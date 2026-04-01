const API = 'http://localhost:5000'

const COINS = [
    { symbol: 'BTC', name: 'Bitcoin',  ticker: 'BTCUSDT' },
    { symbol: 'ETH', name: 'Ethereum', ticker: 'ETHUSDT' },
    { symbol: 'SOL', name: 'Solana',   ticker: 'SOLUSDT' },
    { symbol: 'BNB', name: 'BNB',      ticker: 'BNBUSDT' },
    { symbol: 'XRP', name: 'XRP',      ticker: 'XRPUSDT' },
]

const INTERVALS = ['5m', '15m', '1h', '4h', '1d']

let activeCoin     = COINS[0]
let activeInterval = '1h'
let activeModel    = ''
let chatHistory    = []
let chart          = null
let candleSeries   = null
let volumeSeries   = null
let priceContext   = ''
let insightRefreshTimer = null
let chartRefreshTimer   = null
let sentimentRefreshTimer = null
let isChatLoading  = false
let terminalVisible = false
let terminalLog     = []

const $ = (id) => document.getElementById(id)

function ts() {
    return new Date().toTimeString().slice(0, 5)
}

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
    if (m.includes('saved') || m.includes('pulled') || m.includes('ready')) return 'success'
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
    const ready = await waitForBackend()
    if (!ready) {
        $('connLabel').textContent = 'Offline'
        $('connDot').className = 'conn-dot offline'
        addLog('Backend unreachable after 12s', 'error')
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

    $('refreshBtn').addEventListener('click', handleRefresh)
    $('settingsBtn').addEventListener('click', openSettings)
    $('clearChatBtn').addEventListener('click', clearChat)
    $('manageModelsBtn').addEventListener('click', openSettings)
    $('termToggleBtn').addEventListener('click', toggleTerminal)
    $('termClearBtn').addEventListener('click', () => { terminalLog = []; renderTerminal() })
    $('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) sendChat() })
    $('sendBtn').addEventListener('click', sendChat)
    $('chartRetryBtn').addEventListener('click', loadCoinData)

    document.querySelectorAll('.chip').forEach(btn => {
        btn.addEventListener('click', () => {
            $('chatInput').value = btn.dataset.msg
            sendChat()
        })
    })

    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
        if (e.key === '`' || e.key === '~') toggleTerminal()
    })
}

async function waitForBackend() {
    for (let i = 0; i < 24; i++) {
        try {
            const r = await fetch(`${API}/health`)
            if (r.ok) return true
        } catch {}
        await sleep(500)
    }
    return false
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function checkSettings() {
    try {
        const r = await fetch(`${API}/get-settings`)
        const data = await r.json()
        if (!data.setup_complete) openSetupModal()
    } catch {}
}

async function loadModels() {
    try {
        const r = await fetch(`${API}/models`)
        const data = await r.json()
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
        }

        select.addEventListener('change', () => { activeModel = select.value })
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
            <span>${m}</span>
            ${m === activeModel ? '<span class="model-active-tag">ACTIVE</span>' : ''}
        </div>
    `).join('')
}

function setupCoinList() {
    const list = $('coinList')
    list.innerHTML = COINS.map(c => `
        <button class="coin-btn ${c.symbol === activeCoin.symbol ? 'active' : ''}" data-symbol="${c.symbol}">
            <span class="coin-sym">${c.symbol}</span>
            <span class="coin-nm">${c.name}</span>
        </button>
    `).join('')

    list.querySelectorAll('.coin-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const coin = COINS.find(c => c.symbol === btn.dataset.symbol)
            if (coin && coin.symbol !== activeCoin.symbol) {
                activeCoin = coin
                list.querySelectorAll('.coin-btn').forEach(b => b.classList.remove('active'))
                btn.classList.add('active')
                chatHistory = []
                clearChat()
                loadCoinData()
            }
        })
    })
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
        layout: {
            background: { color: 'transparent' },
            textColor: '#5a7fa0'
        },
        grid: {
            vertLines: { color: 'rgba(25,38,56,0.8)' },
            horzLines: { color: 'rgba(25,38,56,0.8)' }
        },
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

    volumeSeries = chart.addHistogramSeries({
        priceFormat: { type: 'volume' },
        priceScaleId: 'vol'
    })
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })

    const observer = new ResizeObserver(() => {
        chart.applyOptions({ width: container.clientWidth, height: container.clientHeight })
    })
    observer.observe(container)
}

async function loadCoinData() {
    $('chartSymbol').textContent = `${activeCoin.symbol}/USDT`
    const tag = $('chartIntervalTag')
    if (tag) tag.textContent = activeInterval.toUpperCase()
    showChartLoading()

    addLog(`Selected symbol: ${activeCoin.symbol}`)

    await Promise.all([loadChart(), loadInsight()])
    loadRefresh()
}

async function loadChart() {
    try {
        const r = await fetch(`${API}/price?symbol=${activeCoin.ticker}&interval=${activeInterval}&limit=200`)
        const data = await r.json()
        if (data.error) throw new Error(data.error)

        const candles = data.candles
        candleSeries.setData(candles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })))
        volumeSeries.setData(candles.map(c => ({
            time: c.time,
            value: c.volume,
            color: c.close >= c.open ? 'rgba(0,232,122,0.25)' : 'rgba(255,51,85,0.25)'
        })))
        chart.timeScale().fitContent()

        const latest = candles[candles.length - 1]
        const first  = candles[0]
        const change = ((latest.close - first.close) / first.close) * 100

        $('chartCurrentPrice').textContent = formatPrice(latest.close)
        const changeEl = $('chartPriceChange')
        changeEl.textContent = (change >= 0 ? '+' : '') + change.toFixed(2) + '%'
        changeEl.className = 'chart-delta ' + (change >= 0 ? 'up' : 'down')

        hideChartLoading()
        hideChartError()
    } catch (e) {
        hideChartLoading()
        showChartError(e.message || 'Failed to load chart data')
        addLog(`Chart load failed: ${e.message}`, 'error')
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
        $('insightBody').innerHTML = `<div style="color:var(--down);font-size:11px;padding:8px">${e.message || 'Failed to load insight'}</div>`
        addLog(`Insight load failed: ${e.message}`, 'error')
    }
}

async function loadRefresh() {
    const sentEl = $('sentimentBody')
    if (sentEl) {
        sentEl.innerHTML = '<div class="sent-loading"><div class="spin spin--sm"></div><span>Fetching Reddit &amp; running sentiment…</span></div>'
    }

    if (!activeModel) {
        if (sentEl) sentEl.innerHTML = '<div class="sent-placeholder"><span class="sm-dot"></span><span>No model loaded — sentiment unavailable</span></div>'
        addLog('No Ollama model loaded, skipping sentiment', 'error')
        return
    }

    try {
        addLog(`Starting refresh pipeline for ${activeCoin.symbol}`)
        const r = await fetch(`${API}/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                symbol: activeCoin.symbol,
                interval: activeInterval,
                model: activeModel
            })
        })
        const data = await r.json()

        if (data.log && data.log.length) {
            data.log.forEach(l => addLog(l))
        }

        if (data.sentiment) {
            renderSentiment(data.sentiment)
            priceContext += `\nReddit sentiment: ${data.sentiment.label} (score: ${data.sentiment.score.toFixed(2)}, confidence: ${data.sentiment.confidence.toFixed(2)})\nSentiment summary: ${data.sentiment.summary}`
        } else {
            if (sentEl) sentEl.innerHTML = '<div class="sent-placeholder"><span class="sm-dot"></span><span>Sentiment unavailable</span></div>'
        }
    } catch (e) {
        addLog(`Refresh pipeline failed: ${e.message}`, 'error')
        if (sentEl) sentEl.innerHTML = '<div class="sent-placeholder"><span class="sm-dot offline"></span><span>Sentiment unavailable</span></div>'
    }
}

function renderInsight(data) {
    const dir     = data.direction.toLowerCase()
    const chgClass = data.change_24h >= 0 ? 'up' : 'down'
    $('insightBody').innerHTML = `
        <div class="insight-dir-row">
            <div class="dir-label ${dir}">
                <span class="dir-dot"></span>
                ${data.direction}
            </div>
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
        <div class="insight-reason">${data.reason}</div>
    `
}

function renderSentiment(data) {
    const el = $('sentimentBody')
    if (!el) return
    const label      = data.label.toLowerCase()
    const scoreVal   = Math.round(data.score * 100)
    const confVal    = Math.round(data.confidence * 100)
    el.innerHTML = `
        <div class="sent-row-label">Reddit Sentiment</div>
        <div class="sent-header">
            <span class="sent-label ${label}">${data.label}</span>
            <span class="conf-badge">${confVal}% conf</span>
        </div>
        <div class="sent-bar-row">
            <div class="sent-bar">
                <div class="sent-fill ${label}" style="width:${scoreVal}%"></div>
            </div>
            <span class="sent-score">${scoreVal}%</span>
        </div>
        <div class="sent-summary">${escapeHtml(data.summary)}</div>
    `
}

async function sendChat() {
    if (isChatLoading) return
    const input   = $('chatInput')
    const message = input.value.trim()
    if (!message) return

    if (!activeModel) {
        addMessage('assistant', 'No model selected. Please install and select a model in Settings.')
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
                model: activeModel,
                symbol: activeCoin.symbol,
                timeframe: activeInterval,
                price_context: priceContext,
                history: chatHistory.slice(-10)
            })
        })
        const data = await r.json()
        removeThinking(thinkingId)
        addMessage('assistant', data.reply)
        chatHistory.push({ role: 'assistant', content: data.reply })
    } catch (e) {
        removeThinking(thinkingId)
        addMessage('assistant', 'Failed to reach Ollama. Make sure it is running.')
    } finally {
        isChatLoading = false
        $('sendBtn').disabled = false
    }
}

function hideChatEmpty() {
    const el = $('chatMessages').querySelector('.chat-empty')
    if (el) el.remove()
}

function addMessage(role, content) {
    const msgs = $('chatMessages')
    const el   = document.createElement('div')
    el.className = `msg ${role}`
    el.innerHTML = `
        <div class="msg-role">${role === 'user' ? 'You' : 'Analyst'}</div>
        <div class="msg-body">${escapeHtml(content)}</div>
    `
    msgs.appendChild(el)
    msgs.scrollTop = msgs.scrollHeight
    return el
}

function addThinking() {
    const msgs = $('chatMessages')
    const id   = 'thinking-' + Date.now()
    const el   = document.createElement('div')
    el.className = 'msg assistant'
    el.id = id
    el.innerHTML = `
        <div class="msg-role">Analyst</div>
        <div class="thinking-body"><span></span><span></span><span></span></div>
    `
    msgs.appendChild(el)
    msgs.scrollTop = msgs.scrollHeight
    return id
}

function removeThinking(id) {
    const el = document.getElementById(id)
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
        </div>
    `
    msgs.querySelectorAll('.chip').forEach(btn => {
        btn.addEventListener('click', () => {
            $('chatInput').value = btn.dataset.msg
            sendChat()
        })
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
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ binance_api_key: key, setup_complete: true })
        })
    } catch {}
    if (model) { activeModel = model; $('modelSelect').value = activeModel }
    $('setupModal').classList.add('hidden')
}

async function skipSetup() {
    try {
        await fetch(`${API}/save-settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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
        const data = await r.json()
        $('settingsApiKey').value = data.binance_api_key || ''
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
        chip.addEventListener('click', () => {
            $('installModelInput').value = chip.dataset.model
        })
    })

    $('settingsModal').addEventListener('click', (e) => {
        if (e.target === $('settingsModal')) $('settingsModal').classList.add('hidden')
    })
}

async function saveApiKey() {
    const key = $('settingsApiKey').value.trim()
    try {
        await fetch(`${API}/save-settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: name })
        })
        const data = await r.json()
        if (data.success) {
            statusText.textContent = `✓ ${name} installed`
            $('installModelInput').value = ''
            addLog(`Model ${name} installed`, 'success')
            await loadModels()
        } else {
            statusText.textContent = `Error: ${data.error || 'Failed'}`
            addLog(`Model pull failed: ${data.error}`, 'error')
        }
    } catch (e) {
        statusText.textContent = `Error: ${e.message}`
        addLog(`Model pull error: ${e.message}`, 'error')
    } finally {
        btn.disabled = false
        setTimeout(() => statusEl.classList.add('hidden'), 4000)
    }
}

async function handleRefresh() {
    const icon = $('refreshIcon')
    icon.style.display = 'inline-block'
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
    if (insightRefreshTimer)   clearInterval(insightRefreshTimer)
    if (chartRefreshTimer)     clearInterval(chartRefreshTimer)
    if (sentimentRefreshTimer) clearInterval(sentimentRefreshTimer)
    insightRefreshTimer   = setInterval(loadInsight,  30000)
    chartRefreshTimer     = setInterval(loadChart,    60000)
    sentimentRefreshTimer = setInterval(loadRefresh, 300000)
}

function showChartLoading() { $('chartLoading').style.display = 'flex' }
function hideChartLoading() { $('chartLoading').style.display = 'none' }
function showChartError(msg) {
    $('chartError').classList.remove('hidden')
    $('chartErrorMsg').textContent = msg
}
function hideChartError() { $('chartError').classList.add('hidden') }

function formatPrice(price) {
    if (!price && price !== 0) return '—'
    if (price >= 1000) return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    if (price >= 1)    return price.toFixed(4)
    return price.toFixed(6)
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>')
}

document.addEventListener('DOMContentLoaded', init)