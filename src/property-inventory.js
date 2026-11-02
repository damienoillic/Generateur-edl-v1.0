import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EDL_SYNCED_DRIVE_DIRECTORY } from './edl-context.js';

const INVENTORY_FILE = 'property-inventory.json';

export function getPropertyInventoryDirectory() {
  return path.resolve(
    process.env.EDL_PROPERTY_INVENTORY_DIRECTORY ||
    process.env.EDL_SYNCED_DRIVE_DIRECTORY ||
    EDL_SYNCED_DRIVE_DIRECTORY
  );
}

export function getPropertyInventoryId(address, lot) {
  const normalized = [normalizeIdentityPart(address), normalizeIdentityPart(normalizeLot(lot))];
  if (normalized.some(value => !value)) {
    throw new Error('Adresse et lot sont requis pour identifier l’inventaire partagé du logement.');
  }
  const hash = createHash('sha256').update(normalized.join('|')).digest('hex');
  return `property-${hash}`;
}

export async function loadPropertyInventory(address, lot, baseData, directory = getPropertyInventoryDirectory()) {
  const id = getPropertyInventoryId(address, lot);
  const inventory = await readInventory(directory);
  const record = inventory.data.properties[id];
  if (!record) {
    return {
      id,
      revision: 0,
      bienData: structuredClone(baseData)
    };
  }
  validateRecord(record, id);
  return {
    id,
    revision: record.revision,
    bienData: applyRecordToBienData(baseData, record)
  };
}

export async function preparePropertyInventoryChange(draft, directory = getPropertyInventoryDirectory()) {
  const address = draft.property_inventory_address || draft.adresse_bien || draft.bien_data?.adresse || draft.bien_data?.nom;
  const lot = draft.locataire?.lot;
  const id = getPropertyInventoryId(address, lot);
  const inventoryPath = path.join(directory, INVENTORY_FILE);
  await requireDirectory(directory);

  const inventory = await readInventory(directory);
  const currentRecord = inventory.data.properties[id] || null;
  const record = currentRecord
    ? structuredClone(validateRecord(currentRecord, id))
    : createRecord(address, lot, draft.bien_data);

  if (draft.property_inventory_id && draft.property_inventory_id !== id) {
    throw new Error('Le brouillon ne correspond pas à l’identifiant de son inventaire partagé.');
  }
  if (currentRecord) {
    validateRecord(currentRecord, id);
    if (
      draft.property_inventory_revision !== currentRecord.revision ||
      !hasSameInventory(draft.bien_data, currentRecord)
    ) {
      throw new Error('L’inventaire partagé a changé depuis la création du brouillon. Créez un nouveau brouillon avant de le modifier.');
    }
  }

  return {
    directory,
    inventoryPath,
    id,
    address,
    lot: normalizeLot(lot),
    expectedRecord: currentRecord ? structuredClone(currentRecord) : null,
    record
  };
}

export async function writePropertyInventoryChange(plan) {
  const latest = await readInventory(plan.directory);
  const latestRecord = latest.data.properties[plan.id] || null;
  if (!sameJsonValue(latestRecord, plan.expectedRecord)) {
    throw new Error('L’inventaire partagé a été modifié depuis la proposition. Relisez le brouillon et recommencez.');
  }

  validateRecord(plan.record, plan.id);
  const nextData = latest.data;
  nextData.properties[plan.id] = plan.record;
  await writeAtomically(plan.inventoryPath, JSON.stringify(nextData, null, 2));
  return plan.record;
}

export function applyInventoryRecordToDraft(draft, plan) {
  draft.property_inventory_id = plan.id;
  draft.property_inventory_revision = (plan.expectedRecord?.revision || 0) + 1;
}

export function applyPropertyInventoryChange(draft, plan, change) {
  const room = plan.record.pieces[change.piece];
  const draftElements = draft.bien_data?.pieces?.[change.piece];
  const states = draft.etat_usure?.[change.piece];
  if (!room || !Array.isArray(draftElements) || !states) {
    throw new Error(`Pièce introuvable dans l’inventaire partagé : "${change.piece}".`);
  }
  const element = requireText(change.element, 'Le nom de l’équipement');
  const inventoryIndex = room.elements.findIndex(item => normalizeIdentityPart(item) === normalizeIdentityPart(element));
  const draftIndex = draftElements.findIndex(item => normalizeIdentityPart(item) === normalizeIdentityPart(element));

  if (change.action === 'remove_property_element') {
    if (inventoryIndex < 0 || draftIndex < 0) {
      throw new Error(`Équipement introuvable dans l’inventaire partagé : "${change.piece}.${element}".`);
    }
    if (room.elements.length === 1) {
      throw new Error(`Impossible de supprimer le dernier équipement de la pièce "${change.piece}".`);
    }
    const removedElement = draftElements[draftIndex];
    room.elements.splice(inventoryIndex, 1);
    draftElements.splice(draftIndex, 1);
    const stateKey = Object.keys(states).find(key => normalizeIdentityPart(key) === normalizeIdentityPart(removedElement));
    if (stateKey) delete states[stateKey];
    return `Équipement « ${element} » retiré de ${change.piece} et de l’inventaire partagé du logement/lot. Les futurs EDL de ce lot ne le proposeront plus.`;
  }

  if (change.action === 'add_property_element') {
    if (inventoryIndex >= 0 || draftIndex >= 0) {
      throw new Error(`L’équipement "${change.piece}.${element}" existe déjà dans l’inventaire partagé.`);
    }
    room.elements.push(element);
    draftElements.push(element);
    states[element] = ['', ''];
    return `Équipement « ${element} » ajouté à ${change.piece} et à l’inventaire partagé du logement/lot. Son état reste à constater.`;
  }

  throw new Error(`Action d’inventaire non autorisée : "${change.action}".`);
}

function applyRecordToBienData(baseData, record) {
  return {
    ...structuredClone(baseData),
    pieces: Object.fromEntries(
      Object.entries(record.pieces).map(([key, room]) => [key, [...room.elements]])
    ),
    piece_labels: Object.fromEntries(
      Object.entries(record.pieces).map(([key, room]) => [key, room.label])
    )
  };
}

function createRecord(address, lot, bienData) {
  if (!bienData || typeof bienData !== 'object' || !bienData.pieces || typeof bienData.pieces !== 'object') {
    throw new Error('Le brouillon ne contient pas d’inventaire de pièces utilisable.');
  }
  const pieces = {};
  for (const [key, elements] of Object.entries(bienData.pieces)) {
    if (!Array.isArray(elements) || elements.some(element => typeof element !== 'string' || !element.trim())) {
      throw new Error(`La liste des équipements de la pièce "${key}" est invalide.`);
    }
    pieces[key] = {
      label: bienData.piece_labels?.[key] || key,
      elements: [...elements]
    };
  }
  return { adresse: address, lot: normalizeLot(lot), revision: 0, pieces };
}

function validateRecord(record, id) {
  if (
    !record ||
    typeof record !== 'object' ||
    typeof record.adresse !== 'string' ||
    typeof record.lot !== 'string' ||
    !Number.isInteger(record.revision) ||
    record.revision < 0 ||
    !record.pieces ||
    typeof record.pieces !== 'object' ||
    Array.isArray(record.pieces)
  ) {
    throw new Error(`L’enregistrement d’inventaire partagé "${id}" est invalide.`);
  }
  for (const [piece, room] of Object.entries(record.pieces)) {
    if (
      !room ||
      typeof room.label !== 'string' ||
      !Array.isArray(room.elements) ||
      room.elements.some(element => typeof element !== 'string' || !element.trim()) ||
      new Set(room.elements.map(normalizeIdentityPart)).size !== room.elements.length
    ) {
      throw new Error(`La pièce "${piece}" de l’inventaire partagé "${id}" est invalide.`);
    }
  }
  return record;
}

function hasSameInventory(bienData, record) {
  if (!bienData?.pieces || typeof bienData.pieces !== 'object') return false;
  const keys = Object.keys(record.pieces);
  if (keys.length !== Object.keys(bienData.pieces).length) return false;
  return keys.every(key => {
    const elements = bienData.pieces[key];
    return Array.isArray(elements) &&
      elements.length === record.pieces[key].elements.length &&
      elements.every((element, index) => element === record.pieces[key].elements[index]);
  });
}

async function readInventory(directory) {
  const inventoryPath = path.join(directory, INVENTORY_FILE);
  let raw;
  try {
    raw = await fs.readFile(inventoryPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { data: { schema_version: 1, properties: {} }, raw: null };
    throw new Error(`Impossible de lire l’inventaire partagé (${inventoryPath}) : ${error.message}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(`L’inventaire partagé contient un JSON invalide : ${error.message}`);
  }
  if (
    !data ||
    data.schema_version !== 1 ||
    !data.properties ||
    typeof data.properties !== 'object' ||
    Array.isArray(data.properties)
  ) {
    throw new Error('Le fichier d’inventaire partagé est invalide ou utilise une version inconnue.');
  }
  for (const [id, record] of Object.entries(data.properties)) {
    validateRecord(record, id);
    if (getPropertyInventoryId(record.adresse, record.lot) !== id) {
      throw new Error(`L’enregistrement d’inventaire partagé "${id}" ne correspond pas à son logement et son lot.`);
    }
  }
  return { data, raw };
}

async function requireDirectory(directory) {
  let stats;
  try {
    stats = await fs.stat(directory);
  } catch (error) {
    throw new Error(`Le dossier partagé de Google Drive est inaccessible (${directory}) : ${error.message}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Le chemin d’inventaire partagé n’est pas un dossier : ${directory}`);
  }
}

async function writeAtomically(filePath, content) {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw new Error(`Impossible d’enregistrer l’inventaire partagé : ${error.message}`);
  }
}

function normalizeIdentityPart(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleUpperCase('fr-FR');
}

function normalizeLot(value) {
  return String(value || '').trim().replace(/^#/, '');
}

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} ne peut pas être vide.`);
  return value.trim();
}

function sameJsonValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
