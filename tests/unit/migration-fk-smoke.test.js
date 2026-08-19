'use strict';
// Migration FK-Smoke: frische DB, alle Migrationen, `foreign_key_check` leer.
//
// CLAUDE.md "Pflicht: jede Migration endet mit foreign_key_check". Eine
// Migration, die FK-Verstösse erzeugt (z.B. Recreate-Pattern ohne Pre-Cleanup),
// pflanzt sich auf alle frisch-Installs fort und failed später unter Last.
// Dieser Test fährt das Initial-Schema + alle Migrationen auf eine leere DB
// hoch und assertiert, dass `PRAGMA foreign_key_check` keine Treffer liefert.
//
// Plus: alle FK-Spalten haben einen Index (Performance + sauberes Schema).

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Vor require auf eigene Temp-DB zeigen, sonst öffnet db/connection.js die
// Produktions-DB (oder die Default-./schreibwerkstatt.db im Repo-Root).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fk-smoke-'));
const dbFile = path.join(tmpDir, `fresh-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = dbFile;

// Module-Cache räumen, falls vorheriger Test die DB-Pfade schon geladen hat.
function freshRequire(rel) {
  const abs = require.resolve(path.join(__dirname, '..', '..', rel));
  delete require.cache[abs];
  return require(abs);
}

// connection.js zuerst — öffnet die DB an DB_PATH. migrations.js läuft auto-mig.
freshRequire('db/connection');
freshRequire('db/migrations');
const { db } = freshRequire('db/connection');

test.after(() => {
  try { db.close(); } catch { /* noop */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

test('foreign_key_check liefert null Treffer nach allen Migrationen', () => {
  const violations = db.pragma('foreign_key_check');
  assert.deepEqual(violations, [],
    `FK-Verstösse nach Migrationen: ${JSON.stringify(violations.slice(0, 5))}`);
});

test('PRAGMA foreign_keys ist auf der Verbindung aktiv', () => {
  const fk = db.pragma('foreign_keys', { simple: true });
  assert.equal(fk, 1, 'foreign_keys MUSS auf 1 stehen — sonst greifen FK-Constraints zur Laufzeit nicht');
});

test('schema_version wurde auf die finale Version gehoben', () => {
  const rows = db.prepare('SELECT version FROM schema_version').all();
  assert.equal(rows.length, 1, 'genau eine Zeile in schema_version');
  assert.ok(rows[0].version >= 1, 'version >= 1');
});

test('Alle FK-Spalten haben einen Index (Performance)', () => {
  // Alle Tabellen.
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  ).all().map(r => r.name);

  const missing = [];
  for (const t of tables) {
    const fkList = db.pragma(`foreign_key_list(${t})`);
    if (fkList.length === 0) continue;
    const idxList = db.pragma(`index_list(${t})`);
    // index_list liefert: { seq, name, unique, origin, partial }
    const indexedCols = new Set();
    for (const idx of idxList) {
      const info = db.pragma(`index_info(${idx.name})`);
      // Wir betrachten den FÜHRENDEN Index-Spalten-Eintrag (seqno=0) — nur
      // dieser indiziert Lookups auf die FK-Spalte direkt.
      if (info.length > 0) indexedCols.add(info[0].name);
    }
    // PRIMARY-KEY-Spalten zählen ebenfalls als indiziert (impliziter Index).
    for (const col of db.pragma(`table_info(${t})`)) {
      if (col.pk > 0) indexedCols.add(col.name);
    }
    for (const fk of fkList) {
      if (!indexedCols.has(fk.from)) {
        missing.push(`${t}.${fk.from} → ${fk.table}.${fk.to}`);
      }
    }
  }
  // Whitelist: aktuell existierende FK-Spalten ohne führenden Index.
  // Pragmatisch ok, wenn die FK-Spalte nur in JOINs mit (book_id, …)
  // ko-gelesen wird (Composite-Index reicht) oder die Tabelle klein ist.
  // Test hält die Liste eingefroren — neue Einträge werden als Fail sichtbar
  // und brauchen entweder Migration mit CREATE INDEX oder explizite Aufnahme
  // hier mit Begründung im Diff.
  const WHITELIST = new Set([
    'user_page_usage.book_id → books.book_id',           // immer mit user_email zusammen gelesen
    'job_checkpoints.book_id → books.book_id',           // klein, nur per job_id gelesen
    'chapter_reviews.chapter_id → chapters.chapter_id',  // klein, per book_id+user gefiltert
    'page_checks.chapter_id → chapters.chapter_id',      // nullable; selten direkt gefiltert
    'locations.erste_erwaehnung_page_id → pages.page_id',// nullable, selten reverse-gelesen
    'chapters.book_id → books.book_id',                  // Composite-Index (book_id, chapter_id) deckt es
    'figure_events.figure_id → figures.id',              // klein pro Figur, immer per Figur gelesen
  ]);
  const real = missing.filter(m => !WHITELIST.has(m));
  assert.deepEqual(real, [],
    `FK-Spalten ohne Index (Performance-Falle): ${JSON.stringify(real)}`);
});

test('Keine SET-NULL-FK-Spalte, die ein CHECK als NOT NULL fordert', () => {
  // `ON DELETE SET NULL` und ein CHECK, der dieselbe Spalte als gesetzt fordert,
  // schliessen sich aus: die FK-Aktion nullt die Spalte und verletzt dabei den
  // CHECK — die loeschende Transaktion bricht ab. Der Fehler zeigt sich NICHT
  // beim Anlegen, sondern erst beim Loeschen des Elternsatzes, und dann fuer
  // JEDEN Loeschweg, der die Kette anfasst (Seite, Kapitel, Buch, Konto).
  // Darum ein statischer Tripwire ueber das ganze Schema statt Einzeltests.
  const tables = db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  ).all();

  const conflicts = [];
  for (const t of tables) {
    if (!t.sql || !/CHECK/i.test(t.sql)) continue;
    for (const fk of db.pragma(`foreign_key_list("${t.name}")`)) {
      if (fk.on_delete !== 'SET NULL') continue;
      // Grob, aber genau die gefaehrliche Form: der CHECK verlangt irgendwo,
      // dass diese Spalte gesetzt ist.
      const re = new RegExp(`\\b${fk.from}\\s+IS NOT NULL`, 'i');
      if (re.test(t.sql)) conflicts.push(`${t.name}.${fk.from} → ${fk.table} (SET NULL vs. CHECK)`);
    }
  }
  assert.deepEqual(conflicts, [],
    `SET NULL trifft NOT-NULL-CHECK — dieses Loeschen schlaegt zur Laufzeit fehl: ${JSON.stringify(conflicts)}`);
});

test('Snapshot-Spalten verboten (CLAUDE.md "Snapshot-Spalten verboten")', () => {
  // Display-Namen (chapter_name, page_name, book_name, kapitel, seite) gehören
  // NICHT in Tabellen — Wahrheit lebt in chapters/pages/books/figures.
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  ).all().map(r => r.name);

  const BAD_COLS = ['chapter_name', 'page_name', 'book_name', 'kapitel', 'seite'];
  // Whitelist: die SSoT-Tabellen selbst dürfen ihre Namen-Spalten haben.
  const ALLOWED_OWNER = new Map([
    ['chapter_name', new Set(['chapters'])],
    ['page_name',    new Set(['pages'])],
    ['book_name',    new Set(['books'])],
    // Historische Snapshot-Spalten auf Caches/Sentinels, die noch leben:
    ['kapitel', new Set(['continuity_issue_chapters' /* nullable Fallback */])],
    ['seite',   new Set([])],
  ]);
  // Bekannte Ausnahmen (Fallback bei nullable FK, dokumentiert in CLAUDE.md):
  //   continuity_issue_figures.figur_name (nullable FK auf figures.id)
  const TOLERATED = new Set([
    'continuity_issue_figures.figur_name',
    'continuity_issue_chapters.kapitel',
    // chat_sessions.page_name: Snapshot von BookStack-Seitennamen, da chat
    // auch nach Page-Löschung lesbar bleiben soll. Bewusst toleriert.
    'chat_sessions.page_name',
    // page_deletions.page_name: Audit-Name der geloeschten Seite fuer den
    // Collab-Toast; die Seite selbst ist bereits hard-deleted.
    'page_deletions.page_name',
  ]);

  const offenders = [];
  for (const t of tables) {
    const cols = db.pragma(`table_info(${t})`).map(c => c.name);
    for (const bad of BAD_COLS) {
      if (!cols.includes(bad)) continue;
      const ownerSet = ALLOWED_OWNER.get(bad) || new Set();
      if (ownerSet.has(t)) continue;
      const k = `${t}.${bad}`;
      if (TOLERATED.has(k)) continue;
      offenders.push(k);
    }
  }
  assert.deepEqual(offenders, [],
    `Snapshot-Spalten gefunden (CLAUDE.md verboten): ${JSON.stringify(offenders)}. ` +
    `Falls bewusst nullable Fallback: in TOLERATED ergänzen und in CLAUDE.md begründen.`);
});
