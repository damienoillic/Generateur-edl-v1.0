import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { selectRelevantPhotos } from '../src/photo-selection.js';

test('deduplicates photos, covers rooms, favors overview and defect details, and caps at 30', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'edl-photo-selection-'));

  try {
    const rooms = ['chambre', 'salon', 'cuisine', 'toilettes', 'couloirs'];
    const photos = [];
    const analyses = [];

    for (let index = 0; index < 60; index += 1) {
      const filename = `photo-${index}.jpg`;
      const filePath = path.join(root, filename);
      await fs.writeFile(filePath, `image-content-${index}`);
      photos.push({ filename, path: filePath });
      const roomIndex = Math.floor(index / 12);
      const positionInRoom = index % 12;
      analyses.push({
        fichier: filename,
        piece: rooms[roomIndex],
        type_vue: positionInRoom === 0
          ? 'vue_ensemble'
          : positionInRoom === 1
            ? 'detail_defaut'
            : 'autre',
        pertinence: positionInRoom === 0 || positionInRoom === 1 ? 90 : 20,
        score_qualite: 80,
        defauts: positionInRoom === 1
          ? [{ description: 'Rayure visible', gravite: 'forte' }]
          : []
      });
    }

    const duplicatePath = path.join(root, 'duplicate.jpg');
    await fs.copyFile(photos[0].path, duplicatePath);
    photos.push({ filename: 'duplicate.jpg', path: duplicatePath });
    analyses.push({
      fichier: 'duplicate.jpg',
      piece: 'chambre',
      type_vue: 'vue_ensemble',
      pertinence: 100,
      score_qualite: 100,
      defauts: []
    });

    const result = await selectRelevantPhotos(photos, analyses, 'sortie');
    const selectedNames = new Set(result.photos.map(photo => photo.filename));

    assert.equal(result.photos.length, 30);
    assert.equal(result.duplicateCount, 1);
    assert.equal(result.omittedCount, 30);
    assert.equal(selectedNames.has('duplicate.jpg'), false);

    for (const room of rooms) {
      const selectedAnalyses = analyses.filter(analysis =>
        selectedNames.has(analysis.fichier) && analysis.piece === room
      );
      assert.ok(selectedAnalyses.some(analysis => analysis.type_vue === 'vue_ensemble'), `${room} has an overview`);
      assert.ok(selectedAnalyses.some(analysis => analysis.type_vue === 'detail_defaut'), `${room} has a defect detail`);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
