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

const PORT = parseInt(process.env.PORT, 10) || 8090;
const BUNDLE_FILE = path.join(__dirname, 'active_trader.js');

let activeApp = null;

const server = http.createServer((req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const urlObj = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1'));
  const pathname = urlObj.pathname;

  function getAppHandler() {
    if (!activeApp) return null;
    if (typeof activeApp.handle === 'function') return (req, res) => activeApp.handle(req, res);
    if (typeof activeApp === 'function') return activeApp;
    if (activeApp.app && typeof activeApp.app.handle === 'function') return (req, res) => activeApp.app.handle(req, res);
    if (activeApp.default && typeof activeApp.default.handle === 'function') return (req, res) => activeApp.default.handle(req, res);
    return null;
  }

  // 1. Health Probe
  if (pathname === '/api/health') {
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
  if (pathname === '/api/version') {
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
  if ((pathname === '/env/restart-shell' || pathname === '/api/system/reset-shell') && req.method === 'POST') {
    activeApp = null;
    if (fs.existsSync(BUNDLE_FILE)) {
      try { fs.unlinkSync(BUNDLE_FILE); } catch (_) {}
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, status: 'STANDBY_SHELL' }));
  }

  // 4. REST Bundle Injection & Deployment
  if ((pathname === '/env/inject-bundle' || pathname === '/api/system/inject-bundle' || pathname === '/api/system/deploy-bundle') && req.method === 'POST') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        let bundleBuffer = Buffer.concat(chunks);
        const cType = req.headers['content-type'] || '';
        if (cType.includes('application/json')) {
          try {
            const parsed = JSON.parse(bundleBuffer.toString('utf8'));
            if (parsed.bundle || parsed.code || parsed.data) {
              bundleBuffer = Buffer.from(parsed.bundle || parsed.code || parsed.data, 'utf8');
            } else if (parsed.filename || pathname.includes('deploy-bundle')) {
              const candidatePaths = [
                path.resolve(process.env.REPO_ROOT || '', 'dist/trader.js'),
                path.resolve(__dirname, '../../pwa-trader/dist/trader.js'),
                path.resolve(__dirname, '../pwa-trader/dist/trader.js'),
                path.resolve(__dirname, 'active_trader.js')
              ];
              const found = candidatePaths.find(p => p && fs.existsSync(p));
              if (found) bundleBuffer = fs.readFileSync(found);
            }
          } catch (_) {}
        }

        fs.writeFileSync(BUNDLE_FILE, bundleBuffer);

        delete require.cache[require.resolve(BUNDLE_FILE)];
        activeApp = require(BUNDLE_FILE);

        // Ensure live broker mode (HYBRID) is enforced on bundle injection
        try {
          if (global.__marketDataGateway && typeof global.__marketDataGateway.setMode === 'function') {
            global.__marketDataGateway.setMode('HYBRID');
          }
          if (global.__syntheticMarketFeedEngine && global.__syntheticMarketFeedEngine.isRunning) {
            global.__syntheticMarketFeedEngine.stop();
          }
        } catch (_) {}

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

let retryCount = 0;
function onListening() {
  console.log('[SHELL] Standby receiver listening on port ' + PORT);

  // Auto-restore bundle from disk AFTER shell port is bound
  if (fs.existsSync(BUNDLE_FILE)) {
    try {
      activeApp = require(BUNDLE_FILE);
      console.log('[SHELL] Restored active bundle from disk (' + BUNDLE_FILE + ').');
    } catch (err) {
      console.error('[SHELL] Error booting saved bundle:', err.message);
    }
  }
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    if (retryCount < 10) {
      retryCount++;
      console.log('[SHELL] Port ' + PORT + ' busy (TIME_WAIT). Retrying bind in 1s (' + retryCount + '/10)...');
      setTimeout(() => {
        try { server.close(); } catch (_) {}
        server.listen(PORT, '0.0.0.0', onListening);
      }, 1000);
      return;
    }
    console.error('[SHELL ERROR] Port ' + PORT + ' is already in use by another process.');
  } else {
    console.error('[SHELL ERROR]', err.message);
  }
});

server.listen(PORT, '0.0.0.0', onListening);
