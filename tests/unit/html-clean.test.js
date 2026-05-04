'use strict';
// Unit-Tests für lib/html-clean.js — Server-seitiger Page-HTML-Sanitizer.
// Lauf: `node --test tests/unit/html-clean.test.js`

const test = require('node:test');
const assert = require('node:assert/strict');

const { cleanPageHtml, wrapOrphanBlocks, collapseEmptyBlocks, stripTrailingEmptyBlocks } = require('../../lib/html-clean');

test('collapseEmptyBlocks: leere <p>-Runs auf einen kollabieren', () => {
  assert.equal(
    collapseEmptyBlocks('<p>Hallo</p><p></p><p></p><p>Welt</p>'),
    '<p>Hallo</p><p></p><p>Welt</p>'
  );
});

test('collapseEmptyBlocks: <p><br></p>-Runs kollabieren', () => {
  assert.equal(
    collapseEmptyBlocks('<p>Eins</p><p><br></p><p><br></p><p>Zwei</p>'),
    '<p>Eins</p><p><br></p><p>Zwei</p>'
  );
});

test('collapseEmptyBlocks: <br><br>-Runs auf ein <br>', () => {
  assert.equal(
    collapseEmptyBlocks('<p>foo<br><br><br>bar</p>'),
    '<p>foo<br>bar</p>'
  );
});

test('collapseEmptyBlocks: einzelner Leerblock bleibt (Absatz-Trennung)', () => {
  assert.equal(
    collapseEmptyBlocks('<p>Eins</p><p></p><p>Zwei</p>'),
    '<p>Eins</p><p></p><p>Zwei</p>'
  );
});

test('collapseEmptyBlocks: idempotent', () => {
  const input = '<p>Hallo</p><p></p><p></p><p><br></p><p>Welt</p>';
  const once = collapseEmptyBlocks(input);
  const twice = collapseEmptyBlocks(once);
  assert.equal(once, twice);
});

test('stripTrailingEmptyBlocks: trailing <p></p> raus', () => {
  assert.equal(
    stripTrailingEmptyBlocks('<p>End</p><p></p><p></p>'),
    '<p>End</p>'
  );
});

test('stripTrailingEmptyBlocks: behält Inhalt am Ende', () => {
  assert.equal(
    stripTrailingEmptyBlocks('<p>Mitte</p><p>End</p>'),
    '<p>Mitte</p><p>End</p>'
  );
});

test('cleanPageHtml: kombiniert beide Schritte', () => {
  assert.equal(
    cleanPageHtml('<p>A</p><p></p><p></p><p>B</p><p></p><p></p>'),
    '<p>A</p><p></p><p>B</p>'
  );
});

test('cleanPageHtml: Edge-Cases', () => {
  assert.equal(cleanPageHtml(''), '');
  assert.equal(cleanPageHtml(null), null);
  assert.equal(cleanPageHtml(undefined), undefined);
  assert.equal(cleanPageHtml(42), 42);
});

test('cleanPageHtml: einfacher Inhalt unverändert', () => {
  const html = '<p>Hallo Welt</p>';
  assert.equal(cleanPageHtml(html), html);
});

test('cleanPageHtml: idempotent auch über Trailing+Run-Mix', () => {
  const input = '<p>A</p><p><br></p><p><br></p><p>B</p><p>&nbsp;</p><p></p>';
  const once = cleanPageHtml(input);
  const twice = cleanPageHtml(once);
  assert.equal(once, twice);
});

test('cleanPageHtml: strukturelle Leafs (img/table) werden nicht entfernt', () => {
  const out = cleanPageHtml('<p><img src="x.jpg"></p><p></p><p>Text</p>');
  assert.match(out, /<img[^>]*src="x.jpg"/);
  assert.match(out, /<p>Text<\/p>/);
});

test('wrapOrphanBlocks: bare Text-Run → <p>', () => {
  assert.equal(
    wrapOrphanBlocks('Stefan fand problemlos eine Anstellung.'),
    '<p>Stefan fand problemlos eine Anstellung.</p>'
  );
});

test('wrapOrphanBlocks: bare Text + bestehendes <p> bleiben getrennt', () => {
  assert.equal(
    wrapOrphanBlocks('Vorlauf<p>Block</p>Nachlauf'),
    '<p>Vorlauf</p><p>Block</p><p>Nachlauf</p>'
  );
});

test('wrapOrphanBlocks: inline-Run (<strong>, <em>) wird in <p> verpackt', () => {
  assert.equal(
    wrapOrphanBlocks('Hallo <strong>Welt</strong>!'),
    '<p>Hallo <strong>Welt</strong>!</p>'
  );
});

test('wrapOrphanBlocks: bereits gewrappt → no-op (idempotent)', () => {
  const html = '<p>A</p><p>B</p>';
  assert.equal(wrapOrphanBlocks(html), html);
  assert.equal(wrapOrphanBlocks(wrapOrphanBlocks(html)), html);
});

test('wrapOrphanBlocks: rein leere Whitespace-Runs ergeben kein Phantom-<p>', () => {
  assert.equal(wrapOrphanBlocks('   \n\t  '), '   \n\t  ');
});

test('wrapOrphanBlocks: Heading bleibt eigenständiger Block', () => {
  assert.equal(
    wrapOrphanBlocks('Vorlauf<h2>Titel</h2>'),
    '<p>Vorlauf</p><h2>Titel</h2>'
  );
});

test('cleanPageHtml: heilt Bare-Text-Page wie page 146 (Focus-Editor-Bug)', () => {
  const broken = 'Stefan fand problemlos eine Anstellung bei den SBB-Werkstätten.&nbsp;';
  const out = cleanPageHtml(broken);
  // linkedom re-encoded &nbsp; als &#160; — semantisch identisch (U+00A0).
  assert.match(out, /^<p>Stefan fand problemlos eine Anstellung bei den SBB-Werkstätten\.(?:&nbsp;|&#160;)<\/p>$/);
});
