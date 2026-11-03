#!/usr/bin/env node
/* Pre-downloads the tesseract OCR language model into .tess-cache so the
 * first real run works offline. Called by install.sh; safe to re-run. */
'use strict';
const fs = require('fs');
const path = require('path');
const { createWorker } = require('tesseract.js');

const dir = path.join(__dirname, '..', '.tess-cache');
fs.mkdirSync(dir, { recursive: true });

(async () => {
  const cached = fs.existsSync(path.join(dir, 'eng.traineddata'));
  if (cached) { console.log('OCR model already cached in ' + dir); return; }
  console.log('Downloading OCR language model (~10 MB, one time)…');
  const worker = await createWorker('eng', 1, { cachePath: dir });
  await worker.terminate();
  console.log('OCR model cached in ' + dir);
})().catch((e) => { console.error('OCR model setup failed: ' + e.message); process.exit(1); });
