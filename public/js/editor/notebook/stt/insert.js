// Einfuege-Seite des Diktats: wohin der Text kommt und wie er sich an den
// vorhandenen Satz anschliesst.
//
// Der Caret wird NICHT aus der Live-Selection gelesen, sondern aus dem
// Vorwaerts-Anker `_sttLastNode` — der Browser kollabiert/resettet die Selection
// nach laengeren Pausen (Fokusverlust) an den Editoranfang, was den Caret „nach
// oben" springen liesse.

import { caretRangeIn, rangeAtEnd } from '../../utils.js';

export const sttInsertMethods = {
  // Range fuer die naechste Einfuegung. Bevorzugt den Vorwaerts-Anker
  // (`_sttLastNode`): Caret direkt HINTER dem zuletzt diktierten Knoten. So
  // bewegt sich die Einfuegestelle nur vorwaerts. Die Live-Selection ist
  // unzuverlaessig — der Browser kollabiert/resettet sie nach laengeren Pausen
  // an den Editoranfang, was den Caret „nach oben" springen liesse. Nur fuer
  // das ERSTE Segment (kein Anker) wird die Live-Selection (vom User bewusst
  // gesetzter Caret bzw. der Start-Anker ans Ende) honoriert, sonst Editorende.
  _sttResolveRange() {
    const editEl = this._getEditEl?.();
    if (!editEl) return null;
    if (this._sttLastNode && editEl.contains(this._sttLastNode)) {
      const range = document.createRange();
      range.setStartAfter(this._sttLastNode);
      range.collapse(true);
      return range;
    }
    return caretRangeIn(editEl) || rangeAtEnd(editEl);
  },

  _sttInsertText(text, boundaryKind) {
    const clean = this._normalizeTranscript(text);
    if (!clean) return; // leerer/Whitespace-Transkript -> nichts einfuegen
    if (this._isLikelyHallucination(clean)) return; // Whisper-Geisterphrase -> verwerfen
    this._trackSttChars?.(clean.length); // Diktat-Tracking: diktierte Zeichen buchen
    if (boundaryKind === 'paragraph') { this._sttInsertParagraph(clean); return; }
    const range = this._sttResolveRange();
    if (!range) return;
    const sel = document.getSelection();
    let prevChar = this._sttCharBefore(range);
    // Beginnt das Segment mit Satzzeichen und steht davor schon ein Leerzeichen,
    // dieses entfernen (kein „Wort , dann").
    if (range.collapsed && this._computeEatPrevSpace(prevChar, clean) && this._sttDeletePrevWhitespace(range)) {
      prevChar = this._sttCharBefore(range);
    }
    const prevText = this._sttTextBefore(range);
    const node = document.createTextNode(this._computeSpacedInsert(prevText, clean));
    range.deleteContents();
    range.insertNode(node);
    this._sttLastNode = node; // Vorwaerts-Anker auf den frisch eingefuegten Knoten
    range.setStartAfter(node);
    range.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(range);
    this._markEditDirty?.();
    // Programmatischer Insert: der Browser zieht den Scroll nicht automatisch
    // nach — den eingefügten Knoten selbst vermessen und ins Sichtfeld holen.
    let caretRect = null;
    try { const rr = document.createRange(); rr.selectNode(node); caretRect = rr.getBoundingClientRect(); } catch { /* noop */ }
    this._scrollEditCaretIntoView?.(caretRect);
  },

  // Fuegt das Transkript als NEUEN Absatz (`<p>`) ein — getriggert, wenn die
  // Sprechpause deutlich laenger war (Absatz-Erkennung im VAD). Der neue Absatz
  // wird hinter den Block gesetzt, in dem der Caret steht (sonst ans Editorende);
  // der vorausgehende Block bekommt ein Satzendezeichen, falls es fehlt. Erster
  // Buchstabe gross (neuer Absatz = neuer Satz). data-bid vergibt der Write-
  // Chokepoint beim Speichern (idempotent) — hier kein manuelles Setzen noetig.
  _sttInsertParagraph(clean) {
    const editEl = this._getEditEl?.();
    if (!editEl) return;
    const range = this._sttResolveRange();
    if (!range) return;
    const sel = document.getSelection();

    // Direkten Kind-Block von editEl ermitteln, in dem der Caret steht.
    let block = range.startContainer;
    while (block && block !== editEl && block.parentNode !== editEl) block = block.parentNode;
    if (block === editEl) block = editEl.lastElementChild; // Caret direkt am Root

    const p = document.createElement('p');
    p.textContent = this._capitalizeSentenceStart(clean);
    if (block && block.parentNode === editEl) {
      this._sttEnsureTerminalPunct(block);
      block.after(p);
    } else {
      editEl.appendChild(p);
    }

    // Vorwaerts-Anker auf den Textknoten IM neuen Absatz, damit das naechste
    // Segment innerhalb dieses `<p>` weiterschreibt (nicht dahinter am Root).
    this._sttLastNode = p.firstChild || p;
    const r2 = document.createRange();
    r2.selectNodeContents(p);
    r2.collapse(false);
    sel?.removeAllRanges();
    sel?.addRange(r2);
    this._markEditDirty?.();
    let rect = null;
    try { rect = p.getBoundingClientRect(); } catch { /* noop */ }
    this._scrollEditCaretIntoView?.(rect);
  },

  // Haengt ein '.' an den letzten Textknoten eines Blocks an, wenn dieser nicht
  // bereits auf einem Satz-/Doppelpunkt endet — damit beim Absatzwechsel der
  // vorausgehende Satz sauber schliesst.
  _sttEnsureTerminalPunct(block) {
    try {
      if (!block || block.nodeType !== 1) return;
      // Schliessende Anfuehrungs-/Klammerzeichen mit abstreifen, damit ein vom
      // Modell gesetztes Satzzeichen im Dialog („…her.«") erkannt wird und wir
      // keinen zweiten Punkt anhaengen.
      const txt = (block.textContent || '').replace(/[\s"'’”“»«)\]]+$/u, '');
      if (!txt || /[.!?…:;]$/.test(txt)) return;
      const lastTextNode = (node) => {
        for (let i = node.childNodes.length - 1; i >= 0; i--) {
          const c = node.childNodes[i];
          if (c.nodeType === 3 && c.textContent.trim()) return c;
          if (c.nodeType === 1) { const r = lastTextNode(c); if (r) return r; }
        }
        return null;
      };
      const tn = lastTextNode(block);
      if (tn) tn.textContent = tn.textContent.replace(/\s+$/, '') + '.';
      else block.appendChild(document.createTextNode('.'));
    } catch { /* noop */ }
  },

  // Zeichen unmittelbar vor dem Caret (fuer Leerzeichen-Heuristik). Der Caret
  // steht zwischen Segmenten meist an einer Knotengrenze (nach dem zuletzt
  // eingefuegten Textknoten), wo `startContainer` ein Elementknoten ist — darum
  // den gesamten Text links vom Caret per Range einsammeln und das letzte
  // Zeichen nehmen (deckt Text- und Elementknoten gleichermassen ab).
  // Letzte n Zeichen links vom Caret (Default 12) — genug Kontext, um ein
  // Satzendezeichen auch hinter einer schliessenden Anfuehrung zu erkennen
  // (siehe `_endsSentence`). Sammelt den Text per Range ueber Knotengrenzen.
  _sttTextBefore(range, n = 12) {
    try {
      const editEl = this._getEditEl?.();
      if (!editEl) return '';
      const probe = range.cloneRange();
      probe.collapse(true);
      const left = document.createRange();
      left.selectNodeContents(editEl);
      left.setEnd(probe.startContainer, probe.startOffset);
      return left.toString().slice(-n);
    } catch { /* noop */ }
    return '';
  },

  _sttCharBefore(range) {
    try {
      const probe = range.cloneRange();
      probe.collapse(true);
      const node = probe.startContainer;
      if (node.nodeType === 3 && probe.startOffset > 0) {
        return node.textContent[probe.startOffset - 1] || '';
      }
      const editEl = this._getEditEl?.();
      if (editEl) {
        const left = document.createRange();
        left.selectNodeContents(editEl);
        left.setEnd(probe.startContainer, probe.startOffset);
        const txt = left.toString();
        if (txt.length) return txt[txt.length - 1];
      }
    } catch { /* noop */ }
    return '';
  },

  // Loescht ein einzelnes Whitespace-Zeichen direkt vor dem (kollabierten)
  // Caret und setzt `range` an die Tilgungsstelle. Liefert true bei Erfolg.
  // Deckt Textknoten-Caret und Element-Knoten-Grenze (vorausgehender Textknoten)
  // ab. Idempotent-sicher: tilgt nur, wenn dort wirklich Whitespace steht.
  _sttDeletePrevWhitespace(range) {
    try {
      if (!range.collapsed) return false;
      let node = range.startContainer;
      let offset = range.startOffset;
      if (node.nodeType === 1 && offset > 0) {
        let child = node.childNodes[offset - 1];
        while (child && child.nodeType === 1 && child.lastChild) child = child.lastChild;
        if (child && child.nodeType === 3) { node = child; offset = child.textContent.length; }
      }
      if (node.nodeType === 3 && offset > 0 && /\s/.test(node.textContent[offset - 1])) {
        node.deleteData(offset - 1, 1);
        range.setStart(node, offset - 1);
        range.collapse(true);
        return true;
      }
    } catch { /* noop */ }
    return false;
  },
};
