'use strict';

const { splitParagraphs } = require('../../lib/text');
const { escapeRe } = require('../../lib/names');

// Block 21: Text-geerdete Figur-Passagen
function buildFigurePassageSamples(ctx) {
  const { langIsEn, opts, figRows, pageContents, pushQA } = ctx;
  const { maxChars } = opts;

  // Für jede Figur suchen wir ein paar konkrete Textausschnitte, in denen
  // der Name vorkommt. Prompt: „Zeig mir eine Passage mit X" → Absatz aus
  // dem Buch. Groundet Figurwissen direkt im Quelltext.
  const PASSAGE_MAX_PER_FIG = 5;
  for (const f of figRows) {
    const names = [f.name, f.kurzname].filter(n => n && String(n).trim().length >= 2);
    if (!names.length) continue;
    const longestFirst = [...names].sort((a, b) => b.length - a.length);
    const found = [];
    for (const p of pageContents) {
      if (found.length >= PASSAGE_MAX_PER_FIG) break;
      const paragraphs = splitParagraphs(p.text);
      for (const para of paragraphs) {
        if (found.length >= PASSAGE_MAX_PER_FIG) break;
        if (para.length < 120 || para.length > maxChars) continue;
        const hits = longestFirst.some(n => new RegExp('\\b' + escapeRe(n) + '\\b', 'i').test(para));
        if (!hits) continue;
        found.push({ para, page: p });
      }
    }
    for (let j = 0; j < found.length; j++) {
      const { para, page } = found[j];
      pushQA('authorChat|figPass|' + f.fig_id + '|' + j,
        langIsEn
          ? `Show me a passage where ${f.name} appears.`
          : `Zeig mir eine Passage mit ${f.name}.`,
        para);
      // Variante mit Kapitel-Kontext als weitere Formulierung
      if (page.chapter && j === 0) {
        pushQA('authorChat|figPassCh|' + f.fig_id,
          langIsEn
            ? `How does ${f.name} appear in «${page.chapter}»?`
            : `Wie tritt ${f.name} in «${page.chapter}» auf?`,
          para);
      }
    }
  }
}

module.exports = { buildFigurePassageSamples };
