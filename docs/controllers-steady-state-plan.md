# Plan: Auto-Tuned Controllers & Convergence to Operating Steady State

*Drafted 2026-07-06. Goal: an uncontrolled plant boils its SGs dry or drifts
into a reactivity excursion (see the 200 s runs in
semi-implicit-flow-solver-plan.md). This plan adds the minimum control layer
for the presets to converge to full-power steady state and hold it — without
the user ever tuning a PID.*

## Design principles

1. **The user states an intent, not gains.** "Keep this SG level steady" is a
   sensor + actuator + setpoint. Gains are derived from the plant's own
   physics, re-derived continuously (free gain scheduling), with one optional
   "sluggish ↔ aggressive" knob (`aggressiveness`, scales the closed-loop
   time constant). Manual PID entry remains available (`gains` override) for
   users who want it.
2. **Controllers are devices, not physics.** Unlike the physics model, they
   MAY have deadbands, rate limits, and saturation — real controllers do.
   The physics stays clamp-free.
3. **Sampled control, like a real DCS.** Controllers execute once per
   accepted solver step (5–500 ms — faster than any real plant DCS scan).
   They live in a `finalOnly` constraint operator, so RK45 stage states and
   rejected steps never see partial controller updates, and controller state
   (integrator) is part of `SimulationState` so save/rewind works.
4. **Generic building blocks.** One `ControllerState` shape covers every
   loop; "loop templates" only choose how gains are derived. Any sensor can
   drive any actuator, including nonsensical pairings (the identification
   fallback still produces *a* stable controller or an obvious failure).

## Architecture

### ControllerState (new, in `ComponentStates.controllers`)

```
id, label, mode: 'auto' | 'manual'
sensor:   { kind: node-level | node-pressure | node-temperature |
                   connection-flow | reactor-power,  targetId }
setpoint: number         // SI units; reactor-power in fraction of nominal
feedforward?: { kind: connection-flow, targetId, gain? }   // three-element
actuator: { kind: valve-position | pump-speed | governor-valve |
                   heater-power | control-rods,
            targetId, min, max, rateLimit }
aggressiveness: number   // 1 = default; >1 faster, <1 gentler
gains?: { kp, ki }       // manual override (advanced users)
invert?: boolean         // reverse-acting loop (e.g. spray: MORE output LOWERS pressure)
integral, lastError, lastOutput, lastAutoGains   // runtime state
```

### ControlSystemOperator (new, finalOnly ConstraintOperator)

Per accepted step: read sensor → derive gains → velocity-form PI →
rate-limit + clamp → write actuator. Velocity form
(Δu = Kp·Δe + Ki·e·dt) gives bumpless auto/manual transfer and inherent
anti-windup under output clamping. `ConstraintOperator.applyConstraints`
gains an optional `dt` argument (backward compatible).

### Auto-gain derivation (tier 1: analytic, per template)

All loops reduce to an integrating process `dy/dt = k'·u` whose k' is
readable from the live state; SIMC/lambda tuning then gives
`Kp = 1/(k'·λ)`, `Ti = 4λ` with λ = template default / aggressiveness.

| Template | k' from state | λ default |
|---|---|---|
| node-level | 1/(ρ_liq·A_surface) — geometry + fluid state | 30 s |
| node-pressure (fluid in/out) | K/(ρV) — the SAME compliance the pressure solver uses | 15 s |
| node-pressure (heater) | (dP_sat/dT)/(m·c_p,eff) — numerical from steam tables | 30 s |
| connection-flow | actuator flow gain only (below) | 5 s |
| reactor-power | rod-speed-limited P-control (below) | — |

**Actuator flow gain** (converts flow-units PI output to actuator units),
estimated online — this is what makes gains operating-point-adaptive:
- pump-speed: `g ≈ max(|current flow|/max(speed, 0.2), ratedFlow/2)`
- valve-position / governor: `g ≈ max(|current flow|/max(pos, 0.05), rated est.)`
  (valve flow is ~linear in position at fixed ΔP since K_eff ∝ 1/pos²)
- heater-power: output IS in watts; no conversion.

**Feedforward (three-element FW control):** commanded flow = measured steam
flow + PI trim on level. This sidesteps shrink/swell, the reason plain
level-PID on a boiling SG is genuinely hard to tune. We have perfect flow
measurements; use them.

**Reactor power via rods** is not a PI: rod position is already the integral
of rod velocity, and the reactor self-stabilizes through Doppler. Controller:
`dPos/dt = clamp(±rodSpeed · err/errBand)`, err = (P_set−P)/P_nom,
errBand 5 %, rodSpeed 0.01/s (real bank speeds), deadband 0.2 % to prevent
dithering. Blocked while scrammed.

### Tier 2 (fallback, later): automated identification

For pairings with no template match: automatic step/relay test on a
background copy of the state, FOPDT fit, SIMC gains. Not needed for the
preset loops; documented as the extension path for weird user builds.

## Neutronics changes

1. **`excessReactivity`** (new NeutronicsState field, default 0): built-in
   positive reactivity margin (enrichment) so criticality sits at partial rod
   insertion instead of exactly at full withdrawal — without it a rod
   controller has no authority to raise power.
   `computeTotalReactivity += excessReactivity`.
2. **Criticality initialization**: cores with `initializeCritical: true`
   start with `rodPosition = 1 − excess/worth` (ρ = 0 at the initial
   reference conditions) and precursors at equilibrium — the plant starts AT
   its operating point and the controllers only have to hold it. The same
   root-solve is later reusable as an "estimated critical position" gameplay
   feature.
3. Reactivity-coefficient derivation from core parameters stays on the todo
   list — current constant coefficients are adequate for holding steady
   state.

## Pressurizer control

- **Heaters**: new `FlowNode.heaterPower` (W, default 0), deposited as
  dEnergy by `HeatGenerationRateOperator`. Generic: any tank can have
  heaters. Actuated by a pressure controller (direct acting).
- **Spray**: no new physics needed — a spray line (valve on a connection
  from the cold leg to the pressurizer top) plus a reverse-acting pressure
  controller with a slightly higher setpoint (split-range by setpoint
  stagger: heaters hold 155 bar, spray caps ~157 bar). Injected subcooled
  water condenses steam through the existing (m,U,V) equilibrium physics.

## Steady-state detection

`SteadyStateDetector` (simulation-level, fed accepted states): tracks
normalized drift rates — per flow node |dm/dt|/m and |dT/dt|, reactor
|dP/dt|/P_nom — smoothed over a trailing window (EWMA, ~20 s). Steady when
all smoothed rates stay below thresholds (default 0.1 %/s... loose enough
for realistic plant noise) for a hold time (default 60 s). Used by:
- the harness (`assertReachesSteadyState` in regression tests),
- later: the "wait for random initiating event once steady" feature and the
  "test design before build" flow.

## Phasing

- **Phase 1**: framework (ControllerState, operator, auto-gains, actuator/
  sensor bindings), heaters, excessReactivity + critical init, factory
  translation of `controllerType: 'pid'` plant components. Steady-state
  detector.
- **Phase 2**: wire the PWR preset: rod power controller, turbine governor
  pressure controller, three-element FW, condensate/hotwell makeup, pzr
  heaters + spray. Regression test: PWR converges to ~100 % power and holds
  steady ≥ 200 s (both solver modes).
- **Phase 3** (follow-up): BWR + two-loop wiring (data-only), construction-
  mode UI for creating/editing PID controllers, tier-2 identification,
  reactivity coefficients from core geometry.

## Non-goals (this pass)

- No construction-mode UI for PID controllers (presets wire them via JSON;
  the scram controller UI pattern extends naturally later).
- No cascade/multi-loop coordination beyond feedforward.
- No control-room/operator-screen features.

## Outcome (implemented 2026-07-06, same day)

Phases 1–2 landed. The PWR preset now converges from a 5 %-power critical
start to a held operating point (regression test "Controlled PWR converges
to operating steady state and holds"): rods parked mid-stroke inside the
deadband, ρ within ±80 pcm, pressurizer at 155.0 bar with heaters
modulating, SG at 60.0 bar on the governor, levels held, primary at
~4700 kg/s. Six controllers, zero hand-tuned gains (only setpoints and
device limits in the preset JSON).

What the convergence campaign taught us (each was a real bug or physical
insight, not tuning):

1. **Rod control must be T_avg/T_cold, not raw power.** Holding coolant
   temperature automatically matches reactor power to the heat the steam
   side actually removes; holding raw power bottles the primary up against
   a closed governor until the core saturates.
2. **Rod controllers need lead (rate) compensation and a generous deadband**
   (~±1 K), and must be SLOW (≤ ~5 pcm/s): the plant's own MTC (~−34 pcm/K
   here) is the real stabilizer; fast rods integrate whole dollars per
   temperature swing and limit-cycle the plant between bursts and
   shutdowns. A withdrawal inhibit on short reactor period (real RODC
   feature) prevents reactivity accumulation at zero power.
3. **Consistent initial conditions matter more than controller tuning**:
   pumps marked running now start AT speed (a full-power core with stagnant
   coolant boils during the ramp); the initial temperature gradient must
   match the initial power; approaching full power from a low-power start
   beats starting at 100 % into an unestablished flow field.
4. **Plant-design lessons surfaced by the controllers**: connection
   `resistanceCoeff` is now honored from plant JSON (the default 5 per
   segment cost the primary loop ~30 % of rated flow); SG level setpoint
   must keep the tube bundle wetted (level-dependent HX area means a low
   level strangles UA); the pressurizer spray line must be small (a
   pipe-sized spray collapses the steam bubble and depressurizes the
   primary); pump-body pressure at saturated suction is inherently bistable
   (dome-edge hops), which the steady-state detector handles by
   volume-weighting pressure drift.
5. **Factory fix**: a pump's `connectedFlowPath` is no longer stolen by a
   second outlet connection (the spray tap silently moved the RCP's head
   onto the spray line and killed the loop).

Remaining (phase 3): BWR/two-loop wiring, construction-mode UI for PID
controllers, tier-2 identification, reactivity coefficients from core
geometry, decay heat at shutdown (power → 0 currently removes ALL heat
input; the fission-product term should keep ~7 % initially), and SG UA
review (the preset needed 12 000 tubeCount for ~3 MW/K; full-power 1000 MW
operation wants ~10× that - either bigger per-tube area or richer
convection correlations).
