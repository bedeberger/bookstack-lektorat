const { db } = require('../connection');
const { mergeFigures } = require('../entity-merge');
require('../migrations');

/** Post-Hoc-Cleanup für bereits gespeicherte Figuren-Daten eines Buchs/Users.
 *  1. Namens-Duplikate zusammenführen (case-insensitive, normalisiert). Das
 *     Umhängen aller Referenzen + Löschen der Dublette macht `mergeFigures`
 *     ([db/entity-merge.js](../entity-merge.js)) — dieselbe Funktion, die auch der
 *     manuelle Merge aus den Bucheinstellungen nutzt. **Why:** eine zweite,
 *     lokale Merge-Implementierung hier deckte nur sechs Brücken ab und liess
 *     plot_beat_figures/research_item_links/song_figures/motif_figures per CASCADE
 *     wegfallen; die Tabellenliste gehört an genau eine Stelle.
 *  2. figure_relations dedupliziert (pro ungeordnetem Paar max 1), Relations mit
 *     nicht-existierenden fig_ids oder Selbst-Referenz entfernt.
 *  3. Beziehungs-Beschreibungen geleert, die den Namen der Zielfigur nicht enthalten
 *     (häufiger Verrutscher bei Lokal-KI).
 *
 *  Performance: Statt einer einzigen umfassenden `db.transaction` läuft der
 *  Cleanup in vielen kleinen Transaktionen (eine pro Duplikat-Gruppe + je eine
 *  für Relations-Dedup und Description-Rescue). better-sqlite3 ist synchron;
 *  ein einziger grosser Transaction-Block würde den WAL-Writer-Lock minutenlang
 *  halten und konkurrierende Requests blockieren. Per-Gruppe-Transaktionen
 *  geben den Lock zwischendurch frei. `onProgress(done, total)` (optional) liefert
 *  Fortschritt für UI-Polling. */
function cleanupDuplicateFiguren(bookId, userEmail, onProgress = null) {
  const em = userEmail || null;
  const stats = { figurenMerged: 0, relationsRemoved: 0, descriptionsCleared: 0, descriptionsMoved: 0 };
  const normalize = s => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');

  const figs = db.prepare(
    'SELECT id, fig_id, name, kurzname, typ, geburtstag, geschlecht, beruf, wohnadresse, beschreibung, sozialschicht FROM figures WHERE book_id = ? AND user_email IS ? ORDER BY sort_order, id'
  ).all(bookId, em);

  const groups = new Map();
  for (const f of figs) {
    const key = normalize(f.name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }

  // Phase 1: Duplikat-Gruppen mergen — eine Transaktion pro Gruppe, damit der
  // WAL-Lock zwischen Gruppen freigegeben wird (vorher: ein einziger Block über
  // alle Gruppen, der den Server für die Dauer aller Merges blockierte).
  // Die Referenz-Arbeit pro Paar macht mergeFigures (geteilter Merge-Kern);
  // hier bleibt nur die Gruppenbildung + die Wahl der kanonischen Figur.
  const groupArr = [...groups.values()].filter(g => g.length >= 2);
  const totalSteps = groupArr.length + 2; // +1 für Relations-Dedup, +1 für Description-Rescue
  let stepDone = 0;
  for (const group of groupArr) {
    // Reichste Beschreibung gewinnt; die übrigen werden in sie hineingemergt
    // (mergeFigures füllt leere Felder der kanonischen Figur aus der Dublette).
    group.sort((a, b) => (b.beschreibung?.length || 0) - (a.beschreibung?.length || 0));
    const canon = group[0];
    db.transaction(() => {
      for (const dup of group.slice(1)) {
        mergeFigures(bookId, em, dup.id, canon.id);
        stats.figurenMerged++;
      }
    })();
    stepDone++;
    if (onProgress) onProgress(stepDone, totalSteps);
  }

  // Phase 2: Relations-Dedup (eine Transaktion). FK CASCADE faengt orphans
  // ohnehin ab — verbleibender Check ist Self-Ref + Pair-Dedup.
  db.transaction(() => {
    const rels = db.prepare(
      'SELECT rowid, from_fig_id, to_fig_id FROM figure_relations WHERE book_id = ? AND user_email IS ?'
    ).all(bookId, em);
    const seenPair = new Set();
    const toDelete = [];
    for (const r of rels) {
      if (r.from_fig_id === r.to_fig_id) { toDelete.push(r.rowid); continue; }
      const [a, b] = r.from_fig_id < r.to_fig_id ? [r.from_fig_id, r.to_fig_id] : [r.to_fig_id, r.from_fig_id];
      const key = `${a}|${b}`;
      if (seenPair.has(key)) toDelete.push(r.rowid);
      else seenPair.add(key);
    }
    if (toDelete.length) {
      const delRel = db.prepare('DELETE FROM figure_relations WHERE rowid = ?');
      for (const rid of toDelete) delRel.run(rid);
    }
    stats.relationsRemoved = toDelete.length;
  })();
  stepDone++;
  if (onProgress) onProgress(stepDone, totalSteps);

  // Phase 3: Description-Rescue (eine Transaktion).
  db.transaction(() => {
    // figLookup: integer figures.id (=DB-PK) als Schluessel — figure_relations.from/to_fig_id
    // sind seit Mig 72 INTEGER auf figures.id.
    const figByIdForRescue = db.prepare(
      'SELECT id, name, kurzname FROM figures WHERE book_id = ? AND user_email IS ?'
    ).all(bookId, em);
    const figLookup = figByIdForRescue.map(f => ({
      id: f.id,
      names: [f.name, f.kurzname].filter(Boolean).map(s => s.toLowerCase()),
    }));

    const relsWithNames = db.prepare(`
      SELECT r.rowid, r.from_fig_id, r.to_fig_id, r.typ, r.machtverhaltnis, r.beschreibung,
             f2.name AS to_name, f2.kurzname AS to_kurz
      FROM figure_relations r
      LEFT JOIN figures f2 ON f2.id = r.to_fig_id
      WHERE r.book_id = ? AND r.user_email IS ? AND r.beschreibung IS NOT NULL AND r.beschreibung != ''
    `).all(bookId, em);
    const clearDesc = db.prepare('UPDATE figure_relations SET beschreibung = NULL WHERE rowid = ?');
    const getRel = db.prepare(
      'SELECT rowid, beschreibung FROM figure_relations WHERE book_id = ? AND user_email IS ? AND from_fig_id = ? AND to_fig_id = ?'
    );
    const setDesc = db.prepare('UPDATE figure_relations SET beschreibung = ? WHERE rowid = ?');
    const insRel = db.prepare(
      'INSERT INTO figure_relations (book_id, from_fig_id, to_fig_id, typ, beschreibung, machtverhaltnis, user_email) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );

    for (const r of relsWithNames) {
      const targets = [r.to_name, r.to_kurz].filter(Boolean).map(s => s.toLowerCase());
      if (!targets.length) continue;
      const text = r.beschreibung.toLowerCase();
      if (targets.some(n => text.includes(n))) continue;

      const candidates = figLookup.filter(c =>
        c.id !== r.from_fig_id && c.id !== r.to_fig_id && c.names.some(n => text.includes(n))
      );
      if (candidates.length === 1) {
        const target = candidates[0];
        const existing = getRel.get(bookId, em, r.from_fig_id, target.id);
        if (existing && !existing.beschreibung) {
          setDesc.run(r.beschreibung, existing.rowid);
          clearDesc.run(r.rowid);
          stats.descriptionsMoved++;
          continue;
        }
        if (!existing) {
          insRel.run(bookId, r.from_fig_id, target.id, r.typ, r.beschreibung, r.machtverhaltnis ?? null, em);
          clearDesc.run(r.rowid);
          stats.descriptionsMoved++;
          continue;
        }
      }
      clearDesc.run(r.rowid);
      stats.descriptionsCleared++;
    }
  })();
  stepDone++;
  if (onProgress) onProgress(stepDone, totalSteps);

  return stats;
}

module.exports = { cleanupDuplicateFiguren };
