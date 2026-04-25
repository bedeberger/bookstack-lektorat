'use strict';

const { extractName } = require('../../lib/names');

// Block 5: Szenen-Q&A
function buildSceneQASamples(ctx) {
  const {
    langIsEn,
    sceneRows, figsByScene, locsByScene, figById, locById,
    sceneQuestions, pushQA, pickVariants,
  } = ctx;

  for (const s of sceneRows) {
    const komm = (s.kommentar || '').trim();
    if (!s.titel || !komm) continue;
    const parts = [komm];
    const figIds = figsByScene.get(s.id) || [];
    const figNames = figIds.map(id => extractName(id, figById)).filter(Boolean);
    if (figNames.length) parts.push(langIsEn ? `Characters: ${figNames.join(', ')}.` : `Figuren: ${figNames.join(', ')}.`);
    const locIds = locsByScene.get(s.id) || [];
    const locNames = locIds.map(id => extractName(id, locById)).filter(Boolean);
    if (locNames.length) parts.push(langIsEn ? `Setting: ${locNames.join(', ')}.` : `Schauplatz: ${locNames.join(', ')}.`);
    if (s.kapitel) parts.push(langIsEn ? `Chapter: ${s.kapitel}.` : `Kapitel: ${s.kapitel}.`);
    const answer = parts.join(' ');
    const idxs = pickVariants('scene|' + s.id, sceneQuestions, 2);
    for (const idx of idxs) {
      const q = sceneQuestions[idx].replace('{titel}', s.titel);
      pushQA('authorChat|scene|' + s.id + '|' + idx, q, answer);
    }
  }
}

module.exports = { buildSceneQASamples };
