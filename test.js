// test.js — 自己チェック。実行: node test.js
const assert = require('assert');
const Sim = require('./sim.js');

const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: ${a} != ${b}`);
const RATE = 48000;
function sine(f, amp, sec) { return Float64Array.from({ length: Math.round(sec * RATE) }, (_, i) => amp * Math.sin(2 * Math.PI * f * i / RATE)); }
function simulate(text, input, output, sig) {
  const s = Sim.prepare(typeof text === 'string' ? Sim.parseNetlist(text) : text, { input, output, rate: RATE });
  const out = new Float64Array(sig.length);
  s.run(sig, out, 0, sig.length);
  return { s, out };
}
const peak = (a, from = 0) => { let m = 0; for (let i = from; i < a.length; i++) m = Math.max(m, Math.abs(a[i])); return m; };
const swing = (a, from) => { let lo = Infinity, hi = -Infinity; for (let i = from; i < a.length; i++) { lo = Math.min(lo, a[i]); hi = Math.max(hi, a[i]); } return (hi - lo) / 2; };

// 値の解釈
assert.strictEqual(Sim.parseValue('4k7'), 4700);
assert.strictEqual(Sim.parseValue('1Meg'), 1e6);
near(Sim.parseValue('100nF'), 1e-7, 1e-20, '100nF');
near(Sim.parseValue('1M'), 1e-3, 1e-15, 'SPICE の M はミリ');
assert.strictEqual(Sim.parseValue('1M', true), 1e6);
assert.strictEqual(Sim.fmt(4700), '4.7k');

// 分圧（DC）
{
  const { s } = simulate('t\nV1 A 0 10\nVIN X 0 0\nR1 A B 1k\nR2 B 0 1k\nR3 X 0 1k', 'VIN', 'B', new Float64Array(1));
  near(s.dc('B'), 5, 1e-6, '分圧');
}
// RC ローパス: fc で -3dB
{
  const { out } = simulate('t\nVIN IN 0 SIN(0 1 1k)\nR1 IN OUT 1k\nC1 OUT 0 159.15n', 'VIN', 'OUT', sine(1000, 1, 0.02));
  near(swing(out, 720), Math.SQRT1_2, 0.01, 'RCローパス');
}
// LPB-1: バイアスと利得
{
  const net = Sim.SAMPLES['LPB-1 (トランジスタ・ブースター)'];
  const { s, out } = simulate(net, 'VIN', 'OUT', sine(1000, 0.01, 0.03));
  const vc = s.dc('C');
  assert(vc > 3 && vc < 5.5, `LPB-1 コレクタ電圧 ${vc}`);
  const g = swing(out, 960) / 0.01;
  assert(g > 15 && g < 30, `LPB-1 利得 ${g}`);
  console.log(`LPB-1: Vc=${vc.toFixed(2)}V 利得=${g.toFixed(1)}倍`);
}
// Distortion+: ダイオードでクリップされる
{
  const net = Sim.SAMPLES['Distortion+ (オペアンプ歪み)'];
  const t0 = Date.now();
  const { s, out } = simulate(net, 'VIN', 'OUT', sine(440, 0.5, 0.1));
  near(s.dc('VREF'), 4.5, 0.01, 'VREF');
  const sw = swing(out, 2400);
  assert(sw > 0.05 && sw < 0.3, `Distortion+ 出力振幅 ${sw}`);
  assert.strictEqual(s.fails, 0, '収束失敗なし');
  console.log(`Distortion+: 出力±${sw.toFixed(3)}V (0.1秒を ${Date.now() - t0}ms)`);
}
console.log('sim OK');

// 基板と回路図の照合
const Board = require('./check.js');
{
  const net = Sim.parseNetlist('t\nVIN A 0 SIN(0 2 1k)\nR1 A B 1k\nR2 B 0 1k\nD1 B 0 1N4148');
  let id = 1;
  const two = (kind, ref, value, a, b) => ({ id: id++, kind, ref, value, a: { x: a[0], y: a[1] }, b: { x: b[0], y: b[1] } });
  const term = (label, x, y) => ({ id: id++, kind: 'terminal', label, x, y, rot: 0 });
  const good = () => [
    term('A', 0, 4), two('wire', '', '', [0, 4], [0, 0]),
    two('resistor', 'R1', '1k', [0, 0], [4, 0]), two('wire', '', '', [4, 0], [4, 2]),
    two('resistor', 'R2', '1k', [4, 2], [8, 2]), two('wire', '', '', [4, 2], [4, 4]),
    two('diode', 'D1', '1N4148', [4, 4], [7, 4]), two('wire', '', '', [7, 4], [8, 4]), two('wire', '', '', [8, 4], [8, 2]),
    term('GND', 9, 4), two('wire', '', '', [8, 4], [9, 4]),
  ];
  const run = mod => { const parts = good(); mod(parts); return Board.check({ board: { cols: 12, rows: 6 }, parts, offboard: {} }, net); };
  const msgs = r => r.issues.map(i => i.level + ':' + i.msg);
  const has = (r, level, text) => assert(r.issues.some(i => i.level === level && i.msg.includes(text)), `${level}「${text}」が無い: ${msgs(r)}`);

  let r = run(() => {});
  assert.deepStrictEqual(msgs(r), ['ok:回路図どおりに配線されています']);
  r = run(p => { const d = p.find(x => x.ref === 'D1'); [d.a, d.b] = [d.b, d.a]; });
  has(r, 'error', '極性');
  r = run(p => { const r1 = p.find(x => x.ref === 'R1'); [r1.a, r1.b] = [r1.b, r1.a]; });
  assert.deepStrictEqual(msgs(r), ['ok:回路図どおりに配線されています'], '抵抗は逆向きでも可');
  r = run(p => p.splice(3, 1));
  has(r, 'error', '未接続: ネット B');
  assert.strictEqual(r.airwires.length, 1);
  r = run(p => p.push(two('wire', '', '', [0, 0], [4, 0])));
  has(r, 'error', 'ショート');
  r = run(p => { p.find(x => x.ref === 'R1').value = '2k'; });
  has(r, 'error', '値が違います');
  r = run(p => p.splice(9, 2));
  has(r, 'warn', '外部配線用の端子がありません: ネット GND');
  r = run(p => p.splice(6, 1));
  has(r, 'warn', '未配置の部品 1 個: D1');

  // 基板の配線どおりのシミュレーション
  const sig = sine(1000, 2, 0.005);
  const play = (n, output) => simulate(n, 'VIN', output, sig).out;
  const ref = play(Sim.parseNetlist('t\nVIN A 0 SIN(0 2 1k)\nR1 A B 1k\nR2 B 0 1k\nD1 B 0 1N4148'), 'B');
  const board = mod => {
    const parts = good(); mod(parts);
    const sheet = { board: { cols: 12, rows: 6 }, parts, offboard: {}, simOut: 'B' };
    return Board.boardNetlist(sheet, net, Board.check(sheet, net));
  };
  const diff = (a, b) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);
  let bn = board(() => {});
  assert(!bn.error && !bn.warnings.length, JSON.stringify(bn.error || bn.warnings));
  assert(diff(play(bn.net, bn.output), ref) < 1e-6, '正しい配線は回路図と同じ音');
  bn = board(p => { const d = p.find(x => x.ref === 'D1'); [d.a, d.b] = [d.b, d.a]; });
  assert(diff(play(bn.net, bn.output), ref) > 0.3, 'ダイオード逆挿しは音が変わる');
  bn = board(p => p.splice(9, 2));
  assert(bn.warnings.some(w => w.includes('自動で')), '端子が無ければ自動でつなぐ');
  assert(diff(play(bn.net, bn.output), ref) < 1e-6, '自動でつないでも同じ音');
  bn = board(p => p.splice(3, 1));
  assert(diff(play(bn.net, bn.output), ref) > 0.3, '配線が切れていれば音が変わる');
  bn = board(p => p.splice(6, 1));
  assert(bn.error && bn.error.includes('未配置'), '未配置があれば計算しない');
  bn = board(p => { p.find(x => x.ref === 'R1').value = '2k'; });
  assert(bn.changed.some(s => s.startsWith('R1 2k')) && diff(play(bn.net, bn.output), ref) > 0.05, '基板で値を変えると音に出る');
  bn = board(p => { p.find(x => x.ref === 'R1').value = '?'; });
  assert(bn.warnings.some(w => w.includes('読めない')) && diff(play(bn.net, bn.output), ref) < 1e-6, '読めない値は回路図の値で計算');
}
console.log('check OK');

// 音色の比較（手本との比較に使う）
{
  const n = 2 * RATE, x = new Float64Array(n);
  for (let h = 1; 110 * h < 8000; h++) for (let i = 0; i < n; i++) x[i] += Math.sin(2 * Math.PI * 110 * h * i / RATE + h) / h * Math.exp(-i / RATE);
  const lp = new Float64Array(n), a = Math.exp(-2 * Math.PI * 1000 / RATE);
  for (let i = 1; i < n; i++) lp[i] = (1 - a) * x[i] + a * lp[i - 1];
  const clip = x.map(v => Math.max(-0.2, Math.min(0.2, v)));
  const t = Sim.toneProfile(x, RATE);
  let c = Sim.compareTone(t, Sim.toneProfile(x.map(v => v * 3), RATE));
  assert(c.tone < 0.01 && Math.abs(c.crest) < 0.01, '音量が違うだけなら同じ音色');
  c = Sim.compareTone(t, Sim.toneProfile(lp, RATE));
  assert(c.high < -3 && c.tone > 3, `ローパスは高域が少ない: ${JSON.stringify(c)}`);
  c = Sim.compareTone(t, Sim.toneProfile(clip, RATE));
  assert(c.crest < -3, `クリップすると歪み感(クレスト)が下がる: ${c.crest}`);
}
console.log('tone OK');

// draw.io 回路図の取り込み
const Drawio = require('./drawio.js');
(async () => {
  const E = 'mxgraph.electrical.';
  const v = (id, shape, x, y, w, h, value = '', extra = '') =>
    `<mxCell id="${id}" value="${value}" style="${shape.includes('=') ? shape : 'shape=' + E + shape}${extra ? ';' + extra : ''}" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/></mxCell>`;
  const pt = (p, as) => `<mxPoint x="${p[0]}" y="${p[1]}"${as ? ` as="${as}"` : ''}/>`;
  const w = (id, src, tgt, o = {}) => `<mxCell id="${id}" style="endArrow=none;${o.style || ''}" edge="1" parent="1"${src ? ` source="${src}"` : ''}${tgt ? ` target="${tgt}"` : ''}>` +
    `<mxGeometry relative="1" as="geometry">${o.sp ? pt(o.sp, 'sourcePoint') : ''}${o.tp ? pt(o.tp, 'targetPoint') : ''}${o.pts ? `<Array as="points">${o.pts.map(p => pt(p)).join('')}</Array>` : ''}</mxGeometry></mxCell>`;
  const model = cells => `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells.join('')}</root></mxGraphModel>`;
  const conv = async x => { const r = await Drawio.toSpice(x); return { ...r, net: Sim.parseNetlist(r.text) }; };
  const elOf = (net, n) => net.elements.find(e => e.name === n);

  // 値・品番の読み方
  for (const [t, want] of [['5 K', 5e3], ['0,1uF', 1e-7], ['4k7', 4700], ['1M', 1e6], ['1Meg', 1e6], ['470', 470], ['10 uF', 1e-5], ['2n2', 2.2e-9], ['100nF', 1e-7], ['5.1 K', 5100], ['10 Ohm', 10]])
    near(Drawio.readValue(t), want, want * 1e-9, `値「${t}」`);
  assert(isNaN(Drawio.readValue('"Drive"')) && isNaN(Drawio.readValue('PNP Ge')));
  assert.strictEqual(Drawio.readModel('PNP Ge', 'PNP').model, 'NKT275');
  assert.strictEqual(Drawio.readModel('2n3904', 'NPN').model, '2N3904');
  assert(Drawio.readModel('NPN Ge', 'NPN').def, 'Ge の NPN は .model を自前で出す');
  assert(Drawio.readModel('2SA1015', 'PNP').unknown, '未知の品番');
  // 端子の向き（図形の描画から確認した極性を固定）
  const roles = s => Drawio.SHAPES[E + s].pins.map(p => `${p[2]}@${p[0]},${p[1]}`).join(' ');
  assert.strictEqual(roles('transistors.npn_transistor_1'), 'C@0.7,0 E@0.7,1 B@0,0.5');
  assert.strictEqual(roles('transistors.pnp_transistor_1'), 'E@0.7,0 C@0.7,1 B@0,0.5');
  assert.strictEqual(roles('transistors.pnp_transistor_2'), 'C@1,0 E@1,1 B@0,0.5');
  assert.strictEqual(roles('capacitors.capacitor_3'), '+@0,0.5 -@1,0.5');
  assert.strictEqual(roles('diodes.diode'), 'A@0,0.5 K@1,0.5');
  assert.strictEqual(roles('miscellaneous.batteryStack'), '-@0,0.5 +@1,0.5');
  // 回転・反転（mxGraph.getConnectionPoint と同じ）: 下向きの抵抗は左端が上、さらに flipV で下へ
  const res = st => ({ box: { x: 240, y: 80, w: 20, h: 100 }, style: st });
  assert.deepStrictEqual(Drawio.connPoint(res({ direction: 'south' }), 0, 0.5), { x: 250, y: 80 });
  assert.deepStrictEqual(Drawio.connPoint(res({ direction: 'south', flipV: '1' }), 0, 0.5), { x: 250, y: 180 });
  assert.deepStrictEqual(Drawio.connPoint(res({ direction: 'south', flipH: '1' }), 0, 0.5), { x: 250, y: 80 });

  // A: 信号源 → R1 → (接続ドット) → R2(下向き) と D1(rotation=90) → GND。D1 のカソードは浮いた線で GND へ
  const A = model([
    v('src', 'signal_sources.ac_source', 0, 100, 60, 60), v('g3', 'signal_sources.protective_earth', 15, 200, 30, 20),
    v('r1', 'resistors.resistor_2', 100, 40, 100, 20, 'R1 1k'), v('j1', 'ellipse;fillColor=#000000', 246, 46, 8, 8),
    v('r2', 'resistors.resistor_2', 240, 80, 20, 100, 'R2 1k', 'direction=south'), v('g1', 'signal_sources.protective_earth', 235, 200, 30, 20),
    v('d1', 'diodes.diode', 310, 110, 100, 60, 'D1 1N4148', 'rotation=90'), v('g2', 'signal_sources.protective_earth', 345, 230, 30, 20),
    w('w1', 'src', 'r1', { style: 'exitX=0.5;exitY=0;entryX=0;entryY=0.5', pts: [[30, 50]] }), w('w2', 'r1', 'j1', { style: 'exitX=1;exitY=0.5' }),
    w('w3', 'j1', 'r2', { style: 'entryX=0;entryY=0.5' }), w('w4', 'j1', 'd1', { style: 'entryX=0;entryY=0.5', pts: [[360, 50]] }),
    w('w5', 'r2', 'g1', { style: 'exitX=1;exitY=0.5;entryX=0.5;entryY=0' }), w('w6', null, 'g2', { sp: [360, 190] }),
    w('w7', 'src', 'g3', { style: 'exitX=0.5;exitY=1' }),
  ]);
  const checkA = net => {
    const [r1, r2, d1, vin] = ['R1', 'R2', 'D1', 'VIN'].map(n => elOf(net, n));
    assert(r1 && r2 && d1 && vin, net.elements.map(e => e.name).join());
    const mid = r1.nodes[1];
    assert.deepStrictEqual(vin.nodes, ['IN', '0']);
    assert.deepStrictEqual(r1.nodes, ['IN', mid]);
    assert.deepStrictEqual(r2.nodes, [mid, '0'], 'R2 は分圧点と GND');
    assert.deepStrictEqual(d1.nodes, [mid, '0'], 'D1 は回転していてもアノードが分圧点・カソードが GND');
    assert.strictEqual(r1.value, 1000);
    assert.strictEqual(d1.model, '1N4148');
  };
  let r = await conv(`<mxfile><diagram name="分圧">${A}</diagram></mxfile>`);
  checkA(r.net);
  checkA((await conv(A)).net);   // mxfile 無しの mxGraphModel だけでも読める
  const packed = require('zlib').deflateRawSync(Buffer.from(encodeURIComponent(A))).toString('base64').replace(/(.{60})/g, '$1\n');
  r = await conv(`<mxfile><diagram name="メモ">${model([v('t', 'text;html=1', 0, 0, 80, 20, 'メモ')])}</diagram><diagram name="回路">${packed}</diagram></mxfile>`);
  checkA(r.net);   // 圧縮されたページ・電気図形のあるページを選ぶ
  assert(r.warnings.some(x => x.includes('「メモ」')), 'ほかのページは警告に出す');

  // B: T字・交差・反転した電解・ポット(ワイパーの矢印)・オペアンプ電源の自動接続・ジャック
  const B = model([
    v('bat', 'miscellaneous.batteryStack', 0, 0, 60, 30, '9V'), v('gb', 'signal_sources.protective_earth', -15, 40, 30, 20),
    w('wb', 'bat', 'gb', { style: 'exitX=0;exitY=0.5;entryX=0.5;entryY=0' }),
    v('u1', 'abstract.operational_amp_1', 200, 100, 100, 60, 'U1 TL072'),
    v('jin', 'ellipse;fillColor=none', 20, 130, 40, 40), v('tin', 'text;html=1', 20, 175, 40, 20, '&quot;IN&quot;'),
    v('c1', 'capacitors.capacitor_3', 100, 135, 40, 30, '10uF', 'flipH=1'),
    w('wi', 'jin', 'c1', { style: 'exitX=1;exitY=0.5;entryX=1;entryY=0.5' }), w('wc', 'c1', 'u1', { style: 'exitX=0;exitY=0.5;entryX=0;entryY=0.8333' }),
    w('wo', 'u1', null, { style: 'exitX=1;exitY=0.5', tp: [440, 130] }),
    v('r3', 'resistors.resistor_2', 340, 160, 20, 60, '47 K', 'direction=south'), v('g3', 'signal_sources.protective_earth', 335, 240, 30, 20),
    w('wt', null, 'r3', { sp: [350, 130], style: 'entryX=0;entryY=0.5' }), w('wr3', 'r3', 'g3', { style: 'exitX=1;exitY=0.5;entryX=0.5;entryY=0' }),
    v('r4', 'resistors.resistor_2', 370, 240, 20, 60, '100k', 'direction=south'), v('g4', 'signal_sources.protective_earth', 365, 320, 30, 20),
    w('wx', 'bat', null, { style: 'exitX=1;exitY=0.5', pts: [[380, 15]], tp: [380, 240] }), w('wr4', 'r4', 'g4', { style: 'exitX=1;exitY=0.5;entryX=0.5;entryY=0' }),
    v('vr', 'resistors.resistor_2', 150, 40, 100, 20), v('tvr', 'text;html=1', 150, 12, 100, 20, '&quot;Gain&quot; 100K'),
    w('wm', 'u1', 'vr', { style: 'exitX=0;exitY=0.1667;entryX=0;entryY=0.5', pts: [[150, 110]] }),
    w('ww', 'u1', null, { style: 'exitX=1;exitY=0.5;endArrow=block', pts: [[320, 80], [200, 80]], tp: [200, 58] }),
    v('gp', 'signal_sources.protective_earth', 255, 60, 30, 20), w('wp', 'vr', 'gp', { style: 'exitX=1;exitY=0.5;entryX=0.5;entryY=0' }),
    v('jout', 'ellipse;fillColor=none', 460, 110, 40, 40, 'OUT'), w('wj', null, 'jout', { sp: [440, 130], style: 'entryX=0;entryY=0.5' }),
  ]);
  r = await conv(B);
  const u1 = elOf(r.net, 'XU1'), c1 = elOf(r.net, 'C1'), r3 = elOf(r.net, 'R1'), r4 = elOf(r.net, 'R2');
  const pa = elOf(r.net, 'RPOT_GAIN_A'), pb = elOf(r.net, 'RPOT_GAIN_B'), bat = elOf(r.net, 'V1');
  assert(u1 && c1 && r3 && r4 && pa && pb && bat, r.text);
  assert.deepStrictEqual(bat.nodes, ['VCC', '0']); assert.strictEqual(bat.dc, 9);
  assert.deepStrictEqual(u1.nodes.slice(2, 4), ['VCC', '0'], 'オペアンプ電源は VCC/GND へ');
  assert(r.warnings.some(x => x.includes('電源ピン')));
  assert.deepStrictEqual(c1.nodes, [u1.nodes[0], 'IN'], '反転した電解も＋側は IN+');
  assert.strictEqual(u1.nodes[4], 'OUT', 'ジャックの OUT');
  assert.deepStrictEqual(r3.nodes, ['OUT', '0'], 'T字でつながる');
  assert.deepStrictEqual(r4.nodes, ['VCC', '0'], '交差しただけの線はつながらない');
  assert.deepStrictEqual([pa.nodes, pb.nodes], [[u1.nodes[1], 'OUT'], ['OUT', '0']], 'ポットのワイパーは OUT');
  assert.strictEqual(pa.value + pb.value, 1e5);
  assert.strictEqual(elOf(r.net, 'VIN').nodes[0], 'IN');

  // プラス接地: GND が電池の＋側にあれば −側は −9V のまま
  r = await conv(model([v('bat', 'miscellaneous.batteryStack', 0, 0, 60, 30, '9V'), v('g', 'signal_sources.protective_earth', 45, 40, 30, 20),
    w('w1', 'bat', 'g', { style: 'exitX=1;exitY=0.5;entryX=0.5;entryY=0' }), v('r', 'resistors.resistor_2', 0, 60, 60, 20, '10k'),
    w('w2', 'bat', 'r', { style: 'exitX=0;exitY=0.5;entryX=0;entryY=0.5' }), w('w3', 'r', 'g', { style: 'exitX=1;exitY=0.5' })]));
  assert.deepStrictEqual(elOf(r.net, 'V1').nodes, ['0', 'VEE']);
  assert(!r.warnings.some(x => x.includes('GND とみなし')));

  // ユーザーの回路図（ZVEX Fuzz Factory）: 変換してバイアスが妥当か
  const fs = require('fs'), ff = 'ZVEX Fuzz Factory 回路図.drawio';
  if (fs.existsSync(ff)) {
    r = await conv(fs.readFileSync(ff, 'utf8'));
    const qs = r.net.elements.filter(e => e.type === 'Q');
    assert.strictEqual(qs.length, 3); assert.strictEqual(r.net.elements.filter(e => /^RPOT_.*_A$/.test(e.name)).length, 5);
    const s = Sim.prepare(r.net, { input: 'VIN', output: 'OUT', rate: RATE }), dc = s.dc;
    for (const q of qs) {
      const vbe = dc(q.nodes[1]) - dc(q.nodes[2]);
      if (q.model === '2N3904') assert(vbe > 0.4 && vbe < 0.8, `${q.name} Vbe ${vbe}`);
      else assert(-vbe > 0.05 && -vbe < 0.5, `${q.name} Veb ${-vbe}`);
    }
    const istab = (dc('VCC') - dc(elOf(r.net, 'RPOT_STABILITY_B').nodes[1])) / elOf(r.net, 'RPOT_STABILITY_B').value;
    assert(istab > 1e-4, `電源電流 ${istab}`);
  }
  console.log('drawio OK');
})().catch(e => { console.error(e); process.exit(1); });
