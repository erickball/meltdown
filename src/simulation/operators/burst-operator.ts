/**
 * Burst Check Operator
 *
 * Checks all pressurized components for overpressure conditions and initiates/updates bursts.
 * Components burst when gauge pressure (relative to container) exceeds their burst threshold.
 *
 * Key mechanics:
 * - Burst pressure = design rating + random 0-40% margin (calculated at sim start)
 * - Break size scales with overpressure: 1% at burst, ~20% at 1.5x burst, cap at 100%
 * - Breaks can only grow, not shrink
 * - Break connections are bidirectional to container (or atmosphere if no container)
 * - HX tubes burst based on pressure differential vs shell side
 */

import {
  SimulationState,
  FlowNode,
  BurstState,
  BurstConfig,
  DEFAULT_BURST_CONFIG,
} from '../types';
import { ConstraintOperator } from '../rk45-solver';
import { cloneSimulationState } from '../solver';
import { meltFraction } from './rate-operators';
import { basematErodedDepth } from './mcci';
import { MATERIALS, DEFAULT_MATERIAL, type StructuralMaterial } from '../materials';

/**
 * Deterministic pseudo-random number generator.
 * Returns a value between 0 and 1 based on the seed.
 */
function seededRandom(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Calculate break fraction based on overpressure ratio.
 *
 * Uses quadratic interpolation from minBreak at burst pressure
 * to maxBreak at (1 + fullBreakOverpressure) * burstPressure.
 * Includes deterministic random variation based on seed.
 *
 * The quadratic curve gives:
 * - Slow initial growth right at burst pressure
 * - Accelerating growth as overpressure increases
 */
function calculateBreakFraction(
  currentPressure: number,
  burstPressure: number,
  config: BurstConfig,
  randomSeed: number
): number {
  if (currentPressure <= burstPressure) return 0;

  // Overpressure ratio: 0 at burst, fullBreakOverpressure at design max
  const ratio = (currentPressure - burstPressure) / burstPressure;
  const t = Math.min(1, ratio / config.fullBreakOverpressure);

  // Quadratic growth: slow start, accelerates with overpressure
  const baseFraction = config.minBreakFraction +
    (config.maxBreakFraction - config.minBreakFraction) * t * t;

  // Apply deterministic random variation
  // The seed varies slightly with ratio to give different random factors at different pressures
  const randomFactor = 1 + (seededRandom(randomSeed + ratio * 1000) - 0.5) * 2 * config.breakSizeRandomness;

  return Math.min(config.maxBreakFraction, Math.max(0, baseFraction * randomFactor));
}

// ============================================================================
// Creep rupture (Larson-Miller, time-fraction damage)
// ============================================================================
// Membrane stress relative to ultimate is the pressure ratio s = P/P_burst
// (P_burst is where the wall reaches ultimate strength by construction).
// Larson-Miller: LMP = T·(C + log10(t_r[h])), with the required LMP at a given
// stress ratio LMP_req(s) = A - B·log10(s). (C, A, B) are per-MATERIAL and live
// in materials.ts - a low-alloy-steel duct and an Alloy 800H duct at the same
// temperature and stress differ by a factor of thousands in rupture life, which
// is precisely why gas reactors use 800H for hot ducts and SG tubing.
// Cold components get astronomically long rupture times - no thresholds.

/**
 * Creep rupture time (seconds) at stress ratio s = P/P_burst and wall T (K),
 * for the given structural material (default: low-alloy steel, the original
 * behaviour for every component that does not declare one).
 */
export function creepRuptureTime(
  stressRatio: number,
  wallTempK: number,
  material: StructuralMaterial = DEFAULT_MATERIAL
): number {
  if (stressRatio <= 0) return Infinity;
  if (stressRatio >= 1) return 0;
  const m = MATERIALS[material];
  const lmpRequired = m.lmA - m.lmB * Math.log10(stressRatio);
  const log10Hours = lmpRequired / wallTempK - m.lmC;
  return Math.pow(10, log10Hours) * 3600;
}

/**
 * Checks all pressurized components for burst conditions.
 * Creates/updates break connections when components burst.
 */
export class BurstCheckOperator implements ConstraintOperator {
  name = 'BurstCheck';

  // Bursting is irreversible - it must only be decided from ACCEPTED states.
  // finalOnly was not enough: end-of-step candidates still run finalOnly
  // constraints BEFORE the accept/reject decision, so transient garbage
  // pressures (which the sanity check then rejects) were announcing - and in
  // the worst case committing - phantom bursts. postAcceptOnly runs strictly
  // after acceptance.
  postAcceptOnly = true;

  applyConstraints(state: SimulationState, dt?: number): SimulationState {
    // If no burst states are configured, nothing to do
    if (!state.burstStates || state.burstStates.size === 0) {
      return state;
    }

    const newState = cloneSimulationState(state);
    const config = newState.burstConfig ?? DEFAULT_BURST_CONFIG;

    // Safety check after clone (burstStates should be preserved)
    if (!newState.burstStates) {
      return newState;
    }

    for (const [nodeId, burstState] of newState.burstStates) {
      const node = newState.flowNodes.get(nodeId);
      if (!node) continue;

      // Calculate gauge pressure relative to container (can be positive or negative)
      const gaugePressure = this.getGaugePressure(node, burstState, newState);

      // Check for new failure (burst from internal overpressure or collapse from external)
      if (!burstState.isBurst) {
        if (gaugePressure > burstState.burstPressure) {
          // Internal overpressure - burst
          this.initiateBurst(burstState, gaugePressure, newState, config, false);
        } else if (-gaugePressure > burstState.collapsePressure) {
          // External overpressure - collapse (treated same as burst for now)
          this.initiateBurst(burstState, -gaugePressure, newState, config, true);
        } else if (dt !== undefined && dt > 0 && gaugePressure > 0) {
          // Creep damage: a hot pressurized wall fails below its burst
          // pressure given time (SG tube rupture, vessel lower head).
          const wallT = this.updateWallTemperature(node, burstState, newState, dt);
          const tRupture = creepRuptureTime(
            gaugePressure / burstState.burstPressure, wallT, burstState.material);
          if (isFinite(tRupture) && tRupture > 0) {
            burstState.creepDamage = (burstState.creepDamage ?? 0) + dt / tRupture;
            if (burstState.creepDamage >= 1) {
              // The creeping wall has weakened to the current load: rupture
              // now, with the failure threshold at today's pressure so the
              // break starts small and can grow if pressure rises.
              burstState.isCreepRupture = true;
              burstState.burstPressure = gaugePressure;
              this.initiateBurst(burstState, gaugePressure, newState, config, false);
            }
          }
        }
      }

      // Lower-head melt-through: the corium pool has melted the head open
      // (CoriumRelocationRateOperator is pouring the melt out). Open the
      // vessel's FLUID break at the bottom too - water/steam drain through
      // the same hole, whose size follows the melted-away head fraction.
      if (!burstState.isMeltThrough) {
        const head = newState.thermalNodes.get(`${burstState.componentId}-lowerhead`);
        if (head && meltFraction(head) > 0.1) {
          burstState.isMeltThrough = true;
          if (!burstState.isBurst) {
            // Break at the vessel bottom (not the seeded random elevation)
            burstState.breakElevation = node.elevation;
            this.initiateBurst(burstState, gaugePressure, newState, config, false);
          } else {
            // Already burst elsewhere (creep/overpressure): the head hole
            // now dominates the drain path - move the break to the bottom
            burstState.breakElevation = node.elevation;
            const conn = newState.flowConnections.find(c => c.id === `break-${burstState.nodeId}`);
            if (conn) conn.fromElevation = 0;
            if (!newState.pendingEvents) newState.pendingEvents = [];
            newState.pendingEvents.push({
              type: 'component-burst',
              message: `VESSEL BREACH: ${burstState.componentLabel} lower head melted through - ` +
                `corium relocating to containment floor`,
              data: { nodeId: burstState.nodeId, componentId: burstState.componentId },
            });
            console.log(`[BurstCheck] MELT-THROUGH: ${burstState.componentLabel} lower head at t=${newState.time.toFixed(1)}s`);
          }
        }
      }

      // Basemat melt-through (buildings with an MCCI debris attack): the
      // ablation front has passed the structural basemat thickness. No gas
      // break opens - the hole is plugged with melt - but this is the
      // ground-contamination consequence, reported once.
      if (!burstState.basematMeltThrough) {
        const basemat = newState.thermalNodes.get(`${burstState.nodeId}-basemat`);
        if (basemat && basematErodedDepth(newState, burstState.nodeId) > basemat.characteristicLength) {
          burstState.basematMeltThrough = true;
          if (!newState.pendingEvents) newState.pendingEvents = [];
          newState.pendingEvents.push({
            type: 'component-burst',
            message: `BASEMAT MELT-THROUGH: corium has eroded through the ` +
              `${burstState.componentLabel} basemat (${basemat.characteristicLength.toFixed(1)} m) - ` +
              `melt entering the ground`,
            data: { nodeId: burstState.nodeId, componentId: burstState.componentId },
          });
          console.log(`[BurstCheck] BASEMAT MELT-THROUGH: ${burstState.componentLabel} at t=${newState.time.toFixed(1)}s`);
        }
      }

      // Update break size for existing failures (can grow with increasing pressure differential)
      if (burstState.isBurst) {
        // Use absolute gauge pressure for break growth
        const effectivePressure = burstState.isCollapse ? -gaugePressure : gaugePressure;
        updateBreakSize(burstState, effectivePressure, newState, config);
      }
    }

    return newState;
  }

  /**
   * Wall temperature for creep. Components with a real metal thermal node
   * read it directly: HX tubes, and the vessel lower head once a corium
   * pool can heat it (a dry head under corium runs far above the steam
   * temperature). Everything else gets a first-order lag of the fluid
   * temperature: tau = (wall areal mass * cp) / h_film, ~1-2 minutes under
   * liquid contact (h ~ 2000 W/m2K on ~5 cm of steel) but HOURS under gas
   * contact (h ~ 30) - so a seconds-scale deflagration's 2000 K flame gas
   * does not instantly "creep-rupture" a cold steel shell (it did, before
   * the lag: the fluid-T-as-wall-T proxy held only for liquid contact).
   */
  private updateWallTemperature(
    node: FlowNode,
    burstState: BurstState,
    state: SimulationState,
    dt: number
  ): number {
    // Explicit metal node for this boundary (a component with more than one
    // pressure boundary names its own, e.g. a coaxial duct's inner liner and
    // outer shell, which run hundreds of K apart)
    if (burstState.wallNodeId) {
      const metal = state.thermalNodes.get(burstState.wallNodeId);
      if (metal) {
        burstState.wallTemperature = metal.temperature;
        return metal.temperature;
      }
    }
    if (burstState.isTubeSide) {
      const tubeMetal = state.thermalNodes.get(`${burstState.componentId}-tubes`);
      if (tubeMetal) {
        burstState.wallTemperature = tubeMetal.temperature;
        return tubeMetal.temperature;
      }
    }
    // Real wall node (wall thermal-node pass): read the metal directly
    const wallMetal = state.thermalNodes.get(`${burstState.componentId}-wall`);
    if (wallMetal) {
      const lowerHeadNode = state.thermalNodes.get(`${burstState.componentId}-lowerhead`);
      const wallT = lowerHeadNode
        ? Math.max(wallMetal.temperature, lowerHeadNode.temperature)
        : wallMetal.temperature;
      burstState.wallTemperature = wallT;
      return wallT;
    }
    const lowerHead = state.thermalNodes.get(`${burstState.componentId}-lowerhead`);

    const prev = burstState.wallTemperature ?? node.fluid.temperature;
    const gasContact = node.fluid.phase === 'vapor';
    const tau = gasContact ? 6000 : 90; // s - steel areal mass over film h
    const alpha = Math.min(1, dt / tau);
    let wallT = prev + alpha * (node.fluid.temperature - prev);

    // Creep is governed by the hottest part of the wall
    if (lowerHead) wallT = Math.max(wallT, lowerHead.temperature);

    burstState.wallTemperature = wallT;
    return wallT;
  }

  /**
   * Calculate gauge pressure (internal minus external).
   * Positive = internal overpressure (can burst)
   * Negative = external overpressure (can collapse)
   *
   * For HX tube side: compare to shell pressure
   * For all other components: compare to container pressure (or atmosphere if no container)
   */
  private getGaugePressure(
    node: FlowNode,
    burstState: BurstState,
    state: SimulationState
  ): number {
    const absolutePressure = node.fluid.pressure;

    // Nested boundary (HX tube inside its shell, duct liner inside its
    // annulus): the load is the differential, not the pressure vs containment
    if ((burstState.isTubeSide || burstState.isNestedBoundary) && burstState.shellNodeId) {
      const shell = state.flowNodes.get(burstState.shellNodeId);
      if (shell) {
        return absolutePressure - shell.fluid.pressure;
      }
    }

    // For all other components, use gauge pressure relative to container
    if (node.containerId) {
      const container = state.flowNodes.get(node.containerId);
      if (container) {
        return absolutePressure - container.fluid.pressure;
      }
    }

    // If no container, gauge pressure vs atmosphere (1 atm)
    return absolutePressure - 101325;
  }

  /**
   * Initiate a new burst or collapse event.
   * @param isCollapse - true if failure is due to external overpressure (collapse), false for internal (burst)
   */
  private initiateBurst(
    burstState: BurstState,
    pressure: number,
    state: SimulationState,
    config: BurstConfig,
    isCollapse: boolean
  ): void {
    burstState.isBurst = true;
    burstState.isCollapse = isCollapse;
    burstState.burstTime = state.time;

    // For pipes, assign break location along the length using the seed for determinism
    if (burstState.breakLocation === undefined) {
      burstState.breakLocation = seededRandom(burstState.breakSizeSeed + 12345);
    }

    // Calculate break elevation along component height using the seed
    // Uses a different seed offset to get independent randomness from breakLocation
    const node = state.flowNodes.get(burstState.nodeId);
    if (node && node.height !== undefined && node.height > 0) {
      const elevationFraction = seededRandom(burstState.breakSizeSeed + 67890);
      burstState.breakElevation = node.elevation + elevationFraction * node.height;
    } else if (node) {
      // If node has no height defined, use node's elevation as break point
      burstState.breakElevation = node.elevation;
    }

    // Calculate initial break fraction using the appropriate threshold
    const thresholdPressure = isCollapse ? burstState.collapsePressure : burstState.burstPressure;
    burstState.currentBreakFraction = calculateBreakFraction(
      pressure,
      thresholdPressure,
      config,
      burstState.breakSizeSeed
    );

    // Create break flow connection
    createBreakConnection(burstState, state, config);

    // Queue event for GameLoop to emit
    if (!state.pendingEvents) state.pendingEvents = [];
    const elevationStr = burstState.breakElevation !== undefined
      ? ` at ${burstState.breakElevation.toFixed(1)}m elevation`
      : '';
    const failureType = burstState.isMeltThrough ? 'lower head melted through'
      : burstState.isCreepRupture ? 'creep-ruptured'
      : isCollapse ? 'collapsed' : 'ruptured';
    const thresholdLabel = burstState.isMeltThrough ? 'melt-through'
      : burstState.isCreepRupture ? 'creep-weakened'
      : isCollapse ? 'collapse' : 'burst';
    state.pendingEvents.push({
      type: 'component-burst',
      message: `LOCA: ${burstState.componentLabel} ${failureType}${elevationStr} at ${(pressure / 1e5).toFixed(1)} bar differential (${thresholdLabel} threshold: ${(thresholdPressure / 1e5).toFixed(1)} bar)`,
      data: {
        nodeId: burstState.nodeId,
        componentId: burstState.componentId,
        pressure: pressure,
        burstPressure: burstState.burstPressure,
        collapsePressure: burstState.collapsePressure,
        isCollapse,
        breakFraction: burstState.currentBreakFraction,
        breakElevation: burstState.breakElevation,
      },
    });

    console.log(
      `[BurstCheck] ${isCollapse ? 'COLLAPSE' : 'BURST'}: ${burstState.componentLabel} at t=${state.time.toFixed(2)}s, ` +
      `ΔP=${(pressure / 1e5).toFixed(1)} bar, break=${(burstState.currentBreakFraction * 100).toFixed(1)}%`
    );
  }
}

/**
 * Create a break flow connection from the burst node to its container.
 *
 * Module level (not a method) because a scenario can open a break too - see
 * `applyScriptedBurst` - and both routes must produce the SAME flow path.
 */
function createBreakConnection(
  burstState: BurstState,
  state: SimulationState,
  config: BurstConfig
): void {
  const node = state.flowNodes.get(burstState.nodeId);
  if (!node) return;

  // Determine discharge target - always the container
  let targetNodeId: string;
  if ((burstState.isTubeSide || burstState.isNestedBoundary) && burstState.shellNodeId) {
    // A nested boundary discharges into the volume around it, not to
    // containment: tubes into the shell, a duct liner into its annulus
    targetNodeId = burstState.shellNodeId;
  } else if (node.containerId) {
    // Contained component breaks to container
    targetNodeId = node.containerId;
  } else {
    // Uncontained component breaks to atmosphere
    targetNodeId = 'atmosphere';
  }

  const breakConnId = `break-${burstState.nodeId}`;

  // Check if break connection already exists (shouldn't happen on first burst)
  let breakConn = state.flowConnections.find(c => c.id === breakConnId);

  if (!breakConn) {
    // Calculate break area based on node's flow area
    const breakArea = node.flowArea * burstState.currentBreakFraction;

    // Calculate fromElevation relative to node bottom
    // Use the pseudorandom break elevation if set, otherwise fall back to node midpoint
    const fromElev = burstState.breakElevation !== undefined
      ? burstState.breakElevation - node.elevation
      : (node.height ?? 0) / 2;

    // Generate random direction for the break (0 to 2π)
    // Use a different seed offset than break size to get independent randomness
    const breakDirection = seededRandom(burstState.breakSizeSeed + 7777) * Math.PI * 2;

    breakConn = {
      id: breakConnId,
      fromNodeId: burstState.nodeId,
      toNodeId: targetNodeId,
      flowArea: breakArea,
      hydraulicDiameter: Math.sqrt(4 * breakArea / Math.PI),
      length: 0.1,                         // Short path for break
      elevation: 0,                        // Net elevation change (break to target)
      fromElevation: fromElev,             // Elevation of break relative to node bottom
      resistanceCoeff: 2.0,                // Sharp-edged orifice
      massFlowRate: 0,
      isBreakConnection: true,
      burstSourceNodeId: burstState.nodeId,
      breakFraction: burstState.currentBreakFraction,
      breakDischargeCoeff: config.breakDischargeCoeff,
      breakDirection,                      // Random direction for rendering
      fromOpeningHeight: burstState.breakOpeningHeight,
    };
    state.flowConnections.push(breakConn);
  }
}

/**
 * Update break size for an already-burst/collapsed component.
 * Breaks can grow if pressure continues to increase, but cannot shrink.
 */
function updateBreakSize(
  burstState: BurstState,
  pressure: number,
  state: SimulationState,
  config: BurstConfig
): void {
  // Use appropriate threshold based on failure mode
  const thresholdPressure = burstState.isCollapse
    ? burstState.collapsePressure
    : burstState.burstPressure;
  let newBreakFraction = calculateBreakFraction(
    pressure,
    thresholdPressure,
    config,
    burstState.breakSizeSeed
  );

  // Melt-through holes grow with the melted-away head fraction, not
  // just overpressure (a depressurized vessel still drains through the
  // hole the corium is candling open)
  if (burstState.isMeltThrough) {
    const head = state.thermalNodes.get(`${burstState.componentId}-lowerhead`);
    if (head && head.initialMass && head.initialMass > 0) {
      const headLost = 1 - head.mass / head.initialMass;
      newBreakFraction = Math.max(
        newBreakFraction,
        Math.min(config.maxBreakFraction, headLost)
      );
    }
  }

  // Break can only grow, not shrink
  if (newBreakFraction > burstState.currentBreakFraction) {
    const oldFraction = burstState.currentBreakFraction;
    burstState.currentBreakFraction = newBreakFraction;

    // Update break connection flow area
    const breakConnId = `break-${burstState.nodeId}`;
    const breakConn = state.flowConnections.find(c => c.id === breakConnId);
    if (breakConn) {
      const node = state.flowNodes.get(burstState.nodeId);
      if (node) {
        const breakArea = node.flowArea * burstState.currentBreakFraction;
        breakConn.flowArea = breakArea;
        breakConn.hydraulicDiameter = Math.sqrt(4 * breakArea / Math.PI);
        breakConn.breakFraction = burstState.currentBreakFraction;
      }
    }

    // Log significant break growth
    if (newBreakFraction - oldFraction > 0.05) {
      console.log(
        `[BurstCheck] Break grew: ${burstState.componentLabel} ` +
        `${(oldFraction * 100).toFixed(1)}% → ${(newBreakFraction * 100).toFixed(1)}%`
      );
    }
  }
}

// ============================================================================
// Scripted bursts
// ============================================================================

/**
 * What a scenario asks for when it opens a break by hand.
 *
 * A pressure burst and an earthquake tearing a liner are the same hole: the
 * only thing a script supplies that the pressure check works out for itself
 * is the SIZE and the PLACE. Everything after that - the break connection,
 * the discharge target (the containing building, else the open air), the
 * flow, the drawing, and liquid landing in the terrain basin under the
 * component - is the machinery that was already there.
 */
export interface ScriptedBurstSpec {
  /** Break area (m2). Exactly one of `area` or `fraction`. */
  area?: number;
  /** Break area as a fraction of the node's own flow area. */
  fraction?: number;
  /** Height of the break above the component's own base (m). Default: the base. */
  elevation?: number;
  /** Vertical extent of the opening (m); the draw is averaged over it. */
  openingHeight?: number;
  /** Reported in the event banner instead of the generic burst wording. */
  message?: string;
}

/**
 * Open a break on a named component, whatever its pressure is doing.
 *
 * The component must have a burst state (every pressure-bearing component
 * gets one at build time), and it is addressed by component id or by node
 * id - a scenario names components, the way a valve or pump action does.
 */
export function applyScriptedBurst(
  state: SimulationState,
  id: string,
  spec: ScriptedBurstSpec
): void {
  if (!state.burstStates || state.burstStates.size === 0) {
    throw new Error(
      `[Scenario] burst '${id}': this plant has no burst states at all, so ` +
      `there is nothing to tear. Only pressure-bearing components get one.`);
  }
  let burstState = state.burstStates.get(id);
  if (!burstState) {
    for (const [, bs] of state.burstStates) {
      if (bs.componentId === id) { burstState = bs; break; }
    }
  }
  if (!burstState) {
    const known = Array.from(state.burstStates.values())
      .map(b => b.componentId).join(', ');
    throw new Error(
      `[Scenario] burst '${id}': no such component. Components that can be ` +
      `burst here: ${known}`);
  }
  const node = state.flowNodes.get(burstState.nodeId);
  if (!node) {
    throw new Error(
      `[Scenario] burst '${id}': burst state names flow node ` +
      `'${burstState.nodeId}', which does not exist.`);
  }
  if ((spec.area === undefined) === (spec.fraction === undefined)) {
    throw new Error(
      `[Scenario] burst '${id}': give exactly one of area (m2) or fraction ` +
      `(of the node's ${node.flowArea.toFixed(3)} m2 flow area), not both and ` +
      `not neither.`);
  }
  const fraction = spec.fraction !== undefined
    ? spec.fraction
    : (spec.area as number) / node.flowArea;
  if (!(fraction > 0)) {
    throw new Error(`[Scenario] burst '${id}': break size ${fraction} is not positive.`);
  }

  const config = state.burstConfig ?? DEFAULT_BURST_CONFIG;
  const elevation = spec.elevation ?? 0;
  burstState.breakElevation = node.elevation + elevation;
  burstState.breakOpeningHeight = spec.openingHeight;
  burstState.isScripted = true;
  burstState.currentBreakFraction = Math.max(burstState.currentBreakFraction, fraction);
  const wasBurst = burstState.isBurst;
  burstState.isBurst = true;
  if (!wasBurst) burstState.burstTime = state.time;

  if (wasBurst) {
    // Already open: move/resize the hole that exists rather than adding a
    // second one (the connection id is per node).
    const conn = state.flowConnections.find(c => c.id === `break-${burstState.nodeId}`);
    if (conn) {
      const area = node.flowArea * burstState.currentBreakFraction;
      conn.flowArea = area;
      conn.hydraulicDiameter = Math.sqrt(4 * area / Math.PI);
      conn.breakFraction = burstState.currentBreakFraction;
      conn.fromElevation = elevation;
      conn.fromOpeningHeight = spec.openingHeight;
    }
  } else {
    createBreakConnection(burstState, state, config);
    const conn = state.flowConnections.find(c => c.id === `break-${burstState.nodeId}`);
    // A tear has a height; a hole does not. Either way the connection reads
    // it the same way every other offtake does.
    if (conn) conn.fromOpeningHeight = spec.openingHeight;
  }

  const area = node.flowArea * burstState.currentBreakFraction;
  if (!state.pendingEvents) state.pendingEvents = [];
  state.pendingEvents.push({
    type: 'component-burst',
    message: spec.message ??
      `BREACH: ${burstState.componentLabel} is open to the outside - ` +
      `${area.toFixed(3)} m2 at ${elevation.toFixed(1)} m above its base`,
    data: {
      nodeId: burstState.nodeId,
      componentId: burstState.componentId,
      breakFraction: burstState.currentBreakFraction,
      breakElevation: burstState.breakElevation,
      scripted: true,
    },
  });
  console.log(
    `[Scenario] SCRIPTED BURST: ${burstState.componentLabel} at t=${state.time.toFixed(1)}s, ` +
    `${area.toFixed(4)} m2 (${(burstState.currentBreakFraction * 100).toFixed(2)}% of the node's ` +
    `flow area) at +${elevation.toFixed(2)} m` +
    (spec.openingHeight ? `, ${spec.openingHeight.toFixed(2)} m tall` : ''));
}
