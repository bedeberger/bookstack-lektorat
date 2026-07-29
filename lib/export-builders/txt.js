'use strict';
// Plain-Text-Export. Verkettet Titel + Kapitel-/Page-Headings + Body. `<br>`
// wird zu `\n` (Shift-Enter aus den Editoren = harter Zeilenumbruch); übrige
// Tags zu Single-Space, horizontale Whitespaces collapsed, Mehrfach-Leerzeilen
// auf max. 2 begrenzt.

const { resolveTitle, prepareCitations, notesTitleFor } = require('./shared');
const { bibliographyItemLines } = require('../bibliography');

function htmlToText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function buildTxt(bundle, opts = {}) {
  const { scope, book, chapter, page } = bundle;
  const { groups, bib, showBibliography } = await prepareCitations(bundle, opts);
  const out = [];
  const title = resolveTitle({ scope, book, chapter, page });
  if (title) out.push(title, '');

  for (const g of groups) {
    const ch = g.chapter;
    if (ch && (scope === 'book' || scope === 'chapter')) {
      out.push(ch.name);
      out.push('');
    }
    const includePageHeadings = scope === 'book' && ch && g.pages.length > 1;
    for (const x of g.pages) {
      if (includePageHeadings) {
        out.push(x.p.name);
        out.push('');
      }
      const txt = htmlToText(x.pd.html);
      if (txt) { out.push(txt); out.push(''); }
    }
    if (g.notes && g.notes.length) {
      out.push(notesTitleFor(bib), '');
      for (const nt of g.notes) out.push(`${nt.n}. ${nt.text}`);
      out.push('');
    }
  }
  // Quellenverzeichnis: Klartext-Form der Eintraege (bib.entries[].text) statt
  // des HTML — Plaintext hat keinen Kursivsatz, den man strippen muesste. Das
  // `[n]`-Praefix des numerischen Stils setzt bibliographyItemLines, damit die
  // Nummern-Regel nicht in jedem Builder erneut steht.
  if (showBibliography) {
    out.push(bib.title, '');
    out.push(...bibliographyItemLines(bib));
    out.push('');
  }
  // BOM wird vom Caller (routes/export.js) gesetzt — Builder liefert nackten
  // UTF-8-Text.
  return Buffer.from(out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n', 'utf8');
}

module.exports = { buildTxt, htmlToText };
