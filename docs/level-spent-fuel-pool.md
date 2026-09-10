# Level 1: HOT AND DRY (the spent fuel pool)

The first career level. No reactor, no turbine, no money: a spent fuel pool on
a bench above the sea, an earthquake that cracks its liner, and eight hours
to keep the fuel under water with what is in the yard.

**Updated 2026-09-08** - see the section "Uncovery is not the loss" at the end:
the crack is now a scripted burst, the clock is eight hours, running the racks
dry no longer ends the level, and the run-dry divergence is fixed.

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
* **The tsunami.** The sea goes to **+12.6 m**, which is above everything
  except the +13 m bench itself, so a pump anywhere but the bench is under
  water - and the bench is the one place a pump cannot lift the sea from. A
  flooded pump coasts down and cannot restart until the water is gone, which
  here takes minutes, not hours.

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

Eight sim hours at 60x = **eight real minutes**. Re-timed 2026-09-08: the
night's earthquake is what took the power out before the player arrived, and
what happens on watch is the AFTERSHOCK. Everything after it keeps the
intervals it was tuned with (warning +300 s, wave +1200 s), so the gap the
tanks have to cover is unchanged in shape and much shorter in fact.

**The aftershock is timed in WALL seconds** (corrected 2026-09-09): twenty
seconds of the player's own time, which at this level's 60x is `QUAKE = 1200`
simulated seconds. Written as 20 simulated seconds it landed a third of a
second after TAKE THE WATCH and read as instantaneous. `QUAKE` is in simulated
seconds, so it is 20 x `LevelDef.simSpeed`; change the speed and it wants
changing with it. `scripts/test-game-levels.ts sfp` check [0b] pins the wall
number, the two offsets, and that nothing is due at t=0.

**The wave is 54 minutes behind the aftershock** (changed 2026-09-09; it was
20). That gap is the level: it is long enough that the tanks are a real
inventory decision rather than a formality, long enough that a pump built at
the shore before the water arrives is a pump that will be under it, and long
enough to build anything the player wants to build - which matters now that
building costs simulated time (see [[build-queue]]). `WAVE_IN` is written as
`QUAKE + 54*60` and the warning as `WAVE_IN - 900`, so the whole sequence
still moves with the aftershock.

| sim t | real t | event |
| --- | --- | --- |
| 0 | 0:00 | Start. Pool 8.35 m, 45 C, warming 2.9 mK/s. Nothing leaking. |
| **1200** | 0:20 | **AFTERSHOCK** - a scripted burst tears the liner. Leak starts at ~144 kg/s. |
| 3540 | 0:59 | Tsunami warning (message only), a quarter of an hour ahead of the water. |
| **4440** | 1:14 | **The wave**: sea ramps 0 -> +12.6 m over 180 s. The shore (+1.7 m) is under at ~t=4480. |
| 4620 | 1:17 | Peak. Everything below the +13 m bench is under water. |
| 4740 | 1:19 | The sea drains back to 0 over 240 s; the shore is workable again by ~t=4960. |
| 28800 | 8:00 | **Win**, if the fuel is still covered. |

The wave carries floating debris (`src/render/debris-fx.ts`, drawn by the grid
view): logs, drums, crates and a boat, seeded along the water's edge when the
body first stands more than 0.5 m above its own level, each riding at its own
draught so it climbs the slope as the water rises - and stranded where it
grounds when the water goes, which leaves the hillside littered above the old
shoreline. Decoration only; the simulation neither writes it nor reads it.

### Unfed (measured, `SFP_ONLY=1`)

*The two tables below were measured on the OLD clock (quake at 2400 s). The
shape is unchanged; subtract 2380 s for the times as they now stand, and see
the re-measured numbers at the bottom of this document.*

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
| tank `fillLevel` | 0.78 / 0.80 (1217 t) | how long the player can ride out the 54 minutes to the wave and the ten it takes to pass. The answer key draws 474 t of it and finishes with 61% left; shrink the tanks if that wants to be tighter. |
| `QUAKE` / `TSUNAMI_WARN` / `WAVE_IN` / `WAVE_OUT` / `LEVEL_END` | 1200 / 3540 / 4440 / 4740 / 28800 s | pacing. `QUAKE` is 20 s of WALL time at the level's 60x; `WAVE_IN` is `QUAKE + 54*60` and `TSUNAMI_WARN` is `WAVE_IN - 900`, so moving the aftershock moves the sequence with it. The 54 minutes is what the tanks have to cover. |
| `WAVE_PEAK` / `WAVE_RISE` / `WAVE_HOLD` / `WAVE_FALL` | 12.6 m / 180 / 120 / 240 s | how far up the hill the sea gets and how long anything down there stays stopped. The peak must stay UNDER the 13 m bench or the pool floods too. |
| `simSpeed` | 60 | eight sim hours in eight real minutes |
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
* ~~**A pump or a valve run dry against air diverges.**~~ FIXED 2026-09-08 -
  see below. It was three things and none of them was in water-properties.
* The control-rod / boron / SCRAM panel and the "MW to Grid" readout are up
  for a plant with no reactor and no turbine. Harmless, and pre-existing for
  any such sandbox plant, but it is noise on a level aimed at newcomers.

---

## Uncovery is not the loss (2026-09-08)

Erick asked for four things after playing it. What changed:

**1. The level readout stopped jittering.** It was the DISPLAY, not the
physics: the pool level moves 0.006 mm per 0.05 s and its mass is constant to
seven figures, but `getLiquidFraction` re-derived the phase split from the mass
quality through the steam tables. At pool conditions the quality is 1.7e-5 and
v_g/v_f is ~15000, so solver-tolerance noise in a quantity that is a hundred-
thousandth of the state came out as a **9.4 cm swing, 7.6 cm frame to frame**.
The node's own liquid level is now synced onto `Fluid.liquidLevelFraction` and
the renderer uses it: **0.35 mm span, 0.01 mm frame to frame**. Two true-zero
fixes came with it - the atmosphere node's dry-air fractions are renormalised
(they summed to 0.9996, so "1 atm" was 40 Pa short of it) and the pool's own IC
air is `101325 - P_sat`, which took the start-up vent ring from +-8.4 kg/s to
+-0.04 kg/s.

**2. The crack is a scripted BURST.** No more crack pipe and crack valve: the
earthquake fires `{ kind: 'burst', id: 'pool', area: 0.0170, elevation: 0.4,
openingHeight: 0.8 }`, which drives the same machinery a pressure rupture does
- one BurstState, one `break-pool` connection, the same discharge to open air
and onto the pad, the same rendering. The leak reproduces the old two-
connection path to within 0.3% (144.2 / 133.5 / 122.8 kg/s at t = 2700 / 3300 /
3900 s, against 143.9 / 133.3 / 122.6). Deleting the crack valve also removed a
liquid-solid 2 m3 node that used to crush dt in the first second of the level.

**3. Running the racks dry no longer ends the level.** The `level` hazard is
gone. The run continues: the pool boils dry, the racks heat, the cladding
burns, and the level is lost on `maxRelease` = 1.0 of the CsI/Xe release index
(about 0.017 mol of caesium-iodine, ~8 TBq - "a genuine release ... this one
makes the news"), with a 1800 C clad-melt backstop. The pool now has a real
radiological inventory: derived from its declared decay heat and a new
`fuelAgeDays` (default 30 days) by running Way-Wigner backwards to the rated
power the fuel came off, then the core model's 700 / 250 mol per GWt. 8 MW at
30 days = a 4.55 GWt core = 3184 mol of noble gas and 1137 mol of CsI-class
volatiles.

**The clock went from six hours to eight.** At six hours a do-nothing run WON -
dry, on fire, forty minutes before the consequence arrived. Eight hours puts
the release inside the level. That in turn exposed the sea tank emptying
(3600 t at 350 kg/s), so it now carries an explicit `volume: 200000` while
keeping its drawn size.

**Unfed timeline** (`SFP_ONLY=1 npx tsx scripts/test-game-levels.ts sfp`):

| t | what |
| --- | --- |
| 2400 s | liner tears, 144 kg/s |
| 5040 s | racks uncovered |
| 18,120 s | pool boils dry |
| 22,320 s | cladding past 900 C, 6.1 MW of oxidation against 8 MW of decay heat |
| 24,020 s | release limit - **level lost**, clad 1174 C, 1.65% of the cladding consumed |
| 28,800 s | clock, if anyone had fed it |

**4. The cladding burns in air as well as steam** - `docs/zircaloy-air-oxidation.md`.
On this level it burns mostly in STEAM, because a one-node pool with no
hydrostatic gas column has no chimney and cannot draw air back in after boiling
purges it. That gap is written up in the oxidation doc; it is the next thing to
fix if air ingress matters.

**The run-dry divergence is fixed**, and none of it was in water-properties:
`fluidHeatCapacity` re-deriving the water state from an ill-conditioned
subtraction, `computeRatesNorm` dividing the mass rate by the water mass alone
instead of the node's whole fluid inventory, and `solveMixtureState` not
recognising the pure-gas limit when the water mass falls below one
representable unit of the node's energy. The unfed level now runs to t =
52,680 s instead of dying at 22,440 s (it ends there in a 4700 C rack, which is
well past anything the model claims to represent).

## 2026-09-08, second pass (branch `sfp-script`)

From a play session. The level itself is unchanged in structure; the pacing,
the wave and three pieces of UI around it are not.

**The aftershock is twenty seconds in.** Forty minutes of watching an intact
pool was forty minutes of nothing; the player now arrives, presses TAKE THE
WATCH, has a moment to look at the plant, and hears the liner go. The
scenario's messages call it an AFTERSHOCK, which is also what the briefing
says to expect. (This shipped as `QUAKE = 20` - twenty SIMULATED seconds,
which at 60x is a third of a second of watching. Corrected to 1200 s on
2026-09-09; see the timeline table above.)

**The wave is bigger and much faster.** +12.6 m (was +5), rising over 180 s,
held 120 s, drained over 240 s (was a 300 s rise and an 80-minute stand). It
now covers everything except the bench, and it is gone in under ten minutes -
so the tanks have to carry the make-up for minutes rather than an hour and a
half, and the shore is workable again almost immediately.

**Re-measured** (`npx tsx scripts/test-game-levels.ts sfp`):

| check | result |
| --- | --- |
| [1] unfed | racks uncovered t=2660 s, boiled dry t=15,780 s, clad past 900 C t=19,960 s (6.1 MW of oxidation), release limit **t=21,680 s**, 1.65% of the cladding gone |
| [2] bench pump | -0.0 kg/s, suction node two-phase at 0.174 bar |
| [3] shore pump | 352.4 kg/s into the pool |
| [4] the answer | sea pump from t=30 s, tank line open 1200..2400 s: min pool level **8.28 m**, peak clad 46 C, no uncovery, shore pump drowned t=1260 s and restarted t=1740 s, tanks gave up 142 t |

## 2026-09-09, the aftershock in wall seconds (branch `fix-freeze`)

`QUAKE` moved from 20 to **1200 s** - the twenty seconds it was always meant
to be, measured on the clock the player sits through rather than the plant's.
Nothing else about the level changed: the offsets carried the rest of the
sequence with them and all four checks pass untouched, with every milestone
1180 s later than the line above.

| check | result |
| --- | --- |
| [0b] timeline | aftershock t=1200 s = 20 s of wall time at 60x, shake + burst, warning +300 s, wave +1200 s |
| [1] unfed | racks uncovered t=3840 s, boiled dry t=18,520 s, clad past 900 C t=22,560 s (3.8 MW of oxidation), release limit **t=23,620 s**, 1.96% of the cladding gone |
| [2] bench pump | -0.0 kg/s, suction node two-phase at 0.173 bar |
| [3] shore pump | 352.4 kg/s into the pool |
| [4] the answer | min pool level **8.36 m**, peak clad 46 C, no uncovery, shore pump drowned t=2440 s and restarted t=2920 s |

The level is still not re-tuned for the wall-clock cost of BUILDING (see the
2026-09-09 note in [[build-queue]]): the 300 m service line is 30 s of the
player's time and the aftershock now lands before it can be finished, which is
probably right but has not been played.

**The canvas used to freeze the moment the level loaded** and that is what
made the aftershock look instantaneous - the picture stopped on an intact
pool while the simulation went on draining it, so the first thing that ever
changed on screen was the toast saying the liner had gone. Root cause was not
in this level: a cold air-blanketed tank hands the renderer 17 mbar of steam
under a bar of air, the colour code read the tank's steam pressure as a TOTAL
and subtracted the air from it, and the resulting negative pressure threw out
of the steam tables mid-frame. `PlantCanvas.render` armed its next animation
frame at the END of the drawing code, so that one throw ended the loop for
the session. Both halves fixed on this branch: `Fluid.steamPressure` (see
`src/types.ts`) makes every producer say which pressure it is carrying, and
both animation loops now arm the next frame in a `finally` without swallowing
the error. Regression: `scripts/test-display-fluid.ts`.

**The earthquake used to fire again every time a dialog was closed.** A live
edit rebuilds the simulation from the plant, and the rebuild called
`initScenarioState` afresh - `fired: 0` - so every event whose time had passed
fired again on the next step. Scenario progress is live state, and
`carryScenarioProgress` in `src/simulation/resume.ts` now carries it across the
transplant (matching the event lists, and saying so loudly if they ever
differ). Regression: the last block of `scripts/test-live-edit.ts`.

**Placing from the yard no longer opens a dialog.** A stock line that names a
design has nothing left to ask: `ComponentDialog.showYardPlacement` builds the
same form, fills it from the design, puts the part on the ground with its
auto-generated name and submits it in the same task, so nothing paints. Generic
lines (no design) still open the full dialog.

**Reactor controls are hidden on a plant that has no reactor.** The rod /
boron / SCRAM panel and the MW-to-grid readout come up only when the plant
holds a reactor vessel, core barrel, fuel assembly or turbine
(`plantHasReactorControls` in main.ts). Derived from the plant, so it is right
in the sandbox too, and a reactor built while the plant runs brings the panel
straight back.

## 2026-09-09, an hour of tanks, and building on the plant's clock

Two changes from a play session, on branch `build-simtime`.

**The tsunami is 54 minutes behind the aftershock** (`WAVE_IN = QUAKE + 54*60`,
the warning at `WAVE_IN - 900`). At twenty minutes the tanks were a formality -
the answer key drew 142 t of 1217 and the shore was workable again almost at
once. An hour of gravity feed against a 100-150 kg/s tear is a real inventory,
and it is also the room the player now needs to *build* in, since a build costs
simulated time rather than the player's.

**Building runs on the plant's clock** ([[build-queue]]): 0.223 simulated
seconds a kilogram, which is the same 0.1 s a metre of service-water line the
rate was always anchored on, measured at this level's own 60x. So the numbers
that matter here are unchanged in the player's seconds and honest in the
plant's: the yard's 300 m of pipe is 30 minutes of plant time (30 s at 60x) and
its pump is 9.4 minutes (9.4 s). A build in progress now pauses when the
simulation pauses and rewinds when the run does.

**The answer key changed shape.** It used to run the sea pump from t=30 s,
which pre-filled the pool and left the tanks topping up a full pool through a
short wave. It now does what the geometry actually forces:

| t | action |
| --- | --- |
| 1260 s | the liner is gone: open the tank make-up valve (gravity, no pump) |
| 5100 s | the sea is back down: start the shore pump |
| 5700 s | the sea pump has the load: shut the tank line |

Re-measured (`npx tsx scripts/test-game-levels.ts sfp`):

| check | result |
| --- | --- |
| [0b] timeline | aftershock t=1200 s = 20 s of wall time at 60x, shake + burst; wave t=4440 s (54 min after), warning t=3540 s (15 min before the water) |
| [1] unfed | racks uncovered t=3840 s, boiled dry t=18,520 s, clad past 900 C t=22,560 s (3.8 MW of oxidation), release limit **t=23,620 s**, 1.96% of the cladding gone - unchanged, the wave never touched it |
| [2] bench pump | -0.0 kg/s, suction node two-phase at 0.173 bar |
| [3] shore pump | 352.4 kg/s into the pool |
| [4] the answer | min pool level **6.68 m** (racks at 4.16 m), peak clad 49 C, no uncovery, shore pump drowned t=4480 s and restarted t=4960 s, **tanks 1216 t -> 743 t: 474 t drawn, 61% left** |

The tank line alone passes ~110 kg/s against a tear that starts at ~144, so the
pool goes on falling for the whole hour - 8.35 m down to 6.68 m at the worst of
it - and then recovers to the rim once the sea pump is on. That is the shape the
level wanted: the gravity feed slows the loss but does not stop it, and the sea
is still the only thing that ends the accident. Check [4] now also asserts the
tanks finish with a margin (>5% of what they started with), so a future change
that quietly drains them fails rather than passing on the pool level alone.

---

## 2026-09-09, the pump has to stand in the sea (worktree `level1-adjustments`)

Erick's asks, from playing it: the yard pump is too big and works from the
shore, which makes no sense; the sea floor should deepen offshore and the pump
should stand on it; the connection dialog's "absolute" elevations were not
absolute; the wave should take what it reaches; the HUD should fold away but
keep the clock and stay off the panels; a pump should start stopped, spew into
a puddle if a line is missing, and be started from its panel; the leak should
stand as a puddle; more decay heat; and a t=0 reset should refill the yard.
The generic mechanics are in [pump-placement.md](pump-placement.md); this is
what they did to the level.

**The yard pump is now a wet-pit machine delivered DRY:** `pump-service-water-lp`
= 120 kg/s at 12 m, NPSHr 1.5 m, motor on a 6 m column, casing full of air,
discharge check valve. Full of air it cannot draw water up to itself, so on the
bench or the shore it sits at 1 atm doing nothing (the old primed pump worked
from the shore because a primed pump 1.7 m above the water is fine - the
physics never disagreed with it; NPSH is not what stops it, priming is).
Standing in the sea the water walks in, the air goes up the discharge, and it
lifts ~84 kg/s to the pool's RIM. Too far out and the sea is over the motor:
drowned before it starts. The discharge check is what lets a stopped pump sit
in the sea without the pool's air seeping down the line into it, and without
the pool siphoning back through it.

**The map:** the beach face now ends at -2 m and a shelf shelves to -3.5 m
over the next 28 m (x = 234..262), then the floor drops to -9 m at the map's
edge. The shelf is kept under 3.7 m of water on purpose: a dry casing filling
through a 12" line with more than ~0.4 bar behind it hits liquid-solid hard
enough to burst (a phantom-gas artifact - see the placement doc); off the
shelf the motor is under water anyway. The sea tank's `elevation` follows the
sloping floor so its base stays at -4 m, and its nozzle is 2 m under the
surface (it used to be AT the surface and drew half air).

**The pool's make-up nozzles moved to the rim.** A nozzle under the water was
a siphon the moment the pump stopped: a 12" line from the pool ten metres
above the sea drained ~440 kg/s back through an idle pump. Real make-up lines
discharge above the water for exactly this reason. Consequence: the sea pump
lifts to 12.7 m whatever the level, so its delivery does not grow as the pool
empties - it is the make-up that never runs out, not the one that keeps up.

**The pad is a shallow dish** (0.3 m at the pool, flat at its edges where the
tanks and the yard stand) and the terrain's infiltration is 3e-5 m/s: the
leak now stands as a puddle around the pool that grows to ~500 m3 over the
first hours and shrinks as the tear slows. On a flat pad at the default 1e-4
no puddle ever stood (the whole 8100 m2 drank 810 kg/s).

**Decay heat 10 MW** (was 8). Unfed: racks uncovered t=3840 s, dry t=16,640,
clad past 900 C t=19,740, release limit **t=20,640 s** (was 23,620).

**The answer changed shape again.** The sea pump cannot beat the tear on its
own (~84 kg/s against ~105 at the rack top), so the tanks are not a bridge to
it - they are the other half of the make-up for the whole watch, and the play
is to THROTTLE them to the shortfall so that 1200 tonnes lasts eight hours.
Check [4]: tank line open at 1260 s, sea pump on at 5100 s (it stood in the
sea through the wave, stopped - the wave rule names it as a casualty at
t=4520 s, which is why a player builds it AFTERWARDS), tank valve to
`SFP_ANSWER_TANK_THROTTLE` at 5700 s.

Measured (`npx tsx scripts/test-game-levels.ts sfp`):

| check | result |
| --- | --- |
| [1] unfed | uncovered 3840 s, dry 16,640 s, clad past 900 C 19,740 s, release limit 20,640 s |
| [2] bench / shore | 0.0 kg/s, casing still 1.013 bar of air (a stagnant hanging interface, nothing moves) |
| [3] in the sea (x=236, 2 m) | 75.9 kg/s at t=120 s (84 steady), casing primed, motor 4.3 m above the sea |
| [2] too far out (x=282, 7 m) | drowned before it starts; 0.0 kg/s |
| [4] the answer | tank line open 1260 s, sea pump on 5100 s, tank valve to 30% at 5700 s: min pool level **4.32 m** (racks at 4.16), no uncovery, peak clad 50 C, sea pump ~84 kg/s from 5100 s to the end, tanks 1216 t -> 156 t (13% left), puddle peaked ~450 m3. At 50% the tanks ran dry at ~21,700 s and the racks uncovered for the last 50 min; at 35% they ended under the 5% margin. |

**Still open:** the phantom-gas fill (the proper fix is the vapour-space
partial pressure, its own piece of work); the fill slam past ~0.4 bar of
head; the pump's drawn height is ~1 m while its motor stands 6 m up.
