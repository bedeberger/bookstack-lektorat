'use strict';
// Modell-Preise pro 1 Mio Tokens in USD. costUsd() bepreist einen einzelnen
// Call. Aufgerufen wird es an der SCHREIB-Seite: beim Abschluss eines Calls
// friert db/cost-ledger die USD-Kosten als Zeile in ai_cost_ledger ein. Alle
// Kosten-Aggregate (Admin-Usage, Budget, Daily-Usage, /metrics) summieren diese
// eingefrorenen Werte — ein PRICING-Update wirkt daher NUR auf kuenftige Calls,
// nicht rueckwirkend auf bereits gebuchte Ledger-Zeilen.
//
// Update-Disziplin: bei Anthropic-Preisaenderung PR auf PRICING. Logger warnt
// einmal pro unbekanntem Modell, damit kein stiller Drift entsteht.

const logger = require('../logger');

// cache_write = 5-min-TTL (1.25x Input), cache_write_1h = 1h-TTL (2x Input).
//
// 5er-Serie: Sonnet 5 hat einen befristeten Einfuehrungstarif (2.00/10.00 bis
// 2026-08-31). Der ist hier BEWUSST nicht abgebildet — costUsd friert den Preis
// pro Call im Ledger ein, ein datumsabhaengiger Tarif wuerde nach Ablauf des
// Rabatts falsche Historie erzeugen (und ein Datumsvergleich hier waere die
// einzige zeitabhaengige Logik im Modul). Der Standardtarif ueberschaetzt
// konservativ — lieber zu hoch gebucht als zu tief.
const PRICING = Object.freeze({
  'claude-fable-5':          { input: 10.00, output: 50.00, cache_write: 12.50, cache_write_1h: 20.00, cache_read: 1.00 },
  'claude-mythos-5':         { input: 10.00, output: 50.00, cache_write: 12.50, cache_write_1h: 20.00, cache_read: 1.00 },
  'claude-opus-5':           { input:  5.00, output: 25.00, cache_write:  6.25, cache_write_1h: 10.00, cache_read: 0.50 },
  'claude-sonnet-5':         { input:  3.00, output: 15.00, cache_write:  3.75, cache_write_1h:  6.00, cache_read: 0.30 },
  'claude-opus-4-8':         { input:  5.00, output: 25.00, cache_write:  6.25, cache_write_1h: 10.00, cache_read: 0.50 },
  'claude-opus-4-7':         { input:  5.00, output: 25.00, cache_write:  6.25, cache_write_1h: 10.00, cache_read: 0.50 },
  'claude-opus-4-6':         { input:  5.00, output: 25.00, cache_write:  6.25, cache_write_1h: 10.00, cache_read: 0.50 },
  'claude-opus-4-5':         { input:  5.00, output: 25.00, cache_write:  6.25, cache_write_1h: 10.00, cache_read: 0.50 },
  'claude-opus-4-1':         { input: 15.00, output: 75.00, cache_write: 18.75, cache_write_1h: 30.00, cache_read: 1.50 },
  'claude-opus-4-0':         { input: 15.00, output: 75.00, cache_write: 18.75, cache_write_1h: 30.00, cache_read: 1.50 },
  'claude-sonnet-4-6':       { input:  3.00, output: 15.00, cache_write:  3.75, cache_write_1h:  6.00, cache_read: 0.30 },
  'claude-sonnet-4-5':       { input:  3.00, output: 15.00, cache_write:  3.75, cache_write_1h:  6.00, cache_read: 0.30 },
  'claude-sonnet-4-0':       { input:  3.00, output: 15.00, cache_write:  3.75, cache_write_1h:  6.00, cache_read: 0.30 },
  'claude-3-7-sonnet-latest':{ input:  3.00, output: 15.00, cache_write:  3.75, cache_write_1h:  6.00, cache_read: 0.30 },
  'claude-haiku-4-5':        { input:  1.00, output:  5.00, cache_write:  1.25, cache_write_1h:  2.00, cache_read: 0.10 },
  'claude-3-5-haiku-latest': { input:  0.80, output:  4.00, cache_write:  1.00, cache_write_1h:  1.60, cache_read: 0.08 },
});

// Server-Tool: Anthropic-Web-Suche. Separater Posten ZUSAETZLICH zu den Tokens,
// $10 pro 1'000 Suchen. Nur Claude (andere Provider haben keine Web-Suche).
const WEB_SEARCH_USD_PER_1K = 10.00;

const _warnedModels = new Set();

// Family-Fallback: identifier wie 'claude-opus-4-7-20251212' werden auf den
// Basistarif geleitet. Reihenfolge wichtig (laengster Match zuerst).
const _FAMILY_PREFIXES = [
  'claude-fable-5', 'claude-mythos-5',
  'claude-opus-5', 'claude-sonnet-5',
  'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5', 'claude-opus-4-1', 'claude-opus-4-0',
  'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4-0',
  'claude-3-7-sonnet',
  'claude-haiku-4-5',
  'claude-3-5-haiku',
];

function fallbackFamily(model) {
  if (!model || typeof model !== 'string') return null;
  const m = model.toLowerCase();
  for (const prefix of _FAMILY_PREFIXES) {
    if (m.startsWith(prefix)) {
      // Mapping auf den Hauptkey, der in PRICING haengt.
      if (prefix === 'claude-3-7-sonnet') return 'claude-3-7-sonnet-latest';
      if (prefix === 'claude-3-5-haiku')  return 'claude-3-5-haiku-latest';
      return prefix;
    }
  }
  // Generischer Generationen-Fallback: künftige Punktversionen (claude-opus-4-9,
  // claude-sonnet-4-7, claude-opus-5-1, …) teilen den Tarif ihrer Familie. Verhindert
  // stillen Cost=0-Drift, bis die exakte Modell-Zeile ergänzt ist (Logger warnt dann NICHT,
  // weil ein Familien-Match vorliegt — bewusst, der Tarif ist innerhalb einer Familie stabil).
  // Die 5er-Zeilen stehen VOR den 4.x-Zeilen, damit 'claude-opus-5…' nicht an der
  // laxeren 4.x-Regex vorbeirutscht.
  if (/^claude-fable-/.test(m))    return 'claude-fable-5';
  if (/^claude-mythos-/.test(m))   return 'claude-mythos-5';
  if (/^claude-opus-[5-9]/.test(m))   return 'claude-opus-5';
  if (/^claude-sonnet-[5-9]/.test(m)) return 'claude-sonnet-5';
  if (/^claude-opus-4-/.test(m))   return 'claude-opus-4-8';
  if (/^claude-sonnet-4-/.test(m)) return 'claude-sonnet-4-6';
  if (/^claude-haiku-4-/.test(m))  return 'claude-haiku-4-5';
  return null;
}

function _resolvePricing(model) {
  if (!model) return null;
  if (PRICING[model]) return PRICING[model];
  const family = fallbackFamily(model);
  if (family && PRICING[family]) return PRICING[family];
  if (!_warnedModels.has(model)) {
    _warnedModels.add(model);
    logger.warn(`[pricing] Modell '${model}' unbekannt — Cost=0 angesetzt. Pricing in lib/pricing.js ergaenzen.`);
  }
  return null;
}

// USD-Kosten fuer einen Aufruf. Cache-Read = guenstig (~10% Input), Cache-Write
// = teuer (1.25x Input bei 5-min-TTL, 2x bei 1h-TTL).
// Lokale Provider (ollama/llama) sind 0 USD — Strom/Compute-Aufwand des
// Betreibers, nicht App-Sache.
//
// tokensIn ist das cache-INKLUSIVE Total, so wie lib/ai.js es liefert und
// job_runs.tokens_in/chat_messages.tokens_in es speichern (input_tokens +
// cache_read + cache_creation). Zum vollen Input-Tarif zaehlt nur der
// ungecachte Anteil — Cache-Tokens laufen ausschliesslich ueber ihre eigenen
// Tarife, sonst wuerden sie doppelt bepreist.
// cacheCreation1hIn ist der 1h-TTL-Anteil von cacheCreationIn (Teilmenge,
// nicht zusaetzlich); historische Rows ohne Aufschluesselung (Spalte 0/NULL)
// laufen komplett zum 5-min-Satz.
//
// 1M-Kontext: Fable 5, Opus 4.6+ und Sonnet 4.6 rechnen das gesamte 1M-Fenster zum
// Standard-Tarif ab — kein Long-Context-Aufschlag fuer Input > 200K (Stand Anthropic-
// Preisseite: ein 900K-Request kostet pro Token gleich viel wie ein 9K-Request). Darum
// keine >200K-Staffel hier; Produktion faehrt Sonnet 4.6, der Standard-Single-Pass-Tarif
// ist exakt. Nur die alten 1M-Beta-Modelle (Sonnet 4.5/4.0) hatten einen >200K-Aufschlag
// (Input 2x, Output 1.5x) — nicht abgebildet, da nicht in Benutzung.
// webSearches ist die Anzahl der Anthropic-Web-Suchen dieses Calls (server_tool_use
// 'web_search'); sie wird zum Token-Kostenanteil addiert. Nur der Recherche-Chat
// liefert sie > 0.
function costUsd({ provider, model, tokensIn = 0, tokensOut = 0, cacheReadIn = 0, cacheCreationIn = 0, cacheCreation1hIn = 0, webSearches = 0 } = {}) {
  if (provider !== 'claude') return 0;
  const p = _resolvePricing(model);
  if (!p) return 0;
  const cacheRead       = Number(cacheReadIn) || 0;
  const cacheWriteTotal = Number(cacheCreationIn) || 0;
  const cacheWrite1h    = Math.min(Math.max(0, Number(cacheCreation1hIn) || 0), cacheWriteTotal);
  const cacheWrite5m    = cacheWriteTotal - cacheWrite1h;
  const uncachedIn      = Math.max(0, (Number(tokensIn) || 0) - cacheRead - cacheWriteTotal);
  const tokenUsd = (
    uncachedIn                  * p.input +
    (Number(tokensOut)    || 0) * p.output +
    cacheWrite5m                * p.cache_write +
    cacheWrite1h                * p.cache_write_1h +
    cacheRead                   * p.cache_read
  ) / 1_000_000;
  const webSearchUsd = (Math.max(0, Number(webSearches) || 0) * WEB_SEARCH_USD_PER_1K) / 1_000;
  return tokenUsd + webSearchUsd;
}

module.exports = { PRICING, WEB_SEARCH_USD_PER_1K, costUsd, fallbackFamily };
