import { calculateState } from '../src/simulation/water-properties-v4';
calculateState(1, 1e6, 1e-3);
function scan(v: number, u0: number, u1: number, n: number) {
  console.log(`--- v=${v} m3/kg, u ${u0}..${u1} kJ/kg ---`);
  let prev: any = null;
  let worstT = 0, worstP = 0, worstAt = '';
  for (let i = 0; i <= n; i++) {
    const uk = u0 + (u1-u0)*i/n;
    let s: any = null;
    try { s = calculateState(1, uk*1e3, v); } catch(e){ console.log(`  u=${uk.toFixed(3)} THREW ${String((e as Error).message).split('\n')[0]}`); prev=null; continue; }
    if (prev) {
      const dT = Math.abs(s.temperature - prev.temperature);
      const dP = Math.abs(s.pressure - prev.pressure)/Math.max(1e-30,0.5*(s.pressure+prev.pressure));
      if (dT > worstT) { worstT = dT; worstAt = `u=${uk.toFixed(4)}`; }
      if (dP > worstP) worstP = dP;
    }
    prev = s;
  }
  console.log(`  worst adjacent dT=${worstT.toExponential(3)} K at ${worstAt}, worst rel dP=${worstP.toExponential(3)} (step du=${((u1-u0)/n).toExponential(2)} kJ/kg)`);
}
scan(1e4, 2280, 2360, 4000);
scan(10, -250, 150, 4000);
scan(100, -400, 1400, 4000);
scan(206, 0, 2500, 4000);
scan(1.2e-3, -350, 20, 4000);
