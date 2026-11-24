// 全球态势感知台 — standalone server (Node 24 stdlib only, no dependencies).
// Serves the dashboard at http://localhost:8080 and fetches live data
// server-side from EONET / USGS / CelesTrak / NASA FIRMS.
// FIRMS MAP_KEY comes ONLY from env var FIRMS_MAP_KEY, never from files,
// never sent to the browser.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const CACHE_FILE = path.join(DATA_DIR, 'cache.json');
const UA = 'Muse-Situation-Dashboard/1.0';

const EONET_URL = 'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=200&days=90';
const USGS_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson';
const FIRMS_SENSORS = ['VIIRS_NOAA21_NRT', 'VIIRS_NOAA20_NRT', 'VIIRS_SNPP_NRT', 'MODIS_NRT'];

const SATS = [
  { noradId: 25544, nameZh: '国际空间站' },
  { noradId: 48274, nameZh: '中国空间站' },
  { noradId: 20580, nameZh: '哈勃空间望远镜' },
  { noradId: 33591, nameZh: 'NOAA 19' },
  { noradId: 25994, nameZh: 'Terra' },
  { noradId: 27424, nameZh: 'Aqua' },
  { noradId: 37849, nameZh: 'Suomi NPP' },
  { noradId: 40697, nameZh: '哨兵-2A' },
];

// EONET category id -> dashboard kind
const EONET_KIND = {
  wildfires: 'wildfire',
  severeStorms: 'storm',
  volcanoes: 'volcano',
  seaLakeIce: 'ice',
  earthquakes: 'earthquake',
};

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// ---------------------------------------------------------------- fetch util

async function fetchWithTimeout(url, { timeoutMs = 20000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, ...headers },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function errText(e) {
  return e && e.message ? String(e.message) : String(e);
}

// ---------------------------------------------------------------- EONET

function lastLocatable(geometry) {
  if (!Array.isArray(geometry)) return null;
  for (let i = geometry.length - 1; i >= 0; i--) {
    const g = geometry[i];
    if (!g || !g.coordinates) continue;
    if (g.type === 'Point') {
      const [lon, lat] = g.coordinates;
      if (Number.isFinite(lon) && Number.isFinite(lat)) return { lon, lat, date: g.date };
    } else if (g.type === 'Polygon') {
      const ring = g.coordinates && g.coordinates[0];
      if (Array.isArray(ring) && ring.length > 0) {
        let sx = 0, sy = 0, n = 0;
        for (const [lon, lat] of ring) {
          if (Number.isFinite(lon) && Number.isFinite(lat)) { sx += lon; sy += lat; n++; }
        }
        if (n > 0) return { lon: sx / n, lat: sy / n, date: g.date };
      }
    }
  }
  return null;
}

async function fetchEonet() {
  const res = await fetchWithTimeout(EONET_URL, { timeoutMs: 25000 });
  const data = await res.json();
  const events = [];
  for (const ev of data.events || []) {
    const loc = lastLocatable(ev.geometry);
    if (!loc) continue;
    const catId = (ev.categories && ev.categories[0] && ev.categories[0].id) || '';
    const kind = EONET_KIND[catId] || 'other';
    const lastGeom = ev.geometry[ev.geometry.length - 1];
    events.push({
      id: 'eonet-' + ev.id,
      kind,
      title: ev.title || '',
      lat: loc.lat,
      lon: loc.lon,
      time: (lastGeom && lastGeom.date) || (loc.date || null),
      magnitude: null,
      magnitudeUnit: null,
      detail: ev.description || ((ev.categories || []).map((c) => c.title).filter(Boolean).join('、')),
      source: 'EONET',
      sourceUrl: 'https://eonet.gsfc.nasa.gov/api/v3/events/' + ev.id,
    });
  }
  // newest first
  events.sort((a, b) => (Date.parse(b.time || 0) || 0) - (Date.parse(a.time || 0) || 0));
  return events;
}

// ---------------------------------------------------------------- USGS

async function fetchUsgs() {
  const res = await fetchWithTimeout(USGS_URL, { timeoutMs: 25000 });
  const data = await res.json();
  const feats = (data.features || []).slice();
  feats.sort((a, b) => (b.properties.time || 0) - (a.properties.time || 0));
  const events = feats.slice(0, 220).map((f) => {
    const p = f.properties || {};
    const c = (f.geometry && f.geometry.coordinates) || [];
    const depth = c[2];
    let detail = '';
    if (p.place) detail += p.place;
    detail += (detail ? '；' : '') + '深度 ' + (depth != null ? Number(depth).toFixed(1) : '未知') + ' km';
    if (p.tsunami === 1) detail += '；可能引发海啸';
    return {
      id: 'usgs-' + f.id,
      kind: 'earthquake',
      title: p.title || ('M' + p.mag + ' 地震'),
      lat: c[1],
      lon: c[0],
      time: p.time ? new Date(p.time).toISOString() : null,
      magnitude: p.mag != null ? Number(p.mag) : null,
      magnitudeUnit: 'M',
      detail,
      source: 'USGS',
      sourceUrl: p.url || '',
    };
  });
  return events;
}

// ---------------------------------------------------------------- TLE sources
// Primary: CelesTrak GP JSON (per spec). CelesTrak is unreachable from some
// networks — this dev VM's egress proxy gets empty replies from celestrak.org
// (verified with curl and node fetch; EONET/USGS work fine through the same
// proxy), so per-satellite fallbacks keep the dashboard live. All sources
// carry the same public US Space Force catalogue data; each satellite records
// its tleSource for provenance (shown in the detail card).
// Fallback order: CelesTrak -> SatNOGS DB API -> orbitalradar.com page ->
// retlector.eu TLE list / AMSAT nasa.all (bulk, fetched once per refresh).

function parseTleLines(line1, line2) {
  // TLE fixed columns (0-indexed substrings).
  const epochStr = line1.substring(18, 32).trim();
  const m = epochStr.match(/^(\d{2})(\d{3})\.(\d+)$/);
  if (!m) throw new Error('bad TLE epoch: ' + epochStr);
  const yy = parseInt(m[1], 10);
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  const day = parseInt(m[2], 10);
  const frac = parseFloat('0.' + m[3]);
  const epochMs = Date.UTC(year, 0, 1) + (day - 1 + frac) * 86400000;
  return {
    epoch: new Date(epochMs).toISOString(),
    meanMotion: parseFloat(line2.substring(52, 63)),
    eccentricity: parseFloat('0.' + line2.substring(26, 33).trim()),
    inclination: parseFloat(line2.substring(8, 16)),
    raan: parseFloat(line2.substring(17, 25)),
    argPerigee: parseFloat(line2.substring(34, 42)),
    meanAnomaly: parseFloat(line2.substring(43, 51)),
  };
}

function tleToSat(sat, name, els, tleSource) {
  return {
    noradId: sat.noradId,
    name: name || ('NORAD ' + sat.noradId),
    nameZh: sat.nameZh,
    epoch: els.epoch,
    meanMotion: els.meanMotion,
    eccentricity: els.eccentricity,
    inclination: els.inclination,
    raan: els.raan,
    argPerigee: els.argPerigee,
    meanAnomaly: els.meanAnomaly,
    tleSource,
  };
}

async function fetchTleCelestrak(sat) {
  const url = `https://celestrak.org/NORAD/elements/gp.php?CATNR=${sat.noradId}&FORMAT=JSON`;
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchWithTimeout(url, { timeoutMs: 12000 });
      const arr = await res.json();
      const row = Array.isArray(arr) ? arr[0] : null;
      if (!row || row.OBJECT_NAME == null || row.EPOCH == null) {
        throw new Error('empty TLE response');
      }
      return tleToSat(sat, row.OBJECT_NAME, {
        epoch: row.EPOCH,
        meanMotion: Number(row.MEAN_MOTION),
        eccentricity: Number(row.ECCENTRICITY),
        inclination: Number(row.INCLINATION),
        raan: Number(row.RA_OF_ASC_NODE),
        argPerigee: Number(row.ARG_OF_PERICENTER),
        meanAnomaly: Number(row.MEAN_ANOMALY),
      }, 'CelesTrak');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function fetchTleSatnogs(sat) {
  const url = `https://db.satnogs.org/api/tle/?format=json&norad_cat_id=${sat.noradId}`;
  const res = await fetchWithTimeout(url, { timeoutMs: 15000 });
  const arr = await res.json();
  const row = Array.isArray(arr) ? arr[0] : null;
  if (!row || !row.tle1 || !row.tle2) throw new Error('SatNOGS: no TLE for ' + sat.noradId);
  const name = String(row.tle0 || '').replace(/^0\s+/, '').trim();
  return tleToSat(sat, name, parseTleLines(row.tle1, row.tle2), 'SatNOGS');
}

async function fetchTleOrbitalRadar(sat) {
  const url = `https://orbitalradar.com/satellite/${sat.noradId}`;
  const res = await fetchWithTimeout(url, { timeoutMs: 15000 });
  const html = await res.text();
  const m1 = html.match(/"t1"\s*:\s*"([^"]+)"/);
  const m2 = html.match(/"t2"\s*:\s*"([^"]+)"/);
  if (!m1 || !m2) throw new Error('OrbitalRadar: no TLE on page for ' + sat.noradId);
  return tleToSat(sat, null, parseTleLines(m1[1], m2[1]), 'OrbitalRadar');
}

let bulkTleCache = null; // Map noradId -> {line1, line2, name, source}
async function fetchBulkTles() {
  if (bulkTleCache) return bulkTleCache;
  const map = new Map();
  const lists = [
    { url: 'https://www.retlector.eu/science/tle', source: 'retlector.eu', html: true },
    { url: 'https://www.amsat.org/tle/current/nasa.all', source: 'AMSAT', html: false },
  ];
  const results = await Promise.allSettled(
    lists.map((l) => fetchWithTimeout(l.url, { timeoutMs: 20000 }).then((r) => r.text()).then((t) => ({ t, l })))
  );
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    let text = r.value.t;
    if (r.value.l.html) text = text.replace(/<[^>]+>/g, '\n');
    const lines = text.split(/\r?\n/);
    let i = 0;
    while (i + 2 < lines.length) {
      const name = (lines[i] || '').trim();
      const l1 = (lines[i + 1] || '').trim();
      const l2 = (lines[i + 2] || '').trim();
      if (l1.startsWith('1 ') && l2.startsWith('2 ')) {
        const id = parseInt(l1.substring(2, 7), 10);
        if (Number.isFinite(id) && !map.has(id)) {
          map.set(id, { line1: l1, line2: l2, name, source: r.value.l.source });
        }
        i += 3;
      } else {
        i += 1;
      }
    }
  }
  bulkTleCache = map;
  return map;
}

async function fetchTleOne(sat) {
  const attempts = [
    () => fetchTleCelestrak(sat),
    () => fetchTleSatnogs(sat),
    () => fetchTleOrbitalRadar(sat),
    async () => {
      const bulk = await fetchBulkTles();
      const hit = bulk.get(sat.noradId);
      if (!hit) throw new Error('not in bulk TLE lists');
      return tleToSat(sat, hit.name, parseTleLines(hit.line1, hit.line2), hit.source);
    },
  ];
  let lastErr = null;
  for (const fn of attempts) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function fetchCelestrak(prevSnap) {
  bulkTleCache = null; // fresh bulk lists each refresh
  const results = await Promise.allSettled(SATS.map((s) => fetchTleOne(s)));
  const prevSats = new Map();
  if (prevSnap && Array.isArray(prevSnap.satellites)) {
    for (const s of prevSnap.satellites) prevSats.set(s.noradId, s);
  }
  const sats = [];
  const failed = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      sats.push(r.value);
    } else {
      const prev = prevSats.get(SATS[i].noradId);
      if (prev) {
        sats.push(prev); // keep original epoch
        failed.push(SATS[i].nameZh + '（用上次缓存的 TLE）');
      } else {
        failed.push(SATS[i].nameZh + '（无缓存）');
      }
    }
  });
  if (sats.length === 0) {
    throw new Error('8 颗卫星的 TLE 全部获取失败' + (failed.length ? '：' + failed.join('；') : ''));
  }
  // keep the fixed order
  sats.sort((a, b) => SATS.findIndex((s) => s.noradId === a.noradId) - SATS.findIndex((s) => s.noradId === b.noradId));
  if (failed.length > 0) {
    const err = new Error('部分卫星使用缓存 TLE：' + failed.join('；'));
    err.partial = true;
    err.sats = sats;
    throw err;
  }
  return sats;
}

// ---------------------------------------------------------------- FIRMS

function parseFirmsCsv(text, sensor) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const idx = (name) => header.indexOf(name);
  const iLat = idx('latitude'), iLon = idx('longitude'), iDate = idx('acq_date'),
    iTime = idx('acq_time'), iConf = idx('confidence'), iFrp = idx('frp');
  if (iLat < 0 || iLon < 0 || iDate < 0 || iTime < 0) return [];
  const isModis = sensor === 'MODIS_NRT';
  const now = Date.now();
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const lat = parseFloat(cols[iLat]);
    const lon = parseFloat(cols[iLon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const dateStr = (cols[iDate] || '').trim();
    const timeStr = (cols[iTime] || '').trim().padStart(4, '0');
    const t = Date.parse(dateStr + 'T' + timeStr.slice(0, 2) + ':' + timeStr.slice(2, 4) + ':00Z');
    if (!Number.isFinite(t)) continue;
    if (now - t > 24 * 3600 * 1000) continue; // rolling last 24h
    if (iConf >= 0) {
      const conf = (cols[iConf] || '').trim().toLowerCase();
      if (isModis) {
        const c = Number(conf);
        if (!Number.isFinite(c) || c < 30) continue;
      } else {
        if (conf !== 'n' && conf !== 'h') continue;
      }
    }
    const frp = iFrp >= 0 ? parseFloat(cols[iFrp]) : NaN;
    out.push({ lat, lon, frp: Number.isFinite(frp) ? frp : 0 });
  }
  return out;
}

function aggregateFires(points) {
  const cells = new Map();
  for (const p of points) {
    const kLat = Math.floor(p.lat / 0.25);
    const kLon = Math.floor(p.lon / 0.25);
    const key = kLat + ',' + kLon;
    let cell = cells.get(key);
    if (!cell) {
      cell = { sumLat: 0, sumLon: 0, count: 0, frp: 0 };
      cells.set(key, cell);
    }
    cell.sumLat += p.lat;
    cell.sumLon += p.lon;
    cell.count += 1;
    if (p.frp > cell.frp) cell.frp = p.frp;
  }
  const fires = [];
  for (const cell of cells.values()) {
    fires.push({
      lat: Math.round((cell.sumLat / cell.count) * 100) / 100,
      lon: Math.round((cell.sumLon / cell.count) * 100) / 100,
      count: cell.count,
      frp: Math.round(cell.frp * 10) / 10,
    });
  }
  fires.sort((a, b) => b.count - a.count);
  return fires.slice(0, 9000);
}

async function fetchFirms() {
  const key = process.env.FIRMS_MAP_KEY;
  if (!key) throw new Error('FIRMS_MAP_KEY 未设置，跳过火点数据');
  let lastErr = null;
  for (const sensor of FIRMS_SENSORS) {
    const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/${sensor}/world/2`;
    try {
      const res = await fetchWithTimeout(url, { timeoutMs: 45000 });
      const text = await res.text();
      const rows = parseFirmsCsv(text, sensor);
      if (rows.length === 0) {
        lastErr = new Error(sensor + ' 返回 0 条有效火点');
        continue; // try next sensor
      }
      return { sensor, rows, fires: aggregateFires(rows), detections: rows.length };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('FIRMS 无可用数据');
}

// ---------------------------------------------------------------- cache

function loadCache() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.snapshots)) return parsed;
  } catch (e) {
    // missing or corrupt: no data
  }
  return { snapshots: [] };
}

function saveCache(cache) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = CACHE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache));
  fs.renameSync(tmp, CACHE_FILE);
}

// ---------------------------------------------------------------- refresh

let refreshPromise = null;

async function doRefresh() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const cache = loadCache();
    const prevSnap = cache.snapshots[0] || null;

    const [eonetR, usgsR, celestrakR, firmsR] = await Promise.allSettled([
      fetchEonet(),
      fetchUsgs(),
      fetchCelestrak(prevSnap),
      fetchFirms(),
    ]);

    const sources = {
      eonet: { ok: false, count: 0, error: null },
      usgs: { ok: false, count: 0, error: null },
      celestrak: { ok: false, count: 0, error: null },
      firms: { ok: false, count: 0, error: null },
    };

    const allFailed =
      eonetR.status === 'rejected' && usgsR.status === 'rejected' &&
      celestrakR.status === 'rejected' && firmsR.status === 'rejected';
    if (allFailed) {
      const errs = [eonetR, usgsR, celestrakR, firmsR].map((r) => errText(r.reason)).join('；');
      return { ok: false, fetchedAt: null, error: '四个数据源全部失败，未写入缓存：' + errs };
    }

    // Events: EONET + USGS; a failed source leaves its category empty (never fabricate).
    let events = [];
    if (eonetR.status === 'fulfilled') {
      events = events.concat(eonetR.value);
      sources.eonet = { ok: true, count: eonetR.value.length, error: null };
    } else {
      sources.eonet = { ok: false, count: 0, error: errText(eonetR.reason) };
    }
    if (usgsR.status === 'fulfilled') {
      events = events.concat(usgsR.value);
      sources.usgs = { ok: true, count: usgsR.value.length, error: null };
    } else {
      sources.usgs = { ok: false, count: 0, error: errText(usgsR.reason) };
    }
    events.sort((a, b) => (Date.parse(b.time || 0) || 0) - (Date.parse(a.time || 0) || 0));

    // Satellites: fresh TLEs, or partial ones carried by the thrown error, or previous snapshot.
    let satellites = [];
    if (celestrakR.status === 'fulfilled') {
      satellites = celestrakR.value;
      sources.celestrak = { ok: true, count: satellites.length, error: null };
    } else {
      const reason = celestrakR.reason;
      if (reason && reason.partial && Array.isArray(reason.sats) && reason.sats.length > 0) {
        satellites = reason.sats;
        sources.celestrak = { ok: false, count: satellites.length, error: errText(reason) };
      } else if (prevSnap && Array.isArray(prevSnap.satellites) && prevSnap.satellites.length > 0) {
        satellites = prevSnap.satellites;
        sources.celestrak = { ok: false, count: satellites.length, error: errText(reason) + '（使用上次缓存的 TLE）' };
      } else {
        sources.celestrak = { ok: false, count: 0, error: errText(reason) };
      }
    }

    // FIRMS: fresh fires, or previous snapshot's fires on failure.
    let fires = [];
    let fireDetections = 0;
    let firmsSensor = null;
    if (firmsR.status === 'fulfilled') {
      fires = firmsR.value.fires;
      fireDetections = firmsR.value.detections;
      firmsSensor = firmsR.value.sensor;
      sources.firms = { ok: true, count: fireDetections, error: null };
    } else if (prevSnap && Array.isArray(prevSnap.fires)) {
      fires = prevSnap.fires;
      fireDetections = prevSnap.stats ? prevSnap.stats.fireDetections : 0;
      firmsSensor = prevSnap.firmsSensor || null;
      sources.firms = { ok: false, count: fireDetections, error: errText(firmsR.reason) + '（使用上次缓存的火点）' };
    } else {
      sources.firms = { ok: false, count: 0, error: errText(firmsR.reason) };
    }

    // Stats
    const now = Date.now();
    const eonetEvents = eonetR.status === 'fulfilled' ? eonetR.value : [];
    const usgsEvents = usgsR.status === 'fulfilled' ? usgsR.value : [];
    const countKind = (k) => eonetEvents.filter((e) => e.kind === k).length;
    let quakesDay = 0, quakesM6Week = 0, maxQuakeMag = 0;
    for (const q of usgsEvents) {
      const t = Date.parse(q.time || 0) || 0;
      if (now - t <= 24 * 3600 * 1000) quakesDay++;
      if (q.magnitude != null) {
        if (q.magnitude >= 6) quakesM6Week++;
        if (q.magnitude > maxQuakeMag) maxQuakeMag = q.magnitude;
      }
    }
    const stats = {
      wildfires: countKind('wildfire'),
      storms: countKind('storm'),
      volcanoes: countKind('volcano'),
      ice: countKind('ice'),
      quakesDay,
      quakesWeek: usgsEvents.length,
      quakesM6Week,
      maxQuakeMag: Math.round(maxQuakeMag * 10) / 10,
      fireDetections,
    };

    const fetchedAt = new Date().toISOString();
    const snapshot = {
      fetchedAt,
      events,
      satellites,
      fires,
      firmsSensor,
      sources,
      stats,
    };

    const allOk = sources.eonet.ok && sources.usgs.ok && sources.celestrak.ok && sources.firms.ok;
    const errors = ['eonet', 'usgs', 'celestrak', 'firms']
      .filter((k) => sources[k].error)
      .map((k) => k + ': ' + sources[k].error);
    const error = allOk ? null : errors.join('；');

    cache.snapshots = [snapshot, ...(prevSnap ? [prevSnap] : [])].slice(0, 2);
    saveCache(cache);
    log('refresh done ok=' + allOk + ' events=' + events.length +
      ' sats=' + satellites.length + ' fires=' + fires.length +
      ' detections=' + fireDetections + (error ? ' errors: ' + error : ''));
    return { ok: allOk, fetchedAt, error };
  })();
  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

// ---------------------------------------------------------------- HTTP server

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/dashboard' && req.method === 'GET') {
      const cache = loadCache();
      const snap = cache.snapshots[0];
      if (!snap) {
        sendJson(res, 200, { hasData: false, stale: true, payload: null });
        return;
      }
      const stale = Date.now() - Date.parse(snap.fetchedAt) > 15 * 60 * 1000;
      sendJson(res, 200, { hasData: true, stale, payload: snap });
      return;
    }
    if (url.pathname === '/api/refresh' && req.method === 'POST') {
      const result = await doRefresh();
      sendJson(res, 200, result);
      return;
    }
    if (req.method === 'GET') {
      serveStatic(req, res);
      return;
    }
    res.writeHead(405); res.end('method not allowed');
  } catch (e) {
    log('request error:', errText(e));
    sendJson(res, 500, { ok: false, error: errText(e) });
  }
});

// ---------------------------------------------------------------- CLI

if (process.argv.includes('--refresh-once')) {
  doRefresh().then((r) => {
    const cache = loadCache();
    const snap = cache.snapshots[0];
    console.log(JSON.stringify({
      ok: r.ok,
      fetchedAt: r.fetchedAt,
      error: r.error,
      counts: snap ? {
        events: snap.events.length,
        satellites: snap.satellites.length,
        fires: snap.fires.length,
        stats: snap.stats,
        sources: snap.sources,
      } : null,
    }, null, 2));
    process.exit(r.fetchedAt ? 0 : 1);
  }).catch((e) => {
    console.error('refresh failed:', errText(e));
    process.exit(1);
  });
} else {
  server.listen(PORT, '0.0.0.0', () => {
    log(`listening on http://localhost:${PORT}`);
    const cache = loadCache();
    if (cache.snapshots.length === 0) {
      log('no cache yet; first load will trigger a refresh');
    } else {
      log('cache loaded, latest snapshot:', cache.snapshots[0].fetchedAt);
    }
    // Self-refresh every 3h so the dashboard stays fresh even with no
    // visitors (the Altare App is always on), plus one refresh on startup
    // when there is no cache or it is already stale.
    const THREE_HOURS = 3 * 60 * 60 * 1000;
    setInterval(() => {
      doRefresh().catch((e) => log('scheduled refresh failed:', errText(e)));
    }, THREE_HOURS);
    const snap = cache.snapshots[0];
    if (!snap || Date.now() - Date.parse(snap.fetchedAt) > 15 * 60 * 1000) {
      doRefresh().catch((e) => log('startup refresh failed:', errText(e)));
    }
  });
}
