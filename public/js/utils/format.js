// Zahlen-, Dauer-, Token- und Umfangs-Formatierung + Locale-Helper + kleine
// Compute-Helper (Memo, Min/Max, Heatmap-Zellfarbe). Pure Funktionen, kein DOM.

// Durchschnittliche Zeichen pro Token für Display-Schätzungen. Wird in app.js aus
// /config überschrieben (Server setzt den provider-spezifischen Wert). Vor dem
// /config-Load bleibt der Claude-Default aktiv. Änderung ist via Live-Binding in
// allen Importern sofort sichtbar.
export let CHARS_PER_TOKEN = 3;

export function configureTokenEstimate(value) {
  const v = parseFloat(value);
  if (Number.isFinite(v) && v > 0) CHARS_PER_TOKEN = v;
}

// Intl-Locale-Tag aus uiLocale (en → en-US, sonst de-CH).
export function localeTag(uiLocale) {
  return uiLocale === 'en' ? 'en-US' : 'de-CH';
}

// Pro (Locale, Options) gecachter Intl.NumberFormat. `Number#toLocaleString`
// baut intern bei JEDEM Aufruf einen Formatter — in Grids/Heatmaps (Buch-
// Übersicht: bis 364 Streak-Zellen pro Render) ist das messbar. Cache-Key
// über den Options-Bag, der in der Praxis aus einer Handvoll Varianten besteht.
const _NF_CACHE = new Map();
export function numberFormat(uiLocale, opts = {}) {
  const tag = localeTag(uiLocale);
  const key = tag + '|' + JSON.stringify(opts);
  let nf = _NF_CACHE.get(key);
  if (!nf) { nf = new Intl.NumberFormat(tag, opts); _NF_CACHE.set(key, nf); }
  return nf;
}

// Klassische Normseite (DIN): 30 Zeilen × ~50 Zeichen ≈ 1500 Zeichen.
// Sekundäre Umfangs-Kennzahl neben Zeichen/Wörter.
export const CHARS_PER_NORMSEITE = 1500;
export function charsToNormseiten(chars) {
  const n = Number(chars) || 0;
  return Math.round((n / CHARS_PER_NORMSEITE) * 10) / 10;
}

// Kompakte Zeichen-Plakette der Sidebar/Editor-Leisten: unter 1000 die genaue
// Zahl, darueber auf Tausender gerundet mit Tilde. Die EINHEIT kommt als
// Parameter herein (`t('bookstats.unit.z')` — de „Z", en „c"); ohne das stand
// sie in fuenf Templates als Literal „Z" und blieb in der englischen UI deutsch,
// waehrend die Σ-Zeile direkt daneben schon „c" zeigte.
export function charBadgeLabel(chars, unit) {
  const n = Number(chars) || 0;
  return n >= 1000
    ? '~' + Math.round(n / 1000) + 'k ' + unit
    : n + ' ' + unit;
}

// Live-Σ Zeichen/Wörter/Tokens über alle Seiten. Spiegelt
// routes/sync.js#syncBook-Total: Σ per-Seite-Stats. Seiten- und Kapitelnamen
// sind kein Teil des Umfangs.
export function aggregateLiveBookStats(tokEsts) {
  let chars = 0, words = 0, tok = 0;
  for (const id of Object.keys(tokEsts || {})) {
    const e = tokEsts[id];
    if (!e) continue;
    chars += Number(e.chars) || 0;
    words += Number(e.words) || 0;
    tok += Number(e.tok) || 0;
  }
  return { chars, words, tok };
}

// Ein `Intl.NumberFormat` pro (Locale, Dezimalstellen). `toLocaleString` mit
// Options-Objekt baut den Formatter bei JEDEM Aufruf neu — das kostet rund 15 µs
// und faellt auf, sobald eine Tabelle vierstellig viele Zellen formatiert
// (Stil-Heatmap: Kapitel × 9 Metriken). Die Instanzen sind unveraenderlich, das
// Ergebnis ist identisch; die Zahl der Kombinationen ist zweistellig.
const _numFormatters = new Map();
function _numFormatter(uiLocale, decimals) {
  const tag = localeTag(uiLocale);
  const key = `${tag}|${decimals}`;
  let f = _numFormatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat(tag, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    _numFormatters.set(key, f);
  }
  return f;
}

// Locale-korrekte Zahl mit fixer Dezimalstellenzahl. Null/NaN → '–'.
export function formatNumber(value, uiLocale, decimals = 1) {
  if (value == null || !isFinite(value)) return '–';
  return _numFormatter(uiLocale, decimals).format(value);
}

// Exakte Dauer in h/min/s. 0 wird als „0 s" zurückgegeben. Komponenten mit
// Wert 0 werden weggelassen, ausser die Gesamtdauer ist 0. Ergebnis: „1 h 23 min 45 s",
// „23 min 5 s", „45 s". Einheiten sind locale-stabil (bewusst nicht übersetzt,
// damit eine Stelle die Reihenfolge h/min/s vorgibt).
export function fmtExactDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total === 0) return '0 s';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts = [];
  if (h > 0) parts.push(h + ' h');
  if (m > 0) parts.push(m + ' min');
  if (s > 0) parts.push(s + ' s');
  return parts.join(' ');
}

// Min/Max über `items`. `getValue` liefert Zahl oder null/NaN.
// Leere Menge → { min: 0, max: 0 } (konsistent mit den Heatmap-Callern).
export function minMaxBy(items, getValue) {
  let min = Infinity, max = -Infinity;
  for (const it of items) {
    const v = getValue(it);
    if (typeof v !== 'number' || !isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === Infinity) return { min: 0, max: 0 };
  return { min, max };
}

// Heatmap-Zellfarbe: t∈[0,1], 0 → grün, 1 → rot.
// Liefert ein Style-Objekt mit CSS-Custom-Properties, das Alpine via
// `:style` anbindet. Die Farbberechnung selbst steht in style.css
// (`.heatmap-cell--tinted`), damit keine Inline-Style-Strings im DOM landen.
export function heatmapCellVars(t, opacity = 1) {
  const pct = Math.round(Math.max(0, Math.min(1, t)) * 100);
  return { '--heatmap-t': pct + '%', '--heatmap-opacity': String(opacity) };
}

export function fmtTok(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

// Sterne-Render mit Halbschritt-Support. `gesamtnote` ist Dezimal (Schema:
// 1.0–6.0, Halbschritte erlaubt). Liefert HTML-Markup mit zwei übereinander
// liegenden Layern: Hintergrund = max ★ in Mute-Farbe, Vordergrund = max ★ in
// Akzentfarbe, Vordergrund-Width via Step-Klasse (`stars-rating--n-{N}`,
// N = 0..max*2 in halben Schritten). Identische Glyphen + identisches Layout
// auf beiden Layern → fontunabhängig, kein Tofu. Output ist konstantes Markup
// ohne User-Daten — direkt in x-html / Template-Literals einsetzbar.
export function renderStars(note, max = 6) {
  const n = Number(note);
  const safe = Number.isFinite(n) && n > 0 ? Math.min(max, n) : 0;
  const step = Math.round(safe * 2);
  const stars = '★'.repeat(max);
  return `<span class="stars-rating stars-rating--n-${step}" aria-hidden="true">`
    + `<span class="stars-rating__bg">${stars}</span>`
    + `<span class="stars-rating__fg">${stars}</span>`
    + `</span>`;
}

// Tooltip-Text für Sterne: exakter Wert auf 0.5 gerundet, "n / max".
// Null wenn keine numerische Note → :data-tip greift nicht.
export function noteTip(note, max = 6) {
  const n = Number(note);
  if (!Number.isFinite(n) || n <= 0) return null;
  const rounded = Math.round(Math.min(max, n) * 2) / 2;
  return `${rounded.toFixed(1)} / ${max}`;
}
