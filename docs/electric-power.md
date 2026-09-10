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

## Simplifications (deliberate)

- Real power only: no phases, power factor, voltage drop, motor inrush.
- Generator output is exported; house loads come from the grid (no islanding).
- Motors restart by themselves when their bus returns (load sequencer).
- Wires are free and carry no physics.

## Operating it

Selecting a piece shows its state, loading and relay heat, with buttons:
breaker Open/Close, diesel Start/Stop, Reset trip, and at a switchyard
"Lose / Restore offsite power". Scenario actions: `offsite-power`,
`breaker`, `diesel` (see `scenario-types.ts`).

## Drawing

Wires auto-route on the 1 m lattice around equipment (`src/render/wires.ts`),
hair-thin twisted pairs (copper live, grey dead), dotted when zoomed out.
"Show power wiring" in the View panel hides them.

## Tests

`scripts/test-electrical.ts` (in `npm test`): the solve on a hand-built
station. `scripts/test-electrical-plant.ts`: the two-loop PWR wired by
auto-wire, loss and return of offsite power.
