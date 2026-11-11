// Pure scanner logic shared by index.html (browser) and tests/ (node). No DOM, no network.
(function (root) {
  'use strict';

  const DEFAULT_PARAMS = {
    earningsDays: 7,          // EARNINGS_BLOCK if next report within N calendar days
    postEarningsSessions: 3,  // POST_EARNINGS_GAP window after a report
    postEarningsGapPct: 5,    // move that invalidates pre-report indicators
    maxRiskPct: 10,           // RISK_WIDE: (price - stop) / price
    minStopAtr: 1,            // STOP_TOO_CLOSE: (price - stop) / ATR
    maxExtPct: 10,            // EXTENDED: price over EMA20
    rsiLo: 55, rsiHi: 70,     // RSI_OUT band
    minRR: 1.5,               // RR_LOW
    hideStaleSessions: 2,     // rows this many sessions behind are hidden by default
    scoreCap: 64,             // P7: flagged rows can't reach 'high' strength (>= 65)
    rsiScoreCap: 75,
  };

  // NYSE full-day closures
  const MARKET_HOLIDAYS = new Set([
    '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19',
    '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
    '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18',
    '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
  ]);

  const ETFS = new Set(['SPY', 'QQQ', 'IWM', 'XLK', 'XLF', 'XLE', 'XLV', 'XLI', 'GLD', 'IBIT']);

  function isoAddDays(iso, n) {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  function isSession(iso) {
    const dow = new Date(iso + 'T00:00:00Z').getUTCDay();
    return dow !== 0 && dow !== 6 && !MARKET_HOLIDAYS.has(iso);
  }

  // Trading sessions s with from < s <= to. sessionsBetween('2026-11-09','2026-11-11') === 2
  function sessionsBetween(from, to) {
    if (!from || !to || to <= from) return 0;
    let n = 0, d = from;
    while (d < to) { d = isoAddDays(d, 1); if (isSession(d)) n++; }
    return n;
  }

  // Calendar days from `today` to `target` (negative = past)
  function daysTo(target, today) {
    return Math.round((Date.parse(target + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
  }

  function nyParts(now) {
    const parts = {};
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now).forEach(p => { parts[p.type] = p.value; });
    return { iso: `${parts.year}-${parts.month}-${parts.day}`, mins: (+parts.hour) * 60 + (+parts.minute) };
  }

  function nyDate(now = new Date()) { return nyParts(now).iso; }

  // Most recent session whose daily bar is complete (regular close 16:00 ET)
  function lastCompletedSession(now = new Date()) {
    const { iso, mins } = nyParts(now);
    let d = iso;
    if (isSession(d) && mins >= 16 * 60) return d;
    do { d = isoAddDays(d, -1); } while (!isSession(d));
    return d;
  }

  // R/R to the recent high. null = price <= stop (broken), 0 = at/above the high
  function realRR(price, stop, recentHigh) {
    const risk = price - stop;
    if (!(risk > 0)) return null;
    const reward = recentHigh - price;
    return reward <= 0 ? 0 : reward / risk;
  }

  // ── Indicators ──────────────────────────────────────────────────
  function calcEMA(closes, period) {
    if (closes.length < period) return null;
    const k = 2 / (period + 1);
    let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
    return Math.round(ema * 100) / 100;
  }

  // Wilder's smoothed RSI (IBKR / TradingView). Needs ~100+ bars to converge.
  function calcRSI(closes, period = 14) {
    if (closes.length < period + 2) return 50;
    let ag = 0, al = 0;
    for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) ag += d; else al -= d; }
    ag /= period; al /= period;
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
      al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
    }
    if (al === 0) return 100;
    return Math.round((100 - 100 / (1 + ag / al)) * 10) / 10;
  }

  // ATR = simple mean of the last `period` true ranges
  function calcATR(highs, lows, closes, period = 14) {
    if (closes.length < period + 1) return null;
    const trs = [];
    for (let i = 1; i < closes.length; i++) {
      const h = highs[i] || closes[i] * 1.01, l = lows[i] || closes[i] * 0.99, pc = closes[i - 1];
      trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    return Math.round(trs.slice(-period).reduce((a, b) => a + b, 0) / period * 100) / 100;
  }

  // Volume of the last complete bar / mean of the 20 sessions before it.
  // lastIsComplete=false when the series ends with a partial (live) bar.
  function volumeRatio(volumes, lastIsComplete = true) {
    const lc = volumes.length - (lastIsComplete ? 1 : 2);
    const base = volumes.slice(Math.max(0, lc - 20), lc);
    if (lc < 1 || base.length === 0) return 1;
    const avg = base.reduce((a, b) => a + b, 0) / base.length;
    return avg > 0 ? Math.round(volumes[lc] / avg * 100) / 100 : 1;
  }

  // ── Flags ───────────────────────────────────────────────────────
  // row: { price (scanner), live|null, barDate, asOf, today, atr, stopScanner, hi20, ema20, ema50, rsi,
  //        earnNext, earnLast, earnGapInData, volRatio, lastBarChgPct, isEtf, holding }
  // level: 'block' (own section), 'hide' (hidden by default), 'warn', 'info'
  function computeFlags(row, params) {
    const P = Object.assign({}, DEFAULT_PARAMS, params || {});
    const flags = [];
    const add = (code, level, msg) => flags.push({ code, level, msg });
    const hasLive = row.live != null && row.live > 0;
    const cur = hasLive ? row.live : row.price;
    const r2 = x => Math.round(x * 100) / 100;

    const sessionsBehind = row.barDate && row.asOf ? sessionsBetween(row.barDate, row.asOf) : 0;
    const chgVsScanner = hasLive ? (row.live / row.price - 1) * 100 : null;
    const stopLive = row.atr ? cur - 2 * row.atr : null;
    const rrLive = stopLive != null && row.hi20 != null ? realRR(cur, stopLive, row.hi20) : null;
    const rrScanner = row.stopScanner != null && row.hi20 != null ? realRR(cur, row.stopScanner, row.hi20) : null;
    const stopAtr = row.atr && row.stopScanner != null ? (cur - row.stopScanner) / row.atr : null;
    const riskPct = row.stopScanner != null ? (cur - row.stopScanner) / cur * 100 : null;
    const extPct = row.ema20 ? (cur / row.ema20 - 1) * 100 : null;

    // P0 freshness
    if (sessionsBehind >= 1) {
      add('STALE', sessionsBehind >= P.hideStaleSessions ? 'hide' : 'warn',
        `Barras al cierre ${row.barDate}: ${sessionsBehind} sesión${sessionsBehind > 1 ? 'es' : ''} de atraso vs ${row.asOf}`);
    }
    if (hasLive && row.stopScanner != null && row.live <= row.stopScanner) {
      add('STOP_BROKEN', 'block', `Precio vivo $${r2(row.live)} ≤ stop del scanner $${r2(row.stopScanner)}`);
    }

    // P1 earnings
    if (row.earnNext) {
      const d = daysTo(row.earnNext, row.today);
      if (d >= 0 && d <= P.earningsDays) add('EARNINGS_BLOCK', 'block', `Earnings ${row.earnNext} (${d === 0 ? 'hoy' : `en ${d} d`})`);
    }
    if (row.earnLast && row.earnLast <= row.today && sessionsBetween(row.earnLast, row.asOf) <= P.postEarningsSessions) {
      const reactionNotInData = row.barDate && row.barDate <= row.earnLast;
      const bigLive = chgVsScanner != null && Math.abs(chgVsScanner) > P.postEarningsGapPct;
      const bigInData = row.earnGapInData != null && Math.abs(row.earnGapInData) > P.postEarningsGapPct;
      if (reactionNotInData || bigLive || bigInData) {
        const why = reactionNotInData ? 'barras previas a la reacción' :
          bigLive ? `precio vivo ${chgVsScanner > 0 ? '+' : ''}${r2(chgVsScanner)}% vs scanner` :
            `movimiento ${row.earnGapInData > 0 ? '+' : ''}${r2(row.earnGapInData)}% desde el reporte`;
        add('POST_EARNINGS_GAP', 'warn', `Reportó ${row.earnLast} — ${why}; indicadores no confiables`);
      }
    }
    const recentLast = row.earnLast && daysTo(row.earnLast, row.today) >= -60;
    if (!row.isEtf && !row.earnNext && !recentLast) add('NO_EARNINGS_DATA', 'warn', 'Earnings: sin dato (verificar fecha)');

    // P2 risk / reward
    if (rrLive == null || rrLive < P.minRR) add('RR_LOW', 'warn', `R/R real ${rrLive == null ? '—' : r2(rrLive)} (stop 2×ATR al precio actual, máx 20d $${row.hi20})`);
    if (hasLive && stopAtr != null && stopAtr > 0 && stopAtr < P.minStopAtr) add('STOP_TOO_CLOSE', 'warn', `Stop del scanner a ${r2(stopAtr)} ATR del precio vivo`);
    if (riskPct != null && riskPct > P.maxRiskPct) add('RISK_WIDE', 'warn', `Stop a ${r2(riskPct)}% del precio`);

    // P3 structure
    if (row.ema20 && row.ema50 && row.ema20 <= row.ema50) add('STACK_INV', 'warn', `EMA20 ${row.ema20} ≤ EMA50 ${row.ema50}`);
    if (row.ema20 && cur <= row.ema20) add('BELOW_EMA20', 'warn', `Precio ≤ EMA20 ${row.ema20}`);
    if (row.rsi != null && (row.rsi < P.rsiLo || row.rsi > P.rsiHi)) add('RSI_OUT', 'warn', `RSI ${row.rsi} fuera de ${P.rsiLo}–${P.rsiHi}`);
    if (extPct != null && extPct > P.maxExtPct) add('EXTENDED', 'warn', `+${r2(extPct)}% sobre EMA20 (anti-chasing)`);

    // P4 volume info
    if (row.volRatio != null && row.volRatio >= 1.5 && row.lastBarChgPct != null && row.lastBarChgPct < -2) {
      add('VOL_DOWN_DAY', 'info', `Volumen ${row.volRatio}x en día de ${r2(row.lastBarChgPct)}% (posible distribución)`);
    }

    // P5 portfolio
    if (row.holding) {
      const lbl = { position: 'Ya en cartera', order: 'Orden pendiente', excluded: 'Excluido' }[row.holding.type] || 'En cartera';
      add('HOLDING', 'block', `${lbl}${row.holding.note ? ' — ' + row.holding.note : ''}`);
    }

    return { flags, sessionsBehind, chgVsScanner, stopLive, rrLive, rrScanner, stopAtr, riskPct, extPct, cur };
  }

  const has = (flags, code) => flags.some(f => f.code === code);
  const isClean = flags => !flags.some(f => f.level !== 'info');

  // P7: flagged rows cannot carry a top score
  function capScore(score, rsi, flags, params) {
    const P = Object.assign({}, DEFAULT_PARAMS, params || {});
    if (rsi >= P.rsiScoreCap || has(flags, 'STALE') || has(flags, 'POST_EARNINGS_GAP')) return Math.min(score, P.scoreCap);
    return score;
  }

  // Merge auto (pipeline) and manual earnings; manual wins per field.
  // Manual value may be "YYYY-MM-DD" (future = next, past = last) or {next,last,nextTime}.
  function mergeEarnings(auto, manual, today) {
    const out = {};
    const put = (t, rec, src) => {
      if (!rec || t.startsWith('_')) return;
      if (typeof rec === 'string') rec = rec >= today ? { next: rec } : { last: rec };
      const cur = out[t] || {};
      ['next', 'last', 'nextTime'].forEach(k => { if (rec[k]) { cur[k] = rec[k]; cur.src = src; } });
      out[t] = cur;
    };
    Object.entries(auto || {}).forEach(([t, r]) => put(t, r, 'auto'));
    Object.entries(manual || {}).forEach(([t, r]) => put(t, r, 'manual'));
    // A stale "next" that already passed becomes "last"
    Object.values(out).forEach(r => { if (r.next && r.next < today) { if (!r.last || r.last < r.next) r.last = r.next; delete r.next; } });
    return out;
  }

  function holdingsMap(pf) {
    const m = {};
    if (!pf) return m;
    (pf.positions || []).forEach(p => { m[p.t] = { type: 'position', note: p.note || '' }; });
    (pf.orders || []).forEach(o => { if (!m[o.t]) m[o.t] = { type: 'order', note: [o.limit ? `límite $${o.limit}` : '', o.note || ''].filter(Boolean).join(' · ') }; });
    (pf.exclusions || []).forEach(x => { m[x.t] = { type: 'excluded', note: x.note || '' }; });
    return m;
  }

  const api = {
    DEFAULT_PARAMS, MARKET_HOLIDAYS, ETFS, isoAddDays, isSession, sessionsBetween, daysTo, nyDate,
    lastCompletedSession, realRR, calcEMA, calcRSI, calcATR, volumeRatio, computeFlags, has, isClean,
    capScore, mergeEarnings, holdingsMap,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ScannerCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
