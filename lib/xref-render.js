'use strict';
// Querverweise fuer die Render-Pfade (Custom-PDF, Custom-DOCX, EPUB/HTML/MD,
// Blog-Push). Zwei Aufgaben, die jeder Exporter braucht:
//
//   buildXrefContext()   — die Nummern-Map der GERENDERTEN EINHEIT
//   applyXrefsInHtml()   — Verweistexte setzen + Abbildungslegenden nummerieren
//
// HARTE INVARIANTEN (dieselben wie in lib/bibliography.js — und aus denselben
// Gruenden)
//
//   A) Nichts davon wird in pages.content persistiert. Nummern sind ein
//      Render-Artefakt und entstehen bei jedem Export neu. Kein Aufrufer
//      schreibt etwas aus diesem Modul zurueck in den Content-Store.
//
//   B) Kein Marker verliert seine Attribute. `applyXrefsInHtml` ersetzt
//      ausschliesslich den Textknoten eines Verweises (`data-xref`/`data-xref-id`
//      /`class` bleiben unberuehrt) und gibt bei unveraendertem Ergebnis den
//      EINGABE-String zurueck, statt neu zu serialisieren.
//
//   C) Ein unaufloesbarer Verweis wird NIE ueberschrieben. Zeigt ein Marker auf
//      ein geloeschtes Kapitel oder aus dem gerenderten Ausschnitt heraus, bleibt
//      der Cache-Text des Autors stehen und der Verweis wird gemeldet
//      (`unresolved`). Der Exporter darf warnen; „???" in den Text schreiben
//      darf er nicht.
//
// WARUM DIE TEXTE UEBERHAUPT NEU GESETZT WERDEN: der Marker ist die Wahrheit,
// sein Text ein Cache vom Einfuege-Zeitpunkt (siehe public/js/xrefs/xref-html.js).
// „Kapitel 3" ist keine Eigenschaft des Ziels, sondern des Ausgabewegs — dasselbe
// Kapitel heisst im Profil mit roemischer Nummerierung „Kapitel III" und im
// Kapitel-Scope-Export zaehlt es ab 1. Genau wie bei den numerischen
// Quellen-Nummern.
//
// KEIN ZWEITER ZAEHLAUTOMAT: Der PDF-Renderer reicht seine bereits berechneten
// Kapitel-Labels als `chapterLabels` herein (lib/pdf-render/numbering.js ist SSoT
// dafuer). Nur Ausgabewege ohne eigene Kapitel-Nummerierung lassen die Map offen
// und bekommen die nested-arabische Vorgabe.
//
// Die reine Logik liegt als ESM in public/js/xrefs/ und wird per dynamic import()
// geladen (Muster lib/prompts-loader.js, wie lib/bibliography.js). Daraus folgt:
// die Funktionen sind `async`. Das DOM kommt von linkedom.

const { parseHTML } = require('linkedom');
const { xrefModules } = require('./esm-bridge');

// Markup + Anker + Nummerierung + Formatierung — der Renderer braucht alle vier.
function _xrefModules() {
  return xrefModules({ withRender: true });
}

// ── Struktur der gerenderten Einheit ─────────────────────────────────────────

/** Kapitel-Tiefe (1..3) aus der Elternkette. `groups` traegt die Kapitel als
 *  flache Liste in Leserichtung; die Hierarchie steckt in `parent_chapter_id`
 *  (siehe docs/chapter-hierarchy.md, max 3 Ebenen). */
function _chaptersFromGroups(groups) {
  const chapters = [];
  const byId = new Map();
  for (const g of Array.isArray(groups) ? groups : []) {
    const c = g?.chapter;
    if (!c || c.id == null) continue;
    if (byId.has(c.id)) continue;
    byId.set(c.id, c);
    chapters.push(c);
  }
  return chapters.map((c) => {
    let depth = 1;
    let cur = c;
    const seen = new Set();
    while (cur && cur.parent_chapter_id != null && !seen.has(cur.id) && depth < 3) {
      seen.add(cur.id);
      cur = byId.get(cur.parent_chapter_id);
      if (!cur) break;
      depth++;
    }
    return {
      chapterId: c.id,
      depth,
      title: c.chapter_name || c.name || '',
      unnumbered: !!c.unnumbered,
    };
  });
}

/** Abbildungs-Anker der gerenderten Einheit, in Render-Reihenfolge.
 *
 *  Bewusst aus dem HTML gelesen, das gerade gerendert wird — NICHT aus
 *  `xref_anchors`. Zwei Gruende: der Scope stimmt dann automatisch (ein
 *  Kapitel-PDF zaehlt nur seine eigenen Abbildungen), und das Ergebnis haengt
 *  nicht davon ab, ob der Index gerade frisch ist. Die Tabelle bedient die
 *  Oberflaeche (Ziel-Picker, Rueckwaertsfrage), nicht den Renderer. */
async function _anchorsFromGroups(groups) {
  const { collectAnchors } = await _xrefModules();
  const out = [];
  for (const g of Array.isArray(groups) ? groups : []) {
    for (const x of g.pages || []) {
      const html = x?.pd?.html;
      // Schnell-Ausschluss vor dem Parsen. Beide Anker-Typen muessen hier
      // stehen — mit nur `<figure>` bekaeme eine Seite, die ausschliesslich
      // Tabellen traegt, keine Nummern, und der Verweis darauf bliebe offen.
      if (typeof html !== 'string'
          || (html.indexOf('<figure') === -1 && html.indexOf('<table') === -1)) continue;
      const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body></html>`);
      const root = document.getElementById('r');
      if (!root) continue;
      for (const a of collectAnchors(root)) {
        out.push({ ...a, chapterId: g.chapterId ?? null, pageId: x?.p?.id ?? null });
      }
    }
  }
  return out;
}

/** Nummern-Kontext der gerenderten Einheit.
 *
 *  @param {object}      args
 *  @param {number}      args.bookId
 *  @param {Array}       args.groups        Output von lib/load-contents
 *  @param {Map|null}    [args.chapterLabels] chapterId → Label, aus dem
 *                       Render-Pfad (PDF). Fehlt sie, gilt nested-arabisch.
 *  @param {string|null} [args.userEmail]
 *  @returns {Promise<{lang:string, figureNumbering:boolean,
 *                     chapter:Map, figure:Map}>}
 *
 *  Direkt als `ctx` fuer applyXrefsInHtml verwendbar. */
async function buildXrefContext({ bookId, groups = [], chapterLabels = null, userEmail = null } = {}) {
  const { getBookSettings } = require('../db/schema');
  const { buildXrefNumbers } = await _xrefModules();

  const bid = parseInt(bookId, 10);
  const settings = (Number.isInteger(bid) && bid > 0 ? getBookSettings(bid, userEmail) : null) || {};
  const lang = settings.language === 'en' ? 'en' : 'de';
  const figureNumbering = !!settings.figure_numbering;
  const tableNumbering = !!settings.table_numbering;

  const chapters = _chaptersFromGroups(groups);
  const anchors = await _anchorsFromGroups(groups);
  const { chapter, figure, table } = buildXrefNumbers({ chapters, anchors, chapterLabels });

  // Abbildungs-Nummerierung ausgeschaltet → die Abbildungen tragen im Dokument
  // keine sichtbare Nummer. Dann darf auch kein Verweis eine nennen: er faellt
  // ueber `number: null` auf den Legendentext zurueck („vgl. „Der Kaefer"").
  // Sonst zeigte der Text auf eine Zahl, die nirgends steht.
  if (!figureNumbering) {
    for (const [k, v] of figure) figure.set(k, { ...v, number: null });
  }
  // Tabellen tragen ihren eigenen Schalter — ein Werk kann Tabellen nummerieren
  // und Abbildungen nicht (oder umgekehrt). Dieselbe Rueckfallebene: ohne Nummer
  // zeigt der Verweis auf die Beschriftung.
  if (!tableNumbering) {
    for (const [k, v] of table) table.set(k, { ...v, number: null });
  }

  return { lang, figureNumbering, tableNumbering, chapter, figure, table };
}

// ── Anwenden ─────────────────────────────────────────────────────────────────

function _entryFor(ctx, kind, target) {
  const map = kind === 'chapter' ? ctx?.chapter
    : kind === 'figure' ? ctx?.figure
      : kind === 'table' ? ctx?.table
        : null;
  if (!map) return null;
  return (map instanceof Map ? map.get(String(target)) : map[String(target)]) || null;
}

/** Verweistexte setzen und Legenden/Beschriftungen nummerieren — in EINEM DOM-Pass.
 *
 *  Beide Aufgaben brauchen dasselbe geparste Dokument; getrennt aufgerufen
 *  kostete es bei Manuskripten im Millionen-Zeichen-Bereich einen zweiten
 *  vollstaendigen HTML-Parse pro Seite.
 *
 *  @returns {Promise<{html:string, unresolved:Array<{kind:string,target:string,
 *                     text:string}>}>}
 *           `html` ist bei fehlender Aenderung der EINGABE-String (Invariante B).
 */
async function applyXrefsInHtml(html, ctx = {}) {
  const empty = { html, unresolved: [] };
  if (typeof html !== 'string' || !html) return empty;

  const {
    XREF_SEL, XREF_ATTR_KIND, XREF_ATTR_ID, XREF_ATTR_FMT, isXrefEl,
    FIGURE_SEL, TABLE_SEL, formatXref, captionPrefix,
  } = await _xrefModules();

  // Billiger Vorab-Test, bevor ein DOM gebaut wird. Die Literale kommen aus der
  // SSoT, nicht aus einer Kopie.
  const hasXrefs = html.indexOf(XREF_ATTR_ID) !== -1;
  const wantCaptions = !!ctx.figureNumbering && html.indexOf('<figure') !== -1;
  if (!hasXrefs && !wantCaptions) return empty;

  const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body></html>`);
  const root = document.getElementById('r');
  if (!root) return empty;

  let changed = 0;
  const unresolved = [];

  if (hasXrefs) {
    for (const el of Array.from(root.querySelectorAll(XREF_SEL))) {
      if (!isXrefEl(el)) continue;
      const kind = el.getAttribute(XREF_ATTR_KIND);
      const target = el.getAttribute(XREF_ATTR_ID);
      const entry = _entryFor(ctx, kind, target);
      const next = formatXref({
        kind,
        fmt: el.getAttribute(XREF_ATTR_FMT) || 'label',
        entry,
        lang: ctx.lang,
      });
      if (next === null) {
        // Invariante C: Text des Autors bleibt stehen, Fund wird gemeldet.
        unresolved.push({ kind, target: String(target), text: String(el.textContent || '') });
        continue;
      }
      if (next === el.textContent) continue;
      // Nur der Textknoten — kein Re-Build des Elements, keine Attribut-Kopie.
      el.textContent = next;
      changed++;
    }
  }

  if (wantCaptions) {
    // Abbildungslegende und Tabellenbeschriftung laufen durch dieselbe Schleife,
    // nur mit anderem Selektor, Anker-Typ und Text-Traeger. Zwei Kopien waeren
    // eine Drift-Quelle: die Regeln (Praefix voranstellen, Autor-Text nie
    // beschneiden, doppeltes Praefix vermeiden) sind identisch.
    const CAPTIONED = [
      { sel: FIGURE_SEL, kind: 'figure', capSel: 'figcaption' },
      { sel: TABLE_SEL, kind: 'table', capSel: 'caption' },
    ];
    for (const { sel, kind, capSel } of CAPTIONED) {
      for (const el of Array.from(root.querySelectorAll(sel))) {
        const bid = String(el.getAttribute('data-bid') || '').trim().toLowerCase();
        const entry = _entryFor(ctx, kind, bid);
        const prefix = captionPrefix(kind, entry?.number, ctx.lang);
        if (!prefix) continue;
        const cap = el.querySelector(capSel);
        if (!cap) continue;
        // Praefix wird vorangestellt, nicht eingerechnet: der Text gehoert dem
        // Autor. Hat er selbst schon „Abb. 3.2:" getippt, steht es doppelt — dann
        // gehoert die Nummerierung ausgeschaltet, nicht der Text beschnitten.
        const cur = String(cap.textContent || '');
        if (cur.startsWith(prefix)) continue;
        cap.textContent = `${prefix}${cur}`;
        changed++;
      }
    }
  }

  return { html: changed ? root.innerHTML : html, unresolved };
}

/** `applyXrefsInHtml` ueber eine ganze `groups`-Liste (Output von
 *  lib/load-contents). Liefert eine neue Liste; die Eingabe wird nicht mutiert,
 *  und Seiten ohne Aenderung behalten ihr Original-Objekt. */
async function applyXrefsInGroups(groups, ctx = {}) {
  if (!Array.isArray(groups) || !groups.length) return { groups, unresolved: [] };
  const out = [];
  const unresolved = [];
  for (const g of groups) {
    const pages = [];
    for (const x of g.pages || []) {
      const html = x?.pd?.html;
      const res = await applyXrefsInHtml(html, ctx);
      for (const u of res.unresolved) unresolved.push({ ...u, pageId: x?.p?.id ?? null });
      pages.push(res.html === html ? x : { ...x, pd: { ...x.pd, html: res.html } });
    }
    out.push({ ...g, pages });
  }
  return { groups: out, unresolved };
}

module.exports = { buildXrefContext, applyXrefsInHtml, applyXrefsInGroups };
