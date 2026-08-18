# Moving-Boundary Once-Through Steam Generator — Design

Status: DESIGN, not yet implemented. Agreed 2026-08-14. Target branch: xe100
first (the Xe-100 OTSG is the motivating case), then generic.

## 1. Problem

The generic `heatExchanger` exchanges heat through three lumps (tube fluid ↔
tube metal ↔ shell fluid) using **bulk** node temperatures. Two structural
consequences, both observed at length while tuning the Xe-100:

1. **Bulk = outlet.** A flow-through well-mixed node sits at its outlet state
   (steady balance: h_node = h_in + Q/ṁ = h_out), so exchanger duty runs on
   outlet-vs-outlet ΔT. A counterflow temperature cross — steam leaving
   hotter than the helium leaves — is structurally impossible in one lump
   pair, because heat would have to flow from the colder bulk to the hotter
   bulk. This is why one lumped SG could not make 565 °C steam from helium
   averaging 505 °C, and why the evap+SH split was needed at all.

2. **Phase-spanning lumps.** A two-phase lump presents T_sat to the metal
   everywhere, including where subcooled feed physically ought to be
   absorbing heat. The helium consequently cannot be cooled below ~T_sat in
   the evaporator lump (the "economizer pinch"): cold leg ~350–400 °C
   instead of 260 °C, duty capped ~145 MW instead of 200.

A third consequence emerged during tuning: with a whole-lump superheater, the
plant has two mutually exclusive branches (saturated ~75 kg/s or superheated
~50 kg/s at the same duty) selected by feed delivery, and the superheated
branch sits at a razor-thin dry/wet margin that relaxation-oscillates
(refill → dry-out → blowdown, ~300 s, undamped). The branch dichotomy is an
artifact of the SH lump being wet or dry *as a whole*.

## 2. Shape of the fix

The tube side of an OTSG becomes up to three sections in series —
**subcooled / two-phase / superheated** — whose boundaries are not fixed at
construction but move so they stay pinned to the phase boundaries. Each
section is single-regime *by construction*: the regime transitions live at
the interfaces, not inside nodes. This is the standard moving-boundary OTSG
formulation from the boiler-dynamics literature, adapted to this codebase's
conventions (integrated masses/energies, derived geometry, no switching).

The branch dichotomy dissolves automatically: superheat is no longer a
whole-lump state but a section length that grows and shrinks continuously.

## 3. State variables and closure

Per moving-boundary tube side, the integrated state is three (mass, energy)
pairs:

    (m_1, U_1)  subcooled liquid
    (m_2, U_2)  two-phase mixture
    (m_3, U_3)  superheated vapor

Everything else is DERIVED, in keeping with house style:

- **Pressure** (one per tube side — acoustic equilibration along the bundle,
  the same assumption every existing node makes): solve

      Σ m_i · v_i(u_i, P) = V_tube_total

  for P by secant, reusing the existing water-property machinery. Each
  section's v_i(u_i, P) evaluates in its own regime; the sum-to-volume
  constraint is the closure. Failure to close = loud error, no fallback.

- **Section volumes / lengths / areas**: V_i = m_i·v_i, L_i = L·V_i/V_total,
  A_i = A_total·L_i/L. A section with zero mass has zero length, zero area,
  zero everything — see §6.

### 3a. What the plant actually runs (`evaluateOtsgPartition`)

The closure above is the reference form (`evaluateOtsg`, exercised by the
unit tests). The plant's form solves the partition AND the tube's pressure
together from the node's conserved totals, one integrated boundary variable,
and the wall.

**Why the pressure is solved here.** A boiler tube holds cold slug at one end
and superheated steam at the other, and both sit BELOW the saturation tie
line in (u,v) — the slug by its energy deficit, the steam because the vapour
isobar's du/dv runs at about half the tie line's slope. Blend them into one
(u,v) pair and the uniform EOS reads low-pressure two-phase mush: a partition
built at 80 bar reads back at 53. The flow solver, the relief valves and the
governor were all steering on that fiction. So the tube's pressure is the one
the partition needs to pack its sections into the tube volume — the same
volume constraint the reference closure always solved — and
`OtsgPartitionConstraintOperator` publishes it (plus any NCG partial) as the
node's `fluid.pressure` on every stage, along with the partition's
mass-weighted temperature and vapour fraction.

**The four descriptors and where each comes from.** Against the node's two
conserved totals the tube carries four unknowns; each gets its value from the
physics that actually sets it:

- the **economizer** from its integrated MASS m₁ — how much cold feed is in
  the tube is genuine dynamics (the history of feed that has not yet boiled),
  with the transit balance as its rate:

      dm₁/dt = W_in − W₁₂ − (liquid draws)

  Its ENERGY is priced at the profile mean ū₁(P), so a falling pressure
  reprices the slug colder and hands the difference to the vapour side of the
  books — which is exactly the flash a depressurized slug undergoes. (The
  energy-ledger variant could not express that: as u_f fell, the same joules
  claimed more mass than the tube held, and a blowdown walked it into a
  partition no pressure could pack.)
- the **boiling outlet quality** from the structural rule: dry steam only
  when there is somewhere to hand it; when flooded, the energy says where
  boiling stops (below zero mean quality the leftovers are simply liquid
  cooler than saturation — a cold-filled tube needs no special case).
- the **superheat mass** from the energy total.
- the **superheat energy** from the WALL: the steam's approach to its own
  metal,

      T₃ = T_sat + θ̄·(T_wall3 − T_sat),   θ̄ = hA₃ / (2·W·cp + hA₃)

  the mean-stream form of the duty calculation's own θ machinery. A stagnant
  section soaks to its metal, a strongly drawn one barely leaves saturation,
  and a cold wall pins it AT saturation — which is dryout. Steam physically
  cannot leave hotter than the metal heating it, which is the property no
  integrated vapour state could deliver (measured failure: 329-bar steam
  inside what the uniform EOS called a 160-bar node, held for hundreds of
  seconds by a drifted energy ledger).

At a given pressure everything is closed form — mass and energy split the
leftovers in every regime — so the pressure search is one safeguarded 1-D
root find on the volume residual, warm-started from the node's last published
pressure. Regime switches branch on the SIGN of a solved mass and join
continuously at the states where the descriptions coincide. When the totals
carry more energy than wall-limited steam can hold (a slug directly under
flash-heated vapour, real for a while after a depressurization), u₃ unpins
upward and Q₃ runs backwards — the physical channel that relaxes the state,
with no ledger to hold it there. When no sub-critical pressure packs the
inventory, the dome is gone: one supercritical fluid at its own uniform
(u,v), whose EOS has no tie line to be biased by.

Two things the sections are evaluated *on*, rather than the node's stored
numbers:

- **The water's own share.** `fluid.internalEnergy` includes any NCG
  (`tubeWaterState` splits them; with no gas it is the stored state), and the
  published pressure adds the gas partial back on top.
- **The draw enthalpies.** A vapour draw leaves from the superheat section's
  OUTLET (2·h̄₃ − h_g under the linear profile, fading to the mean as the
  boiling section that feeds it vanishes), a liquid draw from the subcooled
  section's mean. The cache every consumer reads (`otsg.lastEval`) is
  refreshed by the partition constraint on every state — the pressure
  solver's donor-enthalpy path included. Pricing a vapour draw at the bulk
  instead leaves the vapour's energy behind in the node (measured: 93 kg
  drawn at 1.46 MJ/kg where the superheat section held ~3), and the books
  inflate until no pressure can pack them.

**The ledger and its leash.** m₁ is watched, not trusted: the integrator
floors it at zero and ceilings it at the node's own mass; the closure caps
the claim at the inventory; and because u₃ is pinned, a drifting claim can no
longer hide in phantom steam — it shows up as the pressure and the sections
visibly disagreeing with the plant around them, which
`OtsgLedgerCheckOperator` reports (steam over every wall that persists, or a
claim swallowing the whole inventory).

## 4. Interface conditions

Interfaces sit at saturation by definition:

- 1→2 boundary: saturated liquid, crossing enthalpy h_f(P)
- 2→3 boundary: saturated vapor, crossing enthalpy h_g(P)

The interface mass fluxes W_12, W_23 are determined by the requirement that
each boundary stays at its saturation condition — the standard moving-
boundary derivation: differentiate the section balances holding the boundary
state pinned, solve for the interface velocities. In rate-operator terms the
result is explicit expressions for W_12, W_23 in terms of section duties,
feed/steam flows, and dP/dt terms. These are ordinary smooth rates fed to
RK45; no events.

External connections: feed enters section 1 at its own enthalpy; steam is
drawn from section 3 (or from section 2 at h_g when 3 is empty — the
zero-mass pass-through of §6 handles this without a case split).

## 5. Heat transfer: parallel transit + standing branches

Within each section, wall exchange uses the two-branch form (this is the
resolution of the θ-blend discussion — the two are algebraically identical,
ε·ṁc_p ≡ hA·θ(NTU), and the parallel-branch form is the physical one):

    Q_i = ε_i·(ṁc_p)_i·(T_wall,i − T_in,i)   transit branch
        + h_nat·A_i·(T_wall,i − T_bulk,i)     standing branch

- ε_i = 1 − exp(−NTU_i), NTU_i = h_i·A_i/(ṁc_p)_i. For the two-phase
  section c_p → ∞ ⇒ NTU → 0 on the water side: the wall simply sees T_sat —
  which is exact.
- The transit branch is capped at the stream's carrying capacity by
  construction (ε ≤ 1); the standing branch never turns off, so a bottled
  boiler still heats and pressurizes (the SGTR-critical case).
- No blending function exists anywhere; dominance follows from ṁc_p vs
  h_nat·A.

**Shell side** (gas): no new state. Gas residence is seconds, so treat the
shell stream as quasi-steady plug flow *for exchange purposes*: march the
gas temperature analytically through the sections in physical order
(counterflow: gas meets section 3 first), each section an exponential decay
toward its wall temperature. The shell NODE keeps its bulk state for
inventory/pressure exactly as today; only the exchange calculation uses the
marched profile. This is what finally produces true counterflow pairing —
hot gas against the superheat section, coldest gas against subcooled feed —
with zero added state.

**Tube metal**: keep ONE metal thermal node initially (integrated state must
not appear/disappear with sections). It exchanges with each section weighted
by A_i. This smears axial metal temperature; accepted for v1 and noted as a
refinement (three fixed metal sub-nodes would be smooth too, since metal
nodes never vanish).

## 6. Empty sections — the part the literature does with switches

Classical moving-boundary implementations track section *lengths* and need
explicit model-structure switching when a section vanishes (flooded SG: no
superheat section; dried-out SG: no subcooled). That switching is the
published failure mode (chatter, restarts) and violates this project's
no-special-cases rule.

Tracking **masses** instead makes death and birth asymptotic:

- m_i → 0 ⇒ A_i → 0 ⇒ Q_i → 0 and all its rates → 0 smoothly. Like burn-off
  approaching 1, the empty state is a fixed point approached, never a wall.
- Birth is continuous: the interface flux terms exist regardless; the first
  gram entering an empty section gives it a state.
- A zero-mass section passes flux through: W_in = W_out with the saturation
  enthalpy jump absorbed at the (coincident) interfaces. The middle-section-
  empty case (subcooled directly under superheated, possible under fast
  pressurization) is the same pass-through and needs a dedicated unit test.

One numerical care point: as m_i → 0 its temperature becomes ill-conditioned
(tiny heat capacity). The rates all carry A_i ∝ m_i factors, so dT_i/dt
stays bounded; the unit tests must verify this at m_i = 1e-6 kg scale, and
any residual stiffness is an integrator concern (exponential update), not a
clamp.

## 7. Scope and migration

- New tube-side model inside the existing `heatExchanger` component, opt-in:
  `tubeModel: 'moving-boundary'`. All existing plants unchanged.
- Single-phase exchangers degenerate naturally (one section holds all the
  mass) — so this subsumes the "ε-NTU overlay" idea rather than competing
  with it.
- Xe-100: replace the evap+SH pair with ONE moving-boundary OTSG (the
  original single-vessel arrangement, which is also the physically real
  one). The evap/SH split, its sizing lore, and the branch-selection pump
  trims all become obsolete.

## 7a. Several bundles in one shell

`bundleCount` puts N independent tube bundles inside a single shell. Each
bundle is a complete copy of everything above — its own flow node, its own
tube metal (three section nodes when the tube model is moving-boundary), its
own partition, its own burst boundary — and its own pair of connection
points, so a shell can feed two separate steam headers or take feedwater from
two trains. What they share is the shell fluid.

The split is a SUBDIVISION, not a resizing. `tubeCount` remains the
exchanger's total, and tube volume, flow area, heat area and metal mass are
divided evenly between the bundles, so the shell holds the same tubing
whatever the bundle count. Each bundle then sees `gasShare = 1/N` of the
shell stream: equal bundles occupy equal shares of the shell's free-flow
area, so they pass equal shares of its mass flow at the same velocity. The
gas film coefficient is therefore unchanged and only the carrying capacity
`mdot*cp` each bundle marches against is divided; the duties sum back onto
the shell node. scripts/test-hx-bundles.ts runs the same boiler as 1 bundle
and as 2 and holds them to the same trajectory.

Naming (src/simulation/hx-bundles.ts): the FIRST bundle keeps every name a
single-bundle exchanger has always had (`id-tube`, `id-tubes`, ports
`id-tube-top` …); bundles 2..N suffix `-b{n}`. That asymmetry is deliberate —
adding a bundle to an existing exchanger must not rename anything, or drawn
connections and saved plants would break.

## 8. Test plan

1. Unit: volume-closure solve round-trips (P recovered from constructed
   states); interface fluxes conserve mass/energy exactly; empty-section
   limits finite and smooth (m = 0, 1e-6, 1e-3 kg); middle-section-empty
   pass-through.
2. Analytic: steady counterflow profile vs the textbook three-region
   solution at design conditions (He 750→260, water 200→565 at 165 bar,
   200 MW) — the design point must be an equilibrium of the model within a
   few percent before it goes near the plant.
3. Plant: Xe-100 probe must reach ~200 MW / 165 bar / superheated steam and
   hold it; then LOFC and SGTR re-verified. The superheated state must be
   STABLE — the whole point is that the dry/wet relaxation oscillation
   cannot exist when superheat is a continuous section length.
4. Regression: all existing suites; PWR/BWR presets untouched (opt-in flag).

## 9. Failure honesty

No fallbacks: volume closure failing, a section state evaluating outside its
regime, or interface fluxes going non-finite all throw with full state in
the message. If the model cannot represent a condition, the simulation says
so loudly rather than continuing on a fabricated state.
