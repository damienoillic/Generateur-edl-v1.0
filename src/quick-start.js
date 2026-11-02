/**
 * Quick Start - Point d'entrée ultra-simplifié
 * 
 * Utilisation:
 *   node src/quick-start.js "Nom de famille"
 *   
 * Exemple:
 *   node src/quick-start.js "Dupont"
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { generateAndSaveContext } from './context-generator.js';
import { newCommand } from './new.js';
import { finalizeCommand } from './finalize.js';
import { collectMissingEdlAnswers } from './edl-clarification.js';
import { ensureEdlContext } from './edl-context.js';
import { resolveTenantPhotosDirectory } from './photo-source.js';

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
 * Affiche une erreur
 */
function displayError(message) {
  console.log(`❌ ${message}`);
}

/**
 * Point d'entrée du quick start
 */
async function quickStart() {
  // Récupérer le nom de famille depuis les arguments
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log(`
Utilisation: node src/quick-start.js "Nom de famille"

Exemple:
  node src/quick-start.js "Dupont"
  node src/quick-start.js "Martin"
`);
    process.exit(1);
  }
  
  const locataireNom = args[0];
  
  displayTitle(`EDL Quick Start - Locataire: ${locataireNom}`);
  
  try {
    // Générer le contexte
    displayTitle('🔍 Recherche des informations du locataire...');
    const edlContextData = await ensureEdlContext(locataireNom);
    const { context, contextPath } = await generateAndSaveContext(locataireNom, {
      requireVibeContext: false,
      promptForMissingContact: true,
      requireConfirmedContact: true,
      edlContextData
    });
    const draftAnswers = collectMissingEdlAnswers({});
    
    displaySuccess(`Contexte généré: ${contextPath}`);
    console.log(`  Type: ${context.type}`);
    console.log(`  Locataire: ${context.locataire.nom}`);
    console.log(`  Email: ${context.locataire.email}`);
    console.log(`  Chambre: ${context.locataire.chambre}`);
    console.log(`  Lot: ${context.locataire.lot}`);
    console.log(`  Date: ${context.date}`);
    console.log(`  Adresse du logement: ${context.adresseBien}`);

    const { photosDirectory: photosDir, imageCount } =
      await resolveTenantPhotosDirectory(locataireNom, context.type);
    displaySuccess(`Dossier photos trouvé: ${photosDir} (${imageCount} image(s))`);
    
    // Vérifier l'analyse (par défaut: context-analysis.json ou analysis.json)
    let analysisFile = path.join(projectRoot, 'analysis.json');
    
    try {
      const fs = await import('fs/promises');
      await fs.access(analysisFile);
    } catch (error) {
      analysisFile = path.join(projectRoot, 'context-analysis.json');
    }
    
    // Lancer la création de l'EDL
    displayTitle('📸 Création de l\'EDL...');
    
    const newOptions = {
      bien: context.bien,
      type: context.type,
      locataire: context.locataire.nom,
      email: context.locataire.email,
      telephone: context.locataire.telephone || '',
      edlContextData,
      ...draftAnswers,
      chambre: context.locataire.chambre,
      lot: context.locataire.lot,
      date: context.date,
      adresseBien: context.adresseBien,
      photos: photosDir,
      analysis: analysisFile
    };
    
    const result = await newCommand(newOptions);
    
    displaySuccess(`EDL brouillon créé: ${result.draftPath}`);
    displaySuccess(`Photos traitées: ${result.photosCount}`);
    if (result.analysisCount) {
      displaySuccess(`Analyse chargée: ${result.analysisCount} photo(s)`);
    }
    
    console.log(`\n📄 Fichier brouillon: ${result.draftPath}`);
    console.log(`🌐 Brouillon HTML: ${result.htmlPath} (ouvert dans le navigateur)`);
    
    // Proposer de finaliser
    const { stdin, stdout } = process;
    const readline = await import('readline/promises');
    const finalizeRl = readline.createInterface({ input: stdin, output: stdout });
    
    const shouldFinalize = (await finalizeRl.question('\nVoulez-vous finaliser cet EDL maintenant (PDF) ? (o/n): ')).trim().toLowerCase();
    finalizeRl.close();
    
    if (shouldFinalize === 'o' || shouldFinalize === 'oui' || shouldFinalize === 'y') {
      displayTitle('📄 Finalisation de l\'EDL...');
      const draftFilename = path.basename(result.draftPath);
      const finalizeResult = await finalizeCommand(draftFilename);
      displaySuccess(`EDL finalisé: ${finalizeResult.message}`);
      console.log(`📄 PDF: ${finalizeResult.pdfPath}`);
      console.log(`📄 HTML: ${finalizeResult.htmlPath}`);
    } else {
      console.log('\n⏸️  Finalisation reportée.');
      console.log(`   Pour finaliser plus tard: node src/cli.js finalize ${path.basename(result.draftPath)}`);
    }
    
    displayTitle('✨ Terminé !');
    
  } catch (error) {
    displayError(`Erreur: ${error.message}`);
    console.log('\nVeuillez vérifier:');
    console.log(`  - Le nom du locataire: "${locataireNom}"`);
    console.log(`  - Le dossier photos: ${path.join(process.env.EDL_PHOTOS_SOURCE_ROOT || 'C:\\Users\\damie\\Proton Drive\\damienoillic\\My files\\EDL', locataireNom)}`);
    console.log(`  - Le fichier analysis.json`);
    process.exit(1);
  }
}

// Lancer si ce fichier est exécuté directement
const isMainModule = process.argv[1]?.includes('quick-start.js');
if (isMainModule) {
  quickStart().catch(error => {
    console.error('Erreur:', error.message);
    process.exit(1);
  });
}

export { quickStart };

export default { quickStart };
