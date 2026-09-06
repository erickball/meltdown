# Plan: Fully Semi-Implicit Pressure–Flow Solver (RELAP-style)

*Drafted 2026-07-06. Status: **IMPLEMENTED** (2026-07-06) — all phases landed,
implicit momentum is the default. See "Outcome" at the end of this document.*

## Why

The simulation is currently limited to dt ≈ 5–15 ms on the reactor presets by one
thing: marginally-damped acoustic modes of liquid loops (e.g. mass sloshing
between the RPV downcomer and core barrel through the 7.5 m² internal opening,
ω ≈ 30 rad/s, friction Q ≈ 100+). Explicit RK45 must resolve these modes or they
amplify; four independent experiments confirmed no cheaper escape exists:

1. Slaving high-A/L connections to algebraic equilibrium flow — amplifies
   pressure noise ~10⁵× through the sqrt(ΔP) sensitivity. Dead on arrival.
2. De-weighting momentum in the RK45 error norm — the mode grows until its
   *mass* consequences reject steps; 2× more rejections, half the speed.
3. Loosening relTol — same mechanism, monotonically worse (1e-2 → 64% slower).
4. Tightening relTol — helps (new default 2e-4), but only by keeping the mode
   small; the resolution floor remains.

The existing `PressureSolver` is implicit in only **half** the acoustic loop
(flows → mass → pressure); the momentum leg (pressure → flows) is still
integrated explicitly, so the mode survives with damping only ~(ω·dt)². The fix
with no valley: make the **whole pressure–flow pair** implicit, RELAP-style.
Backward Euler on the coupled pair has |amplification| < 1 at every dt, so the
acoustic modes are unconditionally damped and dt becomes limited only by the
physics the user cares about (thermal, neutronic, phase-change timescales).

Expected payoff: dt limited by ~50–200 ms scales instead of 5–15 ms → roughly
5–20× realtime on the presets, better scaling for large plants (the linear
solve is O(n³) with tiny n, while each avoided step saves a full water-property
sweep).

## Target formulation

One linear solve per accepted step (and per RK stage for the remaining explicit
physics to see consistent flows). Unknowns: node pressure corrections δP and
end-of-step connection flows ṁ¹.

Momentum (per connection j between nodes a, b), backward Euler with friction
and pump-curve slope linearized at ṁ⁰:

    ṁ¹ = ṁ⁰ + dt·(A/ρL)·[ ΔP⁰_driving + (δP_a − δP_b) − R'·(ṁ¹ − ṁ⁰) ]

    R' = ∂(friction + pump-curve losses)/∂ṁ  ≥ 0

Mass/pressure closure (per node i), same compliance as the current solver:

    Σ_j ±ṁ¹_j = c_i·δP_i,     c_i = ρ_i V_i / (K_i dt)

Substituting the momentum rows into the mass rows gives the same SPD
(compliance + weighted-Laplacian) system the current `PressureSolver` already
builds — the difference is that the right-hand side includes the full explicit
driving pressures ΔP⁰ (hydrostatic connection heads, gravity, pump curve), and
the resulting ṁ¹ **replaces** the RK45 momentum integration instead of
correcting it. `FlowMomentumRateOperator` stops producing dṁ/dt (or produces it
only for connections the implicit solve doesn't own — see open questions).

Energy and mass *transport* still advect explicitly through RK45 using ṁ¹, so
thermal accuracy keeps 5th-order treatment. Pressure stays algebraic from
(m, U, V) via the steam tables — the δP are still virtual, exactly as today.

## What must move into (or wrap around) the linear solve

These all live in `FlowMomentumRateOperator` today and are the risk surface —
the regression suite in `scripts/test-flow-physics.ts` pins each one:

| Feature | Implicit treatment | Test |
|---|---|---|
| Choked flow | Cap ṁ¹ at ṁ_choked after the solve; when capped, zero the connection's conductance in the mass rows (flow no longer responds to δP) and re-solve or iterate once | `choked ceiling`, `choked insensitivity` |
| Closed valves | Conductance = 0 AND ṁ¹ decays to 0 (already handled in current solver) | `closed valve holds` |
| Valve throttling | K_eff/position² enters R' (already in current conductance) | `valve opening transient` |
| Check valves | Closed ⇒ conductance 0; opening decision from ΔP⁰ + δP, one-way | `check valve blocks/passes` |
| Pump curve | Head at ṁ⁰ in ΔP⁰; curve slope in R' (already in current damping) | `pump operating point`, `pump deadhead` |
| Pump reverse block | Large R' for reverse flow through running pumps (already present) | `pump deadhead` |
| Governor valve | Same as valve throttling | (covered by valve tests) |
| Phase-dependent flow density | ρ_flow by connection elevation vs liquid level — evaluate at ṁ⁰, keep explicit | `level equalization` |
| Two-phase/NCG nodes | Compliance already phase-aware; no change | `level equalization`, conservation checks |
| Small-dt fidelity | Implicit damping must vanish as dt → 0 so water hammer remains observable when the user caps dt | `acoustic ring at small dt` |

## Phasing

**Phase 0 — Regression baseline (done with this commit).**
Two suites, both must stay green through every later phase:
- `scripts/test-flow-physics.ts` (in `npm test`): 10 focused rig tests for
  choking, valves, check valves, pump curve equilibrium, deadhead,
  conservation, level equalization, and small-dt acoustic fidelity.
- `scripts/test-plant-scenarios.ts` (`npm run test:plants`, or `test:all`):
  structurally diverse whole plants under `scripts/test-plants/` so the solver
  is never tuned to just the shipping presets - a two-loop PWR (parallel
  primary loops, merged steam lines, split feed), a pump-free natural-
  circulation condensing loop, an accumulator/check-valve safety injection
  with mid-run valve actuation, and a deliberately awkward "kitchen sink"
  (parallel return paths, pipe component, dead leg, half-open valve, NCG
  building). Run `test:all` before landing each phase; the two-loop plant is
  also the current worst-case performance benchmark (~0.06x realtime - a
  direct measure of what the implicit solver should improve).

**Phase 1 — Implicit momentum inside PressureSolver, opt-in.**
Extend `PressureSolver.solve()` to optionally perform the full BE momentum
update (add ΔP⁰_driving terms to the RHS; set flows to ṁ¹). Flag on
`RK45Config` (e.g. `implicitMomentum: true`), default OFF. Duplicate of the
driving-pressure computation must be shared with `FlowMomentumRateOperator`
(extract a `connectionDrivingPressure()` helper — one model, two callers).

**Phase 2 — Retire explicit momentum when implicit owns a connection.**
When `implicitMomentum` is on, `FlowMomentumRateOperator` returns zero rates
for connections the solve owns (initially: all of them), and the momentum terms
drop out of the RK45 error norm for those connections. Choked-flow capping
moves into the solve per the table above.

**Phase 3 — Validation & tuning.**
- Full regression suite + presets (PWR/BWR/tankburst) + a large synthetic plant
  (30–50 nodes) for scaling.
- Compare transients against the explicit solver at small dt (which remains
  the ground truth): SCRAM, turbine trip, LOCA, valve slam.
- Sweep maxDt to find the new practical ceiling; re-tune relTol if the error
  landscape changed.

**Phase 4 — Flip the default; keep explicit path selectable.**
UI toggle next to the existing pressure-solver checkbox (tooltip explaining
the accuracy trade). The explicit path stays for water-hammer studies and as
the reference implementation.

## Open questions (decide during Phase 1)

1. Should vapor-vapor connections stay explicit? Their acoustic modes are slow
   (soft compliance) and choking logic is cleaner explicitly. The conductance
   formulation makes implicit-ownership continuous, but ownership for the
   *momentum replacement* is binary per connection — probably: implicit owns
   everything, and choking is a post-solve cap.
2. Iterate the solve when caps/check-valve states change (RELAP does 1–2 outer
   iterations)? Start with one re-solve after applying caps; measure.
3. Does the surge-line/pressurizer coupling stay well-behaved when the primary
   loop is fully implicit? (Watch the PWR preset's pzr level/pressure during
   Phase 3 transients.)
4. Energy consistency: implicit flows are end-of-step values while advection
   uses them over the whole step — first-order splitting error, same class as
   today's correction. Verify conservation tests stay at current tolerances.

## Non-goals

- No change to phase determination or the (u,v) steam-table architecture.
- No implicit treatment of energy or neutronics (they are not stiff here).
- No per-node hard switches — ownership rules must be continuous or per-
  connection structural (a connection is owned or not), never state-threshold
  driven.

## Outcome (implemented 2026-07-06)

All four phases landed in one pass. The final architecture differs from the
sketch above in three ways that came out of Phase 3 debugging, all
improvements:

1. **One solve per step attempt, not per RK stage.** The BE momentum solve
   runs once in `RK45Solver.step()` (on a clone, since attempts can be
   rejected) and the end-of-step flows ṁ¹ are frozen through all seven DOPRI5
   stages. Per-stage re-solves gave each stage slightly different flows, and
   the 5th-order combination of those deposited stage-averaged mass matching
   NO balance — a ppm-scale error that stiff liquid nodes amplify into
   bar-scale pressure flicker. With frozen flows the advected mass exactly
   equals the solve's mass-balance closure (and 6 of 7 linear solves are
   saved).

2. **Quadratic backward-Euler predictor, not linearized friction.** Friction
   linearized at ṁ⁰ is catastrophically wrong for large per-step flow changes
   (zero friction at zero flow ⇒ multi-x overshoot of the friction
   equilibrium ⇒ slosh divergence in small nodes). The BE predictor solves
   the full quadratic resistance (pipe friction + pump-curve falloff) in
   closed form: ṁ* = sign(b)·(√(1+4·G0·C·|b|)−1)/(2·G0·C), b = ṁ⁰+G0·ΔP_nf,
   G0 = dt·A/L. Bounded by the friction equilibrium as dt→∞, exactly explicit
   Euler as dt→0. The δP conductance is then linearized at ṁ* (not ṁ⁰).
   Note the momentum conductance is G0 = dt·A/L — in mass-flow form the
   density cancels (dṁ/dt = (A/L)·ΔP). The legacy correction-only path keeps
   its historical dt·A/(ρL) scaling untouched.

3. **Secant compliance for dome-edge crossings.** The compliance c_i uses the
   blended bulk modulus, which understates true liquid stiffness by ~10³ for
   nodes at the saturation boundary (a hotwell pump body full of saturated
   condensate lives there permanently). After the first solve, any node whose
   predicted inflow c_i·δP_i·dt carries it onto/across the liquid edge gets
   its compliance replaced by the secant of the true EOS response over the
   step, and the system is re-solved once (shared with the choked-flow cap
   re-solve). This is a Newton iteration on the real nonlinearity — no tuning
   constants — and it removed ~90 % of step rejections on the reactor presets.

   *Addendum (2026-09-06): the "already liquid" case is no longer gated on
   predicted net inflow.* The correction originally ran only for nodes whose
   first-solve prediction c_i·δP_i·dt was positive. That gate was load-bearing
   in the wrong direction: a liquid node just inside the blend zone (the
   Xe-100 condensate pump body — 4.5 m³ at 40 kPa, 0.02 mL/kg on the liquid
   side of v_f, 80 kg/s through it) is priced ~500× too soft, and on that
   soft row the energy-coupled closure can predict net *outflow* while the
   momentum rows deliver net inflow. The gate then skipped the correction on
   exactly the steps that needed it; the solve admitted ~0.3 kg the liquid
   could not hold, the EOS answered with +150–260 kPa, and the pressure guard
   rejected the step — 97 % of all Xe-100 rejections, every one starting from
   a node with mEdge < 0. On the liquid side, stiffness is a property of the
   state, not of the flow direction, so the K_liq secant now applies whichever
   way the predicted flow points (the crossing case is unchanged). Measured:
   Xe-100 rejections 764 → 83 per 60 s and 1.65× wall speed; BWR 1799 → 349
   per 120 s and 5.25× → 6.86×; PWR and tankburst step-for-step identical.
   The pump body now sits at its hydrostatic 40 kPa with zero two-phase steps
   where it previously flashed to P_sat and slammed back every ~0.6 s. The
   tempting alternative — measuring the guard's tolerance against the adjacent
   pump head — was tried first and rejected: it removed the same rejections
   but left the node two-phase 57 % of the time with 2.7 bar spikes, i.e. it
   accepted the cavitation instead of curing the solve that caused it.

Other notes:
- Shared hydraulics model lives in `operators/connection-hydraulics.ts` (one
  model, two callers: `FlowMomentumRateOperator` and `PressureSolver`).
- Pump head density now always comes from the pump's own node (the from-node
  of its outlet connection), not the flow-direction upstream node. For forward
  flow these are identical; for momentary reverse leaks the old rule evaluated
  a liquid-filled pump's head with the downstream node's *vapor* density
  (~0.25 bar instead of ~12 bar), which could latch a condensate train into a
  permanently stalled reverse-leak state under the implicit solve.
- `checkStateSanity`'s flow-change check is skipped under implicit momentum
  (BE legitimately jumps flows to equilibrium in one step); the pressure-change
  check REMAINS active in both modes — it is what forces dt down to resolve
  genuine dome-edge crossings the linearized solve cannot represent.
- Open question 1 resolved: implicit owns ALL connections; choking is a
  post-solve cap with fixed-flow re-solve. Open question 2: one re-solve
  suffices (shared by caps and secant compliance). Open question 3: PWR
  pressurizer coupling verified against the explicit reference (end states
  agree to ~0.1–1 %). Open question 4: conservation suites all green; the
  frozen-flow structure makes advected mass exactly consistent.

Measured on the regression scenarios (20 s sim, 0.1 s ticks, same machine):

| Scenario | Explicit | Implicit | Speedup |
|---|---|---|---|
| PWR preset | 0.82x realtime | 28–31x | ~35x |
| BWR preset | ~1.1x | 19–28x | ~20x |
| Two-loop PWR (worst case) | 0.17x | 16–18x | ~100x |
| Tank burst (LOCA) | 2.8x | 20x | ~7x |

End-state accuracy vs the explicit reference on the PWR startup transient
(t = 20 s): all node pressures/temperatures/masses within ~0.1–1 %. The
tankburst LOCA fires in both modes (burst differential 23.7 bar explicit vs
24.4 bar implicit — threshold overshoot from the larger accepted step).
relTol no longer affects step counts in implicit mode (dt is limited by the
mass-movement and pressure sanity guards, i.e. by transport accuracy), so the
2e-4 default stays.

Both test harnesses accept `IMPLICIT_MOMENTUM=1|0` to force either scheme;
the UI exposes an "Implicit flow momentum" checkbox next to the pressure
solver toggle. The explicit momentum path remains the reference
implementation and must stay green in CI (`IMPLICIT_MOMENTUM=0`).

### Pre-existing bugs exposed by long-horizon validation

Running the PWR preset to 200 s (impossible before — explicit took ~4 min of
wall time and both modes crashed identically at t ≈ 183 s) surfaced two
neutronics bugs unrelated to the flow solver, now fixed:

1. **Reactor power was never deposited into the fuel.**
   `HeatGenerationRateOperator` gated the neutronics branch on
   `node.heatGeneration > 0`, but factory-built cores create the fuel node
   with `heatGeneration: 0 // Set by neutronics` (the code that set it was
   lost in a commented-out refactor). Consequence: the core heated nothing,
   fuel temperature simply relaxed to coolant temperature, and there was NO
   Doppler feedback at all — an uncontrolled cooldown eventually re-inserted
   enough reactivity to go prompt-supercritical with nothing to quench it
   (power reached 1e276 MW and overflowed to NaN). The operator now deposits
   `neutronics.power` into the linked fuel node unconditionally (exact
   `fuelNodeId` match preferred; `includes('fuel')` fallback only when no
   linkage exists).

2. **Point-kinetics matrix exponential overflowed for prompt-supercritical
   cores.** The analytic solution used a fixed 100 ms secant window;
   exp(λ₁·0.1) overflows double precision for λ₁ ≳ 7000/s. The positive
   exponent is now capped at 3 (window 3/λ₁), keeping the secant slope within
   ~7x of the true tangent so RK45 resolves excursions like explicit dynamics
   and Doppler quenches them physically. Negative (prompt-decay) eigenvalues
   are untouched, so normal-operation behavior is identical.

Hardening added alongside: non-finite RK45 error estimates are named
(`findNonFiniteRate`), rejected (never force-accepted at min-dt), counted in
`RK45Solver.rejectionStats`, shrink dt deterministically instead of poisoning
it (NaN dt froze the old controller), and trip the stuck-detector with a
loud error if persistent. `checkPreConstraintSanity` also rejects non-finite
neutronics state.

## Addendum: energy-coupled closure (2026-07-13)

The "no implicit treatment of energy" non-goal above was half-right: energy
is not stiff for the *momentum* modes this plan targeted, but the mass-only
compliance left the closure blind to nodes whose pressure is a function of
temperature riding on a tiny inventory (post-dryout two-phase remnants and
gas spaces, P ≈ P_sat(T) on kilograms of fluid). There each accepted step's
own enthalpy transport swings T, P answers exponentially, and the flows flip
sign every step at ANY dt — a discrete relaxation oscillation, not a
resolved mode (slosh-probe diagnostic, commit b223e92). The fix is the
energy leg of RELAP's semi-implicit scheme (`energyCompliance`, default on,
`ENERGY_COMPLIANCE=0` to A/B):

1. **Donor-side enthalpy anomaly.** A flow leaving a node perturbs its
   pressure by `(dP/dm + (h_drawn − h_node)·dP/dU)·ṁ·dt`, folded into the
   c-normalized system as a weight `φ = 1 + (h_drawn − h_node)·β·c·dt` on
   the donor row (β = ∂P/∂U at constant m,V, per-regime: ideal gas
   P/(T·C_th); two-phase Clausius-Clapeyron with the constant-volume
   evaporation buffer and NCG partial pressure; blended across the dome
   edge like the bulk modulus). Pure liquid takes β = 0: its weight
   correction would be O(0.1%) while β_liq in Pa/J is huge, so the stale
   source term (point 3) turns into bar-scale RHS jitter on the small
   feedwater-train nodes — measured 4.7x → 2.8x realtime on the BWR preset
   with the liquid branch enabled, 6.0x with it excluded.

2. **Equilibrated arrival.** Arriving flows are billed at the RECEIVER's
   bulk enthalpy (weight 1). Weighting them at donor enthalpy (the "obvious"
   symmetric scheme) predicts tangent-EOS condensation collapse for cold
   water entering a hot steam space and feeds it back as more inflow — an
   artificial implosion channel that measurably held water in a degrading
   core against the explicit-reference trajectory (cb-1 held 30+ kg where
   the reference dries to ~6 kg by t≈27 s in melt-test).

3. **Measured heat-source term.** Everything the transport model cannot see
   (wall/fuel heat, work, arrival excess) enters the RHS as
   `c·β·q·dt`, with `q = (last accepted step's total dU/dt) − (model
   transport at current flows)`. Because q is the measured remainder of the
   SAME model the weights encode, the closure reproduces reality exactly
   whenever flows are unchanged: zero steady-state bias for every node type
   by construction. Without q, a heated node reads as steadily
   depressurizing (its through-flow exports the wall heat as enthalpy) and
   the solved loop flow biases low — the controlled-PWR plant test failed at
   2911 kg/s against its >3000 kg/s assertion until q landed.

Validation: slosh probe (melt-test t=188–189.5) goes from ±25 kg/s flows
flipping sign on 86% of accepted steps at avg dt 17.5 ms to ~±1 kg/s at the
50 ms tick cap; melt-test early trajectory matches the explicit reference
family (monotone core dryout); all plant-scenario, flow-physics, and unit
suites green in both ENERGY_COMPLIANCE and IMPLICIT_MOMENTUM A/B states.


## Addendum: the "acoustic ceiling" that was a closure bug (2026-09-06)

Lengthening the Xe-100 hot duct (correct geometry, parked on
`worktree-cv-inner-length`) lifted the cv-1-inner material-Courant ceiling
from ~36 to ~63 ms, and the plant promptly surged: primary flows 0–160 kg/s,
circulator stalling, ±3 bar between adjacent nodes. The first reading was
that the loop's Helmholtz mode (probe spectrum: ~15 Hz, cold-leg side
sloshing through the core) needed ~3 explicit steps per period and a
"declared acoustic-resolution ceiling" analogous to `materialCourantDt`.
That reading was wrong, and the ceiling was never built:

1. **The surge was period-2 at any dt above ~45 ms**, i.e. an inconsistent
   closure, not an under-resolved wave. `scripts/probe-loop-mode.ts`
   printed the solve's predicted δP against the realized ΔP per node: every
   gas node came in ~28% low, the ratio of helium's γ (5/3) to the fixed
   steam γ = 1.3 in `getEffectiveBulkModulus`. The energy slope β beside it
   already used the real mixture heat capacity, so one closure held two
   opinions about the gas. Now `K = P·(1 + P·V/(T·C_th))`, the isentropic
   modulus of the actual steam+NCG mixture from the same C_th. With it the
   same run is dead steady at 50 ms and predicted/realized agree to the kPa.
   A consistent backward-Euler closure damps every acoustic mode at every
   dt; there is nothing to resolve.

2. **Check valves seat on end-of-step quantities.** The next thing the
   per-step probe showed was ±3–6 bar and ±15 kg/s every step on the Xe-100
   feedwater train at every dt, predicted exactly by the solve: the check
   valve was held shut on the start-of-step driving pressure with its flow
   decaying at τ = 0.1 s (56 kg/s "through a closed valve"), and against a
   stiff liquid node that is a limit cycle. Check valves are now solved
   connections: cracking pressure as a forward preload on the momentum
   predictor, seated (flow zero, conductance dropped) when the predictor's
   momentum cannot stay forward, and an open valve whose solved flow comes
   out reversed is seated with one re-solve (the choke-cap outer
   iteration). A finite "reverse resistance" instead of seating leaked
   ~6 kg/s backwards under the PWR feed line's 42 bar reverse head.

3. **Closure-consistency error** (`PressureSolver.measureClosureError`,
   `RK45Solver.closureErrorNorm`). What a consistent solve still cannot see:
   nothing in the RK45 error estimate looks at the once-per-step solve
   (momentum has no rates in implicit mode, balanced throughput cancels).
   With `r = ΔP_realized − δP_predicted`, the flows that would actually
   have moved are the network's linear response `M·δq = c∘r` (one
   elimination of the stored matrix), and the per-node inventory error
   `c·(r − δq)·dt` relative to inventory has the form of the RK45 norm's
   mass term, so it can join step control at relTol with no tolerance of
   its own. The raw `c·r` mismatch is not usable — it over-charges nodes
   whose pressure the mass compliance does not own (OTSG partitions,
   sliver valve nodes) at 100× relTol. Measured: catches the fixed-γ bug at
   60× relTol; silent on the PWR (100× below) and BWR (20× below) at steady
   state; on the Xe-100 it is fed by a real gap the solve cannot close yet —
   the OTSG tube pressure drops ~1.5 bar in the step after each
   feedwater-controller scan, which the compliance model does not predict,
   and the response on the sliver steam nodes off the tube (val-msv-1,
   val-leak-1) is ~1% of their inventory per step. Resolving that honestly
   costs 6.4× → 1.9× realtime, so control ships **off**
   (`closureErrorControl`, `CLOSURE_ERROR=1` in the harnesses); the error is
   always computed and reported. Flip it on once the OTSG's response to feed
   changes is in the closure.

Paired 60 s (master → this): Xe-100 as shipped 1879/83 rejections/4.41× →
1804/3/4.51× (the 33 ms Courant ceiling still binds); long duct
1638/221/3.95× → 1207/3/5.55×; PWR 8783/81/3.32× → 8790/84/3.29×; BWR
4904/349/7.95× → 4797/286/8.71×. Next ceiling on the Xe-100 is
cv-1-inner's material Courant limit (~63 ms with the long duct), then
neutronics' declared 120 ms.
