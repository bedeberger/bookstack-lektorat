'use strict';
// Zeit-Tracking-Familie (db/time-tracking.js): die drei Heartbeat-Zaehler
// entstehen aus EINER Spec. Dieser Test haelt fest, was die Spec pro Tracker
// unterschiedlich machen MUSS — und dass die Antwortform stimmt, denn sie ist
// Client-Vertrag (BookStats-Karte liest total_seconds/active_days/daily,
// Lektoratszeit zusaetzlich per_page/per_chapter, Diktat total_chars).

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(os.tmpdir(), `time-tracking-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmpDb;
delete process.env.ADMIN_EMAIL;

require('../../db/migrations');
const { db } = require('../../db/connection');
const tt = require('../../db/time-tracking');

test.after(() => {
  try { db.close(); } catch {}
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch {} }
});

const EMAIL = 'tester@test.dev';
const BOOK = 4242;
const PAGE = 77;

// Minimalbestand: die Tracker haengen per FK an app_users/books/pages.
const NOW = '2026-08-10T12:00:00.000Z';
db.prepare('INSERT INTO app_users (email, display_name) VALUES (?, ?)').run(EMAIL, 'Autor');
db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)')
  .run(BOOK, 'Testbuch', NOW, NOW, EMAIL);
db.prepare('INSERT INTO pages (page_id, book_id, page_name, updated_at) VALUES (?, ?, ?, ?)')
  .run(PAGE, BOOK, 'Testseite', NOW);

const beat = (kind, over = {}) => tt.recordHeartbeat(kind, {
  userEmail: EMAIL, bookId: BOOK, date: '2026-08-10', hour: 14, seconds: 60, ...over,
});

test('clampDelta: nur positive Ganzzahlen, gedeckelt', () => {
  assert.equal(tt.clampDelta(59.6), 60);
  assert.equal(tt.clampDelta(0), 0);
  assert.equal(tt.clampDelta(-5), 0);
  assert.equal(tt.clampDelta('abc'), 0);
  assert.equal(tt.clampDelta(undefined), 0);
  assert.equal(tt.clampDelta(Infinity), 0, 'nicht-endlich zaehlt nicht');
  // Uhrensprung-Schutz: ein Ping kann nie mehr als eine Stunde buchen.
  assert.equal(tt.clampDelta(999999), tt.MAX_SECONDS_PER_PING);
  assert.equal(tt.clampDelta(999999, tt.MAX_CHARS_PER_PING), tt.MAX_CHARS_PER_PING);
});

test('unbekannter Tracker wirft statt still nichts zu tun', () => {
  assert.throws(() => tt.trackerSpec('gibtsnicht'), /Unbekannter Zeit-Tracker/);
  assert.throws(() => tt.recordHeartbeat('gibtsnicht', {}), /Unbekannter Zeit-Tracker/);
});

test('writing: summiert additiv pro Tag und fuehrt Stunde + Session mit', () => {
  beat('writing', { seconds: 60 });
  beat('writing', { seconds: 30 });
  const s = tt.readSummary('writing', { userEmail: EMAIL, bookId: BOOK });
  assert.equal(s.total_seconds, 90, 'zweiter Ping addiert, ersetzt nicht');
  assert.equal(s.active_days, 1);
  assert.deepEqual(s.daily, [{ date: '2026-08-10', seconds: 90 }]);
  assert.equal(s.first_date, '2026-08-10');
  assert.equal(s.last_date, '2026-08-10');

  // Nebenbuecher der Schreibzeit — nur dieser Tracker fuehrt sie.
  const hour = db.prepare('SELECT hour, seconds FROM writing_hour WHERE user_email = ? AND book_id = ?').get(EMAIL, BOOK);
  assert.deepEqual(hour, { hour: 14, seconds: 90 });
  const sess = db.prepare('SELECT COUNT(*) AS n, SUM(seconds) AS s FROM writing_session WHERE user_email = ? AND book_id = ?').get(EMAIL, BOOK);
  assert.equal(sess.n, 1, 'zwei Pings knapp hintereinander = eine Session');
  assert.equal(sess.s, 90);
});

test('writing: kein per_page/per_chapter und kein total_chars in der Antwort', () => {
  const s = tt.readSummary('writing', { userEmail: EMAIL, bookId: BOOK });
  assert.equal('per_page' in s, false);
  assert.equal('per_chapter' in s, false);
  assert.equal('total_chars' in s, false);
});

test('stt: zaehlt Zeichen als zweite Spalte, mit eigenem Deckel', () => {
  beat('stt', { seconds: 15, extra: { chars: 120 } });
  beat('stt', { seconds: 15, extra: { chars: 999999 } });   // Zeichen-Clamp
  const s = tt.readSummary('stt', { userEmail: EMAIL, bookId: BOOK });
  assert.equal(s.total_seconds, 30);
  assert.equal(s.total_chars, 120 + tt.MAX_CHARS_PER_PING);
  assert.deepEqual(Object.keys(s.daily[0]).sort(), ['chars', 'date', 'seconds']);
});

test('stt: ein Tag mit Zeichen aber 0 Sekunden zaehlt als aktiver Tag', () => {
  // Transkript-Antwort trifft nach dem Mic-Stop ein: nur Zeichen, keine Zeit.
  beat('stt', { date: '2026-08-11', seconds: 0, extra: { chars: 40 } });
  const s = tt.readSummary('stt', { userEmail: EMAIL, bookId: BOOK });
  assert.equal(s.active_days, 2);
  assert.equal(s.last_date, '2026-08-11');
});

test('lektorat: pro Seite skopiert, Antwort traegt per_page + per_chapter', () => {
  beat('lektorat', { scopeId: PAGE, seconds: 100 });
  beat('lektorat', { scopeId: PAGE, seconds: 50 });
  const s = tt.readSummary('lektorat', { userEmail: EMAIL, bookId: BOOK });
  assert.equal(s.total_seconds, 150);
  assert.equal(s.active_days, 1, 'Tage distinct, obwohl mehrere Zeilen pro Tag moeglich');
  assert.deepEqual(s.daily, [{ date: '2026-08-10', seconds: 150 }]);
  assert.deepEqual(s.per_page, [{ page_id: PAGE, page_name: 'Testseite', seconds: 150 }]);
  assert.equal(Array.isArray(s.per_chapter), true);
  // Seite ohne Kapitel → chapter_id null, Name leer (kein Sentinel).
  assert.equal(s.per_chapter[0].chapter_id, null);
  assert.equal(s.per_chapter[0].chapter_name, '');
  assert.equal(s.per_chapter[0].pages_count, 1);
});

test('Tracker sind gegeneinander dicht: derselbe Tag zaehlt je Tabelle getrennt', () => {
  const w = tt.readSummary('writing', { userEmail: EMAIL, bookId: BOOK });
  const l = tt.readSummary('lektorat', { userEmail: EMAIL, bookId: BOOK });
  assert.equal(w.total_seconds, 90);
  assert.equal(l.total_seconds, 150);
});

test('fremdes Buch/fremder User sieht nichts', () => {
  const other = tt.readSummary('writing', { userEmail: 'fremd@test.dev', bookId: BOOK });
  assert.equal(other.total_seconds, 0);
  assert.deepEqual(other.daily, []);
  const otherBook = tt.readSummary('writing', { userEmail: EMAIL, bookId: 999999 });
  assert.equal(otherBook.total_seconds, 0);
});
