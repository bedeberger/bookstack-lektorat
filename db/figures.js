// Facade des Figuren-Datenzugriffs. Die Umsetzung liegt in ./figures/:
// refs (fig_id↔id-Übersetzung, Namens-/Beleg-Auflösung), save (Match-Planung +
// die drei Reconcile-Modi), events (Lebensereignisse, Soziogramm, nachgetragene
// Beziehungen), cleanup (Post-Hoc-Dedup) und queries (Lesepfade + der
// abgeleitete Auftritts-Index). Externe Konsumenten importieren nur diese Datei.

const { RELATION_INVERSES, dedupRelations, figIdMaps } = require('./figures/refs');
const { planFigurenMatch, saveFigurenToDb } = require('./figures/save');
const { updateFigurenEvents, updateFigurenSoziogramm, addFigurenBeziehungen } = require('./figures/events');
const { cleanupDuplicateFiguren } = require('./figures/cleanup');
const {
  listFigurenWithDetails, getChapterFigures, rebuildFigureAppearances,
  getChapterFigureRelations, getFigureWithDetails,
} = require('./figures/queries');

module.exports = {
  planFigurenMatch,
  RELATION_INVERSES,
  dedupRelations,
  figIdMaps,
  saveFigurenToDb,
  updateFigurenEvents,
  updateFigurenSoziogramm,
  addFigurenBeziehungen,
  cleanupDuplicateFiguren,
  listFigurenWithDetails,
  getChapterFigures,
  getChapterFigureRelations,
  getFigureWithDetails,
  rebuildFigureAppearances,
};
