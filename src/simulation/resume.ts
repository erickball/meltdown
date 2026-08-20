/**
 * Mode-switch resume: leave simulation mode, edit the plant, come back, and
 * the simulation continues where it left off - except where the user changed
 * something, which re-initializes from the (edited) initial conditions.
 *
 * Three pieces, used by main.ts's setMode:
 *
 * 1. writeSimulationStateToPlant - on entering construction mode, write the
 *    LIVE simulation state back into the component fields the factory reads
 *    as initial conditions (fillLevel, fluid.*, initialNcg, opening, ...).
 *    The edit dialogs read those same fields, so they show the current state
 *    as the new "initial" conditions.
 *
 * 2. captureResumeSnapshot - remember the live SimulationState plus a
 *    stable-serialized snapshot of every component/connection, so that on
 *    re-entry we can tell exactly what the user edited. Also rebuilds the
 *    plant once from the written-back ICs and LOUDLY audits any node whose
 *    re-initialization would not reproduce the live state (that is the state
 *    an EDITED component will resume from, so infidelity there must be
 *    visible, not silent).
 *
 * 3. transplantSimulationState - on re-entering simulation mode, take the
 *    freshly built state (which reflects all construction edits, including
 *    added/removed components) and swap in the saved live state for every
 *    element whose owning component was NOT edited. Unedited components
 *    resume bit-exactly; edited ones start from their edited ICs.
 *
 * Conventions this file must keep in lockstep with factory.ts:
 *  - fluid.pressure is the STEAM partial pressure (createFluidState adds NCG
 *    partial pressures on top). Buildings are the exception: their
 *    fluid.pressure is TOTAL pressure and the factory subtracts the NCG.
 *  - initialNcg / shellInitialNcg / annulusInitialNcg are partial pressures
 *    in bar converted to moles over the node's TOTAL volume (n = PV/RT),
 *    regardless of phase - so the inverse here uses total volume too.
 *  - fillLevel is the liquid VOLUME fraction (tank/vessel/condenser/building).
 *  - Turbine/TD-pump inletFluid is LIVE state and is written back; the
 *    machine's design point lives in the separate sticky
 *    component.designInletPressure, which the factory freezes at the first
 *    simulation build and never derives from inletFluid again.
 *  - Turbine extraction nodes and the TD pump's pump-side node have no IC
 *    fields at all; they re-initialize at design conditions when their
 *    component is edited (the audit skips them for that reason).
 */

import { SimulationState, FlowNode } from './types';
import { PlantState } from '../types';
import { NcgPartialPressures } from './operators';
import { R_GAS, GasComposition } from './gas-properties';
import * as Water from './water-properties';
import { hxBundleCount, hxTubeNodeId } from './hx-bundles';
import { assignFlowConnectionIds } from './connection-ids';
import { createSimulationFromPlant } from './factory';

// ============================================================================
// Small helpers
// ============================================================================

/** Liquid volume fraction of a node (what fillLevel means). */
function liquidVolumeFraction(node: FlowNode): number {
  const f = node.fluid;
  if (f.phase === 'liquid') return 1;
  if (f.phase === 'vapor') return 0;
  const rho_f = Water.saturatedLiquidDensity(f.temperature);
  const liquidVolume = (f.mass * (1 - f.quality)) / rho_f;
  // fillLevel is defined on [0,1]; table roundoff can put the ratio a hair
  // outside, which is not a physical statement worth preserving
  return Math.min(1, Math.max(0, liquidVolume / node.volume));
}

/** Vapor-space volume of a node (for live NCG partial pressure). */
function vaporVolume(node: FlowNode): number {
  const f = node.fluid;
  if (f.phase === 'vapor') return node.volume;
  if (f.phase === 'liquid') return 0;
  const rho_g = Water.saturatedVaporDensity(f.temperature);
  return (f.mass * f.quality) / rho_g;
}

/**
 * Live steam partial pressure: node total pressure minus the NCG partial
 * pressure over the actual vapor space (Dalton). Liquid-full nodes have no
 * gas space; their stored pressure is used as-is.
 */
function steamPartialPressurePa(node: FlowNode): number {
  const f = node.fluid;
  if (!f.ncg) return f.pressure;
  const V_gas = vaporVolume(node);
  if (!(V_gas > 0)) return f.pressure;
  let P_ncg = 0;
  for (const moles of Object.values(f.ncg)) {
    if (moles && moles > 0) P_ncg += (moles * R_GAS * f.temperature) / V_gas;
  }
  const P_steam = f.pressure - P_ncg;
  if (!(P_steam > 0)) {
    console.warn(
      `[Resume] Node '${node.id}': NCG partial pressure (${(P_ncg / 1e5).toFixed(3)} bar) ` +
      `exceeds total pressure (${(f.pressure / 1e5).toFixed(3)} bar) - the written-back ` +
      `steam pressure would be non-positive. Keeping total pressure; expect an audit warning.`
    );
    return f.pressure;
  }
  return P_steam;
}

/**
 * NCG moles back to the factory's initial-condition convention: partial
 * pressures in bar over the TOTAL given volume (the exact inverse of
 * createFluidState's n = P*V/RT). Returns undefined when there is no NCG.
 */
function ncgToInitialBar(
  ncg: Partial<GasComposition> | undefined, temperature: number, volume: number
): NcgPartialPressures | undefined {
  if (!ncg) return undefined;
  const out: Record<string, number> = {};
  let any = false;
  for (const [species, moles] of Object.entries(ncg)) {
    if (moles && moles > 1e-12) {
      out[species] = (moles * R_GAS * temperature) / volume / 1e5;
      any = true;
    }
  }
  return any ? (out as NcgPartialPressures) : undefined;
}

/** Write the common fluid IC fields (steam-partial-pressure convention). */
function writeFluidIC(c: Record<string, any>, node: FlowNode): void {
  if (!c.fluid) c.fluid = { temperature: 300, pressure: 1e5, phase: 'liquid', flowRate: 0 };
  c.fluid.temperature = node.fluid.temperature;
  c.fluid.pressure = steamPartialPressurePa(node);
  c.fluid.phase = node.fluid.phase;
  c.fluid.quality = node.fluid.quality;
  // Display-only fields the canvas reads (kept consistent with the old
  // per-frame sync so construction-mode rendering matches the state)
  c.fluid.separation = node.separation;
  c.fluid.ncg = node.fluid.ncg;
  c.fluid.volume = node.volume;
}

// ============================================================================
// 1. Write-back: live simulation state -> component initial conditions
// ============================================================================

export function writeSimulationStateToPlant(sim: SimulationState, plant: PlantState): void {
  for (const [id, component] of plant.components) {
    const c = component as Record<string, any>;
    const node = sim.flowNodes.get(id);

    switch (c.type) {
      case 'tank': {
        if (!node) break;
        writeFluidIC(c, node);
        c.fillLevel = liquidVolumeFraction(node);
        const ncg = ncgToInitialBar(node.fluid.ncg, node.fluid.temperature, node.volume);
        if (ncg) c.initialNcg = ncg; else delete c.initialNcg;
        if (node.heaterPower !== undefined) c.initialHeaterPower = node.heaterPower;
        break;
      }

      case 'pipe':
      case 'coreBarrel': {
        if (!node) break;
        writeFluidIC(c, node);
        const ncg = ncgToInitialBar(node.fluid.ncg, node.fluid.temperature, node.volume);
        if (ncg) c.initialNcg = ncg; else delete c.initialNcg;
        break;
      }

      case 'pump': {
        if (!node) break;
        writeFluidIC(c, node);
        const ncg = ncgToInitialBar(node.fluid.ncg, node.fluid.temperature, node.volume);
        if (ncg) c.initialNcg = ncg; else delete c.initialNcg;
        const pumpState = sim.components.pumps.get(id);
        if (pumpState) {
          c.running = pumpState.running;
          c.speed = pumpState.speed;
        }
        break;
      }

      case 'valve': {
        if (!node) break;
        writeFluidIC(c, node);
        const ncg = ncgToInitialBar(node.fluid.ncg, node.fluid.temperature, node.volume);
        if (ncg) c.initialNcg = ncg; else delete c.initialNcg;
        const valveState = sim.components.valves.get(id);
        if (valveState) c.opening = valveState.position;
        break;
      }

      case 'vessel': {
        if (!node) break;
        writeFluidIC(c, node);
        c.fillLevel = liquidVolumeFraction(node);
        break;
      }

      case 'reactorVessel': {
        if (!node) break; // legacy sibling-architecture vessels have no own node
        writeFluidIC(c, node);
        c.fillLevel = liquidVolumeFraction(node);
        const ncg = ncgToInitialBar(node.fluid.ncg, node.fluid.temperature, node.volume);
        if (ncg) c.initialNcg = ncg; else delete c.initialNcg;
        break;
      }

      case 'condenser': {
        if (!node) break;
        writeFluidIC(c, node);
        c.fillLevel = liquidVolumeFraction(node);
        const ncg = ncgToInitialBar(node.fluid.ncg, node.fluid.temperature, node.volume);
        if (ncg) c.initialNcg = ncg; else delete c.initialNcg;
        break;
      }

      case 'building': {
        if (!node) break;
        writeFluidIC(c, node);
        c.fillLevel = liquidVolumeFraction(node);
        const ncg = ncgToInitialBar(node.fluid.ncg, node.fluid.temperature, node.volume);
        if (ncg) c.initialNcg = ncg; else delete c.initialNcg;
        // Buildings alone store TOTAL pressure; the factory subtracts the
        // NCG spec (bar over total volume) to recover the steam pressure,
        // so the total written here must use the same convention
        let ncgTotalPa = 0;
        if (ncg) for (const bar of Object.values(ncg)) ncgTotalPa += (bar as number) * 1e5;
        c.fluid.pressure = steamPartialPressurePa(node) + ncgTotalPa;
        break;
      }

      case 'crossVessel': {
        const inner = sim.flowNodes.get(`${id}-inner`);
        if (inner) {
          writeFluidIC(c, inner);
          const ncg = ncgToInitialBar(inner.fluid.ncg, inner.fluid.temperature, inner.volume);
          if (ncg) c.initialNcg = ncg; else delete c.initialNcg;
        }
        const annulus = sim.flowNodes.get(`${id}-annulus`);
        if (annulus) {
          if (!c.annulusFluid) c.annulusFluid = { temperature: 565, pressure: 155e5, phase: 'liquid', flowRate: 0 };
          c.annulusFluid.temperature = annulus.fluid.temperature;
          c.annulusFluid.pressure = steamPartialPressurePa(annulus);
          c.annulusFluid.phase = annulus.fluid.phase;
          c.annulusFluid.quality = annulus.fluid.quality;
          const ncgA = ncgToInitialBar(annulus.fluid.ncg, annulus.fluid.temperature, annulus.volume);
          if (ncgA) c.annulusInitialNcg = ncgA; else delete c.annulusInitialNcg;
        }
        break;
      }

      case 'heatExchanger': {
        // Tube side: aggregate all bundles into the single tubeFluid spec the
        // factory splits back across bundles. Mass-weighted temperature and
        // quality; pressure from the first bundle (they share a header).
        const nBundles = hxBundleCount(c as { bundleCount?: number });
        let mSum = 0, mT = 0, mX = 0, vSum = 0;
        let anyTwoPhase = false, allVapor = true, allLiquid = true;
        let firstNode: FlowNode | undefined;
        let ncgMoles: Record<string, number> | undefined;
        for (let b = 0; b < nBundles; b++) {
          const tubeNode = sim.flowNodes.get(hxTubeNodeId(id, b));
          if (!tubeNode) continue;
          if (!firstNode) firstNode = tubeNode;
          const f = tubeNode.fluid;
          mSum += f.mass; mT += f.mass * f.temperature; mX += f.mass * f.quality;
          vSum += tubeNode.volume;
          if (f.phase === 'two-phase') anyTwoPhase = true;
          if (f.phase !== 'vapor') allVapor = false;
          if (f.phase !== 'liquid') allLiquid = false;
          if (f.ncg) {
            ncgMoles = ncgMoles ?? {};
            for (const [sp, n] of Object.entries(f.ncg)) {
              if (n) ncgMoles[sp] = (ncgMoles[sp] ?? 0) + n;
            }
          }
        }
        if (firstNode && mSum > 0) {
          const T = mT / mSum;
          const phase = anyTwoPhase || (!allVapor && !allLiquid) ? 'two-phase'
            : allVapor ? 'vapor' : 'liquid';
          const tubeFluid = {
            temperature: T,
            pressure: steamPartialPressurePa(firstNode),
            phase,
            quality: mX / mSum,
            flowRate: 0,
          };
          // tubeFluid takes precedence over primaryFluid in the factory, so
          // it is the field written; primaryFluid mirrors it for display
          c.tubeFluid = tubeFluid;
          if (c.primaryFluid) Object.assign(c.primaryFluid, tubeFluid);
          const ncg = ncgToInitialBar(ncgMoles as Partial<GasComposition> | undefined, T, vSum);
          if (ncg) c.initialNcg = ncg; else delete c.initialNcg;
        }

        const shell = sim.flowNodes.get(`${id}-shell`);
        if (shell) {
          const shellFluid = {
            temperature: shell.fluid.temperature,
            pressure: steamPartialPressurePa(shell),
            phase: shell.fluid.phase,
            quality: shell.fluid.quality,
            flowRate: 0,
          };
          c.shellFluid = shellFluid;
          if (c.secondaryFluid) Object.assign(c.secondaryFluid, shellFluid);
          const ncg = ncgToInitialBar(shell.fluid.ncg, shell.fluid.temperature, shell.volume);
          if (ncg) c.shellInitialNcg = ncg; else delete c.shellInitialNcg;
        }
        break;
      }

      case 'turbine-generator':
      case 'turbine-driven-pump': {
        // inletFluid is live state (the design point is the separate sticky
        // designInletPressure, frozen by the factory at first build). For a
        // TD pump the base node is the drive-turbine steam path; its
        // pump-side node has no IC fields and always re-inits when edited.
        if (!node) break;
        if (!c.inletFluid) c.inletFluid = { temperature: 550, pressure: 5.5e6, phase: 'vapor', flowRate: 0 };
        c.inletFluid.temperature = node.fluid.temperature;
        c.inletFluid.pressure = steamPartialPressurePa(node);
        c.inletFluid.phase = node.fluid.phase;
        c.inletFluid.quality = node.fluid.quality;
        if (node.governorValve !== undefined) c.governorValve = node.governorValve;
        break;
      }

      // controllers, switchyards etc. have no fluid state
      default:
        break;
    }

    // Core state shared by any fueled component: current fuel temperature
    // seeds the rebuilt thermal nodes, current rod position seeds the
    // criticality search
    const fuelNode = sim.thermalNodes.get(`${id}-fuel`);
    if (fuelNode) c.fuelTemperature = fuelNode.temperature;
    if (sim.neutronics.coreId === id) {
      c.controlRodPosition = sim.neutronics.controlRodPosition;
    }
  }
}

// ============================================================================
// 2. Snapshot + write-back fidelity audit
// ============================================================================

/** Sim-link / render-cache fields that are not initial conditions. */
const VOLATILE_COMPONENT_KEYS = new Set([
  'simNodeId', 'simPumpId', 'simValveId',
  'tubeSections', 'bundleFluids', 'opFlowFraction',
]);

/** Deterministic JSON: sorted keys, volatile top-level fields stripped. */
function stableStringify(value: unknown, stripVolatile = false): string {
  const seen = new Set<object>();
  const norm = (v: unknown, top: boolean): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v as object)) return '[circular]';
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(x => norm(x, false));
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as object).sort()) {
      if (top && stripVolatile && VOLATILE_COMPONENT_KEYS.has(key)) continue;
      const val = (v as Record<string, unknown>)[key];
      if (val === undefined || typeof val === 'function') continue;
      out[key] = norm(val, false);
    }
    return out;
  };
  return JSON.stringify(norm(value, true));
}

export interface ResumeSnapshot {
  /** The live simulation state at the moment construction mode was entered. */
  saved: SimulationState;
  /** A throwaway rebuild from the written-back ICs: geometry reference for
   *  the transplant guard, and the audit's "what would an edited component
   *  resume as" baseline. */
  refBuild: SimulationState;
  componentICs: Map<string, string>;
  connectionICs: Map<string, string>;
}

/**
 * Call AFTER writeSimulationStateToPlant. Rebuilds the plant once from the
 * written-back ICs, audits reconstruction fidelity (loudly - an unfaithful
 * write-back is a bug in this file or a factory convention change), and
 * captures the edit-detection snapshots.
 */
export function captureResumeSnapshot(sim: SimulationState, plant: PlantState): ResumeSnapshot {
  const refBuild = createSimulationFromPlant(plant);
  auditWriteBackFidelity(sim, refBuild, plant);

  const componentICs = new Map<string, string>();
  for (const [id, component] of plant.components) {
    componentICs.set(id, stableStringify(component, true));
  }
  const connectionICs = new Map<string, string>();
  const connIds = assignFlowConnectionIds(plant.connections);
  plant.connections.forEach((conn, i) => connectionICs.set(connIds[i], stableStringify(conn)));

  return { saved: sim, refBuild, componentICs, connectionICs };
}

/**
 * Nodes with no initial-condition representation at all: turbine extraction
 * lines (always built at their extraction design pressure) and the TD pump's
 * pump-side water node (hardcoded cold defaults). The audit skips them; when
 * their component is edited they re-initialize at those design conditions.
 */
function nodeHasNoIcRepresentation(refNode: FlowNode, nodeId: string, ownerType: string | undefined, owner: string | null): boolean {
  if ((refNode as { extractionPressure?: number }).extractionPressure !== undefined) return true;
  return ownerType === 'turbine-driven-pump' && nodeId === `${owner}-pump`;
}

function ownerComponentId(nodeId: string, plant: PlantState): string | null {
  if (plant.components.has(nodeId)) return nodeId;
  let best: string | null = null;
  for (const compId of plant.components.keys()) {
    // '-' delimited prefix: guards against 'hx-1' claiming 'hx-10-shell'
    if (nodeId.startsWith(compId + '-') && (best === null || compId.length > best.length)) {
      best = compId;
    }
  }
  return best;
}

function auditWriteBackFidelity(live: SimulationState, refBuild: SimulationState, plant: PlantState): void {
  const REL_TOL = 0.01;
  let warned = 0;
  for (const [nodeId, liveNode] of live.flowNodes) {
    const rebuilt = refBuild.flowNodes.get(nodeId);
    if (!rebuilt) {
      // Burst-created or otherwise runtime-created nodes have no IC to audit
      continue;
    }
    const owner = ownerComponentId(nodeId, plant);
    const ownerType = owner ? (plant.components.get(owner) as { type?: string } | undefined)?.type : undefined;
    if (nodeHasNoIcRepresentation(rebuilt, nodeId, ownerType, owner)) continue;
    const dMass = Math.abs(rebuilt.fluid.mass - liveNode.fluid.mass) / Math.max(1e-9, liveNode.fluid.mass);
    const uLive = liveNode.fluid.internalEnergy / Math.max(1e-9, liveNode.fluid.mass);
    const uRebuilt = rebuilt.fluid.internalEnergy / Math.max(1e-9, rebuilt.fluid.mass);
    const dU = Math.abs(uRebuilt - uLive) / Math.max(1e-9, Math.abs(uLive));
    if (dMass > REL_TOL || dU > REL_TOL) {
      warned++;
      console.warn(
        `[Resume] Write-back audit: '${nodeId}' would re-initialize with ` +
        `mass ${rebuilt.fluid.mass.toPrecision(5)} kg / u ${(uRebuilt / 1e3).toPrecision(5)} kJ/kg ` +
        `instead of the live ${liveNode.fluid.mass.toPrecision(5)} kg / ${(uLive / 1e3).toPrecision(5)} kJ/kg ` +
        `(Δm ${(dMass * 100).toFixed(1)}%, Δu ${(dU * 100).toFixed(1)}%). ` +
        `This only matters if you EDIT '${owner ?? nodeId}' before returning to simulation - ` +
        `unedited components resume exactly - but it means the write-back in resume.ts ` +
        `does not faithfully invert factory.ts for this component type.`
      );
    }
  }
  if (warned > 0) {
    console.warn(`[Resume] Write-back audit: ${warned} node(s) would not re-initialize faithfully (see above).`);
  }
}

// ============================================================================
// 3. Transplant: fresh factory build + saved live state -> resumed state
// ============================================================================

function sameNodeGeometry(a: FlowNode, b: FlowNode): boolean {
  return a.volume === b.volume && a.flowArea === b.flowArea &&
    a.height === b.height && a.elevation === b.elevation &&
    a.hydraulicDiameter === b.hydraulicDiameter;
}

/**
 * Mutates `fresh` (a factory build reflecting the CURRENT plant) so that
 * every element owned by an unedited component carries the saved live state.
 * Returns human-readable notes about what was and wasn't resumed.
 */
export function transplantSimulationState(
  fresh: SimulationState, snap: ResumeSnapshot, plant: PlantState
): string[] {
  const notes: string[] = [];
  const { saved, refBuild } = snap;

  // Which components changed since the snapshot (edited, or newly added)
  const dirty = new Set<string>();
  for (const [id, component] of plant.components) {
    const before = snap.componentICs.get(id);
    if (!before || before !== stableStringify(component, true)) dirty.add(id);
  }
  if (dirty.size > 0) {
    notes.push(`re-initialized from edited settings: ${[...dirty].join(', ')}`);
  }

  const isDirtyOwner = (elementId: string): boolean => {
    const owner = ownerComponentId(elementId, plant);
    return owner !== null && dirty.has(owner);
  };

  // --- Flow nodes ---
  const transplanted = new Set<string>();
  for (const [nodeId, freshNode] of fresh.flowNodes) {
    const savedNode = saved.flowNodes.get(nodeId);
    if (!savedNode) continue; // new component
    if (isDirtyOwner(nodeId)) continue;
    const refNode = refBuild.flowNodes.get(nodeId);
    // Geometry must be reproduced by the rebuild (compare factory output to
    // factory output - the LIVE node's volume may legitimately have evolved).
    // A mismatch means something this node depends on changed indirectly,
    // e.g. an edited connection changed the pipe-inventory lumping.
    if (!refNode || !sameNodeGeometry(freshNode, refNode)) {
      console.warn(
        `[Resume] '${nodeId}' was not edited but its rebuilt geometry differs ` +
        `(likely an edited neighboring connection changed its lumped piping volume) - ` +
        `re-initializing it instead of resuming.`
      );
      continue;
    }
    fresh.flowNodes.set(nodeId, savedNode);
    transplanted.add(nodeId);
  }

  // --- Thermal nodes (fuel, walls, corium, ...) ---
  for (const [thermalId, freshThermal] of fresh.thermalNodes) {
    const savedThermal = saved.thermalNodes.get(thermalId);
    if (!savedThermal) continue;
    if (isDirtyOwner(thermalId)) continue;
    const refThermal = refBuild.thermalNodes.get(thermalId);
    // Same factory-vs-factory guard; live mass may have evolved (relocation)
    if (!refThermal || refThermal.mass !== freshThermal.mass ||
        refThermal.specificHeat !== freshThermal.specificHeat) {
      console.warn(`[Resume] Thermal node '${thermalId}' rebuilt differently despite no edit - re-initializing.`);
      continue;
    }
    fresh.thermalNodes.set(thermalId, savedThermal);
  }

  // --- Neutronics (xenon, precursors, rods, power) ---
  // Carried whenever the same core (or, for coreless plants, no core) is
  // present and unedited; otherwise the fresh criticality solve stands
  if (saved.neutronics.coreId === fresh.neutronics.coreId &&
      (!saved.neutronics.coreId || !dirty.has(saved.neutronics.coreId))) {
    fresh.neutronics = saved.neutronics;
  } else if (saved.neutronics.coreId || fresh.neutronics.coreId) {
    notes.push('core re-initialized (criticality re-solved, xenon/precursors reset)');
  }

  // --- Pumps / valves / check valves / controllers ---
  for (const [pumpId, freshPump] of fresh.components.pumps) {
    const savedPump = saved.components.pumps.get(pumpId);
    if (!savedPump || isDirtyOwner(pumpId)) continue;
    freshPump.running = savedPump.running;
    freshPump.speed = savedPump.speed;
    freshPump.effectiveSpeed = savedPump.effectiveSpeed;
  }
  for (const [valveId, freshValve] of fresh.components.valves) {
    const savedValve = saved.components.valves.get(valveId);
    if (!savedValve || isDirtyOwner(valveId)) continue;
    freshValve.position = savedValve.position;
    if (savedValve.reliefOpen !== undefined) freshValve.reliefOpen = savedValve.reliefOpen;
    if (savedValve.liftCount !== undefined) freshValve.liftCount = savedValve.liftCount;
  }
  for (const ctlId of [...fresh.components.controllers.keys()]) {
    const savedCtl = saved.components.controllers.get(ctlId);
    if (!savedCtl || isDirtyOwner(ctlId)) continue;
    // Same config (undirty) - carry the whole loop state: mode, integrator,
    // auto-tuned gains, scan clock
    fresh.components.controllers.set(ctlId, savedCtl);
  }

  // --- Flow connections: carry momentum (mass flow) where both ends resumed ---
  const savedConns = new Map(saved.flowConnections.map(conn => [conn.id, conn]));
  const currentConnIds = assignFlowConnectionIds(plant.connections);
  const currentConnJson = new Map<string, string>();
  plant.connections.forEach((conn, i) => currentConnJson.set(currentConnIds[i], stableStringify(conn)));
  for (const freshConn of fresh.flowConnections) {
    const savedConn = savedConns.get(freshConn.id);
    if (!savedConn) continue;
    if (!transplanted.has(freshConn.fromNodeId) || !transplanted.has(freshConn.toNodeId)) continue;
    const snapJson = snap.connectionICs.get(freshConn.id);
    if (snapJson !== undefined && snapJson !== currentConnJson.get(freshConn.id)) continue; // edited
    freshConn.massFlowRate = savedConn.massFlowRate;
    freshConn.currentFlowPhase = savedConn.currentFlowPhase;
  }

  // --- Burst-created break connections and damage state ---
  const freshConnIds = new Set(fresh.flowConnections.map(conn => conn.id));
  let carriedBreaks = 0;
  for (const savedConn of saved.flowConnections) {
    if (!savedConn.isBreakConnection || freshConnIds.has(savedConn.id)) continue;
    const sourceOk = !savedConn.burstSourceNodeId || !isDirtyOwner(savedConn.burstSourceNodeId);
    if (sourceOk && transplanted.has(savedConn.fromNodeId) &&
        fresh.flowNodes.has(savedConn.toNodeId)) {
      fresh.flowConnections.push(savedConn);
      carriedBreaks++;
    }
  }
  if (carriedBreaks > 0) {
    notes.push(`${carriedBreaks} existing rupture(s) still open (edit the burst component to repair it)`);
  }
  if (saved.burstStates && fresh.burstStates) {
    for (const [burstId, savedBurst] of saved.burstStates) {
      if (!fresh.burstStates.has(burstId)) continue;
      if (dirty.has(burstId) || isDirtyOwner(burstId)) continue;
      fresh.burstStates.set(burstId, savedBurst);
    }
  }

  // --- Globals ---
  fresh.time = saved.time;
  if (saved.atmosphereRelease) fresh.atmosphereRelease = saved.atmosphereRelease;
  if (saved.environmentalRelease) fresh.environmentalRelease = saved.environmentalRelease;
  if (saved.liquidBasePressures) {
    fresh.liquidBasePressures = fresh.liquidBasePressures ?? new Map();
    for (const [nodeId, pressure] of saved.liquidBasePressures) {
      if (transplanted.has(nodeId)) fresh.liquidBasePressures.set(nodeId, pressure);
    }
  }

  notes.unshift(`resumed at t=${saved.time.toFixed(1)} s; ${transplanted.size}/${fresh.flowNodes.size} nodes carried over`);
  return notes;
}
