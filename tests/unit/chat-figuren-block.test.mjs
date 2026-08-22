// Figuren-Block der Chat-Prompts: das Zeichenbudget MUSS greifen.
//
// `getFiguren` liefert Volldossiers (Szenen, Schauplätze, Beziehungen,
// Lebensereignisse je Figur). Ungekappt ist dieser Block bei einem ausanalysierten
// Buch mehrere Hunderttausend Zeichen gross und sprengt jedes Kontextfenster, bevor
// eine Zeile Buchtext oder ein Werkzeug-Ergebnis im Prompt steht — der Call scheitert
// dann am Preflight (lib/ai/shared.js#assertPromptFitsContext). Genau diese Grenze
// prüft die Suite; dazu die Offenlegung: was der Block nicht trägt, wird als fehlend
// AUSGEWIESEN, damit das Modell ein gekapptes Ensemble nicht für das ganze hält.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync(new URL('../../prompt-config.json', import.meta.url), 'utf8'));
const facade = await import('../../public/js/prompts.js');
facade.configurePrompts(cfg, 'claude');
const { buildFigurenBlock, buildBookChatAgentSystemPrompt, buildBookChatSystemPrompt, buildChatSystemPrompt } =
  await import('../../public/js/prompts/chat.js');

/** Figur mit Volldossier — `detail` steuert die Menge der Detaileinträge. */
function figur(i, detail = 0) {
  return {
    id: `fig_${i}`, name: `Figur ${i}`, kurzname: `F${i}`, typ: 'nebenfigur',
    beschreibung: `Beschreibung der Figur ${i}. `.repeat(6),
    beruf: 'Schreiner', geschlecht: 'm',
    eigenschaften: ['ruhig', 'zäh'], kapitel: ['Kapitel 1'],
    ...(detail ? {
      lebensereignisse: Array.from({ length: detail }, (_, k) => ({ datum: `19${70 + k}`, ereignis: `Ereignis ${k} `.repeat(10), typ: 'wende' })),
      beziehungen:      Array.from({ length: detail }, (_, k) => ({ mit: `fig_${k}`, typ: 'freund', beschreibung: `Beziehung ${k} `.repeat(10) })),
      'schauplätze':    Array.from({ length: detail }, (_, k) => ({ name: `Ort ${k}`, beschreibung: `Ortsbeschreibung ${k} `.repeat(10) })),
      szenen:           Array.from({ length: detail }, (_, k) => ({ titel: `Szene ${k}`, kommentar: `Kommentar ${k} `.repeat(10) })),
    } : {}),
  };
}

const joinBlocks = (blocks) => blocks.map(b => b.text).join('\n\n');

test('leeres Ensemble erzeugt keinen Block', () => {
  assert.equal(buildFigurenBlock([]), null);
  assert.equal(buildFigurenBlock(null), null);
});

test('kleines Ensemble bleibt Volldossier', () => {
  const list = [figur(1, 2), figur(2, 2)];
  const blk = buildFigurenBlock(list, { maxChars: 100000 });
  assert.equal(blk.mode, 'voll');
  assert.equal(blk.shown, 2);
  assert.match(blk.text, /=== FIGUREN DES BUCHS ===/);
  assert.match(blk.text, /"szenen"/);           // Details sind noch drin
  assert.ok(!blk.text.includes('weggelassen'));
});

test('Dossiers über Budget fallen auf Stammdaten mit Anzahl-Angabe', () => {
  const list = Array.from({ length: 8 }, (_, i) => figur(i, 4));
  const voll = buildFigurenBlock(list, { maxChars: 10 ** 9 });
  const blk = buildFigurenBlock(list, { maxChars: Math.floor(voll.chars / 2) });
  assert.equal(blk.mode, 'stamm');
  assert.equal(blk.shown, list.length, 'Stammdaten-Stufe zeigt ALLE Figuren');
  assert.ok(blk.chars <= Math.floor(voll.chars / 2));
  assert.ok(!blk.text.includes('"szenen":['), 'Detaillisten sind weg');
  assert.match(blk.text, /"weggelassen":\{[^}]*"szenen":4/, 'Anzahl der Detaileinträge bleibt sichtbar');
});

test('auch die Stammdaten werden gekappt — und die Kappung offengelegt', () => {
  const list = Array.from({ length: 60 }, (_, i) => figur(i, 3));
  const blk = buildFigurenBlock(list, { maxChars: 6000 });
  assert.equal(blk.mode, 'gekappt');
  assert.ok(blk.chars <= 6000, `Block hält das Budget (${blk.chars})`);
  assert.ok(blk.shown > 0 && blk.shown < 60);
  assert.match(blk.text, new RegExp(`NUR ${blk.shown} von 60 Figuren`));
  assert.match(blk.text, /weitere fehlen/);
  assert.match(blk.text, /"id":"fig_0"/, 'die erste Figur (sort_order) bleibt drin');
  assert.ok(JSON.parse(blk.text.slice(blk.text.indexOf('['))).length === blk.shown, 'Rest bleibt gültiges JSON');
});

test('detailTools nennt die Nachlade-Werkzeuge nur im agentischen Pfad', () => {
  const list = Array.from({ length: 40 }, (_, i) => figur(i, 3));
  const mitTools = buildFigurenBlock(list, { maxChars: 6000, detailTools: true });
  const ohne     = buildFigurenBlock(list, { maxChars: 6000 });
  assert.match(mitTools.text, /get_figure_profile/);
  assert.ok(!ohne.text.includes('get_figure_profile'));
  assert.match(ohne.text, /NICHT als vollständiges Ensemble/);
});

test('alle drei Chat-Prompts kappen den Figuren-Block', () => {
  const list = Array.from({ length: 60 }, (_, i) => figur(i, 4));
  const unbudgeted = JSON.stringify(list, null, 2).length;
  const maxChars = 8000;

  const agent = joinBlocks(buildBookChatAgentSystemPrompt('Buch', list, null, null, 6, { figurenMaxChars: maxChars }));
  const buch  = joinBlocks(buildBookChatSystemPrompt('Buch', [], list, null, null, { figurenMaxChars: maxChars }));
  const seite = joinBlocks(buildChatSystemPrompt('Seite', 'Text.', list, null, null, null, null, null, { figurenMaxChars: maxChars }));

  for (const [name, prompt] of [['agentisch', agent], ['klassisch', buch], ['seite', seite]]) {
    assert.ok(prompt.length < unbudgeted / 2, `${name}: Prompt trägt nicht mehr das ganze Dossier-Konvolut`);
    assert.match(prompt, /=== FIGUREN DES BUCHS ===/, `${name}: Block existiert weiterhin`);
    assert.match(prompt, /NUR \d+ von 60 Figuren/, `${name}: Kappung ist offengelegt`);
  }
});
