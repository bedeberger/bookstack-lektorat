// Verweis-ZIELE im Seiten-HTML — die Gegenseite zu xref-html.js (den Verweisen
// selbst). Liest die nummerierbaren Elemente einer Seite in Dokumentordnung.
//
// Zwei Typen: `<figure>` (Abbildung) und `<table>` (Tabelle). Der Zeiger darauf
// ist das `data-bid`, das lib/html-clean.js#ensureBlockIds am Schreib-Chokepoint
// ohnehin auf jeden Block setzt (beide stehen in `_BID_BLOCK_SEL`). Es gibt also
// KEIN eigenes Anker-Attribut und keinen zusaetzlichen Write-Path — ein
// Querverweis zeigt auf die Block-ID, die schon da ist.
//
// Die beiden zaehlen GETRENNT (xref-number.js): „Abb. 3.1" und „Tab. 3.1" stehen
// im Fachbuch nebeneinander. Darum liefert `collectAnchors` sie in EINER Liste
// mit `kind`, und die Nummerierung trennt sie.
//
// KAPITEL BRAUCHEN HIER NICHTS: `chapters.chapter_id` ist selbst der stabile
// Zeiger und die Reihenfolge steht im Tree (book_order). Nur Ziele, die IM
// HTML leben, muessen aus dem HTML gelesen werden.
//
// `data-bid` ist pro Seite eindeutig (`seen`-Set in ensureBlockIds), nicht
// garantiert buchweit. Bei 8 Zufallsbytes je Block ist eine Kollision innerhalb
// eines Buchs praktisch ausgeschlossen; traefe sie doch ein, gewinnt der erste
// Anker in Leserichtung (siehe db/xrefs.js#listBookAnchors). Deterministisch,
// nicht korrekt-um-jeden-Preis — die Alternative waere ein zweiter ID-Raum nur
// fuer Abbildungen, der denselben Zufall mit mehr Code faehrt.
//
// Modul ist DOM-agnostisch (Browser-DOM wie linkedom), Muster wie xref-html.js.

export const FIGURE_SEL = 'figure[data-bid]';
export const TABLE_SEL = 'table[data-bid]';

// Anker-Typen, die IM HTML leben (Kapitel brauchen keinen — siehe oben).
export const ANCHOR_KINDS = ['figure', 'table'];

/** Legenden-/Beschriftungstext eines Ankers als Klartext, auf eine Zeile
 *  normalisiert. Dient nur der Anzeige im Ziel-Picker und als Fallback-Text — die
 *  Wahrheit bleibt das HTML der Seite.
 *
 *  Traeger je Typ: `<figcaption>` in der Abbildung, `<caption>` in der Tabelle. */
function _caption(el, sel) {
  const cap = typeof el.querySelector === 'function' ? el.querySelector(sel) : null;
  if (!cap) return '';
  return String(cap.textContent || '').replace(/\s+/g, ' ').trim();
}

/** Alle Abbildungs-Anker unter `root` in Dokumentordnung.
 *  Liefert `[{ kind: 'figure', bid, caption, ord }]`; `ord` ist die Position
 *  innerhalb DIESER Seite. Die buchweite Nummer entsteht erst beim Rendern
 *  (public/js/xrefs/xref-number.js) — sie haengt an Kapitel und Leserichtung,
 *  also an Wissen, das eine einzelne Seite nicht hat. */
export function collectFigureAnchors(root) {
  return collectAnchors(root).filter(a => a.kind === 'figure');
}

/** Alle Anker unter `root` in Dokumentordnung, ueber ALLE Typen.
 *
 *  `ord` ist die Position innerhalb DIESER Seite und laeuft ueber die Typen
 *  hinweg durch — es ist eine Leseposition, keine Nummer. Die typweise Nummer
 *  entsteht erst beim Rendern (public/js/xrefs/xref-number.js): sie haengt an
 *  Kapitel und Leserichtung, also an Wissen, das eine einzelne Seite nicht hat.
 *
 *  EIN Durchlauf mit `querySelectorAll` ueber beide Selektoren, nicht zwei
 *  Durchlaeufe hintereinander: nur so stimmt `ord` mit der Leserichtung ueberein,
 *  wenn auf einer Seite Abbildung und Tabelle gemischt stehen. */
export function collectAnchors(root) {
  const out = [];
  if (!root || typeof root.querySelectorAll !== 'function') return out;
  let ord = 0;
  for (const el of Array.from(root.querySelectorAll(`${FIGURE_SEL}, ${TABLE_SEL}`))) {
    const bid = String(el.getAttribute('data-bid') || '').trim().toLowerCase();
    if (!/^[0-9a-f]{8,32}$/.test(bid)) continue;
    const isTable = el.tagName === 'TABLE';
    out.push({
      kind: isTable ? 'table' : 'figure',
      bid,
      caption: _caption(el, isTable ? 'caption' : 'figcaption'),
      ord: ord++,
    });
  }
  return out;
}
