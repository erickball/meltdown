# Zircaloy oxidation in steam AND in air

Built 2026-09-08 alongside the spent-fuel-pool level. Lives in
`CladdingOxidationRateOperator` (`src/simulation/operators/rate-operators.ts`).

Until now a fuel rod could only burn in steam. That is the right reaction for
a core inside a pressure vessel, and the wrong one for a spent fuel pool that
has boiled dry: those racks stand in AIR, and

    Zr + O2 -> ZrO2          1096 kJ/mol Zr
    Zr + 2 H2O -> ZrO2 + 2 H2  586 kJ/mol Zr

differ by nearly a factor of two in heat as well as in what they leave behind
(one makes hydrogen for later, the other makes nothing but heat). Both now run
in PARALLEL on the same metal, each on its own oxidant's concentration. There
is no regime switch and no "is this a steam accident or an air accident?"
anywhere in the model, because a rack half in steam and half in air is doing
both at once.

## The rate law

Both reactions grow a protective oxide, so both are parabolic in the thickness
of metal already consumed, X:

    d(X^2)/dt = k(T)      =>      dX/dt = k(T) / (2X)

X starts at `INITIAL_OXIDE_THICKNESS` = 1 um of metal (~1.6 um of oxide) rather
than zero. This is not a numerical guard for the singularity at X = 0; cladding
is never bare. Benjamin et al. record 15-20 um of waterside corrosion oxide on
discharged PWR fuel and used 1.5 um as the deliberately conservative value for
their spent-fuel heat-up calculations, which is what this is.

## Oxidant supply, in series with the kinetics

Growing oxide consumes oxidant, and the oxidant has to arrive through the gas.
Two resistances in series, so the flux is their harmonic mean:

    J = 1 / ( 1/J_kinetic + 1/J_transport ),   J_transport = h_m * C_bulk

with `h_m` from the same Sherwood correlation the graphite oxidation operator
uses, `Sh = 2 + 0.6 Re^0.5 Sc^(1/3)` on the rod diameter, and `C_bulk` the
oxidant's molar concentration in the node's gas space taken straight from its
inventory (moles / gas volume), never from its pressure.

Two things fall out of that and are therefore NOT rules anywhere in the file:

* **Oxygen starvation.** As O2 is consumed, `C_bulk` falls and so does the
  rate. A pool fire puts itself out. The test asserts it.
* **Ignition.** Nothing in this operator knows an ignition temperature. A rack
  "ignites" when the chemical power outruns what the rack can lose, which is a
  property of the heat balance and not of the rate law. `scripts/check-zr-oxidation.ts`
  finds where those two curves cross for a given rack: 742 C for level 1's
  8 MW / 7209 m2 racks on fresh oxide, which is the right neighbourhood for
  Benjamin's 5.7-8.7 kW-per-assembly self-sustaining criterion.

Benjamin et al. did the same thing with `min(kinetic, diffusion)` and the
heat/mass-transfer analogy for the transport term. The harmonic mean is the
smooth version of that min - same asymptotes, no corner.

Reading `C_bulk` from the INVENTORY rather than from the node's pressure also
stops the reaction consuming steam that is not there. A node that has boiled
itself down to grams still reports its last pressure; pricing the steam supply
off that let the reaction draw 0.12 kg/s of steam out of a node holding 6 g,
and the run came apart shortly afterwards.

## Where the surface is

The submerged part of a rack sits against liquid water: unlimited steam supply
at the surface, so it is purely kinetics-limited, and no oxygen. The emerged
part sits in the node's gas and reacts with whatever is in it. The split is
`effectiveSurfaceAreas`, the same liquid-level split the convection model uses
- promoted to a module-level function so the two cannot disagree about how much
of a rod is wet.

## Constants, and how they were converted

### Air: Benjamin et al., NUREG/CR-0649

**Source:** A. S. Benjamin, D. J. McCloskey, D. A. Powers, S. A. Dupree,
*Spent Fuel Heatup Following Loss of Water During Storage*, NUREG/CR-0649
(SAND77-1371), Sandia Laboratories, March 1979 - Section 3.2 and Figure 6.
Public: https://www.nrc.gov/docs/ML1209/ML120960637.pdf

This is the study the whole scenario comes from, and its air correlation is
fitted to Zircaloy-4 (Leistikow 1975) plus pure-zirconium data (White 1967,
Hayes & Roberson 1945). It gives

    2W dW/dt = K0 exp(-Ea/RT)

with W the weight gain in **mg O2 per cm2**, t in s, R = 1.987 cal/(mol.K) and
Ea in cal/mol, in three fitted branches:

| range | K0 | Ea (cal/mol) |
|---|---|---|
| T <= 920 C  | 1.15e3 | 27340 |
| 920 C < T <= 1155 C | 5.76e7 | 52990 |
| T > 1155 C | 6.20e4 | 29077 |

**Conversion to metal-recession form.** One mg of O2 per cm2 corresponds to
M_Zr/M_O2 = 91.22/32.00 = 2.8507 mg of Zr per cm2, i.e.

    X = 2.8507e-3 g/cm2 / 6.5 g/cm3 = 4.3857e-4 cm = 4.3857e-6 m of metal

so d(X^2)/dt = (4.3857e-6)^2 * K0 exp(-Ea/RT) = 1.9235e-11 K0 exp(...), and
Ea x 4.184 puts the exponent in J/mol:

| range | A (m2/s) | Q (J/mol) |
|---|---|---|
| T <= 1193.15 K | 2.2120e-8 | 114391 |
| T <= 1428.15 K | 1.1079e-3 | 221710 |
| above | 1.1926e-6 | 121658 |

**The two breakpoints are the source's, not ours,** and it says what they are:
the alpha/beta change in the Zr-O solid solution at 920 C and the
monoclinic-to-tetragonal change in ZrO2 at 1155 C. The first pair join
continuously (they agree to 0.1% at 1193 K - that is how the fit was made); the
third branch steps UP by about 5x at 1428 K. **That step is reproduced rather
than smoothed away.** Smoothing it would be inventing a blend width that is not
in the source, and it is nearly invisible in a fire anyway: above ~1100 C it is
the oxygen supply and not the kinetics that governs.

### Steam: Baker-Just (1962), and a units bug it was carrying

    (m/A)^2 = 3.33e7 * t * exp(-45500/(R T)),  m/A in mg Zr/cm2, R cal/mol.K

1.53846e-6 m of metal per mg Zr/cm2 squares to 2.36686e-12, so
A = 2.36686e-12 x 3.33e7 = **7.8817e-5 m2/s**, Q = 45500 x 4.184 = 190372 J/mol.

The previous code carried **3.33e-3 m2/s**, having converted "33.3 cm2/s" to
m2/s by 1e-4. The correlation's constant is not an area rate - its units are
(mg/cm2)^2/s - so the steam reaction was running **42x too fast in k**, i.e.
about 6.5x too fast in rate. Fixed here, because two rate laws that are meant
to run in parallel have to be on the same footing before they can be compared
at all. All 13 plant scenarios (including the melt/MCCI chain) pass after the
change.

### Which is faster

`npx tsx scripts/check-zr-oxidation.ts` prints the comparison. Air / steam:
221x at 400 C, 3.4x at 700 C, 1.4x at 800 C, 0.6-0.9x at 900-1100 C, 2-4x above
1155 C. Below ~900 C air is clearly faster, which is Benjamin's own statement;
between 900 and 1100 C our steam number is Baker-Just, which is deliberately
conservative (roughly 2x Cathcart-Pawel), so air reads slightly slower there
than it would against a best-estimate steam correlation.

## What is NOT modelled

* **Nitriding as a separate reaction.** Benjamin's constants are fitted to
  Zircaloy in AIR, so nitrogen's effect on the oxide is inside them; what is
  missing is a separate ZrN inventory and its re-oxidation, and the breakaway
  transition that Steinbrück's later KIT work resolves. The practical
  consequence is that the model has no accelerating post-breakaway phase.
* **Natural draft, and this is the big one.** A drained pool in this model is a
  single well-mixed node with one or two openings, and the pressure at an
  opening carries no hydrostatic gas column - inside OR outside. Both terms are
  missing and they do not cancel, so a hot pool has no chimney: the boiling
  purges its own air out of the vent (correctly), and then nothing draws fresh
  air back in. The unfed level-1 run therefore burns in STEAM, not in air, and
  runs out of oxygen within seconds of drying. Making air ingress work needs
  two coupled terms - a gas column inside a node (`pressureAtConnection`
  returns the bare node pressure for a vapour node today) and an elevation-
  dependent pressure at the environment endpoint - which must land TOGETHER,
  because either alone fabricates a permanent draft through any cold vented
  building. That is a global change to every gas-filled component in every
  preset and it is deliberately not in this change.
* **Decay heat does not follow the pool's released fission products** the way a
  core's does (the pool's `fuelPower` is a declared constant), so a pool that
  has released half its volatiles still makes its full stated heat.

## Checks

* `npx tsx scripts/check-zr-oxidation.ts` - the constants, the air/steam ratio
  across temperature, the self-sustaining crossing, and the transport ceiling.
* `scripts/test-plant-scenarios.ts`, "Zircaloy fire: dry racks burn faster in
  air, and the fire eats its own oxygen" - the same drained pool in air and in
  nitrogen, 300 s each. Air: 34.8 MW peak against 5 MW of decay heat, 11,325
  mol of O2 down to 0, 0.45% of the cladding consumed. Inerted: 0.33%
  (residual steam only). The fire falls back from its peak on its own.
* `scripts/test-game-levels.ts sfp` check [1] - the unfed level: racks uncover
  t=5040 s, boils dry t=18120 s, cladding past 900 C t=22320 s with 6.1 MW of
  oxidation, release limit t=24020 s, 1.65% of the cladding gone.
