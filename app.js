// app.js — 画面と操作（基板エディタ・各パネル・音・ファイル）
'use strict';
const P = 20, MM = P / 2.54, RATE = 48000, MAX_SEC = 10, DETAIL = 0.03;   // 1穴 = 2.54mm = 20単位
const { KINDS, partPins } = Board;
const PINOUTS = { bjt: ['EBC', 'ECB', 'BEC', 'BCE', 'CBE', 'CEB'], jfet: ['DSG', 'DGS', 'SDG', 'SGD', 'GDS', 'GSD'] };
const WIRE_COLORS = { '#d63031': '赤', '#2d3436': '黒', '#0984e3': '青', '#fdcb6e': '黄', '#00b894': '緑', '#f5f6fa': '白', '#e17055': '橙' };
const PALETTE = [['resistor', '抵抗'], ['capacitor', 'フィルムC'], ['electrolytic', '電解C'], ['diode', 'ダイオード'], ['led', 'LED'], ['inductor', 'コイル'],
  ['bjt', 'トランジスタ'], ['jfet', 'JFET'], ['opamp2', 'OPアンプ×2'], ['opamp1', 'OPアンプ×1'], ['terminal', '外部端子'], ['wire', '配線']];
const BAND = ['#111', '#7b3f00', '#e00', '#f80', '#ee0', '#0a0', '#05f', '#80f', '#888', '#fff'];

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const svg = $('#board'), wrap = $('#canvasWrap'), stage = $('#stage'), gBoard = $('#gBoard'), gParts = $('#gParts'), gOver = $('#gOver');

let doc, sheet, res, sel = new Set(), tool = 'select', zoom = 1, vb = { x: 0, y: 0, w: 1, h: 1 };
let dirty = false, fileHandle = null, fileName = '無題', clip = null, pasteN = 0, wireColor = '#d63031';
let drag = null, hoverRoot = -1, focusIssue = -1, spaceDown = false;
const opt = { rats: true, labels: true, marks: true };

/* ───────── データ ───────── */
function newSheet(name) {
  return { name, board: { cols: 30, rows: 20 }, parts: [], netlist: '', image: '', offboard: {}, simIn: '', simOut: '', nextId: 1, _undo: [], _redo: [], _net: null };
}
const pt = o => ({ x: Math.round(+(o && o.x)) || 0, y: Math.round(+(o && o.y)) || 0 });
const num = (v, d) => Number.isFinite(+v) && +v > 0 ? +v : d;
// ファイル等から来た部品を検証して正規化する
function cleanPart(p, id) {
  const k = p && KINDS[p.kind];
  if (!k) return null;
  const q = { id, kind: p.kind, ref: String(p.ref || '').slice(0, 30), value: String(p.value || '').slice(0, 30) };
  if (k.two) { q.a = pt(p.a); q.b = pt(p.b); } else { Object.assign(q, pt(p)); q.rot = (p.rot | 0) & 3; }
  if (p.kind === 'wire') q.color = /^#[0-9a-f]{3,8}$/i.test(p.color) ? p.color : '#d63031';
  else if (k.two) { q.bodyL = num(p.bodyL, k.bodyL); q.bodyW = num(p.bodyW, k.bodyW); }
  if (PINOUTS[p.kind]) { q.pinout = PINOUTS[p.kind].includes(p.pinout) ? p.pinout : PINOUTS[p.kind][0]; q.pitch = p.pitch === 2 ? 2 : 1; }
  if (k.dip) q.units = [0, 1].map(i => String((p.units || [])[i] || ''));
  if (p.kind === 'terminal') q.label = String(p.label || '').slice(0, 30);
  return q;
}
function loadSheet(s) {
  const t = newSheet(String(s.name || 'シート').slice(0, 40));
  t.board = { cols: clamp((s.board && s.board.cols | 0) || 30, 4, 120), rows: clamp((s.board && s.board.rows | 0) || 20, 4, 120) };
  t.netlist = String(s.netlist || '');
  t._net = t.netlist ? Sim.parseNetlist(t.netlist) : null;
  t.image = /^data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=]+$/.test(s.image || '') ? s.image : '';
  for (const [k, v] of Object.entries(s.offboard || {})) t.offboard[k] = !!v;
  t.simIn = String(s.simIn || ''); t.simOut = String(s.simOut || '');
  t.parts = (Array.isArray(s.parts) ? s.parts : []).map(p => cleanPart(p, t.nextId++)).filter(Boolean);
  return t;
}
function makePart(kind, at, extra = {}) {
  const k = KINDS[kind], p = { id: sheet.nextId++, kind, ref: '', value: k.value || '' };
  if (k.two) { p.a = { x: at.x, y: at.y }; p.b = { x: at.x + k.span, y: at.y }; } else { p.x = at.x; p.y = at.y; p.rot = 0; }
  if (kind === 'wire') p.color = wireColor;
  else if (k.two) { p.bodyL = k.bodyL; p.bodyW = k.bodyW; }
  if (PINOUTS[kind]) { p.pinout = PINOUTS[kind][0]; p.pitch = 1; }
  if (k.dip) p.units = ['', ''];
  if (kind === 'terminal') p.label = '';
  Object.assign(p, extra);
  if (k.prefix && !p.ref) p.ref = nextRef(k.prefix);
  return p;
}
// 基板上と回路図上のどちらとも重ならない番号
function nextRef(prefix) {
  const re = new RegExp('^' + prefix + '(\\d+)$', 'i');
  let n = 0;
  for (const s of sheet.parts.map(p => p.ref).concat(sheet._net ? sheet._net.elements.map(e => e.name) : [])) { const m = re.exec(s); if (m) n = Math.max(n, +m[1]); }
  return prefix + (n + 1);
}
function shift(p, dx, dy) {
  if (p.a) { p.a.x += dx; p.a.y += dy; p.b.x += dx; p.b.y += dy; } else { p.x += dx; p.y += dy; }
}
const partById = id => sheet.parts.find(p => p.id === id);
const selected = () => sheet.parts.filter(p => sel.has(p.id));

/* ───────── 編集と Undo ───────── */
const snapshot = () => JSON.stringify({ parts: sheet.parts, board: sheet.board, offboard: sheet.offboard, nextId: sheet.nextId });
function pushUndo(s) { sheet._undo.push(s); if (sheet._undo.length > 200) sheet._undo.shift(); sheet._redo.length = 0; }
function edit(fn, full) { pushUndo(snapshot()); fn(); dirty = true; focusIssue = -1; refresh(full); }
function undoRedo(from, to) {
  if (!from.length) return;
  to.push(snapshot()); Object.assign(sheet, JSON.parse(from.pop()));
  sel.clear(); dirty = true; refresh(true);
}
function refresh(full) {
  res = Board.check(sheet, sheet._net);
  if (snd.output && !snd.job) { verdict('▲ 基板が変更されました。SoundCheck で再判定してください', 'warn'); verdict('', '', '#verdictRef'); }
  if (full) { renderBoard(); renderSchem(); renderTabs(); renderSimSel(); }
  renderParts(); renderOverlay(); renderPartsList(); renderIssues(); renderProps(); renderTitle();
}
function renderSel() { renderParts(); renderOverlay(); renderProps(); renderPartsList(); }

/* ───────── 基板の描画 ───────── */
const rowName = y => (y >= 26 ? String.fromCharCode(64 + Math.floor(y / 26)) : '') + String.fromCharCode(65 + y % 26);
function renderBoard() {
  const { cols, rows } = sheet.board, m = 1.3 * P;
  vb = { x: -m, y: -m, w: (cols - 1) * P + 2 * m, h: (rows - 1) * P + 2 * m };
  svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  let s = `<rect class="pcb" x="${-m + 3}" y="${-m + 3}" width="${vb.w - 6}" height="${vb.h - 6}" rx="8"/>`;
  for (let x = 0; x < cols; x++) s += `<text class="lbl" x="${x * P}" y="${-0.85 * P}">${x + 1}</text>`;
  for (let y = 0; y < rows; y++) s += `<text class="lbl" x="${-0.85 * P}" y="${y * P}">${rowName(y)}</text>`;
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) s += `<circle class="pad" cx="${x * P}" cy="${y * P}" r="${0.26 * P}"/>`;
  gBoard.innerHTML = s;
  applyZoom();
}
function renderParts() {
  const order = sheet.parts.filter(p => p.kind !== 'wire').concat(sheet.parts.filter(p => p.kind === 'wire'));
  gParts.innerHTML = order.map(p => drawPart(p)).join('');
}
function drawPart(p, icon) {
  const k = KINDS[p.kind], lab = !icon && opt.labels;
  let s = k.two ? draw2(p, k, lab) : k.dip ? drawDip(p, lab) : p.kind === 'terminal' ? drawTerm(p) : drawTO92(p, lab);
  if (p.kind !== 'wire') for (const q of partPins(p))
    s += `<circle class="pin" cx="${q.x * P}" cy="${q.y * P}" r="${0.17 * P}">${icon ? '' : `<title>${esc(res.pinText.get(`${q.x},${q.y}`) || '')}</title>`}</circle>`;
  return `<g class="part${sel.has(p.id) && !icon ? ' sel' : ''}" data-id="${p.id}">${s}</g>`;
}
function draw2(p, k, lab) {
  const x1 = p.a.x * P, y1 = p.a.y * P, x2 = p.b.x * P, y2 = p.b.y * P;
  const len = Math.hypot(x2 - x1, y2 - y1), ang = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI, mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const line = `x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"`;
  if (p.kind === 'wire') return `<line class="wire-o" ${line} stroke-width="${0.34 * P}"/><line class="wire" ${line} stroke="${p.color}" stroke-width="${0.24 * P}"/>`;
  const L = p.bodyL * MM, W = p.bodyW * MM, rot = `transform="translate(${mx} ${my}) rotate(${ang})"`;
  let s = `<line class="lead" ${line}/>`, lx = mx, ly = my;
  if (k.radial) {
    const r = L / 2;
    s += `<circle class="body ${p.kind}" cx="${mx}" cy="${my}" r="${r}"/>`;
    s += p.kind === 'electrolytic'   // − 側(b)の白帯
      ? `<g ${rot}><path d="M${r * .45} ${-r * .89}A${r} ${r} 0 0 1 ${r * .45} ${r * .89}Z" fill="#cfd8ef"/><text class="mark-text" x="${r * .72}" y="0" style="fill:#24418f">−</text></g>`
      : `<g ${rot}><line x1="${r * .72}" y1="${-r * .68}" x2="${r * .72}" y2="${r * .68}" stroke="#7a0000" stroke-width="1.6"/></g>`;   // LEDのカソード側
    ly = my - r - 0.32 * P;
  } else if (k.box) {   // 箱型フィルム: 足の間の中央に本体
    s += `<g ${rot}><rect class="body ${p.kind}" x="${-L / 2}" y="${-W / 2}" width="${L}" height="${W}" rx="${W / 5}"/></g>`;
    if (Math.abs(Math.sin(ang * Math.PI / 180)) > 0.7) lx = mx + W / 2 + 0.5 * P; else ly = my - W / 2 - 0.32 * P;
  } else if (len < L + 0.3 * P) {   // 間隔が狭いときは立てて実装
    const r = Math.max(W * 0.7, 0.3 * P);
    s += `<circle class="body ${p.kind}" cx="${x1}" cy="${y1}" r="${r}"/>`;
    lx = x1; ly = y1 - r - 0.32 * P;
  } else {
    s += `<g ${rot}><rect class="body ${p.kind}" x="${-L / 2}" y="${-W / 2}" width="${L}" height="${W}" rx="${p.kind === 'resistor' ? W / 2.5 : W / 4}"/>${bodyDeco(p, L, W)}</g>`;
    if (Math.abs(Math.sin(ang * Math.PI / 180)) > 0.7) lx = mx + W / 2 + 0.5 * P; else ly = my - W / 2 - 0.32 * P;
  }
  if (lab && p.ref) s += `<text class="ref" x="${lx}" y="${ly}">${esc(p.ref)}</text>`;
  return s;
}
function bands(v) {   // 抵抗のカラーコード4本
  if (!(v > 0)) return null;
  let e = Math.floor(Math.log10(v) + 1e-9) - 1, d = Math.round(v / 10 ** e);
  if (d >= 100) { d = Math.round(d / 10); e++; }
  if (e < -2 || e > 9) return null;
  return [BAND[Math.floor(d / 10)], BAND[d % 10], e === -1 ? '#c9a227' : e === -2 ? '#c0c0c0' : BAND[e], '#c9a227'];
}
function bodyDeco(p, L, W) {
  if (p.kind === 'resistor') {
    const b = bands(Sim.parseValue(p.value, true));
    return b ? b.map((c, i) => `<rect x="${L * [-0.3, -0.17, -0.04, 0.24][i] - L * 0.035}" y="${-W / 2}" width="${L * 0.07}" height="${W}" fill="${c}"/>`).join('') : '';
  }
  if (p.kind === 'diode') return `<rect x="${L * 0.22}" y="${-W / 2}" width="${L * 0.14}" height="${W}" fill="#222"/>`;   // カソード帯(b側)
  return '';
}
function drawTO92(p, lab) {
  const w = 2 * (p.pitch || 1) * P, x0 = -0.5 * P, x1 = w + 0.5 * P, r = p.rot || 0, pins = partPins(p);
  let s = `<g transform="translate(${p.x * P} ${p.y * P}) rotate(${r * 90})"><path class="body ${p.kind}" d="M${x0} ${0.42 * P}A${(x1 - x0) / 2} ${0.95 * P} 0 0 1 ${x1} ${0.42 * P}Z"/></g>`;
  const [dx, dy] = Board.rot(0, -0.45 * P, r), [rx, ry] = Board.rot(0, 1.0 * P, r);
  pins.forEach(q => s += `<text class="pinl" x="${q.x * P + dx}" y="${q.y * P + dy}">${q.name}</text>`);
  if (lab) s += `<text class="ref" x="${pins[1].x * P + rx}" y="${pins[1].y * P + ry}">${esc(p.ref)} ${esc(p.value)}</text>`;
  return s;
}
function drawDip(p, lab) {
  const r = p.rot || 0, pins = partPins(p);
  let s = `<g transform="translate(${p.x * P} ${p.y * P}) rotate(${r * 90})"><rect class="body ic" x="${-0.55 * P}" y="${0.42 * P}" width="${4.1 * P}" height="${2.16 * P}" rx="2"/>` +
    `<path d="M${-0.55 * P} ${1.15 * P}A${0.35 * P} ${0.35 * P} 0 0 1 ${-0.55 * P} ${1.85 * P}" fill="#666"/></g>`;
  for (const q of pins) { const [dx, dy] = Board.rot(0, (+q.name <= 4 ? -0.4 : 0.4) * P, r); s += `<text class="pinl" x="${q.x * P + dx}" y="${q.y * P + dy}">${q.name}</text>`; }
  const [cx, cy] = Board.rot(1.5 * P, 1.5 * P, r);
  if (lab) s += `<text class="ictext" x="${p.x * P + cx}" y="${p.y * P + cy - 5}">${esc(p.ref)}</text><text class="ictext" x="${p.x * P + cx}" y="${p.y * P + cy + 5}">${esc(p.value)}</text>`;
  return s;
}
function drawTerm(p) {
  const x = p.x * P, y = p.y * P, t = p.label ? Board.disp(Board.normNet(p.label)) : '?';
  return `<rect class="body term" x="${x - 0.32 * P}" y="${y - 0.32 * P}" width="${0.64 * P}" height="${0.64 * P}" rx="2"/>` +
    `<rect class="tagbg" x="${x + 0.36 * P}" y="${y - 0.98 * P}" width="${[...t].length * 5.6 + 8}" height="${0.66 * P}" rx="3"/><text class="tag" x="${x + 0.36 * P + 4}" y="${y - 0.65 * P}">${esc(t)}</text>`;
}
function bbox(p) {   // 選択枠(px)
  const ps = partPins(p), k = KINDS[p.kind];
  const span = k.two ? Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y) : 0;
  const pad = k.dip || PINOUTS[p.kind] ? 0.75 : k.radial ? Math.max(0.5, p.bodyL * MM / 2 / P + 0.15)
    : k.box ? Math.max(0.5, p.bodyL * MM / 2 / P - span / 2 + 0.15, p.bodyW * MM / 2 / P + 0.15) : 0.5;
  const xs = ps.map(q => q.x), ys = ps.map(q => q.y);
  const x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad;
  return { x: x0 * P, y: y0 * P, w: (Math.max(...xs) + pad - x0) * P, h: (Math.max(...ys) + pad - y0) * P };
}
function renderOverlay() {
  let s = '';
  const { cols, rows } = sheet.board;
  if (hoverRoot >= 0) for (let h = 0; h < cols * rows; h++) if (res.find(h) === hoverRoot) s += `<circle class="hl" cx="${h % cols * P}" cy="${Math.floor(h / cols) * P}" r="${0.42 * P}"/>`;
  if (opt.rats) for (const [a, b] of res.airwires) s += `<line class="rat" x1="${a.x * P}" y1="${a.y * P}" x2="${b.x * P}" y2="${b.y * P}"/>`;
  if (opt.marks) res.issues.forEach((it, i) => {
    if (it.level === 'error' || (it.level === 'warn' && i === focusIssue))
      for (const h of it.holes) s += `<circle class="mark ${it.level}${i === focusIssue ? ' focus' : ''}" cx="${h.x * P}" cy="${h.y * P}" r="${0.5 * P}"/>`;
  });
  for (const p of selected()) {
    const b = bbox(p);
    s += `<rect class="selbox" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="3"/>`;
    if (KINDS[p.kind].two && tool === 'select') for (const e of ['a', 'b']) s += `<circle class="handle" data-id="${p.id}" data-h="${e}" cx="${p[e].x * P}" cy="${p[e].y * P}" r="${0.27 * P}"/>`;
  }
  if (drag && drag.type === 'wire') s += `<line class="preview" x1="${drag.a.x * P}" y1="${drag.a.y * P}" x2="${drag.b.x * P}" y2="${drag.b.y * P}" style="stroke:${wireColor}"/>`;
  if (drag && drag.type === 'band') { const r = rectOf(drag.p0, drag.p1); s += `<rect class="band" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}"/>`; }
  gOver.innerHTML = s;
}
const rectOf = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });

/* ───────── ズーム・座標 ───────── */
function applyZoom() {
  svg.style.width = vb.w * zoom + 'px'; svg.style.height = vb.h * zoom + 'px';
  // 基板の周りに表示枠ぶんの余白を取り、全体が見えていてもハンドツールで好きな位置へずらせるようにする
  stage.style.padding = `${Math.round(wrap.clientHeight * 0.9)}px ${Math.round(wrap.clientWidth * 0.9)}px`;
  $('#zoomLabel').textContent = Math.round(zoom * 100) + '%';
}
// 基板座標 (x, y) が表示の中央に来るようにスクロールする
function centerOn(x, y, smooth) {
  const w = wrap.getBoundingClientRect(), b = svg.getBoundingClientRect();
  wrap.scrollTo({ left: wrap.scrollLeft + b.left - w.left + (x - vb.x) * zoom - wrap.clientWidth / 2,
    top: wrap.scrollTop + b.top - w.top + (y - vb.y) * zoom - wrap.clientHeight / 2, behavior: smooth ? 'smooth' : 'auto' });
}
function setZoom(z, cx, cy) {
  const r = wrap.getBoundingClientRect();
  if (cx === undefined) { cx = r.left + r.width / 2; cy = r.top + r.height / 2; }
  const b = svg.getBoundingClientRect(), fx = (cx - b.left) / zoom, fy = (cy - b.top) / zoom;
  zoom = clamp(z, 0.3, 6); applyZoom();
  const b2 = svg.getBoundingClientRect();
  wrap.scrollLeft += b2.left + fx * zoom - cx; wrap.scrollTop += b2.top + fy * zoom - cy;
}
function zoomFit() { zoom = clamp(Math.min((wrap.clientWidth - 12) / vb.w, (wrap.clientHeight - 12) / vb.h), 0.3, 6); applyZoom(); centerOn(vb.x + vb.w / 2, vb.y + vb.h / 2); }
function toBoard(cx, cy) { const q = new DOMPoint(cx, cy).matrixTransform(svg.getScreenCTM().inverse()); return { x: q.x, y: q.y }; }
const snap = q => ({ x: Math.round(q.x / P), y: Math.round(q.y / P) });
function viewCenter() {
  const r = wrap.getBoundingClientRect(), q = snap(toBoard(r.left + r.width / 2, r.top + r.height / 2));
  return { x: clamp(q.x, 0, sheet.board.cols - 1), y: clamp(q.y, 0, sheet.board.rows - 1) };
}
const scrollToHole = h => centerOn(h.x * P, h.y * P, true);

/* ───────── 空き場所への配置 ───────── */
function holeBox(p, pad) {
  const ps = partPins(p), xs = ps.map(q => q.x), ys = ps.map(q => q.y);
  return { x0: Math.min(...xs) - pad, x1: Math.max(...xs) + pad, y0: Math.min(...ys) - pad, y1: Math.max(...ys) + pad };
}
function occupancy() {
  const { cols, rows } = sheet.board, used = new Uint8Array(cols * rows);
  sheet.parts.forEach(p => markUsed(used, p));
  return used;
}
function markUsed(used, p) {
  const b = holeBox(p, 1), { cols, rows } = sheet.board;
  for (let y = Math.max(0, b.y0); y <= Math.min(rows - 1, b.y1); y++) for (let x = Math.max(0, b.x0); x <= Math.min(cols - 1, b.x1); x++) used[y * cols + x] = 1;
}
// near に近い順（null なら左上から行順）に、ピンの範囲が空いている場所を探して置く
function placeFree(p, near, used) {
  const { cols, rows } = sheet.board, b = holeBox(p, 0), bw = b.x1 - b.x0, bh = b.y1 - b.y0, cands = [];
  for (let y = 0; y + bh < rows; y++) for (let x = 0; x + bw < cols; x++) cands.push([x, y]);
  const d = c => (c[0] - near.x) ** 2 + (c[1] - near.y) ** 2;
  cands.sort(near ? (a, c) => d(a) - d(c) : (a, c) => a[1] - c[1] || a[0] - c[0]);
  for (const [x, y] of cands) {
    let ok = true;
    for (let yy = y; yy <= y + bh && ok; yy++) for (let xx = x; xx <= x + bw && ok; xx++) ok = !used[yy * cols + xx];
    if (ok) { shift(p, x - b.x0, y - b.y0); markUsed(used, p); return; }
  }
  if (near) shift(p, near.x - b.x0, near.y - b.y0);   // 空きが無ければ指定位置にそのまま
}

/* ───────── 部品の追加 ───────── */
function addPart(kind, at) {
  if (kind === 'wire') return setTool('wire');
  edit(() => { const p = makePart(kind, at); placeFree(p, at, occupancy()); sheet.parts.push(p); sel = new Set([p.id]); });
}
// 回路図の素子に対応する部品を作る（デュアルOPアンプの空きユニットがあればそこへ割り当てる）
function partFor(e) {
  const kind = Board.kindFor(e);
  if (kind === 'opamp2') {
    const ic = sheet.parts.find(p => p.kind === 'opamp2' && p.units[0] && !p.units[1]);
    if (ic) { ic.units[1] = e.name; return ic; }
  }
  const extra = { ref: e.name };
  if ('RCL'.includes(e.type)) extra.value = Sim.fmt(e.value);
  else if (e.model) extra.value = e.model;
  if (PINOUTS[kind]) { const po = (Sim.MODELS[e.model] || {}).pinout; if (PINOUTS[kind].includes(po)) extra.pinout = po; }
  if (KINDS[kind].dip) Object.assign(extra, { ref: e.name.replace(/^X/i, '').replace(/(\d)[A-D]$/i, '$1') || e.name, value: e.sub, units: [e.name, ''] });
  return makePart(kind, { x: 0, y: 0 }, extra);
}
const findByEl = name => sheet.parts.find(p => [p.ref, ...(p.units || [])].some(s => s.toUpperCase() === name.toUpperCase()));
function placeElement(name, at) {
  const e = sheet._net && sheet._net.elements.find(x => x.name === name);
  if (!e) return;
  if (!Board.kindFor(e)) return alert(`${name} は基板に載せる部品ではありません。\n「外部端子」を置いて、つながるネット名を設定してください。`);
  if (res.placed.has(e.name)) { const p = findByEl(e.name); if (p) { sel = new Set([p.id]); renderSel(); scrollToHole(partPins(p)[0]); } return; }
  edit(() => {
    const p = partFor(e);
    if (!sheet.parts.includes(p)) { placeFree(p, at, occupancy()); sheet.parts.push(p); }
    sel = new Set([p.id]);
  });
}
function placeAll() {
  if (!sheet._net) return alert('回路図(ネットリスト)がまだありません');
  const todo = sheet._net.elements.filter(e => !res.placed.has(e.name) && !Board.isExternal(e, sheet.offboard));
  if (!todo.length) return alert('未配置の部品はありません');
  edit(() => {
    const used = occupancy();
    for (const e of todo) { const p = partFor(e); if (!sheet.parts.includes(p)) { placeFree(p, null, used); sheet.parts.push(p); } }
  });
}
function moveSel(dx, dy) { selected().forEach(p => shift(p, dx, dy)); }
function rotateSel() {
  const ps = selected();
  if (!ps.length) return;
  const all = ps.flatMap(partPins), xs = all.map(q => q.x), ys = all.map(q => q.y);
  const cx = Math.round((Math.min(...xs) + Math.max(...xs)) / 2), cy = Math.round((Math.min(...ys) + Math.max(...ys)) / 2);
  const R = q => ({ x: cx - (q.y - cy), y: cy + (q.x - cx) });   // 時計回り90°
  edit(() => ps.forEach(p => {
    if (p.a) { p.a = R(p.a); p.b = R(p.b); } else { const o = R(p); p.x = o.x; p.y = o.y; p.rot = (p.rot + 1) % 4; }
  }));
}
function copySel() { const ps = selected(); if (ps.length) { clip = JSON.stringify(ps); pasteN = 0; } }
function pasteClip() {
  if (!clip) return;
  pasteN++;
  edit(() => {
    sel = new Set();
    for (const src of JSON.parse(clip)) {
      const p = cleanPart(src, sheet.nextId++), k = KINDS[p.kind];
      shift(p, pasteN, pasteN);
      if (k.prefix && sheet.parts.some(q => q.ref.toUpperCase() === p.ref.toUpperCase())) p.ref = nextRef(k.prefix);
      if (k.dip) p.units = ['', ''];   // 同じユニットの二重割り当てを避ける
      sheet.parts.push(p); sel.add(p.id);
    }
  });
}
function setTool(t) { tool = t; renderTitle(); renderOverlay(); }

/* ───────── マウス操作 ───────── */
wrap.addEventListener('pointerdown', e => {
  closeMenus();
  if (e.target === wrap) return;   // スクロールバー
  if (e.button === 1 || (e.button === 0 && (spaceDown || tool === 'hand'))) {
    drag = { type: 'pan', cx: e.clientX, cy: e.clientY, sl: wrap.scrollLeft, st: wrap.scrollTop };
    wrap.setPointerCapture(e.pointerId); wrap.classList.add('panning'); e.preventDefault(); return;
  }
  if (e.button !== 0) return;
  wrap.setPointerCapture(e.pointerId);
  const q = toBoard(e.clientX, e.clientY), h = snap(q), t = e.target;
  focusIssue = -1;
  if (tool === 'wire') { drag = { type: 'wire', a: h, b: h }; renderOverlay(); return; }
  if (t.dataset.h) { drag = { type: 'end', p: partById(+t.dataset.id), end: t.dataset.h, pre: snapshot() }; return; }
  const g = t.closest('#gParts [data-id]');
  if (g) {
    const id = +g.dataset.id;
    if (e.shiftKey || e.ctrlKey) sel.has(id) ? sel.delete(id) : sel.add(id);
    else if (!sel.has(id)) sel = new Set([id]);
    drag = { type: 'move', last: h, pre: snapshot() };
  } else {
    if (!e.shiftKey && !e.ctrlKey) sel.clear();
    drag = { type: 'band', p0: q, p1: q, base: new Set(sel) };
  }
  renderSel(); renderIssues();
});
wrap.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });   // 中ボタンの自動スクロールを止める
wrap.addEventListener('pointermove', e => {
  if (!drag) return hover(e);
  if (drag.type === 'pan') { wrap.scrollLeft = drag.sl - (e.clientX - drag.cx); wrap.scrollTop = drag.st - (e.clientY - drag.cy); return; }
  const q = toBoard(e.clientX, e.clientY), h = snap(q);
  if (drag.type === 'wire') { drag.b = h; renderOverlay(); }
  else if (drag.type === 'band') {
    drag.p1 = q;
    const r = rectOf(drag.p0, drag.p1);
    sel = new Set(drag.base);
    for (const p of sheet.parts) { const b = bbox(p); if (b.x >= r.x && b.y >= r.y && b.x + b.w <= r.x + r.w && b.y + b.h <= r.y + r.h) sel.add(p.id); }
    renderSel();
  } else if (drag.type === 'end') {
    const o = drag.p[drag.end];
    if (o.x !== h.x || o.y !== h.y) { touch(); drag.p[drag.end] = h; live(); }
  } else if (drag.type === 'move') {
    const dx = h.x - drag.last.x, dy = h.y - drag.last.y;
    if (dx || dy) { touch(); moveSel(dx, dy); drag.last = h; live(); }
  }
});
function touch() { if (!drag.moved) { drag.moved = true; pushUndo(drag.pre); dirty = true; } }
function live() { res = Board.check(sheet, sheet._net); renderParts(); renderOverlay(); renderProps(); }
function endDrag() {
  const d = drag;
  drag = null;
  wrap.classList.remove('panning');
  if (!d) return;
  if (d.type === 'wire') {
    if (d.a.x !== d.b.x || d.a.y !== d.b.y) return edit(() => { const w = makePart('wire', d.a); w.b = d.b; sheet.parts.push(w); });
    return renderOverlay();
  }
  if (d.moved) refresh(); else renderSel();
}
wrap.addEventListener('pointerup', endDrag);
wrap.addEventListener('pointercancel', endDrag);
wrap.addEventListener('pointerleave', () => { if (!drag && hoverRoot >= 0) { hoverRoot = -1; $('#hoverInfo').textContent = ''; renderOverlay(); } });
function hover(e) {
  const h = snap(toBoard(e.clientX, e.clientY)), i = res.hole(h.x, h.y), r = i >= 0 ? res.find(i) : -1;
  $('#hoverInfo').textContent = i >= 0 ? `${rowName(h.y)}${h.x + 1}  ${res.pinText.get(`${h.x},${h.y}`) || ''}` : '';
  if (r !== hoverRoot) { hoverRoot = r; renderOverlay(); }
}
wrap.addEventListener('wheel', e => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  setZoom(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX, e.clientY);
}, { passive: false });
wrap.addEventListener('dragover', e => e.preventDefault());
wrap.addEventListener('drop', e => {
  e.preventDefault();
  const d = e.dataTransfer.getData('text/plain'), q = snap(toBoard(e.clientX, e.clientY));
  const at = { x: clamp(q.x, 0, sheet.board.cols - 1), y: clamp(q.y, 0, sheet.board.rows - 1) };
  if (d.startsWith('kind:')) addPart(d.slice(5), at);
  else if (d.startsWith('el:')) placeElement(d.slice(3), at);
  else if (e.dataTransfer.files[0]) openAnyFile(e.dataTransfer.files[0]);
});

/* ───────── パネル ───────── */
function renderPalette() {
  $('#palette').innerHTML = PALETTE.map(([kind, name]) => {
    const p = { id: 0, kind, ref: '', value: KINDS[kind].value || '', rot: 0, x: 0, y: 0, a: { x: 0, y: 0 }, b: { x: KINDS[kind].span || 0, y: 0 },
      bodyL: KINDS[kind].bodyL, bodyW: KINDS[kind].bodyW, pinout: (PINOUTS[kind] || [])[0], pitch: 1, label: 'IN', color: '#d63031' };
    if (!KINDS[kind].two) { delete p.a; delete p.b; }
    const b = bbox(p), m = kind === 'terminal' ? 22 : 4;
    return `<button draggable="true" data-kind="${kind}" title="${esc(KINDS[kind].label)}"><svg viewBox="${b.x - m} ${b.y - m} ${b.w + 2 * m + (kind === 'terminal' ? 20 : 0)} ${b.h + 2 * m}">${drawPart(p, true)}</svg><span>${name}</span></button>`;
  }).join('');
}
$('#palette').addEventListener('click', e => { const b = e.target.closest('[data-kind]'); if (b) addPart(b.dataset.kind, viewCenter()); });
$('#palette').addEventListener('dragstart', e => { const b = e.target.closest('[data-kind]'); if (b) e.dataTransfer.setData('text/plain', 'kind:' + b.dataset.kind); });

const row = (label, html) => `<label>${label}</label><div>${html}</div>`;
const options = (list, cur) => list.map(([v, t]) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(t)}</option>`).join('');
function renderProps() {
  const ps = selected(), el = $('#props');
  if (!ps.length) {
    el.innerHTML = `<h3>基板</h3>${row('横の穴数', `<input data-f="cols" type="number" min="4" max="120" value="${sheet.board.cols}">`)}${row('縦の穴数', `<input data-f="rows" type="number" min="4" max="120" value="${sheet.board.rows}">`)}
      <p class="note">上のボタンをクリック、または基板へドラッグで部品を追加。<br>配線は W キー(配線ツール)で穴から穴へドラッグ。</p>`;
    return;
  }
  if (ps.length > 1) { el.innerHTML = `<h3>${ps.length} 個を選択中</h3><div class="btns"><button data-cmd="rotate">90°回転</button><button data-cmd="del">削除</button></div>`; return; }
  const p = ps[0], k = KINDS[p.kind], net = sheet._net;
  let h = `<h3>${esc(k.label)}</h3>`;
  if (k.prefix) h += row('部品番号', `<input data-f="ref" value="${esc(p.ref)}">`);
  if (k.letters) h += row('RCL'.includes(k.letters) ? '値' : '品番', `<input data-f="value" value="${esc(p.value)}">`);
  if (k.two && p.kind !== 'wire') {
    const span = Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y);
    h += row('リード間隔', `${+span.toFixed(2)} 穴 (${(span * 2.54).toFixed(2)} mm)`);
    h += row(k.radial ? '本体の直径 mm' : '本体の長さ mm', `<input data-f="bodyL" type="number" step="0.1" min="0.5" value="${p.bodyL}">`);
    if (!k.radial) h += row('本体の太さ mm', `<input data-f="bodyW" type="number" step="0.1" min="0.5" value="${p.bodyW}">`);
    h += `<p class="note">両端の ● をドラッグするとリード間隔を変えられます${k.polar ? `（${k.pinNames[0]} 側 → ${k.pinNames[1]} 側）` : ''}</p>`;
  }
  if (p.kind === 'wire') h += row('色', `<select data-f="color">${options(Object.entries(WIRE_COLORS), p.color)}</select>`);
  if (PINOUTS[p.kind]) {
    h += row('ピン配置', `<select data-f="pinout">${options(PINOUTS[p.kind].map(s => [s, s.split('').join('-')]), p.pinout)}</select>`);
    h += row('ピン間隔', `<select data-f="pitch">${options([['1', '1穴 (2.54mm)'], ['2', '2穴 (5.08mm)']], String(p.pitch))}</select>`);
    h += '<p class="note">ピン配置は平らな面を手前にして左から。品番で異なるのでデータシートで確認してください</p>';
  }
  if (k.dip) {
    const ops = [['', '(なし)']].concat(net ? net.elements.filter(e => e.type === 'X' && e.nodes.length === 5).map(e => [e.name, `${e.name} (${e.sub})`]) : []);
    h += row('種類', `<select data-f="kind">${options([['opamp2', 'デュアル (TL072等)'], ['opamp1', 'シングル (TL071等)']], p.kind)}</select>`);
    h += row('ユニットA', `<select data-f="unit0">${options(ops, p.units[0])}</select>`);
    if (p.kind === 'opamp2') h += row('ユニットB', `<select data-f="unit1">${options(ops, p.units[1])}</select>`);
  }
  if (p.kind === 'terminal') {
    h += row('ネット名', `<input data-f="label" list="netNames" value="${esc(p.label)}"><datalist id="netNames">${(net ? ['GND', ...net.nodes] : []).map(n => `<option value="${esc(n)}">`).join('')}</datalist>`);
    h += '<p class="note">電源・ジャック・ポットなど基板の外へ配線する位置です。回路図のネット名(IN, OUT, VCC, GND など)を指定します</p>';
  }
  el.innerHTML = h + '<div class="btns"><button data-cmd="rotate">90°回転</button><button data-cmd="del">削除</button></div>';
}
$('#props').addEventListener('change', e => {
  const f = e.target.dataset.f, v = e.target.value;
  if (!f) return;
  if (f === 'cols' || f === 'rows') return edit(() => { sheet.board[f] = clamp(Math.round(+v) || 4, 4, 120); }, true);
  const p = selected()[0];
  if (!p) return;
  edit(() => {
    if (f === 'unit0' || f === 'unit1') p.units[+f[4]] = v;
    else if (f === 'bodyL' || f === 'bodyW') p[f] = clamp(+v || 1, 0.5, 50);
    else if (f === 'pitch') p.pitch = +v;
    else if (f === 'kind') { p.kind = v; if (v === 'opamp1') p.units[1] = ''; }
    else { p[f] = v.trim(); if (f === 'color') wireColor = v; }
  });
});

function typeLabel(e) {
  if (e.type === 'Q') return 'トランジスタ ' + Sim.getModel(sheet._net, e.model, ['NPN', 'PNP']).type;
  if (e.type === 'J') return 'JFET ' + (Sim.getModel(sheet._net, e.model, ['NJF', 'PJF']).type === 'PJF' ? 'P' : 'N');
  const k = Board.kindFor(e);
  return k ? KINDS[k].label.replace('オペアンプ', 'OPアンプ') : ({ V: '電圧源', I: '電流源', E: '制御電源', X: 'サブ回路' })[e.type] || e.type;
}
function valueLabel(e) {
  if ('RCL'.includes(e.type)) return Sim.fmt(e.value) + { R: 'Ω', C: 'F', L: 'H' }[e.type];
  if (e.type === 'V') return `${Sim.fmt(e.dc)}V${e.signal ? ' 信号' : ''}`;
  return e.model || e.sub || '';
}
function renderPartsList() {
  const net = sheet._net, box = $('#partsList');
  if (!net) { box.innerHTML = '<p class="empty">回路図(ネットリスト)がまだありません。<br>File → 回路図を取り込む、または Tools → サンプル回路 から始めてください。</p>'; return; }
  const selNames = new Set(selected().flatMap(p => [p.ref, ...(p.units || [])]).map(s => s.toUpperCase()));
  let h = '<table><thead><tr><th>No</th><th>Name</th><th>Type</th><th>Value</th><th></th></tr></thead><tbody>', n = 0, done = 0;
  net.elements.forEach((e, i) => {
    const kind = Board.kindFor(e), placed = res.placed.has(e.name), ext = Board.isExternal(e, sheet.offboard), canToggle = kind && !'VIE'.includes(e.type);
    if (kind && !ext) { n++; if (placed) done++; }
    const st = placed ? '<span class="st ok">配置済</span>'
      : ext ? `<span class="st ext"${canToggle ? ' data-toggle title="クリックで「未配置(基板に載せる)」に切替"' : ' title="基板の外につなぐ部品"'}>外付</span>`
      : '<span class="st todo" data-toggle title="クリックで「外付(基板の外)」に切替">未配置</span>';
    h += `<tr data-el="${esc(e.name)}" draggable="${!!kind && !placed}" class="${selNames.has(e.name.toUpperCase()) ? 'sel' : ''}" title="${kind && !placed ? '基板へドラッグ／ダブルクリックで配置' : ''}">` +
      `<td>${i + 1}</td><td>${esc(e.name)}</td><td>${esc(typeLabel(e))}</td><td>${esc(valueLabel(e))}</td><td>${st}</td></tr>`;
  });
  box.innerHTML = h + `</tbody><tfoot><tr><td colspan="5">基板に配置 ${done} / ${n}</td></tr></tfoot></table>`;
}
$('#partsList').addEventListener('click', e => {
  const tr = e.target.closest('tr[data-el]');
  if (!tr) return;
  const name = tr.dataset.el;
  if (e.target.closest('[data-toggle]')) return edit(() => { sheet.offboard[name] = !Board.isExternal(sheet._net.elements.find(x => x.name === name), sheet.offboard); });
  const p = res.placed.has(name) && findByEl(name);
  if (p) { sel = new Set([p.id]); renderSel(); scrollToHole(partPins(p)[0]); }
});
$('#partsList').addEventListener('dblclick', e => { const tr = e.target.closest('tr[data-el]'); if (tr) placeElement(tr.dataset.el, viewCenter()); });
$('#partsList').addEventListener('dragstart', e => { const tr = e.target.closest('tr[data-el]'); if (tr) e.dataTransfer.setData('text/plain', 'el:' + tr.dataset.el); });

function renderIssues() {
  const n = t => res.issues.filter(i => i.level === t).length;
  $('#issueCount').innerHTML = `<span style="color:var(--err)">✖ ${n('error')}</span>　<span style="color:var(--warn)">▲ ${n('warn')}</span>`;
  $('#issues').innerHTML = res.issues.map((it, i) => `<li class="${it.level}${i === focusIssue ? ' focus' : ''}" data-i="${i}">${esc(it.msg)}</li>`).join('');
}
$('#issues').addEventListener('click', e => {
  const li = e.target.closest('li');
  if (!li) return;
  focusIssue = +li.dataset.i;
  const it = res.issues[focusIssue];
  sel = new Set(it.parts); renderSel(); renderIssues();
  if (it.holes.length) scrollToHole(it.holes[0]);
});

function renderSchem() {
  const net = sheet._net;
  let h = sheet.image ? `<img id="schemImg" src="${esc(sheet.image)}" alt="回路図" title="クリックで拡大">` : '';
  if (net) h += net.warnings.map(w => `<div class="warn">▲ ${esc(w)}</div>`).join('') +
    `<details${sheet.image ? '' : ' open'}><summary>ネットリスト${net.title ? '：' + esc(net.title) : ''}</summary><pre>${esc(sheet.netlist)}</pre></details>`;
  $('#schem').innerHTML = h || '<p class="empty">回路図の画像(PNG/JPG)とネットリストを取り込めます。画像は組み立て時の参照用です。</p>';
}
$('#schem').addEventListener('click', e => { if (e.target.id === 'schemImg') dialog(`<img src="${esc(sheet.image)}" alt="回路図">`); });

function renderTabs() {
  $('#tabs').innerHTML = doc.sheets.map((s, i) => `<button class="tab${i === doc.active ? ' on' : ''}" data-i="${i}" title="ダブルクリックで名前を変更">${esc(s.name)}</button>`).join('');
}
$('#tabs').addEventListener('click', e => { const b = e.target.closest('.tab'); if (b && +b.dataset.i !== doc.active) switchSheet(+b.dataset.i); });
$('#tabs').addEventListener('dblclick', e => {
  const b = e.target.closest('.tab');
  if (!b) return;
  const s = doc.sheets[+b.dataset.i], n = prompt('シート名', s.name);
  if (n && n.trim()) { s.name = n.trim().slice(0, 40); dirty = true; renderTabs(); renderTitle(); }
});
function switchSheet(i) {
  doc.active = i; sheet = doc.sheets[i];
  sel.clear(); focusIssue = -1; hoverRoot = -1; drag = null;
  resetSound(); refresh(true); zoomFit();
}
function renderTitle() {
  const f = $('#filename');
  f.textContent = `${fileName} — ${sheet.name}`; f.classList.toggle('dirty', dirty);
  document.title = `${dirty ? '● ' : ''}${fileName} - UniBoard FX`;
  $('#tSelect').classList.toggle('on', tool === 'select'); $('#tWire').classList.toggle('on', tool === 'wire'); $('#tHand').classList.toggle('on', tool === 'hand');
  wrap.classList.toggle('wire', tool === 'wire'); wrap.classList.toggle('pan', tool === 'hand' || spaceDown);
  for (const k in opt) document.querySelector(`.chk[data-cmd="${k}"]`).classList.toggle('on', opt[k]);
  const nw = sheet.parts.filter(p => p.kind === 'wire').length;
  $('#status').textContent = `基板 ${sheet.board.cols}×${sheet.board.rows} 穴 ／ 部品 ${sheet.parts.length - nw} ／ 配線 ${nw}`;
}

/* ───────── メニュー・キー ───────── */
const closeMenus = () => document.querySelectorAll('.menu.open').forEach(m => m.classList.remove('open'));
document.addEventListener('click', e => {
  const m = e.target.closest('.menu > button');
  if (m) { const open = m.parentElement.classList.contains('open'); closeMenus(); if (!open) m.parentElement.classList.add('open'); return; }
  const c = e.target.closest('[data-cmd], [data-sample]');
  if (c) { closeMenus(); c.dataset.cmd ? CMD[c.dataset.cmd]() : loadSample(c.dataset.sample); return; }
  if (!e.target.closest('.menu')) closeMenus();
});
document.querySelectorAll('.menu > button').forEach(b => b.addEventListener('mouseenter', () => {
  if (document.querySelector('.menu.open') && !b.parentElement.classList.contains('open')) { closeMenus(); b.parentElement.classList.add('open'); }
}));
document.addEventListener('keydown', e => {
  if (e.target.closest('input, textarea, select') || $('#dlg').open) return;
  const c = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  const cmd = c ? { z: e.shiftKey ? 'redo' : 'undo', y: 'redo', c: 'copy', x: 'cut', v: 'paste', d: 'dup', a: 'selAll', s: e.shiftKey ? 'saveAs' : 'save', o: 'open' }[k]
    : { delete: 'del', backspace: 'del', r: 'rotate', w: 'toolWire', v: 'toolSelect', h: 'toolHand', '+': 'zoomIn', ';': 'zoomIn', '=': 'zoomIn', '-': 'zoomOut', '0': 'zoomFit' }[k];
  if (cmd) { e.preventDefault(); return CMD[cmd](); }
  if (e.key === 'Escape') { closeMenus(); setTool('select'); drag = null; sel.clear(); renderSel(); }
  if (e.key === ' ') { spaceDown = true; wrap.classList.add('pan'); e.preventDefault(); }
  const a = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
  if (a && sel.size) { e.preventDefault(); const n = e.shiftKey ? 5 : 1; edit(() => moveSel(a[0] * n, a[1] * n)); }
});
document.addEventListener('keyup', e => { if (e.key === ' ') { spaceDown = false; wrap.classList.toggle('pan', tool === 'hand'); } });
addEventListener('beforeunload', e => { if (dirty) e.preventDefault(); });

const toggle = k => { opt[k] = !opt[k]; renderParts(); renderOverlay(); renderTitle(); };
const CMD = {
  new() { if (confirmDiscard()) newDoc(); },
  open: openDoc, save: () => saveDoc(false), saveAs: () => saveDoc(true),
  importNet: () => pickFile('.cir,.net,.sp,.spi,.txt,.drawio,.xml,.asc,.kicad_sch', f => f.text().then(importText)),
  pasteNet: () => dialog('<h3>ネットリストを貼り付け</h3><p>LTspice なら View → SPICE Netlist の内容をそのまま貼り付けます。draw.io の図は Extras → Edit Diagram の XML でも取り込めます。</p><textarea id="netText" spellcheck="false" placeholder="* タイトル&#10;R1 IN OUT 10k&#10;..."></textarea>',
    [['取り込む', () => importText($('#netText').value)]]),
  importImg: () => pickFile('image/*', loadImage),
  csv: exportCsv,
  undo: () => undoRedo(sheet._undo, sheet._redo), redo: () => undoRedo(sheet._redo, sheet._undo),
  cut() { copySel(); CMD.del(); }, copy: copySel, paste: pasteClip, dup() { copySel(); pasteClip(); },
  del() { if (sel.size) edit(() => { sheet.parts = sheet.parts.filter(p => !sel.has(p.id)); sel.clear(); }); },
  selAll() { sel = new Set(sheet.parts.map(p => p.id)); renderSel(); },
  rotate: rotateSel,
  rats: () => toggle('rats'), labels: () => toggle('labels'), marks: () => toggle('marks'),
  toolSelect: () => setTool('select'), toolWire: () => setTool('wire'), toolHand: () => setTool('hand'),
  placeAll, soundcheck: soundCheck,
  toggleLeft: () => document.body.classList.toggle('hide-left'), toggleRight: () => document.body.classList.toggle('hide-right'),
  zoomIn: () => setZoom(zoom * 1.25), zoomOut: () => setZoom(zoom / 1.25), zoomFit,
  addSheet() { doc.sheets.push(newSheet(`シート${doc.sheets.length + 1}`)); dirty = true; switchSheet(doc.sheets.length - 1); },
  delSheet() {
    if (doc.sheets.length < 2) return alert('最後のシートは削除できません');
    if (!confirm(`「${sheet.name}」を削除しますか？（元に戻せません）`)) return;
    doc.sheets.splice(doc.active, 1); dirty = true; switchSheet(Math.min(doc.active, doc.sheets.length - 1));
  },
  help: showHelp,
};

/* ───────── ファイル ───────── */
const confirmDiscard = () => !dirty || confirm('保存していない変更があります。破棄してよろしいですか？');
function pickFile(accept, cb) { const i = document.createElement('input'); i.type = 'file'; i.accept = accept; i.onchange = () => i.files[0] && cb(i.files[0]); i.click(); }
function download(name, data, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function dialog(html, btns = []) {
  const d = $('#dlg');
  $('#dlgBody').innerHTML = html;
  $('#dlgBtns').innerHTML = btns.map(([l], i) => `<button value="${i}"${i ? '' : ' class="primary"'}>${l}</button>`).join('') + '<button value="cancel">閉じる</button>';
  d.returnValue = 'cancel';
  d.onclose = () => { const b = btns[+d.returnValue]; if (b) b[1](); };
  d.showModal();
}
function newDoc() { doc = { sheets: [newSheet('シート1')], active: 0 }; fileName = '無題'; fileHandle = null; dirty = false; switchSheet(0); }
const FILE_TYPES = [{ description: 'UniBoard FX', accept: { 'application/json': ['.ubfx'] } }];
async function saveDoc(as) {
  const data = JSON.stringify({ app: 'UniBoardFX', version: 1, active: doc.active, sheets: doc.sheets }, (k, v) => k[0] === '_' ? undefined : v);
  if (window.showSaveFilePicker) {
    try {
      if (as || !fileHandle) fileHandle = await showSaveFilePicker({ suggestedName: fileName + '.ubfx', types: FILE_TYPES });
      const w = await fileHandle.createWritable(); await w.write(data); await w.close();
      fileName = fileHandle.name.replace(/\.ubfx$/i, ''); dirty = false; renderTitle(); return;
    } catch (err) { if (err.name === 'AbortError') return; fileHandle = null; }
  }
  download(fileName + '.ubfx', data, 'application/json'); dirty = false; renderTitle();
}
async function openDoc() {
  if (!confirmDiscard()) return;
  if (window.showOpenFilePicker) {
    try { const [h] = await showOpenFilePicker({ types: FILE_TYPES }); loadDocText(await (await h.getFile()).text(), h.name); fileHandle = h; return; }
    catch (err) { if (err.name === 'AbortError') return; }
  }
  pickFile('.ubfx,.json', f => f.text().then(t => loadDocText(t, f.name)));
}
function loadDocText(text, name) {
  let d;
  try { d = JSON.parse(text); } catch { return alert('ファイルを読み込めませんでした'); }
  if (!d || !Array.isArray(d.sheets) || !d.sheets.length) return alert('UniBoard FX のファイルではありません');
  doc = { sheets: d.sheets.slice(0, 50).map(loadSheet), active: 0 };
  doc.active = clamp(d.active | 0, 0, doc.sheets.length - 1);
  fileName = name.replace(/\.(ubfx|json)$/i, ''); fileHandle = null; dirty = false; switchSheet(doc.active);
}
function openAnyFile(f) {
  if (/^image\//.test(f.type)) loadImage(f);
  else if (/\.ubfx$/i.test(f.name)) { if (confirmDiscard()) f.text().then(t => loadDocText(t, f.name)); }
  else if (/^audio\//.test(f.type)) loadAudio(f);
  else f.text().then(importText);
}
// draw.io の図（mxfile / mxGraphModel）なら SPICE ネットリストに変換してから取り込む
async function importText(text) {
  if (!/^\s*(<\?xml[^>]*>\s*)?<(mxfile|mxGraphModel)\b/.test(text)) return importNetlist(text);
  try { importNetlist((await Drawio.toSpice(text)).text); }
  catch (err) { alert(`draw.io の図を回路として読めませんでした。\n${err.message}`); }
}
function importNetlist(text) {
  if (/^\s*(Version 4|\(kicad_sch)/.test(text))
    return alert('これは回路図の編集ファイル(.asc / .kicad_sch)です。\nLTspice は View → SPICE Netlist、KiCad はシミュレーション用ネットリスト(.cir)を書き出して取り込んでください。');
  const net = Sim.parseNetlist(text);
  if (!net.elements.length) return alert('素子が見つかりませんでした。SPICE ネットリスト形式か確認してください。');
  if (sheet.netlist && !confirm('このシートの回路図を置き換えますか？（基板の部品はそのまま残ります）')) return;
  sheet.netlist = text; sheet._net = net; sheet.offboard = {}; sheet.simIn = ''; sheet.simOut = '';
  for (const e of net.elements) if (/POT|^VR/i.test(e.name)) sheet.offboard[e.name] = true;   // ポットは基板外が前提
  dirty = true; resetSound(); refresh(true);
}
function loadSample(i) {
  const name = Object.keys(Sim.SAMPLES)[i];
  if (sheet.netlist || sheet.parts.length) { doc.sheets.push(newSheet(name.split(' ')[0])); switchSheet(doc.sheets.length - 1); }
  else { sheet.name = name.split(' ')[0]; renderTabs(); }
  importNetlist(Sim.SAMPLES[name]);
}
function loadImage(f) {
  if (f.size > 8e6) return alert('画像が大きすぎます（8MBまで）');
  const r = new FileReader();
  r.onload = () => { if (/^data:image\//.test(r.result)) { sheet.image = r.result; dirty = true; renderSchem(); renderTitle(); } };
  r.readAsDataURL(f);
}
function exportCsv() {
  const net = sheet._net;
  if (!net) return alert('回路図(ネットリスト)がまだありません');
  const q = s => `"${String(s).replace(/^[=+\-@]/, "'$&").replace(/"/g, '""')}"`;   // Excel の数式扱いを防ぐ
  const lines = [['No', 'Name', 'Type', 'Value', '状態'].map(q).join(',')];
  net.elements.forEach((e, i) => lines.push([i + 1, e.name, typeLabel(e), valueLabel(e),
    res.placed.has(e.name) ? '配置済' : Board.isExternal(e, sheet.offboard) ? '外付' : '未配置'].map(q).join(',')));
  download(`${fileName}_${sheet.name}_部品リスト.csv`, '﻿' + lines.join('\r\n'), 'text/csv');
}
function showHelp() {
  dialog(`<h3>使い方</h3><ol>
    <li><b>回路図を取り込む</b>：File → 回路図(ネットリスト)を取り込む。LTspice は View → SPICE Netlist、KiCad はシミュレーション用ネットリスト。draw.io の Electrical 図形で描いた回路図(.drawio)もそのまま取り込めます（値は部品の近くのテキストから読みます）。Tools → サンプル回路 でも試せます。回路図の画像は参照用に別途取り込めます。</li>
    <li><b>部品を置く</b>：Parts List の行を基板へドラッグ（ダブルクリックでも可）。「一括配置」で全部並べることもできます。</li>
    <li><b>サイズを変える</b>：2本足の部品は両端の ● をドラッグでリード間隔を変更。本体寸法・ピン配置はサイドバーで編集。</li>
    <li><b>配線する</b>：W キー(配線ツール)で穴から穴へドラッグ。青い点線(ラッツネスト)はまだつながっていない所です。</li>
    <li><b>基板の外へつなぐ</b>：電源・ジャック・ポットへの配線位置に「外部端子」を置き、ネット名(IN, OUT, VCC, GND…)を設定。</li>
    <li><b>エラー判定</b>：未接続・ショート・値違い・極性逆などを表示。項目をクリックすると基板上で場所が光ります。</li>
    <li><b>SoundCheck</b>：ギターの音が「回路図どおりの回路」と「基板の配線どおりの回路」を通るとどう変わるかを計算し、両者が同じ音かを自動で判定します。「手本の音…」で狙った音の録音を読み込むと、音色(帯域バランス)と歪み感がどれだけ近いかも判定します。手本はエフェクターの出力をライン(DI)で録ったものを使ってください（アンプ・マイク経由の録音は比べられません）。波形の重ね表示と再生で聴き比べもできます（部品が全部配置されるまで基板の音は計算しません）。</li></ol>
    <h3>ショートカット</h3><table>
    <tr><td>V / W / H</td><td>選択ツール / 配線ツール / ハンドツール(表示位置を移動)</td></tr><tr><td>R</td><td>90°回転</td></tr>
    <tr><td>Delete</td><td>削除</td></tr><tr><td>矢印 (+Shift)</td><td>1穴 (5穴) 移動</td></tr>
    <tr><td>Ctrl+Z / Ctrl+Y</td><td>元に戻す / やり直し</td></tr><tr><td>Ctrl+C / X / V / D</td><td>コピー / 切り取り / 貼り付け / 複製</td></tr>
    <tr><td>Shift+クリック、ドラッグ</td><td>複数選択、範囲選択</td></tr><tr><td>Ctrl+ホイール</td><td>ズーム</td></tr>
    <tr><td>スペース+ドラッグ / 中ボタン</td><td>表示の移動</td></tr><tr><td>Ctrl+S / Ctrl+O</td><td>保存 / 開く</td></tr></table>`);
}

/* ───────── 音 ───────── */
const snd = { input: null, output: null, board: null, ref: null, view: 'wave', file: null, ctx: null, src: null, playing: '', job: null, pos: 0.1 };
// 内蔵ギター音（Karplus-Strong 合成。毎回同じ音になるよう乱数は固定）
function guitar() {
  let seed = 12345;
  const rnd = () => (seed = seed * 16807 % 2147483647) / 1073741823.5 - 1;
  const notes = [[0, 40, 1.1], [0.012, 47, 1.1], [0.024, 52, 1.1], [1.2, 52, 0.25], [1.45, 55, 0.25], [1.7, 57, 0.4],
    [2.2, 45, 1.3], [2.212, 52, 1.3], [2.224, 57, 1.3]];   // [開始秒, MIDIノート, 長さ]: E5 → 単音 → A5
  const out = new Float32Array(Math.ceil(3.8 * RATE));
  for (const [t0, m, dur] of notes) {
    const N = Math.round(RATE / (440 * 2 ** ((m - 69) / 12))), buf = Float32Array.from({ length: N }, rnd);
    for (let i = 1; i < N; i++) buf[i] = (buf[i] + buf[i - 1]) / 2;
    const s0 = Math.round(t0 * RATE), end = dur * RATE;
    for (let i = 0; i < end + 0.05 * RATE && s0 + i < out.length; i++) {
      const j = i % N, y = buf[j];
      out[s0 + i] += y * (i < end ? 1 : 1 - (i - end) / (0.05 * RATE));   // 最後はミュート
      buf[j] = 0.996 * (y + buf[(j + 1) % N]) / 2;
    }
  }
  return normalize(out);
}
function normalize(d) { let pk = 1e-9; for (const v of d) pk = Math.max(pk, Math.abs(v)); for (let i = 0; i < d.length; i++) d[i] /= pk; return d; }
const rms = d => { let s = 0; for (const v of d) s += v * v; return Math.sqrt(s / d.length) || 1e-12; };
function highpass(d) {   // 出力のDC(バイアス電圧)を除く 5Hz ハイパス
  const a = 1 / (1 + 2 * Math.PI * 5 / RATE);
  let px = d[0], py = 0;
  for (let i = 0; i < d.length; i++) { const x = d[i]; py = a * (py + x - px); px = x; d[i] = py; }
}
// 音声ファイルを 48kHz モノラルに（長ければ先頭 MAX_SEC 秒）
async function decodeFile(f) {
  const ab = await new OfflineAudioContext(1, 1, RATE).decodeAudioData(await f.arrayBuffer());   // 48kHz に変換される
  const n = Math.min(ab.length, MAX_SEC * RATE), d = new Float32Array(n);
  for (let c = 0; c < ab.numberOfChannels; c++) { const ch = ab.getChannelData(c); for (let i = 0; i < n; i++) d[i] += ch[i] / ab.numberOfChannels; }
  return { data: normalize(d), name: f.name + (ab.length > n ? `（先頭${MAX_SEC}秒）` : '') };
}
async function loadAudio(f) {
  try { snd.file = await decodeFile(f); setInput('file'); }
  catch { alert('この音声ファイルは読み込めませんでした'); setInput(snd.file ? 'file' : 'guitar'); }
}
// 手本（狙った音の録音）
async function loadRef(f) {
  try { snd.ref = await decodeFile(f); } catch { return alert('この音声ファイルは読み込めませんでした'); }
  let clip = 0;   // 最大値に張り付いたサンプルが多ければ録音が音割れしている
  for (const v of snd.ref.data) if (Math.abs(v) > 0.999) clip++;
  snd.ref.clipped = clip > Math.max(10, snd.ref.data.length * 5e-4);
  $('#refName').textContent = $('#refName').title = snd.ref.name;
  refVerdict(); drawSound();
}
$('#refBtn').addEventListener('click', () => pickFile('audio/*,.wav,.mp3,.ogg,.flac,.m4a', loadRef));
function setInput(src) {
  snd.input = src === 'file' ? snd.file.data : guitar();
  $('#srcSel').innerHTML = options([['guitar', '内蔵ギター(リフ)']].concat(snd.file ? [['file', snd.file.name]] : [], [['open', '音声ファイルを開く…']]), src);
  resetSound();
}
$('#srcSel').addEventListener('change', e => {
  if (e.target.value === 'open') { e.target.value = snd.input === (snd.file && snd.file.data) ? 'file' : 'guitar'; pickFile('audio/*,.wav,.mp3,.ogg,.flac,.m4a', loadAudio); }
  else setInput(e.target.value);
});
function resetSound() {
  if (snd.job) snd.job.cancel = true;
  stopPlay(); snd.output = snd.board = null;
  verdict(''); refVerdict();
  simStatus('SoundCheck を押すと、回路図と基板の配線それぞれで音を計算して比べます');
  drawSound();
}
function simStatus(msg, err) { const s = $('#simStatus'); s.textContent = msg; s.classList.toggle('err', !!err); }
function verdict(text, cls = '', id = '#verdict') { const v = $(id); v.textContent = text; v.className = 'verdict ' + cls; }
function renderSimSel() {
  const net = sheet._net, vs = net ? net.elements.filter(e => e.type === 'V') : [], nodes = net ? net.nodes : [];
  if (!vs.some(e => e.name === sheet.simIn)) sheet.simIn = (vs.find(e => e.signal) || vs.find(e => /IN/i.test(e.name)) || {}).name || '';
  if (!nodes.includes(sheet.simOut)) sheet.simOut = nodes.find(n => n === 'OUT') || nodes.find(n => /OUT/.test(n)) || nodes[nodes.length - 1] || '';
  $('#inSel').innerHTML = options(vs.map(e => [e.name, e.name]), sheet.simIn) || '<option value="">(なし)</option>';
  $('#outSel').innerHTML = options(nodes.map(n => [n, n]), sheet.simOut) || '<option value="">(なし)</option>';
}
$('#inSel').addEventListener('change', e => { sheet.simIn = e.target.value; dirty = true; resetSound(); renderTitle(); });
$('#outSel').addEventListener('change', e => { sheet.simOut = e.target.value; dirty = true; resetSound(); renderTitle(); });

const MATCH_DB = -26;   // 基板と回路図の音の差(誤差のRMS比)がこれ未満なら「同じ音」と判定。厳しくするなら下げる
// 過渡解析を1回。画面が固まらないよう少しずつ計算する
async function simulate(net, output, sig, job, label) {
  const sim = Sim.prepare(net, { input: sheet.simIn, output, rate: RATE }), out = new Float32Array(sig.length);
  for (let i = 0; i < sig.length && !job.cancel;) {
    const t = performance.now();
    while (i < sig.length && performance.now() - t < 30) { const e = Math.min(i + 256, sig.length); sim.run(sig, out, i, e); i = e; }
    $('#soundcheck').textContent = `${label} ${Math.round(i / sig.length * 100)}%`;
    await new Promise(r => { const c = new MessageChannel(); c.port1.onmessage = r; c.port2.postMessage(0); });   // setTimeout は裏に回ると1秒間隔に制限される
  }
  highpass(out);
  return { out, sim };
}
// 基板の音が回路図の音とどれだけ違うか → [判定文, class]
function compare(a, b, changed) {
  const ra = rms(a), lvl = 20 * Math.log10(rms(b) / ra);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  const d = 20 * Math.log10(Math.sqrt(s / a.length) / ra + 1e-12), ds = d < -99 ? 'ほぼ0' : `${d.toFixed(1)} dB`;
  const note = changed.length ? `　値を変えた部品: ${changed.join(', ')}` : '';
  if (lvl < -40) return [`✖ 基板からほとんど音が出ていません（回路図より ${lvl.toFixed(0)} dB）${note}`, 'ng'];
  return d < MATCH_DB ? [`✔ 回路図どおりの音です（差 ${ds}）${note}`, 'ok'] : [`✖ 回路図と音が違います（差 ${ds}／音量 ${lvl >= 0 ? '+' : ''}${lvl.toFixed(1)} dB）${note}`, 'ng'];
}
const TONE_DB = 3, CREST_DB = 2;   // 手本に「近い」とみなす音色の差・歪み感の差(dB)。厳しくするなら下げる
const profCache = new WeakMap();
const profile = d => { if (!profCache.has(d)) profCache.set(d, Sim.toneProfile(d, RATE)); return profCache.get(d); };
// 手本と比べた判定（基板の音があれば基板、なければ回路図の音）
function refVerdict() {
  const x = snd.board || snd.output;
  if (!snd.ref || !x) return verdict(snd.ref ? '手本の音を読み込みました。SoundCheck を押すと比べます（手本はライン(DI)録音を想定）' : '', '', '#verdictRef');
  const c = Sim.compareTone(profile(snd.ref.data), profile(x)), hints = [];
  for (const [k, name] of [['low', '低域'], ['mid', '中域'], ['high', '高域']])
    if (Math.abs(c[k]) >= 2) hints.push(`${name}が${c[k] > 0 ? '多い' : '少ない'}(${c[k] > 0 ? '+' : ''}${c[k].toFixed(1)}dB)`);
  if (Math.abs(c.crest) >= CREST_DB) hints.push(c.crest < 0 ? '歪み・圧縮が強い' : '歪み・圧縮が弱い');
  const ok = c.tone < TONE_DB && Math.abs(c.crest) < CREST_DB;
  verdict(`${ok ? '✔' : '✖'} 手本と比べて${snd.board ? '基板' : '回路図'}の音は${ok ? '近い音です' : '違います'}（音色の差 ${c.tone.toFixed(1)} dB／歪み感の差 ${c.crest >= 0 ? '+' : ''}${c.crest.toFixed(1)} dB）${hints.length ? '：' + hints.join('、') : ''}` +
    (snd.ref.clipped ? '　▲手本の録音が音割れしている可能性があります（歪み感の比較は参考程度に）' : ''),
    ok ? 'ok' : 'ng', '#verdictRef');
}
async function soundCheck() {
  if (snd.job) { snd.job.cancel = true; return; }
  if (!sheet._net) return simStatus('先に回路図(ネットリスト)を取り込んでください', true);
  resetSound();
  const lvl = clamp(+$('#level').value || 0.5, 0.001, 10), sig = Float64Array.from(snd.input, v => v * lvl);
  const job = snd.job = { cancel: false }, btn = $('#soundcheck'), t0 = performance.now(), notes = [];
  btn.classList.add('busy');
  simStatus('計算中…（もう一度押すと中止）');
  try {
    let a;
    try { a = await simulate(sheet._net, sheet.simOut, sig, job, '回路図'); } catch (err) { return simStatus(err.message, true); }
    if (job.cancel) return simStatus('中止しました');
    snd.output = a.out;
    if (a.sim.fails) notes.push(`収束しなかった点 ${a.sim.fails}`);
    notes.push(...a.sim.warnings);
    const bn = Board.boardNetlist(sheet, sheet._net, res);
    if (bn.error) verdict('▲ ' + bn.error, 'warn');
    else {
      notes.push(...bn.warnings);
      try {
        const b = await simulate(bn.net, bn.output, sig, job, '基板');
        if (job.cancel) return simStatus('中止しました');
        snd.board = b.out;
        verdict(...compare(a.out, b.out, bn.changed));
      } catch (err) {
        verdict(`▲ 基板の配線では計算できませんでした（${err.message}）。電源のショートや未接続をエラー判定で確認してください`, 'warn');
      }
    }
    const db = 20 * Math.log10(rms(a.out) / rms(sig));
    refVerdict();
    simStatus(`完了 ${((performance.now() - t0) / 1000).toFixed(1)}秒 ／ ${sheet.simIn} → ${sheet.simOut} ／ 音量 ${db >= 0 ? '+' : ''}${db.toFixed(1)} dB` + notes.map(m => ' ／ ▲' + m).join(''));
    drawSound();
  } finally {
    btn.classList.remove('busy'); btn.textContent = 'SoundCheck';
    if (snd.job === job) snd.job = null;
  }
}
const PLAY_BTN = { in: '#playIn', out: '#playOut', board: '#playBoard', ref: '#playRef' };
function play(which) {
  const data = { in: snd.input, out: snd.output, board: snd.board, ref: snd.ref && snd.ref.data }[which], was = snd.playing;
  stopPlay();
  if (was === which) return;
  if (!data) return simStatus(which === 'ref' ? '先に「手本の音…」で録音を読み込んでください' : which === 'board' && snd.output ? '基板の音は計算できていません（判定欄を確認してください）' : '先に SoundCheck を押してください');
  snd.ctx = snd.ctx || new AudioContext();
  let pk = 1e-9;
  for (const v of data) pk = Math.max(pk, Math.abs(v));
  // 入力と出力は同じくらいの音量にそろえる。基板は回路図と同じ倍率にして音量差も聞こえるようにする
  const g = Math.min(0.15 / rms(which === 'board' ? snd.output : data), 0.95 / pk);
  const b = snd.ctx.createBuffer(1, data.length, RATE), ch = b.getChannelData(0);
  for (let i = 0; i < data.length; i++) ch[i] = data[i] * g;
  const s = snd.src = snd.ctx.createBufferSource();
  s.buffer = b; s.connect(snd.ctx.destination); s.start();
  s.onended = () => { if (snd.src === s) stopPlay(); };
  snd.playing = which;
  $(PLAY_BTN[which]).textContent = '■ 停止';
}
function stopPlay() {
  if (snd.src) { try { snd.src.stop(); } catch { /* 停止済み */ } snd.src = null; }
  snd.playing = '';
  document.querySelectorAll('.play').forEach(b => { b.textContent = '▶ ' + b.dataset.label; });
}
for (const k in PLAY_BTN) $(PLAY_BTN[k]).addEventListener('click', () => play(k));
for (const id of ['#cvIn', '#cvOut']) $(id).addEventListener('click', e => { snd.pos = clamp(e.offsetX / e.currentTarget.clientWidth, 0, 1); drawSound(); });

function prep(cv) {
  const r = devicePixelRatio || 1, g = cv.getContext('2d');
  cv.width = cv.clientWidth * r; cv.height = cv.clientHeight * r;
  g.scale(r, r);
  g.strokeStyle = css('--line'); g.lineWidth = 1;
  g.beginPath(); g.moveTo(0, cv.clientHeight / 2); g.lineTo(cv.clientWidth, cv.clientHeight / 2); g.stroke();
  return g;
}
// list: [[データ, 色], ...] を同じスケールで重ねて描く
function drawWave(cv, list) {
  const g = prep(cv), w = cv.clientWidth, h = cv.clientHeight;
  list = list.filter(([d]) => d);
  if (!list.length) return;
  let pk = 1e-9;
  for (const [d] of list) for (const v of d) pk = Math.max(pk, Math.abs(v));
  const len = list[0][0].length, step = len / w;
  g.globalAlpha = list.length > 1 ? 0.7 : 1;
  for (const [data, color] of list) {
    g.strokeStyle = color; g.beginPath();
    for (let x = 0; x < w; x++) {
      let lo = Infinity, hi = -Infinity;
      for (let i = Math.floor(x * step), e = Math.max(i + 1, Math.floor((x + 1) * step)); i < e && i < len; i++) { lo = Math.min(lo, data[i]); hi = Math.max(hi, data[i]); }
      g.moveTo(x + 0.5, h / 2 - hi / pk * h * 0.46); g.lineTo(x + 0.5, h / 2 - lo / pk * h * 0.46 + 0.5);
    }
    g.stroke();
  }
  g.globalAlpha = 1; g.fillStyle = '#2a6df433';
  g.fillRect(snd.pos * w, 0, Math.max(2, DETAIL * RATE / len * w), h);
}
$('#viewSel').addEventListener('click', e => {
  const b = e.target.closest('[data-view]');
  if (!b) return;
  snd.view = b.dataset.view;
  for (const x of $('#viewSel').children) x.classList.toggle('on', x === b);
  drawDetail();
});
// 音色: 帯域ごとの音量バランスを重ねる（各カーブは平均を0にそろえて形だけ比べる）
function drawTone(g, w, h) {
  const curves = [[snd.input, '--wave-in', '入力'], [snd.output, '--wave-out', '回路図'], [snd.board, '--wave-board', '基板'], [snd.ref && snd.ref.data, '--wave-ref', '手本']].filter(c => c[0]);
  const fx = f => Math.log(f / 80) / Math.log(10000 / 80) * w;
  g.font = '9px system-ui'; g.lineWidth = 1;
  for (const f of [100, 300, 1000, 3000, 8000]) {
    g.strokeStyle = css('--line'); g.beginPath(); g.moveTo(fx(f), 0); g.lineTo(fx(f), h); g.stroke();
    g.fillStyle = css('--muted'); g.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), fx(f) + 2, h - 2);
  }
  let lx = 4;
  for (const [d, color, label] of curves) {
    const p = profile(d), m = p.db.reduce((a, b) => a + b, 0) / p.db.length;
    g.strokeStyle = css(color); g.lineWidth = 1.8; g.setLineDash(label === '基板' ? [5, 4] : []); g.beginPath();
    p.db.forEach((v, j) => { const x = fx(p.fc[j]), y = clamp(h / 2 - (v - m) / 20 * (h / 2 - 6), 2, h - 2); j ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.stroke(); g.setLineDash([]);
    g.fillStyle = css(color); g.fillText('■' + label, lx, 11); lx += g.measureText('■' + label).width + 6;
  }
  g.fillStyle = css('--muted'); g.fillText('音色 ±20dB', lx, 11);
}
function drawDetail() {
  const cv = $('#cvDetail'), g = prep(cv), w = cv.clientWidth, h = cv.clientHeight, a = snd.input;
  if (snd.view === 'tone') return drawTone(g, w, h);
  if (!a) return;
  const n = Math.round(DETAIL * RATE), s0 = clamp(Math.floor(snd.pos * a.length), 0, Math.max(0, a.length - n));
  const peak = (...ds) => { let pk = 1e-9; for (const d of ds) if (d) for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(d[s0 + i] || 0)); return pk; };
  const line = (d, color, pk, dash) => {
    if (!d) return;
    g.strokeStyle = color; g.lineWidth = 1.5; g.setLineDash(dash || []); g.beginPath();
    for (let i = 0; i < n; i++) { const x = i / (n - 1) * w, y = h / 2 - (d[s0 + i] || 0) / pk * h * 0.4; i ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.stroke();
  };
  const po = peak(snd.output, snd.board);   // 回路図と基板は同じ倍率で比べる
  line(a, css('--wave-in'), peak(a)); line(snd.output, css('--wave-out'), po); line(snd.board, css('--wave-board'), po, [5, 4]);
  g.setLineDash([]); g.fillStyle = css('--muted'); g.font = '10px system-ui';
  g.fillText(`${(s0 / RATE).toFixed(2)}秒から30ms拡大（灰:入力 赤:回路図 青点線:基板）`, 4, 11);
}
function drawSound() {
  drawWave($('#cvIn'), [[snd.input, css('--wave-in')]]);
  drawWave($('#cvOut'), [[snd.output, css('--wave-out')], [snd.board, css('--wave-board')]]);
  drawDetail();
}
// 表示枠の大きさが変わったら余白を付け直し、見ていた場所を中央に保つ
new ResizeObserver(() => {
  if (!sheet) return;
  const r = wrap.getBoundingClientRect(), c = toBoard(r.left + r.width / 2, r.top + r.height / 2);
  applyZoom(); centerOn(c.x, c.y);
}).observe(wrap);
let rz = 0;
addEventListener('resize', () => { cancelAnimationFrame(rz); rz = requestAnimationFrame(drawSound); });

/* ───────── 起動 ───────── */
$('#sampleItems').innerHTML = Object.keys(Sim.SAMPLES).map((k, i) => `<button data-sample="${i}">${esc(k)}</button>`).join('');
newDoc();
renderPalette();
setInput('guitar');
