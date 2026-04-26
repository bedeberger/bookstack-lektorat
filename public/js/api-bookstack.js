import { buildStilkorrekturPrompt } from './prompts.js';
import { SAFETY_HTML_RATIO, findInHtml, stripFocusArtefacts } from './utils.js';

// Methoden für BookStack-API-Calls (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.
// Authorization-Header wird serverseitig vom Proxy injiziert.

// Retry-After: Sekunden (Integer) ODER HTTP-Date. Liefert Millisekunden zum Warten,
// gedeckelt auf 30 s damit ein böser Header die UI nicht ewig blockiert.
function _parseRetryAfter(raw) {
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(30000, Math.round(secs * 1000));
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.min(30000, Math.max(0, date - Date.now()));
  return null;
}

// Wrapper um fetch mit eigenem Timeout. Liefert die Response (auch bei 429),
// damit der Aufrufer entscheiden kann, ob retried wird.
async function _fetchWithTimeout(url, opts, timeoutMs, abortMsg) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(abortMsg)), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

const MAX_RETRY_429 = 3;

export const bookstackMethods = {
  async bsGet(path) {
    let lastStatus = 0;
    for (let attempt = 0; attempt <= MAX_RETRY_429; attempt++) {
      let r;
      try {
        r = await _fetchWithTimeout('/api/' + path, {}, 30000, this.t('bs.timeoutGet'));
      } catch (e) {
        if (e.name === 'AbortError') {
          throw new Error(e.message || this.t('bs.timeoutAborted'));
        }
        throw e;
      }
      if (r.ok) return r.json();
      lastStatus = r.status;
      if (r.status !== 429 || attempt === MAX_RETRY_429) break;
      const wait = _parseRetryAfter(r.headers.get('Retry-After'))
        ?? Math.min(8000, 1000 * Math.pow(2, attempt));
      await new Promise(rs => setTimeout(rs, wait));
    }
    throw new Error(this.t('bs.apiError', { status: lastStatus }));
  },

  async bsGetAll(path) {
    const COUNT = 500;
    let offset = 0, all = [];
    while (true) {
      const sep = path.includes('?') ? '&' : '?';
      const data = await this.bsGet(`${path}${sep}count=${COUNT}&offset=${offset}`);
      all = all.concat(data.data);
      if (all.length >= data.total) break;
      offset += COUNT;
    }
    return all;
  },

  async bsPut(path, body) {
    return this._bsWrite('PUT', path, body);
  },

  async bsPost(path, body) {
    return this._bsWrite('POST', path, body);
  },

  async _bsWrite(method, path, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
    let lastRes = null;
    for (let attempt = 0; attempt <= MAX_RETRY_429; attempt++) {
      let r;
      try {
        r = await _fetchWithTimeout('/api/' + path, opts, 90000, this.t('bs.timeoutPut'));
      } catch (e) {
        if (e.name === 'AbortError') {
          throw new Error(e.message || this.t('bs.timeoutAborted'));
        }
        throw e;
      }
      if (r.ok) return r.json();
      lastRes = r;
      if (r.status !== 429 || attempt === MAX_RETRY_429) break;
      const wait = _parseRetryAfter(r.headers.get('Retry-After'))
        ?? Math.min(8000, 1000 * Math.pow(2, attempt));
      await new Promise(rs => setTimeout(rs, wait));
    }
    let detail = '';
    try { const e = await lastRes.json(); detail = e.message || e.error || ''; } catch (_) {}
    throw new Error(detail
      ? this.t('bs.apiErrorDetail', { status: lastRes.status, detail })
      : this.t('bs.apiError', { status: lastRes.status }));
  },

  _applyCorrections(html, fehler) {
    let result = html;
    for (const f of fehler) {
      if (!f.original || !f.korrektur || f.original === f.korrektur) continue;
      const m = findInHtml(result, f.original);
      if (m) result = result.slice(0, m.htmlStart) + f.korrektur + result.slice(m.htmlEnd);
    }
    return result;
  },

  // Ruft den Stil-KI-Call auf und wendet Korrekturen an. Gibt das (ggf. korrigierte) HTML zurück.
  // onProgress(chars, aiBase) – optional, für zusätzliches Fortschritts-Tracking beim Aufrufer.
  async _applyStilkorrektur(html, selectedStyles, onProgress) {
    const aiBase = html.length || 1;
    this.setStatus(this.t('stilkorrektur.working', { chars: 0 }), true);
    try {
      let completionInfo = null;
      const result = await this.callAI(
        buildStilkorrekturPrompt(html, selectedStyles),
        'stilkorrektur',
        (chars) => {
          this.setStatus(this.t('stilkorrektur.working', { chars }), true);
          if (onProgress) onProgress(chars, aiBase);
        },
        ({ tokensIn, tokensOut, tokPerSec }) => { completionInfo = { tokensIn, tokensOut, tokPerSec }; }
      );
      if (completionInfo?.tokPerSec) {
        this.setStatus(this.t('stilkorrektur.tps', { tps: completionInfo.tokPerSec }), true);
      }
      if (Array.isArray(result?.korrekturen) && result.korrekturen.length > 0) {
        return this._applyCorrections(html, result.korrekturen.map(k => ({ original: k.original, korrektur: k.ersatz })));
      }
    } catch (e) {
      console.error('[_applyStilkorrektur]', e);
      this.setStatus(this.t('stilkorrektur.failed'), true);
    }
    return html;
  },

  // Gemeinsamer Kern für Lektorat-Save und History-Apply:
  // Seite frisch laden → Korrekturen anwenden → Stilkorrektur → Safety-Check → Speichern.
  // onProgress(pct, statusText) – Fortschritt (10–85), statusText nur bei Phasenwechsel.
  // Gibt das gespeicherte HTML zurück. Wirft bei Fehler.
  async _loadApplyAndSave(selectedErrors, selectedStyles, onProgress) {
    onProgress(10, this.t('bs.loadingPage'));
    const page = await this.bsGet('pages/' + this.currentPage.id);
    page.html = stripFocusArtefacts(page.html || '');

    let finalHtml = selectedErrors.length > 0
      ? this._applyCorrections(page.html, selectedErrors)
      : page.html;

    if (selectedStyles.length > 0) {
      onProgress(30, null);
      finalHtml = await this._applyStilkorrektur(
        finalHtml,
        selectedStyles,
        (chars, aiBase) => onProgress(Math.min(70, 30 + Math.round((chars / aiBase) * 40)), null),
      );
    }

    if (finalHtml.length < page.html.length * SAFETY_HTML_RATIO) {
      throw new Error(this.t('bs.unsafeHtml'));
    }

    onProgress(85, this.t('bs.savingToBookStack'));
    const saved = await this.bsPut('pages/' + this.currentPage.id, { html: finalHtml, name: this.currentPage.name });
    if (saved?.updated_at) this.currentPage.updated_at = saved.updated_at;
    // Übernommene Korrekturen sind eine direkte Folge des Lektorats — Seite soll nicht
    // unmittelbar danach auf "seit Lektorat bearbeitet" flippen.
    this.markPageChecked?.(this.currentPage.id);
    this._syncPageStatsAfterSave?.(this.currentPage, finalHtml);
    return finalHtml;
  },
};
