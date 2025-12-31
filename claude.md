
## PROJECT GUIDELINES
This project is intended as a sandbox environment with game-like aspects, to allow users to experiment with a wide variety of reactor designs. We don't need perfect accuracy, but I want all the qualitative behavior to be physically plausible, so a knowledgeable engineer looking at the simulation would not be able to tell anything is off unless they check the numbers. That also means it needs to be robust to weird configurations and poorly set up initial conditions by having a fully internally consistent physics model. It is best to avoid special cases, hard-coded values, thresholds, hysteresis, clamping, and other simplifications that may cause unstable simulation behavior. If normal methods fail (especially related to calculating water properties) any fallback assumptions must come with a very noticeable error message. Don't clamp anything. If simplifications or heuristics are needed, please discuss with me before adding them. Although we are using a PWR-like setup for testing, this is not a "PWR simulator" and none of the hydraulic components have special roles. It can also do BWRs, advanced reactors, or new and weird ideas for reactor designs. All the physics needs to be robust to all configurations the user might throw at us. To get there, we should follow the "anti-robustness principle" - fail loudly so we can find the source of the problem. Do not add band-aids.

## TODO List
-What does it mean when a connection turns orange?
-Most components don't need their connection ports to be red/green; only if they have directionality like a pump or turbine.

-When you are building we will show a running estimate of "overnight construction cost" and then when you finish the design you press build and immediately take out a loan for that amount
-There should also be a sandbox mode where you have infinite money
-Non-condensible gases (air, hydrogen, helium, maybe co2, maybe co)
-Clean up the debug display
-Maybe find a good way to display relative pressure at connections
-Position the arrows at the flow connections (each tank & pipe should get up to 4 connection locations: ends & middle). E.g. the hot leg connection to the pressurizer should have an arrow that points up or down, and it should be near the top-center of the hot leg not at the end.
-Pixelated display should apply to the tube side of a HX
-Figure out why power increases after a scram? Just fix neutronics in general, something about it isn't right anymore.
-Add visual scram indicator (should say time and reason for scram)
-Add LOCA capability (atmosphere as boundary condition)
-Make pipes, tanks, etc. rupture on high pressure (dependent on thickness)
-When you create a component you specify pressure rating but the actual break pressure should have a random element as well (let's say 0-40% higher than specified)
-Things could also have a failure temperature. Or maybe this is just creep rupture.
-Ability to put things inside other things, e.g. containment building, or cross-vessel with internal hot leg
-Add containment building as an option
-Add FW heaters?
-Heat transfer in a HX should depend on liquid level. In the core too. In a way that makes physical sense.
-Need a better way of deciding whether a node has separate liquid and vapor spaces, or is mixed. Or has a vapor space and a mixture space. Something about its height to width ratio and flow rate? This affects display but also flow through flowpaths at the top or bottom.
-Improve performance (why are timesteps getting so small?)
-Maybe something about a control room, but I don't want the user to have to worry about this a lot
-Let the user implement automated logic for controlling stuff
-Add ability to wait for random initiating event (once steady state is achieved)
-Add random failures for active components
-Add money earning system based on generation (in game mode). 
-Add cool visuals for different initiating events
-Model vessel creep rupture and SG tube creep rupture
-Model core-concrete interaction
-Add cladding oxidation and hydrogen explosions
-Maybe show the UHS as a river or ocean?
-Steam separators? Maybe not
-User editable Scram logic and system actuation
-"Operator actions" initiated by the user (with delay and progress bar) by clicking on a pump or w/e
-Diesel generators (and electric power in general)
-Add fuel melting and radionuclide release ("meltdown!")
-Show power in MWt along with %
-Add advanced reactor options (pebble bed fuel, helium or metal coolant)
-We can do operating cost estimates based on fuel use, number of employees (how many do you need for maintenance of this many components, etc). But we're glossing over outages.
-We could even account for interest rates? Maybe
-We should make a pebble bed core option, too
-Not sure how to handle needing big graphite reflectors though?
-Show connection starting from their listed elevation.


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

## WATER PROPERTIES NOTES
- Our saturated steam table data goes all the way from the triple point to the critical point.
- It is critical to determine phase PURELY by comparing whether a node's (energy, volume) pair is inside the saturation dome in (u,v) space. Any thresholds, approximations, or special case rules will cause problems down the line.
- Representing the dome boundary as a single curve that concatenates the saturated liquid and saturated vapor lines DOES correctly represent the two-phase region. Testing whether u < u_sat(v) is the ONLY valid way to determine if a node is two-phase.
- If we ever fail to find a good match between x_u and x_v, we need to stop and throw a big error message. Do NOT use any fallback assumptions.

