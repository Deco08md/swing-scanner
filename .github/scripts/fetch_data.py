import requests
import json
import os
import time
from datetime import datetime

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
}

TICKERS = [
    # Mega-cap tech
    'NVDA','AMZN','GOOGL','META','MSFT','AAPL','TSLA',
    # Semiconductors
    'AMD','MU','INTC','QCOM','MRVL','AVGO','ASML','AMAT','KLAC','LRCX','TXN','ADI','ON',
    # Software / cloud / cyber
    'CRM','ADBE','NOW','NET','PLTR','CRWD','DDOG','SNOW','ZS','PANW','OKTA','TEAM','HUBS','TTD','MDB',
    # Consumer tech / fintech
    'UBER','ABNB','SHOP','PYPL','COIN','SOFI','LYFT','RBLX','SNAP','PINS',
    # Media / telecom
    'NFLX','DIS','SPOT','TMUS',
    # Growth / consumer
    'ARM','ISRG','BKNG','LULU','ONON','NKE',
    # ETFs
    'SPY','QQQ','IWM','XLK','XLF','XLE','XLV','XLI','GLD','IBIT',
    # Finance
    'JPM','BAC','GS','WFC','MS','BLK','AXP','V','MA','COF','SPGI','MCO','SCHW','C','USB','PNC','BK','ICE','CME','CB',
    # Healthcare
    'LLY','UNH','ABBV','MRK','JNJ','ABT','DHR','BMY','GILD','REGN','VRTX','ELV','CI','HCA','TMO','SYK','BSX','MDT','AMGN',
    # Energy
    'XOM','CVX','COP','EOG','SLB','PSX','MPC','VLO','OXY','HAL','KMI','WMB','DVN','FANG',
    # Industrials
    'CAT','DE','HON','RTX','LMT','GE','UNP','FDX','UPS','CSX','BA','ETN','EMR','PH','ITW','ROK','IR',
    # Retail / consumer staples
    'COST','WMT','TGT','SBUX','MCD','CMG','KO','PG',
    # LatAm
    'MELI','CPA','TIGO',
]

# Short timeouts: (connect_seconds, read_seconds)
TIMEOUT = (5, 8)


def fetch_yahoo(ticker, session):
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?interval=1d&range=15mo"
    try:
        resp = session.get(url, timeout=TIMEOUT)
        if resp.status_code != 200:
            return None
        data = resp.json()
        result = (data.get('chart', {}).get('result') or [None])[0]
        if not result:
            return None
        quote = (result.get('indicators', {}).get('quote') or [{}])[0]
        ts = result.get('timestamp', [])
        raw_closes = quote.get('close', [])
        raw_highs = quote.get('high', [])
        raw_lows = quote.get('low', [])
        raw_volumes = quote.get('volume', [])

        valid = []
        for c, h, lo, v, t in zip(raw_closes, raw_highs, raw_lows, raw_volumes, ts):
            if c and c > 0:
                valid.append((
                    round(c, 4),
                    round(h or c, 4),
                    round(lo or c, 4),
                    int(v or 0),
                    t
                ))

        if len(valid) < 52:
            return None
        valid = valid[-260:]

        return {
            'closes': [x[0] for x in valid],
            'highs':  [x[1] for x in valid],
            'lows':   [x[2] for x in valid],
            'volumes':[x[3] for x in valid],
            'dates':  [datetime.utcfromtimestamp(x[4]).strftime('%Y-%m-%d') for x in valid],
        }
    except Exception:
        return None


def fetch_stooq(ticker, session):
    st = f"{ticker}.US" if '.' not in ticker else ticker
    url = f"https://stooq.com/q/d/l/?s={st.lower()}&i=d"
    try:
        resp = session.get(url, timeout=TIMEOUT)
        if resp.status_code != 200:
            return None
        text = resp.text.strip()
        if not text or 'No data' in text or len(text) < 100:
            return None
        lines = [l for l in text.split('\n') if l and not l.startswith('Date')]
        if len(lines) < 52:
            return None
        recent = lines[-260:]
        closes, highs, lows, volumes, dates = [], [], [], [], []
        for line in recent:
            p = line.split(',')
            if len(p) < 6:
                continue
            try:
                c = float(p[4])
                h = float(p[2]) if p[2] else c
                lo = float(p[3]) if p[3] else c
                v = int(float(p[5])) if p[5] else 0
                if c <= 0:
                    continue
                closes.append(round(c, 4))
                highs.append(round(h, 4))
                lows.append(round(lo, 4))
                volumes.append(v)
                dates.append(p[0])
            except Exception:
                continue
        if len(closes) < 52:
            return None
        return {'closes': closes, 'highs': highs, 'lows': lows, 'volumes': volumes, 'dates': dates}
    except Exception:
        return None


os.makedirs('data', exist_ok=True)

session = requests.Session()
session.headers.update(HEADERS)

today = datetime.utcnow().strftime('%Y-%m-%d')
success = 0
failed = []

for ticker in TICKERS:
    # Yahoo first (faster and more reliable from server-side), Stooq as fallback
    data = fetch_yahoo(ticker, session)
    source = 'yahoo'
    if not data:
        data = fetch_stooq(ticker, session)
        source = 'stooq'

    if data:
        out = {'t': ticker, 'updated': today, 'src': source, **data}
        with open(f"data/{ticker}.json", 'w') as f:
            json.dump(out, f, separators=(',', ':'))
        print(f"  {ticker} ({len(data['closes'])} bars, {source})")
        success += 1
    else:
        print(f"✗ {ticker} FAILED")
        failed.append(ticker)

    time.sleep(0.3)

print(f"\n{success}/{len(TICKERS)} ok", end='')
if failed:
    print(f"  |  failed: {', '.join(failed)}")
else:
    print()
