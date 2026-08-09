// Synonym-Controller — editor-agnostisch, Alpine-frei. Eine Instanz pro aktivem
// contenteditable-Editor. Vorbild: cards/editor-spellcheck/controller.js.
//
// Wird im OTA-Editor-Bundle ([lib/editor-bundle.js]) an den nativen macOS-Focus-
// Client ausgeliefert (Boot-Glue in dessen WebAssets.swift ist auf diese
// Factory-Signatur + die unten genutzten i18n-Keys verdrahtet). In der SPA
// laeuft daneben weiterhin die Alpine-Karte (editor-synonyme-card.js) — dieser
// Controller wird dort nicht gemountet, ist also rein additiv.
//
// Mounting durch Editor-Schale:
//   const ctl = createSynonymController({ root, getBookId, getPageId,
//                                         isEnabled, i18n,
//                                         lookupThesaurus, lookupAi,
//                                         onApplyReplacement });
//   ctl.attach();   // Hotkey-Handler an root
//   ctl.detach();   // Cleanup (Menue/Picker, Listener, laufender KI-Call)
//
// Ablauf:
//   ⌘/Ctrl+⇧+S -> markiertes Wort bzw. Wort unter Cursor -> Range -> Menue
//   ("Synonym suchen fuer …") -> Klick -> Picker mit zwei Sektionen
//   (Thesaurus + KI), beide laden parallel -> Klick auf Vorschlag ->
//   onApplyReplacement(range, text).
//
// Die Default-Callbacks bilden den SPA-Pfad nach (OpenThesaurus-Sync-Call,
// /jobs/synonym + Polling, Range-Mutation via shared/apply-replacement.js).
// Der Mac-Client injiziert eigene Callbacks (Bridge-Transport; Swift pollt den
// KI-Job fertig, sodass lookupAi direkt { synonyme } liefert).
//
// Schlanke Closure: bewusst keine Imports aus editor/utils.js oder
// job-helpers.js (die zoegen schwere Closures ins Bundle). Die benoetigten
// Helfer (WORD_RE, Popup-Positionierung, Reflow, Satz-Extraktion, Job-Poll)
// sind inline. Einzige Import-Kopplung: apply-replacement.js — bereits ein
// Entry-Modul des Bundles.

import { applySpellcheckReplacement } from '../../editor/shared/apply-replacement.js';

// Ein "Einzelwort": Buchstaben/Ziffern, optional mit Bindestrich/Apostroph.
const WORD_RE = /^[\p{L}\p{N}][\p{L}\p{N}\-']*$/u;
const MOBILE_MAX = 768;
const POLL_INTERVAL_MS = 2000;

// Default-Callbacks bilden den SPA-Pfad nach. ───────────────────────────────

async function defaultLookupThesaurus({ word, bookId, signal }) {
  const url = `/openthesaurus/synonyms?word=${encodeURIComponent(word)}`
    + (bookId ? `&book_id=${bookId}` : '');
  const resp = await fetch(url, { signal, credentials: 'same-origin' });
  if (!resp.ok) throw new Error('thes_http_' + resp.status);
  const d = await resp.json();
  return {
    synonyme: Array.isArray(d.synonyme) ? d.synonyme : [],
    disabled: !!d.disabled,
  };
}

// POST /jobs/synonym + Polling bis Terminal-Status. Resolved { synonyme }.
async function defaultLookupAi({ word, satz, bookId, pageId, signal }) {
  const resp = await fetch('/jobs/synonym', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wort: word, satz, book_id: bookId, page_id: pageId }),
    signal,
    credentials: 'same-origin',
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.jobId) throw new Error(data.error || 'job_failed');
  const jobId = data.jobId;

  return await new Promise((resolve, reject) => {
    let stopped = false;
    const finish = (fn) => { if (stopped) return; stopped = true; clearInterval(timer); fn(); };
    const onAbort = () => {
      // Abbruch durch User (Picker zu / neuer Request): Job serverseitig killen.
      fetch('/jobs/' + jobId, { method: 'DELETE' }).catch(() => {});
      finish(() => reject(new DOMException('aborted', 'AbortError')));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setInterval(async () => {
      if (stopped) return;
      try {
        const r = await fetch('/jobs/' + jobId, { credentials: 'same-origin' });
        if (stopped) return;
        if (r.status === 404) { finish(() => reject(new Error('job_unavailable'))); return; }
        if (!r.ok) return;
        const job = await r.json();
        if (stopped) return;
        if (job.status === 'running' || job.status === 'queued') return;
        if (job.status === 'error' || job.status === 'cancelled') {
          finish(() => reject(new Error(job.error || 'ki_failed')));
          return;
        }
        const list = Array.isArray(job.result?.synonyme) ? job.result.synonyme : [];
        finish(() => resolve({ synonyme: list }));
      } catch { /* transienter Netzfehler -> naechster Tick */ }
    }, POLL_INTERVAL_MS);
  });
}

export function createSynonymController({
  root,
  getBookId = () => null,
  getPageId = () => null,
  isEnabled = () => true,
  i18n = (k) => k,
  lookupThesaurus = defaultLookupThesaurus,
  lookupAi = defaultLookupAi,
  onApplyReplacement = (range, text) => applySpellcheckReplacement(range, text),
} = {}) {
  if (!root) throw new Error('synonym: root required');

  let attached = false;
  let menuEl = null;
  let pickerEl = null;
  let anchorRange = null;
  let word = '';
  let reflowDetach = null;
  let dismissBound = false;
  let reqAbort = null;          // AbortController des laufenden Synonym-Requests
  // Picker-Sektions-Container, befuellt sobald die jeweilige Quelle antwortet.
  let thesContentEl = null;
  let aiContentEl = null;

  // ─── kleine DOM-/Geometrie-Helfer (inline) ───────────────────────────────

  function _makeIcon(name) {
    const NS = 'http://www.w3.org/2000/svg';
    const XLINK = 'http://www.w3.org/1999/xlink';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(NS, 'use');
    use.setAttribute('href', `/icons.svg#${name}`);
    use.setAttributeNS(XLINK, 'xlink:href', `/icons.svg#${name}`);
    svg.appendChild(use);
    return svg;
  }

  // Position relativ zum Anker-Rect: flippt nach oben wenn unten kein Platz,
  // clamped horizontal an die Viewport-Grenzen. Liefert {x,y}.
  function _positionNearRect(rect, el, { gap = 4, padding = 8, fallbackWidth = 280, fallbackHeight = 200 } = {}) {
    const w = el?.offsetWidth || fallbackWidth;
    const h = el?.offsetHeight || fallbackHeight;
    const spaceBelow = window.innerHeight - rect.bottom;
    const placeBelow = spaceBelow >= h + gap;
    const x = Math.max(padding, Math.min(Math.round(rect.left), window.innerWidth - w - padding));
    const y = placeBelow
      ? Math.round(rect.bottom + gap)
      : Math.max(padding, Math.round(rect.top - h - gap));
    return { x, y };
  }

  function _reposition() {
    const el = pickerEl || menuEl;
    if (!el || !anchorRange) return;
    const rect = anchorRange.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) { _closeAll(); return; }
    const isPicker = !!pickerEl;
    const { x, y } = _positionNearRect(rect, el, {
      gap: 4,
      fallbackWidth: isPicker ? 300 : 220,
      fallbackHeight: isPicker ? 360 : 44,
    });
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }

  function _attachReflow() {
    if (reflowDetach) return;
    const ctrl = new AbortController();
    const { signal } = ctrl;
    const handler = () => _reposition();
    window.addEventListener('scroll', handler, { capture: true, signal });
    window.addEventListener('resize', handler, { signal });
    reflowDetach = () => ctrl.abort();
  }

  function _detachReflow() {
    if (!reflowDetach) return;
    reflowDetach();
    reflowDetach = null;
  }

  // ─── Satz-Extraktion fuer den KI-Kontext (inline) ─────────────────────────

  function _extractSentence(range, wort) {
    let node = range.startContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    const block = node?.closest?.('p, li, blockquote, h1, h2, h3, h4, h5, h6, div') || node;
    const full = (block?.textContent || '').replace(/\s+/g, ' ').trim();
    if (!full) return wort;

    let offset = -1;
    try {
      const pre = document.createRange();
      pre.selectNodeContents(block);
      pre.setEnd(range.startContainer, range.startOffset);
      offset = pre.toString().replace(/\s+/g, ' ').length;
    } catch { /* Fallback via indexOf */ }
    if (offset < 0 || offset > full.length) offset = full.indexOf(wort);
    if (offset < 0) return full.length <= 400 ? full : wort;

    const before = full.slice(0, offset);
    const after = full.slice(offset);
    const startMatch = before.match(/[.!?…][\s"»)]*(?=[^.!?…]*$)/);
    const start = startMatch ? startMatch.index + startMatch[0].length : 0;
    const endMatch = after.match(/[.!?…]/);
    const end = endMatch ? offset + endMatch.index + 1 : full.length;
    const sentence = full.slice(start, end).trim();
    return sentence || full;
  }

  // ─── Dismiss (Outside-Click + Escape) ─────────────────────────────────────

  function _onDocMousedown(ev) {
    if (menuEl && menuEl.contains(ev.target)) return;
    if (pickerEl && pickerEl.contains(ev.target)) return;
    _closeAll();
  }
  function _onDocKeydown(ev) {
    if (ev.key === 'Escape') _closeAll();
  }
  function _bindDismiss() {
    if (dismissBound) return;
    dismissBound = true;
    document.addEventListener('mousedown', _onDocMousedown, true);
    document.addEventListener('keydown', _onDocKeydown, true);
  }
  function _unbindDismiss() {
    if (!dismissBound) return;
    dismissBound = false;
    document.removeEventListener('mousedown', _onDocMousedown, true);
    document.removeEventListener('keydown', _onDocKeydown, true);
  }

  // ─── Menue ────────────────────────────────────────────────────────────────

  function _closeMenu() {
    if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
    menuEl = null;
  }

  function _openMenu(range, wort) {
    _closeAll();
    anchorRange = range;
    word = wort;

    menuEl = document.createElement('div');
    menuEl.className = 'synonym-menu';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'synonym-menu-btn';
    btn.textContent = i18n('synonym.menu.searchFor', { word: wort });
    btn.addEventListener('mousedown', (ev) => ev.preventDefault());
    btn.addEventListener('click', () => _requestSynonyms());
    menuEl.appendChild(btn);

    document.body.appendChild(menuEl);
    _reposition();
    _attachReflow();
    _bindDismiss();
  }

  // ─── Picker ────────────────────────────────────────────────────────────────

  function _closePicker() {
    if (reqAbort) { reqAbort.abort(); reqAbort = null; }
    if (pickerEl && pickerEl.parentNode) pickerEl.parentNode.removeChild(pickerEl);
    pickerEl = null;
    thesContentEl = null;
    aiContentEl = null;
  }

  function _closeAll() {
    _closeMenu();
    _closePicker();
    _detachReflow();
    _unbindDismiss();
    anchorRange = null;
    word = '';
  }

  // Befuellt einen Sektions-Content-Container mit Loading/Error/Leer/Liste.
  function _fillSection(contentEl, state) {
    if (!contentEl) return;
    contentEl.replaceChildren();
    if (state.loading) {
      contentEl.className = 'synonym-picker-loading';
      contentEl.textContent = state.loadingLabel;
      return;
    }
    if (state.error) {
      contentEl.className = 'synonym-picker-error';
      contentEl.textContent = state.error;
      return;
    }
    const list = Array.isArray(state.list) ? state.list : [];
    if (list.length === 0) {
      contentEl.className = 'synonym-picker-error';
      contentEl.textContent = state.emptyLabel;
      return;
    }
    contentEl.className = 'synonym-picker-list';
    for (const s of list) {
      if (!s || !s.wort) continue;
      const entry = document.createElement('button');
      entry.type = 'button';
      entry.className = 'synonym-entry';
      // mousedown.preventDefault: Editor-Selection nicht verschieben.
      entry.addEventListener('mousedown', (ev) => ev.preventDefault());
      entry.addEventListener('click', () => _apply(s.wort));
      const w = document.createElement('span');
      w.className = 'synonym-word';
      w.textContent = s.wort;
      entry.appendChild(w);
      if (s.hinweis) {
        const h = document.createElement('span');
        h.className = 'synonym-hint';
        h.textContent = s.hinweis;
        entry.appendChild(h);
      }
      contentEl.appendChild(entry);
    }
  }

  function _buildPickerShell(wort, withThes) {
    const el = document.createElement('div');
    el.className = 'synonym-picker';

    const header = document.createElement('div');
    header.className = 'synonym-picker-header';
    const title = document.createElement('span');
    title.textContent = i18n('synonym.picker.titleFor', { word: wort });
    header.appendChild(title);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn-close synonym-picker-close';
    const closeLabel = i18n('synonym.close');
    close.setAttribute('data-tip', closeLabel);
    close.setAttribute('aria-label', closeLabel);
    close.addEventListener('mousedown', (ev) => ev.preventDefault());
    close.addEventListener('click', () => _closeAll());
    close.appendChild(_makeIcon('x'));
    header.appendChild(close);
    el.appendChild(header);

    const body = document.createElement('div');
    body.className = 'synonym-picker-body';

    if (withThes) {
      const thesSection = document.createElement('div');
      thesSection.className = 'synonym-picker-section';
      const thesHead = document.createElement('div');
      thesHead.className = 'synonym-picker-subheader';
      thesHead.textContent = i18n('synonym.thesaurus');
      thesContentEl = document.createElement('div');
      thesSection.appendChild(thesHead);
      thesSection.appendChild(thesContentEl);
      body.appendChild(thesSection);
    } else {
      thesContentEl = null;
    }

    const aiSection = document.createElement('div');
    aiSection.className = 'synonym-picker-section';
    const aiHead = document.createElement('div');
    aiHead.className = 'synonym-picker-subheader';
    aiHead.textContent = i18n('synonym.ki');
    aiContentEl = document.createElement('div');
    aiSection.appendChild(aiHead);
    aiSection.appendChild(aiContentEl);
    body.appendChild(aiSection);

    el.appendChild(body);
    return el;
  }

  async function _requestSynonyms() {
    if (!anchorRange || !word) return;
    const range = anchorRange;
    const wort = word;
    const satz = _extractSentence(range, wort);
    const bookId = getBookId();
    const pageId = getPageId();

    if (reqAbort) reqAbort.abort();
    reqAbort = new AbortController();
    const { signal } = reqAbort;

    _closeMenu();
    pickerEl = _buildPickerShell(wort, true);
    document.body.appendChild(pickerEl);
    _fillSection(thesContentEl, { loading: true, loadingLabel: i18n('synonym.loading') });
    _fillSection(aiContentEl, { loading: true, loadingLabel: i18n('synonym.kiLoading') });
    _reposition();
    _attachReflow();
    _bindDismiss();

    // Thesaurus (Sync-Call).
    Promise.resolve()
      .then(() => lookupThesaurus({ word: wort, bookId, signal }))
      .then((res) => {
        if (signal.aborted || !pickerEl) return;
        const r = res || {};
        if (r.disabled) {
          // Thesaurus deaktiviert -> Sektion ganz ausblenden, falls noch da.
          if (thesContentEl?.parentNode) thesContentEl.parentNode.style.display = 'none';
          return;
        }
        _fillSection(thesContentEl, {
          list: r.synonyme || [],
          emptyLabel: i18n('synonym.noMatches'),
        });
        _reposition();
      })
      .catch((err) => {
        if (signal.aborted || !pickerEl || err?.name === 'AbortError') return;
        _fillSection(thesContentEl, { error: i18n('synonym.error') });
        _reposition();
      });

    // KI (Job-Queue + Poll, bzw. Mac-Bridge liefert direkt).
    Promise.resolve()
      .then(() => lookupAi({ word: wort, satz, bookId, pageId, signal }))
      .then((res) => {
        if (signal.aborted || !pickerEl) return;
        _fillSection(aiContentEl, {
          list: (res && res.synonyme) || [],
          emptyLabel: i18n('synonym.noneFound'),
        });
        _reposition();
      })
      .catch((err) => {
        if (signal.aborted || !pickerEl || err?.name === 'AbortError') return;
        _fillSection(aiContentEl, { error: i18n('synonym.error') });
        _reposition();
      });
  }

  function _apply(text) {
    const range = anchorRange;
    _closeAll();
    if (!range || !text) return;
    if (root && range.startContainer && !root.contains(range.startContainer)) return;
    try { onApplyReplacement(range, text); }
    catch { /* Host-Fehler schlucken; DOM-Stand bleibt konsistent */ }
  }

  // ─── Hotkey ────────────────────────────────────────────────────────────────

  function _onKeydown(e) {
    if (!attached || !isEnabled()) return;
    if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey) return;
    if ((e.key || '').toLowerCase() !== 's') return;
    if (window.innerWidth <= MOBILE_MAX) return;

    const sel = window.getSelection();
    let range = null;
    let wort = '';
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
      const text = sel.toString().trim();
      if (!text || !WORD_RE.test(text)) return;
      const r = sel.getRangeAt(0);
      if (!root.contains(r.commonAncestorContainer)) return;
      range = r.cloneRange();
      wort = text;
    } else if (sel && sel.rangeCount > 0) {
      // Caret in Wort: Range ueber die Wortgrenzen expandieren.
      const r = sel.getRangeAt(0);
      if (!root.contains(r.commonAncestorContainer)) return;
      const node = r.startContainer;
      if (node.nodeType !== Node.TEXT_NODE) return;
      const text = node.textContent || '';
      let s = r.startOffset;
      let eIdx = r.startOffset;
      const isWord = (ch) => /[\p{L}\p{M}\d'’-]/u.test(ch);
      while (s > 0 && isWord(text[s - 1])) s--;
      while (eIdx < text.length && isWord(text[eIdx])) eIdx++;
      const candidate = text.slice(s, eIdx);
      if (!candidate || !WORD_RE.test(candidate)) return;
      const expanded = document.createRange();
      expanded.setStart(node, s);
      expanded.setEnd(node, eIdx);
      range = expanded;
      wort = candidate;
      sel.removeAllRanges();
      sel.addRange(expanded.cloneRange());
    } else {
      return;
    }
    e.preventDefault();
    _openMenu(range, wort);
  }

  // ─── Public ──────────────────────────────────────────────────────────────

  function attach() {
    if (attached) return;
    attached = true;
    root.addEventListener('keydown', _onKeydown);
  }

  function detach() {
    if (!attached) return;
    attached = false;
    root.removeEventListener('keydown', _onKeydown);
    _closeAll();
  }

  return { attach, detach, isAttached: () => attached };
}
