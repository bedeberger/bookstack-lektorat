'use strict';
// Abbildungs- und Tabellenverzeichnis — ein Verzeichnis der nummerierten Anker
// einer gerenderten Einheit.
//
// QUELLE IST DER XREF-KONTEXT, NICHT DIE DATENBANK. `buildXrefContext`
// (lib/xref-render.js) hat die Nummern schon berechnet — passend zum Scope
// (Buch/Kapitel/Seite) und zur Nummerierungs-Einstellung des Buchs. Ein zweiter
// Zählautomat hier würde genau die Abweichung erzeugen, die das Verzeichnis
// unbrauchbar macht: „Tab. 3.2" im Verzeichnis, „Tab. 3.1" im Text.
//
// OHNE NUMMERN KEIN VERZEICHNIS. Ist die Nummerierung des Typs im Buch
// ausgeschaltet (`book_settings.figure_numbering` / `table_numbering`), setzt
// buildXrefContext alle `number` auf null — dann gibt es nichts aufzulisten, und
// dieses Modul liefert leer. Ein Verzeichnis ohne Nummern wäre eine Liste von
// Beschriftungen ohne Sprungziel.
//
// KEINE SEITENZAHLEN. Dieses Modul bedient die Ausgabewege, die keine haben
// (HTML, Markdown, EPUB — dort ist die „Seite" eine Funktion des Lesegeräts).
// Der Custom-PDF- und der Word-Export brauchen ein anderes Verzeichnis: dort
// gehört die Seitenzahl dazu, und die steht erst fest, wenn der Umbruch gelaufen
// ist (zweiter Pass wie beim Inhaltsverzeichnis, lib/pdf-render/pages.js). Wer
// das nachrüstet, ergänzt dort — nicht hier.

const { escXml } = require('./export-builders/shared');

const TITLES = {
  de: { figure: 'Abbildungsverzeichnis', table: 'Tabellenverzeichnis' },
  en: { figure: 'List of Figures', table: 'List of Tables' },
};

const WORDS = {
  de: { figure: 'Abb.', table: 'Tab.' },
  en: { figure: 'Fig.', table: 'Tab.' },
};

/** Einträge eines Anker-Typs aus dem Xref-Kontext, in Leserichtung.
 *
 *  `ctx` ist das Ergebnis von lib/xref-render.js#buildXrefContext. Die Map ist
 *  in Einfüge-Reihenfolge gefüllt (Leserichtung) — Map bewahrt sie, darum ist
 *  hier keine Sortierung nötig und auch keine möglich: „3.10" nach „3.9" wäre
 *  lexikografisch falsch.
 *
 *  @returns {Array<{number:string, title:string, label:string}>}
 */
function directoryEntries(ctx, kind, { lang = 'de' } = {}) {
  const map = ctx && ctx[kind];
  if (!map) return [];
  const word = (WORDS[lang] || WORDS.de)[kind] || '';
  const out = [];
  const iter = map instanceof Map ? map.entries() : Object.entries(map);
  for (const [, v] of iter) {
    if (!v || !v.number) continue;
    out.push({
      number: String(v.number),
      title: String(v.title || '').trim(),
      label: `${word} ${v.number}`,
    });
  }
  return out;
}

/** Überschrift des Verzeichnisses in der Buchsprache. */
function directoryTitle(kind, lang = 'de') {
  return (TITLES[lang] || TITLES.de)[kind] || '';
}

/** Verzeichnis als HTML-Abschnitt (HTML- und EPUB-Export).
 *  Leer, wenn es nichts zu listen gibt — der Aufrufer muss nicht prüfen. */
function directoryHtml(ctx, kind, { lang = 'de', headingLevel = 2 } = {}) {
  const entries = directoryEntries(ctx, kind, { lang });
  if (!entries.length) return '';
  const h = Math.min(6, Math.max(1, headingLevel));
  const items = entries.map(e => `<p class="anchor-dir__item">`
    + `<span class="anchor-dir__num">${escXml(e.label)}</span>`
    + (e.title ? ` ${escXml(e.title)}` : '')
    + `</p>`).join('\n');
  return `<div class="anchor-dir anchor-dir--${kind}">`
    + `<h${h}>${escXml(directoryTitle(kind, lang))}</h${h}>\n${items}</div>`;
}

/** Verzeichnis als Markdown-Abschnitt. */
function directoryMd(ctx, kind, { lang = 'de', headingLevel = 2 } = {}) {
  const entries = directoryEntries(ctx, kind, { lang });
  if (!entries.length) return '';
  const h = '#'.repeat(Math.min(6, Math.max(1, headingLevel)));
  const lines = entries.map(e => `- **${e.label}** ${e.title}`.trimEnd());
  return `${h} ${directoryTitle(kind, lang)}\n\n${lines.join('\n')}\n`;
}

/** Verzeichnis als Klartext-Zeilen (Plaintext-Export). */
function directoryLines(ctx, kind, { lang = 'de' } = {}) {
  const entries = directoryEntries(ctx, kind, { lang });
  if (!entries.length) return [];
  return [directoryTitle(kind, lang), '', ...entries.map(e => `${e.label} ${e.title}`.trimEnd())];
}

module.exports = { directoryEntries, directoryTitle, directoryHtml, directoryMd, directoryLines };
