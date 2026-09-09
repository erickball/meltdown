/**
 * Zircaloy oxidation kinetics check: the steam and air parabolic constants
 * side by side, and what they mean for a spent-fuel rack standing in air.
 *
 *   npx tsx scripts/check-zr-oxidation.ts
 *
 * Air constants: Benjamin et al., NUREG/CR-0649 (Sandia 1979) Fig. 6.
 * Steam constants: Baker-Just (1962).
 * See docs/zircaloy-air-oxidation.md.
 */

const R = 8.314;

function kSteam(T: number): number {
  return 7.8817e-5 * Math.exp(-190372 / (R * T));
}
function kAir(T: number): number {
  if (T <= 1193.15) return 2.2120e-8 * Math.exp(-114391 / (R * T));
  if (T <= 1428.15) return 1.1079e-3 * Math.exp(-221710 / (R * T));
  return 1.1926e-6 * Math.exp(-121658 / (R * T));
}

// Level 1's rack: 250 assemblies x 264 rods, 9.5 mm OD, 0.6 mm clad,
// 4.16 m tall - the geometry factory.ts derives from the pool component.
const ROD_COUNT = 250 * 264;
const ROD_D = 0.0095;
const CLAD_T = 0.0006;
const ACTIVE_H = 3.66;
const AREA = Math.PI * ROD_D * ACTIVE_H * ROD_COUNT;   // m2
const ZR_RHO = 6500, ZR_M = 0.09122;
const OXIDE0 = 1e-6;
const DECAY = 8e6;   // W

console.log(`rack: ${ROD_COUNT} rods, ${AREA.toFixed(0)} m2 of cladding, ` +
  `decay heat ${(DECAY / 1e6).toFixed(1)} MW\n`);
console.log('   T/C     k_steam/m2/s      k_air/m2/s   air/steam   ' +
  'air power at 1 um oxide      vs decay');
for (const C of [400, 600, 700, 800, 850, 900, 920, 1000, 1100, 1155, 1200, 1400, 1600]) {
  const T = C + 273.15;
  const ks = kSteam(T), ka = kAir(T);
  // Fresh oxide, kinetics only (no transport limit): the upper bound
  const v = ka / (2 * OXIDE0);                       // m/s of metal
  const molZr = (ZR_RHO * v / ZR_M) * AREA;          // mol/s
  const power = molZr * 1096e3;                      // W
  console.log(
    `${C.toString().padStart(6)}  ${ks.toExponential(3).padStart(15)} ` +
    `${ka.toExponential(3).padStart(15)}  ${(ka / ks).toFixed(2).padStart(9)}  ` +
    `${(power / 1e6).toFixed(3).padStart(20)} MW  ${(power / DECAY).toFixed(2).padStart(10)}x`);
}

// Where does the AIR reaction alone match the decay heat? That is the
// classic "self-sustaining oxidation" temperature for a drained pool - it
// is not a constant in the model, it is where two curves cross.
let ignition = NaN;
for (let C = 300; C < 1600; C += 0.5) {
  const T = C + 273.15;
  const v = kAir(T) / (2 * OXIDE0);
  const power = (ZR_RHO * v / ZR_M) * AREA * 1096e3;
  if (power >= DECAY) { ignition = C; break; }
}
console.log(`\nUnstarved air oxidation matches the ${(DECAY / 1e6).toFixed(0)} MW decay ` +
  `heat at ${ignition.toFixed(0)} C (fresh 1 um oxide).`);
console.log('Benjamin et al. put self-sustaining clad oxidation for a drained PWR pool ' +
  'at 5.7-8.7 kW per assembly, i.e. 1.4-2.2 MW over 250 - the same neighbourhood.');

// Transport ceiling: how much oxygen can reach the rods by diffusion alone
// (Sh = 2, the stagnant limit) if the pool space is full of air?
const D = 1.5e-4;                     // m2/s, O2 in N2 at ~1000 K
const hm = 2 * D / ROD_D;
for (const [label, pO2] of [['air', 21000], ['half-spent air', 10000], ['2% O2', 2000]] as const) {
  const C_O2 = pO2 / (R * 1000);
  const molO2 = hm * C_O2 * AREA;
  console.log(`transport ceiling in ${label}: ${(molO2 * 1096e3 / 1e6).toFixed(1)} MW ` +
    `(${molO2.toFixed(0)} mol O2/s)`);
}
