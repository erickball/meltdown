/**
 * Building takes time.
 *
 * Placing a part used to be instantaneous: click, and a pump was running.
 * That made an emergency a typing test rather than a decision - the answer
 * to "the pool is draining" was to build the whole make-up train in the two
 * seconds it took to click through the dialogs. A part now stands on the map
 * as a GHOST for as long as it would really take to install, and only joins
 * the simulation when the timer runs out.
 *
 * ONE LAW, no per-part tuning: every job takes `SIM_SECONDS_PER_KG` of
 * SIMULATED time per kilogram of installed mass, in both directions (taking
 * a part back to the yard is the same work as putting it in). The rate is
 * anchored on the pipe the player lays most:
 *
 *   the level's service-water line (`spec-12in-service`, 0.3 m bore, 16 bar)
 *   weighs 26.90 kg/m (the 3 mm handling minimum wall, plus the estimator's
 *   20% for elbows, tees and flanges), one grid segment of it is 1 m, and
 *   one segment should feel like about 0.1 s of the PLAYER'S time on the
 *   level this was tuned on, which runs at 60x
 *     => SIM_SECONDS_PER_KG = 0.1 x 60 / 26.90 = 0.2230 s/kg,
 *        i.e. 6 simulated seconds a metre, or 3.72 simulated minutes a tonne.
 *
 * Everything else follows from its own mass (`componentBuildMassKg`), so a
 * 2.5 t service-water pump is ~9 minutes of plant time and a 300 m run of
 * that pipe is ~30 - without any of them being a number somebody picked.
 *
 * SIMULATED TIME, NOT WALL CLOCK. Installing a pump is work the PLANT waits
 * for, so it has to be measured on the plant's clock: it stops when the
 * simulation stops, it takes twice as long at 2x, and a run replayed at a
 * different speed builds the same part in the same place. (It used to be
 * ticked with the frame's wall interval, which meant the same job took a
 * different amount of the accident depending on how fast the player had the
 * clock turned up.) The FEEL at 60x is unchanged, because the rate was
 * multiplied by that 60.
 *
 * REWINDING. Progress is keyed to the simulated clock rather than
 * accumulated frame by frame: a job records the time it was taken and is
 * `simTime - startedAt` along. So seeking backwards runs the ring backwards
 * too, and seeking back PAST a job's start abandons it and refunds it - at
 * that point in the run nobody had ordered it yet.
 *
 * Construction mode does not use this at all: there the plant is not running
 * and there is nothing to be late for.
 */

import { PlantComponent, PipeComponent, Connection } from '../types';
import { pipeSteelMassPerMetre, vesselSteelMass } from '../construction/cost-estimation';

/** Mass per metre of the anchoring line: 12" service water at 16 bar. */
const ANCHOR_PIPE_KG_PER_M = pipeSteelMassPerMetre(0.3, 16);

/**
 * How long one metre of the anchoring line should FEEL like to the player,
 * and the speed the level that fixes the feel runs at. The product is what
 * the plant's own clock has to charge for that metre.
 */
const ANCHOR_WALL_SECONDS_PER_M = 0.1;
const ANCHOR_SIM_SPEED = 60;

/** SIMULATED seconds of work per kilogram installed. */
export const SIM_SECONDS_PER_KG =
  ANCHOR_WALL_SECONDS_PER_M * ANCHOR_SIM_SPEED / ANCHOR_PIPE_KG_PER_M;

/** Anything the queue can hold: a plant component or a connection. */
export interface Buildable {
  /** Present and true while the part is a ghost, not yet in the simulation. */
  underConstruction?: boolean;
  /** Present and true while the part is being taken back to the yard. */
  pendingRemoval?: boolean;
  /** 0-1, written by the queue every tick. Display only. */
  buildProgress?: number;
}

export type BuildJobKind = 'build' | 'return';

export interface BuildJob {
  id: string;
  kind: BuildJobKind;
  /** What the notification and the panel call this job. */
  label: string;
  massKg: number;
  /** Total SIMULATED seconds of work. */
  simSeconds: number;
  /** The simulated time the job was taken. Progress is measured from it. */
  startedAt: number;
  /** Simulated seconds done so far, i.e. `simTime - startedAt`. */
  elapsed: number;
  /** The plant objects held by this job; the queue writes their progress. */
  targets: Buildable[];
  /**
   * Put the part into (or take it out of) the running simulation.
   *
   * `apply` clears the ghost marks. The caller decides WHEN inside its own
   * transaction that happens - the whole point is that the plant changes
   * exactly once, inside one live edit, rather than being mutated here and
   * rebuilt somewhere else.
   */
  finish: (apply: () => void) => void;
  /** Undo the job outright: the part never happened, the stock comes back. */
  abandon: (apply: () => void) => void;
}

let nextJobId = 1;

export class BuildQueue {
  private queue: BuildJob[] = [];

  /**
   * The simulated clock, as of the last `tick`. A job takes its start time
   * from here, which is exact: every path that creates a part runs inside a
   * live edit, and a live edit stops the clock for the whole gesture, so no
   * simulated time passes between the last tick and the enqueue.
   */
  private simTime = 0;

  /** Where the queue thinks the plant's clock is. */
  get time(): number {
    return this.simTime;
  }

  get jobs(): readonly BuildJob[] {
    return this.queue;
  }

  get busy(): boolean {
    return this.queue.length > 0;
  }

  /**
   * Take a job. The caller has already made the plant change (and paid for
   * it, or is about to be refunded for it) and marked its targets; all the
   * queue owns is the clock.
   */
  enqueue(spec: {
    kind: BuildJobKind;
    label: string;
    massKg: number;
    targets: Buildable[];
    finish: (apply: () => void) => void;
    abandon: (apply: () => void) => void;
  }): BuildJob {
    const massKg = Math.max(0, spec.massKg);
    const job: BuildJob = {
      id: `job-${nextJobId++}`,
      kind: spec.kind,
      label: spec.label,
      massKg,
      simSeconds: massKg * SIM_SECONDS_PER_KG,
      startedAt: this.simTime,
      elapsed: 0,
      targets: spec.targets,
      finish: spec.finish,
      abandon: spec.abandon,
    };
    for (const t of job.targets) {
      if (job.kind === 'build') t.underConstruction = true;
      else t.pendingRemoval = true;
      t.buildProgress = 0;
    }
    this.queue.push(job);
    console.log(`[BuildQueue] ${job.kind === 'build' ? 'Building' : 'Returning'} ` +
      `${job.label}: ${Math.round(massKg)} kg, ${job.simSeconds.toFixed(1)} s of plant time ` +
      `from t=${job.startedAt.toFixed(1)} s`);
    // A job with no mass at all has nothing to wait for.
    if (!(job.simSeconds > 0)) this.complete(job);
    return job;
  }

  /**
   * Move the queue to `simTime`, the plant's own clock. Jobs whose timer has
   * run out by then finish here, in the order they were taken.
   *
   * This is an ABSOLUTE time, not an interval, which is what makes a rewind
   * mean something: progress is `simTime - startedAt`, so going back down the
   * history runs every ring backwards, and a job whose start is now in the
   * future never happened - it is abandoned and refunded.
   */
  tick(simTime: number): void {
    const rewound = simTime < this.simTime;
    this.simTime = simTime;
    if (this.queue.length === 0) return;

    if (rewound) {
      const unordered = this.queue.filter(j => simTime < j.startedAt);
      if (unordered.length > 0) {
        this.queue = this.queue.filter(j => simTime >= j.startedAt);
        for (const job of unordered) {
          console.log(`[BuildQueue] Rewound to t=${simTime.toFixed(1)} s, before ` +
            `${job.label} was ordered at t=${job.startedAt.toFixed(1)} s - abandoned.`);
          job.abandon(() => this.clearMarks(job));
        }
      }
    }

    // finish() rebuilds the simulation and can therefore be re-entered by
    // anything it triggers, so decide what is done before running any of it.
    const done: BuildJob[] = [];
    for (const job of this.queue) {
      job.elapsed = simTime - job.startedAt;
      const p = Math.min(1, job.elapsed / job.simSeconds);
      for (const t of job.targets) t.buildProgress = p;
      if (job.elapsed >= job.simSeconds) done.push(job);
    }
    for (const job of done) this.complete(job);
  }

  /** Give up on a job: its part is undone and whatever it cost comes back. */
  cancel(jobId: string): boolean {
    const job = this.queue.find(j => j.id === jobId);
    if (!job) return false;
    this.queue = this.queue.filter(j => j !== job);
    console.log(`[BuildQueue] Cancelled ${job.label} at ` +
      `${(100 * job.elapsed / Math.max(job.simSeconds, 1e-9)).toFixed(0)}%`);
    job.abandon(() => this.clearMarks(job));
    return true;
  }

  /**
   * Drop a job WITHOUT its abandon hook: the parts are not going back on the
   * shelf - a wave took them (see simulation/wave-casualties.ts). The
   * caller removes the components themselves.
   */
  discard(jobId: string): boolean {
    const job = this.queue.find(j => j.id === jobId);
    if (!job) return false;
    this.queue = this.queue.filter(j => j !== job);
    console.log(`[BuildQueue] Discarded ${job.label} at ` +
      `${(100 * job.elapsed / Math.max(job.simSeconds, 1e-9)).toFixed(0)}% - the parts are lost`);
    this.clearMarks(job);
    return true;
  }

  /** The job holding this part, if any. */
  jobFor(target: Buildable): BuildJob | null {
    return this.queue.find(j => j.targets.includes(target)) ?? null;
  }

  /** Drop every job without running it - a different plant was loaded. */
  clear(): void {
    for (const job of this.queue) this.clearMarks(job);
    this.queue = [];
  }

  /**
   * Run every outstanding job now.
   *
   * Entering construction mode stops the plant: the work happens during the
   * outage, so nothing is left half-installed on a map the player is about
   * to rebuild.
   */
  finishAll(): void {
    const pending = this.queue;
    this.queue = [];
    for (const job of pending) job.finish(() => this.clearMarks(job));
  }

  private complete(job: BuildJob): void {
    this.queue = this.queue.filter(j => j !== job);
    job.finish(() => this.clearMarks(job));
  }

  private clearMarks(job: BuildJob): void {
    for (const t of job.targets) {
      delete t.underConstruction;
      delete t.pendingRemoval;
      delete t.buildProgress;
    }
  }
}

// ===========================================================================
// How much a part weighs
// ===========================================================================

/**
 * Installed mass of a component, in kilograms.
 *
 * These are ordinary engineering estimates from the component's own stored
 * geometry and rating - a shell of ASME wall thickness for anything that
 * holds pressure, and a power law for the rotating machines, whose mass is
 * set by their duty rather than by how big they are drawn. They are not
 * tuned to produce a particular build time; the build time is whatever the
 * one rate above makes of them.
 */
export function componentBuildMassKg(component: PlantComponent): number {
  const c = component as unknown as Record<string, number | string | undefined>;
  const num = (v: unknown, dflt: number) => (typeof v === 'number' && isFinite(v) ? v : dflt);

  switch (component.type) {
    case 'pipe': {
      const pipe = component as PipeComponent;
      return pipeSteelMassPerMetre(num(pipe.diameter, 0.3), num(pipe.pressureRating, 16))
        * Math.max(0, num(pipe.length, 1));
    }

    case 'tank':
      return vesselSteelMass(num(c.width, 3), num(c.height, 5), num(c.pressureRating, 10));

    case 'vessel':
      return vesselSteelMass(num(c.innerDiameter, num(c.width, 3)), num(c.height, 5),
        num(c.pressureRating, 100));

    case 'reactorVessel':
      // Plus internals: the barrel, the upper plenum, the head studs. A
      // large PWR vessel is ~400 t bare and ~700 t installed.
      return vesselSteelMass(num(c.innerDiameter, 4), num(c.height, 12),
        num(c.pressureRating, 175)) * 1.7;

    case 'coreBarrel':
      // A thin shell that carries no pressure difference to speak of, plus
      // the fuel standing in it.
      return vesselSteelMass(num(c.innerDiameter, 3), num(c.height, 4), 10, false) * 1.4;

    case 'crossVessel':
      return vesselSteelMass(num(c.outerDiameter, num(c.diameter, 1)), num(c.length, 5),
        num(c.pressureRating, 60));

    case 'heatExchanger': {
      // Shell plus a tube bundle roughly as heavy again as the shell.
      const horizontal = c.orientation !== undefined
        ? c.orientation === 'horizontal'
        : num(c.height, 0) < num(c.width, 0);
      const d = horizontal ? num(c.height, 2) : num(c.width, 2);
      const l = horizontal ? num(c.width, 6) : num(c.height, 6);
      return vesselSteelMass(d, l, num(c.shellPressureRating, num(c.pressureRating, 60))) * 2.0;
    }

    case 'condenser':
      // A low-pressure box with a very large tube bundle inside it.
      return vesselSteelMass(num(c.width, 6), num(c.height, 5), 5) * 2.5;

    case 'pump':
      return pumpTrainMassKg(num(c.ratedFlow, 100), num(c.ratedHead, 50));

    case 'turbine-driven-pump':
      // The same pump with a steam turbine and its governor on the shaft.
      return pumpTrainMassKg(num(c.ratedFlow, 100), num(c.ratedHead, 50)) * 1.6;

    case 'turbine-generator':
      // 11.25 t per (MW)^0.75: a 1000 MW train lands near 2000 t.
      return 11250 * Math.pow(Math.max(num(c.ratedPower, 100e6) / 1e6, 1e-6), 0.75);

    case 'valve': {
      // Body and bonnet: a shell about 2.5 bores across and 3 bores long,
      // doubled for the bonnet, the trim and the actuator.
      const d = Math.max(num(c.diameter, 0.2), 1e-3);
      return vesselSteelMass(2.5 * d, 3 * d, num(c.pressureRating, 60), false) * 2;
    }

    case 'controller':
      // An instrument cabinet: it is cable and thought, not steel.
      return 50;

    case 'warehouse':
      // A steel-framed open shed, about 150 kg of structure per m2 of floor.
      return num(c.width, 6) * num(c.depth, 4) * 150;

    case 'switchyard':
      // Transformers dominate; 1.5 t per (MW)^0.7.
      return 1500 * Math.pow(Math.max(num(c.transformerRating, 100), 1e-6), 0.7);

    case 'transformer':
      // Oil-filled power transformer: ~20 t at 10 MVA, ~110 t at 100 MVA.
      return 3500 * Math.pow(Math.max(num(c.ratingMVA, 10), 1e-6), 0.75);

    case 'bus':
      // A lineup of metal-clad switchgear cubicles.
      return 2500;

    case 'breaker':
      // One breaker cubicle.
      return 400;

    case 'diesel-generator':
      // Medium-speed engine, generator and skid: ~12 kg per kW.
      return 12 * Math.max(num(c.ratingKW, 4000), 1e-6);

    case 'battery':
      // Lead-acid cells with their racks: ~35 kg per kWh.
      return 35 * Math.max(num(c.capacityKWh, 250), 1e-6);

    case 'pool': {
      // Reinforced concrete: floor plus four walls, at 2400 kg/m3.
      const side = num(c.side, 12), depth = num(c.depth, 12), t = num(c.wallThickness, 1.5);
      return (side * side + 4 * side * depth) * t * 2400;
    }

    case 'building': {
      // Shell of concrete: the wall ring plus a roof and a mat.
      const shape = c.shape ?? 'cylinder';
      const h = num(c.height, 25);
      const t = num(c.wallThickness, 1.0);
      const area = shape === 'cylinder'
        ? Math.PI * num(c.diameter, 40) * h + 2 * Math.PI * Math.pow(num(c.diameter, 40) / 2, 2)
        : 2 * (num(c.width, 40) + num(c.length, 40)) * h + 2 * num(c.width, 40) * num(c.length, 40);
      return area * t * 2400;
    }
  }

  // Unreachable while the switch above covers every ComponentType (the
  // compiler proves it), but a type added later would land here. Say so
  // loudly rather than quietly making the new thing free to build.
  const unknown = component as { type: string; id: string };
  console.error(
    `[BuildQueue] No installed-mass estimate for component type '${unknown.type}' ` +
    `('${unknown.id}'). Using a nominal 1000 kg, so its build time is a guess. ` +
    `Add it to componentBuildMassKg in src/game/build-queue.ts.`);
  return 1000;
}

/** Pump plus motor plus baseplate: 90 kg per (hydraulic kW)^0.7. */
function pumpTrainMassKg(ratedFlowKgS: number, ratedHeadM: number): number {
  const hydraulicKW = Math.max(ratedFlowKgS * 9.81 * ratedHeadM / 1000, 1e-6);
  return 90 * Math.pow(hydraulicKW, 0.7);
}

/**
 * Installed mass of a connection: the run of pipe it is.
 *
 * A connection with a pipe COMPONENT is that component's mass, counted
 * there; the connection itself is then the two short stubs at its ends and
 * weighs what its own stated length says.
 */
export function connectionBuildMassKg(conn: Connection): number {
  const area = conn.flowArea ?? 0.07;
  const diameter = 2 * Math.sqrt(Math.max(area, 1e-9) / Math.PI);
  // A bare connection stores no pressure rating (only a pipe COMPONENT
  // does), so it is priced at yard pressure. At these bores that is the
  // 3 mm handling minimum anyway - the ASME wall for 0.3 m at 16 bar is
  // 1.8 mm - so the rating makes no difference to the mass until the line
  // is a primary-pressure one, which is never a bare connection in the yard.
  return pipeSteelMassPerMetre(diameter, CONNECTION_NOMINAL_BAR)
    * Math.max(0, conn.length ?? 0);
}

/** Yard service pressure: what a connection with no stated rating is built to. */
const CONNECTION_NOMINAL_BAR = 16;

/** Simulated seconds a mass takes to install (or to take away again). */
export function buildSimSecondsForMass(massKg: number): number {
  return Math.max(0, massKg) * SIM_SECONDS_PER_KG;
}

/**
 * What a renderer needs to know about a part that is not finished: how far
 * along it is and which way it is going. Null for everything else, which is
 * almost everything, so the drawing cost is a property lookup.
 */
export function buildGhost(target: unknown): { progress: number; kind: BuildJobKind } | null {
  const t = target as Buildable | null | undefined;
  if (!t) return null;
  if (t.underConstruction) return { progress: t.buildProgress ?? 0, kind: 'build' };
  if (t.pendingRemoval) return { progress: t.buildProgress ?? 0, kind: 'return' };
  return null;
}

/**
 * The ring that says how far along a ghost is. Drawn in screen space at the
 * middle of whatever the part is drawn in.
 */
export function drawBuildProgress(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, radius: number,
  progress: number, kind: BuildJobKind
): void {
  const r = Math.max(11, radius);
  const p = Math.max(0, Math.min(1, progress));
  ctx.save();
  // A dark disc behind it: the ring has to read on bare ground, on concrete
  // and over a sprite, and a stroke alone does not.
  ctx.fillStyle = 'rgba(8, 10, 14, 0.3)';
  ctx.beginPath();
  ctx.arc(x, y, r * 1.18, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = Math.max(2, r * 0.22);
  ctx.strokeStyle = 'rgba(10, 12, 14, 0.7)';
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = kind === 'build' ? 'rgba(90, 200, 255, 0.95)' : 'rgba(255, 175, 70, 0.95)';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}
