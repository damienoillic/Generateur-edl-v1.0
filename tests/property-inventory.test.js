import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getPropertyInventoryId, loadPropertyInventory } from '../src/property-inventory.js';

async function createTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'edl-property-inventory-'));
}

test('uses the base inventory until a shared property inventory exists', async () => {
  const directory = await createTempDir();
  const baseData = {
    pieces: { chambre: ['Mur', 'Radiateur'] },
    piece_labels: { chambre: 'Chambre' }
  };
  try {
    const result = await loadPropertyInventory('12 rue Exemple, Paris', '#A1', baseData, directory);

    assert.equal(result.id, getPropertyInventoryId('12 rue Exemple, Paris', 'A1'));
    assert.equal(result.revision, 0);
    assert.deepEqual(result.bienData.pieces.chambre, ['Mur', 'Radiateur']);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('loads shared inventory by normalized address and lot', async () => {
  const directory = await createTempDir();
  const id = getPropertyInventoryId('12 rue Éxemple, Paris', 'A1');
  await fs.writeFile(path.join(directory, 'property-inventory.json'), JSON.stringify({
    schema_version: 1,
    properties: {
      [id]: {
        adresse: '12 rue Éxemple, Paris',
        lot: 'A1',
        revision: 3,
        pieces: {
          chambre: { label: 'Chambre', elements: ['Mur'] }
        }
      }
    }
  }));
  try {
    const result = await loadPropertyInventory(
      '12 rue Exemple, Paris',
      '#A1',
      { pieces: { chambre: ['Mur', 'Radiateur'] } },
      directory
    );

    assert.equal(result.revision, 3);
    assert.deepEqual(result.bienData.pieces.chambre, ['Mur']);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('rejects a malformed shared inventory rather than silently using the old list', async () => {
  const directory = await createTempDir();
  await fs.writeFile(path.join(directory, 'property-inventory.json'), '{invalid');
  try {
    await assert.rejects(
      loadPropertyInventory('12 rue Exemple, Paris', 'A1', { pieces: {} }, directory),
      /JSON invalide/
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
