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
lines (minor interval about a twelfth of the relief rounded to 1/2/5, index
contour every fifth), and every cell below its basin's water surface in
translucent blue (deeper = more opaque): the sea and lakes at their
surfaces, puddles where a leak has pooled. In construction mode the bodies
show at their declared surfaces.

Contours are marching squares over the BILINEAR surface (`terrainHeightAt`)
on a lattice three times finer than the cells, chained into polylines and
drawn through their own midpoints as quadratic curves
(`src/render/terrain-contours.ts`). They therefore curve and close the way a
surveyed contour does. The geometry is world-space and cached with the
height field, so only the projection is per frame. (The first version walked
cell EDGES, which drew a staircase.)

## A water body that is also a component

A sea or lake a pump takes suction on has to be a real flow node - finite
inventory, a water surface, a nozzle to pipe to - and until now that meant a
steel tank drawn standing on the beach. `TankComponent.waterBody` names a
terrain water body that the tank IS:

- the grid view treats it as a GROUND-LAYER component: no pad, no sprite.
  The blue the terrain already paints for that body is its picture.
- its hit area is the water (`GridView.onWaterBody`) plus a small reach round
  its nozzle, so clicking the sea selects it; selecting or hovering it tints
  the whole body and outlines its shore.
- gauges hang off the nozzle rather than off the (meaningless) footprint, and
  the footprint is not a routing obstacle - a pipe crosses water.
- 2.5D, which has no terrain, draws the water SURFACE as a low band at the
  component's own water line instead of a vessel.

Nothing about the physics changes: it is one tank node, and a sea can be
pumped dry. The tank's `elevation`/`height`/`fillLevel` still have to put its
surface at the body's surface - that is the author's job, and the level
generator asserts it.

## Not yet

- A terrain editor (levels ship their height field); hills as a build item.
- The 2.5D view ignores terrain (a `waterBody` tank draws only its surface).
- Ground water as a source: a puddle cannot be pumped.
- A `waterBody` tank and the terrain body it draws as are still DECOUPLED:
  raising the body (a tsunami) does not raise the tank's level.
- Flooding affects pumps only; a flooded tank or valve carries on.
- The water fill is still per CELL, so a coastline reads blockier than the
  contours that now curve over it.
