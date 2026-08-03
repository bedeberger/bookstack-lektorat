'use strict';
// Modell-Listen der konfigurierten KI-Hosts — "welche Modelle kennt dieser
// Server?". Datenquelle der Modell-Combobox in den Admin-Einstellungen
// (settingField `type: 'model'`), damit Modell-IDs nicht abgetippt werden
// muessen. Reines Lesen, kein KI-Call: die Job-Queue-Regel greift nicht.
//
// Ein Ziel (`target`) buendelt Host-Art + die app_settings-Keys, aus denen
// Host und Schluessel kommen. Die Frontend-Felder nennen nur den Target-Namen;
// welcher Endpunkt dahinter liegt, weiss ausschliesslich diese Datei.

const appSettings = require('./app-settings');

const MODEL_TARGETS = {
  'claude':        { kind: 'anthropic',                            keyKey: 'ai.claude.api_key' },
  'ollama':        { kind: 'ollama', hostKey: 'ai.ollama.host' },
  'openai-compat': { kind: 'openai', hostKey: 'ai.openai-compat.host', keyKey: 'ai.openai-compat.api_key' },
  'embed':         { kind: 'openai', hostKey: 'embed.host',            keyKey: 'embed.api_key' },
  'rerank':        { kind: 'openai', hostKey: 'rerank.host',           keyKey: 'rerank.api_key' },
  'stt':           { kind: 'openai', hostKey: 'stt.host',              keyKey: 'stt.api_key' },
  'tts':           { kind: 'openai', hostKey: 'tts.host',              keyKey: 'tts.api_key' },
  'image':         { kind: 'openai', hostKey: 'image.host',            keyKey: 'image.api_key' },
};

const MAX_MODELS = 500;

// Pure: Antwort-Body → [{ id, label }], dedupliziert und alphabetisch.
// Drei Schemata: Anthropic (`data[].id` + `display_name`), Ollama
// (`models[].name`), OpenAI-kompatibel (`data[].id`, manche Server liefern
// das Array direkt). Unbekannte/leere Eintraege fallen raus statt zu werfen —
// ein halb-konformer Server soll die Liste nicht komplett verlieren.
function parseModels(kind, json) {
  let raw = [];
  if (kind === 'ollama') {
    raw = Array.isArray(json?.models) ? json.models : [];
  } else if (Array.isArray(json)) {
    raw = json;
  } else {
    raw = Array.isArray(json?.data) ? json.data : [];
  }

  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    const id = typeof entry === 'string'
      ? entry.trim()
      : String(entry?.id ?? entry?.name ?? entry?.model ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const display = typeof entry === 'object' && entry ? String(entry.display_name || '').trim() : '';
    out.push(display && display !== id ? { id, label: display } : { id, label: id });
    if (out.length >= MAX_MODELS) break;
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

// Host normalisieren: trailing Slashes weg, ein angehaengtes /v1 weg (die
// Admin-Felder werden mal mit, mal ohne getippt — dieselbe Toleranz wie in
// den test-*-Proben).
function normalizeHost(raw) {
  return String(raw || '').trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
}

function isKnownTarget(target) {
  return Object.prototype.hasOwnProperty.call(MODEL_TARGETS, target);
}

// Liefert { ok, models, error_code?, status? }. Wirft nicht — ein nicht
// erreichbarer Host ist der Normalfall (Dienst aus, Host noch nicht gestartet)
// und soll im Feld als Hinweis landen, nicht als 500.
async function listModels(target, { host: hostOverride = '', timeoutMs = 8000 } = {}) {
  const cfg = MODEL_TARGETS[target];
  if (!cfg) return { ok: false, error_code: 'UNKNOWN_TARGET', models: [] };

  const apiKey = cfg.keyKey ? String(appSettings.get(cfg.keyKey) || '').trim() : '';
  let url;
  const headers = { Accept: 'application/json' };

  if (cfg.kind === 'anthropic') {
    if (!apiKey) return { ok: false, error_code: 'NO_API_KEY', models: [] };
    url = 'https://api.anthropic.com/v1/models?limit=100';
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    const host = normalizeHost(hostOverride || appSettings.get(cfg.hostKey));
    if (!host) return { ok: false, error_code: 'NO_HOST', models: [] };
    if (!/^https?:\/\//i.test(host)) return { ok: false, error_code: 'BAD_HOST', models: [] };
    url = cfg.kind === 'ollama' ? `${host}/api/tags` : `${host}/v1/models`;
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal });
    if (!r.ok) {
      await r.arrayBuffer().catch(() => {}); // Body draenen → Socket freigeben
      return { ok: false, error_code: `HTTP_${r.status}`, status: r.status, models: [] };
    }
    const json = await r.json().catch(() => null);
    if (json == null) return { ok: false, error_code: 'BAD_RESPONSE', models: [] };
    return { ok: true, models: parseModels(cfg.kind, json) };
  } catch (e) {
    return { ok: false, error_code: e.name === 'AbortError' ? 'TIMEOUT' : 'UNREACHABLE', detail: e.message, models: [] };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { MODEL_TARGETS, MAX_MODELS, parseModels, normalizeHost, isKnownTarget, listModels };
