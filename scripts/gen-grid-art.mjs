#!/usr/bin/env node
/**
 * Generate seamless ground textures for the grid view with Google's image
 * models, writing PNGs the app picks up automatically from public/art/.
 *
 *   GEMINI_API_KEY=... node scripts/gen-grid-art.mjs            # all surfaces
 *   GEMINI_API_KEY=... node scripts/gen-grid-art.mjs ground     # one surface
 *   node scripts/gen-grid-art.mjs --model gemini-2.5-flash-image ground
 *
 * Each file covers ART_TILE_SPAN (8) x 8 tiles, i.e. 8 m x 8 m of ground
 * seen straight down, and must tile seamlessly. The app tiles it at every
 * zoom, so 1024 px is plenty. Without an API key this prints the prompts so
 * they can be pasted into any image tool by hand; a hand-made file only
 * needs adding to public/art/manifest.json to be picked up.
 *
 * Endpoints (Gemini API, key in the x-goog-api-key header):
 *  - Imagen:  POST /v1beta/models/{model}:predict   {instances:[{prompt}], parameters:{sampleCount, aspectRatio}}
 *             -> predictions[0].bytesBase64Encoded
 *  - Gemini image models: POST /v1beta/models/{model}:generateContent
 *             {contents:[{parts:[{text}]}], generationConfig:{responseModalities:['IMAGE']}}
 *             -> candidates[0].content.parts[].inlineData.data
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', 'public', 'art');

const SURFACES = {
  ground: {
    file: 'ground.png',
    prompt:
      'Seamless tileable texture, viewed straight down from above, of the open ground of an ' +
      'industrial site: packed dry gravel and sandy soil with sparse patches of short dry grass ' +
      'and small stones. Even, soft daylight with no shadows, no objects, no text, no borders. ' +
      'Muted warm earth tones (khaki, olive, tan). Photorealistic, fine detail, the edges must ' +
      'wrap seamlessly so the image can be tiled in every direction. The image covers an 8 m x 8 m area.',
  },
  concrete: {
    file: 'concrete.png',
    prompt:
      'Seamless tileable texture, viewed straight down from above, of a poured concrete floor ' +
      'slab divided by straight expansion joints into a 4 x 4 grid of equal square panels, ' +
      'each panel 2 m across. Light grey concrete with subtle grain and faint stains, even soft ' +
      'daylight with no shadows, no objects, no text, no borders. Photorealistic. The joints ' +
      'run exactly along the image edges so it tiles seamlessly in every direction.',
  },
  pad: {
    file: 'pad.png',
    prompt:
      'Seamless tileable texture, viewed straight down from above, of a dark grey concrete ' +
      'equipment foundation pad divided by straight joints into an 8 x 8 grid of equal 1 m ' +
      'squares. Slightly rough, slightly oil-stained industrial concrete, even soft daylight ' +
      'with no shadows, no objects, no text, no borders. Photorealistic. The joints run exactly ' +
      'along the image edges so it tiles seamlessly in every direction.',
  },
};

const args = process.argv.slice(2);
let model = 'imagen-4.0-generate-001';
const wanted = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--model') model = args[++i];
  else wanted.push(args[i]);
}
const names = wanted.length > 0 ? wanted : Object.keys(SURFACES);
for (const n of names) {
  if (!SURFACES[n]) {
    console.error(`Unknown surface '${n}'. Known: ${Object.keys(SURFACES).join(', ')}`);
    process.exit(1);
  }
}

const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
if (!apiKey) {
  console.log('No GEMINI_API_KEY / GOOGLE_API_KEY in the environment. Prompts to use by hand:\n');
  for (const n of names) console.log(`--- ${SURFACES[n].file} ---\n${SURFACES[n].prompt}\n`);
  console.log(`Save each as public/art/<name>.png (square, seamless, covers 8 x 8 tiles).`);
  process.exit(0);
}

async function generate(prompt) {
  const base = `https://generativelanguage.googleapis.com/v1beta/models/${model}`;
  const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey };
  if (model.startsWith('imagen')) {
    const res = await fetch(`${base}:predict`, {
      method: 'POST', headers,
      body: JSON.stringify({ instances: [{ prompt }], parameters: { sampleCount: 1, aspectRatio: '1:1' } }),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
    const json = await res.json();
    const b64 = json.predictions?.[0]?.bytesBase64Encoded;
    if (!b64) throw new Error(`No image in response: ${JSON.stringify(json).slice(0, 400)}`);
    return Buffer.from(b64, 'base64');
  }
  const res = await fetch(`${base}:generateContent`, {
    method: 'POST', headers,
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['IMAGE'] },
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  const json = await res.json();
  const part = json.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
  if (!part) throw new Error(`No image in response: ${JSON.stringify(json).slice(0, 400)}`);
  return Buffer.from(part.inlineData.data, 'base64');
}

fs.mkdirSync(outDir, { recursive: true });
const manifestPath = path.join(outDir, 'manifest.json');
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { files: [] };
manifest.files = Array.isArray(manifest.files) ? manifest.files : [];
for (const n of names) {
  const { file, prompt } = SURFACES[n];
  process.stdout.write(`${file} (${model}) ... `);
  try {
    const png = await generate(prompt);
    fs.writeFileSync(path.join(outDir, file), png);
    if (!manifest.files.includes(file)) manifest.files.push(file);
    console.log(`${(png.length / 1024).toFixed(0)} kB`);
  } catch (err) {
    console.log('FAILED');
    console.error(`  ${err.message}`);
    process.exitCode = 1;
  }
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`\nDone. ${manifestPath} lists ${manifest.files.length} file(s); reload the app and the grid view uses them (see src/render/grid-art.ts).`);
