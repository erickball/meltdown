/**
 * Headless screenshots of the 3D view harness.
 *
 *   BROWSER=none npx vite --port 3021 --strictPort      (in another shell)
 *   npx tsx scripts/scene3d-harness/shoot.ts [port] [outDir]
 *
 * Needs puppeteer-core (npm install --no-save puppeteer-core) and the
 * installed Chrome. Headless Chrome gets WebGL through SwiftShader.
 */
import { createRequire } from 'module';
import { join } from 'path';
import { mkdirSync } from 'fs';

const require = createRequire(join(process.cwd(), 'package.json'));
const puppeteer = require('puppeteer-core');

const port = process.argv[2] || '3021';
const outDir = process.argv[3] || process.cwd();
mkdirSync(outDir, { recursive: true });

type V = { x: number; y: number; z: number };
const v = (x: number, y: number, z: number): V => ({ x, y, z });

async function main() {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: ['--window-size=1400,900', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  try {
    const page = await browser.newPage();
    const log: string[] = [];
    page.on('console', (m: { type(): string; text(): string }) => log.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', (e: Error) => log.push(`[pageerror] ${e.message}`));
    page.on('response', (r: { status(): number; url(): string }) => { if (r.status() >= 400) log.push(`[http ${r.status()}] ${r.url()}`); });
    await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
    await page.goto(`http://localhost:${port}/scripts/scene3d-harness/index.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('window.harness !== undefined', { timeout: 60000 });
    const settle = () => new Promise(r => setTimeout(r, 1500));
    const shot = async (name: string) => {
      await settle();
      await page.screenshot({ path: join(outDir, `${name}.png`) });
      console.log('shot', name);
    };
    const cam = (from: V, to: V) => page.evaluate((f: V, t: V) => (window as any).harness.setCam(f, t), from, to);
    const call = (expr: string) => page.evaluate(expr);

    await shot('01-frame-all');
    await cam(v(70, -60, 35), v(5, 0, 6));
    await shot('02-southeast');
    await cam(v(-45, 50, 30), v(-10, 5, 3));
    await shot('03-northwest-pool');
    await cam(v(6, -14, 12), v(1, 0, 8));
    await shot('04-close-vessel');
    await cam(v(30, -12, 22), v(18, -10, 10));
    await shot('05-elbows');
    await cam(v(-15, -30, 6), v(10, 10, 2));
    await shot('06-low-angle');
    console.log('pick true sky (low angle, right edge):', JSON.stringify(await call('harness.pick(1390, 250)')));
    console.log('pick pipe (low angle):', JSON.stringify(await call('harness.pick(1255, 250)')));

    // Pick the vessel from the front: centre of screen looking at the core through containment + RPV
    await cam(v(0, -40, 7), v(0, 0, 6));
    await settle();
    console.log('pick centre (core inside rpv inside containment):', JSON.stringify(await call('harness.pick(700, 450)')));
    console.log('pick sky:', JSON.stringify(await call('harness.pick(700, 20)')));
    console.log('pick ground:', JSON.stringify(await call('harness.pick(30, 880)')));
    await call(`harness.highlight({ componentId: 'rpv' })`);
    await shot('07-highlight-rpv');
    await call(`harness.highlight({ connectionKey: 'rpv:out>tank:in' })`);
    await call('harness.hot()');
    await cam(v(45, -45, 30), v(8, -5, 7));
    await shot('08-hot-colours-pipe-highlight');
    await call('harness.highlight(null)');
    await call('harness.rest()');
    await shot('09-rest-again');

    console.log('bad shape:', await call('harness.badShape()'));
    await call('harness.modelB()');
    await shot('10-model-b-kept-camera');
    await call('harness.frameAll()');
    await shot('11-model-b-framed');
    await cam(v(3.9, -0.6, 0.8), v(3.5, 0, 0.5));
    await shot('12-model-b-valve-close');
    await call('harness.modelA()');
    await call('harness.frameAll()');
    await shot('13-model-a-again');
    await call('harness.hide()');
    await shot('14-hidden');
    await call('harness.show()');
    console.log('canvases after dispose:', await call('harness.dispose()'));
    console.log('harness errors:', JSON.stringify(await call('harness.errors')));
    console.log('--- console ---\n' + log.join('\n'));
  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
