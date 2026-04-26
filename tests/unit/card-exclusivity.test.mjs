// Tests für app-view: Karten-Exklusivität.
//   - _closeOtherMainCards(keep) schliesst alle Hauptkarten ausser `keep`
//   - Toggle-Funktionen rufen _closeOtherMainCards beim Öffnen
//   - Toggle auf bereits offene Karte: schliesst (Settings/UserSettings/Stil/Heatmap/BookStats/Finetune/BookSettings)
//     oder dispatched card:refresh (Figuren/Orte/Szenen/Ereignisse/Kontinuität/BookReview/BookChat)
//   - Seiten-Chat (showChatCard) ist NICHT in _closeOtherMainCards →
//     bleibt neben Editor offen
import test from 'node:test';
import assert from 'node:assert/strict';
import { appViewMethods } from '../../public/js/app-view.js';

// Minimal-DOM-Stubs für Module die window.dispatchEvent nutzen.
globalThis.window = globalThis.window || { dispatchEvent: () => {} };
globalThis.CustomEvent = globalThis.CustomEvent || class CustomEvent {
  constructor(type, init) { this.type = type; this.detail = init?.detail; }
};

function makeCtx() {
  // Spiegelt cards-Flags aus app-state.js. Default: alles geschlossen.
  return {
    showBookReviewCard: false,
    showKapitelReviewCard: false,
    showFiguresCard: false,
    showSzenenCard: false,
    showEreignisseCard: false,
    showBookStatsCard: false,
    showStilCard: false,
    showFehlerHeatmapCard: false,
    showBookChatCard: false,
    showOrteCard: false,
    showKontinuitaetCard: false,
    showBookSettingsCard: false,
    showUserSettingsCard: false,
    showFinetuneExportCard: false,
    showEditorCard: false,
    showChatCard: false,
    showIdeenCard: false,
    showTreeCard: false,
    selectedBookId: 42,
    currentPage: { id: 7 },
    figuren: [],
    orte: [],
    pages: [],
    resetPage() { /* noop */ },
    loadFiguren: async () => {},
    loadOrte: async () => {},
    ...appViewMethods,
  };
}

test('_closeOtherMainCards: keep="figures" → schliesst alle anderen', () => {
  const c = makeCtx();
  c.showBookReviewCard = true;
  c.showFiguresCard = true;
  c.showOrteCard = true;
  c.showStilCard = true;
  c.showBookStatsCard = true;
  c._closeOtherMainCards('figures');
  assert.equal(c.showFiguresCard, true, 'keep-Karte bleibt offen');
  assert.equal(c.showBookReviewCard, false);
  assert.equal(c.showOrteCard, false);
  assert.equal(c.showStilCard, false);
  assert.equal(c.showBookStatsCard, false);
});

test('_closeOtherMainCards: keep="none" → schliesst alle Hauptkarten', () => {
  const c = makeCtx();
  c.showBookReviewCard = true;
  c.showFiguresCard = true;
  c.showOrteCard = true;
  c.showStilCard = true;
  c.showBookChatCard = true;
  c._closeOtherMainCards('none');
  assert.equal(c.showBookReviewCard, false);
  assert.equal(c.showFiguresCard, false);
  assert.equal(c.showOrteCard, false);
  assert.equal(c.showStilCard, false);
  assert.equal(c.showBookChatCard, false);
});

test('_closeOtherMainCards: schliesst Editor + Seiten-Chat (Seitenebene exklusiv mit Buchebene)', () => {
  // CLAUDE.md: Buch- und Seitenebene sind gegenseitig exklusiv.
  // _closeOtherMainCards ruft resetPage(), das den Editor + Seiten-Chat
  // schliesst. Tree bleibt aktiv (eigener Bereich).
  const c = makeCtx();
  c.showEditorCard = true;
  c.showChatCard = true;
  c.showTreeCard = true;
  c.showFiguresCard = true;
  c._closeOtherMainCards('figures');
  assert.equal(c.showEditorCard, false, 'Editor schliesst beim Wechsel auf Buch-Karte');
  assert.equal(c.showChatCard, false, 'Seiten-Chat schliesst mit dem Editor');
  assert.equal(c.showTreeCard, true, 'Tree bleibt aktiv');
});

test('toggleChatCard: lebt parallel zum Editor (Seiten-Chat-Ausnahme)', () => {
  // Anders als Hauptkarten ruft toggleChatCard KEIN _closeOtherMainCards.
  // Editor bleibt offen, Tree bleibt offen.
  const c = makeCtx();
  c.showEditorCard = true;
  c.showTreeCard = true;
  c.toggleChatCard();
  assert.equal(c.showChatCard, true);
  assert.equal(c.showEditorCard, true,
    'Seiten-Chat schliesst Editor NICHT – läuft daneben');
  assert.equal(c.showTreeCard, true);
});

test('toggleStilCard: öffnet & schliesst andere Karten', () => {
  const c = makeCtx();
  c.showBookReviewCard = true;
  c.toggleStilCard();
  assert.equal(c.showStilCard, true);
  assert.equal(c.showBookReviewCard, false, 'Andere Hauptkarte muss schliessen');
});

test('toggleStilCard: zweiter Klick schliesst (Settings-Pattern)', () => {
  const c = makeCtx();
  c.toggleStilCard();
  c.toggleStilCard();
  assert.equal(c.showStilCard, false);
});

test('toggleFiguresCard: zweiter Klick dispatcht card:refresh statt zu schliessen', () => {
  const c = makeCtx();
  const events = [];
  globalThis.window.dispatchEvent = (e) => events.push({ type: e.type, detail: e.detail });
  c.toggleFiguresCard();
  assert.equal(c.showFiguresCard, true);
  c.toggleFiguresCard();
  assert.equal(c.showFiguresCard, true,
    'Refresh-Pattern: erneuter Klick schliesst NICHT, sondern dispatcht card:refresh');
  assert.deepEqual(events.pop(), { type: 'card:refresh', detail: { name: 'figuren' } });
});

test('toggleBookChatCard: braucht selectedBookId – ohne Buch kein Open', () => {
  const c = makeCtx();
  c.selectedBookId = null;
  c.toggleBookChatCard();
  assert.equal(c.showBookChatCard, false,
    'BookChat ohne Buch-Auswahl darf nicht öffnen');
});

test('toggleChatCard: schliesst Ideen-Card (gleicher Slot neben Editor)', () => {
  const c = makeCtx();
  c.showIdeenCard = true;
  c.toggleChatCard();
  assert.equal(c.showChatCard, true);
  assert.equal(c.showIdeenCard, false,
    'Ideen und Chat teilen den Slot – nur eines aktiv');
});

test('toggleChatCard: ohne currentPage nicht öffnen', () => {
  const c = makeCtx();
  c.currentPage = null;
  c.toggleChatCard();
  assert.equal(c.showChatCard, false);
});

test('toggleKontinuitaetCard: refresh-Pattern beim erneuten Klick', () => {
  const c = makeCtx();
  const events = [];
  globalThis.window.dispatchEvent = (e) => events.push({ type: e.type, detail: e.detail });
  c.toggleKontinuitaetCard();
  assert.equal(c.showKontinuitaetCard, true);
  c.toggleKontinuitaetCard();
  assert.equal(c.showKontinuitaetCard, true);
  const last = events.pop();
  assert.equal(last.type, 'card:refresh');
  assert.equal(last.detail.name, 'kontinuitaet');
});
