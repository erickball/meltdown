// Debug the dome detection for state: u=858 kJ/kg, v=0.00228 m³/kg

import * as fs from 'fs';

const satData = JSON.parse(fs.readFileSync('./public/saturation_dome_iapws.json', 'utf-8'));

const u = 858.14e3; // J/kg
const v = 0.00228765; // m³/kg

const v_crit = satData.critical_point.v_c;
console.log('v_crit =', (v_crit * 1e6).toFixed(2), 'mL/kg');
console.log('Our v =', (v * 1e6).toFixed(2), 'mL/kg');
console.log('v < v_crit:', v < v_crit);

// Find the T where v = v_f(T) - liquid side since v < v_crit
console.log('\nLooking for T where v_f = v...');

const rawData = satData.raw_data;
for (let i = 0; i < rawData.length - 1; i++) {
  const p1 = rawData[i];
  const p2 = rawData[i + 1];

  if (p1.v_f <= v && v <= p2.v_f) {
    // Found bracket
    const t = (v - p1.v_f) / (p2.v_f - p1.v_f);
    const T_interp = p1.T_K + t * (p2.T_K - p1.T_K);
    const u_f_interp = (p1.u_f + t * (p2.u_f - p1.u_f)) * 1000; // J/kg
    const u_g_interp = (p1.u_g + t * (p2.u_g - p1.u_g)) * 1000; // J/kg

    console.log(`Found bracket at T = ${(T_interp - 273).toFixed(1)}°C`);
    console.log(`  u_f = ${(u_f_interp/1e3).toFixed(2)} kJ/kg`);
    console.log(`  u_g = ${(u_g_interp/1e3).toFixed(2)} kJ/kg`);
    console.log(`  Our u = ${(u/1e3).toFixed(2)} kJ/kg`);
    console.log(`  Inside dome: ${u > u_f_interp && u < u_g_interp}`);
    break;
  }
}

// Also check what findSaturationAtV would return
console.log('\nChecking saturation data bounds:');
console.log(`  v_f range: ${(rawData[0].v_f * 1e6).toFixed(2)} to ${(rawData[rawData.length-1].v_f * 1e6).toFixed(2)} mL/kg`);
console.log(`  v_g range: ${(rawData[rawData.length-1].v_g * 1e6).toFixed(2)} to ${(rawData[0].v_g * 1e6).toFixed(2)} mL/kg`);
