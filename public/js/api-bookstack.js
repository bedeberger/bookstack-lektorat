import { buildStilkorrekturPrompt } from './prompts.js';
import { SAFETY_HTML_RATIO, replaceInHtml, stripFocusArtefacts, fmtTok } from './utils.js';

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

// Bust SW-API_CACHE nach BookStack-Writes. Ohne diese Invalidierung serviert
// SWR auf Folge-Reads (Editor-Open, Lektorat-Save, Chat-Vorschlag) den alten
// Stand — und ein Read-Modify-Write-Pfad überschreibt frische Server-Edits
// mit Stale-Daten. Aufruf nach jedem erfolgreichen `_bsWrite('PUT'|'POST'|...)`.
export function _invalidateApiCache(paths) {
  if (typeof navigator === 'undefined') return;
  const ctrl = navigator.serviceWorker?.controller;
  if (!ctrl) return;
  const arr = Array.isArray(paths) ? paths : [paths];
  try { ctrl.postMessage({ type: 'invalidate-api', paths: arr }); } catch {}
}

export const bookstackMethods = {
  async bsGet(path, opts = {}) {
    let lastStatus = 0;
    // Bypass-Marker: SW (public/sw.js) sieht `?__fresh=1` und umgeht den
    // SWR-Cache. Nötig für konsistenzkritische Reads (Editor-Open, Re-Klick),
    // sonst kann eine veraltete Version aus dem API-Cache rendern.
    const url = '/api/' + path + (opts.fresh ? (path.includes('?') ? '&' : '?') + '__fresh=1' : '');
    for (let attempt = 0; attempt <= MAX_RETRY_429; attempt++) {
      let r;
      try {
        r = await _fetchWithTimeout(url, {}, 30000, this.t('bs.timeoutGet'));
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
      if (r.ok) {
        // Pages-Cache nach Write busten — Folge-Reads müssen die neue Fassung
        // sehen, sonst überschreibt der nächste Read-Modify-Write Server-Edits
        // mit Stale-Daten aus dem SWR-Cache.
        _invalidateApiCache(path);
        return r.json();
      }
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
      result = replaceInHtml(result, f.original, f.korrektur);
    }
    return result;
  },

  // Ruft den Stil-KI-Call auf und wendet Korrekturen an.
  // Liefert { html, log, appliedStyles } – log enthält requested/returned/applied/items/error
  // für Debugging und Persistenz in page_checks.stilkorrektur_log.
  // hardOriginals: Originaltexte der Hard-Findings, die VOR der Stilkorrektur
  // schon ins HTML appliziert wurden — Stil-Findings, deren `original` sich mit
  // einem dieser Hard-Strings überschneidet, werden vor dem KI-Call gefiltert
  // (sonst sucht die KI Texte, die so nicht mehr im HTML stehen).
  async _applyStilkorrektur(html, selectedStyles, onProgress, hardOriginals = []) {
    const aiBase = html.length || 1;
    const log = {
      requested: selectedStyles.length,
      returned: 0,
      applied: 0,
      items: [],
      error: null,
      attempted_at: new Date().toISOString(),
    };
    // (1) Überlappungs-Filter: Stil-Findings, deren Originaltext sich mit einem
    // ausgewählten Hard-Finding überlappt (Substring in eine Richtung), schon
    // vor dem KI-Call droppen. Loggen mit reason='overlapped_with_hard'.
    const usableStyles = [];
    for (const s of selectedStyles) {
      const orig = s.original || '';
      const overlap = orig && hardOriginals.some(h => h && (h.includes(orig) || orig.includes(h)));
      if (overlap) {
        log.items.push({
          original: orig,
          ersatz: s.korrektur || '',
          applied: false,
          reason: 'overlapped_with_hard',
        });
      } else {
        usableStyles.push(s);
      }
    }
    if (usableStyles.length === 0) {
      console.info(`[stilkorrektur] requested=${log.requested} all dropped (overlapped_with_hard)`);
      return { html, log, appliedStyles: [] };
    }
    this.setStatus(this.t('stilkorrektur.workingChars', { chars: 0 }), true);
    try {
      let completionInfo = null;
      const result = await this.callAI(
        buildStilkorrekturPrompt(html, usableStyles),
        'stilkorrektur',
        (chars, tokIn) => {
          // tokensIn ist erst ab message_start verfügbar; tokensOut erst am Ende.
          // Bis tokensIn da ist: chars-Fallback. Danach: ↑in↓~out (chars/4-Schätzung,
          // Provider-Tokenizer divergieren → ~).
          const status = (tokIn > 0)
            ? this.t('stilkorrektur.workingTokens', {
                tokIn: fmtTok(tokIn),
                tokOutEst: fmtTok(Math.round(chars / 4)),
              })
            : this.t('stilkorrektur.workingChars', { chars });
          this.setStatus(status, true);
          if (onProgress) onProgress(chars, aiBase);
        },
        ({ tokensIn, tokensOut, tokPerSec }) => { completionInfo = { tokensIn, tokensOut, tokPerSec }; }
      );
      if (completionInfo) {
        this.setStatus(this.t('stilkorrektur.done', {
          tokIn: fmtTok(completionInfo.tokensIn || 0),
          tokOut: fmtTok(completionInfo.tokensOut || 0),
          tps: completionInfo.tokPerSec ? Math.round(completionInfo.tokPerSec) : 0,
        }), true);
      }
      const korrekturen = Array.isArray(result?.korrekturen) ? result.korrekturen : [];
      log.returned = korrekturen.length;
      let outHtml = html;
      // Per usableStyle merken, ob sie applied wurde – Mapping primär via
      // index-Feld der KI (1-basiert auf Liste oben), Fallback positional bei
      // Count-Match (KI liefert genau ebensoviele Einträge wie verlangt).
      const styleApplied = new Array(usableStyles.length).fill(false);
      const countMatches = korrekturen.length === usableStyles.length;
      for (let i = 0; i < korrekturen.length; i++) {
        const k = korrekturen[i];
        const skip = !k.original || !k.ersatz || k.original === k.ersatz;
        const before = outHtml;
        const after = skip ? before : replaceInHtml(outHtml, k.original, k.ersatz);
        const applied = !skip && after !== before;
        // Style-Index ableiten: KI-`index` bevorzugen, sonst positional bei Count-Match.
        let styleIdx = null;
        if (Number.isInteger(k.index)) {
          const cand = k.index - 1;
          if (cand >= 0 && cand < usableStyles.length) styleIdx = cand;
        }
        if (styleIdx === null && countMatches) styleIdx = i;
        log.items.push({
          index: k.index ?? null,
          style_idx: styleIdx,
          original: k.original || '',
          ersatz: k.ersatz || '',
          applied,
          reason: skip ? 'empty_or_identical' : (applied ? null : 'not_found_in_html'),
        });
        if (applied) {
          log.applied++;
          outHtml = after;
          if (styleIdx !== null) styleApplied[styleIdx] = true;
        }
      }
      const appliedStyles = usableStyles.filter((_, i) => styleApplied[i]);
      const dropped = log.requested - usableStyles.length;
      console.info(`[stilkorrektur] requested=${log.requested} dropped_overlap=${dropped} returned=${log.returned} applied=${log.applied} mappable=${appliedStyles.length}`);
      return { html: outHtml, log, appliedStyles };
    } catch (e) {
      console.error('[_applyStilkorrektur]', e);
      log.error = e?.message || String(e);
      this.setStatus(this.t('stilkorrektur.failed'), true);
      return { html, log, appliedStyles: [] };
    }
  },

  // Gemeinsamer Kern für Lektorat-Save und History-Apply:
  // Seite frisch laden → Korrekturen anwenden → Stilkorrektur → Safety-Check → Speichern.
  // onProgress(pct, statusText) – Fortschritt (10–85), statusText nur bei Phasenwechsel.
  // Liefert { finalHtml, stilLog } (stilLog null wenn keine Stil-Findings). Wirft bei Fehler.
  async _loadApplyAndSave(selectedErrors, selectedStyles, onProgress) {
    onProgress(10, this.t('bs.loadingPage'));
    // `fresh: true` umgeht SWR — sonst kann der API_CACHE nach kurz zuvor
    // gesetzten Edits noch die alte Fassung liefern, und der gleich folgende
    // PUT würde frische Server-Edits mit Stale-Daten überschreiben.
    const page = await this.bsGet('pages/' + this.currentPage.id, { fresh: true });
    page.html = stripFocusArtefacts(page.html || '');

    let finalHtml = selectedErrors.length > 0
      ? this._applyCorrections(page.html, selectedErrors)
      : page.html;

    let stilLog = null;
    let appliedStyles = [];
    if (selectedStyles.length > 0) {
      onProgress(30, null);
      const hardOriginals = selectedErrors.map(e => e?.original).filter(Boolean);
      const r = await this._applyStilkorrektur(
        finalHtml,
        selectedStyles,
        (chars, aiBase) => onProgress(Math.min(70, 30 + Math.round((chars / aiBase) * 40)), null),
        hardOriginals,
      );
      finalHtml = r.html;
      stilLog = r.log;
      appliedStyles = r.appliedStyles || [];
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
    return { finalHtml, stilLog, appliedStyles };
  },
};
