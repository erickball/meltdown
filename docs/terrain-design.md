# Terrain and surface water

Ground for the plant: a height field over the plan, and a very simplified
account of water that ends up on the ground. Built for the spent-fuel-pool
level (a shore pump, a tsunami, a leaking pool) and general enough for hills
under gravity-head tanks.

## Data

`PlantState.terrain` (`src/terrain-types.ts`, plain data like the scenario
types): a grid of cell heights (metres above datum, row-major, `cellSize`
pitch, `origin` = centre of cell (0,0)), an `infiltration` rate for open
ground (m/s, default 1e-4), and `waters`: named water bodies, each a seed
point and a surface height. A plant without terrain is flat at 0 and nothing
below engages.

A component's `elevation` means **above the local ground**. Its absolute base
is `terrainHeightAt(position) + elevation` (bilinear between cell centres,
held at the edges). The factory prices every node elevation and every
connection through that, so a tank on a hill has its head for free.

## Derived model (`src/simulation/terrain.ts`)

`buildTerrainModel(spec)` runs once per simulation build (the model is
never mutated and is shared by reference between cloned states):

- **Drainage.** Every cell drains by steepest descent (8 neighbours) to a
  local minimum. Neighbouring sinks at the same height are unioned, so a
  level shoreline or a flat sea floor is one basin, not one per cell.
- **Basins.** Each has its cells sorted by height - the stage-storage curve
  (`surfaceAtVolume`, `volumeAtSurface`, `wettedArea`) - and a spill: the
  lowest crossing into a neighbouring basin and which basin that is.
- **Water bodies.** The basin containing a body's seed is that body; its
  surface is a boundary condition, not a stored volume.

## Water on the ground (`src/simulation/operators/surface-water.ts`)

State: `SimulationState.surfaceWater` = stored volume per open basin plus
the bodies' surfaces (each a level or a ramp from one level to another,
started by a scenario event).

- **Rate operator.** Liquid crossing into a boundary node (a break or vent
  to atmosphere) lands in the basin under its source node (`node.position`,
  stamped by the factory) at the liquid mass share of the draw over the
  liquid density. Every open basin loses volume at `infiltration x wetted
  area`: a leak makes a puddle that spreads until the ground takes it as fast
  as it runs. Nothing else is a rate.
- **Constraint operator.** Scripted surfaces follow their ramps in time;
  dry puddles are removed; water above a basin's spill height crosses into
  the basin it spills to (vanishing into a water body), repeated while
  anything moves; and every pump is flagged `flooded` when the surface of
  its basin stands above its base.
- **Flooded pumps** coast down like tripped ones and cannot restart until
  the water is gone (`PumpSpeedRateOperator`).

Scenario action: `{ kind: 'water-level', id: 'sea', surface: 5, over: 20 }`
raises the sea to +5 m over 20 s; a second event brings it back. That is
the tsunami.

## Why this shape

- No flow between basins except overflow at the lip, and no time for water
  to get from a leak to its basin: at the timescales of a level (minutes to
  hours at 60x) runoff is instantaneous and only the volumes matter.
- Infiltration through the wetted area is what makes ground water "mostly
  soak in" without a rule: the puddle's area grows until the ground drinks
  the leak. Only declared bodies hold water indefinitely.
- The sea as a scripted surface, not a volume, is the honest way to script
  a tsunami; the plant's hydraulic reservoir at the shore is still an
  ordinary tank component whose node is what pumps draw from.

## Drawing (2D grid view)

Height tint over the ground texture (valley green to hilltop tan), contour
lines every metre with a heavier line every five, and every cell below its
basin's water surface in translucent blue (deeper = more opaque): the sea
and lakes at their surfaces, puddles where a leak has pooled. In
construction mode the bodies show at their declared surfaces.

## Not yet

- A terrain editor (levels ship their height field); hills as a build item.
- The 2.5D view ignores terrain.
- Ground water as a source: a puddle cannot be pumped.
- Flooding affects pumps only; a flooded tank or valve carries on.
