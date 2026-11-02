/**
 * Module finalize - Finalisation d'un EDL brouillon
 * 
 * Étapes:
 * 1. Lire le fichier JSON du brouillon
 * 2. Générer le HTML final (photos en base64 de manière sélective)
 * 3. Générer le PDF
 * 4. Déplacer le JSON vers data/edl/ avec son nom définitif
 * 5. Ouvrir le PDF généré
 */

import fs from 'fs/promises';
import path from 'path';
import open from 'open';
import { fileURLToPath } from 'url';
import { encodeSelectedToBase64 } from './images.js';
import { generateHtml } from './template.js';
import { generatePdf } from './pdf.js';
import { ensureEdlContext, matchesTenantIdentity } from './edl-context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(__dirname);

/**
 * Finalise un EDL brouillon
 * @param {string} draftFile - Nom du fichier JSON du brouillon
 * @param {string} locataireFamily - Nom de famille du locataire
 */
export async function finalizeCommand(draftFile, locataireFamily) {
  const edlContext = await ensureEdlContext(locataireFamily);
  
  let draftPath;
  if (draftFile.startsWith('data/') || draftFile.startsWith('output/') || path.isAbsolute(draftFile)) {
    draftPath = path.resolve(draftFile);
  } else {
    const edlDir = path.join(projectRoot, 'data', 'edl');
    draftPath = path.join(edlDir, draftFile);
  }
  
  console.log('\nLecture du brouillon...');
  let draftJson;
  try {
    const content = await fs.readFile(draftPath, 'utf8');
    draftJson = JSON.parse(content);
  } catch (error) {
    throw new Error(`Erreur lors de la lecture du fichier ${draftPath}: ${error.message}`);
  }
  
  validateDraft(draftJson);
  if (!matchesTenantIdentity(draftJson.locataire.nom, edlContext.locataire)) {
    throw new Error(`Le brouillon "${draftFile}" ne correspond pas au locataire "${locataireFamily}".`);
  }
  
  // Encoder sélectivement uniquement les photos du brouillon
  console.log('Encodage sélectif des photos en base64...');
  const mediaDir = path.join(projectRoot, 'output', 'media');
  const filenames = (draftJson.photos || []).map(p => p.fichier).filter(Boolean);
  const encodedPhotos = await encodeSelectedToBase64(mediaDir, filenames);
  
  const photosWithBase64 = (draftJson.photos || []).map(photo => {
    const encoded = encodedPhotos.find(p => p.filename === photo.fichier);
    return {
      ...photo,
      base64: encoded?.base64 || ''
    };
  });
  
  const finalJson = {
    ...draftJson,
    photos: photosWithBase64
  };
  
  console.log('Génération du HTML final...');
  const html = generateHtml(finalJson, false);
  
  const outputDir = path.join(projectRoot, 'output');
  await fs.mkdir(outputDir, { recursive: true });
  
  const htmlPath = path.join(outputDir, `edl-${draftJson.id}.html`);
  await fs.writeFile(htmlPath, html, 'utf8');
  console.log(`✓ HTML généré: ${htmlPath}`);
  
  console.log('Génération du PDF...');
  const locataireFormatted = draftJson.locataire.nom.replace(/[^a-zA-Z0-9]/g, '_');
  const typeFormatted = draftJson.type.charAt(0).toUpperCase() + draftJson.type.slice(1);
  const dateFormatted = draftJson.date.replace(/-/g, '.');
  const pdfFilename = `EDL ${typeFormatted} ${locataireFormatted} - ${dateFormatted}.pdf`;
  const pdfPath = path.join(outputDir, pdfFilename);
  
  const pdfResult = await generatePdf(html, pdfPath);
  console.log(`✓ PDF généré: ${pdfResult.path} (${(pdfResult.size / 1024 / 1024).toFixed(2)} MB)`);
  
  // Déplacer le JSON vers data/edl/
  const edlDir = path.join(projectRoot, 'data', 'edl');
  await fs.mkdir(edlDir, { recursive: true });
  const finalJsonPath = path.join(edlDir, `${draftJson.id}.json`);
  
  await fs.writeFile(finalJsonPath, JSON.stringify(finalJson, null, 2), 'utf8');
  console.log(`✓ JSON sauvegardé: ${finalJsonPath}`);
  
  // Supprimer le brouillon original
  try {
    await fs.unlink(draftPath);
    console.log(`✓ Brouillon supprimé: ${draftPath}`);
  } catch (error) {
    console.warn(`Impossible de supprimer le brouillon: ${error.message}`);
  }
  
  console.log('\n========================================');
  console.log('  EDL FINALISÉ AVEC SUCCÈS');
  console.log('========================================');
  console.log(`HTML: ${htmlPath}`);
  console.log(`PDF:  ${pdfPath}`);
  console.log(`JSON: ${finalJsonPath}`);
  console.log('========================================\n');

  try {
    console.log('Ouverture du PDF dans le navigateur...');
    await open(pdfPath);
  } catch (error) {
    console.warn(`Impossible d'ouvrir le PDF automatiquement: ${error.message}`);
  }
  
  return {
    htmlPath,
    pdfPath,
    jsonPath: finalJsonPath
  };
}

function validateDraft(draft) {
  const required = ['id', 'bien', 'type', 'locataire', 'date', 'etat_usure'];
  for (const field of required) {
    if (!draft[field]) {
      throw new Error(`Champ obligatoire manquant dans le brouillon: ${field}`);
    }
  }
}

export default { finalizeCommand };

