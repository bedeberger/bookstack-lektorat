// Redaktions-Status: Drift-Gate über die Stufenkette + Verhalten der Frische-
// Prüfung.
//
// SSoT ist public/js/redaktion/status.js. Drei Schichten führen eigene Kopien,
// weil sie in anderen Modulsystemen leben oder synchron validieren MÜSSEN:
//   1. db/redaktion.js#REDAKTION_STATUS (CJS-Spiegel, Schreibpfad-Validierung)
//   2. der CHECK-Constraint von `page_editorial_status.status` (Migration 268)
//   3. public/js/i18n/{de,en}.json (`redaktion.status.<key>`)
//
// Eine Stufe, die nur in der SSoT landet, wird von der Route mit 400
// INVALID_VALUE abgelehnt bzw. vom CHECK-Constraint geworfen — und erschiene in
// der Organizer-Zeile als leere Plakette.
//
// Eigene DB: der Test schreibt Seiten und Stufen. Ohne `DB_PATH` liefe das gegen
// die Entwicklungs-Datenbank.

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-redaktion-'));
process.env.DB_PATH = path.join(TMP, 'test.db');

const { REDAKTION_STATUS, REDAKTION_STATUS_DONE, statusRank, statusLabelKey } =
  await import(pathToFileURL(path.join(ROOT, 'public/js/redaktion/status.js')).href);

// ── Drift ────────────────────────────────────────────────────────────────────

test('Stufenkette ist geordnet, eindeutig und endet auf der Fertig-Stufe', () => {
  assert.equal(REDAKTION_STATUS.length, new Set(REDAKTION_STATUS).size, 'Duplikate in der Kette');
  assert.ok(REDAKTION_STATUS.length >= 2, 'eine Kette braucht mindestens zwei Stufen');
  // Die Kette ist ein Weg, kein Sack: die Fertig-Stufe steht am Ende, sonst
  // laeuft „weiter als" gegen die Anzeige-Reihenfolge.
  assert.equal(REDAKTION_STATUS.at(-1), REDAKTION_STATUS_DONE);
  for (let i = 1; i < REDAKTION_STATUS.length; i++) {
    assert.ok(statusRank(REDAKTION_STATUS[i]) > statusRank(REDAKTION_STATUS[i - 1]));
  }
  for (const v of [null, undefined, '', 'gibtsnicht']) assert.equal(statusRank(v), -1, String(v));
});

test('db/redaktion.js spiegelt die Kette und validiert danach', () => {
  const cjs = require(path.join(ROOT, 'db/redaktion.js'));
  assert.deepEqual(cjs.REDAKTION_STATUS, REDAKTION_STATUS, 'CJS-Spiegel weicht ab');
  assert.equal(cjs.REDAKTION_STATUS_DONE, REDAKTION_STATUS_DONE);
  for (const k of REDAKTION_STATUS) assert.ok(cjs.isValidRedaktionStatus(k), k);
  for (const k of ['', 'roman', null, 42, 'ROH']) {
    assert.ok(!cjs.isValidRedaktionStatus(k), String(k));
  }
});

test('CHECK-Constraint der Tabelle kennt genau dieselben Stufen', () => {
  const { db } = require(path.join(ROOT, 'db/connection.js'));
  require(path.join(ROOT, 'db/migrations.js'));
  const sql = db.prepare(
    "SELECT sql FROM sqlite_master WHERE name = 'page_editorial_status'",
  ).get()?.sql;
  assert.ok(sql, 'Tabelle page_editorial_status fehlt — Migration 268 nicht gelaufen?');
  const inList = sql.match(/status\s+IN\s*\(([^)]+)\)/i);
  assert.ok(inList, 'CHECK-Constraint auf status nicht gefunden');
  const werte = inList[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
  assert.deepEqual(werte, REDAKTION_STATUS, 'CHECK-Constraint weicht von der Kette ab');
});

test('jede Stufe hat ein Label in beiden Locales, dazu die Rahmen-Keys', () => {
  for (const locale of ['de', 'en']) {
    const i18n = JSON.parse(fs.readFileSync(path.join(ROOT, `public/js/i18n/${locale}.json`), 'utf8'));
    for (const k of REDAKTION_STATUS) {
      assert.ok(i18n[statusLabelKey(k)], `${locale}: ${statusLabelKey(k)} fehlt`);
    }
    for (const k of ['redaktion.status.none', 'redaktion.setStatus', 'redaktion.staleHint',
      'redaktion.saveFailed']) {
      assert.ok(i18n[k], `${locale}: ${k} fehlt`);
    }
  }
});

test('die Spalte mit Konto-Bezug steht im Konto-Löschplan', () => {
  // Ohne den Eintrag bliebe die Adresse nach einer Konto-Selbstloeschung in der
  // Tabelle stehen. Das generische Gate (tests/unit/account-delete.test.js)
  // faengt das erst, wenn die Tabelle in der geprueften DB existiert — hier
  // steht es unabhaengig davon.
  const src = fs.readFileSync(path.join(ROOT, 'lib/account-delete.js'), 'utf8');
  assert.match(src, /page_editorial_status'?,?\s*column:\s*'updated_by'/,
    'page_editorial_status.updated_by fehlt im USER_REF_PLAN');
});

// ── Verhalten ────────────────────────────────────────────────────────────────

const { db } = require(path.join(ROOT, 'db/connection.js'));
require(path.join(ROOT, 'db/migrations.js'));
const {
  setPageStatus, getPageStatus, listBookStatus, statusCounts,
} = require(path.join(ROOT, 'db/redaktion.js'));

const T0 = '2026-01-01T10:00:00.000Z';
const T1 = '2026-01-01T11:00:00.000Z';

// `updated_by` ist ein FK auf app_users(email) — ohne das Konto wirft schon das
// erste Setzen. Genau so soll es sein: eine Stufe traegt eine Person, die es gibt.
db.prepare('INSERT OR IGNORE INTO app_users (email, display_name) VALUES (?, ?)')
  .run('a@b.ch', 'Testredaktion');

function seed() {
  db.prepare('INSERT INTO books (name, created_at, updated_at) VALUES (?, ?, ?)')
    .run('Ressort', T0, T0);
  const bookId = db.prepare('SELECT MAX(book_id) AS id FROM books').get().id;
  const pages = [];
  for (const name of ['Beitrag A', 'Beitrag B', 'Beitrag C']) {
    db.prepare('INSERT INTO pages (book_id, page_name, updated_at) VALUES (?, ?, ?)')
      .run(bookId, name, T0);
    pages.push(db.prepare('SELECT MAX(page_id) AS id FROM pages').get().id);
  }
  return { bookId, pages };
}

test('Stufe setzen, lesen, wieder entfernen', () => {
  const { bookId, pages } = seed();
  const entry = setPageStatus(pages[0], bookId, { status: 'gegengelesen', userEmail: 'a@b.ch' });
  assert.equal(entry.status, 'gegengelesen');
  assert.equal(entry.updated_by, 'a@b.ch');
  assert.equal(entry.stale, false);
  assert.equal(getPageStatus(pages[0]).status, 'gegengelesen');

  // Zweites Setzen ueberschreibt, legt keine zweite Zeile an.
  setPageStatus(pages[0], bookId, { status: 'freigegeben', userEmail: 'a@b.ch' });
  assert.equal(getPageStatus(pages[0]).status, 'freigegeben');

  assert.equal(setPageStatus(pages[0], bookId, { status: null }), null);
  assert.equal(getPageStatus(pages[0]), null);
});

test('ungültige Stufe wirft, statt still nichts zu tun', () => {
  const { bookId, pages } = seed();
  assert.throws(() => setPageStatus(pages[0], bookId, { status: 'fertig' }), /INVALID|Ungueltig/i);
  assert.equal(getPageStatus(pages[0]), null);
});

test('Freigabe wird als überholt gemeldet, sobald der Text danach gespeichert wurde', () => {
  const { bookId, pages } = seed();
  setPageStatus(pages[0], bookId, { status: 'freigegeben', userEmail: 'a@b.ch' });
  assert.equal(getPageStatus(pages[0]).stale, false, 'frisch gesetzt ist nie überholt');

  // Der Beitrag wird ueberarbeitet — die Freigabe gilt fuer diesen Stand nicht mehr.
  db.prepare('UPDATE pages SET updated_at = ? WHERE page_id = ?').run(T1, pages[0]);
  assert.equal(getPageStatus(pages[0]).stale, true);

  // Erneut freigeben setzt den Anker nach.
  setPageStatus(pages[0], bookId, { status: 'freigegeben', userEmail: 'a@b.ch' });
  assert.equal(getPageStatus(pages[0]).stale, false);
});

test('der Anker kommt aus der Seite, nicht vom Aufrufer', () => {
  // Sonst koennte ein Client einen Status auf einen Textstand stempeln, den es
  // nie gab — die Stale-Anzeige waere damit wertlos.
  const { bookId, pages } = seed();
  setPageStatus(pages[0], bookId, { status: 'roh', content_updated_at: '2099-01-01T00:00:00.000Z' });
  const stored = db.prepare('SELECT content_updated_at FROM page_editorial_status WHERE page_id = ?')
    .get(pages[0]);
  assert.equal(stored.content_updated_at, T0);
});

test('Notiz wird getrimmt und gedeckelt', () => {
  const { bookId, pages } = seed();
  assert.equal(setPageStatus(pages[0], bookId, { status: 'roh', note: '   ' }).note, null);
  const lang = setPageStatus(pages[0], bookId, { status: 'roh', note: 'x'.repeat(900) });
  assert.equal(lang.note.length, 500);
});

test('Verteilung zählt die Beiträge ohne Stufe mit', () => {
  const { bookId, pages } = seed();
  setPageStatus(pages[0], bookId, { status: 'roh' });
  setPageStatus(pages[1], bookId, { status: 'freigegeben' });
  const c = statusCounts(bookId);
  assert.equal(c.roh, 1);
  assert.equal(c.freigegeben, 1);
  assert.equal(c.gegengelesen, 0);
  // Ohne diese Zahl liest sich die Verteilung als „alles erfasst".
  assert.equal(c.ohne, 1, 'Beitrag C hat keine Stufe');
  assert.equal(Object.values(c).reduce((a, b) => a + b, 0), pages.length);
});

test('Buch-Liste ist nach page_id verschlüsselt und buchskopiert', () => {
  const a = seed();
  const b = seed();
  setPageStatus(a.pages[0], a.bookId, { status: 'roh' });
  setPageStatus(b.pages[0], b.bookId, { status: 'freigegeben' });
  const listA = listBookStatus(a.bookId);
  assert.deepEqual(Object.keys(listA), [String(a.pages[0])]);
  assert.equal(listA[String(a.pages[0])].status, 'roh');
  assert.ok(!(String(b.pages[0]) in listA), 'fremdes Buch darf nicht durchschlagen');
});

test('Löschen der Seite nimmt die Stufe mit (CASCADE)', () => {
  const { bookId, pages } = seed();
  setPageStatus(pages[0], bookId, { status: 'roh' });
  db.prepare('DELETE FROM pages WHERE page_id = ?').run(pages[0]);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM page_editorial_status WHERE page_id = ?').get(pages[0]).n,
    0,
  );
});

test.after(() => {
  try { db.close(); } catch { /* egal */ }
  fs.rmSync(TMP, { recursive: true, force: true });
});
