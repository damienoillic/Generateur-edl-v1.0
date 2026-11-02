/**
 * Module analyze - Analyse des photos via API Mistral Vision
 * 
 * Utilise le SDK @mistralai/mistralai pour analyser chaque photo
 * et retourner : pièce, défauts visibles et légende
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_IMAGES_PER_REQUEST = 8;
const MODEL = 'pixtral-12b';
const PROMPT_VERSION = 5;
const DEFAULT_RETRIES = 1;

// Prompt d'analyse détaillé (pour les EDL de sortie)
const DETAILED_ANALYSIS_PROMPT = `
Analyse ces photos pour un état des lieux de SORTIE d'un appartement en colocation.
Pour chaque image, classe la pièce et relève avec précision tous les défauts et dommages visibles, y compris les dégradations mineures et les traces d'usure. Localise chaque défaut sur l'élément concerné et décris uniquement ce qui est visible, sans rien supposer.
Pièces : chambre, salon, cuisine, salle-deau-1, salle-deau-2, toilettes, couloirs, entree, sejour-cuisine, salle-de-bains-wc, indetermine.
Réponds uniquement en JSON valide, avec exactement une entrée par image :
{
  "analyses": [
    {
      "fichier": "nom exact du fichier indiqué avant l'image",
      "piece": "une des pièces possibles, ou 'indetermine'",
      "type_vue": "vue_ensemble|detail_defaut|autre",
      "pertinence": 0,
      "score_qualite": 0,
      "defauts": [{"description": "...", "gravite": "faible|moyenne|forte"}],
      "legende_suggeree": "description courte en français (12 mots maximum)"
    }
  ]
}
Utilise la gravité "faible", "moyenne" ou "forte" selon l'importance du défaut. Si aucun défaut n'est visible, utilise "defauts": [].
La légende doit rester courte et descriptive ; elle peut mentionner les défauts visibles sans remplacer leur description détaillée dans "defauts".
Classe le cadrage : "vue_ensemble" pour situer la pièce, "detail_defaut" pour montrer un défaut précis, sinon "autre".
Évalue pertinence et score_qualite de 0 à 100 : pertinence pour documenter cet EDL, qualité pour la lisibilité et l'utilité de la photo.`;

// Prompt d'analyse rapide (pour les EDL d'entrée)
const QUICK_ANALYSIS_PROMPT = `
Analyse ces photos pour un état des lieux d'ENTRÉE d'un appartement en colocation.
Pour chaque image, classe la pièce et relève uniquement les problèmes majeurs, évidents et visibles, susceptibles d'affecter l'usage ou de constituer un dommage important (par exemple : élément cassé, manquant ou inutilisable, très grande salissure, dégât des eaux ou fissure importante).
Ne mentionne pas l'usure normale, les petites rayures, les marques légères, les défauts mineurs ni les variations esthétiques. Pour un EDL d'entrée, les défauts retenus doivent avoir la gravité "forte" ; ignore tout défaut faible ou moyen.
Pièces : chambre, salon, cuisine, salle-deau-1, salle-deau-2, toilettes, couloirs, entree, sejour-cuisine, salle-de-bains-wc, indetermine.
Réponds uniquement en JSON valide, avec exactement une entrée par image :
{
  "analyses": [
    {
      "fichier": "nom exact du fichier indiqué avant l'image",
      "piece": "une des pièces possibles, ou 'indetermine'",
      "type_vue": "vue_ensemble|detail_defaut|autre",
      "pertinence": 0,
      "score_qualite": 0,
      "defauts": [{"description": "...", "gravite": "faible|moyenne|forte"}],
      "legende_suggeree": "description courte en français (12 mots maximum)"
    }
  ]
}
Si aucun défaut majeur n'est visible, utilise "defauts": [].
La légende doit rester une description neutre de la vue, sauf si un problème majeur retenu doit être signalé.
Classe le cadrage : "vue_ensemble" pour situer la pièce, "detail_defaut" pour montrer un défaut précis, sinon "autre".
Évalue pertinence et score_qualite de 0 à 100 : pertinence pour documenter cet EDL, qualité pour la lisibilité et l'utilité de la photo.`;

/**
 * Charge le SDK Mistral
 */
async function getMistralClient() {
  try {
    if (!process.env.MISTRAL_API_KEY) {
      throw new Error('MISTRAL_API_KEY n’est pas configurée dans .env ou dans les variables d’environnement.');
    }

    const { Mistral } = await import('@mistralai/mistralai');
    
    // Charger la clé API depuis .env ou variable d'environnement
    const client = new Mistral({ 
      apiKey: process.env.MISTRAL_API_KEY 
    });
    
    return client;
  } catch (error) {
    throw new Error(`Impossible de charger le SDK Mistral: ${error.message}`);
  }
}

/**
 * Analyse une photo via l'API Vision
 * @param {string} imagePath - Chemin de l'image
 * @param {object} client - Client Mistral
 * @param {string} edlType - Type d'EDL ('entree' ou 'sortie')
 * @returns {Promise<object>} Résultat de l'analyse
 */
async function analyzePhotoBatch(photos, client, edlType = 'entree', retries = DEFAULT_RETRIES, retryDelayMs = 1000) {
  const prompt = edlType === 'sortie' ? DETAILED_ANALYSIS_PROMPT : QUICK_ANALYSIS_PROMPT;
  const content = [{ type: 'text', text: prompt }];

  for (const photo of photos) {
    const imageData = await fs.readFile(photo.path);
    content.push(
      { type: 'text', text: `Nom exact du fichier : ${photo.filename}` },
      {
        type: 'image_url',
        imageUrl: `data:image/jpeg;base64,${imageData.toString('base64')}`
      }
    );
  }

  let response;
  try {
    response = await client.chat.complete({
      model: MODEL,
      messages: [{ role: 'user', content }],
      temperature: 0,
      responseFormat: { type: 'json_object' }
    });
  } catch (error) {
    if (retries > 0 && isRetryableApiError(error)) {
      console.warn(`Erreur temporaire d'analyse, nouvelle tentative: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      return analyzePhotoBatch(photos, client, edlType, retries - 1, retryDelayMs * 2);
    }

    const status = error.statusCode ?? error.status ?? error.rawResponse?.status;
    if (status === 402 || String(error.message).includes('budget exhausted')) {
      throw new Error(`Crédit d’API Mistral / Vibe épuisé (budget exhausted / code 402). Vous pouvez continuer avec l'analyse manuelle par lots.`);
    }

    throw new Error(`Échec de l'analyse du lot: ${error.message}`);
  }

  let result;
  try {
    result = JSON.parse(response.choices[0].message.content);
  } catch (error) {
    throw new Error(`Réponse JSON invalide de l'API: ${error.message}`);
  }

  if (!result || !Array.isArray(result.analyses)) {
    throw new Error('Réponse invalide de l’API: le tableau "analyses" est absent.');
  }

  return result.analyses;
}

function isRetryableApiError(error) {
  const status = error.statusCode ?? error.status ?? error.rawResponse?.status;
  if (status !== undefined) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }

  return [
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'EAI_AGAIN',
    'ENOTFOUND',
    'UND_ERR_CONNECT_TIMEOUT'
  ].includes(error.code);
}

async function analyzePhoto(imagePath, client, edlType = 'entree', retries = DEFAULT_RETRIES) {
  const [analysis] = await analyzePhotoBatch([{
    filename: path.basename(imagePath),
    path: imagePath
  }], client, edlType, retries);
  return analysis;
}

/**
 * Analyse toutes les photos d'un dossier
 * @param {string} photosDir - Dossier contenant les photos
 * @param {string} outputPath - Chemin pour sauvegarder analysis.json
 * @param {string} edlType - Type d'EDL ('entree' ou 'sortie')
 * @returns {Promise<Array>} Tableau des résultats d'analyse
 */
async function analyzeAllPhotos(photosDir, outputPath = null, edlType = 'entree', options = {}) {
  // Lister les fichiers
  const files = (await fs.readdir(photosDir)).sort();
  const imageFiles = files.filter(file => {
    const ext = path.extname(file).toLowerCase();
    return ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'].includes(ext);
  });
  
  if (imageFiles.length === 0) {
    console.warn(`Aucune image trouvée dans ${photosDir}`);
    return [];
  }
  
  const cachePath = options.cachePath || path.join(path.dirname(outputPath || photosDir), 'analysis-cache.json');
  const cache = await loadAnalysisCache(cachePath);
  const photoRecords = [];
  const uniquePhotos = new Map();

  for (const filename of imageFiles) {
    const photoPath = path.join(photosDir, filename);
    const imageData = await fs.readFile(photoPath);
    const imageHash = crypto.createHash('sha256').update(imageData).digest('hex');
    const cacheKey = createCacheKey(imageHash, edlType);
    const record = { filename, path: photoPath, imageHash, cacheKey };
    photoRecords.push(record);
    if (!uniquePhotos.has(cacheKey)) uniquePhotos.set(cacheKey, record);
  }

  const pendingPhotos = [...uniquePhotos.values()].filter(photo => !cache.entries[photo.cacheKey]);
  const batchCount = Math.ceil(pendingPhotos.length / MAX_IMAGES_PER_REQUEST);
  console.log(`Analyse de ${imageFiles.length} photos (${pendingPhotos.length} nouvelle(s), doublons et analyses déjà en cache exclus) en ${batchCount} requête(s) maximum...`);

  const client = pendingPhotos.length > 0 ? (options.client || await getMistralClient()) : null;
  const results = [];

  for (let start = 0; start < pendingPhotos.length; start += MAX_IMAGES_PER_REQUEST) {
    const batch = pendingPhotos.slice(start, start + MAX_IMAGES_PER_REQUEST);
    console.log(`  Requête ${Math.floor(start / MAX_IMAGES_PER_REQUEST) + 1}/${batchCount}: ${batch.length} photo(s)...`);
    const analyses = await analyzePhotoBatch(batch, client, edlType);
    const analysesByFilename = new Map(analyses
      .filter(analysis => typeof analysis?.fichier === 'string')
      .map(analysis => [analysis.fichier.toLowerCase(), analysis]));

    for (const [batchIndex, photo] of batch.entries()) {
      let analysis = analysesByFilename.get(photo.filename.toLowerCase());
      if (!analysis && analyses.length === batch.length) {
        // Repli tolérant si le modèle Vision a légèrement altéré le nom de fichier
        analysis = analyses[batchIndex];
      }
      if (!analysis) {
        throw new Error(`La réponse de l'API ne contient pas d'analyse pour ${photo.filename}.`);
      }
      cache.entries[photo.cacheKey] = normalizeAnalysis(photo.filename, analysis);
    }

    await saveAnalysisCache(cachePath, cache);
  }

  for (const photo of photoRecords) {
    const cached = cache.entries[photo.cacheKey];
    if (!cached) throw new Error(`Aucune analyse disponible pour ${photo.filename}.`);
    const normalized = normalizeAnalysis(photo.filename, cached);
    results.push(normalized);
    console.log(`  ✓ ${photo.filename}: ${normalized.piece} - ${normalized.legende_suggeree}`);
  }

  // Sauvegarder le fichier analysis.json
  if (outputPath) {
    await fs.writeFile(outputPath, JSON.stringify(results, null, 2), 'utf8');
    await fs.writeFile(`${outputPath}.meta.json`, JSON.stringify({
      version: PROMPT_VERSION,
      model: MODEL,
      edlType,
      photos: photoRecords.map(({ filename, imageHash }) => ({ filename, imageHash }))
    }, null, 2), 'utf8');
    console.log(`\n✅ Analyse sauvegardée: ${outputPath}`);
  }
  
  return results;
}

function normalizeAnalysis(filename, analysis = {}) {
  return {
    fichier: filename,
    piece: typeof analysis.piece === 'string' ? analysis.piece.toLowerCase() : 'indetermine',
    elements_visibles: Array.isArray(analysis.elements_visibles) ? analysis.elements_visibles : [],
    defauts: Array.isArray(analysis.defauts) ? analysis.defauts : [],
    legende_suggeree: typeof analysis.legende_suggeree === 'string' ? analysis.legende_suggeree : '',
    type_vue: typeof analysis.type_vue === 'string' ? analysis.type_vue : 'autre',
    pertinence: typeof analysis.pertinence === 'number' ? analysis.pertinence : 0,
    score_qualite: typeof analysis.score_qualite === 'number' ? analysis.score_qualite : 0
  };
}

function createCacheKey(imageHash, edlType) {
  return `${MODEL}:${PROMPT_VERSION}:${edlType}:${imageHash}`;
}

async function loadAnalysisCache(cachePath) {
  try {
    const cache = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    if (
      cache.version === 1 &&
      cache.entries &&
      typeof cache.entries === 'object' &&
      !Array.isArray(cache.entries)
    ) return cache;
    console.warn(`Cache d'analyse incompatible, il sera reconstruit: ${cachePath}`);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`Cache d'analyse illisible, il sera reconstruit: ${error.message}`);
    }
  }
  return { version: 1, entries: {} };
}

async function saveAnalysisCache(cachePath, cache) {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  const temporaryPath = `${cachePath}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(cache, null, 2), 'utf8');
  await fs.rename(temporaryPath, cachePath);
}

async function isAnalysisCurrent(photosDir, analysisPath, edlType) {
  let metadata;
  let analyses;
  try {
    [metadata, analyses] = await Promise.all([
      fs.readFile(`${analysisPath}.meta.json`, 'utf8').then(JSON.parse),
      fs.readFile(analysisPath, 'utf8').then(JSON.parse)
    ]);
  } catch {
    return false;
  }

  if (
    metadata.version !== PROMPT_VERSION ||
    metadata.model !== MODEL ||
    metadata.edlType !== edlType ||
    !Array.isArray(metadata.photos) ||
    !Array.isArray(analyses)
  ) return false;

  const files = (await fs.readdir(photosDir)).filter(file =>
    ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'].includes(path.extname(file).toLowerCase())
  ).sort();
  if (files.length !== metadata.photos.length || files.length !== analyses.length) return false;

  const metadataByName = new Map(metadata.photos.map(photo => [photo.filename.toLowerCase(), photo]));
  const analysesByName = new Set(analyses.map(analysis => analysis?.fichier?.toLowerCase()));
  for (const filename of files) {
    const stored = metadataByName.get(filename.toLowerCase());
    if (!stored || !analysesByName.has(filename.toLowerCase())) return false;
    const imageData = await fs.readFile(path.join(photosDir, filename));
    const imageHash = crypto.createHash('sha256').update(imageData).digest('hex');
    if (stored.imageHash !== imageHash) return false;
  }
  return true;
}

/**
 * Vérifie si l'API Mistral est configurée
 */
function isMistralConfigured() {
  return !!(process.env.MISTRAL_API_KEY);
}

export {
  analyzePhoto,
  analyzeAllPhotos,
  analyzePhotoBatch,
  isAnalysisCurrent,
  isMistralConfigured,
  DETAILED_ANALYSIS_PROMPT,
  QUICK_ANALYSIS_PROMPT,
  MAX_IMAGES_PER_REQUEST
};

export default {
  analyzePhoto,
  analyzeAllPhotos,
  analyzePhotoBatch,
  isAnalysisCurrent,
  isMistralConfigured,
  DETAILED_ANALYSIS_PROMPT,
  QUICK_ANALYSIS_PROMPT,
  MAX_IMAGES_PER_REQUEST
};
