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
const TEXT_SIZES = [12, 16, 24];
const MAX_CANVAS_PX = 8e6;
const MAX_PIC = 2000;                       // pictures are stored at most this many pixels across
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', heic: 'image/heic' };
const PIC_EXTS = Object.keys(MIME);                  // keeps memory low and stays under iOS canvas limits

const DEFAULT_PREFS = {
  tool: 'pen',
  penColor: PEN_COLORS[0], hlColor: HL_COLORS[0],
  penSize: PEN_SIZES[1], hlSize: HL_SIZES[1], eraserSize: ERASER_SIZES[1],
  textSize: TEXT_SIZES[1],
  eraserMode: 'precise',                    // 'precise' rubs out only what is under the circle; 'stroke' removes whole strokes
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
    version: 2,
    w: o.landscape ? A4[1] : A4[0],
    h: o.landscape ? A4[0] : A4[1],
    spacing: prefs.spacing, paper: prefs.paper,
    pages: [{ id: uid(), tpl: o.template, strokes: [] }],
  };
}

/* ------------------------------------------------------------------ */
/* File format                                                         */
/* ------------------------------------------------------------------ */

/* In memory a stroke is { t, c, w, p: [x, y, pressure, x, y, pressure, ...] }.
   On disk (version 2) the points are packed into a short string: every number is an integer
   (coordinates in 1/32 pt, pressure in 1/100), stored as the difference from the previous point
   and written as base64 digits, 5 bits each (the same trick as JS source maps). Pen colour and
   width live once in a shared `styles` table. This is about a fifth of the size of plain JSON
   numbers. Version 1 files (plain JSON numbers under `pages`) are still read. */
const Q = 32;
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64I = new Int8Array(128).fill(-1);
for (let i = 0; i < 64; i++) B64I[B64.charCodeAt(i)] = i;

function packPoints(p) {
  let out = '';
  const put = (v) => {
    let z = v < 0 ? -2 * v - 1 : 2 * v;
    do { const d = z % 32; z = (z - d) / 32; out += B64[z ? d + 32 : d]; } while (z);
  };
  const uni = uniform(p);
  put(uni ? Math.round(p[2] * 100) : -1);     // one pressure for the whole stroke, or -1: one per point
  let px = 0, py = 0, pp = 0;
  for (let i = 0; i < p.length; i += 3) {
    const x = Math.round(p[i] * Q), y = Math.round(p[i + 1] * Q);
    put(x - px); put(y - py); px = x; py = y;
    if (!uni) { const r = Math.round(p[i + 2] * 100); put(r - pp); pp = r; }
  }
  return out;
}

function unpackPoints(str) {
  if (typeof str !== 'string') return null;
  const v = [];
  let acc = 0, mul = 1;
  for (let i = 0; i < str.length; i++) {
    const d = B64I[str.charCodeAt(i)];
    if (!(d >= 0)) return null;
    acc += (d & 31) * mul;
    if (d & 32) mul *= 32;
    else { v.push(acc % 2 ? -(acc + 1) / 2 : acc / 2); acc = 0; mul = 1; }
  }
  const uni = v[0] >= 0, step = uni ? 2 : 3;
  if (mul !== 1 || v.length < 1 + step || (v.length - 1) % step) return null;
  const p = [];
  let x = 0, y = 0, pr = uni ? v[0] : 0;
  for (let i = 1; i < v.length; i += step) {
    x += v[i]; y += v[i + 1];
    if (!uni) pr += v[i + 2];
    p.push(x / Q, y / Q, pr / 100);
  }
  return p;
}

const num = (v, d) => (Number.isFinite(+v) ? +v : d);

/* Text boxes { k:'text', x, y, w, size, c, text, rot } and pictures { k:'img', x, y, w, h, src, rot }:
   x, y is the top-left corner before rotation; rot (radians) turns the box about its centre. */
function cleanItem(it) {
  if (!it || typeof it !== 'object') return null;
  const base = { x: r2(num(it.x, 0)), y: r2(num(it.y, 0)), rot: num(it.rot, 0) };
  if (it.k === 'text' && typeof it.text === 'string') {
    return Object.assign({ k: 'text' }, base, { w: Math.max(20, r2(num(it.w, 200))), size: clamp(r2(num(it.size, 16)), 2, 400), c: String(it.c || '#1a1a1a'), text: it.text });
  }
  if (it.k === 'img' && typeof it.src === 'string') {
    const w = num(it.w, 0), h = num(it.h, 0);
    if (!(w > 0 && h > 0)) return null;
    return Object.assign({ k: 'img' }, base, { w: r2(w), h: r2(h), src: it.src });
  }
  return null;
}

const packCache = new WeakMap();              // strokes are never changed in place once on a page

function serializeNotebook(nb) {
  const styles = [], index = new Map();
  let hasItems = false;
  const pg = nb.pages.map((page) => {
    const o = { id: page.id, tpl: page.tpl };
    if (page.bg) o.bg = page.bg;
    if (page.items && page.items.length) { o.items = page.items; hasItems = true; }
    if (page.mark) { o.mark = 1; hasItems = true; }
    o.ink = [];
    for (const s of page.strokes) {
      const key = s.t + '|' + s.c + '|' + s.w;
      let i = index.get(key);
      if (i === undefined) { i = styles.length; index.set(key, i); styles.push([s.t === 'highlighter' ? 1 : 0, s.c, s.w]); }
      let str = packCache.get(s);
      if (str === undefined) { str = packPoints(s.p); packCache.set(s, str); }
      o.ink.push(i, str);
    }
    return o;
  });
  // The page list is called `pg`, not `pages`, so an older copy of the plugin on another device
  // refuses the file (and leaves it untouched) instead of opening it as an empty notebook.
  // Text boxes, pictures and bookmarks need version 3; without them the file stays readable by version 2 plugins.
  return JSON.stringify({ version: hasItems ? 3 : 2, w: nb.w, h: nb.h, spacing: nb.spacing, paper: nb.paper, styles, pg });
}

function parseNotebook(text, prefs) {
  if (!text || !text.trim()) return newNotebook(prefs);
  const d = JSON.parse(text);
  if (!d || typeof d !== 'object') throw new Error('Not an Inkbook notebook');
  if (d.version > 3) throw new Error('it was made by a newer version of Inkbook — update the plugin on this device');
  const v2 = Array.isArray(d.pg);
  if (!v2 && !Array.isArray(d.pages)) throw new Error('Not an Inkbook notebook');
  const nb = {
    version: 2, w: +d.w || A4[0], h: +d.h || A4[1],
    spacing: +d.spacing || 5 * MM, paper: PAPERS[d.paper] ? d.paper : 'white', pages: [],
  };
  const styles = Array.isArray(d.styles) ? d.styles : [];
  for (const src of v2 ? d.pg : d.pages) {
    if (!src) continue;
    const page = { id: src.id || uid(), tpl: TEMPLATES[src.tpl] ? src.tpl : 'squared', strokes: [] };
    if (src.bg && typeof src.bg.src === 'string' && src.bg.n >= 1) page.bg = { src: src.bg.src, n: src.bg.n };   // imported PDF page
    if (src.mark) page.mark = true;                      // bookmarked page
    if (Array.isArray(src.items)) {
      const items = src.items.map(cleanItem).filter(Boolean);
      if (items.length) page.items = items;
    }
    if (v2) {
      const ink = Array.isArray(src.ink) ? src.ink : [];
      for (let i = 0; i + 1 < ink.length; i += 2) {
        const st = styles[ink[i]], p = unpackPoints(ink[i + 1]);
        if (!Array.isArray(st) || !p) continue;
        const s = { t: st[0] ? 'highlighter' : 'pen', c: String(st[1]), w: +st[2] || 1, p };
        packCache.set(s, ink[i + 1]);
        page.strokes.push(s);
      }
    } else if (Array.isArray(src.strokes)) {
      for (const s of src.strokes) {
        if (!s || !Array.isArray(s.p) || s.p.length < 3 || s.p.length % 3) continue;
        const n = { t: s.t === 'highlighter' ? 'highlighter' : 'pen', c: String(s.c), w: +s.w || 1, p: s.p };
        n.p = simplify(n);                    // older notebooks kept every pencil sample
        page.strokes.push(n);
      }
    } else continue;
    nb.pages.push(page);
  }
  if (!nb.pages.length) nb.pages.push({ id: uid(), tpl: prefs.template, strokes: [] });
  return nb;
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
  if (p.length < 45) return false;
  const b = ptsBox(p, 3), diag = Math.hypot(b.x1 - b.x0, b.y1 - b.y0);
  if (diag < 6 || pathLength(p, 3) < diag * 3.5) return false;
  const min = Math.max(3, diag * 0.15);
  return Math.max(reversals(p, 0, min), reversals(p, 1, min)) >= 4;
}

/* A stroke is scribbled out only when most of it is covered by the scribble — at least 45% of
   its points lie close to the scribble's path — so ink that is merely touched survives. */
function scribbleHits(p, s) {
  const b = strokeBox(s), pb = ptsBox(p, 3);
  if (b.x1 < pb.x0 || b.x0 > pb.x1 || b.y1 < pb.y0 || b.y0 > pb.y1) return false;
  const q = s.p, n = q.length / 3, d = Math.max(3, s.w / 2 + 2.5), dd = d * d;
  let covered = 0;
  for (let i = 0; i < q.length; i += 3) {
    const x = q[i], y = q[i + 1];
    if (x < pb.x0 - d || x > pb.x1 + d || y < pb.y0 - d || y > pb.y1 + d) continue;
    for (let j = 3; j < p.length; j += 3) {
      if (segDist2(x, y, p[j - 3], p[j - 2], p[j], p[j + 1]) <= dd) { covered++; break; }
    }
  }
  return covered / n >= 0.45;
}

/* Thins out a finished stroke. Pencils report far more points than the shape needs; this keeps
   only those that matter (Ramer–Douglas–Peucker over x, y and line width), plus the immediate
   neighbours of every sharp turn so that corners are drawn exactly as tight as before. */
const SIMPLIFY_EPS = 0.06, SIMPLIFY_CORNER = 0.3;
function simplify(s) {
  const p = s.p, n = p.length / 3;
  if (n < 4) return p;
  const zk = s.t === 'highlighter' ? 0 : 0.6 * s.w;   // pressure -> half line width
  const keep = new Uint8Array(n), stack = [0, n - 1];
  keep[0] = keep[n - 1] = 1;
  while (stack.length) {
    const b = stack.pop(), a = stack.pop();
    if (b - a < 2) continue;
    const ax = p[3 * a], ay = p[3 * a + 1], az = p[3 * a + 2] * zk;
    const dx = p[3 * b] - ax, dy = p[3 * b + 1] - ay, dz = p[3 * b + 2] * zk - az, l2 = dx * dx + dy * dy + dz * dz;
    let worst = 0, at = -1;
    for (let i = a + 1; i < b; i++) {
      const ex = p[3 * i] - ax, ey = p[3 * i + 1] - ay, ez = p[3 * i + 2] * zk - az;
      let t = l2 ? (ex * dx + ey * dy + ez * dz) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = ex - t * dx, qy = ey - t * dy, qz = ez - t * dz, d = qx * qx + qy * qy + qz * qz;
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > SIMPLIFY_EPS * SIMPLIFY_EPS) { keep[at] = 1; stack.push(a, at, at, b); }
  }
  const kept = [];
  for (let i = 0; i < n; i++) if (keep[i]) kept.push(i);
  for (let k = 1; k < kept.length - 1; k++) {
    const a = 3 * kept[k - 1], c = 3 * kept[k], b = 3 * kept[k + 1];
    if (segDist2(p[c], p[c + 1], p[a], p[a + 1], p[b], p[b + 1]) > SIMPLIFY_CORNER * SIMPLIFY_CORNER) keep[kept[k] - 1] = keep[kept[k] + 1] = 1;
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(p[3 * i], p[3 * i + 1], p[3 * i + 2]);
  return out.length === p.length ? p : out;
}

/* Precise eraser: removes the parts of stroke `s` that lie under the circle (cx, cy, R) and returns
   what is left as new strokes — or null if the circle does not touch it. The cut is made half a
   line width outside the circle, so the rounded ends of the remaining ink just touch its edge. */
function cutStroke(s, cx, cy, R) {
  const b = strokeBox(s);
  if (cx < b.x0 - R || cx > b.x1 + R || cy < b.y0 - R || cy > b.y1 + R) return null;
  const p = s.p, r = R + s.w / 2, rr = r * r;
  if (p.length === 3) return (p[0] - cx) * (p[0] - cx) + (p[1] - cy) * (p[1] - cy) <= rr ? [] : null;
  const out = [];
  let cur = [], cut = false;
  for (let i = 3; i < p.length; i += 3) {
    const x0 = p[i - 3], y0 = p[i - 2], p0 = p[i - 1], dx = p[i] - x0, dy = p[i + 1] - y0, dp = p[i + 2] - p0;
    const ax = x0 - cx, ay = y0 - cy;
    const A = dx * dx + dy * dy, B = ax * dx + ay * dy, C = ax * ax + ay * ay - rr;
    let t0 = 1, t1 = 0;                              // the part of this segment inside the circle
    if (A < 1e-9) { if (C <= 0) { t0 = 0; t1 = 1; } }
    else {
      const D = B * B - A * C;
      if (D > 0) { const q = Math.sqrt(D); t0 = Math.max(0, (-B - q) / A); t1 = Math.min(1, (-B + q) / A); }
    }
    if (t0 >= t1) {                                  // untouched
      if (!cur.length) cur.push(x0, y0, p0);
      cur.push(p[i], p[i + 1], p[i + 2]);
      continue;
    }
    cut = true;
    if (t0 > 0) {
      if (!cur.length) cur.push(x0, y0, p0);
      cur.push(r2(x0 + dx * t0), r2(y0 + dy * t0), r2(p0 + dp * t0));
    }
    if (cur.length) { out.push(cur); cur = []; }
    if (t1 < 1) cur.push(r2(x0 + dx * t1), r2(y0 + dy * t1), r2(p0 + dp * t1), p[i], p[i + 1], p[i + 2]);
  }
  if (!cut) return null;
  if (cur.length) out.push(cur);
  return out.filter((q) => q.length >= 6 && pathLength(q, 3) > 0.25).map((q) => Object.assign({}, s, { p: q }));
}

/* Recognises a straight line { k:'line', ax, ay, bx, by, pr } or a circle / ellipse
   { k:'ell', cx, cy, rx, ry, rot, pr } in the points p, or returns null. */
function recognizeShape(p) {
  const n = p.length / 3;
  if (n < 3) return null;
  const len = pathLength(p, 3);
  if (len < 12) return null;
  // The corrected shape keeps the average pressure it was drawn with, so it stays the same thickness.
  let pr = 0;
  for (let i = 2; i < p.length; i += 3) pr += p[i];
  pr = r2(pr / n);
  const ax = p[0], ay = p[1], bx = p[p.length - 3], by = p[p.length - 2];
  const chord = Math.hypot(bx - ax, by - ay);
  // A line: the ink is nearly as short as the straight path from start to end. 0.8 lets fairly
  // rough lines through; anything that bends a lot or doubles back is not a line.
  if (chord / len > 0.8) return { k: 'line', ax, ay, bx, by, pr };
  if (chord / len < 0.3) {
    const b = ptsBox(p, 3);
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    let rx = (b.x1 - b.x0) / 2, ry = (b.y1 - b.y0) / 2;
    if (rx < 4 || ry < 4) return null;
    let err = 0;
    for (let i = 0; i < p.length; i += 3) err += Math.abs(Math.hypot((p[i] - cx) / rx, (p[i + 1] - cy) / ry) - 1);
    if (err / n > 0.15) return null;
    // Must actually go most of the way round, so a "C" or "U" isn't turned into a circle.
    let turn = 0;
    for (let i = 3; i < p.length; i += 3) {
      let d = Math.atan2(p[i + 1] - cy, p[i] - cx) - Math.atan2(p[i - 2] - cy, p[i - 3] - cx);
      if (d > Math.PI) d -= 2 * Math.PI; else if (d < -Math.PI) d += 2 * Math.PI;
      turn += d;
    }
    if (Math.abs(turn) < Math.PI * 1.6) return null;
    if (Math.abs(rx - ry) / Math.max(rx, ry) < 0.18) rx = ry = (rx + ry) / 2;
    return { k: 'ell', cx, cy, rx, ry, rot: 0, pr };
  }
  return null;
}

function shapePts(sh) {
  if (sh.k === 'line') return [r2(sh.ax), r2(sh.ay), sh.pr, r2(sh.bx), r2(sh.by), sh.pr];
  const out = [], steps = 72, c = Math.cos(sh.rot), s = Math.sin(sh.rot);
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2, x = sh.rx * Math.cos(a), y = sh.ry * Math.sin(a);
    out.push(r2(sh.cx + x * c - y * s), r2(sh.cy + x * s + y * c), sh.pr);
  }
  return out;
}

/* Returns corrected points for a straight line or circle/ellipse, or null. */
function recognize(p) {
  const sh = recognizeShape(p);
  return sh ? shapePts(sh) : null;
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

/* ---------- text boxes and pictures ---------- */

const TEXT_FONT = 'Helvetica, Arial, sans-serif', TEXT_LH = 1.3, TEXT_PAD = 3;
let measureCtx = null;
const layoutCache = new WeakMap();

function wrapPara(ctx, para, max, out) {
  let line = '';
  for (let tok of para.match(/\S+|\s+/g) || []) {
    if (/^\s/.test(tok)) { if (line) line += tok.replace(/\t/g, '    '); continue; }
    if (ctx.measureText(line + tok).width <= max) { line += tok; continue; }
    if (line.trim()) { out.push(line.trimEnd()); line = ''; }
    while (tok.length > 1 && ctx.measureText(tok).width > max) {     // a word wider than the box
      let n = tok.length - 1;
      while (n > 1 && ctx.measureText(tok.slice(0, n)).width > max) n--;
      out.push(tok.slice(0, n)); tok = tok.slice(n);
    }
    line = tok;
  }
  out.push(line.trimEnd());
}

/* Lines of a text box, wrapped to its width, and the box height. */
function textLayout(it) {
  let L = layoutCache.get(it);
  if (L) return L;
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = `${it.size}px ${TEXT_FONT}`;
  const lines = [];
  for (const para of it.text.split('\n')) wrapPara(measureCtx, para, Math.max(1, it.w - 2 * TEXT_PAD), lines);
  L = { lines, h: 2 * TEXT_PAD + lines.length * it.size * TEXT_LH };
  layoutCache.set(it, L);
  return L;
}

const itemH = (it) => (it.k === 'text' ? textLayout(it).h : it.h);

/* Maps a point given in the item's unrotated frame onto the page. */
function itemPt(it, x, y) {
  const h = itemH(it), cx = it.x + it.w / 2, cy = it.y + h / 2;
  if (!it.rot) return [x, y];
  const c = Math.cos(it.rot), s = Math.sin(it.rot), dx = x - cx, dy = y - cy;
  return [cx + c * dx - s * dy, cy + s * dx + c * dy];
}

function itemBox(it) {
  let b = boxCache.get(it);
  if (!b) {
    const h = itemH(it), pts = [itemPt(it, it.x, it.y), itemPt(it, it.x + it.w, it.y), itemPt(it, it.x + it.w, it.y + h), itemPt(it, it.x, it.y + h)];
    b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const [x, y] of pts) { b.x0 = Math.min(b.x0, x); b.y0 = Math.min(b.y0, y); b.x1 = Math.max(b.x1, x); b.y1 = Math.max(b.y1, y); }
    boxCache.set(it, b);
  }
  return b;
}

const boxOf = (o) => (o.p ? strokeBox(o) : itemBox(o));

function itemCenter(it) { return [it.x + it.w / 2, it.y + itemH(it) / 2]; }

function itemHit(it, x, y, m) {
  const [cx, cy] = itemCenter(it), c = Math.cos(-(it.rot || 0)), s = Math.sin(-(it.rot || 0));
  const dx = x - cx, dy = y - cy, lx = c * dx - s * dy, ly = s * dx + c * dy;
  return Math.abs(lx) <= it.w / 2 + m && Math.abs(ly) <= itemH(it) / 2 + m;
}

function withItemFrame(ctx, it, fn) {
  ctx.save();
  if (it.rot) {
    const [cx, cy] = itemCenter(it);
    ctx.translate(cx, cy); ctx.rotate(it.rot); ctx.translate(-cx, -cy);
  }
  fn();
  ctx.restore();
}

function drawText(ctx, it) {
  const L = textLayout(it);
  withItemFrame(ctx, it, () => {
    ctx.font = `${it.size}px ${TEXT_FONT}`; ctx.fillStyle = it.c; ctx.textBaseline = 'alphabetic';
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    L.lines.forEach((ln, i) => { if (ln) ctx.fillText(ln, it.x + TEXT_PAD, it.y + TEXT_PAD + it.size * (i * TEXT_LH + 1)); });
  });
}

/* img: a decoded image, or null while loading / if the file is missing (a grey box shows instead). */
function drawPicture(ctx, it, img) {
  withItemFrame(ctx, it, () => {
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    if (img) { ctx.drawImage(img, it.x, it.y, it.w, it.h); return; }
    ctx.fillStyle = '#ececef'; ctx.fillRect(it.x, it.y, it.w, it.h);
    ctx.strokeStyle = '#b8b8c0'; ctx.lineWidth = 1; ctx.strokeRect(it.x, it.y, it.w, it.h);
  });
}

/* Moves / scales / rotates an item by the affine matrix M (uniform scale k). */
function transformItem(it, M, k) {
  const [cx, cy] = itemCenter(it), h = itemH(it) * k, w = it.w * k;
  const nx = M[0] * cx + M[2] * cy + M[4], ny = M[1] * cx + M[3] * cy + M[5];
  let rot = (it.rot || 0) + Math.atan2(M[1], M[0]);
  rot = Math.atan2(Math.sin(rot), Math.cos(rot));
  if (Math.abs(rot) < 1e-4) rot = 0;
  const o = Object.assign({}, it, { x: r2(nx - w / 2), y: r2(ny - h / 2), w: r2(w), rot });
  if (it.k === 'text') o.size = r2(it.size * k); else o.h = r2(h);
  return o;
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

/* PDF string in the standard WinAnsi encoding (Western European characters; anything else becomes ?). */
const WIN = { 0x20ac: 0x80, 0x2026: 0x85, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x2122: 0x99 };
function pdfText(str) {
  let o = '(';
  for (const ch of str) {
    let c = ch.codePointAt(0);
    if (c === 9) c = 32;
    if (c === 40 || c === 41 || c === 92) o += '\\' + ch;
    else if (c >= 32 && c < 127) o += ch;
    else {
      c = c >= 160 && c <= 255 ? c : WIN[c] || 63;
      o += '\\' + c.toString(8).padStart(3, '0');
    }
  }
  return o + ')';
}

/* bg: the imported PDF page as an image ({ fit }) or null; pics: Map picture src -> XObject name. */
function pdfPage(nb, page, bg, pics) {
  const o = [], paper = PAPERS[nb.paper] || PAPERS.white, g = templateGeom(nb, page), items = page.items || [];
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
  if (bg) {                                                   // imported PDF page, drawn upright
    const f = bg.fit;
    o.push(`q ${f2(f.w)} 0 0 ${f2(-f.h)} ${f2(f.x)} ${f2(f.y + f.h)} cm /Im0 Do Q`);
  }
  for (const it of items) {                                   // pictures (below the ink, like on screen)
    if (it.k !== 'img') continue;
    const c = Math.cos(it.rot || 0), sn = Math.sin(it.rot || 0), [cx, cy] = itemCenter(it), w = it.w, h = it.h;
    const name = pics && pics.get(it.src);
    if (name) {
      o.push(`q ${f2(w * c)} ${f2(w * sn)} ${f2(h * sn)} ${f2(-h * c)} ${f2(cx - (w / 2) * c - (h / 2) * sn)} ${f2(cy - (w / 2) * sn + (h / 2) * c)} cm /${name} Do Q`);
    } else {
      const p = [[it.x, it.y], [it.x + w, it.y], [it.x + w, it.y + h], [it.x, it.y + h]].map(([x, y]) => itemPt(it, x, y));
      o.push(`0.93 0.93 0.94 rg ${f2(p[0][0])} ${f2(p[0][1])} m ${p.slice(1).map((q) => `${f2(q[0])} ${f2(q[1])} l`).join(' ')} h f`);
    }
  }
  for (const it of items) {                                   // text boxes
    if (it.k !== 'text') continue;
    const L = textLayout(it), c = Math.cos(it.rot || 0), sn = Math.sin(it.rot || 0);
    o.push(`BT /F1 ${f2(it.size)} Tf ${hexRgb(it.c)} rg`);
    L.lines.forEach((ln, i) => {
      if (!ln) return;
      const [x, y] = itemPt(it, it.x + TEXT_PAD, it.y + TEXT_PAD + it.size * (i * TEXT_LH + 1));
      o.push(`${f2(c)} ${f2(sn)} ${f2(sn)} ${f2(-c)} ${f2(x)} ${f2(y)} Tm ${pdfText(ln)} Tj`);
    });
    o.push('ET');
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

/* pages: indices to include (default all). bgs: Map index -> { bytes (JPEG), w, h, fit } for pages
   with an imported PDF page behind the ink. pics: Map picture src -> { bytes (JPEG), w, h }. */
async function buildPdf(nb, pages, bgs, pics) {
  const enc = new TextEncoder(), chunks = [], offsets = [];
  let size = 0, next = 1;
  const put = (d) => { const b = typeof d === 'string' ? enc.encode(d) : d; chunks.push(b); size += b.length; };
  const obj = (id, body) => { offsets[id] = size; put(`${id} 0 obj\n${body}\nendobj\n`); };
  const stream = (id, dict, data) => { offsets[id] = size; put(`${id} 0 obj\n<< ${dict} /Length ${data.length} >>\nstream\n`); put(data); put('\nendstream\nendobj\n'); };
  const jpeg = (id, im) => stream(id, `/Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`, im.bytes);
  const list = pages || nb.pages.map((_, i) => i);
  bgs = bgs || new Map(); pics = pics || new Map();
  const CAT = next++, PAGES = next++, FONT = next++;
  const picIds = new Map(), picNames = new Map();
  for (const src of pics.keys()) { picIds.set(src, next++); picNames.set(src, 'P' + picNames.size); }
  const ids = list.map((i) => ({ page: next++, content: next++, bg: bgs.has(i) ? next++ : 0 }));
  put('%PDF-1.4\n'); put(new Uint8Array([37, 226, 227, 207, 211, 10]));
  obj(CAT, `<< /Type /Catalog /Pages ${PAGES} 0 R >>`);
  obj(PAGES, `<< /Type /Pages /Count ${list.length} /Kids [${ids.map((d) => `${d.page} 0 R`).join(' ')}] >>`);
  obj(FONT, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  for (const [src, im] of pics) jpeg(picIds.get(src), im);
  for (let k = 0; k < list.length; k++) {
    const page = nb.pages[list[k]], d = ids[k], bg = bgs.get(list[k]);
    const used = new Set((page.items || []).filter((it) => it.k === 'img' && picIds.has(it.src)).map((it) => it.src));
    const xo = [];
    if (bg) xo.push(`/Im0 ${d.bg} 0 R`);
    for (const src of used) xo.push(`/${picNames.get(src)} ${picIds.get(src)} 0 R`);
    const raw = enc.encode(pdfPage(nb, page, bg, picNames));
    const packed = await deflate(raw);
    obj(d.page, `<< /Type /Page /Parent ${PAGES} 0 R /MediaBox [0 0 ${f2(nb.w)} ${f2(nb.h)}] ` +
      `/Resources << /ExtGState << /GH << /Type /ExtGState /CA ${HL_ALPHA} /ca ${HL_ALPHA} /BM /Multiply >> >>` +
      ` /Font << /F1 ${FONT} 0 R >>${xo.length ? ` /XObject << ${xo.join(' ')} >>` : ''} >> /Contents ${d.content} 0 R >>`);
    stream(d.content, packed ? '/Filter /FlateDecode' : '', packed || raw);
    if (bg) jpeg(d.bg, bg);
  }
  const count = next - 1, xref = size;
  put(`xref\n0 ${count + 1}\n0000000000 65535 f \n`);
  for (let id = 1; id <= count; id++) put(String(offsets[id]).padStart(10, '0') + ' 00000 n \n');
  put(`trailer\n<< /Size ${count + 1} /Root ${CAT} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
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
  ['lasso', 'lasso', 'Lasso select (tap ink, a picture or text to select it)'],
  ['text', 'type|text-cursor-input|text', 'Add text'],
];

class Editor {
  constructor(parent, host) {
    this.host = host;
    this.prefs = host.prefs;
    if (!TOOLS.some((t) => t[0] === this.prefs.tool)) this.prefs.tool = 'pen';   // the old shape pen
    this.nb = newNotebook(this.prefs);
    this.pageIndex = 0;
    this.scale = 1; this.tx = 0; this.ty = 0; this.ready = false;
    this.act = null;                  // pen / mouse action in progress
    this.touches = new Map();         // fingers currently used for a gesture
    this.gesture = null;
    this.sel = new Set(); this.selBox = null; this.selM = null;   // selM: live move/scale/rotate matrix
    this.undoStack = []; this.redoStack = [];
    this.liveQueued = false; this.resTimer = 0;
    this.rect = { left: 0, top: 0 };
    this.origin = { x: 0, y: 0, k: 1 };  // where the page really is on screen, measured at pen-down
    this.gestureQueued = false;
    this.penUpAt = 0;
    this.pdfDocs = new Map();         // vault path -> Promise<pdf.js document>
    this.bgLow = new Map();           // "path#page" -> low-res render (small LRU)
    this.bgThumb = new Map();         // "path#page" -> thumbnail render
    this.bgHi = null; this.bgPending = null; this.bgToken = 0; this.bgTimer = 0;
    this.ov = null;                   // page overview, when open
    this.bgWaiters = new Map();
    this.imgs = new Map();            // picture src -> { img, failed, url, waiters }
    this.textEd = null;               // text box being typed in
    this.imgRedraw = () => this.renderMain();
    this.liveRedraw = () => this.queueLive();

    this.root = el('div', 'inkbook-root', parent);
    this.root.tabIndex = -1;
    this.toolbar = el('div', 'inkbook-toolbar', this.root);
    this.stage = el('div', 'inkbook-stage', this.root);
    // viewEl carries page-turn slides; pageEl is the paper itself (shadow, colour, true position);
    // the canvases cover the visible area and are drawn at the screen's real pixel density.
    this.viewEl = el('div', 'inkbook-view', this.stage);
    this.pageEl = el('div', 'inkbook-page', this.viewEl);
    this.main = el('canvas', 'inkbook-layer', this.viewEl);
    this.live = el('canvas', 'inkbook-layer', this.viewEl);
    this.rv = null;                   // the view the canvases were last drawn for
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
      if (!this.selBar.contains(e.target) && !this.inTextEditor(e.target)) e.preventDefault();
    }, { passive: false });
    // overflow:hidden boxes can still be scrolled by the browser; any scroll would shift the page
    // away from where the pen maths thinks it is.
    st.addEventListener('scroll', () => { st.scrollLeft = 0; st.scrollTop = 0; });
    st.addEventListener('touchmove', (e) => { e.stopPropagation(); e.preventDefault(); }, { passive: false });
    this.root.addEventListener('keydown', (e) => this.onKey(e));
    this.root.addEventListener('paste', (e) => this.onPaste(e));
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(st);
    // If the app is put away mid-stroke the pencil-up may never arrive; start clean when it returns.
    this.onHide = () => { if (document.hidden) this.resetInput(); };
    document.addEventListener('visibilitychange', this.onHide);
    // While the pencil is writing, no other touch anywhere on screen may do anything. A palm resting
    // on the toolbar or on Obsidian's own bars could otherwise start a scroll or swipe there, and
    // iPadOS then cancels every touch in progress — including the pencil, ending the stroke.
    this.guard = (e) => { if (this.act && !this.act.touch && e.cancelable) e.preventDefault(); };
    document.addEventListener('touchstart', this.guard, { passive: false, capture: true });
    document.addEventListener('touchmove', this.guard, { passive: false, capture: true });
  }

  destroy() {
    this.ro.disconnect();
    document.removeEventListener('visibilitychange', this.onHide);
    document.removeEventListener('touchstart', this.guard, true);
    document.removeEventListener('touchmove', this.guard, true);
    this.closeText(true);
    for (const e of this.imgs.values()) if (e.url) URL.revokeObjectURL(e.url);
    this.closeColors();
    this.closeOverview();
    clearTimeout(this.resTimer); clearTimeout(this.bgTimer);
    if (this.bgTask) try { this.bgTask.cancel(); } catch (e) { /* already finished */ }
    for (const d of this.pdfDocs.values()) d.then((doc) => doc.destroy && doc.destroy(), () => {});
    if (this.act && this.act.timer) clearTimeout(this.act.timer);
    this.root.remove();
  }

  get page() { return this.nb.pages[this.pageIndex]; }

  /* pos: where this notebook was last left ({ page, s, tx, ty, cw }) when it is being opened. */
  load(nb, pos) {
    const resized = nb.w !== this.nb.w || nb.h !== this.nb.h;
    this.nb = nb;
    this.closeOverview();
    if (pos) {
      this.pageIndex = clamp(pos.page | 0, 0, nb.pages.length - 1);
      this.pendingView = pos; this.ready = false; this.rv = null;
    } else this.pageIndex = clamp(this.pageIndex, 0, nb.pages.length - 1);
    this.closeText(true);
    this.undoStack = []; this.redoStack = [];
    this.act = null; this.dropSelection();
    if (resized) { this.ready = false; this.rv = null; }
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
    this.btn(g2, 'image-plus|image', 'Insert picture', (e) => this.host.menu([
      { title: 'Photo or file from this device…', icon: 'camera', click: () => this.pickDeviceImage() },
      { title: 'Picture from the vault…', icon: 'image', click: () => this.pickVaultImage() },
    ], e));
    el('div', 'inkbook-spacer', t);
    const g3 = el('div', 'inkbook-group', t);
    this.prevBtn = this.btn(g3, 'chevron-left', 'Previous page', () => this.goTo(this.pageIndex - 1, -1));
    this.pageLabel = el('div', 'inkbook-pagelabel', g3);
    this.pageLabel.addEventListener('click', () => this.openOverview());
    this.nextBtn = this.btn(g3, 'chevron-right', 'Next page', () => this.goTo(this.pageIndex + 1, 1));
    this.markBtn = this.btn(g3, 'bookmark', 'Bookmark this page', () => this.toggleMark(this.page));
    this.btn(g3, 'plus', 'Add page', () => this.addPage());
    this.btn(g3, 'layout-dashboard|layout-grid', 'All pages', () => this.openOverview());
    const g4 = el('div', 'inkbook-group', t);
    this.btn(g4, 'settings|settings-2', 'Settings: page style and pencil options', (e) => this.settingsMenu(e));
    this.btn(g4, 'more-horizontal|more-vertical', 'More', (e) => this.moreMenu(e));
    this.refreshToolbar();
  }

  refreshToolbar() {
    const p = this.prefs, tool = p.tool;
    for (const k in this.toolBtns) this.toolBtns[k].classList.toggle('is-active', k === tool);

    // One swatch showing the current colour; tapping it opens a small popup with the rest.
    this.palette.textContent = '';
    this.closeColors();
    if (tool === 'eraser') {
      // Precise rubs out only the ink under the circle; Stroke removes every stroke it touches.
      for (const [mode, label] of [['precise', 'Precise'], ['stroke', 'Stroke']]) {
        const b = el('button', 'inkbook-seg' + (p.eraserMode === mode ? ' is-active' : ''), this.palette);
        b.textContent = label;
        b.setAttribute('aria-label', mode === 'precise' ? 'Erase only what is under the circle' : 'Erase whole strokes');
        b.addEventListener('click', (e) => { e.preventDefault(); p.eraserMode = mode; this.host.savePrefs(); this.refreshToolbar(); });
      }
    } else {
      const hl = tool === 'highlighter', cur = hl ? p.hlColor : p.penColor;
      const b = this.swatch(this.palette, cur, 'Colour', () => (this.colorPop ? this.closeColors() : this.openColors(b)));
      b.classList.add('is-current');
    }

    this.sizes.textContent = '';
    const key = { highlighter: 'hlSize', eraser: 'eraserSize', lasso: null, text: 'textSize' }[tool];
    if (key !== null) {
      const k = key || 'penSize';
      const list = { hlSize: HL_SIZES, eraserSize: ERASER_SIZES, textSize: TEXT_SIZES, penSize: PEN_SIZES }[k];
      list.forEach((v, i) => {
        const b = el('button', 'inkbook-btn inkbook-size' + (p[k] === v ? ' is-active' : ''), this.sizes);
        if (k === 'textSize') {
          b.setAttribute('aria-label', ['Small text', 'Medium text', 'Large text'][i]);
          const d = el('div', 'inkbook-aa', b);
          d.textContent = 'A'; d.style.fontSize = 11 + i * 4 + 'px';
        } else {
          b.setAttribute('aria-label', ['Thin', 'Medium', 'Thick'][i]);
          const d = el('div', 'inkbook-dot', b);
          d.style.width = d.style.height = 5 + i * 5 + 'px';
        }
        b.addEventListener('click', () => {
          p[k] = v; this.host.savePrefs(); this.refreshToolbar();
          if (k === 'textSize') this.restyleText({ size: v });
        });
      });
    }
    this.refreshState();
  }

  /* Swatches are plain <div>s: themes restyle <button>s (padding, minimum sizes), which squashed
     them into ovals. */
  swatch(parent, color, label, fn) {
    const b = el('div', 'inkbook-swatch', parent);
    b.style.backgroundColor = color;
    b.setAttribute('role', 'button');
    b.setAttribute('aria-label', label);
    b.addEventListener('click', (e) => { e.preventDefault(); fn(); });
    return b;
  }

  openColors(anchor) {
    const p = this.prefs, hl = p.tool === 'highlighter', cur = hl ? p.hlColor : p.penColor;
    const colors = hl ? HL_COLORS : PEN_COLORS;
    const pop = this.colorPop = el('div', 'inkbook-colorpop', this.root);
    for (const c of colors) {
      const b = this.swatch(pop, c, 'Colour', () => this.setColor(c));
      if (c === cur) b.classList.add('is-active');
    }
    // Custom colour: a round rainbow swatch with the (invisible) system colour picker on top of it.
    const wrap = el('div', 'inkbook-swatch inkbook-custom', pop);
    if (!colors.includes(cur)) { wrap.classList.add('is-active'); wrap.style.background = cur; }
    const custom = el('input', '', wrap);
    custom.type = 'color'; custom.value = cur;
    custom.setAttribute('aria-label', 'Custom colour');
    custom.addEventListener('change', () => this.setColor(custom.value));
    const r = anchor.getBoundingClientRect(), rr = this.root.getBoundingClientRect();
    pop.style.top = r.bottom - rr.top + 6 + 'px';
    pop.style.left = clamp(r.left - rr.left - 8, 4, Math.max(4, rr.width - pop.offsetWidth - 4)) + 'px';
    this.popOff = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) this.closeColors(); };
    setTimeout(() => document.addEventListener('pointerdown', this.popOff, true));
  }

  closeColors() {
    if (!this.colorPop) return;
    this.colorPop.remove(); this.colorPop = null;
    document.removeEventListener('pointerdown', this.popOff, true);
  }

  refreshState() {
    this.undoBtn.disabled = !this.undoStack.length;
    this.redoBtn.disabled = !this.redoStack.length;
    this.pasteBtn.style.display = this.host.getClipboard() ? '' : 'none';
    this.prevBtn.disabled = this.pageIndex === 0;
    this.nextBtn.disabled = this.pageIndex >= this.nb.pages.length - 1;
    this.pageLabel.textContent = `${this.pageIndex + 1} / ${this.nb.pages.length}`;
    const marked = !!this.page.mark;
    this.markBtn.classList.toggle('is-marked', marked);
    this.markBtn.setAttribute('aria-label', marked ? 'Remove bookmark from this page' : 'Bookmark this page');
  }

  /* Bookmarks mark pages; they show as red ribbons in All pages, which can list only them. */
  toggleMark(page) {
    if (page.mark) delete page.mark; else page.mark = true;
    this.changed();
    if (page === this.page && page.mark && !this.ov) this.host.notice('Page bookmarked — All pages shows it with a red ribbon');
  }

  setTool(tool) {
    this.closeText();
    if (tool !== 'lasso') this.clearSelection();
    this.prefs.tool = tool;
    this.host.savePrefs();
    this.refreshToolbar();
  }

  setColor(c) {
    if (this.sel.size) {
      this.pushHistory();
      this.transformSel((s) => (s.k === 'img' ? s : Object.assign({}, s, { c })));
      this.queueLive(); this.changed();
    }
    this.restyleText({ c });
    this.prefs[this.prefs.tool === 'highlighter' ? 'hlColor' : 'penColor'] = c;
    this.host.savePrefs();
    this.refreshToolbar();
  }

  /* Gear button: everything that is a setting — how the page looks and how the pencil behaves. */
  settingsMenu(evt) {
    const nb = this.nb, page = this.page, p = this.prefs, items = [];
    const toggle = (key, title) => ({ title, checked: !!p[key], click: () => { p[key] = !p[key]; this.host.savePrefs(); } });
    for (const k in TEMPLATES) items.push({ title: TEMPLATES[k] + ' page', checked: page.tpl === k, click: () => { page.tpl = k; this.renderMain(); this.changed(); } });
    items.push({ title: 'Use this style on all pages', click: () => { for (const q of nb.pages) q.tpl = page.tpl; this.changed(); } });
    items.push('-');
    for (const [v, title] of SPACINGS) items.push({ title: 'Grid: ' + title.toLowerCase(), checked: Math.abs(nb.spacing - v) < 0.1, click: () => { nb.spacing = v; this.renderMain(); this.changed(); } });
    items.push('-');
    items.push({ title: 'White paper', checked: nb.paper === 'white', click: () => { nb.paper = 'white'; this.renderMain(); this.changed(); } });
    items.push({ title: 'Cream paper', checked: nb.paper === 'cream', click: () => { nb.paper = 'cream'; this.renderMain(); this.changed(); } });
    items.push('-');
    items.push(toggle('fingerDraw', 'Draw with finger'), toggle('scribbleErase', 'Scribble to erase'), toggle('holdSnap', 'Hold to straighten lines and circles'));
    this.host.menu(items, evt);
  }

  /* ⋯ button: things you do — export, import, page actions. */
  moreMenu(evt) {
    this.host.menu([
      { title: 'Export notebook as PDF', icon: 'file-down', click: () => this.exportPdf() },
      { title: 'Export some pages as PDF…', icon: 'files', click: () => this.openOverview(true) },
      { title: 'Export this page as PNG', icon: 'image', click: () => this.exportPng() },
      '-',
      { title: 'Import PDF from vault…', icon: 'file-input', click: () => this.pickVaultPdf() },
      { title: 'Import PDF from device…', icon: 'upload', click: () => this.pickDevicePdf() },
      '-',
      { title: 'Insert picture from device…', icon: 'image-plus', click: () => this.pickDeviceImage() },
      { title: 'Insert picture from vault…', icon: 'image', click: () => this.pickVaultImage() },
      '-',
      { title: 'Zoom to fit', icon: 'maximize', click: () => { this.fit(); this.applyTransform(); this.render(); } },
      { title: 'Clear page', icon: 'eraser', click: () => this.clearPage() },
      { title: 'Delete page', icon: 'trash-2', click: () => this.deletePage() },
    ], evt);
  }

  /* ---------------- view transform ---------------- */

  layout() {
    const cw = this.stage.clientWidth, ch = this.stage.clientHeight;
    if (!cw || !ch) return;
    this.pageEl.style.width = this.nb.w + 'px';
    this.pageEl.style.height = this.nb.h + 'px';
    if (!this.ready) {
      this.ready = true; this.fit();
      // Same zoom and scroll as last time — unless the window is now a different width.
      const v = this.pendingView;
      this.pendingView = null;
      if (v && v.s > 0 && Math.abs((v.cw || 0) - cw) < 40) { this.scale = v.s; this.tx = v.tx; this.ty = v.ty; }
    }
    this.clampPan(); this.applyTransform(); this.render();
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

  /* Slide offset for page turns (applied to the whole view, paper and ink together). */
  slideCss(extra) {
    return extra ? `translateX(${extra}px)` : 'none';
  }

  /* The paper moves to the new view at once; the ink canvases, drawn for an earlier view, are
     stretched to match by CSS until render() redraws them sharply for the new view. */
  applyTransform(extra) {
    this.viewEl.style.transform = this.slideCss(extra);
    this.pageEl.style.transform = `translate(${this.tx}px,${this.ty}px) scale(${this.scale})`;
    const v = this.rv;
    if (v) {
      const k = this.scale / v.s;
      const t = `translate(${this.tx - v.tx * k}px,${this.ty - v.ty * k}px) scale(${k})`;
      this.main.style.transform = this.live.style.transform = t;
    }
    this.placeSelBar(); this.placeText();
    if (v && (v.s !== this.scale || v.tx !== this.tx || v.ty !== this.ty)) this.renderSoon();
  }

  zoomAt(cx, cy, s) {
    const cw = this.stage.clientWidth, ch = this.stage.clientHeight;
    const min = Math.min((cw - 24) / this.nb.w, (ch - 24) / this.nb.h) * 0.8;
    s = clamp(s, min, 8);
    const px = (cx - this.tx) / this.scale, py = (cy - this.ty) / this.scale;
    this.scale = s; this.tx = cx - px * s; this.ty = cy - py * s;
    this.clampPan(); this.applyTransform();
  }

  /* Redraw sharply once panning / zooming pauses. */
  renderSoon() {
    clearTimeout(this.resTimer);
    this.resTimer = setTimeout(() => { if (this.act) this.renderSoon(); else this.render(); }, 90);
  }

  /* Sizes the canvases to the visible area (plus a margin so a short pan shows ink straight away)
     at device pixel density, and draws everything for the current view. */
  render() {
    clearTimeout(this.resTimer);
    const cw = this.stage.clientWidth, ch = this.stage.clientHeight;
    if (!cw || !ch) return;
    const mx = Math.round(cw * 0.15), my = Math.round(ch * 0.15);
    const W = cw + 2 * mx, H = ch + 2 * my;
    const k = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_CANVAS_PX / (W * H)));
    const pw = Math.round(W * k), ph = Math.round(H * k);
    for (const c of [this.main, this.live]) {
      if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
      c.style.left = -mx + 'px'; c.style.top = -my + 'px';
      c.style.width = W + 'px'; c.style.height = H + 'px';
      c.style.transformOrigin = `${mx}px ${my}px`;
      c.style.transform = 'none';
    }
    this.rv = { tx: this.tx, ty: this.ty, s: this.scale, k: pw / W, mx, my };
    this.renderMain(); this.paintLive();
    if (this.host.setPos) this.host.setPos({ page: this.pageIndex, s: this.scale, tx: Math.round(this.tx), ty: Math.round(this.ty), cw });
  }

  ctxOf(canvas) {
    const ctx = canvas.getContext('2d'), v = this.rv, f = v.k * v.s;
    ctx.setTransform(f, 0, 0, f, v.k * (v.mx + v.tx), v.k * (v.my + v.ty));
    return ctx;
  }

  /* ---------------- painting ---------------- */

  renderMain() {
    if (!this.rv) return;
    const nb = this.nb, page = this.page;
    this.pageEl.style.background = (PAPERS[nb.paper] || PAPERS.white).bg;
    const raw = this.main.getContext('2d');
    raw.setTransform(1, 0, 0, 1, 0, 0);
    raw.clearRect(0, 0, this.main.width, this.main.height);
    const ctx = this.ctxOf(this.main);
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, nb.w, nb.h); ctx.clip();
    drawTemplate(ctx, nb, page);
    if (page.bg) this.drawBg(ctx, page.bg);
    const v = this.rv, W = this.main.width / v.k, H = this.main.height / v.k;   // skip off-screen ink
    const x0 = (-v.mx - v.tx) / v.s, y0 = (-v.my - v.ty) / v.s, x1 = x0 + W / v.s, y1 = y0 + H / v.s;
    const ed = this.textEd && this.textEd.orig;
    this.drawContent(ctx, page, (o) => this.sel.has(o) || o === ed, [x0, y0, x1, y1], this.imgRedraw);
    ctx.restore();
  }

  /* Pictures, then text boxes, then ink — so you can write on top of both. skip(o) leaves
     something out; view [x0, y0, x1, y1] skips what is off screen; onImg runs once a picture
     that was still loading is ready. */
  drawContent(ctx, page, skip, view, onImg) {
    const vis = (o) => {
      if (skip && skip(o)) return false;
      if (!view) return true;
      const b = boxOf(o);
      return !(b.x1 < view[0] || b.x0 > view[2] || b.y1 < view[1] || b.y0 > view[3]);
    };
    const items = page.items || [];
    for (const it of items) if (it.k === 'img' && vis(it)) drawPicture(ctx, it, this.image(it.src, onImg));
    for (const it of items) if (it.k === 'text' && vis(it)) drawText(ctx, it);
    for (const s of page.strokes) if (vis(s)) drawStroke(ctx, s);
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
    if (!this.rv) return;
    const a = this.act;
    if (a && a.type === 'stroke') return this.paintLiveStroke(a);
    this.clearLive();
    const ctx = this.ctxOf(this.live), px = 1 / this.rv.s;
    if (this.sel.size && this.selBox) {
      const M = this.selM;
      ctx.save();
      if (M) ctx.transform(M[0], M[1], M[2], M[3], M[4], M[5]);
      this.drawContent(ctx, this.page, (o) => !this.sel.has(o), null, this.liveRedraw);
      ctx.restore();
      // Frame and handles are drawn untransformed so they keep a constant on-screen size.
      const f = this.selFrame(), c = f.corners;
      ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 1.2 * px; ctx.setLineDash([5 * px, 4 * px]);
      ctx.beginPath(); ctx.moveTo(c[0][0], c[0][1]);
      for (let i = 1; i < 4; i++) ctx.lineTo(c[i][0], c[i][1]);
      ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(f.top[0], f.top[1]); ctx.lineTo(f.rot[0], f.rot[1]); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.lineWidth = 1.5 * px;
      for (const q of c.concat([f.rot])) {
        ctx.beginPath(); ctx.arc(q[0], q[1], 6 * px, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
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
    const b = ptsBox(p, 3), m = s.w * 2 + 2 / (this.rv.k * this.rv.s);
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
    if (this.viewEl.getAnimations) for (const an of this.viewEl.getAnimations()) an.finish();
    const v = this.rv;
    if (!v || v.s !== this.scale || v.tx !== this.tx || v.ty !== this.ty) this.render();   // sharp before writing
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
    if (this.selBar.contains(e.target) || this.inTextEditor(e.target)) return;
    this.rect = this.stage.getBoundingClientRect();
    // Pencil or mouse down elsewhere finishes typing; fingers just scroll and zoom around it.
    this.wasTyping = !!this.textEd && e.pointerType !== 'touch';
    if (this.wasTyping) this.closeText();
    if (!this.textEd) this.root.focus({ preventScroll: true });
    try { this.stage.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }

    if (e.pointerType === 'touch') {
      // The first finger of a new touch means every finger we still remember has really gone
      // (iOS sometimes never reports a palm lifting); forget them so they can't act as a phantom
      // second finger.
      if (e.isPrimary && this.touches.size) {
        if (this.act && this.act.touch) this.endAct();
        this.touches.clear(); this.endGesture(true);
      }
      if (this.act && !this.act.touch) return;              // pencil is down: this is a resting palm
      // A hand landing right after the pencil lifts is a palm, not a scroll.
      if (!this.touches.size && performance.now() - this.penUpAt < 500) return;
      this.touches.set(e.pointerId, { x: e.clientX - this.rect.left, y: e.clientY - this.rect.top });
      if (this.prefs.fingerDraw && this.touches.size === 1 && !this.act) { this.measureOrigin(); this.beginAct(e); return; }
      if (this.act) this.cancelAct();                       // second finger: stop drawing, start pinch
      this.beginGesture(this.gesture && this.gesture.pinched);
      return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // The pencil is touching down, so whatever was in progress is over. (If a pencil-up was lost
    // this used to leave the editor waiting for it forever, ignoring every new stroke.)
    if (this.act) this.endAct();
    e.preventDefault();
    if (this.gesture) {                                     // pencil wins over any finger gesture
      const g = this.gesture;
      this.endGesture(true);
      // Fingers still down when the pencil lands are the writing hand: undo any scroll or zoom
      // they caused on the way down.
      if (performance.now() - g.t0 < 1500) {
        this.scale = g.v0.scale; this.tx = g.v0.tx; this.ty = g.v0.ty;
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

  /* Drops every pointer we are tracking (finishing a stroke in progress). */
  resetInput() {
    if (this.act) this.endAct();
    this.touches.clear();
    this.endGesture(true);
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
    if (this.inTextEditor(e.target)) return;
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    let done = true;
    if (mod && k === 'z') e.shiftKey ? this.redo() : this.undo();
    else if (mod && k === 'y') this.redo();
    else if (mod && k === 'v') {
      // Let the browser's paste event come through (it may carry a PDF); fall back to ink paste.
      this.pasteSeen = false;
      setTimeout(() => { if (!this.pasteSeen) this.paste(); }, 80);
      return;
    }
    else if (this.sel.size && mod && k === 'c') this.copySel();
    else if (this.sel.size && mod && k === 'x') { this.copySel(); this.deleteSel(); }
    else if (this.sel.size && (k === 'delete' || k === 'backspace')) this.deleteSel();
    else done = false;
    if (done) { e.preventDefault(); e.stopPropagation(); }
  }

  onPaste(e) {
    this.pasteSeen = true;
    if (this.inTextEditor(e.target)) return;                // ordinary text paste into a text box
    const files = e.clipboardData ? Array.from(e.clipboardData.files || []) : [];
    const pdf = files.find((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name || ''));
    const pic = files.find((f) => /^image\//.test(f.type));
    e.preventDefault();
    if (pdf) this.importPdfFile(pdf);
    else if (pic) this.insertImageFile(pic);
    else this.paste();
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
      armed: false,
      t0: old ? old.t0 : performance.now(),
      v0: old ? old.v0 : { scale: this.scale, tx: this.tx, ty: this.ty },   // view before any finger moved it
    };
  }

  moveGesture() {
    const g = this.gesture, c = this.centroid();
    if (g.mode === 'pinch') {
      if (g.d < 1) return;
      // Two contacts that barely move are a resting hand, not a pinch.
      if (!g.armed) {
        if (Math.abs(c.d - g.d) < 8 && Math.hypot(c.x - g.cx, c.y - g.cy) < 8) return;
        g.armed = true; g.cx = c.x; g.cy = c.y; g.d = c.d;
        return;
      }
      const cw = this.stage.clientWidth, ch = this.stage.clientHeight;
      const min = Math.min((cw - 24) / this.nb.w, (ch - 24) / this.nb.h) * 0.8;
      const s = clamp(g.scale * (c.d / g.d), min, 8);
      this.scale = s;
      this.tx = c.x - ((g.cx - g.tx) / g.scale) * s;
      this.ty = c.y - ((g.cy - g.ty) / g.scale) * s;
      this.clampPan(); this.applyTransform();
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
      if (this.viewEl.animate) this.viewEl.animate([{ transform: this.slideCss(g.swipe) }, { transform: 'none' }], { duration: 140, easing: 'ease-out' });
    }
  }

  /* ---------------- pencil actions ---------------- */

  beginAct(e) {
    const [x, y] = this.toPage(e), p = this.prefs, id = e.pointerId, touch = e.pointerType === 'touch';
    let tool = p.tool;
    if (e.pointerType === 'pen' && ((e.buttons & 32) || e.button === 5)) tool = 'eraser';   // pencil eraser end / button
    if (tool === 'text') {
      this.act = { type: 'tap', id, touch, x0: x, y0: y, moved: false, typing: this.wasTyping };
    } else if (tool === 'eraser') {
      this.clearSelection();
      this.act = { type: 'erase', id, touch, x, y, changed: false };
      this.eraseAlong(x, y, x, y);
      this.queueLive();
    } else if (tool === 'lasso') {
      const h = this.sel.size ? this.selHandleAt(x, y) : null;
      if (h !== null || (this.sel.size && this.inSelBox(x, y))) {
        this.startTransform(h, x, y, id, touch);
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

  /* Moves (h null), resizes (h = corner 0-3) or turns (h = 'rot') the selection. */
  startTransform(h, x, y, id, touch) {
    const b = this.selBox, f = this.selFrame();
    const act = { type: 'move', id, touch, x0: x, y0: y };
    if (h === 'rot') {
      Object.assign(act, { type: 'rotate', cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2 });
      act.a0 = Math.atan2(y - act.cy, x - act.cx);
    } else if (h !== null && h !== undefined) {
      const fx = f.corners[(h + 2) % 4], cx = f.corners[h];  // scale about the opposite corner
      Object.assign(act, { type: 'scale', fx: fx[0], fy: fx[1], vx: cx[0] - fx[0], vy: cx[1] - fx[1] });
    }
    this.act = act;
    this.selBar.style.display = 'none';
  }

  moveAct(e) {
    const a = this.act;
    if (a.type === 'stroke') {
      const co = e.getCoalescedEvents ? e.getCoalescedEvents() : null;   // full-rate pencil samples
      const list = co && co.length ? co : [e];
      for (const ev of list) { const [x, y] = this.toPage(ev); this.addPoint(a, x, y, this.pressure(ev)); }
    } else {
      const [x, y] = this.toPage(e);
      if (a.type === 'tap') { if (Math.hypot(x - a.x0, y - a.y0) > 8 / this.scale) a.moved = true; }
      else if (a.type === 'erase') { this.eraseAlong(a.x, a.y, x, y); a.x = x; a.y = y; }
      else if (a.type === 'lasso') a.pts.push(x, y);
      else if (a.type === 'move') this.selM = [1, 0, 0, 1, x - a.x0, y - a.y0];
      else if (a.type === 'scale') {
        const l2 = a.vx * a.vx + a.vy * a.vy;
        const k = Math.max(0.05, ((x - a.fx) * a.vx + (y - a.fy) * a.vy) / (l2 || 1));
        this.selM = [k, 0, 0, k, a.fx - k * a.fx, a.fy - k * a.fy];
      } else if (a.type === 'rotate') {
        let t = Math.atan2(y - a.cy, x - a.cx) - a.a0;
        const q = Math.PI / 2, near = Math.round(t / q) * q;   // click to 0 / 90 / 180 / 270 degrees
        if (Math.abs(t - near) < 0.07) t = near;
        const c = Math.cos(t), s = Math.sin(t);
        this.selM = [c, s, -s, c, a.cx - c * a.cx + s * a.cy, a.cy - s * a.cx - c * a.cy];
      }
    }
    this.queueLive();
  }

  addPoint(a, x, y, pr) {
    a.rx = x; a.ry = y;
    const sh = a.shape;
    if (sh) {
      // Still holding after the snap: the pen drags a line's end point, or resizes (and turns) a
      // circle / ellipse around its centre.
      if (sh.k === 'line') { sh.bx = x; sh.by = y; }
      else {
        const b = a.base, k = Math.max(0.05, Math.hypot(x - b.cx, y - b.cy) / a.d0);
        sh.rx = b.rx * k; sh.ry = b.ry * k;
        if (b.rx !== b.ry) sh.rot = b.rot + Math.atan2(y - b.cy, x - b.cx) - a.a0;
      }
      a.snapped = shapePts(sh);
      return;
    }
    if (Math.hypot(x - a.ax, y - a.ay) > 8 / this.scale) { a.ax = x; a.ay = y; this.armHold(a); }
    const k = 1 - clamp(this.prefs.stabilize, 0, 0.9);  // stabiliser: ink trails the pen slightly
    a.sx += (x - a.sx) * k; a.sy += (y - a.sy) * k; a.sp += (pr - a.sp) * k;
    const p = a.s.p, n = p.length;
    if (Math.hypot(a.sx - p[n - 3], a.sy - p[n - 2]) < 0.4) return;
    p.push(r2(a.sx), r2(a.sy), r2(a.sp));
  }

  armHold(a) {
    clearTimeout(a.timer);
    if (!this.prefs.holdSnap) return;
    a.timer = setTimeout(() => {
      if (this.act !== a || a.shape) return;
      const sh = recognizeShape(a.s.p.concat([r2(a.rx), r2(a.ry), r2(a.sp)]));
      if (!sh) return;
      a.shape = sh; a.snapped = shapePts(sh); a.base = Object.assign({}, sh);
      if (sh.k === 'ell') {
        a.d0 = Math.max(4, Math.hypot(a.rx - sh.cx, a.ry - sh.cy));
        a.a0 = Math.atan2(a.ry - sh.cy, a.rx - sh.cx);
      }
      this.queueLive();
    }, 200);
  }

  cancelAct() {
    const a = this.act;
    this.act = null;
    if (!a) return;
    clearTimeout(a.timer);
    if (a.type === 'move' || a.type === 'scale' || a.type === 'rotate') { this.selM = null; this.placeSelBar(); }
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
      if (!snapped && a.tool === 'pen' && this.prefs.scribbleErase && isScribble(p)) {
        const hit = new Set(page.strokes.filter((s) => scribbleHits(p, s)));
        if (hit.size) {
          this.pushHistory();
          page.strokes = page.strokes.filter((s) => !hit.has(s));
          this.clearLive(); this.renderMain(); this.changed();
          return;
        }
      }
      a.s.p = snapped || simplify(a.s);
      this.pushHistory();
      page.strokes.push(a.s);
      drawStroke(this.ctxOf(this.main), a.s);
      this.clearLive(); this.changed();
      return;
    }
    if (a.type === 'tap') {
      if (!a.moved && !a.typing) this.textAt(a.x0, a.y0);
    } else if (a.type === 'erase') {
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
        for (const it of page.items || []) { const [cx, cy] = itemCenter(it); if (inPolygon(cx, cy, poly)) set.add(it); }
        if (set.size) this.select(set);
      } else {
        const hit = this.objectAt(poly[0], poly[1]);              // a tap selects what is under it
        if (hit) this.select(new Set([hit]));
      }
    } else if (a.type === 'move' || a.type === 'scale' || a.type === 'rotate') {
      const M = this.selM;
      this.selM = null;
      if (M && (M[0] !== 1 || M[1] !== 0 || M[2] !== 0 || M[3] !== 1 || M[4] || M[5])) {
        const k = Math.sqrt(Math.abs(M[0] * M[3] - M[1] * M[2]));   // resizing scales line width too
        this.pushHistory();
        this.transformSel((s) => {
          if (!s.p) return transformItem(s, M, k);
          const q = s.p.slice();
          for (let i = 0; i < q.length; i += 3) {
            const x = q[i], y = q[i + 1];
            q[i] = r2(M[0] * x + M[2] * y + M[4]); q[i + 1] = r2(M[1] * x + M[3] * y + M[5]);
          }
          return Object.assign({}, s, { p: q, w: Math.max(0.2, r2(s.w * k)) });
        });
        this.changed();
      }
      this.placeSelBar();
    }
    this.queueLive();
  }

  eraseAlong(x0, y0, x1, y1) {
    const a = this.act, page = this.page, size = this.prefs.eraserSize, len = Math.hypot(x1 - x0, y1 - y0);
    let next = null;
    if (this.prefs.eraserMode !== 'stroke') {
      // Precise: stamp the eraser circle along its path, cutting out whatever lies under it.
      const R = size / 2, steps = Math.max(1, Math.ceil(len / Math.max(R * 0.5, 0.5)));
      let list = page.strokes;
      for (let k = 0; k <= steps; k++) {
        const t = k / steps, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
        let out = null;
        for (let i = 0; i < list.length; i++) {
          const parts = cutStroke(list[i], x, y, R);
          if (parts) { if (!out) out = list.slice(0, i); for (const q of parts) out.push(q); }
          else if (out) out.push(list[i]);
        }
        if (out) next = list = out;
      }
    } else {
      // Whole strokes: only the inner part of the circle counts, so it has to really pass over the ink.
      const r = size * 0.3, steps = Math.max(1, Math.ceil(len / Math.max(r, 1)));
      let hit = null;
      for (const s of page.strokes) {
        for (let k = 0; k <= steps; k++) {
          const t = k / steps;
          if (strokeNear(s, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r)) { (hit || (hit = new Set())).add(s); break; }
        }
      }
      if (hit) next = page.strokes.filter((s) => !hit.has(s));
    }
    if (!next) return;
    if (!a.changed) { this.pushHistory(); a.changed = true; }
    page.strokes = next;
    this.renderMain();
  }

  /* ---------------- selection (lasso) ---------------- */

  buildSelBar() {
    this.selBar.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.editBtn = this.btn(this.selBar, 'pencil-line|type', 'Edit text', () => {
      const it = [...this.sel][0];
      this.clearSelection(); this.openText(it);
    });
    this.btn(this.selBar, 'copy', 'Copy', () => { this.copySel(); this.host.notice('Copied — paste on any page or notebook'); });
    this.btn(this.selBar, 'scissors', 'Cut', () => { this.copySel(); this.deleteSel(); });
    this.btn(this.selBar, 'copy-plus|files', 'Duplicate', () => this.pasteStrokes(this.selObjects(), 14, 14));
    this.btn(this.selBar, 'trash-2|trash', 'Delete', () => this.deleteSel());
  }

  selObjects() {
    const pick = (o) => this.sel.has(o);
    return (this.page.items || []).filter(pick).concat(this.page.strokes.filter(pick));
  }

  /* What a lasso tap at (x, y) selects, top layer first: ink, then text, then pictures. */
  objectAt(x, y) {
    const items = this.page.items || [], strokes = this.page.strokes, m = 6 / this.scale;
    for (let i = strokes.length - 1; i >= 0; i--) if (strokeNear(strokes[i], x, y, m)) return strokes[i];
    for (let i = items.length - 1; i >= 0; i--) if (items[i].k === 'text' && itemHit(items[i], x, y, m)) return items[i];
    for (let i = items.length - 1; i >= 0; i--) if (items[i].k === 'img' && itemHit(items[i], x, y, 0)) return items[i];
    return null;
  }

  computeSelBox() {
    let b = null;
    for (const s of this.sel) {
      const q = boxOf(s);
      b = b ? { x0: Math.min(b.x0, q.x0), y0: Math.min(b.y0, q.y0), x1: Math.max(b.x1, q.x1), y1: Math.max(b.y1, q.y1) } : Object.assign({}, q);
    }
    this.selBox = b;
  }

  /* Selection frame in page coordinates (with any drag in progress applied): corners in the order
     top-left, top-right, bottom-right, bottom-left; `top` is the top-edge midpoint, `rot` the
     rotate handle above it. */
  selFrame() {
    const b = this.selBox, M = this.selM || [1, 0, 0, 1, 0, 0], pad = 6 / this.scale;
    const tf = (x, y) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];
    const x0 = b.x0 - pad, y0 = b.y0 - pad, x1 = b.x1 + pad, y1 = b.y1 + pad;
    const corners = [tf(x0, y0), tf(x1, y0), tf(x1, y1), tf(x0, y1)];
    const top = tf((x0 + x1) / 2, y0), bot = tf((x0 + x1) / 2, y1);
    const ux = top[0] - bot[0], uy = top[1] - bot[1], ul = Math.hypot(ux, uy) || 1, d = 26 / this.scale;
    return { corners, top, rot: [top[0] + (ux / ul) * d, top[1] + (uy / ul) * d] };
  }

  /* 0-3 for a corner (resize), 'rot' for the rotate handle, or null. */
  selHandleAt(x, y) {
    if (!this.selBox) return null;
    const f = this.selFrame(), r = 18 / this.scale;
    if (Math.hypot(x - f.rot[0], y - f.rot[1]) < r) return 'rot';
    for (let i = 0; i < 4; i++) if (Math.hypot(x - f.corners[i][0], y - f.corners[i][1]) < r) return i;
    return null;
  }

  inSelBox(x, y) {
    const b = this.selBox, m = 8 / this.scale;
    return !!b && x >= b.x0 - m && x <= b.x1 + m && y >= b.y0 - m && y <= b.y1 + m;
  }

  select(set) {
    this.sel = set; this.selM = null;
    this.computeSelBox();
    this.renderMain(); this.queueLive(); this.placeSelBar();
  }

  dropSelection() {
    this.sel = new Set(); this.selBox = null; this.selM = null;
    this.selBar.style.display = 'none';
  }

  clearSelection() {
    if (!this.sel.size) return;
    this.dropSelection();
    this.renderMain(); this.queueLive();
  }

  transformSel(fn) {
    const next = new Set(), map = (o) => {
      if (!this.sel.has(o)) return o;
      const n = fn(o); next.add(n); return n;
    };
    this.page.strokes = this.page.strokes.map(map);
    if (this.page.items) this.page.items = this.page.items.map(map);
    this.sel = next;
    this.computeSelBox();
  }

  placeSelBar() {
    const bar = this.selBar, b = this.selBox;
    const busy = this.act && (this.act.type === 'move' || this.act.type === 'scale' || this.act.type === 'rotate');
    if (!b || !this.sel.size || busy) { bar.style.display = 'none'; return; }
    bar.style.display = 'flex';
    const one = this.sel.size === 1 ? [...this.sel][0] : null;
    this.editBtn.style.display = one && one.k === 'text' ? '' : 'none';
    const cw = this.stage.clientWidth, ch = this.stage.clientHeight, bw = bar.offsetWidth || 150, bh = bar.offsetHeight || 40;
    const x = this.tx + ((b.x0 + b.x1) / 2) * this.scale - bw / 2;
    // Below the selection (the rotate handle sits above it); above if there is no room below.
    let y = this.ty + b.y1 * this.scale + 18;
    if (y + bh > ch - 6) y = this.ty + b.y0 * this.scale - bh - 44;
    bar.style.left = clamp(x, 6, Math.max(6, cw - bw - 6)) + 'px';
    bar.style.top = clamp(y, 6, Math.max(6, ch - bh - 6)) + 'px';
  }

  copySel() {
    this.host.setClipboard(this.selObjects().map((s) => Object.assign({}, s, s.p ? { p: s.p.slice() } : {})));
    this.refreshState();
  }

  deleteSel() {
    if (!this.sel.size) return;
    this.pushHistory();
    this.page.strokes = this.page.strokes.filter((s) => !this.sel.has(s));
    if (this.page.items) this.page.items = this.page.items.filter((s) => !this.sel.has(s));
    this.dropSelection();
    this.renderMain(); this.queueLive(); this.changed();
  }

  paste() {
    const clip = this.host.getClipboard();
    if (!clip || !clip.length) return;
    // Drop the copy in the middle of what is currently visible.
    let b = null;
    for (const s of clip) { const q = boxOf(s); b = b ? { x0: Math.min(b.x0, q.x0), y0: Math.min(b.y0, q.y0), x1: Math.max(b.x1, q.x1), y1: Math.max(b.y1, q.y1) } : Object.assign({}, q); }
    const vx = clamp((this.stage.clientWidth / 2 - this.tx) / this.scale, 0, this.nb.w);
    const vy = clamp((this.stage.clientHeight / 2 - this.ty) / this.scale, 0, this.nb.h);
    this.pasteStrokes(clip, vx - (b.x0 + b.x1) / 2, vy - (b.y0 + b.y1) / 2);
  }

  /* Pastes strokes and items (text, pictures), shifted by dx, dy, and selects them. */
  pasteStrokes(objs, dx, dy) {
    if (!objs.length) return;
    this.closeText();
    const copies = objs.map((s) => {
      if (!s.p) return Object.assign({}, s, { x: r2(s.x + dx), y: r2(s.y + dy) });
      const q = s.p.slice();
      for (let i = 0; i < q.length; i += 3) { q[i] = r2(q[i] + dx); q[i + 1] = r2(q[i + 1] + dy); }
      return Object.assign({}, s, { p: q });
    });
    this.pushHistory();
    this.sel = new Set();
    const page = this.page;
    page.strokes = page.strokes.concat(copies.filter((c) => c.p));
    const items = copies.filter((c) => !c.p);
    if (items.length) page.items = (page.items || []).concat(items);
    if (this.prefs.tool !== 'lasso') { this.prefs.tool = 'lasso'; this.host.savePrefs(); this.refreshToolbar(); }
    this.select(new Set(copies));
    this.changed();
  }

  /* ---------------- history ---------------- */

  /* Undo entries are snapshots: { page, strokes, items } for what is on one page, or { pages, focus }
     for the list of pages (adding, deleting, moving, importing). Strokes and items are never changed
     in place, so a snapshot is just a copy of the arrays. */
  pushHistory(page = this.page) {
    this.record({ page, strokes: page.strokes.slice(), items: page.items ? page.items.slice() : null });
  }

  pushPages(focus = this.page) { this.record({ pages: this.nb.pages.slice(), focus }); }

  record(h) {
    this.undoStack.push(h);
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
  }

  undo() { this.stepHistory(this.undoStack, this.redoStack); }
  redo() { this.stepHistory(this.redoStack, this.undoStack); }

  stepHistory(from, to) {
    if (this.act) return;
    this.closeText();
    let h;
    while ((h = from.pop())) {
      if (h.pages) {
        to.push({ pages: this.nb.pages.slice(), focus: this.page });
        this.nb.pages = h.pages.slice();
        const i = this.nb.pages.indexOf(h.focus);
        this.showPage(i >= 0 ? i : Math.min(this.pageIndex, this.nb.pages.length - 1), true);
        this.changed();
        return;
      }
      const i = this.nb.pages.indexOf(h.page);
      if (i < 0) continue;                                 // page was deleted since
      to.push({ page: h.page, strokes: h.page.strokes.slice(), items: h.page.items ? h.page.items.slice() : null });
      h.page.strokes = h.strokes;
      if (h.items) h.page.items = h.items; else delete h.page.items;
      this.showPage(i);
      this.changed();
      return;
    }
    this.refreshState();
  }

  showPage(i, force) {
    this.dropSelection();
    if (i !== this.pageIndex) this.goTo(i);
    else if (force) { this.render(); this.clearLive(); }
    else { this.renderMain(); this.paintLive(); }
    if (this.ov) this.buildOverview();
  }

  changed() {
    this.host.changed();
    this.refreshState();
  }

  /* ---------------- pages ---------------- */

  goTo(i, dir) {
    if (i < 0 || i >= this.nb.pages.length || this.act) return;
    this.closeText();
    this.dropSelection();
    this.pageIndex = i;
    this.ty = 12; this.clampPan();
    this.applyTransform();
    this.render(); this.clearLive(); this.refreshState();
    if (dir && this.viewEl.animate) {
      this.viewEl.animate(
        [{ transform: this.slideCss(dir * 90), opacity: 0.3 }, { transform: 'none', opacity: 1 }],
        { duration: 170, easing: 'ease-out' });
    }
  }

  addPage() {
    this.pushPages();
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

  deletePage() {
    this.closeText();
    this.pushPages();
    const pages = this.nb.pages, tpl = this.page.tpl;
    pages.splice(this.pageIndex, 1);
    if (!pages.length) pages.push({ id: uid(), tpl, strokes: [] });
    this.dropSelection();
    this.pageIndex = Math.min(this.pageIndex, pages.length - 1);
    this.render(); this.clearLive(); this.changed();
    this.host.notice('Page deleted — Undo brings it back');
  }

  /* ---------------- imported PDF pages ---------------- */

  bgKey(bg) { return bg.src + '#' + bg.n; }

  pdfDoc(src) {
    let d = this.pdfDocs.get(src);
    if (!d) {
      d = Promise.resolve().then(() => this.host.loadPdf(src));
      this.pdfDocs.set(src, d);
      d.catch(() => this.pdfDocs.delete(src));
    }
    return d;
  }

  /* A PDF page is scaled to fit the notebook page and centred. */
  bgFit(vw, vh) {
    const nb = this.nb, s = Math.min(nb.w / vw, nb.h / vh), w = vw * s, h = vh * s;
    return { x: (nb.w - w) / 2, y: (nb.h - h) / 2, w, h, s };
  }

  /* Renders a whole PDF page at `ppu` pixels per page unit, on white. */
  async bgCanvas(bg, ppu) {
    const doc = await this.pdfDoc(bg.src), pg = await doc.getPage(bg.n);
    const vp1 = pg.getViewport({ scale: 1 }), fit = this.bgFit(vp1.width, vp1.height);
    const vp = pg.getViewport({ scale: fit.s * ppu });
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(vp.width)); c.height = Math.max(1, Math.ceil(vp.height));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await pg.render({ canvasContext: ctx, viewport: vp }).promise;
    return { canvas: c, fit };
  }

  /* Cached render. Returns the render, null while loading (onReady runs once it arrives), or
     {error} if the PDF could not be opened. Keeps at most `limit` renders. */
  bgCached(cache, bg, ppu, limit, onReady) {
    const key = this.bgKey(bg), wkey = key + '@' + ppu;
    if (cache.has(key)) {
      const v = cache.get(key);
      if (v && v.canvas) { cache.delete(key); cache.set(key, v); }   // mark recently used
      else if (v === null && onReady) this.bgWaiters.set(wkey, onReady);
      return v;
    }
    cache.set(key, null);
    if (onReady) this.bgWaiters.set(wkey, onReady);
    this.bgCanvas(bg, ppu).then((r) => {
      cache.set(key, r);
      while (cache.size > limit) {
        const [k, v] = cache.entries().next().value;
        if (v && v.canvas) v.canvas.width = 0;                       // free iOS canvas memory now
        cache.delete(k);
      }
    }, (e) => {
      console.error(e);
      cache.set(key, { error: e });
      if (!this.bgWarned) { this.bgWarned = true; this.host.notice('Could not open PDF ' + bg.src + ' (' + e.message + ')'); }
    }).then(() => {
      const w = this.bgWaiters.get(wkey);
      if (w) { this.bgWaiters.delete(wkey); w(); }
    });
    return null;
  }

  drawBg(ctx, bg) {
    const hi = this.bgHi;
    if (hi && hi.key === this.bgHiKey(bg)) {
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(hi.canvas, 0, 0); ctx.restore();
      return;
    }
    const low = this.bgCached(this.bgLow, bg, 1.5, 6, () => { if (this.page.bg === bg) this.renderMain(); });
    if (low && low.canvas) { const f = low.fit; ctx.drawImage(low.canvas, f.x, f.y, f.w, f.h); }
    if (!low || low.canvas) this.renderBgHi(bg);
  }

  bgHiKey(bg) {
    const v = this.rv;
    return this.bgKey(bg) + '|' + [v.tx, v.ty, v.s, v.k, v.mx, v.my, this.main.width, this.main.height].join(',');
  }

  /* Renders exactly the visible part of the PDF page at screen resolution, so it stays as sharp as
     the ink at any zoom. Runs in the background; the low-res copy shows meanwhile. */
  renderBgHi(bg) {
    const key = this.bgHiKey(bg);
    if (this.bgPending === key) return;
    this.bgPending = key;
    const token = ++this.bgToken, v = this.rv, W = this.main.width, H = this.main.height;
    if (this.bgTask) { try { this.bgTask.cancel(); } catch (e) { /* already finished */ } this.bgTask = null; }
    clearTimeout(this.bgTimer);
    this.bgTimer = setTimeout(async () => {
      const c = document.createElement('canvas');
      try {
        const doc = await this.pdfDoc(bg.src), pg = await doc.getPage(bg.n);
        if (token !== this.bgToken) return;
        const vp1 = pg.getViewport({ scale: 1 }), fit = this.bgFit(vp1.width, vp1.height);
        const S = v.k * v.s * fit.s;
        const ox = v.k * (v.mx + v.tx + v.s * fit.x), oy = v.k * (v.my + v.ty + v.s * fit.y);
        const vp = pg.getViewport({ scale: S, offsetX: ox, offsetY: oy });
        c.width = W; c.height = H;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(ox, oy, vp1.width * S, vp1.height * S);
        this.bgTask = pg.render({ canvasContext: ctx, viewport: vp });
        await this.bgTask.promise;
        if (token !== this.bgToken) { c.width = 0; return; }
        if (this.bgHi) this.bgHi.canvas.width = 0;
        this.bgHi = { key, canvas: c };
        this.bgPending = null;
        if (this.page.bg === bg && this.rv === v) this.renderMain();
      } catch (e) {
        c.width = 0;
        if (token === this.bgToken) this.bgPending = null;
      }
    }, 50);
  }

  async importPdf(src) {
    try {
      const doc = await this.pdfDoc(src), n = doc.numPages;
      if (!n) throw new Error('the PDF has no pages');
      const pages = this.nb.pages, cur = this.page;
      const fresh = pages.length === 1 && !cur.strokes.length && !cur.bg;   // brand-new notebook: replace its blank page
      const add = [];
      for (let i = 1; i <= n; i++) add.push({ id: uid(), tpl: 'blank', strokes: [], bg: { src, n: i } });
      const at = fresh ? 0 : this.pageIndex + 1;
      this.pushPages();
      pages.splice(at, fresh ? 1 : 0, ...add);
      this.closeOverview();
      this.goTo(at, 1);
      this.changed();
      this.host.notice(`Imported ${n} page${n === 1 ? '' : 's'} from ${src.split('/').pop()}`);
    } catch (e) {
      console.error(e);
      this.host.notice('PDF import failed: ' + e.message);
    }
  }

  async importPdfFile(file) {
    try {
      let name = file.name || 'Pasted.pdf';
      if (!/\.pdf$/i.test(name)) name += '.pdf';
      const src = await this.host.storeFile(name, await file.arrayBuffer());
      await this.importPdf(src);
    } catch (e) { console.error(e); this.host.notice('PDF import failed: ' + e.message); }
  }

  pickDevicePdf() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'application/pdf,.pdf';
    inp.style.display = 'none';
    document.body.appendChild(inp);
    inp.addEventListener('change', () => { if (inp.files && inp.files[0]) this.importPdfFile(inp.files[0]); inp.remove(); });
    inp.click();
  }

  async pickVaultPdf() {
    const src = await this.host.pickPdf();
    if (src) this.importPdf(src);
  }

  /* ---------------- page overview ---------------- */

  openOverview(selecting) {
    this.closeOverview();
    this.closeText();
    this.clearSelection();
    const root = el('div', 'inkbook-overview', this.root);
    const head = el('div', 'inkbook-ovhead', root);
    this.ov = {
      el: root, selecting: !!selecting,
      picked: new Set(selecting ? this.nb.pages.map((_, i) => i) : []),
      title: el('div', 'inkbook-ovtitle', head),
      actions: el('div', 'inkbook-ovactions', head),
      grid: el('div', 'inkbook-ovgrid', root),
      io: null,
    };
    // While a page is being dragged the grid must not scroll under the finger.
    this.ov.grid.addEventListener('touchmove', (e) => { if (this.ov && this.ov.drag && e.cancelable) e.preventDefault(); }, { passive: false });
    this.buildOverview();
  }

  closeOverview() {
    if (!this.ov) return;
    if (this.ov.drag) { cancelAnimationFrame(this.ov.drag.raf); this.ov.drag = null; }
    if (this.ov.io) this.ov.io.disconnect();
    this.ov.el.remove();
    this.ov = null;
  }

  ovButton(text, fn, cls) {
    const b = el('button', 'inkbook-textbtn' + (cls ? ' ' + cls : ''), this.ov.actions);
    b.textContent = text;
    b.addEventListener('click', (e) => { e.preventDefault(); fn(); });
    return b;
  }

  refreshOverviewHead() {
    const ov = this.ov, n = this.nb.pages.length, k = ov.picked.size;
    ov.actions.textContent = '';
    if (ov.selecting) {
      ov.title.textContent = k ? `${k} of ${n} selected` : 'Tap pages to select';
      this.ovButton(k === n ? 'Select none' : 'Select all', () => {
        ov.picked = new Set(k === n ? [] : this.nb.pages.map((_, i) => i));
        this.buildOverview();
      });
      const ex = this.ovButton('Export PDF', () => this.exportPdf([...ov.picked].sort((a, b) => a - b)), 'mod-cta');
      const del = this.ovButton('Delete', () => this.deletePages([...ov.picked]), 'mod-warning');
      ex.disabled = del.disabled = !k;
      this.ovButton('Cancel', () => { ov.selecting = false; ov.picked.clear(); this.buildOverview(); });
    } else {
      const marks = this.nb.pages.filter((p) => p.mark).length;
      if (ov.marked && !marks) ov.marked = false;
      ov.title.textContent = ov.marked ? `${marks} bookmarked page${marks === 1 ? '' : 's'}` : `${n} page${n === 1 ? '' : 's'}`;
      el('span', 'inkbook-ovhint', ov.title).textContent = ov.marked ? '' : n > 1 ? ' · drag the ⠿ handle to move a page' : '';
      const bm = this.ovButton(ov.marked ? 'Show all pages' : `Bookmarks (${marks})`, () => { ov.marked = !ov.marked; this.buildOverview(); }, ov.marked ? 'is-on' : '');
      bm.disabled = !marks && !ov.marked;
      const u = this.ovButton('Undo', () => this.undo());
      u.disabled = !this.undoStack.length;
      this.ovButton('Select', () => { ov.selecting = true; this.buildOverview(); });
      this.ovButton('Done', () => this.closeOverview(), 'mod-cta');
    }
  }

  buildOverview() {
    const ov = this.ov, nb = this.nb;
    this.refreshOverviewHead();
    if (ov.io) ov.io.disconnect();
    ov.grid.textContent = '';
    // Thumbnails are drawn only when scrolled into view, so long notebooks open instantly.
    ov.io = typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver((list) => {
        for (const en of list) if (en.isIntersecting) { ov.io.unobserve(en.target); en.target._draw(); }
      }, { root: ov.grid, rootMargin: '300px' })
      : null;
    const filtered = !!ov.marked && !ov.selecting;
    nb.pages.forEach((page, i) => {
      if (filtered && !page.mark) return;
      const tile = el('div', 'inkbook-tile' + (i === this.pageIndex ? ' is-current' : '') + (ov.picked.has(i) ? ' is-picked' : '') + (page.mark ? ' is-marked' : ''), ov.grid);
      const c = el('canvas', 'inkbook-thumb', tile);
      c.style.aspectRatio = `${nb.w} / ${nb.h}`;
      el('div', 'inkbook-tilenum', tile).textContent = String(i + 1);
      if (ov.selecting) el('div', 'inkbook-check', tile);
      else {
        // Bookmark ribbon: red when the page is bookmarked; tap it to add or remove the bookmark.
        const rib = el('div', 'inkbook-ribbon', tile);
        rib.setAttribute('role', 'button');
        rib.setAttribute('aria-label', page.mark ? 'Remove bookmark' : 'Bookmark this page');
        rib.addEventListener('pointerdown', (e) => e.stopPropagation());
        rib.addEventListener('click', (e) => {
          e.stopPropagation();
          this.toggleMark(page);
          if (filtered) this.buildOverview();
          else { tile.classList.toggle('is-marked', !!page.mark); this.refreshOverviewHead(); }
        });
        if (!filtered && nb.pages.length > 1) {
          // Drag handle: pressing it picks the page up at once (no hold needed) and never scrolls.
          const grip = el('div', 'inkbook-grip', tile);
          grip.setAttribute('aria-label', 'Drag to move this page');
          this.host.setIcon(grip, 'grip-vertical|grip|move');
          grip.addEventListener('touchstart', (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
          grip.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); this.ovPress(e, tile, true); });
        }
      }
      tile._draw = () => this.drawThumb(c, page);
      tile._page = page;
      if (ov.io) ov.io.observe(tile); else tile._draw();
      if (!filtered) tile.addEventListener('pointerdown', (e) => this.ovPress(e, tile));
      tile.addEventListener('click', () => {
        if (tile._noClick) return;
        if (ov.selecting) {
          if (ov.picked.has(i)) ov.picked.delete(i); else ov.picked.add(i);
          tile.classList.toggle('is-picked', ov.picked.has(i));
          this.refreshOverviewHead();
        } else {
          this.closeOverview();
          if (i !== this.pageIndex) this.goTo(i, i > this.pageIndex ? 1 : -1);
        }
      });
    });
    if (!ov.selecting && !filtered) {
      const add = el('div', 'inkbook-tile inkbook-addtile', ov.grid);
      add.textContent = '+';
      add.style.aspectRatio = `${nb.w} / ${nb.h}`;
      add.setAttribute('aria-label', 'Add page at the end');
      add.addEventListener('click', () => {
        this.pushPages();
        nb.pages.push({ id: uid(), tpl: nb.pages[nb.pages.length - 1].tpl, strokes: [] });
        this.changed(); this.buildOverview();
        ov.grid.scrollTop = ov.grid.scrollHeight;
      });
    }
  }

  /* Hold a page (or drag it with the mouse) to pick it up; the other pages make room as it moves. */
  ovPress(e, tile, now) {
    const ov = this.ov;
    if (!ov || ov.selecting || ov.drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const mouse = e.pointerType === 'mouse';
    const st = { id: e.pointerId, x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, tile, on: false, timer: 0, raf: 0 };
    const off = () => {
      clearTimeout(st.timer);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
    };
    const move = (ev) => {
      if (ev.pointerId !== st.id) return;
      st.lx = ev.clientX; st.ly = ev.clientY;
      if (st.on) { ev.preventDefault(); return; }
      const d = Math.hypot(ev.clientX - st.x, ev.clientY - st.y);
      if (mouse && d > 6) this.ovDragStart(st);
      else if (!mouse && d > 10) off();                    // moved before the hold: a scroll
    };
    const up = (ev) => {
      if (ev.pointerId !== st.id) return;
      off();
      if (st.on) this.ovDragEnd(st);
    };
    if (!mouse && !now) st.timer = setTimeout(() => this.ovDragStart(st), 380);
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    if (now) { clearTimeout(st.timer); this.ovDragStart(st); }
  }

  ovDragStart(st) {
    const ov = this.ov;
    if (!ov || st.on || !st.tile.isConnected) return;
    st.on = true; ov.drag = st;
    const r = st.tile.getBoundingClientRect();
    st.dx = st.lx - r.left; st.dy = st.ly - r.top;
    st.ghost = el('div', 'inkbook-dragghost', ov.el);
    st.ghost.style.width = r.width + 'px';
    const src = st.tile.querySelector('canvas'), c = el('canvas', 'inkbook-thumb', st.ghost);
    c.width = src.width; c.height = src.height; c.style.aspectRatio = src.style.aspectRatio;
    if (src.width) c.getContext('2d').drawImage(src, 0, 0);
    st.tile.classList.add('is-dragging');
    if (navigator.vibrate) try { navigator.vibrate(10); } catch (e) { /* not supported */ }
    this.ovDragFrame();
  }

  ovDragFrame() {
    const ov = this.ov, st = ov && ov.drag;
    if (!st) return;
    const or = ov.el.getBoundingClientRect(), g = ov.grid, gr = g.getBoundingClientRect(), edge = 60;
    st.ghost.style.transform = `translate(${st.lx - st.dx - or.left}px, ${st.ly - st.dy - or.top}px)`;
    if (st.ly < gr.top + edge) g.scrollTop -= Math.ceil((gr.top + edge - st.ly) / 4);           // scroll near the edges
    else if (st.ly > gr.bottom - edge) g.scrollTop += Math.ceil((st.ly - gr.bottom + edge) / 4);
    for (const t of g.children) {
      if (!t._page || t === st.tile) continue;
      const r = t.getBoundingClientRect();
      if (st.lx < r.left || st.lx > r.right || st.ly < r.top || st.ly > r.bottom) continue;
      // Take the place of the page under the finger: it shifts one step towards where we came from.
      const before = st.tile.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING;
      g.insertBefore(st.tile, before ? t.nextSibling : t);
      break;
    }
    st.raf = requestAnimationFrame(() => this.ovDragFrame());
  }

  ovDragEnd(st) {
    cancelAnimationFrame(st.raf);
    const ov = this.ov;
    if (!ov || ov.drag !== st) return;
    ov.drag = null;
    st.ghost.remove(); st.tile.classList.remove('is-dragging');
    st.tile._noClick = true;
    setTimeout(() => { st.tile._noClick = false; }, 400);
    const order = [...ov.grid.children].filter((t) => t._page).map((t) => t._page);
    if (order.length !== this.nb.pages.length || order.every((p, i) => p === this.nb.pages[i])) return;
    const cur = this.page;
    this.pushPages();
    this.nb.pages = order;
    this.pageIndex = order.indexOf(cur);
    this.changed();
    this.buildOverview();
  }

  drawThumb(c, page) {
    const nb = this.nb, k = (Math.min(2, window.devicePixelRatio || 1) * 150) / nb.w;
    c.width = Math.round(nb.w * k); c.height = Math.round(nb.h * k);
    const ctx = c.getContext('2d');
    ctx.setTransform(k, 0, 0, k, 0, 0);
    drawTemplate(ctx, nb, page);
    if (page.bg) {
      const r = this.bgCached(this.bgThumb, page.bg, k, 400, () => { if (c.isConnected) this.drawThumb(c, page); });
      if (r && r.canvas) ctx.drawImage(r.canvas, r.fit.x, r.fit.y, r.fit.w, r.fit.h);
    }
    this.drawContent(ctx, page, null, null, () => { if (c.isConnected) this.drawThumb(c, page); });
  }

  deletePages(list) {
    if (!list.length) return;
    const pages = this.nb.pages, n = list.length;
    const drop = new Set(list.map((i) => pages[i])), tpl = this.page.tpl, cur = this.page;
    this.pushPages();
    this.nb.pages = pages.filter((p) => !drop.has(p));
    if (!this.nb.pages.length) this.nb.pages.push({ id: uid(), tpl, strokes: [] });
    const keep = this.nb.pages.indexOf(cur);
    this.pageIndex = keep >= 0 ? keep : Math.min(this.pageIndex, this.nb.pages.length - 1);
    this.dropSelection(); this.render(); this.clearLive(); this.changed();
    if (this.ov) { this.ov.picked.clear(); this.ov.selecting = false; this.buildOverview(); }
    this.host.notice(`Deleted ${n} page${n === 1 ? '' : 's'} — Undo brings ${n === 1 ? 'it' : 'them'} back`);
  }

  /* ---------------- text boxes ---------------- */

  inTextEditor(t) { return !!this.textEd && this.textEd.ta === t; }

  /* Text tool tap: edit the text box under the pencil, or start a new one there. */
  textAt(x, y) {
    const items = this.page.items || [];
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].k === 'text' && itemHit(items[i], x, y, 4 / this.scale)) { this.openText(items[i]); return; }
    }
    const p = this.prefs, size = p.textSize, nb = this.nb, x0 = clamp(x, 4, nb.w - 64);
    this.openText({ k: 'text', x: r2(x0 - TEXT_PAD), y: r2(y - size * 0.8 - TEXT_PAD), w: r2(clamp(nb.w - x0 - 16, 60, 320)), size, c: p.penColor, text: '', rot: 0 });
  }

  openText(orig) {
    this.closeText();
    this.clearSelection();
    const ta = el('textarea', 'inkbook-textedit', this.stage);
    ta.value = orig.text;
    ta.setAttribute('aria-label', 'Text box');
    this.textEd = { ta, orig, item: orig, page: this.page };
    ta.addEventListener('input', () => this.placeText());
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); this.closeText(); }
    });
    // Hiding the keyboard (or tapping outside the notebook) finishes the text box.
    ta.addEventListener('blur', () => setTimeout(() => {
      if (this.textEd && this.textEd.ta === ta && document.activeElement !== ta) this.closeText();
    }, 150));
    this.placeText();
    this.renderMain();
    ta.focus({ preventScroll: true });
    try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) { /* not focusable yet */ }
  }

  placeText() {
    const t = this.textEd;
    if (!t) return;
    const it = t.item, s = this.scale, ta = t.ta;
    ta.style.left = this.tx + it.x * s + 'px';
    ta.style.top = this.ty + it.y * s + 'px';
    ta.style.width = it.w * s + 'px';
    ta.style.fontSize = it.size * s + 'px';
    ta.style.padding = TEXT_PAD * s + 'px';
    ta.style.color = it.c;
    ta.style.transform = it.rot ? `rotate(${it.rot}rad)` : '';
    ta.style.height = '0px';
    ta.style.height = Math.max(ta.scrollHeight, (2 * TEXT_PAD + it.size * TEXT_LH) * s) + 'px';
  }

  /* Colour / size changes while typing apply to the text box. */
  restyleText(props) {
    const t = this.textEd;
    if (!t) return;
    t.item = Object.assign({}, t.item, props);
    this.placeText();
    t.ta.focus({ preventScroll: true });
  }

  /* Puts the typed text on the page (an emptied box is removed). silent: just close. */
  closeText(silent) {
    const t = this.textEd;
    if (!t) return;
    this.textEd = null;
    const text = t.ta.value.replace(/\s+$/, '');
    t.ta.remove();
    if (silent) return;
    const page = t.page, items = page.items || [], i = items.indexOf(t.orig);
    const next = text ? Object.assign({}, t.item, { text }) : null;
    const same = i >= 0 && next && next.text === t.orig.text && next.c === t.orig.c && next.size === t.orig.size;
    if (!same && (i >= 0 || next)) {
      this.pushHistory(page);
      const out = items.slice();
      if (i < 0) out.push(next); else if (next) out[i] = next; else out.splice(i, 1);
      page.items = out;
      this.changed();
    }
    if (page === this.page) this.renderMain();
  }

  /* ---------------- pictures ---------------- */

  /* Decoded picture for a vault path (null while it loads; onReady runs once it has). */
  image(src, onReady) {
    let e = this.imgs.get(src);
    if (!e) {
      e = { img: null, failed: false, url: null, waiters: new Set() };
      this.imgs.set(src, e);
      Promise.resolve().then(() => this.host.readFile(src)).then((buf) => new Promise((res, rej) => {
        e.url = URL.createObjectURL(new Blob([buf], { type: MIME[src.split('.').pop().toLowerCase()] || '' }));
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = () => rej(new Error('cannot read ' + src));
        im.src = e.url;
      })).then((im) => { e.img = im; }, (err) => {
        console.error(err);
        e.failed = true;
        if (!this.imgWarned) { this.imgWarned = true; this.host.notice('Picture missing: ' + src); }
      }).then(() => {
        const w = [...e.waiters];
        e.waiters.clear();
        for (const f of w) f();
      });
    }
    if (!e.img && !e.failed && onReady) e.waiters.add(onReady);
    return e.img;
  }

  loadImage(src) {
    return new Promise((res) => {
      const im = this.image(src, () => res(this.imgs.get(src).img));
      if (im || this.imgs.get(src).failed) res(im);
    });
  }

  pickDeviceImage() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*';
    inp.style.display = 'none';
    document.body.appendChild(inp);
    inp.addEventListener('change', () => { if (inp.files && inp.files[0]) this.insertImageFile(inp.files[0]); inp.remove(); });
    inp.click();
  }

  async pickVaultImage() {
    const src = await this.host.pickImage();
    if (src) this.insertImage(src);
  }

  /* Photos are shrunk to at most MAX_PIC pixels across before they are saved into the vault. */
  async insertImageFile(file) {
    try {
      const pic = await shrinkImage(file);
      const src = await this.host.storeFile(pic.name, pic.buffer);
      await this.insertImage(src, pic.w, pic.h);
    } catch (e) { console.error(e); this.host.notice('Could not insert the picture: ' + e.message); }
  }

  async insertImage(src, w, h) {
    if (!w) {
      const im = await this.loadImage(src);
      if (!im) return;
      w = im.naturalWidth; h = im.naturalHeight;
    }
    const nb = this.nb, k = Math.min(0.75, (nb.w * 0.6) / w, (nb.h * 0.45) / h);   // 0.75: 96 dpi pixels to points
    const iw = r2(w * k), ih = r2(h * k);
    const cx = clamp((this.stage.clientWidth / 2 - this.tx) / this.scale, iw / 2, nb.w - iw / 2);
    const cy = clamp((this.stage.clientHeight / 2 - this.ty) / this.scale, ih / 2, nb.h - ih / 2);
    const it = { k: 'img', x: r2(cx - iw / 2), y: r2(cy - ih / 2), w: iw, h: ih, src, rot: 0 };
    this.closeText();
    this.pushHistory();
    this.page.items = (this.page.items || []).concat([it]);
    // Selected straight away, so it can be moved, resized or turned.
    if (this.prefs.tool !== 'lasso') { this.prefs.tool = 'lasso'; this.host.savePrefs(); this.refreshToolbar(); }
    this.select(new Set([it]));
    this.changed();
  }

  /* ---------------- export ---------------- */

  async exportPdf(list) {
    const nb = this.nb;
    list = list && list.length ? list : nb.pages.map((_, i) => i);
    try {
      const images = new Map();
      if (list.some((i) => nb.pages[i].bg)) this.host.notice('Exporting…');
      for (const i of list) {
        const bg = nb.pages[i].bg;
        if (!bg) continue;
        const r = await this.bgCanvas(bg, 200 / 72);                   // imported pages at 200 dpi
        const blob = await new Promise((res) => r.canvas.toBlob(res, 'image/jpeg', 0.88));
        images.set(i, { bytes: new Uint8Array(await blob.arrayBuffer()), w: r.canvas.width, h: r.canvas.height, fit: r.fit });
        r.canvas.width = 0;
      }
      const pics = new Map();
      for (const i of list) {
        for (const it of nb.pages[i].items || []) {
          if (it.k !== 'img' || pics.has(it.src)) continue;
          const im = await this.loadImage(it.src);
          if (im) pics.set(it.src, await jpegOf(im));
        }
      }
      const bytes = await buildPdf(nb, list, images, pics);
      const all = list.length === nb.pages.length;
      await this.host.saveFile(all ? '.pdf' : ` - pages ${pageRanges(list)}.pdf`, bytes.buffer, 'application/pdf');
    } catch (e) { console.error(e); this.host.notice('PDF export failed: ' + e.message); }
  }

  async exportPng() {
    try {
      const nb = this.nb, k = 3, c = document.createElement('canvas'), page = this.page;
      c.width = Math.round(nb.w * k); c.height = Math.round(nb.h * k);
      const ctx = c.getContext('2d');
      ctx.scale(k, k);
      drawTemplate(ctx, nb, page);
      if (page.bg) {
        const r = await this.bgCanvas(page.bg, k);
        ctx.drawImage(r.canvas, r.fit.x, r.fit.y, r.fit.w, r.fit.h);
        r.canvas.width = 0;
      }
      for (const it of page.items || []) if (it.k === 'img') await this.loadImage(it.src);
      this.drawContent(ctx, page);
      const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
      await this.host.saveFile(` - page ${this.pageIndex + 1}.png`, await blob.arrayBuffer(), 'image/png');
    } catch (e) { console.error(e); this.host.notice('PNG export failed: ' + e.message); }
  }
}

function decodeImage(url) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('this file is not a picture that can be opened here'));
    im.src = url;
  });
}

function canvasJpeg(c, q) {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('could not compress the picture'))), 'image/jpeg', q));
}

/* Small PNG / JPEG / GIF files are kept as they are; anything big (camera photos) is scaled down to
   MAX_PIC pixels and saved as JPEG — usually 200–500 KB instead of several MB. */
async function shrinkImage(file) {
  const base = (file.name || 'Picture').replace(/\.[^.]*$/, '') || 'Picture';
  const url = URL.createObjectURL(file);
  try {
    const im = await decodeImage(url), W = im.naturalWidth, H = im.naturalHeight;
    if (!W || !H) throw new Error('the picture is empty');
    const k = Math.min(1, MAX_PIC / Math.max(W, H)), type = file.type || '';
    const small = { 'image/png': 1.5e6, 'image/jpeg': 1e6, 'image/gif': 1e6 }[type];
    if (k === 1 && small && file.size < small) {
      return { name: base + '.' + ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif' })[type], buffer: await file.arrayBuffer(), w: W, h: H };
    }
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(W * k)); c.height = Math.max(1, Math.round(H * k));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(im, 0, 0, c.width, c.height);
    const blob = await canvasJpeg(c, 0.85), out = { name: base + '.jpg', buffer: await blob.arrayBuffer(), w: c.width, h: c.height };
    c.width = 0;
    return out;
  } finally { URL.revokeObjectURL(url); }
}

/* A decoded picture as JPEG bytes for the PDF (transparent parts become white). */
async function jpegOf(im) {
  const W = im.naturalWidth, H = im.naturalHeight, k = Math.min(1, MAX_PIC / Math.max(W, H, 1));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(W * k)); c.height = Math.max(1, Math.round(H * k));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(im, 0, 0, c.width, c.height);
  const out = { bytes: new Uint8Array(await (await canvasJpeg(c, 0.9)).arrayBuffer()), w: c.width, h: c.height };
  c.width = 0;
  return out;
}

/* [0,1,2,4,6,7] -> "1-3, 5, 7-8" */
function pageRanges(list) {
  const out = [];
  for (let i = 0; i < list.length; i++) {
    let j = i;
    while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
    out.push(j > i ? `${list[i] + 1}-${list[j] + 1}` : `${list[i] + 1}`);
    i = j;
  }
  return out.join(', ');
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

class FilePickModal extends obsidian.FuzzySuggestModal {
  constructor(app, exts, placeholder, done) { super(app); this.exts = exts; this.done = done; this.setPlaceholder(placeholder); }
  getItems() { return this.app.vault.getFiles().filter((f) => this.exts.includes(f.extension.toLowerCase())); }
  getItemText(f) { return f.path; }
  onChooseItem(f) { this.done(f.path); }
  // Obsidian closes the modal before reporting the choice, so report "nothing chosen" a moment later.
  onClose() { setTimeout(() => this.done(null), 0); }
}

class InkbookView extends obsidian.TextFileView {
  constructor(leaf, plugin) {
    super(leaf); this.plugin = plugin; this.broken = null; this.editor = null;
    this.shown = null;   // the file whose notebook is on screen; null while one is still loading
  }
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
    return this.broken !== null ? this.broken : serializeNotebook(this.editor.nb);
  }

  setViewData(data, clear) {
    try {
      const nb = parseNotebook(data, this.plugin.settings);
      this.broken = null;
      this.errorEl.hide(); this.editor.root.style.display = '';
      const opening = this.shown !== this.file;   // a different notebook than the one on screen
      this.editor.load(nb, opening ? this.plugin.getPos(this.file) || { page: 0 } : null);
      this.shown = this.file;
    } catch (e) {
      this.broken = data;
      this.editor.root.style.display = 'none';
      this.errorEl.setText('This notebook file could not be read (' + e.message + '). It has been left untouched.');
      this.errorEl.show();
    }
  }

  clear() {}

  // Closing this notebook (or switching to another file in this tab): forget which one is shown,
  // so the next one's loading screen can't save over anything.
  async onUnloadFile(file) {
    this.shown = null;
    return super.onUnloadFile(file);
  }

  makeHost() {
    const plugin = this.plugin, view = this, app = plugin.app;
    const pick = (exts, placeholder) => new Promise((res) => {
      let settled = false;
      new FilePickModal(app, exts, placeholder, (p) => { if (!settled) { settled = true; res(p); } }).open();
    });
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
      // PDF pages behind the ink are rendered with the pdf.js copy that ships inside Obsidian.
      readFile: async (src) => {
        const f = app.vault.getAbstractFileByPath(src);
        if (!(f instanceof obsidian.TFile)) throw new Error('file not found: ' + src);
        return app.vault.readBinary(f);
      },
      loadPdf: async (src) => {
        const f = app.vault.getAbstractFileByPath(src);
        if (!(f instanceof obsidian.TFile)) throw new Error('file not found: ' + src);
        const lib = await obsidian.loadPdfJs();
        const data = new Uint8Array(await app.vault.readBinary(f));
        return lib.getDocument({ data }).promise;
      },
      pickPdf: () => pick(['pdf'], 'Choose a PDF to add to this notebook'),
      pickImage: () => pick(PIC_EXTS, 'Choose a picture to put on this page'),
      // PDFs and pictures from the device or the clipboard are saved into the vault (attachment folder) first.
      storeFile: async (name, buffer) => {
        name = (name || '').replace(/[\\/:*?"<>|#^[\]]/g, '').trim() || 'Imported';
        const dot = name.lastIndexOf('.'), base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
        const from = view.file ? view.file.path : '';
        let path;
        if (app.fileManager.getAvailablePathForAttachment) {
          path = await app.fileManager.getAvailablePathForAttachment(name, from);
        } else {
          const dir = view.file && view.file.parent && view.file.parent.path !== '/' ? view.file.parent.path + '/' : '';
          path = obsidian.normalizePath(dir + name);
          for (let i = 1; app.vault.getAbstractFileByPath(path); i++) path = obsidian.normalizePath(`${dir}${base} ${i}${ext}`);
        }
        const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
        if (folder && !app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
        await app.vault.createBinary(path, buffer);
        return path;
      },
      setPos: (pos) => { if (view.file && view.shown === view.file) plugin.setPos(view.file, pos); },
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
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      const all = this.settings.positions;
      if (all && all[oldPath]) { all[file.path] = all[oldPath]; delete all[oldPath]; this.saveSettingsSoon(); }
    }));
  }

  /* Where each notebook was left (page, zoom, scroll), kept in the plugin's data, newest last. */
  getPos(file) { const all = this.settings.positions; return file && all ? all[file.path] : null; }

  setPos(file, pos) {
    const all = this.settings.positions || (this.settings.positions = {}), old = all[file.path];
    if (old && old.page === pos.page && old.s === pos.s && old.tx === pos.tx && old.ty === pos.ty) return;
    delete all[file.path];
    all[file.path] = pos;
    const keys = Object.keys(all);
    for (let i = 0; i < keys.length - 300; i++) delete all[keys[i]];
    this.saveSettingsSoon();
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
    const file = await this.app.vault.create(path, serializeNotebook(newNotebook(this.settings, opts)));
    await this.app.workspace.getLeaf(true).openFile(file);
  }
}

module.exports = InkbookPlugin;
// Exposed for the browser test harness (dev/index.html).
InkbookPlugin.Editor = Editor;
InkbookPlugin.internals = { DEFAULT_PREFS, parseNotebook, serializeNotebook, newNotebook, buildPdf, isScribble, recognize, recognizeShape, simplify, cutStroke, piece };
