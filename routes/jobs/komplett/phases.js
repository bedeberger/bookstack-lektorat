'use strict';
// Facade: Komplettanalyse-Pipeline-Phasen, nach Domäne in das phases/-Subfolder
// aufgeteilt (File-Limit >600 LOC). Externer Einstieg (job.js) ausschliesslich über
// diese Datei. Interne Aufteilung:
//   tokens                 – komplettMaxTokens (geteilt, separat gegen Zirkular-Imports)
//   extraktion             – Phase 1 Vollextraktion (Single-/Multi-Pass) + Completeness-Gap
//   figuren                – Phase 2 Figuren-Konsolidierung + Soziogramm
//   orte                   – Phase 3 Orte/Songs (+ Fallback-Merges, Prelim, paralleler Orte-Call)
//   beziehungen-zeitstrahl – Phase 3b kapitelübergreifende Beziehungen + Phase 6 Zeitstrahl
//   kontinuitaet           – Block 2: Zeitstrahl + Kontinuität (P8) + Attribut-Detektor
//   coverage               – Coverage-Self-Audit (Extraktions-Recall, rein diagnostisch)
const { komplettMaxTokens } = require('./phases/tokens');
const { runPhase1 } = require('./phases/extraktion');
const { runPhase2 } = require('./phases/figuren');
const {
  runPhase3, runPhase3Songs, buildPrelimFigurenKompakt, runPhase3OrteCall,
} = require('./phases/orte');
const { runPhase3b, runZeitstrahl } = require('./phases/beziehungen-zeitstrahl');
const { runErzaehlprofil } = require('./phases/erzaehlprofil');
const { runKontinuitaetPhase } = require('./phases/kontinuitaet');
const { runCoverageAudit } = require('./phases/coverage');

module.exports = {
  runPhase1, runPhase2, runPhase3, runPhase3Songs,
  buildPrelimFigurenKompakt, runPhase3OrteCall, runPhase3b, runZeitstrahl,
  runErzaehlprofil, runKontinuitaetPhase, runCoverageAudit,
  komplettMaxTokens,
};
