# ⚡ Quick Start - EDL Tool V1.0

## 🎯 En 1 commande

```powershell
cd C:\Projet_EDL\edl-v1.0
npm run launch
```

Répondez simplement aux questions :
1. **Nom du locataire** (ex: `BANIZA`)
2. **Confirmation du type d'EDL** (suggéré automatiquement selon l'historique)
3. **Date de l'EDL** (format AAAA-MM-JJ)

---

## 🔄 Les deux façons de réviser un brouillon avec Mistral Vibe

### Option 1 (Recommandée) : Revue Google Drive sans tunnel
1. Lors de l'exécution de `npm run launch`, le programme génère le brouillon HTML et publie un dossier dans Google Drive (`edl-review/<brouillon>`).
2. Un **prompt complet** est affiché dans votre terminal.
3. Copiez ce prompt dans **Mistral Vibe Work** et échangez normalement pour lui indiquer vos corrections.
4. Dès que Vibe a rédigé les corrections dans le fichier partagé `changes.json`, confirmez dans votre terminal (`y`).
5. Le terminal applique immédiatement les modifications, actualise le brouillon HTML et vous propose de générer le PDF.

### Option 2 : Serveur MCP direct
1. Lancez `npm run mcp`.
2. Connectez Vibe Work via tunnel HTTPS à l'endpoint `/mcp` avec le token d'authentification `EDL_MCP_TOKEN`.
3. Vibe Work appelle directement les outils `suggest_edl_type`, `create_edl_draft`, `read_edl_draft` et `propose_edl_changes`.

---

## 📄 Finalisation manuelle

Si vous préférez finaliser un brouillon plus tard :

```powershell
npm run finalize -- draft-entree-BANIZA-20261102-1234.json --locataire "BANIZA"
```
Le PDF A4 est créé dans `output/` et s'ouvre automatiquement dans votre navigateur.

