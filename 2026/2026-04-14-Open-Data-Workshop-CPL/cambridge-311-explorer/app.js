/* Cambridge 311 Explorer
 * Single-page app: fetch data once, explore via map/charts/timeline.
 */

// ---------- Config ----------
const DATA_URL = "https://data.cambridgema.gov/resource/2z9k-mv9g.json";
const NHOOD_URL = "https://data.cambridgema.gov/resource/k3pi-9823.geojson";
const PAGE_SIZE = 50000;
// Cap to avoid runaway memory; the set is ~145k but we'll pull in chunks.
const MAX_PAGES = 6;

// Distinct qualitative palette — 22 hues that are reasonably distinguishable.
const PALETTE = [
  "#1e6dd1", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6",
  "#ec4899", "#14b8a6", "#f97316", "#6366f1", "#84cc16",
  "#eab308", "#0ea5e9", "#a855f7", "#22c55e", "#dc2626",
  "#06b6d4", "#d946ef", "#fb923c", "#64748b", "#b45309",
  "#0891b2", "#b91c1c"
];
const OTHER_COLOR = "#94a3b8";
const TOP_N_TYPES_COLORED = PALETTE.length;

// ---------- State ----------
const state = {
  records: [],           // {id, type, status, ts (Date), lat, lng, nhoodIdx}
  types: [],             // distinct issue types, sorted by frequency desc
  typeCount: new Map(),  // type -> total count
  typeColor: new Map(),  // type -> color
  statuses: ["Open", "Acknowledged", "Closed", "Archived"],
  nhoods: [],            // {name, n_hood, geom, centroid, bboxCheck}
  nhoodByIdx: new Map(),

  minTs: null,
  maxTs: null,

  // filters
  selectedTypes: new Set(),
  selectedStatuses: new Set(["Open", "Acknowledged", "Closed", "Archived"]),
  selectedNhoods: new Set(), // empty = all

  // window
  windowStart: null,
  windowEnd: null,
  windowSizeDays: 90,

  // map
  mapMode: "pin",       // "pin" or "area"
  map: null,
  pinLayer: null,
  areaLayer: null,

  // animation
  playing: false,
  speedMul: 3,
  animTimer: null,
};

// ---------- Utils ----------
const $ = (sel) => document.querySelector(sel);
const fmtDate = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const DAY_MS = 86400000;

function setLoaderStatus(text, pct) {
  $("#loader-status").textContent = text;
  if (pct != null) $("#loader-fill").style.width = pct + "%";
}

function throttle(fn, ms) {
  let queued = false, lastArgs;
  return (...args) => {
    lastArgs = args;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn(...lastArgs);
    });
  };
}

// ---------- Data loading ----------
async function loadData() {
  setLoaderStatus("Fetching Cambridge neighborhoods…", 2);
  const nhoodRes = await fetch(NHOOD_URL + "?$limit=50");
  const nhoodGeo = await nhoodRes.json();
  state.nhoods = (nhoodGeo.features || []).map((f) => ({
    name: f.properties.name,
    n_hood: f.properties.n_hood,
    geom: f.geometry,
    bbox: bboxOf(f.geometry),
  }));
  state.nhoods.sort((a, b) => a.name.localeCompare(b.name));

  setLoaderStatus("Fetching 311 records (page 1)…", 5);

  const fields = ["ticket_id", "issue_type", "ticket_status", "ticket_created_date_time", "lat", "lng"];
  const select = encodeURIComponent(fields.join(","));
  let offset = 0;
  const all = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${DATA_URL}?$select=${select}&$order=ticket_created_date_time%20DESC&$limit=${PAGE_SIZE}&$offset=${offset}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error("Failed to fetch 311 data: " + r.status);
    const rows = await r.json();
    all.push(...rows);
    offset += rows.length;
    const pct = 5 + Math.min(90, (offset / 145000) * 90);
    setLoaderStatus(`Fetched ${offset.toLocaleString()} records…`, pct);
    if (rows.length < PAGE_SIZE) break;
  }

  setLoaderStatus("Indexing…", 95);

  // Normalize
  const typeCount = new Map();
  const records = [];
  for (const r of all) {
    const lat = parseFloat(r.lat);
    const lng = parseFloat(r.lng);
    if (!isFinite(lat) || !isFinite(lng)) continue;
    if (lat < 42.34 || lat > 42.42 || lng < -71.17 || lng > -71.06) continue; // Cambridge-ish bbox
    const ts = new Date(r.ticket_created_date_time);
    if (isNaN(ts.getTime())) continue;
    const type = r.issue_type || "Other";
    const status = r.ticket_status || "Open";
    records.push({
      id: r.ticket_id,
      type,
      status,
      ts,
      lat,
      lng,
      nhoodIdx: -1, // resolved below
    });
    typeCount.set(type, (typeCount.get(type) || 0) + 1);
  }

  // Resolve neighborhood membership via point-in-polygon
  setLoaderStatus("Mapping points to neighborhoods…", 97);
  for (const rec of records) {
    rec.nhoodIdx = findNhoodIdx(rec.lng, rec.lat);
  }

  // Sort types by frequency desc; assign colors for top N
  const sortedTypes = [...typeCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t);
  const typeColor = new Map();
  sortedTypes.forEach((t, i) => {
    typeColor.set(t, i < TOP_N_TYPES_COLORED ? PALETTE[i] : OTHER_COLOR);
  });

  state.records = records;
  state.typeCount = typeCount;
  state.types = sortedTypes;
  state.typeColor = typeColor;

  // Initial selections: top 10 types on, rest off
  state.selectedTypes = new Set(sortedTypes.slice(0, 10));

  // Time range
  let minTs = Infinity, maxTs = -Infinity;
  for (const r of records) {
    const t = r.ts.getTime();
    if (t < minTs) minTs = t;
    if (t > maxTs) maxTs = t;
  }
  state.minTs = new Date(minTs);
  state.maxTs = new Date(maxTs);

  // Default window: last 90 days
  state.windowEnd = new Date(maxTs);
  state.windowStart = new Date(maxTs - 90 * DAY_MS);

  setLoaderStatus("Ready", 100);
}

// ---------- Neighborhood point-in-polygon ----------
function bboxOf(geom) {
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  const polys = geom.type === "MultiPolygon" ? geom.coordinates : [geom.coordinates];
  for (const poly of polys) {
    for (const ring of poly) {
      for (const [x, y] of ring) {
        if (x < xmin) xmin = x;
        if (x > xmax) xmax = x;
        if (y < ymin) ymin = y;
        if (y > ymax) ymax = y;
      }
    }
  }
  return [xmin, ymin, xmax, ymax];
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > y) !== (yj > y)) &&
      (x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPoly(x, y, polyCoords) {
  // polyCoords = [outerRing, hole1, hole2, ...]
  if (!pointInRing(x, y, polyCoords[0])) return false;
  for (let k = 1; k < polyCoords.length; k++) {
    if (pointInRing(x, y, polyCoords[k])) return false;
  }
  return true;
}

function findNhoodIdx(lng, lat) {
  for (let i = 0; i < state.nhoods.length; i++) {
    const nh = state.nhoods[i];
    const [xmin, ymin, xmax, ymax] = nh.bbox;
    if (lng < xmin || lng > xmax || lat < ymin || lat > ymax) continue;
    const polys = nh.geom.type === "MultiPolygon" ? nh.geom.coordinates : [nh.geom.coordinates];
    for (const poly of polys) {
      if (pointInPoly(lng, lat, poly)) return i;
    }
  }
  return -1;
}

// ---------- Filter pipeline ----------
function filteredIndices() {
  const out = [];
  const wStart = state.windowStart.getTime();
  const wEnd = state.windowEnd.getTime();
  const selTypes = state.selectedTypes;
  const selStatuses = state.selectedStatuses;
  const selNh = state.selectedNhoods;
  const nhFilter = selNh.size > 0;
  const recs = state.records;
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    const t = r.ts.getTime();
    if (t < wStart || t > wEnd) continue;
    if (!selTypes.has(r.type)) continue;
    if (!selStatuses.has(r.status)) continue;
    if (nhFilter && !selNh.has(r.nhoodIdx)) continue;
    out.push(i);
  }
  return out;
}

// ---------- Map ----------
function initMap() {
  const map = L.map("map", { preferCanvas: true, zoomControl: true }).setView([42.378, -71.108], 13);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    subdomains: "abcd",
    maxZoom: 19,
  }).addTo(map);
  state.map = map;
  state.pinLayer = L.layerGroup().addTo(map);
  state.areaLayer = L.layerGroup();
}

function renderMap(idx) {
  const map = state.map;
  state.pinLayer.clearLayers();
  state.areaLayer.clearLayers();

  if (state.mapMode === "pin") {
    if (!map.hasLayer(state.pinLayer)) state.pinLayer.addTo(map);
    if (map.hasLayer(state.areaLayer)) map.removeLayer(state.areaLayer);

    const recs = state.records;
    // Cap render to keep interaction snappy
    const MAX_PINS = 6000;
    let stride = Math.max(1, Math.ceil(idx.length / MAX_PINS));
    for (let k = 0; k < idx.length; k += stride) {
      const r = recs[idx[k]];
      const color = state.typeColor.get(r.type) || OTHER_COLOR;
      const m = L.circleMarker([r.lat, r.lng], {
        radius: 4,
        color,
        weight: 1,
        fillColor: color,
        fillOpacity: 0.75,
        opacity: 0.9,
      });
      m.bindTooltip(
        `<b>${escapeHtml(r.type)}</b><br/>${fmtDate(r.ts)} • ${escapeHtml(r.status)}`,
        { className: "pin-tip" }
      );
      m.addTo(state.pinLayer);
    }
    $("#map-stats").textContent = `${idx.length.toLocaleString()} records in window` + (stride > 1 ? ` (showing 1-in-${stride})` : "");
  } else {
    if (!map.hasLayer(state.areaLayer)) state.areaLayer.addTo(map);
    if (map.hasLayer(state.pinLayer)) map.removeLayer(state.pinLayer);

    const counts = new Array(state.nhoods.length).fill(0);
    const recs = state.records;
    let unassigned = 0;
    for (const i of idx) {
      const r = recs[i];
      if (r.nhoodIdx >= 0) counts[r.nhoodIdx]++;
      else unassigned++;
    }
    const maxC = Math.max(1, ...counts);
    for (let i = 0; i < state.nhoods.length; i++) {
      const nh = state.nhoods[i];
      const c = counts[i];
      const intensity = c / maxC;
      const color = densityColor(intensity);
      const layer = L.geoJSON(nh.geom, {
        style: {
          color: "#475467",
          weight: 1,
          fillColor: color,
          fillOpacity: 0.7,
        },
      });
      layer.bindTooltip(
        `<b>${escapeHtml(nh.name)}</b><br/>${c.toLocaleString()} records`,
        { className: "pin-tip", sticky: true }
      );
      layer.addTo(state.areaLayer);
    }
    $("#map-stats").textContent =
      `${idx.length.toLocaleString()} records in window • max nhood = ${maxC.toLocaleString()}` +
      (unassigned ? ` • ${unassigned} outside nhoods` : "");
  }
}

function densityColor(t) {
  // light yellow → orange → deep red
  const c1 = [255, 247, 214];
  const c2 = [253, 141, 60];
  const c3 = [178, 24, 43];
  let r, g, b;
  if (t < 0.5) {
    const k = t / 0.5;
    r = c1[0] + (c2[0] - c1[0]) * k;
    g = c1[1] + (c2[1] - c1[1]) * k;
    b = c1[2] + (c2[2] - c1[2]) * k;
  } else {
    const k = (t - 0.5) / 0.5;
    r = c2[0] + (c3[0] - c2[0]) * k;
    g = c2[1] + (c3[1] - c2[1]) * k;
    b = c2[2] + (c3[2] - c2[2]) * k;
  }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

function renderLegend(idx) {
  if (state.mapMode === "area") {
    $("#map-legend").innerHTML = `
      <div style="font-weight:600;margin-bottom:4px">Record density</div>
      <div style="display:flex;align-items:center;gap:6px">
        <span style="width:70px;height:10px;background:linear-gradient(90deg,${densityColor(0)},${densityColor(0.5)},${densityColor(1)});display:inline-block;border-radius:2px"></span>
        <span>low → high</span>
      </div>`;
    return;
  }
  // Pin: legend of selected types with counts in window
  const counts = new Map();
  const recs = state.records;
  for (const i of idx) {
    const t = recs[i].type;
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  const rows = [...state.selectedTypes].map((t) => ({
    t, c: counts.get(t) || 0, color: state.typeColor.get(t) || OTHER_COLOR,
  })).sort((a, b) => b.c - a.c).slice(0, 20);
  $("#map-legend").innerHTML =
    `<div style="font-weight:600;margin-bottom:4px">Issue type</div>` +
    rows.map((r) =>
      `<div class="row"><span class="swatch" style="background:${r.color}"></span>
       <span class="lbl" title="${escapeHtml(r.t)}">${escapeHtml(r.t)}</span>
       <span class="cnt">${r.c.toLocaleString()}</span></div>`
    ).join("");
}

// ---------- Charts ----------
function renderCharts(idx) {
  renderTypeChart(idx);
  renderDailyChart(idx);
  renderStatusChart(idx);
}

function renderTypeChart(idx) {
  const canvas = $("#chart-types");
  const ctx = canvas.getContext("2d");
  const w = canvas.width = canvas.clientWidth * devicePixelRatio;
  const h = canvas.height = canvas.clientHeight * devicePixelRatio || 240 * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);
  const W = canvas.clientWidth, H = (h / devicePixelRatio);
  ctx.clearRect(0, 0, W, H);

  const counts = new Map();
  const recs = state.records;
  for (const i of idx) {
    const t = recs[i].type;
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (!rows.length) {
    drawEmpty(ctx, W, H, "No records in window");
    return;
  }

  const maxV = rows[0][1];
  const barH = 18, gap = 4;
  const labelW = 140;
  const startY = 10;
  ctx.font = "11px -apple-system, sans-serif";
  ctx.textBaseline = "middle";

  rows.forEach(([t, c], i) => {
    const y = startY + i * (barH + gap);
    const barMax = W - labelW - 48;
    const bw = Math.max(2, (c / maxV) * barMax);
    ctx.fillStyle = "#344054";
    ctx.textAlign = "right";
    const label = t.length > 22 ? t.slice(0, 21) + "…" : t;
    ctx.fillText(label, labelW - 4, y + barH / 2);
    ctx.fillStyle = state.typeColor.get(t) || OTHER_COLOR;
    ctx.fillRect(labelW, y, bw, barH);
    ctx.fillStyle = "#475467";
    ctx.textAlign = "left";
    ctx.fillText(c.toLocaleString(), labelW + bw + 4, y + barH / 2);
  });
}

function renderDailyChart(idx) {
  const canvas = $("#chart-daily");
  const ctx = canvas.getContext("2d");
  const w = canvas.width = canvas.clientWidth * devicePixelRatio;
  const h = canvas.height = 140 * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);
  const W = canvas.clientWidth, H = 140;
  ctx.clearRect(0, 0, W, H);

  const start = state.windowStart.getTime();
  const end = state.windowEnd.getTime();
  const days = Math.max(1, Math.ceil((end - start) / DAY_MS));
  const bins = new Array(days).fill(0);
  const recs = state.records;
  for (const i of idx) {
    const d = Math.floor((recs[i].ts.getTime() - start) / DAY_MS);
    if (d >= 0 && d < days) bins[d]++;
  }
  const maxV = Math.max(1, ...bins);
  const padL = 28, padR = 6, padT = 6, padB = 20;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const barW = plotW / days;

  ctx.fillStyle = "#1e6dd1";
  for (let i = 0; i < days; i++) {
    const bh = (bins[i] / maxV) * plotH;
    ctx.fillRect(padL + i * barW, padT + plotH - bh, Math.max(1, barW - 0.5), bh);
  }

  // y axis label
  ctx.fillStyle = "#98a2b3";
  ctx.font = "10px -apple-system, sans-serif";
  ctx.textBaseline = "top";
  ctx.textAlign = "right";
  ctx.fillText(maxV.toLocaleString(), padL - 4, padT);
  ctx.fillText("0", padL - 4, padT + plotH - 10);
  // x axis
  ctx.textAlign = "left";
  ctx.fillText(fmtDateShort(new Date(start)), padL, H - 14);
  ctx.textAlign = "right";
  ctx.fillText(fmtDateShort(new Date(end)), W - padR, H - 14);
}

function renderStatusChart(idx) {
  const canvas = $("#chart-status");
  const ctx = canvas.getContext("2d");
  canvas.width = canvas.clientWidth * devicePixelRatio;
  canvas.height = 100 * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);
  const W = canvas.clientWidth, H = 100;
  ctx.clearRect(0, 0, W, H);

  const counts = new Map();
  const recs = state.records;
  for (const i of idx) {
    const s = recs[i].status;
    counts.set(s, (counts.get(s) || 0) + 1);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (!total) {
    drawEmpty(ctx, W, H, "No records in window");
    return;
  }
  const colors = { "Open": "#ef4444", "Acknowledged": "#f59e0b", "Closed": "#10b981", "Archived": "#94a3b8" };
  const order = ["Open", "Acknowledged", "Closed", "Archived"];
  const padL = 8, padR = 8, padT = 10, padB = 10;
  const barH = 14;
  const barY = padT;
  const plotW = W - padL - padR;
  let x = padL;
  for (const s of order) {
    const c = counts.get(s) || 0;
    const frac = c / total;
    const seg = frac * plotW;
    ctx.fillStyle = colors[s] || "#94a3b8";
    ctx.fillRect(x, barY, seg, barH);
    x += seg;
  }
  // legend rows
  ctx.font = "11px -apple-system, sans-serif";
  ctx.textBaseline = "middle";
  let ly = barY + barH + 14;
  let lx = padL;
  for (const s of order) {
    const c = counts.get(s) || 0;
    const pct = ((c / total) * 100).toFixed(1);
    ctx.fillStyle = colors[s];
    ctx.fillRect(lx, ly - 5, 10, 10);
    ctx.fillStyle = "#344054";
    const label = `${s} ${c.toLocaleString()} (${pct}%)`;
    ctx.fillText(label, lx + 14, ly);
    const w = ctx.measureText(label).width + 30;
    lx += w;
    if (lx > W - 60) { lx = padL; ly += 16; }
  }
}

function drawEmpty(ctx, W, H, msg) {
  ctx.fillStyle = "#98a2b3";
  ctx.font = "12px -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(msg, W / 2, H / 2);
}

function fmtDateShort(d) {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  }[c]));
}

// ---------- Timeline ----------
const Timeline = {
  svg: null,
  dims: { width: 0, height: 110, padL: 10, padR: 10, padT: 8, padB: 22 },
  bins: [],       // per-day counts across full data
  binStart: null, // ms
  binDays: 0,

  init() {
    this.svg = $("#timeline");
    this.buildBins();
    this.render();
    this.attachDrag();
    window.addEventListener("resize", throttle(() => this.render(), 100));
  },

  buildBins() {
    const start = new Date(state.minTs);
    start.setHours(0, 0, 0, 0);
    const end = new Date(state.maxTs);
    end.setHours(0, 0, 0, 0);
    const days = Math.floor((end - start) / DAY_MS) + 1;
    const bins = new Array(days).fill(0);
    for (const r of state.records) {
      const d = Math.floor((r.ts.getTime() - start.getTime()) / DAY_MS);
      if (d >= 0 && d < days) bins[d]++;
    }
    this.bins = bins;
    this.binStart = start.getTime();
    this.binDays = days;
  },

  dayToX(day) {
    const { padL, padR } = this.dims;
    const w = this.dims.width - padL - padR;
    return padL + (day / (this.binDays - 1)) * w;
  },

  tsToX(ts) {
    const day = (ts - this.binStart) / DAY_MS;
    return this.dayToX(day);
  },

  xToTs(x) {
    const { padL, padR } = this.dims;
    const w = this.dims.width - padL - padR;
    const day = ((x - padL) / w) * (this.binDays - 1);
    return this.binStart + day * DAY_MS;
  },

  render() {
    const svg = this.svg;
    const rect = svg.getBoundingClientRect();
    this.dims.width = rect.width;
    const { width, height, padL, padR, padT, padB } = this.dims;

    const maxV = Math.max(1, ...this.bins);
    const plotH = height - padT - padB;

    // Group by week for display (reduces DOM nodes)
    const weekBins = [];
    for (let i = 0; i < this.bins.length; i += 7) {
      let s = 0;
      for (let j = i; j < Math.min(i + 7, this.bins.length); j++) s += this.bins[j];
      weekBins.push(s / 7);
    }
    const maxW = Math.max(1, ...weekBins);

    const wStart = state.windowStart.getTime();
    const wEnd = state.windowEnd.getTime();

    // Build SVG
    let html = "";
    const plotW = width - padL - padR;
    const bw = plotW / weekBins.length;
    for (let i = 0; i < weekBins.length; i++) {
      const v = weekBins[i];
      const h = (v / maxW) * plotH;
      const x = padL + i * bw;
      const y = padT + plotH - h;
      const weekStart = this.binStart + i * 7 * DAY_MS;
      const weekEnd = weekStart + 7 * DAY_MS;
      const inWin = weekEnd >= wStart && weekStart <= wEnd;
      const cls = inWin ? "tl-bar-sel" : "tl-bar";
      html += `<rect class="${cls}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, bw - 0.5).toFixed(1)}" height="${h.toFixed(1)}"/>`;
    }

    // Window rectangle + handles
    const wx1 = Math.max(padL, this.tsToX(wStart));
    const wx2 = Math.min(width - padR, this.tsToX(wEnd));
    const wW = Math.max(4, wx2 - wx1);
    html += `<rect class="tl-window" id="tl-window" x="${wx1.toFixed(1)}" y="${padT}" width="${wW.toFixed(1)}" height="${plotH}"/>`;
    html += `<rect class="tl-handle" id="tl-handle-l" x="${(wx1 - 3).toFixed(1)}" y="${padT - 2}" width="6" height="${plotH + 4}" rx="2"/>`;
    html += `<rect class="tl-handle" id="tl-handle-r" x="${(wx2 - 3).toFixed(1)}" y="${padT - 2}" width="6" height="${plotH + 4}" rx="2"/>`;

    // x-axis labels (year ticks)
    const minY = new Date(this.binStart).getFullYear();
    const maxY = new Date(this.binStart + (this.binDays - 1) * DAY_MS).getFullYear();
    for (let y = minY; y <= maxY; y++) {
      const ts = new Date(y, 0, 1).getTime();
      if (ts < this.binStart) continue;
      const x = this.tsToX(ts);
      html += `<line class="tl-axis" x1="${x}" x2="${x}" y1="${padT}" y2="${padT + plotH}" stroke-dasharray="2,2"/>`;
      html += `<text class="tl-axis" x="${x + 3}" y="${height - 6}">${y}</text>`;
    }

    svg.innerHTML = html;
  },

  attachDrag() {
    let dragMode = null; // "window" | "left" | "right" | null
    let grabOffsetMs = 0;
    let startWindowStart = null, startWindowEnd = null;

    const onDown = (e) => {
      const pt = this.getPointerX(e);
      if (!pt) return;
      const target = e.target;
      e.preventDefault();
      if (target.id === "tl-handle-l") dragMode = "left";
      else if (target.id === "tl-handle-r") dragMode = "right";
      else if (target.id === "tl-window") {
        dragMode = "window";
        const winMid = (state.windowStart.getTime() + state.windowEnd.getTime()) / 2;
        grabOffsetMs = this.xToTs(pt) - winMid;
      } else {
        // Click on background: center window at click
        const clickTs = this.xToTs(pt);
        const half = (state.windowEnd - state.windowStart) / 2;
        setWindow(clickTs - half, clickTs + half);
        return;
      }
      startWindowStart = state.windowStart.getTime();
      startWindowEnd = state.windowEnd.getTime();
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp, { once: true });
      const winEl = document.getElementById("tl-window");
      if (winEl) winEl.classList.add("grabbing");
    };

    const onMove = (e) => {
      const pt = this.getPointerX(e);
      if (!pt) return;
      const ts = this.xToTs(pt);
      if (dragMode === "left") {
        setWindow(Math.min(ts, startWindowEnd - DAY_MS), startWindowEnd);
      } else if (dragMode === "right") {
        setWindow(startWindowStart, Math.max(ts, startWindowStart + DAY_MS));
      } else if (dragMode === "window") {
        const size = startWindowEnd - startWindowStart;
        const mid = ts - grabOffsetMs;
        setWindow(mid - size / 2, mid + size / 2);
      }
    };

    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      dragMode = null;
      const winEl = document.getElementById("tl-window");
      if (winEl) winEl.classList.remove("grabbing");
    };

    this.svg.addEventListener("pointerdown", onDown);

    // Wheel: shift window
    this.svg.addEventListener("wheel", (e) => {
      e.preventDefault();
      const size = state.windowEnd - state.windowStart;
      const shift = (e.deltaX || e.deltaY) * 0.5 * DAY_MS / 10;
      setWindow(state.windowStart.getTime() + shift, state.windowEnd.getTime() + shift);
    }, { passive: false });
  },

  getPointerX(e) {
    const r = this.svg.getBoundingClientRect();
    return e.clientX - r.left;
  },
};

// ---------- Window setter (clamps + redraws) ----------
function setWindow(startMs, endMs, { skipRender = false } = {}) {
  const minMs = state.minTs.getTime();
  const maxMs = state.maxTs.getTime();
  let s = Math.max(minMs, Math.min(startMs, maxMs - DAY_MS));
  let e = Math.max(s + DAY_MS, Math.min(endMs, maxMs));
  state.windowStart = new Date(s);
  state.windowEnd = new Date(e);
  updateRangeLabel();
  if (!skipRender) rerender();
}

function updateRangeLabel() {
  const days = Math.round((state.windowEnd - state.windowStart) / DAY_MS);
  $("#range-label").textContent =
    `${fmtDate(state.windowStart)} → ${fmtDate(state.windowEnd)} • ${days}d window`;
}

// ---------- Re-render orchestration ----------
const rerenderInner = () => {
  const idx = filteredIndices();
  renderMap(idx);
  renderLegend(idx);
  renderCharts(idx);
  Timeline.render();
};
const rerender = throttle(rerenderInner, 16);

// ---------- UI: filters ----------
function buildFilterUI() {
  // Types
  const typeList = $("#type-list");
  const items = state.types.map((t) => {
    const color = state.typeColor.get(t);
    const count = state.typeCount.get(t);
    const checked = state.selectedTypes.has(t) ? "checked" : "";
    return `<label class="row" data-type="${escapeHtml(t)}">
      <input type="checkbox" ${checked}/>
      <span class="swatch" style="background:${color}"></span>
      <span class="lbl" title="${escapeHtml(t)}">${escapeHtml(t)}</span>
      <span class="cnt">${count.toLocaleString()}</span>
    </label>`;
  }).join("");
  typeList.innerHTML = items;
  typeList.addEventListener("change", (e) => {
    const row = e.target.closest("label[data-type]");
    if (!row) return;
    const t = row.dataset.type;
    if (e.target.checked) state.selectedTypes.add(t);
    else state.selectedTypes.delete(t);
    rerender();
  });

  $("#type-search").addEventListener("input", (e) => {
    const q = e.target.value.toLowerCase();
    typeList.querySelectorAll("label[data-type]").forEach((row) => {
      const t = row.dataset.type.toLowerCase();
      row.style.display = t.includes(q) ? "" : "none";
    });
  });
  $("#types-all").addEventListener("click", () => {
    typeList.querySelectorAll("label[data-type]").forEach((row) => {
      if (row.style.display === "none") return;
      const t = row.dataset.type;
      state.selectedTypes.add(t);
      row.querySelector("input").checked = true;
    });
    rerender();
  });
  $("#types-none").addEventListener("click", () => {
    typeList.querySelectorAll("label[data-type]").forEach((row) => {
      if (row.style.display === "none") return;
      const t = row.dataset.type;
      state.selectedTypes.delete(t);
      row.querySelector("input").checked = false;
    });
    rerender();
  });

  // Statuses
  const statusColors = { "Open": "#ef4444", "Acknowledged": "#f59e0b", "Closed": "#10b981", "Archived": "#94a3b8" };
  const statusList = $("#status-list");
  statusList.innerHTML = state.statuses.map((s) => `
    <label class="row" data-status="${s}">
      <input type="checkbox" checked/>
      <span class="swatch" style="background:${statusColors[s]}"></span>
      <span class="lbl">${s}</span>
    </label>
  `).join("");
  statusList.addEventListener("change", (e) => {
    const row = e.target.closest("label[data-status]");
    if (!row) return;
    const s = row.dataset.status;
    if (e.target.checked) state.selectedStatuses.add(s);
    else state.selectedStatuses.delete(s);
    rerender();
  });

  // Neighborhoods
  const sel = $("#nhood-select");
  sel.innerHTML = state.nhoods.map((nh, i) => `<option value="${i}">${escapeHtml(nh.name)}</option>`).join("");
  sel.addEventListener("change", () => {
    state.selectedNhoods = new Set([...sel.selectedOptions].map((o) => parseInt(o.value, 10)));
    rerender();
  });

  $("#clear-filters").addEventListener("click", () => {
    state.selectedTypes = new Set(state.types.slice(0, 10));
    state.selectedStatuses = new Set(state.statuses);
    state.selectedNhoods = new Set();
    sel.selectedIndex = -1;
    typeList.querySelectorAll("label[data-type]").forEach((row) => {
      row.querySelector("input").checked = state.selectedTypes.has(row.dataset.type);
    });
    statusList.querySelectorAll("label[data-status] input").forEach((i) => (i.checked = true));
    rerender();
  });

  // Mode toggle
  document.querySelectorAll("#mode-toggle button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#mode-toggle button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.mapMode = btn.dataset.mode;
      rerender();
    });
  });

  // Window presets
  $("#window-preset").addEventListener("change", (e) => {
    const days = parseInt(e.target.value, 10);
    state.windowSizeDays = days;
    const end = state.windowEnd.getTime();
    setWindow(end - days * DAY_MS, end);
  });

  // Play
  $("#play-btn").addEventListener("click", togglePlay);
  $("#speed").addEventListener("change", (e) => {
    state.speedMul = parseFloat(e.target.value);
  });
}

// ---------- Animation ----------
function togglePlay() {
  state.playing = !state.playing;
  const btn = $("#play-btn");
  btn.textContent = state.playing ? "❚❚" : "▶";
  btn.classList.toggle("playing", state.playing);
  if (state.playing) stepAnim();
  else if (state.animTimer) { clearTimeout(state.animTimer); state.animTimer = null; }
}

function stepAnim() {
  if (!state.playing) return;
  const mul = state.speedMul;
  // days to advance per tick, and tick interval ms
  // 1x = 1 day / 400 ms; 3x = 1 day / 140 ms; 7x=7d/300ms; 14x=14d/300ms; 30x=30d/300ms
  let stepDays, intervalMs;
  if (mul <= 1) { stepDays = 1; intervalMs = 400; }
  else if (mul <= 3) { stepDays = 1; intervalMs = 140; }
  else if (mul <= 7) { stepDays = 7; intervalMs = 300; }
  else if (mul <= 14) { stepDays = 14; intervalMs = 300; }
  else { stepDays = 30; intervalMs = 300; }

  const windowMs = state.windowEnd - state.windowStart;
  let newEnd = state.windowEnd.getTime() + stepDays * DAY_MS;
  let newStart = newEnd - windowMs;

  // wrap back to start when we overshoot
  if (newEnd > state.maxTs.getTime()) {
    newStart = state.minTs.getTime();
    newEnd = newStart + windowMs;
  }
  setWindow(newStart, newEnd);
  state.animTimer = setTimeout(stepAnim, intervalMs);
}

// ---------- Main ----------
async function main() {
  try {
    await loadData();
    initMap();
    buildFilterUI();
    Timeline.init();
    updateRangeLabel();
    rerenderInner();
    // Leaflet needs a size recalc once the containing flex/grid has settled
    setTimeout(() => state.map && state.map.invalidateSize(), 50);
    $("#record-count").textContent =
      `${state.records.length.toLocaleString()} records • ${fmtDate(state.minTs)} – ${fmtDate(state.maxTs)}`;
    setTimeout(() => {
      $("#loader").classList.add("hidden");
      // After loader hides, give the browser a frame to settle the grid layout
      // then tell Leaflet to recalc so tiles fill the container.
      requestAnimationFrame(() => {
        state.map && state.map.invalidateSize();
        Timeline.render();
      });
    }, 200);
  } catch (err) {
    console.error(err);
    setLoaderStatus("Error: " + err.message, 100);
  }
}

main();
