'use strict';
// Substack-Export. Zielformat ist NICHT ein Substack-API-Upload (Substack hat
// keine offizielle Publishing-API), sondern eine paste-fertige HTML-Datei: der
// Autor oeffnet sie, markiert den Body unterhalb der Trennlinie und fuegt ihn in
// den Substack-Editor ein (Clipboard-HTML -> Substack-Bloecke).
//
// Unterschiede zum generischen html.js-Export, alle Substack-spezifisch:
//  1. Titel steht NICHT als <h1> im Body — Substack hat ein separates Titelfeld.
//     Er liegt in einer klar abgesetzten Meta-Box oben, die der Autor ins
//     Titelfeld kopiert.
//  2. Ueberschriften werden auf Substacks zwei Ebenen geklemmt: Ueberschrift (h2)
//     und Unterueberschrift (h3); alles tiefer -> fetter Absatz. Substack kollabiert
//     tiefere Ebenen ohnehin.
//  3. Nur Substack-vertraegliches Inline-Markup (strong/em/u/a, <br>), Listen,
//     Blockquote, hr, Bilder. Tabellen/CSS/Klassen wuerden beim Paste gestrippt.
//  4. Bilder mit nicht-oeffentlicher URL werden gezaehlt und gewarnt — Substack
//     kann nur http(s)-URLs nachladen.
//
// Quelle ist wie bei md.js ausschliesslich das html-clean-bereinigte body_html
// -> html-walker -> Block-Serializer. Kein weiterer Dependency.

const { parseHtmlToBlocks } = require('../pdf-render/html-walker');
const { escXml, resolveTitle, chapterDepth, buildChaptersById, prepareCitations, notesTitleFor } = require('./shared');
const { bibliographyItemHtml } = require('../bibliography');
const { endnoteItemHtml } = require('../endnotes');

// Lokalisierte Labels fuer die Meta-/Instruktions-Box. Kein public/js/i18n hier —
// das ist erzeugter Datei-Inhalt, kein App-UI; Sprache kommt aus book_settings
// (opts.lang) analog zum lang-Attribut in html.js.
const L = {
  de: {
    boxTitle: 'Für Substack',
    titleLabel: 'Titel (in Substacks Titelfeld einfügen):',
    instr: 'Den Inhalt unterhalb der Linie markieren und in den Substack-Editor einfügen. Der Titel oben gehört ins separate Titelfeld, nicht in den Text.',
    imgWarn: n => `${n} Bild${n === 1 ? '' : 'er'} ohne öffentliche URL — Substack kann sie nicht laden. Nach dem Einfügen im Substack-Editor manuell hochladen.`,
    divider: 'Ab hier in den Substack-Body kopieren',
  },
  en: {
    boxTitle: 'For Substack',
    titleLabel: 'Title (paste into Substack’s title field):',
    instr: 'Select everything below the line and paste it into the Substack editor. The title above belongs in the separate title field, not in the body.',
    imgWarn: n => `${n} image${n === 1 ? '' : 's'} without a public URL — Substack cannot load them. Upload them manually in the Substack editor after pasting.`,
    divider: 'Copy into the Substack body from here down',
  },
};

const STYLE = `
:root { color-scheme: light; }
body { font-family: 'Lora', Georgia, serif; line-height: 1.55; max-width: 72ch; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
h2 { font-size: 1.6em; margin-top: 1.6em; }
h3 { font-size: 1.2em; margin-top: 1.4em; }
p { margin: 0 0 0.8em; }
blockquote { border-left: 3px solid #888; margin: 1em 0; padding-left: 1em; color: #555; }
pre { font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace; font-size: 0.9em; white-space: pre-wrap; background: #f6f6f4; border: 1px solid #e2e2de; border-radius: 4px; padding: 0.7em 0.9em; margin: 1em 0; overflow-x: auto; }
img { max-width: 100%; height: auto; }
hr { border: 0; border-top: 1px solid #ddd; margin: 2em 0; }
.substack-meta { border: 1px solid #c9c9c9; background: #f6f6f4; border-radius: 4px; padding: 0.8rem 1rem; margin-bottom: 1.5rem; font-family: system-ui, sans-serif; font-size: 0.9em; }
.substack-meta h1 { font-size: 1.1em; margin: 0 0 0.4rem; }
.substack-meta .stk-title { font-size: 1.25em; font-weight: 700; margin: 0.2rem 0 0.6rem; font-family: 'Lora', Georgia, serif; }
.substack-meta .stk-warn { color: #8a3b00; margin: 0.4rem 0 0; }
.substack-divider { border: 0; border-top: 2px dashed #b45; margin: 1.5rem 0; text-align: center; }
.substack-divider span { display: inline-block; transform: translateY(-0.75em); background: #fff; padding: 0 0.6rem; font-family: system-ui, sans-serif; font-size: 0.8em; color: #b45; }
`.trim();

function _runsToHtml(runs) {
  let out = '';
  for (const r of runs || []) {
    if (r.text === '\n') { out += '<br>'; continue; }
    let t = escXml(r.text || '');
    if (r.bold)      t = `<strong>${t}</strong>`;
    if (r.italic)    t = `<em>${t}</em>`;
    if (r.underline) t = `<u>${t}</u>`;
    if (r.sup)       t = `<sup>${t}</sup>`;
    if (r.link)      t = `<a href="${escXml(r.link)}">${t}</a>`;
    out += t;
  }
  return out;
}

// Klemmt eine nominale Ueberschriften-Ebene auf Substacks Modell:
// 1-2 -> h2 (Ueberschrift), 3 -> h3 (Unterueberschrift), >=4 -> fetter Absatz.
function _headingHtml(level, text) {
  const t = escXml(text || '');
  if (level >= 4) return `<p><strong>${t}</strong></p>`;
  const tag = level <= 2 ? 'h2' : 'h3';
  return `<${tag}>${t}</${tag}>`;
}

function _blockToHtml(block, depth, imgSink) {
  switch (block.kind) {
    case 'heading':
      return _headingHtml(block.level + depth, block.text);
    case 'paragraph': {
      const inner = _runsToHtml(block.runs);
      return inner ? `<p>${inner}</p>` : '';
    }
    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul';
      const items = (block.items || []).map((itemBlocks) => {
        const inner = itemBlocks.map(b => _blockToHtml(b, depth + 1, imgSink)).join('');
        // <li> darf keine <p> als Kind haben (Substack flacht das ohnehin) —
        // ein Absatz-Item wird zu reinem Inline-Inhalt.
        const unwrapped = inner.replace(/^<p>([\s\S]*)<\/p>$/, '$1');
        return `<li>${unwrapped}</li>`;
      }).join('');
      return items ? `<${tag}>${items}</${tag}>` : '';
    }
    case 'blockquote': {
      const inner = (block.blocks || []).map(b => _blockToHtml(b, depth, imgSink)).join('');
      return inner ? `<blockquote>${inner}</blockquote>` : '';
    }
    case 'poem': {
      // Substack strippt class+style -> Zeilen ueber <br> in einem Absatz halten.
      const lines = (block.lines || []).map(_runsToHtml);
      return lines.length ? `<p>${lines.join('<br>')}</p>` : '';
    }
    case 'image': {
      const src = block.src || '';
      if (!/^https?:\/\//i.test(src)) imgSink.nonPublic += 1;
      return `<figure><img src="${escXml(src)}" alt="${escXml(block.alt || '')}"></figure>`;
    }
    case 'pre': {
      // Codeblock — und damit auch der Quelltext eines Diagramms, das diesen
      // Walker erreicht (lib/diagram-export.js, Invariante B: nicht renderbar ⇒
      // Quelltext bleibt stehen). Substack kann kein `data:`-Bild und keine
      // Diagramm-Notation zeichnen, also bleibt es der Quelltext.
      //
      // Rohtext ueber escXml, NICHT `_runsToHtml`: in einem `<pre>` ist jedes
      // Zeichen Inhalt, und ein als Kursiv-Marker gelesenes `_` zerlegte den
      // Diagramm-Code.
      const text = (block.lines || [])
        .map(runs => (runs || []).map(r => r.text || '').join(''))
        .join('\n');
      return text.trim() ? `<pre>${escXml(text)}</pre>` : '';
    }
    case 'hr':
      return '<hr>';
    default:
      return '';
  }
}

function _pageToHtml(html, imgSink) {
  if (!html) return '';
  try {
    return parseHtmlToBlocks(html).map(b => _blockToHtml(b, 0, imgSink)).join('\n');
  } catch {
    const txt = String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return txt ? `<p>${escXml(txt)}</p>` : '';
  }
}

async function buildSubstack(bundle, opts = {}) {
  const { scope, book, chapter, page } = bundle;
  const { groups, bib, showBibliography } = await prepareCitations(bundle, opts);
  const t = L[opts.lang === 'en' ? 'en' : 'de'];
  const title = resolveTitle({ scope, book, chapter, page });
  const imgSink = { nonPublic: 0 };

  const body = [];
  const byId = buildChaptersById(groups);
  for (const g of groups) {
    const ch = g.chapter;
    if (ch && (scope === 'book' || scope === 'chapter')) {
      const d = chapterDepth(ch, byId);
      body.push(_headingHtml(d + 1, ch.name));
    }
    const includePageHeadings = scope === 'book' && ch && g.pages.length > 1;
    for (const x of g.pages) {
      if (includePageHeadings) {
        const d = chapterDepth(ch, byId);
        body.push(_headingHtml(d + 2, x.p.name));
      }
      const html = _pageToHtml(x.pd?.html || '', imgSink);
      if (html) body.push(html);
    }
    if (g.notes && g.notes.length) {
      body.push(_headingHtml(3, notesTitleFor(bib)));
      body.push(_pageToHtml(endnoteItemHtml(g.notes), imgSink));
    }
  }
  // Quellenverzeichnis durch denselben Block-Serializer wie der Buchtext — das
  // Ergebnis muss Substacks Paste-Filter ueberleben (kein class/style, nur <p>
  // und <em>). Ueberschrift auf Substacks oberster Ebene.
  if (showBibliography) {
    body.push(_headingHtml(2, bib.title));
    body.push(_pageToHtml(bibliographyItemHtml(bib), imgSink));
  }

  const meta = [];
  meta.push('<div class="substack-meta">');
  meta.push(`<h1>${escXml(t.boxTitle)}</h1>`);
  meta.push(`<div>${escXml(t.titleLabel)}</div>`);
  meta.push(`<div class="stk-title">${escXml(title)}</div>`);
  meta.push(`<div>${escXml(t.instr)}</div>`);
  if (imgSink.nonPublic > 0) meta.push(`<div class="stk-warn">${escXml(t.imgWarn(imgSink.nonPublic))}</div>`);
  meta.push('</div>');
  meta.push(`<div class="substack-divider"><span>${escXml(t.divider)}</span></div>`);

  const parts = [
    '<!DOCTYPE html>',
    `<html lang="${escXml(opts.lang === 'en' ? 'en' : 'de')}"><head><meta charset="UTF-8"><title>${escXml(title)}</title>`,
    `<style>${STYLE}</style>`,
    '</head><body>',
    meta.join('\n'),
    body.join('\n'),
    '</body></html>',
  ];
  return Buffer.from(parts.join('\n'), 'utf8');
}

module.exports = { buildSubstack };
