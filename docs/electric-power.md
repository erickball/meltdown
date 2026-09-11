# Electric power model

Optional, per plant, off by default. `PlantState.electrical = { enabled: true }`
(saved with the design) turns it on; the checkbox is "⚡ Electric power model"
at the top of the construction palette.

## What it does

With the model on, these loads work only while fed from a live supply of
the right voltage class:

| Load | Class | Without power |
|---|---|---|
| Pump motor (motor-driven pumps) | MV AC if the motor is ≥ 200 kW, else LV AC | coasts down (same path as a drowned motor); runs back up when power returns; START/STOP switch untouched |
| Motor-operated valve (gate/globe/ball/butterfly) | LV AC | stays where it is (fail as-is); controllers cannot stroke it |
| PORV | DC | solenoid drops out: closes, cannot relieve |
| PID controller cabinet | DC | stops scanning; its actuator holds |
| Scram (protection) cabinet | DC | trips the reactor (de-energize to trip) |
| Pressurizer / tank heaters (`heaterCapacity > 0`) | LV AC | heat nothing |
| Control rod drives (reactor vessel / standalone core) | LV AC | rods drop (scram) |

Classes: DC; LV = AC ≤ 1 kV; MV = AC 1–35 kV; HV (> 35 kV) is the switchyard.
Check valves, spring relief valves and turbine-driven pumps need no power.

## The network

New palette parts (shown only with the model on): **transformer, bus,
breaker, diesel generator, battery**. The existing **switchyard** is the grid
connection (its transmission voltage, its transformer rating as capacity,
`offsiteAvailable` for loss of offsite power).

Every part and load names its feed with `powerSupplyId`; a bus may also have
a `backupPowerSupplyId` (normally the diesel). The placement dialog defaults
to the nearest compatible supply, and "Auto-wire unpowered parts" wires
everything still unwired. A dialog never offers a supply fed from the part
itself, and the factory throws on a feed loop.

Voltage rules: a bus accepts only its exact voltage and AC/DC; a transformer
only its exact primary voltage (AC); a breaker passes whatever feeds it; a
battery charger wants LV AC; a load wants its class. A mismatched feed is a
wiring fault: reported in the panel, carries nothing.

## The solve (`src/simulation/electrical.ts`)

Once per accepted step (`ElectricalOperator`, postAcceptOnly, ahead of the
control system), and once at build:

1. Energization, sources first: grid available; diesel running, past its
   start time, with fuel; battery with charge or a live charger; transformer /
   breaker / bus with a live compatible feed (breaker also closed).
2. Loads: powered = supply energized and at the right class. Demand:
   pumps = (|ṁ g H(ṁ,s)| + (1/η − 1) ṁ_r g H_r s³) / η_motor on the pump's own
   curve (rated point → exactly the nameplate); heaters = their setting;
   cabinets 1 kW; rod drives 200 kW; valve operators 0 (they draw only while
   stroking).
3. Demand flows back up; a node with several live feeds splits its load in
   proportion to what each can deliver (droop sharing).
4. Stores: battery (charger carries the DC load first, cells the rest, spare
   charger output recharges with a (1 − SOC) taper); diesel fuel (a quarter of
   the full-load rate idling, plus the load share); diesel start timer.
5. Overload: each rated element has an inverse-time relay θ' = ((P/R)² − θ)/τ,
   τ = 30 s, trip at θ > 1 (10 % over ≈ 50 s, 200 % ≈ 9 s). The relay keeps
   its heat, so reclosing onto the same overload trips again almost at once.
6. Diesels with auto-start start when an element they feed is dead.
7. Flags to the physics: `PumpState.powered`, `ValveState.powered`,
   `ControllerState.powered`, `FlowNode.heaterPowered`; rod-drive or RPS loss
   scrams.

## The turbine-generator

With the model on, every turbine-generator is a source. It feeds its
switchyard (through the main step-up transformer inside it,
`connectedGeneratorId`) and anything wired straight to it at its terminal
voltage (`terminalVoltage`, default 22 kV) - a unit auxiliary transformer,
a generator bus or breaker.

- **Synchronized** (breaker closed, switchyard has the grid): the grid holds
  the rotor at rated speed (a speed error decays with a 1 s time constant -
  the envelope of the synchronizing swing). The grid carries the
  switchyard's house load; the generator exports shaft power × η_gen less
  the house load. That export is what "MW to grid" shows.
- **Islanded** (breaker closed, no grid): the switchyard is fed by its
  generator, and the rotor follows the swing equation in energy form,
  d/dt(H·P_rated·ω²) = P_shaft − P_elec/η_gen − 0.5 %·P_rated·ω³. P_shaft
  is the turbine's own staged expansion (`expandTurbines`, shared with the
  rate operator, so the steam's books and the rotor's agree). A full-power
  load rejection spins the rotor up at about 1/(2H) of rated speed a second.
- **Speed governor** (on by default, `speedDroop` 5 %): the control valves
  go to `governor valve setting + (1 − ω)/droop + reset`, within their
  travel, stroking with a 0.2 s lag - at 5 % droop a 1 % overspeed takes
  20 % of travel off at once. The reset integrates (1 − ω)/(droop·10 s) so
  an island settles back at rated speed; tied to the grid it walks back to
  zero at 10 %/min (the loading rate). The hydraulics read one admission
  (`governorPositionFor`): 0 when tripped, else `governorAdmission` (the
  stroked valves) when there is a speed governor, else the governor valve.
- **Protection**: overspeed (`overspeedTrip`, 110 %) trips the turbine - stop
  valves shut (the machine admits nothing), generator breaker open, rotor
  coasts on windage. Underfrequency (95 %) opens the generator breaker.
  Closing the breaker onto a live grid needs speed within 1 % (synch check);
  onto dead plant buses it closes at any speed.

So a loss of offsite power at power either islands onto the house load
(governor fast enough, turbine inventory small enough) or overspeeds and
trips, whereupon the house loads go dead and the diesels start - which is
the plant's own emergent answer, not a scripted one.

## Simplifications (deliberate)

- Real power only: no phases, power factor, voltage drop, motor inrush.
- Frequency does not change what motors draw; an island at 104 % runs its
  pumps at their normal speed.
- Turbine power does not depend on rotor speed (fine within ±10 %).
- No reactor trip on turbine trip - the plant's other protection has to
  catch the pressure rise.
- Motors restart by themselves when their bus returns (load sequencer).
- Wires are free and carry no physics.

## Operating it

Selecting a piece shows its state, loading and relay heat, with buttons:
breaker Open/Close, diesel Start/Stop, Reset trip, at a switchyard
"Lose / Restore offsite power", and at a turbine-generator its breaker and
Trip / Reset turbine. Scenario actions: `offsite-power`, `breaker`,
`diesel`, `generator-breaker`, `turbine-trip` (see `scenario-types.ts`).

## Drawing

Wires auto-route on the 1 m lattice around equipment (`src/render/wires.ts`),
hair-thin twisted pairs (copper live, grey dead), dotted when zoomed out.
"Show power wiring" in the View panel hides them.

## Tests

`scripts/test-electrical.ts` (in `npm test`): the solve on a hand-built
station. `scripts/test-electrical-plant.ts`: the two-loop PWR wired by
auto-wire, loss and return of offsite power.
