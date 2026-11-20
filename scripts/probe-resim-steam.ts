/**
 * Headless check: a re-click of Simulation (and Reset SCRAM) must not inject
 * steam into gas-filled volumes.
 *
 * The per-frame display sync writes TOTAL pressure into component.fluid.pressure,
 * while the factory reads that field as the STEAM partial pressure. Any rebuild
 * from those fields (without the write-back in resume.ts) fills every gas
 * volume with roughly its own pressure of steam.
 *
 *   npx vite --port 3019 --strictPort      (in another shell)
 *   npx tsx scripts/probe-resim-steam.ts [port] [preset label]
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const port = process.argv[2] || '3019';
const preset = process.argv[3] || 'Xe-100';

async function main() {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: ['--window-size=1400,900'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.evaluateOnNewDocument('window.__name = (f) => f;');
  page.on('pageerror', (e: Error) => console.log('PAGE ERROR', e.message));

  await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.gm-title-sandbox');
  await page.evaluate(() => (document.querySelector('.gm-title-sandbox') as HTMLElement).click());
  await page.evaluate(() => (document.querySelector('#open-save-load-btn') as HTMLElement).click());
  await page.waitForSelector('#dialog-preset-grid');
  const found = await page.evaluate((l: string) => {
    const btn = Array.from(document.querySelectorAll('#dialog-preset-grid button')).find(b => b.textContent === l) as HTMLElement | undefined;
    btn?.click();
    return !!btn;
  }, preset);
  if (!found) throw new Error(`preset ${preset} not found`);

  // Total water mass in the helium-filled volumes
  const steamInGas = () => page.evaluate(() => {
    const st = (window as any).__meltdownDebug.gameLoop.getState();
    let steam = 0, nodes = 0;
    for (const n of st.flowNodes.values()) {
      const ncg = n.fluid.ncg;
      if (!ncg) continue;
      if (!(ncg.He > 0)) continue; // helium volumes only (not the atmosphere)
      nodes++;
      steam += n.fluid.mass;
    }
    return { steam, nodes, time: st.time };
  });
  const click = (sel: string) => page.evaluate((s: string) => (document.querySelector(s) as HTMLElement).click(), sel);
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

  await click('#mode-simulation');
  await wait(1000);
  const first = await steamInGas();
  // Let a few frames of display sync run, as in the browser
  await click('#pause-btn');
  await wait(1500);
  await click('#pause-btn');
  const running = await steamInGas();
  await click('#mode-simulation');
  await wait(1000);
  const second = await steamInGas();

  console.log(`first build:     water in ${first.nodes} gas nodes = ${first.steam.toFixed(3)} kg (t=${first.time.toFixed(2)})`);
  console.log(`after running:   water in gas nodes = ${running.steam.toFixed(3)} kg (t=${running.time.toFixed(2)})`);
  console.log(`after re-click:  water in gas nodes = ${second.steam.toFixed(3)} kg (t=${second.time.toFixed(2)})`);

  let ok = Math.abs(second.steam - running.steam) <= 0.01 * Math.max(1, running.steam) && second.time === running.time;
  console.log(ok ? 'PASS re-click: state unchanged' : 'FAIL re-click changed the state');

  // Reset SCRAM rebuilds to the initial conditions
  const hasReset = await page.evaluate(() => !!document.querySelector('#reset-scram-btn'));
  if (hasReset) {
    await click('#reset-scram-btn');
    await wait(1000);
    const reset = await steamInGas();
    console.log(`after reset:     water in gas nodes = ${reset.steam.toFixed(3)} kg (t=${reset.time.toFixed(2)})`);
    const resetOk = Math.abs(reset.steam - first.steam) <= 0.01 * Math.max(1, first.steam);
    console.log(resetOk ? 'PASS reset: back to the initial inventory' : 'FAIL reset did not return to the initial inventory');
    ok = ok && resetOk;
  }
  // A plant loaded while running still gets its simulation built by a click
  const nodeIds = () => page.evaluate(() =>
    Array.from((window as any).__meltdownDebug.gameLoop.getState().flowNodes.keys()).sort().join('|'));
  const before = await nodeIds();
  await click('#open-save-load-btn');
  await page.waitForSelector('#dialog-preset-grid');
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('#dialog-preset-grid button')).find(b => b.textContent === 'PWR') as HTMLElement;
    btn.click();
  });
  await wait(500);
  await click('#mode-simulation');
  await wait(1000);
  const after = await nodeIds();
  const builtOk = after !== before;
  console.log(builtOk ? 'PASS load-while-running: Simulation built the new plant' : 'FAIL load-while-running: still the old simulation');
  ok = ok && builtOk;

  await browser.close();
  process.exit(ok ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
