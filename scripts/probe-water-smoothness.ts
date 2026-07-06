/**
 * Probe smoothness of P(u,v) from water-properties-v4.
 *
 * Sweeps u (at fixed v) and v (at fixed u) along fine lines through states the
 * preset plants actually occupy, and reports the largest jumps in the numerical
 * derivative dP/du and dP/dv between adjacent intervals. C1-smooth interpolation
 * would show slowly varying derivatives; piecewise-linear tables show derivative
 * jumps at knots; discontinuous interpolation (IDW with truncated support) shows
 * jumps in P itself.
 *
 * Usage: npx tsx scripts/probe-water-smoothness.ts
 */

import { calculateState } from '../src/simulation/water-properties-v4';

interface JumpReport {
  x: number;
  slopeBefore: number;
  slopeAfter: number;
  jump: number;
  pJump?: number;
}

function sweep(
  label: string,
  xStart: number,
  xEnd: number,
  n: number,
  evalP: (x: number) => number
): void {
  const xs: number[] = [];
  const ps: number[] = [];
  let failures = 0;

  for (let i = 0; i <= n; i++) {
    const x = xStart + ((xEnd - xStart) * i) / n;
    try {
      ps.push(evalP(x));
      xs.push(x);
    } catch {
      failures++;
    }
  }

  if (xs.length < 10) {
    console.log(`${label}: only ${xs.length} valid samples (${failures} failures) - skipping`);
    return;
  }

  // Numerical slopes per interval
  const slopes: number[] = [];
  for (let i = 0; i < xs.length - 1; i++) {
    slopes.push((ps[i + 1] - ps[i]) / (xs[i + 1] - xs[i]));
  }

  // Find largest slope jumps between adjacent intervals, and largest P jumps
  const jumps: JumpReport[] = [];
  for (let i = 0; i < slopes.length - 1; i++) {
    jumps.push({
      x: xs[i + 1],
      slopeBefore: slopes[i],
      slopeAfter: slopes[i + 1],
      jump: Math.abs(slopes[i + 1] - slopes[i]),
    });
  }
  jumps.sort((a, b) => b.jump - a.jump);

  const meanAbsSlope =
    slopes.reduce((s, v) => s + Math.abs(v), 0) / slopes.length;
  const pRange = Math.max(...ps) - Math.min(...ps);
  const dx = (xEnd - xStart) / n;

  console.log(`\n=== ${label} ===`);
  console.log(
    `samples=${xs.length}, failures=${failures}, P range=${(pRange / 1e5).toFixed(3)} bar, mean |dP/dx|=${meanAbsSlope.toExponential(3)} Pa/unit`
  );
  console.log(`Top 5 slope discontinuities (dP/dx jump between adjacent intervals):`);
  for (const j of jumps.slice(0, 5)) {
    // Pressure error a step of size dx would see from this kink
    const localPJump = j.jump * dx;
    console.log(
      `  x=${j.x.toPrecision(8)}: slope ${j.slopeBefore.toExponential(3)} -> ${j.slopeAfter.toExponential(3)} ` +
      `(jump=${j.jump.toExponential(3)}, = ${(localPJump).toFixed(1)} Pa per sample-step, ` +
      `${((j.jump / Math.max(meanAbsSlope, 1e-30)) * 100).toFixed(1)}% of mean slope)`
    );
  }

  // Direct P discontinuities (adjacent samples differing far more than neighbors)
  let maxPJump = 0;
  let maxPJumpX = 0;
  for (let i = 0; i < xs.length - 1; i++) {
    const dP = Math.abs(ps[i + 1] - ps[i]);
    if (dP > maxPJump) {
      maxPJump = dP;
      maxPJumpX = xs[i + 1];
    }
  }
  console.log(
    `Largest single-sample |dP|: ${maxPJump.toFixed(1)} Pa at x=${maxPJumpX.toPrecision(8)} ` +
    `(smooth expectation ~${(meanAbsSlope * dx).toFixed(1)} Pa)`
  );
}

// ----------------------------------------------------------------------------
// Probe states matching the PWR preset nodes
// ----------------------------------------------------------------------------

// rv-1-like compressed liquid: ~300C, ~152 bar. u ~ 1332 kJ/kg, v slightly under v_f.
{
  const v0 = 0.001373; // m3/kg - compressed at ~150 bar
  sweep('LIQUID: P vs u at v=1.373 mL/g (rv-1-like, ~300C/150bar)', 1_300_000, 1_360_000, 30000, (u) => {
    const st = calculateState(1, u, v0);
    if (st.phase !== 'liquid') throw new Error('not liquid');
    return st.pressure;
  });

  const u0 = 1_332_000; // J/kg
  sweep('LIQUID: P vs v at u=1332 kJ/kg (rv-1-like)', 0.001355, 0.001395, 30000, (v) => {
    const st = calculateState(1, u0, v);
    if (st.phase !== 'liquid') throw new Error('not liquid');
    return st.pressure;
  });
}

// Cold compressed liquid like the condensate string: ~35C. u ~ 146 kJ/kg.
{
  const v0 = 0.001004;
  sweep('LIQUID: P vs u at v=1.004 mL/g (condensate-like, ~35C)', 130_000, 170_000, 30000, (u) => {
    const st = calculateState(1, u, v0);
    if (st.phase !== 'liquid') throw new Error('not liquid');
    return st.pressure;
  });
}

// Vapor like turbine inlet: ~275C, 60 bar: u ~ 2590 kJ/kg, v ~ 0.032 m3/kg
{
  const v0 = 0.032;
  sweep('VAPOR: P vs u at v=32 mL/g (turbine-inlet-like, ~60bar)', 2_550_000, 2_650_000, 30000, (u) => {
    const st = calculateState(1, u, v0);
    if (st.phase !== 'vapor') throw new Error('not vapor');
    return st.pressure;
  });

  const u0 = 2_590_000;
  sweep('VAPOR: P vs v at u=2590 kJ/kg (turbine-inlet-like)', 0.030, 0.036, 30000, (v) => {
    const st = calculateState(1, u0, v);
    if (st.phase !== 'vapor') throw new Error('not vapor');
    return st.pressure;
  });
}

// Two-phase like the SG shell: ~20 bar, x~0.1: v between v_f and v_g
{
  const v0 = 0.01; // m3/kg, x ~ 0.09 at 20 bar
  sweep('TWO-PHASE: P vs u at v=10 mL/g (SG-shell-like)', 1_800_000, 2_100_000, 30000, (u) => {
    const st = calculateState(1, u, v0);
    if (st.phase !== 'two-phase') throw new Error('not two-phase');
    return st.pressure;
  });
}
