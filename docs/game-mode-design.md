# Game Mode ("Career Mode") Design

Branch: `game-mode`. Status: first playable.

## Vision

A campaign of levels wrapped around the existing sandbox. The player is the new
Chief Engineer at **Gigawatt Power & Light**, working for **Mr. Grubb** — a
cigar-chomping 1970s fat-cat who hates environmentalists, safety margins, and
especially interest payments. Presentation is deliberately corny 90s-PC-game:
pixel portraits (2-frame talk animation + blink), typewriter dialogue boxes you
click through, chiptune jingles (WebAudio square waves standing in for MIDI),
CRT scanlines on the overlays.

The physics sandbox is untouched — career mode is a layer that drives the
existing construction/simulation modes, budget system, and severe-accident
modeling. Sandbox mode remains exactly as before (chosen from the title
screen).

## Core loop per level

1. **BRIEFING** — dialogue scene. Boss states the assignment, the loan cap,
   and the payout. Objectives appear in the HUD.
2. **CONSTRUCTION** — normal construction mode plus a **BUILD IT** button.
   Level-provided "stock" components are free (already on site). Everything
   the player adds is priced by the existing overnight-cost estimator. BUILD
   is allowed only while player-added cost ≤ loan cap. Pressing BUILD takes
   out the loan and locks the design in.
3. **OPERATION** — simulation mode. Revenue = generator MW × electricity
   price × time (price follows a day/night sine ± events). Loan accrues
   interest continuously. Random events fire (per level): pump trips, tube
   ruptures, LOCAs, price spikes/crashes. Player fixes things with
   **operator actions** (new in-sim panel: pump start/stop/speed, valve
   position, controller AUTO/MANUAL) — local actions take ~20 s of sim time
   ("someone has to walk out there"), control-room actions are instant.
4. **Post-build changes** — returning to construction is an outage. Changes
   are priced per the lock-in rules: new component = cost × 1.10 (work fee),
   edited component = max(0, newCost − paidPrice) × 1.10 (no refund for
   downgrades), deleted component = 75% of paid price back. Components that
   burst during operation are charged a 25% repair fee automatically on
   entering the outage.
5. **DEBRIEF / FAILURE** —
   - All objectives met → payout, boss praise, next level unlocked.
   - Cash < $0 → bankruptcy rant, retry level.
   - Radiological release (severity index ≥ the level's limit) → the plant
     keeps running ~15 s so the player watches it unfold, then the accident
     screen reports how much radioactive material reached the environment
     (moles of aerosol + noble gas, ≈ becquerels), then the boss rant about
     interest accumulating, then back to construction ("Out For Repairs") or
     retry.

## Release severity

`severity = 60 × CsI_moles_released + 0.02 × Xe_moles_released`

CsI aerosol deposits downwind and dominates the significance of a release;
noble-gas xenon disperses and is ~3 orders of magnitude less significant per
mole. Weights are calibrated so a full-core volatile release from a ~3 GWt
core (~750 mol CsI-equivalent) lands at severity ~10^4 and a scram-and-leak
whiff lands well under 1. The level's `maxRelease` limit is a threshold on this
index. For flavor the accident screen also reports an approximate released
activity (~5e14 Bq per mole of CsI-equivalent, 5e11 per mole of Xe).

## Levels (first playable set)

Stock plants derive from the shipping presets, so convergence is proven.

1. **FIRST LIGHT** — Full PWR secondary + pressurizer + RCP + containment on
   site (free); the old reactor was "decommissioned by a previous incident."
   Player builds the reactor vessel + core and pipes it in (cold leg → RPV,
   core barrel top → SG, RPV → pressurizer surge). Manual rods (no rod
   controller on site). Goals: hold 150 MWe for 2 min, deliver 25 MWh.
   No random events. Loan cap $750M (reference reactor prices at ~$560M).
2. **SHAKEDOWN** — Complete PWR with full autocontrol, free. Operate it.
   Goals: 60 MWh + grow cash $20M → $32M. One scripted feedwater-pump trip
   plus a price spike. Teaches operator actions.
3. **GOING CONCERN** — Empty site, $6B loan cap. Build whatever delivers.
   Goals: hold 250 MWe for 5 min, 120 MWh, stay above $40M. Random events
   at moderate rate (pump/turbine trips, price swings).
4. **THE INSPECTION** — Two-loop PWR, free. An NRC stress test: one surprise
   major initiating event (SGTR / small LOCA / RCP trip / turbine trip) at a
   random time. Goals: 100 MWh, cash to $50M, release severity < 0.01.

## Playtest notes / known issues

- Headless, both the level-1 plant AND the shipping pwr.json preset currently
  run at ~1.1x realtime (RK45 dt pinned to a few ms, mostly around the FW
  check-valve node). The perf memory says presets used to do 20-30x, so this
  may be a recent regression on master - worth a look, because level pacing
  assumes the player can run 5-20x. Level goals are sized to ~10-15 sim-min
  of operation as a hedge.
- The level-1 reference reactor (rods parked at 70% withdrawn, lattice-derived
  coefficients, 5% enrichment) settles at ~48% of 1000 MWt nominal ->
  ~208 MWe. The briefing tells the player to trim rods by hand; the 150 MWe /
  25 MWh goals leave slack for less-optimal builds.
- The career flow is integration-tested only headlessly (physics + economy);
  the DOM flow (title -> briefing -> BUILD -> operate -> debrief) still needs
  a human playtest pass.
- Goal/economy numbers (prices, APRs, bonuses) are first-pass tuning.

## Deferred (noted in master todo)

- Population skyline growth with career progress.
- Steady-state pre-test before BUILD ("test drive").
- O&M staffing costs, fuel burnup economics.
- Real waiting-for-initiating-event mode (events currently poisson-timed
  during operation).
- Hydrogen explosions as an event visual (H2 is generated but combustion
  isn't modeled).

## Module map

```
src/game-mode/
  index.ts        initGameMode(host) — the only export main.ts touches
  types.ts        LevelDef, GoalDef, EventDef, phase enum, career save
  economy.ts      Ledger: cash/loan/interest, price curve, lock-in pricing
  consequences.ts assessRelease(), release/accident text helpers
  events.ts       RandomEventEngine (poisson timing, weighted picks)
  levels.ts       LEVELS[] with dialogue scripts and goal defs
  levels/*.json   stock plants (level 1 partial PWR; others reuse presets)
  dialogue.ts     DialogueOverlay (typewriter, portraits, choices)
  sprites.ts      pixel portraits (boss, inspector), 2-frame talk + blink
  music.ts        chiptune player (title/briefing/victory/disaster themes)
  hud.ts          career HUD (cash, price ticker, objectives, phase)
  operator-actions.ts  in-sim component action panel (career mode)
  manager.ts      GameModeManager state machine wiring it all together
```

Host interface (implemented in main.ts): plantState, gameLoop, setMode,
loadPlantData, clearPlant, componentCost, showNotification,
refreshCostPanel, onSimUpdate/onComponentSelect/onGameEvent hook points.
