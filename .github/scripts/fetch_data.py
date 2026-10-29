import yfinance as yf
import json
import os
from datetime import datetime, timedelta

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
now_utc = datetime.utcnow()
today = now_utc.strftime('%Y-%m-%d')

# Most recent expected trading day: today if after 22:00 UTC (market close + buffer), else yesterday
expected_trading_day = today if now_utc.hour >= 22 else (now_utc - timedelta(days=1)).strftime('%Y-%m-%d')

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
data_dates = {}  # {ticker: last_bar_date}

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

        last_date = out['dates'][-1]
        data_dates[ticker] = last_date

        # Warn if last bar is stale (more than 5 calendar days before expected)
        days_diff = (datetime.strptime(expected_trading_day, '%Y-%m-%d') - datetime.strptime(last_date, '%Y-%m-%d')).days
        stale_flag = ' ⚠ STALE' if days_diff > 5 else ''

        with open(f"data/{ticker}.json", 'w') as f:
            json.dump(out, f, separators=(',', ':'))

        print(f"  {ticker} ({len(out['closes'])} bars, last={last_date}){stale_flag}")
        success += 1

    except Exception as e:
        print(f"✗ {ticker}: {e}")
        failed.append(ticker)

print(f"\n{success}/{len(TICKERS)} ok", end='')
if failed:
    print(f"  |  failed: {', '.join(failed)}")
else:
    print()

# Identify stale tickers (last bar older than expected by more than 1 business day)
stale = []
for t, d in data_dates.items():
    try:
        delta = (datetime.strptime(expected_trading_day, '%Y-%m-%d') - datetime.strptime(d, '%Y-%m-%d')).days
        if delta > 3:  # > 3 calendar days is suspicious
            stale.append({'t': t, 'last_date': d, 'days': delta})
    except:
        pass

if stale:
    print(f"\n⚠ {len(stale)} tickers with stale data:")
    for s in stale:
        print(f"  {s['t']}: last={s['last_date']} ({s['days']} days behind {expected_trading_day})")

# Write manifest so scanner can display freshness info
manifest = {
    'run_date': today,
    'run_time': now_utc.strftime('%H:%M:%S'),
    'expected_trading_day': expected_trading_day,
    'tickers_ok': success,
    'tickers_failed': failed,
    'stale_tickers': stale,
}
with open('data/manifest.json', 'w') as f:
    json.dump(manifest, f, separators=(',', ':'))
print(f"Manifest: {len(stale)} stale, {len(failed)} failed")
