/**
 * Module template - Génération du HTML de l'EDL
 * 
 * Structure du HTML:
 * - Titre et mention légale
 * - Informations générales
 * - Tableaux par pièce (État d'usure)
 * - Relevés des compteurs
 * - Remise des clés
 * - Observations générales
 * - Bloc signatures
 * - Annexe photo
 */

import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

/**
 * États d'usure normalisés
 */
export const ETATS_USURE = [
  "Très bon état",
  "Neuf",
  "Bon état",
  "État moyen",
  "Mauvais état",
  "Cassé(e)",
  "À vérifier"
];

/**
 * Génère le HTML complet de l'EDL
 * @param {object} edl - Données de l'EDL
 * @param {boolean} isDraft - Si true, ajoute le filigrane "BROUILLON"
 * @returns {string} HTML complet
 */
export function generateHtml(edl, isDraft = false) {
  const { bien, type, locataire, bailleur, date, etat_usure, photos, cles, securite, proprete, reserves_bailleur, reserves_locataire } = edl;
  
  const bienData = edl.bien_data || getBienData(bien);
  const title = type === 'sortie'
    ? "ÉTAT DES LIEUX DE SORTIE"
    : "ÉTAT DES LIEUX D'ENTRÉE";
  
  // Générer les sections
  const identificationHtml = generateIdentification(edl, bienData);
  const piecesHtml = generatePiecesSection(
    etat_usure,
    bien,
    bienData,
    isDraft,
    edl.edl_reference,
    type,
    edl.etat_usure_entree
  );
  const clesHtml = generateClesSection(cles);
  const observationsHtml = generateObservationsSection(securite, proprete, reserves_bailleur, reserves_locataire);
  const signaturesHtml = generateSignaturesSection(
    date,
    edl.adresse_bien || bienData?.adresse || bienData?.nom
  );
  const annexeHtml = generateAnnexePhoto(photos, isDraft);
  
  // Assembler le HTML
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    ${getCss()}
  </style>
</head>
<body>
  <div class="container">
    <!-- En-tête -->
    <header class="header">
      <h1>${title}</h1>
      <p class="legal-notice">
        État des lieux contradictoire à annexer au contrat de location dont il ne peut être dissocié.
      </p>
      ${isDraft ? '<div class="draft-watermark">BROUILLON</div>' : ''}
    </header>

    <!-- Informations générales -->
    ${identificationHtml}

    <!-- Pièces -->
    ${piecesHtml}

    <div class="page-break"></div>

    <!-- Clés -->
    ${clesHtml}

    <!-- Observations -->
    ${observationsHtml}

    <!-- Signatures -->
    ${signaturesHtml}

    <div class="page-break"></div>

    <!-- Annexe photo -->
    ${annexeHtml}

  </div>
</body>
</html>`;
}

/**
 * Génère la section d'identification
 */
function generateIdentification(edl, bienData) {
  const { locataire, bailleur, date } = edl;
  const chambre = locataire?.chambre || '';
  const bienNom = edl.adresse_bien || bienData?.nom || 'Adresse du logement non configurée';
  const surface = bienData?.surface ? `${bienData.surface} m²` : '';
  
  return `
    <section class="section">
      <h2 class="section-title">Informations générales</h2>
      
      <div class="identification-grid">
        <div class="identification-item">
          <strong>Date :</strong> ${formatDate(date)}
        </div>
        <div class="identification-item">
          <strong>Adresse :</strong> ${bienNom}
        </div>
        <div class="identification-item">
          <strong>Surface :</strong> ${surface}
        </div>
        <div class="identification-item full-width">
          <strong>Chambre louée :</strong> ${chambre}
        </div>
      </div>

      <div class="identification-grid">
        <div class="identification-block">
          <h3>Bailleur</h3>
          <p><strong>Nom :</strong> ${bailleur?.nom || ''}</p>
          <p><strong>Adresse :</strong> ${bailleur?.adresse || ''}</p>
        </div>
        <div class="identification-block">
          <h3>Locataire</h3>
          <p><strong>Nom :</strong> ${locataire?.nom || ''}</p>
          <p><strong>Téléphone :</strong> ${locataire?.telephone || ''}</p>
          <p><strong>Email :</strong> ${locataire?.email || ''}</p>
        </div>
      </div>
    </section>`;
}

/**
 * Génère les tableaux par pièce
 */
function generatePiecesSection(etat_usure, bien, bienData, isDraft, reference, type, etatUsureEntree = {}) {
  let html = '';
  const pieces = bienData?.pieces || Object.fromEntries(
    Object.entries(etat_usure || {}).map(([pieceName, elements]) => [
      pieceName,
      Object.keys(elements || {})
    ])
  );
  if (Object.keys(pieces).length === 0) return '';
  
  // Note de pré-remplissage
  if (isDraft && type === 'sortie') {
    const sourceLabel = reference
      ? `${escapeHtml(reference.type || '')}${reference.date ? ` du ${escapeHtml(reference.date)}` : ''} — ${escapeHtml(reference.locataire || '')}`
      : '';
    const defects = (reference?.defauts_documentes || []).map(defect =>
      `<li>${escapeHtml(defect.photo || '')} : ${escapeHtml(defect.defaut || '')}</li>`
    ).join('');
    html += `
      <section class="section">
        <p class="prefill-note">États repris du contexte de référence lorsqu'ils sont disponibles ; les champs vides restent à compléter.${sourceLabel ? ` Source : ${sourceLabel}.` : ''}</p>
        ${defects ? `<p>Défauts documentés dans la source :</p><ul>${defects}</ul>` : ''}
      </section>`;
  }
  
  for (const [pieceName, elements] of Object.entries(pieces)) {
    const pieceLabel = formatPieceName(pieceName);
    const pieceState = etat_usure?.[pieceName] || {};
    const referenceRoom = {
      salon: 'salon',
      cuisine: 'cuisine',
      'salle-deau-1': 'salle_eau_1',
      'salle-deau-2': 'salle_eau_2',
      toilettes: 'wc',
      couloirs: 'couloir'
    }[pieceName];
    const referenceSummary = referenceRoom && typeof reference?.parties_communes?.[referenceRoom] === 'string'
      ? reference.parties_communes[referenceRoom].trim()
      : '';
    const knownStates = ['Très bon état', 'Neuf', 'Bon état', 'État moyen', 'Mauvais état', 'Cassé(e)', 'À vérifier'];
    const summaryNote = isDraft && type === 'sortie' && referenceSummary &&
      !knownStates.some(state => state.toLocaleLowerCase() === referenceSummary.toLocaleLowerCase())
      ? `<p class="prefill-note">Résumé de l'EDL d'entrée : ${escapeHtml(referenceSummary)} (à vérifier et reporter aux éléments concernés).</p>`
      : '';
    
    html += `
      <section class="section">
        <h2 class="section-title">Pièce : ${escapeHtml(bienData?.piece_labels?.[pieceName] || pieceLabel)}</h2>
        ${summaryNote}
        <table class="state-table">
          <thead>
            <tr>
              <th>Élément / équipement</th>
              <th>Nombre</th>
              ${type === 'sortie'
                ? "<th>État d'usure à l'entrée</th><th>État d'usure à la sortie</th>"
                : "<th>État d'usure</th>"}
              <th>Observation(s)</th>
            </tr>
          </thead>
          <tbody>`;
    
    for (const element of elements) {
      const state = pieceState[element] || ['', ''];
      const etat = state[0] || '';
      const observation = state[1] || '';
      const etatEntree = etatUsureEntree?.[pieceName]?.[element]?.[0] || '';
      
      html += `
            <tr>
              <td>${element}</td>
              <td>1</td>
              ${type === 'sortie' ? `<td>${etatEntree}</td>` : ''}
              <td>${etat}</td>
              <td>${observation}</td>
            </tr>`;
    }

    html += `
          </tbody>
        </table>
      </section>`;
  }
  
  return html;
}

/**
 * Génère la section de remise des clés
 */
function generateClesSection(cles) {
  if (!cles || cles.length === 0) return '';
  
  let html = `
    <section class="section">
      <h2 class="section-title">Remise des clés</h2>
      <table class="cles-table">
        <thead>
          <tr>
            <th>Type</th>
            <th>Nombre</th>
            <th>Date</th>
            <th>Observations</th>
          </tr>
        </thead>
        <tbody>`;
  
  for (const cle of cles) {
    html += `
          <tr>
            <td>${cle.type || ''}</td>
            <td>${cle.nombre || ''}</td>
            <td>${cle.date || ''}</td>
            <td>${cle.observations || ''}</td>
          </tr>`;
  }
  
  html += `
        </tbody>
      </table>
    </section>`;
  
  return html;
}

/**
 * Génère la section des observations
 */
function generateObservationsSection(securite, proprete, reserves_bailleur, reserves_locataire) {
  return `
    <section class="section">
      <h2 class="section-title">Observations générales et réserves</h2>
      <div class="observations-grid">
        <div class="observation-item">
          <strong>Détecteur de fumée :</strong> ${securite?.detecteur_fumee || ''}
        </div>
        <div class="observation-item">
          <strong>État de propreté générale :</strong> ${proprete || ''}
        </div>
        <div class="observation-item full-width">
          <strong>Réserves du bailleur :</strong> ${reserves_bailleur || ''}
        </div>
        <div class="observation-item full-width">
          <strong>Réserves du locataire :</strong> ${reserves_locataire || ''}
        </div>
      </div>
    </section>`;
}

/**
 * Génère le bloc des signatures
 */
function generateSignaturesSection(date, address) {
  const signingCity = address?.split(',').at(-1).trim().replace(/^\d{5}\s+/, '') || 'Massy';
  return `
    <section class="section signatures-section">
      <p class="signatures-intro">
        Ainsi fait contradictoirement et signé à ${escapeHtml(signingCity)}, le ${formatDate(date)}
      </p>
      <div class="signatures-grid">
        <div class="signature-block">
          <p class="signature-title">Le Bailleur</p>
          <div class="signature-line"></div>
        </div>
        <div class="signature-block">
          <p class="signature-title">Le Locataire</p>
          <div class="signature-line"></div>
        </div>
      </div>
    </section>`;
}

/**
 * Génère l'annexe photo
 */
function generateAnnexePhoto(photos, isDraft) {
  if (!photos || photos.length === 0) return '';
  
  let html = `
    <section class="section">
      <h2 class="section-title">ANNEXE PHOTO</h2>`;
  
  // Regrouper les photos par pièce
  const photosByPiece = {};
  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i];
    const piece = photo.piece || 'indetermine';
    
    if (!photosByPiece[piece]) {
      photosByPiece[piece] = [];
    }
    
    photosByPiece[piece].push({ ...photo, index: i });
  }
  
  // Générer pour chaque pièce
  for (const [pieceName, piecePhotos] of Object.entries(photosByPiece)) {
    const pieceLabel = formatPieceName(pieceName);
    
    html += `
      <h3 class="annexe-subtitle">${pieceLabel}</h3>
      <div class="photo-grid">`;
    
    for (let i = 0; i < piecePhotos.length;) {
      const orientation = piecePhotos[i].orientation === 'portrait' ? 'portrait' : 'paysage';
      const rowSize = orientation === 'portrait' ? 3 : 2;
      const group = [];
      while (
        i < piecePhotos.length &&
        group.length < rowSize &&
        (piecePhotos[i].orientation === 'portrait' ? 'portrait' : 'paysage') === orientation
      ) {
        group.push(piecePhotos[i]);
        i += 1;
      }

      html += `<div class="photo-row photo-row--${orientation}">`;
      
      for (const photo of group) {
        const photoIndex = photo.index + 1;
        const legend = photo.legende || photo.commentaire || photo.description || photo.fichier || `Photo ${photoIndex}`;
        const photoNumber = `P${String(photoIndex).padStart(2, '0')}`;
        
        // Pour le brouillon, utiliser le chemin local
        // Pour le final, utiliser base64
        let imgSrc;
        if (isDraft) {
          imgSrc = `./media/${photo.fichier}`;
        } else {
          imgSrc = photo.base64 || `./media/${photo.fichier}`;
        }
        
        html += `
          <div class="photo-item">
            <img src="${imgSrc}" alt="${legend}">
            <p class="photo-legend">${photoNumber} — ${legend}</p>
          </div>`;
      }
      
      html += '</div>';
    }
    
    html += '</div>';
  }
  
  html += '</section>';
  
  return html;
}

/**
 * CSS du document
 */
function getCss() {
  return `
    @charset "UTF-8";
    
    /* Réinitialisation */
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    /* Police */
    body {
      font-family: Georgia, "Times New Roman", Times, serif;
      font-size: 12px;
      line-height: 1.4;
      color: #333;
      background-color: #fff;
    }
    
    /* Container */
    .container {
      max-width: 860px;
      margin: 0 auto;
      padding: 20px;
    }
    
    /* CSS d'impression */
    @page {
      size: A4;
      margin: 14mm;
    }
    
    /* Saut de page */
    .page-break {
      page-break-before: always;
    }
    
    /* En-tête */
    .header {
      margin-bottom: 30px;
      text-align: center;
      position: relative;
    }
    
    .header h1 {
      font-size: 24px;
      font-weight: bold;
      color: #1f3a5f;
      margin-bottom: 10px;
      padding: 15px;
      background-color: #1f3a5f;
      color: white;
    }
    
    .legal-notice {
      font-style: italic;
      font-size: 10px;
      color: #555;
      margin-bottom: 20px;
    }
    
    .draft-watermark {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      font-size: 100px;
      font-weight: bold;
      color: rgba(200, 200, 200, 0.5);
      z-index: -1;
      opacity: 0.3;
    }
    
    /* Sections */
    .section {
      margin-bottom: 25px;
    }
    
    .section-title {
      font-size: 14px;
      font-weight: bold;
      color: white;
      background-color: #1f3a5f;
      padding: 10px 15px;
      margin-bottom: 15px;
      text-transform: uppercase;
    }
    
    /* Tableaux */
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 15px;
    }
    
    table th {
      background-color: #eef2f7;
      color: #1f3a5f;
      font-weight: bold;
      padding: 8px 10px;
      text-align: left;
      border: 1px solid #b9c4d2;
    }
    
    table td {
      padding: 8px 10px;
      border: 1px solid #b9c4d2;
      vertical-align: top;
    }
    
    table tr:nth-child(even) td {
      background-color: #f8f9fa;
    }
    
    .state-table td:nth-child(1) {
      font-weight: 500;
    }
    
    /* Identification */
    .identification-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 15px;
      margin-bottom: 20px;
    }
    
    .identification-item {
      margin-bottom: 8px;
    }
    
    .identification-item.full-width {
      grid-column: 1 / -1;
    }
    
    .identification-block {
      background-color: #f8f9fa;
      padding: 15px;
      border-radius: 5px;
      border: 1px solid #b9c4d2;
    }
    
    .identification-block h3 {
      font-size: 14px;
      margin-bottom: 10px;
      color: #1f3a5f;
    }
    
    /* Observations */
    .observations-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 15px;
    }
    
    .observation-item {
      margin-bottom: 8px;
    }
    
    .observation-item.full-width {
      grid-column: 1 / -1;
    }
    
    /* Signatures */
    .signatures-section {
      margin-top: 40px;
    }
    
    .signatures-intro {
      text-align: center;
      margin-bottom: 30px;
      font-size: 14px;
    }
    
    .signatures-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 40px;
    }
    
    .signature-block {
      text-align: center;
    }
    
    .signature-title {
      font-size: 14px;
      font-weight: bold;
      margin-bottom: 40px;
    }
    
    .signature-line {
      height: 1px;
      width: 200px;
      background-color: #000;
      margin: 0 auto 10px;
    }
    
    /* Annexe photo */
    .annexe-subtitle {
      font-size: 14px;
      font-weight: bold;
      color: #1f3a5f;
      margin: 20px 0 15px;
      border-bottom: 2px solid #eef2f7;
      padding-bottom: 5px;
    }
    
    .photo-grid {
      display: flex;
      flex-direction: column;
      gap: 15px;
    }
    
    .photo-row {
      display: flex;
      gap: 15px;
    }
    
    .photo-item {
      flex: 1;
      min-width: 0;
    }

    .photo-row--portrait .photo-item {
      flex: 0 0 calc((100% - 30px) / 3);
    }

    .photo-row--paysage .photo-item {
      flex: 0 0 calc((100% - 15px) / 2);
    }
    
    .photo-item img {
      width: 100%;
      height: auto;
      border: 1px solid #b9c4d2;
      display: block;
    }
    
    .photo-legend {
      font-size: 10px;
      color: #555;
      margin-top: 5px;
      text-align: center;
    }
    
    /* Notes */
    .prefill-note {
      font-style: italic;
      font-size: 10px;
      color: #555;
      margin-bottom: 20px;
      background-color: #fff9f9;
      padding: 8px 12px;
      border-left: 3px solid #ffcccc;
    }
    
    /* Impression */
    @media print {
      body {
        background-color: white;
      }
      
      .header h1 {
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
      
      .section-title {
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
      
      table th {
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
        background-color: #eef2f7 !important;
      }
    }`;
}

let cachedBiens = null;

/**
 * Récupère les données d'un bien
 */
function getBienData(bienName) {
  if (!cachedBiens) {
    const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const biensPath = path.join(projectRoot, 'data', 'biens.json');
    try {
      cachedBiens = JSON.parse(readFileSync(biensPath, 'utf8'));
    } catch {
      return null;
    }
  }
  return cachedBiens?.[bienName] || null;
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

export default {
  generateHtml,
  ETATS_USURE
};
