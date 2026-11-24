// End-to-end tests for the server: run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { FORMAT, LIMITS, noteImageLine } from '../public/shared/model.js';

const quiet = { info() {}, error() {}, warn() {}, log() {} };

async function start(dataDir, extra = {}) {
  const app = await createApp({ dataDir, password: '', backupKeepDays: 14, trashKeepDays: 30, log: quiet, ...extra });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body, headers = {}) => {
    const r = await fetch(base + url, {
      method, headers: body !== undefined ? { 'Content-Type': 'application/json', ...headers } : headers,
      body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual',
    });
    const text = await r.text();
    let data = null; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data, headers: r.headers };
  };
  return { app, base, call };
}
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'ideenraum-test-'));
// 1x1 pixel pictures; extra bytes at the end make further distinct files of the same type
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const variant = (buf, tag) => Buffer.concat([buf, Buffer.from(tag)]);
async function upload(s, buf, type = 'image/png', headers = {}) {
  const r = await fetch(`${s.base}/api/images`, { method: 'POST', headers: { 'Content-Type': type, ...headers }, body: buf });
  return { status: r.status, data: await r.json().catch(() => null) };
}

test('boards survive a restart (update-safe storage)', async () => {
  const dir = await tmp();
  let s = await start(dir);
  const created = await s.call('POST', '/api/boards', { name: 'Projekt' });
  assert.equal(created.status, 201);
  const id = created.data.id;
  const r = await s.call('POST', `/api/boards/${id}/changes`, { client: 'c1', changes: [
    { id: 'root1', data: { type: 'node', parent: null, order: 1, text: 'Hauptthema', x: 0, y: 0, z: 1 } },
    { id: 'kid1', data: { type: 'node', parent: 'root1', order: 1, text: 'Ast', z: 2, futureField: { keep: true } } },
  ] });
  assert.equal(r.status, 200);
  await s.app.close();

  s = await start(dir);
  const b = await s.call('GET', `/api/boards/${id}`);
  assert.equal(b.data.name, 'Projekt');
  assert.equal(b.data.items.root1.text, 'Hauptthema');
  assert.deepEqual(b.data.items.kid1.futureField, { keep: true }, 'unknown fields must be kept');
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'boards', `${id}.json`), 'utf8'));
  assert.equal(raw.format, FORMAT);
  await s.app.close();
});

test('old board files are migrated, with a backup first', async () => {
  const dir = await tmp();
  await fs.mkdir(path.join(dir, 'boards'), { recursive: true });
  const old = { id: 'altesboard', name: 'Alt', items: [{ id: 'n1', type: 'node', parent: null, order: 1, text: 'Von früher', x: 5, y: 5 }] };
  await fs.writeFile(path.join(dir, 'boards', 'altesboard.json'), JSON.stringify(old));
  const s = await start(dir);
  const b = await s.call('GET', '/api/boards/altesboard');
  assert.equal(b.status, 200);
  assert.equal(b.data.items.n1.text, 'Von früher');
  const backups = await fs.readdir(path.join(dir, 'backups'));
  assert.ok(backups.some(n => n.includes('vor-migration')), 'backup before migration');
  await s.app.close();
});

test('refuses to start on data from a newer version', async () => {
  const dir = await tmp();
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ format: FORMAT + 1 }));
  await assert.rejects(start(dir), /neueren Ideenraum-Version/);
});

test('delete moves boards to the trash', async () => {
  const dir = await tmp();
  const s = await start(dir);
  const { data } = await s.call('POST', '/api/boards', { name: 'Weg damit' });
  await s.app.store.flushAll();
  assert.equal((await s.call('DELETE', `/api/boards/${data.id}`)).status, 200);
  assert.equal((await s.call('GET', `/api/boards/${data.id}`)).status, 404);
  const trash = await fs.readdir(path.join(dir, 'trash'));
  assert.equal(trash.length, 1);
  await s.app.close();
});

test('full backup export and import round trip', async () => {
  const s1 = await start(await tmp());
  const { data } = await s1.call('POST', '/api/boards', { name: 'Sicher', items: [{ id: 'a1', type: 'sticky', x: 1, y: 2, w: 100, h: 100, text: 'Hallo' }] });
  const exp = await s1.call('GET', '/api/export');
  assert.match(exp.headers.get('content-disposition'), /attachment/);
  await s1.app.close();

  const s2 = await start(await tmp());
  const imp = await s2.call('POST', '/api/import', exp.data);
  assert.equal(imp.status, 201);
  const b = await s2.call('GET', `/api/boards/${data.id}`);
  assert.equal(b.data.items.a1.text, 'Hallo');
  await s2.app.close();
});

test('rejects bad input and cross-site writes', async () => {
  const s = await start(await tmp());
  const { data } = await s.call('POST', '/api/boards', { name: 'X' });
  assert.equal((await s.call('POST', `/api/boards/${data.id}/changes`, { changes: [{ id: '../evil', data: { type: 'node' } }] })).status, 400);
  assert.equal((await s.call('POST', `/api/boards/${data.id}/changes`, { changes: [] }, { Origin: 'https://evil.example' })).status, 403);
  const plain = await fetch(`${s.base}/api/boards`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"name":"x"}' });
  assert.equal(plain.status, 415);
  assert.equal((await s.call('GET', '/../package.json')).status, 404);
  await s.app.close();
});

test('password protection', async () => {
  const s = await start(await tmp(), { password: 'geheim' });
  assert.equal((await s.call('GET', '/api/boards')).status, 401);
  assert.equal((await s.call('GET', '/')).status, 302);
  assert.equal((await s.call('GET', '/api/health')).status, 200);
  assert.equal((await s.call('POST', '/api/login', { password: 'falsch' })).status, 401);
  const ok = await s.call('POST', '/api/login', { password: 'geheim' });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.equal((await s.call('GET', '/api/boards', undefined, { Cookie: cookie })).status, 200);
  assert.equal((await upload(s, PNG)).status, 401, 'uploads need the login too');
  const up = await upload(s, PNG, 'image/png', { Cookie: cookie });
  assert.equal(up.status, 201);
  assert.equal((await s.call('GET', `/api/images/${up.data.id}`)).status, 401);
  assert.equal((await s.call('GET', `/api/images/${up.data.id}`, undefined, { Cookie: cookie })).status, 200);
  await s.app.close();
});

test('live updates reach other open devices', async () => {
  const s = await start(await tmp());
  const { data } = await s.call('POST', '/api/boards', { name: 'Live' });
  const ac = new AbortController();
  const res = await fetch(`${s.base}/api/events`, { signal: ac.signal });
  const reader = res.body.getReader();
  await s.call('POST', `/api/boards/${data.id}/changes`, { client: 'laptop', changes: [{ id: 's1', data: { type: 'sticky', x: 0, y: 0, w: 200, h: 200, text: 'Neu' } }] });
  let text = '';
  const deadline = Date.now() + 3000;
  while (!text.includes('event: changes') && Date.now() < deadline) text += new TextDecoder().decode((await reader.read()).value);
  assert.match(text, /"client":"laptop"/);
  assert.match(text, /"text":"Neu"/);
  ac.abort();
  await s.app.close();
});

test('imports a board exported from the claude.ai version', async () => {
  const s = await start(await tmp());
  const artifactExport = { app: 'ideenraum', version: 1, name: 'Aus claude.ai', exportedAt: '2026-11-23T12:00:00Z', items: [
    { id: 'r', type: 'node', z: 1, parent: null, order: 1, text: 'Wurzel', x: 0, y: 0 },
    { id: 'k', type: 'node', z: 2, parent: 'r', order: 1, text: 'Kind', side: 'r', color: '#F2704D' },
    { id: 'l', type: 'link', z: 0, a: { id: 'r' }, b: { id: 'k' }, arrow: 'end', label: '' },
  ] };
  const imp = await s.call('POST', '/api/import', artifactExport);
  assert.equal(imp.status, 201);
  const b = await s.call('GET', `/api/boards/${imp.data.created[0].id}`);
  const items = Object.values(b.data.items);
  const root = items.find(i => i.text === 'Wurzel'), kid = items.find(i => i.text === 'Kind');
  assert.equal(kid.parent, root.id, 'parent links survive the id remapping');
  assert.equal(items.find(i => i.type === 'link').b.id, kid.id);
  await s.app.close();
});

test('items of unknown future types are stored untouched', async () => {
  const s = await start(await tmp());
  const { data } = await s.call('POST', '/api/boards', { name: 'Zukunft' });
  const future = { type: 'video', x: 10, y: 20, src: 'asset-123', crop: [0, 0, 1, 1] };
  assert.equal((await s.call('POST', `/api/boards/${data.id}/changes`, { changes: [{ id: 'img1', data: future }] })).status, 200);
  const b = await s.call('GET', `/api/boards/${data.id}`);
  assert.deepEqual(b.data.items.img1, { ...future, id: 'img1' });
  await s.app.close();
});

test('hand-placed branch positions (dx/dy, since 1.1.0) are stored', async () => {
  const s = await start(await tmp());
  const { data } = await s.call('POST', '/api/boards', { name: 'Anordnung' });
  await s.call('POST', `/api/boards/${data.id}/changes`, { changes: [
    { id: 'r', data: { type: 'node', parent: null, order: 1, text: 'Wurzel', x: 0, y: 0, dx: 50 } },
    { id: 'k', data: { type: 'node', parent: 'r', order: 1, text: 'Ast', dx: 120.5, dy: -40 } },
  ] });
  const b = await s.call('GET', `/api/boards/${data.id}`);
  assert.equal(b.data.items.k.dx, 120.5);
  assert.equal(b.data.items.k.dy, -40);
  assert.equal(b.data.items.r.dx, undefined, 'root nodes are placed by x/y, not dx');
  await s.app.close();
});

test('notes on mindmap topics (since 1.2.0) are stored, blank ones dropped', async () => {
  const dir = await tmp();
  let s = await start(dir);
  const { data } = await s.call('POST', '/api/boards', { name: 'Notizen' });
  const steps = '1. Wachsmodell spritzen\n2. Modelltraube aufbauen\n3. Keramikschale';
  await s.call('POST', `/api/boards/${data.id}/changes`, { changes: [
    { id: 'r', data: { type: 'node', parent: null, order: 1, text: 'Gießen', x: 0, y: 0 } },
    { id: 'k', data: { type: 'node', parent: 'r', order: 1, text: 'Feinguss', note: steps } },
    { id: 'e', data: { type: 'node', parent: 'r', order: 2, text: 'Leer', note: ' \n ' } },
    { id: 'l', data: { type: 'node', parent: 'r', order: 3, text: 'Lang', note: 'x'.repeat(LIMITS.noteLength + 10) } },
  ] });
  await s.app.close();
  s = await start(dir);
  const b = await s.call('GET', `/api/boards/${data.id}`);
  assert.equal(b.data.items.k.note, steps);
  assert.equal('note' in b.data.items.e, false, 'blank notes are not stored');
  assert.equal(b.data.items.l.note.length, LIMITS.noteLength);
  assert.equal('note' in b.data.items.r, false);
  await s.app.close();
});

test('pictures (since 1.3.0): upload, download and checks', async () => {
  const s = await start(await tmp());
  const up = await upload(s, PNG);
  assert.equal(up.status, 201);
  const id = up.data.id;
  assert.match(id, /^[a-f0-9]{32}\.png$/);
  assert.equal((await upload(s, PNG)).data.id, id, 'the same picture is stored once');
  assert.match((await upload(s, GIF, 'image/gif')).data.id, /\.gif$/);

  const get = await fetch(`${s.base}/api/images/${id}`);
  assert.equal(get.status, 200);
  assert.equal(get.headers.get('content-type'), 'image/png');
  assert.match(get.headers.get('cache-control'), /immutable/);
  assert.match(get.headers.get('content-security-policy'), /sandbox/);
  assert.deepEqual(Buffer.from(await get.arrayBuffer()), PNG);
  assert.equal((await fetch(`${s.base}/api/images/${id}`, { headers: { 'If-None-Match': `"${id}"` } })).status, 304);
  assert.equal((await fetch(`${s.base}/api/images/${id}`, { method: 'HEAD' })).headers.get('content-length'), String(PNG.length));

  assert.equal((await upload(s, Buffer.from('<svg onload="alert(1)"></svg> and more'), 'image/svg+xml')).status, 415, 'only real pictures');
  assert.equal((await upload(s, PNG, 'application/octet-stream')).status, 415);
  assert.equal((await upload(s, PNG, 'image/png', { Origin: 'https://evil.example' })).status, 403);
  const tooBig = await new Promise((resolve, reject) => { // only the announced size, the server refuses before reading
    const req = http.request(`${s.base}/api/images`, { method: 'POST', headers: { 'Content-Type': 'image/png', 'Content-Length': LIMITS.imageBytes + 1 } }, res => {
      res.resume(); resolve(res.statusCode); req.destroy();
    });
    req.on('error', reject); req.flushHeaders();
  });
  assert.equal(tooBig, 413);
  assert.equal((await fetch(`${s.base}/api/images/${'0'.repeat(32)}.png`)).status, 404);
  assert.equal((await fetch(`${s.base}/api/images/..%2F..%2Fmeta.json`)).status, 404);

  const { data } = await s.call('POST', '/api/boards', { name: 'Bilder' });
  await s.call('POST', `/api/boards/${data.id}/changes`, { changes: [
    { id: 'i1', data: { type: 'image', x: 10, y: 20, w: 320, h: 200, src: id, text: 'kein Text' } },
    { id: 'i2', data: { type: 'image', x: 0, y: 0, w: 50, h: 50, src: '../../meta.json' } },
  ] });
  const b = await s.call('GET', `/api/boards/${data.id}`);
  assert.deepEqual(b.data.items.i1, { id: 'i1', type: 'image', z: 0, x: 10, y: 20, w: 320, h: 200, src: id });
  assert.equal(b.data.items.i2.src, '', 'only names of stored pictures are allowed');
  await s.app.close();
});

test('pictures travel with the full backup', async () => {
  const s1 = await start(await tmp());
  const png = (await upload(s1, PNG)).data.id, gif = (await upload(s1, GIF, 'image/gif')).data.id;
  const unused = (await upload(s1, variant(PNG, 'unbenutzt'))).data.id;
  const { data } = await s1.call('POST', '/api/boards', { name: 'Mit Bildern', items: [
    { id: 'p', type: 'image', x: 0, y: 0, w: 100, h: 100, src: png },
    { id: 'r', type: 'node', parent: null, order: 1, x: 0, y: 0, text: 'Feinguss', note: `Ablauf\n${noteImageLine(gif)}\nEnde` },
  ] });
  const exp = await s1.call('GET', '/api/export');
  assert.equal(exp.status, 200);
  assert.deepEqual(Object.keys(exp.data.images).sort(), [png, gif].sort(), 'only pictures the boards use');
  assert.equal(exp.data.images[png], PNG.toString('base64'));
  assert.equal(unused in exp.data.images, false);
  await s1.app.close();

  const s2 = await start(await tmp());
  assert.equal((await s2.call('POST', '/api/import', exp.data)).status, 201);
  const b = await s2.call('GET', `/api/boards/${data.id}`);
  assert.equal(b.data.items.p.src, png);
  for (const [id, buf] of [[png, PNG], [gif, GIF]]) {
    const r = await fetch(`${s2.base}/api/images/${id}`);
    assert.equal(r.status, 200);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), buf);
  }
  await s2.app.close();
});

test('unused pictures are deleted after a week, used ones stay', async () => {
  const dir = await tmp();
  const s = await start(dir);
  const ids = {};
  for (const k of ['item', 'note', 'trash', 'old', 'fresh']) ids[k] = (await upload(s, variant(PNG, k))).data.id;
  const { data } = await s.call('POST', '/api/boards', { name: 'Lernen', items: [
    { id: 'p', type: 'image', x: 0, y: 0, w: 100, h: 100, src: ids.item },
    { id: 'r', type: 'node', parent: null, order: 1, x: 0, y: 0, text: 'Thema', note: noteImageLine(ids.note) },
  ] });
  const gone = await s.call('POST', '/api/boards', { name: 'Weg', items: [{ id: 'q', type: 'image', x: 0, y: 0, w: 9, h: 9, src: ids.trash }] });
  await s.app.store.flushAll();
  await s.call('DELETE', `/api/boards/${gone.data.id}`);
  const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  for (const k of ['item', 'note', 'trash', 'old']) await fs.utimes(path.join(dir, 'images', ids[k]), old, old);

  assert.equal(await s.app.store.cleanImages(), 1);
  const left = await fs.readdir(path.join(dir, 'images'));
  assert.deepEqual(left.sort(), [ids.item, ids.note, ids.trash, ids.fresh].sort());
  assert.ok(data.id);
  await s.app.close();
});
