/**
 * ControlSystemOperator - auto-tuned process controllers.
 *
 * Executes every ACCEPTED solver step (finalOnly), like a plant DCS scanning
 * its loops: read sensor, derive gains from the current plant state, take one
 * velocity-form PI step, rate-limit and clamp, write the actuator.
 *
 * DESIGN NOTES
 *
 * - Gains are DERIVED, not tuned. Every template below reduces the process
 *   to an integrating model dy/dt = k'·q whose k' is readable from the live
 *   state (surface area x density for levels, vapor compliance for
 *   pressures, saturation-line slope for heater-pressure). SIMC/lambda
 *   tuning then gives Kp = 1/(k'·λ), Ti = 4λ. The one user knob,
 *   `aggressiveness`, scales λ. Because k' and the actuator flow gain are
 *   re-evaluated every step, the controller is continuously gain-scheduled
 *   to the operating point.
 *
 * - Velocity form (Δu = Kp·Δe + Ki·e·dt): output clamping gives inherent
 *   anti-windup, and switching auto/manual or retuning is bumpless - there
 *   is no integrator state to initialize, only lastOutput/lastError.
 *
 * - Controllers are devices, not physics: rate limits, saturation, and the
 *   rod-controller deadband are properties of real hardware and are allowed
 *   here (the physics model itself remains clamp-free).
 *
 * - Misconfigured controllers (missing sensor/actuator targets) throw:
 *   a controller silently doing nothing is the worst failure mode.
 */

import { SimulationState, ControllerState, ControllerSignal, ControllerSensorKind, FlowNode } from '../types';
import { ConstraintOperator } from '../rk45-solver';
import { cloneSimulationState } from '../solver';
import { saturationPressure, saturatedLiquidEnergy } from '../water-properties';
import { evaluateOtsgAtP } from '../otsg';
import { tubeWaterState } from './otsg-operator';
import {
  approxLiquidDensity,
  calculateLiquidLevelWithObstructions,
} from './connection-hydraulics';

/**
 * Seconds between controller scans. A real DCS scans its loops at 0.1-1 s;
 * this sits in the middle and is comfortably faster than the fastest lambda
 * below (5 s for flow), so the loop still resolves its own dynamics.
 * Per-controller override: `scanPeriod`.
 */
const DEFAULT_SCAN_PERIOD = 0.5;

/** Default closed-loop time constants per sensor kind (s), before the
 *  aggressiveness scaling. Chosen like DCS commissioning defaults: slow
 *  enough to be robust to the k' estimate being off by 2-3x. */
const LAMBDA_DEFAULTS: Record<string, number> = {
  'node-level': 30,
  'node-pressure': 15,
  'node-temperature': 60,
  'connection-flow': 5,
  // A boiler's section boundaries move on its inventory time constant -
  // minutes, not seconds - and feed changes reach them through the whole
  // tube length, so this loop wants to be slow.
  'otsg-superheat-fraction': 90,
};

/** Rod controller proportional bands: full rod speed at this much error,
 *  with a dead band to keep rods from dithering. Power errors are fractions
 *  of nominal; temperature errors are Kelvin (the T_avg program of a real
 *  PWR - holding coolant temperature automatically matches reactor power to
 *  the heat the steam side is actually removing, so the primary can never
 *  bottle up against a closed governor). */
const ROD_BANDS: Record<string, { band: number; deadband: number }> = {
  'reactor-power': { band: 0.05, deadband: 0.002 },   // fraction of nominal
  // Temperature band is wide and the deadband generous (real plants use
  // ~±1 K) because the loop transport delay is tens of seconds - rods that
  // chase small temperature errors against that delay hunt forever. Inside
  // the deadband the reactor's own temperature/density coefficients hold the
  // operating point.
  'node-temperature': { band: 12, deadband: 1.0 },    // Kelvin
  'node-pressure': { band: 5e5, deadband: 2e4 },      // Pa (e.g. BWR dome pressure)
};

export class ControlSystemOperator implements ConstraintOperator {
  name = 'ControlSystem';
  /**
   * ACCEPTED states only, not candidates. A PI in velocity form carries its
   * integral in lastOutput and differentiates against lastError, so stepping
   * it on a candidate that is then rejected rewinds both - and the next
   * attempt measures its increment against an error from the discarded
   * branch. In a plant that rejects four steps in five (the Xe-100 does), a
   * loop asked to raise its output against a sustained +20 kg/s error simply
   * sat there while its computed output oscillated around it. A real DCS
   * scans the plant state it actually has, which is this one.
   */
  postAcceptOnly = true;

  applyConstraints(state: SimulationState, dt?: number): SimulationState {
    const controllers = state.components.controllers;
    const boronPending = state.neutronics.boronTargetPpm !== undefined &&
      (state.neutronics.boronPpm ?? 0) !== state.neutronics.boronTargetPpm;
    let hasRelief = false;
    for (const [, v] of state.components.valves) {
      if (v.relief) { hasRelief = true; break; }
    }
    if ((!controllers || controllers.size === 0) && !boronPending && !hasRelief) return state;
    if (dt === undefined || !(dt > 0)) return state;

    const newState = cloneSimulationState(state);

    if (hasRelief) {
      this.updateReliefValves(newState, dt);
    }

    // CVCS boration/dilution: the operator sets a target concentration and
    // the charging system slews toward it. Real plants change RCS boron at
    // a few ppm/min; we allow a brisk 0.5 ppm/s so it is playable at 1x.
    if (boronPending) {
      const n = newState.neutronics;
      const BORON_SLEW = 0.5; // ppm/s
      const current = n.boronPpm ?? 0;
      const target = n.boronTargetPpm ?? 0;
      const step = Math.max(-BORON_SLEW * dt, Math.min(BORON_SLEW * dt, target - current));
      n.boronPpm = current + step;
    }

    if (controllers) {
      for (const [, ctl] of newState.components.controllers) {
        // A loop SCANS - it does not run at solver cadence. The velocity form
        // increments by kp*(error - lastError), which measures the change
        // since the last update, so running it every accepted step makes that
        // term the step-to-step JITTER of the measurement. The solver takes
        // hundreds of steps a second in a lively plant, so that noise walks
        // the output around by kp*sigma*sqrt(N) while the integral, which
        // grows as ki*error*t, is left orders of magnitude behind: the
        // Xe-100's feed loop sat still against a sustained +20 kg/s error
        // because the P term was re-rolling the dice 100 times a second.
        //
        // Real DCS loops scan on a fixed period for exactly this reason, and
        // the lambda tuning below is already written in seconds against one.
        const since = state.time - (ctl.lastScanTime ?? -Infinity);
        if (since < (ctl.scanPeriod ?? DEFAULT_SCAN_PERIOD)) continue;
        ctl.lastScanTime = state.time;
        this.updateController(newState, ctl, Number.isFinite(since) ? since : dt);
      }
    }
    return newState;
  }

  /**
   * Relief valves and PORVs: spring/pilot-actuated devices, not PI loops.
   * Pop fully open when the sensed pressure reaches the setpoint; stay open
   * (latched) until the pressure falls to setpoint*(1-blowdown), then reseat.
   * The disc strokes at a finite rate so the flow solver sees a continuous
   * resistance change rather than a step (a real safety valve pops in ~0.1 s;
   * we use a slightly gentler stroke, which matters only for the first
   * fraction of a second of each lift).
   */
  private updateReliefValves(state: SimulationState, dt: number): void {
    const FULL_STROKE_SECONDS = 0.3;
    for (const [, valve] of state.components.valves) {
      const relief = valve.relief;
      if (!relief) continue;
      const senseNode = state.flowNodes.get(relief.senseNodeId);
      if (!senseNode) {
        throw new Error(
          `[ControlSystem] Relief valve '${valve.id}': sense node '${relief.senseNodeId}' not found`
        );
      }

      let demandOpen: boolean;
      switch (relief.controlMode) {
        case 'open': demandOpen = true; break;
        case 'closed': demandOpen = false; break;
        default: {
          const P = senseNode.fluid.pressure;
          if (P >= relief.setpoint) demandOpen = true;
          else if (P <= relief.setpoint * (1 - relief.blowdown)) demandOpen = false;
          else demandOpen = valve.reliefOpen ?? false; // between reseat and pop: hold latch
        }
      }
      if (demandOpen && !(valve.reliefOpen ?? false)) {
        valve.liftCount = (valve.liftCount ?? 0) + 1;
      }
      valve.reliefOpen = demandOpen;

      const target = demandOpen ? 1 : 0;
      const maxStep = dt / FULL_STROKE_SECONDS;
      valve.position += Math.max(-maxStep, Math.min(maxStep, target - valve.position));
    }
  }

  private updateController(state: SimulationState, ctl: ControllerState, dt: number): void {
    if (ctl.actuator.kind === 'control-rods') {
      this.updateRodController(state, ctl, dt);
      return;
    }

    const pv = this.readSensor(state, ctl);
    const setpoint = this.readSetpoint(state, ctl);
    // Positive error must always demand MORE output; invert flags
    // reverse-acting loops (spray on pressure, steam valve on upstream P).
    const error = ctl.invert ? pv - setpoint : setpoint - pv;

    let output: number;
    if (ctl.mode === 'manual') {
      output = ctl.manualOutput ?? ctl.lastOutput;
    } else {
      // Gains in output units: PI acts in flow units (kg/s) or watts, then
      // converts through the actuator flow gain.
      const gA = this.actuatorFlowGain(state, ctl);
      let kp: number;
      let ki: number;
      if (ctl.gains) {
        kp = ctl.gains.kp;
        ki = ctl.gains.ki;
      } else {
        const lambda = (LAMBDA_DEFAULTS[this.sensorKindOf(ctl)] ?? 30) / Math.max(0.1, ctl.aggressiveness || 1);
        const kPrime = this.processIntegratingGain(state, ctl);
        // SIMC for an integrating process: Kc = 1/(k'·λ), Ti = 4λ
        const kpFlow = 1 / (kPrime * lambda);
        const kiFlow = kpFlow / (4 * lambda);
        kp = kpFlow / gA;
        ki = kiFlow / gA;
        ctl.lastAutoGains = { kp, ki };
      }

      // Velocity-form PI increment
      let du = kp * (error - ctl.lastError) + ki * error * dt;

      // Feedforward (three-element): follow changes in the measured
      // feedforward flow, converted to actuator units. Velocity form needs
      // only the CHANGE in feedforward, so an imperfect gA cancels out at
      // steady state (the PI trim owns the DC value).
      if (ctl.feedforward) {
        const ff = this.readConnectionFlow(state, ctl.feedforward.targetId, ctl.id);
        const lastFf = ctl.lastFeedforward ?? ff;
        du += (ff - lastFf) / gA;
        ctl.lastFeedforward = ff;
      }

      output = ctl.lastOutput + du;
    }

    // Actuator limits: slew rate, then saturation
    const maxStep = ctl.actuator.rateLimit * dt;
    output = Math.max(ctl.lastOutput - maxStep, Math.min(ctl.lastOutput + maxStep, output));
    output = Math.max(ctl.actuator.min, Math.min(ctl.actuator.max, output));

    this.writeActuator(state, ctl, output);
    ctl.lastOutput = output;
    ctl.lastError = error;
  }

  /**
   * Reactor power control via rods. Rod position is already the integral of
   * rod velocity and the core self-stabilizes through Doppler, so this is a
   * speed-limited proportional velocity law, not a PI: full rod speed at
   * ROD_ERROR_BAND power error, dead band against dithering. Blocked while
   * scrammed (safety systems outrank the controller).
   */
  private updateRodController(state: SimulationState, ctl: ControllerState, dt: number): void {
    const n = state.neutronics;
    if (!n.coreId || n.nominalPower <= 0) {
      throw new Error(`[ControlSystem] '${ctl.id}': control-rods actuator but no core/neutronics present`);
    }
    if (n.scrammed) {
      // Track the scrammed rod position so recovery is bumpless
      ctl.lastOutput = n.controlRodPosition;
      ctl.lastError = 0;
      return;
    }

    const bands = ROD_BANDS[this.sensorKindOf(ctl)];
    if (!bands) {
      throw new Error(
        `[ControlSystem] '${ctl.id}': control-rods actuator has no proportional band for ` +
        `sensor kind '${this.sensorKindOf(ctl)}' (supported: ${Object.keys(ROD_BANDS).join(', ')})`
      );
    }
    const pv = this.readSensor(state, ctl);
    const setpoint = this.readSetpoint(state, ctl);
    const error = ctl.invert ? pv - setpoint : setpoint - pv;

    // Lead (rate) compensation, as in a real rod controller's lead-lag: act
    // on the PROJECTED error ~40 s ahead. Against the loop's transport delay,
    // raw proportional action keeps driving rods while the error is already
    // closing, over-inserts by whole dollars, and limit-cycles the plant
    // between power bursts and shutdowns.
    const LEAD_SECONDS = 40;
    const dErrDt = (error - ctl.lastError) / dt;
    const leadTerm = Math.max(-2 * bands.band, Math.min(2 * bands.band, LEAD_SECONDS * dErrDt));
    const errProjected = error + leadTerm;

    let velocityDemand = 0;
    if (ctl.mode === 'manual') {
      const target = ctl.manualOutput ?? n.controlRodPosition;
      velocityDemand = Math.sign(target - n.controlRodPosition);
    } else if (Math.abs(errProjected) > bands.deadband) {
      velocityDemand = Math.max(-1, Math.min(1, errProjected / bands.band));
    }

    // Withdrawal inhibit on short reactor period (real RODC feature): near
    // zero power there is no thermal feedback, so continued withdrawal
    // accumulates reactivity that later overshoots violently. If power is
    // already rising with a period under ~20 s, further withdrawal waits for
    // the thermal feedback to catch up. Insertion is never inhibited.
    const prevPower = ctl.lastAux ?? n.power;
    const powerRate = (n.power - prevPower) / (dt * Math.max(n.power, 1e-6 * n.nominalPower));
    if (velocityDemand > 0 && powerRate > 0.05) {
      velocityDemand = 0;
    }
    ctl.lastAux = n.power;

    // Rod-withdrawal permissive: never withdraw above the power limit
    // (default rated power). A temperature-mode controller has no intrinsic
    // power ceiling - with a strong SG, T_cold barely depends on power, so
    // chasing a T setpoint would ratchet power indefinitely.
    const powerLimit = ctl.powerLimit ?? 1.0;
    if (velocityDemand > 0 && n.power >= powerLimit * n.nominalPower) {
      velocityDemand = 0;
    }

    const newPos = Math.max(
      ctl.actuator.min,
      Math.min(ctl.actuator.max, n.controlRodPosition + velocityDemand * ctl.actuator.rateLimit * dt)
    );
    n.controlRodPosition = newPos;
    ctl.lastOutput = newPos;
    ctl.lastError = error;
  }

  // ==========================================================================
  // Sensors
  // ==========================================================================

  /**
   * Evaluate a measurement expression (see ControllerSignal).
   *
   * Every operator is total over its inputs except `ratio`, which is the one
   * that can be handed a divisor the plant legitimately makes zero - a steam
   * flow at startup, a level in an empty vessel. It throws rather than
   * returning an infinity that would arrive at the PI as a NaN two lines
   * later and freeze the loop silently. A ratio belongs on the SETPOINT,
   * where the denominator is a constant.
   */
  private evaluateSignal(
    state: SimulationState, sig: ControllerSignal, ctl: ControllerState
  ): number {
    const op = (sig as { op?: string }).op ?? 'signal';
    switch (op) {
      case 'signal': {
        const leaf = sig as { kind: ControllerSensorKind; targetId: string };
        return this.readSignalKind(state, leaf.kind, leaf.targetId, ctl);
      }
      case 'const':
        return (sig as { value: number }).value;
      case 'scale': {
        const n = sig as { input: ControllerSignal; factor: number; offset?: number };
        return this.evaluateSignal(state, n.input, ctl) * n.factor + (n.offset ?? 0);
      }
      default: {
        const n = sig as { op: string; inputs: ControllerSignal[] };
        if (!Array.isArray(n.inputs) || n.inputs.length === 0) {
          throw new Error(`[ControlSystem] '${ctl.id}': '${op}' has no inputs`);
        }
        const v = n.inputs.map(i => this.evaluateSignal(state, i, ctl));
        switch (op) {
          case 'sum': return v.reduce((a, b) => a + b, 0);
          case 'diff': return v.slice(1).reduce((a, b) => a - b, v[0]);
          case 'product': return v.reduce((a, b) => a * b, 1);
          case 'min': return Math.min(...v);
          case 'max': return Math.max(...v);
          case 'ratio': {
            let r = v[0];
            for (const d of v.slice(1)) {
              if (Math.abs(d) < 1e-12) {
                throw new Error(
                  `[ControlSystem] '${ctl.id}': ratio divides by ${d} - a measurement the ` +
                  `plant can legitimately zero (a shut steam line, an empty vessel) does not ` +
                  `belong under a divisor. Put the ratio on the setpoint instead, where the ` +
                  `denominator is a constant.`);
              }
              r /= d;
            }
            return r;
          }
          default:
            throw new Error(`[ControlSystem] '${ctl.id}': unknown sensor operator '${op}'`);
        }
      }
    }
  }

  /**
   * The signal an expression is TUNED against: its first leaf, in written
   * order. Lambda and the process gain are per sensor kind, and a composite
   * has no single kind - so the convention is that the first signal named is
   * the one the loop is really about (the trim in a three-element scheme, the
   * level in a level/flow cascade). Anything exotic enough for that to be
   * wrong should carry explicit `gains`.
   */
  private primaryLeaf(sig: ControllerSignal): { kind: ControllerSensorKind; targetId: string } | null {
    const op = (sig as { op?: string }).op ?? 'signal';
    if (op === 'signal') return sig as { kind: ControllerSensorKind; targetId: string };
    if (op === 'const') return null;
    if (op === 'scale') return this.primaryLeaf((sig as { input: ControllerSignal }).input);
    for (const i of (sig as { inputs: ControllerSignal[] }).inputs ?? []) {
      const leaf = this.primaryLeaf(i);
      if (leaf) return leaf;
    }
    return null;
  }

  /** The measurement's tuning kind, or a loud error if it has no signal in it. */
  private sensorKindOf(ctl: ControllerState): ControllerSensorKind {
    const leaf = this.primaryLeaf(ctl.sensor);
    if (!leaf) {
      throw new Error(
        `[ControlSystem] '${ctl.id}': the measurement is made only of constants - ` +
        `there is nothing for the loop to follow.`);
    }
    return leaf.kind;
  }

  /** The setpoint, whether written as a number or as an expression. */
  private readSetpoint(state: SimulationState, ctl: ControllerState): number {
    return typeof ctl.setpoint === 'number'
      ? ctl.setpoint
      : this.evaluateSignal(state, ctl.setpoint, ctl);
  }

  private readSensor(state: SimulationState, ctl: ControllerState): number {
    return this.evaluateSignal(state, ctl.sensor, ctl);
  }

  private readSignalKind(
    state: SimulationState, kind: ControllerSensorKind, targetId: string, ctl: ControllerState
  ): number {
    switch (kind) {
      case 'node-level': {
        const node = this.getNode(state, targetId, ctl.id, 'sensor');
        return nodeLiquidLevel(node);
      }
      case 'node-pressure':
        return this.getNode(state, targetId, ctl.id, 'sensor').fluid.pressure;
      case 'node-temperature':
        return this.getNode(state, targetId, ctl.id, 'sensor').fluid.temperature;
      case 'connection-flow':
        return this.readConnectionFlow(state, targetId, ctl.id);
      case 'reactor-power': {
        const n = state.neutronics;
        if (!n.coreId || n.nominalPower <= 0) {
          throw new Error(`[ControlSystem] '${ctl.id}': reactor-power sensor but no core/neutronics present`);
        }
        return n.power / n.nominalPower;
      }
      case 'otsg-superheat-fraction': {
        const node = this.getNode(state, targetId, ctl.id, 'sensor');
        const cfg = node.otsg;
        if (!cfg) {
          throw new Error(
            `[ControlSystem] '${ctl.id}': otsg-superheat-fraction sensor on '${targetId}', ` +
            `which is not a moving-boundary boiler tube node (no otsg state). Point it at a ` +
            `heat exchanger built with tubeModel 'moving-boundary'.`
          );
        }
        // Evaluate the sections HERE rather than reading otsg.lastEval. That
        // cache is written by the rate operator onto the solver's per-stage
        // clones, so it never reaches the accepted state a controller runs
        // on - a sensor reading it sees undefined forever and the loop sits
        // frozen at its setpoint, which is exactly how this one first failed.
        // The subcooled section's energy U1 and the node's totals ARE
        // integrated state, so the evaluation can be redone from them - at the
        // WATER's own pressure and energy, which is all the sections describe
        // (tubeWaterState; identical to the stored totals with no gas about).
        const water = tubeWaterState(node);
        const ev = evaluateOtsgAtP(
          cfg.U1, node.fluid.mass, water.energy,
          water.pressure, this.otsgFeedEnergy(state, node),
          { tubeVolume: node.volume, tubeLength: 1, heatArea: cfg.heatArea },
        );
        return ev.sections[2].lengthFrac;
      }
      default:
        throw new Error(`[ControlSystem] '${ctl.id}': unknown sensor kind '${kind}'`);
    }
  }

  /**
   * Specific energy of the feedwater entering a boiler tube node (J/kg).
   *
   * The sectioned evaluation needs it to place the subcooled section's mean.
   * With no feed flowing there is nothing to average, so this reports the
   * closure's own ceiling - saturated liquid less the 25 kJ/kg the profile
   * needs to stay inside its valid domain - which is the value
   * evaluateOtsgAtP would cap any hotter feed to anyway.
   */
  private otsgFeedEnergy(state: SimulationState, node: FlowNode): number {
    let flow = 0, energyNum = 0;
    for (const conn of state.flowConnections) {
      const into = conn.toNodeId === node.id ? conn.massFlowRate
        : conn.fromNodeId === node.id ? -conn.massFlowRate : 0;
      if (into <= 0 || conn.currentFlowPhase === 'vapor') continue;
      const donor = state.flowNodes.get(
        conn.toNodeId === node.id ? conn.fromNodeId : conn.toNodeId);
      if (!donor) continue;
      flow += into;
      energyNum += into * saturatedLiquidEnergy(donor.fluid.temperature);
    }
    const uSatCeiling = saturatedLiquidEnergy(node.fluid.temperature) - 25e3;
    return flow > 0 ? Math.min(energyNum / flow, uSatCeiling) : uSatCeiling;
  }

  private readConnectionFlow(state: SimulationState, connId: string, ctlId: string): number {
    const conn = state.flowConnections.find(c => c.id === connId);
    if (!conn) {
      throw new Error(`[ControlSystem] '${ctlId}': flow connection '${connId}' not found`);
    }
    return conn.massFlowRate;
  }

  private getNode(state: SimulationState, nodeId: string, ctlId: string, role: string): FlowNode {
    const node = state.flowNodes.get(nodeId);
    if (!node) {
      throw new Error(`[ControlSystem] '${ctlId}': ${role} flow node '${nodeId}' not found`);
    }
    return node;
  }

  // ==========================================================================
  // Auto-gain ingredients
  // ==========================================================================

  /**
   * Integrating-process gain k' = d(dy/dt)/d(q): sensor-units per second per
   * (kg/s of net flow, or W for heater actuators). Read from the live state.
   */
  private processIntegratingGain(state: SimulationState, ctl: ControllerState): number {
    // Tuned against the measurement's primary signal - see primaryLeaf.
    const { kind, targetId } = this.primaryLeaf(ctl.sensor) ?? { kind: 'node-level' as const, targetId: '' };
    const heater = ctl.actuator.kind === 'heater-power';

    switch (kind) {
      case 'node-level': {
        // dLevel/dt = q/(rho_liq * A_surface)
        const node = this.getNode(state, targetId, ctl.id, 'sensor');
        const height = node.height && node.height > 0 ? node.height : Math.cbrt(node.volume);
        const area = node.volume / height;
        return 1 / (approxLiquidDensity(node) * area);
      }
      case 'node-pressure': {
        const node = this.getNode(state, targetId, ctl.id, 'sensor');
        if (heater) {
          // Two-phase node on the saturation line: dP/dt = Q * (dP_sat/dT) / (m*c_eff).
          // c_eff ~ 6 kJ/kg-K (saturated-liquid c_p scale); factor-of-2 error
          // in c_eff only shifts lambda, which the SIMC margins absorb.
          const T = node.fluid.temperature;
          const dPsat_dT = (saturationPressure(T + 0.5) - saturationPressure(T - 0.5));
          const cEff = 6000;
          return Math.max(1e-12, dPsat_dT) / (node.fluid.mass * cEff);
        }
        // Flow actuator: dP/dt = q*K/(rho*V) - the same compliance concept the
        // pressure solver uses. Vapor: K = gamma*P; two-phase: ~P_sat = P.
        const K = node.fluid.phase === 'vapor' ? 1.3 * node.fluid.pressure : node.fluid.pressure;
        const rho = node.fluid.mass / node.volume;
        return K / (rho * node.volume);
      }
      case 'node-temperature': {
        const node = this.getNode(state, targetId, ctl.id, 'sensor');
        const cEff = 5000; // J/kg-K, liquid water scale
        // Heater actuators are in watts: dT/dt = Q/(m*c).
        if (heater) return 1 / (node.fluid.mass * cEff);
        // Flow actuators are in kg/s, so the kg must be converted to watts
        // before dividing by the node's heat capacity - without this the
        // computed kp comes out ~6 orders of magnitude too hot and the PI
        // degenerates into a slew-limited bang-bang driven by the error
        // DERIVATIVE (feed slams to full while the steam is still 170 K too
        // cold, merely because it is warming). A kg of injected stream moves
        // the node's energy by an enthalpy-difference scale ~2 MJ/kg
        // (feedwater into superheated steam: sensible + latent). A factor-2
        // error here only shifts lambda, which the SIMC margins absorb -
        // the same tolerance the node-pressure template leans on.
        const H_SCALE = 2e6; // J/kg
        return H_SCALE / (node.fluid.mass * cEff);
      }
      case 'connection-flow':
        // Flow responds within a step under the implicit momentum solve -
        // treat as a fast integrator with a 1-second effective inertia so the
        // PI is a smooth tracker rather than a deadbeat controller.
        return 1;
      case 'otsg-superheat-fraction': {
        // A kilogram of feed the boiler is not evaporating accumulates as
        // liquid, and at fixed tube volume that liquid displaces steam - so
        // the boundaries move at d(fraction)/dt = W * v_liquid / V_tube. The
        // gain is a property of the bundle, not a constant: a big bundle
        // swallows the same excess feed with a proportionally smaller shift.
        const node = this.getNode(state, targetId, ctl.id, 'sensor');
        return 1 / (approxLiquidDensity(node) * node.volume);
      }
      default:
        throw new Error(`[ControlSystem] '${ctl.id}': no gain template for sensor kind '${kind}'`);
    }
  }

  /**
   * Actuator flow gain gA = d(flow)/d(output), estimated from the current
   * operating point (this is what makes the loop self gain-scheduling).
   * Heater actuators are already in watts (gA = 1).
   */
  private actuatorFlowGain(state: SimulationState, ctl: ControllerState): number {
    const { kind, targetId } = ctl.actuator;
    switch (kind) {
      case 'heater-power':
        return 1;
      case 'pump-speed': {
        const pump = state.components.pumps.get(targetId);
        if (!pump) throw new Error(`[ControlSystem] '${ctl.id}': pump '${targetId}' not found`);
        const flow = Math.abs(this.readConnectionFlow(state, pump.connectedFlowPath, ctl.id));
        // Affinity-law scale flow ~ speed; floor at a fraction of rated so
        // the gain stays sane while flow is still establishing.
        return Math.max(pump.ratedFlow * 0.3, flow / Math.max(0.2, pump.effectiveSpeed));
      }
      case 'valve-position': {
        const valve = state.components.valves.get(targetId);
        if (!valve) throw new Error(`[ControlSystem] '${ctl.id}': valve '${targetId}' not found`);
        const flow = Math.abs(this.readConnectionFlow(state, valve.connectedFlowPath, ctl.id));
        // K_eff ~ K/pos^2 makes flow ~linear in position at fixed dP.
        // Floor keeps the controller moving while the valve is nearly closed
        // with no flow yet (it simply opens at a bounded rate until flow
        // establishes and the estimate takes over).
        return Math.max(10, flow / Math.max(0.05, valve.position));
      }
      case 'governor-valve': {
        const node = this.getNode(state, targetId, ctl.id, 'actuator');
        const gv = node.governorValve ?? 1;
        let inflow = 0;
        for (const conn of state.flowConnections) {
          if (conn.toNodeId === targetId) inflow += Math.max(0, conn.massFlowRate);
          if (conn.fromNodeId === targetId) inflow += Math.max(0, -conn.massFlowRate);
        }
        return Math.max(10, inflow / Math.max(0.05, gv));
      }
      default:
        throw new Error(`[ControlSystem] '${ctl.id}': unknown actuator kind '${kind}'`);
    }
  }

  // ==========================================================================
  // Actuators
  // ==========================================================================

  private writeActuator(state: SimulationState, ctl: ControllerState, output: number): void {
    const { kind, targetId } = ctl.actuator;
    switch (kind) {
      case 'valve-position': {
        const valve = state.components.valves.get(targetId);
        if (!valve) throw new Error(`[ControlSystem] '${ctl.id}': valve '${targetId}' not found`);
        valve.position = output;
        return;
      }
      case 'pump-speed': {
        const pump = state.components.pumps.get(targetId);
        if (!pump) throw new Error(`[ControlSystem] '${ctl.id}': pump '${targetId}' not found`);
        pump.speed = output;
        return;
      }
      case 'governor-valve': {
        const node = this.getNode(state, targetId, ctl.id, 'actuator');
        node.governorValve = output;
        return;
      }
      case 'heater-power': {
        const node = this.getNode(state, targetId, ctl.id, 'actuator');
        const cap = node.heaterCapacity ?? ctl.actuator.max;
        node.heaterPower = Math.min(output, cap);
        return;
      }
      default:
        throw new Error(`[ControlSystem] '${ctl.id}': unknown actuator kind '${kind}'`);
    }
  }
}

/**
 * Liquid level (m above node bottom) of a flow node, accounting for internal
 * obstructions. Vapor nodes read 0; liquid-full nodes read the node height.
 * Shared with the steady-state detector and (later) UI display.
 */
/**
 * A measurement expression as readable text, for logs and for the UI.
 *
 * Anything that displays a controller has to cope with a setpoint that is no
 * longer necessarily a number and a sensor that is no longer necessarily a
 * leaf - `${sp.toFixed(1)} kg/s` on an expression is a TypeError, and in a
 * render loop that takes the whole frame down with it.
 */
export function describeControllerSignal(sig: ControllerSignal | number | undefined): string {
  if (sig === undefined) return '-';
  if (typeof sig === 'number') return String(sig);
  const op = (sig as { op?: string }).op ?? 'signal';
  switch (op) {
    case 'signal': {
      const leaf = sig as { kind: string; targetId: string };
      return leaf.targetId ? `${leaf.kind}(${leaf.targetId})` : leaf.kind;
    }
    case 'const':
      return String((sig as { value: number }).value);
    case 'scale': {
      const n = sig as { input: ControllerSignal; factor: number; offset?: number };
      const body = `${n.factor}x ${describeControllerSignal(n.input)}`;
      return n.offset ? `(${body} ${n.offset > 0 ? '+' : '-'} ${Math.abs(n.offset)})` : body;
    }
    default: {
      const n = sig as { inputs?: ControllerSignal[] };
      return `${op}(${(n.inputs ?? []).map(describeControllerSignal).join(', ')})`;
    }
  }
}

/** The signal a measurement is really about - its first leaf. Exported for
 *  displays that want to label a composite by what it follows. */
export function primaryControllerSignal(
  sig: ControllerSignal | undefined
): { kind: ControllerSensorKind; targetId: string } | undefined {
  if (!sig) return undefined;
  const op = (sig as { op?: string }).op ?? 'signal';
  if (op === 'signal') return sig as { kind: ControllerSensorKind; targetId: string };
  if (op === 'const') return undefined;
  if (op === 'scale') return primaryControllerSignal((sig as { input: ControllerSignal }).input);
  for (const i of (sig as { inputs?: ControllerSignal[] }).inputs ?? []) {
    const leaf = primaryControllerSignal(i);
    if (leaf) return leaf;
  }
  return undefined;
}

export function nodeLiquidLevel(node: FlowNode): number {
  const phase = node.fluid.phase;
  if (phase === 'vapor') return 0;
  const quality = phase === 'two-phase' ? (node.fluid.quality ?? 0) : 0;
  const liquidMass = node.fluid.mass * (1 - quality);
  const liquidVolume = liquidMass / approxLiquidDensity(node);
  return calculateLiquidLevelWithObstructions(node, liquidVolume);
}
