// Erst-Kontext des agentischen Buch-Chats: Block-Form + Cache-Lage.
//
// Gegenstand ist die Kosten-Invariante aus docs/buchchat-tools.md: der Erst-Kontext
// steht als LETZTER System-Block und traegt KEINEN Cache-Breakpoint (er wechselt pro
// Frage), waehrend Block 1 der stabile Praefix ueber alle Iterationen bleibt. Faellt
// das um, bezahlt jede Iteration Tools + System erneut — genau der Kostenpfad, den
// der Erst-Kontext schliessen soll.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Facade konfigurieren (setzt SYSTEM_BOOK_CHAT); der Erst-Kontext-Baustein selbst ist
// interner Helfer von prompts/chat.js und wird von dort direkt importiert.
const cfg = JSON.parse(readFileSync(new URL('../../prompt-config.json', import.meta.url), 'utf8'));
const facade = await import('../../public/js/prompts.js');
facade.configurePrompts(cfg, 'claude');
const { buildBookChatAgentSystemPrompt, buildBookChatPreContext } =
  await import('../../public/js/prompts/chat.js');

const PASSAGES = [
  { kind: 'page', entity_id: 7, title: 'Kapitel 1, Seite 2', score: 0.812, text: 'Stefan war damals achtundzwanzig.' },
  { kind: 'figure', entity_id: 3, title: 'Stefan', score: 0.44, text: 'Lehrer, in Bern aufgewachsen.' },
];

test('Agent-System-Prompt: zwei Bloecke, Erst-Kontext zuletzt und ohne Breakpoint', () => {
  const blocks = buildBookChatAgentSystemPrompt('Buch', null, null, null, 12, { passages: PASSAGES });
  assert.equal(Array.isArray(blocks), true, 'Rueckgabe muss ein Block-Array sein');
  assert.equal(blocks.length, 2);
  // Block 1: stabiler Praefix mit Extended-TTL.
  assert.equal(blocks[0].ttl, '1h');
  assert.notEqual(blocks[0].cache, false);
  // Block 2: volatil, KEIN Breakpoint, und er ist der letzte.
  assert.equal(blocks[1].cache, false);
  assert.equal(blocks[1].ttl, undefined);
  assert.match(blocks[1].text, /ERST-KONTEXT/);
  assert.doesNotMatch(blocks[0].text, /ERST-KONTEXT: SEMANTISCH/);
});

test('Agent-System-Prompt: Kosten-Leiter steht im stabilen Block', () => {
  const [stable] = buildBookChatAgentSystemPrompt('Buch', null, null, null, 12, {});
  assert.match(stable.text, /KOSTEN-LEITER/);
  assert.match(stable.text, /Stufe 1 \(gratis, schon da\)/);
  assert.match(stable.text, /Stufe 3 \(teuer, Volltext\)/);
  // search_similar muss in der Werkzeug-Anleitung vorkommen — ohne das kennt das
  // Modell den billigen Bedeutungs-Pfad nicht und rate mit search_passages.
  assert.match(stable.text, /search_similar/);
});

test('Erst-Kontext-Block: Passagen mit entity_id als Sprungziel', () => {
  const text = buildBookChatPreContext(PASSAGES);
  assert.match(text, /entity_id 7/);
  assert.match(text, /Stefan war damals achtundzwanzig\./);
  assert.match(text, /final_answer/);
  // Zitat-Invariante: aus dem Ausschnitt darf nicht wortwoertlich zitiert werden.
  assert.match(text, /quote_match/);
});

test('Erst-Kontext-Block: ohne Treffer bleibt der Block mit Begruendung stehen', () => {
  for (const empty of [[], null, undefined]) {
    const text = buildBookChatPreContext(empty);
    assert.match(text, /ERST-KONTEXT/, 'Block darf nie ganz fehlen (sonst liest das Modell «kein Index»)');
    assert.match(text, /Keine Treffer/);
  }
});
