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

/** Jahres-Buchstaben („2020a" / „2020b") fuer Quellen, die im Kurzbeleg sonst
 *  nicht unterscheidbar waeren.
 *
 *  DAS PROBLEM: In den Autor-Jahr-Stilen ist „(Müller, 2020)" der Zeiger ins
 *  Verzeichnis. Hat derselbe Urheber im selben Jahr zwei Titel veroeffentlicht,
 *  zeigt der Beleg auf zwei Eintraege gleichzeitig — die Angabe ist dann in
 *  beide Richtungen unaufloesbar. APA und Chicago haengen darum einen
 *  Kleinbuchstaben an, im Kurzbeleg UND im Verzeichniseintrag.
 *
 *  Vergeben wird nach der Verzeichnis-Reihenfolge der Gruppe, also alphabetisch
 *  nach Titel — nicht nach Erstzitat. Sonst haengt der Buchstabe daran, in welcher
 *  Reihenfolge der Autor die Belege gesetzt hat, und verschiebt sich beim
 *  Umstellen eines Kapitels.
 *
 *  BEZUGSMENGE IST DAS BUCH, nicht die gerenderte Einheit: `2020a` soll im
 *  Kapitel-PDF dasselbe Werk meinen wie im Buch-PDF. Anders als die Nummern des
 *  numerischen Stils (die der Einheit folgen, siehe assignNumbers) ist der
 *  Buchstabe damit stabil.
 *
 *  Nur datierte Werke bekommen einen Buchstaben: ohne vierstellige Jahreszahl
 *  gibt es nichts zu disambiguieren, was ein Buchstabe loesen wuerde („o. J.a"
 *  waere eine eigene Konvention und ist bewusst nicht drin).
 *
 *  Gruppen aus genau einem Werk bleiben leer — ein einzelnes „Müller 2020a" ohne
 *  ein „2020b" daneben waere eine Falschmeldung an den Leser.
 *
 *  @param {Array} sources  alle Quellen des Buchs
 *  @returns {Map<number,string>} sources.id → 'a' | 'b' | … (nur Mehrdeutige) */
export function assignYearSuffixes(sources, { lang = 'de' } = {}) {
  const out = new Map();
  const list = Array.isArray(sources) ? sources : [];
  const collator = new Intl.Collator(lang === 'en' ? 'en' : 'de', { sensitivity: 'base', numeric: true });

  const groups = new Map();
  for (const s of list) {
    if (!s || s.id == null) continue;
    const y = _yearNum(s);
    if (y < 0) continue;
    const key = `${sortKeyOf(s).trim().toLowerCase()}|${y}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => collator.compare(String(a.title || ''), String(b.title || '')));
    group.forEach((s, i) => out.set(s.id, _letter(i)));
  }
  return out;
}

// 0→'a', 25→'z', 26→'aa'. Mehr als 26 Titel desselben Urhebers im selben Jahr
// sind Theorie, sollen aber keine Kollision erzeugen.
function _letter(i) {
  let n = i;
  let s = '';
  do {
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
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
