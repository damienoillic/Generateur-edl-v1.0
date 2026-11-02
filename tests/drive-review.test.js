import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyDriveReview,
  createDriveReviewPrompt,
  findLatestProposalFile,
  publishReviewDraft
} from '../src/drive-review.js';

async function createProject() {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'edl-drive-review-'));
  const reviewDirectory = path.join(projectRoot, 'drive', 'edl-review');
  const edlDirectory = path.join(projectRoot, 'data', 'edl');
  await fs.mkdir(edlDirectory, { recursive: true });

  const draftFile = 'draft-entree-test.json';
  const draftPath = path.join(edlDirectory, draftFile);
  const draft = {
    id: 'entree-test',
    type: 'entree',
    date: '2026-11-01',
    locataire: {
      nom: 'Mme Exemple',
      email: 'tenant-secret@example.org',
      telephone: '0600000000',
      chambre: 'Chambre 1',
      lot: 'A1'
    },
    etat_usure: {
      chambre: {
        Fenêtre: ['Bon état', 'Fenêtre brisée (photo annexe P01)']
      }
    },
    photos: [{
      fichier: 'C:\\private\\photo-1.jpg',
      piece: 'chambre',
      legende: 'Fenêtre brisée',
      defauts: ['Fenêtre brisée']
    }],
    cles: [{ type: 'Clé de chambre', nombre: 1, date: '2026-11-01', observations: '' }],
    proprete: 'Bon état',
    securite: { detecteur_fumee: 'présent' },
    reserves_bailleur: 'Aucune observation ni réserve.',
    reserves_locataire: 'Aucune observation ni réserve.'
  };
  await fs.writeFile(draftPath, JSON.stringify(draft, null, 2), 'utf8');
  return { projectRoot, reviewDirectory, draftFile, draftPath, draft };
}

test('publishes contacts and review details without copying photo files', async () => {
  const project = await createProject();
  try {
    const published = await publishReviewDraft(project.draftPath, {
      reviewDirectory: project.reviewDirectory
    });
    const snapshot = await fs.readFile(published.reviewPath, 'utf8');
    const proposal = JSON.parse(await fs.readFile(published.proposalPath, 'utf8'));
    const instructions = await fs.readFile(path.join(published.reviewDirectory, 'instructions.txt'), 'utf8');

    assert.match(snapshot, /Fenêtre brisée/);
    assert.match(snapshot, /tenant-secret@example\.org/);
    assert.match(snapshot, /0600000000/);
    assert.doesNotMatch(snapshot, /photo-1\.jpg|private/);
    assert.deepEqual(proposal, {
      schema_version: 1,
      draft_file: project.draftFile,
      locataire: 'Mme Exemple',
      changes: []
    });
    assert.match(instructions, /update_photo_defect/);
    assert.match(instructions, /set_room_condition/);
    assert.match(instructions, /coordonnées du locataire sont incluses/);
  } finally {
    await fs.rm(project.projectRoot, { recursive: true, force: true });
  }
});

test('creates a Vibe Work prompt containing the exact draft name and review folder', () => {
  const prompt = createDriveReviewPrompt(
    'draft-entree-BANIZA-2026-11-01.json',
    'G:\\Mon Drive\\EDL tool\\edl-review\\draft-entree-BANIZA-2026-11-01'
  );
  assert.match(prompt, /Nom exact du brouillon local : draft-entree-BANIZA-2026-11-01\.json/);
  assert.ok(prompt.includes(String.raw`G:\Mon Drive\EDL tool\edl-review`));
  assert.match(prompt, /écris uniquement la proposition structurée dans un fichier nommé changes\.json/);
  assert.match(prompt, /changes \(1\)\.json/);
  assert.match(prompt, /fichier changes\*\.json le plus récemment modifié/);
  assert.match(prompt, /remove_property_element/);
  assert.match(prompt, /add_property_element/);
});

test('selects the most recently modified Drive duplicate proposal', async () => {
  const project = await createProject();
  try {
    const packageDirectory = path.join(project.reviewDirectory, 'proposal-selection');
    await fs.mkdir(packageDirectory, { recursive: true });
    const oldPath = path.join(packageDirectory, 'changes.json');
    const newPath = path.join(packageDirectory, 'changes (1).json');
    await fs.writeFile(oldPath, '{}', 'utf8');
    await fs.writeFile(newPath, '{}', 'utf8');
    const older = new Date('2026-11-01T10:00:00Z');
    const newer = new Date('2026-11-01T11:00:00Z');
    await fs.utimes(oldPath, older, older);
    await fs.utimes(newPath, newer, newer);

    const selected = await findLatestProposalFile(packageDirectory);
    assert.equal(selected.name, 'changes (1).json');
    assert.equal(selected.stats.mtime.toISOString(), newer.toISOString());
  } finally {
    await fs.rm(project.projectRoot, { recursive: true, force: true });
  }
});

test('applies a confirmed Drive proposal and archives it for another review', async () => {
  const project = await createProject();
  try {
    const published = await publishReviewDraft(project.draftPath, {
      reviewDirectory: project.reviewDirectory
    });
    await fs.writeFile(published.proposalPath, JSON.stringify({
      schema_version: 1,
      draft_file: project.draftFile,
      locataire: 'Mme Exemple',
      changes: [{
        action: 'update_photo_defect',
        photo_number: 'P01',
        current_description: 'Fenêtre brisée',
        new_description: 'Fenêtre légèrement sale'
      }]
    }), 'utf8');

    const result = await applyDriveReview(
      project.projectRoot,
      project.draftFile,
      { nom: 'Exemple' },
      {
        reviewDirectory: project.reviewDirectory,
        ask: async () => 'oui',
        print: () => {}
      }
    );

    const savedDraft = JSON.parse(await fs.readFile(project.draftPath, 'utf8'));
    const updatedSnapshot = await fs.readFile(published.reviewPath, 'utf8');
    const resetProposal = JSON.parse(await fs.readFile(published.proposalPath, 'utf8'));
    assert.equal(result.applied, true);
    assert.equal(result.proposalArchived, true);
    assert.equal(savedDraft.photos[0].defauts[0], 'Fenêtre légèrement sale');
    assert.match(updatedSnapshot, /Fenêtre légèrement sale/);
    assert.deepEqual(resetProposal.changes, []);
    assert.equal((await fs.readdir(path.join(published.reviewDirectory, 'archive'))).length, 1);
  } finally {
    await fs.rm(project.projectRoot, { recursive: true, force: true });
  }
});

test('applies and archives the newest duplicate while preserving the original template', async () => {
  const project = await createProject();
  try {
    const published = await publishReviewDraft(project.draftPath, {
      reviewDirectory: project.reviewDirectory
    });
    const originalTemplate = await fs.readFile(published.proposalPath, 'utf8');
    const duplicatePath = path.join(published.reviewDirectory, 'changes (1).json');
    await fs.writeFile(duplicatePath, JSON.stringify({
      schema_version: 1,
      draft_file: project.draftFile,
      locataire: 'Mme Exemple',
      changes: [{
        action: 'update_photo_defect',
        photo_number: 'P01',
        current_description: 'Fenêtre brisée',
        new_description: 'Fenêtre légèrement sale'
      }]
    }), 'utf8');

    const result = await applyDriveReview(
      project.projectRoot,
      project.draftFile,
      { nom: 'Exemple' },
      {
        reviewDirectory: project.reviewDirectory,
        ask: async () => 'oui',
        print: () => {}
      }
    );

    const savedDraft = JSON.parse(await fs.readFile(project.draftPath, 'utf8'));
    assert.equal(result.applied, true);
    assert.equal(path.basename(result.archivedPath).startsWith('changes-'), true);
    assert.equal(savedDraft.photos[0].defauts[0], 'Fenêtre légèrement sale');
    assert.equal(await fs.readFile(published.proposalPath, 'utf8'), originalTemplate);
    await assert.rejects(fs.access(duplicatePath));
  } finally {
    await fs.rm(project.projectRoot, { recursive: true, force: true });
  }
});

test('does not apply a proposal when the user declines', async () => {
  const project = await createProject();
  try {
    const published = await publishReviewDraft(project.draftPath, {
      reviewDirectory: project.reviewDirectory
    });
    const proposalContent = JSON.stringify({
      schema_version: 1,
      draft_file: project.draftFile,
      locataire: 'Mme Exemple',
      changes: [{
        action: 'append_observation',
        piece: 'chambre',
        element: 'Fenêtre',
        observation: 'Vérifier la fermeture.'
      }]
    });
    await fs.writeFile(published.proposalPath, proposalContent, 'utf8');

    const result = await applyDriveReview(
      project.projectRoot,
      project.draftFile,
      { nom: 'Mme Exemple' },
      {
        reviewDirectory: project.reviewDirectory,
        ask: async () => 'n',
        print: () => {}
      }
    );

    assert.equal(result.applied, false);
    assert.equal(
      JSON.parse(await fs.readFile(project.draftPath, 'utf8')).etat_usure.chambre.Fenêtre[1],
      'Fenêtre brisée (photo annexe P01)'
    );
    assert.equal(await fs.readFile(published.proposalPath, 'utf8'), proposalContent);
  } finally {
    await fs.rm(project.projectRoot, { recursive: true, force: true });
  }
});

test('rejects a proposal that changes while awaiting confirmation', async () => {
  const project = await createProject();
  try {
    const published = await publishReviewDraft(project.draftPath, {
      reviewDirectory: project.reviewDirectory
    });
    await fs.writeFile(published.proposalPath, JSON.stringify({
      schema_version: 1,
      draft_file: project.draftFile,
      locataire: 'Mme Exemple',
      changes: [{
        action: 'append_observation',
        piece: 'chambre',
        element: 'Fenêtre',
        observation: 'Vérifier la fermeture.'
      }]
    }), 'utf8');

    await assert.rejects(
      applyDriveReview(
        project.projectRoot,
        project.draftFile,
        { nom: 'Mme Exemple' },
        {
          reviewDirectory: project.reviewDirectory,
          ask: async () => {
            await fs.writeFile(published.proposalPath, '{"changes":[]}', 'utf8');
            return 'oui';
          },
          print: () => {}
        }
      ),
      /a changé pendant sa validation/
    );
    assert.equal(
      JSON.parse(await fs.readFile(project.draftPath, 'utf8')).etat_usure.chambre.Fenêtre[1],
      'Fenêtre brisée (photo annexe P01)'
    );
  } finally {
    await fs.rm(project.projectRoot, { recursive: true, force: true });
  }
});
