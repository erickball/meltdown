/**
 * Print the shell-side tube bank every helical bundle in the presets implies:
 * pitch, rows, narrowest flow area and the pressure-loss coefficient the
 * factory charges its shell connections.
 *
 *   npx tsx scripts/probe-shell-bundle.ts
 */
import { readFileSync, readdirSync } from 'fs';
import { helicalTubeBank, tubeBankMinFlowArea, tubeBankRowLossCoefficient } from '../src/simulation/hx-bundles';

const dir = 'src/presets';
for (const file of readdirSync(dir).filter(f => f.endsWith('.json'))) {
  const json = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8'));
  const list = json.components ?? json.plant?.components ?? [];
  for (const entry of list) {
    const c = Array.isArray(entry) ? entry[1] : entry;
    if (c?.type !== 'heatExchanger' || c.hxType !== 'helical') continue;
    const bank = helicalTubeBank(c);
    const xi = tubeBankRowLossCoefficient(bank.pitchRatio);
    console.log(`${file} ${c.id} (${c.tubeModel ?? 'bulk'}): ${c.tubeCount} tubes of ` +
      `${(bank.tubeOD * 1e3).toFixed(0)} mm, S/d ${bank.pitchRatio.toFixed(2)}, ` +
      `${bank.rows.toFixed(0)} rows, face ${bank.faceArea.toFixed(2)} m2, ` +
      `gap ${tubeBankMinFlowArea(bank).toFixed(2)} m2, xi/row ${xi.toFixed(3)}, ` +
      `bundle loss ${(bank.rows * xi).toFixed(1)} gap velocity heads`);
  }
}
