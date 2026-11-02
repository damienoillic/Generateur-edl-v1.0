import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyzeAllPhotos, analyzePhotoBatch, isAnalysisCurrent } from '../src/analyze.js';

async function createTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'edl-analysis-test-'));
}

function createClient(onRequest) {
  return {
    chat: {
      complete: onRequest
    }
  };
}

function responseFor(request) {
  const content = request.messages[0].content;
  const filenames = content
    .filter(item => item.type === 'text' && item.text.startsWith('Nom exact du fichier : '))
    .map(item => item.text.replace('Nom exact du fichier : ', ''));

  return {
    choices: [{
      message: {
        content: JSON.stringify({
          analyses: filenames.map(fichier => ({
            fichier,
            piece: 'chambre',
            defauts: [],
            legende_suggeree: 'Vue de la chambre'
          }))
        })
      }
    }]
  };
}

test('réutilise le cache par contenu et déduplique les photos identiques', async () => {
  const root = await createTempDir();
  const photosDir = path.join(root, 'photos');
  const outputPath = path.join(root, 'analysis.json');
  const cachePath = path.join(root, 'analysis-cache.json');
  await fs.mkdir(photosDir);
  await fs.writeFile(path.join(photosDir, 'photo-a.jpg'), 'identical image');
  await fs.writeFile(path.join(photosDir, 'photo-b.jpg'), 'identical image');

  let calls = 0;
  const client = createClient(async request => {
    calls += 1;
    return responseFor(request);
  });

  const first = await analyzeAllPhotos(photosDir, outputPath, 'entree', { client, cachePath });
  assert.equal(calls, 1);
  assert.deepEqual(first.map(item => item.fichier), ['photo-a.jpg', 'photo-b.jpg']);
  assert.equal(await isAnalysisCurrent(photosDir, outputPath, 'entree'), true);

  await analyzeAllPhotos(photosDir, outputPath, 'entree', { client, cachePath });
  assert.equal(calls, 1);

  await fs.writeFile(path.join(photosDir, 'photo-b.jpg'), 'changed image');
  assert.equal(await isAnalysisCurrent(photosDir, outputPath, 'entree'), false);
  await analyzeAllPhotos(photosDir, outputPath, 'entree', { client, cachePath });
  assert.equal(calls, 2);

  await fs.rm(root, { recursive: true, force: true });
});

test('ne relance pas les erreurs permanentes et retente une erreur temporaire une fois', async () => {
  const root = await createTempDir();
  const photoPath = path.join(root, 'photo.jpg');
  await fs.writeFile(photoPath, 'image');
  const photos = [{ filename: 'photo.jpg', path: photoPath }];

  let permanentCalls = 0;
  await assert.rejects(
    analyzePhotoBatch(photos, createClient(async () => {
      permanentCalls += 1;
      throw Object.assign(new Error('budget exhausted'), { statusCode: 402 });
    }), 'entree', 1, 0),
    /budget exhausted/
  );
  assert.equal(permanentCalls, 1);

  let temporaryCalls = 0;
  const result = await analyzePhotoBatch(photos, createClient(async request => {
    temporaryCalls += 1;
    if (temporaryCalls === 1) {
      throw Object.assign(new Error('temporary outage'), { statusCode: 503 });
    }
    return responseFor(request);
  }), 'entree', 1, 0);

  assert.equal(temporaryCalls, 2);
  assert.equal(result[0].piece, 'chambre');
  await fs.rm(root, { recursive: true, force: true });
});

test('applique un niveau de détail différent selon le type d’EDL', async () => {
  const root = await createTempDir();
  const photoPath = path.join(root, 'photo.jpg');
  await fs.writeFile(photoPath, 'image');
  const photos = [{ filename: 'photo.jpg', path: photoPath }];
  const prompts = [];
  const client = createClient(async request => {
    prompts.push(request.messages[0].content[0].text);
    return responseFor(request);
  });

  await analyzePhotoBatch(photos, client, 'entree');
  await analyzePhotoBatch(photos, client, 'sortie');

  assert.match(prompts[0], /uniquement les problèmes majeurs/i);
  assert.match(prompts[0], /gravité "forte"/i);
  assert.match(prompts[1], /tous les défauts et dommages visibles/i);
  assert.match(prompts[1], /dégradations mineures/i);
  await fs.rm(root, { recursive: true, force: true });
});
