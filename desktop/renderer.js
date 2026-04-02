const API = 'http://localhost:5000'
const eAPI = window.electronAPI || null

let COINS = [
    { symbol: 'BTC', name: 'Bitcoin',  ticker: 'BTCUSDT', subreddits: ['Bitcoin','CryptoCurrency'] },
    { symbol: 'ETH', name: 'Ethereum', ticker: 'ETHUSDT', subreddits: ['ethereum','CryptoCurrency'] },
    { symbol: 'SOL', name: 'Solana',   ticker: 'SOLUSDT', subreddits: ['solana','CryptoCurrency'] },
    { symbol: 'BNB', name: 'BNB',      ticker: 'BNBUSDT', subreddits: ['binance','CryptoCurrency'] },
    { symbol: 'XRP', name: 'XRP',      ticker: 'XRPUSDT', subreddits: ['XRP','CryptoCurrency'] },
]

const INTERVALS = ['5m', '15m', '1h', '4h', '1d']

let activeCoin      = COINS[0]
let activeInterval  = '1h'
let activeModel     = ''
let chatHistory     = []
let chart           = null
let candleSeries    = null
let volumeSeries    = null
let priceContext    = ''
let isChatLoading   = false
let terminalVisible = false
let terminalLog     = []
let pipelineRunning = false

let chartTimer    = null
let insightTimer  = null
let pipelineTimer = null

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

    document.querySelectorAll('.chip').forEach(btn => {
        btn.addEventListener('click', () => { $('chatInput').value = btn.dataset.msg; sendChat() })
    })

    document.addEventListener('keydown', e => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
        if (e.key === '`' || e.key === '~') {
            e.preventDefault()
            toggleTerminal()
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
        <div class="sheet" style="text-align:center;gap:12px">
            <div style="font-size:32px;margin-bottom:4px">⬡</div>
            <h2 class="sheet-title">Crypto Terminal</h2>
            <p style="font-size:11px;color:var(--text-2)">Version 2.0.0 · NMIMS Innovathon 2026</p>
            <p style="font-size:11px;color:var(--text-2);line-height:1.7">
                An AI-powered cryptocurrency analysis terminal.<br>
                Combines real-time Binance data, Reddit sentiment,<br>
                and local LLM analysis via Ollama.
            </p>
            <p style="font-size:10px;color:var(--text-3)">Educational use only. Not financial advice.</p>
            <button class="primary-btn" id="aboutCloseBtn">Close</button>
        </div>`
    document.body.appendChild(overlay)
    overlay.addEventListener('click', e => { if (e.target === overlay || e.target.id === 'aboutCloseBtn') overlay.classList.add('hidden') })
}

function openCustomMarketModal() {
    const existing = $('customMarketModal')
    if (existing) existing.remove()

    const overlay = document.createElement('div')
    overlay.className = 'overlay'; overlay.id = 'customMarketModal'
    overlay.innerHTML = `
        <div class="sheet">
            <div class="sheet-header-row">
                <h2 class="sheet-title">Import Custom Market</h2>
                <button class="close-btn" id="customMarketClose">✕</button>
            </div>

            <div class="field">
                <label class="field-label">Search Binance Markets</label>
                <div style="position:relative">
                    <input type="text" class="field-input" id="cmSearch"
                        placeholder="Type a symbol — e.g. DOGE, PEPE, WIF…"
                        maxlength="20" autocomplete="off" style="width:100%">
                    <div id="cmDropdown" style="
                        display:none; position:absolute; top:100%; left:0; right:0; z-index:100;
                        background:var(--bg-2); border:1px solid var(--line-bright);
                        border-top:none; border-radius:0 0 6px 6px;
                        max-height:200px; overflow-y:auto;
                    "></div>
                </div>
                <div id="cmSearchStatus" style="font-size:9px;color:var(--text-3);margin-top:4px;min-height:14px"></div>
            </div>

            <div id="cmFields" style="display:none;flex-direction:column;gap:12px">
                <div class="field">
                    <label class="field-label">Symbol <span class="opt-tag">auto-filled</span></label>
                    <input type="text" class="field-input" id="cmSymbol" readonly
                        style="opacity:0.7;cursor:default">
                </div>
                <div class="field">
                    <label class="field-label">Binance Ticker <span class="opt-tag">auto-filled</span></label>
                    <input type="text" class="field-input" id="cmTicker" readonly
                        style="opacity:0.7;cursor:default">
                </div>
                <div class="field">
                    <label class="field-label">Display Name <span class="opt-tag">editable</span></label>
                    <input type="text" class="field-input" id="cmName"
                        placeholder="e.g. Dogecoin" maxlength="40">
                </div>
                <div class="field">
                    <label class="field-label">Subreddits <span class="opt-tag">comma-separated, optional</span></label>
                    <input type="text" class="field-input" id="cmSubs"
                        placeholder="dogecoin, CryptoCurrency" maxlength="200">
                </div>
            </div>

            <button class="primary-btn" id="cmAddBtn" style="display:none">Add Market</button>
            <p id="cmMsg" style="font-size:10px;min-height:14px;margin-top:4px"></p>
        </div>`
    document.body.appendChild(overlay)

    let searchTimer = null

    const searchInput  = $('cmSearch')
    const dropdown     = $('cmDropdown')
    const statusEl     = $('cmSearchStatus')
    const fieldsDiv    = $('cmFields')
    const addBtn       = $('cmAddBtn')
    const msgEl        = $('cmMsg')

    function closeDropdown() {
        dropdown.style.display = 'none'
        dropdown.innerHTML = ''
    }

    function selectResult(result) {
        closeDropdown()
        $('cmSymbol').value = result.symbol
        $('cmTicker').value = result.ticker
        $('cmName').value   = result.symbol
        fieldsDiv.style.display = 'flex'
        addBtn.style.display    = 'block'
        statusEl.textContent = `Selected: ${result.ticker} · $${result.price.toLocaleString()} · ${result.change >= 0 ? '+' : ''}${result.change}%`
        statusEl.style.color = result.change >= 0 ? 'var(--up)' : 'var(--down)'
        $('cmName').focus()
        $('cmName').select()
    }

    function renderDropdown(results) {
        if (!results.length) {
            dropdown.innerHTML = `<div style="padding:10px 12px;font-size:10px;color:var(--text-3)">No USDT pairs found for that query</div>`
            dropdown.style.display = 'block'
            return
        }
        dropdown.innerHTML = results.map(r => `
            <div class="cm-result-row" data-symbol="${r.symbol}" data-ticker="${r.ticker}"
                 data-price="${r.price}" data-change="${r.change}"
                 style="padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--line);
                        display:flex;justify-content:space-between;align-items:center">
                <div>
                    <span style="font-size:11px;font-weight:500;color:var(--text-0)">${escapeHtml(r.symbol)}</span>
                    <span style="font-size:9px;color:var(--text-3);margin-left:6px">${escapeHtml(r.ticker)}</span>
                </div>
                <div style="text-align:right">
                    <span style="font-size:10px;color:var(--text-1)">$${r.price >= 1 ? r.price.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:4}) : r.price.toFixed(6)}</span>
                    <span style="font-size:9px;margin-left:6px;color:${r.change >= 0 ? 'var(--up)' : 'var(--down)'}">${r.change >= 0 ? '+' : ''}${r.change}%</span>
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
                    change: parseFloat(row.dataset.change)
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
        msgEl.textContent = ''

        if (!q) { statusEl.textContent = ''; statusEl.style.color = ''; return }

        statusEl.textContent = 'Searching Binance…'
        statusEl.style.color = 'var(--text-3)'

        searchTimer = setTimeout(async () => {
            try {
                const r    = await fetch(`${API}/search-markets?q=${encodeURIComponent(q)}`)
                const data = await r.json()
                if (data.error) {
                    statusEl.textContent = `Search failed: ${data.error}`
                    statusEl.style.color = 'var(--down)'
                    return
                }
                statusEl.textContent = data.results.length
                    ? `${data.results.length} USDT pair${data.results.length !== 1 ? 's' : ''} found — click one to select`
                    : 'No matches'
                statusEl.style.color = 'var(--text-3)'
                renderDropdown(data.results)
            } catch (e) {
                statusEl.textContent = 'Search unavailable — check backend'
                statusEl.style.color = 'var(--down)'
            }
        }, 300)
    })

    document.addEventListener('click', function outsideClick(e) {
        if (!dropdown.contains(e.target) && e.target !== searchInput) {
            closeDropdown()
        }
        if (e.target === overlay || e.target.id === 'customMarketClose') {
            document.removeEventListener('click', outsideClick)
        }
    })

    addBtn.addEventListener('click', async () => {
        const sym    = $('cmSymbol').value.trim().toUpperCase()
        const name   = $('cmName').value.trim() || sym
        const ticker = $('cmTicker').value.trim().toUpperCase()
        const subs   = $('cmSubs').value.split(',').map(s => s.trim()).filter(Boolean)

        if (!sym || !ticker) { msgEl.textContent = 'Please select a market from the search results.'; msgEl.style.color = 'var(--down)'; return }
        if (COINS.find(c => c.symbol === sym)) { msgEl.textContent = `${sym} is already in your market list.`; msgEl.style.color = 'var(--down)'; return }

        COINS.push({ symbol: sym, name, ticker, subreddits: subs.length ? subs : ['CryptoCurrency'] })
        if (eAPI) await eAPI.saveCoins(COINS)
        setupCoinList()
        msgEl.style.color = 'var(--up)'
        msgEl.textContent = `✓ ${name} (${sym}) added successfully`
        setTimeout(() => overlay.remove(), 1000)
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

    chartTimer    = setInterval(loadChart,    60000)
    insightTimer  = setInterval(loadInsight,  30000)
    pipelineTimer = setInterval(runPipeline, 300000)
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

document.addEventListener('DOMContentLoaded', init)