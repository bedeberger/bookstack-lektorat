// Reihenfolge des Verzeichnisses + Nummernvergabe im numerischen Stil.

import { familyOf } from './persons.js';

/** Sortierschluessel eines Eintrags: erster Urheber, sonst erster Herausgeber,
 *  sonst der Titel (title-first-Eintrag). */
export function sortKeyOf(src) {
  const a = Array.isArray(src.authors) ? src.authors : [];
  const e = Array.isArray(src.editors) ? src.editors : [];
  return familyOf(a[0]) || familyOf(e[0]) || String(src.title || '').trim();
}

// Erste vierstellige Jahreszahl im Feld. `year` ist TEXT ("1915", "2019/2021",
// "o. J.") — ohne Zahl sortiert der Eintrag VOR den datierten, wie es APA und
// Chicago fuer undatierte Werke desselben Urhebers vorsehen.
function _yearNum(src) {
  const m = /\d{4}/.exec(String(src.year || ''));
  return m ? parseInt(m[0], 10) : -1;
}

/** Nummern nach Erstzitat.
 *  `citations` muss in Buch-Leserichtung vorliegen — genau das liefert
 *  db/sources.js#listBookCitations (Seitenposition, dann Textoffset).
 *  Rueckgabe: Map(source_id → 1..n). */
export function assignNumbers(citations) {
  const out = new Map();
  let n = 0;
  for (const c of Array.isArray(citations) ? citations : []) {
    const id = c?.source_id;
    if (id == null || out.has(id)) continue;
    out.set(id, ++n);
  }
  return out;
}

/** Verzeichnis-Reihenfolge. Mutiert die Eingabe nicht.
 *
 *  apa7/chicago-ad: alphabetisch nach Sortierschluessel (Collator der
 *  Buchsprache — im Deutschen sortiert 'ä' damit unter 'a', wie es das
 *  Verzeichnis verlangt), dann Jahr, dann Titel.
 *
 *  numeric: nach vergebener Nummer. Eintraege ohne Nummer (unzitiert, nur bei
 *  bibliography_scope='all' im Verzeichnis) haengen alphabetisch hinten an. */
export function sortEntries(sources, { style = 'apa7', lang = 'de', numbers = null } = {}) {
  const list = Array.isArray(sources) ? [...sources] : [];
  const collator = new Intl.Collator(lang === 'en' ? 'en' : 'de', { sensitivity: 'base', numeric: true });

  if (style === 'numeric') {
    const numOf = s => (numbers && numbers.has(s.id) ? numbers.get(s.id) : Infinity);
    return list.sort((a, b) => {
      const d = numOf(a) - numOf(b);
      if (d !== 0) return d;
      return collator.compare(sortKeyOf(a), sortKeyOf(b));
    });
  }

  return list.sort((a, b) => {
    const k = collator.compare(sortKeyOf(a), sortKeyOf(b));
    if (k !== 0) return k;
    const y = _yearNum(a) - _yearNum(b);
    if (y !== 0) return y;
    return collator.compare(String(a.title || ''), String(b.title || ''));
  });
}
