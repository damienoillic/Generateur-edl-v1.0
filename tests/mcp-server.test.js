import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMcpHttpServer, getMissingContextFields, isAuthorized, resolvePhotosDirectory } from '../src/mcp-server.js';
import { applyDefaultEdlAnswers, collectMissingEdlAnswers } from '../src/edl-clarification.js';

test('requires a matching bearer token', () => {
  const token = 'a'.repeat(64);

  assert.equal(isAuthorized({ headers: { authorization: `Bearer ${token}` } }, token), true);
  assert.equal(isAuthorized({ headers: { authorization: `Bearer ${'b'.repeat(64)}` } }, token), false);
  assert.equal(isAuthorized({ headers: { authorization: token } }, token), false);
});

test('accepts photo folders only inside the configured root', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'edl-mcp-path-test-'));
  const allowedRoot = path.join(testRoot, 'photos-root');
  const allowedPhotos = path.join(allowedRoot, 'tenant', 'photos');
  const outsidePhotos = path.join(testRoot, 'outside-photos');
  await fs.mkdir(allowedPhotos, { recursive: true });
  await fs.mkdir(outsidePhotos);

  try {
    assert.equal(
      await resolvePhotosDirectory(allowedPhotos, allowedRoot),
      await fs.realpath(allowedPhotos)
    );
    await assert.rejects(
      resolvePhotosDirectory(outsidePhotos, allowedRoot),
      /sous-dossier de EDL_PHOTOS_ROOT/
    );
    await assert.rejects(
      resolvePhotosDirectory(allowedRoot, allowedRoot),
      /sous-dossier de EDL_PHOTOS_ROOT/
    );
  } finally {
    await fs.rm(testRoot, { recursive: true, force: true });
  }
});

test('returns only missing or placeholder details for clarification', () => {
  const confirmedAnswers = {
    detecteur_fumee: 'présent',
    proprete: 'Propre',
    reserves_bailleur: 'Aucune',
    reserves_locataire: 'Aucune'
  };
  assert.deepEqual(getMissingContextFields({
    locataire: {
      email: 'tenant@example.com',
      telephone: '',
      chambre: 'Chambre 2',
      lot: 'LOT-2'
    },
    adresseBien: ''
  }, confirmedAnswers), ['email', 'telephone', 'adresse_bien']);

  assert.deepEqual(getMissingContextFields({
    locataire: {
      email: 'camille@example.test',
      telephone: '06 00 00 00 00',
      chambre: 'Chambre 2',
      lot: 'LOT-2'
    },
    adresseBien: '12 rue des Lilas'
  }, confirmedAnswers), ['email']);

  const noOptionalFields = {
    locataire: {
      email: 'tenant@example.org',
      telephone: '0601020304',
      chambre: 'Chambre 2',
      lot: 'LOT-2'
    },
    adresseBien: '12 rue des Lilas'
  };
  assert.deepEqual(getMissingContextFields(noOptionalFields, {
    proprete: 'Propre',
    reserves_bailleur: 'Aucune',
    reserves_locataire: 'Aucune'
  }), []);

  assert.deepEqual(getMissingContextFields({
    locataire: {
      email: 'tenant@example.org',
      telephone: null,
      chambre: 'Chambre 2',
      lot: 'LOT-2'
    },
    adresseBien: '12 rue des Lilas'
  }), ['telephone']);
});

test('applies routine EDL answers, including smoke detector presence, as defaults', () => {
  const answers = collectMissingEdlAnswers({});
  assert.deepEqual(answers, {
    detecteurFumee: 'présent',
    proprete: 'Bon état',
    reservesBailleur: 'Aucune observation ni réserve.',
    reservesLocataire: 'Aucune observation ni réserve.'
  });

  const confirmedAnswers = applyDefaultEdlAnswers({
    proprete: 'Très propre',
    reservesBailleur: 'Travaux à prévoir.'
  });
  assert.deepEqual(confirmedAnswers, {
    proprete: 'Très propre',
    detecteurFumee: 'présent',
    reservesBailleur: 'Travaux à prévoir.',
    reservesLocataire: 'Aucune observation ni réserve.'
  });

  assert.equal(applyDefaultEdlAnswers({ detecteur_fumee: 'absent' }).detecteur_fumee, 'absent');
});

test('asks for every element when the tenant has no previous EDL, one at a time', () => {
  const context = {
    locataire: {
      email: 'tenant@example.org',
      telephone: '0601020304',
      chambre: 'Chambre 2',
      lot: 'LOT-2'
    },
    adresseBien: '12 rue des Lilas',
    referenceDernierEdl: null
  };
  const answers = {
    detecteur_fumee: 'présent',
    proprete: 'Propre',
    reserves_bailleur: 'Aucune',
    reserves_locataire: 'Aucune'
  };
  const bienData = { pieces: { chambre: ['Mur', 'Sol'] } };

  assert.deepEqual(
    getMissingContextFields(context, answers, bienData),
    ['etat_usure.chambre.Mur', 'etat_usure.chambre.Sol']
  );
  assert.ok(!getMissingContextFields(context, answers, bienData).some(field => field.startsWith('compteur_')));
  assert.deepEqual(
    getMissingContextFields(context, {
      ...answers,
      etat_usure: { chambre: { Mur: { etat: 'Bon état' } } }
    }, bienData),
    ['etat_usure.chambre.Sol']
  );
});

test('exposes the EDL tool through authenticated stateless MCP HTTP', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'edl-mcp-http-test-'));
  const token = 'c'.repeat(64);
  const server = createMcpHttpServer({ token, photosRoot: testRoot });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    const endpoint = `http://127.0.0.1:${address.port}/mcp`;
    const unauthorized = await fetch(endpoint, { method: 'POST' });
    assert.equal(unauthorized.status, 401);

    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream'
    };
    const initializeResponse = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'edl-test', version: '1.0.0' }
        }
      })
    });
    assert.equal(initializeResponse.status, 200);
    const initializeResult = await initializeResponse.json();
    assert.equal(initializeResult.result.serverInfo.name, 'edl-local');

    const toolsResponse = await fetch(endpoint, {
      method: 'POST',
      headers: { ...headers, 'MCP-Protocol-Version': '2025-03-26' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    });
    assert.equal(toolsResponse.status, 200);
    const tools = await toolsResponse.json();
    assert.deepEqual(
      tools.result.tools.map(tool => tool.name),
      [
        'suggest_edl_type',
        'create_edl_draft',
        'read_edl_draft',
        'propose_edl_changes',
        'confirm_edl_changes'
      ]
    );
    assert.ok(tools.result.tools[0].inputSchema.required.includes('locataire_nom'));
    assert.ok(tools.result.tools[1].inputSchema.required.includes('type_edl'));
    assert.ok(!tools.result.tools[1].inputSchema.required.includes('telephone'));
    assert.ok(!tools.result.tools[1].inputSchema.required.includes('email'));
    assert.ok(tools.result.tools[2].inputSchema.required.includes('brouillon'));
    assert.ok(tools.result.tools[3].inputSchema.required.includes('modifications'));
    assert.ok(tools.result.tools[4].inputSchema.required.includes('confirmation_token'));
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.rm(testRoot, { recursive: true, force: true });
  }
});
