## RULES - always follow
- DO NOT pipe npx output into head or grep. It fails every single time. Use && instead of pipes.
- Always use backslashes (\) in file paths on Windows. File edits will fail if you use forward slashes.

## PROJECT GUIDELINES
This project is intended as a sandbox environment with game-like aspects, to allow users to experiment with a wide variety of reactor designs. We don't need perfect accuracy, but I want all the qualitative behavior to be physically plausible, so a knowledgeable engineer looking at the simulation would not be able to tell anything is off unless they check the numbers. That also means it needs to be robust to weird configurations and poorly set up initial conditions by having a fully internally consistent physics model. It is best to avoid special cases, hard-coded values, thresholds, hysteresis, clamping, and other simplifications that may cause unstable simulation behavior. If normal methods fail (especially related to calculating water properties) any fallback assumptions must come with a very noticeable error message. Don't clamp anything. If simplifications or heuristics are needed, please discuss with me before adding them. Although we are using a PWR-like setup for testing, this is not a "PWR simulator" and none of the hydraulic components have special roles. All the physics needs to be robust to all configurations the user might throw at us. To get there, we should follow the "anti-robustness principle" - fail loudly so we can find the source of the problem. Do not add band-aids.

## WATER PROPERTIES NOTES
- Our saturated steam table data goes all the way from the triple point to the critical point.
- It is critical to determine phase PURELY by comparing whether a node's (energy, volume) pair is inside the saturation dome in (u,v) space. Any thresholds, approximations, or special case rules will cause problems down the line.
- Representing the dome boundary as a single curve that concatenates the saturated liquid and saturated vapor lines DOES correctly represent the two-phase region. Testing whether u < u_sat(v) is the ONLY valid way to determine if a node is two-phase.
- If we ever fail to find a good match between x_u and x_v, we need to stop and throw a big error message. Do NOT use any fallback assumptions.

## TODO List
    why do we have computeTargetFlow? is it different than
    const steadyStateFlow = sign * rho * A * v_steady;
    and do we use it anywhere?

-Add the ability for the user to create components and connect them (construction mode)
-And specify their initial properties
-In the construction mode where the user can select components, the condenser component should just always include a condensate pump. There's no reason you'd ever want a condenser without one. (as far as I know)
-When you are building we will show a running estimate of "overnight construction cost" and then when you finish the design you press build and immediately take out a loan for that amount
-There should also be a sandbox mode where you have infinite money
-Clean up the debug display
-Fix double-display of SG secondary side (HX shell side)
-Display the full control rods even when they're not fully inserted (the non-inserted part can extend above the core).
-Fix the pressure gauges so they come off the top of each component
-Change the pressure gauges to display the number in the center and add a sig fig (down to .1 bar) and then instead of the white dial arm have the colored ring around the edge just go up to where the dial would be.
-Maybe find a good way to display relative pressure at connections
-Position the arrows at the flow connections (each tank & pipe should get up to 4 connection locations: ends & middle). E.g. the hot leg connection to the pressurizer should have an arrow that points up or down, and it should be near the top-center of the hot leg not at the end.
-Pixelated display should apply to the tube side of a HX
-Fix hybrid pressure model to reduce discontinuities
-Figure out why power increases after a scram? Just fix neutronics in general, something about it isn't right anymore.
-Add manual reset of scram
-Add visual scram indicator
-Add LOCA capability (atmosphere as boundary condition)
-Make pipes, tanks, etc. rupture on high pressure (dependent on thickness)
-Ability to put things inside other things, e.g. containment building, or cross-vessel with internal hot leg
-Add containment building as an option
-Add FW heaters?
-Calculate efficiency (turbine work output) in a more realistic way
-Heat transfer in a HX should depend on liquid level. In the core too.
-Need a better way of deciding whether a node has separate liquid and vapor spaces, or is mixed. Or has a vapor space and a mixture space. Something about its height to width ratio and flow rate? This affects display but also flow through flowpaths at the top or bottom.
-Improve performance (why are timesteps getting so small?)
-Maybe something about a control room, but I don't want the user to have to worry about this a lot
-Let the user implement automated logic for controlling stuff
-Add ability to wait for random initiating event (once steady state is achieved)
-Add money earning system based on generation (in game mode). 
-Add cool visuals for different initiating events
-Model tank and pipe overpressure
-Model vessel creep rupture and SG tube creep rupture
-Model core-concrete interaction
-Add cladding oxidation and hydrogen explosions
-Show the "ground" in the display? And maybe the UHS?
-Steam separators? Maybe not
-Add U-tube heat exchangers as an option. Also horizontal and vertical once-through HXs.
-User editable Scram logic and system actuation
-"Operator actions" initiated by the user (with delay and progress bar) by clicking on a pump or w/e
-Diesel generators (and electric power in general)
-Add fuel melting and radionuclide release ("meltdown!")
-Show power in MWt along with %
-Add advanced reactor options (pebble bed fuel, helium or metal coolant)
-Allow multiple cores
-We can do operating cost estimates based on fuel use, number of employees (how many do you need for maintenance of this many components, etc). But we're glossing over outages.
-We could even account for interest rates? Maybe

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



