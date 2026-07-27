// editorToolbarCard: zentraler Keydown-Dispatcher für den Edit-Container
// (delegiert aus editor-toolbar-card.js). Statt eines Megaswitch eine geordnete
// Kette benannter Handler: jeder gibt `true` zurück, wenn er das Event
// konsumiert hat — dann bricht der Dispatcher ab. `this` = Sub-Komponente
// (editorToolbarCard), Root-Zugriffe via window.__app.

import { getEditEl, placeCaretIn, _brLeftOfCaret, _formatStamp, findTodoLi, findPoemP, findBlock, topLevelBlock, caretAtBlockStart, caretAtBlockEnd, MERGE_BLOCK_TAGS } from './_shared.js';

export const keydownMethods = {
  // Reihenfolge ist verhaltensrelevant (z.B. Shift+Enter vor Enter-in-Todo).
  // Die Handler bis zum Focus-Hard-Stop laufen in BEIDEN Modi (Notebook +
  // Focus); danach sind Slash + Block-Transforms tabu.
  _onEditKeydown(e) {
    const app = window.__app;
    if (!app?.editMode) return;

    if (this._kbSoftBreak(e, app)) return;
    if (this._kbTodoEnter(e, app)) return;
    if (this._kbPoemEnter(e, app)) return;
    if (this._kbDateStamp(e, app)) return;
    if (this._kbInlineFormat(e)) return;
    if (this._kbHorizontalRule(e, app)) return;
    if (this._kbLink(e, app)) return;
    if (this._kbUndoRedo(e, app)) return;

    // Ab hier hört die Toolbar im Focus-Modus auf — Slash-Menü und Block-
    // Transforms sind dort nicht erlaubt. B/I/U liefen oben bzw. via Browser-
    // Default weiter.
    if (app.focusActive) return;

    if (this._kbSlashNav(e)) return;
    if (this._kbDeleteBlock(e, app)) return;
    this._kbSlashTrigger(e);
  },

  // Shift+Enter = weicher Zeilenumbruch (<br>). In Safari/WebKit splittet die
  // Default-Aktion stattdessen den Absatz in zwei <p> – in Gedichten/Dialogen
  // der falsche Umbruch. execCommand('insertLineBreak') setzt das <br> cross-
  // browser konsistent (WebKit + Chromium getestet). Auf einer bereits leeren
  // Soft-Break-Zeile (links steht ein <br>) keinen zweiten <br> einfügen — der
  // würde beim Save eh kollabieren (No-Op statt Doppel-Umbruch, der nach Reload
  // verschwindet).
  _kbSoftBreak(e, app) {
    if (!(e.key === 'Enter' && e.shiftKey)) return false;
    e.preventDefault();
    const editEl = getEditEl();
    const sel = editEl ? document.getSelection() : null;
    if (sel && _brLeftOfCaret(sel)) return true;
    document.execCommand('insertLineBreak');
    app._markEditDirty?.();
    return true;
  },

  // Enter in einer Checkbox-Liste: neues <li class="todo-item"> mit eigener
  // Checkbox einfügen. Leere todo-li → aus der Liste raus in <p>.
  _kbTodoEnter(e, app) {
    if (!(e.key === 'Enter' && !e.shiftKey)) return false;
    const editEl = getEditEl();
    const sel = editEl ? document.getSelection() : null;
    if (!sel || sel.rangeCount === 0) return false;
    const li = findTodoLi(sel.getRangeAt(0).startContainer, editEl);
    if (!li) return false;
    e.preventDefault();
    const text = (li.querySelector('.todo-text')?.textContent || '').trim();
    if (!text) {
      // Leere todo-li → in <p> hinter der Liste konvertieren, alte li raus.
      const ul = li.parentNode;
      const p = document.createElement('p');
      p.appendChild(document.createElement('br'));
      ul.parentNode.insertBefore(p, ul.nextSibling);
      li.remove();
      if (!ul.querySelector('li')) ul.remove();
      placeCaretIn(p);
    } else {
      const newLi = document.createElement('li');
      newLi.className = 'todo-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      const span = document.createElement('span');
      span.className = 'todo-text';
      span.appendChild(document.createElement('br'));
      newLi.appendChild(cb);
      newLi.appendChild(span);
      li.parentNode.insertBefore(newLi, li.nextSibling);
      placeCaretIn(span);
    }
    app._markEditDirty?.();
    return true;
  },

  // Doppel-Enter in einem Gedicht (<div class="poem"><p>…</p></div>): trifft
  // Enter ein leeres <p>, raus aus dem Gedicht in ein <p> dahinter. Der erste
  // Enter auf einer Textzeile erzeugt per Browser-Default die leere Zeile, der
  // zweite trifft sie und verlässt den Block. Spiegelt das Verhalten der
  // Checkbox-Liste (leeres todo-li → raus).
  _kbPoemEnter(e, app) {
    if (!(e.key === 'Enter' && !e.shiftKey)) return false;
    const editEl = getEditEl();
    const sel = editEl ? document.getSelection() : null;
    if (!sel || sel.rangeCount === 0) return false;
    const p = findPoemP(sel.getRangeAt(0).startContainer, editEl);
    if (!p || (p.textContent || '').trim()) return false;
    e.preventDefault();
    const poem = p.parentNode;
    const out = document.createElement('p');
    out.appendChild(document.createElement('br'));
    poem.parentNode.insertBefore(out, poem.nextSibling);
    p.remove();
    if (!poem.querySelector('p')) poem.remove();
    placeCaretIn(out);
    app._markEditDirty?.();
    return true;
  },

  // Cmd/Ctrl+; → Datum, Cmd/Ctrl+Shift+; → Datum+Zeit. Bewährter Office-
  // Shortcut, im Browser noch frei.
  _kbDateStamp(e, app) {
    if (!((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === ';' || e.code === 'Semicolon'))) return false;
    e.preventDefault();
    const stamp = _formatStamp(e.shiftKey ? 'datetime' : 'date');
    document.execCommand('insertText', false, stamp);
    app._markEditDirty?.();
    return true;
  },

  // Ctrl/Cmd+B und Ctrl/Cmd+I: Bold/Italic auch im Fokus-Modus, in dem die
  // Bubble-Toolbar ausgeblendet ist. Explizit statt Browser-Default, damit
  // _markEditDirty + Bubble-Reposition konsistent laufen.
  _kbInlineFormat(e) {
    if (!((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey)) return false;
    if (e.key === 'b' || e.key === 'B') { e.preventDefault(); this._applyInline('bold'); return true; }
    if (e.key === 'i' || e.key === 'I') { e.preventDefault(); this._applyInline('italic'); return true; }
    return false;
  },

  // Ctrl/Cmd+Shift+H: Trennlinie (<hr>) am Caret einfügen.
  _kbHorizontalRule(e, app) {
    if (!((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && (e.key === 'h' || e.key === 'H'))) return false;
    e.preventDefault();
    app.insertHorizontalRule?.();
    return true;
  },

  // Ctrl/Cmd+Shift+K: Link-Input öffnen (Cmd+K alleine belegt mit Palette). Im
  // Focus konsumiert die Kombo, tut aber nichts (kein preventDefault) — wie im
  // Original-Megaswitch.
  _kbLink(e, app) {
    if (!((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K'))) return false;
    if (app.focusActive) return true;
    e.preventDefault();
    this.openLinkInput();
    return true;
  },

  // Undo/Redo — nur im Notebook (Focus fällt durch → Hard-Stop im Dispatcher).
  // Cmd/Ctrl+Z → Undo, Cmd/Ctrl+Shift+Z + Ctrl+Y → Redo. Browser-Default
  // bewusst überschrieben — eigener Stack ist nach Slash/HR-Mutationen
  // konsistent, der Browser-Stack ist es nicht.
  _kbUndoRedo(e, app) {
    if (app.focusActive || !(e.metaKey || e.ctrlKey) || e.altKey) return false;
    if (!e.shiftKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); app.notebookUndo?.(); return true; }
    if (e.shiftKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); app.notebookRedo?.(); return true; }
    if (!e.shiftKey && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); app.notebookRedo?.(); return true; }
    return false;
  },

  // Slash-Menü-Navigation, wenn geöffnet. Bei offenem Menü werden ALLE Tasten
  // konsumiert (druckbare Zeichen filtern die Liste statt das Menü zu schliessen;
  // Modifier-Combos durchlaufen die Filter-Zeile nicht, konsumieren aber).
  _kbSlashNav(e) {
    if (!this.slashShow) return false;
    if (e.key === 'Escape') { e.preventDefault(); this._closeSlash(); return true; }
    const filtered = this.slashItems();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (filtered.length) this.slashIdx = (this.slashIdx + 1) % filtered.length;
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (filtered.length) this.slashIdx = (this.slashIdx - 1 + filtered.length) % filtered.length;
      return true;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const pick = filtered[this.slashIdx];
      if (pick) this._applySlashByKey(pick.key);
      return true;
    }
    if (e.key === 'Backspace') {
      e.preventDefault();
      if (!this.slashQuery) { this._closeSlash(); return true; }
      this.slashQuery = this.slashQuery.slice(0, -1);
      this.slashIdx = 0;
      return true;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      this.slashQuery += e.key;
      this.slashIdx = 0;
      return true;
    }
    return true;
  },

  // Backspace/Delete-Sonderpfade: (a) per Klick markierte <hr> löschen; (b) eine
  // direkt angrenzende <hr> löschen (void-Element, sonst kein Lösch-Pfad); (c)
  // Absatz-Merge über weiche Umbrüche hinweg selbst übernehmen (Browser zieht
  // sonst nur die erste Zeile hoch und macht aus dem Rest neue Absätze). Gibt
  // false zurück, wenn keiner dieser Fälle greift → normaler Browser-Default.
  _kbDeleteBlock(e, app) {
    if (e.key !== 'Backspace' && e.key !== 'Delete') return false;
    const editEl = getEditEl();
    // Per Klick markierte <hr> direkt entfernen (siehe editor-toolbar-card.js).
    const selectedHr = editEl?.querySelector('hr.hr-selected');
    if (selectedHr) {
      e.preventDefault();
      selectedHr.remove();
      app._markEditDirty?.();
      return true;
    }
    const sel = editEl ? document.getSelection() : null;
    if (!editEl || !sel || sel.rangeCount === 0) return false;
    const range = sel.getRangeAt(0);
    if (!range.collapsed || !editEl.contains(range.startContainer)) return false;
    const block = findBlock(range.startContainer, editEl);
    if (!block) return false;
    // Eine <hr> ist Direktkind von editEl; der Caret-Block kann tiefer liegen
    // (z.B. <li> in einer Liste). Nachbar daher auf der Ebene des umschliessenden
    // Top-Level-Childs suchen, nicht am Block selbst.
    const top = topLevelBlock(block, editEl);
    const neighbour = e.key === 'Backspace'
      ? (caretAtBlockStart(range, block) ? top.previousElementSibling : null)
      : (caretAtBlockEnd(range, block) ? top.nextElementSibling : null);
    if (neighbour && neighbour.tagName === 'HR') {
      e.preventDefault();
      neighbour.remove();
      app._markEditDirty?.();
      return true;
    }
    // Absatz-Grenze löschen (Merge zweier Absätze): enthält der Quell-Absatz
    // weiche Umbrüche (<br>), zieht der Browser nur dessen ERSTE Zeile hoch und
    // befördert den ersten <br> zu einer neuen Absatzgrenze — aus einem
    // gelöschten Absatz werden so „automatisch" mehrere. Bei top-level Absätzen
    // daher den Merge selbst übernehmen: gesamten Quell-Inhalt anhängen, weiche
    // Umbrüche bleiben weich.
    if (neighbour && block.parentNode === editEl
        && MERGE_BLOCK_TAGS.has(block.tagName)
        && MERGE_BLOCK_TAGS.has(neighbour.tagName)) {
      const source = e.key === 'Backspace' ? block : neighbour;
      if (source.querySelector('br') && (source.textContent || '').trim()) {
        e.preventDefault();
        const receiver = e.key === 'Backspace' ? neighbour : block;
        this._mergeBlocksManually(receiver, source);
        app._markEditDirty?.();
        return true;
      }
    }
    return false;
  },

  // Slash-Trigger: `/` in einem leeren Block öffnet das Block-Transform-Menü.
  _kbSlashTrigger(e) {
    if (e.key !== '/') return false;
    const editEl = getEditEl();
    if (!editEl) return false;
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    const range = sel.getRangeAt(0);
    if (!editEl.contains(range.startContainer)) return false;
    const block = findBlock(range.startContainer, editEl);
    if (!block) return false;
    if ((block.textContent || '').trim() !== '') return false;
    e.preventDefault();
    this._openSlashAt(block);
    return true;
  },

  // Verschmilzt `source` (gesamter Inhalt inkl. weicher <br>-Umbrüche) ans Ende
  // von `receiver` und entfernt `source`. Setzt den Caret an die Naht zwischen
  // Alt-Inhalt und angehängtem Inhalt. Ersetzt das native Merge-Verhalten, das
  // bei <br>-haltigen Absätzen nur die erste Zeile übernimmt und den Rest zu
  // einem neuen Absatz abspaltet.
  _mergeBlocksManually(receiver, source) {
    // Leeres Placeholder-<br> im Receiver entfernen, sonst bliebe eine Leerzeile
    // vor dem angehängten Text stehen.
    if (receiver.childNodes.length === 1 && receiver.firstChild.nodeName === 'BR') {
      receiver.removeChild(receiver.firstChild);
    }
    const anchor = receiver.lastChild; // Naht-Anker (null, wenn Receiver leer war)
    while (source.firstChild) receiver.appendChild(source.firstChild);
    source.remove();
    const sel = document.getSelection();
    if (!sel) return;
    const r = document.createRange();
    if (anchor && anchor.nodeType === 3) r.setStart(anchor, anchor.textContent.length);
    else if (anchor) r.setStartAfter(anchor);
    else r.setStart(receiver, 0);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  },
};
