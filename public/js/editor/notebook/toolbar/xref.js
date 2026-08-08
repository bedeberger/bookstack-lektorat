// Querverweis einfügen (Notebook-Editor). Inline am Caret, nicht als Block —
// darum bewusst KEIN Slash-Menü-Eintrag: das Slash-Menü triggert auf einem
// leeren Block und *ersetzt* ihn (siehe slash.js), ein Querverweis gehört aber
// mitten in den fertigen Satz. Vorbild ist deshalb der Beleg-Picker in cite.js:
// Range sichern → kleines Panel → an der gesicherten Range einfügen.
//
// Der eingefügte Verweis trägt seine Nummer als Text (Cache) und
// `data-xref`/`data-xref-id` als Wahrheit — Markup-SSoT ist
// public/js/xrefs/xref-html.js.
//
// DIE NUMMER IM EDITOR IST EINE VORSCHAU. Sie folgt der nested-arabischen
// Vorgabe (1, 1.1, „Abb. 2.1"). Was im fertigen Dokument steht, entscheidet der
// Ausgabeweg: ein PDF-Profil mit römischer Nummerierung schreibt „Kapitel III",
// eines ohne Nummerierung den Kapiteltitel. Das ist kein Fehler, sondern der
// Kern des Features — lib/xref-render.js setzt den Text bei jedem Export neu.
//
// Nur Notebook: Focus-Editor und Bucheditor stellen Verweise dar und zerstören
// sie nicht, bringen aber keinen Einfügepfad mit.

import { getEditEl, caretRangeIn } from './_shared.js';
import { capHits, cycleIdx, insertHtmlAtRange, onPickerKeydown, panelAnchorFor } from './caret-panel.js';
import { buildXrefHtml, markXrefsAtomic } from '../../../xrefs/xref-html.js';
import { defaultChapterLabels, figureNumbers } from '../../../xrefs/xref-number.js';
import { formatXref } from '../../../xrefs/xref-format.js';

// Deckel der Trefferliste — wie beim Beleg-Picker: mehr als 40 Zeilen scannt
// niemand, und der Picker soll bei langen Büchern nicht zur Endlosliste werden.
const XREF_MAX_HITS = 40;

// Ziele je Buch nur einmal holen. Sie ändern sich beim Umbauen des Buchs oder
// beim Einfügen einer Abbildung; beides dispatcht `xrefs:changed`.
const _targetCache = new Map();

export function invalidateXrefTargetCache(bookId = null) {
  if (bookId == null) _targetCache.clear();
  else _targetCache.delete(String(bookId));
}

async function loadTargets(bookId) {
  const key = String(bookId);
  if (_targetCache.has(key)) return _targetCache.get(key);
  const res = await fetch(`/xrefs/targets?book_id=${encodeURIComponent(key)}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const out = {
    chapters: Array.isArray(data?.chapters) ? data.chapters : [],
    figures: Array.isArray(data?.figures) ? data.figures : [],
  };
  _targetCache.set(key, out);
  return out;
}

// Vorschau-Nummern über beide Achsen — dieselbe pure Logik, die auch der
// Renderer benutzt, nur ohne Profil-Labels.
function previewNumbers({ chapters, figures }) {
  // Tiefe aus der Elternkette (max 3 Ebenen, siehe docs/chapter-hierarchy.md).
  const byId = new Map(chapters.map(c => [String(c.target), c]));
  const shaped = chapters.map((c) => {
    let depth = 1;
    let cur = c;
    const seen = new Set();
    while (cur && cur.parentId != null && !seen.has(cur.target) && depth < 3) {
      seen.add(cur.target);
      cur = byId.get(String(cur.parentId));
      if (!cur) break;
      depth++;
    }
    return { chapterId: c.target, depth, title: c.title };
  });
  const chapterLabels = defaultChapterLabels(shaped);
  const figNums = figureNumbers(
    figures.map(f => ({ bid: f.target, chapterId: f.chapterId })),
    chapterLabels,
  );
  return { chapterLabels, figNums, depthById: new Map(shaped.map(s => [String(s.chapterId), s.depth])) };
}

export const xrefMethods = {
  // Panel öffnen: Caret-Range sichern, positionieren, Ziele laden.
  async openXrefInput() {
    const app = window.__app;
    if (!app?.editMode || app.focusActive) return;
    const editEl = getEditEl();
    if (!editEl) return;
    // Ohne Caret im Edit-Feld kein Verweis: anders als beim Beleg (der auch aus
    // der Seiten-Toolbar kommt und dann ans Ende ankert) hat dieser Picker nur
    // Einstiege AUS dem Text heraus.
    const range = caretRangeIn(editEl);
    if (!range) return;

    this._xrefRange = range.cloneRange();

    const { x, y } = panelAnchorFor(this._xrefRange, editEl);
    this.xrefX = x;
    this.xrefY = y;

    this.xrefQuery = '';
    this.xrefIdx = 0;
    this.xrefFmt = 'label';
    this.xrefError = false;
    this.bubbleShow = false;
    this.xrefShow = true;

    const bookId = window.Alpine?.store('nav')?.selectedBookId;
    if (!bookId) { this.xrefTargets = []; this.xrefHits = []; return; }
    this.xrefLoading = true;
    try {
      const data = await loadTargets(bookId);
      const { chapterLabels, figNums, depthById } = previewNumbers(data);
      // Eine flache Liste in Buch-Leserichtung: erst die Kapitel (mit ihrer
      // Hierarchie-Einrückung), dann die Abbildungen. Beide tragen ihre
      // Vorschau-Nummer schon hier, damit der Picker zeigt, was gleich im Text
      // steht.
      this.xrefTargets = [
        ...data.chapters.map(c => ({
          kind: 'chapter',
          target: c.target,
          title: c.title,
          number: chapterLabels.get(String(c.target)) || null,
          depth: depthById.get(String(c.target)) || 1,
        })),
        ...data.figures.map(f => ({
          kind: 'figure',
          target: f.target,
          title: f.title,
          number: figNums.get(f.target) || null,
          depth: 1,
          pageName: f.pageName,
        })),
      ];
    } catch (_) {
      this.xrefTargets = [];
      this.xrefError = true;
    } finally {
      this.xrefLoading = false;
      this._recomputeXrefHits();
    }
    this.$nextTick(() => {
      const inp = this.$refs?.xrefFilter;
      if (inp) inp.focus();
    });
  },

  // Trefferliste neu berechnen. Ergebnis liegt in `xrefHits` (deklarierter
  // State), nicht als Methode im Template — dieselbe Begründung wie bei
  // `_recomputeCiteHits`: das Panel liest die Liste mehrfach pro Render.
  // Aufrufer: nach dem Laden und der $watch auf `xrefQuery`.
  _recomputeXrefHits() {
    const q = (this.xrefQuery || '').trim().toLowerCase();
    const list = this.xrefTargets || [];
    const hits = q
      ? list.filter(t => `${t.title} ${t.number || ''} ${t.pageName || ''}`.toLowerCase().includes(q))
      : list;
    this.xrefHits = capHits(hits, XREF_MAX_HITS);
    if (this.xrefIdx >= this.xrefHits.length) this.xrefIdx = 0;
  },

  // Vorschautext einer Zeile — genau das, was `_commitXref` einfügen würde.
  xrefPreview(hit) {
    if (!hit) return '';
    const lang = window.__app?.citationLangForCurrentBook || 'de';
    return formatXref({
      kind: hit.kind,
      fmt: this.xrefFmt || 'label',
      entry: { number: hit.number, title: hit.title },
      lang,
    }) || hit.title || '';
  },

  xrefMove(delta) {
    if (!this.xrefHits.length) return;
    this.xrefIdx = cycleIdx(this.xrefIdx, delta, this.xrefHits.length);
  },

  _onXrefKeydown(e) {
    onPickerKeydown(e, {
      onClose: () => this._closeXref(),
      onMove: (d) => this.xrefMove(d),
      onEnter: () => {
        const hit = this.xrefHits[this.xrefIdx];
        if (hit) this._commitXref(hit);
      },
    });
  },

  // Verweis an der gesicherten Range einfügen.
  _commitXref(hit) {
    const editEl = getEditEl();
    const range = this._xrefRange;
    if (!editEl || !range || !hit?.target) { this._closeXref(); return; }

    const text = this.xrefPreview(hit);
    const html = buildXrefHtml({
      kind: hit.kind,
      target: hit.target,
      fmt: this.xrefFmt || 'label',
      text,
    });
    if (!html) { this._closeXref(); return; }

    editEl.focus();

    // `replaceContents`: eine markierte Stelle WIRD hier ersetzt — der Verweis
    // tritt an ihre Stelle im Satz (anders als der Beleg, der sie nachweist).
    // Trennzeichen ist ein gewöhnliches Leerzeichen, weil der Verweis Fliesstext
    // ist; Caret dahinter besorgt der Helfer.
    insertHtmlAtRange(range, html, { after: ' ', replaceContents: true });

    // Der frisch eingefügte Verweis ist noch nicht atomar (markXrefsAtomic läuft
    // sonst nur beim Mount). Direkt nachziehen, sonst tippt der User in den
    // Verweis hinein statt dahinter. Idempotent.
    markXrefsAtomic(editEl);

    window.__app?._markEditDirty?.();
    this._closeXref();
  },

  _closeXref() {
    this.xrefShow = false;
    this.xrefQuery = '';
    this.xrefIdx = 0;
    this.xrefHits = [];
    this.xrefError = false;
    this._xrefRange = null;
    getEditEl()?.focus();
  },
};
