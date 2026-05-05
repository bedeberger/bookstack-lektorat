'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

// Eigene Test-DB pro Lauf, sonst kollidiert das Test-Statement-Cache mit
// anderen Test-Suites, die parallel laufen (--test-concurrency=4).
const tmp = path.join('/tmp', `pdfx-db-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmp;

const schema = require('../../db/schema');

test('CRUD-Cycle für pdf_export_profile', () => {
  const userA = 'a@x.test';
  const userB = 'b@x.test';

  // Mig 81: pdf_export_profile.book_id FK -> books(bookstack_book_id).
  // Test-Buch im books-Cache anlegen.
  schema.upsertBookByName(42, 'Test-Buch 42');

  const p1 = schema.createPdfExportProfile(42, userA, 'A4 Print', { layout: { pageSize: 'A4' } });
  assert.ok(p1.id);
  assert.equal(p1.is_default, false);
  assert.equal(p1.has_cover, false);

  const p2 = schema.createPdfExportProfile(42, userA, 'A5 Pocket', { layout: { pageSize: 'A5' } });
  const list = schema.listPdfExportProfiles(42, userA);
  assert.equal(list.length, 2);
  assert.equal(list[0].name, 'A4 Print');     // alphabetisch nach is_default DESC

  // User B sieht NICHT die Profile von User A.
  assert.equal(schema.listPdfExportProfiles(42, userB).length, 0);

  // setDefault macht genau eines zum Default.
  schema.setPdfExportProfileDefault(42, userA, p2.id);
  const after = schema.listPdfExportProfiles(42, userA);
  const defs = after.filter(p => p.is_default);
  assert.equal(defs.length, 1);
  assert.equal(defs[0].id, p2.id);

  // Cover setzen + lesen + löschen
  const buf = Buffer.from('FAKEJPEG');
  schema.setPdfExportProfileCover(p1.id, buf, 'image/jpeg');
  const cover = schema.getPdfExportProfileCover(p1.id);
  assert.ok(cover);
  assert.equal(cover.mime, 'image/jpeg');
  assert.equal(cover.image.toString(), 'FAKEJPEG');

  schema.clearPdfExportProfileCover(p1.id);
  assert.equal(schema.getPdfExportProfileCover(p1.id), null);

  // Update + Delete
  schema.updatePdfExportProfile(p1.id, 'A4 Final', { layout: { pageSize: 'A4', columns: 2 } });
  const updated = schema.getPdfExportProfile(p1.id);
  assert.equal(updated.name, 'A4 Final');
  assert.equal(updated.config.layout.columns, 2);

  schema.deletePdfExportProfile(p1.id);
  assert.equal(schema.getPdfExportProfile(p1.id), null);
});

test('Font-Cache schreibt Buffer und liefert Frische-Indikator', () => {
  schema.cacheFont('Lora', 400, 'normal', Buffer.from([0,1,0,0]));
  const hit = schema.getCachedFont('Lora', 400, 'normal');
  assert.ok(hit);
  assert.equal(hit.stale, false);
  assert.equal(hit.ttf[0], 0);
  assert.equal(hit.ttf[1], 1);
});

test('Font-Cache miss liefert null', () => {
  const miss = schema.getCachedFont('Nichts', 999, 'normal');
  assert.equal(miss, null);
});

test.after(() => {
  try { fs.unlinkSync(tmp); } catch {}
  try { fs.unlinkSync(tmp + '-journal'); } catch {}
  try { fs.unlinkSync(tmp + '-wal'); } catch {}
  try { fs.unlinkSync(tmp + '-shm'); } catch {}
});
