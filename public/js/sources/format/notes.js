// Anmerkungsapparat: die Form EINER Note (End- oder Fussnote).
//
// Unterschied zum Verzeichniseintrag (styles.js): ein Verzeichnis listet WERKE,
// ein Apparat listet BELEGSTELLEN. Darum drei Dinge, die es im Verzeichnis nicht
// gibt — die Stellenangabe („S. 44") gehoert in die Note, dieselbe Quelle kann
// mehrfach vorkommen, und Wiederholungen werden gekuerzt.
//
// DIE DREI FORMEN, in der Reihenfolge, in der sie greifen:
//
//   full    Erstnennung im Kapitel → der vollstaendige Eintrag + Stellenangabe.
//   ibid    Die unmittelbar vorangehende Note belegt DIESELBE Quelle → „Ebd."
//           (bzw. „Ibid."). Nur die Stellenangabe kommt dazu, und auch die nur,
//           wenn sie sich geaendert hat: „Ebd." allein heisst „gleiche Quelle,
//           gleiche Stelle".
//   opCit   Die Quelle kam im Kapitel schon vor, aber nicht direkt davor →
//           Kurzname + „a. a. O." (bzw. „op. cit.") + Stellenangabe.
//
// KEIN „ders."/„dies.": Die Kurzform fuer „derselbe Urheber, anderes Werk" gibt
// es im Deutschen nur in grammatisch gegenderter Form. Welches Geschlecht eine
// reale Person hat, steht nirgends im Datenmodell (`authors` fuehrt nur
// family/given/literal) und laesst sich aus einem Vornamen nicht erschliessen —
// ein geratenes „Ders." vergendert Autorinnen in einem gedruckten Buch. Der
// Apparat wiederholt an dieser Stelle stattdessen den Nachnamen; das ist in jedem
// Stil zulaessig und nie falsch.
//
// Reines Modul wie der Rest von format/ — keine DOM-/Alpine-Abhaengigkeit, damit
// der Server es im Render-Pfad laden kann (lib/endnotes.js).

import { txt, joinParts, terminate, pageLabel } from './runs.js';
import { shortNames } from './persons.js';

/** Stellenangabe einer Belegstelle als Run-Liste.
 *
 *  Gleiche Regel wie im Kurzbeleg (format.js#_loc): beginnt der Wert mit einer
 *  Ziffer, kommt die Sprach-Abkuerzung davor („44" → „S. 44"); beginnt er mit
 *  einem Buchstaben, hat der Autor bereits qualifiziert („Kap. 3", „Abs. 12")
 *  und der Wert bleibt unveraendert. Verhindert „S. S. 44". */
export function locatorRuns(loc, labels) {
  const s = loc == null ? '' : String(loc).trim();
  if (!s) return [];
  return txt(/^\d/.test(s) ? pageLabel(s, labels) : s);
}

/** Welche Form eine Belegstelle bekommt.
 *
 *  @param {object} cur   `{ sourceId, loc }` der aktuellen Belegstelle
 *  @param {object|null} prev  die unmittelbar vorangehende Note desselben
 *                             Kapitels (oder null bei der ersten)
 *  @param {Set} seen     Quellen-IDs, die im Kapitel schon eine Note haben
 *  @returns {'full'|'ibid'|'opCit'} */
export function noteForm(cur, prev, seen) {
  if (prev && prev.sourceId === cur.sourceId) return 'ibid';
  if (seen && seen.has(cur.sourceId)) return 'opCit';
  return 'full';
}

/** Die Runs EINER Note.
 *
 *  `fullRuns` ist der vollstaendige Eintrag aus formatFullRuns — er wird
 *  uebergeben statt hier gebaut, damit dieses Modul die Stil-Builder nicht kennen
 *  muss und der Jahres-Buchstabe („2020a") schon drinsteckt.
 *
 *  @param {object} args
 *  @param {'full'|'ibid'|'opCit'} args.form
 *  @param {Array}  args.fullRuns   Voll-Eintrag (nur bei form='full' benutzt)
 *  @param {object} args.source     Quellen-Objekt (fuer den Kurznamen)
 *  @param {string} args.loc        Stellenangabe dieser Belegstelle
 *  @param {string} args.prevLoc    Stellenangabe der vorangehenden Note
 *  @param {string} args.style      Zitierstil (fuer die Kurznamen-Schwellen)
 *  @param {object} args.labels     labelsFor(lang) */
export function noteRuns({ form, fullRuns = [], source = null, loc = '', prevLoc = '', style = 'apa7', labels }) {
  const locRuns = locatorRuns(loc, labels);

  if (form === 'ibid') {
    // „Ebd." allein heisst: gleiche Quelle, gleiche Stelle. Nur bei geaenderter
    // Stelle kommt sie dazu — sonst stuende in jeder Wiederholung dieselbe
    // Seitenzahl, was den Apparat aufblaeht, ohne etwas zu sagen.
    const same = String(loc || '').trim() === String(prevLoc || '').trim();
    if (same || !locRuns.length) return terminate(txt(labels.ibidWord));
    return terminate(joinParts([txt(labels.ibidWord), locRuns], ', '));
  }

  if (form === 'opCit') {
    // Kurzname wie im Autor-Jahr-Kurzbeleg; im numerischen Stil gibt es keine
    // eigene Kurznamen-Schwelle, darum dort die APA-Regel (siehe format.js).
    const names = shortNames(
      (Array.isArray(source?.authors) && source.authors.length) ? source.authors : source?.editors,
      style === 'numeric' ? 'apa7' : style,
      labels,
    ) || String(source?.title || '').trim() || labels.noTitle;
    return terminate(joinParts([txt(names), txt(labels.opCitWord), locRuns], ', '));
  }

  // full: Voll-Eintrag, Stellenangabe hinten angehaengt.
  if (!locRuns.length) return terminate(fullRuns);
  // `joinParts` mit ', ' kollabiert den Schlusspunkt des Eintrags nicht — der
  // Eintrag endet terminal, die Stelle gehoert aber noch dazu. Darum den
  // Schlusspunkt vor dem Anhaengen abtragen.
  return terminate(joinParts([_unterminate(fullRuns), locRuns], ', '));
}

// Schlusspunkt des Voll-Eintrags entfernen, damit „…, Verlag. , S. 44" nicht
// entsteht. Nur der Punkt am ALLERLETZTEN Run, und nur wenn es einer ist —
// Fragezeichen/Ausrufezeichen eines Werktitels bleiben stehen.
function _unterminate(runs) {
  const list = (runs || []).filter(r => r && r.text);
  if (!list.length) return list;
  const last = list[list.length - 1];
  if (!/\.$/.test(last.text)) return list;
  return [...list.slice(0, -1), { ...last, text: last.text.replace(/\.$/, '') }];
}
