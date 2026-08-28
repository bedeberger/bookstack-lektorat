'use strict';

const { db } = require('../../../../../db/schema');

// Block 29: Welt-Fakten (world_facts) — deklaratives Buch-Wissen der Komplettanalyse.
//
// KEIN vom Autor kuratierter Kanon: `world_facts` ist ein abgeleiteter Index, den
// Phase 1 der Komplettanalyse per Full-Replace schreibt (es gibt keinen Edit-Pfad,
// die Karte ist read-only). Gegenüber Block 20 (chapter_extract_cache) ist der
// Unterschied nur, dass diese Fakten PERSISTIERT sind — nicht, dass sie von Hand
// geprüft wären.
//
// Genau darum steht der Faktencheck-Filter unten: ein Fakt vervielfacht sich hier
// zu rund einem halben Dutzend Trainingssamples (Paraphrasen + Subjekt-Sammlung +
// Kategorie-Sammlung + Welt-Übersicht). Ein schiefer Fakt würde damit sechsfach
// eingeübt — bei Trainingsdaten ist die Vervielfachung des Fehlers teurer als das
// fehlende Sample.
function buildWorldFactSamples(ctx) {
  const { langIsEn, bookIdInt, userEmail, pushQA, pickVariants } = ctx;

  const factRows = db.prepare(`
    SELECT id, kategorie, subjekt, fakt, seite_label
    FROM world_facts
    WHERE book_id = ? AND (user_email = ? OR (? IS NULL AND user_email IS NULL))
    ORDER BY sort_order
  `).all(bookIdInt, userEmail, userEmail);
  if (!factRows.length) return;

  // Als real FALSCH belegte Fakten aussortieren. Der Faktencheck-Job (web_search,
  // opt-in pro Buch) persistiert seine Befunde als typ='faktenfehler' in
  // continuity_issues; `stelle_a` trägt dort die geprüfte Aussage in genau der Form
  // `subjekt: fakt` (siehe routes/jobs/komplett/job-faktencheck.js). Der Abgleich
  // läuft deshalb über den normalisierten Text — es gibt keine fact_id am Befund,
  // und eine einzuführen hiesse, den Befund an einen Index zu hängen, der beim
  // nächsten Lauf komplett ersetzt wird.
  // Läuft der Faktencheck nie, ist die Menge leer und nichts wird gefiltert.
  const _normFakt = (x) => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const falsch = new Set(
    db.prepare(`
      SELECT ci.stelle_a
        FROM continuity_issues ci
        JOIN continuity_checks cc ON cc.id = ci.check_id
       WHERE cc.book_id = ? AND cc.user_email IS ? AND ci.typ = 'faktenfehler'
    `).all(bookIdInt, userEmail || null)
      .map(r => _normFakt(r.stelle_a))
      .filter(Boolean)
  );
  const istFalsch = (r) => falsch.size > 0
    && falsch.has(_normFakt(`${r.subjekt ? `${r.subjekt}: ` : ''}${r.fakt}`));

  // Junction: fact_id → [chapter_name]
  const chByFact = new Map();
  for (const r of db.prepare(`
    SELECT wfc.fact_id, c.chapter_name AS name
    FROM world_fact_chapters wfc
    JOIN world_facts wf ON wf.id = wfc.fact_id
    LEFT JOIN chapters c ON c.chapter_id = wfc.chapter_id
    WHERE wf.book_id = ?
  `).all(bookIdInt)) {
    if (!r.name) continue;
    if (!chByFact.has(r.fact_id)) chByFact.set(r.fact_id, []);
    chByFact.get(r.fact_id).push(r.name);
  }

  const subjQuestions = langIsEn
    ? ['Tell me a fact about {subjekt}.', 'What do you know about {subjekt}?',
       'What is true about {subjekt}?', 'Give me a detail about {subjekt}.']
    : ['Nenn mir einen Fakt über {subjekt}.', 'Was weisst du über {subjekt}?',
       'Was stimmt über {subjekt}?', 'Erzähl mir ein Detail zu {subjekt}.'];

  const factsBySubject = new Map();   // subjekt lower → { subjekt, items:[{fakt,kategorie,seite,kapitel}] }
  const factsByCategory = new Map();  // kategorie lower → { kategorie, items:[fakt] }

  for (const r of factRows) {
    const fakt = (r.fakt || '').trim();
    if (fakt.length < 8) continue;
    if (istFalsch(r)) continue;   // gegen die reale Faktenlage widerlegt
    const subjekt   = (r.subjekt || '').trim();
    const kategorie = (r.kategorie || '').trim();
    const seite     = (r.seite_label || '').trim();
    const kapitel   = chByFact.get(r.id) || [];

    // Vollantwort mit Quellenanker
    const tail = [];
    if (kapitel.length) tail.push(langIsEn ? `In chapter(s): ${kapitel.slice(0, 5).join(', ')}.` : `In Kapitel: ${kapitel.slice(0, 5).join(', ')}.`);
    else if (seite)     tail.push(langIsEn ? `(from «${seite}»)` : `(aus «${seite}»)`);
    const answer = tail.length ? `${fakt} ${tail.join(' ')}` : fakt;

    // Einzel-Fakt-Q&A mit mehreren Paraphrasen (nur wenn Subjekt vorhanden)
    if (subjekt) {
      const idxs = pickVariants('wfact|' + r.id, subjQuestions, subjQuestions.length);
      for (const idx of idxs) {
        const q = subjQuestions[idx].replace('{subjekt}', subjekt);
        pushQA('authorChat|wfact|' + r.id + '|' + idx, q, answer);
      }
      const skey = subjekt.toLowerCase();
      if (!factsBySubject.has(skey)) factsBySubject.set(skey, { subjekt, items: [] });
      factsBySubject.get(skey).items.push({ fakt, kategorie, seite, kapitel });
    }
    if (kategorie) {
      const ckey = kategorie.toLowerCase();
      if (!factsByCategory.has(ckey)) factsByCategory.set(ckey, { kategorie, items: [] });
      factsByCategory.get(ckey).items.push(fakt);
    }

    // Reverse: Fakt → Kapitel
    if (kapitel.length) {
      pushQA('authorChat|wfactCh|' + r.id,
        langIsEn ? `In which chapter is this established: "${fakt}"` : `In welchem Kapitel wird das etabliert: „${fakt}"`,
        kapitel.join(', '));
    }
  }

  // Gruppiert pro Subjekt — reiche „Erzähl mir alles über X"-Antwort
  for (const [, group] of factsBySubject) {
    if (group.items.length < 2) continue;
    const joined = group.items.slice(0, 20).map(it => it.fakt).join(' ');
    pushQA('authorChat|wfactSubjAll|' + group.subjekt.toLowerCase(),
      langIsEn ? `Tell me everything you know about ${group.subjekt}.` : `Erzähl mir alles, was du über ${group.subjekt} weisst.`,
      joined);
    pushQA('authorChat|wfactSubjAll2|' + group.subjekt.toLowerCase(),
      langIsEn ? `Summarize the world facts about ${group.subjekt}.` : `Fasse die Weltfakten zu ${group.subjekt} zusammen.`,
      joined);
  }

  // Gruppiert pro Kategorie — thematischer Lore-Block
  for (const [, group] of factsByCategory) {
    if (group.items.length < 2) continue;
    const joined = group.items.slice(0, 20).join(' ');
    pushQA('authorChat|wfactCatAll|' + group.kategorie.toLowerCase(),
      langIsEn ? `What does the book establish about ${group.kategorie}?` : `Was etabliert das Buch zum Thema ${group.kategorie}?`,
      joined);
    pushQA('authorChat|wfactCatAll2|' + group.kategorie.toLowerCase(),
      langIsEn ? `Tell me about ${group.kategorie} in this world.` : `Erzähl mir über ${group.kategorie} in dieser Welt.`,
      joined);
  }

  // Globale Welt-Übersicht
  const gueltig = factRows.filter(r => !istFalsch(r));
  if (gueltig.length >= 2) {
    const all = gueltig.map(r => (r.fakt || '').trim()).filter(f => f.length >= 8).slice(0, 30).join(' ');
    pushQA('authorChat|wfactAll',
      langIsEn ? `Describe the world of this book.` : `Beschreibe die Welt dieses Buches.`,
      all);
    pushQA('authorChat|wfactAll2',
      langIsEn ? `What are the key facts about the book's world?` : `Was sind die wichtigsten Fakten über die Welt des Buches?`,
      all);
  }
}

module.exports = { buildWorldFactSamples };
