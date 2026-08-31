# Implicit energy advection ("nearly-implicit" step) — design

Branch: `worktree-implicit-energy`. Started 2026-08-31 after the material-
Courant ceiling (1f1da03) made the transport limit explicit: dt is now
honestly capped at ~0.36·m/W of the smallest transit node (cv-1-inner:
15 kg He, ~0.2 s residence), and the remaining rejection driver
(cond-pump-1:pressure) is the liquid-stiff face of the same coin. This
project removes that ceiling the way the pressure solve removed the acoustic
one.

## Problem

The semi-implicit pressure-flow solve (RELAP-class) makes PRESSURE respond
implicitly to flows, collapsing the acoustic CFL. The mass/energy actually
MOVED by those flows is still integrated explicitly by RK45 with donor
enthalpies sampled at stage times. When dt approaches a node's turnover time
m/W, donor advection degrades (a node exports enthalpy its step-start state
does not contain), so the throughput guard — and now the matching
materialCourantDt ceiling — hold dt at ~0.36·m/W. The whole plant steps at
the smallest transit node's pace: the material Courant limit.

RELAP's answer is the "nearly-implicit" scheme: solve the advective
mass/energy update implicitly against the already-solved end-of-step flows.
Donor-cell upwinding makes that linear system an M-matrix — unconditionally
stable, no ringing — and the material CFL disappears.

## What already exists (pressure-solver.ts, solveImplicit)

Per step (not per RK stage), in constraint application:
- BE momentum predictor per connection (quadratic friction, closed form),
  then the network pressure correction `(diag(c) + L(D))·δP = inflow`.
- Donor enthalpy per connection (`blendedDonorEnthalpy`, same donor
  convention as the explicit advection operator).
- β = dP/dU per node and a measured unmodeled-source vector q (last
  accepted step's total dEnergy minus this transport model at current
  flows) — zero steady-state bias by construction.
- `providesFlowMomentum` flag: the solver SKIPS the explicit momentum
  operator when the implicit solve owns the update. This is the exact
  pattern the energy step needs.

## Proposed scheme

After the flow solve produces end-of-step connection flows W_j:

1. **Implicit mass update** (already effectively what applying net flows
   does): m_i' = m_i + dt·Σ_j s_ij·W_j. Unchanged.
2. **Implicit energy update**: solve for end-of-step specific enthalpies
   h' in the donor-cell system

       m_i'·u_i' = m_i·u_i + dt·( Σ_in W·h'_donor − Σ_out W·h'_i + q_i )

   with h' ≈ u' + P·v evaluated with step-start Pv (the pressure work term
   is small over one step and P is re-derived from (m,U,V) afterward — the
   thermodynamic consistency invariant is untouched: state stays (m, U, V),
   phase stays pure (u,v)-classified). Donor side uses the RECEIVER-of-flow
   convention already in `blendedDonorEnthalpy`; drawComp (phase-separated
   draws) uses the same blend. The matrix is diagonally dominant with
   negative off-diagonals (an M-matrix): direct solve, no iteration, same
   solveLinearSystem.
3. The explicit advection rate operator gets a `providesAdvection`-style
   skip (mirror of providesFlowMomentum) so the energy is not moved twice.
   Wall heat, work terms, and all non-advective physics stay explicit in
   RK45 — this is operator splitting, advection|rest.

## The hard parts (in expected order of pain)

- **RK45 interaction.** The advective terms leave the error estimate when
  the operator is skipped, so the controller no longer sees transit error at
  all. That is the point — but the splitting error (advection at
  step-frequency vs physics at stage-frequency) must be bounded somehow.
  Plan: keep the throughput guard (raised threshold, e.g. 2 turnovers/step)
  as the splitting-error backstop, and A/B trajectory families carefully.
- **Phase changes mid-step.** A donor whose phase flips during the step
  (dryout, flashing) breaks the frozen-donor-blend assumption. The pressure
  guard already refuses steps that cross the dome on stiff nodes; the same
  edge-caution likely suffices, but this is where weird configurations will
  bite first. NO special cases without measurement.
- **OTSG nodes.** The partition closure derives everything from (m, U)
  totals, so implicit updates to totals are fine — but the m1 economizer
  ledger integrates dOtsgM1 explicitly and must stay consistent with the
  implicitly-moved mass. Check the ledger drift watch closely.
- **Boundary nodes, burst flows, choked caps.** The flow solve already
  handles caps/fixed flows; the energy solve must bill capped flows at the
  same donor enthalpies (reuse `fixedFlows` + `entries` verbatim).
- **The measured-q convention.** q currently patches the PRESSURE closure's
  blindness; with advection implicit, the transport part of q moves into
  the solve itself and q must shrink to only wall/work sources. Re-derive,
  don't reuse.

## Staging

1. `implicitEnergyAdvection` config knob, default OFF. A/B harness first.
2. Energy solve for PLAIN nodes only (no OTSG, no NCG) — helium loops are
   pure NCG, so Xe-100 needs NCG handled: mixture internal energy moves
   with the same donor convention; the mixture split already handles
   arbitrary (m_water, U, n_gas). Probably: implicit update on TOTAL U and
   per-species NCG moles, water mass as today.
3. Raise/replace materialCourantDt when the knob is on (ceiling becomes
   ~2 turnovers, from the splitting-error backstop).
4. OTSG + drawComp phase-separated draws.
5. Falsification battery: sweep hash N/A (no property changes), trajectory
   families on all presets, tankburst + sbo transients (fast blowdowns are
   where donor-implicit schemes smear), bit-exact replay suite, and the
   conservation ledgers (mass/energy books must close to machine precision
   per step — add a per-step audit while the knob is experimental).

## Expected payoff

cv-1-inner ceiling 0.07–0.2 s → gone; dt bounded next by the OTSG phase
boundary and neutronics (~0.5–1 s scale). Plausibly 2–4x on gas plants,
less on PWR (already at 30–200 ms for other reasons). The cond-pump-1
pressure guard is NOT addressed by this and stays.

## Stage-frequency splitting: concrete failure modes (Erick's question, 2026-08-31)

Pulling advection out of the stage rates means intermediate RK states are no
longer refreshed by transport, and every other operator evaluates against
them. Named consequences, in decreasing expected severity:

1. **BWR void-feedback aliasing.** Node masses stop evolving within the
   step, so density/void reactivity feedback updates at step frequency, not
   stage frequency. Void is a BWR's fastest feedback loop and already
   carries slosh noise - sampling it once per step risks aliasing an
   oscillation the stages currently resolve. BWR trajectory families move
   into the stage-2 A/B, not the final battery.
2. **Coupling-term error, O(dt).** A node whose balance is
   advection-dominated (condenser, heaters, transit ducts) drifts under its
   non-advective physics alone during the step - wall heat keeps pulling
   with nothing replenishing - so heat-transfer rates are evaluated at a
   slightly wrong dT. Largest exactly where advection dominates; partially
   self-limiting because those nodes tend to have weak other-physics.
3. **Steady-state bias, O(dt).** The implicit update restores each node once
   per step, so its time-AVERAGE state sits ~half a step of non-advective
   drift away from the true steady value, and every flux computed from it
   inherits the bias. This is the same disease the pressure closure's
   measured-q term cures in its own domain; the plain split has no
   equivalent corrector.
4. All of it is invisible to the embedded error estimate - bounded by the
   raised throughput guard, not controlled.

Why proceed anyway: flows already crossed this bridge (implicit momentum
froze them through the stages) and trajectory families survived; moving the
transported mass/energy to the SAME frequency as the flows that carry it
restores a consistency the current half-split lacks.

**Mitigation B (build only if stage-2 A/B demands it):** feed the stages a
frozen transport tendency - the last implicit solve's per-node advective
rates, constant across stages - so intermediate states drift realistically;
the implicit solve then computes the CORRECTION against what the stages
already integrated. Kills failure modes 1-3; costs exact-conservation
bookkeeping (the correction must subtract the integrated estimate to the
last joule). Predictor-corrector, standard shape, easy to get subtly wrong -
measure first.

## Stage-2 findings (first implementation, 2026-08-31)

Implemented: stamp-early/apply-late partition (`stampImplicitAdvection` /
`applyImplicitAdvection` in pressure-solver.ts), one-LU multi-RHS transport
solve (species as kg/kg concentrations, energy as bulk enthalpy
hB' = (U'+PV)/M', water as the exact remainder - concentrations sum to one
by construction so the books close to machine precision), q-history merge,
guard/ceiling exemptions, IMPLICIT_ADVECTION env knob. Default-off verified
bit-neutral (identical step signature).

1. **Advection-FIRST splitting fails.** Applying the step's transport before
   the stages feeds it to the physics as an initial jolt: rk45-error and
   pressure-sanity rejections on the liberated nodes, trajectory bent 10%
   (184 vs 204 MW at t=60). Physics-then-advection fixed all of it
   (power back in family, flow-physics suite green with the knob on).
2. **The pressure guard is the next wall, at nearly the same dt.** With
   throughput exempted, the controller pushes dt up and
   cv-1-inner:pressure + cond-pump-1:pressure reject instead - the implicit
   momentum solve's own trust region (flows solved against step-start
   pressures). Xe-100 net: 1.18x at 60 s, 0.7x at 300 s vs the
   Courant-ceiling baseline - the ceiling's smooth limit beat implicit
   advection's discover-by-rejection at the pressure guard. Relaxing the
   Courant ceiling by 8x for stamped connections changed NOTHING
   (bit-identical run) - the ceiling was never the active constraint in ON
   mode.
3. **RESOLVED - the ON trajectory DIVERGES.** The 600 s OFF reference holds
   133.8 MW (the established family: every reference run since the turbine
   IC fix sits at 134-141 MW from t=300 on). ON's 208 MW at t=300 is not
   faster settling - it is a different operating point, ~50% off. The
   plausible mechanism is failure mode 3 amplified by control feedback:
   the O(dt) time-average state bias on advection-dominated nodes is
   sensed by the plant's controllers (rod/valve loops respond to drifted
   temperatures), and the closed loop turns a small per-step bias into a
   different equilibrium. **Mitigation B (frozen transport tendency
   through the stages, implicit solve as corrector) is REQUIRED, not
   optional.** Do not trust any ON-mode trajectory until it lands.

Next lever is NOT more advection work: it is the pressure guard's
step-frequency rejection cycle - either a predictive trust-region dt
ceiling (the materialCourantDt trick applied to the pressure swing), or an
outer iteration of the flow solve at the post-transport state (re-solve
once when the swing exceeds tolerance - a second LU, cheap next to a
rejected six-stage attempt).
