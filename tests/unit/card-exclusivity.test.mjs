// Tests für app-view: Karten-Exklusivität.
//   - _closeOtherMainCards(keep) schliesst alle Hauptkarten ausser `keep`
//   - Toggle-Funktionen rufen _closeOtherMainCards beim Öffnen
//   - Toggle auf bereits offene Karte: schliesst (Settings/UserSettings/Stil/Heatmap/BookStats/Finetune/BookSettings)
//     oder dispatched card:refresh (Figuren/Orte/Szenen/Ereignisse/Kontinuität/BookReview/BookChat)
//   - Seiten-Chat (showChatCard) ist NICHT in _closeOtherMainCards →
//     bleibt neben Editor offen
import test from 'node:test';
import assert from 'node:assert/strict';
import { appViewMethods } from '../../public/js/app/app-view.js';
import { setLastPageId } from '../../public/js/local-prefs.js';

// localStorage-Stub: `getLastPageId`/`setLastPageId` (local-prefs) sind
// quota-tolerant und liefern ohne Storage still `null` — der Landing-Pfad
// „letzte Seite restaurieren" wäre dann untestbar.
if (!globalThis.localStorage) {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
}

// Minimal-DOM-Stubs für Module die window.dispatchEvent nutzen.
globalThis.window = globalThis.window || { dispatchEvent: () => {} };
globalThis.CustomEvent = globalThis.CustomEvent || class CustomEvent {
  constructor(type, init) { this.type = type; this.detail = init?.detail; }
};

function makeCtx() {
  // Spiegelt cards-Flags aus app-state.js. Default: alles geschlossen.
  // Nav-State lebt in Alpine.store('nav') (kein Root-Proxy mehr): nav-Objekt
  // unter $store.nav + Getter/Setter-Aliasse fuer c.selectedBookId-Mutationen.
  const nav = { selectedBookId: 42, books: [], pages: [], tree: [] };
  return {
    get selectedBookId() { return nav.selectedBookId; },
    set selectedBookId(v) { nav.selectedBookId = v; },
    get pages() { return nav.pages; },
    set pages(v) { nav.pages = v; },
    get tree() { return nav.tree; },
    set tree(v) { nav.tree = v; },
    get books() { return nav.books; },
    set books(v) { nav.books = v; },
    showBookOverviewCard: false,
    showBookReviewCard: false,
    showKapitelReviewCard: false,
    showFiguresCard: false,
    showFigurWerkstattCard: false,
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
    showExportCard: false,
    showPdfExportCard: false,
    showBookOrganizerCard: false,
    showEditorCard: false,
    showChatCard: false,
    showIdeenCard: false,
    showTreeCard: false,
    // resetView-Pflichtdaten
    bookReviewHistory: [],
    showGlobalZeitstrahl: false,
    // Katalog-Daten/-UI leben in Alpine.store('catalog')/('catalogUi'), Job-Daten
    // in Alpine.store('jobs'); resetView schreibt via this.$store.* — Mock spiegelt
    // die Struktur.
    $store: {
      nav,
      catalog: { figuren: [], orte: [], songs: [], szenen: [], globalZeitstrahl: [], zeitstrahlChronology: null },
      catalogUi: {
        figurenStatus: '', figurenProgress: 0, selectedFigurId: null,
        figurenFilters: { kapitel: '', seite: '', suche: '' },
        ereignisseFilters: { figurId: '', kapitel: '', seite: '', subtyp: '', suche: '' },
        szenenUpdatedAt: null, selectedSzeneId: null,
        szenenFilters: { wertung: '', figurId: '', kapitel: '', ortId: '', suche: '' },
        orteUpdatedAt: null, selectedOrtId: null,
        orteFilters: { figurId: '', kapitel: '', szeneId: '', suche: '' },
        songsUpdatedAt: null, selectedSongId: null,
        songsFilters: { figurId: '', kapitel: '', szeneId: '', genre: '', kontextTyp: '', suche: '' },
        kontinuitaetFilters: { figurId: '', kapitel: '', schwere: '' },
      },
      jobs: {
        alleAktualisierenLoading: false, alleAktualisierenStatus: '', alleAktualisierenProgress: 0,
        alleAktualisierenTokIn: 0, alleAktualisierenTokOut: 0, alleAktualisierenTps: null,
        alleAktualisierenLastRun: null,
      },
    },
    batchLoading: false,
    batchProgress: 0,
    batchStatus: '',
    _batchPollTimer: null,
    _komplettPollTimer: null,
    clearBookstackSearch() {},
    currentPage: { id: 7 },
    resetPage() { /* noop */ },
    loadFiguren: async () => {},
    loadOrte: async () => {},
    _ensurePartial: async () => true,
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

test('toggleChatCard: lebt parallel zum Editor (Seiten-Chat-Ausnahme)', async () => {
  // Anders als Hauptkarten ruft toggleChatCard KEIN _closeOtherMainCards.
  // Editor bleibt offen, Tree bleibt offen.
  const c = makeCtx();
  c.showEditorCard = true;
  c.showTreeCard = true;
  await c.toggleChatCard();
  assert.equal(c.showChatCard, true);
  assert.equal(c.showEditorCard, true,
    'Seiten-Chat schliesst Editor NICHT – läuft daneben');
  assert.equal(c.showTreeCard, true);
});

test('toggleStilCard: öffnet & schliesst andere Karten', async () => {
  const c = makeCtx();
  c.showBookReviewCard = true;
  await c.toggleStilCard();
  assert.equal(c.showStilCard, true);
  assert.equal(c.showBookReviewCard, false, 'Andere Hauptkarte muss schliessen');
});

test('toggleStilCard: zweiter Klick schliesst (Settings-Pattern)', async () => {
  const c = makeCtx();
  await c.toggleStilCard();
  await c.toggleStilCard();
  assert.equal(c.showStilCard, false);
});

test('toggleStilCard: zweiter Klick landet auf der Buchuebersicht (keine leere Spalte)', async () => {
  // Schliessen per Toggle muss dieselbe Landung nehmen wie das `x` im
  // Karten-Header (`closeCard`) — sonst steht der User vor einer leeren Ansicht.
  const c = makeCtx();
  await c.toggleStilCard();
  await c.toggleStilCard();
  assert.equal(c.showStilCard, false);
  assert.equal(c.showBookOverviewCard, true, 'Nach dem Schliessen faellt die Ansicht auf die Buchuebersicht zurueck');
});

test('toggleFiguresCard: zweiter Klick dispatcht card:refresh statt zu schliessen', async () => {
  const c = makeCtx();
  const events = [];
  globalThis.window.dispatchEvent = (e) => events.push({ type: e.type, detail: e.detail });
  await c.toggleFiguresCard();
  assert.equal(c.showFiguresCard, true);
  await c.toggleFiguresCard();
  assert.equal(c.showFiguresCard, true,
    'Refresh-Pattern: erneuter Klick schliesst NICHT, sondern dispatcht card:refresh');
  assert.deepEqual(events.pop(), { type: 'card:refresh', detail: { name: 'figuren' } });
});

test('toggleBookChatCard: braucht selectedBookId – ohne Buch kein Open', async () => {
  const c = makeCtx();
  c.selectedBookId = null;
  await c.toggleBookChatCard();
  assert.equal(c.showBookChatCard, false,
    'BookChat ohne Buch-Auswahl darf nicht öffnen');
});

test('toggleChatCard: schliesst Ideen-Card (gleicher Slot neben Editor)', async () => {
  const c = makeCtx();
  c.showIdeenCard = true;
  await c.toggleChatCard();
  assert.equal(c.showChatCard, true);
  assert.equal(c.showIdeenCard, false,
    'Ideen und Chat teilen den Slot – nur eines aktiv');
});

test('toggleChatCard: ohne currentPage nicht öffnen', async () => {
  const c = makeCtx();
  c.currentPage = null;
  await c.toggleChatCard();
  assert.equal(c.showChatCard, false);
});

test('resetView: schliesst alle Hauptkarten und öffnet bookOverview (Home-Klick)', async () => {
  // Regression: figurWerkstatt war früher nicht in resetView gelistet → Home-Klick
  // aus Werkstatt liess Flag true → _maybeOpenBookOverview skipte → keine Übersicht.
  // Mit Registry-driven Reset darf das nicht mehr passieren — neue Karten kommen
  // automatisch durch EXCLUSIVE_CARDS.
  const c = makeCtx();
  c.showFigurWerkstattCard = true;
  await c.resetView();
  assert.equal(c.showFigurWerkstattCard, false, 'Werkstatt-Flag muss nach resetView false sein');
  assert.equal(c.showBookOverviewCard, true, 'bookOverview ist Default-Home');
});

test('resetView: kein zweiter Tab offen → bookOverview öffnet', async () => {
  const c = makeCtx();
  c.showBookOrganizerCard = true;
  c.showExportCard = true;
  c.showPdfExportCard = true;
  await c.resetView();
  assert.equal(c.showBookOrganizerCard, false);
  assert.equal(c.showExportCard, false);
  assert.equal(c.showPdfExportCard, false);
  assert.equal(c.showBookOverviewCard, true);
});

// ── Landing-Race: Übersicht vs. offene Seite ────────────────────────────────
// Ein Buchwechsel triggert zwei Landing-Pfade (resetView aus der Combobox +
// selectedBookId-$watch). Beide awaiten Netz-Fetches (Partial-Load bzw.
// Editor-Partials). Hängt einer davon (Verbindungsverlust), dürfen sie nicht
// beide durchlaufen — sonst stehen Buch-Übersicht UND letzte Seite offen.

// Promise, deren Auflösung der Test kontrolliert (simuliert hängenden Fetch).
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function makeLandingCtx() {
  const c = makeCtx();
  c.currentPage = null;
  c.$store.session = { currentUser: { email: 'a@b.ch' } };
  c.selectPageCalls = [];
  c.selectPage = async (p) => { c.selectPageCalls.push(p.id); c.showEditorCard = true; };
  return c;
}

test('_maybeOpenBookOverview: zweiter Landing-Pfad wird dedupliziert (hängender Partial-Load)', async () => {
  const c = makeLandingCtx();
  c.$store.nav.pages = [{ id: 7 }];
  setLastPageId('a@b.ch', 42, 7); // Pfad B würde diese Seite restaurieren
  const d = deferred();
  c._ensurePartial = () => d.promise;

  // Pfad A (resetView aus der Buchwahl-Combobox) hängt im Partial-Fetch.
  const pA = c._maybeOpenBookOverview({ restoreLastPage: false });
  // Pfad B (selectedBookId-$watch) läuft los, während A noch hängt.
  await c._maybeOpenBookOverview();
  assert.deepEqual(c.selectPageCalls, [],
    'zweiter Landing-Pfad darf keine Seite restaurieren, solange der erste läuft');

  d.resolve(true);
  await pA;
  assert.equal(c.showBookOverviewCard, true);
  assert.equal(c.showEditorCard, false, 'Übersicht UND Seite dürfen nie gleichzeitig offen sein');
});

test('_maybeOpenBookOverview: öffnet nicht über eine während des Awaits geöffnete Seite', async () => {
  const c = makeLandingCtx();
  const d = deferred();
  c._ensurePartial = () => d.promise;

  const p = c._maybeOpenBookOverview({ restoreLastPage: false });
  // Während der Partial-Fetch hängt, öffnet ein anderer Pfad (Sidebar-Klick,
  // Hash-Router) die Seite.
  c.showEditorCard = true;
  d.resolve(true);
  await p;
  assert.equal(c.showBookOverviewCard, false,
    'Re-Check nach dem await muss das blinde Öffnen verhindern');
  assert.equal(c.showEditorCard, true);
});

test('_maybeOpenBookOverview: Buchwechsel während des Awaits → keine Übersicht des alten Buchs', async () => {
  const c = makeLandingCtx();
  const d = deferred();
  c._ensurePartial = () => d.promise;

  const p = c._maybeOpenBookOverview({ restoreLastPage: false });
  c.$store.nav.selectedBookId = 43;
  d.resolve(true);
  await p;
  assert.equal(c.showBookOverviewCard, false);
});

test('_maybeOpenBookOverview: fehlgeschlagener Partial-Load öffnet keine leere Hülle', async () => {
  const c = makeLandingCtx();
  c._ensurePartial = async () => false;
  await c._maybeOpenBookOverview({ restoreLastPage: false });
  assert.equal(c.showBookOverviewCard, false);
});

test('selectPage: re-assertet Exklusivität nach den Partial-Awaits', async (t) => {
  // Gegenrichtung des Races: der Editor lädt seine Partials, währenddessen
  // schaltet ein Landing-Pfad die Übersicht sichtbar. Ohne Re-Assert bliebe
  // sie neben dem Editor stehen.
  const c = makeCtx();
  c.currentPage = null;
  c.editMode = false;
  c.editDirty = false;
  c.$store.session = { currentUser: { email: 'a@b.ch' } };
  const d = deferred();
  c._ensurePartial = () => d.promise;
  c.$nextTick = (fn) => { if (fn) fn(); };
  c._scrollToEditorCard = () => {};
  c._loadPageBadgeCounts = () => {};
  c._loadCurrentPageContent = async () => true;
  c.loadChapterFigures = () => {};
  c.loadPageHistory = async () => {};
  c.startCheckPoll = () => {};
  c.t = (k) => k;
  // selectPage fragt am Ende `/jobs/active` ab — hier stumm beantworten,
  // sonst rauscht der echte fetch (relative URL) in die Testausgabe.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
  t.after(() => { globalThis.fetch = realFetch; });

  const p = c.selectPage({ id: 7 });
  c.showBookOverviewCard = true; // Landing-Pfad kommt dazwischen
  d.resolve(true);
  await p;
  assert.equal(c.showEditorCard, true);
  assert.equal(c.showBookOverviewCard, false,
    'Buchkarte, die während des Partial-Loads aufging, muss beim Editor-Commit schliessen');
  assert.equal(c.currentPage.id, 7);
});

test('toggleKontinuitaetCard: refresh-Pattern beim erneuten Klick', async () => {
  const c = makeCtx();
  const events = [];
  globalThis.window.dispatchEvent = (e) => events.push({ type: e.type, detail: e.detail });
  await c.toggleKontinuitaetCard();
  assert.equal(c.showKontinuitaetCard, true);
  await c.toggleKontinuitaetCard();
  assert.equal(c.showKontinuitaetCard, true);
  const last = events.pop();
  assert.equal(last.type, 'card:refresh');
  assert.equal(last.detail.name, 'kontinuitaet');
});

test('closeCard: schliesst eine Refresh-Karte wirklich und landet auf der Übersicht', async () => {
  // Das `x` im Karten-Header darf NICHT den Toggle rufen: Karten mit
  // `onReclick: 'refresh'` (hier Quellenverzeichnis) deuten den zweiten Aufruf
  // als Neuladen — die Karte bliebe offen. closeCard schliesst hart und öffnet
  // danach die Buchübersicht, damit keine leere Spalte stehenbleibt.
  const c = makeCtx();
  const events = [];
  globalThis.window.dispatchEvent = (e) => events.push({ type: e.type, detail: e.detail });
  c.showSourcesCard = true;
  await c.closeCard('sources');
  assert.equal(c.showSourcesCard, false, 'Karte muss geschlossen sein');
  assert.equal(c.showBookOverviewCard, true, 'Buchübersicht übernimmt');
  assert.ok(!events.some(e => e.type === 'card:refresh'),
    'kein Refresh-Dispatch — das wäre der Toggle-Pfad');
});

test('closeCard: unbekannter Key + bereits geschlossene Karte sind No-Ops', async () => {
  const c = makeCtx();
  await c.closeCard('gibtsnicht');
  assert.equal(c.showBookOverviewCard, false, 'kein Landing-Pfad ohne geschlossene Karte');
  c.showSourcesCard = false;
  await c.closeCard('sources');
  assert.equal(c.showBookOverviewCard, false);
});
