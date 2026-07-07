## TODO List
Misc:
-AI assistant to help users add to, fix, or understand the model (use sonnet 5, cap usage at $10/month. context: a bunch of game documentation, the current plant model - full list of components and their connections and properties, the last few changes the user made, what mode they're in, and the most recent simulation results for this model (if any). Also the ability to look at the code but let's try to make the documentation good enough it doesn't usually have to.)


Display & minor issues:
-We should probably display a thermometer, at least on large hydraulic nodes.
-Need a better way of deciding whether a node has separate liquid and vapor spaces, or is mixed. Or has a vapor space and a mixture space. Something about its height to width ratio and flow rate? This affects display but also flow through flowpaths at the top or bottom. (the system we have now incorporates some of this, but the results seem hit-or-miss. Needs work.)
-Add FW heaters? (did we already solve this by deciding they're just heat exchangers, and turbines can have extraction steam outlets?)
-Clean up the debug display
-Maybe find a good way to display relative pressure at connections
-Construction-mode UI for creating/editing PID controllers (sim + JSON presets work today; scram-controller UI pattern extends). Includes a manual/auto toggle so the rod slider can take back control from an auto rod controller.
-BWR preset control suite (rods on dome pressure, recirc, level): still a manually-operated plant; PWR preset now ships with full auto control.
-Maybe show the UHS as a river or ocean?
-Water and steam coloring: should it be proportional to internal energy? Maybe it should, with white as the critical energy and fading into blue below that and yellow/orange above that. With max saturated vapor (~2604) being a very pale yellow. This will create a clear split in two-phase nodes, but less noticeable as you approach the critical pressure. It does mean that high pressure steam and low pressure steam at the same energy can be the same color, but that's fine I guess.
-Maybe to put anything at negative elevation you should first have to "dig" voxels out Minecraft-style
-Maybe you can build seismic supports under things to give them earthquake resistance. So anything elevated off the ground should by default have a real spindly scaffold holding it up, and then you can optionally beef it up.
-Steam separators? Maybe not. What's the point
-How hard would it be to have the liquid and vapor spaces get separate temperatures, like MELCOR does? Do we need this, maybe for pressurizer spray to work right? Probably not it sounds like



Modeling gaps:
-Neutronics remaining: solid-moderated lattices (graphite/pebble + gas coolant need a solidModerationFraction so the lattice model doesn't collapse without water); boron/soluble poison as an operator control (would also enable the positive-MTC-at-high-boron failure mode); estimated-critical-position display from latticeKeff.
-Things could also have a failure temperature. Or maybe this is just creep rupture.
-Wire auto-tuned controllers into the BWR and two-loop presets (PWR done - rods/governor/3-elem FW/hotwell/pzr heaters+spray; framework in docs/controllers-steady-state-plan.md)
-Model vessel creep rupture and SG tube creep rupture
-Model core-concrete interaction
-Hydrogen explosions (H2 generation from cladding oxidation is done and released as NCG; combustion/deflagration when it meets air is not modeled yet)
-Diesel generators (and electric power in general)
-Add fuel melting and radionuclide release ("meltdown!")
-Add advanced reactor options (pebble bed fuel, helium or metal coolant)
-Not sure how to handle needing big graphite reflectors though?

Game mode:
-In game mode, after you press build, you're locked in and additional changes will cost more. Deleting a component gets you 75% of the cost back. Editing one you just have to pay the difference in value minus a 10% work fee, and if the new version is cheaper you don't get anything back. But maybe you should get an option to test a design in steady state before you "build" it.
-Add ability to wait for random initiating event (once steady state is achieved)
-Add random failures for active components
-Add money earning system based on generation (in game mode). 
-After an accident you get told how many people you may have given cancer to ("but we'll never know for certain"). Then you go to "Out For Repairs" (construction mode, basically) and your boss gives you a little angry rant about the interest accumulating by the millions every day. But there's no actual time limit. For the game-flavor sequences (intro, post-accident, story progression, etc.) I'm thinking kind of a corny pixelated 90s-game aesthetic, where it's some text you click through, some MIDI music, and a two-frame animation of a cartoon person with different expressions depending on what's happening. The boss character is kind of a stereotype of a fat-cat 1960s-70s businessman who hates environmentalists, safety concerns, and the government.
-I guess that means we're building in some sort of MACCS-lite?
-Add cool visuals for different initiating events
-Maybe something about a control room, but I don't want the user to have to worry about this a lot
-"Operator actions" initiated by the user (with delay and progress bar) by clicking on a pump or w/e
-We can do operating cost estimates based on fuel use, number of employees (how many do you need for maintenance of this many components, etc). But we're glossing over outages.
-We could even account for interest rates? Maybe

-Level 1, we give you a turbine generator condenser and FW pump, and you just basically have to create a vessel and core and hook them up and you've got power. Maybe it's for like, an emergency situation or an isolated island community or something? Maybe I don't need that much story. A mining operation might be better.
-As you get farther along and are more successful, the skyline starts to fill up with buildings showing local population increase.

## Done List
X Post-CHF heat transfer: full boiling curve on hot walls - nucleate (Thom, Zuber-saturated) below the crisis, smooth wetted-fraction collapse (logistic in log-superheat between the CHF point and the homogeneous-nucleation/Leidenfrost limit, Lienhard) into Bromley film boiling + radiation. scripts/check-boiling-curve.ts prints the curve. Condensation on cold walls unchanged.
X Cladding properly in the heat path for component-built cores: fuel -> clad (gap conductance) -> coolant convection; fuel/clad masses, areas, and conductances derived from rod geometry (cladThickness now a component field, default 0.6mm); clad is the surface the boiling curve sees. CladdingOxidationRateOperator (Baker-Just Zr-steam kinetics, exothermic heat, H2 to coolant NCG) wired into the game loop and test harnesses; oxidation state attached to every player-built core's clad node. Prompt-crit test now drives clad to ~920C through the boiling crisis - fuel-damage sequences are live.
X Display cleanup batch: PID controller cabinets show their loop label/mode/setpoint (no more universal "SCRAM"/"NO CORE"); reactor thermal power shown on the RPV graphic and detail panel in MWt and % of rated (player-built cores' thermalPower now actually sets nominalPower); Heat Transfer panel reads live RK45 convection rates instead of the dead Euler diagnostics map; elevation labels small/black/at component base; fuel rods drawn from the core barrel's activeFuelHeight and limited at construction to fit the barrel; toolbar speed display tracks auto-slow and its recovery ramp, RT ratio now measures achieved speed vs wall time; rod slider becomes a tracking indicator while an auto rod controller owns the rods; obsolete "hybrid" pressure model removed from the UI, K_max applied on init.
X Fix the way cylindrical buildings are displayed. The outline moves around, and the back wall really should look like half a cylindrical shell. (footprint ellipse now projects the true center/axis endpoints; backdrop is a cylinder silhouette with curvature shading)
X Feedwater check valves in the PWR and BWR presets (val-fwcv-1 between FW pump and SG/RPV): a stopped feed pump facing the 60-bar SG / 72-bar RPV leaked ~20 kg/s backward through the reverse-block friction; the check valve holds it to zero. scripts/pwr-test.json kept in sync.
X Reactivity coefficients derived from core geometry (lattice-lite four-factor model, simulation/lattice.ts): enrichment + fuel material are user settings (default 5% UO2); Doppler/density coefficients and excess reactivity come from rod size/count/pitch/core size. Natural uranium correctly fails in light water; over-moderated lattices flip the density coefficient sign. Player-built cores use it; presets keep validated explicit values.
X SG/core heat transfer fixed on the RK45 path: wetted-area split by liquid level, Thom nucleate boiling h with smooth Zuber CHF saturation, per-tube/rod characteristic diameters, tube areas from real geometry (pi*d*L*N). SG UA went ~3 -> ~35 MW/K; the PWR preset now converges to ~100% power under its controllers, and the shipping pwr.json preset ships with the full auto-control suite.
X Decay heat: 4-group fission-product pools (coarse ANS-5.1 fit) build with power history and keep ~5%/3%/1.5% of prior power flowing at 10s/100s/1000s after shutdown. Scrammed cores now need cooling.
X Fully implicit (RELAP-style) pressure-flow momentum solver - default on, explicit path selectable. Presets now run 20-30x realtime (two-loop PWR went 0.17x -> ~17x). See docs/semi-implicit-flow-solver-plan.md Outcome section.
X Improve performance (why are timesteps getting so small?) - acoustic modes of liquid loops; removed by the implicit momentum solver.
X Reactor power was never deposited into the fuel node for factory-built cores (no Doppler feedback at all); fixed along with point-kinetics overflow during prompt-supercritical excursions.
X Heat transfer in a HX should depend on liquid level. In the core too. In a way that makes physical sense.
X How much pressure can things handle from the outside?
X Ability to put things inside other things, e.g. containment building, or cross-vessel with internal hot leg
X If I build a building around existing stuff, put it inside
X break at random elevation. Maybe show a hole? with the red box around it
X make the red box big enough for the text
X arrows for break flow
X Choked flow
X Add LOCA capability (atmosphere as boundary condition)
X Make pipes, tanks, etc. rupture on high pressure (dependent on thickness)
X When you create a component you specify pressure rating but the actual break pressure should have a random element as well (let's say 0-40% higher than specified). This is randomized at the start of the simulation and stored.
X Add containment building as an option
X Non-condensible gases (air, hydrogen, helium, maybe co2, maybe co)
X When you are building we will show a running estimate of "overnight construction cost" and then when you finish the design you press build and immediately take out a loan for that amount
X There should also be a sandbox mode where you have infinite money. That's the one we're doing first.
X When I move a pipe I can only move the "from" end, the "to" end seems to be stuck in place. Let me position both ends in 3d from the edit menu.
X Back up a timestep feature, and periodic state-saving
X Some kind of semi-implicit fluid flow/pressure calculation
X Debug panel should show what RK45 operator-component combination(s) contribute most to limiting the timestep
X Refactor to make reactor vessel a component that contains a core barrel instead of having core and annulus as siblings
X Wall thickness rendering for tanks and pipes should match their pressure rating
X Show connections starting from their listed elevation.
x Add an abort if there's super high RK45 error instead of plowing through and pretending to advance the sim
X Pump head accounts for NPSH
X The numbers with flow arrows should be black not white.
X Flow arrows are not located at the connections and not pointing the way flow is going. 
X Below u=30 density starts to go up as it gets colder; this affects determination of two-phase.
X Water level should account for volume of any components contained.
X Debug condensate pump connection to always draw from the very bottom.
X Display issue: when one reactor region is liquid, they both look like liquid (all blue) visually
X Allow bubbles in the liquid space and droplets in the vapor space of a two-phase component.
X Debug new steam table
X Switched to custom steam table that should be more stable for compressed liquid.
X Initial pressure can't be higher than pressure rating. Maybe 95% of pressure rating (nah)
X the condenser ports are in the right position now, but the pipe ports are offset by L/2. Remember that pipe position is at one end, not in the middle.
X If you zoom in on the red and green ports you should be able to see a white arrow in them pointing towards or away from the component center.
X Pipe (non-auto) and condenser have their ports too close together. They should have one on each end.
X Most components don't need their connection ports to be red/green; only if they have directionality like a pump or turbine. Fix pipe, condenser, reactor vessel. Pressurizer is ok as is.
X Debug condenser not removing heat.
X Got rid of old Euler method code that was causing problems.
X Labels under the generator and condenser say 0 MW even when they're not.
X Pressure gauges should come from the tops of the components
X Condenser should have a pressure rating, but a low one.
X Visual rendering of the core doesn't seem to match its diameter. Height is ok.
X Turbine power calculations have a unit conversion problem for the edit menu
X In construction mode, delete button should bring up the delete confirmation for the selected component (if any)
X Core exceeds available space 3.30 m, when barrel ID is 3.35 m.
X If I'm placing a component and I click on an existing component, the options should be "place inside" or "cancel" not "place normally"
X User-editable scram logic (Scram controller component)
X Resolve some issues with high outward flow rate persisting despite almost no mass left in pump.
X Limit flow into or out of a node based on the fraction of its mass. Goes in the RK45 derivative calc?
X Warning before saving over something
X Successful save should close the dialog
X Selecting a pump does not show you its current head or rated head or flow, or current or rated speed, or even its quality. (confirm if quality shows up now when the pump is two phase)
X Add visual scram indicator (should say time and reason for scram)
X Preload water triangulation asynchronously
X Pumps are "running" but speed and pump head stay at 0.
X The debug panel used to show pump head next to any flow connections with pumps on them, what happened to that?
X What does it mean when a connection turns orange?
X Pumps are drawn upside down when you switch them to right->left; they should be mirrored instead.
X Pumps should have a better drawing and also a big arrow showing which way they point. And ability to turn them around in construction mode.
X Fix the pressure gauges so they come off the top of each component
X Change the pressure gauges to display the number in the center and add a sig fig (down to .1 bar) and then instead of the white dial arm have the colored ring around the edge just go up to where the dial would be.
X Bring back flow arrows and pressure gauges like they were in the demo plant
X Simulation started running while I was in construction mode. Keyboard shortcuts shouldn't work in construction mode.
X Minimum connection length doesn't seem to be correct (it's sometimes less than the elevation difference) and also doesn't seem to be enforced. Also if one component is inside the other, the minimum connection length should never be more than 1 m regardless of the distance between ports.
X Show the "ground" in the display
X Add U-tube heat exchangers as an option. Also horizontal and vertical once-through HXs.
X Calculate efficiency (turbine work output) in a more realistic way
X Condenser should be drawn much bigger dependent on its volume
X Condenser should default to 0 elevation. Negative requires excavating which we haven't implemented.
X Turbine should be drawn somewhat bigger and flipped around
X Turbine should be able to connect to a generator, not as a hydraulic connection
X Show connections between portions of the vessel as holes in the barrel top/bottom. 
X Add manual reset of scram
X Allow multiple cores
X User-constructed plant should run in the simulation; debug panel modified accordingly.
X User should be able to save a configuration (can we save it in a cookie or something?)
X Fix hybrid pressure model to reduce discontinuities
X Fix double-display of SG secondary side (HX shell side)
X Display the full control rods even when they're not fully inserted (the non-inserted part can extend above the core).
X Core should allow the user to specify number and diameter of fuel rods, cladding thickness, materials, etc. And total core diameter, which will determine the rod spacing. Also number of control rods, and whether they enter from the top or bottom. Not number of assemblies, and not burnup (since we're ignoring outages and refueling). "Control rods" can be assumed to mean either blades or spider assemblies because they're functionally equivalent.
X Core display should not include the surrounding water, just the core and the fluid between rods.
X A core should only have two ports, i.e. assume it comes with a core barrel.
X Add the ability for the user to create components and connect them (construction mode)
X And specify their initial properties
X In the construction mode where the user can select components, the condenser component should just always include a condensate pump. There's no reason you'd ever want a condenser without one. (as far as I know)
X Debug flow calculations (exceeding max)
X Finish debugging quality calculation - there are still cases where x_u and x_v don't match perfectly.
X Add flow momentum for numerical stability
X Show connections between components on the display (matching fluid flows)
X Make fluid mass match its density based on temperature & quality
X Figure out a decent way to approximate steam tables
X Keep the number displays from flickering so much, especially power
X Make arrows in pipes proportional to flow velocity
X Add time speed control for during simulation
X Change water temp display so dark blue is sat - 50 C
X Add check valves
X Add better secondary side modeling (turbine, condenser)
X Flow connections should have a specified elevation and check if it's above or below the liquid level in a tank, and transfer saturated liquid/saturated steam/mixture as appropriate.

