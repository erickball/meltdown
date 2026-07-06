# Plan: Fully Semi-Implicit Pressure–Flow Solver (RELAP-style)

*Drafted 2026-07-06. Status: planning — not started.*

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
`scripts/test-flow-physics.ts`: 9 scenario tests asserting today's correct
behavior for choking, valves, check valves, pump curve equilibrium, deadhead,
conservation, level equalization, and small-dt acoustic fidelity. Wired into
`npm test`. Any Phase 1+ change must keep these green.

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
