// EPG standalone server (Docker / bare metal).
// Reuses worker.js routing (handleRequest) with a filesystem-backed R2 shim.
// Env:
//   DATA_DIR       directory for generated files (default ./data)
//   PORT           listen port (default 8080)
//   ADMIN_PASSWORD password for /admin (default: changeme)
//   EPG_SOURCES    optional "name|url|priority" lines, overrides builtin
//   UPDATE_CRON    update interval in minutes (default 240 = every 4 hours, aligned with Cloudflare version)

import http from 'http';
import { spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { handleRequest } from './worker.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data');
const PORT = parseInt(process.env.PORT || '8080', 10);
mkdirSync(DATA_DIR, { recursive: true });

// ---- R2 shim backed by local disk ----
function r2obj(buf) {
  return { body: buf, text: async () => buf.toString('utf8') };
}
const env = {
  EPG_BUCKET: {
    get: async (key) => {
      const p = join(DATA_DIR, key);
      if (!existsSync(p)) return null;
      return r2obj(readFileSync(p));
    },
    put: async (key, data) => {
      let buf;
      if (Buffer.isBuffer(data)) buf = data;
      else if (typeof data === 'string') buf = Buffer.from(data, 'utf8');
      else if (data && typeof data.getReader === 'function') {
        const chunks = [];
        const reader = data.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(Buffer.from(value));
        }
        buf = Buffer.concat(chunks);
      } else buf = Buffer.from(String(data));
      writeFileSync(join(DATA_DIR, key), buf);
    },
  },
  EPG_SOURCES: process.env.EPG_SOURCES || '',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'changeme',
  UPDATE_TOKEN: process.env.UPDATE_TOKEN || '',
};

// ---- HTTP server: adapt Node req/res to fetch API ----
const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const request = new Request(url, {
      method: req.method,
      headers: req.headers,
      body: body && body.length ? body : undefined,
    });
    const response = await handleRequest(request, env);
    const outHeaders = {};
    response.headers.forEach((v, k) => { outHeaders[k] = v; });
    res.writeHead(response.status, outHeaders);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    console.error('request error:', e.message);
    res.writeHead(500); res.end('internal error');
  }
});

// ---- Updater: run update.mjs on boot, then on schedule ----
let updating = false;
function runUpdate() {
  if (updating) { console.log('[updater] already running, skip'); return; }
  updating = true;
  console.log('[updater] starting update...');
  const child = spawn('node', [join(ROOT, 'update.mjs')], {
    env: { ...process.env, OUTPUT_DIR: DATA_DIR },
    stdio: 'inherit',
  });
  child.on('close', (code) => {
    updating = false;
    console.log(`[updater] finished with code ${code}`);
  });
  child.on('error', (e) => { updating = false; console.error('[updater] spawn failed:', e.message); });
}

function schedule() {
  const cron = (process.env.UPDATE_CRON || '240').trim();
  const mins = /^\d+$/.test(cron) ? Math.min(1440, Math.max(10, parseInt(cron, 10))) : 240;
  console.log(`[updater] every ${mins} minutes`);
  setInterval(runUpdate, mins * 60000);
}

server.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}, data dir ${DATA_DIR}`);
  schedule();
  // initial update shortly after boot (skip if files already fresh)
  const metaPath = join(DATA_DIR, 'meta.json');
  let fresh = false;
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    fresh = Date.now() - new Date(meta.updatedAt).getTime() < 20 * 3600000;
  } catch (e) { /* no meta yet */ }
  if (fresh) { console.log('[updater] data fresh, skipping boot update'); }
  else setTimeout(runUpdate, 5000);
});
