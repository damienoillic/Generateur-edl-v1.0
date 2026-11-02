/**
 * Module new - Création d'un nouvel EDL brouillon
 * 
 * Étapes:
 * 1. Valider les paramètres
 * 2. Lire les données du bien depuis data/biens.json
 * 3. Copier et compresser les photos vers output/media/
 * 4. Lire l'analyse (si fournie) et faire la jointure avec les photos
 * 5. Créer le brouillon JSON avec les métadonnées
 * 6. Générer le HTML du brouillon
 * 7. Sauvegarder et ouvrir dans le navigateur
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { compressAllImages } from './images.js';
import { generateHtml } from './template.js';
import { previewHtml } from './pdf.js';
import { ensureEdlContext, getTenantReference } from './edl-context.js';
import { applyDefaultEdlAnswers } from './edl-clarification.js';
import { loadPropertyInventory } from './property-inventory.js';
import { publishReviewDraft } from './drive-review.js';
import { selectRelevantPhotos } from './photo-selection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(__dirname);

/**
 * Ajuste les états d'usure en fonction des observations négatives
 * @param {object} etat_usure - États d'usure à ajuster
 */
function adjustEtatsFromObservations(etat_usure) {
  // Mots-clés négatifs qui indiquent un problème
  const negativeKeywords = [
    'défaut', 'problème', 'cassé', 'abîmé', 'endommagé', 'manque', 'manquant',
    'fissure', 'trou', 'trace', 'sale', 'poussière', 'poussiéreux', 'désordre',
    'écaillé', 'humidité', 'calcaire', 'détérioré', 'dégât', 'fuite',
    'froissé', 'non lissé', 'non ferm', 'pas de', 'sans', 'absenc'
  ];
  
  for (const pieceName of Object.keys(etat_usure)) {
    for (const element of Object.keys(etat_usure[pieceName])) {
      const [etat, observation] = etat_usure[pieceName][element];
      
      // Vérifier si l'observation contient des mots négatifs
      const observationLower = observation.toLowerCase();
      const hasNegative = negativeKeywords.some(keyword => 
        observationLower.includes(keyword)
      );

      if (hasNegative) {
        // Déterminer le nouvel état en fonction de la gravité
        // Si observation contient "cassé" ou "manquant" -> "Cassé(e)" ou "À vérifier"
        if (observationLower.includes('cassé') || observationLower.includes('manquant')) {
          etat_usure[pieceName][element][0] = 'Cassé(e)';
        } else if (observationLower.includes('mauvais') || observationLower.includes('dégât')) {
          etat_usure[pieceName][element][0] = 'Mauvais état';
        } else if (observationLower.includes('moyen') || observationLower.includes('écaillé') || observationLower.includes('fissure')) {
          etat_usure[pieceName][element][0] = 'État moyen';
        } else {
          // Sinon, passer à "Bon état" si ce n'était pas déjà moins bon
          const etatsOrder = ['Très bon état', 'Neuf', 'Bon état', 'État moyen', 'Mauvais état', 'Cassé(e)', 'À vérifier'];
          const currentIndex = etatsOrder.indexOf(etat);
          if (currentIndex > 0 && currentIndex < 2) {
            etat_usure[pieceName][element][0] = 'Bon état';
          }
        }
      }
    }
  }
}

/**
 * Crée un nouvel EDL brouillon
 * @param {object} options - Options de la commande
 * @param {string} options.bien - Nom du bien
 * @param {string} options.type - Type (entree/sortie)
 * @param {string} options.locataire - Nom du locataire
 * @param {string} options.email - Email du locataire
 * @param {string} options.chambre - Description de la chambre
 * @param {string} options.lot - Numéro de lot
 * @param {string} options.date - Date
 * @param {string} options.photos - Chemin du dossier des photos
 * @param {string} [options.analysis] - Chemin vers analysis.json (optionnel)
 */
export async function newCommand(options) {
  const referenceContext = options.edlContextData || await ensureEdlContext(options.locataireFamille || options.locataire);
  const reference = getTenantReference(referenceContext, options.locataireFamille || options.locataire);
  const defaultEdlAnswers = applyDefaultEdlAnswers({
    detecteurFumee: options.detecteurFumee || options.detecteur_fumee ||
      referenceDernierEdlSmokeDetector(reference.referenceDernierEdl),
    proprete: options.proprete,
    reservesBailleur: options.reservesBailleur || options.reserves_bailleur,
    reservesLocataire: options.reservesLocataire || options.reserves_locataire
  });
  const normalizedOptions = {
    ...options,
    bien: reference.bien,
    locataire: reference.nom,
    email: reference.email || options.email || '',
    telephone: options.telephone || reference.telephone,
    chambre: reference.chambre || options.chambre || '',
    lot: reference.lot || options.lot || '',
    adresseBien: reference.adresseBien || options.adresseBien || options.adresse_bien || '',
    bailleur: reference.bailleur,
    referenceDernierEdl: reference.referenceDernierEdl,
    relevesCompteurs: options.relevesCompteurs || options.releves_compteurs,
    detecteurFumee: resolveSmokeDetectorState(defaultEdlAnswers.detecteurFumee),
    proprete: defaultEdlAnswers.proprete,
    reservesBailleur: defaultEdlAnswers.reservesBailleur,
    reservesLocataire: defaultEdlAnswers.reservesLocataire
  };

  const {
    bien,
    type,
    locataire,
    email,
    chambre,
    lot,
    date,
    photos,
    analysis,
    adresseBien,
    telephone = '',
    precompressedPhotos
  } = normalizedOptions;
  
  // Lire les données du bien
  const configuredBienData = reference.bienData || await getBienData(bien);
  if (!configuredBienData) {
    throw new Error(`Bien "${bien}" non trouvé dans data/biens.json`);
  }
  const propertyInventory = await loadPropertyInventory(
    referenceContext.bien.adresse,
    lot,
    configuredBienData
  );
  const surfaceMatch = referenceContext.bien.type.match(/(\d+(?:[,.]\d+)?)\s*m(?:2|²)/i);
  const bienData = {
    ...propertyInventory.bienData,
    nom: referenceContext.bien.adresse,
    adresse: referenceContext.bien.adresse,
    type: referenceContext.bien.type,
    ...(surfaceMatch ? { surface: Number(surfaceMatch[1].replace(',', '.')) } : {})
  };

  const resolvedAdresseBien = (adresseBien || bienData.adresse || bienData.adresse_bien || bienData.nom || 'Adresse non renseignée').trim();
  normalizedOptions.adresseBien = resolvedAdresseBien;
  
  // Valider les paramètres
  validateOptions(normalizedOptions);
  
  // Créer les dossiers de sortie
  const outputDir = path.join(projectRoot, 'output');
  const mediaDir = path.join(outputDir, 'media');
  const edlDir = path.join(projectRoot, 'data', 'edl');
  
  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(mediaDir, { recursive: true });
  await fs.mkdir(edlDir, { recursive: true });
  
  // Vérifier que le dossier photos existe
  const photosDir = path.resolve(photos);
  await verifyPhotosDir(photosDir);
  
  // Lire et parser l'analyse si fournie
  let analysisData = [];
  if (analysis) {
    analysisData = await loadAnalysis(analysis);
    console.log(`Analyse chargée: ${analysisData.length} photo(s) analysée(s)`);
  }

  const analysisCount = analysisData.length;
  let allCompressedPhotos;
  let compressionTempDir;
  let selection;
  let compressedPhotos;
  try {
    if (precompressedPhotos) {
      console.log('\nRéutilisation des photos déjà compressées...');
      allCompressedPhotos = precompressedPhotos;
    } else {
      console.log('\nCompression des photos...');
      compressionTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'edl-photos-'));
      allCompressedPhotos = await compressAllImages(photosDir, compressionTempDir);
    }

    selection = await selectRelevantPhotos(allCompressedPhotos, analysisData, type);
    compressedPhotos = await copyCompressedPhotos(selection.photos, mediaDir);
  } finally {
    if (compressionTempDir) {
      await fs.rm(compressionTempDir, { recursive: true, force: true });
    }
  }

  const selectedFilenames = new Set(selection.photos.map(photo => photo.filename.toLocaleLowerCase()));
  analysisData = analysisData.filter(entry => selectedFilenames.has(entry.fichier.toLocaleLowerCase()));
  if (selection.duplicateCount || selection.omittedCount) {
    console.log(
      `Sélection photo: ${compressedPhotos.length}/${allCompressedPhotos.length} gardée(s), ` +
      `${selection.duplicateCount} doublon(s) supprimé(s), ${selection.omittedCount} photo(s) écartée(s) ` +
      `au-delà de la limite de 30.`
    );
  }
  
  // Charger l'état d'usure précédent
  const previousEtatUsure = getReferenceEtatUsure(
    normalizedOptions.referenceDernierEdl,
    bienData
  );
  if (normalizedOptions.etatUsure) {
    if (normalizedOptions.referenceDernierEdl !== null) {
      throw new Error('Les états transmis ne peuvent pas remplacer un contexte qui contient déjà un EDL de référence.');
    }
    for (const [piece, elements] of Object.entries(normalizedOptions.etatUsure)) {
      if (!previousEtatUsure[piece]) {
        throw new Error(`Pièce inconnue dans etat_usure : "${piece}".`);
      }
      for (const [element, state] of Object.entries(elements)) {
        if (!previousEtatUsure[piece][element]) {
          throw new Error(`Élément inconnu dans etat_usure : "${piece}.${element}".`);
        }
        if (typeof state?.etat !== 'string' || !state.etat.trim()) {
          throw new Error(`État confirmé manquant dans etat_usure : "${piece}.${element}".`);
        }
        previousEtatUsure[piece][element] = [state.etat.trim(), state.observation?.trim() || ''];
      }
    }
  }
  
  // Créer le brouillon JSON avec injection des données d'analyse
  const draftId = generateDraftId(type, locataire, date);
  const draftJson = createDraftJson(
    draftId,
    bien,
    type,
    locataire,
    email,
    chambre,
    lot,
    date,
    compressedPhotos,
    bienData,
    analysisData,
    previousEtatUsure,
    normalizedOptions.adresseBien,
    telephone,
    normalizedOptions.bailleur,
    normalizedOptions.referenceDernierEdl,
    normalizedOptions
  );
  draftJson.bien_data = bienData;
  draftJson.property_inventory_id = propertyInventory.id;
  draftJson.property_inventory_revision = propertyInventory.revision;
  draftJson.property_inventory_address = referenceContext.bien.adresse;
  // Sauvegarder le brouillon JSON
  const draftPath = path.join(edlDir, `draft-${draftId}.json`);
  await fs.writeFile(draftPath, JSON.stringify(draftJson, null, 2), 'utf8');
  
  // Générer le HTML
  console.log('\nGénération du HTML...');
  const html = generateHtml(draftJson, true);
  
  // Sauvegarder le HTML
  const htmlPath = path.join(outputDir, 'brouillon.html');
  await fs.writeFile(htmlPath, html, 'utf8');
  
  // Ouvrir dans le navigateur
  console.log('\nOuverture du brouillon dans le navigateur...');
  await previewHtml(htmlPath);
  
  // Afficher la liste des photos par pièce pour vérification
  console.log('\nPhotos classées par pièce:');
  displayPhotosByPiece(draftJson.photos);
  
  // Afficher les défauts injectés
  if (analysisData.length > 0) {
    console.log('\nDéfauts détectés et injectés:');
    displayInjectedDefauts(draftJson.etat_usure);
  }

  let review = null;
  let reviewError = null;
  try {
    review = await publishReviewDraft(draftPath, { reviewDirectory: options.reviewDirectory });
  } catch (error) {
    reviewError = error.message;
    console.warn(`\n⚠️ Fiche de revue Drive non publiée : ${error.message}`);
  }
  
  return {
    draftPath,
    htmlPath,
    photosCount: compressedPhotos.length,
    analysisCount,
    reviewPath: review?.reviewPath || null,
    reviewError,
    message: `Brouillon créé: ${draftPath}`
  };
}

async function copyCompressedPhotos(photos, mediaDir) {
  if (!Array.isArray(photos)) {
    throw new Error('La liste des photos précompressées doit être un tableau.');
  }

  const copiedPhotos = [];
  for (const photo of photos) {
    if (
      typeof photo?.filename !== 'string' ||
      path.basename(photo.filename) !== photo.filename ||
      typeof photo.path !== 'string'
    ) {
      throw new Error('Entrée invalide dans la liste des photos précompressées.');
    }

    const destination = path.join(mediaDir, photo.filename);
    await fs.copyFile(photo.path, destination);
    copiedPhotos.push({
      ...photo,
      path: destination
    });
  }
  return copiedPhotos;
}

/**
 * Valide les options
 */
export function validateOptions(options) {
  const required = [
    'bien', 'type', 'locataire', 'email', 'telephone', 'chambre', 'lot',
    'date', 'adresseBien', 'photos', 'proprete', 'detecteurFumee',
    'reservesBailleur', 'reservesLocataire'
  ];
  
  for (const key of required) {
    if (!options[key]) {
      throw new Error(`Option manquante: --${key}`);
    }
  }
  if (!['présent', 'absent'].includes(options.detecteurFumee.toLocaleLowerCase())) {
    throw new Error('Le détecteur de fumée doit être confirmé comme « présent » ou « absent ».');
  }
  
  if (!['entree', 'sortie'].includes(options.type)) {
    throw new Error(`Type invalide: "${options.type}". Doit être "entree" ou "sortie".`);
  }
  
  // Valider le format de la date (YYYY-MM-DD)
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(options.date)) {
    throw new Error(`Format de date invalide: "${options.date}". Doit être YYYY-MM-DD.`);
  }
}

/**
 * Récupère les données d'un bien
 */
async function getBienData(bienName) {
  const biensPath = path.join(projectRoot, 'data', 'biens.json');
  
  try {
    const biens = JSON.parse(await fs.readFile(biensPath, 'utf8'));
    return biens[bienName] || null;
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Fichier biens.json non trouvé. Exécutez d'abord: node src/cli.js seed`);
    }
    throw new Error(`Erreur lors de la lecture de biens.json: ${error.message}`);
  }
}

/**
 * Vérifie que le dossier photos existe et contient des images
 */
async function verifyPhotosDir(photosDir) {
  try {
    const stats = await fs.stat(photosDir);
    if (!stats.isDirectory()) {
      throw new Error(`Le chemin des photos doit être un dossier: ${photosDir}`);
    }
    
    const files = await fs.readdir(photosDir);
    const imageFiles = files.filter(file => {
      const ext = path.extname(file).toLowerCase();
      return ['.jpg', '.jpeg', '.png', '.webp'].includes(ext);
    });
    
    if (imageFiles.length === 0) {
      console.warn(`Aucune image trouvée dans ${photosDir}`);
    } else {
      console.log(`Trouvé ${imageFiles.length} image(s) dans ${photosDir}`);
    }
  } catch (error) {
    throw new Error(`Erreur avec le dossier photos: ${error.message}`);
  }
}

/**
 * Charge et parse le fichier analysis.json
 * @param {string} analysisPath - Chemin vers analysis.json
 * @returns {Array} Tableau d'analyses valides
 */
async function loadAnalysis(analysisPath) {
  try {
    const resolvedPath = path.resolve(analysisPath);
    const content = await fs.readFile(resolvedPath, 'utf8');
    const data = JSON.parse(content);
    
    // Valider que c'est un tableau
    if (!Array.isArray(data)) {
      console.warn(`Le fichier analysis.json doit être un tableau. Ignoré.`);
      return [];
    }
    
    // Valider et nettoyer chaque entrée
    const validEntries = [];
    for (const entry of data) {
      try {
        // Vérifier les champs requis
        if (!entry || typeof entry !== 'object') continue;
        if (!entry.fichier) continue;
        
        // Normaliser le nom de fichier (case-insensitive)
        const normalizedEntry = {
          fichier: entry.fichier.toString(),
          piece: entry.piece ? entry.piece.toString().toLowerCase() : 'indetermine',
          elements_visibles: Array.isArray(entry.elements_visibles) ? entry.elements_visibles : [],
          defauts: Array.isArray(entry.defauts) ? entry.defauts : [],
          legende_suggeree: entry.legende_suggeree ? entry.legende_suggeree.toString() : '',
          type_vue: typeof entry.type_vue === 'string' ? entry.type_vue : 'autre',
          pertinence: typeof entry.pertinence === 'number' ? entry.pertinence : 0,
          score_qualite: typeof entry.score_qualite === 'number' ? entry.score_qualite : 0
        };
        
        validEntries.push(normalizedEntry);
      } catch (error) {
        console.warn(`Entrée invalide ignorée dans analysis.json: ${error.message}`);
      }
    }
    
    return validEntries;
  } catch (error) {
    console.warn(`Erreur lors de la lecture de analysis.json: ${error.message}. Continu sans analyse.`);
    return [];
  }
}

/**
 * Génère un ID de brouillon
 */
function generateDraftId(type, locataire, date) {
  // Extraire les initiales du locataire
  const nomParts = locataire.split(' ');
  const initiales = nomParts.length > 0 ? nomParts[0].charAt(0).toUpperCase() : 'X';
  
  // Formater la date (YYYY-MM-DD -> YYYYMMDD)
  const formattedDate = date.replace(/-/g, '');
  
  // Générer un identifiant unique
  const timestamp = Date.now().toString().slice(-4);
  
  return `${type}-${initiales}-${formattedDate}-${timestamp}`;
}

/**
 * Crée l'objet JSON du brouillon avec injection des données d'analyse
 */
function createDraftJson(
  id,
  bien,
  type,
  locataire,
  email,
  chambre,
  lot,
  date,
  photos,
  bienData,
  analysisData,
  previousEtatUsure = null,
  adresseBien = '',
  telephone = '',
  bailleur = {},
  referenceDernierEdl = {},
  options = {}
) {
  // Create the base state structure without assigning unverified conditions.
  const etat_usure = cloneEtatUsure(previousEtatUsure || {});
  
  // Keep unknown states blank rather than asserting an unverified condition.
  if (Object.keys(etat_usure).length === 0) {
    for (const [pieceName, elements] of Object.entries(bienData.pieces)) {
      etat_usure[pieceName] = {};
      for (const element of elements) {
        etat_usure[pieceName][element] = ['', ''];
      }
    }
  }
  const etat_usure_entree = type === 'sortie' ? cloneEtatUsure(etat_usure) : undefined;
  if (type === 'sortie') {
    prefixEntryObservations(etat_usure);
  }
  
  // Créer la liste des photos avec injection des données d'analyse
  const photosList = [];
  let photoIndex = 0;
  
  for (const photo of photos) {
    photoIndex++;
    const photoNumber = `P${String(photoIndex).padStart(2, '0')}`;
    
    // Chercher l'analyse correspondante (jointure par nom de fichier, case-insensitive)
    const analysis = analysisData.find(a => 
      a.fichier.toLowerCase() === photo.filename.toLowerCase()
    );
    
    // Déterminer la pièce
    let piece = 'indetermine';
    let legende = '';
    let defauts = [];
    let score = 0;
    
    if (analysis) {
      piece = analysis.piece || 'indetermine';
      defauts = filterPhotoDefects(analysis.defauts, type);
      legende = analysis.legende_suggeree || (defauts.length
        ? defauts.map(d => d.description).join(' ; ')
        : '');
      score = analysis.score_qualite || 0;
      
      // Injecter les défauts dans les observations de la pièce correspondante
      if (piece !== 'indetermine' && etat_usure[piece]) {
        for (const defaut of defauts) {
          const observation = `${defaut.description} (photo annexe ${photoNumber})`;
          
          // Trouver l'élément le plus pertinent dans la pièce
          // ou ajouter à un élément générique
          const elementToUpdate = findBestElementMatch(defaut.description, bienData.pieces[piece]);
          
          if (elementToUpdate && etat_usure[piece][elementToUpdate]) {
            // Conserver l'observation existante si présente
            const currentState = etat_usure[piece][elementToUpdate];
            const currentObs = currentState[1];
            const newObs = currentObs ? `${currentObs}; ${observation}` : observation;
            etat_usure[piece][elementToUpdate] = [currentState[0] || '', newObs];
          }
        }
      }
    }
    
    photosList.push({
      fichier: photo.filename,
      piece: piece,
      orientation: photo.metadata?.width < photo.metadata?.height ? 'portrait' : 'paysage',
      legende: legende,
      defauts: defauts.map(d => d.description),
      score: score
    });
  }
  
  // Ajustement automatique de l'état basé sur les observations
  if (type === 'entree' && referenceDernierEdl !== null) {
    adjustEtatsFromObservations(etat_usure);
  }
  
  return {
    id,
    bien,
    adresse_bien: adresseBien.trim() || bienData.nom || '',
    type,
    locataire: {
      nom: locataire,
      email,
      telephone,
      chambre,
      lot
    },
    bailleur,
    date,
    etat_usure,
    ...(etat_usure_entree ? { etat_usure_entree } : {}),
    photos: photosList,
    cles: createDefaultKeys(date, referenceDernierEdl?.cles_remises),
    releves_compteurs: options.relevesCompteurs || {},
    proprete: options.proprete || '',
    securite: {
      detecteur_fumee: options.detecteurFumee || ''
    },
    reserves_bailleur: options.reservesBailleur || '',
    reserves_locataire: options.reservesLocataire || '',
    edl_reference: referenceDernierEdl
  };
}

function cloneEtatUsure(etatUsure) {
  return Object.fromEntries(Object.entries(etatUsure).map(([piece, elements]) => [
    piece,
    Object.fromEntries(Object.entries(elements || {}).map(([element, state]) => [
      element,
      Array.isArray(state) ? [...state] : ['', '']
    ]))
  ]));
}

export function filterPhotoDefects(defauts, type) {
  if (!Array.isArray(defauts)) return [];
  return defauts.filter(defaut =>
    defaut &&
    typeof defaut.description === 'string' &&
    defaut.description.trim() &&
    (type !== 'entree' || (
      typeof defaut.gravite === 'string' &&
      defaut.gravite.toLocaleLowerCase().trim() === 'forte'
    ))
  );
}

export function prefixEntryObservations(etatUsure) {
  const prefix = 'CONSTATÉ DANS L’EDL D’ENTRÉE';
  for (const elements of Object.values(etatUsure)) {
    for (const state of Object.values(elements)) {
      if (!Array.isArray(state) || typeof state[1] !== 'string' || !state[1].trim()) continue;
      if (state[1].trimStart().startsWith(prefix)) continue;
      state[1] = `${prefix} : ${state[1]}`;
    }
  }
  return etatUsure;
}

export function createDefaultKeys(date, referenceKeys = []) {
  return (referenceKeys || []).map(key => ({
    type: key.type,
    nombre: key.nombre,
    date: key.date || date,
    observations: key.observations || ''
  }));
}

export function resolveSmokeDetectorState(state) {
  return state || 'présent';
}

export function getReferenceEtatUsure(reference, bienData) {
  const states = Object.fromEntries(
    Object.entries(bienData.pieces).map(([piece, elements]) => [
      piece,
      Object.fromEntries(elements.map(element => [element, ['', '']]))
    ])
  );

  for (const room of reference?.pieces || []) {
    if (typeof room?.piece !== 'string' || !Array.isArray(room.elements)) continue;
    const piece = Object.keys(states).find(
      name => name.toLocaleLowerCase() === normalizeReferenceRoomName(room.piece, bienData)
    );
    if (!piece) continue;
    for (const item of room.elements) {
      if (typeof item?.element !== 'string' || typeof item?.etat !== 'string') continue;
      const element = Object.keys(states[piece]).find(
        name => name.toLocaleLowerCase() === item.element.toLocaleLowerCase()
      );
      if (element) states[piece][element] = [item.etat, item.observation || ''];
    }
  }

  const roomStates = reference?.chambres_13m2 || reference?.chambre_13m2 || reference?.chambre || [];
  for (const item of roomStates) {
    if (typeof item?.element !== 'string' || typeof item?.etat !== 'string') continue;
    const element = Object.keys(states.chambre || {}).find(
      name => name.toLocaleLowerCase() === item.element.toLocaleLowerCase()
    );
    if (element) states.chambre[element] = [item.etat, item.observation || ''];
  }

  const roomAliases = {
    salon: 'salon',
    cuisine: 'cuisine',
    salle_eau_1: 'salle-deau-1',
    salle_eau_2: 'salle-deau-2',
    wc: 'toilettes',
    couloir: 'couloirs'
  };
  for (const [referenceRoom, roomValue] of Object.entries(reference?.parties_communes || {})) {
    const room = roomAliases[referenceRoom];
    if (!room || !states[room]) continue;
    if (typeof roomValue === 'string' && roomValue.trim()) {
      const elements = Object.keys(states[room]);
      const clauses = splitReferenceClauses(roomValue);
      for (const clause of clauses) {
        const element = findReferenceRoomElement(clause, elements);
        const condition = findReferenceCondition(clause);
        if (!element && condition && isRoomWideCondition(clause, condition)) {
          for (const roomElement of elements) {
            states[room][roomElement] = [condition, states[room][roomElement][1]];
          }
        } else if (element) {
          states[room][element] = [condition || '', clause];
        }
      }
    } else if (Array.isArray(roomValue)) {
      for (const item of roomValue) {
        if (typeof item?.element !== 'string' || typeof item?.etat !== 'string') continue;
        const element = Object.keys(states[room]).find(
          name => name.toLocaleLowerCase() === item.element.toLocaleLowerCase()
        );
        if (element) states[room][element] = [item.etat, item.observation || ''];
      }
    }
  }
  return states;
}

function normalizeReferenceRoomName(value, bienData) {
  const normalized = value.normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('fr-FR')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const match = Object.entries(bienData.piece_labels || {}).find(
    ([, label]) => label.normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase('fr-FR')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') === normalized
  );
  if (match) return match[0].toLocaleLowerCase();
  return normalized;
}

function referenceDernierEdlSmokeDetector(reference) {
  return typeof reference?.detecteur_fumee === 'string'
    ? reference.detecteur_fumee.toLocaleLowerCase('fr-FR')
    : '';
}

function splitReferenceClauses(value) {
  const clauses = [];
  let start = 0;
  let parenthesisDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '(') parenthesisDepth += 1;
    if (value[index] === ')') parenthesisDepth = Math.max(0, parenthesisDepth - 1);
    if (value[index] === ';' && parenthesisDepth === 0) {
      clauses.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  clauses.push(value.slice(start).trim());
  return clauses.filter(Boolean);
}

function findReferenceRoomElement(clause, elements) {
  const normalize = value => String(value).normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('fr-FR');
  const normalizedClause = normalize(clause);
  const aliases = {
    fenetre: ['fenetre', 'vitre', 'vitres', 'vitrage', 'vitrages'],
    store: ['store', 'stores'],
    plinthes: ['plinthe', 'plinthes'],
    porte: ['porte'],
    evier: ['evier'],
    miroir: ['miroir']
  };
  for (const element of elements) {
    const normalizedElement = normalize(element);
    const candidates = aliases[normalizedElement] || [normalizedElement];
    if (candidates.some(candidate =>
      new RegExp(`(^|[^a-z0-9])${candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i')
        .test(normalizedClause)
    )) {
      return element;
    }
  }
  return null;
}

function findReferenceCondition(clause) {
  const normalized = String(clause).normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('fr-FR');
  const conditions = [
    [/\b(quasi\s+(?:neuf|neuve|neufs|neuves))\b/, () => 'Quasi neuf'],
    [/\b(tres\s+bon\s+etat)\b/, () => 'Très bon état'],
    [/\b(bon\s+etat)\b/, () => 'Bon état'],
    [/\b(etat\s+moyen)\b/, () => 'État moyen'],
    [/\b(mauvais\s+etat)\b/, () => 'Mauvais état'],
    [/\b(a\s+verifier)\b/, () => 'À vérifier'],
    [/\b(casse(?:e|s|es)?)\b/, () => 'Cassé(e)'],
    [/\b(defectueux|defectueuse|defectueuses)\b/, () => 'Défectueux']
  ];
  for (const [pattern, format] of conditions) {
    const match = normalized.match(pattern);
    if (match) return format(match);
  }
  if (/^\s*neuf(?:ve)?s?\s*$/.test(normalized)) return 'Neuf';
  return '';
}

function isRoomWideCondition(clause, condition) {
  const normalized = String(clause).normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('fr-FR').trim();
  const normalizedCondition = String(condition).normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('fr-FR');
  return normalized === normalizedCondition ||
    /^quasi\s+neuf(?:s)?$/.test(normalized) ||
    /^quasi\s+neuve(?:s)?$/.test(normalized) ||
    normalized === 'neuf' ||
    normalized === 'neuve';
}

/**
 * Trouve l'élément le plus pertinent pour un défaut donné
 */
function findBestElementMatch(defautDescription, elements) {
  const defautLower = defautDescription.toLowerCase();
  
  // Mots-clés pour chaque élément
  const elementKeywords = {
    'lit': ['lit', 'matelas', 'sommiers', 'couverture', 'oreiller'],
    'bureau': ['bureau', 'table', 'plan de travail'],
    'chaise': ['chaise', 'siège', 'tabouret'],
    'armoire': ['armoire', 'placard', 'penderie'],
    'canapé': ['canapé', 'sofa', 'fauteuil'],
    'évier': ['évier', 'lavabo', 'robinet'],
    'wc': ['wc', 'toilette', 'cuvette'],
    'douche': ['douche', 'cabine', 'pommeau'],
    'four': ['four', 'micro-onde'],
    'réfrigérateur': ['réfrigérateur', 'frigo'],
    'lavabo': ['lavabo', 'évier'],
    'mirror': ['miroir', 'glace'],
    'mur': ['mur', 'peinture', 'trou'],
    'sol': ['sol', 'parquet', 'carrelage', 'tapis'],
    'fenêtre': ['fenêtre', 'vitre', 'volet'],
    'porte': ['porte', 'serrure', 'poignée']
  };
  
  // Pour chaque élément, vérifier si le défaut correspond
  for (const element of elements) {
    const elementLower = element.toLowerCase();
    
    // Vérifier les mots-clés
    const keywords = elementKeywords[elementLower] || [];
    for (const keyword of keywords) {
      if (defautLower.includes(keyword)) {
        return element;
      }
    }
    
    // Vérification directe
    if (defautLower.includes(elementLower)) {
      return element;
    }
  }
  
  return null;
}

/**
 * Affiche la liste des photos par pièce pour vérification
 */
function displayPhotosByPiece(photos) {
  const photosByPiece = {};
  
  for (const photo of photos) {
    const piece = photo.piece || 'indetermine';
    
    if (!photosByPiece[piece]) {
      photosByPiece[piece] = [];
    }
    photosByPiece[piece].push(photo.fichier);
  }
  
  for (const [piece, files] of Object.entries(photosByPiece)) {
    console.log(`  ${piece}: ${files.join(', ')}`);
  }
}

/**
 * Affiche les défauts injectés
 */
function displayInjectedDefauts(etat_usure) {
  let hasDefauts = false;
  
  for (const [piece, elements] of Object.entries(etat_usure)) {
    for (const [element, state] of Object.entries(elements)) {
      const observation = state[1];
      if (observation && observation.includes('(photo annexe')) {
        if (!hasDefauts) {
          console.log('');
          hasDefauts = true;
        }
        console.log(`  - ${piece} > ${element}: ${observation}`);
      }
    }
  }
  
  if (!hasDefauts) {
    console.log('  Aucun défaut injecté.');
  }
}

export default { newCommand };
