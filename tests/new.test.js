import assert from 'node:assert/strict';
import test from 'node:test';
import { filterPhotoDefects, prefixEntryObservations, validateOptions, getReferenceEtatUsure } from '../src/new.js';

function validOptions() {
  return {
    bien: 'massy',
    type: 'entree',
    locataire: 'Mme Exemple',
    email: 'tenant@example.org',
    telephone: '0601020304',
    chambre: 'Chambre 1',
    lot: 'A2354-1',
    date: '2026-11-01',
    adresseBien: '1 rue Exemple, Massy',
    photos: 'C:\\photos',
    proprete: 'Bon état',
    detecteurFumee: 'présent',
    reservesBailleur: 'Aucune observation ni réserve.',
    reservesLocataire: 'Aucune observation ni réserve.'
  };
}

test('allows EDL validation without meter readings', () => {
  assert.doesNotThrow(() => validateOptions(validOptions()));
});

test('continues validating required EDL fields without requiring meter readings', () => {
  const options = validOptions();
  delete options.date;
  assert.throws(() => validateOptions(options), /Option manquante: --date/);
});

test('ne conserve que les défauts de gravité forte dans un EDL d’entrée', () => {
  const defects = [
    { description: 'petite rayure', gravite: 'faible' },
    { description: 'trace visible', gravite: 'moyenne' },
    { description: 'porte cassée', gravite: 'forte' },
    { description: 'gravité absente' }
  ];

  assert.deepEqual(filterPhotoDefects(defects, 'entree'), [defects[2]]);
});

test('conserve tous les défauts décrits dans un EDL de sortie', () => {
  const defects = [
    { description: 'petite rayure', gravite: 'faible' },
    { description: 'porte cassée', gravite: 'forte' }
  ];

  assert.deepEqual(filterPhotoDefects(defects, 'sortie'), defects);
  assert.deepEqual(filterPhotoDefects(null, 'sortie'), []);
});

test('préfixe les observations d’entrée une seule fois pour les reprendre dans l’EDL de sortie', () => {
  const states = {
    chambre: {
      murs: ['Bon état', 'Peinture propre'],
      sol: ['État moyen', 'CONSTATÉ DANS L’EDL D’ENTRÉE : rayure'],
      plafond: ['Bon état', '']
    }
  };

  assert.equal(prefixEntryObservations(states), states);
  assert.deepEqual(states.chambre, {
    murs: ['Bon état', 'CONSTATÉ DANS L’EDL D’ENTRÉE : Peinture propre'],
    sol: ['État moyen', 'CONSTATÉ DANS L’EDL D’ENTRÉE : rayure'],
    plafond: ['Bon état', '']
  });
});

test('reprend les états et observations des pièces d’un contexte de logement générique', () => {
  const property = {
    pieces: { chambre: ['Sol', 'Fenêtre'] },
    piece_labels: { chambre: 'Chambre' }
  };
  const previous = {
    pieces: [{
      piece: 'Chambre',
      elements: [
        { element: 'Sol', etat: 'Mauvais état', observation: 'Parquet rayé et usé' },
        { element: 'Fenêtre', etat: 'Bon état', observation: 'Joint décollé' }
      ]
    }]
  };

  assert.deepEqual(getReferenceEtatUsure(previous, property), {
    chambre: {
      Sol: ['Mauvais état', 'Parquet rayé et usé'],
      Fenêtre: ['Bon état', 'Joint décollé']
    }
  });
});
