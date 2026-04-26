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
    pagesByChapter,
    figRows, locRows, appearancesByFigPk, chaptersByLocPk,
  } = ctx;
  const { minChars, maxChars, maxFullChars, fulltext } = opts;

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

    // ── Page-Sliding-Window: 3 Cuts (15%, 50%, 80%) ──────────────────────
    // Anfang/Mitte/Ende decken alle drei narrativen Positionen, damit das
    // Modell nicht nur eröffnen, sondern auch zur Hälfte und am Ende
    // weiterschreiben lernt.
    if (p.text.length >= minChars * 2) {
      const prefix = metaParts.length ? metaParts.join(' · ') + '\n\n' : '';
      for (const cut of [0.15, 0.5, 0.8]) {
        const [opening, rest] = splitAtSentence(completion, cut);
        if (opening.length < 80 || rest.length < 120) continue;
        samples.push({
          id: 'pageCont|' + p.id + '|' + Math.round(cut * 100),
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

    // ── Cloze-Vervollständigung: Mittelteil herausschneiden ──────────────
    // Lehrt Inferenz innerhalb einer Passage, multipliziert vorhandenen
    // Buchtext um Faktor 3 ohne neue Inhalte. Schnitt an Satzgrenzen, damit
    // Output nicht mit Halbsatz beginnt.
    if (p.text.length >= minChars * 3) {
      const [head, midTail] = splitAtSentence(completion, 0.33);
      const [mid, tail]    = splitAtSentence(midTail, 0.5);
      if (head.length >= 80 && mid.length >= 80 && tail.length >= 80) {
        const gap = langIsEn ? '\n\n[…]\n\n' : '\n\n[…]\n\n';
        const prefix = metaParts.length ? metaParts.join(' · ') + '\n\n' : '';
        samples.push({
          id: 'pageCloze|' + p.id,
          type: 'scene',
          messages: [
            { role: 'system', content: unifiedSys },
            { role: 'user', content: (langIsEn
              ? 'Fill in the missing middle section of this passage:\n\n'
              : 'Vervollständige den fehlenden Mittelteil dieser Passage:\n\n') + prefix + head + gap + tail },
            { role: 'assistant', content: mid },
          ],
        });
        counts.scene++;
      }
    }
  }

  // ── Multi-Page-Continuation: N Vorseiten → nächste Seite ─────────────
  // Lange Kontextfenster ausnutzen (Mistral 128k). Lehrt Konsistenz über
  // Seitengrenzen hinweg: gleiche Figurenbestand, Tempus, POV.
  const pagesByChapterArr = [...pagesByChapter.values()];
  for (const pages of pagesByChapterArr) {
    if (pages.length < 2) continue;
    for (let i = 1; i < pages.length; i++) {
      const cur = pages[i];
      if (!cur.text || cur.text.length < minChars) continue;
      const prevSlice = pages.slice(Math.max(0, i - 2), i);
      const ctxText = prevSlice.map(p => p.text).join('\n\n');
      if (ctxText.length < minChars) continue;
      const ctxCapped = ctxText.length > maxFullChars
        ? ctxText.slice(-maxFullChars)
        : ctxText;
      const completion = cur.text.length > maxChars ? cur.text.slice(0, maxChars) : cur.text;
      samples.push({
        id: 'pageMulti|' + cur.id,
        type: 'scene',
        messages: [
          { role: 'system', content: unifiedSys },
          { role: 'user', content: (langIsEn
            ? 'Here are the previous pages. Write the next page:\n\n'
            : 'Hier die vorherigen Seiten. Schreibe die nächste Seite:\n\n') + ctxCapped },
          { role: 'assistant', content: completion },
        ],
      });
      counts.scene++;
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

  // ── Voll-Kapitel-Samples (chunked nach maxFullChars) ─────────────────
  // Lange Kapitel werden in Slices ≤maxFullChars gesplittet (an Satzgrenzen),
  // jeder Slice = eigenes Sample mit Part-Label + Vorgänger-Tail als
  // Continuity-Kontext. So passt voller Buchtext auch in 4096-seqlen
  // (maxFullChars=10000 chars ≈ 3000 Tekken-V7-Tokens).
  // Generiert: (a) chunked-fulltext, (b) Sliding-Window-Cuts auf 1. Slice,
  // (c) Kapitel→Kapitel-Continuation mit gestutztem Vorgänger-Tail.
  const sliceAtSentence = (text, maxLen) => {
    if (text.length <= maxLen) return [text];
    const out = [];
    let remaining = text;
    while (remaining.length > maxLen) {
      const ratio = maxLen / remaining.length;
      const [head, rest] = splitAtSentence(remaining, ratio);
      if (!head.length || head.length === remaining.length) {
        out.push(remaining.slice(0, maxLen));
        remaining = remaining.slice(maxLen);
        break;
      }
      out.push(head);
      remaining = rest;
    }
    if (remaining.length > 0) out.push(remaining);
    return out;
  };

  if (fulltext) {
    for (let ci = 0; ci < chapterKeys.length; ci++) {
      const k = chapterKeys[ci];
      const text = chapterFullTextByKey.get(k) || '';
      if (text.length < 600) continue;
      const name = chapterNameByKey.get(k);

      const metaLines = [];
      if (bookName) metaLines.push(langIsEn ? `Book: «${bookName}»` : `Buch: «${bookName}»`);
      metaLines.push(langIsEn ? `Chapter: «${name}»` : `Kapitel: «${name}»`);
      const chFigs = (figsByChName.get(name) || []).slice(0, 12);
      if (chFigs.length) metaLines.push(langIsEn ? `Cast: ${chFigs.join(', ')}` : `Figuren: ${chFigs.join(', ')}`);
      const chLocs = (locsByChName.get(name) || []).slice(0, 8);
      if (chLocs.length) metaLines.push(langIsEn ? `Settings: ${chLocs.join(', ')}` : `Schauplätze: ${chLocs.join(', ')}`);
      const summary = chapterReviewMap.get(name);
      if (summary) metaLines.push(langIsEn ? `Summary: ${summary}` : `Inhalt: ${summary}`);

      // (a) Voll-Kapitel chunked. Jeder Slice eigenständiges Sample. Bei
      // total>1 enthält Prompt Part-Label + Vorgänger-Tail (300 chars) als
      // Continuity-Anker, damit Modell die Kette als zusammenhängenden
      // Kapitelfluss lernt statt isolierte Schnipsel.
      const slices = sliceAtSentence(text, maxFullChars);
      const total = slices.length;
      for (let si = 0; si < total; si++) {
        const slice = slices[si];
        if (slice.length < 200) continue;
        const partLabel = total > 1
          ? (langIsEn ? `Part: ${si + 1} of ${total}` : `Teil: ${si + 1} von ${total}`)
          : null;
        const sliceMeta = partLabel ? [...metaLines, partLabel] : metaLines;
        const ctxTail = si > 0 ? slices[si - 1].slice(-300).trim() : '';
        const ctxBlock = ctxTail
          ? '\n\n' + (langIsEn ? 'Continues from:\n' : 'Anschluss an:\n') + ctxTail
          : '';
        const instr = total === 1
          ? (langIsEn
              ? 'Write this entire chapter in the author\'s style:\n'
              : 'Schreibe das ganze Kapitel im Stil des Autors:\n') + sliceMeta.join('\n')
          : (langIsEn
              ? `Write part ${si + 1} of ${total} of this chapter in the author's style:\n`
              : `Schreibe Teil ${si + 1} von ${total} dieses Kapitels im Stil des Autors:\n`)
            + sliceMeta.join('\n') + ctxBlock;
        samples.push({
          id: total > 1 ? 'chapFullChunk|' + k + '|' + si : 'chapFull|' + k,
          type: 'scene',
          messages: [
            { role: 'system', content: unifiedSys },
            { role: 'user', content: instr },
            { role: 'assistant', content: slice },
          ],
        });
        counts.scene++;
      }

      // (b) Sliding-Window-Cuts auf 1. Slice (oder ganzem Kapitel, falls
      // nicht gechunkt). Bei mehreren Slices liegen die Cuts „innerhalb
      // Teil 1" — die Folge-Slices werden bereits durch (a) abgedeckt.
      const baseSlice = slices[0];
      for (const cut of [0.2, 0.5, 0.8]) {
        const [head, rest] = splitAtSentence(baseSlice, cut);
        if (head.length < 200 || rest.length < 200) continue;
        samples.push({
          id: 'chapCont|' + k + '|' + Math.round(cut * 100),
          type: 'scene',
          messages: [
            { role: 'system', content: unifiedSys },
            { role: 'user', content: (langIsEn
              ? 'Continue this chapter:\n\n'
              : 'Setze dieses Kapitel fort:\n\n') + metaLines.join(' · ') + '\n\n' + head },
            { role: 'assistant', content: rest },
          ],
        });
        counts.scene++;
      }

      // (c) Kapitel→Kapitel-Continuation: gestutzter Vorgänger-Tail
      // (maxFullChars/2) + Anfang Kapitel N → Rest Kapitel N. Tail-Cap
      // hält Sample im seqlen-Budget auch bei kleinem maxFullChars.
      if (ci > 0) {
        const prevK = chapterKeys[ci - 1];
        const prevText = chapterFullTextByKey.get(prevK) || '';
        const prevName = chapterNameByKey.get(prevK);
        if (prevText.length >= 400) {
          const prevTailCap = Math.max(800, Math.floor(maxFullChars / 2));
          const prevCapped = prevText.length > prevTailCap
            ? prevText.slice(-prevTailCap)
            : prevText;
          const [chHead, chRest] = splitAtSentence(baseSlice, 0.1);
          if (chHead.length >= 100 && chRest.length >= 200) {
            const ctxLabel = langIsEn
              ? `Previous chapter «${prevName}» ended:\n${prevCapped}\n\nNew chapter «${name}» begins:\n${chHead}`
              : `Vorheriges Kapitel «${prevName}» endete:\n${prevCapped}\n\nNeues Kapitel «${name}» beginnt:\n${chHead}`;
            samples.push({
              id: 'chapBridge|' + k,
              type: 'scene',
              messages: [
                { role: 'system', content: unifiedSys },
                { role: 'user', content: (langIsEn
                  ? 'Write the rest of the new chapter, picking up from where it begins:\n\n'
                  : 'Schreibe das neue Kapitel weiter, knüpfend an den Anfang:\n\n') + ctxLabel },
                { role: 'assistant', content: chRest },
              ],
            });
            counts.scene++;
          }
        }
      }
    }
  }
}

module.exports = { buildSceneSamples };
