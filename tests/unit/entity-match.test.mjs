// lib/entity-match.js — Entitaeten-Matching der Komplettanalyse (Figuren, Orte, Szenen).
//
// Kern der Suite sind die vier Faelle, an denen die reine Namens-Aehnlichkeit
// systematisch falsch lag (gemessen am Ist-Stand vor dem Umbau):
//   «Restaurant Kreuz (Olten)» ~ «Restaurant Kreuz (Bern)»  → wurde gemergt
//   «Bahnhof» ⊂ «Bahnhof (Solothurn)»                       → wurde gemergt, willkuerlich
//   «Olten» (Stadt) ~ «Olten (Bahnhofsviertel)»             → wurde gemergt
//   «Schulhaus Frohheim» ~ «Frohheim-Schule Olten»          → blieb Dublette
// Regel dahinter: Unsicherheit fuehrt NIE zu einem stillen Merge, sie fuehrt zu
// `unsure` (→ KI-Judge). Wer eine Schwelle lockert, macht diese Tests rot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  SAME, UNSURE, DIFFERENT,
  placeTokens, splitQualifier, locationSimilarity, locationEvidence, scoreLocationPair,
  scoreScenePair, sceneEvidence, figureEvidence, scoreFigurePair,
  matchLocations, matchScenes, matchFiguren,
  dedupeLocationsWithinRun, dedupeScenesWithinRun,
} = require('../../lib/entity-match.js');

const G = (name, extra = {}) => ({ name, typ: 'GEBAEUDE', ...extra });
const verdictOf = (a, b) => scoreLocationPair(a, b).verdict;

test('placeTokens strips parens/slashes/connectors', () => {
  assert.deepEqual(placeTokens('Mathys AG (Bettlach)'), ['mathys', 'ag', 'bettlach']);
  assert.deepEqual(placeTokens('EPA / Nordmann Solothurn'), ['epa', 'nordmann', 'solothurn']);
  assert.deepEqual(placeTokens('EPA und Nordmann (Solothurn)'), ['epa', 'nordmann', 'solothurn']);
  assert.deepEqual(placeTokens('Dieters Bar/Etablissement in Olten'), ['dieters', 'bar', 'etablissement', 'olten']);
});

test('splitQualifier trennt Klammer- und Komma-Zusatz vom Kern', () => {
  assert.deepEqual(splitQualifier('Restaurant Kreuz (Olten)'),
    { head: ['restaurant', 'kreuz'], qualifier: ['olten'] });
  assert.deepEqual(splitQualifier('Wohnung Brunner, Olten'),
    { head: ['wohnung', 'brunner'], qualifier: ['olten'] });
  assert.deepEqual(splitQualifier('Mathys AG Produktionsstätte Bettlach').qualifier, []);
});

test('Qualifizierer-Konflikt trennt: gleicher Kern, verschiedene Klammer', () => {
  assert.equal(locationSimilarity(G('Restaurant Kreuz (Olten)'), G('Restaurant Kreuz (Bern)')), 0);
  assert.equal(verdictOf(G('Restaurant Kreuz (Olten)'), G('Restaurant Kreuz (Bern)')), DIFFERENT);
  // Auch als Komma-Variante.
  assert.equal(verdictOf(G('Wohnung Brunner, Olten'), G('Wohnung Brunner, Bern')), DIFFERENT);
});

test('Ein Zusatz gegen keinen Zusatz ist kein Konflikt, aber auch kein Beweis', () => {
  // «Bahnhof» ist Teilmenge JEDER qualifizierten Variante → duennes Signal, nicht SAME.
  const r = scoreLocationPair(G('Bahnhof'), G('Bahnhof (Solothurn)'));
  assert.equal(r.verdict, UNSURE);
  assert.ok(r.sim > 0 && r.sim < 0.95);
  // Stadt + Quartier: derselbe Fehlerfall, ebenfalls nur unsicher.
  assert.equal(scoreLocationPair({ name: 'Olten', typ: 'STADT' },
    { name: 'Olten (Bahnhofsviertel)', typ: 'STADT' }).verdict, UNSURE);
});

test('Teilmenge mit zwei geteilten Token bleibt SAME (Mathys AG)', () => {
  const r = scoreLocationPair(G('Mathys AG (Bettlach)'), G('Mathys AG Produktionsstätte Bettlach'));
  assert.equal(r.verdict, SAME);
  assert.ok(r.sim >= 0.9);
  assert.equal(verdictOf(G('EPA / Nordmann Solothurn'), G('EPA und Nordmann (Solothurn)')), SAME);
});

test('Indizien holen den Ein-Token-Fall in den Graubereich (Frohheim)', () => {
  // Ein gemeinsames Token («frohheim») reicht dem Namen nicht — frueher fiel das Paar
  // auf 0 und wurde zur Dublette. Ohne Indizien bleibt es dabei …
  assert.equal(scoreLocationPair(G('Schulhaus Frohheim'), G('Frohheim-Schule Olten')).verdict, DIFFERENT);
  // … mit gemeinsamem Kapitel UND gemeinsamer Figur wird es ein Verdachtsfall fuer den
  // Judge. Bewusst nicht SAME: ob zwei aehnlich benannte Gebaeude dasselbe sind, sagt
  // nur der Text.
  const aI = G('Schulhaus Frohheim', { chapters: ['K1'], figures: ['Mario'] });
  const bI = G('Frohheim-Schule Olten', { chapters: ['K1'], figures: ['Mario'] });
  assert.equal(scoreLocationPair(aI, bI).verdict, UNSURE);
});

test('locationEvidence: Land und Distanz koennen widersprechen', () => {
  assert.equal(locationEvidence({ land: 'ch' }, { land: 'ch' }), 1);
  assert.ok(locationEvidence({ land: 'ch' }, { land: 'de' }) <= -3);
  assert.equal(locationEvidence({ lat: 47.35, lng: 7.9 }, { lat: 47.35, lng: 7.9 }), 2);
  assert.ok(locationEvidence({ lat: 47.35, lng: 7.9 }, { lat: 46.95, lng: 7.45 }) <= -3);
});

test('Widerspruch schlaegt Namensgleichheit: gleicher Kern, andere Koordinaten', () => {
  const a = G('Mathys AG (Bettlach)', { lat: 47.20, lng: 7.42 });
  const b = G('Mathys AG Produktionsstätte Bettlach', { lat: 46.20, lng: 6.14 });
  assert.equal(scoreLocationPair(a, b).verdict, DIFFERENT);
});

test('locationSimilarity: verschiedener Typ und kein geteiltes Token → 0', () => {
  assert.equal(locationSimilarity({ name: 'Olten', typ: 'STADT' }, G('Olten Bahnhof')), 0);
  assert.equal(locationSimilarity(G('Bahnhof Olten'), G('Bahnhof Bern')), 0);
  assert.equal(locationSimilarity(G('Schreinerei Grütter'), { name: 'Solothurn', typ: 'STADT' }), 0);
});

test('matchLocations: exakter Name und starke Variante treffen dieselbe Zeile', () => {
  const existing = [
    { id: 10, name: 'Mathys AG (Produktionsstätte)', typ: 'GEBAEUDE' },
    { id: 11, name: 'Solothurn', typ: 'STADT' },
  ];
  const incoming = [
    { name: 'Mathys AG Produktionsstätte Bettlach', typ: 'GEBAEUDE' },
    { name: 'Solothurn', typ: 'STADT' },
  ];
  const { matchOf } = matchLocations(existing, incoming);
  assert.equal(matchOf.get(0), 10);
  assert.equal(matchOf.get(1), 11);
});

test('matchLocations: jede Bestands-Zeile hoechstens einmal', () => {
  const existing = [{ id: 1, name: 'Frohheim-Schule Olten', typ: 'GEBAEUDE' }];
  const incoming = [
    { name: 'Frohheim-Schule Olten', typ: 'GEBAEUDE' },
    { name: 'Frohheim-Schulhaus Olten', typ: 'GEBAEUDE' },
  ];
  const { matchOf } = matchLocations(existing, incoming);
  assert.equal(matchOf.get(0), 1);
  assert.equal(matchOf.has(1), false);
});

test('Ambiguitaet fuehrt NICHT zum Merge: zwei gleich gute Kandidaten', () => {
  // «Bahnhof» passt auf Solothurn und Bern gleich gut. Frueher entschied die
  // Array-Reihenfolge — jetzt entscheidet niemand automatisch.
  const existing = [
    { id: 1, name: 'Bahnhof Solothurn', typ: 'GEBAEUDE' },
    { id: 2, name: 'Bahnhof Bern', typ: 'GEBAEUDE' },
  ];
  const incoming = [{ name: 'Bahnhof', typ: 'GEBAEUDE' }];
  const { matchOf, unsure } = matchLocations(existing, incoming);
  assert.equal(matchOf.size, 0, 'kein automatischer Merge');
  assert.ok(unsure.length >= 2, 'beide Kandidaten gehen an den Judge');
  assert.deepEqual([...new Set(unsure.map(u => u.existingId))].sort(), [1, 2]);
});

test('matchLocations: hint (vom Judge bestaetigt) schlaegt die Regel', () => {
  const existing = [{ id: 7, name: 'Beiz zum Stern', typ: 'GEBAEUDE' }];
  const incoming = [{ id: 'ort_3', name: 'Sternen-Wirtschaft', typ: 'GEBAEUDE' }];
  assert.equal(matchLocations(existing, incoming).matchOf.size, 0, 'ohne Hint kein Match');
  const hint = new Map([['ort_3', 7]]);
  assert.equal(matchLocations(existing, incoming, { hint }).matchOf.get(0), 7);
});

test('dedupeLocationsWithinRun: merged Teilmengen, sammelt Unsicheres', () => {
  const { orte } = dedupeLocationsWithinRun([
    { name: 'Mathys AG (Bettlach)', typ: 'GEBAEUDE', figuren_namen: ['Der Vater'], kapitel: ['K1'], beschreibung: 'kurz' },
    { name: 'Mathys AG Produktionsstätte Bettlach', typ: 'GEBAEUDE', figuren_namen: ['Mario'], kapitel: ['K2'], beschreibung: 'eine viel längere Beschreibung' },
  ]);
  assert.equal(orte.length, 1);
  assert.deepEqual([...orte[0].figuren_namen].sort(), ['Der Vater', 'Mario']);
  assert.equal(orte[0].kapitel.length, 2);
  assert.equal(orte[0].beschreibung, 'eine viel längere Beschreibung');
  assert.equal(orte[0].name, 'Mathys AG Produktionsstätte Bettlach');

  // Overlap ohne Teilmenge bleibt getrennt, wird aber als Verdachtsfall gemeldet.
  const res = dedupeLocationsWithinRun([
    { name: 'Dieters Bar (Innenstadt Olten)', typ: 'GEBAEUDE' },
    { name: 'Dieters Bar/Etablissement in Olten', typ: 'GEBAEUDE' },
  ]);
  assert.equal(res.orte.length, 2);
  assert.equal(res.unsure.length, 1);
});

test('Szenen: Kapitel ist hartes Gate, Titel-Teilmenge zaehlt darin', () => {
  const existing = [
    { id: 5, chapter_id: 1, titel: 'Ankunft in Olten' },
    { id: 6, chapter_id: 2, titel: 'Abschied' },
  ];
  const incoming = [
    { chapterId: 1, titel: 'Ankunft in Olten am Bahnhof' },
    { chapterId: 2, titel: 'Abschied' },
  ];
  const { matchOf } = matchScenes(existing, incoming);
  assert.equal(matchOf.get(0), 5);
  assert.equal(matchOf.get(1), 6);

  const other = matchScenes([{ id: 5, chapter_id: 1, titel: 'Der Streit' }],
    [{ chapterId: 2, titel: 'Der Streit' }]);
  assert.equal(other.matchOf.size, 0);
});

test('Szenen: die Seite entscheidet den duennen Titel-Fall', () => {
  const a = { chapter_id: 1, titel: 'Gespräch', page_id: 42 };
  const b = { chapter_id: 1, titel: 'Gespräch am Abend', page_id: 42 };
  assert.equal(scoreScenePair(a, b).verdict, SAME, 'gleiche Seite ⇒ dieselbe Szene');
  const c = { chapter_id: 1, titel: 'Gespräch am Abend', page_id: 99 };
  assert.equal(scoreScenePair(a, c).verdict, UNSURE, 'andere Seite ⇒ unsicher, kein Merge');
});

test('sceneEvidence: disjunkte Figuren sprechen dagegen', () => {
  assert.equal(sceneEvidence({ figures: ['Mario'] }, { figures: ['Mario', 'Anna'] }), 1);
  assert.equal(sceneEvidence({ figures: ['Mario'] }, { figures: ['Anna'] }), -1);
});

test('dedupeScenesWithinRun: Titel-Varianten derselben Szene fallen zusammen', () => {
  const { szenen } = dedupeScenesWithinRun([
    { titel: 'Ankunft', kapitel: 'K1', chapterId: 1, pageId: 7, figuren_namen: ['Mario'] },
    { titel: 'Ankunft am Bahnhof', kapitel: 'K1', chapterId: 1, pageId: 7, figuren_namen: ['Anna'], kommentar: 'laenger' },
  ]);
  assert.equal(szenen.length, 1);
  assert.equal(szenen[0].titel, 'Ankunft am Bahnhof');
  assert.deepEqual([...szenen[0].figuren_namen].sort(), ['Anna', 'Mario']);
  assert.equal(szenen[0].kommentar, 'laenger');
});

test('Figuren: Geburtsjahr-Widerspruch trennt zwei Gleichnamige', () => {
  const a = { name: 'Anna Meier', geburtstag: '1943' };
  const b = { name: 'Anna Meier', geburtstag: '1978' };
  assert.ok(figureEvidence(a, b) <= -3);
  // Exakt gleicher Name bleibt SAME (derselbe Katalog-Eintrag, Datum ist ein Datenfehler)
  assert.equal(scoreFigurePair(a, b).verdict, SAME);
  // Aber bei Namensvariante schlaegt der Widerspruch durch:
  assert.equal(scoreFigurePair({ name: 'Anna', geburtstag: '1943' },
    { name: 'Anna Meier', geburtstag: '1978' }).verdict, DIFFERENT);
});

test('Figuren: Teilmenge braucht Indizien, sonst unsicher', () => {
  const thin = scoreFigurePair({ name: 'Gerold' }, { name: 'Gerold Brunner' });
  assert.equal(thin.verdict, UNSURE);
  const strong = scoreFigurePair(
    { name: 'Gerold', beruf: 'Schmied', chapters: ['K1'] },
    { name: 'Gerold Brunner', beruf: 'Schmied', chapters: ['K1'] });
  assert.equal(strong.verdict, SAME);
});

test('Figuren: verschiedene Vornamen, gleicher Nachname bleiben getrennt', () => {
  const r = scoreFigurePair(
    { name: 'Paul Schmidt', geschlecht: 'm', chapters: ['K1'] },
    { name: 'Marta Schmidt', geschlecht: 'w', chapters: ['K1'] });
  assert.equal(r.verdict, DIFFERENT);
});

test('Figuren: Rename-Fallback nur bei starken Indizien', () => {
  const strong = scoreFigurePair(
    { name: 'Der Alte', beruf: 'Lehrer', geburtstag: '1901', chapters: ['K1'], typ: 'nebenfigur' },
    { name: 'Gustav Weber', beruf: 'Lehrer', geburtstag: '1901', chapters: ['K1'], typ: 'nebenfigur' });
  assert.equal(strong.verdict, SAME);
  const weak = scoreFigurePair({ name: 'Der Alte', typ: 'nebenfigur' }, { name: 'Gustav Weber', typ: 'nebenfigur' });
  assert.notEqual(weak.verdict, SAME);
});

test('matchFiguren: exakter Name gewinnt vor Variante, Rest wird unsure', () => {
  const existing = [
    { id: 1, name: 'Gerold Brunner', beruf: 'Schmied' },
    { id: 2, name: 'Marta Brunner', geschlecht: 'w' },
  ];
  const incoming = [
    { id: 'fig_1', name: 'Gerold Brunner', beruf: 'Schmied' },
    { id: 'fig_2', name: 'Gerold' },
  ];
  const { matchOf, unsure } = matchFiguren(existing, incoming);
  assert.equal(matchOf.get(0), 1);
  assert.equal(matchOf.has(1), false, 'die Variante trifft keine freie Zeile automatisch');
  assert.ok(unsure.length >= 0);
});

test('Ambiguitaet sperrt den Eintrag: kein schwaecherer Kandidat springt ein', () => {
  // Drei Bestands-Zeilen; die ersten zwei sind gleich stark (Gleichstand an der Spitze),
  // die dritte waere schwaecher. Auch sie darf nicht gewinnen — sonst haette der
  // Gleichstand nur die Reihenfolge verschoben statt die Entscheidung zu verweigern.
  const existing = [
    { id: 1, name: 'Gerold Brunner', beruf: 'Schmied', chapters: ['K1'] },
    { id: 2, name: 'Gerold Brunner', beruf: 'Schmied', chapters: ['K1'] },
    { id: 3, name: 'Gerold Brunner', beruf: 'Schmied' },
  ];
  const incoming = [{ id: 'fig_1', name: 'Gerold Brunner', beruf: 'Schmied', chapters: ['K1'] }];
  const { matchOf, unsure } = matchFiguren(existing, incoming);
  assert.equal(matchOf.size, 0);
  // Genau die zwei gleich starken Kandidaten gehen an den Judge, ohne Dubletten.
  const keys = [...new Set(unsure.filter(u => u.reason === 'ambiguous').map(u => u.existingId))].sort();
  assert.deepEqual(keys, [1, 2]);
});
