'use strict';
// CRUD für die Motiv-Werkstatt (Themen & Motive als Konstellation) — reine
// Facade über die Domänen-Module unter db/motifs/. Pro Buch + User skopiert; der
// Owner-/ACL-Check geschieht im Route-Handler.
//
// Datenmodell:
//   themes            — abstrakte Cluster (Schuld & Vergebung …), geordnet via position.
//   motifs            — die zentrale Nabe; theme_id (SET NULL) ordnet sie einem Thema zu.
//   motif_relations   — gerichtete Motiv-↔-Motiv-Kanten (typ Freitext).
//   motif_{figures,draft_figures,beats,chapters,pages} — Soll-Brücken (wo ein Motiv laut Plan trägt).
//   motif_occurrences — Ist-Index: wo die KI-Motiverkennung das Motiv real fand.
//   motif_{brainstorm,consistency}_runs — Lauf-Historie der beiden KI-Jobs.
//
// Figuren werden nach aussen als TEXT-fig_id exponiert (Frontend-Identität, vgl.
// plot_beat_figures); intern liegt der INTEGER-FK figures.id. Die Route löst um.
//
// Neue Funktion gehört ins passende Modul unter db/motifs/ und wird hier nur
// re-exportiert — keine Logik in der Facade.

const catalog = require('./motifs/catalog');
const relations = require('./motifs/relations');
const links = require('./motifs/links');
const occurrences = require('./motifs/occurrences');
const runs = require('./motifs/runs');
const graph = require('./motifs/graph');

module.exports = {
  // Themen + Motive
  ...catalog,
  // Beziehungen
  ...relations,
  // Soll-Brücken + Scoping-Validatoren
  ...links,
  // Ist-Index + Soll-Motive einer Seite
  ...occurrences,
  // KI-Lauf-Historien + Brainstorm-Delta-Cache
  ...runs,
  // Graph-Payload + Knoten-Layout
  ...graph,
};
