// Drift-Gate für die Bewertungsprofile der Buch- und Kapitelbewertung.
//
// SSoT ist public/js/prompts/review-typen.js. An dem Achsen-Set hängen drei
// Schichten, die es in eigenen Ableitungen führen:
//   1. public/js/prompts/review.js (Prompt-Text UND JSON-Schema pro Call)
//   2. public/js/book/review.js (welche Abschnitte gerendert werden)
//   3. public/js/i18n/{de,en}.json (`review.section.*`, `kapitelReview.section.*`,
//      `review.cat.*`)
//
// Eine neue Achse, die nur in der SSoT landet, erscheint in der App als roher
// Key ohne Label; eine, die nur im Prompt landet, fehlt im Schema und wird von
// lokalen Providern gar nicht erst erzeugt.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const esm = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const T = await esm('public/js/prompts/review-typen.js');
const R = await esm('public/js/prompts/review.js');
const {
  reviewProfil, bookReviewAxes, chapterReviewAxes, chapterAnalysisFelder,
  empfehlungKategorien, notenTiers, werkPhrase,
  ALLE_BOOK_AXES, ALLE_CHAPTER_AXES, ALLE_KATEGORIEN, REVIEW_PROFIL_KEYS,
} = T;

const de = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/js/i18n/de.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/js/i18n/en.json'), 'utf8'));

// ── 1. Profil-Zuordnung ──────────────────────────────────────────────────────

test('Profil-Zuordnung: nur die Nicht-Erzähl-Buchtypen weichen von narrativ ab', () => {
  assert.equal(reviewProfil('wissenschaft'), 'wissenschaft');
  assert.equal(reviewProfil('journalismus'), 'journalistisch');
  assert.equal(reviewProfil('lyrik'), 'lyrisch');
  for (const bt of ['sachbuch', 'essay', 'blog']) assert.equal(reviewProfil(bt), 'sachlich', bt);
  for (const bt of ['roman', 'krimi', 'historisch', 'fantasy_scifi', 'tagebuch',
    'autobiografie', 'satire', 'kurzgeschichten', 'andere', null, undefined, 'gibtsnicht']) {
    assert.equal(reviewProfil(bt), 'narrativ', String(bt));
  }
});

test('Lyrik weicht bewusst vom Lektorat-Profil ab', async () => {
  // Im Lektorat bleibt Lyrik narrativ (Wiederholung/Bilder sind Kunstmittel),
  // in der Bewertung nicht (Plot und Figuren existieren dort nicht).
  const { lektoratProfil } = await esm('public/js/prompts/lektorat-typen.js');
  assert.equal(lektoratProfil('lyrik'), 'narrativ');
  assert.equal(reviewProfil('lyrik'), 'lyrisch');
});

// ── 2. Achsen-Inhalt ─────────────────────────────────────────────────────────

test('Nicht-Erzähl-Profile führen keine narrativen Achsen', () => {
  for (const bt of ['wissenschaft', 'sachbuch', 'journalismus', 'lyrik']) {
    const keys = [...bookReviewAxes(bt), ...chapterReviewAxes(bt)].map(a => a.key);
    for (const narrativ of ['plot', 'figuren', 'dramaturgie', 'pacing', 'perspektive']) {
      assert.ok(!keys.includes(narrativ), `${bt} darf Achse «${narrativ}» nicht führen`);
    }
  }
});

test('Fach-Achsen sind da, wo sie hingehören', () => {
  const buch = (bt) => bookReviewAxes(bt).map(a => a.key);
  for (const k of ['argumentation', 'methode', 'belege', 'begriffe', 'beitrag']) {
    assert.ok(buch('wissenschaft').includes(k), `wissenschaft fehlt «${k}»`);
  }
  for (const k of ['argumentation', 'belege', 'verstaendlichkeit']) {
    assert.ok(buch('sachbuch').includes(k), `sachbuch fehlt «${k}»`);
  }
  for (const k of ['recherche', 'textsortentreue', 'relevanz']) {
    assert.ok(buch('journalismus').includes(k), `journalismus fehlt «${k}»`);
  }
  for (const k of ['form', 'bildsprache', 'verdichtung', 'stimme', 'komposition']) {
    assert.ok(buch('lyrik').includes(k), `lyrik fehlt «${k}»`);
  }
});

test('jedes Profil ist vollständig: Achsen, Tiers, Analyse-Felder, Werk-Phrase', () => {
  for (const profil of REVIEW_PROFIL_KEYS) {
    // Über einen Buchtyp desselben Profils gehen (die API nimmt Buchtypen).
    const bt = { narrativ: 'roman', sachlich: 'sachbuch', wissenschaft: 'wissenschaft',
      journalistisch: 'journalismus', lyrisch: 'lyrik' }[profil];
    assert.ok(bt, `kein Test-Buchtyp für Profil «${profil}»`);
    assert.equal(reviewProfil(bt), profil);
    for (const scope of ['book', 'chapter']) {
      const axes = scope === 'book' ? bookReviewAxes(bt) : chapterReviewAxes(bt);
      assert.ok(axes.length >= 4, `${profil}/${scope}: zu wenige Achsen`);
      for (const a of axes) assert.ok(a.hint && a.hint.length > 20, `${profil}: Achse «${a.key}» ohne Hint`);
      const tiers = notenTiers(bt, scope);
      for (const t of ['mangelhaft', 'schwach', 'solide', 'sehrGut']) {
        assert.ok(tiers[t] && tiers[t].length > 10, `${profil}/${scope}: Notenstufe «${t}» fehlt`);
      }
    }
    const felder = chapterAnalysisFelder(bt);
    assert.equal(felder.length, 3, `${profil}: drei profilspezifische Analyse-Felder erwartet`);
    for (const f of felder) {
      assert.ok(f.key.endsWith('_kurz'), `${profil}: «${f.key}» ohne _kurz-Suffix`);
      assert.ok(f.label, `${profil}: «${f.key}» ohne Label (Synthese-Eingabe zeigt sonst «undefined»)`);
      assert.ok(f.hint, `${profil}: «${f.key}» ohne Hint`);
    }
    assert.ok(werkPhrase(bt, 'nom').includes(' '), `${profil}: Werk-Phrase braucht Artikel`);
    assert.ok(werkPhrase(bt, 'akk').includes(' '), `${profil}: Werk-Phrase (Akk) braucht Artikel`);
  }
});

// ── 3. Prompt ↔ Schema ↔ Kategorien ──────────────────────────────────────────

test('Schema-Felder == Achsen des Profils, Note zuletzt', () => {
  for (const bt of ['roman', 'sachbuch', 'wissenschaft', 'journalismus', 'lyrik']) {
    for (const [build, axesFn, scope] of [
      [R.buildReviewSchema, bookReviewAxes, 'book'],
      [R.buildChapterReviewSchema, chapterReviewAxes, 'chapter'],
    ]) {
      const schema = build({ buchtyp: bt });
      const keys = Object.keys(schema.properties);
      const axes = axesFn(bt).map(a => a.key);
      assert.deepEqual(keys.slice(1, 1 + axes.length), axes, `${bt}/${scope}: Achsen-Block im Schema`);
      // Die Reihenfolge-Invariante: die Note wird NACH den Achsen generiert.
      assert.deepEqual(keys.slice(-2), ['gesamtnote', 'gesamtnote_begruendung'], `${bt}/${scope}: Note zuletzt`);
      assert.deepEqual(schema.required, keys, `${bt}/${scope}: alle Felder required`);
      const kat = schema.properties.empfehlungen.items.properties.kategorie.enum;
      assert.deepEqual(kat, empfehlungKategorien(bt, scope), `${bt}/${scope}: Kategorien-Enum`);
    }
  }
});

test('Kapitelanalyse-Schema führt funktion_kurz und die Profil-Felder', () => {
  for (const bt of ['roman', 'sachbuch', 'wissenschaft', 'journalismus', 'lyrik']) {
    const keys = Object.keys(R.buildChapterAnalysisSchema({ buchtyp: bt }).properties);
    assert.deepEqual(keys.slice(0, 3), ['themen', 'stil', 'funktion_kurz'], bt);
    assert.deepEqual(keys.slice(3, 6), chapterAnalysisFelder(bt).map(f => f.key), bt);
    // `qualitaet` («Allgemeiner Qualitätseindruck») ist bewusst weg: vages
    // Sammelfeld, das staerken/schwaechen dupliziert hat.
    assert.ok(!keys.includes('qualitaet'), `${bt}: qualitaet ist abgeschafft`);
  }
});

// ── 4. i18n-Vollständigkeit ──────────────────────────────────────────────────

test('jede Achse und jede Kategorie hat ein Label in beiden Locales', () => {
  const missing = [];
  const check = (key) => {
    if (!de[key]) missing.push(`de: ${key}`);
    if (!en[key]) missing.push(`en: ${key}`);
  };
  for (const k of ALLE_BOOK_AXES)    check(`review.section.${k}`);
  for (const k of ALLE_CHAPTER_AXES) check(`kapitelReview.section.${k}`);
  for (const k of ALLE_KATEGORIEN)   check(`review.cat.${k}`);
  for (const k of ['review.basis.multi', 'review.basis.multiTip']) check(k);
  assert.deepEqual(missing, []);
});

test('Union-Listen decken alle Profile ab', () => {
  for (const bt of ['roman', 'sachbuch', 'wissenschaft', 'journalismus', 'lyrik']) {
    for (const a of bookReviewAxes(bt))    assert.ok(ALLE_BOOK_AXES.includes(a.key), a.key);
    for (const a of chapterReviewAxes(bt)) assert.ok(ALLE_CHAPTER_AXES.includes(a.key), a.key);
    for (const scope of ['book', 'chapter']) {
      for (const k of empfehlungKategorien(bt, scope)) assert.ok(ALLE_KATEGORIEN.includes(k), k);
    }
  }
});
