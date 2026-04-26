'use strict';

const { extractName } = require('../../lib/names');

// Block 5: Szenen-Q&A + POV-Prosa + Reverse-Lookup + Stimmungs-getrieben
function buildSceneQASamples(ctx) {
  const {
    langIsEn, opts,
    sceneRows, figsByScene, locsByScene, figById, locById,
    pageTextById,
    sceneQuestions, pushQA, pickVariants,
  } = ctx;
  const maxChars = opts.maxChars;

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
    const idxs = pickVariants('scene|' + s.id, sceneQuestions, sceneQuestions.length);
    for (const idx of idxs) {
      const q = sceneQuestions[idx].replace('{titel}', s.titel);
      pushQA('authorChat|scene|' + s.id + '|' + idx, q, answer);
    }
  }

  // ── POV-Generierung mit Szenentext ────────────────────────────────────
  // Pro Szene mit Page-Mapping: „Erzähle Szene X aus Sicht von Figur Y" →
  // Page-Volltext der Szene. Schichtet POV-Framing auf vorhandenen Text,
  // damit das Modell Perspektivwechsel als Operation lernt.
  for (const s of sceneRows) {
    if (!s.titel || !s.page_id) continue;
    const text = pageTextById.get(s.page_id);
    if (!text || text.length < 200) continue;
    const completion = text.length > maxChars ? text.slice(0, maxChars) : text;
    const figIds = figsByScene.get(s.id) || [];
    for (const fid of figIds.slice(0, 3)) {
      const fname = extractName(fid, figById);
      if (!fname) continue;
      pushQA('authorChat|scenePov|' + s.id + '|' + fid,
        langIsEn ? `Tell scene «${s.titel}» from ${fname}'s point of view.` : `Erzähle Szene «${s.titel}» aus ${fname}s Sicht.`,
        completion);
    }
  }

  // ── Reverse-Lookup: Welche Szene zeigt X mit Y / X an Z? ─────────────
  // Pro Figurenpaar mit gemeinsamer Szene + Pro Figur×Ort: Szenen-Treffer.
  for (const s of sceneRows) {
    if (!s.titel) continue;
    const figIds = figsByScene.get(s.id) || [];
    const locIds = locsByScene.get(s.id) || [];
    // Figurenpaar
    for (let ai = 0; ai < Math.min(figIds.length, 4); ai++) {
      for (let bi = ai + 1; bi < Math.min(figIds.length, 4); bi++) {
        const a = extractName(figIds[ai], figById);
        const b = extractName(figIds[bi], figById);
        if (!a || !b) continue;
        pushQA('authorChat|sceneRevPair|' + s.id + '|' + figIds[ai] + '|' + figIds[bi],
          langIsEn
            ? `Which scene shows ${a} together with ${b}?`
            : `Welche Szene zeigt ${a} zusammen mit ${b}?`,
          `«${s.titel}»${s.kapitel ? ' (' + s.kapitel + ')' : ''}`);
      }
    }
    // Figur × Ort
    for (let fi = 0; fi < Math.min(figIds.length, 4); fi++) {
      const fname = extractName(figIds[fi], figById);
      if (!fname) continue;
      for (let li = 0; li < Math.min(locIds.length, 3); li++) {
        const lname = extractName(locIds[li], locById);
        if (!lname) continue;
        pushQA('authorChat|sceneRevFigLoc|' + s.id + '|' + figIds[fi] + '|' + locIds[li],
          langIsEn
            ? `Which scene shows ${fname} at ${lname}?`
            : `Welche Szene zeigt ${fname} an ${lname}?`,
          `«${s.titel}»${s.kapitel ? ' (' + s.kapitel + ')' : ''}`);
      }
    }
  }

  // ── Stimmungs-/Wertungs-Bündel ───────────────────────────────────────
  // wertung-Werte clustern Szenen → „Welche Szenen sind X-bewertet?".
  const scenesByWertung = new Map();
  for (const s of sceneRows) {
    const w = (s.wertung || '').trim().toLowerCase();
    if (!w || !s.titel) continue;
    if (!scenesByWertung.has(w)) scenesByWertung.set(w, { label: s.wertung.trim(), items: [] });
    scenesByWertung.get(w).items.push(s);
  }
  for (const [key, group] of scenesByWertung) {
    if (group.items.length < 2) continue;
    const list = group.items.slice(0, 12).map(s => `«${s.titel}»`).join(', ');
    pushQA('authorChat|sceneWert|' + key.replace(/\s+/g, '_').slice(0, 60),
      langIsEn ? `Which scenes are rated «${group.label}»?` : `Welche Szenen sind als «${group.label}» bewertet?`,
      list);
  }
}

module.exports = { buildSceneQASamples };
