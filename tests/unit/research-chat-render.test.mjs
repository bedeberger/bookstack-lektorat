// Unit-Tests für public/js/chat/research-chat-render.js — pure Marker-Logik des
// Recherche-Chats (extrahiert aus research-chat.js, mit der Tests-trackbar sein
// soll). Mocks für renderChatMarkdown (passthrough), escHtml (passthrough) und
// t (key -> '[i18n]key'); tests üben allein die Zitat-Resolver-/Sentinel-Logik.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderResearchAnswer,
  citedSources,
  parseCiteDocNums,
  resolveSource,
} from '../../public/js/chat/research-chat-render.js';

const ID = (s) => s;          // escHtml mock: passthrough
const MK = (s) => s;          // renderChatMarkdown mock: passthrough
const T = (k) => `[i18n]${k}`; // t mock

function render(text, sources = [], opts = {}) {
  return renderResearchAnswer({
    text, sources,
    renderChatMarkdown: opts.renderChatMarkdown ?? MK,
    escHtml: opts.escHtml ?? ID,
    t: opts.t ?? T,
  });
}

test('parseCiteDocNums: erste Zahl pro Komma-Teil, distinkt, Reihenfolge erhalten', () => {
  assert.deepEqual(parseCiteDocNums('4-4,4-5,1-2,4-7'), [4, 1]);
  assert.deepEqual(parseCiteDocNums(' 2-1 ,3-9 '), [2, 3]);
  assert.deepEqual(parseCiteDocNums(''), []);
  assert.deepEqual(parseCiteDocNums(null), []);
});

test('resolveSource: 1-basiert, null bei Overflow', () => {
  const srcs = [{ url: 'a' }, { url: 'b' }];
  assert.equal(resolveSource(srcs, 1).url, 'a');
  assert.equal(resolveSource(srcs, 2).url, 'b');
  assert.equal(resolveSource(srcs, 3), null);
  assert.equal(resolveSource([], 1), null);
});

test('renderResearchAnswer: einzelner cite-Index mit Source → klickbarer sup', () => {
  const sources = [{ url: 'https://a.example', title: 'Alpha' }];
  const out = render('Siehe <cite index="1-3">hier</cite> für mehr.', sources);
  assert.match(out, /<sup class="chat-cite"><a href="https:\/\/a\.example" target="_blank" rel="noopener noreferrer" data-tip="Alpha">1<\/a><\/sup>/);
  // Innerer Text erhalten, Tag-Wrapper aufgelöst.
  assert.ok(out.includes('Siehe hier'));
  assert.ok(!out.includes('<cite'));
});

test('renderResearchAnswer: mehrere Kommas in einem index (4-4,1-2) → beide Marker', () => {
  const sources = [
    { url: 'https://a.example', title: 'A' },
    { url: 'https://b.example', title: 'B' },
    { url: 'https://c.example', title: 'C' },
    { url: 'https://d.example', title: 'D' },
  ];
  // Index "4-4,1-2" → parseCiteDocNums gibt [4, 1] (distinkt, Reihenfolge erhalten).
  const out = render('Mehr <cite index="4-4,1-2">dazu</cite>.', sources);
  const sups = out.match(/<sup class="chat-cite">/g) || [];
  assert.equal(sups.length, 2, 'beide Marker werden gerendert');
  assert.ok(/data-tip="D"[^]*data-tip="A"/.test(out), 'Reihenfolge: D zuerst, dann A');
});

test('renderResearchAnswer: gleicher Index zweimal (4-4,4-5) → ein Marker (Parser dedup)', () => {
  const sources = [
    { url: 'https://a.example', title: 'A' },
    { url: 'https://b.example', title: 'B' },
    { url: 'https://c.example', title: 'C' },
    { url: 'https://d.example', title: 'D' },
  ];
  const out = render('Mehr <cite index="4-4,4-5">dazu</cite>.', sources);
  const sups = out.match(/<sup class="chat-cite">/g) || [];
  assert.equal(sups.length, 1, 'Parser dedup führt 4-4,4-5 auf Index [4] → ein Marker');
  assert.match(out, /data-tip="D"/);
});

test('renderResearchAnswer: cite-Index ohne Source → dim-marker', () => {
  const sources = [{ url: 'https://a.example', title: 'A' }];
  const out = render('XX <cite index="2-1">dort</cite> YY', sources);
  // Index 2 hat keine Source → dim, kein <a>.
  assert.match(out, /<sup class="chat-cite chat-cite--dim">2<\/sup>/);
  assert.ok(out.includes('dort'));
});

test('renderResearchAnswer: keine Sources → Tags entwrappen, Text erhalten', () => {
  const out = render('Siehe <cite index="1-1">hier</cite>.', []);
  assert.ok(out.includes('Siehe hier'));
  assert.ok(!out.includes('<cite'));
  assert.ok(!out.includes('<sup'));
});

test('renderResearchAnswer: reste-<cite> ohne index werden entwrapt', () => {
  const out = render('Rest <cite>blah</cite> bleibt', [{ url: 'u', title: 't' }]);
  assert.ok(out.includes('Rest blah bleibt'));
  assert.ok(!out.includes('<cite'));
});

test('renderResearchAnswer: __i18n:Marker geht durch t + renderChatMarkdown', () => {
  const out = render('__i18n:chat.errors.generic__', []);
  assert.equal(out, '[i18n]chat.errors.generic');
});

test('renderResearchAnswer: __i18n:Marker ohne t-Resolver → key als Fallback', () => {
  const out = renderResearchAnswer({
    text: '__i18n:foo.bar__', sources: [],
    renderChatMarkdown: MK, escHtml: ID, t: undefined,
  });
  assert.equal(out, 'foo.bar');
});

test('renderResearchAnswer: escHtml wird nur für url + title aufgerufen', () => {
  let escCalls = [];
  const esc = (s) => { escCalls.push(s); return 'ESC(' + s + ')'; };
  const out = renderResearchAnswer({
    text: '<cite index="1-1">x</cite>',
    sources: [{ url: 'https://a.example/path?a=1&b=2', title: 'A & B' }],
    renderChatMarkdown: MK, escHtml: esc, t: T,
  });
  // url + title beide escaped — NICHT der citae-Inner 'x' (der durch markdown).
  assert.deepEqual(escCalls, ['https://a.example/path?a=1&b=2', 'A & B']);
  assert.ok(out.includes('ESC(https://a.example/path?a=1&b=2)'));
  assert.ok(out.includes('data-tip="ESC(A & B)"'));
});

test('citedSources: distinkt nach url, sortiert nach Index', () => {
  const sources = [
    { url: 'https://c.example', title: 'C' },
    { url: 'https://a.example', title: 'A' },
    { url: 'https://a.example', title: 'A-Dup' },   // dieselbe URL, ignoriert
  ];
  const text = '<cite index="2-1">x</cite>, <cite index="3-2">y</cite>, <cite index="1-1">z</cite>';
  const out = citedSources(text, sources);
  assert.deepEqual(out, [
    { n: 1, url: 'https://c.example', title: 'C' },
    { n: 2, url: 'https://a.example', title: 'A' },
  ]);
});

test('citedSources: leere Sources → []', () => {
  assert.deepEqual(citedSources('<cite index="1">x</cite>', []), []);
});

test('citedSources: Index ohne Source wird übersprungen', () => {
  const sources = [{ url: 'https://a.example', title: 'A' }];
  const out = citedSources('<cite index="1-1">x</cite><cite index="3-1">y</cite>', sources);
  // Index 1 → ok, Index 3 → keine Source → nicht in der Liste.
  assert.deepEqual(out, [{ n: 1, url: 'https://a.example', title: 'A' }]);
});