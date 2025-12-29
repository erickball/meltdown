/**
 * Water/Steam Properties Module v3 - Delaunay Interpolation
 *
 * Based on steam.py approach: uses Delaunay triangulation in (log(v), u) space
 * to interpolate P and T from the steam table data.
 *
 * Key improvements over v2:
 * - Proper 2D interpolation using triangulation
 * - Uses log(v) for better interpolation across orders of magnitude
 * - Direct table lookup for all single-phase states
 * - Explicit two-phase region detection using saturation curves
 */

// Browser/Node.js compatible steam table loading
//
// Strategy:
// 1. For browser (Vite): Use static import with ?raw suffix - Vite inlines the file content
// 2. For Node.js (tests): Detect browser absence and use fs.readFileSync
//
// The import is gated so that Node.js/tsx doesn't try to resolve it.

// Steam table content - populated by loadSteamTable() based on environment
let steamTableContent: string | undefined;

// For Node.js: preload fs and path using top-level await (works in ESM)
// This is wrapped in try-catch so browser builds don't fail
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let nodeFs: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let nodePath: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let nodeUrl: any;
try {
  if (typeof window === 'undefined') {
    // Node.js environment - load modules dynamically
    // Using string concatenation to prevent Vite from trying to bundle these
    const fsModule = 'fs';
    const pathModule = 'path';
    const urlModule = 'url';
    nodeFs = await import(/* @vite-ignore */ fsModule);
    nodePath = await import(/* @vite-ignore */ pathModule);
    nodeUrl = await import(/* @vite-ignore */ urlModule);
  }
} catch {
  // Browser or unsupported environment - ignore
}

// ============================================================================
// Constants
// ============================================================================

const T_CRIT = 647.096;     // K
const P_CRIT = 22.064e6;    // Pa
const RHO_CRIT = 322;       // kg/m³
const T_TRIPLE = 273.16;    // K
const T_REF = 273.15;       // K
const R_WATER = 461.5;      // J/kg-K
const CV_LIQUID = 4186;     // J/kg-K

// ============================================================================
// Data Types
// ============================================================================

interface DataPoint {
  P: number;      // Pa
  T: number;      // K
  v: number;      // m³/kg
  u: number;      // J/kg
  logV: number;   // log10(v)
  logP: number;   // log10(P) for (P,u)->rho interpolation
  phase: string;
}

interface Triangle {
  i: number;
  j: number;
  k: number;
}

interface SaturationPair {
  P: number;      // Pa
  T: number;      // K
  v_f: number;    // m³/kg
  v_g: number;    // m³/kg
  u_f: number;    // J/kg
  u_g: number;    // J/kg
}

// ============================================================================
// Module State
// ============================================================================

let dataPoints: DataPoint[] = [];
let triangles: Triangle[] = [];
let saturationPairs: SaturationPair[] = [];
let dataLoaded = false;

// ============================================================================
// Spatial Index for O(1) Triangle Lookup
// ============================================================================

interface GridCell {
  triangleIndices: number[];
}

// Grid parameters - will be set during initialization
let grid: GridCell[][] = [];
let gridMinLogV = 0;
let gridMaxLogV = 0;
let gridMinU = 0;
let gridMaxU = 0;
let gridCellsX = 0;
let gridCellsY = 0;
let gridCellWidth = 0;
let gridCellHeight = 0;

// LRU Cache for recent lookups
const CACHE_SIZE = 64;
interface CacheEntry {
  logV: number;
  u: number;
  triangleIdx: number;  // -1 means no triangle found
  age: number;
}
let lookupCache: CacheEntry[] = [];
let cacheAge = 0;

// Precomputed minVf for two-phase check
let minVf = 0.001;

// ============================================================================
// Phase Detection Caches (built once after loading saturation pairs)
// ============================================================================

interface DomeBoundaryPoint {
  v: number;
  logV: number;  // log(v) for accurate interpolation near critical point
  u: number;
  sat: SaturationPair;
  side: 'liquid' | 'vapor';
}

interface DomeBoundaryCache {
  points: DomeBoundaryPoint[];
  v_min: number;
  v_max: number;
}

interface BoundsCache {
  v_f_min: number;
  v_g_max: number;
  u_f_min: number;
  u_g_max: number;
}

// Cache structures - populated by buildPhaseDetectionCaches()
let domeBoundaryCache: DomeBoundaryCache | null = null;
let sortedSatPairsCache: SaturationPair[] = [];  // Pre-sorted by pressure
let boundsCache: BoundsCache | null = null;

// Detailed saturated steam table data for accurate dome boundary
let detailedSaturationData: SaturationPair[] = [];
let detailedSaturationLoaded = false;

// Convergence tracking for debugging
let bisectionFailureCount = 0;
let bisectionTotalCount = 0;

// ============================================================================
// Compressed Liquid (P,u)->rho Interpolation
// ============================================================================

// Data structure for (P,u)->rho interpolation in compressed liquid region
interface CompressedLiquidPoint {
  logP: number;    // log10(P) in Pa
  u: number;       // J/kg
  rho: number;     // kg/m³ (= 1/v)
  idx: number;     // Index into original dataPoints for reference
}

// Module state for compressed liquid interpolation
let clPoints: CompressedLiquidPoint[] = [];
let clTriangles: Triangle[] = [];
let clGrid: GridCell[][] = [];
let clGridMinLogP = 0;
let clGridMaxLogP = 0;
let clGridMinU = 0;
let clGridMaxU = 0;
let clGridCellsX = 0;
let clGridCellsY = 0;
let clGridCellWidth = 0;
let clGridCellHeight = 0;
let clDataReady = false;

// ============================================================================
// Liquid-Only (V,u)->P Interpolation
// ============================================================================
// This is similar to the compressed liquid interpolation but uses (logV, u) space
// to enable (u, v) -> P lookups without crossing into vapor region.

interface LiquidVUPoint {
  logV: number;   // log10(v) where v is specific volume in m³/kg
  u: number;      // Internal energy in J/kg
  P: number;      // Pressure in Pa
  idx: number;    // Index into original dataPoints
}

let lvuPoints: LiquidVUPoint[] = [];
let lvuTriangles: Triangle[] = [];
let lvuGrid: GridCell[][] = [];
let lvuGridMinLogV = 0;
let lvuGridMaxLogV = 0;
let lvuGridMinU = 0;
let lvuGridMaxU = 0;
let lvuGridCellsX = 0;
let lvuGridCellsY = 0;
let lvuGridCellWidth = 0;
let lvuGridCellHeight = 0;
let lvuDataReady = false;

/**
 * Load detailed saturated steam table for accurate dome boundary.
 * This table has ~277 points from triple point to critical point.
 */
function loadDetailedSaturationTable(): void {
  if (detailedSaturationLoaded) return;

  try {
    const isBrowser = typeof window !== 'undefined';
    let content: string = '';

    if (isBrowser) {
      // Browser: use synchronous XHR
      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/saturated-steam-table.txt', false); // false = synchronous
      xhr.send();
      if (xhr.status === 200) {
        content = xhr.responseText;
      } else {
        throw new Error(`Failed to fetch saturated steam table: HTTP ${xhr.status}`);
      }
    } else {
      // Node.js: use fs
      if (!nodeFs || !nodePath || !nodeUrl) {
        throw new Error('Node.js modules not loaded');
      }
      const __filename = nodeUrl.fileURLToPath(import.meta.url);
      const __dirname = nodePath.dirname(__filename);
      const satTablePath = nodePath.resolve(__dirname, '../../public/saturated-steam-table.txt');
      content = nodeFs.readFileSync(satTablePath, 'utf-8');
    }

    const lines = content.split('\n');
    detailedSaturationData = [];

    // Skip header line
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const parts = line.split('\t');
      if (parts.length < 6) continue;

      const P = parseFloat(parts[0]) * 1e6;  // MPa to Pa
      const T = parseFloat(parts[1]) + 273.15;  // °C to K
      const v_f = parseFloat(parts[2]);  // m³/kg
      const v_g = parseFloat(parts[3]);  // m³/kg
      const u_f = parseFloat(parts[4]) * 1000;  // kJ/kg to J/kg
      const u_g = parseFloat(parts[5]) * 1000;  // kJ/kg to J/kg

      if (!isNaN(P) && !isNaN(T) && !isNaN(v_f) && !isNaN(v_g) && !isNaN(u_f) && !isNaN(u_g)) {
        detailedSaturationData.push({ P, T, v_f, v_g, u_f, u_g });
      }
    }

    detailedSaturationLoaded = true;
    console.log(`[WaterProps v3] Loaded ${detailedSaturationData.length} detailed saturation points`);
  } catch (error) {
    console.warn('[WaterProps v3] Could not load detailed saturation table, falling back to general data:', error);
    detailedSaturationData = [...saturationPairs];
    detailedSaturationLoaded = true;
  }
}

/**
 * Build caches for fast phase detection.
 * Called once after saturation pairs are loaded.
 */
function buildPhaseDetectionCaches(): void {
  if (saturationPairs.length === 0) return;

  // Use detailed saturation data if available, otherwise fall back to general saturation pairs
  const satData = detailedSaturationLoaded && detailedSaturationData.length > 0
    ? detailedSaturationData
    : saturationPairs;

  // Build dome boundary as continuous piecewise curve
  const liquidLine: DomeBoundaryPoint[] = satData.map(s => ({
    v: s.v_f,
    logV: Math.log(s.v_f),
    u: s.u_f,
    sat: s,
    side: 'liquid' as const,
  })).sort((a, b) => a.v - b.v);

  const vaporLine: DomeBoundaryPoint[] = satData.map(s => ({
    v: s.v_g,
    logV: Math.log(s.v_g),
    u: s.u_g,
    sat: s,
    side: 'vapor' as const,
  })).sort((a, b) => a.v - b.v);

  const domeBoundary = [...liquidLine, ...vaporLine];

  domeBoundaryCache = {
    points: domeBoundary,
    v_min: domeBoundary[0].v,
    v_max: domeBoundary[domeBoundary.length - 1].v,
  };

  // Pre-sort saturation pairs by pressure - use detailed data for bisection
  sortedSatPairsCache = [...satData].sort((a, b) => a.P - b.P);

  // Pre-compute bounds
  boundsCache = {
    v_f_min: Math.min(...satData.map(s => s.v_f)),
    v_g_max: Math.max(...satData.map(s => s.v_g)),
    u_f_min: Math.min(...satData.map(s => s.u_f)),
    u_g_max: Math.max(...satData.map(s => s.u_g)),
  };

  console.log(`[WaterProps v3] Phase detection caches built: dome has ${domeBoundary.length} points (from ${satData.length} saturation points)`);
}

/**
 * Find the saturation line u value at a given v.
 * Uses binary search on the pre-built dome boundary.
 * Uses log-linear interpolation for accuracy near critical point.
 * Returns null if v is outside the dome range.
 *
 * NOTE: This function returns the u value on the dome boundary at the given v,
 * but this is NOT sufficient to determine if a point is inside the two-phase region.
 * The dome boundary is constructed as [...liquidLine, ...vaporLine] which creates
 * a continuous curve, but the two-phase region is the area BETWEEN the liquid and vapor lines.
 */
function findSaturationU(v: number): { u_sat: number; side: 'liquid' | 'vapor' } | null {
  if (!domeBoundaryCache) return null;

  const { points: domeBoundary, v_min, v_max } = domeBoundaryCache;

  // If v is outside the dome range
  if (v < v_min || v > v_max) {
    return null;
  }

  const logV = Math.log(v);

  // Binary search for the segment containing v (still search by v for correct ordering)
  let lo = 0;
  let hi = domeBoundary.length - 2;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (domeBoundary[mid + 1].v < v) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  const p1 = domeBoundary[lo];
  const p2 = domeBoundary[lo + 1];

  // Verify v is in this segment (handles edge cases)
  if (v < p1.v || v > p2.v) {
    // Linear search fallback (shouldn't happen often)
    for (let i = 0; i < domeBoundary.length - 1; i++) {
      if (v >= domeBoundary[i].v && v <= domeBoundary[i + 1].v) {
        const pt1 = domeBoundary[i];
        const pt2 = domeBoundary[i + 1];
        // Use log-linear interpolation
        const t = (logV - pt1.logV) / (pt2.logV - pt1.logV);
        const u_sat = pt1.u + t * (pt2.u - pt1.u);
        let side: 'liquid' | 'vapor' = pt1.side;
        if (pt1.side !== pt2.side) side = t < 0.5 ? 'liquid' : 'vapor';
        return { u_sat, side };
      }
    }
    return null;
  }

  // Use log-linear interpolation: linear in log(v) space
  const t = (logV - p1.logV) / (p2.logV - p1.logV);
  const u_sat = p1.u + t * (p2.u - p1.u);

  let side: 'liquid' | 'vapor' = p1.side;
  if (p1.side !== p2.side) {
    side = t < 0.5 ? 'liquid' : 'vapor';
  }

  return { u_sat, side };
}

// ============================================================================
// Spatial Index Functions
// ============================================================================

function buildSpatialIndex(): void {
  if (triangles.length === 0 || dataPoints.length === 0) return;

  // Find bounds
  let minLV = Infinity, maxLV = -Infinity;
  let minU_val = Infinity, maxU_val = -Infinity;

  for (const pt of dataPoints) {
    if (pt.phase === '__super__') continue;
    minLV = Math.min(minLV, pt.logV);
    maxLV = Math.max(maxLV, pt.logV);
    minU_val = Math.min(minU_val, pt.u);
    maxU_val = Math.max(maxU_val, pt.u);
  }

  // Add small padding
  const padLV = (maxLV - minLV) * 0.01;
  const padU = (maxU_val - minU_val) * 0.01;
  gridMinLogV = minLV - padLV;
  gridMaxLogV = maxLV + padLV;
  gridMinU = minU_val - padU;
  gridMaxU = maxU_val + padU;

  // Grid size: aim for ~10-20 triangles per cell on average
  // With 18000 triangles, ~50x50 = 2500 cells -> ~7 triangles/cell
  gridCellsX = 50;
  gridCellsY = 50;
  gridCellWidth = (gridMaxLogV - gridMinLogV) / gridCellsX;
  gridCellHeight = (gridMaxU - gridMinU) / gridCellsY;

  // Initialize grid
  grid = [];
  for (let i = 0; i < gridCellsX; i++) {
    grid[i] = [];
    for (let j = 0; j < gridCellsY; j++) {
      grid[i][j] = { triangleIndices: [] };
    }
  }

  // Populate grid with triangles
  for (let tIdx = 0; tIdx < triangles.length; tIdx++) {
    const t = triangles[tIdx];
    const p0 = dataPoints[t.i];
    const p1 = dataPoints[t.j];
    const p2 = dataPoints[t.k];

    // Find bounding box of triangle
    const triMinLV = Math.min(p0.logV, p1.logV, p2.logV);
    const triMaxLV = Math.max(p0.logV, p1.logV, p2.logV);
    const triMinU = Math.min(p0.u, p1.u, p2.u);
    const triMaxU = Math.max(p0.u, p1.u, p2.u);

    // Find grid cells that overlap with triangle's bounding box
    const minCellX = Math.max(0, Math.floor((triMinLV - gridMinLogV) / gridCellWidth));
    const maxCellX = Math.min(gridCellsX - 1, Math.floor((triMaxLV - gridMinLogV) / gridCellWidth));
    const minCellY = Math.max(0, Math.floor((triMinU - gridMinU) / gridCellHeight));
    const maxCellY = Math.min(gridCellsY - 1, Math.floor((triMaxU - gridMinU) / gridCellHeight));

    // Add triangle to all overlapping cells
    for (let i = minCellX; i <= maxCellX; i++) {
      for (let j = minCellY; j <= maxCellY; j++) {
        grid[i][j].triangleIndices.push(tIdx);
      }
    }
  }

  // Compute minVf from saturation data
  if (saturationPairs.length > 0) {
    minVf = Math.min(...saturationPairs.map(s => s.v_f));
  }

  // Initialize cache
  lookupCache = [];
  cacheAge = 0;
}

function gridLookup(logV: number, u: number): number {
  // Get grid cell
  const cellX = Math.floor((logV - gridMinLogV) / gridCellWidth);
  const cellY = Math.floor((u - gridMinU) / gridCellHeight);

  // Check bounds
  if (cellX < 0 || cellX >= gridCellsX || cellY < 0 || cellY >= gridCellsY) {
    return -1;
  }

  // Search only triangles in this cell
  const candidates = grid[cellX][cellY].triangleIndices;
  for (const tIdx of candidates) {
    if (pointInTriangle(logV, u, triangles[tIdx])) {
      return tIdx;
    }
  }

  return -1;
}

function cacheLookup(logV: number, u: number): number | null {
  // Tolerance for cache hit - small values since logV and u have different scales
  const tolLV = 0.001;  // ~0.2% change in v
  const tolU = 100;     // 100 J/kg tolerance

  for (const entry of lookupCache) {
    if (Math.abs(entry.logV - logV) < tolLV && Math.abs(entry.u - u) < tolU) {
      entry.age = ++cacheAge;  // Update age on hit
      return entry.triangleIdx;
    }
  }
  return null;
}

function cacheStore(logV: number, u: number, triangleIdx: number): void {
  // Check if already in cache
  for (const entry of lookupCache) {
    if (Math.abs(entry.logV - logV) < 0.0001 && Math.abs(entry.u - u) < 10) {
      entry.triangleIdx = triangleIdx;
      entry.age = ++cacheAge;
      return;
    }
  }

  // Add new entry
  if (lookupCache.length < CACHE_SIZE) {
    lookupCache.push({ logV, u, triangleIdx, age: ++cacheAge });
  } else {
    // Evict oldest entry
    let oldest = 0;
    let oldestAge = lookupCache[0].age;
    for (let i = 1; i < lookupCache.length; i++) {
      if (lookupCache[i].age < oldestAge) {
        oldest = i;
        oldestAge = lookupCache[i].age;
      }
    }
    lookupCache[oldest] = { logV, u, triangleIdx, age: ++cacheAge };
  }
}

// ============================================================================
// Compressed Liquid (P,u)->rho Interpolation Functions
// ============================================================================

/**
 * Build the compressed liquid interpolation structure.
 * Extracts liquid-phase points and builds a Delaunay triangulation in (logP, u) space.
 */
function buildCompressedLiquidInterpolation(): void {
  // Filter for liquid-phase points only
  clPoints = [];
  for (let i = 0; i < dataPoints.length; i++) {
    const pt = dataPoints[i];
    // Include 'liquid' and 'saturated liquid' (but not vapor or two-phase)
    if (pt.phase === 'liquid' || pt.phase === 'saturated liquid') {
      clPoints.push({
        logP: pt.logP,
        u: pt.u,
        rho: 1 / pt.v,  // density = 1/specific volume
        idx: i,
      });
    }
  }

  if (clPoints.length < 3) {
    console.warn('[WaterProps v3] Not enough liquid points for compressed liquid interpolation');
    return;
  }

  // Build Delaunay triangulation in (logP, u) space
  buildCLTriangulation();

  // Build spatial index for fast lookup
  buildCLSpatialIndex();

  clDataReady = true;
}

/**
 * Build Delaunay triangulation for compressed liquid points in (logP, u) space.
 * Uses Bowyer-Watson algorithm (same approach as main triangulation).
 */
function buildCLTriangulation(): void {
  if (clPoints.length < 3) return;

  // Get bounds in (logP, u) space
  let minLogP = Infinity, maxLogP = -Infinity;
  let minU = Infinity, maxU = -Infinity;

  for (const pt of clPoints) {
    minLogP = Math.min(minLogP, pt.logP);
    maxLogP = Math.max(maxLogP, pt.logP);
    minU = Math.min(minU, pt.u);
    maxU = Math.max(maxU, pt.u);
  }

  // Add padding
  const dLogP = maxLogP - minLogP;
  const dU = maxU - minU;
  minLogP -= dLogP * 0.5;
  maxLogP += dLogP * 0.5;
  minU -= dU * 0.5;
  maxU += dU * 0.5;

  // Create super-triangle vertices (temporary)
  const superA: CompressedLiquidPoint = {
    logP: minLogP - dLogP, u: minU - dU * 2, rho: 0, idx: -1
  };
  const superB: CompressedLiquidPoint = {
    logP: maxLogP + dLogP, u: minU - dU * 2, rho: 0, idx: -1
  };
  const superC: CompressedLiquidPoint = {
    logP: (minLogP + maxLogP) / 2, u: maxU + dU * 2, rho: 0, idx: -1
  };

  // Add super triangle vertices temporarily
  const n = clPoints.length;
  clPoints.push(superA, superB, superC);

  // Start with super-triangle
  clTriangles = [{ i: n, j: n + 1, k: n + 2 }];

  // Insert each point using Bowyer-Watson
  for (let p = 0; p < n; p++) {
    const pt = clPoints[p];
    insertCLPoint(p, pt.logP, pt.u);
  }

  // Remove triangles that contain super-triangle vertices
  clTriangles = clTriangles.filter(t =>
    t.i < n && t.j < n && t.k < n
  );

  // Remove super-triangle vertices
  clPoints.splice(n, 3);
}

/**
 * Insert a point into the compressed liquid triangulation (Bowyer-Watson).
 */
function insertCLPoint(pIdx: number, x: number, y: number): void {
  // Find triangles whose circumcircle contains the point
  const badTriangles: number[] = [];

  for (let i = 0; i < clTriangles.length; i++) {
    if (inCLCircumcircle(clTriangles[i], x, y)) {
      badTriangles.push(i);
    }
  }

  // Find boundary edges of the cavity
  const polygon: [number, number][] = [];

  for (const tIdx of badTriangles) {
    const t = clTriangles[tIdx];
    const edges: [number, number][] = [
      [t.i, t.j],
      [t.j, t.k],
      [t.k, t.i],
    ];

    for (const [a, b] of edges) {
      let shared = false;
      for (const otherIdx of badTriangles) {
        if (otherIdx === tIdx) continue;
        const other = clTriangles[otherIdx];
        if (hasCLEdge(other, a, b)) {
          shared = true;
          break;
        }
      }
      if (!shared) {
        polygon.push([a, b]);
      }
    }
  }

  // Remove bad triangles (in reverse order)
  badTriangles.sort((a, b) => b - a);
  for (const idx of badTriangles) {
    clTriangles.splice(idx, 1);
  }

  // Create new triangles
  for (const [a, b] of polygon) {
    clTriangles.push({ i: a, j: b, k: pIdx });
  }
}

function inCLCircumcircle(t: Triangle, x: number, y: number): boolean {
  const ax = clPoints[t.i].logP;
  const ay = clPoints[t.i].u;
  const bx = clPoints[t.j].logP;
  const by = clPoints[t.j].u;
  const cx = clPoints[t.k].logP;
  const cy = clPoints[t.k].u;

  // Normalize u to similar scale as logP for numerical stability
  const uScale = 1e-6;
  const nay = ay * uScale;
  const nby = by * uScale;
  const ncy = cy * uScale;
  const ny = y * uScale;

  const d = 2 * (ax * (nby - ncy) + bx * (ncy - nay) + cx * (nay - nby));
  if (Math.abs(d) < 1e-20) return false;

  const ax2 = ax * ax + nay * nay;
  const bx2 = bx * bx + nby * nby;
  const cx2 = cx * cx + ncy * ncy;

  const ux = (ax2 * (nby - ncy) + bx2 * (ncy - nay) + cx2 * (nay - nby)) / d;
  const uy = (ax2 * (cx - bx) + bx2 * (ax - cx) + cx2 * (bx - ax)) / d;

  const r2 = (ax - ux) * (ax - ux) + (nay - uy) * (nay - uy);
  const d2 = (x - ux) * (x - ux) + (ny - uy) * (ny - uy);

  return d2 < r2 * 1.0001;
}

function hasCLEdge(t: Triangle, a: number, b: number): boolean {
  const edges: [number, number][] = [
    [t.i, t.j], [t.j, t.i],
    [t.j, t.k], [t.k, t.j],
    [t.k, t.i], [t.i, t.k],
  ];
  return edges.some(([x, y]) => x === a && y === b);
}

/**
 * Build spatial index for compressed liquid triangulation.
 */
function buildCLSpatialIndex(): void {
  if (clTriangles.length === 0 || clPoints.length === 0) return;

  // Find bounds
  let minLP = Infinity, maxLP = -Infinity;
  let minU_val = Infinity, maxU_val = -Infinity;

  for (const pt of clPoints) {
    minLP = Math.min(minLP, pt.logP);
    maxLP = Math.max(maxLP, pt.logP);
    minU_val = Math.min(minU_val, pt.u);
    maxU_val = Math.max(maxU_val, pt.u);
  }

  // Add small padding
  const padLP = (maxLP - minLP) * 0.01;
  const padU = (maxU_val - minU_val) * 0.01;
  clGridMinLogP = minLP - padLP;
  clGridMaxLogP = maxLP + padLP;
  clGridMinU = minU_val - padU;
  clGridMaxU = maxU_val + padU;

  // Grid size
  clGridCellsX = 50;
  clGridCellsY = 50;
  clGridCellWidth = (clGridMaxLogP - clGridMinLogP) / clGridCellsX;
  clGridCellHeight = (clGridMaxU - clGridMinU) / clGridCellsY;

  // Initialize grid
  clGrid = [];
  for (let i = 0; i < clGridCellsX; i++) {
    clGrid[i] = [];
    for (let j = 0; j < clGridCellsY; j++) {
      clGrid[i][j] = { triangleIndices: [] };
    }
  }

  // Populate grid with triangles
  for (let tIdx = 0; tIdx < clTriangles.length; tIdx++) {
    const t = clTriangles[tIdx];
    const p0 = clPoints[t.i];
    const p1 = clPoints[t.j];
    const p2 = clPoints[t.k];

    const triMinLP = Math.min(p0.logP, p1.logP, p2.logP);
    const triMaxLP = Math.max(p0.logP, p1.logP, p2.logP);
    const triMinU = Math.min(p0.u, p1.u, p2.u);
    const triMaxU = Math.max(p0.u, p1.u, p2.u);

    const minCellX = Math.max(0, Math.floor((triMinLP - clGridMinLogP) / clGridCellWidth));
    const maxCellX = Math.min(clGridCellsX - 1, Math.floor((triMaxLP - clGridMinLogP) / clGridCellWidth));
    const minCellY = Math.max(0, Math.floor((triMinU - clGridMinU) / clGridCellHeight));
    const maxCellY = Math.min(clGridCellsY - 1, Math.floor((triMaxU - clGridMinU) / clGridCellHeight));

    for (let i = minCellX; i <= maxCellX; i++) {
      for (let j = minCellY; j <= maxCellY; j++) {
        clGrid[i][j].triangleIndices.push(tIdx);
      }
    }
  }
}

/**
 * Look up compressed liquid density given pressure and internal energy.
 * Returns null if the point is outside the interpolation domain.
 *
 * @param P - Pressure in Pa
 * @param u - Specific internal energy in J/kg
 * @returns Density in kg/m³, or null if outside domain
 */
export function lookupCompressedLiquidDensity(P: number, u: number): number | null {
  if (!clDataReady) {
    throw new Error('[FATAL] lookupCompressedLiquidDensity called before compressed liquid data is loaded. This should not happen.');
  }
  if (clPoints.length === 0) {
    throw new Error('[FATAL] Compressed liquid data has no points. Check that compressed-liquid-table.txt loaded correctly.');
  }
  if (clTriangles.length === 0) {
    throw new Error('[FATAL] Compressed liquid triangulation has no triangles. buildCLTriangulation() may have failed.');
  }
  if (clGrid.length === 0) {
    throw new Error('[FATAL] Compressed liquid spatial index not built. buildCLSpatialIndex() may have failed.');
  }

  const logP = Math.log10(P);

  // Find containing triangle using grid lookup
  const cellX = Math.floor((logP - clGridMinLogP) / clGridCellWidth);
  const cellY = Math.floor((u - clGridMinU) / clGridCellHeight);

  if (cellX < 0 || cellX >= clGridCellsX || cellY < 0 || cellY >= clGridCellsY) {
    return null;  // Outside grid bounds
  }

  // Verify grid cell exists (should always be true if grid was built correctly)
  if (!clGrid[cellX] || !clGrid[cellX][cellY]) {
    throw new Error(`[FATAL] Compressed liquid grid cell [${cellX}][${cellY}] is undefined. ` +
      `Grid dimensions: ${clGrid.length}x${clGrid[0]?.length ?? 0}, expected ${clGridCellsX}x${clGridCellsY}. ` +
      `Query: P=${P.toExponential(3)} Pa (logP=${logP.toFixed(3)}), u=${u.toFixed(0)} J/kg. ` +
      `Grid bounds: logP=[${clGridMinLogP.toFixed(3)}, ${clGridMaxLogP.toFixed(3)}], u=[${clGridMinU.toFixed(0)}, ${clGridMaxU.toFixed(0)}]`);
  }

  // Search triangles in this cell
  const candidates = clGrid[cellX][cellY].triangleIndices;
  let foundTriangle: Triangle | null = null;

  for (const tIdx of candidates) {
    if (pointInCLTriangle(logP, u, clTriangles[tIdx])) {
      foundTriangle = clTriangles[tIdx];
      break;
    }
  }

  if (!foundTriangle) {
    // Fallback: linear search (for edge cases)
    for (const t of clTriangles) {
      if (pointInCLTriangle(logP, u, t)) {
        foundTriangle = t;
        break;
      }
    }
  }

  if (!foundTriangle) {
    return null;  // Point not in any triangle
  }

  // Interpolate density using barycentric coordinates
  const p0 = clPoints[foundTriangle.i];
  const p1 = clPoints[foundTriangle.j];
  const p2 = clPoints[foundTriangle.k];

  const denom = (p1.u - p2.u) * (p0.logP - p2.logP) + (p2.logP - p1.logP) * (p0.u - p2.u);
  if (Math.abs(denom) < 1e-20) {
    // Degenerate triangle - return average
    return (p0.rho + p1.rho + p2.rho) / 3;
  }

  const w0 = ((p1.u - p2.u) * (logP - p2.logP) + (p2.logP - p1.logP) * (u - p2.u)) / denom;
  const w1 = ((p2.u - p0.u) * (logP - p2.logP) + (p0.logP - p2.logP) * (u - p2.u)) / denom;
  const w2 = 1 - w0 - w1;

  return w0 * p0.rho + w1 * p1.rho + w2 * p2.rho;
}

function pointInCLTriangle(logP: number, u: number, t: Triangle): boolean {
  const x1 = clPoints[t.i].logP;
  const y1 = clPoints[t.i].u;
  const x2 = clPoints[t.j].logP;
  const y2 = clPoints[t.j].u;
  const x3 = clPoints[t.k].logP;
  const y3 = clPoints[t.k].u;

  const denom = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3);
  if (Math.abs(denom) < 1e-20) return false;

  const a = ((y2 - y3) * (logP - x3) + (x3 - x2) * (u - y3)) / denom;
  const b = ((y3 - y1) * (logP - x3) + (x1 - x3) * (u - y3)) / denom;
  const c = 1 - a - b;

  return a >= -0.001 && b >= -0.001 && c >= -0.001;
}

// ============================================================================
// Liquid-Only (V,u)->P Interpolation Functions
// ============================================================================

/**
 * Build the liquid-only (logV, u) -> P triangulation.
 * This is used for round-trip verification and avoids triangles spanning the dome.
 */
function buildLiquidVUInterpolation(): void {
  // Filter for liquid-phase points only
  lvuPoints = [];
  for (let i = 0; i < dataPoints.length; i++) {
    const pt = dataPoints[i];
    if (pt.phase === 'liquid' || pt.phase === 'saturated liquid') {
      lvuPoints.push({
        logV: pt.logV,
        u: pt.u,
        P: pt.P,
        idx: i,
      });
    }
  }

  if (lvuPoints.length < 3) {
    console.warn('[WaterProps v3] Not enough liquid points for (V,u)->P interpolation');
    return;
  }

  // Build Delaunay triangulation in (logV, u) space
  buildLVUTriangulation();

  // Build spatial index
  buildLVUSpatialIndex();

  lvuDataReady = true;
  console.log(`[WaterProps v3 OPTIMIZED] Liquid (V,u)->P: ${lvuPoints.length} points, ${lvuTriangles.length} triangles`);
}

/**
 * Build Delaunay triangulation for liquid points in (logV, u) space.
 */
function buildLVUTriangulation(): void {
  if (lvuPoints.length < 3) return;

  // Get bounds
  let minLogV = Infinity, maxLogV = -Infinity;
  let minU = Infinity, maxU = -Infinity;

  for (const pt of lvuPoints) {
    minLogV = Math.min(minLogV, pt.logV);
    maxLogV = Math.max(maxLogV, pt.logV);
    minU = Math.min(minU, pt.u);
    maxU = Math.max(maxU, pt.u);
  }

  // Add padding
  const dLogV = maxLogV - minLogV;
  const dU = maxU - minU;
  minLogV -= dLogV * 0.5;
  maxLogV += dLogV * 0.5;
  minU -= dU * 0.5;
  maxU += dU * 0.5;

  // Super-triangle vertices
  const superA: LiquidVUPoint = { logV: minLogV - dLogV, u: minU - dU * 2, P: 0, idx: -1 };
  const superB: LiquidVUPoint = { logV: maxLogV + dLogV, u: minU - dU * 2, P: 0, idx: -1 };
  const superC: LiquidVUPoint = { logV: (minLogV + maxLogV) / 2, u: maxU + dU * 2, P: 0, idx: -1 };

  const n = lvuPoints.length;
  lvuPoints.push(superA, superB, superC);

  lvuTriangles = [{ i: n, j: n + 1, k: n + 2 }];

  // Insert each point using Bowyer-Watson
  for (let p = 0; p < n; p++) {
    const pt = lvuPoints[p];
    insertLVUPoint(p, pt.logV, pt.u);
  }

  // Remove triangles with super-triangle vertices
  lvuTriangles = lvuTriangles.filter(t => t.i < n && t.j < n && t.k < n);

  // Remove super-triangle vertices
  lvuPoints.splice(n, 3);
}

/**
 * Insert point into LVU triangulation using Bowyer-Watson.
 */
function insertLVUPoint(pIdx: number, x: number, y: number): void {
  const badTriangles: number[] = [];

  // Find all triangles whose circumcircle contains the point
  for (let i = 0; i < lvuTriangles.length; i++) {
    const t = lvuTriangles[i];
    if (inLVUCircumcircle(x, y, t)) {
      badTriangles.push(i);
    }
  }

  // Find boundary edges
  const edges: Array<[number, number]> = [];
  for (const tIdx of badTriangles) {
    const t = lvuTriangles[tIdx];
    const triEdges: Array<[number, number]> = [[t.i, t.j], [t.j, t.k], [t.k, t.i]];
    for (const [a, b] of triEdges) {
      // Check if edge is shared with another bad triangle
      let isShared = false;
      for (const otherIdx of badTriangles) {
        if (otherIdx === tIdx) continue;
        const ot = lvuTriangles[otherIdx];
        const hasEdge =
          (ot.i === a && ot.j === b) || (ot.j === a && ot.k === b) || (ot.k === a && ot.i === b) ||
          (ot.i === b && ot.j === a) || (ot.j === b && ot.k === a) || (ot.k === b && ot.i === a);
        if (hasEdge) {
          isShared = true;
          break;
        }
      }
      if (!isShared) {
        edges.push([a, b]);
      }
    }
  }

  // Remove bad triangles (in reverse order to maintain indices)
  badTriangles.sort((a, b) => b - a);
  for (const idx of badTriangles) {
    lvuTriangles.splice(idx, 1);
  }

  // Create new triangles
  for (const [a, b] of edges) {
    lvuTriangles.push({ i: a, j: b, k: pIdx });
  }
}

/**
 * Check if point is in circumcircle of LVU triangle.
 */
function inLVUCircumcircle(px: number, py: number, t: Triangle): boolean {
  const ax = lvuPoints[t.i].logV;
  const ay = lvuPoints[t.i].u;
  const bx = lvuPoints[t.j].logV;
  const by = lvuPoints[t.j].u;
  const cx = lvuPoints[t.k].logV;
  const cy = lvuPoints[t.k].u;

  // Scale u down for better numerical stability
  const uScale = 1e-6;
  const ay_s = ay * uScale;
  const by_s = by * uScale;
  const cy_s = cy * uScale;
  const py_s = py * uScale;

  const ax_sq = ax * ax + ay_s * ay_s;
  const bx_sq = bx * bx + by_s * by_s;
  const cx_sq = cx * cx + cy_s * cy_s;
  const px_sq = px * px + py_s * py_s;

  const det =
    (ax - px) * ((by_s - py_s) * (cx_sq - px_sq) - (bx_sq - px_sq) * (cy_s - py_s)) -
    (ay_s - py_s) * ((bx - px) * (cx_sq - px_sq) - (bx_sq - px_sq) * (cx - px)) +
    (ax_sq - px_sq) * ((bx - px) * (cy_s - py_s) - (by_s - py_s) * (cx - px));

  // Orientation of triangle
  const orient = (bx - ax) * (cy_s - ay_s) - (by_s - ay_s) * (cx - ax);

  return orient > 0 ? det > 0 : det < 0;
}

/**
 * Build spatial index for LVU triangulation.
 */
function buildLVUSpatialIndex(): void {
  if (lvuTriangles.length === 0) return;

  // Find bounds
  let minLogV = Infinity, maxLogV = -Infinity;
  let minU = Infinity, maxU = -Infinity;

  for (const pt of lvuPoints) {
    minLogV = Math.min(minLogV, pt.logV);
    maxLogV = Math.max(maxLogV, pt.logV);
    minU = Math.min(minU, pt.u);
    maxU = Math.max(maxU, pt.u);
  }

  // Add padding
  const padLogV = (maxLogV - minLogV) * 0.01 + 0.01;
  const padU = (maxU - minU) * 0.01 + 1000;
  lvuGridMinLogV = minLogV - padLogV;
  lvuGridMaxLogV = maxLogV + padLogV;
  lvuGridMinU = minU - padU;
  lvuGridMaxU = maxU + padU;

  lvuGridCellsX = 50;
  lvuGridCellsY = 50;
  lvuGridCellWidth = (lvuGridMaxLogV - lvuGridMinLogV) / lvuGridCellsX;
  lvuGridCellHeight = (lvuGridMaxU - lvuGridMinU) / lvuGridCellsY;

  // Initialize grid
  lvuGrid = [];
  for (let i = 0; i < lvuGridCellsX; i++) {
    lvuGrid[i] = [];
    for (let j = 0; j < lvuGridCellsY; j++) {
      lvuGrid[i][j] = { triangleIndices: [] };
    }
  }

  // Populate grid
  for (let tIdx = 0; tIdx < lvuTriangles.length; tIdx++) {
    const t = lvuTriangles[tIdx];
    const p0 = lvuPoints[t.i];
    const p1 = lvuPoints[t.j];
    const p2 = lvuPoints[t.k];

    const triMinLV = Math.min(p0.logV, p1.logV, p2.logV);
    const triMaxLV = Math.max(p0.logV, p1.logV, p2.logV);
    const triMinU = Math.min(p0.u, p1.u, p2.u);
    const triMaxU = Math.max(p0.u, p1.u, p2.u);

    const minCellX = Math.max(0, Math.floor((triMinLV - lvuGridMinLogV) / lvuGridCellWidth));
    const maxCellX = Math.min(lvuGridCellsX - 1, Math.floor((triMaxLV - lvuGridMinLogV) / lvuGridCellWidth));
    const minCellY = Math.max(0, Math.floor((triMinU - lvuGridMinU) / lvuGridCellHeight));
    const maxCellY = Math.min(lvuGridCellsY - 1, Math.floor((triMaxU - lvuGridMinU) / lvuGridCellHeight));

    for (let i = minCellX; i <= maxCellX; i++) {
      for (let j = minCellY; j <= maxCellY; j++) {
        lvuGrid[i][j].triangleIndices.push(tIdx);
      }
    }
  }
}

/**
 * Look up pressure from (u, v) using liquid-only triangulation.
 * This avoids triangles that span from liquid to vapor.
 *
 * @param u - Specific internal energy (J/kg)
 * @param v - Specific volume (m³/kg)
 * @returns Pressure in Pa, or null if outside liquid domain
 */
export function lookupPressureFromUV_LiquidOnly(u: number, v: number): number | null {
  if (!lvuDataReady || lvuPoints.length === 0) {
    return null;
  }

  if (v <= 0 || !isFinite(u) || !isFinite(v)) {
    return null;
  }

  const logV = Math.log10(v);

  // Grid lookup
  const cellX = Math.floor((logV - lvuGridMinLogV) / lvuGridCellWidth);
  const cellY = Math.floor((u - lvuGridMinU) / lvuGridCellHeight);

  if (cellX < 0 || cellX >= lvuGridCellsX || cellY < 0 || cellY >= lvuGridCellsY) {
    return null;
  }

  // Search triangles in cell
  const candidates = lvuGrid[cellX][cellY].triangleIndices;
  let foundTriangle: Triangle | null = null;

  for (const tIdx of candidates) {
    if (pointInLVUTriangle(logV, u, lvuTriangles[tIdx])) {
      foundTriangle = lvuTriangles[tIdx];
      break;
    }
  }

  if (!foundTriangle) {
    // Fallback: linear search
    for (const t of lvuTriangles) {
      if (pointInLVUTriangle(logV, u, t)) {
        foundTriangle = t;
        break;
      }
    }
  }

  if (!foundTriangle) {
    return null;
  }

  // Interpolate pressure
  const p0 = lvuPoints[foundTriangle.i];
  const p1 = lvuPoints[foundTriangle.j];
  const p2 = lvuPoints[foundTriangle.k];

  const denom = (p1.u - p2.u) * (p0.logV - p2.logV) + (p2.logV - p1.logV) * (p0.u - p2.u);
  if (Math.abs(denom) < 1e-20) {
    return (p0.P + p1.P + p2.P) / 3;
  }

  const w0 = ((p1.u - p2.u) * (logV - p2.logV) + (p2.logV - p1.logV) * (u - p2.u)) / denom;
  const w1 = ((p2.u - p0.u) * (logV - p2.logV) + (p0.logV - p2.logV) * (u - p2.u)) / denom;
  const w2 = 1 - w0 - w1;

  return w0 * p0.P + w1 * p1.P + w2 * p2.P;
}

function pointInLVUTriangle(logV: number, u: number, t: Triangle): boolean {
  const x1 = lvuPoints[t.i].logV;
  const y1 = lvuPoints[t.i].u;
  const x2 = lvuPoints[t.j].logV;
  const y2 = lvuPoints[t.j].u;
  const x3 = lvuPoints[t.k].logV;
  const y3 = lvuPoints[t.k].u;

  const denom = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3);
  if (Math.abs(denom) < 1e-20) return false;

  const a = ((y2 - y3) * (logV - x3) + (x3 - x2) * (u - y3)) / denom;
  const b = ((y3 - y1) * (logV - x3) + (x1 - x3) * (u - y3)) / denom;
  const c = 1 - a - b;

  return a >= -0.001 && b >= -0.001 && c >= -0.001;
}

// ============================================================================
// Data Loading
// ============================================================================

function loadData(): void {
  if (dataLoaded) return;

  console.log('[WaterProps v3] Building spatial index...');

  try {
    let content = steamTableContent;

    // Detect environment
    const isBrowser = typeof window !== 'undefined';

    // Load steam table based on environment
    if (!content) {
      if (isBrowser) {
        // Browser: use synchronous XHR (not ideal but works for initialization)
        // The steam table should be in the public folder for Vite to serve
        const xhr = new XMLHttpRequest();
        xhr.open('GET', '/steam-table.txt', false); // false = synchronous
        xhr.send();
        if (xhr.status === 200) {
          content = xhr.responseText;
        } else {
          throw new Error(`Failed to fetch steam table: HTTP ${xhr.status}`);
        }
      } else {
        // Node.js: use pre-loaded fs module
        if (!nodeFs || !nodePath || !nodeUrl) {
          throw new Error('Node.js modules not loaded - ensure top-level await completed');
        }
        try {
          const __filename = nodeUrl.fileURLToPath(import.meta.url);
          const __dirname = nodePath.dirname(__filename);
          const steamTablePath = nodePath.resolve(__dirname, '../../steam-table.txt');
          content = nodeFs.readFileSync(steamTablePath, 'utf-8');
        } catch (err) {
          throw new Error(`Failed to load steam table: ${err}`);
        }
      }
    }

    if (!content) {
      throw new Error('Failed to load steam table data');
    }

    const lines = content.trim().split('\n');

    // Parse all data points
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split('\t');
      if (parts.length < 8) continue;

      const P_MPa = parseFloat(parts[0]);
      const T_C = parseFloat(parts[1]);
      const v_m3kg = parseFloat(parts[2]);
      const u_kJkg = parseFloat(parts[3]);
      const phase = parts[6];

      if (isNaN(P_MPa) || isNaN(T_C) || isNaN(v_m3kg) || isNaN(u_kJkg)) continue;
      if (v_m3kg <= 0) continue;

      const P_Pa = P_MPa * 1e6;
      dataPoints.push({
        P: P_Pa,                  // Pa
        T: T_C + 273.15,          // Convert to K
        v: v_m3kg,
        u: u_kJkg * 1000,         // Convert to J/kg
        logV: Math.log10(v_m3kg),
        logP: Math.log10(P_Pa),   // For (P,u)->rho interpolation
        phase: phase.toLowerCase(),
      });
    }

    // Extract saturation pairs
    extractSaturationPairs();

    // Add interpolated saturation curve points to fill triangulation gaps
    addInterpolatedSaturationPoints();

    // Add interpolated compressed liquid points along isobars to fill gaps
    addInterpolatedCompressedLiquidPoints();

    // Build Delaunay triangulation
    console.time("[WaterProps] buildTriangulation");

    buildTriangulation();

    console.timeEnd("[WaterProps] buildTriangulation");

    // Build spatial index for fast lookup
    console.time("[WaterProps] buildSpatialIndex");

    buildSpatialIndex();

    console.timeEnd("[WaterProps] buildSpatialIndex");

    // Build phase detection caches
    // Load detailed saturated steam table for more accurate dome boundary
    loadDetailedSaturationTable();

    console.time("[WaterProps] buildPhaseDetectionCaches");

    buildPhaseDetectionCaches();

    console.timeEnd("[WaterProps] buildPhaseDetectionCaches");

    // Build compressed liquid (P,u)->rho interpolation
    console.time("[WaterProps] buildCompressedLiquidInterpolation");

    buildCompressedLiquidInterpolation();

    console.timeEnd("[WaterProps] buildCompressedLiquidInterpolation");

    // Build liquid-only (V,u)->P interpolation for round-trip verification
    console.time("[WaterProps] buildLiquidVUInterpolation");

    buildLiquidVUInterpolation();

    console.timeEnd("[WaterProps] buildLiquidVUInterpolation");

    console.log(`[WaterProps v3 OPTIMIZED] Loaded ${dataPoints.length} data points`);
    console.log(`[WaterProps v3 OPTIMIZED] Built ${triangles.length} triangles`);
    console.log(`[WaterProps v3 OPTIMIZED] Found ${saturationPairs.length} saturation pairs`);
    console.log(`[WaterProps v3 OPTIMIZED] Spatial index: ${gridCellsX}x${gridCellsY} grid`);
    console.log(`[WaterProps v3 OPTIMIZED] Compressed liquid: ${clPoints.length} points, ${clTriangles.length} triangles`);

    dataLoaded = true;
  } catch (e) {
    console.error('[WaterProps v3] Failed to load steam table:', e);
    dataLoaded = true; // Prevent repeated attempts
  }
}

function extractSaturationPairs(): void {
  // Group saturation points by pressure
  const satLiquid = new Map<number, DataPoint>();
  const satVapor = new Map<number, DataPoint>();

  for (const pt of dataPoints) {
    // Round pressure to 4 decimal places in MPa for matching
    const P_key = Math.round(pt.P / 100) * 100;

    if (pt.phase === 'saturated liquid') {
      satLiquid.set(P_key, pt);
    } else if (pt.phase === 'saturated vapor') {
      satVapor.set(P_key, pt);
    }
  }

  // Match pairs
  for (const [P_key, liq] of satLiquid) {
    const vap = satVapor.get(P_key);
    if (vap) {
      saturationPairs.push({
        P: (liq.P + vap.P) / 2,
        T: (liq.T + vap.T) / 2,
        v_f: liq.v,
        v_g: vap.v,
        u_f: liq.u,
        u_g: vap.u,
      });
    }
  }

  // Sort by pressure
  saturationPairs.sort((a, b) => a.P - b.P);
}

/**
 * Add interpolated saturation curve points to fill triangulation gaps.
 *
 * The steam table has saturation data at discrete pressures, which can leave
 * gaps in the triangulation near the saturation curve. This function adds
 * interpolated saturation points at finer pressure intervals to ensure
 * the triangulation covers the region just above the saturation curve.
 */
function addInterpolatedSaturationPoints(): void {
  if (saturationPairs.length < 2) return;

  const newPoints: DataPoint[] = [];

  // Add interpolated points between each pair of saturation points
  // Focus on the high-pressure region (P > 100 bar) where the curve is steep
  for (let i = 0; i < saturationPairs.length - 1; i++) {
    const sat1 = saturationPairs[i];
    const sat2 = saturationPairs[i + 1];

    // Calculate pressure step - use finer steps at high pressure
    const P_avg = (sat1.P + sat2.P) / 2;
    const P_diff = sat2.P - sat1.P;

    // Skip if points are already close together
    if (P_diff < 0.5e6) continue; // Less than 5 bar apart

    // Determine number of interpolation points based on pressure range
    // Use finer interpolation at high pressure where the saturation curve is steep
    let numInterp: number;
    if (P_avg > 16e6) {
      // Very high pressure (>160 bar): finest interpolation - every 2.5 bar
      numInterp = Math.ceil(P_diff / 0.25e6);
    } else if (P_avg > 15e6) {
      // High pressure (150-160 bar): fine interpolation - every 5 bar
      numInterp = Math.ceil(P_diff / 0.5e6);
    } else if (P_avg > 10e6) {
      // Medium-high pressure (100-150 bar): every 10 bar
      numInterp = Math.min(5, Math.ceil(P_diff / 1e6));
    } else {
      // Lower pressure: coarser interpolation - every 20 bar
      numInterp = Math.min(3, Math.ceil(P_diff / 2e6));
    }

    if (numInterp < 1) continue;

    // Add interpolated saturated liquid points
    for (let j = 1; j <= numInterp; j++) {
      const t = j / (numInterp + 1);
      // Linear interpolation in (log(v), u) space - this produces a straight line
      // in the triangulation's coordinate system and a more convex curve in (v, u) space
      const P_interp = sat1.P + t * (sat2.P - sat1.P);
      const T_interp = sat1.T + t * (sat2.T - sat1.T);
      const logV_f_interp = Math.log10(sat1.v_f) + t * (Math.log10(sat2.v_f) - Math.log10(sat1.v_f));
      const v_f_interp = Math.pow(10, logV_f_interp);
      const u_f_interp = sat1.u_f + t * (sat2.u_f - sat1.u_f);

      // Add saturated liquid point
      newPoints.push({
        P: P_interp,
        T: T_interp,
        v: v_f_interp,
        u: u_f_interp,
        logV: logV_f_interp,
        logP: Math.log10(P_interp),
        phase: 'saturated liquid',
      });

      // Also add saturated vapor point (also interpolate in log space)
      const logV_g_interp = Math.log10(sat1.v_g) + t * (Math.log10(sat2.v_g) - Math.log10(sat1.v_g));
      const v_g_interp = Math.pow(10, logV_g_interp);
      const u_g_interp = sat1.u_g + t * (sat2.u_g - sat1.u_g);

      newPoints.push({
        P: P_interp,
        T: T_interp,
        v: v_g_interp,
        u: u_g_interp,
        logV: Math.log10(v_g_interp),
        logP: Math.log10(P_interp),
        phase: 'saturated vapor',
      });
    }
  }

  // Add the new points to the data set
  if (newPoints.length > 0) {
    dataPoints.push(...newPoints);
    console.log(`[WaterProps v3] Added ${newPoints.length} interpolated saturation points`);
  }

  // ALSO add interpolated saturation pairs for phase detection
  // This ensures phase detection uses the same fine resolution as triangulation
  const newPairs: SaturationPair[] = [];
  for (let i = 0; i < saturationPairs.length - 1; i++) {
    const sat1 = saturationPairs[i];
    const sat2 = saturationPairs[i + 1];

    const P_avg = (sat1.P + sat2.P) / 2;
    const P_diff = sat2.P - sat1.P;

    if (P_diff < 0.5e6) continue;

    let numInterp: number;
    if (P_avg > 16e6) {
      numInterp = Math.ceil(P_diff / 0.25e6);
    } else if (P_avg > 15e6) {
      numInterp = Math.ceil(P_diff / 0.5e6);
    } else if (P_avg > 10e6) {
      numInterp = Math.min(5, Math.ceil(P_diff / 1e6));
    } else {
      numInterp = Math.min(3, Math.ceil(P_diff / 2e6));
    }

    if (numInterp < 1) continue;

    for (let j = 1; j <= numInterp; j++) {
      const t = j / (numInterp + 1);
      const P_interp = sat1.P + t * (sat2.P - sat1.P);
      const T_interp = sat1.T + t * (sat2.T - sat1.T);

      // Interpolate v in log space for consistency
      const logV_f_interp = Math.log10(sat1.v_f) + t * (Math.log10(sat2.v_f) - Math.log10(sat1.v_f));
      const logV_g_interp = Math.log10(sat1.v_g) + t * (Math.log10(sat2.v_g) - Math.log10(sat1.v_g));
      const v_f_interp = Math.pow(10, logV_f_interp);
      const v_g_interp = Math.pow(10, logV_g_interp);
      const u_f_interp = sat1.u_f + t * (sat2.u_f - sat1.u_f);
      const u_g_interp = sat1.u_g + t * (sat2.u_g - sat1.u_g);

      newPairs.push({
        P: P_interp,
        T: T_interp,
        v_f: v_f_interp,
        v_g: v_g_interp,
        u_f: u_f_interp,
        u_g: u_g_interp,
      });
    }
  }

  if (newPairs.length > 0) {
    saturationPairs.push(...newPairs);
    saturationPairs.sort((a, b) => a.P - b.P);
    console.log(`[WaterProps v3] Added ${newPairs.length} interpolated saturation pairs for phase detection`);
  }
}

/**
 * Add interpolated compressed liquid points along isobars to fill triangulation gaps.
 *
 * The steam table has data at discrete temperatures for each pressure. In (logV, u) space,
 * consecutive temperature points along an isobar can be far apart, leaving triangulation gaps.
 * This function adds interpolated points between consecutive temperature steps on each isobar.
 */
function addInterpolatedCompressedLiquidPoints(): void {
  // Group liquid points by pressure
  const liquidByPressure = new Map<number, DataPoint[]>();

  for (const pt of dataPoints) {
    if (pt.phase !== 'liquid') continue;

    // Round pressure to group nearby values (within 0.1%)
    const P_key = Math.round(pt.P / 1000) * 1000;

    if (!liquidByPressure.has(P_key)) {
      liquidByPressure.set(P_key, []);
    }
    liquidByPressure.get(P_key)!.push(pt);
  }

  const newPoints: DataPoint[] = [];

  // For each pressure level, sort by temperature and interpolate between consecutive points
  for (const [, points] of liquidByPressure) {
    if (points.length < 2) continue;

    // Sort by temperature (which correlates with u for liquid)
    points.sort((a, b) => a.T - b.T);

    // Interpolate between consecutive points
    for (let i = 0; i < points.length - 1; i++) {
      const pt1 = points[i];
      const pt2 = points[i + 1];

      // Calculate the gap in u (internal energy)
      const dU = Math.abs(pt2.u - pt1.u);

      // Normalize to similar scales (logV is ~0.001 range, u is ~10000 J/kg range)
      // Use a threshold based on energy gap - if dU > 20 kJ/kg, add interpolation
      const dU_kJ = dU / 1000;

      // Determine number of interpolation points based on gap size
      // Be conservative to avoid adding too many points (impacts triangulation performance)
      let numInterp = 0;
      if (dU_kJ > 60) {
        numInterp = Math.min(3, Math.floor(dU_kJ / 25)); // One point per 25 kJ/kg, max 3
      } else if (dU_kJ > 30) {
        numInterp = 1;
      }
      // Skip smaller gaps - they don't cause major triangulation issues

      if (numInterp < 1) continue;

      // Add interpolated points
      for (let j = 1; j <= numInterp; j++) {
        const t = j / (numInterp + 1);

        // Interpolate linearly in (log(v), u) space for consistency with saturation interpolation
        // This ensures interpolated points form straight lines in the triangulation's coordinate system
        const T_interp = pt1.T + t * (pt2.T - pt1.T);
        const logV_interp = Math.log10(pt1.v) + t * (Math.log10(pt2.v) - Math.log10(pt1.v));
        const v_interp = Math.pow(10, logV_interp);
        const u_interp = pt1.u + t * (pt2.u - pt1.u);
        const P_interp = pt1.P + t * (pt2.P - pt1.P); // Should be ~same for isobar

        newPoints.push({
          P: P_interp,
          T: T_interp,
          v: v_interp,
          u: u_interp,
          logV: logV_interp,
          logP: Math.log10(P_interp),
          phase: 'liquid',
        });
      }
    }
  }

  // Add the new points to the data set
  if (newPoints.length > 0) {
    dataPoints.push(...newPoints);
    console.log(`[WaterProps v3] Added ${newPoints.length} interpolated compressed liquid points`);
  }
}

// ============================================================================
// Delaunay Triangulation (Bowyer-Watson algorithm)
// ============================================================================

function buildTriangulation(): void {
  if (dataPoints.length < 3) return;

  // Get bounds in (logV, u) space
  let minLogV = Infinity, maxLogV = -Infinity;
  let minU = Infinity, maxU = -Infinity;

  for (const pt of dataPoints) {
    minLogV = Math.min(minLogV, pt.logV);
    maxLogV = Math.max(maxLogV, pt.logV);
    minU = Math.min(minU, pt.u);
    maxU = Math.max(maxU, pt.u);
  }

  // Add padding
  const dLogV = maxLogV - minLogV;
  const dU = maxU - minU;
  minLogV -= dLogV * 0.5;
  maxLogV += dLogV * 0.5;
  minU -= dU * 0.5;
  maxU += dU * 0.5;

  // Create super-triangle that contains all points
  // Add three virtual points at the end of dataPoints
  const superA = dataPoints.length;
  const superB = dataPoints.length + 1;
  const superC = dataPoints.length + 2;

  dataPoints.push({
    P: 0, T: 0, v: 0, u: 0,
    logV: minLogV - dLogV,
    logP: 0,
    phase: '__super__',
  });
  dataPoints.push({
    P: 0, T: 0, v: 0, u: 0,
    logV: maxLogV + dLogV,
    logP: 0,
    phase: '__super__',
  });
  dataPoints.push({
    P: 0, T: 0, v: 0, u: 0,
    logV: (minLogV + maxLogV) / 2,
    logP: 0,
    phase: '__super__',
  });

  // Update u for super triangle vertices
  dataPoints[superA].u = minU - dU * 2;
  dataPoints[superB].u = minU - dU * 2;
  dataPoints[superC].u = maxU + dU * 2;

  // Start with super-triangle
  triangles = [{ i: superA, j: superB, k: superC }];

  // Insert each point
  const n = dataPoints.length - 3;  // Exclude super-triangle vertices
  for (let p = 0; p < n; p++) {
    const pt = dataPoints[p];
    insertPoint(p, pt.logV, pt.u);
  }

  // Remove triangles that contain super-triangle vertices
  triangles = triangles.filter(t =>
    t.i < n && t.j < n && t.k < n
  );

  // Remove super-triangle vertices
  dataPoints.splice(n, 3);
}

function insertPoint(pIdx: number, x: number, y: number): void {
  // Find triangles whose circumcircle contains the point
  const badTriangles: number[] = [];

  for (let i = 0; i < triangles.length; i++) {
    if (inCircumcircle(triangles[i], x, y)) {
      badTriangles.push(i);
    }
  }

  // Find boundary edges of the cavity using edge counting
  // An edge is on the boundary if it appears exactly once among bad triangles
  const edgeCount = new Map<string, { a: number; b: number; count: number }>();

  for (const tIdx of badTriangles) {
    const t = triangles[tIdx];
    const edges: [number, number][] = [
      [t.i, t.j],
      [t.j, t.k],
      [t.k, t.i],
    ];

    for (const [a, b] of edges) {
      // Normalize edge key so (a,b) and (b,a) map to the same key
      const key = a < b ? a + ',' + b : b + ',' + a;
      const existing = edgeCount.get(key);
      if (existing) {
        existing.count++;
      } else {
        edgeCount.set(key, { a, b, count: 1 });
      }
    }
  }

  // Boundary edges are those with count === 1
  const polygon: [number, number][] = [];
  for (const edge of edgeCount.values()) {
    if (edge.count === 1) {
      polygon.push([edge.a, edge.b]);
    }
  }

  // Remove bad triangles (in reverse order to preserve indices)
  badTriangles.sort((a, b) => b - a);
  for (const idx of badTriangles) {
    triangles.splice(idx, 1);
  }

  // Create new triangles from polygon edges to the new point
  for (const [a, b] of polygon) {
    triangles.push({ i: a, j: b, k: pIdx });
  }
}

function inCircumcircle(t: Triangle, x: number, y: number): boolean {
  const ax = dataPoints[t.i].logV;
  const ay = dataPoints[t.i].u;
  const bx = dataPoints[t.j].logV;
  const by = dataPoints[t.j].u;
  const cx = dataPoints[t.k].logV;
  const cy = dataPoints[t.k].u;

  // Normalize u to similar scale as logV for numerical stability
  const uScale = 1e-6;
  const nay = ay * uScale;
  const nby = by * uScale;
  const ncy = cy * uScale;
  const ny = y * uScale;

  const d = 2 * (ax * (nby - ncy) + bx * (ncy - nay) + cx * (nay - nby));
  if (Math.abs(d) < 1e-20) return false;

  const ax2 = ax * ax + nay * nay;
  const bx2 = bx * bx + nby * nby;
  const cx2 = cx * cx + ncy * ncy;

  const ux = (ax2 * (nby - ncy) + bx2 * (ncy - nay) + cx2 * (nay - nby)) / d;
  const uy = (ax2 * (cx - bx) + bx2 * (ax - cx) + cx2 * (bx - ax)) / d;

  const r2 = (ax - ux) * (ax - ux) + (nay - uy) * (nay - uy);
  const d2 = (x - ux) * (x - ux) + (ny - uy) * (ny - uy);

  return d2 < r2 * 1.0001;  // Small tolerance
}

// ============================================================================
// Interpolation
// ============================================================================

function findContainingTriangle(logV: number, u: number): Triangle | null {
  // 1. Check cache first
  const cached = cacheLookup(logV, u);
  if (cached !== null) {
    if (cached === -1) return null;
    return triangles[cached];
  }

  // 2. Try grid lookup (O(1) average)
  const gridResult = gridLookup(logV, u);
  if (gridResult >= 0) {
    cacheStore(logV, u, gridResult);
    return triangles[gridResult];
  }

  // 3. Fallback: linear search (for edge cases outside grid bounds)
  for (let i = 0; i < triangles.length; i++) {
    if (pointInTriangle(logV, u, triangles[i])) {
      cacheStore(logV, u, i);
      return triangles[i];
    }
  }

  // Not found - cache the miss
  cacheStore(logV, u, -1);
  return null;
}

function pointInTriangle(x: number, y: number, t: Triangle): boolean {
  const x1 = dataPoints[t.i].logV;
  const y1 = dataPoints[t.i].u;
  const x2 = dataPoints[t.j].logV;
  const y2 = dataPoints[t.j].u;
  const x3 = dataPoints[t.k].logV;
  const y3 = dataPoints[t.k].u;

  const denom = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3);
  if (Math.abs(denom) < 1e-20) return false;

  const a = ((y2 - y3) * (x - x3) + (x3 - x2) * (y - y3)) / denom;
  const b = ((y3 - y1) * (x - x3) + (x1 - x3) * (y - y3)) / denom;
  const c = 1 - a - b;

  return a >= -0.001 && b >= -0.001 && c >= -0.001;
}

function barycentricInterpolate(logV: number, u: number, t: Triangle, values: number[]): number {
  const x1 = dataPoints[t.i].logV;
  const y1 = dataPoints[t.i].u;
  const x2 = dataPoints[t.j].logV;
  const y2 = dataPoints[t.j].u;
  const x3 = dataPoints[t.k].logV;
  const y3 = dataPoints[t.k].u;

  const denom = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3);
  if (Math.abs(denom) < 1e-20) {
    return (values[0] + values[1] + values[2]) / 3;
  }

  const a = ((y2 - y3) * (logV - x3) + (x3 - x2) * (u - y3)) / denom;
  const b = ((y3 - y1) * (logV - x3) + (x1 - x3) * (u - y3)) / denom;
  const c = 1 - a - b;

  return a * values[0] + b * values[1] + c * values[2];
}

/**
 * Estimate temperature from liquid internal energy using the saturation curve.
 *
 * For liquid water, T(u) is nearly independent of pressure because:
 * 1. Liquid is nearly incompressible
 * 2. Internal energy is dominated by thermal energy, not PV work
 *
 * We interpolate along the saturation liquid curve (u_f, T) pairs.
 * For compressed liquid at the same T, u is very close to u_f.
 */
function estimateTemperatureFromLiquidEnergy(u: number): number {
  // Sort saturation pairs by u_f for binary search
  const sorted = [...saturationPairs].sort((a, b) => a.u_f - b.u_f);

  // Handle out of range cases
  if (u <= sorted[0].u_f) {
    return sorted[0].T;
  }
  if (u >= sorted[sorted.length - 1].u_f) {
    // Beyond the critical point saturation data
    // This shouldn't happen for properly classified liquid (u_f_crit ≈ 2029 kJ/kg)
    // If u > u_f_crit, the state is likely supercritical or misclassified
    // Cap at critical temperature to avoid impossible states
    const n = sorted.length;
    const slope = (sorted[n-1].T - sorted[n-2].T) / (sorted[n-1].u_f - sorted[n-2].u_f);
    const extrapolated = sorted[n-1].T + slope * (u - sorted[n-1].u_f);
    // Cap at critical temperature - liquid cannot exist above this
    return Math.min(extrapolated, T_CRIT);
  }

  // Binary search to find bracketing points
  let lo = 0;
  let hi = sorted.length - 1;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (sorted[mid].u_f <= u) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  // Linear interpolation between lo and hi
  const t = (u - sorted[lo].u_f) / (sorted[hi].u_f - sorted[lo].u_f);
  return sorted[lo].T + t * (sorted[hi].T - sorted[lo].T);
}

function findNearestPoint(logV: number, u: number): DataPoint {
  let best = dataPoints[0];
  let bestDist = Infinity;

  for (const pt of dataPoints) {
    // Normalize u to similar scale as logV
    const dx = logV - pt.logV;
    const dy = (u - pt.u) * 1e-6;
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      best = pt;
    }
  }

  return best;
}

// ============================================================================
// Phase Detection from (u, v) Space
// ============================================================================

/**
 * Determine phase from (u, v) coordinates using the saturation dome boundary.
 *
 * NEW APPROACH (v3 optimized):
 * - Use pre-built dome boundary curve in (v, u) space
 * - Point below the dome curve = two-phase
 * - Point above the dome curve = single-phase (liquid or vapor)
 * - For two-phase, use bisection to find exact T where x_v = x_u
 *
 * This replaces the old approach of checking quality consistency with a 10% threshold.
 * The new geometric approach is more accurate and provides interpolated T/P values.
 * Do not modify the method of detecting whether a point is two-phase.
 */
function determinePhaseFromUV(v: number, u: number): {
  phase: 'liquid' | 'two-phase' | 'vapor';
  P?: number;
  T?: number;
  quality?: number;
} {
  // Reset debug info
  lastPhaseDetectionDebug = {};

  // Quick bounds check - u above u_g_max is definitely vapor
  // Critical point internal energy is ~2.029 MJ/kg for liquid, ~2.084 MJ/kg for vapor
  // Values above ~2.605 MJ/kg are definitely superheated vapor
  if (u > 2.605e6) {
    lastPhaseDetectionDebug.decisionReason = 'u > 2.605 MJ/kg -> vapor';
    return { phase: 'vapor' };
  }

  // Find where the saturation dome boundary is at this v
  const satResult = findSaturationU(v);

  if (satResult === null) {
    // v is outside the dome range - use cached bounds
    if (!boundsCache) {
      // Fallback if caches not built
      // No fallbacks! This should be an error. -Erick
      lastPhaseDetectionDebug.decisionReason = 'caches not built, fallback';
      return { phase: u < 1.8e6 ? 'liquid' : 'vapor' };
    }

    const { v_f_min } = boundsCache;

    // Use u < 1.8 MJ/kg as the liquid/vapor boundary for single-phase
    // This is a sharp boundary in the steam table data
    if (u < 1.8e6) {
      const location = v < v_f_min ? `v < v_f_min (left of dome)` : `v > v_g_max (right of dome)`;
      lastPhaseDetectionDebug.decisionReason = `u < 1.8 MJ/kg, ${location} -> liquid`;
      return { phase: 'liquid' };
    } else {
      const location = v < v_f_min ? `v < v_f_min (left of dome)` : `v > v_g_max (right of dome)`;
      lastPhaseDetectionDebug.decisionReason = `u >= 1.8 MJ/kg, ${location} -> vapor`;
      return { phase: 'vapor' };
    }
  }

  const u_sat = satResult.u_sat;

  // Key test: is the point below or above the saturation line?
  // Below the line = two-phase
  // Above the line = single-phase

  if (u < u_sat) {
    // BELOW the saturation line = TWO-PHASE
    // Find the exact saturation state by interpolating between saturation pairs
    // Goal: find T_sat where x_v(T) = x_u(T)
    bisectionTotalCount++;

    const result = findTwoPhaseState(v, u);

    if (result) {
      lastPhaseDetectionDebug.decisionReason = `below dome: u < u_sat, T=${result.T.toFixed(1)}K, x=${result.quality.toFixed(4)}`;
      lastPhaseDetectionDebug.x_v = result.x_v;
      lastPhaseDetectionDebug.x_u = result.x_u;
      return {
        phase: 'two-phase',
        P: result.P,
        T: result.T,
        quality: result.quality,
      };
    } else {
      // Bisection failed - this is a fatal error
      bisectionFailureCount++;
      console.error(`[WaterProps v3] FATAL ERROR: Phase detection failure`);
      console.error(`  State: v=${(v*1e6).toFixed(1)} mL/kg, u=${(u/1e3).toFixed(1)} kJ/kg`);
      console.error(`  findSaturationU indicates two-phase (u < u_sat)`);
      console.error(`  But cannot find saturation T/P where x_v and x_u agree`);
      console.error(`  This is physically impossible - stopping simulation`);

      throw new Error(
        `Phase detection failure: v=${(v*1e6).toFixed(1)} mL/kg, u=${(u/1e3).toFixed(1)} kJ/kg. ` +
        `State appears two-phase but x_v and x_u cannot be reconciled.`
      );
    }
  } else {
    // ABOVE the saturation line = SINGLE PHASE
    // Determine liquid vs vapor based on both energy and density
    //
    // For subcritical states: u < 1.8 MJ/kg → liquid, otherwise vapor
    // For supercritical states (very high density): use density as a guide
    //   - ρ > 1.5 × ρ_crit → liquid-like behavior (bulk modulus physics)
    //   - ρ < 0.5 × ρ_crit → vapor-like behavior (ideal gas physics)
    //   - In between: use energy threshold
    const rho = 1 / v;

    if (rho > 1.5 * RHO_CRIT) {
      // Very high density - treat as liquid regardless of energy
      // This handles supercritical compressed fluid correctly
      lastPhaseDetectionDebug.decisionReason = `above ${satResult.side} line, ρ=${rho.toFixed(0)} > 1.5×ρ_crit -> liquid (high density)`;
      return { phase: 'liquid' };
    } else if (rho < 0.5 * RHO_CRIT) {
      // Very low density - treat as vapor regardless of energy
      lastPhaseDetectionDebug.decisionReason = `above ${satResult.side} line, ρ=${rho.toFixed(0)} < 0.5×ρ_crit -> vapor (low density)`;
      return { phase: 'vapor' };
    } else if (u < 1.8e6) {
      // Intermediate density, low energy - liquid
      lastPhaseDetectionDebug.decisionReason = `above ${satResult.side} line, u < 1.8 MJ/kg -> liquid`;
      return { phase: 'liquid' };
    } else {
      // Intermediate density, high energy - vapor
      lastPhaseDetectionDebug.decisionReason = `above ${satResult.side} line, u >= 1.8 MJ/kg -> vapor`;
      return { phase: 'vapor' };
    }
  }
}

/**
 * Find the exact two-phase state using binary search.
 * Searches for the saturation pressure where x_v = x_u.
 */
function findTwoPhaseState(v: number, u: number): {
  T: number;
  P: number;
  quality: number;
  x_v: number;
  x_u: number;
} | null {
  const sortedPairs = sortedSatPairsCache;
  const n = sortedPairs.length;

  if (n < 2) return null;

  // Helper function to calculate x_v and x_u at a given saturation state
  // These can be negative or > 1 if we're outside the saturation bounds
  function calcQualities(sat: SaturationPair): { x_v: number; x_u: number; diff: number } {
    const x_v = (v - sat.v_f) / (sat.v_g - sat.v_f);
    const x_u = (u - sat.u_f) / (sat.u_g - sat.u_f);
    return { x_v, x_u, diff: x_v - x_u };
  }

  // Binary search for the pressure where x_v = x_u
  let lo = 0;
  let hi = n - 1;

  // Check endpoints
  let loQual = calcQualities(sortedPairs[lo]);
  let hiQual = calcQualities(sortedPairs[hi]);

  // Check if there's a sign change
  if (loQual.diff * hiQual.diff > 0) {
    // No sign change - x_v and x_u don't cross
    // This means the state is not truly two-phase
    return null;
  }

  // Binary search
  let iterations = 0;
  const maxIterations = 50;

  while (hi - lo > 1 && iterations < maxIterations) {
    iterations++;
    const mid = Math.floor((lo + hi) / 2);
    const midQual = calcQualities(sortedPairs[mid]);

    // Check if we're close enough
    if (Math.abs(midQual.diff) < 0.0001) {
      // Found it! x_v and x_u are essentially equal
      const quality = Math.max(0, Math.min(1, midQual.x_v));
      return {
        T: sortedPairs[mid].T,
        P: sortedPairs[mid].P,
        quality,
        x_v: midQual.x_v,
        x_u: midQual.x_u
      };
    }

    // Decide which half to search
    if (loQual.diff * midQual.diff < 0) {
      // Sign change is in lower half
      hi = mid;
      hiQual = midQual;
    } else {
      // Sign change is in upper half
      lo = mid;
      loQual = midQual;
    }
  }

  // We've narrowed it down to two adjacent points
  // Now interpolate between them to find exact crossing
  const sat1 = sortedPairs[lo];
  const sat2 = sortedPairs[hi];

  // We need to find t ∈ [0,1] such that x_v(t) = x_u(t)
  // where saturation properties are linearly interpolated:
  // prop(t) = prop1 + t * (prop2 - prop1)

  // The condition x_v(t) = x_u(t) means:
  // (v - v_f(t)) / (v_g(t) - v_f(t)) = (u - u_f(t)) / (u_g(t) - u_f(t))
  //
  // Cross multiplying:
  // (v - v_f(t)) * (u_g(t) - u_f(t)) = (u - u_f(t)) * (v_g(t) - v_f(t))
  //
  // With linear interpolation, this becomes a quadratic equation in t:
  // At² + Bt + C = 0

  // Define the differences for cleaner notation
  const dv_f = sat2.v_f - sat1.v_f;
  const dv_g = sat2.v_g - sat1.v_g;
  const du_f = sat2.u_f - sat1.u_f;
  const du_g = sat2.u_g - sat1.u_g;

  // Terms for left side: (v - v_f(t)) * (u_g(t) - u_f(t))
  // v - v_f(t) = v - sat1.v_f - t*dv_f = (v - sat1.v_f) - t*dv_f
  // u_g(t) - u_f(t) = (sat1.u_g - sat1.u_f) + t*(du_g - du_f)
  const L1 = v - sat1.v_f;  // constant term of (v - v_f(t))
  const L2 = -dv_f;         // linear term of (v - v_f(t))
  const L3 = sat1.u_g - sat1.u_f;  // constant term of (u_g(t) - u_f(t))
  const L4 = du_g - du_f;          // linear term of (u_g(t) - u_f(t))

  // Terms for right side: (u - u_f(t)) * (v_g(t) - v_f(t))
  // u - u_f(t) = u - sat1.u_f - t*du_f = (u - sat1.u_f) - t*du_f
  // v_g(t) - v_f(t) = (sat1.v_g - sat1.v_f) + t*(dv_g - dv_f)
  const R1 = u - sat1.u_f;  // constant term of (u - u_f(t))
  const R2 = -du_f;         // linear term of (u - u_f(t))
  const R3 = sat1.v_g - sat1.v_f;  // constant term of (v_g(t) - v_f(t))
  const R4 = dv_g - dv_f;          // linear term of (v_g(t) - v_f(t))

  // Expand: (L1 + L2*t) * (L3 + L4*t) = (R1 + R2*t) * (R3 + R4*t)
  // Left: L1*L3 + (L1*L4 + L2*L3)*t + L2*L4*t²
  // Right: R1*R3 + (R1*R4 + R2*R3)*t + R2*R4*t²
  //
  // Moving everything to left side:
  // (L2*L4 - R2*R4)*t² + (L1*L4 + L2*L3 - R1*R4 - R2*R3)*t + (L1*L3 - R1*R3) = 0

  const A = L2 * L4 - R2 * R4;
  const B = L1 * L4 + L2 * L3 - R1 * R4 - R2 * R3;
  const C = L1 * L3 - R1 * R3;

  // Solve quadratic At² + Bt + C = 0
  let t: number;

  if (Math.abs(A) < 1e-12) {
    // Linear equation: Bt + C = 0
    if (Math.abs(B) < 1e-12) {
      // Degenerate case - use midpoint
      t = 0.5;
    } else {
      t = -C / B;
    }
  } else {
    // Quadratic equation - use quadratic formula
    const discriminant = B * B - 4 * A * C;

    if (discriminant < 0) {
      // No real solution - shouldn't happen for valid two-phase states
      // Use midpoint as fallback
      t = 0.5;
    } else {
      const sqrt_disc = Math.sqrt(discriminant);
      const t1 = (-B + sqrt_disc) / (2 * A);
      const t2 = (-B - sqrt_disc) / (2 * A);

      // Choose the root that's in [0, 1]
      // There should only be ONE valid root physically
      if (t1 >= 0 && t1 <= 1 && t2 >= 0 && t2 <= 1) {
        // Both roots in [0,1] - this shouldn't happen physically!
        console.error(`[WaterProperties] ERROR: Two valid roots found in findTwoPhaseState!`);
        console.error(`  v=${(v*1e6).toFixed(2)} mL/kg, u=${(u/1e3).toFixed(1)} kJ/kg`);
        console.error(`  t1=${t1.toFixed(6)}, t2=${t2.toFixed(6)}`);
        console.error(`  P range: ${(sat1.P/1e5).toFixed(2)} to ${(sat2.P/1e5).toFixed(2)} bar`);
        console.error(`  Quadratic coefficients: A=${A}, B=${B}, C=${C}`);
        throw new Error('Physical inconsistency: Two valid interpolation parameters for x_v = x_u');
      } else if (t1 >= 0 && t1 <= 1) {
        t = t1;
      } else if (t2 >= 0 && t2 <= 1) {
        t = t2;
      } else {
        // Neither root is in [0, 1] - clamp the closer one
        if (Math.abs(t1 - 0.5) < Math.abs(t2 - 0.5)) {
          t = Math.max(0, Math.min(1, t1));
        } else {
          t = Math.max(0, Math.min(1, t2));
        }
      }
    }
  }

  // Ensure t is in valid range
  t = Math.max(0, Math.min(1, t));

  // Calculate final properties at t
  const P_t = sat1.P + t * (sat2.P - sat1.P);
  const T_t = sat1.T + t * (sat2.T - sat1.T);
  const v_f_t = sat1.v_f + t * dv_f;
  const v_g_t = sat1.v_g + t * dv_g;
  const u_f_t = sat1.u_f + t * du_f;
  const u_g_t = sat1.u_g + t * du_g;

  // Calculate final qualities
  const x_v_final = (v - v_f_t) / (v_g_t - v_f_t);
  const x_u_final = (u - u_f_t) / (u_g_t - u_f_t);

  // Use minimum of x_v and x_u as the quality
  const quality = Math.min(x_v_final, x_u_final);

  // Clamp quality to [0, 1]
  const qualityClamped = Math.max(0, Math.min(1, quality));

  // Check for convergence issues
  if (Math.abs(x_v_final - x_u_final) > 0.0001) {
    console.error(`[WaterProperties] Poor convergence in findTwoPhaseState:`);
    console.error(`  v=${(v*1e6).toFixed(2)} mL/kg, u=${(u/1e3).toFixed(1)} kJ/kg`);
    console.error(`  P=${(P_t/1e5).toFixed(2)} bar, T=${(T_t-273.15).toFixed(1)}°C`);
    console.error(`  x_v=${x_v_final.toFixed(6)}, x_u=${x_u_final.toFixed(6)}`);
    console.error(`  Difference: ${Math.abs(x_v_final - x_u_final).toFixed(6)}`);
  }

  return {
    T: T_t,
    P: P_t,
    quality: qualityClamped,
    x_v: x_v_final,
    x_u: x_u_final
  };
}


/**
 * Get bisection convergence statistics for debugging.
 * Returns failure rate as a fraction.
 */
export function getBisectionStats(): { total: number; failures: number; failureRate: number } {
  return {
    total: bisectionTotalCount,
    failures: bisectionFailureCount,
    failureRate: bisectionTotalCount > 0 ? bisectionFailureCount / bisectionTotalCount : 0,
  };
}

/**
 * Reset bisection statistics.
 */
export function resetBisectionStats(): void {
  bisectionTotalCount = 0;
  bisectionFailureCount = 0;
}

// ============================================================================
// Main Interface
// ============================================================================

export interface WaterState {
  temperature: number;    // K
  pressure: number;       // Pa
  density: number;        // kg/m³
  phase: 'liquid' | 'two-phase' | 'vapor';
  quality: number;
  specificEnergy: number; // J/kg
}

// Debug flag for phase detection logging
let phaseDebugEnabled = true; // Enable by default to diagnose phase issues
let phaseDebugCount = 0;
const PHASE_DEBUG_MAX = 20; // Limit debug output

// Detailed debug for tracking temperature jumps
interface PhaseDetectionDebug {
  bestMatchScore?: number;
  bestMatchQuality?: number;
  bestMatchIdx?: number;
  x_v?: number;
  x_u?: number;
  satPairChecked?: { P: number; T: number; v_f: number; v_g: number; u_f: number; u_g: number };
  decisionReason?: string;
}

interface CalculationDebugInfo {
  inputs: { mass: number; U: number; V: number; rho: number; v: number; u: number };
  phaseResult: { phase: string; P?: number; T?: number; quality?: number };
  phaseDetectionDebug?: PhaseDetectionDebug;
  calculationPath: string;
  intermediateValues: Record<string, number | string>;
  result: { T: number; P: number; phase: string };
}

// Global to pass phase detection debug info out
let lastPhaseDetectionDebug: PhaseDetectionDebug | null = null;

let calculationDebugLog: CalculationDebugInfo[] = [];
let calculationDebugEnabled = false;
const CALCULATION_DEBUG_MAX = 50;

export function enableCalculationDebug(enabled: boolean): void {
  calculationDebugEnabled = enabled;
  if (enabled) {
    calculationDebugLog = [];
    console.log('[WaterProps] Calculation debug ENABLED - will log next', CALCULATION_DEBUG_MAX, 'calculations');
  }
}

export function getCalculationDebugLog(): CalculationDebugInfo[] {
  return calculationDebugLog;
}

export function setPhaseDebug(enabled: boolean): void {
  phaseDebugEnabled = enabled;
  phaseDebugCount = 0;
}

export function calculateState(mass: number, internalEnergy: number, volume: number): WaterState {
  loadData();

  const rho = mass / volume;
  const v = volume / mass;  // specific volume m³/kg
  const u = internalEnergy / mass;  // specific internal energy J/kg

  // Debug info accumulator
  const debugInfo: CalculationDebugInfo = {
    inputs: { mass, U: internalEnergy, V: volume, rho, v, u },
    phaseResult: { phase: 'unknown' },
    calculationPath: '',
    intermediateValues: {},
    result: { T: 0, P: 0, phase: 'unknown' },
  };

  if (!isFinite(rho) || rho <= 0 || !isFinite(u) || v <= 0) {
    debugInfo.calculationPath = 'INVALID_INPUT';
    if (calculationDebugEnabled && calculationDebugLog.length < CALCULATION_DEBUG_MAX) {
      debugInfo.result = { T: 400, P: 1e6, phase: 'liquid' };
      calculationDebugLog.push(debugInfo);
    }
    return {
      temperature: 400,
      pressure: 1e6,
      density: 1000,
      phase: 'liquid',
      quality: 0,
      specificEnergy: 500000,
    };
  }

  // PHASE DETECTION: Use (u, v) space to determine phase
  // This is reliable and doesn't require pressure as input
  const phaseResult = determinePhaseFromUV(v, u);
  debugInfo.phaseResult = {
    phase: phaseResult.phase,
    P: phaseResult.P,
    T: phaseResult.T,
    quality: phaseResult.quality
  };
  // Capture phase detection debug info
  if (lastPhaseDetectionDebug) {
    debugInfo.phaseDetectionDebug = { ...lastPhaseDetectionDebug };
  }

  if (phaseResult.phase === 'two-phase') {
    debugInfo.calculationPath = 'TWO_PHASE';
    debugInfo.result = { T: phaseResult.T!, P: phaseResult.P!, phase: 'two-phase' };
    if (calculationDebugEnabled && calculationDebugLog.length < CALCULATION_DEBUG_MAX) {
      calculationDebugLog.push(debugInfo);
    }
    // Two-phase: we already have P, T, quality from the saturation curve
    return {
      temperature: phaseResult.T!,
      pressure: phaseResult.P!,
      density: rho,
      phase: 'two-phase',
      quality: phaseResult.quality!,
      specificEnergy: u,
    };
  }

  // Single-phase (liquid or vapor): determine T and P
  const phase = phaseResult.phase;
  const logV = Math.log10(v);
  debugInfo.intermediateValues.logV = logV;

  let P: number;
  let T: number;

  if (phase === 'liquid') {
    // LIQUID: Use energy-based temperature estimation
    // For liquid, T(u) is nearly independent of pressure (incompressible)
    T = estimateTemperatureFromLiquidEnergy(u);
    debugInfo.intermediateValues.T_fromEnergy = T;
    debugInfo.calculationPath = 'LIQUID_ENERGY_BASED';

    // Fallback if estimation fails
    if (!isFinite(T) || T < T_TRIPLE || T > T_CRIT) {
      T = 373.15 + (u - 417500) / 4200;
      debugInfo.calculationPath = 'LIQUID_FALLBACK';
      debugInfo.intermediateValues.T_fallback = T;
    }

    // PRESSURE: Use liquid-only triangulation for accurate compressed liquid pressure
    // This uses steam table data to interpolate P from (v, u)
    const P_lookup = lookupPressureFromUV_LiquidOnly(u, v);

    if (P_lookup !== null) {
      // Triangulation succeeded - use interpolated pressure
      P = P_lookup;
      debugInfo.calculationPath = 'LIQUID_TRIANGULATION';
      debugInfo.intermediateValues.P_triangulation = P;
    } else {
      // Fallback for isolated liquid or outside triangulation domain:
      // Use saturation pressure + temperature-dependent bulk modulus compression
      const P_sat = saturationPressure(T);
      const rho_sat = saturatedLiquidDensity(T);
      const T_C = T - 273.15;
      const K = bulkModulus(T_C);  // Temperature-dependent bulk modulus
      const compressionRatio = Math.max(0, (rho - rho_sat) / rho_sat);
      P = P_sat + K * compressionRatio;
      P = Math.max(P_sat, P);

      debugInfo.calculationPath = 'LIQUID_SATURATION_FALLBACK';
      debugInfo.intermediateValues.P_sat = P_sat;
      debugInfo.intermediateValues.rho_sat = rho_sat;
      debugInfo.intermediateValues.compressionRatio = compressionRatio;
      debugInfo.intermediateValues.K_bulkModulus = K;
    }
  } else {
    // VAPOR: Use Delaunay interpolation for P and T
    // Try to find containing triangle
    const tri = findContainingTriangle(logV, u);

    if (tri) {
      // Interpolate within triangle
      P = barycentricInterpolate(logV, u, tri, [
        dataPoints[tri.i].P,
        dataPoints[tri.j].P,
        dataPoints[tri.k].P,
      ]);
      T = barycentricInterpolate(logV, u, tri, [
        dataPoints[tri.i].T,
        dataPoints[tri.j].T,
        dataPoints[tri.k].T,
      ]);
      debugInfo.calculationPath = 'VAPOR_TRIANGULATION';
      debugInfo.intermediateValues.trianglePoints = `[${tri.i}, ${tri.j}, ${tri.k}]`;
    } else {
      // Vapor outside triangulation - use ideal gas with corrections for supercritical states
      const nearest = findNearestPoint(logV, u);

      // For temperature, use the nearest point as a reference
      T = nearest.T;
      debugInfo.calculationPath = 'VAPOR_EXTRAPOLATION';
      debugInfo.intermediateValues.nearestPhase = nearest.phase;
      debugInfo.intermediateValues.nearestP = nearest.P;

      // For pressure, use ideal gas law with compressibility correction
      // P = Z * ρ * R * T, where Z is compressibility factor
      // Near critical point, Z can be significantly less than 1
      // Use a simple correlation: Z ≈ 1 for low ρ, decreasing as ρ approaches ρ_crit
      const P_ideal = rho * R_WATER * T;

      // Compressibility factor: Z = 1 at low density, ~0.23 at critical point
      // Use a smooth blend based on reduced density (ρ/ρ_crit)
      const rho_reduced = rho / RHO_CRIT;
      if (rho_reduced < 0.5) {
        // Low density - nearly ideal
        const Z = 1 - 0.1 * rho_reduced;
        P = Z * P_ideal;
        debugInfo.intermediateValues.Z_factor = Z;
        debugInfo.intermediateValues.P_ideal = P_ideal;
      } else if (rho_reduced < 1.5) {
        // Near critical - significant non-ideality
        // At ρ = ρ_crit, Z ≈ 0.23 for water
        const Z = 0.95 - 0.72 * (rho_reduced - 0.5);
        P = Z * P_ideal;
        debugInfo.intermediateValues.Z_factor = Z;
        debugInfo.intermediateValues.P_ideal = P_ideal;
      } else {
        // High density (compressed) - blend toward liquid-like behavior
        // Use bulk modulus extrapolation for very high density
        const T_C = T - 273.15;
        const K = bulkModulus(T_C);
        // Estimate pressure from compression relative to critical density
        const dP = K * (rho - RHO_CRIT) / RHO_CRIT;
        P = P_CRIT + dP;
        debugInfo.calculationPath = 'VAPOR_HIGH_DENSITY_EXTRAPOLATION';
        debugInfo.intermediateValues.bulkModulus = K;
        debugInfo.intermediateValues.dP = dP;
      }

      // Ensure smooth transition: if we're close to the triangulation edge,
      // blend with the nearest point's pressure to avoid sudden jumps
      if (nearest.P > 0 && isFinite(nearest.P)) {
        // Calculate distance from nearest point in normalized space
        const dLogV = Math.abs(logV - nearest.logV);
        const dU = Math.abs(u - nearest.u) / 1e6;
        const dist = Math.sqrt(dLogV * dLogV + dU * dU);

        // Blend factor: 1 at edge (dist=0), 0 at dist=0.5
        const blendToNearest = Math.max(0, 1 - dist * 2);
        if (blendToNearest > 0) {
          P = blendToNearest * nearest.P + (1 - blendToNearest) * P;
          debugInfo.intermediateValues.blendToNearest = blendToNearest;
        }
      }
    }
  }

  // Sanity checks
  P = Math.max(1000, Math.min(P, P_CRIT * 10));
  T = Math.max(T_TRIPLE, Math.min(T, 3000));

  // Debug: Log when we have suspicious states (high T liquid or low T vapor)
  // Only trigger for T >= 500°C to reduce noise
  const T_C = T - 273.15;
  if (phaseDebugEnabled && phaseDebugCount < PHASE_DEBUG_MAX && T_C >= 500) {
    const T_sat_at_P = saturationTemperature(P);
    const T_sat_C = T_sat_at_P - 273.15;

    // Check for suspicious states:
    // - Liquid above saturation temperature at this pressure (at high T)
    // - Vapor below saturation temperature at this pressure
    const isSuspicious = (phase === 'liquid' && T > T_sat_at_P + 10) ||
                        (phase === 'vapor' && T < T_sat_at_P - 10);

    if (isSuspicious) {
      phaseDebugCount++;
      console.warn(`[PhaseDebug #${phaseDebugCount}] Suspicious state detected:`);
      console.warn(`  Inputs: mass=${mass.toFixed(1)}kg, U=${(internalEnergy/1e6).toFixed(3)}MJ, V=${volume.toFixed(4)}m³`);
      console.warn(`  Derived: ρ=${rho.toFixed(1)}kg/m³, v=${v.toFixed(6)}m³/kg, u=${(u/1000).toFixed(1)}kJ/kg`);
      console.warn(`  Result: T=${T_C.toFixed(1)}°C, P=${(P/1e5).toFixed(1)}bar, phase=${phase}, T_sat=${T_sat_C.toFixed(1)}°C`);
      console.warn(`  Critical: ρ_crit=${RHO_CRIT}kg/m³, T_crit=${(T_CRIT-273.15).toFixed(1)}°C`);
      console.warn(`  Phase decision: rho(${rho.toFixed(1)}) ${rho > RHO_CRIT ? '>' : '<='} RHO_CRIT(${RHO_CRIT}) => ${rho > RHO_CRIT ? 'liquid' : 'vapor'}`);

      // Also log what saturation pairs we checked
      console.warn(`  minVf=${minVf.toFixed(6)}, v/minVf=${(v/minVf).toFixed(2)}`);

      // Find nearest saturation pairs to understand the dome
      let nearestSat: SaturationPair | null = null;
      let nearestDist = Infinity;
      for (const sat of saturationPairs) {
        // Distance in normalized (u, v) space
        const du = (u - (sat.u_f + sat.u_g) / 2) / 1e6;
        const dv = (v - (sat.v_f + sat.v_g) / 2) * 1000;
        const dist = Math.sqrt(du * du + dv * dv);
        if (dist < nearestDist) {
          nearestDist = dist;
          nearestSat = sat;
        }
      }
      if (nearestSat) {
        console.warn(`  Nearest sat pair: P=${(nearestSat.P/1e5).toFixed(1)}bar, T=${(nearestSat.T-273.15).toFixed(1)}°C`);
        console.warn(`    v_f=${nearestSat.v_f.toFixed(6)}, v_g=${nearestSat.v_g.toFixed(4)}, our v=${v.toFixed(6)}`);
        console.warn(`    u_f=${(nearestSat.u_f/1000).toFixed(1)}kJ/kg, u_g=${(nearestSat.u_g/1000).toFixed(1)}kJ/kg, our u=${(u/1000).toFixed(1)}kJ/kg`);
        console.warn(`    v in range: ${v >= nearestSat.v_f && v <= nearestSat.v_g}`);
        console.warn(`    u in range: ${u >= nearestSat.u_f && u <= nearestSat.u_g}`);
      }
    }
  }

  // CRITICAL CHECK: Liquid cannot exist above critical temperature (374°C / 647K)
  // If we detect liquid above 375°C, something is very wrong with phase detection
  if (phase === 'liquid' && T > 648) { // 648K = 375°C
    console.error('='.repeat(60));
    console.error('[PHASE ERROR] Liquid detected above critical temperature!');
    console.error('='.repeat(60));
    console.error(`  Temperature: ${(T - 273.15).toFixed(1)}°C (${T.toFixed(1)}K)`);
    console.error(`  Pressure: ${(P / 1e5).toFixed(1)} bar (${(P / 1e6).toFixed(2)} MPa)`);
    console.error(`  Density: ${rho.toFixed(1)} kg/m³`);
    console.error(`  Specific volume: ${v.toFixed(6)} m³/kg`);
    console.error(`  Specific energy: ${(u / 1000).toFixed(1)} kJ/kg`);
    console.error(`  Critical point: T_crit=${(T_CRIT - 273.15).toFixed(1)}°C, ρ_crit=${RHO_CRIT} kg/m³`);
    console.error(`  Phase decision was: rho(${rho.toFixed(1)}) > RHO_CRIT(${RHO_CRIT}) => liquid`);
    console.error('');
    console.error('  Input values:');
    console.error(`    mass=${mass.toFixed(1)}kg, U=${(internalEnergy / 1e6).toFixed(3)}MJ, V=${volume.toFixed(4)}m³`);
    console.error('');

    // Find what saturation pairs say about this state
    console.error('  Saturation dome analysis:');
    console.error(`    minVf=${minVf.toFixed(6)}, v/minVf=${(v / minVf).toFixed(2)}`);

    // Check if any saturation pair contains this (u, v)
    let foundInDome = false;
    for (const sat of saturationPairs) {
      if (u >= sat.u_f && u <= sat.u_g && v >= sat.v_f && v <= sat.v_g) {
        console.error(`    IN DOME at P=${(sat.P / 1e5).toFixed(1)}bar, T=${(sat.T - 273.15).toFixed(1)}°C`);
        foundInDome = true;
        break;
      }
    }
    if (!foundInDome) {
      console.error('    NOT inside any saturation dome');
      // Check if u is above all u_g (superheated)
      const maxUg = Math.max(...saturationPairs.map(s => s.u_g));
      if (u > maxUg) {
        console.error(`    u=${(u / 1000).toFixed(1)}kJ/kg > max_u_g=${(maxUg / 1000).toFixed(1)}kJ/kg => SUPERHEATED VAPOR`);
      }
    }

    console.error('='.repeat(60));

    // Pause simulation by triggering debugger
    // eslint-disable-next-line no-debugger
    debugger;
  }

  // Log to calculation debug if enabled
  debugInfo.result = { T, P, phase };
  if (calculationDebugEnabled && calculationDebugLog.length < CALCULATION_DEBUG_MAX) {
    calculationDebugLog.push(debugInfo);
  }

  return {
    temperature: T,
    pressure: P,
    density: rho,
    phase,
    quality: phase === 'vapor' ? 1 : 0,
    specificEnergy: u,
  };
}

// ============================================================================
// Exported Saturation Functions
// ============================================================================

export function saturationPressure(T: number): number {
  loadData();

  // Find nearest saturation pair by temperature
  let best = saturationPairs[0];
  let bestDist = Infinity;

  for (const sat of saturationPairs) {
    const dist = Math.abs(sat.T - T);
    if (dist < bestDist) {
      bestDist = dist;
      best = sat;
    }
  }

  // Linear interpolation between neighbors
  const idx = saturationPairs.indexOf(best);
  if (idx > 0 && idx < saturationPairs.length - 1) {
    const prev = saturationPairs[idx - 1];
    const next = saturationPairs[idx + 1];
    if (T < best.T && prev.T < T) {
      const t = (T - prev.T) / (best.T - prev.T);
      return prev.P + t * (best.P - prev.P);
    } else if (T > best.T && next.T > T) {
      const t = (T - best.T) / (next.T - best.T);
      return best.P + t * (next.P - best.P);
    }
  }

  return best?.P ?? 101325;
}

export function saturationTemperature(P: number): number {
  loadData();

  // Binary search for pressure
  let lo = 0, hi = saturationPairs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (saturationPairs[mid].P <= P) lo = mid;
    else hi = mid;
  }

  if (lo === hi) return saturationPairs[lo].T;

  const t = (P - saturationPairs[lo].P) / (saturationPairs[hi].P - saturationPairs[lo].P);
  return saturationPairs[lo].T + t * (saturationPairs[hi].T - saturationPairs[lo].T);
}

export function saturatedLiquidDensity(T: number): number {
  loadData();

  for (const sat of saturationPairs) {
    if (Math.abs(sat.T - T) < 5) {
      return 1 / sat.v_f;
    }
  }

  // Fallback correlation
  const tau = 1 - T / T_CRIT;
  return RHO_CRIT + (1000 - RHO_CRIT) * Math.pow(Math.max(0, tau), 0.35);
}

export function saturatedVaporDensity(T: number): number {
  loadData();

  for (const sat of saturationPairs) {
    if (Math.abs(sat.T - T) < 5) {
      return 1 / sat.v_g;
    }
  }

  // Fallback: ideal gas at saturation pressure
  const P = saturationPressure(T);
  return P / (R_WATER * T);
}

export function saturatedLiquidEnergy(T: number): number {
  loadData();

  for (const sat of saturationPairs) {
    if (Math.abs(sat.T - T) < 5) {
      return sat.u_f;
    }
  }

  return CV_LIQUID * (T - T_REF);
}

export function saturatedVaporEnergy(T: number): number {
  loadData();

  for (const sat of saturationPairs) {
    if (Math.abs(sat.T - T) < 5) {
      return sat.u_g;
    }
  }

  return 2500000 + 1500 * (T - 373);
}

export function latentHeat(T: number): number {
  loadData();

  for (const sat of saturationPairs) {
    if (Math.abs(sat.T - T) < 5) {
      return sat.u_g - sat.u_f;
    }
  }

  const tau = 1 - T / T_CRIT;
  return 2.5e6 * Math.pow(Math.max(0, tau), 0.38);
}

// ============================================================================
// Distance to Saturation Line
// ============================================================================

/**
 * Result of computing distance to saturation line in (u, v) space.
 */
export interface SaturationDistanceResult {
  /** Signed distance to saturation liquid line: positive = compressed (v < v_f), negative = expanded (v > v_f) */
  distance: number;
  /** Specific volume in mL/kg (v * 1e6) - scaled to match u in kJ/kg (~1000-1700 range) */
  v_mLkg: number;
  /** Specific internal energy in kJ/kg */
  u_kJkg: number;
  /** Saturation pressure at the closest point on the saturation line */
  P_sat_closest: number;
  /** v_f at the closest saturation point (mL/kg) */
  v_f_closest: number;
}

/**
 * Compute the signed distance from a (u, v) point to the saturated liquid line.
 *
 * Uses Euclidean distance in scaled (u, v) space where:
 * - v is scaled by 1e6 (m³/kg → mL/kg) to be similar magnitude to u (kJ/kg)
 *   At operating conditions: v ≈ 0.0013-0.0017 m³/kg → 1300-1700 mL/kg
 * - u is in kJ/kg (typically 1000-1700 kJ/kg for hot liquid)
 *
 * The distance is signed based on v relative to v_f at the closest saturation point:
 * - Positive: v < v_f (compressed liquid, denser than saturated)
 * - Negative: v > v_f (expanded, approaching or inside two-phase dome)
 *
 * This measures distance to the saturated liquid line (v_f, u_f) only.
 *
 * @param u_Jkg - Specific internal energy in J/kg
 * @param v_m3kg - Specific volume in m³/kg
 * @returns Distance result with closest saturation point info
 */
export function distanceToSaturationLine(u_Jkg: number, v_m3kg: number): SaturationDistanceResult {
  loadData();

  // Convert to scaled units for distance calculation
  // v in mL/kg (1e6 scale) and u in kJ/kg puts both in ~1000-1700 range for hot liquid
  const v_mLkg = v_m3kg * 1e6;  // m³/kg → mL/kg
  const u_kJkg = u_Jkg / 1000;  // J/kg → kJ/kg

  if (saturationPairs.length < 2) {
    return {
      distance: NaN,
      v_mLkg,
      u_kJkg,
      P_sat_closest: NaN,
      v_f_closest: NaN,
    };
  }

  // Find minimum distance to the saturated liquid line using point-to-line-segment distance
  // The saturation line is a series of connected segments
  let minDist = Infinity;
  let closestP = saturationPairs[0].P;
  let closestVf = saturationPairs[0].v_f * 1e6;  // mL/kg

  // Sort by temperature for proper line segments
  const sorted = [...saturationPairs].sort((a, b) => a.T - b.T);

  for (let i = 0; i < sorted.length - 1; i++) {
    const sat1 = sorted[i];
    const sat2 = sorted[i + 1];

    // Distance to saturated liquid line segment
    const p1_v = sat1.v_f * 1e6;  // Convert to mL/kg
    const p1_u = sat1.u_f / 1000;  // Convert to kJ/kg
    const p2_v = sat2.v_f * 1e6;
    const p2_u = sat2.u_f / 1000;

    // Point-to-line-segment distance
    const dist = pointToSegmentDistance(v_mLkg, u_kJkg, p1_v, p1_u, p2_v, p2_u);

    if (dist < minDist) {
      minDist = dist;
      // Interpolate pressure and v_f at closest point
      const t = Math.max(0, Math.min(1, projectOntoSegment(v_mLkg, u_kJkg, p1_v, p1_u, p2_v, p2_u)));
      closestP = sat1.P + t * (sat2.P - sat1.P);
      closestVf = p1_v + t * (p2_v - p1_v);
    }
  }

  // Also check endpoints
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  const distFirst = Math.sqrt(Math.pow(v_mLkg - first.v_f * 1e6, 2) + Math.pow(u_kJkg - first.u_f / 1000, 2));
  const distLast = Math.sqrt(Math.pow(v_mLkg - last.v_f * 1e6, 2) + Math.pow(u_kJkg - last.u_f / 1000, 2));
  if (distFirst < minDist) {
    minDist = distFirst;
    closestP = first.P;
    closestVf = first.v_f * 1e6;
  }
  if (distLast < minDist) {
    minDist = distLast;
    closestP = last.P;
    closestVf = last.v_f * 1e6;
  }

  // Sign the distance based on v relative to v_f at closest point:
  // Positive = compressed (v < v_f, smaller volume, higher density)
  // Negative = expanded (v > v_f, larger volume, lower density, approaching/in two-phase)
  const signedDist = v_mLkg < closestVf ? minDist : -minDist;

  return {
    distance: signedDist,
    v_mLkg,
    u_kJkg,
    P_sat_closest: closestP,
    v_f_closest: closestVf,
  };
}

/**
 * Compute distance from point (px, py) to line segment (x1, y1)-(x2, y2)
 */
function pointToSegmentDistance(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;

  if (lenSq === 0) {
    // Segment is a point
    return Math.sqrt((px - x1) ** 2 + (py - y1) ** 2);
  }

  // Project point onto line, clamped to segment
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  const closestX = x1 + t * dx;
  const closestY = y1 + t * dy;

  return Math.sqrt((px - closestX) ** 2 + (py - closestY) ** 2);
}

/**
 * Compute projection parameter t for point onto line segment (0 = start, 1 = end)
 */
function projectOntoSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return 0;
  return ((px - x1) * dx + (py - y1) * dy) / lenSq;
}

// ============================================================================
// Compatibility exports
// ============================================================================

export function liquidCv(_T: number): number {
  return CV_LIQUID;
}

export function vaporCv(T: number): number {
  return 1400 + 0.47 * Math.max(0, T - 373);
}

export function setWaterPropsDebug(_enabled: boolean): void {}
export function getWaterPropsDebugLog(): string[] { return []; }

// Profiling stubs (not implemented in v3)
export interface WaterPropsProfile {
  calculateStateCalls: number;
  calculateStateCacheHits: number;
  calculateStateTime: number;
  pressureFeedbackCalls: number;
  pressureFeedbackTime: number;
}

export function getWaterPropsProfile(): WaterPropsProfile {
  return {
    calculateStateCalls: 0,
    calculateStateCacheHits: 0,
    calculateStateTime: 0,
    pressureFeedbackCalls: 0,
    pressureFeedbackTime: 0,
  };
}

export function resetWaterPropsProfile(): void {}

export function clearStateCache(): void {}

export function addEnergy(mass: number, energy: number, volume: number, added: number): WaterState {
  return calculateState(mass, energy + added, volume);
}

export function effectiveSpecificHeat(state: WaterState): number {
  if (state.phase === 'liquid') return liquidCv(state.temperature);
  if (state.phase === 'vapor') return vaporCv(state.temperature);
  return latentHeat(state.temperature) / 10;
}

export function energyFromTemperature(T: number, phase: 'liquid' | 'two-phase' | 'vapor', quality = 0): number {
  if (phase === 'liquid') return saturatedLiquidEnergy(T);
  if (phase === 'vapor') return saturatedVaporEnergy(T);
  const u_f = saturatedLiquidEnergy(T);
  const u_g = saturatedVaporEnergy(T);
  return u_f + quality * (u_g - u_f);
}

export function massFromDensityVolume(density: number, volume: number): number {
  return density * volume;
}

export interface StabilityInfo {
  regime: string;
  isStiff: boolean;
  characteristicTime: number;
  warnings: string[];
}

export function analyzeStability(state: WaterState, volume: number): StabilityInfo {
  // Use thermal diffusion timescale, not acoustic timescale
  // Acoustic waves (L / 1500 m/s) are too fast to matter for thermal-hydraulics
  // Thermal equilibration happens on timescales of seconds, not microseconds
  const L = Math.cbrt(volume);
  // Characteristic time based on convective transport (typical flow velocity ~1-10 m/s)
  // and thermal diffusion (much slower than acoustic)
  const ct = state.phase === 'liquid' ? L / 10 : L / 50;  // ~0.1s for 1m³ liquid, ~0.02s for vapor
  return { regime: state.phase, isStiff: state.phase === 'liquid', characteristicTime: ct, warnings: [] };
}

export function suggestMaxTimestep(state: WaterState, volume: number): number {
  // Allow larger timesteps - thermal-hydraulic simulations don't need to resolve acoustics
  // Floor at 10ms (was 1μs), cap at 500ms (was 100ms)
  return Math.max(0.01, Math.min(analyzeStability(state, volume).characteristicTime * 0.5, 0.5));
}

// ============================================================================
// Pressure Feedback Model - Shared Utility
// ============================================================================

/**
 * Bulk modulus of water as a function of temperature.
 * Data from bulk-modulus.txt - decreases significantly near critical point.
 * Values in [temperature °C, bulk modulus MPa].
 */
const BULK_MODULUS_DATA: [number, number][] = [
  [0.01, 1964.64],
  [10, 2091.18],
  [20, 2178.65],
  [30, 2233.14],
  [40, 2259.89],
  [50, 2263.47],
  [60, 2246.69],
  [70, 2213.37],
  [80, 2166.38],
  [90, 2107.93],
  [100, 2039.98],
  [110, 1964.25],
  [120, 1882.18],
  [130, 1795.33],
  [140, 1705.03],
  [150, 1611.86],
  [160, 1516.76],
  [170, 1420.66],
  [180, 1323.98],
  [190, 1227.75],
  [200, 1132.25],
  [210, 1037.99],
  [220, 945.18],
  [230, 855.43],
  [240, 767.46],
  [250, 682.59],
  [260, 600.96],
  [270, 523.01],
  [280, 448.63],
  [290, 378.50],
  [300, 312.70],
  [310, 251.51],
  [320, 195.35],
  [330, 144.51],
  [340, 99.21],
  [350, 59.56],
  [360, 26.68],
];

/**
 * Get the bulk modulus of water at a given temperature.
 * Uses linear interpolation on tabulated data.
 *
 * @param T_celsius - Temperature in degrees Celsius
 * @returns Bulk modulus in Pa
 */
export function bulkModulus(T_celsius: number): number {
  const data = BULK_MODULUS_DATA;

  // Clamp to data range
  if (T_celsius <= data[0][0]) {
    return data[0][1] * 1e6; // Convert MPa to Pa
  }
  if (T_celsius >= data[data.length - 1][0]) {
    return data[data.length - 1][1] * 1e6; // Convert MPa to Pa
  }

  // Binary search for bracket
  let lo = 0, hi = data.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (data[mid][0] <= T_celsius) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  // Linear interpolation
  const [T1, K1] = data[lo];
  const [T2, K2] = data[hi];
  const t = (T_celsius - T1) / (T2 - T1);
  const K_MPa = K1 + t * (K2 - K1);

  return K_MPa * 1e6; // Convert MPa to Pa
}

/**
 * @deprecated Use bulkModulus(T_celsius) instead for temperature-dependent bulk modulus.
 * These constants are retained for reference but should not be used in new code.
 * The actual bulk modulus varies from ~2200 MPa at 50°C to ~60 MPa at 350°C.
 */
export const PRESSURE_MODEL = {
  /** @deprecated Use bulkModulus(T_celsius) instead */
  K_PHYSICAL: 2.2e9,
  /** @deprecated Use bulkModulus(T_celsius) instead */
  K_FEEDBACK: 1e8,
} as const;

/**
 * Result of computing expected density and feedback pressure.
 */
export interface PressureFeedbackResult {
  /** Expected density at (P_base, u) from steam tables or saturation */
  rho_expected: number;
  /** Feedback pressure deviation: K_feedback * (rho - rho_expected) / rho_expected */
  dP_feedback: number;
  /** Final pressure: P_base + dP_feedback */
  P_final: number;
  /** Whether steam table lookup was used (vs saturation fallback) */
  usedTableLookup: boolean;
}

/**
 * Compute the expected density and feedback pressure for a liquid node.
 *
 * This implements the hybrid pressure model:
 * P = P_base + K_feedback * (ρ - ρ_expected) / ρ_expected
 *
 * Where ρ_expected is looked up from steam tables at (P_base, u).
 * This accounts for thermal expansion: as fluid heats up, ρ_expected
 * decreases, so there's no spurious pressure rise from expansion alone.
 *
 * @param rho - Actual density (kg/m³) = mass / volume
 * @param P_base - Base pressure (Pa) from two-phase node via BFS
 * @param u_specific - Specific internal energy (J/kg)
 * @param T - Temperature (K) - used for fallback calculation
 * @returns Pressure feedback result with expected density and pressures
 */
export function computePressureFeedback(
  rho: number,
  P_base: number,
  u_specific: number,
  T: number
): PressureFeedbackResult {
  // Use temperature-dependent bulk modulus for realistic pressure response
  // At high temperatures (350°C), K drops to ~60 MPa, giving softer response
  const T_C = T - 273.15;
  const K_feedback = bulkModulus(T_C);

  // Steam table lookup - this MUST succeed for valid liquid states
  const rho_table = lookupCompressedLiquidDensity(P_base, u_specific);

  if (rho_table === null) {
    // This is a physically impossible state - the internal energy is too high
    // for this pressure to correspond to liquid. The fluid should be boiling.
    const P_bar = P_base / 1e5;
    const u_kJ = u_specific / 1000;
    const P_sat = saturationPressure(T);
    const P_sat_bar = P_sat / 1e5;
    throw new Error(
      `Invalid liquid state: P_base=${P_bar.toFixed(1)} bar, u=${u_kJ.toFixed(0)} kJ/kg, T=${T_C.toFixed(0)}C. ` +
      `At T=${T_C.toFixed(0)}C, P_sat=${P_sat_bar.toFixed(1)} bar. ` +
      `The fluid should be boiling (two-phase), not liquid. Check that P_base is set correctly from pressurizer.`
    );
  }

  const rho_expected = rho_table;

  // Compute feedback pressure deviation using temperature-dependent K
  const densityRatio = (rho - rho_expected) / rho_expected;
  const dP_feedback = K_feedback * densityRatio;
  const P_final = P_base + dP_feedback;

  return {
    rho_expected,
    dP_feedback,
    P_final,
    usedTableLookup: true,
  };
}

/**
 * Compute pressure for an isolated liquid region (no two-phase connection).
 *
 * Uses saturation pressure at the current temperature plus compression
 * feedback from excess mass.
 *
 * @param rho - Actual density (kg/m³)
 * @param T - Temperature (K)
 * @returns Pressure (Pa)
 */
export function computeIsolatedLiquidPressure(rho: number, T: number): number {
  // Use temperature-dependent bulk modulus for realistic pressure response
  const T_C = T - 273.15;
  const K_feedback = bulkModulus(T_C);

  const rho_sat = saturatedLiquidDensity(T);
  const P_sat = saturationPressure(T);
  const densityRatio = (rho - rho_sat) / rho_sat;
  const dP_compression = K_feedback * densityRatio;

  return P_sat + Math.max(0, dP_compression);
}

// ============================================================================
// Round-Trip Verification for (P,u)->ρ Interpolation
// ============================================================================

/**
 * Debug flag to enable round-trip verification logging.
 * When enabled, verifyPressureDensityRoundTrip will log results.
 */
let roundTripVerificationEnabled = false;

/**
 * Enable or disable round-trip verification logging.
 */
export function setRoundTripVerification(enabled: boolean): void {
  roundTripVerificationEnabled = enabled;
}

/**
 * Result of a round-trip verification test.
 */
export interface RoundTripResult {
  /** Input pressure (Pa) */
  P_input: number;
  /** Input specific internal energy (J/kg) */
  u_input: number;
  /** Interpolated density from (P,u) lookup (kg/m³) */
  rho_interp: number | null;
  /** Specific volume derived from interpolated density (m³/kg) */
  v_derived: number | null;
  /** Pressure recovered from (u,v) lookup via calculateState (Pa) */
  P_recovered: number | null;
  /** Absolute pressure error (Pa) */
  P_error: number | null;
  /** Relative pressure error (%) */
  P_error_pct: number | null;
  /** Whether the lookup succeeded */
  success: boolean;
}

/**
 * Perform a round-trip verification of the (P,u)->ρ interpolation.
 *
 * Process:
 * 1. Given (P, u), look up ρ using lookupCompressedLiquidDensity
 * 2. Compute v = 1/ρ
 * 3. Call calculateState with (m=1, U=u, V=v) to get P back
 * 4. Compare original P with recovered P
 *
 * This tests whether the (P,u)->ρ interpolation is consistent with
 * the (u,v)->P interpolation used by calculateState.
 *
 * @param P - Pressure in Pa
 * @param u - Specific internal energy in J/kg
 * @returns Round-trip verification result
 */
export function verifyPressureDensityRoundTrip(P: number, u: number): RoundTripResult {
  // Step 1: Look up density at (P, u) using compressed liquid triangulation
  const rho_interp = lookupCompressedLiquidDensity(P, u);

  if (rho_interp === null) {
    const result: RoundTripResult = {
      P_input: P,
      u_input: u,
      rho_interp: null,
      v_derived: null,
      P_recovered: null,
      P_error: null,
      P_error_pct: null,
      success: false,
    };
    if (roundTripVerificationEnabled) {
      console.log(`[RoundTrip] FAILED: No density found at P=${(P/1e6).toFixed(2)}MPa, u=${(u/1e3).toFixed(1)}kJ/kg`);
    }
    return result;
  }

  // Step 2: Compute specific volume from interpolated density
  const v_derived = 1 / rho_interp;

  // Step 3: Use direct steam table lookup (u, v) → P
  // This uses the main Delaunay triangulation in (logV, u) space
  const P_recovered = lookupPressureFromUV(u, v_derived);

  if (P_recovered === null) {
    const result: RoundTripResult = {
      P_input: P,
      u_input: u,
      rho_interp,
      v_derived,
      P_recovered: null,
      P_error: null,
      P_error_pct: null,
      success: false,
    };
    if (roundTripVerificationEnabled) {
      console.log(`[RoundTrip] FAILED: No P found at u=${(u/1e3).toFixed(1)}kJ/kg, v=${v_derived.toFixed(6)}m³/kg`);
    }
    return result;
  }

  // Step 4: Compare
  const P_error = Math.abs(P_recovered - P);
  const P_error_pct = (P_error / P) * 100;

  const result: RoundTripResult = {
    P_input: P,
    u_input: u,
    rho_interp,
    v_derived,
    P_recovered,
    P_error,
    P_error_pct,
    success: true,
  };

  if (roundTripVerificationEnabled) {
    const P_bar_in = P / 1e5;
    const P_bar_out = P_recovered / 1e5;
    const u_kJ = u / 1e3;
    const symbol = P_error_pct < 1 ? '✓' : P_error_pct < 5 ? '~' : '✗';
    console.log(
      `[RoundTrip] ${symbol} P_in=${P_bar_in.toFixed(1)}bar, u=${u_kJ.toFixed(0)}kJ/kg ` +
      `→ ρ=${rho_interp.toFixed(1)}kg/m³ → P_out=${P_bar_out.toFixed(1)}bar ` +
      `(err=${P_error_pct.toFixed(2)}%)`
    );
  }

  return result;
}

/**
 * Run a batch of round-trip verification tests across the compressed liquid region.
 * Returns summary statistics.
 */
export function runRoundTripTests(): {
  total: number;
  succeeded: number;
  failed: number;
  maxError_pct: number;
  avgError_pct: number;
  results: RoundTripResult[];
} {
  const results: RoundTripResult[] = [];

  // Test points spanning typical PWR operating range
  // Pressure: 50 bar to 170 bar
  // u: 800 kJ/kg (cold) to 1650 kJ/kg (hot, near saturation)
  const testPressures = [50e5, 80e5, 100e5, 120e5, 140e5, 155e5, 160e5, 170e5]; // Pa
  const testEnergies = [800e3, 1000e3, 1200e3, 1400e3, 1500e3, 1600e3, 1650e3]; // J/kg

  for (const P of testPressures) {
    for (const u of testEnergies) {
      const result = verifyPressureDensityRoundTrip(P, u);
      results.push(result);
    }
  }

  const succeeded = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  const successfulResults = results.filter(r => r.success && r.P_error_pct !== null);
  const maxError_pct = successfulResults.length > 0
    ? Math.max(...successfulResults.map(r => r.P_error_pct!))
    : 0;
  const avgError_pct = successfulResults.length > 0
    ? successfulResults.reduce((sum, r) => sum + r.P_error_pct!, 0) / successfulResults.length
    : 0;

  console.log(`\n[RoundTrip Summary] Total: ${results.length}, Success: ${succeeded}, Failed: ${failed}`);
  console.log(`[RoundTrip Summary] Max error: ${maxError_pct.toFixed(2)}%, Avg error: ${avgError_pct.toFixed(2)}%`);

  return {
    total: results.length,
    succeeded,
    failed,
    maxError_pct,
    avgError_pct,
    results,
  };
}

/**
 * Direct steam table lookup: (u, v) → P
 *
 * Uses the Delaunay triangulation in (log(v), u) space to interpolate
 * pressure directly from steam table data. This bypasses the hybrid
 * pressure model used in calculateState.
 *
 * For liquid-region queries (v < 0.01 m³/kg), this now uses a liquid-only
 * triangulation to avoid triangles that span the saturation dome.
 *
 * @param u - Specific internal energy (J/kg)
 * @param v - Specific volume (m³/kg)
 * @returns Pressure in Pa, or null if outside interpolation domain
 */
export function lookupPressureFromUV(u: number, v: number): number | null {
  loadData();

  if (v <= 0 || !isFinite(u) || !isFinite(v)) {
    return null;
  }

  // For liquid-region queries, use the liquid-only triangulation
  // This avoids triangles that span from saturated liquid to saturated vapor
  // Cutoff at v < 0.0032 m³/kg (just above critical point v_c ≈ 0.00317)
  if (v < 0.0032) {
    const P_liquid = lookupPressureFromUV_LiquidOnly(u, v);
    if (P_liquid !== null) {
      return P_liquid;
    }
    // Fall through to general triangulation if liquid-only fails
  }

  const logV = Math.log10(v);

  // Find containing triangle in (logV, u) space
  const tri = findContainingTriangle(logV, u);

  if (!tri) {
    return null;  // Point not in any triangle
  }

  // Validate the triangle - reject if it spans incompatible phases
  // A triangle spanning liquid and vapor would give nonsense results
  const pt0 = dataPoints[tri.i];
  const pt1 = dataPoints[tri.j];
  const pt2 = dataPoints[tri.k];

  const hasLiquid = pt0.phase === 'liquid' || pt0.phase === 'saturated liquid' ||
                    pt1.phase === 'liquid' || pt1.phase === 'saturated liquid' ||
                    pt2.phase === 'liquid' || pt2.phase === 'saturated liquid';
  const hasVapor = pt0.phase === 'vapor' || pt0.phase === 'saturated vapor' ||
                   pt1.phase === 'vapor' || pt1.phase === 'saturated vapor' ||
                   pt2.phase === 'vapor' || pt2.phase === 'saturated vapor';

  if (hasLiquid && hasVapor) {
    // This triangle spans across the saturation dome - unreliable
    if (v < 0.0032) {
      // Already tried liquid-only and failed, return null
      return null;
    }
    // Otherwise proceed with caution (might be near two-phase or supercritical)
  }

  // Interpolate pressure using barycentric coordinates
  const P = barycentricInterpolate(logV, u, tri, [
    pt0.P,
    pt1.P,
    pt2.P,
  ]);

  return P;
}

/**
 * Diagnostic function to investigate why a (u, v) lookup might fail.
 * Returns information about nearby points in the triangulation.
 */
export function diagnoseUVLookup(u: number, v: number): {
  logV: number;
  inGrid: boolean;
  gridCell: { x: number; y: number } | null;
  trianglesInCell: number;
  nearestPoints: Array<{
    idx: number;
    logV: number;
    u: number;
    P_bar: number;
    phase: string;
    distance: number;
  }>;
  foundTriangle: boolean;
  triangleVertices: Array<{
    idx: number;
    logV: number;
    u: number;
    P_bar: number;
    phase: string;
  }> | null;
  trianglesWithNearestPoints: Array<{
    triIdx: number;
    vertices: Array<{ idx: number; logV: number; u: number; P_bar: number; phase: string }>;
  }>;
} {
  loadData();

  const logV = Math.log10(v);

  // Check if in grid bounds
  const cellX = Math.floor((logV - gridMinLogV) / gridCellWidth);
  const cellY = Math.floor((u - gridMinU) / gridCellHeight);
  const inGrid = cellX >= 0 && cellX < gridCellsX && cellY >= 0 && cellY < gridCellsY;

  let trianglesInCell = 0;
  if (inGrid) {
    trianglesInCell = grid[cellX][cellY].triangleIndices.length;
  }

  // Find nearest points
  const nearestPoints: Array<{
    idx: number;
    logV: number;
    u: number;
    P_bar: number;
    phase: string;
    distance: number;
  }> = [];

  // Normalize distance calculation (logV and u have very different scales)
  const logVScale = 1;
  const uScale = 1e-6;  // Scale u down to similar magnitude as logV

  for (let i = 0; i < dataPoints.length; i++) {
    const pt = dataPoints[i];
    const dLogV = (pt.logV - logV) * logVScale;
    const dU = (pt.u - u) * uScale;
    const dist = Math.sqrt(dLogV * dLogV + dU * dU);

    if (nearestPoints.length < 10 || dist < nearestPoints[nearestPoints.length - 1].distance) {
      nearestPoints.push({
        idx: i,
        logV: pt.logV,
        u: pt.u,
        P_bar: pt.P / 1e5,
        phase: pt.phase,
        distance: dist,
      });
      nearestPoints.sort((a, b) => a.distance - b.distance);
      if (nearestPoints.length > 10) nearestPoints.pop();
    }
  }

  // Try to find containing triangle
  const tri = findContainingTriangle(logV, u);
  let triangleVertices: Array<{
    idx: number;
    logV: number;
    u: number;
    P_bar: number;
    phase: string;
  }> | null = null;

  if (tri) {
    triangleVertices = [
      {
        idx: tri.i,
        logV: dataPoints[tri.i].logV,
        u: dataPoints[tri.i].u,
        P_bar: dataPoints[tri.i].P / 1e5,
        phase: dataPoints[tri.i].phase,
      },
      {
        idx: tri.j,
        logV: dataPoints[tri.j].logV,
        u: dataPoints[tri.j].u,
        P_bar: dataPoints[tri.j].P / 1e5,
        phase: dataPoints[tri.j].phase,
      },
      {
        idx: tri.k,
        logV: dataPoints[tri.k].logV,
        u: dataPoints[tri.k].u,
        P_bar: dataPoints[tri.k].P / 1e5,
        phase: dataPoints[tri.k].phase,
      },
    ];
  }

  // Find triangles that include the nearest points
  const nearestIndices = new Set(nearestPoints.slice(0, 5).map(p => p.idx));
  const trianglesWithNearestPoints: Array<{
    triIdx: number;
    vertices: Array<{ idx: number; logV: number; u: number; P_bar: number; phase: string }>;
  }> = [];

  for (let tIdx = 0; tIdx < triangles.length; tIdx++) {
    const t = triangles[tIdx];
    const hasNearest = nearestIndices.has(t.i) || nearestIndices.has(t.j) || nearestIndices.has(t.k);
    if (hasNearest) {
      trianglesWithNearestPoints.push({
        triIdx: tIdx,
        vertices: [
          { idx: t.i, logV: dataPoints[t.i].logV, u: dataPoints[t.i].u, P_bar: dataPoints[t.i].P / 1e5, phase: dataPoints[t.i].phase },
          { idx: t.j, logV: dataPoints[t.j].logV, u: dataPoints[t.j].u, P_bar: dataPoints[t.j].P / 1e5, phase: dataPoints[t.j].phase },
          { idx: t.k, logV: dataPoints[t.k].logV, u: dataPoints[t.k].u, P_bar: dataPoints[t.k].P / 1e5, phase: dataPoints[t.k].phase },
        ],
      });
    }
  }

  return {
    logV,
    inGrid,
    gridCell: inGrid ? { x: cellX, y: cellY } : null,
    trianglesInCell,
    nearestPoints,
    foundTriangle: tri !== null,
    triangleVertices,
    trianglesWithNearestPoints,
  };
}

/**
 * Get diagnostic info about the compressed liquid interpolation domain.
 */
export function getCompressedLiquidDomainInfo(): {
  ready: boolean;
  numPoints: number;
  numTriangles: number;
  logP_range: [number, number] | null;
  P_range_bar: [number, number] | null;
  u_range_kJ: [number, number] | null;
} {
  if (!clDataReady || clPoints.length === 0) {
    return {
      ready: false,
      numPoints: 0,
      numTriangles: 0,
      logP_range: null,
      P_range_bar: null,
      u_range_kJ: null,
    };
  }

  return {
    ready: true,
    numPoints: clPoints.length,
    numTriangles: clTriangles.length,
    logP_range: [clGridMinLogP, clGridMaxLogP],
    P_range_bar: [Math.pow(10, clGridMinLogP) / 1e5, Math.pow(10, clGridMaxLogP) / 1e5],
    u_range_kJ: [clGridMinU / 1e3, clGridMaxU / 1e3],
  };
}

/**
 * Get all data points for visualization.
 * Returns array of points with their properties for plotting.
 */
export function getAllDataPoints(): Array<{
  v: number;     // m³/kg
  u: number;     // kJ/kg
  P: number;     // bar
  T: number;     // °C
  phase: string;
  isInterpolated: boolean;
}> {
  loadData();

  // The first ~7500 points are original, the rest are interpolated
  // We can identify interpolated points by their index
  const originalCount = dataPoints.length - 322 - 88;  // Subtract interpolated counts

  return dataPoints.map((pt, idx) => ({
    v: pt.v,
    u: pt.u / 1000,  // Convert J/kg to kJ/kg
    P: pt.P / 1e5,   // Convert Pa to bar
    T: pt.T - 273.15, // Convert K to °C
    phase: pt.phase,
    isInterpolated: idx >= originalCount,
  }));
}
