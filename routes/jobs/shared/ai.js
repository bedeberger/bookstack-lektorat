'use strict';
const { callAI, parseJSON, CHARS_PER_TOKEN, getContextConfigFor, resolveProvider } = require('../../../lib/ai');
const appSettings = require('../../../lib/app-settings');
const { jobAbortControllers } = require('./state');
const { updateJob, i18nError } = require('./jobs');

// Transient-Klassifikator: Claude-Streams droppen gelegentlich mid-flight als
// 'terminated' (Undici-Socket-Reset) oder werden vom Hard-Timeout (`AI_TIMEOUT`)
// nach `ai.claude.timeout_ms` abgebrochen. Beides ist nicht-fatal: ein erneuter
// Versuch erwischt typischerweise einen warmen Anthropic-Prompt-Cache (von
// parallelen oder vorhergehenden Chunks geschrieben) und laeuft deutlich
// schneller durch. JSON-Parse-Failures (Modell-Output) sind dagegen
// deterministisch → kein Retry.
function _isTransientAiError(e) {
  if (!e) return false;
  if (e.code === 'AI_TIMEOUT') return true;
  const msg = (e.message || '').toLowerCase();
  if (msg.includes('terminated')) return true;
  if (e.cause && /UND_ERR_SOCKET|ECONNRESET|other side closed/i.test(String(e.cause?.code || e.cause?.message || ''))) return true;
  return false;
}

/** Fuehrt `fn` aus und retried bei transient AI-Fehlern (max. `tries`-1 Re-Versuche).
 *  AbortError wird sofort weitergereicht; deterministische Fehler ebenfalls. */
async function retryOnTransientAi(fn, { tries = 2, log = null, label = '' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try { return await fn(); }
    catch (e) {
      if (e.name === 'AbortError') throw e;
      if (!_isTransientAiError(e) || attempt === tries) throw e;
      lastErr = e;
      if (log) log.warn(`${label || 'AI-Call'} transient (${e.message}) – Retry ${attempt}/${tries - 1}.`);
    }
  }
  throw lastErr;
}

// ── Lokaler-Provider-kompatibler Promise.allSettled-Ersatz ────────────────────
// Ollama und Llama verarbeiten Requests sequenziell. Bei parallelen Calls mit
// grossem Kontext läuft der VRAM voll → fetch failed. Daher serialisieren.
//
// Claude-Multi-Pass mit vielen Chunks (grosse Bücher, 11+ Chunks) trifft sonst
// Anthropic-TPM-Limits → einige Streams kommen als „terminated" zurück. Optional
// `opts.concurrency` (Default: unbegrenzt) cappt parallele Calls; `opts.warmup`
// (Default: false) lässt den ERSTEN Thunk seriell laufen, bevor der Rest startet
// — der Erst-Call schreibt den Prompt-Cache, Folge-Calls greifen den Cache-Hit
// und sind ~10× günstiger + viel kürzer (kleinerer TPM-Burst).
async function settledAll(thunks, opts = {}) {
  const isLocal = (appSettings.get('ai.provider') || 'claude') !== 'claude';
  if (isLocal) {
    const results = [];
    for (const fn of thunks) {
      try { results.push({ status: 'fulfilled', value: await fn() }); }
      catch (e) {
        if (e.name === 'AbortError') throw e;
        results.push({ status: 'rejected', reason: e });
      }
    }
    return results;
  }

  const settle = async (fn) => {
    try { return { status: 'fulfilled', value: await fn() }; }
    catch (e) {
      if (e.name === 'AbortError') throw e;
      return { status: 'rejected', reason: e };
    }
  };

  const results = new Array(thunks.length);
  let nextIdx = 0;

  if (opts.warmup && thunks.length > 1) {
    results[0] = await settle(thunks[0]);
    nextIdx = 1;
  }

  const concurrency = Math.max(1, opts.concurrency || thunks.length);
  const remaining = thunks.length - nextIdx;
  if (remaining <= 0) return results;
  const workerCount = Math.min(concurrency, remaining);

  const worker = async () => {
    while (true) {
      const i = nextIdx++;
      if (i >= thunks.length) return;
      results[i] = await settle(thunks[i]);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

// ── HTML-Entity-Dekodierung ──────────────────────────────────────────────────
// Single-Pass-Dekoder: jede Entity wird genau einmal aufgelöst, damit
// `&amp;#39;` (literal: &#39;) nicht versehentlich zu `'` re-decodiert wird.
const HTML_NAMED_ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  ndash: '–', mdash: '—', hellip: '…',
  laquo: '«', raquo: '»',
  lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”',
  bdquo: '„', sbquo: '‚',
  auml: 'ä', Auml: 'Ä', ouml: 'ö', Ouml: 'Ö', uuml: 'ü', Uuml: 'Ü',
  szlig: 'ß', shy: '', copy: '©', reg: '®', trade: '™',
  euro: '€', deg: '°',
};

// Token-Sparkur fürs Buchtext-Preprocessing (claude-only).
// Wird nach loadPageContents auf jede Seite angewendet, BEVOR fullBookText oder
// Multi-Pass-Chunks gebaut werden – damit P1 und P8 byte-identischen Buchtext
// sehen (Cache-Read in P8 trifft den 1h-Block aus P1).
// Greift Reste, die htmlToText nicht entfernt: unbekannte HTML-Entities,
// Zero-Width-Zeichen, weiche Trennstriche, Mehrfach-Leerzeichen.
const _CLAUDE_ENTITY_MAP = {
  nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', bull: '•', middot: '·',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', sbquo: '‚', bdquo: '„',
  apos: "'", prime: '′', Prime: '″',
  times: '×', divide: '÷', plusmn: '±', minus: '−',
};

// Entity-Decoder der drei Text-Varianten unten. Numerische Referenzen (&#x2014;,
// &#8212;) werden immer aufgelöst, benannte nur, wenn sie in `map` stehen — eine
// unbekannte Entity bleibt wörtlich stehen statt zu verschwinden. Ungültige
// Codepoints (Range/`fromCodePoint`-Wurf) fallen ebenfalls auf den Rohtext
// zurück. Die drei Aufrufer unterscheiden sich nur in `map`.
function _decodeEntities(str, map) {
  return str.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|([a-zA-Z][a-zA-Z0-9]+));/g, (m, hex, dec, name) => {
    const raw = hex !== undefined ? hex : dec;
    if (raw !== undefined) {
      const cp = parseInt(raw, hex !== undefined ? 16 : 10);
      if (Number.isFinite(cp) && cp >= 0 && cp <= 0x10FFFF) {
        try { return String.fromCodePoint(cp); } catch { return m; }
      }
      return m;
    }
    return Object.prototype.hasOwnProperty.call(map, name) ? map[name] : m;
  });
}

function cleanPageTextForClaude(text) {
  return _decodeEntities(text || '', _CLAUDE_ENTITY_MAP)
    .replace(/[​-‍﻿]/g, '')
    .replace(/­/g, '')
    .replace(/ /g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

function htmlToText(html) {
  return _decodeEntities((html || '').replace(/<[^>]+>/g, ' '), HTML_NAMED_ENTITIES)
    .replace(/\s+/g, ' ').trim();
}

// Absatz-erhaltende HTML→Text-Variante für Lektorat-Prompts. Während
// `htmlToText` (oben) Absatzgrenzen einebnet — Tags → Space, danach jeder
// Whitespace-Lauf → ein Space —, behält diese Variante Blockgrenzen als `\n\n`
// (und `<br>` als `\n`). Why: die Dialogformat-Regel „Sprecherwechsel → neuer
// Absatz" ist nur gegen Absatzgrenzen prüfbar; in der einzeiligen Variante kann
// die KI den Umbruch gar nicht sehen und meldet jeden Sprecherwechsel als
// fehlenden Umbruch. Block-Tags: p, div, li, h1-h6, blockquote, pre, ul, ol,
// figure, figcaption, table, tr, section, article. Inline-Tags werden weiterhin
// zu Space — nur Blockgrenzen tragen einen Umbruch. Entspricht damit der Sicht
// des Lektorat-Prompts, der die Seite als Prosa mit Absätzen liest.
function htmlToTextForPrompt(html) {
  return _decodeEntities((html || '')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|pre|ul|ol|figure|figcaption|table|tr|section|article)\s*>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' '), HTML_NAMED_ENTITIES)
    .replace(/ {2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[ \t]+/gm, '')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

// Konvertiert eine SYSTEM_*_BLOCKS-Variante (String oder Array aus prompts/core.js)
// in ein Anthropic-Block-Array mit konfigurierbarem Default-TTL. Idempotent für
// Array-Eingaben (TTL-Hints der Eingabe bleiben erhalten). Nutzung in Multi-Block-
// Jobs, die zusätzliche Cache-Blöcke (z.B. Buchtext) prependen wollen:
//
//   const sysBlocks = [bookSystemBlock, ...toSystemBlocks(sys.SYSTEM_X_BLOCKS, '1h')];
//
// Für einfache Job-Sites ohne zusätzliche Blöcke ist der Helper nicht nötig —
// aiCall/callAI verarbeiten String und Array transparent.
function toSystemBlocks(blocksOrString, defaultTtl) {
  if (Array.isArray(blocksOrString)) return blocksOrString;
  if (!blocksOrString) return [];
  return [{ text: blocksOrString, ttl: defaultTtl }];
}

// Mindestabstand zwischen zwei updateJob-Calls aus dem Streaming-onProgress.
// Reduziert Event-Loop-Last bei parallelen KI-Streams; die Live-Anzeige ruckelt
// in der Praxis bei 200 ms nicht sichtbar.
const PROGRESS_THROTTLE_MS = 200;

// Hilfsfunktion: callAI aufrufen, Token-Zähler akkumulieren, Job aktualisieren.
// fromPct/toPct: optionaler Fortschrittsbereich – während des Streamings wird der Balken
// von fromPct auf toPct gefüllt (basierend auf akkumulierten Output-Zeichen vs. dynExpectedChars).
// outputRatio: erwartetes Output/Input-Verhältnis für dynamische Recalibrierung (Default 0.2).
//   Sobald tokIn bekannt ist (Claude: message_start; Ollama: erster Chunk), wird dynExpectedChars
//   auf max(staticFallback, tokIn * 4 * outputRatio) gesetzt.
// maxTokens: explizites Token-Limit (überschreibt die expectedChars-Formel). null = globalMax.
async function aiCall(jobId, tok, prompt, system, fromPct, toPct, expectedChars = 3000, outputRatio = 0.2, maxTokens = null, provider = undefined, jsonSchema = null, modelOverride = undefined) {
  let dynExpectedChars = expectedChars;
  let calibrated = false;
  // Eindeutige ID für diesen Call – wird in tok.inflight eingetragen wenn vorhanden
  // (tok.inflight ist ein Map, der nur vom komplett-analyse-Job gesetzt wird, damit
  // bei parallelen Kapitel-Calls die Live-Anzeige alle in-flight-Tokens summiert.)
  const callId = Symbol();
  // Throttle: updateJob höchstens alle PROGRESS_THROTTLE_MS. Bei parallelen Streams
  // (Komplettanalyse) feuert onProgress sonst hunderte Mal/s pro Call und belastet
  // den Event-Loop, sodass andere Clients Requests verzögert bedient werden.
  // Kalibrierung läuft ungedrosselt – sie ist einmalig und braucht die erste tokIn-Meldung.
  // Finale Werte werden nach callAI-Ende ohnehin explizit gesetzt.
  let lastUpdateMs = 0;
  const onProgress = ({ chars, tokIn }) => {
    if (!calibrated && tokIn > 0) {
      dynExpectedChars = Math.max(expectedChars, Math.round(tokIn * 4 * outputRatio));
      calibrated = true;
    }
    const now = Date.now();
    if (now - lastUpdateMs < PROGRESS_THROTTLE_MS) return;
    lastUpdateMs = now;

    const updates = {};
    if (tok.progressRange) {
      // Mehrere Teil-Calls (Lektorat-Split: K Objektiv-Läufe + 1 Stil-Lauf) teilen
      // sich EINEN Fortschrittsbereich. Jeder Call meldet seine eigene Streaming-
      // Fraktion; der Balken zeigt den Mittelwert über alle erwarteten Calls
      // (progressRange.total) – additiv statt konkurrierend, damit parallele Streams
      // den Balken nicht hin- und herspringen lassen (analog tok.inflight).
      tok.progressParts.set(callId, Math.min(1, chars / dynExpectedChars));
      const { from, to, total } = tok.progressRange;
      const sum = [...tok.progressParts.values()].reduce((s, v) => s + v, 0);
      updates.progress = Math.round(from + (to - from) * Math.min(1, sum / total));
    } else if (fromPct != null && toPct != null) {
      updates.progress = Math.round(fromPct + (toPct - fromPct) * Math.min(1, chars / dynExpectedChars));
    }
    if (tok.inflight) {
      const entry = tok.inflight.get(callId) || { tokIn: 0, outEst: 0 };
      tok.inflight.set(callId, {
        tokIn:   tokIn > 0  ? tokIn              : entry.tokIn,
        outEst:  chars > 0  ? Math.floor(chars / CHARS_PER_TOKEN) : entry.outEst,
      });
      const vals = [...tok.inflight.values()];
      if (tokIn > 0) updates.tokensIn  = tok.in  + vals.reduce((s, v) => s + v.tokIn,  0);
      if (chars > 0) updates.tokensOut = tok.out + vals.reduce((s, v) => s + v.outEst, 0);
    } else {
      if (tokIn > 0) updates.tokensIn  = tok.in  + tokIn;
      if (chars > 0) updates.tokensOut = tok.out + Math.floor(chars / CHARS_PER_TOKEN);
    }
    if (Object.keys(updates).length) updateJob(jobId, updates);
  };
  // Output-Ceiling pro Call aus dem TATSAECHLICHEN Provider dieses Calls ableiten,
  // nicht aus dem globalen MAX_TOKENS_OUT (= ai.claude.max_tokens_out). Sonst klemmt
  // der Claude-Cap auch openai-compat/ollama-Jobs runter (z.B. 8000), obwohl der Admin
  // ai.openai-compat.max_tokens_out hoeher gesetzt hat → vorzeitige Truncation.
  // WICHTIG: undefined `provider` zuerst auflösen – exakt so, wie callAI es intern tut
  // (provider || resolveProvider()). Sonst fiele getContextConfigFor auf 'claude' zurück,
  // während callAI den echten Provider (z.B. openai-compat) anspricht → Cap und Call
  // divergieren und der Output wird vorzeitig auf den Claude-Default gekappt.
  const effProvider = provider || resolveProvider();
  const providerMaxOut = getContextConfigFor(effProvider).maxTokensOut;
  const maxTokensOverride = maxTokens != null
    ? Math.min(maxTokens, providerMaxOut)
    : providerMaxOut;
  const signal = jobAbortControllers.get(jobId)?.signal;
  const { text, truncated, tokensIn, tokensOut, cacheReadIn = 0, cacheCreationIn = 0, cacheCreation1hIn = 0, genDurationMs } = await callAI(prompt, system, onProgress, maxTokensOverride, signal, effProvider, jsonSchema, modelOverride);
  tok.inflight?.delete(callId);
  tok.in += tokensIn;
  tok.out += tokensOut;
  tok.cacheRead = (tok.cacheRead || 0) + cacheReadIn;
  tok.cacheCreate = (tok.cacheCreate || 0) + cacheCreationIn;
  tok.cacheCreate1h = (tok.cacheCreate1h || 0) + cacheCreation1hIn;
  if (genDurationMs != null) tok.ms += genDurationMs;
  const liveTps = tok.ms > 0 ? tok.out / (tok.ms / 1000) : null;
  const finalUpdates = {
    tokensIn: tok.in, tokensOut: tok.out,
    cacheReadIn: tok.cacheRead, cacheCreationIn: tok.cacheCreate,
    cacheCreation1hIn: tok.cacheCreate1h,
    tokensPerSec: liveTps,
  };
  if (tok.progressRange) {
    // Dieser Teil-Call ist fertig → volle Fraktion, Balken um sein Segment vorrücken.
    tok.progressParts.set(callId, 1);
    const { from, to, total } = tok.progressRange;
    const sum = [...tok.progressParts.values()].reduce((s, v) => s + v, 0);
    finalUpdates.progress = Math.round(from + (to - from) * Math.min(1, sum / total));
  }
  updateJob(jobId, finalUpdates);
  if (truncated) throw i18nError('job.error.aiTruncated', { max: maxTokensOverride, tokIn: tokensIn, tokOut: tokensOut, total: tokensIn + tokensOut });
  return parseJSON(text);
}

module.exports = {
  settledAll,
  retryOnTransientAi, _isTransientAiError,
  HTML_NAMED_ENTITIES, _CLAUDE_ENTITY_MAP,
  cleanPageTextForClaude, htmlToText, htmlToTextForPrompt,
  PROGRESS_THROTTLE_MS,
  aiCall,
  toSystemBlocks,
};
