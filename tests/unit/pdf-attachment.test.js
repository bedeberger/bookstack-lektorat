'use strict';
// Geteilter PDF-Anhang-Stack (lib/pdf-attachment.js). Zwei Oberflaechen haengen
// ein PDF an einen Datensatz — Quelle und Recherche-Fundstueck. Getestet wird
// hier das Mechanische, das beide teilen: Namens-Bereinigung, Fehler-Mapping
// (ein pauschales 400 kann „passwortgeschuetzt" nicht von „kein PDF" trennen),
// Inhalts-Hash (Basis des Re-Upload-Kurzschlusses) und die Auslieferungs-Header.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  cleanDocName, docHash, readDocUpload, sendDoc,
  DOCNAME_MAX, DOCNAME_FALLBACK, RAW_BODY_LIMIT, MAX_INPUT_BYTES,
} = require('../../lib/pdf-attachment');

test('cleanDocName: trimmt, deckelt und faellt auf einen Namen zurueck', () => {
  assert.equal(cleanDocName('  Habermas.pdf '), 'Habermas.pdf');
  assert.equal(cleanDocName(''), DOCNAME_FALLBACK);
  assert.equal(cleanDocName(null), DOCNAME_FALLBACK);
  assert.equal(cleanDocName('x'.repeat(500)).length, DOCNAME_MAX);
  // Zeilenumbrueche wuerden den Content-Disposition-Header aufbrechen.
  assert.equal(cleanDocName('a\r\nb.pdf'), 'a b.pdf');
});

test('RAW_BODY_LIMIT leitet sich aus dem SSoT-Limit ab', () => {
  assert.equal(RAW_BODY_LIMIT, `${Math.floor(MAX_INPUT_BYTES / (1024 * 1024))}mb`);
});

test('docHash ist deterministisch und unterscheidet Inhalte', () => {
  const a = Buffer.from('%PDF-1.4 alpha');
  const b = Buffer.from('%PDF-1.4 beta');
  assert.equal(docHash(a), docHash(Buffer.from('%PDF-1.4 alpha')));
  assert.notEqual(docHash(a), docHash(b));
  assert.match(docHash(a), /^[0-9a-f]{16}$/);
});

test('readDocUpload: leerer Body → NO_DOC, kein Wurf', async () => {
  for (const body of [null, undefined, Buffer.alloc(0), 'kein buffer']) {
    const r = await readDocUpload(body, 'x.pdf');
    assert.equal(r.ok, false);
    assert.equal(r.error_code, 'NO_DOC');
    assert.equal(r.status, 400);
  }
});

test('readDocUpload: Nicht-PDF wird als solches gemeldet, nicht als „kaputt"', async () => {
  const r = await readDocUpload(Buffer.from('GIF89a und dann Muell'), 'bild.gif');
  assert.equal(r.ok, false);
  assert.equal(r.error_code, 'DOC_NOT_PDF');
  assert.equal(r.status, 415);
});

test('readDocUpload: zu grosser Body bekommt 413, nicht 400', async () => {
  // Magic-Bytes stimmen, nur die Groesse nicht — sonst greift der Format-Check zuerst.
  const big = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(MAX_INPUT_BYTES + 1)]);
  const r = await readDocUpload(big, 'gross.pdf');
  assert.equal(r.ok, false);
  assert.equal(r.error_code, 'DOC_TOO_LARGE');
  assert.equal(r.status, 413);
});

test('readDocUpload: unlesbares PDF bleibt DOC_UNREADABLE (kein Wurf nach oben)', async () => {
  // Gueltige Magic-Bytes, danach Schrott → der Parser scheitert.
  const r = await readDocUpload(Buffer.from('%PDF-1.7\nnicht wirklich ein PDF'), 'kaputt.pdf');
  assert.equal(r.ok, false);
  assert.equal(r.error_code, 'DOC_UNREADABLE');
  assert.equal(r.status, 400);
});

test('sendDoc bindet den Content-Type (nosniff) und setzt den Dateinamen', () => {
  const headers = {};
  let sent = null;
  const res = { set: (k, v) => { headers[k] = v; }, send: (b) => { sent = b; } };
  const buf = Buffer.from('%PDF-1.4');
  sendDoc(res, { buffer: buf, mime: 'application/pdf', name: 'Müller (2020).pdf' });

  assert.equal(sent, buf);
  assert.equal(headers['Content-Type'], 'application/pdf');
  // Ohne nosniff darf der Browser fremdes Upload-Material umdeuten.
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.match(headers['Content-Disposition'], /^inline; filename\*=UTF-8''/);
  assert.ok(headers['Content-Disposition'].includes(encodeURIComponent('Müller (2020).pdf')));
  assert.equal(headers['Cache-Control'], 'private, max-age=3600');
});

test('sendDoc faellt auf application/pdf zurueck, wenn kein MIME gespeichert ist', () => {
  const headers = {};
  const res = { set: (k, v) => { headers[k] = v; }, send: () => {} };
  sendDoc(res, { buffer: Buffer.from('x'), mime: null, name: null });
  assert.equal(headers['Content-Type'], 'application/pdf');
  assert.ok(headers['Content-Disposition'].includes('dokument.pdf'));
});
