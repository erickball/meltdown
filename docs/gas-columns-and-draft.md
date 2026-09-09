# Hydrostatic gas columns and natural draft

Built 2026-09-08 (branch `gas-column`). This is the change
`docs/zircaloy-air-oxidation.md` deferred under "Natural draft, and this is
the big one": a connection's pressure now carries the weight of the GAS
standing between the node's datum and the opening, inside the plant and
outside it, so a hot vessel with two openings at different heights breathes.

## The rule

`pressureAtConnection(node, z)` (src/simulation/operators/connection-hydraulics.ts)
is one formula for every node, and the datum it measures from is the node's
**liquid surface**:

```
    P(z) = P_node + rho_liquid * g * (L - z)      z <  L
         = P_node - rho_gas    * g * (z - L)      z >= L
```

* `L` is the node's liquid level from `calculateLiquidLevelWithObstructions`
  - the level of a two-phase node, the TOP of a liquid-full one, the BASE of
  an all-gas one. The two branches meet at `L`, so the answer is continuous
  as a node fills or drains, and the liquid half is exactly what it was
  before this change.
* A node with no liquid therefore carries `node.fluid.pressure` at its own
  BASE - which is `node.elevation`, the same point its ports' local
  elevations are measured from and the same point a connection's
  `elevation` (the difference of the two ports' absolute elevations) is
  measured between. The columns inside the nodes and the columns along the
  lines between them are one continuous ladder.
* Nodes with no vertical extent (`height` 0: pipes, pumps, valves) have no
  internal column at all, in either phase. Their whole run is charged to the
  connections at their ends, as before.

`rho_gas` is `nodeGasSpaceDensity(node, V_liquid)`, from the node's own
inventory, never re-derived from its pressure:

```
    rho_gas = (m_water * x) / (V - V_liquid)   +   m_ncg / V
```

The two species use the two volumes their own partial pressures are priced
over. Water vapour occupies the vapour space, and for a two-phase node
`m*x/(V-V_liq)` IS the saturated vapour density at its temperature, by
construction. The NCG's partial pressure is priced over the FULL node volume
- the documented simplification at the top of `mixture-properties.ts` - so
its density in the mixture is priced the same way; spreading it over the
vapour space instead would make a 20%-ullage pool's 1 atm air headspace read
five times denser than air while the same node reports 1 atm. When there is
no liquid the two volumes are the same thing and this is just the node's bulk
density, which is the case every gas loop and every drained building lives
in.

## The outside air

The atmosphere is still ONE boundary node, not a column of nodes. It is
stated at the terrain datum (`ENVIRONMENT_REFERENCE_ELEVATION = 0`, which is
the `elevation` `createAtmosphereNode` gives it) and it holds no liquid, so
by the rule above its 101325 Pa lives at z = 0 and

```
    P_atm(z) = 101325 - rho_air * g * z
```

with `rho_air` the node's OWN density - 20 C, 1 atm, 50% RH, N2/O2/Ar - which
is what makes the cancellation exact rather than approximate.

An environment endpoint's "local" connection elevation is therefore its
ABSOLUTE elevation (`createFlowConnectionFromPlantConnection`), because local
elevations are measured from a node's own reference and this node's reference
is the datum. The environment end has no geometry of its own, so it sits at
the same physical point as the port it faces unless the connection states a
height above the local ground - unchanged from the rule
`docs/pool-component.md` introduced.

The one place the boundary differs from every other node: a port drawn
outside a node's body is clamped back into it (a valve pot with a port 3 m up
still draws from inside the pot), but the outside air has no walls to be
outside of, so its column is NOT clamped and runs to whatever elevation the
opening is at - including below the datum, where the air is denser than
1 atm.

Break connections (`burst-operator.ts`) carry the same point on both sides: a
hole has no length, so its `elevation` is 0 and its `toElevation` is the
absolute elevation of the tear expressed in the target's own reference.
Without that the target answered at its mid-height - 5 km up, for the
atmosphere.

## Why the two terms had to land together

Either alone fabricates a permanent draft through any cold vented building.
Together they cancel identically when the gas inside matches the gas outside,
at every height, which is the property that makes the pair correct rather
than merely plausible. Measured (regression test `Gas columns: a cold vented
building has no draft, a warm one is a chimney`): a 20 m building with
openings at 0.5 m and 19.5 m, its gas built from `createAtmosphereNode`'s own
recipe, sees **1.5e-11 Pa** of head across either opening at t = 0, against a
**224 Pa** column - i.e. zero to the last bit of a 101325 Pa number. The same
building at 100 C draws **2.4 kg/s** in at the floor and pushes the same out
of the roof.

Running, the cold building settles at **4.8 mPa** of head (2.1e-5 of its
column), which moves 0.038 kg/s through two 0.5 m2 holes. That residual is
NOT the gas columns. It is the building's own initial state failing to
survive a round trip through the mixture solve: the steam tables do not reach
0.012 bar, `createFluidState` says so out loud
("falling back to the ideal-gas/linear-cv estimate. This node will start with
a temperature step"), and the node settles 3.6 mK warm and 4.3e-5 lighter
than the boundary - which is never re-solved, being a boundary. Fixing that
means extending the superheated-vapour inversion below the grid, which is
water-properties work and has not been done.

## Loop closure

`scripts/check-gas-columns.ts` builds every preset, test plant and level, sets
every flow to zero and adds the hydrostatic terms up around every independent
loop of the flow network (the loops through the atmosphere included). It
reports two numbers per plant:

* **UNIFORM** - the same sum with ONE density everywhere. This MUST be zero.
  With one density the columns telescope around any closed path, so anything
  else is a broken ladder: the two books (a connection's `elevation` and its
  two ports' local elevations) disagreeing, which is the 1.85 bar phantom
  head the RCCS thermosyphon taught. The per-connection form of the same
  defect is the GEOMETRY RESIDUAL, `conn.elevation` minus the difference of
  the two ports' absolute elevations as `pressureAtConnection` actually reads
  them (a port clamped into its node's body is a broken rung and shows up
  here).
* **REAL** - the sum with the model's own densities. This is NOT expected to
  be zero: a loop whose two legs stand at different densities has a real
  buoyancy head, and that head is the whole point.

Result over 23 plants: every UNIFORM loop head is 0 or 1.5e-11 Pa (round-off)
**except w4loop.json, at 1962 Pa**, and that one is pre-existing and has
nothing to do with gas. Every geometry residual in every preset comes from
the same place: a node with NO vertical extent (a pump, a valve, a
crossVessel end) whose connection states a port elevation anyway.
`pressureAtConnection` says a point node has no internal extent and answers at
its reference; the factory's `pointOf` charges the port height to
`conn.elevation`. The two residuals cancel in pairs as long as a point node's
two ports are at the same height - which `hasPinnedPortElevations` enforces
for pumps and valves - so xe100's +-0.9 m and pool-level1's +-0.3 m sum to
nothing around their loops. w4loop's turbine-driven AFW pump is the exception:
steam in at 1.2 m, exhaust at 1.0 m, leaving 0.2 m = 1962 Pa on the
uniform check (~40 Pa at the real steam density). The one-line fix is to make
`localElevationOf` return 0 for ANY zero-height node, as it already does for
pipes - but that shifts `conn.elevation` on every preset with an offset pump
nozzle, so it wants its own change and its own re-tuning.

## What it changed

### The spent fuel pool: the fire now breathes

`npx tsx scripts/test-game-levels.ts sfp`, the unfed level-1 run (an
earthquake tears the liner 0.4 m up the wall; the vent is at the rim, 10.1 m
above it):

| | before | after |
| --- | --- | --- |
| racks uncovered | 5,040 s | 5,040 s |
| boiled dry | 18,120 s | 19,720 s |
| clad past 900 C | 22,320 s | 23,740 s |
| peak oxidation | 6.1 MW | 3.9 MW |
| release limit | 24,040 s | 24,800 s |
| clad there | 1177 C | 1092 C |
| cladding consumed | 1.65% | 1.95% |

`npx tsx scripts/probe-sfp-fire.ts` shows the mechanism. Before, the pool's
6,050 mol of O2 boiled out by t ~ 9,000 s, the NCG inventory went to zero and
stayed there, and the tear and the vent both blew OUT for the rest of the
run: the fire burned in steam and stopped (0.000 MW, 1.71% of the cladding,
from t ~ 21,300 s to the end of a 52,000 s run). After, the tear draws air IN
at 0.11-0.20 kg/s while the vent pushes steam out at 3.7 kg/s - a
once-through chimney - so the pool holds ~110 mol of O2 all through the
boil-down and 1,463 mol once the steam stops. The fire then runs at a steady
**1.5 MW** and has eaten **12.9% of the cladding by t = 47,500 s** instead of
freezing at 1.7%.

The oxygen FRACTION in the pool stays near zero either way, and that is the
right answer rather than a failure to breathe: 0.3 kg/s of air carries ~2
mol/s of O2 into racks whose kinetics at 750 C would take ten times that, so
every molecule reacts on arrival. The measure of a fed fire is the power the
delivery sustains, not the oxygen left over.

The A/B is in the regression suite (`Natural draft feeds a Zircaloy fire`):
the same drained hot pool, the same tear, moved from 0.4 m to 11.5 m so the
chimney is 0.5 m instead of 11.6 m. Floor tear: 0.286 kg/s of air in, 5.51 MW
sustained. Rim tear: 0.120 kg/s, 4.27 MW. Height is the only difference
between the two runs.

### Gas-cooled reactors: a real, and smaller, thermosiphon

Xe-100 at power is barely touched. `scripts/xe100-probe.ts` at 600 s: helium
78.5 -> 79.7 kg/s, core outlet 749.6 -> 749.5 C, core inlet 468.2 -> 465.4 C,
steam 11.8 -> 12.3 kg/s, 112 -> 119 MW, and the solver is slightly healthier
(13 rejections and dt 250 ms, against 17 and 206 ms). The plant is inside its
known m1-flood limit cycle either way. SGTR is indistinguishable: 63.76 ->
63.67 kg/s of helium, primary pressures within 0.03 bar.

The blackout is where it shows. The primary ring after the circulator trips
(`xe100-sbo.json` through the same harness the suites use):

| t | before | after |
| --- | --- | --- |
| 400 s (circulator on) | 80.7 kg/s | 81.0 kg/s |
| 420 s | 3.56 | 1.16 |
| 500 s | 3.38 | 0.85 |
| 600 s | 3.38 | 0.31 |
| core gas at 600 s | 820 C | 851 C |

Both are smooth: all seven segments of the ring agree to a few percent at
every sample and decay monotonically. Natural circulation is **weaker**, and
that is the correction, not a regression. Before this change a node's
internal rise was a FREE pressure gain - the model charged nothing to lift
gas from a node's inlet port to its outlet port - which is the caveat the
hydrostatic-loop note ends on. The Xe-100 lifts helium 11 m through the core
and drops it 14 m to a below-grade steam generator, so that free gain was
inflating the thermosiphon. Now the core's rise is priced at the core's own
(hot, light) gas and the downcomer's at its own (cooler, heavier) gas, the
loop's static head is +137 Pa AGAINST the forced direction at the design
state (`check-gas-columns.ts`, primary loop), and the post-trip circulation
settles at a third of a kg/s with the core 30 K hotter. A hot leg that
descends to a low SG is a geometry whose buoyancy opposes its forced
direction; that is a property of this plant layout, and the model now says so.

(`scripts/test-simulation.ts` does not register `OtsgRateOperator` or
`GraphiteOxidationRateOperator`, so it runs the Xe-100 with a different steam
generator and reaches a different state - 56 bar rather than 67 at t = 600 s
in the blackout. Under that runner the post-trip ring prints per-segment
flows that disagree by ~10 kg/s while the node inventories move by 0.009
kg/s, i.e. the printed flows are not what was advected. That is a runner
artifact and it is NOT chased here; `xe100-probe.ts` and every suite use
`scripts/lib/sim-harness.ts`, which registers the full operator set.)

### Everything else

All 13 pre-existing plant scenarios pass unchanged, plus the two new ones.
`npm test` passes. The level-1 `sfp` check passes. No preset was re-tuned.
The presets whose behaviour moved at all are the two above (spent fuel pool
and Xe-100); the PWR/BWR/two-loop/w4loop family is a liquid plant whose gas
spaces are small columns on large pressures (a 155 bar pressurizer steam
space is ~10 kPa over 10 m, and its surge line is at the bottom, in liquid),
and none of their scenario numbers moved enough to disturb an assertion.

## Known approximations

* The column along a LINE between two nodes (`dP_gravity`) is priced at
  `drawCompositionAt`'s density, which for a gas node is
  `approxVaporDensity` - ideal-gas steam at its partial pressure plus the
  NCG, with a 0.1 kg/m3 floor - while the column INSIDE a node is priced at
  the node's inventory. For a gas loop the two agree to the ideal-gas error
  of the steam share (exactly, for the NCG share, which is mass/volume in
  both), but for dense steam they do not: real 155 bar steam is ~100 kg/m3
  where the ideal-gas form says 54. Unifying them means changing the momentum
  and choking density everywhere, which is its own change.
* Choking (`computeChokeLimit`) still compares the two nodes' BARE pressures,
  not the pressures at the two ends of the connection.
* Each column is priced with one density over its height rather than
  integrated against the barometric variation of that gas's own density. Over
  any plant height that is a part-per-thousand effect, and it is second-order
  in the cancellation above (both sides use one density).
* A tank/pool IC declares its pressure as the node's, i.e. at its liquid
  surface. A component whose base stands well above the terrain datum
  therefore starts a little over ambient and puffs once through its vent -
  the level-1 pool's headspace is ~130 Pa high at t = 0 and relieves 0.2 kg
  of air in a fraction of a second. No preset was re-seeded for this.
