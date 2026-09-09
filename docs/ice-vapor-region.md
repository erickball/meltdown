# Water below the triple point: the ice-vapour region

*2026-09-08. Extension of `water-properties-v4.ts` approved by Erick in advance;
every edit to that file is listed at the end.*

## Why

A helium loop blowing down from 70 to 2 bar expands its gas 35x, which is an
isentropic temperature ratio of about 4: 900 K in, ~217 K out. Whatever
moisture the loop carried is frost at that point. Before this extension the
model had nothing below 273.16 K. The dome test returned "outside", the (u, v)
solve threw "IMPOSSIBLE STATE: below triple point", the final validation threw
for any T below the triple point, the mixture energy split bracketed the
water's specific energy at +1 kJ/kg, and the fluid-state constraint carried a
node-level "ice buffer" that pinned the temperature at 273.15 K, forced the
phase to liquid, and **added energy to the node** to make its books balance.
That buffer is what a user saw as "hx-1-shell pinned at 273.16 K forever".

## The geometry

In (u, v) the sub-triple description is three curves and one triangle, all
anchored to the saturation table's own triple-point row so the two
descriptions meet exactly at 273.16 K:

| curve | definition |
|---|---|
| ice line | v = 1/917 m³/kg, constant; u_ice(T) = u_f(T_t) − 333.5 kJ/kg − 2.05 kJ/kg·K · (T_t − T) |
| vapour over ice | ideal gas at the sublimation pressure with Z frozen at the table's triple-point value; u_g(T) = u_g(T_t) − 1500 J/kg·K · (T_t − T) |
| sublimation | IAPWS R14-08 (Wagner, Riethmann, Feistel, Harvey 2011), certified 50 to 273.16 K |

The **triple triangle** is the set of (u, v) where ice, liquid and vapour
coexist. Its vertices are the ice, saturated-liquid and saturated-vapour states
at 273.16 K. Its liquid-vapour edge is exactly the old dome's bottom edge, the
same `u_bottom(v)` expression the dome test uses, so no sliver of state space
belongs to both regions or to neither. Inside it T and P are pinned at
273.16 K and 611.657 Pa, and the three phase fractions are barycentric
coordinates: warming through it is melting at constant temperature.

Below the triangle's ice-vapour edge and right of the ice line are the
ice-vapour tie lines, swept from the model's lowest temperature (150 K) up to
the triple point. A state there is found by the same bisection
`findTwoPhaseState` uses, with the ice line in place of the liquid line and
the same relative two-output stopping rule (quality and pressure each
bracketed to 1e-5 of their own magnitude). The residual is strictly monotone
in T for any v above the ice volume, so one root at most.

## The aerosol convention

An ice-vapour node is a well-mixed frost fog: no stratification, no liquid
level, a draw takes the mixture, the ice moves with the gas. It is therefore
reported as phase `'vapor'` with `quality = 1`, and the solid mass fraction in
a new field `iceFraction`. `quality` is now defined as the **non-liquid**
fraction, which is the ordinary vapour quality everywhere at or above the
triple point (there `iceFraction` is zero), so every consumer that reads
`1 − quality` as the liquid whose volume sets a level is unchanged. The true
vapour fraction is always `quality − iceFraction`.

A new phase value was the alternative and would have been worse: `phase ===
'vapor'` is tested in about 240 places, and a value none of them know would
route a frost node into whichever branch happens to be the `else`.

Consumers that read the ice explicitly: the pressure solver's compliance
(a frost node is a condensed-vapour equilibrium whose dP/dU is set by the
sublimation slope and latent heat, not the gas heat capacity), the standpipe
draw (ice does not evaporate up the pipe with the steam), the debug panel
(labels the node "frost" and shows the ice fraction).

## Scope limits, stated loudly

- **Bulk freezing is not modelled.** A state below the triple line at liquid
  or ice density, a tank or pipe of water going solid, throws
  `BULK FREEZING IS NOT MODELLED`. Freezing an inventory changes the network's
  topology (blockage, 9% expansion against the pipe) and needs its own
  representation.
- **The lowest temperature is 150 K.** Below it the solve throws
  `BELOW THE MODEL'S LOWEST TEMPERATURE`. The sublimation equation is certified
  to 50 K but the ice caloric fit is a two-term expansion about the triple
  point, and nothing in this sandbox is colder than a deep gas blowdown.
- The ice density and heat capacity are held constant (917 kg/m³, 2.05 kJ/kg·K);
  ice contracts 2% and its heat capacity falls to 1.4 between the triple point
  and 150 K. Both are negligible next to the vapour specific volume that sets
  the tie line's quality split.
- The vapour-over-ice caloric slope is 1500 J/kg·K, 7% above the ideal-gas
  value for cold steam, because it must equal the `cv_steam` the ideal-gas
  path uses for dilute vapour: that path owns the region immediately above the
  vapour-over-ice line, and sharing the constant is what makes T and P
  continuous across the line. The cost is 0.2% on the vapour's energy at 217 K.

## What changed outside the tables

- `mixture-properties.ts`: the water-energy bracket's low end is ice at 150 K
  (about −586 kJ/kg, negative because IAPWS puts u = 0 at saturated liquid at
  the triple point), not +1 kJ/kg; the cold tail of the seed sweep walks the
  sub-triple half of the band; `MixtureState` carries `iceFraction`.
- `rate-operators.ts`: the node-level ice buffer is deleted; the fluid-state
  constraint writes `fluid.iceFraction` from the split; temperature and
  pressure floors are the model's own (150 K, P_sub(150 K)).
- `rk45-solver.ts`: the sanity guards use `minimumSpecificEnergy(v)` from the
  tables instead of a floor built by hand from the triple point, which had put
  the floor at +1150 kJ/kg for a node at 100 m³/kg where the true floor is
  −584 kJ/kg; the pressure floor is `modelMinPressure()`; the "negative
  internal energy" check is replaced by the floor test.
- `pressure-solver.ts`: the [273.16, 646.5] K clamp on saturation evaluations
  is gone (the accessors continue onto the sublimation line); frost nodes take
  the condensed-vapour compliance branch; ice comes out of the standpipe draw.
- `connection-hydraulics.ts`, `fluid-flow.ts`: `iceFraction` carried through
  the draw composition.
- `types.ts`: `FluidState.iceFraction`, `quality` redefined as non-liquid
  fraction; `FlowNode.iceFraction` (the buffer) removed.
- `debug.ts`: frost label and ice fraction in the node panel.

## Verification

- `scripts/sweep-water-properties.ts` now hashes the points at or above the
  triple line separately. Old vs new: `ABOVETRIPLEHASH` identical
  (c51f8aa7…), so every state at or above the triple point is bit-exact;
  4465 states below it that used to throw now solve.
- Unit tests in `test-suite.ts`: the sublimation curve and ice line meet the
  table at the triple point (h_sub = 2834 kJ/kg = h_fg + h_fus); a (u, v) walk
  from the dome through the triangle into ice-vapour is continuous in T, P and
  ice fraction; trace moisture in helium blown down 900 K/70 bar to 2 bar is
  solved by the mixture split as frost at 217 K with the steam at its
  sublimation pressure; bulk freezing and sub-floor states throw their own
  messages.
- Presets at or above the triple point are on their previous trajectories.

## Edits to `water-properties-v4.ts`, classified

| edit | class |
|---|---|
| sublimation pressure (IAPWS-08), ice line, vapour-over-ice line, `latentHeatSublimation`, `iceCv`, `minimumSpecificEnergy`, `modelMinPressure`, `modelMinSpecificEnergy`, `MODEL_MIN_TEMPERATURE` | adds physics |
| triple triangle with barycentric phase fractions | adds physics |
| `classifySubTriple` and the sub-triple branch in `calculateState` replacing the flat "IMPOSSIBLE STATE" throw | adds physics |
| `saturationPressure`, `saturationTemperature`, `saturatedLiquidDensity`, `saturatedVaporDensity`, `saturatedLiquidEnergy`, `saturatedVaporEnergy`, `latentHeat` continue onto the sublimation line | removes a fabrication (the table clamp returned 611 Pa and liquid water at 1000 kg/m³ for any T below 273.16 K) |
| `idealGasApproximation` condensed-state test compares P against the equilibrium pressure at the state's own T instead of `u < u_g(T_triple)` | removes a fabrication (rejected legitimate cold vapour between 2317 and 2375 kJ/kg) |
| final validation floor 150 K instead of 273.16 K | scope limit |
| `WaterState.iceFraction`, `quality` redefined as non-liquid fraction; Wood's speed of sound uses the vapour fraction | adds physics |
| `T_MIN_MODEL = 150`, `RHO_ICE`, `CP_ICE`, `H_FUSION`, `CV_VAPOR_COLD` | physical constants, sources in the comments; `CV_VAPOR_COLD` is the one deliberate approximation (7% high, see above) |
| triple-point row cached as `tripleAnchor` with a check that the table's first row is the triple point | search anchor, fails loudly |
