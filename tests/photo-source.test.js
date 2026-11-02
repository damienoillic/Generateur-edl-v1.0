import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveTenantPhotosDirectory } from '../src/photo-source.js';

test('finds the tenant and EDL folders without regard to case or accents', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'edl-photo-source-'));
  try {
    const photos = path.join(root, 'Baniza', 'Entrée');
    await fs.mkdir(photos, { recursive: true });
    await fs.writeFile(path.join(photos, 'IMG_6809.JPG'), '');
    await fs.writeFile(path.join(photos, 'notes.txt'), '');

    const result = await resolveTenantPhotosDirectory('BANIZA', 'entree', { root });
    assert.equal(result.photosDirectory, photos);
    assert.equal(result.imageCount, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('selects photos from the requested EDL type only', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'edl-photo-source-'));
  try {
    const entree = path.join(root, 'Baniza', 'Entrée');
    const sortie = path.join(root, 'Baniza', 'Sortie');
    await fs.mkdir(entree, { recursive: true });
    await fs.mkdir(sortie);
    await fs.writeFile(path.join(entree, 'entree.jpg'), '');
    await fs.writeFile(path.join(sortie, 'sortie.jpg'), '');

    const result = await resolveTenantPhotosDirectory('Baniza', 'sortie', { root });
    assert.equal(result.photosDirectory, sortie);
    assert.equal(result.imageCount, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rejects missing tenant or EDL folders and ambiguous tenant folders', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'edl-photo-source-'));
  try {
    await fs.mkdir(path.join(root, 'Other'));
    await assert.rejects(resolveTenantPhotosDirectory('Baniza', 'entree', { root }), /Aucun dossier photo nommé/);

    await fs.mkdir(path.join(root, 'Bániza'));
    await fs.mkdir(path.join(root, 'BANIZA'));
    await assert.rejects(resolveTenantPhotosDirectory('Baniza', 'entree', { root }), /Plusieurs dossiers correspondent/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rejects a tenant without a folder for the requested EDL type', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'edl-photo-source-'));
  try {
    await fs.mkdir(path.join(root, 'Baniza', 'Entrée'), { recursive: true });
    await assert.rejects(
      resolveTenantPhotosDirectory('Baniza', 'sortie', { root }),
      /Aucun dossier photo sortie trouvé/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
