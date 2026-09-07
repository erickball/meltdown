# The spent-fuel pool

A square, open, **sunken** basin of water with racks of spent fuel standing
in it. Built for level 1 of the game ladder (see `docs/terrain-design.md` for
the ground it stands in), but it is an ordinary component: anything that
wants a big open pot of water with a heat source in it can use one.

## What it is made of

Nothing about the pool is new physics. It is three existing pieces wired
together by `createFlowNodeFromComponent` / the pool block in
`createSimulationFromPlant` (`src/simulation/factory.ts`):

- **One FlowNode**, like a tank: `height` = the pool depth, `volume` = the
  water capacity (`side² × depth` less what the fuel rods displace),
  `flowArea` = the plan area. Liquid, vapour and air, boiling and drying out
  through the same (u, v) state everything else uses.
- **Two ThermalNodes**, exactly as a reactor core has: `<id>-pellets` (UO₂,
  carrying the constant `fuelPower`) and `<id>-clad` (Zircaloy, carrying the
  Zr-steam oxidation block), joined by a conduction connection whose
  conductance is the same series rod resistance a core uses (pellet interior
  r/4k + gas gap + half the clad wall).
- **One ConvectionConnection** from the cladding to the pool water, carrying
  `tubeBottomElevation` = the rack bottom and `tubeHeight` = the active fuel
  length. That is the whole uncovery model: `effectiveSurfaceAreas` splits
  the rod surface between liquid and vapour by where the obstruction-aware
  liquid level falls in that band, and the boiling curve / vapour-side
  correlations do the rest. A core does the identical thing.

Rack geometry comes from the assembly count and the rod design
(`poolRackGeometry`), so the wetted surface, the metal mass and the passage
the water rises through all follow from what the user built.

## Sunken, and open to the sky

Neither is a special case.

- `elevation` means "base above the LOCAL GROUND" everywhere in this model
  (`absoluteBase` in factory.ts). A pool of depth *D* placed at grade is
  therefore `elevation = -D`, and its rim lands at 0. The dialog default
  keeps the two in step.
- "Open to the atmosphere" is a **vent connection**, from the pool's rim
  port to the reserved component id `atmosphere` — the model's one boundary
  node. Steam leaves through it as the pool boils and air comes back in as
  the level falls, so the pool holds ~1 atm on its own instead of being
  declared to.

**The environment as a connection endpoint** (`ENVIRONMENT_NODE_ID` in
factory.ts) is new and generic: any connection may name `atmosphere` as its
`fromComponentId` / `toComponentId`. The environment end has no geometry, so
it sits at the *same physical point* as the port it faces unless the
connection states an elevation for it, which is then read as a height above
the local ground beside the other component. A vent therefore carries no
head no density difference put there, and a crack low in a pool wall drains
at its own depth rather than having to climb to grade first. Liquid crossing
into the boundary lands in the terrain basin under its source node and soaks
in (`operators/surface-water.ts`), which is what lets a liner crack empty a
pool that sits below ground level.

### The atmosphere is now air

Making a vent work forced a fix to the boundary node itself. It used to be
1e12 kg of pure water vapour at 1 atm, which is harmless as long as nothing
ever flows inward — a break only discharges — but two things went wrong the
moment a line was open both ways:

- a vent faced ~1 atm of steam on the outside against a few kPa under a
  column of air on the inside, and the species gradient drove tonnes of
  water *into* the plant;
- every uncontained component's outer wall faces this node, and pure steam
  at 1 atm has a 100 °C dew point, so bare metal anywhere below boiling was
  condensing "outdoor" steam onto itself.

`createAtmosphereNode` now builds standard sea-level air: 20 °C, 1 atm,
50% relative humidity, N₂/O₂/Ar at their atmospheric fractions. It is still
an infinite fixed boundary; only its composition changed.

## The earthquake crack

A leak from low in the pool wall to the environment, gated by an ordinary
valve so a scenario `{ kind: 'valve', ... }` action can open it. The
connection carries a **tall `fromOpeningHeight`**, so the draw averages the
pool's phase profile over the opening: as the level sweeps down through the
crack, the drawn stream crossfades from liquid to vapour and the leak dies
away instead of stepping. Together with the falling head above the crack
that gives a leak that starts at hundreds of kg/s and ends at single digits,
with no threshold anywhere.

The crack's valve component is placed at the crack's own depth
(`elevation` negative), which is what keeps the leak path level.

## Properties

| Dialog | Stored | Notes |
|---|---|---|
| Elevation (Floor) | `elevation` | above local ground; `-depth` puts the rim at grade |
| Side Length / Depth | `side`, `depth` | square in plan |
| Wall Thickness | `wallThickness` | drawn concrete; the pool is not a pressure vessel |
| Decay Heat | `fuelPower` (W) | **constant** — no decay curve |
| Stored Assemblies, Rods per Assembly, Rod Diameter, Cladding Thickness | as named | rod design → surface, metal mass, flow passage |
| Active Fuel Height, Rack Bottom | `rackHeight`, `rackBottomElevation` | the band uncovery acts over |
| Initial Water Level | `fillLevel` | liquid VOLUME fraction, same as a tank |
| Initial Water Temperature | `fluid.temperature` | the steam pressure follows it (an open pool has no separate pressure) |
| Gas Above the Water | `initialNcg` | air |

Ports: a vent on the rim (N), a drain at the bottom (S), and make-up nozzles
on both sides. Connection elevations are heights above the pool FLOOR, as
for any node.

## Drawing

- **2D (grid)**: a ground-layer component like a building — a square hole
  with a concrete coping, the racks as a grid of assembly cells, water
  colour deepening with how much stands there, a level bar on the rim with
  the top-of-fuel marked on it, and a numeric readout of the level and the
  margin over the fuel. The racks redden as the cladding heats.
- **2.5D**: a front-view concrete box with the water level and the racks
  drawn where the model puts them.

## Approximations (deliberate, and where they bite)

- **One lumped rack.** Like a core, the pool has a single cladding node, so
  a half-uncovered rack has one temperature. Partial uncovery is a wetted
  AREA fraction, not an axial profile: the covered part pins the whole rack
  near saturation until the water is below the fuel entirely.
- **Rod displacement is smeared over the depth.** The node is one prism, so
  the rods' volume is taken out of its cross-section rather than declared as
  a band. Inventory is exact; the level reads a few centimetres low across
  the rack band. (`internalObstructions` would make the level exact but
  would put `node.volume` at odds with the water it actually holds.)
- **No wall node.** A buried pool is surrounded by concrete and soil, not by
  the air the generic outer-wall path would connect it to, so it is
  adiabatic through its walls: all the rack power goes into the water.
- **No fission-product inventory.** The racks oxidise and melt through the
  generic machinery, but they carry no `fissionProducts` block, so a damaged
  pool releases hydrogen and not activity.
