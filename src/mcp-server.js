import { createServer as createHttpServer } from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import 'dotenv/config';
import { generateContext, suggestTypeForLocataire } from './context-generator.js';
import { newCommand } from './new.js';
import { compressAllImages } from './images.js';
import { analyzeAllPhotos, isMistralConfigured } from './analyze.js';
import { ensureEdlContext } from './edl-context.js';
import { DEFAULT_EDL_ANSWERS } from './edl-clarification.js';
import {
  confirmDraftChanges,
  proposeDraftChanges,
  readDraftForTenant
} from './draft-editor.js';
import { ETATS_USURE } from './template.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(__dirname);
const MAX_REQUEST_BODY_SIZE = 1024 * 1024;
let generationInProgress = false;

const toolInputSchema = z.object({
  locataire_nom: z.string().trim().min(1).describe('Nom de famille du locataire, utilisé pour sélectionner son contexte Google Drive.'),
  type_edl: z.enum(['entree', 'sortie']).describe('Type d’EDL confirmé par l’utilisateur après la suggestion de suggest_edl_type.'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Date de l’état des lieux au format AAAA-MM-JJ.'),
  dossier_photos: z.string().trim().min(1).describe('Chemin local du dossier de photos sur le PC, sous EDL_PHOTOS_ROOT.'),
  email: z.string().trim().email().optional().describe('Adresse email réelle si connue. Si absente, le serveur indique à Vibe Work de la demander avant de relancer.'),
  telephone: z.string().trim().min(1).optional().describe('Numéro de téléphone réel si connu. Si absent, le serveur indique à Vibe Work de le demander avant de relancer.'),
  chambre: z.string().trim().min(1).optional().describe('Description de la chambre si connue.'),
  lot: z.string().trim().min(1).optional().describe('Numéro de lot si connu.'),
  bien: z.string().trim().min(1).optional().describe('Clé du bien si connue, sinon le bien par défaut est utilisé.'),
  adresse_bien: z.string().trim().min(1).optional().describe('Adresse complète si connue, sinon utilise l’adresse configurée pour le bien.'),
  compteur_electricite: z.string().trim().min(1).optional(),
  compteur_eau_froide: z.string().trim().min(1).optional(),
  compteur_eau_chaude: z.string().trim().min(1).optional(),
  detecteur_fumee: z.enum(['présent', 'absent']).optional().describe('État du détecteur, facultatif. Par défaut : présent.'),
  proprete: z.string().trim().min(1).optional().describe(`Par défaut : ${DEFAULT_EDL_ANSWERS.proprete}.`),
  reserves_bailleur: z.string().trim().min(1).optional().describe(`Par défaut : ${DEFAULT_EDL_ANSWERS.reservesBailleur}`),
  reserves_locataire: z.string().trim().min(1).optional().describe(`Par défaut : ${DEFAULT_EDL_ANSWERS.reservesLocataire}`),
  etat_usure: z.record(z.string(), z.record(z.string(), z.object({
    etat: z.string().trim().min(1),
    observation: z.string().optional()
  }))).optional().describe('États confirmés par pièce et élément. À renseigner progressivement si aucun EDL précédent n’existe.')
});

const draftFileSchema = z.string().regex(/^draft-[\w.-]+\.json$/i)
  .describe('Nom du brouillon draft-*.json retourné par create_edl_draft, sans chemin.');
const photoNumberSchema = z.string().regex(/^P\d{2,}$/i);
const draftChangeSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('update_photo_defect'),
    photo_number: photoNumberSchema,
    current_description: z.string().min(1),
    new_description: z.string().trim().min(1)
  }),
  z.object({
    action: z.literal('remove_photo_defect'),
    photo_number: photoNumberSchema,
    current_description: z.string().min(1)
  }),
  z.object({
    action: z.literal('remove_photo'),
    photo_number: photoNumberSchema
  }),
  z.object({
    action: z.literal('set_room_condition'),
    piece: z.string().trim().min(1),
    element: z.string().trim().min(1),
    etat: z.enum(ETATS_USURE),
    observation: z.string().optional()
  }),
  z.object({
    action: z.literal('add_property_element'),
    piece: z.string().trim().min(1),
    element: z.string().trim().min(1)
  }).describe('Ajoute, après confirmation locale, un équipement à l’inventaire partagé du logement et du lot.'),
  z.object({
    action: z.literal('remove_property_element'),
    piece: z.string().trim().min(1),
    element: z.string().trim().min(1)
  }).describe('Retire, après confirmation locale, un équipement de l’inventaire partagé du logement et du lot.'),
  z.object({
    action: z.literal('append_observation'),
    piece: z.string().trim().min(1),
    element: z.string().trim().min(1),
    observation: z.string().trim().min(1)
  }),
  z.object({
    action: z.literal('set_keys'),
    cles: z.array(z.object({
      type: z.string().trim().min(1),
      nombre: z.number().int().min(0),
      observations: z.string().optional()
    })).max(100)
  }),
  z.object({
    action: z.literal('set_reserve'),
    partie: z.enum(['bailleur', 'locataire']),
    texte: z.string().trim().min(1)
  })
]);

function isValidDate(value) {
  const parsedDate = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsedDate.getTime()) && parsedDate.toISOString().slice(0, 10) === value;
}

function isAuthorized(request, expectedToken) {
  const authorization = request.headers.authorization || '';
  if (!authorization.startsWith('Bearer ')) return false;

  const provided = Buffer.from(authorization.slice('Bearer '.length));
  const expected = Buffer.from(expectedToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

async function resolvePhotosDirectory(photoDirectory, configuredRoot) {
  const allowedRoot = await fs.realpath(configuredRoot);
  const resolvedDirectory = await fs.realpath(path.resolve(photoDirectory));
  const relativePath = path.relative(allowedRoot, resolvedDirectory);

  if (
    !relativePath ||
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error('Le dossier photos doit être un sous-dossier de EDL_PHOTOS_ROOT.');
  }

  const stats = await fs.stat(resolvedDirectory);
  if (!stats.isDirectory()) {
    throw new Error('Le chemin des photos ne désigne pas un dossier.');
  }

  return resolvedDirectory;
}

async function generateDraft(args, configuredRoot) {
  if (generationInProgress) {
    throw new Error('Une génération EDL est déjà en cours. Réessayez dans quelques instants.');
  }
  generationInProgress = true;

  let temporaryPhotoDirectory;
  let temporaryAnalysisPath;
  let temporaryAnalysisMetaPath;
  try {
    if (!isValidDate(args.date)) {
      throw new Error('La date fournie n’existe pas au calendrier.');
    }

    const edlContextData = await ensureEdlContext(args.locataire_nom);
    const bien = args.bien || 'massy';
    const biens = JSON.parse(await fs.readFile(path.join(projectRoot, 'data', 'biens.json'), 'utf8'));
    const bienData = biens[bien];
    if (!bienData) throw new Error(`Bien "${bien}" non trouvé dans data/biens.json.`);
    const vibeContextData = {
      version: 1,
      locataires: [{
        nom: args.locataire_nom,
        email: args.email,
        telephone: args.telephone,
        chambre: args.chambre,
        lot: args.lot,
        bien,
        adresse_bien: args.adresse_bien
      }],
      biens: {
        [bien]: {
          adresse: args.adresse_bien || bienData.adresse_bien || bienData.adresse || bienData.nom || ''
        }
      }
    };
    const { context } = await generateContext(args.locataire_nom, {
      date: args.date,
      requireVibeContext: true,
      allowMissingContext: true,
      vibeContextData,
      edlContextData
    });
    context.type = args.type_edl;

    const missingFields = getMissingContextFields(context, args, bienData);
    if (missingFields.length > 0) {
      const missingField = missingFields[0];
      const detail = missingField.startsWith('etat_usure.')
        ? ` Demandez l’état observé pour l’élément "${missingField.slice('etat_usure.'.length)}", puis transmettez-le dans etat_usure.`
        : '';
      return {
        clarification_required: true,
        missing_fields: [missingField],
        message: `Demandez à l’utilisateur uniquement le champ "${missingField}", puis relancez create_edl_draft avec la réponse confirmée.${detail} Répétez jusqu’à ce que tous les champs requis soient renseignés. N’inventez aucune valeur.`
      };
    }

    const photosDirectory = await resolvePhotosDirectory(args.dossier_photos, configuredRoot);
    if (!isMistralConfigured()) {
      throw new Error('MISTRAL_API_KEY doit être configurée pour analyser les photos automatiquement.');
    }

    const temporaryRoot = path.join(projectRoot, 'output', 'to-analyze');
    await fs.mkdir(temporaryRoot, { recursive: true });
    temporaryPhotoDirectory = await fs.mkdtemp(path.join(temporaryRoot, 'mcp-'));

    const compressedPhotos = await compressAllImages(photosDirectory, temporaryPhotoDirectory);
    if (compressedPhotos.length === 0) {
      throw new Error('Aucune photo exploitable trouvée dans le dossier indiqué.');
    }

    const outputDirectory = path.join(projectRoot, 'output');
    temporaryAnalysisPath = path.join(outputDirectory, `analysis-mcp-${randomUUID()}.json`);
    temporaryAnalysisMetaPath = `${temporaryAnalysisPath}.meta.json`;
    const analyses = await analyzeAllPhotos(
      temporaryPhotoDirectory,
      temporaryAnalysisPath,
      context.type,
      { cachePath: path.join(outputDirectory, 'analysis-cache.json') }
    );
    if (analyses.length !== compressedPhotos.length) {
      throw new Error(`Analyse incomplète : ${analyses.length} résultat(s) pour ${compressedPhotos.length} photo(s).`);
    }

    const result = await newCommand({
      bien: context.bien,
      type: context.type,
      locataire: context.locataire.nom,
      email: context.locataire.email,
      telephone: context.locataire.telephone,
      chambre: context.locataire.chambre,
      lot: context.locataire.lot,
      edlContextData,
      date: context.date,
      adresseBien: context.adresseBien,
      relevesCompteurs: {
        electricite: args.compteur_electricite,
        eau_froide: args.compteur_eau_froide,
        eau_chaude: args.compteur_eau_chaude
      },
      detecteurFumee: args.detecteur_fumee,
      proprete: args.proprete,
      reservesBailleur: args.reserves_bailleur,
      reservesLocataire: args.reserves_locataire,
      etatUsure: args.etat_usure,
      photos: photosDirectory,
      analysis: temporaryAnalysisPath,
      precompressedPhotos: compressedPhotos
    });

    return {
      draft: path.basename(result.draftPath),
      draft_path: result.draftPath,
      preview_path: result.htmlPath,
      photos_count: result.photosCount,
      analyzed_count: result.analysisCount,
      type: context.type,
      message: 'Brouillon créé et ouvert sur le PC. Vérifiez-le avant toute finalisation PDF.'
    };
  } finally {
    try {
      if (temporaryPhotoDirectory) {
        await fs.rm(temporaryPhotoDirectory, { recursive: true, force: true });
      }
      if (temporaryAnalysisPath) {
        await fs.rm(temporaryAnalysisPath, { force: true });
      }
      if (temporaryAnalysisMetaPath) {
        await fs.rm(temporaryAnalysisMetaPath, { force: true });
      }
    } finally {
      generationInProgress = false;
    }
  }
}

function getMissingContextFields(context, args = {}, bienData = {}) {
  const missing = [];
  const locataire = context.locataire || {};
  if (!isConfirmedEmail(locataire.email)) missing.push('email');
  if (!locataire.telephone?.trim()) missing.push('telephone');
  if (!locataire.chambre?.trim()) missing.push('chambre');
  if (!locataire.lot?.trim()) missing.push('lot');
  if (!context.adresseBien?.trim()) missing.push('adresse_bien');
  if (context.referenceDernierEdl === null) {
    for (const [piece, elements] of Object.entries(bienData.pieces || {})) {
      for (const element of elements) {
        const state = args.etat_usure?.[piece]?.[element]?.etat;
        if (typeof state !== 'string' || !state.trim()) {
          missing.push(`etat_usure.${piece}.${element}`);
        }
      }
    }
  }
  return missing;
}

function isConfirmedEmail(email) {
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return false;
  const domain = email.split('@')[1].toLowerCase();
  return domain !== 'example.com' && !['example', 'invalid', 'test'].some(tld => domain.endsWith(`.${tld}`));
}

function createMcpServer(configuredRoot, projectRootOverride = projectRoot) {
  const mcpServer = new McpServer({
    name: 'edl-local',
    version: '1.0.0'
  });

  mcpServer.registerTool('suggest_edl_type', {
    title: 'Suggérer le type d’état des lieux',
    description: [
      'Détermine si le prochain EDL du locataire est suggéré comme entrée ou sortie à partir de l’historique local.',
      'Avant toute création, présente cette suggestion à l’utilisateur et demande confirmation par Y/N.',
      'S’il répond N, propose l’autre type et demande confirmation avant d’appeler create_edl_draft.'
    ].join(' '),
    inputSchema: z.object({
      locataire_nom: z.string().trim().min(1).describe('Nom de famille du locataire, utilisé pour sélectionner son contexte Google Drive.')
    })
  }, async ({ locataire_nom }) => {
    try {
      const type = await suggestTypeForLocataire(locataire_nom);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            type_suggere: type,
            libelle: type === 'entree' ? 'Entrée' : 'Sortie',
            si_refuse: type === 'entree' ? 'sortie' : 'entree'
          }, null, 2)
        }]
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: error.message }]
      };
    }
  });

  mcpServer.registerTool('create_edl_draft', {
    title: 'Créer un brouillon d’état des lieux',
    description: [
      'Crée un brouillon EDL local à partir du contexte du locataire, de la date et du dossier photos.',
      'Le fichier de contexte individuel téléchargé depuis Google Drive est la source de vérité pour le bailleur, le bien, le locataire et le dernier EDL. Ne redemande pas un champ présent dans ce fichier et ne le modifie jamais.',
      `N’invente aucune information. Pour chaque valeur manquante (coordonnées), l’outil retourne un seul champ dans clarification_required : demande ce champ puis rappelle create_edl_draft avec la réponse confirmée. La propreté est « ${DEFAULT_EDL_ANSWERS.proprete} » et les réserves du bailleur et du locataire sont « ${DEFAULT_EDL_ANSWERS.reservesBailleur} » par défaut. Les relevés de compteurs ne sont pas demandés et le détecteur de fumée est considéré présent par défaut. Si dernier_edl_connu est null, il demande également l’état de chaque élément, un par un.`,
      'Appelle d’abord suggest_edl_type, obtiens une confirmation Y/N de l’utilisateur, puis transmets le type confirmé dans type_edl.',
      'Les photos sont analysées par l’API Mistral configurée sur le PC. Le brouillon reste local. Après sa création, propose à l’utilisateur de le relire et utilise read_edl_draft pour répondre à ses demandes de correction.'
    ].join(' '),
    inputSchema: toolInputSchema
  }, async args => {
    try {
      const result = await generateDraft(args, configuredRoot);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: error.message }]
      };
    }
  });

  mcpServer.registerTool('read_edl_draft', {
    title: 'Lire un brouillon EDL',
    description: [
      'Lit les données modifiables d’un brouillon non finalisé appartenant au locataire demandé.',
      'Utilise le nom du fichier draft-* retourné par create_edl_draft. Ne retourne pas les coordonnées du locataire.',
      'Présente les photos avec leur numéro Pxx, puis les états, observations, clés et réserves pour aider l’utilisateur à formuler ses corrections.'
    ].join(' '),
    inputSchema: z.object({
      locataire_nom: z.string().trim().min(1),
      brouillon: draftFileSchema
    })
  }, async ({ locataire_nom, brouillon }) => {
    try {
      const context = await ensureEdlContext(locataire_nom);
      const draft = await readDraftForTenant(projectRootOverride, brouillon, context.locataire);
      return { content: [{ type: 'text', text: JSON.stringify(draft, null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  });

  mcpServer.registerTool('propose_edl_changes', {
    title: 'Préparer des corrections EDL',
    description: [
      'Prépare un aperçu de modifications structurées sur un brouillon sans rien enregistrer.',
      'Les actions autorisées sont : corriger ou retirer un défaut photo sans retirer la photo, retirer une photo entière de l’annexe, définir l’état d’un élément, ajouter une observation à une ligne, remplacer la liste des clés ou mettre à jour une réserve.',
      'Utilise seulement les actions décrites dans le schéma. Les numéros Pxx identifient les photos actuelles de l’annexe.',
      'Après cet appel, résume les modifications prévues à l’utilisateur et attends sa confirmation explicite. Pour supprimer une photo entière, confirme d’abord qu’il veut retirer la photo de l’annexe, pas seulement son commentaire.',
      'Pour modifier un seul nombre de clés, lis d’abord la liste complète et conserve toutes les autres clés inchangées dans set_keys.',
      'N’invente jamais un état ni une observation. Ne modifie pas les données de référence du locataire.'
    ].join(' '),
    inputSchema: z.object({
      locataire_nom: z.string().trim().min(1),
      brouillon: draftFileSchema,
      modifications: z.array(draftChangeSchema).min(1).max(100)
    })
  }, async ({ locataire_nom, brouillon, modifications }) => {
    try {
      const context = await ensureEdlContext(locataire_nom);
      const proposal = await proposeDraftChanges(
        projectRootOverride,
        brouillon,
        context.locataire,
        modifications
      );
      return { content: [{ type: 'text', text: JSON.stringify(proposal, null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  });

  mcpServer.registerTool('confirm_edl_changes', {
    title: 'Confirmer les corrections EDL',
    description: [
      'Enregistre une proposition de corrections et met à jour l’aperçu HTML.',
      'Appelle uniquement après que l’utilisateur a explicitement confirmé le résumé exact renvoyé par propose_edl_changes.',
      'Ne finalise pas le PDF. Si le brouillon a changé depuis la proposition ou si le jeton a expiré, relis-le et prépare une nouvelle proposition.'
    ].join(' '),
    inputSchema: z.object({
      locataire_nom: z.string().trim().min(1),
      brouillon: draftFileSchema,
      confirmation_token: z.string().uuid()
    })
  }, async ({ locataire_nom, brouillon, confirmation_token }) => {
    try {
      const context = await ensureEdlContext(locataire_nom);
      const result = await confirmDraftChanges(
        projectRootOverride,
        brouillon,
        context.locataire,
        confirmation_token
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  });

  return mcpServer;
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(body));
}

function createMcpHttpServer({ token, photosRoot, projectRoot: projectRootOverride = projectRoot }) {
  return createHttpServer(async (request, response) => {
    if (request.url !== '/mcp') {
      sendJson(response, 404, { error: 'Not found' });
      return;
    }
    if (!isAuthorized(request, token)) {
      response.setHeader('WWW-Authenticate', 'Bearer');
      sendJson(response, 401, { error: 'Unauthorized' });
      return;
    }
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'Method not allowed' });
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: MAX_REQUEST_BODY_SIZE
    });
    const mcpServer = createMcpServer(photosRoot, projectRootOverride);

    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(request, response);
    } catch (error) {
      console.error(`Erreur MCP: ${error.message}`);
      if (!response.headersSent) {
        sendJson(response, 500, {
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null
        });
      }
    } finally {
      await transport.close();
      await mcpServer.close();
    }
  });
}

async function startMcpServer() {
  const token = process.env.EDL_MCP_TOKEN;
  if (!token || token.length < 32) {
    throw new Error('EDL_MCP_TOKEN doit contenir au moins 32 caractères aléatoires.');
  }
  if (!process.env.EDL_PHOTOS_ROOT) {
    throw new Error('EDL_PHOTOS_ROOT doit désigner le dossier parent autorisé pour les photos.');
  }

  const photosRoot = await fs.realpath(path.resolve(process.env.EDL_PHOTOS_ROOT));
  const port = Number(process.env.EDL_MCP_PORT || 3333);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('EDL_MCP_PORT doit être un port TCP valide.');
  }

  const httpServer = createMcpHttpServer({ token, photosRoot });

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '127.0.0.1', resolve);
  });
  console.log(`Serveur MCP EDL actif sur http://127.0.0.1:${port}/mcp`);
  console.log(`Dossier photos autorisé : ${photosRoot}`);
  console.log('Le serveur n’écoute que sur le PC local et ne publie aucun fichier EDL.');
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  startMcpServer().catch(error => {
    console.error(`Impossible de démarrer le serveur MCP : ${error.message}`);
    process.exitCode = 1;
  });
}

export { createMcpHttpServer, createMcpServer, generateDraft, getMissingContextFields, isAuthorized, resolvePhotosDirectory, startMcpServer };
