/**
 * Headless screenshots of a preset in both views (2.5D and the 2D grid),
 * for eyeballing rendering changes.
 *
 *   BROWSER=none npx vite --port 3027 --strictPort      (in another shell)
 *   npx tsx scripts/shot-views.ts [port] [preset label ...]
 *
 * Needs puppeteer-core in node_modules (npm install --no-save puppeteer-core)
 * and the installed Chrome. PNGs go to SHOT_OUT (default: the cwd).
 */
import { createRequire } from 'module';
import { writeFileSync } from 'fs';
import { join } from 'path';

const require = createRequire(join(process.cwd(), 'package.json'));
const puppeteer = require('puppeteer-core');

const port = process.argv[2] || '3027';
const presets = process.argv.slice(3).length ? process.argv.slice(3) : ['Xe-100 (HTGR)', 'PWR'];
const outDir = process.env.SHOT_OUT || process.cwd();
const zoom = parseFloat(process.env.SHOT_ZOOM || '1');
/** Component id to crop round (SHOT_FOCUS), device pixel ratio (SHOT_DPR), and SHOT_SIM=1 to run the plant first. */
const focus = process.env.SHOT_FOCUS || '';
const dpr = parseFloat(process.env.SHOT_DPR || '1');
const sim = process.env.SHOT_SIM === '1';

async function main() {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: ['--window-size=1600,1000'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: dpr });
  await page.evaluateOnNewDocument('window.__name = (f) => f;');
  page.on('pageerror', (e: Error) => console.log('PAGE ERROR', e.message));
  page.on('console', (m: any) => { const t = m.text(); if (/error|Error/.test(t)) console.log('CONSOLE', t.slice(0, 300)); });

  for (const label of presets) {
    await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.gm-title-sandbox');
    await page.evaluate(() => (document.querySelector('.gm-title-sandbox') as HTMLElement).click());
    await page.waitForSelector('#open-save-load-btn');
    await page.evaluate(() => (document.querySelector('#open-save-load-btn') as HTMLElement).click());
    await page.waitForSelector('#dialog-preset-grid');
    const found = await page.evaluate((l: string) => {
      const btn = Array.from(document.querySelectorAll('#dialog-preset-grid button')).find(b => b.textContent === l) as HTMLElement | undefined;
      if (!btn) return Array.from(document.querySelectorAll('#dialog-preset-grid button')).map(b => b.textContent).join(' | ');
      btn.click();
      return '';
    }, label);
    if (found) { console.log(`preset ${label} not found; have: ${found}`); continue; }
    await new Promise(r => setTimeout(r, 1500));
    const slug = label.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    if (sim) {
      await page.evaluate(() => (document.querySelector('#mode-simulation') as HTMLElement).click());
      await new Promise(r => setTimeout(r, 3000));
    }

    for (const mode of ['perspective', 'grid']) {
      const box = await page.evaluate((m: string, z: number, id: string) => {
        (document.querySelector(`#view-mode-${m}`) as HTMLElement).click();
        const pc = (window as any).__meltdownDebug.plantCanvas;
        pc.centerOnPlant();
        if (z !== 1) pc.setIsoZoom(z);
        if (!id) return null;
        const comp = pc.plantState.components.get(id);
        const b = comp && pc.getComponentScreenBounds(comp);
        return b ? { x: b.topCenter.x, y: b.topCenter.y, w: b.width ?? 100, h: b.height ?? 100 } : null;
      }, mode, zoom, focus);
      await new Promise(r => setTimeout(r, 800));
      // A focused shot crops round the component (with its neighbourhood)
      const clip = box ? {
        x: Math.max(0, box.x - box.w * 1.5), y: Math.max(0, box.y - box.h * 0.4),
        width: Math.min(1600, box.w * 3), height: Math.min(1000, box.h * 2.2),
      } : undefined;
      if (mode === 'perspective') {
        // Render-only cost of the 2.5D frame, averaged over a few frames
        const perf = await page.evaluate(async () => {
          const pc = (window as any).__meltdownDebug.plantCanvas;
          let total = 0; const sections: Record<string, number> = {};
          for (let i = 0; i < 20; i++) {
            await new Promise<void>(r => requestAnimationFrame(() => r()));
            total += pc.lastFrameMs;
            for (const [k, v] of Object.entries(pc.frameProfile as Record<string, number>)) sections[k] = (sections[k] ?? 0) + v;
          }
          for (const k of Object.keys(sections)) sections[k] = +(sections[k] / 20).toFixed(2);
          return { frameMs: +(total / 20).toFixed(2), sections };
        });
        console.log('2.5D frame', JSON.stringify(perf));
      }
      const png = await page.screenshot({ type: 'png', clip });
      const file = join(outDir, `shot-${slug}-${mode}${focus ? '-' + focus : ''}${sim ? '-sim' : ''}.png`);
      writeFileSync(file, png);
      console.log('wrote', file);
    }
  }
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
