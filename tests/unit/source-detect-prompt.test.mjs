// Quellen-Erkennung (public/js/prompts/sources.js): der Prompt-Vertrag.
//
// Der wichtigste Test ist der erste: das Schema darf KEIN Metadaten-Feld
// tragen. Die Trennung „Modell extrahiert, Register recherchiert" ist die
// Existenzberechtigung des Features — ein Sprachmodell, das nach einer ISBN
// gefragt wird, liefert eine, und sie waere erfunden.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const {
  buildSourceDetectSystemPrompt, buildSourceDetectPrompt,
  SCHEMA_SOURCE_DETECT, SOURCE_DETECT_TYPES,
} = await import('../../public/js/prompts.js');

const require = createRequire(import.meta.url);
const { CSL_TYPES } = require('../../db/sources.js');

const werkProps = SCHEMA_SOURCE_DETECT.properties.werke.items.properties;

test('das Schema kennt keine Metadaten-Felder', () => {
  for (const verboten of ['isbn', 'doi', 'issn', 'verlag', 'publisher', 'ort', 'place', 'url']) {
    assert.ok(!(verboten in werkProps), `Schema traegt "${verboten}" — das erfindet das Modell`);
  }
  assert.deepEqual(Object.keys(werkProps).sort(),
    ['autoren', 'container', 'erwaehnung', 'jahr', 'titel', 'typ']);
  assert.equal(SCHEMA_SOURCE_DETECT.properties.werke.items.additionalProperties, false);
});

test('jeder Modell-Typ bildet auf einen echten csl_type ab', () => {
  for (const [modellTyp, cslType] of Object.entries(SOURCE_DETECT_TYPES)) {
    assert.ok(CSL_TYPES.includes(cslType), `${modellTyp} → ${cslType} steht nicht in CSL_TYPES`);
  }
  // Prompt-Enum und Schema-Enum muessen dieselbe Liste sein, sonst erzwingt
  // Constrained Decoding bei lokalen Providern Werte, die der Prompt verbietet.
  assert.deepEqual(werkProps.typ.enum.sort(), Object.keys(SOURCE_DETECT_TYPES).sort());
  const prompt = buildSourceDetectPrompt('Text.', [], '', null);
  for (const t of Object.keys(SOURCE_DETECT_TYPES)) assert.ok(prompt.includes(t), `Typ ${t} fehlt im Prompt`);
});

test('der Systemprompt verbietet das Ergaenzen fehlender Angaben', () => {
  const sys = buildSourceDetectSystemPrompt();
  assert.match(sys, /ergaenzt keine Verlage/);
  assert.match(sys, /ISBN\/DOI/);
});

test('erzaehlender Buchtyp bekommt die Warnung vor erfundenen Werken', () => {
  const roman = buildSourceDetectPrompt('Text.', [], '', 'roman');
  assert.match(roman, /erzaehlender Text/);
  assert.match(roman, /erzaehlten Welt/);
  // Der Sachtext-Block darf dort NICHT stehen (und umgekehrt).
  assert.ok(!roman.includes('EIGENE Arbeit'));

  const diss = buildSourceDetectPrompt('Text.', [], '', 'wissenschaft');
  assert.match(diss, /EIGENE Arbeit/);
  assert.ok(!diss.includes('erzaehlender Text'));
});

test('ohne Buchtyp gilt das narrative Profil — die vorsichtigere Lesart', () => {
  assert.match(buildSourceDetectPrompt('Text.', [], '', null), /erzaehlender Text/);
});

test('bekannte Titel stehen als Nicht-wiederholen-Liste im Prompt', () => {
  const p = buildSourceDetectPrompt('Text.', ['Die Struktur wissenschaftlicher Revolutionen'], '', 'sachbuch');
  assert.match(p, /BEREITS IN DER BIBLIOTHEK/);
  assert.ok(p.includes('- Die Struktur wissenschaftlicher Revolutionen'));

  const leer = buildSourceDetectPrompt('Text.', [], '', 'sachbuch');
  assert.ok(leer.includes('(noch keine)'));
});

test('Buch-Kontext erscheint nur, wenn es einen gibt', () => {
  assert.ok(!buildSourceDetectPrompt('Text.', [], '   ', 'sachbuch').includes('BUCH-KONTEXT'));
  assert.match(buildSourceDetectPrompt('Text.', [], 'Eine Studie zur Alpenwirtschaft.', 'sachbuch'),
    /BUCH-KONTEXT:\nEine Studie zur Alpenwirtschaft\./);
});

test('das leere Ergebnis wird ausdruecklich erlaubt', () => {
  // Ohne diesen Satz erfindet ein Modell lieber etwas, als nichts zu liefern.
  assert.match(buildSourceDetectPrompt('Text.', [], '', 'sachbuch'), /leeres Ergebnis ist ein gueltiges Ergebnis/);
});
