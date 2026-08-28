'use strict';
// page_revisions CRUD + Retention.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const tmp = path.join('/tmp', `page-revisions-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmp;

const { db } = require('../../db/connection');
require('../../db/migrations');
const { upsertBookByName } = require('../../db/books');
const appUsers = require('../../db/app-users');
const pageRevisions = require('../../db/page-revisions');

function _seedPage(bookId, pageId, name = 'Seite') {
  db.prepare(
    'INSERT INTO pages (page_id, book_id, page_name, updated_at) VALUES (?, ?, ?, ?)'
  ).run(pageId, bookId, name, new Date().toISOString());
}

// Mig 130 FK: user_email braucht app_users-Row.
appUsers.createUser({ email: 'a@x.test', displayName: 'A' });
appUsers.createUser({ email: 'b@x.test', displayName: 'B' });

test('page_revisions: insert + listForPage + countForPage', () => {
  upsertBookByName(901, 'Test-Buch P2 A');
  _seedPage(901, 90101, 'Erste Seite');

  pageRevisions.insert({
    pageId: 90101, bookId: 901,
    bodyHtml: '<p>Hallo Welt</p>',
    source: 'main', userEmail: 'a@x.test',
  });
  pageRevisions.insert({
    pageId: 90101, bookId: 901,
    bodyHtml: '<p>Hallo schoene Welt</p>',
    source: 'focus', userEmail: 'a@x.test',
  });
  pageRevisions.insert({
    pageId: 90101, bookId: 901,
    bodyHtml: '<p>Hallo schoenere Welt</p>',
    source: 'chat-apply', userEmail: 'b@x.test',
  });

  assert.equal(pageRevisions.countForPage(90101), 3);

  const list = pageRevisions.listForPage(90101);
  assert.equal(list.length, 3);
  // DESC: jueng­ste zuerst.
  assert.equal(list[0].source, 'chat-apply');
  assert.equal(list[2].source, 'main');
  // chars-Spalte ist gefuellt (HTML→Text + Length).
  assert.ok(list[0].chars > 0);
});

test('page_revisions: Dedup gegen juengste Revision', () => {
  upsertBookByName(905, 'Test-Buch P2 Dedup');
  _seedPage(905, 90501);

  const id1 = pageRevisions.insert({
    pageId: 90501, bookId: 905,
    bodyHtml: '<p>identisch</p>',
    source: 'main', userEmail: 'a@x.test',
  });
  assert.ok(id1);

  // Identischer Body → skip, gibt null zurueck.
  const id2 = pageRevisions.insert({
    pageId: 90501, bookId: 905,
    bodyHtml: '<p>identisch</p>',
    source: 'focus', userEmail: 'a@x.test',
  });
  assert.equal(id2, null);
  assert.equal(pageRevisions.countForPage(90501), 1);

  // Geaenderter Body → neue Row.
  const id3 = pageRevisions.insert({
    pageId: 90501, bookId: 905,
    bodyHtml: '<p>anders</p>',
    source: 'main', userEmail: 'a@x.test',
  });
  assert.ok(id3);
  assert.equal(pageRevisions.countForPage(90501), 2);

  // Wieder zurueck auf alten Body → KEIN Dedup (juengste = "anders").
  const id4 = pageRevisions.insert({
    pageId: 90501, bookId: 905,
    bodyHtml: '<p>identisch</p>',
    source: 'main', userEmail: 'a@x.test',
  });
  assert.ok(id4);
  assert.equal(pageRevisions.countForPage(90501), 3);
});

test('page_revisions: Dedup auf normalisiertem Text (Phantom-Rev-Schutz)', () => {
  upsertBookByName(906, 'Test-Buch P2 PhantomDedup');
  _seedPage(906, 90601);

  const id1 = pageRevisions.insert({
    pageId: 90601, bookId: 906,
    bodyHtml: '<p>als gewöhnlich.</p>',
    source: 'main', userEmail: 'a@x.test',
  });
  assert.ok(id1);

  // Trailing &#160; aendert Bytes, aber sichtbarer Text identisch.
  // Dedup auf htmlToPlainText muss greifen → null.
  const id2 = pageRevisions.insert({
    pageId: 90601, bookId: 906,
    bodyHtml: '<p>als gewöhnlich.&#160;</p>',
    source: 'focus', userEmail: 'a@x.test',
  });
  assert.equal(id2, null);
  assert.equal(pageRevisions.countForPage(90601), 1);

  // Echte Text-Aenderung → neue Row.
  const id3 = pageRevisions.insert({
    pageId: 90601, bookId: 906,
    bodyHtml: '<p>als gewöhnlich. Plus mehr.</p>',
    source: 'main', userEmail: 'a@x.test',
  });
  assert.ok(id3);
  assert.equal(pageRevisions.countForPage(90601), 2);
});

test('page_revisions: invalid source wirft', () => {
  upsertBookByName(902, 'Test-Buch P2 B');
  _seedPage(902, 90201);
  assert.throws(() => pageRevisions.insert({
    pageId: 90201, bookId: 902, bodyHtml: '<p>x</p>', source: 'haxxor',
  }), /invalid source/);
});

// Backdating-Helper: schreibt created_at explizit (umgeht den NOW_ISO_SQL-Default).
// `anchorMs` macht die UTC-Date-Buckets (date()/strftime in pruneTiered) deterministisch
// — sonst wandern Tag-/Wochen-Grenzen je nach CI-Uhrzeit zwischen den daysAgo-Werten.
function _insertAt(pageId, bookId, bodyHtml, daysAgo, anchorMs = Date.now()) {
  const created = new Date(anchorMs - daysAgo * 86400_000).toISOString();
  // Stats analog _statsFromHtml: hier reicht ein Wert >0; pruneTiered liest sie nicht.
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO page_revisions
      (page_id, book_id, body_html, chars, words, tok,
       source, user_email, summary, created_at)
    VALUES
      (?, ?, ?, ?, ?, ?, 'main', NULL, NULL, ?)
  `).run(pageId, bookId, bodyHtml, bodyHtml.length, 1, 1, created);
  return { id: lastInsertRowid, created };
}

test('page_revisions: pruneTiered haelt Floor (jueng­ste N) pro Seite', () => {
  db.prepare('DELETE FROM page_revisions').run();
  upsertBookByName(903, 'Test-Buch P2 C');
  _seedPage(903, 90301);
  _seedPage(903, 90302);

  // Alle Revisions <1 Tag → alle im 'raw'-Bucket → keine Loeschung durch Tiering.
  for (let i = 1; i <= 5; i++) {
    pageRevisions.insert({
      pageId: 90301, bookId: 903,
      bodyHtml: `<p>v${i}</p>`, source: 'main',
    });
  }
  for (let i = 1; i <= 3; i++) {
    pageRevisions.insert({
      pageId: 90302, bookId: 903,
      bodyHtml: `<p>w${i}</p>`, source: 'main',
    });
  }
  const removed = pageRevisions.pruneTiered({ floor: 2 });
  // raw-Bucket schuetzt alle juengsten 24h → nichts geloescht.
  assert.equal(removed, 0);
  assert.equal(pageRevisions.countForPage(90301), 5);
  assert.equal(pageRevisions.countForPage(90302), 3);
});

test('page_revisions: pruneTiered GFS — Tages-Bucket nimmt aelteste pro Tag', () => {
  db.prepare('DELETE FROM page_revisions').run();
  upsertBookByName(910, 'Test-Buch GFS Daily');
  _seedPage(910, 91001);

  // Fixer UTC-Anker → date(created_at)-Buckets sind unabhaengig von der CI-Uhrzeit.
  const anchor = '2026-05-25T12:00:00.000Z';
  const anchorMs = Date.parse(anchor);

  // Tag 2 ago: 3 Revisions (sollten zu 1 zusammenfallen — aelteste)
  // Tag 3 ago: 2 Revisions (zu 1)
  // Tag 4 ago: 1 Revision
  // daysAgo-Werte innerhalb 0.5d eines Integer-Tages, damit anchor±xd in einem UTC-Kalendertag landet.
  const r_d2_old = _insertAt(91001, 910, '<p>d2_old</p>', 2.4, anchorMs);
  _insertAt(91001, 910, '<p>d2_mid</p>', 2.2, anchorMs);
  _insertAt(91001, 910, '<p>d2_new</p>', 2.0, anchorMs);
  const r_d3_old = _insertAt(91001, 910, '<p>d3_old</p>', 3.4, anchorMs);
  _insertAt(91001, 910, '<p>d3_new</p>', 3.0, anchorMs);
  const r_d4 = _insertAt(91001, 910, '<p>d4</p>', 4.0, anchorMs);

  assert.equal(pageRevisions.countForPage(91001), 6);

  // Floor 1 (minimal), damit Floor nicht den Test verfaelscht.
  pageRevisions.pruneTiered({ floor: 1, now: anchor });

  const ids = db.prepare('SELECT id FROM page_revisions WHERE page_id = ? ORDER BY id ASC').all(91001).map(r => r.id);
  // Erwartet: 3 Behalten (aelteste pro Tag) plus Floor-Pick (juengste). Juengste = r_d2_new ist bereits NICHT in keep_buckets (nur aelteste pro Tag).
  // Buckets: d2 → r_d2_old, d3 → r_d3_old, d4 → r_d4.
  // Floor 1 → juengste = r_d2_new (Tag 2, neueste). → Total 4 IDs.
  assert.equal(ids.length, 4, `kept ids: ${ids.join(',')}`);
  assert.ok(ids.includes(r_d2_old.id), 'aelteste in Tag-2-Bucket fehlt');
  assert.ok(ids.includes(r_d3_old.id), 'aelteste in Tag-3-Bucket fehlt');
  assert.ok(ids.includes(r_d4.id), 'Tag-4-Rev fehlt');
});

test('page_revisions: pruneTiered GFS — Wochen-/Monats-/Jahres-Buckets', () => {
  db.prepare('DELETE FROM page_revisions').run();
  upsertBookByName(911, 'Test-Buch GFS Tiers');
  _seedPage(911, 91101);

  // Fixer UTC-Anker (Montag, 12:00) → ISO-Wochen-/Monats-/Jahres-Buckets sind
  // unabhaengig von der CI-Uhrzeit und vom Wochentag von "jetzt" deterministisch.
  const anchor = '2026-05-25T12:00:00.000Z';
  const anchorMs = Date.parse(anchor);

  // Wochen-Range (7-60 Tage): 2 Revs in derselben Woche → 1 behalten.
  const r_w_old = _insertAt(91101, 911, '<p>w_old</p>', 14, anchorMs);
  _insertAt(91101, 911, '<p>w_new</p>', 13, anchorMs);
  // Andere Woche im selben Range
  const r_w2 = _insertAt(91101, 911, '<p>w2</p>', 30, anchorMs);

  // Monats-Range (60-365 Tage): 2 Revs im selben Monat → 1 behalten.
  const r_m_old = _insertAt(91101, 911, '<p>m_old</p>', 100, anchorMs);
  _insertAt(91101, 911, '<p>m_new</p>', 95, anchorMs);
  // Anderer Monat
  const r_m2 = _insertAt(91101, 911, '<p>m2</p>', 200, anchorMs);

  // Jahres-Range (>365 Tage): 2 Revs im selben Jahr → 1 behalten.
  const r_y_old = _insertAt(91101, 911, '<p>y_old</p>', 800, anchorMs);
  _insertAt(91101, 911, '<p>y_new</p>', 600, anchorMs);

  assert.equal(pageRevisions.countForPage(91101), 8);

  pageRevisions.pruneTiered({ floor: 1, now: anchor });

  const kept = db.prepare('SELECT id, body_html FROM page_revisions WHERE page_id = ? ORDER BY id ASC').all(91101);
  const keptBodies = kept.map(r => r.body_html);

  // Erwartet behalten: w_old, w2, m_old, m2, y_old + Floor (juengste = w_new bei daysAgo=13).
  assert.ok(keptBodies.includes('<p>w_old</p>'), 'aelteste in Woche-1 fehlt');
  assert.ok(keptBodies.includes('<p>w2</p>'), 'aelteste in Woche-2 fehlt');
  assert.ok(keptBodies.includes('<p>m_old</p>'), 'aelteste in Monat-1 fehlt');
  assert.ok(keptBodies.includes('<p>m2</p>'), 'aelteste in Monat-2 fehlt');
  assert.ok(keptBodies.includes('<p>y_old</p>'), 'aelteste in Jahr-Bucket fehlt');

  // Nicht behalten: w_new (selbe Woche wie w_old, aber juenger), m_new, y_new (≠ Floor-juengste).
  assert.ok(!keptBodies.includes('<p>m_new</p>'), 'm_new sollte weg sein');
  assert.ok(!keptBodies.includes('<p>y_new</p>'), 'y_new sollte weg sein');

  // Unused-Marker (Lint)
  void r_w_old; void r_w2; void r_m_old; void r_m2; void r_y_old;
});

test('page_revisions: pruneTiered — Floor schuetzt zusaetzlich zu Buckets', () => {
  db.prepare('DELETE FROM page_revisions').run();
  upsertBookByName(912, 'Test-Buch GFS Floor');
  _seedPage(912, 91201);

  // Fixer Anker mitten im Monat → 100d/99.6d-99.9d landen alle im selben %Y-%m.
  const anchor = '2026-05-25T12:00:00.000Z';
  const anchorMs = Date.parse(anchor);

  // 5 Revs im Monat-Bucket (alle ~100d alt, selber Monat).
  // Ohne Floor wuerde Tiering nur die aelteste behalten.
  const ids = [];
  for (let i = 0; i < 5; i++) {
    ids.push(_insertAt(91201, 912, `<p>m${i}</p>`, 100 - i * 0.1, anchorMs).id);
  }
  assert.equal(pageRevisions.countForPage(91201), 5);

  pageRevisions.pruneTiered({ floor: 3, now: anchor });

  // Behalten: aelteste-im-Bucket (ids[0]) + juengste 3 (ids[2], ids[3], ids[4]).
  // ids[1] kein Bucket-Pick (nicht aelteste), kein Floor-Pick (nur 3 juengste).
  const kept = db.prepare('SELECT id FROM page_revisions WHERE page_id = ?').all(91201).map(r => r.id).sort();
  assert.equal(kept.length, 4, `kept: ${kept.join(',')}`);
  assert.ok(kept.includes(ids[0]), 'Bucket-aelteste fehlt');
  assert.ok(kept.includes(ids[2]) && kept.includes(ids[3]) && kept.includes(ids[4]), 'Floor-Trio fehlt');
  assert.ok(!kept.includes(ids[1]), 'ids[1] sollte weg sein');
});

test('page_revisions: pruneTiered — now-Override fuer deterministische Tests', () => {
  db.prepare('DELETE FROM page_revisions').run();
  upsertBookByName(913, 'Test-Buch GFS NowOverride');
  _seedPage(913, 91301);

  // Rev von "vor 2 Tagen" relativ zu fixiertem Anker.
  const anchor = new Date('2026-06-01T12:00:00.000Z');
  const twoDaysBefore = new Date(anchor.getTime() - 2 * 86400_000).toISOString();
  db.prepare(`
    INSERT INTO page_revisions
      (page_id, book_id, body_html, chars, words, tok, source, created_at)
    VALUES (?, ?, '<p>x</p>', 1, 1, 1, 'main', ?)
  `).run(91301, 913, twoDaysBefore);

  // now = anchor → Rev faellt in Tages-Bucket (1-7d), nicht raw, nicht Woche.
  // Floor 1 → genau die eine Rev bleibt (sowohl als Bucket- als auch Floor-Pick).
  const removed = pageRevisions.pruneTiered({ floor: 1, now: anchor.toISOString() });
  assert.equal(removed, 0);
  assert.equal(pageRevisions.countForPage(91301), 1);
});

test('page_revisions: FK-CASCADE bei Page-Delete', () => {
  upsertBookByName(904, 'Test-Buch P2 D');
  _seedPage(904, 90401);
  pageRevisions.insert({
    pageId: 90401, bookId: 904, bodyHtml: '<p>x</p>', source: 'main',
  });
  assert.equal(pageRevisions.countForPage(90401), 1);
  db.prepare('DELETE FROM pages WHERE page_id = ?').run(90401);
  assert.equal(pageRevisions.countForPage(90401), 0);
});

// ── Keyset-Paginierung ───────────────────────────────────────────────────────
// Deckt ab, was die Revisionsliste im Editor braucht: das erste Fenster ist
// nicht die ganze Historie (raw-Bucket haelt jeden Autosave der letzten 24 h),
// und der Cursor muss auch bei gleichem `created_at` weiterkommen.

test('page_revisions: listForPageKeyset — Fenster + hasMore + Cursor', () => {
  upsertBookByName(914, 'Test-Buch Keyset');
  _seedPage(914, 91401);
  const ins = db.prepare(`
    INSERT INTO page_revisions
      (page_id, book_id, body_html, chars, words, tok, source, created_at)
    VALUES (?, ?, ?, ?, 1, 1, 'main', ?)
  `);
  const base = new Date('2026-06-01T00:00:00.000Z').getTime();
  for (let i = 0; i < 7; i++) {
    ins.run(91401, 914, `<p>r${i}</p>`, i + 1, new Date(base + i * 60_000).toISOString());
  }

  const first = pageRevisions.listForPageKeyset(91401, { limit: 3 });
  assert.equal(first.revisions.length, 3);
  assert.equal(first.hasMore, true);
  // DESC: juengste zuerst.
  assert.equal(first.revisions[0].chars, 7);
  assert.equal(first.revisions[2].chars, 5);

  const last = first.revisions[first.revisions.length - 1];
  const second = pageRevisions.listForPageKeyset(91401, {
    limit: 3, before: last.created_at, beforeId: last.id,
  });
  assert.equal(second.revisions.length, 3);
  assert.equal(second.hasMore, true);
  assert.equal(second.revisions[0].chars, 4, 'Cursor-Revision darf nicht doppelt kommen');

  const last2 = second.revisions[second.revisions.length - 1];
  const third = pageRevisions.listForPageKeyset(91401, {
    limit: 3, before: last2.created_at, beforeId: last2.id,
  });
  assert.equal(third.revisions.length, 1);
  assert.equal(third.hasMore, false, 'letztes Fenster darf kein hasMore melden');

  // Kein Loch, keine Dublette ueber alle drei Fenster.
  const all = [...first.revisions, ...second.revisions, ...third.revisions].map(r => r.chars);
  assert.deepEqual(all, [7, 6, 5, 4, 3, 2, 1]);
});

test('page_revisions: listForPageKeyset — id als Tie-Break bei gleichem created_at', () => {
  upsertBookByName(915, 'Test-Buch Keyset Tie');
  _seedPage(915, 91501);
  const same = '2026-06-02T10:00:00.000Z';
  const ins = db.prepare(`
    INSERT INTO page_revisions
      (page_id, book_id, body_html, chars, words, tok, source, created_at)
    VALUES (?, ?, ?, ?, 1, 1, 'main', ?)
  `);
  const ids = [];
  for (let i = 0; i < 3; i++) {
    ids.push(Number(ins.run(91501, 915, `<p>t${i}</p>`, i + 1, same).lastInsertRowid));
  }

  const first = pageRevisions.listForPageKeyset(91501, { limit: 2 });
  assert.deepEqual(first.revisions.map(r => r.id), [ids[2], ids[1]]);
  assert.equal(first.hasMore, true);

  // Ohne id im WHERE waere hier Schluss (created_at < created_at ist leer).
  const second = pageRevisions.listForPageKeyset(91501, {
    limit: 2, before: same, beforeId: ids[1],
  });
  assert.deepEqual(second.revisions.map(r => r.id), [ids[0]]);
  assert.equal(second.hasMore, false);
});

test('page_revisions: listForPageKeyset — halber Cursor liest von vorne', () => {
  // Der Route-Handler filtert das schon; die DB-Schicht darf bei fehlendem
  // beforeId trotzdem nicht in ein SQL mit NULL-Vergleich laufen (liefert sonst
  // stumm 0 Zeilen und die Liste bricht mitten in der Historie ab).
  const full = pageRevisions.listForPageKeyset(91501, { limit: 10 });
  const halfCursor = pageRevisions.listForPageKeyset(91501, {
    limit: 10, before: '2026-06-02T10:00:00.000Z', beforeId: null,
  });
  assert.equal(halfCursor.revisions.length, full.revisions.length);
});
