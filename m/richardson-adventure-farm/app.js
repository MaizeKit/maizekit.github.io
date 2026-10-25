'use strict';

/** Farther than this from the field (metres), the app says you're not at the maze. */
const NEAR_FARM_M = 1500;
/** How far past the field edge (metres) still counts as being in the maze. */
const OUTSIDE_MARGIN_M = 20;
/** GPS fixes less accurate than this (metres) are ignored. */
const MAX_GPS_ACCURACY_M = 50;
/** Within this distance of the exit (metres), the app says you're at the exit. */
const ARRIVED_M = 8;
/** Walking speed (metres per second) of the simulated visitor in demo mode. */
const DEMO_WALK_MPS = 1.2;

/** How far simulated GPS fixes wander from the true spot in demo mode (metres, one standard deviation). */
const DEMO_GPS_NOISE_M = 3;

/** A Fix my spot correction bigger than this (metres) is a mistake, not GPS error, so it's ignored. */
const MAX_OFFSET_M = 40;

/** How long (ms) after the user pans or zooms before the map frames them and the exit again. */
const HANDS_OFF_MS = 15000;

/** Browser storage key for the user's Fix my spot correction, one per maze. */
const STORE_KEY = 'maze-offset-v3:' + location.pathname;

const $ = (id) => document.getElementById(id);

const state = {
  meta: null,
  grid: null, // Uint8Array, 0 = corn, >0 = path (value ~ distance to corn)
  distToExit: null, // Float64Array from Dijkstra
  offset: { e: 0, n: 0, taps: 0 }, // user correction applied on top of the field georeference
  gps: null, // {e, n, acc, heading, t}
  pin: null, // {u, v}: last spot the user marked
  picking: false,
  mode: 'north', // 'north' | 'track'
  compass: null,
  route: null, // locked route, see routeFor()
  framedAt: 0, // last time the map was framed on you and the exit
  handsOffUntil: 0, // don't reframe until then: the user is moving the map themselves
};

// ---------- coordinates ----------
// Raster pixels (u right, v down) are RES metres; ground is metres east/north of the raster origin.

/**
 * Converts a longitude/latitude to metres east and north of the maze raster's origin.
 * @param {number} lon
 * @param {number} lat
 * @returns {{e: number, n: number}}
 */
function toEN(lon, lat) {
  const { origin, mPerDeg } = state.meta;
  return { e: (lon - origin.lon) * mPerDeg.lon, n: (lat - origin.lat) * mPerDeg.lat };
}
/**
 * Converts metres east/north of the raster origin back to longitude/latitude.
 * @param {number} e Metres east.
 * @param {number} n Metres north.
 * @returns {[number, number]} [lon, lat]
 */
function toLonLat(e, n) {
  const { origin, mPerDeg } = state.meta;
  return [origin.lon + e / mPerDeg.lon, origin.lat + n / mPerDeg.lat];
}
/**
 * Converts a maze raster pixel to ground metres, including the user's Fix my spot correction.
 * @param {number} u Pixel x.
 * @param {number} v Pixel y.
 * @returns {{e: number, n: number}}
 */
function imgToGround(u, v) {
  const r = state.meta.res;
  return { e: u * r + state.offset.e, n: -v * r + state.offset.n };
}
/**
 * Converts ground metres to a maze raster pixel, including the user's Fix my spot correction.
 * @param {number} e Metres east.
 * @param {number} n Metres north.
 * @returns {{u: number, v: number}}
 */
function groundToImg(e, n) {
  const r = state.meta.res;
  return { u: (e - state.offset.e) / r, v: -(n - state.offset.n) / r };
}
/**
 * Converts a maze raster pixel to longitude/latitude.
 * @param {number} u Pixel x.
 * @param {number} v Pixel y.
 * @returns {[number, number]} [lon, lat]
 */
function imgToLonLat(u, v) {
  const g = imgToGround(u, v);
  return toLonLat(g.e, g.n);
}
/**
 * Converts a longitude/latitude to a maze raster pixel.
 * @param {number} lon
 * @param {number} lat
 * @returns {{u: number, v: number}}
 */
function lonLatToImg(lon, lat) {
  const { e, n } = toEN(lon, lat);
  return groundToImg(e, n);
}
/**
 * The maze image's four corners on the map, for MapLibre's image source.
 * @returns {Array<[number, number]>} Top-left, top-right, bottom-right, bottom-left as [lon, lat].
 */
function imageCorners() {
  const { width: W, height: H } = state.meta;
  return [[0, 0], [W, 0], [W, H], [0, H]].map(([u, v]) => imgToLonLat(u, v));
}

/**
 * Saves the Fix my spot correction to browser storage.
 */
function saveOffset() {
  if (state.demo) return; // demo positions are simulated; never keep a correction from them
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state.offset)); } catch (_) {}
}
/**
 * Restores the Fix my spot correction from browser storage, if there is one.
 */
function loadOffset() {
  try {
    const o = JSON.parse(localStorage.getItem(STORE_KEY));
    if (o && isFinite(o.e) && isFinite(o.n) && Math.hypot(o.e, o.n) <= MAX_OFFSET_M) state.offset = o;
  } catch (_) {}
}

// ---------- maze grid + routing ----------

/**
 * Loads the walkable path grid from assets/walk.png into memory.
 * Each cell holds 0 for corn, or a value that grows with distance from the nearest corn.
 * @returns {Promise<void>}
 */
async function loadGrid() {
  const img = new Image();
  img.src = 'assets/walk.png';
  await img.decode();
  const { gridWidth: gw, gridHeight: gh } = state.meta;
  const canvas = document.createElement('canvas');
  canvas.width = gw; canvas.height = gh;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, gw, gh).data;
  const grid = new Uint8Array(gw * gh);
  for (let i = 0; i < grid.length; i++) grid[i] = data[i * 4];
  state.grid = grid;
}

/**
 * A min-heap of grid cells keyed by distance, used by dijkstra() and buildRoute().
 */
class Heap {
  constructor() { this.idx = []; this.key = []; }
  push(i, k) {
    const a = this.idx, b = this.key;
    let n = a.length; a.push(i); b.push(k);
    while (n > 0) {
      const p = (n - 1) >> 1;
      if (b[p] <= k) break;
      a[n] = a[p]; b[n] = b[p]; n = p;
    }
    a[n] = i; b[n] = k;
  }
  pop() {
    const a = this.idx, b = this.key;
    const top = a[0], topK = b[0];
    const li = a.pop(), lk = b.pop();
    if (a.length) {
      let n = 0;
      const len = a.length;
      for (;;) {
        let c = 2 * n + 1;
        if (c >= len) break;
        if (c + 1 < len && b[c + 1] < b[c]) c++;
        if (b[c] >= lk) break;
        a[n] = a[c]; b[n] = b[c]; n = c;
      }
      a[n] = li; b[n] = lk;
    }
    return [top, topK];
  }
  get size() { return this.idx.length; }
}

const NB = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];

/**
 * Cost of stepping into a cell. Cells near corn cost more, so routes keep to the middle of paths.
 * @param {number} g Grid value of the cell (distance to corn).
 * @param {number} base Step length: 1 straight, √2 diagonal.
 * @returns {number}
 */
function stepCost(g, base) {
  const wallCells = g / state.meta.distScale;
  return base * (1 + 2 / Math.max(wallCells, 0.5));
}

/**
 * Walking distance from one cell to every reachable cell on the path grid.
 * Run once from the exit, so the way out from anywhere is a lookup.
 * @param {number} startCell Grid index to measure from.
 * @returns {Float64Array} Distance per cell; Infinity where unreachable.
 */
function dijkstra(startCell) {
  const grid = state.grid;
  const { gridWidth: gw, gridHeight: gh } = state.meta;
  const dist = new Float64Array(gw * gh).fill(Infinity);
  const heap = new Heap();
  dist[startCell] = 0;
  heap.push(startCell, 0);
  while (heap.size) {
    const [i, d] = heap.pop();
    if (d > dist[i]) continue;
    const x = i % gw, y = (i / gw) | 0;
    for (const [dx, dy, base] of NB) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
      const j = ny * gw + nx;
      const g = grid[j];
      if (!g) continue;
      // no corner cutting through corn
      if (dx && dy && (!grid[y * gw + nx] || !grid[ny * gw + x])) continue;
      const nd = d + stepCost(g, base);
      if (nd < dist[j]) { dist[j] = nd; heap.push(j, nd); }
    }
  }
  return dist;
}

/**
 * Finds the nearest grid cell that has a path to the exit.
 * @param {number} u Pixel x.
 * @param {number} v Pixel y.
 * @param {number} [maxR=60] Search radius in cells.
 * @returns {number} Grid index, or -1 if none within the radius.
 */
function snap(u, v, maxR = 60) {
  const { gridWidth: gw, gridHeight: gh, cell } = state.meta;
  const cx = Math.floor(u / cell), cy = Math.floor(v / cell);
  let best = -1, bestD = Infinity;
  for (let r = 0; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
        const i = y * gw + x;
        if (!isFinite(state.distToExit[i])) continue;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    if (best >= 0 && r * r > bestD) break;
  }
  return best;
}

/**
 * Walks downhill on the distance-to-exit field from a cell to the exit.
 * @param {number} fromCell Grid index to start from.
 * @returns {Array<{u: number, v: number}>} Route points in raster pixels.
 */
function traceRoute(fromCell) {
  const { gridWidth: gw, gridHeight: gh, cell } = state.meta;
  const dist = state.distToExit;
  const cells = [fromCell];
  let i = fromCell;
  for (let guard = 0; guard < gw * gh && dist[i] > 0; guard++) {
    const x = i % gw, y = (i / gw) | 0;
    let next = -1, nd = dist[i];
    for (const [dx, dy] of NB) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
      const j = ny * gw + nx;
      if (dist[j] < nd) { nd = dist[j]; next = j; }
    }
    if (next < 0) break;
    cells.push(next);
    i = next;
  }
  return cells.map((c) => ({ u: (c % gw) * cell + cell / 2, v: ((c / gw) | 0) * cell + cell / 2 }));
}

// ---------- geometry helpers ----------

/**
 * Whether a point is inside a polygon.
 * @param {number} u
 * @param {number} v
 * @param {Array<[number, number]>} poly
 * @returns {boolean}
 */
function pointInPoly(u, v, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > v) !== (yj > v) && u < ((xj - xi) * (v - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Distance from a point to a polygon's edge; 0 if inside.
 * @param {number} u
 * @param {number} v
 * @param {Array<[number, number]>} poly
 * @returns {number} Distance in raster pixels.
 */
function distToPoly(u, v, poly) {
  if (pointInPoly(u, v, poly)) return 0;
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [x1, y1] = poly[j], [x2, y2] = poly[i];
    const dx = x2 - x1, dy = y2 - y1;
    const t = Math.max(0, Math.min(1, ((u - x1) * dx + (v - y1) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(u - (x1 + t * dx), v - (y1 + t * dy)));
  }
  return best;
}

const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);
const fmtSteps = (m) => `about ${Math.max(1, Math.round(m / 0.75))} steps`;

// ---------- map ----------

const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: {
      sat: {
        type: 'raster',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        maxzoom: 19,
        attribution: 'Imagery © Esri',
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#e8eae6' } },
      { id: 'sat', type: 'raster', source: 'sat', paint: { 'raster-opacity': 1 } },
    ],
  },
  center: [0, 0], // replaced by fitMaze() once the maze loads
  zoom: 1,
  maxZoom: 22,
  pitchWithRotate: false,
  touchPitch: false,
  attributionControl: { compact: true },
});
map.touchZoomRotate.enableRotation();
// Wait for the style only, not tiles: satellite tiles may never arrive on weak signal.
const mapLoaded = new Promise((resolve) => {
  if (map.style && map.style._loaded) resolve();
  else map.once('style.load', resolve);
});

const emptyFC = () => ({ type: 'FeatureCollection', features: [] });
const pt = (coords, props = {}) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: coords }, properties: props });

/**
 * Adds the maze image, route line and position dot to the map.
 */
function addLayers() {
  map.addSource('maze', { type: 'image', url: 'assets/maze.webp', coordinates: imageCorners() });
  map.addLayer({ id: 'maze', type: 'raster', source: 'maze', paint: { 'raster-opacity': 0.95, 'raster-fade-duration': 0 } });

  map.addSource('route', { type: 'geojson', data: emptyFC() });
  map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#fff', 'line-opacity': 1, 'line-width': ['interpolate', ['exponential', 2], ['zoom'], 16, 4, 20, 14] } });
  map.addLayer({ id: 'route', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#1a73e8', 'line-width': ['interpolate', ['exponential', 2], ['zoom'], 16, 2, 20, 8] } });

  map.addSource('me', { type: 'geojson', data: emptyFC() });
  map.addLayer({ id: 'me-acc', type: 'circle', source: 'me', filter: ['==', ['get', 'kind'], 'gps'], paint: { 'circle-radius': ['get', 'accPx'], 'circle-color': '#1a73e8', 'circle-opacity': 0.15 } });
  map.addLayer({ id: 'me', type: 'circle', source: 'me', paint: { 'circle-radius': 8, 'circle-color': '#1a73e8', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } });
}

const labels = {};
/**
 * Places the EXIT and Entrance labels on the map.
 */
function drawMarks() {
  const { exit, entrance } = state.meta.points;
  for (const [key, p, text, anchor] of [['exit', exit, 'EXIT', 'top-right'], ['entrance', entrance, 'Entrance', 'bottom-right']]) {
    if (!labels[key]) {
      const el = document.createElement('div');
      el.className = 'mark mark-' + key;
      el.textContent = text;
      labels[key] = new maplibregl.Marker({ element: el, anchor }).setLngLat(imgToLonLat(p.x, p.y)).addTo(map);
    }
    labels[key].setLngLat(imgToLonLat(p.x, p.y));
  }
}

/**
 * Zooms the map to show the whole maze.
 * @param {boolean} [animate=true]
 */
function fitMaze(animate = true) {
  const b = new maplibregl.LngLatBounds();
  imageCorners().forEach((c) => b.extend(c));
  const bearing = state.mode === 'track' ? map.getBearing() : fitBearing();
  map.fitBounds(b, { padding: { top: 100, bottom: 90, left: 16, right: 16 }, bearing, duration: animate ? 600 : 0 });
}

/**
 * Which way to turn the map when showing the whole maze: the way the maze's own map faces,
 * so the app matches the sign at the entrance. If that leaves a wide map small on a tall
 * screen (or a tall one on a wide screen), it turns a further 90 degrees to fill the screen.
 * The compass needle shows where north is, and the compass button turns it north-up.
 * @returns {number} Map bearing in degrees.
 */
function fitBearing() {
  const base = state.meta.signBearing ?? 0;
  const sign = state.meta.signAspect ?? 1;
  const screen = map.getContainer().clientWidth / map.getContainer().clientHeight;
  const mismatched = (sign > 1.3 && screen < 0.8) || (sign < 0.77 && screen > 1.3);
  return (base + (mismatched ? 270 : 0)) % 360;
}

// ---------- HUD ----------

/**
 * Sets the status card at the top of the screen.
 * @param {string} tone '' for normal, 'alert' for a warning.
 * @param {string} title
 * @param {string} [sub=''] Smaller second line.
 */
function setHud(tone, title, sub = '') {
  $('hud').className = 'card ' + tone;
  $('hud-title').textContent = title;
  $('hud-sub').textContent = sub;
}

/**
 * Where the user is, in raster pixels: from GPS when it's accurate enough, otherwise the spot they last marked.
 * @returns {{u: number, v: number, kind: 'gps' | 'pin'} | null}
 */
function currentImagePos() {
  if (state.gps && state.gps.acc <= MAX_GPS_ACCURACY_M) return { ...groundToImg(state.gps.e, state.gps.n), kind: 'gps' };
  if (state.pin) return { ...state.pin, kind: 'pin' };
  return null;
}

/**
 * How many metres one screen pixel covers at the current zoom.
 * @param {number} lat
 * @returns {number}
 */
function metersPerScreenPx(lat) {
  return (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * Math.pow(2, map.getZoom()));
}

// ---------- route locking ----------
// GPS jitter of a few metres hops the dot between neighbouring rows, and each row has a
// different way out. So keep the current route while GPS stays near it, slide the dot
// along it, and only re-route after several fixes in a row are clearly off it.

/** Keep the current route while GPS stays within this distance of it (metres). */
const LOCK_M = 8;
/** Re-route after this many GPS fixes in a row are off the current route. */
const OFF_ROUTE_FIXES = 3;

/**
 * Builds a route from a cell to the exit, with cumulative distances along it.
 * @param {number} start Grid index.
 * @returns {{pts: Array<{u: number, v: number}>, cum: number[], along: number, off: number, lastT: number}}
 */
function buildRoute(start) {
  const pts = traceRoute(start);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].u - pts[i - 1].u, pts[i].v - pts[i - 1].v) * state.meta.res);
  return { pts, cum, along: 0, off: 0, lastT: 0 };
}

/**
 * Nearest point on a route to a position. Only searches between minAlong and maxAlong,
 * since a maze route often doubles back one row away.
 * @param {object} route From buildRoute().
 * @param {number} u Pixel x.
 * @param {number} v Pixel y.
 * @param {number} [minAlong=-Infinity] Metres along the route.
 * @param {number} [maxAlong=Infinity] Metres along the route.
 * @returns {{u: number, v: number, i: number, d: number, along: number}} d is metres off the route.
 */
function project(route, u, v, minAlong = -Infinity, maxAlong = Infinity) {
  const { pts, cum } = route;
  let best = { u: pts[0].u, v: pts[0].v, i: 0, d: Infinity, along: 0 };
  for (let i = 0; i < pts.length - 1; i++) {
    if (cum[i + 1] < minAlong || cum[i] > maxAlong) continue;
    const a = pts[i], b = pts[i + 1];
    const dx = b.u - a.u, dy = b.v - a.v, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((u - a.u) * dx + (v - a.v) * dy) / len2)) : 0;
    const pu = a.u + t * dx, pv = a.v + t * dy;
    const d = Math.hypot(u - pu, v - pv) * state.meta.res;
    if (d < best.d) best = { u: pu, v: pv, i, d, along: cum[i] + t * (cum[i + 1] - cum[i]) };
  }
  if (pts.length === 1) best.d = Math.hypot(u - pts[0].u, v - pts[0].v) * state.meta.res;
  return best;
}

/**
 * The route and the user's spot on it. Keeps the current route through small GPS jitter
 * and re-routes only after OFF_ROUTE_FIXES fixes in a row are off it.
 * @param {{u: number, v: number, kind: string}} pos From currentImagePos().
 * @returns {{route: object, here: object} | null}
 */
function routeFor(pos) {
  let route = state.route;
  if (route) {
    // From the last spot on the route you can only have walked so far (back or forward).
    const dt = pos.kind === 'gps' && route.lastT ? Math.max(1, (state.gps.t - route.lastT) / 1000) : 1;
    const reach = 5 + 2.5 * dt;
    const p = project(route, pos.u, pos.v, route.along - reach, route.along + reach);
    const tol = pos.kind === 'gps' ? Math.max(LOCK_M, Math.min(state.gps.acc, 15)) : 2;
    const newFix = pos.kind === 'gps' && state.gps.t !== route.lastT;
    if (newFix) route.lastT = state.gps.t;
    if (p.d <= tol) {
      if (newFix) route.off = 0;
      route.along = p.along;
      return { route, here: p };
    }
    if (pos.kind === 'gps' && (newFix ? ++route.off : route.off) < OFF_ROUTE_FIXES) {
      return { route, here: project(route, pos.u, pos.v, route.along, route.along) };
    }
  }
  const start = snap(pos.u, pos.v);
  if (start < 0) return null;
  route = state.route = buildRoute(start);
  if (pos.kind === 'gps') route.lastT = state.gps.t;
  const here = project(route, pos.u, pos.v, 0, 0);
  route.along = 0;
  return { route, here };
}

/**
 * Redraws everything that depends on position: the dot, the route and the status card.
 * Called on every GPS fix, tap and zoom.
 */
function refresh() {
  if (!state.meta || !state.distToExit || !map.getSource('route')) return;
  const pos = currentImagePos();
  const meSrc = map.getSource('me');
  const routeSrc = map.getSource('route');
  const clear = () => { meSrc.setData(emptyFC()); routeSrc.setData(emptyFC()); };

  if (state.picking) setHud('', 'Tap where you are on the map', 'Tap Fix my spot again to cancel');

  if (state.gps && state.gps.acc <= 500) {
    const c = groundToImg(state.gps.e, state.gps.n);
    const away = distToPoly(c.u, c.v, state.meta.field) * state.meta.res;
    if (away > NEAR_FARM_M) {
      clear();
      if (!state.picking) setHud('alert', 'You’re not at the maze', `${fmtDist(away)} away`);
      return;
    }
  }

  if (!pos) {
    clear();
    if (state.picking) return;
    // iPhone "Precise Location" off gives fixes accurate to only ~1–10 km.
    if (state.gps && state.gps.acc > 500) setHud('alert', 'Turn on Precise Location', 'Settings › Privacy & Security › Location Services › Safari Websites › Precise Location');
    else setHud('', 'Finding your location…', 'Or tap Fix my spot, then tap where you are');
    return;
  }

  const outsideM = distToPoly(pos.u, pos.v, state.meta.field) * state.meta.res;
  if (outsideM > OUTSIDE_MARGIN_M) {
    state.route = null;
    routeSrc.setData(emptyFC());
    meSrc.setData({ type: 'FeatureCollection', features: [pt(imgToLonLat(pos.u, pos.v), { kind: pos.kind, accPx: 0 })] });
    if (!state.picking) setHud('alert', 'You’re not in the maze', `${fmtDist(outsideM)} away`);
    return;
  }

  const r = routeFor(pos);
  if (!r) {
    clear();
    if (!state.picking) setHud('alert', 'Can’t find a path near you', 'Tap Fix my spot, then tap where you are');
    return;
  }
  const { route, here } = r;
  const lonlat = imgToLonLat(here.u, here.v);
  const accPx = state.gps ? state.gps.acc / metersPerScreenPx(lonlat[1]) : 0;
  meSrc.setData({ type: 'FeatureCollection', features: [pt(lonlat, { kind: pos.kind, accPx })] });

  const meters = route.cum[route.cum.length - 1] - here.along;
  const ahead = route.pts.slice(here.i + 1).filter((_, i, a) => i % 2 === 0 || i === a.length - 1);
  const coords = [lonlat, ...ahead.map((p) => imgToLonLat(p.u, p.v))];
  routeSrc.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }] });

  if (!state.picking) {
    if (meters < ARRIVED_M) setHud('', 'You’re at the exit');
    else setHud('', `${fmtDist(meters)} to the exit`, `${fmtSteps(meters)} · follow the blue line`);
  }

  if (state.mode === 'track' && pos.kind === 'gps') map.easeTo({ center: lonlat, duration: 500 });
  else frameRoute(coords);
}

/**
 * Keeps you, the route and the exit on screen, zoomed in as close as they all fit. Reframes at
 * most every few seconds, and not while the user is moving the map themselves.
 * @param {Array<[number, number]>} coords The route from you to the exit, as [lon, lat].
 */
function frameRoute(coords) {
  const now = Date.now();
  if (state.picking || now < state.handsOffUntil || now - state.framedAt < 3000) return;
  state.framedAt = now;
  const b = new maplibregl.LngLatBounds();
  coords.forEach((c) => b.extend(c));
  map.fitBounds(b, { padding: { top: 140, bottom: 110, left: 40, right: 40 }, bearing: map.getBearing(), maxZoom: 19.5, duration: 900 });
}

// ---------- sensors ----------

/**
 * Handles a new GPS fix from the browser.
 * @param {GeolocationPosition} p
 */
function onGps(p) {
  const { latitude: lat, longitude: lon, accuracy, heading } = p.coords;
  state.gps = { ...toEN(lon, lat), acc: accuracy, heading, t: Date.now() };
  if (state.mode === 'track' && state.compass == null && heading != null && !isNaN(heading) && (p.coords.speed || 0) > 0.5) {
    map.easeTo({ bearing: heading, duration: 300 });
  }
  refresh();
}

/**
 * Handles a location error; shows how to turn location on if it was denied.
 * @param {GeolocationPositionError} err
 */
function onGpsError(err) {
  if (err.code === err.PERMISSION_DENIED) {
    setHud('alert', 'Location is off', 'Settings › Privacy › Location Services › Safari Websites. Or tap Fix my spot.');
  }
}

/**
 * Starts watching the phone's location. The browser asks the user for permission.
 */
function startGps() {
  if ('geolocation' in navigator) {
    navigator.geolocation.watchPosition(onGps, onGpsError, { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 });
  }
}

/**
 * Starts reading the compass so Follow mode can turn the map. iPhone asks for permission.
 * @returns {Promise<void>}
 */
async function startCompass() {
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      if ((await DeviceOrientationEvent.requestPermission()) !== 'granted') return;
    }
  } catch (_) { return; }
  let last = 0;
  window.addEventListener('deviceorientation', (ev) => {
    let h = ev.webkitCompassHeading;
    if (h == null && ev.absolute && ev.alpha != null) h = 360 - ev.alpha;
    if (h == null) return;
    state.compass = h;
    const now = performance.now();
    if (state.mode === 'track' && now - last > 120) {
      last = now;
      const diff = ((h - map.getBearing() + 540) % 360) - 180;
      if (Math.abs(diff) > 2) map.easeTo({ bearing: h, duration: 150 });
    }
  });
}

// ---------- controls ----------

/**
 * Switches between north-up and follow (map turns with the phone and stays centred on you).
 * @param {'north' | 'track'} mode
 */
function setMode(mode) {
  state.mode = mode;
  $('btn-mode').classList.toggle('active', mode === 'track');
  if (mode === 'north') {
    map.easeTo({ bearing: 0, duration: 400 });
  } else {
    if (state.compass == null) startCompass();
    const pos = currentImagePos();
    if (pos) map.easeTo({ center: imgToLonLat(pos.u, pos.v), zoom: Math.max(map.getZoom(), 19), bearing: state.compass ?? map.getBearing(), duration: 500 });
  }
  refresh();
}

map.on('rotate', () => {
  $('needle').style.transform = `rotate(${-map.getBearing()}deg)`;
});

$('btn-here').addEventListener('click', () => {
  state.picking = !state.picking;
  $('btn-here').classList.toggle('active', state.picking);
  refresh();
});

map.on('click', (e) => {
  if (!state.picking) return;
  state.picking = false;
  $('btn-here').classList.remove('active');
  const { u, v } = lonLatToImg(e.lngLat.lng, e.lngLat.lat);
  state.pin = { u, v };
  state.route = null; // re-route from the marked spot
  const fresh = state.gps && Date.now() - state.gps.t < 20000 && state.gps.acc <= MAX_GPS_ACCURACY_M;
  if (fresh) {
    // Shift the maze so the tapped spot sits under the GPS fix (running average over taps).
    const g = imgToGround(u, v);
    const k = Math.min(state.offset.taps, 4);
    const next = {
      e: state.offset.e + (state.gps.e - g.e) / (k + 1),
      n: state.offset.n + (state.gps.n - g.n) / (k + 1),
      taps: state.offset.taps + 1,
    };
    // A tap far from where GPS says you are means you're elsewhere, not that the map is off.
    if (Math.hypot(next.e, next.n) <= MAX_OFFSET_M) state.offset = next;
    saveOffset();
    map.getSource('maze').setCoordinates(imageCorners());
      drawMarks();
  }
  refresh();
});

// Dragging the map in track mode drops back to north-up so it doesn't fight the user.
map.on('dragstart', () => { if (state.mode === 'track') setMode('north'); });
// Pans, pinches and scroll-zooms by the user (not our own camera moves) pause auto-framing.
for (const ev of ['dragstart', 'zoomstart', 'rotatestart']) {
  map.on(ev, (e) => { if (e.originalEvent) state.handsOffUntil = Date.now() + HANDS_OFF_MS; });
}
map.on('zoomend', () => refresh());

$('btn-mode').addEventListener('click', () => setMode(state.mode === 'north' ? 'track' : 'north'));
$('btn-maze').addEventListener('click', () => { state.handsOffUntil = Date.now() + HANDS_OFF_MS; fitMaze(); });

// Long-press "Fix my spot" for 2 s to clear the position correction.
let resetTimer = null;
$('btn-here').addEventListener('touchstart', () => {
  resetTimer = setTimeout(() => {
    state.offset = { e: 0, n: 0, taps: 0 };
    state.pin = null;
    state.route = null;
    state.picking = false;
    $('btn-here').classList.remove('active');
    saveOffset();
    map.getSource('maze').setCoordinates(imageCorners());
      drawMarks();
    refresh();
  }, 2000);
}, { passive: true });
$('btn-here').addEventListener('touchend', () => clearTimeout(resetTimer));


// ---------- boot ----------

/**
 * Nearest walkable cell, ignoring whether it reaches the exit. Used before the exit distances exist.
 * @param {number} u
 * @param {number} v
 * @returns {number} Grid index.
 */
function snapRaw(u, v) {
  const { gridWidth: gw, gridHeight: gh, cell } = state.meta;
  const cx = Math.floor(u / cell), cy = Math.floor(v / cell);
  for (let r = 0; r < 40; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x >= 0 && y >= 0 && x < gw && y < gh && state.grid[y * gw + x]) return y * gw + x;
      }
    }
  }
  return cy * gw + cx;
}

// ---------- demo ----------

/**
 * Demo mode: add ?demo to a maze's link and a simulated visitor walks out from the middle
 * of the maze, sending GPS fixes with realistic wobble through the same code as real GPS.
 * ?demo=8 walks 8x faster. Used to try a maze from home and to record videos.
 * @param {number} speedup How many times faster than walking pace.
 */
function startDemo(speedup) {
  const field = state.meta.field;
  const c = field.reduce((a, [x, y]) => [a[0] + x / field.length, a[1] + y / field.length], [0, 0]);
  const start = snap(c[0], c[1]);
  if (start < 0) return;
  const walk = buildRoute(start);
  const total = walk.cum[walk.cum.length - 1];
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const noise = () => Math.sqrt(-2 * Math.log(rand())) * Math.cos(2 * Math.PI * rand()) * DEMO_GPS_NOISE_M;
  const t0 = performance.now();
  const tick = () => {
    const along = Math.min(total, ((performance.now() - t0) / 1000) * DEMO_WALK_MPS * speedup);
    let i = walk.cum.findIndex((d) => d >= along);
    if (i < 0) i = walk.pts.length - 1;
    const g = imgToGround(walk.pts[i].u, walk.pts[i].v);
    const [lon, lat] = toLonLat(g.e + noise(), g.n + noise());
    onGps({ coords: { latitude: lat, longitude: lon, accuracy: 6, heading: null, speed: 0 } });
    if (along < total) setTimeout(tick, 500);
    else setTimeout(() => { state.route = null; startDemo(speedup); }, 4000); // pause at the exit, then walk again
  };
  tick();
}

/**
 * Starts the app: loads the maze data and path grid, works out distances from the exit,
 * draws the map and starts GPS.
 * @returns {Promise<void>}
 */
async function boot() {
  state.meta = await (await fetch('assets/maze.json', { cache: 'no-cache' })).json();
  if (state.meta.name) document.title = state.meta.name;
  if (state.meta.notice) {
    $('notice').textContent = state.meta.notice;
    $('notice').hidden = false;
  }
  loadOffset();
  await loadGrid();
  const exit = state.meta.points.exit;
  state.distToExit = dijkstra(snapRaw(exit.x, exit.y));

  await mapLoaded;
  addLayers();
  drawMarks();
  fitMaze(false);
  setHud('', 'Finding your location…');
  const demo = new URLSearchParams(location.search).get('demo');
  state.demo = demo !== null;
  if (state.demo) {
    state.offset = { e: 0, n: 0, taps: 0 };
    $('notice').textContent = 'Demo: a simulated walk out of the maze.';
    $('notice').hidden = false;
    startDemo(Math.max(1, Number(demo) || 6));
  } else {
    startGps();
  }
  refresh();
}

boot().catch((err) => {
  console.error(err);
  setHud('alert', 'Couldn’t load the maze', String(err));
});

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
