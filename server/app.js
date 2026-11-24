// HTTP layer: static files, JSON API and a server-sent-events stream that keeps
// several open devices in sync. No external dependencies.

import http from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, StoreError } from './store.js';
import { createAuth } from './auth.js';
import { FORMAT, ID_RE, IMAGE_RE, IMAGE_TYPES, LIMITS } from '../public/shared/model.js';

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
    // a refused upload is not read at all: end the connection instead of receiving it in vain
    if (status === 413 && res.req && !res.req.complete) headers = { ...headers, Connection: 'close' };
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
  const readRaw = (req, limit) => new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > limit) return reject(new StoreError(413, 'Das Bild ist zu groß'));
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new StoreError(413, 'Das Bild ist zu groß')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
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

  // Pictures never change (the name is their checksum), so browsers may keep them for good.
  async function serveImage(req, res, id) {
    let st;
    try { st = await fs.stat(store.imageFile(id)); } catch { return json(res, 404, { error: 'Bild nicht gefunden' }); }
    const etag = `"${id}"`;
    const headers = {
      'Content-Type': IMAGE_TYPES[id.slice(id.lastIndexOf('.') + 1)], 'Cache-Control': 'private, max-age=31536000, immutable', ETag: etag,
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox", 'Cross-Origin-Resource-Policy': 'same-origin',
    };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    createReadStream(store.imageFile(id)).on('error', () => res.destroy()).pipe(res); // e.g. deleted in the meantime
  }

  // The full backup is one JSON file. Pictures go in as base64 and are streamed one by one,
  // so even a backup with many photos never has to fit into memory at once.
  async function sendExport(res) {
    await store.flushAll();
    const data = store.exportAll(), ids = await store.boardImages();
    const day = new Date().toISOString().slice(0, 10);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="ideenraum-backup-${day}.json"` });
    const head = JSON.stringify(data);
    if (!ids.length) return res.end(head);
    const drained = () => new Promise(r => { const done = () => { res.off('drain', done); res.off('close', done); r(); }; res.on('drain', done); res.on('close', done); });
    const out = async text => { if (!res.write(text)) await drained(); };
    await out(head.slice(0, -1) + ',"images":{');
    let n = 0;
    for (const id of ids) {
      if (res.destroyed) return;
      let buf;
      try { buf = await fs.readFile(store.imageFile(id)); } catch { continue; }
      await out(`${n++ ? ',' : ''}"${id}":"${buf.toString('base64')}"`);
    }
    res.end('}}');
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
      const ct = req.headers['content-type'] || '';
      if (p === '/api/images' && m === 'POST') {
        if (!/^image\//i.test(ct)) return json(res, 415, { error: 'Erwartet ein Bild' });
      } else if ((m === 'POST' || m === 'PATCH') && !/^application\/json\b/i.test(ct)) {
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
    if (p === '/api/export' && m === 'GET') return sendExport(res);
    if (p === '/api/import' && m === 'POST') {
      const body = await readBody(req, 100 * 1024 * 1024);
      return json(res, 201, { created: await store.importData(body) });
    }
    if (p === '/api/images' && m === 'POST') {
      const r = await store.saveImage(await readRaw(req, LIMITS.imageBytes));
      return json(res, 201, r);
    }
    const im = p.match(/^\/api\/images\/([^/]+)$/);
    if (im && (m === 'GET' || m === 'HEAD')) {
      if (!IMAGE_RE.test(im[1])) return json(res, 404, { error: 'Bild nicht gefunden' });
      return serveImage(req, res, im[1]);
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
    // Keep-alive connections would hold the shutdown up for a minute: close every connection
    // as soon as its last answer is out, and after three seconds end whatever is left.
    const closed = new Promise(r => server.close(() => r()));
    const idle = setInterval(() => server.closeIdleConnections(), 50);
    const force = setTimeout(() => server.closeAllConnections(), 3000);
    await closed;
    clearInterval(idle); clearTimeout(force);
    await store.close();
  }
  return { server, store, close, version: pkg.version };
}
