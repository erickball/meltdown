# Grid view

The "2D" view: a top-down tile map in the style of factory-building games,
alongside the 2.5D perspective. Selected from the View panel (2D / 2.5D);
the choice is remembered in `meltdown_settings`. It replaced the original
flat plan view, whose code was removed from PlantCanvas (internally the mode
is still called `grid`).

Nothing about a plant changes when it is viewed on the grid. World
coordinates stay in metres; the grid is a 1 m lattice laid over them. What
the grid view adds is where new things snap to and how the pipes between
them are drawn.

## Model

| Concept | Rule | Where |
|---|---|---|
| Tile | 1 m square (`TILE_M`). Cell (i, j) covers [i, i+1) × [j, j+1); pipe routes run through cell centres. | `grid-geometry.ts` |
| Footprint | Whole tiles, w × d, centred on `position`. Upright cylinders are square (d = w); pumps, valves and controllers are 1 × 1; front-view drawings (turbine, condenser, horizontal HX) take the smaller of their two drawn dimensions as depth; buildings and switchyards are plan-native. | `componentFootprint` |
| Snapping | Odd footprints centre on a cell, even ones on a lattice corner, so edges always land on tile lines. Applied to placement clicks and to moves. | `snapCenter`, `PlantCanvas.snapPlacementPosition` / `snapComponentPosition` |
| Port anchor | Each port anchors on the midpoint of one footprint edge cell and faces that side. Side comes from the port's front-view position: lateral ports go E/W, a port on top of the drawing leaves from the back (N), one on the bottom from the front (S). Two ports landing on the same edge cell are spread along the edge. For a connection, an E/W nozzle of an upright cylinder (tank, vessel, reactor vessel, core barrel) is mirrored to the edge facing its partner, as the 2.5D view draws it; otherwise a cold leg stored on the "left" of a vessel whose partner sits to the right would loop all the way round. | `portAnchors`, `portAnchorFacing` |
| Route | Orthogonal polyline from anchor to anchor. Leaves and enters through the "out" cell half a tile outside the edge, so a pipe always exits the component straight before bending. Between the out-cells an automatic route is found by an A* search over cells with a bend penalty, where cells inside the footprint of standing equipment cost extra (pipes are runs, buildings are floors, so neither is an obstacle). The cost is finite, so a port inside a footprint still routes out through the wall. Routes are cached in `GridView` and recomputed only when their ends or the obstacle set move. | `autoRoute`, `searchRoute`, `routeObstacles`, `completeRoute` |
| Lanes | Runs that share a corridor are drawn side by side: every straight segment gets one lane along its whole length (so a run does not wobble cell to cell), overlapping segments on the same line form a group, and the group's lanes are spread across the tile, compressing to fit when the corridor is full. Ends stay on their anchors with a short jog onto the lane. Display only - the stored geometry, lengths and hit tests use the laned polylines only for drawing and clicking. | `laneOffsetRoutes` |
| Stored route | `Connection.route` / `PipeComponent.route`: the polyline the user drew. Rendering only; the physical `length` lives where it always did (the dialog is seeded with the drawn plan length plus the rise between the two ports). Absent = auto-routed with one bend. | `types.ts` |
| Re-anchoring | A stored route whose ends no longer sit on the anchors (component edited, pump re-oriented) keeps its interior and re-lays the legs into each port at draw time. A component moved by dragging in grid view drops the routes touching it instead, because the old interior would be dragged along. | `reanchorRoute`, `PlantCanvas.rerouteConnectionsOf` |

## Drawing

Layers, back to front (`GridView.render`):

1. Ground: a repeating texture anchored to the world lattice, then tile lines
   (clear in construction mode, all but invisible while simulating).
2. Buildings in plan (concrete floor, thick wall, label) and switchyards.
   A building is hit-tested on its wall ring only, so clicks inside reach the
   equipment.
3. Foundation pads under every standing component, with a bevel and shadow.
4. Pipes: pipe components and connections as routed runs (laned where they
   share a corridor) with a dark wall, a fluid-coloured body (the same
   donor-node colour logic as the other views), a sheen, elbows at bends and
   flanges at the ends. Runs inside a container's section view (below) are
   drawn later, on the container's sprite; openings into a container that is
   not a sprite (a building, a pool) are not drawn.
5. Sprites: the component's existing front-view drawing standing on its pad,
   rising north from the south edge of the footprint, painter-sorted by south
   edge and containment. A sprite standing on the plan sits on its pad
   whatever its elevation (the elevation is a label). Small fittings are
   drawn no smaller than 0.8 tile so a valve is visible. Right after each
   container's sprite come the runs inside its section view, then (by the
   containment sort) the sprites of what it holds.
6. Controller wires and generator lines, connection points (connect mode),
   the pipe being laid, and the placement preview.

The shared overlays (gauges, thermometers, flow arrows, burst symbols, break
lines, elevation nudge arrows) draw on top through the same callbacks the
2.5D view uses; `scale` is px-per-metre / 50 so the readout size law is
unchanged.

### Section views

A standing sprite is a front elevation drawn on a plan footprint, so within
that drawing screen-y is height. The grid uses that in one rule: **a
container's sprite is a section view; the tile lattice is a plan view.**

- A component contained by a sprite (a core barrel in a vessel, the bundle
  and circulators in the Xe-100 SG vessel) is drawn ON the container's
  sprite at the container's scale, offset laterally by its plan offset and
  vertically by its elevation above the container's. No pad, no elevation
  label. A section has no depth axis, so two contained things at the same
  x but different plan y overlap, as they would on a real section drawing.
  Buildings, pools and the other ground-layer things are floors, not
  frames: what they hold stands on the plan as before. Nested containers
  resolve to the nearest sprite ancestor (`sectionFrameOf`); the outermost
  one is the "root" the lattice sees (`sectionRootOf`).
- A connection whose two ends share a root is drawn in that section view
  only: an orthogonal run between the two ports' positions on the sprite.
  That includes openings between a component and its own container.
- A connection that leaves a container is split at the wall. Outside, an
  ordinary lattice route from the partner to a `wallAnchor` on the
  container's footprint edge facing the partner (the same rule mirrored
  vessel nozzles use). Inside, a run from the port to the penetration at the
  outside end's port height, across to the sprite's edge, then down the wall
  to the plan anchor where the lattice route picks it up - so a circulator
  under the SG dome is seen discharging down the vessel to the cross-vessel.
  The rise from plan anchor to penetration is the seam between the two
  frames; it reads as an external pipe climbing to its nozzle.
- The ports of a contained component are drawn and picked on the sprite
  (`drawnPorts`); a route laid from one starts at the root's wall
  (`PortHit.frameRoot`, `anchor` = the wall anchor), on the side the port
  itself faces. The container's own port markers stay plan anchors on its
  footprint edge, since that is where an outside pipe is laid to.
- Section runs are screen polylines rebuilt with the layout each frame
  (`RouteLayout.sections` by root, `sectionParts` by connection); hit tests,
  the selected-run label and the flow arrows read them.

Checked headlessly by `scripts/test-grid-sections.ts` on the Xe-100 plant
layout.

### Textures

`grid-art.ts` builds each surface (ground, concrete, pad) as a repeating tile
pattern regenerated per integer zoom, so pixels never scale. Two sources:

- `public/art/<surface>.png`, if listed in `public/art/manifest.json`. Each
  image covers 8 × 8 tiles seen straight down and must tile seamlessly.
  `scripts/gen-grid-art.mjs` generates them with Google's image models
  (Imagen by default; `--model gemini-2.5-flash-image` for the Gemini image
  model) given `GEMINI_API_KEY`, and maintains the manifest. Without a key it
  prints the prompts for use by hand.
- Otherwise the procedural texture drawn in code (seeded, so it is the same
  every time).

The manifest exists so a plant with no generated art makes one small request
rather than a 404 per surface.

## Interaction

Camera: drag or arrow keys to pan, wheel to zoom about the cursor, the Zoom
slider and +/- buttons as in 2.5D (1 = 24 px/m), edge-scroll if enabled.
Entering the view or loading a plant fits the whole plant on screen.

Placing: the preview shows the snapped footprint and its size in tiles, amber
when it overlaps another footprint (informational; containers still accept
things inside them).

Connecting (Connect mode, `PlantCanvas.handleGridPointerDown`):

- Press on a connection point and sweep: pipe is laid cell by cell, straight
  on before bending, and dragging back along the last leg shortens it. The
  sweep never re-enters the source footprint. Release on another component's
  point to finish; release on open ground and the pipe waits.
- Or click a point, click waypoints on open ground, click the finishing point.
  The dashed rubber band always shows where the pipe would go, and finishes
  with a running length.
- Esc, right-click, or leaving Connect mode abandons the pipe.
- A release at the press point is a click, never a finish: a legacy pipe's end
  can sit exactly on the nozzle it feeds, and a click on one must not land on
  the other. Where points coincide, an unconnected one is preferred.

Finishing opens the usual connection dialog with the drawn length; the
resulting connection (or auto-created pipe) carries the route.

Moving: components snap to the lattice; a pipe with a drawn route moves as one
piece and its route with it.

### The pipe tool

Selecting pipe from the palette (or from a supply yard's pipe line) arms the
**pipe tool**, which on the grid is connection mode and ground-pipe placement
at once - on the grid those are one job:

- A press on a **connection point** starts a run to another port, exactly as
  the Connect tool does, and finishes in the connection dialog.
- A press **anywhere else** lays pipe on the ground there. A bare click drops
  one section, one tile long, in the tool's current rotation; a press-sweep-
  release lays the whole swept path as ONE pipe component along the route
  drawn. (One component per gesture, not one per tile: a pipe component is a
  flow node, and a tile-per-node run would put fifty nodes where the player
  drew one line.)
- **R**, and the on-screen Rotate button, turn the section between east-west
  and north-south. The preview draws the actual polyline the placement will
  build (`pipePieceRoute`), so preview and placed piece coincide exactly.
- While the tool is armed a drag on the canvas lays pipe rather than panning.
  Click the palette button again (or pick another tool) to disarm it.

A ground pipe's route ENDS are carried half a tile past the terminal cell
centres, out to the tile boundary, so a piece fills its tile. That is what
makes ground pipe connectable without a tolerance: the end of one section
lands on exactly the point the next section's end lands on, and on exactly the
point a component's port anchors to on that footprint edge.

**Free ends that touch connect themselves.** When a run is laid, each of its
loose ends is joined to another pipe's loose end at the same point facing back
at it, or to a free component port anchored there whose face is turned towards
it (`findFreeEndJoins`). Exact coincidence only - a tolerance would let a run
grab a nozzle it merely passes near. A newly laid run that lands on something
takes that thing's fluid conditions as its initial state, so splicing a
section into a hot loop is not a step change nobody asked for.

Two sections meeting at a CORNER do not join: their ends are on different tile
edges and genuinely do not touch. Draw the corner as one sweep instead.

### What pipe costs

| Gesture | Charged |
|---|---|
| Ground pipe (click or sweep) | its own route length, once, off `pipeMeters`, through the same `createComponent` path as any other part |
| An end joining another end or a nozzle | nothing - the join is a zero-length connection, because the ends are touching and there is no pipe between them |
| A run drawn port to port | unchanged: the length the connection dialog confirms (or, with "create pipe", the auto-pipe's own length, once) |
| Deleting any of it | the same amount back on the racks |

So nothing is charged twice, and `ConstructionManager.layGroundPipe` is the
one place that says so.

### Removing pipe

- A click on a run selects it (halo + label); a second click opens the edit
  dialog, which carries a **Delete Pipe** button.
- **Delete** removes what is selected - a run first, then a component.
- Deleting a component with pipe on it asks a question rather than warning:
  *Delete all* / *Keep pipes* / *Cancel* (D / K / C or Escape, with the
  focused button on Enter). **Keep pipes** leaves each attached run standing
  as ground pipe along the very route it was drawn along, still attached at
  its far end and with a free end where the component was; the ledger nets to
  zero because the run's metres come back and the pipe that replaces it costs
  exactly the same. A run that has nothing at its far end to stay attached to
  (the far end goes with the same deletion, the line runs to open air, it is
  an opening into the vessel the component sits inside) cannot be left
  standing, and the dialog says so instead of quietly doing less than it
  offered. A connection with NO length is not a run at all - it is two things
  touching - so only the joint goes and the section butted onto the component
  stays where it is.

All of this works in construction mode and, through the live-edit path, while
the plant is running.


Selecting a pipe run: a click on a connection's run (where no component is
hit) selects it - halo plus a label with its ends, bore and length, and
while simulating the mass flow and phase. Clicking the selected run again
while building opens the connection edit dialog. Connections have no id, so
the selection is the connection object itself and lapses when the plant is
replaced.

## Not done yet

- Rotation of anything but a ground pipe section. Equipment footprints are
  never rotated; a component's `rotation` is ignored on the grid (it is
  effectively unused for anything but legacy pipes elsewhere too). The pipe
  tool's N/S - E/W rotation is a property of the piece being drawn, not a
  stored `rotation` on the pipe: the route already says which way it lies.
- Elevation is shown by lifting the sprite and a label, but the pipe runs
  themselves have no elevation profile on the grid.
- Preset plants were laid out for the 2.5D camera and overlap on the grid in
  places; they are drawn where they are, with auto-routed pipes.
- Sprite art: the sprites are the vector front-view drawings. Generated
  sprites would need to carry the live state (fill level, fluid colour,
  temperature) those drawings show, so the art pipeline currently covers
  ground surfaces only.
