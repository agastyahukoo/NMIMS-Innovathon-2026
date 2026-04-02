from flask import Flask, request, jsonify
from flask_cors import CORS
import requests
import os
import re
import sqlite3
import json
import time
import threading
import numpy as np
from dotenv import load_dotenv

PANDAS_AVAILABLE  = False
PROPHET_AVAILABLE = False
try:
    import warnings
    import pandas as pd
    PANDAS_AVAILABLE = True
    try:
        from prophet import Prophet
        PROPHET_AVAILABLE = True
    except Exception:
        pass
except ImportError:
    pass

ENV_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), '.env')
load_dotenv(ENV_PATH)

app = Flask(__name__)
CORS(app, origins=['http://localhost:5000', 'file://', 'null'])

BINANCE_BASE = 'https://api.binance.com/api/v3'
BINANCE_FAPI = 'https://fapi.binance.com/fapi/v1'
OLLAMA_BASE  = 'http://localhost:11434'
DB_PATH      = os.path.join(os.path.dirname(__file__), 'app.db')

ALLOWED_SYMBOLS   = {'BTC', 'ETH', 'SOL', 'BNB', 'XRP'}
ALLOWED_INTERVALS = {'1m','3m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d','3d','1w'}

COIN_TICKERS = {'BTC':'BTCUSDT','ETH':'ETHUSDT','SOL':'SOLUSDT','BNB':'BNBUSDT','XRP':'XRPUSDT'}

COIN_SUBREDDITS = {
    'BTC': ['Bitcoin','CryptoCurrency'],
    'ETH': ['ethereum','CryptoCurrency'],
    'SOL': ['solana','CryptoCurrency'],
    'BNB': ['binance','CryptoCurrency'],
    'XRP': ['XRP','CryptoCurrency'],
}

COIN_KEYWORDS = {
    'BTC': ['btc','bitcoin'], 'ETH': ['eth','ethereum'],
    'SOL': ['sol','solana'],  'BNB': ['bnb','binance coin'],
    'XRP': ['xrp','ripple'],
}

COIN_OWN_SUBS = {'BTC':'bitcoin','ETH':'ethereum','SOL':'solana','BNB':'binance','XRP':'xrp'}

INTERVAL_SECONDS = {
    '1m':60,'3m':180,'5m':300,'15m':900,'30m':1800,
    '1h':3600,'2h':7200,'4h':14400,'6h':21600,'8h':28800,'12h':43200,
    '1d':86400,'3d':259200,'1w':604800
}

_MODEL_RE        = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9._:\-]{0,99}$')
_prophet_cache   = {}
PROPHET_CACHE_TTL = 1800


def sanitize_str(val, max_len=500):
    return str(val).replace('\n','').replace('\r','').replace('\0','')[:max_len]

def valid_model(name): return bool(name and _MODEL_RE.match(name))
def valid_symbol(sym): return sym in ALLOWED_SYMBOLS
def valid_interval(iv): return iv in ALLOWED_INTERVALS

def clean_error(e):
    msg = str(e)
    if any(k in msg for k in ['NameResolutionError','Failed to resolve','nodename nor servname']):
        return 'No internet connection'
    if any(k in msg for k in ['Max retries exceeded','ConnectionError','ConnectionRefusedError','HTTPSConnectionPool','HTTPConnectionPool']):
        return 'Cannot reach server'
    if any(k in msg for k in ['Timeout','timed out']):
        return 'Request timed out'
    return 'Network error'


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()
    conn.executescript('''
        CREATE TABLE IF NOT EXISTS posts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol TEXT, subreddit TEXT, title TEXT, body TEXT,
            url TEXT, score INTEGER, created_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS sentiment (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol TEXT, model TEXT, label TEXT,
            score REAL, confidence REAL, summary TEXT, created_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS prices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol TEXT, interval TEXT, timestamp INTEGER,
            close REAL, volume REAL
        );
        CREATE TABLE IF NOT EXISTS predictions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol TEXT, interval TEXT, direction TEXT,
            confidence REAL, horizon TEXT, score REAL,
            features_json TEXT, created_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS signals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol TEXT, action TEXT, confidence REAL,
            evidence_json TEXT, direction_used TEXT,
            sentiment_used TEXT, created_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS backtest_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol TEXT, interval TEXT, horizon_candles INTEGER,
            confidence_threshold REAL, win_rate REAL, total_signals INTEGER,
            active_signals INTEGER, avg_return REAL, cumulative_return REAL,
            sharpe REAL, pnl_json TEXT, created_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS ml_evaluations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol TEXT, interval TEXT, horizon_candles INTEGER,
            train_candles INTEGER, test_candles INTEGER,
            directional_accuracy REAL, precision_score REAL,
            recall_score REAL, f1_score REAL,
            ml_sharpe REAL, bh_sharpe REAL, alpha REAL,
            technical_accuracy REAL, created_at INTEGER
        );
    ''')
    conn.commit()

    for col_sql in [
        'ALTER TABLE signals ADD COLUMN price_at_signal REAL',
        'ALTER TABLE signals ADD COLUMN price_at_eval REAL',
        'ALTER TABLE signals ADD COLUMN outcome TEXT',
        'ALTER TABLE signals ADD COLUMN interval TEXT',
        'ALTER TABLE signals ADD COLUMN source TEXT',
        'ALTER TABLE signals ADD COLUMN ml_direction TEXT',
        'ALTER TABLE signals ADD COLUMN ml_confidence REAL',
        'ALTER TABLE signals ADD COLUMN ml_agrees INTEGER',
    ]:
        try:
            conn.execute(col_sql)
            conn.commit()
        except Exception:
            pass

    conn.close()


init_db()


def _ema(arr, period):
    if len(arr) < 1:
        return 0.0
    k = 2.0 / (period + 1)
    val = float(arr[0])
    for v in arr[1:]:
        val = float(v) * k + val * (1 - k)
    return val


def _rsi(closes, period=14):
    if len(closes) < period + 1:
        return 50.0
    deltas = np.diff(np.array(closes[-(period+1):], dtype=float))
    gains  = np.where(deltas > 0, deltas, 0.0)
    losses = np.where(deltas < 0, -deltas, 0.0)
    ag, al = np.mean(gains), np.mean(losses)
    if al == 0:
        return 100.0
    return float(100.0 - 100.0 / (1.0 + ag / al))


def _bollinger(closes, period=20):
    data = np.array(closes[-period:], dtype=float) if len(closes) >= period else np.array(closes, dtype=float)
    mid  = float(np.mean(data))
    std  = float(np.std(data))
    return mid + 2*std, mid, mid - 2*std


def compute_technical_prediction(candles, horizon='1h'):
    if len(candles) < 30:
        return None
    closes  = [c['close'] for c in candles]
    volumes = [c['volume'] for c in candles]
    scores, features = [], []

    rsi = _rsi(closes)
    if rsi < 35:
        scores.append(1.0);  features.append(f'RSI {rsi:.0f} — oversold, bullish bias')
    elif rsi > 65:
        scores.append(-1.0); features.append(f'RSI {rsi:.0f} — overbought, bearish bias')
    else:
        scores.append(0.0);  features.append(f'RSI {rsi:.0f} — neutral zone')

    if len(closes) >= 26:
        macd_val = _ema(closes[-12:], 12) - _ema(closes[-26:], 26)
        if macd_val > 0:
            scores.append(0.8);  features.append('MACD positive — bullish momentum')
        else:
            scores.append(-0.8); features.append('MACD negative — bearish momentum')

    if len(closes) >= 10:
        recent_avg = float(np.mean(closes[-5:]))
        prev_avg   = float(np.mean(closes[-10:-5]))
        if prev_avg > 0:
            mom = (recent_avg - prev_avg) / prev_avg * 100
            if mom > 0.3:
                scores.append(0.7);  features.append(f'Positive price momentum +{mom:.2f}%')
            elif mom < -0.3:
                scores.append(-0.7); features.append(f'Negative price momentum {mom:.2f}%')
            else:
                scores.append(0.0);  features.append(f'Flat price momentum {mom:.2f}%')

    if len(volumes) >= 10:
        vol_ratio = float(volumes[-1]) / max(float(np.mean(volumes[-10:])), 1e-9)
        mom_sign  = 1 if (scores[-1] if scores else 0) >= 0 else -1
        if vol_ratio > 1.4:
            scores.append(0.5 * mom_sign)
            features.append(f'Elevated volume {vol_ratio:.1f}x avg — momentum confirmation')
        else:
            scores.append(0.0)
            features.append(f'Normal volume {vol_ratio:.1f}x avg')

    bb_upper, bb_mid, bb_lower = _bollinger(closes)
    price  = float(closes[-1])
    bb_rng = bb_upper - bb_lower
    if bb_rng > 0:
        bb_pos = (price - bb_lower) / bb_rng
        if bb_pos < 0.2:
            scores.append(0.6);  features.append('Near lower Bollinger Band — potential reversal up')
        elif bb_pos > 0.8:
            scores.append(-0.6); features.append('Near upper Bollinger Band — potential reversal down')
        else:
            scores.append(0.0);  features.append(f'Price in mid Bollinger range ({bb_pos:.0%})')

    if len(closes) >= 21:
        ema9  = _ema(closes[-9:],  9)
        ema21 = _ema(closes[-21:], 21)
        if ema9 > ema21:
            scores.append(0.9);  features.append('EMA9 > EMA21 — uptrend structure')
        else:
            scores.append(-0.9); features.append('EMA9 < EMA21 — downtrend structure')

    if not scores:
        return None

    total        = float(sum(scores))
    max_possible = sum(abs(s) for s in [1.0, 0.8, 0.7, 0.5, 0.6, 0.9])
    confidence   = round(min(abs(total) / max_possible, 0.95), 3)

    if total > 0.4:
        direction = 'UP'
    elif total < -0.4:
        direction = 'DOWN'
    else:
        direction = 'SIDEWAYS'

    return {
        'direction':  direction,
        'confidence': confidence,
        'horizon':    horizon,
        'score':      round(total, 3),
        'features':   features
    }


def compute_signal(prediction, sentiment_label='NEUTRAL', sentiment_score=0.5,
                   sentiment_confidence=0.5, threshold=0.5):
    direction = prediction['direction']
    pred_conf = prediction['confidence']
    evidence  = [
        f"Prediction: {direction} ({pred_conf:.0%} confidence)",
        f"Reddit sentiment: {sentiment_label} ({float(sentiment_score):.0%})"
    ]
    sent_bull = sentiment_label == 'BULLISH'
    sent_bear = sentiment_label == 'BEARISH'

    if direction == 'UP' and pred_conf >= threshold:
        if sent_bull:
            action   = 'BUY'
            sig_conf = round(pred_conf * 0.6 + float(sentiment_confidence) * 0.4, 3)
            evidence.append('Sentiment confirms bullish prediction')
        elif sent_bear:
            action   = 'HOLD'
            sig_conf = round(pred_conf * 0.35, 3)
            evidence.append('Conflicting signals — bearish sentiment vs bullish prediction')
        else:
            action   = 'BUY'
            sig_conf = round(pred_conf * 0.55, 3)
            evidence.append('Neutral sentiment — buy on technical basis')
    elif direction == 'DOWN' and pred_conf >= threshold:
        if sent_bear:
            action   = 'SELL'
            sig_conf = round(pred_conf * 0.6 + float(sentiment_confidence) * 0.4, 3)
            evidence.append('Sentiment confirms bearish prediction')
        elif sent_bull:
            action   = 'HOLD'
            sig_conf = round(pred_conf * 0.35, 3)
            evidence.append('Conflicting signals — bullish sentiment vs bearish prediction')
        else:
            action   = 'SELL'
            sig_conf = round(pred_conf * 0.55, 3)
            evidence.append('Neutral sentiment — sell on technical basis')
    else:
        action   = 'HOLD'
        sig_conf = round(max(0.3, pred_conf * 0.4), 3)
        reason   = 'Sideways prediction — no clear directional edge' \
                   if direction == 'SIDEWAYS' \
                   else f'Confidence {pred_conf:.0%} below threshold {threshold:.0%}'
        evidence.append(reason)

    return {
        'action':         action,
        'confidence':     sig_conf,
        'evidence':       evidence,
        'direction_used': direction,
        'sentiment_used': sentiment_label
    }


def run_backtest_logic(candles, horizon_candles=4, confidence_threshold=0.55):
    window     = 50
    pnl        = [0.0]
    signal_log = []
    winning    = 0
    active     = 0
    returns    = []

    for i in range(window, len(candles) - horizon_candles):
        pred = compute_technical_prediction(candles[i-window:i], '?')
        if pred is None:
            continue
        sig    = compute_signal(pred, 'NEUTRAL', 0.5, 0.5, confidence_threshold)
        action = sig['action']

        if action == 'HOLD':
            signal_log.append({'ts': candles[i]['time'], 'action': 'HOLD',
                                'confidence': sig['confidence'],
                                'actual': '—', 'result': '—', 'return': 0})
            continue

        active      += 1
        entry_price  = float(candles[i]['close'])
        exit_price   = float(candles[i + horizon_candles]['close'])
        pct          = (exit_price - entry_price) / entry_price

        if action == 'SELL':
            pct = -pct
            win = exit_price < entry_price
            actual_move = 'DOWN' if exit_price < entry_price else 'UP'
        else:
            win = exit_price > entry_price
            actual_move = 'UP' if exit_price > entry_price else 'DOWN'

        if win:
            winning += 1
        returns.append(pct)
        pnl.append(pnl[-1] + pct)
        signal_log.append({
            'ts':         candles[i]['time'],
            'action':     action,
            'confidence': round(sig['confidence'], 3),
            'actual':     actual_move,
            'result':     'WIN' if win else 'LOSS',
            'return':     round(pct * 100, 3)
        })

    win_rate   = round(winning / active, 3) if active > 0 else 0
    avg_return = round(float(np.mean(returns)), 5) if returns else 0
    cum_return = round(float(pnl[-1]), 5)

    if len(returns) > 1:
        arr    = np.array(returns)
        sharpe = round(float(np.mean(arr) / np.std(arr)), 3) if float(np.std(arr)) > 0 else 0.0
    else:
        sharpe = 0.0

    return {
        'total_candles':     len(candles),
        'total_signals':     len(signal_log),
        'active_signals':    active,
        'buy_signals':       sum(1 for s in signal_log if s['action'] == 'BUY'),
        'sell_signals':      sum(1 for s in signal_log if s['action'] == 'SELL'),
        'hold_signals':      sum(1 for s in signal_log if s['action'] == 'HOLD'),
        'winning':           winning,
        'win_rate':          win_rate,
        'avg_return':        avg_return,
        'cumulative_return': cum_return,
        'sharpe':            sharpe,
        'pnl_curve':         [round(v, 5) for v in pnl],
        'signal_log':        signal_log[-150:]
    }


def post_matches(title, body, symbol):
    text = (title + ' ' + body).lower()
    return any(kw in text for kw in COIN_KEYWORDS.get(symbol, [symbol.lower()]))


def fetch_reddit(symbol, limit=25):
    subreddits  = COIN_SUBREDDITS.get(symbol, ['CryptoCurrency'])
    own_sub     = COIN_OWN_SUBS.get(symbol, '').lower()
    headers     = {'User-Agent': 'CryptoTerminal/2.0'}
    posts, seen = [], set()
    for sub in subreddits:
        try:
            r    = requests.get(f'https://www.reddit.com/r/{sub}/hot.json?limit={limit}',
                                headers=headers, timeout=10)
            data = r.json()
            for item in data['data']['children']:
                p   = item['data']
                pid = p.get('id','')
                if pid in seen:
                    continue
                title = p.get('title','')
                body  = p.get('selftext','')[:500]
                if sub.lower() == own_sub or post_matches(title, body, symbol):
                    seen.add(pid)
                    posts.append({'symbol': symbol, 'subreddit': sub,
                                  'title': title, 'body': body,
                                  'url':   'https://reddit.com' + p.get('permalink',''),
                                  'score': p.get('score', 0),
                                  'created_at': int(p.get('created_utc', time.time()))})
        except Exception:
            pass
    posts.sort(key=lambda x: x['score'], reverse=True)
    return posts[:15]


def run_sentiment(symbol, posts, model):
    post_text = '\n\n'.join([
        f"Title: {p['title']}\nBody: {p.get('body','')[:200]}\nScore: {p['score']}"
        for p in posts[:10]
    ])
    prompt = (
        f'Analyze these Reddit posts about {symbol} cryptocurrency.\n'
        f'Return ONLY a JSON object with no markdown, no explanation, no extra text.\n\n'
        f'Posts:\n{post_text}\n\n'
        f'Required JSON format:\n'
        f'{{"symbol":"{symbol}","label":"BULLISH or BEARISH or NEUTRAL",'
        f'"score":0.0,"confidence":0.0,"summary":"one sentence"}}'
    )
    resp   = requests.post(f'{OLLAMA_BASE}/api/chat',
                           json={'model': model,
                                 'messages': [{'role':'user','content': prompt}],
                                 'stream': False, 'format': 'json'},
                           timeout=120)
    raw    = resp.json().get('message',{}).get('content','{}')
    result = json.loads(raw)
    result['label']      = str(result.get('label','NEUTRAL')).upper()
    if result['label'] not in ('BULLISH','BEARISH','NEUTRAL'):
        result['label']  = 'NEUTRAL'
    result['score']      = round(max(0.0, min(1.0, float(result.get('score', 0.5)))), 4)
    result['confidence'] = round(max(0.0, min(1.0, float(result.get('confidence', 0.5)))), 4)
    result['summary']    = str(result.get('summary',''))[:300]
    result['symbol']     = symbol
    return result


def fetch_onchain(ticker):
    result = {}
    try:
        r = requests.get(f'{BINANCE_FAPI}/premiumIndex',
                         params={'symbol': ticker}, timeout=5)
        if r.status_code == 200:
            fi = r.json()
            result['funding_rate'] = round(float(fi.get('lastFundingRate', 0)), 6)
            result['mark_price']   = round(float(fi.get('markPrice', 0)), 4)
    except Exception:
        pass
    try:
        r = requests.get(f'{BINANCE_FAPI}/openInterest',
                         params={'symbol': ticker}, timeout=5)
        if r.status_code == 200:
            result['open_interest'] = round(float(r.json().get('openInterest', 0)), 2)
    except Exception:
        pass
    return result


def _build_prophet_df(candles):
    ts = pd.to_datetime([c['time'] for c in candles], unit='s', utc=True).tz_localize(None)
    return pd.DataFrame({
        'ds': ts,
        'y':  np.log(np.maximum([float(c['close']) for c in candles], 1e-10))
    })


def _fit_prophet(df, interval):
    if interval in ('1d','3d','1w'):
        weekly = True;  daily = False; yearly = True
    elif interval in ('1h','2h','4h','6h','8h','12h'):
        weekly = True;  daily = True;  yearly = False
    else:
        weekly = False; daily = True;  yearly = False

    m = Prophet(
        changepoint_prior_scale=0.25,
        seasonality_prior_scale=10.0,
        seasonality_mode='additive',
        weekly_seasonality=weekly,
        daily_seasonality=daily,
        yearly_seasonality=yearly,
        interval_width=0.80,
        uncertainty_samples=200,
    )
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        m.fit(df)
    return m


def _prophet_future_df(last_ds, interval, n):
    step = pd.Timedelta(seconds=INTERVAL_SECONDS.get(interval, 3600))
    return pd.DataFrame({'ds': [last_ds + step * i for i in range(1, n + 1)]})


def _get_cached_prophet(symbol, interval, n_candles):
    key   = (symbol, interval)
    entry = _prophet_cache.get(key)
    if entry and (time.time() - entry['at']) < PROPHET_CACHE_TTL and entry['n'] == n_candles:
        return entry['model']
    return None


def _set_cached_prophet(symbol, interval, model, n_candles):
    _prophet_cache[(symbol, interval)] = {'model': model, 'n': n_candles, 'at': time.time()}


def prophet_predict_now(candles, symbol, interval, horizon_candles=4):
    if not PANDAS_AVAILABLE:
        return None, 'pandas not installed — run: pip install prophet'
    if not PROPHET_AVAILABLE:
        return None, 'Prophet not installed — run: pip install prophet'
    if len(candles) < 50:
        return None, f'Need at least 50 candles, got {len(candles)}'

    try:
        df     = _build_prophet_df(candles)
        cached = _get_cached_prophet(symbol, interval, len(candles))
        if cached is None:
            cached = _fit_prophet(df, interval)
            _set_cached_prophet(symbol, interval, cached, len(candles))

        future   = _prophet_future_df(df.iloc[-1]['ds'], interval, horizon_candles)
        forecast = cached.predict(future)

        current_price      = float(candles[-1]['close'])
        last_row           = forecast.iloc[-1]
        pred_price         = float(np.exp(float(last_row['yhat'])))
        lower_price        = float(np.exp(float(last_row['yhat_lower'])))
        upper_price        = float(np.exp(float(last_row['yhat_upper'])))
        pct_change         = (pred_price - current_price) / current_price
        interval_width_pct = (upper_price - lower_price) / max(current_price, 1e-10)
        strength           = abs(pct_change) / max(interval_width_pct, 0.001)
        confidence         = float(np.clip(0.28 + strength * 0.50, 0.22, 0.90))

        if pct_change > 0.002:
            direction = 'UP'
        elif pct_change < -0.002:
            direction = 'DOWN'
        else:
            direction = 'SIDEWAYS'

        return {
            'direction':       direction,
            'confidence':      round(confidence, 3),
            'predicted_price': round(pred_price, 4),
            'current_price':   round(current_price, 4),
            'pct_change':      round(pct_change * 100, 3),
            'pred_lower':      round(lower_price, 4),
            'pred_upper':      round(upper_price, 4),
            'horizon_candles': horizon_candles,
            'model':           'Prophet',
        }, None
    except Exception as e:
        return None, f'Prophet prediction error: {str(e)}'


def _dir_metrics(y_true, y_pred, pos_label=1):
    tp = sum(1 for t, p in zip(y_true, y_pred) if t == pos_label and p == pos_label)
    fp = sum(1 for t, p in zip(y_true, y_pred) if t != pos_label and p == pos_label)
    fn = sum(1 for t, p in zip(y_true, y_pred) if t == pos_label and p != pos_label)
    prec = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    rec  = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    f1   = 2 * prec * rec / (prec + rec) if (prec + rec) > 0 else 0.0
    return round(prec, 4), round(rec, 4), round(f1, 4)


def _annualised_sharpe(rets, interval):
    arr = np.array(rets, dtype=float)
    if len(arr) < 2 or float(np.std(arr)) == 0:
        return 0.0
    secs_per_year    = 365.0 * 24 * 3600
    periods_per_year = secs_per_year / max(INTERVAL_SECONDS.get(interval, 3600), 1)
    return round(float(np.mean(arr) / np.std(arr) * np.sqrt(periods_per_year)), 3)


def evaluate_prophet_model(candles, interval, horizon_candles=1):
    if not PANDAS_AVAILABLE:
        return None, 'pandas not installed — run: pip install prophet'
    if not PROPHET_AVAILABLE:
        return None, 'Prophet not installed — run: pip install prophet'
    if len(candles) < 80:
        return None, f'Need at least 80 candles for evaluation, got {len(candles)}'

    split_idx   = int(len(candles) * 0.8)
    train_cands = candles[:split_idx]
    test_cands  = candles[split_idx:]

    try:
        train_df = _build_prophet_df(train_cands)
        model    = _fit_prophet(train_df, interval)

        test_ds  = pd.DataFrame({
            'ds': pd.to_datetime([c['time'] for c in test_cands], unit='s', utc=True).tz_localize(None)
        })
        forecast = model.predict(test_ds)
    except Exception as e:
        return None, f'Prophet fitting failed: {str(e)}'

    actuals    = []
    ml_preds   = []
    tech_pairs = []
    ml_returns = []
    bh_returns = []
    signal_log = []
    tech_window = 50

    for i, cand in enumerate(test_cands):
        prev_close = float(train_cands[-1]['close']) if i == 0 else float(test_cands[i-1]['close'])
        curr_close = float(cand['close'])
        actual_up  = 1 if curr_close > prev_close else 0

        pred_price = float(np.exp(float(forecast.iloc[i]['yhat'])))
        pred_lower = float(np.exp(float(forecast.iloc[i]['yhat_lower'])))
        pred_upper = float(np.exp(float(forecast.iloc[i]['yhat_upper'])))
        ml_up      = 1 if pred_price > prev_close else 0

        available = list(train_cands) + list(test_cands[:i])
        tech_pred = compute_technical_prediction(available[-tech_window:], interval)
        tech_up   = (1 if tech_pred['direction'] == 'UP' else 0) if tech_pred else None

        actuals.append(actual_up)
        ml_preds.append(ml_up)
        if tech_up is not None:
            tech_pairs.append((actual_up, tech_up))

        if i > 0:
            prev = float(test_cands[i-1]['close'])
            ret  = (curr_close - prev) / max(prev, 1e-10)
            bh_returns.append(ret)
            ml_returns.append(ret if ml_preds[i-1] == 1 else -ret)

        signal_log.append({
            'ts':           cand['time'],
            'actual_dir':   'UP' if actual_up else 'DOWN',
            'ml_dir':       'UP' if ml_up else 'DOWN',
            'tech_dir':     ('UP' if tech_up else 'DOWN') if tech_up is not None else '—',
            'pred_price':   round(pred_price, 4),
            'actual_price': round(curr_close, 4),
            'pred_lower':   round(pred_lower, 4),
            'pred_upper':   round(pred_upper, 4),
            'correct':      actual_up == ml_up,
        })

    n_total  = len(actuals)
    if n_total == 0:
        return None, 'No evaluation samples produced'

    n_correct    = sum(1 for a, p in zip(actuals, ml_preds) if a == p)
    dir_acc      = n_correct / n_total
    n_up_actual  = sum(actuals)
    baseline_acc = n_up_actual / n_total

    precision, recall, f1 = _dir_metrics(actuals, ml_preds, pos_label=1)

    tp = sum(1 for a, p in zip(actuals, ml_preds) if a == 1 and p == 1)
    fp = sum(1 for a, p in zip(actuals, ml_preds) if a == 0 and p == 1)
    tn = sum(1 for a, p in zip(actuals, ml_preds) if a == 0 and p == 0)
    fn = sum(1 for a, p in zip(actuals, ml_preds) if a == 1 and p == 0)

    ml_cum    = float(np.sum(ml_returns)) if ml_returns else 0.0
    bh_cum    = float(np.sum(bh_returns)) if bh_returns else 0.0
    ml_sharpe = _annualised_sharpe(ml_returns, interval)
    bh_sharpe = _annualised_sharpe(bh_returns, interval)
    alpha     = round(ml_cum - bh_cum, 5)

    ml_pnl = [round(v, 5) for v in np.cumsum(ml_returns).tolist()] if ml_returns else []
    bh_pnl = [round(v, 5) for v in np.cumsum(bh_returns).tolist()] if bh_returns else []

    tech_acc   = None
    ml_vs_tech = None
    if tech_pairs:
        t_act  = [x[0] for x in tech_pairs]
        t_pred = [x[1] for x in tech_pairs]
        n_tech_correct = sum(1 for a, p in zip(t_act, t_pred) if a == p)
        tech_acc   = round(n_tech_correct / len(t_act), 4)
        ml_vs_tech = round(dir_acc - tech_acc, 4)

    return {
        'train_candles':        split_idx,
        'test_candles':         len(test_cands),
        'train_from':           train_cands[0]['time'],
        'train_to':             train_cands[-1]['time'],
        'test_from':            test_cands[0]['time'],
        'test_to':              test_cands[-1]['time'],
        'directional_accuracy': round(dir_acc, 4),
        'baseline_accuracy':    round(baseline_acc, 4),
        'precision':            precision,
        'recall':               recall,
        'f1_score':             f1,
        'confusion_matrix':     {'tp': tp, 'fp': fp, 'tn': tn, 'fn': fn},
        'ml_cumulative_return': round(ml_cum, 5),
        'ml_sharpe':            ml_sharpe,
        'bh_cumulative_return': round(bh_cum, 5),
        'bh_sharpe':            bh_sharpe,
        'alpha':                alpha,
        'technical_accuracy':   tech_acc,
        'ml_vs_tech_edge':      ml_vs_tech,
        'pnl_ml':               ml_pnl,
        'pnl_bh':               bh_pnl,
        'horizon_candles':      horizon_candles,
        'signal_log':           signal_log[-150:],
        'prophet_available':    True,
    }, None


@app.route('/health')
def health():
    return jsonify({
        'status':            'ok',
        'version':           '2.0.0',
        'prophet_available': PROPHET_AVAILABLE,
        'pandas_available':  PANDAS_AVAILABLE,
    })


@app.route('/price')
def price():
    symbol   = request.args.get('symbol','BTCUSDT')
    interval = request.args.get('interval','1h')
    limit    = min(int(request.args.get('limit',150)), 500)
    if not valid_interval(interval):
        return jsonify({'error':'Invalid interval'}), 400
    key     = os.getenv('BINANCE_API_KEY','')
    headers = {'X-MBX-APIKEY': key} if key else {}
    try:
        resp = requests.get(f'{BINANCE_BASE}/klines',
                            params={'symbol': symbol,'interval': interval,'limit': limit},
                            headers=headers, timeout=10)
        raw = resp.json()
        if isinstance(raw, dict) and raw.get('code'):
            return jsonify({'error': raw.get('msg','Binance error')}), 400
        candles = [{'time':c[0]//1000,'open':float(c[1]),'high':float(c[2]),
                    'low':float(c[3]),'close':float(c[4]),'volume':float(c[5])} for c in raw]
        return jsonify({'candles': candles})
    except Exception as e:
        return jsonify({'error': clean_error(e)}), 503


@app.route('/insight')
def insight():
    symbol   = request.args.get('symbol','BTCUSDT')
    interval = request.args.get('interval','1h')
    if not valid_interval(interval):
        return jsonify({'error':'Invalid interval'}), 400
    key     = os.getenv('BINANCE_API_KEY','')
    headers = {'X-MBX-APIKEY': key} if key else {}
    try:
        r1     = requests.get(f'{BINANCE_BASE}/klines',
                              params={'symbol': symbol,'interval': interval,'limit': 20},
                              headers=headers, timeout=10)
        data   = r1.json()
        closes = [float(c[4]) for c in data]
        current       = closes[-1]
        sma5          = sum(closes[-5:]) / 5
        sma20         = sum(closes) / 20
        recent_change = ((closes[-1] - closes[-5]) / closes[-5]) * 100
        if sma5 > sma20 and recent_change > 0:
            direction  = 'UP';   confidence = 'Medium' if abs(recent_change) > 1 else 'Low'
            reason     = f'Price above 20-candle MA. +{recent_change:.2f}% in last 5 candles.'
        elif sma5 < sma20 and recent_change < 0:
            direction  = 'DOWN'; confidence = 'Medium' if abs(recent_change) > 1 else 'Low'
            reason     = f'Price below 20-candle MA. {recent_change:.2f}% in last 5 candles.'
        else:
            direction  = 'NEUTRAL'; confidence = 'Low'
            reason     = 'Mixed signals — no strong directional bias detected.'
        r2 = requests.get(f'{BINANCE_BASE}/ticker/24hr',
                          params={'symbol': symbol}, headers=headers, timeout=10)
        t  = r2.json()
        return jsonify({'symbol': symbol,'current_price': current,
                        'change_24h': float(t.get('priceChangePercent',0)),
                        'high_24h': float(t.get('highPrice',0)),
                        'low_24h': float(t.get('lowPrice',0)),
                        'volume_24h': float(t.get('volume',0)),
                        'direction': direction,'confidence': confidence,
                        'reason': reason,'sma5': round(sma5,4),'sma20': round(sma20,4)})
    except Exception as e:
        return jsonify({'error': clean_error(e)}), 503


@app.route('/chat', methods=['POST'])
def chat():
    body      = request.json or {}
    message   = sanitize_str(body.get('message',''), max_len=1000)
    model     = sanitize_str(body.get('model','llama3.2'), max_len=100)
    symbol    = body.get('symbol','BTC').upper()
    timeframe = body.get('timeframe','1h')
    price_ctx = sanitize_str(body.get('price_context',''), max_len=2000)
    history   = body.get('history',[])
    if not message:
        return jsonify({'reply':'Empty message.'}), 400
    if not valid_model(model):
        return jsonify({'reply':'Invalid model name.'}), 400
    symbol    = symbol if valid_symbol(symbol) else 'BTC'
    timeframe = timeframe if valid_interval(timeframe) else '1h'
    system    = (f'You are a crypto market analysis assistant built into an educational terminal.\n'
                 f'Currently analyzing: {symbol} | Timeframe: {timeframe}\n{price_ctx}\n'
                 f'Rules: Educational simulation only. Never give real financial advice. Be concise and analytical.')
    messages  = [{'role':'system','content': system}]
    for h in history[-10:]:
        if isinstance(h, dict) and h.get('role') in ('user','assistant'):
            messages.append({'role': h['role'],'content': sanitize_str(h.get('content',''), 500)})
    messages.append({'role':'user','content': message})
    try:
        resp = requests.post(f'{OLLAMA_BASE}/api/chat',
                             json={'model': model,'messages': messages,'stream': False},
                             timeout=120)
        data = resp.json()
        return jsonify({'reply': data.get('message',{}).get('content','No response from model.')})
    except Exception as e:
        return jsonify({'reply':'Cannot reach Ollama. Make sure it is running locally.',
                        'error': clean_error(e)}), 500


@app.route('/models')
def models():
    try:
        resp = requests.get(f'{OLLAMA_BASE}/api/tags', timeout=10)
        return jsonify({'models': [m['name'] for m in resp.json().get('models',[])]})
    except Exception as e:
        return jsonify({'models':[], 'error': clean_error(e)})


@app.route('/pull-model', methods=['POST'])
def pull_model():
    name = sanitize_str((request.json or {}).get('model',''), max_len=100)
    if not name or not valid_model(name):
        return jsonify({'error':'Invalid model name'}), 400
    try:
        requests.post(f'{OLLAMA_BASE}/api/pull',
                      json={'name': name,'stream': False}, timeout=600)
        return jsonify({'success': True,'model': name})
    except Exception as e:
        return jsonify({'error': clean_error(e)}), 500


@app.route('/save-settings', methods=['POST'])
def save_settings():
    body  = request.json or {}
    lines = {}
    if os.path.exists(ENV_PATH):
        with open(ENV_PATH) as f:
            for line in f:
                line = line.strip()
                if '=' in line and not line.startswith('#'):
                    k, v = line.split('=', 1)
                    lines[k.strip()] = v.strip()
    if 'binance_api_key' in body:
        key = sanitize_str(body['binance_api_key'], max_len=200)
        if re.match(r'^[A-Za-z0-9]*$', key):
            lines['BINANCE_API_KEY'] = key
    if 'setup_complete' in body:
        lines['SETUP_COMPLETE'] = 'true' if body['setup_complete'] else 'false'
    with open(ENV_PATH, 'w') as f:
        for k, v in lines.items():
            f.write(f'{k}={v}\n')
    load_dotenv(ENV_PATH, override=True)
    return jsonify({'success': True})


@app.route('/get-settings')
def get_settings():
    return jsonify({'binance_api_key': os.getenv('BINANCE_API_KEY',''),
                    'setup_complete':  os.getenv('SETUP_COMPLETE','false') == 'true'})


@app.route('/reddit')
def reddit():
    symbol = request.args.get('symbol','BTC').upper()
    if not valid_symbol(symbol):
        return jsonify({'error':'Invalid symbol'}), 400
    posts = fetch_reddit(symbol)
    conn  = get_db()
    for p in posts:
        conn.execute('INSERT INTO posts (symbol,subreddit,title,body,url,score,created_at) VALUES (?,?,?,?,?,?,?)',
                     (p['symbol'],p['subreddit'],p['title'],p['body'],p['url'],p['score'],p['created_at']))
    conn.commit(); conn.close()
    return jsonify({'posts': posts,'count': len(posts)})


@app.route('/sentiment', methods=['POST'])
def sentiment():
    body   = request.json or {}
    symbol = body.get('symbol','BTC').upper()
    model  = sanitize_str(body.get('model','llama3.2'), max_len=100)
    posts  = body.get('posts',[])
    if not valid_symbol(symbol):
        return jsonify({'error':'Invalid symbol'}), 400
    if not valid_model(model):
        return jsonify({'error':'Invalid model name'}), 400
    if not posts:
        return jsonify({'error':'No posts provided'}), 400
    try:
        result = run_sentiment(symbol, posts, model)
        conn   = get_db()
        conn.execute('INSERT INTO sentiment (symbol,model,label,score,confidence,summary,created_at) VALUES (?,?,?,?,?,?,?)',
                     (symbol, model, result['label'], result['score'],
                      result['confidence'], result['summary'], int(time.time())))
        conn.commit(); conn.close()
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': clean_error(e)}), 500


@app.route('/forecast', methods=['POST'])
def forecast():
    body     = request.json or {}
    symbol   = body.get('symbol','BTC').upper()
    interval = body.get('interval','1h')
    horizon  = body.get('horizon','1h')
    if not valid_symbol(symbol):
        return jsonify({'error':'Invalid symbol'}), 400
    if not valid_interval(interval):
        return jsonify({'error':'Invalid interval'}), 400
    ticker  = COIN_TICKERS.get(symbol, symbol + 'USDT')
    key     = os.getenv('BINANCE_API_KEY','')
    headers = {'X-MBX-APIKEY': key} if key else {}
    try:
        resp = requests.get(f'{BINANCE_BASE}/klines',
                            params={'symbol': ticker,'interval': interval,'limit': 100},
                            headers=headers, timeout=10)
        raw  = resp.json()
        if isinstance(raw, dict) and raw.get('code'):
            return jsonify({'error': raw.get('msg','Binance error')}), 400
        candles = [{'time':c[0]//1000,'open':float(c[1]),'high':float(c[2]),
                    'low':float(c[3]),'close':float(c[4]),'volume':float(c[5])} for c in raw]
    except Exception as e:
        return jsonify({'error': clean_error(e)}), 503
    pred = compute_technical_prediction(candles, horizon)
    if pred is None:
        return jsonify({'error':'Not enough data for prediction'}), 400
    conn = get_db()
    row  = conn.execute('SELECT label, score, confidence FROM sentiment WHERE symbol=? ORDER BY created_at DESC LIMIT 1',
                        (symbol,)).fetchone()
    conn.close()
    sent_label, sent_score, sent_conf = ('NEUTRAL', 0.5, 0.5)
    if row:
        sent_label = row['label']; sent_score = row['score']; sent_conf = row['confidence']
    sig = compute_signal(pred, sent_label, sent_score, sent_conf)
    ts  = int(time.time())
    conn = get_db()
    conn.execute('INSERT INTO predictions (symbol,interval,direction,confidence,horizon,score,features_json,created_at) VALUES (?,?,?,?,?,?,?,?)',
                 (symbol, interval, pred['direction'], pred['confidence'],
                  pred['horizon'], pred['score'], json.dumps(pred['features']), ts))
    conn.commit(); conn.close()
    return jsonify({
        'prediction':     {**pred, 'created_at': ts},
        'signal':         {**sig,  'created_at': ts, 'symbol': symbol},
        'sentiment_used': {'label': sent_label,'score': sent_score,'confidence': sent_conf}
    })


@app.route('/ml-predict', methods=['POST'])
def ml_predict():
    body     = request.json or {}
    symbol   = body.get('symbol','BTC').upper()
    interval = body.get('interval','1h')
    horizon  = min(int(body.get('horizon_candles', 4)), 24)
    if not valid_symbol(symbol):
        return jsonify({'error':'Invalid symbol'}), 400
    if not valid_interval(interval):
        return jsonify({'error':'Invalid interval'}), 400
    if not PANDAS_AVAILABLE or not PROPHET_AVAILABLE:
        return jsonify({'error':'Prophet not installed. Run: pip install prophet',
                        'prophet_available': False}), 503
    ticker  = COIN_TICKERS.get(symbol, symbol + 'USDT')
    key     = os.getenv('BINANCE_API_KEY','')
    headers = {'X-MBX-APIKEY': key} if key else {}
    try:
        resp = requests.get(f'{BINANCE_BASE}/klines',
                            params={'symbol': ticker,'interval': interval,'limit': 500},
                            headers=headers, timeout=15)
        raw = resp.json()
        if isinstance(raw, dict) and raw.get('code'):
            return jsonify({'error': raw.get('msg','Binance error')}), 400
        candles = [{'time':c[0]//1000,'open':float(c[1]),'high':float(c[2]),
                    'low':float(c[3]),'close':float(c[4]),'volume':float(c[5])} for c in raw]
    except Exception as e:
        return jsonify({'error': clean_error(e)}), 503
    ml_pred, err = prophet_predict_now(candles, symbol, interval, horizon)
    if err:
        return jsonify({'error': err}), 400
    tech_pred = compute_technical_prediction(candles[-100:], interval)
    agreement = (ml_pred['direction'] == tech_pred['direction']) if tech_pred else None
    return jsonify({
        'ml_prediction':     ml_pred,
        'tech_prediction':   tech_pred,
        'agreement':         agreement,
        'symbol':            symbol,
        'interval':          interval,
        'prophet_available': True,
    })


@app.route('/ml-evaluate', methods=['POST'])
def ml_evaluate():
    body     = request.json or {}
    symbol   = body.get('symbol','BTC').upper()
    interval = body.get('interval','1h')
    horizon  = min(int(body.get('horizon_candles', 1)), 8)
    lookback = min(int(body.get('lookback', 500)), 500)
    if not valid_symbol(symbol):
        return jsonify({'error':'Invalid symbol'}), 400
    if not valid_interval(interval):
        return jsonify({'error':'Invalid interval'}), 400
    if not PANDAS_AVAILABLE or not PROPHET_AVAILABLE:
        return jsonify({
            'error': 'Prophet not installed. Run: pip install prophet  (then restart the backend)',
            'prophet_available': False
        }), 503
    ticker  = COIN_TICKERS.get(symbol, symbol + 'USDT')
    key     = os.getenv('BINANCE_API_KEY','')
    headers = {'X-MBX-APIKEY': key} if key else {}
    try:
        resp = requests.get(f'{BINANCE_BASE}/klines',
                            params={'symbol': ticker,'interval': interval,'limit': lookback},
                            headers=headers, timeout=30)
        raw = resp.json()
        if isinstance(raw, dict) and raw.get('code'):
            return jsonify({'error': raw.get('msg','Binance error')}), 400
        candles = [{'time':c[0]//1000,'open':float(c[1]),'high':float(c[2]),
                    'low':float(c[3]),'close':float(c[4]),'volume':float(c[5])} for c in raw]
    except Exception as e:
        return jsonify({'error': clean_error(e)}), 503
    result, err = evaluate_prophet_model(candles, interval, horizon)
    if err:
        return jsonify({'error': err, 'prophet_available': PROPHET_AVAILABLE}), 400
    result['symbol']   = symbol
    result['interval'] = interval
    result['lookback'] = len(candles)
    ts = int(time.time())
    try:
        conn = get_db()
        conn.execute(
            'INSERT INTO ml_evaluations (symbol,interval,horizon_candles,train_candles,test_candles,'
            'directional_accuracy,precision_score,recall_score,f1_score,ml_sharpe,bh_sharpe,alpha,'
            'technical_accuracy,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            (symbol, interval, horizon, result['train_candles'], result['test_candles'],
             result['directional_accuracy'], result['precision'], result['recall'],
             result['f1_score'], result['ml_sharpe'], result['bh_sharpe'], result['alpha'],
             result['technical_accuracy'], ts))
        conn.commit(); conn.close()
    except Exception:
        pass
    return jsonify(result)


@app.route('/search-markets')
def search_markets():
    query = request.args.get('q','').strip().upper()
    if not query:
        return jsonify({'results': []})
    try:
        r       = requests.get(f'{BINANCE_BASE}/ticker/24hr', timeout=10)
        tickers = r.json()
        results = []
        for t in tickers:
            sym = t.get('symbol','')
            if not sym.endswith('USDT'):
                continue
            base = sym[:-4]
            if query in base:
                results.append({
                    'symbol': base,
                    'ticker': sym,
                    'price':  float(t.get('lastPrice', 0)),
                    'change': round(float(t.get('priceChangePercent', 0)), 2),
                    'volume': round(float(t.get('quoteVolume', 0)), 0),
                })
        results.sort(key=lambda x: x['volume'], reverse=True)
        return jsonify({'results': results[:25]})
    except Exception as e:
        return jsonify({'error': clean_error(e), 'results': []})


@app.route('/pipeline', methods=['POST'])
def pipeline():
    body     = request.json or {}
    symbol   = body.get('symbol','BTC').upper()
    interval = body.get('interval','1h')
    model    = sanitize_str(body.get('model','llama3.2'), max_len=100)
    if not valid_symbol(symbol):
        return jsonify({'error':'Invalid symbol'}), 400
    if not valid_interval(interval):
        return jsonify({'error':'Invalid interval'}), 400
    if not valid_model(model):
        return jsonify({'error':'Invalid model name'}), 400

    ticker  = COIN_TICKERS.get(symbol, symbol + 'USDT')
    key     = os.getenv('BINANCE_API_KEY','')
    headers = {'X-MBX-APIKEY': key} if key else {}
    log     = []
    result  = {'symbol': symbol, 'log': log}
    ts      = int(time.time())

    candles       = []
    current_price = None
    try:
        r   = requests.get(f'{BINANCE_BASE}/klines',
                           params={'symbol': ticker,'interval': interval,'limit': 100},
                           headers=headers, timeout=10)
        raw = r.json()
        if isinstance(raw, list) and raw:
            candles = [{'time':c[0]//1000,'open':float(c[1]),'high':float(c[2]),
                        'low':float(c[3]),'close':float(c[4]),'volume':float(c[5])} for c in raw]
            current_price = float(candles[-1]['close'])
            conn = get_db()
            for c in candles[-10:]:
                conn.execute('INSERT INTO prices (symbol,interval,timestamp,close,volume) VALUES (?,?,?,?,?)',
                             (symbol, interval, c['time'], c['close'], c['volume']))
            conn.commit(); conn.close()
            log.append(f'Fetched {len(candles)} Binance candles for {ticker}')
            result['candles']       = len(candles)
            result['current_price'] = current_price
        else:
            msg = raw.get('msg','empty') if isinstance(raw, dict) else 'empty'
            log.append(f'Binance error: {msg}')
    except Exception as e:
        log.append(f'Binance fetch failed: {clean_error(e)}')

    posts = []
    try:
        posts = fetch_reddit(symbol)
        if posts:
            conn = get_db()
            for p in posts:
                conn.execute('INSERT INTO posts (symbol,subreddit,title,body,url,score,created_at) VALUES (?,?,?,?,?,?,?)',
                             (p['symbol'],p['subreddit'],p['title'],p['body'],
                              p['url'],p['score'],p['created_at']))
            conn.commit(); conn.close()
        subs = ', '.join([f"r/{s}" for s in COIN_SUBREDDITS.get(symbol,['CryptoCurrency'])])
        log.append(f'Fetched {len(posts)} Reddit posts from {subs}')
        result['post_count'] = len(posts)
    except Exception as e:
        log.append(f'Reddit fetch failed: {clean_error(e)}')

    sentiment_data = None
    if posts and model:
        try:
            log.append(f'Running sentiment analysis with {model}')
            sentiment_data = run_sentiment(symbol, posts, model)
            conn = get_db()
            conn.execute('INSERT INTO sentiment (symbol,model,label,score,confidence,summary,created_at) VALUES (?,?,?,?,?,?,?)',
                         (symbol, model, sentiment_data['label'], sentiment_data['score'],
                          sentiment_data['confidence'], sentiment_data['summary'], ts))
            conn.commit(); conn.close()
            log.append(f'{symbol} sentiment: {sentiment_data["label"]} ({sentiment_data["score"]:.2f})')
            result['sentiment'] = sentiment_data
        except Exception as e:
            log.append(f'Sentiment failed: {clean_error(e)}')
    else:
        log.append('Skipping sentiment — no posts or no model')

    onchain = fetch_onchain(ticker)
    if onchain:
        fr = onchain.get('funding_rate', 0)
        oi = onchain.get('open_interest', 0)
        log.append(f'On-chain: funding={fr:.4%}, OI={oi:,.0f}')
        result['onchain'] = onchain
    else:
        log.append('On-chain data unavailable (futures endpoint)')

    tech_pred = None
    if candles:
        try:
            tech_pred = compute_technical_prediction(candles, interval)
            if tech_pred:
                conn = get_db()
                conn.execute('INSERT INTO predictions (symbol,interval,direction,confidence,horizon,score,features_json,created_at) VALUES (?,?,?,?,?,?,?,?)',
                             (symbol, interval, tech_pred['direction'], tech_pred['confidence'],
                              tech_pred['horizon'], tech_pred['score'], json.dumps(tech_pred['features']), ts))
                conn.commit(); conn.close()
                log.append(f'Technical: {tech_pred["direction"]} ({tech_pred["confidence"]:.0%} conf)')
        except Exception as e:
            log.append(f'Technical prediction failed: {clean_error(e)}')

    ml_pred_result = None
    if candles and PANDAS_AVAILABLE and PROPHET_AVAILABLE:
        ml_holder = [None]
        ml_err    = [None]

        def _ml_thread():
            try:
                ml_holder[0], ml_err[0] = prophet_predict_now(candles, symbol, interval, 4)
            except Exception as ex:
                ml_err[0] = str(ex)

        t = threading.Thread(target=_ml_thread, daemon=True)
        t.start()
        t.join(timeout=25)

        if ml_holder[0]:
            ml_pred_result = ml_holder[0]
            log.append(f'ML Prophet: {ml_pred_result["direction"]} ({ml_pred_result["confidence"]:.0%} conf, '
                        f'target ${ml_pred_result["predicted_price"]})')
            result['ml_prediction'] = ml_pred_result
        else:
            log.append(f'ML Prophet: {ml_err[0] or "timed out after 25s"}')
    elif not PROPHET_AVAILABLE:
        log.append('ML Prophet: not installed (pip install prophet)')

    if tech_pred:
        if ml_pred_result and ml_pred_result['direction'] != 'SIDEWAYS':
            if ml_pred_result['direction'] == tech_pred['direction']:
                boosted = round(min(
                    tech_pred['confidence'] * 0.55 + ml_pred_result['confidence'] * 0.45 + 0.05,
                    0.93
                ), 3)
                combined = {
                    **tech_pred,
                    'confidence': boosted,
                    'features': tech_pred['features'] + [
                        f"ML Prophet confirms {ml_pred_result['direction']} — "
                        f"target ${ml_pred_result['predicted_price']} "
                        f"({ml_pred_result['pct_change']:+.2f}%)"
                    ]
                }
                log.append(f'ML + Technical agree: {tech_pred["direction"]} — boosted to {boosted:.0%}')
            else:
                reduced = round(tech_pred['confidence'] * 0.65, 3)
                combined = {
                    **tech_pred,
                    'confidence': reduced,
                    'features': tech_pred['features'] + [
                        f"ML Prophet disagrees — predicts {ml_pred_result['direction']} "
                        f"(target ${ml_pred_result['predicted_price']})"
                    ]
                }
                log.append(f'ML vs Technical conflict — reduced to {reduced:.0%}')
        else:
            combined = tech_pred

        sent_label = sentiment_data['label']      if sentiment_data else 'NEUTRAL'
        sent_score = sentiment_data['score']      if sentiment_data else 0.5
        sent_conf  = sentiment_data['confidence'] if sentiment_data else 0.5

        try:
            sig       = compute_signal(combined, sent_label, sent_score, sent_conf)
            ml_dir    = ml_pred_result['direction']  if ml_pred_result else None
            ml_conf_v = ml_pred_result['confidence'] if ml_pred_result else None
            ml_agrees = int(ml_pred_result['direction'] == tech_pred['direction']) if ml_pred_result else None

            conn = get_db()
            conn.execute(
                'INSERT INTO signals (symbol,action,confidence,evidence_json,direction_used,'
                'sentiment_used,price_at_signal,interval,source,ml_direction,ml_confidence,'
                'ml_agrees,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                (symbol, sig['action'], sig['confidence'], json.dumps(sig['evidence']),
                 sig['direction_used'], sig['sentiment_used'], current_price,
                 interval, 'pipeline', ml_dir, ml_conf_v, ml_agrees, ts))
            conn.commit(); conn.close()

            log.append(f'Signal: {sig["action"]} ({sig["confidence"]:.0%} conf)')
            result['prediction'] = {**combined, 'created_at': ts}
            result['signal']     = {**sig, 'created_at': ts, 'symbol': symbol}
        except Exception as e:
            log.append(f'Signal generation failed: {clean_error(e)}')

    log.append('Pipeline complete — all data saved to SQLite')
    return jsonify(result)


@app.route('/signal-history')
def signal_history():
    symbol = request.args.get('symbol','').upper()
    limit  = min(int(request.args.get('limit', 100)), 500)
    conn   = get_db()
    if symbol and valid_symbol(symbol):
        rows = conn.execute(
            'SELECT id,symbol,action,confidence,evidence_json,direction_used,sentiment_used,'
            'price_at_signal,price_at_eval,outcome,interval,source,created_at '
            'FROM signals WHERE symbol=? ORDER BY created_at DESC LIMIT ?',
            (symbol, limit)).fetchall()
    else:
        rows = conn.execute(
            'SELECT id,symbol,action,confidence,evidence_json,direction_used,sentiment_used,'
            'price_at_signal,price_at_eval,outcome,interval,source,created_at '
            'FROM signals ORDER BY created_at DESC LIMIT ?',
            (limit,)).fetchall()
    conn.close()
    signals = []
    for r in rows:
        d = dict(r)
        try:
            d['evidence'] = json.loads(d['evidence_json'] or '[]')
        except Exception:
            d['evidence'] = []
        signals.append(d)
    total   = len(signals)
    wins    = sum(1 for s in signals if s.get('outcome') == 'WIN')
    losses  = sum(1 for s in signals if s.get('outcome') == 'LOSS')
    pending = sum(1 for s in signals if s.get('outcome') is None and s.get('price_at_signal') is not None)
    wr      = round(wins / (wins + losses), 3) if (wins + losses) > 0 else None
    return jsonify({'signals': signals, 'total': total, 'wins': wins,
                    'losses': losses, 'pending': pending, 'win_rate': wr})


@app.route('/evaluate-outcomes', methods=['POST'])
def evaluate_outcomes():
    min_age = 3600
    cutoff  = int(time.time()) - min_age
    conn    = get_db()
    pending = conn.execute(
        'SELECT id,symbol,action,price_at_signal,created_at FROM signals '
        'WHERE outcome IS NULL AND price_at_signal IS NOT NULL AND created_at < ?',
        (cutoff,)).fetchall()
    evaluated = 0
    key     = os.getenv('BINANCE_API_KEY','')
    headers = {'X-MBX-APIKEY': key} if key else {}
    for row in pending:
        symbol = row['symbol']
        ticker = COIN_TICKERS.get(symbol, symbol + 'USDT')
        try:
            r       = requests.get(f'{BINANCE_BASE}/ticker/price',
                                   params={'symbol': ticker}, headers=headers, timeout=5)
            current = float(r.json()['price'])
            entry   = float(row['price_at_signal'])
            action  = row['action']
            pct     = (current - entry) / entry
            threshold = 0.003
            if action == 'BUY':
                outcome = 'WIN' if pct >= threshold else ('LOSS' if pct <= -threshold else 'NEUTRAL')
            elif action == 'SELL':
                outcome = 'WIN' if pct <= -threshold else ('LOSS' if pct >= threshold else 'NEUTRAL')
            else:
                outcome = 'NEUTRAL'
            conn.execute('UPDATE signals SET outcome=?, price_at_eval=? WHERE id=?',
                         (outcome, current, row['id']))
            evaluated += 1
        except Exception:
            pass
    conn.commit(); conn.close()
    return jsonify({'evaluated': evaluated})


@app.route('/backtest', methods=['POST'])
def backtest():
    body      = request.json or {}
    symbol    = body.get('symbol','BTC').upper()
    interval  = body.get('interval','1h')
    horizon_c = min(int(body.get('horizon_candles', 4)), 24)
    threshold = max(0.1, min(0.95, float(body.get('confidence_threshold', 0.55))))
    lookback  = min(int(body.get('lookback', 300)), 500)
    if not valid_symbol(symbol):
        return jsonify({'error':'Invalid symbol'}), 400
    if not valid_interval(interval):
        return jsonify({'error':'Invalid interval'}), 400
    ticker  = COIN_TICKERS.get(symbol, symbol + 'USDT')
    key     = os.getenv('BINANCE_API_KEY','')
    headers = {'X-MBX-APIKEY': key} if key else {}
    try:
        resp = requests.get(f'{BINANCE_BASE}/klines',
                            params={'symbol': ticker,'interval': interval,'limit': lookback},
                            headers=headers, timeout=30)
        raw  = resp.json()
        if isinstance(raw, dict) and raw.get('code'):
            return jsonify({'error': raw.get('msg','Binance error')}), 400
        candles = [{'time':c[0]//1000,'open':float(c[1]),'high':float(c[2]),
                    'low':float(c[3]),'close':float(c[4]),'volume':float(c[5])} for c in raw]
    except Exception as e:
        return jsonify({'error': clean_error(e)}), 503
    result = run_backtest_logic(candles, horizon_c, threshold)
    result['symbol']   = symbol
    result['interval'] = interval
    ts = int(time.time())
    conn = get_db()
    conn.execute('INSERT INTO backtest_runs (symbol,interval,horizon_candles,confidence_threshold,win_rate,total_signals,active_signals,avg_return,cumulative_return,sharpe,pnl_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                 (symbol, interval, horizon_c, threshold, result['win_rate'],
                  result['total_signals'], result['active_signals'],
                  result['avg_return'], result['cumulative_return'],
                  result['sharpe'], json.dumps(result['pnl_curve']), ts))
    conn.commit(); conn.close()
    return jsonify(result)


@app.route('/refresh', methods=['POST'])
def refresh():
    body     = request.json or {}
    symbol   = body.get('symbol','BTC').upper()
    interval = body.get('interval','1h')
    model    = sanitize_str(body.get('model','llama3.2'), max_len=100)
    if not valid_symbol(symbol):
        return jsonify({'error':'Invalid symbol'}), 400
    if not valid_interval(interval):
        return jsonify({'error':'Invalid interval'}), 400
    if not valid_model(model):
        return jsonify({'error':'Invalid model name'}), 400
    ticker  = COIN_TICKERS.get(symbol, symbol + 'USDT')
    log     = []
    result  = {'symbol': symbol,'log': log}
    key     = os.getenv('BINANCE_API_KEY','')
    headers = {'X-MBX-APIKEY': key} if key else {}
    try:
        r       = requests.get(f'{BINANCE_BASE}/klines',
                               params={'symbol': ticker,'interval': interval,'limit': 100},
                               headers=headers, timeout=10)
        candles = r.json()
        if isinstance(candles, list) and len(candles) > 0:
            conn = get_db()
            for c in candles[-10:]:
                conn.execute('INSERT INTO prices (symbol,interval,timestamp,close,volume) VALUES (?,?,?,?,?)',
                             (symbol, interval, int(c[0])//1000, float(c[4]), float(c[5])))
            conn.commit(); conn.close()
            log.append(f'Pulled {len(candles)} Binance candles for {ticker}')
            result['candles'] = len(candles)
        else:
            msg = candles.get('msg','unknown') if isinstance(candles, dict) else 'empty'
            log.append(f'Binance error: {msg}')
            candles = []
    except Exception as e:
        log.append(f'Binance fetch failed: {clean_error(e)}')
        candles = []
    posts = []
    try:
        posts = fetch_reddit(symbol)
        if posts:
            conn = get_db()
            for p in posts:
                conn.execute('INSERT INTO posts (symbol,subreddit,title,body,url,score,created_at) VALUES (?,?,?,?,?,?,?)',
                             (p['symbol'],p['subreddit'],p['title'],p['body'],
                              p['url'],p['score'],p['created_at']))
            conn.commit(); conn.close()
        subs = ', '.join([f"r/{s}" for s in COIN_SUBREDDITS.get(symbol,['CryptoCurrency'])])
        log.append(f'Pulled {len(posts)} Reddit posts from {subs}')
        result['post_count'] = len(posts)
        result['posts']      = posts
    except Exception as e:
        log.append(f'Reddit fetch failed: {clean_error(e)}')
    if posts:
        try:
            log.append(f'Sent {len(posts)} posts to Ollama model {model}')
            sentiment_data = run_sentiment(symbol, posts, model)
            conn = get_db()
            conn.execute('INSERT INTO sentiment (symbol,model,label,score,confidence,summary,created_at) VALUES (?,?,?,?,?,?,?)',
                         (symbol, model, sentiment_data['label'], sentiment_data['score'],
                          sentiment_data['confidence'], sentiment_data['summary'], int(time.time())))
            conn.commit(); conn.close()
            log.append(f"{symbol} sentiment: {sentiment_data['label']} ({sentiment_data['score']:.2f})")
            log.append('Saved price and sentiment snapshot to SQLite')
            result['sentiment'] = sentiment_data
        except Exception as e:
            log.append(f'Sentiment analysis failed: {clean_error(e)}')
    else:
        log.append('No relevant posts found, skipping sentiment analysis')
    return jsonify(result)


@app.route('/delete-model', methods=['POST'])
def delete_model():
    name = sanitize_str((request.json or {}).get('model',''), max_len=100)
    if not name or not valid_model(name):
        return jsonify({'error':'Invalid model name'}), 400
    try:
        resp = requests.delete(f'{OLLAMA_BASE}/api/delete', json={'name': name}, timeout=30)
        if resp.status_code in (200, 204):
            return jsonify({'success': True})
        return jsonify({'error': f'Ollama returned {resp.status_code}'}), 500
    except Exception as e:
        return jsonify({'error': clean_error(e)}), 500


@app.route('/load-model', methods=['POST'])
def load_model():
    name = sanitize_str((request.json or {}).get('model',''), max_len=100)
    if not name or not valid_model(name):
        return jsonify({'error':'Invalid model name'}), 400
    try:
        resp = requests.post(f'{OLLAMA_BASE}/api/generate',
                             json={'model': name,'keep_alive': -1}, timeout=60)
        return jsonify({'success': resp.status_code == 200})
    except Exception as e:
        return jsonify({'error': clean_error(e)}), 500


@app.route('/unload-model', methods=['POST'])
def unload_model():
    name = sanitize_str((request.json or {}).get('model',''), max_len=100)
    if not name or not valid_model(name):
        return jsonify({'error':'Invalid model name'}), 400
    try:
        resp = requests.post(f'{OLLAMA_BASE}/api/generate',
                             json={'model': name,'keep_alive': 0}, timeout=30)
        return jsonify({'success': resp.status_code == 200})
    except Exception as e:
        return jsonify({'error': clean_error(e)}), 500


if __name__ == '__main__':
    app.run(host='127.0.0.1', port=5000, debug=False, use_reloader=False)