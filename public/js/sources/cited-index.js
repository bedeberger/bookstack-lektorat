// Welche Quellen sind HIER belegt — pure Gruppierung des Fund-Index
// (`source_citations`, geliefert von `GET /sources/citations?book_id=`) auf die
// Sicht des Referenz-Slots: aktuelle Seite, aktuelles Kapitel oder ganzes Buch.
//
// Kein DOM, kein Alpine, kein Netz — der Slot memoized nur den Aufruf.
//
// Die Seiten-/Kapitelzuordnung kommt aus dem Buchtree (`Alpine.store('nav').pages`),
// nicht aus dem Index: dort stehen bewusst keine Snapshot-Namen, und der Tree
// liegt im Frontend ohnehin schon vor. Er liefert zugleich die Leserichtung —
// seine Reihenfolge ist die Buchreihenfolge (siehe book/tree/load.js).

/** Seiten-Lookup aus der Tree-Seitenliste: id → { name, chapterId, order }.
 *  `order` ist der Listenindex und damit die Leseposition der Seite. */
export function buildPageInfo(pages = []) {
  const map = new Map();
  (Array.isArray(pages) ? pages : []).forEach((p, i) => {
    if (p?.id == null) return;
    map.set(p.id, {
      name: p.name || '',
      chapterId: p.chapter_id ?? null,
      order: i,
    });
  });
  return map;
}

/**
 * Belegte Quellen einer Sicht, in Leserichtung.
 *
 * @param {object}  opts
 * @param {Array}   opts.sources    Quellen des Buchs (aus `GET /sources`).
 * @param {Array}   opts.citations  Fundstellen des Buchs (aus `GET /sources/citations`).
 * @param {Array}   opts.pages      Tree-Seitenliste (`Alpine.store('nav').pages`).
 * @param {'page'|'book'} opts.scope  'page' grenzt auf Seite + Kapitel ein.
 * @param {number|null} opts.pageId    aktuelle Seite (nur bei scope='page').
 * @param {number|null} opts.chapterId Kapitel der aktuellen Seite.
 * @returns {Array<{source:object, count:number, onPage:boolean,
 *                  pages:Array<{pageId:number, name:string, count:number, onPage:boolean}>}>}
 *
 * Reihenfolge: Quellen der aktuellen Seite zuerst (der Kontext, in dem der Autor
 * gerade schreibt), danach die uebrigen in Leserichtung ihrer ersten Fundstelle.
 * Quellen ohne Fundstelle im Ausschnitt fehlen — das Tab beantwortet „wo wird
 * belegt", nicht „was ist zugeordnet" (das ist das Quellenverzeichnis).
 */
export function groupCitedSources({
  sources = [], citations = [], pages = [],
  scope = 'book', pageId = null, chapterId = null,
} = {}) {
  const byId = new Map();
  for (const s of (Array.isArray(sources) ? sources : [])) {
    if (s?.id != null) byId.set(s.id, s);
  }
  if (!byId.size) return [];

  const pageInfo = buildPageInfo(pages);
  const contextual = scope === 'page' && pageId != null;
  const groups = new Map();

  for (const c of (Array.isArray(citations) ? citations : [])) {
    // Quelle nicht (mehr) in diesem Buch: der Unlink raeumt die Fundstellen mit
    // weg, ein Ueberbleibsel ist also ein Wettlauf gegen eine parallele Aenderung —
    // stillschweigend ueberspringen statt eine Zeile ohne Beschriftung zeigen.
    const src = byId.get(c?.source_id);
    if (!src) continue;

    const info = pageInfo.get(c.page_id);
    const onPage = contextual && c.page_id === pageId;
    if (contextual && !onPage) {
      // Kapitel-Treffer nur, wenn die Seite im selben Kapitel liegt. Seiten ohne
      // Kapitel (Tree-Wurzel) zaehlen nur bei einer ebenfalls kapitellosen
      // Bezugsseite — sonst waere „im Kapitel" die Aussage ueber gar kein Kapitel.
      if (!info || (info.chapterId ?? null) !== (chapterId ?? null)) continue;
    }

    const count = Math.max(0, parseInt(c.count, 10) || 0);
    let g = groups.get(src.id);
    if (!g) {
      g = { source: src, count: 0, onPage: false, pages: [], _order: Number.MAX_SAFE_INTEGER };
      groups.set(src.id, g);
    }
    g.count += count;
    g.onPage = g.onPage || onPage;
    g.pages.push({ pageId: c.page_id, name: info?.name || '', count, onPage });
    const order = info ? info.order : Number.MAX_SAFE_INTEGER;
    if (order < g._order) g._order = order;
  }

  return [...groups.values()]
    .sort((a, b) => (Number(b.onPage) - Number(a.onPage)) || (a._order - b._order))
    .map(({ _order, ...g }) => g);
}
