// Quelle einfügen (Notebook-Editor). Inline am Caret, nicht als Block —
// darum bewusst KEIN Slash-Menü-Eintrag: das Slash-Menü triggert auf einem
// leeren Block und *ersetzt* ihn (siehe slash.js), eine Quellenangabe gehört
// aber mitten in den fertigen Satz. Vorbild ist deshalb der Link-Input in
// bubble.js: Range sichern → kleines Panel → an der gesicherten Range einfügen.
//
// Der eingefügte Chip trägt seinen Kurzbeleg als Text (Cache) und `data-src`
// als Wahrheit — Markup-SSoT ist public/js/sources/cite-html.js.
//
// Nur Notebook: Focus-Editor und Bucheditor stellen Chips dar und zerstören
// sie nicht, bringen aber keinen Einfügepfad mit.

import { getEditEl, findBlock } from './_shared.js';
import { buildCiteHtml, markCitesAtomic } from '../../../sources/cite-html.js';
import { formatShort } from '../../../sources/format.js';

// Deckel der Trefferliste: mehr als 40 Zeilen scannt niemand, und der Picker
// soll bei dreistelligen Literaturverzeichnissen nicht zur Endlosliste werden.
const CITE_MAX_HITS = 40;

// Quellenliste je Buch nur einmal holen. Sie ändert sich nur über die
// Quellen-Karte; die dispatcht `sources:changed`, was den Cache verwirft.
const _sourceCache = new Map();

export function invalidateSourceCache(bookId = null) {
  if (bookId == null) _sourceCache.clear();
  else _sourceCache.delete(String(bookId));
}

async function loadSources(bookId) {
  const key = String(bookId);
  if (_sourceCache.has(key)) return _sourceCache.get(key);
  const res = await fetch(`/sources?book_id=${encodeURIComponent(key)}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const list = await res.json();
  const arr = Array.isArray(list) ? list : [];
  _sourceCache.set(key, arr);
  return arr;
}

// Anzeigezeile im Picker: „Kafka, Franz — Die Verwandlung (1915)".
function pickerLabel(s) {
  const persons = [...(s.authors || []), ...(s.editors || [])];
  const first = persons[0];
  const who = first ? (first.literal || [first.family, first.given].filter(Boolean).join(', ')) : '';
  const parts = [who, s.title].filter(Boolean).join(' — ');
  return s.year ? `${parts} (${s.year})` : parts;
}

function haystack(s) {
  const persons = [...(s.authors || []), ...(s.editors || [])]
    .map(p => `${p.family || ''} ${p.given || ''} ${p.literal || ''}`).join(' ');
  return [s.title, s.container_title, s.publisher, s.year, s.citekey, persons]
    .filter(Boolean).join(' ').toLowerCase();
}

export const citeMethods = {
  // Panel öffnen: Caret-Range sichern, positionieren, Quellen laden.
  async openCiteInput() {
    const app = window.__app;
    if (!app?.editMode || app.focusActive) return;
    const editEl = getEditEl();
    if (!editEl) return;
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!editEl.contains(range.commonAncestorContainer) && editEl !== range.commonAncestorContainer) return;

    this._citeRange = range.cloneRange();

    let rect = this._citeRange.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      const block = findBlock(this._citeRange.startContainer, editEl) || editEl;
      rect = block.getBoundingClientRect();
    }
    this.citeX = rect.left + rect.width / 2;
    this.citeY = rect.top;

    this.citeQuery = '';
    this.citeLoc = '';
    this.citeIdx = 0;
    this.citeError = false;
    this.bubbleShow = false;
    this.citeShow = true;

    const bookId = window.Alpine?.store('nav')?.selectedBookId;
    if (!bookId) { this.citeSources = []; this.citeHits = []; return; }
    this.citeLoading = true;
    try {
      this.citeSources = await loadSources(bookId);
    } catch (_) {
      this.citeSources = [];
      this.citeError = true;
    } finally {
      this.citeLoading = false;
      this._recomputeCiteHits();
    }
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
    const q = (this.citeQuery || '').trim().toLowerCase();
    const list = this.citeSources || [];
    const hits = q ? list.filter(s => haystack(s).includes(q)) : list;
    this.citeHits = hits.slice(0, CITE_MAX_HITS).map(s => ({ id: s.id, label: pickerLabel(s), src: s }));
    if (this.citeIdx >= this.citeHits.length) this.citeIdx = 0;
  },

  citeMove(delta) {
    const n = this.citeHits.length;
    if (!n) return;
    this.citeIdx = (this.citeIdx + delta + n) % n;
  },

  _onCiteKeydown(e) {
    if (e.key === 'Escape')    { e.preventDefault(); this._closeCite(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); this.citeMove(1); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); this.citeMove(-1); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const hit = this.citeHits[this.citeIdx];
      if (hit) this._commitCite(hit.src);
    }
  },

  // Chip an der gesicherten Range einfügen.
  //
  // `num` bleibt null: die Nummer im numerischen Stil kommt aus der
  // Erstzitat-Reihenfolge des Fund-Index, der erst beim Speichern neu gebaut
  // wird. formatShort fällt darum bewusst auf die Autor-Jahr-Form zurück; der
  // Regenerierungs-Pass stellt den Text später richtig (der Chip-Text ist
  // Cache, `data-src` ist die Wahrheit).
  _commitCite(source) {
    const editEl = getEditEl();
    const range = this._citeRange;
    if (!editEl || !range || !source?.id) { this._closeCite(); return; }

    const app = window.__app;
    const text = formatShort(source, {
      style: app?.citationStyleForCurrentBook || 'apa7',
      lang: app?.citationLangForCurrentBook || 'de',
      loc: this.citeLoc || '',
      num: null,
    });
    const html = buildCiteHtml({ id: source.id, loc: this.citeLoc || '', text });
    if (!html) { this._closeCite(); return; }

    editEl.focus();

    // Einfügen über die Range-API, NICHT über execCommand('insertHTML'):
    // Chromium schleust den Fragment-String durch seinen Editing-Sanitizer, der
    // `class`/`data-*` verwirft und die berechneten CSS-Werte der Klasse als
    // Inline-`style` einbäckt. Aus dem Chip würde
    // `<span style="color: rgb(...); white-space: nowrap">` — Zeiger weg, dazu
    // ein `style`-Attribut, das gegen „Styles nur in public/css" verstösst und
    // im Dark-Mode falsch ist. Dieselbe Chromium-Eigenheit steckt hinter der
    // Blockgrenzen-Löschbehandlung (siehe docs/notebook-editor.md, Inv. 17+18).
    const doc = editEl.ownerDocument || document;
    const holder = doc.createElement('div');
    holder.innerHTML = `${html} `;
    const frag = doc.createDocumentFragment();
    while (holder.firstChild) frag.appendChild(holder.firstChild);
    const lastNode = frag.lastChild;

    range.deleteContents();
    range.insertNode(frag);

    // Der eingefügte Chip ist noch nicht atomar (markCitesAtomic läuft sonst nur
    // beim Mount). Direkt hier nachziehen, sonst tippt der User in die frisch
    // eingefügte Quelle hinein statt dahinter. Idempotent — schon markierte
    // Chips bleiben unverändert.
    markCitesAtomic(editEl);

    // Caret hinter die Quelle (hinter das angehängte Trennzeichen), damit der
    // User direkt weiterschreiben kann. Chromium macht aus dem Leerzeichen am
    // Blockende ein `&nbsp;`; steht die Quelle am Absatzende, trimmt der
    // Server-Cleaner es beim Speichern weg (stripBlockEdgeNbsp).
    const sel = doc.getSelection();
    if (sel && lastNode) {
      const after = doc.createRange();
      after.setStartAfter(lastNode);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
    }

    window.__app?._markEditDirty?.();
    this._closeCite();
  },

  _closeCite() {
    this.citeShow = false;
    this.citeQuery = '';
    this.citeLoc = '';
    this.citeIdx = 0;
    this.citeHits = [];
    this.citeError = false;
    this._citeRange = null;
    getEditEl()?.focus();
  },
};
