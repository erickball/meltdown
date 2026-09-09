/**
 * What a spent-fuel pool is doing, in the numbers a player has to read.
 *
 * There is exactly one of these so the picture and the panel cannot
 * disagree: the grid view's cut-away drawing, the gauges on it, and the
 * selected-component panel all take their level, their rack temperature and
 * their state word from here.
 *
 * NOTHING in this file decides anything. Every field is either a stored
 * dimension of the pool or a number the simulation produced this step; the
 * state word is a comparison between two of them (see `poolState`).
 */

import { PoolComponent, Fluid } from '../types';
import { SimulationState } from '../simulation';
import { getCladdingOxidationPower } from '../simulation/operators/rate-operators';
import { fireIntensity } from './fire-fx';
import { getLiquidFraction } from './components';

/**
 * The one word that says what is happening to the fuel.
 *
 *  - `covered`    - water stands over the top of the active fuel.
 *  - `uncovering` - the level is inside the fuel band: part of the rack is
 *                   in steam, which is where the heat-transfer model stops
 *                   taking the whole surface to liquid.
 *  - `uncovered`  - the level is below the bottom of the fuel.
 *  - `dry`        - no liquid left in the pool at all.
 *  - `oxidising`  - the cladding is reacting, but the chemistry is still
 *                   smaller than the decay heat.
 *  - `burning`    - the chemical power has passed the decay power: the fire
 *                   is now the bigger heat source and drives itself.
 */
export type PoolState =
  'covered' | 'uncovering' | 'uncovered' | 'dry' | 'oxidising' | 'burning';

export interface PoolReadout {
  /** Depth of liquid standing on the floor (m). */
  level: number;
  /** Floor-to-rim depth of the basin (m). */
  depth: number;
  /** Bottom and top of the ACTIVE FUEL above the floor (m). */
  rackBottom: number;
  rackTop: number;
  /** level - rackTop: positive is water over the fuel. */
  overFuel: number;
  /** Fraction of the active fuel band standing under water (0-1). */
  coveredFraction: number;
  /** Water temperature (K), and whether it is at its own saturation. */
  waterK: number;
  /** Cladding (rack) and pellet temperatures (K); null with no simulation. */
  cladK: number | null;
  pelletK: number | null;
  /** Decay heat the stored fuel makes (W). */
  decayW: number;
  /** Chemical power the cladding released this step (W). */
  oxidationW: number;
  /** Fraction of the cladding metal consumed (0-1). */
  oxidizedFraction: number;
  /**
   * Whether the chemistry is releasing enough power to be worth showing.
   * The SAME question the flames ask (`fireIntensity` in fire-fx.ts), so the
   * word and the picture turn on together: a rack that is drawn alight is
   * never described as merely covered. It is a display floor, not a physical
   * one - the reaction runs underneath it whatever this says.
   */
  reacting: boolean;
  state: PoolState;
}

/** The state word, from the numbers above and nothing else. */
function poolState(r: Omit<PoolReadout, 'state'>): PoolState {
  // Chemistry first, and only when it is actually releasing power. The
  // dividing line between "reacting" and "burning" is not a temperature or a
  // rate constant - it is whether the reaction has become the larger heat
  // source, which is the same statement as a self-sustaining excursion.
  if (r.oxidationW > 0 && r.oxidationW >= r.decayW) return 'burning';
  if (r.reacting) return 'oxidising';
  if (r.level <= 0) return 'dry';
  if (r.level >= r.rackTop) return 'covered';
  if (r.level > r.rackBottom) return 'uncovering';
  return 'uncovered';
}

/**
 * Read a pool.
 *
 * `simState` may be null (construction mode, or a plant that has not been
 * built yet); then the level comes from the stored fill level and the fuel
 * temperatures are unknown rather than invented.
 */
export function poolReadout(
  pool: PoolComponent,
  simState: SimulationState | null,
  isSimulating: boolean
): PoolReadout {
  const depth = pool.depth || 12;
  const level = getLiquidFraction(pool, pool.fluid ?? ({} as Fluid), isSimulating) * depth;
  const rackBottom = pool.rackBottomElevation ?? 0.5;
  const rackTop = rackBottom + (pool.rackHeight || 3.66);
  const band = Math.max(rackTop - rackBottom, 1e-9);

  const cladNode = simState?.thermalNodes.get(`${pool.id}-clad`) ?? null;
  const pelletNode = simState?.thermalNodes.get(`${pool.id}-pellets`) ?? null;
  const oxidationW = simState
    ? (getCladdingOxidationPower().get(`${pool.id}-clad`) ?? 0)
    : 0;

  const base = {
    level,
    depth,
    rackBottom,
    rackTop,
    overFuel: level - rackTop,
    coveredFraction: Math.max(0, Math.min(1, (level - rackBottom) / band)),
    waterK: pool.fluid?.temperature ?? 293.15,
    // The rack temperature synced onto the component is the same node; read
    // the node itself when there is one so the panel never lags a frame.
    cladK: cladNode ? cladNode.temperature : (pool.rackTemperature ?? null),
    pelletK: pelletNode ? pelletNode.temperature : null,
    decayW: pool.fuelPower ?? 0,
    oxidationW,
    oxidizedFraction: cladNode?.oxidation?.oxidizedFraction ?? 0,
    reacting: fireIntensity(oxidationW) > 0,
  };
  return { ...base, state: poolState(base) };
}

/** The state word as the interface spells it, and the colour it is drawn in. */
export function poolStateLabel(state: PoolState): { text: string; color: string } {
  switch (state) {
    case 'covered': return { text: 'COVERED', color: '#6fc3f0' };
    case 'uncovering': return { text: 'UNCOVERING', color: '#f0c04a' };
    case 'uncovered': return { text: 'UNCOVERED', color: '#f08a3c' };
    case 'dry': return { text: 'DRY', color: '#f0663c' };
    case 'oxidising': return { text: 'OXIDISING', color: '#ff8a2a' };
    case 'burning': return { text: 'BURNING', color: '#ff3b1f' };
  }
}
