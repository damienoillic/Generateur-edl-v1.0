import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(__dirname);
export const EDL_CONTEXT_INDEX_URL = 'https://drive.google.com/uc?export=download&id=YOUR_DRIVE_ID_HERE';
export const EDL_CONTEXT_DIRECTORY = path.join(projectRoot, 'context');
export const EDL_SYNCED_DRIVE_DIRECTORY = String.raw`G:\Mon Drive\EDL tool`;
const DEFAULT_CONFIG_PATH = path.join(projectRoot, 'config.json');
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_CONTEXT_SIZE = 5 * 1024 * 1024;
const GOOGLE_DRIVE_HOSTS = new Set(['drive.google.com', 'drive.usercontent.google.com']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleUpperCase('fr-FR');
}

export function normalizeTenantFamily(value) {
  const normalized = normalizeText(value);
  if (!normalized || /[<>/\\:*?"|]/.test(normalized) || normalized === '.' || normalized === '..') {
    throw new Error('Le nom de famille du locataire est absent ou invalide.');
  }
  return normalized;
}

function requireRecord(parent, key, pathName) {
  if (!isRecord(parent[key])) {
    throw new Error(`Contexte locataire invalide : "${pathName}" doit être un objet.`);
  }
}

function requireString(parent, key, pathName) {
  if (
    typeof parent[key] !== 'string' ||
    parent[key].trim() === '' ||
    /<[^>]+>|\bXX\b/i.test(parent[key])
  ) {
    throw new Error(`Contexte locataire invalide : "${pathName}" doit être une chaîne renseignée.`);
  }
}

function requireDate(value, pathName) {
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const french = /^\d{2}\/\d{2}\/\d{4}$/.test(value);
  if (!iso && !french) {
    throw new Error(`Contexte locataire invalide : "${pathName}" doit être une date réelle.`);
  }
  const [year, month, day] = iso
    ? value.split('-').map(Number)
    : value.split('/').reverse().map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`Contexte locataire invalide : "${pathName}" doit être une date réelle.`);
  }
}

function requireEmail(parent, key, pathName) {
  requireString(parent, key, pathName);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parent[key])) {
    throw new Error(`Contexte locataire invalide : "${pathName}" doit être une adresse email valide.`);
  }
}

export function validateEdlContextIndex(index) {
  if (!isRecord(index) || !Array.isArray(index.locataires)) {
    throw new Error('Index EDL invalide : "locataires" doit être un tableau.');
  }
  for (const [position, route] of index.locataires.entries()) {
    const pathName = `locataires[${position}]`;
    if (!isRecord(route)) {
      throw new Error(`Index EDL invalide : "${pathName}" doit être un objet.`);
    }
    requireString(route, 'nom_famille', `${pathName}.nom_famille`);
    requireString(route, 'fichier', `${pathName}.fichier`);
    requireString(route, 'drive_id', `${pathName}.drive_id`);
    requireString(route, 'download_url', `${pathName}.download_url`);
    if (
      path.basename(route.fichier) !== route.fichier ||
      path.extname(route.fichier).toLowerCase() !== '.json'
    ) {
      throw new Error(`Index EDL invalide : "${pathName}.fichier" doit être un nom de fichier JSON sans chemin.`);
    }
    let downloadUrl;
    try {
      downloadUrl = new URL(route.download_url);
    } catch {
      throw new Error(`Index EDL invalide : "${pathName}.download_url" doit être une URL.`);
    }
    if (downloadUrl.protocol !== 'https:' || !GOOGLE_DRIVE_HOSTS.has(downloadUrl.hostname)) {
      throw new Error(`Index EDL invalide : "${pathName}.download_url" doit pointer vers Google Drive en HTTPS.`);
    }
  }
  return index;
}

export function validateEdlContext(context) {
  if (!isRecord(context)) {
    throw new Error('Contexte locataire invalide : la racine doit être un objet JSON.');
  }
  requireRecord(context, 'bailleur', 'bailleur');
  for (const field of ['nom', 'adresse', 'telephone', 'email']) {
    requireString(context.bailleur, field, `bailleur.${field}`);
  }
  requireEmail(context.bailleur, 'email', 'bailleur.email');

  requireRecord(context, 'bien', 'bien');
  for (const field of ['type', 'adresse']) {
    requireString(context.bien, field, `bien.${field}`);
  }
  const legacyPropertySchema = isRecord(context.bien.lots);
  if (legacyPropertySchema) {
    const lot = String(context.locataire?.lot || '').trim().replace(/^#/, '');
    if (typeof context.bien.lots[lot] !== 'string' || !context.bien.lots[lot].trim()) {
      throw new Error(`Contexte locataire invalide : l’adresse du lot "${lot}" est absente de "bien.lots".`);
    }
    requireString(context, 'formulation_chambre_standard', 'formulation_chambre_standard');
  } else {
    requireString(context.bien, 'lot', 'bien.lot');
    requireString(context.bien, 'formulation_lot', 'bien.formulation_lot');
  }
  requireRecord(context, 'locataire', 'locataire');
  for (const field of ['nom', 'email', 'lot']) {
    requireString(context.locataire, field, `locataire.${field}`);
  }
  requireEmail(context.locataire, 'email', 'locataire.email');
  if (!legacyPropertySchema && context.bien.lot.trim().replace(/^#/, '') !== context.locataire.lot.trim().replace(/^#/, '')) {
    throw new Error('Contexte locataire invalide : "bien.lot" ne correspond pas à "locataire.lot".');
  }
  if (context.dernier_edl_connu !== null) {
    requireRecord(context, 'dernier_edl_connu', 'dernier_edl_connu');
    const previous = context.dernier_edl_connu;
    requireString(previous, 'type', 'dernier_edl_connu.type');
    if (previous.locataire !== undefined) requireString(previous, 'locataire', 'dernier_edl_connu.locataire');
    if (
      previous.date !== undefined &&
      previous.date !== null &&
      !(typeof previous.date === 'string' && previous.date.trim() === '')
    ) {
      requireString(previous, 'date', 'dernier_edl_connu.date');
      requireDate(previous.date, 'dernier_edl_connu.date');
    }
    if (Array.isArray(previous.pieces)) {
      for (const [position, room] of previous.pieces.entries()) {
        if (!isRecord(room)) {
          throw new Error(`Contexte locataire invalide : dernier_edl_connu.pieces[${position}] doit être un objet.`);
        }
        requireString(room, 'piece', `dernier_edl_connu.pieces[${position}].piece`);
        if (!Array.isArray(room.elements) || room.elements.length === 0) {
          throw new Error(`Contexte locataire invalide : dernier_edl_connu.pieces[${position}].elements doit être un tableau non vide.`);
        }
        for (const [elementPosition, item] of room.elements.entries()) {
          if (!isRecord(item)) {
            throw new Error(`Contexte locataire invalide : dernier_edl_connu.pieces[${position}].elements[${elementPosition}] doit être un objet.`);
          }
          requireString(item, 'element', `dernier_edl_connu.pieces[${position}].elements[${elementPosition}].element`);
          requireString(item, 'etat', `dernier_edl_connu.pieces[${position}].elements[${elementPosition}].etat`);
          if (item.observation !== undefined && typeof item.observation !== 'string') {
            throw new Error(`Contexte locataire invalide : observation de l’élément ${item.element} doit être une chaîne.`);
          }
        }
      }
    } else if (
      previous.pieces !== undefined ||
      !Array.isArray(previous.chambres_13m2) &&
      !Array.isArray(previous.chambre_13m2) &&
      !Array.isArray(previous.chambre)
    ) {
      throw new Error('Contexte locataire invalide : dernier_edl_connu doit contenir "pieces", "chambre", "chambres_13m2" ou "chambre_13m2" sous forme de tableau.');
    }
    const roomItems = previous.chambres_13m2 ?? previous.chambre_13m2 ?? previous.chambre ?? [];
    for (const [position, item] of roomItems.entries()) {
      if (!isRecord(item)) {
        throw new Error(`Contexte locataire invalide : chambre[${position}] doit être un objet.`);
      }
      requireString(item, 'element', `chambres_13m2[${position}].element`);
      requireString(item, 'etat', `chambres_13m2[${position}].etat`);
    }
    if (previous.parties_communes !== undefined) {
      requireRecord(previous, 'parties_communes', 'dernier_edl_connu.parties_communes');
    }
    if (previous.defauts_documentes !== undefined && !Array.isArray(previous.defauts_documentes)) {
      throw new Error('Contexte locataire invalide : "dernier_edl_connu.defauts_documentes" doit être un tableau.');
    }
    if (previous.cles_remises !== undefined && !Array.isArray(previous.cles_remises)) {
      throw new Error('Contexte locataire invalide : "dernier_edl_connu.cles_remises" doit être un tableau.');
    }
    for (const [position, key] of (previous.cles_remises || []).entries()) {
      if (!isRecord(key) || typeof key.nombre !== 'number' || !Number.isInteger(key.nombre) || key.nombre < 0) {
        throw new Error(`Contexte locataire invalide : cles_remises[${position}] doit contenir un nombre entier positif.`);
      }
      requireString(key, 'type', `cles_remises[${position}].type`);
      if (key.date !== undefined) {
        requireString(key, 'date', `cles_remises[${position}].date`);
        requireDate(key.date, `cles_remises[${position}].date`);
      }
    }
    if (!Array.isArray(previous.champs_a_completer) && !Array.isArray(previous.champs_a_completer_par_damien) &&
      !Array.isArray(context.donnees_manquantes_ou_ambigues)) {
      throw new Error('Contexte locataire invalide : "dernier_edl_connu.champs_a_completer" doit être un tableau.');
    }
  }
  if (!Array.isArray(context.regles_generation) || context.regles_generation.length === 0) {
    throw new Error('Contexte locataire invalide : "regles_generation" doit être un tableau non vide.');
  }
  return context;
}

async function downloadJson(url, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'follow'
    });
    if (!response.ok) throw new Error(`Réponse HTTP ${response.status}`);
    const finalUrl = new URL(response.url || url);
    if (finalUrl.protocol !== 'https:' || !GOOGLE_DRIVE_HOSTS.has(finalUrl.hostname)) {
      throw new Error('La redirection Google Drive a abouti à une adresse inattendue.');
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_CONTEXT_SIZE) {
      throw new Error('Le fichier de contexte dépasse la taille maximale autorisée.');
    }
    const body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > MAX_CONTEXT_SIZE) {
      throw new Error('Le fichier de contexte dépasse la taille maximale autorisée.');
    }
    try {
      return JSON.parse(body);
    } catch (error) {
      throw new Error(`Le JSON téléchargé est invalide : ${error.message}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function writeJsonAtomically(filePath, data) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(temporaryPath, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

async function readOptionalJsonFile(filePath, label) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    try {
      return { data: JSON.parse(content), stats: await fs.stat(filePath) };
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`${label} invalide (${filePath}) : JSON mal formé.`);
      }
      throw error;
    }
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readLatestSyncedIndex(directory) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }

  const candidates = await Promise.all(
    entries
      .filter(entry => entry.isFile() && /^index(?:\s*\(\d+\))?\.json$/i.test(entry.name))
      .map(async entry => {
        const filePath = path.join(directory, entry.name);
        const file = await readOptionalJsonFile(filePath, 'Index synchronisé');
        return file ? { ...file, filePath } : null;
      })
  );
  const available = candidates.filter(Boolean);
  if (available.length === 0) return null;

  available.sort((left, right) => {
    const versionOrder = compareIndexVersions(right.data.version, left.data.version);
    return versionOrder || right.stats.mtimeMs - left.stats.mtimeMs;
  });
  return available[0];
}

async function readLatestSyncedContext(directory, filename) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }

  const parsed = path.parse(filename);
  const candidatePattern = new RegExp(
    `^${escapeRegExp(parsed.name)}(?:\\s*\\(\\d+\\))?${escapeRegExp(parsed.ext)}$`,
    'i'
  );
  const candidates = entries
    .filter(entry => entry.isFile() && candidatePattern.test(entry.name))
    .map(entry => path.join(directory, entry.name));
  const available = await Promise.all(candidates.map(async filePath => ({
    filePath,
    stats: await fs.stat(filePath)
  })));
  if (available.length === 0) return null;

  available.sort((left, right) => right.stats.mtimeMs - left.stats.mtimeMs);
  const latest = available[0];
  const file = await readOptionalJsonFile(latest.filePath, 'Contexte synchronisé');
  return file ? { ...file, filePath: latest.filePath } : null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compareIndexVersions(left, right) {
  const leftParts = typeof left === 'string' ? left.match(/\d+/g)?.map(Number) : null;
  const rightParts = typeof right === 'string' ? right.match(/\d+/g)?.map(Number) : null;
  if (!leftParts || !rightParts) return 0;

  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

async function loadConfiguredIndexUrl(configPath) {
  let config;
  try {
    config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return EDL_CONTEXT_INDEX_URL;
    throw new Error(`Configuration EDL illisible (${configPath}) : ${error.message}`);
  }
  if (!isRecord(config) || typeof config.index_url !== 'string' || !config.index_url.trim()) {
    throw new Error(`Configuration EDL invalide (${configPath}) : "index_url" doit être une URL Google Drive.`);
  }
  return config.index_url.trim();
}

function validateIndexUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('URL de l’index EDL invalide : fournissez une URL Google Drive HTTPS.');
  }
  if (url.protocol !== 'https:' || !GOOGLE_DRIVE_HOSTS.has(url.hostname)) {
    throw new Error('URL de l’index EDL invalide : fournissez une URL Google Drive HTTPS.');
  }
  return url.toString();
}

export function findTenantRoute(index, familyName) {
  const family = normalizeTenantFamily(familyName);
  const matches = index.locataires.filter(route => normalizeText(route.nom_famille) === family);
  if (matches.length > 1) {
    throw new Error(`L’index EDL contient plusieurs entrées pour "${family}". Faites corriger l’index par Vibe.`);
  }
  if (matches.length === 0) {
    throw new Error(`Locataire inconnu de l’index : "${family}". Vérifiez l’orthographe ou faites-le ajouter via l’assistant conversationnel Vibe.`);
  }
  return matches[0];
}

export function matchesTenantFamily(tenantName, familyName) {
  const tenant = ` ${normalizeText(tenantName)} `;
  const family = ` ${normalizeTenantFamily(familyName)} `;
  return tenant.includes(family);
}

export function matchesTenantIdentity(tenantName, tenant) {
  const actual = normalizeText(tenantName);
  if (!actual || !isRecord(tenant) || typeof tenant.nom !== 'string') return false;
  const candidates = [
    tenant.nom,
    [tenant.civilite, tenant.nom].filter(Boolean).join(' ')
  ];
  return candidates.some(candidate => normalizeText(candidate) === actual);
}

export async function ensureEdlContext(familyName, {
  indexUrl,
  configPath = DEFAULT_CONFIG_PATH,
  contextDirectory = EDL_CONTEXT_DIRECTORY,
  syncedDriveDirectory = EDL_SYNCED_DRIVE_DIRECTORY,
  fetchImpl = globalThis.fetch
} = {}) {
  const family = normalizeTenantFamily(familyName);
  const resolvedIndexUrl = validateIndexUrl(indexUrl || await loadConfiguredIndexUrl(configPath));
  let index;
  let indexError;
  try {
    index = validateEdlContextIndex(await downloadJson(resolvedIndexUrl, fetchImpl));
  } catch (error) {
    if (error.message.startsWith('Index EDL invalide') || error.message.startsWith('Le JSON téléchargé est invalide')) {
      throw error;
    }
    indexError = error;
  }

  let syncedIndex;
  let syncedIndexError;
  try {
    syncedIndex = await readLatestSyncedIndex(syncedDriveDirectory);
    if (syncedIndex) validateEdlContextIndex(syncedIndex.data);
  } catch (error) {
    syncedIndexError = error;
  }

  const localIndexPath = path.join(contextDirectory, 'index.json');
  if (index && syncedIndexError) {
    console.warn(`⚠️ Impossible de vérifier l’index synchronisé Google Drive : ${syncedIndexError.message}`);
  }
  if (!index) {
    if (syncedIndex) {
      index = validateEdlContextIndex(syncedIndex.data);
      console.warn(`⚠️ INDEX NON MIS À JOUR — version synchronisée ${syncedIndex.data.version || ''} du ${syncedIndex.stats.mtime.toLocaleDateString('fr-FR')} utilisée (${indexError.message}).`);
    } else {
      if (syncedIndexError) {
        throw new Error(`Index Google Drive synchronisé invalide : ${syncedIndexError.message}`);
      }
      const localIndex = await readOptionalJsonFile(localIndexPath, 'Index local');
      if (!localIndex) {
        throw new Error(`Téléchargement de l’index EDL impossible (${indexError.message}) et aucun index local valide n’existe.`);
      }
      try {
        index = validateEdlContextIndex(localIndex.data);
      } catch (error) {
        throw new Error(`Index EDL local invalide (${localIndexPath}) : ${error.message}`);
      }
      console.warn(`⚠️ INDEX NON MIS À JOUR — version locale du ${localIndex.stats.mtime.toLocaleDateString('fr-FR')} utilisée (${indexError.message}).`);
    }
  } else if (
    syncedIndex &&
    compareIndexVersions(syncedIndex.data.version, index.version) > 0
  ) {
    index = validateEdlContextIndex(syncedIndex.data);
    console.log(`✓ Index Google Drive synchronisé plus récent détecté : version ${index.version}.`);
    await writeJsonAtomically(localIndexPath, index);
  } else {
    await writeJsonAtomically(localIndexPath, index);
  }

  const route = findTenantRoute(index, family);
  const localContextPath = path.join(contextDirectory, route.fichier);
  let context;
  let contextError;
  try {
    context = validateEdlContext(await downloadJson(route.download_url, fetchImpl));
    if (!matchesTenantFamily(context.locataire.nom, family)) {
      throw new Error(`Le contexte téléchargé ne correspond pas au locataire "${family}".`);
    }
    await writeJsonAtomically(localContextPath, context);
  } catch (error) {
    if (
      error.message.startsWith('Contexte locataire invalide') ||
      error.message.startsWith('Le JSON téléchargé est invalide') ||
      error.message.startsWith('Le contexte téléchargé ne correspond pas')
    ) {
      throw error;
    }
    contextError = error;
    const syncedContext = await readLatestSyncedContext(syncedDriveDirectory, route.fichier);
    if (syncedContext) {
      context = validateEdlContext(syncedContext.data);
      if (!matchesTenantFamily(context.locataire.nom, family)) {
        throw new Error(`Le contexte synchronisé ne correspond pas au locataire "${family}".`);
      }
      console.warn(`⚠️ CONTEXTE NON MIS À JOUR — version synchronisée ${path.basename(syncedContext.filePath)} du ${syncedContext.stats.mtime.toLocaleDateString('fr-FR')} utilisée pour ${family} (${contextError.message}).`);
    } else {
      const localContext = await readOptionalJsonFile(localContextPath, 'Contexte local');
      if (!localContext) {
        throw new Error(`Téléchargement du contexte locataire impossible (${contextError.message}) et aucun contexte local valide n’existe pour "${family}".`);
      }
      try {
        context = validateEdlContext(localContext.data);
      } catch (fallbackError) {
        throw new Error(`Contexte local invalide (${localContextPath}) : ${fallbackError.message}`);
      }
      if (!matchesTenantFamily(context.locataire.nom, family)) {
        throw new Error(`Le contexte local ne correspond pas au locataire "${family}".`);
      }
      console.warn(`⚠️ CONTEXTE NON MIS À JOUR — version locale du ${localContext.stats.mtime.toLocaleDateString('fr-FR')} utilisée pour ${family} (${contextError.message}).`);
    }
  }
  return context;
}

export function getTenantReference(context, familyName) {
  const tenant = context.locataire;
  const lot = String(tenant.lot).trim().replace(/^#/, '');
  const fullName = [tenant.civilite, tenant.nom].filter(Boolean).join(' ').trim();
  const nomFamille = normalizeTenantFamily(familyName || tenant.nom.split(/\s+/).at(-1));
  if (!matchesTenantFamily(tenant.nom, nomFamille)) {
    throw new Error(`Le contexte chargé ne correspond pas au locataire "${nomFamille}".`);
  }
  const isLegacyProperty = isRecord(context.bien.lots);
  const propertyData = isLegacyProperty
    ? null
    : createPropertyDataFromReference(context);
  return {
    tenant,
    nom: fullName || tenant.nom,
    nomFamille,
    email: tenant.email,
    telephone: typeof tenant.telephone === 'string' ? tenant.telephone : '',
    lot,
    chambre: isLegacyProperty
      ? context.bien.lots[lot].trim()
      : context.bien.formulation_lot.trim(),
    bien: isLegacyProperty ? 'massy' : createPropertyId(context.bien, lot),
    bienData: propertyData,
    adresseBien: context.bien.adresse,
    bailleur: context.bailleur,
    referenceDernierEdl: context.dernier_edl_connu
      ? {
          ...context.dernier_edl_connu,
          locataire: context.dernier_edl_connu.locataire || context.locataire.nom
        }
      : null,
    formulationChambre: context.formulation_chambre_standard
  };
}

function createPropertyId(property, lot) {
  const address = normalizeText(`${property.adresse}-${lot}`).toLowerCase();
  return `logement-${address.replace(/[^a-z0-9]+/g, '-')}`.replace(/-+$/g, '');
}

function createPropertyDataFromReference(context) {
  const rooms = context.dernier_edl_connu?.pieces;
  if (!Array.isArray(rooms) || rooms.length === 0) {
    throw new Error(
      `Le logement "${context.bien.adresse}" n’a pas de liste de pièces et d’équipements exploitable dans son EDL de référence. Faites compléter le contexte par Vibe.`
    );
  }

  const pieces = {};
  const labels = {};
  for (const room of rooms) {
    const key = normalizeRoomKey(room.piece);
    if (pieces[key]) {
      throw new Error(`Le contexte du logement contient deux pièces ayant le même nom normalisé : "${room.piece}".`);
    }
    pieces[key] = [...new Set(room.elements.map(item => item.element.trim()))];
    labels[key] = room.piece.trim();
  }
  const surfaceMatch = context.bien.type.match(/(\d+(?:[,.]\d+)?)\s*m(?:2|²)/i);
  return {
    nom: context.bien.adresse,
    adresse: context.bien.adresse,
    type: context.bien.type,
    ...(surfaceMatch ? { surface: Number(surfaceMatch[1].replace(',', '.')) } : {}),
    pieces,
    piece_labels: labels
  };
}

function normalizeRoomKey(value) {
  const normalized = normalizeText(value).toLocaleLowerCase('fr-FR');
  const aliases = new Map([
    ['entree', 'entree'],
    ['sejour et coin cuisine', 'sejour-cuisine'],
    ['sejour coin cuisine', 'sejour-cuisine'],
    ['salle de bains et wc', 'salle-de-bains-wc'],
    ['salle de bain et wc', 'salle-de-bains-wc'],
    ['chambre', 'chambre']
  ]);
  return aliases.get(normalized) || normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function normalizePropertyRoomName(value) {
  return normalizeRoomKey(value);
}
