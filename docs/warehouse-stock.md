# Warehouse and parts stock

A **warehouse** is a non-hydraulic component that holds the plant's parts
list. Its purpose is the level ladder: a level can hand the player a *finite*
supply of pipe and equipment, and that supply is visible on the map as stacks
that shrink instead of a number buried in a menu.

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
- **Placing** a component of stored type `T` takes 1 from `stock.components[T]`.
  Refused when the count is 0 or the type is absent (they are the same thing).
- **Pipe is measured, not counted.** A connection and a pipe component are the
  same commodity: each costs its own `length` out of `stock.pipeMeters`.
  Editing a connection's length pays or refunds the difference.
- **Deleting refunds** exactly what was charged. A component refunds one of its
  own type (or its length, for a pipe), plus every connection that went away
  with it. Sub-components that came free with a parent (a reactor vessel's core
  barrel) are not refunded, because they were never charged.
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

## Stock keys are stored ComponentTypes

`stock.components` is keyed by the type the plant *stores*, not by the palette
button. `PALETTE_TO_STORED` in `stock.ts` is the map, and
`ConstructionManager.createComponent` throws if the type it charged is not the
type it actually built - so the map cannot silently drift.

Two consequences worth knowing, both signposted in the dialog help text:

- all four valve buttons (gate, check, relief, PORV) draw on the one `valve`
  pile, because the model stores them all as valves;
- a **pressurizer is a tank**, so it comes out of the `tank` pile. The
  `vessel` pile is standalone reactor cores.

## What the player sees

- **Toolbar badges.** Each build button shows what is left (`×2`, or `412 m` on
  the Pipe button and the Connect tool). An empty pile greys the button with
  `.tool-unavailable` - deliberately not the `disabled` attribute, which eats
  the tooltip that explains why - and clicking it repeats the reason as a
  notification instead of opening a dialog that could not be confirmed.
- **Connection dialog.** `Pipe in stock: N m` sits under the length field.
- **Selected-component panel.** A selected warehouse lists its pipe metres and
  a row per stocked type.
- **The yard itself.** In the 2D grid view the warehouse draws as an
  open-sided shed on an apron with racks of pipe sticks on the left and crates
  (pumps get their own silhouette) on the right, and the numbers underneath.
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

- **Deleting refunds a part even if the warehouse never stocked that type.**
  The player salvages what they tear down. The alternative would be a history
  of what was built with which parts, which the plant does not keep.
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
  save/load round trip, and that spending past a refusal throws.
- `scripts/check-dialog-sync.ts` includes `warehouse`, so every stock field in
  the dialog must round-trip through `updateComponent` / `readComponentOption`.
- `scripts/test-plants/pool-level1.json` carries a yard with 400 m of pipe,
  2 pumps and 1 valve, exercised by `scripts/test-plant-scenarios.ts`.
