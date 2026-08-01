'use strict';
// Unit-Tests für lib/html-clean.js — Server-seitiger Page-HTML-Sanitizer.
// Lauf: `node --test tests/unit/html-clean.test.js`

const test = require('node:test');
const assert = require('node:assert/strict');

const { cleanPageHtml, wrapOrphanBlocks, collapseEmptyBlocks, stripTrailingEmptyBlocks, stripBlockEdgeNbsp, flattenDivBlocks, linkifyBareUrls, stripEditorUiArtefacts, stripActiveContent } = require('../../lib/html-clean');

// ── stripActiveContent ───────────────────────────────────────────────────────
// Zweite Schicht unter der CSP: Page-HTML landet unescaped in der öffentlichen
// Share-Leseansicht, und die Schreibwege dorthin (API, Blog-Import, Migration,
// Restore) tragen nicht zwingend Editor-Markup. Entfernt wird ausführbares
// Script — Darstellungs-Markup bleibt unangetastet.

test('stripActiveContent: <script> raus, Text bleibt', () => {
  assert.equal(
    stripActiveContent('<p>Vorher</p><script>alert(1)</script><p>Nachher</p>'),
    '<p>Vorher</p><p>Nachher</p>'
  );
});

test('stripActiveContent: Event-Handler-Attribute raus, Element bleibt', () => {
  assert.equal(
    stripActiveContent('<img src="/content/page-image/7" onerror="alert(1)" alt="x">'),
    '<img src="/content/page-image/7" alt="x">'
  );
  assert.equal(
    stripActiveContent('<p onclick="x()" data-bid="ab12">Text</p>'),
    '<p data-bid="ab12">Text</p>'
  );
});

test('stripActiveContent: javascript:-URL verliert das Attribut, Linktext bleibt', () => {
  assert.equal(
    stripActiveContent('<p><a href="javascript:alert(1)">klick</a></p>'),
    '<p><a>klick</a></p>'
  );
});

test('stripActiveContent: obfuskierte Schemes (Whitespace/Steuerzeichen, Grossschreibung)', () => {
  // Der Browser ignoriert Tabs/Newlines im Scheme — der Vergleich muss das auch.
  assert.equal(stripActiveContent('<a href="java\tscript:alert(1)">x</a>'), '<a>x</a>');
  assert.equal(stripActiveContent('<a href="  JaVaScRiPt:alert(1)">x</a>'), '<a>x</a>');
  assert.equal(stripActiveContent('<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>'), '<a>x</a>');
});

test('stripActiveContent: Darstellungs-Markup bleibt (keine Tag-Allowlist)', () => {
  // WordPress-Embeds in Blog-Büchern, data:-Bilder aus dem Fassungs-Export und
  // die Marker-Spans der Quellen-SSoT dürfen NICHT fallen.
  const keep = '<iframe src="https://example.com/e"></iframe>'
    + '<img src="data:image/png;base64,iVBORw0KGgo=">'
    + '<span class="cite" data-src="7" data-loc="44">(Müller, 2020, S. 44)</span>'
    + '<a href="https://example.com/x">Link</a>';
  assert.equal(stripActiveContent(keep), keep);
});

test('stripActiveContent: Fast-Path lässt unverdächtiges HTML byte-identisch', () => {
  const html = '<p data-bid="aa11">Ein Satz mit <em>Kursivem</em> darin.</p>';
  assert.equal(stripActiveContent(html), html);
});

test('stripActiveContent: Prosa über „JavaScript" bleibt inhaltlich unberührt', () => {
  // Trifft den Vorab-Test (Falsch-Positiv) und läuft durch den Parser — der Text
  // darf davon nichts abbekommen.
  const html = '<p>Sie schrieb ein Kapitel über javascript: die Sprache.</p>';
  assert.equal(stripActiveContent(html), html);
});

test('stripActiveContent: idempotent', () => {
  const once = stripActiveContent('<p onclick="a()">x</p><script>b()</script>');
  assert.equal(stripActiveContent(once), once);
});

test('cleanPageHtml: aktive Inhalte fallen auch über die Pipeline', () => {
  // flattenDivBlocks klont Attribute vom <div> ans neue <p> — würde erst danach
  // gestrippt, überlebte der Handler die Wandlung.
  const out = cleanPageHtml('<div onclick="alert(1)">Absatz</div><script>x()</script>');
  assert.equal(out.includes('onclick'), false);
  assert.equal(out.includes('<script'), false);
  assert.equal(out.includes('Absatz'), true);
});

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
  // Trailing &nbsp; ist Phantom-Rev-Quelle (Editor-Cursor-Anker) und wird
  // via stripBlockEdgeNbsp entfernt; sichtbarer Text bleibt unveraendert.
  assert.equal(out, '<p>Stefan fand problemlos eine Anstellung bei den SBB-Werkstätten.</p>');
});

test('stripBlockEdgeNbsp: trailing &#160; im Block-Ende wird entfernt', () => {
  assert.equal(
    stripBlockEdgeNbsp('<p>Text&#160;</p>'),
    '<p>Text</p>'
  );
});

test('stripBlockEdgeNbsp: leading NBSP am Block-Anfang wird entfernt', () => {
  assert.equal(
    stripBlockEdgeNbsp('<p>&#160;Text</p>'),
    '<p>Text</p>'
  );
});

test('stripBlockEdgeNbsp: NBSP mitten im Block bleibt erhalten', () => {
  // Mid-Block-NBSP ist gewollt (Geviert-Trennung, Vorname&nbsp;Nachname).
  const out = stripBlockEdgeNbsp('<p>Vorname&#160;Nachname</p>');
  assert.match(out, /Vorname( |&nbsp;|&#160;)Nachname/);
});

test('stripBlockEdgeNbsp: trailing NBSP in <li> + <h2>', () => {
  assert.equal(stripBlockEdgeNbsp('<li>Eintrag&#160;</li>'), '<li>Eintrag</li>');
  assert.equal(stripBlockEdgeNbsp('<h2>Titel&#160;</h2>'), '<h2>Titel</h2>');
});

test('stripBlockEdgeNbsp: NBSP nur in einem Block, andere unberuehrt', () => {
  const out = stripBlockEdgeNbsp('<p>A</p><p>B&#160;</p><p>C</p>');
  assert.equal(out, '<p>A</p><p>B</p><p>C</p>');
});

test('cleanPageHtml: trailing NBSP in mehreren Absaetzen alle gestripped', () => {
  // Reproduziert konkreten Phantom-Rev-Case: rev 158 vs rev 159 in Prod
  // unterschieden sich nur durch trailing &#160; im letzten <p>.
  const a = '<p>Text 1.&#160;</p><p>Text 2.</p><p>Text 3.&#160;</p>';
  const b = '<p>Text 1.</p><p>Text 2.</p><p>Text 3.</p>';
  assert.equal(cleanPageHtml(a), cleanPageHtml(b));
});

test('stripBlockEdgeNbsp: idempotent', () => {
  const input = '<p>X&#160;</p>';
  const once = stripBlockEdgeNbsp(input);
  const twice = stripBlockEdgeNbsp(once);
  assert.equal(once, twice);
});

test('flattenDivBlocks: plain <div> mit Textinhalt → <p>', () => {
  assert.equal(
    flattenDivBlocks('<div>Hallo</div>'),
    '<p>Hallo</p>'
  );
});

test('flattenDivBlocks: id-Attribut bleibt erhalten', () => {
  assert.equal(
    flattenDivBlocks('<div id="bkmrk-x">Text</div>'),
    '<p id="bkmrk-x">Text</p>'
  );
});

test('flattenDivBlocks: page-1056-Case (vier flache divs) → vier <p>', () => {
  const input = '<p id="bkmrk-a">Eins</p><div id="bkmrk-b">Zwei</div><div id="bkmrk-b">Drei</div><div id="bkmrk-b">Vier</div>';
  const out = flattenDivBlocks(input);
  assert.equal(
    out,
    '<p id="bkmrk-a">Eins</p><p id="bkmrk-b">Zwei</p><p id="bkmrk-b">Drei</p><p id="bkmrk-b">Vier</p>'
  );
});

test('flattenDivBlocks: <div class="poem"> bleibt unverändert', () => {
  const input = '<div class="poem"><p>Vers 1</p><p>Vers 2</p></div>';
  assert.equal(flattenDivBlocks(input), input);
});

test('flattenDivBlocks: Wrapper-<div> mit Block-Kindern bleibt <div>', () => {
  const input = '<div><p>Inner</p></div>';
  // Innerer <p> existiert bereits → kein Re-Wrap; äusserer <div> hat
  // Block-Descendant <p> → kein Convert.
  assert.equal(flattenDivBlocks(input), input);
});

test('flattenDivBlocks: verschachtelte div-only-Kette → innerste werden <p>', () => {
  // Innerer <div> hat keinen Block-Descendant → wird <p>. Äusserer hat danach
  // <p>-Descendant → bleibt <div>.
  assert.equal(
    flattenDivBlocks('<div><div>Innen</div></div>'),
    '<div><p>Innen</p></div>'
  );
});

test('flattenDivBlocks: inline-Markup im div bleibt erhalten', () => {
  assert.equal(
    flattenDivBlocks('<div>Hallo <strong>Welt</strong>!</div>'),
    '<p>Hallo <strong>Welt</strong>!</p>'
  );
});

test('flattenDivBlocks: idempotent', () => {
  const input = '<div>A</div><div>B</div>';
  const once = flattenDivBlocks(input);
  const twice = flattenDivBlocks(once);
  assert.equal(once, twice);
  assert.equal(once, '<p>A</p><p>B</p>');
});

test('cleanPageHtml: heilt page-1056-Pattern (div-Absätze → p)', () => {
  const broken = '<p id="bkmrk-x">Lieblingsszene.</p><div id="bkmrk-y">Eins.</div><div id="bkmrk-y">Zwei.</div><p>Drei.</p>';
  const out = cleanPageHtml(broken);
  assert.ok(!/<div/.test(out), 'darf keine <div> mehr enthalten');
  assert.match(out, /<p id="bkmrk-y">Eins\.<\/p>/);
  assert.match(out, /<p id="bkmrk-y">Zwei\.<\/p>/);
});

test('linkifyBareUrls: nackte http-URL wird zum <a>', () => {
  const out = linkifyBareUrls('<p>Siehe https://example.com hier.</p>');
  assert.match(out, /<a href="https:\/\/example\.com">https:\/\/example\.com<\/a>/);
});

test('linkifyBareUrls: bestehende <a>-Wraps bleiben unverändert (idempotent)', () => {
  const input = '<p><a href="https://example.com">https://example.com</a></p>';
  assert.equal(linkifyBareUrls(input), input);
});

test('linkifyBareUrls: trailing-Punkt bleibt ausserhalb des Links', () => {
  const out = linkifyBareUrls('<p>Zitiere https://example.com/page.</p>');
  assert.match(out, /<a href="https:\/\/example\.com\/page">https:\/\/example\.com\/page<\/a>\./);
});

test('linkifyBareUrls: mehrere URLs in einem Absatz', () => {
  const out = linkifyBareUrls('<p>A https://a.example und B https://b.example fertig.</p>');
  assert.match(out, /<a href="https:\/\/a\.example">https:\/\/a\.example<\/a>/);
  assert.match(out, /<a href="https:\/\/b\.example">https:\/\/b\.example<\/a>/);
});

test('linkifyBareUrls: URL im <pre> bleibt unangetastet', () => {
  const input = '<pre>https://example.com/raw</pre>';
  assert.equal(linkifyBareUrls(input), input);
});

test('linkifyBareUrls: URL mit Query-String + Anker', () => {
  const out = linkifyBareUrls('<p>Link https://example.com/path?x=1&y=2#anchor sehen.</p>');
  assert.match(out, /<a href="https:\/\/example\.com\/path\?x=1(&amp;|&)y=2#anchor">/);
});

test('linkifyBareUrls: &amp;-Entity in URL spannt den ganzen Link (kein Abbruch am &)', () => {
  // contenteditable persistiert getippte URLs mit escaptem `&`; der Parser
  // zerlegt das in mehrere Text-Nodes → ohne normalize() bricht der Link am &.
  const out = linkifyBareUrls('<p>Job https://jobs.admin.ch/?lang=de&amp;f=verwaltungseinheit:1083431 offen.</p>');
  assert.match(out, /href="https:\/\/jobs\.admin\.ch\/\?lang=de&f=verwaltungseinheit:1083431"/);
  assert.match(out, /1083431<\/a> offen\./); // Rest der URL ist im Link, nicht Klartext
});

test('linkifyBareUrls: kein http im Text → no-op', () => {
  assert.equal(linkifyBareUrls('<p>Kein Link hier.</p>'), '<p>Kein Link hier.</p>');
});

test('cleanPageHtml: linkifiziert URLs im Save-Pfad', () => {
  const out = cleanPageHtml('<p>Siehe https://example.com bla.</p>');
  assert.match(out, /<a href="https:\/\/example\.com">/);
});

// ─── LanguageTool-UI-Artefakte (Popover/Badge im contenteditable) ───

test('stripEditorUiArtefacts: entfernt .lt-popover samt Buttons/SVG', () => {
  const html = '<p>Der Jungen ging</p>'
    + '<div class="lt-popover" role="dialog" contenteditable="false">'
    + '<div class="lt-popover__header"><button class="lt-popover__close">×</button></div>'
    + '<div class="lt-popover__replacements"><button class="lt-popover__replacement">Junge</button></div>'
    + '</div>';
  const out = stripEditorUiArtefacts(html);
  assert.equal(out.indexOf('lt-popover'), -1);
  assert.equal(out.indexOf('<button'), -1);
  assert.equal(out, '<p>Der Jungen ging</p>');
});

test('stripEditorUiArtefacts: entfernt .lt-badge samt Icon-SVG', () => {
  const html = '<p>Text</p><div class="lt-badge" data-state="matches">'
    + '<span class="lt-badge__icon"><svg class="icon"><use href="/icons.svg#check"></use></svg></span>'
    + '<span class="lt-badge__label">3</span></div>';
  assert.equal(stripEditorUiArtefacts(html), '<p>Text</p>');
});

test('stripEditorUiArtefacts: kein lt-Markup → no-op (identische Referenz-Bytes)', () => {
  const html = '<p>Nichts zu tun.</p>';
  assert.equal(stripEditorUiArtefacts(html), html);
});

test('cleanPageHtml: Popover-Markup eines alten Clients landet nicht im Content', () => {
  const out = cleanPageHtml(
    '<p>Erster Absatz</p>'
    + '<div class="lt-popover"><p class="lt-popover__message">Meinten Sie …</p></div>'
    + '<p>Zweiter Absatz</p>'
  );
  assert.equal(out.indexOf('lt-popover'), -1);
  assert.equal(out.indexOf('Meinten Sie'), -1);
  assert.equal(out, '<p>Erster Absatz</p><p>Zweiter Absatz</p>');
});
