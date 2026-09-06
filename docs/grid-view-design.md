# Grid view

A third way of looking at (and building) a plant, alongside the flat 2D plan
and the 2.5D perspective: a top-down tile map in the style of
factory-building games. Selected from the View panel (2D / 2.5D / Grid); the
choice is remembered in `meltdown_settings`.

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
| Port anchor | Each port anchors on the midpoint of one footprint edge cell and faces that side. Side comes from the port's front-view position: lateral ports go E/W, a port on top of the drawing leaves from the back (N), one on the bottom from the front (S). Two ports landing on the same edge cell are spread along the edge. | `portAnchors` |
| Route | Orthogonal polyline from anchor to anchor. Leaves and enters through the "out" cell half a tile outside the edge, so a pipe always exits the component straight before bending. | `autoRoute`, `completeRoute` |
| Stored route | `Connection.route` / `PipeComponent.route`: the polyline the user drew. Rendering only; the physical `length` lives where it always did (the dialog is seeded with the drawn plan length plus the rise between the two ports). Absent = auto-routed with one bend. | `types.ts` |
| Re-anchoring | A stored route whose ends no longer sit on the anchors (component edited, pump re-oriented) keeps its interior and re-lays the legs into each port at draw time. A component moved by dragging in grid view drops the routes touching it instead, because the old interior would be dragged along. | `reanchorRoute`, `PlantCanvas.rerouteConnectionsOf` |

## Drawing

Layers, back to front (`GridView.render`):

1. Ground: a repeating texture anchored to the world lattice, then tile lines
   (stronger in construction mode).
2. Buildings in plan (concrete floor, thick wall, label) and switchyards.
   A building is hit-tested on its wall ring only, so clicks inside reach the
   equipment.
3. Foundation pads under every standing component, with a bevel and shadow.
4. Pipes: pipe components and connections as routed runs with a dark wall, a
   fluid-coloured body (the same donor-node colour logic as the other views),
   a sheen, elbows at bends and flanges at the ends. Openings between a
   component and its container are internal and are not drawn.
5. Sprites: the component's existing front-view drawing standing on its pad,
   rising north from the south edge of the footprint, painter-sorted by south
   edge and containment. Raised components float on columns above the pad
   with a cast shadow; sunken ones are shaded with soil. Small fittings are
   drawn no smaller than 0.8 tile so a valve is visible.
6. Controller wires and generator lines, connection points (connect mode),
   the pipe being laid, and the placement preview.

The shared overlays (gauges, thermometers, flow arrows, burst symbols, break
lines, elevation nudge arrows) draw on top through the same callbacks the
2.5D view uses; `scale` is px-per-metre / 50 so the readout size law is
unchanged.

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

## Not done yet

- Rotation. Footprints are never rotated; a component's `rotation` is
  ignored on the grid (it is effectively unused for anything but legacy
  pipes elsewhere too).
- Elevation is shown by lifting the sprite and a label, but the pipe runs
  themselves have no elevation profile on the grid.
- Preset plants were laid out for the 2.5D camera and overlap on the grid in
  places; they are drawn where they are, with auto-routed pipes.
- Sprite art: the sprites are the vector front-view drawings. Generated
  sprites would need to carry the live state (fill level, fluid colour,
  temperature) those drawings show, so the art pipeline currently covers
  ground surfaces only.
