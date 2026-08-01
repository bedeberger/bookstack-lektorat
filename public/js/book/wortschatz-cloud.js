// Wortwolke der Wortschatz-Karte — vierter Reiter neben den drei Ranglisten.
//
// Die Tabellen beantworten „welches Wort steht auf Platz 7"; die Wolke
// beantwortet „wie sieht mein Wortschatz aus" auf einen Blick. Sie liest
// dieselbe Quelle (`lexicon_terms` über GET /lexicon/:book_id) und fügt keine
// eigene Auswahl hinzu — was in der Tabelle steht, steht auch in der Wolke.
//
// Zwei Modi, weil die Wortliste zwei Auswahlachsen hat (siehe docs/wortschatz.md):
//   'freq' — Lieblingswörter, Grösse ∝ Häufigkeit
//   'key'  — auffällige Wörter, Grösse ∝ Keyness gegen die übrigen Bücher
// Der zweite Modus existiert nur, wenn es überhaupt ein Referenzkorpus gab.
//
// Layout: d3-cloud (lazy via lazy-libs.js). Der Lauf ist asynchron — die Lib
// misst jedes Wort auf einem Offscreen-Canvas und arbeitet über mehrere Ticks.

import { loadWordCloud } from '../lazy-libs.js';

// Zeichenfläche des Layouts. Die Wolke wird per viewBox auf die Kartenbreite
// skaliert, das Seitenverhältnis bleibt also fix — d3-cloud braucht eine feste
// Fläche, und ein Neulauf bei jedem Resize würde die Wolke bei jedem
// Fensterziehen neu würfeln.
const CLOUD_W = 900;
const CLOUD_H = 460;
// Höchstzahl Wörter. Darüber wird die Wolke zur grauen Fläche, und jedes
// zusätzliche Wort kostet Kollisionsprüfungen gegen alle bereits platzierten.
const CLOUD_MAX_WORDS = 90;
const FONT_MIN = 13;
const FONT_MAX = 76;
// Muss zur CSS-Familie in wortschatz.css passen — d3-cloud misst mit genau
// diesem Font auf dem Canvas, und eine Abweichung erzeugt Überlappungen.
const CLOUD_FONT = 'Inter, system-ui, sans-serif';

/** Wählt die Wörter für einen Modus aus den `terms`-Zeilen.
 *  Pure Funktion, damit die Auswahl ohne Alpine und ohne Canvas testbar ist.
 *
 *  'key' nimmt den BETRAG der Keyness: negativ heisst „auffällig gemieden" und
 *  ist genauso ein Befund wie „auffällig häufig". Das Vorzeichen geht nicht in
 *  die Grösse ein, sondern in die Farbe (siehe `sign`). */
export function selectCloudWords(terms, mode, limit = CLOUD_MAX_WORDS) {
  const rows = [];
  for (const t of terms || []) {
    if (mode === 'key') {
      if (t.keyness == null) continue;
      const v = Math.abs(Number(t.keyness));
      if (!(v > 0)) continue;
      rows.push({ term: t.term, weight: v, sign: Number(t.keyness) < 0 ? -1 : 1, row: t });
    } else {
      const v = Number(t.count);
      if (!(v > 0)) continue;
      rows.push({ term: t.term, weight: v, sign: 1, row: t });
    }
  }
  rows.sort((a, b) => (b.weight - a.weight) || a.term.localeCompare(b.term));
  return rows.slice(0, limit);
}

/** Schriftgrössen-Skala. Wurzel statt linear: die Häufigkeitsverteilung eines
 *  Buchs ist zipfverteilt, linear skaliert erdrückt das häufigste Wort alle
 *  anderen. Sind alle Gewichte gleich (Keyness-Modus mit einem Wert), bekommt
 *  jedes Wort die Mitte statt der Maximalgrösse. */
export function cloudFontScale(rows, min = FONT_MIN, max = FONT_MAX) {
  if (!rows.length) return () => min;
  let lo = Infinity, hi = -Infinity;
  for (const r of rows) { if (r.weight < lo) lo = r.weight; if (r.weight > hi) hi = r.weight; }
  if (!(hi > lo)) return () => Math.round((min + max) / 2);
  const sLo = Math.sqrt(lo);
  const sHi = Math.sqrt(hi);
  return (weight) => {
    const t = (Math.sqrt(weight) - sLo) / (sHi - sLo);
    return Math.round(min + t * (max - min));
  };
}

/** Deterministische Rotation. d3-cloud würfelt per Default (`Math.random`) —
 *  dieselbe Analyse ergäbe dann bei jedem Öffnen der Karte ein anderes Bild,
 *  und man könnte zwei Scans nicht vergleichen. Jedes fünfte Wort steht
 *  senkrecht; das lockert die Fläche auf, ohne die Lesbarkeit zu opfern. */
export function cloudRotation(_word, index) {
  return index % 5 === 4 ? -90 : 0;
}

export const wortschatzCloudMethods = {
  // Modus umschalten. Layout neu rechnen, nicht nur umfärben — die Gewichte
  // ändern sich und damit jede Position.
  wsSetCloudMode(mode) {
    if (this.wsCloudMode === mode) return;
    this.wsCloudMode = mode;
    this.wsBuildCloud();
  },

  /** Baut die Wolke. Idempotent — mehrfache Aufrufe (Reiterwechsel, Reload)
   *  brechen einen noch laufenden Layout-Lauf ab, statt zwei Läufe um dieselbe
   *  Zustandsvariable konkurrieren zu lassen. */
  async wsBuildCloud() {
    const terms = this.wortschatzTerms;
    // Ein Modus ohne Datengrundlage (Keyness bei nur einem Buch im Bestand) darf
    // nicht in eine leere Wolke laufen — zurück auf die Häufigkeit.
    // `wortschatzHasKeyness` ist ein Getter im Karten-Literal, nicht hier: ein
    // Getter in einem gespreadeten Modul feuert beim Spread mit falschem `this`.
    if (this.wsCloudMode === 'key' && !this.wortschatzHasKeyness) this.wsCloudMode = 'freq';

    const rows = selectCloudWords(terms, this.wsCloudMode);
    this.wsCloudLayout = [];
    if (!rows.length) { this.wsCloudBuilding = false; this.wsCloudError = false; return; }

    this.wsCloudBuilding = true;
    this.wsCloudError = false;
    this._wsCloudStop();

    // Jeder Lauf bekommt eine Nummer. Trifft das `end`-Event eines überholten
    // Laufs ein (Modus zweimal schnell umgeschaltet), wird es verworfen.
    const run = (this._wsCloudRun = (this._wsCloudRun || 0) + 1);

    let cloud;
    try {
      cloud = await loadWordCloud();
    } catch {
      this.wsCloudBuilding = false;
      this.wsCloudError = true;
      return;
    }
    if (run !== this._wsCloudRun) return;

    const scale = cloudFontScale(rows);
    const layout = cloud()
      .size([CLOUD_W, CLOUD_H])
      .words(rows.map((r, i) => ({
        text: r.term,
        size: scale(r.weight),
        weight: r.weight,
        sign: r.sign,
        idx: i,
        pageId: r.row.first_page_id ?? null,
        pageName: r.row.first_page_name || '',
        count: r.row.count,
        keyness: r.row.keyness,
      })))
      .padding(3)
      .font(CLOUD_FONT)
      .fontSize(d => d.size)
      .rotate((d, i) => cloudRotation(d, i))
      // Fixer Zufallsgenerator: gleiche Analyse ⇒ gleiches Bild.
      .random(() => 0.5)
      .on('end', (placed) => {
        if (run !== this._wsCloudRun) return;
        this.wsCloudLayout = placed;
        this.wsCloudBuilding = false;
        // d3-cloud lässt Wörter weg, für die kein Platz mehr war. Die Zahl wird
        // ausgewiesen — eine stillschweigend gekürzte Wolke liest sich als
        // vollständig (dieselbe Regel wie beim Einmalwort-Deckel).
        this.wsCloudDropped = rows.length - placed.length;
        // Das SVG wird erst durch `x-show` sichtbar, wenn wsCloudLayout gefüllt
        // ist — malen also im nächsten Tick, sonst greift $refs ins Leere.
        this.$nextTick(() => this.wsPaintCloud(placed));
      });

    this._wsCloudLayout = layout;
    layout.start();
  },

  _wsCloudStop() {
    if (this._wsCloudLayout) {
      try { this._wsCloudLayout.stop(); } catch { /* Lauf war schon fertig */ }
      this._wsCloudLayout = null;
    }
  },

  /** Die platzierten Wörter als `<text>`-Knoten ins SVG malen.
   *
   *  Imperativ statt `<template x-for>`: innerhalb von `<svg>` parst der Browser
   *  `<template>` als Fremdelement, Alpine sieht kein echtes
   *  HTMLTemplateElement und initialisiert die Kinder ausserhalb des
   *  Loop-Scopes. `createElementNS` ist hier ausserdem zwingend — `<text>` per
   *  innerHTML in einen SVG-Kontext zu schreiben, erzeugt HTML-Elemente mit
   *  SVG-Namen, die der Renderer ignoriert. */
  wsPaintCloud(placed) {
    const svg = this.$refs?.wsCloudSvg;
    if (!svg) return;
    const NS = 'http://www.w3.org/2000/svg';
    // Ursprung in die Mitte: d3-cloud liefert Koordinaten relativ zum Zentrum.
    svg.setAttribute('viewBox', `${-CLOUD_W / 2} ${-CLOUD_H / 2} ${CLOUD_W} ${CLOUD_H}`);
    const frag = document.createDocumentFragment();
    for (const w of placed) {
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('class', 'wortschatz-cloud-word'
        + (w.sign < 0 ? ' wortschatz-cloud-word--neg' : ''));
      t.setAttribute('transform', `translate(${Math.round(w.x)},${Math.round(w.y)}) rotate(${w.rotate})`);
      t.setAttribute('font-size', String(w.size));
      t.setAttribute('text-anchor', 'middle');
      // Gewicht als CSS-Custom-Property, nicht als feste Farbe: die Wolke muss
      // in Light und Dark tragen, der Ton kommt aus dem Karten-Akzent.
      const q = Math.min(1, Math.max(0, (w.size - FONT_MIN) / (FONT_MAX - FONT_MIN)));
      t.style.setProperty('--cloud-weight', Math.round(35 + q * 55) + '%');
      t.setAttribute('data-tip', this.wsCloudTip(w));
      if (w.pageId != null) t.setAttribute('data-page', String(w.pageId));
      // textContent, nie innerHTML: der Term kommt aus dem Manuskript.
      t.textContent = w.text;
      frag.appendChild(t);
    }
    svg.replaceChildren(frag);
  },

  // Klick-Delegation am SVG (die Knoten entstehen ausserhalb von Alpine).
  wsCloudClick(e) {
    const el = e.target?.closest?.('text[data-page]');
    if (!el) return;
    this.wsGotoPage(Number(el.getAttribute('data-page')));
  },

  wsCloudTip(w) {
    if (this.wsCloudMode === 'key') {
      return window.__app?.t?.('wortschatz.cloud.tipKey', {
        word: w.text, value: this.wsNum(w.keyness, 1), count: this.wsNum(w.count),
      }) || w.text;
    }
    return window.__app?.t?.('wortschatz.cloud.tipFreq', {
      word: w.text, count: this.wsNum(w.count), page: w.pageName || '–',
    }) || w.text;
  },
};
