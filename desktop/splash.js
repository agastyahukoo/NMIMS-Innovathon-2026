const steps = [
    { text: "Initializing", pct: 12 },
    { text: "Starting backend", pct: 30 },
    { text: "Loading market data", pct: 52 },
    { text: "Connecting to Ollama", pct: 70 },
    { text: "Preparing interface", pct: 88 },
    { text: "Ready", pct: 100 }
]

const fill = document.getElementById('progressFill')
const statusText = document.getElementById('statusText')
let i = 0

function runStep() {
    if (i >= steps.length) return
    const s = steps[i]
    fill.style.width = s.pct + '%'
    statusText.textContent = s.text
    i++
    if (i < steps.length) setTimeout(runStep, i === steps.length - 1 ? 700 : 440)
}

setTimeout(runStep, 200)