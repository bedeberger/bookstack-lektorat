'use strict';
// Pure Satz-Segmentierung + Chunking fuer das Vorlesen (TTS / Proof-Listening).
// SSoT, geteilt zwischen dem Notebook-Proof-Listening (Alpine-Root,
// editor/notebook/tts-proof.js) und dem Share-Reader-Vorlese-Dock (Vanilla,
// share-reader/tts.js). Keine DOM-/Browser-Abhaengigkeit ausser Intl.Segmenter
// (mit Regex-Fallback) — ohne Browser testbar.
//
// Warum die zwei Chunk-Korrektive: sehr kurze Eingaben lassen XTTS-v2 am
// Satzende einen erfundenen Restlaut anhaengen (Kurz-Input-Halluzination) →
// Kurz-Satz-Buendelung. Sehr lange Saetze ergaeben einen Request mit
// zweistelliger Synthese-Latenz (naehert sich dem 20s-Server-Timeout) + einen
// monoton heruntergelesenen Audio-Block → Lang-Satz-Splitting an Klausel-Grenzen.

// Mindest-Zeichenzahl pro Synthese-Chunk (Kurz-Satz-Buendelung).
export const TTS_MIN_CHUNK_CHARS = 60;
// Hoechst-Zeichenzahl pro Synthese-Chunk (Lang-Satz-Splitting).
export const TTS_MAX_CHUNK_CHARS = 220;

// Satzgrenzen via Intl.Segmenter (handhabt Abkuerzungen wie „z. B." korrekt),
// Fallback Regex split nach .!?. Liefert [start,end]-Offset-Paare in `text`.
export function computeTtsSentences(text, locale = 'de') {
  if (!text || !text.trim()) return [];
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    try {
      const seg = new Intl.Segmenter(locale, { granularity: 'sentence' });
      const out = [];
      for (const s of seg.segment(text)) {
        if (s.segment.trim()) out.push([s.index, s.index + s.segment.length]);
      }
      return out;
    } catch { /* fallthrough */ }
  }
  const out = [];
  const re = /[^.!?]+[.!?]*\s*/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0].trim()) out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

// Kurze Satz-Ranges (in `text`) zu Chunks >= minLen buendeln. Ein anwachsender
// Chunk schluckt Folgesaetze, bis seine getrimmte Laenge die Schwelle erreicht;
// ein zu kurzer Rest am Ende wird in den Vorgaenger gezogen. `maxLen` deckelt das
// Anwachsen, damit die Buendelung die Split-Stuecke nicht wieder ueber die Grenze
// zusammenzieht (Default Infinity = kein Deckel).
export function coalesceTtsRanges(ranges, text, minLen = TTS_MIN_CHUNK_CHARS, maxLen = Infinity) {
  if (!Array.isArray(ranges) || ranges.length <= 1) return ranges || [];
  const len = ([s, e]) => text.slice(s, e).trim().length;
  const fits = (s, e) => text.slice(s, e).trim().length <= maxLen;
  const merged = [];
  let cur = null;
  for (const [s, e] of ranges) {
    if (!cur) { cur = [s, e]; continue; }
    if (len(cur) < minLen && fits(cur[0], e)) { cur[1] = e; } // zu kurz + passt -> anhaengen
    else { merged.push(cur); cur = [s, e]; }                  // lang genug / wuerde sprengen -> abschliessen
  }
  if (cur) {
    const prev = merged[merged.length - 1];
    if (len(cur) < minLen && prev && fits(prev[0], cur[1])) prev[1] = cur[1];
    else merged.push(cur);
  }
  return merged;
}

// Eine zu lange Satz-Range an Klausel-/Wortgrenzen in Teilstuecke <= maxLen
// zerlegen. Bevorzugt nach dem LETZTEN Klausel-Zeichen im Fenster (; : , oder
// freistehender Gedankenstrich - – —), sonst am letzten Leerzeichen, im Notfall
// hart bei maxLen. Intra-Wort-Bindestriche („Midlife-Krise") bleiben unangetastet.
export function splitLongRange([s, e], text, maxLen = TTS_MAX_CHUNK_CHARS) {
  const out = [];
  let start = s;
  while (e - start > maxLen) {
    const win = text.slice(start, start + maxLen);
    let cut = -1;
    const clause = /[;:,](?=\s|$)|\s[-–—]\s/g;
    let m;
    while ((m = clause.exec(win)) !== null) cut = m.index + m[0].length;
    if (cut <= 0) {
      const sp = win.lastIndexOf(' ');
      cut = sp > 0 ? sp + 1 : maxLen; // kein Trennpunkt -> harter Schnitt
    }
    out.push([start, start + cut]);
    start += cut;
  }
  if (start < e) out.push([start, e]);
  return out;
}

// Satz-Ranges eines Blocks in synthese-taugliche Chunks bringen: erst zu lange
// Saetze splitten, dann zu kurze buendeln (mit maxLen-Deckel).
export function chunkTtsRanges(ranges, text, minLen = TTS_MIN_CHUNK_CHARS, maxLen = TTS_MAX_CHUNK_CHARS) {
  if (!Array.isArray(ranges) || !ranges.length) return ranges || [];
  const split = [];
  for (const r of ranges) {
    if (text.slice(r[0], r[1]).trim().length > maxLen) split.push(...splitLongRange(r, text, maxLen));
    else split.push(r);
  }
  return coalesceTtsRanges(split, text, minLen, maxLen);
}

// Schweizer Guillemets (« ») spricht XTTS als Lautfolge aus statt sie als
// Anfuehrung zu ignorieren. Vor der Synthese auf gerade Anfuehrungszeichen
// normalisieren — rein fuer die Sprachausgabe; angezeigter Text +
// Highlight-Offsets bleiben unveraendert.
export function normalizeForSpeech(text) {
  return text.replace(/[«»]/g, '"').replace(/[‹›]/g, "'");
}

// ── Sprech-Text eines Blocks (Beleg-Chips ausgelassen) ──────────────────────
// Quellennachweise sollen nicht mitgelesen werden: „(Kafka, 1915, S. 44)" mitten
// im Satz zerreisst den Hoerfluss und ist genau die Information, die beim
// Vorlesen nichts beitraegt.
//
// Text UND Highlight muessen dabei in EINEM Offsetraum leben — beide Konsumenten
// bauen ihre Satz-Range aus Zeichen-Offsets in denselben Textknoten. Darum
// liefert `ttsTextNodes` die Knotenliste, aus der beide arbeiten: `ttsBlockText`
// verkettet sie zum Sprech-Text, und der Range-Bau der Konsumenten laeuft ueber
// dieselbe Liste statt ueber einen eigenen TreeWalker. Wuerde nur der Sprechtext
// gefiltert, driftete das Highlight um die Chip-Laenge.
//
// Der Selektor ist eine bewusste KOPIE von CITE_SEL (public/js/sources/
// cite-html.js): dieses Modul muss pre-auth ladbar bleiben (PUBLIC_ASSETS in
// server.js, der Share-Reader importiert es) und darf deshalb nichts aus dem
// App-Bundle importieren — dieselbe Begruendung wie bei READER_BLOCK_SEL in
// share-reader/tts.js. Gegen Drift gesichert durch tests/unit/tts-cite-skip.test.mjs.
export const TTS_SKIP_SEL = 'span.cite[data-src]';

// ── Bloecke, die gar nicht vorgelesen werden ────────────────────────────────
// Andere Frage als TTS_SKIP_SEL: der oben ueberspringt einen INLINE-Teilbaum
// innerhalb eines Satzes, dieser hier verwirft einen ganzen Block.
//
// Ein Diagramm hat keinen Sprech-Text. Vorzulesen waere entweder sein Quelltext
// („flowchart TD A eckige Klammer auf Ausgangslage") oder die Knoten-Labels des
// gerenderten SVG in Layout-Reihenfolge — beides ist kein Satz und reisst den
// Hoerfluss auseinander. Darum fallen Quelltext-Block UND Render-Knoten weg.
// Die Bildbeschreibung fuer Screenreader haengt am SVG (`role="img"`), das ist
// der richtige Kanal dafuer.
//
// `.mermaid-render` ist der zur Laufzeit eingefuegte Geschwister-Knoten (siehe
// public/js/diagram/mermaid-view.js). Beide Selektoren sind bewusste KOPIEN aus
// public/js/diagram/mermaid-html.js — dieses Modul muss pre-auth ladbar bleiben
// (der Share-Reader importiert es) und darf nichts aus dem App-Bundle ziehen.
// Gegen Drift gesichert durch tests/unit/mermaid-drift.test.mjs.
//
// Eine TABELLE faellt aus demselben Grund weg: vorgelesen waere sie eine Folge
// von Zellen ohne Satzbau („Jahr zweitausenddreiundzwanzig eins Punkt zwei
// Millionen vier Komma eins Prozent"), und der Zusammenhang, den die Spalten
// tragen, entsteht beim Hoeren nicht. Der Zweck des Vorlesens ist das
// Korrekturhoeren der Prosa; eine Zahlenkolonne prueft man mit den Augen.
// Die Beschriftung faellt mit weg: `<caption>` liegt INNERHALB der Tabelle, ein
// Block-Skip nimmt den ganzen Teilbaum. Das ist hier die richtige Wahl — eine
// vorgelesene Beschriftung ohne die Tabelle dahinter kuendigt etwas an, das
// nicht kommt.
// Kopie von public/js/table/table-html.js#TABLE_SEL, gegated durch
// tests/unit/table-drift.test.mjs.
export const TTS_SKIP_BLOCK_SEL = 'pre.mermaid, .mermaid-render, table';

/** Ist `el` ein Block, der komplett uebersprungen wird? */
export function isTtsSkippedBlock(el) {
  return !!(el && el.nodeType === 1 && el.matches && el.matches(TTS_SKIP_BLOCK_SEL));
}

// Textknoten unter `root` in Dokumentordnung, Teilbaeume von `skipSel` uebersprungen.
export function ttsTextNodes(root, skipSel = TTS_SKIP_SEL) {
  const out = [];
  if (!root) return out;
  const walk = (node) => {
    const kids = node.childNodes;
    if (!kids) return;
    for (const child of kids) {
      if (child.nodeType === 3) {
        if (child.nodeValue) out.push(child);
        continue;
      }
      if (child.nodeType !== 1) continue;
      if (skipSel && child.matches && child.matches(skipSel)) continue;
      walk(child);
    }
  };
  walk(root);
  return out;
}

// Sprech-Text eines Blocks: `textContent` minus der uebersprungenen Teilbaeume.
export function ttsBlockText(root, skipSel = TTS_SKIP_SEL) {
  return ttsTextNodes(root, skipSel).map(n => n.nodeValue).join('');
}
