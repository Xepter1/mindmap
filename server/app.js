// HTTP layer: static files, JSON API and a server-sent-events stream that keeps
// several open devices in sync. No external dependencies.

import http from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, StoreError } from './store.js';
import { createAuth } from './auth.js';
import { FORMAT, ID_RE } from '../public/shared/model.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
  + "font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'";
const PUBLIC_WITHOUT_LOGIN = new Set(['/login', '/login.html', '/login.js', '/styles.css', '/favicon.svg', '/manifest.webmanifest', '/api/health', '/api/login']);

export async function createApp(config) {
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const log = config.log || console;
  const store = new Store(config.dataDir, { appVersion: pkg.version, backupKeepDays: config.backupKeepDays, trashKeepDays: config.trashKeepDays, log });
  await store.init();
  const auth = await createAuth({ password: config.password, dataDir: config.dataDir, secureCookies: config.secureCookies });

  /* ---------- live updates ---------- */
  const clients = new Set();
  const send = (event, data) => { const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of clients) c.write(msg); };
  let boardsTimer = null;
  store.on(type => {
    if (type !== 'boards' || boardsTimer) return;
    boardsTimer = setTimeout(() => { boardsTimer = null; send('boards', store.list()); }, 800);
  });
  const ping = setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25000);
  ping.unref();

  /* ---------- helpers ---------- */
  const json = (res, status, data, headers = {}) => {
    const body = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  };
  const readBody = (req, limit) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new StoreError(413, 'Die Anfrage ist zu groß')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new StoreError(400, 'Ungültiges JSON')); }
    });
    req.on('error', reject);
  });
  const boardJson = b => ({ id: b.id, name: b.name, createdAt: b.createdAt, updatedAt: b.updatedAt, rev: b.rev, items: b.items });

  async function serveStatic(req, res, pathname) {
    if (pathname === '/') pathname = '/index.html';
    if (pathname === '/login') pathname = '/login.html';
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { return json(res, 400, { error: 'Ungültiger Pfad' }); }
    const file = path.join(PUBLIC, path.normalize(rel));
    if (!file.startsWith(PUBLIC + path.sep)) return json(res, 403, { error: 'Verboten' });
    let st;
    try { st = await fs.stat(file); if (!st.isFile()) throw new Error('not a file'); }
    catch { return json(res, 404, { error: 'Nicht gefunden' }); }
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers = { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ETag: etag };
    if (file.endsWith('.html')) headers['Content-Security-Policy'] = CSP;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  }

  /* ---------- routes ---------- */
  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname, m = req.method;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');

    if (p === '/api/health') return json(res, 200, { ok: true, app: 'ideenraum', version: pkg.version, format: FORMAT, boards: store.boards.size, login: auth.enabled });
    if (p === '/api/login' && m === 'POST') {
      if (!auth.enabled) return json(res, 200, { ok: true });
      const body = await readBody(req, 4096);
      const r = auth.login(req, res, typeof body.password === 'string' ? body.password : '');
      return r.ok ? json(res, 200, { ok: true }) : json(res, r.status, { error: r.error });
    }
    if (p === '/api/logout' && m === 'POST') { if (auth.enabled) auth.logout(req, res); return json(res, 200, { ok: true }); }

    if (auth.enabled && !auth.check(req) && !PUBLIC_WITHOUT_LOGIN.has(p)) {
      if (p.startsWith('/api/')) return json(res, 401, { error: 'Bitte anmelden' });
      res.writeHead(302, { Location: '/login' }); return res.end();
    }

    if (!p.startsWith('/api/')) {
      if (m !== 'GET' && m !== 'HEAD') return json(res, 405, { error: 'Methode nicht erlaubt' });
      return serveStatic(req, res, p);
    }
    // Writes only from the app itself: same origin and a JSON body (blocks cross-site requests).
    if (m !== 'GET' && m !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin) {
        let host = '';
        try { host = new URL(origin).host; } catch { /* "null" or garbage */ }
        const allowed = [req.headers.host, req.headers['x-forwarded-host']].filter(Boolean);
        if (!allowed.includes(host)) return json(res, 403, { error: 'Anfrage von fremder Seite abgelehnt' });
      }
      if ((m === 'POST' || m === 'PATCH') && !/^application\/json\b/i.test(req.headers['content-type'] || '')) {
        return json(res, 415, { error: 'Erwartet JSON' });
      }
    }

    if (p === '/api/events' && m === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 3000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (p === '/api/boards' && m === 'GET') return json(res, 200, store.list());
    if (p === '/api/boards' && m === 'POST') {
      const body = await readBody(req, 50 * 1024 * 1024);
      const b = store.create({ id: body.id, name: body.name, items: body.items });
      return json(res, 201, boardJson(b));
    }
    if (p === '/api/export' && m === 'GET') {
      await store.flushAll();
      const day = new Date().toISOString().slice(0, 10);
      return json(res, 200, store.exportAll(), { 'Content-Disposition': `attachment; filename="ideenraum-backup-${day}.json"` });
    }
    if (p === '/api/import' && m === 'POST') {
      const body = await readBody(req, 100 * 1024 * 1024);
      return json(res, 201, { created: store.importData(body) });
    }

    const bm = p.match(/^\/api\/boards\/([^/]+)(\/changes)?$/);
    if (bm && ID_RE.test(bm[1])) {
      const id = bm[1];
      if (!bm[2] && m === 'GET') return json(res, 200, boardJson(store.get(id)));
      if (!bm[2] && m === 'PATCH') { const body = await readBody(req, 8192); const b = store.rename(id, body.name); return json(res, 200, { id: b.id, name: b.name, updatedAt: b.updatedAt }); }
      if (!bm[2] && m === 'DELETE') { await store.remove(id); return json(res, 200, { ok: true }); }
      if (bm[2] && m === 'POST') {
        const body = await readBody(req, 20 * 1024 * 1024);
        const r = store.applyChanges(id, body.changes);
        if (r.applied.length) send('changes', { board: id, rev: r.rev, client: typeof body.client === 'string' ? body.client.slice(0, 64) : '', changes: r.applied });
        return json(res, 200, { rev: r.rev });
      }
    }
    return json(res, 404, { error: 'Nicht gefunden' });
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch(e => {
      const status = e instanceof StoreError ? e.status : 500;
      if (status === 500) log.error(e);
      if (!res.headersSent) json(res, status, { error: status === 500 ? 'Interner Fehler' : e.message });
      else res.end();
    });
  });
  server.keepAliveTimeout = 65000;

  async function close() {
    clearInterval(ping);
    for (const c of clients) c.end();
    clients.clear();
    await new Promise(r => server.close(() => r()));
    await store.close();
  }
  return { server, store, close, version: pkg.version };
}
