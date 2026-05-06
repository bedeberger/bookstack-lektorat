'use strict';
// Übersetzt BookStack-Page-HTML in Render-Operationen für lib/pdf-render.js.
// Ausgabe ist ein flacher Array von „Blocks":
//   { kind: 'heading',  level, text, anchorId? }
//   { kind: 'paragraph', runs: Run[] }
//   { kind: 'list', ordered: bool, items: Block[][] }
//   { kind: 'blockquote', blocks: Block[] }
//   { kind: 'poem',      lines: Run[][] }       // .poem-Klasse
//   { kind: 'image',     src, alt }
//   { kind: 'hr' }
//
// Run = { text: string, bold?, italic?, underline?, link? }
//
// Tabellen und unbekannte Elemente werden geskippt (Inhalt wird als Plain-Text
// durchgereicht, falls er textbasierend ist; nicht aber als Block-Strukturen).
// Whitelist orientiert sich an dem, was BookStack-WYSIWYG erzeugt: h1-h3, p,
// ul/ol/li, blockquote, div.poem (eigene Klasse aus editor-toolbar.js), pre,
// img, hr, br + inline strong/em/u/a.

const { parseHTML } = require('linkedom');

const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'div', 'img', 'hr', 'br']);

function _hasClass(el, cls) {
  const c = el.getAttribute && el.getAttribute('class');
  if (!c) return false;
  return c.split(/\s+/).includes(cls);
}

// Sammelt Text-Runs der Kinder von `parent` rekursiv. Inline-Stil-Stack via
// strong/em/u/a. <br> emittiert einen \n-Run. Verschachtelte Block-Elemente
// werden geskippt — BookStack-WYSIWYG verschachtelt das selten.
function _collectChildrenRuns(parent, ctx, out) {
  for (const child of parent.childNodes) _collectInline(child, ctx, out);
}

function _collectInline(node, ctx, out) {
  if (node.nodeType === 3) {
    let text = node.textContent || '';
    if (!ctx.preserveWhitespace) text = text.replace(/\s+/g, ' ');
    if (text === '') return;
    out.push({ ...ctx.style, text });
    return;
  }
  if (node.nodeType !== 1) return;
  const tag = node.tagName ? node.tagName.toLowerCase() : '';

  let nextStyle = ctx.style;
  if (tag === 'strong' || tag === 'b')   nextStyle = { ...nextStyle, bold: true };
  if (tag === 'em' || tag === 'i')       nextStyle = { ...nextStyle, italic: true };
  if (tag === 'u')                       nextStyle = { ...nextStyle, underline: true };
  if (tag === 'a') {
    const href = node.getAttribute('href');
    if (href) nextStyle = { ...nextStyle, underline: true, link: href };
  }
  if (tag === 'br') {
    out.push({ ...ctx.style, text: '\n' });
    return;
  }
  // Verschachteltes Block-Element innerhalb eines Paragraph/Heading? Inhalt
  // einsammeln statt skippen, sonst geht Text verloren.
  for (const child of node.childNodes) _collectInline(child, { ...ctx, style: nextStyle }, out);
}

function _trimRuns(runs) {
  // Leere Runs entfernen, gleichzeitig führende/abschließende Whitespace-Runs
  // trimmen.
  const trimmed = runs.filter(r => r.text !== '');
  while (trimmed.length && /^\s*$/.test(trimmed[0].text)) trimmed.shift();
  while (trimmed.length && /^\s*$/.test(trimmed[trimmed.length - 1].text)) trimmed.pop();
  return trimmed;
}

function _walkBlock(el, ctx, blocks) {
  const tag = el.tagName ? el.tagName.toLowerCase() : '';

  // div.poem → eigener Block-Typ. Erkennt sowohl <div class="poem"> als auch
  // <blockquote class="poem">. Verse-Inhalt wird zeilenweise gesammelt; jede
  // Quelle-Zeile = eigenes Run-Array.
  if ((tag === 'div' || tag === 'blockquote') && _hasClass(el, 'poem')) {
    const lines = [];
    for (const child of el.childNodes) {
      if (child.nodeType === 1 && /^(p|div)$/i.test(child.tagName)) {
        const runs = [];
        _collectChildrenRuns(child, { style: { italic: true }, preserveWhitespace: true }, runs);
        // Wenn der Absatz selbst <br>s enthält, splitten wir hier auf:
        const acc = [];
        let cur = [];
        for (const r of runs) {
          if (r.text === '\n') { acc.push(_trimRuns(cur)); cur = []; }
          else cur.push(r);
        }
        if (cur.length) acc.push(_trimRuns(cur));
        for (const a of acc) if (a.length) lines.push(a);
      } else if (child.nodeType === 3) {
        const t = (child.textContent || '').split(/\n/);
        for (const line of t) {
          const s = line.trim();
          if (s) lines.push([{ text: s, italic: true }]);
        }
      }
    }
    if (lines.length) blocks.push({ kind: 'poem', lines });
    return;
  }

  if (tag === 'div') {
    // Generischer div ohne Poem-Klasse → durchwalken (BookStack nutzt teilweise
    // Wrapper-Divs für Editor-State).
    for (const child of el.childNodes) _walkNode(child, ctx, blocks);
    return;
  }

  if (tag === 'p') {
    const runs = [];
    _collectChildrenRuns(el, { style: {}, preserveWhitespace: false }, runs);
    const t = _trimRuns(runs);
    if (t.length) blocks.push({ kind: 'paragraph', runs: t });
    return;
  }

  if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') {
    const level = Math.min(3, parseInt(tag[1]));
    const runs = [];
    _collectChildrenRuns(el, { style: {}, preserveWhitespace: false }, runs);
    const text = _trimRuns(runs).map(r => r.text).join('').trim();
    if (text) blocks.push({ kind: 'heading', level, text });
    return;
  }

  if (tag === 'ul' || tag === 'ol') {
    const items = [];
    for (const child of el.childNodes) {
      if (child.nodeType === 1 && child.tagName.toLowerCase() === 'li') {
        const sub = [];
        // li-Inhalt: ggf. mehrere Blocks (verschachtelte Listen, p, …)
        // Einfachfall: collectRuns auf Top-Level-Inline + rekursiv für innere
        // Block-Tags.
        const inlineRuns = [];
        for (const liChild of child.childNodes) {
          if (liChild.nodeType === 1 && BLOCK_TAGS.has(liChild.tagName.toLowerCase())
              && liChild.tagName.toLowerCase() !== 'br') {
            // Block innerhalb li → vorher inline-Runs zu paragraph machen.
            if (inlineRuns.length) {
              const t = _trimRuns(inlineRuns.splice(0));
              if (t.length) sub.push({ kind: 'paragraph', runs: t });
            }
            _walkNode(liChild, ctx, sub);
          } else {
            _collectInline(liChild, { style: {}, preserveWhitespace: false }, inlineRuns);
          }
        }
        if (inlineRuns.length) {
          const t = _trimRuns(inlineRuns);
          if (t.length) sub.unshift({ kind: 'paragraph', runs: t });
        }
        items.push(sub);
      }
    }
    if (items.length) blocks.push({ kind: 'list', ordered: tag === 'ol', items });
    return;
  }

  if (tag === 'blockquote') {
    const sub = [];
    for (const child of el.childNodes) _walkNode(child, ctx, sub);
    if (sub.length) blocks.push({ kind: 'blockquote', blocks: sub });
    return;
  }

  if (tag === 'pre') {
    // Plain-Text mit erhaltenen Whitespaces; rendern wir als Poem-ähnlich
    // ohne Italic, mit Body-Font monospace-Skala (Renderer entscheidet).
    const text = el.textContent || '';
    const lines = text.split(/\n/).map(l => [{ text: l }]);
    blocks.push({ kind: 'pre', lines });
    return;
  }

  if (tag === 'img') {
    const src = el.getAttribute('src');
    const alt = el.getAttribute('alt') || '';
    if (src) blocks.push({ kind: 'image', src, alt });
    return;
  }

  if (tag === 'hr') {
    blocks.push({ kind: 'hr' });
    return;
  }

  if (tag === 'table') {
    // Tabellen werden bewusst nicht gerendert (s. CLAUDE.md / Spec).
    // Inhalt als Fließtext-Fallback einsammeln, damit kein Inhalt verschwindet.
    const runs = [];
    _collectChildrenRuns(el, { style: {}, preserveWhitespace: false }, runs);
    const t = _trimRuns(runs);
    if (t.length) blocks.push({ kind: 'paragraph', runs: t });
    return;
  }

  // Unbekannt → Inhalte einsammeln und als paragraph fallback durchreichen.
  const runs = [];
  _collectChildrenRuns(el, { style: {}, preserveWhitespace: false }, runs);
  const t = _trimRuns(runs);
  if (t.length) blocks.push({ kind: 'paragraph', runs: t });
}

function _walkNode(node, ctx, blocks) {
  if (node.nodeType === 1) return _walkBlock(node, ctx, blocks);
  if (node.nodeType === 3) {
    const t = (node.textContent || '').replace(/\s+/g, ' ').trim();
    if (t) blocks.push({ kind: 'paragraph', runs: [{ text: t }] });
  }
}

/**
 * Parst einen HTML-Snippet (typisch BookStack-Page.html) in Block-Liste.
 * Eingabe darf außerhalb eines `<body>` stehen — linkedom packt automatisch.
 *
 * @param {string} html
 * @returns {Block[]}
 */
function parseHtmlToBlocks(html) {
  const { document } = parseHTML(`<!doctype html><html><body>${html || ''}</body></html>`);
  const root = document.body;
  const blocks = [];
  for (const child of root.childNodes) _walkNode(child, {}, blocks);
  return blocks;
}

module.exports = { parseHtmlToBlocks };
