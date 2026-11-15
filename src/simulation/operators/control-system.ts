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
import { saturationPressure } from '../water-properties';
import { nodeGasVolume } from '../mixture-properties';
import { evaluateOtsgSections } from './otsg-operator';
import {
  nodeLiquidDensity,
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
        // A cabinet without power does not scan. Its clock stops with it, so
        // the first scan after the power returns measures the whole outage.
        if (ctl.powered === false) continue;
        const since = state.time - (ctl.lastScanTime ?? -Infinity);
        if (since < (ctl.scanPeriod ?? DEFAULT_SCAN_PERIOD)) continue;
        ctl.lastScanTime = state.time;
        this.updateController(newState, ctl, Number.isFinite(since) ? since : dt);
      }
      // The actuators move EVERY step, toward the command the last scan
      // left, at their rate limit. A scan used to write its command straight
      // to the plant, so a governor with a 2 s stroke scanned at 0.1 s jumped
      // 5% at a time and a boiler with dP/dm in the bars-per-kilogram range
      // took each feed step as a 1.5 bar kick - a discontinuity no error
      // controller can price, and the largest thing left in the closure
      // error of the Xe-100. Real actuators stroke continuously; the loop's
      // rate limit already IS that stroke rate, so this only moves where the
      // limit is applied: from the command to the device.
      for (const [, ctl] of newState.components.controllers) {
        if (ctl.actuator.kind === 'control-rods') continue;
        // Nothing drives the actuator without power - neither a dead cabinet
        // nor a motor-operated valve on a dead bus: it stays where it is.
        if (ctl.powered === false) continue;
        if (ctl.actuator.kind === 'valve-position' &&
            newState.components.valves.get(ctl.actuator.targetId)?.powered === false) continue;
        this.slewActuator(newState, ctl, dt);
      }
    }
    return newState;
  }

  /** Move the actuator toward the loop's command at its rate limit. */
  private slewActuator(state: SimulationState, ctl: ControllerState, dt: number): void {
    const command = ctl.lastOutput;
    const actual = ctl.actual ?? command;
    const maxStep = ctl.actuator.rateLimit * dt;
    const next = Math.max(actual - maxStep, Math.min(actual + maxStep, command));
    ctl.actual = next;
    this.writeActuator(state, ctl, next);
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
      // A PORV is held open by its solenoid: with no DC power it closes,
      // whatever the pressure or the operator's switch says. (Spring safety
      // valves are not loads and never carry the flag.)
      if (valve.powered === false) {
        demandOpen = false;
      } else switch (relief.controlMode) {
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
      } else if (this.sensorKindOf(ctl) === 'connection-flow') {
        // A flow answers its actuator within the scan - the momentum solve is
        // implicit - so to a sampled loop it is a STATIC gain, not an
        // integrator. A proportional term on a static process is positive
        // feedback through the one-scan delay: the increment kp*(e - e_last)
        // is answered a scan later by its own mirror image, a pole at
        // -kp*gain however fast the loop scans. SIMC for a pure gain is
        // integral-only, Ki = 1/(gain*lambda): the flow closes on its
        // setpoint as exp(-t/lambda), and the loop tolerates a gain estimate
        // off by 2*lambda/scan before it rings.
        const lambda = LAMBDA_DEFAULTS['connection-flow'] / Math.max(0.1, ctl.aggressiveness || 1);
        kp = 0;
        ki = 1 / (lambda * gA);
        ctl.lastAutoGains = { kp, ki };
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

      // Velocity-form PI increment, its two parts kept apart (see below)
      let duFast = kp * (error - ctl.lastError);
      const duIntegral = ki * error * dt;

      // Feedforward (three-element): follow changes in the measured
      // feedforward flow, converted to actuator units. Velocity form needs
      // only the CHANGE in feedforward, so an imperfect gA cancels out at
      // steady state (the PI trim owns the DC value).
      if (ctl.feedforward) {
        const ff = this.readConnectionFlow(state, ctl.feedforward.targetId, ctl.id);
        const lastFf = ctl.lastFeedforward ?? ff;
        duFast += (ff - lastFf) / gA;
        ctl.lastFeedforward = ff;
      }

      // Each part is held to one scan's stroke SEPARATELY. The velocity form
      // keeps its integral in the command itself, so a single limit on the
      // sum throws the integral away whenever the proportional kick alone
      // reaches the limit: a loop ringing between +stroke and -stroke nets
      // zero per pair of scans however large its standing error, and never
      // corrects it (the Xe-100 feed loop sat 1.5 kg/s off its trim for an
      // hour this way). What stops the command running away from a device
      // that cannot keep up is the limit against the device's ACTUAL
      // position: it may lead by two scans of stroke and no more.
      const stroke = ctl.actuator.rateLimit * dt;
      const within = (x: number) => Math.max(-stroke, Math.min(stroke, x));
      const actual = ctl.actual ?? ctl.lastOutput;
      output = ctl.lastOutput + within(duFast) + within(duIntegral);
      output = Math.max(actual - 2 * stroke, Math.min(actual + 2 * stroke, output));
    }

    // Manual: at most one scan's worth of stroke toward the operator's
    // demand. The command is what the actuator can reach by the next scan;
    // the device itself is moved toward it step by step (slewActuator), so
    // the plant sees a continuous stroke, never a jump.
    if (ctl.mode === 'manual') {
      const maxStep = ctl.actuator.rateLimit * dt;
      output = Math.max(ctl.lastOutput - maxStep, Math.min(ctl.lastOutput + maxStep, output));
    }
    // actuator.min/max is the LOOP's authority band - how far the controller
    // may drive the device on its own (a governor trim held to 0.05-0.45).
    // An operator in manual is not the loop: the device goes wherever the
    // device itself can go. Clamping manual into the band silently kept a
    // "shut" governor 5% open behind every blackout scenario.
    const [lo, hi] = ctl.mode === 'manual' ? this.deviceRange(state, ctl) : [ctl.actuator.min, ctl.actuator.max];
    output = Math.max(lo, Math.min(hi, output));

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
        // The partition is solved from the node's totals, so the shared
        // evaluation path can simply be rerun on the accepted state.
        return evaluateOtsgSections(state, targetId, node).ev.sections[2].lengthFrac;
      }
      case 'otsg-outlet-temperature': {
        const node = this.getNode(state, targetId, ctl.id, 'sensor');
        if (!node.otsg) {
          throw new Error(
            `[ControlSystem] '${ctl.id}': otsg-outlet-temperature sensor on '${targetId}', ` +
            `which is not a moving-boundary boiler tube node (no otsg state). Point it at a ` +
            `heat exchanger built with tubeModel 'moving-boundary'.`
          );
        }
        // Evaluated here for the same reason as the superheat fraction above.
        return evaluateOtsgSections(state, targetId, node).ev.TSteamOut;
      }
      default:
        throw new Error(`[ControlSystem] '${ctl.id}': unknown sensor kind '${kind}'`);
    }
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
        return 1 / (nodeLiquidDensity(node) * area);
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
      // 'connection-flow' is not here: a flow is a static gain, not an
      // integrator, and is tuned integral-only in updateController.
      case 'otsg-superheat-fraction': {
        // A kilogram of feed the boiler is not evaporating accumulates as
        // liquid, and at fixed tube volume that liquid displaces steam - so
        // the boundaries move at d(fraction)/dt = W * v_liquid / V_tube. The
        // gain is a property of the bundle, not a constant: a big bundle
        // swallows the same excess feed with a proportionally smaller shift.
        const node = this.getNode(state, targetId, ctl.id, 'sensor');
        return 1 / (nodeLiquidDensity(node) * node.volume);
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
        // Floor at a fraction of rated so the loop keeps moving while flow
        // is still establishing (below the deadhead speed nothing flows and
        // the true gain is zero).
        const floor = pump.ratedFlow * 0.3;
        const s = pump.effectiveSpeed;
        if (!(flow > 0) || !(s > 0)) return floor;
        // The pump curve H = Hr(1.25 s^2 - 0.25 q^2) meets a system curve
        // h0 + c q^2 (static head plus friction). Differentiating the
        // balance at the operating point, the friction coefficient drops
        // out and
        //     dQ/ds = Q s / (s^2 - s0^2),   s0^2 = h0 / 1.25
        // with s0 the DEADHEAD speed - where the shutoff head just equals
        // the static head. No static head gives the affinity law Q/s; a
        // feed pump lifting into a boiler runs a little above s0 and its
        // flow is several times more sensitive than that (the Xe-100 pump:
        // deadhead at 0.48, 60 kg/s at 0.575, 300 kg/s per unit speed where
        // affinity says 105 - a loop tuned on the affinity figure rang
        // between its rate limits). Friction cannot be negative, so the
        // gain is at most the no-friction value 5 s Qr^2 / Q.
        const conn = state.flowConnections.find(c => c.id === pump.connectedFlowPath);
        if (!conn) throw new Error(`[ControlSystem] '${ctl.id}': pump '${targetId}' has no discharge connection '${pump.connectedFlowPath}'`);
        const pumpNode = this.getNode(state, conn.fromNodeId, ctl.id, 'pump');
        const rho = pumpNode.fluid.phase === 'liquid'
          ? nodeLiquidDensity(pumpNode) : pumpNode.fluid.mass / pumpNode.volume;
        const h0 = this.pumpStaticHead(state, conn, pumpNode, rho) / (rho * 9.81 * pump.ratedHead);
        const frictionless = 5 * s * pump.ratedFlow * pump.ratedFlow / flow;
        const margin = s * s - h0 / 1.25;
        const gain = margin > 0 ? Math.min(frictionless, flow * s / margin) : frictionless;
        return Math.max(floor, gain);
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

  /**
   * The static head a pump works against (Pa): the pressure it must make
   * before anything flows. Followed downstream from the pump's discharge
   * through liquid-full nodes - which pass a pressure change straight on -
   * to the first node that can take the flow up without its pressure
   * answering within a scan: one with a vapour space, or the suction of the
   * next pump in the train. The lift along the way is static head too. At a
   * branch the path is the line carrying the most flow. A path that comes
   * back to a node it has visited is a closed liquid loop, where the pump's
   * whole head is friction and there is no static head at all.
   */
  private pumpStaticHead(
    state: SimulationState,
    discharge: SimulationState['flowConnections'][number],
    pumpNode: FlowNode,
    rho: number,
  ): number {
    const pumpNodes = new Set<string>();
    for (const [, p] of state.components.pumps) {
      const c = state.flowConnections.find(x => x.id === p.connectedFlowPath);
      if (c) pumpNodes.add(c.fromNodeId);
    }
    const visited = new Set<string>([pumpNode.id]);
    let lift = rho * 9.81 * (discharge.elevation || 0);
    let nodeId = discharge.toNodeId;
    for (;;) {
      if (visited.has(nodeId)) return 0;
      visited.add(nodeId);
      const node = state.flowNodes.get(nodeId);
      if (!node) throw new Error(`[ControlSystem] flow node '${nodeId}' not found downstream of pump node '${pumpNode.id}'`);
      const takesUpFlow = node.fluid.phase !== 'liquid' || nodeGasVolume(node) > 0 || pumpNodes.has(nodeId);
      // Onward along the line carrying the most flow out of this node
      let next: { id: string; dz: number } | undefined;
      let most = 0;
      if (!takesUpFlow) {
        for (const c of state.flowConnections) {
          const out = c.fromNodeId === nodeId ? c.massFlowRate : c.toNodeId === nodeId ? -c.massFlowRate : 0;
          if (out > most) {
            most = out;
            const forward = c.fromNodeId === nodeId;
            next = { id: forward ? c.toNodeId : c.fromNodeId, dz: forward ? (c.elevation || 0) : -(c.elevation || 0) };
          }
        }
      }
      // A liquid-full node with nothing leaving it is the end of the line:
      // its pressure is what the pump is holding.
      if (!next) return node.fluid.pressure - pumpNode.fluid.pressure + lift;
      lift += rho * 9.81 * next.dz;
      nodeId = next.id;
    }
  }

  // ==========================================================================
  // Actuators
  // ==========================================================================

  /** The physical travel of the device an actuator drives, independent of
   *  any controller's authority band: a valve, pump speed, governor or rod
   *  bank runs 0..1; a heater 0 to its rated capacity. */
  private deviceRange(state: SimulationState, ctl: ControllerState): [number, number] {
    switch (ctl.actuator.kind) {
      case 'valve-position':
      case 'pump-speed':
      case 'governor-valve':
      case 'control-rods':
        return [0, 1];
      case 'heater-power':
        return [0, this.getNode(state, ctl.actuator.targetId, ctl.id, 'actuator').heaterCapacity ?? Infinity];
      default:
        throw new Error(`[ControlSystem] '${ctl.id}': unknown actuator kind '${ctl.actuator.kind}'`);
    }
  }

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

/**
 * The fraction of a node's height that stands in liquid (0-1) - the same
 * number `nodeLiquidLevel` reports, expressed against the node's height so
 * a drawing can use it directly.
 *
 * Single-phase nodes are exact (a liquid node is full, a vapour node is
 * empty) rather than divided out, so a solid-liquid node cannot read as
 * 100.3% full through its own compressibility.
 */
export function nodeLiquidLevelFraction(node: FlowNode): number {
  const phase = node.fluid.phase;
  if (phase === 'vapor') return 0;
  if (phase === 'liquid') return 1;
  const height = node.height;
  if (height !== undefined && height > 0) return nodeLiquidLevel(node) / height;
  // No height declared: fall back to the volume fraction, which is what a
  // drawing of a shapeless node can show anyway.
  return node.volume > 0 ? nodeLiquidVolume(node) / node.volume : 0;
}

/**
 * The liquid's volume in a two-phase node: everything but the vapour space
 * the mixture solve left (nodeGasVolume) - the same split the draws and the
 * hydrostatic head use (connection-hydraulics). This used to be the liquid
 * mass over a density fit, which put the surface somewhere the node's own
 * equation of state did not (0.05% at 12 C, 3-4% near 100 and 200 C).
 */
function nodeLiquidVolume(node: FlowNode): number {
  return node.volume - Math.max(0, Math.min(node.volume, nodeGasVolume(node)));
}

export function nodeLiquidLevel(node: FlowNode): number {
  const phase = node.fluid.phase;
  if (phase === 'vapor') return 0;
  const liquidVolume = phase === 'two-phase' ? nodeLiquidVolume(node) : node.volume;
  return calculateLiquidLevelWithObstructions(node, liquidVolume);
}
