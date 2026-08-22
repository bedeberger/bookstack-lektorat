// editorToolbarCard: zentraler Keydown-Dispatcher für den Edit-Container
// (delegiert aus editor-toolbar-card.js). Statt eines Megaswitch eine geordnete
// Kette benannter Handler: jeder gibt `true` zurück, wenn er das Event
// konsumiert hat — dann bricht der Dispatcher ab. `this` = Sub-Komponente
// (editorToolbarCard), Root-Zugriffe via window.__app.

import { getEditEl, placeCaretIn, _brLeftOfCaret, _formatStamp, findTodoLi, findPoemP, findFigcaption, findBlock, topLevelBlock, caretAtBlockStart, caretAtBlockEnd, MERGE_BLOCK_TAGS, ATOMIC_BLOCK_TAGS, BOUNDARY_WRAPPER_SEL, wrapperInnerBlocks } from './_shared.js';
import { createTodoItem, TODO_TEXT_SEL, TODO_LIST_SEL } from '../../shared/todo-html.js';
import { matchHistoryCommand } from '../../shared/shortcuts.js';

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
    // Struktur-Grenzen: spezifisch vor generisch. `_kbTodoDelete` und
    // `_kbFigureCaption` schützen je ein Void-Element (Checkbox bzw. Bild),
    // `_kbBlockBoundary` deckt die übrigen formatierten Wrapper ab.
    if (this._kbTodoDelete(e, app)) return;
    if (this._kbFigureCaption(e, app)) return;
    if (this._kbBlockBoundary(e, app)) return;
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
    const text = (li.querySelector(TODO_TEXT_SEL)?.textContent || '').trim();
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
      // Struktur kommt aus der Markup-SSoT editor/shared/todo-html.js.
      const newLi = createTodoItem();
      li.parentNode.insertBefore(newLi, li.nextSibling);
      placeCaretIn(newLi.querySelector(TODO_TEXT_SEL));
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

  // Undo/Redo. Griffe kommen aus `matchHistoryCommand` (shared/shortcuts.js) —
  // dieselbe Funktion bindet der Fokusmodus (focus/listeners.js). Browser-Default
  // bewusst überschrieben: der eigene Stack ist nach Slash/HR-Mutationen
  // konsistent, der Browser-Stack ist es nicht.
  //
  // Der Fokusmodus fällt hier durch (→ Hard-Stop im Dispatcher) und wird von
  // seinem eigenen Container-Listener bedient, der VOR diesem document-Level-
  // Dispatcher läuft und das Event per stopPropagation verbraucht. Beide Wege
  // landen auf derselben Historie (siehe notebook/history.js).
  _kbUndoRedo(e, app) {
    if (app.focusActive) return false;
    const cmd = matchHistoryCommand(e);
    if (!cmd) return false;
    e.preventDefault();
    if (cmd === 'undo') app.notebookUndo?.(); else app.notebookRedo?.();
    return true;
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

  // Backspace/Delete-Sonderpfade: (a) per Klick markierte <hr> löschen; (b) einen
  // direkt angrenzenden atomaren Block (<hr>, <figure>) löschen — beide nehmen
  // keinen Caret auf, es gäbe sonst keinen Lösch-Pfad; (c) Absatz-Merge über
  // weiche Umbrüche hinweg selbst übernehmen (Browser zieht sonst nur die erste
  // Zeile hoch und macht aus dem Rest neue Absätze). Gibt false zurück, wenn
  // keiner dieser Fälle greift → normaler Browser-Default.
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
    // Ein atomarer Block ist Direktkind von editEl; der Caret-Block kann tiefer
    // liegen (z.B. <li> in einer Liste). Nachbar daher auf der Ebene des
    // umschliessenden Top-Level-Childs suchen, nicht am Block selbst.
    const top = topLevelBlock(block, editEl);
    const neighbour = e.key === 'Backspace'
      ? (caretAtBlockStart(range, block) ? top.previousElementSibling : null)
      : (caretAtBlockEnd(range, block) ? top.nextElementSibling : null);
    if (neighbour && ATOMIC_BLOCK_TAGS.has(neighbour.tagName)) {
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

  // Backspace/Delete in einer Checkbox-Liste (`ul.todo`). Der Browser-Default
  // behandelt die `<input>`-Checkbox wie ein Textzeichen: der erste Tastendruck
  // frisst sie, erst der nächste räumt die Zeile auf — dazwischen steht ein
  // `li.todo-item` ohne Checkbox. Am Listenanfang tut er dagegen gar nichts
  // (die Liste ist per Backspace nicht verlassbar), und über die Listengrenze
  // hinweg zieht er den Folgeabsatz samt Inline-`style`-Attribut in das
  // `.todo-text`-Span. Diese vier Fälle daher selbst übernehmen — die Checkbox
  // ist Struktur, nie Löschziel, und ein Tastendruck bewirkt genau einen
  // Schritt. Nicht-collapsed Selektionen bleiben beim Default (Mehrzeilen-Löschen
  // ist kein Struktur-, sondern ein Inhaltsfall).
  _kbTodoDelete(e, app) {
    if (e.key !== 'Backspace' && e.key !== 'Delete') return false;
    const editEl = getEditEl();
    const sel = editEl ? document.getSelection() : null;
    if (!sel || sel.rangeCount === 0) return false;
    const range = sel.getRangeAt(0);
    if (!range.collapsed || !editEl.contains(range.startContainer)) return false;
    const li = findTodoLi(range.startContainer, editEl);
    return li
      ? this._kbTodoDeleteInside(e, app, range, li, editEl)
      : this._kbTodoDeleteAdjacent(e, app, range, editEl);
  },

  // Caret sitzt IN einer Checkbox-Zeile. Backspace am Zeilenanfang: mit der
  // Zeile darüber verschmelzen bzw. — in der ersten Zeile — die Liste in einen
  // Absatz davor verlassen. Delete am Zeilenende: die Zeile darunter hochziehen
  // (deren Checkbox verschwindet mit ihr, die eigene bleibt samt Häkchen) bzw.
  // in der letzten Zeile den Folgeabsatz hochziehen. Mitten im Text: Default.
  _kbTodoDeleteInside(e, app, range, li, editEl) {
    const span = li.querySelector(TODO_TEXT_SEL);
    if (!span) return false; // fremdes Markup — nicht anfassen
    if (e.key === 'Backspace') {
      if (!caretAtBlockStart(range, span)) return false;
      e.preventDefault();
      const prevSpan = li.previousElementSibling?.querySelector(TODO_TEXT_SEL);
      if (prevSpan) {
        this._mergeBlocksManually(prevSpan, span);
        li.remove();
      } else {
        // Erste Zeile → raus aus der Liste. Inhalt kommt aus dem `.todo-text`,
        // nicht aus der `li` — sonst wanderte die Checkbox in den Absatz.
        this._blockToParagraph(li, li.parentNode, span);
      }
      app._markEditDirty?.();
      return true;
    }
    if (!caretAtBlockEnd(range, span)) return false;
    e.preventDefault();
    const next = li.nextElementSibling;
    const nextSpan = next?.querySelector(TODO_TEXT_SEL);
    if (nextSpan) {
      this._mergeBlocksManually(span, nextSpan);
      next.remove();
    } else {
      // Letzte Zeile: nur absatz-artige Folgeblöcke hochziehen. Steht dahinter
      // etwas anderes (Liste, Gedicht, <hr>) bzw. nichts, bleibt es ein No-Op —
      // besser als der Default, der fremdes Markup ins Span schiebt.
      const after = topLevelBlock(li, editEl).nextElementSibling;
      if (!after || !MERGE_BLOCK_TAGS.has(after.tagName)) return true;
      this._mergeBlocksManually(span, after);
    }
    app._markEditDirty?.();
    return true;
  },

  // Caret in einem Absatz, der an eine Checkbox-Liste GRENZT — beide
  // Richtungen, denn der Default ist in beiden falsch: nach der Liste schiebt er
  // den Absatz mit einem Inline-`style` ins Span und lässt ihn als Block
  // verschwinden; vor der Liste frisst er die Checkbox der ersten Zeile.
  //   • Backspace am Anfang des Absatzes NACH der Liste → an die letzte Zeile
  //     anhängen (Gegenstück zu Delete am Ende der letzten Zeile).
  //   • Delete am Ende des Absatzes VOR der Liste → Inhalt der ersten Zeile in
  //     den Absatz ziehen. Die Checkbox fällt dabei weg, weil ein Absatz keine
  //     hat — dieselbe Semantik wie beim Verlassen der Liste per Backspace.
  _kbTodoDeleteAdjacent(e, app, range, editEl) {
    const block = findBlock(range.startContainer, editEl);
    if (!block || block.parentNode !== editEl || !MERGE_BLOCK_TAGS.has(block.tagName)) return false;
    const back = e.key === 'Backspace';
    if (!(back ? caretAtBlockStart(range, block) : caretAtBlockEnd(range, block))) return false;
    const ul = back ? block.previousElementSibling : block.nextElementSibling;
    if (!ul?.matches?.(TODO_LIST_SEL)) return false;
    const li = back ? ul.lastElementChild : ul.firstElementChild;
    const span = li?.querySelector(TODO_TEXT_SEL);
    if (!span) return false;
    e.preventDefault();
    if (back) {
      this._mergeBlocksManually(span, block);
    } else {
      this._mergeBlocksManually(block, span);
      li.remove();
      if (!ul.querySelector('li')) ul.remove();
    }
    app._markEditDirty?.();
    return true;
  },

  // Backspace/Delete in der `<figcaption>` eines Bildes. `<figure>` ist der
  // zweite Fall nach `ul.todo`, in dem ein Void-Element (`<img>`) direkt neben
  // dem Text steht — und der Default behandelt es genauso als Zeichen: bei
  // leerer Legende löscht Druck #1 die Legende, #2 das BILD (zurück bleibt ein
  // `<figure>` mit Rahmen ohne Inhalt), erst #3 räumt auf. Mit Text in der
  // Legende macht er aus der `<figcaption>` ein `<span style="…">` und steckt
  // danach dauerhaft fest. Beides ersetzt:
  //   • leere Legende + Backspace → ganzes `<figure>` weg (ein Druck), leerer
  //     Absatz an seiner Stelle. Das Bild ist der Inhalt, den man loswerden will.
  //   • Legende mit Text + Backspace am Anfang → No-Op. Links steht das Bild,
  //     kein Zeichen; erst den Legendentext löschen, dann greift der Fall oben.
  //     Verlustfrei und ohne Feststecken.
  //   • Delete am Ende der Legende → No-Op statt den Folgeblock hereinzuziehen.
  // Das Bild selbst löscht man von aussen: `_kbDeleteBlock` behandelt ein
  // angrenzendes `<figure>` wie eine `<hr>` (ATOMIC_BLOCK_TAGS).
  _kbFigureCaption(e, app) {
    if (e.key !== 'Backspace' && e.key !== 'Delete') return false;
    const editEl = getEditEl();
    const sel = editEl ? document.getSelection() : null;
    if (!sel || sel.rangeCount === 0) return false;
    const range = sel.getRangeAt(0);
    if (!range.collapsed || !editEl.contains(range.startContainer)) return false;
    const cap = findFigcaption(range.startContainer, editEl);
    if (!cap) return false;
    if (e.key === 'Delete') {
      if (!caretAtBlockEnd(range, cap)) return false;
      e.preventDefault();
      return true;
    }
    if (!caretAtBlockStart(range, cap)) return false;
    const fig = cap.closest('figure');
    if (!fig || !editEl.contains(fig)) return false;
    e.preventDefault();
    if ((cap.textContent || '').trim()) return true; // erst den Legendentext löschen
    const p = document.createElement('p');
    p.appendChild(document.createElement('br'));
    fig.parentNode.replaceChild(p, fig);
    placeCaretIn(p);
    app._markEditDirty?.();
    return true;
  },

  // Grenzen formatierter Wrapper-Blöcke (`blockquote`, `div.poem`, `pre`,
  // `ul`/`ol`) — siehe BOUNDARY_WRAPPER_SEL für das Warum: der Default bäckt
  // beim Merge über so eine Grenze die berechneten CSS-Werte als Inline-`style`
  // ein und lässt den Wrapper teils ganz verschwinden. Vier symmetrische Fälle,
  // je nachdem ob der Caret innerhalb des Wrappers oder im Nachbarabsatz sitzt.
  // Merges INNERHALB eines Wrappers (Zeile 2 auf Zeile 1) bleiben beim Default —
  // die sind nachweislich sauber.
  _kbBlockBoundary(e, app) {
    if (e.key !== 'Backspace' && e.key !== 'Delete') return false;
    const editEl = getEditEl();
    const sel = editEl ? document.getSelection() : null;
    if (!sel || sel.rangeCount === 0) return false;
    const range = sel.getRangeAt(0);
    if (!range.collapsed || !editEl.contains(range.startContainer)) return false;
    const block = findBlock(range.startContainer, editEl);
    if (!block) return false;
    const top = topLevelBlock(block, editEl);
    if (top.matches?.(BOUNDARY_WRAPPER_SEL)) {
      return this._kbBoundaryInside(e, app, range, block, top);
    }
    if (block === top && MERGE_BLOCK_TAGS.has(block.tagName)) {
      return this._kbBoundaryOutside(e, app, range, block);
    }
    return false;
  },

  // Caret INNERHALB des Wrappers. Am Anfang des ersten Kind-Blocks verlässt
  // Backspace den Wrapper (Inhalt wird zum Absatz davor) — dieselbe Regel wie
  // in der Checkbox-Liste. Am Ende des letzten Kind-Blocks zieht Delete den
  // Folgeabsatz herein.
  _kbBoundaryInside(e, app, range, block, wrapper) {
    const inner = wrapperInnerBlocks(wrapper);
    const idx = inner.indexOf(block);
    if (idx === -1) return false;
    if (e.key === 'Backspace') {
      if (idx > 0 || !caretAtBlockStart(range, block)) return false;
      e.preventDefault();
      this._blockToParagraph(block, wrapper);
      app._markEditDirty?.();
      return true;
    }
    if (idx < inner.length - 1 || !caretAtBlockEnd(range, block)) return false;
    // Nichts bzw. kein absatz-artiger Block dahinter: durchfallen lassen. Einen
    // atomaren Nachbarn (<hr>, <figure>) hat `_kbDeleteBlock` bereits erledigt.
    const after = wrapper.nextElementSibling;
    if (!after || !MERGE_BLOCK_TAGS.has(after.tagName)) return false;
    e.preventDefault();
    this._mergeBlocksManually(block, after);
    app._markEditDirty?.();
    return true;
  },

  // Caret in einem Top-Level-Absatz, der an einen Wrapper grenzt: Inhalt an
  // dessen letzten Kind-Block anhängen (Backspace) bzw. dessen ersten
  // Kind-Block hereinziehen (Delete). Gegenstücke zu `_kbBoundaryInside`.
  _kbBoundaryOutside(e, app, range, block) {
    const back = e.key === 'Backspace';
    if (!(back ? caretAtBlockStart(range, block) : caretAtBlockEnd(range, block))) return false;
    const wrapper = back ? block.previousElementSibling : block.nextElementSibling;
    if (!wrapper?.matches?.(BOUNDARY_WRAPPER_SEL)) return false;
    const inner = wrapperInnerBlocks(wrapper);
    if (!inner.length) return false;
    e.preventDefault();
    if (back) {
      this._mergeBlocksManually(inner[inner.length - 1], block);
    } else {
      // `_mergeBlocksManually` entfernt die Quelle. Bei <pre> IST die Quelle der
      // Wrapper, der damit schon weg ist — sonst den leer gewordenen entfernen.
      this._mergeBlocksManually(block, inner[0]);
      if (wrapper.isConnected && !wrapperInnerBlocks(wrapper).length) wrapper.remove();
    }
    app._markEditDirty?.();
    return true;
  },

  // Block aus seinem Wrapper lösen: der Inhalt wandert in einen `<p>` VOR dem
  // Wrapper, der Block verschwindet, ein leer gewordener Wrapper ebenfalls. Ist
  // der Block selbst der Wrapper (`<pre>`), wird er an seiner Stelle durch den
  // Absatz ersetzt. `contentEl` trennt „welcher Knoten wird entfernt" von
  // „woraus kommt der Inhalt" — in der Checkbox-Liste ist das die `<li>` bzw.
  // ihr `.todo-text`, damit die Checkbox nicht mitwandert. Caret an den
  // Absatz-Anfang, also dorthin, wo er vor dem Backspace stand.
  _blockToParagraph(block, wrapper, contentEl = block) {
    const p = document.createElement('p');
    while (contentEl?.firstChild) p.appendChild(contentEl.firstChild);
    if (!p.childNodes.length) p.appendChild(document.createElement('br'));
    if (block === wrapper) {
      wrapper.parentNode.replaceChild(p, wrapper);
    } else {
      wrapper.parentNode.insertBefore(p, wrapper);
      block.remove();
      if (!wrapperInnerBlocks(wrapper).length) wrapper.remove();
    }
    placeCaretIn(p);
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
    // Ein alleinstehendes <br> ist Platzhalter, nicht Inhalt: auf BEIDEN Seiten
    // wegräumen, sonst bleibt eine Leerzeile vor (Receiver) bzw. hinter (Source)
    // dem angehängten Text stehen. Der Source-Fall tritt nur über den Checkbox-
    // Pfad auf — `_kbDeleteBlock` merged ausschliesslich Quellen mit Text.
    const placeholderOnly = (el) => el.childNodes.length === 1 && el.firstChild.nodeName === 'BR';
    if (placeholderOnly(receiver)) receiver.removeChild(receiver.firstChild);
    if (placeholderOnly(source)) source.removeChild(source.firstChild);
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
