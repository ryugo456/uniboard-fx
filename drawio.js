// drawio.js — draw.io(.drawio) の回路図を SPICE ネットリストに変換する
const Drawio = (() => {
'use strict';
const S = typeof Sim !== 'undefined' ? Sim : require('./sim.js');

/* 図形ごとの端子 [x, y, 役割]。座標は draw.io 公式の図形定義の接続点
   (jgraph/drawio dev ブランチの js/stencils.min.js と shapes/mxElectrical.js, 2026-10 取得)。
   役割(極性)は各図形の描画から確認: NPN 1-5 は上C・下E、PNP 1・5 は上E・下C、PNP 2-4 は上C・下E(矢印の位置)、
   有極性コンデンサ 2-6 は左が＋、ダイオード/LED は左A・右K、電池は右が＋、DC電源は上が＋、JFET は上D・下S・左G */
const SHAPES = {};
const def = (type, names, pins, opt = {}) => { for (const n of names.split(' ')) SHAPES['mxgraph.electrical.' + n] = { type, pins, ...opt }; };
const H = (y, a = 'a', b = 'b') => [[0, y, a], [1, y, b]];
def('R', 'resistors.resistor_1 resistors.resistor_2 resistors.resistor_3 resistors.resistor_4 resistors.variable_resistor_2 resistors.resistor_with_instrument_or_relay_shunt', H(0.5));
def('R', 'resistors.trimmer_resistor_1 resistors.trimmer_resistor_2', H(0.542));
def('POT', 'resistors.potentiometer_1 resistors.potentiometer_2 resistors.trimmer_pot_1 resistors.trimmer_pot_2', [[0, 0.25, 'a'], [1, 0.25, 'b'], [0.5, 1, 'w']]);
def('POT', 'resistors.variable_resistor_1', [[0, 0.5, 'a'], [1, 0.5, 'b'], [0.3, 1, 'w']]);
def('C', 'capacitors.capacitor_1 capacitors.variable_capacitor_1 capacitors.variable_capacitor_2', H(0.5));
def('C', 'capacitors.trimmer_capacitor_1 capacitors.trimmer_capacitor_2', H(0.542));
def('C', 'capacitors.capacitor_2 capacitors.capacitor_3 capacitors.capacitor_4 capacitors.capacitor_5 capacitors.capacitor_6', H(0.5, '+', '-'));
def('L', 'inductors.inductor_1 inductors.inductor_3', H(1));
def('L', 'inductors.inductor_2', [[0.6977, 0, 'a'], [0.6977, 1, 'b']]);
def('L', 'inductors.inductor_4', H(0.5517));
def('L', 'inductors.inductor_5', H(0.6446));
def('L', 'inductors.variable_inductor', H(0.5));
def('D', 'diodes.diode diodes.zener_diode_1 diodes.zener_diode_2 diodes.zener_diode_3', H(0.5, 'A', 'K'));
def('D', 'diodes.schottky_diode', H(0.5, 'A', 'K'), { model: '1N5817' });
def('D', 'opto_electronics.led_1', H(0.5385, 'A', 'K'), { model: 'LED' });
def('D', 'opto_electronics.led_2', H(0.5714, 'A', 'K'), { model: 'LED' });
def('NPN', 'transistors.npn_transistor_1 transistors.npn_transistor_4', [[0.7, 0, 'C'], [0.7, 1, 'E'], [0, 0.5, 'B']]);
def('NPN', 'transistors.npn_transistor_2', [[1, 0, 'C'], [1, 0.9859, 'E'], [0, 0.493, 'B']]);
def('NPN', 'transistors.npn_transistor_3', [[0.9973, 0, 'C'], [1, 1, 'E'], [0, 0.4986, 'B']]);
def('NPN', 'transistors.npn_transistor_5', [[1, 0, 'C'], [1, 1, 'E'], [0, 0.5, 'B']]);
def('PNP', 'transistors.pnp_transistor_1', [[0.7, 0, 'E'], [0.7, 1, 'C'], [0, 0.5, 'B']]);
def('PNP', 'transistors.pnp_transistor_5', [[1, 0, 'E'], [1, 1, 'C'], [0, 0.5, 'B']]);
def('PNP', 'transistors.pnp_transistor_2 transistors.pnp_transistor_3', [[1, 0, 'C'], [1, 1, 'E'], [0, 0.5, 'B']]);
def('PNP', 'transistors.pnp_transistor_4', [[0.7, 0, 'C'], [0.7, 1, 'E'], [0, 0.5, 'B']]);
def('NJF', 'transistors.n-channel_jfet_1', [[0.7, 0, 'D'], [0.7, 1, 'S'], [0, 0.6818, 'G']]);
def('PJF', 'transistors.p-channel_jfet_1', [[0.7, 0, 'D'], [0.7, 1, 'S'], [0, 0.6818, 'G']]);
def('PJF', 'transistors.p-channel_jfet_2', [[0.97, 0.333, 'D'], [0.97, 0.665, 'S'], [0.025, 0.67, 'G']]);
def('X', 'abstract.operational_amp_1', [[0, 0.1667, 'IN-'], [0, 0.8333, 'IN+'], [1, 0.5, 'OUT'], [0.612, 0.11, 'V+'], [0.612, 0.89, 'V-']]);
def('X', 'abstract.operational_amp_2', [[0, 0.1667, 'IN-'], [0, 0.8333, 'IN+'], [1, 0.5, 'OUT'], [0.408, 0.05, 'V+'], [0.408, 0.95, 'V-']]);
def('BAT', 'miscellaneous.batteryStack miscellaneous.monocell_battery miscellaneous.multicell_battery', H(0.5, '-', '+'));
def('BAT', 'signal_sources.dc_source_1', [[0.58, 0.135, '+'], [0.58, 0.935, '-']]);
def('BAT', 'signal_sources.dc_source_3 signal_sources.dc_source_3_v2', [[0.5, 0, '+'], [0.5, 1, '-']]);
def('SIG', 'signal_sources.ac_source', [[0.5, 0, 'N'], [0.5, 1, 'S'], [0, 0.5, 'W'], [1, 0.5, 'E'], [0.145, 0.145, 'NW'], [0.145, 0.855, 'SW'], [0.855, 0.145, 'NE'], [0.855, 0.855, 'SE']]);
def('SIG', 'signal_sources.source', [[0.5, 0, 'N'], [0.5, 1, 'S'], [0, 0.5, 'W'], [1, 0.5, 'E']]);
def('GND', 'signal_sources.protective_earth signal_sources.signal_ground', [[0.5, 0, 'g']]);
def('JACK', 'miscellaneous.2_conductor_jack', [[1, 0.4, 't']]);
def('JACK', 'miscellaneous.3_conductor_jack', [[1, 0.1, 't'], [1, 0.9, 's']]);
def('JACK', 'miscellaneous.normalled_jack miscellaneous.normalled_jack2', [[1, 0.31, 't'], [0.7273, 1, 's']]);
// SPICE の節点順
const ORDER = { R: 'ab', POT: 'abw', C: ['a', 'b', '+', '-'], L: 'ab', D: 'AK', NPN: 'CBE', PNP: 'CBE', NJF: 'DGS', PJF: 'DGS', X: ['IN+', 'IN-', 'V+', 'V-', 'OUT'], BAT: '+-' };
const TOL = 5;            // 座標を同じ点とみなす距離
const WIPER_DB = 0.5;     // ponytail: ポットは中点固定。ラベルの「30%」等を読むならここを部品ごとに

/* ───── XML ───── */
const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' };
const unent = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(/^#x/i.test(e) ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e.toLowerCase()] ?? m);
// draw.io が書き出す程度の XML を読む小さなパーサ（ブラウザと Node の両方で動くように）
function parseXml(s) {
  const root = { tag: '', attrs: {}, kids: [], text: '' }, stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  for (const m of s.matchAll(re)) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[6] !== undefined) top.text += unent(m[6]);
    else if (m[3]) {
      if (m[2]) { if (stack.length > 1) stack.pop(); continue; }
      const el = { tag: m[3], attrs: {}, kids: [], text: '' };
      for (const a of m[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) el.attrs[a[1]] = unent(a[2] ?? a[3]);
      top.kids.push(el);
      if (!m[5]) stack.push(el);
    }
  }
  return root;
}
const all = (el, tag, out = []) => { for (const k of el.kids) { if (k.tag === tag) out.push(k); all(k, tag, out); } return out; };
const first = (el, tag) => all(el, tag)[0];
// 圧縮されたページ: base64 → deflate-raw → URI エンコード
async function inflate(b64) {
  const bin = Uint8Array.from(atob(b64.replace(/\s+/g, '')), c => c.charCodeAt(0));
  const stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return decodeURIComponent(await new Response(stream).text());
}
const parseStyle = s => {
  const o = {};
  for (const kv of String(s || '').split(';')) { const i = kv.indexOf('='); if (i > 0) o[kv.slice(0, i)] = kv.slice(i + 1); else if (kv && !o._base) o._base = kv; }
  return o;
};
// ラベル: HTML タグを外し、二重にエスケープされた実体参照も戻す
const labelText = v => unent(String(v || '').replace(/<br\s*\/?>|<\/(div|p|li)>/gi, '\n').replace(/<[^>]*>/g, '')).replace(/ /g, ' ').trim();

/* ───── 値・品番の読み方 ───── */
const SC = { meg: 1e6, k: 1e3, M: 1e6, m: 1e-3, u: 1e-6, U: 1e-6, 'µ': 1e-6, 'μ': 1e-6, n: 1e-9, N: 1e-9, p: 1e-12, P: 1e-12, r: 1, R: 1, K: 1e3 };
// 「5 K」「0,1uF」「4k7」「10 uF」「1M(メガ)」「470」など。読めなければ NaN
function readValue(text) {
  const toks = String(text).split(/\s+/).filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
    let t = toks[i].replace(/meg/i, 'meg');
    if (/^\d+([.,]\d+)?$/.test(t) && toks[i + 1] && /^(meg|[kmunpµμr])?(Ω|ohms?|f|h)?$/i.test(toks[i + 1])) t += toks[++i].replace(/meg/i, 'meg');
    const m = /^(\d+(?:[.,]\d+)?)(meg|[kKmMuUµμnNpPrR])?(\d*)(?:Ω|[oO]hms?|[fF]|[hH])?$/.exec(t);
    if (!m) continue;
    const unit = m[2] && m[2].toLowerCase() === 'meg' ? 'meg' : m[2];
    if (m[3] && /[.,]/.test(m[1])) continue;   // 「1.2k3」のような形は値ではない
    return parseFloat(m[1].replace(',', '.') + (m[3] ? '.' + m[3] : '')) * (unit ? SC[unit] : 1);
  }
  return NaN;
}
const spiceNum = v => S.fmt(v).replace(/[µμ]/, 'u').replace(/M$/, 'Meg');
const WANT = { NPN: 'NPN', PNP: 'PNP', NJF: 'NJF', PJF: 'PJF', D: 'D' };
const SI = { NPN: '2N3904', PNP: '2N3906', NJF: 'J201', D: '1N4148' };
const GE = { PNP: 'NKT275', D: '1N34A' };
const GENERIC = { NPN: 'Is=1e-14 Bf=200 Br=2', PNP: 'Is=1e-14 Bf=200 Br=2', NJF: 'Beta=1e-3 Vto=-1.5', PJF: 'Beta=1e-3 Vto=-1.5', D: 'Is=1e-14 N=1' };
const GENERIC_GE = { NPN: 'Is=2e-7 Bf=100 Br=2' };
const PARTNO = /^[A-Z]{0,4}\d{2,}[A-Z0-9-]*$|^\d[A-Z]{1,2}\d{2,}[A-Z0-9-]*$/i;
// 半導体の品番。{ model, def?(自前で .model を出す内容) }
function readModel(text, type) {
  const toks = String(text).split(/[\s,/]+/).map(t => t.replace(/[^\w-]/g, '').toUpperCase()).filter(Boolean);
  for (const t of toks) if (S.MODELS[t] && S.MODELS[t].type === WANT[type] && !WANT[t]) return { model: t };
  if (/\bge\b|germanium|ゲルマ/i.test(text)) return GE[type] ? { model: GE[type], note: '汎用Ge' } : { model: 'GE_' + type, def: GENERIC_GE[type] || GENERIC[type], note: '汎用Ge' };
  if (/\bsi\b|silicon|シリコン/i.test(text)) return SI[type] ? { model: SI[type], note: '汎用Si' } : { model: 'SI_' + type, def: GENERIC[type], note: '汎用Si' };
  const t = toks.find(x => PARTNO.test(x) && !/^\d+$/.test(x));
  return t ? { model: t, def: GENERIC[type], unknown: true } : null;
}
const OPAMP = /^(TL0\d\d|LM\d+|NE\d+|JRC\d+[A-Z]*|NJM\d+[A-Z]*|RC\d+|OPA\d+|CA\d+|UA\d+|MC\d+|AD\d+|LF\d+|\d{3,4}(?![KM])[A-Z]?)$/i;   // 4558D・741C など。100K のような抵抗値は除く
const ioOf = text => /\bOUT(PUT)?\b|出力/i.test(text) ? 'out' : /\bIN(PUT)?\b|入力/i.test(text) ? 'in' : '';
const quoted = text => (/["“”「『']([^"“”」』']+)["“”」』']/.exec(text) || [])[1];
const refOf = text => (String(text).match(/\b(R|C|L|D|Q|J|U|IC|VR|RV|POT|LED|TR|X)\d+[A-Z]?\b/i) || [])[0];
const tokenize = s => String(s).toUpperCase().replace(/[^A-Z0-9_]/g, '');

/* ───── 幾何 ───── */
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const boxDist = (a, b) => Math.hypot(Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w)), Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h)));
const segDist = (p, a, b) => {
  const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0;
  return { d: dist(p, { x: a.x + t * dx, y: a.y + t * dy }), t };
};
const center = c => ({ x: c.box.x + c.box.w / 2, y: c.box.y + c.box.h / 2 });
// 図形内の接続点(0〜1) → 図面座標。mxGraph.getConnectionPoint と同じ順(上下向きなら反転を入替 → 反転 → 向き → 回転)
function connPoint(c, px, py) {
  const st = c.style, g = c.box, cx = g.x + g.w / 2, cy = g.y + g.h / 2, dir = st.direction;
  const ns = dir === 'north' || dir === 'south';
  const b = ns ? { x: cx - g.h / 2, y: cy - g.w / 2, w: g.h, h: g.w } : g;
  let x = b.x + px * b.w, y = b.y + py * b.h;
  let fh = st.flipH == 1 || st.stencilFlipH == 1, fv = st.flipV == 1 || st.stencilFlipV == 1;
  if (ns) [fh, fv] = [fv, fh];
  if (fh) x = 2 * cx - x;
  if (fv) y = 2 * cy - y;
  const r = (st.anchorPointDirection == 0 ? 0 : { north: 270, west: 180, south: 90 }[dir] || 0) + (+st.rotation || 0);
  if (r) { const a = r * Math.PI / 180, dx = x - cx, dy = y - cy; x = cx + dx * Math.cos(a) - dy * Math.sin(a); y = cy + dx * Math.sin(a) + dy * Math.cos(a); }
  return { x, y };
}

/* ───── ページの選択 ───── */
async function pickModel(text) {
  const doc = parseXml(text);
  const direct = doc.kids.find(k => k.tag === 'mxGraphModel');
  if (direct) return { model: direct, name: '', others: [] };
  const pages = all(doc, 'diagram');
  if (!pages.length) throw new Error('draw.io の図が見つかりませんでした');
  const loaded = [];
  for (const p of pages) {
    const m = first(p, 'mxGraphModel') || (p.text.trim() ? first(parseXml(await inflate(p.text.trim())), 'mxGraphModel') : null);
    if (m) loaded.push({ model: m, name: p.attrs.name || '' });
  }
  const isCircuit = l => all(l.model, 'mxCell').some(c => /mxgraph\.electrical\./.test(c.attrs.style || ''));
  const pick = loaded.find(isCircuit) || loaded[0];
  if (!pick) throw new Error('draw.io の図が読めませんでした');
  return { ...pick, others: loaded.filter(l => l !== pick).map(l => l.name) };
}

// 変換本体: draw.io の文字列 → { text: SPICE ネットリスト, warnings }
async function toSpice(text) {
  const page = await pickModel(text), warnings = [];
  if (page.others.length) warnings.push(`ページ「${page.name}」を読み込みました（ほかのページ ${page.others.map(n => `「${n}」`).join('')} は読み込んでいません）`);

  // セルを集める（object / UserObject で包まれたものは外側の id・label を使う）
  const cells = [], byId = new Map();
  const collect = (el, wrap) => {
    for (const k of el.kids) {
      if (k.tag === 'mxCell') {
        const a = k.attrs, geo = first(k, 'mxGeometry'), ga = geo ? geo.attrs : {};
        const pt = el2 => el2 ? { x: +el2.attrs.x || 0, y: +el2.attrs.y || 0 } : null;
        const points = geo ? (geo.kids.find(x => x.tag === 'Array' && x.attrs.as === 'points') || { kids: [] }).kids.filter(x => x.tag === 'mxPoint').map(pt) : [];
        const c = {
          id: wrap ? wrap.attrs.id : a.id, value: wrap ? (wrap.attrs.label ?? '') : (a.value ?? ''), style: parseStyle(a.style),
          vertex: a.vertex === '1', edge: a.edge === '1', parent: a.parent, source: a.source, target: a.target,
          box: { x: +ga.x || 0, y: +ga.y || 0, w: +ga.width || 0, h: +ga.height || 0 }, relative: ga.relative === '1',
          points, sp: pt(geo && geo.kids.find(x => x.tag === 'mxPoint' && x.attrs.as === 'sourcePoint')),
          tp: pt(geo && geo.kids.find(x => x.tag === 'mxPoint' && x.attrs.as === 'targetPoint')),
        };
        cells.push(c); byId.set(c.id, c);
      } else if (k.tag === 'object' || k.tag === 'UserObject') collect(k, k);
      else collect(k, wrap);
    }
  };
  collect(first(page.model, 'root') || page.model);
  // 親(グループ)の位置を足して図面上の座標にする
  const offs = new Map();
  const offset = id => {
    if (!offs.has(id)) { const p = byId.get(id); offs.set(id, p && p.vertex && !p.relative ? (o => ({ x: o.x + p.box.x, y: o.y + p.box.y }))(offset(p.parent)) : { x: 0, y: 0 }); }
    return offs.get(id);
  };
  cells.forEach(c => offset(c.parent));
  for (const c of cells) {
    const o = offs.get(c.parent);
    c.box.x += o.x; c.box.y += o.y;
    for (const p of [...c.points, c.sp, c.tp]) if (p) { p.x += o.x; p.y += o.y; }
  }

  // 図形の分類
  const comps = [], junctions = [], texts = [], conns = [];
  const touched = new Set(cells.filter(c => c.edge).flatMap(c => [c.source, c.target]).filter(Boolean));
  for (const c of cells) {
    if (!c.vertex || c.relative) continue;
    const shape = c.style.shape || c.style._base || '', sh = SHAPES[shape], label = labelText(c.value);
    if (sh) {
      c.kind = 'comp'; c.type = sh.type; c.def = sh; c.texts = label ? [label] : [];
      c.pins = sh.pins.map(([px, py, role], i) => ({ key: `T:${c.id}:${i}`, role, local: [px, py], pt: connPoint(c, px, py), comp: c }));
      comps.push(c);
    } else if (/^mxgraph\.electrical\./.test(shape)) warnings.push(`対応していない図形（${shape.replace('mxgraph.electrical.', '')}）は無視しました`);
    else if (!label && ((c.box.w <= 14 && c.box.h <= 14) || shape === 'waypoint')) { c.kind = 'junction'; junctions.push(c); }
    else if (touched.has(c.id)) { c.kind = 'conn'; c.attach = new Set(); c.texts = label ? [label] : []; conns.push(c); }
    else if (label) texts.push({ box: c.box, text: label });
  }
  if (!comps.some(c => c.type !== 'GND')) throw new Error('回路の部品（draw.io の Electrical 図形）が見つかりませんでした');

  // つながり: union-find（キー: 端子 T、ジャンクション J、線 E、その他の図形の接続点 K、ポットのワイパー W）
  const par = new Map(), find = k => { while (par.has(k)) k = par.get(k); return k; };
  const unite = (a, b) => { a = find(a); b = find(b); if (a !== b) par.set(a, b); };
  const used = new Set();
  const join = (a, b) => { unite(a, b); used.add(a); used.add(b); };
  for (const c of comps) if (c.type === 'GND') join(c.pins[0].key, 'GND');
  const nearestPin = (c, p) => c.pins.reduce((m, q) => dist(q.pt, p) < dist(m.pt, p) ? q : m);
  const wiperOf = (c, p) => {   // 抵抗本体の中ほど(15〜85%)に触れていればワイパー
    if (c.type !== 'R') return false;
    const s = segDist(p, c.pins[0].pt, c.pins[1].pt);
    return s.t > 0.15 && s.t < 0.85 && s.d <= Math.min(c.box.w, c.box.h) / 2 + TOL && c.pins.every(q => dist(q.pt, p) >= 2 * TOL);
  };
  const edges = cells.filter(c => c.edge), loose = [];
  for (const e of edges) {
    const ends = ['source', 'target'].map(side => {
      const id = e[side], cell = id && byId.get(id), raw = side === 'source' ? e.sp : e.tp;
      const near = side === 'source' ? (e.points[0] || e.tp) : (e.points[e.points.length - 1] || e.sp);
      const ex = e.style[side === 'source' ? 'exitX' : 'entryX'], ey = e.style[side === 'source' ? 'exitY' : 'entryY'];
      if (!cell || (!cell.edge && !cell.kind)) return { key: null, pt: raw };
      if (cell.edge) return { key: 'E:' + cell.id, pt: raw };
      if (cell.kind === 'junction') return { key: 'J:' + cell.id, pt: center(cell) };
      if (cell.kind === 'conn') {
        const k = ex !== undefined ? `K:${cell.id}:${(+ex).toFixed(2)},${(+ey).toFixed(2)}` : `K:${cell.id}`;
        cell.attach.add(k);
        return { key: k, pt: ex !== undefined ? connPoint(cell, +ex, +ey) : center(cell) };
      }
      if (ex !== undefined) {   // 接続点が指定されていれば図形内座標で端子を決める（回転・反転の影響を受けない）
        const q = cell.pins.reduce((m, p) => Math.hypot(p.local[0] - ex, p.local[1] - ey) < Math.hypot(m.local[0] - ex, m.local[1] - ey) ? p : m);
        return { key: q.key, pt: q.pt };
      }
      const toward = near || center(cell);
      if (wiperOf(cell, toward)) { cell.wiper = true; return { key: 'W:' + cell.id, pt: toward }; }
      const q = nearestPin(cell, toward);
      return { key: q.key, pt: q.pt };
    });
    e.poly = [ends[0].pt, ...e.points, ends[1].pt].filter(Boolean);
    for (const end of ends) if (end.key) join('E:' + e.id, end.key); else if (end.pt) loose.push({ e, pt: end.pt });
  }
  // 座標で決める: 浮いた線の端（端子・ジャンクション・抵抗本体(ワイパー)・図形・他の線の途中(T字)）
  const pins = comps.flatMap(c => c.pins);
  const onEdge = (pt, skip) => edges.find(o => o !== skip && o.poly.slice(1).some((b, i) => segDist(pt, o.poly[i], b).d <= TOL));
  let dangling = 0;
  for (const { e, pt } of loose) {
    const pin = pins.find(p => dist(p.pt, pt) <= TOL);
    const j = !pin && junctions.find(c => boxDist({ ...pt, w: 0, h: 0 }, c.box) <= TOL);
    const wc = !pin && !j && comps.find(c => wiperOf(c, pt));
    const cn = !pin && !j && !wc && conns.find(c => boxDist({ ...pt, w: 0, h: 0 }, c.box) <= TOL);
    const other = !pin && !j && !wc && !cn && onEdge(pt, e);
    if (pin) join('E:' + e.id, pin.key);
    else if (j) join('E:' + e.id, 'J:' + j.id);
    else if (wc) { wc.wiper = true; join('E:' + e.id, 'W:' + wc.id); }
    else if (cn) { cn.attach.add('K:' + cn.id); join('E:' + e.id, 'K:' + cn.id); }
    else if (other) join('E:' + e.id, 'E:' + other.id);
    else dangling++;
  }
  if (dangling) warnings.push(`どこにもつながっていない線の端が ${dangling} か所あります`);
  // 線のつながっていない端子: 他の端子と重なっているか、線の上に乗っていればつながっている
  for (const p of pins) if (!used.has(p.key)) {
    const o = pins.find(q => q !== p && dist(q.pt, p.pt) <= TOL) || junctions.find(c => dist(center(c), p.pt) <= TOL);
    const e = !o && onEdge(p.pt);
    if (o) join(p.key, o.key || 'J:' + o.id); else if (e) join(p.key, 'E:' + e.id);
  }

  // ラベル → 部品: 縦に並んだラベルはまとめ、その内容を使える部品のうち近いものへ
  const accepts = (c, t) => {
    if (c.kind === 'conn' || c.type === 'JACK' || c.type === 'SIG') return true;
    if (refOf(t) || (quoted(t) && (c.type === 'POT' || c.wiper))) return true;
    if ('R C L'.split(' ').includes(c.type) || c.type === 'POT') return isFinite(readValue(t));
    if (c.type === 'BAT') return /\d\s*V\b/i.test(t);
    if (c.type === 'X') return t.split(/\s+/).some(x => OPAMP.test(x));
    return WANT[c.type] ? !!readModel(t, c.type) : false;
  };
  const cands = [...comps.filter(c => c.type !== 'GND'), ...conns];
  const sizes = comps.filter(c => c.type !== 'GND').map(c => Math.max(c.box.w, c.box.h)).sort((a, b) => a - b);
  const thr = Math.max(30, Math.min(200, 0.9 * (sizes[sizes.length >> 1] || 40)));
  texts.sort((a, b) => a.box.y - b.box.y);
  const groups = [];
  for (const t of texts) {
    const g = groups.find(g => g.some(o => o.box.x < t.box.x + t.box.w && t.box.x < o.box.x + o.box.w && t.box.y - (o.box.y + o.box.h) <= 8 && t.box.y >= o.box.y));
    g ? g.push(t) : groups.push([t]);
  }
  for (const g of groups) {
    let best = null;
    for (const c of cands) {
      if (!g.some(t => accepts(c, t.text))) continue;
      const ds = g.map(t => boxDist(t.box, c.box));
      if (Math.min(...ds) > thr) continue;
      const score = ds.reduce((a, b) => a + b, 0);
      if (!best || score < best.score) best = { c, score };
    }
    if (best) best.c.texts.push(...g.map(t => t.text));
  }

  // 部品番号（ラベルの番号を優先、無ければ自動採番）
  const names = new Set(['VIN']), uniq = base => { let n = base, i = 2; while (names.has(n)) n = base + '_' + i++; names.add(n); return n; };
  const auto = p => { let i = 1; while (names.has(p + i)) i++; names.add(p + i); return p + i; };
  const PREFIX = { R: 'R', C: 'C', L: 'L', D: 'D', NPN: 'Q', PNP: 'Q', NJF: 'J', PJF: 'J', X: 'XU', BAT: 'V' };
  const models = new Map(), el = [];
  const order = ['R', 'POT', 'C', 'L', 'D', 'NPN', 'PNP', 'NJF', 'PJF', 'X', 'BAT'];
  const parts = comps.filter(c => order.includes(c.type)).sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  for (const c of parts) {   // 1回目: ラベルに番号がある部品
    const t = c.texts.join(' '), r = tokenize(refOf(t) || '');
    if (c.type === 'R' && c.wiper) c.type = 'POT';
    if (c.type === 'POT') { c.label = quoted(t) || refOf(t) || ''; c.name = uniq('RPOT_' + (tokenize(c.label) || 'POT')); }
    else if (c.type === 'X' && /^(U|IC|X)/.test(r)) c.name = uniq('X' + r.replace(/^X/, ''));
    else if (r && r[0] === PREFIX[c.type][0] && c.type !== 'X') c.name = uniq(r);
  }
  for (const c of parts) if (!c.name) c.name = auto(PREFIX[c.type]);   // 2回目: 自動採番

  // 電源: 電池のどちらの極も GND につながっていなければ −側を GND とみなす（プラス接地の図はそのまま）
  const bats = parts.filter(c => c.type === 'BAT'), pinOf = (c, role) => c.pins.find(p => p.role === role);
  for (const b of bats) {
    const g = find('GND'), plus = find(pinOf(b, '+').key), minus = find(pinOf(b, '-').key);
    if (plus !== g && minus !== g) {
      join(pinOf(b, '-').key, 'GND');
      warnings.push(comps.some(c => c.type === 'GND')
        ? `${b.name}: 電池の−側が GND につながっていないため GND とみなしました（ジャックのリングで電源を入れる回路など）`
        : `${b.name}: GND 記号が無いため、電池の−側を GND とみなしました`);
    }
  }
  if (!bats.length) warnings.push('電池・電源が見つかりません');
  // オペアンプの電源ピンが描かれていなければ VCC / GND へ
  const alone = k => ![...par.keys(), ...par.values()].some(x => x !== k && find(x) === find(k));
  for (const c of parts.filter(c => c.type === 'X')) {
    const vp = pinOf(c, 'V+'), vn = pinOf(c, 'V-');
    if (alone(vp.key) && bats[0]) { join(vp.key, pinOf(bats[0], '+').key); c.pwr = true; }
    if (alone(vn.key)) { join(vn.key, 'GND'); c.pwr = true; }
    if (c.pwr) warnings.push(`${c.name}: 電源ピンが描かれていないため VCC と GND につないで計算します`);
  }

  // 入出力: IN / OUT のラベルが付いたジャック。電池以外の部品につながる接続点を信号線とみなす
  const jacks = [...conns, ...comps.filter(c => c.type === 'JACK')].map(c => ({ c, io: ioOf(c.texts.join(' ')), keys: c.attach ? [...c.attach] : c.pins.filter(p => used.has(p.key)).map(p => p.key) }));
  const signalKey = keys => {
    const live = keys.filter(k => find(k) !== find('GND'));
    return live.find(k => pins.some(p => !['BAT', 'GND', 'JACK'].includes(p.comp.type) && find(p.key) === find(k))) || live[0] || keys[0];
  };
  const inJ = jacks.find(j => j.io === 'in' && j.keys.length), outJ = jacks.find(j => j.io === 'out' && j.keys.length);
  for (const j of jacks) if (!j.io && j.c.kind === 'conn') warnings.push(`線がつながっている図形「${j.c.texts.join(' ') || j.c.style._base || j.c.id}」は IN / OUT のジャックとして扱えないため無視しました`);
  let vin = null;
  if (inJ) vin = [signalKey(inJ.keys), 'GND'];
  else {
    const sig = comps.find(c => c.type === 'SIG');
    const ks = sig ? sig.pins.filter(p => used.has(p.key)).sort((a, b) => a.pt.y - b.pt.y || a.pt.x - b.pt.x) : [];
    if (ks.length >= 2) vin = [ks[0].key, ks[ks.length - 1].key];
    else if (ks.length === 1) vin = [ks[0].key, 'GND'];
    else warnings.push('入力ジャック（IN のラベル）または信号源が見つからないため、入力を設定できません');
  }
  if (!outJ) warnings.push('出力ジャック（OUT のラベル）が見つかりません。SoundCheck の出力は手で選んでください');

  // ネット名: GND=0、電池＋=VCC、入力=IN、出力=OUT、それ以外は N001…
  const netName = new Map([[find('GND'), '0']]);
  const fixed = (k, n) => { const r = find(k); if (!netName.has(r)) netName.set(r, n); };
  bats.forEach((b, i) => fixed(pinOf(b, '+').key, i ? 'VCC' + (i + 1) : 'VCC'));
  bats.forEach((b, i) => fixed(pinOf(b, '-').key, i ? 'VEE' + (i + 1) : 'VEE'));
  if (vin) fixed(vin[0], 'IN');
  if (outJ) fixed(signalKey(outJ.keys), 'OUT');
  let seq = 0;
  const net = k => { const r = find(k); if (!netName.has(r)) netName.set(r, 'N' + String(++seq).padStart(3, '0')); return netName.get(r); };
  const nodes = (c, roles) => [...roles].map(role => net(pinOf(c, role).key));

  // 素子の行
  const lonely = [];
  for (const c of parts) {
    const t = c.texts.join(' ');
    for (const p of c.pins) if (!(c.type === 'X' && /^V[+-]$/.test(p.role)) && alone(p.key)) lonely.push(`${c.name}(${p.role})`);
    if (c.type === 'POT') {
      let v = readValue(t);
      if (!(v > 0)) { v = 100e3; warnings.push(`${c.label || c.name}: 値の記載が無いため 100k で計算します`); }
      const [a, b] = nodes(c, 'ab'), w = c.wiper ? net('W:' + c.id) : net(pinOf(c, 'w').key);
      el.push(`${c.name}_A ${a} ${w} ${spiceNum(v * WIPER_DB)}  ; ポット「${c.label || c.name}」${spiceNum(v)}（中点で計算）`, `${c.name}_B ${w} ${b} ${spiceNum(v * (1 - WIPER_DB))}`);
    } else if ('RCL'.includes(c.type)) {
      let v = readValue(t);
      const dflt = { R: 10e3, C: 100e-9, L: 10e-3 }[c.type];
      if (!(v > 0)) { v = dflt; warnings.push(`${c.name}: 値の記載が無いため ${spiceNum(dflt)} で計算します`); }
      el.push(`${c.name} ${nodes(c, c.pins[0].role === '+' ? '+-' : 'ab').join(' ')} ${spiceNum(v)}`);
    } else if (WANT[c.type] || c.type === 'D') {
      let m = c.def.model && !readModel(t, c.type) ? { model: c.def.model } : readModel(t, c.type);
      if (!m) { m = SI[c.type] ? { model: SI[c.type] } : { model: 'SI_' + c.type, def: GENERIC[c.type] }; warnings.push(`${c.name}: 品番の記載が無いため ${m.model} で計算します`); }
      else if (m.unknown) warnings.push(`${c.name}: 品番 ${m.model} の特性データが無いため一般的な値で計算します`);
      else if (m.note) warnings.push(`${c.name}: 「${m.note}」として ${m.model} で計算します`);
      const name = tokenize(m.model);
      if (m.def) models.set(name, `.model ${name} ${WANT[c.type]}(${m.def})`);
      el.push(`${c.name} ${nodes(c, c.type === 'D' ? 'AK' : ORDER[c.type]).join(' ')} ${name}`);
    } else if (c.type === 'X') {
      const sub = t.split(/\s+/).find(x => OPAMP.test(x));
      if (!sub) warnings.push(`${c.name}: 品番の記載が無いため TL072 で計算します`);
      el.push(`${c.name} ${nodes(c, ORDER.X).join(' ')} ${tokenize(sub || 'TL072')}`);
    } else if (c.type === 'BAT') {
      const m = /(\d+(?:[.,]\d+)?)\s*V\b/i.exec(t);
      if (!m) warnings.push(`${c.name}: 電圧の記載が無いため 9V で計算します`);
      el.push(`${c.name} ${nodes(c, '+-').join(' ')} ${m ? m[1].replace(',', '.') : 9}`);
    }
  }
  if (vin) el.push(`VIN ${net(vin[0])} ${net(vin[1])} SIN(0 0.3 440)`);
  if (lonely.length) warnings.push(`どこにもつながっていない端子: ${lonely.join(', ')}`);

  const title = page.name || 'draw.io';
  const textOut = [`* ${title}（draw.io から変換）`, ...warnings.map(w => '*! ' + w.replace(/;/g, '，')), ...el, ...models.values(), '.end'].join('\n');
  return { text: textOut, warnings };
}

return { toSpice, readValue, readModel, connPoint, SHAPES };
})();
if (typeof module !== 'undefined') module.exports = Drawio;
