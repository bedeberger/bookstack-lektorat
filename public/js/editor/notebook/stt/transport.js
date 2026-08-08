// Uebertragung eines Segments an /stt/transcribe — inklusive Retry-Politik.
//
// Die Fetches laufen parallel (Durchsatz), die EINFUEGUNG wird ueber
// `rt.insertChain` in Sende-Reihenfolge serialisiert: sonst landete ein spaeter
// gesprochenes, aber schneller transkribiertes Segment vor einem frueheren im
// Text.

// Segment-Retry: transiente Upstream-Fehler mehrfach mit exponentiellem Backoff
// wiederholen, bevor der Fehler-Toast kommt — ein GPU-Cold-Start (Modell-Reload
// nach Idle) oder kurzzeitige Backend-Last kostet so keinen Satz. Die Retries
// laufen INNERHALB der insertChain (siehe _sttSendSegment) → Sprechreihenfolge
// bleibt erhalten, spaetere Segmente warten nur mit dem Einfuegen.
const STT_MAX_RETRY = 3;
const STT_RETRY_DELAY_MS = 800; // Basis; Backoff = base * 2^attempt, gedeckelt
const STT_RETRY_MAX_DELAY_MS = 6000;
const STT_RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export const sttTransportMethods = {
  // Transkribiert ein Segment und fuegt es ein. Der Fetch startet sofort (mehrere
  // Segmente transkribieren parallel), die EINFUEGUNG wird aber ueber
  // `rt.insertChain` in Sende-Reihenfolge serialisiert — so landet ein frueher
  // gesprochenes Segment auch dann vor einem spaeteren im Text, wenn dessen
  // Transkript (z. B. nach einem Retry) erst spaeter zurueckkommt. Der Guard
  // `this._sttRt === rt` verwirft Inserts, deren Session inzwischen beendet oder
  // gewechselt wurde (Stop, Seitenwechsel).
  _sttSendSegment(blob, mime, boundaryKind) {
    const rt = this._sttRt;
    if (!rt) return;
    this._sttBusyOn(); // Indikator „transkribiert" (mit Mindest-Standzeit)
    const fetchP = this._sttFetchTranscript(blob, mime, 0, rt.abort.signal)
      .finally(() => this._sttBusyOff());
    rt.insertChain = rt.insertChain
      .then(async () => {
        const text = await fetchP;
        if (text == null) return; // Fehler/Abbruch bereits behandelt (Toast/Stop)
        if (this._sttRt !== rt) return; // Session beendet -> nicht mehr einfuegen
        this._sttInsertText(text, boundaryKind);
      })
      .catch(() => { /* ein fehlgeschlagener Insert darf die Kette nicht brechen */ });
  },

  // Transkribiert ein Segment; gibt den Text zurueck oder null (Fehler bereits
  // behandelt). Transiente Fehler (Netzwerk-Throw, 408/5xx) werden bis zu
  // STT_MAX_RETRY-mal wiederholt, bevor der Fehler-Toast kommt — ein kurzer
  // Upstream-Haenger kostet so keinen Satz. 404 (Feature aus) und 4xx
  // (z. B. 413/415) werden NICHT wiederholt. `signal` (Session-AbortController)
  // beendet Request UND Retry-Wait sofort und still beim Stop — ein
  // abgebrochenes Segment liefert `null` ohne Fehler-Toast.
  async _sttFetchTranscript(blob, mime, attempt, signal) {
    if (signal?.aborted) return null; // Session beendet -> still verwerfen
    const params = new URLSearchParams();
    if (this.$store.nav.selectedBookId) params.set('bookId', this.$store.nav.selectedBookId);
    if (this.currentPage?.id) params.set('pageId', this.currentPage.id);
    const qs = params.toString() ? `?${params}` : '';
    let res;
    try {
      res = await fetch(`/stt/transcribe${qs}`, {
        method: 'POST',
        headers: { 'Content-Type': mime },
        body: blob,
        signal,
      });
    } catch (e) {
      if (signal?.aborted || e?.name === 'AbortError') return null; // Stop -> kein Toast/Retry
      if (attempt < STT_MAX_RETRY) {
        await this._sttDelay(this._sttRetryDelay(attempt), signal);
        return this._sttFetchTranscript(blob, mime, attempt + 1, signal);
      }
      this._sttToastFailed();
      return null;
    }
    if (res.status === 404) { this._sttStop(); return null; } // Feature serverseitig aus
    // 401 = Session abgelaufen: der globale fetch-Wrapper (app.js) hat bereits
    // den Session-Banner ausgeloest. Hier nur die Aufnahme stoppen (logged-out =
    // kein Diktat) — KEIN Fehler-Toast (der Banner kommuniziert es) und keine
    // Toast-Flut pro Folgesegment. Analog zum 404-Zweig.
    if (res.status === 401) { this._sttStop(); return null; }
    if (!res.ok) {
      if (STT_RETRYABLE_STATUS.has(res.status) && attempt < STT_MAX_RETRY) {
        await this._sttDelay(this._sttRetryDelay(attempt), signal);
        return this._sttFetchTranscript(blob, mime, attempt + 1, signal);
      }
      this._sttToastFailed();
      return null;
    }
    // 200 mit kaputtem Body (Server-/Proxy-Fehler): nicht stumm verwerfen.
    // Bei Abort waehrend des Body-Reads aber still bleiben (Stop).
    try {
      return (await res.json())?.text || '';
    } catch (e) {
      if (signal?.aborted || e?.name === 'AbortError') return null;
      this._sttToastFailed();
      return null;
    }
  },

  // Exponentieller Backoff fuer den Retry-Wait: base * 2^attempt, gedeckelt.
  // Gibt dem Backend bei Last/Cold-Start zunehmend Zeit, statt es zu hetzen.
  _sttRetryDelay(attempt) {
    return Math.min(STT_RETRY_DELAY_MS * (2 ** attempt), STT_RETRY_MAX_DELAY_MS);
  },

  // Verzoegerung fuer Retry-Waits; loest beim Abort der Session sofort auf, damit
  // ein laufender Retry-Wait das Stoppen nicht um STT_RETRY_DELAY_MS verzoegert
  // (der Aufrufer verwirft danach via `signal.aborted`-Guard).
  _sttDelay(ms, signal) {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const t = setTimeout(resolve, ms);
      signal?.addEventListener?.('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });
  },

  _sttToastFailed() {
    this._showJobToast?.({ message: this.t('stt.error.failed'), severity: 'err', jobType: 'stt', bookId: null });
  },
};
