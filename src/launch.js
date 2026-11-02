/**
 * LAUNCH - Point d'entrée unique de l'outil EDL
 * 
 * Workflow:
 * 1. Demande le nom du locataire et trouve automatiquement son dossier photo
 * 2. Génère le contexte
 * 3. Compresse les photos
 * 4. Analyse automatiquement les photos par lots de huit si la clé Mistral est configurée
 * 5. Génère l'EDL, ou prépare des lots manuels si l'analyse automatique est indisponible
 * 
 * Utilisation:
 *   node src/launch.js
 */

import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateContext, saveContext, suggestTypeForLocataire } from './context-generator.js';
import { newCommand } from './new.js';
import { finalizeCommand } from './finalize.js';
import { compressAllImages } from './images.js';
import { analyzeAllPhotos, isAnalysisCurrent, isMistralConfigured } from './analyze.js';
import { collectMissingEdlAnswers } from './edl-clarification.js';
import { ensureEdlContext } from './edl-context.js';
import { resolveTenantPhotosDirectory } from './photo-source.js';
import { applyDriveReview, createDriveReviewPrompt } from './drive-review.js';
import open from 'open';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(__dirname);

/**
 * Affiche un titre
 */
function displayTitle(text) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${text}`);
  console.log('='.repeat(60) + '\n');
}

/**
 * Affiche un message de succès
 */
function displaySuccess(message) {
  console.log(`✅ ${message}`);
}

/**
 * Affiche une étape
 */
function displayStep(message) {
  console.log(`\n📌 ${message}`);
}

/**
 * Affiche un message important
 */
function displayImportant(message) {
  console.log(`\n${'⚠'.repeat(3)}  ${message}  ${'⚠'.repeat(3)}`);
}

/**
 * Point d'entrée unique
 */
async function launch() {
  displayTitle('🚀 EDL Tool - Lancement');
  console.log('Je vais créer un nouvel état des lieux.');
  console.log('Répondez simplement aux questions.\n');

  // Demander le nom de famille pour résoudre le contexte distant
  const rl = readline.createInterface({ input, output });
  const locataireNom = (await rl.question('Nom de famille du locataire (ou "quit" pour quitter): ')).trim();
  rl.close();
  
  if (locataireNom.toLowerCase() === 'quit' || locataireNom === '') {
    console.log('\n❌ Annulé. Au revoir !\n');
    process.exit(0);
  }

  const edlContextData = await ensureEdlContext(locataireNom);
  const suggestedType = await suggestTypeForLocataire(locataireNom, undefined, edlContextData);
  const confirmedType = await confirmSuggestedType(suggestedType);

  // Demander la date
  let date = (await askQuestion('Date (format AAAA-MM-JJ, ex: 2026-10-31): ')).trim();
  
  // Valider le format de la date
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  while (!dateRegex.test(date)) {
    console.log('\n❌ Format de date invalide. Utilisez AAAA-MM-JJ (ex: 2026-10-31)');
    date = (await askQuestion('Date (format AAAA-MM-JJ): ')).trim();
  }

  // Étape 1: Générer le contexte
  displayStep('Étape 1/5: Génération du contexte...');
  const generatedContext = await generateContext(locataireNom, {
    date,
    requireVibeContext: false,
    promptForMissingContact: true,
    requireConfirmedContact: true,
    edlContextData
  });
  const context = unwrapGeneratedContext(generatedContext);
  const { photosDirectory: resolvedPhotosDir, imageCount } =
    await resolveTenantPhotosDirectory(locataireNom, confirmedType);
  displaySuccess(`Dossier photos trouvé: ${resolvedPhotosDir} (${imageCount} image(s))`);
  const draftAnswers = collectMissingEdlAnswers({});
  context.type = confirmedType;
  const contextPath = await saveContext(context);
  
  displaySuccess(`Contexte généré: ${contextPath}`);
  console.log(`  Type d'état des lieux confirmé: ${context.type === 'entree' ? 'Entrée' : 'Sortie'}`);
  console.log(`  Date: ${context.date}`);
  console.log(`  Locataire: ${context.locataire.nom}`);
  console.log(`  Téléphone: ${context.locataire.telephone}`);
  console.log(`  Email: ${context.locataire.email}`);
  console.log(`  Chambre: ${context.locataire.chambre}`);
  console.log(`  Lot: ${context.locataire.lot}`);
  console.log(`  Adresse du logement: ${context.adresseBien}`);
  
  // Étape 2: Vérifier et compresser les photos
  displayStep('Étape 2/5: Compression des photos...');
  
  try {
    await fs.access(resolvedPhotosDir);
  } catch {
    console.log(`\n❌ Dossier introuvable: ${resolvedPhotosDir}`);
    process.exitCode = 1;
    return;
  }

  const toAnalyzeDir = path.join(projectRoot, 'output', 'to-analyze', `session-${Date.now()}`);
  const compressedToAnalyze = await compressAllImages(resolvedPhotosDir, toAnalyzeDir);
  if (compressedToAnalyze.length === 0) {
    throw new Error(`Aucune photo exploitable trouvée dans ${resolvedPhotosDir}.`);
  }

  displaySuccess(`Photos compressées: ${compressedToAnalyze.length} photos`);
  displaySuccess(`→ Dossier temporaire: ${toAnalyzeDir}`);

  const analysisPath = path.join(projectRoot, 'analysis.json');
  let analysisReady = false;

  try {
    await fs.access(analysisPath);
    analysisReady = await isAnalysisCurrent(toAnalyzeDir, analysisPath, context.type);

    if (!analysisReady) {
      let hasMetadata = true;
      try {
        await fs.access(`${analysisPath}.meta.json`);
      } catch {
        hasMetadata = false;
      }

      if (!hasMetadata) {
        analysisReady = await hasCompleteManualAnalysis(
          analysisPath,
          compressedToAnalyze.map(photo => photo.filename)
        );
        if (analysisReady) {
          displayImportant('analysis.json est réutilisé comme analyse manuelle; vérifiez qu’il correspond aux photos et au type d’EDL.');
        }
      } else {
        displayImportant('analysis.json ne correspond pas aux photos ou au type d’EDL courant; une nouvelle analyse est nécessaire.');
      }
    } else {
      displaySuccess('Analyse précédente réutilisée: mêmes photos et même type d’EDL.');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  if (!analysisReady && isMistralConfigured()) {
    displayStep('Étape 3/5: Analyse automatique avec réutilisation du cache...');
    try {
      const analyses = await analyzeAllPhotos(toAnalyzeDir, analysisPath, context.type, {
        cachePath: path.join(projectRoot, 'output', 'analysis-cache.json')
      });
      analysisReady = analyses.length === compressedToAnalyze.length;
      if (analysisReady) {
        displaySuccess(`Analyse terminée: ${analyses.length} photo(s)`);
      }
    } catch (error) {
      console.warn(`\n⚠️  Analyse automatique impossible: ${error.message}`);
    }
  }

  if (!analysisReady) {
    displayImportant('Étape 4/5: ANALYSE MANUELLE DES PHOTOS');

    const batchSize = 8;
    for (let start = 0; start < compressedToAnalyze.length; start += batchSize) {
      const batchNumber = Math.floor(start / batchSize) + 1;
      const batchDir = path.join(toAnalyzeDir, `lot-${String(batchNumber).padStart(2, '0')}`);
      await fs.mkdir(batchDir, { recursive: true });

      for (const photo of compressedToAnalyze.slice(start, start + batchSize)) {
        await fs.rename(photo.path, path.join(batchDir, photo.filename));
      }
    }

    try {
      await open(toAnalyzeDir);
      displaySuccess(`Dossiers d'analyse ouverts: ${toAnalyzeDir}`);
    } catch (error) {
      console.log(`\n⚠️  Impossible d'ouvrir l'Explorateur: ${error.message}`);
      console.log(`   Dossier: ${toAnalyzeDir}`);
    }

    console.log('\nEnvoyez chaque dossier lot-XX dans une conversation séparée.');
    console.log('Chaque dossier contient au maximum 8 photos.');
    console.log('Pour chaque photo, ajoutez type_vue (vue_ensemble|detail_defaut|autre), pertinence (0-100) et score_qualite (0-100) à son analyse.');
    if (context.type === 'entree') {
      console.log('Pour cet EDL d’entrée, notez uniquement les problèmes majeurs et évidents (gravité forte) ; ignorez usure normale et défauts mineurs.');
    } else {
      console.log('Pour cet EDL de sortie, décrivez précisément tous les défauts et dommages visibles, même mineurs, sans rien supposer.');
    }
    console.log('Regroupez ensuite les résultats dans analysis.json et relancez le programme.');

    const markerPath = path.join(projectRoot, 'output', 'waiting-for-analysis.flag');
    await fs.writeFile(markerPath, `waiting: ${new Date().toISOString()}`, 'utf8');
    displayTitle('✨ En attente de l\'analyse');
    return;
  }

  displayStep('Étape 5/5: Création de l\'EDL...');
  let draftCreated = false;

  try {
    await fs.access(analysisPath);
    displaySuccess(`analysis.json trouvé: ${analysisPath}`);

    const newOptions = {
      bien: context.bien,
      type: context.type,
      locataire: context.locataire.nom,
      locataireFamille: locataireNom,
      email: context.locataire.email,
      telephone: context.locataire.telephone || '',
      edlContextData,
      ...draftAnswers,
      chambre: context.locataire.chambre,
      lot: context.locataire.lot,
      date: context.date,
      adresseBien: context.adresseBien,
      photos: resolvedPhotosDir,
      analysis: analysisPath,
      precompressedPhotos: compressedToAnalyze
    };

    const result = await newCommand(newOptions);
    draftCreated = true;

    displaySuccess(`EDL brouillon créé: ${result.draftPath}`);
    displaySuccess(`Photos traitées: ${result.photosCount}`);
    if (result.analysisCount) {
      displaySuccess(`Analyse chargée: ${result.analysisCount} photo(s)`);
    }

    console.log(`\n📄 Fichier brouillon: ${result.draftPath}`);
    console.log(`🌐 Brouillon HTML: ${result.htmlPath} (ouvert dans le navigateur)`);
    if (result.reviewPath) {
      displaySuccess(`Fiche de revue synchronisée: ${result.reviewPath}`);
      console.log('\nPrompt à copier dans Vibe Work :\n');
      console.log(createDriveReviewPrompt(path.basename(result.draftPath), result.reviewPath));
      console.log('\nLaissez cette fenêtre ouverte pendant votre échange avec Vibe Work.');
      console.log('Cette fenêtre affiche le brouillon actuel et se mettra à jour automatiquement.');

      // BOUCLE ITÉRATIVE : permet plusieurs allers-retours avec Vibe Work
      let continueLoop = true;
      while (continueLoop) {
        const answer = (await askQuestion(
          '\nAvez-vous demandé des modifications à Vibe Work et souhaitez-vous consulter le nouveau brouillon ? (y/n): '
        )).trim().toLowerCase();

        if (answer === 'n' || answer === 'non' || answer === 'no') {
          continueLoop = false;
          break;
        }

        // Appliquer les modifications du dernier changes*.json
        try {
          const reviewResult = await applyDriveReview(
            projectRoot,
            path.basename(result.draftPath),
            { nom: locataireNom }
          );
          if (reviewResult.applied) {
            displaySuccess('Modifications appliquées. Rafraîchissez votre navigateur pour voir le brouillon mis à jour.');
            console.log(`🌐 Brouillon HTML: ${result.htmlPath}`);
            if (reviewResult.warning) console.warn(`⚠️ ${reviewResult.warning}`);
          } else {
            displaySuccess('Aucune modification appliquée.');
          }
        } catch (error) {
          console.warn(`⚠️ Impossible d\'appliquer les modifications : ${error.message}`);
          console.log('Vérifiez que Vibe Work a bien créé un fichier changes*.json dans le dossier Drive.');
          console.log('Si oui, réessayez. Sinon, attendez la confirmation de Vibe Work.');
        }
      }

      // Après la boucle, demander la génération du PDF
      if (await confirmPdfGeneration()) {
        try {
          const finalizeResult = await finalizeCommand(
            path.basename(result.draftPath),
            locataireNom
          );
          displaySuccess(`PDF généré: ${finalizeResult.pdfPath}`);
        } catch (error) {
          console.error(`Erreur pendant la génération du PDF : ${error.message}`);
          console.log('Le brouillon mis à jour est conservé. Vérifiez-le puis relancez la commande finalize.');
        }
      } else {
        displaySuccess('EDL terminé. Le brouillon est conservé sans PDF.');
      }
    } else if (result.reviewError) {
      console.warn(`⚠️ Fiche Drive non disponible : ${result.reviewError}`);
      console.log('Quand Drive sera disponible et la fiche publiée, lancez npm run apply-review.');
      console.log('Après vérification, vous pourrez générer le PDF avec :');
      console.log(`   node src/cli.js finalize ${path.basename(result.draftPath)} --locataire "${locataireNom}"`);

      if (await confirmPdfGeneration()) {
        try {
          const finalizeResult = await finalizeCommand(
            path.basename(result.draftPath),
            locataireNom
          );
          displaySuccess(`PDF généré: ${finalizeResult.pdfPath}`);
        } catch (error) {
          console.error(`Erreur pendant la génération du PDF : ${error.message}`);
          console.log('Le brouillon est conservé. Vérifiez-le puis relancez la commande finalize.');
        }
      }
    }
  } catch (error) {
    console.log('\n❌ Échec de la création ou de la finalisation de l’EDL.');
    console.log(`   Détail: ${error.message}`);
  }
  
  displayTitle(draftCreated ? '✨ EDL prêt' : '✨ Traitement terminé');
}

async function hasCompleteManualAnalysis(analysisPath, filenames) {
  try {
    const analyses = JSON.parse(await fs.readFile(analysisPath, 'utf8'));
    if (!Array.isArray(analyses)) return false;

    const names = new Set(analyses
      .filter(analysis => typeof analysis?.fichier === 'string')
      .map(analysis => analysis.fichier.toLowerCase()));
    return names.size === filenames.length &&
      filenames.every(filename => names.has(filename.toLowerCase()));
  } catch (error) {
    console.warn(`Impossible de réutiliser l’analyse manuelle: ${error.message}`);
    return false;
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

export async function confirmVibeReview(ask = askQuestion) {
  while (true) {
    const answer = (await ask(
      '\nAvez-vous confirmé avec Mistral Vibe que le brouillon vous convenait et que sa proposition changes*.json est complète ? (y/n): '
    )).trim().toLowerCase();
    if (['y', 'yes', 'o', 'oui'].includes(answer)) return true;
    if (['n', 'no', 'non'].includes(answer)) return false;
    console.log('Répondez par Y (oui) ou N (non).');
  }
}

export async function confirmPdfGeneration(ask = askQuestion) {
  while (true) {
    const answer = (await ask(
      '\nConfirmez-vous cette version et souhaitez-vous générer le PDF ? (y/n): '
    )).trim().toLowerCase();
    if (['y', 'yes', 'o', 'oui'].includes(answer)) return true;
    if (['n', 'no', 'non'].includes(answer)) return false;
    console.log('Répondez par Y (oui) ou N (non).');
  }
}

function getTypeLabel(type) {
  return type === 'entree' ? 'Entrée' : 'Sortie';
}

export async function confirmSuggestedType(suggestedType, ask = askQuestion) {
  let currentType = suggestedType;
  while (true) {
    console.log(`\nType d'état des lieux suggéré : ${getTypeLabel(currentType)}.`);
    const answer = (await ask('Confirmer ce type ? (Y/N): ')).trim().toLowerCase();
    if (answer === 'y') return currentType;
    if (answer === 'n') {
      currentType = currentType === 'entree' ? 'sortie' : 'entree';
      console.log(`Suggestion suivante : ${getTypeLabel(currentType)}.`);
      continue;
    }
    console.log('Répondez par Y (oui) ou N (non).');
  }
}

export function unwrapGeneratedContext(result) {
  const context = result?.context;
  if (!context || !context.locataire || typeof context.locataire.nom !== 'string' || !context.date) {
    throw new Error('La génération du contexte n’a pas retourné les informations attendues du locataire et de la date.');
  }
  return context;
}

// Lancer si ce fichier est exécuté directement
const isMainModule = process.argv[1]?.includes('launch.js');
if (isMainModule) {
  launch().catch(error => {
    console.error('\n❌ Erreur:', error.message);
    process.exit(1);
  });
}

export { launch };

export default { launch };
