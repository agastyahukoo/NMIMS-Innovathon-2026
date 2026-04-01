const { app, BrowserWindow, ipcMain, shell } = require('electron')
const path = require('path')
const { spawn } = require('child_process')
const fs = require('fs')

let splashWindow = null
let mainWindow   = null
let backendProcess = null

const ALLOWED_URL_PROTOCOLS = ['https:', 'http:']

function startBackend() {
    const backendDir  = path.join(__dirname, '..', 'backend')
    const venvPython  = path.join(backendDir, 'venv', 'bin', 'python3')
    const python      = fs.existsSync(venvPython) ? venvPython : 'python3'
    const script      = path.join(backendDir, 'app.py')

    backendProcess = spawn(python, [script], {
        cwd:   backendDir,
        stdio: 'pipe',
        env:   { ...process.env }
    })

    backendProcess.stderr.on('data', (d) => console.error('Backend:', d.toString()))
    backendProcess.stdout.on('data', (d) => console.log('Backend:', d.toString()))
    backendProcess.on('close', (code) => console.log('Backend exited with code', code))
}

function createSplash() {
    splashWindow = new BrowserWindow({
        width: 480, height: 300,
        frame: false, transparent: true,
        alwaysOnTop: true, resizable: false, center: true,
        webPreferences: {
            nodeIntegration:  false,
            contextIsolation: true,
            sandbox:          true
        }
    })
    splashWindow.loadFile(path.join(__dirname, 'splash.html'))
}

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1440, height: 920,
        minWidth: 1100, minHeight: 700,
        show: false,
        titleBarStyle: 'hiddenInset',
        backgroundColor: '#060a12',
        webPreferences: {
            preload:          path.join(__dirname, 'preload.js'),
            nodeIntegration:  false,
            contextIsolation: true,
            sandbox:          true,
            webSecurity:      true
        }
    })

    mainWindow.loadFile(path.join(__dirname, 'index.html'))

    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

    mainWindow.once('ready-to-show', () => {
        setTimeout(() => {
            if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close()
            mainWindow.show()
            mainWindow.focus()
        }, 3800)
    })

    mainWindow.on('closed', () => { mainWindow = null })
}

app.whenReady().then(() => {
    startBackend()
    createSplash()
    setTimeout(createMainWindow, 400)
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
})

app.on('before-quit', () => {
    if (backendProcess) backendProcess.kill('SIGTERM')
})

app.on('window-all-closed', () => {
    if (backendProcess) backendProcess.kill('SIGTERM')
    if (process.platform !== 'darwin') app.quit()
})

ipcMain.handle('open-external', (_, url) => {
    try {
        const parsed = new URL(url)
        if (!ALLOWED_URL_PROTOCOLS.includes(parsed.protocol)) return
        shell.openExternal(url)
    } catch {}
})

ipcMain.handle('get-version', () => app.getVersion())