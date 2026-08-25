'use strict';
// Kandidatensuche: welche Saetze eines Seitentexts sagen etwas ueber das Alter
// welcher Figur? Reine Funktionen — der Aufrufer (routes/jobs/figur-alter.js)
// bringt die Namensmuster mit (lib/page-index.js#buildFigureNamePatterns), damit
// dieses Modul ohne DB testbar bleibt und es fuer „was gilt als Erwaehnung
// dieser Figur" nur eine Definition gibt.

const { extractAgeSignals, splitSentences, foldWord } = require('./patterns');

// Grobfilter vor den ~20 Mustern: enthaelt der Satz ueberhaupt etwas, das eine
// Alters- oder Jahresangabe sein koennte? Spart auf einem 1-Mio-Zeichen-Buch den
// Grossteil der Regex-Laeufe.
const COARSE_RE = /\d|j[äa]hrig|Jahre|Jahren|geboren|geb\.|Jahrgang|Geburtstag|year|aged|born/i;

/** Nachschlage-Struktur fuer „welche Figur wird hier genannt".
 *  `figures`: [{ id, patterns: [{ text }] }] */
function buildNameIndex(figures) {
  const byForm = new Map();   // gefaltete Musterform → Set<figure id>
  const forms = [];
  for (const f of figures || []) {
    for (const p of f.patterns || []) {
      const raw = String(p?.text ?? '').trim();
      if (!raw) continue;
      const key = foldWord(raw);
      if (!byForm.has(key)) { byForm.set(key, new Set()); forms.push(raw); }
      byForm.get(key).add(f.id);
    }
  }
  if (!forms.length) return null;
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Laengste Form zuerst: sonst gewinnt „Anna" gegen „Anna Berg".
  const alt = [...forms].sort((a, b) => b.length - a.length).map(esc).join('|');
  return {
    byForm,
    // Wortgrenzen umlaut-sicher (\b greift bei „Anna-Lena" falsch) — dieselbe
    // Klammerung wie in lib/page-index.js#computeFigureMentions.
    re: new RegExp(`(?<![A-Za-zÄÖÜäöüß])(${alt})(?![A-Za-zÄÖÜäöüß])`, 'giu'),
  };
}

/** Figuren-IDs, die in `text` genannt werden. */
function figuresInText(text, index) {
  if (!index || !text) return [];
  index.re.lastIndex = 0;
  const out = new Set();
  let m;
  while ((m = index.re.exec(text)) !== null) {
    const ids = index.byForm.get(foldWord(m[1]));
    if (ids) for (const id of ids) out.add(id);
    if (index.re.lastIndex === m.index) index.re.lastIndex++;
  }
  return [...out];
}

const SATZ_MAX = 320;

/** Satz auf Prompt-Laenge kuerzen — die Fundstellensuche schlaegt den Satz
 *  spaeter woertlich nach, darum von vorne kuerzen und nicht in der Mitte. */
function trimSatz(s) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > SATZ_MAX ? t.slice(0, SATZ_MAX) : t;
}

/**
 * Kandidatensaetze einer Seite.
 * @param {string} text   Seitentext (schon HTML-frei).
 * @param {object} index  aus buildNameIndex.
 * @param {object} meta   { page_id, chapter_id, chapter, page_name, ordinal }
 * @returns {Array} [{ figure_id, satz, signale, page_id, chapter, ordinal, offset, indirekt }]
 *   `indirekt` = die Figur steht nicht im Satz selbst, sondern im Satz davor
 *   (Pronomen-Anschluss: „Sie war damals zwoelf."). Das Modell erfaehrt das und
 *   entscheidet, ob der Bezug traegt.
 */
function scanPage(text, index, meta = {}) {
  if (!text || !index) return [];
  const sentences = splitSentences(text);
  const out = [];
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    if (!COARSE_RE.test(s.text)) continue;
    const signale = extractAgeSignals(s.text);
    if (!signale.length) continue;
    let ids = figuresInText(s.text, index);
    let indirekt = false;
    if (!ids.length && i > 0) {
      ids = figuresInText(sentences[i - 1].text, index);
      indirekt = true;
    }
    if (!ids.length) continue;
    const satz = trimSatz(indirekt ? `${sentences[i - 1].text} ${s.text}` : s.text);
    if (!satz) continue;
    for (const id of ids) {
      out.push({
        figure_id: id,
        satz,
        signale,
        page_id: meta.page_id ?? null,
        page_name: meta.page_name ?? null,
        chapter: meta.chapter ?? null,
        chapter_id: meta.chapter_id ?? null,
        ordinal: meta.ordinal ?? 0,
        offset: s.start,
        indirekt,
      });
    }
  }
  return out;
}

/** Hat ein Kandidat eine harte (nicht-schwache) Alters- oder Geburtsjahr-Angabe? */
function isStrong(c) {
  return (c.signale || []).some(sg => !sg.weak && (sg.art === 'alter' || sg.art === 'geburtsjahr'));
}

/**
 * Auswahl der Kandidaten einer Figur fuer den Prompt.
 *
 * ZWEI ZIELE, die gegeneinander laufen: die harten Angaben duerfen nicht
 * verlorengehen, und die Auswahl darf nicht im ersten Kapitel kleben — das Alter
 * einer Figur ist eine SPANNE ueber das Buch, und die sieht man nur, wenn Anfang
 * und Ende drin sind. Darum: alle harten Funde zuerst (bis zum Deckel), der Rest
 * gleichmaessig ueber die Leserichtung verteilt.
 * Gibt zusaetzlich zurueck, wie viele weggelassen wurden — ein stiller Deckel
 * liest sich wie „mehr gab es nicht".
 */
function selectCandidates(list, max = 12) {
  const items = [...(list || [])].sort((a, b) => (a.ordinal - b.ordinal) || (a.offset - b.offset));
  if (items.length <= max) return { picked: items, dropped: 0 };
  const strong = items.filter(isStrong);
  const weak = items.filter(c => !isStrong(c));
  const picked = [];
  const takeSpread = (arr, n) => {
    if (n <= 0 || !arr.length) return;
    if (arr.length <= n) { picked.push(...arr); return; }
    // Erster und letzter immer, dazwischen gleichmaessig.
    const step = (arr.length - 1) / (n - 1);
    const seen = new Set();
    for (let k = 0; k < n; k++) {
      const idx = Math.round(k * step);
      if (!seen.has(idx)) { seen.add(idx); picked.push(arr[idx]); }
    }
  };
  takeSpread(strong, Math.min(max, strong.length));
  takeSpread(weak, max - picked.length);
  picked.sort((a, b) => (a.ordinal - b.ordinal) || (a.offset - b.offset));
  return { picked, dropped: items.length - picked.length };
}

module.exports = { buildNameIndex, figuresInText, scanPage, selectCandidates, isStrong, trimSatz };
