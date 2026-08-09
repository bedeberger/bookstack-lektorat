const { db } = require('../connection');
require('../migrations');

// Gerichtete Beziehungstypen und ihre Inverse. A→B elternteil ≡ B→A kind,
// A→B mentor ≡ B→A schuetzling. Für Dedup-Zwecke als identisch betrachtet.
const RELATION_INVERSES = { elternteil: 'kind', kind: 'elternteil', mentor: 'schuetzling', schuetzling: 'mentor', vorgesetzter: 'untergebener', untergebener: 'vorgesetzter' };

/** Dedupliziert Relations pro ungeordnetem Paar (A,B). Erste gewinnt.
 *  Eliminiert damit auch widersprüchliche typs (z.B. elternteil + kind auf dem
 *  gleichen Paar) sowie inverse Dubletten (A elternteil B + B kind A). */
function dedupRelations(relations, validIds) {
  const seen = new Set();
  const result = [];
  for (const r of relations) {
    if (!r.from || !r.to || r.from === r.to) continue;
    if (validIds && (!validIds.has(r.from) || !validIds.has(r.to))) continue;
    const [a, b] = r.from < r.to ? [r.from, r.to] : [r.to, r.from];
    const key = `${a}|${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(r);
  }
  return result;
}

/** SSoT für die fig_id→id-Übersetzung im Write-Path. `figures.fig_id` (TEXT,
 *  KI-stabil) ist nur pro (book_id, user_email) eindeutig; die FK-Targets in
 *  figure_relations/figure_events/location_figures/zeitstrahl_event_figures sind
 *  INTEGER `figures.id`. Jede Stelle, die fig_id-basierten KI-Output in diese
 *  INTEGER-FKs schreibt, MUSS diesen Helper nutzen statt selbst
 *  `SELECT id, fig_id … + Object.fromEntries` zu wiederholen — sonst landet bei
 *  einer neuen Write-Stelle still eine TEXT-fig_id in einer INTEGER-Spalte.
 *  Liefert `rows` (inkl. name/kurzname für Namens-Lookups) + `byFigId`.
 *  Ausnahme: saveFigurenToDb baut die Map beim INSERT aus lastInsertRowid, weil
 *  die Figuren dort noch nicht in der DB stehen. */
function figIdMaps(bookId, userEmail) {
  const rows = db.prepare(
    'SELECT id, fig_id, name, kurzname FROM figures WHERE book_id = ? AND user_email IS ?'
  ).all(bookId, userEmail || null);
  const byFigId = Object.fromEntries(rows.map(r => [r.fig_id, r.id]));
  return { rows, byFigId };
}

// KI liefert Kapitel-/Seitennamen gelegentlich mit Markdown-Header-Präfix
// (##/###, wörtlich aus dem Prompt-Text kopiert) oder als Schema-Platzhalter-Echo
// («## Kapitel-Header», «### Seiten-Header»). Beides strippen/nullen, damit der
// Namens-Lookup auf chNameToId/pageNameToIdByChapter trifft und die UI keinen
// rohen Header anzeigt. Synchron mit dem ^#{1,6}-Strip in komplett/remap.js.
function _cleanRefName(v) {
  if (v == null) return null;
  const s = String(v).replace(/^#{1,6}\s+/, '').trim();
  if (!s || /Kapitel-Header|Seiten-Header/i.test(s)) return null;
  return s;
}

// Auflösung der ersten Erwähnung einer Figur auf eine konkrete page_id:
// 1. Versuche die Pages innerhalb der figure_appearances-Kapitel
//    (kapitel-scoped, gegen Namenskollisionen gleichnamiger Seiten).
// 2. Fallback: Unambiguous-Match über alle Kapitel (nur wenn der Seitenname
//    genau einmal vorkommt).
function resolveErstePageId(ersteErwaehnung, appearances, idMaps) {
  if (!ersteErwaehnung || !idMaps?.pageNameToIdByChapter) return null;
  for (const app of (appearances || [])) {
    const chapId = idMaps.chNameToId?.[_cleanRefName(app.name)];
    if (chapId != null) {
      const pid = idMaps.pageNameToIdByChapter[chapId]?.[ersteErwaehnung];
      if (pid) return pid;
    }
  }
  const candidates = [];
  for (const m of Object.values(idMaps.pageNameToIdByChapter)) {
    if (m[ersteErwaehnung]) candidates.push(m[ersteErwaehnung]);
  }
  return candidates.length === 1 ? candidates[0] : null;
}

// Reichert einen Beziehungs-Beleg ({kapitel, seite}) um chapter_id / page_id an,
// damit das Frontend Klick-Links ohne erneuten Namens-Match bauen kann.
// LLM-Halluzination (seite === kapitel) wird wie bei Szenen genullt.
function enrichBelegWithIds(beleg, idMaps) {
  const chMap = idMaps?.chNameToId || {};
  const a = _cleanRefName(beleg.kapitel);
  const b = _cleanRefName(beleg.seite);
  // Kapitel bestimmen: bevorzugt das kapitel-Feld; sonst das seite-Feld, falls
  // die KI dort einen echten Kapitelnamen abgelegt hat (häufige Feld-Verwechslung
  // im A2-Beziehungs-Call). So bleibt der Beleg klickbar statt als toter Name zu enden.
  let kapitel = (a && chMap[a] != null) ? a : null;
  let seite = b;
  if (!kapitel && b && chMap[b] != null) {
    kapitel = b;   // «seite» war in Wahrheit der Kapitelname
    seite = null;
  } else if (!kapitel) {
    kapitel = a;   // unauflösbar – bereinigter Rohname dient nur der Anzeige
  }
  const chId = (kapitel && chMap[kapitel]) ?? null;
  const effSeite = (seite && seite !== kapitel && seite !== 'Sonstige Seiten')
    ? seite : null;
  const pId = effSeite
    ? (idMaps?.pageNameToIdByChapter?.[chId ?? 0]?.[effSeite] ?? null)
    : null;
  return {
    kapitel: kapitel || null,
    seite: effSeite,
    chapter_id: chId,
    page_id: pId,
  };
}

// Flacht den strukturierten Arc ({typ, anfang, wendepunkte[], ende}) zu einem
// Anzeige-String – Fallback für Leser, die nur das alte `entwicklung`-Feld kennen
// (Figur-Werkstatt-bogen, Buch-Chat-Tool, Alt-Daten ohne arc-Spalte).
function _arcToFlat(arc) {
  if (!arc || typeof arc !== 'object') return null;
  const parts = [arc.anfang, ...(Array.isArray(arc.wendepunkte) ? arc.wendepunkte : []), arc.ende].filter(Boolean);
  if (!parts.length) return arc.typ || null;
  return parts.join(' → ');
}

module.exports = {
  RELATION_INVERSES,
  dedupRelations,
  figIdMaps,
  _cleanRefName,
  resolveErstePageId,
  enrichBelegWithIds,
  _arcToFlat,
};
