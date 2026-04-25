// buildChatSystemPrompt: offene Ideen werden als eigene Section eingespielt.
// Wenn keine Ideen vorhanden sind, darf die Section nicht erscheinen.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildChatSystemPrompt } = await import('../../public/js/prompts.js');

test('Ideen-Section: ohne Ideen kein Block', () => {
  const out = buildChatSystemPrompt('Seite A', 'Inhalt.', [], null);
  assert.ok(!out.includes('OFFENE IDEEN'));
});

test('Ideen-Section: mit Ideen erscheint Block + Hinweis', () => {
  const ideen = [
    { content: 'Szene mit Storm einfügen.', created_at: '2026-04-25T10:00:00.000Z' },
    { content: 'Verbindung zu Kapitel 3 hinterfragen.', created_at: '2026-04-25T11:00:00.000Z' },
  ];
  const out = buildChatSystemPrompt('Seite A', 'Inhalt.', [], null, null, null, ideen);
  assert.ok(out.includes('=== OFFENE IDEEN (Notizen des Autors für diese Seite) ==='));
  assert.ok(out.includes('Szene mit Storm einfügen.'));
  assert.ok(out.includes('Verbindung zu Kapitel 3 hinterfragen.'));
  assert.ok(out.includes('2026-04-25')); // Datum sichtbar
  assert.ok(out.includes('wandle sie aber nicht eigenmächtig in vorschlaege-Einträge'));
});

test('Ideen-Section: leeres Array erzeugt keinen Block', () => {
  const out = buildChatSystemPrompt('Seite A', 'Inhalt.', [], null, null, null, []);
  assert.ok(!out.includes('OFFENE IDEEN'));
});
