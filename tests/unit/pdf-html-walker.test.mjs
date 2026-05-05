import { test } from 'node:test';
import assert from 'node:assert';
import { parseHtmlToBlocks } from '../../lib/pdf-html-walker.js';

test('Heading + Paragraph + Inline-Stil', () => {
  const blocks = parseHtmlToBlocks('<h1>Kapitel 1</h1><p>Text mit <strong>fett</strong> und <em>kursiv</em>.</p>');
  assert.deepEqual(blocks[0], { kind: 'heading', level: 1, text: 'Kapitel 1' });
  assert.equal(blocks[1].kind, 'paragraph');
  const runs = blocks[1].runs;
  assert.equal(runs[0].text, 'Text mit ');
  assert.equal(runs[1].bold, true);
  assert.equal(runs[1].text, 'fett');
  assert.equal(runs[3].italic, true);
});

test('div.poem wird als poem-Block erkannt mit pro-Absatz-Linie', () => {
  const blocks = parseHtmlToBlocks(
    '<div class="poem"><p>Wenn nicht mehr Zahlen und Figuren</p><p>Sind Schlüssel aller Kreaturen</p></div>'
  );
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'poem');
  assert.equal(blocks[0].lines.length, 2);
  assert.equal(blocks[0].lines[0][0].italic, true);
});

test('Listen mit ordered/unordered + verschachtelte Inline-Styles', () => {
  const blocks = parseHtmlToBlocks('<ol><li>Eins</li><li>Zwei mit <em>kursiv</em></li></ol>');
  assert.equal(blocks[0].kind, 'list');
  assert.equal(blocks[0].ordered, true);
  assert.equal(blocks[0].items.length, 2);
});

test('Tabellen werden geskippt aber Inhalt als paragraph fallback', () => {
  const blocks = parseHtmlToBlocks('<table><tr><td>Zelle</td></tr></table>');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'paragraph');
});

test('Links bekommen underline + link', () => {
  const blocks = parseHtmlToBlocks('<p>Siehe <a href="https://x">hier</a>.</p>');
  const link = blocks[0].runs.find(r => r.link);
  assert.equal(link?.link, 'https://x');
  assert.equal(link?.underline, true);
});

test('hr und img werden als eigene Block-Typen erkannt', () => {
  const blocks = parseHtmlToBlocks('<hr><img src="/foo.png" alt="x">');
  assert.equal(blocks[0].kind, 'hr');
  assert.equal(blocks[1].kind, 'image');
  assert.equal(blocks[1].src, '/foo.png');
});
