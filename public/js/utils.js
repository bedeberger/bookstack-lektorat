// Zeichenanzahl pro Token für deutschen Text (Komposita, Umlaute → dichter als Englisch).
export const CHARS_PER_TOKEN = 3;

// Sicherheitscheck vor dem Speichern: < 50 % wirkt unvollständig → Abbruch
export const SAFETY_HTML_RATIO = 0.5;

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
    .replace(/"/g, '&quot;');
}

export function htmlToText(html) {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d.textContent || d.innerText || '';
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
  if (!html.includes('focus-paragraph-active') && !/font-size|background-color\s*:\s*transparent/i.test(html)) {
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
