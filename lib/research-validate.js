'use strict';
// Geteilte Validierung/Normalisierung für Recherche-Items. Single Source of Truth
// für Limits + URL/Tag-Regeln, genutzt vom Board-Backend (routes/research.js) und
// vom Recherche-Chat-Vorschlag (routes/jobs/research-chat-tools.js) — sonst driften
// die Caps und die http(s)-/Dedup-Logik zwischen „per Hand angelegt" und „vom Chat
// vorgeschlagen" auseinander.

// Eintragstypen, die per Hand/Chat als Item angelegt werden. 'image'/'document'
// entstehen ausschliesslich über die Upload-Routen, nicht über create.
const RESEARCH_KINDS = new Set(['note', 'link', 'quote', 'fact', 'image']);
// Was der Chat vorschlagen darf (kein Upload-only-Kind).
const PROPOSAL_KINDS = new Set(['note', 'link', 'quote', 'fact']);
// Was im List-Filter erlaubt ist (inkl. der Upload-Kinds zum Durchsuchen).
// 'transcript' entsteht ueber den Audio-Upload (routes/interview.js) — wie
// 'image'/'document' nicht ueber `create`, aber filterbar.
const LIST_FILTER_KINDS = new Set(['note', 'link', 'quote', 'fact', 'image', 'document', 'transcript']);

const TITLE_MAX = 300;
const BODY_MAX = 20000;
// Deckel des FTS5-Vorfilters in der Listen-Route: mehr Treffer holt sie nie,
// egal welches `limit` danach greift. Steht hier statt als Zahl in der Route,
// weil ihn der Client kennen muss — wer mehr als so viele Funde in einem Buch
// hat, bekommt bei einer sehr breiten Suche NICHT die aeltesten mit.
const FTS_PREFILTER_LIMIT = 500;
// Listen-Deckel fuer Client-Lesepfade (Browser-Erweiterung). Die SPA laedt das
// Board weiterhin ungedeckelt; ein Popup, das nur „kenne ich diese Seite schon"
// fragt, braucht keine 800 Zeilen.
const CLIENT_LIST_LIMIT = 50;
const LIST_LIMIT_MAX = 200;
// Laenge des Text-Anrisses in der Client-Form. Der volle `body` traegt bis zu
// BODY_MAX Zeichen extrahierten Seitentext — den hat der Client selbst erfasst
// und schickt ihn sich sonst bei jeder Dublettenpruefung erneut zu.
const SNIPPET_MAX = 200;
const URL_MAX = 2000;
const URL_LABEL_MAX = 300;
const MAX_URLS = 20;
const SOURCE_MAX = 1000;
const TAG_MAX = 60;
const MAX_TAGS = 20;

// Trim + cap; '' / non-string → null.
function cleanStr(v, max) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  return t.slice(0, max);
}

// urls: Array von { url, label? } ODER reinen URL-Strings → [{ url, label }]
// (label '' wenn keins). http(s)-only (XSS-/Schema-Schutz beim späteren :href-
// Binding), je URL einmal, auf MAX_URLS gedeckelt. `hadBadUrl` meldet, ob eine
// nicht-http(s)-URL verworfen wurde, damit Aufrufer eine Fehlermeldung wählen können.
function normalizeUrls(input, { max = MAX_URLS } = {}) {
  const seen = new Set();
  const urls = [];
  let hadBadUrl = false;
  for (const raw of (Array.isArray(input) ? input : [])) {
    const u = cleanStr(typeof raw === 'string' ? raw : raw?.url, URL_MAX);
    if (!u) continue;
    if (!/^https?:\/\//i.test(u)) { hadBadUrl = true; continue; }
    if (seen.has(u)) continue;
    seen.add(u);
    const label = (typeof raw === 'object' ? cleanStr(raw?.label, URL_LABEL_MAX) : null) || '';
    urls.push({ url: u, label });
    if (urls.length >= max) break;
  }
  return { urls, hadBadUrl };
}

// tags: Array → distinkte (case-insensitive) getrimmte Strings, gedeckelt.
function normalizeTags(input, { max = MAX_TAGS } = {}) {
  const seen = new Set();
  const out = [];
  for (const raw of (Array.isArray(input) ? input : [])) {
    const tag = cleanStr(String(raw ?? ''), TAG_MAX);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
    if (out.length >= max) break;
  }
  return out;
}

// `limit` einer Listen-Abfrage → Zahl oder `fallback`. Unbrauchbare Eingaben
// (leer, 0, negativ, Text) fallen auf den Default zurueck statt 400 zu werfen:
// ein Lesepfad soll an einem vertippten Query-Parameter nicht scheitern.
// `fallback = null` heisst „kein LIMIT" (Verhalten der SPA).
function clampListLimit(raw, fallback = null) {
  const n = Number.parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, LIST_LIMIT_MAX);
}

// Whitespace-normalisierter Anriss des Item-Texts.
function bodySnippet(body, max = SNIPPET_MAX) {
  const s = String(body ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

// Item-Zeile (inkl. angehaengter Relationen) → reduzierte Client-Form.
// `urls` bleibt drin, obwohl es kein Skalarfeld ist: die Frage, fuer die dieser
// Lesepfad existiert („ist diese Seite schon erfasst?"), ist ohne die URLs des
// Fundstuecks nicht beantwortbar. `body` faellt raus, `tags`/`links`/`doc_*`
// ebenso — das ist Board-Zubehoer, kein Erfassungs-Kontext.
function toClientItem(row) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title || null,
    source: row.source || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    body_snippet: bodySnippet(row.body),
    urls: (row.urls || []).map(u => ({ url: u.url, label: u.label || '' })),
  };
}

module.exports = {
  RESEARCH_KINDS, PROPOSAL_KINDS, LIST_FILTER_KINDS,
  TITLE_MAX, BODY_MAX, URL_MAX, URL_LABEL_MAX, MAX_URLS, SOURCE_MAX, TAG_MAX, MAX_TAGS,
  FTS_PREFILTER_LIMIT, CLIENT_LIST_LIMIT, LIST_LIMIT_MAX, SNIPPET_MAX,
  cleanStr, normalizeUrls, normalizeTags,
  clampListLimit, bodySnippet, toClientItem,
};
