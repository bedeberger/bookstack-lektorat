// Seitenansicht-Methoden: Formatierte HTML-Ansicht mit Inline-Fehlermarkierung
// und Figurenkontext-Panel. `this` bezieht sich auf die Alpine-Komponente.

import { escHtml, fetchJson, findInHtml, decorateMentions } from '../utils.js';
import { handleEditorCopy } from '../editor/shared/paste.js';
import { isPageConflict, savePage } from '../editor/shared/page-api.js';
import { setTodoCheckedAt, todoBoxIndex } from '../editor/shared/todo-html.js';
import { closestCiteEl } from '../sources/cite-html.js';
import { DIAGRAM_SEL } from '../diagram/mermaid-html.js';
import { contentRepo } from '../repo/content.js';
import { tRaw } from '../i18n.js';
import { _sanitizeFigur } from './figuren.js';

// Pauschale Diagrammhöhe, solange nichts zu messen ist (mermaid rendert
// asynchron nach dem ersten Höhen-Update). Grob ein mittleres Flowchart —
// lieber etwas zu gross, `max-height` deckelt nur (siehe `_diagramsPx`).
const DIAGRAM_FALLBACK_PX = 320;

// Weiche Typen: standardmässig nicht vorausgewählt (User entscheidet pro Finding).
// `hedging` ist weich (Absicherungs-Mass ist Autorenentscheid); die übrigen
// Fach-Typen (unbelegt, begriffsinkonsistenz, autorenform) sind hart – das sind
// Belegs- und Formbefunde, keine Geschmacksfragen.
export const SOFT_TYPEN = new Set(['satzbau', 'wiederholung', 'schwaches_verb', 'fuellwort', 'filterwort', 'klischee', 'pleonasmus', 'ki_geruch', 'show_vs_tell', 'passiv', 'perspektivbruch', 'tempuswechsel', 'hedging', 'amtsdeutsch']);

// Harte Typen = Default-selektiert → rote Einfärbung (Badge, Border, Inline-Mark --selected).
// Weiche Typen und 'stil' = Default-unselektiert → orange Einfärbung.
export function isHardFinding(typ) {
  return typ !== 'stil' && !SOFT_TYPEN.has(typ);
}

/** Sortiert Fehler nach Position im HTML (toleranter Match via `findInHtml`,
 *  damit Originale mit Tags/Entities/Whitespace-Differenzen richtig einsortiert
 *  werden). Findings, deren `original` im HTML nicht gefunden wird (z.B. KI-
 *  Halluzination), werden rausgefiltert – sie hätten in der Seitenansicht
 *  ohnehin keine Markierung. */
export function sortByPosition(html, fehler) {
  return fehler
    .map(f => {
      if (!f.original) return null;
      const m = findInHtml(html, f.original);
      return m ? { f, pos: m.htmlStart } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.pos - b.pos)
    .map(e => e.f);
}

// Spannt der Match einen Block-Tag-Übergang (z.B. </p><p>) auf, würde ein
// einzelnes <mark> phrasing-only sein und vom Parser am ersten </p> implizit
// geschlossen — Folge: nur der erste Absatz erhält die Markierung, das <ins>
// landet weit unten am Ende des letzten Absatzes. Darum den Match an Block-
// Grenzen splitten und pro Text-Segment ein eigenes <mark> emittieren.
const _BLOCK_BOUNDARY_RE = /(<\/(?:p|div|li|blockquote|h[1-6]|ol|ul|tr|td|th|pre)>\s*<(?:p|div|li|blockquote|h[1-6]|ol|ul|tr|td|th|pre)\b[^>]*>)/gi;
function _wrapMatchedRange(matched, markOpen) {
  const parts = matched.split(_BLOCK_BOUNDARY_RE);
  if (parts.length === 1) return markOpen + matched + '</mark>';
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      out += parts[i]; // Block-Grenzen unverändert
    } else if (parts[i].length > 0) {
      out += markOpen + parts[i] + '</mark>';
    }
  }
  return out;
}

/**
 * Baut eine HTML-Version mit <mark>-Tags um Fehlerstellen und optional
 * Chat-Änderungsvorschläge. Iteriert von hinten nach vorne, damit Offsets
 * stabil bleiben. Bei Überschneidung gewinnt die höhere Position; Lektorat
 * und Chat teilen sich denselben Overlap-Filter.
 */
export function buildHighlightedHtml(html, errors, selected, chatProposals = []) {
  if (!html || (!errors?.length && !chatProposals.length)) return html || '';

  const positions = [];
  for (let i = 0; i < (errors?.length || 0); i++) {
    const f = errors[i];
    if (!f.original) continue;
    const m = findInHtml(html, f.original);
    if (m) {
      positions.push({ idx: m.htmlStart, len: m.htmlEnd - m.htmlStart, kind: 'lektorat', errIdx: i });
    }
  }
  for (let i = 0; i < chatProposals.length; i++) {
    const p = chatProposals[i];
    if (!p.original) continue;
    const m = findInHtml(html, p.original);
    if (m) {
      positions.push({ idx: m.htmlStart, len: m.htmlEnd - m.htmlStart, kind: 'chat', propIdx: i });
    }
  }

  positions.sort((a, b) => b.idx - a.idx);

  const seen = new Set();
  const unique = positions.filter(p => {
    for (const s of seen) {
      if (p.idx < s.end && p.idx + p.len > s.start) return false;
    }
    seen.add({ start: p.idx, end: p.idx + p.len });
    return true;
  });

  let result = html;
  for (const p of unique) {
    const originalText = result.slice(p.idx, p.idx + p.len);
    let markOpen, ins;
    if (p.kind === 'lektorat') {
      const f = errors[p.errIdx];
      const isSel = selected[p.errIdx];
      const sel = isSel ? ' lektorat-mark--selected' : '';
      markOpen = `<mark class="lektorat-mark${sel}" data-error-idx="${p.errIdx}">`;
      ins = isSel && f.korrektur ? `<ins class="lektorat-ins">${escHtml(f.korrektur)}</ins>` : '';
    } else {
      const prop = chatProposals[p.propIdx];
      markOpen = `<mark class="chat-mark" data-chat-msg-idx="${prop.msgIdx}" data-chat-v-idx="${prop.vIdx}">`;
      ins = `<ins class="chat-mark-ins">${escHtml(prop.ersatz)}</ins>`;
    }
    result = result.slice(0, p.idx) + _wrapMatchedRange(originalText, markOpen) + ins + result.slice(p.idx + p.len);
  }

  return result;
}

// ── Singleton-Tooltip ──────────────────────────────────────────────────────

let tipEl = null;
let activeMark = null;

function ensureTipEl() {
  if (tipEl) return tipEl;
  tipEl = document.createElement('div');
  tipEl.className = 'lektorat-tip';
  document.body.appendChild(tipEl);
  // Tooltip bleibt offen wenn die Maus drauf wandert
  tipEl.addEventListener('mouseleave', () => hideTip());
  return tipEl;
}

function showTip(mark, errors) {
  const idx = parseInt(mark.dataset.errorIdx);
  if (isNaN(idx)) return;
  const allErrors = errors;
  if (!allErrors[idx]) return;
  const f = allErrors[idx];

  activeMark = mark;
  const tip = ensureTipEl();

  const typLabel = tRaw('finding.' + f.typ);
  const badgeCls = isHardFinding(f.typ) ? 'badge-err' : 'badge-warn';
  tip.innerHTML =
    `<span class="badge ${badgeCls}">${escHtml(typLabel)}</span>`
    + (f.erklaerung ? `<span class="lektorat-tip-erkl">${escHtml(f.erklaerung)}</span>` : '');

  // Positionierung: erst messen, dann platzieren
  tip.style.left = '-9999px';
  tip.style.top = '0';
  tip.classList.add('lektorat-tip--visible');

  const tipRect = tip.getBoundingClientRect();
  const markRect = mark.getBoundingClientRect();
  const GAP = 6;

  let left = markRect.left + markRect.width / 2 - tipRect.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));

  let top;
  if (markRect.top - tipRect.height - GAP >= 4) {
    top = markRect.top - tipRect.height - GAP;
  } else {
    top = markRect.bottom + GAP;
  }

  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}

function hideTip() {
  if (tipEl) tipEl.classList.remove('lektorat-tip--visible');
  activeMark = null;
}

// ── Split-Modus: Hover-Sync ───────────────────────────────────────────────

const splitMQ = window.matchMedia('(min-width: 1100px)');

function flashEl(el) {
  el.classList.remove('hover-sync-flash');
  void el.offsetWidth; // reflow → Animation neu starten
  el.classList.add('hover-sync-flash');
}

// ── Exportierte Methoden ───────────────────────────────────────────────────

export const pageViewMethods = {
  // State-Defaults (in app.js eingebunden)
  // renderedPageHtml: '',
  // chapterFigures: [],
  // showChapterFigures: false,

  /** Ist-Höhe der Leseansicht, wenn ihr DOM zur aktuellen Seite gehört.
   *
   *  Nur für Seiten mit Diagramm: dessen Höhe lässt sich aus dem Quelltext
   *  nicht ableiten (zwei Zeilen Code können 400 px Grafik sein), und in der
   *  Leseansicht ist der `<pre>` ausgeblendet, taucht in der Wortzahl also
   *  ohnehin nicht auf. Ohne Messung deckelt `--pcv-max-h` den Kasten auf die
   *  Prosa-Höhe und das Diagramm verschwindet hinter einer inneren Scrollbar.
   *
   *  `scrollHeight` (inkl. Padding) statt einer Summe aus Einzelhöhen: das ist
   *  genau die gesuchte Grösse, misst Ränder und Zeilenumbrüche korrekt mit und
   *  hat keine Rückkopplung — `max-height` ändert die Inhaltshöhe nicht.
   *
   *  Liefert 0 (→ Aufrufer schätzt), solange nicht sicher ist, dass das DOM zum
   *  aktuellen HTML gehört: nach einem Seitenwechsel steht bis zum nächsten
   *  Alpine-Tick die Vorgängerseite da, und vor dem mermaid-Lauf fehlen die
   *  Render-Knoten. Die Leseansicht ruft nach dem Rendern erneut hier durch. */
  _measuredPageViewPx(diagramCount) {
    const view = document.querySelector('.page-content-view:not(.page-content-view--editing)');
    if (!view) return 0;
    if (view.querySelectorAll(DIAGRAM_SEL).length !== diagramCount) return 0;
    // Fehlgeschlagene Diagramme zählen mit: der Fehlerknoten trägt dieselbe
    // Klasse, und der Quelltext daneben braucht ebenfalls Platz.
    if (view.querySelectorAll('.mermaid-render').length !== diagramCount) return 0;
    if (!view.scrollHeight) return 0;
    // `max-height` rechnet border-box (globales box-sizing), `scrollHeight`
    // nicht — ohne den Rahmenzuschlag bleiben 2 px Scrollrest stehen.
    return view.scrollHeight + (view.offsetHeight - view.clientHeight);
  },

  /** Berechnet max-height für die Seitenansicht basierend auf Textlänge */
  _updatePageViewHeight() {
    // Nach Edits ist tokEsts stale → aktuellen Text aus originalHtml ableiten,
    // sonst auf Cache fallback (bevor die Seite geladen ist).
    let words = 0;
    let diagramPx = 0;
    let measuredPx = 0;
    if (this.originalHtml) {
      const doc = new DOMParser().parseFromString(this.originalHtml, 'text/html');
      const diagrams = [...(doc.body?.querySelectorAll(DIAGRAM_SEL) || [])];
      // Diagramm-Notation zählt nirgends als Prosa (gleiche Regel wie
      // html-text/TTS/LanguageTool): Quelltext raus aus der Wortzahl, die
      // Blockhöhe kommt separat dazu.
      for (const d of diagrams) d.remove();
      const text = (doc.body?.textContent || '').trim();
      words = text ? text.split(/\s+/).length : 0;
      if (diagrams.length) {
        measuredPx = this._measuredPageViewPx(diagrams.length);
        // Schätzung bis zum Render: Pauschale pro Grafik, mindestens aber die
        // Quelltexthöhe (Edit-Modus, mermaid nicht geladen, ungültiger Code —
        // dort steht der `<pre>` mit ~20 px Zeilenhöhe).
        for (const d of diagrams) {
          const codeLines = (d.textContent || '').split('\n').length;
          diagramPx += Math.max(DIAGRAM_FALLBACK_PX, codeLines * 20 + 40);
        }
      }
    } else {
      words = this.tokEsts?.[this.currentPage?.id]?.words || 0;
    }
    // ~7 Wörter/Zeile bei 64ch Spalte mit langen deutschen Wörtern.
    // line-height 1.7 × 17px = 28.9px; 28px top + 28px bottom Padding = 56px.
    // Vorher: 12 wpm + nur Content-Höhe → Box deutlich zu kurz, Inhalt
    // overflowte sichtbar unter den weissen Hintergrund.
    const estLines = Math.ceil(words / 7);
    const contentPx = measuredPx || (estLines * 29 + 56 + diagramPx);
    const minPx = window.innerHeight * 0.20;
    const maxPx = window.innerHeight * 0.80;
    const px = Math.round(Math.min(maxPx, Math.max(minPx, contentPx)));
    document.documentElement.style.setProperty('--pcv-max-h', px + 'px');
  },

  /** Aktualisiert die gerenderte Seitenansicht (mit oder ohne Highlights) */
  updatePageView() {
    if (!this.originalHtml) {
      this.renderedPageHtml = '';
      return;
    }
    const allErrors = this.lektoratFindings || [];
    const allSelected = this.selectedFindings || [];
    const chatProposals = [];
    // Nur die letzte Assistant-Nachricht als Quelle für Inline-Marks: sonst
    // mischen sich frische Vorschläge mit denen aus der Historie und das
    // Ergebnis ist unübersichtlich. Ältere Vorschläge bleiben in den
    // Chat-Bubbles sichtbar.
    const msgs = this.chatMessages || [];
    let lastAsstIdx = -1;
    for (let mi = msgs.length - 1; mi >= 0; mi--) {
      if (msgs[mi].role === 'assistant') { lastAsstIdx = mi; break; }
    }
    if (lastAsstIdx !== -1 && Array.isArray(msgs[lastAsstIdx].vorschlaege)) {
      const lastMsg = msgs[lastAsstIdx];
      for (let vi = 0; vi < lastMsg.vorschlaege.length; vi++) {
        const v = lastMsg.vorschlaege[vi];
        if (v._applied || !v.original || !v.ersatz) continue;
        chatProposals.push({ msgIdx: lastAsstIdx, vIdx: vi, original: v.original, ersatz: v.ersatz });
      }
    }
    if (allErrors.length > 0 || chatProposals.length > 0) {
      this.renderedPageHtml = decorateMentions(buildHighlightedHtml(this.originalHtml, allErrors, allSelected, chatProposals));
    } else {
      this.renderedPageHtml = decorateMentions(this.originalHtml);
    }
    this._updatePageViewHeight();
  },

  /** Lädt Figurenkontext für das aktuelle Kapitel (nur bei >1 Seite im Kapitel) */
  async loadChapterFigures() {
    if (!this.currentPage?.chapter_id || !this.$store.nav.selectedBookId) {
      this.chapterFigures = [];
      return;
    }
    // Bei nur einer Seite pro Kapitel liefert der Endpoint alle Buchfiguren → nicht hilfreich
    const chapter = this.$store.nav.tree?.find(c => c.id === this.currentPage.chapter_id);
    if (chapter && chapter.pages?.length <= 1) {
      this.chapterFigures = [];
      return;
    }
    try {
      const data = await fetchJson(`/figures/chapter/${this.$store.nav.selectedBookId}/${this.currentPage.chapter_id}`);
      this.chapterFigures = (data?.figuren || []).map(_sanitizeFigur);
    } catch (e) {
      console.error('[loadChapterFigures]', e);
      this.chapterFigures = [];
    }
  },

  /** Klick auf eine Todo-Checkbox in der LESEANSICHT: der Browser hat den Haken
   *  schon visuell umgelegt (natives Input, kein contenteditable) — hier wird er
   *  ins gespeicherte Seiten-HTML nachgezogen und persistiert. Ohne diesen Pfad
   *  wirkt das Abhaken erledigt und ist beim nächsten Laden wieder weg (im
   *  Edit-Modus pflegt der Toggle-Handler in cards/editor-toolbar-card.js das
   *  `checked`-Attribut). Liefert true, wenn der Klick behandelt wurde. */
  _handleViewTodoClick(e) {
    const box = e.target;
    if (!box || box.tagName !== 'INPUT' || box.type !== 'checkbox') return false;
    const view = box.closest('.page-content-view');
    if (!view || view.classList.contains('page-content-view--editing')) return false;
    // Ohne Schreibrecht (viewer/lektor) nichts persistieren und den nativen
    // Toggle zurückdrehen — sonst zeigt die Ansicht einen Haken, den der Server
    // nie bekommt. CSS macht die Box für diese Rollen zusätzlich klick-inert
    // (.page-content-view--readonly in page-view.css); das hier ist die Defense
    // dahinter. `_todoSaving` ist ein kurzlebiger Re-Entry-Guard: zwei Haken in
    // schneller Folge würden sonst mit demselben `expectedUpdatedAt` speichern
    // und der zweite PUT liefe garantiert in einen 409 gegen den ersten.
    if (!this.canEdit?.() || this._todoSaving) {
      box.checked = !box.checked;
      return true;
    }
    this._saveViewTodo(view, box, box.checked);
    return true;
  },


  /** Persistiert den Haken des angeklickten Todo-Kastens. Fehlerpfade drehen den
   *  visuellen Toggle zurück, damit Ansicht und Persistenz nie auseinanderlaufen. */
  async _saveViewTodo(view, box, checked) {
    const page = this.currentPage;
    const idx = page && this.originalHtml ? todoBoxIndex(view, box) : -1;
    const html = idx < 0 ? null : setTodoCheckedAt(this.originalHtml, idx, checked);
    if (html == null) { box.checked = !checked; return; }
    this._todoSaving = true;
    try {
      const saved = await savePage(page.id, {
        html,
        pageName: page.name,
        source: 'main',
        expectedUpdatedAt: page.updated_at || null,
      });
      if (saved?.updated_at) page.updated_at = saved.updated_at;
      this.originalHtml = html;
      this._syncPageStatsAfterSave?.(page, html);
      // Sidebar-Lektorat-Status hängt an `updated_at` (Server-Map) — nachladen.
      this.refreshPageAges?.();
      this.updatePageView();
    } catch (err) {
      box.checked = !checked;
      if (isPageConflict(err)) {
        // Fremder Schreibvorgang dazwischen: kein Merge-Aufwand für ein Bit —
        // frischen Stand holen, User setzt den Haken erneut.
        try {
          const remote = await contentRepo.loadPage(page.id, { fresh: true });
          if (remote?.html != null) {
            this.originalHtml = remote.html;
            if (remote.updated_at) page.updated_at = remote.updated_at;
            this.updatePageView();
          }
        } catch (reloadErr) {
          console.error('[viewTodoConflictReload]', reloadErr);
        }
        this.setStatus(this.t('page.todo.conflict'), false, 6000);
        return;
      }
      console.error('[viewTodoToggle]', err);
      this.setStatus(this.t('page.todo.saveFailed', { msg: err.message }), false, 6000);
    } finally {
      this._todoSaving = false;
    }
  },


  /** Click-Handler für Inline-Marks → togglet Selektion. Links → neuer Tab. */
  handleMarkClick(e) {
    if (this._handleViewTodoClick(e)) return;
    // Beleg-Chip: gehört dem Quellen-Popover (cards/editor-entities-card.js).
    // Liegt der Chip innerhalb eines Lektorat-Marks, würde derselbe Klick sonst
    // zusätzlich das Finding auf-/zuklappen.
    if (closestCiteEl(e.target, e.currentTarget)) return;
    const link = e.target.closest('a[href]');
    if (link && !link.classList.contains('lektorat-mark')) {
      const href = link.getAttribute('href');
      if (href && !href.startsWith('#')) {
        e.preventDefault();
        window.open(link.href, '_blank', 'noopener,noreferrer');
        return;
      }
    }
    const mark = e.target.closest('.lektorat-mark');
    if (!mark) return;
    const idx = parseInt(mark.dataset.errorIdx);
    if (isNaN(idx)) return;
    this.toggleFinding(idx);
  },

  /** Pointer-Handler auf page-content-view: Im Split → Hover-Sync, sonst → Tooltip */
  handleMarkPointer(e) {
    if (e.pointerType !== 'mouse') return;
    const mark = e.target.closest('.lektorat-mark');
    if (mark === activeMark) return;
    if (!mark) { hideTip(); return; }

    if (splitMQ.matches && this.checkDone) {
      // Split-Modus: Finding-Panel mitscrollen
      activeMark = mark;
      const idx = parseInt(mark.dataset.errorIdx);
      if (isNaN(idx)) return;
      const finding = document.querySelector(`.lektorat-split-findings [data-finding-idx="${idx}"]`);
      if (finding) {
        finding.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        flashEl(finding);
      }
    } else {
      // Kein Split: Tooltip wie bisher
      showTip(mark, this.lektoratFindings || []);
    }
  },

  handleMarkPointerLeave(e) {
    if (splitMQ.matches && this.checkDone) return;
    const related = e.relatedTarget;
    if (related && tipEl?.contains(related)) return;
    hideTip();
  },

  // Copy aus Page-View: nur text/plain ins Clipboard (gemeinsam mit allen
  // Editoren). Browser-Default würde text/html mitsenden, was in Outlook
  // & Co. zusätzliche Absatzabstände, Inline-Styles und Lektorat-Marks
  // rendert. `sel.toString()` liefert den Block-getrennten Plain-Text.
  handleViewCopy(e) { handleEditorCopy(e); },
};
