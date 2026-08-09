// Unit tests for lib/wp-html.js: Gutenberg block strip on import + wrap on export.
//
// `wpToAppHtml` ist async, weil es die Chip-Selektoren aus der ESM-SSoT
// public/js/sources/cite-html.js laedt (statt eine Kopie zu halten) — jeder
// Aufruf hier wird darum awaited.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const { wpToAppHtml, appToWpHtml, appToWpHtmlWithMedia } = await import('../../lib/wp-html.js');

test('wpToAppHtml: strips wp:* comments', async () => {
  const wp = `
<!-- wp:paragraph -->
<p>Hallo Welt.</p>
<!-- /wp:paragraph -->

<!-- wp:heading {"level":2} -->
<h2 class="wp-block-heading">Kapitel 1</h2>
<!-- /wp:heading -->
  `;
  const app = await wpToAppHtml(wp);
  assert.doesNotMatch(app, /wp:/);
  assert.match(app, /<p>Hallo Welt\.<\/p>/);
  assert.match(app, /<h2>Kapitel 1<\/h2>/);
});

test('wpToAppHtml: keeps images/figures, strips non-image embeds', async () => {
  const wp = `<p>vorher</p><figure class="wp-block-image"><img src="https://blog.test/a.jpg" alt="A" srcset="x 2x" width="800"/></figure><iframe src="y"></iframe><p>nachher</p>`;
  const app = await wpToAppHtml(wp);
  assert.match(app, /<img/);
  assert.match(app, /src="https:\/\/blog\.test\/a\.jpg"/);
  assert.match(app, /alt="A"/);
  // fremde img-Attribute (srcset/width) werden gestrippt
  assert.doesNotMatch(app, /srcset/);
  assert.doesNotMatch(app, /width=/);
  assert.doesNotMatch(app, /<iframe/);
  assert.match(app, /vorher/);
  assert.match(app, /nachher/);
});

test('wpToAppHtml: keeps wp-image-<n> class (attachment id) but strips other wp- classes', async () => {
  const wp = `<figure class="wp-block-image size-large"><img class="wp-image-42 has-shadow" src="https://blog.test/a.jpg"/></figure>`;
  const app = await wpToAppHtml(wp);
  assert.match(app, /wp-image-42/);
  assert.doesNotMatch(app, /wp-block-image/);
  assert.doesNotMatch(app, /has-shadow/);
});

test('wpToAppHtml: drops empty figure left over from stripped video', async () => {
  const wp = `<figure class="wp-block-video"><video src="v.mp4"></video></figure><p>text</p>`;
  const app = await wpToAppHtml(wp);
  assert.doesNotMatch(app, /<figure/);
  assert.doesNotMatch(app, /<video/);
  assert.match(app, /text/);
});

test('wpToAppHtml: empty/null returns empty string', async () => {
  assert.equal(await wpToAppHtml(''), '');
  assert.equal(await wpToAppHtml(null), '');
});

test('wpToAppHtml: removes wp-* utility classes', async () => {
  const wp = `<!-- wp:paragraph --><p class="wp-block has-text-color">x</p><!-- /wp:paragraph -->`;
  const app = await wpToAppHtml(wp);
  assert.doesNotMatch(app, /wp-block/);
  assert.doesNotMatch(app, /has-text-color/);
});

test('appToWpHtml: paragraph block', () => {
  const out = appToWpHtml('<p>Hallo Welt.</p>');
  assert.match(out, /<!-- wp:paragraph -->/);
  assert.match(out, /<p>Hallo Welt\.<\/p>/);
  assert.match(out, /<!-- \/wp:paragraph -->/);
});

test('appToWpHtml: h2 heading default level', () => {
  const out = appToWpHtml('<h2>Kapitel 1</h2>');
  assert.match(out, /<!-- wp:heading -->/);
  assert.match(out, /<h2 class="wp-block-heading">Kapitel 1<\/h2>/);
});

test('appToWpHtml: h3 heading level annotated', () => {
  const out = appToWpHtml('<h3>Unterkapitel</h3>');
  assert.match(out, /<!-- wp:heading \{"level":3\} -->/);
  assert.match(out, /<h3 class="wp-block-heading">Unterkapitel<\/h3>/);
});

test('appToWpHtml: unordered list with list-items', () => {
  const out = appToWpHtml('<ul><li>a</li><li>b</li></ul>');
  assert.match(out, /<!-- wp:list -->/);
  assert.match(out, /<!-- wp:list-item -->\n<li>a<\/li>\n<!-- \/wp:list-item -->/);
  assert.match(out, /<!-- wp:list-item -->\n<li>b<\/li>\n<!-- \/wp:list-item -->/);
});

test('appToWpHtml: ordered list flagged', () => {
  const out = appToWpHtml('<ol><li>x</li></ol>');
  assert.match(out, /<!-- wp:list \{"ordered":true\} -->/);
  assert.match(out, /<ol>/);
});

test('appToWpHtml: blockquote', () => {
  const out = appToWpHtml('<blockquote><p>Zitat</p></blockquote>');
  assert.match(out, /<!-- wp:quote -->/);
  assert.match(out, /<blockquote class="wp-block-quote">/);
});

test('appToWpHtml: code block', () => {
  const out = appToWpHtml('<pre>console.log(1)</pre>');
  assert.match(out, /<!-- wp:code -->/);
  assert.match(out, /<pre class="wp-block-code">console\.log\(1\)<\/pre>/);
});

test('Diagramm-Block ueberlebt den Push→Pull-Round-Trip', async () => {
  // `<pre class="mermaid">` ist der persistierte Diagramm-Block (Markup-SSoT
  // public/js/diagram/mermaid-html.js). Der Push muss die Klasse als Gutenberg-
  // `className` mitschicken, sonst kommt vom LWW-Pull ein klassenloses `<pre>`
  // zurueck und macht das Diagramm im Manuskript dauerhaft zum Codeblock.
  const app = '<pre class="mermaid">flowchart TD\n  A[Start] --&gt; B[Ende]</pre>';
  const wp = appToWpHtml(app);
  assert.match(wp, /<!-- wp:code \{"className":"mermaid"\} -->/);
  assert.match(wp, /<pre class="wp-block-code mermaid">/);

  const back = await wpToAppHtml(wp);
  assert.match(back, /<pre class="mermaid">/, 'die Diagramm-Klasse muss den Pull ueberleben');
  assert.doesNotMatch(back, /wp-block-code/, 'WP-Utility-Klassen fliegen raus');
  assert.match(back, /flowchart TD/);
  assert.match(back, /A\[Start\] --&gt; B\[Ende\]/, 'der Quelltext bleibt unveraendert');
});

test('appToWpHtml: hr → separator', () => {
  const out = appToWpHtml('<hr>');
  assert.match(out, /<!-- wp:separator -->/);
  assert.match(out, /<hr class="wp-block-separator has-alpha-channel-opacity"\/>/);
});

test('appToWpHtml: wraps <figure>/<img> as wp:image block', () => {
  const out = appToWpHtml('<p>vor</p><figure><img src="https://blog.test/a.jpg" alt="A"/></figure><p>nach</p>');
  assert.match(out, /<!-- wp:image -->/);
  assert.match(out, /<figure class="wp-block-image size-full"><img src="https:\/\/blog\.test\/a\.jpg" alt="A"\/><\/figure>/);
  assert.match(out, /<!-- \/wp:image -->/);
  assert.match(out, /vor/);
  assert.match(out, /nach/);
});

test('appToWpHtml: wp:image carries attachment id from wp-image-<n> class', () => {
  const out = appToWpHtml('<figure><img class="wp-image-42" src="https://blog.test/a.jpg"/></figure>');
  assert.match(out, /<!-- wp:image \{"id":42,"sizeSlug":"full"\} -->/);
  assert.match(out, /class="wp-image-42"/);
});

test('appToWpHtml: wp:image keeps figcaption', () => {
  const out = appToWpHtml('<figure><img src="https://blog.test/a.jpg"/><figcaption>Bildtitel</figcaption></figure>');
  assert.match(out, /<figcaption class="wp-element-caption">Bildtitel<\/figcaption>/);
});

test('appToWpHtml: still drops video/iframe embeds', () => {
  const out = appToWpHtml('<p>vor</p><video src="v.mp4"></video><iframe src="y"></iframe><p>nach</p>');
  assert.doesNotMatch(out, /<video/);
  assert.doesNotMatch(out, /<iframe/);
  assert.match(out, /vor/);
  assert.match(out, /nach/);
});

test('appToWpHtml: escapes quotes/angle-brackets in img src/alt', () => {
  const out = appToWpHtml('<figure><img src="https://blog.test/a.jpg?x=1&amp;y=2" alt="&quot;q&quot; <b>"/></figure>');
  assert.doesNotMatch(out, /alt="[^"]*"[^/]*"/); // kein ungeschlossenes Attribut durch rohes "
  assert.match(out, /&amp;y=2/);
  assert.match(out, /&quot;q&quot;/);
});

test('appToWpHtmlWithMedia: replaces src via resolver and sets attachment id', async () => {
  const resolveImage = async (src) => {
    assert.equal(src, 'data:image/png;base64,AAAA');
    return { src: 'https://blog.test/uploaded.png', id: 99 };
  };
  const out = await appToWpHtmlWithMedia('<figure><img src="data:image/png;base64,AAAA"/></figure>', { resolveImage });
  assert.match(out, /<!-- wp:image \{"id":99,"sizeSlug":"full"\} -->/);
  assert.match(out, /src="https:\/\/blog\.test\/uploaded\.png"/);
  assert.match(out, /class="wp-image-99"/);
});

test('appToWpHtmlWithMedia: drops image when resolver returns null', async () => {
  const resolveImage = async () => null;
  const out = await appToWpHtmlWithMedia('<p>vor</p><figure><img src="data:image/svg+xml,x"/></figure><p>nach</p>', { resolveImage });
  assert.doesNotMatch(out, /<!-- wp:image/);
  assert.doesNotMatch(out, /<img/);
  assert.match(out, /vor/);
  assert.match(out, /nach/);
});

test('appToWpHtmlWithMedia: keeps blog-hosted src unchanged (resolver echoes)', async () => {
  const resolveImage = async (src) => ({ src, id: null });
  const out = await appToWpHtmlWithMedia('<figure><img src="https://blog.test/a.jpg"/></figure>', { resolveImage });
  assert.match(out, /<!-- wp:image -->/);
  assert.match(out, /src="https:\/\/blog\.test\/a\.jpg"/);
});

test('appToWpHtml: preserves inline formatting inside paragraph', () => {
  const out = appToWpHtml('<p>foo <strong>bold</strong> <em>i</em> <a href="https://x">link</a></p>');
  assert.match(out, /<strong>bold<\/strong>/);
  assert.match(out, /<em>i<\/em>/);
  assert.match(out, /<a href="https:\/\/x">link<\/a>/);
});

test('round-trip: app → wp → app yields plain blocks', async () => {
  const original = '<h2>Titel</h2><p>Eins.</p><ul><li>a</li><li>b</li></ul><p>Zwei.</p>';
  const wp = appToWpHtml(original);
  const back = await wpToAppHtml(wp);
  assert.doesNotMatch(back, /wp:/);
  assert.match(back, /<h2>Titel<\/h2>/);
  assert.match(back, /<p>Eins\.<\/p>/);
  assert.match(back, /<li>a<\/li>/);
  assert.match(back, /<p>Zwei\.<\/p>/);
});

test('appToWpHtml: empty input → empty string', () => {
  assert.equal(appToWpHtml(''), '');
  assert.equal(appToWpHtml(null), '');
});

test('appToWpHtml: unknown block tag falls back to paragraph if it has text', () => {
  const out = appToWpHtml('<div>orphan text</div>');
  assert.match(out, /<!-- wp:paragraph -->/);
  assert.match(out, /orphan text/);
});

// ── Quellenverzeichnis-Anhang + die Akkumulations-Invariante ─────────────────
//
// Der WordPress-Sync ist bidirektional mit Last-Write-Wins (docs/blog-sync.md).
// Ein angehaengtes Verzeichnis ist ein Render-Artefakt und MUSS beim Pull wieder
// verschwinden — sonst steht es nach einem Pull im Manuskript, der naechste Push
// haengt ein zweites an, und es wachsen pro Zyklus weitere hinzu.
//
// Der Beweis dafuer ist der Vergleich MIT gegen OHNE Verzeichnis: nach einem
// Round-Trip muessen beide Wege buchstabengleich denselben Seitenstand liefern.
// Wird der Pull-Strip in lib/wp-html.js entfernt, faellt genau dieser Vergleich.

const { buildCiteHtml } = await import('../../public/js/sources/cite-html.js');

// Form wie die Rueckgabe von buildBibliography (lib/bibliography.js) — hier von
// Hand, damit der Test keine DB braucht.
function bib(style = 'apa7') {
  return {
    enabled: true,
    inBlog: true,
    style,
    title: 'Quellenverzeichnis',
    titleHtml: 'Quellenverzeichnis',
    entries: [
      { id: 1, num: 1, text: 'Kafka, F. (1915). Die Verwandlung.', html: 'Kafka, F. (1915). <em>Die Verwandlung</em>.' },
      { id: 2, num: 2, text: 'Zweig, S. (1942). Schachnovelle.', html: 'Zweig, S. (1942). <em>Schachnovelle</em>.' },
    ],
  };
}

const CHIP = buildCiteHtml({ id: 1, loc: '44', text: '(Kafka, 1915, S. 44)' });
const PAGE = `<p>Ein Satz ${CHIP} mit Beleg.</p><p>Und noch einer.</p>`;

test('appToWpHtml: haengt das Verzeichnis als markierten wp:group-Block an', () => {
  const out = appToWpHtml(PAGE, { bibliography: bib() });
  // Marker-Klasse steht sowohl in den Block-Attributen (content.raw) als auch in
  // der Klassenliste des div (content.rendered) — beides muss der Pull finden.
  assert.match(out, /<!-- wp:group \{"className":"sw-bibliography"\} -->/);
  assert.match(out, /<div class="wp-block-group sw-bibliography">/);
  assert.match(out, /<!-- wp:heading -->\n<h2 class="wp-block-heading">Quellenverzeichnis<\/h2>/);
  // Autor-Jahr-Stil → Liste; der kursive Werktitel bleibt erhalten.
  assert.match(out, /<!-- wp:list -->/);
  assert.match(out, /<li>Kafka, F\. \(1915\)\. <em>Die Verwandlung<\/em>\.<\/li>/);
  // Verzeichnis steht HINTER dem Seitentext.
  assert.ok(out.indexOf('Und noch einer.') < out.indexOf('sw-bibliography'));
});

test('appToWpHtml: numerischer Stil als Absaetze mit [n], nicht als <ol>', () => {
  // Eine auto-numerierte <ol> waere falsch: bei bibliography_scope="all" haengen
  // unzitierte Quellen ohne Nummer hinten an (sortEntries), die Liste zaehlte
  // dann weiter und widersprache den Chips im Text.
  const out = appToWpHtml(PAGE, { bibliography: bib('numeric') });
  assert.doesNotMatch(out, /<!-- wp:list/);
  assert.match(out, /<p>\[1\] Kafka/);
  assert.match(out, /<p>\[2\] Zweig/);
});

test('appToWpHtml: kein Anhang ohne Verzeichnis, ohne Eintraege oder abgeschaltet', () => {
  assert.equal(appToWpHtml(PAGE), appToWpHtml(PAGE, { bibliography: null }));
  assert.equal(appToWpHtml(PAGE), appToWpHtml(PAGE, { bibliography: { ...bib(), enabled: false } }));
  assert.equal(appToWpHtml(PAGE), appToWpHtml(PAGE, { bibliography: { ...bib(), entries: [] } }));
});

test('INVARIANTE: Pull entfernt das Verzeichnis wieder — Round-Trip ist identisch', async () => {
  const withBib = await wpToAppHtml(appToWpHtml(PAGE, { bibliography: bib() }));
  const without = await wpToAppHtml(appToWpHtml(PAGE));

  // Der Kern: das Verzeichnis hinterlaesst keine Spur im Seitentext.
  assert.equal(withBib, without,
    'Verzeichnis ueberlebt den Pull → es wandert in den Seitentext und akkumuliert bei jedem Push');
  assert.doesNotMatch(withBib, /Quellenverzeichnis/);
  assert.doesNotMatch(withBib, /sw-bibliography/);
  assert.doesNotMatch(withBib, /Schachnovelle/);

  // Und der Chip im Text bleibt vollstaendig — mit Zeiger und Stellenangabe.
  assert.match(withBib, /<span class="cite" data-src="1" data-loc="44">\(Kafka, 1915, S\. 44\)<\/span>/);
  assert.match(withBib, /Ein Satz/);
  assert.match(withBib, /Und noch einer\./);
});

test('INVARIANTE: Verzeichnis akkumuliert auch ueber mehrere Push/Pull-Zyklen nicht', async () => {
  let page = PAGE;
  for (let i = 0; i < 3; i++) {
    page = await wpToAppHtml(appToWpHtml(page, { bibliography: bib() }));
  }
  assert.doesNotMatch(page, /Quellenverzeichnis/);
  assert.equal((page.match(/data-src="1"/g) || []).length, 1, 'Chip wurde vervielfaeltigt');
  assert.equal(page, await wpToAppHtml(appToWpHtml(PAGE)));
});

test('wpToAppHtml: Verzeichnis aus WPs gerendertem HTML (ohne Block-Kommentare) fliegt auch raus', async () => {
  // `content.rendered` liefert keine wp:*-Kommentare, aber die Klassenliste des
  // Group-Div — inklusive der Layout-Klassen, die WP selbst dazuschreibt.
  const rendered = '<p>Text.</p>\n<div class="wp-block-group sw-bibliography is-layout-flow wp-block-group-is-layout-flow">'
                 + '<h2 class="wp-block-heading">Quellenverzeichnis</h2><ul><li>Kafka, F. (1915).</li></ul></div>';
  const app = await wpToAppHtml(rendered);
  assert.match(app, /<p>Text\.<\/p>/);
  assert.doesNotMatch(app, /Quellenverzeichnis/);
  assert.doesNotMatch(app, /Kafka/);
});

// ── KSES-Guard: Chip ohne Zeiger ────────────────────────────────────────────

test('wpToAppHtml: Chip ohne data-src wird zu reinem Text degradiert und gezaehlt', async () => {
  // WordPress' KSES strippt `data-*`, wenn dem verbundenen Benutzer
  // `unfiltered_html` fehlt. Dann ist der Chip eine Quellenangabe ohne Ziel.
  const stats = {};
  const app = await wpToAppHtml('<p>Ein Satz <span class="cite">(Kafka, 1915, S. 44)</span> mit Beleg.</p>', stats);

  // Der lesbare Kurzbeleg bleibt im Satz stehen — er ist das einzige, was noch da
  // ist. Aber ohne Chip-Markup, damit nichts vorgibt, ein Nachweis zu sein.
  assert.match(app, /Ein Satz \(Kafka, 1915, S\. 44\) mit Beleg\./);
  assert.doesNotMatch(app, /class="cite"/);
  // NIE auf eine Quelle raten: kein data-src darf erfunden werden.
  assert.doesNotMatch(app, /data-src/);
  assert.equal(stats.citesDegraded, 1);
});

test('wpToAppHtml: intakter Chip wird nicht angetastet und nicht gezaehlt', async () => {
  const stats = {};
  const app = await wpToAppHtml(`<p>a ${CHIP} b</p>`, stats);
  assert.match(app, /<span class="cite" data-src="1" data-loc="44">/);
  assert.equal(stats.citesDegraded, undefined);
});

test('wpToAppHtml: mehrere zeigerlose Chips werden alle gezaehlt, stats ist optional', async () => {
  const html = '<p><span class="cite">(A, 2020)</span> und <span class="cite">(B, 2021)</span></p>';
  const stats = {};
  await wpToAppHtml(html, stats);
  assert.equal(stats.citesDegraded, 2);
  // Ohne stats-Objekt darf nichts werfen (routes/blog.js ruft so auf).
  const app = await wpToAppHtml(html);
  assert.match(app, /\(A, 2020\) und \(B, 2021\)/);
});

test('wpToAppHtml: Chip mit unbrauchbarem data-src verliert das Chip-Markup', async () => {
  // `data-src="0"`/`"abc"` ist kein gueltiger Zeiger (public/js/sources/cite-html.js)
  // — das Element ist Fremdmarkup und wird entpackt, nicht als KSES-Verlust
  // gezaehlt (das Attribut ist ja da, es ist nur wertlos).
  const stats = {};
  const app = await wpToAppHtml('<p>x <span class="cite" data-src="abc">(?)</span> y</p>', stats);
  assert.doesNotMatch(app, /class="cite"/);
  assert.match(app, /x \(\?\) y/);
  assert.equal(stats.citesDegraded, undefined);
});

// ── Tabellen ────────────────────────────────────────────────────────────────
// Der Pull ist hier der kritische Weg, nicht der Push: Gutenberg verpackt seinen
// Tabellenblock in `<figure class="wp-block-table">`, und der Pull entfernt
// „Figuren ohne Bild". Ohne die Entpackung LOESCHT ein Abgleich damit die ganze
// Tabelle aus dem Manuskript — Inhaltsverlust, den niemand ausgeloest hat, bei
// jedem Pull erneut. Genau diese Zusage steht hier.

const TABLE_APP = '<table data-bid="aabbccdd">'
  + '<caption>Umsatz nach Jahr</caption>'
  + '<thead><tr><th scope="col">Jahr</th><th scope="col" data-align="right">Umsatz</th></tr></thead>'
  + '<tbody><tr><td>2023</td><td data-align="right">1.2 Mio</td></tr></tbody></table>';

test('Push: Tabelle wird ein wp:table-Block mit figure-Wrapper', async () => {
  const wp = await appToWpHtml(TABLE_APP);
  assert.match(wp, /<!-- wp:table -->/);
  assert.match(wp, /<figure class="wp-block-table">/);
  assert.match(wp, /<thead><tr><th>Jahr<\/th>/);
  assert.match(wp, /<figcaption[^>]*>Umsatz nach Jahr<\/figcaption>/,
    'WordPress traegt die Beschriftung als figcaption, nicht als caption');
});

test('Push: Ausrichtung wird auf Gutenbergs Klasse abgebildet', async () => {
  const wp = await appToWpHtml(TABLE_APP);
  assert.match(wp, /class="has-text-align-right"/,
    'ohne die WP-Klasse zeigt der Block-Editor alle Spalten linksbuendig');
});

test('Pull: die Tabelle ueberlebt — figure-Wrapper wird entpackt, nicht entfernt', async () => {
  const wp = await appToWpHtml(TABLE_APP);
  const app = await wpToAppHtml(wp);
  assert.match(app, /<table/, 'die Regel „Figuren ohne Bild fallen weg" darf die Tabelle nicht treffen');
  assert.match(app, /2023/);
  assert.match(app, /1\.2 Mio/);
  assert.doesNotMatch(app, /wp-block-table/, 'der WP-Wrapper gehoert nicht ins Manuskript');
});

test('Pull: Beschriftung kommt als caption zurueck, nicht als figcaption', async () => {
  const app = await wpToAppHtml(await appToWpHtml(TABLE_APP));
  assert.match(app, /<caption>Umsatz nach Jahr<\/caption>/);
  assert.doesNotMatch(app, /figcaption/);
});

test('Pull: Ausrichtung und scope werden auf unseren Vertrag normalisiert', async () => {
  const app = await wpToAppHtml(await appToWpHtml(TABLE_APP));
  assert.match(app, /data-align="right"/, 'has-text-align-* muss auf data-align gehoben werden');
  assert.doesNotMatch(app, /has-text-align/, 'die Theme-Klasse gehoert nicht ins Manuskript');
  assert.match(app, /<th scope="col"/, 'scope gehoert zum Markup-Vertrag und wird beim Pull gesetzt');
});

test('Pull: eine in WordPress angelegte Tabelle kommt vollstaendig an', async () => {
  // Rohform, wie der Block-Editor sie schreibt: kein data-align, kein scope,
  // Beschriftung als figcaption.
  const raw = '<!-- wp:table -->\n'
    + '<figure class="wp-block-table"><table><thead><tr><th>A</th>'
    + '<th class="has-text-align-center">B</th></tr></thead>'
    + '<tbody><tr><td>1</td><td class="has-text-align-center">2</td></tr></tbody></table>'
    + '<figcaption class="wp-element-caption">Fremde Tabelle</figcaption></figure>\n'
    + '<!-- /wp:table -->';
  const app = await wpToAppHtml(raw);
  assert.match(app, /<table/);
  assert.match(app, /<caption>Fremde Tabelle<\/caption>/);
  assert.match(app, /data-align="center"/);
  assert.match(app, /<th scope="col"/);
  for (const bit of ['A', 'B', '1', '2']) assert.match(app, new RegExp(bit));
});

test('Pull: eine Figur OHNE Bild faellt weiterhin weg', async () => {
  // Die Entpackung darf die bestehende Regel nicht aushebeln.
  const app = await wpToAppHtml('<figure class="wp-block-embed"><div>nur Wrapper</div></figure>');
  assert.doesNotMatch(app, /<figure/);
});
