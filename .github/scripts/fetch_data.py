import yfinance as yf
import json
import os
from datetime import datetime

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

os.makedirs('data', exist_ok=True)
today = datetime.utcnow().strftime('%Y-%m-%d')

print(f"Descargando {len(TICKERS)} tickers con yfinance...")

# Download all tickers in one batch request
raw = yf.download(
    tickers=' '.join(TICKERS),
    period='15mo',
    interval='1d',
    auto_adjust=True,
    group_by='ticker',
    threads=True,
    progress=False,
)

success = 0
failed = []

for ticker in TICKERS:
    try:
        if len(TICKERS) == 1:
            df = raw
        else:
            df = raw[ticker]

        df = df.dropna(subset=['Close'])
        df = df[df['Close'] > 0]

        if len(df) < 52:
            raise ValueError(f"only {len(df)} bars")

        df = df.tail(260)

        out = {
            't': ticker,
            'updated': today,
            'src': 'yahoo',
            'closes':  [round(float(x), 4) for x in df['Close']],
            'highs':   [round(float(x), 4) for x in df['High']],
            'lows':    [round(float(x), 4) for x in df['Low']],
            'volumes': [int(x) for x in df['Volume']],
            'dates':   [d.strftime('%Y-%m-%d') for d in df.index],
        }

        with open(f"data/{ticker}.json", 'w') as f:
            json.dump(out, f, separators=(',', ':'))

        print(f"  {ticker} ({len(out['closes'])} bars)")
        success += 1

    except Exception as e:
        print(f"✗ {ticker}: {e}")
        failed.append(ticker)

print(f"\n{success}/{len(TICKERS)} ok", end='')
if failed:
    print(f"  |  failed: {', '.join(failed)}")
else:
    print()
