// editorToolbarCard: Slash-Menü (Block-Transforms). `this` = Sub-Komponente
// (editorToolbarCard). Im Fokus-Modus deaktiviert (Trigger im keydown-Dispatch
// hinter dem Focus-Hard-Stop).

import { getEditEl, placeCaretIn, SLASH_ITEMS, _formatStamp } from './_shared.js';
import { createTodoList } from '../../shared/todo-html.js';
import { contentRepo } from '../../../repo/content.js';

const SLASH_GAP = 4;
// Deckungsgleich mit `max-height` in css/editor/notebook/edit-toolbar.css.
const SLASH_MAX_H = 360;
// Unter dieser Höhe wird die Liste unbrauchbar: dann darf das Menü den
// Trigger-Block überlappen und das ganze sichtbare Band nutzen (bleibt scrollbar).
const SLASH_MIN_H = 140;

// Sichtbares Band in Client-Koordinaten (dieselbe Bezugsebene wie
// `getBoundingClientRect`). Auf Mobile ist das der `visualViewport`: die
// Bildschirmtastatur schrumpft ihn (und kann ihn verschieben), während
// `window.innerHeight` unverändert bleibt — würde man danach positionieren,
// landet das Menü hinter der Tastatur.
function visibleBand() {
  const vv = window.visualViewport;
  return {
    top: vv ? vv.offsetTop : 0,
    left: vv ? vv.offsetLeft : 0,
    height: vv ? vv.height : window.innerHeight,
    width: vv ? vv.width : window.innerWidth,
  };
}

export const slashMethods = {
  // Neu messen, sobald der DOM den aktuellen Stand zeigt. Bewusst per
  // `requestAnimationFrame` und nicht per `$nextTick`: die Trefferliste ist ein
  // verschachtelter `x-for` mit eigenem `x-show` je Gruppen-Header — dessen
  // Effekte laufen erst im Flush NACH dem äusseren Tick, ein einzelnes
  // `$nextTick` misst also eine veraltete Höhe. Vor dem nächsten Frame sind alle
  // Microtasks durch.
  _schedSlashPosition() {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => this._updateSlashPosition());
    } else {
      this._updateSlashPosition();
    }
  },

  // Positioniert das (nach <body> teleportierte) Menü am Trigger-Block.
  // Vorzugsrichtung bleibt oberhalb (näher am Caret in langen Texten, springt
  // nicht unter den Fold); reicht der Platz dort nicht, klappt es nach unten.
  // Die eigene Höhe wird gemessen, nicht geschätzt — sie hängt an der
  // gefilterten Trefferliste und am gedeckelten `max-height`.
  _updateSlashPosition() {
    if (!this.slashShow || !this._slashBlock || !this._slashBlock.isConnected) return;
    const rect = this._slashBlock.getBoundingClientRect();
    const band = visibleBand();
    // Block komplett ausserhalb des sichtbaren Bandes → schliessen.
    if (rect.bottom < band.top || rect.top > band.top + band.height) {
      this._closeSlash();
      return;
    }
    const above = rect.top - band.top - SLASH_GAP;
    const below = (band.top + band.height) - rect.bottom - SLASH_GAP;
    // Höhe deckeln, damit das Menü in sein Fach passt statt aus dem Band zu
    // ragen — mit offener Tastatur bleiben oft weniger als 360 px übrig.
    const avail = Math.min(
      SLASH_MAX_H,
      Math.max(above, below, Math.min(SLASH_MIN_H, band.height - 2 * SLASH_GAP)),
    );
    this.slashMaxH = avail;

    const menu = this.$refs?.slashMenu;
    // `max-height` vor dem Messen anwenden (Alpine schreibt denselben Wert im
    // nächsten Tick via `:style`); versteckt/ungerendert → Deckel als Schätzung.
    if (menu) menu.style.maxHeight = avail + 'px';
    const h = menu?.offsetHeight || avail;
    const w = menu?.offsetWidth || 240;

    const top = (h <= above || above >= below)
      ? rect.top - h - SLASH_GAP
      : rect.bottom + SLASH_GAP;
    this.slashY = Math.max(
      band.top + SLASH_GAP,
      Math.min(top, band.top + band.height - h - SLASH_GAP),
    );
    this.slashX = Math.max(
      band.left + SLASH_GAP,
      Math.min(rect.left, band.left + band.width - w - SLASH_GAP),
    );
  },

  // ── Slash-Menü ────────────────────────────────────────────────────────
  // Labels werden einmalig beim Öffnen aufgelöst (`_slashLabels`, gesetzt in
  // `_openSlashAt`) statt bei jedem Keystroke 14× `t()` aufzurufen.
  // `_buildSlashLabels` ist der Fallback, falls `slashItems` vor dem Öffnen
  // läuft (defensiv) – kein Getter im Data-Spread, sonst würde `this.t` zu
  // früh auf den Methoden selbst aufgerufen.
  _buildSlashLabels() {
    const app = window.__app;
    // Alles, was sich pro Eintrag nicht mit der Query ändert, wird hier einmal
    // beim Öffnen aufgelöst (Label, Gruppen-Label, Modifier-Klasse, Stempel).
    // Das Template liest dann nur noch Properties – keine `t()`-/Funktions-
    // Aufrufe pro Eintrag und Render, die beim Tippen reaktiv neu liefen.
    return SLASH_ITEMS.map(it => ({
      key: it.key,
      group: it.group,
      groupLabel: app?.t('editor.slash.group.' + it.group) || it.group,
      label: app?.t('editor.slash.' + it.key) || it.key,
      modClass: 'edit-slash-item--' + it.key,
      // Datums-/Zeit-Items zeigen den tatsächlich einzufügenden Wert als
      // Sekundär-Text (beim Öffnen aufgelöst; `_applySlashItem` rechnet beim
      // Einfügen ohnehin frisch).
      preview: it.insertText ? _formatStamp(it.insertText) : '',
    }));
  },
  // Filter: Substring-Match (case-insensitive) auf Label + Key, damit sowohl
  // DE-Labels („Über") als auch interne Keys („h2") tippbar sind. Ergebnis
  // wird pro Query gecacht – Template ruft `slashItems()` zweimal pro Render
  // (x-for + Leer-Check), der zweite Aufruf trifft den Cache statt neu zu
  // filtern.
  slashItems() {
    const q = (this.slashQuery || '').trim().toLowerCase();
    if (this._slashFilterCache && this._slashFilterCache.q === q) {
      return this._slashFilterCache.r;
    }
    const items = this._slashLabels || this._buildSlashLabels();
    const filtered = !q ? items : items.filter(it =>
      it.label.toLowerCase().includes(q) || it.key.toLowerCase().includes(q));
    // `showGroup`: erstes Item seiner Gruppe in der gefilterten Liste → der
    // Gruppen-Header wird gerendert. Einmal pro Query berechnet, damit das
    // Template beim Tippen nicht pro Eintrag erneut `slashItems()` aufruft.
    let prevGroup = null;
    const r = filtered.map(it => {
      const showGroup = it.group !== prevGroup;
      prevGroup = it.group;
      return { ...it, showGroup };
    });
    this._slashFilterCache = { q, r };
    return r;
  },

  _openSlashAt(block) {
    this._slashBlock = block;
    this.slashIdx = 0;
    this.slashQuery = '';
    // Labels einmalig in der aktuellen Sprache auflösen; Filter-Cache leeren.
    this._slashLabels = this._buildSlashLabels();
    this._slashFilterCache = null;
    // Beim Öffnen ist das Menü noch `display:none` → keine messbare Höhe.
    // Mit dem Deckel als Schätzung vorpositionieren, damit kein Frame an alter
    // Stelle sichtbar wird, und im nächsten Tick auf die echte Höhe nachziehen.
    const rect = block.getBoundingClientRect();
    const band = visibleBand();
    this.slashMaxH = SLASH_MAX_H;
    this.slashX = rect.left;
    this.slashY = Math.max(band.top + SLASH_GAP, rect.top - SLASH_MAX_H - SLASH_GAP);
    this.slashShow = true;
    this._schedSlashPosition();
  },

  // Bild-Upload: Datei-Dialog → Upload → <figure>-Insert. Der Trigger-Block
  // wird vor dem async Upload gesichert; ist er beim Zurueckkommen weg (User hat
  // weitergetippt), haengen wir das Bild ans Editor-Ende.
  async _slashInsertImage(block) {
    const app = window.__app;
    const pageId = app?.currentPage?.id;
    if (!pageId) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp,image/gif';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      input.remove();
      if (!file) return;
      let result;
      try {
        result = await contentRepo.uploadPageImage(pageId, file);
      } catch {
        app?._showJobToast?.({
          message: app?.t?.('editor.image.uploadError') || 'Bild-Upload fehlgeschlagen',
          severity: 'err', jobType: 'image', bookId: null,
        });
        return;
      }
      this._insertImageFigure(block, result);
    }, { once: true });
    input.click();
  },

  _insertImageFigure(block, result) {
    const editEl = getEditEl();
    if (!editEl || !result?.url) return;
    const fig = document.createElement('figure');
    const img = document.createElement('img');
    img.src = result.url;
    img.alt = '';
    const cap = document.createElement('figcaption');
    cap.appendChild(document.createElement('br'));
    fig.appendChild(img);
    fig.appendChild(cap);
    if (block && block.isConnected && block.parentNode && editEl.contains(block)) {
      block.parentNode.replaceChild(fig, block);
    } else {
      editEl.appendChild(fig);
    }
    placeCaretIn(cap);
    window.__app?._markEditDirty?.();
  },

  _closeSlash() {
    this.slashShow = false;
    this.slashQuery = '';
    this._slashBlock = null;
    this._slashLabels = null;
    this._slashFilterCache = null;
    getEditEl()?.focus();
  },

  _applySlashByKey(key) {
    const item = SLASH_ITEMS.find(i => i.key === key);
    if (item) this._applySlashItem(item);
  },

  _applySlashItem(item) {
    const editEl = getEditEl();
    const block = this._slashBlock;
    if (!editEl || !block || !block.parentNode) { this._closeSlash(); return; }

    // Bild: oeffnet den Datei-Dialog. Async → Block vor dem Schliessen sichern,
    // Menue sofort schliessen (der Dialog uebernimmt).
    if (item.upload === 'image') {
      this._slashInsertImage(block);
      this._closeSlash();
      return;
    }

    // Diagramm: oeffnet den Quelltext-Dialog. Wie beim Bild uebernimmt der
    // Dialog — der leere Trigger-Block wird erst beim Bestaetigen ersetzt.
    if (item.diagram) {
      this.openDiagramDialog(block);
      this._closeSlash();
      return;
    }

    // Datums-/Zeit-Stempel: ersetzt den (per Trigger leeren) Block durch
    // einen <p> mit dem formatierten Stempel-String. Caret hinter den Text,
    // damit der User direkt weiterschreiben kann.
    if (item.insertText) {
      const stamp = _formatStamp(item.insertText);
      const p = document.createElement('p');
      p.textContent = stamp;
      block.parentNode.replaceChild(p, block);
      const sel = document.getSelection();
      if (sel) {
        const range = document.createRange();
        range.selectNodeContents(p);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      window.__app?._markEditDirty?.();
      this._closeSlash();
      return;
    }

    let replacement;
    let caretTarget;

    if (item.tag === 'hr') {
      replacement = document.createElement('hr');
      if (item.className) replacement.className = item.className;
      block.parentNode.replaceChild(replacement, block);
      const next = document.createElement('p');
      next.appendChild(document.createElement('br'));
      replacement.insertAdjacentElement('afterend', next);
      caretTarget = next;
    } else if (item.todoList) {
      // Struktur kommt aus der Markup-SSoT editor/shared/todo-html.js.
      const todo = createTodoList();
      replacement = todo.list;
      block.parentNode.replaceChild(replacement, block);
      caretTarget = todo.text;
    } else if (item.list) {
      replacement = document.createElement(item.tag);
      const li = document.createElement('li');
      li.appendChild(document.createElement('br'));
      replacement.appendChild(li);
      block.parentNode.replaceChild(replacement, block);
      caretTarget = li;
    } else if (item.wrapP) {
      // blockquote / .poem → enthält ein <p> als Schreibfläche.
      replacement = document.createElement(item.tag);
      if (item.className) replacement.className = item.className;
      const p = document.createElement('p');
      p.innerHTML = '<br>';
      replacement.appendChild(p);
      block.parentNode.replaceChild(replacement, block);
      caretTarget = p;
    } else {
      // Einfacher Tag-Swap (p, h2, h3).
      replacement = document.createElement(item.tag);
      replacement.innerHTML = '<br>';
      block.parentNode.replaceChild(replacement, block);
      caretTarget = replacement;
    }

    placeCaretIn(caretTarget);
    window.__app?._markEditDirty?.();
    this._closeSlash();
  },
};
