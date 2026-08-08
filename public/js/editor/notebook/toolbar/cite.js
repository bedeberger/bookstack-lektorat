// Quelle einfügen und bearbeiten (Notebook-Editor). Inline am Caret, nicht als
// Block — darum bewusst KEIN Slash-Menü-Eintrag: das Slash-Menü triggert auf
// einem leeren Block und *ersetzt* ihn (siehe slash.js), eine Quellenangabe
// gehört aber mitten in den fertigen Satz. Vorbild ist deshalb der Link-Input in
// bubble.js: Range sichern → kleines Panel → an der gesicherten Range einfügen.
//
// DREI EINSTIEGE, EIN PANEL:
//   • Button in der Seiten-Toolbar (editor-page-toolbar.html) — der Weg für den
//     laufenden Satz, ohne vorher etwas markieren zu müssen. Kommt über
//     EVT.EDITOR_CITE_OPEN, weil der Auslöser im Root-Scope sitzt und der Picker
//     in `editorToolbarCard`.
//   • Button in der Bubble-Toolbar — wenn eine Textstelle markiert ist.
//   • Klick auf einen bestehenden Chip → `openCiteForChip` (Quelle wechseln,
//     Stelle korrigieren, Zitat-Art ändern, Beleg entfernen). Pendant zum
//     Link-Input, der einen bestehenden `<a>` vorbefüllt.
//
// EINE SELEKTION WIRD NIE ERSETZT: der Beleg gehört HINTER die belegte Stelle,
// nicht an ihre Stelle (siehe `_commitCite`). Wer „Kafka schrieb X" markiert und
// belegt, will den Satz behalten.
//
// Der eingefügte Chip trägt seinen Kurzbeleg als Text (Cache) und `data-src`
// als Wahrheit — Markup-SSoT ist public/js/sources/cite-html.js.
//
// DREI ZITAT-ARTEN (`citeKind`), wie sie das wissenschaftliche Schreiben
// unterscheidet. Die Auswahl im Panel ist UI-Zustand; im Markup landen davon nur
// zwei Attribute (siehe Modulkopf von cite-html.js):
//
//   'quote'       Kurzzitat/Belegstelle — Chip am Caret, kein Präfix.
//   'paraphrase'  Chip am Caret mit `data-mode="paraphrase"` → „vgl."/„cf.".
//   'block'       Blockzitat — der umgebende Absatz wird zum `<blockquote>` mit
//                 `data-src`, der Chip landet am Ende des Blocks. Nur dieser
//                 Fall ändert Blockstruktur, und nur er trägt zum Zitat-Anteil
//                 bei (der Fund-Index zählt die Zeichen des Blocks).
//
// Nur Notebook: Focus-Editor und Bucheditor stellen Chips dar und zerstören
// sie nicht, bringen aber keinen Einfügepfad mit.

import { getEditEl, findBlock, caretRangeIn, rangeAtEnd } from './_shared.js';
import {
  appendHtmlInto, capHits, cycleIdx, htmlToElement, insertHtmlAtRange, NBSP,
  onPickerKeydown, panelAnchorFor, placeCaretAfter,
} from './caret-panel.js';
import {
  buildCiteHtml, markCitesAtomic, closestQuoteBlock, setQuoteBlockSource,
  citeModeOf, isQuoteBlockEl, CITE_ATTR_SRC, CITE_ATTR_LOC,
} from '../../../sources/cite-html.js';
import { formatShort } from '../../../sources/format.js';
// Suchfelder und Anzeigezeile sind SSoT in sources/search.js — hier lagen sie
// als Kopie mit abweichender Feldliste (ohne Verlagsort), sodass dieselbe Suche
// im Picker weniger fand als in der Quellen-Karte.
import { filterSources, sourceLine } from '../../../sources/search.js';
import { loadBookSources } from '../../../sources/source-cache.js';

// Nur ein normaler Absatz lässt sich zu einem Blockzitat umhüllen. Überschrift,
// Listenpunkt, Codeblock und Gedicht (`div.poem`) sind keine Zitatabsätze — dort
// bleibt die Blockzitat-Option gesperrt statt die Struktur zu verbiegen. Darum
// bewusst NICHT `DIV`: der einzige `div`, den der Editor als Block schreibt, ist
// das Gedicht.
const WRAPPABLE_TAGS = new Set(['P']);

// Deckel der Trefferliste: mehr als 40 Zeilen scannt niemand, und der Picker
// soll bei dreistelligen Literaturverzeichnissen nicht zur Endlosliste werden.
const CITE_MAX_HITS = 40;

export const citeMethods = {
  // Panel am Caret (oder an der Selektion) öffnen: Range sichern,
  // positionieren, Quellen laden.
  async openCiteInput() {
    const app = window.__app;
    if (!app?.editMode || app.focusActive) return;
    const editEl = getEditEl();
    if (!editEl) return;
    // Der Auslöser kann ein Button in der Seiten-Toolbar sein — dann liegt der
    // Fokus dort und nicht im contenteditable. Erst fokussieren, dann die
    // Selection lesen (Chromium stellt dabei die letzte Caret-Position wieder
    // her); gleiche Reihenfolge wie `insertHorizontalRule`. Die Bubble-Toolbar
    // verliert den Fokus nie (`@mousedown.prevent`), dort ist es ein No-Op.
    editEl.focus();
    // Kein Caret im Editor (Edit-Modus gerade betreten, noch nirgends
    // hingeklickt): ans Ende des Inhalts ankern statt gar nichts zu tun.
    const range = caretRangeIn(editEl) || rangeAtEnd(editEl);

    this._citeRange = range.cloneRange();
    this._citeEditEl = null;
    this.citeEditing = false;
    this._resetCiteFields();
    // Blockzitat nur anbieten, wo es strukturell geht: Caret schon in einem
    // <blockquote> (bekommt nur den Zeiger) oder in einem umhüllbaren Absatz.
    const caretBlock = findBlock(this._citeRange.startContainer, editEl);
    this.citeBlockOk = !!(
      closestQuoteBlock(this._citeRange.startContainer, editEl)
      || (caretBlock && WRAPPABLE_TAGS.has(String(caretBlock.tagName || '').toUpperCase()))
    );
    this._placeCitePanel(this._citeRange, editEl);
    this.bubbleShow = false;
    this.citeShow = true;

    await this._fillCiteSources();
    this._focusCiteFilter();
  },

  // Bestehenden Chip bearbeiten (Klick-Handler in cards/editor-toolbar-card.js).
  // Die Range umfasst den Chip selbst — der Commit-Pfad ersetzt genau ihn.
  async openCiteForChip(chip) {
    const app = window.__app;
    if (!app?.editMode || app.focusActive) return;
    const editEl = getEditEl();
    if (!editEl || !chip || !editEl.contains(chip)) return;
    const doc = editEl.ownerDocument || document;

    const range = doc.createRange();
    range.selectNode(chip);
    this._citeRange = range;
    this._citeEditEl = chip;
    this.citeEditing = true;
    this._resetCiteFields();
    this.citeLoc = chip.getAttribute(CITE_ATTR_LOC) || '';

    // Zitat-Art aus dem Markup zurücklesen. Ein Chip in einem Blockzitat, das
    // auf DIESELBE Quelle zeigt, ist der Blockzitat-Fall; zeigt der Absatz
    // woanders hin (oder nirgendwohin), ist der Chip ein eigener Nachweis.
    const bq = closestQuoteBlock(chip, editEl);
    const blockCited = !!bq && isQuoteBlockEl(bq)
      && bq.getAttribute(CITE_ATTR_SRC) === chip.getAttribute(CITE_ATTR_SRC);
    this.citeKind = blockCited ? 'block'
      : (citeModeOf(chip) === 'paraphrase' ? 'paraphrase' : 'quote');
    const chipBlock = findBlock(chip, editEl);
    this.citeBlockOk = !!(
      bq || (chipBlock && WRAPPABLE_TAGS.has(String(chipBlock.tagName || '').toUpperCase()))
    );

    this._placeCitePanel(range, editEl);
    this.bubbleShow = false;
    this.citeShow = true;

    await this._fillCiteSources();
    this._focusCiteFilter();
  },

  // Panel über der Range verankern (Geometrie in caret-panel.js).
  _placeCitePanel(range, editEl) {
    const { x, y } = panelAnchorFor(range, editEl);
    this.citeX = x;
    this.citeY = y;
  },

  // Eingabefelder/Auswahl in den Ausgangszustand. Die Zitat-Art wird bewusst
  // bei jedem Öffnen zurückgesetzt: „vgl." darf nicht aus dem vorigen Beleg
  // hängen bleiben — das Präfix ist eine inhaltliche Aussage.
  _resetCiteFields() {
    this.citeQuery = '';
    this.citeLoc = '';
    this.citeIdx = 0;
    this.citeError = false;
    this.citeKind = 'quote';
  },

  async _fillCiteSources() {
    const bookId = window.Alpine?.store('nav')?.selectedBookId;
    if (!bookId) { this.citeSources = []; this.citeHits = []; return; }
    this.citeLoading = true;
    try {
      this.citeSources = await loadBookSources(bookId);
    } catch (_) {
      this.citeSources = [];
      this.citeError = true;
    } finally {
      this.citeLoading = false;
      this._recomputeCiteHits();
    }
  },

  _focusCiteFilter() {
    this.$nextTick(() => {
      const inp = this.$refs?.citeFilter;
      if (inp) inp.focus();
    });
  },

  // Trefferliste neu berechnen. Ergebnis liegt in `citeHits` (deklarierter
  // State), nicht als Methode im Template: das Panel liest die Liste an drei
  // Stellen (x-for + zwei Leer-Zustände), eine Methode würde pro Render dreimal
  // filtern und formatieren. Aufrufer: nach dem Laden der Quellen und der
  // $watch auf `citeQuery` in cards/editor-toolbar-card.js.
  _recomputeCiteHits() {
    const q = (this.citeQuery || '').trim();
    let hits = filterSources(this.citeSources || [], q);
    // Beim Bearbeiten eines Chips steht die aktuell verknüpfte Quelle ohne
    // Suchbegriff vorne — sonst liegt sie bei dreistelligen Bibliotheken hinter
    // dem CITE_MAX_HITS-Deckel und Enter träfe eine fremde Quelle. Mit
    // Suchbegriff gilt die Suche: dann WILL der User wechseln.
    if (!q && this._citeEditEl) {
      const editId = Number(this._citeEditEl.getAttribute(CITE_ATTR_SRC));
      const cur = hits.find(s => s.id === editId);
      if (cur) hits = [cur, ...hits.filter(s => s !== cur)];
    }
    this.citeHits = capHits(hits, CITE_MAX_HITS).map(s => ({ id: s.id, label: sourceLine(s), src: s }));
    if (this.citeIdx >= this.citeHits.length) this.citeIdx = 0;
  },

  citeMove(delta) {
    if (!this.citeHits.length) return;
    this.citeIdx = cycleIdx(this.citeIdx, delta, this.citeHits.length);
  },

  _onCiteKeydown(e) {
    onPickerKeydown(e, {
      onClose: () => this._closeCite(),
      onMove: (d) => this.citeMove(d),
      onEnter: () => {
        const hit = this.citeHits[this.citeIdx];
        if (hit) this._commitCite(hit.src);
      },
    });
  },

  // Chip an der gesicherten Range einfügen.
  //
  // `num` bleibt null: die Nummer im numerischen Stil kommt aus der
  // Erstzitat-Reihenfolge des Fund-Index, der erst beim Speichern neu gebaut
  // wird. formatShort fällt darum bewusst auf die Autor-Jahr-Form zurück; der
  // Render-Pfad stellt den Text beim Export richtig (der Chip-Text ist
  // Cache, `data-src` ist die Wahrheit).
  //
  // Aus demselben Grund kein `suffix`: der Jahres-Buchstabe („Müller, 2020a")
  // hängt an ALLEN Quellen des Buchs, nicht an der einen hier ausgewählten
  // (public/js/sources/format/sort.js#assignYearSuffixes). Er entsteht im
  // Render-Pfad, wo diese Menge vorliegt.
  _commitCite(source) {
    const editEl = getEditEl();
    const range = this._citeRange;
    if (!editEl || !range || !source?.id) { this._closeCite(); return; }
    // Gesperrte Blockzitat-Option (Caret in Liste/Überschrift) fällt auf das
    // Kurzzitat zurück — der Beleg soll nie ganz ausfallen.
    let kind = this.citeKind || 'quote';
    if (kind === 'block' && !this.citeBlockOk) kind = 'quote';

    const app = window.__app;
    const mode = kind === 'paraphrase' ? 'paraphrase' : 'quote';
    const text = formatShort(source, {
      style: app?.citationStyleForCurrentBook || 'apa7',
      lang: app?.citationLangForCurrentBook || 'de',
      loc: this.citeLoc || '',
      num: null,
      mode,
    });
    const html = buildCiteHtml({ id: source.id, loc: this.citeLoc || '', text, mode });
    if (!html) { this._closeCite(); return; }

    editEl.focus();

    // Bestehenden Chip bearbeiten statt einen zweiten daneben setzen.
    if (this._citeEditEl) {
      this._commitCiteEdit(editEl, this._citeEditEl, source, kind, html);
      window.__app?._markEditDirty?.();
      this._closeCite();
      return;
    }

    if (kind === 'block') {
      this._commitCiteAsBlock(editEl, range, source, html);
      window.__app?._markEditDirty?.();
      this._closeCite();
      return;
    }

    // Eine Selektion wird NICHT gelöscht, sondern am Ende verlassen (darum kein
    // `replaceContents`): der Beleg weist die markierte Stelle NACH, er ersetzt
    // sie nicht. Anders als beim Link, wo die Selektion der Linktext ist.
    // Trennzeichen (NBSP, siehe caret-panel.js) und Caret dahinter besorgt der
    // Helfer.
    insertHtmlAtRange(range, html, { after: NBSP });

    // Der eingefügte Chip ist noch nicht atomar (markCitesAtomic läuft sonst nur
    // beim Mount). Direkt hier nachziehen, sonst tippt der User in die frisch
    // eingefügte Quelle hinein statt dahinter. Idempotent — schon markierte
    // Chips bleiben unverändert.
    markCitesAtomic(editEl);

    window.__app?._markEditDirty?.();
    this._closeCite();
  },

  // Blockzitat: den Absatz am Caret zum belegten `<blockquote>` machen und den
  // Kurzbeleg an sein Ende setzen.
  //
  // Umhüllen passiert über DOM-Knoten, NICHT über execCommand('formatBlock'):
  // Chromium bäckt dort die berechneten CSS-Werte der Zitatklasse als
  // Inline-`style` ein (dieselbe Eigenheit wie beim Chip-Insert, siehe unten) —
  // das verstösst gegen „Styles nur in public/css" und ist im Dark-Mode falsch.
  //
  // Der Beleg steht am ENDE des Blocks, nicht am Caret: beim Blockzitat weist der
  // Kurzbeleg das ganze Zitat nach, nicht die Stelle, an der der Cursor gerade
  // stand. Ein bereits belegtes Blockzitat bekommt den neuen Zeiger — ein Absatz
  // ist immer nur aus EINER Quelle wörtlich übernommen.
  _commitCiteAsBlock(editEl, range, source, html) {
    const doc = editEl.ownerDocument || document;
    let bq = closestQuoteBlock(range.startContainer, editEl);

    if (!bq) {
      const block = findBlock(range.startContainer, editEl);
      if (!block || !WRAPPABLE_TAGS.has(String(block.tagName || '').toUpperCase())) return;
      bq = doc.createElement('blockquote');
      block.parentNode.insertBefore(bq, block);
      bq.appendChild(block);
    }
    setQuoteBlockSource(bq, source.id);

    // Chip in den letzten Absatz des Zitats, sonst direkt in den blockquote
    // (Blockzitat aus reinem Text ohne <p>-Hülle).
    const lastNode = appendHtmlInto(bq.lastElementChild || bq, html, { before: ' ' });

    markCitesAtomic(editEl);

    if (lastNode) placeCaretAfter(lastNode);
  },

  // Bestehenden Chip auf die neue Auswahl umschreiben. `data-src` ist die
  // Wahrheit, der Text ein Cache — beides wird hier neu gesetzt, statt am alten
  // Knoten Attribute zu flicken (eine Quelle für das Chip-Markup, buildCiteHtml).
  _commitCiteEdit(editEl, chip, source, kind, html) {
    const doc = editEl.ownerDocument || document;
    const oldId = chip.getAttribute(CITE_ATTR_SRC);

    // Zur Blockzitat-Form gewechselt: der Kurzbeleg gehört ans ENDE des Zitats,
    // nicht dorthin, wo der Chip zufällig stand. Also raus damit und denselben
    // Pfad wie beim Einfügen laufen lassen — die Range bleibt beim Entfernen
    // gültig (Browser zieht Live-Ranges mit) und zeigt in den Absatz.
    if (kind === 'block') {
      const range = doc.createRange();
      range.setStartBefore(chip);
      range.collapse(true);
      chip.remove();
      this._commitCiteAsBlock(editEl, range, source, html);
      return;
    }

    const fresh = htmlToElement(html, doc);
    if (!fresh || !chip.parentNode) return;
    chip.parentNode.replaceChild(fresh, chip);

    // Zeigte der umgebende Absatz als Blockzitat auf die ALTE Quelle, folgt sein
    // Zeiger mit: „dieser Absatz ist wörtlich aus Quelle N" und der sichtbare
    // Kurzbeleg darunter dürfen nicht auseinanderlaufen. Zeigt er woanders hin,
    // bleibt er unangetastet — dann sind es zwei getrennte Aussagen.
    const bq = closestQuoteBlock(fresh, editEl);
    if (bq && isQuoteBlockEl(bq) && bq.getAttribute(CITE_ATTR_SRC) === oldId) {
      setQuoteBlockSource(bq, source.id);
    }

    markCitesAtomic(editEl);
    placeCaretAfter(fresh);
  },

  // Beleg entfernen (nur im Bearbeiten-Fall sichtbar).
  _removeCite() {
    const editEl = getEditEl();
    const chip = this._citeEditEl;
    if (!editEl || !chip || !editEl.contains(chip)) { this._closeCite(); return; }
    const doc = editEl.ownerDocument || document;
    const srcId = chip.getAttribute(CITE_ATTR_SRC);
    const bq = closestQuoteBlock(chip, editEl);

    editEl.focus();
    const sel = doc.getSelection();
    if (sel) {
      const at = doc.createRange();
      at.setStartBefore(chip);
      at.collapse(true);
      sel.removeAllRanges();
      sel.addRange(at);
    }
    chip.remove();

    // Der Zeiger am Blockzitat ist derselbe Nachweis in Blockform: zeigt er auf
    // die entfernte Quelle, geht er mit. Sonst zählte der Absatz weiter als
    // wörtliches Zitat aus einer Quelle, die im Text nicht mehr belegt ist (ein
    // belegtes Blockzitat OHNE Chip ist selbst eine Fundstelle, siehe
    // cite-html.js#citationsFromCites). Das `<blockquote>` selbst bleibt stehen —
    // die Einrückung ist eine Formatierung des Autors, kein Nachweis.
    if (bq && isQuoteBlockEl(bq) && bq.getAttribute(CITE_ATTR_SRC) === srcId) {
      setQuoteBlockSource(bq, null);
    }

    window.__app?._markEditDirty?.();
    this._closeCite();
  },

  /**
   * O-TON EINFÜGEN — ein Redebeitrag aus einem Interview-Transkript wird zum
   * belegten Blockzitat im Artikel.
   *
   * Bewusst KEIN eigener Markup-Weg: es entsteht dasselbe
   * `<blockquote data-src>` + `span.cite`, das auch der Quellen-Picker erzeugt.
   * Dadurch trägt der O-Ton ohne Zutun bis ins Quellenverzeichnis, in den
   * Anmerkungsapparat, in die Zitat-Anteil-Kennzahl und in jeden Exportweg —
   * und die Warnung bei fehlender Zitatautorisierung (`oton_auth`) greift
   * überall dort, wo sie auch für jede andere Quelle greift.
   *
   * Die Stellenangabe ist die ZEITMARKE. Bei einem Gespräch ist sie das, was die
   * Seitenzahl bei einem Buch ist: sie führt zur Stelle in der Aufnahme zurück.
   *
   * Einfügeort ist der zuletzt gesetzte Caret; ohne Caret hängt der O-Ton ans
   * Ende des Editorfelds. Bewusst kein Abbruch in dem Fall — den Block danach zu
   * verschieben ist ein Handgriff, ihn erneut herauszusuchen nicht.
   *
   * @returns {boolean} ob eingefügt wurde
   */
  insertOTonBlock({ source, text, loc = '' } = {}) {
    const editEl = getEditEl();
    const quote = String(text || '').trim();
    if (!editEl || !source?.id || !quote) return false;

    const app = window.__app;
    const doc = editEl.ownerDocument || document;
    const shortText = formatShort(source, {
      style: app?.citationStyleForCurrentBook || 'apa7',
      lang: app?.citationLangForCurrentBook || 'de',
      loc,
      num: null,
      mode: 'quote',
    });
    const chipHtml = buildCiteHtml({ id: source.id, loc, text: shortText, mode: 'quote' });
    if (!chipHtml) return false;

    // Der Zitattext geht als TEXTKNOTEN in den Absatz, nie als HTML-String:
    // er stammt aus einer Transkription und darf nie als Markup gedeutet werden.
    const bq = doc.createElement('blockquote');
    const p = doc.createElement('p');
    p.appendChild(doc.createTextNode(quote + ' '));
    bq.appendChild(p);
    setQuoteBlockSource(bq, source.id);
    // Kein Caret hier (appendHtmlInto setzt keinen): der Block hängt noch nicht
    // im Dokument, ein Caret zeigte auf einen abgehängten Knoten.
    appendHtmlInto(p, chipHtml);

    editEl.focus();
    const range = caretRangeIn(editEl);
    const anchor = range ? findBlock(range.startContainer, editEl) : null;
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(bq, anchor.nextSibling);
    else editEl.appendChild(bq);

    markCitesAtomic(editEl);
    placeCaretAfter(bq);
    // Ohne das greift der Autosave nicht — der Block wäre beim Verlassen weg.
    window.__app?._markEditDirty?.();
    return true;
  },

  _closeCite() {
    this.citeShow = false;
    this.citeQuery = '';
    this.citeLoc = '';
    this.citeIdx = 0;
    this.citeHits = [];
    this.citeError = false;
    this.citeKind = 'quote';
    this.citeBlockOk = false;
    this.citeEditing = false;
    this._citeEditEl = null;
    this._citeRange = null;
    getEditEl()?.focus();
  },
};
