'use strict';

const { hashSplit } = require('../../lib/names');

// Block 1+2: Figuren-Composite + Trait-Q&A
function buildFigureBaseSamples(ctx) {
  const { langIsEn, opts, figRows, figQuestions, pushQA, pickVariants } = ctx;
  const seed = opts.valSeed;

  // ── Figuren-Q&A ────────────────────────────────────────────────────────
  // Composite answer: beschreibung als Rückgrat + ein angehängter Satz zu
  // Beruf/Geschlecht/Tags (so die Antwort wie Prosa klingt und nicht wie CSV).
  for (const f of figRows) {
    const desc = (f.beschreibung || '').trim();
    if (!desc) continue;
    const extras = [];
    if (f.beruf) extras.push(langIsEn ? `Occupation: ${f.beruf}.` : `Beruf: ${f.beruf}.`);
    if (f.tags_csv) {
      const tags = f.tags_csv.split(',').map(t => t.trim()).filter(Boolean).slice(0, 4).join(', ');
      if (tags) extras.push(langIsEn ? `Traits: ${tags}.` : `Eigenschaften: ${tags}.`);
    }
    const answer = [desc, ...extras].join(' ');
    // 3 Paraphrasen pro Figur → gleiche Fakten mehrmals sehen → bessere
    // Memorisierung der Buchwelt (Ziel: Figur als «Realität» akzeptieren).
    const idxs = pickVariants('fig|' + f.fig_id, figQuestions, 3);
    for (const idx of idxs) {
      const q = figQuestions[idx].replace('{name}', f.name);
      pushQA('authorChat|fig|' + f.fig_id + '|' + idx, q, answer);
    }
    // Zusatz-Frage mit Kurzname als Zielnamen (wenn vorhanden), damit das
    // Modell beide Namen-Varianten kennt.
    if (f.kurzname && f.kurzname !== f.name && f.kurzname.trim().length >= 2) {
      const altIdx = Math.floor(hashSplit('figAlt|' + f.fig_id, seed) * figQuestions.length);
      const q = figQuestions[altIdx].replace('{name}', f.kurzname);
      pushQA('authorChat|figAlt|' + f.fig_id, q, answer);
    }
  }

  // ── Figuren-Charaktereigenschaften (Tags) ────────────────────────────
  // Pro Figur ein dediziertes Trait-Sample, damit "Wie ist X charakterlich?"
  // direkt auf figure_tags zielt (nicht nur als Anhang in der Composite-Antwort).
  for (const f of figRows) {
    if (!f.tags_csv) continue;
    const tags = f.tags_csv.split(',').map(t => t.trim()).filter(Boolean);
    if (!tags.length) continue;
    const tagList = tags.join(', ');
    const traitQs = langIsEn
      ? [`What traits does ${f.name} have?`, `How would you characterize ${f.name}?`,
         `Describe ${f.name}'s personality.`, `What is ${f.name} like as a person?`]
      : [`Welche Eigenschaften hat ${f.name}?`, `Wie würdest du ${f.name} charakterisieren?`,
         `Beschreibe den Charakter von ${f.name}.`, `Was zeichnet ${f.name} charakterlich aus?`];
    const idxs = pickVariants('figTraits|' + f.fig_id, traitQs, 2);
    const answer = langIsEn
      ? `${f.name} is: ${tagList}.`
      : `${f.name} ist: ${tagList}.`;
    for (const idx of idxs) {
      pushQA('authorChat|figTraits|' + f.fig_id + '|' + idx, traitQs[idx], answer);
    }
  }
}

// Block 17+18+19: Lebensereignisse + Auftritte + Dialogstil
function buildFigureMetaSamples(ctx) {
  const { langIsEn, figRows, eventsByFigPk, appearancesByFigPk, dialogsByFigure, pushQA } = ctx;

  // ── Figuren-Lebensereignisse ─────────────────────────────────────────
  // Pro figure_events-Eintrag ein gezielter Fakt + eine aggregierte Antwort
  // für „Was erlebt X im Buch?"
  for (const f of figRows) {
    const evts = eventsByFigPk.get(f.pk) || [];
    if (!evts.length) continue;
    for (let j = 0; j < evts.length; j++) {
      const e = evts[j];
      const parts = [e.ereignis];
      if (e.datum)     parts.push(langIsEn ? `(${e.datum})` : `(${e.datum})`);
      if (e.bedeutung) parts.push('— ' + e.bedeutung);
      const answer = parts.join(' ');
      pushQA('authorChat|figEvt|' + f.fig_id + '|' + j,
        langIsEn
          ? `What happens to ${f.name} ${e.datum ? `around ${e.datum}` : `during the story`}?`
          : `Was passiert mit ${f.name}${e.datum ? ` (${e.datum})` : ' im Verlauf der Geschichte'}?`,
        answer);
    }
    const allEvtsList = evts.slice(0, 8)
      .map(e => `${e.datum ? e.datum + ': ' : ''}${e.ereignis}${e.bedeutung ? ' (' + e.bedeutung + ')' : ''}`)
      .join(' · ');
    pushQA('authorChat|figAllEvt|' + f.fig_id,
      langIsEn ? `What are the key moments in ${f.name}'s story?` : `Welche Schlüsselmomente erlebt ${f.name}?`,
      allEvtsList);
  }

  // ── Figuren-Auftritte (Kapitel-Liste) ────────────────────────────────
  for (const f of figRows) {
    const chs = appearancesByFigPk.get(f.pk) || [];
    if (!chs.length) continue;
    const answer = chs.slice(0, 20).join(', ');
    pushQA('authorChat|figApp|' + f.fig_id,
      langIsEn ? `In which chapters does ${f.name} appear?` : `In welchen Kapiteln taucht ${f.name} auf?`,
      langIsEn ? `${f.name} appears in: ${answer}.` : `${f.name} kommt vor in: ${answer}.`);
  }

  // ── Figuren-Dialogstil: wie spricht X? ───────────────────────────────
  // Wenn wir Zitate einer Figur gesammelt haben, aggregieren wir die
  // prägnantesten als Sprach-Portrait. Nimmt die mittleren Längen (nicht
  // zu kurz, nicht zu lang) — die eigentlichen Stimm-Träger.
  for (const f of figRows) {
    const entries = dialogsByFigure.get(f.name.toLowerCase()) || [];
    const altEntries = (f.kurzname && f.kurzname !== f.name)
      ? (dialogsByFigure.get(f.kurzname.toLowerCase()) || [])
      : [];
    const seenQ = new Set();
    const combined = [];
    for (const e of [...entries, ...altEntries]) {
      if (seenQ.has(e.quote)) continue;
      if (e.quote.length < 20 || e.quote.length > 220) continue;
      seenQ.add(e.quote);
      combined.push(e);
    }
    if (combined.length < 2) continue;
    const sample = combined.slice(0, 6).map(e => `„${e.quote}"`).join(' · ');
    pushQA('authorChat|figVoice|' + f.fig_id,
      langIsEn ? `How does ${f.name} speak? Show me a few lines.` : `Wie spricht ${f.name}? Zeig mir ein paar Sätze.`,
      sample);
  }
}

module.exports = { buildFigureBaseSamples, buildFigureMetaSamples };
