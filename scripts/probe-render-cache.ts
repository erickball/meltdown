/**
 * Headless check of the 2.5D render caches (src/render/sprite-cache.ts).
 *
 * For each preset: load it, pause, capture the plant canvas with the caches
 * off and on, and report how many pixels differ (a clipped sprite margin or
 * a painter reading something the key omits shows up here); then run at the
 * 10x preset for a few seconds each way and report frame time and achieved
 * speed.
 *
 *   npx vite --port 3017 --strictPort      (in another shell)
 *   npx tsx scripts/probe-render-cache.ts [port] [preset label ...]
 *
 * puppeteer-core lives in the main tree's node_modules; Chrome is the
 * installed one.
 */
import { createRequire } from 'module';
import { writeFileSync } from 'fs';

const require = createRequire('C:/Users/erick/source/meltdown/package.json');
const puppeteer = require('puppeteer-core');

const port = process.argv[2] || '3017';
const presets = process.argv.slice(3).length ? process.argv.slice(3) : ['Xe-100 (HTGR)', 'PWR', 'BWR', '4-Loop PWR (W)'];
const outDir = process.env.PROBE_OUT || 'C:/Users/erick/AppData/Local/Temp/claude/c--Users-erick-source-meltdown/66492a99-ed8f-4ab3-8043-d1a111d16281/scratchpad';
const dpr = parseFloat(process.env.DPR || '1');

async function main() {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: ['--window-size=1400,900', '--enable-gpu-rasterization'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: dpr });
  // tsx (esbuild keepNames) decorates serialized callbacks with a __name helper the page lacks
  await page.evaluateOnNewDocument('window.__name = (f) => f;');
  page.on('pageerror', (e: Error) => console.log('PAGE ERROR', e.message));
  page.on('console', (m: any) => { const t = m.text(); if (/error|Error/.test(t)) console.log('CONSOLE', t.slice(0, 200)); });

  for (const label of presets) {
    await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.gm-title-sandbox');
    await page.evaluate(() => (document.querySelector('.gm-title-sandbox') as HTMLElement).click());
    await page.waitForSelector('#open-save-load-btn');
    await page.evaluate(() => (document.querySelector('#open-save-load-btn') as HTMLElement).click());
    await page.waitForSelector('#dialog-preset-grid');
    const found = await page.evaluate((l: string) => {
      const btn = Array.from(document.querySelectorAll('#dialog-preset-grid button')).find(b => b.textContent === l) as HTMLElement | undefined;
      if (!btn) return false;
      btn.click();
      return true;
    }, label);
    if (!found) { console.log(`preset ${label} not found`); continue; }
    await page.waitForSelector('#mode-simulation');
    await page.evaluate(() => (document.querySelector('#mode-simulation') as HTMLElement).click());
    await new Promise(r => setTimeout(r, 1500));

    // --- Pixel diff, paused ---
    // Make sure the sim is paused (button text shows the action available)
    await page.evaluate(() => {
      const b = document.querySelector('#pause-btn') as HTMLElement;
      if (b && b.textContent && b.textContent.includes('Pause')) b.click();
    });
    await new Promise(r => setTimeout(r, 300));

    // 'none' leaves both caches off for the second capture: the frame-to-frame
    // baseline (pulsing overlays, speckle) the cached numbers are read against
    const pixelDiff = (which: 'both' | 'sprites' | 'ground' | 'none') => page.evaluate(async (which: string) => {
      const dbg = (window as any).__meltdownDebug;
      const pc = dbg.plantCanvas;
      const canvas: HTMLCanvasElement = pc.canvas;
      const twoFrames = () => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
      const grab = () => canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let attempt = 0; attempt < 5; attempt++) {
        pc.renderCache.sprites = false; pc.renderCache.ground = false;
        await twoFrames();
        const s0 = Math.floor(Date.now() / 1000);
        const a = grab();
        pc.renderCache.sprites = which === 'both' || which === 'sprites';
        pc.renderCache.ground = which === 'both' || which === 'ground';
        await twoFrames();
        await twoFrames();
        const s1 = Math.floor(Date.now() / 1000);
        const b = grab();
        if (s0 !== s1) continue; // speckle re-seeded between captures; retry
        let differing = 0, big = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1, maxD = 0;
        const w = canvas.width;
        for (let i = 0; i < a.length; i += 4) {
          const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]), Math.abs(a[i + 3] - b[i + 3]));
          if (d > 0) {
            differing++;
            if (d > maxD) maxD = d;
            if (d > 64) {
              big++;
              const p = i / 4, x = p % w, y = (p - x) / w;
              if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
            }
          }
        }
        // Diff image: differing pixels in red on a faded copy of the cached frame
        const dc = document.createElement('canvas');
        dc.width = w; dc.height = canvas.height;
        const img = dc.getContext('2d')!.createImageData(w, canvas.height);
        for (let i = 0; i < a.length; i += 4) {
          const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
          if (d > 64) { img.data[i] = 255; img.data[i + 1] = 0; img.data[i + 2] = 0; }
          else if (d > 0) { img.data[i] = 0; img.data[i + 1] = 0; img.data[i + 2] = 255; }
          else { const g = 128 + b[i] / 2; img.data[i] = g; img.data[i + 1] = g; img.data[i + 2] = g; }
          img.data[i + 3] = 255;
        }
        dc.getContext('2d')!.putImageData(img, 0, 0);
        (window as any).__diffPng = dc.toDataURL('image/png');
        // Cluster big diffs into 24px cells, merge neighbours, crop the largest
        const cell = 24, cw = Math.ceil(w / cell), ch = Math.ceil(canvas.height / cell);
        const counts = new Int32Array(cw * ch);
        for (let i = 0; i < a.length; i += 4) {
          const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
          if (d > 64) { const p = i / 4, x = p % w, y = (p - x) / w; counts[Math.floor(y / cell) * cw + Math.floor(x / cell)]++; }
        }
        const seen = new Uint8Array(cw * ch);
        const clusters: { x0: number; y0: number; x1: number; y1: number; n: number }[] = [];
        for (let c = 0; c < cw * ch; c++) {
          if (!counts[c] || seen[c]) continue;
          const stack = [c]; seen[c] = 1;
          const cl = { x0: cw, y0: ch, x1: 0, y1: 0, n: 0 };
          while (stack.length) {
            const k = stack.pop()!; const kx = k % cw, ky = (k - kx) / cw;
            cl.n += counts[k]; cl.x0 = Math.min(cl.x0, kx); cl.x1 = Math.max(cl.x1, kx); cl.y0 = Math.min(cl.y0, ky); cl.y1 = Math.max(cl.y1, ky);
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const nx = kx + dx, ny = ky + dy;
              if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
              const nk = ny * cw + nx;
              if (counts[nk] && !seen[nk]) { seen[nk] = 1; stack.push(nk); }
            }
          }
          clusters.push(cl);
        }
        clusters.sort((p, q) => q.n - p.n);
        const crops: string[] = [];
        const offC = document.createElement('canvas'); offC.width = w; offC.height = canvas.height;
        const onC = document.createElement('canvas'); onC.width = w; onC.height = canvas.height;
        const ia = new ImageData(new Uint8ClampedArray(a), w), ib = new ImageData(new Uint8ClampedArray(b), w);
        offC.getContext('2d')!.putImageData(ia, 0, 0); onC.getContext('2d')!.putImageData(ib, 0, 0);
        for (const cl of clusters.slice(0, 6)) {
          const x = cl.x0 * cell, y = cl.y0 * cell, cwid = (cl.x1 - cl.x0 + 1) * cell, chei = (cl.y1 - cl.y0 + 1) * cell;
          const mag = Math.max(1, Math.min(4, Math.floor(400 / Math.max(cwid, chei))));
          const cc = document.createElement('canvas'); cc.width = cwid * mag * 3 + 8; cc.height = chei * mag;
          const g = cc.getContext('2d')!; g.imageSmoothingEnabled = false;
          g.fillStyle = '#f0f'; g.fillRect(0, 0, cc.width, cc.height);
          g.drawImage(offC, x, y, cwid, chei, 0, 0, cwid * mag, chei * mag);
          g.drawImage(onC, x, y, cwid, chei, cwid * mag + 4, 0, cwid * mag, chei * mag);
          g.drawImage(dc, x, y, cwid, chei, 2 * (cwid * mag + 4), 0, cwid * mag, chei * mag);
          crops.push(cc.toDataURL('image/png'));
        }
        (window as any).__crops = crops;
        (window as any).__clusters = clusters.slice(0, 6).map(cl => ({ n: cl.n, x: cl.x0 * cell, y: cl.y0 * cell, w: (cl.x1 - cl.x0 + 1) * cell, h: (cl.y1 - cl.y0 + 1) * cell }));
        return { total: a.length / 4, differing, big, maxD, box: [minX, minY, maxX, maxY], stats: { ...pc.spriteCache.stats, sprites: pc.spriteCache.size }, attempt };
      }
      return null;
    }, which);
    console.log(`\n=== ${label} ===`);
    const diff = await pixelDiff('both');
    console.log('pixel diff (cache off vs on, paused):', JSON.stringify(diff));
    const slug0 = label.replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/-+$/, '');
    {
      const crops: string[] = await page.evaluate(() => (window as any).__crops ?? []);
      const clusters = await page.evaluate(() => (window as any).__clusters ?? []);
      console.log('  largest diff clusters:', JSON.stringify(clusters));
      crops.forEach((c, i) => writeFileSync(`${outDir}/rc-${slug0}-crop${i}.png`, Buffer.from(c.split(',')[1], 'base64')));
    }
    const saveDiff = async (which: string) => {
      const png: string | null = await page.evaluate(() => (window as any).__diffPng ?? null);
      if (png) writeFileSync(`${outDir}/rc-${slug0}-diff-${which}.png`, Buffer.from(png.split(',')[1], 'base64'));
    };
    console.log('  sprites only:', JSON.stringify(await pixelDiff('sprites'))); await saveDiff('sprites');
    console.log('  ground only: ', JSON.stringify(await pixelDiff('ground'))); await saveDiff('ground');
    console.log('  baseline (both off, two frames):', JSON.stringify(await pixelDiff('none'))); await saveDiff('none');

    const slug = label.replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/-+$/, '');
    const diffPng: string | null = await page.evaluate(() => (window as any).__diffPng ?? null);
    if (diffPng) writeFileSync(`${outDir}/rc-${slug}-diff.png`, Buffer.from(diffPng.split(',')[1], 'base64'));

    // Render-only frame time while paused (no solver in the frame)
    const pausedFrames = async (on: boolean) => page.evaluate(async (on: boolean) => {
      const pc = (window as any).__meltdownDebug.plantCanvas;
      pc.renderCache.sprites = on; pc.renderCache.ground = on;
      const frames: number[] = [];
      const prof: Record<string, number[]> = {};
      await new Promise<void>(resolve => {
        const t0 = performance.now();
        const tick = () => {
          frames.push(pc.lastFrameMs);
          for (const k in pc.frameProfile) (prof[k] ??= []).push(pc.frameProfile[k]);
          if (performance.now() - t0 < 2000) requestAnimationFrame(tick); else resolve();
        };
        requestAnimationFrame(tick);
      });
      frames.shift();
      frames.sort((x, y) => x - y);
      const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return +s[Math.floor(s.length / 2)].toFixed(2); };
      const profile: Record<string, number> = {};
      for (const k in prof) profile[k] = med(prof[k]);
      return { n: frames.length, p50: +frames[Math.floor(frames.length / 2)].toFixed(2), p90: +frames[Math.floor(frames.length * 0.9)].toFixed(2), hits: pc.spriteCache.stats.hits, misses: pc.spriteCache.stats.misses, profile };
    }, on);
    for (let round = 0; round < 2; round++) {
      console.log('paused, cache off:', JSON.stringify(await pausedFrames(false)));
      console.log('paused, cache on: ', JSON.stringify(await pausedFrames(true)));
    }
    await page.evaluate(() => { const pc = (window as any).__meltdownDebug.plantCanvas; pc.renderCache.sprites = false; pc.renderCache.ground = false; });
    await new Promise(r => setTimeout(r, 200));
    await page.screenshot({ path: `${outDir}/rc-${slug}-off.png` });
    await page.evaluate(() => { const pc = (window as any).__meltdownDebug.plantCanvas; pc.renderCache.sprites = true; pc.renderCache.ground = true; });
    await new Promise(r => setTimeout(r, 200));
    await page.screenshot({ path: `${outDir}/rc-${slug}-on.png` });

    // --- Frame time and achieved speed, running at the 10x preset ---
    const measure = async (on: boolean, seconds: number) => {
      return page.evaluate(async (on: boolean, seconds: number) => {
        const pc = (window as any).__meltdownDebug.plantCanvas;
        pc.renderCache.sprites = on; pc.renderCache.ground = on;
        const frames: number[] = [];
        let hits = 0, misses = 0, scaled = 0;
        const t0 = performance.now();
        await new Promise<void>(resolve => {
          const tick = () => {
            frames.push(pc.lastFrameMs);
            hits += pc.spriteCache.stats.hits; misses += pc.spriteCache.stats.misses; scaled += pc.spriteCache.stats.scaledHits;
            if (performance.now() - t0 < seconds * 1000) requestAnimationFrame(tick); else resolve();
          };
          requestAnimationFrame(tick);
        });
        frames.sort((a, b) => a - b);
        const mean = frames.reduce((s, x) => s + x, 0) / frames.length;
        const speedText = (document.getElementById('sim-speed') as HTMLElement).textContent;
        return { frames: frames.length, meanMs: +mean.toFixed(2), p50: +frames[Math.floor(frames.length / 2)].toFixed(2), p90: +frames[Math.floor(frames.length * 0.9)].toFixed(2), hits, scaled, misses, speedText };
      }, on, seconds);
    };
    await page.evaluate(() => {
      (Array.from(document.querySelectorAll('.speed-preset')).find(b => b.getAttribute('data-speed') === '10') as HTMLElement).click();
      const b = document.querySelector('#pause-btn') as HTMLElement;
      if (b && b.textContent && b.textContent.includes('Resume')) b.click();
    });
    await new Promise(r => setTimeout(r, 1000));
    for (let round = 0; round < 2; round++) {
      console.log('cache off:', JSON.stringify(await measure(false, 6)));
      console.log('cache on: ', JSON.stringify(await measure(true, 6)));
    }
  }
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
