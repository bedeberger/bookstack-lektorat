'use strict';
// Deterministische Erkennung von Alters- und Jahresangaben im Buchtext.
//
// ARBEITSTEILUNG mit dem Modell (dieselbe Trennung wie bei der Quellen-Erkennung,
// siehe routes/jobs/source-detect.js):
//   1. Dieses Modul waehlt KANDIDATENSAETZE aus — Saetze, in denen eine Figur
//      vorkommt UND eine Alters-/Jahresangabe steht. Es darf grosszuegig sein:
//      ein Fehlfund kostet ein paar Tokens im Prompt, ein verpasster Satz kostet
//      die Aussage.
//   2. Das Modell liest diese Saetze und sagt, WAS sie ueber die Figur behaupten
//      (Alter, Geburtsjahr, Bezugsjahr) — es sieht Kontext, den kein Muster sieht
//      ("drei Jahre spaeter", "an ihrem sechzehnten Geburtstag").
//   3. Die Zahlen dieses Moduls sind hinterher die PRUEFGROESSE: eine Zahl, die
//      das Modell nennt, die aber in seinem eigenen woertlichen Zitat gar nicht
//      vorkommt, ist erfunden und faellt heraus (lib/figure-age/consolidate.js).
//
// Rein rueckwaertsgewandt: liest Text, schreibt nie in ihn.

// ── Zahlwoerter ──────────────────────────────────────────────────────────────
// Ein Roman schreibt Alter meist aus ("die zwoelfjaehrige Anna"), Sachtexte
// ziffern es. Beides muss greifen.
const NUM_WORDS = {
  ein: 1, eine: 1, eins: 1, zwei: 2, drei: 3, vier: 4, fuenf: 5, sechs: 6,
  sieben: 7, acht: 8, neun: 9, zehn: 10, elf: 11, zwoelf: 12, dreizehn: 13,
  vierzehn: 14, fuenfzehn: 15, sechzehn: 16, siebzehn: 17, achtzehn: 18,
  neunzehn: 19, zwanzig: 20, dreissig: 30, vierzig: 40, fuenfzig: 50,
  sechzig: 60, siebzig: 70, achtzig: 80, neunzig: 90, hundert: 100,
};
// Unregelmaessige Ordinalstaemme ("an ihrem dritten Geburtstag").
const ORDINAL_IRREGULAR = { erst: 1, dritt: 3, siebt: 7, acht: 8 };
const TENS = ['zwanzig', 'dreissig', 'vierzig', 'fuenfzig', 'sechzig', 'siebzig', 'achtzig', 'neunzig'];
const ONES = ['ein', 'zwei', 'drei', 'vier', 'fuenf', 'sechs', 'sieben', 'acht', 'neun'];

/** Umlaute/ß auf die ASCII-Vergleichsform falten (dieselbe Schweizer Norm wie
 *  lib/lexicon/tokenize.js: ß → ss). Nur fuer den Wortlisten-Lookup, nie fuer
 *  die Anzeige. */
function foldWord(s) {
  return String(s ?? '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
}

/** Zahlwort → Zahl. Deckt "einundzwanzig"-Komposita mit ab. null, wenn das Wort
 *  keine Zahl ist. */
function germanNumberWord(word) {
  const w = foldWord(word);
  if (!w) return null;
  if (Object.prototype.hasOwnProperty.call(NUM_WORDS, w)) return NUM_WORDS[w];
  const m = /^(ein|zwei|drei|vier|fuenf|sechs|sieben|acht|neun)und(zwanzig|dreissig|vierzig|fuenfzig|sechzig|siebzig|achtzig|neunzig)$/.exec(w);
  if (m) return NUM_WORDS[m[1]] + NUM_WORDS[m[2]];
  return null;
}

/** Ordinalwort ("sechzehnten", "dritten", "achten") → Zahl.
 *  Mehrere Staemme probieren statt einer Abschneide-Regel: die deutschen
 *  Ordinalzahlen sind teils regelmaessig ("sechzehn|ten"), teils nicht
 *  ("dritt|en", "siebt|en") — eine einzige Suffix-Regel trifft immer nur eine
 *  der beiden Gruppen. */
function germanOrdinalWord(word) {
  const w = foldWord(word);
  if (!w) return null;
  const cands = [w];
  for (const suf of ['sten', 'ten', 'stem', 'tem', 'ster', 'ter', 'stes', 'tes', 'ste', 'te', 'en', 'em', 'er', 'es', 'e']) {
    if (w.endsWith(suf) && w.length > suf.length) cands.push(w.slice(0, -suf.length));
  }
  for (const c of cands) {
    if (Object.prototype.hasOwnProperty.call(ORDINAL_IRREGULAR, c)) return ORDINAL_IRREGULAR[c];
  }
  for (const c of cands) {
    const n = germanNumberWord(c);
    if (n != null) return n;
  }
  return null;
}

// Alternation aller Zahlwoerter in Original-Schreibweise (Umlaut-Varianten
// eingeschlossen), damit die Muster unten sie direkt greifen koennen.
const WORD_ALT = (() => {
  const forms = new Set();
  const add = (s) => { forms.add(s); };
  for (const k of Object.keys(NUM_WORDS)) add(k);
  // Umlaut-Rueckformen: die Tabelle ist gefaltet gespeichert, der Text nicht.
  for (const [a, b] of [['fuenf', 'fünf'], ['zwoelf', 'zwölf'], ['dreissig', 'dreissig'], ['dreissig', 'dreißig']]) {
    if (forms.has(a)) add(b);
  }
  for (const t of TENS) for (const o of ONES) add(`${o}und${t}`);
  // Umlaut-Komposita ("fuenfundzwanzig" → "fünfundzwanzig", "…dreissig/dreißig")
  const extra = [];
  for (const f of forms) {
    if (f.includes('fuenf')) extra.push(f.replace(/fuenf/g, 'fünf'));
    if (f.includes('zwoelf')) extra.push(f.replace(/zwoelf/g, 'zwölf'));
    if (f.includes('dreissig')) extra.push(f.replace(/dreissig/g, 'dreißig'));
  }
  for (const e of extra) add(e);
  // Laengste zuerst — sonst greift "ein" in "einundzwanzig".
  return [...forms].sort((a, b) => b.length - a.length).join('|');
})();

const YEAR_RE_SRC = '(?:1[0-9]{3}|20[0-9]{2})';

// ── Muster ───────────────────────────────────────────────────────────────────
// `art`  — was die Angabe behauptet: 'alter' (Jahre), 'geburtsjahr', 'jahr'
//          (irgendeine Jahreszahl im Satz — schwaches Signal, aber der Bezugs-
//          punkt, an dem ein Alter haengt).
// `word` — true, wenn Gruppe 1 ein Zahlwort ist (statt einer Ziffernfolge).
// `weak` — true bei Mustern, die auch ohne Alterskontext greifen. Sie waehlen
//          den Satz aus, taugen aber nicht als Pruefgroesse allein.
const PATTERNS = [
  // "die 12-jährige", "12jährig", "zwölfjährige"
  { art: 'alter', re: /\b(\d{1,3})\s*[-–]?\s*j[äa]hrig/giu },
  { art: 'alter', re: new RegExp(`\\b(${WORD_ALT})j[äa]hrig`, 'giu'), word: true },
  // "12 Jahre alt", "zwölf Jahre alt", "erst zwölf Jahre jung"
  { art: 'alter', re: /\b(\d{1,3})\s+Jahre?\s+(?:alt|jung)\b/giu },
  { art: 'alter', re: new RegExp(`\\b(${WORD_ALT})\\s+Jahre?\\s+(?:alt|jung)\\b`, 'giu'), word: true },
  // "mit 40 Jahren", "im Alter von 40 (Jahren)"
  { art: 'alter', re: /\bmit\s+(\d{1,3})\s+Jahren\b/giu },
  { art: 'alter', re: new RegExp(`\\bmit\\s+(${WORD_ALT})\\s+Jahren\\b`, 'giu'), word: true },
  { art: 'alter', re: /\b(?:im\s+)?Alter\s+von\s+(\d{1,3})\b/giu },
  { art: 'alter', re: new RegExp(`\\b(?:im\\s+)?Alter\\s+von\\s+(${WORD_ALT})\\b`, 'giu'), word: true },
  // "an ihrem sechzehnten Geburtstag", "zum 40. Geburtstag"
  { art: 'alter', re: /\b(\d{1,3})\.\s*Geburtstag\b/giu },
  { art: 'alter', re: /\b([A-Za-zÄÖÜäöüß]{3,20})(?:sten|ten)\s+Geburtstag\b/giu, ordinal: true },
  // Englisch — Buecher in EN sind ein regulaerer Fall (book_settings.language).
  { art: 'alter', re: /\b(\d{1,3})[\s-]?year[s]?[\s-]old\b/giu },
  { art: 'alter', re: /\baged\s+(\d{1,3})\b/giu },
  // Geburtsjahr
  { art: 'geburtsjahr', re: new RegExp(`\\bgeboren\\b[^.;!?]{0,30}?(${YEAR_RE_SRC})`, 'giu') },
  // Beide Leserichtungen: "geboren 1850" UND "1850 geboren" — im Deutschen steht
  // das Partizip regelmaessig hinter der Jahreszahl.
  { art: 'geburtsjahr', re: new RegExp(`(${YEAR_RE_SRC})[^.;!?]{0,30}?\\bgeboren\\b`, 'giu') },
  { art: 'geburtsjahr', re: new RegExp(`\\bgeb\\.\\s*(?:am\\s+)?[^.;!?]{0,15}?(${YEAR_RE_SRC})`, 'giu') },
  { art: 'geburtsjahr', re: new RegExp(`\\bJahrgang\\s+(${YEAR_RE_SRC})`, 'giu') },
  { art: 'geburtsjahr', re: new RegExp(`\\bborn\\s+(?:in|on)?[^.;!?]{0,20}?(${YEAR_RE_SRC})`, 'giu') },
  { art: 'geburtsjahr', re: new RegExp(`\\*\\s*(${YEAR_RE_SRC})`, 'giu') },
  // "war damals zwölf" — ohne "Jahre"; nur mit Kopula, sonst greift es in jedem
  // Aufzaehlungssatz. Schwach: das Modell entscheidet, ob es ein Alter ist.
  { art: 'alter', weak: true, re: new RegExp(`\\b(?:war|ist|wurde|werde|bin)\\s+(?:damals\\s+|gerade\\s+|erst\\s+|schon\\s+|knapp\\s+|fast\\s+)?(${WORD_ALT})\\b(?!\\s*(?:Uhr|Prozent))`, 'giu'), word: true },
  // Blosse Jahreszahl: schwaches Signal, aber der Bezugspunkt jedes errechneten
  // Alters ("1912 kehrte sie zurueck").
  { art: 'jahr', weak: true, re: new RegExp(`\\b(${YEAR_RE_SRC})\\b`, 'giu') },
];

/** Alle Alters-/Jahressignale eines Satzes. Reihenfolge = Textreihenfolge.
 *  Doppelfunde derselben (art, wert) an derselben Position werden verworfen. */
function extractAgeSignals(sentence) {
  const text = String(sentence ?? '');
  if (!text) return [];
  const out = [];
  const seen = new Set();
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(text)) !== null) {
      let wert = null;
      if (p.ordinal) wert = germanOrdinalWord(m[1]);
      else if (p.word) wert = germanNumberWord(m[1]);
      else wert = parseInt(m[1], 10);
      if (wert == null || !Number.isFinite(wert)) continue;
      // Plausibilitaet: ein Alter ueber 130 ist keine Altersangabe mehr, ein
      // Geburtsjahr unter 1000 keine Jahreszahl.
      if (p.art === 'alter' && (wert < 0 || wert > 130)) continue;
      if (p.art !== 'alter' && (wert < 1000 || wert > 2999)) continue;
      const key = `${p.art}:${wert}:${m.index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ art: p.art, wert, offset: m.index, weak: !!p.weak, treffer: m[0] });
      if (p.re.lastIndex === m.index) p.re.lastIndex++; // Null-Laengen-Schutz
    }
  }
  return out.sort((a, b) => a.offset - b.offset);
}

/** Alle Zahlen, die in einem Text vorkommen — als Ziffer, als Zahlwort UND als
 *  Kompositum ("neunzehnjaehrige"). Pruefgroesse fuer die Modellantwort: nennt
 *  das Modell ein Alter, das in seinem eigenen Zitat nirgends steht, ist es
 *  errechnet oder erfunden.
 *
 *  Die dritte Quelle ist bewusst `extractAgeSignals` selbst: ein Zahlwort steckt
 *  im Deutschen regelmaessig IN einem Wort ("zwoelfjaehrig", "sechzehnten
 *  Geburtstag"), und ein reiner Wort-fuer-Wort-Lookup findet es dort nicht — er
 *  wuerde genau die woertlich belegten Faelle als „erfunden" verwerfen. */
function numbersIn(text) {
  const out = new Set();
  const s = String(text ?? '');
  for (const m of s.matchAll(/\d{1,4}/g)) out.add(parseInt(m[0], 10));
  for (const m of s.matchAll(/[A-Za-zÄÖÜäöüß]{3,24}/g)) {
    const n = germanNumberWord(m[0]) ?? germanOrdinalWord(m[0]);
    if (n != null) out.add(n);
  }
  for (const sig of extractAgeSignals(s)) out.add(sig.wert);
  return out;
}

/** Satzgrenzen inkl. Start-Offset. Eigener, absichtlich einfacher Splitter:
 *  gebraucht wird hier der SATZ ALS FENSTER (Figur + Angabe im selben Atemzug),
 *  nicht die Satzzahl-Metrik von lib/page-index.js — die ist dort privat und auf
 *  ihre Kennzahl getrimmt. Absatzenden zaehlen als Grenze, damit eine Zeile ohne
 *  Schlusspunkt (Dialogzeile, Ueberschrift) nicht mit dem naechsten Absatz
 *  verklebt. */
function splitSentences(text) {
  const s = String(text ?? '');
  const out = [];
  const re = /[^.!?\n]*[.!?]+|[^\n]+/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const raw = m[0];
    if (!raw.trim()) continue;
    out.push({ start: m.index, end: m.index + raw.length, text: raw });
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  return out;
}

module.exports = {
  germanNumberWord, germanOrdinalWord, extractAgeSignals, numbersIn,
  splitSentences, foldWord,
};
