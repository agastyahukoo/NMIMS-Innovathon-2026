const API = 'http://localhost:5000'
const eAPI = window.electronAPI || null

let COINS = [
    { symbol: 'BTC', name: 'Bitcoin',  ticker: 'BTCUSDT', subreddits: ['Bitcoin','CryptoCurrency'] },
    { symbol: 'ETH', name: 'Ethereum', ticker: 'ETHUSDT', subreddits: ['ethereum','CryptoCurrency'] },
    { symbol: 'SOL', name: 'Solana',   ticker: 'SOLUSDT', subreddits: ['solana','CryptoCurrency'] },
    { symbol: 'BNB', name: 'BNB',      ticker: 'BNBUSDT', subreddits: ['binance','CryptoCurrency'] },
    { symbol: 'XRP', name: 'XRP',      ticker: 'XRPUSDT', subreddits: ['XRP','CryptoCurrency'] },
]

const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d']

let activeCoin        = COINS[0]
let activeInterval    = '1h'
let activeModel       = ''
let chatHistory       = []
let chart             = null
let candleSeries      = null
let volumeSeries      = null
let priceContext      = ''
let isChatLoading     = false
let terminalVisible   = false
let terminalLog       = []
let pipelineRunning   = false
let phVisible         = false
let phActiveFilter    = 'all'
let phAllForecasts    = []

let chartTimer    = null
let insightTimer  = null
let pipelineTimer = null
let forecastTimer = null

const notifSettings = {
    enabled:    true,
    onlyBuy:    false,
    onlySell:   false,
    threshold:  0.55,
    cooldownMs: 5 * 60 * 1000,
    lastNotif:  {}
}

const $ = (id) => document.getElementById(id)

function ts() { return new Date().toTimeString().slice(0,5) }

function addLog(msg, type) {
    const cls = type || classifyLog(msg)
    terminalLog.push({ msg: `[${ts()}] ${msg}`, cls })
    if (terminalLog.length > 300) terminalLog.shift()
    if (terminalVisible) renderTerminal()
}

function classifyLog(msg) {
    const m = msg.toLowerCase()
    if (m.includes('failed') || m.includes('error')) return 'error'
    if (m.includes('sentiment:') || m.includes('bullish') || m.includes('bearish') || m.includes('neutral')) return 'sentiment'
    if (m.includes('saved') || m.includes('fetched') || m.includes('pulled') || m.includes('ready') || m.includes('success') || m.includes('complete')) return 'success'
    return 'info'
}

function renderTerminal() {
    const el = $('terminalOutput')
    if (!el) return
    el.innerHTML = terminalLog.map(e => `<div class="term-line ${e.cls}">${escapeHtml(e.msg)}</div>`).join('')
    el.scrollTop = el.scrollHeight
}

function toggleTerminal() {
    terminalVisible = !terminalVisible
    const panel = $('terminalPanel')
    const btn   = $('termToggleBtn')
    if (terminalVisible) {
        panel.classList.remove('hidden')
        btn.classList.add('active')
        renderTerminal()
    } else {
        panel.classList.add('hidden')
        btn.classList.remove('active')
    }
}

async function init() {
    if (eAPI) {
        const saved = await eAPI.getCoins().catch(() => null)
        if (saved && saved.length) COINS = saved
    }

    // Restore scrollbar preference
    if (localStorage.getItem('scrollbarsHidden') === 'true') {
        document.body.classList.add('scrollbars-hidden')
    }

    const ready = await waitForBackend()
    if (!ready) {
        $('connLabel').textContent = 'Offline'
        $('connDot').className = 'conn-dot offline'
        addLog('Backend unreachable', 'error')
        return
    }

    $('connDot').className = 'conn-dot online'
    $('connLabel').textContent = 'Online'
    addLog('Backend ready', 'success')

    initChart()
    setupCoinList()
    setupTimeframes()
    await loadModels()
    await checkSettings()
    await loadCoinData()
    startAutoRefresh()
    checkOllama()
    setupIPCListeners()

    $('refreshBtn').addEventListener('click', handleRefresh)
    $('settingsBtn').addEventListener('click', openSettings)
    $('clearChatBtn').addEventListener('click', clearChat)
    $('manageModelsBtn').addEventListener('click', openSettings)
    $('termToggleBtn').addEventListener('click', toggleTerminal)
    const analyticsBtn = $('analyticsBtn')
    if (analyticsBtn) analyticsBtn.addEventListener('click', () => { if (eAPI) eAPI.openAnalytics() })
    $('termClearBtn').addEventListener('click', () => { terminalLog = []; renderTerminal() })
    $('chatInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) sendChat() })
    $('sendBtn').addEventListener('click', sendChat)
    $('chartRetryBtn').addEventListener('click', loadCoinData)

    // Price history panel
    const phBtn = $('phBtn')
    if (phBtn) phBtn.addEventListener('click', togglePriceHistory)
    const phToggleBtn = $('phToggleBtn')
    if (phToggleBtn) phToggleBtn.addEventListener('click', togglePriceHistory)
    const phCloseBtn = $('phCloseBtn')
    if (phCloseBtn) phCloseBtn.addEventListener('click', togglePriceHistory)

    // ph horizon filters
    document.querySelectorAll('.ph-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.ph-filter-btn').forEach(b => b.classList.remove('active'))
            btn.classList.add('active')
            phActiveFilter = btn.dataset.h
            renderPhTable(phAllForecasts)
        })
    })

    document.querySelectorAll('.chip').forEach(btn => {
        btn.addEventListener('click', () => { $('chatInput').value = btn.dataset.msg; sendChat() })
    })

    document.addEventListener('keydown', e => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
        if (e.key === '`' || e.key === '~') {
            e.preventDefault()
            toggleTerminal()
        }
        if (e.key === 'p' || e.key === 'P') {
            if (!e.ctrlKey && !e.metaKey) {
                e.preventDefault()
                togglePriceHistory()
            }
        }
    })
}

function setupIPCListeners() {
    if (!eAPI) return

    eAPI.onSetCoin(coin => {
        const found = COINS.find(c => c.symbol === coin.symbol) || coin
        switchCoin(found)
    })

    eAPI.onSetModel(name => {
        activeModel = name
        const sel = $('modelSelect')
        if (sel) sel.value = name
        addLog(`Model switched to ${name}`, 'success')
    })

    eAPI.onTriggerRefresh(() => handleRefresh())
    eAPI.onToggleTerminal(() => toggleTerminal())
    eAPI.onShowAbout(() => showAboutModal())
    eAPI.onOpenCustomMarket(() => openCustomMarketModal())
    eAPI.onOpenMarketManager(() => openMarketManagerModal())
    eAPI.onOpenModelDownload(() => openSettings())
    eAPI.onOpenModelDelete(() => openModelDeleteModal())

    eAPI.onModelLoad(async name => {
        addLog(`Loading ${name} into RAM…`)
        try {
            const r = await fetch(`${API}/load-model`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: name })
            })
            const d = await r.json()
            addLog(d.success ? `${name} loaded into RAM` : `Load failed: ${d.error}`, d.success ? 'success' : 'error')
        } catch (e) { addLog(`Load error: ${e.message}`, 'error') }
    })

    eAPI.onModelUnload(async name => {
        addLog(`Unloading ${name} from RAM…`)
        try {
            const r = await fetch(`${API}/unload-model`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: name })
            })
            const d = await r.json()
            addLog(d.success ? `${name} unloaded from RAM` : `Unload failed: ${d.error}`, d.success ? 'success' : 'error')
        } catch (e) { addLog(`Unload error: ${e.message}`, 'error') }
    })
}

async function waitForBackend() {
    for (let i = 0; i < 6; i++) {
        try {
            const r = await fetch(`${API}/health`)
            if (r.ok) return true
        } catch {}
        await sleep(400)
    }
    return false
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function isOffline(e) {
    const msg = (e && e.message) ? e.message.toLowerCase() : ''
    return msg.includes('no internet') || msg.includes('failed to fetch') ||
           msg.includes('networkerror') || msg.includes('network request failed') ||
           msg.includes('cannot reach server') || msg.includes('connection')
}

async function checkSettings() {
    try {
        const r = await fetch(`${API}/get-settings`)
        const d = await r.json()
        if (!d.setup_complete) openSetupModal()
    } catch {}
}

async function loadModels() {
    try {
        const r      = await fetch(`${API}/models`)
        const data   = await r.json()
        const models = data.models || []

        const select      = $('modelSelect')
        const setupSelect = $('setupModelSelect')

        select.innerHTML = models.length
            ? models.map(m => `<option value="${m}">${m}</option>`).join('')
            : '<option value="">No models found</option>'

        if (setupSelect) {
            setupSelect.innerHTML = models.length
                ? models.map(m => `<option value="${m}">${m}</option>`).join('')
                : '<option value="">No models found</option>'
        }

        if (models.length > 0) {
            activeModel = models[0]
            select.value = activeModel
            if (eAPI) eAPI.setActiveModel(activeModel)
        }

        select.addEventListener('change', () => {
            activeModel = select.value
            if (eAPI) eAPI.setActiveModel(activeModel)
            if (eAPI) eAPI.refreshMenu()
        })
        renderSettingsModelList(models)
    } catch {}
}

function renderSettingsModelList(models) {
    const el = $('settingsModelList')
    if (!el) return
    if (!models.length) {
        el.innerHTML = '<div style="font-size:10px;color:var(--text-3);padding:8px">No models installed</div>'
        return
    }
    el.innerHTML = models.map(m => `
        <div class="model-item">
            <span>${escapeHtml(m)}</span>
            ${m === activeModel ? '<span class="model-active-tag">ACTIVE</span>' : ''}
        </div>
    `).join('')
}

function setupCoinList() {
    const list = $('coinList')
    list.innerHTML = COINS.map(c => `
        <button class="coin-btn ${c.symbol === activeCoin.symbol ? 'active' : ''}" data-symbol="${c.symbol}">
            <span class="coin-sym">${escapeHtml(c.symbol)}</span>
            <span class="coin-nm">${escapeHtml(c.name)}</span>
        </button>
    `).join('')

    list.querySelectorAll('.coin-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const coin = COINS.find(c => c.symbol === btn.dataset.symbol)
            if (coin && coin.symbol !== activeCoin.symbol) switchCoin(coin)
        })
    })
}

function switchCoin(coin) {
    activeCoin = coin
    if (eAPI) eAPI.setActiveCoin(coin.symbol)
    document.querySelectorAll('.coin-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.symbol === coin.symbol)
    })
    chatHistory = []
    clearChat()
    loadCoinData()
}

function setupTimeframes() {
    const grid = $('timeframeGrid')
    grid.innerHTML = INTERVALS.map(iv => `
        <button class="tf-btn ${iv === activeInterval ? 'active' : ''}" data-interval="${iv}">${iv.toUpperCase()}</button>
    `).join('')

    grid.querySelectorAll('.tf-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            activeInterval = btn.dataset.interval
            grid.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'))
            btn.classList.add('active')
            const tag = $('chartIntervalTag')
            if (tag) tag.textContent = activeInterval.toUpperCase()
            loadCoinData()
        })
    })
}

function initChart() {
    const container = $('chartContainer')
    chart = LightweightCharts.createChart(container, {
        layout: { background: { color: 'transparent' }, textColor: '#5a7fa0' },
        grid: { vertLines: { color: 'rgba(25,38,56,0.8)' }, horzLines: { color: 'rgba(25,38,56,0.8)' } },
        crosshair: {
            mode: LightweightCharts.CrosshairMode.Normal,
            vertLine: { color: 'rgba(0,212,255,0.3)', labelBackgroundColor: '#0b1220' },
            horzLine: { color: 'rgba(0,212,255,0.3)', labelBackgroundColor: '#0b1220' }
        },
        rightPriceScale: { borderColor: '#192638' },
        timeScale: { borderColor: '#192638', timeVisible: true, secondsVisible: false },
        width: container.clientWidth,
        height: container.clientHeight
    })

    candleSeries = chart.addCandlestickSeries({
        upColor: '#00e87a', downColor: '#ff3355',
        borderUpColor: '#00e87a', borderDownColor: '#ff3355',
        wickUpColor: '#00e87a', wickDownColor: '#ff3355'
    })

    volumeSeries = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol' })
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })

    new ResizeObserver(() => {
        chart.applyOptions({ width: container.clientWidth, height: container.clientHeight })
    }).observe(container)
}

async function loadCoinData() {
    $('chartSymbol').textContent = `${activeCoin.symbol}/USDT`
    const tag = $('chartIntervalTag')
    if (tag) tag.textContent = activeInterval.toUpperCase()
    showChartLoading()
    addLog(`Selected symbol: ${activeCoin.symbol}`)
    await Promise.all([loadChart(), loadInsight()])
    loadForecast()
    loadMultiForecast()
    runPipeline()
}

async function loadChart() {
    try {
        const r = await fetch(`${API}/price?symbol=${activeCoin.ticker}&interval=${activeInterval}&limit=200`)
        const data = await r.json()
        if (data.error) throw new Error(data.error)
        const candles = data.candles
        candleSeries.setData(candles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })))
        volumeSeries.setData(candles.map(c => ({
            time: c.time, value: c.volume,
            color: c.close >= c.open ? 'rgba(0,232,122,0.25)' : 'rgba(255,51,85,0.25)'
        })))
        chart.timeScale().fitContent()
        const latest = candles[candles.length - 1]
        const change = ((latest.close - candles[0].close) / candles[0].close) * 100
        $('chartCurrentPrice').textContent = formatPrice(latest.close)
        const changeEl = $('chartPriceChange')
        changeEl.textContent = (change >= 0 ? '+' : '') + change.toFixed(2) + '%'
        changeEl.className = 'chart-delta ' + (change >= 0 ? 'up' : 'down')
        hideChartLoading(); hideChartError()
    } catch (e) {
        hideChartLoading()
        const msg = isOffline(e) ? 'No internet connection' : 'Failed to load chart'
        showChartError(msg)
        addLog(`Chart: ${msg}`, 'error')
    }
}

async function loadInsight() {
    try {
        const r = await fetch(`${API}/insight?symbol=${activeCoin.ticker}&interval=${activeInterval}`)
        const data = await r.json()
        if (data.error) throw new Error(data.error)
        renderInsight(data)
        priceContext = `Current price: $${formatPrice(data.current_price)}
24h change: ${data.change_24h > 0 ? '+' : ''}${data.change_24h.toFixed(2)}%
24h high: $${formatPrice(data.high_24h)} | 24h low: $${formatPrice(data.low_24h)}
SMA5: ${data.sma5} | SMA20: ${data.sma20}
Direction signal: ${data.direction} (Confidence: ${data.confidence})`
        $('insightUpdated').textContent = new Date().toLocaleTimeString()
    } catch (e) {
        const msg = isOffline(e) ? 'No internet connection' : 'Market data unavailable'
        $('insightBody').innerHTML = `
            <div class="offline-state">
                <div class="offline-icon">⚡</div>
                <div class="offline-label">${msg}</div>
                <div class="offline-sub">Data will refresh when connection is restored</div>
            </div>`
        addLog(`Insight: ${msg}`, 'error')
    }
}

async function loadForecast() {
    try {
        const r = await fetch(`${API}/forecast`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ symbol: activeCoin.symbol, interval: activeInterval, horizon: activeInterval })
        })
        const data = await r.json()
        if (data.error) throw new Error(data.error)
        renderForecast(data)
        $('predictUpdated').textContent = new Date().toLocaleTimeString()
        priceContext += `\nForecast: ${data.prediction.direction} (${(data.prediction.confidence * 100).toFixed(0)}% confidence)\nSignal: ${data.signal.action} (${(data.signal.confidence * 100).toFixed(0)}% confidence)\nEvidence: ${data.signal.evidence.join('; ')}`
    } catch (e) {
        const msg = isOffline(e) ? 'No internet connection' : 'Forecast unavailable'
        const el  = $('predictBody')
        if (el) el.innerHTML = `<div class="offline-state"><div class="offline-icon">⬡</div><div class="offline-label">${msg}</div></div>`
        addLog(`Forecast: ${msg}`, 'error')
    }
}

async function runPipeline() {
    if (pipelineRunning) {
        addLog('Pipeline already running, skipping', 'info')
        return
    }
    if (!activeModel) {
        const sentEl = $('sentimentBody')
        if (sentEl) sentEl.innerHTML = '<div class="sent-placeholder"><span class="sm-dot"></span><span>No model — sentiment unavailable</span></div>'
        addLog('Pipeline skipped — no model loaded', 'error')
        return
    }

    pipelineRunning = true
    const sentEl = $('sentimentBody')
    if (sentEl) sentEl.innerHTML = '<div class="sent-loading"><div class="spin spin--sm"></div><span>Pipeline running — fetching Reddit &amp; sentiment…</span></div>'
    addLog(`Starting unified pipeline for ${activeCoin.symbol}`)

    const coin     = activeCoin
    const interval = activeInterval
    const model    = activeModel

    try {
        const r = await fetch(`${API}/pipeline`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol: coin.symbol, interval, model })
        })
        const data = await r.json()

        if (data.log) data.log.forEach(l => addLog(l))

        if (data.sentiment) {
            renderSentiment(data.sentiment)
            priceContext += `\nReddit sentiment: ${data.sentiment.label} (score: ${data.sentiment.score.toFixed(2)})\nSummary: ${data.sentiment.summary}`
        } else {
            if (sentEl) sentEl.innerHTML = '<div class="sent-placeholder"><span class="sm-dot"></span><span>Sentiment unavailable</span></div>'
        }

        if (data.prediction && data.signal) {
            renderForecast({ prediction: data.prediction, signal: data.signal })
            $('predictUpdated').textContent = new Date().toLocaleTimeString()

            const sig = data.signal
            const now = Date.now()
            const key = coin.symbol + sig.action
            if (eAPI && notifSettings.enabled &&
                (sig.action === 'BUY' || sig.action === 'SELL') &&
                sig.confidence >= notifSettings.threshold &&
                (!notifSettings.onlyBuy  || sig.action === 'BUY')  &&
                (!notifSettings.onlySell || sig.action === 'SELL') &&
                (now - (notifSettings.lastNotif[key] || 0)) > notifSettings.cooldownMs) {
                notifSettings.lastNotif[key] = now
                eAPI.showNotification(
                    `${coin.symbol} → ${sig.action}`,
                    `${(sig.confidence * 100).toFixed(0)}% confidence · ${(sig.evidence || [])[0] || ''}`
                )
            }
        }

        fetch(`${API}/evaluate-outcomes`, { method: 'POST' }).catch(() => {})

    } catch (e) {
        addLog(`Pipeline failed: ${e.message}`, 'error')
        if (sentEl) sentEl.innerHTML = '<div class="sent-placeholder"><span class="sm-dot offline"></span><span>Pipeline failed</span></div>'
    } finally {
        pipelineRunning = false
    }
}

function renderInsight(data) {
    const dir      = data.direction.toLowerCase()
    const chgClass = data.change_24h >= 0 ? 'up' : 'down'
    $('insightBody').innerHTML = `
        <div class="insight-dir-row">
            <div class="dir-label ${dir}"><span class="dir-dot"></span>${data.direction}</div>
            <span class="conf-badge">${data.confidence}</span>
        </div>
        <div class="insight-price-row">
            <span class="insight-price">${formatPrice(data.current_price)}</span>
            <span class="insight-chg ${chgClass}">${data.change_24h >= 0 ? '+' : ''}${data.change_24h.toFixed(2)}%</span>
        </div>
        <div class="stat-grid">
            <div class="stat"><div class="stat-k">24H High</div><div class="stat-v">${formatPrice(data.high_24h)}</div></div>
            <div class="stat"><div class="stat-k">24H Low</div><div class="stat-v">${formatPrice(data.low_24h)}</div></div>
            <div class="stat"><div class="stat-k">SMA 5</div><div class="stat-v">${formatPrice(data.sma5)}</div></div>
            <div class="stat"><div class="stat-k">SMA 20</div><div class="stat-v">${formatPrice(data.sma20)}</div></div>
        </div>
        <div class="insight-reason">${escapeHtml(data.reason)}</div>
    `
}

function renderSentiment(data) {
    const el = $('sentimentBody')
    if (!el) return
    const label    = data.label.toLowerCase()
    const scoreVal = Math.round(data.score * 100)
    const confVal  = Math.round(data.confidence * 100)
    el.innerHTML = `
        <div class="sent-row-label">Reddit Sentiment</div>
        <div class="sent-header">
            <span class="sent-label ${label}">${data.label}</span>
            <span class="conf-badge">${confVal}% conf</span>
        </div>
        <div class="sent-bar-row">
            <div class="sent-bar"><div class="sent-fill ${label}" style="width:${scoreVal}%"></div></div>
            <span class="sent-score">${scoreVal}%</span>
        </div>
        <div class="sent-summary">${escapeHtml(data.summary)}</div>
    `
}

function renderForecast(data) {
    const pred = data.prediction
    const sig  = data.signal
    const ml   = data.ml_prediction || null
    const el   = $('predictBody')
    if (!el) return

    const dirClass = pred.direction === 'UP' ? 'up' : pred.direction === 'DOWN' ? 'down' : 'sideways'
    const dirArrow = pred.direction === 'UP' ? '\u2191' : pred.direction === 'DOWN' ? '\u2193' : '\u2192'
    const sigClass = sig.action.toLowerCase()
    const featHTML = pred.features.slice(0, 3).map(f => `<div class="predict-feature">\xb7 ${escapeHtml(f)}</div>`).join('')
    const evHTML   = sig.evidence.slice(2).map(e => `<div class="predict-feature">\xb7 ${escapeHtml(e)}</div>`).join('')

    let mlHTML = ''
    if (ml) {
        const mlClass    = ml.direction === 'UP' ? 'up' : ml.direction === 'DOWN' ? 'down' : 'sideways'
        const mlArrow    = ml.direction === 'UP' ? '\u2191' : ml.direction === 'DOWN' ? '\u2193' : '\u2192'
        const mlAgrees   = ml.direction === pred.direction
        const mlChg      = ml.pct_change >= 0 ? `+${ml.pct_change}%` : `${ml.pct_change}%`
        const agreeClass = mlAgrees ? 'ml-agree' : 'ml-conflict'
        const agreeText  = mlAgrees ? 'confirms' : 'conflicts'
        const targetFmt  = ml.predicted_price >= 1000
            ? ml.predicted_price.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})
            : ml.predicted_price.toFixed(4)
        const lowerFmt   = ml.pred_lower >= 1000
            ? ml.pred_lower.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})
            : ml.pred_lower.toFixed(4)
        const upperFmt   = ml.pred_upper >= 1000
            ? ml.pred_upper.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})
            : ml.pred_upper.toFixed(4)
        mlHTML = `
        <div class="predict-divider"></div>
        <div class="ml-section">
            <div class="ml-header">
                <span class="ml-badge">ML \xb7 Prophet</span>
                <span class="ml-agree-tag ${agreeClass}">${agreeText} technical</span>
            </div>
            <div class="ml-body-row">
                <span class="predict-dir ${mlClass}" style="font-size:12px">${mlArrow} ${ml.direction} <span class="predict-conf">${(ml.confidence * 100).toFixed(0)}%</span></span>
                <div class="ml-price-block">
                    <span class="ml-target">$${targetFmt}</span>
                    <span class="ml-chg ${ml.pct_change >= 0 ? 'up' : 'down'}">${mlChg}</span>
                </div>
            </div>
            <div class="ml-bounds">80% CI: $${lowerFmt} \u2013 $${upperFmt}</div>
        </div>`
    }

    el.innerHTML = `
        <div class="predict-row">
            <div>
                <div class="predict-dir ${dirClass}">${dirArrow} ${pred.direction} <span class="predict-conf">${(pred.confidence * 100).toFixed(0)}%</span></div>
                <div class="predict-horizon">Next ${pred.horizon} forecast</div>
            </div>
            <div class="signal-badge">
                <span class="signal-action ${sigClass}">${sig.action}</span>
                <span class="signal-conf">${(sig.confidence * 100).toFixed(0)}% confidence</span>
            </div>
        </div>
        <div class="predict-divider"></div>
        <div class="predict-features">${featHTML}</div>
        ${evHTML ? `<div class="predict-evidence">${evHTML}</div>` : ''}
        ${mlHTML}
    `
}

async function sendChat() {
    if (isChatLoading) return
    const input   = $('chatInput')
    const message = input.value.trim()
    if (!message) return
    if (!activeModel) {
        addMessage('assistant', 'No model selected. Please install and select a model.')
        return
    }
    input.value = ''
    hideChatEmpty()
    addMessage('user', message)
    chatHistory.push({ role: 'user', content: message })
    isChatLoading = true
    $('sendBtn').disabled = true
    const thinkingId = addThinking()
    try {
        const r = await fetch(`${API}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message,
                model:         activeModel,
                symbol:        activeCoin.symbol,
                timeframe:     activeInterval,
                price_context: priceContext,
                history:       chatHistory.slice(-10)
            })
        })
        const data = await r.json()
        removeThinking(thinkingId)
        const reply = data.reply || 'No response.'
        addMessage('assistant', reply)
        chatHistory.push({ role: 'assistant', content: reply })
    } catch (e) {
        removeThinking(thinkingId)
        addMessage('assistant', `Error: ${e.message}`)
    } finally {
        isChatLoading = false
        $('sendBtn').disabled = false
    }
}

function hideChatEmpty() {
    const el = $('chatEmpty')
    if (el) el.style.display = 'none'
}

function addMessage(role, content) {
    const msgs = $('chatMessages')
    const div  = document.createElement('div')
    div.className = `message ${role}`
    div.innerHTML = `<div class="msg-bubble">${escapeHtml(content)}</div>`
    msgs.appendChild(div)
    msgs.scrollTop = msgs.scrollHeight
}

function addThinking() {
    const id   = 'think-' + Date.now()
    const msgs = $('chatMessages')
    const div  = document.createElement('div')
    div.className = 'message assistant'
    div.id = id
    div.innerHTML = '<div class="msg-bubble thinking"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>'
    msgs.appendChild(div)
    msgs.scrollTop = msgs.scrollHeight
    return id
}

function removeThinking(id) {
    const el = $(id)
    if (el) el.remove()
}

function clearChat() {
    const msgs = $('chatMessages')
    msgs.innerHTML = `
        <div class="chat-empty">
            <p class="chat-empty-label">Ask about the current market</p>
            <div class="chips">
                <button class="chip" data-msg="What does the current price action suggest?">Price action</button>
                <button class="chip" data-msg="What trend do you see on this chart?">Trend</button>
                <button class="chip" data-msg="What key levels should I watch?">Key levels</button>
                <button class="chip" data-msg="What does Reddit sentiment indicate?">Reddit mood</button>
            </div>
        </div>`
    msgs.querySelectorAll('.chip').forEach(btn => {
        btn.addEventListener('click', () => { $('chatInput').value = btn.dataset.msg; sendChat() })
    })
    chatHistory = []
}

function openSetupModal() {
    $('setupModal').classList.remove('hidden')
    $('setupLaunchBtn').addEventListener('click', completeSetup)
    $('setupSkipBtn').addEventListener('click', skipSetup)
}

async function completeSetup() {
    const key   = $('setupApiKey').value.trim()
    const model = $('setupModelSelect').value
    try {
        await fetch(`${API}/save-settings`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ binance_api_key: key, setup_complete: true })
        })
    } catch {}
    if (model) { activeModel = model; $('modelSelect').value = activeModel }
    $('setupModal').classList.add('hidden')
}

async function skipSetup() {
    try {
        await fetch(`${API}/save-settings`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ setup_complete: true })
        })
    } catch {}
    $('setupModal').classList.add('hidden')
}

function openSettings() {
    $('settingsModal').classList.remove('hidden')
    loadSettingsData()
    setupSettingsListeners()
}

async function loadSettingsData() {
    try {
        const r = await fetch(`${API}/get-settings`)
        const d = await r.json()
        $('settingsApiKey').value = d.binance_api_key || ''
    } catch {}
    await loadModels()
}

function setupSettingsListeners() {
    const closeBtn = $('settingsCloseBtn')
    const nc = closeBtn.cloneNode(true)
    closeBtn.parentNode.replaceChild(nc, closeBtn)
    nc.addEventListener('click', () => $('settingsModal').classList.add('hidden'))

    const saveKeyBtn = $('saveApiKeyBtn')
    const ns = saveKeyBtn.cloneNode(true)
    saveKeyBtn.parentNode.replaceChild(ns, saveKeyBtn)
    ns.addEventListener('click', saveApiKey)

    const installBtn = $('installModelBtn')
    const ni = installBtn.cloneNode(true)
    installBtn.parentNode.replaceChild(ni, installBtn)
    ni.addEventListener('click', installModel)

    // Scrollbar toggle
    const sbToggle = $('scrollbarToggle')
    if (sbToggle) {
        sbToggle.checked = !document.body.classList.contains('scrollbars-hidden')
        // Clone to remove old listeners
        const sbNew = sbToggle.cloneNode(true)
        sbToggle.parentNode.replaceChild(sbNew, sbToggle)
        sbNew.addEventListener('change', () => {
            document.body.classList.toggle('scrollbars-hidden', !sbNew.checked)
            localStorage.setItem('scrollbarsHidden', String(!sbNew.checked))
        })
    }

    document.querySelectorAll('.model-tag').forEach(chip => {
        chip.addEventListener('click', () => { $('installModelInput').value = chip.dataset.model })
    })

    $('settingsModal').addEventListener('click', e => {
        if (e.target === $('settingsModal')) $('settingsModal').classList.add('hidden')
    })
}

async function saveApiKey() {
    const key = $('settingsApiKey').value.trim()
    try {
        await fetch(`${API}/save-settings`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ binance_api_key: key })
        })
        const btn = $('saveApiKeyBtn')
        const orig = btn.textContent
        btn.textContent = 'Saved ✓'
        setTimeout(() => { btn.textContent = orig }, 2000)
    } catch {}
}

async function installModel() {
    const name = $('installModelInput').value.trim()
    if (!name) return
    const statusEl   = $('installStatus')
    const statusText = $('installStatusText')
    const btn        = $('installModelBtn')
    statusEl.classList.remove('hidden')
    statusText.textContent = `Downloading ${name}…`
    btn.disabled = true
    addLog(`Pulling model: ${name}`)
    try {
        const r = await fetch(`${API}/pull-model`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: name })
        })
        const d = await r.json()
        if (d.success) {
            statusText.textContent = `✓ ${name} installed`
            $('installModelInput').value = ''
            addLog(`Model ${name} installed`, 'success')
            await loadModels()
            if (eAPI) eAPI.refreshMenu()
        } else {
            statusText.textContent = `Error: ${d.error || 'Failed'}`
            addLog(`Model pull failed: ${d.error}`, 'error')
        }
    } catch (e) {
        statusText.textContent = `Error: ${e.message}`
        addLog(`Model pull error: ${e.message}`, 'error')
    } finally {
        btn.disabled = false
        setTimeout(() => statusEl.classList.add('hidden'), 4000)
    }
}

function showAboutModal() {
    const existing = $('aboutModal')
    if (existing) { existing.classList.remove('hidden'); return }

    const overlay = document.createElement('div')
    overlay.className = 'overlay'; overlay.id = 'aboutModal'
    overlay.innerHTML = `
        <div class="about-sheet">
            <button class="close-btn about-close" id="aboutCloseBtn">✕</button>

            <div class="about-hero">
                <div class="about-icon">⬡</div>
                <div>
                    <div class="about-name">Crypto Terminal</div>
                    <div class="about-ver">v1.0.0 · Market Intelligence Platform · NMIMS Innovathon 2026</div>
                </div>
            </div>

            <div class="about-divider"></div>
            <div class="about-section-label">Features</div>
            <div class="about-features">
                <div class="about-feat"><span class="feat-icon">📈</span><div><div class="feat-title">Live Candlestick Charts</div><div class="feat-sub">Real-time Binance data across 6 intervals (1m → 1d) with volume overlay</div></div></div>
                <div class="about-feat"><span class="feat-icon">🎯</span><div><div class="feat-title">6-Horizon Price Forecasting</div><div class="feat-sub">Precise $ targets for 1m · 5m · 15m · 1h · 4h · 1d with CI bands and accuracy tracking</div></div></div>
                <div class="about-feat"><span class="feat-icon">🤖</span><div><div class="feat-title">Local AI Analysis via Ollama</div><div class="feat-sub">Fully private — no data leaves your machine. Chat with any installed model</div></div></div>
                <div class="about-feat"><span class="feat-icon">📡</span><div><div class="feat-title">Reddit Sentiment Analysis</div><div class="feat-sub">Live community mood scored and tracked per coin</div></div></div>
                <div class="about-feat"><span class="feat-icon">⚗️</span><div><div class="feat-title">Backtesting Engine</div><div class="feat-sub">Walk-forward signal replay with win rate and Sharpe ratio</div></div></div>
                <div class="about-feat"><span class="feat-icon">🧠</span><div><div class="feat-title">ML Evaluation (Prophet)</div><div class="feat-sub">Time-series model vs technical baseline with full confusion matrix</div></div></div>
                <div class="about-feat"><span class="feat-icon">◈</span><div><div class="feat-title">Price History Panel</div><div class="feat-sub">Full forecast log with per-horizon accuracy stats — press P to toggle</div></div></div>
            </div>

            <div class="about-divider"></div>
            <div class="about-section-label">Tech Stack</div>
            <div class="about-stack">
                <span class="stack-pill">Electron</span>
                <span class="stack-pill">Python · Flask</span>
                <span class="stack-pill">SQLite</span>
                <span class="stack-pill">Ollama</span>
                <span class="stack-pill">Binance API</span>
                <span class="stack-pill">lightweight-charts</span>
                <span class="stack-pill">Prophet</span>
                <span class="stack-pill">NumPy</span>
                <span class="stack-pill">Reddit API</span>
            </div>

            <div class="about-divider"></div>
            <div class="about-footer">
                <span class="about-disclaimer">⚠ Educational simulation only · Not financial advice</span>
                <span class="about-event">NMIMS Innovathon 2026</span>
            </div>
        </div>`
    document.body.appendChild(overlay)
    overlay.addEventListener('click', e => {
        if (e.target === overlay || e.target.id === 'aboutCloseBtn') overlay.classList.add('hidden')
    })
}

function openCustomMarketModal() {
    const existing = $('customMarketModal')
    if (existing) existing.remove()

    const overlay = document.createElement('div')
    overlay.className = 'overlay'; overlay.id = 'customMarketModal'
    overlay.innerHTML = `
        <div class="sheet sheet--wide" style="max-height:88vh;overflow-y:auto">
            <div class="sheet-header-row">
                <h2 class="sheet-title">Import Custom Market</h2>
                <button class="close-btn" id="customMarketClose">✕</button>
            </div>

            <div class="field">
                <label class="field-label">Search Binance USDT Markets</label>
                <div style="position:relative">
                    <input type="text" class="field-input" id="cmSearch"
                        placeholder="Type symbol — DOGE, PEPE, WIF, AVAX…"
                        maxlength="20" autocomplete="off" style="width:100%">
                    <div id="cmDropdown" style="
                        display:none;position:absolute;top:100%;left:0;right:0;z-index:100;
                        background:var(--bg-2);border:1px solid var(--line-bright);
                        border-top:none;border-radius:0 0 6px 6px;max-height:220px;overflow-y:auto
                    "></div>
                </div>
                <div id="cmSearchStatus" style="font-size:9px;color:var(--text-3);margin-top:4px;min-height:14px"></div>
            </div>

            <div id="cmMarketCard" style="display:none"></div>

            <div id="cmFields" style="display:none;flex-direction:column;gap:12px">
                <div class="field">
                    <label class="field-label">Display Name <span class="opt-tag">editable</span></label>
                    <input type="text" class="field-input" id="cmName" placeholder="e.g. Dogecoin" maxlength="40">
                </div>
                <div class="field">
                    <label class="field-label">Subreddits <span class="opt-tag">comma-separated · optional</span></label>
                    <input type="text" class="field-input" id="cmSubs" placeholder="dogecoin, CryptoCurrency" maxlength="200">
                </div>
                <input type="hidden" id="cmSymbol">
                <input type="hidden" id="cmTicker">
            </div>

            <button class="primary-btn" id="cmAddBtn" style="display:none;margin-top:4px">+ Add to Markets</button>
            <p id="cmMsg" style="font-size:10px;min-height:14px;margin-top:4px"></p>
        </div>`
    document.body.appendChild(overlay)

    let searchTimer = null
    let selectedResult = null

    const searchInput = $('cmSearch')
    const dropdown    = $('cmDropdown')
    const statusEl    = $('cmSearchStatus')
    const fieldsDiv   = $('cmFields')
    const addBtn      = $('cmAddBtn')
    const msgEl       = $('cmMsg')
    const cardEl      = $('cmMarketCard')

    function closeDropdown() { dropdown.style.display = 'none'; dropdown.innerHTML = '' }

    async function buildMarketCard(result) {
        cardEl.style.display = 'block'
        cardEl.innerHTML = `<div class="cm-market-card">
            <div style="font-size:9px;color:var(--text-3);text-transform:uppercase;letter-spacing:0.6px;margin-bottom:6px">Selected Market</div>
            <div class="cm-card-top">
                <div>
                    <div class="cm-card-sym">${escapeHtml(result.symbol)}</div>
                    <div class="cm-card-name">${escapeHtml(result.ticker)}</div>
                </div>
                <div class="cm-card-right">
                    <div class="cm-card-price">${fmtPrice(result.price)}</div>
                    <div class="cm-card-chg ${result.change >= 0 ? 'up' : 'down'}">${result.change >= 0 ? '+' : ''}${result.change}% 24h</div>
                </div>
            </div>
            <div class="cm-stats-row">
                <div class="cm-stat"><div class="cm-stat-k">24h Vol</div><div class="cm-stat-v">${result.volume >= 1e9 ? (result.volume/1e9).toFixed(1)+'B' : result.volume >= 1e6 ? (result.volume/1e6).toFixed(1)+'M' : result.volume >= 1e3 ? (result.volume/1e3).toFixed(0)+'K' : result.volume.toFixed(0)}</div></div>
                <div class="cm-stat"><div class="cm-stat-k">24h Change</div><div class="cm-stat-v" style="color:${result.change >= 0 ? 'var(--up)' : 'var(--down)'}">${result.change >= 0 ? '+' : ''}${result.change}%</div></div>
                <div class="cm-stat"><div class="cm-stat-k">Rank</div><div class="cm-stat-v" id="cmRankVal">—</div></div>
            </div>
            <div id="cmSparkWrap" class="cm-sparkline-wrap" title="7-day price trend"></div>
            <div class="cm-forecast-badge" id="cmForecastBadge">
                <span class="cm-fc-label">1H Forecast</span>
                <span class="cm-fc-val side"><div class="spin spin--sm" style="display:inline-block"></div></span>
            </div>
        </div>`

        // Fetch sparkline (7-day closes from daily candles)
        try {
            const r = await fetch(`${API}/price?symbol=${result.ticker}&interval=1d&limit=14`)
            const d = await r.json()
            if (d.candles && d.candles.length > 1) {
                const closes   = d.candles.map(c => c.close)
                const minC     = Math.min(...closes)
                const maxC     = Math.max(...closes)
                const range    = maxC - minC || 1
                const sparkEl  = $('cmSparkWrap')
                if (sparkEl) {
                    sparkEl.innerHTML = closes.map((c, i) => {
                        const h   = Math.max(4, Math.round(((c - minC) / range) * 24))
                        const col = c >= closes[Math.max(0,i-1)] ? 'var(--up)' : 'var(--down)'
                        return `<div class="cm-spark-bar" style="height:${h}px;background:${col}"></div>`
                    }).join('')
                }
            }
        } catch {}

        // Fetch quick 1h forecast for the selected coin
        try {
            const r = await fetch(`${API}/insight?symbol=${result.ticker}&interval=1h`)
            const d = await r.json()
            const badge = $('cmForecastBadge')
            if (badge && !d.error) {
                const dirCls = d.direction === 'UP' ? 'up' : d.direction === 'DOWN' ? 'down' : 'side'
                const arrow  = d.direction === 'UP' ? '↑' : d.direction === 'DOWN' ? '↓' : '→'
                badge.innerHTML = `
                    <span class="cm-fc-label">1H Signal</span>
                    <span class="cm-fc-val ${dirCls}">${arrow} ${d.direction} · ${d.confidence}</span>
                    <span style="font-size:9px;color:var(--text-2)">${d.change_24h >= 0 ? '+' : ''}${Number(d.change_24h).toFixed(2)}% 24h</span>`
            }
        } catch {}
    }

    async function selectResult(result) {
        selectedResult = result
        closeDropdown()
        $('cmSymbol').value = result.symbol
        $('cmTicker').value = result.ticker
        $('cmName').value   = result.symbol
        fieldsDiv.style.display = 'flex'
        addBtn.style.display    = 'block'
        statusEl.textContent = ''
        await buildMarketCard(result)
        $('cmName').focus()
        $('cmName').select()
    }

    function renderDropdown(results) {
        if (!results.length) {
            dropdown.innerHTML = `<div style="padding:10px 12px;font-size:10px;color:var(--text-3)">No USDT pairs found</div>`
            dropdown.style.display = 'block'
            return
        }
        dropdown.innerHTML = results.map(r => `
            <div class="cm-result-row" data-symbol="${escapeHtml(r.symbol)}" data-ticker="${escapeHtml(r.ticker)}"
                 data-price="${r.price}" data-change="${r.change}" data-volume="${r.volume || 0}"
                 style="padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center">
                <div style="display:flex;flex-direction:column;gap:1px">
                    <div>
                        <span style="font-size:11px;font-weight:500;color:var(--text-0)">${escapeHtml(r.symbol)}</span>
                        <span style="font-size:9px;color:var(--text-3);margin-left:6px">${escapeHtml(r.ticker)}</span>
                    </div>
                    <span style="font-size:9px;color:var(--text-2)">Vol ${r.volume >= 1e6 ? (r.volume/1e6).toFixed(0)+'M' : (r.volume/1e3).toFixed(0)+'K'} USDT</span>
                </div>
                <div style="text-align:right">
                    <div style="font-size:11px;color:var(--text-0);font-variant-numeric:tabular-nums">${fmtPrice(r.price)}</div>
                    <div style="font-size:9px;color:${r.change >= 0 ? 'var(--up)' : 'var(--down)'}">${r.change >= 0 ? '+' : ''}${r.change}%</div>
                </div>
            </div>`).join('')
        dropdown.style.display = 'block'

        dropdown.querySelectorAll('.cm-result-row').forEach(row => {
            row.addEventListener('mouseenter', () => { row.style.background = 'var(--bg-3)' })
            row.addEventListener('mouseleave', () => { row.style.background = '' })
            row.addEventListener('click', () => {
                selectResult({
                    symbol: row.dataset.symbol,
                    ticker: row.dataset.ticker,
                    price:  parseFloat(row.dataset.price),
                    change: parseFloat(row.dataset.change),
                    volume: parseFloat(row.dataset.volume)
                })
            })
        })
    }

    searchInput.addEventListener('input', () => {
        const q = searchInput.value.trim()
        clearTimeout(searchTimer)
        closeDropdown()
        fieldsDiv.style.display = 'none'
        addBtn.style.display    = 'none'
        cardEl.style.display    = 'none'
        msgEl.textContent       = ''
        selectedResult          = null

        if (!q) { statusEl.textContent = ''; return }

        statusEl.textContent = 'Searching…'
        statusEl.style.color = 'var(--text-3)'

        searchTimer = setTimeout(async () => {
            try {
                const r    = await fetch(`${API}/search-markets?q=${encodeURIComponent(q)}`)
                const data = await r.json()
                statusEl.textContent = data.results?.length
                    ? `${data.results.length} pair${data.results.length !== 1 ? 's' : ''} found — click to select`
                    : 'No matches'
                renderDropdown(data.results || [])
            } catch {
                statusEl.textContent = 'Search failed — is backend running?'
                statusEl.style.color = 'var(--down)'
            }
        }, 280)
    })

    document.addEventListener('click', function outsideClick(e) {
        if (!dropdown.contains(e.target) && e.target !== searchInput) closeDropdown()
        if (e.target === overlay || e.target.id === 'customMarketClose') document.removeEventListener('click', outsideClick)
    })

    addBtn.addEventListener('click', async () => {
        const sym    = $('cmSymbol').value.trim().toUpperCase()
        const name   = $('cmName').value.trim() || sym
        const ticker = $('cmTicker').value.trim().toUpperCase()
        const subs   = $('cmSubs').value.split(',').map(s => s.trim()).filter(Boolean)

        if (!sym || !ticker) { msgEl.textContent = 'Please select a market first.'; msgEl.style.color = 'var(--down)'; return }
        if (COINS.find(c => c.symbol === sym)) { msgEl.textContent = `${sym} is already in your list.`; msgEl.style.color = 'var(--down)'; return }

        COINS.push({ symbol: sym, name, ticker, subreddits: subs.length ? subs : ['CryptoCurrency'] })
        if (eAPI) await eAPI.saveCoins(COINS)
        setupCoinList()
        addLog(`Added custom market: ${sym}`, 'success')
        msgEl.style.color  = 'var(--up)'
        msgEl.textContent  = `✓ ${name} (${sym}) added`
        setTimeout(() => overlay.remove(), 900)
    })

    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove() })
    $('customMarketClose').addEventListener('click', () => overlay.remove())
    searchInput.focus()
}

function openMarketManagerModal() {
    const existing = $('marketManagerModal')
    if (existing) existing.remove()

    const overlay = document.createElement('div')
    overlay.className = 'overlay'; overlay.id = 'marketManagerModal'

    function coinRow(c, i) {
        const subs   = (c.subreddits || []).join(', ')
        const locked = i < 5
        return `
        <div class="mm-row" data-idx="${i}">
            <div class="mm-row-header">
                <div class="mm-row-title">
                    <span class="mm-sym">${escapeHtml(c.symbol)}</span>
                    <span class="mm-name">${escapeHtml(c.name)}</span>
                    <span class="mm-ticker">${escapeHtml(c.ticker)}</span>
                </div>
                <div class="mm-row-actions">
                    <button class="small-btn mm-edit-btn" data-idx="${i}">Edit</button>
                    ${!locked ? `<button class="small-btn mm-del-btn" data-idx="${i}" style="color:var(--down);border-color:rgba(255,69,58,0.3)">Remove</button>` : '<span style="font-size:9px;color:var(--text-3)">default</span>'}
                </div>
            </div>
            <div class="mm-subs-row">
                <span class="mm-subs-label">Subreddits:</span>
                <span class="mm-subs-val" id="mm-subs-${i}">${subs ? escapeHtml(subs) : '<span style="color:var(--text-3)">none</span>'}</span>
            </div>
            <div class="mm-edit-panel hidden" id="mm-edit-${i}">
                <div class="field" style="margin-top:8px">
                    <label class="field-label">Subreddits <span class="opt-tag">comma-separated</span></label>
                    <input type="text" class="field-input mm-subs-input" id="mm-input-${i}" value="${escapeHtml(subs)}" placeholder="e.g. Bitcoin, CryptoCurrency">
                </div>
                ${!locked ? `
                <div class="field">
                    <label class="field-label">Display Name</label>
                    <input type="text" class="field-input mm-name-input" id="mm-name-${i}" value="${escapeHtml(c.name)}" maxlength="40">
                </div>` : ''}
                <div style="display:flex;gap:8px;margin-top:8px">
                    <button class="primary-btn mm-save-btn" data-idx="${i}" style="flex:1;padding:8px">Save</button>
                    <button class="small-btn mm-cancel-btn" data-idx="${i}" style="flex:0 0 auto">Cancel</button>
                </div>
            </div>
        </div>`
    }

    function renderAll() { return COINS.map((c, i) => coinRow(c, i)).join('') }

    overlay.innerHTML = `
        <div class="sheet sheet--wide" style="max-height:85vh;overflow-y:auto">
            <div class="sheet-header-row">
                <h2 class="sheet-title">Manage Markets &amp; Subreddits</h2>
                <button class="close-btn" id="mmClose">✕</button>
            </div>
            <div id="mmList" style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px">
                ${renderAll()}
            </div>
            <p style="font-size:10px;color:var(--text-3)">Default markets can have their subreddits edited but cannot be removed. Use Market → Import Custom Market to add new ones.</p>
        </div>`

    document.body.appendChild(overlay)

    function bindEvents() {
        overlay.querySelectorAll('.mm-edit-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const i     = btn.dataset.idx
                const panel = $(`mm-edit-${i}`)
                const isOpen = !panel.classList.contains('hidden')
                document.querySelectorAll('.mm-edit-panel').forEach(p => p.classList.add('hidden'))
                if (!isOpen) panel.classList.remove('hidden')
            })
        })

        overlay.querySelectorAll('.mm-save-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const i       = parseInt(btn.dataset.idx)
                const coin    = COINS[i]
                const subsVal = $(`mm-input-${i}`).value
                const nameInp = $(`mm-name-${i}`)
                coin.subreddits = subsVal.split(',').map(s => s.trim()).filter(Boolean)
                if (nameInp) coin.name = nameInp.value.trim() || coin.name
                if (eAPI) await eAPI.saveCoins(COINS)
                setupCoinList()
                const subsSpan = $(`mm-subs-${i}`)
                if (subsSpan) subsSpan.innerHTML = coin.subreddits.length ? escapeHtml(coin.subreddits.join(', ')) : '<span style="color:var(--text-3)">none</span>'
                $(`mm-edit-${i}`).classList.add('hidden')
                addLog(`${coin.symbol} subreddits updated`, 'success')
            })
        })

        overlay.querySelectorAll('.mm-cancel-btn').forEach(btn => {
            btn.addEventListener('click', () => { $(`mm-edit-${btn.dataset.idx}`).classList.add('hidden') })
        })

        overlay.querySelectorAll('.mm-del-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const i = parseInt(btn.dataset.idx)
                if (i < 5) return
                COINS.splice(i, 1)
                if (activeCoin.symbol === COINS[i]?.symbol || !COINS.find(c => c.symbol === activeCoin.symbol)) {
                    activeCoin = COINS[0]
                }
                if (eAPI) await eAPI.saveCoins(COINS)
                setupCoinList()
                $('mmList').innerHTML = renderAll()
                bindEvents()
            })
        })
    }
    bindEvents()

    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove() })
    $('mmClose').addEventListener('click', () => overlay.remove())
}

async function openModelDeleteModal() {
    const r      = await fetch(`${API}/models`)
    const data   = await r.json()
    const models = data.models || []

    const existing = $('modelDeleteModal')
    if (existing) existing.remove()

    const overlay = document.createElement('div')
    overlay.className = 'overlay'; overlay.id = 'modelDeleteModal'
    overlay.innerHTML = `
        <div class="sheet">
            <div class="sheet-header-row">
                <h2 class="sheet-title">Delete Model</h2>
                <button class="close-btn" id="mdClose">✕</button>
            </div>
            <p style="font-size:11px;color:var(--text-2)">Select a model to permanently delete it from disk.</p>
            <div class="model-list" id="mdList">
                ${models.length ? models.map(m => `
                    <div class="model-item">
                        <span>${escapeHtml(m)}</span>
                        <button class="small-btn" data-model="${escapeHtml(m)}" style="color:var(--down);border-color:var(--down-bg)">Delete</button>
                    </div>`).join('') : '<div style="font-size:10px;color:var(--text-3);padding:8px">No models installed</div>'}
            </div>
            <p class="field-label" id="mdMsg" style="min-height:14px"></p>
        </div>`
    document.body.appendChild(overlay)

    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove() })
    $('mdClose').addEventListener('click', () => overlay.remove())

    overlay.querySelectorAll('[data-model]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const name = btn.dataset.model
            btn.disabled = true; btn.textContent = '…'
            try {
                const resp = await fetch(`${API}/delete-model`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model: name })
                })
                const d = await resp.json()
                if (d.success) {
                    btn.closest('.model-item').remove()
                    addLog(`Model ${name} deleted`, 'success')
                    await loadModels()
                    if (eAPI) eAPI.refreshMenu()
                    $('mdMsg').style.color = 'var(--up)'
                    $('mdMsg').textContent = `${name} deleted.`
                } else {
                    btn.disabled = false; btn.textContent = 'Delete'
                    $('mdMsg').style.color = 'var(--down)'
                    $('mdMsg').textContent = d.error || 'Delete failed'
                }
            } catch (e) {
                btn.disabled = false; btn.textContent = 'Delete'
                $('mdMsg').style.color = 'var(--down)'
                $('mdMsg').textContent = e.message
            }
        })
    })
}

async function handleRefresh() {
    const icon = $('refreshIcon')
    icon.style.animation = 'dospin 0.7s linear infinite'
    await loadCoinData()
    icon.style.animation = ''
}

async function checkOllama() {
    try {
        const r    = await fetch(`${API}/models`)
        const data = await r.json()
        const dot  = $('ollamaDot')
        const lbl  = $('ollamaLabel')
        if (data.models && data.models.length > 0) {
            dot.className = 'sm-dot online'
            lbl.textContent = `Ollama · ${data.models.length} model${data.models.length > 1 ? 's' : ''}`
        } else if (!data.error) {
            dot.className = 'sm-dot online'
            lbl.textContent = 'Ollama · no models'
        } else {
            dot.className = 'sm-dot offline'
            lbl.textContent = 'Ollama offline'
        }
    } catch {
        $('ollamaDot').className = 'sm-dot offline'
        $('ollamaLabel').textContent = 'Ollama offline'
    }
}

function startAutoRefresh() {
    if (chartTimer)    clearInterval(chartTimer)
    if (insightTimer)  clearInterval(insightTimer)
    if (pipelineTimer) clearInterval(pipelineTimer)
    if (forecastTimer) clearInterval(forecastTimer)

    chartTimer    = setInterval(loadChart,          60000)
    insightTimer  = setInterval(loadInsight,         30000)
    forecastTimer = setInterval(loadMultiForecast,   60000)  // every 1 min — matches 1m horizon
    pipelineTimer = setInterval(runPipeline,        300000)
}

function showChartLoading() { $('chartLoading').style.display = 'flex' }
function hideChartLoading() { $('chartLoading').style.display = 'none' }
function showChartError(msg) { $('chartError').classList.remove('hidden'); $('chartErrorMsg').textContent = msg }
function hideChartError()    { $('chartError').classList.add('hidden') }

function formatPrice(price) {
    if (!price && price !== 0) return '—'
    if (price >= 1000) return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    if (price >= 1)    return price.toFixed(4)
    return price.toFixed(6)
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/\n/g, '<br>')
}

// ── Multi-horizon price forecasts ──────────────────────────────────────────

async function loadMultiForecast() {
    const gridEl = $('forecastGrid')
    if (!gridEl) return
    gridEl.innerHTML = `<div class="fc-loading"><div class="spin spin--sm"></div><span>Fetching price targets…</span></div>`
    try {
        const r = await fetch(`${API}/multi-forecast`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol: activeCoin.symbol })
        })
        const data = await r.json()
        if (data.error) throw new Error(data.error)
        renderMultiForecast(data)
        const ts = $('forecastGridUpdated')
        if (ts) ts.textContent = new Date().toLocaleTimeString()
        loadForecastHistory()
        fetch(`${API}/evaluate-price-forecasts`, { method: 'POST' }).catch(() => {})
        addLog(`Price forecasts updated for ${activeCoin.symbol}`, 'success')
    } catch (e) {
        if (gridEl) gridEl.innerHTML = `<div class="fc-loading"><span style="color:var(--down)">Forecast unavailable — ${e.message}</span></div>`
        addLog(`Multi-forecast: ${e.message}`, 'error')
    }
}

function fmtPrice(p) {
    if (p == null) return '—'
    if (p >= 1000)  return '$' + Number(p).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    if (p >= 1)     return '$' + Number(p).toFixed(4)
    if (p >= 0.01)  return '$' + Number(p).toFixed(5)
    return '$' + Number(p).toFixed(7)
}

function renderMultiForecast(data) {
    const gridEl = $('forecastGrid')
    if (!gridEl || !data.forecasts) return

    const rows = data.forecasts.map(fc => {
        if (fc.error) return `
            <div class="fc-row">
                <span class="fc-horizon">${(fc.horizon||'').toUpperCase()}</span>
                <span class="fc-price" style="color:var(--text-3)">—</span>
                <span class="fc-dir side">—</span>
                <span class="fc-pct side">—</span>
                <span class="fc-conf">—</span>
            </div>`

        const isUp   = fc.direction === 'UP'
        const isDn   = fc.direction === 'DOWN'
        const dirCls = isUp ? 'up' : isDn ? 'down' : 'side'
        const arrow  = isUp ? '↑' : isDn ? '↓' : '→'
        const sign   = fc.pct_change >= 0 ? '+' : ''
        const pctStr = `${sign}${Number(fc.pct_change).toFixed(3)}%`
        const conf   = Math.round(fc.confidence * 100)

        return `<div class="fc-row" title="90% CI: ${fmtPrice(fc.price_lower)} – ${fmtPrice(fc.price_upper)}">
            <span class="fc-horizon">${(fc.horizon||'').toUpperCase()}</span>
            <span class="fc-price">${fmtPrice(fc.price_target)}</span>
            <span class="fc-dir ${dirCls}">${arrow} ${fc.direction}</span>
            <span class="fc-pct ${dirCls}">${pctStr}</span>
            <span class="fc-conf">${conf}%</span>
        </div>`
    }).join('')

    gridEl.innerHTML = `
        <div class="fc-header-row">
            <span class="fc-col-h">TF</span>
            <span class="fc-col-h">Target</span>
            <span class="fc-col-h">Dir</span>
            <span class="fc-col-h">Δ%</span>
            <span class="fc-col-h">Conf</span>
        </div>
        ${rows}
        <div class="fc-ci-hint">Hover row for 90% CI · Reg + RSI/EMA/BB · auto-evaluated</div>`
}

async function loadForecastHistory() {
    try {
        const r = await fetch(`${API}/forecast-history?symbol=${activeCoin.symbol}&limit=40`)
        const data = await r.json()
        if (data.error) throw new Error(data.error)
        phAllForecasts = data.forecasts || []
        renderForecastHistoryStrip(data)
        if (phVisible) renderPhTable(phAllForecasts)
        updatePhStats(data)
    } catch (e) { /* silent */ }
}

function renderForecastHistoryStrip(data) {
    const histEl = $('forecastHistory')
    if (!histEl) return

    const forecasts = (data.forecasts || []).filter(f => f.actual_price != null)
    const stats     = data.stats || {}
    const horizonOrder = ['1m','5m','15m','1h','4h','1d']

    const statBadges = horizonOrder.map(h => {
        const s = stats[h]
        if (!s || s.evaluated === 0) return ''
        const pct = Math.round((s.hit_rate || 0) * 100)
        const cls = pct >= 65 ? 'acc-good' : pct >= 45 ? 'acc-ok' : 'acc-bad'
        return `<span class="acc-badge ${cls}">${h.toUpperCase()} ${pct}%</span>`
    }).filter(Boolean).join('')

    if (!forecasts.length) {
        histEl.innerHTML = `
            <div class="fh-header">
                <span class="fh-title">Accuracy ${statBadges ? `— <span class="acc-badges">${statBadges}</span>` : ''}</span>
                <button class="fh-see-all" id="phToggleBtn">See all →</button>
            </div>
            <div class="fh-empty">Predictions evaluate after each horizon elapses</div>`
        document.getElementById('phToggleBtn')?.addEventListener('click', togglePriceHistory)
        return
    }

    const rows = forecasts.slice(0, 8).map(fc => {
        const hit      = fc.hit_target === 1
        const dirCls   = fc.direction === 'UP' ? 'up' : fc.direction === 'DOWN' ? 'down' : 'side'
        const movePct  = fc.actual_pct != null
            ? `${fc.actual_pct >= 0 ? '+' : ''}${Number(fc.actual_pct).toFixed(2)}%`
            : '—'
        return `<div class="fh-row">
            <span class="fh-horizon">${(fc.horizon||'').toUpperCase()}</span>
            <span class="fh-target">${fmtPrice(fc.price_target)}</span>
            <span class="fh-actual">${fmtPrice(fc.actual_price)}</span>
            <span class="fh-move ${dirCls}">${movePct}</span>
            <span class="fh-result ${hit ? 'fh-hit' : 'fh-miss'}">${hit ? '✓ HIT' : '✗ MISS'}</span>
        </div>`
    }).join('')

    const badgeHtml = statBadges ? `<div class="acc-badges">${statBadges}</div>` : ''

    histEl.innerHTML = `
        <div class="fh-header">
            <span class="fh-title">Accuracy</span>
            <div style="display:flex;align-items:center;gap:6px">
                ${badgeHtml}
                <button class="fh-see-all" id="phToggleBtn">All →</button>
            </div>
        </div>
        <div class="fh-col-row">
            <span>TF</span><span>Target</span><span>Actual</span><span>Move</span><span>Hit?</span>
        </div>
        ${rows}`
    document.getElementById('phToggleBtn')?.addEventListener('click', togglePriceHistory)
}

// ── Price History Full Panel ────────────────────────────────────────────────

function togglePriceHistory() {
    phVisible = !phVisible
    const panel = $('priceHistoryPanel')
    const btn   = $('phBtn')
    if (!panel) return

    if (phVisible) {
        panel.classList.remove('hidden')
        if (btn) btn.classList.add('active')
        const lbl = $('phCoinLabel')
        if (lbl) lbl.textContent = `${activeCoin.symbol} · last 100`
        renderPhTable(phAllForecasts)
        if (!phAllForecasts.length) loadForecastHistory()
    } else {
        panel.classList.add('hidden')
        if (btn) btn.classList.remove('active')
    }
}

function updatePhStats(data) {
    const statsRow = $('phStatsRow')
    if (!statsRow) return
    const stats = data.stats || {}
    const all   = data.forecasts || []
    const total = all.length
    const evaluated = all.filter(f => f.actual_price != null).length
    const hits  = all.filter(f => f.hit_target === 1).length
    const rate  = evaluated > 0 ? Math.round(hits / evaluated * 100) : null

    const horizons = ['1m','5m','15m','1h','4h','1d']
    const bestH = horizons.reduce((best, h) => {
        const s = stats[h]
        if (!s || s.evaluated === 0) return best
        if (!best || (s.hit_rate || 0) > (stats[best]?.hit_rate || 0)) return h
        return best
    }, null)

    statsRow.innerHTML = `
        <div class="ph-stat">
            <div class="ph-stat-k">Total Forecasts</div>
            <div class="ph-stat-v">${total}</div>
        </div>
        <div class="ph-stat">
            <div class="ph-stat-k">Evaluated</div>
            <div class="ph-stat-v">${evaluated}</div>
        </div>
        <div class="ph-stat">
            <div class="ph-stat-k">Hit Rate (CI)</div>
            <div class="ph-stat-v" style="color:${rate != null ? (rate >= 65 ? 'var(--up)' : rate >= 45 ? 'var(--neutral)' : 'var(--down)') : 'var(--text-2)'}">${rate != null ? rate + '%' : '—'}</div>
        </div>
        <div class="ph-stat">
            <div class="ph-stat-k">Best Horizon</div>
            <div class="ph-stat-v">${bestH ? bestH.toUpperCase() : '—'}</div>
        </div>`
}

function renderPhTable(forecasts) {
    const tbody = $('phTableBody')
    if (!tbody) return

    const filtered = phActiveFilter === 'all'
        ? forecasts
        : forecasts.filter(f => f.horizon === phActiveFilter)

    if (!filtered.length) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--text-3);padding:20px">No forecasts for this filter yet</td></tr>`
        return
    }

    tbody.innerHTML = filtered.map(fc => {
        const pending   = fc.actual_price == null
        const hit       = fc.hit_target === 1
        const isUp      = fc.direction === 'UP'
        const isDn      = fc.direction === 'DOWN'
        const dirCls    = isUp ? 'up' : isDn ? 'down' : ''
        const movePct   = fc.actual_pct != null
            ? `${fc.actual_pct >= 0 ? '+' : ''}${Number(fc.actual_pct).toFixed(3)}%`
            : '—'
        const timeStr   = fc.created_at
            ? new Date(fc.created_at * 1000).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })
            : '—'
        const confStr   = fc.confidence != null ? Math.round(fc.confidence * 100) + '%' : '—'
        const outClass  = pending ? 'pending' : hit ? 'hit' : 'miss'
        const outLabel  = pending ? 'pending' : hit ? '✓ hit' : '✗ miss'
        const ciTitle   = `90% CI: ${fmtPrice(fc.price_lower)} – ${fmtPrice(fc.price_upper)}`

        return `<tr title="${ciTitle}">
            <td class="ph-ts">${timeStr}</td>
            <td><span style="font-size:9px;font-weight:500;color:var(--text-1)">${(fc.horizon||'').toUpperCase()}</span></td>
            <td class="ph-num">${fmtPrice(fc.current_price)}</td>
            <td class="ph-num ${dirCls}">${fmtPrice(fc.price_target)}</td>
            <td class="ph-num">${pending ? '<span style="color:var(--text-3)">pending</span>' : fmtPrice(fc.actual_price)}</td>
            <td class="ph-num ${movePct !== '—' ? dirCls : ''}">${movePct}</td>
            <td><span class="ph-outcome ${outClass}">${outLabel}</span></td>
            <td class="ph-num">${confStr}</td>
        </tr>`
    }).join('')
}

document.addEventListener('DOMContentLoaded', init)