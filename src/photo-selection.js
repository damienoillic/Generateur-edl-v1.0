import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';

export const MAX_EDL_PHOTOS = 30;

export async function selectRelevantPhotos(photos, analyses, edlType, limit = MAX_EDL_PHOTOS) {
  if (!Array.isArray(photos) || !Array.isArray(analyses)) {
    throw new Error('Les photos et leurs analyses doivent être des listes.');
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('La limite de photos doit être un entier positif.');
  }

  const analysisByFilename = new Map(analyses
    .filter(analysis => typeof analysis?.fichier === 'string')
    .map(analysis => [analysis.fichier.toLocaleLowerCase(), analysis]));
  const candidates = [];
  const hashes = new Set();
  let duplicateCount = 0;

  for (const [index, photo] of photos.entries()) {
    if (typeof photo?.filename !== 'string' || typeof photo.path !== 'string') {
      throw new Error('Entrée invalide dans la liste des photos.');
    }

    const bytes = await fs.readFile(photo.path);
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hashes.has(hash)) {
      duplicateCount += 1;
      continue;
    }
    hashes.add(hash);

    const analysis = analysisByFilename.get(photo.filename.toLocaleLowerCase()) || {};
    const defects = getEffectiveDefects(analysis.defauts, edlType);
    const imageType = normalizeImageType(analysis.type_vue, defects.length > 0);
    candidates.push({
      photo,
      index,
      piece: typeof analysis.piece === 'string' && analysis.piece.trim()
        ? analysis.piece.toLocaleLowerCase()
        : 'indetermine',
      type_vue: imageType,
      defects,
      relevance: normalizeScore(analysis.pertinence),
      quality: normalizeScore(analysis.score_qualite)
    });
  }

  const selected = [];
  const selectedNames = new Set();
  const add = candidate => {
    if (!candidate || selectedNames.has(candidate.photo.filename)) return false;
    selected.push(candidate);
    selectedNames.add(candidate.photo.filename);
    return true;
  };
  const groups = groupByPiece(candidates);

  for (const group of groups.values()) {
    if (selected.length >= limit) break;
    const overview = group
      .filter(candidate => candidate.type_vue === 'vue_ensemble')
      .sort(compareCandidates)[0];
    add(overview || [...group].sort(compareCandidates)[0]);
  }

  for (const group of groups.values()) {
    if (selected.length >= limit) break;
    const defectPhoto = group
      .filter(candidate => candidate.defects.length > 0)
      .sort(compareCandidates)[0];
    add(defectPhoto);
  }

  while (selected.length < limit && selected.length < candidates.length) {
    const selectedCountByPiece = countByPiece(selected);
    const selectedTypesByPiece = typesByPiece(selected);
    const next = candidates
      .filter(candidate => !selectedNames.has(candidate.photo.filename))
      .sort((left, right) =>
        scoreCandidate(right, selectedCountByPiece, selectedTypesByPiece) -
        scoreCandidate(left, selectedCountByPiece, selectedTypesByPiece) ||
        left.index - right.index
      )[0];
    if (!add(next)) break;
  }

  selected.sort((left, right) => left.index - right.index);
  return {
    photos: selected.map(candidate => candidate.photo),
    duplicateCount,
    omittedCount: candidates.length - selected.length,
    pieceCount: groups.size
  };
}

function getEffectiveDefects(defects, edlType) {
  if (!Array.isArray(defects)) return [];
  return defects.filter(defect =>
    typeof defect?.description === 'string' &&
    defect.description.trim() &&
    (edlType !== 'entree' || defect.gravite?.toLocaleLowerCase().trim() === 'forte')
  );
}

function normalizeImageType(type, hasDefects) {
  if (type === 'vue_ensemble' || type === 'detail_defaut' || type === 'autre') return type;
  return hasDefects ? 'detail_defaut' : 'autre';
}

function normalizeScore(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(100, value))
    : 0;
}

function compareCandidates(left, right) {
  return scoreCandidate(right, new Map(), new Map()) -
    scoreCandidate(left, new Map(), new Map()) ||
    left.index - right.index;
}

function scoreCandidate(candidate, selectedCountByPiece, selectedTypesByPiece) {
  const severityScore = candidate.defects.reduce((total, defect) => {
    const severity = defect.gravite?.toLocaleLowerCase().trim();
    return total + (severity === 'forte' ? 30 : severity === 'moyenne' ? 18 : 8);
  }, 0);
  const selectedTypes = selectedTypesByPiece.get(candidate.piece) || new Set();
  const diversityBonus = selectedTypes.has(candidate.type_vue) ? 0 : 35;
  const pieceCountPenalty = (selectedCountByPiece.get(candidate.piece) || 0) * 8;
  return candidate.relevance * 2 + candidate.quality + severityScore +
    Math.min(candidate.defects.length, 3) * 6 + diversityBonus - pieceCountPenalty;
}

function groupByPiece(candidates) {
  const groups = new Map();
  for (const candidate of candidates) {
    if (!groups.has(candidate.piece)) groups.set(candidate.piece, []);
    groups.get(candidate.piece).push(candidate);
  }
  return groups;
}

function countByPiece(candidates) {
  const counts = new Map();
  for (const candidate of candidates) {
    counts.set(candidate.piece, (counts.get(candidate.piece) || 0) + 1);
  }
  return counts;
}

function typesByPiece(candidates) {
  const types = new Map();
  for (const candidate of candidates) {
    if (!types.has(candidate.piece)) types.set(candidate.piece, new Set());
    types.get(candidate.piece).add(candidate.type_vue);
  }
  return types;
}
