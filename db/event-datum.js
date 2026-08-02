// SSoT für die Datums-Aufbereitung von Events beim Schreiben — geteilt von
// beiden Zielen: `zeitstrahl_events` (db/schema.js#saveZeitstrahlEvents) und
// `figure_events` (db/figures.js#updateFigurenEvents). Beide Tabellen tragen
// dieselben Spalten und müssen exakt gleich befüllt werden; die Auswertung
// (Sortierung, Jahres-Band, Buch-Epoche) liest je nach Pipeline-Stand aus der
// einen oder der anderen.
//
// Zwei Stufen:
//   1. normalizeDatumFields (lib/datum-parse) — «welche Zahl heisst unbekannt»
//   2. parseDatum-Fallback  — Freitext-Label zerlegen, wenn die KI kein
//      strukturiertes Feld geliefert hat
const { parseDatum, normalizeDatumFields } = require('../lib/datum-parse');
const { normEventSubtyp } = require('./event-subtyp');

/**
 * Baut aus dem rohen Event-Objekt der KI die einfügefertigen Datums-Spalten.
 * @param {object} ev  Roh-Event aus dem AI-Output.
 * @returns {object}   { datum_label, datum_year, datum_month, datum_day,
 *                       datum_ende_*, story_tag, datum_unsicher, subtyp }
 */
function structuredDatum(ev) {
  const labelSrc = ev.datum_label || ev.datum || '';
  const p = parseDatum(labelSrc);
  // Normalisierung ZUERST auf den AI-Output: dessen 0-Platzhalter müssen zu
  // null werden, BEVOR `??` entscheidet, ob der parseDatum-Fallback greift —
  // sonst gewinnt die 0 gegen ein aus dem Label geparstes echtes Datum.
  const ai = normalizeDatumFields(ev);
  const d = normalizeDatumFields({
    datum_year:       ai.datum_year       ?? p.year      ?? null,
    datum_month:      ai.datum_month      ?? p.month     ?? null,
    datum_day:        ai.datum_day        ?? p.day       ?? null,
    datum_ende_year:  ai.datum_ende_year,
    datum_ende_month: ai.datum_ende_month,
    datum_ende_day:   ai.datum_ende_day,
    story_tag:        ai.story_tag        ?? p.story_tag ?? null,
  });
  return {
    datum_label: (ev.datum_label || ev.datum || p.label || '').toString(),
    ...d,
    // "unsicher" nur sinnvoll mit Jahr; abgeleitetes Jahr von der KI markiert.
    datum_unsicher: (ev.datum_unsicher && d.datum_year != null) ? 1 : 0,
    subtyp: normEventSubtyp(ev.subtyp),
  };
}

module.exports = { structuredDatum };
