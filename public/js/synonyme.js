import { escHtml } from './utils.js';
import { SYSTEM_SYNONYM_CHECK, buildSynonymCheckPrompt } from './prompts.js';

// Synonymanalyse-Methoden (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.

export const synonymeMethods = {

  // ── Karte öffnen/schliessen ─────────────────────────────────────────────────

  async toggleSynonymeCard() {
    if (this.showSynonymeCard) {
      this.showSynonymeCard = false;
      return;
    }
    if (!this.currentPage) return;
    this.showSynonymeCard = true;

    // Prüfen ob ein Synonymanalyse-Job für diese Seite noch läuft
    if (!this._synonymePollTimer && !this.synonymeLoading) {
      try {
        const { jobId } = await fetch(`/jobs/active?type=synonyme&book_id=${this.currentPage.id}`).then(r => r.json());
        if (jobId) {
          this.synonymeLoading  = true;
          this.synonymeProgress = 0;
          this.synonymeStatus   = this._runningJobStatus('Analyse läuft bereits…', 0, 0);
          this._startSynonymPoll(jobId);
        }
      } catch (e) { console.error('[toggleSynonymeCard active-job check]', e); }
    }
  },

  // ── Analyse ─────────────────────────────────────────────────────────────────

  async runSynonymanalyse() {
    if (!this.currentPage || this.synonymeLoading) return;
    this.synonymeLoading = true;
    this.synonymeResult  = null;
    this.synonymeStatus  = '';
    this.synonymeProgress = 0;

    try {
      const { jobId } = await fetch('/jobs/synonyme', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page_id: this.currentPage.id }),
      }).then(r => r.json());

      this._startSynonymPoll(jobId);
    } catch (e) {
      console.error('[runSynonymanalyse]', e);
      this.synonymeStatus  = `<span class="error-msg">Fehler: ${escHtml(e.message)}</span>`;
      this.synonymeLoading = false;
    }
  },

  _startSynonymPoll(jobId) {
    this._startPoll({
      timerProp:    '_synonymePollTimer',
      progressProp: 'synonymeProgress',
      jobId,
      lsKey: null,
      onProgress: (job) => {
        this.synonymeStatus = this._runningJobStatus(job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut, job.progress);
      },
      onNotFound: () => {
        this.synonymeLoading  = false;
        this.synonymeProgress = 0;
        this.synonymeStatus   = '<span class="error-msg">Job nicht gefunden.</span>';
      },
      onError: (job) => {
        this.synonymeLoading  = false;
        this.synonymeProgress = 0;
        this.synonymeStatus   = `<span class="error-msg">Fehler: ${escHtml(job.error || 'Unbekannter Fehler')}</span>`;
      },
      onDone: (job) => {
        this.synonymeLoading  = false;
        this.synonymeProgress = 0;
        if (job.result?.empty) {
          this.synonymeStatus = '<span class="muted-msg">Seite ist leer.</span>';
          return;
        }
        this.synonymeHtml   = job.result.pageHtml || '';
        this.synonymeResult = { woerter: job.result.woerter };
        this._annotatePassages();
        this.synonymeStatus = job.result.woerter.length === 0
          ? '<span class="muted-msg">Keine auffälligen Wortwiederholungen gefunden.</span>'
          : '';
      },
    });
  },

  // Baut einen Regex-String, der die Passage im HTML findet – HTML-Tags zwischen
  // Wörtern werden erlaubt (z.B. <em>…</em>, <strong>…</strong>).
  _passageToHtmlRegex(passage) {
    return passage
      .split(' ')
      .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('(?:\\s|<[^>]*>)+');
  },

  // Durchsucht synonymeHtml einmal pro Wort und speichert Index + Länge des
  // HTML-Treffers in vorkommen._htmlIdx / vorkommen._htmlLen.
  // Sucht sequenziell (searchFrom rückt vor), damit bei identischen Sätzen
  // jedes Vorkommen seiner tatsächlichen Position im Text zugeordnet wird.
  // Berücksichtigt Inline-Tags (z.B. <em>) innerhalb des Satzes.
  _annotatePassages() {
    const html = this.synonymeHtml;
    for (const w of this.synonymeResult.woerter) {
      let searchFrom = 0;
      for (const vork of w.vorkommen) {
        // Exakter Treffer zuerst (kein Inline-HTML im Satz)
        const directIdx = html.indexOf(vork.passage, searchFrom);
        if (directIdx !== -1) {
          vork._htmlIdx = directIdx;
          vork._htmlLen = vork.passage.length;
          searchFrom = directIdx + 1;
          continue;
        }
        // Fallback: tag-toleranter Regex (Inline-Tags zwischen Wörtern)
        const match = new RegExp(this._passageToHtmlRegex(vork.passage)).exec(html.slice(searchFrom));
        if (match) {
          vork._htmlIdx = searchFrom + match.index;
          vork._htmlLen = match[0].length;
          searchFrom = vork._htmlIdx + 1;
        } else {
          vork._htmlIdx = -1;
          vork._htmlLen = -1;
        }
      }
    }
  },

  // ── Synonym für eine Textstelle anwenden ────────────────────────────────────

  async applySynonym(wort, synonym, passage, htmlIdx, wortIdx, vorkIdx) {
    if (!this.synonymeHtml || !this.currentPage) return;

    const htmlLen = this.synonymeResult.woerter[wortIdx]?.vorkommen[vorkIdx]?._htmlLen ?? -1;
    const newHtml = this._applyWordInPassage(this.synonymeHtml, passage, wort, synonym, htmlIdx, htmlLen);

    if (newHtml === null) {
      this.synonymeStatus = `<span class="error-msg">Textstelle nicht mehr auffindbar – bitte Analyse neu starten.</span>`;
      return;
    }

    try {
      // Plausibilitätsprüfung: KI prüft ob das Synonym im Kontext korrekt ist.
      // passageNach = tatsächlicher Satz nach Ersetzung (Plaintext), damit der
      // Check den Ergebnis-Satz explizit sieht (z.B. verwaiste Verbpräfixe).
      this.synonymeStatus = `<span class="muted-msg">Plausibilisiere…</span>`;
      const escapedWort = wort.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const wortRe = new RegExp(`(?<![a-zA-ZäöüÄÖÜß0-9])${escapedWort}(?![a-zA-ZäöüÄÖÜß0-9])`);
      const passageNach = passage.replace(wortRe, synonym);
      let checkOk = true;
      let checkBegruendung = null;
      try {
        const check = await this.callAI(
          buildSynonymCheckPrompt(passage, passageNach, wort, synonym),
          SYSTEM_SYNONYM_CHECK
        );
        checkOk = check?.ok !== false;
        checkBegruendung = check?.begruendung || null;
      } catch (e) {
        console.warn('[applySynonym] Plausibilitätsprüfung fehlgeschlagen, fahre fort:', e.message);
      }

      if (!checkOk) {
        this.synonymeStatus = `<span class="error-msg">Synonym nicht passend: ${escHtml(checkBegruendung || 'Bitte anderen Vorschlag wählen.')}</span>`;
        return;
      }

      await this.bsPut('pages/' + this.currentPage.id, { html: newHtml });
      this.synonymeHtml = newHtml;
      // Vorkommen als erledigt markieren und alle Indizes neu berechnen,
      // da sich durch die Längenänderung Positionen verschoben haben können.
      this.synonymeResult.woerter[wortIdx].vorkommen[vorkIdx]._applied = synonym;
      this._annotatePassages();
      this.synonymeStatus = `<span class="success-msg">«${escHtml(wort)}» → «${escHtml(synonym)}» gespeichert.</span>`;
      setTimeout(() => {
        if (this.synonymeStatus.includes('gespeichert')) this.synonymeStatus = '';
      }, 3000);
    } catch (e) {
      console.error('[applySynonym]', e);
      this.synonymeStatus = `<span class="error-msg">Fehler beim Speichern: ${escHtml(e.message)}</span>`;
    }
  },

  // Ersetzt `wort` innerhalb der HTML-Passage an Position `htmlIdx`/`htmlLen`.
  // Unterstützt Inline-Tags (z.B. <em>) innerhalb des Satzes.
  // Prüft zuerst die gespeicherte Position; fällt auf tag-toleranten Regex zurück.
  // Gibt null zurück wenn die Textstelle nicht gefunden oder das Wort nicht ersetzt werden kann.
  _applyWordInPassage(html, passage, wort, synonym, htmlIdx, htmlLen) {
    let idx = -1;
    let len = passage.length;

    // Gespeicherte Position prüfen (exakter Treffer aus _annotatePassages)
    if (htmlIdx >= 0 && htmlLen > 0) {
      const candidate = html.slice(htmlIdx, htmlIdx + htmlLen);
      const stripped = candidate.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (stripped === passage.trim()) {
        idx = htmlIdx;
        len = htmlLen;
      }
    }

    // Fallback: tag-toleranter Regex (erneute Suche)
    if (idx === -1) {
      const match = new RegExp(this._passageToHtmlRegex(passage)).exec(html);
      if (match) { idx = match.index; len = match[0].length; }
    }

    if (idx === -1) return null;

    const htmlPassage = html.slice(idx, idx + len);
    const escaped = wort.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<![a-zA-ZäöüÄÖÜß0-9])${escaped}(?![a-zA-ZäöüÄÖÜß0-9])`);
    const newPassage = htmlPassage.replace(re, synonym);
    if (newPassage === htmlPassage) return null; // Wort nicht in HTML-Passage gefunden

    return html.slice(0, idx) + newPassage + html.slice(idx + len);
  },

  // Hebt `wort` in `passage` mit <mark> hervor (für die UI-Darstellung).
  _highlightWord(passage, wort) {
    const escaped = wort.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(
      `(?<![a-zA-ZäöüÄÖÜß0-9])${escaped}(?![a-zA-ZäöüÄÖÜß0-9])`,
      'g'
    );
    return passage
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(re, m => `<mark>${m}</mark>`);
  },

  // ── Reset ────────────────────────────────────────────────────────────────────

  resetSynonymeCard() {
    if (this._synonymePollTimer) { clearInterval(this._synonymePollTimer); this._synonymePollTimer = null; }
    this.showSynonymeCard  = false;
    this.synonymeLoading   = false;
    this.synonymeProgress  = 0;
    this.synonymeResult    = null;
    this.synonymeStatus    = '';
    this.synonymeHtml      = null;
  },
};
