// Wirkung des Bewertungsprofils im GEBAUTEN Prompt.
//
// review-typen-drift.test.mjs prüft die Datenstruktur; hier geht es um den Text,
// der beim Modell ankommt. Die beiden Fehlerklassen, die das Gate abfängt:
//   · eine narrative Formulierung, die trotz Profil im Sachtext-Prompt steht
//     («Hauptfiguren-Bogen», «marktfähig»),
//   · eine Verletzung der Reihenfolge-Invariante (Note vor den Achsen).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const esm = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const R = await esm('public/js/prompts/review.js');
const T = await esm('public/js/prompts/review-typen.js');

const TEXT = 'Kapiteltext zum Bewerten.';
const ANALYSE = (extra) => ({
  name: 'K1', pageCount: 2, themen: 'T', stil: 'S', funktion_kurz: 'F',
  staerken: ['a'], schwaechen: ['b'],
  zitate: [{ kind: 'staerke', zitat: 'Z', kommentar: 'K' }],
  ...extra,
});

/** Alle vier Bewertungs-Prompts eines Buchtyps (nicht die Kapitelanalyse). */
function alleReviewPrompts(buchtyp) {
  const o = { buchtyp };
  return {
    buchSingle:    R.buildBookReviewSinglePassPrompt('B', 3, TEXT, o),
    buchMulti:     R.buildBookReviewMultiPassPrompt('B', [ANALYSE()], 3, o),
    kapitelSingle: R.buildChapterReviewPrompt('K', 'B', 2, TEXT, o),
    kapitelMulti:  R.buildChapterReviewMultiPassPrompt('K', 'B', [ANALYSE()], 2, o),
  };
}

test('Note steht in JEDEM Bewertungs-Prompt hinter den Achsen', () => {
  for (const bt of ['roman', 'sachbuch', 'wissenschaft', 'journalismus', 'lyrik']) {
    const prompts = alleReviewPrompts(bt);
    for (const [name, p] of Object.entries(prompts)) {
      const of = p.slice(p.indexOf('<output_format>'), p.indexOf('</output_format>'));
      const notePos = of.indexOf('"gesamtnote"');
      assert.ok(notePos > 0, `${bt}/${name}: gesamtnote fehlt im output_format`);
      const scope = name.startsWith('buch') ? 'book' : 'chapter';
      const axes = scope === 'book' ? T.bookReviewAxes(bt) : T.chapterReviewAxes(bt);
      for (const a of axes) {
        const axisPos = of.indexOf(`"${a.key}"`);
        assert.ok(axisPos > 0, `${bt}/${name}: Achse «${a.key}» fehlt im output_format`);
        assert.ok(axisPos < notePos, `${bt}/${name}: Achse «${a.key}» steht HINTER der Note`);
      }
      assert.ok(of.indexOf('"fazit"') < notePos, `${bt}/${name}: fazit steht hinter der Note`);
    }
  }
});

test('Sachprofile bekommen keine narrativen Formulierungen', () => {
  const verboten = [/Hauptfiguren-Bogen/, /marktfähig/, /Genreprosa/, /Spannungskurve/, /Szenen sitzen/];
  for (const bt of ['sachbuch', 'wissenschaft', 'journalismus', 'lyrik']) {
    for (const [name, p] of Object.entries(alleReviewPrompts(bt))) {
      for (const re of verboten) {
        assert.ok(!re.test(p), `${bt}/${name}: enthält «${re}»`);
      }
    }
  }
});

test('wissenschaftliche Arbeit: Passiv und Nominalstil werden ausdrücklich nicht abgewertet', () => {
  const p = R.buildBookReviewSinglePassPrompt('B', 3, TEXT, { buchtyp: 'wissenschaft' });
  assert.match(p, /Nominalstil, Passiv und wiederholte Fachtermini sind hier kein Mangel/);
  assert.match(p, /Beleglage/);
});

test('Notenanker nennt die Achsen DIESES Profils', () => {
  for (const bt of ['roman', 'sachbuch', 'wissenschaft', 'journalismus', 'lyrik']) {
    const p = R.buildBookReviewSinglePassPrompt('B', 3, TEXT, { buchtyp: bt });
    const zeile = p.split('\n').find(l => l.startsWith('- 4.5:'));
    assert.ok(zeile, `${bt}: 4.5-Zeile fehlt`);
    for (const a of T.bookReviewAxes(bt)) {
      assert.ok(zeile.includes(a.key), `${bt}: 4.5-Schwelle nennt «${a.key}» nicht`);
    }
  }
});

test('Empfehlungs-Beispiel schreibt keine Prio-/Kategorie-Verteilung vor', () => {
  for (const bt of ['roman', 'wissenschaft']) {
    for (const [name, p] of Object.entries(alleReviewPrompts(bt))) {
      const of = p.slice(p.indexOf('<output_format>'), p.indexOf('</output_format>'));
      // Genau EIN Beispiel-Eintrag, mit Enum statt einer konkreten Auswahl —
      // drei Einträge (je hoch/mittel/niedrig) wirken als Few-Shot-Vorgabe.
      const eintraege = of.match(/"prio":/g) || [];
      assert.equal(eintraege.length, 1, `${bt}/${name}: mehr als ein Empfehlungs-Beispiel`);
      assert.ok(of.includes('"prio": "hoch|mittel|niedrig"'), `${bt}/${name}: Prio als Enum erwartet`);
      assert.ok(!/"kategorie": "mikro"/.test(of), `${bt}/${name}: «mikro» als Beispiel-Kategorie`);
      assert.match(p, /zeigt die FORM eines Eintrags, nicht die zu liefernde Verteilung/);
    }
  }
});

test('Kapitel-Empfehlungen verlangen weniger als Buch-Empfehlungen', () => {
  const buch = R.buildBookReviewSinglePassPrompt('B', 3, TEXT, {});
  const kap  = R.buildChapterReviewPrompt('K', 'B', 2, TEXT, {});
  assert.match(buch, /4–8 Empfehlungen insgesamt/);
  assert.match(kap,  /3–5 Empfehlungen insgesamt/);
  // Der Empfehlungs-Block spricht im Kapitel-Review nicht mehr vom «Buch».
  const block = kap.slice(kap.indexOf('Empfehlungen – Format'), kap.indexOf('Beispielzitate – Format'));
  assert.ok(!/das Buch/.test(block), 'Kapitel-Empfehlungsblock spricht vom Buch');
});

test('Kapitelanalyse erhebt die Funktion im Ganzen', () => {
  for (const bt of ['roman', 'wissenschaft']) {
    const p = R.buildChapterAnalysisPrompt('K', 'B', 2, TEXT, { buchtyp: bt });
    assert.match(p, /funktion_kurz/);
    assert.match(p, /Funktion im Ganzen/);
    // Ohne diesen Satz füllt das Modell knapp und die Synthese steht auf Sand.
    assert.match(p, /fehlt der Gesamtbewertung ersatzlos/);
    for (const f of T.chapterAnalysisFelder(bt)) assert.ok(p.includes(f.key), `${bt}: ${f.key} fehlt`);
  }
});

test('Multi-Pass-Synthese sieht die Belegzitate der Teil-Analysen', () => {
  const p = R.buildBookReviewMultiPassPrompt('B', [ANALYSE()], 3, {});
  assert.match(p, /Belegzitate:/);
  assert.match(p, /«Z»/);
  assert.match(p, /setze "beispielzitate" auf \[\]/);
});

// ── Form-Befunde des Struktur-Checks ─────────────────────────────────────────

const STRUKTUR_CTX = {
  scope: 'book', geprueft: 9, gesamt: 14,
  urteile: { traegt: 4, lueckenhaft: 4, verfehlt: 1 },
  proTextsorte: [{ textsorte: 'bericht', anzahl: 6, traegt: 3, lueckenhaft: 2, verfehlt: 1 }],
  luecken: [{ textsorte: 'bericht', nr: 3, fehlt: 4, teilweise: 1 }],
  wFragen: [{ frage: 'warum', anzahl: 5 }],
  seiten: [{ titel: 'Gemeinde streicht Budget', textsorte: 'bericht', urteil: 'verfehlt',
    maengel: [{ nr: 3, status: 'fehlt', befund: 'Zahlen ohne Quelle.' }] }],
  seitenGekuerzt: 2,
};

test('ohne Struktur-Befunde entsteht kein Block', () => {
  for (const [, p] of Object.entries(alleReviewPrompts('journalismus'))) {
    assert.ok(!p.includes('FORM-BEFUNDE'), 'Block ohne Daten');
  }
});

test('Struktur-Befunde landen in allen vier Bewertungs-Prompts', () => {
  const o = { buchtyp: 'journalismus', strukturContext: STRUKTUR_CTX };
  const prompts = {
    buchSingle:    R.buildBookReviewSinglePassPrompt('B', 3, TEXT, o),
    buchMulti:     R.buildBookReviewMultiPassPrompt('B', [ANALYSE()], 3, o),
    kapitelSingle: R.buildChapterReviewPrompt('K', 'B', 2, TEXT, o),
    kapitelMulti:  R.buildChapterReviewMultiPassPrompt('K', 'B', [ANALYSE()], 2, o),
  };
  for (const [name, p] of Object.entries(prompts)) {
    assert.match(p, /=== FORM-BEFUNDE DES STRUKTUR-CHECKS/, name);
    assert.ok(p.includes('9 von 14 Beiträgen'), `${name}: Abdeckung`);
    // Die Kernrahmung: ungeprüft ≠ in Ordnung.
    assert.match(p, /UNBEKANNT, nicht in Ordnung/, name);
    // Und: verwenden, nicht nacherzählen.
    assert.match(p, /Verwende den Befund, zähle ihn nicht noch einmal auf/, name);
    // Regel-Wortlaut kommt aus der Textsorten-SSoT, nicht aus einer Kopie.
    assert.ok(p.includes('Bericht, Regel 3'), `${name}: Regel benannt`);
    assert.ok(p.includes('«Gemeinde streicht Budget»'), `${name}: auffälliger Beitrag`);
    assert.ok(p.includes('2 weitere auffällige Beiträge'), `${name}: Deckel ausgewiesen`);
  }
});

test('der Block zeigt auf eine Achse, die das Profil wirklich führt', () => {
  const achseVon = (buchtyp, build) => {
    const p = build({ buchtyp, strukturContext: STRUKTUR_CTX });
    return p.match(/Stütze die Achse "(\w+)"/)[1];
  };
  const buch = (o) => R.buildBookReviewSinglePassPrompt('B', 3, TEXT, o);
  const kap  = (o) => R.buildChapterReviewPrompt('K', 'B', 2, TEXT, o);
  assert.equal(achseVon('journalismus', buch), 'textsortentreue');
  assert.equal(achseVon('journalismus', kap), 'textsortentreue');
  // Ein Blog läuft auf `sachlich` — dort gibt es keine Textsorten-Achse.
  assert.equal(achseVon('blog', buch), 'struktur');
  assert.equal(achseVon('blog', kap), 'kohaerenz');
  for (const [bt, build, scope] of [['journalismus', buch, 'book'], ['blog', buch, 'book'],
    ['journalismus', kap, 'chapter'], ['blog', kap, 'chapter']]) {
    const achse = achseVon(bt, build);
    const axes = (scope === 'book' ? T.bookReviewAxes(bt) : T.chapterReviewAxes(bt)).map(a => a.key);
    assert.ok(axes.includes(achse), `${bt}/${scope}: «${achse}» ist keine Achse dieses Profils`);
  }
});

test('Zitat-Regel kündigt die serverseitige Prüfung an', () => {
  for (const bt of ['roman', 'lyrik']) {
    const p = R.buildBookReviewSinglePassPrompt('B', 3, TEXT, { buchtyp: bt });
    assert.match(p, /serverseitig gegen den Text geprüft/);
  }
});
