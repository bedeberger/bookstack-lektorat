'use strict';
// OPF-Paketdokument: Buchhandels-Metadaten (ISBN/Schlagwoerter/Reihe/Mitwirkende),
// Barrierefreiheits-Discovery und die Patches am Lib-eigenen EPUB3-Template.

// Lib-eigenes EPUB3-OPF-Template zur Laufzeit ziehen (statt kopieren) — bleibt
// driftfest bei Lib-Updates. Wir injizieren nur zusaetzliche dc:subject/Reihen-
// Metadaten vor </metadata>; die ejs-Platzhalter der Lib bleiben unberuehrt.
const EPUB3_OPF_TEMPLATE = require('epub-gen-memory/dist/lib/templates/epub3/content.opf.ejs').default;
// Provenienz-Stempel fuer den OPF-generator-Tag (womit das EPUB erzeugt wurde).
// Das "wann" traegt bereits das Lib-gepflegte dcterms:modified (EPUB3-Pflichtfeld,
// Build-Zeitstempel) — hier ueberschreiben wir nur den App-Identitaets-Teil.
const APP_GENERATOR = `Schreibwerkstatt ${require('../../version').getVersion()}`;
const { escXml } = require('../shared');

// Buchhandels-Metadaten, die epub-gen-memory nicht nativ als Option kennt, als
// OPF-Metadata-Zeilen: Schlagwoerter → dc:subject (eins pro Term), Reihe →
// EPUB3-Collection + calibre-Legacy-Meta (von Calibre/vielen Readern gelesen).
function _buildOpfExtraMeta(meta) {
  const parts = [];
  // ISBN als zusaetzlicher dc:identifier (urn:isbn:) — der Buchhandel/Distributoren
  // (Tolino, Apple Books, ONIX) erkennen das Buch darueber. Der Package-eigene
  // unique-identifier bleibt die UUID; ISBN tritt als weiterer Identifier hinzu.
  // onix:codelist5 15 = ISBN-13, 02 = ISBN-10. Bindestriche/Spaces gestrippt.
  const isbn = String(meta?.isbn || '').replace(/[\s-]/g, '').trim();
  if (isbn) {
    const code = /^\d{13}$/.test(isbn) ? '15' : /^\d{9}[\dxX]$/.test(isbn) ? '02' : null;
    parts.push(`<dc:identifier id="isbn">urn:isbn:${escXml(isbn)}</dc:identifier>`);
    if (code) parts.push(`<meta refines="#isbn" property="identifier-type" scheme="onix:codelist5">${code}</meta>`);
  }
  const kw = String(meta?.keywords || '').split(',').map(s => s.trim()).filter(Boolean);
  for (const k of kw) parts.push(`<dc:subject>${escXml(k)}</dc:subject>`);
  const series = String(meta?.series || '').trim();
  if (series) {
    const idx = String(meta?.series_index || '').trim();
    parts.push(`<meta property="belongs-to-collection" id="series-collection">${escXml(series)}</meta>`);
    parts.push('<meta refines="#series-collection" property="collection-type">series</meta>');
    if (idx) parts.push(`<meta refines="#series-collection" property="group-position">${escXml(idx)}</meta>`);
    parts.push(`<meta name="calibre:series" content="${escXml(series)}"/>`);
    if (idx) parts.push(`<meta name="calibre:series_index" content="${escXml(idx)}"/>`);
  }
  const rights = String(meta?.epub_rights || '').trim();
  if (rights) parts.push(`<dc:rights>${escXml(rights)}</dc:rights>`);
  // Mitwirkende → dc:contributor + MARC-Relator-Rolle (trl/ill/edt). id refines
  // koppelt Rolle an den Eintrag (EPUB3).
  const contributors = [
    ['translator', 'trl', meta?.epub_translator],
    ['illustrator', 'ill', meta?.epub_illustrator],
    ['editor', 'edt', meta?.epub_editor_name],
  ];
  contributors.forEach(([key, role, raw]) => {
    const name = String(raw || '').trim();
    if (!name) return;
    parts.push(`<dc:contributor id="contrib-${key}">${escXml(name)}</dc:contributor>`);
    parts.push(`<meta refines="#contrib-${key}" property="role" scheme="marc:relators">${role}</meta>`);
  });
  // Hauptautor: MARC-Relator aut auf das Lib-#creator (file-as setzt
  // _buildContentOPF direkt im Template). Co-Autoren (Schreib-Duos) als
  // zusaetzliche dc:creator je eigener Identifier + Rolle aut + optional file-as.
  parts.push('<meta refines="#creator" property="role" scheme="marc:relators">aut</meta>');
  const coAuthors = Array.isArray(meta?.co_authors) ? meta.co_authors : [];
  coAuthors.forEach((c, i) => {
    const name = String(c?.name || '').trim();
    if (!name) return;
    const cid = `creator-co${i + 1}`;
    parts.push(`<dc:creator id="${cid}">${escXml(name)}</dc:creator>`);
    parts.push(`<meta refines="#${cid}" property="role" scheme="marc:relators">aut</meta>`);
    const fa = String(c?.file_as || '').trim();
    if (fa) parts.push(`<meta refines="#${cid}" property="file-as">${escXml(fa)}</meta>`);
  });
  return parts.join('\n        ');
}

// Barrierefreiheits-Metadaten (EPUB Accessibility 1.1 / schema.org). Pflicht-
// Discovery-Metadaten fuer den EU-Vertrieb (European Accessibility Act, seit
// 06/2025). Auto-generiert aus dem Inhalt: reflowierbarer Text mit struktureller
// Navigation + Inhaltsverzeichnis. accessMode `visual` nur, wenn Bilder vorhanden.
// Die conformsTo-Aussage ist eine Selbsteinschaetzung des sauber strukturierten
// Outputs; epubcheck validiert die strukturelle Konformitaet separat.
function _buildAccessibilityMeta({ hasImages, lang }) {
  const parts = [];
  parts.push('<meta property="schema:accessMode">textual</meta>');
  if (hasImages) parts.push('<meta property="schema:accessMode">visual</meta>');
  parts.push('<meta property="schema:accessModeSufficient">textual</meta>');
  parts.push('<meta property="schema:accessibilityFeature">tableOfContents</meta>');
  parts.push('<meta property="schema:accessibilityFeature">readingOrder</meta>');
  parts.push('<meta property="schema:accessibilityFeature">structuralNavigation</meta>');
  parts.push('<meta property="schema:accessibilityHazard">none</meta>');
  const summary = String(lang || '').startsWith('en')
    ? 'Reflowable text with structural navigation and a table of contents.'
    : 'Reflowierbarer Text mit struktureller Navigation und Inhaltsverzeichnis.';
  parts.push(`<meta property="schema:accessibilitySummary">${escXml(summary)}</meta>`);
  parts.push('<link rel="dcterms:conformsTo" href="http://www.idpf.org/epub/a11y/accessibility-20170105.html#wcag-aa"/>');
  return parts.join('\n        ');
}

// Custom-OPF immer bauen: der Lib-Default weist `epub-gen` als generator aus —
// wir ersetzen den Tag durch die App-Identitaet (Provenienz-Nachweis: womit
// erzeugt). Optionale Provenienz-Details: die Instanz-Domain wandert in den
// generator-Content (wo erzeugt), der exportierende User in ein eigenes
// generated-by-Meta (wer erzeugt). Das "wann" traegt das Lib-gepflegte
// dcterms:modified. Buchhandels-Extra-Metadaten werden zusaetzlich vor
// </metadata> injiziert (ejs-Platzhalter der Lib bleiben unberuehrt).
function _buildContentOPF(meta, provenance = {}, a11y = {}) {
  const instanceUrl = String(provenance.instanceUrl || '').trim();
  const exportedBy = String(provenance.exportedBy || '').trim();
  const genContent = instanceUrl ? `${APP_GENERATOR} (${instanceUrl})` : APP_GENERATOR;
  const genLines = [`<meta name="generator" content="${escXml(genContent)}" />`];
  if (exportedBy) genLines.push(`<meta name="generated-by" content="${escXml(exportedBy)}" />`);
  let opf = EPUB3_OPF_TEMPLATE.replace(
    '<meta name="generator" content="epub-gen" />',
    genLines.join('\n        '),
  );
  // EPUB3-konforme Cover-Kennzeichnung: properties="cover-image" am Bild-Item
  // (epub-gen-memory emittiert nur das Legacy-<meta name="cover">). Reader, die
  // EPUB3 bevorzugen, erkennen das Cover-Thumbnail dadurch zuverlaessig.
  opf = opf.replace(
    '<item id="image_cover" href="cover.<%= cover.extension %>" media-type="<%= cover.mediaType %>" />',
    '<item id="image_cover" href="cover.<%= cover.extension %>" media-type="<%= cover.mediaType %>" properties="cover-image" />',
  );
  // Legacy-Guide-Referenz auf die Cover-Seite (EPUB2-Reader-Kompat).
  opf = opf.replace(
    '<reference type="text" title="Table of Content" href="toc.xhtml"/>',
    '<% if(cover) { %><reference type="cover" title="Cover" href="front_cover.xhtml"/>\n        <% } %><reference type="text" title="Table of Content" href="toc.xhtml"/>',
  );
  // Leerer Verlag: das Lib-Template rendert sonst leere
  // <meta property="dcterms:publisher"/> + <dc:publisher/> (EPUBCheck RSC-005,
  // "character content … length at least 1"). Zeilen entfernen statt leer
  // emittieren; die Copyright-Default-Zeile verliert ihren "by …"-Zusatz.
  if (!String(meta?.publisher || '').trim()) {
    opf = opf
      .replace(/[ \t]*<meta property="dcterms:publisher"><%= publisher %><\/meta>\n/, '')
      .replace(/[ \t]*<dc:publisher><%= publisher %><\/dc:publisher>\n/, '')
      .replace(/ by <%= publisher %>/, '');
  }
  // Sortiername des Hauptautors (file-as, z.B. "Beispiel, Anna"): das Lib-Template
  // setzt file-as = Anzeigename → Katalog-/Reader-Bibliotheken sortieren unter dem
  // Vornamen. Ist author_file_as gesetzt, den file-as-Wert im Template ersetzen
  // (regex-robust gegen den ejs-Platzhalter dazwischen).
  const fileAs = String(meta?.author_file_as || '').trim();
  if (fileAs) {
    opf = opf.replace(
      /(<meta refines="#creator" property="file-as">)[\s\S]*?(<\/meta>)/,
      `$1${escXml(fileAs)}$2`,
    );
  }
  const injected = [_buildOpfExtraMeta(meta), _buildAccessibilityMeta(a11y)].filter(Boolean).join('\n        ');
  if (injected) opf = opf.replace('</metadata>', `        ${injected}\n    </metadata>`);
  return opf;
}

module.exports = { _buildOpfExtraMeta, _buildAccessibilityMeta, _buildContentOPF };
