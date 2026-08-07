// Titel-Werkstatt: Drift-Gate über Felder und Kanäle + Verhalten von
// Speicherung, Varianten und Übernahme.
//
// SSoT der Felder ist public/js/headline/channels.js. Drei Schichten führen
// eigene Kopien:
//   1. db/headline.js#HEADLINE_FIELDS (CJS-Spiegel, Schreibpfad-Validierung)
//   2. der CHECK-Constraint von `page_headline_variants.feld` (Migration 269)
//   3. die Spalten von `page_headline` — ein Feld OHNE Spalte liesse sich
//      speichern und wäre beim nächsten Lesen weg
// dazu die Labels in public/js/i18n/{de,en}.json.
//
// Die Zeichenlimits haben bewusst KEINEN Spiegel: sie sind Anzeige, nicht
// Validierung. Ein Test, der sie serverseitig einfordert, würde genau das
// Gegenteil zementieren.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const require = createRequire(import.meta.url);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-headline-'));
process.env.DB_PATH = path.join(TMP, 'test.db');

const ch = await import(pathToFileURL(path.join(ROOT, 'public/js/headline/channels.js')).href);
const {
  HEADLINE_FIELDS, HEADLINE_LONG_FIELDS, HEADLINE_CHANNELS,
  channelsForField, tightestLimit, channelFit, fieldLabelKey, channelLabelKey,
} = ch;

// ── Drift ────────────────────────────────────────────────────────────────────

test('Feld-Katalog ist eindeutig, Langfelder sind eine Teilmenge davon', () => {
  assert.equal(HEADLINE_FIELDS.length, new Set(HEADLINE_FIELDS).size);
  for (const f of HEADLINE_LONG_FIELDS) {
    assert.ok(HEADLINE_FIELDS.includes(f), `${f} ist kein bekanntes Feld`);
  }
});

test('jeder Kanal hat mindestens ein Limit, und jedes Limit gilt einem echten Feld', () => {
  const keys = HEADLINE_CHANNELS.map(c => c.key);
  assert.equal(keys.length, new Set(keys).size, 'Duplikate im Kanal-Katalog');
  for (const c of HEADLINE_CHANNELS) {
    const felder = Object.keys(c.limits);
    assert.ok(felder.length, `${c.key}: Kanal ohne Limit ist sinnlos`);
    for (const f of felder) {
      assert.ok(HEADLINE_FIELDS.includes(f), `${c.key}: Limit für unbekanntes Feld ${f}`);
      assert.ok(Number.isInteger(c.limits[f]) && c.limits[f] > 0, `${c.key}.${f}: kein positives Limit`);
    }
  }
  // Der Titel ist das Feld, um das es geht — ohne Limit dort wäre das Lineal leer.
  assert.ok(channelsForField('titel').length >= 2);
});

test('db/headline.js spiegelt den Feld-Katalog und validiert danach', () => {
  const cjs = require(path.join(ROOT, 'db/headline.js'));
  assert.deepEqual(cjs.HEADLINE_FIELDS, HEADLINE_FIELDS, 'CJS-Spiegel weicht ab');
  for (const f of HEADLINE_FIELDS) assert.ok(cjs.isValidHeadlineField(f), f);
  for (const f of ['', 'untertitel', null, 7]) assert.ok(!cjs.isValidHeadlineField(f), String(f));
});

test('jedes Feld hat eine eigene Spalte und steht im CHECK der Varianten', () => {
  const { db } = require(path.join(ROOT, 'db/connection.js'));
  require(path.join(ROOT, 'db/migrations.js'));
  const cols = db.pragma('table_info(page_headline)').map(c => c.name);
  for (const f of HEADLINE_FIELDS) {
    assert.ok(cols.includes(f), `page_headline.${f} fehlt — Feld ohne Spalte ist beim Lesen weg`);
  }
  const sql = db.prepare(
    "SELECT sql FROM sqlite_master WHERE name = 'page_headline_variants'",
  ).get()?.sql;
  assert.ok(sql, 'Tabelle page_headline_variants fehlt — Migration 269 nicht gelaufen?');
  const inList = sql.match(/feld\s+IN\s*\(([^)]+)\)/i);
  assert.ok(inList, 'CHECK-Constraint auf feld nicht gefunden');
  const werte = inList[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
  assert.deepEqual(werte, HEADLINE_FIELDS, 'CHECK-Constraint weicht vom Katalog ab');
});

test('Felder und Kanäle haben Labels in beiden Locales', () => {
  for (const locale of ['de', 'en']) {
    const i18n = JSON.parse(fs.readFileSync(path.join(ROOT, `public/js/i18n/${locale}.json`), 'utf8'));
    for (const f of HEADLINE_FIELDS) {
      assert.ok(i18n[fieldLabelKey(f)], `${locale}: ${fieldLabelKey(f)} fehlt`);
      assert.ok(i18n[`headline.placeholder.${f}`], `${locale}: Platzhalter für ${f} fehlt`);
    }
    for (const c of HEADLINE_CHANNELS) {
      assert.ok(i18n[channelLabelKey(c.key)], `${locale}: ${channelLabelKey(c.key)} fehlt`);
    }
    for (const h of ['user', 'ki']) {
      assert.ok(i18n[`headline.origin.${h}`], `${locale}: headline.origin.${h} fehlt`);
    }
  }
});

test('beide Spalten mit Konto-Bezug stehen im Konto-Löschplan', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib/account-delete.js'), 'utf8');
  assert.match(src, /page_headline'?,?\s*column:\s*'updated_by'/);
  assert.match(src, /page_headline_variants'?,?\s*column:\s*'created_by'/);
});

// ── Kanal-Lineal (pure) ──────────────────────────────────────────────────────

test('channelFit meldet je Kanal, um wie viel zu kürzen ist', () => {
  const limit = HEADLINE_CHANNELS.find(c => c.key === 'print').limits.titel;
  const knapp = 'x'.repeat(limit);
  for (const f of channelFit('titel', knapp)) {
    if (f.key === 'print') { assert.ok(f.fits, 'genau auf dem Limit passt noch'); assert.equal(f.over, 0); }
  }
  const zulang = 'x'.repeat(limit + 7);
  const print = channelFit('titel', zulang).find(f => f.key === 'print');
  assert.equal(print.fits, false);
  // „7 zu viel" ist die Angabe, mit der man kürzt — „passt nicht" ist es nicht.
  assert.equal(print.over, 7);
});

test('gezählt wird der getrimmte Text, nicht das Eingabefeld', () => {
  const a = channelFit('titel', '  Hallo  ')[0];
  assert.equal(a.len, 5);
});

test('ein Feld ohne Limit in einem Kanal taucht dort nicht auf', () => {
  // Eine Dachzeile hat in der Suchergebnis-Vorschau keinen Platz — kein Limit
  // heisst „gilt nicht", nicht „unbegrenzt".
  const keys = channelFit('dachzeile', 'x').map(f => f.key);
  assert.ok(!keys.includes('seo'));
  assert.equal(tightestLimit('dachzeile'), Math.min(
    ...HEADLINE_CHANNELS.filter(c => c.limits.dachzeile).map(c => c.limits.dachzeile),
  ));
});

// ── Verhalten ────────────────────────────────────────────────────────────────

const { db } = require(path.join(ROOT, 'db/connection.js'));
require(path.join(ROOT, 'db/migrations.js'));
const {
  getHeadline, listBookHeadlines, setHeadline,
  listVariants, addVariant, deleteVariant, promoteVariant, MAX_LEN,
} = require(path.join(ROOT, 'db/headline.js'));

db.prepare('INSERT OR IGNORE INTO app_users (email, display_name) VALUES (?, ?)')
  .run('a@b.ch', 'Testredaktion');

function seed() {
  const T = '2026-01-01T10:00:00.000Z';
  db.prepare('INSERT INTO books (name, created_at, updated_at) VALUES (?, ?, ?)').run('Ressort', T, T);
  const bookId = db.prepare('SELECT MAX(book_id) AS id FROM books').get().id;
  db.prepare('INSERT INTO pages (book_id, page_name, updated_at) VALUES (?, ?, ?)')
    .run(bookId, 'Beitrag', T);
  const pageId = db.prepare('SELECT MAX(page_id) AS id FROM pages').get().id;
  return { bookId, pageId };
}

test('nur übergebene Felder werden geschrieben, fehlende bleiben stehen', () => {
  const { bookId, pageId } = seed();
  setHeadline(pageId, bookId, { titel: 'Erste Zeile', dachzeile: 'Verkehr' }, 'a@b.ch');
  // Ein Teil-PUT darf die anderen Felder nicht leeren — sonst löscht eine alte
  // Tab-Sitzung, was inzwischen woanders gesetzt wurde.
  setHeadline(pageId, bookId, { lead: 'Der Vorspann.' }, 'a@b.ch');
  const h = getHeadline(pageId);
  assert.equal(h.titel, 'Erste Zeile');
  assert.equal(h.dachzeile, 'Verkehr');
  assert.equal(h.lead, 'Der Vorspann.');
});

test('ausdrücklich leeres Feld löscht, alle vier leer löschen die Zeile', () => {
  const { bookId, pageId } = seed();
  setHeadline(pageId, bookId, { titel: 'Weg damit' }, 'a@b.ch');
  setHeadline(pageId, bookId, { titel: '' }, 'a@b.ch');
  // Ohne diesen Abräumer zählt „wie viele Beiträge haben einen Titel" falsch.
  assert.equal(getHeadline(pageId), null);
});

test('Eingaben werden normalisiert und gedeckelt', () => {
  const { bookId, pageId } = seed();
  const h = setHeadline(pageId, bookId, { titel: '  Zwei   Wörter\nmit Umbruch  ' }, 'a@b.ch');
  // Ein harter Umbruch aus einem Paste wäre in jeder Ausspielung etwas anderes.
  assert.equal(h.titel, 'Zwei Wörter mit Umbruch');
  const lang = setHeadline(pageId, bookId, { titel: 'x'.repeat(MAX_LEN.titel + 50) }, 'a@b.ch');
  assert.equal(lang.titel.length, MAX_LEN.titel);
});

test('Varianten: anlegen, wortgleiche Doppel zusammenfassen, löschen', () => {
  const { bookId, pageId } = seed();
  const v1 = addVariant(pageId, bookId, { feld: 'titel', text: 'Ein Vorschlag', herkunft: 'ki' });
  assert.ok(v1.id);
  // Ein zweiter KI-Lauf schlägt regelmässig dieselbe naheliegende Zeile vor.
  const v2 = addVariant(pageId, bookId, { feld: 'titel', text: 'Ein Vorschlag', herkunft: 'ki' });
  assert.equal(v2.id, v1.id, 'wortgleiches Doppel darf keine zweite Zeile anlegen');
  assert.equal(listVariants(pageId).titel.length, 1);

  assert.equal(addVariant(pageId, bookId, { feld: 'titel', text: '   ' }), null);
  assert.throws(() => addVariant(pageId, bookId, { feld: 'untertitel', text: 'x' }), /INVALID|Ungueltig/i);

  deleteVariant(v1.id);
  assert.equal(listVariants(pageId).titel.length, 0);
});

test('Übernehmen tauscht: die Variante wird geltend, der alte Stand wird gesichert', () => {
  const { bookId, pageId } = seed();
  setHeadline(pageId, bookId, { titel: 'Alter Stand' }, 'a@b.ch');
  const v = addVariant(pageId, bookId, { feld: 'titel', text: 'Neuer Stand', herkunft: 'ki' });

  const h = promoteVariant(v.id, 'a@b.ch');
  assert.equal(h.titel, 'Neuer Stand');
  const texte = listVariants(pageId).titel.map(x => x.text);
  // Beide stehen danach in der Liste — jede Übernahme bleibt umkehrbar, ohne
  // dass es dafür eine eigene Undo-Historie braucht.
  assert.ok(texte.includes('Neuer Stand'), 'übernommene Variante bleibt stehen');
  assert.ok(texte.includes('Alter Stand'), 'bisheriger Stand wurde gesichert');
});

test('Übernehmen ohne bisherigen Stand legt keine leere Variante an', () => {
  const { bookId, pageId } = seed();
  const v = addVariant(pageId, bookId, { feld: 'titel', text: 'Erster Titel', herkunft: 'user' });
  promoteVariant(v.id, 'a@b.ch');
  assert.equal(listVariants(pageId).titel.length, 1);
});

test('Buch-Liste ist buchskopiert', () => {
  const a = seed();
  const b = seed();
  setHeadline(a.pageId, a.bookId, { titel: 'A' }, 'a@b.ch');
  setHeadline(b.pageId, b.bookId, { titel: 'B' }, 'a@b.ch');
  const listA = listBookHeadlines(a.bookId);
  assert.deepEqual(Object.keys(listA), [String(a.pageId)]);
  assert.equal(listA[String(a.pageId)].titel, 'A');
});

test('Löschen der Seite nimmt Titel und Varianten mit (CASCADE)', () => {
  const { bookId, pageId } = seed();
  setHeadline(pageId, bookId, { titel: 'X' }, 'a@b.ch');
  addVariant(pageId, bookId, { feld: 'titel', text: 'Y' });
  db.prepare('DELETE FROM pages WHERE page_id = ?').run(pageId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM page_headline WHERE page_id = ?').get(pageId).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM page_headline_variants WHERE page_id = ?').get(pageId).n, 0);
});

test.after(() => {
  try { db.close(); } catch { /* egal */ }
  fs.rmSync(TMP, { recursive: true, force: true });
});
