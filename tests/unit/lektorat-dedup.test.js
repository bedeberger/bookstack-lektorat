'use strict';
// Tests fuer dedupFehler aus routes/jobs/lektorat.js.
//
// AI-Output (insb. lokale Modelle) enthaelt gelegentlich byte-gleiche
// Duplikate desselben Findings — typisch bei mehrfachem Vorkommen eines
// fehlerhaften Tokens. Da `original` fuer Replace-Logik als Match-String
// dient, reicht ein Eintrag; Duplikate muellen die Findings-Liste zu.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

// Temp-DB, damit das Laden von lektorat.js (→ db/schema.js) keine Live-DB anfasst.
process.env.DB_PATH = path.join(os.tmpdir(), `schreibwerkstatt-lektorat-dedup-${process.pid}-${Date.now()}.db`);
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
require('../../db/migrations');

const { dedupFehler, validateLektoratFehler, capStylisticFehler, STYLISTIC_TYPEN } = require('../../routes/jobs/lektorat');

// validateLektoratFehler filtert gegen das Typ-Set des Buchtyp-Profils (SSoT:
// public/js/prompts/lektorat-typen.js, ESM — hier nicht importierbar, weil diese
// Suite CJS ist; die Uebereinstimmung Profil <-> Server gated
// tests/unit/lektorat-typen-drift.test.mjs). Die Tests hier pruefen die UEBRIGEN
// Filter, darum ein Set, das die verwendeten Typen deckt.
const NARRATIV = new Set(['rechtschreibung', 'grammatik', 'stil', 'show_vs_tell', 'hedging']);

test('dedupFehler entfernt byte-gleiche Duplikate (gleicher typ+original+korrektur)', () => {
  const input = [
    { typ: 'rechtschreibung', original: 'warscheinlich', korrektur: 'wahrscheinlich', kontext: 'irgendwas', erklaerung: 'Tippfehler' },
    { typ: 'rechtschreibung', original: 'warscheinlich', korrektur: 'wahrscheinlich', kontext: 'irgendwas', erklaerung: 'Tippfehler' },
    { typ: 'grammatik', original: 'Plöztlich', korrektur: 'Plötzlich', kontext: 'Plöztlich fror ich', erklaerung: 'Tippfehler' },
  ];
  const out = dedupFehler(input);
  assert.equal(out.length, 2);
  assert.equal(out[0].original, 'warscheinlich');
  assert.equal(out[1].original, 'Plöztlich');
});

test('dedupFehler behaelt unterschiedliche Korrekturen fuer gleiches Original', () => {
  const input = [
    { typ: 'stil', original: 'einfach', korrektur: 'simpel', kontext: 'a', erklaerung: 'x' },
    { typ: 'stil', original: 'einfach', korrektur: 'klar', kontext: 'b', erklaerung: 'y' },
  ];
  assert.equal(dedupFehler(input).length, 2);
});

test('dedupFehler unterscheidet typen', () => {
  const input = [
    { typ: 'rechtschreibung', original: 'foo', korrektur: 'bar' },
    { typ: 'grammatik',       original: 'foo', korrektur: 'bar' },
  ];
  assert.equal(dedupFehler(input).length, 2);
});

test('dedupFehler haelt leeres/null-Korrektur-Feld stabil', () => {
  const input = [
    { typ: 'stil', original: 'foo' },
    { typ: 'stil', original: 'foo' },
    { typ: 'stil', original: 'foo', korrektur: null },
  ];
  // null/undefined kollabieren beide auf '' im Key → alle drei sind Duplikate.
  assert.equal(dedupFehler(input).length, 1);
});

test('validateLektoratFehler strippt Legacy-Feld `kontext` (PROMPTS_VERSION 16: Feld entfernt)', () => {
  const input = [
    { typ: 'rechtschreibung', original: 'foo', korrektur: 'bar', kontext: 'halluzinierter Satz', erklaerung: 'x' },
  ];
  const out = validateLektoratFehler(input, 'de-CH', NARRATIV);
  assert.equal(out.length, 1);
  assert.equal('kontext' in out[0], false, 'kontext-Feld muss entfernt sein');
  assert.equal(out[0].original, 'foo');
  assert.equal(out[0].korrektur, 'bar');
});

test('validateLektoratFehler verwirft Selbst-Widerruf-Einträge (DE + EN)', () => {
  const input = [
    // Echter Fehler – bleibt.
    { typ: 'grammatik', original: 'wegen dem Regen', korrektur: 'wegen des Regens', erklaerung: '«wegen» verlangt den Genitiv.' },
    // DE-Selbstwiderruf.
    { typ: 'grammatik', original: 'sassen', korrektur: 'saßen', erklaerung: 'Im Schweizer Kontext akzeptabel, kein Fehler.' },
    // EN-Selbstwiderruf (genau der gemeldete Fall): Modell zieht den Eintrag selbst zurück.
    { typ: 'grammatik', original: 'I laid my phone down', korrektur: 'I lay my phone down',
      erklaerung: '«laid» is in fact correct for transitive use, so this entry is withdrawn.' },
    // Weitere EN-Varianten.
    { typ: 'grammatik', original: 'it buzzed', korrektur: 'it buzzed', erklaerung: 'This is not an error; leave as is.' },
    { typ: 'stil', original: 'she ran fast', korrektur: 'she sprinted', erklaerung: 'No correction needed, the sentence is fine.' },
  ];
  const out = validateLektoratFehler(input, 'en-US', NARRATIV);
  assert.equal(out.length, 1, 'nur der echte Genitiv-Fehler bleibt');
  assert.equal(out[0].original, 'wegen dem Regen');
});

test('dedupFehler behaelt Reihenfolge des ersten Vorkommens', () => {
  const input = [
    { typ: 'stil', original: 'B' },
    { typ: 'stil', original: 'A' },
    { typ: 'stil', original: 'B' },
  ];
  const out = dedupFehler(input);
  assert.equal(out.length, 2);
  assert.equal(out[0].original, 'B');
  assert.equal(out[1].original, 'A');
});

// ── capStylisticFehler: Handler-Backstop zur Prompt-Mengen-Obergrenze ──────────

test('capStylisticFehler kappt stilistische Findings auf cap, unter cap unveraendert', () => {
  const under = Array.from({ length: 5 }, (_, i) => ({ typ: 'stil', original: `s${i}` }));
  assert.equal(capStylisticFehler(under, 20).length, 5, 'unter dem Cap: nichts entfernt');

  const over = Array.from({ length: 30 }, (_, i) => ({ typ: 'fuellwort', original: `f${i}` }));
  const out = capStylisticFehler(over, 20);
  assert.equal(out.length, 20, 'ueber dem Cap: auf 20 gekappt');
  assert.equal(out[0].original, 'f0', 'Reihenfolge erhalten (Textposition)');
  assert.equal(out[19].original, 'f19');
});

test('capStylisticFehler kappt mechanische/objektive Fehler NIE', () => {
  // 40 Rechtschreib- + 40 Grammatik-Fehler dürfen alle bleiben.
  const mech = [
    ...Array.from({ length: 40 }, (_, i) => ({ typ: 'rechtschreibung', original: `r${i}` })),
    ...Array.from({ length: 40 }, (_, i) => ({ typ: 'grammatik', original: `g${i}` })),
  ];
  assert.equal(capStylisticFehler(mech, 20).length, 80, 'objektive Fehler bleiben vollständig');
});

test('capStylisticFehler: Konsistenz-Typen zaehlen nicht als stilistisch', () => {
  // namenskonsistenz/figurenmerkmal/anrede/schauplatzmerkmal + tempuswechsel/perspektivbruch/
  // dialogformat sind objektiv → nicht im Cap.
  const objektiv = ['namenskonsistenz', 'figurenmerkmal', 'anrede', 'schauplatzmerkmal',
    'tempuswechsel', 'perspektivbruch', 'dialogformat']
    .flatMap(typ => Array.from({ length: 10 }, (_, i) => ({ typ, original: `${typ}${i}` })));
  assert.equal(capStylisticFehler(objektiv, 5).length, objektiv.length, 'kein Konsistenz-/Tempus-Finding gekappt');
  // Gegenprobe: keiner dieser Typen ist im STYLISTIC_TYPEN-Set.
  for (const typ of ['namenskonsistenz', 'figurenmerkmal', 'anrede', 'schauplatzmerkmal',
    'tempuswechsel', 'perspektivbruch', 'dialogformat', 'rechtschreibung', 'grammatik']) {
    assert.equal(STYLISTIC_TYPEN.has(typ), false, `${typ} darf nicht stilistisch sein`);
  }
});

test('capStylisticFehler: gemischte Liste – nur stilistische Ueberzahl faellt weg', () => {
  const input = [
    { typ: 'rechtschreibung', original: 'r1' },   // bleibt
    ...Array.from({ length: 25 }, (_, i) => ({ typ: 'stil', original: `s${i}` })),
    { typ: 'grammatik', original: 'g1' },          // bleibt
  ];
  const out = capStylisticFehler(input, 20);
  assert.equal(out.length, 22, '2 objektiv + 20 stilistisch');
  assert.equal(out.filter(f => f.typ === 'stil').length, 20);
  assert.ok(out.some(f => f.typ === 'rechtschreibung') && out.some(f => f.typ === 'grammatik'));
});

test('capStylisticFehler: nicht-Array bleibt unveraendert (defensiv)', () => {
  assert.equal(capStylisticFehler(null), null);
  assert.equal(capStylisticFehler(undefined), undefined);
});

// ── Profil-Filter: nur Typen des Buchtyp-Profils passieren ────────────────────

test('validateLektoratFehler verwirft profilfremde Typen', () => {
  const input = [
    { typ: 'grammatik',   original: 'wegen dem Regen', korrektur: 'wegen des Regens', erklaerung: 'Genitiv.' },
    { typ: 'show_vs_tell', original: 'Er war wuetend.', korrektur: 'Seine Faust traf den Tisch.', erklaerung: 'Telling.' },
    { typ: 'hedging',     original: 'moeglicherweise unter Umstaenden', korrektur: 'moeglicherweise', erklaerung: 'Stapel.' },
  ];
  // Wissenschaftliches Profil: show_vs_tell existiert dort nicht, hedging schon.
  const wissenschaft = new Set(['rechtschreibung', 'grammatik', 'stil', 'hedging']);
  const wiss = validateLektoratFehler(input, 'de-CH', wissenschaft);
  assert.deepEqual(wiss.map(f => f.typ), ['grammatik', 'hedging']);

  // Narratives Profil: umgekehrt – show_vs_tell bleibt, hedging faellt weg.
  const narrativ = new Set(['rechtschreibung', 'grammatik', 'stil', 'show_vs_tell']);
  const nar = validateLektoratFehler(input, 'de-CH', narrativ);
  assert.deepEqual(nar.map(f => f.typ), ['grammatik', 'show_vs_tell']);
});
