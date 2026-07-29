'use strict';
// Fussnotenapparat am Seitenfuss.
//
// Der Anmerkungsapparat selbst (Nummerierung pro Kapitel, Notentexte inkl.
// „Ebd."/„a. a. O.") entsteht in lib/endnotes.js und ist hier fertig; dieses
// Modul macht ausschliesslich die PLATZIERUNG: Platz am Seitenfuss reservieren,
// bevor die Seite voll ist, und ihn nachtraeglich bemalen.
//
// ── Der Hebel ────────────────────────────────────────────────────────────────
//
// `doc.page.margins.bottom` ist der einzige Wert, den ALLE Umbruchpruefungen des
// Renderers sehen: justify.js prueft `doc.page.maxY()`, die Witwenkontrolle,
// der Bild-Umbruch und der DropCap rechnen `height - margins.bottom` von Hand.
// Wer den Rand aufblaeht, verkleinert damit den Satzspiegel fuer jeden dieser
// Konsumenten auf einmal — es braucht keine zweite Reserve-Groesse im Renderer.
//
// Das summiert sich NICHT ueber Seiten auf: pdfkit leitet die Raender einer neuen
// Seite aus `doc.options` ab, nicht von der Vorseite (`normalizeSides` liefert
// ein frisches Literal). Die Reserve verfaellt also mit jedem Seitenwechsel von
// selbst — genau richtig, denn jede Seite hat ihren eigenen Apparat.
//
// ── margins.bottom ist der Hebel, NICHT die Wahrheit ─────────────────────────
//
// Zurueckgelesen wird der Rand nie. Grund: chrome.js#_drawHeaderFooter setzt die
// Raender jeder Body-Seite am Ende auf die Basis-Raender (`origMargins =
// outerMargins`) — das ist keine Restauration, sondern eine Ueberschreibung mit
// einem Fremdwert. Wer die Reserve aus `margins.bottom` zurueckrechnen wollte,
// bekaeme nach dem Kopf-/Fusszeilen-Pass Unsinn. Die Wahrheit ist `_pages`.
//
// ── Mess- und Zeichenweg sind derselbe Code ──────────────────────────────────
//
// Gemessen wird beim Setzen des Markers, gezeichnet Seiten spaeter im
// Stamp-Pass. Weichen die beiden auch nur um eine Zeile ab, ragt der Apparat in
// die Fusszeile oder die Seite verschenkt Platz. Darum laufen beide durch
// `_tokenize`/`_breakLines`/`_renderLine` aus justify.js — denselben Layouter wie
// der Fliesstext. Das misst nebenbei run-genau (der kursive Werktitel im
// Notentext ist schmaler als aufrecht) statt ueber `heightOfString` auf dem
// Klartext.

const { MM_TO_PT } = require('./layout');
const { _tokenize, _breakLines, _renderLine, noteIdsOfLine } = require('./justify');

/** Notenziffer im Apparat: „12. " vor dem Notentext. Der haengende Einzug
 *  (siehe `hangMm`) setzt Folgezeilen dahinter, sodass die Ziffern eine Spalte
 *  bilden. Bewusst dieselbe Form wie im Endnoten-Apparat
 *  (lib/endnotes.js#endnoteItemHtml), damit ein Buch beim Moduswechsel nicht
 *  anders aussieht als erwartet. */
function _noteRuns(note) {
  return [{ text: `${note.n}. ` }, ...(note.runs || [])];
}

/** Fussnoten-Zustand fuer EINEN Render-Lauf.
 *
 *  @param {object}  args
 *  @param {object}  args.doc          pdfkit-Dokument
 *  @param {Map}     args.notesById    aus buildEndnotes (id → note)
 *  @param {object}  args.cfg          config.footnotes
 *  @param {object}  args.fontCfg      config.font.footnote (sizePt/lineHeight)
 *  @param {object}  args.outerMargins Basis-Raender — SSoT fuer die Notenbreite.
 *                                     Nie `doc.page.margins` benutzen: im
 *                                     Blockquote ist `left` verschoben, und die
 *                                     Note stuende dann schmaler als reserviert.
 *  @param {number}  args.pageWidth
 *  @param {number}  args.pageHeight */
function createFootnoteState({ doc, notesById, cfg, fontCfg, outerMargins, pageWidth, pageHeight }) {
  const sizePt = fontCfg.sizePt || 8;
  const lineHeight = fontCfg.lineHeight || 1.25;
  const gapPt = (cfg.gapMm || 0) * MM_TO_PT;
  const hangPt = (cfg.hangMm || 0) * MM_TO_PT;
  const sepGapPt = cfg.separator ? gapPt : gapPt * 0.5;
  // Breite des Apparats = Satzspiegelbreite der Basis-Raender.
  const widthPt = pageWidth - outerMargins.left - outerMargins.right;

  // Deckel: der Apparat darf hoechstens diesen Anteil des Satzspiegels belegen.
  const textBlockPt = pageHeight - outerMargins.top - outerMargins.bottom;
  const capPt = textBlockPt * ((cfg.maxHeightPct || 45) / 100);

  // pageIdx → { notes, reserveH, appliedH }
  //   reserveH  Soll-Hoehe des Apparats dieser Seite
  //   appliedH  wie viel davon bereits auf margins.bottom addiert wurde
  // Die Differenz wird relativ nachgezogen (nie absolut gesetzt), damit die
  // Arithmetik neben page-geometry.js#enableBodyInset bestehen kann.
  const _pages = new Map();
  const _heightCache = new Map();

  function _state(pageIdx) {
    let st = _pages.get(pageIdx);
    if (!st) { st = { notes: [], reserveH: 0, appliedH: 0, overflow: 0 }; _pages.set(pageIdx, st); }
    return st;
  }

  /** Zeilen einer Note im Apparat — die gemeinsame Grundlage von Messen und
   *  Zeichnen. `doc.font`/`fontSize` werden von _breakLines pro Run gesetzt. */
  function _linesOf(note) {
    const items = _tokenize(_noteRuns(note));
    doc.font('footnote').fontSize(sizePt);
    const cache = new Map();
    const spaceWidth = doc.widthOfString(' ');
    return _breakLines(doc, items, {
      sizePt,
      features: doc._otFeatures,
      cache,
      hyphenate: null,
      fontKeyBase: 'footnote',
      totalWidth: widthPt,
      firstIndent: 0,
      hangIndent: hangPt,
      spaceWidth,
    });
  }

  function _advance() {
    doc.font('footnote').fontSize(sizePt);
    return doc.currentLineHeight(true) + (lineHeight - 1) * sizePt;
  }

  /** Hoehe EINER Note in pt (ohne Separator). Gecached ueber die Noten-ID —
   *  dieselbe Note wird beim Fit-Check mehrfach gemessen. */
  function heightOf(note) {
    if (_heightCache.has(note.id)) return _heightCache.get(note.id);
    const h = _linesOf(note).length * _advance();
    _heightCache.set(note.id, h);
    return h;
  }

  /** Hoehe, die der Separator auf einer Seite belegt (nur vor der ERSTEN Note). */
  function separatorHeight() {
    return sepGapPt + (cfg.separator ? 1 : 0) + gapPt * 0.5;
  }

  /** Zusatzhoehe, die `noteIds` auf dieser Seite kosten wuerden — inklusive
   *  Separator, wenn die Seite noch keine Note traegt. Reine Rechnung, aendert
   *  nichts. */
  function extraHeightFor(pageIdx, noteIds) {
    if (!noteIds || !noteIds.length) return 0;
    const st = _pages.get(pageIdx);
    let h = (!st || !st.notes.length) ? separatorHeight() : 0;
    for (const id of noteIds) {
      const note = notesById.get(id);
      if (note) h += heightOf(note);
    }
    return h;
  }

  /** Wuerde die Zusatzhoehe den Deckel sprengen? */
  function wouldExceedCap(pageIdx, extraH) {
    const st = _pages.get(pageIdx);
    return (st ? st.reserveH : 0) + extraH > capPt;
  }

  /** Noten der aktuellen Seite zuschlagen und den Rand nachziehen.
   *
   *  `maxReserve` clamped die Reserve so, dass `maxY()` nie unter `margins.top`
   *  faellt — sonst passt keine einzige Zeile mehr und jede Folgezeile
   *  kaskadiert in eine eigene Seite. Wird der Clamp wirksam, ragt der Apparat
   *  in den unteren Rand; das meldet der Renderer als Warnung (nicht fatal).
   *
   *  Aufrufer MUSS sicherstellen, dass `doc.page` die Seite `pageIdx` ist. */
  function commit(pageIdx, noteIds, { maxReserve = Infinity } = {}) {
    if (!noteIds || !noteIds.length) return 0;
    const st = _state(pageIdx);
    for (const id of noteIds) {
      const note = notesById.get(id);
      if (!note || st.notes.some(n => n.id === id)) continue;
      st.notes.push(note);
    }
    if (!st.notes.length) return 0;

    let want = separatorHeight();
    for (const n of st.notes) want += heightOf(n);
    const clamped = Math.min(want, maxReserve);
    st.reserveH = clamped;
    st.overflow = want > clamped ? want - clamped : 0;

    const delta = st.reserveH - st.appliedH;
    if (delta !== 0) {
      doc.page.margins.bottom += delta;
      st.appliedH = st.reserveH;
    }
    return delta;
  }

  /** Seiten mit Apparat, aufsteigend. Fuer den Stamp-Pass. */
  function pages() {
    return [..._pages.entries()].filter(([, st]) => st.notes.length).sort((a, b) => a[0] - b[0]);
  }

  /** Zahl der Seiten, deren Apparat ueber die reservierte Hoehe hinausragt. */
  function overflowCount() {
    let n = 0;
    for (const [, st] of _pages) if (st.overflow > 0) n++;
    return n;
  }

  return {
    heightOf, separatorHeight, extraHeightFor, wouldExceedCap, commit, pages, overflowCount,
    _linesOf, _advance,
    widthPt, capPt, sizePt, hangPt,
  };
}

/** Noten-IDs eines ganzen Run-Arrays (fuer die Witwenkontrolle, die vor dem
 *  Zeilenumbruch entscheidet und darum konservativ ALLE Noten des Absatzes
 *  einrechnet). */
function noteIdsOfRuns(runs) {
  const out = [];
  for (const r of runs || []) {
    const id = r && r.noteId;
    if (Number.isInteger(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Den Apparat auf alle Seiten zeichnen, die einen haben.
 *
 *  Laeuft NACH dem Body, ueber `switchToPage` (Muster stamp.js). Der Platz ist zu
 *  dem Zeitpunkt reserviert, es wird also nur noch gemalt.
 *
 *  ZWEI HARTE REGELN:
 *
 *    1. Keine Auto-Paginierung ausloesen. Eine mehrzeilige Note mit `width` baut
 *       in pdfkit einen LineWrapper; reisst der `maxY`, haengt pdfkit MITTEN IM
 *       STAMP eine Seite an — das kippt die Paritaet von padToEvenPages und die
 *       bereits berechneten Seitenzahlen. Darum die Raender fuer die Dauer auf 0
 *       (Muster chrome.js) und danach den VORGEFUNDENEN Wert zurueckschreiben.
 *    2. Nichts aus `doc.page.margins` als Position lesen (siehe Modulkopf). */
function stampFootnotes(doc, fn, { outerMargins, color = '#000000', separator = true, separatorWidthMm = 30 }) {
  const list = fn.pages();
  if (!list.length) return;

  const saveX = doc.x;
  const saveY = doc.y;
  const advance = fn._advance();
  const sepH = fn.separatorHeight();

  for (const [pageIdx, st] of list) {
    doc.switchToPage(pageIdx);
    const orig = doc.page.margins;
    doc.save();
    doc.page.margins = { top: 0, right: orig.right, bottom: 0, left: orig.left };

    const left = outerMargins.left;
    // Der Apparat sitzt UNTEN im reservierten Band: seine Oberkante liegt genau
    // um die Reservehoehe ueber der Satzspiegel-Unterkante.
    let y = doc.page.height - outerMargins.bottom - st.reserveH;

    if (separator) {
      const w = Math.max(10, separatorWidthMm * MM_TO_PT);
      doc.save();
      doc.lineWidth(0.5).strokeColor(color).opacity(0.55);
      doc.moveTo(left, y + sepH * 0.35).lineTo(left + w, y + sepH * 0.35).stroke();
      doc.restore();
    }
    y += sepH;

    for (const note of st.notes) {
      const lines = fn._linesOf(note);
      lines.forEach((line, li) => {
        // Haengender Einzug: erste Zeile am Rand (die Ziffer steht dort), alle
        // Folgezeilen eingerueckt — dieselbe Aufteilung, mit der _breakLines
        // gemessen hat. Weicht das ab, stimmt die reservierte Hoehe nicht.
        _renderLine(doc, line, left + (li === 0 ? 0 : fn.hangPt), y, {
          sizePt: fn.sizePt, ws: 0, textColor: color, linkColor: color, fontKeyBase: 'footnote',
        });
        y += advance;
      });
    }

    doc.page.margins = orig;
    doc.restore();
  }

  doc.x = saveX;
  doc.y = saveY;
}

module.exports = { createFootnoteState, stampFootnotes, noteIdsOfLine, noteIdsOfRuns };
