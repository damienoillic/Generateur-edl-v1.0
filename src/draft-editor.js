import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { generateHtml, ETATS_USURE } from './template.js';
import { matchesTenantIdentity } from './edl-context.js';
import {
  applyInventoryRecordToDraft,
  applyPropertyInventoryChange,
  getPropertyInventoryDirectory,
  preparePropertyInventoryChange,
  writePropertyInventoryChange
} from './property-inventory.js';

const pendingProposals = new Map();
const PROPOSAL_TTL_MS = 10 * 60 * 1000;

export async function readDraftForTenant(projectRoot, draftFile, tenant) {
  const { draft } = await loadDraft(projectRoot, draftFile, tenant);
  return summarizeDraft(draft, draftFile);
}

export async function proposeDraftChanges(projectRoot, draftFile, tenant, changes, options = {}) {
  const { draftPath, draft, content } = await loadDraft(projectRoot, draftFile, tenant);
  if (!Array.isArray(changes) || changes.length === 0) {
    throw new Error('La proposition doit contenir au moins une modification.');
  }

  const updatedDraft = structuredClone(draft);
  const propertyChanges = changes.filter(change =>
    ['add_property_element', 'remove_property_element'].includes(change?.action)
  );
  const inventoryPlan = propertyChanges.length > 0
    ? await preparePropertyInventoryChange(
        draft,
        options.inventoryDirectory || getPropertyInventoryDirectory()
      )
    : null;
  const summaries = [];
  for (const change of changes) {
    summaries.push(applyChange(updatedDraft, change, inventoryPlan));
  }
  if (inventoryPlan) {
    inventoryPlan.record.revision = (inventoryPlan.expectedRecord?.revision || 0) + 1;
    applyInventoryRecordToDraft(updatedDraft, inventoryPlan);
  }

  const token = randomUUID();
  pendingProposals.set(token, {
    draftPath,
    draftFile,
    tenantName: tenant.nom,
    originalHash: hash(content),
    updatedDraft,
    inventoryPlan,
    summaries,
    expiresAt: Date.now() + PROPOSAL_TTL_MS
  });
  cleanExpiredProposals();

  return {
    confirmation_token: token,
    expires_in_seconds: PROPOSAL_TTL_MS / 1000,
    modifications: summaries,
    apercu: summarizeDraft(updatedDraft, draftFile),
    message: 'Aucun changement n’a encore été enregistré. Présentez ces modifications à l’utilisateur et attendez sa confirmation explicite avant d’appeler confirm_edl_changes.'
  };
}

export async function confirmDraftChanges(projectRoot, draftFile, tenant, confirmationToken) {
  const proposal = pendingProposals.get(confirmationToken);
  if (!proposal || proposal.expiresAt <= Date.now()) {
    pendingProposals.delete(confirmationToken);
    throw new Error('Cette proposition a expiré ou n’existe plus. Relisez le brouillon et proposez à nouveau les modifications.');
  }
  if (
    proposal.draftFile !== draftFile ||
    !matchesTenantIdentity(proposal.tenantName, tenant) ||
    !matchesTenantIdentity(tenant.nom, { nom: proposal.tenantName })
  ) {
    throw new Error('La confirmation ne correspond pas au brouillon ou au locataire de la proposition.');
  }

  const { draftPath, content } = await loadDraft(projectRoot, draftFile, tenant);
  if (hash(content) !== proposal.originalHash) {
    pendingProposals.delete(confirmationToken);
    throw new Error('Le brouillon a changé depuis la proposition. Relisez-le et proposez à nouveau les modifications.');
  }

  const oldPreviewPath = path.join(projectRoot, 'output', 'brouillon.html');
  let oldPreview = null;
  try {
    oldPreview = await fs.readFile(oldPreviewPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const nextDraftContent = JSON.stringify(proposal.updatedDraft, null, 2);
  const nextPreviewContent = generateHtml(proposal.updatedDraft, true);
  await fs.mkdir(path.dirname(oldPreviewPath), { recursive: true });

  try {
    await writeAtomically(draftPath, nextDraftContent);
    await writeAtomically(oldPreviewPath, nextPreviewContent);
    if (proposal.inventoryPlan) await writePropertyInventoryChange(proposal.inventoryPlan);
  } catch (error) {
    try {
      await writeAtomically(draftPath, content);
      if (oldPreview === null) {
        await fs.rm(oldPreviewPath, { force: true });
      } else {
        await writeAtomically(oldPreviewPath, oldPreview);
      }
    } catch (rollbackError) {
      throw new Error(`Échec de l’enregistrement des modifications (${error.message}) et de leur restauration (${rollbackError.message}).`);
    }
    throw new Error(`Modifications non enregistrées : ${error.message}`);
  }

  pendingProposals.delete(confirmationToken);
  return {
    brouillon: draftFile,
    modifications: proposal.summaries,
    apercu_mis_a_jour: oldPreviewPath,
    etat: summarizeDraft(proposal.updatedDraft, draftFile),
    message: 'Modifications confirmées et enregistrées. Vérifiez le nouvel aperçu avant de finaliser le PDF.'
  };
}

async function loadDraft(projectRoot, draftFile, tenant) {
  if (
    typeof draftFile !== 'string' ||
    path.basename(draftFile) !== draftFile ||
    !/^draft-[\w.-]+\.json$/i.test(draftFile)
  ) {
    throw new Error('Indiquez le nom de fichier d’un brouillon draft-*.json, sans chemin.');
  }

  const edlDirectory = path.join(projectRoot, 'data', 'edl');
  const draftPath = path.join(edlDirectory, draftFile);
  let realEdlDirectory;
  let realDraftPath;
  try {
    [realEdlDirectory, realDraftPath] = await Promise.all([
      fs.realpath(edlDirectory),
      fs.realpath(draftPath)
    ]);
  } catch (error) {
    throw new Error(`Brouillon introuvable : ${error.message}`);
  }
  const relativePath = path.relative(realEdlDirectory, realDraftPath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('Le brouillon doit rester dans data/edl.');
  }

  const content = await fs.readFile(realDraftPath, 'utf8');
  let draft;
  try {
    draft = JSON.parse(content);
  } catch (error) {
    throw new Error(`Le brouillon contient un JSON invalide : ${error.message}`);
  }
  if (!draft || typeof draft !== 'object' || !draft.locataire?.nom || !Array.isArray(draft.photos)) {
    throw new Error('Le fichier ne contient pas un brouillon EDL modifiable.');
  }
  if (!matchesTenantIdentity(draft.locataire.nom, tenant)) {
    throw new Error(`Le brouillon "${draftFile}" ne correspond pas au locataire demandé.`);
  }

  return { draftPath: realDraftPath, draft, content };
}

function applyChange(draft, change, inventoryPlan) {
  switch (change.action) {
    case 'update_photo_defect':
      return updatePhotoDefect(draft, change);
    case 'remove_photo_defect':
      return removePhotoDefect(draft, change);
    case 'remove_photo':
      return removePhoto(draft, change);
    case 'set_room_condition':
      return setRoomCondition(draft, change);
    case 'add_property_element':
    case 'remove_property_element':
      if (!inventoryPlan) throw new Error('Le plan d’inventaire partagé est absent.');
      return applyPropertyInventoryChange(draft, inventoryPlan, change);
    case 'append_observation':
      return appendObservation(draft, change);
    case 'set_keys':
      return setKeys(draft, change);
    case 'set_reserve':
      return setReserve(draft, change);
    case 'remove_photo_legend':
      return removePhotoLegend(draft, change);
    case 'update_photo_legend':
      return updatePhotoLegend(draft, change);
    default:
      throw new Error(`Type de modification non autorisé : "${change?.action}".`);
  }
}

function updatePhotoDefect(draft, change) {
  const { photo, photoNumber } = getPhoto(draft, change.photo_number);
  const defectIndex = photo.defauts?.indexOf(change.current_description) ?? -1;
  if (defectIndex < 0) {
    throw new Error(`Le défaut indiqué n’existe pas pour ${change.photo_number}. Relisez le brouillon avant de le modifier.`);
  }
  const description = requireText(change.new_description, 'Le nouveau commentaire');
  photo.defauts[defectIndex] = description;
  updatePhotoText(photo, change.current_description, description);
  replacePhotoAnnotation(draft, photoNumber, change.current_description, description);
  return `${change.photo_number} : défaut reformulé en « ${description} ».`;
}

function removePhotoDefect(draft, change) {
  const { photo, photoNumber } = getPhoto(draft, change.photo_number);
  const defectIndex = photo.defauts?.indexOf(change.current_description) ?? -1;
  if (defectIndex < 0) {
    throw new Error(`Le défaut indiqué n’existe pas pour ${change.photo_number}. Relisez le brouillon avant de le modifier.`);
  }
  photo.defauts.splice(defectIndex, 1);
  if (typeof photo.legende === 'string') {
    photo.legende = photo.legende
      .replaceAll(change.current_description, '')
      .split(';')
      .map(part => part.trim())
      .filter(Boolean)
      .join(' ; ');
  }
  removePhotoAnnotation(draft, photoNumber, change.current_description);
  return `${change.photo_number} : défaut « ${change.current_description} » retiré ; la photo reste dans l’annexe.`;
}

function removePhoto(draft, change) {
  const { index, photoNumber } = getPhoto(draft, change.photo_number);
  const [removed] = draft.photos.splice(index, 1);
  for (const elements of Object.values(draft.etat_usure || {})) {
    for (const state of Object.values(elements || {})) {
      if (!Array.isArray(state) || typeof state[1] !== 'string') continue;
      state[1] = state[1]
        .split(';')
        .filter(clause => !clause.includes(`(photo annexe ${photoNumber})`))
        .map(clause => clause.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join('; ');
    }
  }
  renumberPhotoAnnotations(draft, index);
  return `${photoNumber} — ${removed.fichier} retirée de l’annexe photo. Les numéros suivants sont décalés.`;
}

function removePhotoLegend(draft, change) {
  const { photo, photoNumber } = getPhoto(draft, change.photo_number);
  photo.legende = '';
  return `${photoNumber} — légende supprimée.`;
}

function updatePhotoLegend(draft, change) {
  const { photo, photoNumber } = getPhoto(draft, change.photo_number);
  photo.legende = requireText(change.legende, 'Légende');
  return `${photoNumber} — légende mise à jour : "${photo.legende}".`;
}

function setRoomCondition(draft, change) {
  const room = draft.etat_usure?.[change.piece];
  if (!room || !Object.hasOwn(room, change.element)) {
    throw new Error(`Élément introuvable dans le brouillon : "${change.piece}.${change.element}".`);
  }
  if (!ETATS_USURE.includes(change.etat)) {
    throw new Error(`État invalide. Choisissez parmi : ${ETATS_USURE.join(', ')}.`);
  }
  if (change.observation !== undefined && typeof change.observation !== 'string') {
    throw new Error('L’observation doit être un texte.');
  }
  const previous = room[change.element];
  room[change.element] = [
    change.etat,
    change.observation === undefined
      ? (Array.isArray(previous) ? previous[1] || '' : '')
      : change.observation
  ];
  return `${change.piece} — ${change.element} : état « ${change.etat} »${change.observation === undefined ? '' : `, observation « ${change.observation || 'aucune'} »`}.`;
}

function appendObservation(draft, change) {
  const room = draft.etat_usure?.[change.piece];
  if (!room || !Object.hasOwn(room, change.element)) {
    throw new Error(`Élément introuvable dans le brouillon : "${change.piece}.${change.element}".`);
  }
  const observation = requireText(change.observation, 'L’observation');
  const previous = room[change.element];
  const current = previous[1] || '';
  if (current.includes(observation)) {
    return `${change.piece} — ${change.element} : observation déjà présente.`;
  }
  room[change.element] = [previous[0] || '', current ? `${current}; ${observation}` : observation];
  return `${change.piece} — ${change.element} : observation ajoutée « ${observation} ».`;
}

function setKeys(draft, change) {
  if (!Array.isArray(change.cles)) {
    throw new Error('La remise des clés doit être une liste.');
  }
  draft.cles = change.cles.map(key => {
    if (!key || typeof key !== 'object' || !Number.isInteger(key.nombre) || key.nombre < 0) {
      throw new Error('Chaque clé doit avoir un type et une quantité entière positive ou nulle.');
    }
    const matchingKey = draft.cles?.find(existing => existing.type === key.type);
    return {
      type: requireText(key.type, 'Le type de clé'),
      nombre: key.nombre,
      date: matchingKey?.date || draft.date,
      observations: key.observations || ''
    };
  });
  return `Remise des clés remplacée : ${draft.cles.map(key => `${key.nombre} × ${key.type}`).join(', ') || 'aucune clé'}.`;
}

function setReserve(draft, change) {
  if (!['bailleur', 'locataire'].includes(change.partie)) {
    throw new Error('La partie concernée doit être "bailleur" ou "locataire".');
  }
  const field = change.partie === 'bailleur' ? 'reserves_bailleur' : 'reserves_locataire';
  draft[field] = requireText(change.texte, 'Le texte de la réserve');
  return `Réserve du ${change.partie} mise à jour.`;
}

function getPhoto(draft, photoNumber) {
  const match = /^P(\d{2,})$/i.exec(photoNumber || '');
  if (!match) throw new Error(`Numéro de photo invalide : "${photoNumber}".`);
  const index = Number(match[1]) - 1;
  const photo = draft.photos[index];
  if (!photo) throw new Error(`La photo ${photoNumber} n’existe pas dans ce brouillon.`);
  return { photo, index, photoNumber: `P${String(index + 1).padStart(2, '0')}` };
}

function updatePhotoText(photo, previous, replacement) {
  if (typeof photo.legende === 'string') {
    photo.legende = photo.legende.replaceAll(previous, replacement);
  }
}

function replacePhotoAnnotation(draft, photoNumber, previous, replacement) {
  const oldAnnotation = `${previous} (photo annexe ${photoNumber})`;
  const newAnnotation = `${replacement} (photo annexe ${photoNumber})`;
  for (const elements of Object.values(draft.etat_usure || {})) {
    for (const state of Object.values(elements || {})) {
      if (Array.isArray(state) && typeof state[1] === 'string') {
        state[1] = state[1].replaceAll(oldAnnotation, newAnnotation);
      }
    }
  }
}

function removePhotoAnnotation(draft, photoNumber, description) {
  const annotation = `${description} (photo annexe ${photoNumber})`;
  for (const elements of Object.values(draft.etat_usure || {})) {
    for (const state of Object.values(elements || {})) {
      if (!Array.isArray(state) || typeof state[1] !== 'string') continue;
      state[1] = state[1]
        .split(';')
        .filter(clause => !clause.includes(annotation))
        .map(clause => clause.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join('; ');
    }
  }
}

function renumberPhotoAnnotations(draft, removedIndex) {
  for (const elements of Object.values(draft.etat_usure || {})) {
    for (const state of Object.values(elements || {})) {
      if (!Array.isArray(state) || typeof state[1] !== 'string') continue;
      state[1] = state[1].replace(/\(photo annexe P(\d+)\)/g, (annotation, number) => {
        const oldIndex = Number(number) - 1;
        if (oldIndex <= removedIndex) return annotation;
        return `(photo annexe P${String(oldIndex).padStart(2, '0')})`;
      });
    }
  }
}

function summarizeDraft(draft, draftFile) {
  return {
    brouillon: draftFile,
    id: draft.id,
    type: draft.type,
    date: draft.date,
    locataire: draft.locataire.nom,
    etats: Object.entries(draft.etat_usure || {}).flatMap(([piece, elements]) =>
      Object.entries(elements || {}).map(([element, state]) => ({
        piece,
        element,
        etat: Array.isArray(state) ? state[0] || '' : '',
        observation: Array.isArray(state) ? state[1] || '' : ''
      }))
    ),
    cles: draft.cles || [],
    reserves_bailleur: draft.reserves_bailleur || '',
    reserves_locataire: draft.reserves_locataire || '',
    photos: draft.photos.map((photo, index) => ({
      photo_number: `P${String(index + 1).padStart(2, '0')}`,
      fichier: photo.fichier,
      piece: photo.piece || 'indetermine',
      legende: photo.legende || '',
      defauts: photo.defauts || []
    }))
  };
}

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} ne peut pas être vide.`);
  }
  return value.trim();
}

function hash(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function writeAtomically(filePath, content) {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, content);
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

function cleanExpiredProposals() {
  const now = Date.now();
  for (const [token, proposal] of pendingProposals) {
    if (proposal.expiresAt <= now) pendingProposals.delete(token);
  }
}
