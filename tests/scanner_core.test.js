// node tests/scanner_core.test.js — no dependencies
const assert = require('assert');
const C = require('../scanner-core.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n    ', e.message); process.exitCode = 1; }
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} vs ${b} (tol ${tol})`);
const codes = r => C.computeFlags(r).flags.filter(f => f.level !== 'info').map(f => f.code).sort();

console.log('sessionsBetween / daysTo / lastCompletedSession');
test('sessionsBetween casos del brief', () => {
  assert.strictEqual(C.sessionsBetween('2026-11-09', '2026-11-11'), 2);
  assert.strictEqual(C.sessionsBetween('2026-11-10', '2026-11-11'), 1);
  assert.strictEqual(C.sessionsBetween('2026-11-11', '2026-11-11'), 0);
  assert.strictEqual(C.sessionsBetween('2026-11-06', '2026-11-09'), 1); // fin de semana
});
test('sessionsBetween salta feriados (Thanksgiving 2026-11-26)', () => {
  assert.strictEqual(C.sessionsBetween('2026-11-25', '2026-11-27'), 1);
  assert.strictEqual(C.sessionsBetween('2026-11-11', '2026-11-09'), 0);
});
test('daysTo casos del brief 2-nov', () => {
  assert.strictEqual(C.daysTo('2026-11-05', '2026-11-02'), 3);
  assert.strictEqual(C.daysTo('2026-11-09', '2026-11-02'), 7);
  assert.strictEqual(C.daysTo('2026-11-02', '2026-11-02'), 0);
});
test('lastCompletedSession usa el cierre de 16:00 ET', () => {
  assert.strictEqual(C.lastCompletedSession(new Date('2026-11-11T22:00:00Z')), '2026-11-11'); // 17:00 ET
  assert.strictEqual(C.lastCompletedSession(new Date('2026-11-11T15:00:00Z')), '2026-11-10'); // 10:00 ET
  assert.strictEqual(C.lastCompletedSession(new Date('2026-11-14T15:00:00Z')), '2026-11-13'); // sábado
  assert.strictEqual(C.lastCompletedSession(new Date('2026-11-27T15:00:00Z')), '2026-11-25'); // tras Thanksgiving
});

console.log('realRR');
test('bordes del brief', () => {
  assert.strictEqual(C.realRR(100, 95, 99), 0);
  assert.strictEqual(C.realRR(100, 101, 120), null);
  assert.strictEqual(C.realRR(100, 100, 120), null);
  near(C.realRR(100, 95, 110), 2, 1e-9);
});

// 11-nov: precio scanner, vivo y sesiones vienen de la tabla §1 del brief. ATR, stop del scanner y
// máx 20d se derivan de las cifras del brief (riesgo %, stop en ATR, R/R real). Valores marcados
// "neutral" no están en el brief y se eligen para no disparar banderas que el brief no reporta.
const base = { asOf: '2026-11-11', today: '2026-11-11' };
const NOV11 = {
  TTD: { ...base, price: 14.93, live: 15.99, barDate: '2026-11-09', atr: 0.701, stopScanner: 13.528, hi20: 16.10 /* neutral */,
    ema20: 13.47, ema50: 13.52, rsi: 73.4, earnLast: '2026-11-09' },
  ABNB: { ...base, price: 190.29, live: 181.13, barDate: '2026-11-09', atr: 6.735, stopScanner: 176.82, hi20: 196.35,
    ema20: 178, ema50: 174, rsi: 58 /* neutral */, earnLast: '2026-11-05' },
  ONON: { ...base, price: 37.53, live: 34.72, barDate: '2026-11-09', atr: 1.544, stopScanner: 34.442, hi20: 38.60 /* neutral */,
    ema20: 35.60, ema50: 35.20 /* neutral */, rsi: 51.3, earnLast: '2026-11-10' },
  ABBV: { ...base, price: 293.30, live: 294.92, barDate: '2026-11-09', atr: 7.239, stopScanner: 278.82, hi20: 302.88,
    ema20: 289, ema50: 282, rsi: 60 /* neutral */, earnLast: '2026-10-30' },
  CPA: { ...base, price: 148.22, live: 149.11, barDate: '2026-11-10', atr: 5.818, stopScanner: 136.58, hi20: 151.90,
    ema20: 139.10, ema50: 133, rsi: 62 /* neutral */, earnNext: '2026-11-18' },
};
const EXPECTED = {
  TTD: ['STALE', 'RISK_WIDE', 'POST_EARNINGS_GAP', 'STACK_INV', 'RSI_OUT', 'EXTENDED', 'RR_LOW'],
  ABNB: ['STALE', 'STOP_TOO_CLOSE', 'RR_LOW'],
  ONON: ['STALE', 'STOP_TOO_CLOSE', 'POST_EARNINGS_GAP', 'BELOW_EMA20', 'RSI_OUT', 'RR_LOW'],
  ABBV: ['STALE', 'RR_LOW'],
  CPA: ['STALE', 'EARNINGS_BLOCK', 'RR_LOW'],
};

console.log('flags 11-nov (5 tickers)');
for (const t of Object.keys(NOV11)) {
  test(`${t} = ${EXPECTED[t].join(', ')}`, () => assert.deepStrictEqual(codes(NOV11[t]), [...EXPECTED[t]].sort()));
}
test('cambio vs scanner (TTD +7.1, ABNB −4.8, ONON −7.5)', () => {
  near(C.computeFlags(NOV11.TTD).chgVsScanner, 7.1, 0.05);
  near(C.computeFlags(NOV11.ABNB).chgVsScanner, -4.81, 0.05);
  near(C.computeFlags(NOV11.ONON).chgVsScanner, -7.49, 0.05);
});
test('R/R real: ABNB 1.13 con stop recalculado vs 3.5 con stop del scanner; ABBV 0.55; CPA 0.24', () => {
  const a = C.computeFlags(NOV11.ABNB);
  near(a.rrLive, 1.13, 0.012); near(a.rrScanner, 3.53, 0.012);
  near(C.computeFlags(NOV11.ABBV).rrLive, 0.55, 0.012);
  near(C.computeFlags(NOV11.CPA).rrLive, 0.24, 0.012);
});
test('stop en ATR: ABNB 0.64, ONON 0.18; riesgo TTD 15.4%', () => {
  near(C.computeFlags(NOV11.ABNB).stopAtr, 0.64, 0.01);
  near(C.computeFlags(NOV11.ONON).stopAtr, 0.18, 0.01);
  near(C.computeFlags(NOV11.TTD).riskPct, 15.4, 0.05);
});
test('ninguna de las 5 queda limpia', () => {
  for (const t of Object.keys(NOV11)) assert.ok(!C.isClean(C.computeFlags(NOV11[t]).flags), t);
});
test('STALE ≥ 2 sesiones se oculta por defecto; 1 sesión solo avisa', () => {
  assert.strictEqual(C.computeFlags(NOV11.TTD).flags.find(f => f.code === 'STALE').level, 'hide');
  assert.strictEqual(C.computeFlags(NOV11.CPA).flags.find(f => f.code === 'STALE').level, 'warn');
});
test('parámetros: con minRR=1.0 ABNB deja de ser RR_LOW', () => {
  const f = C.computeFlags(NOV11.ABNB, { minRR: 1.0 }).flags.map(x => x.code);
  assert.ok(!f.includes('RR_LOW'));
});
test('sin regla de frescura (asOf = barDate) desaparece STALE', () => {
  assert.ok(!codes({ ...NOV11.ABBV, asOf: '2026-11-09' }).includes('STALE'));
});

console.log('señal rota (2-nov)');
test('DVN y OXY = STOP_BROKEN; MA no', () => {
  const dvn = { asOf: '2026-10-30', today: '2026-11-02', barDate: '2026-10-30', price: 52.15, live: 48.90, stopScanner: 49.41, atr: 1.37, hi20: 54 };
  const oxy = { ...dvn, price: 64.00, live: 60.61, stopScanner: 61.00, atr: 1.5, hi20: 66 };
  const ma = { ...dvn, price: 638.01, live: 660.62, stopScanner: 614.49, atr: 11.76, hi20: 655 };
  assert.ok(codes(dvn).includes('STOP_BROKEN'));
  assert.ok(codes(oxy).includes('STOP_BROKEN'));
  assert.ok(!codes(ma).includes('STOP_BROKEN'));
  assert.strictEqual(C.computeFlags(dvn).rrLive !== undefined, true);
});

console.log('earnings / cartera / score / volumen');
test('sin fecha de earnings → NO_EARNINGS_DATA, nunca "ok"; ETF exento', () => {
  const r = { ...NOV11.ABBV, earnLast: null };
  assert.ok(codes(r).includes('NO_EARNINGS_DATA'));
  assert.ok(!codes({ ...r, isEtf: true }).includes('NO_EARNINGS_DATA'));
});
test('mergeEarnings: manual gana; fecha pasada en "next" pasa a "last"', () => {
  const m = C.mergeEarnings({ CPA: { next: '2026-11-20', last: '2026-08-10' }, NVDA: { next: '2026-11-19' } },
    { CPA: { next: '2026-11-18' }, NVDA: '2026-11-17', AAPL: '2026-10-30' }, '2026-11-11');
  assert.strictEqual(m.CPA.next, '2026-11-18'); assert.strictEqual(m.CPA.last, '2026-08-10');
  assert.strictEqual(m.NVDA.next, '2026-11-17'); assert.strictEqual(m.AAPL.last, '2026-10-30');
  assert.ok(!m.AAPL.next);
});
test('cartera: orden pendiente ABBV y exclusión COST → HOLDING (bloquea)', () => {
  const h = C.holdingsMap({ positions: [{ t: 'KO' }], orders: [{ t: 'ABBV', limit: 286.40 }], exclusions: [{ t: 'COST' }] });
  assert.strictEqual(h.ABBV.type, 'order'); assert.strictEqual(h.COST.type, 'excluded'); assert.strictEqual(h.KO.type, 'position');
  const f = C.computeFlags({ ...NOV11.ABBV, holding: h.ABBV }).flags.find(x => x.code === 'HOLDING');
  assert.strictEqual(f.level, 'block'); assert.ok(f.msg.includes('286.4'));
});
test('P7: RSI ≥ 75 o STALE no recibe score máximo', () => {
  assert.strictEqual(C.capScore(92, 79, []), 64);
  assert.strictEqual(C.capScore(92, 65, C.computeFlags(NOV11.ABBV).flags), 64);
  assert.strictEqual(C.capScore(80, 65, []), 80);
});
test('volumen = último día completo / media de las 20 sesiones previas', () => {
  const v = Array(20).fill(100).concat([250]);
  assert.strictEqual(C.volumeRatio(v, true), 2.5);
  assert.strictEqual(C.volumeRatio(v.concat([30]), false), 2.5); // barra parcial ignorada
});
test('VOL_DOWN_DAY: volumen alto en día bajista es info, no filtro', () => {
  const f = C.computeFlags({ ...NOV11.ABBV, volRatio: 2.84, lastBarChgPct: -3.1 }).flags.find(x => x.code === 'VOL_DOWN_DAY');
  assert.strictEqual(f.level, 'info');
});

console.log('RSI Wilder14 (P6)');
const pg = require('./fixtures/pg_ibkr_2026-11-11.json');
test('PG hasta el cierre 30-oct (IBKR, sin ajuste) = 62.7 — el valor del brief', () => {
  const i = pg.dates.indexOf('2026-10-30');
  near(C.calcRSI(pg.closes.slice(0, i + 1)), 62.7, 0.05);
});
test('PG con precios ajustados por dividendo (como el caché viejo) da ~64.4 → causa del desvío', () => {
  const i = pg.dates.indexOf('2026-10-30'), ex = pg.dates.indexOf('2026-10-23');
  const adj = pg.closes.slice(0, i + 1).map((x, n) => (n < ex ? x * (1 - 1.0885 / 165.59) : x));
  near(C.calcRSI(adj), 64.4, 0.1);
});
test('RSI de serie plana = 100; serie alcista en 50–80', () => {
  assert.strictEqual(C.calcRSI(Array(16).fill(100)), 100);
  const r = C.calcRSI([100, 102, 101, 103, 104, 102, 105, 107, 106, 108, 107, 109, 110, 108, 111, 112]);
  assert.ok(r >= 50 && r <= 80);
});

console.log(process.exitCode ? `\nFALLARON TESTS (${passed} ok)` : `\nTODOS LOS TESTS OK (${passed})`);
