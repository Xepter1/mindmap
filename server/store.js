// Board storage: one JSON file per board in <dataDir>/boards.
// Files are written atomically (temp file + fsync + rename), so a power cut
// on the Raspberry Pi leaves either the old or the new version, never half a file.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FORMAT, ID_RE, LIMITS, boardFormat, migrateBoard, remapItems, sanitizeItem, uid, validateItem, APP_ID } from '../public/shared/model.js';

const DAY = 24 * 60 * 60 * 1000;
const stamp = (d = new Date()) => d.toISOString().replace(/[:.]/g, '-');

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
async function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fh = await fs.open(tmp, 'w');
  try { await fh.writeFile(text); await fh.sync(); } finally { await fh.close(); }
  await fs.rename(tmp, file);
}

export class StoreError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export class Store {
  constructor(dataDir, { appVersion = '0.0.0', backupKeepDays = 14, trashKeepDays = 30, log = console } = {}) {
    this.dir = dataDir;
    this.boardsDir = path.join(dataDir, 'boards');
    this.backupDir = path.join(dataDir, 'backups');
    this.trashDir = path.join(dataDir, 'trash');
    this.appVersion = appVersion;
    this.backupKeepDays = backupKeepDays;
    this.trashKeepDays = trashKeepDays;
    this.log = log;
    this.boards = new Map();
    this.dirty = new Set();
    this.writing = new Map();
    this.timers = new Map();
    this.listeners = new Set();
  }

  /* ---------- startup ---------- */
  async init() {
    for (const d of [this.dir, this.boardsDir, this.backupDir, this.trashDir]) await fs.mkdir(d, { recursive: true });
    try { await fs.access(this.dir, fs.constants.W_OK); }
    catch { throw new Error(`Kein Schreibzugriff auf ${this.dir}. Unter Docker: "sudo chown -R 1000:1000 data" im Projektordner ausführen.`); }

    const meta = await readJson(path.join(this.dir, 'meta.json'));
    if (meta && Number.isInteger(meta.format) && meta.format > FORMAT) {
      throw new Error(`Die Daten in ${this.dir} stammen von einer neueren Ideenraum-Version (Datenformat ${meta.format}). `
        + `Diese Version (${this.appVersion}) kennt nur Format ${FORMAT}. Bitte die neuere Version starten, damit nichts verloren geht.`);
    }

    const files = (await fs.readdir(this.boardsDir)).filter(f => f.endsWith('.json'));
    const toMigrate = [];
    for (const f of files) {
      const file = path.join(this.boardsDir, f);
      let board;
      try { board = await readJson(file); }
      catch (e) {
        const dest = path.join(this.dir, `defekt-${stamp()}-${f}`);
        await fs.rename(file, dest);
        this.log.error(`Board-Datei ${f} ist beschädigt und wurde nach ${dest} verschoben.`);
        continue;
      }
      if (!board || typeof board !== 'object') continue;
      board.id = typeof board.id === 'string' && ID_RE.test(board.id) ? board.id : f.replace(/\.json$/, '');
      if (boardFormat(board) > FORMAT) {
        throw new Error(`Board ${board.id} hat Datenformat ${boardFormat(board)}, diese Version kennt nur ${FORMAT}. Bitte die neuere Version starten.`);
      }
      if (boardFormat(board) < FORMAT) toMigrate.push(board);
      else this.boards.set(board.id, board);
    }

    if (toMigrate.length) {
      const dest = await this.snapshot(`vor-migration-auf-format-${FORMAT}`, true);
      this.log.info(`Migriere ${toMigrate.length} Board(s) auf Datenformat ${FORMAT}. Sicherung: ${dest}`);
      for (const b of toMigrate) {
        const m = migrateBoard(b);
        this.boards.set(m.id, m);
        await this.writeBoard(m);
      }
    }

    await writeAtomic(path.join(this.dir, 'meta.json'), JSON.stringify({ app: APP_ID, format: FORMAT, appVersion: this.appVersion, updatedAt: new Date().toISOString() }, null, 2));
    this.log.info(`${this.boards.size} Board(s) geladen aus ${this.boardsDir}`);
    await this.maintenance();
    this.maintenanceTimer = setInterval(() => this.maintenance().catch(e => this.log.error('Wartung fehlgeschlagen:', e)), 60 * 60 * 1000);
    this.maintenanceTimer.unref();
  }

  /* ---------- reading ---------- */
  list() {
    return [...this.boards.values()]
      .map(b => ({ id: b.id, name: b.name, createdAt: b.createdAt, updatedAt: b.updatedAt, rev: b.rev, itemCount: Object.keys(b.items).length }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  get(id) {
    const b = this.boards.get(id);
    if (!b) throw new StoreError(404, 'Board nicht gefunden');
    return b;
  }

  /* ---------- writing ---------- */
  create({ id, name, items } = {}) {
    if (!(typeof id === 'string' && ID_RE.test(id)) || this.boards.has(id)) id = uid();
    const now = Date.now();
    const board = { format: FORMAT, id, name: cleanName(name), createdAt: now, updatedAt: now, rev: 0, items: {} };
    const list = Array.isArray(items) ? items : items && typeof items === 'object' ? Object.values(items) : [];
    if (list.length > LIMITS.itemsPerBoard) throw new StoreError(413, 'Zu viele Elemente für ein Board');
    for (const it of list) {
      const { item } = validateItem(it && it.id, it);
      if (item) board.items[item.id] = item;
    }
    this.boards.set(id, board);
    this.saveSoon(id, 0);
    this.emit('boards');
    return board;
  }
  rename(id, name) {
    const b = this.get(id);
    b.name = cleanName(name); b.updatedAt = Date.now(); b.rev += 1;
    this.saveSoon(id);
    this.emit('boards');
    return b;
  }
  applyChanges(id, changes) {
    const b = this.get(id);
    if (!Array.isArray(changes)) throw new StoreError(400, 'changes muss eine Liste sein');
    const applied = [];
    for (const ch of changes) {
      if (!ch || typeof ch.id !== 'string' || !ID_RE.test(ch.id)) throw new StoreError(400, 'Ungültige Element-ID');
      if (ch.data === null) { delete b.items[ch.id]; applied.push({ id: ch.id, data: null }); continue; }
      const { item, error } = validateItem(ch.id, ch.data);
      if (error) throw new StoreError(400, `Element ${ch.id}: ${error}`);
      if (!b.items[ch.id] && Object.keys(b.items).length >= LIMITS.itemsPerBoard) throw new StoreError(413, 'Das Board ist voll');
      b.items[ch.id] = item;
      applied.push({ id: ch.id, data: item });
    }
    if (applied.length) {
      b.rev += 1; b.updatedAt = Date.now();
      this.saveSoon(id);
      this.emit('boards');
    }
    return { rev: b.rev, applied };
  }
  async remove(id) {
    this.get(id);
    await this.flush(id);
    this.boards.delete(id);
    const src = this.file(id);
    try { await fs.rename(src, path.join(this.trashDir, `${stamp()}__${id}.json`)); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    this.emit('boards');
  }

  /* ---------- import / export ---------- */
  exportAll() {
    return { app: APP_ID, kind: 'backup', format: FORMAT, appVersion: this.appVersion, exportedAt: new Date().toISOString(), boards: [...this.boards.values()] };
  }
  importData(data) {
    if (!data || typeof data !== 'object') throw new StoreError(400, 'Keine gültige Datei');
    const created = [];
    if (Array.isArray(data.boards)) { // full backup
      if (Number.isInteger(data.format) && data.format > FORMAT) throw new StoreError(400, 'Die Sicherung stammt von einer neueren Version');
      for (const raw of data.boards) {
        if (!raw || typeof raw !== 'object') continue;
        const b = migrateBoard(JSON.parse(JSON.stringify(raw)));
        const keepIds = !this.boards.has(b.id);
        const items = keepIds ? Object.values(b.items) : remapItems(Object.values(b.items));
        created.push(this.create({ id: keepIds ? b.id : undefined, name: b.name, items }));
      }
    } else if (Array.isArray(data.items)) { // single board export
      created.push(this.create({ name: typeof data.name === 'string' ? data.name : 'Importiertes Board', items: remapItems(data.items) }));
    } else throw new StoreError(400, 'Diese Datei ist kein Ideenraum-Export');
    return created.map(b => ({ id: b.id, name: b.name, itemCount: Object.keys(b.items).length }));
  }

  /* ---------- persistence ---------- */
  file(id) { return path.join(this.boardsDir, `${id}.json`); }
  saveSoon(id, delay = 300) {
    this.dirty.add(id);
    clearTimeout(this.timers.get(id));
    this.timers.set(id, setTimeout(() => this.flush(id).catch(e => this.log.error(`Speichern von ${id} fehlgeschlagen:`, e)), delay));
  }
  async flush(id) {
    clearTimeout(this.timers.get(id)); this.timers.delete(id);
    while (this.writing.has(id)) await this.writing.get(id);
    if (!this.dirty.has(id)) return;
    this.dirty.delete(id);
    const b = this.boards.get(id);
    if (!b) return;
    const p = this.writeBoard(b).finally(() => this.writing.delete(id));
    this.writing.set(id, p);
    try { await p; }
    catch (e) { this.dirty.add(id); this.saveSoon(id, 5000); throw e; }
  }
  async flushAll() {
    await Promise.all([...new Set([...this.dirty, ...this.writing.keys()])].map(id => this.flush(id)));
  }
  writeBoard(b) { return writeAtomic(this.file(b.id), JSON.stringify(b)); }

  /* ---------- backups & cleanup ---------- */
  async snapshot(label, force = false) {
    await this.flushAll();
    const files = (await fs.readdir(this.boardsDir)).filter(f => f.endsWith('.json'));
    if (!files.length && !force) return null;
    const dest = path.join(this.backupDir, `${stamp()}_${label}`);
    await fs.mkdir(dest, { recursive: true });
    for (const f of files) await fs.copyFile(path.join(this.boardsDir, f), path.join(dest, f));
    return dest;
  }
  async maintenance() {
    const now = Date.now();
    const entries = (await fs.readdir(this.backupDir, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort();
    const daily = entries.filter(n => n.endsWith('_taeglich'));
    const lastDaily = daily.length ? (await fs.stat(path.join(this.backupDir, daily[daily.length - 1]))).mtimeMs : 0;
    const lastChange = Math.max(0, ...[...this.boards.values()].map(b => b.updatedAt || 0));
    if (this.boards.size && now - lastDaily > 20 * 60 * 60 * 1000 && lastChange > lastDaily) {
      const dest = await this.snapshot('taeglich');
      if (dest) { daily.push(path.basename(dest)); this.log.info(`Tägliche Sicherung: ${dest}`); }
    }
    // keep the newest N daily backups and the newest 10 others (e.g. before migrations)
    const others = entries.filter(n => !n.endsWith('_taeglich'));
    const drop = [...daily.slice(0, Math.max(0, daily.length - this.backupKeepDays)), ...others.slice(0, Math.max(0, others.length - 10))];
    for (const n of drop) await fs.rm(path.join(this.backupDir, n), { recursive: true, force: true });
    for (const f of await fs.readdir(this.trashDir)) {
      const st = await fs.stat(path.join(this.trashDir, f));
      if (now - st.mtimeMs > this.trashKeepDays * DAY) await fs.rm(path.join(this.trashDir, f), { force: true });
    }
  }

  /* ---------- events ---------- */
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(type, data) { for (const fn of this.listeners) fn(type, data); }

  async close() {
    clearInterval(this.maintenanceTimer);
    await this.flushAll();
  }
}

function cleanName(name) {
  const n = typeof name === 'string' ? name.trim().slice(0, LIMITS.nameLength) : '';
  return n || 'Unbenanntes Board';
}

export { sanitizeItem };
