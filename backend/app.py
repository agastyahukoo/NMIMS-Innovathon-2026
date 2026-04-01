from flask import Flask, request, jsonify
from flask_cors import CORS
import requests
import os
import re
import sqlite3
import json
import time
from dotenv import load_dotenv

ENV_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), '.env')
load_dotenv(ENV_PATH)

app = Flask(__name__)
CORS(app, origins=['http://localhost:5000', 'file://', 'null'])

BINANCE_BASE = 'https://api.binance.com/api/v3'
OLLAMA_BASE  = 'http://localhost:11434'
DB_PATH      = os.path.join(os.path.dirname(__file__), 'app.db')

ALLOWED_SYMBOLS = {'BTC', 'ETH', 'SOL', 'BNB', 'XRP'}
ALLOWED_INTERVALS = {'1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w'}

COIN_TICKERS = {
    'BTC': 'BTCUSDT', 'ETH': 'ETHUSDT', 'SOL': 'SOLUSDT',
    'BNB': 'BNBUSDT', 'XRP': 'XRPUSDT',
}

COIN_SUBREDDITS = {
    'BTC': ['Bitcoin', 'CryptoCurrency'],
    'ETH': ['ethereum', 'CryptoCurrency'],
    'SOL': ['solana', 'CryptoCurrency'],
    'BNB': ['binance', 'CryptoCurrency'],
    'XRP': ['XRP', 'CryptoCurrency'],
}

COIN_KEYWORDS = {
    'BTC': ['btc', 'bitcoin'],
    'ETH': ['eth', 'ethereum'],
    'SOL': ['sol', 'solana'],
    'BNB': ['bnb', 'binance coin'],
    'XRP': ['xrp', 'ripple'],
}

COIN_OWN_SUBS = {
    'BTC': 'bitcoin', 'ETH': 'ethereum', 'SOL': 'solana',
    'BNB': 'binance', 'XRP': 'xrp',
}

_MODEL_RE = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9._:\-]{0,99}$')


def sanitize_str(val, max_len=500):
    return str(val).replace('\n', '').replace('\r', '').replace('\0', '')[:max_len]


def valid_model(name):
    return bool(name and _MODEL_RE.match(name))


def valid_symbol(sym):
    return sym in ALLOWED_SYMBOLS


def valid_interval(iv):
    return iv in ALLOWED_INTERVALS


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()
    conn.executescript('''
        CREATE TABLE IF NOT EXISTS posts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol TEXT,
            subreddit TEXT,
            title TEXT,
            body TEXT,
            url TEXT,
            score INTEGER,
            created_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS sentiment (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol TEXT,
            model TEXT,
            label TEXT,
            score REAL,
            confidence REAL,
            summary TEXT,
            created_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS prices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol TEXT,
            interval TEXT,
            timestamp INTEGER,
            close REAL,
            volume REAL
        );
    ''')
    conn.commit()
    conn.close()


init_db()


def post_matches(title, body, symbol):
    text = (title + ' ' + body).lower()
    return any(kw in text for kw in COIN_KEYWORDS.get(symbol, [symbol.lower()]))


def fetch_reddit(symbol, limit=25):
    subreddits = COIN_SUBREDDITS.get(symbol, ['CryptoCurrency'])
    own_sub    = COIN_OWN_SUBS.get(symbol, '').lower()
    headers    = {'User-Agent': 'CryptoTerminal/2.0'}
    posts      = []
    seen       = set()

    for sub in subreddits:
        try:
            r = requests.get(
                f'https://www.reddit.com/r/{sub}/hot.json?limit={limit}',
                headers=headers, timeout=10
            )
            data = r.json()
            for item in data['data']['children']:
                p   = item['data']
                pid = p.get('id', '')
                if pid in seen:
                    continue
                title = p.get('title', '')
                body  = p.get('selftext', '')[:500]
                is_own_sub = sub.lower() == own_sub
                if is_own_sub or post_matches(title, body, symbol):
                    seen.add(pid)
                    posts.append({
                        'symbol':     symbol,
                        'subreddit':  sub,
                        'title':      title,
                        'body':       body,
                        'url':        'https://reddit.com' + p.get('permalink', ''),
                        'score':      p.get('score', 0),
                        'created_at': int(p.get('created_utc', time.time()))
                    })
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

    resp = requests.post(
        f'{OLLAMA_BASE}/api/chat',
        json={
            'model':    model,
            'messages': [{'role': 'user', 'content': prompt}],
            'stream':   False,
            'format':   'json'
        },
        timeout=120
    )
    raw    = resp.json().get('message', {}).get('content', '{}')
    result = json.loads(raw)

    result['label'] = str(result.get('label', 'NEUTRAL')).upper()
    if result['label'] not in ('BULLISH', 'BEARISH', 'NEUTRAL'):
        result['label'] = 'NEUTRAL'
    result['score']      = round(max(0.0, min(1.0, float(result.get('score', 0.5)))), 4)
    result['confidence'] = round(max(0.0, min(1.0, float(result.get('confidence', 0.5)))), 4)
    result['summary']    = str(result.get('summary', ''))[:300]
    result['symbol']     = symbol
    return result


@app.route('/health')
def health():
    return jsonify({'status': 'ok', 'version': '2.0.0'})


@app.route('/price')
def price():
    symbol   = request.args.get('symbol', 'BTCUSDT')
    interval = request.args.get('interval', '1h')
    limit    = min(int(request.args.get('limit', 150)), 500)

    if not valid_interval(interval):
        return jsonify({'error': 'Invalid interval'}), 400

    key     = os.getenv('BINANCE_API_KEY', '')
    headers = {'X-MBX-APIKEY': key} if key else {}
    try:
        resp = requests.get(
            f'{BINANCE_BASE}/klines',
            params={'symbol': symbol, 'interval': interval, 'limit': limit},
            headers=headers, timeout=10
        )
        raw = resp.json()
        if isinstance(raw, dict) and raw.get('code'):
            return jsonify({'error': raw.get('msg', 'Binance error')}), 400
        candles = [
            {'time': c[0]//1000, 'open': float(c[1]), 'high': float(c[2]),
             'low': float(c[3]), 'close': float(c[4]), 'volume': float(c[5])}
            for c in raw
        ]
        return jsonify({'candles': candles})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/insight')
def insight():
    symbol   = request.args.get('symbol', 'BTCUSDT')
    interval = request.args.get('interval', '1h')

    if not valid_interval(interval):
        return jsonify({'error': 'Invalid interval'}), 400

    key     = os.getenv('BINANCE_API_KEY', '')
    headers = {'X-MBX-APIKEY': key} if key else {}
    try:
        r1     = requests.get(f'{BINANCE_BASE}/klines',
                              params={'symbol': symbol, 'interval': interval, 'limit': 20},
                              headers=headers, timeout=10)
        data   = r1.json()
        closes = [float(c[4]) for c in data]
        current       = closes[-1]
        sma5          = sum(closes[-5:]) / 5
        sma20         = sum(closes) / 20
        recent_change = ((closes[-1] - closes[-5]) / closes[-5]) * 100

        if sma5 > sma20 and recent_change > 0:
            direction  = 'UP'
            confidence = 'Medium' if abs(recent_change) > 1 else 'Low'
            reason     = f'Price above 20-candle MA. +{recent_change:.2f}% in last 5 candles.'
        elif sma5 < sma20 and recent_change < 0:
            direction  = 'DOWN'
            confidence = 'Medium' if abs(recent_change) > 1 else 'Low'
            reason     = f'Price below 20-candle MA. {recent_change:.2f}% in last 5 candles.'
        else:
            direction  = 'NEUTRAL'
            confidence = 'Low'
            reason     = 'Mixed signals — no strong directional bias detected.'

        r2 = requests.get(f'{BINANCE_BASE}/ticker/24hr',
                          params={'symbol': symbol}, headers=headers, timeout=10)
        t  = r2.json()

        return jsonify({
            'symbol':       symbol,
            'current_price': current,
            'change_24h':   float(t.get('priceChangePercent', 0)),
            'high_24h':     float(t.get('highPrice', 0)),
            'low_24h':      float(t.get('lowPrice', 0)),
            'volume_24h':   float(t.get('volume', 0)),
            'direction':    direction,
            'confidence':   confidence,
            'reason':       reason,
            'sma5':         round(sma5, 4),
            'sma20':        round(sma20, 4)
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/chat', methods=['POST'])
def chat():
    body      = request.json or {}
    message   = sanitize_str(body.get('message', ''), max_len=1000)
    model     = sanitize_str(body.get('model', 'llama3.2'), max_len=100)
    symbol    = body.get('symbol', 'BTC').upper()
    timeframe = body.get('timeframe', '1h')
    price_ctx = sanitize_str(body.get('price_context', ''), max_len=2000)
    history   = body.get('history', [])

    if not message:
        return jsonify({'reply': 'Empty message.'}), 400
    if not valid_model(model):
        return jsonify({'reply': 'Invalid model name.'}), 400

    symbol    = symbol if valid_symbol(symbol) else 'BTC'
    timeframe = timeframe if valid_interval(timeframe) else '1h'

    system = (
        f'You are a crypto market analysis assistant built into an educational terminal.\n'
        f'Currently analyzing: {symbol} | Timeframe: {timeframe}\n'
        f'{price_ctx}\n'
        f'Rules: This is an educational simulation only. Never give real financial advice. '
        f'Be concise, analytical, and insightful.'
    )

    messages = [{'role': 'system', 'content': system}]
    for h in history[-10:]:
        if isinstance(h, dict) and h.get('role') in ('user', 'assistant'):
            messages.append({'role': h['role'], 'content': sanitize_str(h.get('content', ''), 500)})
    messages.append({'role': 'user', 'content': message})

    try:
        resp = requests.post(
            f'{OLLAMA_BASE}/api/chat',
            json={'model': model, 'messages': messages, 'stream': False},
            timeout=120
        )
        data = resp.json()
        return jsonify({'reply': data.get('message', {}).get('content', 'No response from model.')})
    except Exception as e:
        return jsonify({'reply': 'Cannot reach Ollama. Make sure it is running.', 'error': str(e)}), 500


@app.route('/models')
def models():
    try:
        resp = requests.get(f'{OLLAMA_BASE}/api/tags', timeout=10)
        return jsonify({'models': [m['name'] for m in resp.json().get('models', [])]})
    except Exception as e:
        return jsonify({'models': [], 'error': str(e)})


@app.route('/pull-model', methods=['POST'])
def pull_model():
    name = sanitize_str((request.json or {}).get('model', ''), max_len=100)
    if not name:
        return jsonify({'error': 'No model name provided'}), 400
    if not valid_model(name):
        return jsonify({'error': 'Invalid model name'}), 400
    try:
        requests.post(f'{OLLAMA_BASE}/api/pull',
                      json={'name': name, 'stream': False}, timeout=600)
        return jsonify({'success': True, 'model': name})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


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
    return jsonify({
        'binance_api_key': os.getenv('BINANCE_API_KEY', ''),
        'setup_complete':  os.getenv('SETUP_COMPLETE', 'false') == 'true'
    })


@app.route('/reddit')
def reddit():
    symbol = request.args.get('symbol', 'BTC').upper()
    if not valid_symbol(symbol):
        return jsonify({'error': 'Invalid symbol'}), 400

    posts = fetch_reddit(symbol)
    conn  = get_db()
    for p in posts:
        conn.execute(
            'INSERT INTO posts (symbol,subreddit,title,body,url,score,created_at) VALUES (?,?,?,?,?,?,?)',
            (p['symbol'], p['subreddit'], p['title'], p['body'], p['url'], p['score'], p['created_at'])
        )
    conn.commit()
    conn.close()
    return jsonify({'posts': posts, 'count': len(posts)})


@app.route('/sentiment', methods=['POST'])
def sentiment():
    body   = request.json or {}
    symbol = body.get('symbol', 'BTC').upper()
    model  = sanitize_str(body.get('model', 'llama3.2'), max_len=100)
    posts  = body.get('posts', [])

    if not valid_symbol(symbol):
        return jsonify({'error': 'Invalid symbol'}), 400
    if not valid_model(model):
        return jsonify({'error': 'Invalid model name'}), 400
    if not posts:
        return jsonify({'error': 'No posts provided'}), 400

    try:
        result = run_sentiment(symbol, posts, model)
        conn   = get_db()
        conn.execute(
            'INSERT INTO sentiment (symbol,model,label,score,confidence,summary,created_at) VALUES (?,?,?,?,?,?,?)',
            (symbol, model, result['label'], result['score'],
             result['confidence'], result['summary'], int(time.time()))
        )
        conn.commit()
        conn.close()
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/refresh', methods=['POST'])
def refresh():
    body     = request.json or {}
    symbol   = body.get('symbol', 'BTC').upper()
    interval = body.get('interval', '1h')
    model    = sanitize_str(body.get('model', 'llama3.2'), max_len=100)

    if not valid_symbol(symbol):
        return jsonify({'error': 'Invalid symbol'}), 400
    if not valid_interval(interval):
        return jsonify({'error': 'Invalid interval'}), 400
    if not valid_model(model):
        return jsonify({'error': 'Invalid model name'}), 400

    ticker = COIN_TICKERS.get(symbol, symbol + 'USDT')
    log    = []
    result = {'symbol': symbol, 'log': log}

    key     = os.getenv('BINANCE_API_KEY', '')
    headers = {'X-MBX-APIKEY': key} if key else {}

    try:
        r       = requests.get(f'{BINANCE_BASE}/klines',
                               params={'symbol': ticker, 'interval': interval, 'limit': 100},
                               headers=headers, timeout=10)
        candles = r.json()
        if isinstance(candles, list) and len(candles) > 0:
            conn = get_db()
            for c in candles[-10:]:
                conn.execute(
                    'INSERT INTO prices (symbol,interval,timestamp,close,volume) VALUES (?,?,?,?,?)',
                    (symbol, interval, int(c[0])//1000, float(c[4]), float(c[5]))
                )
            conn.commit()
            conn.close()
            log.append(f'Pulled {len(candles)} Binance candles for {ticker}')
            result['candles'] = len(candles)
        else:
            msg = candles.get('msg', 'unknown error') if isinstance(candles, dict) else 'empty response'
            log.append(f'Binance error: {msg}')
    except Exception as e:
        log.append(f'Binance fetch failed: {str(e)}')

    posts = []
    try:
        posts = fetch_reddit(symbol)
        if posts:
            conn = get_db()
            for p in posts:
                conn.execute(
                    'INSERT INTO posts (symbol,subreddit,title,body,url,score,created_at) VALUES (?,?,?,?,?,?,?)',
                    (p['symbol'], p['subreddit'], p['title'], p['body'],
                     p['url'], p['score'], p['created_at'])
                )
            conn.commit()
            conn.close()
        subs = ', '.join([f"r/{s}" for s in COIN_SUBREDDITS.get(symbol, ['CryptoCurrency'])])
        log.append(f'Pulled {len(posts)} Reddit posts from {subs}')
        result['post_count'] = len(posts)
        result['posts']      = posts
    except Exception as e:
        log.append(f'Reddit fetch failed: {str(e)}')

    if posts:
        try:
            log.append(f'Sent {len(posts)} posts to Ollama model {model}')
            sentiment_data = run_sentiment(symbol, posts, model)
            conn           = get_db()
            conn.execute(
                'INSERT INTO sentiment (symbol,model,label,score,confidence,summary,created_at) VALUES (?,?,?,?,?,?,?)',
                (symbol, model, sentiment_data['label'], sentiment_data['score'],
                 sentiment_data['confidence'], sentiment_data['summary'], int(time.time()))
            )
            conn.commit()
            conn.close()
            log.append(f"{symbol} sentiment: {sentiment_data['label']} ({sentiment_data['score']:.2f})")
            log.append('Saved price and sentiment snapshot to SQLite')
            result['sentiment'] = sentiment_data
        except Exception as e:
            log.append(f'Sentiment analysis failed: {str(e)}')
    else:
        log.append('No relevant posts found, skipping sentiment analysis')

    return jsonify(result)


if __name__ == '__main__':
    app.run(host='127.0.0.1', port=5000, debug=False, use_reloader=False)