'use strict';

// DeepSeek Harness Desktop — Electron shell + process guardian (prototype).
//
// The desktop layer does NOT reimplement any Harness logic. It only:
//   1. shows a window immediately (loading screen),
//   2. spawns the upstream `@deepseek-ai/dsh` web server as a child process,
//   3. loads that URL into the window once it is reachable over HTTP,
//   4. tears the child down on quit.
//
// Data lives in the default ~/.dsh (or $DSH_HOME), so sessions created in the
// CLI are visible here and vice versa.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Early logging: write to %TEMP% so diagnostics are always available, even if
// Electron's userData directory was never initialized (the "no window" case).
// ---------------------------------------------------------------------------
const TMP_LOG = process.env.DSH_DESKTOP_LOG || path.join(os.tmpdir(), 'dsh-desktop.log');
function rawLog(msg) {
  const line = `${new Date().toISOString()} [pid=${process.pid}] ${msg}`;
  try {
    fs.appendFileSync(TMP_LOG, line + '\n');
  } catch (_) {
    /* best effort */
  }
}
rawLog('=== main.js loaded argv=' + JSON.stringify(process.argv) + ' ===');

const { app, BrowserWindow, shell, dialog } = require('electron');

// ---------------------------------------------------------------------------
// Chromium compatibility switches: prevent startup hangs on GPU-less hosts,
// VMs, and remote-desktop sessions (the classic "double-click but no window").
// ---------------------------------------------------------------------------
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
if (process.env.DSH_DESKTOP_NO_SANDBOX !== '0') {
  app.commandLine.appendSwitch('no-sandbox');
}

const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');

const APP_NAME = 'DeepSeek Harness Desktop';
const READY_TIMEOUT_MS = 45000;
const MAX_ATTEMPTS = 3;

const LOADING_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>${APP_NAME}</title>
<style>body{background:#0d1117;color:#e6edf3;font-family:Segoe UI,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0} .box{text-align:center} .spinner{width:28px;height:28px;border:3px solid #30363d;border-top-color:#2f81f7;border-radius:50%;margin:0 auto 16px;animation:spin 1s linear infinite} @keyframes spin{to{transform:rotate(360deg)}}</style></head>
<body><div class="box"><div class="spinner"></div><div>正在启动 DeepSeek Harness…</div></div></body></html>`;

let mainWindow = null;
let dshChild = null;
let dshLogFd = null;
let shuttingDown = false;
let userDataReady = false;

function log(...parts) {
  const msg = parts.map((p) => String(p)).join(' ');
  rawLog(msg);
  console.log('[desktop] ' + msg);
}

function resolveUserData() {
  try {
    return app.getPath('userData');
  } catch (_) {
    return path.join(os.tmpdir(), 'dsh-desktop-data');
  }
}

function ensureUserData() {
  const dir = resolveUserData();
  try {
    fs.mkdirSync(dir, { recursive: true });
    userDataReady = true;
  } catch (_) {
    userDataReady = false;
  }
  return dir;
}

// Absolute path of the upstream dsh CLI entry (lib/bin.js) inside this app's
// node_modules. `@deepseek-ai/dsh` has no "exports" field, so resolving the
// package.json subpath lands on the filesystem path directly.
function resolveDshBin() {
  const pkg = require.resolve('@deepseek-ai/dsh/package.json');
  return path.join(path.dirname(pkg), 'lib', 'bin.js');
}

function openDshLog() {
  const dir = ensureUserData();
  try {
    dshLogFd = fs.openSync(path.join(dir, 'dsh.log'), 'a');
  } catch (_) {
    dshLogFd = 'ignore'; // sentinel: discard child output
  }
}

function closeDshLog() {
  if (dshLogFd && dshLogFd !== 'ignore') {
    try {
      fs.closeSync(dshLogFd);
    } catch (_) {
      /* ignore */
    }
  }
  dshLogFd = null;
}

// Spawn the upstream dsh web server. Child stdout/stderr go to a log file
// (never a pipe), which keeps this path friendly to restricted environments
// and works identically in the packaged (double-click) build.
function spawnDsh(port) {
  const bin = resolveDshBin();
  // `--expose-internals` is required by the current upstream HMR plugin.
  const args = ['--expose-internals', bin, 'web', '--host', '127.0.0.1', '--port', String(port)];
  const stdio = dshLogFd && dshLogFd !== 'ignore' ? ['ignore', dshLogFd, dshLogFd] : 'ignore';

  if (process.env.DSH_DESKTOP_USE_SYSTEM_NODE === '1') {
    log('launch: system node');
    return spawn('node', args, { stdio });
  }
  log('launch: self-contained (Electron as Node), bin=' + bin);
  return spawn(process.execPath, args, {
    stdio,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  });
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

// Readiness = the dsh webserver answers HTTP on the loopback URL.
function waitForHttp(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - started > timeoutMs) {
          return reject(new Error(`no HTTP response at ${url} within ${timeoutMs}ms`));
        }
        setTimeout(attempt, 250);
      });
      req.setTimeout(1500, () => req.destroy());
    };
    attempt();
  });
}

function killDsh() {
  if (dshChild && dshChild.pid) {
    log('stopping dsh child', dshChild.pid);
    try {
      dshChild.kill();
    } catch (e) {
      log('kill error:', e && e.message);
    }
  }
  dshChild = null;
}

async function startDsh() {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const port = await findFreePort();
    const url = `http://127.0.0.1:${port}`;
    log(`attempt ${attempt}: port ${port}`);

    dshChild = spawnDsh(port);
    dshChild.on('exit', (code, signal) => {
      log(`dsh exited code=${code} signal=${signal}`);
      dshChild = null;
    });
    dshChild.on('error', (err) => log('dsh spawn error:', err && err.message));

    try {
      await waitForHttp(url, READY_TIMEOUT_MS);
      log('dsh ready at', url);
      return url;
    } catch (err) {
      log('attempt failed:', err.message);
      killDsh();
    }
  }
  throw new Error('DeepSeek Harness did not start after ' + MAX_ATTEMPTS + ' attempts');
}

function errorHtml(message) {
  const escaped = String(message || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${APP_NAME}</title>
<style>body{background:#0d1117;color:#e6edf3;font-family:Segoe UI,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0} .box{max-width:640px;padding:24px;border:1px solid #f85149;border-radius:8px;background:#161b22} pre{white-space:pre-wrap;word-break:break-word;color:#ffa198}</style></head>
<body><div class="box"><h3>DeepSeek Harness 启动失败</h3><pre>${escaped}</pre><p>日志：${TMP_LOG}</p></div></body></html>`;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    title: APP_NAME,
    autoHideMenuBar: true,
    backgroundColor: '#0d1117',
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(LOADING_HTML));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  log('window created (loading screen)');
}

function loadApp(url) {
  if (!mainWindow) return;
  mainWindow.loadURL(url);
  mainWindow.webContents.on('did-finish-load', () => log('window finished load:', url));
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => log('window failed load:', code, desc));
}

function shutdownDsh() {
  if (shuttingDown) return;
  shuttingDown = true;
  killDsh();
  closeDshLog();
}

async function startup() {
  log('app ready — electron', process.versions.electron, 'node', process.versions.node, 'chrome', process.versions.chrome);
  ensureUserData();
  openDshLog();
  createWindow(); // show the window immediately

  try {
    const url = await startDsh();
    loadApp(url);
  } catch (err) {
    const msg = err && (err.stack || err.message || String(err));
    log('startup failed:', msg);
    if (mainWindow) {
      mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(errorHtml(msg)));
    }
  }
}

// ---------------------------------------------------------------------------
// Auto-update (electron-updater): checks GitHub Releases on startup, silently
// downloads in the background, then prompts to restart once the new version is
// ready. Requires the NSIS installer build; skipped in dev (unpackaged).
// ---------------------------------------------------------------------------
function setupAutoUpdate() {
  if (!app.isPackaged) {
    log('auto-update: skipped (not packaged)');
    return;
  }
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.logger = {
      info: (...a) => log('updater:', ...a),
      warn: (...a) => log('updater-warn:', ...a),
      error: (...a) => log('updater-error:', ...a),
      debug: () => {}
    };
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    // The bundled harness ships as prereleases (0.1.0-rc.N); accept them so
    // upstream rc bumps are picked up by auto-update.
    autoUpdater.allowPrerelease = true;

    autoUpdater.on('update-available', (info) => log('update available:', info && info.version));
    autoUpdater.on('update-not-available', (info) => log('no update:', info && info.version));
    autoUpdater.on('update-downloaded', (info) => {
      log('update downloaded:', info && info.version);
      const opts = {
        type: 'info',
        title: APP_NAME,
        message: `新版本 ${info && info.version} 已下载完成`,
        detail: '重启应用即可完成升级。',
        buttons: ['立即重启', '稍后'],
        defaultId: 0,
        cancelId: 1
      };
      const choice = mainWindow ? dialog.showMessageBoxSync(mainWindow, opts) : dialog.showMessageBoxSync(opts);
      if (choice === 0) {
        autoUpdater.quitAndInstall(false, true);
      }
    });
    autoUpdater.on('error', (err) => log('update error:', err && err.message));

    setTimeout(() => {
      log('checking for updates...');
      autoUpdater.checkForUpdatesAndNotify().catch((err) => log('update check failed:', err && err.message));
    }, 8000);
  } catch (err) {
    log('auto-update setup failed:', err && (err.stack || err.message || err));
  }
}

// ---- lifecycle ----
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  rawLog('single-instance lock NOT acquired; quitting');
  app.quit();
} else {
  app.on('second-instance', () => {
    rawLog('second-instance event');
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(startup).then(setupAutoUpdate).catch((err) => {
    log('startup failed:', err && (err.stack || err.message || err));
    app.quit();
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', shutdownDsh);
}
