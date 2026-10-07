// epg-new Worker: independent EPG service
// Sources: TvWasm/autoEPG (official) + 8 XMLTV sources (configurable via EPG_SOURCES / admin UI)
// Outputs: XMLTV, GZip, DIYP JSON, channels.json, meta.json
// Schedule: daily 01:00 Beijing (17:00 UTC)

const SRC = {
  channels: 'https://github.com/TvWasm/autoEPG/releases/latest/download/channels.json',
  epg3: 'https://github.com/TvWasm/autoEPG/releases/latest/download/epg3.xml',
  hist: d => `https://github.com/TvWasm/autoEPG/releases/download/${d}/epg.xml`,
  zmt: 'https://epg.51zmt.top:8001/e.xml',
  pp112114: 'https://epg.112114.xyz/pp.xml.gz',
};

const BJ = 8 * 3600 * 1000;
// Default EPG source list (one per line: name|url|priority). Override via Worker variable EPG_SOURCES.
// priority: 1=low, 2=normal, 3=high (autoEPG official is always 3, hardcoded in updater).
// gzip is auto-detected from URL (.gz suffix or type=gz param).
const DEFAULT_SOURCES = `# 名称|URL|优先级(1-3,默认2)
51zmt|https://epg.51zmt.top:8001/e.xml|1
112114|https://epg.112114.xyz/pp.xml.gz|2
v1mk|https://epg.v1.mk/fy.xml|2
epgpw|https://epg.pw/xmltv/epg_CN.xml|2
sparkpp|https://raw.githubusercontent.com/sparkssssssssss/epg/main/pp.xml|2
zsdc|https://epg.zsdc.eu.org/t.xml|2
kuke31|https://raw.githubusercontent.com/kuke31/xmlgz/main/all.xml.gz|2
liliu|https://liliu.serv00.net/epg/download.php?type=gz|2
`; // Beijing offset ms

const DEFAULT_ADMIN_PASSWORD = 'admin';

async function getAdminPassword(env) {
  // Priority: R2 stored > env var > default 'admin'
  try {
    const o = await env.EPG_BUCKET.get('admin_pass.txt');
    if (o) {
      const p = (await o.text()).trim();
      if (p) return { password: p, isDefault: false, source: 'r2' };
    }
  } catch (e) {}
  if (env.ADMIN_PASSWORD) return { password: env.ADMIN_PASSWORD, isDefault: false, source: 'env' };
  return { password: DEFAULT_ADMIN_PASSWORD, isDefault: true, source: 'default' };
}

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
function bjTimeStr(iso) {
  // "2026-10-05T19:21:11Z" -> "2026-10-06 03:21:11" (Beijing)
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  const b = new Date(d.getTime() + BJ);
  const p = n => String(n).padStart(2, '0');
  return `${b.getUTCFullYear()}-${p(b.getUTCMonth() + 1)}-${p(b.getUTCDate())} ${p(b.getUTCHours())}:${p(b.getUTCMinutes())}:${p(b.getUTCSeconds())}`;
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

async function fetchText(url, timeoutMs = 60000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(t); }
}

async function fetchGzipText(url, timeoutMs = 90000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = await r.arrayBuffer();
    const ds = new DecompressionStream('gzip');
    const text = await new Response(new Blob([buf]).stream().pipeThrough(ds)).text();
    return text;
  } finally { clearTimeout(t); }
}

async function gzipBytes(str) {
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  writer.write(new TextEncoder().encode(str));
  writer.close();
  const buf = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(buf);
}

async function update(env) {
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

  // 2a. 51zmt (2 days, CCTV + 卫视)
  try {
    const t0 = Date.now();
    const items = parseXMLTV(await fetchText(SRC.zmt), aliasOf);
    stat('51zmt').fetchMs = Date.now() - t0;
    stat('51zmt').ok = true;
    const chNames = {};
    for (const it of items) {
      if (it.type === 'channel') chNames[it.id] = it.name;
      else putProg(chNames[it.ch] || it.ch, it.start, it.stop, it.title, '51zmt', 1);
    }
  } catch (e) { stat('51zmt').error = e.message; errors.push('51zmt: ' + e.message); }

  // 2b. 112114 pp.xml.gz (today, ~493 channels incl. local stations)
  try {
    const t0 = Date.now();
    const items = parseXMLTV(await fetchGzipText(SRC.pp112114), aliasOf);
    stat('112114').fetchMs = Date.now() - t0;
    stat('112114').ok = true;
    const chNames = {};
    for (const it of items) {
      if (it.type === 'channel') chNames[it.id] = it.name;
      else putProg(chNames[it.ch] || it.ch, it.start, it.stop, it.title, '112114', 2);
    }
  } catch (e) { stat('112114').error = e.message; errors.push('112114: ' + e.message); }

  // 2c. autoEPG official: 3-day + 7-day history
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

  // ---- 6. Upload to R2 ----
  const gzXml = await gzipBytes(xml);
  const gzDiyp = await gzipBytes(diypStr);
  await env.EPG_BUCKET.put('epg.xml', xml, { httpMetadata: { contentType: 'application/xml; charset=utf-8' } });
  await env.EPG_BUCKET.put('epg.xml.gz', gzXml, { httpMetadata: { contentType: 'application/gzip' } });
  await env.EPG_BUCKET.put('diyp.json', diypStr, { httpMetadata: { contentType: 'application/json; charset=utf-8' } });
  await env.EPG_BUCKET.put('diyp.json.gz', gzDiyp, { httpMetadata: { contentType: 'application/gzip' } });

  const chList = sortedCh.map(id => {
    const c = channels[id] || { id, name: id, icon: '' };
    return { id: c.id, name: c.name, icon: c.icon };
  });
  await env.EPG_BUCKET.put('channels.json', JSON.stringify(chList), { httpMetadata: { contentType: 'application/json; charset=utf-8' } });

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
    sources: ['TvWasm/autoEPG', '+8 XMLTV (see /sources.txt)'],
    errors,
  };
  await env.EPG_BUCKET.put('meta.json', JSON.stringify(meta), { httpMetadata: { contentType: 'application/json; charset=utf-8' } });

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
    const old = await env.EPG_BUCKET.get('logs.json');
    if (old) logs = JSON.parse(await old.text());
  } catch (e) { /* fresh */ }
  logs.unshift(runLog);
  logs = logs.slice(0, 30);
  await env.EPG_BUCKET.put('logs.json', JSON.stringify(logs), { httpMetadata: { contentType: 'application/json; charset=utf-8' } });

  return meta;
}

function logPage(host, logs, actions) {
  const latest = logs[0];
  const srcRows = latest ? latest.sources.map(s => `
    <tr>
      <td><b>${esc(s.name)}</b></td>
      <td>${s.ok ? '<span class="ok">正常</span>' : '<span class="bad">失败</span>'}</td>
      <td>${(s.fetchMs / 1000).toFixed(1)}s</td>
      <td>${s.parsed.toLocaleString()}</td>
      <td>${s.merged.toLocaleString()}</td>
      <td>${(s.parsed - s.merged).toLocaleString()}</td>
      <td>${s.channels}</td>
      <td>${esc(s.days || '-')}</td>
      <td>${s.error ? '<span class="bad">' + esc(s.error) + '</span>' : (s.histOk ? '历史 ' + esc(s.histOk) + ' 天' : '-')}</td>
    </tr>`).join('') : '<tr><td colspan="9">暂无更新记录</td></tr>';
  const runRows = (actions || []).map(a => {
    const at = new Date(a.time).getTime();
    const match = logs.find(l => {
      const lt = new Date(l.time).getTime();
      return lt >= at - 60000 && lt <= at + 15 * 60000;
    });
    const ok = a.status === 'success';
    return `
    <tr>
      <td>${esc(bjTimeStr(a.time))}</td>
      <td>${ok ? '<span class="ok">成功</span>' : '<span class="bad">' + esc(a.status) + '</span>'}</td>
      <td>${match ? match.channels : '-'}</td>
      <td>${match ? match.programmes.toLocaleString() : '-'}</td>
      <td>${a.url ? `<a href="${esc(a.url)}" target="_blank">查看运行</a>` : '-'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="5">暂无运行记录</td></tr>';
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
<p class="hint"><a href="/">← 返回首页</a> · 每天 00:46、07:47、12:33（北京时间）自动更新 · 保留最近 30 次</p>
<div class="card"><h3>定时任务运行记录</h3>
<table><tr><th>运行时间</th><th>状态</th><th>频道</th><th>节目</th><th>详情</th></tr>${runRows}</table>
<p class="hint">状态来自 GitHub Actions；失败时频道/节目显示为 -，点"查看运行"看具体报错。</p></div>
<div class="card"><h3>最新一次（${latest ? esc(bjTimeStr(latest.time)) : '-'}）数据源详情</h3>
<table><tr><th>数据源</th><th>状态</th><th>抓取耗时</th><th>解析节目数</th><th>有效节目数</th><th>重复跳过</th><th>覆盖频道</th><th>数据日期</th><th>备注</th></tr>
${srcRows}</table>
<p class="hint">解析节目数 = 从该源抓到的原始条数；有效节目数 = 去重合并后最终采用的条数；重复跳过 = 与其他源重复未采用的条数。源列表可在 Cloudflare 后台 Worker 变量 EPG_SOURCES 中修改（一行一个）。</p></div>
</body></html>`;
}

function adminPage() {
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>设置</title>
<style>
*{box-sizing:border-box}
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;max-width:720px;margin:0 auto;padding:24px 16px 40px;color:#1d1d1f;background:#f7f8fa}
h1{font-size:22px;margin:4px 0 4px}
.sub{color:#6b7280;font-size:13px;margin:0 0 16px}
.card{background:#fff;border-radius:14px;padding:16px 18px;margin:12px 0;box-shadow:0 2px 10px rgba(30,64,175,.06)}
.row{display:flex;gap:8px;align-items:center;padding:10px 0;border-bottom:1px solid #f1f5f9;flex-wrap:wrap}
.row:last-child{border:none}
.row .nm{font-weight:700;width:90px;flex-shrink:0}
.row .url{flex:1;min-width:200px;font-size:12px;color:#4b5563;word-break:break-all;font-family:ui-monospace,monospace}
select.pri{padding:6px;border:1px solid #d1d5db;border-radius:8px;font-size:13px}
button{border-radius:10px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;border:none}
.btn-del{background:#fee2e2;color:#b91c1c}
.btn-add{background:#2563eb;color:#fff}
.btn-save{background:#059669;color:#fff;padding:10px 28px;font-size:15px}
.btn-login{background:#2563eb;color:#fff;padding:10px 28px;font-size:15px;width:100%}
input[type=text],input[type=password]{width:100%;padding:10px 12px;border:1.5px solid #d1d5db;border-radius:10px;font-size:14px;margin:6px 0}
input:focus{outline:none;border-color:#2563eb}
.formgrid{display:grid;grid-template-columns:110px 1fr 90px;gap:8px;margin:10px 0}
.hint{font-size:12px;color:#9ca3af;line-height:1.7}
.err{color:#b91c1c;font-size:13px;margin:8px 0;display:none}
.okmsg{color:#059669;font-size:13px;margin:8px 0;display:none}
.back{display:inline-block;margin-bottom:8px;color:#2563eb;text-decoration:none;font-size:14px}
.badge{font-size:11px;border-radius:6px;padding:2px 8px;font-weight:700}
.p1{background:#fef3c7;color:#92400e}.p2{background:#dbeafe;color:#1d4ed8}.p3{background:#fce7f3;color:#9d174d}
</style></head><body>
<h1>⚙️ 设置</h1>
<p class="sub"><a class="back" href="/">← 返回首页</a></p>
<div class="card" id="loginCard">
  <h3 style="margin:4px 0 8px">请输入管理密码</h3>
  <input type="password" id="pwd" placeholder="管理密码" onkeydown="if(event.key==='Enter')doLogin()">
  <div class="err" id="loginErr"></div>
  <button class="btn-login" onclick="doLogin()">登录</button>
  <p class="hint">默认密码 admin，首次登录后请修改。也可以在 Cloudflare 后台设置 ADMIN_PASSWORD 变量。</p>
</div>
<div id="mainUI" style="display:none">
  <div class="card"><h3 style="margin:4px 0">当前数据源 <span class="hint" id="cnt"></span></h3><div id="list"></div></div>
  <div class="card"><h3 style="margin:4px 0">添加新源</h3>
    <div class="formgrid">
      <input type="text" id="nName" placeholder="名称">
      <input type="text" id="nUrl" placeholder="https://...">
      <select id="nPri" class="pri"><option value="1">优先级 1</option><option value="2" selected>优先级 2</option><option value="3">优先级 3</option></select>
    </div>
    <button class="btn-add" onclick="addSrc()">＋ 添加</button>
    <p class="hint">优先级：1=低（先抓取，易被覆盖），3=高（官方源，后抓取覆盖其他）。gzip 会自动识别（.gz 结尾或 type=gz）。改完点下方保存，GitHub 第二天凌晨自动生效。</p>
  </div>

  <div style="text-align:center;margin:16px 0">
    <button class="btn-save" onclick="saveAll()">💾 保存全部</button>
    <div class="okmsg" id="saveOk">已保存 ✓</div>
    <div class="err" id="saveErr"></div>
  </div>
</div>
<script>
var _pwd='', _list=[];
function api(action, extra){
  var b = Object.assign({action:action, password:_pwd}, extra||{});
  return fetch('/admin/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(function(r){return r.json();});
}
function doLogin(){
  _pwd = document.getElementById('pwd').value;
  api('get').then(function(d){
    if(d.ok){
      document.getElementById('loginCard').style.display='none';
      document.getElementById('mainUI').style.display='block';
      _list=d.sources; render();
      api('check_default').then(function(c){
        if(c.ok && c.isDefault){
          var np = prompt('当前使用默认密码 admin，请设置新密码（至少4位）：');
          if(np && np.trim().length >= 4){
            api('change_password',{newPassword:np.trim()}).then(function(r){
              if(r.ok){ _pwd = np.trim(); alert('密码已修改，请牢记新密码'); }
              else alert('修改失败：'+(r.error||'未知错误'));
            });
          } else if(np !== null){
            alert('密码至少4位，请稍后在设置中修改');
          }
        }
      });
    }
    else { var e=document.getElementById('loginErr'); e.textContent=d.error||'登录失败'; e.style.display='block'; }
  });
}
function priBadge(p){ return '<span class="badge p'+p+'">P'+p+'</span>'; }
function render(){
  var h='';
  _list.forEach(function(s,i){
    h += '<div class="row"><span class="nm">'+esc(s.name)+'</span>'
      + '<span class="url">'+esc(s.url)+'</span>'
      + priBadge(s.priority)
      + '<select class="pri" onchange="setPri('+i+',this.value)">'
      + [1,2,3].map(function(p){return '<option value="'+p+'"'+(p===s.priority?' selected':'')+'>P'+p+'</option>';}).join('')
      + '</select>'
      + '<button class="btn-del" onclick="delSrc('+i+')">删除</button></div>';
  });
  document.getElementById('list').innerHTML = h || '<p class="hint">暂无数据源</p>';
  document.getElementById('cnt').textContent = '（共 '+_list.length+' 个）';
}
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function setPri(i,v){ _list[i].priority = parseInt(v,10); render(); }
function delSrc(i){ if(confirm('删除 "'+_list[i].name+'"？')){ _list.splice(i,1); render(); } }
function addSrc(){
  var n=document.getElementById('nName').value.trim(), u=document.getElementById('nUrl').value.trim(), p=parseInt(document.getElementById('nPri').value,10);
  if(!u || u.indexOf('http')!==0){ alert('URL 必须以 http 开头'); return; }
  _list.push({name:n||('src'+(_list.length+1)), url:u, priority:p});
  document.getElementById('nName').value=''; document.getElementById('nUrl').value='';
  render();
}
function saveAll(){
  api('save',{sources:_list}).then(function(d){
    if(d.ok){ var e=document.getElementById('saveOk'); e.textContent='已保存 ✓（共 '+d.count+' 个源）'; e.style.display='block';
      setTimeout(function(){e.style.display='none';},2000); }
    else { var x=document.getElementById('saveErr'); x.textContent=d.error||'保存失败'; x.style.display='block'; }
  });
}
</script></body></html>`;
}

async function nextUpdateStr(env) {
  const s = await getSettings(env);
  const now = Date.now();
  const BJ = 8 * 3600000;
  let lastRun = 0;
  try {
    const o = await env.EPG_BUCKET.get('meta.json');
    if (o) lastRun = new Date(JSON.parse(await o.text()).updatedAt).getTime() || 0;
  } catch (e) { /* none yet */ }
  const slot = latestDueSlot(now, s);
  if (slot && lastRun < slot) return '即将更新';
  // next slot after now
  const iv = Math.min(24, Math.max(1, parseInt(s.intervalHours) || 6)) * 3600000;
  const bj = new Date(now + BJ);
  const [sh, sm] = String(s.startTime || '01:00').split(':').map(Number);
  const day0 = new Date(bj);
  day0.setUTCHours(0, 0, 0, 0);
  let next = day0.getTime() + sh * 3600000 + sm * 60000;
  while (next <= bj.getTime()) next += iv;
  const nbj = new Date(next);
  const sameDay = nbj.toISOString().slice(0, 10) === bj.toISOString().slice(0, 10);
  const hm = String(nbj.getUTCHours()).padStart(2, '0') + ':' + String(nbj.getUTCMinutes()).padStart(2, '0');
  return '下次 ' + (sameDay ? '今天 ' : '明天 ') + hm + ' 更新';
}
function channelsPage() {
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>频道列表 - EPG</title><style>
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f4f6fb;margin:0;padding:16px;color:#1f2937}
.wrap{max-width:900px;margin:0 auto}
h1{font-size:20px;margin:8px 0 12px}
.search{width:100%;box-sizing:border-box;padding:12px 16px;font-size:16px;border:1px solid #d1d5db;border-radius:12px;margin-bottom:12px;outline:none}
.search:focus{border-color:#3b82f6}
.count{color:#6b7280;font-size:14px;margin-bottom:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px}
.card{background:#fff;border-radius:12px;padding:12px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.card img{width:48px;height:48px;object-fit:contain;margin-bottom:8px}
.card .nm{font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.back{display:inline-block;margin-bottom:12px;color:#3b82f6;text-decoration:none;font-size:14px}
</style></head><body><div class="wrap">
<a class="back" href="/">← 返回首页</a>
<h1>📺 频道列表</h1>
<input class="search" id="q" placeholder="🔍 搜索频道名称…" oninput="filter()">
<div class="count" id="count"></div>
<div class="grid" id="grid"></div>
</div><script>
var _all=[];
fetch('/channels.json').then(function(r){return r.json();}).then(function(d){
  _all = Array.isArray(d) ? d : (d.channels||[]);
  render('');
});
function render(kw){
  var kwl = kw.trim().toLowerCase();
  var list = _all.filter(function(c){
    return !kwl || (c.name||'').toLowerCase().indexOf(kwl) >= 0;
  });
  document.getElementById('count').textContent = '共 ' + list.length + ' 个频道' + (kwl ? '（搜索：'+kw+'）' : '');
  var h = '';
  list.forEach(function(c){
    var icon = c.icon ? '<img src="'+c.icon+'" loading="lazy">' : '<div style="width:48px;height:48px;margin:0 auto 8px;background:#e5e7eb;border-radius:8px"></div>' '<div style="width:48px;height:48px;margin:0 auto 8px;background:#e5e7eb;border-radius:8px"></div>';
    h += '<div class="card">'+icon+'<div class="nm" title="'+esc(c.name)+'">'+esc(c.name)+'</div></div>';
  });
  document.getElementById('grid').innerHTML = h || '<p style="color:#9ca3af">没有找到匹配的频道</p>';
}
function filter(){ render(document.getElementById('q').value); }
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
</script></body></html>`;
}

function homePage(host) {
  const subs = [
    ['XML 节目单', '/epg.xml', 'TiviMate / IPTV Pro / Kodi 等通用格式'],
    ['XML 压缩包', '/epg.xml.gz', 'GZip 压缩，体积更小'],
    ['DIYP 接口', '/d', 'DIYP / 酷9 播放器 EPG 栏直接填此地址'],
  ].map(([label, path, desc]) => `
    <div class="row">
      <div class="rowmain">
        <span class="label">${label}</span>
        <span class="desc">${desc}</span>
        <code class="url">${host}${path}</code>
      </div>
      <button class="copy" data-url="${host}${path}" onclick="copyUrl(this)">复制</button>
    </div>`).join('');
  const views = [
    ['频道列表', '/channels', '全部频道及台标'],
    ['更新状态', '/meta.json', '数据量、时间范围'],
    ['更新日志', '/log', '每次更新记录'],
  ].map(([label, path, desc]) => `
    <a class="viewlink" href="${path}">
      <div class="row">
        <div class="rowmain">
          <span class="label">${label} <span class="arrow">›</span></span>
          <span class="desc">${desc}</span>
        </div>
      </div>
    </a>`).join('');
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>EPG 节目单服务</title>
<style>
*{box-sizing:border-box}
body{font-family:-apple-system,"PingFang SC","HarmonyOS Sans SC","Microsoft YaHei",sans-serif;max-width:680px;margin:0 auto;padding:28px 16px 40px;color:#1d1d1f;background:linear-gradient(180deg,#eef2ff 0%,#f7f8fa 220px)}
h1{font-size:24px;margin:6px 0 4px;letter-spacing:.5px}
.sub{color:#6b7280;font-size:13px;line-height:1.9;margin:0 0 18px}
.sub a{color:#2563eb;text-decoration:none;border-bottom:1px dashed #93c5fd}
.sub a:hover{border-bottom-style:solid}
.card{background:#fff;border-radius:16px;padding:6px 18px;margin:14px 0;box-shadow:0 2px 12px rgba(30,64,175,.07)}
.card h3{font-size:15px;margin:14px 0 4px;color:#111827}
.row{display:flex;align-items:center;gap:10px;padding:13px 0;border-bottom:1px solid #f1f5f9}
.row:last-child{border-bottom:none}
.rowmain{flex:1;min-width:0}
.label{font-weight:700;font-size:15px;display:block}
.desc{font-size:12px;color:#9ca3af;display:block;margin:2px 0 6px}
.url{display:block;word-break:break-all;background:#f3f4f6;padding:7px 10px;border-radius:8px;font-size:12px;color:#374151;font-family:ui-monospace,Menlo,monospace}
.copy{border:1.5px solid #2563eb;color:#2563eb;background:#eff6ff;border-radius:10px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;flex-shrink:0;transition:all .15s}
.copy:active{background:#2563eb;color:#fff;transform:scale(.96)}
a.viewlink{text-decoration:none;color:inherit;display:block}
a.viewlink .row{cursor:pointer;border-radius:10px;transition:background .15s}
a.viewlink:hover .row{background:#f8fafc}
.arrow{color:#c7cdd6;font-weight:400}
.api{margin:12px 0 16px;background:#f8fafc;border:1px solid #eef2f7;border-radius:12px;padding:12px 14px;font-size:13px}
.api .t{font-weight:700;margin-bottom:8px;display:block}
.api code{display:block;background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px;margin:6px 0;font-size:12px;word-break:break-all;color:#1f2937;font-family:ui-monospace,Menlo,monospace}
.api .ex{color:#6b7280;font-size:12px}
#toast{position:fixed;bottom:48px;left:50%;transform:translateX(-50%);background:#111827;color:#fff;padding:10px 22px;border-radius:999px;display:none;font-size:14px;box-shadow:0 4px 16px rgba(0,0,0,.2);z-index:99}
.badge{display:inline-block;font-size:11px;background:#ecfdf5;color:#047857;border-radius:999px;padding:2px 10px;margin-left:8px;vertical-align:2px;font-weight:600}
.hdr{display:flex;align-items:center;justify-content:space-between}
.gear{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:12px;background:#fff;box-shadow:0 2px 10px rgba(30,64,175,.08);text-decoration:none;font-size:20px;flex-shrink:0}
.gear:hover{background:#f1f5f9}
</style></head><body>
<div class="hdr"><h1>📺 EPG 节目单服务</h1><a class="gear" href="/admin" title="设置">⚙️</a></div>
<p class="sub">回看 7 天 · 预告未来 3 天</p>
<div class="card"><h3>订阅地址</h3>${subs}
</div>
<div class="card"><h3>查看</h3>${views}</div>
<div id="toast">已复制 ✓</div>
<script>
function copyUrl(btn){
  var url=btn.getAttribute('data-url');
  function done(){var t=document.getElementById('toast');t.style.display='block';clearTimeout(t._h);t._h=setTimeout(function(){t.style.display='none'},1300);}
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(url).then(done).catch(function(){fallback();});}
  else fallback();
  function fallback(){var ta=document.createElement('textarea');ta.value=url;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();try{document.execCommand('copy');done();}catch(e){}document.body.removeChild(ta);}
}
</script>
</body></html>`;
}

async function serveR2(env, key, contentType) {
  const obj = await env.EPG_BUCKET.get(key);
  if (!obj) return new Response('Not generated yet.', { status: 503 });
  return new Response(obj.body, { headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=1800' } });
}

// In-memory cache for diyp query API
let diypCache = null;
let diypCacheAt = 0;

async function diypQuery(env, url) {
  const ch = url.searchParams.get('ch') || url.searchParams.get('channel') || '';
  const dateParam = url.searchParams.get('date') || '';
  if (!ch) return new Response(JSON.stringify({ error: 'missing ch parameter' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(dateParam);
  const date = m ? `${m[1]}-${m[2]}-${m[3]}` : bjDate(Date.now());

  if (!diypCache || Date.now() - diypCacheAt > 10 * 60000) {
    const obj = await env.EPG_BUCKET.get('diyp.json');
    if (!obj) return new Response(JSON.stringify({ error: 'not generated yet' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    diypCache = JSON.parse(await obj.text());
    diypCacheAt = Date.now();
  }
  const nch = norm(ch);
  const hit = diypCache.find(e => norm(e.channel_name) === nch);
  if (!hit) return new Response(JSON.stringify({ channel_name: ch, date, epg_data: [] }), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  const day = diypCache.find(e => norm(e.channel_name) === nch && e.date === date);
  return new Response(JSON.stringify(day || { channel_name: hit.channel_name, date, epg_data: [] }), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

// ---- EPG source list management ----
// Precedence: R2 sources.json (admin UI) > Worker var EPG_SOURCES > builtin default
function parseSourceText(text) {
  const out = [];
  const re = /([^\s|#][^\s|]*)\|(https?:\/\/[^\s|]+)(?:\|([123]))?/g;
  const s = String(text || '');
  let m;
  while ((m = re.exec(s)) !== null) {
    const ls = s.lastIndexOf('\n', m.index - 1) + 1;
    if (s.slice(ls, m.index).trimStart().startsWith('#')) continue;
    out.push({ name: m[1].trim(), url: m[2].trim(), priority: m[3] ? parseInt(m[3], 10) : 2 });
  }
  return out;
}
function defaultSources() { return parseSourceText(DEFAULT_SOURCES); }
const DEFAULT_SETTINGS = { startTime: '01:00', intervalHours: 6 };
async function getSettings(env) {
  try {
    const o = await env.EPG_BUCKET.get('settings.json');
    if (o) {
      const s = JSON.parse(await o.text());
      // new schema: startTime + intervalHours; migrate from old mode/dailyTime
      let startTime = s.startTime;
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime || '')) {
        startTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(s.dailyTime || '') ? s.dailyTime : '01:00';
      }
      return {
        startTime,
        intervalHours: Math.min(24, Math.max(1, parseInt(s.intervalHours) || 6)),
      };
    }
  } catch (e) { /* fall through */ }
  return { ...DEFAULT_SETTINGS };
}
// due(dateMs, settings): latest expected slot (Beijing ms) <= now, or 0 if none yet today
function latestDueSlot(nowMs, s) {
  const BJ = 8 * 3600000;
  const bj = new Date(nowMs + BJ);
  const [sh, sm] = String(s.startTime || '01:00').split(':').map(Number);
  const day0 = new Date(bj);
  day0.setUTCHours(0, 0, 0, 0);
  const start = day0.getTime() + sh * 3600000 + sm * 60000; // Beijing ms
  const nowBj = bj.getTime();
  if (nowBj < start) return 0;
  const iv = Math.min(24, Math.max(1, parseInt(s.intervalHours) || 6)) * 3600000;
  const n = Math.floor((nowBj - start) / iv);
  return start - BJ + n * iv; // back to UTC ms
}
async function getSources(env) {
  try {
    const o = await env.EPG_BUCKET.get('sources.json');
    if (o) {
      const arr = JSON.parse(await o.text());
      if (Array.isArray(arr) && arr.length) return arr.filter(s => s && s.url).map(s => ({
        name: String(s.name || 'src'), url: String(s.url), priority: [1,2,3].includes(s.priority) ? s.priority : 2,
      }));
    }
  } catch (e) { /* fall through */ }
  if (env.EPG_SOURCES) {
    const arr = parseSourceText(env.EPG_SOURCES);
    if (arr.length) return arr;
  }
  return defaultSources();
}
function sourcesToText(list) {
  return list.map(s => `${s.name}|${s.url}|${s.priority}`).join('\n') + '\n';
}

export async function handleRequest(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    const host = url.origin;
    if (p === '/') {
      return new Response(homePage(host), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (p === '/epg.xml') return serveR2(env, 'epg.xml', 'application/xml; charset=utf-8');
    if (p === '/epg.xml.gz') return serveR2(env, 'epg.xml.gz', 'application/gzip');
    if (p === '/diyp.json') return serveR2(env, 'diyp.json', 'application/json; charset=utf-8');
    if (p === '/diyp.json.gz') return serveR2(env, 'diyp.json.gz', 'application/gzip');
    if (p === '/channels.json') return serveR2(env, 'channels.json', 'application/json; charset=utf-8');
    if (p === '/channels') {
      return new Response(channelsPage(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (p === '/meta.json') return serveR2(env, 'meta.json', 'application/json; charset=utf-8');
    if (p === '/log.json') return serveR2(env, 'logs.json', 'application/json; charset=utf-8');
    if (p === '/actions.json') return serveR2(env, 'actions.json', 'application/json; charset=utf-8');
    if (p === '/push' && req.method === 'POST') {
      // VM-side updater pushes generated files here (free plan: keep Worker CPU minimal)
      const token = url.searchParams.get('token');
      const key = url.searchParams.get('key');
      const expected = env.UPDATE_TOKEN;
      const allowed = ['epg.xml', 'epg.xml.gz', 'diyp.json', 'diyp.json.gz', 'channels.json', 'meta.json', 'logs.json', 'actions.json', 'sources.json'];
      if (!expected || token !== expected) return new Response('forbidden', { status: 403 });
      if (!allowed.includes(key)) return new Response('bad key', { status: 400 });
      const ct = key.endsWith('.gz') ? 'application/gzip' : key.endsWith('.json') ? 'application/json; charset=utf-8' : 'application/xml; charset=utf-8';
      await env.EPG_BUCKET.put(key, req.body, { httpMetadata: { contentType: ct } });
      return new Response('ok', { status: 200 });
    }
    if (p === '/sources.txt') {
      const list = await getSources(env);
      return new Response(sourcesToText(list), {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' },
      });
    }
    if (p === '/sources.json') {
      const list = await getSources(env);
      return new Response(JSON.stringify(list), {
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' },
      });
    }
    if (p === '/settings.json') {
      const s = await getSettings(env);
      return new Response(JSON.stringify(s), {
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' },
      });
    }
    if (p === '/admin') {
      return new Response(adminPage(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (p === '/admin/api' && req.method === 'POST') {
      let body = {};
      try { body = await req.json(); } catch (e) { return new Response('bad json', { status: 400 }); }
      const { password: adminPwd, isDefault } = await getAdminPassword(env);
      if (!adminPwd || body.password !== adminPwd) {
        return new Response(JSON.stringify({ ok: false, error: '密码错误' }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (body.action === 'check_default') {
        return new Response(JSON.stringify({ ok: true, isDefault }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (body.action === 'change_password') {
        const np = String(body.newPassword || '').trim();
        if (np.length < 4) {
          return new Response(JSON.stringify({ ok: false, error: '密码至少4位' }), { headers: { 'Content-Type': 'application/json' } });
        }
        await env.EPG_BUCKET.put('admin_pass.txt', np, {
          httpMetadata: { contentType: 'text/plain; charset=utf-8' },
        });
        return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (body.action === 'get') {
        const list = await getSources(env);
        return new Response(JSON.stringify({ ok: true, sources: list }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (body.action === 'get_settings') {
        const s = await getSettings(env);
        return new Response(JSON.stringify({ ok: true, settings: s }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (body.action === 'save_settings') {
        const s = body.settings || {};
        const settings = {
          mode: s.mode === 'interval' ? 'interval' : 'daily',
          dailyTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(s.dailyTime || '') ? s.dailyTime : '01:00',
          intervalHours: Math.min(24, Math.max(1, parseInt(s.intervalHours) || 6)),
        };
        await env.EPG_BUCKET.put('settings.json', JSON.stringify(settings, null, 2), {
          httpMetadata: { contentType: 'application/json; charset=utf-8' },
        });
        return new Response(JSON.stringify({ ok: true, settings }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (body.action === 'save') {
        const list = (body.sources || []).filter(s => s && s.url && String(s.url).startsWith('http')).map(s => ({
          name: String(s.name || 'src').slice(0, 40), url: String(s.url).slice(0, 500),
          priority: [1, 2, 3].includes(s.priority) ? s.priority : 2,
        }));
        await env.EPG_BUCKET.put('sources.json', JSON.stringify(list, null, 2), {
          httpMetadata: { contentType: 'application/json; charset=utf-8' },
        });
        // allow /push for sources.json so updater can also write it if needed
        return new Response(JSON.stringify({ ok: true, count: list.length }), { headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: false, error: 'unknown action' }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (p === '/log') {
      let logs = [], actions = [];
      try {
        const o1 = await env.EPG_BUCKET.get('logs.json');
        if (o1) logs = JSON.parse(await o1.text());
        const o2 = await env.EPG_BUCKET.get('actions.json');
        if (o2) actions = JSON.parse(await o2.text());
      } catch (e) { /* none yet */ }
      return new Response(logPage(host, logs, actions), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (p === '/api/diyp' || p === '/d') return diypQuery(env, url);
    return new Response('not found', { status: 404 });
}

export default {
  async fetch(req, env, ctx) {
    return handleRequest(req, env);
  },
};
