// Jeder FEATURES-Eintrag braucht ein explizites `minRole` — implizites
// Default (`editor`) ist verboten, weil Viewer/Lektor sonst Cards sehen, die
// sie nicht aufrufen dürfen.
//
// hasMinRole + featuresVisibleFor sind die SSoT für Frontend-Sichtbarkeit.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FEATURES,
  ROLE_RANK,
  hasMinRole,
  featuresVisibleFor,
  featureByKey,
  isFeatureAvailable,
  unavailabilityReasonKey,
  KOMPLETT_HIDDEN_BUCHTYPEN,
  komplettHiddenFor,
  matchesRequiredBuchtyp,
} from '../../public/js/cards/feature-registry.js';

test('jeder FEATURES-Eintrag hat ein gültiges minRole', () => {
  const valid = new Set(Object.keys(ROLE_RANK));
  for (const f of FEATURES) {
    assert.ok(f.minRole, `feature "${f.key}" hat kein minRole`);
    assert.ok(valid.has(f.minRole), `feature "${f.key}" hat ungültiges minRole "${f.minRole}"`);
  }
});

test('hasMinRole respektiert Hierarchie owner > editor > lektor > viewer', () => {
  assert.equal(hasMinRole('owner',  'editor'), true);
  assert.equal(hasMinRole('editor', 'editor'), true);
  assert.equal(hasMinRole('lektor', 'editor'), false);
  assert.equal(hasMinRole('viewer', 'lektor'), false);
  assert.equal(hasMinRole('owner',  'viewer'), true);
  assert.equal(hasMinRole(null,     'viewer'), false);
  // required null → immer true (Action ohne Rollenbindung).
  assert.equal(hasMinRole(null,     null),     true);
  assert.equal(hasMinRole('viewer', null),     true);
});

test('featuresVisibleFor(viewer): nur overview/export/pdfExport/epubExport/docxExport/bookEditor/search/help/onboarding', () => {
  const visible = featuresVisibleFor(FEATURES, 'viewer').map(f => f.key).sort();
  assert.deepEqual(visible, ['bookEditor', 'docxExport', 'epubExport', 'export', 'help', 'onboarding', 'overview', 'pdfExport', 'search'].sort());
});

test('featuresVisibleFor(lektor): viewer-Set (lektor hat keine zusätzlichen FEATURES)', () => {
  // FEATURES-Subset für lektor ist identisch zu viewer, weil lektor-spezifische
  // Pfade (Lektorat-Findings-Card im Editor) keine eigenen FEATURES-Einträge
  // haben — die laufen aus dem Editor heraus.
  const viewerSet = new Set(featuresVisibleFor(FEATURES, 'viewer').map(f => f.key));
  const lektorSet = new Set(featuresVisibleFor(FEATURES, 'lektor').map(f => f.key));
  for (const k of viewerSet) assert.ok(lektorSet.has(k), `${k} fehlt bei lektor`);
});

// `requiresBuchtyp`-Karten sind nur sichtbar, wenn der Buchtyp passt — auch für
// editor/owner. Ohne passenden Buchtyp fallen sie raus. Umgekehrt blendet
// `hiddenForBuchtyp` Karten in genau einem Werktyp aus.
function _visibleAt(role, buchtyp) {
  return featuresVisibleFor(FEATURES, role, buchtyp).map(f => f.key).sort();
}
// Erwartung ueber die SSoT bilden, nicht ueber eine zweite Kopie der Regel:
// `requiresBuchtyp` nimmt einen Key ODER eine Liste (die Titel-Werkstatt gilt
// fuer 'journalismus' UND 'blog'). Ein nachgebautes `===` hier haette genau die
// Drift erzeugt, gegen die der Helper existiert.
function _expectedAt(buchtyp) {
  return FEATURES
    .filter(f => matchesRequiredBuchtyp(f, buchtyp)
      && !(f.hiddenForBuchtyp || []).includes(buchtyp))
    .map(f => f.key).sort();
}

test('featuresVisibleFor(editor, buchtyp=tagebuch): alle ausser den fremd-typisierten', () => {
  assert.deepEqual(_visibleAt('editor', 'tagebuch'), _expectedAt('tagebuch'));
  // Tagebuch blendet NICHTS aus (kein hiddenForBuchtyp nennt es) — die
  // Gegenprobe zum journalistischen Fall. Es fehlen nur die Karten, die einen
  // ANDEREN Buchtyp verlangen.
  const nurFremdTypisiert = FEATURES
    .filter(f => f.requiresBuchtyp && !matchesRequiredBuchtyp(f, 'tagebuch'))
    .map(f => f.key).sort();
  assert.deepEqual(nurFremdTypisiert, ['struktur', 'titelwerkstatt']);
  assert.ok(FEATURES.every(f => !(f.hiddenForBuchtyp || []).includes('tagebuch')));
});

// Die Listen-Form von `requiresBuchtyp`: der Titelapparat gilt fuer BEIDE
// publizistischen Typen, der Struktur-Check nur fuers Ressort. Ohne diesen Fall
// faellt eine Rueckkehr zum Einzel-Key nicht auf — die Karte verschwaende dann
// lautlos aus dem Blog.
test('featuresVisibleFor(editor, buchtyp=blog): Titel-Werkstatt ja, Struktur nein', () => {
  const visible = new Set(_visibleAt('editor', 'blog'));
  assert.ok(visible.has('titelwerkstatt'), 'titelwerkstatt muss im Blog erscheinen');
  assert.ok(!visible.has('struktur'), 'struktur ist ressort-eigen');
  assert.deepEqual(_visibleAt('editor', 'blog'), _expectedAt('blog'));
});

test('featuresVisibleFor(owner, buchtyp=tagebuch): wie editor', () => {
  assert.deepEqual(_visibleAt('owner', 'tagebuch'), _expectedAt('tagebuch'));
});

// Journalistisches Ressort: die Buchwelt-Karten (Figuren, Plot, Motive, Orte,
// Songs, Ereignisse, Szenen, Weltfakten, Kontinuität, Erzählprofil) und der
// Buchsatz (PDF/EPUB) verschwinden; die Struktur-Karte kommt dafür dazu.
test('featuresVisibleFor(editor, buchtyp=journalismus): Buchwelt weg, Struktur da', () => {
  const visible = new Set(_visibleAt('editor', 'journalismus'));
  for (const k of ['figuren', 'werkstatt', 'szenen', 'orte', 'songs', 'ereignisse',
    'plot', 'motiv', 'weltfakten', 'kontinuitaet', 'erzaehlprofil',
    'pdfExport', 'epubExport']) {
    assert.ok(!visible.has(k), `${k} darf im journalistischen Ressort nicht erscheinen`);
  }
  assert.ok(visible.has('struktur'), 'struktur fehlt');
  assert.ok(visible.has('titelwerkstatt'), 'titelwerkstatt fehlt');
  // Was bleibt, bleibt: Recherche, Quellen, Lektorat-Auswertung, Export, Editor.
  for (const k of ['recherche', 'sources', 'fehlerHeatmap', 'export', 'bookEditor']) {
    assert.ok(visible.has(k), `${k} muss bleiben`);
  }
  assert.deepEqual(_visibleAt('editor', 'journalismus'), _expectedAt('journalismus'));
});

// Die Komplettanalyse wird dort nicht angeboten, wo alle ihre Abnehmer-Karten
// ausgeblendet sind — beide Richtungen muessen zusammenpassen, sonst verlangt
// eine Karte einen Lauf, den es nicht zu starten gibt (oder umgekehrt bleibt ein
// Einstiegspunkt stehen, der nur Kosten produziert).
test('kein dependsOnKomplett-Feature ist sichtbar, wo die Komplettanalyse fehlt', () => {
  for (const bt of KOMPLETT_HIDDEN_BUCHTYPEN) {
    assert.ok(komplettHiddenFor(bt), `komplettHiddenFor(${bt}) muss true sein`);
    const visible = new Set(_visibleAt('owner', bt));
    for (const f of FEATURES.filter(f => f.dependsOnKomplett)) {
      assert.ok(!visible.has(f.key), `${f.key} braucht die Komplettanalyse, die es bei ${bt} nicht gibt`);
    }
    assert.ok(!visible.has('action.komplett'), `action.komplett muss bei ${bt} weg sein`);
  }
});

test('komplettHiddenFor gilt nur fuer die genannten Buchtypen', () => {
  for (const bt of ['roman', 'sachbuch', 'tagebuch', 'blog', 'lyrik', null]) {
    assert.ok(!komplettHiddenFor(bt), `komplettHiddenFor(${bt}) muss false sein`);
  }
});

test('struktur ist ausserhalb des journalistischen Ressorts unsichtbar', () => {
  for (const bt of ['roman', 'sachbuch', 'tagebuch', null]) {
    assert.ok(!_visibleAt('editor', bt).includes('struktur'), `struktur bei ${bt} sichtbar`);
  }
});

// requiresClaude: Kontinuität + Erzählprofil sind Claude-only (die Qualitätsstufen
// gibt es nur bei Claude). Für Nicht-Claude ausgeblendet.
test('requiresClaude-Karten sind kontinuitaet + erzaehlprofil', () => {
  const gated = FEATURES.filter(f => f.requiresClaude).map(f => f.key).sort();
  assert.deepEqual(gated, ['erzaehlprofil', 'kontinuitaet']);
});

test('featuresVisibleFor blendet requiresClaude-Karten aus, wenn effektiver Provider nicht Claude', () => {
  const withClaude = new Set(featuresVisibleFor(FEATURES, 'editor', null, true).map(f => f.key));
  const noClaude = new Set(featuresVisibleFor(FEATURES, 'editor', null, false).map(f => f.key));
  for (const k of ['kontinuitaet', 'erzaehlprofil']) {
    assert.ok(withClaude.has(k), `${k} bei Claude sichtbar`);
    assert.ok(!noClaude.has(k), `${k} bei Nicht-Claude ausgeblendet`);
  }
});

test('featuresVisibleFor: claudeEffective default true (Rückwärtskompatibilität)', () => {
  const visible = new Set(featuresVisibleFor(FEATURES, 'editor').map(f => f.key));
  assert.ok(visible.has('kontinuitaet') && visible.has('erzaehlprofil'));
});

test('isFeatureAvailable + unavailabilityReasonKey gaten requiresClaude', () => {
  const feat = featureByKey('kontinuitaet');
  const base = { selectedBookId: 1, pages: [{}], bookRole: 'editor' };
  assert.equal(isFeatureAvailable(feat, { ...base, claudeEffective: true }), true);
  assert.equal(isFeatureAvailable(feat, { ...base, claudeEffective: false }), false);
  assert.equal(unavailabilityReasonKey(feat, { ...base, claudeEffective: false }), 'palette.disabled.needClaude');
});

test('featuresVisibleFor(editor) ohne passenden Buchtyp blendet requiresBuchtyp-Karten aus', () => {
  const gated = FEATURES.filter(f => f.requiresBuchtyp).map(f => f.key);
  assert.ok(gated.includes('tagebuchRueckblick'), 'Test-Voraussetzung: gated Card existiert');
  const visibleNoBuchtyp = new Set(featuresVisibleFor(FEATURES, 'editor').map(f => f.key));
  for (const k of gated) assert.ok(!visibleNoBuchtyp.has(k), `${k} darf ohne passenden Buchtyp nicht sichtbar sein`);
  // Mit passendem Buchtyp wieder sichtbar.
  const visibleTagebuch = new Set(featuresVisibleFor(FEATURES, 'editor', 'tagebuch').map(f => f.key));
  assert.ok(visibleTagebuch.has('tagebuchRueckblick'));
});
