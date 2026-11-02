import assert from 'node:assert/strict';
import test from 'node:test';
import { findVibeLocataire, generateContext } from '../src/context-generator.js';

test('trouve un locataire sans tenir compte des accents ou de la casse', () => {
  const context = {
    locataires: [{
      nom: 'Élodie BANIZA Emmanuel',
      email: 'elodie@example.com'
    }]
  };

  assert.equal(
    findVibeLocataire(context, 'elodie baniza emmanuel').email,
    'elodie@example.com'
  );
});

test('refuse une recherche partielle ambiguë', () => {
  const context = {
    locataires: [
      { nom: 'Baniza Emmanuel' },
      { nom: 'Baniza Emmanuel Junior' }
    ]
  };

  assert.throws(() => findVibeLocataire(context, 'Baniza'), /plusieurs locataires/i);
});

function createEdlContext() {
  return {
    bailleur: {
      nom: 'Bailleur Exemple',
      adresse: '1 rue Exemple, Paris',
      telephone: '0102030405',
      email: 'bailleur@example.org'
    },
    bien: {
      type: 'Appartement T5',
      adresse: '2 place Exemple, Massy',
      lots: { 'A2354-1': 'chambre de 13 m², à gauche — lot A2354-1' }
    },
    formulation_chambre_standard: 'chambre de 13 m², à gauche — lot A2354-1',
    locataire: {
      civilite: 'Mme',
      nom: 'Locataire Test',
      email: 'locataire@example.org',
      lot: '#A2354-1'
    },
    dernier_edl_connu: {
      type: 'EDL d’entrée',
      locataire: 'Locataire Test',
      date: '30/10/2026',
      chambres_13m2: [{ element: 'Mur', etat: 'Bon état' }],
      parties_communes: {},
      defauts_documentes: [],
      cles_remises: [],
      champs_a_completer: []
    },
    regles_generation: ['Ne rien inventer.']
  };
}

test('génère le contexte depuis la source distante sans utiliser la base locale', async () => {
  const { context } = await generateContext('Test', {
    edlContextData: createEdlContext(),
    date: '2026-11-01'
  });

  assert.equal(context.locataire.nom, 'Mme Locataire Test');
  assert.equal(context.locataire.email, 'locataire@example.org');
  assert.equal(context.locataire.lot, 'A2354-1');
  assert.equal(context.locataire.chambre, 'chambre de 13 m², à gauche — lot A2354-1');
  assert.equal(context.adresseBien, '2 place Exemple, Massy');
  assert.equal(context.type, 'sortie');
  assert.equal(context.bailleur.nom, 'Bailleur Exemple');
});

test('does not infer a tenant EDL type from an unassigned property reference', async () => {
  const edlContextData = createEdlContext();
  delete edlContextData.dernier_edl_connu.locataire;

  const { context } = await generateContext('Test', { edlContextData });

  assert.equal(context.type, 'entree');
});

test('demande seulement le téléphone absent et conserve les données canoniques', async () => {
  const { context } = await generateContext('Test', {
    edlContextData: createEdlContext(),
    requireConfirmedContact: true,
    vibeContextData: {
      locataires: [{
        nom: 'Locataire Test',
        email: 'ignored@example.org',
        telephone: '0601020304'
      }]
    }
  });

  assert.equal(context.locataire.email, 'locataire@example.org');
  assert.equal(context.locataire.telephone, '0601020304');
});

test('refuse un locataire absent de la source de vérité', async () => {
  await assert.rejects(
    generateContext('Autre', { edlContextData: createEdlContext() }),
    /ne correspond pas au locataire/
  );
});

test('refuse le flux confirmé tant que le téléphone manque', async () => {
  await assert.rejects(
    generateContext('Test', {
      edlContextData: createEdlContext(),
      requireConfirmedContact: true
    }),
    /téléphone confirmé/
  );
});
