/**
 * Grid and colours for the geomodel range map. The map is Web Mercator, so rows are
 * evenly spaced in Mercator y: the image overlay then lines up with the tiles.
 */

const MAX_LAT = 85.05112878;
const clampLat = (lat: number) => Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));

export function mercY(lat: number): number {
  const r = (clampLat(lat) * Math.PI) / 180;
  return Math.log(Math.tan(Math.PI / 4 + r / 2));
}

export function invMercY(y: number): number {
  return ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;
}

export interface ViewBounds { north: number; south: number; west: number; east: number }

export interface ViewGrid {
  /** Row centre latitudes, north first. */
  lats: number[];
  cols: number;
  west: number;
  east: number;
  /** Edges of the image overlay. */
  north: number;
  south: number;
}

/**
 * Grid for the visible map: about one cell per `cellPx` screen pixels, at most `maxCells` cells.
 * Longitudes may exceed ±180 (wrapped map); the worker wraps them.
 */
export function gridForView(b: ViewBounds, widthPx: number, heightPx: number, cellPx = 6, maxCells = 12000): ViewGrid {
  const north = clampLat(b.north), south = clampLat(b.south);
  let west = b.west, east = b.east;
  if (east - west > 360) { const mid = (west + east) / 2; west = mid - 180; east = mid + 180; }
  let cols = Math.max(8, Math.round(widthPx / cellPx));
  let rows = Math.max(8, Math.round(heightPx / cellPx));
  const scale = Math.sqrt((rows * cols) / maxCells);
  if (scale > 1) { cols = Math.max(8, Math.floor(cols / scale)); rows = Math.max(8, Math.floor(rows / scale)); }
  const yN = mercY(north), yS = mercY(south);
  const lats: number[] = [];
  for (let r = 0; r < rows; r++) lats.push(invMercY(yN - ((r + 0.5) / rows) * (yN - yS)));
  return { lats, cols, west, east, north, south };
}

/** Score colour: transparent below `min`, then a light-to-dark ramp with rising opacity. */
export function scoreColor(v: number, min = 0.01): [number, number, number, number] {
  if (!(v >= min)) return [0, 0, 0, 0];
  const t = Math.max(0, Math.min(1, v));
  // viridis-like stops
  const stops: Array<[number, number, number]> = [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]];
  const x = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
  const c = stops[i].map((a, k) => Math.round(a + (stops[i + 1][k] - a) * f)) as [number, number, number];
  return [c[0], c[1], c[2], Math.round(90 + 140 * t)];
}

/** RGBA pixels (one per cell) for an ImageData of cols x rows. */
export function gridToRgba(values: ArrayLike<number>, rows: number, cols: number, min = 0.01): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rows * cols * 4);
  for (let i = 0; i < rows * cols; i++) {
    const [r, g, b, a] = scoreColor(values[i], min);
    out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = a;
  }
  return out;
}
