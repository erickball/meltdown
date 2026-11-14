/**
 * Two-way (exchange) flow through a break.
 *
 * A connection carries ONE mass flow, so through it a fluid can only go one
 * way at a time. A hole in a wall does not work like that: when the fluids
 * on its two sides differ in density, the heavy one runs out through the
 * lower part of the opening while the light one comes in through the upper
 * part - water draining out of a torn tank while air bubbles in over it,
 * cold building air flowing into a vessel under the hot helium leaving it.
 * Without this a sealed tank torn below its water line can only lose water
 * as fast as something else makes room for it (it sat in a knife-edge
 * manometer balance, draining at 0.85 kg/s through a 42 cm tear, and any
 * disturbance tipped it into alternating whole-opening slugs of air and
 * water - see xe100-dlofc's RCCS tank before it had a vacuum breaker).
 *
 * THE MODEL: layered orifice flow through a side opening of height H and
 * width W = A/H (a hole of area A; a circular one is taken at H = its
 * diameter). Across the opening the pressure difference between the two
 * sides varies linearly with height at g*drho per metre, crossing zero at a
 * neutral plane z_n. Below it the heavy fluid flows out, above it the light
 * fluid flows in, each layer by the orifice equation at its own density:
 *
 *   v_h(z) = Cd sqrt(2 g drho (z_n - z) / rho_h),   z < z_n
 *   v_l(z) = Cd sqrt(2 g drho (z - z_n) / rho_l),   z > z_n
 *
 *   Q_h(z_n) = (2/3) Cd W sqrt(2 g drho / rho_h) [z_n^1.5 - (z_n - H)_+^1.5]
 *   Q_l(z_n) = (2/3) Cd W sqrt(2 g drho / rho_l) [(H - z_n)^1.5 - (-z_n)_+^1.5]
 *
 * At zero net flow and similar densities this is the classic buoyant
 * exchange through a vertical opening, (Cd/3) W sqrt(g' H^3) with
 * g' = g drho / rho (Brown & Solvason); the per-density form keeps it right
 * for water against gas, where the neutral plane sits high and the gas comes
 * in fast through a thin top slice. The capacity goes as W H^1.5: a thin
 * horizontal slit exchanges far less than a square hole of the same area.
 *
 * NET FLOW: the connection's own momentum equation already sets the net
 * flow through the opening (pressure-driven, single phase at the donor's
 * density). This module does not touch it. It finds the neutral plane that
 * reproduces that net volume flow, Q_h - Q_l = Q_net, and adds only the
 * COUNTER-CURRENT part, min(Q_h, Q_l), as two equal-volume legs (heavy one
 * way, light the other). As the net flow grows in either direction the
 * neutral plane leaves the opening and the exchange fades to zero - the
 * flooding limit falls out of the same orifice law, with nothing added.
 * Equal volumes mean the legs move no net volume across the opening, so they
 * leave the pressure balance that sets the net flow alone.
 *
 * Cd is the break's own discharge coefficient - the same orifice the net
 * break flow uses. What each leg carries (water, steam, gas, enthalpy) is
 * priced exactly like any draw through that opening (FlowRateOperator.
 * priceDraw), and the pressure solver books the legs as fixed flows so its
 * closure sees their mass and enthalpy.
 *
 * Scope: break connections (holes in vessel walls, all side openings in
 * this model). Holes in horizontal surfaces (Epstein's floor/ceiling
 * exchange) and counter-current flooding in pipes (Wallis) are not modelled.
 */

import { SimulationState, FlowConnection, FlowNode } from '../types';
import { drawCompositionAt } from './connection-hydraulics';

const G = 9.81;

export interface ExchangeLeg {
  conn: FlowConnection;
  /** true: this leg flows from conn.fromNodeId to conn.toNodeId */
  fromIsDonor: boolean;
  /** kg/s, positive */
  massFlow: number;
}

export interface BreakExchange {
  conn: FlowConnection;
  /** m3/s each way */
  volumeFlow: number;
  heavy: ExchangeLeg;
  light: ExchangeLeg;
}

/** Volume flow each way through the opening at neutral plane z (m from its bottom). */
function layerFlows(z: number, H: number, kh: number, kl: number): { Qh: number; Ql: number } {
  const p = (x: number) => (x > 0 ? x * Math.sqrt(x) : 0);
  return {
    Qh: kh * (p(z) - p(z - H)),
    Ql: kl * (p(H - z) - p(-z)),
  };
}

/**
 * The exchange through one break, or null when there is none (equal
 * densities, nothing on one side, or a net flow beyond what the opening can
 * carry against a counter-current).
 */
export function breakExchange(state: SimulationState, conn: FlowConnection): BreakExchange | null {
  const fromNode = state.flowNodes.get(conn.fromNodeId);
  const toNode = state.flowNodes.get(conn.toNodeId);
  if (!fromNode || !toNode) return null;
  const A = conn.flowArea;
  if (!(A > 0)) return null;
  const Cd = conn.breakDischargeCoeff;
  if (!(Cd! > 0)) {
    throw new Error(`[ExchangeFlow] break '${conn.id}' has no discharge coefficient (${Cd}).`);
  }
  // The opening's vertical extent: a scripted slot says, a burst hole is
  // taken round (its height is its diameter)
  const H = conn.fromOpeningHeight ?? conn.toOpeningHeight ?? conn.hydraulicDiameter;
  if (!(H > 0)) {
    throw new Error(`[ExchangeFlow] break '${conn.id}' has no opening height or diameter (${H}).`);
  }
  const W = A / H;

  const compFrom = drawCompositionAt(fromNode, conn.fromElevation, 0, conn.fromPhaseTolerance, conn.fromOpeningHeight);
  const compTo = drawCompositionAt(toNode, conn.toElevation, 0, conn.toPhaseTolerance, conn.toOpeningHeight);
  const rhoFrom = compFrom.rho, rhoTo = compTo.rho;
  if (!(rhoFrom > 0) || !(rhoTo > 0)) return null;
  if (!hasContent(fromNode) || !hasContent(toNode)) return null;
  const dRho = Math.abs(rhoFrom - rhoTo);
  if (!(dRho > 0)) return null;
  const heavyIsFrom = rhoFrom > rhoTo;
  const rhoH = heavyIsFrom ? rhoFrom : rhoTo;
  const rhoL = heavyIsFrom ? rhoTo : rhoFrom;
  const kh = (2 / 3) * Cd! * W * Math.sqrt(2 * G * dRho / rhoH);
  const kl = (2 / 3) * Cd! * W * Math.sqrt(2 * G * dRho / rhoL);

  // The connection's net volume flow, signed in the heavy fluid's direction
  // of travel (heavy side -> light side), at the density of what it carries
  const w = conn.massFlowRate;
  const rhoDonor = w >= 0 ? rhoFrom : rhoTo;
  const qFromTo = w / rhoDonor;
  const qNet = heavyIsFrom ? qFromTo : -qFromTo;

  // Q_h - Q_l rises monotonically with z_n; past either end of the opening
  // one layer is gone and nothing runs counter to the other
  const atBottom = layerFlows(0, H, kh, kl);
  const atTop = layerFlows(H, H, kh, kl);
  if (!(qNet > atBottom.Qh - atBottom.Ql) || !(qNet < atTop.Qh - atTop.Ql)) return null;
  let lo = 0, hi = H;
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    const f = layerFlows(mid, H, kh, kl);
    if (f.Qh - f.Ql < qNet) lo = mid; else hi = mid;
  }
  const f = layerFlows(0.5 * (lo + hi), H, kh, kl);
  const x = Math.min(f.Qh, f.Ql);
  if (!(x > 0)) return null;

  return {
    conn,
    volumeFlow: x,
    heavy: { conn, fromIsDonor: heavyIsFrom, massFlow: x * rhoH },
    light: { conn, fromIsDonor: !heavyIsFrom, massFlow: x * rhoL },
  };
}

function hasContent(node: FlowNode): boolean {
  if (node.isBoundary) return true;
  const n = node.fluid.ncg;
  let moles = 0;
  if (n) for (const k in n) moles += (n as any)[k] ?? 0;
  return node.fluid.mass > 0 || moles > 0;
}

/** Every break's exchange in the state, as legs. */
export function breakExchangeLegs(state: SimulationState): ExchangeLeg[] {
  const legs: ExchangeLeg[] = [];
  for (const conn of state.flowConnections) {
    if (!conn.isBreakConnection) continue;
    const ex = breakExchange(state, conn);
    if (!ex) continue;
    legs.push(ex.heavy, ex.light);
  }
  return legs;
}
