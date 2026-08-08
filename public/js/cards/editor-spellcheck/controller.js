// Spellcheck-Controller — editor-agnostisch. Eine Instanz pro aktivem Editor.
//
// Mounting durch Editor-Modul:
//   const ctl = createSpellcheckController({ root, scrollContainer, getHtml,
//     onApplyReplacement, editorKind, getBookLocale, isEnabled });
//   ctl.attach();   // bei Edit-Mode-Enter / Focus-Enter / Block-Activate
//   ctl.detach();   // bei Exit / Block-Deactivate
//
// Pipeline pro attach: input/MutationObserver -> debounce (getDebounceMs(),
// Default 1500ms) -> _runCheck() -> fetch /languagetool/check -> _renderMatches()
// registriert DOM-Ranges in CSS.highlights (typo/grammar/style). Browser rendert
// die wavy-Underline nativ via ::highlight() — keine DOM-Spans pro Match, kein
// JS-Reposition bei Scroll. Ranges aktualisieren sich beim Editieren via
// DOM-Mutation; bei strukturellen Aenderungen invalidiert der naechste Check.
//
// Hier liegt die Pipeline; die Bestandteile daneben:
//   categories.js       Klassifikation eines Matches + die drei Highlight-Toepfe
//   badge.js            Status-Plakette am Editor-Eck
//   popover.js          Befund-Popover samt Mount/Position/Dismiss
//   extension-guard.js  Erkennung der LanguageTool-Browser-Erweiterung
//   mapping.js          Text-Offsets <-> DOM-Ranges, Schutzzonen
//   position.js         Host-Wahl + Geometrie des Popovers

import { buildOffsetTable, rangeFromOffset, filterProtectedMatches } from './mapping.js';
import {
  categoryKey, createHighlightBuckets, matchId, supportsHighlightApi,
} from './categories.js';
import { createBadge } from './badge.js';
import { createPopover } from './popover.js';
import { createExtensionGuard } from './extension-guard.js';
import { EVT } from '../../events.js';

const DEFAULT_DEBOUNCE_MS = 1500;

export function createSpellcheckController({
  root,
  scrollContainer,
  getHtml,
  onApplyReplacement,
  editorKind = 'notebook',
  getBookLocale,
  getBookId,
  getPageId,
  isEnabled = () => true,
  getDebounceMs = () => DEFAULT_DEBOUNCE_MS,
  i18n = (key) => key,
  checkText = async ({ text, language, bookId, pageId, signal }) => {
    const resp = await fetch('/languagetool/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, language, bookId, pageId }),
      signal,
      credentials: 'same-origin',
    });
    if (resp.status === 404) return { disabled: true };
    if (!resp.ok) throw new Error('lt_http_' + resp.status);
    const json = await resp.json();
    return { matches: Array.isArray(json.matches) ? json.matches : [] };
  },
  addWord = async ({ word, bookId, lang }) => {
    const resp = await fetch('/dictionary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ word, bookId, lang }),
      credentials: 'same-origin',
    });
    return resp.ok;
  },
}) {
  if (!root) throw new Error('spellcheck: root required');

  const highlights = createHighlightBuckets();
  const squiggles = new Map(); // matchId -> { match, range, category }
  const ignored = new Set();   // matchId session-only

  const badge = createBadge({ root, editorKind, i18n });

  let scrollEl = null;
  const popover = createPopover({
    editorKind,
    i18n,
    getScrollEl: () => scrollEl,
    addWord,
    // 'auto' ist die Sprach-Autoerkennung der Pruefung; im Woerterbuch heisst
    // „gilt fuer alle Sprachen" dagegen '*'.
    getLang: () => {
      const raw = getBookLocale ? getBookLocale() : '*';
      return (!raw || raw === 'auto') ? '*' : raw;
    },
  });

  const extensionGuard = createExtensionGuard({
    onDetected: () => {
      highlights.clear();
      squiggles.clear();
      popover.close();
      badge.update('extension');
      window.dispatchEvent(new CustomEvent(EVT.LANGUAGETOOL_EXTENSION_DETECTED));
    },
    onCleared: () => {
      window.dispatchEvent(new CustomEvent(EVT.LANGUAGETOOL_EXTENSION_CLEARED));
      // Highlights wurden bei Detect geleert -> Re-Check erzwingen, auch wenn
      // der Text seit dem letzten Render unveraendert ist.
      _scheduleCheck({ force: true });
    },
  });

  let mutationObs = null;
  let resizeObs = null;
  let attached = false;

  let debounceTimer = null;
  let abortCtrl = null;
  let seq = 0;
  let lastHtmlSnapshot = '';
  // Plain-Text-Stream des zuletzt erfolgreich gerenderten Checks. Ein
  // `input`-Event, das keinen Text-Node aendert (z.B. Todo-Checkbox an/aus),
  // wuerde sonst einen Re-Check ausloesen, der die Highlights neu registriert
  // -> sichtbares Flackern. Bei identischem Text wird der Check uebersprungen;
  // explizite Rechecks (force) umgehen den Vergleich.
  let lastCheckedText = null;

  // Bei Notebook/Focus haengt der Popover als contenteditable="false"-Insel IM
  // Editier-Root (Scroll-Layer == Schreibflaeche). Jede Operation, die den
  // Root-Inhalt aus HTML neu aufbaut oder Bloecke teilt (Enter-Split, Undo,
  // `content.innerHTML = …`, Laden von HTML, in dem Popover-Markup mit-
  // gespeichert wurde), kann eine Kopie erzeugen, die die Popover-Closure nicht
  // kennt: ein Knoten ohne jeden Handler, den `close()` nie abtraegt —
  // unschliessbar bis zum Reload. Darum wird nie nur die eigene Referenz
  // entfernt, sondern jedes Popover-/Badge-Markup im Root. Das echte Badge ist
  // Sibling von root (siehe badge.js) und damit nicht betroffen.
  function _purgeStrayUi() {
    if (!root.querySelectorAll) return;
    root.querySelectorAll('.lt-popover, .lt-badge').forEach((n) => n.remove());
  }

  // ─── Pruef-Pipeline ──────────────────────────────────────────────────────

  function _scheduleCheck(opts) {
    if (!attached) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    const force = opts === true || !!(opts && opts.force === true);
    const ms = Number(getDebounceMs?.()) || DEFAULT_DEBOUNCE_MS;
    debounceTimer = setTimeout(() => _runCheck({ force }), ms);
  }

  async function _runCheck(opts) {
    if (!attached || extensionGuard.blocked) return;
    if (!isEnabled()) return;

    const force = opts === true || !!(opts && opts.force === true);
    const table = buildOffsetTable(root);
    // Text unveraendert seit letztem gerenderten Check -> kein Netz-Roundtrip,
    // kein Highlight-Re-Register (Flacker-Quelle). Bestehende Squiggles bleiben
    // gueltig (keine Text-Node-Mutation). Force-Pfade (Wörterbuch, Quote-Norm,
    // Extension-cleared, manuelles refresh) pruefen trotzdem.
    if (!force && lastCheckedText !== null && table.text === lastCheckedText) return;

    if (abortCtrl) abortCtrl.abort();
    abortCtrl = new AbortController();

    const myReq = ++seq;
    if (!table.text.trim()) {
      _renderMatches([]);
      badge.update('clean');
      lastCheckedText = table.text;
      return;
    }
    lastHtmlSnapshot = getHtml ? getHtml() : root.innerHTML;
    const language = getBookLocale ? getBookLocale() : 'auto';
    const bookId = getBookId ? getBookId() : null;
    const pageId = getPageId ? getPageId() : null;

    badge.update('loading');

    let result;
    try {
      result = await checkText({
        text: table.text, language, bookId, pageId, signal: abortCtrl.signal,
      });
    } catch (err) {
      if (err && err.name !== 'AbortError') badge.update('error');
      return;
    }
    if (myReq !== seq) return; // stale
    if (result && result.disabled) { _renderMatches([]); badge.update('disabled'); return; }
    const currentSnap = getHtml ? getHtml() : root.innerHTML;
    if (currentSnap !== lastHtmlSnapshot) return; // DOM mutated mid-flight
    const matches = filterProtectedMatches((result && Array.isArray(result.matches)) ? result.matches : [], table.protectedRanges);
    _renderMatches(matches, table);
    lastCheckedText = table.text;
    const visibleCount = matches.filter((m) => !ignored.has(matchId(m))).length;
    badge.update(visibleCount ? 'matches' : 'clean', { count: visibleCount });
  }

  function _renderMatches(matches, table) {
    if (!highlights.ensure()) return;
    highlights.clear();
    squiggles.clear();
    if (!table) return;
    for (const m of matches) {
      const id = matchId(m);
      if (ignored.has(id)) continue;
      const range = rangeFromOffset(table, m.offset, m.length);
      if (!range) continue;
      const cat = categoryKey(m);
      highlights.add(cat, range);
      squiggles.set(id, { match: m, range, category: cat });
    }
  }

  // Squiggle aus Anzeige + Register nehmen (Ignorieren, Woerterbuch, Ersetzen).
  function _dropSquiggle(id) {
    const entry = squiggles.get(id);
    if (!entry) return;
    highlights.remove(entry.category, entry.range);
    squiggles.delete(id);
  }

  // ─── Click-Hit-Test ──────────────────────────────────────────────────────
  // Geometrischer Treffer-Test: der Klickpunkt wird gegen die ClientRects der
  // gespeicherten Squiggle-Ranges geprueft. Bewusst NICHT ueber
  // caretPositionFromPoint/caretRangeFromPoint — die liefern in einem
  // gescrollten overflow-Container (.page-content-view--editing, max-height
  // 70vh) eine falsche oder leere Caret-Position, sodass der Match beim
  // Scrollen zunehmend daneben liegt. ClientRects sind scroll- und
  // engine-unabhaengig korrekt.

  function _findMatchAtPoint(x, y) {
    for (const [id, entry] of squiggles) {
      const rects = entry.range.getClientRects();
      for (const rc of rects) {
        if (x >= rc.left && x <= rc.right && y >= rc.top && y <= rc.bottom) return id;
      }
    }
    return null;
  }

  // Beide Zeiger-Handler teilen dieselbe Vorprüfung. `ev.detail >= 2`:
  // Doppel-/Dreifachklick gewinnt — die native Wort-/Absatz-Selektion darf nicht
  // weggefangen werden, sonst laesst sich ein Wort unter einem Squiggle nicht
  // mehr per Doppelklick markieren.
  function _hitAt(ev) {
    if (ev.button !== 0) return null;
    if (popover.contains(ev.target)) return null;
    if (ev.detail >= 2) return null;
    if (!squiggles.size) return null;
    return _findMatchAtPoint(ev.clientX, ev.clientY);
  }

  function _onRootMousedown(ev) {
    const id = _hitAt(ev);
    if (!id) return;
    // KEIN preventDefault: die native Caret-Platzierung an die Klickposition
    // soll laufen, damit der User gezielt in eine Stelle des Wortes springen
    // kann (statt zwangsweise an den Wort-Anfang). Die Ersetzung laeuft ohnehin
    // ueber entry.range, nicht ueber die Selection — die Caret-Position ist rein
    // kosmetisch. stopPropagation bleibt (Editor-eigene mousedown-Handler sollen
    // nicht zusaetzlich feuern); das blockiert die Default-Aktion nicht.
    // Link-Folgen wird separat auf dem `click`-Event (_onRootClick) unterdrueckt.
    ev.stopPropagation();
    _openPopover(id);
  }

  // Native Anker-Navigation (und sonstige Default-Click-Aktion) feuert auf dem
  // `click`-Event, nicht auf mousedown — `_onRootMousedown` verhindert sie also
  // nicht. Sitzt der Squiggle innerhalb eines <a href>, wuerde der Link beim
  // Klick gefolgt statt das Popover geoeffnet. Darum unterdruecken wir den
  // Folge-Click geometrisch am selben Punkt.
  function _onRootClick(ev) {
    if (!_hitAt(ev)) return;
    ev.preventDefault();
    ev.stopPropagation();
  }

  function _openPopover(id) {
    popover.close();
    _purgeStrayUi();
    const entry = squiggles.get(id);
    if (!entry) return;
    popover.open(entry, {
      onApply: (text) => _applyReplacement(id, text),
      onIgnore: () => { ignored.add(id); _dropSquiggle(id); },
      // Text unveraendert, Dictionary aber geaendert -> force.
      onDictAdded: () => { _dropSquiggle(id); _scheduleCheck({ force: true }); },
    });
  }

  function _applyReplacement(id, text) {
    const entry = squiggles.get(id);
    if (!entry) return;
    popover.close();
    if (typeof onApplyReplacement === 'function') {
      try { onApplyReplacement(entry.range, text); }
      catch { /* host-side errors swallowed; next check rebuilds */ }
    }
    _dropSquiggle(id);
    _scheduleCheck();
  }

  // MutationObserver-Filter: ignoriere Mutationen, die nur das Popover-Subtree
  // betreffen (Popover ist contenteditable="false"-Insel im Editor-Root). Sonst
  // triggert das Anhaengen/Entfernen des Popover einen Re-Check, der die
  // Squiggles vor dem User-Klick verwirft.
  function _isPopoverOnlyMutation(m) {
    if (!popover.isOpen()) return false;
    const el = popover.el;
    if (m.type === 'characterData' || m.type === 'attributes') {
      return el.contains(m.target);
    }
    if (m.type === 'childList') {
      const added = m.addedNodes ? Array.from(m.addedNodes) : [];
      const removed = m.removedNodes ? Array.from(m.removedNodes) : [];
      if (added.length === 0 && removed.length === 0) return false;
      const allSelf = (n) => n === el || el.contains(n);
      return added.every(allSelf) && removed.every(allSelf);
    }
    return false;
  }

  function _findScrollParent(el) {
    let p = el.parentElement;
    while (p) {
      const s = getComputedStyle(p);
      if (/(auto|scroll|overlay)/.test(s.overflowY)) return p;
      p = p.parentElement;
    }
    return window;
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  function attach() {
    if (attached) return;
    attached = true;

    // Popover-/Badge-Markup, das aus gespeichertem HTML zurueckkam (Altbestand
    // vor dem Save-Filter), ist reiner Waisen-Knoten — beim Mount wegraeumen,
    // bevor der erste Check laeuft.
    _purgeStrayUi();

    if (!supportsHighlightApi) {
      // Stiller Skip — App laeuft, nur ohne LT-Markierungen.
      badge.update('disabled');
      return;
    }

    highlights.ensure();
    badge.ensure();

    mutationObs = new MutationObserver((muts) => {
      for (const m of muts) {
        if (_isPopoverOnlyMutation(m)) continue;
        _scheduleCheck();
        return;
      }
    });
    mutationObs.observe(root, { childList: true, subtree: true, characterData: true });
    root.addEventListener('input', _scheduleCheck);
    root.addEventListener('mousedown', _onRootMousedown, true);
    root.addEventListener('click', _onRootClick, true);

    if (typeof ResizeObserver !== 'undefined') {
      // Resize verschiebt Anker — Popover neu positionieren + Badge an Ecke
      // halten. Squiggles selbst aktualisiert der Browser via Highlight-Range
      // automatisch.
      resizeObs = new ResizeObserver(() => {
        badge.syncPosition();
        popover.remount();
      });
      resizeObs.observe(root);
    }
    scrollEl = scrollContainer || _findScrollParent(root);

    extensionGuard.start();

    // Sofort-Check beim Attach (force: lastCheckedText ist noch leer, aber
    // explizit, falls der Controller je wiederverwendet wuerde).
    _runCheck({ force: true });
  }

  function detach() {
    if (!attached) return;
    attached = false;
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (abortCtrl) { abortCtrl.abort(); abortCtrl = null; }
    if (mutationObs) { mutationObs.disconnect(); mutationObs = null; }
    if (resizeObs) { resizeObs.disconnect(); resizeObs = null; }
    extensionGuard.stop();
    root.removeEventListener('input', _scheduleCheck);
    root.removeEventListener('mousedown', _onRootMousedown, true);
    root.removeEventListener('click', _onRootClick, true);
    scrollEl = null;
    popover.close();
    _purgeStrayUi();
    highlights.clear();
    squiggles.clear();
    lastCheckedText = null;
    badge.remove();
  }

  function refresh() {
    _scheduleCheck({ force: true });
  }

  return { attach, detach, refresh, isAttached: () => attached };
}
