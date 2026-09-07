/**
 * Terrain description carried by a plant: a height field over the plan and
 * the water bodies (sea, lakes) on it. Plain data with no imports, shared by
 * the plant description (src/types.ts) and the simulation (src/simulation/
 * terrain.ts), like scenario-types.ts.
 */

export interface TerrainPoint {
  x: number;
  y: number;
}

export interface WaterBodySpec {
  /** Name used by scenario events ('sea', 'lake'). */
  id: string;
  /** Any plan point inside the body: the basin containing it is the body. */
  seed: TerrainPoint;
  /** Surface height (m above datum). */
  surface: number;
}

export interface TerrainSpec {
  /** Plan position of the centre of cell (0, 0). */
  origin: TerrainPoint;
  /** Cell pitch (m). */
  cellSize: number;
  cols: number;
  rows: number;
  /** Ground height per cell, row-major (rows x cols), metres above datum. */
  heights: number[];
  /** Infiltration rate of open ground (m/s of water through the wetted area). Default 1e-4 (gravelly soil). */
  infiltration?: number;
  waters?: WaterBodySpec[];
}
