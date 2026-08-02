// Pure Renderer für den Recherche-Chat: nimmt eine Assistant-Nachricht mit
// `<cite index="N-…">TEXT</cite>`-Markern + die Trefferdokumente und liefert
// HTML mit klickbaren Quell-Superscripts. Aus research-chat.js extrahiert, damit
// die Marker-Logik (Sentinels, Regex-Pässe, Index-Auflösung) Unit-testbar ist —
// Alpine-Key `renderChatMarkdown`/`escHtml`/`t` werden injiziert, kein glob-Import.
//
// Konsument: research-chat.js#_renderResearchAnswer delegiert dünn an
// renderResearchAnswer (Live-Export an der Alpine-Methode erhalten, Templates
// binden `this._renderResearchAnswer(msg)`).

// Private-Use-Sentinels für Inline-Zitatmarker: überleben escHtml + die
// Markdown-Transforms unverändert und werden NACH dem Render durch das
// Superscript-HTML ersetzt. Kollusionsfrei in echtem Chat-/Markdown-Text.
// Definiert per String.fromCharCode statt Literale, weil der Write/Lese-Weg
// PUA-Chars manchmal literal fallen lässt — so sind sie robust.
const CITE_OPEN = String.fromCharCode(0xE010);
const CITE_CLOSE = String.fromCharCode(0xE011);
// `<cite index="4-4,4-5">…</cite>` — das Modell schreibt diese Marker als
// Klartext in die final_answer-Antwort (claude.ai-Zitatformat). Die erste Zahl
// jedes Komma-Teils ist der Dokument-Index, die zweite ein Satz-Index (ignoriert).
const CITE_TAG_RE = /<cite\b[^>]*\bindex="([^"]*)"[^>]*>([\s\S]*?)<\/cite>/gi;
const CITE_INDEX_ONLY_RE = /<cite\b[^>]*\bindex="([^"]*)"[^>]*>/gi;

// Dokument-Indizes aus einem `index="4-4,4-5"`-String: erste Zahl pro Komma-Teil
// (= Dokument), Satz-Index dahinter ignoriert. Distinkt, Reihenfolge erhalten.
export function parseCiteDocNums(idxStr) {
  const nums = [];
  for (const part of String(idxStr || '').split(',')) {
    const n = parseInt(part.trim(), 10); // parseInt stoppt am '-' → führende Zahl
    if (Number.isFinite(n) && !nums.includes(n)) nums.push(n);
  }
  return nums;
}

// 1-basiertes Mapping Modell-Index → gesammeltes Trefferdokument. Einzige Stelle
// der Basis-Annahme (falls je off-by-one, hier zentral korrigierbar).
export function resolveSource(sources, n) {
  return sources[n - 1] || null;
}

// Distinkte, in der Antwort tatsächlich zitierte Quellen — für die Quellenliste
// unter der Antwort. Sortiert nach Index, je URL nur einmal. Pure Variante der
// researchCitedSources-Alpine-Methode (Test + Konsument teilen sie sich).
export function citedSources(text, sources) {
  if (!sources.length) return [];
  const nums = [];
  let m;
  CITE_INDEX_ONLY_RE.lastIndex = 0;
  while ((m = CITE_INDEX_ONLY_RE.exec(text))) {
    for (const n of parseCiteDocNums(m[1])) if (!nums.includes(n)) nums.push(n);
  }
  nums.sort((a, b) => a - b);
  const seen = new Set();
  const out = [];
  for (const n of nums) {
    const src = resolveSource(sources, n);
    if (src && src.url && !seen.has(src.url)) {
      seen.add(src.url);
      out.push({ n, url: src.url, title: src.title || src.url });
    }
  }
  return out;
}

/**
 * Rendert eine Assistant-Antwort in HTML. Ersetzt `<cite index="N-…">TEXT</cite>`
 * durch TEXT + klickbaren Superscript-Marker [N] (verlinkt auf das N-te Treffer-
 * dokument). Ohne Quellen werden die Tags still entwrapt. Sentinels umgehen den
 * XSS-Escape von renderChatMarkdown; das injizierte HTML escaped url/title selbst.
 *
 * @param {object} opts
 * @param {string} opts.text        Text der Nachricht (oder `__i18n:key__`).
 * @param {Array}  opts.sources     Trefferdokumente (1-basiert, aus context_info).
 * @param {(s:string)=>string} opts.renderChatMarkdown  Markdown-Renderer (escaped).
 * @param {(s:string)=>string} opts.escHtml             XSS-Escape (nur für url/title).
 * @param {(key:string)=>string} [opts.t]                i18n-Resolver für `__i18n:`-Marker.
 * @returns {string} HTML-String.
 */
export function renderResearchAnswer({ text, sources, renderChatMarkdown, escHtml, t }) {
  const txt = String(text || '');
  const srcs = Array.isArray(sources) ? sources : [];
  const i18nMatch = /^__i18n:([a-zA-Z0-9_.-]+)__$/.exec(txt);
  if (i18nMatch) {
    const resolved = t ? t(i18nMatch[1]) : i18nMatch[1];
    return renderChatMarkdown(resolved);
  }

  let transformed = txt.replace(CITE_TAG_RE, (_full, idxStr, inner) => {
    if (!srcs.length) return inner; // nichts zu verlinken → Tag entfernen
    const marks = parseCiteDocNums(idxStr)
      .map(n => `${CITE_OPEN}${n}${CITE_CLOSE}`).join('');
    return inner + marks;
  });
  // Defensiv: etwaige Rest-cite-Tags (ohne index / Fragmente) entwrappen.
  transformed = transformed.replace(/<\/?cite\b[^>]*>/gi, '');

  let html = renderChatMarkdown(transformed);
  html = html.replace(new RegExp(`${CITE_OPEN}(\\d+)${CITE_CLOSE}`, 'g'), (_s, nStr) => {
    const n = parseInt(nStr, 10);
    const src = resolveSource(srcs, n);
    if (src && src.url) {
      return `<sup class="chat-cite"><a href="${escHtml(src.url)}" target="_blank" rel="noopener noreferrer" data-tip="${escHtml(src.title || src.url)}">${n}</a></sup>`;
    }
    return `<sup class="chat-cite chat-cite--dim">${n}</sup>`;
  });
  return html;
}