import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import test from 'node:test';
import { compressImage } from '../src/images.js';

test('returns the actual dimensions of a compressed portrait image', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'edl-image-dimensions-'));
  const inputPath = path.join(root, 'portrait.png');
  const outputPath = path.join(root, 'portrait.jpg');

  try {
    await sharp({
      create: {
        width: 600,
        height: 900,
        channels: 3,
        background: '#ffffff'
      }
    }).png().toFile(inputPath);

    const result = await compressImage(inputPath, outputPath);
    assert.equal(result.width, 600);
    assert.equal(result.height, 900);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
