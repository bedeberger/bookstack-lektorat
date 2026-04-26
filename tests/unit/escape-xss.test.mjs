// Tests für escHtml + escPreserveStrong + renderChatMarkdown:
// XSS-Regression. KI- und User-Inhalte fliessen über `x-html`-Sinks ins DOM
// (Review-Renderer, Chat-Markdown, Status-Strings). CLAUDE.md fordert ein
// Escape-First-Modell ohne Runtime-Sanitizer; jede neue Sink muss durch
// escHtml. Dieser Test prüft die Escape-Invariante.
import test from 'node:test';
import assert from 'node:assert/strict';
import { escHtml, escPreserveStrong, renderChatMarkdown } from '../../public/js/utils.js';

const PAYLOADS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '"><svg onload=alert(1)>',
  "'\"><body onload=alert(1)>",
  '<a href="javascript:alert(1)">x</a>',
];

test('escHtml: neutralisiert <script>', () => {
  const out = escHtml('<script>alert(1)</script>');
  assert.equal(out, '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.ok(!out.includes('<script'));
  assert.ok(!out.includes('</script>'));
});

test('escHtml: alle XSS-Payloads enthalten kein < oder " ungeschützt', () => {
  for (const p of PAYLOADS) {
    const out = escHtml(p);
    assert.ok(!/[<>]/.test(out), `payload "${p}" → output "${out}" enthält < oder >`);
    // Quotes müssen escaped sein
    assert.ok(!out.includes('"'), `payload "${p}" → output enthält literal "`);
  }
});

test('escHtml: ampersand wird zuerst escaped (verhindert double-encode)', () => {
  // & vor < ersetzen, sonst würde &lt; zu &amp;lt; werden.
  assert.equal(escHtml('a & b'), 'a &amp; b');
  assert.equal(escHtml('<'), '&lt;');
  // Kombination: bereits escaped Inhalt darf nicht doppelt encoded werden
  // (passiert hier nicht, weil escHtml input als raw behandelt – aber
  // das & muss sicher nur einmal pro Pass laufen).
  assert.equal(escHtml('<&>'), '&lt;&amp;&gt;');
});

test('escHtml: leere/null Werte → leerer String, kein Crash', () => {
  assert.equal(escHtml(null), '');
  assert.equal(escHtml(undefined), '');
  assert.equal(escHtml(''), '');
  assert.equal(escHtml(0), ''); // 0 ist falsy – aktueller Vertrag liefert ''
});

test('escPreserveStrong: erlaubt <strong> aber escapt alles andere', () => {
  const input = '<strong>Treffer</strong> <script>x</script>';
  const out = escPreserveStrong(input);
  assert.ok(out.includes('<strong>'), 'BookStack-Search-Highlight muss erhalten bleiben');
  assert.ok(out.includes('</strong>'));
  assert.ok(!out.includes('<script'), '<script> muss escaped sein');
  assert.match(out, /&lt;script&gt;/);
});

test('escPreserveStrong: kein <strong>-Smuggling via escaped Tags', () => {
  // Wenn ein Angreifer "&lt;strong&gt;" liefert, darf escPreserveStrong das
  // NICHT in echtes <strong> zurückwandeln (sonst wäre die Whitelist umgehbar).
  const input = '&lt;strong&gt;evil&lt;/strong&gt;';
  const out = escPreserveStrong(input);
  // & wird zu &amp; → "&amp;lt;strong&amp;gt;..."
  assert.ok(!out.includes('<strong>evil</strong>'),
    'escaped Strong-Sequenz darf nicht zu echtem Tag werden');
});

test('renderChatMarkdown: escapt Input zuerst – <script> wird unausführbar', () => {
  const out = renderChatMarkdown('Hier: <script>alert(1)</script>');
  assert.ok(!out.includes('<script>'),
    'renderChatMarkdown muss vor Markdown-Processing escapen');
  assert.match(out, /&lt;script&gt;/);
});

test('renderChatMarkdown: img-onerror-Payload bleibt unausführbar', () => {
  const out = renderChatMarkdown('<img src=x onerror=alert(1)>');
  assert.ok(!out.includes('<img'),
    '<img>-Tag muss escaped sein, sonst feuert onerror');
  // onerror= als Text-Inhalt ist OK (kein < davor → kein Attribut-Kontext);
  // entscheidend ist: das öffnende `<` ist neutralisiert.
  assert.match(out, /&lt;img/);
});

test('renderChatMarkdown: Markdown-Features funktionieren weiter (regression)', () => {
  // **bold** → <strong>, *italic* → <em>, `code` → <code>
  const out = renderChatMarkdown('**fett** *kursiv* `code`');
  assert.match(out, /<strong>fett<\/strong>/);
  assert.match(out, /<em>kursiv<\/em>/);
  assert.match(out, /<code class="chat-code">code<\/code>/);
});

test('renderChatMarkdown: payload IM Markdown-Kontext bleibt escaped', () => {
  // Ein Angreifer könnte versuchen, das Tag durch Bold/Italic-Marker zu schmuggeln.
  const out = renderChatMarkdown('**<script>alert(1)</script>**');
  assert.match(out, /<strong>/);
  assert.ok(!out.includes('<script>'));
  assert.match(out, /&lt;script&gt;/);
});

test('renderChatMarkdown: leerer Input → leerer Output', () => {
  assert.equal(renderChatMarkdown(''), '');
  assert.equal(renderChatMarkdown(null), '');
});

test('renderChatMarkdown: Tabelle escapt Zelleninhalt', () => {
  // Dreifaches Zeilenende: Tabellen-Regex captured \|[^\n]+\n, also muss
  // jede Zeile auf \n enden (auch die letzte) damit der Markdown-Parser
  // sie als Block erkennt.
  const md = '| Name | Wert |\n|---|---|\n| <script>x</script> | y |\n';
  const out = renderChatMarkdown(md);
  assert.match(out, /<table/);
  assert.ok(!out.includes('<script>'),
    'Tabellenzellen müssen escaped sein – sonst XSS via Markdown-Tabelle');
});
