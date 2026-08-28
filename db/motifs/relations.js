'use strict';
// Motiv-Werkstatt — gerichtete Motiv-↔-Motiv-Kanten (`motif_relations`, typ als
// Freitext mit kuratierten Vorschlägen im Frontend). Die Erwartungs-Familien der
// kuratierten Typen liegen in lib/motif-consistency.js, nicht hier: dies ist die
// Speicherschicht, sie interpretiert `typ` nicht.

const { db } = require('../connection');
// Migrationen vor den prepare()-Aufrufen erzwingen (wie db/schema.js & Co.): das
// Modul bereitet seine Statements beim Laden vor — ohne die Kette fehlt auf einer
// noch nicht migrierten DB die Tabelle und der Require wirft.
require('../migrations');
const { NOW_ISO_SQL } = require('../now');

// ── Motiv-Beziehungen (Motiv ↔ Motiv) ──────────────────────────────────────

const _stmtListRelations = db.prepare(`
  SELECT r.id, r.from_motif_id, r.to_motif_id, r.typ, r.created_at
    FROM motif_relations r
    JOIN motifs mf ON mf.id = r.from_motif_id
   WHERE mf.book_id = ? AND mf.user_email = ?
   ORDER BY r.id
`);
const _stmtInsertRelation = db.prepare(`
  INSERT OR IGNORE INTO motif_relations (from_motif_id, to_motif_id, typ, created_at)
  VALUES (?, ?, ?, ${NOW_ISO_SQL})
`);
const _stmtDeleteRelation = db.prepare('DELETE FROM motif_relations WHERE id = ?');

function listRelations(bookId, userEmail) {
  return _stmtListRelations.all(parseInt(bookId), userEmail);
}
// Owner/Buch der Beziehung über das Quell-Motiv (für den ACL-Check beim Löschen).
const _stmtRelationOwner = db.prepare(`
  SELECT m.book_id, m.user_email
    FROM motif_relations r JOIN motifs m ON m.id = r.from_motif_id
   WHERE r.id = ?
`);
function getRelationOwner(id) {
  return _stmtRelationOwner.get(parseInt(id)) || null;
}
function createRelation(fromMotifId, toMotifId, typ) {
  // INSERT OR IGNORE: bei Duplikat (UNIQUE) ist changes=0; lastInsertRowid bleibt
  // dann auf dem vorherigen Insert stehen → nur bei echtem Insert die ID liefern.
  const info = _stmtInsertRelation.run(parseInt(fromMotifId), parseInt(toMotifId), String(typ));
  return info.changes ? info.lastInsertRowid : null;
}
function deleteRelation(id) {
  _stmtDeleteRelation.run(parseInt(id));
}

module.exports = { listRelations, getRelationOwner, createRelation, deleteRelation };
