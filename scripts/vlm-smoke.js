#!/usr/bin/env node
/* Verifies the local llama.cpp + Gemma 4 E2B describer end-to-end:
 * renders a synthetic slide, asks Gemma for 1–4 words, prints the result. */
'use strict';

const sharp = require('sharp');
const { Vlm } = require('../lib/vlm');

(async () => {
  const svg = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">
      <rect width="1280" height="720" fill="#1a2340"/>
      <text x="640" y="340" font-size="72" fill="#ffffff" text-anchor="middle"
            font-family="Helvetica, Arial, DejaVu Sans, sans-serif" font-weight="bold">Q3 Revenue Growth</text>
      <text x="640" y="430" font-size="40" fill="#a9b4c4" text-anchor="middle"
            font-family="Helvetica, Arial, DejaVu Sans, sans-serif">up 24% year over year</text>
    </svg>`);
  const jpeg = await sharp(svg).jpeg({ quality: 85 }).toBuffer();

  const vlm = new Vlm({ log: (m) => console.log('   ', m) });
  await vlm.start();
  const t0 = Date.now();
  const desc = await vlm.describe(jpeg, { timeoutMs: 600000 }); // CPU-only hosts are slow; GPUs finish in seconds
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Gemma described the test slide as: "${desc}"  (${secs}s)`);
  const words = desc.trim().split(/\s+/);
  if (words.length < 1 || words.length > 5) throw new Error(`expected 1-5 words, got: ${desc}`);
  console.log('VLM SMOKE OK');
  vlm.stop();
  process.exit(0);
})().catch((e) => { console.error('VLM SMOKE FAILED:', e.message); process.exit(1); });
