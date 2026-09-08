# Warehouse and parts stock

A **warehouse** is a non-hydraulic component that holds the plant's parts
list. Its purpose is the level ladder: a level can hand the player a *finite*
supply of pipe and equipment, and that supply is visible on the map as stacks
that shrink instead of a number buried in a menu.

## The equipment dialog for the yard

`componentDefinitions['warehouse']` has name/width/depth, `stockPipeMeters`,
`stockPipeSpec` (a select over `PIPE_SPECS`, plus "Any size"), and
`stockLines` - a dialog option TYPE of its own, rendered as a repeatable list
of `[part] [count] [x]` rows with an "Add a part" button. The part dropdown
offers every generic type first, then every equipment design grouped by the
form that builds it. The rows write through to a hidden input carrying the
array as JSON (`dataset.jsonList`, the same trick the NCG panel uses), so the
dialog submits the very shape the model stores and the round-trip audit
compares like with like.

`parseStockLines` in `component-properties.ts` is the one normalizer: it
throws on a line with no type or a negative count, drops the design when it is
blank, and merges two rows naming the same part (a list is not a ledger; two
lines of one design would split its refunds).

## The rules, in one place

Everything lives in `src/game/stock.ts`. Every path that can spend or refund
a part goes through it:

| Path | Where it calls stock.ts |
|---|---|
| placing a component (construction mode **and** live edits) | `ConstructionManager.createComponent` |
| completing a route / confirming the connection dialog | `ConstructionManager.createConnection` |
| a connection big enough to become a pipe component | `ConstructionManager.createConnectionWithPipe` |
| Delete button and the Delete key | `ConstructionManager.deleteComponent` |
| deleting a connection | `ConstructionManager.deleteConnection` |
| editing a connection's length | `applyConnectionLengthEdit`, from `main.ts` |

The model:

- **No warehouse means unlimited.** `getStock(plant)` returns `null` and every
  check passes. Every design that existed before this feature is that plant,
  and nothing about building in one changed.
- **Stock is a list of LINES**, not a count per type. A line is
  `{ type, design?, count }`: a stored ComponentType, optionally an equipment
  DESIGN (a preset id from `src/construction/component-presets.ts`), and how
  many are standing in the yard. `2 x Low-Pressure Service Water Pump` is a
  different pile from `2 x Reactor Coolant Pump`, and a line with **no**
  design is generic - any design of that type comes off it, which is what
  every yard held before designs existed.
- **A design line hands out that design and nothing else.** Placing from one
  opens the placement dialog with the design stated and every field locked but
  the name and the elevation: the part is already built and standing in the
  yard, so there is no design left to choose. The design id rides onto the
  component (`component.design`), which is what makes the refund go back to
  the line the part came out of and what the info panel names.
- **Placing** takes 1 from the line the button came from. Refused when that
  line's count is 0 or the line is absent (they are the same thing) - and the
  refusal names the design, not just the type.
- **Pipe is measured, not counted.** A connection and a pipe component are the
  same commodity: each costs its own `length` out of `stock.pipeMeters`.
  Editing a connection's length pays or refunds the difference. When the yard
  names a `pipeSpec` (a `PIPE_SPECS` id), that is the ONE line size it hands
  out: the connection dialog shows it fixed and locks the bore and rating, so
  only the route and the length are the builder's.
- **Deleting refunds** exactly what was charged. A component refunds one of
  ITS line - the design it carries, or the generic line for its type when it
  carries none - plus every connection that went away with it.
  Sub-components that came free with a parent (a reactor vessel's core barrel)
  are not refunded, because they were never charged.
- **Putting up a warehouse costs nothing.** Otherwise the first thing a level
  had to give the player would be a warehouse.
- **What is already standing is not charged.** The stock is simply what is
  left; there is no attempt to reconstruct how the plant got there.
- **Nothing is clamped.** A charge that cannot be paid is *refused*, with the
  shortfall in the message. `spend()` throws if asked to pay a charge that
  `checkCharge()` would have refused, so a negative pile is impossible rather
  than merely unlikely.

Career mode keeps its money model unchanged; stock applies on top whenever a
warehouse exists.

## Stock lines are keyed by stored ComponentType, then design

A line's `type` is the type the plant *stores*, not the palette button.
`PALETTE_TO_STORED` in `stock.ts` is the map, and
`ConstructionManager.createComponent` throws if the type it charged is not the
type it actually built - so the map cannot silently drift.

Two consequences worth knowing, both signposted in the dialog help text:

- all four valve buttons (gate, check, relief, PORV) draw on the one `valve`
  pile, because the model stores them all as valves;
- a **pressurizer is a tank**, so it comes out of the `tank` pile. The
  `vessel` pile is standalone reactor cores.

A line that names a design goes the other way as well:
`paletteKeyForStockLine` reads the design's own `type` to decide which
placement form to open (so a line of check valves opens the check-valve form,
not the gate-valve one) and **throws** if that disagrees with the line's
stored type, or if the design id is unknown. A level naming a design that has
been renamed fails at the yard rather than quietly building a generic part.

### Why a freely-picked design is NOT stamped on the component

`ComponentConfig.design` is set only for a yard placement. The design dropdown
in an ordinary placement is a *starting point* - the player may edit any field
afterwards, and the dialog says so with its "modified from the selected
design" note - so recording the id would be a claim the component cannot keep.
It would also unbalance the ledger: the placement was charged to the generic
pile, and a refund keyed on the stamped design would go to a different line.
In the locked yard form nothing can be edited, so the id is truthful.

## What the player sees

- **The palette IS the yard.** When a warehouse exists, the component palette
  grows a `Supply Yard` group holding one button per stock LINE - "Low-Pressure
  Service Water Pump ×2", "Service water line — 12″ (0.3 m), 16 bar 300 m" -
  and the generic type buttons stand down (all but Warehouse, which costs
  nothing out of the yard it edits). The level's "suggested parts" filter
  toggle stands down too: there is no wider catalog to show. With no warehouse
  the group is hidden and the palette is exactly what it always was.
- **Toolbar badges.** Each build button shows what is left (`×2`, or `412 m` on
  the pipe button and the Connect tool). An empty pile greys the button with
  `.tool-unavailable` - deliberately not the `disabled` attribute, which eats
  the tooltip that explains why - and clicking it repeats the reason as a
  notification instead of opening a dialog that could not be confirmed.
- **Placement dialog.** A yard part shows a "From the Supply Yard" plate with
  the design's name and description; every field but the name and the
  elevation is disabled, with `YARD_FIXED_DESIGN_TOOLTIP` on each form group
  saying why. The values still submit (a disabled input keeps its `.value`),
  so the component is built to the yard's design exactly.
- **Connection dialog.** `Pipe in stock: N m` sits under the length field, and
  when the yard names a line size the Line Specification dropdown shows it,
  disabled, with "From the supply yard - this is the pipe you have."  The
  same lock applies when EDITING a run, so an existing line cannot be
  re-specified into a bigger bore for free.
- **Selected-component panel.** A selected warehouse lists its pipe metres, its
  line size and a row per stock line, named by design. Any component built
  from a design shows a `Design:` row.
- **The yard itself.** In the 2D grid view the warehouse draws as an
  open-sided shed on an apron with racks of pipe sticks on the left and crates
  (pumps get their own silhouette) on the right, and one labelled line per
  stack underneath - the design's name, not the generic type.
  One drawn stick is `PIPE_METRES_PER_STICK` = 20 m and one crate is one part,
  so the piles visibly run down as the player builds. The 2.5D view draws the
  same shed in front view with the pipe bundle seen end-on.

## Persistence

`stock` is an ordinary component field, so it rides along in
`serializePlantState` / `deserializePlantState`, in presets, and in plant
fixtures with no extra code.

It **is** listed in `VOLATILE_COMPONENT_KEYS` (`src/simulation/resume.ts`):
the stock changes on every build, and the factory never reads it (a warehouse
has no flow node, thermal node or port), so counting it would mark the
warehouse "edited" on every single placement. Harmless today - there is
nothing of a warehouse to re-initialize - but exactly the sort of false
"this component changed" the transplant guard exists to avoid.

## Known simplifications

- **Deleting refunds a part even if the warehouse never stocked that line.**
  The refund creates the line. The player salvages what they tear down; the
  alternative would be a history of what was built with which parts, which the
  plant does not keep.
- **A yard saved before designs existed** carried `components` as an object of
  type -> count. `getStock` converts it once, in place, to generic lines and
  says so loudly in the console. There is no other reader of the old shape.
- **The stacks are capped by the drawn area.** A yard holding more sticks or
  crates than the racks can draw fills the racks; the numeric labels beside
  the drawing carry the exact figures. `PIPE_METRES_PER_STICK` is a drawing
  scale only - nothing in the rules is quantised to it.
- **One warehouse per plant.** `findWarehouse` takes the first one; a second
  yard is drawn and priced but never spent from.
- **A charge is spent at the end of a successful build**, so a component whose
  creation throws part-way through costs nothing. A refusal is checked as late
  as the length is knowable, though, which is after two cosmetic side effects
  have already happened: `createConnectionWithPipe` may have re-oriented a pump
  toward its new partner, and a cross-vessel annulus connection has already
  moved the cross-vessel (that one always costs zero metres, so it can never
  actually be refused). Neither changes the physics of the existing plant.
- **The warehouse has no capacity**, no delivery time, and no cost for what it
  holds. The parts are priced when they are placed, as they always were.

## Tests

- `scripts/test-stock.ts` (in `npm test`): unlimited without a warehouse,
  pre-existing components not charged, place/refuse/refund, the 60 m + 50 m
  shortfall case, length edits up and down, the auto-pipe charged once, a
  save/load round trip, that spending past a refusal throws, and the design
  lines - placing off a design line, refusing the wrong design while pumps are
  in stock, refunding to the right line, generic and design lines of the same
  type staying separate, salvage onto a line the yard never held, and an old
  type-keyed save migrating to generic lines.
- `scripts/check-dialog-sync.ts` includes `warehouse`, so the pipe metres, the
  line size and the whole `stockLines` list must round-trip through
  `updateComponent` / `readComponentOption`.
- `scripts/test-plants/pool-level1.json` carries a yard with 400 m of 12-inch
  service water pipe, 2 low-pressure service water pumps and 1 service water
  valve, exercised by `scripts/test-plant-scenarios.ts`.
- `scripts/test-game-levels.ts` (`sfp`) reads the level's yard and measures the
  design it actually stocks: check `[0]` asserts the lines name designs and a
  pipe spec, and checks `[2]`/`[3]` build the pump FROM the preset, so the
  numbers reported are the design's own.
