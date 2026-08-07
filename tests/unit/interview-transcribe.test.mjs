// Interview-Transkription: die reinen Teile.
//
// Geprüft wird, was ohne Backend entscheidbar ist — Normalisierung der
// Upstream-Antwort, das Zusammenfassen zu Redebeiträgen, die Zeitmarke und der
// Volltext, der als `doc_text` am Fundstück landet. Der Netz-Aufruf selbst
// (`transcribeAudio`) hat hier bewusst keinen Test: er wäre ein Test des Mocks.
//
// Dazu das Drift-Gate über die Zeitmarken-Formatierung: sie existiert zweimal
// (CJS im Server, ESM im Browser), weil beide Seiten dieselbe Marke rendern und
// ein Import über die Modulsysteme hinweg nicht geht.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const require = createRequire(import.meta.url);

const lib = require(path.join(ROOT, 'lib/interview-transcribe.js'));
const {
  normalizeSegments, mergeBySpeaker, formatTimecode, transcriptToText, extForMime,
} = lib;
const browser = await import(pathToFileURL(path.join(ROOT, 'public/js/interview/timecode.js')).href);

// ── Drift ────────────────────────────────────────────────────────────────────

test('Server und Browser formatieren dieselbe Zeitmarke', () => {
  // Wertetabelle statt Stichprobe: der Übergang bei 60 und 3600 Sekunden ist die
  // Stelle, an der zwei Implementierungen auseinanderlaufen.
  for (const s of [0, 1, 59, 60, 61, 599, 600, 3599, 3600, 3601, 3661, 7325.9]) {
    assert.equal(formatTimecode(s), browser.formatTimecode(s), `bei ${s}s`);
  }
  assert.equal(formatTimecode(0), '0:00');
  assert.equal(formatTimecode(65), '1:05');
  assert.equal(formatTimecode(3661), '1:01:01');
  // Unsinn wird nicht zu NaN:NaN — im Transkript stünde das an jeder Zeile.
  for (const bad of [null, undefined, -5, 'x', NaN]) {
    assert.equal(formatTimecode(bad), '0:00', String(bad));
    assert.equal(browser.formatTimecode(bad), '0:00', String(bad));
  }
});

test('Sprechername: Zuordnung des Nutzers vor rohem Schlüssel', () => {
  const speakers = { SPEAKER_00: { label: 'Maria Keller' }, SPEAKER_01: { label: null } };
  assert.equal(browser.speakerLabel(speakers, 'SPEAKER_00'), 'Maria Keller');
  // Ohne Zuordnung bleibt der Schlüssel stehen — kein erfundenes „Sprecher 2".
  assert.equal(browser.speakerLabel(speakers, 'SPEAKER_01'), 'SPEAKER_01');
  assert.equal(browser.speakerLabel({}, 'SPEAKER_09'), 'SPEAKER_09');
  assert.equal(browser.speakerLabel({}, null), '');
});

// ── Normalisierung ───────────────────────────────────────────────────────────

test('normalizeSegments trimmt, verwirft Leeres und nummeriert lückenlos', () => {
  const out = normalizeSegments([
    { start: 0, end: 2, text: '  Guten   Tag. ' },
    { start: 2, end: 3, text: '   ' },
    { start: 3, end: 5, text: 'Wie geht es?', speaker: 'SPEAKER_01' },
    null,
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(s => s.idx), [0, 1]);
  assert.equal(out[0].text, 'Guten Tag.');
  assert.equal(out[0].speaker, null);
  assert.equal(out[1].speaker, 'SPEAKER_01');
});

test('unbrauchbare Zeitmarken werden null, nicht NaN', () => {
  const out = normalizeSegments([{ start: 'x', end: null, text: 'Hallo' }]);
  assert.equal(out[0].start_s, null);
  assert.equal(out[0].end_s, null);
});

test('normalizeSegments verträgt fehlende/kaputte Eingaben', () => {
  for (const bad of [null, undefined, {}, 'nein', 42]) {
    assert.deepEqual(normalizeSegments(bad), [], String(bad));
  }
});

// ── Redebeiträge ─────────────────────────────────────────────────────────────

test('aufeinanderfolgende Schnipsel derselben Stimme werden ein Redebeitrag', () => {
  // Whisper schneidet alle paar Sekunden; ohne das Zusammenfassen zerfällt ein
  // Interview in hunderte Fragmente, die man weder liest noch zitiert.
  const merged = mergeBySpeaker(normalizeSegments([
    { start: 0, end: 3, text: 'Wir haben lange', speaker: 'A' },
    { start: 3, end: 6, text: 'darüber gesprochen.', speaker: 'A' },
    { start: 6, end: 9, text: 'Und was folgt daraus?', speaker: 'B' },
  ]));
  assert.equal(merged.length, 2);
  assert.equal(merged[0].text, 'Wir haben lange darüber gesprochen.');
  // Die Zeitmarke des Beitrags spannt vom ersten bis zum letzten Schnipsel —
  // sonst führte der Rückbezug auf die Aufnahme an die falsche Stelle.
  assert.equal(merged[0].start_s, 0);
  assert.equal(merged[0].end_s, 6);
  assert.deepEqual(merged.map(s => s.idx), [0, 1]);
});

test('ein Sprecherwechsel trennt immer, auch bei kurzen Beiträgen', () => {
  const merged = mergeBySpeaker(normalizeSegments([
    { start: 0, end: 1, text: 'Ja.', speaker: 'A' },
    { start: 1, end: 2, text: 'Nein.', speaker: 'B' },
    { start: 2, end: 3, text: 'Doch.', speaker: 'A' },
  ]));
  assert.equal(merged.length, 3);
});

test('ein Monolog wird gedeckelt statt zu einem unzitierbaren Block', () => {
  const parts = Array.from({ length: 12 }, (_, i) => ({
    start: i, end: i + 1, text: `Satz ${i} ` + 'x'.repeat(100), speaker: 'A',
  }));
  const merged = mergeBySpeaker(normalizeSegments(parts), { maxChars: 300 });
  assert.ok(merged.length > 1, 'Deckel greift nicht');
  for (const m of merged) assert.ok(m.text.length <= 300 + 120, 'Block deutlich über dem Deckel');
});

test('ohne Sprechertrennung bleibt die Reihenfolge, nichts wird erfunden', () => {
  const merged = mergeBySpeaker(normalizeSegments([
    { start: 0, end: 3, text: 'Erster Teil.' },
    { start: 3, end: 6, text: 'Zweiter Teil.' },
  ]));
  // Beide haben speaker=null → gelten als dieselbe Stimme und werden
  // zusammengefasst. Ein geratener Sprecherwechsel an der Sprechpause wäre eine
  // Falschzuschreibung.
  assert.equal(merged.length, 1);
  assert.equal(merged[0].speaker, null);
});

// ── Volltext ─────────────────────────────────────────────────────────────────

test('Volltext trägt Zeitmarke und Namen — das ist der durchsuchbare Text', () => {
  const segs = mergeBySpeaker(normalizeSegments([
    { start: 0, end: 4, text: 'Die Sanierung beginnt im Herbst.', speaker: 'SPEAKER_00' },
    { start: 65, end: 70, text: 'Das bezweifle ich.', speaker: 'SPEAKER_01' },
  ]));
  const text = transcriptToText(segs, { SPEAKER_00: 'Maria Keller' });
  assert.equal(text.split('\n').length, 2);
  assert.match(text, /^\[0:00\] Maria Keller: Die Sanierung/);
  // Ohne Zuordnung steht der rohe Schlüssel da — sichtbar unbenannt.
  assert.match(text, /\[1:05\] SPEAKER_01: Das bezweifle ich\./);
});

test('Volltext ohne Sprecher und ohne Zeitmarke bleibt lesbarer Text', () => {
  const text = transcriptToText([{ idx: 0, start_s: null, end_s: null, speaker: null, text: 'Nur Text.' }], {});
  assert.equal(text, 'Nur Text.');
});

// ── Format-Whitelist ─────────────────────────────────────────────────────────

test('Audio-Whitelist erkennt gängige Aufnahmeformate, verwirft Fremdes', () => {
  for (const m of ['audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/x-m4a', 'audio/ogg',
    'audio/flac', 'video/mp4']) {
    assert.ok(extForMime(m), m);
  }
  // Codec-Parameter am Content-Type dürfen die Erkennung nicht kippen.
  assert.equal(extForMime('audio/webm;codecs=opus'), 'webm');
  for (const m of ['application/pdf', 'text/plain', '', null, 'image/png']) {
    assert.equal(extForMime(m), null, String(m));
  }
});
