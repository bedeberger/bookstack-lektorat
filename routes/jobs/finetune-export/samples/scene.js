'use strict';

const { db } = require('../../../../db/schema');
const { splitAtSentence } = require('../lib/text');
const { extractName } = require('../lib/names');

function buildSceneSamples(ctx) {
  const {
    samples, counts, opts, langIsEn, unifiedSys,
    bookIdInt, userEmail, bookName,
    pageContents, pageTextById, pageChapterById,
    sceneRows, figsByScene, locsByScene,
    figById, locById,
    chapterKeys, chapterFullTextByKey, chapterNameByKey,
    figRows, locRows, appearancesByFigPk, chaptersByLocPk,
  } = ctx;
  const { minChars, maxChars } = opts;

  const scenesByPageId = new Map();
  for (const s of sceneRows) {
    if (!s.page_id) continue;
    if (!scenesByPageId.has(s.page_id)) scenesByPageId.set(s.page_id, []);
    scenesByPageId.get(s.page_id).push(s);
  }
  for (const [pageId, scenes] of scenesByPageId) {
    const txt = pageTextById.get(pageId);
    if (!txt || txt.length < minChars) continue;
    const completion = txt.length > maxChars ? txt.slice(0, maxChars) : txt;
    const meta = [];
    const titel = [...new Set(scenes.map(s => s.titel).filter(Boolean))].join(' / ');
    if (titel) meta.push((langIsEn ? 'Title: ' : 'Titel: ') + titel);
    const kapitel = scenes[0].kapitel || pageChapterById.get(pageId);
    if (kapitel) meta.push((langIsEn ? 'Chapter: ' : 'Kapitel: ') + kapitel);
    const figIds = [...new Set(scenes.flatMap(s => figsByScene.get(s.id) || []))];
    const figNames = figIds.map(id => extractName(id, figById)).filter(Boolean);
    if (figNames.length) meta.push((langIsEn ? 'Characters: ' : 'Figuren: ') + figNames.join(', '));
    const locIds = [...new Set(scenes.flatMap(s => locsByScene.get(s.id) || []))];
    const locNames = locIds.map(id => extractName(id, locById)).filter(Boolean);
    if (locNames.length) meta.push((langIsEn ? 'Location: ' : 'Schauplatz: ') + locNames.join(', '));
    const comments = [...new Set(scenes.map(s => s.kommentar).filter(Boolean))].join(' ');
    if (comments) meta.push((langIsEn ? 'Notes: ' : 'Notiz: ') + comments);
    if (meta.length === 0) continue;
    const instr = (langIsEn
      ? 'Write a scene with the following parameters:\n'
      : 'Schreibe eine Szene mit folgenden Vorgaben:\n') + meta.join('\n');
    samples.push({
      id: 'scene|' + pageId,
      type: 'scene',
      messages: [
        { role: 'system', content: unifiedSys },
        { role: 'user', content: instr },
        { role: 'assistant', content: completion },
      ],
    });
    counts.scene++;
  }

  // ── Alle Seiten als Meta→Text (unabhängig vom Scene-Mapping) ─────────
  // Der User will den gesamten Buchinhalt internalisiert — jede Seite
  // erhält ein Sample „Seite «X», Kapitel «Y»: schreibe den Inhalt" →
  // Seitentext. Das doppelt sich bewusst mit dem Szenen-Block (dort
  // metadaten-reicher), hier einfacher und vollständig deckend.
  for (const p of pageContents) {
    if (!p.text || p.text.length < minChars) continue;
    const completion = p.text.length > maxChars ? p.text.slice(0, maxChars) : p.text;
    const metaParts = [];
    if (bookName) metaParts.push(langIsEn ? `Book: «${bookName}»` : `Buch: «${bookName}»`);
    if (p.chapter) metaParts.push(langIsEn ? `Chapter: «${p.chapter}»` : `Kapitel: «${p.chapter}»`);
    if (p.title)   metaParts.push(langIsEn ? `Page: «${p.title}»` : `Seite: «${p.title}»`);
    const instr = (langIsEn
      ? 'Write the content of this page:\n'
      : 'Schreibe den Inhalt dieser Seite:\n') + metaParts.join('\n');
    samples.push({
      id: 'page|' + p.id,
      type: 'scene',
      messages: [
        { role: 'system', content: unifiedSys },
        { role: 'user', content: instr },
        { role: 'assistant', content: completion },
      ],
    });
    counts.scene++;

    // ── Page-Fortsetzung: erste 15% als Prompt → Rest als Completion.
    // Lehrt das Modell, von einer Anfangsszene aus weiterzuschreiben,
    // was für die Fortsetzungs-Fähigkeit des fertigen Modells zentral ist.
    if (p.text.length >= minChars * 2) {
      const [opening, rest] = splitAtSentence(completion, 0.15);
      if (opening.length >= 80 && rest.length >= 120) {
        const prefix = metaParts.length
          ? metaParts.join(' · ') + '\n\n'
          : '';
        samples.push({
          id: 'pageCont|' + p.id,
          type: 'scene',
          messages: [
            { role: 'system', content: unifiedSys },
            { role: 'user', content: (langIsEn
              ? 'Continue this passage:\n\n'
              : 'Setze diese Passage fort:\n\n') + prefix + opening },
            { role: 'assistant', content: rest },
          ],
        });
        counts.scene++;
      }
    }
  }

  // ── Kapitel-Anfänge mit vollem Metadaten-Kontext (#4) ────────────────
  // Pro Kapitel: Prompt kombiniert Kapitelname + Figuren (aus
  // figure_appearances), Orte (aus location_chapters), Kurz-Zusammenfassung
  // (aus chapter_reviews) + Vorgänger-Ausklang → Completion = erste
  // 3000 Zeichen des Kapitels. Lehrt, wie Kapitel in genau diesem Buch
  // begonnen werden, mit welcher Besetzung und Stimmung.
  const chapterReviewMap = new Map();
  try {
    const crRows = db.prepare(`
      SELECT cr1.chapter_name, cr1.review_json
      FROM chapter_reviews cr1
      WHERE cr1.book_id = ? AND cr1.user_email = ?
        AND cr1.reviewed_at = (
          SELECT MAX(cr2.reviewed_at) FROM chapter_reviews cr2
          WHERE cr2.book_id = cr1.book_id AND cr2.chapter_id = cr1.chapter_id AND cr2.user_email = cr1.user_email
        )
    `).all(bookIdInt, userEmail);
    for (const r of crRows) {
      if (!r.chapter_name || !r.review_json) continue;
      try {
        const cr = JSON.parse(r.review_json);
        if (cr?.zusammenfassung) chapterReviewMap.set(r.chapter_name, cr.zusammenfassung);
      } catch { /* ignore */ }
    }
  } catch { /* chapter_reviews optional */ }

  // figures per chapter via figure_appearances.chapter_name
  const figsByChName = new Map();
  for (const f of figRows) {
    for (const ch of (appearancesByFigPk.get(f.pk) || [])) {
      if (!figsByChName.has(ch)) figsByChName.set(ch, []);
      figsByChName.get(ch).push(f.name);
    }
  }
  // locations per chapter via location_chapters
  const locsByChName = new Map();
  for (const l of locRows) {
    for (const ch of (chaptersByLocPk.get(l.pk) || [])) {
      if (!locsByChName.has(ch)) locsByChName.set(ch, []);
      locsByChName.get(ch).push(l.name);
    }
  }

  for (let ci = 0; ci < chapterKeys.length; ci++) {
    const k = chapterKeys[ci];
    const text = chapterFullTextByKey.get(k) || '';
    if (text.length < 400) continue;
    const name = chapterNameByKey.get(k);
    const opening = text.slice(0, Math.min(3000, maxChars, text.length));
    if (opening.length < 200) continue;
    const metaLines = [];
    if (bookName) metaLines.push(langIsEn ? `Book: «${bookName}»` : `Buch: «${bookName}»`);
    metaLines.push(langIsEn ? `Chapter: «${name}»` : `Kapitel: «${name}»`);
    const chFigs = (figsByChName.get(name) || []).slice(0, 10);
    if (chFigs.length) metaLines.push(langIsEn ? `Cast: ${chFigs.join(', ')}` : `Figuren: ${chFigs.join(', ')}`);
    const chLocs = (locsByChName.get(name) || []).slice(0, 6);
    if (chLocs.length) metaLines.push(langIsEn ? `Settings: ${chLocs.join(', ')}` : `Schauplätze: ${chLocs.join(', ')}`);
    const summary = chapterReviewMap.get(name);
    if (summary) metaLines.push(langIsEn ? `Summary: ${summary}` : `Inhalt: ${summary}`);
    // Vorgänger-Ausklang: letzte 400 Zeichen des vorherigen Kapitels
    if (ci > 0) {
      const prevText = chapterFullTextByKey.get(chapterKeys[ci - 1]) || '';
      if (prevText.length > 200) {
        const prevTail = prevText.slice(-400).trim();
        metaLines.push((langIsEn
          ? `Previous chapter ended with: `
          : `Vorheriges Kapitel endete mit: `) + prevTail);
      }
    }
    const instr = (langIsEn
      ? 'Begin this chapter in the author\'s style:\n'
      : 'Beginne dieses Kapitel im Stil des Autors:\n') + metaLines.join('\n');
    samples.push({
      id: 'chapOpen|' + k,
      type: 'scene',
      messages: [
        { role: 'system', content: unifiedSys },
        { role: 'user',   content: instr },
        { role: 'assistant', content: opening },
      ],
    });
    counts.scene++;
  }
}

module.exports = { buildSceneSamples };
