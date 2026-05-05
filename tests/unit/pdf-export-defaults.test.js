'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { defaultConfig, validateConfig } = require('../../lib/pdf-export-defaults');

test('defaultConfig liefert vollständigen Schema-Baum', () => {
  const c = defaultConfig();
  assert.equal(c.layout.pageSize, 'A4');
  assert.equal(c.font.body.family, 'Lora');
  assert.equal(c.chapter.pageStructure, 'flatten');
  assert.equal(c.cover.enabled, false);
  assert.equal(c.toc.enabled, true);
  assert.equal(c.pdfa.enabled, true);
});

test('validateConfig clamped Margins auf erlaubten Bereich', () => {
  const c = validateConfig({ layout: { marginsMm: { top: 1000, right: -50, bottom: 25, left: 22 } } });
  assert.equal(c.layout.marginsMm.top, 80);
  assert.equal(c.layout.marginsMm.right, 5);
  assert.equal(c.layout.marginsMm.bottom, 25);
});

test('validateConfig verwirft unbekannte enum-Werte', () => {
  const c = validateConfig({ chapter: { breakBefore: 'bogus', numbering: 'arabic' } });
  assert.equal(c.chapter.breakBefore, 'always');
  assert.equal(c.chapter.numbering, 'arabic');
});

test('validateConfig verwirft Top-Level-Junk', () => {
  const c = validateConfig({ layout: { pageSize: 'A5' }, junkKey: 42, weirdField: 'x' });
  assert.equal(c.layout.pageSize, 'A5');
  assert.equal(c.junkKey, undefined);
  assert.equal(c.weirdField, undefined);
});

test('validateConfig clamped numerische Bereiche bei Schriftgrössen', () => {
  const c = validateConfig({ font: { body: { family: 'Lora', weight: 400, sizePt: 999 } } });
  assert.equal(c.font.body.sizePt, 72);
});

test('validateConfig erhält pageStructure und pageBreakBetweenPages', () => {
  const c = validateConfig({ chapter: { pageStructure: 'nested', pageBreakBetweenPages: true } });
  assert.equal(c.chapter.pageStructure, 'nested');
  assert.equal(c.chapter.pageBreakBetweenPages, true);
});
