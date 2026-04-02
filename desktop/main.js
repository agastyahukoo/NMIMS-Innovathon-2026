const { app, BrowserWindow, ipcMain, shell, Menu, Notification } = require('electron')
const path   = require('path')
const { spawn } = require('child_process')
const fs     = require('fs')
const http   = require('http')

let splashWindow    = null
let mainWindow      = null
let analyticsWindow = null
let backendProcess  = null
let backendReady    = false
let backendKilled   = false
let installedModels = []
let activeModel     = ''
let activeCoin      = 'BTC'

const IS_MAC = process.platform === 'darwin'
const IS_DEV = process.env.NODE_ENV === 'development'
const ALLOWED_URL_PROTOCOLS = ['https:', 'http:']

const DEFAULT_COINS = [
    { symbol:'BTC', name:'Bitcoin',  ticker:'BTCUSDT', subreddits:['Bitcoin','CryptoCurrency'] },
    { symbol:'ETH', name:'Ethereum', ticker:'ETHUSDT', subreddits:['ethereum','CryptoCurrency'] },
    { symbol:'SOL', name:'Solana',   ticker:'SOLUSDT', subreddits:['solana','CryptoCurrency'] },
    { symbol:'BNB', name:'BNB',      ticker:'BNBUSDT', subreddits:['binance','CryptoCurrency'] },
    { symbol:'XRP', name:'XRP',      ticker:'XRPUSDT', subreddits:['XRP','CryptoCurrency'] },
]

const COINS_PATH = path.join(app.getPath('userData'), 'custom_coins.json')

function loadCoins() {
    try {
        if (fs.existsSync(COINS_PATH)) return JSON.parse(fs.readFileSync(COINS_PATH, 'utf8'))
    } catch {}
    return [...DEFAULT_COINS]
}

function saveCoins(coins) {
    try { fs.writeFileSync(COINS_PATH, JSON.stringify(coins, null, 2)) } catch {}
}

function killBackend() {
    if (backendKilled || !backendProcess) return
    backendKilled = true
    try { backendProcess.kill('SIGTERM') } catch {}
}

function resolvePython(backendDir) {
    const candidates = [
        path.join(backendDir, 'venv',       'bin', 'python3'),
        path.join(backendDir, '.venv',      'bin', 'python3'),
        path.join(backendDir, '..', '.venv','bin', 'python3'),
        path.join(backendDir, '..', 'venv', 'bin', 'python3'),
    ]
    for (const p of candidates) {
        if (fs.existsSync(p)) { console.log('Using python:', p); return p }
    }
    console.log('Falling back to system python3')
    return 'python3'
}

function startBackend() {
    const backendDir = path.join(__dirname, '..', 'backend')
    const python     = resolvePython(backendDir)
    const script     = path.join(backendDir, 'app.py')
    backendProcess   = spawn(python, [script], { cwd: backendDir, stdio: 'pipe', env: { ...process.env } })
    backendProcess.stdout.on('data', d => console.log('Backend:', d.toString()))
    backendProcess.stderr.on('data', d => console.error('Backend:', d.toString()))
    backendProcess.on('close', code => { console.log('Backend exited', code); backendReady = false })
}

function pollOnce(resolve) {
    const req = http.get('http://127.0.0.1:5000/health', res => { resolve(res.statusCode === 200) })
    req.on('error', () => resolve(false))
    req.setTimeout(500, () => { req.destroy(); resolve(false) })
}

function waitForBackend(attempts) {
    return new Promise(resolve => {
        let left = attempts
        const tryOnce = () => { pollOnce(ok => { if (ok) return resolve(true); if (--left <= 0) return resolve(false); setTimeout(tryOnce, 600) }) }
        tryOnce()
    })
}

function fetchModels() {
    return new Promise(resolve => {
        const req = http.get('http://127.0.0.1:5000/models', res => {
            let body = ''
            res.on('data', d => body += d)
            res.on('end', () => { try { resolve(JSON.parse(body).models || []) } catch { resolve([]) } })
        })
        req.on('error', () => resolve([]))
        req.setTimeout(3000, () => { req.destroy(); resolve([]) })
    })
}

async function refreshMenu() {
    installedModels = await fetchModels()
    Menu.setApplicationMenu(buildMenu())
}

function createAnalyticsWindow(startTab) {
    const tab = startTab || 'backtest'

    if (analyticsWindow && !analyticsWindow.isDestroyed()) {
        analyticsWindow.focus()
        analyticsWindow.loadFile(path.join(__dirname, 'analytics.html'), { hash: tab })
        return
    }
    analyticsWindow = new BrowserWindow({
        width:1100, height:720, minWidth:900, minHeight:600,
        title:'Backtesting & Analytics',
        backgroundColor:'#000000',
        webPreferences:{
            nodeIntegration:  false,
            contextIsolation: true,
            sandbox:          true,
            webSecurity:      true
        }
    })
    analyticsWindow.loadFile(path.join(__dirname, 'analytics.html'), { hash: tab })
    analyticsWindow.on('closed', () => { analyticsWindow = null })
    if (IS_MAC) analyticsWindow.setWindowButtonVisibility(true)
}

function buildMenu() {
    const coins = loadCoins()

    const coinItems = coins.map(c => ({
        label:   `${c.symbol}  —  ${c.name}`,
        type:    'radio',
        checked: c.symbol === activeCoin,
        click:   () => {
            activeCoin = c.symbol
            if (mainWindow) mainWindow.webContents.send('set-coin', c)
            Menu.setApplicationMenu(buildMenu())
        }
    }))

    const modelItems = installedModels.length === 0
        ? [{ label:'No models installed', enabled:false }]
        : installedModels.map(m => ({
            label:   m, type:'radio', checked: m === activeModel,
            click:   () => {
                activeModel = m
                if (mainWindow) mainWindow.webContents.send('set-model', m)
                Menu.setApplicationMenu(buildMenu())
            }
        }))

    const template = [
        ...(IS_MAC ? [{
            label: app.name,
            submenu: [
                { label:'About Crypto Terminal', click: () => { if (mainWindow) mainWindow.webContents.send('show-about') } },
                { type:'separator' },
                { role:'hide' }, { role:'hideOthers' }, { role:'unhide' },
                { type:'separator' },
                { role:'quit' }
            ]
        }] : []),

        {
            label: 'Market',
            submenu: [
                ...coinItems,
                { type:'separator' },
                { label:'Import Custom Market…', accelerator: IS_MAC ? 'Cmd+Shift+I' : 'Ctrl+Shift+I',
                  click: () => { if (mainWindow) mainWindow.webContents.send('open-custom-market') } },
                { label:'Manage Markets & Subreddits…', accelerator: IS_MAC ? 'Cmd+,' : 'Ctrl+,',
                  click: () => { if (mainWindow) mainWindow.webContents.send('open-market-manager') } },
                { type:'separator' },
                { label:'Refresh Data', accelerator: IS_MAC ? 'Cmd+R' : 'Ctrl+R',
                  click: () => { if (mainWindow) mainWindow.webContents.send('trigger-refresh') } }
            ]
        },

        {
            label: 'Models',
            submenu: [
                { label:`Active: ${activeModel || 'none'}`, enabled:false },
                { type:'separator' },
                ...modelItems,
                { type:'separator' },
                { label:'Download Model…', accelerator: IS_MAC ? 'Cmd+Shift+D' : 'Ctrl+Shift+D',
                  click: () => { if (mainWindow) mainWindow.webContents.send('open-model-download') } },
                { type:'separator' },
                { label:'Unload Active Model from RAM', enabled:!!activeModel,
                  click: () => { if (mainWindow) mainWindow.webContents.send('model-unload', activeModel) } },
                { label:'Reload Active Model into RAM', enabled:!!activeModel,
                  click: () => { if (mainWindow) mainWindow.webContents.send('model-load', activeModel) } },
                { type:'separator' },
                { label:'Delete Model…', enabled: installedModels.length > 0,
                  click: () => { if (mainWindow) mainWindow.webContents.send('open-model-delete') } },
                { label:'Refresh Model List', click: refreshMenu }
            ]
        },

        {
            label: 'View',
            submenu: [
                { label:'Toggle Terminal Log', click: () => { if (mainWindow) mainWindow.webContents.send('toggle-terminal') } },
                { type:'separator' },
                { role:'togglefullscreen' },
                ...(IS_DEV ? [
                    { type:'separator' },
                    { role:'reload' }, { role:'forceReload' }, { role:'toggleDevTools' }
                ] : [])
            ]
        },

        {
            label: 'Window',
            submenu: [
                { role:'minimize' }, { role:'zoom' },
                { type:'separator' },
                { label:'Backtesting & Analytics',
                  accelerator: IS_MAC ? 'Cmd+Shift+B' : 'Ctrl+Shift+B',
                  click: () => createAnalyticsWindow('backtest') },
                { label:'Signal History',
                  accelerator: IS_MAC ? 'Cmd+Shift+H' : 'Ctrl+Shift+H',
                  click: () => createAnalyticsWindow('signals') },
                { label:'ML Evaluation',
                  accelerator: IS_MAC ? 'Cmd+Shift+M' : 'Ctrl+Shift+M',
                  click: () => createAnalyticsWindow('ml') },
                ...(IS_MAC ? [
                    { type:'separator' },
                    { role:'front' }, { type:'separator' }, { role:'window' }
                ] : [{ role:'close' }])
            ]
        }
    ]

    return Menu.buildFromTemplate(template)
}

function createSplash() {
    splashWindow = new BrowserWindow({
        width:480, height:300, frame:false, transparent:true,
        alwaysOnTop:true, resizable:false, center:true,
        webPreferences:{ nodeIntegration:false, contextIsolation:true, sandbox:true }
    })
    splashWindow.loadFile(path.join(__dirname, 'splash.html'))
}

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width:1440, height:920, minWidth:1100, minHeight:700,
        show:false, titleBarStyle:'hiddenInset', backgroundColor:'#000000',
        webPreferences:{
            preload:          path.join(__dirname, 'preload.js'),
            nodeIntegration:  false,
            contextIsolation: true,
            sandbox:          true,
            webSecurity:      true
        }
    })
    mainWindow.loadFile(path.join(__dirname, 'index.html'))
    mainWindow.webContents.setWindowOpenHandler(() => ({ action:'deny' }))
    mainWindow.on('close', () => { killBackend(); mainWindow = null })
}

app.whenReady().then(async () => {
    Menu.setApplicationMenu(buildMenu())
    startBackend()
    createSplash()
    createMainWindow()

    const windowReady = new Promise(resolve => { mainWindow.once('ready-to-show', resolve) })
    const [backendOk]  = await Promise.all([waitForBackend(40), windowReady])
    backendReady = backendOk
    installedModels = await fetchModels()
    Menu.setApplicationMenu(buildMenu())

    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close()
    mainWindow.show()
    mainWindow.focus()

    app.on('activate', () => {
        if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus() }
    })
})

app.on('before-quit', killBackend)
app.on('window-all-closed', () => { killBackend(); app.quit() })

ipcMain.handle('open-external', (_, url) => {
    try { const p = new URL(url); if (ALLOWED_URL_PROTOCOLS.includes(p.protocol)) shell.openExternal(url) } catch {}
})
ipcMain.handle('get-version',       () => app.getVersion())
ipcMain.handle('backend-ready',     () => backendReady)
ipcMain.handle('get-coins',         () => loadCoins())
ipcMain.handle('save-coins',        (_, c) => { saveCoins(c); Menu.setApplicationMenu(buildMenu()) })
ipcMain.handle('set-active-coin',   (_, s) => { activeCoin = s; Menu.setApplicationMenu(buildMenu()) })
ipcMain.handle('set-active-model',  (_, n) => { activeModel = n; Menu.setApplicationMenu(buildMenu()) })
ipcMain.handle('refresh-menu',      async () => { await refreshMenu() })
ipcMain.handle('open-analytics',    () => createAnalyticsWindow('backtest'))
ipcMain.handle('show-notification', (_, { title, body }) => {
    try {
        if (Notification.isSupported()) new Notification({ title, body, silent:false }).show()
    } catch {}
})