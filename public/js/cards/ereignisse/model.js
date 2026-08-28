// Event-Modell: Kanonform und Ordnung der Zeitstrahl-Events. Reine Funktionen
// ohne Alpine — direkt testbar (tests/unit/event-sort.test.mjs).
//
// Zwei Produzenten speisen `Alpine.store('catalog').globalZeitstrahl`: der
// konsolidierte Server-Endpunkt (/figures/zeitstrahl/:book_id) und der
// Figuren-Fallback (../../book/ereignisse.js#_buildGlobalZeitstrahl). Beide
// laufen durch `normalizeEvent`, damit JEDE Leseseite eine feste Form vorfindet
// — sonst normalisiert jede Stelle einzeln nach (`Array.isArray(ev.kapitel) ?
// … : …`), und genau diese Nachnormalisierung driftet: sie stand an dreizehn
// Stellen und las teils Felder, die der Produzent gar nicht mehr setzt.

/** Ein Wert → Liste. `null`/`''`/`undefined` → []; Skalar → [Skalar]. */
function _list(v) {
  if (Array.isArray(v)) return v.filter(x => x != null && x !== '');
  return (v == null || v === '') ? [] : [v];
}

/**
 * Kanonform eines Events. Mehrwertige Anker (Kapitel/Seiten/Figuren) sind IMMER
 * Arrays, Typ und Subtyp immer gesetzt. Die Skalar-Felder `kapitel`/`seite` des
 * Fallback-Pfads werden dabei in ihre Listen ueberfuehrt und nicht doppelt
 * gefuehrt — zwei Traeger derselben Aussage waeren die naechste Drift.
 */
export function normalizeEvent(ev) {
  const kapitel = _list(ev.kapitel);
  const seiten = _list(ev.seiten !== undefined ? ev.seiten : ev.seite);
  const out = {
    ...ev,
    typ: ev.typ || 'persoenlich',
    subtyp: ev.subtyp || 'sonstiges',
    kapitel,
    chapter_ids: _list(ev.chapter_ids),
    seiten,
    page_ids: _list(ev.page_ids),
    figuren: Array.isArray(ev.figuren) ? ev.figuren : [],
  };
  delete out.seite;
  return out;
}

/** Kanonform fuer eine ganze Liste. */
export function normalizeEvents(list) {
  return (list || []).map(normalizeEvent);
}

// Sortier-Schluessel mit strukturierten Datums-Feldern. Events ohne Jahr landen
// am Ende ("unbekannt"-Bucket). story_tag faengt relative Story-Zeit ohne
// Kalender. Spiegelt die ORDER-BY-Klausel von GET /figures/zeitstrahl/:book_id
// (routes/figures/zeitstrahl.js) — inklusive `id` als letztem Tiebreaker, sonst
// ordnet ein Client-Resort gleich datierte Events anders als der Server.
function _sortKey(ev) {
  return [
    ev.datum_year  ?? 9999,
    ev.datum_month ?? 99,
    ev.datum_day   ?? 99,
    ev.story_tag   ?? 99999,
    ev.sort_order  ?? 0,
    ev.id          ?? 0,
  ];
}

export function compareEvents(a, b) {
  const ka = _sortKey(a), kb = _sortKey(b);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
  return 0;
}

/** Sortierte Kopie (nie in-place — die Quelle ist ein Alpine-Store-Array). */
export function sortEvents(list) {
  return [...(list || [])].sort(compareEvents);
}
