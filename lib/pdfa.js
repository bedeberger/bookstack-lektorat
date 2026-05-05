'use strict';
// PDF/A-2B-Postprocess für pdfkit-Dokumente. Wird VOR doc.end() aufgerufen.
// Hängt drei Dinge an:
//   1. XMP-Metadata-Stream (mit pdfaid:part=2 / conformance=B)
//   2. OutputIntent-Array mit eingebettetem sRGB-ICC-Profil
//   3. Catalog-/Document-Info-Felder, die XMP referenzieren
//
// Voraussetzungen, die der Renderer erfüllen muss:
//   - pdfkit-Doc mit `pdfVersion: '1.7'` und `tagged: true`
//   - alle Fonts subset-embedded (TTF + ToUnicode CMap; pdfkit macht das
//     automatisch bei `registerFont(name, ttfBuffer)`)
//   - keine Transparenz auf Pixeln (Alpha-Channels werden in cover-prepare
//     bereits gestripped)
//   - keine Verschlüsselung (pdfkit verschlüsselt nicht per Default)

const fs = require('fs');
const path = require('path');
const { create } = require('xmlbuilder2');

const ICC_PATH = path.join(__dirname, '..', 'assets', 'icc', 'sRGB-v2-micro.icc');
let _iccBuffer = null;
function _icc() {
  if (!_iccBuffer) _iccBuffer = fs.readFileSync(ICC_PATH);
  return _iccBuffer;
}

function _xmpEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _buildXmp({ title, author, lang, producer, creator, conformance = 'B' }) {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const xml = create({ version: '1.0', encoding: 'UTF-8' })
    .ele('x:xmpmeta', { 'xmlns:x': 'adobe:ns:meta/' })
      .ele('rdf:RDF', { 'xmlns:rdf': 'http://www.w3.org/1999/02/22-rdf-syntax-ns#' })
        .ele('rdf:Description', {
          'rdf:about': '',
          'xmlns:dc': 'http://purl.org/dc/elements/1.1/',
          'xmlns:xmp': 'http://ns.adobe.com/xap/1.0/',
          'xmlns:pdf': 'http://ns.adobe.com/pdf/1.3/',
          'xmlns:pdfaid': 'http://www.aiim.org/pdfa/ns/id/',
        })
          .ele('dc:title').ele('rdf:Alt').ele('rdf:li', { 'xml:lang': lang || 'x-default' }).txt(_xmpEscape(title || '')).up().up().up()
          .ele('dc:creator').ele('rdf:Seq').ele('rdf:li').txt(_xmpEscape(author || '')).up().up().up()
          .ele('dc:format').txt('application/pdf').up()
          .ele('xmp:CreateDate').txt(now).up()
          .ele('xmp:ModifyDate').txt(now).up()
          .ele('xmp:CreatorTool').txt(_xmpEscape(creator || 'bookstack-lektorat')).up()
          .ele('pdf:Producer').txt(_xmpEscape(producer || 'pdfkit')).up()
          .ele('pdfaid:part').txt('2').up()
          .ele('pdfaid:conformance').txt(conformance).up()
        .up()
      .up()
    .up()
    .end({ prettyPrint: false, headless: false });
  return xml;
}

/**
 * Hängt PDF/A-Metadaten + OutputIntent in das pdfkit-Doc, kurz vor end().
 *
 * @param {PDFDocument} doc  - pdfkit-Doc
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.author
 * @param {string} [opts.lang='de']
 * @param {string} [opts.creator='bookstack-lektorat']
 * @param {string} [opts.producer='pdfkit']
 * @param {string} [opts.conformance='B']
 */
function applyPdfaMetadata(doc, opts) {
  const xmp = _buildXmp({ ...opts, conformance: opts.conformance || 'B' });
  // 1. XMP als Metadata-Stream — Subtype /XML
  const xmpRef = doc.ref({ Type: 'Metadata', Subtype: 'XML', Length: Buffer.byteLength(xmp, 'utf8') });
  // PDF/A-Stream-Anforderung: kein FlateDecode. pdfkit komprimiert per Default;
  // wir umgehen das, indem wir direkt schreiben.
  xmpRef.compress = false;
  xmpRef.write(Buffer.from(xmp, 'utf8'));
  xmpRef.end();
  doc._root.data.Metadata = xmpRef;

  // 2. ICC-Profile-Stream
  const iccBuf = _icc();
  const iccRef = doc.ref({ N: 3, Length: iccBuf.length });
  iccRef.compress = false;
  iccRef.write(iccBuf);
  iccRef.end();

  // 3. OutputIntent-Dictionary
  const outputIntentRef = doc.ref({
    Type: 'OutputIntent',
    S: 'GTS_PDFA1',
    OutputConditionIdentifier: 'sRGB IEC61966-2.1',
    Info: 'sRGB IEC61966-2.1',
    DestOutputProfile: iccRef,
  });
  outputIntentRef.end();
  doc._root.data.OutputIntents = [outputIntentRef];

  // 4. Catalog: ViewerPreferences/DisplayDocTitle. MarkInfo wird von pdfkit
  //    selbst als ref erstellt (tagged: true ist gesetzt) — wir überschreiben
  //    es nicht, sonst bricht endMarkings.
  if (!doc._root.data.ViewerPreferences) doc._root.data.ViewerPreferences = {};
  doc._root.data.ViewerPreferences.DisplayDocTitle = true;

  // 5. Document-Info-Dictionary an XMP-Werte angleichen.
  if (doc._info && doc._info.data) {
    if (opts.title  !== undefined) doc._info.data.Title  = String(opts.title  || '');
    if (opts.author !== undefined) doc._info.data.Author = String(opts.author || '');
    doc._info.data.Producer = opts.producer || 'pdfkit';
    doc._info.data.Creator  = opts.creator  || 'bookstack-lektorat';
  }
}

module.exports = { applyPdfaMetadata };
