/**
 * Career levels: stock plants, budgets, objectives, events, and the
 * dialogue scripts that hold the whole thing together.
 *
 * Stock plants derive from the shipping presets so convergence is proven
 * (see scripts/test-game-levels.ts for the headless reference runs).
 */

import { LevelDef } from './types';
import spentFuelPool from './levels/spent-fuel-pool.json';
import level1Site from './levels/level1-site.json';
import level1ReactorSolution from './levels/level1-reactor-solution.json';
import pwrPreset from '../presets/pwr.json';
import twoLoopPreset from '../presets/two-loop.json';

/**
 * Merge preset-format plant fragments into one plant (components must have
 * distinct ids). Used to lay the reference reactor into the level-1 site the
 * same way scripts/test-game-levels.ts does for the headless validation runs.
 */
function mergePlantJson(...parts: unknown[]): unknown {
  const seen = new Set<string>();
  const components: unknown[] = [];
  const connections: unknown[] = [];
  for (const part of parts as Array<{ components?: unknown[]; connections?: unknown[] }>) {
    for (const entry of part.components ?? []) {
      const id = (entry as [string, unknown])[0];
      if (seen.has(id)) throw new Error(`Duplicate component id '${id}' merging reference plant`);
      seen.add(id);
      components.push(entry);
    }
    connections.push(...(part.connections ?? []));
  }
  return { components, connections };
}

export const LEVELS: LevelDef[] = [
  // =========================================================================
  {
    id: 'spent-fuel-pool',
    title: 'LEVEL 1: HOT AND DRY',
    tagline: 'A cracked fuel pool on a cliff, and the sea a long way below it.',
    stockPlant: spentFuelPool,

    // No money on this job at all: what you can build is what is in the yard.
    economy: 'none',
    loanCap: 0,
    startingCash: 0,
    completionBonus: 0,
    basePowerPrice: 0,
    interestAPR: 0,

    // Six sim hours at 60x is six real minutes. The plant is tiny (one pool,
    // three tanks, whatever the player puts up) so the solver keeps up.
    simSpeed: 60,
    // The tile grid is the only view that draws terrain, and this level IS
    // its terrain.
    view: 'grid',
    // Build with the plant running: there is no outage while fuel is heating.
    liveBuild: true,

    goals: [
      { kind: 'survive', seconds: 21600, label: 'Keep the fuel covered for six hours' },
    ],
    // Nothing here is pressurised or contained: any real fuel damage vents
    // straight to the sky, so the release limit is set where a first sign of
    // damage already counts.
    maxRelease: 0.01,
    hazards: [
      {
        kind: 'level', nodeId: 'pool', minMetres: 4.16, graceSeconds: 1200,
        label: 'Pool level',
        consequence:
          'The racks stand 4.16 m tall. Water below that leaves fuel in steam, ' +
          'and steam does not carry 8 megawatts away.',
      },
      {
        kind: 'temperature', nodeId: 'pool-clad', limitC: 600,
        label: 'Cladding temperature',
        consequence:
          'Zircaloy has almost no strength left at 600 \u00b0C, and its reaction with ' +
          'steam turns self-sustaining not far above 800 \u00b0C. Past that the fuel ' +
          'makes its own heat and hydrogen and nobody is putting it back.',
      },
    ],

    palette: ['pump', 'pipe', 'valve'],
    // Nothing random on this level: the earthquake and the wave are in the
    // plant's own scenario block, on a fixed clock.
    events: { warmupSeconds: Infinity, meanIntervalSeconds: Infinity, pool: [] },

    briefing: [
      { who: 'grubb', mood: 'neutral', text: 'Kid. Before you ask: no, this is not a power plant. It is a swimming pool with two hundred and fifty spent fuel assemblies at the bottom of it.' },
      { who: 'grubb', mood: 'neutral', text: 'Eight megawatts of decay heat, and the only thing standing between that and the evening news is nine metres of water. The cooling pumps went with the switchyard last night.' },
      { who: 'grubb', mood: 'happy', text: 'Good news: with that much water it warms up slower than my coffee. You have got time. Not a lot of it.' },
      { who: 'inspector', mood: 'neutral', text: 'Inspector Pruitt. The seismologists are unhappy. If that liner cracks, your pool becomes a bathtub with the plug out.' },
      { who: 'grubb', mood: 'angry', text: 'The yard has three hundred metres of pipe, two pumps and a couple of valves. That is the whole company. There is no budget, there is no bank, there is a YARD.' },
      { who: 'grubb', mood: 'neutral', text: 'Water: two site tanks up here on the bench, and the sea. The tanks are close and they are FINITE. The sea is not finite, but it is down there and you are up here.' },
      { who: 'inspector', mood: 'unimpressed', text: 'Keep the fuel covered for six hours and I will write this up as an event, not an accident. Uncover it and we will both be explaining ourselves for years.' },
      { who: 'grubb', mood: 'happy', text: 'Build while it runs - no shutting anything down, nothing to shut down. Go.' },
    ],
    debrief: [
      { who: 'grubb', mood: 'happy', text: 'Six hours. The water is still over the fuel and the fuel is still in one piece.' },
      { who: 'inspector', mood: 'neutral', text: 'Level held, cladding cool, and the only thing you lost was a tank of demineralised water and some pipe. I am recording this as an event.' },
      { who: 'grubb', mood: 'happy', text: 'An EVENT. You hear that? Not an accident. That is the nicest word anyone at that agency has ever said to me.' },
    ],
    hints: [
      'Watch the pool level readout - the racks are 4.16 m tall, and everything below that number is trouble.',
      'The crack passes about 100 kg/s once the level is down near the racks. A make-up pump much bigger than that just empties the tanks faster.',
      'A pump can only SUCK water up about ten metres before its intake boils. It can PUSH it as high as its head allows.',
      'When the wave comes, anything standing on the shore is under water and stays stopped until it drains. Make the tanks last.',
    ],
  },
  // =========================================================================
  {
    id: 'first-light',
    title: 'LEVEL 2: FIRST LIGHT',
    tagline: 'Everything is on site except, well, the reactor.',
    stockPlant: level1Site,
    loanCap: 750e6,
    startingCash: 25e6,
    completionBonus: 40e6,
    basePowerPrice: 110,
    interestAPR: 0.08,
    goals: [
      { kind: 'power', mwe: 150, holdSeconds: 120, label: 'Reach 150 MWe and hold it' },
      { kind: 'energy', mwh: 15, label: 'Deliver 15 MWh to the grid' },
    ],
    maxRelease: 1,
    palette: ['reactor-vessel', 'core', 'pipe', 'valve', 'check-valve'],
    events: { warmupSeconds: Infinity, meanIntervalSeconds: Infinity, pool: [] },
    briefing: [
      { who: 'grubb', mood: 'neutral', text: 'So you\'re the new Chief Engineer. Welcome to Gigawatt Power & Light. Don\'t get comfortable.' },
      { who: 'grubb', mood: 'angry', text: 'The last chief engineer "decommissioned" our reactor. Long story. Insurance is still arguing about it.' },
      { who: 'grubb', mood: 'neutral', text: 'Good news: the turbine hall survived. Steam generator, coolant pump, pressurizer - all paid for, all sitting there, doing NOTHING.' },
      { who: 'grubb', mood: 'happy', text: 'Your job: put a new reactor in that containment building and pipe it up. The bank gave us a $750 million line of credit. Try to leave some of it.' },
      { who: 'grubb', mood: 'neutral', text: 'The old drawings say: vessel about 4 meters across, 12 tall, rated 172 bar. Core around 1000 megawatts thermal, 5 percent enrichment. Or improvise. What could go wrong.' },
      { who: 'grubb', mood: 'angry', text: 'Piping 101, since apparently I have to say it: coolant pump into the vessel downcomer. Core outlet to the steam generator tubes. And connect the pressurizer to the vessel or the whole thing goes BANG.' },
      { who: 'grubb', mood: 'neutral', text: 'No rod controller in the budget - you\'ll drive the control rods yourself, by hand, like your grandfather did. Ease them out. EASE. The turbine governor and feedwater are automatic.' },
      { who: 'grubb', mood: 'happy', text: 'Get me 150 megawatts and 15 megawatt-hours on the meter. Do that and there\'s a bonus in it. Interest starts the second you press BUILD, so move it.' },
    ],
    debrief: [
      { who: 'grubb', mood: 'happy', text: 'Would you look at that. The meter\'s spinning forward for a change.' },
      { who: 'grubb', mood: 'neutral', text: 'The bank called. They used the word "solvent." First time anyone\'s said that about us in years.' },
      { who: 'grubb', mood: 'happy', text: 'Bonus is in your account. Don\'t spend it all - I\'ve got bigger plans for you, kid.' },
    ],
    hints: [
      'Place a Reactor Vessel inside the containment, then place a Reactor Core inside the vessel.',
      'Set the barrel TOP gap under 0.1 m so the hot leg comes off the core outlet port.',
      'Connect: RCP outlet -> vessel inlet. Core barrel top -> SG tube port. Vessel outlet -> pressurizer bottom.',
      'After BUILD: withdraw rods slowly until the core settles near your target power.',
    ],
    reference: {
      design: mergePlantJson(level1Site, level1ReactorSolution),
      notes: [
        'GRUBB\'S DRAWINGS: vessel and core are placed and piped. Cold leg -> downcomer, hot leg -> SG tubes, surge line -> pressurizer. Just press BUILD IT.',
        'The rods start at the critical position. Withdraw a percent at a time, then WAIT for power to settle before the next pull.',
        'Keep the reactivity readout under ~50 pcm on the way up. Around 60% core power the generator clears 150 MWe.',
      ],
      scolding: [
        { who: 'grubb', mood: 'furious', text: 'THREE PIPES. The job was THREE PIPES and a slow hand on the rods, and you gave me modern art.' },
        { who: 'grubb', mood: 'angry', text: 'Here. The as-built drawings from the old plant. I was saving them for someone who didn\'t need them. Clearly that ship has SAILED.' },
        { who: 'grubb', mood: 'neutral', text: 'The rod procedure is on the binder cover: SLOWLY. Underlined. Twice. The man who underlined it is the reason we had a job opening.' },
      ],
    },
  },
  // =========================================================================
  {
    id: 'shakedown',
    title: 'LEVEL 3: SHAKEDOWN',
    tagline: 'A whole plant, free and clear. What could it be hiding?',
    stockPlant: pwrPreset,
    loanCap: 500e6,
    startingCash: 20e6,
    completionBonus: 60e6,
    basePowerPrice: 95,
    interestAPR: 0.08,
    goals: [
      { kind: 'energy', mwh: 60, label: 'Deliver 60 MWh' },
      { kind: 'events', count: 2, recoverMwe: 150, label: 'Ride through 2 equipment casualties' },
    ],
    maxRelease: 1,
    palette: ['pump', 'valve', 'check-valve', 'relief-valve', 'pipe', 'pid-controller'],
    events: {
      warmupSeconds: 180,
      meanIntervalSeconds: Infinity,
      pool: [],
      scripted: [
        { kind: 'pump-trip', earliestSeconds: 210, latestSeconds: 420 },
        { kind: 'turbine-trip', earliestSeconds: 540, latestSeconds: 840 },
        { kind: 'price-spike', earliestSeconds: 120, latestSeconds: 400 },
      ],
    },
    briefing: [
      { who: 'grubb', mood: 'happy', text: 'Great news! I bought a complete pressurized water reactor at auction. Barely used. The controls are all automatic - it practically runs itself.' },
      { who: 'grubb', mood: 'neutral', text: 'Why was it at auction, you ask? Great question. Nobody asked it at the auction, and I\'m not starting now.' },
      { who: 'grubb', mood: 'neutral', text: 'Just keep the thing RUNNING. Sixty megawatt-hours on the meter, and whatever the auction plant throws at you - a tripped pump, a slammed turbine - you ride it out and get back to full power.' },
      { who: 'grubb', mood: 'angry', text: 'Because something WILL trip out there. And when it does, somebody has to WALK OUT and restart it. Click the machine, use the operator panel. That somebody is you.' },
    ],
    debrief: [
      { who: 'grubb', mood: 'happy', text: 'Smooth as a bond salesman. The auction house called - they want to know if we\'d like another one.' },
      { who: 'grubb', mood: 'neutral', text: 'I said maybe. The NRC called too. I let it ring.' },
    ],
    hints: [
      'The plant starts itself - watch it climb to full power.',
      'When something trips, select it in simulation mode to open the OPERATOR ACTIONS panel and restart it.',
      'A casualty only counts as "ridden through" once you\'re back above 150 MWe.',
    ],
    reference: {
      design: pwrPreset,
      notes: [
        'GRUBB\'S BINDER: the plant is fine - press BUILD IT and let the controllers take it to full power. Your job starts when something stops.',
        'When a pump trips, click it and press START in the OPERATOR ACTIONS panel. Do it promptly; the core does not enjoy waiting.',
        'A slammed turbine governor: click its controller and put it back in AUTO. Then get back above 150 MWe to log the save.',
      ],
      scolding: [
        { who: 'grubb', mood: 'furious', text: 'The plant runs ITSELF. The ONE thing it can\'t do is walk outside and flip its own breaker. That part - the WALKING - is what I pay you for.' },
        { who: 'grubb', mood: 'angry', text: 'Here\'s the operating binder. Chapter one: when a machine stops, START IT AGAIN. There is no chapter two. My nephew wrote it and even HE passed this level.' },
      ],
    },
  },
  // =========================================================================
  {
    id: 'going-concern',
    title: 'LEVEL 4: GOING CONCERN',
    tagline: 'An empty field, a big loan, and a bigger interest payment.',
    stockPlant: null,
    loanCap: 6e9,
    startingCash: 60e6,
    completionBonus: 150e6,
    basePowerPrice: 100,
    interestAPR: 0.04,
    goals: [
      { kind: 'power', mwe: 250, holdSeconds: 300, label: 'Hold 250 MWe for 5 minutes' },
      { kind: 'energy', mwh: 120, label: 'Deliver 120 MWh' },
      { kind: 'cash', dollars: 40e6, label: 'Stay solvent: keep $40M+' },
    ],
    maxRelease: 1,
    events: {
      warmupSeconds: 600,
      meanIntervalSeconds: 900,
      pool: [
        { kind: 'pump-trip', weight: 4 },
        { kind: 'price-spike', weight: 2 },
        { kind: 'price-crash', weight: 2 },
        { kind: 'turbine-trip', weight: 1 },
      ],
    },
    briefing: [
      { who: 'grubb', mood: 'happy', text: 'Kid, I bought LAND. Beautiful land. Flat as an accountant\'s pulse. And the bank - the FOOLS - gave me six billion dollars.' },
      { who: 'grubb', mood: 'neutral', text: 'Build me a power plant. From scratch. Reactor, steam side, the works. Your design. I don\'t care if it\'s got two loops or a pebble bed, as long as it makes MONEY.' },
      { who: 'grubb', mood: 'angry', text: 'What I care about is the interest on six billion dollars. You know what that comes to a day? Don\'t look it up. It\'ll only upset you.' },
      { who: 'grubb', mood: 'neutral', text: 'Two hundred fifty megawatts, held steady. Hundred twenty megawatt-hours. Hundred million in the account. And kid - out here, things BREAK. Keep your boots by the door.' },
    ],
    debrief: [
      { who: 'grubb', mood: 'happy', text: 'A whole power plant. From dirt. You know what my old man built? Resentment. Mostly resentment.' },
      { who: 'grubb', mood: 'happy', text: 'The board wants to meet you. I told them no. Can\'t risk somebody poaching my chief engineer. Take the bonus and buy something with a warranty.' },
    ],
    hints: [
      'A save/load slot full of working designs is worth more than the loan cap.',
      'Controllers cost pocket change and they never fall asleep at 3 AM. Buy them.',
      'Loan interest runs whether you generate or not: build fast, start fast.',
    ],
    reference: {
      design: pwrPreset,
      notes: [
        'GRUBB\'S DRAWINGS: the Shakedown plant, about $3.8B all-in - well under the loan cap. Press BUILD IT; the controllers handle startup.',
        'Interest on the build runs roughly $7,000 a sim-second. Revenue at full power is around $12,000. Conclusion: BE at full power.',
        'Out here things break. Click the tripped machine, OPERATOR ACTIONS, restart it. Ride out price crashes at full output; they pass.',
      ],
      scolding: [
        { who: 'grubb', mood: 'furious', text: 'Six BILLION dollars of credit, a flat field, and you built the bank a CRATER. They\'re framing your loan application as a warning to others.' },
        { who: 'grubb', mood: 'angry', text: 'So here. The drawings from the auction plant. Yes, I\'m giving you the answers. Yes, like your homework. No, I\'m not proud either.' },
        { who: 'grubb', mood: 'neutral', text: 'Build it EXACTLY as drawn, keep it running, and maybe the interest doesn\'t eat us alive before the meter does its job.' },
      ],
    },
  },
  // =========================================================================
  {
    id: 'the-inspection',
    title: 'LEVEL 5: THE INSPECTION',
    tagline: 'The NRC would like a word. And a demonstration.',
    stockPlant: twoLoopPreset,
    loanCap: 500e6,
    startingCash: 30e6,
    completionBonus: 250e6,
    basePowerPrice: 85,
    interestAPR: 0.08,
    goals: [
      { kind: 'energy', mwh: 100, label: 'Deliver 100 MWh during the audit' },
      { kind: 'cash', dollars: 50e6, label: 'End the audit above $50M' },
    ],
    maxRelease: 0.01,
    events: {
      warmupSeconds: 300,
      meanIntervalSeconds: Infinity,
      pool: [],
      scripted: [
        { kind: 'major-surprise', earliestSeconds: 420, latestSeconds: 900 },
      ],
    },
    briefing: [
      { who: 'grubb', mood: 'panic', text: 'Bad news. The Nuclear Regulatory Commission is here. IN THE BUILDING. There\'s a man with a clipboard drinking my coffee.' },
      { who: 'inspector', mood: 'neutral', text: 'Pruitt again. This facility is due for an operational stress audit. Today, your plant will experience one significant equipment casualty.' },
      { who: 'inspector', mood: 'unimpressed', text: 'I will not tell you what, and I will not tell you when. You will maintain generation, you will protect the core, and you will release nothing to the environment. Nothing.' },
      { who: 'grubb', mood: 'angry', text: 'Release? RELEASE? Pruitt, this is the tightest ship in the fleet. My engineer here has ice water for blood. Show him, kid.' },
      { who: 'inspector', mood: 'neutral', text: 'For your reference: a scram is an acceptable outcome. A release is a career outcome. Yours and mine. Proceed.' },
    ],
    debrief: [
      { who: 'inspector', mood: 'neutral', text: 'The casualty was contained, generation was maintained, and my dosimeter is as bored as I am. That is the correct way for a dosimeter to feel.' },
      { who: 'inspector', mood: 'unimpressed', text: 'I am recording this facility as "adequately operated." That is the highest rating I have ever issued.' },
      { who: 'grubb', mood: 'happy', text: 'ADEQUATE! You hear that, kid? Frame it. FRAME IT. That word is worth two hundred fifty million dollars in license renewals.' },
    ],
    hints: [
      'Two loops means the casualty might only take half the plant. Keep the other half earning.',
      'A steam generator tube rupture pushes primary coolant into the steam side: isolate and cool.',
      'Scram early beats explaining a release to Pruitt. He has a form for it.',
    ],
    reference: {
      design: twoLoopPreset,
      notes: [
        'GRUBB\'S PROCEDURES: the plant passes the audit as-is. Bank your 100 MWh early, before Pruitt\'s surprise lands (after about 7 minutes).',
        'Tube rupture: primary is leaking into the steam side. Scram, then keep the ruptured SG bottled up while the intact loop removes heat.',
        'A tripped pump or slammed governor: restart it from OPERATOR ACTIONS / the controller and carry on. And remember Pruitt\'s math: a scram costs money, a release costs EVERYTHING.',
      ],
      scolding: [
        { who: 'grubb', mood: 'panic', text: 'Pruitt is still in the building. He watched the WHOLE thing. He asked for a second clipboard. He\'s never needed a SECOND CLIPBOARD.' },
        { who: 'grubb', mood: 'furious', text: 'The emergency procedures were IN YOUR DESK. I found them just now. You were using them as a COASTER.' },
        { who: 'grubb', mood: 'neutral', text: 'One more chance. Follow the book, keep the dosimeter bored, and if in doubt - SCRAM. Nobody ever went to prison for a scram.' },
      ],
    },
  },
];

/** The special level-4 surprise: picked randomly at fire time by the manager. */
export const MAJOR_SURPRISES = ['sgtr', 'small-loca', 'pump-trip', 'turbine-trip'] as const;
