'use strict';
// Vorlesen / Proof-Listening im Share-Reader (Vanilla, kein Alpine). Pendant zum
// Notebook-Proof-Listening (editor/notebook/tts-proof.js), aber standalone fuer
// die anonyme Leseansicht: liest den geteilten Text satzweise vor, markiert den
// gerade gehoerten Satz per CSS Custom Highlight (::highlight(tts-sentence)) und
// nudgt ihn ins Sichtfeld.
//
// Datenfluss: pro Satz ein POST /share/:token/tts { text } (token-skopiert,
// ohne Session — der authed /tts/speak-Proxy ist fuer den Leser nicht
// erreichbar). Der Server holt Host/Voice/Key aus app_settings und forwarded an
// den OpenAI-kompatiblen Speech-Endpunkt (Kern lib/tts-synth.js). Audio-Bytes ->
// blob: -> new Audio(...).play(). Kein Persistieren, keine DOM-Mutation am
// Inhalt (nur CSS-Highlight).
//
// Die pure Segmentierung/Chunk-Logik kommt aus der SSoT ../tts-segment.js
// (geteilt mit dem Notebook-Dock).
//
// Selbst-bootstrappend: share.html laedt dieses Modul als eigenes
// <script type="module"> (unabhaengig vom Kommentar-Reader share-reader.js). Es
// liest die Reader-Config (#share-config) selbst und baut den Dock nur, wenn der
// Betreiber Vorlesen aktiviert hat (tts.enabled) und Lesetext vorhanden ist.

import { computeTtsSentences, chunkTtsRanges, normalizeForSpeech, ttsTextNodes, ttsBlockText, isTtsSkippedBlock } from '../tts-segment.js';
import { el } from './dom.js';

const HIGHLIGHT = 'tts-sentence';
const PREFETCH_AHEAD = 1;          // wie viele Saetze im Voraus synthetisiert werden
const FRAGMENT_PAUSE_MS = 250;     // Fallback-Atempause Satz-zu-Satz
const PARAGRAPH_PAUSE_MS = 550;    // Fallback-Atempause an Absatzgrenzen
const MAX_RETRY = 1;
const RETRY_DELAY_MS = 600;
const RETRYABLE_STATUS = new Set([408, 500, 502, 503]);
const ERROR_SHOW_MS = 4000;        // wie lange der Fehler-Status stehen bleibt
// Prosa-Bloecke, die vorgelesen werden. Leaf-Filter (siehe readableBlocks)
// verhindert Doppel-Lesen bei Verschachtelung (z.B. blockquote > p).
//
// BEWUSSTE KOPIE des Kerns aus editor/shared/dom-block.js: der Reader ist ein
// eigenstaendiger, schlanker Modulgraph und darf nur aus /js/share-reader/
// importieren — ein Import aus editor/shared/ zoege dem anonymen Leser das
// halbe App-Bundle in die Leseansicht. Eigener Name, damit die Kopie nicht
// wie der Editor-Selektor aussieht; gegen Drift gesichert durch
// tests/unit/block-sel-consolidation.test.mjs.
const READER_BLOCK_SEL = 'p, h1, h2, h3, h4, h5, h6, blockquote, li, pre, figcaption';

export function setupTts({ token, article, t, locale, pause }) {
  if (!token || !article) return;
  const supportsHighlight = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';
  const fragmentMs  = Number.isFinite(pause?.fragmentMs)  ? pause.fragmentMs  : FRAGMENT_PAUSE_MS;
  const paragraphMs = Number.isFinite(pause?.paragraphMs) ? pause.paragraphMs : PARAGRAPH_PAUSE_MS;

  // Aktive Vorlese-Session (roh im Closure gehalten — keine Reaktivitaet, die die
  // Identitaets-Guards `active === rt` brechen koennte). Pro Session neu, bei
  // Stop genullt.
  let active = null;
  let errorTimer = null;

  // ── Dock-DOM ───────────────────────────────────────────────────────────────
  // Neutrale .dock-*-Klassen tragen Form/Tasten/Pille (css/components/floating-dock.css,
  // geteilt mit den beiden Notebook-Docks); die tts-*-Klassen daneben tragen
  // Verankerung + Zustaende aus css/share/tts.css.
  const dock = el('div', 'dock tts-dock');
  dock.setAttribute('role', 'group');
  dock.setAttribute('aria-label', t('tts_listen'));

  const status = el('span', 'dock-status tts-status');
  status.setAttribute('aria-live', 'polite');
  status.hidden = true;

  const subCls = 'dock-btn dock-btn--sub tts-dock-btn tts-dock-btn--sub';
  const skipBtn = iconButton(subCls, 'chevron-last', t('tts_skip'));
  const stopBtn = iconButton(subCls, 'square', t('tts_stop'));
  const mainBtn = iconButton('dock-btn tts-dock-btn', 'headphones', t('tts_listen'));
  skipBtn.hidden = true;
  stopBtn.hidden = true;

  dock.appendChild(status);
  dock.appendChild(skipBtn);
  dock.appendChild(stopBtn);
  dock.appendChild(mainBtn);
  document.body.appendChild(dock);

  mainBtn.addEventListener('click', toggle);
  skipBtn.addEventListener('click', skip);
  stopBtn.addEventListener('click', stop);

  function iconButton(cls, icon, label) {
    const b = el('button', cls);
    b.type = 'button';
    b.setAttribute('data-tip', label);
    b.setAttribute('aria-label', label);
    setIcon(b, icon);
    return b;
  }
  function setIcon(btn, icon) {
    btn.innerHTML = `<svg class="icon" aria-hidden="true"><use href="/icons.svg#${icon}"/></svg>`;
  }

  // ── UI-Sync ──────────────────────────────────────────────────────────────
  function render() {
    const rt = active;
    const playing = !!rt;
    const paused = playing && rt.paused;
    if (errorTimer) return; // Fehler-Status kurz stehen lassen (Timer setzt zurueck)

    mainBtn.setAttribute('aria-pressed', playing && !paused ? 'true' : 'false');
    mainBtn.classList.toggle('is-reading', playing && !paused);
    const mainIcon = !playing ? 'headphones' : (paused ? 'play' : 'pause');
    const mainLabel = !playing ? t('tts_listen') : (paused ? t('tts_resume') : t('tts_pause'));
    setIcon(mainBtn, mainIcon);
    mainBtn.setAttribute('data-tip', mainLabel);
    mainBtn.setAttribute('aria-label', mainLabel);

    skipBtn.hidden = !(playing && !paused);
    stopBtn.hidden = !playing;

    status.hidden = !playing;
    status.classList.remove('is-error');
    if (playing) {
      status.classList.toggle('is-paused', paused);
      status.classList.toggle('is-reading', !paused);
      status.textContent = paused
        ? t('tts_paused')
        : (rt.loading && !rt.index
          ? t('tts_loading')
          : fmt(t('tts_reading'), { i: rt.index, n: rt.total }));
    }
  }
  function fmt(tpl, params) {
    return String(tpl).replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? params[k] : `{${k}}`));
  }
  function showError() {
    status.hidden = false;
    status.classList.remove('is-reading', 'is-paused');
    status.classList.add('is-error');
    status.textContent = t('tts_error');
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => { errorTimer = null; render(); }, ERROR_SHOW_MS);
  }

  // ── Segmentierung ──────────────────────────────────────────────────────────
  // Leaf-Prosa-Bloecke: Bloecke, die keinen anderen passenden Block enthalten
  // (blockquote > p -> nur p), sonst wuerde Text doppelt gelesen.
  function readableBlocks() {
    const all = Array.from(article.querySelectorAll(READER_BLOCK_SEL))
      .filter(b => !b.querySelector(READER_BLOCK_SEL))
      // Diagramme haben keinen Sprech-Text (SSoT tts-segment.js).
      .filter(b => !isTtsSkippedBlock(b));
    return all.length ? all : [article];
  }
  function collectSegments() {
    const segs = [];
    for (const block of readableBlocks()) {
      // Sprech-Text OHNE Beleg-Chips (SSoT tts-segment.js#ttsBlockText). Der
      // Range-Bau in buildRange laeuft ueber dieselbe Knotenliste — sonst
      // driftet das Satz-Highlight um die Chip-Laenge.
      const text = ttsBlockText(block);
      if (!text.trim()) continue;
      const ranges = computeTtsSentences(text, locale);
      const base = ranges.length ? ranges : [[0, text.length]];
      for (const [s, e] of chunkTtsRanges(base, text)) {
        const seg = text.slice(s, e).trim();
        if (seg) segs.push({ text: seg, block, startOff: s, endOff: e });
      }
    }
    return segs;
  }
  // Range aus Block + Zeichen-Offsets (Tree-Walk ueber die Textknoten). Erst beim
  // Highlight gebaut -> ueberlebt minimale Reflows.
  function buildRange(block, startOffset, endOffset) {
    if (!block || !block.isConnected) return null;
    let pos = 0, startNode = null, startOff = 0, endNode = null, endOff = 0;
    for (const node of ttsTextNodes(block)) {
      const len = node.nodeValue.length;
      if (!startNode && pos + len >= startOffset) { startNode = node; startOff = startOffset - pos; }
      if (pos + len >= endOffset) { endNode = node; endOff = endOffset - pos; break; }
      pos += len;
    }
    if (!startNode || !endNode) return null;
    const r = document.createRange();
    try {
      r.setStart(startNode, Math.max(0, Math.min(startOff, startNode.nodeValue.length)));
      r.setEnd(endNode, Math.max(0, Math.min(endOff, endNode.nodeValue.length)));
    } catch { return null; }
    return r;
  }
  function highlight(idx) {
    if (!supportsHighlight) return;
    CSS.highlights.delete(HIGHLIGHT);
    const seg = active?.segs?.[idx];
    if (!seg) return;
    const range = buildRange(seg.block, seg.startOff, seg.endOff);
    if (!range) return;
    try { CSS.highlights.set(HIGHLIGHT, new Highlight(range)); } catch { return; }
    scrollRangeIntoView(range);
  }
  function clearHighlight() {
    if (supportsHighlight) CSS.highlights.delete(HIGHLIGHT);
  }
  // Der Reader scrollt das Fenster (kein eigener Scroll-Container wie im Notebook)
  // -> window.scrollTo statt scrollTop-Nudge. Nur wenn der Satz ausserhalb des
  // sichtbaren Bereichs liegt.
  function scrollRangeIntoView(range) {
    let rect = null;
    try { rect = range.getBoundingClientRect(); } catch { return; }
    if (!rect || !rect.height) return;
    const marginTop = 120;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    if (rect.top < marginTop || rect.bottom > vh - 48) {
      window.scrollTo({ top: window.scrollY + rect.top - marginTop, behavior: 'smooth' });
    }
  }

  // ── Steuerung ──────────────────────────────────────────────────────────────
  function toggle() {
    const rt = active;
    if (!rt) { start(); return; }
    if (rt.paused) {
      rt.paused = false;
      if (rt.resolveCurrent && rt.audio && !rt.audio.ended) {
        try { rt.audio.play(); } catch { /* noop */ }
      } else if (!rt.running) {
        run(rt);
      }
      render();
    } else {
      rt.paused = true;
      try { rt.audio?.pause(); } catch { /* noop */ }
      render();
    }
  }
  function skip() {
    const rt = active;
    if (!rt || rt.paused) return;
    try { rt.audio?.pause(); } catch { /* noop */ }
    if (rt.resolveCurrent) { const r = rt.resolveCurrent; rt.resolveCurrent = null; r(true); }
  }
  function stop() { stopSession(); }

  function start() {
    if (active) return;
    const segs = collectSegments();
    if (!segs.length) { showError(); return; }
    const rt = {
      segs, i: 0, index: 0, total: segs.length,
      loading: false, paused: false, running: false,
      cache: new Map(), urls: new Set(), audio: null,
      abort: new AbortController(), resolveCurrent: null,
      failShown: false,
    };
    active = rt;
    render();
    run(rt);
  }

  async function run(rt) {
    if (rt.running) return;
    rt.running = true;
    try {
      while (active === rt && rt.i < rt.segs.length) {
        if (rt.paused) return;
        const idx = rt.i;
        rt.index = idx + 1;
        highlight(idx);
        for (let k = 0; k <= PREFETCH_AHEAD; k++) prefetch(rt, idx + k);
        rt.loading = true; render();
        const url = await rt.cache.get(idx);
        rt.loading = false;
        if (active !== rt || rt.paused) return;
        render();
        if (url == null) { rt.i++; continue; } // Fehler-Satz uebersprungen
        const ended = await playUrl(rt, url);
        if (active !== rt) return;
        if (!ended) return; // pausiert/gestoppt
        rt.i++;
        const next = rt.segs[rt.i];
        if (next) {
          const blockChange = next.block !== rt.segs[idx].block;
          const ms = blockChange ? paragraphMs : fragmentMs;
          if (ms > 0) { await delay(ms, rt.abort.signal); if (active !== rt || rt.paused) return; }
        }
      }
      if (active === rt) stopSession(); // ans Ende gelesen
    } finally {
      rt.running = false;
    }
  }

  function playUrl(rt, url) {
    return new Promise((resolve) => {
      const audio = new Audio(url);
      rt.audio = audio;
      rt.resolveCurrent = resolve;
      const done = (val) => { if (rt.resolveCurrent !== resolve) return; rt.resolveCurrent = null; resolve(val); };
      audio.addEventListener('ended', () => done(true));
      audio.addEventListener('error', () => { if (active !== rt) return; done(true); }); // defektes Segment -> weiter
      audio.play().catch(() => { if (!rt.paused) done(true); });
    });
  }

  // ── Synthese (Prefetch + Fetch) ────────────────────────────────────────────
  function prefetch(rt, idx) {
    if (idx < 0 || idx >= rt.segs.length || rt.cache.has(idx)) return;
    const p = fetchAudio(rt, rt.segs[idx].text, 0)
      .then((blob) => {
        if (active !== rt || !blob) return null;
        const objUrl = URL.createObjectURL(blob);
        rt.urls.add(objUrl);
        return objUrl;
      })
      .catch(() => null);
    rt.cache.set(idx, p);
  }

  async function fetchAudio(rt, rawText, attempt) {
    const signal = rt.abort.signal;
    if (signal.aborted) return null;
    const text = normalizeForSpeech(rawText);
    let res;
    try {
      res = await fetch(`/share/${encodeURIComponent(token)}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal,
      });
    } catch (e) {
      if (signal.aborted || e?.name === 'AbortError') return null;
      if (attempt < MAX_RETRY) { await delay(RETRY_DELAY_MS, signal); return fetchAudio(rt, rawText, attempt + 1); }
      failed(rt);
      return null;
    }
    // 404 (Feature aus / Link weg) -> Session beenden. Kein 401 hier: der Reader
    // ist ohnehin anonym; die Route ist token-skopiert.
    if (res.status === 404) { stopSession(); return null; }
    if (!res.ok) {
      if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRY) {
        await delay(RETRY_DELAY_MS, signal); return fetchAudio(rt, rawText, attempt + 1);
      }
      failed(rt);
      return null;
    }
    try {
      const blob = await res.blob();
      return blob && blob.size ? blob : null;
    } catch (e) {
      if (signal.aborted || e?.name === 'AbortError') return null;
      failed(rt);
      return null;
    }
  }

  function delay(ms, signal) {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const tm = setTimeout(resolve, ms);
      signal?.addEventListener?.('abort', () => { clearTimeout(tm); resolve(); }, { once: true });
    });
  }
  function failed(rt) {
    if (rt.failShown) return; // nur einmal pro Session
    rt.failShown = true;
    showError();
  }

  function stopSession() {
    const rt = active;
    active = null;
    clearTimeout(errorTimer); errorTimer = null; // Fehler-Fenster nicht ueber den Stop halten
    clearHighlight();
    if (!rt) { render(); return; }
    try { rt.abort.abort(); } catch { /* noop */ }
    try { if (rt.audio) { rt.audio.pause(); rt.audio.src = ''; } } catch { /* noop */ }
    if (rt.resolveCurrent) { const r = rt.resolveCurrent; rt.resolveCurrent = null; r(false); }
    for (const url of rt.urls) { try { URL.revokeObjectURL(url); } catch { /* noop */ } }
    rt.urls.clear();
    render();
  }

  render();

  // Stop, wenn der Tab in den Hintergrund geht — spart Synthese-Last, und der
  // Leser will das Vorlesen nicht im Hintergrund weiterlaufen hoeren.
  document.addEventListener('visibilitychange', () => { if (document.hidden && active) stopSession(); });
}

// ── Selbst-Bootstrap (share.html laedt dieses Modul direkt) ──────────────────
// DOM-guarded, damit der Import in Node/Tests keinen ReferenceError wirft.
if (typeof document !== 'undefined') {
  const boot = () => {
    const cfgEl = document.getElementById('share-config');
    if (!cfgEl) return;
    let cfg;
    try { cfg = JSON.parse(cfgEl.textContent || '{}'); } catch { return; }
    if (!cfg.token || !cfg.tts?.enabled) return;
    const article = document.getElementById('share-article');
    if (!article) return;
    const i18n = cfg.i18n || {};
    setupTts({
      token: cfg.token,
      article,
      t: (k) => i18n[k] || k,
      locale: cfg.lang || 'de',
      pause: cfg.tts.pause,
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
}
