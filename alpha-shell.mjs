/**
 * Algo Alpha - Permanent Tiny Tri-Shell Bootstrapper (ESM)
 * File: alpha-shell.mjs
 *
 * Minimal immutable PID-1 server shell:
 * - Exposes POST /env/inject-shell to hot-swap active_shell_core.mjs in-memory (~0.2s)
 * - Boots active_shell_core.mjs (or bundled shell-core.mjs) without container restarts
 * - Runs 5-minute self-ping anti-sleep keep-alive loop
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = parseInt(process.env.PORT, 10) || 10000;
const ACTIVE_CORE_PATH = path.join(__dirname, 'active_shell_core.mjs');
const DEFAULT_CORE_PATH = path.join(__dirname, 'shell-core.mjs');

let activeCore = null;

async function loadCoreModule() {
  const target = fs.existsSync(ACTIVE_CORE_PATH) ? ACTIVE_CORE_PATH : (fs.existsSync(DEFAULT_CORE_PATH) ? DEFAULT_CORE_PATH : null);
  if (!target) return null;
  const mod = await import(`${pathToFileURL(target).href}?t=${Date.now()}`);
  if (typeof mod.initShellCore === 'function') await mod.initShellCore();
  activeCore = mod;
  console.log(`[BOOTSTRAP] Loaded shell core: ${path.basename(target)}`);
  return activeCore;
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1'));

  if (urlObj.pathname === '/env/inject-shell' && req.method === 'POST') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const buf = Buffer.concat(chunks);
        const isJson = (req.headers['content-type'] || '').includes('application/json');
        const payload = isJson ? (JSON.parse(buf.toString('utf8')).code ?? '') : buf;
        if (!payload || payload.length < 10) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'Missing shell-core code payload' }));
        }
        fs.writeFileSync(ACTIVE_CORE_PATH, payload);
        await loadCoreModule();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, subsystem: 'shell-core', hotloadStatus: 'SUCCESS', size: Buffer.byteLength(payload) }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  if (activeCore && typeof activeCore.handleHttpRequest === 'function') {
    return activeCore.handleHttpRequest(req, res);
  }

  res.writeHead(urlObj.pathname === '/healthz' ? 200 : 503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'BOOTSTRAP_STANDBY', message: 'Awaiting shell-core via POST /env/inject-shell' }));
});

server.on('upgrade', (req, socket, head) => {
  if (activeCore && typeof activeCore.handleUpgrade === 'function') {
    return activeCore.handleUpgrade(req, socket, head);
  }
  socket.destroy();
});

let retryCount = 0;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && retryCount++ < 10) {
    return setTimeout(() => { try { server.close(); } catch (_) {} server.listen(PORT, '0.0.0.0'); }, 1000);
  }
  console.error('[BOOTSTRAP ERROR]', err.message);
});

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`[BOOTSTRAP] Listening on port ${PORT}`);
  await loadCoreModule();
  if (process.env.KEEP_ALIVE !== 'false') {
    const ext = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL;
    const targets = [...(ext ? [`${ext.replace(/\/+$/, '')}/healthz`] : []), `http://127.0.0.1:${PORT}/healthz`];
    const ping = () => targets.forEach(t => fetch(t, { signal: AbortSignal.timeout(6000) }).catch(() => {}));
    setTimeout(ping, 3000);
    setInterval(ping, 5 * 60 * 1000);
  }
});
