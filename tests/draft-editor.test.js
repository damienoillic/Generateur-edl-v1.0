import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  confirmDraftChanges,
  proposeDraftChanges,
  readDraftForTenant
} from '../src/draft-editor.js';

async function createProject() {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'edl-draft-editor-'));
  const edlDirectory = path.join(projectRoot, 'data', 'edl');
  await fs.mkdir(edlDirectory, { recursive: true });
  const draftFile = 'draft-entree-test.json';
  const draftPath = path.join(edlDirectory, draftFile);
  const draft = {
    id: 'entree-test',
    bien: 'massy',
    adresse_bien: '1 rue Exemple, Massy',
    type: 'entree',
    locataire: {
      nom: 'Mme Exemple',
      email: 'tenant@example.org',
      telephone: '0600000000',
      chambre: 'Chambre 1',
      lot: 'A1'
    },
    adresse_bien: '12 rue Exemple, 75000 Paris',
    bien_data: {
      adresse: '12 rue Exemple, 75000 Paris',
      pieces: { chambre: ['Fenêtre', 'Radiateur'] },
      piece_labels: { chambre: 'Chambre' }
    },
    bailleur: {},
    date: '2026-11-01',
    etat_usure: {
      chambre: {
        Fenêtre: ['Bon état', 'Fenêtre brisée (photo annexe P01)'],
        Radiateur: ['Bon état', ''],
        Porte: ['Bon état', 'Fissure (photo annexe P02)']
      }
    },
    photos: [
      { fichier: 'photo-1.jpg', piece: 'chambre', legende: 'Fenêtre brisée', defauts: ['Fenêtre brisée'] },
      { fichier: 'photo-2.jpg', piece: 'chambre', legende: 'Fissure porte', defauts: ['Fissure porte'] }
    ],
    cles: [{ type: 'Clé de chambre', nombre: 1, date: '2026-11-01', observations: '' }],
    proprete: 'Bon état',
    securite: { detecteur_fumee: 'présent' },
    reserves_bailleur: 'Aucune observation ni réserve.',
    reserves_locataire: 'Aucune observation ni réserve.',
    edl_reference: {
      type: 'EDL d’entrée',
      pieces: [{ piece: 'Chambre', elements: [{ element: 'Radiateur', etat: 'Bon état' }] }]
    }
  };
  await fs.writeFile(draftPath, JSON.stringify(draft, null, 2), 'utf8');
  return { projectRoot, draftFile, draftPath, draft };
}

test('reads only a draft matching the requested tenant and rejects paths', async () => {
  const project = await createProject();
  try {
    const summary = await readDraftForTenant(project.projectRoot, project.draftFile, { nom: 'Mme Exemple' });
    assert.equal(summary.photos[0].photo_number, 'P01');
    assert.equal(summary.photos[0].defauts[0], 'Fenêtre brisée');
    assert.equal('email' in summary, false);
    await assert.rejects(
      readDraftForTenant(project.projectRoot, project.draftFile, { nom: 'M. Autre' }),
      /ne correspond pas au locataire/
    );
    await assert.rejects(
      readDraftForTenant(project.projectRoot, '..\\outside.json', { nom: 'Mme Exemple' }),
      /nom de fichier/
    );
  } finally {
    await fs.rm(project.projectRoot, { recursive: true, force: true });
  }
});

test('proposes typed changes without writing and applies them after confirmation', async () => {
  const project = await createProject();
  try {
    const proposal = await proposeDraftChanges(
      project.projectRoot,
      project.draftFile,
      { nom: 'Mme Exemple' },
      [
        {
          action: 'update_photo_defect',
          photo_number: 'P01',
          current_description: 'Fenêtre brisée',
          new_description: 'Fenêtre légèrement sale'
        },
        {
          action: 'set_room_condition',
          piece: 'chambre',
          element: 'Fenêtre',
          etat: 'Bon état',
          observation: 'Fenêtre légèrement sale.'
        },
        {
          action: 'set_keys',
          cles: [{ type: 'Clé de chambre', nombre: 2 }]
        },
        {
          action: 'set_reserve',
          partie: 'locataire',
          texte: 'Aucune observation ni réserve.'
        }
      ]
    );
    assert.ok(proposal.confirmation_token);
    assert.equal(proposal.modifications.length, 4);
    assert.equal(
      JSON.parse(await fs.readFile(project.draftPath, 'utf8')).photos[0].defauts[0],
      'Fenêtre brisée'
    );

    const result = await confirmDraftChanges(
      project.projectRoot,
      project.draftFile,
      { nom: 'Mme Exemple' },
      proposal.confirmation_token
    );
    const savedDraft = JSON.parse(await fs.readFile(project.draftPath, 'utf8'));
    const preview = await fs.readFile(result.apercu_mis_a_jour, 'utf8');
    assert.equal(savedDraft.photos[0].defauts[0], 'Fenêtre légèrement sale');
    assert.equal(savedDraft.photos[0].legende, 'Fenêtre légèrement sale');
    assert.deepEqual(savedDraft.etat_usure.chambre.Fenêtre, ['Bon état', 'Fenêtre légèrement sale.']);
    assert.equal(savedDraft.cles[0].nombre, 2);
    assert.match(preview, /Fenêtre légèrement sale/);
    assert.doesNotMatch(preview, /Fenêtre brisée/);
  } finally {
    await fs.rm(project.projectRoot, { recursive: true, force: true });
  }
});

test('removing a photo removes its observation and renumbers following references', async () => {
  const project = await createProject();
  try {
    const proposal = await proposeDraftChanges(
      project.projectRoot,
      project.draftFile,
      { nom: 'Mme Exemple' },
      [{ action: 'remove_photo', photo_number: 'P01' }]
    );
    await confirmDraftChanges(
      project.projectRoot,
      project.draftFile,
      { nom: 'Mme Exemple' },
      proposal.confirmation_token
    );

    const savedDraft = JSON.parse(await fs.readFile(project.draftPath, 'utf8'));
    assert.deepEqual(savedDraft.photos.map(photo => photo.fichier), ['photo-2.jpg']);
    assert.equal(savedDraft.etat_usure.chambre.Fenêtre[1], '');
    assert.equal(savedDraft.etat_usure.chambre.Porte[1], 'Fissure (photo annexe P01)');
  } finally {
    await fs.rm(project.projectRoot, { recursive: true, force: true });
  }
});

test('removes only the selected defect while retaining the annex photo', async () => {
  const project = await createProject();
  try {
    const proposal = await proposeDraftChanges(
      project.projectRoot,
      project.draftFile,
      { nom: 'Mme Exemple' },
      [{
        action: 'remove_photo_defect',
        photo_number: 'P01',
        current_description: 'Fenêtre brisée'
      }]
    );
    await confirmDraftChanges(
      project.projectRoot,
      project.draftFile,
      { nom: 'Mme Exemple' },
      proposal.confirmation_token
    );

    const savedDraft = JSON.parse(await fs.readFile(project.draftPath, 'utf8'));
    assert.equal(savedDraft.photos.length, 2);
    assert.deepEqual(savedDraft.photos[0].defauts, []);
    assert.equal(savedDraft.etat_usure.chambre.Fenêtre[1], '');
  } finally {
    await fs.rm(project.projectRoot, { recursive: true, force: true });
  }
});

test('removes an equipment from the shared property inventory after explicit confirmation', async () => {
  const project = await createProject();
  const inventoryDirectory = path.join(project.projectRoot, 'shared');
  await fs.mkdir(inventoryDirectory);
  try {
    const proposal = await proposeDraftChanges(
      project.projectRoot,
      project.draftFile,
      { nom: 'Mme Exemple' },
      [{
        action: 'remove_property_element',
        piece: 'chambre',
        element: 'Radiateur'
      }],
      { inventoryDirectory }
    );

    assert.match(proposal.modifications[0], /futurs EDL de ce lot/);
    assert.equal(JSON.parse(await fs.readFile(project.draftPath, 'utf8')).bien_data.pieces.chambre.includes('Radiateur'), true);
    await assert.rejects(fs.access(path.join(inventoryDirectory, 'property-inventory.json')));

    await confirmDraftChanges(
      project.projectRoot,
      project.draftFile,
      { nom: 'Mme Exemple' },
      proposal.confirmation_token
    );

    const savedDraft = JSON.parse(await fs.readFile(project.draftPath, 'utf8'));
    const inventory = JSON.parse(await fs.readFile(path.join(inventoryDirectory, 'property-inventory.json'), 'utf8'));
    const { getPropertyInventoryId, loadPropertyInventory } = await import('../src/property-inventory.js');
    const id = getPropertyInventoryId('12 rue Exemple, 75000 Paris', 'A1');
    assert.deepEqual(savedDraft.bien_data.pieces.chambre, ['Fenêtre']);
    assert.equal(savedDraft.etat_usure.chambre.Radiateur, undefined);
    assert.equal(savedDraft.edl_reference.pieces[0].elements[0].element, 'Radiateur');
    assert.deepEqual(inventory.properties[id].pieces.chambre.elements, ['Fenêtre']);
    assert.equal(inventory.properties[id].revision, savedDraft.property_inventory_revision);

    const futureInventory = await loadPropertyInventory(
      '12 rue Exemple, 75000 Paris',
      'A1',
      project.draft.bien_data,
      inventoryDirectory
    );
    assert.deepEqual(futureInventory.bienData.pieces.chambre, ['Fenêtre']);
  } finally {
    await fs.rm(project.projectRoot, { recursive: true, force: true });
  }
});

test('adds a confirmed new equipment to the shared inventory with an unknown condition', async () => {
  const project = await createProject();
  const inventoryDirectory = path.join(project.projectRoot, 'shared');
  await fs.mkdir(inventoryDirectory);
  try {
    const proposal = await proposeDraftChanges(
      project.projectRoot,
      project.draftFile,
      { nom: 'Mme Exemple' },
      [{
        action: 'add_property_element',
        piece: 'chambre',
        element: 'Climatiseur'
      }],
      { inventoryDirectory }
    );
    await confirmDraftChanges(
      project.projectRoot,
      project.draftFile,
      { nom: 'Mme Exemple' },
      proposal.confirmation_token
    );

    const savedDraft = JSON.parse(await fs.readFile(project.draftPath, 'utf8'));
    const inventory = JSON.parse(await fs.readFile(path.join(inventoryDirectory, 'property-inventory.json'), 'utf8'));
    const { getPropertyInventoryId } = await import('../src/property-inventory.js');
    const id = getPropertyInventoryId('12 rue Exemple, 75000 Paris', 'A1');
    assert.ok(savedDraft.bien_data.pieces.chambre.includes('Climatiseur'));
    assert.deepEqual(savedDraft.etat_usure.chambre.Climatiseur, ['', '']);
    assert.ok(inventory.properties[id].pieces.chambre.elements.includes('Climatiseur'));
  } finally {
    await fs.rm(project.projectRoot, { recursive: true, force: true });
  }
});

test('rejects stale proposals and invalid target elements', async () => {
  const project = await createProject();
  try {
    await assert.rejects(
      proposeDraftChanges(project.projectRoot, project.draftFile, { nom: 'Mme Exemple' }, [{
        action: 'set_room_condition',
        piece: 'chambre',
        element: 'Objet inconnu',
        etat: 'Bon état'
      }]),
      /Élément introuvable/
    );

    const proposal = await proposeDraftChanges(
      project.projectRoot,
      project.draftFile,
      { nom: 'Mme Exemple' },
      [{
        action: 'append_observation',
        piece: 'chambre',
        element: 'Porte',
        observation: 'Poignée à vérifier.'
      }]
    );
    await fs.writeFile(project.draftPath, JSON.stringify(project.draft), 'utf8');
    await assert.rejects(
      confirmDraftChanges(
        project.projectRoot,
        project.draftFile,
        { nom: 'Mme Exemple' },
        proposal.confirmation_token
      ),
      /brouillon a changé/
    );
  } finally {
    await fs.rm(project.projectRoot, { recursive: true, force: true });
  }
});

test('rejects invalid reserve parties, key quantities, and room observations', async () => {
  const project = await createProject();
  try {
    for (const change of [
      { action: 'set_reserve', partie: 'autre', texte: 'Réserve.' },
      { action: 'set_keys', cles: [{ type: 'Clé', nombre: -1 }] },
      {
        action: 'set_room_condition',
        piece: 'chambre',
        element: 'Fenêtre',
        etat: 'Bon état',
        observation: { texte: 'invalide' }
      }
    ]) {
      await assert.rejects(
        proposeDraftChanges(project.projectRoot, project.draftFile, { nom: 'Mme Exemple' }, [change]),
        /partie concernée|quantité entière|observation doit être un texte/
      );
    }
    assert.deepEqual(JSON.parse(await fs.readFile(project.draftPath, 'utf8')), project.draft);
  } finally {
    await fs.rm(project.projectRoot, { recursive: true, force: true });
  }
});
