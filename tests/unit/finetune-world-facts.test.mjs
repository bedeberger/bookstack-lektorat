// Unit: Finetune-Sampler fuer Welt-Fakten (Block 29).
//
// Der Sampler giesst EINEN Fakt in rund ein halbes Dutzend Trainingssamples
// (Paraphrasen + Subjekt-Sammlung + Kategorie-Sammlung + Welt-Uebersicht). Genau
// deshalb darf ein als real FALSCH belegter Fakt (Faktencheck-Befund
// typ='faktenfehler') nicht durch: bei Trainingsdaten ist die Vervielfachung des
// Fehlers teurer als das fehlende Sample.
import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.DB_PATH = path.join('/tmp', `ft-wf-test-${process.pid}-${Date.now()}.db`);
const schema = require('../../db/schema');
const db = schema.db;
const { buildWorldFactSamples } = require('../../routes/jobs/finetune-export/samples/author-chat/world-facts.js');

const BOOK = 720;
const USER = 'ftwf@test.dev';

function seedFacts() {
  db.prepare('INSERT OR IGNORE INTO app_users (email) VALUES (?)').run(USER);
  schema.upsertBookByName(BOOK, 'Finetune-Welt');
  // Befunde aus vorherigen Tests raeumen (gleiche DB je Datei).
  db.prepare('DELETE FROM continuity_checks WHERE book_id = ?').run(BOOK);
  db.prepare('INSERT OR IGNORE INTO chapters (chapter_id, book_id, chapter_name, position) VALUES (?, ?, ?, ?)')
    .run(7201, BOOK, 'Kapitel 1', 1);
  schema.saveFaktenToDb(BOOK, [{ kapitel: 'Kapitel 1', fakten: [
    { kategorie: 'historie', subjekt: 'Krieg', fakt: 'Der Krieg endete 1712 mit dem Frieden von Utrecht.' },
    { kategorie: 'historie', subjekt: 'Krieg', fakt: 'Der Krieg begann 1701 im Herbst.' },
    { kategorie: 'regel', subjekt: 'Magie', fakt: 'Zauber kostet Lebenszeit und altert den Traeger.' },
  ] }], USER, { 'Kapitel 1': 7201 });
}

/** Faktencheck-Befund anlegen: `stelle_a` traegt die geprüfte Aussage als
 *  `subjekt: fakt` — genau wie routes/jobs/komplett/job-faktencheck.js sie schreibt. */
function seedFaktenfehler(stelleA) {
  const { lastInsertRowid: cid } = db.prepare(
    `INSERT INTO continuity_checks (book_id, user_email, summary, model, checked_at)
     VALUES (?, ?, '', 'test', '2026-01-01T00:00:00.000Z')`).run(BOOK, USER);
  db.prepare(`INSERT INTO continuity_issues (check_id, book_id, user_email, schwere, typ, beschreibung, stelle_a, stelle_b)
              VALUES (?, ?, ?, 'mittel', 'faktenfehler', 'falsch', ?, '')`).run(cid, BOOK, USER, stelleA);
}

function collect() {
  const samples = [];
  buildWorldFactSamples({
    langIsEn: false,
    bookIdInt: BOOK,
    userEmail: USER,
    pushQA: (id, q, a) => samples.push({ id, q, a }),
    pickVariants: (_id, variants) => variants.map((_, i) => i),
  });
  return samples;
}

test('ohne Faktencheck-Befund kommen alle Fakten durch', () => {
  seedFacts();
  const s = collect();
  assert.ok(s.some(x => x.a.includes('Frieden von Utrecht')));
  assert.ok(s.some(x => x.a.includes('Zauber kostet Lebenszeit')));
  // Welt-Uebersicht ist dabei (>= 2 gueltige Fakten).
  assert.ok(s.some(x => x.id === 'authorChat|wfactAll'));
});

test('als real falsch belegter Fakt erscheint in KEINEM Sample-Typ', () => {
  seedFacts();
  seedFaktenfehler('Krieg: Der Krieg endete 1712 mit dem Frieden von Utrecht.');
  const s = collect();
  for (const x of s) {
    assert.doesNotMatch(x.a, /Frieden von Utrecht/,
      `widerlegter Fakt in Sample ${x.id}`);
  }
  // Der zweite Fakt desselben Subjekts bleibt — gefiltert wird der Fakt, nicht das Subjekt.
  assert.ok(s.some(x => x.a.includes('begann 1701')));
});

test('Filter greift auch in der globalen Welt-Uebersicht', () => {
  seedFacts();
  seedFaktenfehler('Krieg: Der Krieg endete 1712 mit dem Frieden von Utrecht.');
  const all = collect().filter(x => x.id.startsWith('authorChat|wfactAll'));
  assert.ok(all.length, 'Welt-Uebersicht muss noch entstehen');
  for (const x of all) assert.doesNotMatch(x.a, /Frieden von Utrecht/);
});

test('Textvergleich ist whitespace-/case-tolerant (Befund traegt Roh-Text)', () => {
  seedFacts();
  seedFaktenfehler('  krieg:   Der Krieg endete 1712 mit dem Frieden von Utrecht.  ');
  for (const x of collect()) assert.doesNotMatch(x.a, /Frieden von Utrecht/);
});

test('ein Befund zu einem FREMDEN Text filtert nichts weg', () => {
  seedFacts();
  seedFaktenfehler('Irgendwas: gilt hier nicht.');
  const s = collect();
  assert.ok(s.some(x => x.a.includes('Frieden von Utrecht')));
  assert.ok(s.some(x => x.a.includes('Zauber kostet Lebenszeit')));
});
