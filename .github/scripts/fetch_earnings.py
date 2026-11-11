"""Best-effort earnings calendar from Yahoo. Manual earnings.json always overrides these values."""
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import yfinance as yf

sys.path.insert(0, os.path.dirname(__file__))
from tickers import TICKERS  # noqa: E402

ETFS = {'SPY', 'QQQ', 'IWM', 'XLK', 'XLF', 'XLE', 'XLV', 'XLI', 'GLD', 'IBIT'}
OUT = 'data/earnings_auto.json'
today = datetime.now(ZoneInfo('America/New_York')).date().isoformat()


def fetch(ticker):
    try:
        df = yf.Ticker(ticker).get_earnings_dates(limit=12)
        if df is None or df.empty:
            return ticker, None
        dts = sorted(df.index.tz_convert('America/New_York').to_pydatetime())
        past = [d for d in dts if d.date().isoformat() < today]
        future = [d for d in dts if d.date().isoformat() >= today]
        rec = {}
        if future:
            n = future[0]
            rec['next'] = n.date().isoformat()
            rec['nextTime'] = 'bmo' if n.hour < 12 else ('amc' if n.hour >= 16 else 'unk')
        if past:
            rec['last'] = past[-1].date().isoformat()
        return ticker, rec or None
    except Exception as e:
        print(f"  ✗ {ticker}: {e}")
        return ticker, None


def recent_enough(hours=20):
    try:
        with open(OUT) as f:
            prev = json.load(f).get('_updated')
        age = datetime.now(timezone.utc) - datetime.strptime(prev, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)
        return age.total_seconds() < hours * 3600
    except Exception:
        return False


def main():
    if recent_enough() and '--force' not in sys.argv:
        print("earnings_auto.json tiene < 20 h — no se vuelve a consultar")
        return
    out = {'_updated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), '_src': 'yahoo'}
    with ThreadPoolExecutor(max_workers=4) as ex:
        for ticker, rec in ex.map(fetch, [t for t in TICKERS if t not in ETFS]):
            if rec:
                out[ticker] = rec
            time.sleep(0.1)
    n = len(out) - 2
    print(f"earnings: {n} tickers con fecha")
    if n == 0:
        print("sin datos — no se sobrescribe el archivo")
        return
    with open(OUT, 'w') as f:
        json.dump(out, f, separators=(',', ':'), sort_keys=True)


if __name__ == '__main__':
    main()
