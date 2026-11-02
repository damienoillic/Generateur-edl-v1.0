import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  EDL_CONTEXT_INDEX_URL,
  ensureEdlContext,
  findTenantRoute,
  getTenantReference,
  matchesTenantIdentity,
  normalizeTenantFamily,
  validateEdlContext,
  validateEdlContextIndex
} from '../src/edl-context.js';

const tenantUrl = 'https://drive.google.com/uc?export=download&id=tenant-id';

test('uses the current Google Drive context index', () => {
  assert.equal(
    EDL_CONTEXT_INDEX_URL,
    'https://drive.google.com/uc?export=download&id=YOUR_DRIVE_ID_HERE'
  );
});

function validContext() {
  return {
    bailleur: {
      nom: 'Bailleur Exemple',
      adresse: '1 rue Exemple, 75000 Paris',
      telephone: '0102030405',
      email: 'bailleur@example.org'
    },
    bien: {
      type: 'Appartement T5 de 84 m2',
      adresse: '2 place Exemple, 91300 Massy',
      lots: {
        'A2354-1': "chambre de 13 m², en face de l'entrée à gauche"
      }
    },
    formulation_chambre_standard: "chambre de 13 m², en face de l'entrée à gauche — lot n° A2354-1",
    locataire: {
      civilite: 'Mme',
      nom: 'Baniza Magnoudewa Emmanuel',
      email: 'tenant@example.org',
      lot: '#A2354-1'
    },
    dernier_edl_connu: null,
    regles_generation: ['Ne rien inventer.']
  };
}

function validApartmentContext() {
  return {
    bailleur: {
      nom: 'Bailleur Exemple',
      adresse: '49 rue Exemple, Paris',
      telephone: '0102030405',
      email: 'bailleur@example.org'
    },
    bien: {
      type: 'T2 meublé',
      adresse: '191 rue St Charles, Bat C, 75015 Paris',
      lot: '#500',
      formulation_lot: 'logement entier — lot n° 500'
    },
    locataire: {
      nom: 'Mohamed Ben Salem',
      email: 'tenant@example.org',
      telephone: '0600000000',
      lot: '#500'
    },
    dernier_edl_connu: {
      type: 'EDL d’entrée',
      date: '31/07/2026',
      detecteur_fumee: 'Absent',
      pieces: [{
        piece: 'Chambre',
        elements: [
          { element: 'Sol', etat: 'Mauvais état', observation: 'Parquet rayé et usé' },
          { element: 'Fenêtre', etat: 'Bon état', observation: 'Joint décollé' }
        ]
      }],
      cles_remises: [{ type: 'Clé principale', nombre: 1 }]
    },
    donnees_manquantes_ou_ambigues: ['Surface absente'],
    regles_generation: ['Ne rien inventer.']
  };
}

function validIndex() {
  return {
    version: '2026-11-01.5',
    locataires: [{
      nom_famille: 'Baniza',
      fichier: 'baniza.json',
      drive_id: 'tenant-id',
      download_url: tenantUrl
    }]
  };
}

function responseFor(data, url) {
  return {
    ok: true,
    status: 200,
    url,
    headers: { get: () => null },
    text: async () => JSON.stringify(data)
  };
}

async function createTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'edl-context-test-'));
}

test('uses a newer index version from the synchronized Google Drive folder', async () => {
  const root = await createTempDir();
  const syncedDirectory = path.join(root, 'synced');
  const newerIndex = {
    ...validIndex(),
    version: '2026-11-01.6',
    locataires: [{
      ...validIndex().locataires[0],
      fichier: 'baniza-new.json',
      download_url: 'https://drive.google.com/uc?export=download&id=tenant-new'
    }]
  };
  await fs.mkdir(syncedDirectory);
  await fs.writeFile(path.join(syncedDirectory, 'index (4).json'), JSON.stringify(newerIndex));

  try {
    const result = await ensureEdlContext('BANIZA', {
      contextDirectory: path.join(root, 'project-cache'),
      syncedDriveDirectory: syncedDirectory,
      fetchImpl: async url => url === EDL_CONTEXT_INDEX_URL
        ? responseFor(validIndex(), url)
        : responseFor(validContext(), url)
    });

    assert.deepEqual(result, validContext());
    const savedIndex = JSON.parse(await fs.readFile(path.join(root, 'project-cache', 'index.json'), 'utf8'));
    assert.equal(savedIndex.version, '2026-11-01.6');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('normalizes family names and resolves an exact route', () => {
  const index = validIndex();
  assert.equal(normalizeTenantFamily('  ben salém  '), 'BEN SALEM');
  assert.equal(findTenantRoute(index, 'BANIZA').fichier, 'baniza.json');
  assert.throws(() => findTenantRoute(index, 'Baniz'), /Locataire inconnu de l’index/);
});

test('validates individual context, including a null previous EDL', () => {
  const context = validateEdlContext(validContext());
  const reference = getTenantReference(context, 'BANIZA');

  assert.equal(reference.nom, 'Mme Baniza Magnoudewa Emmanuel');
  assert.equal(reference.lot, 'A2354-1');
  assert.equal(reference.chambre, "chambre de 13 m², en face de l'entrée à gauche");
  assert.equal(reference.adresseBien, '2 place Exemple, 91300 Massy');
  assert.equal(reference.referenceDernierEdl, null);
  assert.equal(matchesTenantIdentity('Mme Baniza Magnoudewa Emmanuel', context.locataire), true);
  assert.equal(matchesTenantIdentity('Autre Baniza', context.locataire), false);
});

test('validates and resolves a property context with an EDL-derived room model', () => {
  const context = validateEdlContext(validApartmentContext());
  const reference = getTenantReference(context, 'Ben Salem');

  assert.equal(reference.nom, 'Mohamed Ben Salem');
  assert.equal(reference.lot, '500');
  assert.equal(reference.chambre, 'logement entier — lot n° 500');
  assert.match(reference.bien, /^logement-/);
  assert.deepEqual(reference.bienData.pieces, {
    chambre: ['Sol', 'Fenêtre']
  });
  assert.equal(reference.bienData.piece_labels.chambre, 'Chambre');
  assert.equal(reference.referenceDernierEdl.pieces[0].elements[0].observation, 'Parquet rayé et usé');
});

test('accepts a previous EDL without a date but rejects an invalid supplied date', () => {
  const context = validApartmentContext();
  delete context.dernier_edl_connu.date;

  const validated = validateEdlContext(context);
  assert.equal(getTenantReference(validated, 'Ben Salem').referenceDernierEdl.date, undefined);

  context.dernier_edl_connu.date = '   ';
  assert.equal(validateEdlContext(context).dernier_edl_connu.date, '   ');

  context.dernier_edl_connu.date = 'date inconnue';
  assert.throws(() => validateEdlContext(context), /dernier_edl_connu\.date/);
});

test('accepts Massy references using the chambre array without a recorded key list', () => {
  const context = validContext();
  context.bien.lots['A2354-4'] = 'chambre KEITA (porte-fenêtre sur balcon)';
  context.formulation_chambre_standard = 'chambre avec porte-fenêtre sur balcon — lot n° A2354-4';
  context.locataire = {
    civilite: 'Mme',
    nom: 'KEITA Banse Audrey Mariette',
    email: 'keita@example.org',
    lot: '#A2354-4'
  };
  context.dernier_edl_connu = {
    type: "EDL d'entrée",
    date: '26/08/2025',
    chambre: [{ element: 'Store', etat: 'Mauvais état', observation: 'Ne fonctionne pas' }],
    champs_a_completer: ['Détecteur de fumée']
  };

  const reference = getTenantReference(validateEdlContext(context), 'Keita');
  assert.equal(reference.referenceDernierEdl.chambre[0].observation, 'Ne fonctionne pas');
  assert.equal(reference.referenceDernierEdl.cles_remises, undefined);
});

test('rejects placeholders and a missing lot address', () => {
  const context = validContext();
  context.bien.type = 'Appartement T5 de XX,XX m2';
  assert.throws(() => validateEdlContext(context), /bien\.type/);

  const noLotAddress = validContext();
  noLotAddress.bien.lots = {};
  assert.throws(() => validateEdlContext(noLotAddress), /adresse du lot/);
});

test('downloads the index and tenant context and persists the per-tenant cache', async () => {
  const root = await createTempDir();
  const context = validContext();
  const calls = [];
  try {
    const result = await ensureEdlContext('  baniza ', {
      contextDirectory: root,
      syncedDriveDirectory: path.join(root, 'synced'),
      fetchImpl: async url => {
        calls.push(url);
        return url === EDL_CONTEXT_INDEX_URL
          ? responseFor(validIndex(), url)
          : responseFor(context, url);
      }
    });
    assert.deepEqual(result, context);
    assert.deepEqual(calls, [EDL_CONTEXT_INDEX_URL, tenantUrl]);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'index.json'), 'utf8')), validIndex());
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'baniza.json'), 'utf8')), context);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('loads the index URL from the local configuration file', async () => {
  const root = await createTempDir();
  const context = validContext();
  const configuredIndexUrl = 'https://drive.google.com/uc?export=download&id=configured-index-id';
  const calls = [];
  try {
    const configPath = path.join(root, 'config.json');
    await fs.writeFile(configPath, JSON.stringify({ index_url: configuredIndexUrl }));
    await ensureEdlContext('BANIZA', {
      configPath,
      contextDirectory: path.join(root, 'context'),
      syncedDriveDirectory: path.join(root, 'synced'),
      fetchImpl: async url => {
        calls.push(url);
        return url === configuredIndexUrl
          ? responseFor(validIndex(), url)
          : responseFor(context, url);
      }
    });
    assert.deepEqual(calls, [configuredIndexUrl, tenantUrl]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rejects invalid local index configuration before downloading', async () => {
  const root = await createTempDir();
  try {
    const configPath = path.join(root, 'config.json');
    await fs.writeFile(configPath, JSON.stringify({ index_url: 'https://example.org/index.json' }));
    await assert.rejects(
      ensureEdlContext('BANIZA', {
        configPath,
        contextDirectory: path.join(root, 'context'),
        syncedDriveDirectory: path.join(root, 'synced'),
        fetchImpl: async () => { throw new Error('fetch should not run'); }
      }),
      /URL de l’index EDL invalide/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('falls back to the exact local tenant context when Drive is unavailable', async () => {
  const root = await createTempDir();
  const context = validContext();
  await fs.writeFile(path.join(root, 'index.json'), JSON.stringify(validIndex()));
  await fs.writeFile(path.join(root, 'baniza.json'), JSON.stringify(context));
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = message => warnings.push(message);

  try {
    const result = await ensureEdlContext('BANIZA', {
      contextDirectory: root,
      syncedDriveDirectory: path.join(root, 'synced'),
      fetchImpl: async () => { throw new Error('offline'); }
    });
    assert.deepEqual(result, context);
    assert.match(warnings[0], /INDEX NON MIS À JOUR/);
    assert.match(warnings[1], /CONTEXTE NON MIS À JOUR/);
    assert.match(warnings[1], /version locale du/);
  } finally {
    console.warn = originalWarn;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('uses the synchronized Drive directory before the project cache when Drive is unavailable', async () => {
  const root = await createTempDir();
  const syncedDirectory = path.join(root, 'synced');
  const context = validContext();
  await fs.mkdir(syncedDirectory);
  await fs.writeFile(path.join(syncedDirectory, 'index.json'), JSON.stringify(validIndex()));
  await fs.writeFile(path.join(syncedDirectory, 'baniza.json'), JSON.stringify(context));
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = message => warnings.push(message);

  try {
    const result = await ensureEdlContext('BANIZA', {
      contextDirectory: path.join(root, 'project-cache'),
      syncedDriveDirectory: syncedDirectory,
      fetchImpl: async () => { throw new Error('offline'); }
    });
    assert.deepEqual(result, context);
    assert.match(warnings[0], /INDEX NON MIS À JOUR — version synchronisée .* du/);
    assert.match(warnings[1], /CONTEXTE NON MIS À JOUR — version synchronisée baniza\.json du/);
    await assert.rejects(fs.access(path.join(root, 'project-cache', 'index.json')));
    await assert.rejects(fs.access(path.join(root, 'project-cache', 'baniza.json')));
  } finally {
    console.warn = originalWarn;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('uses the newest duplicate synchronized tenant context when Drive is unavailable', async () => {
  const root = await createTempDir();
  const syncedDirectory = path.join(root, 'synced');
  const olderContext = validContext();
  const newerContext = validContext();
  newerContext.bien.type = 'Appartement version récente';
  await fs.mkdir(syncedDirectory);
  await fs.writeFile(path.join(syncedDirectory, 'index.json'), JSON.stringify(validIndex()));
  const olderPath = path.join(syncedDirectory, 'baniza.json');
  const newerPath = path.join(syncedDirectory, 'baniza (1).json');
  await fs.writeFile(olderPath, JSON.stringify(olderContext));
  await fs.writeFile(newerPath, JSON.stringify(newerContext));
  await fs.utimes(olderPath, new Date('2026-01-01'), new Date('2026-01-01'));
  await fs.utimes(newerPath, new Date('2026-02-01'), new Date('2026-02-01'));
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = message => warnings.push(message);

  try {
    const result = await ensureEdlContext('BANIZA', {
      contextDirectory: path.join(root, 'project-cache'),
      syncedDriveDirectory: syncedDirectory,
      fetchImpl: async () => { throw new Error('offline'); }
    });
    assert.equal(result.bien.type, 'Appartement version récente');
    assert.match(warnings[1], /baniza \(1\)\.json/);
  } finally {
    console.warn = originalWarn;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('does not use a neighboring tenant context for an unknown family', async () => {
  const root = await createTempDir();
  try {
    await assert.rejects(
      ensureEdlContext('Baniz', {
        contextDirectory: root,
        syncedDriveDirectory: path.join(root, 'synced'),
        fetchImpl: async url => responseFor(validIndex(), url)
      }),
      /Locataire inconnu de l’index/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('stops on malformed or invalid downloaded JSON instead of using stale files', async () => {
  const root = await createTempDir();
  await fs.writeFile(path.join(root, 'index.json'), JSON.stringify(validIndex()));
  await fs.writeFile(path.join(root, 'baniza.json'), JSON.stringify(validContext()));
  try {
    await assert.rejects(
      ensureEdlContext('BANIZA', {
        contextDirectory: root,
        syncedDriveDirectory: path.join(root, 'synced'),
        fetchImpl: async url => ({
          ...responseFor({}, url),
          text: async () => '{not json'
        })
      }),
      /Le JSON téléchargé est invalide/
    );

    await assert.rejects(
      ensureEdlContext('BANIZA', {
        contextDirectory: root,
        syncedDriveDirectory: path.join(root, 'synced'),
        fetchImpl: async url => url === EDL_CONTEXT_INDEX_URL
          ? responseFor(validIndex(), url)
          : responseFor({ ...validContext(), dernier_edl_connu: {} }, url)
      }),
      /Contexte locataire invalide/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('refuses to proceed if remote and local index downloads both fail', async () => {
  const root = await createTempDir();
  try {
    await assert.rejects(
      ensureEdlContext('BANIZA', {
        contextDirectory: root,
        syncedDriveDirectory: path.join(root, 'synced'),
        fetchImpl: async () => { throw new Error('offline'); }
      }),
      /aucun index local valide/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('validates the index route schema and Google Drive URL', () => {
  const index = validIndex();
  assert.equal(validateEdlContextIndex(index), index);
  assert.throws(() => validateEdlContextIndex({
    locataires: [{ ...index.locataires[0], download_url: 'https://example.org/tenant.json' }]
  }), /doit pointer vers Google Drive/);
});
