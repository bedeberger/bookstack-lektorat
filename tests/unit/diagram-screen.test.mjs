// Diagramm-Auflösung fuer den BILDSCHIRM (`mode: 'screen'`) — der Pfad, der die
// SSR-Leseansicht des Share-Links vom 3,4-MB-mermaid-Bundle befreit.
//
// Geprueft wird gegen den Cache, nicht gegen Chromium: `MERMAID_RENDER_DISABLED`
// schaltet den Renderer ab, die Testdaten liegen als Cache-Zeilen. Damit ist der
// Test schnell und deterministisch — und der Miss-Fall (Invariante B: nicht
// renderbar ⇒ Quelltext bleibt stehen) ueberhaupt erst pruefbar.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

process.env.DB_PATH = path.join('/tmp', `diagram-screen-${process.pid}-${Date.now()}.db`);
// Kein Chromium in diesem Test: was nicht im Cache liegt, ist "nicht renderbar".
process.env.MERMAID_RENDER_DISABLED = '1';

await import('../../db/schema.js');
const { putCachedDiagram } = (await import('../../db/mermaid-cache.js')).default
  || await import('../../db/mermaid-cache.js');
const { renderKey, rendererUnavailable } = (await import('../../lib/mermaid-render.js')).default
  || await import('../../lib/mermaid-render.js');
const { resolveDiagramsInHtml } = (await import('../../lib/diagram-export.js')).default
  || await import('../../lib/diagram-export.js');
const { buildDiagramHtml } = await import('../../public/js/diagram/mermaid-html.js');

function seed(code, theme, svg) {
  putCachedDiagram(renderKey(code, theme), theme, { svg, png: null, width: 100, height: 60 });
}

const BOTH = 'flowchart TD\n  A[Anfang] --> B[Ende]';
const LIGHT_ONLY = 'flowchart LR\n  X --> Y';
const MISS = 'flowchart TD\n  Nie[gerendert] --> Nirgends';

seed(BOTH, 'default', '<svg id="hell"></svg>');
seed(BOTH, 'dark', '<svg id="dunkel"></svg>');
seed(LIGHT_ONLY, 'default', '<svg id="nur-hell"></svg>');

test('MERMAID_RENDER_DISABLED meldet den Renderer als nicht verfuegbar', () => {
  // Das ist die Auskunft, an der routes/diagram.js zwischen 503 (Rueckfall auf
  // den Client-Bundle) und 422 (kaputtes Diagramm) unterscheidet.
  assert.equal(rendererUnavailable(), true);
});

test('screen-Modus liefert beide Themes in einem Knoten', async () => {
  const out = await resolveDiagramsInHtml(`<p>Davor.</p>${buildDiagramHtml(BOTH)}<p>Danach.</p>`,
    { mode: 'screen' });

  assert.ok(!out.includes('pre class="mermaid"'), 'der Quelltext-Block ist ersetzt');
  assert.ok(out.includes('class="mermaid-render"'),
    'Wrapper-Klasse muss die der Laufzeit-Variante sein — daran haengen Manuskript-CSS und TTS-Ausschluss');
  assert.ok(out.includes('diagram-theme--light') && out.includes('diagram-theme--dark'),
    'beide Theme-Varianten muessen im Markup stehen');
  assert.ok(out.includes('id="hell"') && out.includes('id="dunkel"'));
  assert.ok(out.includes('<p>Davor.</p>') && out.includes('<p>Danach.</p>'), 'Prosa bleibt unangetastet');
});

test('nur eine Theme-Variante vorhanden: ohne Umschaltung ausliefern', async () => {
  const out = await resolveDiagramsInHtml(buildDiagramHtml(LIGHT_ONLY), { mode: 'screen' });
  assert.ok(out.includes('id="nur-hell"'));
  assert.ok(!out.includes('diagram-theme--'),
    'eine einzelne Variante braucht keine Umschalt-Spans');
});

test('Invariante B: nicht renderbar ⇒ Quelltext bleibt stehen', async () => {
  const html = buildDiagramHtml(MISS);
  const out = await resolveDiagramsInHtml(html, { mode: 'screen' });
  assert.equal(out, html, 'kein Platzhalter, kein Fehlerbild, keine Luecke');
});

test('gemischt: der renderbare Block wird ersetzt, der andere bleibt Quelltext', async () => {
  const out = await resolveDiagramsInHtml(
    `${buildDiagramHtml(BOTH)}${buildDiagramHtml(MISS)}`, { mode: 'screen' });
  assert.ok(out.includes('id="hell"'), 'gecachter Block ist gerendert');
  assert.ok(out.includes('Nie[gerendert]'), 'der andere behaelt seinen Quelltext');
});

test('screen-Modus schreibt nichts in den Quelltext zurueck', async () => {
  // Der Eingabe-String ist unveraendert; das Ergebnis ist eine neue Zeichenkette.
  // Die Regel "der Quelltext ist die Wahrheit" haengt daran, dass diese Schicht
  // rein ableitend ist (docs/diagramme.md).
  const html = buildDiagramHtml(BOTH);
  const before = String(html);
  await resolveDiagramsInHtml(html, { mode: 'screen' });
  assert.equal(html, before);
});

test('die anderen Modi bleiben unberuehrt', async () => {
  const html = buildDiagramHtml(BOTH);
  const svgMode = await resolveDiagramsInHtml(html, { mode: 'svg' });
  assert.ok(svgMode.includes('<figure class="diagram">'), 'svg-Modus bleibt figure');
  assert.ok(!svgMode.includes('diagram-theme--'), 'nur der screen-Modus liefert zwei Themes');

  const codeMode = await resolveDiagramsInHtml(html, { mode: 'code' });
  assert.equal(codeMode, html, 'code-Modus rendert nicht');
});
