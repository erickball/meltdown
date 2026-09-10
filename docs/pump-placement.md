# Pumps as things you put somewhere

Built 2026-09-09 for level 1 (the spent fuel pool), where the player has to
decide where a service-water intake pump can stand. Everything here is
generic - every pump in every plant has these properties - and nothing in
it is a rule about level 1.

| What | Where |
| --- | --- |
| Pump fields | `PumpComponent` in `src/types.ts` (`ratedRpm`, `motorElevation`, `initialFill`, `dischargeCheck`) |
| Dialog | `componentDefinitions['pump']` in `src/construction/component-config.ts` |
| Factory | `src/simulation/factory.ts`: pump node (`pumpCasingHeight`), `openPumpPortsToAir`, `fitPumpDischargeChecks`, `ambientAir` |
| Drowning | `isPumpDrowned` in `src/simulation/operators/surface-water.ts` |
| The wave | `src/simulation/wave-casualties.ts` (decides), `main.ts` `washAway` (does it), `addWreck` in `src/render/debris-fx.ts` |
| Hanging interface | `computeConnectionHydraulics` in `src/simulation/operators/connection-hydraulics.ts` (`stagnant`) |
| Panel | `case 'pump'` in `src/debug.ts` (START/STOP, speed, casing, open nozzles) |
| Tests | `scripts/test-pump-placement.ts` (in `npm test`), `scripts/test-game-levels.ts sfp` checks [2]-[4] |

## The setpoint is not the motor's RPM

The pump dialog's "Speed" field (RPM) used to be stored as `speed = rpm /
3600`, and `speed` is the running SETPOINT as a fraction of rated. An 1800
RPM pump was therefore built at 50% speed and, by the affinity laws, 31% of
its head. The field is now `ratedRpm` (informational) and a new pump's
`speed` is 1.0. Older plants that carry `speed = rpm/3600` read back the RPM
from it in the dialog; their setpoint is left alone.

## Motor height (`motorElevation`)

The part of the machine that drowns. `PumpState.motorElevation` is absolute
(ground + the component's elevation + the motor's height on the machine).
`SurfaceWaterConstraintOperator` sets `flooded` when the water over the pump
stands above it - used to be above the BASE, which made any pump standing in
water a drowned pump. A horizontal pump keeps its motor at shaft height, 0.5
m (`DEFAULT_PUMP_MOTOR_ELEVATION`, also the dialog default). A vertical
wet-pit intake pump stands its motor on a column - the level's yard pump
says 6 m - so the bowl can sit under water. The same number is what a wave
has to pass to take the pump (below).

## Casing fill (`initialFill`)

`'primed'` (default): built full of the liquid it pumps, as a commissioned
plant's pumps are. `'dry'`: built full of ambient air, the same air the
environment node is made of (`ambientAir()`). A centrifugal pump full of air
develops rho_air g H - a few hundred pascals - so it cannot draw water up to
itself; it fills only if its suction floods it (a source whose surface is
above the nozzle, or a pressurised one). That is what makes "put the intake
pump IN the water" a physical requirement rather than a rule: on the shore
it sits at 1 atm of air doing nothing, in the sea the water walks in.

The write-back (`resume.ts`) records the live phase back into `initialFill`,
so a dry pump that has since primed re-initialises as primed if something
else about it is edited.

**Casing height.** A pump node used to be a zero-height, well-mixed pot,
which priced every draw from it as the mixture. A casing holding any air
could then never get rid of it: the discharge line was priced at the
mixture's density, the air could not climb it, and a dry pump in the sea sat
air-bound for ever. The pot now spans base-to-discharge-nozzle
(`pumpCasingHeight`: the pinned outlet elevation, height/2 - port.y on the
drawn machine): the discharge draws from the top of the casing, gas first
while there is gas, and the suction from the bottom. That is the standard
end-suction / top-discharge layout, and it is why real casings vent through
their discharge.

## Open nozzles (`openPumpPortsToAir`)

A pump nozzle with no line on it faces the air. The factory gives it a
connection to the environment AT the nozzle (no head across it, one
entry/exit loss, the nozzle's area): an open suction draws air, an open
discharge pours onto the ground under the pump, where the surface-water
operator makes a puddle of it. A pump missing a line on either side is
built STOPPED whatever its design says (its setpoint is kept), and can be
started from its panel - which is how a player sets a pump up to spew into
a puddle. `PumpState.openInlet` / `openOutlet` say which nozzle is open; the
panel reports it. Matching is by component, not port id (the connection
pass resolves a pump's lines the same way, and test plants do not always
name ports).

Once both lines exist the pump keeps whatever running state it had: a
live-build rebuild carries the pump state over unless the pump itself was
edited, so the player presses START. In construction mode (a plant built
from scratch and then run) `initialState` applies as before, provided both
lines are there.

## Discharge check valve (`dischargeCheck`)

A non-return flap on the discharge nozzle, as vertical wet-pit pumps and
most service pumps carry: a `CheckValveState` keyed to the pump's discharge
flow path, so the solver treats it exactly as a check-valve component
(cracking pressure 5 kPa). Without one a stopped pump is an open pipe: a
12" line from a pool ten metres above a pump drains ~440 kg/s back through
it into the sea, which is also what one of Jack's bug reports was. It also
stops a pool's air seeping down a discharge line into a casing below.

## The hanging interface (`stagnant`)

A line's contents are priced from whichever end is upstream of the CURRENT
flow. At zero flow between a liquid node and a gas node above it that is
undefined: priced as liquid the column cannot be lifted ("reverse"), priced
as the gas nothing pushes the gas down ("forward"), and flipping between the
two moved a little of each phase every step. It bled a dry pump standing 15
m above the sea down to a vacuum (and past the model's temperature floor:
the solver threw), and seeped a pool's air down a discharge line.

A real line stratifies - liquid part-way up, gas above, the interface where
the column's weight balances the pressure difference - and nothing moves.
`computeConnectionHydraulics` now prices the driving term with BOTH ends'
fluids; when the pressure difference lies between the two pure-phase heads
(neither phase driven in its own direction) the line is `stagnant`: its
gravity head is set to the pressure difference, which is what a hanging
interface means, so the driving term is zero and the flow decays. Outside
that band the current pricing stands; both edges are continuous.

## The wave takes what it closes over

`waveCasualties(plant, state)` (pure): a terrain water body standing more
than `WAVE_TRIGGER` (0.5 m) above its declared surface is a wave running;
every component in its basin whose wash-away elevation is under the surface
is taken - by the MOTOR for a pump, by the base for anything else. Never
water bodies, pools, warehouses, buildings, switchyards, or anything inside a
container (its container decides). Puddles never take anything.

`main.ts` checks on every state update and acts on the next tick (removal is
a live edit - a rebuild - which cannot happen inside the step that noticed
it): `constructionManager.destroyComponent` (no refund - nothing of it goes
back to the yard; a part still in the build queue is `discard`ed, lost with
it), a `washed-away` game event (HUD, history 🌊), and a wreck in the flood
debris that floats off and strands with the rest. Rewinding past the wave
brings the component back, since the removal is an ordinary plant edit in
the history.

## Known limits (both are the same gap)

**Gas partial pressure over the full node volume.** `mixture-properties.ts`
prices a node's non-condensible gas at n R T / V with V the WHOLE node, not
the vapour space (its header calls this a known simplification with its own
blast radius). Two consequences for a dry casing filling with water:

* the air is never compressed and never has to leave. The casing fills at a
  constant pressure, and once full the moles are still there as a phantom
  partial pressure (about a bar) that the pressure solver carries along.
  The through-flow physics comes out right - the casing's absolute pressure
  is set by its lines - but the air ledger is not.
* the fill does not slow as the air compresses, so a casing with a lot of
  head behind it (the yard's lines make its pot 8 m3 - see below) fills
  fast and hits liquid-solid hard: through a 12" line with more than ~0.4
  bar behind it the slam bursts a 16 bar casing. Level 1's sea shelf is
  kept under 3.5 m of water for this reason; off the shelf the water is
  over the motor anyway. With the gas space priced properly the fill would
  stop at the compressed air, and the pump would prime by pushing the air
  out through its discharge once started - and no slam.

The proper fix is the vapour-space partial pressure with the liquid's own
compressibility closing the liquid-full case. It changes every
gas-blanketed node (accumulators would finally depressurise as they
discharge) and wants its ICs re-based, so it is its own piece of work.

**The pot is mostly pipe.** Connections carry no inventory, so the factory
lumps a line's water into the node at each end; a pump on 300 m of 12" pipe
therefore shows an 8 m3 casing (the casing itself is 0.004 x rated flow,
0.5 m3 here). That inventory is real - it is the line's - and it is what
makes the fill above take half a minute.
