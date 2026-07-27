// Unit-Tests für public/js/editor/shared/quote-normalize.js.
// Stellt sicher: Locale-Map liefert pro Region die richtigen Quotes,
// Walker erkennt Open/Close anhand Kontext + Nesting-Stack, falsch gesetzte
// Glyphen-Cluster werden repariert, Apostroph zwischen Buchstaben/Ziffern wird
// zu U+2019, <pre>/<code> bleiben unangetastet, Block-Boundary resettet den
// Open/Close-State.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { window } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.window = window;
globalThis.document = window.document;
globalThis.Node = window.Node;
globalThis.NodeFilter = window.NodeFilter;
globalThis.HTMLElement = window.HTMLElement;

const { resolveQuoteStyle, normalizeQuotes, normalizeQuotesInRange } = await import('../../public/js/editor/shared/quote-normalize.js');

function makeRoot(fragment) {
  const { document: d } = parseHTML(`<!doctype html><html><body><div id="root">${fragment}</div></body></html>`);
  return d.getElementById('root');
}

// Minimal-Range-Shim — linkedom hat keine setStart/setEnd-API mit Offset.
// Reicht für die Eigenschaften, die normalizeQuotesInRange liest.
function makeRange(startContainer, startOffset, endContainer, endOffset) {
  return {
    collapsed: startContainer === endContainer && startOffset === endOffset,
    commonAncestorContainer:
      startContainer === endContainer
        ? startContainer
        : (startContainer.parentNode || startContainer),
    startContainer, startOffset, endContainer, endOffset,
    intersectsNode(node) {
      // Tests benutzen aktuell nur Single-Text-Node-Ranges. Erweitern bei Bedarf.
      return node === startContainer || node === endContainer;
    },
  };
}

test('resolveQuoteStyle: de-CH liefert Guillemets', () => {
  const s = resolveQuoteStyle('de', 'CH');
  assert.equal(s.ldquo, '«');
  assert.equal(s.rdquo, '»');
  assert.equal(s.lsquo, '‹');
  assert.equal(s.rsquo, '›');
});

test('resolveQuoteStyle: de-DE liefert „…"', () => {
  const s = resolveQuoteStyle('de', 'DE');
  assert.equal(s.ldquo, '„');
  assert.equal(s.rdquo, '“');
  assert.equal(s.lsquo, '‚');
  assert.equal(s.rsquo, '‘');
});

test('resolveQuoteStyle: en ohne Region', () => {
  const s = resolveQuoteStyle('en', '');
  assert.equal(s.ldquo, '“');
  assert.equal(s.rdquo, '”');
});

test('resolveQuoteStyle: en-US liefert modernen Stil', () => {
  const s = resolveQuoteStyle('en', 'US');
  assert.equal(s.ldquo, '“');
  assert.equal(s.rdquo, '”');
  assert.equal(s.lsquo, '‘');
  assert.equal(s.rsquo, '’');
  assert.equal(s.apostrophe, '’');
});

test('resolveQuoteStyle: en-GB modern (Oxford 2014+) = en-US', () => {
  const s = resolveQuoteStyle('en', 'GB');
  assert.equal(s.ldquo, '“');
  assert.equal(s.rdquo, '”');
  assert.equal(s.lsquo, '‘');
  assert.equal(s.rsquo, '’');
  assert.equal(s.apostrophe, '’');
});

test('normalizeQuotes: en-GB Outer-Quotes', () => {
  const root = makeRoot('<p>She said "Hello" loudly.</p>');
  const style = resolveQuoteStyle('en', 'GB');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'She said “Hello” loudly.');
});

test('normalizeQuotes: en-GB nested single in double', () => {
  const root = makeRoot('<p>She said "I heard \'hi\' loudly".</p>');
  const style = resolveQuoteStyle('en', 'GB');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'She said “I heard ‘hi’ loudly”.');
});

test('normalizeQuotes: en — Leading-Apostroph \'tis', () => {
  const root = makeRoot('<p>\'tis the season</p>');
  const style = resolveQuoteStyle('en', '');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, '’tis the season');
});

test('normalizeQuotes: en — \'em (Pronomen-Kontraktion)', () => {
  const root = makeRoot('<p>Get \'em all.</p>');
  const style = resolveQuoteStyle('en', '');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'Get ’em all.');
});

test('normalizeQuotes: en — \'90s Year-Shorthand', () => {
  const root = makeRoot('<p>The \'90s were wild.</p>');
  const style = resolveQuoteStyle('en', '');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'The ’90s were wild.');
});

test('normalizeQuotes: en — rock \'n\' roll', () => {
  const root = makeRoot('<p>rock \'n\' roll</p>');
  const style = resolveQuoteStyle('en', '');
  normalizeQuotes(root, style);
  // Beide ' werden zu ’ — leading via Kontraktions-Liste, trailing via
  // rsquo (das in en U+2019 == apostrophe ist).
  assert.equal(root.querySelector('p').textContent, 'rock ’n’ roll');
});

test('normalizeQuotes: en — \'cause (because-Kurzform)', () => {
  const root = makeRoot('<p>I left \'cause it was late.</p>');
  const style = resolveQuoteStyle('en', '');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'I left ’cause it was late.');
});

test('normalizeQuotes: en — Leading-Quote bei NICHT-Kontraktion bleibt lsquo', () => {
  // 'hello' ist kein Leading-Apostroph-Wort → echte Single-Quote-Klammer.
  const root = makeRoot('<p>He said \'hello\' to me.</p>');
  const style = resolveQuoteStyle('en', '');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'He said ‘hello’ to me.');
});

test('normalizeQuotes: de-CH — \'tis bleibt OHNE Kontraktions-Behandlung (nicht-en)', () => {
  // de-CH ist kein English-Style → Leading-Apostroph wird zu lsquo (‹).
  const root = makeRoot('<p>\'tis the season</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, '‹tis the season');
});

test('resolveQuoteStyle: Fallback bei unbekannter Sprache', () => {
  const s = resolveQuoteStyle('zz', 'XX');
  // Default ist de-CH
  assert.equal(s.ldquo, '«');
});

test('resolveQuoteStyle: de ohne Region → de-CH (Swiss-Default)', () => {
  // Swiss-App: ohne explizite Region fällt `de` auf DEFAULT_STYLE = de-CH,
  // nicht auf de-DE. Buchsprache ohne Region soll nicht stillschweigend
  // Anführungszeichen ins deutsche Format kippen.
  const s = resolveQuoteStyle('de', '');
  assert.equal(s.ldquo, '«');
  assert.equal(s.rdquo, '»');
  assert.equal(s.lsquo, '‹');
  assert.equal(s.rsquo, '›');
});

test('resolveQuoteStyle: de mit unbekannter Region → de-CH', () => {
  // Fallback auf DEFAULT_STYLE statt auf de-DE.
  const s = resolveQuoteStyle('de', 'XX');
  assert.equal(s.ldquo, '«');
});

test('normalizeQuotes: blockquote mit nested p — kein State-Leak zwischen p\'s', () => {
  // Vor dem Fix: outermost-only-Filter behielt nur die blockquote, und
  // _normalizeBlock lief mit durchgehendem prevChar/quoteStack über beide p's.
  const root = makeRoot('<blockquote><p>"Eins</p><p>"Zwei"</p></blockquote>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  const ps = root.querySelectorAll('p');
  assert.equal(ps[0].textContent, '«Eins');
  assert.equal(ps[1].textContent, '«Zwei»');
});

test('normalizeQuotes: ul mit nested li — kein State-Leak zwischen li\'s', () => {
  const root = makeRoot('<ul><li>"Eins</li><li>"Zwei"</li></ul>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  const lis = root.querySelectorAll('li');
  assert.equal(lis[0].textContent, '«Eins');
  assert.equal(lis[1].textContent, '«Zwei»');
});

test('normalizeQuotes: direkter Text in blockquote + nested p werden beide normalisiert', () => {
  // blockquote enthält direkten Text VOR dem p. Beide müssen normalisiert
  // werden — ohne Doppel-Processing der p-Inhalte.
  const root = makeRoot('<blockquote>"Direkt" und <p>"InP"</p></blockquote>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  const bq = root.querySelector('blockquote');
  // Direkter Text wird via blockquote-Pass normalisiert (p wird übersprungen).
  assert.ok(bq.textContent.includes('«Direkt»'), `expected «Direkt» in: ${bq.textContent}`);
  // p-Inhalt wird via p-Pass normalisiert.
  assert.equal(root.querySelector('p').textContent, '«InP»');
});

test('normalizeQuotes: gerade Doppelquotes → de-CH Guillemets', () => {
  const root = makeRoot('<p>Er sagte "Hallo" zu mir.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  const count = normalizeQuotes(root, style);
  assert.equal(count, 2);
  assert.equal(root.querySelector('p').textContent, 'Er sagte «Hallo» zu mir.');
});

test('normalizeQuotes: de-DE „…"', () => {
  const root = makeRoot('<p>Er sagte "Hallo" zu mir.</p>');
  const style = resolveQuoteStyle('de', 'DE');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'Er sagte „Hallo“ zu mir.');
});

test('normalizeQuotes: Apostroph zwischen Buchstaben → U+2019', () => {
  const root = makeRoot('<p>don\'t</p>');
  const style = resolveQuoteStyle('en', '');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'don’t');
});

test('normalizeQuotes: einfache Quotes als Open/Close', () => {
  const root = makeRoot('<p>He said \'hi\' to me.</p>');
  const style = resolveQuoteStyle('en', '');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'He said ‘hi’ to me.');
});

test('normalizeQuotes: <pre> bleibt unangetastet', () => {
  const root = makeRoot('<p>"foo"</p><pre>const x = "bar";</pre>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, '«foo»');
  assert.equal(root.querySelector('pre').textContent, 'const x = "bar";');
});

test('normalizeQuotes: <code> bleibt unangetastet', () => {
  const root = makeRoot('<p>Beispiel: <code>"x"</code> und "y".</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  // Im <code> bleiben gerade Quotes; ausserhalb werden sie ersetzt.
  assert.equal(root.querySelector('code').textContent, '"x"');
  const pText = root.querySelector('p').textContent;
  assert.ok(pText.includes('«y»'), `expected «y» in: ${pText}`);
});

test('normalizeQuotes: Quote überspannt <strong>', () => {
  const root = makeRoot('<p>Er rief "Hallo <strong>Welt</strong>" laut.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'Er rief «Hallo Welt» laut.');
});

test('normalizeQuotes: Block-Boundary resettet State', () => {
  // Erste P hat nur einen Quote → state-leak könnte zweite P falsch öffnen.
  // Erwartet: jede P startet frisch mit Open.
  const root = makeRoot('<p>"Eins</p><p>"Zwei"</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  const ps = root.querySelectorAll('p');
  assert.equal(ps[0].textContent, '«Eins');
  assert.equal(ps[1].textContent, '«Zwei»');
});

test('normalizeQuotes: keine Quotes → count 0, kein Mutate', () => {
  const root = makeRoot('<p>Nichts hier.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  const html = root.innerHTML;
  const count = normalizeQuotes(root, style);
  assert.equal(count, 0);
  assert.equal(root.innerHTML, html);
});

test('normalizeQuotes: style-konforme Quotes bleiben (idempotent)', () => {
  const root = makeRoot('<p>Er sagte «Hallo» laut.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  const count = normalizeQuotes(root, style);
  assert.equal(count, 0);
  assert.equal(root.querySelector('p').textContent, 'Er sagte «Hallo» laut.');
});

test('normalizeQuotes: fremder Style (de-DE „…") → de-CH «…»', () => {
  const root = makeRoot('<p>Er sagte „Hallo“ laut.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  const count = normalizeQuotes(root, style);
  assert.equal(count, 2);
  assert.equal(root.querySelector('p').textContent, 'Er sagte «Hallo» laut.');
});

test('normalizeQuotes: en Smart-Quotes → de-CH Guillemets', () => {
  const root = makeRoot('<p>He said “Hello” loud.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'He said «Hello» loud.');
});

test('normalizeQuotes: de-CH Guillemets → de-DE „…"', () => {
  const root = makeRoot('<p>Er sagte «Hallo» laut.</p>');
  const style = resolveQuoteStyle('de', 'DE');
  const count = normalizeQuotes(root, style);
  assert.equal(count, 2);
  assert.equal(root.querySelector('p').textContent, 'Er sagte „Hallo“ laut.');
});

test('normalizeQuotes: gemischt ASCII + typografisch → Style-konform', () => {
  const root = makeRoot('<p>Er sagte „Hallo" und "Welt“ laut.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'Er sagte «Hallo» und «Welt» laut.');
});

test('normalizeQuotes: nested single (typografisch) → de-CH inner Guillemets', () => {
  const root = makeRoot('<p>Er sagte: «Sie meinte ‚sofort‘, sagte er.»</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(
    root.querySelector('p').textContent,
    'Er sagte: «Sie meinte ‹sofort›, sagte er.»',
  );
});

test('normalizeQuotes: Apostroph U+2019 zwischen Buchstaben bleibt', () => {
  const root = makeRoot('<p>Marie’s Buch und don’t go</p>');
  const style = resolveQuoteStyle('de', 'CH');
  const count = normalizeQuotes(root, style);
  assert.equal(count, 0);
  assert.equal(root.querySelector('p').textContent, 'Marie’s Buch und don’t go');
});

test('normalizeQuotes: de-CH Saxon-Genitiv Chris\' wird Apostroph, nicht ›', () => {
  const root = makeRoot('<p>Dort machte er jeweils Chris\' berufliche Karriere.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(
    root.querySelector('p').textContent,
    'Dort machte er jeweils Chris’ berufliche Karriere.',
  );
});

test('normalizeQuotes: de-CH Genitiv-Apostroph vor Satzzeichen', () => {
  const root = makeRoot('<p>Das ist Chris\'.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'Das ist Chris’.');
});

test('normalizeQuotes: de-CH Genitiv-Apostroph innerhalb offenem Double-Quote', () => {
  const root = makeRoot('<p>"Das war Chris\' Idee."</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, '«Das war Chris’ Idee.»');
});

test('normalizeQuotes: de-CH echtes schliessendes Single-Quote bleibt ›', () => {
  const root = makeRoot('<p>Er sagte \'Hallo Chris\' laut.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'Er sagte ‹Hallo Chris› laut.');
});

test('normalizeQuotes: FR-Style fügt NBSP innen ein', () => {
  const root = makeRoot('<p>Il a dit "Bonjour" fort.</p>');
  const style = resolveQuoteStyle('fr', '');
  normalizeQuotes(root, style);
  // « + NBSP + Bonjour + NBSP + »
  assert.equal(root.querySelector('p').textContent, 'Il a dit « Bonjour » fort.');
});

test('normalizeQuotes: FR-Style idempotent (keine Doppel-NBSP)', () => {
  const root = makeRoot('<p>Il a dit « Bonjour » fort.</p>');
  const style = resolveQuoteStyle('fr', '');
  const count = normalizeQuotes(root, style);
  assert.equal(count, 0);
  assert.equal(root.querySelector('p').textContent, 'Il a dit « Bonjour » fort.');
});

test('normalizeQuotes: FR-Style frisst bestehenden regulären Space', () => {
  const root = makeRoot('<p>Il a dit « Bonjour » fort.</p>');
  const style = resolveQuoteStyle('fr', '');
  normalizeQuotes(root, style);
  // Reguläre Spaces werden zu NBSP (kein Doppel-Space).
  assert.equal(root.querySelector('p').textContent, 'Il a dit « Bonjour » fort.');
});

test('normalizeQuotes: drei Quote-Paare nacheinander, korrekt klassifiziert', () => {
  const root = makeRoot('<p>"Eins" sagte er, "Zwei" rief sie, "Drei" murmelte ich.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(
    root.querySelector('p').textContent,
    '«Eins» sagte er, «Zwei» rief sie, «Drei» murmelte ich.',
  );
});

test('normalizeQuotes: Klammern um Quote', () => {
  const root = makeRoot('<p>Er sagte ("Hallo") laut.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'Er sagte («Hallo») laut.');
});

test('normalizeQuotes: Punkt vor schliessendem Quote', () => {
  const root = makeRoot('<p>Er sagte "Hallo." und ging.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'Er sagte «Hallo.» und ging.');
});

test('normalizeQuotes: nur ein Quote, am Wortanfang → öffnend', () => {
  const root = makeRoot('<p>Hier nur "ein offener Quote ohne Ende.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'Hier nur «ein offener Quote ohne Ende.');
});

test('normalizeQuotes: nur ein Quote, am Wortende → schliessend', () => {
  const root = makeRoot('<p>Schliessendes ohne Anfang", sagte er.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'Schliessendes ohne Anfang», sagte er.');
});

test('normalizeQuotes: Em-Dash vor öffnendem Quote', () => {
  const root = makeRoot('<p>Er rief — "Halt!" — und blieb stehen.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'Er rief — «Halt!» — und blieb stehen.');
});

test('normalizeQuotes: nested single in double', () => {
  const root = makeRoot('<p>Er sagte: "Sie meinte \'sofort\', sagte er."</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(
    root.querySelector('p').textContent,
    'Er sagte: «Sie meinte ‹sofort›, sagte er.»',
  );
});

test('normalizeQuotes: Possessiv-Apostroph kids\'', () => {
  const root = makeRoot('<p>the kids\' books</p>');
  const style = resolveQuoteStyle('en', '');
  normalizeQuotes(root, style);
  // kids' = Apostroph (nicht schliessendes Single-Quote)
  assert.equal(root.querySelector('p').textContent, 'the kids’ books');
});

test('normalizeQuotes: Quote über <em> hinweg → next-Kontext aus folgendem Text-Node', () => {
  const root = makeRoot('<p>Er rief "<em>Hallo Welt</em>" laut.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'Er rief «Hallo Welt» laut.');
});

test('normalizeQuotes: adjazenter Mixed-Style-Cluster wird zum einen Schliesser', () => {
  // `„«` klebt aneinander, davor ein Space, dahinter ein Komma. Jede Glyphe für
  // sich wirkt öffnend — als Run ist die Stelle eindeutig der Schliesser der
  // offenen Rede. Überzählige Glyphe fällt weg, Space davor wird gestrippt.
  const root = makeRoot('<p>„Die Wohnung? „«, fragte er.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  const count = normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, '«Die Wohnung?», fragte er.');
  assert.ok(count > 0);
});

// --- Reparatur bereits falsch gesetzter Anführungszeichen ---

test('normalizeQuotes: Space vor Schliesser macht ihn nicht zum inneren Öffner', () => {
  const root = makeRoot('<p>«Die Wohnung? «, fragte ich.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, '«Die Wohnung?», fragte ich.');
});

test('normalizeQuotes: Cluster ‹« mitten im Satz wird repariert', () => {
  const root = makeRoot('<p>«Die Wohnung? ‹«, fragte ich ganz erstaunt.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(
    root.querySelector('p').textContent,
    '«Die Wohnung?», fragte ich ganz erstaunt.',
  );
});

test('normalizeQuotes: repariertes Ergebnis ist idempotent', () => {
  const root = makeRoot('<p>«Die Wohnung? ‹«, fragte ich.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  const once = root.querySelector('p').textContent;
  assert.equal(normalizeQuotes(root, style), 0);
  assert.equal(root.querySelector('p').textContent, once);
});

test('normalizeQuotes: Cluster »« ohne Space schliesst und öffnet neu', () => {
  // Zwei Reden ohne Trennzeichen — der Run klebt beidseitig an Inhalt.
  const root = makeRoot('<p>»Komm rein.««Danke», sagte er.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, '«Komm rein.»«Danke», sagte er.');
});

test('normalizeQuotes: legitime adjazente Schliesser bleiben beide erhalten', () => {
  const root = makeRoot('<p>«Er sagte ‹hallo›», rief sie.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  assert.equal(normalizeQuotes(root, style), 0);
  assert.equal(root.querySelector('p').textContent, '«Er sagte ‹hallo›», rief sie.');
});

test('normalizeQuotes: Schliesser ohne Öffner bleibt Schliesser (Rede über Absätze)', () => {
  const root = makeRoot('<p>Fortsetzung», sagte er.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  assert.equal(normalizeQuotes(root, style), 0);
  assert.equal(root.querySelector('p').textContent, 'Fortsetzung», sagte er.');
});

test('normalizeQuotes: Page-105-Corpus → alle non-Swiss Quotes weg', () => {
  // Real-World-Mix aus Buch 102 / Seite 105: „… »…« mit gemischten Richtungen.
  // Erwartet: nach Normalisierung sind ausschliesslich Swiss-Glyphen (« » ‹ › ’)
  // im Text — keine deutschen „…“ oder englischen "…" Reste.
  const root = makeRoot(`
    <p>„Spurensicherung ist dort. Keine Einbruchsspuren.«</p>
    <p>„Und ihr Handy?«, während er von The Doors »The End« hörte.</p>
    <p>„Weg. Nicht in der Wohnung.« Markus setzte sich. „Letzter Anruf: tot.»</p>
    <p>„Natürlich.«</p>
    <p>„Ich war bei der Kanzlei«, sagte Markus.</p>
    <p>„Eine Affäre?«</p>
    <p>„Möglich. Oder etwas Berufliches.«</p>
    <p>„Mit wem?«</p>
    <p>Was soll’s.</p>
  `);
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  const all = root.textContent;
  assert.ok(!/[„“”‚‘"']/.test(all), `non-Swiss quotes remained: ${[...all].filter(c => /[„“”‚‘"']/.test(c)).join(' ')}`);
  // Vereinzelte Erwartungen: dialogische Sätze beginnen mit `«` und enden mit `»`.
  const ps = root.querySelectorAll('p');
  assert.equal(ps[0].textContent, '«Spurensicherung ist dort. Keine Einbruchsspuren.»');
  assert.equal(ps[1].textContent, '«Und ihr Handy?», während er von The Doors «The End» hörte.');
  assert.equal(ps[3].textContent, '«Natürlich.»');
  assert.equal(ps[4].textContent, '«Ich war bei der Kanzlei», sagte Markus.');
  assert.equal(ps[8].textContent, 'Was soll’s.');
});

// Stack-basiertes Depth-Tracking: User tippt durchgehend `"` für Outer und
// Inner. Klassifizierer-allein würde alle vier als Outer-Double sehen.
// Block-lokaler Stack erkennt Verschachtelung und demoted die mittleren zwei
// Double-Quotes zu Inner-Single.
test('normalizeQuotes: en — verschachtelte ASCII-Doubles → Inner zu Single', () => {
  const root = makeRoot('<p>He said: "Everything is "great" - but not always"</p>');
  const style = resolveQuoteStyle('en', '');
  normalizeQuotes(root, style);
  assert.equal(
    root.querySelector('p').textContent,
    'He said: “Everything is ‘great’ - but not always”',
  );
});

test('normalizeQuotes: de-DE — verschachtelte ASCII-Doubles → Inner zu ‚…‘', () => {
  const root = makeRoot('<p>Er sagte: "Heute ist "schön" wirklich."</p>');
  const style = resolveQuoteStyle('de', 'DE');
  normalizeQuotes(root, style);
  assert.equal(
    root.querySelector('p').textContent,
    'Er sagte: „Heute ist ‚schön‘ wirklich.“',
  );
});

test('normalizeQuotes: de-CH — verschachtelte ASCII-Doubles → Inner zu ‹…›', () => {
  const root = makeRoot('<p>Er sagte: "Heute ist "schön" wirklich."</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(
    root.querySelector('p').textContent,
    'Er sagte: «Heute ist ‹schön› wirklich.»',
  );
});

test('normalizeQuotes: en — 3-Level-Nesting (Double-Single-Double)', () => {
  // depth=0 outer "  depth=1 inner '  depth=2 wieder outer "
  const root = makeRoot('<p>"Sie sagte \'er rief "ja"\' laut."</p>');
  const style = resolveQuoteStyle('en', '');
  normalizeQuotes(root, style);
  assert.equal(
    root.querySelector('p').textContent,
    '“Sie sagte ‘er rief “ja”’ laut.”',
  );
});

test('normalizeQuotes: en — Apostroph innerhalb Outer-Dialog unverändert', () => {
  // Stack push für Outer, dann Apostroph (kein push/pop), dann Outer-Close.
  const root = makeRoot('<p>"It is foo\'s bar"</p>');
  const style = resolveQuoteStyle('en', '');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, '“It is foo’s bar”');
});

test('normalizeQuotes: <br>-Zeilengrenze resettet Kontext — öffnendes Quote nach Satzende', () => {
  // Regression: <br>-getrennte Dialogzeilen in EINEM <p>. Ohne Reset erbt das
  // öffnende `"` der Folgezeile den `.` der Vorzeile als prevChar und wird
  // fälschlich als schliessend (”) klassifiziert; zugleich bleibt der Dot-Run
  // unkonvertiert, weil der Quote-Stack auf 0 hängt.
  const root = makeRoot('<p>I started typing.<br>"Thank you. I...."<br>What did I do?</p>');
  const style = resolveQuoteStyle('en', 'US');
  normalizeQuotes(root, style);
  assert.equal(
    root.querySelector('p').textContent,
    'I started typing.“Thank you. I…”What did I do?',
  );
});

test('normalizeQuotes: <br>-getrennte Dialogzeilen — jede Zeile öffnet/schliesst korrekt', () => {
  const lines = [
    '"Hey, wanna come?"',
    'I stared at the message.',
    '"... will check my calendar."',
    'I didn\'t need to.',
    '"Next time, I would love to come."',
  ].join('<br>');
  const root = makeRoot(`<p>${lines}</p>`);
  const style = resolveQuoteStyle('en', 'US');
  normalizeQuotes(root, style);
  const text = root.querySelector('p').textContent;
  assert.ok(!/["”]Hey/.test(text), `opening quote misclassified: ${text}`);
  assert.ok(text.includes('“Hey, wanna come?”'), text);
  assert.ok(text.includes('“… will check my calendar.”'), text);
  assert.ok(text.includes('“Next time, I would love to come.”'), text);
  assert.ok(text.includes('didn’t'), text);
});

test('normalizeQuotes: <br> innerhalb <strong> wird ebenfalls als Grenze erkannt', () => {
  const root = makeRoot('<p>Foo bar.<strong>baz.<br>"Quote here"</strong></p>');
  const style = resolveQuoteStyle('en', 'US');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'Foo bar.baz.“Quote here”');
});

test('normalizeQuotesInRange: <br>-Grenze resettet Kontext auch im Range-Scope', () => {
  // Range deckt den gesamten <p>-Inhalt ab (über die <br>-Grenze hinweg).
  const root = makeRoot('<p>typing.<br>"Hi there"</p>');
  const style = resolveQuoteStyle('en', 'US');
  const p = root.querySelector('p');
  // Range vom ersten bis zum letzten Text-Node.
  const first = p.firstChild;
  const last = p.lastChild;
  const range = makeRange(first, 0, last, last.nodeValue.length);
  // intersectsNode-Shim muss beide Text-Nodes erfassen.
  range.intersectsNode = () => true;
  normalizeQuotesInRange(range, style);
  assert.equal(p.textContent, 'typing.“Hi there”');
});

test('normalizeQuotesInRange: nur Selection wird transformiert', () => {
  const root = makeRoot('<p>"Eins" und "Zwei"</p>');
  const style = resolveQuoteStyle('de', 'CH');
  const p = root.querySelector('p');
  const t = p.firstChild;
  // Selektiere genau "Eins" inkl. der umgebenden geraden Quotes (offsets 0..6).
  const range = makeRange(t, 0, t, 6);
  const count = normalizeQuotesInRange(range, style);
  assert.equal(count, 2);
  assert.equal(p.textContent, '«Eins» und "Zwei"');
});

test('normalizeQuotesInRange: leere Range → 0', () => {
  const root = makeRoot('<p>"foo"</p>');
  const style = resolveQuoteStyle('de', 'CH');
  const p = root.querySelector('p');
  const range = makeRange(p.firstChild, 2, p.firstChild, 2);
  assert.equal(normalizeQuotesInRange(range, style), 0);
  assert.equal(p.textContent, '"foo"');
});

test('normalizeQuotesInRange: prev-Kontext aus Text vor Range', () => {
  // Range umschliesst `"Hallo"` (offsets 9..17). prev-Kontext ist Whitespace
  // VOR der Range → erstes `"` wird öffnend, zweites schliessend.
  const root = makeRoot('<p>Er sagte "Hallo" laut.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  const p = root.querySelector('p');
  const t = p.firstChild;
  const range = makeRange(t, 9, t, 17);
  normalizeQuotesInRange(range, style);
  assert.equal(p.textContent, 'Er sagte «Hallo» laut.');
});

test('normalizeQuotes: Dot-Run innerhalb Quote → … (de-CH)', () => {
  const root = makeRoot('<p>Er sagte "Oh.." und ging.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'Er sagte «Oh…» und ging.');
});

test('normalizeQuotes: drei Punkte in Quote → …', () => {
  const root = makeRoot('<p>"Ich weiss nicht..."</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, '«Ich weiss nicht…»');
});

test('normalizeQuotes: einzelner Punkt in Quote bleibt', () => {
  const root = makeRoot('<p>"Oh."</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, '«Oh.»');
});

test('normalizeQuotes: Dot-Run ausserhalb Quote bleibt (z.B.)', () => {
  const root = makeRoot('<p>Das war z.B. wichtig... wirklich.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'Das war z.B. wichtig... wirklich.');
});

test('normalizeQuotes: Dot-Run in Quote, andere Stelle ausserhalb bleibt', () => {
  const root = makeRoot('<p>z.B. sagte er "Oh.." und lachte.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'z.B. sagte er «Oh…» und lachte.');
});

test('normalizeQuotes: Dot-Run in en-US Quote', () => {
  const root = makeRoot('<p>He said "I dont know...".</p>');
  const style = resolveQuoteStyle('en', 'US');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'He said “I dont know…”.');
});

test('normalizeQuotes: idempotent — bereits … bleibt …', () => {
  const root = makeRoot('<p>«Oh…»</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, '«Oh…»');
});

test('normalizeQuotesInRange: Dot-Run nur innerhalb Range', () => {
  // Range umschliesst nur den inneren Dot-Run; Quotes bereits gesetzt.
  const root = makeRoot('<p>«Oh..» z.B. Foo..</p>');
  const style = resolveQuoteStyle('de', 'CH');
  const p = root.querySelector('p');
  const t = p.firstChild;
  // Offsets: «=0, O=1, h=2, .=3, .=4, »=5
  const range = makeRange(t, 3, t, 5);
  normalizeQuotesInRange(range, style);
  // Inner Dot-Run normalisiert; ausserhalb (`Foo..`) bleibt
  assert.equal(p.textContent, '«Oh…» z.B. Foo..');
});

// --- Innen-Abstand & Idempotenz (Fix: macOS-Autokorrektur-Spaces + FR-Wachstum) ---

const NBSP = ' ';

test('de-CH: von aussen (macOS) eingefügte Spaces in Guillemets werden gestrippt', () => {
  const root = makeRoot('<p>« Hallo », sagte er.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  const n = normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, '«Hallo», sagte er.');
  assert.ok(n > 0, 'Änderung muss gezählt werden (markiert dirty)');
});

test('de-CH: NBSP-Innenabstände werden ebenfalls gestrippt', () => {
  const root = makeRoot(`<p>«${NBSP}Hallo${NBSP}»</p>`);
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, '«Hallo»');
});

test('de-CH: bereits sauber → count 0 (kein unnötiges Dirty/Re-Save)', () => {
  const root = makeRoot('<p>«Hallo», sagte er.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  assert.equal(normalizeQuotes(root, style), 0);
});

test('fr: exakt ein NBSP je Guillemet, idempotent über mehrere Läufe', () => {
  const root = makeRoot('<p>"Bonjour", dit-il.</p>');
  const style = resolveQuoteStyle('fr');
  normalizeQuotes(root, style);
  const once = root.querySelector('p').textContent;
  assert.equal(once, `«${NBSP}Bonjour${NBSP}», dit-il.`);
  // Wiederholte Läufe dürfen keine weiteren Spaces einschieben.
  normalizeQuotes(root, style);
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, once);
});

test('fr: mehrfach-Spaces kollabieren auf den Style-NBSP', () => {
  const root = makeRoot('<p>«   Bonjour   »</p>');
  const style = resolveQuoteStyle('fr');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, `«${NBSP}Bonjour${NBSP}»`);
});

test('fr: fragmentierte Text-Nodes (Guillemet | NBSP | Wort) bleiben idempotent', () => {
  // Simuliert contenteditable-Fragmentierung: normalize() muss vorher mergen.
  const root = makeRoot('<p></p>');
  const p = root.querySelector('p');
  p.appendChild(document.createTextNode('«'));
  p.appendChild(document.createTextNode(NBSP + 'Bonjour' + NBSP));
  p.appendChild(document.createTextNode('»'));
  const style = resolveQuoteStyle('fr');
  normalizeQuotes(root, style);
  const once = root.querySelector('p').textContent;
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, once);
  assert.equal(once, `«${NBSP}Bonjour${NBSP}»`);
});
