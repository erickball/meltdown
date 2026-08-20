## ENV NOTES
In windows file paths, always use backslashes. Using forward slashes will cause file edits to fail. It will look like the file keeps getting modified.

## PROJECT GUIDELINES
This project is intended as a sandbox environment with game-like aspects, to allow users to experiment with a wide variety of reactor designs. We don't need perfect accuracy, but I want all the qualitative behavior to be physically plausible, so a knowledgeable engineer looking at the simulation would not be able to tell anything is off unless they check the numbers. That also means it needs to be robust to weird configurations and poorly set up initial conditions by having a fully internally consistent physics model. It is best to avoid special cases, hard-coded values, thresholds, hysteresis, clamping, and other simplifications that may cause unstable simulation behavior. If normal methods fail (especially related to calculating water properties) any fallback assumptions must come with a very noticeable error message. Don't clamp anything. If simplifications or heuristics are needed, please discuss with me before adding them. The components should be generic building blocks as much as possible. This sandbox can simulate PWRs, BWRs, advanced reactors, or new and weird ideas for reactor designs. All the physics needs to be robust to all configurations the user might throw at us. To get there, we should follow the "anti-robustness principle" - fail loudly so we can find the source of the problem. Do not add band-aids.
Whenever there's something potentially confusing in an interface, add a tooltip to explain.
After any substantive changes to the code, run npm test to see if it still works.
You can run specific scenario tests like this to see console output: npx tsx scripts/test-simulation.ts scripts/tankburst.json 100000 0.01
Style note: please avoid starting a response by telling me I'm right, unless I specifically ask whether I'm right. This is a pet peeve of mine.

## GIT WORKFLOW (handle this autonomously - the user does not want to do branch management)
Multiple Claude sessions often run in this repo at the same time, sharing this working tree. Manage all branching, merging, and pushing yourself, without being asked:
- For any task that edits code, do NOT edit the shared tree directly. Create a git worktree with a fresh feature branch (EnterWorktree) and work there. This is what keeps parallel sessions from trampling each other.
- Stage files explicitly by name. Never use `git add -A` or `git add .` (another session's stray files may be present).
- When the work is complete and `npm test` passes: merge the latest master into your branch, re-run tests if the merge touched anything, then merge the branch into master and push to origin. The goal is that master (the source of the deployed version) always accumulates every finished feature/fix from every session. Do not leave finished work stranded on a feature branch or unpushed.
- Resolve merge conflicts yourself. Only ask the user if a resolution genuinely requires a judgment call about intended behavior.
- This applies to work YOU complete. Do not auto-merge pre-existing experimental branches (game-mode, atom-jack, xe100, iso-zoom, ...) - those are parked deliberately.
- After merging, clean up: remove your worktree and delete the merged feature branch.

## WATER PROPERTIES NOTES
- Our saturated steam table data goes all the way from the triple point to the critical point.
- It is critical to determine phase PURELY by comparing whether a node's (energy, volume) pair is inside the saturation dome in (u,v) space. Any thresholds, approximations, or special case rules will cause problems down the line.
- Representing the dome boundary as a single curve that concatenates the saturated liquid and saturated vapor lines DOES correctly represent the two-phase region. Testing whether u < u_sat(v) is the ONLY valid way to determine if a node is two-phase (or v > v_sat(u) if u < 50).
- If we ever fail to find a good match between x_u and x_v, we need to stop and throw a big error message. Do NOT use any fallback assumptions unless you get explicit user approval.


