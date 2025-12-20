You can run npx or other commands directly, but remember that you can't use head or tail to look at the output. Also remember that cmd /c will not work correctly in this git bash environment (it swallows the output). As long as you don't use head, you should be able to run npx by specifying the path like this:
PATH="$PATH:/c/Program Files/nodejs" npx tsx src/simulation/tests.ts 2>&1

This project is intended as a sandbox environment with game-like aspects, to allow users to experiment with a wide variety of reactor designs. We don't need perfect accuracy, but I want all the qualitative behavior to be physically plausible, so a knowledgeable engineer looking at the simulation would not be able to tell anything is off unless they check the numbers. That also means it needs to be robust to weird configurations and poorly set up initial conditions. It is best to avoid special cases, hard-coded values, thresholds, and other simplifications that may cause unstable simulation behavior. If this kind of simplification is needed, please discuss with me before adding it.

Style note: Please avoid beginning any response by saying I'm right. This is a pet peeve of mine. I would prefer you challenge my ideas and tell me if I'm wrong, rather than assuming I'm right.

/*
TODO:
X Show connections between components on the display (matching fluid flows)
X Make fluid mass match its density based on temperature & quality
X Figure out a decent way to approximate steam tables
X Keep the number displays from flickering so much, especially power
Figure out why power increases after a scram?
Add the ability for the user to create components and connect them
And specify their initial properties
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