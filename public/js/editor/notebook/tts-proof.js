import { EVT } from '../../events.js';
import {
  computeTtsSentences, coalesceTtsRanges, splitLongRange, chunkTtsRanges,
  normalizeForSpeech, ttsTextNodes, ttsBlockText, isTtsSkippedBlock,
  TTS_MIN_CHUNK_CHARS, TTS_MAX_CHUNK_CHARS,
} from '../../tts-segment.js';
'use strict';
// Proof-Listening / Text-to-Speech (Notebook-Seitenansicht, Read-Modus). Liest
// den gerenderten Seitentext satzweise vor: pro Satz ein POST /tts/speak, das
// Audio wird sequenziell abgespielt, der gerade gehoerte Satz per
// CSS-Custom-Highlight markiert und ins Sichtfeld gescrollt. Den eigenen Text
// gehoert aufzudecken Stolperstellen, die das Auge ueberliest.
//
// Laeuft in der Leseansicht (`.page-content-view`), NICHT im Edit-Modus —
// Korrekturhoeren am fertigen Text, nicht waehrend des Tippens.
//
// Reines Lesen: KEINE DOM-Mutation, kein Save-Pfad, kein data-bid, kein
// Stale-Write. Der Highlight laeuft ueber die CSS Custom Highlight API (wie
// Bucheditor-Find/Replace + LanguageTool-Squiggles) — er faerbt nur, er
// veraendert den Seiteninhalt nicht.
//
// Diese Methoden werden in den Root (`Alpine.data('lektorat')`) gespreaded —
// der Vorlese-Dock laeuft im Root-Scope.
//
// Durchsatz: das Audio des aktuellen Satzes wird abgespielt, waehrend das des
// naechsten schon vorgeladen wird (Prefetch-Kette) — das Gegenstueck zur
// STT-insertChain (dort seriell EINFUEGEN, hier seriell ABSPIELEN).

const TTS_HIGHLIGHT = 'tts-sentence';
const TTS_PREFETCH_AHEAD = 1;   // wie viele Saetze im Voraus synthetisiert werden
// Chunk-Groessen + die pure Segmentierung leben in ../../tts-segment.js (SSoT,
// geteilt mit dem Share-Reader-Vorlese-Dock). Siehe dort, warum die zwei
// Chunk-Korrektive noetig sind (Kurz-Input-Halluzination / Lang-Satz-Latenz).
// Default-Atempause (ms) zwischen den vorgelesenen Fragmenten: statt nahtlos ins
// naechste Fragment ueberzugehen, gibt eine kurze Stille dem Ohr Luft — naeher
// am natuerlichen Vorlesen. An Absatzgrenzen (Block-Wechsel) etwas laenger.
// Fallback, falls /config keine Werte liefert — der Admin ueberschreibt sie via
// `tts.pause.fragment_ms` / `tts.pause.paragraph_ms` (this.$store.tts.pause).
const TTS_FRAGMENT_PAUSE_MS = 250;
const TTS_PARAGRAPH_PAUSE_MS = 550;
const TTS_MAX_RETRY = 1;
const TTS_RETRY_DELAY_MS = 600;
const TTS_RETRYABLE_STATUS = new Set([408, 500, 502, 503]);

// Aktive Vorlese-Session (Segmente, Audio, Prefetch-Cache, AbortController).
// Bewusst MODUL-scoped, NICHT auf der Alpine-Card: ein an `this` (= reaktiver
// Alpine-Root-Proxy) zugewiesenes Objekt wird von Alpine/Vue in einen reaktiven
// Proxy gewrappt, sodass `activeRt === rt` (Referenz-Identitaet) NIE haelt —
// die Abspiel-Schleife laeuft dann nie an. Als Modul-Variable bleibt die
// Referenz roh und die Guards greifen. Es gibt genau einen Root → ein Singleton
// reicht. Pro Session neu befuellt, bei Stop genullt.
let activeRt = null;

export const ttsProofMethods = {
  // Diagnostik-Logger: meldet reine Vorlese-Frontend-Events fire-and-forget an
  // POST /telemetry/tts-log, sodass sie zentral in schreibwerkstatt.log landen
  // (der /tts/speak-Proxy loggt nur die einzelnen Synthese-Calls). Lifecycle als
  // level=info, Fehler/Retry als level=warn. Best-effort: Netzfehler verschluckt.
  _ttsLog(msg, level = 'info') {
    const body = { level, msg, bookId: this.$store.nav.selectedBookId || null };
    try {
      fetch('/telemetry/tts-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
      }).catch(() => {});
    } catch { /* noop */ }
  },
  _ttsWarn(msg, data) {
    this._ttsLog(data !== undefined ? `${msg} (${data})` : msg, 'warn');
  },

  // ── Pure Compute (SSoT tts-segment.js, testbar ohne Browser) ─────────────
  // Duenne Delegationen an den geteilten Kern (auch der Share-Reader-Dock nutzt
  // ihn). Als Methoden erhalten, damit die bestehenden Aufrufer + Unit-Tests
  // (`ttsProofMethods._computeTtsSentences`) unveraendert bleiben.
  _computeTtsSentences(text, locale = 'de') { return computeTtsSentences(text, locale); },
  _coalesceTtsRanges(ranges, text, minLen = TTS_MIN_CHUNK_CHARS, maxLen = Infinity) {
    return coalesceTtsRanges(ranges, text, minLen, maxLen);
  },
  _splitLongRange(range, text, maxLen = TTS_MAX_CHUNK_CHARS) { return splitLongRange(range, text, maxLen); },
  _chunkTtsRanges(ranges, text, minLen = TTS_MIN_CHUNK_CHARS, maxLen = TTS_MAX_CHUNK_CHARS) {
    return chunkTtsRanges(ranges, text, minLen, maxLen);
  },

  // ── Lifecycle ────────────────────────────────────────────────────────────

  _initTtsProof(signal) {
    // Session-Handle zuruecksetzen (siehe `activeRt`-Deklaration oben: bewusst
    // modul-scoped, damit die Referenz-Identitaets-Guards nicht am Alpine-Proxy
    // scheitern).
    activeRt = null;
    this._ttsFailToasted = false; // Fehler-Toast nur einmal pro Session (kein Flood)
    const stop = () => { if (this.$store.tts.playing) this._ttsStop(); };
    window.addEventListener(EVT.BOOK_CHANGED, stop, { signal });
    window.addEventListener(EVT.VIEW_RESET, stop, { signal });
    // In den Edit-Modus wechseln (Dock ist read-only) / Seite gewechselt ->
    // Vorlesen beenden, Audio freigeben.
    this.$watch('editMode', (on) => { if (on) stop(); });
    this.$watch(() => this.currentPage?.id, () => stop());
  },

  _ttsLocaleCode() {
    return String(this.$store.shell.uiLocale || 'de').split('-')[0].trim().toLowerCase() || 'de';
  },

  // Hat die aktuelle Seite vorlesbaren Text? Steuert die Sichtbarkeit des
  // Vorlese-Docks: `renderedPageHtml` ist auch bei leerem Markup (`<p></p>`,
  // `<p><br></p>`) truthy — der Dock soll aber nur erscheinen, wenn nach dem
  // Strippen der Tags echter Text uebrig bleibt. Liest reaktiv aus
  // `renderedPageHtml` (Alpine trackt den Zugriff im x-show-Aufruf).
  _ttsHasReadableText() {
    const html = this.renderedPageHtml;
    if (!html) return false;
    return html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').trim().length > 0;
  },

  // Container der Leseansicht (Read-Modus). Bewusst nicht der Edit-Container
  // (`_getEditEl`): TTS liest den gerenderten Seitentext, nicht das
  // contenteditable. `:not(--editing)` grenzt gegen das Edit-Feld ab.
  _ttsGetReadEl() {
    return document.querySelector('#editor-card .page-content-view:not(.page-content-view--editing)');
  },

  // ── DOM-Segmentierung ──────────────────────────────────────────────────────

  // Edit-Feld in Vorlese-Segmente zerlegen: pro Block-Kind die Saetze, jeweils
  // mit Block-Referenz + Zeichen-Offsets. Die Range wird erst beim Highlight
  // gebaut (ueberlebt so minimale Reflows). Leere Bloecke werden uebersprungen.
  _ttsCollectSegments() {
    const editEl = this._ttsGetReadEl();
    if (!editEl) return [];
    const locale = this._ttsLocaleCode();
    const blocks = editEl.children.length ? Array.from(editEl.children) : [editEl];
    const segs = [];
    for (const block of blocks) {
      // Diagramme und Tabellen haben keinen Sprech-Text (SSoT tts-segment.js).
      if (isTtsSkippedBlock(block)) continue;
      // Sprech-Text OHNE Beleg-Chips (SSoT tts-segment.js#ttsBlockText) — ein
      // vorgelesenes „(Kafka, 1915, S. 44)" zerreisst den Hoerfluss. Der
      // Range-Bau unten laeuft ueber dieselbe Knotenliste, sonst driftet das
      // Highlight um die Chip-Laenge.
      const text = ttsBlockText(block);
      if (!text.trim()) continue;
      const ranges = this._computeTtsSentences(text, locale);
      const base = ranges.length ? ranges : [[0, text.length]];
      const list = this._chunkTtsRanges(base, text);
      for (const [s, e] of list) {
        const t = text.slice(s, e).trim();
        if (t) segs.push({ text: t, block, startOff: s, endOff: e });
      }
    }
    return segs;
  },

  // Range aus Block + Zeichen-Offsets. Knotenliste kommt aus ttsTextNodes —
  // derselbe Offsetraum, aus dem _ttsCollectSegments seinen Text zieht.
  _ttsBuildRange(block, startOffset, endOffset) {
    if (!block) return null;
    let pos = 0;
    let startNode = null, startOff = 0, endNode = null, endOff = 0;
    for (const node of ttsTextNodes(block)) {
      const len = node.nodeValue.length;
      if (!startNode && pos + len >= startOffset) {
        startNode = node;
        startOff = startOffset - pos;
      }
      if (pos + len >= endOffset) {
        endNode = node;
        endOff = endOffset - pos;
        break;
      }
      pos += len;
    }
    if (!startNode || !endNode) return null;
    const r = document.createRange();
    try {
      r.setStart(startNode, Math.max(0, Math.min(startOff, startNode.nodeValue.length)));
      r.setEnd(endNode, Math.max(0, Math.min(endOff, endNode.nodeValue.length)));
    } catch { return null; }
    return r;
  },

  // Rect des aktuellen Satzes in der Leseansicht ins Sichtfeld nudgen. Die
  // `.page-content-view` ist (wie das Edit-Feld) ihr eigener Scroll-Container
  // (max-height + overflow-y:auto) -> scrollTop direkt nachziehen, nur wenn der
  // Satz ueber/unter den sichtbaren Rand rutscht. Eigene Methode statt
  // `_scrollEditCaretIntoView`, weil jene gegen den Edit-Container misst.
  _ttsScrollViewIntoView(rect) {
    const el = this._ttsGetReadEl();
    if (!el || !rect || (!rect.height && !rect.top && !rect.bottom)) return;
    const host = el.getBoundingClientRect();
    const margin = 28;
    if (rect.bottom > host.bottom - margin) {
      el.scrollTop += rect.bottom - (host.bottom - margin);
    } else if (rect.top < host.top + margin) {
      el.scrollTop -= (host.top + margin) - rect.top;
    }
  },

  // Den gerade vorgelesenen Satz markieren + ins Sichtfeld holen. Reiner
  // CSS-Custom-Highlight (keine DOM-Mutation). Leseansicht ist ihr eigener
  // Scroll-Container -> Rect des Satzes an den scrollTop-Nudge geben.
  _ttsHighlight(idx) {
    if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return;
    CSS.highlights.delete(TTS_HIGHLIGHT);
    const rt = activeRt;
    const seg = rt?.segs?.[idx];
    if (!seg || !seg.block?.isConnected) return;
    const range = this._ttsBuildRange(seg.block, seg.startOff, seg.endOff);
    if (!range) return;
    try { CSS.highlights.set(TTS_HIGHLIGHT, new Highlight(range)); } catch { return; }
    let rect = null;
    try { rect = range.getBoundingClientRect(); } catch { /* noop */ }
    this._ttsScrollViewIntoView(rect);
  },

  _ttsClearHighlight() {
    if (typeof CSS !== 'undefined' && CSS.highlights) CSS.highlights.delete(TTS_HIGHLIGHT);
  },

  // ── Toggle / Start / Stop ────────────────────────────────────────────────

  // Hauptbutton: idle -> starten; aktiv -> pausieren <-> fortsetzen.
  toggleTtsProof() {
    if (!this.$store.tts.enabled) return;
    const rt = activeRt;
    if (!this.$store.tts.playing || !rt) { this._ttsStart(); return; }
    if (this.$store.tts.paused) {
      rt.paused = false;
      this.$store.tts.paused = false;
      // War mitten in der Wiedergabe pausiert (Audio pending) -> dasselbe Element
      // weiterspielen; war beim Laden pausiert (kein aktives Audio) -> Schleife
      // neu antreiben.
      if (rt.resolveCurrent && rt.audio && !rt.audio.ended) {
        try { rt.audio.play(); } catch { /* noop */ }
      } else if (!rt.running) {
        // Beim Laden / in einer Inter-Fragment-Pause pausiert: die alte Schleife
        // laeuft ggf. noch (running) und nimmt den Resume selbst auf — dann hier
        // keine zweite anwerfen.
        this._ttsRun(rt);
      }
    } else {
      rt.paused = true;
      this.$store.tts.paused = true;
      try { rt.audio?.pause(); } catch { /* noop */ }
    }
  },

  // Naechsten Satz: aktuelles Audio beenden, Schleife rueckt auf i+1. Nur im
  // laufenden (nicht pausierten) Zustand sinnvoll — der Skip-Button ist im
  // pausierten Zustand ausgeblendet.
  skipTtsProof() {
    const rt = activeRt;
    if (!rt || this.$store.tts.paused) return;
    try { rt.audio?.pause(); } catch { /* noop */ }
    if (rt.resolveCurrent) {
      const r = rt.resolveCurrent;
      rt.resolveCurrent = null;
      r(true); // als "beendet" aufloesen -> Schleife geht zu i+1
    }
  },

  stopTtsProof() { this._ttsStop(); },

  _ttsStart() {
    if (!this.$store.tts.enabled || this.$store.tts.playing) return;
    const segs = this._ttsCollectSegments();
    if (!segs.length) {
      this._ttsLog('start aborted: no segments (empty text)');
      this._showJobToast?.({ message: this.t('tts.error.empty'), severity: 'info', jobType: 'tts', bookId: null });
      return;
    }
    this._ttsLog(`start segments=${segs.length} locale=${this._ttsLocaleCode()} book=${this.$store.nav.selectedBookId || '-'} page=${this.currentPage?.id || '-'}`);
    const rt = {
      segs,
      i: 0,
      cache: new Map(),     // idx -> Promise<objectURL|null>
      urls: new Set(),      // alle erzeugten Object-URLs (Revoke beim Stop)
      audio: null,
      paused: false,
      running: false,       // Re-Entry-Guard fuer _ttsRun (siehe dort)
      abort: new AbortController(),
      resolveCurrent: null, // beendet das aktuelle _ttsPlayUrl-Promise (Skip/Stop)
    };
    activeRt = rt;
    this._ttsFailToasted = false;
    this.$store.tts.playing = true;
    this.$store.tts.paused = false;
    this.$store.tts.loading = false;
    this.$store.tts.total = segs.length;
    this.$store.tts.index = 0;
    this._ttsRun(rt);
  },

  // Abspiel-Schleife: highlightet Satz i, laedt i (+Lookahead) vor, spielt ab,
  // rueckt vor. Alle Guards pruefen `activeRt === rt` — eine beendete oder
  // gewechselte Session bricht still ab.
  async _ttsRun(rt) {
    // Re-Entry-Guard: solange die Schleife laeuft (auch waehrend einer
    // Inter-Fragment-Pause oder eines Lade-Awaits), darf der Resume-Pfad in
    // `toggleTtsProof` keine zweite Schleife anwerfen — sonst spielen zwei
    // Schleifen parallel. `running` wird in `finally` garantiert zurueckgesetzt.
    if (rt.running) return;
    rt.running = true;
    try {
      while (activeRt === rt && rt.i < rt.segs.length) {
        if (rt.paused) return; // Fortsetzen treibt die Schleife neu an
        const idx = rt.i;
        this.$store.tts.index = idx + 1;
        this._ttsHighlight(idx);
        for (let k = 0; k <= TTS_PREFETCH_AHEAD; k++) this._ttsPrefetch(rt, idx + k);
        this.$store.tts.loading = true;
        const url = await rt.cache.get(idx);
        this.$store.tts.loading = false;
        if (activeRt !== rt || rt.paused) return;
        if (url == null) { this._ttsWarn(`segment ${idx} skipped (synth failed)`); rt.i++; continue; } // Fehler-Satz uebersprungen (schon getoastet)
        const ended = await this._ttsPlayUrl(rt, url);
        if (activeRt !== rt) return;
        if (!ended) return; // pausiert/gestoppt -> Steuerung liegt bei Toggle/Stop
        rt.i++;
        // Atempause vor dem naechsten Fragment (an Absatzgrenzen laenger). Dauer
        // vom Admin konfigurierbar (this.$store.tts.pause aus /config), Default via
        // Konstanten. 0 = keine Pause (kein unnoetiger Await). Kein Audio aktiv
        // -> nur via Stop abbrechbar (abort.signal); Pause waehrend der Pause
        // faengt der `rt.paused`-Return oben in der naechsten Runde.
        const next = rt.segs[rt.i];
        if (next) {
          const blockChange = next.block !== rt.segs[idx].block;
          const ms = blockChange
            ? (this.$store.tts.pause?.paragraphMs ?? TTS_PARAGRAPH_PAUSE_MS)
            : (this.$store.tts.pause?.fragmentMs ?? TTS_FRAGMENT_PAUSE_MS);
          if (ms > 0) {
            await this._ttsDelay(ms, rt.abort.signal);
            if (activeRt !== rt || rt.paused) return;
          }
        }
      }
      if (activeRt === rt) this._ttsStop(); // ans Ende gelesen
    } finally {
      rt.running = false;
    }
  },

  // Spielt eine Audio-URL; resolved true bei natuerlichem Ende (oder Defekt ->
  // weiter), false wenn von aussen (Stop) beendet. Pause/Resume operiert direkt
  // am Media-Element, ohne dieses Promise aufzuloesen — der Await bleibt offen.
  _ttsPlayUrl(rt, url) {
    return new Promise((resolve) => {
      const audio = new Audio(url);
      rt.audio = audio;
      rt.resolveCurrent = resolve;
      const done = (val) => {
        if (rt.resolveCurrent !== resolve) return;
        rt.resolveCurrent = null;
        resolve(val);
      };
      audio.addEventListener('ended', () => done(true));
      audio.addEventListener('error', () => {
        // Beim Stop setzt `_ttsStop` `audio.src = ''`, was ein spaeteres
        // MEDIA_ELEMENT_ERROR ("Empty src attribute") feuert. Da `activeRt`
        // dort vorher genullt wird, ist das nur Teardown-Rauschen -> still
        // verwerfen. Nur bei lebender Session ist es ein echter Defekt.
        if (activeRt !== rt) return;
        this._ttsWarn('audio playback error, skipping segment', audio.error?.message);
        done(true); // defektes Segment -> weiter
      });
      audio.play().catch((e) => { if (!rt.paused) { this._ttsWarn('audio.play() rejected, skipping segment', e?.message); done(true); } });
    });
  },

  // ── Synthese (Prefetch + Fetch) ───────────────────────────────────────────

  // Synthetisiert das Segment idx vorab und legt das Object-URL-Promise in den
  // Cache. Mehrfachaufruf ist no-op (Cache-Hit).
  _ttsPrefetch(rt, idx) {
    if (idx < 0 || idx >= rt.segs.length || rt.cache.has(idx)) return;
    const seg = rt.segs[idx];
    const p = this._ttsFetchAudio(seg.text, 0, rt.abort.signal)
      .then((blob) => {
        if (activeRt !== rt || !blob) return null;
        const objUrl = URL.createObjectURL(blob);
        rt.urls.add(objUrl);
        return objUrl;
      })
      .catch(() => null);
    rt.cache.set(idx, p);
  },

  // Synthetisiert einen Satz; gibt das Audio-Blob zurueck oder null (Fehler
  // bereits behandelt). Transiente Fehler (Netzwerk-Throw, 408/5xx) werden bis
  // TTS_MAX_RETRY-mal wiederholt. 404 (Feature aus) / 401 (Session abgelaufen)
  // stoppen die Session. `signal` (Session-AbortController) beendet Request UND
  // Retry-Wait sofort und still beim Stop.
  // Guillemet-Normalisierung fuer die Sprachausgabe (SSoT tts-segment.js).
  _ttsNormalizeForSpeech(text) { return normalizeForSpeech(text); },

  async _ttsFetchAudio(text, attempt, signal) {
    if (signal?.aborted) return null;
    text = this._ttsNormalizeForSpeech(text);
    const params = new URLSearchParams();
    if (this.$store.nav.selectedBookId) params.set('bookId', this.$store.nav.selectedBookId);
    if (this.currentPage?.id) params.set('pageId', this.currentPage.id);
    const qs = params.toString() ? `?${params}` : '';
    let res;
    try {
      res = await fetch(`/tts/speak${qs}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal,
      });
    } catch (e) {
      if (signal?.aborted || e?.name === 'AbortError') return null;
      if (attempt < TTS_MAX_RETRY) {
        this._ttsWarn(`fetch network error (attempt ${attempt + 1}/${TTS_MAX_RETRY + 1}), retrying`, e?.message);
        await this._ttsDelay(TTS_RETRY_DELAY_MS, signal);
        return this._ttsFetchAudio(text, attempt + 1, signal);
      }
      this._ttsWarn('fetch network error, giving up', e?.message);
      this._ttsToastFailed();
      return null;
    }
    if (res.status === 404 || res.status === 401) {
      this._ttsWarn(`fetch ${res.status} (${res.status === 404 ? 'feature disabled' : 'session expired'}) -> stop session`);
      this._ttsStop();
      return null;
    }
    if (!res.ok) {
      if (TTS_RETRYABLE_STATUS.has(res.status) && attempt < TTS_MAX_RETRY) {
        this._ttsWarn(`fetch ${res.status} (attempt ${attempt + 1}/${TTS_MAX_RETRY + 1}), retrying`);
        await this._ttsDelay(TTS_RETRY_DELAY_MS, signal);
        return this._ttsFetchAudio(text, attempt + 1, signal);
      }
      this._ttsWarn(`fetch ${res.status}, giving up`);
      this._ttsToastFailed();
      return null;
    }
    try {
      const blob = await res.blob();
      return blob && blob.size ? blob : null;
    } catch (e) {
      if (signal?.aborted || e?.name === 'AbortError') return null;
      this._ttsToastFailed();
      return null;
    }
  },

  _ttsDelay(ms, signal) {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const t = setTimeout(resolve, ms);
      signal?.addEventListener?.('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });
  },

  _ttsToastFailed() {
    if (this._ttsFailToasted) return; // nur einmal pro Session
    this._ttsFailToasted = true;
    this._showJobToast?.({ message: this.t('tts.error.failed'), severity: 'err', jobType: 'tts', bookId: null });
  },

  _ttsStop() {
    const rt = activeRt;
    activeRt = null; // Guard: laufende Schleife/Prefetches verwerfen ab hier
    this.$store.tts.playing = false;
    this.$store.tts.paused = false;
    this.$store.tts.loading = false;
    this.$store.tts.index = 0;
    this.$store.tts.total = 0;
    this._ttsClearHighlight();
    if (!rt) return;
    this._ttsLog(`stop at segment ${rt.i}/${rt.segs.length}`);
    try { rt.abort.abort(); } catch { /* noop */ }
    try { if (rt.audio) { rt.audio.pause(); rt.audio.src = ''; } } catch { /* noop */ }
    if (rt.resolveCurrent) {
      const r = rt.resolveCurrent;
      rt.resolveCurrent = null;
      r(false); // wartende Schleife beenden
    }
    for (const url of rt.urls) { try { URL.revokeObjectURL(url); } catch { /* noop */ } }
    rt.urls.clear();
  },
};
