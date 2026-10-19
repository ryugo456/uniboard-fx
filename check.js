// check.js — 部品の定義、基板の導通解析、回路図(ネットリスト)との照合
const Board = (() => {
'use strict';
const S = typeof Sim !== 'undefined' ? Sim : require('./sim.js');

// two: 両端点 a,b を持つ2端子部品。span: 既定のリード間隔(穴数)。bodyL/W: 本体寸法(mm)
const KINDS = {
  resistor:     { label: '抵抗', letters: 'R', prefix: 'R', two: true, pinNames: ['1', '2'], span: 4, bodyL: 6.3, bodyW: 2.4, value: '10k' },
  capacitor:    { label: 'コンデンサ', letters: 'C', prefix: 'C', two: true, box: true, pinNames: ['1', '2'], span: 2, bodyL: 7.2, bodyW: 3.5, value: '100n' },
  electrolytic: { label: '電解コンデンサ', letters: 'C', prefix: 'C', two: true, polar: true, radial: true, pinNames: ['+', '−'], span: 1, bodyL: 5, bodyW: 5, value: '10u' },
  inductor:     { label: 'インダクタ', letters: 'L', prefix: 'L', two: true, pinNames: ['1', '2'], span: 4, bodyL: 8, bodyW: 4, value: '100m' },
  diode:        { label: 'ダイオード', letters: 'D', prefix: 'D', two: true, polar: true, pinNames: ['A', 'K'], span: 3, bodyL: 3.5, bodyW: 1.8, value: '1N4148' },
  led:          { label: 'LED', letters: 'D', prefix: 'D', two: true, polar: true, radial: true, pinNames: ['A', 'K'], span: 1, bodyL: 5, bodyW: 5, value: 'LED' },
  bjt:          { label: 'トランジスタ', letters: 'Q', prefix: 'Q', value: '2N5088' },
  jfet:         { label: 'JFET', letters: 'J', prefix: 'J', value: 'J201' },
  opamp2:       { label: 'オペアンプ(デュアル)', letters: 'X', prefix: 'U', dip: true, value: 'TL072' },
  opamp1:       { label: 'オペアンプ(シングル)', letters: 'X', prefix: 'U', dip: true, value: 'TL071' },
  terminal:     { label: '外部配線端子' },
  wire:         { label: '配線', two: true, pinNames: ['', ''], span: 1 },
};
// DIP8 のピン番号 → オペアンプ素子の端子番号 (IN+, IN-, V+, V-, OUT)
const OPAMP_PINS = {
  opamp1: [{ 3: 0, 2: 1, 7: 2, 4: 3, 6: 4 }],
  opamp2: [{ 3: 0, 2: 1, 8: 2, 4: 3, 1: 4 }, { 5: 0, 6: 1, 8: 2, 4: 3, 7: 4 }],
};
const TERM = { C: 0, B: 1, E: 2, D: 0, G: 1, S: 2 };   // ピン配置の文字 → Q(C,B,E) / J(D,G,S) の端子番号
const SINGLE = /741|TL0[678]1|5534|OPA134|OP07|3130|LM318/i;

const rot = (x, y, r) => { for (let i = 0; i < (r & 3); i++) [x, y] = [-y, x]; return [x, y]; };
const disp = n => n === '0' ? 'GND' : n;
const normNet = s => /^(0|GND)$/i.test(String(s).trim()) ? '0' : String(s).trim().toUpperCase();

function partPins(p) {
  const k = KINDS[p.kind];
  if (k.two) return [{ x: p.a.x, y: p.a.y, name: k.pinNames[0] }, { x: p.b.x, y: p.b.y, name: k.pinNames[1] }];
  let loc;
  if (p.kind === 'bjt' || p.kind === 'jfet') loc = [0, 1, 2].map(i => [i * (p.pitch || 1), 0, p.pinout[i]]);
  else if (k.dip) loc = [1, 2, 3, 4, 5, 6, 7, 8].map(i => i <= 4 ? [i - 1, 3, String(i)] : [8 - i, 0, String(i)]);
  else loc = [[0, 0, '']];
  return loc.map(([lx, ly, name]) => { const [rx, ry] = rot(lx, ly, p.rot || 0); return { x: p.x + rx, y: p.y + ry, name }; });
}

function kindFor(el) {
  switch (el.type) {
    case 'R': return 'resistor';
    case 'C': return el.value >= 1e-6 ? 'electrolytic' : 'capacitor';
    case 'L': return 'inductor';
    case 'D': return /LED/i.test(el.model) ? 'led' : 'diode';
    case 'Q': return 'bjt';
    case 'J': return 'jfet';
    case 'X': return el.nodes.length === 5 ? (SINGLE.test(el.sub) ? 'opamp1' : 'opamp2') : null;
  }
  return null;
}
const isExternal = (el, offboard) => 'VIE'.includes(el.type) || !!offboard[el.name] || !kindFor(el);

// 基板(sheet)と回路図(net)を照合する。net が無ければ配置上のチェックだけ
function check(sheet, net) {
  const { cols, rows } = sheet.board;
  const issues = [], pins = [], byPart = new Map(), occ = new Map();
  const par = Int32Array.from({ length: cols * rows }, (_, i) => i);
  const find = i => { while (par[i] !== i) i = par[i] = par[par[i]]; return i; };
  const hole = (x, y) => x >= 0 && y >= 0 && x < cols && y < rows ? y * cols + x : -1;
  const name = p => p.kind === 'terminal' ? `端子 ${p.label || '?'}` : p.ref || KINDS[p.kind].label;
  const pinLabel = q => q.part.kind === 'terminal' ? name(q.part) : `${name(q.part)}-${q.name}`;
  const add = (level, msg, at = [], parts = []) => issues.push({ level, msg, holes: at.map(q => ({ x: q.x, y: q.y })), parts });

  for (const p of sheet.parts) if (p.kind === 'wire') {
    const h1 = hole(p.a.x, p.a.y), h2 = hole(p.b.x, p.b.y);
    if (h1 < 0 || h2 < 0) add('error', '配線が基板の外に出ています', [p.a, p.b], [p.id]);
    else par[find(h1)] = find(h2);
  }
  for (const p of sheet.parts) if (p.kind !== 'wire') {
    const ps = partPins(p), mine = [];
    ps.forEach((q, i) => {
      const h = hole(q.x, q.y);
      if (h < 0) return;
      const pin = { part: p, i, x: q.x, y: q.y, h, name: q.name, nets: [] };
      pins.push(pin); mine[i] = pin;
      (occ.get(h) || occ.set(h, []).get(h)).push(pin);
    });
    byPart.set(p.id, mine);
    if (mine.filter(Boolean).length < ps.length) add('error', `${name(p)}: 基板の外にはみ出しています`, ps, [p.id]);
  }
  for (const list of occ.values())
    if (list.length > 1) add('error', `同じ穴に複数のリード: ${list.map(pinLabel).join(', ')}`, list, list.map(q => q.part.id));

  const placed = new Set(), airwires = [];
  const result = { issues, pins, find, hole, placed, airwires, pinText: new Map() };
  if (!net) {
    add('info', '回路図(ネットリスト)を取り込むと、配線の照合ができます');
    return finish(result);
  }

  const els = new Map(net.elements.map(e => [e.name.toUpperCase(), e]));
  const nodeSet = new Set(net.nodes).add('0');
  const twos = [];
  const fixed = (p, i, n) => { const q = byPart.get(p.id)[i]; if (q) q.nets.push(n); };

  for (const p of sheet.parts) {
    const k = KINDS[p.kind];
    if (p.kind === 'wire') continue;
    if (p.kind === 'terminal') {
      if (!p.label) add('warn', '外部配線端子のネット名が未設定です', partPins(p), [p.id]);
      else if (!nodeSet.has(normNet(p.label))) add('error', `端子「${p.label}」: 回路図に同名のネットがありません`, partPins(p), [p.id]);
      else fixed(p, 0, normNet(p.label));
      continue;
    }
    if (k.dip) {
      let any = false;
      OPAMP_PINS[p.kind].forEach((map, ui) => {
        const u = (p.units || [])[ui];
        if (!u) return;
        const el = els.get(u.toUpperCase());
        if (!el || el.type !== 'X' || el.nodes.length !== 5) { add('error', `${name(p)}: ユニット${'AB'[ui]}「${u}」は回路図のオペアンプではありません`, [], [p.id]); return; }
        any = true; placed.add(el.name);
        for (const [pin, ni] of Object.entries(map)) fixed(p, pin - 1, el.nodes[ni]);
      });
      if (!any) add('warn', `${name(p)}: 回路図のオペアンプと対応付けられていません（サイドバーでユニットを選択）`, partPins(p), [p.id]);
      continue;
    }
    const el = els.get((p.ref || '').toUpperCase());
    if (!el) { add('warn', `${name(p)}: 回路図にない部品です`, partPins(p), [p.id]); continue; }
    if (!k.letters.includes(el.type)) { add('error', `${name(p)}: 種類が違います（回路図の ${el.name} は ${el.type} 素子）`, partPins(p), [p.id]); continue; }
    placed.add(el.name);
    if ('RCL'.includes(el.type)) {
      const v = S.parseValue(p.value, true);
      if (!(Math.abs(v - el.value) <= el.value * 0.01)) add('error', `${name(p)}: 値が違います（回路図 ${S.fmt(el.value)} / 基板 ${p.value || '未入力'}）`, partPins(p), [p.id]);
    } else if (el.model && p.value && p.value.toUpperCase() !== el.model) {
      add('warn', `${name(p)}: 品番が違います（回路図 ${el.model} / 基板 ${p.value}）`, partPins(p), [p.id]);
    }
    if (k.two) {
      const q = byPart.get(p.id);
      if (q[0] && q[1]) twos.push({ p, q, n: el.nodes, polar: k.polar, swap: false });
    } else for (let i = 0; i < 3; i++) fixed(p, i, el.nodes[TERM[p.pinout[i]]]);
  }

  // 2端子部品の向き: 周囲とのつながりが多い向きを採用（抵抗などは逆でも可、極性部品は逆ならエラー）
  for (let pass = 0; pass < 2; pass++) {
    const cnt = new Map();
    const bump = (r, n, d) => { const m = cnt.get(r) || cnt.set(r, new Map()).get(r); m.set(n, (m.get(n) || 0) + d); };
    for (const q of pins) for (const n of q.nets) bump(find(q.h), n, 1);
    if (pass) for (const t of twos) { bump(find(t.q[0].h), t.n[+t.swap], 1); bump(find(t.q[1].h), t.n[+!t.swap], 1); }
    const c = (q, n) => (cnt.get(find(q.h)) || new Map()).get(n) || 0;
    for (const t of twos) {
      const own = pass ? 2 : 0;   // 2回目は自分自身の寄与を引く
      const straight = c(t.q[0], t.n[0]) + c(t.q[1], t.n[1]) - (t.swap ? 0 : own);
      const swapped = c(t.q[0], t.n[1]) + c(t.q[1], t.n[0]) - (t.swap ? own : 0);
      t.swap = swapped > straight;
    }
  }
  for (const t of twos) {
    t.q[0].nets.push(t.n[+t.swap]); t.q[1].nets.push(t.n[+!t.swap]);
    if (t.swap && t.polar) add(t.p.kind === 'electrolytic' ? 'warn' : 'error',
      `${name(t.p)}: 極性(向き)が逆の可能性があります`, t.q, [t.p.id]);
  }

  // ネットごと／導通グループごとに集計して、分断(オープン)とショートを探す
  const byNet = new Map(), byRoot = new Map();
  for (const q of pins) for (const n of new Set(q.nets)) {
    const r = find(q.h);
    const a = byNet.get(n) || byNet.set(n, new Map()).get(n);
    (a.get(r) || a.set(r, []).get(r)).push(q);
    const b = byRoot.get(r) || byRoot.set(r, new Map()).get(r);
    (b.get(n) || b.set(n, []).get(n)).push(q);
  }
  for (const [n, roots] of byNet) if (roots.size > 1) {
    const groups = [...roots.values()];
    add('error', `未接続: ネット ${disp(n)} が ${groups.length} か所に分かれています（${groups.map(g => g.map(pinLabel).join('・')).join(' / ')}）`,
      groups.flat(), groups.flat().map(q => q.part.id));
    // ラッツネスト: 最も近いピン同士で順につなぐ
    const done = [...groups.shift()];
    while (groups.length) {
      let best = null;
      groups.forEach((g, gi) => g.forEach(a => done.forEach(b => {
        const d = (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
        if (!best || d < best.d) best = { d, a, b, gi };
      })));
      airwires.push([best.a, best.b]);
      done.push(...groups.splice(best.gi, 1)[0]);
    }
  }
  for (const nets of byRoot.values()) if (nets.size > 1) {
    const all = [...nets.values()].flat();
    add('error', `ショート: ${[...nets.keys()].map(disp).join(' と ')} がつながっています（${all.map(pinLabel).join('・')}）`, all, all.map(q => q.part.id));
  }

  const unplaced = [], need = new Map();
  for (const el of net.elements) {
    if (placed.has(el.name)) continue;
    if (!isExternal(el, sheet.offboard || {})) { unplaced.push(el.name); continue; }
    for (const n of el.nodes) if (byNet.has(n) && ![...byNet.get(n).values()].flat().some(q => q.part.kind === 'terminal'))
      (need.get(n) || need.set(n, new Set()).get(n)).add(el.name);
  }
  if (unplaced.length) add('warn', `未配置の部品 ${unplaced.length} 個: ${unplaced.join(', ')}`);
  for (const [n, names] of need) {
    const at = [...byNet.get(n).values()].flat();
    add('warn', `外部配線用の端子がありません: ネット ${disp(n)}（${[...names].join(', ')} へつなぐ）`, at, at.map(q => q.part.id));
  }
  return finish(result);

  function finish(r) {
    const order = { error: 0, warn: 1, info: 2 };
    issues.sort((a, b) => order[a.level] - order[b.level]);
    if (!issues.some(i => i.level !== 'info')) issues.unshift({ level: 'ok', msg: net ? '回路図どおりに配線されています' : '配置上の問題はありません', holes: [], parts: [] });
    for (const q of pins) r.pinText.set(`${q.x},${q.y}`, `${pinLabel(q)}${q.nets.length ? ' → ネット ' + [...new Set(q.nets)].map(disp).join('/') : ''}`);
    return r;
  }
}

// 基板の配線どおりのネットリストを作る（値・品番は基板に入力したもの）。res は check() の結果
// 電源・入力・ポットなどの外付け要素は回路図のネット名でつなぐ。外部端子が無ければ自動でつないで警告
function boardNetlist(sheet, net, res) {
  const off = sheet.offboard || {};
  const unplaced = net.elements.filter(e => !res.placed.has(e.name) && !isExternal(e, off)).map(e => e.name);
  if (unplaced.length) return { error: `未配置の部品があるため、基板の音は計算していません（${unplaced.join(', ')}）` };

  // 導通グループ 'r<穴>' と回路図ネット 'n:<名前>' をまとめる union-find
  const par = new Map(), f = k => { while (par.has(k)) k = par.get(k); return k; };
  const unite = (a, b) => { a = f(a); b = f(b); if (a !== b) par.set(a, b); };
  const byPart = new Map(), labeled = new Set(), warnings = [];
  for (const q of res.pins) {
    (byPart.get(q.part.id) || byPart.set(q.part.id, []).get(q.part.id))[q.i] = q;
    if (q.part.kind === 'terminal' && q.nets.length) { unite('r' + res.find(q.h), 'n:' + q.nets[0]); labeled.add(q.nets[0]); }
  }
  // そのネットのピンを一番多く持つ導通グループ
  const bestRoot = n => {
    const cnt = new Map();
    for (const q of res.pins) if (q.part.kind !== 'terminal' && q.nets.includes(n)) { const r = res.find(q.h); cnt.set(r, (cnt.get(r) || 0) + 1); }
    let best = -1, m = 0;
    for (const [r, c] of cnt) if (c > m) { m = c; best = r; }
    return best;
  };
  const ext = net.elements.filter(e => !res.placed.has(e.name) && isExternal(e, off)), auto = [];
  for (const n of new Set(ext.flatMap(e => e.nodes))) {
    if (labeled.has(n)) continue;
    const r = bestRoot(n);
    if (r >= 0) { unite('r' + r, 'n:' + n); auto.push(disp(n)); }
  }
  if (auto.length) warnings.push(`外部端子が無いネットは自動でつないで計算しました: ${auto.join(', ')}`);
  const names = new Map();
  for (const k of [...par.keys(), ...par.values()]) if (k.startsWith('n:')) {
    const g = f(k), n = k.slice(2);
    if (!names.has(g) || n === '0') names.set(g, n);
  }
  const nameOf = k => names.get(f(k)) ?? (k.startsWith('n:') ? k.slice(2) : '~' + f(k));

  const els = new Map(net.elements.map(e => [e.name.toUpperCase(), e])), out = [], extra = [], changed = [];
  for (const p of sheet.parts) {
    const k = KINDS[p.kind];
    if (p.kind === 'wire' || p.kind === 'terminal') continue;
    const pins = byPart.get(p.id) || [];
    const node = i => pins[i] ? nameOf('r' + res.find(pins[i].h)) : `~${p.id}.${i}`;   // 基板外のピンは宙に浮いた節点
    if (k.dip) {
      OPAMP_PINS[p.kind].forEach((map, ui) => {
        const el = els.get(((p.units || [])[ui] || '').toUpperCase());
        if (!el || el.type !== 'X' || el.nodes.length !== 5) return;
        const nodes = [];
        for (const [pin, ni] of Object.entries(map)) nodes[ni] = node(pin - 1);
        out.push({ ...el, nodes });
      });
      continue;
    }
    const el = els.get((p.ref || '').toUpperCase());
    if (!el || !k.letters.includes(el.type)) { extra.push(p.ref || k.label); continue; }
    const nodes = [];
    if (k.two) nodes.push(node(0), node(1));   // 実際に挿さっている向きのまま（逆挿しも音に出る）
    else for (let i = 0; i < 3; i++) nodes[TERM[p.pinout[i]]] = node(i);
    const own = { ...el, nodes };   // 値・品番は基板に入力したもので計算する
    if ('RCL'.includes(el.type)) {
      const v = S.parseValue(p.value, true);
      if (v > 0) own.value = v; else warnings.push(`${p.ref}: 値「${p.value}」を読めないため回路図の値で計算しました`);
      if (Math.abs(own.value - el.value) > el.value * 0.01) changed.push(`${p.ref} ${S.fmt(own.value)}（回路図 ${S.fmt(el.value)}）`);
    } else if (p.value && p.value.toUpperCase() !== el.model) {
      const m = p.value.toUpperCase();
      if (net.models[m] || S.MODELS[m]) { own.model = m; changed.push(`${p.ref} ${m}（回路図 ${el.model}）`); }
      else warnings.push(`${p.ref}: 品番 ${p.value} の特性データが無いため回路図の ${el.model} で計算しました`);
    }
    out.push(own);
  }
  if (extra.length) warnings.push(`回路図にない部品は計算に含めていません: ${extra.join(', ')}`);
  for (const e of ext) out.push({ ...e, nodes: e.nodes.map(n => nameOf('n:' + n)) });

  const o = sheet.simOut;
  let output = '';
  if (names.has(f('n:' + o)) || ext.some(e => e.nodes.includes(o))) output = nameOf('n:' + o);   // 端子・外付け要素でつながっているネット
  else { const r = bestRoot(o); if (r >= 0) output = nameOf('r' + r); }
  if (!output) return { error: `出力ネット ${disp(o)} が基板上に見つかりません` };
  const nodes = [...new Set(out.flatMap(e => e.nodes))].filter(n => n !== '0');
  return { net: { title: '基板', elements: out, models: net.models, nodes, warnings: [] }, output, warnings, changed };
}

return { KINDS, partPins, kindFor, isExternal, check, boardNetlist, disp, normNet, rot };
})();
if (typeof module !== 'undefined') module.exports = Board;
