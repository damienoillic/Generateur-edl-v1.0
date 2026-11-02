/**
 * Module seed - Crée le fichier data/biens.json avec le bien Massy
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(__dirname);
const biensPath = path.join(projectRoot, 'data', 'biens.json');

/**
 * Données du bien Massy
 */
const massyBien = {
  "massy": {
    "nom": "Massy — 2 place d'Allemagne, 91300 Massy",
    "surface": 84.16,
    "type": "T5",
    "pieces": {
      "chambre": [
        "Mur", "Plafond", "Porte", "Éclairage", "Prise", "Interrupteur", "Sol", 
        "Fenêtre", "Plinthes", "Porte-fenêtre", "Lit", "Table de chevet", 
        "Cadre", "Bureau", "Chaise", "Armoire", "Miroir", "Tapis", "Rideau", "Store"
      ],
      "salon": [
        "Mur", "Plafond", "Éclairage", "Prise", "Interrupteur", "Sol", 
        "Fenêtre", "Plinthes", "Canapé", "Meuble TV", "Téléviseur", "Table", 
        "Chaise", "Table basse", "Banc", "Store"
      ],
      "cuisine": [
        "Mur", "Plafond", "Éclairage", "Prise", "Interrupteur", "Sol", 
        "Plinthes", "Porte", "Fenêtre", "Plaque de cuisson", "Plan de travail", 
        "Évier", "Meuble de cuisine", "Four", "Réfrigérateur", "Micro-onde", 
        "Lave-vaisselle", "Hotte aspirante", "Bouilloire", "Grille-pain", "Interphone"
      ],
      "salle-deau-1": [
        "Mur", "Porte", "Plafond", "Éclairage", "VMC", "Prise", "Interrupteur", 
        "Sol", "Miroir", "Plinthes", "Lave-linge", "Douche", "Meuble vasque", "Sèche-serviette"
      ],
      "salle-deau-2": [
        "Mur", "Porte", "Plafond", "Éclairage", "VMC", "Prise", "Interrupteur", 
        "Sol", "Miroir", "Plinthes", "Douche", "WC", "Meuble vasque", "Sèche-serviette"
      ],
      "toilettes": [
        "Mur", "Porte", "Plafond", "Éclairage", "VMC", "Interrupteur", "Sol", 
        "WC", "Poubelle", "Brosse WC"
      ],
      "couloirs": [
        "Mur", "Plafond", "Éclairage", "Interrupteur", "Sol", "Plinthes", 
        "Placard", "Miroir"
      ]
    }
  }
};

/**
 * Crée le fichier biens.json
 */
export async function seedCommand() {
  try {
    // Créer le dossier data s'il n'existe pas
    await fs.mkdir(path.dirname(biensPath), { recursive: true });
    
    // Écrire le fichier
    await fs.writeFile(biensPath, JSON.stringify(massyBien, null, 2), 'utf8');
    
    return { success: true, path: biensPath };
  } catch (error) {
    throw new Error(`Erreur lors de la création de biens.json: ${error.message}`);
  }
}

export default { seedCommand };
