// Diagramm-Kette: SSoT-Verhalten plus die vier BEWUSSTEN Selektor-Kopien.
//
// Warum die Kopien existieren: der Share-Reader und die pre-auth ladbaren
// Module (tts-segment.js) duerfen nichts aus dem App-Bundle importieren, sonst
// bekommt der anonyme Leser vom Auth-Guard HTML statt JavaScript. lib/html-text.js
// ist bewusst parserfrei und arbeitet mit einer Regex. Und das LanguageTool-
// Mapping haelt sich generell frei von Bundle-Importen (siehe cite-guard-drift).
//
// Sie duerfen deshalb existieren — aber nicht driften. Genau das prueft diese
// Datei.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';

import {
  DIAGRAM_CLASS, DIAGRAM_SEL, buildDiagramHtml, collectDiagrams,
  diagramCode, isDiagramEl, closestDiagramEl, markDiagramsAtomic, diagramKey,
} from '../../public/js/diagram/mermaid-html.js';
import { TTS_SKIP_BLOCK_SEL, isTtsSkippedBlock } from '../../public/js/tts-segment.js';
import { htmlToPlainText } from '../../public/js/html-text.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function root(html) {
  const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body></html>`);
  return document.getElementById('r');
}

// ── SSoT-Verhalten ───────────────────────────────────────────────────────────

test('buildDiagramHtml escapet den Quelltext', () => {
  const html = buildDiagramHtml('graph TD\n  A["<b>fett</b>"] --> B');
  assert.ok(html.includes('&lt;b&gt;'), 'rohes Markup im Quelltext muss escaped werden');
  assert.ok(!html.includes('<b>'));
  assert.ok(html.startsWith(`<pre class="${DIAGRAM_CLASS}">`));
});

test('diagramCode liest den Quelltext verlustfrei zurueck', () => {
  const code = 'flowchart LR\n  A["a & b"] --> B';
  const el = root(buildDiagramHtml(code)).querySelector(DIAGRAM_SEL);
  assert.equal(diagramCode(el), code);
});

test('collectDiagrams uebergeht leere Bloecke', () => {
  const r = root(`${buildDiagramHtml('graph TD; A-->B')}<pre class="mermaid">   </pre><pre>kein Diagramm</pre>`);
  const found = collectDiagrams(r);
  assert.equal(found.length, 1);
  assert.equal(found[0].code, 'graph TD; A-->B');
});

test('isDiagramEl trennt Diagramm von gewoehnlichem Codeblock', () => {
  const r = root('<pre class="mermaid">x</pre><pre>y</pre><div class="mermaid">z</div>');
  const [a, b] = r.querySelectorAll('pre');
  assert.equal(isDiagramEl(a), true);
  assert.equal(isDiagramEl(b), false);
  assert.equal(isDiagramEl(r.querySelector('div')), false, 'nur <pre> traegt ein Diagramm');
});

test('closestDiagramEl findet den Block vom Kindknoten aus', () => {
  const r = root(buildDiagramHtml('graph TD; A-->B'));
  const pre = r.querySelector(DIAGRAM_SEL);
  assert.equal(closestDiagramEl(pre.firstChild, r), pre);
  assert.equal(closestDiagramEl(r, r), null);
});

test('markDiagramsAtomic setzt nur Laufzeit-Attribute', () => {
  const r = root(buildDiagramHtml('graph TD; A-->B'));
  markDiagramsAtomic(r);
  const pre = r.querySelector(DIAGRAM_SEL);
  assert.equal(pre.getAttribute('contenteditable'), 'false');
  assert.equal(pre.getAttribute('class'), DIAGRAM_CLASS, 'die Klasse bleibt unveraendert');
});

test('diagramKey ist stabil und unterscheidet', () => {
  assert.equal(diagramKey('graph TD; A-->B'), diagramKey('graph TD; A-->B'));
  assert.notEqual(diagramKey('graph TD; A-->B'), diagramKey('graph TD; A-->C'));
});

// ── Bewusste Kopien gegen die SSoT ───────────────────────────────────────────

test('TTS ueberspringt Quelltext-Block UND Render-Knoten', () => {
  assert.ok(TTS_SKIP_BLOCK_SEL.includes(DIAGRAM_SEL),
    `TTS_SKIP_BLOCK_SEL ("${TTS_SKIP_BLOCK_SEL}") muss ${DIAGRAM_SEL} enthalten`);
  assert.ok(TTS_SKIP_BLOCK_SEL.includes('.mermaid-render'),
    'der zur Laufzeit eingefuegte Render-Knoten muss ebenfalls uebersprungen werden');

  const r = root(`${buildDiagramHtml('graph TD; A-->B')}<div class="mermaid-render"><svg></svg></div><p>Prosa.</p>`);
  const kinds = [...r.children].map(isTtsSkippedBlock);
  assert.deepEqual(kinds, [true, true, false]);
});

test('LanguageTool-Mapping traegt denselben Diagramm-Selektor', () => {
  const src = readFileSync(
    resolve(ROOT, 'public', 'js', 'cards', 'editor-spellcheck', 'mapping.js'), 'utf8');
  const m = /DIAGRAM_SKIP_SEL\s*=\s*'([^']+)'/.exec(src);
  assert.ok(m, 'DIAGRAM_SKIP_SEL in mapping.js nicht gefunden');
  assert.equal(m[1], DIAGRAM_SEL);
});

test('Share-Reader-Kopie nutzt denselben Selektor und importiert nichts aus dem App-Bundle', () => {
  const src = readFileSync(resolve(ROOT, 'public', 'js', 'share-reader', 'diagrams.js'), 'utf8');
  const m = /DIAGRAM_SEL\s*=\s*'([^']+)'/.exec(src);
  assert.ok(m, 'DIAGRAM_SEL in share-reader/diagrams.js nicht gefunden');
  assert.equal(m[1], DIAGRAM_SEL);

  for (const imp of [...src.matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)].map(x => x[1])) {
    assert.ok(imp.startsWith('./'),
      `Reader-Modul darf nur aus /js/share-reader/ importieren, gefunden: ${imp}`);
  }
});

test('Share-Reader referenziert dieselbe Vendor-Datei, die server.js pre-auth freigibt', () => {
  const reader = readFileSync(resolve(ROOT, 'public', 'js', 'share-reader', 'diagrams.js'), 'utf8');
  const m = /VENDOR_SRC\s*=\s*'([^']+)'/.exec(reader);
  assert.ok(m, 'VENDOR_SRC nicht gefunden');
  const server = readFileSync(resolve(ROOT, 'server.js'), 'utf8');
  assert.ok(server.includes(`'${m[1]}'`),
    `${m[1]} fehlt in PUBLIC_ASSETS — der anonyme Leser bekaeme Login-HTML statt der Lib`);

  const lazy = readFileSync(resolve(ROOT, 'public', 'js', 'lazy-libs.js'), 'utf8');
  assert.ok(lazy.includes(m[1].replace(/^\//, '')),
    'App-Loader und Reader muessen dieselbe mermaid-Version laden');
});

test('htmlToPlainText schneidet Diagramm-Quelltext aus den Textstatistiken', () => {
  const html = `<p>Davor.</p>${buildDiagramHtml('flowchart TD\n  A[Ausgangslage] --> B')}<p>Danach.</p>`;
  assert.equal(htmlToPlainText(html), 'Davor. Danach.');
});

test('htmlToPlainText laesst gewoehnliche Codebloecke stehen', () => {
  assert.equal(htmlToPlainText('<pre>echo hallo</pre>'), 'echo hallo');
});

test('der KI-Prompt-Pfad schneidet Diagramme genauso aus wie die Textstatistik', async () => {
  // Zweite, unabhaengige HTML→Text-Kette (routes/jobs/shared/ai.js): sie haelt
  // Absatzgrenzen als `\n\n` und kann darum nicht htmlToPlainText sein, muss
  // aber denselben Ausschnitt machen. Was sie durchlaesst, kostet Input-Tokens
  // in jedem Job, landet im Embedding-Index (via loadPageContents) und wird vom
  // Lektorat als Prosa gelesen — siehe docs/diagramme.md, Invariante 7.
  process.env.DB_PATH = process.env.DB_PATH
    || resolve('/tmp', `mermaid-drift-${process.pid}-${Date.now()}.db`);
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
  await import('../../db/schema.js');
  const mod = await import('../../routes/jobs/shared/ai.js');
  const { htmlToText, htmlToTextForPrompt } = mod.default || mod;

  const code = 'flowchart TD\n  A[Ausgangslage] --> B{Entscheidung}';
  const html = `<p>Davor.</p>${buildDiagramHtml(code)}<p>Danach.</p>`;

  assert.equal(htmlToText(html), 'Davor. Danach.');

  const prompt = htmlToTextForPrompt(html);
  assert.equal(prompt, 'Davor.\n\nDanach.');
  for (const token of ['flowchart', 'Ausgangslage', '-->']) {
    assert.ok(!prompt.includes(token), `Diagramm-Notation "${token}" darf nicht in den Prompt`);
  }

  // Gewoehnliche Codebloecke bleiben Prosa-Kontext (der Autor hat sie als Inhalt
  // geschrieben, nicht als Notation eines Bildes).
  assert.equal(htmlToText('<pre>echo hallo</pre>'), 'echo hallo');
});

test('stripDiagramBlocks: Server- und Frontend-Kopie bleiben gleichauf', async () => {
  const { stripDiagramBlocks: srv } = await import('../../lib/html-text.js');
  const { stripDiagramBlocks: fe } = await import('../../public/js/html-text.js');
  const cases = [
    `<p>a</p>${buildDiagramHtml('graph TD; A-->B')}<p>b</p>`,
    '<pre class="lang mermaid other">graph TD</pre>rest',
    "<pre class='mermaid'>graph TD</pre>rest",
    '<pre>normal</pre>',
    '',
  ];
  for (const c of cases) {
    assert.equal(srv(c), fe(c), c);
    assert.ok(!srv(c).includes('graph TD;'), 'Diagramm-Quelltext muss weg sein');
  }
});

test('Server- und Frontend-Kopie von htmlToPlainText bleiben gleichauf', async () => {
  const server = (await import('../../lib/html-text.js')).default
    || (await import('../../lib/html-text.js'));
  const { htmlToPlainText: srv } = server;
  const cases = [
    `<p>a</p>${buildDiagramHtml('graph TD; A-->B')}<p>b</p>`,
    '<pre class="lang mermaid other">graph TD</pre>rest',
    "<pre class='mermaid'>graph TD</pre>rest",
    '<pre>normal</pre>',
  ];
  for (const c of cases) assert.equal(srv(c), htmlToPlainText(c), c);
});
