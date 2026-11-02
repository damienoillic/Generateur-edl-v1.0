export const DEFAULT_EDL_ANSWERS = Object.freeze({
  detecteurFumee: 'présent',
  proprete: 'Bon état',
  reservesBailleur: 'Aucune observation ni réserve.',
  reservesLocataire: 'Aucune observation ni réserve.'
});

export function applyDefaultEdlAnswers(options) {
  for (const [key, value] of Object.entries(DEFAULT_EDL_ANSWERS)) {
    if (key === 'detecteurFumee' && options.detecteur_fumee) continue;
    if (typeof options[key] !== 'string' || options[key].trim() === '') {
      options[key] = value;
    }
  }
  return options;
}

export function collectMissingEdlAnswers(options) {
  return applyDefaultEdlAnswers(options);
}
