/**
 * Algo Alpha - Standby Cloud Container Receiver Shell
 * File: trader-shell.js
 * 
 * Ultra-lightweight receiver for zero-build REST bundle injection (/env/inject-bundle).
 * Automatically boots and persists active trading bundles.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT, 10) || 10000;
const BUNDLE_FILE = path.join(__dirname, 'active_trader.js');

let activeApp = null;

// Auto-restore bundle from disk if previously saved
if (fs.existsSync(BUNDLE_FILE)) {
  try {
    activeApp = require(BUNDLE_FILE);
    console.log('[SHELL] Restored active bundle from disk (' + BUNDLE_FILE + ').');
  } catch (err) {
    console.error('[SHELL] Error booting saved bundle:', err.message);
  }
}

const server = http.createServer((req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  function getAppHandler() {
    if (!activeApp) return null;
    if (typeof activeApp.handle === 'function') return (req, res) => activeApp.handle(req, res);
    if (typeof activeApp === 'function') return activeApp;
    if (activeApp.app && typeof activeApp.app.handle === 'function') return (req, res) => activeApp.app.handle(req, res);
    if (activeApp.default && typeof activeApp.default.handle === 'function') return (req, res) => activeApp.default.handle(req, res);
    return null;
  }

  // 1. Health Probe
  if (req.url === '/api/health') {
    const handler = getAppHandler();
    if (handler) {
      return handler(req, res);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'OK',
      mode: 'STANDBY_SHELL',
      uptime: Math.round(process.uptime()),
      timestamp: Date.now()
    }));
  }

  // 2. Version Probe
  if (req.url === '/api/version') {
    const handler = getAppHandler();
    if (handler) {
      return handler(req, res);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      version: '1.0.0',
      build: 'shell',
      mode: 'STANDBY'
    }));
  }

  // 3. Reset to Standby Shell
  if ((req.url === '/env/restart-shell' || req.url === '/api/system/reset-shell') && req.method === 'POST') {
    activeApp = null;
    if (fs.existsSync(BUNDLE_FILE)) {
      try { fs.unlinkSync(BUNDLE_FILE); } catch (_) {}
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, status: 'STANDBY_SHELL' }));
  }

  // 4. REST Bundle Injection
  if ((req.url === '/env/inject-bundle' || req.url === '/api/system/inject-bundle') && req.method === 'POST') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const bundleBuffer = Buffer.concat(chunks);
        fs.writeFileSync(BUNDLE_FILE, bundleBuffer);

        delete require.cache[require.resolve(BUNDLE_FILE)];
        activeApp = require(BUNDLE_FILE);

        console.log('[SHELL] New bundle injected successfully (' + bundleBuffer.length + ' bytes).');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, hotloadStatus: 'SUCCESS', size: bundleBuffer.length }));
      } catch (err) {
        console.error('[SHELL] Injection error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // 5. Delegate all other HTTP requests to the active application
  const appHandler = getAppHandler();
  if (appHandler) {
    return appHandler(req, res);
  }

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Algo Alpha Standby Shell is active. Ready for bundle injection via /env/inject-bundle.\n');
});

server.on('upgrade', (req, socket, head) => {
  if (activeApp && typeof activeApp.handleUpgrade === 'function') {
    return activeApp.handleUpgrade(req, socket, head);
  }
  socket.destroy();
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('[SHELL] Standby receiver listening on port ' + PORT);
});
