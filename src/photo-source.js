import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_TENANT_PHOTOS_ROOT = String.raw`C:\Users\damie\Proton Drive\damienoillic\My files\EDL`;

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']);

export async function resolveTenantPhotosDirectory(familyName, edlType, {
  root = process.env.EDL_PHOTOS_SOURCE_ROOT || DEFAULT_TENANT_PHOTOS_ROOT
} = {}) {
  const familyKey = normalizeFolderName(familyName);
  if (!familyKey) {
    throw new Error('Nom de famille invalide pour rechercher le dossier des photos.');
  }
  if (!['entree', 'sortie'].includes(edlType)) {
    throw new Error(`Type d'EDL invalide pour rechercher les photos : "${edlType}".`);
  }

  const photosRoot = path.resolve(root);
  let entries;
  try {
    entries = await fs.readdir(photosRoot, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Impossible de lire le dossier source des photos "${photosRoot}" : ${error.message}`);
  }

  const matches = entries.filter(entry =>
    entry.isDirectory() && normalizeFolderName(entry.name) === familyKey
  );
  if (matches.length === 0) {
    throw new Error(`Aucun dossier photo nommé "${familyName}" n’a été trouvé dans "${photosRoot}".`);
  }
  if (matches.length > 1) {
    throw new Error(`Plusieurs dossiers correspondent au locataire "${familyName}" dans "${photosRoot}".`);
  }

  const tenantDirectory = path.join(photosRoot, matches[0].name);
  const edlFolder = edlType === 'entree' ? 'ENTREE' : 'SORTIE';
  let edlDirectories;
  try {
    edlDirectories = await fs.readdir(tenantDirectory, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Impossible de lire le dossier du locataire "${tenantDirectory}" : ${error.message}`);
  }
  const typeMatches = edlDirectories.filter(entry =>
    entry.isDirectory() && normalizeFolderName(entry.name) === edlFolder
  );
  if (typeMatches.length === 0) {
    const expectedDirectory = path.join(tenantDirectory, edlType === 'entree' ? 'Entrée' : 'Sortie');
    throw new Error(`Aucun dossier photo ${edlType} trouvé : "${expectedDirectory}".`);
  }
  if (typeMatches.length > 1) {
    throw new Error(`Plusieurs dossiers correspondent au type "${edlType}" pour le locataire "${familyName}".`);
  }

  const photosDirectory = path.join(tenantDirectory, typeMatches[0].name);
  const files = await fs.readdir(photosDirectory, { withFileTypes: true });
  const imageFiles = files.filter(entry =>
    entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
  );
  if (imageFiles.length === 0) {
    throw new Error(`Aucune photo exploitable trouvée dans le dossier "${photosDirectory}".`);
  }

  return { photosDirectory, imageCount: imageFiles.length };
}

function normalizeFolderName(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleUpperCase('fr-FR')
    .replace(/[^A-Z0-9]/g, '');
}
