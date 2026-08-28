// Pure Compute der Karte „Meine Buecher" (Buecherregal). Ohne Alpine, ohne
// fetch — damit die Ordnung des Regals und die Filter-Semantik testbar sind
// (tests/unit/my-books-compute.test.mjs).
//
// Der Server liefert Kennzahlen je `book_id`, aber KEINE Buchnamen (Content-
// Store-Regel — die Namen hat das Frontend schon aus `/content/books`). Das
// Zusammenfuehren ist deshalb Frontend-Arbeit und passiert hier an genau einer
// Stelle.

/** Status-Reiter des Regals. `aktiv` blendet Archiviertes aus — ein Archiv,
 *  das in der Standardansicht mitlaeuft, archiviert nichts. */
export const SHELF_TABS = ['aktiv', 'fertig', 'archiviert', 'alle'];

/**
 * Server-Zeilen (`/me/books`) mit der geladenen Buchliste zusammenfuehren.
 * Buecher ohne Server-Zeile fallen NICHT weg (frisch angelegt, noch ohne
 * Kennzahlen) — sie erscheinen als Nullzeile; ein Buch, das der Server nicht
 * mehr kennt, verschwindet dagegen (Zugriff entzogen).
 */
export function mergeShelfRows(serverRows, books, categoryNames = new Map()) {
  const byId = new Map();
  for (const b of books || []) byId.set(String(b.id), b);
  const seen = new Set();
  const out = [];
  for (const r of serverRows || []) {
    const key = String(r.book_id);
    const b = byId.get(key);
    if (!b) continue; // kein Zugriff mehr / anderes Buch
    seen.add(key);
    out.push(_row(r, b, categoryNames));
  }
  for (const b of books || []) {
    if (seen.has(String(b.id))) continue;
    out.push(_row({ book_id: b.id }, b, categoryNames));
  }
  return out;
}

function _row(r, b, categoryNames) {
  const catId = b.category_id == null ? null : String(b.category_id);
  return {
    book_id: Number(b.id),
    name: b.name || '',
    role: r.role || b.role || null,
    buchtyp: b.buchtyp || null,
    category_id: b.category_id ?? null,
    category: catId ? (categoryNames.get(catId) || null) : null,
    pinned: !!(r.pinned ?? b.pinned),
    archived: !!(r.archived ?? b.archived),
    pinned_at: r.pinned_at || null,
    archived_at: r.archived_at || null,
    is_finished: !!r.is_finished,
    chars: r.chars || 0,
    words: r.words || 0,
    pages: r.pages || 0,
    chapters: r.chapters || 0,
    writing_seconds: r.writing_seconds || 0,
    lektorat_seconds: r.lektorat_seconds || 0,
    share_links: r.share_links || 0,
    share_links_active: r.share_links_active || 0,
    share_views: r.share_views || 0,
    comments: r.comments || 0,
    comments_unread: r.comments_unread || 0,
    snapshots: r.snapshots || 0,
    snapshot_last_at: r.snapshot_last_at || null,
    exports: r.exports || 0,
    export_last_at: r.export_last_at || null,
    findings: r.findings || 0,
    pages_checked: r.pages_checked || 0,
    goal_target_chars: r.goal_target_chars ?? null,
    goal_deadline: r.goal_deadline || null,
    last_activity_at: r.last_activity_at || null,
  };
}

/**
 * Reiter + Freitext anwenden. Der Reiter entscheidet ueber Archiv-Sichtbarkeit,
 * die Suche filtert nur weiter (sie hebt das Archiv nicht auf — sonst taucht
 * Archiviertes beim Tippen wieder auf).
 */
export function filterShelfRows(rows, { tab = 'aktiv', query = '' } = {}) {
  const q = String(query || '').trim().toLowerCase();
  return (rows || []).filter((r) => {
    if (tab === 'aktiv' && (r.archived || r.is_finished)) return false;
    if (tab === 'fertig' && (!r.is_finished || r.archived)) return false;
    if (tab === 'archiviert' && !r.archived) return false;
    if (!q) return true;
    return r.name.toLowerCase().includes(q)
        || (r.category || '').toLowerCase().includes(q);
  });
}

/**
 * Angeheftete zuerst, danach die vom `sortableTable` bestimmte Ordnung. Der Pin
 * ist eine Aussage ueber die Reihenfolge — er darf von einer Spalten-Sortierung
 * nicht ueberstimmt werden, sonst ist er wirkungslos.
 */
export function pinnedFirst(rows) {
  const arr = [...(rows || [])];
  const idx = new Map(arr.map((r, i) => [r, i]));
  return arr.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.pinned && b.pinned) {
      const at = a.pinned_at || '', bt = b.pinned_at || '';
      if (at !== bt) return at < bt ? -1 : 1; // laenger angeheftet = weiter oben
    }
    return idx.get(a) - idx.get(b); // stabil: Sortier-Ordnung der Tabelle
  });
}

/** Summen fuer die Kopfzeile. Bewusst ueber die GEFILTERTE Menge — die Zahlen
 *  sollen zu dem passen, was darunter steht. */
export function shelfTotals(rows) {
  const t = {
    books: 0, finished: 0, archived: 0, pinned: 0,
    chars: 0, words: 0, pages: 0,
    writing_seconds: 0, exports: 0,
    share_links_active: 0, comments: 0, comments_unread: 0, snapshots: 0,
  };
  for (const r of rows || []) {
    t.books++;
    if (r.is_finished) t.finished++;
    if (r.archived) t.archived++;
    if (r.pinned) t.pinned++;
    t.chars += r.chars;
    t.words += r.words;
    t.pages += r.pages;
    t.writing_seconds += r.writing_seconds;
    t.exports += r.exports;
    t.share_links_active += r.share_links_active;
    t.comments += r.comments;
    t.comments_unread += r.comments_unread;
    t.snapshots += r.snapshots;
  }
  return t;
}

/** Rollen-Gate fuer den Fertig-Schalter: `is_finished` ist eine Buch-Einstellung
 *  und der Server verlangt dafuer `editor` (PUT /booksettings/:id/finished).
 *  Ohne dasselbe Gate im Frontend zeigt die Karte einen Knopf, der 403 liefert. */
export function mayToggleFinished(role) {
  return role === 'owner' || role === 'editor';
}
