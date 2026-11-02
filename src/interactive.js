/**
 * Module interactif - Interface simplifiée pour créer un EDL
 * 
 * Pose des questions à l'utilisateur et lance automatiquement :
 * 1. Création du brouillon (new)
 * 2. Ouverture dans le navigateur
 * 3. Proposition de finalisation
 */

import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { newCommand } from './new.js';
import { finalizeCommand } from './finalize.js';
import { generateContext } from './context-generator.js';
import { collectMissingEdlAnswers } from './edl-clarification.js';
import { ensureEdlContext } from './edl-context.js';
import { resolveTenantPhotosDirectory } from './photo-source.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(__dirname);

/**
 * Question avec valeur par défaut
 */
async function ask(question, defaultValue = '') {
  const rl = readline.createInterface({ input, output });
  const prompt = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
  const answer = (await rl.question(prompt)).trim();
  rl.close();
  return answer || defaultValue;
}

/**
 * Question oui/non
 */
async function askYesNo(question) {
  const rl = readline.createInterface({ input, output });
  const answer = (await rl.question(`${question} (o/n): `)).trim().toLowerCase();
  rl.close();
  return answer === 'o' || answer === 'oui' || answer === 'yes' || answer === 'y';
}

/**
 * Affiche un titre
 */
function displayTitle(text) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${text}`);
  console.log('='.repeat(60));
}

/**
 * Affiche un message de succès
 */
function displaySuccess(message) {
  console.log(`\n✅ ${message}\n`);
}

/**
 * Point d'entrée du mode interactif
 */
export async function interactiveMode() {
  displayTitle('EDL Tool - Mode Interactif');
  console.log('Répondez aux questions pour créer un nouvel EDL.\n');

  // Collecter les informations
  const options = {};
  
  options.type = await ask('Type d\'EDL', 'entree');
  options.locataire = await ask('Nom de famille du locataire');
  options.date = await ask('Date (YYYY-MM-DD)', new Date().toISOString().split('T')[0]);
  options.analysis = await ask('Fichier analysis.json (laisser vide si aucun)');

  // Valider le type
  if (!['entree', 'sortie'].includes(options.type)) {
    displayTitle('❌ Type invalide');
    console.log('Le type doit être "entree" ou "sortie".\n');
    return interactiveMode(); // Recommencer
  }

  // Valider la date
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(options.date)) {
    displayTitle('❌ Date invalide');
    console.log('Le format de date doit être YYYY-MM-DD.\n');
    return interactiveMode(); // Recommencer
  }

  // Lancer la création du brouillon
  displayTitle('Création de l\'EDL...');
  
  try {
    const { photosDirectory, imageCount } =
      await resolveTenantPhotosDirectory(options.locataire, options.type);
    options.photos = photosDirectory;
    displaySuccess(`Dossier photos trouvé: ${photosDirectory} (${imageCount} image(s))`);

    const edlContextData = await ensureEdlContext(options.locataire);
    const context = await generateContext(options.locataire, {
      date: options.date,
      requireVibeContext: false,
      promptForMissingContact: true,
      requireConfirmedContact: true,
      edlContextData
    });
    options.bien = context.bien;
    options.email = context.locataire.email;
    options.telephone = context.locataire.telephone;
    options.chambre = context.locataire.chambre;
    options.lot = context.locataire.lot;
    options.adresseBien = context.adresseBien;
    options.edlContextData = edlContextData;
    Object.assign(options, collectMissingEdlAnswers({}));
    const result = await newCommand(options);
    displaySuccess(`EDL brouillon créé: ${result.draftPath}`);
    displaySuccess(`Photos traitées: ${result.photosCount}`);
    if (result.analysisCount) {
      displaySuccess(`Analyse chargée: ${result.analysisCount} photo(s) analysée(s)`);
    }
    
    console.log(`\n📄 Fichier brouillon: ${result.draftPath}`);
    console.log(`🌐 Brouillon HTML: ${result.htmlPath} (ouvert dans le navigateur)`);
    
    // Proposer de finaliser
    const draftFilename = path.basename(result.draftPath);
    const shouldFinalize = await askYesNo(`\nVoulez-vous finaliser cet EDL maintenant (générer le PDF) ?`);
    
    if (shouldFinalize) {
      displayTitle('Finalisation de l\'EDL...');
      const finalizeResult = await finalizeCommand(draftFilename);
      displaySuccess(`EDL finalisé: ${finalizeResult.message}`);
      console.log(`📄 PDF généré: ${finalizeResult.pdfPath}`);
      console.log(`📄 HTML final: ${finalizeResult.htmlPath}`);
    } else {
      console.log('\n⏸️  Vous pouvez finaliser plus tard avec:');
      console.log(`   node src/cli.js finalize ${draftFilename}`);
    }
    
    console.log('\n' + '='.repeat(60));
    
  } catch (error) {
    displayTitle('❌ Erreur');
    console.error(`Erreur: ${error.message}\n`);
    console.log('Veuillez vérifier vos réponses et réessayer.');
  }
}

// Lancer le mode interactif si ce fichier est exécuté directement
const isMainModule = process.argv[1]?.includes('interactive.js');
if (isMainModule) {
  interactiveMode().catch(error => {
    console.error('Erreur:', error.message);
    process.exit(1);
  });
}

export default { interactiveMode };
