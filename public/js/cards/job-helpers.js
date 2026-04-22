// Pure Job-Helper — extrahiert aus app-jobs-core.js, damit Sub-Komponenten
// das Polling nutzen können, ohne `this._startPoll` am Root zu verlangen.
// Der Root behält seine Methoden-Wrapper für Rückwärtskompatibilität
// (lektorat/figuren/komplett rufen weiterhin `this._startPoll(…)`).

import { escHtml, fmtTok } from '../utils.js';

// Generischer Job-Poller. `ctx` ist das Komponenten-Objekt, in dessen Feldern
// `timerProp` und `progressProp` geschrieben wird. Root-Kontext: `ctx` = die
// Alpine-Komponente. Sub-Kontext: `ctx` = die Sub-Komponente selbst.
//
// config: { timerProp, jobId, lsKey?, progressProp?, onProgress, onNotFound, onError, onDone }
export function startPoll(ctx, config) {
  if (ctx[config.timerProp]) clearInterval(ctx[config.timerProp]);
  ctx[config.timerProp] = setInterval(async () => {
    try {
      const resp = await fetch('/jobs/' + config.jobId);
      if (resp.status === 404) {
        clearInterval(ctx[config.timerProp]);
        ctx[config.timerProp] = null;
        if (config.lsKey) localStorage.removeItem(config.lsKey);
        config.onNotFound?.();
        return;
      }
      if (!resp.ok) return;
      const job = await resp.json();
      if (config.progressProp) ctx[config.progressProp] = job.progress || 0;
      if (job.status === 'running' || job.status === 'queued') { config.onProgress?.(job); return; }
      clearInterval(ctx[config.timerProp]);
      ctx[config.timerProp] = null;
      if (config.lsKey) localStorage.removeItem(config.lsKey);
      if (job.status === 'cancelled') { await config.onError?.(job); return; }
      if (job.status === 'error') await config.onError?.(job);
      else await config.onDone?.(job);
    } catch (e) { console.error('[poll ' + config.timerProp + ']', e); }
  }, 2000);
}

// Baut das Status-HTML für einen laufenden Job. `translate` ist die i18n-Funktion
// (in Root: this.t, in Sub: window.__app.t) — via expliziten Parameter entkoppelt.
export function runningJobStatus(translate, statusText, tokIn, tokOut, maxTokOut, progress, tokPerSec, statusParams) {
  let tokInfo = '';
  if ((tokIn || 0) + (tokOut || 0) > 0) {
    const pctPart = (progress > 0 && progress < 100) ? ` ~${progress}%` : '';
    const tpsPart = tokPerSec ? ` · ${Math.round(tokPerSec)} tok/s` : '';
    const inPart = (tokIn || 0) > 0 ? `↑${fmtTok(tokIn)} ` : '';
    tokInfo = ` · ${inPart}↓${fmtTok(tokOut || 0)} Tokens${pctPart}${tpsPart}`;
  }
  // statusText kann ein i18n-Key sein (z.B. 'job.phase.extracting') oder freier Text.
  // tRaw gibt unbekannte Keys 1:1 zurück, damit Legacy-Text pass-through funktioniert.
  const label = statusText ? translate(statusText, statusParams) : '…';
  return `<span class="spinner"></span>${escHtml(label)}${tokInfo}`;
}
