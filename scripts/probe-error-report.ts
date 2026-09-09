/**
 * Headless check of the simulation error dialog's "File bug report" button.
 *
 * Loads a preset, runs it, wrecks a flow node so the solver throws for real,
 * then walks the dialog: report -> note -> consent -> send. The fileCar
 * endpoint is stubbed in the page, so nothing reaches the real site office.
 *
 *   npx vite --port 3021 --strictPort      (in another shell)
 *   npx tsx scripts/probe-error-report.ts [port]
 *
 * Needs puppeteer-core (npm install puppeteer-core --no-save); Chrome is the
 * installed one.
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const port = process.argv[2] || '3021';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: ['--window-size=1400,900'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.evaluateOnNewDocument('window.__name = (f) => f;');
  // Intercept the CAR post: record what would have been sent, answer as the
  // cloud function does. Nothing leaves the machine.
  await page.evaluateOnNewDocument(`
    window.__carPosts = [];
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url && url.includes('fileCar')) {
        const body = JSON.parse(init.body);
        window.__carPosts.push({
          title: body.title, description: body.description, severity: body.severity,
          context: body.context ?? null,
          bundleChars: body.bundle ? body.bundle.data.length : 0,
          bundleSummary: body.bundle ? body.bundle.summary : null,
        });
        return Promise.resolve(new Response(
          JSON.stringify({ ok: true, carId: 'STUBBED', bundleChunks: 1 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return realFetch(input, init);
    };
  `);
  page.on('pageerror', (e: Error) => console.log('PAGE ERROR', e.message));

  await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.gm-title-sandbox');
  await page.evaluate(() => (document.querySelector('.gm-title-sandbox') as HTMLElement).click());
  await page.waitForSelector('#open-save-load-btn');
  await page.evaluate(() => (document.querySelector('#open-save-load-btn') as HTMLElement).click());
  await page.waitForSelector('#dialog-preset-grid');
  const found = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('#dialog-preset-grid button'))
      .find((b) => b.textContent === 'PWR') as HTMLElement | undefined;
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!found) throw new Error('PWR preset not found');
  await page.waitForSelector('#mode-simulation');
  await page.evaluate(() => (document.querySelector('#mode-simulation') as HTMLElement).click());
  await wait(2500);

  // Throw from inside the frame the loop runs, which is the same place a
  // water-properties failure lands: GameLoop's catch -> 'simulation-error'
  // event -> the dialog. The message carries '<' on purpose - the dialog
  // renders it as HTML, so an unescaped one would eat the rest of the text.
  const wrecked = await page.evaluate(() => {
    const loop = (window as any).__meltdownDebug.gameLoop;
    const orig = loop.onStateUpdate;
    loop.onStateUpdate = (...args: unknown[]) => {
      loop.onStateUpdate = orig;  // one throw is enough
      orig?.(...args);
      throw new Error('Probe: forced failure, u < u_sat(v) at node hx-1-shell');
    };
    loop.resume();
    return { paused: loop.isPaused };
  });
  console.log(`armed ${JSON.stringify(wrecked)}, waiting for the error dialog...`);

  await page.waitForSelector('#error-dialog-report', { timeout: 20000 });
  const shown = await page.evaluate(() => {
    const d = document.getElementById('error-dialog')!;
    return { visible: d.style.display, text: (d.textContent ?? '').slice(0, 260) };
  });
  console.log('DIALOG:', JSON.stringify(shown, null, 2));

  await page.evaluate(() => (document.getElementById('error-dialog-report') as HTMLElement).click());
  await page.waitForSelector('#error-dialog-note');
  await page.type('#error-dialog-note', 'Ran the PWR preset at 1x and it blew up on its own.');
  await page.evaluate(() => (document.getElementById('error-dialog-send') as HTMLElement).click());

  // The consent dialog is the gate; find it and press Send report.
  await page.waitForSelector('#jack-car-consent', { timeout: 30000 });
  const consent = await page.evaluate(() => {
    const p = document.getElementById('jack-car-consent')!;
    return (p.textContent ?? '').replace(/\s+/g, ' ').slice(0, 900);
  });
  console.log('\nCONSENT PANEL:\n' + consent);

  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('#jack-car-consent button'))
      .find((b) => b.textContent === 'Send report') as HTMLElement;
    btn.click();
  });
  await wait(4000);

  const posts = await page.evaluate(() => (window as any).__carPosts);
  console.log('\nWHAT WOULD HAVE BEEN SENT:\n' + JSON.stringify(posts, null, 2).slice(0, 3000));

  const after = await page.evaluate(() => ({
    dialog: (document.getElementById('error-dialog') as HTMLElement)?.style.display,
    notifications: Array.from(document.querySelectorAll('.sim-notification')).map((n) => n.textContent),
  }));
  console.log('\nAFTER:', JSON.stringify(after, null, 2));

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
