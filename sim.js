// sim.js — SPICEネットリスト解析と回路シミュレータ（MNA過渡解析・台形積分・Newton法）
const Sim = (() => {
'use strict';

const VT = 0.025852;      // 熱電圧 (300K)
const GMIN = 1e-12;
const AOL = 1e5;          // オペアンプ開ループ利得
const HEADROOM = 1.5;     // ponytail: オペアンプ出力は全品番「電源-1.5V」で飽和。品番別にするならモデル表に持たせる
const SCALE = { t: 1e12, g: 1e9, meg: 1e6, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 };

// "4k7" "10u" "1Meg" "100nF" などを数値に。megaM=true なら大文字 M をメガとして扱う（基板の手入力用）
function parseValue(s, megaM = false) {
  if (s == null) return NaN;
  s = String(s).trim().replace(/[µμ]/g, 'u');
  let m = s.match(/^(\d+)(meg|[tgkmunpfr])(\d+)/i);
  if (m) return parseFloat(m[1] + '.' + m[3]) * scaleOf(m[2], megaM);
  m = s.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?/i);
  return m ? parseFloat(m[1]) * (m[2] ? scaleOf(m[2], megaM) : 1) : NaN;
}
const scaleOf = (u, megaM) => u === 'M' && megaM ? 1e6 : /^r$/i.test(u) ? 1 : SCALE[u.toLowerCase()];

function fmt(v) {
  if (!isFinite(v)) return '?';
  if (v === 0) return '0';
  const a = Math.abs(v);
  for (const [s, u] of [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p']])
    if (a >= s * 0.9995) return +(v / s).toPrecision(3) + u;
  return v.toExponential(2);
}

// 内蔵モデル（エフェクターでよく使う品番の近似値）。pinout は TO-92 平面を手前にして左から
const MODELS = {
  D: { type: 'D' }, NPN: { type: 'NPN' }, PNP: { type: 'PNP' }, NJF: { type: 'NJF' }, PJF: { type: 'PJF' },
  '1N4148': { type: 'D', is: 2.52e-9, n: 1.752 },
  '1N914': { type: 'D', is: 2.52e-9, n: 1.752 },
  '1N4001': { type: 'D', is: 14.11e-9, n: 1.984 },
  '1N34A': { type: 'D', is: 2e-7, n: 1.3 },
  '1N60': { type: 'D', is: 2e-7, n: 1.3 },
  '1N5817': { type: 'D', is: 3e-6, n: 1.1 },
  LED: { type: 'D', is: 7.7e-18, n: 2 },
  '2N3904': { type: 'NPN', is: 6.734e-15, bf: 416.4, br: 0.7371, pinout: 'EBC' },
  '2N2222': { type: 'NPN', is: 14.34e-15, bf: 255.9, br: 6.092, pinout: 'EBC' },
  '2N5088': { type: 'NPN', is: 5.9e-15, bf: 1100, br: 1.8, pinout: 'EBC' },
  '2N5089': { type: 'NPN', is: 5.9e-15, bf: 1400, br: 1.8, pinout: 'EBC' },
  BC549C: { type: 'NPN', is: 1.8e-14, bf: 500, br: 2, pinout: 'CBE' },
  BC109: { type: 'NPN', is: 1.8e-14, bf: 400, br: 2, pinout: 'EBC' },
  '2N3906': { type: 'PNP', is: 1.41e-15, bf: 180.7, br: 4.977, pinout: 'EBC' },
  AC128: { type: 'PNP', is: 2e-7, bf: 100, br: 2, pinout: 'EBC' },
  NKT275: { type: 'PNP', is: 2e-7, bf: 80, br: 2, pinout: 'EBC' },
  J201: { type: 'NJF', beta: 1e-3, vto: -0.8, lambda: 0.01, pinout: 'DSG' },
  '2N5457': { type: 'NJF', beta: 1e-3, vto: -1.5, lambda: 0.01, pinout: 'DSG' },
  MPF102: { type: 'NJF', beta: 4e-4, vto: -3, lambda: 0.01, pinout: 'DSG' },
};
const DEF = {
  D: { is: 1e-14, n: 1 }, NPN: { is: 1e-14, bf: 100, br: 1 }, PNP: { is: 1e-14, bf: 100, br: 1 },
  NJF: { beta: 1e-4, vto: -2, lambda: 0 }, PJF: { beta: 1e-4, vto: -2, lambda: 0 },
};

// net の .model → 内蔵モデル → 既定値 の順で探す。types[0] が既定の型
function getModel(net, name, types) {
  const m = (net && net.models[name]) || MODELS[name];
  const type = m && types.includes(m.type) ? m.type : types[0];
  return Object.assign({}, DEF[type], m, { type, known: !!m });
}

const tokenize = l => l.replace(/[(),]/g, ' ').replace(/\s*=\s*/g, '=').trim().split(/\s+/);

function parseNetlist(text) {
  const out = { title: '', elements: [], models: {}, nodes: [], warnings: [] };
  const lines = [];
  for (const raw of String(text).replace(/\r/g, '').split('\n')) {
    const l = raw.replace(/;.*$/, '').trim();
    if (l[0] === '+' && lines.length) lines[lines.length - 1] += ' ' + l.slice(1);
    else lines.push(l);
  }
  // SPICE の慣習で1行目はタイトル（ただし素子行に見えるなら素子として読む）
  if (lines.length && lines[0][0] === '*') out.title = lines[0].replace(/^\*\s*/, '');
  else if (lines.length && lines[0][0] !== '.' && !/^[RCLV]\S*\s+\S+\s+\S+\s+[\d.]/i.test(lines[0])) out.title = lines.shift();

  const params = {}, raws = [];
  let sub = 0;
  for (const l of lines) {
    if (l.startsWith('*!')) { out.warnings.push(l.slice(2).trim()); continue; }   // 変換時の警告（draw.io 取込など）
    if (!l || l[0] === '*') continue;
    const t = tokenize(l), d = t[0].toLowerCase();
    if (d[0] === '.') {
      if (d === '.subckt') sub++;
      else if (d === '.ends') sub = Math.max(0, sub - 1);
      else if (!sub && d === '.model' && t.length >= 3) {
        const m = { type: t[2].toUpperCase() };
        for (const kv of t.slice(3)) { const [k, v] = kv.split('='); if (v !== undefined) m[k.toLowerCase()] = v; }
        out.models[t[1].toUpperCase()] = m;
      } else if (!sub && d === '.param') {
        for (const kv of t.slice(1)) { const [k, v] = kv.split('='); if (v !== undefined) params[k.toLowerCase()] = v; }
      }
      continue;
    }
    if (!sub) raws.push(t);
  }
  const val = s => { const m = /^\{(\w+)\}$/.exec(s || ''); return m && params[m[1].toLowerCase()] !== undefined ? params[m[1].toLowerCase()] : s; };
  const node = n => /^(0|gnd)$/i.test(n) ? '0' : n.toUpperCase();
  const nodes = new Set();

  for (const t of raws) {
    const name = t[0], L = name[0].toUpperCase();
    const pos = t.filter(s => !s.includes('='));
    let el;
    if ('RCL'.includes(L) && pos.length >= 4) {
      const v = parseValue(val(pos[3]));
      if (!isFinite(v)) { out.warnings.push(`${name}: 値「${pos[3]}」を解釈できないため無視しました`); continue; }
      if (L === 'R' && v < 0.1) out.warnings.push(`${name}: 「${pos[3]}」は SPICE ではミリ(m)です。メガは 1Meg と書きます`);
      el = { name, type: L, nodes: pos.slice(1, 3), value: v };
    } else if (L === 'D' && pos.length >= 4) el = { name, type: L, nodes: pos.slice(1, 3), model: pos[3].toUpperCase() };
    else if ((L === 'Q' || L === 'J') && pos.length >= 5) el = { name, type: L, nodes: pos.slice(1, 4), model: pos[pos.length - 1].toUpperCase() };
    else if ((L === 'V' || L === 'I') && pos.length >= 3) {
      const spec = pos.slice(3).map(s => s.toLowerCase()), i = spec.indexOf('dc');
      let dc = i >= 0 ? parseValue(val(spec[i + 1])) : spec[0] === 'sin' ? parseValue(spec[1]) : parseValue(val(spec[0]));
      if (!isFinite(dc)) dc = 0;
      el = { name, type: L, nodes: pos.slice(1, 3), dc, signal: /sin|ac|pulse|pwl|wavefile/i.test(t.slice(3).join(' ')) };
    } else if (L === 'E' && pos.length >= 6) el = { name, type: L, nodes: pos.slice(1, 5), value: parseValue(val(pos[5])) };
    else if (L === 'X' && pos.length >= 3) el = { name, type: L, nodes: pos.slice(1, -1), sub: pos[pos.length - 1].toUpperCase() };
    else { out.warnings.push(`${name}: 未対応の素子のため無視しました`); continue; }
    if (L === 'E' && !isFinite(el.value)) { out.warnings.push(`${name}: 利得を解釈できないため無視しました`); continue; }
    el.nodes = el.nodes.map(node);
    el.nodes.forEach(n => n !== '0' && nodes.add(n));
    out.elements.push(el);
  }
  for (const m of Object.values(out.models))
    for (const k in m) if (k !== 'type') { const v = parseValue(val(m[k])); if (isFinite(v)) m[k] = v; else delete m[k]; }
  out.nodes = [...nodes].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return out;
}

// SPICE の接合電圧リミッタ（Newton法の発散防止）
function pnjlim(vnew, vold, vt, vcrit) {
  if (vnew > vcrit && Math.abs(vnew - vold) > 2 * vt) {
    if (vold > 0) { const arg = 1 + (vnew - vold) / vt; vnew = arg > 0 ? vold + vt * Math.log(arg) : vcrit; }
    else vnew = vt * Math.log(vnew / vt);
  }
  return vnew;
}

// 密行列LU（部分ピボット）。解は b に入る
function solve(A, b, N) {
  for (let c = 0; c < N; c++) {
    let p = c, mx = Math.abs(A[c * N + c]);
    for (let r = c + 1; r < N; r++) { const v = Math.abs(A[r * N + c]); if (v > mx) { mx = v; p = r; } }
    if (mx < 1e-300) return false;
    if (p !== c) {
      for (let k = c; k < N; k++) { const t = A[c * N + k]; A[c * N + k] = A[p * N + k]; A[p * N + k] = t; }
      const t = b[c]; b[c] = b[p]; b[p] = t;
    }
    const inv = 1 / A[c * N + c];
    for (let r = c + 1; r < N; r++) {
      const f = A[r * N + c] * inv;
      if (f === 0) continue;
      for (let k = c + 1; k < N; k++) A[r * N + k] -= f * A[c * N + k];
      b[r] -= f * b[c];
    }
  }
  for (let c = N - 1; c >= 0; c--) {
    let s = b[c];
    for (let k = c + 1; k < N; k++) s -= A[c * N + k] * b[k];
    b[c] = s / A[c * N + c];
  }
  return true;
}

// 回路を組み立ててDC動作点まで解く。返り値の run() でサンプルを順に処理する
// opts: { input: 入力V源の名前, output: 出力ノード名, rate }
function prepare(net, opts) {
  const warnings = [];
  const map = new Map();
  let n = 0;
  const idx = s => s === '0' ? -1 : map.has(s) ? map.get(s) : (map.set(s, n), n++);
  const els = net.elements.filter(e => {
    if (e.type !== 'X' || e.nodes.length === 5) return true;
    warnings.push(`${e.name}: 5端子(オペアンプ)以外のサブサーキットは未対応のため無視しました`);
    return false;
  });
  els.forEach(e => e.nodes.forEach(idx));
  let N = n;
  const c = { res: [], caps: [], inds: [], vs: [], is: [], es: [], dio: [], bjt: [], jf: [], op: [] };
  let nst = 0;
  const diode = (a, k, is, nn) => {
    const nvt = nn * VT;
    c.dio.push({ a, k, is, nvt, vcrit: nvt * Math.log(nvt / (Math.SQRT2 * is)), s: nst++ });
  };
  const mdl = (e, types) => {
    const m = getModel(net, e.model, types);
    if (!m.known) warnings.push(`${e.name}: モデル ${e.model} が無いため既定値(${m.type})で計算します`);
    return m;
  };
  for (const e of els) {
    const d = e.nodes.map(idx);
    switch (e.type) {
      case 'R': c.res.push([d[0], d[1], 1 / Math.max(e.value, 1e-6)]); break;
      case 'C': c.caps.push({ a: d[0], b: d[1], C: e.value, v: 0, i: 0 }); break;
      case 'L': c.inds.push({ a: d[0], b: d[1], L: Math.max(e.value, 1e-12), v: 0, i: 0 }); break;
      case 'V': c.vs.push({ a: d[0], b: d[1], k: N++, dc: e.dc, input: e.name === opts.input }); break;
      case 'I': c.is.push({ a: d[0], b: d[1], dc: e.dc }); break;
      case 'E': c.es.push({ a: d[0], b: d[1], cp: d[2], cn: d[3], g: e.value, k: N++ }); break;
      case 'D': { const m = mdl(e, ['D']); diode(d[0], d[1], m.is, m.n); break; }
      case 'Q': {
        const m = mdl(e, ['NPN', 'PNP']), is = m.is;
        c.bjt.push({ c: d[0], b: d[1], e: d[2], pol: m.type === 'PNP' ? -1 : 1, is, bf: m.bf, br: m.br, vcrit: VT * Math.log(VT / (Math.SQRT2 * is)), s: nst });
        nst += 2; break;
      }
      case 'J': {
        const m = mdl(e, ['NJF', 'PJF']), pol = m.type === 'PJF' ? -1 : 1;
        c.jf.push({ d: d[0], g: d[1], s: d[2], pol, beta: m.beta, vto: m.vto, lambda: m.lambda });
        if (pol > 0) { diode(d[1], d[2], 1e-14, 1); diode(d[1], d[0], 1e-14, 1); }   // ゲート接合
        else { diode(d[2], d[1], 1e-14, 1); diode(d[0], d[1], 1e-14, 1); }
        break;
      }
      case 'X': c.op.push({ p: d[0], m: d[1], vp: d[2], vn: d[3], o: d[4], k: N++, s: nst++ }); break;
    }
  }
  if (!c.vs.some(v => v.input)) throw new Error('入力にする電圧源(V)を選んでください');
  const out = map.get(opts.output);
  if (out === undefined) throw new Error('出力ノードを選んでください');

  const A = new Float64Array(N * N), R = new Float64Array(N), R0 = new Float64Array(N);
  const x = new Float64Array(N), st = new Float64Array(nst);
  const bases = new Map();
  const add = (i, j, v) => { if (i >= 0 && j >= 0) A[i * N + j] += v; };
  const G2 = (a, b, g) => { add(a, a, g); add(b, b, g); add(a, b, -g); add(b, a, -g); };
  const V = i => i < 0 ? 0 : x[i];

  // 線形部分の行列（h=0 は DC）。ステップ幅ごとにキャッシュ
  function base(h) {
    let B = bases.get(h);
    if (B) return B;
    A.fill(0);
    for (let i = 0; i < n; i++) A[i * N + i] += GMIN;
    for (const [a, b, g] of c.res) G2(a, b, g);
    for (const e of c.caps) if (h) G2(e.a, e.b, 2 * e.C / h);
    for (const e of c.inds) G2(e.a, e.b, h ? h / (2 * e.L) : 1e3);
    for (const e of c.vs.concat(c.es)) { add(e.a, e.k, 1); add(e.b, e.k, -1); add(e.k, e.a, 1); add(e.k, e.b, -1); }
    for (const e of c.es) { add(e.k, e.cp, -e.g); add(e.k, e.cn, e.g); }
    for (const e of c.op) { add(e.o, e.k, 1); add(e.k, e.o, 1); }
    bases.set(h, B = A.slice());
    return B;
  }
  function rhs(h, scale, vin) {
    R0.fill(0);
    for (const e of c.vs) R0[e.k] = (e.input ? e.dc + vin : e.dc) * scale;
    for (const e of c.is) { if (e.a >= 0) R0[e.a] -= e.dc * scale; if (e.b >= 0) R0[e.b] += e.dc * scale; }
    if (!h) return;
    for (const e of c.caps) { const q = 2 * e.C / h * e.v + e.i; if (e.a >= 0) R0[e.a] += q; if (e.b >= 0) R0[e.b] -= q; }
    for (const e of c.inds) { const q = e.i + h / (2 * e.L) * e.v; if (e.a >= 0) R0[e.a] -= q; if (e.b >= 0) R0[e.b] += q; }
  }
  // 端子 t から流れ出す電流 = g1*(V[p1]-V[n1]) + g2*(V[p2]-V[n2]) + ieq
  function stampI(t, g1, p1, n1, g2, p2, n2, ieq) {
    if (t < 0) return;
    const r = t * N;
    if (p1 >= 0) A[r + p1] += g1;
    if (n1 >= 0) A[r + n1] -= g1;
    if (p2 >= 0) A[r + p2] += g2;
    if (n2 >= 0) A[r + n2] -= g2;
    R[t] -= ieq;
  }
  function nonlinear() {
    let lim = false;
    for (const d of c.dio) {
      const v0 = V(d.a) - V(d.k), v = pnjlim(v0, st[d.s], d.nvt, d.vcrit);
      if (v !== v0) lim = true;
      st[d.s] = v;
      const ex = Math.exp(Math.min(v / d.nvt, 80));
      const g = d.is * ex / d.nvt + GMIN, ieq = d.is * (ex - 1) + GMIN * v - g * v;
      stampI(d.a, g, d.a, d.k, 0, -1, -1, ieq);
      stampI(d.k, -g, d.a, d.k, 0, -1, -1, -ieq);
    }
    for (const q of c.bjt) {
      const p = q.pol, be0 = p * (V(q.b) - V(q.e)), bc0 = p * (V(q.b) - V(q.c));
      const be = pnjlim(be0, st[q.s], VT, q.vcrit), bc = pnjlim(bc0, st[q.s + 1], VT, q.vcrit);
      if (be !== be0 || bc !== bc0) lim = true;
      st[q.s] = be; st[q.s + 1] = bc;
      const ef = Math.exp(Math.min(be / VT, 80)), er = Math.exp(Math.min(bc / VT, 80));
      const gf = q.is * ef / VT, gr = q.is * er / VT;
      const ic = q.is * (ef - er) - q.is / q.br * (er - 1), ib = q.is / q.bf * (ef - 1) + q.is / q.br * (er - 1);
      const cbe = gf, cbc = -gr - gr / q.br, bbe = gf / q.bf + GMIN, bbc = gr / q.br + GMIN;
      const ieqc = p * (ic - cbe * be - cbc * bc), ieqb = p * (ib + GMIN * (be + bc) - bbe * be - bbc * bc);
      stampI(q.c, cbe, q.b, q.e, cbc, q.b, q.c, ieqc);
      stampI(q.b, bbe, q.b, q.e, bbc, q.b, q.c, ieqb);
      stampI(q.e, -cbe - bbe, q.b, q.e, -cbc - bbc, q.b, q.c, -ieqc - ieqb);
    }
    for (const j of c.jf) {
      const p = j.pol, vgs = p * (V(j.g) - V(j.s)), vgd = p * (V(j.g) - V(j.d));
      const rev = vgs < vgd;                               // vds < 0 ならドレインとソースを入れ替えて計算
      const vg = rev ? vgd : vgs, vd = Math.abs(vgs - vgd), D = rev ? j.s : j.d, S = rev ? j.d : j.s;
      const vov = vg - j.vto, lam = 1 + j.lambda * vd;
      let id = 0, gm = 0, gds = 0;
      if (vov > 0 && vd < vov) {
        id = j.beta * vd * (2 * vov - vd) * lam; gm = 2 * j.beta * vd * lam;
        gds = j.beta * (2 * vov - 2 * vd) * lam + j.lambda * j.beta * vd * (2 * vov - vd);
      } else if (vov > 0) {
        id = j.beta * vov * vov * lam; gm = 2 * j.beta * vov * lam; gds = j.lambda * j.beta * vov * vov;
      }
      gds += GMIN; id += GMIN * vd;
      const ieq = p * (id - gm * vg - gds * vd);
      stampI(D, gm, j.g, S, gds, D, S, ieq);
      stampI(S, -gm, j.g, S, -gds, D, S, -ieq);
    }
    for (const o of c.op) {
      const top = V(o.vp), bot = V(o.vn), mid = (top + bot) / 2, half = Math.max((top - bot) / 2 - HEADROOM, 0.05);
      let vd = V(o.p) - V(o.m), th = Math.tanh((AOL * vd - mid) / half);
      // 飽和域は傾き0でレール間を往復するので、出力の変化を1反復1Vに制限して線形域で接線を取る
      const f = mid + half * th, fo = st[o.s];
      if (Math.abs(f - fo) > 1) {
        th = Math.max(-0.99, Math.min(0.99, (fo + Math.sign(f - fo) - mid) / half));
        vd = (Math.atanh(th) * half + mid) / AOL;
        lim = true;
      }
      st[o.s] = mid + half * th;
      const fp = AOL * (1 - th * th), r = o.k * N;
      if (o.p >= 0) A[r + o.p] -= fp;
      if (o.m >= 0) A[r + o.m] += fp;
      R[o.k] += mid + half * th - fp * vd;
    }
    return lim;
  }
  function newton(h, scale, vin, maxIt) {
    const B = base(h);
    rhs(h, scale, vin);
    for (let it = 0; it < maxIt; it++) {
      A.set(B); R.set(R0);
      const lim = nonlinear();
      if (!solve(A, R, N)) return false;
      let ok = !lim;
      for (let i = 0; i < N; i++) {
        if (!isFinite(R[i])) return false;
        if (Math.abs(R[i] - x[i]) > 1e-6 + 1e-4 * Math.abs(R[i])) ok = false;
        x[i] = R[i];
      }
      if (ok) return true;
    }
    return false;
  }

  // DC動作点（だめならソースステッピング）
  let ok = newton(0, 1, 0, 300);
  if (!ok) {
    x.fill(0); st.fill(0); ok = true;
    for (let k = 1; k <= 50 && ok; k++) ok = newton(0, k / 50, 0, 300);
  }
  if (!ok) throw new Error('DC動作点が求まりませんでした（電源や配線が欠けていないか確認してください）');
  for (const e of c.caps) e.v = V(e.a) - V(e.b);
  for (const e of c.inds) { e.v = V(e.a) - V(e.b); e.i = 1e3 * e.v; }

  const h0 = 1 / opts.rate, saves = [];
  let fails = 0;
  function accept(h) {
    for (const e of c.caps) { const v = V(e.a) - V(e.b); e.i = 2 * e.C / h * (v - e.v) - e.i; e.v = v; }
    for (const e of c.inds) { const v = V(e.a) - V(e.b); e.i += h / (2 * e.L) * (v + e.v); e.v = v; }
  }
  // 収束しなければステップを半分に割って再試行
  function step(h, v0, v1, depth) {
    const s = saves[depth] || (saves[depth] = { x: new Float64Array(N), st: new Float64Array(nst) });
    s.x.set(x); s.st.set(st);
    if (newton(h, 1, v1, 40)) { accept(h); return; }
    x.set(s.x); st.set(s.st);
    if (depth >= 6) { fails++; accept(h); return; }   // あきらめて前の値を保持
    const vm = (v0 + v1) / 2;
    step(h / 2, v0, vm, depth + 1);
    step(h / 2, vm, v1, depth + 1);
  }
  return {
    warnings,
    get fails() { return fails; },
    dc: name => V(map.get(name) ?? -1),
    // signal[from..to) を処理して出力ノード電圧を dst に書く
    run(signal, dst, from, to) {
      for (let k = from; k < to; k++) {
        step(h0, k ? signal[k - 1] : 0, signal[k], 0);
        dst[k] = x[out];
      }
    },
  };
}

// 基数2の FFT（その場で計算）
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a), h = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < h; k++) {
        const p = i + k, q = p + h, tr = re[q] * cr - im[q] * ci, ti = re[q] * ci + im[q] * cr;
        re[q] = re[p] - tr; im[q] = im[p] - ti; re[p] += tr; im[p] += ti;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
// 音色の特徴: 1/3オクターブ20帯域(約100Hz〜8kHz)の平均レベル(dB, 全体比) と クレストファクター(dB, 小さいほど歪み・圧縮が強い)
function toneProfile(x, rate) {
  const N = 4096, re = new Float64Array(N), im = new Float64Array(N), pow = new Float64Array(N / 2);
  for (let s = 0; s + N <= x.length; s += N / 2) {
    for (let i = 0; i < N; i++) { re[i] = x[s + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N)); im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < N / 2; k++) pow[k] += re[k] * re[k] + im[k] * im[k];
  }
  const fc = [], e = [];
  for (let b = -10; b <= 9; b++) {
    const c = 1000 * 2 ** (b / 3);
    let sum = 0;
    for (let k = Math.ceil(c / 2 ** (1 / 6) * N / rate); k <= Math.floor(c * 2 ** (1 / 6) * N / rate); k++) sum += pow[k];
    fc.push(c); e.push(sum);
  }
  const total = e.reduce((a, b) => a + b, 0) || 1e-30;
  let db = e.map(v => 10 * Math.log10(v / total + 1e-15));
  const top = Math.max(...db);
  db = db.map(v => Math.max(v, top - 50));   // 何も鳴っていない帯域で差が暴れないように
  // 99.9パーセンタイル/RMS（ピックの一瞬のピークに引きずられないように）
  const abs = new Float32Array(Math.ceil(x.length / 4));
  let ss = 0;
  for (let i = 0; i < x.length; i++) ss += x[i] * x[i];
  for (let i = 0; i < abs.length; i++) abs[i] = Math.abs(x[i * 4]);
  abs.sort();
  const crest = 20 * Math.log10((abs[Math.floor(abs.length * 0.999)] || 1e-12) / (Math.sqrt(ss / x.length) || 1e-12));
  return { fc, db, crest };
}
// 手本 t と比べた x の違い: tone = 帯域バランスの差(dB RMS), crest = 歪み感の差(dB, 負なら x の方が歪み・圧縮が強い), low/mid/high = 帯域ごとの偏り(dB)
function compareTone(t, x) {
  const d = x.db.map((v, i) => v - t.db[i]), m = d.reduce((a, b) => a + b, 0) / d.length, dd = d.map(v => v - m);
  const avg = (lo, hi) => { const s = dd.filter((_, i) => t.fc[i] >= lo && t.fc[i] < hi); return s.reduce((a, b) => a + b, 0) / s.length; };
  return { tone: Math.sqrt(dd.reduce((a, v) => a + v * v, 0) / dd.length), crest: x.crest - t.crest, low: avg(0, 300), mid: avg(300, 2000), high: avg(2000, 1e9) };
}

const SAMPLES = {
  'Distortion+ (オペアンプ歪み)': `* Distortion+ (MXR系) サンプル
V1 VCC 0 9
VIN IN 0 SIN(0 0.5 440)
R1 IN 0 1Meg
C1 IN N1 10n
R2 N1 INP 10k
R3 INP VREF 1Meg
R4 VCC VREF 100k
R5 VREF 0 100k
C2 VREF 0 10u
XU1 INP INM VCC 0 OPOUT LM741
R6 OPOUT INM 1Meg
R7 INM N2 4.7k
RPOT1 N2 N3 50k  ; Distortion ポット
C3 N3 0 47n
C4 OPOUT N4 1u
R8 N4 CLIP 10k
D1 CLIP 0 1N34A
D2 0 CLIP 1N34A
C5 CLIP 0 1n
RPOT2A CLIP OUT 5k  ; Volume ポット(10k の中点)
RPOT2B OUT 0 5k
.end`,
  'LPB-1 (トランジスタ・ブースター)': `* LPB-1 Linear Power Booster サンプル
V1 VCC 0 9
VIN IN 0 SIN(0 0.3 440)
C1 IN B 100n
R1 VCC B 430k
R2 B 0 43k
Q1 C B E 2N5088
R3 VCC C 10k
R4 E 0 390
C2 C OUT 100n
RPOT1 OUT 0 100k  ; Volume ポット
.end`,
};

return { parseValue, fmt, parseNetlist, prepare, getModel, toneProfile, compareTone, MODELS, SAMPLES };
})();
if (typeof module !== 'undefined') module.exports = Sim;
