# Level 1: HOT AND DRY (the spent fuel pool)

The first career level. No reactor, no turbine, no money: a spent fuel pool on
a bench above the sea, an earthquake that cracks its liner, and six hours to
keep the fuel under water with what is in the yard.

Files:

| What | Where |
| --- | --- |
| Level definition | `src/game-mode/levels.ts` (`id: 'spent-fuel-pool'`, index 0) |
| Plant + terrain + scenario | `src/game-mode/levels/spent-fuel-pool.json` |
| **Generator (source of truth for the JSON)** | `scripts/gen-spent-fuel-pool.ts` |
| Headless checks | `scripts/test-game-levels.ts` (`npm run test:levels`, key `sfp`) |
| Tuning probe | `scripts/probe-sfp-level.ts` |

Do **not** hand-edit `spent-fuel-pool.json`: the terrain is a 30x16 height
field and every structure's elevation depends on standing on a flat bench.
Edit `scripts/gen-spent-fuel-pool.ts` and re-run `npx tsx
scripts/gen-spent-fuel-pool.ts`.

---

## The map

Terrain: 30 x 16 cells of 10 m (300 x 160 m), heights piecewise linear in x
and constant in y.

| x (m) | ground | what it is |
| --- | --- | --- |
| 20..100, y 40..120 | **+13.0 flat** | the pool bench - pool, crack line, both tanks, the yard |
| elsewhere x <= 110 | +14.0 | plateau rim (the bench's lip) |
| 110..185 | +14.0 -> +2.0 | the hillside |
| 185..215 | +2.0 -> +1.4 | the shore bench |
| 215..232 | +1.4 -> -4.0 | the beach face |
| x >= 232 | -4.0 flat | sea shelf; terrain water body `sea`, surface 0 m |

The bench is **flat on purpose**: component `elevation` is height above local
ground, so a sloping bench would give the pool, its crack valve and the tanks
subtly different datums and a phantom head between them. It is also a **closed
depression**, so water leaving the pool lands on the bench and soaks in there
(default infiltration 1e-4 m/s over ~8100 m2 = ~810 kg/s, more than the leak
ever runs, so no puddle actually stands - see "Tuning knobs").

Two obstacles fall straight out of the ground:

* **Suction lift.** A pump on the bench stands 13.3 m above the sea surface.
  The atmosphere can push water up about 10.3 m before it boils, less the
  pump's NPSH: the intake flashes and it delivers nothing. Measured: **-0.0
  kg/s, suction node two-phase at 0.175 bar.**
* **The tsunami.** The sea goes to +5 m, which is above the whole shore bench
  (+1.4..+2.0), so anything built down there is under water. A flooded pump
  coasts down and cannot restart until the water is gone.

## The plant as it starts

| id | what | numbers |
| --- | --- | --- |
| `pool` | Spent Fuel Pool | 9 x 9 x 10.5 m, sunk to grade; 250 assemblies x 264 rods; **8.0 MW**; 170 t of fuel+clad; racks 0.50..4.16 m above the floor; 660 t of 45 C water at 8.35 m |
| `crack` | Liner Crack (valve, **shut**) | 0.024 m2, 0.4 m up the pool wall over a 0.8 m opening; a 2 m3 node so it is not a water hammer |
| `tank-a` | Demineralised Water Tank | 14 m x 7 m, 78% full = **840 t** at 15 C |
| `tank-b` | Fire Water Tank | 10 m x 6 m, 80% full = **377 t** at 15 C |
| `sea` | The Sea (a tank) | 34 m x 8 m on the -4 m shelf, half full so its surface is 0 m = 11 300 t |
| `yard` | Supply Yard (warehouse) | **300 m of 12-inch service water pipe, 2 Low-Pressure Service Water Pumps, 2 Service Water Isolation valves** - fully specified, see below |

Plus a vent from the pool rim to `atmosphere` (no standing head), and the
crack's own line to `atmosphere`.

Nothing else. No pumps, no make-up line: the player builds all of it, live.

## Timeline

Six sim hours at 60x = **six real minutes**.

| sim t | real t | event |
| --- | --- | --- |
| 0 | 0:00 | Start. Pool 8.35 m, 45 C, warming 2.9 mK/s. Nothing leaking. |
| 2400 | 0:40 | **EARTHQUAKE** - the crack valve opens. Leak starts at ~144 kg/s. |
| 2700 | 0:45 | Tsunami warning (message only). |
| 3600 | 1:00 | **The wave**: sea ramps 0 -> +5 m over 300 s. Shore floods from ~t=3720. |
| 8400 | 2:20 | The sea falls back to 0 over 400 s; the shore is dry again by ~t=8680. |
| 21600 | 6:00 | **Win**, if the fuel is still covered. |

### Unfed (measured, `SFP_ONLY=1`)

| t (s) | pool level (m) | leak (kg/s) | water (C) | clad (C) |
| --- | --- | --- | --- | --- |
| 2700 | 7.79 | 144 | 52.6 | 53.3 |
| 3900 | 5.77 | 123 | 56.9 | 57.5 |
| **5040** | **4.16** | ~105 | ~59 | ~60 | racks uncover
| 6300 | 2.69 | 80 | 70.8 | 71.6 |
| **6240** | | | | | **level goal lost** (1200 s of uncovery)
| 8700 | 0.86 | 37 | 98.6 | 100.7 |
| 10800 | 0.40 | 1 | 99.9 | 205 |

So doing nothing loses at **t = 6240 s (1:44 of real time)**, about a minute
after the quake. Note it is the *level* limit that fires, not the clad limit:
the residual 25 t of water boiling at 100 C holds the clad near 240 C for
hours. The clad limit is the backstop for a genuinely dry pool.

### Fed (measured, `SFP_ONLY=4`: sea pump from t=2410, tank line open 3700..9600)

| t (s) | pool (m) | clad (C) | tanks (t) | shore pump |
| --- | --- | --- | --- | --- |
| 1800 | 8.36 | 51 | 1216 | stopped |
| 3600 | 10.10 | 41 | 1216 | running |
| 5400 | 9.39 | 38 | 1020 | **FLOODED** |
| 7200 | 8.28 | 37 | 832 | **FLOODED** |
| 9000 | 8.08 | 34 | 666 | running again |
| 21600 | 10.4 | 20 | 614 | running |

Minimum level 5.65 m against a 4.16 m rack top, peak clad 52 C, zero seconds
of uncovery, shore pump drowned at t=3720 and restarted at t=8680. The tanks
give up 602 t of their 1217 t: real pressure, real margin.

## Rules

* **`liveBuild: true`** - built while it runs. `liveBuildAllowed()` in main.ts
  is `!gameMode?.active || gameMode.liveBuild`, so the palette, the connect
  tool and the edit section stay up in simulation mode and every change goes
  through `commitLiveEdit` (which stops the clock for the gesture, so opening
  a dialog does not cost the player sim time). Pressing CONSTRUCTION is
  **refused** rather than billed as an outage: `beforeModeSwitch` returns
  false with the reason, and the button wears `.tool-unavailable` with that
  reason as its tooltip.
* **`economy: 'none'`** - no loan, interest, revenue, price or bankruptcy. The
  HUD hides cash/loan/price/MWe (`GameHud.setEconomyVisible`), the
  overnight-cost panel stays down, and BUILD IT becomes **TAKE THE WATCH**,
  which just starts the clock. The limit on building is the warehouse.
* **`simSpeed: 60`, `view: 'grid'`** - set on the level, applied through the
  host (`setSimSpeed`, `setViewMode`). The tile grid is the only view that
  draws terrain.
* **Goal** `{ kind: 'survive', seconds: 21600 }` - a new GoalDef kind: done
  when the level has been *operated* for that much sim time.
* **Hazards** (new `LevelDef.hazards`, a way to lose rather than a goal):
  * `{ kind: 'level', nodeId: 'pool', minMetres: 4.16, graceSeconds: 1200 }` -
    the rack top. Breach must be **continuous**: the clock resets the moment
    the level recovers, so make-up that catches up in time is not punished.
  * `{ kind: 'temperature', nodeId: 'pool-clad', limitC: 600 }` - Zircaloy has
    almost no strength left at 600 C and its steam reaction turns
    self-sustaining not far above 800 C (Baker-Just runs away from ~827 C).
    600 C is the last point at which the fuel is still recoverable.
* Random career events are off (`warmupSeconds: Infinity`, empty pool). All
  the trouble is in the plant's own `scenario` block, on a fixed clock, and
  those events now show in the career HUD ticker and event log as well as the
  usual notification.
* `palette: ['pump', 'pipe', 'valve']`, `maxRelease: 0.01`.

## What the player can do (and what they will find out)

* The tanks stand on the same bench as the pool rim with the pool floor 10.5 m
  below their feet, so **they gravity-feed the pool with no pump at all** -
  their water surface is 5.5 m above the pool rim. That is not a bug, it is
  what the geometry says, and it is the cheapest answer to the wave. It is
  also why an *un-valved* tank line drains 1200 t in about 90 sim-minutes:
  the headless answer key throttles with a valve, and a player who leaves it
  open will watch the yard's water go over the pool rim and out of the vent.
* **The yard's parts are fully specified.** The pump is the
  `pump-service-water-lp` design (200 kg/s at 60 m, 16 bar casing, NPSHr 5 m)
  and the pipe is `spec-12in-service` (0.3 m bore, 16 bar). Placing from the
  yard offers no design choice at all - the palette button IS the design, and
  the placement dialog locks every field but the name and the elevation. See
  [warehouse-stock.md](warehouse-stock.md).
* That pump measures **352 kg/s** from the shore into the pool (check `[3]`)
  against a crack that passes ~144 kg/s at the start and ~100 kg/s near the
  racks: it keeps up with the leak and refills the pool in tens of minutes,
  not instantly. From the bench it delivers **-0.0 kg/s** - the suction lift
  flashes its intake - which is the level's first obstacle, unchanged.
  Before this the palette handed out a 1000 kg/s generic pump, which simply
  pushed tank water out of the vent ten times faster; one of the four HUD
  hints still warns about oversizing.
* The sea is the only lasting source, and reaching it needs a pump *at the
  shore*, which means waiting out the wave. A pump on the bench delivers zero.

## Tuning knobs

Everything below is in `scripts/gen-spent-fuel-pool.ts` unless said otherwise.

| Knob | Now | Effect |
| --- | --- | --- |
| crack `flowArea` | 0.024 m2 | the whole drain schedule. Uncovery time scales ~1/area. |
| `fuelPower` | 8.0 MW | how fast an uncovered rack heats: 170 t of fuel+clad is 5.2e7 J/K, so 8 MW is ~155 K per 1000 s once genuinely dry. |
| `assemblyCount` | 250 | fuel+clad mass, hence that same rate |
| tank `fillLevel` | 0.78 / 0.80 (1217 t) | how long the player can ride the wave. 602 t is what the answer key uses. |
| `QUAKE` / `WAVE_IN` / `WAVE_OUT` / `LEVEL_END` | 2400 / 3600 / 8400 / 21600 s | pacing. The gap `WAVE_OUT + 300 - QUAKE` is what the tanks must cover. |
| `simSpeed` | 60 | six sim hours in six real minutes |
| hazard `graceSeconds` | 1200 s (20 real s at 60x) | how forgiving a dip below the racks is |
| terrain `infiltration` | default 1e-4 m/s | at ~2e-5 the bench would hold a visible puddle instead of drinking the leak - but then a make-up pump standing on the bench would eventually be flooded by it, which is why it is left at the default |

## Measured performance

* Unfed headless run: **140x realtime** over the first 600 s at dt = 0.25 s,
  falling as the crack node stiffens late in the drain (the pool memory note
  predicted this).
* In the browser at 60x the status bar reads a steady 60x (no auto-slow). Asked
  for 100x it achieves **91-95x**, so 60x has comfortable headroom - which is
  the number that matters, since 60x is what the level sets.

## Known gaps

* **No `reference.design`.** The in-game "SHOW ME THE ANSWER" button is not
  wired for this level; the headless check `[4]` is the answer expressed as a
  static plant driven by scenario actions, not as the live edits a player
  makes. Building the real reference fragment is the obvious next job.
* **The sea tank and the terrain sea are two different things.** The tank is
  the inventory a pump draws from; the terrain water body of the same name is
  the flooding surface. The tsunami raises the surface but not the tank's own
  level, so a shore pump does not see the extra suction head the real wave
  would give it. This is a pre-existing limitation of the terrain model ("a
  puddle cannot be pumped from"), not something this level introduced.
* **A pump or a valve run dry against air diverges.** Take a node down to near
  vacuum, let it draw air, and the mixture energy split ends up asking for
  water below the triple point; the bracket collapses and the solver gives up.
  Seen twice while tuning: an unfed pool at t ~ 16.5 ks (2.9 h *after* the
  level is already lost), and a make-up pump left running after its tanks
  emptied. Loud, pre-existing, and outside this level's scope - but a player
  who keeps watching a lost level will hit it.
* The control-rod / boron / SCRAM panel and the "MW to Grid" readout are up
  for a plant with no reactor and no turbine. Harmless, and pre-existing for
  any such sandbox plant, but it is noise on a level aimed at newcomers.
