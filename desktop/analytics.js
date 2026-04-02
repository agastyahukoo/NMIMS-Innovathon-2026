const API = 'http://localhost:5000'
let pnlChart    = null
let allSignals  = []
let activeTab   = 'backtest'

function $(id) { return document.getElementById(id) }

function fmt(n, digits=1) { return (n * 100).toFixed(digits) + '%' }

function tsToTime(ts) {
    const d = new Date(ts * 1000)
    return d.toLocaleDateString('en-US', { month:'short', day:'numeric' }) +
           ' ' + d.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', hour12:false })
}

function formatPrice(p) {
    if (!p && p !== 0) return '—'
    if (p >= 1000) return '$' + p.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 })
    if (p >= 1)    return '$' + p.toFixed(4)
    return '$' + p.toFixed(6)
}

function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}

let mlPnlChart = null

function switchTab(tab) {
    activeTab = tab
    $('backtestPane').classList.toggle('hidden', tab !== 'backtest')
    $('signalsPane').classList.toggle('hidden',  tab !== 'signals')
    $('mlPane').classList.toggle('hidden',       tab !== 'ml')
    $('tabBacktest').classList.toggle('active', tab === 'backtest')
    $('tabSignals').classList.toggle('active',  tab === 'signals')
    $('tabML').classList.toggle('active',       tab === 'ml')

    if (tab === 'signals' && allSignals.length === 0) loadSignalHistory()
}

document.addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style')
    style.textContent = `
        :root {
            --up: #32d74b; --down: #ff453a; --neutral: #ffd60a;
            --bg: #000; --bg-1: #0d0d0d; --bg-2: #141414;
            --line: rgba(255,255,255,0.07); --text-0: rgba(255,255,255,0.92);
            --text-1: rgba(255,255,255,0.55); --text-2: rgba(255,255,255,0.24);
            --text-3: rgba(255,255,255,0.10);
        }
    `
    document.head.appendChild(style)

    $('atThreshold').addEventListener('input', () => {
        $('atThresholdVal').textContent = $('atThreshold').value + '%'
    })
    $('atRunBtn').addEventListener('click', runBacktest)

    $('tabBacktest').addEventListener('click', () => switchTab('backtest'))
    $('tabSignals').addEventListener('click', () => switchTab('signals'))
    $('tabML').addEventListener('click', () => switchTab('ml'))

    $('mlRunBtn').addEventListener('click', runMLEvaluation)

    $('shRefreshBtn').addEventListener('click', loadSignalHistory)
    $('shEvalBtn').addEventListener('click', evaluateOutcomes)
    $('shSymbol').addEventListener('change', renderFilteredSignals)
    $('shAction').addEventListener('change', renderFilteredSignals)
    $('shSource').addEventListener('change', renderFilteredSignals)

    const hashTab = window.location.hash.replace('#', '')
    switchTab(['signals','ml','backtest'].includes(hashTab) ? hashTab : 'backtest')
})



async function loadSignalHistory() {
    const symbol = $('shSymbol').value

    $('shStatusText').classList.add('hidden')
    $('shLoading').classList.remove('hidden')
    $('shLoadingText').textContent = 'Loading signal history…'
    $('shBody').innerHTML = ''

    try {
        const url = symbol
            ? `${API}/signal-history?symbol=${symbol}&limit=200`
            : `${API}/signal-history?limit=200`
        const r    = await fetch(url)
        const data = await r.json()
        allSignals = data.signals || []

        const noprice = allSignals.filter(s => !s.price_at_signal).length
        const wins    = data.wins    || 0
        const losses  = data.losses  || 0
        const pending = data.pending || 0
        const wr      = data.win_rate

        $('shSummary').classList.remove('hidden')
        $('shTotal').textContent   = data.total || 0
        $('shWinRate').textContent = wr !== null ? (wr * 100).toFixed(1) + '%' : 'N/A'
        $('shWinRate').style.color = wr === null ? '' : wr >= 0.55 ? 'var(--up)' : wr >= 0.45 ? 'var(--neutral)' : 'var(--down)'
        $('shWins').textContent    = wins
        $('shLosses').textContent  = losses
        $('shPending').textContent = pending
        $('shNoprice').textContent = noprice

        renderFilteredSignals()

        $('shLoading').classList.add('hidden')
        $('shStatusText').classList.remove('hidden')
        $('shStatusText').textContent = `Loaded ${allSignals.length} signals — pipeline signals with price data are evaluated after 1 hour`

    } catch (e) {
        $('shLoading').classList.add('hidden')
        $('shStatusText').classList.remove('hidden')
        $('shStatusText').textContent = '⚠ Failed to load: ' + e.message
        $('shStatusText').style.color = 'var(--down)'
    }
}

function renderFilteredSignals() {
    const filterSymbol = $('shSymbol').value.toUpperCase()
    const filterAction = $('shAction').value.toUpperCase()
    const filterSource = $('shSource').value

    let signals = allSignals.slice()
    if (filterSymbol) signals = signals.filter(s => s.symbol === filterSymbol)
    if (filterAction) signals = signals.filter(s => s.action === filterAction)
    if (filterSource) signals = signals.filter(s => s.source === filterSource)

    const tbody = $('shBody')

    if (!signals.length) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:rgba(255,255,255,0.2);padding:24px">No signals found with current filters</td></tr>`
        return
    }

    tbody.innerHTML = signals.map(s => {
        const outcome   = s.outcome
        const hasPriceData = !!s.price_at_signal
        const source    = s.source || 'forecast'
        const interval  = s.interval || '—'

        let outcomeHtml
        if (!hasPriceData) {
            outcomeHtml = `<span class="sh-outcome sh-outcome--noprice">NO PRICE</span>`
        } else if (!outcome) {
            outcomeHtml = `<span class="sh-outcome sh-outcome--pending">PENDING</span>`
        } else if (outcome === 'WIN') {
            outcomeHtml = `<span class="sh-outcome sh-outcome--win">WIN</span>`
        } else if (outcome === 'LOSS') {
            outcomeHtml = `<span class="sh-outcome sh-outcome--loss">LOSS</span>`
        } else {
            outcomeHtml = `<span class="sh-outcome sh-outcome--neutral">NEUTRAL</span>`
        }

        const entryPrice = s.price_at_signal ? formatPrice(s.price_at_signal) : '—'
        const exitPrice  = s.price_at_eval   ? formatPrice(s.price_at_eval)   : '—'

        let pctHtml = ''
        if (s.price_at_signal && s.price_at_eval) {
            const pct = ((s.price_at_eval - s.price_at_signal) / s.price_at_signal) * 100
            const cl  = pct >= 0 ? 'up' : 'dn'
            pctHtml   = ` <span class="log-num ${cl}" style="font-size:9px">(${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)</span>`
        }

        return `<tr>
            <td class="log-ts">${tsToTime(s.created_at)}</td>
            <td><span class="sh-coin">${escHtml(s.symbol)}</span></td>
            <td><span class="log-action ${s.action.toLowerCase()}">${escHtml(s.action)}</span></td>
            <td class="log-num">${(s.confidence * 100).toFixed(0)}%</td>
            <td class="log-num">${entryPrice}</td>
            <td class="log-num">${exitPrice}${pctHtml}</td>
            <td>${outcomeHtml}</td>
            <td class="sh-source">${escHtml(source)} <span style="color:rgba(255,255,255,0.15)">${interval}</span></td>
        </tr>`
    }).join('')
}

async function evaluateOutcomes() {
    const btn = $('shEvalBtn')
    btn.disabled = true
    btn.textContent = '⚙ Evaluating…'
    $('shStatusText').textContent = 'Running outcome evaluation — checking signals older than 1 hour…'

    try {
        const r    = await fetch(`${API}/evaluate-outcomes`, { method: 'POST' })
        const data = await r.json()
        btn.textContent = '⚙ Evaluate Outcomes'
        btn.disabled = false
        $('shStatusText').textContent = `Evaluated ${data.evaluated} signal${data.evaluated !== 1 ? 's' : ''} — refreshing…`
        await loadSignalHistory()
    } catch (e) {
        btn.textContent = '⚙ Evaluate Outcomes'
        btn.disabled = false
        $('shStatusText').textContent = '⚠ Evaluation failed: ' + e.message
    }
}

async function runBacktest() {
    const symbol    = $('atSymbol').value
    const interval  = $('atInterval').value
    const horizon   = parseInt($('atHorizon').value)
    const threshold = parseInt($('atThreshold').value) / 100
    const lookback  = parseInt($('atLookback').value)

    setLoading(true, 'Fetching ' + lookback + ' candles for ' + symbol + '…')

    try {
        const r = await fetch(`${API}/backtest`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ symbol, interval, horizon_candles: horizon,
                                     confidence_threshold: threshold, lookback })
        })

        if (!r.ok) {
            const err = await r.json()
            throw new Error(err.error || 'Server error')
        }

        const data = await r.json()
        if (data.error) throw new Error(data.error)

        setLoading(false)
        renderResults(data)
    } catch (e) {
        setLoading(false, null, e.message || 'Backtest failed')
    }
}

function setLoading(loading, text, errMsg) {
    $('statusIdle').classList.toggle('hidden', loading || !!errMsg)
    $('statusLoading').classList.toggle('hidden', !loading)
    $('statusError').classList.toggle('hidden', !errMsg)
    if (text)   $('statusText').textContent = text
    if (errMsg) $('statusError').textContent = '⚠ ' + errMsg
    $('atRunBtn').disabled = loading
}

function renderResults(d) {
    $('atMetrics').classList.remove('hidden')
    $('atSubtitle').textContent =
        `${d.symbol} · ${d.interval} · horizon ${d.signal_log?.[0]?.action ? $('atHorizon').value : '?'} candles · ` +
        `${d.total_candles} candles analysed`

    const wr = d.win_rate
    $('mvWinRate').textContent = fmt(wr)
    $('mvWinRate').style.color = wr >= 0.55 ? 'var(--up)' : wr >= 0.45 ? 'var(--neutral)' : 'var(--down)'
    $('mcWinRate').style.borderColor = $('mvWinRate').style.color

    $('mvSignals').textContent = d.active_signals + ' (' + d.total_signals + ' total)'

    const sh = d.sharpe
    $('mvSharpe').textContent = sh.toFixed(2)
    $('mvSharpe').style.color = sh >= 1 ? 'var(--up)' : sh >= 0 ? 'var(--neutral)' : 'var(--down)'

    const cr = d.cumulative_return
    $('mvCumRet').textContent = (cr >= 0 ? '+' : '') + fmt(cr)
    $('mvCumRet').style.color = cr >= 0 ? 'var(--up)' : 'var(--down)'

    const ar = d.avg_return
    $('mvAvgRet').textContent = (ar >= 0 ? '+' : '') + fmt(ar, 3)
    $('mvAvgRet').style.color = ar >= 0 ? 'var(--up)' : 'var(--down)'

    $('mvBuySell').textContent = `${d.buy_signals} / ${d.sell_signals} / ${d.hold_signals}`

    renderChart(d.pnl_curve)
    renderLog(d.signal_log || [])
    $('statusIdle').classList.remove('hidden')
    $('statusIdle').textContent =
        `✓  Backtest complete — ${d.active_signals} signals, win rate ${fmt(wr)}, Sharpe ${sh.toFixed(2)}`
}

function renderChart(pnlCurve) {
    const canvas = $('pnlChart')
    if (pnlChart) { pnlChart.destroy(); pnlChart = null }

    const labels       = pnlCurve.map((_, i) => i === 0 ? 'Start' : 'Trade ' + i)
    const positiveColor = 'rgba(50, 215, 75, 0.8)'
    const negativeColor = 'rgba(255, 69, 58, 0.8)'
    const lastVal       = pnlCurve[pnlCurve.length - 1] || 0

    pnlChart = new Chart(canvas, {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: 'Cumulative Return',
                data:  pnlCurve,
                borderColor: lastVal >= 0 ? positiveColor : negativeColor,
                backgroundColor: lastVal >= 0
                    ? 'rgba(50,215,75,0.06)' : 'rgba(255,69,58,0.06)',
                borderWidth: 1.5,
                pointRadius: 0,
                tension: 0.3,
                fill: true
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode:'index', intersect:false },
            plugins: {
                legend: { display:false },
                tooltip: {
                    backgroundColor: '#1a1a1a',
                    borderColor: 'rgba(255,255,255,0.08)',
                    borderWidth: 1,
                    titleColor: 'rgba(255,255,255,0.6)',
                    bodyColor: 'rgba(255,255,255,0.9)',
                    callbacks: {
                        label: ctx => {
                            const v = ctx.raw
                            return ` ${(v >= 0 ? '+' : '') + (v * 100).toFixed(2)}%`
                        }
                    }
                }
            },
            scales: {
                x: {
                    ticks: { color:'rgba(255,255,255,0.2)', maxTicksLimit:8, font:{ family:'JetBrains Mono', size:9 } },
                    grid:  { color:'rgba(255,255,255,0.04)' }
                },
                y: {
                    ticks: {
                        color: 'rgba(255,255,255,0.2)',
                        font:  { family:'JetBrains Mono', size:9 },
                        callback: v => (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%'
                    },
                    grid: { color:'rgba(255,255,255,0.06)' }
                }
            }
        }
    })
}

function renderLog(log) {
    $('logCount').textContent = log.length + ' entries'
    const tbody    = $('logBody')
    const relevant = log.filter(s => s.action !== 'HOLD').reverse()
    tbody.innerHTML = relevant.map(s => {
        const isWin   = s.result === 'WIN'
        const retSign = s.return >= 0 ? '+' : ''
        return `<tr>
            <td class="log-ts">${tsToTime(s.ts)}</td>
            <td><span class="log-action ${s.action.toLowerCase()}">${s.action}</span></td>
            <td class="log-num">${(s.confidence * 100).toFixed(0)}%</td>
            <td class="log-num ${s.actual === 'UP' ? 'up' : s.actual === 'DOWN' ? 'dn' : ''}">${s.actual}</td>
            <td><span class="log-result ${isWin ? 'win' : 'loss'}">${s.result}</span></td>
            <td class="log-num ${s.return >= 0 ? 'up' : 'dn'}">${retSign}${s.return.toFixed(2)}%</td>
        </tr>`
    }).join('')

    if (!relevant.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:rgba(255,255,255,0.2);padding:20px">No active signals generated with current parameters</td></tr>'
    }
}

async function runMLEvaluation() {
    const symbol   = $('mlSymbol').value
    const interval = $('mlInterval').value
    const horizon  = parseInt($('mlHorizon').value)
    const lookback = parseInt($('mlLookback').value)

    $('mlStatusIdle').classList.add('hidden')
    $('mlStatusError').classList.add('hidden')
    $('mlStatusLoading').classList.remove('hidden')
    $('mlStatusText').textContent = 'Fetching candles and training Prophet model\u2026 (30-90 seconds)'
    $('mlRunBtn').disabled = true
    $('mlInstallNote').classList.add('hidden')
    $('mlSummary').classList.add('hidden')
    $('mlBody').classList.add('hidden')

    try {
        const r = await fetch(`${API}/ml-evaluate`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ symbol, interval, horizon_candles: horizon, lookback })
        })
        const data = await r.json()

        if (data.error) {
            if (data.prophet_available === false) {
                $('mlInstallNote').classList.remove('hidden')
                $('mlInstallText').textContent =
                    'Prophet not installed. Run: pip install prophet scikit-learn  \u2014 then restart the backend.'
            }
            $('mlStatusLoading').classList.add('hidden')
            $('mlStatusError').classList.remove('hidden')
            $('mlStatusError').textContent = '\u26a0 ' + data.error
            return
        }

        renderMLResults(data)

        $('mlStatusLoading').classList.add('hidden')
        $('mlStatusIdle').classList.remove('hidden')
        const lift = ((data.directional_accuracy - data.baseline_accuracy) * 100).toFixed(1)
        const liftSign = lift >= 0 ? '+' : ''
        $('mlStatusIdle').textContent =
            `\u2713  Evaluation complete \u2014 ${data.train_candles} train / ${data.test_candles} test candles \u00b7 ` +
            `${symbol} ${interval} \u00b7 horizon ${horizon} \u00b7 ` +
            `accuracy ${(data.directional_accuracy * 100).toFixed(1)}% (${liftSign}${lift}% vs baseline)`

    } catch (e) {
        $('mlStatusLoading').classList.add('hidden')
        $('mlStatusError').classList.remove('hidden')
        $('mlStatusError').textContent = '\u26a0 ' + (e.message || 'Evaluation failed')
    } finally {
        $('mlRunBtn').disabled = false
    }
}

function renderMLResults(d) {
    $('mlSummary').classList.remove('hidden')
    $('mlBody').classList.remove('hidden')

    const acc      = d.directional_accuracy
    const baseline = d.baseline_accuracy || 0.5
    const lift     = acc - baseline

    $('mlAccuracy').textContent    = (acc * 100).toFixed(1) + '%'
    $('mlAccuracy').style.color    = acc >= 0.55 ? 'var(--up)' : acc >= 0.45 ? 'var(--neutral)' : 'var(--down)'
    $('mlAccuracySub').textContent = `precision ${(d.precision * 100).toFixed(0)}%  recall ${(d.recall * 100).toFixed(0)}%`
    $('mlBaseline').textContent    = (baseline * 100).toFixed(1) + '%'

    const liftPct = (lift * 100).toFixed(1)
    $('mlLift').textContent     = (lift >= 0 ? '+' : '') + liftPct + '%'
    $('mlLift').style.color     = lift > 0 ? 'var(--up)' : lift < -0.01 ? 'var(--down)' : 'var(--neutral)'

    $('mlSharpe').textContent   = d.ml_sharpe.toFixed(3)
    $('mlSharpe').style.color   = d.ml_sharpe >= 1 ? 'var(--up)' : d.ml_sharpe >= 0 ? 'var(--neutral)' : 'var(--down)'

    $('mlBhSharpe').textContent = d.bh_sharpe.toFixed(3)
    $('mlBhSharpe').style.color = d.bh_sharpe >= 1 ? 'var(--up)' : d.bh_sharpe >= 0 ? 'var(--neutral)' : 'var(--down)'

    const alpha = d.alpha * 100
    $('mlAlpha').textContent    = (alpha >= 0 ? '+' : '') + alpha.toFixed(2) + '%'
    $('mlAlpha').style.color    = alpha > 0 ? 'var(--up)' : alpha < 0 ? 'var(--down)' : 'var(--neutral)'

    if (d.technical_accuracy !== null && d.technical_accuracy !== undefined) {
        $('mlTechAcc').textContent = (d.technical_accuracy * 100).toFixed(1) + '%'
        const edge = d.ml_vs_tech_edge
        if (edge !== null && edge !== undefined) {
            $('mlEdge').textContent  = (edge >= 0 ? '+' : '') + (edge * 100).toFixed(1) + '%'
            $('mlEdge').style.color  = edge > 0 ? 'var(--up)' : edge < -0.01 ? 'var(--down)' : 'var(--neutral)'
        }
    } else {
        $('mlTechAcc').textContent = 'N/A'
        $('mlEdge').textContent    = 'N/A'
    }

    renderMLPnlChart(d.pnl_ml || [], d.pnl_bh || [])
    renderMLConfusionMatrix(d.confusion_matrix)
    renderMLReportTable(d)

    const trainFrom = new Date(d.train_from * 1000).toLocaleDateString('en-US', {month:'short', day:'numeric', year:'2-digit'})
    const trainTo   = new Date(d.train_to   * 1000).toLocaleDateString('en-US', {month:'short', day:'numeric', year:'2-digit'})
    const testFrom  = new Date(d.test_from  * 1000).toLocaleDateString('en-US', {month:'short', day:'numeric', year:'2-digit'})
    const testTo    = new Date(d.test_to    * 1000).toLocaleDateString('en-US', {month:'short', day:'numeric', year:'2-digit'})
    $('mlSplitInfo').textContent =
        `Train: ${trainFrom} \u2013 ${trainTo} (${d.train_candles} candles) \u00b7 ` +
        `Test: ${testFrom} \u2013 ${testTo} (${d.test_candles} candles)`
}

function renderMLPnlChart(mlPnl, bhPnl) {
    if (mlPnlChart) { mlPnlChart.destroy(); mlPnlChart = null }
    const canvas = $('mlPnlChart')
    const n      = Math.max(mlPnl.length, bhPnl.length)
    const labels = Array.from({length: n}, (_, i) => i === 0 ? 'Start' : `${i}`)

    mlPnlChart = new Chart(canvas, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'ML Strategy',
                    data:  mlPnl,
                    borderColor:     'rgba(50,215,75,0.85)',
                    backgroundColor: 'rgba(50,215,75,0.06)',
                    borderWidth: 1.5, pointRadius: 0, tension: 0.3, fill: true
                },
                {
                    label: 'Buy & Hold',
                    data:  bhPnl,
                    borderColor:     'rgba(90,127,160,0.7)',
                    backgroundColor: 'rgba(90,127,160,0.04)',
                    borderWidth: 1, pointRadius: 0, tension: 0.3, fill: true,
                    borderDash: [4, 3]
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: {
                    display: true,
                    labels: { color: 'rgba(255,255,255,0.4)', font: { family: 'JetBrains Mono', size: 9 }, boxWidth: 16 }
                },
                tooltip: {
                    backgroundColor: '#1a1a1a', borderColor: 'rgba(255,255,255,0.08)', borderWidth: 1,
                    titleColor: 'rgba(255,255,255,0.4)', bodyColor: 'rgba(255,255,255,0.9)',
                    callbacks: { label: ctx => ` ${ctx.dataset.label}: ${(ctx.raw >= 0 ? '+' : '') + (ctx.raw * 100).toFixed(2)}%` }
                }
            },
            scales: {
                x: { ticks: { color: 'rgba(255,255,255,0.2)', maxTicksLimit: 8, font: { family: 'JetBrains Mono', size: 9 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
                y: { ticks: { color: 'rgba(255,255,255,0.2)', font: { family: 'JetBrains Mono', size: 9 }, callback: v => (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%' }, grid: { color: 'rgba(255,255,255,0.06)' } }
            }
        }
    })
}

function renderMLConfusionMatrix(cm) {
    if (!cm) return
    const { tp, fp, tn, fn } = cm
    const total = tp + fp + tn + fn
    function pct(n) { return total ? ((n / total) * 100).toFixed(0) + '%' : '—' }
    $('mlCMGrid').innerHTML = `
        <div class="ml-cm-labels">
            <div></div><div class="ml-cm-col-label">Pred UP</div><div class="ml-cm-col-label">Pred DOWN</div>
        </div>
        <div class="ml-cm-row">
            <div class="ml-cm-row-label">Act UP</div>
            <div class="ml-cm-cell ml-cm-tp" title="True Positive"><span class="ml-cm-val">${tp}</span><span class="ml-cm-pct">${pct(tp)}</span><span class="ml-cm-tag">TP</span></div>
            <div class="ml-cm-cell ml-cm-fn" title="False Negative"><span class="ml-cm-val">${fn}</span><span class="ml-cm-pct">${pct(fn)}</span><span class="ml-cm-tag">FN</span></div>
        </div>
        <div class="ml-cm-row">
            <div class="ml-cm-row-label">Act DOWN</div>
            <div class="ml-cm-cell ml-cm-fp" title="False Positive"><span class="ml-cm-val">${fp}</span><span class="ml-cm-pct">${pct(fp)}</span><span class="ml-cm-tag">FP</span></div>
            <div class="ml-cm-cell ml-cm-tn" title="True Negative"><span class="ml-cm-val">${tn}</span><span class="ml-cm-pct">${pct(tn)}</span><span class="ml-cm-tag">TN</span></div>
        </div>`
}

function renderMLReportTable(d) {
    const rows = [
        { cls: 'UP',   prec: d.precision, rec: d.recall, f1: d.f1_score },
        { cls: 'DOWN', prec: 1 - d.precision, rec: 1 - d.recall, f1: d.f1_score },
    ]
    $('mlReportBody').innerHTML = rows.map(r => {
        const pColor = r.prec >= 0.55 ? 'var(--up)' : r.prec >= 0.45 ? 'var(--neutral)' : 'var(--down)'
        const rColor = r.rec  >= 0.55 ? 'var(--up)' : r.rec  >= 0.45 ? 'var(--neutral)' : 'var(--down)'
        const fColor = r.f1   >= 0.55 ? 'var(--up)' : r.f1   >= 0.45 ? 'var(--neutral)' : 'var(--down)'
        return `<tr>
            <td><span class="log-action ${r.cls.toLowerCase()}">${r.cls}</span></td>
            <td class="log-num" style="color:${pColor}">${(r.prec * 100).toFixed(1)}%</td>
            <td class="log-num" style="color:${rColor}">${(r.rec  * 100).toFixed(1)}%</td>
            <td class="log-num" style="color:${fColor}">${(r.f1   * 100).toFixed(1)}%</td>
        </tr>`
    }).join('')
}