# EDL Tool - Version 1.0 (Édition Consolidée)

Outil CLI pour créer, analyser, réviser et finaliser des **États des Lieux (EDL)** pour locations meublées en colocation.

---

## 🌟 Nouveautés et Améliorations de la V1.0

1. **Revue assistée par Vibe Work via Google Drive (sans tunnel)** :
   - Plus besoin d'exposer un serveur MCP via tunnel Cloudflare. Le script publie automatiquement un dossier de revue dans Google Drive (`edl-review/`) avec un prompt prêt à copier.
   - Vibe Work génère les corrections dans un fichier `changes.json` que vous appliquez en direct depuis votre terminal.
2. **Gestion de l'Inventaire Partagé (`property-inventory.json`)** :
   - Ajout ou retrait durable d'équipements par pièce et par lot, conservé sur Google Drive et pris en compte pour tous les futurs EDL du lot.
3. **Optimisation des performances & mémoire** :
   - Encodage Base64 sélectif : seules les photos retenues dans l'EDL sont chargées et encodées, évitant la saturation de la RAM lors de la finalisation.
   - Mise en cache mémoire de la configuration des logements (`data/biens.json`).
4. **Robustesse de l'API Vision (Mistral `pixtral-12b`)** :
   - Détection explicite de l'épuisement de budget (HTTP 402) et bascule guidée vers les lots manuels.
   - Tolérance au renommage ou altération mineure des noms de fichiers par le modèle de vision.
5. **Codebase épurée** :
   - Suppression intégrale du code mort hérité (~400 lignes de code obsolète nettoyées).
   - Suite complète de 91 tests unitaires automatisés (`npm test`).

---

## 🚀 Démarrage rapide

### 1. Installation & Configuration

Assurez-vous que votre fichier `.env` est configuré à la racine :
```powershell
cd C:\Projet_EDL\edl-v1.0
# Si .env n'existe pas, copiez le modèle :
Copy-Item .env.example .env
```

Renseignez votre clé `MISTRAL_API_KEY` dans `.env` si vous souhaitez utiliser l'analyse automatique d'images.

### 2. Lancement guidé (Recommandé)

```powershell
npm run launch
# ou node src/launch.js
```

Le script vous guide pas à pas :
1. Saisie du nom de famille du locataire (recherché dans l'index Google Drive synchronisé).
2. Détection / confirmation automatique du type (Entrée ou Sortie).
3. Compression et analyse des photos (automatique ou manuelle par lots).
4. Création du brouillon et ouverture immédiate dans le navigateur.
5. Publication de la fiche de revue Drive avec prompt pour Vibe Work.
6. Application des modifications interactives puis génération du PDF.

---

## 🎯 Commandes disponibles

| Commande | Action |
|---|---|
| `npm run launch` | Workflow complet guidé pas à pas (création + revue + PDF) |
| `npm run quick-start -- "Nom"` | Création rapide en 1 commande |
| `npm run apply-review` | Applique les modifications `changes.json` de Vibe Work |
| `npm run finalize -- <draft.json> --locataire "Nom"` | Génère le PDF final pour un brouillon existant |
| `npm run compare -- <edl1.json> <edl2.json> --locataire "Nom"` | Compare deux EDL (ex: Entrée vs Sortie) |
| `npm run mcp` | Démarre le serveur MCP local pour connexion directe Vibe Work |
| `npm test` | Exécute la suite de tests unitaires (91 tests) |

---

## 📁 Architecture du projet

```
C:\Projet_EDL\edl-v1.0\
├── src/
│   ├── launch.js              # Point d'entrée principal interactif
│   ├── quick-start.js         # Mode rapide en 1 argument
│   ├── interactive.js         # Mode formulaire guidé
│   ├── cli.js                 # Dispatcher de commandes CLI
│   ├── drive-review.js        # Gestion de la revue via Google Drive (sans tunnel)
│   ├── draft-editor.js        # Moteur d'application des modifications de brouillon
│   ├── property-inventory.js  # Inventaire partagé du logement et du lot
│   ├── analyze.js             # Analyse des photos via Mistral Vision (pixtral-12b)
│   ├── images.js              # Compression Sharp (1200px max) & encodage base64
│   ├── photo-source.js        # Recherche automatique des photos (Proton Drive)
│   ├── photo-selection.js     # Déduplication SHA-256 et équilibrage vues/défauts
│   ├── edl-context.js         # Synchronisation source de vérité Google Drive
│   ├── context-generator.js   # Construction unifiée du contexte locataire/bien
│   ├── template.js            # Génération HTML avec galeries responsives
│   ├── pdf.js                 # Export PDF vectoriel A4 via Puppeteer
│   ├── finalize.js            # Finalisation et archivage de l'EDL
│   ├── compare.js             # Comparateur d'usure entrée / sortie
│   ├── edl-clarification.js   # Valeurs par défaut courantes
│   ├── mcp-server.js          # Serveur Model Context Protocol
│   └── seed.js                # Initialisation de la configuration Massy
├── data/
│   ├── biens.json             # Modèle de pièces et équipements du bien
│   └── edl/                   # Historique des EDL finalisés et brouillons
├── context/                   # Cache local des contextes locataires Drive
├── output/
│   ├── media/                 # Photos compressées
│   ├── brouillon.html         # Aperçu en direct du brouillon
│   └── *.pdf                  # Fichiers PDF générés
├── tests/                     # 91 tests unitaires (couverture complète)
├── package.json
└── README.md
```

