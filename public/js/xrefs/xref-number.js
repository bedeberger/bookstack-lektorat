// Nummern fuer Querverweise — pur, ohne DOM und ohne DB, geteilt zwischen
// Browser (Editor-Vorschau, Leseansicht) und Server (alle Exporter).
//
// DIE ZENTRALE REGEL: Nummern folgen der GERENDERTEN EINHEIT, nicht dem Ziel.
// Dieses Modul bekommt darum die Struktur der gerade gerenderten Einheit
// herein und gibt eine Map heraus; es fragt selbst nichts ab.
//
// KEIN ZWEITER ZAEHLAUTOMAT FUER KAPITEL: Der PDF-Renderer berechnet die
// Kapitel-Labels bereits fuer Ueberschriften und Inhaltsverzeichnis
// (lib/pdf-render/numbering.js#computeChapterLabels, SSoT genau dafuer). Der
// Render-Pfad reicht dieses Ergebnis als `chapterLabels` herein, statt hier neu
// zu zaehlen — sonst koennte der Verweis „Kapitel III" sagen, waehrend die
// Ueberschrift „Kapitel IV" traegt. `defaultChapterLabels` ist nur fuer
// Ausgabewege ohne eigene Kapitel-Nummerierung (Web-Leseansicht, EPUB, HTML,
// Markdown) gedacht.

/** Nested-arabische Kapitel-Labels („1", „1.1", „1.1.1") in Leserichtung.
 *
 *  `chapters`: [{ chapterId, depth (1..3), unnumbered? }] in Buch-Leserichtung.
 *  Zaehler pro Tiefe; bei Eintritt in Tiefe d wird counters[d-1]++ und alle
 *  tieferen auf 0 — dieselbe Mechanik wie computeChapterLabels, hier aber ohne
 *  Profil-Formatierung (kein roemisch, kein „Kapitel"-Wort).
 *
 *  @returns {Map<string,string>} chapterId (als String) → Label
 */
export function defaultChapterLabels(chapters) {
  const counters = [0, 0, 0];
  const out = new Map();
  for (const ch of chapters || []) {
    if (!ch || ch.chapterId == null) continue;
    const depth = Math.max(1, Math.min(3, ch.depth || 1));
    if (ch.unnumbered) continue;
    counters[depth - 1] += 1;
    for (let d = depth; d < 3; d++) counters[d] = 0;
    out.set(String(ch.chapterId), counters.slice(0, depth).join('.'));
  }
  return out;
}

/** Abbildungs-Nummern in Buch-Leserichtung.
 *
 *  `anchors`: [{ bid, chapterId }] in Leserichtung (Seitenposition, dann
 *  Position innerhalb der Seite) — die Form von db/xrefs.js#listBookAnchors.
 *  `chapterLabels`: Map chapterId → Label (aus dem Render-Pfad oder
 *  defaultChapterLabels).
 *
 *  KAPITELWEISE ZAEHLUNG ist die Vorgabe („Abb. 3.2"): der Zaehler startet je
 *  Kapitel neu, das Praefix ist die Kapitelnummer. Robust gegen Umstellungen —
 *  wird ein Kapitel verschoben, aendert sich nur sein Praefix, nicht die
 *  Nummerierung aller nachfolgenden Abbildungen im Buch.
 *
 *  FALLBACK AUF BUCHWEIT: Traegt auch nur eine Abbildung ein Kapitel ohne Label
 *  (Profil mit `numbering: 'none'`, unnummeriertes Kapitel, Abbildung auf einer
 *  kapitellosen Seite), waere das Ergebnis ein Mischmasch aus „3.2" und „7".
 *  Dann zaehlt das ganze Buch durchgehend. Die Entscheidung faellt EINMAL pro
 *  gerenderter Einheit, nicht pro Abbildung — sonst ist die Nummernfolge im
 *  fertigen Dokument nicht mehr nachvollziehbar.
 *
 *  @returns {Map<string,string>} bid → Nummer („3.2" bzw. „7")
 */
export function figureNumbers(anchors, chapterLabels) {
  const list = (anchors || []).filter(a => a && a.bid);
  const labels = chapterLabels instanceof Map ? chapterLabels : new Map();

  const perChapter = list.every(a => a.chapterId != null && labels.has(String(a.chapterId)));

  const out = new Map();
  if (!perChapter) {
    let n = 0;
    for (const a of list) out.set(a.bid, String(++n));
    return out;
  }

  const counters = new Map();
  for (const a of list) {
    const key = String(a.chapterId);
    const n = (counters.get(key) || 0) + 1;
    counters.set(key, n);
    out.set(a.bid, `${labels.get(key)}.${n}`);
  }
  return out;
}

/** Vollstaendige Nummern-Map fuer eine gerenderte Einheit.
 *
 *  Buendelt beide Achsen zu der Form, die lib/xref-render.js#resolveXrefsInHtml
 *  und die Legenden-Nummerierung erwarten:
 *
 *    { chapter: Map<chapterId, { number, title }>,
 *      figure:  Map<bid,       { number, title }> }
 *
 *  `title` ist der Kapiteltitel bzw. der Legendentext — gebraucht fuer die
 *  Anzeigeform `title` UND als Rueckfallebene, wenn es keine Nummer gibt.
 */
export function buildXrefNumbers({ chapters = [], anchors = [], chapterLabels = null } = {}) {
  const labels = chapterLabels instanceof Map ? chapterLabels : defaultChapterLabels(chapters);
  const figNums = figureNumbers(anchors, labels);

  const chapter = new Map();
  for (const ch of chapters) {
    if (!ch || ch.chapterId == null) continue;
    const key = String(ch.chapterId);
    chapter.set(key, { number: labels.get(key) || null, title: ch.title || '' });
  }

  const figure = new Map();
  for (const a of anchors) {
    if (!a || !a.bid) continue;
    figure.set(a.bid, { number: figNums.get(a.bid) || null, title: a.caption || '' });
  }

  return { chapter, figure };
}
