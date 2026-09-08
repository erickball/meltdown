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

**The economizer's INLET enthalpy is geometry, not flow.** The slug's energy
is priced at the profile mean (u_in + u_f(P))/2, so `u_in` multiplies the
whole ledger: on a blacked-out Xe-100 bundle a 73 kg slug and 31 kg of
leftovers means a 1 kJ/kg move in `u_in` is 2.3 kJ/kg on the steam that sets
the pressure. `classifyOtsgFlows` therefore takes `u_in` from the water
STANDING at the tube's lowest connections - its feed nozzle - weighted by how
subcooled each is, with no flow rate in the expression. It used to read
`WFeed > 0 ? donor-weighted mean : h_f(473 K)`, and the instant a feed pump
coasted to zero the inlet stepped to that hard-coded 200 C: measured 1136 ->
840 kJ/kg in one step, repricing the slug by 11 MJ and moving the published
pressure 81 -> 99 bar. That single input step was 79% of a station
blackout's solver rejections (1527 of 1933 in 180 s), and no timestep could
shrink it, because the jump was in an argument rather than in a rate. With
one feed line the new expression is exactly the value the flow-weighted mean
gave; with nothing subcooled at the inlet the weights vanish together with
(h_f - h_in), so it tends to h_f and the economizer degenerates to zero
subcooling continuously.

**KNOWN OPEN: the volume residual can fold.** The boundary move
(`reconcileSlugMass`) is evaluated at the walk's TRIAL pressure, which closes
a positive feedback loop inside the root find: a higher trial pressure leaves
more of the tube subcooled, the bigger slug takes mass at the cold profile
mean and leaves the enthalpy behind, the leftovers get hotter and need MORE
volume. Near the critical point that beats the compression term about 6 to 1.
Measured on one blackout state (330 kg, 508 MJ, 1.19 m3, ledger 279 kg): R(P)
runs UPHILL from 158 to 188 bar and has three roots - 153, 179 and 189 bar -
and which one is published depends on the warm start, so the pressure is
hysteretic. It shows up on ~0.7% of tube-ticks of that run
(`scripts/probe-otsg-roots.ts` counts them; `scripts/probe-otsg-resid.ts`
dumps R(P)). Freezing the move against the pressure the node last published
does make R monotone - verified over 140-198 bar - but it converts the fold
into an explicit one-publication lag around the same >1 loop gain, and the
circulator-trip case then diverges at t=71 s. The real cure is the
cancellation underneath it: the leftovers are (totals - slug), and when the
slug is 90% of the inventory their energy is a difference of large numbers
with dP/dm1 up to 10 bar/kg. That is the "drop the ledger, solve all three
masses from the totals plus the wall pin" rework, not a patch here.

**The ledger and its leash.** m₁ is watched, not trusted: the integrator
floors it at zero and ceilings it at the node's own mass; the closure caps
the claim at the inventory; and because u₃ is pinned, a drifting claim can no
longer hide in phantom steam — it shows up as the pressure and the sections
visibly disagreeing with the plant around them, which
`OtsgLedgerCheckOperator` reports (steam over every wall that persists, or a
claim swallowing the whole inventory).

## 3b. Addendum: what leaves the tube, and out of which section

*(2026-09-08. Fixes the drift source §3a's "ledger and its leash" paragraph
could only report.)*

The economizer is a MASS ledger, so every kilogram of slug water that leaves
the node has to be debited from it. Booking an outflow by the momentum path's
phase LABEL (`conn.currentFlowPhase`) cannot do that. That label is written
last, before the rates run, by `FlowDynamicsConstraintOperator`'s own phase
model, which knows nothing about the partition: it estimates the node's
height as the cube root of its volume (1.2 m for an Xe-100 bundle whose real
tubes are 14 m) and compares the connection's elevation against a
bulk-quality liquid level inside that fiction. Every nozzle more than a metre
up therefore reads 'vapor' whatever is standing at it. Measured on a
circulator trip (`scripts/probe-otsg-draw.ts`): **128-190 kg of slug water
left the tube over 180 s without the ledger ever being debited** - 2.7-4.2%
of everything that left, 10.5% on a station blackout - and past the point
where the bundle floods, a mid-bundle leak drains the economizer with the
whole draw booked to the steam section.

The section that owns a draw is the one PHYSICALLY at the nozzle, and the
partition already answers that: `drawCompositionAt` reads the partition's own
section boundaries by elevation (economizer / boiling / superheat), the same
convention the feed nozzle is selected by. It is also the answer the ENERGY
side has always used - `FlowRateOperator` and the pressure solver both price
a draw by blending those same mass weights over the section enthalpies
(`hLiquidOut` = the slug's mean, `hSteamOut` = the superheat outlet). So the
mass debit and the energy the node loses now describe ONE event. Only the
LIQUID share needs booking, because the boiling and superheat masses are
derived from the totals.

**What is not booked by elevation: the steam pass's transit scale.**
`WSteamOut` is not a second ledger; it is the flow the wall pin's theta and
the superheater's transit branch are scaled by. The sections of a
once-through tube are in SERIES, so what the bundle ships had to flow
through the sections above the water it came from - the outlet is the top of
the tube, and the drawn nozzle's half-metre of stub below it is
drawing-frame detail, not a bypass. So the transit scale stays the bundle's
whole non-liquid throughput. Scaling it by elevation instead was built and
measured: the moment a flooding tube's boiling section rose past the steam
nozzle, the pin's theta stepped from ~0.1 to 1 (a dead-ended pocket soaking
to its metal, T3 270 -> 390 C) and on a tube that is 99% water that step
lands in the published pressure through the last cubic centimetres of vapour
- circulator-trip rejections 649 -> 1201. A discontinuity in an ARGUMENT,
which no timestep can shrink. The residual defect is that the zone boundary
crossing a nozzle is a POINT sample (`drawCompositionAt` gives OTSG nozzles
no opening height and no interface tolerance), so `wLiquid` still flips 0<->1
as a boundary sweeps past; a real nozzle diameter would crossfade it.

An INFLOW is the DONOR's business, so it is classified by the DONOR's own
draw model at its own nozzle - its non-vapor share (1 - wVapor), the
continuous form of the "not labelled vapor" test it replaces. For the
single-phase feed line that is every plant's normal case that share is
exactly 1, as the label was; where it differs it is again the answer the
energy side already uses, because `FlowRateOperator` prices what arrives by
this same composition of this same donor.

The `m1/(m1+1)` weight on a liquid draw STAYS. The new classification does
taper a draw off as its section dies - `wLiquid` goes to zero once the
economizer boundary falls below the nozzle - but for a feed nozzle 1 m up a
14 m tube that is at 7% of the inventory, not at zero, so the emptying-
section guard is still the thing that keeps `dm1` from running through the
floor.

**Measured (`perf-xe100` 120 s, `perf-lofc` 180 s, tick 0.1 s):** steady
Xe-100 2406 steps / 3 rejections, unchanged; blackout 2290/294 ->
2917/490; circulator trip 3117/649 -> 3164/634 with the two "needs more than
220 bar to pack" refusals gone. PWR and BWR bit-identical. Read those
rejection counts against the plant's own chaos: a 1e-12 relative tickle on
one booked draw moves the SAME code's blackout 294 -> 360 and its circulator
trip 649 -> 600, and moves the pack refusals 2 -> 0 and the "steam above its
wall" reports 3 -> 0. Rare-event counts on one 180 s run are noise at this
sample size; the 128-190 kg of undebited slug water is not.

The "economizer ledger claims 99.x%" reports (20 of them on the circulator
trip) do NOT go away, and should not: by t=50 s that tube is genuinely water
solid (988 kg in 1.19 m3 at v = 0.00120 m3/kg, u = 842 kJ/kg against
u_f = 1040), so a ledger claiming 99.8% of it is telling the truth. The
report fires because `node.fluid.phase` is 'two-phase' on a gram of steam at
the top. That check is asking the wrong question - the drift it wants to see
is the integrator's ceiling CLIPPING the ledger, which `probe-otsg-draw.ts`
measures directly (21% of accepted ticks on that run, both before and after
this change) - and rewriting it that way is left open.

## 3c. Addendum: the slug carries its own energy

*(2026-09-08. Replaces the pinned-profile pricing described in 3a - "the
economizer's INLET enthalpy is geometry, not flow" - which was a repair to
this defect rather than a cure for it.)*

The economizer was a MASS ledger priced on a linear profile pinned at the
instantaneous inlet enthalpy, U1 = m1 (u_in + u_f(P))/2. Two things followed
that the plant could feel:

- a feed-temperature change repriced the WHOLE slug in one step. Measured
  (`scripts/probe-otsg-feedstep.ts`, MODE=step, a 20 K chill of the water at
  the feed nozzle): the same totals and the same slug mass, priced the old
  way, publish **144 -> 174 bar in a single step**. The published pressure
  now moves 154.23 -> 154.12 bar across the same step, and the profile's cold
  end walks with the feed at its own turnover instead;
- a STANDING slug under a hot wall could not warm. The old flux was
  W12 = (Q1 - W_in (hBar1 - h_in))/(h_f - hBar1), and at W_in = 0 that put
  the whole duty into boundary motion - twice the batch-heating rate - while
  the real slug's mean energy rose. The energy the pinned profile could not
  hold landed on the leftovers, which is one source of the "steam section
  above its wall" reports.

**The state is now the pair (m1, U1) and the profile is DERIVED from it.**
It stays linear - uniform in enthalpy per unit mass, which is what a steady
flow under a wall builds - so with mean hBar1 = U1/m1 + P v1 running up to
the saturation the pair is referenced to, the cold end is
h_a = 2 hBar1 - h_f. The balances are the ordinary ones:

    dm1/dt = W_in - W12 - (liquid draws booked to the slug)
    dU1/dt = W_in h_in - W12 h_f + Q1 - P dV1/dt - (draws at u1 per kg)
    W12    = Q1 / (h_f - h_a) = Q1 / (2 (h_f - hBar1))

W12 is just the mass crossing saturation: the profile's density in energy
space is dm/dh = m1/(h_f - h_a), the wall pushes every kilogram up at Q1/m1,
and their product is the flux. A draw costs the section u1 per kg - its
enthalpy out less the boundary work the vacated volume does, which is the
flow work it left with.

Three limits, each an analytic check and each a unit test:

1. **steady flow.** W12 = W_in and Q1 = W_in (h_f - h_in) give h_a = h_in:
   the derived profile IS the pinned one, so the steady plant does not move.
   This is exact in the profile the section carries, unlike the old form's
   algebraic identity - the fixture's own pressure round-trip (1e-4) is now
   what limits it, which is why that test's tolerance is 1e-3 W rather than
   1e-6 kg/s.
2. **no feed.** dm1/dt = -Q1/(h_f - h_a) and dh_a/dt = Q1/m1: the whole
   profile rises uniformly while its hot end boils off. Batch heating, with
   no switch between the regimes. In the plant (MODE=reversal, feed pump
   tripped): the cold end climbs at 5 kJ/kg-s and m1, u1 and the published
   pressure all stay smooth through the check valves seating.
3. **a colder feed** relaxes the cold end over one turnover m1/W_in, because
   cold mass arrives at the cold end. No lag constant, and nothing frozen -
   which is what the parked `otsg-slug-fraction` attempt got wrong by
   lagging the inlet instead.

**A flow that carries no heat now moves no mass across saturation.** Q1 = 0
gives W12 = 0: the column shifts bodily, the slug gets longer and colder on
average, and the interface - a material one when there is no phase change -
does not move relative to the water. The pinned profile had to report
W12 < 0 there. A pressure move still recruits boiling-section liquid, and
that belongs to `reconcileSlug`, below.

**reconcileSlug: one expression, both directions.** The physical invariant of
a pressure move is the profile's COLD END - no heat has crossed the wall, so
the coldest water in the slug is still the coldest water in the slug.
Preserving the profile's mass density in energy space and re-cutting it at
the new saturation gives

    m1' = m1 (u_f - u_a)/(u_fRef - u_a),   U1' = m1' (u_a + u_f)/2

which reads on a FALL as the part above the new saturation flashing out
(carrying exactly its own profile mean, which the leftovers inherit by
subtraction) and on a RISE as boiling-section liquid at the old saturation
joining and being warmed to fill the newly-subcooled span by the vapour
condensing beside it. Identity at u_f = u_fRef, exactly reversible, and the
rise still capped by what the leftovers can give (`slugJoinCap`, now judged
at the joining water's own mean energy). `uFRef` therefore STAYS: the fall
needs to know where the boundary was. The mass-ledger predecessor needed a
different rule per direction, and its rise had to over-join to undo its own
repricing; with the energy carried there is nothing to undo. The span-sign
test also carries the extinction limit: a pair whose mean has reached
saturation has boiled away, m1 = U1 = 0, no floor and nothing to switch. (A
sliver at m1 = 0.1 kg whose mean overshot saturation between write-backs is
exactly that state, and before the unified form it tripped the closure's own
invariant and killed a blackout at t = 159 s.)

**The extinction limit is benign, and that is not luck.** As a standing slug
dies, Q1 carries the section's own AREA, which is proportional to its mass,
so m1 stays proportional to its subcooling: measured on a blackout,
m1/(h_f - hBar1) held at 0.906 kg per kJ/kg for the last seconds while both
went to zero linearly and dm1/dt sat at -0.65 kg/s. W12 = Q1/(2 d1) is a
ratio of two quantities that vanish together.

**Two things this exposed, both fixed here.** The routing ramp measured an
inflow's subcooling against `saturatedLiquidEnergy(node.fluid.temperature)` -
and that temperature is the partition's mass-weighted MEAN of the three
sections, so a bundle holding 18 kg of 450 C steam reported a saturation 30 K
above its own T_sat and scored feed that was 6 kJ/kg ABOVE saturation as 30 K
subcooled, routing it into the economizer at full weight. It now reads the
saturation at the tube's own pressure. And the tangent band (`partitionLin`)
gained a gate on the PREDICTED PRESSURE MOVE: the state bands bound how
stale the anchor's sections are, but on a nearly water-solid tube the
leftovers are a difference of two large integrated numbers and dP/dU1 is
enormous, so a slug-energy move well inside its own band can imply tens of
bar. Without the gate the linearized pressure failed the solver's own
20%-per-step sanity check 943 times on a circulator trip (1714 rejections);
with it, 410 and none from the tube.

**Measured (`perf-xe100` 120 s, `perf-lofc` 180 s, tick 0.1 s), against 3b:**
steady Xe-100 2406/3 -> 2416/5 (148 MW, an oscillating plant); blackout
2917/490 -> 2455/358; circulator trip 3164/634 -> 3392/410, and the one pack
refusal 3b still had is gone. "Steam above its wall" reports 2 -> 1 on the
circulator trip and 0 -> 0 on the blackout (4 and 3 at the baseline). PWR and BWR bit-identical; npm test and the replay
bit-identity suite green; xe100-scenarios runs through with no bursts. The
"economizer ledger claims 99.x%" reports are unchanged (19-20 on the
circulator trip) and remain the water-solid tube 3b describes, not drift.

**One run got worse, and it is not the closure.** `xe100-scenarios` (the
station-blackout preset, settled 400 s then blacked out) now bursts the FW
check valve at t = 422.1 s with a 317-bar differential, where 3b does not.
Diagnosis: that node is a LIQUID-FULL 204 kg feed header, acoustically stiff,
and 20 s into the blowdown the tube and the feed line sit within a bar of
each other (108 vs 107) while the line's flow reverses through +88 to
+242 kg/s in two ticks - a feed-line water hammer, robust across tick sizes
(0.04 / 0.05 / 0.1 s all burst it within 4 s of the same instant). The tube's
own published pressure stays smooth through it at ~110 bar, with no pack
refusal and no ledger report, so this is the feed train's stiffness being
crossed by a slightly different trajectory rather than a partition failure.
The trajectory differs because the STEADY state does: this preset settles
with 227 kg in the tube and 128 MW where 3b settles at 175 kg and 113 MW -
closer to the seeded design point (222 kg slug, 200 MW), which is a separate
open item.

**Still open.** The fold (§3a) is untouched: `reconcileSlug` is still
evaluated at the walk's TRIAL pressure, and near-critical states can still
present several roots. `subcooledSectionMean` survives only to seed the
design point and to build test fixtures - no runtime path prices a section
from a feed enthalpy any more.

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
