'use strict';
// Manueller Blocksatz-Layouter für gemischt formatierte Absätze.
//
// Warum: pdfkit kann eine Sichtzeile, die aus mehreren `continued`-Fragmenten
// besteht (Fliesstext → Link/`<strong>`/`<em>` → Fliesstext), NICHT als Ganzes
// justieren. Es behandelt jedes Fragment-Ende als Absatz-Schlusszeile
// (erzwingt linksbündig) und berechnet den Wortabstand PRO Fragment gegen die
// volle Zeilenbreite (pdfkit.js `_fragment`, justify-Zweig). Ergebnis: der Text
// vor einer Formatierung sitzt eng, der umbrechende Text danach schluckt den
// gesamten Rest → riesige Lücken um jede Formatierung.
//
// Dieser Layouter bricht die Zeilen selbst (misst jeden Run in SEINER Schrift,
// inkl. Silbentrennung) und verteilt den Wortabstand pro Sichtzeile gleichmässig
// über alle Runs. Vertikaler Fluss + Seitenumbruch bleiben an pdfkit delegiert
// (doc.y-Vorschub + doc.addPage), damit Blockquote-Ränder, Geometrie-Hooks und
// Witwen-/Waisen-Vorprüfung wie gehabt komponieren.
//
// Nur für Einspalten-Blocksatz (columns === 1, align 'justify'); alles andere
// läuft weiter über den pdfkit-`continued`-Pfad in runs.js.

const { _runFontKey } = require('./fonts');
const { _currentPageIdx } = require('./layout');

const SHY = '­';

// Schliessende Interpunktion, die nie allein umbrechen und nie einen justierten
// Wortabstand vor sich bekommen darf.
const CLINGING_PUNCT = /^[.,;:!?…·)\]}»›”’%‰]+$/;

function _styleSig(s) {
  if (!s) return '||||';
  return `${s.bold ? 1 : 0}|${s.italic ? 1 : 0}|${s.underline ? 1 : 0}|${s.sup ? 1 : 0}|${s.link || ''}`;
}

// Hochstellung (Notenziffern des Anmerkungsapparats). Zwei Groessen statt einer
// echten OpenType-Variante: `sups` haben die wenigsten Google-Fonts, und eine
// fehlende Glyphe waere im PDF eine Leerstelle mitten im Satz. Skalierte Ziffern
// funktionieren in jeder Schrift.
//
// 0.62 / 0.34 sind die ueblichen Werte fuer Werksatz: klein genug, um nicht als
// Fliesstext gelesen zu werden, gross genug zum Lesen; die Grundlinie hebt sich
// um gut ein Drittel der Schriftgroesse, sodass die Ziffer unter der Oberlaenge
// bleibt und die Zeilenhoehe nicht sprengt.
const SUP_SCALE = 0.62;
const SUP_RISE = 0.34;

/** Schriftgroesse eines Runs — hochgestellte kleiner als der Fliesstext. */
function _sizeFor(style, sizePt) {
  return style && style.sup ? sizePt * SUP_SCALE : sizePt;
}

/** Vertikaler Versatz des Zeichen-Ursprungs fuer einen hochgestellten Run.
 *
 *  pdfkit setzt `y` auf die OBERKANTE der Zeile, nicht auf die Grundlinie. Eine
 *  kleinere Schrift an derselben Oberkante haette damit automatisch eine hoehere
 *  Grundlinie — aber um einen von der Schrift abhaengigen Betrag. Darum wird hier
 *  zurueckgerechnet: gewuenscht ist Grundlinie(sup) = Grundlinie(Fliesstext) −
 *  SUP_RISE·Groesse, und der Versatz ergibt sich aus der Oberlaenge der Schrift.
 *
 *  Muss aufgerufen werden, NACHDEM die Schrift am doc gesetzt ist (`doc._font`).
 *  Fehlt die Metrik, faellt es auf 0.75 zurueck — der Ueblichkeitswert fuer
 *  Serifen-Werksatzschriften. */
function _supOffset(doc, style, sizePt) {
  if (!style || !style.sup) return 0;
  const asc = Number.isFinite(doc?._font?.ascender) ? doc._font.ascender / 1000 : 0.75;
  return asc * sizePt * (1 - SUP_SCALE) - SUP_RISE * sizePt;
}

// Runs → flache Item-Liste: Wörter, Leerzeichen (je mit Herkunfts-Style, damit
// Unterstrich/Link innerhalb eines mehrwortigen Runs durchgezogen wird) und
// harte Umbrüche (\n aus <br>). Mehrfach-Whitespace kollabiert, führende/
// abschliessende Leerzeichen fallen weg.
function _tokenize(runs) {
  const raw = [];
  for (const r of runs) {
    if (r.text === '\n') { raw.push({ br: true }); continue; }
    for (const part of r.text.split(/(\s+)/)) {
      if (part === '') continue;
      if (/^\s+$/.test(part)) raw.push({ space: true, style: r });
      else raw.push({ word: part, style: r });
    }
  }
  const out = [];
  for (const it of raw) {
    if (it.space) {
      const last = out[out.length - 1];
      if (!last || last.space || last.br) continue; // führende/doppelte Spaces droppen
    }
    out.push(it);
  }
  while (out.length && out[out.length - 1].space) out.pop();
  // ── Klebe-Regeln ───────────────────────────────────────────────────────────
  // Zwei Fälle, in denen zwei benachbarte Wort-Tokens NICHT durch einen
  // Zeilenumbruch getrennt werden dürfen. Ergebnis ist jeweils ein
  // VERBUND-Token (`parts`), das jeden Teil mit seinem EIGENEN Style behält —
  // die Teile werden nur gemeinsam umbrochen, nicht gemeinsam formatiert.
  //
  //   1. Schliessende Interpunktion (typisch der Punkt nach </em>/<strong>/</a>)
  //      stammt aus einem eigenen Run. Ungeklebt landet sie als einzelner Punkt
  //      auf der neuen Zeile bzw. bekommt im Blocksatz eine Lücke davor. Ein
  //      dazwischenliegendes (mitformatiertes) Leerzeichen wird verworfen.
  //
  //   2. Eine hochgestellte Notenziffer (`sup`, siehe lib/endnotes.js), der
  //      unmittelbar — ohne Leerzeichen — ein Wort vorausging. Ungeklebt rutscht
  //      die Ziffer allein auf die Folgezeile; ist das ein SEITENumbruch, steht
  //      sie auf einer anderen Seite als ihre Note. Ein vom Autor gesetztes
  //      Leerzeichen vor dem Marker bleibt dagegen respektiert (dann kein Kleben).
  const glued = [];
  for (const it of out) {
    if (it.word && CLINGING_PUNCT.test(it.word)) {
      if (glued.length && glued[glued.length - 1].space) glued.pop();
      const prev = glued[glued.length - 1];
      if (prev && (prev.word || prev.parts)) { glued[glued.length - 1] = _glue(prev, it); continue; }
    }
    if (it.word && it.style && it.style.sup) {
      const prev = glued[glued.length - 1];
      if (prev && (prev.word || prev.parts)) { glued[glued.length - 1] = _glue(prev, it); continue; }
    }
    glued.push(it);
  }
  return glued;
}

/** Noten-IDs, die eine fertig umbrochene Zeile traegt, in Reihenfolge.
 *
 *  Steht hier und nicht in footnotes.js, weil es die Zeilen-/Token-Struktur
 *  dieses Moduls kennt (Verbund-Tokens muessen aufgefaltet werden — sonst
 *  entgeht genau der geklebte Marker) und weil footnotes.js bereits von hier
 *  importiert; umgekehrt waere es ein Zyklus. */
function noteIdsOfLine(line) {
  const out = [];
  for (const it of line.items || []) {
    for (const p of it.parts || [it]) {
      const id = p.style && p.style.noteId;
      if (Number.isInteger(id) && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

/** Teile eines Tokens als Liste — ein einfaches Wort ist ein Ein-Teil-Verbund. */
function _parts(it) {
  return it.parts ? it.parts : [{ text: it.word, style: it.style }];
}

/** Zwei Tokens zu einem unteilbaren Verbund zusammenfassen. `style` bleibt der
 *  des ERSTEN Teils, damit Aufrufer, die nur `it.style` lesen (Silbentrennung),
 *  etwas Sinnvolles bekommen; gerendert wird jeder Teil mit seinem eigenen. */
function _glue(prev, next) {
  const parts = [..._parts(prev), ..._parts(next)];
  return { parts, word: parts.map(p => p.text).join(''), style: parts[0].style };
}

function _measure(doc, text, fontKey, sizePt, features, cache) {
  // Groesse gehoert in den Cache-Schluessel, seit hochgestellte Runs eine eigene
  // haben — sonst liefert der Cache die Fliesstext-Breite fuer eine Notenziffer.
  const key = fontKey + '\u0000' + sizePt + '\u0000' + text;
  let w = cache.get(key);
  if (w === undefined) {
    doc.font(fontKey).fontSize(sizePt);
    w = doc.widthOfString(text, { features });
    cache.set(key, w);
  }
  return w;
}

// Versucht, ein zu langes Wort per Silbentrennung so zu teilen, dass ein
// Präfix + Bindestrich noch in `maxWidth` passt. Gibt { head, tail } zurück
// (head inkl. '-') oder null, wenn keine Trennstelle passt.
function _tryHyphenate(doc, word, style, maxWidth, o) {
  if (!o.hyphenate || maxWidth <= 0) return null;
  const hy = o.hyphenate(word);
  if (!hy || hy.indexOf(SHY) < 0) return null;
  const fontKey = _runFontKey(style, o.fontKeyBase);
  let best = null;
  for (let i = 0; i < hy.length; i++) {
    if (hy[i] !== SHY) continue;
    const head = hy.slice(0, i).replace(new RegExp(SHY, 'g'), '') + '-';
    const w = _measure(doc, head, fontKey, o.sizePt, o.features, o.cache);
    if (w <= maxWidth) best = { i, head };
    else break; // Präfixe werden nur länger → abbrechen
  }
  if (!best) return null;
  const tail = hy.slice(best.i + 1).replace(new RegExp(SHY, 'g'), '');
  return { head: best.head, tail };
}

// Greedy-Zeilenumbruch. Liefert Zeilen mit vorgemessenen Item-Breiten.
function _breakLines(doc, items, o) {
  const { sizePt, features, cache, totalWidth, firstIndent, hangIndent = 0, spaceWidth, fontKeyBase = 'body' } = o;
  const lines = [];
  let cur = [];
  let width = 0;      // natürliche Breite (Wörter + Leerzeichen, ohne ws)
  let spaces = 0;
  let avail = totalWidth - firstIndent;

  const flush = (forced) => {
    while (cur.length && cur[cur.length - 1].space) { cur.pop(); width -= spaceWidth; spaces--; }
    if (cur.length || forced) lines.push({ items: cur, width, spaces, forced });
    cur = []; width = 0; spaces = 0;
    // Folgezeilen: volle Breite, abzueglich eines haengenden Einzugs.
    avail = totalWidth - hangIndent;
  };

  // Breite eines Tokens. Ein Verbund (`parts`) wird teilweise gemessen — jeder
  // Teil in SEINER Schrift und Groesse — und die Teilbreiten werden am Teil
  // gemerkt, damit _renderLine sie nicht neu messen muss.
  const itemWidth = (it) => {
    if (!it.parts) return _measure(doc, it.word, _runFontKey(it.style, fontKeyBase), _sizeFor(it.style, sizePt), features, cache);
    let w = 0;
    for (const p of it.parts) {
      p.w = _measure(doc, p.text, _runFontKey(p.style, fontKeyBase), _sizeFor(p.style, sizePt), features, cache);
      w += p.w;
    }
    return w;
  };

  const place = (it) => {
    const w = itemWidth(it);
    if (width + w <= avail || cur.length === 0) {
      cur.push({ ...it, w }); width += w; return;
    }
    // Silbentrennung nur fuer einfache Woerter — ein Verbund ist per Definition
    // unteilbar (sonst waere das Kleben sinnlos).
    const hy = it.parts ? null : _tryHyphenate(doc, it.word, it.style, avail - width - 0.01, o);
    if (hy) {
      const hw = _measure(doc, hy.head, _runFontKey(it.style, fontKeyBase), sizePt, features, cache);
      cur.push({ word: hy.head, style: it.style, w: hw, hyphenated: true }); width += hw;
      flush(false);
      place({ word: hy.tail, style: it.style }); // Rest auf neuer Zeile (ggf. erneut trennen)
      return;
    }
    flush(false);
    cur.push({ ...it, w }); width += w;
  };

  for (const it of items) {
    if (it.br) { flush(true); continue; }
    if (it.space) {
      if (!cur.length) continue;
      const w = _measure(doc, ' ', _runFontKey(it.style, fontKeyBase), _sizeFor(it.style, sizePt), features, cache);
      cur.push({ space: true, style: it.style, w }); width += w; spaces++;
      continue;
    }
    place(it);
  }
  flush(true); // Schlusszeile
  return lines;
}

function _renderLine(doc, line, x, y, o) {
  const { sizePt, ws, textColor, linkColor, fontKeyBase = 'body' } = o;
  let segText = '';
  let segStyle = null;
  let segAdvance = 0;
  let segSpaces = 0;
  let segLeadWidth = 0;  // Vorschub führender Spaces (bevor das erste Wort kam)
  let segLeadSpaces = 0;
  let segHasWord = false;
  const flush = () => {
    if (segText === '') return;
    // Hochgestellte Segmente (Notenziffern) laufen kleiner und auf angehobener
    // Grundlinie. Der Zeilenvorschub bleibt davon unberührt — eine Note darf den
    // Zeilenabstand nicht aufreissen.
    const segSize = _sizeFor(segStyle, sizePt);
    doc.font(_runFontKey(segStyle || {}, fontKeyBase)).fontSize(segSize);
    const segDy = _supOffset(doc, segStyle, sizePt);
    doc.fillColor(segStyle && segStyle.link ? linkColor : textColor);
    // pdfkit `_fragment` macht bei gesetztem wordSpacing intern ein
    // `text.trim().split(/\s+/)` und baut die Wortabstände selbst — ein
    // FÜHRENDER Boundary-Space (z. B. das Trennzeichen nach `</em>`, das als
    // leading space ins Folge-Segment fällt) geht dabei verloren und die Wörter
    // kleben aneinander ("Heimatund"). Fix: den sichtbaren Text ohne führenden
    // Whitespace zeichnen und die Startposition um dessen Vorschub (inkl.
    // justify-ws) nach rechts schieben. Die Gesamt-x-Fortschreibung bleibt
    // unverändert (segAdvance/segSpaces decken alles ab) → Folgesegmente sitzen
    // an gleicher Stelle wie zuvor.
    const drawText = segText.replace(/^\s+/, '');
    const drawX = x + segLeadWidth + ws * segLeadSpaces;
    // Ohne LineWrapper füllt pdfkit `textWidth`/`wordCount` nicht — die
    // Unterstrich-/Link-Rechteckbreite (`renderedWidth` in _fragment) würde sonst
    // NaN. Beide um den führenden Whitespace bereinigt, damit die Rect-Breite zum
    // ab drawX gezeichneten Text passt.
    const topts = {
      lineBreak: false, wordSpacing: ws,
      underline: !!(segStyle && segStyle.underline),
      textWidth: segAdvance - segLeadWidth, wordCount: (segSpaces - segLeadSpaces) + 1,
    };
    if (segStyle && segStyle.link) topts.link = segStyle.link;
    doc.text(drawText, drawX, y + segDy, topts);
    x += segAdvance + ws * segSpaces;
    segText = ''; segStyle = null; segAdvance = 0; segSpaces = 0;
    segLeadWidth = 0; segLeadSpaces = 0; segHasWord = false;
  };
  // Verbund-Tokens (Klebe-Regeln in _tokenize) sind nur fuer den Zeilenumbruch
  // eine Einheit — gezeichnet wird jeder Teil mit seinem eigenen Style. Darum
  // hier auffalten, bevor die Segmentbildung laeuft. Genau das verhindert den
  // hochgestellten Satzpunkt hinter einer Notenziffer.
  const items = [];
  for (const it of line.items) {
    if (!it.parts) { items.push(it); continue; }
    for (const p of it.parts) items.push({ word: p.text, style: p.style, w: p.w });
  }
  for (const it of items) {
    const sig = _styleSig(it.style);
    if (segStyle !== null && _styleSig(segStyle) !== sig) flush();
    if (segStyle === null) segStyle = it.style;
    if (it.space) {
      if (!segHasWord) { segLeadWidth += it.w; segLeadSpaces++; }
      segText += ' '; segSpaces++;
    } else {
      segHasWord = true;
      segText += it.word;
    }
    segAdvance += it.w;
  }
  flush();
}

// Rendert `runs` als Einspalten-Blocksatz ab der aktuellen doc-Position.
function _renderRunsJustified(doc, runs, opts) {
  const { sizePt, lineHeight, textColor = '#000000', linkColor = '#1a4d8f', firstLineIndent = 0, hangingIndentPt = 0, hyphenate = null, fontKeyBase = 'body', align = 'justify' } = opts;
  const items = _tokenize(runs);
  if (!items.length) return;
  const features = doc._otFeatures;
  const cache = new Map();
  const spaceWidth = _measure(doc, ' ', fontKeyBase, sizePt, features, cache);
  const totalWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  const lines = _breakLines(doc, items, {
    sizePt, features, cache, hyphenate, fontKeyBase,
    totalWidth, firstIndent: firstLineIndent, hangIndent: hangingIndentPt, spaceWidth,
  });

  doc.font(fontKeyBase).fontSize(sizePt);
  const baseAdvance = doc.currentLineHeight(true) + (lineHeight - 1) * sizePt;
  const fitHeight = doc.currentLineHeight(true);

  // Fussnoten: `footnotes` ist der Zustand aus footnotes.js. Fehlt er, laeuft
  // alles wie zuvor — der Zweig kostet dann nichts.
  const fn = opts.footnotes || null;

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];

    // ── Umbruchentscheidung, GENAU EINE pro Zeile ────────────────────────────
    // Traegt die Zeile Notenmarker, muss der Platz ihrer Noten am Seitenfuss
    // schon in DIESER Pruefung stecken. Sonst passt die Zeile, die Reserve
    // waechst danach — und die letzte Zeile der Seite steht im Apparat.
    //
    // TERMINIERUNG kommt nicht aus dieser Bedingung, sondern aus der Struktur:
    // pro Zeile gibt es hoechstens EINEN Seitenumbruch (kein Re-Check nach dem
    // addPage), und der Deckel haelt die Reserve unter einem Bruchteil des
    // Satzspiegels. Beides zusammen garantiert, dass jede Zeile gesetzt wird.
    //
    // `pageEmpty` ist ein Struktur-Schutz, kein Fix fuer einen beobachteten
    // Fehler: auf einer frischen Seite waere ein Umbruch sinnlos, weil die Zeile
    // danach ohnehin gesetzt wird. Der Guard haelt die Invariante „eine frische
    // Seite nimmt jede Zeile" auch dann, wenn Deckel oder Geometrie spaeter
    // veraendert werden.
    const noteIds = fn ? noteIdsOfLine(line) : null;
    const pageIdx = fn && noteIds && noteIds.length ? _currentPageIdx(doc) : -1;
    const extraH = pageIdx >= 0 ? fn.extraHeightFor(pageIdx, noteIds) : 0;
    const pageEmpty = doc.y <= doc.page.margins.top + 0.5;
    const overflows = doc.y + fitHeight + extraH > doc.page.maxY();
    const overCap = extraH > 0 && fn.wouldExceedCap(pageIdx, extraH);

    if (!pageEmpty && (overflows || overCap)) {
      doc.addPage();
      doc.y = doc.page.margins.top;
    }
    // Haengender Einzug (Verzeichniseintraege): erste Zeile am Rand, alle
    // Folgezeilen eingerueckt — das Gegenteil des Erstzeilen-Einzugs.
    const indent = li === 0 ? firstLineIndent : hangingIndentPt;
    const left = doc.page.margins.left + indent;
    const avail = totalWidth - indent;
    const isLast = li === lines.length - 1;
    // Linksbuendig ist derselbe Layouter ohne Wortabstands-Ausgleich. Gebraucht
    // wird das fuer Listen: sie laufen sonst ueber den pdfkit-Pfad, der keinen
    // Per-Zeilen-Hook hat — und ohne den koennte eine Note dort keinen Platz am
    // Seitenfuss reservieren.
    let ws = 0;
    if (align === 'justify' && !line.forced && !isLast && line.spaces > 0) {
      ws = (avail - line.width) / line.spaces;
      if (ws < 0) ws = 0;
      else if (ws > spaceWidth * 3) ws = spaceWidth * 3; // Rivers vermeiden
    }
    _renderLine(doc, line, left, doc.y, { sizePt, ws, textColor, linkColor, fontKeyBase });
    doc.y += baseAdvance;

    // Erst NACH dem Setzen zuschlagen: die Reserve gilt ab der Folgezeile. Die
    // eigene Zeile hat ihren Platz oben schon eingerechnet. `maxReserve` haelt
    // den Apparat unter dem Deckel — damit bleibt garantiert Satzspiegel fuer
    // Text uebrig und der Umbruch terminiert. Eine einzelne Note ueber dem
    // Deckel ragt dafuer in den unteren Rand; das zaehlt overflowCount().
    if (fn && noteIds && noteIds.length) {
      fn.commit(_currentPageIdx(doc), noteIds, { maxReserve: fn.capPt });
    }
  }
  doc.x = doc.page.margins.left;
  doc.fillColor(textColor);
}

module.exports = { _renderRunsJustified, _tokenize, _breakLines, _styleSig, _renderLine, _sizeFor, _supOffset, noteIdsOfLine, SUP_SCALE, SUP_RISE };
