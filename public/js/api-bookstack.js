import { SYSTEM_STILKORREKTUR, buildStilkorrekturPrompt } from './prompts.js';
import { SAFETY_HTML_RATIO } from './utils.js';

// Methoden für BookStack-API-Calls (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.
// Authorization-Header wird serverseitig vom Proxy injiziert.

export const bookstackMethods = {
  async bsGet(path) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('Timeout: BookStack hat nicht innerhalb von 30 Sekunden geantwortet')), 30000);
    try {
      const r = await fetch('/api/' + path, { signal: ctrl.signal });
      if (r.status === 401) { location.href = '/auth/login'; return; }
      if (!r.ok) throw new Error('BookStack API Fehler ' + r.status);
      return r.json();
    } catch (e) {
      if (e.name === 'AbortError') {
        throw new Error(ctrl.signal.reason?.message || 'Timeout: Anfrage wurde abgebrochen');
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
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
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('Timeout: BookStack hat nicht innerhalb von 90 Sekunden geantwortet')), 90000);
    try {
      const r = await fetch('/api/' + path, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (r.status === 401) { location.href = '/auth/login'; return; }
      if (!r.ok) {
        let detail = '';
        try { const e = await r.json(); detail = e.message || e.error || ''; } catch (_) {}
        throw new Error(`BookStack API Fehler ${r.status}${detail ? ': ' + detail : ''}`);
      }
      return r.json();
    } catch (e) {
      if (e.name === 'AbortError') {
        throw new Error(ctrl.signal.reason?.message || 'Timeout: Anfrage wurde abgebrochen');
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  },

  _applyCorrections(html, fehler) {
    let result = html;
    for (const f of fehler) {
      if (!f.original || !f.korrektur || f.original === f.korrektur) continue;
      const idx = result.indexOf(f.original);
      if (idx !== -1) {
        result = result.slice(0, idx) + f.korrektur + result.slice(idx + f.original.length);
      }
    }
    return result;
  },

  // Ruft den Stil-KI-Call auf und wendet Korrekturen an. Gibt das (ggf. korrigierte) HTML zurück.
  // onProgress(chars, aiBase) – optional, für zusätzliches Fortschritts-Tracking beim Aufrufer.
  async _applyStilkorrektur(html, selectedStyles, onProgress) {
    const aiBase = html.length || 1;
    this.setStatus('KI überarbeitet Stil… (0 Zeichen)', true);
    try {
      let completionInfo = null;
      const result = await this.callAI(
        buildStilkorrekturPrompt(html, selectedStyles),
        SYSTEM_STILKORREKTUR,
        (chars) => {
          this.setStatus(`KI überarbeitet Stil… (${chars} Zeichen)`, true);
          if (onProgress) onProgress(chars, aiBase);
        },
        ({ tokensIn, tokensOut, tokPerSec }) => { completionInfo = { tokensIn, tokensOut, tokPerSec }; }
      );
      if (completionInfo?.tokPerSec) {
        this.setStatus(`KI überarbeitet Stil… (${completionInfo.tokPerSec} tok/s)`, true);
      }
      if (Array.isArray(result?.korrekturen) && result.korrekturen.length > 0) {
        return this._applyCorrections(html, result.korrekturen.map(k => ({ original: k.original, korrektur: k.ersatz })));
      }
    } catch (e) {
      console.error('[_applyStilkorrektur]', e);
      this.setStatus('Stilkorrektur fehlgeschlagen – speichere übrige Korrekturen…', true);
    }
    return html;
  },

  // Gemeinsamer Kern für Lektorat-Save und History-Apply:
  // Seite frisch laden → Korrekturen anwenden → Stilkorrektur → Safety-Check → Speichern.
  // onProgress(pct, statusText) – Fortschritt (10–85), statusText nur bei Phasenwechsel.
  // Gibt das gespeicherte HTML zurück. Wirft bei Fehler.
  async _loadApplyAndSave(selectedErrors, selectedStyles, onProgress) {
    onProgress(10, 'Lade aktuelle Seite…');
    const page = await this.bsGet('pages/' + this.currentPage.id);

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
      throw new Error('Korrigiertes HTML wirkt unvollständig – Speichern abgebrochen.');
    }

    onProgress(85, 'Speichere in BookStack…');
    await this.bsPut('pages/' + this.currentPage.id, { html: finalHtml, name: this.currentPage.name });
    return finalHtml;
  },
};
