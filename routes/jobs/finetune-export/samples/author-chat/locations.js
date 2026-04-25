'use strict';

const { extractName, escapeRe } = require('../../lib/names');
const { splitParagraphs } = require('../../lib/text');

// Block 3+4: Orte-Q&A einzeln + Doppel-/Tripel-Verknüpfungen
function buildLocationSamples(ctx) {
  const {
    langIsEn,
    locRows, sceneRows, figById, figRows,
    chaptersByLocPk, figsByLocPk, scenesByLocPk,
    ortQuestions, pushQA, pickVariants,
  } = ctx;

  // ── Orte-Q&A (angereichert) ───────────────────────────────────────────
  // Der User hat Orte explizit als zentral markiert — wir produzieren pro
  // Ort mehrere Antwort-Framings (Gesamtbeschreibung, Kapitel-Mapping,
  // Figurenbesetzung, Szenen-Überblick, erste Erwähnung). Ziel: das Modell
  // soll jeden Ort aus vielen Blickwinkeln gelernt haben.
  const sceneTitleById = new Map(sceneRows.map(s => [s.id, s.titel]));
  for (const l of locRows) {
    const kapitel    = chaptersByLocPk.get(l.pk) || [];
    const figsHere   = (figsByLocPk.get(l.pk) || []).map(id => extractName(id, figById)).filter(Boolean);
    const szenenHere = (scenesByLocPk.get(l.pk) || []).map(id => sceneTitleById.get(id)).filter(Boolean);
    const desc       = (l.beschreibung || '').trim();

    // Komplette Antwort mit allen verfügbaren Facetten. Wird als Haupt-Antwort
    // auf generelle „Wer/was ist {ort}?"-Fragen verwendet.
    const parts = [];
    if (desc) parts.push(desc);
    if (l.typ)      parts.push(langIsEn ? `Type: ${l.typ}.` : `Art des Ortes: ${l.typ}.`);
    if (l.stimmung) parts.push(langIsEn ? `The atmosphere: ${l.stimmung}.` : `Die Stimmung: ${l.stimmung}.`);
    if (kapitel.length) {
      parts.push(langIsEn
        ? `Appears in: ${kapitel.slice(0, 10).join(', ')}.`
        : `Kommt vor in: ${kapitel.slice(0, 10).join(', ')}.`);
    }
    if (figsHere.length) {
      parts.push(langIsEn
        ? `Characters present: ${figsHere.slice(0, 12).join(', ')}.`
        : `Figuren an diesem Ort: ${figsHere.slice(0, 12).join(', ')}.`);
    }
    if (szenenHere.length) {
      parts.push(langIsEn
        ? `Scenes here: ${szenenHere.slice(0, 6).map(t => `«${t}»`).join(', ')}.`
        : `Szenen an diesem Ort: ${szenenHere.slice(0, 6).map(t => `«${t}»`).join(', ')}.`);
    }
    if (l.erste_erwaehnung) {
      parts.push(langIsEn
        ? `First mentioned on «${l.erste_erwaehnung}».`
        : `Erste Erwähnung auf «${l.erste_erwaehnung}».`);
    }
    const fullAnswer = parts.join(' ');
    if (!fullAnswer) continue;

    // Haupt-Q&A: 3 Paraphrasen mit voller Antwort
    const idxs = pickVariants('ort|' + l.loc_id, ortQuestions, 3);
    for (const idx of idxs) {
      const q = ortQuestions[idx].replace('{name}', l.name);
      pushQA('authorChat|ort|' + l.loc_id + '|' + idx, q, fullAnswer);
    }

    // Spezifische Q&A für jede Facette, damit das Modell gezielt abrufbar lernt.
    if (kapitel.length) {
      const answer = kapitel.slice(0, 15).join(', ');
      pushQA('authorChat|ort-ch|' + l.loc_id,
        langIsEn ? `In which chapters does ${l.name} appear?` : `In welchen Kapiteln kommt ${l.name} vor?`,
        langIsEn ? `${l.name} appears in: ${answer}.` : `${l.name} kommt vor in: ${answer}.`);
    }
    if (figsHere.length) {
      const answer = figsHere.slice(0, 15).join(', ');
      pushQA('authorChat|ort-fig|' + l.loc_id,
        langIsEn ? `Which characters are at ${l.name}?` : `Welche Figuren sind an ${l.name}?`,
        langIsEn ? `At ${l.name}: ${answer}.` : `An ${l.name}: ${answer}.`);
    }
    if (szenenHere.length) {
      const answer = szenenHere.slice(0, 10).map(t => `«${t}»`).join(', ');
      pushQA('authorChat|ort-sz|' + l.loc_id,
        langIsEn ? `What scenes take place at ${l.name}?` : `Welche Szenen spielen an ${l.name}?`,
        langIsEn ? `Scenes at ${l.name}: ${answer}.` : `Szenen an ${l.name}: ${answer}.`);
    }
    if (l.stimmung) {
      pushQA('authorChat|ort-stimmung|' + l.loc_id,
        langIsEn ? `What's the mood of ${l.name}?` : `Welche Stimmung hat ${l.name}?`,
        l.stimmung);
    }
    if (l.erste_erwaehnung) {
      pushQA('authorChat|ort-first|' + l.loc_id,
        langIsEn ? `When is ${l.name} first mentioned?` : `Wann wird ${l.name} zum ersten Mal erwähnt?`,
        langIsEn
          ? `${l.name} is first introduced on the page «${l.erste_erwaehnung}».`
          : `${l.name} wird zum ersten Mal auf der Seite «${l.erste_erwaehnung}» erwähnt.`);
    }
  }

  // ── Schauplätze: Doppel-/Tripel-Verknüpfungen ────────────────────────
  // Reverse-Indizes (Figur→Orte, Kapitel→Orte) + Tripel (Ort×Figur×Szene)
  // + typ-/stimmungs-gruppierte Aggregate.
  const locsByFigId = new Map();
  for (const [locPk, figIds] of figsByLocPk) {
    const loc = locRows.find(l => l.pk === locPk);
    if (!loc) continue;
    for (const fid of figIds) {
      if (!locsByFigId.has(fid)) locsByFigId.set(fid, []);
      locsByFigId.get(fid).push(loc);
    }
  }
  const locsByChapter = new Map();
  for (const l of locRows) {
    for (const ch of (chaptersByLocPk.get(l.pk) || [])) {
      const k = (ch || '').toLowerCase();
      if (!k) continue;
      if (!locsByChapter.has(k)) locsByChapter.set(k, { name: ch, items: [] });
      locsByChapter.get(k).items.push(l);
    }
  }
  for (const f of figRows) {
    const locs = locsByFigId.get(f.fig_id) || [];
    if (!locs.length) continue;
    const list = locs.slice(0, 12).map(l => l.name).join(', ');
    pushQA('authorChat|locsByFig|' + f.fig_id,
      langIsEn ? `Which locations does ${f.name} visit?` : `An welchen Orten ist ${f.name} unterwegs?`,
      list);
    pushQA('authorChat|locsByFig2|' + f.fig_id,
      langIsEn ? `Where do we meet ${f.name} in the book?` : `Wo trifft man ${f.name} im Buch?`,
      list);
    if (locs.length >= 2) {
      pushQA('authorChat|locsByFigMap|' + f.fig_id,
        langIsEn ? `Map ${f.name} across the locations.` : `Verorte ${f.name} in den Schauplätzen.`,
        list);
    }
  }
  for (const [key, group] of locsByChapter) {
    if (group.items.length < 1) continue;
    const list = group.items.slice(0, 10).map(l => l.name).join(', ');
    pushQA('authorChat|locsByCh|' + key.replace(/\s+/g, '_').slice(0, 80),
      langIsEn ? `Which locations appear in «${group.name}»?` : `Welche Schauplätze kommen in «${group.name}» vor?`,
      list);
  }
  const sceneTitleByIdLoc = new Map(sceneRows.map(s => [s.id, s.titel]));
  for (const l of locRows) {
    const sceneIds = scenesByLocPk.get(l.pk) || [];
    const figIds = figsByLocPk.get(l.pk) || [];
    if (!sceneIds.length || !figIds.length) continue;
    for (let si = 0; si < Math.min(sceneIds.length, 4); si++) {
      const sid = sceneIds[si];
      const sTitle = sceneTitleByIdLoc.get(sid);
      if (!sTitle) continue;
      for (let fi = 0; fi < Math.min(figIds.length, 3); fi++) {
        const fid = figIds[fi];
        const fname = extractName(fid, figById);
        if (!fname) continue;
        pushQA('authorChat|locFigSz|' + l.loc_id + '|' + fid + '|' + sid,
          langIsEn
            ? `What does ${fname} do at ${l.name} in scene «${sTitle}»?`
            : `Was macht ${fname} an ${l.name} in der Szene «${sTitle}»?`,
          langIsEn
            ? `${fname} is at ${l.name} in scene «${sTitle}».`
            : `${fname} ist in der Szene «${sTitle}» an ${l.name}.`);
      }
    }
  }
  const locsByTyp = new Map();
  const locsByStimmung = new Map();
  for (const l of locRows) {
    const t = (l.typ || '').trim().toLowerCase();
    if (t) {
      if (!locsByTyp.has(t)) locsByTyp.set(t, { typ: l.typ.trim(), items: [] });
      locsByTyp.get(t).items.push(l);
    }
    const stim = (l.stimmung || '').trim().toLowerCase();
    if (stim) {
      if (!locsByStimmung.has(stim)) locsByStimmung.set(stim, { stimmung: l.stimmung.trim(), items: [] });
      locsByStimmung.get(stim).items.push(l);
    }
  }
  for (const [key, group] of locsByTyp) {
    if (group.items.length < 2) continue;
    const list = group.items.slice(0, 12).map(l => l.name).join(', ');
    pushQA('authorChat|locsByTyp|' + key.replace(/\s+/g, '_').slice(0, 60),
      langIsEn ? `Which ${group.typ} locations appear in the book?` : `Welche Schauplätze vom Typ «${group.typ}» gibt es im Buch?`,
      list);
  }
  for (const [key, group] of locsByStimmung) {
    if (group.items.length < 2) continue;
    const list = group.items.slice(0, 10).map(l => l.name).join(', ');
    pushQA('authorChat|locsByStim|' + key.replace(/\s+/g, '_').slice(0, 60),
      langIsEn ? `Which locations carry a «${group.stimmung}» mood?` : `Welche Orte haben eine «${group.stimmung}» Stimmung?`,
      list);
  }
  if (locRows.length >= 2) {
    const allLocs = locRows.slice(0, 30).map(l => l.name).filter(Boolean).join(', ');
    pushQA('authorChat|locsAll',
      langIsEn ? `List all the locations in the book.` : `Liste alle Schauplätze im Buch auf.`,
      allLocs);
    pushQA('authorChat|locsAll2',
      langIsEn ? `What are the settings of this book?` : `An welchen Schauplätzen spielt das Buch?`,
      allLocs);
  }
}

// Block 22: Text-geerdete Ort-Passagen
function buildLocationPassageSamples(ctx) {
  const { langIsEn, opts, locRows, pageContents, pushQA } = ctx;
  const { maxChars } = opts;
  const PASSAGE_MAX_PER_LOC = 4;
  for (const l of locRows) {
    if (!l.name || l.name.length < 3) continue;
    const nameRe = new RegExp('\\b' + escapeRe(l.name) + '\\b', 'i');
    const found = [];
    for (const p of pageContents) {
      if (found.length >= PASSAGE_MAX_PER_LOC) break;
      const paragraphs = splitParagraphs(p.text);
      for (const para of paragraphs) {
        if (found.length >= PASSAGE_MAX_PER_LOC) break;
        if (para.length < 120 || para.length > maxChars) continue;
        if (!nameRe.test(para)) continue;
        found.push({ para, page: p });
      }
    }
    for (let j = 0; j < found.length; j++) {
      pushQA('authorChat|ortPass|' + l.loc_id + '|' + j,
        langIsEn
          ? `Show me a passage set at ${l.name}.`
          : `Zeig mir eine Passage an ${l.name}.`,
        found[j].para);
    }
  }
}

module.exports = { buildLocationSamples, buildLocationPassageSamples };
