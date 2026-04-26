// Durchschnittliche Zeichen pro Token für Display-Schätzungen. Wird in app.js aus
// /config überschrieben (Server setzt den provider-spezifischen Wert). Vor dem
// /config-Load bleibt der Claude-Default aktiv. Änderung ist via Live-Binding in
// allen Importern sofort sichtbar.
export let CHARS_PER_TOKEN = 3;

export function configureTokenEstimate(value) {
  const v = parseFloat(value);
  if (Number.isFinite(v) && v > 0) CHARS_PER_TOKEN = v;
}

/**
 * Fetch mit Pflicht-OK-Check und JSON-Parsing. Wirft bei HTTP-Fehlern,
 * damit der `.then(r => r.json())`-Pattern nicht stillschweigend HTML-
 * Fehlerseiten als JSON parst. 401 läuft durch den globalen fetch-Wrapper
 * in app.js (dispatcht `session-expired`) und wirft hier dann einen Fehler.
 */
export async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) {
    let detail = '';
    try { const e = await r.clone().json(); detail = e.error || e.message || ''; } catch (_) {}
    throw new Error(detail ? `HTTP ${r.status}: ${detail}` : `HTTP ${r.status}`);
  }
  return r.json();
}

/**
 * Löscht eine Alpine-Status-Property nach `delay`, wenn sie dann noch den
 * gesetzten Wert trägt. Verhindert, dass spätere Status-Updates durch einen
 * verzögerten Reset überschrieben werden – eigenes setTimeout-Idiom, das sich
 * an mehreren Stellen wiederholte.
 */
export function clearStatusAfter(obj, prop, expected, delay) {
  setTimeout(() => {
    if (obj[prop] === expected) obj[prop] = '';
  }, delay);
}

export async function fetchText(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

// Sicherheitscheck vor dem Speichern: < 50 % wirkt unvollständig → Abbruch
export const SAFETY_HTML_RATIO = 0.5;

// Intl-Locale-Tag aus uiLocale (en → en-US, sonst de-CH).
export function localeTag(uiLocale) {
  return uiLocale === 'en' ? 'en-US' : 'de-CH';
}

// Relative Last-Run-Anzeige aus ISO-Timestamp. Server liefert nur den ISO-
// String; Lokalisierung passiert hier (i18n-Hard-Rule). `t` ist die i18n-Funktion,
// `uiLocale` der Sprachcode aus der App ('de' oder 'en').
export function formatLastRun(isoStr, t, uiLocale) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return '';
  const tag = localeTag(uiLocale);
  const time = d.toLocaleTimeString(tag, { hour: '2-digit', minute: '2-digit' });
  const now = new Date();
  const dDay  = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((today - dDay) / 86400000);
  if (diffDays === 0) return t('job.lastRun.today',     { time });
  if (diffDays === 1) return t('job.lastRun.yesterday', { time });
  if (diffDays < 7)   return t('job.lastRun.daysAgo',   { days: diffDays, time });
  const date = d.toLocaleDateString(tag, { day: '2-digit', month: '2-digit' });
  return t('job.lastRun.dateAt', { date, time });
}

// Locale-korrekte Zahl mit fixer Dezimalstellenzahl. Null/NaN → '–'.
export function formatNumber(value, uiLocale, decimals = 1) {
  if (value == null || !isFinite(value)) return '–';
  return value.toLocaleString(localeTag(uiLocale), {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
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

export function escHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Escapt alles außer <strong>…</strong> (BookStack-Search-Highlight).
// Verhindert XSS über preview_html, falls ein BookStack-User böswilligen
// HTML-Seitentitel/-Inhalt einschleust.
export function escPreserveStrong(s) {
  if (!s) return '';
  return escHtml(s)
    .replace(/&lt;strong&gt;/g, '<strong>')
    .replace(/&lt;\/strong&gt;/g, '</strong>');
}

export function htmlToText(html) {
  // DOMParser statt detached div: `div.innerHTML = …` triggert in allen
  // Browsern einen GET auf `<img src>`/Background-URLs (HTML-Parser-Pipeline
  // setzt Resource-Loads nicht aus). DOMParser('text/html') produziert ein
  // inert document ohne Resource-Requests.
  if (typeof DOMParser !== 'undefined') {
    try {
      const doc = new DOMParser().parseFromString(html || '', 'text/html');
      return doc.body?.textContent || '';
    } catch { /* fallback unten */ }
  }
  const d = document.createElement('template');
  d.innerHTML = html || '';
  return d.content?.textContent || '';
}

/**
 * Entfernt Fokus-Modus-Artefakte aus BookStack-HTML. Browser friert bei
 * contenteditable-Edits die computed `font-size` des Fokus-Containers als
 * inline `<span style="font-size:1.45rem">` ein; die Klasse
 * `focus-paragraph-active` ist eine rein interne UI-Markierung, die nie ins
 * persistierte HTML gehört. Idempotent – auch auf bereits sauberem HTML
 * sicher aufrufbar. Aufruf an allen Seams: nach dem Laden von BookStack und
 * vor dem Speichern an BookStack.
 */
export function stripFocusArtefacts(html) {
  if (!html) return html;
  // Trigger erweitern: leeres `class=""` entsteht, wenn classList.remove die
  // letzte Klasse wegnimmt — Attribut bleibt mit leerem Wert stehen. Ohne
  // diesen Branch erzeugt Focus-Mode-Aktiv-Markierung beim Save eine Revision,
  // obwohl semantisch nichts geändert wurde.
  if (
    !html.includes('focus-paragraph-active') &&
    !/font-size|background-color\s*:\s*transparent/i.test(html) &&
    !/\sclass\s*=\s*""/.test(html)
  ) {
    return html;
  }

  const tmp = document.createElement('div');
  tmp.innerHTML = html;

  tmp.querySelectorAll('.focus-paragraph-active').forEach(el => {
    el.classList.remove('focus-paragraph-active');
    if (el.classList.length === 0) el.removeAttribute('class');
  });

  tmp.querySelectorAll('[style]').forEach(el => {
    const cleaned = (el.getAttribute('style') || '')
      .split(';')
      .map(d => d.trim())
      .filter(d => {
        if (!d) return false;
        const key = d.split(':')[0].trim().toLowerCase();
        if (key === 'font-size') return false;
        if (key === 'background-color' && /transparent/i.test(d)) return false;
        return true;
      })
      .join('; ');
    if (cleaned) el.setAttribute('style', cleaned);
    else el.removeAttribute('style');
  });

  tmp.querySelectorAll('span').forEach(span => {
    if (span.attributes.length === 0) {
      const parent = span.parentNode;
      if (!parent) return;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
    }
  });

  // Verbleibende leere class=""-Attribute unabhängig von ihrer Herkunft entfernen.
  tmp.querySelectorAll('[class=""]').forEach(el => el.removeAttribute('class'));

  return tmp.innerHTML;
}

// Tags, auf denen `style` IMMER unerwünscht ist (Block-Styling kommt über
// .poem/.callout/style.css; der Editor selbst setzt nie inline-style).
// Strukturelemente wie img/table/td/col/figure/iframe bleiben unangetastet,
// dort sind Width-/Height-Angaben legitim.
const STRIP_STYLE_TAGS = new Set([
  'P', 'SPAN', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'LI', 'UL', 'OL', 'BLOCKQUOTE', 'A', 'B', 'I', 'STRONG', 'EM',
  'BR', 'PRE', 'CODE', 'SMALL', 'MARK', 'U', 'S', 'SUB', 'SUP',
]);

/**
 * Säubert HTML von Inline-Style-Müll, leeren Spans und Paste-Wrapper-Tags.
 *
 * Chrome friert beim Tippen oder Pasten in `contenteditable` die Computed-
 * Styles auf jedem Block ein (z.B. `<p style="margin:0.4em 0px;color:rgb(...);
 * font-family:Lato,...">`). Wenn dieses HTML via `bsPut` an BookStack geht,
 * überschreiben die Inline-Styles dort die echten Block-Styles (`.poem` &Co)
 * und das Resultat sieht kaputt aus.
 *
 * Idempotent. Behält `style` auf img/table/td/col/figure/iframe.
 */
export function cleanContentArtefacts(html) {
  if (!html) return html;
  if (!/\sstyle\s*=|<(span|meta|link|script|style|title)\b/i.test(html)) return html;

  const tmp = document.createElement('div');
  tmp.innerHTML = html;

  // Paste-Wrapper aus Browser/Office (komplett raus, samt Inhalt)
  tmp.querySelectorAll('meta, link, script, style, title').forEach(el => el.remove());

  tmp.querySelectorAll('[style]').forEach(el => {
    if (STRIP_STYLE_TAGS.has(el.tagName)) el.removeAttribute('style');
  });

  // Leere Spans aus Paste-/Selection-Operationen entkernen
  tmp.querySelectorAll('span').forEach(span => {
    if (span.attributes.length === 0) {
      const parent = span.parentNode;
      if (!parent) return;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
    }
  });

  return tmp.innerHTML;
}

// Elemente mit eigenem "visuellen" Inhalt (dürfen leer wirken, bleiben erhalten).
const _STRUCTURAL_LEAF = 'img,iframe,video,audio,table,figure,hr,object,embed,canvas,svg,input,button';

function _isBlankTrailing(node) {
  if (!node) return false;
  if (node.nodeType === 3) return !node.textContent.replace(/\u00A0/g, ' ').trim();
  if (node.nodeType !== 1) return false;
  const tag = node.tagName;
  if (tag !== 'P' && tag !== 'DIV' && tag !== 'BR') return false;
  if (tag === 'BR') return true;
  if ((node.textContent || '').replace(/\u00A0/g, ' ').trim()) return false;
  if (node.querySelector(_STRUCTURAL_LEAF)) return false;
  return true;
}

/**
 * Entfernt leere Absätze am Ende des HTML. contenteditable hängt beim Tippen
 * oft `<p><br></p>`/`<p>&nbsp;</p>` an; ohne Strip wachsen beim jedem Save
 * weitere Leerabsätze hinten ans BookStack-HTML. Idempotent, Top-Level only.
 * Nutzt DOMParser statt innerHTML-Assign, um keine Script-Side-Effects auszulösen.
 */
export function stripTrailingEmptyBlocks(html) {
  if (!html) return html;
  const doc = new DOMParser().parseFromString('<div id="r">' + html + '</div>', 'text/html');
  const root = doc.getElementById('r');
  if (!root) return html;
  let last = root.lastChild;
  while (last && _isBlankTrailing(last)) {
    const prev = last.previousSibling;
    root.removeChild(last);
    last = prev;
  }
  return root.innerHTML;
}

// Dekodiert eine einzelne HTML-Entity (z.B. &bdquo;) via Browser-Parser.
// Gibt null zurück, wenn sich die Entity nicht auflöst.
const _entityDecoder = typeof document !== 'undefined' ? document.createElement('textarea') : null;
function _decodeHtmlEntity(entity) {
  if (!_entityDecoder) return null;
  _entityDecoder.innerHTML = entity;
  const decoded = _entityDecoder.value;
  return decoded === entity ? null : decoded;
}

/**
 * Baut eine Text-View von `html` mit Positions-Map zurück ins Original-HTML.
 * - Tags werden entfernt; Tag-Grenzen wirken wie Whitespace.
 * - Aufeinanderfolgender Whitespace wird auf einzelne Spaces kollabiert.
 * - Entities werden via Browser-Parser dekodiert.
 * - Pro Text-Zeichen `text[i]` gilt: es stammt aus dem HTML-Bereich [starts[i], ends[i]).
 */
function _buildHtmlTextMap(html) {
  const chars = [];
  const starts = [];
  const ends = [];
  let pendingSpace = false;
  let emittedNonSpace = false;
  let i = 0;

  const markSpace = () => { if (emittedNonSpace) pendingSpace = true; };

  const pushChar = (ch, start, end) => {
    if (pendingSpace) {
      chars.push(' ');
      starts.push(start);
      ends.push(start);
      pendingSpace = false;
    }
    chars.push(ch);
    starts.push(start);
    ends.push(end);
    emittedNonSpace = true;
  };

  while (i < html.length) {
    const c = html[i];
    if (c === '<') {
      const gt = html.indexOf('>', i);
      if (gt === -1) break;
      markSpace();
      i = gt + 1;
      continue;
    }
    if (c === '&') {
      const semi = html.indexOf(';', i);
      if (semi !== -1 && semi - i <= 10) {
        const entity = html.slice(i, semi + 1);
        const decoded = _decodeHtmlEntity(entity);
        if (decoded != null) {
          for (const dc of decoded) {
            if (/\s/.test(dc)) markSpace();
            else pushChar(dc, i, semi + 1);
          }
          i = semi + 1;
          continue;
        }
      }
    }
    if (/\s/.test(c)) {
      markSpace();
      i++;
      continue;
    }
    pushChar(c, i, i + 1);
    i++;
  }
  return { text: chars.join(''), starts, ends };
}

/**
 * Sucht `needle` in `html`. Exakter Substring-Match hat Vorrang; sonst
 * toleranter Match über die Text-View (Tags ignorieren, Entities dekodieren,
 * Whitespace kollabieren). Gibt { htmlStart, htmlEnd } zurück oder null.
 *
 * Typischer Fall: Chat-/Lektorat-KI sieht die Seite als Plaintext und
 * liefert `Er sagte das magische Wort.`, im HTML steht aber
 * `Er sagte <em>das magische</em> Wort.`. Der Tolerant-Match findet die
 * Stelle trotzdem; die `<em>`-Tags fallen beim Ersatz weg, was akzeptabel
 * ist, weil die KI ohnehin eine neue Formulierung vorschlägt.
 */
export function findInHtml(html, needle) {
  if (!html || !needle) return null;
  const exact = html.indexOf(needle);
  if (exact !== -1) return { htmlStart: exact, htmlEnd: exact + needle.length };

  const normalized = needle.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  const { text, starts, ends } = _buildHtmlTextMap(html);
  const idx = text.indexOf(normalized);
  if (idx === -1) return null;
  return { htmlStart: starts[idx], htmlEnd: ends[idx + normalized.length - 1] };
}

const _VOID_TAGS = new Set([
  'area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr',
]);

/**
 * Findet im Slice Tags ohne Partner: Closes ohne vorheriges Open im Slice
 * (Open liegt VOR dem Slice, Tag muss nach dem Replacement erhalten bleiben),
 * bzw. Opens ohne nachfolgendes Close im Slice (Close liegt NACH dem Slice).
 * Self-closing/Void-Elemente werden ignoriert.
 */
function _splitOrphanTags(slice) {
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  const stack = [];
  const orphanCloses = [];
  let m;
  while ((m = tagRe.exec(slice))) {
    const full = m[0];
    const tag = m[1].toLowerCase();
    if (_VOID_TAGS.has(tag) || /\/>$/.test(full)) continue;
    if (full.startsWith('</')) {
      if (stack.length && stack[stack.length - 1].tag === tag) stack.pop();
      else orphanCloses.push(full);
    } else {
      stack.push({ tag, full });
    }
  }
  return { orphanOpens: stack.map(s => s.full), orphanCloses };
}

/**
 * Ersetzt `needle` im HTML durch `replacement`. Nutzt `findInHtml` für die
 * Position. Wenn der Match Tag-Grenzen kreuzt (toleranter Match), bleiben
 * Waisen-Tags innerhalb der ersetzten Range erhalten, sonst zerbricht die
 * Tag-Balance (typisch: KI ändert Phrase, die ein `<em>kursiv</em>` umfasst,
 * dabei darf weder das öffnende noch das schliessende Tag verloren gehen).
 *
 * Gibt das neue HTML zurück, oder das Original wenn nichts gefunden.
 */
export function replaceInHtml(html, needle, replacement) {
  if (!html || !needle) return html;
  const m = findInHtml(html, needle);
  if (!m) return html;
  const removed = html.slice(m.htmlStart, m.htmlEnd);
  let inserted = replacement;
  if (removed.includes('<')) {
    const { orphanOpens, orphanCloses } = _splitOrphanTags(removed);
    if (orphanOpens.length || orphanCloses.length) {
      inserted = orphanOpens.join('') + replacement + orphanCloses.join('');
    }
  }
  return html.slice(0, m.htmlStart) + inserted + html.slice(m.htmlEnd);
}

/**
 * Einfaches Markdown → HTML für Chat-Antworten.
 * Unterstützt: # Überschriften, **fett**, *kursiv*, `code`, Zeilenumbrüche, Listen (- und 1.).
 */
export function renderChatMarkdown(text) {
  if (!text) return '';
  let html = escHtml(text);

  // Überschriften: ### ## #
  html = html.replace(/^### (.+)$/gm, '<h4 class="chat-heading chat-heading--3">$1</h4>');
  html = html.replace(/^## (.+)$/gm,  '<h3 class="chat-heading chat-heading--2">$1</h3>');
  html = html.replace(/^# (.+)$/gm,   '<h2 class="chat-heading chat-heading--1">$1</h2>');

  // Geordnete Listen: Zeilen mit «1. » «2. » usw. → temporäres <oli>-Tag
  html = html.replace(/^\d+\. (.+)$/gm, '<oli>$1</oli>');
  html = html.replace(/(<oli>.*?<\/oli>\n{0,2})+/g, m =>
    '<ol class="chat-list chat-list--ol">' +
    m.replace(/<oli>/g, '<li>').replace(/<\/oli>\n{0,2}/g, '</li>') +
    '</ol>');

  // Horizontale Linie
  html = html.replace(/^---$/gm, '<hr class="chat-hr">');

  // Markdown-Tabellen: Block aus Zeilen die mit | beginnen
  html = html.replace(/((?:\|[^\n]+\n)+)/g, (block) => {
    const lines = block.trimEnd().split('\n');
    if (lines.length < 3) return block;
    if (!/^\|[\s\-:|]+\|$/.test(lines[1])) return block;
    const headers = lines[0].split('|').slice(1, -1).map(h => h.trim());
    const rows = lines.slice(2).map(row => row.split('|').slice(1, -1).map(c => c.trim()));
    const thead = `<tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr>`;
    const tbody = rows.map(row => `<tr>${row.map(c => `<td>${c}</td>`).join('')}</tr>`).join('');
    return `<table class="chat-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
  });

  // Ungeordnete Listen: Zeilen mit «- » oder «* » → temporäres <uli>-Tag
  html = html.replace(/^[-*] (.+)$/gm, '<uli>$1</uli>');
  html = html.replace(/(<uli>.*?<\/uli>\n{0,2})+/g, m =>
    '<ul class="chat-list">' +
    m.replace(/<uli>/g, '<li>').replace(/<\/uli>\n{0,2}/g, '</li>') +
    '</ul>');

  // Inline: **fett**
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Inline: *kursiv*
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Inline: `code`
  html = html.replace(/`([^`]+)`/g, '<code class="chat-code">$1</code>');

  // Leerzeile → <br><br> (direkt, ohne weitere \n die nochmals zu <br> werden)
  html = html.replace(/\n\n+/g, '<br><br>');
  // Einfacher Zeilenumbruch → <br>
  html = html.replace(/\n/g, '<br>');

  // Überschüssige <br> direkt vor/nach Block-Elementen entfernen
  html = html.replace(/(<br>\s*)+(<(?:ol|ul|h[2-4]|hr)\b)/gi, '$2');
  html = html.replace(/(\/(?:ol|ul|h[2-4])>|<hr[^>]*>)(\s*<br>)+/gi, '$1');

  return html;
}
