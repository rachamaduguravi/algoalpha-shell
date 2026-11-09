/**
 * Algo Alpha - Unified Dual Standby Shell Receiver (Trader & Scraper)
 * File: trader-shell.mjs
 * 
 * Multiplexed zero-build cloud receiver for Render Cloud:
 * 1. Trader Subsystem  (active_trader.mjs)  -> UI, Positions, Orders, Broker WS
 * 2. Scraper Subsystem (active_scraper.mjs) -> TV WS, Multi-TF, SQLite, Parquet
 * 3. Management API    (/env/inject-bundle, /env/inject-scraper, /env/restart-shell)
 * 4. Mutual 5-Minute Anti-Sleep Keep-Alive Loop
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT, 10) || 10000;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'scrape');
const TRADER_BUNDLE = path.join(__dirname, 'active_trader.mjs');
const SCRAPER_BUNDLE = path.join(__dirname, 'active_scraper.mjs');

// Ensure scrape directory exists
fs.mkdirSync(DATA_DIR, { recursive: true });

let activeTrader = null;
let activeScraper = false;
let activeJob = {
  isRunning: false,
  preset: null,
  startedAt: null,
  completedAt: null,
  lastError: null,
  outputLog: []
};

// ============================================================================
// DYNAMIC MODULE LOADERS
// ============================================================================
async function loadTraderModule() {
  if (!fs.existsSync(TRADER_BUNDLE)) return null;
  try {
    const fileUrl = `${pathToFileURL(TRADER_BUNDLE).href}?t=${Date.now()}`;
    const mod = await import(fileUrl);
    activeTrader = mod.default || mod.app || mod;
    console.log(`[DUAL-SHELL] Successfully loaded Trader bundle from: ${TRADER_BUNDLE}`);
    return activeTrader;
  } catch (err) {
    console.error(`[DUAL-SHELL] Error loading Trader bundle:`, err.message);
    return null;
  }
}

function getTraderHandler() {
  if (!activeTrader) return null;
  if (typeof activeTrader.handle === 'function') return (req, res) => activeTrader.handle(req, res);
  if (typeof activeTrader === 'function') return activeTrader;
  if (activeTrader.app && typeof activeTrader.app.handle === 'function') return (req, res) => activeTrader.app.handle(req, res);
  if (activeTrader.default && typeof activeTrader.default.handle === 'function') return (req, res) => activeTrader.default.handle(req, res);
  return null;
}

// ============================================================================
// 5-MINUTE KEEP-ALIVE LOOP
// ============================================================================
function startKeepAliveLoop() {
  const KEEP_ALIVE_INTERVAL_MS = 5 * 60 * 1000;
  const externalUrl = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL;
  const peerUrl = process.env.PEER_URL;

  const pingTargets = [];
  if (externalUrl) pingTargets.push(`${externalUrl.replace(/\/+$/, '')}/healthz`);
  if (peerUrl) pingTargets.push(`${peerUrl.replace(/\/+$/, '')}/healthz`);
  pingTargets.push(`http://127.0.0.1:${PORT}/healthz`);

  const executePing = async () => {
    for (const target of pingTargets) {
      try {
        const res = await fetch(target, { signal: AbortSignal.timeout(6000) });
        console.log(`[KeepAlive] Pinged ${target} -> HTTP ${res.status} (Active)`);
      } catch (err) {
        console.log(`[KeepAlive] Ping status for ${target}: ${err.message}`);
      }
    }
  };

  setInterval(executePing, KEEP_ALIVE_INTERVAL_MS);
  setTimeout(executePing, 3000);
}

// ============================================================================
// HTTP REQUEST ROUTER
// ============================================================================
const server = http.createServer(async (req, res) => {
  // Global CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const urlObj = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1'));
  const pathname = urlObj.pathname;

  // --------------------------------------------------------------------------
  // 1. Unified Health & Subsystem Status (/healthz, /api/health)
  // --------------------------------------------------------------------------
  if (pathname === '/healthz' || pathname === '/api/health') {
    const files = fs.existsSync(DATA_DIR)
      ? fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.sqlite') || f.endsWith('.parquet') || f.endsWith('.csv'))
      : [];

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'OK',
      mode: 'DUAL_STANDBY_SHELL',
      trader: {
        active: !!activeTrader,
        subsystem: activeTrader ? 'HYBRID_LIVE' : 'STANDBY'
      },
      scraper: {
        active: fs.existsSync(SCRAPER_BUNDLE) || activeScraper,
        filesCount: files.length,
        isScraping: activeJob.isRunning
      },
      storageDir: DATA_DIR,
      files,
      jobState: activeJob,
      uptime: Math.round(process.uptime()),
      node: process.version,
      timestamp: Date.now()
    }, null, 2));
  }

  // --------------------------------------------------------------------------
  // 2. Version Probe (/api/version)
  // --------------------------------------------------------------------------
  if (pathname === '/api/version') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      version: '2.0.0',
      build: 'dual-shell-esm',
      mode: 'DUAL_STANDBY_SHELL',
      traderActive: !!activeTrader,
      scraperActive: fs.existsSync(SCRAPER_BUNDLE) || activeScraper
    }));
  }

  // --------------------------------------------------------------------------
  // 3. Reset Shells (/env/restart-shell, /api/system/reset-shell)
  // --------------------------------------------------------------------------
  if ((pathname === '/env/restart-shell' || pathname === '/api/system/reset-shell') && req.method === 'POST') {
    const target = urlObj.searchParams.get('target') || 'all';
    if (target === 'trader' || target === 'all') {
      activeTrader = null;
      if (fs.existsSync(TRADER_BUNDLE)) try { fs.unlinkSync(TRADER_BUNDLE); } catch (_) {}
    }
    if (target === 'scraper' || target === 'all') {
      activeScraper = false;
      if (fs.existsSync(SCRAPER_BUNDLE)) try { fs.unlinkSync(SCRAPER_BUNDLE); } catch (_) {}
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, status: 'RESET', target }));
  }

  // --------------------------------------------------------------------------
  // 4. Inject Trader Bundle (/env/inject-bundle, /env/inject-trader)
  // --------------------------------------------------------------------------
  if ((pathname === '/env/inject-bundle' || pathname === '/env/inject-trader' || pathname === '/api/system/inject-bundle' || pathname === '/api/system/deploy-bundle') && req.method === 'POST') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      try {
        let bundleBuffer = Buffer.concat(chunks);
        const cType = req.headers['content-type'] || '';
        if (cType.includes('application/json')) {
          try {
            const parsed = JSON.parse(bundleBuffer.toString('utf8'));
            if (parsed.bundle || parsed.code || parsed.data) {
              bundleBuffer = Buffer.from(parsed.bundle || parsed.code || parsed.data, 'utf8');
            }
          } catch (_) {}
        }

        fs.writeFileSync(TRADER_BUNDLE, bundleBuffer);
        await loadTraderModule();

        // Enforce live broker mode (HYBRID) if gateway is available
        try {
          if (global.__marketDataGateway && typeof global.__marketDataGateway.setMode === 'function') {
            global.__marketDataGateway.setMode('HYBRID');
          }
        } catch (_) {}

        console.log(`[DUAL-SHELL] Trader bundle injected successfully (${bundleBuffer.length} bytes).`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, subsystem: 'trader', hotloadStatus: 'SUCCESS', size: bundleBuffer.length }));
      } catch (err) {
        console.error('[DUAL-SHELL] Trader injection error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // --------------------------------------------------------------------------
  // 5. Inject Scraper Bundle (/env/inject-scraper)
  // --------------------------------------------------------------------------
  if ((pathname === '/env/inject-scraper' || pathname === '/api/system/inject-scraper') && req.method === 'POST') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        let scraperBuffer = Buffer.concat(chunks);
        const cType = req.headers['content-type'] || '';
        if (cType.includes('application/json')) {
          try {
            const parsed = JSON.parse(scraperBuffer.toString('utf8'));
            if (parsed.bundle || parsed.code || parsed.data) {
              scraperBuffer = Buffer.from(parsed.bundle || parsed.code || parsed.data, 'utf8');
            }
          } catch (_) {}
        }

        fs.writeFileSync(SCRAPER_BUNDLE, scraperBuffer);
        activeScraper = true;

        console.log(`[DUAL-SHELL] Scraper bundle injected successfully (${scraperBuffer.length} bytes).`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, subsystem: 'scraper', hotloadStatus: 'SUCCESS', size: scraperBuffer.length }));
      } catch (err) {
        console.error('[DUAL-SHELL] Scraper injection error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // --------------------------------------------------------------------------
  // 6. Scraper Subsystem REST API (/api/files, /api/download, /api/scrape, /api/parquet)
  // --------------------------------------------------------------------------
  if (pathname === '/api/files' && req.method === 'GET') {
    if (!fs.existsSync(DATA_DIR)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify([]));
    }
    const files = fs.readdirSync(DATA_DIR)
      .filter(f => f.endsWith('.sqlite') || f.endsWith('.parquet') || f.endsWith('.csv'))
      .map(f => {
        const st = fs.statSync(path.join(DATA_DIR, f));
        return {
          filename: f,
          type: path.extname(f).slice(1).toUpperCase(),
          sizeBytes: st.size,
          sizeMb: (st.size / 1024 / 1024).toFixed(2),
          modified: st.mtime.toISOString(),
          downloadUrl: '/api/download/' + f
        };
      });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(files, null, 2));
  }

  if (pathname.startsWith('/api/download/') && req.method === 'GET') {
    const filename = path.basename(pathname.replace('/api/download/', ''));
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'File not found: ' + filename }));
    }
    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      'Content-Type': filename.endsWith('.parquet') ? 'application/octet-stream' : filename.endsWith('.csv') ? 'text/csv' : 'application/x-sqlite3',
      'Content-Length': stat.size,
      'Content-Disposition': 'attachment; filename="' + filename + '"'
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  if ((pathname === '/api/scrape' || pathname === '/api/system/scrape') && (req.method === 'POST' || req.method === 'GET')) {
    if (activeJob.isRunning) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Scrape pipeline is already actively running.', jobState: activeJob }));
    }

    if (!fs.existsSync(SCRAPER_BUNDLE)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Scraper bundle not found. Deploy scraper bundle first via /env/inject-scraper.' }));
    }

    const preset = urlObj.searchParams.get('preset') || 'PK.csv';
    activeJob = {
      isRunning: true,
      preset,
      startedAt: new Date().toISOString(),
      completedAt: null,
      lastError: null,
      outputLog: []
    };

    console.log(`[DUAL-SHELL] Triggering background scrape for preset ${preset}...`);

    const scraperChild = spawn(process.execPath, [SCRAPER_BUNDLE, '-c', preset], {
      cwd: path.dirname(SCRAPER_BUNDLE),
      stdio: 'pipe'
    });

    scraperChild.stdout.on('data', (d) => {
      const line = d.toString().trim();
      if (line) {
        console.log(`[SCRAPER] ${line}`);
        activeJob.outputLog.push(line);
        if (activeJob.outputLog.length > 50) activeJob.outputLog.shift();
      }
    });

    scraperChild.stderr.on('data', (d) => {
      const line = d.toString().trim();
      if (line) {
        console.error(`[SCRAPER ERROR] ${line}`);
        activeJob.lastError = line;
      }
    });

    scraperChild.on('close', (code) => {
      activeJob.isRunning = false;
      activeJob.completedAt = new Date().toISOString();
      console.log(`[DUAL-SHELL] Scrape child process exited with code ${code}`);
    });

    res.writeHead(202, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      message: 'Scrape job launched asynchronously on Render container.',
      preset,
      status: 'RUNNING'
    }));
  }

  if ((pathname === '/api/parquet' || pathname === '/api/system/parquet') && (req.method === 'POST' || req.method === 'GET')) {
    if (!fs.existsSync(SCRAPER_BUNDLE)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Scraper bundle not found.' }));
    }

    const dateParam = urlObj.searchParams.get('date');
    const args = [SCRAPER_BUNDLE, '-p'];
    if (dateParam) args.push(dateParam);

    console.log(`[DUAL-SHELL] Launching Parquet conversion for: ${dateParam || 'all'}`);
    const parquetChild = spawn(process.execPath, args, {
      cwd: path.dirname(SCRAPER_BUNDLE),
      stdio: 'inherit'
    });

    parquetChild.on('close', (code) => {
      console.log(`[DUAL-SHELL] Parquet conversion finished with code ${code}`);
    });

    res.writeHead(202, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ message: 'Parquet conversion launched.', date: dateParam || 'all' }));
  }

  // --------------------------------------------------------------------------
  // 7. Delegate all other HTTP requests to Active Trader Subsystem
  // --------------------------------------------------------------------------
  const appHandler = getTraderHandler();
  if (appHandler) {
    return appHandler(req, res);
  }

  // Standby Fallback Landing Page
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Algo Alpha Unified Dual Standby Shell (ESM) is active.\n\n' +
    'Coexisting Endpoints:\n' +
    '  - GET  /healthz              Unified Health & Telemetry\n' +
    '  - GET  /api/health           Unified Health & Telemetry\n' +
    '  - POST /env/inject-bundle    Inject Trader Bundle (active_trader.mjs)\n' +
    '  - POST /env/inject-scraper   Inject Scraper Bundle (active_scraper.mjs)\n' +
    '  - GET  /api/files            List Parquet & SQLite Archives\n' +
    '  - GET  /api/download/:file   Download Archive\n' +
    '  - POST /api/scrape           Trigger Multi-TF Candle Scrape (?preset=PK.csv)\n' +
    '  - POST /api/parquet          Convert SQLite to ZSTD Parquet (?date=YYYY-MM-DD)\n' +
    '  - POST /env/restart-shell    Reset Subsystems (?target=trader|scraper|all)\n');
});

// WebSocket Upgrade Delegation
server.on('upgrade', (req, socket, head) => {
  if (activeTrader && typeof activeTrader.handleUpgrade === 'function') {
    return activeTrader.handleUpgrade(req, socket, head);
  }
  socket.destroy();
});

// Server Initialization
let retryCount = 0;
async function onListening() {
  console.log(`[DUAL-SHELL] Standby receiver listening on port ${PORT}`);

  // Auto-restore Trader bundle from disk
  if (fs.existsSync(TRADER_BUNDLE)) {
    await loadTraderModule();
  }

  // Detect Scraper bundle
  if (fs.existsSync(SCRAPER_BUNDLE)) {
    activeScraper = true;
    console.log(`[DUAL-SHELL] Found active scraper bundle (${SCRAPER_BUNDLE}).`);
  }

  startKeepAliveLoop();
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    if (retryCount < 10) {
      retryCount++;
      console.log(`[DUAL-SHELL] Port ${PORT} busy (TIME_WAIT). Retrying bind in 1s (${retryCount}/10)...`);
      setTimeout(() => {
        try { server.close(); } catch (_) {}
        server.listen(PORT, '0.0.0.0', onListening);
      }, 1000);
      return;
    }
    console.error(`[DUAL-SHELL ERROR] Port ${PORT} is already in use by another process.`);
  } else {
    console.error('[DUAL-SHELL ERROR]', err.message);
  }
});

server.listen(PORT, '0.0.0.0', onListening);
