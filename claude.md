## RULES - always follow
- DO NOT pipe npx output into head or grep. It fails every single time. Use && instead of pipes.
- Always use backslashes (\) in file paths on Windows. File edits will fail if you use forward slashes.

## PROJECT GUIDELINES
This project is intended as a sandbox environment with game-like aspects, to allow users to experiment with a wide variety of reactor designs. We don't need perfect accuracy, but I want all the qualitative behavior to be physically plausible, so a knowledgeable engineer looking at the simulation would not be able to tell anything is off unless they check the numbers. That also means it needs to be robust to weird configurations and poorly set up initial conditions by having a fully internally consistent physics model. It is best to avoid special cases, hard-coded values, thresholds, hysteresis, and other simplifications that may cause unstable simulation behavior. If normal methods fail (especially related to calculating water properties) any fallback assumptions must come with a very noticeable error message. Don't clamp anything. If simplifications or heuristics are needed, please discuss with me before adding them. Although we are using a PWR-like setup for testing, this is not a "PWR simulator" and none of the hydraulic components have special roles. All the physics needs to be robust to all configurations the user might throw at us. To get there, we should follow the "anti-robustness principle" - fail loudly so we can find the source of the problem. Do not add band-aids.

## WATER PROPERTIES NOTES
- Our saturated steam table data goes all the way from the triple point to the critical point.
- It is critical to determine phase PURELY by comparing whether a node's (energy, volume) pair is inside the saturation dome in (u,v) space. Any thresholds, approximations, or special case rules will cause problems down the line.

/*
TODO:
X Show connections between components on the display (matching fluid flows)
X Make fluid mass match its density based on temperature & quality
X Figure out a decent way to approximate steam tables
X Keep the number displays from flickering so much, especially power
Fix double-display of SG secondary side
Figure out why power increases after a scram? Just fix neutronics in general, something about it isn't right anymore.
Add the ability for the user to create components and connect them
And specify their initial properties
In the sandbox/construction mode where the user can select components, the condenser component should just always include a condensate pump. There's no reason you'd ever want a condenser without one.
X Make arrows in pipes proportional to flow velocity
Position the arrows at the flow connections (each tank & pipe should get up to 4 connection locations: ends & middle). E.g. the hot leg connection to the pressurizer should have an arrow that points up or down, and it should be near the top-center of the hot leg not at the end.
Display the full control rods even when they're not fully inserted (the non-inserted part can extend above the core).
X Add time speed control for during simulation
X Change water temp display so dark blue is sat - 50 C
Pixelated display should apply to the tube side of a HX
Add manual reset of scram
Add visual scram indicator
Add LOCA capability
Add check valves
Add better secondary side modeling (turbine, condenser, FW heaters)
Add ability to wait for random initiating event (once steady state is achieved)
Add money system based on generation (in game mode)
There should also be a sandbox mode where you have infinite money
Add cool visuals for different initiating events
Add containment building as an option
Model tank and pipe overpressure
Model vessel creep rupture and SG tube creep rupture
Model core-concrete interaction
Add cladding oxidation and hydrogen explosions
Show the "ground" in the display? And maybe the UHS?
Steam separators? Maybe not
User editable Scram logic and system actuation
"Operator actions" initiated by the user (with delay and progress bar)
Diesel generators (and electric power in general)
Add fuel melting and radionuclide release ("meltdown!")
Show power in MWt along with %
Add advanced reactor options (pebble bed fuel, helium or metal coolant)
Clean up the debug display
Fix the pressure gauges so they come off the top of each component
Change the pressure gauges to display the number in the center and add a sig fig (down to .1 bar) and then instead of the white dial arm have the colored ring around the edge just go up to where the dial would be.
Maybe find a good way to display relative pressure at connections
*/