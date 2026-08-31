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
