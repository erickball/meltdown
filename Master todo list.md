## TODO List
AI:
-AI assistant to help users add to, fix, or understand the model (use sonnet 5, cap usage at $10/month. context: a bunch of game documentation, the current plant model - full list of components and their connections and properties, the last few changes the user made, what mode they're in, and the most recent simulation results for this model (if any). Also the ability to look at the code but let's try to make the documentation good enough it doesn't usually have to.)
-and Sonnet plays the character of "Atom" Jack, head of operations at your primary EPC contractor Atom Enterprises. Jack knows this is all digital but doesn't bring it up unless the user does first. He has a colorful irreverent personality and likes to refer to himself as "just the plumber" and similar, although he does understand the engineering pretty well. He can help with creating customized components (e.g. "add a relief valve to this tank" and he can come up with reasonable sizing and setpoints and add the component to the model). Please write a good character prompt to make him fun to talk to (but not so overboard that it gets annoying). Jack stands in the bottom right corner of the screen (head visible, hard hat says Jack), and a chat box next to his head that expands when you click on it, and then he introduces himself.
-Firebase has my API key.


Playtest follow-ups (2026-07-14) - REMAINING:
-Steady-state MWe rose with the baked pipes (pwr family now settles ~524 MWe vs ~437, startup MWe spikes bigger too: peaks 1700-2400 MWe through the turbine during the first seconds). All levels/tests pass; worth a look at whether the turbine conversion is too generous and whether the startup spike should be tamed.
-HTGR now converges ~10% above rated after a damped slosh from the added He loop volume (109% at 300 s, still settling). Cosmetic; retune nominal or accept.


Display & minor issues:
-Need a better way of deciding whether a node has separate liquid and vapor spaces, or is mixed. Or has a vapor space and a mixture space. Something about its height to width ratio and flow rate? This affects display but also flow through flowpaths at the top or bottom. (the system we have now incorporates some of this, but the results seem hit-or-miss. Needs work.) Maybe the better option is a legit two-phase level?
-Clean up the debug display (light pass done: per-frame [Sync] console spam removed; panel itself still busy)
-Maybe find a good way to display relative pressure at connections
-BWR preset: two loops sit saturated instead of regulating - governor holds ~98.6 bar dome pressure against a ~72 bar setpoint, and the RPV level controller reads level 7.5m above setpoint with the FW pump pinned at max while inventory is actually steady (suspect nodeLiquidLevel on the mostly-liquid two-phase RPV). Plant is stable at 100% power regardless; needs investigation, not urgent.
-Two-loop preset settles at ~103% (rod controller pinned by its 100% withdrawal permissive while T_cold is below setpoint) - stable, cosmetic; lower the T-cold setpoint or accept.
-Pebble-bed cores still render as fuel rods in the vessel graphic (display-only gap).
-Maybe show the UHS as a river or ocean?
-Maybe to put anything at negative elevation you should first have to "dig" voxels out Minecraft-style
-Maybe you can build seismic supports under things to give them earthquake resistance. So anything elevated off the ground should by default have a real spindly scaffold holding it up, and then you can optionally beef it up.


Modeling gaps:
-Model core-concrete interaction
-Hydrogen explosions (H2 generation from cladding oxidation is done and released as NCG; combustion/deflagration when it meets air is not modeled yet)
-Diesel generators (and electric power in general)
-Meltdown remaining: molten fuel relocation/corium (slumping to the lower head, geometry change, molten pool heat transfer to the vessel wall - feeds the creep-rupture wall temperature); aerosol pool scrubbing/condensation washout and resuspension (dry settling is modeled).
-Advanced reactors remaining: metal coolant (sodium/lead - needs a second liquid property system, big); direct Brayton cycle (turbine operator assumes steam - gas loops must use an HX + steam secondary for now); graphite air-ingress oxidation/fires.
-Auto-sized burnable poison ignores initial soluble boron: a PWR-style borate-then-dilute cold start would want the poison sizing to credit boron at the initial conditions (and construction may not expose initial boron ppm at all). Bank-count rod worth covers the BWR-style path already.

Game mode:
STATUS (game-mode branch): first playable shipped - 4 levels, title screen, career save.
See docs/game-mode-design.md for the design and src/game-mode/ for the code.
Done on the branch: build lock-in pricing (75% salvage / diff+10% work fee / 25% burst
repair fee), money from generation ($/MWh with day-night price curve, loan interest,
"fiscal compression" 1 sim-min = 1 fiscal day), random + scripted failures (pump trips,
turbine trips, LOCA/SGTR through the real burst physics, price spikes/crashes),
radiological release source-term reporting (moles + becquerels released; a
severity index sets each level's release limit) + accident/bankruptcy
sequences with the boss rant,
corny 90s dialogue scenes (pixel portraits, typewriter, WebAudio chiptunes),
operator actions panel (click a pump/valve/controller in sim mode; 20s walk-out
delay with progress bar). Level 1 is the "reactor for an existing secondary" build.
Still open from the list below:
-Option to test a design in steady state before you "build" it
-Waiting-for-initiating-event mode (events are currently poisson-timed while generating)
-Cool visuals for different initiating events
-Control room concept beyond instant-vs-walk-out actions
-Operating cost estimates (fuel use, employees); interest rates ARE in
-Skyline fills with buildings as the region grows
Original notes:
-In game mode, after you press build, you're locked in and additional changes will cost more. Deleting a component gets you 75% of the cost back. Editing one you just have to pay the difference in value minus a 10% work fee, and if the new version is cheaper you don't get anything back. But maybe you should get an option to test a design in steady state before you "build" it.
-Add ability to wait for random initiating event (once steady state is achieved)
-Add random failures for active components
-Add money earning system based on generation (in game mode). 
-After an accident you get told how much radioactive material you released to the environment. Then you go to "Out For Repairs" (construction mode, basically) and your boss gives you a little angry rant about the interest accumulating by the millions every day. But there's no actual time limit. For the game-flavor sequences (intro, post-accident, story progression, etc.) I'm thinking kind of a corny pixelated 90s-game aesthetic, where it's some text you click through, some MIDI music, and a two-frame animation of a cartoon person with different expressions depending on what's happening. The boss character is kind of a stereotype of a fat-cat 1960s-70s businessman who hates environmentalists, safety concerns, and the government.
-Some kind of simplified consequence/source-term model for releases
-Add cool visuals for different initiating events
-Maybe something about a control room, but I don't want the user to have to worry about this a lot
-"Operator actions" initiated by the user (with delay and progress bar) by clicking on a pump or w/e
-We can do operating cost estimates based on fuel use, number of employees (how many do you need for maintenance of this many components, etc). But we're glossing over outages.
-We could even account for interest rates? Maybe

-Level 1, we give you a turbine generator condenser and FW pump, and you just basically have to create a vessel and core and hook them up and you've got power. Maybe it's for like, an emergency situation or an isolated island community or something? Maybe I don't need that much story. A mining operation might be better.
-As you get farther along and are more successful, the skyline starts to fill up with buildings showing local population increase.

## To-Don't List
-Steam separators? Maybe not. What's the point
-How hard would it be to have the liquid and vapor spaces get separate temperatures, like MELCOR does? Do we need this, maybe for pressurizer spray to work right? Probably not it sounds like

## Done List
X Pipes baked into every preset and game level (2026-07-14): scripts/bake-pipes.cjs splits all connections over the auto-pipe rule (area>0.1 && len>1, internal vessel/barrel connections exempt) into real pipe components with edge-attached routing (pipe ends at each component's footprint edge facing its partner), inherited fluid (same-phase avg T/P, donor for mixed, NCG carried when both ends have it), split length/K-factor, containment membership, and engineering ratings: vacuum ducts floored at 6 bar, turbine exhausts specced to turbine inlet pressure (the startup spike measurably hits ~8 bar), hot-gas ducts (>650 K) rated for a ~0.3 creep-stress ratio with ASME-consistent wall thickness (unrated 700C He hot legs creep-ruptured in seconds - physics working as intended). Fixed en route: TurbineCondenser operator identified condensers BY NAME ("...condenser" matched the new "Pipe: Turbine to Condenser" labels and crashed on missing heatSinkTemp) - now detected by carrying heatSinkTemp; flow-arrow velocity used water-only density (He loops read 100000+ m/s) - now includes NCG mass; velocity halo thresholds raised above normal service (liquid 20/35 m/s) so nominal RCS flow doesn't flag. Layout: FW/condensate trains moved out from behind the turbine/condenser, controller cabinets 2.5m on a 2-column grid with title lines that no longer collide with the status panel, two-loop SG B and w4loop accumulators pulled inside containment, coincident pipe pairs (BWR recirc) offset perpendicular. w4loop added to the preset menu. Verified: all presets run 300 s headless at power (pwr 88%->climbing, two-loop 100.0%, bwr 99.5%, htgr ~109% settling, w4loop 86% climbing, sbo/prompt-crit/meltdown behave as designed - prompt-crit's RPV burst predates the pipes), 25+10 unit tests and all 4 level convergence tests PASS. Vessel/pressurizer 100-bar minimum rating and 0.02 m barrel-thickness dialog minimums relaxed to physical floors with guidance moved to help text.
X Playtest batch 2026-07-13 (all four level tests still PASS): auto-pipe fluid init inherits real averaged T/P when both neighbors share a phase (was saturated-correlation u-v averaging that dropped pressure -> two-phase pipes, t=0 water hammer); RCP "connected to FW check valve/condenser" was substring id matching (pump-1 matched fw-pump-1/cond-pump-1) in the detail panel + edit lookup, now exact/prefix matching; selecting a component highlights its connections in yellow on the canvas; preset loads now run normalizeLoadedPlant (port.connectedTo flags, canonical pump port geometry + auto-orient); pump port table's rotated orientations matched to the renderer's rotation convention (was mirrored 90-degrees off); pressurizer safety valve + relief tank added to pwr and two-loop presets; controller cabinets spread into a 2x3 grid (were a 1-unit-gap stack); flow areas shown in m2 everywhere (was cm2 in edit dialog + sim detail panel); burst toasts hold 30 s w/ dismiss + persistent MAJOR EVENTS log in the HUD (per-entry dismiss, survives collapse); Level 1 target 25->15 MWh + one-shot speed-control hint when steady >150 MWe at 1x; Level 2 goal reworked to "60 MWh + ride through 2 casualties" (scripted pump-trip AND turbine-trip, failed scripted events re-defer instead of burning their slot, recovery = back >150 MWe 30 s after the hit); outages restore the design's initial conditions from a run-start snapshot (sim writeback no longer leaks into the next run); HUD hide button pinned to the HUD's upper-right; early levels show a filtered parts palette with SHOW ALL toggle (LevelDef.palette); save/load can now carry the RUNNING simulation (serializeSimulationState round-trips every Map incl. burst states + controller memory; save dialog includes it in sim mode, loading resumes paused at the saved time); over-design-pressure gauges flash red; high-velocity/choked connections get a pulsing halo + m/s label; pump ring color shows curve position (red deadhead -> green rated -> blue runout) + detail-panel pump curve with live operating point; Jack can file Corrective Action Reports (file_car tool -> fileCar function -> jack-cars Firestore collection, localStorage fallback offline).
X Reactivity reference values eliminated for lattice-derived cores: reactivity is now (k-1)/k from latticeKeff at the LIVE fuel temp + coolant density every step (no linearization; exact for voiding, cold-to-hot swings, hot fuel). Fixed en route: player-built cores had ~+3500 pcm phantom feedback (coefficients derived at build-state, refs hardcoded 887K/520K/750kg-m3). Burnable poison is a user setting (auto-size default leaves ~1000 pcm shutdown margin with rods full-in at initial conditions); presets' excessReactivity still works as a poison target. Fast-fission floor keeps voided lattices finite (was the "voided-core guard" gap). Both operators + factory t=0 share one computeReactivityComponents.
X Control rod worth derived from bank count (each bank adds absorber into the lattice's thermal-utilization competition): ~1700 pcm/bank on the reference PWR lattice, 4 banks = PWR-like 6800 pcm, 10 banks = BWR-like 17000 pcm (cold shutdown on rods alone, survives the cold-to-hot swing). CRDM cost scales with banks x core size. Core dialog shows est. rod worth + avg linear heat rate (kW/m or kW/pebble, warns when high).
X Default initial rod position = critical: startCritical checkbox (default on) solves rods for exactly rho=0 at the initial conditions (both feedback paths, boron included). Fixed en route: construction stored controlRodPosition INVERTED vs the sim/renderer/preset convention (0=inserted,1=withdrawn) - manual rod positions ran backwards from what the player typed.
X Make auto-slow less aggressive, it's only supposed to be for big events and there should be some obvious indication of why it slowed. (default threshold 10%->50%, warning notification names the quantity and rate)
X Start off paused when switching to simulation mode.
X HUD collapse/expand button should say hide/show along with the arrow, and when collapsed it should still show level number, budget/spent, and the build it button.
X Advanced solver settings should be collapsed by default, and also should go at the bottom, as should the auto-slow setting.
X Run 1 step button should go in the advanced solver settings
X The Rods AUTO button doesn't need to be on its own line, it should fit next to the Control Rods section title.
X Water/steam coloring by internal energy: all fluid colors derive from u - deep blue cold liquid -> white at the critical-point energy (~2030 kJ/kg) -> very pale yellow at max saturated vapor (~2604) -> yellow/orange superheat. Two-phase liquid/vapor pixel split (u_f vs u_g) fades naturally near critical pressure. Legend samples the same stops.
X Thermometers on large hydraulic nodes (>=5 m3): mercury-style column, fixed 0-400C scale with ticks + numeric readout, positioned beside the pressure gauge.
X UI for melt fraction and radiological release: core-damage banner (fuel melt %, FP escape %, environment Xe/CsI as % of core inventory - orange in-plant, red on environmental release); debug shows per-node molten/oxidized/FP-release %, plated-out CsI, and an environment release breakdown. fissionProducts records initial inventory so fractions are exact.
X Construction-mode UI for PID controllers + rod manual/auto toggle: placeable 'PID Controller' with sensor/actuator pickers, plant-derived target dropdowns, per-kind setpoint fields in display units, stroke time -> rate limit, reverse-acting flag, output min/max, rod power permissive; confirm-time validation. Rods: AUTO/MANUAL button bumplessly hands the slider control back and forth.
X Construction-mode pebble/helium core options: Fuel Form selector (rods vs TRISO pebbles) with pebble diameter/count/HM-per-pebble/reflector fields + 61%-packing suggested count; cladThickness now editable for rods. Fixed en route: fuel design (enrichment/material/rod geometry/thermal power) never transferred to the core barrel for player-built RV cores (sim silently used defaults); initialLevel=0 now builds a vapor fill (gas vessels possible from the UI); RV initialNcg now reaches the core barrel. A helium pebble-bed RV builds end-to-end from the dialog.
X Boron/soluble poison as an operator control + estimated-critical-position display: 0-3000 ppm slider slewing at 0.5 ppm/s (CVCS-ish), worth -8 pcm/ppm scaled by in-core water density - so high-boron voiding adds reactivity (positive-MTC failure mode enabled). Debug shows boron pcm and the rod insertion at which rho=0 under current conditions.
X Vessel + SG tube creep rupture (and "failure temperature" generally): burst states accumulate Larson-Miller time-fraction damage using stress ratio P/P_burst - no new geometry, works for every pressurized component. Operating plants: astronomical rupture times; SG tubes at ~950K under full dP: minutes (TI-SGTR); depressurized hot vessel: hours. Fails through the normal burst path with a small initial break. HX tubes read their metal node temperature; others use fluid T as the wall proxy.
X CsI aerosol deposition/plate-out: first-order settling in every node (lambda = v_settle/height, Stokes 3um agglomerate ~1.1 mm/s -> ~2h half-life at containment scale), exactly conservative into FlowNode.depositedCsI. Plated activity stops riding gas transport to the environment.
X Decay heat follows released fission products: the volatile ~30% share of decay power migrates with the Xe/CsI - deposited into whatever nodes hold it (airborne or plated), lost with moles that reached the environment; fuel keeps the non-volatile balance.
X Wire auto-tuned controllers into the BWR and two-loop presets: BWR already had its suite and holds 100.0% (verified 600s headless; two saturated loops noted above). Two-loop was collapsing to zero power with dry SGs by ~400s - it fed both SGs from one pump with no check valves and level control on SG A only; now each SG has its own half-size FW pump + check valve + 3-element level controller and it converges to a steady ~103% with matched SG inventories.
X Add FW heaters - we already solved this by deciding they're just heat exchangers, and turbines can have extraction steam outlets
X Fuel melting and radionuclide release, first stage ("meltdown!"): thermal nodes with meltingPoint/latentHeatFusion get an apparent-heat-capacity latent plateau (temperature stalls while m*L is absorbed; melt fraction DERIVED from T, no new state, no thresholds) - fuel (UO2 2800K / metal U 1405K) and Zircaloy clad (2100K) have it; every operator converts watts to dT via nodeHeatCapacity(). FissionProductReleaseOperator: CORSOR-style Arrhenius release from hot fuel (negligible <1300K, ~1%/20min at 1600K, minutes at melting) of the equilibrium inventory (700 mol noble gas + 250 mol volatile per GWt) into the coolant NCG as Xe and new CsI aerosol species (rides gas transport through breaks/valves/containment; magenta, excluded from fill-gas picker); old saves safe via ??0 guards. state.environmentalRelease integrates NCG crossing boundary nodes - the radiological source term. scripts/test-fuel-melt.ts covers plateau energy bookkeeping, melt fraction, release rates/conservation; scripts/sbo-test.json is a station-blackout severe-accident scenario.
X Gas-cooled pebble-bed reactors end-to-end (simulation/JSON level): lattice model extended with solid (graphite) moderation, dispersed-TRISO Doppler (kernel-scale self-shielding), and reflector savings - nat-U works in a graphite pile but not light water, helium LOCA inserts <50 pcm, water lattices bit-identical. Flow stack made gas-competent: bulk/vapor densities and pump head include NCG mass (gas circulators develop rho*g*H head), total-mixture flow split between water and NCG by flowing-phase composition (NCG advected with Cp enthalpy), FluidState NCG+water iteration handles full evaporation (no more 647 K pin on hot gas loops), vapor-side HTC blends steam with the actual gas mixture (He conducts ~5x better), per-species k/mu in gas-properties. coreBarrel/pump/valve/HX-tube accept vapor-phase + initialNcg fills; pebble cores get kernel fuel node + graphite matrix node (near-isothermal, the walk-away-safe heat sink) and coolant volume/flow area shrink to the packing voids. scripts/htgr-test.json: 250 MWt helium pebble-bed with steam secondary runs at 3.5x realtime, 144 kg/s He, critical with derived coefficients. Remaining pieces tracked in the Advanced-reactors line above.
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

