// Tabellen-Kette: die BEWUSSTEN Selektor-Kopien und die Schicht-Entscheidungen.
//
// Warum die Kopien existieren — dieselbe Begruendung wie bei mermaid-drift und
// cite-guard-drift: lib/html-text.js ist parserfrei und arbeitet mit einer
// Regex; public/js/tts-segment.js muss pre-auth ladbar bleiben (der Share-Reader
// importiert es) und darf nichts aus dem App-Bundle ziehen; das
// LanguageTool-Mapping haelt sich generell frei von Bundle-Importen.
//
// Sie duerfen existieren — aber nicht driften.
//
// Der zweite, wichtigere Teil dieser Datei sind die ENTSCHEIDUNGEN pro Schicht.
// Eine Tabelle ist nicht wie ein Diagramm „ueberall weg": ihr Inhalt ist Text
// des Autors. Wer eine Schicht anfasst, muss hier sehen, was dort gilt und
// warum.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';

import { TABLE_SEL } from '../../public/js/table/table-html.js';
import { TTS_SKIP_BLOCK_SEL, isTtsSkippedBlock, ttsBlockText } from '../../public/js/tts-segment.js';
import { stripTableBlocks as stripBrowser, htmlToPlainText as plainBrowser } from '../../public/js/html-text.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

const { htmlToPlainText, stripTableBlocks, summarizeTableBlocks } = await import(
  resolve(ROOT, 'lib/html-text.js').replace(/^/, 'file://')
).then(m => m.default || m);

const TABLE = '<table><caption>Umsatz nach Jahr</caption>'
  + '<thead><tr><th scope="col">Jahr</th><th scope="col">Umsatz</th></tr></thead>'
  + '<tbody><tr><td>2023</td><td>1.2 Mio</td></tr></tbody></table>';

function root(html) {
  const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body></html>`);
  return document.getElementById('r');
}

// ── Die Kopien ──────────────────────────────────────────────────────────────

test('TTS_SKIP_BLOCK_SEL enthaelt den Tabellen-Selektor', () => {
  assert.ok(TTS_SKIP_BLOCK_SEL.split(',').map(s => s.trim()).includes(TABLE_SEL),
    `TTS_SKIP_BLOCK_SEL (${TTS_SKIP_BLOCK_SEL}) muss ${TABLE_SEL} fuehren`);
});

test('das LanguageTool-Mapping schneidet Tabellen', () => {
  const src = read('public/js/cards/editor-spellcheck/mapping.js');
  assert.match(src, /TABLE_SKIP_SEL\s*=\s*'table'/,
    'mapping.js muss den Tabellen-Selektor als bewusste Kopie fuehren');
  assert.match(src, /_isSkippedIsland[\s\S]{0,400}TABLE_SKIP_SEL/,
    'der Selektor muss in _isSkippedIsland ausgewertet werden, nicht bloss dastehen');
});

test('mapping.js zieht weiterhin nichts aus dem App-Bundle', () => {
  const src = read('public/js/cards/editor-spellcheck/mapping.js');
  assert.ok(!/from\s+['"].*table\/table-html/.test(src),
    'der Import waere der bequeme Weg — und macht das Modul unbrauchbar fuer den pre-auth-Pfad');
});

test('tts-segment.js zieht nichts aus dem App-Bundle', () => {
  const src = read('public/js/tts-segment.js');
  assert.ok(!/from\s+['"].*table\/table-html/.test(src));
});

test('die beiden html-text-Zwillinge tragen dieselbe Tabellen-Regex', () => {
  const server = read('lib/html-text.js');
  const browser = read('public/js/html-text.js');
  const re = /_TABLE_BLOCK_RE\s*=\s*(\/[^\n]+\/[gimsuy]*)/;
  const a = server.match(re)?.[1];
  const b = browser.match(re)?.[1];
  assert.ok(a, 'lib/html-text.js braucht _TABLE_BLOCK_RE');
  assert.equal(b, a, 'Frontend- und Server-Regex muessen zeichengleich sein');
});

test('Server- und Browser-Variante schneiden identisch', () => {
  const html = `<p>vor</p>${TABLE}<p>nach</p>`;
  assert.equal(stripTableBlocks(html), stripBrowser(html));
  assert.equal(htmlToPlainText(html), plainBrowser(html));
});

// ── Die Entscheidungen pro Schicht ──────────────────────────────────────────

test('Umfang: Tabellenzellen ZAEHLEN in htmlToPlainText (page_stats, Suche)', () => {
  const text = htmlToPlainText(`<p>vor</p>${TABLE}`);
  assert.match(text, /2023/, 'wer eine Tabelle schreibt, hat geschrieben — der Umfang zaehlt sie');
  assert.match(text, /1\.2 Mio/);
  assert.match(text, /Umsatz nach Jahr/, 'die Beschriftung ist Prosa des Autors');
});

test('Prosa-Masse: stripTableBlocks nimmt den ganzen Block', () => {
  const out = stripTableBlocks(`<p>vor</p>${TABLE}<p>nach</p>`);
  assert.ok(!/2023/.test(out));
  assert.ok(!/<table/.test(out));
  assert.match(out, /vor/);
  assert.match(out, /nach/, 'nur die Tabelle faellt, nicht der Text danach');
});

test('Wortschatz-Analyse laeuft ueber stripTableBlocks', () => {
  const src = read('lib/lexicon/analyze.js');
  assert.match(src, /stripTableBlocks/,
    'ohne den Ausschnitt liefert eine Zahlenspalte „2023" als Lieblingswort');
});

test('Stil-Metriken laufen auf dem Prosatext, Figuren-Erwaehnungen auf dem Volltext', () => {
  const src = read('routes/sync.js');
  assert.match(src, /styleText\s*=\s*htmlToText\(stripTableBlocks\(/,
    'computePageIndex braucht den Text ohne Tabellen');
  assert.match(src, /computePageIndex\(styleText/);
  assert.match(src, /indexItems\.push\(\{[^}]*fullText/,
    'Figuren-Erwaehnungen bleiben auf dem Volltext — eine in einer Zelle genannte Figur ist genannt');
});

test('Prompt: Tabelle wird verdichtet, nicht geschnitten', () => {
  const out = summarizeTableBlocks(TABLE);
  assert.match(out, /\[Tabelle 2×2/, 'Dimension gehoert in die Kurzform');
  assert.match(out, /Kopf: Jahr \| Umsatz/, 'der Kopf ist die Aussage der Tabelle in einer Zeile');
  assert.match(out, /Umsatz nach Jahr/, 'die Beschriftung bleibt');
  assert.ok(!/1\.2 Mio/.test(out), 'die Datenzellen kosten Tokens ohne Gegenwert');
});

test('beide Prompt-Textpfade nutzen die Kurzform', () => {
  const src = read('routes/jobs/shared/ai.js');
  assert.match(src, /function htmlToText\(html\)[\s\S]{0,200}summarizeTableBlocks/);
  assert.match(src, /function htmlToTextForPrompt\(html\)[\s\S]{0,200}summarizeTableBlocks/);
});

test('summarizeTableBlocks bleibt bei kaputtem Markup harmlos', () => {
  assert.doesNotThrow(() => summarizeTableBlocks('<table><tr><td>offen'));
  assert.equal(summarizeTableBlocks(''), '');
  assert.equal(summarizeTableBlocks(null), '');
});

// ── TTS ─────────────────────────────────────────────────────────────────────

test('TTS ueberspringt die Tabelle als ganzen Block', () => {
  const r = root(`<p>vor</p>${TABLE}<p>nach</p>`);
  const t = r.querySelector('table');
  assert.equal(isTtsSkippedBlock(t), true);
  assert.equal(isTtsSkippedBlock(r.querySelector('p')), false);
});

test('die Block-Aufzaehlung der Konsumenten laesst die Tabelle liegen', () => {
  // Gespiegelte Konsumenten-Kette: Bloecke aufzaehlen → Skip-Bloecke filtern →
  // Sprech-Text ziehen. `ttsBlockText` filtert NICHT selbst (es liefert den Text
  // des Elements, das man ihm gibt) — der Skip gehoert in die Aufzaehlung, und
  // genau die wird hier geprueft.
  const r = root(`<p>vor</p>${TABLE}<p>nach</p>`);
  const spoken = Array.from(r.children)
    .filter(b => !isTtsSkippedBlock(b))
    .map(b => ttsBlockText(b).trim())
    .filter(Boolean);
  assert.deepEqual(spoken, ['vor', 'nach']);
});

test('beide TTS-Oberflaechen filtern die Skip-Bloecke', () => {
  for (const p of ['public/js/editor/notebook/tts-proof.js', 'public/js/share-reader/tts.js']) {
    assert.match(read(p), /isTtsSkippedBlock\(/,
      `${p} muss die Skip-Bloecke filtern — sonst liest es Zellen vor`);
  }
});

test('der Share-Reader sammelt aus Tabellen keine Sprech-Bloecke', () => {
  const src = read('public/js/share-reader/tts.js');
  const sel = src.match(/READER_BLOCK_SEL\s*=\s*'([^']+)'/)?.[1] || '';
  const parts = sel.split(',').map(s => s.trim());
  for (const forbidden of ['table', 'td', 'th', 'caption']) {
    assert.ok(!parts.includes(forbidden),
      `READER_BLOCK_SEL darf ${forbidden} nicht fuehren — sonst liest der Reader Zellen vor`);
  }
});
