// Drift-Gate für die journalistischen Textsorten.
//
// SSoT ist public/js/prompts/textsorten.js. Daran hängen vier Schichten, die den
// Katalog in eigenen Kopien bzw. Ableitungen führen MÜSSEN, weil sie in anderen
// Modulsystemen leben oder synchron validieren:
//   1. db/textsorte.js#TEXTSORTE_KEYS (CJS-Spiegel, Schreibpfad-Validierung)
//   2. der Buchtyp `journalismus` in prompt-config.json + routes/booksettings.js
//   3. das Lektorat-Typ-Set (`wertung` fällt in den Meinungsformen weg)
//   4. public/js/i18n/{de,en}.json (`textsorte.<key>`)
//
// Eine Textsorte, die nur in der SSoT landet, wird vom Server mit 400
// INVALID_VALUE abgelehnt und erscheint in der Karte ohne Label.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const require = createRequire(import.meta.url);
const esm = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const ts = await esm('public/js/prompts/textsorten.js');
const {
  TEXTSORTEN, TEXTSORTE_KEYS, DEFAULT_TEXTSORTE,
  istMeinungsform, textsorteLabel, textsorteRegelnListe,
} = ts;

test('Katalog ist konsistent: Keys eindeutig, jede Sorte hat Regeln und Label', () => {
  assert.equal(TEXTSORTE_KEYS.length, new Set(TEXTSORTE_KEYS).size, 'Duplikate im Katalog');
  assert.ok(TEXTSORTE_KEYS.includes(DEFAULT_TEXTSORTE), 'Default steht nicht im Katalog');
  for (const t of TEXTSORTEN) {
    assert.ok(t.promptLabel, `${t.key}: promptLabel fehlt`);
    assert.ok(Array.isArray(t.regeln) && t.regeln.length >= 4, `${t.key}: zu wenige Formregeln`);
    assert.equal(typeof t.meinung, 'boolean', `${t.key}: meinung muss boolean sein`);
    // Die Regeln landen 1:1 als nummerierte Liste im Prompt — jede muss ein Satz
    // sein, den ein Modell gegen den Text prüfen kann, kein Stichwort.
    for (const r of t.regeln) assert.ok(r.length > 25, `${t.key}: Regel zu knapp: «${r}»`);
  }
});

test('meinungsbetonte Formen sind genau Kommentar, Glosse, Rezension', () => {
  const meinung = TEXTSORTEN.filter(t => t.meinung).map(t => t.key).sort();
  assert.deepEqual(meinung, ['glosse', 'kommentar', 'rezension']);
  for (const k of meinung) assert.ok(istMeinungsform(k), k);
  for (const k of ['nachricht', 'bericht', 'reportage', 'interview', 'portraet', 'feature']) {
    assert.ok(!istMeinungsform(k), k);
  }
  // Unbekannt/null → false: im Zweifel gilt die Trennung von Nachricht und Meinung.
  for (const k of [null, undefined, '', 'gibtsnicht']) assert.ok(!istMeinungsform(k));
});

test('db/textsorte.js#TEXTSORTE_KEYS spiegelt den Katalog', () => {
  const { TEXTSORTE_KEYS: cjs, isValidTextsorte } = require(path.join(ROOT, 'db/textsorte.js'));
  assert.deepEqual([...cjs].sort(), [...TEXTSORTE_KEYS].sort());
  for (const k of TEXTSORTE_KEYS) assert.ok(isValidTextsorte(k), k);
  for (const k of ['', 'roman', null, 42]) assert.ok(!isValidTextsorte(k), String(k));
});

test('Buchtyp `journalismus` existiert in prompt-config.json und in der Route', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'prompt-config.json'), 'utf8'));
  for (const lang of ['de', 'en']) {
    assert.ok(cfg.buchtypen[lang].journalismus, `${lang}: Buchtyp journalismus fehlt`);
    assert.ok(cfg.buchtypen[lang].journalismus.zusatz, `${lang}: zusatz fehlt`);
  }
  const routeSrc = fs.readFileSync(path.join(ROOT, 'routes/booksettings.js'), 'utf8');
  const m = routeSrc.match(/const VALID_BUCHTYPEN = \[([^\]]+)\]/);
  assert.ok(m, 'VALID_BUCHTYPEN nicht gefunden');
  assert.ok(m[1].includes("'journalismus'"), 'VALID_BUCHTYPEN kennt journalismus nicht');
});

test('jede Textsorte hat ein Label in beiden Locales', () => {
  for (const locale of ['de', 'en']) {
    const i18n = JSON.parse(fs.readFileSync(path.join(ROOT, `public/js/i18n/${locale}.json`), 'utf8'));
    for (const k of TEXTSORTE_KEYS) {
      assert.ok(i18n[`textsorte.${k}`], `${locale}: textsorte.${k} fehlt`);
    }
  }
});

// ── Wirkung auf das Lektorat ─────────────────────────────────────────────────
// Der eigentliche Zweck der Meinungs-Flagge: im Kommentar ist die Wertung der
// Zweck des Textes, nicht ihr Mangel. Ohne diesen Schnitt meldete das Lektorat
// einen Kommentar Satz für Satz als fehlerhaft.

test('`wertung` fällt in den Meinungsformen aus dem Lektorat-Typ-Set', async () => {
  const { lektoratTypen } = await esm('public/js/prompts/lektorat-typen.js');
  for (const k of ['bericht', 'nachricht', 'reportage', null]) {
    assert.ok(lektoratTypen('journalismus', { textsorte: k }).includes('wertung'),
      `wertung muss bei ${k} geprüft werden`);
  }
  for (const k of ['kommentar', 'glosse', 'rezension']) {
    assert.ok(!lektoratTypen('journalismus', { textsorte: k }).includes('wertung'),
      `wertung darf bei ${k} nicht geprüft werden`);
  }
  // Die Textsorte darf ausserhalb des journalistischen Profils nichts ändern.
  for (const bt of ['roman', 'sachbuch', 'wissenschaft']) {
    assert.deepEqual(lektoratTypen(bt, { textsorte: 'kommentar' }), lektoratTypen(bt));
  }
});

test('Struktur-Prompt trägt den Soll-Katalog der gewählten Textsorte', async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'prompt-config.json'), 'utf8'));
  const prompts = await esm('public/js/prompts.js');
  prompts.configurePrompts(cfg, 'claude');
  const p = prompts.buildStrukturCheckPrompt('Ein Beispieltext.', { textsorte: 'nachricht' });
  assert.ok(p.includes(textsorteLabel('nachricht')), 'Textsorten-Label fehlt');
  assert.ok(p.includes(textsorteRegelnListe('nachricht')), 'Regel-Katalog fehlt');
  // Der Check ist ausdrücklich KEINE Sprachprüfung — sonst doppelt er das Lektorat.
  assert.ok(/Sprachliche Mängel.*NICHT hierher/s.test(p), 'Abgrenzung zum Lektorat fehlt');
  // Und er darf nichts erfinden: eine fehlende Angabe IST der Befund.
  assert.ok(/Erfinde keine Angaben/.test(p), 'Erfindungs-Verbot fehlt');

  // Schema-Enum und die im Prompt genannten Status müssen identisch sein.
  const schema = prompts.buildStrukturSchema();
  assert.deepEqual(schema.properties.regeln.items.properties.status.enum,
    ['erfuellt', 'teilweise', 'fehlt', 'nicht_anwendbar']);
  assert.deepEqual(schema.properties.gesamturteil.enum,
    ['traegt', 'lueckenhaft', 'verfehlt']);
});

test('Struktur-Befund wird auf den Katalog normalisiert (keine Lücken, keine Geister)', () => {
  const { _normalizeResult } = require(path.join(ROOT, 'routes/jobs/struktur.js'));
  const regelnCount = ts.textsorte('nachricht').regeln.length;
  const out = _normalizeResult({
    gesamturteil: 'lueckenhaft',
    regeln: [
      { nr: 2, status: 'fehlt', befund: 'Kein Zeitbezug.', massnahme: 'Datum ergänzen.' },
      { nr: 2, status: 'erfuellt', befund: 'Duplikat' },          // zweite Nennung fällt weg
      { nr: 99, status: 'fehlt', befund: 'Regel gibt es nicht' },  // ausserhalb des Katalogs
      { nr: 1, status: 'erfuellt', befund: 'Lead sitzt.', massnahme: 'trotzdem was tun' },
    ],
    fehlendeWFragen: ['wann', 'wann', 'quatsch'],
  }, regelnCount);

  assert.equal(out.regeln.length, regelnCount, 'jede Katalog-Regel braucht eine Zeile');
  assert.deepEqual(out.regeln.map(r => r.nr), Array.from({ length: regelnCount }, (_, i) => i + 1));
  assert.equal(out.regeln[1].status, 'fehlt');
  assert.equal(out.regeln[1].massnahme, 'Datum ergänzen.');
  // Massnahme nur, wo etwas zu tun ist — sonst schleppt die Karte
  // Handlungsanweisungen zu erfüllten Regeln mit.
  assert.equal(out.regeln[0].massnahme, '');
  // Nicht gelieferte Regeln gelten als nicht anwendbar, nicht als erfüllt.
  assert.equal(out.regeln[2].status, 'nicht_anwendbar');
  assert.deepEqual(out.fehlendeWFragen, ['wann']);
});

test('fehlendes Gesamturteil wird abgeleitet, nicht auf «trägt» geraten', () => {
  const { _normalizeResult } = require(path.join(ROOT, 'routes/jobs/struktur.js'));
  const mitLuecke = _normalizeResult({ regeln: [{ nr: 1, status: 'fehlt', befund: 'x' }] }, 2);
  assert.equal(mitLuecke.gesamturteil, 'lueckenhaft');
  const ohneLuecke = _normalizeResult({ regeln: [{ nr: 1, status: 'erfuellt', befund: 'x' }] }, 1);
  assert.equal(ohneLuecke.gesamturteil, 'traegt');
});
