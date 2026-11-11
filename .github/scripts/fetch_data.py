import json
import os
import time
from datetime import datetime, timezone

import yfinance as yf

from tickers import TICKERS

REFERENCE = 'SPY'
RETRIES = 3

os.makedirs('data', exist_ok=True)
now_utc = datetime.now(timezone.utc)
run_at = now_utc.strftime('%Y-%m-%dT%H:%M:%SZ')


def to_payload(ticker, df):
    df = df.dropna(subset=['Close'])
    df = df[df['Close'] > 0]
    if len(df) < 52:
        raise ValueError(f"only {len(df)} bars")
    df = df.tail(260)
    return {
        't': ticker,
        'updated': run_at,
        'src': 'yahoo',
        # Split-adjusted only (no dividend adjustment) so RSI/ATR match IBKR and live quotes
        'adjusted': 'splits',
        'closes':  [round(float(x), 4) for x in df['Close']],
        'highs':   [round(float(x), 4) for x in df['High']],
        'lows':    [round(float(x), 4) for x in df['Low']],
        'volumes': [int(x) for x in df['Volume'].fillna(0)],
        'dates':   [d.strftime('%Y-%m-%d') for d in df.index],
    }


def download_single(ticker):
    df = yf.Ticker(ticker).history(period='15mo', interval='1d', auto_adjust=False, actions=False)
    if df.index.tz is not None:
        df.index = df.index.tz_localize(None)
    return to_payload(ticker, df)


def existing_last_date(ticker):
    try:
        with open(f"data/{ticker}.json") as f:
            return json.load(f)['dates'][-1]
    except Exception:
        return None


print(f"Descargando {len(TICKERS)} tickers con yfinance (batch, sin ajuste por dividendos)...")
raw = yf.download(
    tickers=' '.join(TICKERS),
    period='15mo',
    interval='1d',
    auto_adjust=False,
    actions=False,
    group_by='ticker',
    threads=True,
    progress=False,
)

payloads = {}
for ticker in TICKERS:
    try:
        payloads[ticker] = to_payload(ticker, raw[ticker])
    except Exception as e:
        print(f"  batch ✗ {ticker}: {e}")

# The batch call returns some tickers one session behind (2026-11-10 run: ~40 of 146 stopped at 11-09).
last_dates = [p['dates'][-1] for p in payloads.values()]
ref_date = payloads[REFERENCE]['dates'][-1] if REFERENCE in payloads else (max(last_dates) if last_dates else None)
print(f"Fecha de referencia ({REFERENCE}): {ref_date}")

laggards = [t for t in TICKERS if t not in payloads or (ref_date and payloads[t]['dates'][-1] < ref_date)]
print(f"{len(laggards)} tickers atrasados o fallidos en el batch: {', '.join(laggards) or '—'}")

for attempt in range(1, RETRIES + 1):
    if not laggards:
        break
    still = []
    for ticker in laggards:
        try:
            p = download_single(ticker)
            if ticker not in payloads or p['dates'][-1] > payloads[ticker]['dates'][-1]:
                payloads[ticker] = p
            if ref_date is None or p['dates'][-1] >= ref_date:
                print(f"  retry {attempt} ✓ {ticker} last={p['dates'][-1]}")
                continue
            print(f"  retry {attempt} … {ticker} last={p['dates'][-1]} (ref {ref_date})")
        except Exception as e:
            print(f"  retry {attempt} ✗ {ticker}: {e}")
        still.append(ticker)
    laggards = still
    if laggards:
        time.sleep(5 * attempt)

written, kept_older, failed, stale = 0, [], [], []
last_by_ticker = {}
for ticker in TICKERS:
    p = payloads.get(ticker)
    prev = existing_last_date(ticker)
    if p is None:
        failed.append(ticker)
        if prev:
            last_by_ticker[ticker] = prev
        print(f"✗ {ticker}: sin datos (se conserva archivo anterior: {prev or 'ninguno'})")
        continue
    new_last = p['dates'][-1]
    if prev and prev > new_last:
        kept_older.append(ticker)
        last_by_ticker[ticker] = prev
        print(f"  {ticker}: descarga ({new_last}) más vieja que el archivo ({prev}) — se conserva el archivo")
        continue
    with open(f"data/{ticker}.json", 'w') as f:
        json.dump(p, f, separators=(',', ':'))
    written += 1
    last_by_ticker[ticker] = new_last

for ticker, last in last_by_ticker.items():
    if ref_date and last < ref_date:
        stale.append({'t': ticker, 'last_date': last})

print(f"\n{written} escritos, {len(kept_older)} conservados, {len(failed)} fallidos, "
      f"{len(stale)} atrasados vs {ref_date}")
for s in stale:
    print(f"  ⚠ STALE {s['t']}: last={s['last_date']} (ref {ref_date})")

manifest = {
    'run_at': run_at,
    'ref_date': ref_date,
    'reference': REFERENCE,
    'tickers_total': len(TICKERS),
    'tickers_written': written,
    'tickers_failed': failed,
    'stale_tickers': stale,
    'last_dates': last_by_ticker,
    'adjusted': 'splits',
}
with open('data/manifest.json', 'w') as f:
    json.dump(manifest, f, separators=(',', ':'))
