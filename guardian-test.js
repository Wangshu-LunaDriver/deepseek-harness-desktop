'use strict';
// Headless verification of the process-guardian core used by main.js.
// Mirrors main.js exactly (file-redirected child stdio, free-port probe,
// HTTP readiness wait) but skips the BrowserWindow, so it runs under plain
// Node in an environment where Electron's GUI cannot start.

const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');

const APP = __dirname;
const dshBin = path.join(APP, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const electron = path.join(APP, 'node_modules', 'electron', 'dist', 'electron.exe');
const DSH_HOME = path.join(APP, '.dsh-guardian-test');
const logFile = path.join(APP, 'guardian-dsh.log');

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

function waitForHttp(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', () => {
        if (Date.now() - started > timeoutMs) {
          return reject(new Error(`no HTTP response at ${url}`));
        }
        setTimeout(attempt, 250);
      });
      req.setTimeout(1500, () => req.destroy());
    };
    attempt();
  });
}

function fetchBody(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

(async () => {
  fs.mkdirSync(DSH_HOME, { recursive: true });
  const logFd = fs.openSync(logFile, 'w');

  const port = await findFreePort();
  const url = `http://127.0.0.1:${port}`;
  console.log(`[test] chosen port ${port}`);

  const child = spawn(
    electron,
    ['--expose-internals', dshBin, 'web', '--host', '127.0.0.1', '--port', String(port)],
    {
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME }
    }
  );

  let exited = null;
  child.on('exit', (code, signal) => {
    exited = { code, signal };
    console.log(`[test] dsh child exited code=${code} signal=${signal}`);
  });

  const status = await waitForHttp(url, 45000);
  console.log(`[test] HTTP ready, status=${status}`);

  const { body } = await fetchBody(url);
  console.log(`[test] body length=${body.length}`);
  console.log(`[test] has __DSH_BOOT__: ${body.includes('__DSH_BOOT__')}`);
  console.log(`[test] title: ${(body.match(/<title>(.*?)<\/title>/) || [])[1] || '(none)'}`);

  // Now verify graceful teardown + port release.
  child.kill();
  await new Promise((r) => setTimeout(r, 1500));

  const portReleased = await new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
  console.log(`[test] port released after kill: ${portReleased}`);
  console.log(`[test] child exited: ${exited ? JSON.stringify(exited) : 'not yet'}`);

  fs.closeSync(logFd);
  console.log('[test] DONE');
})().catch((err) => {
  console.error('[test] FAILED:', err && (err.stack || err.message || err));
  process.exit(1);
});
