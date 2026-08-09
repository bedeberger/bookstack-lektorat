'use strict';
// Markdown-Export. Quelle ist ausschliesslich das (html-clean-bereinigte)
// `pages.body_html` → html-walker → simple Markdown-Renderer. Kein turndown-Dep
// — die App-eigenen Walker-Blocks decken den Editor-WYSIWYG-Markup-Range
// (h1-h3/p/ul/ol/blockquote/pre/img/hr + inline strong/em/u/a) vollstaendig ab.

const { parseHtmlToBlocks } = require('../pdf-render/html-walker');
const { bibliographyItemHtml } = require('../bibliography');
const { endnoteItemHtml } = require('../endnotes');
const { resolveTitle, chapterDepth, buildChaptersById, prepareCitations, notesTitleFor } = require('./shared');
const { buildXrefContext, applyXrefsInGroups } = require('../xref-render');
const { directoryMd } = require('../anchor-directory');
const headline = require('../headline-render');

function _escMd(text) {
  return String(text || '').replace(/([_*`~])/g, '\\$1');
}

function _runsToMd(runs) {
  let out = '';
  for (const r of runs || []) {
    let t = r.text || '';
    if (t === '\n') { out += '  \n'; continue; }
    t = _escMd(t);
    if (r.bold)     t = `**${t}**`;
    if (r.italic)   t = `*${t}*`;
    // Markdown kennt keine Hochstellung — Inline-HTML ist der uebliche Weg und
    // wird von jedem gaengigen Renderer (GitHub, Pandoc, Static-Site-Generator)
    // durchgereicht. Die Notenziffer als blosse Zahl waere im Fliesstext nicht
    // mehr als Marker erkennbar.
    if (r.sup)      t = `<sup>${t}</sup>`;
    if (r.link)     t = `[${t}](${r.link})`;
    out += t;
  }
  return out;
}

function _blockToMd(block, depth = 0) {
  switch (block.kind) {
    case 'heading': {
      const h = '#'.repeat(Math.min(6, block.level + depth));
      return `${h} ${_escMd(block.text || '')}\n\n`;
    }
    case 'paragraph':
      return `${_runsToMd(block.runs)}\n\n`;
    case 'list': {
      const marker = (i) => block.ordered ? `${i + 1}.` : '-';
      let out = '';
      block.items.forEach((itemBlocks, i) => {
        const inner = itemBlocks.map(b => _blockToMd(b, depth + 1)).join('').trimEnd();
        const indented = inner.replace(/\n/g, '\n  ');
        out += `${marker(i)} ${indented}\n`;
      });
      return out + '\n';
    }
    case 'blockquote': {
      const inner = (block.blocks || []).map(b => _blockToMd(b, depth)).join('').trimEnd();
      return inner.split('\n').map(l => `> ${l}`).join('\n') + '\n\n';
    }
    case 'poem': {
      const lines = (block.lines || []).map(_runsToMd);
      return lines.join('  \n') + '\n\n';
    }
    case 'image': {
      const alt = _escMd(block.alt || '');
      return `![${alt}](${block.src})\n\n`;
    }
    case 'pre': {
      // Codeblock als Fence. `lang` kommt vom Walker; bei `mermaid` erzeugt das
      // einen Block, den Markdown-Renderer mit Diagramm-Unterstuetzung selbst
      // zeichnen — der Quelltext ist im Zielformat mehr wert als ein Bild.
      // Rohtext, NICHT `_runsToMd`: in einem Fence gibt es keine
      // Markdown-Sonderzeichen zu escapen, und ein escaptes `A --\*> B` waere
      // kein gültiger Diagramm-Quelltext mehr.
      const text = (block.lines || [])
        .map(runs => (runs || []).map(r => r.text || '').join(''))
        .join('\n');
      return '```' + (block.lang || '') + '\n' + text + '\n```\n\n';
    }
    case 'table': {
      // GFM-Pipe-Tabelle. Sie braucht zwingend eine Kopfzeile plus die
      // Trennzeile — ohne die rendert kein Markdown-Prozessor eine Tabelle,
      // sondern Zeilen voller Pipes. Eine Tabelle ohne Kopf bekommt darum eine
      // LEERE Kopfzeile: die Struktur bleibt sichtbar, ohne der ersten
      // Datenzeile die Rolle einer Ueberschrift anzudichten.
      const cols = (block.align || []).length
        || Math.max(...(block.rows || [[]]).map(r => r.length), 1);
      // `|` in einer Zelle beendet dort die Spalte — in GFM wird es escaped.
      // Weiche Umbrueche gibt es in einer Pipe-Zeile nicht (der Walker hat sie
      // schon zu Leerzeichen gemacht), `_runsToMd` kann hier also keine `  \n`
      // mehr erzeugen.
      const cell = (runs) => _runsToMd(runs).replace(/\|/g, '\\|').trim() || ' ';
      const pad = (arr) => {
        const out = (arr || []).slice(0, cols).map(cell);
        while (out.length < cols) out.push(' ');
        return out;
      };
      const sep = (block.align || []).slice(0, cols).map((a) => {
        if (a === 'center') return ':---:';
        if (a === 'right') return '---:';
        return '---';
      });
      while (sep.length < cols) sep.push('---');
      const lines = [
        `| ${pad(block.header).join(' | ')} |`,
        `| ${sep.join(' | ')} |`,
        ...(block.rows || []).map(r => `| ${pad(r).join(' | ')} |`),
      ];
      // Beschriftung als kursive Zeile unter der Tabelle — Markdown hat kein
      // `<caption>`, und Inline-HTML waere hier der schlechtere Tausch.
      const cap = _runsToMd(block.caption).trim();
      return lines.join('\n') + '\n' + (cap ? `\n*${cap}*\n` : '') + '\n';
    }
    case 'hr':
      return '---\n\n';
    default:
      return '';
  }
}

function _htmlToMd(html) {
  if (!html) return '';
  try {
    const blocks = parseHtmlToBlocks(html);
    return blocks.map(b => _blockToMd(b)).join('').trimEnd();
  } catch {
    return String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

function _pageMd(page) {
  return _htmlToMd(page?.html || '');
}

async function buildMd(bundle, opts = {}) {
  const { scope, book, chapter, page } = bundle;
  const prepared = await prepareCitations(bundle, opts);
  const { bib, showBibliography } = prepared;
  // Querverweise aufloesen (Begruendung wie im HTML-Builder). Ohne
  // `chapterLabels`: Markdown nummeriert seine Ueberschriften nicht.
  const xrefCtx = await buildXrefContext({ bookId: book?.book_id, groups: prepared.groups });
  const groups = (await applyXrefsInGroups(prepared.groups, xrefCtx)).groups;
  const out = [];
  const title = resolveTitle({ scope, book, chapter, page });
  if (title) out.push(`# ${_escMd(title)}`, '');

  const byId = buildChaptersById(groups);
  for (const g of groups) {
    const ch = g.chapter;
    if (ch && (scope === 'book' || scope === 'chapter')) {
      const d = chapterDepth(ch, byId);
      out.push(`${'#'.repeat(Math.min(6, d + 1))} ${_escMd(ch.name)}`, '');
    }
    const includePageHeadings = scope === 'book' && ch && g.pages.length > 1;
    for (const x of g.pages) {
      // Titel-Kopf: Dachzeile fett ueber der Ueberschrift, Lead kursiv darunter
      // — dieselbe Auszeichnung, die das Kopf-Markup traegt
      // (lib/headline-render.js), hier direkt in Markdown statt durch den Walker.
      const kicker = headline.kickerText(x.p);
      const lead = headline.leadText(x.p);
      const hasHeading = includePageHeadings || headline.needsOwnHead(x.p);
      if (hasHeading) {
        const h = '#'.repeat(Math.min(6, chapterDepth(ch, byId) + 2));
        if (kicker) out.push(`**${_escMd(kicker)}**`, '');
        out.push(`${h} ${_escMd(headline.pageTitle(x.p))}`, '');
        if (lead) out.push(`*${_escMd(lead)}*`, '');
      }
      const body = _pageMd(x.pd);
      if (body) out.push(body, '');
    }
    if (g.notes && g.notes.length) {
      out.push(`### ${_escMd(notesTitleFor(bib))}`, '');
      const notes = _htmlToMd(endnoteItemHtml(g.notes));
      if (notes) out.push(notes, '');
    }
  }
  // Quellenverzeichnis durch denselben Walker wie der Buchtext — so wird der
  // kursive Titel im Eintrag zu `*…*` statt zu rohem <em> (geteiltes
  // Eintrags-Markup: lib/bibliography.js#bibliographyItemHtml). Ueberschrift auf
  // Kapitelebene (h2), wie ein Top-Kapitel.
  // Abbildungs-/Tabellenverzeichnis, Sichtbarkeit wie beim Quellenverzeichnis.
  if (showBibliography) {
    for (const kind of ['figure', 'table']) {
      const dir = directoryMd(xrefCtx, kind, { lang: xrefCtx.lang, headingLevel: 2 });
      if (dir) out.push(dir, '');
    }
  }
  if (showBibliography) {
    out.push(`## ${_escMd(bib.title)}`, '');
    const body = _htmlToMd(bibliographyItemHtml(bib));
    if (body) out.push(body, '');
  }
  return Buffer.from(out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n', 'utf8');
}

module.exports = { buildMd };
