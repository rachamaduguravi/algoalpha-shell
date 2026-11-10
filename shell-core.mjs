/**
 * Algo Alpha - Hot-Swappable Tri-Shell Core Router
 * File: alpha_shell/shell-core.mjs
 *
 * Swappable in-memory via POST /env/inject-shell without restarting PID 1.
 * Coordinates Trader (active_trader.mjs), Scraper (active_scraper.mjs -> handles
 * /api/scrape/*, /api/files, /api/download/*, /api/parquet), and Replay (active_replay.mjs).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'scrape');
const REPLAY_DIR = path.join(__dirname, 'replay');
const TRADER_BUNDLE = path.join(__dirname, 'active_trader.mjs');
const SCRAPER_BUNDLE = path.join(__dirname, 'active_scraper.mjs');
const REPLAY_BUNDLE = path.join(__dirname, 'active_replay.mjs');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(REPLAY_DIR, { recursive: true });

let activeTrader = null;
let activeScraperMod = null;
let activeReplay = null;

async function loadTraderModule() {
  if (!fs.existsSync(TRADER_BUNDLE)) return null;
  try {
    const mod = await import(`${pathToFileURL(TRADER_BUNDLE).href}?t=${Date.now()}`);
    activeTrader = mod.default || mod.app || mod;
    console.log(`[SHELL-CORE] Loaded Trader bundle: ${TRADER_BUNDLE}`);
    return activeTrader;
  } catch (err) {
    console.error(`[SHELL-CORE] Error loading Trader bundle:`, err.message);
    return null;
  }
}

async function loadScraperModule() {
  if (!fs.existsSync(SCRAPER_BUNDLE)) return null;
  try {
    const mod = await import(`${pathToFileURL(SCRAPER_BUNDLE).href}?t=${Date.now()}`);
    activeScraperMod = mod;
    console.log(`[SHELL-CORE] Loaded Scraper module: ${SCRAPER_BUNDLE}`);
    return activeScraperMod;
  } catch (err) {
    console.error(`[SHELL-CORE] Error loading Scraper module:`, err.message);
    return null;
  }
}

async function loadReplayModule() {
  if (!fs.existsSync(REPLAY_BUNDLE)) return null;
  try {
    const mod = await import(`${pathToFileURL(REPLAY_BUNDLE).href}?t=${Date.now()}`);
    activeReplay = mod;
    console.log(`[SHELL-CORE] Loaded Replay module: ${REPLAY_BUNDLE}`);
    return activeReplay;
  } catch (err) {
    console.error(`[SHELL-CORE] Error loading Replay module:`, err.message);
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

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function extractPayloadBuffer(rawBuf, req) {
  const cType = req.headers['content-type'] || '';
  if (cType.includes('application/json')) {
    try {
      const parsed = JSON.parse(rawBuf.toString('utf8'));
      if (parsed.bundle || parsed.code || parsed.data) {
        return Buffer.from(parsed.bundle || parsed.code || parsed.data, 'utf8');
      }
    } catch (_) {}
  }
  return rawBuf;
}

export async function initShellCore() {
  await Promise.all([
    loadTraderModule(),
    loadScraperModule(),
    loadReplayModule()
  ]);
}

export async function handleHttpRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const urlObj = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1'));
  const pathname = urlObj.pathname;

  // 1. Unified Health & Telemetry
  if (pathname === '/healthz' || pathname === '/api/health') {
    const files = fs.existsSync(DATA_DIR)
      ? fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.sqlite') || f.endsWith('.parquet') || f.endsWith('.csv'))
      : [];
    const telemetry = typeof activeScraperMod?.getScrapeTelemetry === 'function'
      ? activeScraperMod.getScrapeTelemetry()
      : { isRunning: false, pid: null };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'OK',
      mode: 'TRI_STANDBY_SHELL',
      hotSwappableCore: true,
      trader: { active: !!activeTrader, subsystem: activeTrader ? 'HYBRID_LIVE' : 'STANDBY' },
      scraper: {
        active: fs.existsSync(SCRAPER_BUNDLE) || !!activeScraperMod,
        filesCount: files.length,
        isScraping: !!telemetry.isRunning,
        pid: telemetry.pid || null
      },
      replay: {
        active: fs.existsSync(REPLAY_BUNDLE) || !!activeReplay,
        status: typeof activeReplay?.getReplayStatus === 'function' ? activeReplay.getReplayStatus() : { ready: !!activeReplay }
      },
      storageDir: DATA_DIR,
      replayDir: REPLAY_DIR,
      files,
      jobState: telemetry,
      uptime: Math.round(process.uptime()),
      node: process.version,
      timestamp: Date.now()
    }, null, 2));
  }

  // 2. Version Probe
  if (pathname === '/api/version') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      version: '4.0.0',
      build: 'tri-shell-hotcore-esm',
      mode: 'TRI_STANDBY_SHELL',
      traderActive: !!activeTrader,
      scraperActive: !!activeScraperMod,
      replayActive: !!activeReplay
    }));
  }

  // 3. Reset Subsystems (/env/restart-shell)
  if ((pathname === '/env/restart-shell' || pathname === '/api/system/reset-shell') && req.method === 'POST') {
    const target = urlObj.searchParams.get('target') || 'all';
    if (target === 'trader' || target === 'all') {
      activeTrader = null;
      if (fs.existsSync(TRADER_BUNDLE)) try { fs.unlinkSync(TRADER_BUNDLE); } catch (_) {}
    }
    if (target === 'scraper' || target === 'all') {
      if (typeof activeScraperMod?.stopActiveScrape === 'function') {
        activeScraperMod.stopActiveScrape('Reset via /env/restart-shell');
      }
      activeScraperMod = null;
      if (fs.existsSync(SCRAPER_BUNDLE)) try { fs.unlinkSync(SCRAPER_BUNDLE); } catch (_) {}
    }
    if (target === 'replay' || target === 'all') {
      activeReplay = null;
      if (fs.existsSync(REPLAY_BUNDLE)) try { fs.unlinkSync(REPLAY_BUNDLE); } catch (_) {}
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, status: 'RESET', target }));
  }

  // 4. Inject Trader Bundle
  if ((pathname === '/env/inject-bundle' || pathname === '/env/inject-trader' || pathname === '/api/system/inject-bundle' || pathname === '/api/system/deploy-bundle') && req.method === 'POST') {
    try {
      const buf = extractPayloadBuffer(await readRawBody(req), req);
      fs.writeFileSync(TRADER_BUNDLE, buf);
      await loadTraderModule();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, subsystem: 'trader', hotloadStatus: activeTrader ? 'SUCCESS' : 'LOADED_FALLBACK', size: buf.length }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }

  // 5. Inject Scraper Bundle
  if ((pathname === '/env/inject-scraper' || pathname === '/api/system/inject-scraper') && req.method === 'POST') {
    try {
      const buf = extractPayloadBuffer(await readRawBody(req), req);
      fs.writeFileSync(SCRAPER_BUNDLE, buf);
      await loadScraperModule();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, subsystem: 'scraper', hotloadStatus: activeScraperMod ? 'SUCCESS' : 'SAVED', size: buf.length }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }

  // 6. Inject Replay Bundle
  if ((pathname === '/env/inject-replay' || pathname === '/api/system/inject-replay') && req.method === 'POST') {
    try {
      const buf = extractPayloadBuffer(await readRawBody(req), req);
      fs.writeFileSync(REPLAY_BUNDLE, buf);
      await loadReplayModule();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, subsystem: 'replay', hotloadStatus: activeReplay ? 'SUCCESS' : 'LOADED', size: buf.length }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }

  // 7. Inject Watchlist CSV
  if ((pathname === '/env/inject-csv' || pathname === '/api/upload-csv' || pathname === '/api/system/inject-csv') && req.method === 'POST') {
    try {
      const filename = path.basename(urlObj.searchParams.get('filename') || 'PK.csv');
      const rawBuf = await readRawBody(req);
      let content = rawBuf.toString('utf8');
      if ((req.headers['content-type'] || '').includes('application/json')) {
        try { const p = JSON.parse(content); if (p.csv || p.content) content = p.csv || p.content; } catch (_) {}
      }
      fs.writeFileSync(path.join(DATA_DIR, filename), content, 'utf8');
      fs.writeFileSync(path.join(__dirname, filename), content, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, filename, bytes: Buffer.byteLength(content) }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }

  // 8. Delegate All Scraper Routes (/api/scrape/*, /api/files, /api/download/*, /api/parquet) to active_scraper.mjs
  const isScraperRoute = pathname.startsWith('/api/scrape') || pathname.startsWith('/api/system/scrape') ||
    pathname === '/api/files' || pathname.startsWith('/api/download/') ||
    pathname === '/api/parquet' || pathname === '/api/system/parquet';

  if (isScraperRoute) {
    if (!activeScraperMod && fs.existsSync(SCRAPER_BUNDLE)) {
      await loadScraperModule();
    }
    if (activeScraperMod && typeof activeScraperMod.handleScraperHttp === 'function') {
      const handled = await activeScraperMod.handleScraperHttp(req, res, {
        urlObj,
        dataDir: DATA_DIR,
        scriptPath: SCRAPER_BUNDLE
      });
      if (handled) return;
    }
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Scraper bundle not deployed. Inject scraper first via POST /env/inject-scraper.' }));
  }

  // 9. Replay Routes Delegation
  if (pathname.startsWith('/api/replay')) {
    if (!activeReplay) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Replay subsystem not deployed. Inject via POST /env/inject-replay.' }));
    }
    if (pathname === '/api/replay/status' && typeof activeReplay.getReplayStatus === 'function') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(activeReplay.getReplayStatus(), null, 2));
    }
    if (typeof activeReplay.handleRequest === 'function') return activeReplay.handleRequest(req, res, urlObj);
  }

  // 10. Delegate to Active Trader Engine
  const traderHandler = getTraderHandler();
  if (traderHandler) return traderHandler(req, res);

  // Standby Banner
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(
    'Algo Alpha Unified Tri Standby Shell (Hot-Core ESM) is active.\n\n' +
    'Hot-Swap Shell Endpoints:\n' +
    '  - POST /env/inject-shell       Hot-swap shell-core.mjs in-memory (0.2s, no restart)\n' +
    '  - POST /env/inject-bundle      Inject Trader Bundle (active_trader.mjs)\n' +
    '  - POST /env/inject-scraper     Inject Scraper Bundle (active_scraper.mjs)\n' +
    '  - POST /env/inject-replay      Inject Replay Bundle (active_replay.mjs)\n' +
    '  - POST /env/inject-csv         Inject Watchlist CSV (?filename=PK.csv)\n' +
    '  - POST /env/restart-shell      Reset Subsystems (?target=trader|scraper|replay|all)\n\n' +
    'Scraper Endpoints (Handled by active_scraper.mjs):\n' +
    '  - GET|POST /api/scrape/start   Start Candle Scrape (?preset=PK.csv)\n' +
    '  - GET|POST /api/scrape/stop    Stop Active Candle Scrape\n' +
    '  - GET      /api/scrape/status  Full Scrape Status & All Logs\n' +
    '  - GET      /api/files          List Parquet & SQLite Archives\n' +
    '  - GET      /api/download/:file Download Archive\n' +
    '  - GET|POST /api/parquet        Convert SQLite to ZSTD Parquet (?date=YYYY-MM-DD)\n'
  );
}

export function handleUpgrade(req, socket, head) {
  if (activeTrader && typeof activeTrader.handleUpgrade === 'function') {
    return activeTrader.handleUpgrade(req, socket, head);
  }
  socket.destroy();
}
