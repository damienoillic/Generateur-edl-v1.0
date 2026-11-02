/**
 * Module compare - Comparaison de deux EDL (itération 3)
 * 
 * Génère un tableau des écarts entre deux états des lieux
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateHtml } from './template.js';
import { generatePdf } from './pdf.js';
import { ensureEdlContext, matchesTenantIdentity } from './edl-context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(__dirname);

/**
 * Compare deux EDL et génère un rapport
 * @param {string} edl1File - Premier EDL (ex: entree-baniza-2026-10-30.json)
 * @param {string} edl2File - Deuxième EDL
 * @param {string} locataireFamily - Nom de famille du locataire
 */
export async function compareCommand(edl1File, edl2File, locataireFamily) {
  const context = await ensureEdlContext(locataireFamily);
  // Résoudre les chemins
  let edl1Path, edl2Path;
  
  if (edl1File.startsWith('data/') || path.isAbsolute(edl1File)) {
    edl1Path = path.resolve(edl1File);
  } else {
    edl1Path = path.join(projectRoot, 'data', 'edl', edl1File);
  }
  
  if (edl2File.startsWith('data/') || path.isAbsolute(edl2File)) {
    edl2Path = path.resolve(edl2File);
  } else {
    edl2Path = path.join(projectRoot, 'data', 'edl', edl2File);
  }
  
  // Lire les EDL
  console.log('\nLecture des EDL...');
  const edl1 = await readEdl(edl1Path);
  const edl2 = await readEdl(edl2Path);
  if (
    !matchesTenantIdentity(edl1.locataire?.nom, context.locataire) ||
    !matchesTenantIdentity(edl2.locataire?.nom, context.locataire)
  ) {
    throw new Error(`Les deux EDL doivent correspondre au locataire "${locataireFamily}".`);
  }
  
  // Valider que les EDL sont comparables
  validateComparison(edl1, edl2);
  
  // Trouver les différences
  const differences = findDifferences(edl1, edl2);
  
  // Afficher le rapport en console
  console.log('\nComparaison des EDL:');
  displayComparisonReport(differences);
  
  // Générer le HTML de comparaison
  const html = generateComparisonHtml(edl1, edl2, differences);
  
  // Sauvegarder le HTML
  const outputDir = path.join(projectRoot, 'output');
  await fs.mkdir(outputDir, { recursive: true });
  
  const htmlPath = path.join(outputDir, `comparaison-${edl1.id}-${edl2.id}.html`);
  await fs.writeFile(htmlPath, html, 'utf8');
  
  // Générer le PDF
  const pdfPath = path.join(outputDir, `Comparaison ${edl1.locataire.nom} ${edl1.date} - ${edl2.date}.pdf`);
  await generatePdf(html, pdfPath);
  
  console.log(`\nRapport de comparaison généré: ${htmlPath}`);
  console.log(`PDF généré: ${pdfPath}`);
  
  return {
    htmlPath,
    pdfPath,
    differences
  };
}

/**
 * Lit un fichier EDL
 */
async function readEdl(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Erreur lors de la lecture de ${filePath}: ${error.message}`);
  }
}

/**
 * Valide que deux EDL peuvent être comparés
 */
function validateComparison(edl1, edl2) {
  if (edl1.bien !== edl2.bien) {
    console.warn(`Les EDL sont pour des biens différents: ${edl1.bien} vs ${edl2.bien}`);
  }
  
  if (edl1.locataire.nom !== edl2.locataire.nom) {
    console.warn(`Les EDL sont pour des locataires différents: ${edl1.locataire.nom} vs ${edl2.locataire.nom}`);
  }
}

/**
 * Trouve les différences entre deux EDL
 */
function findDifferences(edl1, edl2) {
  const differences = [];
  
  // Comparer chaque pièce
  const allPieces = new Set([
    ...Object.keys(edl1.etat_usure || {}),
    ...Object.keys(edl2.etat_usure || {})
  ]);
  
  for (const piece of allPieces) {
    const piece1 = edl1.etat_usure?.[piece] || {};
    const piece2 = edl2.etat_usure?.[piece] || {};
    
    const allElements = new Set([
      ...Object.keys(piece1),
      ...Object.keys(piece2)
    ]);
    
    for (const element of allElements) {
      const state1 = piece1[element] || ['', ''];
      const state2 = piece2[element] || ['', ''];
      
      // Comparer l'état
      const etatChanged = state1[0] !== state2[0];
      // Comparer les observations
      const obsChanged = state1[1] !== state2[1];
      
      if (etatChanged || obsChanged) {
        differences.push({
          piece,
          element,
          etatEntree: state1[0] || 'Non renseigné',
          etatSortie: state2[0] || 'Non renseigné',
          observationEntree: state1[1] || '',
          observationSortie: state2[1] || '',
          type: etatChanged ? 'etat' : 'observation'
        });
      }
    }
  }
  
  return differences;
}

/**
 * Affiche le rapport de comparaison en console
 */
function displayComparisonReport(differences) {
  if (differences.length === 0) {
    console.log('  Aucun écart trouvé entre les deux EDL.');
    return;
  }
  
  console.log(`  ${differences.length} écart(s) trouvé(s):\n`);
  
  for (const diff of differences) {
    console.log(`  - ${formatPieceName(diff.piece)} > ${diff.element}`);
    console.log(`    Entrée: ${diff.etatEntree}`);
    console.log(`    Sortie: ${diff.etatSortie}`);
    if (diff.observationEntree) {
      console.log(`    Obs entrée: ${diff.observationEntree}`);
    }
    if (diff.observationSortie) {
      console.log(`    Obs sortie: ${diff.observationSortie}`);
    }
    console.log('');
  }
}

/**
 * Génère le HTML de comparaison
 */
function generateComparisonHtml(edl1, edl2, differences) {
  const locataire = edl1.locataire.nom;
  const date1 = formatDate(edl1.date);
  const date2 = formatDate(edl2.date);
  
  let html = `
    <!DOCTYPE html>
    <html lang="fr">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Comparaison EDL - ${locataire}</title>
      <style>
        ${getComparisonCss()}
      </style>
    </head>
    <body>
      <div class="container">
        <header>
          <h1>COMPARAISON DES ÉTATS DES LIEUX</h1>
          <p class="subtitle">Locataire: ${locataire}</p>
          <p>Entrée: ${date1} | Sortie: ${date2}</p>
        </header>
        
        <section>
          <h2>Écarts détectés (${differences.length})</h2>
          
          ${differences.length === 0 ? '<p>Aucun écart trouvé entre les deux états des lieux.</p>' : ''}
          
          ${differences.length > 0 ? `
            <table class="comparison-table">
              <thead>
                <tr>
                  <th>Pièce</th>
                  <th>Élément</th>
                  <th>État à l'entrée</th>
                  <th>État à la sortie</th>
                  <th>Observations entrée</th>
                  <th>Observations sortie</th>
                </tr>
              </thead>
              <tbody>
                ${differences.map(diff => `
                  <tr>
                    <td>${formatPieceName(diff.piece)}</td>
                    <td>${diff.element}</td>
                    <td>${diff.etatEntree}</td>
                    <td>${diff.etatSortie}</td>
                    <td>${diff.observationEntree}</td>
                    <td>${diff.observationSortie}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          ` : ''}
        </section>
        
        <footer>
          <p>Document généré le ${formatDate(new Date().toISOString().split('T')[0])}</p>
        </footer>
      </div>
    </body>
    </html>`;
  
  return html;
}

/**
 * CSS pour la page de comparaison
 */
function getComparisonCss() {
  return `
    @charset "UTF-8";
    
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: Georgia, "Times New Roman", Times, serif;
      font-size: 12px;
      line-height: 1.4;
      color: #333;
      background-color: #fff;
    }
    
    @page {
      size: A4;
      margin: 14mm;
    }
    
    .container {
      max-width: 860px;
      margin: 0 auto;
      padding: 20px;
    }
    
    header {
      margin-bottom: 30px;
      text-align: center;
    }
    
    header h1 {
      font-size: 20px;
      font-weight: bold;
      color: #1f3a5f;
      margin-bottom: 10px;
      background-color: #1f3a5f;
      color: white;
      padding: 15px;
    }
    
    .subtitle {
      font-size: 14px;
      font-weight: bold;
      margin-bottom: 5px;
    }
    
    section {
      margin-bottom: 25px;
    }
    
    h2 {
      font-size: 14px;
      font-weight: bold;
      color: #1f3a5f;
      background-color: #eef2f7;
      padding: 10px 15px;
      margin-bottom: 15px;
    }
    
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 15px;
    }
    
    table th {
      background-color: #1f3a5f;
      color: white;
      font-weight: bold;
      padding: 10px;
      text-align: left;
      border: 1px solid #b9c4d2;
    }
    
    table td {
      padding: 10px;
      border: 1px solid #b9c4d2;
      vertical-align: top;
    }
    
    table tr:nth-child(even) td {
      background-color: #f8f9fa;
    }
    
    footer {
      margin-top: 40px;
      text-align: right;
      font-style: italic;
      font-size: 10px;
      color: #555;
    }
    
    @media print {
      table th {
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
    }`;
}

/**
 * Formate le nom d'une pièce
 */
function formatPieceName(name) {
  const labels = {
    'chambre': 'Chambre',
    'salon': 'Salon',
    'cuisine': 'Cuisine',
    'salle-deau-1': 'Salle de bain 1',
    'salle-deau-2': 'Salle de bain 2',
    'toilettes': 'Toilettes',
    'couloirs': 'Couloirs',
    'indetermine': 'Pièce à déterminer'
  };
  return labels[name] || name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * Formate une date (YYYY-MM-DD -> DD/MM/YYYY)
 */
function formatDate(dateString) {
  if (!dateString) return '';
  const [year, month, day] = dateString.split('-');
  return `${day}/${month}/${year}`;
}

export default { compareCommand };
