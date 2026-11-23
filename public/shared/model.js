// Shared data model for Ideenraum. The browser app and the server both import
// this file, so validation and migrations exist exactly once.
//
// Upgrade rules (keep old mindmaps alive across updates):
//  1. Never change the meaning of an existing field. Add new fields instead.
//  2. Unknown fields and unknown item types are kept as they are, so data
//     written by a newer version survives a round trip through an older one.
//  3. If the stored structure has to change, bump FORMAT and add a step to
//     MIGRATIONS. Released steps are never edited afterwards.

export const APP_ID = 'ideenraum';
export const FORMAT = 1;
export const TYPES = ['node', 'sticky', 'text', 'shape', 'stroke', 'link'];
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const LIMITS = {
  itemBytes: 256 * 1024,
  itemsPerBoard: 20000,
  nameLength: 120,
  textLength: 5000,
  points: 20000,
};

export function uid() {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const r = globalThis.crypto.getRandomValues(new Uint8Array(14));
  let s = '';
  for (const b of r) s += a[b % 36];
  return s;
}

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v, max = LIMITS.textLength) => (typeof v === 'string' ? v.slice(0, max) : '');
const col = v => (typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v) ? v : undefined);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const KNOWN = new Set(['id', 'type', 'z', 'parent', 'order', 'text', 'x', 'y', 'dx', 'dy', 'side', 'color', 'collapsed',
  'a', 'b', 'label', 'arrow', 'style', 'dash', 'w', 'h', 'shape', 'size', 'pts', 'width']);

/** Normalise one item of a known type. Unknown fields are carried over unchanged. */
export function sanitizeItem(n) {
  const o = { id: n.id, type: n.type, z: num(n.z) };
  if (n.type === 'node') {
    o.parent = typeof n.parent === 'string' ? n.parent : null;
    o.order = num(n.order, 1);
    o.text = str(n.text);
    if (!o.parent) { o.x = num(n.x); o.y = num(n.y); }
    // since 1.1.0: a branch moved by hand keeps its shift from the automatic layout
    if (o.parent && num(n.dx)) o.dx = num(n.dx);
    if (o.parent && num(n.dy)) o.dy = num(n.dy);
    if (n.side === 'l' || n.side === 'r') o.side = n.side;
    if (col(n.color)) o.color = col(n.color);
    if (n.collapsed) o.collapsed = true;
  } else if (n.type === 'link') {
    const ep = e => (e && typeof e.id === 'string' ? { id: e.id } : e ? { x: num(e.x), y: num(e.y) } : null);
    o.a = ep(n.a); o.b = ep(n.b); o.label = str(n.label, 200);
    o.arrow = ['none', 'both', 'end'].includes(n.arrow) ? n.arrow : 'end';
    if (n.style === 'straight') o.style = 'straight';
    if (n.dash) o.dash = true;
    if (col(n.color)) o.color = col(n.color);
  } else if (TYPES.includes(n.type)) {
    o.x = num(n.x); o.y = num(n.y); o.text = str(n.text);
    if (col(n.color)) o.color = col(n.color);
    if (n.type === 'sticky' || n.type === 'shape' || n.type === 'stroke') { o.w = Math.max(1, num(n.w, 160)); o.h = Math.max(1, num(n.h, 110)); }
    if (n.type === 'shape') o.shape = ['rect', 'ellipse', 'diamond'].includes(n.shape) ? n.shape : 'rect';
    if (n.type === 'text') { o.size = clamp(num(n.size, 20), 8, 200); if (n.w) o.w = Math.max(20, num(n.w)); }
    if (n.type === 'stroke') {
      o.pts = Array.isArray(n.pts) ? n.pts.filter(v => typeof v === 'number' && Number.isFinite(v)).slice(0, LIMITS.points) : [];
      o.width = clamp(num(n.width, 3), 1, 40);
      delete o.text;
    }
  } else {
    return Object.assign({}, n); // unknown type from a newer version: keep untouched
  }
  for (const k of Object.keys(n)) if (!KNOWN.has(k) && !(k in o)) o[k] = n[k];
  return o;
}

/**
 * Check an item coming from a client or an import.
 * Returns {item} or {error}. Known types are normalised, unknown types kept.
 */
export function validateItem(id, data) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return { error: 'invalid item id' };
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: 'item must be an object' };
  if (typeof data.type !== 'string' || !data.type || data.type.length > 40) return { error: 'item needs a type' };
  const item = sanitizeItem(Object.assign({}, data, { id }));
  if (JSON.stringify(item).length > LIMITS.itemBytes) return { error: 'item too large' };
  return { item };
}

/** Give every item a fresh id and rewire references (used for duplicates and imports). */
export function remapItems(list) {
  const map = {};
  for (const n of list) if (n && typeof n.id === 'string') map[n.id] = uid();
  const out = [];
  for (const src of list) {
    if (!src || !map[src.id] || typeof src.type !== 'string') continue;
    const n = sanitizeItem(src); n.id = map[src.id];
    if (n.type === 'node' && n.parent) {
      n.parent = map[n.parent] || null;
      if (!n.parent) { n.x = num(src.x); n.y = num(src.y); }
    }
    if (n.type === 'link') {
      let ok = true;
      for (const e of ['a', 'b']) {
        if (n[e] && n[e].id) { if (map[n[e].id]) n[e] = { id: map[n[e].id] }; else ok = false; }
        else if (!n[e]) ok = false;
      }
      if (!ok) continue;
    }
    out.push(n);
  }
  return out;
}

/* ---------- stored boards ---------- */

// MIGRATIONS[n] upgrades a board from format n-1 to format n.
const MIGRATIONS = {
  // 0 -> 1: boards from early exports had no format field and kept items as an array.
  1: board => {
    if (Array.isArray(board.items)) {
      const m = {};
      for (const it of board.items) if (it && typeof it.id === 'string') m[it.id] = it;
      board.items = m;
    }
    if (!board.items || typeof board.items !== 'object') board.items = {};
    if (typeof board.name !== 'string' || !board.name.trim()) board.name = 'Unbenanntes Board';
    if (!Number.isFinite(board.createdAt)) board.createdAt = Date.now();
    if (!Number.isFinite(board.updatedAt)) board.updatedAt = board.createdAt;
    if (!Number.isFinite(board.rev)) board.rev = 0;
    return board;
  },
};

export function boardFormat(board) {
  return Number.isInteger(board && board.format) ? board.format : 0;
}

/** Upgrade a stored board to the current FORMAT. Throws if it is newer than this version. */
export function migrateBoard(board) {
  let f = boardFormat(board);
  if (f > FORMAT) throw new Error(`Board ${board.id} hat Datenformat ${f}, diese Version kennt nur bis ${FORMAT}.`);
  while (f < FORMAT) {
    f += 1;
    board = MIGRATIONS[f](board);
    board.format = f;
  }
  return board;
}
