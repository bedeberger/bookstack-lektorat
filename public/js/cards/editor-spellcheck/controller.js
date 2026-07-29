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
// Popover wird ins Scroll-Layer eingehaengt (Scroll-Container bei Notebook/Focus,
// body bei Bucheditor). Position absolute in Scroll-Content-Koordinaten — laeuft
// beim Scrollen kompositiv mit, ohne Scroll-Listener.
//
// Badge bleibt am Editor-Eck (Sibling zu root, gleiches offsetParent) und
// zeigt Status (loading/clean/matches/error/extension/disabled).
//
// LT-Browser-Extension-Detection pausiert Highlights solange Extension-Marker
// im DOM existieren.

import { buildOffsetTable, rangeFromOffset, filterProtectedMatches } from './mapping.js';
import { resolvePopoverHost, positionPopover } from './position.js';
import { EVT } from '../../events.js';

const DEFAULT_DEBOUNCE_MS = 1500;
const POPOVER_MAX_REPLACEMENTS = 5;
const EXTENSION_SELECTORS = [
  'lt-div',
  'lt-highlighter',
  '[class*="lt-toolbar"]',
  '[class*="languagetool"]',
];

const HL_TYPO    = 'lt-typo';
const HL_GRAMMAR = 'lt-grammar';
const HL_STYLE   = 'lt-style';
const HL_KEYS    = [HL_TYPO, HL_GRAMMAR, HL_STYLE];

const supportsHighlightApi = typeof CSS !== 'undefined'
  && CSS.highlights
  && typeof Highlight !== 'undefined';

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

  // Per-Instance Highlight-Buckets. CSS.highlights ist global; pro Instanz
  // wird ein frischer Highlight registriert und beim detach() geleert.
  const highlights = { [HL_TYPO]: null, [HL_GRAMMAR]: null, [HL_STYLE]: null };
  const squiggles = new Map(); // matchId -> { match, range, category }
  const ignored = new Set();   // matchId session-only

  let popover = null;
  let popoverHost = null;
  let popoverAnchorRange = null;
  let popoverKeyCtrl = null;

  let badge = null;
  let badgeState = 'idle';

  let mutationObs = null;
  let resizeObs = null;
  let scrollEl = null;
  let extensionObs = null;
  let extensionDetected = false;
  let attached = false;

  let debounceTimer = null;
  let extCheckTimer = null;
  let abortCtrl = null;
  let seq = 0;
  let lastHtmlSnapshot = '';
  // Plain-Text-Stream des zuletzt erfolgreich gerenderten Checks. Ein
  // `input`-Event, das keinen Text-Node aendert (z.B. Todo-Checkbox an/aus),
  // wuerde sonst einen Re-Check ausloesen, der die Highlights neu registriert
  // -> sichtbares Flackern. Bei identischem Text wird der Check uebersprungen;
  // explizite Rechecks (force) umgehen den Vergleich.
  let lastCheckedText = null;

  function _matchId(m) {
    // LT liefert keine stabile ID -> aus offset+length+ruleId zusammenbauen.
    return `${m.offset}:${m.length}:${m.rule?.id || ''}`;
  }

  function _extractMatchedWord(m) {
    const ctx = m?.context;
    if (!ctx || typeof ctx.text !== 'string') return '';
    const word = ctx.text.substr(ctx.offset || 0, ctx.length || 0).trim();
    return word.length > 0 && word.length <= 80 ? word : '';
  }

  function _categoryKey(match) {
    const id = match.rule?.id || '';
    const cat = match.rule?.category?.id || '';
    if (id.includes('SPELL') || cat === 'TYPOS') return HL_TYPO;
    if (cat === 'STYLE' || cat === 'REDUNDANCY' || cat === 'TYPOGRAPHY') return HL_STYLE;
    return HL_GRAMMAR;
  }

  function _badgeClassFor(match) {
    const k = _categoryKey(match);
    if (k === HL_TYPO) return 'lt-squiggle--typo';
    if (k === HL_STYLE) return 'lt-squiggle--style';
    return 'lt-squiggle--grammar';
  }

  function _ensureHighlights() {
    if (!supportsHighlightApi) return false;
    for (const key of HL_KEYS) {
      if (!highlights[key]) {
        highlights[key] = new Highlight();
        CSS.highlights.set(key, highlights[key]);
      }
    }
    return true;
  }

  function _clearHighlights() {
    for (const key of HL_KEYS) {
      if (highlights[key]) highlights[key].clear();
    }
  }

  // ─── Badge ───────────────────────────────────────────────────────────────

  function _ensureBadge() {
    if (badge) return badge;
    badge = document.createElement('div');
    badge.className = 'lt-badge';
    badge.setAttribute('data-editor', editorKind);
    badge.setAttribute('role', 'status');
    badge.setAttribute('aria-live', 'polite');
    root.parentNode?.insertBefore(badge, root.nextSibling);
    _syncBadgePosition();
    return badge;
  }

  function _syncBadgePosition() {
    if (!badge || !root) return;
    badge.style.top  = `${root.offsetTop + 6}px`;
    badge.style.left = `${root.offsetLeft + root.offsetWidth - 8}px`;
  }

  function _removeBadge() {
    if (badge && badge.parentNode) badge.parentNode.removeChild(badge);
    badge = null;
    badgeState = 'idle';
  }

  function _makeIcon(name) {
    const NS = 'http://www.w3.org/2000/svg';
    const XLINK = 'http://www.w3.org/1999/xlink';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'icon');
    const use = document.createElementNS(NS, 'use');
    use.setAttribute('href', `/icons.svg#${name}`);
    use.setAttributeNS(XLINK, 'xlink:href', `/icons.svg#${name}`);
    svg.appendChild(use);
    return svg;
  }

  function _updateBadge(state, opts = {}) {
    badgeState = state;
    _ensureBadge();
    _syncBadgePosition();
    badge.setAttribute('data-state', state);
    let icon = 'check';
    let label = '';
    let title = '';
    if (state === 'extension') {
      icon = 'alert-triangle';
      title = i18n('spellcheck.extension_conflict.title');
    } else if (state === 'error') {
      icon = 'alert-triangle';
      title = i18n('spellcheck.status.error');
    } else if (state === 'loading') {
      icon = 'loader';
      title = i18n('spellcheck.status.active');
    } else if (state === 'matches') {
      icon = 'alert-triangle';
      const n = Number(opts.count || 0);
      label = String(n);
      title = i18n('spellcheck.status.matches').replace('{n}', String(n));
    } else if (state === 'clean') {
      icon = 'check';
      title = i18n('spellcheck.status.no_matches');
    } else if (state === 'disabled') {
      icon = 'x';
      title = i18n('spellcheck.status.disabled');
    }
    badge.setAttribute('data-tip', title);
    badge.setAttribute('aria-label', title);
    badge.replaceChildren();
    const iconWrap = document.createElement('span');
    iconWrap.className = 'lt-badge__icon';
    iconWrap.appendChild(_makeIcon(icon));
    badge.appendChild(iconWrap);
    if (label) {
      const labelSpan = document.createElement('span');
      labelSpan.className = 'lt-badge__label';
      labelSpan.textContent = label;
      badge.appendChild(labelSpan);
    }
  }

  // ─── Popover ─────────────────────────────────────────────────────────────

  function _closePopover() {
    if (popoverKeyCtrl) { popoverKeyCtrl.abort(); popoverKeyCtrl = null; }
    if (popover && popover.parentNode) popover.parentNode.removeChild(popover);
    popover = null;
    popoverHost = null;
    popoverAnchorRange = null;
  }

  // Bei Notebook/Focus haengt der Popover als contenteditable="false"-Insel IM
  // Editier-Root (Scroll-Layer == Schreibflaeche). Jede Operation, die den
  // Root-Inhalt aus HTML neu aufbaut oder Bloecke teilt (Enter-Split, Undo,
  // `content.innerHTML = …`, Laden von HTML, in dem Popover-Markup mit-
  // gespeichert wurde), kann eine Kopie erzeugen, die die `popover`-Closure nicht
  // kennt: ein Knoten ohne jeden Handler, den `_closePopover` nie abtraegt —
  // unschliessbar bis zum Reload. Darum wird nie nur die eigene Referenz
  // entfernt, sondern jedes Popover-/Badge-Markup im Root. Das echte Badge ist
  // Sibling von root (siehe `_ensureBadge`) und damit nicht betroffen.
  function _purgeStrayUi() {
    if (!root.querySelectorAll) return;
    root.querySelectorAll('.lt-popover, .lt-badge').forEach((n) => n.remove());
  }

  function _scheduleCheck(opts) {
    if (!attached) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    const force = opts === true || !!(opts && opts.force === true);
    const ms = Number(getDebounceMs?.()) || DEFAULT_DEBOUNCE_MS;
    debounceTimer = setTimeout(() => _runCheck({ force }), ms);
  }

  async function _runCheck(opts) {
    if (!attached || extensionDetected) return;
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
      _updateBadge('clean');
      lastCheckedText = table.text;
      return;
    }
    lastHtmlSnapshot = getHtml ? getHtml() : root.innerHTML;
    const language = getBookLocale ? getBookLocale() : 'auto';
    const bookId = getBookId ? getBookId() : null;
    const pageId = getPageId ? getPageId() : null;

    _updateBadge('loading');

    let result;
    try {
      result = await checkText({
        text: table.text, language, bookId, pageId, signal: abortCtrl.signal,
      });
    } catch (err) {
      if (err && err.name !== 'AbortError') _updateBadge('error');
      return;
    }
    if (myReq !== seq) return; // stale
    if (result && result.disabled) { _renderMatches([]); _updateBadge('disabled'); return; }
    const currentSnap = getHtml ? getHtml() : root.innerHTML;
    if (currentSnap !== lastHtmlSnapshot) return; // DOM mutated mid-flight
    const matches = filterProtectedMatches((result && Array.isArray(result.matches)) ? result.matches : [], table.protectedRanges);
    _renderMatches(matches, table);
    lastCheckedText = table.text;
    const visibleCount = matches.filter((m) => !ignored.has(_matchId(m))).length;
    _updateBadge(visibleCount ? 'matches' : 'clean', { count: visibleCount });
  }

  function _renderMatches(matches, table) {
    if (!_ensureHighlights()) return;
    _clearHighlights();
    squiggles.clear();
    if (!table) return;
    for (const m of matches) {
      const id = _matchId(m);
      if (ignored.has(id)) continue;
      const range = rangeFromOffset(table, m.offset, m.length);
      if (!range) continue;
      const cat = _categoryKey(m);
      highlights[cat].add(range);
      squiggles.set(id, { match: m, range, category: cat });
    }
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

  function _onRootMousedown(ev) {
    if (ev.button !== 0) return;
    if (popover && popover.contains(ev.target)) return;
    // Doppel-/Dreifachklick (ev.detail >= 2): native Wort-/Absatz-Selektion
    // gewinnt. Sonst würde preventDefault + Selection-Collapse den zweiten
    // mousedown der dblclick-Sequenz wegfangen → User kann Wort über
    // Squiggle nicht mehr per Doppelklick selektieren.
    if (ev.detail >= 2) return;
    if (!squiggles.size) return;
    const id = _findMatchAtPoint(ev.clientX, ev.clientY);
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
  // `click`-Event, nicht auf mousedown — `_onRootMousedown`'s preventDefault
  // verhindert sie also nicht. Sitzt der Squiggle innerhalb eines <a href>,
  // wuerde der Link beim Klick gefolgt statt das Popover geoeffnet. Darum
  // unterdruecken wir den Folge-Click geometrisch am selben Punkt.
  function _onRootClick(ev) {
    if (ev.button !== 0) return;
    if (popover && popover.contains(ev.target)) return;
    if (ev.detail >= 2) return;
    if (!squiggles.size) return;
    if (_findMatchAtPoint(ev.clientX, ev.clientY)) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  }

  function _openPopover(matchId) {
    _closePopover();
    _purgeStrayUi();
    const entry = squiggles.get(matchId);
    if (!entry) return;
    const m = entry.match;
    popoverAnchorRange = entry.range;

    popover = document.createElement('div');
    popover.className = 'lt-popover';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('contenteditable', 'false');
    popover.setAttribute('data-editor', editorKind);

    // preventDefault haelt die Editor-Selection: mousedown auf Nicht-Button-
    // Flaechen des Popovers wuerde sie sonst wegnehmen (click bleibt intakt).
    popover.addEventListener('mousedown', (ev) => ev.preventDefault());

    const header = document.createElement('div');
    header.className = 'lt-popover__header';
    const catBadge = document.createElement('span');
    catBadge.className = `lt-popover__badge ${_badgeClassFor(m)}`;
    catBadge.textContent = m.rule?.category?.name || m.shortMessage || '';
    header.appendChild(catBadge);
    if (m.shortMessage && m.shortMessage !== catBadge.textContent) {
      const title = document.createElement('span');
      title.className = 'lt-popover__title';
      title.textContent = m.shortMessage;
      header.appendChild(title);
    }
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'lt-popover__close';
    // Sichtbar bleibt das Glyph, nicht der uebersetzte Label-Text: der
    // macOS-Client speist die Popover-Strings aus seiner eigenen Bridge-i18n-Map
    // und faellt bei ihm unbekannten Keys auf den rohen Key zurueck — ein
    // Label-Text stuende dort bis zum naechsten Client-Release als
    // „spellcheck.popover.close" im Button. Die Uebersetzung traegt darum nur
    // aria-label/Tooltip.
    closeBtn.textContent = '×';
    const closeLabel = i18n('spellcheck.popover.close');
    closeBtn.setAttribute('aria-label', closeLabel);
    closeBtn.setAttribute('data-tip', closeLabel);
    closeBtn.addEventListener('mousedown', (ev) => ev.preventDefault());
    closeBtn.addEventListener('click', () => _closePopover());
    header.appendChild(closeBtn);
    popover.appendChild(header);

    if (m.message) {
      const msg = document.createElement('p');
      msg.className = 'lt-popover__message';
      msg.textContent = m.message;
      popover.appendChild(msg);
    }

    const replacements = Array.isArray(m.replacements) ? m.replacements.slice(0, POPOVER_MAX_REPLACEMENTS) : [];
    if (replacements.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'lt-popover__empty';
      empty.textContent = i18n('spellcheck.popover.no_suggestions');
      popover.appendChild(empty);
    } else {
      const list = document.createElement('div');
      list.className = 'lt-popover__replacements';
      for (const r of replacements) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'lt-popover__replacement';
        btn.textContent = r.value || '';
        // mousedown.preventDefault: verhindert dass Editor-Selection beim Klick
        // verschoben wird (Buttons sitzen innerhalb contenteditable-Subtree).
        btn.addEventListener('mousedown', (ev) => ev.preventDefault());
        btn.addEventListener('click', () => _applyReplacement(matchId, r.value || ''));
        list.appendChild(btn);
      }
      popover.appendChild(list);
    }

    const footer = document.createElement('div');
    footer.className = 'lt-popover__footer';
    const ignoreBtn = document.createElement('button');
    ignoreBtn.type = 'button';
    ignoreBtn.className = 'lt-popover__ignore';
    ignoreBtn.textContent = i18n('spellcheck.popover.ignore');
    ignoreBtn.addEventListener('mousedown', (ev) => ev.preventDefault());
    ignoreBtn.addEventListener('click', () => {
      ignored.add(matchId);
      const entry2 = squiggles.get(matchId);
      if (entry2) {
        highlights[entry2.category]?.delete(entry2.range);
        squiggles.delete(matchId);
      }
      _closePopover();
    });
    footer.appendChild(ignoreBtn);

    const isSpell = (m.rule?.id || '').includes('SPELL') || (m.rule?.category?.id || '') === 'TYPOS';
    if (isSpell) {
      const word = _extractMatchedWord(m);
      if (word) {
        const dictBtn = document.createElement('button');
        dictBtn.type = 'button';
        dictBtn.className = 'lt-popover__dict';
        dictBtn.textContent = i18n('spellcheck.popover.add_to_dict');
        dictBtn.addEventListener('mousedown', (ev) => ev.preventDefault());
        dictBtn.addEventListener('click', async () => {
          dictBtn.disabled = true;
          try {
            const rawLang = getBookLocale ? getBookLocale() : '*';
            const lang = (!rawLang || rawLang === 'auto') ? '*' : rawLang;
            const ok = await addWord({ word, bookId: 0, lang });
            if (ok) {
              const entry3 = squiggles.get(matchId);
              if (entry3) {
                highlights[entry3.category]?.delete(entry3.range);
                squiggles.delete(matchId);
              }
              _closePopover();
              _scheduleCheck({ force: true }); // Text unveraendert, Dictionary aber geaendert
            } else {
              dictBtn.disabled = false;
            }
          } catch { dictBtn.disabled = false; }
        });
        footer.appendChild(dictBtn);
      }
    }

    const urlInfo = Array.isArray(m.rule?.urls) && m.rule.urls[0]?.value;
    if (urlInfo) {
      const link = document.createElement('a');
      link.href = urlInfo;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'lt-popover__info';
      link.textContent = i18n('spellcheck.popover.rule_info');
      footer.appendChild(link);
    }
    popover.appendChild(footer);

    _mountPopover();

    // Escape schliesst den Popover. Capture auf document, damit der Handler VOR
    // den Editor-eigenen Escape-Handlern laeuft — der Focus-Editor haengt seinen
    // an `window` in der Bubble-Phase (editor/focus/card.js) und wuerde sonst
    // gleichzeitig den Fokus-Modus verlassen. stopPropagation neutralisiert ihn
    // fuer genau diesen Tastendruck: erstes Escape schliesst nur den Popover,
    // zweites verhaelt sich wieder normal (cancelEdit / Exit Fokus-Modus).
    // Bewusst nicht ueber ein `app`-Flag wie bei Synonym-/Figur-Overlay — der
    // Controller ist host-agnostisch und kennt keinen Alpine-Root.
    popoverKeyCtrl = new AbortController();
    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      _closePopover();
    }, { capture: true, signal: popoverKeyCtrl.signal });

    // Outside-Click schliesst. setTimeout: aktueller mousedown soll nicht
    // gleich wieder schliessen.
    setTimeout(() => {
      const onDocClick = (ev) => {
        if (!popover) {
          document.removeEventListener('mousedown', onDocClick, true);
          return;
        }
        if (popover.contains(ev.target)) return;
        _closePopover();
        document.removeEventListener('mousedown', onDocClick, true);
      };
      document.addEventListener('mousedown', onDocClick, true);
    }, 0);
  }

  function _mountPopover() {
    if (!popover || !popoverAnchorRange) return;
    const anchorRect = popoverAnchorRange.getBoundingClientRect();

    // Host-Wahl + Geometrie in position.js. Beim Scroller-Host wird der Popover
    // Kind des contenteditable; der MutationObserver filtert popover-eigene
    // Mutationen heraus (sonst triggert das Anhaengen einen Re-Check, der die
    // Squiggles wegnimmt bevor der User klicken kann).
    popoverHost = resolvePopoverHost(scrollEl);
    popoverHost.appendChild(popover);
    positionPopover(popover, anchorRect, popoverHost);
  }

  function _remountPopover() {
    if (!popover || !popoverAnchorRange || !popoverHost) return;
    positionPopover(popover, popoverAnchorRange.getBoundingClientRect(), popoverHost);
  }

  function _applyReplacement(matchId, text) {
    const entry = squiggles.get(matchId);
    if (!entry) return;
    _closePopover();
    if (typeof onApplyReplacement === 'function') {
      try { onApplyReplacement(entry.range, text); }
      catch { /* host-side errors swallowed; next check rebuilds */ }
    }
    highlights[entry.category]?.delete(entry.range);
    squiggles.delete(matchId);
    _scheduleCheck();
  }

  function _detectExtension() {
    for (const sel of EXTENSION_SELECTORS) {
      if (document.querySelector(sel)) return true;
    }
    return false;
  }

  // Throttle: der Extension-Observer haengt an document.body{subtree} und
  // feuert bei JEDEM Keystroke (Editor-Mutationen). _detectExtension scannt das
  // ganze Dokument (querySelector) — ungedrosselt waere das Tipp-Latenz pro
  // Tastendruck auf grossen Seiten. Trailing-Throttle reicht: Extension-Marker
  // im DOM verschwinden nicht zeitkritisch.
  function _scheduleExtensionCheck() {
    if (extCheckTimer) return;
    extCheckTimer = setTimeout(() => {
      extCheckTimer = null;
      _updateExtensionState();
    }, 300);
  }

  function _updateExtensionState() {
    const present = _detectExtension();
    if (present && !extensionDetected) {
      extensionDetected = true;
      _clearHighlights();
      squiggles.clear();
      _closePopover();
      _updateBadge('extension');
      window.dispatchEvent(new CustomEvent(EVT.LANGUAGETOOL_EXTENSION_DETECTED));
    } else if (!present && extensionDetected) {
      extensionDetected = false;
      window.dispatchEvent(new CustomEvent(EVT.LANGUAGETOOL_EXTENSION_CLEARED));
      // Highlights wurden bei Detect geleert -> Re-Check erzwingen, auch wenn
      // der Text seit dem letzten Render unveraendert ist.
      _scheduleCheck({ force: true });
    }
  }

  // MutationObserver-Filter: ignoriere Mutationen, die nur das Popover-Subtree
  // betreffen (Popover ist contenteditable="false"-Insel im Editor-Root). Sonst
  // triggert das Anhaengen/Entfernen des Popover einen Re-Check, der die
  // Squiggles vor dem User-Klick verwirft.
  function _isPopoverOnlyMutation(m) {
    if (!popover) return false;
    if (m.type === 'characterData' || m.type === 'attributes') {
      return popover.contains(m.target);
    }
    if (m.type === 'childList') {
      const added = m.addedNodes ? Array.from(m.addedNodes) : [];
      const removed = m.removedNodes ? Array.from(m.removedNodes) : [];
      if (added.length === 0 && removed.length === 0) return false;
      const allSelf = (n) => n === popover || popover.contains(n);
      return added.every(allSelf) && removed.every(allSelf);
    }
    return false;
  }

  function attach() {
    if (attached) return;
    attached = true;

    // Popover-/Badge-Markup, das aus gespeichertem HTML zurueckkam (Altbestand
    // vor dem Save-Filter), ist reiner Waisen-Knoten — beim Mount wegraeumen,
    // bevor der erste Check laeuft.
    _purgeStrayUi();

    if (!supportsHighlightApi) {
      // Stiller Skip — App laeuft, nur ohne LT-Markierungen.
      _updateBadge('disabled');
      return;
    }

    _ensureHighlights();
    _ensureBadge();

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
        _syncBadgePosition();
        _remountPopover();
      });
      resizeObs.observe(root);
    }
    scrollEl = scrollContainer || _findScrollParent(root);

    extensionObs = new MutationObserver(() => _scheduleExtensionCheck());
    extensionObs.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    });
    _updateExtensionState();

    // Sofort-Check beim Attach (force: lastCheckedText ist noch leer, aber
    // explizit, falls der Controller je wiederverwendet wuerde).
    _runCheck({ force: true });
  }

  function detach() {
    if (!attached) return;
    attached = false;
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (extCheckTimer) { clearTimeout(extCheckTimer); extCheckTimer = null; }
    if (abortCtrl) { abortCtrl.abort(); abortCtrl = null; }
    if (mutationObs) { mutationObs.disconnect(); mutationObs = null; }
    if (resizeObs) { resizeObs.disconnect(); resizeObs = null; }
    if (extensionObs) { extensionObs.disconnect(); extensionObs = null; }
    root.removeEventListener('input', _scheduleCheck);
    root.removeEventListener('mousedown', _onRootMousedown, true);
    root.removeEventListener('click', _onRootClick, true);
    scrollEl = null;
    _closePopover();
    _purgeStrayUi();
    _clearHighlights();
    squiggles.clear();
    lastCheckedText = null;
    _removeBadge();
  }

  function refresh() {
    _scheduleCheck({ force: true });
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

  return { attach, detach, refresh, isAttached: () => attached };
}
