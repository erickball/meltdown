# Building takes time

`src/game/build-queue.ts`. Regression test: `scripts/test-build-queue.ts`
(in `npm test`).

Placing a part while the plant runs used to be instantaneous: click through
two dialogs and a pump was already delivering. That made an emergency a
typing test rather than a decision — the answer to "the pool is draining" was
to build the whole make-up train in the couple of seconds the dialogs took.

A part now stands on the map as a **ghost** for as long as it would really
take to install, and joins the simulation only when its timer runs out.
Taking a part back to the yard is the same job in reverse.

## The law

One rate, in both directions, for everything:

```
seconds = massKg × SECONDS_PER_KG
```

`SECONDS_PER_KG` is not a number anybody picked. It is anchored on the pipe
the player lays most — the level-1 supply yard's service-water line,
`spec-12in-service` (0.3 m bore, 16 bar) — and on the statement that **one
grid segment of that pipe should take about 0.1 s of wall clock**:

| | |
|---|---|
| ASME wall for 0.3 m at 16 bar | 1.8 mm → the 3 mm handling minimum |
| steel mass, +20% for elbows/tees/flanges | **26.90 kg/m** |
| one grid segment | 1 m (`TILE_M`) |
| **SECONDS_PER_KG** | `0.1 / 26.90` = **3.717e-3 s/kg** |
| equivalently | **269 kg installed per second** |

The mass per metre comes from `pipeSteelMassPerMetre` in
`src/construction/cost-estimation.ts` — the *same* arithmetic the cost
estimate uses, exported rather than copied, so the two can never drift.

Everything else follows from its own installed mass
(`componentBuildMassKg`), which is an ordinary engineering estimate from the
component's stored geometry and rating: an ASME-wall shell for anything that
holds pressure, a duty power law for the rotating machines (whose mass is set
by what they do, not by how big they are drawn), and concrete volume for the
civil works. None of them is tuned to produce a particular build time.

What that gives, at the level-1 scale:

| part | mass | build |
|---|---|---|
| 1 m of 12″ service water | 26.9 kg | 0.10 s |
| the yard's 300 m of it | 8.1 t | 30 s |
| a 40 m run | 1.1 t | 4.0 s |
| Low-Pressure Service Water Pump (200 kg/s, 60 m) | 2.53 t | 9.4 s |
| a 0.3 m gate valve at 16 bar | 0.22 t | 0.8 s |
| an 8 x 8 m, 10 bar tank | 120 t | 7.4 min |
| level 1's 9 x 9 x 10.5 m concrete pool | 1650 t | 1 h 42 min |

**Wall clock, not simulated time.** A level runs at 60x, so a minute of
building would be an hour of the accident; the delay is meant to cost the
*player* time to think, not to cost the plant an hour. The queue is ticked
from `GameLoop.onWallFrame`, which hands it the frame's real interval and is
skipped while paused — so pausing stops the builders along with the plant.

## What a ghost is

A part under construction is a real entry in `plantState` (so it can be
drawn, hovered, selected and cancelled) carrying `underConstruction: true`.
The one thing it is not is *plant*:

- `createSimulationFromPlant` filters through `withoutUnbuiltParts`
  (`src/simulation/factory.ts`), which drops every `underConstruction`
  component and every connection that is one or lands on one. Filtering once,
  at the entry point, is what keeps the rest of the factory from having to
  know that unfinished parts exist. The component objects themselves are not
  copied, so everything the factory stamps back on a component still lands on
  the real object.
- `underConstruction`, `pendingRemoval` and `buildProgress` are in
  `VOLATILE_COMPONENT_KEYS` (`src/simulation/resume.ts`) and connections are
  now stringified with `stripVolatile` too. `buildProgress` moves every frame
  and `pendingRemoval` sits on a part that is still running normally, so
  counting either would re-initialize a live component the moment anything
  else was edited.
- Both views draw a ghost as itself at `GHOST_ALPHA` (0.42) with a progress
  ring over it — cyan for a build, amber for a return
  (`drawBuildProgress`). Nothing about the sprite changes, so the player sees
  what they are going to get, only fainter.

A part being **returned** carries `pendingRemoval` instead. It keeps running
until its timer is up — you are watching it be disconnected, not watching it
vanish — and only then is it deleted and refunded.

## The transaction

The queue owns the clock and nothing else. Every job carries two callbacks,
each handed an `apply()` that clears the ghost marks, so the caller decides
what transaction they happen inside:

```ts
finish:  (apply) => liveEdit(`Building ${label}`, apply)
abandon: (apply) => { apply(); constructionManager.deleteComponent(id); }
```

That is what makes the part join the running simulation **exactly once**, in
one live edit, at the moment the timer fires — rather than being mutated in
one place and rebuilt in another.

Money and parts follow the same rule as before, because the same functions do
it: `ConstructionManager.createComponent` charges the yard when the part is
placed (start of build) and `deleteComponent` refunds it when the part is
removed (end of return, or immediately on a cancel). Nothing in the queue
knows about stock.

| | |
|---|---|
| build starts | charged, ghost appears, not simulated |
| build completes | live edit inserts it; charged once, in total |
| build cancelled | deleted and refunded **immediately** |
| return starts | marked, still running, not yet refunded |
| return completes | live edit removes it, refunded |
| return cancelled | mark cleared, nothing else happens |

Deleting a part that is still under construction **cancels** it rather than
queueing a return — there is nothing installed to take out.

## Where it plugs into main.ts

The UI path is unchanged up to the point where a placement used to commit.
`beginLiveEdit()` still opens the gesture and the construction manager still
makes the plant change; then `queueNewParts()` diffs the plant
(`capturePlantParts` / `newPartsSince`), abandons the snapshot instead of
committing it, and enqueues the job. `removeComponentPart()` and
`removeConnectionPart()` are the same idea for deletions and are what the
Delete key, the delete button and the connection delete callback all call.

`buildsAreTimed()` gates the whole thing: **construction mode builds are
still instant** (the plant is stopped and there is nothing to be late for),
as are builds in a plant with no simulation. Entering construction mode calls
`buildQueue.finishAll()` — the outstanding work happens during the outage, so
nothing is left half-installed on a map the player is about to rebuild. A new
plant clears the queue.

## Open

- The queue has no UI of its own: progress is the ring on the part, plus the
  notification when a job is taken and when it lands. There is no list of
  outstanding jobs and no explicit cancel button — cancelling is deleting the
  ghost.
- Civil works priced by their concrete are hours of work under this law (the
  level's own pool is 1 h 42 min), and even a large tank is minutes. That is
  arguably right, and it never bites in practice because those are placed in
  construction mode, where builds are instant - but nothing stops a player
  from trying it live, and there is no warning if they do.
- Jobs run in parallel, with no crew limit: five parts placed at once all
  finish on their own timers. A single-crew queue would be a different (and
  arguably better) game.
- `finishAll()` on a mode switch runs each job's `finish` in turn, which is
  one live edit per job. That is fine at the numbers involved but is O(jobs)
  rebuilds.
