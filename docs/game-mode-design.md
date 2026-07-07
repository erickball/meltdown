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
   - Radiological release (estimated cancers ≥ 1) → the accident screen:
     "how many people you may have given cancer (but we'll never know for
     certain)", then the boss rant about interest accumulating, then back to
     construction ("Out For Repairs") or retry.

## MACCS-lite

`estimatedCancers = 60 × CsI_moles_released + 0.02 × Xe_moles_released`

Hand-wave chain (documented so the number is defensible-ish in spirit): CsI
moles → Cs-137-equivalent activity → generic Gaussian-plume population dose →
LNT 5%/person-Sv. Calibrated so a full-core volatile release from a ~3 GWt
core (~750 mol) lands in the low tens-of-thousands — Chernobyl-order — and a
scram-and-leak whiff lands well under one statistical cancer. Noble gases are
~3 orders of magnitude less consequential per mole. Constraint objectives use
this number; the accident screen displays a deliberately fuzzy range.

## Levels (first playable set)

Stock plants derive from the shipping presets, so convergence is proven.

1. **FIRST LIGHT** — Full PWR secondary + pressurizer + RCP + containment on
   site (free); the old reactor was "decommissioned by a previous incident."
   Player builds the reactor vessel + core and pipes it in (cold leg → RPV,
   core outlet → SG, RPV top → pressurizer surge). Manual rods (no rod
   controller on site). Goals: 150 MWe sustained, 300 MWh delivered. No
   random events.
2. **SHAKEDOWN** — Complete PWR with full autocontrol, free. Operate it.
   Goals: 1500 MWh + end with positive cash. One scripted feedwater-pump trip
   plus electricity-price volatility. Teaches operator actions.
3. **GOING CONCERN** — Empty site, big loan cap. Build whatever delivers.
   Goals: 3000 MWh + cash target. Random events at moderate rate.
4. **THE INSPECTION** — Two-loop PWR, free. An NRC stress test: one surprise
   major initiating event (SGTR / small LOCA / RCP trip / turbine trip) at a
   random time. Goals: 1000 MWh, estimated cancers < 0.01, stay solvent.

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
  consequences.ts cancersFromRelease(), accident text helpers
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
