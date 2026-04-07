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
