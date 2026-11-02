/**
 * Module context-generator - Génère le contexte d'un EDL depuis la source de référence Google Drive.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { ensureEdlContext, getTenantReference } from './edl-context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(__dirname);
const DEFAULT_VIBE_CONTEXT_PATH = path.join(projectRoot, 'data', 'vibe-context.json');

/**
 * Charge tous les EDL existants
 */
async function loadExistingEDLs() {
  const edlDir = path.join(projectRoot, 'data', 'edl');
  
  try {
    const files = await fs.readdir(edlDir);
    const edls = [];
    
    for (const file of files) {
      if (file.startsWith('draft-')) continue;
      
      const filePath = path.join(edlDir, file);
      try {
        const content = await fs.readFile(filePath, 'utf8');
        const edl = JSON.parse(content);
        edls.push(edl);
      } catch (err) {
        console.warn(`Avertissement lecture EDL ${file}: ${err.message}`);
      }
    }
    
    return edls;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Cherche un EDL d'entrée pour un locataire
 */
async function findEntranceEDL(locataireNom) {
  const edls = await loadExistingEDLs();
  return edls.find(edl => 
    edl.type === 'entree' && 
    edl.locataire?.nom?.toLowerCase().includes(locataireNom.toLowerCase())
  );
}

/**
 * Cherche tous les EDL pour un locataire
 */
async function findAllEDLsForLocataire(locataireNom) {
  const edls = await loadExistingEDLs();
  return edls.filter(edl => 
    edl.locataire?.nom?.toLowerCase().includes(locataireNom.toLowerCase())
  );
}

/**
 * Suggère le type d'EDL (entrée ou sortie)
 */
async function suggestTypeForLocataire(
  locataireNom,
  vibeContextPath = DEFAULT_VIBE_CONTEXT_PATH,
  edlContextData
) {
  const edlContext = edlContextData || await ensureEdlContext(locataireNom);
  const reference = getTenantReference(edlContext, locataireNom);
  const referenceType = getNextTypeFromReference(edlContext, reference);
  if (referenceType) return referenceType;
  const resolvedName = reference.tenant.nom;
  const entranceEDL = await findEntranceEDL(resolvedName);
  const allEDLs = await findAllEDLsForLocataire(resolvedName);
  return determineType(entranceEDL, allEDLs);
}

/**
 * Génère le contexte pour un locataire à partir de Google Drive
 */
async function generateContext(locataireNom, options = {}) {
  const {
    date = new Date().toISOString().split('T')[0],
    promptForMissingContact = false,
    requireConfirmedContact = false,
    allowMissingContext = false,
    edlContextData,
    vibeContextData
  } = options;

  const edlContext = edlContextData || await ensureEdlContext(locataireNom);
  const reference = getTenantReference(edlContext, locataireNom);
  const providedLocataire = vibeContextData === undefined
    ? null
    : findVibeLocataire(validateVibeContext(vibeContextData), locataireNom);

  const locataire = {
    nom: reference.nom,
    email: reference.email,
    telephone: reference.telephone || providedLocataire?.telephone || '',
    chambre: reference.chambre,
    lot: reference.lot
  };
  const adresseBien = reference.adresseBien;

  if (!allowMissingContext) {
    const missingFields = [];
    if (!locataire.chambre) missingFields.push('description de la chambre');
    if (!locataire.lot) missingFields.push('lot');
    if (!adresseBien) missingFields.push('adresse du logement');
    if (missingFields.length > 0) {
      throw new Error(
        `Informations manquantes dans le contexte du locataire pour "${locataire.nom}": ${missingFields.join(', ')}. Demandez à Vibe de compléter le contexte.`
      );
    }
  }

  if (promptForMissingContact) await completeContactInfo(locataire);
  if (requireConfirmedContact) assertConfirmedContact(locataire);

  const referenceType = getNextTypeFromReference(edlContext, reference);
  const localHistory = await findAllEDLsForLocataire(reference.tenant.nom);
  const localEntrance = await findEntranceEDL(reference.tenant.nom);

  return {
    context: {
      locataire,
      bien: reference.bien,
      bienData: reference.bienData,
      adresseBien,
      type: referenceType || determineType(localEntrance, localHistory),
      date,
      bailleur: reference.bailleur,
      referenceDernierEdl: reference.referenceDernierEdl
    }
  };
}

function getNextTypeFromReference(edlContext, reference) {
  const normalize = value => String(value || '').normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
  const last = edlContext.dernier_edl_connu;
  if (!last?.locataire || (
    normalize(last.locataire) !== normalize(reference.nom) &&
    normalize(last.locataire) !== normalize(reference.tenant.nom)
  )) {
    return null;
  }

  const previousType = last.type.toLowerCase();
  if (previousType.includes('entrée') || previousType.includes('entree')) return 'sortie';
  if (previousType.includes('sortie')) return 'entree';
  return null;
}

function assertConfirmedContact(locataire) {
  const missing = [];
  if (!isUsableEmail(locataire.email)) missing.push('email confirmé');
  if (typeof locataire.telephone !== 'string' || !locataire.telephone.trim()) {
    missing.push('téléphone confirmé');
  }
  if (missing.length > 0) {
    throw new Error(
      `Coordonnées manquantes ou non valides pour "${locataire.nom}": ${missing.join(', ')}. Faites compléter le contexte du locataire sur Google Drive ou transmettez ces valeurs confirmées via le connecteur MCP.`
    );
  }
}

function isUsableEmail(email) {
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return false;
  const domain = email.split('@')[1].toLowerCase();
  return domain !== 'example.com' && !['example', 'invalid', 'test'].some(tld => domain.endsWith(`.${tld}`));
}

async function completeContactInfo(locataire) {
  const rl = readline.createInterface({ input, output });
  try {
    if (!isUsableEmail(locataire.email)) {
      let email = '';
      while (!isUsableEmail(email)) {
        email = (await rl.question(`  Email réel de ${locataire.nom}: `)).trim();
        if (!isUsableEmail(email)) console.log('  ❌ Saisissez une adresse email valide (pas une adresse d’exemple).');
      }
      locataire.email = email;
    }

    if (typeof locataire.telephone !== 'string' || !locataire.telephone.trim()) {
      let telephone = '';
      while (!telephone) {
        telephone = (await rl.question(`  Téléphone de ${locataire.nom}: `)).trim();
        if (!telephone) console.log('  ❌ Le numéro de téléphone est requis.');
      }
      locataire.telephone = telephone;
    }
  } finally {
    rl.close();
  }
}

async function loadVibeContext(contextPath = DEFAULT_VIBE_CONTEXT_PATH) {
  try {
    const context = JSON.parse(await fs.readFile(contextPath, 'utf8'));
    return validateVibeContext(context);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Impossible de lire le contexte Vibe (${contextPath}): ${error.message}`);
  }
}

function validateVibeContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    throw new Error('La racine du contexte Vibe doit être un objet JSON.');
  }
  return context;
}

function findVibeLocataire(context, searchName) {
  if (!context.locataires || typeof context.locataires !== 'object') return null;
  const entries = Array.isArray(context.locataires)
    ? context.locataires
    : Object.entries(context.locataires || {}).map(([nom, info]) => ({ nom, ...info }));
  const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
  const query = normalize(searchName);
  if (!query) return null;
  const exact = entries.filter(entry => typeof entry?.nom === 'string' && normalize(entry.nom) === query);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new Error(`Plusieurs locataires correspondent exactement à "${searchName}" dans le contexte Vibe.`);
  }

  const partial = entries.filter(entry =>
    typeof entry?.nom === 'string' &&
    (normalize(entry.nom).includes(query) || query.includes(normalize(entry.nom)))
  );
  if (partial.length > 1) {
    throw new Error(`Le nom "${searchName}" correspond à plusieurs locataires du contexte Vibe. Saisissez leur nom complet.`);
  }
  return partial[0] || null;
}

/**
 * Détermine le type d'EDL en fonction des EDL existants
 */
function determineType(entranceEDL, allEDLs) {
  if (entranceEDL) return 'sortie';
  if (allEDLs.length > 0) {
    const lastEDL = allEDLs[allEDLs.length - 1];
    if (lastEDL.type === 'sortie') return 'entree';
    return 'entree';
  }
  return 'entree';
}

/**
 * Sauvegarde le contexte dans un fichier
 */
async function saveContext(contextData, outputPath = null) {
  const filePath = outputPath || path.join(projectRoot, 'context.json');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(contextData, null, 2), 'utf8');
  return filePath;
}

/**
 * Génère et sauvegarde le contexte
 */
async function generateAndSaveContext(locataireNom, options = {}) {
  const context = await generateContext(locataireNom, options);
  const contextPath = await saveContext(context);
  return { context, contextPath };
}

export { 
  generateContext,
  generateAndSaveContext,
  findEntranceEDL,
  findAllEDLsForLocataire,
  suggestTypeForLocataire,
  loadExistingEDLs,
  determineType,
  saveContext,
  loadVibeContext,
  findVibeLocataire
};

export default {
  generateContext,
  generateAndSaveContext
};

