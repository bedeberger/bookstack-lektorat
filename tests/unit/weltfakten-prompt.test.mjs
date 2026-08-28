// Unit: Weltfakten in den Prompts — vier Einbauorte, EINE gemeinsame Invariante.
//
// `world_facts` ist ein abgeleiteter Index mit Full-Replace: leer heisst „nie
// analysiert", nicht „diese Welt hat keine Regeln". Jeder Einbauort muss den Block
// darum WEGLASSEN statt Regelfreiheit zu behaupten — sonst urteilt das Modell gegen
// eine Abwesenheit, die es nie gemessen hat. Zweite Invariante: was ein Deckel
// geschluckt hat, wird ausgewiesen (kein gekappter Kanon, der als ganzer gilt).
import test from 'node:test';
import assert from 'node:assert';

const chat = await import('../../public/js/prompts/chat.js');
const plot = await import('../../public/js/prompts/plot.js');
const werkstatt = await import('../../public/js/prompts/figur-werkstatt.js');
const review = await import('../../public/js/prompts/review/builders.js');

const FAKTEN = [
  { kategorie: 'regel', subjekt: 'Magie', fakt: 'Tote kehren nie zurueck.', kapitel: ['Kap 2'] },
  { kategorie: 'kultur', subjekt: null, fakt: 'Man gruesst mit der linken Hand.', kapitel: [] },
];

// ── Buch-Chat: gebudgeteter Block im STABILEN (gecachten) System-Anteil ──────

test('Buch-Chat: Block traegt Fakten, Kategorie und Kapitel', () => {
  const b = chat.buildWeltfaktenBlock({ scanned: true, fakten: FAKTEN });
  assert.match(b.text, /ETABLIERTE WELT-FAKTEN/);
  assert.match(b.text, /\[regel\] Magie: Tote kehren nie zurueck\. \(Kap 2\)/);
  assert.equal(b.shown, 2);
  assert.equal(b.total, 2);
});

test('Buch-Chat: nicht erhobener Index → gar kein Block', () => {
  assert.equal(chat.buildWeltfaktenBlock({ scanned: false, fakten: [] }), null);
  assert.equal(chat.buildWeltfaktenBlock({ scanned: true, fakten: [] }), null);
  assert.equal(chat.buildWeltfaktenBlock(null), null);
});

test('Buch-Chat: der Block sagt, dass die Fakten extrahiert und nicht kuratiert sind', () => {
  const b = chat.buildWeltfaktenBlock({ scanned: true, fakten: FAKTEN });
  assert.match(b.text, /nicht von der Autorin kuratiert/);
  assert.match(b.text, /im Zweifel gilt der Buchtext/);
});

test('Buch-Chat: Deckel kappt an der Faktengrenze und weist den Rest aus', () => {
  const viele = Array.from({ length: 200 }, (_, i) => ({
    kategorie: 'kultur', subjekt: `S${i}`, fakt: `Eine ziemlich lange Aussage ueber die Welt Nummer ${i}.`, kapitel: [],
  }));
  const b = chat.buildWeltfaktenBlock({ scanned: true, fakten: viele }, { maxChars: 1500 });
  assert.ok(b.chars <= 1500, `Block sprengt den Deckel (${b.chars})`);
  assert.ok(b.shown < b.total);
  assert.match(b.text, new RegExp(`NUR ${b.shown} von ${b.total} Fakten`));
  assert.match(b.text, /NICHT der vollständige Kanon/);
});

test('Buch-Chat: beim Kappen fallen zuerst die Nicht-Weltgesetze weg', () => {
  const fakten = [
    ...Array.from({ length: 50 }, (_, i) => ({ kategorie: 'sonstiges', fakt: `Beiwerk ${i} mit etwas Text dran.`, kapitel: [] })),
    { kategorie: 'regel', subjekt: 'Magie', fakt: 'Die tragende Regel der Welt.', kapitel: [] },
  ];
  const b = chat.buildWeltfaktenBlock({ scanned: true, fakten }, { maxChars: 800 });
  assert.match(b.text, /Die tragende Regel der Welt/,
    'die Regel muss den Deckel ueberleben, das Beiwerk darf fallen');
});

// ── Plot-Consistency: Weltgesetze als Pruefstein ────────────────────────────

const ACTS = [{ id: 1, name: 'Akt 1' }];
const BEATS = [{ id: 10, act_id: 1, titel: 'Aufbruch', status: 'geplant', verworfen: 0 }];
const GESETZE = [{ kategorie: 'regel', subjekt: 'Magie', fakt: 'Tote kehren nie zurueck.', kapitel: ['Kap 2'] }];
const plotPrompt = (welt) =>
  plot.buildPlotConsistencyPrompt(ACTS, BEATS, [], [], [], '', [], [], [], [], [], [], null, {}, [], welt);

test('Plot: Weltgesetze erscheinen samt Pruefpunkt', () => {
  const p = plotPrompt(GESETZE);
  assert.match(p, /ETABLIERTE WELTGESETZE/);
  assert.match(p, /Tote kehren nie zurueck/);
  assert.match(p, /Verstoss gegen ein Weltgesetz/);
});

test('Plot: ohne Weltgesetze kein Block UND kein Pruefpunkt', () => {
  for (const leer of [undefined, [], null]) {
    const p = plotPrompt(leer);
    assert.doesNotMatch(p, /WELTGESETZ/, 'kein Block ohne erhobene Fakten');
    assert.doesNotMatch(p, /Verstoss gegen ein Weltgesetz/,
      'ohne Fakten darf kein Pruefpunkt entstehen, den das Modell gegen Nichts prueft');
  }
});

test('Plot: der bewusste Regelbruch ist explizit KEIN Befund', () => {
  const p = plotPrompt(GESETZE);
  assert.match(p, /bewusst gesetzter Regelbruch/);
  assert.match(p, /extrahiert, nicht von der Autorin kuratiert/);
});

// ── Figuren-Werkstatt-Consistency ───────────────────────────────────────────

const MM = { data: { id: 'root', topic: 'Mara', children: [] } };
const werkstattPrompt = (welt) =>
  werkstatt.buildConsistencyPrompt('Mara', 'protagonist', MM, '', [], [], [], null, [], [], welt);

test('Werkstatt: Weltgesetze erscheinen samt Pruefpunkt', () => {
  const p = werkstattPrompt(GESETZE);
  assert.match(p, /ETABLIERTE WELTGESETZE/);
  assert.match(p, /Verstoss gegen ein Weltgesetz/);
});

test('Werkstatt: ohne Weltgesetze kein Block UND kein Pruefpunkt', () => {
  const p = werkstattPrompt([]);
  assert.doesNotMatch(p, /WELTGESETZ/);
  assert.doesNotMatch(p, /Verstoss gegen ein Weltgesetz/);
});

// ── Buchbewertung: die Messung, nicht die Schaetzung ────────────────────────

const WELT_CTX = {
  gesamt: 4,
  proKategorie: [{ kategorie: 'regel', anzahl: 2 }, { kategorie: 'ort', anzahl: 2 }],
  topSubjekte: [{ subjekt: 'Magie', anzahl: 2 }],
  kapitelAbdeckung: { gesamt: 6, mitFakten: 3, ohneFakten: ['K4', 'K5'], ohneFaktenGekuerzt: 1 },
  ohneKapitelBezug: 1,
  bogen: { anfang: 3, mitte: 1, schluss: 0 },
  beispiele: [{ kategorie: 'regel', subjekt: 'Magie', fakt: 'Tote kehren nie zurueck.' }],
};

test('Bewertung: Block erscheint in Single- UND Multi-Pass', () => {
  const single = review.buildBookReviewSinglePassPrompt('B', 10, 'text', { weltContext: WELT_CTX });
  const multi = review.buildBookReviewMultiPassPrompt('B', [{ name: 'K1', pageCount: 2 }], 10, { weltContext: WELT_CTX });
  for (const p of [single, multi]) {
    assert.match(p, /WELTAUFBAU-BEFUNDE/);
    assert.match(p, /Verteilung über den Buchbogen/);
    assert.match(p, /Ohne etablierten Fakt: K4, K5 … und 1 weitere/);
    assert.match(p, /Naben der Welt/);
  }
});

test('Bewertung: die drei Fehllesungen sind im Block abgefangen', () => {
  const p = review.buildBookReviewSinglePassPrompt('B', 10, 'text', { weltContext: WELT_CTX });
  assert.match(p, /automatisch EXTRAHIERT, kein von der Autorin kuratierter Kanon/);
  assert.match(p, /NICHT weltarm/);
  assert.match(p, /Kammerspiel/);
  // Fakten ohne Kapitelbezug werden ausgewiesen, damit der Bogen nicht vollstaendig scheint.
  assert.match(p, /1 Fakten ohne Kapitelbezug/);
});

test('Bewertung: ohne Messung kein Block (nicht erhoben ≠ weltarm)', () => {
  const p = review.buildBookReviewSinglePassPrompt('B', 10, 'text', {});
  assert.doesNotMatch(p, /WELTAUFBAU/);
  const p0 = review.buildBookReviewSinglePassPrompt('B', 10, 'text', { weltContext: { gesamt: 0 } });
  assert.doesNotMatch(p0, /WELTAUFBAU/);
});

test('Bewertung: der Befund zeigt auf eine BESTEHENDE Achse des Profils', async () => {
  const { bookReviewAxes } = await import('../../public/js/prompts/review-typen.js');
  for (const buchtyp of [null, 'roman', 'sachbuch', 'dissertation', 'journalismus', 'lyrik']) {
    const p = review.buildBookReviewSinglePassPrompt('B', 10, 'text', { buchtyp, weltContext: WELT_CTX });
    const achse = p.match(/Nutze die Zahlen für die Achse "([^"]+)"/)?.[1];
    assert.ok(achse, `keine Achse im Block (buchtyp=${buchtyp})`);
    const keys = bookReviewAxes(buchtyp).map(a => a.key);
    assert.ok(keys.includes(achse),
      `Achse «${achse}» existiert im Profil von «${buchtyp}» nicht (${keys.join(', ')})`);
  }
});
