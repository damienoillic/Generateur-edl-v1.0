import assert from 'node:assert/strict';
import test from 'node:test';
import { collectMissingEdlAnswers } from '../src/edl-clarification.js';
import {
  confirmPdfGeneration,
  confirmSuggestedType,
  confirmVibeReview,
  unwrapGeneratedContext
} from '../src/launch.js';

test('confirms the suggested type when the user answers Y', async () => {
  const answers = ['Y'];
  const confirmedType = await confirmSuggestedType('entree', async () => answers.shift());

  assert.equal(confirmedType, 'entree');
});

test('suggests the other type after N and confirms it on Y', async () => {
  const answers = ['N', 'Y'];
  const confirmedType = await confirmSuggestedType('entree', async () => answers.shift());

  assert.equal(confirmedType, 'sortie');
});

test('repeats the confirmation when the answer is not Y or N', async () => {
  const answers = ['maybe', 'Y'];
  const confirmedType = await confirmSuggestedType('sortie', async () => answers.shift());

  assert.equal(confirmedType, 'sortie');
});

test('unwraps the generated tenant context before the launch flow uses it', () => {
  const context = {
    locataire: { nom: 'Mme Baniza Magnoudewa Emmanuel' },
    date: '2026-11-01',
    type: 'entree'
  };
  assert.equal(unwrapGeneratedContext({ context }), context);
  assert.equal(unwrapGeneratedContext({ context }).date, '2026-11-01');
});

test('reports an invalid generated context explicitly', () => {
  assert.throws(
    () => unwrapGeneratedContext({ date: '2026-11-01' }),
    /n’a pas retourné les informations attendues/
  );
});

test('confirms Vibe review readiness on Y', async () => {
  const answers = ['y'];
  assert.equal(await confirmVibeReview(async () => answers.shift()), true);
});

test('defers Vibe review on N and repeats unrecognized answers', async () => {
  const answers = ['maybe', 'n'];
  assert.equal(await confirmVibeReview(async () => answers.shift()), false);
});

test('confirms PDF generation on Y and can defer it on N', async () => {
  assert.equal(await confirmPdfGeneration(async () => 'y'), true);
  assert.equal(await confirmPdfGeneration(async () => 'n'), false);
});

test('repeats PDF confirmation after an invalid answer', async () => {
  const answers = ['maybe', 'oui'];
  assert.equal(await confirmPdfGeneration(async () => answers.shift()), true);
});

test('assumes the smoke detector is present unless absence is explicitly provided', () => {
  const result = collectMissingEdlAnswers({});
  const absent = collectMissingEdlAnswers({ detecteurFumee: 'absent' });

  assert.equal(result.detecteurFumee, 'présent');
  assert.equal(absent.detecteurFumee, 'absent');
});
