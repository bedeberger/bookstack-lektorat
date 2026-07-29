// Drift-Gate für die Lektorat-Fehlertyp-Profile.
//
// SSoT ist public/js/prompts/lektorat-typen.js. An dem Typ-Set hängen fünf
// Schichten, die es in eigenen Kopien bzw. Ableitungen führen MÜSSEN, weil sie in
// anderen Modulsystemen oder anderen Runtimes leben:
//   1. routes/jobs/lektorat.js#STYLISTIC_TYPEN (CJS, Cap-Backstop)
//   2. lib/lektorat-consolidate.js#TYP_PRIORITY (CJS, Span-Overlap-Clustering)
//   3. public/js/book/fehler-heatmap.js#FEHLER_CLUSTERS (Spalten der Heatmap)
//   4. public/js/book/page-view.js#SOFT_TYPEN (Vorauswahl der Findings)
//   5. public/js/i18n/{de,en}.json (`finding.*`, `fehlerHeatmap.typ.*`)
//
// Ein neuer Fehlertyp, der nur in der SSoT landet, erscheint sonst in der App als
// roher Key ohne Label, fehlt in der Heatmap und wird vom Server verworfen.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const require = createRequire(import.meta.url);
const esm = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const typen = await esm('public/js/prompts/lektorat-typen.js');
const {
  ALLE_LEKTORAT_TYPEN, STILISTISCHE_TYPEN, TYP_PRIORITAET,
  NARRATIV_TYPEN, WISSENSCHAFT_TYPEN, SACHLICH_TYPEN,
  lektoratProfil, lektoratTypen, lektoratObjektivTypen,
} = typen;

// ── 1. Profil-Zuordnung + Inhalt ─────────────────────────────────────────────

test('Profil-Zuordnung: nur die Sach-Buchtypen weichen von narrativ ab', () => {
  assert.equal(lektoratProfil('wissenschaft'), 'wissenschaft');
  for (const bt of ['sachbuch', 'essay', 'blog']) {
    assert.equal(lektoratProfil(bt), 'sachlich', bt);
  }
  // Erzählende Typen + unbekannt/null fallen auf narrativ zurück.
  for (const bt of ['roman', 'krimi', 'historisch', 'fantasy_scifi', 'lyrik', 'tagebuch',
    'autobiografie', 'satire', 'andere', null, undefined, 'gibtsnicht']) {
    assert.equal(lektoratProfil(bt), 'narrativ', String(bt));
  }
});

test('wissenschaft: die narrativen Rausch-Typen sind weg', () => {
  // Kern der Änderung: eine Dissertation wird nicht mehr auf Erzähl-Handwerk geprüft.
  // Nominalstil/Passiv/wiederholte Fachtermini sind dort erwünscht, nicht Mangel.
  for (const t of ['show_vs_tell', 'klischee', 'schwaches_verb', 'filterwort',
    'ki_geruch', 'passiv', 'perspektivbruch', 'dialogformat',
    'namenskonsistenz', 'figurenmerkmal', 'anrede', 'schauplatzmerkmal']) {
    assert.ok(!WISSENSCHAFT_TYPEN.includes(t), `wissenschaft darf «${t}» nicht führen`);
  }
});

test('wissenschaft: die Fach-Typen sind da und narrativ nicht', () => {
  for (const t of ['unbelegt', 'begriffsinkonsistenz', 'autorenform', 'hedging']) {
    assert.ok(WISSENSCHAFT_TYPEN.includes(t), `wissenschaft fehlt «${t}»`);
    assert.ok(!NARRATIV_TYPEN.includes(t), `narrativ darf «${t}» nicht führen`);
  }
  // Mechanik bleibt in jedem Profil.
  for (const profil of [NARRATIV_TYPEN, SACHLICH_TYPEN, WISSENSCHAFT_TYPEN]) {
    assert.ok(profil.includes('rechtschreibung'));
    assert.ok(profil.includes('grammatik'));
  }
});

test('sachlich: kein Erzähl-Handwerk, aber Hedging + Begriffsdisziplin', () => {
  for (const t of ['show_vs_tell', 'filterwort', 'perspektivbruch', 'dialogformat',
    'namenskonsistenz', 'schauplatzmerkmal']) {
    assert.ok(!SACHLICH_TYPEN.includes(t), `sachlich darf «${t}» nicht führen`);
  }
  for (const t of ['hedging', 'begriffsinkonsistenz', 'schwaches_verb', 'passiv']) {
    assert.ok(SACHLICH_TYPEN.includes(t), `sachlich fehlt «${t}»`);
  }
  // `unbelegt` bleibt der wissenschaftlichen Arbeit vorbehalten – ein Essay muss
  // nicht jede Aussage mit Kurzbeleg stützen.
  assert.ok(!SACHLICH_TYPEN.includes('unbelegt'));
});

test('lokaler Provider schneidet das Profil, statt es zu ersetzen', () => {
  // Lokal × wissenschaft: der lokale Kern OHNE schwaches_verb (nicht im Profil) und
  // ohne die Fach-Typen (verlangen nuanciertes Textverständnis).
  const lokalWiss = lektoratTypen('wissenschaft', { local: true });
  assert.deepEqual(lokalWiss, ['rechtschreibung', 'grammatik', 'stil', 'wiederholung', 'fuellwort']);
  const lokalRoman = lektoratTypen('roman', { local: true });
  assert.deepEqual(lokalRoman,
    ['rechtschreibung', 'grammatik', 'stil', 'wiederholung', 'schwaches_verb', 'fuellwort']);
});

test('Stil-Pass lässt die objektiven Typen weg, Objektiv-Pass nur sie', () => {
  const stilRoman = lektoratTypen('roman', { stilOnly: true });
  for (const t of ['rechtschreibung', 'grammatik', 'dialogformat', 'namenskonsistenz',
    'figurenmerkmal', 'anrede']) {
    assert.ok(!stilRoman.includes(t), `Stil-Pass darf «${t}» nicht führen`);
  }
  assert.deepEqual(lektoratObjektivTypen('roman', { hasFiguren: true }),
    ['rechtschreibung', 'grammatik', 'dialogformat', 'namenskonsistenz', 'figurenmerkmal', 'anrede']);
  assert.deepEqual(lektoratObjektivTypen('roman', { hasFiguren: false }),
    ['rechtschreibung', 'grammatik', 'dialogformat']);
  // Fach-Profile: der Objektiv-Pass schrumpft auf reine Mechanik.
  assert.deepEqual(lektoratObjektivTypen('wissenschaft', { hasFiguren: true }),
    ['rechtschreibung', 'grammatik']);
});

test('TYP_PRIORITAET deckt jeden Typ ab (sonst landen Typen gleichrangig im Dedup)', () => {
  for (const t of ALLE_LEKTORAT_TYPEN) {
    assert.ok(TYP_PRIORITAET.includes(t), `TYP_PRIORITAET fehlt «${t}»`);
  }
  assert.equal(TYP_PRIORITAET.length, new Set(TYP_PRIORITAET).size, 'keine Duplikate');
  assert.equal(TYP_PRIORITAET.length, ALLE_LEKTORAT_TYPEN.length, 'keine verwaisten Typen');
});

// ── 2. CJS-Spiegel der Server-Seite ──────────────────────────────────────────

test('routes/jobs/lektorat.js#STYLISTIC_TYPEN spiegelt STILISTISCHE_TYPEN', () => {
  const { STYLISTIC_TYPEN } = require(path.join(ROOT, 'routes/jobs/lektorat.js'));
  assert.deepEqual([...STYLISTIC_TYPEN].sort(), [...STILISTISCHE_TYPEN].sort());
  // Nur echte Typen im Cap-Set.
  for (const t of STILISTISCHE_TYPEN) {
    assert.ok(ALLE_LEKTORAT_TYPEN.includes(t), `«${t}» ist kein gültiger Fehlertyp`);
  }
  // Beleg-/Form-Befunde dürfen NIE gekappt werden.
  for (const t of ['unbelegt', 'begriffsinkonsistenz', 'autorenform']) {
    assert.ok(!STILISTISCHE_TYPEN.includes(t), `«${t}» darf nicht stilistisch sein`);
  }
});

test('lib/lektorat-consolidate.js#TYP_PRIORITY spiegelt TYP_PRIORITAET (inkl. Reihenfolge)', () => {
  const { TYP_PRIORITY } = require(path.join(ROOT, 'lib/lektorat-consolidate.js'));
  assert.deepEqual(TYP_PRIORITY, TYP_PRIORITAET);
});

// ── 3. Frontend-Ableitungen ──────────────────────────────────────────────────

test('Fehler-Heatmap-Cluster deckt genau ALLE_LEKTORAT_TYPEN ab', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/book/fehler-heatmap.js'), 'utf8');
  const spalten = [...src.matchAll(/\{ key: '([a-z]+)',\s*typen: \[([^\]]+)\]/g)];
  assert.ok(spalten.length >= 5, 'FEHLER_CLUSTERS nicht gefunden');
  const clusterKeys = spalten.map(m => m[1]);
  const alleSpalten = spalten.flatMap(m => [...m[2].matchAll(/'([a-z_]+)'/g)].map(x => x[1]));
  assert.deepEqual([...alleSpalten].sort(), [...ALLE_LEKTORAT_TYPEN].sort());
  assert.equal(alleSpalten.length, new Set(alleSpalten).size, 'Typ in zwei Clustern');
  // Cluster-Labels müssen übersetzt sein.
  for (const locale of ['de', 'en']) {
    const i18n = JSON.parse(fs.readFileSync(path.join(ROOT, `public/js/i18n/${locale}.json`), 'utf8'));
    for (const k of clusterKeys) {
      assert.ok(i18n[`fehlerHeatmap.cluster.${k}`], `${locale}: fehlerHeatmap.cluster.${k} fehlt`);
    }
  }
});

// page-view.js ist ein Browser-Modul (greift beim Laden auf `window` zu) und lässt
// sich in Node nicht importieren – darum aus der Quelle lesen.
test('SOFT_TYPEN enthält nur gültige Typen', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/book/page-view.js'), 'utf8');
  const m = src.match(/export const SOFT_TYPEN = new Set\(\[([^\]]+)\]\)/);
  assert.ok(m, 'SOFT_TYPEN nicht gefunden');
  const soft = [...m[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]);
  assert.ok(soft.length > 0);
  for (const t of soft) {
    assert.ok(ALLE_LEKTORAT_TYPEN.includes(t), `SOFT_TYPEN führt unbekannten Typ «${t}»`);
  }
});

test('jeder Fehlertyp hat Labels in beiden Locales', () => {
  for (const locale of ['de', 'en']) {
    const i18n = JSON.parse(fs.readFileSync(path.join(ROOT, `public/js/i18n/${locale}.json`), 'utf8'));
    for (const t of ALLE_LEKTORAT_TYPEN) {
      assert.ok(i18n[`finding.${t}`], `${locale}: finding.${t} fehlt`);
      assert.ok(i18n[`fehlerHeatmap.typ.${t}`], `${locale}: fehlerHeatmap.typ.${t} fehlt`);
    }
  }
});
