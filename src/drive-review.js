import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { confirmDraftChanges, proposeDraftChanges } from './draft-editor.js';
import { matchesTenantFamily, matchesTenantIdentity } from './edl-context.js';

const DEFAULT_REVIEW_DIRECTORY = String.raw`G:\Mon Drive\EDL tool\edl-review`;
const MAX_PROPOSAL_SIZE = 1024 * 1024;
const MAX_CHANGES = 500;

export function getReviewDirectory() {
  return path.resolve(process.env.EDL_REVIEW_DIRECTORY || DEFAULT_REVIEW_DIRECTORY);
}

export function createDriveReviewPrompt(draftFile, reviewDirectory) {
  validateDraftFileName(draftFile);
  return `Bonjour Vibe Work. Je veux relire et corriger un EDL.

Dossier de revue Drive : ${reviewDirectory}
Nom exact du brouillon local : ${draftFile}

Lis instructions.txt et review.json dans ce dossier. Aide-moi à préparer les corrections que je vais te demander, puis écris uniquement la proposition structurée dans un fichier nommé changes.json dans ce dossier. Drive peut créer un doublon nommé changes (1).json, changes (2).json, etc. : ne supprime aucun fichier et ne modifie pas le modèle vide. Le script local sélectionnera le fichier changes*.json le plus récemment modifié ; écris-y la proposition complète finale avant de confirmer qu’elle est prête. Ne modifie pas review.json, ne finalise pas le PDF et n’invente aucune information. Les actions add_property_element et remove_property_element peuvent modifier l’inventaire partagé du logement et du lot, et donc les prochains EDL : utilise-les seulement si je demande explicitement une modification durable. Si une correction est ambiguë, demande-moi une précision.`;
}

export async function publishReviewDraft(draftPath, options = {}) {
  const draftFile = path.basename(draftPath);
  validateDraftFileName(draftFile);

  const draft = await readDraftFile(draftPath);
  validateDraft(draft);

  const reviewDirectory = path.resolve(options.reviewDirectory || getReviewDirectory());
  const packageDirectory = path.join(reviewDirectory, path.parse(draftFile).name);
  await fs.mkdir(packageDirectory, { recursive: true });
  await ensureReviewPackageIsContained(reviewDirectory, packageDirectory);

  const reviewPath = path.join(packageDirectory, 'review.json');
  const proposalPath = path.join(packageDirectory, 'changes.json');
  const guidePath = path.join(packageDirectory, 'instructions.txt');
  const createdFiles = [];

  try {
    await writeNewFile(reviewPath, JSON.stringify(createReviewSnapshot(draft, draftFile), null, 2));
    createdFiles.push(reviewPath);
    await writeNewFile(proposalPath, JSON.stringify(createProposalTemplate(draft, draftFile), null, 2));
    createdFiles.push(proposalPath);
    await writeNewFile(guidePath, createReviewInstructions());
    createdFiles.push(guidePath);
  } catch (error) {
    await Promise.all(createdFiles.map(file => fs.rm(file, { force: true })));
    throw new Error(`Impossible de publier la fiche de revue dans Drive : ${error.message}`);
  }

  return { reviewDirectory: packageDirectory, reviewPath, proposalPath };
}

export async function applyDriveReview(projectRoot, draftFile, tenant, options = {}) {
  validateDraftFileName(draftFile);
  const reviewDirectory = path.resolve(options.reviewDirectory || getReviewDirectory());
  const packageDirectory = path.join(reviewDirectory, path.parse(draftFile).name);

  await ensureReviewPackageIsContained(reviewDirectory, packageDirectory);

  const draftPath = path.join(projectRoot, 'data', 'edl', draftFile);
  const draft = await readDraftFile(draftPath);
  validateDraft(draft);
  if (tenant && (typeof tenant.nom !== 'string' || !tenant.nom.trim())) {
    throw new Error('Le nom du locataire est invalide.');
  }
  if (tenant && !matchesTenantFamily(draft.locataire.nom, tenant.nom)) {
    throw new Error(`Le brouillon "${draftFile}" ne correspond pas au locataire demandé.`);
  }
  const confirmedTenant = { nom: draft.locataire.nom };

  const proposalFile = await findLatestProposalFile(packageDirectory);
  const proposalPath = path.join(packageDirectory, proposalFile.name);
  const print = options.print || console.log;
  print(`Proposition sélectionnée : ${proposalFile.name} (modifiée le ${proposalFile.stats.mtime.toLocaleString('fr-FR')})`);
  const proposalContent = await readProposalFile(proposalPath);
  const proposal = parseProposal(proposalContent, draftFile, confirmedTenant);
  const plan = await proposeDraftChanges(projectRoot, draftFile, confirmedTenant, proposal.changes, {
    inventoryDirectory: options.inventoryDirectory
  });
  const ask = options.ask || askQuestion;

  print(`Modifications proposées pour ${draftFile} :`);
  for (const [index, modification] of plan.modifications.entries()) {
    print(`${index + 1}. ${modification}`);
  }

  const answer = (await ask('Appliquer ces changements au brouillon local ? (o/n): ')).trim().toLowerCase();
  if (!['o', 'oui', 'y', 'yes'].includes(answer)) {
    print('Aucune modification appliquée.');
    return { applied: false, modifications: plan.modifications };
  }

  if (await fs.readFile(proposalPath, 'utf8') !== proposalContent) {
    throw new Error('La proposition Drive a changé pendant sa validation. Relisez-la avant de recommencer.');
  }

  const result = await confirmDraftChanges(
    projectRoot,
    draftFile,
    confirmedTenant,
    plan.confirmation_token
  );

  try {
    const updatedDraft = await readDraftFile(draftPath);
    await writeAtomically(
      path.join(packageDirectory, 'review.json'),
      JSON.stringify(createReviewSnapshot(updatedDraft, draftFile), null, 2)
    );

    const currentProposal = await fs.readFile(proposalPath, 'utf8');
    if (currentProposal !== proposalContent) {
      return {
        ...result,
        applied: true,
        proposalArchived: false,
        warning: 'Le brouillon est modifié, mais la proposition Drive a changé en parallèle et a été conservée.'
      };
    }

    const archiveDirectory = path.join(packageDirectory, 'archive');
    await fs.mkdir(archiveDirectory, { recursive: true });
    await ensureReviewPackageIsContained(packageDirectory, archiveDirectory);
    const suffix = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const archivedPath = path.join(archiveDirectory, `changes-${suffix}.json`);
    await fs.rename(proposalPath, archivedPath);
    if (proposalFile.name.toLocaleLowerCase() === 'changes.json') {
      await writeNewFile(proposalPath, JSON.stringify(createProposalTemplate(updatedDraft, draftFile), null, 2));
    }

    return { ...result, applied: true, proposalArchived: true, archivedPath };
  } catch (error) {
    throw new Error(`Les changements sont enregistrés localement, mais la fiche Drive n’a pas pu être réinitialisée : ${error.message}`);
  }
}

function createReviewSnapshot(draft, draftFile) {
  return {
    schema_version: 1,
    draft_file: draftFile,
    contexte: {
      id: draft.id,
      type: draft.type,
      date: draft.date,
      locataire: draft.locataire.nom,
      email: draft.locataire.email || '',
      telephone: draft.locataire.telephone || '',
      chambre: draft.locataire.chambre || '',
      lot: draft.locataire.lot || ''
    },
    etat_usure: Object.fromEntries(
      Object.entries(draft.etat_usure || {}).map(([piece, elements]) => [
        piece,
        Object.fromEntries(Object.entries(elements || {}).map(([element, state]) => [
          element,
          {
            etat: Array.isArray(state) ? state[0] || '' : '',
            observation: Array.isArray(state) ? state[1] || '' : ''
          }
        ]))
      ])
    ),
    photos: (draft.photos || []).map((photo, index) => ({
      photo_number: `P${String(index + 1).padStart(2, '0')}`,
      piece: photo.piece || 'indetermine',
      legende: photo.legende || '',
      defauts: Array.isArray(photo.defauts) ? photo.defauts : []
    })),
    cles: draft.cles || [],
    proprete: draft.proprete || '',
    detecteur_fumee: draft.securite?.detecteur_fumee || '',
    reserves_bailleur: draft.reserves_bailleur || '',
    reserves_locataire: draft.reserves_locataire || ''
  };
}

function createProposalTemplate(draft, draftFile) {
  return {
    schema_version: 1,
    draft_file: draftFile,
    locataire: draft.locataire.nom,
    changes: []
  };
}

function createReviewInstructions() {
  return `EDL — instructions de revue

Lisez review.json, puis écrivez la proposition complète finale dans un fichier nommé changes.json.
Si Google Drive crée un doublon (changes (1).json, changes (2).json, etc.), ne supprimez aucun fichier et ne modifiez pas le modèle vide : le script local appliquera le fichier changes*.json le plus récemment modifié.
Ne modifiez pas review.json. Le brouillon complet et les photos restent sur le PC.
Les coordonnées du locataire sont incluses comme contexte : ne les modifiez pas. N’inventez aucune information.
Confirmez que la proposition est complète uniquement après avoir écrit le fichier final. Une proposition n’est appliquée qu’après confirmation dans le terminal local.
Les actions add_property_element et remove_property_element modifient l’inventaire partagé pour les futurs EDL du même logement et du même lot. Utilisez-les uniquement si l’utilisateur demande explicitement une modification durable de l’inventaire. L’historique des EDL précédents ne doit pas être modifié. Pour un équipement nouvellement constaté, demandez confirmation de son nom et de sa pièce avant de l’ajouter.

Format :
{
  "schema_version": 1,
  "draft_file": "draft-....json",
  "locataire": "Nom affiché dans review.json",
  "changes": [ ... ]
}

Actions autorisées (respecter exactement les noms de champs) :
- update_photo_defect: { "action": "update_photo_defect", "photo_number": "P01", "current_description": "...", "new_description": "..." }
- remove_photo_defect: { "action": "remove_photo_defect", "photo_number": "P01", "current_description": "..." }
- remove_photo: { "action": "remove_photo", "photo_number": "P01" }
- remove_photo_legend: { "action": "remove_photo_legend", "photo_number": "P01" }
- update_photo_legend: { "action": "update_photo_legend", "photo_number": "P01", "legende": "Nouvelle légende" }
- set_room_condition: { "action": "set_room_condition", "piece": "chambre", "element": "Fenêtre", "etat": "Bon état", "observation": "..." }
- remove_property_element: { "action": "remove_property_element", "piece": "chambre", "element": "Radiateur" } — retire durablement un équipement de l’inventaire partagé du logement/lot.
- add_property_element: { "action": "add_property_element", "piece": "chambre", "element": "Radiateur" } — ajoute durablement un équipement confirmé à l’inventaire partagé du logement/lot.
- append_observation: { "action": "append_observation", "piece": "chambre", "element": "Fenêtre", "observation": "..." }
- set_keys: { "action": "set_keys", "cles": [{ "type": "Clé de chambre", "nombre": 1, "observations": "" }] }
- set_reserve: { "action": "set_reserve", "partie": "bailleur", "texte": "..." } ; partie vaut "bailleur" ou "locataire"

Utilisez les valeurs et éléments présents dans review.json. Pour toute correction ambiguë, demandez une précision à l’utilisateur au lieu de choisir.
`;
}

export async function findLatestProposalFile(packageDirectory) {
  const entries = await fs.readdir(packageDirectory, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    const match = entry.name.match(/^changes(?:\s*\((\d+)\))?\.json$/i);
    if (!match) continue;
    const filePath = path.join(packageDirectory, entry.name);
    const stats = await fs.lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Le fichier de proposition "${entry.name}" doit être un fichier normal.`);
    }
    candidates.push({
      name: entry.name,
      stats,
      duplicateNumber: Number(match[1] || 0)
    });
  }
  if (candidates.length === 0) {
    throw new Error(`Aucun fichier changes.json n’a été trouvé dans "${packageDirectory}".`);
  }
  candidates.sort((left, right) =>
    right.stats.mtimeMs - left.stats.mtimeMs ||
    right.duplicateNumber - left.duplicateNumber
  );
  return candidates[0];
}

async function ensureReviewPackageIsContained(reviewDirectory, packageDirectory) {
  let realReviewDirectory;
  let realPackageDirectory;
  try {
    [realReviewDirectory, realPackageDirectory] = await Promise.all([
      fs.realpath(reviewDirectory),
      fs.realpath(packageDirectory)
    ]);
  } catch (error) {
    throw new Error(`Dossier de revue introuvable : ${error.message}`);
  }
  const relativePath = path.relative(realReviewDirectory, realPackageDirectory);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('Le dossier de revue doit rester dans le dossier edl-review.');
  }
}

async function readProposalFile(proposalPath) {
  let stat;
  try {
    stat = await fs.lstat(proposalPath);
  } catch (error) {
    throw new Error(`Proposition Drive introuvable : ${error.message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PROPOSAL_SIZE) {
    throw new Error('Le fichier changes.json doit être un fichier de moins de 1 Mo.');
  }
  return fs.readFile(proposalPath, 'utf8');
}

function parseProposal(content, draftFile, tenant) {
  let proposal;
  try {
    proposal = JSON.parse(content);
  } catch (error) {
    throw new Error(`La proposition Drive contient un JSON invalide : ${error.message}`);
  }
  
  // Normaliser le locataire : accepter string ou objet {nom: "..."}
  let locataireName = proposal.locataire;
  if (locataireName && typeof locataireName === 'object' && locataireName.nom) {
    locataireName = locataireName.nom;
  }
  
  if (
    proposal?.schema_version !== 1 ||
    proposal.draft_file !== draftFile ||
    !matchesTenantIdentity(locataireName, tenant) ||
    !Array.isArray(proposal.changes) ||
    proposal.changes.length === 0 ||
    proposal.changes.length > MAX_CHANGES
  ) {
    throw new Error('La proposition Drive est vide, invalide ou ne correspond pas au brouillon et au locataire.');
  }
  return proposal;
}

function validateDraftFileName(draftFile) {
  if (
    typeof draftFile !== 'string' ||
    path.basename(draftFile) !== draftFile ||
    !/^draft-[\w.-]+\.json$/i.test(draftFile)
  ) {
    throw new Error('Indiquez le nom de fichier d’un brouillon draft-*.json, sans chemin.');
  }
}

async function readDraftFile(draftPath) {
  let draft;
  try {
    draft = JSON.parse(await fs.readFile(draftPath, 'utf8'));
  } catch (error) {
    throw new Error(`Impossible de lire le brouillon : ${error.message}`);
  }
  return draft;
}

function validateDraft(draft) {
  if (!draft || typeof draft !== 'object' || !draft.locataire?.nom || !Array.isArray(draft.photos)) {
    throw new Error('Le fichier ne contient pas un brouillon EDL valide.');
  }
}

async function writeNewFile(filePath, content) {
  await fs.writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' });
}

async function writeAtomically(filePath, content) {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

async function askQuestion(question) {
  const readline = await import('readline/promises');
  const { stdin, stdout } = await import('process');
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}
