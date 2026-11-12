'use strict';
/* Inkbook — handwritten notebooks for Obsidian. Plain JS, no dependencies, no build step. */
const obsidian = require('obsidian');

/* ------------------------------------------------------------------ */
/* Model                                                               */
/* ------------------------------------------------------------------ */

const MM = 72 / 25.4;                       // page units are PDF points
const A4 = [595.28, 841.89];
const PAPERS = {
  white: { bg: '#ffffff', line: '#c3cfe0', dot: '#9aa8bd' },
  cream: { bg: '#fbf6e6', line: '#d6ccb0', dot: '#b3a784' },
};
const TEMPLATES = { squared: 'Squared', lined: 'Lined', dotted: 'Dotted', blank: 'Blank' };
const SPACINGS = [[5 * MM, 'Small (5 mm)'], [7 * MM, 'Medium (7 mm)'], [10 * MM, 'Large (10 mm)']];
const HL_ALPHA = 0.35;
const PEN_COLORS = ['#1a1a1a', '#1e40af', '#dc2626', '#15803d', '#ea580c', '#7c3aed'];
const HL_COLORS = ['#fde047', '#86efac', '#f9a8d4', '#93c5fd', '#fdba74'];
const PEN_SIZES = [1.1, 1.8, 3];
const HL_SIZES = [8, 13, 20];
const ERASER_SIZES = [8, 16, 30];
const MAX_CANVAS_PX = 8e6;                  // keeps memory low and stays under iOS canvas limits

const DEFAULT_PREFS = {
  tool: 'pen',
  penColor: PEN_COLORS[0], hlColor: HL_COLORS[0],
  penSize: PEN_SIZES[1], hlSize: HL_SIZES[1], eraserSize: ERASER_SIZES[1],
  fingerDraw: false, scribbleErase: true, holdSnap: true, pressure: true,
  stabilize: 0.4,
  template: 'squared', spacing: 5 * MM, paper: 'white', landscape: false,
};

const uid = () => Math.random().toString(36).slice(2, 10);
const r2 = (v) => Math.round(v * 100) / 100;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function newNotebook(prefs, opts) {
  const o = Object.assign({ template: prefs.template, landscape: prefs.landscape }, opts);
  return {
    version: 1,
    w: o.landscape ? A4[1] : A4[0],
    h: o.landscape ? A4[0] : A4[1],
    spacing: prefs.spacing, paper: prefs.paper,
    pages: [{ id: uid(), tpl: o.template, strokes: [] }],
  };
}

function parseNotebook(text, prefs) {
  if (!text || !text.trim()) return newNotebook(prefs);
  const d = JSON.parse(text);
  if (!d || !Array.isArray(d.pages)) throw new Error('Not an Inkbook notebook');
  d.w = +d.w || A4[0]; d.h = +d.h || A4[1];
  d.spacing = +d.spacing || 5 * MM;
  if (!PAPERS[d.paper]) d.paper = 'white';
  d.pages = d.pages.filter((p) => p && Array.isArray(p.strokes));
  for (const p of d.pages) {
    if (!p.id) p.id = uid();
    if (!TEMPLATES[p.tpl]) p.tpl = 'squared';
    p.strokes = p.strokes.filter((s) => s && Array.isArray(s.p) && s.p.length >= 3 && s.p.length % 3 === 0);
  }
  if (!d.pages.length) d.pages.push({ id: uid(), tpl: prefs.template, strokes: [] });
  return d;
}

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

function ptsBox(p, step) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < p.length; i += step) {
    const x = p[i], y = p[i + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

const boxCache = new WeakMap();
function strokeBox(s) {
  let b = boxCache.get(s);
  if (!b) {
    b = ptsBox(s.p, 3);
    b.x0 -= s.w; b.y0 -= s.w; b.x1 += s.w; b.y1 += s.w;
    boxCache.set(s, b);
  }
  return b;
}

function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx - px, qy = ay + t * dy - py;
  return qx * qx + qy * qy;
}

function strokeNear(s, x, y, r) {
  const b = strokeBox(s);
  if (x < b.x0 - r || x > b.x1 + r || y < b.y0 - r || y > b.y1 + r) return false;
  const p = s.p, rr = (r + s.w / 2) * (r + s.w / 2);
  if (p.length === 3) return (p[0] - x) * (p[0] - x) + (p[1] - y) * (p[1] - y) <= rr;
  for (let i = 3; i < p.length; i += 3) {
    if (segDist2(x, y, p[i - 3], p[i - 2], p[i], p[i + 1]) <= rr) return true;
  }
  return false;
}

function pathLength(p, step) {
  let l = 0;
  for (let i = step; i < p.length; i += step) l += Math.hypot(p[i] - p[i - step], p[i + 1] - p[i - step + 1]);
  return l;
}

function inPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i], yi = poly[i + 1], xj = poly[j], yj = poly[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/* Counts direction reversals along one axis, ignoring wiggles smaller than `min`. */
function reversals(p, axis, min) {
  let dir = 0, ext = p[axis], count = 0;
  for (let i = 3; i < p.length; i += 3) {
    const v = p[i + axis];
    if (dir === 0) {
      if (Math.abs(v - ext) > min) { dir = v > ext ? 1 : -1; ext = v; }
    } else if (dir > 0) {
      if (v > ext) ext = v; else if (ext - v > min) { count++; dir = -1; ext = v; }
    } else {
      if (v < ext) ext = v; else if (v - ext > min) { count++; dir = 1; ext = v; }
    }
  }
  return count;
}

/* A scribble is a dense back-and-forth zigzag: lots of ink in a small box, several reversals. */
function isScribble(p) {
  if (p.length < 36) return false;
  const b = ptsBox(p, 3), diag = Math.hypot(b.x1 - b.x0, b.y1 - b.y0);
  if (diag < 6 || pathLength(p, 3) < diag * 2.8) return false;
  const min = Math.max(3, diag * 0.15);
  return Math.max(reversals(p, 0, min), reversals(p, 1, min)) >= 3;
}

function scribbleHits(p, s) {
  for (let i = 0; i < p.length; i += 3) if (strokeNear(s, p[i], p[i + 1], 1)) return true;
  return false;
}

/* Returns corrected points for a straight line or circle/ellipse, or null. */
function recognize(p) {
  const n = p.length / 3;
  if (n < 3) return null;
  const len = pathLength(p, 3);
  if (len < 15) return null;
  const ax = p[0], ay = p[1], bx = p[p.length - 3], by = p[p.length - 2];
  const chord = Math.hypot(bx - ax, by - ay);
  if (chord / len > 0.88) {
    let ex = bx, ey = by;
    if (Math.abs(by - ay) / chord < 0.06) ey = ay;          // snap near-horizontal
    else if (Math.abs(bx - ax) / chord < 0.06) ex = ax;     // snap near-vertical
    return [ax, ay, 0.5, ex, ey, 0.5];
  }
  if (chord / len < 0.25) {
    const b = ptsBox(p, 3);
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    let rx = (b.x1 - b.x0) / 2, ry = (b.y1 - b.y0) / 2;
    if (rx < 4 || ry < 4) return null;
    let err = 0;
    for (let i = 0; i < p.length; i += 3) err += Math.abs(Math.hypot((p[i] - cx) / rx, (p[i + 1] - cy) / ry) - 1);
    if (err / n > 0.1) return null;
    if (Math.abs(rx - ry) / Math.max(rx, ry) < 0.18) rx = ry = (rx + ry) / 2;
    const out = [], steps = 72;
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      out.push(r2(cx + rx * Math.cos(a)), r2(cy + ry * Math.sin(a)), 0.5);
    }
    return out;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Rendering (shared by screen, PNG and PDF)                           */
/* ------------------------------------------------------------------ */

function templateGeom(nb, page) {
  const lines = [], dots = [], s = nb.spacing, w = nb.w, h = nb.h;
  if (page.tpl === 'squared') {
    for (let x = s; x < w - 1; x += s) lines.push(x, 0, x, h);
    for (let y = s; y < h - 1; y += s) lines.push(0, y, w, y);
  } else if (page.tpl === 'lined') {
    const L = s * 1.5;
    for (let y = L * 2; y < h - L / 2; y += L) lines.push(0, y, w, y);
  } else if (page.tpl === 'dotted') {
    for (let x = s; x < w - 1; x += s) for (let y = s; y < h - 1; y += s) dots.push(x, y);
  }
  return { lines, dots };
}

function drawTemplate(ctx, nb, page) {
  const paper = PAPERS[nb.paper] || PAPERS.white, g = templateGeom(nb, page);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = paper.bg; ctx.fillRect(0, 0, nb.w, nb.h);
  ctx.strokeStyle = paper.line; ctx.lineWidth = 0.5; ctx.lineCap = 'butt';
  ctx.beginPath();
  for (let i = 0; i < g.lines.length; i += 4) { ctx.moveTo(g.lines[i], g.lines[i + 1]); ctx.lineTo(g.lines[i + 2], g.lines[i + 3]); }
  ctx.stroke();
  ctx.fillStyle = paper.dot;
  for (let i = 0; i < g.dots.length; i += 2) ctx.fillRect(g.dots[i] - 0.6, g.dots[i + 1] - 0.6, 1.2, 1.2);
}

const widthAt = (s, pr) => s.w * (0.4 + 1.2 * pr);

function uniform(p) {
  for (let i = 5; i < p.length; i += 3) if (p[i] !== p[2]) return false;
  return true;
}

/* A stroke with n points is n smooth pieces: a short lead-in line, quadratic curves between
   segment midpoints (control = the real point), and a lead-out line. piece() -> [x0,y0,cx,cy,x1,y1,pressure] */
const PC = new Float64Array(7);
function piece(p, j) {
  const n = p.length / 3;
  if (j === 0) {
    PC[0] = p[0]; PC[1] = p[1]; PC[4] = (p[0] + p[3]) / 2; PC[5] = (p[1] + p[4]) / 2;
    PC[2] = (PC[0] + PC[4]) / 2; PC[3] = (PC[1] + PC[5]) / 2; PC[6] = p[2];
  } else if (j === n - 1) {
    const a = 3 * (n - 2), b = 3 * (n - 1);
    PC[0] = (p[a] + p[b]) / 2; PC[1] = (p[a + 1] + p[b + 1]) / 2; PC[4] = p[b]; PC[5] = p[b + 1];
    PC[2] = (PC[0] + PC[4]) / 2; PC[3] = (PC[1] + PC[5]) / 2; PC[6] = p[b + 2];
  } else {
    const a = 3 * (j - 1), c = 3 * j, b = 3 * (j + 1);
    PC[0] = (p[a] + p[c]) / 2; PC[1] = (p[a + 1] + p[c + 1]) / 2;
    PC[2] = p[c]; PC[3] = p[c + 1];
    PC[4] = (p[c] + p[b]) / 2; PC[5] = (p[c + 1] + p[b + 1]) / 2; PC[6] = p[c + 2];
  }
  return PC;
}

function drawPiece(ctx, s, j) {
  const c = piece(s.p, j);
  ctx.lineWidth = widthAt(s, c[6]);
  ctx.beginPath(); ctx.moveTo(c[0], c[1]); ctx.quadraticCurveTo(c[2], c[3], c[4], c[5]); ctx.stroke();
}

function drawStroke(ctx, s) {
  const p = s.p, n = p.length / 3;
  if (!n) return;
  const hl = s.t === 'highlighter';
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = s.c; ctx.fillStyle = s.c;
  if (hl) { ctx.globalAlpha = HL_ALPHA; ctx.globalCompositeOperation = 'multiply'; }
  if (n === 1) {
    ctx.beginPath(); ctx.arc(p[0], p[1], (hl ? s.w : widthAt(s, p[2])) / 2, 0, Math.PI * 2); ctx.fill();
  } else if (hl || uniform(p)) {
    ctx.lineWidth = hl ? s.w : widthAt(s, p[2]);
    ctx.beginPath();
    for (let j = 0; j < n; j++) {
      const c = piece(p, j);
      if (j === 0) ctx.moveTo(c[0], c[1]);
      ctx.quadraticCurveTo(c[2], c[3], c[4], c[5]);
    }
    ctx.stroke();
  } else {
    for (let j = 0; j < n; j++) drawPiece(ctx, s, j);
  }
  if (hl) { ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; }
}

/* ------------------------------------------------------------------ */
/* PDF export — tiny hand-rolled vector PDF writer                     */
/* ------------------------------------------------------------------ */

const f2 = (v) => String(Math.round(v * 100) / 100);

function hexRgb(c) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c || '');
  if (!m) return '0 0 0';
  return [1, 2, 3].map((i) => f2(parseInt(m[i], 16) / 255)).join(' ');
}

function pdfStroke(o, s) {
  const p = s.p, n = p.length / 3, hl = s.t === 'highlighter';
  if (!n) return;
  if (hl) o.push('q /GH gs');
  o.push(hexRgb(s.c) + ' RG');
  if (n === 1) {
    o.push(`${f2(hl ? s.w : widthAt(s, p[2]))} w ${f2(p[0])} ${f2(p[1])} m ${f2(p[0] + 0.01)} ${f2(p[1])} l S`);
  } else {
    let cur = null;
    for (let j = 0; j < n; j++) {
      const c = piece(p, j);
      const w = (hl ? s.w : widthAt(s, c[6])).toFixed(1);
      if (w !== cur) {
        if (cur !== null) o.push('S');
        o.push(`${w} w ${f2(c[0])} ${f2(c[1])} m`);
        cur = w;
      }
      o.push(`${f2(c[0] + (2 / 3) * (c[2] - c[0]))} ${f2(c[1] + (2 / 3) * (c[3] - c[1]))} ` +
             `${f2(c[4] + (2 / 3) * (c[2] - c[4]))} ${f2(c[5] + (2 / 3) * (c[3] - c[5]))} ${f2(c[4])} ${f2(c[5])} c`);
    }
    o.push('S');
  }
  if (hl) o.push('Q');
}

function pdfPage(nb, page) {
  const o = [], paper = PAPERS[nb.paper] || PAPERS.white, g = templateGeom(nb, page);
  o.push(`1 0 0 -1 0 ${f2(nb.h)} cm`);                       // flip so y grows downward like the canvas
  o.push(`${hexRgb(paper.bg)} rg 0 0 ${f2(nb.w)} ${f2(nb.h)} re f`);
  if (g.lines.length) {
    o.push(`${hexRgb(paper.line)} RG 0.5 w`);
    for (let i = 0; i < g.lines.length; i += 4) o.push(`${f2(g.lines[i])} ${f2(g.lines[i + 1])} m ${f2(g.lines[i + 2])} ${f2(g.lines[i + 3])} l`);
    o.push('S');
  }
  if (g.dots.length) {
    o.push(`${hexRgb(paper.dot)} rg`);
    for (let i = 0; i < g.dots.length; i += 2) o.push(`${f2(g.dots[i] - 0.6)} ${f2(g.dots[i + 1] - 0.6)} 1.2 1.2 re`);
    o.push('f');
  }
  o.push('1 J 1 j');
  for (const s of page.strokes) pdfStroke(o, s);
  return o.join('\n');
}

async function deflate(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (e) { return null; }
}

async function buildPdf(nb) {
  const enc = new TextEncoder(), chunks = [], offsets = [];
  let size = 0;
  const put = (d) => { const b = typeof d === 'string' ? enc.encode(d) : d; chunks.push(b); size += b.length; };
  const obj = (id, body) => { offsets[id] = size; put(`${id} 0 obj\n${body}\nendobj\n`); };
  const n = nb.pages.length;
  put('%PDF-1.4\n'); put(new Uint8Array([37, 226, 227, 207, 211, 10]));
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Count ${n} /Kids [${nb.pages.map((_, i) => `${3 + 2 * i} 0 R`).join(' ')}] >>`);
  for (let i = 0; i < n; i++) {
    const pid = 3 + 2 * i, cid = pid + 1;
    const raw = enc.encode(pdfPage(nb, nb.pages[i]));
    const packed = await deflate(raw);
    const data = packed || raw;
    obj(pid, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f2(nb.w)} ${f2(nb.h)}] ` +
      `/Resources << /ExtGState << /GH << /Type /ExtGState /CA ${HL_ALPHA} /ca ${HL_ALPHA} /BM /Multiply >> >> >> ` +
      `/Contents ${cid} 0 R >>`);
    offsets[cid] = size;
    put(`${cid} 0 obj\n<< /Length ${data.length}${packed ? ' /Filter /FlateDecode' : ''} >>\nstream\n`);
    put(data); put('\nendstream\nendobj\n');
  }
  const count = 2 + 2 * n, xref = size;
  put(`xref\n0 ${count + 1}\n0000000000 65535 f \n`);
  for (let id = 1; id <= count; id++) put(String(offsets[id]).padStart(10, '0') + ' 00000 n \n');
  put(`trailer\n<< /Size ${count + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/* ------------------------------------------------------------------ */
/* Editor — everything on screen. Talks to Obsidian only via `host`.   */
/* ------------------------------------------------------------------ */

function el(tag, cls, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}

const TOOLS = [
  ['pen', 'pencil', 'Pen'],
  ['highlighter', 'highlighter', 'Highlighter'],
  ['eraser', 'eraser', 'Eraser'],
  ['lasso', 'lasso', 'Lasso select'],
  ['shape', 'shapes|circle', 'Shape pen (lines and circles)'],
];

class Editor {
  constructor(parent, host) {
    this.host = host;
    this.prefs = host.prefs;
    this.nb = newNotebook(this.prefs);
    this.pageIndex = 0;
    this.scale = 1; this.tx = 0; this.ty = 0; this.res = 0; this.ready = false;
    this.act = null;                  // pen / mouse action in progress
    this.touches = new Map();         // fingers currently used for a gesture
    this.gesture = null;
    this.sel = new Set(); this.selBox = null; this.selDx = 0; this.selDy = 0;
    this.undoStack = []; this.redoStack = [];
    this.liveQueued = false; this.resTimer = 0;
    this.rect = { left: 0, top: 0 };
    this.origin = { x: 0, y: 0, k: 1 };  // where the page really is on screen, measured at pen-down
    this.gestureQueued = false;
    this.penUpAt = 0;

    this.root = el('div', 'inkbook-root', parent);
    this.root.tabIndex = -1;
    this.toolbar = el('div', 'inkbook-toolbar', this.root);
    this.stage = el('div', 'inkbook-stage', this.root);
    this.pageEl = el('div', 'inkbook-page', this.stage);
    this.main = el('canvas', '', this.pageEl);
    this.live = el('canvas', '', this.pageEl);
    this.hint = el('div', 'inkbook-hint', this.stage);
    this.selBar = el('div', 'inkbook-selbar', this.stage);
    this.buildToolbar();
    this.buildSelBar();

    const st = this.stage;
    st.addEventListener('pointerdown', (e) => this.onDown(e));
    st.addEventListener('pointermove', (e) => this.onMove(e));
    st.addEventListener('pointerup', (e) => this.onUp(e));
    st.addEventListener('pointercancel', (e) => this.onUp(e));
    st.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    st.addEventListener('contextmenu', (e) => e.preventDefault());
    // Keep Obsidian's sidebar swipes and iOS scrolling away from the page. Cancelling touchstart also
    // stops iPadOS Scribble / text selection from grabbing the Pencil, which otherwise delays or
    // swallows its pointer events until the pencil lifts.
    st.addEventListener('touchstart', (e) => {
      e.stopPropagation();
      if (!this.selBar.contains(e.target)) e.preventDefault();
    }, { passive: false });
    // overflow:hidden boxes can still be scrolled by the browser; any scroll would shift the page
    // away from where the pen maths thinks it is.
    st.addEventListener('scroll', () => { st.scrollLeft = 0; st.scrollTop = 0; });
    st.addEventListener('touchmove', (e) => { e.stopPropagation(); e.preventDefault(); }, { passive: false });
    this.root.addEventListener('keydown', (e) => this.onKey(e));
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(st);
  }

  destroy() {
    this.ro.disconnect();
    clearTimeout(this.resTimer);
    if (this.act && this.act.timer) clearTimeout(this.act.timer);
    this.root.remove();
  }

  get page() { return this.nb.pages[this.pageIndex]; }

  load(nb) {
    const resized = nb.w !== this.nb.w || nb.h !== this.nb.h;
    this.nb = nb;
    this.pageIndex = clamp(this.pageIndex, 0, nb.pages.length - 1);
    this.undoStack = []; this.redoStack = [];
    this.act = null; this.dropSelection();
    if (resized) { this.ready = false; this.res = 0; }
    this.layout();
    this.renderMain(); this.clearLive();
    this.refreshToolbar();
  }

  /* ---------------- toolbar ---------------- */

  btn(parent, icon, label, fn) {
    const b = el('button', 'inkbook-btn', parent);
    b.setAttribute('aria-label', label);
    this.host.setIcon(b, icon);
    b.addEventListener('click', (e) => { e.preventDefault(); fn(e); });
    return b;
  }

  buildToolbar() {
    const t = this.toolbar;
    this.toolBtns = {};
    const g1 = el('div', 'inkbook-group', t);
    for (const [tool, icon, label] of TOOLS) this.toolBtns[tool] = this.btn(g1, icon, label, () => this.setTool(tool));
    this.palette = el('div', 'inkbook-group', t);
    this.sizes = el('div', 'inkbook-group', t);
    const g2 = el('div', 'inkbook-group', t);
    this.undoBtn = this.btn(g2, 'undo-2|undo', 'Undo', () => this.undo());
    this.redoBtn = this.btn(g2, 'redo-2|redo', 'Redo', () => this.redo());
    this.pasteBtn = this.btn(g2, 'clipboard-paste|clipboard', 'Paste', () => this.paste());
    el('div', 'inkbook-spacer', t);
    const g3 = el('div', 'inkbook-group', t);
    this.prevBtn = this.btn(g3, 'chevron-left', 'Previous page', () => this.goTo(this.pageIndex - 1, -1));
    this.pageLabel = el('div', 'inkbook-pagelabel', g3);
    this.nextBtn = this.btn(g3, 'chevron-right', 'Next page', () => this.goTo(this.pageIndex + 1, 1));
    this.btn(g3, 'plus', 'Add page', () => this.addPage());
    const g4 = el('div', 'inkbook-group', t);
    this.btn(g4, 'layout-grid|grid', 'Page style', (e) => this.pageMenu(e));
    this.btn(g4, 'more-horizontal|more-vertical', 'More', (e) => this.moreMenu(e));
    this.refreshToolbar();
  }

  refreshToolbar() {
    const p = this.prefs, tool = p.tool;
    for (const k in this.toolBtns) this.toolBtns[k].classList.toggle('is-active', k === tool);

    this.palette.textContent = '';
    if (tool !== 'eraser') {
      const hl = tool === 'highlighter', cur = hl ? p.hlColor : p.penColor;
      const colors = hl ? HL_COLORS : PEN_COLORS;
      for (const c of colors) {
        const b = el('button', 'inkbook-swatch' + (c === cur ? ' is-active' : ''), this.palette);
        b.style.backgroundColor = c;
        b.setAttribute('aria-label', 'Colour');
        b.addEventListener('click', () => this.setColor(c));
      }
      const custom = el('input', 'inkbook-swatch inkbook-custom' + (colors.includes(cur) ? '' : ' is-active'), this.palette);
      custom.type = 'color'; custom.value = cur;
      custom.setAttribute('aria-label', 'Custom colour');
      custom.addEventListener('change', () => this.setColor(custom.value));
    }

    this.sizes.textContent = '';
    const key = tool === 'highlighter' ? 'hlSize' : tool === 'eraser' ? 'eraserSize' : tool === 'lasso' ? null : 'penSize';
    if (key) {
      const list = key === 'hlSize' ? HL_SIZES : key === 'eraserSize' ? ERASER_SIZES : PEN_SIZES;
      list.forEach((v, i) => {
        const b = el('button', 'inkbook-btn inkbook-size' + (p[key] === v ? ' is-active' : ''), this.sizes);
        b.setAttribute('aria-label', ['Thin', 'Medium', 'Thick'][i]);
        const d = el('div', 'inkbook-dot', b);
        d.style.width = d.style.height = 5 + i * 5 + 'px';
        b.addEventListener('click', () => { p[key] = v; this.host.savePrefs(); this.refreshToolbar(); });
      });
    }
    this.refreshState();
  }

  refreshState() {
    this.undoBtn.disabled = !this.undoStack.length;
    this.redoBtn.disabled = !this.redoStack.length;
    this.pasteBtn.style.display = this.host.getClipboard() ? '' : 'none';
    this.prevBtn.disabled = this.pageIndex === 0;
    this.nextBtn.disabled = this.pageIndex >= this.nb.pages.length - 1;
    this.pageLabel.textContent = `${this.pageIndex + 1} / ${this.nb.pages.length}`;
  }

  setTool(tool) {
    if (tool !== 'lasso') this.clearSelection();
    this.prefs.tool = tool;
    this.host.savePrefs();
    this.refreshToolbar();
  }

  setColor(c) {
    if (this.sel.size) {
      this.pushHistory();
      this.transformSel((s) => Object.assign({}, s, { c }));
      this.queueLive(); this.changed();
    }
    this.prefs[this.prefs.tool === 'highlighter' ? 'hlColor' : 'penColor'] = c;
    this.host.savePrefs();
    this.refreshToolbar();
  }

  pageMenu(evt) {
    const nb = this.nb, page = this.page, items = [];
    for (const k in TEMPLATES) items.push({ title: TEMPLATES[k], checked: page.tpl === k, click: () => { page.tpl = k; this.renderMain(); this.changed(); } });
    items.push({ title: 'Use this style on all pages', click: () => { for (const p of nb.pages) p.tpl = page.tpl; this.changed(); } });
    items.push('-');
    for (const [v, title] of SPACINGS) items.push({ title, checked: Math.abs(nb.spacing - v) < 0.1, click: () => { nb.spacing = v; this.renderMain(); this.changed(); } });
    items.push('-');
    items.push({ title: 'White paper', checked: nb.paper === 'white', click: () => { nb.paper = 'white'; this.renderMain(); this.changed(); } });
    items.push({ title: 'Cream paper', checked: nb.paper === 'cream', click: () => { nb.paper = 'cream'; this.renderMain(); this.changed(); } });
    this.host.menu(items, evt);
  }

  moreMenu(evt) {
    const p = this.prefs;
    const toggle = (key, title) => ({ title, checked: !!p[key], click: () => { p[key] = !p[key]; this.host.savePrefs(); } });
    this.host.menu([
      { title: 'Export notebook as PDF', icon: 'file-down', click: () => this.exportPdf() },
      { title: 'Export this page as PNG', icon: 'image', click: () => this.exportPng() },
      '-',
      { title: 'Zoom to fit', icon: 'maximize', click: () => { this.fit(); this.applyTransform(); this.ensureRes(); } },
      { title: 'Clear page', icon: 'eraser', click: () => this.clearPage() },
      { title: 'Delete page', icon: 'trash-2', click: () => this.deletePage() },
      '-',
      toggle('fingerDraw', 'Draw with finger'),
      toggle('scribbleErase', 'Scribble to erase'),
      toggle('holdSnap', 'Hold to straighten lines and circles'),
    ], evt);
  }

  /* ---------------- view transform ---------------- */

  layout() {
    const cw = this.stage.clientWidth, ch = this.stage.clientHeight;
    if (!cw || !ch) return;
    this.pageEl.style.width = this.nb.w + 'px';
    this.pageEl.style.height = this.nb.h + 'px';
    if (!this.ready) { this.ready = true; this.fit(); }
    this.clampPan(); this.applyTransform(); this.ensureRes();
  }

  fit() {
    const cw = this.stage.clientWidth;
    this.scale = Math.min((cw - 24) / this.nb.w, 1.8);
    this.tx = (cw - this.nb.w * this.scale) / 2;
    this.ty = 12;
    this.clampPan();
  }

  panRange() {
    const cw = this.stage.clientWidth, ch = this.stage.clientHeight, m = 12;
    const pw = this.nb.w * this.scale, ph = this.nb.h * this.scale;
    return {
      x: pw + 2 * m <= cw ? [(cw - pw) / 2, (cw - pw) / 2] : [cw - pw - m, m],
      y: ph + 2 * m <= ch ? [(ch - ph) / 2, (ch - ph) / 2] : [ch - ph - m, m],
    };
  }

  clampPan() {
    const r = this.panRange();
    this.tx = clamp(this.tx, r.x[0], r.x[1]);
    this.ty = clamp(this.ty, r.y[0], r.y[1]);
  }

  transformCss(extra) {
    return `translate(${this.tx + (extra || 0)}px,${this.ty}px) scale(${this.scale})`;
  }

  applyTransform(extra) {
    this.pageEl.style.transform = this.transformCss(extra);
    this.placeSelBar();
  }

  zoomAt(cx, cy, s) {
    const cw = this.stage.clientWidth, ch = this.stage.clientHeight;
    const min = Math.min((cw - 24) / this.nb.w, (ch - 24) / this.nb.h) * 0.8;
    s = clamp(s, min, 8);
    const px = (cx - this.tx) / this.scale, py = (cy - this.ty) / this.scale;
    this.scale = s; this.tx = cx - px * s; this.ty = cy - py * s;
    this.clampPan(); this.applyTransform(); this.resSoon();
  }

  /* Canvas resolution follows zoom (re-rendered once the zoom settles) so ink stays crisp. */
  resSoon() {
    clearTimeout(this.resTimer);
    this.resTimer = setTimeout(() => {
      if (this.act || this.gesture) this.resSoon(); else this.ensureRes();
    }, 160);
  }

  ensureRes() {
    const nb = this.nb, dpr = window.devicePixelRatio || 1;
    const want = Math.min(this.scale * dpr, Math.sqrt(MAX_CANVAS_PX / (nb.w * nb.h)));
    if (this.res && Math.abs(want - this.res) / this.res < 0.04) return;
    this.res = want;
    for (const c of [this.main, this.live]) { c.width = Math.round(nb.w * want); c.height = Math.round(nb.h * want); }
    this.renderMain(); this.paintLive();
  }

  ctxOf(canvas) {
    const ctx = canvas.getContext('2d');
    ctx.setTransform(this.res, 0, 0, this.res, 0, 0);
    return ctx;
  }

  /* ---------------- painting ---------------- */

  renderMain() {
    if (!this.res) return;
    const ctx = this.ctxOf(this.main), page = this.page;
    drawTemplate(ctx, this.nb, page);
    for (const s of page.strokes) if (!this.sel.has(s)) drawStroke(ctx, s);
  }

  clearLive() {
    const ctx = this.live.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.live.width, this.live.height);
  }

  queueLive() {
    if (this.liveQueued) return;
    this.liveQueued = true;
    requestAnimationFrame(() => { this.liveQueued = false; this.paintLive(); });
  }

  paintLive() {
    if (!this.res) return;
    const a = this.act;
    if (a && a.type === 'stroke') return this.paintLiveStroke(a);
    this.clearLive();
    const ctx = this.ctxOf(this.live), px = 1 / this.scale;
    if (this.sel.size && this.selBox) {
      const b = this.selBox;
      ctx.save();
      ctx.translate(this.selDx, this.selDy);
      for (const s of this.page.strokes) if (this.sel.has(s)) drawStroke(ctx, s);
      ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 1.2 * px; ctx.setLineDash([5 * px, 4 * px]);
      ctx.strokeRect(b.x0 - 4 * px, b.y0 - 4 * px, b.x1 - b.x0 + 8 * px, b.y1 - b.y0 + 8 * px);
      ctx.restore();
    }
    if (a && a.type === 'lasso') {
      ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 1.4 * px; ctx.setLineDash([5 * px, 4 * px]);
      ctx.beginPath(); ctx.moveTo(a.pts[0], a.pts[1]);
      for (let i = 2; i < a.pts.length; i += 2) ctx.lineTo(a.pts[i], a.pts[i + 1]);
      ctx.stroke(); ctx.setLineDash([]);
    } else if (a && a.type === 'erase') {
      ctx.strokeStyle = 'rgba(90,90,90,.8)'; ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = px;
      ctx.beginPath(); ctx.arc(a.x, a.y, this.prefs.eraserSize / 2, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }

  /* While writing, the stroke is redrawn each frame right up to the pencil tip (the stabilised
     curve plus a final piece to the raw pen position), clearing only the area it covers. */
  paintLiveStroke(a) {
    const s = a.s, ctx = this.ctxOf(this.live);
    const p = a.snapped || (a.rx === s.p[s.p.length - 3] && a.ry === s.p[s.p.length - 2]
      ? s.p : s.p.concat([r2(a.rx), r2(a.ry), r2(a.sp)]));
    const tmp = { t: s.t, c: s.c, w: s.w, p };
    if (a.box) {
      const b = a.box;
      ctx.clearRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    }
    const b = ptsBox(p, 3), m = s.w * 2 + 2 / this.res;
    a.box = { x0: b.x0 - m, y0: b.y0 - m, x1: b.x1 + m, y1: b.y1 + m };
    ctx.save();
    drawStroke(ctx, tmp);
    ctx.restore();
  }

  /* ---------------- input ---------------- */

  /* Pen coordinates come from where the page is actually drawn (its on-screen box), not from the
     model's tx/ty, so any outside offset — scrolled containers, sidebars, a running animation,
     Obsidian's own zoom — can't make ink land away from the pencil tip. */
  measureOrigin() {
    if (this.pageEl.getAnimations) for (const an of this.pageEl.getAnimations()) an.finish();
    const r = this.pageEl.getBoundingClientRect();
    const k = r.width > 0 ? r.width / this.nb.w : this.scale;
    this.origin = { x: r.left, y: r.top, k };
  }

  toPage(e) {
    const o = this.origin;
    return [(e.clientX - o.x) / o.k, (e.clientY - o.y) / o.k];
  }

  pressure(e) {
    if (!this.prefs.pressure || e.pointerType !== 'pen') return 0.5;
    return r2(clamp(e.pressure || 0, 0.05, 1));
  }

  onDown(e) {
    if (this.selBar.contains(e.target)) return;
    this.rect = this.stage.getBoundingClientRect();
    this.root.focus({ preventScroll: true });
    try { this.stage.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }

    if (e.pointerType === 'touch') {
      if (this.act && !this.act.touch) return;              // pencil is down: this is a resting palm
      // A hand landing right after the pencil lifts is a palm, not a scroll.
      if (!this.touches.size && performance.now() - this.penUpAt < 350) return;
      this.touches.set(e.pointerId, { x: e.clientX - this.rect.left, y: e.clientY - this.rect.top });
      if (this.prefs.fingerDraw && this.touches.size === 1 && !this.act) { this.measureOrigin(); this.beginAct(e); return; }
      if (this.act) this.cancelAct();                       // second finger: stop drawing, start pinch
      this.beginGesture(this.gesture && this.gesture.pinched);
      return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (this.act) return;
    e.preventDefault();
    if (this.gesture) {                                     // pencil wins over any finger gesture
      const g = this.gesture;
      this.endGesture(true);
      // A palm that touched down just before the pencil may have dragged the page; put it back.
      if (!g.pinched && performance.now() - g.t0 < 1000) {
        this.scale = g.scale; this.tx = g.tx; this.ty = g.ty;
        this.clampPan(); this.applyTransform();
      }
    }
    this.touches.clear();
    this.measureOrigin();
    this.beginAct(e);
  }

  onMove(e) {
    const a = this.act;
    if (a && a.id === e.pointerId) { this.moveAct(e); return; }
    const t = this.touches.get(e.pointerId);
    if (t && this.gesture) {
      t.x = e.clientX - this.rect.left; t.y = e.clientY - this.rect.top;
      // Each finger reports separately; apply them together once per frame so a pinch doesn't jitter.
      if (!this.gestureQueued) {
        this.gestureQueued = true;
        requestAnimationFrame(() => { this.gestureQueued = false; if (this.gesture) this.moveGesture(); });
      }
    }
  }

  onUp(e) {
    const a = this.act;
    if (a && a.id === e.pointerId) {
      this.touches.delete(e.pointerId);
      if (!a.touch) this.penUpAt = performance.now();
      this.endAct();
      return;
    }
    if (this.touches.delete(e.pointerId) && this.gesture) {
      // After a pinch the remaining finger only pans; it never turns the page.
      if (this.touches.size) this.beginGesture(this.gesture.pinched || this.gesture.mode === 'pinch');
      else this.endGesture(false);
    }
  }

  onWheel(e) {
    e.preventDefault();
    const r = this.stage.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      this.zoomAt(e.clientX - r.left, e.clientY - r.top, this.scale * Math.exp(-e.deltaY * 0.01));
    } else {
      this.tx -= e.deltaX; this.ty -= e.deltaY;
      this.clampPan(); this.applyTransform();
    }
  }

  onKey(e) {
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    let done = true;
    if (mod && k === 'z') e.shiftKey ? this.redo() : this.undo();
    else if (mod && k === 'y') this.redo();
    else if (mod && k === 'v') this.paste();
    else if (this.sel.size && mod && k === 'c') this.copySel();
    else if (this.sel.size && mod && k === 'x') { this.copySel(); this.deleteSel(); }
    else if (this.sel.size && (k === 'delete' || k === 'backspace')) this.deleteSel();
    else done = false;
    if (done) { e.preventDefault(); e.stopPropagation(); }
  }

  /* ---------------- finger gestures: pan, pinch-zoom, page swipe ---------------- */

  centroid() {
    let x = 0, y = 0;
    for (const t of this.touches.values()) { x += t.x; y += t.y; }
    const n = this.touches.size, pts = [...this.touches.values()];
    return { x: x / n, y: y / n, d: n >= 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0 };
  }

  beginGesture(pinched) {
    const c = this.centroid(), old = this.gesture;
    if (old && old.mode === 'swipe' && old.swipe) this.applyTransform();   // drop a half-done swipe
    const two = this.touches.size >= 2;
    this.gesture = {
      n: this.touches.size, cx: c.x, cy: c.y, d: c.d,
      scale: this.scale, tx: this.tx, ty: this.ty,
      mode: two ? 'pinch' : pinched ? 'pan' : 'undecided', swipe: 0,
      pinched: !!pinched || two,
      t0: old ? old.t0 : performance.now(),
    };
  }

  moveGesture() {
    const g = this.gesture, c = this.centroid();
    if (g.mode === 'pinch') {
      if (g.d < 1) return;
      const cw = this.stage.clientWidth, ch = this.stage.clientHeight;
      const min = Math.min((cw - 24) / this.nb.w, (ch - 24) / this.nb.h) * 0.8;
      const s = clamp(g.scale * (c.d / g.d), min, 8);
      this.scale = s;
      this.tx = c.x - ((g.cx - g.tx) / g.scale) * s;
      this.ty = c.y - ((g.cy - g.ty) / g.scale) * s;
      this.clampPan(); this.applyTransform(); this.resSoon();
      return;
    }
    const dx = c.x - g.cx, dy = c.y - g.cy;
    if (g.mode === 'undecided') {
      if (Math.hypot(dx, dy) < 8) return;
      // A sideways drag turns the page, unless the zoomed page can still scroll that way.
      const r = this.panRange();
      const stuck = dx < 0 ? this.tx <= r.x[0] + 0.5 : this.tx >= r.x[1] - 0.5;
      g.mode = Math.abs(dx) > Math.abs(dy) * 1.2 && stuck ? 'swipe' : 'pan';
    }
    if (g.mode === 'pan') {
      this.tx = g.tx + dx; this.ty = g.ty + dy;
      this.clampPan(); this.applyTransform();
    } else {
      const last = this.pageIndex === this.nb.pages.length - 1;
      g.swipe = dx > 0 && this.pageIndex === 0 ? dx * 0.25 : dx;
      this.applyTransform(g.swipe);
      if (last && dx < 0) {
        this.hint.textContent = dx < -130 ? 'Release for new page' : 'New page';
        this.hint.style.opacity = String(clamp(-dx / 130, 0, 1));
      } else this.hint.style.opacity = '0';
    }
  }

  endGesture(cancel) {
    const g = this.gesture;
    this.gesture = null;
    this.hint.style.opacity = '0';
    if (!g || g.mode !== 'swipe') return;
    const dx = cancel ? 0 : g.swipe, last = this.pageIndex === this.nb.pages.length - 1;
    if (dx < -70 && !last) this.goTo(this.pageIndex + 1, 1);
    else if (dx < -130 && last) this.addPage();
    else if (dx > 70 && this.pageIndex > 0) this.goTo(this.pageIndex - 1, -1);
    else {
      this.applyTransform();
      if (this.pageEl.animate) this.pageEl.animate([{ transform: this.transformCss(g.swipe) }, { transform: this.transformCss() }], { duration: 140, easing: 'ease-out' });
    }
  }

  /* ---------------- pencil actions ---------------- */

  beginAct(e) {
    const [x, y] = this.toPage(e), p = this.prefs, id = e.pointerId, touch = e.pointerType === 'touch';
    let tool = p.tool;
    if (e.pointerType === 'pen' && ((e.buttons & 32) || e.button === 5)) tool = 'eraser';   // pencil eraser end / button
    if (tool === 'eraser') {
      this.act = { type: 'erase', id, touch, x, y, changed: false };
      this.eraseAlong(x, y, x, y);
      this.queueLive();
    } else if (tool === 'lasso') {
      if (this.sel.size && this.inSelBox(x, y)) {
        this.act = { type: 'move', id, touch, x0: x, y0: y };
        this.selBar.style.display = 'none';
      } else {
        this.clearSelection();
        this.act = { type: 'lasso', id, touch, pts: [x, y] };
      }
    } else {
      const hl = tool === 'highlighter', pr = this.pressure(e);
      this.act = {
        type: 'stroke', id, touch, tool,
        s: { t: hl ? 'highlighter' : 'pen', c: hl ? p.hlColor : p.penColor, w: hl ? p.hlSize : p.penSize, p: [r2(x), r2(y), pr] },
        sx: x, sy: y, sp: pr,           // stabilised position
        rx: x, ry: y,                   // raw position
        ax: x, ay: y,                   // anchor for hold-to-snap
        box: null, snapped: null, timer: 0,
      };
      this.armHold(this.act);
    }
  }

  moveAct(e) {
    const a = this.act;
    if (a.type === 'stroke') {
      const co = e.getCoalescedEvents ? e.getCoalescedEvents() : null;   // full-rate pencil samples
      const list = co && co.length ? co : [e];
      for (const ev of list) { const [x, y] = this.toPage(ev); this.addPoint(a, x, y, this.pressure(ev)); }
    } else {
      const [x, y] = this.toPage(e);
      if (a.type === 'erase') { this.eraseAlong(a.x, a.y, x, y); a.x = x; a.y = y; }
      else if (a.type === 'lasso') a.pts.push(x, y);
      else if (a.type === 'move') { this.selDx = x - a.x0; this.selDy = y - a.y0; }
    }
    this.queueLive();
  }

  addPoint(a, x, y, pr) {
    a.rx = x; a.ry = y;
    if (a.snapped) {                                   // after a line snaps, the pen drags its end point
      if (a.snapped.length === 6) { a.snapped[3] = r2(x); a.snapped[4] = r2(y); }
      return;
    }
    if (Math.hypot(x - a.ax, y - a.ay) > 4 / this.scale) { a.ax = x; a.ay = y; this.armHold(a); }
    const k = 1 - clamp(this.prefs.stabilize, 0, 0.9);  // stabiliser: ink trails the pen slightly
    a.sx += (x - a.sx) * k; a.sy += (y - a.sy) * k; a.sp += (pr - a.sp) * k;
    const p = a.s.p, n = p.length;
    if (Math.hypot(a.sx - p[n - 3], a.sy - p[n - 2]) < 0.4) return;
    p.push(r2(a.sx), r2(a.sy), r2(a.sp));
  }

  armHold(a) {
    clearTimeout(a.timer);
    if (!this.prefs.holdSnap && a.tool !== 'shape') return;
    a.timer = setTimeout(() => {
      if (this.act !== a || a.snapped) return;
      const r = recognize(a.s.p.concat([r2(a.rx), r2(a.ry), a.sp]));
      if (r) { a.snapped = r; this.queueLive(); }
    }, 500);
  }

  cancelAct() {
    const a = this.act;
    this.act = null;
    if (!a) return;
    clearTimeout(a.timer);
    if (a.type === 'move') { this.selDx = this.selDy = 0; this.placeSelBar(); }
    if (a.type === 'erase' && a.changed) this.changed();
    this.paintLive();
  }

  endAct() {
    const a = this.act, page = this.page;
    this.act = null;
    if (a.type === 'stroke') {
      clearTimeout(a.timer);
      const p = a.s.p;
      if (!a.snapped && Math.hypot(a.rx - p[p.length - 3], a.ry - p[p.length - 2]) > 0.05) p.push(r2(a.rx), r2(a.ry), r2(a.sp));
      let snapped = a.snapped;
      if (!snapped && a.tool === 'shape') snapped = recognize(p);
      if (!snapped && a.tool === 'pen' && this.prefs.scribbleErase && isScribble(p)) {
        const hit = new Set(page.strokes.filter((s) => scribbleHits(p, s)));
        if (hit.size) {
          this.pushHistory();
          page.strokes = page.strokes.filter((s) => !hit.has(s));
          this.clearLive(); this.renderMain(); this.changed();
          return;
        }
      }
      if (snapped) a.s.p = snapped;
      this.pushHistory();
      page.strokes.push(a.s);
      drawStroke(this.ctxOf(this.main), a.s);
      this.clearLive(); this.changed();
      return;
    }
    if (a.type === 'erase') {
      if (a.changed) this.changed();
    } else if (a.type === 'lasso') {
      const poly = a.pts;
      if (poly.length >= 8 && pathLength(poly, 2) > 10) {
        const pb = ptsBox(poly, 2), set = new Set();
        for (const s of page.strokes) {
          const b = strokeBox(s);
          if (b.x1 < pb.x0 || b.x0 > pb.x1 || b.y1 < pb.y0 || b.y0 > pb.y1) continue;
          let inside = 0;
          for (let i = 0; i < s.p.length; i += 3) if (inPolygon(s.p[i], s.p[i + 1], poly)) inside++;
          if (inside / (s.p.length / 3) >= 0.6) set.add(s);
        }
        if (set.size) this.select(set);
      }
    } else if (a.type === 'move') {
      const dx = this.selDx, dy = this.selDy;
      this.selDx = this.selDy = 0;
      if (dx || dy) {
        this.pushHistory();
        this.transformSel((s) => {
          const q = s.p.slice();
          for (let i = 0; i < q.length; i += 3) { q[i] = r2(q[i] + dx); q[i + 1] = r2(q[i + 1] + dy); }
          return Object.assign({}, s, { p: q });
        });
        this.changed();
      }
      this.placeSelBar();
    }
    this.queueLive();
  }

  eraseAlong(x0, y0, x1, y1) {
    const a = this.act, page = this.page, r = this.prefs.eraserSize / 2;
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / Math.max(r, 1)));
    let hit = null;
    for (const s of page.strokes) {
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        if (strokeNear(s, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r)) { (hit || (hit = new Set())).add(s); break; }
      }
    }
    if (!hit) return;
    if (!a.changed) { this.pushHistory(); a.changed = true; }
    page.strokes = page.strokes.filter((s) => !hit.has(s));
    this.renderMain();
  }

  /* ---------------- selection (lasso) ---------------- */

  buildSelBar() {
    this.selBar.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.btn(this.selBar, 'copy', 'Copy', () => { this.copySel(); this.host.notice('Copied — paste on any page or notebook'); });
    this.btn(this.selBar, 'scissors', 'Cut', () => { this.copySel(); this.deleteSel(); });
    this.btn(this.selBar, 'copy-plus|files', 'Duplicate', () => this.pasteStrokes(this.selStrokes(), 14, 14));
    this.btn(this.selBar, 'trash-2|trash', 'Delete', () => this.deleteSel());
  }

  selStrokes() { return this.page.strokes.filter((s) => this.sel.has(s)); }

  computeSelBox() {
    let b = null;
    for (const s of this.sel) {
      const q = strokeBox(s);
      b = b ? { x0: Math.min(b.x0, q.x0), y0: Math.min(b.y0, q.y0), x1: Math.max(b.x1, q.x1), y1: Math.max(b.y1, q.y1) } : Object.assign({}, q);
    }
    this.selBox = b;
  }

  inSelBox(x, y) {
    const b = this.selBox, m = 8 / this.scale;
    return !!b && x >= b.x0 - m && x <= b.x1 + m && y >= b.y0 - m && y <= b.y1 + m;
  }

  select(set) {
    this.sel = set; this.selDx = this.selDy = 0;
    this.computeSelBox();
    this.renderMain(); this.queueLive(); this.placeSelBar();
  }

  dropSelection() {
    this.sel = new Set(); this.selBox = null; this.selDx = this.selDy = 0;
    this.selBar.style.display = 'none';
  }

  clearSelection() {
    if (!this.sel.size) return;
    this.dropSelection();
    this.renderMain(); this.queueLive();
  }

  transformSel(fn) {
    const next = new Set();
    this.page.strokes = this.page.strokes.map((s) => {
      if (!this.sel.has(s)) return s;
      const n = fn(s); next.add(n); return n;
    });
    this.sel = next;
    this.computeSelBox();
  }

  placeSelBar() {
    const bar = this.selBar, b = this.selBox;
    if (!b || !this.sel.size || (this.act && this.act.type === 'move')) { bar.style.display = 'none'; return; }
    bar.style.display = 'flex';
    const cw = this.stage.clientWidth, ch = this.stage.clientHeight, bw = bar.offsetWidth || 150, bh = bar.offsetHeight || 40;
    const x = this.tx + ((b.x0 + b.x1) / 2) * this.scale - bw / 2;
    let y = this.ty + b.y0 * this.scale - bh - 12;
    if (y < 6) y = this.ty + b.y1 * this.scale + 12;
    bar.style.left = clamp(x, 6, Math.max(6, cw - bw - 6)) + 'px';
    bar.style.top = clamp(y, 6, Math.max(6, ch - bh - 6)) + 'px';
  }

  copySel() {
    this.host.setClipboard(this.selStrokes().map((s) => Object.assign({}, s, { p: s.p.slice() })));
    this.refreshState();
  }

  deleteSel() {
    if (!this.sel.size) return;
    this.pushHistory();
    this.page.strokes = this.page.strokes.filter((s) => !this.sel.has(s));
    this.dropSelection();
    this.renderMain(); this.queueLive(); this.changed();
  }

  paste() {
    const clip = this.host.getClipboard();
    if (!clip || !clip.length) return;
    // Drop the copy in the middle of what is currently visible.
    let b = null;
    for (const s of clip) { const q = strokeBox(s); b = b ? { x0: Math.min(b.x0, q.x0), y0: Math.min(b.y0, q.y0), x1: Math.max(b.x1, q.x1), y1: Math.max(b.y1, q.y1) } : Object.assign({}, q); }
    const vx = clamp((this.stage.clientWidth / 2 - this.tx) / this.scale, 0, this.nb.w);
    const vy = clamp((this.stage.clientHeight / 2 - this.ty) / this.scale, 0, this.nb.h);
    this.pasteStrokes(clip, vx - (b.x0 + b.x1) / 2, vy - (b.y0 + b.y1) / 2);
  }

  pasteStrokes(strokes, dx, dy) {
    if (!strokes.length) return;
    const copies = strokes.map((s) => {
      const q = s.p.slice();
      for (let i = 0; i < q.length; i += 3) { q[i] = r2(q[i] + dx); q[i + 1] = r2(q[i + 1] + dy); }
      return Object.assign({}, s, { p: q });
    });
    this.pushHistory();
    this.sel = new Set();
    this.page.strokes.push(...copies);
    if (this.prefs.tool !== 'lasso') { this.prefs.tool = 'lasso'; this.host.savePrefs(); this.refreshToolbar(); }
    this.select(new Set(copies));
    this.changed();
  }

  /* ---------------- history ---------------- */

  pushHistory() {
    this.undoStack.push({ page: this.page, strokes: this.page.strokes.slice() });
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
  }

  undo() { this.stepHistory(this.undoStack, this.redoStack); }
  redo() { this.stepHistory(this.redoStack, this.undoStack); }

  stepHistory(from, to) {
    if (this.act) return;
    let h;
    while ((h = from.pop())) {
      const i = this.nb.pages.indexOf(h.page);
      if (i < 0) continue;                                 // page was deleted since
      to.push({ page: h.page, strokes: h.page.strokes.slice() });
      h.page.strokes = h.strokes;
      this.dropSelection();
      if (i !== this.pageIndex) this.goTo(i); else { this.renderMain(); this.paintLive(); }
      this.changed();
      return;
    }
    this.refreshState();
  }

  changed() {
    this.host.changed();
    this.refreshState();
  }

  /* ---------------- pages ---------------- */

  goTo(i, dir) {
    if (i < 0 || i >= this.nb.pages.length || this.act) return;
    this.dropSelection();
    this.pageIndex = i;
    this.ty = 12; this.clampPan();
    this.applyTransform();
    this.renderMain(); this.clearLive(); this.refreshState();
    if (dir && this.pageEl.animate) {
      this.pageEl.animate(
        [{ transform: this.transformCss(dir * 90), opacity: 0.3 }, { transform: this.transformCss(), opacity: 1 }],
        { duration: 170, easing: 'ease-out' });
    }
  }

  addPage() {
    this.nb.pages.splice(this.pageIndex + 1, 0, { id: uid(), tpl: this.page.tpl, strokes: [] });
    this.goTo(this.pageIndex + 1, 1);
    this.changed();
  }

  clearPage() {
    if (!this.page.strokes.length) return;
    this.pushHistory();
    this.page.strokes = [];
    this.dropSelection(); this.renderMain(); this.clearLive(); this.changed();
  }

  async deletePage() {
    if (this.page.strokes.length && !(await this.host.confirm(`Delete page ${this.pageIndex + 1}? This cannot be undone.`))) return;
    const pages = this.nb.pages, tpl = this.page.tpl;
    pages.splice(this.pageIndex, 1);
    if (!pages.length) pages.push({ id: uid(), tpl, strokes: [] });
    this.dropSelection();
    this.pageIndex = Math.min(this.pageIndex, pages.length - 1);
    this.renderMain(); this.clearLive(); this.changed();
  }

  /* ---------------- export ---------------- */

  async exportPdf() {
    try {
      const bytes = await buildPdf(this.nb);
      await this.host.saveFile('.pdf', bytes.buffer, 'application/pdf');
    } catch (e) { console.error(e); this.host.notice('PDF export failed: ' + e.message); }
  }

  async exportPng() {
    try {
      const nb = this.nb, k = 3, c = document.createElement('canvas');
      c.width = Math.round(nb.w * k); c.height = Math.round(nb.h * k);
      const ctx = c.getContext('2d');
      ctx.scale(k, k);
      drawTemplate(ctx, nb, this.page);
      for (const s of this.page.strokes) drawStroke(ctx, s);
      const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
      await this.host.saveFile(` - page ${this.pageIndex + 1}.png`, await blob.arrayBuffer(), 'image/png');
    } catch (e) { console.error(e); this.host.notice('PNG export failed: ' + e.message); }
  }
}

/* ------------------------------------------------------------------ */
/* Obsidian plugin shell                                               */
/* ------------------------------------------------------------------ */

const VIEW_TYPE = 'inkbook-view';
const EXT = 'inknote';

class ConfirmModal extends obsidian.Modal {
  constructor(app, text, done) { super(app); this.text = text; this.done = done; this.answer = false; }
  onOpen() {
    this.contentEl.createEl('p', { text: this.text });
    new obsidian.Setting(this.contentEl)
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((b) => b.setButtonText('Delete').setWarning().onClick(() => { this.answer = true; this.close(); }));
  }
  onClose() { this.done(this.answer); }
}

class NewNotebookModal extends obsidian.Modal {
  constructor(app, plugin, folder) { super(app); this.plugin = plugin; this.folder = folder; }
  onOpen() {
    const s = this.plugin.settings;
    let name = 'Untitled notebook', template = s.template, landscape = s.landscape;
    const submit = () => { this.close(); this.plugin.createNotebook(this.folder, name, { template, landscape }); };
    this.titleEl.setText('New notebook');
    new obsidian.Setting(this.contentEl).setName('Name').setDesc('Created in: ' + (this.folder.path === '/' ? 'vault root' : this.folder.path))
      .addText((t) => {
        t.setValue(name).onChange((v) => { name = v; });
        t.inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
        setTimeout(() => { t.inputEl.focus(); t.inputEl.select(); }, 0);
      });
    new obsidian.Setting(this.contentEl).setName('Page style')
      .addDropdown((d) => d.addOptions(TEMPLATES).setValue(template).onChange((v) => { template = v; }));
    new obsidian.Setting(this.contentEl).setName('Orientation')
      .addDropdown((d) => d.addOptions({ p: 'Portrait', l: 'Landscape' }).setValue(landscape ? 'l' : 'p').onChange((v) => { landscape = v === 'l'; }));
    new obsidian.Setting(this.contentEl).addButton((b) => b.setButtonText('Create').setCta().onClick(submit));
  }
  onClose() { this.contentEl.empty(); }
}

class InkbookView extends obsidian.TextFileView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.broken = null; this.editor = null; }
  getViewType() { return VIEW_TYPE; }
  getIcon() { return 'pencil'; }
  getDisplayText() { return this.file ? this.file.basename : 'Notebook'; }

  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass('inkbook-content');
    this.errorEl = this.contentEl.createDiv({ cls: 'inkbook-error' });
    this.errorEl.hide();
    this.editor = new Editor(this.contentEl, this.makeHost());
  }

  // Keep the editor object around: Obsidian may still ask for the data to save while closing.
  async onClose() { if (this.editor) this.editor.destroy(); }

  getViewData() {
    // If the file could not be parsed, hand its original text back untouched.
    return this.broken !== null ? this.broken : JSON.stringify(this.editor.nb);
  }

  setViewData(data, clear) {
    try {
      const nb = parseNotebook(data, this.plugin.settings);
      this.broken = null;
      this.errorEl.hide(); this.editor.root.style.display = '';
      if (clear) this.editor.pageIndex = 0;
      this.editor.load(nb);
    } catch (e) {
      this.broken = data;
      this.editor.root.style.display = 'none';
      this.errorEl.setText('This notebook file could not be read (' + e.message + '). It has been left untouched.');
      this.errorEl.show();
    }
  }

  clear() {}

  makeHost() {
    const plugin = this.plugin, view = this, app = plugin.app;
    return {
      prefs: plugin.settings,
      savePrefs: () => plugin.saveSettingsSoon(),
      changed: () => view.requestSave(),
      setIcon: (target, names) => {
        for (const n of names.split('|')) { obsidian.setIcon(target, n); if (target.firstChild) return; }
      },
      menu: (items, evt) => {
        const m = new obsidian.Menu();
        for (const it of items) {
          if (it === '-') { m.addSeparator(); continue; }
          m.addItem((i) => {
            i.setTitle(it.title).onClick(it.click);
            if (it.icon) i.setIcon(it.icon);
            if (it.checked) i.setChecked(true);
          });
        }
        m.showAtMouseEvent(evt);
      },
      notice: (t) => new obsidian.Notice(t),
      confirm: (t) => new Promise((res) => new ConfirmModal(app, t, res).open()),
      getClipboard: () => plugin.clipboard,
      setClipboard: (s) => { plugin.clipboard = s; },
      saveFile: async (suffix, buffer, mime) => {
        const f = view.file;
        const dir = f.parent && f.parent.path !== '/' ? f.parent.path + '/' : '';
        const path = obsidian.normalizePath(dir + f.basename + suffix);
        const existing = app.vault.getAbstractFileByPath(path);
        if (existing instanceof obsidian.TFile) await app.vault.modifyBinary(existing, buffer);
        else await app.vault.createBinary(path, buffer);
        new obsidian.Notice('Saved ' + path);
        // On iPad/iPhone also offer the share sheet (AirDrop, Files, Mail…).
        if (obsidian.Platform.isMobile && navigator.canShare) {
          try {
            const file = new File([buffer], path.split('/').pop(), { type: mime });
            if (navigator.canShare({ files: [file] })) await navigator.share({ files: [file] });
          } catch (e) { /* share cancelled or unavailable — the file is in the vault either way */ }
        }
      },
    };
  }
}

class InkbookSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const c = this.containerEl, s = this.plugin.settings, save = () => this.plugin.saveSettingsSoon();
    c.empty();
    const toggle = (key, name, desc) => new obsidian.Setting(c).setName(name).setDesc(desc)
      .addToggle((t) => t.setValue(!!s[key]).onChange((v) => { s[key] = v; save(); }));

    new obsidian.Setting(c).setName('New notebooks').setHeading();
    new obsidian.Setting(c).setName('Default page style')
      .addDropdown((d) => d.addOptions(TEMPLATES).setValue(s.template).onChange((v) => { s.template = v; save(); }));
    new obsidian.Setting(c).setName('Default grid size')
      .addDropdown((d) => {
        SPACINGS.forEach(([v, title], i) => d.addOption(String(i), title));
        d.setValue(String(Math.max(0, SPACINGS.findIndex(([v]) => Math.abs(v - s.spacing) < 0.1))))
          .onChange((v) => { s.spacing = SPACINGS[+v][0]; save(); });
      });
    new obsidian.Setting(c).setName('Default paper')
      .addDropdown((d) => d.addOptions({ white: 'White', cream: 'Cream' }).setValue(s.paper).onChange((v) => { s.paper = v; save(); }));

    new obsidian.Setting(c).setName('Pencil').setHeading();
    new obsidian.Setting(c).setName('Stroke stabilisation').setDesc('Higher is smoother but the ink trails the pencil a little more.')
      .addSlider((sl) => sl.setLimits(0, 0.8, 0.05).setValue(s.stabilize).setDynamicTooltip().onChange((v) => { s.stabilize = v; save(); }));
    toggle('pressure', 'Pressure sensitivity', 'Press harder for thicker lines.');
    toggle('fingerDraw', 'Draw with finger', 'Off: only the pencil draws; fingers scroll, zoom and turn pages.');
    toggle('scribbleErase', 'Scribble to erase', 'Scribbling back and forth over ink with the pen erases it.');
    toggle('holdSnap', 'Hold to straighten', 'Pause at the end of a stroke to snap it to a straight line or circle.');
  }
}

class InkbookPlugin extends obsidian.Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_PREFS, await this.loadData());
    this.clipboard = null;
    this.saveSettingsSoon = obsidian.debounce(() => this.saveData(this.settings), 500, true);

    this.registerView(VIEW_TYPE, (leaf) => new InkbookView(leaf, this));
    this.registerExtensions([EXT], VIEW_TYPE);
    this.addRibbonIcon('pencil', 'New ink notebook', () => this.promptNew());
    this.addCommand({ id: 'new-notebook', name: 'New notebook', callback: () => this.promptNew() });
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (file instanceof obsidian.TFolder) {
        menu.addItem((i) => i.setTitle('New ink notebook').setIcon('pencil').onClick(() => this.promptNew(file)));
      }
    }));
    this.addSettingTab(new InkbookSettingTab(this.app, this));
  }

  promptNew(folder) {
    if (!folder) {
      const active = this.app.workspace.getActiveFile();
      folder = this.app.fileManager.getNewFileParent(active ? active.path : '');
    }
    new NewNotebookModal(this.app, this, folder).open();
  }

  async createNotebook(folder, name, opts) {
    name = (name || '').replace(/[\\/:*?"<>|#^[\]]/g, '').trim() || 'Untitled notebook';
    const dir = folder.path === '/' ? '' : folder.path + '/';
    let path = obsidian.normalizePath(`${dir}${name}.${EXT}`);
    for (let i = 1; this.app.vault.getAbstractFileByPath(path); i++) path = obsidian.normalizePath(`${dir}${name} ${i}.${EXT}`);
    const file = await this.app.vault.create(path, JSON.stringify(newNotebook(this.settings, opts)));
    await this.app.workspace.getLeaf(true).openFile(file);
  }
}

module.exports = InkbookPlugin;
// Exposed for the browser test harness (dev/index.html).
InkbookPlugin.Editor = Editor;
InkbookPlugin.internals = { DEFAULT_PREFS, parseNotebook, newNotebook, buildPdf, isScribble, recognize };
