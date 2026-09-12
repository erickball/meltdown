// When a run between two ports is built as a real pipe, and when it stays a
// direct connection. One rule for everything that lays a run - the connection
// dialog, and the headless level checks that build a level's answer the way a
// player would - so the two cannot drift apart.
//
// A direct connection carries flow but holds no fluid of its own: the factory
// lumps HALF of its A·L into each in-line endpoint (pump, valve) at that
// endpoint's elevation (see the pipe-inventory lumping pass in
// createSimulationFromPlant). That is right for a stub, and wrong for a run
// whose fluid is somewhere else: 250 m of 12-inch discharge line climbing
// 20 m to a pool lumped 8.8 m³ into the pump's 1.8 m³ casing, flat at the
// pump's elevation, and a sea flooding that box slammed its suction column to
// a stop on the last 15 L of air (24 bar, burst casing) - where real water
// would have climbed the line and been slowed by gravity.

/** A run at least this big AND this long is a pipe: 0.03 m² is a ~20 cm
 *  bore, so small instrument and drain lines stay direct, service lines don't. */
export const AUTO_PIPE_MIN_AREA = 0.03;   // m²
export const AUTO_PIPE_MIN_LENGTH = 1;    // m

/** ...and a run holding more than this is a pipe whatever its bore. The
 *  smallest pump node is 0.3 m³ (factory), so a direct run can lump at most
 *  a sixth of that into it: a 2-inch line stays direct up to ~50 m, a 6-inch
 *  one up to ~6 m. */
export const AUTO_PIPE_MAX_DIRECT_VOLUME = 0.1;   // m³

/** Does a run of this flow area (m²) and length (m) get its own pipe? */
export function createsPipe(flowArea: number, length: number): boolean {
  return (flowArea > AUTO_PIPE_MIN_AREA && length > AUTO_PIPE_MIN_LENGTH)
    || flowArea * length > AUTO_PIPE_MAX_DIRECT_VOLUME;
}
