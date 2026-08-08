'use strict';
// Quellen als persoenliche Bibliothek — Facade ueber db/sources/.
//
// Skopierung: die Quelle gehoert dem User (`owner_email`), nicht dem Buch — eine
// Literaturbibliothek ist personen-, nicht werkgebunden. Ein Buch referenziert
// sie ueber die Bruecke `book_source_links`; dieselbe Quelle liegt in beliebig
// vielen Buechern, ohne dort erneut erfasst zu werden.
//
// Daraus folgen zwei Operationen, die nicht verwechselt werden duerfen:
//   unlinkSource  entfernt die Quelle aus EINEM Buch (Bruecke), Pool bleibt
//   deleteSource  loescht sie aus der Bibliothek — und damit aus ALLEN Buechern
// Die Zugriffsregeln dazu liegen in routes/sources.js, die Fachdoku in
// docs/quellen.md.
//
// Aufteilung — fuenf Themen, die nur die Tabelle teilen:
//   shared.js       Feld-Inventar, Normalisierung, SQL-Fragmente, Zeilen-Mapper
//   pool.js         die Bibliothek: CRUD + Dublettenfragen
//   links.js        Bruecke Buch ↔ Quelle
//   citations.js    abgeleiteter Fund-Index + Zitat-Kennzahlen
//   detect-runs.js  Historie der Quellen-Erkennung
//   doc.js          PDF-Anhang (BLOB + Volltext + Index-Stempel)
//
// authors/editors sind JSON-Arrays [{family, given} | {literal}] nach CSL-JSON;
// `literal` fuer Koerperschaften ("Bundesamt fuer Statistik"). Normalisiert wird
// in shared.js, damit jeder Schreibpfad (Formular, BibTeX-Import, DOI-Lookup,
// Browser-Erfassung) dieselbe Form ablegt.

const shared = require('./sources/shared');
const pool = require('./sources/pool');
const links = require('./sources/links');
const citations = require('./sources/citations');
const detectRuns = require('./sources/detect-runs');
const doc = require('./sources/doc');

module.exports = {
  // Feld-Inventar + Normalisierung (shared)
  CSL_TYPES: shared.CSL_TYPES,
  TEXT_FIELDS: shared.TEXT_FIELDS,
  OTON_CHANNELS: shared.OTON_CHANNELS,
  OTON_AUTH: shared.OTON_AUTH,
  normalizePersons: shared.normalizePersons,

  ...pool,
  ...links,
  ...citations,
  ...detectRuns,
  ...doc,
};
