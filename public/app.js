// 全球态势感知台 — frontend (no libraries, Canvas 2D hand-drawn map).
'use strict';

(function () {
  var MU = 398600.4418; // km^3/s^2
  var RE = 6371; // km
  var MIN_ZOOM = 0.9, MAX_ZOOM = 60;

  var KIND_META = {
    wildfire: { label: '野火', color: '#f97316' },
    storm: { label: '风暴', color: '#38bdf8' },
    volcano: { label: '火山', color: '#ef4444' },
    ice: { label: '冰情', color: '#a5f3fc' },
    earthquake: { label: '地震', color: '#facc15' },
    other: { label: '其他', color: '#94a3b8' },
  };
  var KIND_ORDER = ['wildfire', 'storm', 'volcano', 'ice', 'earthquake', 'other'];
  // Medium countries whose labels are always shown (centroid may mislead).
  var ANCHOR_NAMES = ['Japan', 'South Korea', 'North Korea', 'United Kingdom', 'Ireland',
    'Netherlands', 'Belgium', 'Switzerland', 'Denmark', 'Portugal', 'Greece', 'Cuba',
    'Sri Lanka', 'Taiwan', 'New Zealand', 'Iceland', 'Austria', 'Czech Republic',
    'Hungary', 'Slovakia', 'Slovenia', 'Croatia', 'Bosnia and Herzegovina',
    'Republic of Serbia', 'France', 'United States of America', 'Indonesia', 'Philippines'];

  var state = {
    view: 'flat',
    zoom: 1,
    flat: { lon: 0, lat: 20 },
    globe: { lon: 105, lat: 25 },
    layers: { wildfire: true, storm: true, volcano: true, ice: true, earthquake: true, other: true,
      fires: true, satellites: true, borders: true, labels: true },
    evFilter: 'all',
    payload: null,
    stale: false,
    satPos: {},
    lastInteraction: 0,
    fly: null,
    dragging: false,
    lastBgTrigger: null,
    selected: null,
    needsDraw: true,
    lastDraw: 0,
  };

  var $ = function (id) { return document.getElementById(id); };
  var canvas = $('map'), ctx = canvas.getContext('2d');
  var mapWrap = $('mapWrap');
  var W = 0, H = 0, DPR = 1;
  var screenMarkers = []; // {x, y, type, data} for hit testing

  function rad(d) { return d * Math.PI / 180; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function fmtTime(iso) {
    if (!iso) return '—';
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
      }).format(new Date(iso));
    } catch (e) { return iso; }
  }
  function fmtFull(iso) {
    if (!iso) return '—';
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }).format(new Date(iso));
    } catch (e) { return iso; }
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ------------------------------------------------------------ error surface
  function showReloadBox() { $('reloadBox').classList.add('show'); }
  window.addEventListener('error', function () { showReloadBox(); });
  $('reloadBtn').addEventListener('click', function () { location.reload(); });

  // ------------------------------------------------------------ TLE propagation
  function parseEpochMs(epoch) {
    if (epoch == null) return Date.now();
    if (typeof epoch === 'number') return epoch;
    var s = String(epoch).trim();
    var t = Date.parse(s);
    if (Number.isFinite(t)) return t;
    // TLE epoch format: YYDDD.DDDDDDDD
    var m = s.match(/^(\d{2})(\d{3})\.(\d+)$/);
    if (m) {
      var yy = parseInt(m[1], 10);
      var year = yy < 57 ? 2000 + yy : 1900 + yy;
      var day = parseInt(m[2], 10);
      var frac = parseFloat('0.' + m[3]);
      return Date.UTC(year, 0, 1) + (day - 1 + frac) * 86400000;
    }
    return Date.now();
  }
  function gmstRad(date) {
    var D = date.getTime() / 86400000 - 10957.5; // days since J2000.0
    var g = (280.46061837 + 360.98564736629 * D) % 360;
    if (g < 0) g += 360;
    return rad(g);
  }
  function propagate(sat, date) {
    var n = sat.meanMotion * 2 * Math.PI / 86400; // rad/s
    var a = Math.cbrt(MU / (n * n)); // km
    var e = sat.eccentricity;
    var dt = (date.getTime() - parseEpochMs(sat.epoch)) / 1000;
    var M = (rad(sat.meanAnomaly) + n * dt) % (2 * Math.PI);
    if (M < 0) M += 2 * Math.PI;
    var E = M;
    for (var k = 0; k < 12; k++) {
      E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    }
    var cosE = Math.cos(E), sinE = Math.sin(E);
    var sq = Math.sqrt(Math.max(0, 1 - e * e));
    var sinV = (sq * sinE) / (1 - e * cosE);
    var cosV = (cosE - e) / (1 - e * cosE);
    var nu = Math.atan2(sinV, cosV);
    var r = a * (1 - e * cosE);
    var xp = r * Math.cos(nu), yp = r * Math.sin(nu);
    var w = rad(sat.argPerigee), inc = rad(sat.inclination), Om = rad(sat.raan);
    var cw = Math.cos(w), sw = Math.sin(w), ci = Math.cos(inc), si = Math.sin(inc);
    var cO = Math.cos(Om), sO = Math.sin(Om);
    var x = (cO * cw - sO * sw * ci) * xp + (-cO * sw - sO * cw * ci) * yp;
    var y = (sO * cw + cO * sw * ci) * xp + (-sO * sw + cO * cw * ci) * yp;
    var z = (sw * si) * xp + (cw * si) * yp;
    var g = gmstRad(date);
    var cg = Math.cos(g), sg = Math.sin(g);
    var xe = cg * x + sg * y;
    var ye = -sg * x + cg * y;
    var ze = z;
    var lon = Math.atan2(ye, xe) * 180 / Math.PI;
    var lat = Math.atan2(ze, Math.sqrt(xe * xe + ye * ye)) * 180 / Math.PI;
    var alt = Math.sqrt(xe * xe + ye * ye + ze * ze) - RE;
    var speed = Math.sqrt(MU * (2 / r - 1 / a)); // vis-viva
    return { lat: lat, lon: lon, alt: alt, speed: speed };
  }

  // ------------------------------------------------------------ projection
  function globeR() { return Math.min(W, H) * 0.46 * state.zoom; }
  function flatScale() { return (W / 360) * state.zoom; }

  function project(lon, lat) {
    if (state.view === 'flat') {
      var scale = flatScale();
      var dLon = ((lon - state.flat.lon + 540) % 360) - 180;
      var x = W / 2 + dLon * scale;
      var y = H / 2 - (lat - state.flat.lat) * scale;
      return { x: x, y: y, visible: x >= -60 && x <= W + 60 && y >= -60 && y <= H + 60, edge: 1 };
    }
    var R = globeR();
    var lo = rad(lon - state.globe.lon), la = rad(lat), la0 = rad(state.globe.lat);
    var cosC = Math.sin(la0) * Math.sin(la) + Math.cos(la0) * Math.cos(la) * Math.cos(lo);
    // Tolerance -1e-3 rad (~0.06°): a point that far behind the limb is still
    // sub-pixel from the disc edge, so treat it as on the limb. Without this,
    // an interpolated limb crossing can land a hair behind and project()
    // would return (0,0), drawing a stray line to the canvas corner.
    if (cosC < -1e-3) return { x: 0, y: 0, visible: false, edge: 0 };
    var x2 = W / 2 + R * Math.cos(la) * Math.sin(lo);
    var y2 = H / 2 - R * (Math.cos(la0) * Math.sin(la) - Math.sin(la0) * Math.cos(la) * Math.cos(lo));
    return { x: x2, y: y2, visible: true, edge: cosC };
  }
  // cosC without projection (for limb interpolation)
  function cosCOf(lon, lat) {
    var lo = rad(lon - state.globe.lon), la = rad(lat), la0 = rad(state.globe.lat);
    return Math.sin(la0) * Math.sin(la) + Math.cos(la0) * Math.cos(la) * Math.cos(lo);
  }

  function gratStep() {
    var z = state.zoom;
    if (z > 24) return 1;
    if (z > 10) return 2;
    if (z > 4) return 5;
    if (z > 1.8) return 10;
    return 20;
  }

  // ------------------------------------------------------------ drawing
  function drawGraticule() {
    var step = gratStep();
    ctx.strokeStyle = 'rgba(148,163,184,0.22)';
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    if (state.view === 'flat') {
      var scale = flatScale();
      var lonMin = state.flat.lon - (W / 2) / scale, lonMax = state.flat.lon + (W / 2) / scale;
      var latMin = state.flat.lat - (H / 2) / scale, latMax = state.flat.lat + (H / 2) / scale;
      for (var lon = Math.ceil(lonMin / step) * step; lon <= lonMax; lon += step) {
        var x0 = W / 2 + (((lon - state.flat.lon + 540) % 360) - 180) * scale;
        ctx.moveTo(x0, 0); ctx.lineTo(x0, H);
      }
      for (var lat = Math.ceil(latMin / step) * step; lat <= latMax; lat += step) {
        var y0 = H / 2 - (lat - state.flat.lat) * scale;
        if (lat < -90 || lat > 90) continue;
        ctx.moveTo(0, y0); ctx.lineTo(W, y0);
      }
    } else {
      var R = globeR();
      var lon, lat, p, prev;
      for (lon = -180; lon < 180; lon += step) {
        prev = null;
        for (lat = -90; lat <= 90; lat += 2) {
          p = project(lon, lat);
          if (!p.visible) { prev = null; continue; }
          if (prev) { ctx.moveTo(prev.x, prev.y); ctx.lineTo(p.x, p.y); }
          prev = p;
        }
      }
      for (lat = -90 + step; lat < 90; lat += step) {
        prev = null;
        for (lon = -180; lon <= 180; lon += 2) {
          p = project(lon, lat);
          if (!p.visible) { prev = null; continue; }
          if (prev) { ctx.moveTo(prev.x, prev.y); ctx.lineTo(p.x, p.y); }
          prev = p;
        }
      }
      void R;
    }
    ctx.stroke();
  }

  // Trace one ring into the current path. Flat: split on antimeridian jumps.
  // Globe: split at the limb (interpolated crossing point). Long segments are
  // subdivided so a segment whose endpoints are both visible but whose middle
  // passes behind the globe is still split at the limb. No closePath: the
  // ring data is already closed (last point = first point), fill closes
  // implicitly, and an explicit close would draw a chord across the disc.
  function traceRing(ring) {
    if (state.view === 'flat') {
      var prevLon = null, started = false;
      for (var i = 0; i < ring.length; i++) {
        var lon = ring[i][0], lat = ring[i][1];
        var p = project(lon, lat);
        if (prevLon !== null) {
          var dLon = ((lon - prevLon + 540) % 360) - 180;
          if (Math.abs(dLon) > 180) { ctx.moveTo(p.x, p.y); started = true; prevLon = lon; continue; }
        }
        if (!started) { ctx.moveTo(p.x, p.y); started = true; }
        else ctx.lineTo(p.x, p.y);
        prevLon = lon;
      }
      return;
    }
    // globe
    var prev = null; // {lon, lat, visible, c}
    // Point on the segment from a visible point to a behind point where the
    // segment crosses the limb (cosC == 0), found by bisection. A single
    // linear interpolation is not accurate enough: the crossing can land a
    // hair behind the limb, and project() would return (0,0) for it.
    function limbCross(fromLon, fromLat, toLon, toLat) {
      var t0 = 0, t1 = 1;
      for (var b = 0; b < 12; b++) {
        var tm = (t0 + t1) / 2;
        var cm = cosCOf(fromLon + (toLon - fromLon) * tm, fromLat + (toLat - fromLat) * tm);
        if (cm >= 0) t0 = tm; else t1 = tm;
      }
      var t = (t0 + t1) / 2;
      return project(fromLon + (toLon - fromLon) * t, fromLat + (toLat - fromLat) * t);
    }
    function stepPt(lon, lat) {
      var c = cosCOf(lon, lat);
      if (c >= 0) {
        var pp = project(lon, lat);
        if (prev && prev.visible) {
          ctx.lineTo(pp.x, pp.y);
        } else if (prev && !prev.visible) {
          var cross = limbCross(lon, lat, prev.lon, prev.lat);
          ctx.moveTo(cross.x, cross.y);
          ctx.lineTo(pp.x, pp.y);
        } else {
          ctx.moveTo(pp.x, pp.y);
        }
        prev = { lon: lon, lat: lat, visible: true, c: c };
      } else {
        if (prev && prev.visible) {
          var cross2 = limbCross(prev.lon, prev.lat, lon, lat);
          ctx.lineTo(cross2.x, cross2.y);
        }
        prev = { lon: lon, lat: lat, visible: false, c: c };
      }
    }
    for (var j = 0; j < ring.length; j++) {
      var lon2 = ring[j][0], lat2 = ring[j][1];
      if (prev) {
        // Segment start is fixed: stepPt() mutates prev, so capture it first.
        // Wrap the longitude delta so antimeridian crossings interpolate the
        // short way (through ±180°), not the long way through 0°.
        var startLon = prev.lon, startLat = prev.lat;
        var dLon2 = ((lon2 - startLon + 540) % 360) - 180;
        var dLat2 = lat2 - startLat;
        var dist = Math.sqrt(dLon2 * dLon2 + dLat2 * dLat2);
        var n = Math.min(180, Math.max(1, Math.ceil(dist / 2)));
        for (var s = 1; s <= n; s++) {
          stepPt(startLon + dLon2 * (s / n), startLat + dLat2 * (s / n));
        }
      } else {
        stepPt(lon2, lat2);
      }
    }
  }

  function drawCountries() {
    var landColor = state.zoom > 2.5 ? '#2c5480' : '#274b73';
    ctx.fillStyle = landColor;
    ctx.strokeStyle = 'rgba(191,219,254,0.9)';
    ctx.lineWidth = state.zoom > 2.5 ? 1 : 0.8;
    ctx.lineJoin = 'round';
    var countries = window.COUNTRIES || [];
    for (var i = 0; i < countries.length; i++) {
      var polys = countries[i][4];
      ctx.beginPath();
      for (var j = 0; j < polys.length; j++) {
        for (var k = 0; k < polys[j].length; k++) {
          traceRing(polys[j][k]);
        }
      }
      ctx.fill('evenodd');
      if (state.layers.borders) ctx.stroke();
    }
  }

  function drawLabels() {
    var countries = window.COUNTRIES || [];
    var zh = window.COUNTRY_ZH || {};
    // Only label countries big enough for the current zoom; anchor (medium)
    // countries get a lower bar so they appear when zoomed in a little.
    var threshold = 120 / (state.zoom * state.zoom);
    var anchorThreshold = 15 / (state.zoom * state.zoom);
    var candidates = [];
    for (var i = 0; i < countries.length; i++) {
      var c = countries[i];
      var name = c[0], area = c[3];
      var isAnchor = ANCHOR_NAMES.indexOf(name) >= 0;
      if (area < (isAnchor ? anchorThreshold : threshold)) continue;
      var p = project(c[1], c[2]);
      if (!p.visible) continue;
      if (state.view === 'globe' && p.edge < 0.2) continue;
      candidates.push({ name: name, area: area, p: p });
    }
    // Biggest first, so large labels win collisions.
    candidates.sort(function (a, b) { return b.area - a.area; });
    var placed = [];
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (var j = 0; j < candidates.length; j++) {
      var item = candidates[j];
      var p = item.p;
      var clash = false;
      for (var k = 0; k < placed.length; k++) {
        if (Math.abs(placed[k].x - p.x) < 34 && Math.abs(placed[k].y - p.y) < 14) { clash = true; break; }
      }
      if (clash) continue;
      placed.push(p);
      var size = Math.round(10 + Math.min(5, Math.log10(item.area + 1)));
      var label = zh[item.name] || item.name;
      var alpha = state.view === 'flat' ? 1 : clamp((p.edge - 0.15) / 0.85, 0, 1);
      if (alpha <= 0.05) continue;
      ctx.font = '600 ' + size + 'px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.globalAlpha = alpha;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(5,11,20,0.85)';
      ctx.strokeText(label, p.x, p.y);
      ctx.fillStyle = '#cfe3f7';
      ctx.fillText(label, p.x, p.y);
      ctx.globalAlpha = 1;
    }
  }

  function drawMarkers() {
    screenMarkers = [];
    var p = state.payload;
    if (!p) return;
    // fires
    if (state.layers.fires) {
      var fires = p.fires || [];
      for (var i = 0; i < fires.length; i++) {
        var f = fires[i];
        var pf = project(f.lon, f.lat);
        if (!pf.visible) continue;
        var hot = f.frp >= 30 || f.count >= 8;
        ctx.fillStyle = hot ? '#ef4444' : '#fb923c';
        var s = 3;
        ctx.fillRect(pf.x - s / 2, pf.y - s / 2, s, s);
      }
    }
    // events
    var events = p.events || [];
    for (var j = 0; j < events.length; j++) {
      var ev = events[j];
      if (!state.layers[ev.kind]) continue;
      var pe = project(ev.lon, ev.lat);
      if (!pe.visible) continue;
      var meta = KIND_META[ev.kind] || KIND_META.other;
      var r = ev.kind === 'earthquake' && ev.magnitude != null
        ? 3 + Math.max(0, ev.magnitude - 4.5) * 2 : 5;
      ctx.beginPath();
      ctx.arc(pe.x, pe.y, r, 0, Math.PI * 2);
      ctx.fillStyle = meta.color;
      ctx.fill();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.stroke();
      screenMarkers.push({ x: pe.x, y: pe.y, type: 'event', data: ev });
    }
    // satellites
    if (state.layers.satellites) {
      var sats = p.satellites || [];
      for (var k = 0; k < sats.length; k++) {
        var sat = sats[k];
        var pos = state.satPos[sat.noradId];
        if (!pos) continue;
        var ps = project(pos.lon, pos.lat);
        if (!ps.visible) continue;
        ctx.beginPath();
        ctx.moveTo(ps.x, ps.y - 7); ctx.lineTo(ps.x + 7, ps.y);
        ctx.lineTo(ps.x, ps.y + 7); ctx.lineTo(ps.x - 7, ps.y);
        ctx.closePath();
        ctx.fillStyle = '#22d3ee';
        ctx.fill();
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.stroke();
        ctx.font = '11px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(5,11,20,0.9)';
        ctx.strokeText(sat.nameZh, ps.x + 10, ps.y);
        ctx.fillStyle = '#a5f3fc';
        ctx.fillText(sat.nameZh, ps.x + 10, ps.y);
        screenMarkers.push({ x: ps.x, y: ps.y, type: 'satellite', data: sat });
      }
    }
  }

  function draw() {
    try {
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.clearRect(0, 0, W, H);
      if (state.view === 'flat') {
        var grad = ctx.createLinearGradient(0, 0, 0, H);
        grad.addColorStop(0, '#0e2a4e');
        grad.addColorStop(1, '#0a1f3d');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H);
      } else {
        ctx.fillStyle = '#050b14';
        ctx.fillRect(0, 0, W, H);
        var R = globeR();
        var rg = ctx.createRadialGradient(W / 2, H / 2, R * 0.1, W / 2, H / 2, R);
        rg.addColorStop(0, '#12325e');
        rg.addColorStop(0.7, '#0a1f3d');
        rg.addColorStop(1, '#060f1f');
        ctx.beginPath();
        ctx.arc(W / 2, H / 2, R, 0, Math.PI * 2);
        ctx.fillStyle = rg;
        ctx.fill();
      }
      drawGraticule();
      drawCountries();
      if (state.layers.labels) drawLabels();
      drawMarkers();
    } catch (e) {
      showReloadBox();
    }
  }

  // ------------------------------------------------------------ render loop
  function frame(now) {
    var t = now || performance.now();
    // fly-to animation
    if (state.fly) {
      var f = state.fly;
      var k = clamp((t - f.t0) / f.dur, 0, 1);
      var e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      var dLon = ((f.to.lon - f.from.lon + 540) % 360) - 180;
      var lon = f.from.lon + dLon * e;
      var lat = f.from.lat + (f.to.lat - f.from.lat) * e;
      var zoom = f.from.zoom + (f.to.zoom - f.from.zoom) * e;
      if (state.view === 'flat') {
        state.flat.lon = ((lon + 540) % 360) - 180;
        state.flat.lat = clamp(lat, -85, 85);
      } else {
        state.globe.lon = ((lon + 540) % 360) - 180;
        state.globe.lat = clamp(lat, -85, 85);
      }
      state.zoom = zoom;
      state.needsDraw = true;
      if (k >= 1) {
        state.fly = null;
        if (state.view === 'flat') state.flat.lat = clamp(state.flat.lat, -60, 60);
        else state.globe.lat = clamp(state.globe.lat, -60, 60);
      }
    }
    // auto-rotate (globe only, 4s idle, zoom <= 1.2)
    if (state.view === 'globe' && !state.dragging && !state.fly &&
        state.zoom <= 1.2 && t - state.lastInteraction > 4000) {
      state.globe.lon -= 0.04;
      if (state.globe.lon < -180) state.globe.lon += 360;
      state.needsDraw = true;
    }
    if (state.needsDraw && t - state.lastDraw >= 33) {
      state.lastDraw = t;
      state.needsDraw = false;
      draw();
      if (state.fly || (state.view === 'globe' && state.zoom <= 1.2 && t - state.lastInteraction > 4000)) {
        state.needsDraw = true;
      }
    }
    requestAnimationFrame(frame);
  }

  function resize() {
    var rect = mapWrap.getBoundingClientRect();
    DPR = Math.min(window.devicePixelRatio || 1, 1.5);
    W = Math.max(50, rect.width);
    H = Math.max(50, rect.height);
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    state.needsDraw = true;
  }

  // ------------------------------------------------------------ fly-to
  function flyTo(lon, lat, opts) {
    opts = opts || {};
    var targetZoom = state.zoom;
    if (state.view === 'flat') targetZoom = Math.max(state.zoom, 4);
    if (opts.zoom != null) targetZoom = opts.zoom;
    var from = state.view === 'flat'
      ? { lon: state.flat.lon, lat: state.flat.lat, zoom: state.zoom }
      : { lon: state.globe.lon, lat: state.globe.lat, zoom: state.zoom };
    state.fly = {
      t0: performance.now(), dur: 900, from: from,
      to: { lon: lon, lat: clamp(lat, -60, 60), zoom: clamp(targetZoom, MIN_ZOOM, MAX_ZOOM) },
    };
    state.lastInteraction = performance.now();
    state.needsDraw = true;
  }

  // ------------------------------------------------------------ detail card
  function showEventDetail(ev) {
    var meta = KIND_META[ev.kind] || KIND_META.other;
    $('detailTitle').textContent = ev.title || meta.label;
    $('detailMeta').innerHTML =
      '<span style="color:' + meta.color + '">● ' + esc(meta.label) + '</span> · ' + esc(ev.source || '') +
      (ev.magnitude != null ? ' · 震级 M' + ev.magnitude : '') +
      '<br>时间：' + esc(fmtFull(ev.time)) +
      '<br>位置：' + Number(ev.lat).toFixed(2) + '°, ' + Number(ev.lon).toFixed(2) + '°';
    $('detailBody').textContent = ev.detail || '';
    $('detailLink').innerHTML = ev.sourceUrl
      ? '<a href="' + esc(ev.sourceUrl) + '" target="_blank" rel="noopener">查看来源 ↗</a>' : '';
    $('detailCard').classList.add('show');
  }
  function showSatDetail(sat) {
    var pos = state.satPos[sat.noradId] || {};
    $('detailTitle').textContent = sat.nameZh + '（' + sat.name + '）';
    $('detailMeta').innerHTML =
      'NORAD ' + sat.noradId +
      '<br>纬度 ' + (pos.lat != null ? pos.lat.toFixed(2) + '°' : '—') +
      ' · 经度 ' + (pos.lon != null ? pos.lon.toFixed(2) + '°' : '—') +
      '<br>高度 ' + (pos.alt != null ? pos.alt.toFixed(0) + ' km' : '—') +
      ' · 速度 ' + (pos.speed != null ? pos.speed.toFixed(2) + ' km/s' : '—') +
      '<br>星历时刻：' + esc(sat.epoch || '—') +
      (sat.tleSource ? '<br>星历来源：' + esc(sat.tleSource) : '');
    $('detailBody').textContent = '位置由星历（TLE）按二体开普勒模型实时推算，非 SGP4 全精度、误差约数公里。';
    $('detailLink').innerHTML = '';
    $('detailCard').classList.add('show');
  }
  function hideDetail() { $('detailCard').classList.remove('show'); }
  $('detailClose').addEventListener('click', hideDetail);

  // ------------------------------------------------------------ lists & stats
  function riskScore(stats) {
    var s = (stats.quakesM6Week || 0) * 25 +
      Math.min(stats.storms || 0, 5) * 8 +
      (Math.min(stats.wildfires || 0, 120) / 120) * 30 +
      Math.max(0, (stats.maxQuakeMag || 0) - 4.5) * 8;
    return Math.min(100, Math.round(s));
  }
  function riskLevel(score) {
    if (score < 25) return '平稳';
    if (score < 50) return '关注';
    if (score < 75) return '紧张';
    return '高压';
  }

  function renderStats() {
    var p = state.payload;
    if (!p) return;
    var s = p.stats || {};
    $('statWildfires').textContent = s.wildfires != null ? s.wildfires : '—';
    $('statQuakesDay').textContent = s.quakesDay != null ? s.quakesDay : '—';
    $('statMaxMag').textContent = s.maxQuakeMag ? 'M' + s.maxQuakeMag : '—';
    var score = riskScore(s);
    $('statRisk').textContent = score;
    $('statRiskLevel').textContent = '· ' + riskLevel(score);
  }

  function renderSources() {
    var p = state.payload;
    if (!p) return;
    var names = { eonet: 'EONET', usgs: 'USGS 地震', celestrak: 'CelesTrak 星历', firms: 'FIRMS 火点' };
    var html = '';
    ['eonet', 'usgs', 'celestrak', 'firms'].forEach(function (k) {
      var src = (p.sources || {})[k] || { ok: false, count: 0, error: '无数据' };
      html += '<span><span class="sdot ' + (src.ok ? 'ok' : 'bad') + '"></span>' + names[k] +
        ' ' + (src.count || 0) + ' 条' +
        (src.error ? ' <span class="err">' + esc(src.error) + '</span>' : '') + '</span>';
    });
    if (p.firmsSensor) html += '<span>火点传感器：' + esc(p.firmsSensor) + '</span>';
    $('sourceBar').innerHTML = html;
  }

  function renderEventList() {
    var p = state.payload;
    var list = $('evList');
    if (!p) { list.innerHTML = '<li class="loading">加载中…</li>'; return; }
    var events = (p.events || []).filter(function (ev) {
      return state.evFilter === 'all' || ev.kind === state.evFilter;
    }).slice(0, 60);
    $('evCount').textContent = '共 ' + (p.events || []).length + ' 条，显示前 60 条';
    if (events.length === 0) {
      list.innerHTML = '<li class="loading">该分类暂无事件</li>';
      return;
    }
    var html = '';
    events.forEach(function (ev) {
      var meta = KIND_META[ev.kind] || KIND_META.other;
      html += '<li data-id="' + esc(ev.id) + '">' +
        '<span class="tag" style="background:' + meta.color + '">' + meta.label + '</span>' +
        '<span class="t">' + esc(ev.title || meta.label) + '</span>' +
        '<div class="m">' + esc(fmtTime(ev.time)) +
        (ev.magnitude != null ? ' · M' + ev.magnitude : '') +
        ' · ' + esc(ev.source || '') + '</div></li>';
    });
    list.innerHTML = html;
    var items = list.querySelectorAll('li[data-id]');
    items.forEach(function (li) {
      li.addEventListener('click', function () {
        var ev = (p.events || []).find(function (e) { return e.id === li.getAttribute('data-id'); });
        if (!ev) return;
        flyTo(ev.lon, ev.lat);
        showEventDetail(ev);
      });
    });
  }

  function renderSatList() {
    var p = state.payload;
    var list = $('satList');
    if (!p || !p.satellites) { list.innerHTML = '<li class="loading">加载中…</li>'; return; }
    var html = '';
    p.satellites.forEach(function (sat) {
      var pos = state.satPos[sat.noradId] || {};
      html += '<li data-norad="' + sat.noradId + '">' +
        '<b>' + esc(sat.nameZh) + '</b> <span style="color:var(--muted)">' + esc(sat.name) + '</span>' +
        '<div class="m">纬度 ' + (pos.lat != null ? pos.lat.toFixed(2) + '°' : '—') +
        ' · 经度 ' + (pos.lon != null ? pos.lon.toFixed(2) + '°' : '—') +
        '<br>高度 ' + (pos.alt != null ? pos.alt.toFixed(0) + ' km' : '—') +
        ' · 速度 ' + (pos.speed != null ? pos.speed.toFixed(2) + ' km/s' : '—') + '</div></li>';
    });
    list.innerHTML = html;
    var items = list.querySelectorAll('li[data-norad]');
    items.forEach(function (li) {
      li.addEventListener('click', function () {
        var sat = (p.satellites || []).find(function (s) { return String(s.noradId) === li.getAttribute('data-norad'); });
        if (!sat) return;
        var pos = state.satPos[sat.noradId];
        if (pos) flyTo(pos.lon, pos.lat);
        showSatDetail(sat);
      });
    });
  }

  function renderFilters() {
    var wrap = $('evFilters');
    var defs = [{ k: 'all', label: '全部' }].concat(KIND_ORDER.map(function (k) {
      return { k: k, label: KIND_META[k].label };
    }));
    wrap.innerHTML = '';
    defs.forEach(function (d) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = d.label;
      if (state.evFilter === d.k) b.classList.add('active');
      b.addEventListener('click', function () {
        state.evFilter = d.k;
        renderFilters();
        renderEventList();
      });
      wrap.appendChild(b);
    });
  }

  function renderLayerToggles() {
    var wrap = $('layerToggles');
    wrap.innerHTML = '';
    var defs = [
      { k: 'wildfire', label: '野火', color: KIND_META.wildfire.color },
      { k: 'storm', label: '风暴', color: KIND_META.storm.color },
      { k: 'volcano', label: '火山', color: KIND_META.volcano.color },
      { k: 'ice', label: '冰情', color: KIND_META.ice.color },
      { k: 'earthquake', label: '地震', color: KIND_META.earthquake.color },
      { k: 'other', label: '其他', color: KIND_META.other.color },
      { k: 'fires', label: 'FIRMS火点', color: '#fb923c' },
      { k: 'satellites', label: '卫星', color: '#22d3ee' },
      { k: 'borders', label: '国界', color: null },
      { k: 'labels', label: '国名', color: null },
    ];
    defs.forEach(function (d) {
      var chip = document.createElement('span');
      chip.className = 'chip' + (state.layers[d.k] ? '' : ' off');
      chip.innerHTML = (d.color ? '<span class="dot" style="background:' + d.color + '"></span>' : '') + esc(d.label);
      chip.addEventListener('click', function () {
        state.layers[d.k] = !state.layers[d.k];
        chip.classList.toggle('off', !state.layers[d.k]);
        state.needsDraw = true;
      });
      wrap.appendChild(chip);
    });
  }

  function renderAll() {
    renderStats();
    renderSources();
    renderFilters();
    renderEventList();
    renderSatList();
    if (state.payload) {
      $('updatedAt').textContent = '数据更新于 ' + fmtFull(state.payload.fetchedAt) + '（北京时间）';
    }
    state.needsDraw = true;
  }

  function updateStaleBanner() {
    $('staleBanner').classList.toggle('show', !!state.stale);
  }

  // ------------------------------------------------------------ satellite tick
  function tickSatellites() {
    var p = state.payload;
    if (!p || !p.satellites) return;
    var now = new Date();
    var changed = false;
    p.satellites.forEach(function (sat) {
      try {
        state.satPos[sat.noradId] = propagate(sat, now);
        changed = true;
      } catch (e) { /* keep last position */ }
    });
    if (changed) {
      state.needsDraw = true;
      // ISS bar
      var iss = p.satellites.find(function (s) { return s.noradId === 25544; });
      var pos = iss && state.satPos[25544];
      if (pos) {
        $('issPos').textContent = pos.lat.toFixed(2) + '°, ' + pos.lon.toFixed(2) + '°';
        $('issAlt').textContent = pos.alt.toFixed(0) + ' km';
        $('issSpeed').textContent = pos.speed.toFixed(2) + ' km/s';
        $('issEpoch').textContent = iss.epoch || '—';
      }
      renderSatList();
    }
  }

  // ------------------------------------------------------------ data loading
  async function loadDashboard() {
    try {
      var res = await fetch('/api/dashboard');
      var data = await res.json();
      if (!data.hasData) {
        await refreshNow();
        var res2 = await fetch('/api/dashboard');
        data = await res2.json();
        if (!data.hasData) {
          $('evList').innerHTML = '<li class="loading">暂无数据，服务端抓取失败，请稍后点“立即刷新”重试。</li>';
          return;
        }
      }
      state.payload = data.payload;
      state.stale = data.stale;
      renderAll();
      updateStaleBanner();
      tickSatellites();
    } catch (e) {
      $('evList').innerHTML = '<li class="loading">加载失败：' + esc(e.message || e) + '</li>';
    }
  }
  async function refreshNow() {
    var btn = $('refreshBtn');
    btn.disabled = true;
    btn.textContent = '刷新中…';
    try {
      await fetch('/api/refresh', { method: 'POST' });
    } catch (e) { /* server will report via dashboard */ }
    btn.disabled = false;
    btn.textContent = '立即刷新';
  }

  async function periodicCheck() {
    try {
      var res = await fetch('/api/dashboard');
      var data = await res.json();
      if (!data.hasData) return;
      var newFetchedAt = data.payload.fetchedAt;
      if (data.stale && newFetchedAt !== state.lastBgTrigger) {
        state.lastBgTrigger = newFetchedAt;
        await refreshNow();
        var res2 = await fetch('/api/dashboard');
        var data2 = await res2.json();
        if (data2.hasData) {
          state.payload = data2.payload;
          state.stale = data2.stale;
          renderAll();
          updateStaleBanner();
          tickSatellites();
        }
      } else {
        state.payload = data.payload;
        state.stale = data.stale;
        renderAll();
        updateStaleBanner();
      }
    } catch (e) { /* keep showing old data */ }
  }

  $('refreshBtn').addEventListener('click', async function () {
    await refreshNow();
    await loadDashboard();
  });

  // ------------------------------------------------------------ view toggle
  function setView(v) {
    if (state.view === v) return;
    state.view = v;
    state.fly = null;
    $('viewFlat').classList.toggle('active', v === 'flat');
    $('viewGlobe').classList.toggle('active', v === 'globe');
    mapWrap.classList.toggle('flat', v === 'flat');
    mapWrap.classList.toggle('globe', v === 'globe');
    state.lastInteraction = performance.now();
    resize();
  }
  $('viewFlat').addEventListener('click', function () { setView('flat'); });
  $('viewGlobe').addEventListener('click', function () { setView('globe'); });

  function setZoom(z, cx, cy) {
    var nz = clamp(z, MIN_ZOOM, MAX_ZOOM);
    if (state.view === 'flat' && cx != null && cy != null) {
      // keep the lon/lat under the cursor fixed
      var scale0 = flatScale();
      var lon0 = state.flat.lon + (cx - W / 2) / scale0;
      var lat0 = state.flat.lat - (cy - H / 2) / scale0;
      state.zoom = nz;
      var scale1 = flatScale();
      state.flat.lon = lon0 - (cx - W / 2) / scale1;
      state.flat.lat = lat0 + (cy - H / 2) / scale1;
      state.flat.lat = clamp(state.flat.lat, -85, 85);
    } else {
      state.zoom = nz;
    }
    state.lastInteraction = performance.now();
    state.needsDraw = true;
  }
  $('zoomIn').addEventListener('click', function () { setZoom(state.zoom * 1.6); });
  $('zoomOut').addEventListener('click', function () { setZoom(state.zoom / 1.6); });

  // ------------------------------------------------------------ pointer input
  var pointers = new Map();
  var downPos = null, downTime = 0, pinchDist = 0;
  canvas.addEventListener('pointerdown', function (e) {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      var pts = Array.from(pointers.values());
      pinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      downPos = null;
      return;
    }
    downPos = { x: e.clientX, y: e.clientY };
    downTime = performance.now();
    state.dragging = true;
    state.fly = null;
    state.lastInteraction = performance.now();
    canvas.classList.add('dragging');
  });
  canvas.addEventListener('pointermove', function (e) {
    var prev = pointers.get(e.pointerId);
    if (!prev) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      var pts = Array.from(pointers.values());
      var d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (pinchDist > 0 && d > 0) setZoom(state.zoom * (d / pinchDist));
      pinchDist = d;
      state.lastInteraction = performance.now();
      return;
    }
    if (!state.dragging) return;
    var rect = canvas.getBoundingClientRect();
    var dx = e.clientX - prev.x, dy = e.clientY - prev.y;
    if (state.view === 'flat') {
      var scale = flatScale();
      state.flat.lon -= dx / scale;
      state.flat.lon = ((state.flat.lon + 540) % 360) - 180;
      state.flat.lat = clamp(state.flat.lat + dy / scale, -85, 85);
    } else {
      var R = globeR();
      state.globe.lon -= (dx / R) * 180 / Math.PI;
      state.globe.lon = ((state.globe.lon + 540) % 360) - 180;
      state.globe.lat = clamp(state.globe.lat + (dy / R) * 180 / Math.PI, -85, 85);
    }
    void rect;
    state.lastInteraction = performance.now();
    state.needsDraw = true;
  });
  function endPointer(e) {
    var wasClick = false;
    if (downPos && pointers.size === 1) {
      var moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
      wasClick = moved < 6 && performance.now() - downTime < 600;
    }
    pointers.delete(e.pointerId);
    if (pointers.size === 0) {
      state.dragging = false;
      canvas.classList.remove('dragging');
    }
    if (wasClick) handleClick(e);
    downPos = null;
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    var rect = canvas.getBoundingClientRect();
    var cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    setZoom(state.zoom * Math.exp(-e.deltaY * 0.0016), cx, cy);
  }, { passive: false });

  canvas.addEventListener('dblclick', function (e) {
    var rect = canvas.getBoundingClientRect();
    var cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    setZoom(state.zoom * 2, cx, cy);
  });

  function handleClick(e) {
    var rect = canvas.getBoundingClientRect();
    var cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    var best = null, bestD = 16;
    for (var i = 0; i < screenMarkers.length; i++) {
      var m = screenMarkers[i];
      var d = Math.hypot(m.x - cx, m.y - cy);
      if (d < bestD) { bestD = d; best = m; }
    }
    if (best) {
      if (best.type === 'event') {
        flyTo(best.data.lon, best.data.lat);
        showEventDetail(best.data);
      } else {
        var pos = state.satPos[best.data.noradId];
        if (pos) flyTo(pos.lon, pos.lat);
        showSatDetail(best.data);
      }
    } else {
      hideDetail();
    }
  }

  // ------------------------------------------------------------ boot
  renderLayerToggles();
  if (window.ResizeObserver) {
    new ResizeObserver(resize).observe(mapWrap);
  }
  window.addEventListener('resize', resize);
  resize();
  loadDashboard();
  setInterval(tickSatellites, 1000);
  setInterval(periodicCheck, 5 * 60 * 1000);
  requestAnimationFrame(frame);
})();
