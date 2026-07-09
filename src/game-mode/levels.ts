/**
 * Career levels: stock plants, budgets, objectives, events, and the
 * dialogue scripts that hold the whole thing together.
 *
 * Stock plants derive from the shipping presets so convergence is proven
 * (see scripts/test-game-levels.ts for the headless reference runs).
 */

import { LevelDef } from './types';
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
    id: 'first-light',
    title: 'LEVEL 1: FIRST LIGHT',
    tagline: 'Everything is on site except, well, the reactor.',
    stockPlant: level1Site,
    loanCap: 750e6,
    startingCash: 25e6,
    completionBonus: 40e6,
    basePowerPrice: 110,
    interestAPR: 0.08,
    goals: [
      { kind: 'power', mwe: 150, holdSeconds: 120, label: 'Reach 150 MWe and hold it' },
      { kind: 'energy', mwh: 25, label: 'Deliver 25 MWh to the grid' },
    ],
    maxRelease: 1,
    events: { warmupSeconds: Infinity, meanIntervalSeconds: Infinity, pool: [] },
    briefing: [
      { who: 'grubb', mood: 'neutral', text: 'So you\'re the new Chief Engineer. Welcome to Gigawatt Power & Light. Don\'t get comfortable.' },
      { who: 'grubb', mood: 'angry', text: 'The last chief engineer "decommissioned" our reactor. Long story. Insurance is still arguing about it.' },
      { who: 'grubb', mood: 'neutral', text: 'Good news: the turbine hall survived. Steam generator, coolant pump, pressurizer - all paid for, all sitting there, doing NOTHING.' },
      { who: 'grubb', mood: 'happy', text: 'Your job: put a new reactor in that containment building and pipe it up. The bank gave us a $750 million line of credit. Try to leave some of it.' },
      { who: 'grubb', mood: 'neutral', text: 'The old drawings say: vessel about 4 meters across, 12 tall, rated 172 bar. Core around 1000 megawatts thermal, 5 percent enrichment. Or improvise. What could go wrong.' },
      { who: 'grubb', mood: 'angry', text: 'Piping 101, since apparently I have to say it: coolant pump into the vessel downcomer. Core outlet to the steam generator tubes. And connect the pressurizer to the vessel or the whole thing goes BANG.' },
      { who: 'grubb', mood: 'neutral', text: 'No rod controller in the budget - you\'ll drive the control rods yourself, by hand, like your grandfather did. Ease them out. EASE. The turbine governor and feedwater are automatic.' },
      { who: 'grubb', mood: 'happy', text: 'Get me 150 megawatts and 25 megawatt-hours on the meter. Do that and there\'s a bonus in it. Interest starts the second you press BUILD, so move it.' },
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
    title: 'LEVEL 2: SHAKEDOWN',
    tagline: 'A whole plant, free and clear. What could it be hiding?',
    stockPlant: pwrPreset,
    loanCap: 500e6,
    startingCash: 20e6,
    completionBonus: 60e6,
    basePowerPrice: 95,
    interestAPR: 0.08,
    goals: [
      { kind: 'energy', mwh: 60, label: 'Deliver 60 MWh' },
      { kind: 'cash', dollars: 32e6, label: 'Grow the account to $32M' },
    ],
    maxRelease: 1,
    events: {
      warmupSeconds: 240,
      meanIntervalSeconds: Infinity,
      pool: [],
      scripted: [
        { kind: 'pump-trip', earliestSeconds: 300, latestSeconds: 600 },
        { kind: 'price-spike', earliestSeconds: 120, latestSeconds: 400 },
      ],
    },
    briefing: [
      { who: 'grubb', mood: 'happy', text: 'Great news! I bought a complete pressurized water reactor at auction. Barely used. The controls are all automatic - it practically runs itself.' },
      { who: 'grubb', mood: 'neutral', text: 'Why was it at auction, you ask? Great question. Nobody asked it at the auction, and I\'m not starting now.' },
      { who: 'grubb', mood: 'neutral', text: 'Just run the thing. Sixty megawatt-hours on the meter and forty million in the account. The market\'s jumpy this week - sell power when the price is up.' },
      { who: 'grubb', mood: 'angry', text: 'One more thing. If something trips out there - a pump, whatever - somebody has to WALK OUT and restart it. Click the machine, use the operator panel. That somebody is you.' },
    ],
    debrief: [
      { who: 'grubb', mood: 'happy', text: 'Smooth as a bond salesman. The auction house called - they want to know if we\'d like another one.' },
      { who: 'grubb', mood: 'neutral', text: 'I said maybe. The NRC called too. I let it ring.' },
    ],
    hints: [
      'The plant starts itself - watch it climb to full power.',
      'Select a pump in simulation mode to open the OPERATOR ACTIONS panel.',
      'Watch the price ticker: a spike is worth chasing with full output.',
    ],
    reference: {
      design: pwrPreset,
      notes: [
        'GRUBB\'S BINDER: the plant is fine - press BUILD IT and let the controllers take it to full power. Your job starts when something stops.',
        'When a pump trips, click it and press START in the OPERATOR ACTIONS panel. Do it promptly; the core does not enjoy waiting.',
        'A price spike is free money: hold full output until it fades. Interest never sleeps, so neither should the turbine.',
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
    title: 'LEVEL 3: GOING CONCERN',
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
    title: 'LEVEL 4: THE INSPECTION',
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
      { who: 'inspector', mood: 'neutral', text: 'Inspector Pruitt, NRC. This facility is due for an operational stress audit. Today, your plant will experience one significant equipment casualty.' },
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
