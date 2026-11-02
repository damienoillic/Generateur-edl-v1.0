#!/usr/bin/env node

/**
 * Point d'entrée CLI pour l'outil EDL
 * Utilisation: node src/cli.js <command> [options]
 * 
 * Commandes disponibles:
 *   - seed: crée data/biens.json avec le bien Massy
 *   - new: crée un nouvel EDL brouillon
 *   - finalize <draftFile> --locataire <nom>: finalise un EDL brouillon en HTML/PDF
 *   - compare <edl1> <edl2> --locataire <nom>: compare deux EDL
 */

import path from 'path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'url';
import { seedCommand } from './seed.js';
import { newCommand } from './new.js';
import { finalizeCommand } from './finalize.js';
import { compareCommand } from './compare.js';
import { applyDriveReview } from './drive-review.js';
import { generateContext } from './context-generator.js';
import { collectMissingEdlAnswers } from './edl-clarification.js';
import { ensureEdlContext, normalizeTenantFamily } from './edl-context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Récupérer la commande et les arguments
const args = process.argv.slice(2);
const command = args[0];

// Gestion des commandes
switch (command) {
  case 'seed':
    await runSeed();
    break;
    
  case 'new':
    await runNew(args.slice(1));
    break;
    
  case 'finalize':
    await runFinalize(args.slice(1));
    break;
    
  case 'compare':
    await runCompare(args.slice(1));
    break;

  case 'apply-review':
    await runApplyReview(args.slice(1));
    break;
    
  default:
    showHelp();
    process.exit(1);
}

// Fonction d'aide
function showHelp() {
  console.log(`
Outil CLI pour générer des états des lieux (EDL)

Usage: node src/cli.js <command> [options]

Commandes:
  seed                      Crée data/biens.json avec le bien Massy
  new --type <type> --locataire <nom-de-famille> ...  Crée un nouvel EDL brouillon
  finalize <draftFile> --locataire <nom>  Finalise un EDL brouillon en HTML/PDF
  compare <edl1> <edl2> --locataire <nom> Compare deux EDL
  apply-review <draftFile> --locataire <nom>  Applique une proposition Drive après confirmation
  apply-review                              Demande le nom exact du brouillon puis applique la proposition

Options pour 'new':
  --bien <bien>           Nom du bien (ex: massy)
  --type <type>           Type d'EDL: entree ou sortie
  --locataire <nom>       Nom de famille du locataire (sans accent accepté)
  --email <email>         Email du locataire
  --telephone <telephone> Téléphone du locataire
  --compteur-electricite <index> Relevé du compteur électrique
  --compteur-eau-froide <index> Relevé du compteur d'eau froide
  --compteur-eau-chaude <index> Relevé du compteur d'eau chaude
  --detecteur-fumee <présent|absent> État du détecteur (demandé si omis)
  --proprete <description> État de propreté confirmé
  --reserves-bailleur <texte> Réserves du bailleur (ex: "Aucune")
  --reserves-locataire <texte> Réserves du locataire (ex: "Aucune")
  --chambre <desc>        Description de la chambre
  --lot <lot>             Numéro de lot
  --date <date>           Date (YYYY-MM-DD)
  --adresse-bien <adresse> Adresse complète du logement
  --photos <path>         Chemin vers le dossier des photos
  --analysis <path>       Chemin vers analysis.json (optionnel)

Exemple:
  node src/cli.js new --type entree --locataire "NOM" --date 2026-10-30 \
    --photos ./photos/mon-edl --telephone "06..." \
    --compteur-electricite "123" --compteur-eau-froide "456" \
    --compteur-eau-chaude "789" --detecteur-fumee présent \
    --proprete "Propre" --reserves-bailleur "Aucune" \
    --reserves-locataire "Aucune"
`);
}

// Exécution des commandes
async function runSeed() {
  try {
    await seedCommand();
    console.log('✓ Bien Massy créé dans data/biens.json');
  } catch (error) {
    console.error('Erreur:', error.message);
    process.exit(1);
  }
}

async function runNew(args) {
  const options = parseNewArgs(args);
  if (!options) {
    showHelp();
    process.exit(1);
  }
  
  try {
    const edlContextData = await ensureEdlContext(options.locataire);
    const { context } = await generateContext(options.locataire, {
      date: options.date,
      promptForMissingContact: true,
      requireConfirmedContact: true,
      edlContextData,
      vibeContextData: {
        locataires: [{
          nom: options.locataire,
          telephone: options.telephone
        }]
      }
    });
    const draftAnswers = collectMissingEdlAnswers(options);
    const result = await newCommand({
      ...options,
      ...draftAnswers,
      bien: context.bien,
      locataire: context.locataire.nom,
      locataireFamille: options.locataire,
      email: context.locataire.email,
      telephone: context.locataire.telephone,
      chambre: context.locataire.chambre,
      lot: context.locataire.lot,
      adresseBien: context.adresseBien,
      edlContextData
    });
    console.log('✓ EDL brouillon créé avec succès');
    if (result.reviewPath) {
      console.log(`📁 Fiche de revue Drive : ${result.reviewPath}`);
      console.log('Demandez à Vibe Work de lire review.json et de remplir changes.json dans ce dossier. Le script prendra le fichier changes*.json le plus récemment modifié.');
    } else {
      console.warn(`⚠️ Le brouillon est local, mais la fiche Drive n’a pas été publiée : ${result.reviewError}`);
    }
  } catch (error) {
    console.error('Erreur:', error.message);
    process.exit(1);
  }
}

async function runApplyReview(args) {
  let draftFile;
  let locataire;
  if (args.length === 0) {
    draftFile = (await askQuestion('Nom exact du brouillon (ex. draft-entree-BANIZA-2026....json): ')).trim();
    if (!draftFile) {
      console.error('Erreur: le nom exact du brouillon est requis.');
      process.exit(1);
    }
  } else {
    const parsed = parseLocataireCommandArgs(args);
    if (parsed.positional.length !== 1 || !parsed.draftFile) {
      console.error('Erreur: indiquez un nom de brouillon valide, avec --locataire en option.');
      showHelp();
      process.exit(1);
    }
    draftFile = parsed.draftFile;
    locataire = parsed.locataire;
  }

  try {
    const result = await applyDriveReview(
      path.dirname(__dirname),
      draftFile,
      locataire ? { nom: locataire } : null
    );
    if (result.applied) {
      console.log(`✓ Modifications appliquées. Aperçu actualisé : ${result.apercu_mis_a_jour}`);
      if (result.archivedPath) {
        console.log(`📦 Proposition archivée : ${result.archivedPath}`);
      }
      if (result.warning) console.warn(`⚠️ ${result.warning}`);
      console.log(`Pour générer le PDF après vérification : node src/cli.js finalize ${draftFile} --locataire ${locataire}`);
    }
  } catch (error) {
    console.error('Erreur:', error.message);
    process.exit(1);
  }
}

async function askQuestion(question) {
  const rl = readline.createInterface({ input, output });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function runFinalize(args) {
  const { positional, draftFile, locataire } = parseLocataireCommandArgs(args);
  if (positional.length !== 1 || !draftFile || !locataire) {
    console.error('Erreur: un fichier brouillon et --locataire <nom-de-famille> sont requis');
    showHelp();
    process.exit(1);
  }
  
  try {
    await finalizeCommand(draftFile, locataire);
    console.log('✓ EDL finalisé avec succès');
  } catch (error) {
    console.error('Erreur:', error.message);
    process.exit(1);
  }
}

async function runCompare(args) {
  const { positional, locataire } = parseLocataireCommandArgs(args);
  if (positional.length !== 2 || !locataire) {
    console.error('Erreur: deux fichiers EDL et --locataire <nom-de-famille> sont requis');
    showHelp();
    process.exit(1);
  }
  
  try {
    await compareCommand(positional[0], positional[1], locataire);
    console.log('✓ Comparaison générée avec succès');
  } catch (error) {
    console.error('Erreur:', error.message);
    process.exit(1);
  }
}

function parseLocataireCommandArgs(args) {
  const positional = [];
  let locataire;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--locataire' && args[index + 1]) {
      if (locataire) return { positional, locataire: null };
      try {
        locataire = normalizeTenantFamily(args[++index]);
      } catch {
        return { positional, locataire: null };
      }
    } else if (args[index].startsWith('--')) {
      return { positional, locataire: null };
    } else {
      positional.push(args[index]);
    }
  }
  return {
    positional,
    draftFile: positional[0],
    locataire
  };
}

// Parsing des arguments pour 'new'
function parseNewArgs(args) {
  const options = {};
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--bien' && args[i + 1]) options.bien = args[++i];
    else if (arg === '--type' && args[i + 1]) options.type = args[++i];
    else if (arg === '--locataire' && args[i + 1]) options.locataire = args[++i];
    else if (arg === '--email' && args[i + 1]) options.email = args[++i];
    else if (arg === '--telephone' && args[i + 1]) options.telephone = args[++i];
    else if (arg === '--compteur-electricite' && args[i + 1]) {
      options.relevesCompteurs ||= {};
      options.relevesCompteurs.electricite = args[++i];
    }
    else if (arg === '--compteur-eau-froide' && args[i + 1]) {
      options.relevesCompteurs ||= {};
      options.relevesCompteurs.eau_froide = args[++i];
    }
    else if (arg === '--compteur-eau-chaude' && args[i + 1]) {
      options.relevesCompteurs ||= {};
      options.relevesCompteurs.eau_chaude = args[++i];
    }
    else if (arg === '--detecteur-fumee' && args[i + 1]) options.detecteurFumee = args[++i];
    else if (arg === '--proprete' && args[i + 1]) options.proprete = args[++i];
    else if (arg === '--reserves-bailleur' && args[i + 1]) options.reservesBailleur = args[++i];
    else if (arg === '--reserves-locataire' && args[i + 1]) options.reservesLocataire = args[++i];
    else if (arg === '--chambre' && args[i + 1]) options.chambre = args[++i];
    else if (arg === '--lot' && args[i + 1]) options.lot = args[++i];
    else if (arg === '--date' && args[i + 1]) options.date = args[++i];
    else if (arg === '--adresse-bien' && args[i + 1]) options.adresseBien = args[++i];
    else if (arg === '--photos' && args[i + 1]) options.photos = args[++i];
    else if (arg === '--analysis' && args[i + 1]) options.analysis = args[++i];
    else return null;
  }
  
  // Validation
  const required = ['type', 'locataire', 'date', 'photos'];
  for (const key of required) {
    if (!options[key]) return null;
  }
  
  try {
    options.locataire = normalizeTenantFamily(options.locataire);
  } catch {
    return null;
  }
  return options;
}
