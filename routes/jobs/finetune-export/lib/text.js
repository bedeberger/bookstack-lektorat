'use strict';

function splitParagraphs(text) {
  return text.split(/\n\s*\n+/).map(p => p.trim()).filter(Boolean);
}

// Zerlegt Fliesstext in Sätze. Heuristik: Satzende = [.!?…], optional gefolgt
// von schliessender Anführungszeichen, dann Whitespace oder EOT. Hängt den
// Schlussrest (ohne Satzzeichen-Ende) als eigenen Satz an. Für deutsche und
// englische Prosa ausreichend zuverlässig; keine Abkürzungs-Erkennung.
function splitSentences(text) {
  const out = [];
  const re = /([.!?…]+[”"«»„"']?)(\s+|$)/g;
  let lastEnd = 0, m;
  while ((m = re.exec(text)) !== null) {
    const sentence = text.slice(lastEnd, m.index + m[1].length).trim();
    if (sentence) out.push(sentence);
    lastEnd = m.index + m[0].length;
  }
  const tail = text.slice(lastEnd).trim();
  if (tail) out.push(tail);
  return out;
}

// Splittet `text` nahe `ratio` (0–1) an einer Satzgrenze. Sucht zuerst rückwärts
// vom Zielindex nach dem letzten Satzende, fällt dann vorwärts zurück.
function splitAtSentence(text, ratio) {
  const target = Math.max(1, Math.min(text.length - 1, Math.floor(text.length * ratio)));
  const head = text.slice(0, target);
  const tail = text.slice(target);
  const lastStop = head.search(/[.!?…][”"«»„"']?\s+[A-ZÄÖÜ"„«][^.!?…]*$/);
  if (lastStop !== -1) {
    const after = head.slice(lastStop).search(/\s/);
    if (after !== -1) {
      const idx = lastStop + after + 1;
      return [text.slice(0, idx).trim(), text.slice(idx).trim()];
    }
  }
  const nextStop = tail.search(/[.!?…][”"«»„"']?\s+[A-ZÄÖÜ"„«]/);
  if (nextStop !== -1) {
    const idx = target + nextStop + 1;
    return [text.slice(0, idx + 1).trim(), text.slice(idx + 1).trim()];
  }
  return [head.trim(), tail.trim()];
}

const splitHalfAtSentence = (text) => splitAtSentence(text, 0.5);

// Dialog-Zitate (DE + EN-Typografie + ASCII). Bewusst konservativ — matched nur
// Zitate innerhalb eines Absatzes (keine Zeilenumbrüche), damit keine
// mehrseitigen False-Positives entstehen.
function extractDialogs(text) {
  const results = [];
  const patterns = [
    /„([^"\n]{10,400})"/g,
    /"([^"\n]{10,400})"/g,     // U+201C/U+201D
    /«\s?([^»\n]{10,400})\s?»/g,
    /"([^"\n]{10,400})"/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      results.push({ quote: m[1].trim(), start: m.index, end: m.index + m[0].length });
    }
  }
  results.sort((a, b) => a.start - b.start);
  return results;
}

module.exports = {
  splitParagraphs,
  splitSentences,
  splitAtSentence,
  splitHalfAtSentence,
  extractDialogs,
};
