
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
// ---- Output: R2 via Worker /push, or local disk if OUTPUT_DIR is set (Docker mode) ----
// GitHub Actions: UPDATE_TOKEN and PUSH_URL from secrets/env
// Local VM: token from /tmp/epg_update_token.txt
// Docker: set OUTPUT_DIR=/data to write files locally instead of pushing
const OUTPUT_DIR = process.env.OUTPUT_DIR || '';
const PUSH_URL = process.env.PUSH_URL || 'https://epg.cc.cd/push';
function getToken() {
  if (process.env.UPDATE_TOKEN) return process.env.UPDATE_TOKEN.trim();
  try { return readFileSync('/tmp/epg_update_token.txt', 'utf8').trim(); } catch (e) { return ''; }
}
const TOKEN = getToken();
async function pushFile(key, body, contentType) {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
  if (OUTPUT_DIR) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    writeFileSync(`${OUTPUT_DIR}/${key}`, buf);
    console.log(`  wrote ${key} (${(buf.length/1024).toFixed(0)}KB)`);
    return;
  }
  if (!TOKEN) throw new Error('UPDATE_TOKEN not set (or set OUTPUT_DIR for local mode)');
  const r = await fetch(`${PUSH_URL}?token=${encodeURIComponent(TOKEN)}&key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: buf,
  });
  if (!r.ok) throw new Error(`push ${key} failed: HTTP ${r.status}`);
  console.log(`  pushed ${key} (${(buf.length/1024).toFixed(0)}KB)`);
}
async function uploadAll(files) {
  for (const [key, body, ct] of files) await pushFile(key, body, ct);
}

// epg-new Worker: independent EPG service
// Sources: TvWasm/autoEPG (official) + 51zmt + 112114
// Outputs: XMLTV, GZip, DIYP JSON, channels.json, meta.json
// Schedule: daily 01:00 Beijing (17:00 UTC)

const SRC = {
  channels: 'https://github.com/TvWasm/autoEPG/releases/latest/download/channels.json',
  epg3: 'https://github.com/TvWasm/autoEPG/releases/latest/download/epg3.xml',
  hist: d => `https://github.com/TvWasm/autoEPG/releases/download/${d}/epg.xml`,
  // XMLTV source list: fetched from Worker /sources.txt (env EPG_SOURCES, one per line: name|url|priority)
  // Falls back to builtin list if fetch fails.
  builtin: [
    ['51zmt', 'https://epg.51zmt.top:8001/e.xml', 1],
    ['112114', 'https://epg.112114.xyz/pp.xml.gz', 2],
    ['v1mk', 'https://epg.v1.mk/fy.xml', 2],
    ['epgpw', 'https://epg.pw/xmltv/epg_CN.xml', 2],
    ['sparkpp', 'https://raw.githubusercontent.com/sparkssssssssss/epg/main/pp.xml', 2],
    ['zsdc', 'https://epg.zsdc.eu.org/t.xml', 2],
    ['kuke31', 'https://raw.githubusercontent.com/kuke31/xmlgz/main/all.xml.gz', 2],
    ['liliu', 'https://liliu.serv00.net/epg/download.php?type=gz', 2],
  ],
};
const SOURCES_URL = 'https://epg.cc.cd/sources.txt';

function parseSourceList(text) {
  // entries: name|url|priority — one per line, but also tolerates space-separated
  // (# comments and blank lines skipped; urls contain no spaces so this is safe)
  const out = [];
  const re = /([^\s|#][^\s|]*)\|(https?:\/\/[^\s|]+)(?:\|([123]))?/g;
  const src = String(text || '');
  let m;
  while ((m = re.exec(src)) !== null) {
    const lineStart = src.lastIndexOf('\n', m.index - 1) + 1;
    if (src.slice(lineStart, m.index).trimStart().startsWith('#')) continue;
    out.push([m[1].trim(), m[2].trim(), m[3] ? parseInt(m[3], 10) : 2]);
  }
  return out;
}
function isGzipUrl(url) {
  return /\.gz(\?|$)/i.test(url) || /[?&]type=gz(&|$)/i.test(url);
}
async function loadSources() {
  // Docker/local: OUTPUT_DIR/sources.json (admin UI) > EPG_SOURCES env > builtin
  if (OUTPUT_DIR) {
    try {
      const p = `${OUTPUT_DIR}/sources.json`;
      if (existsSync(p)) {
        const arr = JSON.parse(readFileSync(p, 'utf8'));
        const list = (Array.isArray(arr) ? arr : [])
          .filter(s => s && s.url && String(s.url).startsWith('http'))
          .map(s => [String(s.name || 'src'), String(s.url), [1, 2, 3].includes(s.priority) ? s.priority : 2]);
        if (list.length) { console.log(`  sources: loaded ${list.length} from ${p} (admin)`); return list; }
      }
    } catch (e) { console.log('  local sources.json failed:', e.message); }
    if (process.env.EPG_SOURCES) {
      const list = parseSourceList(process.env.EPG_SOURCES);
      if (list.length) { console.log(`  sources: loaded ${list.length} from EPG_SOURCES env`); return list; }
    }
    return SRC.builtin;
  }
  // 1) R2 sources.json (admin UI)  2) Worker var (sources.txt)  3) builtin
  try {
    const r = await fetch('https://epg.cc.cd/sources.json', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (r.ok) {
      const arr = await r.json();
      const list = (Array.isArray(arr) ? arr : [])
        .filter(s => s && s.url && String(s.url).startsWith('http'))
        .map(s => [String(s.name || 'src'), String(s.url), [1, 2, 3].includes(s.priority) ? s.priority : 2]);
      if (list.length) { console.log(`  sources: loaded ${list.length} from sources.json (admin)`); return list; }
    }
  } catch (e) { console.log('  sources.json failed:', e.message); }
  try {
    const t = await fetchText(SOURCES_URL, 15000);
    const list = parseSourceList(t);
    if (list.length) { console.log(`  sources: loaded ${list.length} from ${SOURCES_URL}`); return list; }
  } catch (e) { console.log('  sources: fetch failed, using builtin:', e.message); }
  return SRC.builtin;
}

const BJ = 8 * 3600 * 1000; // Beijing offset ms

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function norm(s) {
  return String(s ?? '').trim().toLowerCase().replace(/[\s\-_]+/g, '');
}

function bjDate(ms) {
  return new Date(ms + BJ).toISOString().slice(0, 10);
}
function bjHM(ms) {
  return new Date(ms + BJ).toISOString().slice(11, 16);
}

// Parse XMLTV with regex (streaming-friendly enough for our sizes)
function parseXMLTV(xml, aliasOf) {
  const out = []; // {ch, start, stop, title}
  const chanRe = /<channel\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/channel>/g;
  const nameRe = /<display-name[^>]*>([^<]+)<\/display-name>/;
  const iconRe = /<icon\s+src="([^"]+)"[^>]*\/?>/;
  let m;
  while ((m = chanRe.exec(xml)) !== null) {
    const rawId = m[1];
    const body = m[2];
    const nm = nameRe.exec(body);
    const ic = iconRe.exec(body);
    out.push({ type: 'channel', id: rawId, name: nm ? nm[1].trim() : rawId, icon: ic ? ic[1] : '' });
  }
  const progRe = /<programme\s+([^>]*?)>([\s\S]*?)<\/programme>/g;
  const attrRe = /(\w+)="([^"]*)"/g;
  const titleRe = /<title[^>]*>([^<]*)<\/title>/;
  while ((m = progRe.exec(xml)) !== null) {
    const attrs = {};
    let a;
    while ((a = attrRe.exec(m[1])) !== null) attrs[a[1]] = a[2];
    const t = titleRe.exec(m[2]);
    if (!attrs.channel || !attrs.start || !t) continue;
    out.push({ type: 'prog', ch: attrs.channel, start: attrs.start, stop: attrs.stop || '', title: t[1].trim() });
  }
  return out;
}

function parseStart(s) {
  // "20261006003000 +0800" or "20261006003000"
  const mm = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-]\d{4}))?/.exec(s.trim());
  if (!mm) return null;
  const tz = mm[7] || '+0800';
  const sign = tz[0] === '-' ? -1 : 1;
  const tzh = parseInt(tz.slice(1, 3), 10), tzm = parseInt(tz.slice(3, 5), 10);
  const utc = Date.UTC(+mm[1], +mm[2] - 1, +mm[3], +mm[4], +mm[5], +mm[6]) - sign * (tzh * 60 + tzm) * 60000;
  return utc;
}

function fmtT(ms) {
  const d = new Date(ms + BJ);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} +0800`;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchOnce(url, timeoutMs, asText) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return asText ? await r.text() : await r.arrayBuffer();
  } finally { clearTimeout(t); }
}

// Retry up to 5 times with exponential backoff — helps with flaky networks
// Delays: 3s, 6s, 12s, 24s (total ~45s extra per source max)
async function fetchRetry(url, timeoutMs, asText, tries = 5) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fetchOnce(url, timeoutMs, asText); }
    catch (e) { lastErr = e; if (i < tries - 1) await sleep(3000 * Math.pow(2, i)); }
  }
  throw lastErr;
}

async function fetchText(url, timeoutMs = 60000) {
  return fetchRetry(url, timeoutMs, true);
}

async function fetchGzipText(url, timeoutMs = 90000) {
  const buf = await fetchRetry(url, timeoutMs, false);
  const ds = new DecompressionStream('gzip');
  const text = await new Response(new Blob([buf]).stream().pipeThrough(ds)).text();
  return text;
}

async function gzipBytes(str) {
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  writer.write(new TextEncoder().encode(str));
  writer.close();
  const buf = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(buf);
}

// ---- Schedule check: GitHub cron runs hourly; only do real work when due ----
// Settings from https://epg.cc.cd/settings.json (admin UI), default daily 01:00 Beijing
async function update() {
  const started = Date.now();
  const errors = [];
  const srcStats = {}; // name -> {name, ok, fetchMs, parsed, merged, dayMin, dayMax, error}
  const stat = name => (srcStats[name] ||= { name, ok: false, fetchMs: 0, parsed: 0, merged: 0, dayMin: null, dayMax: null, error: null });
  const noteParsed = (name, startMs) => {
    const s = stat(name);
    s.parsed++;
    const d = bjDate(startMs);
    if (!s.dayMin || d < s.dayMin) s.dayMin = d;
    if (!s.dayMax || d > s.dayMax) s.dayMax = d;
  };

  // ---- 1. Channel table (autoEPG official) ----
  const chTable = await (await fetch(SRC.channels)).json();
  const channels = {}; // canonicalId -> {id, name, icon}
  const aliasMap = {}; // normalized alias -> canonicalId
  for (const ch of chTable) {
    const id = String(ch.id);
    channels[id] = { id, name: ch.name || id, icon: ch.logo || ch.icon || '' };
    aliasMap[norm(id)] = id;
    if (ch.name) aliasMap[norm(ch.name)] = id;
    if (ch.aliases) for (const a of ch.aliases) aliasMap[norm(a)] = id;
  }
  // CCTV special: cctv1 -> cctv-1 etc.
  for (const id of Object.keys(channels)) {
    const mm = /^cctv(\d+[a-z]*)$/.exec(id.toLowerCase());
    if (mm) aliasMap['cctv-' + mm[1]] = id;
  }

  const aliasOf = raw => aliasMap[norm(raw)] || null;
  const ensureChannel = raw => {
    let id = aliasOf(raw);
    if (id) return id;
    // new channel (e.g. local stations from 112114): use raw name as id
    id = 'x-' + norm(raw).replace(/[^\w\u4e00-\u9fa5]/g, '').slice(0, 40);
    if (!channels[id]) channels[id] = { id, name: String(raw).trim(), icon: '' };
    aliasMap[norm(raw)] = id;
    return id;
  };

  // ---- 2. Merge programmes: 51zmt -> 112114 -> autoEPG (later wins) ----
  const progMap = new Map(); // key: chId|startMs -> {ch, start, stop, title, src}
  const putProg = (rawCh, startStr, stopStr, title, src, pri) => {
    if (!title) return;
    const ch = ensureChannel(rawCh);
    const start = parseStart(startStr);
    if (start == null) return;
    let stop = stopStr ? parseStart(stopStr) : null;
    if (stop == null || stop <= start) stop = start + 30 * 60000;
    noteParsed(src, start);
    progMap.set(ch + '|' + start, { ch, start, stop, title, src, pri });
  };

  // Generic XMLTV source merger
  async function mergeXMLTV(srcName, url, isGzip, pri, timeoutMs) {
    try {
      const t0 = Date.now();
      const xml = isGzip ? await fetchGzipText(url, timeoutMs) : await fetchText(url, timeoutMs);
      const items = parseXMLTV(xml, aliasOf);
      stat(srcName).fetchMs = Date.now() - t0;
      stat(srcName).ok = true;
      const chNames = {};
      for (const it of items) {
        if (it.type === 'channel') chNames[it.id] = it.name;
        else putProg(chNames[it.ch] || it.ch, it.start, it.stop, it.title, srcName, pri);
      }
    } catch (e) { stat(srcName).error = e.message; errors.push(srcName + ': ' + e.message); }
  }

  // 2a-2c. XMLTV sources from Worker config (or builtin fallback), sorted by priority
  const srcList = await loadSources();
  srcList.sort((a, b) => a[2] - b[2]); // low priority first, high priority overwrites
  for (const [sname, surl, spri] of srcList) {
    const gz = isGzipUrl(surl);
    await mergeXMLTV(sname, surl, gz, spri, gz ? 180000 : 120000);
  }

  // 2d. autoEPG official: 3-day + 7-day history
  const now = Date.now();
  const dayMs = 86400000;
  const bjToday = bjDate(now);
  const dates = [];
  for (let i = -7; i <= 0; i++) dates.push(bjDate(now + i * dayMs));
  try {
    const t0 = Date.now();
    const items = parseXMLTV(await fetchText(SRC.epg3, 120000), aliasOf);
    stat('autoEPG').fetchMs = Date.now() - t0;
    stat('autoEPG').ok = true;
    for (const it of items) if (it.type === 'prog') putProg(it.ch, it.start, it.stop, it.title, 'autoEPG', 3);
  } catch (e) { stat('autoEPG').error = e.message; errors.push('autoEPG epg3: ' + e.message); }
  const histDates = dates.filter(d => d !== bjToday);
  const settled = await Promise.allSettled(histDates.map(d => fetchText(SRC.hist(d), 60000)));
  let histOk = 0;
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status !== 'fulfilled') { errors.push('hist ' + histDates[i] + ': ' + (r.reason && r.reason.message)); continue; }
    try {
      const items = parseXMLTV(r.value, aliasOf);
      for (const it of items) if (it.type === 'prog') putProg(it.ch, it.start, it.stop, it.title, 'autoEPG', 3);
      histOk++;
    } catch (e) { errors.push('hist parse ' + histDates[i] + ': ' + e.message); }
  }
  stat('autoEPG').histDays = histDates.length;
  stat('autoEPG').histOk = histOk;

  // ---- 3. Window filter: past 7d + future 3d ----
  const winStart = now - 7 * dayMs, winEnd = now + 3 * dayMs;
  const progs = [];
  for (const p of progMap.values()) {
    if (p.start >= winStart && p.start < winEnd) progs.push(p);
  }
  progs.sort((a, b) => a.ch.localeCompare(b.ch) || a.start - b.start);
  // Second dedup: same channel + start within 2 min + same title -> keep higher-priority source
  // (look back up to 10 entries: a different-titled programme may sit between near-duplicates)
  const deduped = [];
  for (const p of progs) {
    let dupIdx = -1;
    for (let i = deduped.length - 1; i >= 0 && i >= deduped.length - 10; i--) {
      const q = deduped[i];
      if (q.ch !== p.ch) break;
      if (Math.abs(q.start - p.start) >= 120000) break;
      if (norm(q.title) === norm(p.title)) { dupIdx = i; break; }
    }
    if (dupIdx >= 0) {
      if ((p.pri || 0) >= (deduped[dupIdx].pri || 0)) deduped[dupIdx] = p;
    } else {
      deduped.push(p);
    }
  }
  progs.length = 0;
  for (let i = 0; i < deduped.length; i++) progs.push(deduped[i]);
  const usedCh = new Set(progs.map(p => p.ch));

  // ---- 3.5 Backfill missing icons: match by normalized name ----
  // e.g. "CCTV-1（高清）" -> "cctv1", "CCTV4欧洲" -> "cctv4"
  {
    const iconByNorm = {};
    for (const c of Object.values(channels)) {
      if (c.icon) {
        iconByNorm[norm(c.name)] = c.icon;
        iconByNorm[norm(c.id)] = c.icon;
      }
    }
    const baseKey = s => norm(String(s))
      .replace(/（[^）]*）/g, '')
      .replace(/\([^)]*\)/g, '')
      .replace(/(欧洲|美洲|亚洲|非洲|高清|超高清|4k)$/i, '');
    let filled = 0;
    for (const c of Object.values(channels)) {
      if (!c.icon) {
        const k = baseKey(c.name) || baseKey(c.id);
        if (k && iconByNorm[k]) { c.icon = iconByNorm[k]; filled++; }
      }
    }
    console.log(`icon backfill: filled ${filled}`);
  }

  // ---- 4. Build XMLTV ----
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="epg-new" generator-info-url="https://epg-new.13979219797.workers.dev">\n`;
  const sortedCh = [...usedCh].sort();
  for (const id of sortedCh) {
    const c = channels[id] || { id, name: id, icon: '' };
    xml += `<channel id="${esc(c.id)}"><display-name>${esc(c.name)}</display-name>${c.icon ? `<icon src="${esc(c.icon)}"/>` : ''}</channel>\n`;
  }
  for (const p of progs) {
    xml += `<programme channel="${esc(p.ch)}" start="${fmtT(p.start)}" stop="${fmtT(p.stop)}"><title lang="zh">${esc(p.title)}</title></programme>\n`;
  }
  xml += `</tv>\n`;

  // ---- 5. Build DIYP JSON ----
  // [{channel_name, date, epg_data:[{start:"HH:MM", end:"HH:MM", title}]}]
  const diypMap = {}; // chId -> date -> []
  for (const p of progs) {
    const c = channels[p.ch] || { name: p.ch };
    const d = bjDate(p.start);
    (diypMap[p.ch] ||= {})[d] ||= [];
    diypMap[p.ch][d].push({ start: bjHM(p.start), end: bjHM(p.stop), title: p.title });
  }
  const diyp = [];
  for (const id of sortedCh) {
    const c = channels[id] || { name: id };
    const byDate = diypMap[id] || {};
    for (const d of Object.keys(byDate).sort()) {
      diyp.push({ channel_name: c.name, date: d, epg_data: byDate[d] });
    }
  }
  const diypStr = JSON.stringify(diyp);

  // ---- 5b. Total failure check: no source succeeded -> keep old data, retry next hour ----
  // "Failure" = ALL sources failed. A single source failing is normal; partial data is still useful.
  const anyOk = Object.values(srcStats).some(s => s.ok);
  if (!anyOk) {
    console.log('TOTAL FAILURE: all sources failed, keeping previous data');
    const failLog = {
      time: new Date().toISOString(),
      durationMs: Date.now() - started,
      channels: 0,
      programmes: 0,
      sources: Object.values(srcStats).map(s => ({
        name: s.name, ok: false, fetchMs: s.fetchMs || 0, parsed: 0, merged: 0,
        dayMin: null, dayMax: null, histOk: null, error: s.error,
      })),
      errors,
    };
    try {
      let logs = [];
      try {
        const r = await fetch('https://epg.cc.cd/log.json');
        if (r.ok) logs = await r.json();
      } catch (e) { /* fresh */ }
      logs.unshift(failLog);
      logs = logs.slice(0, 30);
      await pushFile('logs.json', JSON.stringify(logs), 'application/json; charset=utf-8');
      console.log('  failure logged to logs.json, old data files untouched');
    } catch (e) { console.log('  could not push failure log:', e.message); }
    throw new Error('all sources failed');
  }

  // ---- 6. Upload to R2 via /push ----
  const gzXml = await gzipBytes(xml);
  const gzDiyp = await gzipBytes(diypStr);
  await uploadAll([
    ['epg.xml', xml, 'application/xml; charset=utf-8'],
    ['epg.xml.gz', gzXml, 'application/gzip'],
    ['diyp.json', diypStr, 'application/json; charset=utf-8'],
    ['diyp.json.gz', gzDiyp, 'application/gzip'],
  ]);

  const chList = sortedCh.map(id => {
    const c = channels[id] || { id, name: id, icon: '' };
    return { id: c.id, name: c.name, icon: c.icon };
  });
  await pushFile('channels.json', JSON.stringify(chList, null, 2), 'application/json; charset=utf-8');

  const meta = {
    updatedAt: new Date().toISOString(),
    updateDurationMs: Date.now() - started,
    channels: sortedCh.length,
    programmes: progs.length,
    xmlBytes: xml.length,
    xmlGzipBytes: gzXml.length,
    diypBytes: diypStr.length,
    diypGzipBytes: gzDiyp.length,
    rangeStart: progs.length ? new Date(progs[0].start).toISOString() : null,
    rangeEnd: progs.length ? new Date(progs[progs.length - 1].start).toISOString() : null,
    sources: ['TvWasm/autoEPG', ...srcList.map(s => s[0])],
    errors,
  };
  await pushFile('meta.json', JSON.stringify(meta, null, 2), 'application/json; charset=utf-8');

  // ---- 7. Per-source merged counts + run log history ----
  const mergedBySrc = {};
  const chSrc = {}; // chId -> src (first seen wins for channel attribution)
  for (const p of progs) {
    mergedBySrc[p.src] = (mergedBySrc[p.src] || 0) + 1;
    if (!chSrc[p.ch]) chSrc[p.ch] = p.src;
  }
  const chBySrc = {};
  for (const id of sortedCh) {
    const s = chSrc[id];
    if (s) chBySrc[s] = (chBySrc[s] || 0) + 1;
  }
  const runLog = {
    time: new Date().toISOString(),
    durationMs: Date.now() - started,
    channels: sortedCh.length,
    programmes: progs.length,
    sources: Object.values(srcStats).map(s => ({
      name: s.name, ok: s.ok, fetchMs: s.fetchMs,
      parsed: s.parsed, merged: mergedBySrc[s.name] || 0,
      channels: chBySrc[s.name] || 0,
      days: s.dayMin ? `${s.dayMin} ~ ${s.dayMax}` : null,
      histOk: s.histOk != null ? `${s.histOk}/${s.histDays}` : null,
      error: s.error,
    })),
    errors,
  };
  let logs = [];
  try {
    const r = await fetch('https://epg.cc.cd/log.json');
    if (r.ok) logs = await r.json();
  } catch (e) { /* fresh */ }
  logs.unshift(runLog);
  logs = logs.slice(0, 30);
  await pushFile('logs.json', JSON.stringify(logs), 'application/json; charset=utf-8');

  return meta;
}

function logPage(host, logs) {
  const latest = logs[0];
  const srcRows = latest ? latest.sources.map(s => `
    <tr>
      <td><b>${esc(s.name)}</b></td>
      <td>${s.ok ? '<span class="ok">正常</span>' : '<span class="bad">失败</span>'}</td>
      <td>${(s.fetchMs / 1000).toFixed(1)}s</td>
      <td>${s.parsed.toLocaleString()}</td>
      <td>${s.merged.toLocaleString()}</td>
      <td>${s.channels}</td>
      <td>${esc(s.days || '-')}</td>
      <td>${s.error ? '<span class="bad">' + esc(s.error) + '</span>' : (s.histOk ? '历史 ' + esc(s.histOk) + ' 天' : '-')}</td>
    </tr>`).join('') : '<tr><td colspan="8">暂无更新记录</td></tr>';
  const histRows = logs.map(l => `
    <tr>
      <td>${esc(l.time.replace('T', ' ').slice(0, 19))} UTC</td>
      <td>${(l.durationMs / 1000).toFixed(0)}s</td>
      <td>${l.channels}</td>
      <td>${l.programmes.toLocaleString()}</td>
      <td>${l.errors.length ? '<span class="bad">' + esc(l.errors[0]).slice(0, 60) + '</span>' : '<span class="ok">无</span>'}</td>
    </tr>`).join('');
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>更新日志 - EPG</title>
<style>
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;max-width:900px;margin:0 auto;padding:24px 16px;color:#222;background:#f7f8fa}
h1{font-size:20px}.card{background:#fff;border-radius:12px;padding:16px;margin:12px 0;box-shadow:0 1px 4px rgba(0,0,0,.06);overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:13px;min-width:640px}
th,td{border-bottom:1px solid #eee;padding:8px 6px;text-align:left;white-space:nowrap}
th{color:#888;font-weight:600}
.ok{color:#0a8a3c;font-weight:600}.bad{color:#d33;font-weight:600}
.hint{color:#888;font-size:13px}a{color:#1677ff}
</style></head><body>
<h1>📋 更新日志</h1>
<p class="hint"><a href="/">← 返回首页</a> · 每天北京时间凌晨 1 点自动更新 · 保留最近 30 次</p>
<div class="card"><h3>最新一次（${latest ? esc(latest.time.replace('T', ' ').slice(0, 19)) + ' UTC' : '-'}）数据源详情</h3>
<table><tr><th>数据源</th><th>状态</th><th>抓取耗时</th><th>解析节目数</th><th>有效节目数</th><th>覆盖频道</th><th>数据日期</th><th>备注</th></tr>
${srcRows}</table>
<p class="hint">解析节目数 = 从该源抓到的原始条数；有效节目数 = 去重合并后最终采用的条数（后抓取的源会覆盖先抓取的同名节目）。</p></div>
<div class="card"><h3>历史更新</h3>
<table><tr><th>更新时间</th><th>耗时</th><th>频道</th><th>节目</th><th>错误</th></tr>${histRows}</table></div>
</body></html>`;
}


// ---- main ----
const t0 = Date.now();
try {
  const meta = await update();
  if (!meta) { console.log('SKIPPED, exiting 0'); process.exit(0); }
  console.log(`DONE in ${((Date.now()-t0)/1000).toFixed(0)}s | channels=${meta.channels} programmes=${meta.programmes}`);
  if (meta.errors.length) { console.log('ERRORS:'); for (const e of meta.errors) console.log('  -', e); }
} catch (e) {
  console.error('UPDATE FAILED:', e.message);
  process.exit(1);
}
