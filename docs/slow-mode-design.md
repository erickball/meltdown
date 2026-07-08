# Slow mode: day-scale severe-accident simulation

STATUS: design for discussion (2026-07-08). Nothing implemented except the
relief-valve lift counter (`ValveState.liftCount`), which the averaged model
below requires and real cycling already increments.

## Problem

Slow boil-off, MCCI, and long-term containment pressurization play out over
days, but the model always contains fast modes (liquid-node acoustics,
momentum ringing, relief-valve pops) whose stability limits cap dt at tens of
milliseconds even when the plant is doing nothing interesting. At ~1x
realtime a 3-day transient is a 3-day run.

Forcing a minimum dt does not work: the fast modes don't disappear when
quiescent, and an explicit integrator stepping past their stability limit
amplifies them (empirically confirmed twice on this codebase - the momentum
error de-weighting attempts and the 2026-07-07 quiet-node guard relaxation,
which ended in negative masses at dt=0.2 s). Any big-dt scheme must either
treat the fast physics implicitly or stop integrating it.

## Two mechanisms, complementary

### 1. Averaged relief-valve cycling (small, buildable now)

Late-phase boil-off is dominated by relief-valve sawtooths: dt recovers
nicely between lifts, then every pop crashes it to milliseconds, every few
minutes, forever. When conditions are quasi-constant the cycle average is
analytic: the valve passes exactly the steam the heat source generates
(Q/h_fg) at the setpoint pressure.

- ENTER averaged mode for a valve after N (~5) consecutive cycles whose
  period and per-cycle discharged mass agree within ~10%. Record
  `massPerLift` and period from those observed cycles.
- IN averaged mode the valve becomes a throttling regulator holding the
  setpoint exactly (reuse the relief machinery with a continuous position
  instead of the pop/reseat latch). The sawtooth disappears; dt is then
  limited by the slow physics only.
- LIFT ACCOUNTING (requirement from Erick - every lift is a chance to stick
  open): `liftCount += reliefMassFlow * dt / massPerLift`, i.e. the counter
  keeps increasing at the equivalent-cycle rate, fractionally. A future
  stick-open failure model draws against the same counter in both modes.
- EXIT on any of: sensed pressure leaving the [reseat, setpoint+margin]
  band, relief flow demand outside the range observed during entry (+/-50%),
  upstream phase change, manual/controlMode intervention. Exit restores the
  latch model with the current pressure state; nothing to rewind.

Expected win: 5-10x on late-phase SBO/boil-off. Risks: mode boundary
chatter (hysteresis on entry/exit counts is device-like and acceptable);
misrepresenting compound oscillations (entry requires the observed cycles to
MATCH, which compound behavior fails).

### 2. Periodicity-detected envelope jumping (the main event)

Erick's framing: if the plant keeps returning to almost the same state,
integrate several periods at once, then drop back to normal integration and
check that everything still behaves the same. This is envelope-following
(standard in RF circuit simulation): detect a periodic steady state,
extrapolate the slow drift of the cycle-averaged state, verify, repeat.

Sketch:

1. FINGERPRINT: a plant-significance-weighted state vector (the
   SteadyStateDetector's normalization work reused: per-node mass/energy
   with the 1e-4-of-total-inventory floor, wall/fuel temperatures, valve
   latches, decay-pool total). Maintain a rolling buffer.
2. PERIOD DETECTION: recurrence - the fingerprint returns within tolerance
   of a previous sample. Candidate period T; confirm over >=3 consecutive
   cycles with consistent T and consistent PER-CYCLE DELTAS of the slow
   quantities (inventories, wall temps, pool energies drift a little every
   cycle - that drift is the envelope derivative).
3. JUMP: apply K cycles' worth of deltas in one step to the slow states;
   fast states (flows, pressures) resume from the recorded cycle phase.
   K adapts upward on successful verification (start small, double).
4. VERIFY: integrate one full cycle normally. If period and deltas match
   the pre-jump measurement within tolerance, jump again with larger K;
   else discard nothing (the verify cycle is real integration), fall back
   to normal mode, re-arm detection.
5. EVENT-CROSSING PREDICTION (bounding the "find out a little late"
   window): the per-cycle deltas price every linear threshold in advance -
   cycles-to-SG-dryout = inventory / delta_inventory_per_cycle, cycles to a
   creep-damage milestone, to a flammability crossing, to CST exhaustion.
   Cap K below the nearest predicted crossing so thresholds are approached
   in normal mode, not discovered late. Unpredicted nonlinear events are
   caught one verify-cycle late at worst, which is the accepted cost.

Notes and open questions for discussion:
- Quiescence (no oscillation at all) is the degenerate case: period
  detection fails but drift rates are directly measurable; jump on rates
  instead of cycle deltas. Same machinery, T -> window length.
- Interaction with mechanism 1: averaged relief REMOVES the dominant cycle,
  possibly leaving the plant quiescent enough for rate-based jumping -
  the two compose (average the valve, then jump the quiet envelope).
- What the jump must NOT skip: stochastic-failure draws (valve stick-open
  per lift - draw once per jumped-cycle batch using the fractional lift
  count), controller integrators (velocity-form PI carries no integrator
  state - clean), creep damage (linear in the deltas - jumps fine),
  oxidation (Arrhenius in T - fine while T's cycle envelope is captured).
- Determinism: jumps must be a pure function of the recorded cycles so
  seeded runs stay reproducible.
- UI: time acceleration display; an event log entry when entering/leaving
  jump mode so the user understands the fast-forward.

## Suggested order

1. (done) lift counter.
2. Averaged relief cycling, validated on the extended-SBO scenario
   (compare against a fully-resolved reference run for lift count,
   inventory, and pressure trajectories).
3. Rate-based (quiescent) jumping with event-crossing prediction.
4. Full periodic envelope jumping.
