import assert from 'node:assert/strict';
import test from 'node:test';
import { generateHtml } from '../src/template.js';
import { createDefaultKeys, getReferenceEtatUsure, resolveSmokeDetectorState } from '../src/new.js';

test('does not fabricate missing room conditions or key entries', () => {
  const states = getReferenceEtatUsure({
    chambres_13m2: [{ element: 'Mur', etat: 'Neuf' }],
    parties_communes: { salon: 'Fenêtre à vérifier ; canapé en bon état' }
  }, {
    pieces: {
      chambre: ['Mur', 'Sol'],
      salon: ['Mur', 'Canapé']
    }
  });

  assert.deepEqual(states.chambre, {
    Mur: ['Neuf', ''],
    Sol: ['', '']
  });
  assert.deepEqual(states.salon, {
    Mur: ['', ''],
    Canapé: ['Bon état', 'canapé en bon état']
  });
  assert.deepEqual(createDefaultKeys('2026-10-31'), []);
});

test('maps the legacy chambre reference array to room states', () => {
  const states = getReferenceEtatUsure({
    chambre: [
      { element: 'Store', etat: 'Mauvais état', observation: 'Ne fonctionne pas' }
    ]
  }, {
    pieces: { chambre: ['Mur', 'Store'] }
  });

  assert.deepEqual(states.chambre, {
    Mur: ['', ''],
    Store: ['Mauvais état', 'Ne fonctionne pas']
  });
});

test('renders custom property rooms and signing city from property data', () => {
  const html = generateHtml({
    bien: 'logement-paris-500',
    bien_data: {
      nom: '12 rue Exemple, 75000 Paris',
      adresse: '12 rue Exemple, 75000 Paris',
      surface: 45,
      pieces: { sejour: ['Mur', 'Fenêtre'] },
      piece_labels: { sejour: 'Séjour-cuisine' }
    },
    type: 'entree',
    date: '2026-11-02',
    adresse_bien: '12 rue Exemple, 75000 Paris',
    locataire: { nom: 'Mme Exemple', chambre: 'Logement entier — lot n° 500' },
    bailleur: {},
    etat_usure: { sejour: { Mur: ['Bon état', 'Peinture propre'], Fenêtre: ['', ''] } },
    photos: [],
    cles: [],
    securite: {}
  }, true);

  assert.match(html, /Pièce : Séjour-cuisine/);
  assert.match(html, /<td>Mur<\/td>\s*<td>1<\/td>\s*<td>Bon état<\/td>\s*<td>Peinture propre<\/td>/);
  assert.match(html, /signé à Paris/);
  assert.doesNotMatch(html, /signé à Massy/);
});

test('renders a previous EDL source without an empty date', () => {
  const html = generateHtml({
    bien: 'logement-clichy',
    bien_data: {
      nom: '1 rue Stepney, 92110 Clichy',
      adresse: '1 rue Stepney, 92110 Clichy',
      pieces: { chambre: ['Mur'] }
    },
    type: 'sortie',
    date: '2026-11-02',
    adresse_bien: '1 rue Stepney, 92110 Clichy',
    locataire: { nom: 'M. Exemple', chambre: 'Logement entier' },
    bailleur: {},
    etat_usure: { chambre: { Mur: ['', ''] } },
    photos: [],
    cles: [],
    securite: {},
    edl_reference: { type: 'EDL d’entrée', locataire: 'M. Exemple' }
  }, true);

  assert.match(html, /Source : EDL d’entrée — M\. Exemple/);
  assert.doesNotMatch(html, /EDL d’entrée du\s*—/);
});

test('maps room-wide and element-specific common-area reference descriptions', () => {
  const states = getReferenceEtatUsure({
    parties_communes: {
      salon: 'Quasi neuf ; fenêtre état moyen ; store défectueux (non concerné)',
      cuisine: 'Quasi neuve ; porte état moyen ; évier bon état ; vitres sales à l’entrée (PC10)',
      salle_eau_1: 'Porte à vérifier (cassée au départ ; remplacement en cours) ; miroir traces de calcaire (PC13)',
      salle_eau_2: 'Neuf',
      wc: 'Neuf',
      couloir: 'Bon état ; plinthes avec traces'
    }
  }, {
    pieces: {
      salon: ['Mur', 'Fenêtre', 'Store'],
      cuisine: ['Mur', 'Porte', 'Évier', 'Fenêtre'],
      'salle-deau-1': ['Porte', 'Miroir', 'Sol'],
      'salle-deau-2': ['Mur', 'Douche'],
      toilettes: ['WC', 'Sol'],
      couloirs: ['Mur', 'Plinthes']
    }
  });

  assert.deepEqual(states.salon, {
    Mur: ['Quasi neuf', ''],
    Fenêtre: ['État moyen', 'fenêtre état moyen'],
    Store: ['Défectueux', 'store défectueux (non concerné)']
  });
  assert.deepEqual(states.cuisine, {
    Mur: ['Quasi neuf', ''],
    Porte: ['État moyen', 'porte état moyen'],
    Évier: ['Bon état', 'évier bon état'],
    Fenêtre: ['', 'vitres sales à l’entrée (PC10)']
  });
  assert.deepEqual(states['salle-deau-1'], {
    Porte: ['À vérifier', 'Porte à vérifier (cassée au départ ; remplacement en cours)'],
    Miroir: ['', 'miroir traces de calcaire (PC13)'],
    Sol: ['', '']
  });
  assert.deepEqual(states['salle-deau-2'], {
    Mur: ['Neuf', ''],
    Douche: ['Neuf', '']
  });
  assert.deepEqual(states.toilettes, {
    WC: ['Neuf', ''],
    Sol: ['Neuf', '']
  });
  assert.deepEqual(states.couloirs, {
    Mur: ['Bon état', ''],
    Plinthes: ['', 'plinthes avec traces']
  });
});

test('le contexte sans dernier EDL laisse tous les états inconnus vides', () => {
  assert.deepEqual(getReferenceEtatUsure(null, {
    pieces: {
      chambre: ['Mur', 'Sol'],
      salon: ['Fenêtre']
    }
  }), {
    chambre: { Mur: ['', ''], Sol: ['', ''] },
    salon: { Fenêtre: ['', ''] }
  });
  assert.deepEqual(createDefaultKeys('2026-10-31', null), []);
});

test('considers the smoke detector present unless an explicit state is supplied', () => {
  assert.equal(resolveSmokeDetectorState(undefined), 'présent');
  assert.equal(resolveSmokeDetectorState('absent'), 'absent');
});

test('génère les tableaux d’état d’usure et l’adresse du bien configuré', () => {
  const html = generateHtml({
    bien: 'massy',
    adresse_bien: '12 rue des Érables imaginaires, 99999 Ville-Fictive',
    type: 'entree',
    date: '2026-10-31',
    locataire: {
      nom: 'Camille Martin (personnage fictif)',
      telephone: '06 00 00 00 00',
      email: 'camille.martin@example.test'
    },
    bailleur: {
      nom: 'Alexandre Exemple (personnage fictif)',
      telephone: '06 00 00 00 01'
    },
    etat_usure: {
      chambre: {
        Mur: ['Bon état', 'Peinture intacte']
      }
    },
    photos: [],
    cles: [],
    securite: {},
    reserves_bailleur: '',
    reserves_locataire: ''
  }, true);

  assert.match(html, /12 rue des Érables imaginaires, 99999 Ville-Fictive/);
  assert.match(html, /<h1>ÉTAT DES LIEUX D'ENTRÉE<\/h1>/);
  assert.match(html, /Informations générales/);
  assert.doesNotMatch(html, /Type d'état des lieux/);
  assert.match(html, /Camille Martin \(personnage fictif\)/);
  assert.match(html, /06 00 00 00 00/);
  assert.doesNotMatch(html, /<strong>Lot :<\/strong>/);
  assert.match(html, /<table class="state-table">/);
  assert.match(html, /Pièce : Chambre/);
  assert.match(html, /<td>Mur<\/td>/);
  assert.match(html, /<td>Bon état<\/td>/);
  assert.match(html, /Peinture intacte/);
});

test('omits landlord contact details and the meter-reading section from every EDL', () => {
  const html = generateHtml({
    bien: 'massy',
    adresse_bien: 'Adresse de test',
    type: 'entree',
    date: '2026-10-31',
    locataire: {
      nom: 'Locataire Exemple',
      telephone: '0600000000',
      email: 'tenant@example.org'
    },
    bailleur: {
      nom: 'Bailleur Exemple',
      adresse: 'Adresse bailleur',
      telephone: '0100000000',
      email: 'landlord@example.org'
    },
    releves_compteurs: {
      electricite: '123',
      eau_froide: '456',
      eau_chaude: '789'
    },
    etat_usure: {},
    photos: [],
    cles: [],
    securite: {}
  });

  const landlordBlock = html.match(/<h3>Bailleur<\/h3>([\s\S]*?)<\/div>/)?.[1] || '';
  assert.match(landlordBlock, /Bailleur Exemple/);
  assert.match(landlordBlock, /Adresse bailleur/);
  assert.doesNotMatch(landlordBlock, /Téléphone|Email|0100000000|landlord@example\.org/);
  assert.match(html, /0600000000/);
  assert.match(html, /tenant@example\.org/);
  assert.doesNotMatch(html, /Relevés des compteurs|Électricité|Eau froide|Eau chaude/);
});

test('affiche les clés provenant du contexte de référence', () => {
  const html = generateHtml({
    bien: 'massy',
    type: 'sortie',
    date: '2026-10-31',
    locataire: { nom: 'Morgan Exemple (personnage fictif)' },
    bailleur: {},
    etat_usure: {},
    photos: [],
    cles: createDefaultKeys('2026-10-31', [
      { type: 'Clé de chambre', nombre: 1, date: '2026-10-31' },
      { type: 'Badge immeuble', nombre: 1, date: '2026-10-31' }
    ]),
    securite: {}
  });

  assert.match(html, /<h1>ÉTAT DES LIEUX DE SORTIE<\/h1>/);
  assert.match(html, /Clé de chambre/);
  assert.match(html, /Badge immeuble/);
  const keysStart = html.indexOf('<h2 class="section-title">Remise des clés</h2>');
  const keysEnd = html.indexOf('</section>', keysStart);
  const keysSection = html.slice(keysStart, keysEnd);
  assert.equal((keysSection.match(/<td>1<\/td>/g) || []).length, 2);
  assert.equal((keysSection.match(/<td>2026-10-31<\/td>/g) || []).length, 2);
});

test('escapes reference details when generating the HTML draft', () => {
  const html = generateHtml({
    bien: 'massy',
    type: 'sortie',
    date: '2026-10-31',
    locataire: { nom: 'Personnage Fictif' },
    bailleur: {},
    etat_usure: {},
    edl_reference: {
      type: 'EDL <entrée>',
      date: '2026-10-30',
      locataire: 'Personnage <Fictif>',
      defauts_documentes: [{ photo: 'P<01>', defaut: 'Mur & peinture' }],
      parties_communes: { salon: 'Canapé <à vérifier>' }
    },
    photos: [],
    cles: [],
    securite: {}
  }, true);

  assert.match(html, /EDL &lt;entrée&gt;/);
  assert.match(html, /Personnage &lt;Fictif&gt;/);
  assert.match(html, /Mur &amp; peinture/);
  assert.match(html, /Canapé &lt;à vérifier&gt;/);
  assert.match(html, /Résumé de l'EDL d'entrée/);
  assert.doesNotMatch(html, /<entrée>|<Fictif>|<à vérifier>/);
});

test('compare les états d’entrée et de sortie sans afficher le résumé pour une entrée', () => {
  const sortieHtml = generateHtml({
    bien: 'massy',
    type: 'sortie',
    date: '2026-10-31',
    locataire: {},
    bailleur: {},
    etat_usure: { chambre: { Mur: ['Bon état', 'Observation de sortie'] } },
    etat_usure_entree: { chambre: { Mur: ['Neuf', 'Observation d’entrée'] } },
    edl_reference: {
      type: "EDL d'entrée",
      date: '2026-10-30',
      locataire: 'Locataire exemple',
      parties_communes: { salon: 'Fenêtre à vérifier' }
    },
    photos: [],
    cles: [],
    securite: {}
  }, true);

  assert.match(sortieHtml, /État d'usure à l'entrée/);
  assert.match(sortieHtml, /État d'usure à la sortie/);
  assert.match(sortieHtml, /<td>Neuf<\/td>\s*<td>Bon état<\/td>/);
  assert.match(sortieHtml, /Résumé de l'EDL d'entrée : Fenêtre à vérifier/);

  const entreeHtml = generateHtml({
    bien: 'massy',
    type: 'entree',
    date: '2026-10-31',
    locataire: {},
    bailleur: {},
    etat_usure: { chambre: { Mur: ['Neuf', ''] } },
    edl_reference: {
      type: "EDL d'entrée",
      parties_communes: { salon: 'Fenêtre à vérifier' }
    },
    photos: [],
    cles: [],
    securite: {}
  }, true);

  assert.match(entreeHtml, /<th>État d'usure<\/th>/);
  assert.doesNotMatch(entreeHtml, /Résumé de l'EDL d'entrée/);
  assert.doesNotMatch(entreeHtml, /États repris du contexte de référence/);
});

test('n’affiche le bloc de signatures qu’une seule fois', () => {
  const html = generateHtml({
    bien: 'massy',
    type: 'entree',
    date: '2026-10-31',
    locataire: { nom: 'Personnage Fictif' },
    bailleur: {},
    etat_usure: {},
    photos: [{ fichier: 'photo.jpg', piece: 'chambre', legende: 'Photo fictive' }],
    cles: [],
    securite: {}
  });

  assert.equal((html.match(/Ainsi fait contradictoirement et signé à Massy/g) || []).length, 1);
});

test('conserve les tableaux d’état si le catalogue du bien est absent', () => {
  const html = generateHtml({
    bien: 'bien-inconnu',
    type: 'sortie',
    date: '2026-10-31',
    locataire: {},
    bailleur: {},
    etat_usure: {
      cuisine: {
        Évier: ['État moyen', 'Joint à contrôler']
      }
    },
    photos: [],
    cles: [],
    securite: {}
  }, false);

  assert.match(html, /<table class="state-table">/);
  assert.match(html, /Pièce : Cuisine/);
  assert.match(html, /<td>Évier<\/td>/);
  assert.match(html, /Joint à contrôler/);
  assert.match(html, /Adresse du logement non configurée/);
});

test('affiche l’adresse saisie pour cet EDL plutôt que celle du catalogue', () => {
  const html = generateHtml({
    bien: 'massy',
    adresse_bien: '12 rue du Test, 91300 Massy',
    type: 'entree',
    date: '2026-10-31',
    locataire: {},
    bailleur: {},
    etat_usure: {},
    photos: [],
    cles: [],
    securite: {}
  }, false);

  assert.match(html, /12 rue du Test, 91300 Massy/);
  assert.doesNotMatch(html, /2 place d'Allemagne, 91300 Massy/);
});

test('affiche les photos à leur largeur de colonne sans cadre de hauteur fixe', () => {
  const html = generateHtml({
    bien: 'bien-inconnu',
    type: 'sortie',
    date: '2026-10-31',
    locataire: {},
    bailleur: {},
    etat_usure: {},
    photos: [{ fichier: 'photo.jpg', piece: 'chambre', legende: 'Vue générale' }],
    cles: [],
    securite: {}
  }, false);

  assert.match(html, /\.photo-item img\s*\{[^}]*width:\s*100%[^}]*height:\s*auto/s);
  assert.doesNotMatch(html, /\.photo-item img\s*\{[^}]*height:\s*\d+px/s);
});

test('regroupe trois portraits ou deux paysages par rangée sans mélanger leurs formats', () => {
  const html = generateHtml({
    bien: 'bien-inconnu',
    type: 'sortie',
    date: '2026-10-31',
    locataire: {},
    bailleur: {},
    etat_usure: {},
    photos: [
      { fichier: 'portrait-1.jpg', piece: 'chambre', orientation: 'portrait' },
      { fichier: 'portrait-2.jpg', piece: 'chambre', orientation: 'portrait' },
      { fichier: 'portrait-3.jpg', piece: 'chambre', orientation: 'portrait' },
      { fichier: 'landscape-1.jpg', piece: 'chambre', orientation: 'paysage' },
      { fichier: 'landscape-2.jpg', piece: 'chambre', orientation: 'paysage' },
      { fichier: 'portrait-4.jpg', piece: 'chambre', orientation: 'portrait' }
    ],
    cles: [],
    securite: {}
  }, false);

  const markers = [...html.matchAll(/<div class="photo-row photo-row--(portrait|paysage)">/g)];
  const rows = markers.map((marker, index) => {
    const start = marker.index + marker[0].length;
    const end = markers[index + 1]?.index ?? html.length;
    return {
      orientation: marker[1],
      photoCount: (html.slice(start, end).match(/class="photo-item"/g) || []).length
    };
  });

  assert.deepEqual(rows, [
    { orientation: 'portrait', photoCount: 3 },
    { orientation: 'paysage', photoCount: 2 },
    { orientation: 'portrait', photoCount: 1 }
  ]);
  assert.match(html, /\.photo-item img\s*\{[^}]*height:\s*auto/s);
  assert.match(html, /\.photo-row--portrait \.photo-item\s*\{\s*flex:\s*0 0 calc\(\(100% - 30px\) \/ 3\);/);
  assert.match(html, /\.photo-row--paysage \.photo-item\s*\{\s*flex:\s*0 0 calc\(\(100% - 15px\) \/ 2\);/);
});
