'use strict';
// Lesepfad des Loesch-Logs `page_deletions`.
//
// Geschrieben wird die Tabelle ausschliesslich am Content-Store-Chokepoint
// ([lib/content-store/backends/localdb-delete.js]) — hart geloeschte Seiten
// lassen sich sonst nicht mehr nachweisen, weder fuer den Collab-Toast noch fuer
// den Delta-Sync der nativen Clients.
//
// Der Collab-Feed (`GET /content/books/:id/changes`) hat seine eigene Abfrage:
// sie exkludiert das anfragende Geraet und joint Anzeigenamen dazu. Hier steht
// die schlichte Form fuer den Sync-Delta — ohne Self-Filter, weil der lokale
// Spiegel eines Clients auch die eigenen Loeschungen nachziehen muss.

const { db } = require('./connection');

// Loeschungen eines Buchs nach `sinceIso` (exklusiv), aelteste zuerst.
// `limit` wird um eins ueberzogen abgefragt, damit der Aufrufer `has_more`
// ohne zweite Abfrage erkennt — er schneidet selbst auf `limit`.
function listDeletionsSince(bookId, sinceIso, limit) {
  if (!bookId || !sinceIso) return [];
  return db.prepare(`
    SELECT page_id, page_name, deleted_at
      FROM page_deletions
     WHERE book_id = ? AND deleted_at > ?
     ORDER BY deleted_at ASC, page_id ASC
     LIMIT ?
  `).all(bookId, sinceIso, Math.max(1, limit | 0) + 1);
}

module.exports = { listDeletionsSince };
