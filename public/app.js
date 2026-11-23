// Ideenraum – browser app. Talks to the server (see /server) through /api.
import { uid, sanitizeItem, remapItems, TYPES, FORMAT } from './shared/model.js';

/* ================= basics ================= */
const $ = s => document.querySelector(s);
const stage = $('#stage'), world = $('#world'), itemsEl = $('#items'), labelsEl = $('#labels'),
      wireG = $('#wireG'), overlay = $('#overlay');
const BRANCH = ['#F2704D', '#F0A23B', '#3FAE6A', '#2BA5A5', '#3D7DE8', '#8A63D2', '#D95C9B', '#5F6B7A'];
const STICKY = ['#FFE27A', '#FFC38A', '#FFB3C7', '#B9EBA0', '#A9D4FF', '#D3C2FF', '#E3E6EA'];
const LS = 'ideenraum.v1.';
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const clone = o => JSON.parse(JSON.stringify(o));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r1 = v => Math.round(v * 10) / 10;
const lsGet = k => { try { const v = localStorage.getItem(LS + k); return v == null ? null : JSON.parse(v); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(LS + k, JSON.stringify(v)); return true; } catch (e) { return false; } };
const lsDel = k => { try { localStorage.removeItem(LS + k); } catch (e) {} };

/* ================= state ================= */
const S = {
  boardId: null, items: {}, cam: { x: 0, y: 0, z: 1 },
  sel: new Set(), tool: 'select', editing: null, readOnly: false,
  stickyColor: STICKY[0], shapeKind: 'rect',
};
let boards = [];          // board metadata list
let base = {};            // id -> JSON string of last committed item state
const undoStack = [], redoStack = [];
let store = null;         // the Server adapter, set below

/* ================= history ================= */
function commit(opts = {}) {
  if (!S.boardId) return false;
  const patch = [];
  const ids = new Set([...Object.keys(base), ...Object.keys(S.items)]);
  for (const id of ids) {
    if (id.startsWith('__')) continue;
    const now = S.items[id] ? JSON.stringify(S.items[id]) : null;
    const was = base[id] ?? null;
    if (now !== was) {
      patch.push({ id, before: was, after: now });
      if (now === null) delete base[id]; else base[id] = now;
    }
  }
  if (!patch.length) return false;
  if (!opts.noHistory) {
    undoStack.push(patch);
    if (undoStack.length > 300) undoStack.shift();
    redoStack.length = 0;
  }
  if (S.readOnly) { updateUndo(); return true; }
  store.writeItems(S.boardId, patch.map(p => ({ id: p.id, data: p.after ? JSON.parse(p.after) : null })));
  updateUndo();
  return true;
}
function applyPatch(patch, useBefore) {
  for (const p of patch) {
    const v = useBefore ? p.before : p.after;
    if (v === null) delete S.items[p.id]; else S.items[p.id] = JSON.parse(v);
  }
}
function undo() {
  finishEdit(); const p = undoStack.pop(); if (!p) return;
  applyPatch(p, true); redoStack.push(p); commit({ noHistory: true }); afterHistory(p);
}
function redo() {
  finishEdit(); const p = redoStack.pop(); if (!p) return;
  applyPatch(p, false); undoStack.push(p); commit({ noHistory: true }); afterHistory(p);
}
function afterHistory(p) {
  const alive = p.map(x => x.id).filter(id => S.items[id]);
  const solid = alive.filter(id => S.items[id].type !== 'link');
  S.sel = new Set(solid.length ? solid : alive);
  pruneSel(); render(); updateUndo();
}
function resetHistory() { undoStack.length = 0; redoStack.length = 0; updateUndo(); }
function updateUndo() {
  $('#undoBtn').disabled = !undoStack.length || S.readOnly;
  $('#redoBtn').disabled = !redoStack.length || S.readOnly;
}
function pruneSel() { for (const id of [...S.sel]) if (!S.items[id]) S.sel.delete(id); }

/* ================= status & toast ================= */
let statusState = 'local';
function setStatus(state) {
  statusState = state;
  const el = $('#status'), t = $('#statusText');
  el.className = 'status ' + ({ saved: '', busy: 'busy', offline: 'err', readonly: 'local' }[state] || '');
  const map = {
    saved: ['Gespeichert', 'Alle Änderungen sind auf deinem Server gespeichert.'],
    busy: ['Speichert …', 'Änderungen werden gerade gespeichert.'],
    offline: ['Offline', 'Der Server ist gerade nicht erreichbar. Änderungen werden nachgeholt, sobald er wieder da ist. Lass diesen Tab bis dahin offen.'],
    readonly: ['Nur ansehen', 'Änderungen werden nicht gespeichert.'],
  }[state] || ['', ''];
  t.textContent = map[0]; el.title = map[1];
}
let toastTimer = 0;
function toast(msg, ms = 2600) {
  const el = $('#toast'); el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/* ================= storage: own server ================= */
const clientId = uid();
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
async function api(method, url, body) {
  let r;
  try {
    r = await fetch(url, {
      method, credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) { throw new HttpError(0, 'Server nicht erreichbar'); }
  if (r.status === 401) { location.href = '/login'; throw new HttpError(401, 'Bitte anmelden'); }
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new HttpError(r.status, (data && data.error) || `Fehler ${r.status}`);
  return data;
}
const Server = {
  q: new Map(),        // boardId -> Map(itemId -> item | null), waiting to be sent
  inflight: null,      // { boardId, ids } currently on the wire
  timer: 0, offline: false,
  listBoards() { return api('GET', '/api/boards'); },
  loadBoard(id) { return api('GET', '/api/boards/' + encodeURIComponent(id)); },
  createBoard(meta, items) { return api('POST', '/api/boards', { id: meta.id, name: meta.name, items }); },
  renameBoard(id, name) { return api('PATCH', '/api/boards/' + encodeURIComponent(id), { name }); },
  deleteBoard(id) { this.q.delete(id); return api('DELETE', '/api/boards/' + encodeURIComponent(id)); },
  writeItems(boardId, changes) {
    let m = this.q.get(boardId);
    if (!m) this.q.set(boardId, (m = new Map()));
    for (const ch of changes) m.set(ch.id, ch.data);
    this.schedule(150);
  },
  schedule(ms) { clearTimeout(this.timer); this.timer = setTimeout(() => this.flush(), ms); this.status(); },
  async flush() {
    if (this.inflight) return;
    const next = [...this.q.entries()].find(([, m]) => m.size);
    if (!next) { this.status(); return; }
    const [boardId, m] = next;
    this.q.delete(boardId);
    const changes = [...m.entries()].map(([id, data]) => ({ id, data }));
    this.inflight = { boardId, ids: new Set(m.keys()) };
    this.status();
    try {
      await api('POST', `/api/boards/${encodeURIComponent(boardId)}/changes`, { client: clientId, changes });
      this.offline = false;
    } catch (e) {
      if (e.status === 0 || e.status >= 500 || e.status === 429) { // keep the changes and try again
        const cur = this.q.get(boardId) || new Map();
        for (const c of changes) if (!cur.has(c.id)) cur.set(c.id, c.data);
        this.q.set(boardId, cur);
        this.offline = true; this.inflight = null; this.schedule(4000);
        return;
      }
      if (e.status !== 404) toast('Eine Änderung wurde vom Server abgelehnt: ' + e.message, 5000);
    }
    this.inflight = null;
    if ([...this.q.values()].some(x => x.size)) this.flush(); else this.status();
  },
  isPending(boardId, id) {
    const m = this.q.get(boardId);
    return !!(m && m.has(id)) || !!(this.inflight && this.inflight.boardId === boardId && this.inflight.ids.has(id));
  },
  pending() { return !!this.inflight || [...this.q.values()].some(m => m.size); },
  status() { setStatus(this.offline ? 'offline' : this.pending() ? 'busy' : 'saved'); },
};
store = Server;

/* Live updates from other open devices (server-sent events). */
let events = null, eventsLost = false;
function connectEvents() {
  if (events) events.close();
  events = new EventSource('/api/events');
  events.addEventListener('open', () => {
    if (!eventsLost) return;
    eventsLost = false;
    if (Server.offline) { Server.offline = false; Server.schedule(0); }
    resync();
  });
  events.addEventListener('error', () => { eventsLost = true; });
  events.addEventListener('boards', e => { try { onBoards(JSON.parse(e.data)); } catch (err) { /* ignore */ } });
  events.addEventListener('changes', e => {
    let d; try { d = JSON.parse(e.data); } catch (err) { return; }
    if (d.client === clientId || d.board !== S.boardId) return;
    for (const c of d.changes) onRemote(c.data ? 'modified' : 'removed', c.id, c.data);
  });
}
async function resync() {
  try { onBoards(await Server.listBoards()); } catch (e) { return; }
  const id = S.boardId; if (!id) return;
  try {
    const b = await Server.loadBoard(id);
    if (S.boardId !== id) return;
    for (const k in b.items) onRemote('modified', k, b.items[k]);
    for (const k of Object.keys(base)) if (!(k in b.items)) onRemote('removed', k, null);
  } catch (e) { if (e.status === 404) closeBoard(); }
}

/* ================= model helpers ================= */
const I = id => S.items[id];
const isNode = n => n && n.type === 'node';
function maxZ() { let m = 0; for (const id in S.items) m = Math.max(m, S.items[id].z || 0); return m; }
function kidsOf(id) {
  const out = [];
  for (const k in S.items) { const n = S.items[k]; if (n.type === 'node' && n.parent === id) out.push(n); }
  return out.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
}
function isRootNode(n) { return isNode(n) && (!n.parent || !isNode(S.items[n.parent])); }
function rootOf(n) {
  let c = n, guard = 0;
  while (c && c.parent && isNode(S.items[c.parent]) && guard++ < 500) c = S.items[c.parent];
  return c;
}
function subtreeIds(id) {
  const out = [id], seen = new Set([id]);
  for (let i = 0; i < out.length; i++) for (const k of kidsOf(out[i])) if (!seen.has(k.id)) { seen.add(k.id); out.push(k.id); }
  return out;
}
function isAncestor(a, b) { // is a an ancestor of b?
  let c = S.items[b], guard = 0;
  while (c && c.parent && guard++ < 500) { if (c.parent === a) return true; c = S.items[c.parent]; }
  return false;
}
function linksOf(ids) {
  const set = new Set(ids), out = [];
  for (const k in S.items) { const l = S.items[k]; if (l.type === 'link' && ((l.a && set.has(l.a.id)) || (l.b && set.has(l.b.id)))) out.push(l.id); }
  return out;
}
function newItem(type, props) {
  const o = Object.assign({ id: uid(), type, z: maxZ() + 1 }, props);
  S.items[o.id] = o; return o;
}

/* ================= mindmap tree pass ================= */
const M = {};   // id -> {depth, color, dir, hidden, root, kids:[...]}
function computeTree() {
  for (const k in M) delete M[k];
  const kidMap = {};
  for (const k in S.items) {
    const n = S.items[k]; if (n.type !== 'node') continue;
    if (n.parent && isNode(S.items[n.parent])) (kidMap[n.parent] || (kidMap[n.parent] = [])).push(n);
  }
  for (const k in kidMap) kidMap[k].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
  const visit = (n, depth, color, dir, hidden, root) => {
    if (M[n.id]) return; // cycle guard
    const kids = kidMap[n.id] || [];
    M[n.id] = { depth, color, dir, hidden, root, kids };
    kids.forEach((c, i) => {
      const cdir = depth === 0 ? (c.side === 'l' ? -1 : 1) : dir;
      const ccol = c.color || (depth === 0 ? BRANCH[i % BRANCH.length] : color);
      visit(c, depth + 1, ccol, cdir, hidden || !!n.collapsed, root);
    });
  };
  for (const k in S.items) { const n = S.items[k]; if (isRootNode(n)) visit(n, 0, n.color || null, 1, false, n.id); }
  for (const k in S.items) { const n = S.items[k]; if (n.type === 'node' && !M[n.id]) visit(n, 0, n.color || null, 1, false, n.id); }
}

/* ================= layout ================= */
const SZ = {};  // measured node sizes
const L = {};   // id -> {x, y, w, h}
const HGAP = d => d === 0 ? 64 : 42;
const VGAP = d => d === 0 ? 22 : 12;
function layoutAll(drag) {
  for (const k in L) delete L[k];
  const sh = {};
  const size = id => SZ[id] || { w: 120, h: 36 };
  const visKids = id => { const n = S.items[id]; return n && n.collapsed ? [] : (M[id] ? M[id].kids : []); };
  const subH = id => {
    if (sh[id] != null) return sh[id];
    sh[id] = size(id).h; // guard
    const ks = visKids(id);
    let t = 0; ks.forEach((k, i) => { t += subH(k.id) + (i ? VGAP(M[id].depth) : 0); });
    return (sh[id] = Math.max(size(id).h, t));
  };
  const place = (pid, ks, dir) => {
    const p = L[pid], d = M[pid].depth;
    let total = 0; ks.forEach((k, i) => { total += subH(k.id) + (i ? VGAP(d) : 0); });
    let y = p.y + p.h / 2 - total / 2;
    for (const k of ks) {
      const s = size(k.id), h = subH(k.id);
      const x = dir > 0 ? p.x + p.w + HGAP(d) : p.x - HGAP(d) - s.w;
      L[k.id] = { x, y: y + h / 2 - s.h / 2, w: s.w, h: s.h };
      place(k.id, visKids(k.id), dir);
      y += h + VGAP(d);
    }
  };
  for (const k in S.items) {
    const n = S.items[k];
    if (n.type !== 'node' || !M[k] || M[k].depth !== 0) continue;
    const s = size(k);
    L[k] = { x: n.x, y: n.y, w: s.w, h: s.h };
    const ks = visKids(k);
    place(k, ks.filter(c => c.side !== 'l'), 1);
    place(k, ks.filter(c => c.side === 'l'), -1);
  }
  if (drag) for (const id of drag.ids) if (L[id]) { L[id].x += drag.dx; L[id].y += drag.dy; }
  for (const k in S.items) {
    const n = S.items[k];
    if (n.type === 'node' || n.type === 'link') continue;
    if (n.type === 'text') { const s = SZ[k] || { w: 60, h: 24 }; L[k] = { x: n.x, y: n.y, w: s.w, h: s.h }; }
    else L[k] = { x: n.x, y: n.y, w: n.w, h: n.h };
  }
}
function itemRect(id) { return L[id] || null; }
function selBounds(ids) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const id of ids) {
    let r = L[id];
    if (!r && S.items[id] && S.items[id].type === 'link') r = linkBox(S.items[id]);
    if (!r) continue;
    x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y); x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h);
  }
  return x1 === Infinity ? null : { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}
function contentBounds() {
  const ids = Object.keys(S.items).filter(id => !(M[id] && M[id].hidden));
  return selBounds(ids);
}

/* ================= link geometry ================= */
function endPoint(e) {
  if (e && e.id) { const r = L[e.id]; if (!r || (M[e.id] && M[e.id].hidden)) return null; return { r, cx: r.x + r.w / 2, cy: r.y + r.h / 2 }; }
  if (e && typeof e.x === 'number') return { r: null, cx: e.x, cy: e.y };
  return null;
}
function anchor(ep, tx, ty) {
  if (!ep.r) return { x: ep.cx, y: ep.cy, nx: 0, ny: 0 };
  const r = ep.r, dx = tx - ep.cx, dy = ty - ep.cy, g = 5;
  if (Math.abs(dx) / (r.w / 2 + 1) > Math.abs(dy) / (r.h / 2 + 1)) {
    const s = dx >= 0 ? 1 : -1; return { x: ep.cx + s * (r.w / 2 + g), y: ep.cy, nx: s, ny: 0 };
  }
  const s = dy >= 0 ? 1 : -1; return { x: ep.cx, y: ep.cy + s * (r.h / 2 + g), nx: 0, ny: s };
}
function linkGeom(l) {
  const ea = endPoint(l.a), eb = endPoint(l.b);
  if (!ea || !eb) return null;
  const A = anchor(ea, eb.cx, eb.cy), B = anchor(eb, ea.cx, ea.cy);
  const dist = Math.hypot(B.x - A.x, B.y - A.y);
  let c1, c2;
  if (l.style === 'straight') { c1 = { x: A.x, y: A.y }; c2 = { x: B.x, y: B.y }; }
  else {
    const k = clamp(dist * 0.42, 24, 170);
    c1 = { x: A.x + A.nx * k, y: A.y + A.ny * k }; c2 = { x: B.x + B.nx * k, y: B.y + B.ny * k };
    if (!A.nx && !A.ny) c1 = { x: A.x + (c2.x - A.x) * 0.3, y: A.y + (c2.y - A.y) * 0.3 };
    if (!B.nx && !B.ny) c2 = { x: B.x + (c1.x - B.x) * 0.3, y: B.y + (c1.y - B.y) * 0.3 };
  }
  const mid = { x: .125 * A.x + .375 * c1.x + .375 * c2.x + .125 * B.x, y: .125 * A.y + .375 * c1.y + .375 * c2.y + .125 * B.y };
  return { A, B, c1, c2, mid, d: `M${r1(A.x)} ${r1(A.y)} C${r1(c1.x)} ${r1(c1.y)} ${r1(c2.x)} ${r1(c2.y)} ${r1(B.x)} ${r1(B.y)}` };
}
function arrowPath(tip, from, w) {
  let dx = tip.x - from.x, dy = tip.y - from.y; const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
  const s = 7 + w * 1.6, bx = tip.x - dx * s, by = tip.y - dy * s, px = -dy * s * 0.55, py = dx * s * 0.55;
  return `M${r1(tip.x)} ${r1(tip.y)} L${r1(bx + px)} ${r1(by + py)} L${r1(bx - px)} ${r1(by - py)} Z`;
}
function linkBox(l) {
  const g = linkGeom(l); if (!g) return null;
  const xs = [g.A.x, g.B.x, g.mid.x], ys = [g.A.y, g.B.y, g.mid.y];
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
function branchPath(pr, cr, dir) {
  const sx = dir > 0 ? pr.x + pr.w : pr.x, sy = pr.y + pr.h / 2;
  const ex = dir > 0 ? cr.x : cr.x + cr.w, ey = cr.y + cr.h / 2;
  const mx = (sx + ex) / 2;
  return `M${r1(sx)} ${r1(sy)} C${r1(mx)} ${r1(sy)} ${r1(mx)} ${r1(ey)} ${r1(ex)} ${r1(ey)}`;
}
function strokePath(pts) {
  if (pts.length < 4) return '';
  if (pts.length === 4) return `M${pts[0]} ${pts[1]} L${pts[2]} ${pts[3]}`;
  let d = `M${pts[0]} ${pts[1]}`;
  for (let i = 2; i < pts.length - 2; i += 2) {
    const mx = r1((pts[i] + pts[i + 2]) / 2), my = r1((pts[i + 1] + pts[i + 3]) / 2);
    d += ` Q${pts[i]} ${pts[i + 1]} ${mx} ${my}`;
  }
  const n = pts.length; return d + ` L${pts[n - 2]} ${pts[n - 1]}`;
}
function shapeSvg(kind, w, h) {
  const st = 'fill="var(--c)" stroke="rgba(0,0,0,.18)" stroke-width="1.5"';
  if (kind === 'ellipse') return `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${Math.max(1, w / 2 - 1)}" ry="${Math.max(1, h / 2 - 1)}" ${st}/>`;
  if (kind === 'diamond') return `<polygon points="${w / 2},1 ${w - 1},${h / 2} ${w / 2},${h - 1} 1,${h / 2}" ${st}/>`;
  return `<rect x="1" y="1" width="${Math.max(1, w - 2)}" height="${Math.max(1, h - 2)}" rx="10" ${st}/>`;
}

/* ================= rendering ================= */
const els = {};
let rafId = 0, dragView = null, gesture = null, dropHint = null, marquee = null;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const w2s = (x, y) => ({ x: x * S.cam.z + S.cam.x, y: y * S.cam.z + S.cam.y });
const s2w = (x, y) => ({ x: (x - S.cam.x) / S.cam.z, y: (y - S.cam.y) / S.cam.z });
function render() { if (!rafId) rafId = requestAnimationFrame(draw); }
function draw() {
  rafId = 0;
  computeTree(); syncItems(); measure(); layoutAll(dragView); placeItems(); drawWires(); drawOverlay(); updateCtx();
}
function syncItems() {
  for (const id in els) if (!S.items[id] || S.items[id].type === 'link' || els[id]._type !== S.items[id].type) { els[id].remove(); delete els[id]; }
  for (const id in S.items) {
    const n = S.items[id]; if (n.type === 'link') continue;
    let el = els[id];
    if (!el) { el = createEl(n); els[id] = el; itemsEl.appendChild(el); }
    updateEl(el, n);
  }
}
function createEl(n) {
  const el = document.createElement('div');
  el._type = n.type; el.dataset.id = n.id;
  if (n.type === 'stroke') el.innerHTML = '<svg><path class="vis" fill="none" stroke-linecap="round" stroke-linejoin="round"></path><path class="hit" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"></path></svg>';
  else if (n.type === 'shape') el.innerHTML = '<svg aria-hidden="true"></svg><div class="tx"></div>';
  else el.innerHTML = '<div class="tx"></div>';
  el._tx = el.querySelector('.tx');
  return el;
}
function updateEl(el, n) {
  const m = M[n.id], editing = S.editing === n.id;
  let cls = 'it ' + n.type;
  if (n.type === 'node') {
    const d = m ? m.depth : 0;
    cls += d === 0 ? ' root' : d === 1 ? ' l1' : ' l2';
    if (d === 0 && n.color) cls += ' custom';
    if (dragView && dragView.ids.includes(n.id)) cls += ' dragging';
    if (dropHint && dropHint.mode === 'child' && dropHint.target === n.id) cls += ' drop-child';
  }
  if (n.type === 'text' && !n.w) cls += ' auto';
  if (editing) cls += ' editing';
  if (el.className !== cls) el.className = cls;
  const hidden = !!(m && m.hidden);
  if (el._hidden !== hidden) { el.style.display = hidden ? 'none' : ''; el._hidden = hidden; }
  const c = n.type === 'node' ? ((m && m.color) || '#8790A3') : (n.color || '');
  if (el._c !== c) { if (c) el.style.setProperty('--c', c); else el.style.removeProperty('--c'); el._c = c; }
  if (el._tx) {
    if (!editing && el._t !== (n.text || '')) { el._tx.textContent = n.text || ''; el._t = n.text || ''; el._fit = null; }
    const ph = n.type === 'node' ? (m && m.depth === 0 ? 'Hauptthema' : 'Thema') : n.type === 'text' ? 'Text' : '';
    if (el._tx.dataset.ph !== ph) el._tx.dataset.ph = ph;
  }
  if (n.type === 'sticky' || n.type === 'shape') {
    if (el._w !== n.w || el._h !== n.h) { el.style.width = n.w + 'px'; el.style.height = n.h + 'px'; el._w = n.w; el._h = n.h; el._fit = null; }
  }
  if (n.type === 'shape') {
    const key = (n.shape || 'rect') + n.w + 'x' + n.h;
    if (el._sk !== key) {
      const svg = el.firstChild; svg.setAttribute('viewBox', `0 0 ${n.w} ${n.h}`);
      svg.innerHTML = shapeSvg(n.shape || 'rect', n.w, n.h); el._sk = key;
    }
  }
  if (n.type === 'text') {
    const fs = (n.size || 20) + 'px', w = n.w ? n.w + 'px' : '';
    if (el.style.fontSize !== fs) el.style.fontSize = fs;
    if (el.style.width !== w) el.style.width = w;
    const fw = n.size >= 32 ? '700' : '500';
    if (el.style.fontWeight !== fw) el.style.fontWeight = fw;
  }
  if (n.type === 'stroke') {
    const key = n.pts.length + ':' + n.pts[0] + ':' + n.pts[n.pts.length - 1] + ':' + n.w + 'x' + n.h + (n.color || '') + n.width;
    if (el._sk !== key) {
      const svg = el.firstChild, pad = 10;
      svg.setAttribute('width', n.w + pad * 2); svg.setAttribute('height', n.h + pad * 2);
      svg.style.margin = `-${pad}px 0 0 -${pad}px`;
      svg.setAttribute('viewBox', `${-pad} ${-pad} ${n.w + pad * 2} ${n.h + pad * 2}`);
      const d = strokePath(n.pts);
      svg.children[0].setAttribute('d', d); svg.children[1].setAttribute('d', d);
      svg.children[0].setAttribute('stroke', n.color || 'var(--ink)');
      svg.children[0].setAttribute('stroke-width', n.width || 3);
      el._sk = key;
    }
  }
}
function fitSticky(el, n) {
  const key = (n.text || '') + '|' + n.w + 'x' + n.h;
  if (el._fit === key) return;
  el._fit = key;
  const tx = el._tx, aw = n.w - 28, ah = n.h - 28;
  let f = Math.min(28, Math.max(12, n.w / 7));
  tx.style.maxHeight = 'none'; tx.style.overflowWrap = 'normal'; el.style.fontSize = f + 'px';
  let guard = 0;
  while (f > 8 && guard++ < 30 && (tx.scrollHeight > ah + 1 || tx.scrollWidth > aw + 1)) { f *= 0.92; el.style.fontSize = r1(f) + 'px'; }
  tx.style.maxHeight = ''; tx.style.overflowWrap = '';
}
function measure() {
  for (const id in els) {
    const n = S.items[id], el = els[id];
    if (!n || el._hidden) continue;
    if (n.type === 'node' || n.type === 'text') SZ[id] = { w: el.offsetWidth, h: el.offsetHeight };
    else if (n.type === 'sticky' && S.editing !== id) fitSticky(el, n);
  }
}
function placeItems() {
  for (const id in els) {
    const r = L[id], el = els[id], n = S.items[id];
    if (!r || !n) continue;
    const t = `translate(${r1(r.x)}px,${r1(r.y)}px)`;
    if (el._tr !== t) { el.style.transform = t; el._tr = t; }
    const z = String(n.type === 'node' ? 100000 + (n.z || 0) : (n.z || 0));
    if (el._z !== z) { el.style.zIndex = z; el._z = z; }
  }
}
function drawWires() {
  let h = '', lab = '';
  for (const id in M) {
    const m = M[id], n = S.items[id];
    if (!n || m.depth === 0 || m.hidden) continue;
    const p = L[n.parent], c = L[id]; if (!p || !c) continue;
    const dragging = dragView && dragView.ids[0] === id;
    h += `<path d="${branchPath(p, c, m.dir)}" stroke="${m.color}" stroke-width="${m.depth === 1 ? 3 : 2}" fill="none" stroke-linecap="round"${dragging ? ' stroke-dasharray="4 6" opacity=".55"' : ''}/>`;
  }
  for (const id in S.items) {
    const l = S.items[id]; if (l.type !== 'link') continue;
    const g = linkGeom(l); if (!g) continue;
    const col = l.color || 'var(--link)', w = l.width || 2;
    if (S.sel.has(id)) h += `<path d="${g.d}" stroke="var(--accent)" stroke-width="${w + 6}" opacity=".28" fill="none" stroke-linecap="round"/>`;
    h += `<path d="${g.d}" stroke="${col}" stroke-width="${w}" fill="none" stroke-linecap="round"${l.dash ? ' stroke-dasharray="7 6"' : ''}/>`;
    const ar = l.arrow || 'end';
    if (ar !== 'none') h += `<path d="${arrowPath(g.B, Math.hypot(g.c2.x - g.B.x, g.c2.y - g.B.y) > 2 ? g.c2 : g.A, w)}" fill="${col}"/>`;
    if (ar === 'both') h += `<path d="${arrowPath(g.A, Math.hypot(g.c1.x - g.A.x, g.c1.y - g.A.y) > 2 ? g.c1 : g.B, w)}" fill="${col}"/>`;
    h += `<path class="hit" data-id="${id}" d="${g.d}" stroke-width="16"/>`;
    if (l.label && !(S.editing === id)) lab += `<div class="lbl" data-id="${id}" style="left:${r1(g.mid.x)}px;top:${r1(g.mid.y)}px">${esc(l.label)}</div>`;
  }
  for (const id in M) {
    const m = M[id], n = S.items[id];
    if (!n || m.hidden || !m.kids.length || !L[id] || !n.collapsed) continue;
    const r = L[id];
    const right = m.depth === 0 ? m.kids.some(k => k.side !== 'l') : m.dir > 0;
    const x = right ? r.x + r.w + 4 : r.x - 22;
    const label = n.collapsed ? String(subtreeIds(id).length - 1) : '−';
    lab += `<div class="toggle" data-toggle="${id}" title="${n.collapsed ? 'Aufklappen' : 'Zuklappen'}" style="--c:${m.color || 'var(--link)'};left:${r1(x)}px;top:${r1(r.y + r.h / 2 - 9)}px">${label}</div>`;
  }
  wireG.innerHTML = h; labelsEl.innerHTML = lab;
}
const box = (x, y, w, h, cls, extra = '') => `<div class="ov ${cls}" style="left:${r1(x)}px;top:${r1(y)}px;width:${r1(w)}px;height:${r1(h)}px"${extra}></div>`;
const handle = (x, y, cls, data, title = '', inner = '') => `<div class="h ${cls}" data-h="${data}" style="left:${r1(x)}px;top:${r1(y)}px"${title ? ` title="${title}"` : ''}>${inner}</div>`;
const PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
function drawOverlay() {
  const z = S.cam.z; let h = '';
  for (const id of S.sel) {
    const n = S.items[id]; if (!n || n.type === 'link') continue;
    const r = L[id]; if (!r || (M[id] && M[id].hidden)) continue;
    const p = w2s(r.x, r.y);
    h += box(p.x - 3, p.y - 3, r.w * z + 6, r.h * z + 6, 'sel-box' + (S.sel.size > 1 ? ' soft' : ''));
  }
  const single = S.sel.size === 1 ? S.items[[...S.sel][0]] : null;
  const busy = gesture && gesture.kind !== 'none';
  if (single && !S.readOnly && !busy && S.editing !== single.id) {
    if (single.type === 'link') {
      const g = linkGeom(single);
      if (g) { const a = w2s(g.A.x, g.A.y), b = w2s(g.B.x, g.B.y); h += handle(a.x, a.y, 'h-end', 'end-a', 'Endpunkt verschieben') + handle(b.x, b.y, 'h-end', 'end-b', 'Endpunkt verschieben'); }
    } else if (L[single.id] && !(M[single.id] && M[single.id].hidden)) {
      const r = L[single.id], p = w2s(r.x, r.y), W = r.w * z, H = r.h * z, cx = p.x + W / 2, cy = p.y + H / 2;
      if (single.type === 'sticky' || single.type === 'shape' || single.type === 'text') h += handle(p.x + W + 3, p.y + H + 3, 'h-resize', 'resize', 'Größe ändern');
      if (single.type === 'node') {
        const m = M[single.id], off = single.collapsed && m.kids.length ? 52 : 26;
        if (m.depth === 0 || m.dir > 0) h += handle(p.x + W + off, cy, 'h-plus', 'plus-r', 'Unterthema hinzufügen (Tab)', PLUS);
        if (m.depth === 0 || m.dir < 0) h += handle(p.x - off, cy, 'h-plus', 'plus-l', 'Unterthema hinzufügen', PLUS);
        if (m.depth === 0) h += handle(cx, p.y - 16, 'h-dot', 'dot', 'Ziehen für Verbindung') + handle(cx, p.y + H + 16, 'h-dot', 'dot', 'Ziehen für Verbindung');
      } else if (single.type !== 'stroke') {
        h += handle(cx, p.y - 16, 'h-dot', 'dot', 'Ziehen für Verbindung') + handle(cx, p.y + H + 16, 'h-dot', 'dot', 'Ziehen für Verbindung')
           + handle(p.x - 16, cy, 'h-dot', 'dot', 'Ziehen für Verbindung') + handle(p.x + W + 16, cy, 'h-dot', 'dot', 'Ziehen für Verbindung');
      }
    }
  }
  if (marquee) {
    const x = Math.min(marquee.x0, marquee.x1), y = Math.min(marquee.y0, marquee.y1);
    h += box(x, y, Math.abs(marquee.x1 - marquee.x0), Math.abs(marquee.y1 - marquee.y0), 'marquee');
  }
  if (dropHint && (dropHint.mode === 'before' || dropHint.mode === 'after') && L[dropHint.target]) {
    const r = L[dropHint.target], p = w2s(r.x, r.y);
    const y = dropHint.mode === 'before' ? p.y - VGAP(1) * z / 2 - 1.5 : p.y + r.h * z + VGAP(1) * z / 2 - 1.5;
    h += box(p.x, y, r.w * z, 3, 'drop-line');
  }
  if (gesture && gesture.kind === 'nodedrag' && gesture.moved && dropHint && gesture.lx != null) {
    const t = dropHint.target && S.items[dropHint.target];
    const msg = dropHint.mode === 'none' ? 'Loslassen: zurück an den alten Platz'
      : dropHint.mode === 'free' ? 'Loslassen: als eigene Mindmap lösen'
      : dropHint.mode === 'child' ? `Wird Unterthema von „${((t && t.text) || 'Thema').slice(0, 28)}“` : 'Hier einsortieren';
    h += `<div class="ov drag-hint" style="left:${r1(gesture.lx + 16)}px;top:${r1(gesture.ly + 20)}px">${esc(msg)}</div>`;
  }
  if (gesture && gesture.kind === 'link' && gesture.target && L[gesture.target]) {
    const r = L[gesture.target], p = w2s(r.x, r.y);
    h += box(p.x - 4, p.y - 4, r.w * z + 8, r.h * z + 8, 'sel-box');
  }
  overlay.innerHTML = h;
}
function applyCam() {
  const { x, y, z } = S.cam;
  world.style.transform = `translate(${x}px,${y}px) scale(${z})`;
  let g = 24 * z; while (g < 12) g *= 2; while (g > 96) g /= 2;
  stage.style.backgroundSize = `${g}px ${g}px`;
  stage.style.backgroundPosition = `${x}px ${y}px`;
  $('#zoomPct').textContent = Math.round(z * 100) + ' %';
  drawOverlay(); updateCtx(); saveCamSoon();
}
let camTimer = 0;
function saveCamSoon() { clearTimeout(camTimer); camTimer = setTimeout(() => { if (S.boardId) lsSet('cam.' + S.boardId, S.cam); }, 400); }

/* ================= operations ================= */
function select(ids) { S.sel = new Set(ids); render(); }
function setTool(t) {
  if (S.readOnly && !['select', 'hand'].includes(t)) return;
  S.tool = t; finishEdit();
  document.querySelectorAll('.tool').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  stage.className = 'tool-' + t + (spaceDown ? ' panning' : '');
  closeFlyout();
  if (t === 'sticky' || t === 'shape') openFlyout(t);
}
function addChild(pid, side) {
  const p = S.items[pid]; if (!isNode(p) || S.readOnly) return;
  if (p.collapsed) p.collapsed = false;
  const ks = kidsOf(pid);
  const o = { parent: pid, order: ks.length ? ks[ks.length - 1].order + 1 : 1, text: '' };
  if (isRootNode(p)) {
    const r = ks.filter(k => k.side !== 'l').length, l = ks.length - r;
    o.side = side || (r <= l ? 'r' : 'l');
    o.color = freeBranchColor(ks);
  }
  const n = newItem('node', o);
  S.sel = new Set([n.id]); startEdit(n.id, { isNew: true });
}
function freeBranchColor(sibs) {
  const used = new Set(sibs.map(s => s.color));
  return BRANCH.find(c => !used.has(c)) || BRANCH[sibs.length % BRANCH.length];
}
function addSibling(id) {
  const n = S.items[id]; if (!isNode(n) || S.readOnly) return;
  if (isRootNode(n)) return addChild(id);
  const sibs = kidsOf(n.parent), i = sibs.findIndex(s => s.id === id), next = sibs[i + 1];
  const o = { parent: n.parent, order: next ? (n.order + next.order) / 2 : n.order + 1, text: '' };
  if (isRootNode(S.items[n.parent])) { o.side = n.side || 'r'; o.color = freeBranchColor(sibs); }
  const s = newItem('node', o);
  S.sel = new Set([s.id]); startEdit(s.id, { isNew: true });
}
function deleteIds(ids) {
  const all = new Set();
  for (const id of ids) { const n = S.items[id]; if (!n) continue; if (n.type === 'node') subtreeIds(id).forEach(x => all.add(x)); else all.add(id); }
  for (const l of linksOf([...all])) all.add(l);
  for (const id of all) delete S.items[id];
  return all;
}
function deleteSelection() {
  if (S.readOnly || !S.sel.size) return;
  const single = S.sel.size === 1 ? S.items[[...S.sel][0]] : null;
  const parent = single && isNode(single) && single.parent && S.items[single.parent] ? single.parent : null;
  deleteIds([...S.sel]);
  S.sel = new Set(parent ? [parent] : []);
  commit(); render();
}
function toggleCollapse(id) {
  const n = S.items[id]; if (!isNode(n) || S.readOnly) return;
  n.collapsed = !n.collapsed; if (!n.collapsed) delete n.collapsed;
  S.sel = new Set([id]); commit(); render();
}
function createAt(tool, pt) {
  let n;
  if (tool === 'node') n = newItem('node', { parent: null, x: r1(pt.x - 80), y: r1(pt.y - 26), text: '' });
  else if (tool === 'sticky') n = newItem('sticky', { x: r1(pt.x - 100), y: r1(pt.y - 100), w: 200, h: 200, color: S.stickyColor, text: '' });
  else if (tool === 'text') n = newItem('text', { x: r1(pt.x - 8), y: r1(pt.y - 16), text: '', size: 20 });
  else if (tool === 'shape') n = newItem('shape', { shape: S.shapeKind, x: r1(pt.x - 80), y: r1(pt.y - 55), w: 160, h: 110, color: '#A9D4FF', text: '' });
  if (!n) return;
  setTool('select');
  S.sel = new Set([n.id]); startEdit(n.id, { isNew: true });
}
function navigate(id, key) {
  const m = M[id], n = S.items[id]; if (!m) return;
  let t = null;
  if (key === 'ArrowRight' || key === 'ArrowLeft') {
    const d = key === 'ArrowRight' ? 1 : -1;
    if (m.depth === 0) { if (!n.collapsed) t = m.kids.find(k => (d > 0 ? k.side !== 'l' : k.side === 'l')); }
    else if (m.dir === d) { if (!n.collapsed && m.kids.length) t = m.kids[0]; }
    else t = S.items[n.parent];
  } else if (m.depth > 0) {
    const pm = M[n.parent]; if (!pm) return;
    const sibs = pm.depth === 0 ? pm.kids.filter(k => (k.side === 'l') === (n.side === 'l')) : pm.kids;
    const i = sibs.findIndex(s => s.id === id);
    t = sibs[i + (key === 'ArrowDown' ? 1 : -1)];
  }
  if (t) { S.sel = new Set([t.id]); render(); requestAnimationFrame(() => ensureVisible(t.id)); }
}
function ensureVisible(id) {
  const r = L[id]; if (!r) return;
  const p = w2s(r.x, r.y), W = r.w * S.cam.z, H = r.h * S.cam.z, m = 80;
  let dx = 0, dy = 0;
  if (p.x < m) dx = m - p.x; else if (p.x + W > innerWidth - m) dx = innerWidth - m - p.x - W;
  if (p.y < m) dy = m - p.y; else if (p.y + H > innerHeight - m) dy = innerHeight - m - p.y - H;
  if (dx || dy) { S.cam.x += dx; S.cam.y += dy; applyCam(); }
}
function nudge(dx, dy) {
  let moved = false;
  for (const id of S.sel) {
    const n = S.items[id]; if (!n) continue;
    if (n.type === 'node' && !isRootNode(n)) continue;
    if (n.type === 'link') { for (const e of [n.a, n.b]) if (e && !e.id) { e.x += dx; e.y += dy; moved = true; } continue; }
    n.x = r1(n.x + dx); n.y = r1(n.y + dy); moved = true;
  }
  if (moved) { commit(); render(); }
}
function zoomAt(sx, sy, f) {
  const z1 = clamp(S.cam.z * f, 0.1, 4), w = s2w(sx, sy);
  S.cam.z = z1; S.cam.x = sx - w.x * z1; S.cam.y = sy - w.y * z1; applyCam();
}
const zoomBy = f => zoomAt(innerWidth / 2, innerHeight / 2, f);
function zoomTo(z) { zoomBy(z / S.cam.z); }
function fitAll() {
  computeTree(); layoutAll();
  const b = contentBounds();
  if (!b) { S.cam = { x: innerWidth / 2, y: innerHeight / 2, z: 1 }; applyCam(); return; }
  const z = clamp(Math.min((innerWidth - 180) / b.w, (innerHeight - 180) / b.h), 0.1, 1.25);
  S.cam = { z, x: innerWidth / 2 - (b.x + b.w / 2) * z, y: innerHeight / 2 - (b.y + b.h / 2) * z };
  applyCam(); render();
}

/* ================= copy & paste ================= */
let clip = null, pasteN = 0;
function copyData() {
  if (!S.sel.size) return null;
  const set = new Set();
  for (const id of S.sel) { const n = S.items[id]; if (!n) continue; if (n.type === 'node') subtreeIds(id).forEach(x => set.add(x)); else set.add(id); }
  for (const k in S.items) { const l = S.items[k]; if (l.type === 'link' && l.a && l.b && (!l.a.id || set.has(l.a.id)) && (!l.b.id || set.has(l.b.id))) set.add(k); }
  const items = [];
  for (const id of set) {
    const n = clone(S.items[id]); if (!n || id.startsWith('__')) continue;
    if (n.type === 'node' && (!n.parent || !set.has(n.parent))) {
      const r = L[id]; if (r) { n.x = r1(r.x); n.y = r1(r.y); }
      if (!n.color && M[id] && M[id].color) n.color = M[id].color;
      n.parent = null; delete n.side;
    }
    if (n.type === 'link') for (const e of ['a', 'b']) if (n[e].id && !set.has(n[e].id)) { const r = L[n[e].id]; n[e] = r ? { x: r.x + r.w / 2, y: r.y + r.h / 2 } : { x: 0, y: 0 }; }
    items.push(n);
  }
  return { app: 'ideenraum', items };
}
function pasteData(d, at) {
  if (!d || !Array.isArray(d.items) || S.readOnly) return;
  const map = {}; let z = maxZ() + 1;
  for (const n of d.items) if (n && n.id) map[n.id] = uid();
  pasteN++;
  let off = { x: 24 * pasteN, y: 24 * pasteN };
  if (at) { const b = boundsOf(d.items); if (b) off = { x: at.x - b.cx, y: at.y - b.cy }; }
  const top = [];
  for (const src of d.items) {
    if (!src || !TYPES.includes(src.type) || !map[src.id]) continue;
    const n = clone(src); n.id = map[src.id]; n.z = z++;
    if (n.type === 'node') {
      n.parent = n.parent && map[n.parent] ? map[n.parent] : null;
      if (!n.parent) { n.x = r1((n.x || 0) + off.x); n.y = r1((n.y || 0) + off.y); top.push(n.id); }
    } else if (n.type === 'link') {
      for (const e of ['a', 'b']) {
        if (n[e] && n[e].id) n[e] = map[n[e].id] ? { id: map[n[e].id] } : null;
        else if (n[e]) n[e] = { x: n[e].x + off.x, y: n[e].y + off.y };
      }
      if (!n.a || !n.b) continue;
      top.push(n.id);
    } else { n.x = r1((n.x || 0) + off.x); n.y = r1((n.y || 0) + off.y); top.push(n.id); }
    S.items[n.id] = sanitize(n);
  }
  S.sel = new Set(top); commit(); render();
}
function boundsOf(items) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const n of items) {
    if (!n || n.type === 'link' || (n.type === 'node' && n.parent)) continue;
    x1 = Math.min(x1, n.x); y1 = Math.min(y1, n.y); x2 = Math.max(x2, n.x + (n.w || 160)); y2 = Math.max(y2, n.y + (n.h || 50));
  }
  return x1 === Infinity ? null : { cx: (x1 + x2) / 2, cy: (y1 + y2) / 2 };
}
function pasteText(t) {
  if (S.readOnly) return;
  const lines = t.split(/\r?\n/).map(s => s.replace(/^\s*([-*•–]|\d+[.)])\s+/, '').trim()).filter(Boolean).slice(0, 200);
  if (!lines.length) return;
  const single = S.sel.size === 1 ? S.items[[...S.sel][0]] : null;
  if (single && isNode(single)) {
    let ks = kidsOf(single.id), order = ks.length ? ks[ks.length - 1].order : 0;
    const root = isRootNode(single), ids = [];
    for (const line of lines) {
      const o = { parent: single.id, order: ++order, text: line.slice(0, 2000) };
      if (root) { o.side = ks.filter(k => k.side !== 'l').length <= ks.filter(k => k.side === 'l').length ? 'r' : 'l'; o.color = freeBranchColor(ks); }
      const n = newItem('node', o); ks.push(n); ids.push(n.id);
    }
    single.collapsed && delete single.collapsed;
    S.sel = new Set(ids);
  } else {
    const c = s2w(innerWidth / 2, innerHeight / 2);
    const n = newItem('sticky', { x: r1(c.x - 100), y: r1(c.y - 100), w: 200, h: 200, color: S.stickyColor, text: lines.join('\n').slice(0, 2000) });
    S.sel = new Set([n.id]);
  }
  commit(); render();
}
const sanitize = sanitizeItem;

/* ================= pointer input ================= */
const pointers = new Map();
let spaceDown = false;
function capture(e) { try { stage.setPointerCapture(e.pointerId); } catch (err) {} }
function hitItem(sx, sy, exclude, filter) {
  for (const el of document.elementsFromPoint(sx, sy)) {
    if (!stage.contains(el)) { if (el.closest && el.closest('.panel')) return null; continue; }
    const h = el.closest('[data-id]'); if (!h) continue;
    const id = h.dataset.id;
    if (id.startsWith('__') || (exclude && exclude.has(id))) continue;
    const n = S.items[id]; if (!n || (filter && !filter(n))) continue;
    return id;
  }
  return null;
}
function captureOrig() {
  const o = {};
  for (const id of S.sel) {
    const n = S.items[id]; if (!n) continue;
    if (n.type === 'node' && !isRootNode(n)) continue;
    o[id] = n.type === 'link' ? { a: clone(n.a), b: clone(n.b) } : { x: n.x, y: n.y };
  }
  return o;
}
function applyMove(g, dx, dy) {
  for (const id in g.orig) {
    const n = S.items[id], o = g.orig[id]; if (!n) continue;
    if (n.type === 'link') { for (const e of ['a', 'b']) if (n[e] && !n[e].id) { n[e].x = r1(o[e].x + dx); n[e].y = r1(o[e].y + dy); } }
    else { n.x = r1(o.x + dx); n.y = r1(o.y + dy); }
  }
}
function startPan(e) {
  gesture = { kind: 'pan', sx: e.clientX, sy: e.clientY, cx: S.cam.x, cy: S.cam.y, pid: e.pointerId };
  stage.classList.add('panning', 'grabbing'); capture(e);
}
function startPinch() {
  const [a, b] = [...pointers.values()];
  if (gesture && gesture.moved && (gesture.kind === 'move' || gesture.kind === 'resize')) commit();
  delete S.items.__tmp; delete S.items.__pen;
  marquee = null; dragView = null; dropHint = null;
  gesture = { kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, cam0: Object.assign({}, S.cam) };
  render();
}
function updatePinch() {
  const [a, b] = [...pointers.values()]; if (!b) return;
  const g = gesture, d = Math.hypot(a.x - b.x, a.y - b.y), m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const z = clamp(g.cam0.z * d / g.d0, 0.1, 4);
  const w = { x: (g.m0.x - g.cam0.x) / g.cam0.z, y: (g.m0.y - g.cam0.y) / g.cam0.z };
  S.cam = { z, x: m.x - w.x * z, y: m.y - w.y * z }; applyCam();
}
stage.addEventListener('contextmenu', e => e.preventDefault());
stage.addEventListener('pointerdown', e => {
  closeMenus();
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) { startPinch(); return; }
  if (pointers.size > 2) return;
  const lbl = document.getElementById('lblEdit');
  if (lbl) lbl._finish();
  if (S.editing) {
    const el = els[S.editing];
    if (el && el.contains(e.target)) return;
    finishEdit();
  }
  if (document.activeElement && document.activeElement !== stage && !document.activeElement.isContentEditable) stage.focus({ preventScroll: true });
  if (e.button === 1 || e.button === 2 || spaceDown || S.tool === 'hand') { e.preventDefault(); startPan(e); return; }
  if (e.button !== 0) return;
  const sx = e.clientX, sy = e.clientY, pt = s2w(sx, sy);
  const hEl = e.target.closest('[data-h]'), tog = e.target.closest('[data-toggle]'), itEl = e.target.closest('[data-id]');
  if (tog) { e.preventDefault(); toggleCollapse(tog.dataset.toggle); return; }
  if (hEl) { e.preventDefault(); onHandleDown(hEl.dataset.h, e, pt); return; }
  if (e.pointerType === 'touch' && !itEl && S.tool === 'select') { startPan(e); return; }
  if (!S.readOnly) {
    if (S.tool === 'pen') { startPen(e, pt); return; }
    if (S.tool === 'link') { const id = itEl && itEl.dataset.id; startLink(e, id && S.items[id] && S.items[id].type !== 'link' ? { id } : { x: r1(pt.x), y: r1(pt.y) }); return; }
    if (['node', 'sticky', 'text', 'shape'].includes(S.tool)) { e.preventDefault(); createAt(S.tool, pt); return; }
  }
  if (itEl) {
    const id = itEl.dataset.id, n = S.items[id]; if (!n) return;
    if (e.shiftKey || e.metaKey || e.ctrlKey) { if (S.sel.has(id)) S.sel.delete(id); else S.sel.add(id); render(); return; }
    const wasSel = S.sel.has(id);
    if (!wasSel) S.sel = new Set([id]);
    if (!S.readOnly) {
      if (n.type === 'node' && !isRootNode(n) && S.sel.size === 1) gesture = { kind: 'nodedrag', id, sx, sy, start: pt, moved: false, pid: e.pointerId };
      else gesture = { kind: 'move', sx, sy, start: pt, moved: false, clickId: wasSel ? id : null, orig: captureOrig(), pid: e.pointerId };
      capture(e);
    }
    render(); return;
  }
  if (!e.shiftKey) S.sel.clear();
  gesture = { kind: 'marquee', base: new Set(S.sel), pid: e.pointerId };
  marquee = { x0: sx, y0: sy, x1: sx, y1: sy }; capture(e); render();
});
function onHandleDown(h, e, pt) {
  const id = [...S.sel][0], n = S.items[id]; if (!n || S.readOnly) return;
  if (h === 'resize') {
    const r = L[id];
    gesture = { kind: 'resize', id, start: pt, o: { w: n.w || r.w, h: n.h || r.h }, pid: e.pointerId, moved: false };
    capture(e); render();
  } else if (h === 'dot') startLink(e, { id });
  else if (h === 'plus-r') addChild(id, 'r');
  else if (h === 'plus-l') addChild(id, 'l');
  else if (h === 'end-a' || h === 'end-b') { gesture = { kind: 'end', id, which: h.slice(-1), pid: e.pointerId }; capture(e); render(); }
}
function startLink(e, from) {
  if (S.readOnly) return;
  const pt = s2w(e.clientX, e.clientY);
  S.items.__tmp = { id: '__tmp', type: 'link', a: from, b: { x: pt.x, y: pt.y }, arrow: 'end', z: 0 };
  gesture = { kind: 'link', from, sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, target: null, pid: e.pointerId };
  capture(e); render();
}
function startPen(e, pt) {
  S.items.__pen = { id: '__pen', type: 'stroke', x: pt.x, y: pt.y, w: 1, h: 1, pts: [0, 0, 0.1, 0], color: S.penColor || null, width: 3, z: maxZ() + 1 };
  gesture = { kind: 'pen', abs: [r1(pt.x), r1(pt.y)], pid: e.pointerId };
  capture(e); updatePen(gesture); render();
}
function updatePen(g) {
  const a = g.abs, t = S.items.__pen; if (!t) return;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (let i = 0; i < a.length; i += 2) { x1 = Math.min(x1, a[i]); x2 = Math.max(x2, a[i]); y1 = Math.min(y1, a[i + 1]); y2 = Math.max(y2, a[i + 1]); }
  t.x = x1; t.y = y1; t.w = Math.max(1, r1(x2 - x1)); t.h = Math.max(1, r1(y2 - y1));
  t.pts = a.length >= 4 ? a.map((v, i) => r1(v - (i % 2 ? y1 : x1))) : [0, 0, 0.1, 0];
}
window.addEventListener('pointermove', e => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const g = gesture;
  if (g && g.kind === 'pinch') { updatePinch(); return; }
  if (!g || g.pid !== e.pointerId) return;
  const sx = e.clientX, sy = e.clientY, pt = s2w(sx, sy);
  if (g.kind === 'pan') { S.cam.x = g.cx + (sx - g.sx); S.cam.y = g.cy + (sy - g.sy); applyCam(); }
  else if (g.kind === 'marquee') {
    marquee.x1 = sx; marquee.y1 = sy;
    const a = s2w(Math.min(marquee.x0, sx), Math.min(marquee.y0, sy)), b = s2w(Math.max(marquee.x0, sx), Math.max(marquee.y0, sy));
    const sel = new Set(g.base);
    for (const id in S.items) {
      if (id.startsWith('__') || (M[id] && M[id].hidden)) continue;
      const n = S.items[id];
      if (n.type === 'link') { const r = linkBox(n); if (r && r.x >= a.x && r.y >= a.y && r.x + r.w <= b.x && r.y + r.h <= b.y) sel.add(id); continue; }
      const r = L[id]; if (r && r.x >= a.x && r.x + r.w <= b.x && r.y >= a.y && r.y + r.h <= b.y) sel.add(id);
    }
    S.sel = sel; render();
  } else if (g.kind === 'move') {
    if (!g.moved && Math.hypot(sx - g.sx, sy - g.sy) < 3) return;
    g.moved = true; applyMove(g, pt.x - g.start.x, pt.y - g.start.y); render();
  } else if (g.kind === 'nodedrag') {
    if (!g.moved && Math.hypot(sx - g.sx, sy - g.sy) < 5) return;
    if (!g.moved) { g.moved = true; g.ids = subtreeIds(g.id); g.ex = new Set(g.ids); }
    dragView = { ids: g.ids, dx: pt.x - g.start.x, dy: pt.y - g.start.y };
    g.lx = sx; g.ly = sy;
    dropHint = computeDrop(sx, sy, pt, g); render();
  } else if (g.kind === 'resize') {
    const n = S.items[g.id]; if (!n) return;
    const dx = pt.x - g.start.x, dy = pt.y - g.start.y; g.moved = true;
    if (n.type === 'sticky') { let k = Math.max((g.o.w + dx) / g.o.w, (g.o.h + dy) / g.o.h); k = Math.max(k, 80 / Math.min(g.o.w, g.o.h)); n.w = r1(g.o.w * k); n.h = r1(g.o.h * k); }
    else if (n.type === 'shape') { n.w = r1(Math.max(40, g.o.w + dx)); n.h = r1(Math.max(30, e.shiftKey ? (g.o.w + dx) * g.o.h / g.o.w : g.o.h + dy)); }
    else if (n.type === 'text') n.w = r1(Math.max(40, g.o.w + dx));
    render();
  } else if (g.kind === 'link') {
    const ex = new Set(['__tmp']); if (g.from.id) ex.add(g.from.id);
    g.target = hitItem(sx, sy, ex, n => n.type !== 'link'); g.lx = sx; g.ly = sy;
    if (S.items.__tmp) S.items.__tmp.b = g.target ? { id: g.target } : { x: pt.x, y: pt.y };
    render();
  } else if (g.kind === 'end') {
    const l = S.items[g.id]; if (!l) return;
    const other = l[g.which === 'a' ? 'b' : 'a'], ex = new Set([g.id]); if (other && other.id) ex.add(other.id);
    g.target = hitItem(sx, sy, ex, n => n.type !== 'link');
    l[g.which] = g.target ? { id: g.target } : { x: r1(pt.x), y: r1(pt.y) }; render();
  } else if (g.kind === 'pen') {
    const a = g.abs, lx = a[a.length - 2], ly = a[a.length - 1];
    if (Math.hypot(pt.x - lx, pt.y - ly) < 2 / S.cam.z) return;
    a.push(r1(pt.x), r1(pt.y)); updatePen(g); render();
  }
});
function computeDrop(sx, sy, pt, g) {
  const id = hitItem(sx, sy, g.ex, n => n.type === 'node');
  if (!id || !L[id] || !M[id]) return Math.hypot(sx - g.sx, sy - g.sy) < 60 ? { mode: 'none' } : { mode: 'free' };
  const r = L[id], m = M[id];
  if (m.depth === 0) return { mode: 'child', target: id, side: pt.x < r.x + r.w / 2 ? 'l' : 'r' };
  const rel = (pt.y - r.y) / r.h;
  if (rel < 0.3) return { mode: 'before', target: id };
  if (rel > 0.7) return { mode: 'after', target: id };
  return { mode: 'child', target: id };
}
function applyDrop(g) {
  const n = S.items[g.id], h = dropHint; if (!n || !h || h.mode === 'none') return;
  if (h.mode === 'free') {
    const r = L[g.id]; if (!r) return;
    if (!n.color && M[g.id] && M[g.id].color) n.color = M[g.id].color;
    n.parent = null; delete n.side; n.x = r1(r.x); n.y = r1(r.y);
  } else {
    const t = S.items[h.target]; if (!t || g.ex.has(t.id)) return;
    let parent, order;
    if (h.mode === 'child') {
      parent = t.id; const ks = kidsOf(parent).filter(k => k.id !== n.id);
      order = ks.length ? ks[ks.length - 1].order + 1 : 1;
    } else {
      parent = t.parent; const sibs = kidsOf(parent).filter(k => k.id !== n.id), i = sibs.findIndex(s => s.id === t.id);
      const nb = h.mode === 'before' ? sibs[i - 1] : sibs[i + 1];
      order = nb ? (t.order + nb.order) / 2 : t.order + (h.mode === 'before' ? -1 : 1);
    }
    const p = S.items[parent];
    n.parent = parent; n.order = order; delete n.x; delete n.y;
    if (isRootNode(p)) {
      n.side = h.mode === 'child' ? h.side : (t.side || 'r');
      if (!n.color) n.color = freeBranchColor(kidsOf(parent).filter(k => k.id !== n.id));
    } else { delete n.side; delete n.color; }
  }
  S.sel = new Set([g.id]); commit();
}
function endGesture(e) {
  pointers.delete(e.pointerId);
  const g = gesture;
  if (g && g.kind === 'pinch') { if (pointers.size < 2) gesture = null; return; }
  if (!g || g.pid !== e.pointerId) return;
  gesture = null;
  const pt = s2w(e.clientX, e.clientY);
  if (g.kind === 'pan') stage.classList.remove('grabbing', ...(spaceDown || S.tool === 'hand' ? [] : ['panning']));
  else if (g.kind === 'marquee') marquee = null;
  else if (g.kind === 'move') { if (g.moved) commit(); else if (g.clickId && S.sel.size > 1) S.sel = new Set([g.clickId]); }
  else if (g.kind === 'nodedrag') { if (g.moved) applyDrop(g); dragView = null; dropHint = null; }
  else if (g.kind === 'resize') { if (g.moved) commit(); }
  else if (g.kind === 'end') commit();
  else if (g.kind === 'link') {
    delete S.items.__tmp;
    const far = Math.hypot(g.lx - g.sx, g.ly - g.sy) > 10;
    if ((g.target || far) && !(g.from.id && g.target === g.from.id)) {
      const l = newItem('link', { a: g.from, b: g.target ? { id: g.target } : { x: r1(pt.x), y: r1(pt.y) }, arrow: 'end', label: '' });
      S.sel = new Set([l.id]); commit();
      if (S.tool === 'link') setTool('select');
    }
  } else if (g.kind === 'pen') {
    const t = S.items.__pen; delete S.items.__pen;
    if (t) { newItem('stroke', { x: r1(t.x), y: r1(t.y), w: t.w, h: t.h, pts: t.pts, color: t.color || undefined, width: t.width }); commit(); }
  }
  render();
}
window.addEventListener('pointerup', endGesture);
window.addEventListener('pointercancel', endGesture);
stage.addEventListener('wheel', e => {
  e.preventDefault();
  const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1;
  if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * k * 0.0105));
  else { S.cam.x -= e.deltaX * k; S.cam.y -= e.deltaY * k; applyCam(); }
}, { passive: false });
stage.addEventListener('dblclick', e => {
  if (S.readOnly || e.target.closest('[data-h],[data-toggle]')) return;
  const itEl = e.target.closest('[data-id]');
  if (itEl) { const id = itEl.dataset.id; if (S.items[id] && S.editing !== id) startEdit(id, { selectAll: true }); return; }
  if (S.tool === 'select') createAt('node', s2w(e.clientX, e.clientY));
});

/* ================= text editing ================= */
let editOrig = '', editNew = false;
const readText = tx => tx.innerText.replace(/\r/g, '').replace(/\n$/, '').slice(0, 5000);
function startEdit(id, opts = {}) {
  const n = S.items[id];
  if (!n || S.readOnly || id.startsWith('__') || n.type === 'stroke') return;
  if (n.type === 'link') { editLabel(id); return; }
  if (S.editing && S.editing !== id) finishEdit();
  if (M[id] && M[id].hidden) return;
  S.editing = id; S.sel = new Set([id]); editOrig = n.text || ''; editNew = !!opts.isNew;
  draw();
  const el = els[id]; if (!el || !el._tx) { S.editing = null; return; }
  const tx = el._tx;
  try { tx.contentEditable = 'plaintext-only'; } catch (err) {}
  if (tx.contentEditable !== 'plaintext-only') tx.contentEditable = 'true';
  if (opts.replace != null) { tx.textContent = opts.replace; n.text = opts.replace; el._t = n.text; }
  tx.focus({ preventScroll: true });
  const range = document.createRange(); range.selectNodeContents(tx);
  if (!opts.selectAll) range.collapse(false);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
  tx.oninput = () => { const v = readText(tx); n.text = v; el._t = v; el._fit = null; render(); };
  tx.onblur = () => { if (S.editing === id) finishEdit(); };
  tx.onpaste = ev => {
    if (tx.contentEditable === 'plaintext-only') return;
    ev.preventDefault(); document.execCommand('insertText', false, ev.clipboardData.getData('text/plain'));
  };
  render();
}
function finishEdit(mode) {
  const id = S.editing; if (!id) return;
  const n = S.items[id];
  if (n && n.type === 'link') { const inp = document.getElementById('lblEdit'); if (inp) inp._finish(); else S.editing = null; return; }
  S.editing = null;
  const el = els[id];
  if (el && el._tx) {
    const tx = el._tx; tx.oninput = tx.onblur = tx.onpaste = null;
    tx.removeAttribute('contenteditable');
    if (document.activeElement === tx) stage.focus({ preventScroll: true });
    el._t = null; el._fit = null;
  }
  if (n) {
    n.text = (n.text || '').replace(/\s+$/, '');
    if (n.type === 'text' && !n.text.trim()) { deleteIds([id]); S.sel.delete(id); }
    else if (n.type === 'node' && editNew && mode === 'escape' && !n.text && !isRootNode(n)) {
      const p = n.parent; deleteIds([id]); S.sel = new Set(p && S.items[p] ? [p] : []);
    }
  }
  editNew = false;
  try { getSelection().removeAllRanges(); } catch (err) {}
  commit(); render();
}
function editLabel(id) {
  const l = S.items[id], g = l && linkGeom(l); if (!g) return;
  if (S.editing) finishEdit();
  S.editing = id; S.sel = new Set([id]); draw();
  const p = w2s(g.mid.x, g.mid.y), inp = document.createElement('input');
  inp.id = 'lblEdit'; inp.className = 'lbl-edit'; inp.value = l.label || ''; inp.placeholder = 'Beschriftung'; inp.maxLength = 200;
  inp.style.left = p.x + 'px'; inp.style.top = p.y + 'px';
  $('#app').appendChild(inp); inp.focus(); inp.select();
  let done = false;
  inp._finish = () => {
    if (done) return; done = true;
    if (S.items[id]) S.items[id].label = inp.value.trim();
    inp.remove(); S.editing = null; commit(); render(); stage.focus({ preventScroll: true });
  };
  inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); inp._finish(); } });
  inp.addEventListener('blur', () => inp._finish());
}

/* ================= keyboard ================= */
const inField = t => t && t.closest && t.closest('input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"]');
let pasteSeen = false;
window.addEventListener('keydown', e => {
  const mod = e.metaKey || e.ctrlKey, k = e.key;
  if (S.editing) {
    const n = S.items[S.editing]; if (!n || n.type === 'link') return;
    if (k === 'Escape') { e.preventDefault(); finishEdit('escape'); return; }
    if (k === 'Enter' && !e.shiftKey && !e.isComposing && (n.type === 'node' || mod)) { e.preventDefault(); finishEdit(); return; }
    if (k === 'Tab' && n.type === 'node') { e.preventDefault(); const id = n.id; finishEdit(); if (S.items[id]) addChild(id); return; }
    return;
  }
  if (inField(e.target)) return;
  if (k === ' ') { e.preventDefault(); if (!spaceDown) { spaceDown = true; stage.classList.add('panning'); } return; }
  const lower = k.length === 1 ? k.toLowerCase() : k;
  if (mod) {
    if (lower === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (lower === 'y') { e.preventDefault(); redo(); }
    else if (lower === 'a') { e.preventDefault(); S.sel = new Set(Object.keys(S.items).filter(id => !id.startsWith('__') && !(M[id] && M[id].hidden))); render(); }
    else if (lower === 'd') { e.preventDefault(); const d = copyData(); if (d) { pasteN = 0; pasteData(d); } }
    else if (k === '=' || k === '+') { e.preventDefault(); zoomBy(1.25); }
    else if (k === '-') { e.preventDefault(); zoomBy(0.8); }
    else if (k === '0') { e.preventDefault(); zoomTo(1); }
    else if (lower === 'c' || lower === 'x') { clip = copyData(); pasteN = 0; if (lower === 'x' && clip) setTimeout(deleteSelection, 0); }
    else if (lower === 'v') { pasteSeen = false; setTimeout(() => { if (!pasteSeen && clip) pasteData(clip); }, 80); }
    return;
  }
  if (e.shiftKey && e.code === 'Digit1') { e.preventDefault(); fitAll(); return; }
  if (k === 'Escape') {
    if (!$('#help').hidden) { $('#help').hidden = true; return; }
    if (closeMenus()) return;
    if (gesture) { cancelGesture(); return; }
    if (S.tool !== 'select') { setTool('select'); return; }
    S.sel.clear(); render(); return;
  }
  if (k === '?') { e.preventDefault(); toggleHelp(); return; }
  if (S.readOnly) return;
  if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); deleteSelection(); return; }
  const single = S.sel.size === 1 ? S.items[[...S.sel][0]] : null;
  if (single && single.type === 'node') {
    if (k === 'Tab') { e.preventDefault(); addChild(single.id); return; }
    if (k === 'Enter') { e.preventDefault(); addSibling(single.id); return; }
    if (k === 'F2') { e.preventDefault(); startEdit(single.id); return; }
    if (k.startsWith('Arrow')) { e.preventDefault(); navigate(single.id, k); return; }
    if (k.length === 1 && k !== ' ' && !e.altKey) { e.preventDefault(); startEdit(single.id, { replace: k }); return; }
  }
  if (single && (k === 'Enter' || k === 'F2')) { e.preventDefault(); startEdit(single.id); return; }
  if (k.startsWith('Arrow') && S.sel.size) {
    e.preventDefault(); const s = e.shiftKey ? 10 : 1;
    nudge(k === 'ArrowLeft' ? -s : k === 'ArrowRight' ? s : 0, k === 'ArrowUp' ? -s : k === 'ArrowDown' ? s : 0); return;
  }
  const tools = { v: 'select', h: 'hand', m: 'node', n: 'sticky', t: 'text', r: 'shape', l: 'link', p: 'pen' };
  if (!e.altKey && tools[lower]) { e.preventDefault(); setTool(tools[lower]); }
});
window.addEventListener('keyup', e => {
  if (e.key === ' ' && spaceDown) { spaceDown = false; if (!(gesture && gesture.kind === 'pan') && S.tool !== 'hand') stage.classList.remove('panning'); }
});
window.addEventListener('blur', () => { spaceDown = false; stage.classList.remove('panning', 'grabbing'); });
function cancelGesture() {
  const g = gesture; gesture = null;
  delete S.items.__tmp; delete S.items.__pen;
  if (g && (g.kind === 'move' || g.kind === 'resize' || g.kind === 'end') ) {
    for (const id of Object.keys(S.items)) if (base[id] && JSON.stringify(S.items[id]) !== base[id]) S.items[id] = JSON.parse(base[id]);
  }
  marquee = null; dragView = null; dropHint = null; render();
}
document.addEventListener('copy', e => {
  if (S.editing || inField(e.target) || (getSelection() + '').length) return;
  const d = copyData(); if (!d) return;
  clip = d; pasteN = 0;
  e.clipboardData.setData('text/plain', 'IDEENRAUM:' + JSON.stringify(d)); e.preventDefault();
});
document.addEventListener('cut', e => {
  if (S.editing || inField(e.target) || S.readOnly) return;
  const d = copyData(); if (!d) return;
  clip = d; pasteN = 0;
  e.clipboardData.setData('text/plain', 'IDEENRAUM:' + JSON.stringify(d)); e.preventDefault();
});
document.addEventListener('paste', e => {
  pasteSeen = true;
  if (S.editing || inField(e.target) || S.readOnly) return;
  const t = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
  e.preventDefault();
  if (t.startsWith('IDEENRAUM:')) { try { pasteData(JSON.parse(t.slice(10))); } catch (err) {} }
  else if (t.trim()) pasteText(t);
  else if (clip) pasteData(clip);
});

/* ================= context toolbar ================= */
const ctx = $('#ctx');
const IC = {
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  front: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2" fill="currentColor" fill-opacity=".25"/><path d="M15 9V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h4"/></svg>',
  child: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="9" width="7" height="6" rx="1.5"/><path d="M10 12h4M18 9v6M15 12h6"/></svg>',
  fold: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m8 9 4-4 4 4M8 15l4 4 4-4"/></svg>',
  unfold: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m8 5 4 4 4-4M8 19l4-4 4 4"/></svg>',
  arrowEnd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h15M14 7l5 5-5 5"/></svg>',
  arrowBoth: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h16M15 7l5 5-5 5M9 7l-5 5 5 5"/></svg>',
  arrowNone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 12h16"/></svg>',
  curve: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 18C10 18 14 6 20 6"/></svg>',
  straight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 18 20 6"/></svg>',
  dash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 12h4M10 12h4M17 12h4"/></svg>',
  label: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 6V4.5h14V6M12 4.5V19M9 19h6"/></svg>',
  rect: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="6" width="16" height="12" rx="2"/></svg>',
  ellipse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="12" rx="8.5" ry="6.5"/></svg>',
  diamond: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3.5 20.5 12 12 20.5 3.5 12Z"/></svg>',
};
const swatch = (c, on, act, title) => `<button class="sw${on ? ' on' : ''}" style="--c:${c}" data-act="${act}" title="${title || ''}" aria-label="${title || 'Farbe'}"></button>`;
const ibtn = (act, icon, title, on) => `<button class="btn${on ? ' on' : ''}" data-act="${act}" title="${title}" aria-label="${title}"${on ? ' style="background:var(--accent-soft);color:var(--accent)"' : ''}>${IC[icon]}</button>`;
let ctxKey = '';
function updateCtx() {
  const ids = [...S.sel].filter(id => S.items[id]);
  const show = ids.length && !S.editing && !(gesture && gesture.kind !== 'pinch') && !S.readOnly;
  if (!show) { if (!ctx.hidden) ctx.hidden = true; ctxKey = ''; return; }
  const items = ids.map(id => S.items[id]), types = new Set(items.map(n => n.type));
  const one = items.length === 1 ? items[0] : null, t = types.size === 1 ? items[0].type : 'mixed';
  const key = ids.join(',') + '|' + items.map(n => [n.color, n.shape, n.arrow, n.style, n.dash, n.size, n.collapsed].join(':')).join(';') + (one && M[one.id] ? M[one.id].kids.length + ':' + M[one.id].depth : '');
  if (key !== ctxKey) {
    ctxKey = key; let h = '';
    if (t === 'node') {
      const cur = one ? one.color : null;
      h += swatch('var(--root-bg)', !cur, 'color:', one && M[one.id] && M[one.id].depth === 0 ? 'Standard' : 'Automatisch');
      for (const c of BRANCH) h += swatch(c, cur === c, 'color:' + c);
      if (one) {
        h += '<div class="sep"></div>' + ibtn('child', 'child', 'Unterthema hinzufügen (Tab)');
        if (M[one.id] && M[one.id].kids.length) h += ibtn('fold', one.collapsed ? 'unfold' : 'fold', one.collapsed ? 'Aufklappen' : 'Zuklappen');
      }
    } else if (t === 'sticky' || t === 'shape') {
      for (const c of STICKY) h += swatch(c, items.every(n => n.color === c), 'color:' + c);
      if (t === 'shape') { h += '<div class="sep"></div>'; for (const s of ['rect', 'ellipse', 'diamond']) h += ibtn('shape:' + s, s, { rect: 'Rechteck', ellipse: 'Ellipse', diamond: 'Raute' }[s], items.every(n => (n.shape || 'rect') === s)); }
    } else if (t === 'text' || t === 'stroke' || t === 'link') {
      h += swatch(t === 'link' ? 'var(--link)' : 'var(--ink)', items.every(n => !n.color), 'color:', 'Standard');
      for (const c of BRANCH.slice(0, 7)) h += swatch(c, items.every(n => n.color === c), 'color:' + c);
      if (t === 'text') {
        h += '<div class="sep"></div>';
        for (const [s, lab] of [[16, 'S'], [24, 'M'], [36, 'L'], [56, 'XL']]) h += `<button class="btn" data-act="size:${s}" title="Schriftgröße ${lab}"${items.every(n => (n.size || 20) === s) ? ' style="background:var(--accent-soft);color:var(--accent)"' : ''}>${lab}</button>`;
      }
      if (t === 'link') {
        const ar = one ? (one.arrow || 'end') : null;
        h += '<div class="sep"></div>' + ibtn('arrow', ar === 'both' ? 'arrowBoth' : ar === 'none' ? 'arrowNone' : 'arrowEnd', 'Pfeilspitzen wechseln');
        h += ibtn('style', one && one.style === 'straight' ? 'straight' : 'curve', 'Gerade / geschwungen');
        h += ibtn('dash', 'dash', 'Gestrichelt', items.every(n => n.dash));
        if (one) h += ibtn('label', 'label', 'Beschriftung');
      }
    }
    if (t !== 'node' && t !== 'link') h += (h ? '<div class="sep"></div>' : '') + ibtn('front', 'front', 'Nach vorne');
    h += (h ? '<div class="sep"></div>' : '') + `<button class="btn danger" data-act="delete" title="Löschen (Entf)" aria-label="Löschen">${IC.trash}</button>`;
    ctx.innerHTML = h;
  }
  if (ctx.hidden) ctx.hidden = false;
  let b = selBounds(ids); if (!b) { ctx.hidden = true; return; }
  const p1 = w2s(b.x, b.y), p2 = w2s(b.x + b.w, b.y + b.h);
  const cw = ctx.offsetWidth, ch = ctx.offsetHeight;
  let x = (p1.x + p2.x) / 2 - cw / 2, y = p1.y - ch - 46;
  if (y < 70) y = p2.y + 46;
  if (y + ch > innerHeight - 70) y = Math.max(70, p1.y - ch - 46);
  ctx.style.left = clamp(x, 12, innerWidth - cw - 12) + 'px'; ctx.style.top = clamp(y, 64, innerHeight - ch - 12) + 'px';
}
ctx.addEventListener('pointerdown', e => e.stopPropagation());
ctx.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b || S.readOnly) return;
  const act = b.dataset.act, ids = [...S.sel].filter(id => S.items[id]), items = ids.map(id => S.items[id]);
  if (act.startsWith('color:')) { const c = act.slice(6); for (const n of items) { if (c) n.color = c; else delete n.color; } if (items.length === 1 && items[0].type === 'sticky' && c) S.stickyColor = c; }
  else if (act.startsWith('shape:')) { for (const n of items) n.shape = act.slice(6); S.shapeKind = act.slice(6); }
  else if (act.startsWith('size:')) { for (const n of items) n.size = +act.slice(5); }
  else if (act === 'arrow') { for (const n of items) n.arrow = { end: 'both', both: 'none', none: 'end' }[n.arrow || 'end']; }
  else if (act === 'style') { for (const n of items) { if (n.style === 'straight') delete n.style; else n.style = 'straight'; } }
  else if (act === 'dash') { const on = !items.every(n => n.dash); for (const n of items) { if (on) n.dash = true; else delete n.dash; } }
  else if (act === 'label') { editLabel(ids[0]); return; }
  else if (act === 'child') { addChild(ids[0]); return; }
  else if (act === 'fold') { toggleCollapse(ids[0]); return; }
  else if (act === 'front') { let z = maxZ(); for (const n of items) n.z = ++z; }
  else if (act === 'delete') { deleteSelection(); return; }
  commit(); render();
});

/* ================= tool flyout ================= */
const flyout = $('#flyout');
function openFlyout(tool) {
  const btn = document.querySelector(`.tool[data-tool="${tool}"]`); if (!btn) return;
  let h = '';
  if (tool === 'sticky') for (const c of STICKY) h += swatch(c, S.stickyColor === c, 'sticky:' + c, 'Haftnotiz-Farbe');
  if (tool === 'shape') for (const s of ['rect', 'ellipse', 'diamond']) h += ibtn('shape:' + s, s, { rect: 'Rechteck', ellipse: 'Ellipse', diamond: 'Raute' }[s], S.shapeKind === s);
  if (tool === 'pen') { h += swatch('var(--ink)', !S.penColor, 'pen:', 'Standard'); for (const c of BRANCH.slice(0, 7)) h += swatch(c, S.penColor === c, 'pen:' + c, 'Stiftfarbe'); }
  if (!h) return;
  flyout.innerHTML = h; flyout.hidden = false;
  const r = btn.getBoundingClientRect(), fr = flyout.getBoundingClientRect();
  if (innerWidth <= 640) { flyout.style.left = r.right + 8 + 'px'; flyout.style.top = clamp(r.top, 8, innerHeight - fr.height - 8) + 'px'; }
  else { flyout.style.left = r.right + 10 + 'px'; flyout.style.top = r.top + r.height / 2 - fr.height / 2 + 'px'; }
}
function closeFlyout() { flyout.hidden = true; }
flyout.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const [kind, v] = b.dataset.act.split(':');
  if (kind === 'sticky') S.stickyColor = v;
  if (kind === 'shape') S.shapeKind = v;
  if (kind === 'pen') S.penColor = v || null;
  openFlyout(S.tool);
});

/* ================= boards ================= */
let loadSeq = 0, foreign = {};
const recentlyCreated = new Map();
const sortBoards = () => boards.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
function onBoards(list) {
  boards = (Array.isArray(list) ? list : []).filter(b => b && b.id && typeof b.name === 'string'); sortBoards();
  $('#loading').hidden = true;
  const fresh = recentlyCreated.get(S.boardId);
  if (S.boardId && !boards.find(b => b.id === S.boardId) && !(fresh && Date.now() - fresh < 10000)) closeBoard();
  if (!S.boardId && boards.length) {
    const last = lsGet('last');
    openBoard(boards.find(b => b.id === last) ? last : boards[0].id);
  }
  $('#empty').hidden = !!(S.boardId || boards.length);
  updateBoardName();
  if (!$('#boardsMenu').hidden) buildBoardsMenu();
}
function clearCanvas() {
  for (const id in els) { els[id].remove(); delete els[id]; }
  for (const k in SZ) delete SZ[k];
  S.items = {}; base = {}; foreign = {}; S.sel = new Set(); S.editing = null; gesture = null; dragView = null; dropHint = null; marquee = null;
  resetHistory();
}
function closeBoard() {
  S.boardId = null; loadSeq++; clearCanvas(); render(); updateBoardName();
  if (boards.length) openBoard(boards[0].id); else $('#empty').hidden = false;
}
async function openBoard(id, opts = {}) {
  if (S.editing) finishEdit();
  const seq = ++loadSeq;
  clearCanvas();
  S.boardId = id; lsSet('last', id);
  $('#empty').hidden = true; updateBoardName(); render();
  const cam = lsGet('cam.' + id);
  let b;
  try { b = await Server.loadBoard(id); }
  catch (e) {
    if (seq !== loadSeq) return;
    if (e.status === 404) { boards = boards.filter(x => x.id !== id); closeBoard(); return; }
    toast('Das Board konnte nicht geladen werden: ' + e.message, 5000);
    return;
  }
  if (seq !== loadSeq || S.boardId !== id) return;
  for (const k in b.items) {
    const n = sanitize(Object.assign({}, b.items[k], { id: k }));
    if (TYPES.includes(n.type)) { S.items[k] = n; base[k] = JSON.stringify(n); }
    else foreign[k] = b.items[k]; // from a newer version: kept on the server, not shown
  }
  const fresh = opts.fresh && S.items[opts.fresh] ? opts.fresh : null;
  if (cam && typeof cam.z === 'number' && !fresh) { S.cam = cam; applyCam(); draw(); }
  else { draw(); fitAll(); }
  if (fresh) { S.cam = { x: innerWidth / 2 - 80, y: innerHeight / 2 - 26, z: 1 }; applyCam(); startEdit(fresh, { isNew: true }); }
}
function onRemote(type, id, data) {
  if (!S.boardId || id.startsWith('__')) return;
  if (Server.isPending(S.boardId, id)) return;
  if (S.editing === id || (gesture && S.sel.has(id))) return;
  const v = data ? sanitize(Object.assign({}, data, { id })) : null;
  if (v && !TYPES.includes(v.type)) { foreign[id] = data; return; }
  const js = v ? JSON.stringify(v) : null;
  if (js === (base[id] ?? null)) return;
  if (v) { S.items[id] = v; base[id] = js; } else { delete S.items[id]; delete base[id]; S.sel.delete(id); }
  render();
}
async function createBoard(name, items, fresh) {
  if (S.readOnly) return;
  closeMenus();
  const now = Date.now(), meta = { id: uid(), name, createdAt: now, updatedAt: now, rev: 0 };
  try { await Server.createBoard(meta, items || []); }
  catch (e) { toast('Das Board konnte nicht angelegt werden: ' + e.message, 5000); return; }
  recentlyCreated.set(meta.id, Date.now());
  if (!boards.find(b => b.id === meta.id)) boards.unshift(meta);
  lsDel('cam.' + meta.id);
  await openBoard(meta.id, { fresh });
}
function newBlankBoard() {
  const root = { id: uid(), type: 'node', parent: null, order: 1, x: 0, y: 0, text: '', z: 1 };
  createBoard(nextName('Unbenanntes Board'), [root], root.id);
}
function nextName(baseName) {
  const names = new Set(boards.map(b => b.name)); if (!names.has(baseName)) return baseName;
  for (let i = 2; i < 999; i++) if (!names.has(`${baseName} ${i}`)) return `${baseName} ${i}`;
  return baseName;
}
async function itemsOfBoard(id) {
  if (id === S.boardId) return [...Object.values(S.items).filter(n => !n.id.startsWith('__')), ...Object.values(foreign)].map(clone);
  const b = await Server.loadBoard(id);
  return Object.values(b.items).map(clone);
}
async function duplicateBoard(id) {
  const m = boards.find(b => b.id === id); if (!m) return;
  try { const items = remapItems(await itemsOfBoard(id)); await createBoard(nextName(m.name + ' (Kopie)'), items); toast('Board dupliziert'); }
  catch (e) { toast('Das Board konnte nicht dupliziert werden.'); }
}
async function deleteBoard(id) {
  try { await Server.deleteBoard(id); }
  catch (e) { if (e.status !== 404) { toast('Löschen hat nicht geklappt: ' + e.message, 5000); return; } }
  boards = boards.filter(b => b.id !== id); lsDel('cam.' + id);
  if (S.boardId === id) closeBoard();
  $('#empty').hidden = !!(S.boardId || boards.length);
  buildBoardsMenu(); updateBoardName(); toast('Board liegt jetzt im Papierkorb des Servers');
}
async function renameBoard(name) {
  const m = boards.find(b => b.id === S.boardId); if (!m || S.readOnly) return;
  name = name.trim().slice(0, 120); if (!name || name === m.name) return;
  const old = m.name; m.name = name; updateBoardName();
  try { await Server.renameBoard(m.id, name); }
  catch (e) { m.name = old; updateBoardName(); toast('Umbenennen hat nicht geklappt: ' + e.message, 5000); }
}
function updateBoardName() {
  const m = boards.find(b => b.id === S.boardId);
  $('#boardName').textContent = m ? m.name : (boards.length ? 'Board wählen' : 'Keine Boards');
  document.title = m ? m.name + ' · Ideenraum' : 'Ideenraum';
}
function startRename() {
  if (S.readOnly || !S.boardId) return;
  closeMenus();
  const btn = $('#boardBtn'), m = boards.find(b => b.id === S.boardId); if (!m) return;
  const inp = document.createElement('input'); inp.className = 'name-input'; inp.id = 'boardNameInput'; inp.value = m.name; inp.maxLength = 120; inp.setAttribute('aria-label', 'Board-Name');
  btn.hidden = true; btn.after(inp); inp.focus(); inp.select();
  let done = false;
  const fin = save => { if (done) return; done = true; if (save) renameBoard(inp.value); inp.remove(); btn.hidden = false; stage.focus({ preventScroll: true }); };
  inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') fin(true); if (e.key === 'Escape') fin(false); });
  inp.addEventListener('blur', () => fin(true));
}
const fmtDate = t => {
  if (!t) return '';
  const d = new Date(t), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: d.getFullYear() === now.getFullYear() ? undefined : '2-digit' });
};
let confirmDel = null;
function buildBoardsMenu() {
  const m = $('#boardsMenu'); sortBoards();
  let h = '<h3>Boards</h3><div class="boards-list">';
  for (const b of boards) {
    if (confirmDel === b.id) {
      h += `<div class="confirm"><span>„${esc(b.name)}“ löschen? Es bleibt 30 Tage im Papierkorb des Servers.</span><button class="btn danger" data-bact="del-yes" data-bid="${b.id}">Löschen</button><button class="btn" data-bact="del-no">Abbrechen</button></div>`;
      continue;
    }
    h += `<div class="brow${b.id === S.boardId ? ' cur' : ''}"><button class="btn open" data-bact="open" data-bid="${b.id}"><span class="nm">${esc(b.name)}</span><span class="dt">${fmtDate(b.updatedAt)}</span></button>`;
    if (!S.readOnly) h += `<button class="btn mini" data-bact="dup" data-bid="${b.id}" title="Duplizieren" aria-label="Duplizieren"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg></button><button class="btn mini danger" data-bact="del" data-bid="${b.id}" title="Löschen" aria-label="Löschen">${IC.trash}</button>`;
    h += '</div>';
  }
  if (!boards.length) h += '<div class="confirm" style="color:var(--muted)">Noch keine Boards.</div>';
  h += '</div>';
  if (!S.readOnly) {
    h += '<div class="sep" style="height:1px;width:auto;margin:6px 4px"></div>';
    h += `<button class="btn" data-bact="new"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>Neues Board</button>`;
    h += `<button class="btn" data-bact="sample"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="9.5" width="7" height="5" rx="1.8"/><path d="M10 12c3 0 2-6 5-6h5M10 12c3 0 2 6 5 6h5"/></svg>Beispiel-Board anlegen</button>`;
    if (S.boardId) h += `<button class="btn" data-bact="rename"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16Z"/></svg>Board umbenennen</button>`;
  }
  m.innerHTML = h;
}
$('#boardsMenu').addEventListener('click', e => {
  const b = e.target.closest('[data-bact]'); if (!b) return;
  const a = b.dataset.bact, id = b.dataset.bid;
  if (a === 'open') { closeMenus(); if (id !== S.boardId) openBoard(id); }
  else if (a === 'dup') { closeMenus(); duplicateBoard(id); }
  else if (a === 'del') { confirmDel = id; buildBoardsMenu(); }
  else if (a === 'del-no') { confirmDel = null; buildBoardsMenu(); }
  else if (a === 'del-yes') { confirmDel = null; deleteBoard(id); }
  else if (a === 'new') { closeMenus(); newBlankBoard(); }
  else if (a === 'sample') { closeMenus(); createBoard(nextName('Beispiel: Sommerfest'), sampleItems()); }
  else if (a === 'rename') startRename();
});
function openMenu(id, anchor, alignRight) {
  const m = $(id), open = !m.hidden; closeMenus(); if (open) return;
  if (id === '#boardsMenu') buildBoardsMenu(); else buildExportMenu();
  m.hidden = false;
  const r = anchor.getBoundingClientRect();
  m.style.top = r.bottom + 8 + 'px';
  if (alignRight) { m.style.right = innerWidth - r.right + 'px'; m.style.left = 'auto'; }
  else { m.style.left = Math.max(12, r.left - 6) + 'px'; m.style.right = 'auto'; }
}
function closeMenus() {
  let was = false;
  for (const id of ['#boardsMenu', '#exportMenu']) { const m = $(id); if (!m.hidden) { m.hidden = true; was = true; } }
  confirmDel = null;
  return was;
}
document.addEventListener('pointerdown', e => {
  if (!e.target.closest('#boardsMenu, #exportMenu, #boardBtn, #exportBtn')) closeMenus();
  if (!e.target.closest('#flyout, .tools')) { if (!flyout.hidden && !['sticky', 'shape', 'pen'].includes(S.tool)) closeFlyout(); }
}, true);

/* ================= export / import ================= */
function buildExportMenu() {
  let h = '<h3>Dieses Board</h3>';
  h += `<button class="btn" data-xact="png"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m4 17 5-5 4 4 3-3 4 4"/><circle cx="15.5" cy="8.5" r="1.5"/></svg>Als Bild (PNG)</button>`;
  h += `<button class="btn" data-xact="json"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4H6a2 2 0 0 0-2 2v4l-1.5 2L4 14v4a2 2 0 0 0 2 2h2M16 4h2a2 2 0 0 1 2 2v4l1.5 2-1.5 2v4a2 2 0 0 1-2 2h-2"/></svg>Als Datei (JSON)</button>`;
  h += '<h3>Alle Boards</h3>';
  h += `<button class="btn" data-xact="backup"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/></svg>Komplette Sicherung herunterladen</button>`;
  if (!S.readOnly) h += `<button class="btn" data-xact="import"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3M7 8l5-5 5 5M5 21h14"/></svg>Sicherung oder Board importieren</button>`;
  $('#exportMenu').innerHTML = h;
}
$('#exportMenu').addEventListener('click', e => {
  const b = e.target.closest('[data-xact]'); if (!b) return;
  closeMenus();
  const act = b.dataset.xact;
  if (act === 'png') exportPNG();
  if (act === 'json') exportJSON();
  if (act === 'backup') { const a = document.createElement('a'); a.href = '/api/export'; a.download = ''; document.body.appendChild(a); a.click(); a.remove(); }
  if (act === 'import') $('#importFile').click();
});
const fileBase = () => { const m = boards.find(b => b.id === S.boardId); return (m ? m.name : 'Ideenraum').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80) || 'Ideenraum'; };
function saveFile(filename, data) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
function exportJSON() {
  if (!S.boardId) return;
  const m = boards.find(b => b.id === S.boardId);
  const items = [...Object.values(S.items).filter(n => !n.id.startsWith('__')), ...Object.values(foreign)];
  const data = { app: 'ideenraum', kind: 'board', format: FORMAT, name: m ? m.name : 'Board', exportedAt: new Date().toISOString(), items };
  saveFile(fileBase() + '.json', JSON.stringify(data, null, 1));
}
$('#importFile').addEventListener('change', async e => {
  const f = e.target.files && e.target.files[0]; e.target.value = '';
  if (!f) return;
  let d;
  try { d = JSON.parse(await f.text()); } catch (err) { toast('Diese Datei ist kein Ideenraum-Export (JSON).', 4000); return; }
  if (Array.isArray(d)) d = { items: d };
  if (d && Array.isArray(d.items) && !(typeof d.name === 'string' && d.name.trim())) d.name = f.name.replace(/\.json$/i, '');
  try {
    const r = await api('POST', '/api/import', d);
    const created = r.created || [];
    toast(created.length === 1 ? `Importiert: „${created[0].name}“` : `Importiert: ${created.length} Boards`);
    onBoards(await Server.listBoards());
    if (created[0]) openBoard(created[0].id);
  } catch (err) { toast('Import hat nicht geklappt: ' + err.message, 5000); }
});

/* ================= PNG export ================= */
const hexRgb = h => { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map(c => c + c).join(''); const n = parseInt(h.slice(0, 6), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
const mix = (a, b, t) => { const A = hexRgb(a), B = hexRgb(b); return `rgb(${A.map((v, i) => Math.round(v * t + B[i] * (1 - t))).join(',')})`; };
function wrapLines(c, text, maxW) {
  const out = [];
  for (const para of String(text).split('\n')) {
    if (!isFinite(maxW)) { out.push(para); continue; }
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      const test = line + word;
      if (c.measureText(test).width <= maxW || !line.trim()) {
        if (c.measureText(test).width > maxW && !line.trim()) { // very long single word: break by characters
          let part = '';
          for (const ch of test) { if (c.measureText(part + ch).width > maxW && part) { out.push(part); part = ch; } else part += ch; }
          line = part;
        } else line = test;
      } else { out.push(line.trimEnd()); line = word.trimStart(); }
    }
    out.push(line.trimEnd());
  }
  return out;
}
function drawText(c, text, box, font, color, lh, align) {
  c.font = font; c.fillStyle = color; c.textBaseline = 'middle'; c.textAlign = align === 'left' ? 'left' : 'center';
  const lines = wrapLines(c, text, box.w * 1.04 + 4), fs = parseFloat(font.match(/(\d+(\.\d+)?)px/)[1]), lineH = fs * lh;
  let y = box.y + box.h / 2 - (lines.length * lineH) / 2 + lineH / 2;
  const x = align === 'left' ? box.x : box.x + box.w / 2;
  for (const ln of lines) { c.fillText(ln, x, y); y += lineH; }
}
async function exportPNG() {
  if (!S.boardId) return;
  finishEdit(); computeTree(); measure(); layoutAll();
  const b = contentBounds(); if (!b) { toast('Das Board ist noch leer.'); return; }
  try { await document.fonts.ready; } catch (e) {}
  const cs = getComputedStyle(document.documentElement), tok = n => cs.getPropertyValue(n).trim();
  const T = { canvas: tok('--canvas'), surface: tok('--surface'), ink: tok('--ink'), link: tok('--link'), rootBg: tok('--root-bg'), rootFg: tok('--root-fg'), sticky: tok('--sticky-ink') };
  const ui = tok('--font-ui'), disp = tok('--font-display');
  const pad = 56, W = Math.ceil(b.w + pad * 2), H = Math.ceil(b.h + pad * 2);
  const scale = Math.min(2, 12000 / Math.max(W, H), Math.sqrt(1.4e8 / (W * H)));
  const cv = document.createElement('canvas'); cv.width = Math.max(1, Math.round(W * scale)); cv.height = Math.max(1, Math.round(H * scale));
  const c = cv.getContext('2d'); c.scale(scale, scale); c.translate(pad - b.x, pad - b.y);
  c.fillStyle = T.canvas; c.fillRect(b.x - pad, b.y - pad, W, H);
  c.lineCap = 'round'; c.lineJoin = 'round';
  for (const id in M) {
    const m = M[id], n = S.items[id]; if (!n || !m.depth || m.hidden || !L[n.parent] || !L[id]) continue;
    c.strokeStyle = m.color; c.lineWidth = m.depth === 1 ? 3 : 2; c.stroke(new Path2D(branchPath(L[n.parent], L[id], m.dir)));
  }
  const lab = [];
  for (const id in S.items) {
    const l = S.items[id]; if (l.type !== 'link' || id.startsWith('__')) continue;
    const g = linkGeom(l); if (!g) continue;
    const col = l.color || T.link, w = l.width || 2;
    c.strokeStyle = col; c.fillStyle = col; c.lineWidth = w; c.setLineDash(l.dash ? [7, 6] : []);
    c.stroke(new Path2D(g.d)); c.setLineDash([]);
    const ar = l.arrow || 'end';
    if (ar !== 'none') c.fill(new Path2D(arrowPath(g.B, Math.hypot(g.c2.x - g.B.x, g.c2.y - g.B.y) > 2 ? g.c2 : g.A, w)));
    if (ar === 'both') c.fill(new Path2D(arrowPath(g.A, Math.hypot(g.c1.x - g.A.x, g.c1.y - g.A.y) > 2 ? g.c1 : g.B, w)));
    if (l.label) lab.push([l.label, g.mid]);
  }
  for (const [text, p] of lab) {
    c.font = `500 13px ${ui}`; const tw = c.measureText(text).width;
    c.fillStyle = T.canvas; c.beginPath(); c.roundRect(p.x - tw / 2 - 6, p.y - 11, tw + 12, 22, 5); c.fill();
    c.fillStyle = T.ink; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(text, p.x, p.y);
  }
  const order = Object.values(S.items).filter(n => n.type !== 'link' && !n.id.startsWith('__') && L[n.id] && !(M[n.id] && M[n.id].hidden))
    .sort((a, b2) => (a.type === 'node' ? 1e5 : 0) + (a.z || 0) - ((b2.type === 'node' ? 1e5 : 0) + (b2.z || 0)));
  for (const n of order) {
    const r = L[n.id];
    if (n.type === 'sticky') {
      c.save(); c.shadowColor = 'rgba(0,0,0,.22)'; c.shadowBlur = 14; c.shadowOffsetY = 6;
      c.fillStyle = n.color || STICKY[0]; c.beginPath(); c.roundRect(r.x, r.y, r.w, r.h, 3); c.fill(); c.restore();
      const fs = parseFloat((els[n.id] && els[n.id].style.fontSize) || '20');
      drawText(c, n.text || '', { x: r.x + 14, y: r.y + 14, w: r.w - 28, h: r.h - 28 }, `500 ${fs}px ${ui}`, T.sticky, 1.25);
    } else if (n.type === 'shape') {
      c.fillStyle = n.color || '#A9D4FF'; c.strokeStyle = 'rgba(0,0,0,.18)'; c.lineWidth = 1.5; c.beginPath();
      if (n.shape === 'ellipse') c.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2 - 1, r.h / 2 - 1, 0, 0, Math.PI * 2);
      else if (n.shape === 'diamond') { c.moveTo(r.x + r.w / 2, r.y + 1); c.lineTo(r.x + r.w - 1, r.y + r.h / 2); c.lineTo(r.x + r.w / 2, r.y + r.h - 1); c.lineTo(r.x + 1, r.y + r.h / 2); c.closePath(); }
      else c.roundRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2, 10);
      c.fill(); c.stroke();
      const inset = n.shape === 'diamond' ? r.w * 0.2 : n.shape === 'ellipse' ? r.w * 0.12 : 16;
      drawText(c, n.text || '', { x: r.x + inset, y: r.y + 12, w: r.w - inset * 2, h: r.h - 24 }, `500 15px ${ui}`, T.sticky, 1.3);
    } else if (n.type === 'text') {
      const fs = n.size || 20, wt = fs >= 32 ? 700 : 500;
      drawText(c, n.text || '', { x: r.x + 4, y: r.y + 2, w: n.w ? r.w - 8 : Infinity, h: r.h - 4 }, `${wt} ${fs}px ${ui}`, n.color || T.ink, 1.3, 'left');
    } else if (n.type === 'stroke') {
      c.save(); c.translate(n.x, n.y); c.strokeStyle = n.color || T.ink; c.lineWidth = n.width || 3; c.stroke(new Path2D(strokePath(n.pts))); c.restore();
    } else if (n.type === 'node') {
      const m = M[n.id] || { depth: 0 }, col = m.color || '#8790A3';
      c.beginPath();
      if (m.depth === 0) {
        c.save(); c.shadowColor = 'rgba(0,0,0,.16)'; c.shadowBlur = 16; c.shadowOffsetY = 6;
        c.fillStyle = n.color ? n.color : T.rootBg; c.roundRect(r.x, r.y, r.w, r.h, 14); c.fill(); c.restore();
        drawText(c, n.text || 'Hauptthema', { x: r.x + 22, y: r.y + 14, w: r.w - 44, h: r.h - 28 }, `700 21px ${disp}`, n.color ? '#fff' : T.rootFg, 1.35);
      } else {
        const l1 = m.depth === 1, bw = l1 ? 2 : 1.5;
        c.fillStyle = mix(col, T.surface, l1 ? 0.15 : 0.10); c.roundRect(r.x + bw / 2, r.y + bw / 2, r.w - bw, r.h - bw, l1 ? 11 : 9); c.fill();
        c.strokeStyle = l1 ? col : mix(col, T.surface, 0.38); c.lineWidth = bw; c.stroke();
        const px = l1 ? 15 : 13, py = l1 ? 9 : 7;
        drawText(c, n.text || 'Thema', { x: r.x + px, y: r.y + py, w: r.w - px * 2 + 1, h: r.h - py * 2 }, `${l1 ? 600 : 400} ${l1 ? 16 : 15}px ${ui}`, T.ink, 1.35);
      }
    }
  }
  cv.toBlob(blob => { if (blob) saveFile(fileBase() + '.png', blob); else toast('Das Bild ist zu groß für den Export.'); }, 'image/png');
}

/* ================= sample board ================= */
function sampleItems() {
  const out = [], add = o => { o.id = uid(); o.z = out.length + 1; out.push(o); return o; };
  const root = add({ type: 'node', parent: null, order: 1, x: 0, y: 0, text: 'Sommerfest planen' });
  const br = (text, side, color, order, kids) => {
    const n = add({ type: 'node', parent: root.id, side, color, order, text });
    kids.forEach((t, i) => add({ type: 'node', parent: n.id, order: i + 1, text: t }));
    return n;
  };
  br('Ort', 'r', BRANCH[0], 1, ['Garten hinter dem Haus', 'Plan B: Gemeindesaal']);
  const food = br('Essen & Getränke', 'r', BRANCH[1], 2, ['Grillen', 'Salate bringen die Gäste mit', 'Getränkeliste bis Freitag']);
  br('Gäste', 'l', BRANCH[2], 3, ['Einladungen bis 1. Juni', 'Nachbarn fragen']);
  br('Programm', 'l', BRANCH[4], 4, ['Musik-Playlist', 'Spiele für Kinder']);
  add({ type: 'text', x: -330, y: -250, text: 'Beispiel-Board: zum Ausprobieren, Ändern und Löschen', size: 24 });
  const s1 = add({ type: 'sticky', x: 620, y: -300, w: 190, h: 190, color: STICKY[0], text: 'Budget: ca. 300 €' });
  add({ type: 'sticky', x: 620, y: 150, w: 190, h: 190, color: STICKY[2], text: 'Wer kümmert sich um die Musikanlage?' });
  add({ type: 'link', a: { id: s1.id }, b: { id: food.id }, arrow: 'end', label: 'gilt für', z: 0 });
  return out.map(sanitize);
}

/* ================= UI wiring & boot ================= */
function toggleHelp() { const h = $('#help'); h.hidden = !h.hidden; closeMenus(); }
const tip = document.createElement('div'); tip.className = 'tip'; tip.hidden = true; $('#app').appendChild(tip);
document.querySelectorAll('.tool').forEach(b => {
  b.addEventListener('click', () => { setTool(b.dataset.tool); stage.focus({ preventScroll: true }); });
  b.addEventListener('pointerenter', () => {
    tip.innerHTML = `${esc(b.dataset.tip)}<kbd>${b.dataset.key}</kbd>`; tip.hidden = false;
    const r = b.getBoundingClientRect(); tip.style.left = r.right + 10 + 'px'; tip.style.top = r.top + r.height / 2 - tip.offsetHeight / 2 + 'px';
  });
  b.addEventListener('pointerleave', () => { tip.hidden = true; });
});
$('#undoBtn').addEventListener('click', () => { undo(); stage.focus({ preventScroll: true }); });
$('#redoBtn').addEventListener('click', () => { redo(); stage.focus({ preventScroll: true }); });
$('#zoomIn').addEventListener('click', () => zoomBy(1.25));
$('#zoomOut').addEventListener('click', () => zoomBy(0.8));
$('#zoomPct').addEventListener('click', () => zoomTo(1));
$('#zoomFit').addEventListener('click', fitAll);
$('#helpBtn').addEventListener('click', toggleHelp);
$('#helpClose').addEventListener('click', () => { $('#help').hidden = true; });
$('#logoutBtn').addEventListener('click', async () => { try { await api('POST', '/api/logout', {}); } catch (e) { /* ignore */ } location.href = '/login'; });
$('#boardBtn').addEventListener('click', e => openMenu('#boardsMenu', e.currentTarget, false));
$('#boardBtn').addEventListener('dblclick', startRename);
$('#exportBtn').addEventListener('click', e => openMenu('#exportMenu', e.currentTarget, true));
$('#emptyNew').addEventListener('click', newBlankBoard);
$('#emptySample').addEventListener('click', () => createBoard(nextName('Beispiel: Sommerfest'), sampleItems()));
addEventListener('resize', () => { applyCam(); render(); });
addEventListener('beforeunload', e => {
  if (Server.pending()) { Server.flush(); e.preventDefault(); e.returnValue = ''; }
});

async function boot() {
  applyCam();
  setStatus('busy');
  try {
    const h = await api('GET', '/api/health');
    $('#appVersion').textContent = `Ideenraum ${h.version} · Datenformat ${h.format}`;
    $('#logoutBtn').hidden = !h.login;
  } catch (e) { /* shown below */ }
  connectEvents();
  for (let attempt = 0; ; attempt++) {
    try { onBoards(await Server.listBoards()); Server.status(); return; }
    catch (e) {
      $('#loadingText').textContent = 'Der Server ist gerade nicht erreichbar. Neuer Versuch in ein paar Sekunden …';
      setStatus('offline');
      await new Promise(r => setTimeout(r, Math.min(10000, 2000 + attempt * 1000)));
    }
  }
}
boot();
