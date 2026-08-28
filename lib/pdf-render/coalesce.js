'use strict';
// Gruppiert die loadBookContents-Output zu Render-Blöcken. Pro Kapitel ein
// Block; Modus 'flatten' verkettet alle Pages, 'nested' rendert pro Page einen
// eigenen Seitentitel (h4). Bei verschachtelten Kapiteln traegt jeder Block die
// `depth` (1..3), die im Renderer auf h1/h2/h3 + Page-Break-Verhalten gemappt
// wird; der Seitentitel sitzt als vierte Ebene darunter.

const headline = require('../headline-render');
const { sameStructureTitle } = require('../export-builders/shared');

// Berechnet die Tiefe eines Kapitels durch Aufstieg via parent_chapter_id.
// Capped bei MAX_DEPTH (3). Kapitel ohne bekannten Parent → depth=1.
const MAX_DEPTH = 3;

// Titel-Kopf eines Beitrags fuer den PDF-Renderer.
//
// Zwei Wege, je nachdem ob an dieser Stelle ueberhaupt eine Seitenueberschrift
// gezeichnet wird:
//  - 'nested': der Renderer setzt `it.heading` selbst → er bekommt zusaetzlich
//    `it.kicker`, und der Lead wird dem Seiten-HTML vorangestellt.
//  - 'flatten' und Seiten ohne Kapitel: hier zeichnet der Renderer gar keine
//    Seitenueberschrift (bewusst, siehe body.js) — dann muss der KOMPLETTE Kopf
//    inklusive Ueberschrift ins HTML, sonst verschwindet die Schlagzeile
//    spurlos. Der HTML-Walker macht daraus eine h3-Ueberschrift plus zwei
//    ausgezeichnete Absaetze.
function _headIntoHtml(p, html) {
  if (!headline.needsOwnHead(p)) return html;
  return headline.headHtml(p, { titleTag: 'h3' }) + '\n' + (html || '');
}
function _depthByChapterId(chapter, byId) {
  let d = 1;
  let cur = chapter;
  const seen = new Set();
  while (cur && cur.parent_chapter_id) {
    if (seen.has(cur.parent_chapter_id)) break;
    seen.add(cur.parent_chapter_id);
    const parent = byId.get(cur.parent_chapter_id);
    if (!parent) break;
    d += 1;
    if (d >= MAX_DEPTH) return MAX_DEPTH;
    cur = parent;
  }
  return d;
}

// True, wenn das Kapitel selbst oder irgendein Ancestor in `excludedSet` liegt.
function _ancestorInSet(chapter, byId, excludedSet) {
  let cur = chapter;
  const seen = new Set();
  while (cur) {
    if (excludedSet.has(cur.id)) return true;
    if (!cur.parent_chapter_id || seen.has(cur.parent_chapter_id)) return false;
    seen.add(cur.parent_chapter_id);
    cur = byId.get(cur.parent_chapter_id);
  }
  return false;
}

function _coalesceGroups(groups, pageStructure, pageBreakBetweenPages, unnumberedChapterIds, skipPageCounterChapterIds) {
  // Map fuer Depth-Lookup ueber Parent-Kette. Kapitel kommen aus loadContents
  // mit `parent_chapter_id`-Feld (siehe content-store/backends/localdb.js).
  const chaptersById = new Map();
  for (const g of groups) {
    if (g.chapter) chaptersById.set(g.chapter.id, g.chapter);
  }
  const excluded = new Set(Array.isArray(unnumberedChapterIds) ? unnumberedChapterIds : []);
  const skipCounterSet = new Set(Array.isArray(skipPageCounterChapterIds) ? skipPageCounterChapterIds : []);
  const out = [];
  for (const g of groups) {
    const depth = g.chapter ? _depthByChapterId(g.chapter, chaptersById) : 1;
    const unnumbered = g.chapter ? _ancestorInSet(g.chapter, chaptersById, excluded) : false;
    const skipPageCounter = g.chapter ? _ancestorInSet(g.chapter, chaptersById, skipCounterSet) : false;
    // Kein `pages.length > 1`-Vorbehalt: die Seite ist ein Strukturelement, und
    // ob ein Kapitel eine oder zwanzig davon hat, aendert daran nichts. Sonst
    // fiele genau das einseitige Sub-Kapitel aus der Gliederung, das seine
    // Seite am dringendsten braucht.
    if (g.chapter && pageStructure === 'nested') {
      const items = [];
      for (let i = 0; i < g.pages.length; i++) {
        const p = g.pages[i].p;
        const lead = headline.leadHtml(p);
        const pageTitle = headline.pageTitle(p);
        // Traegt die erste Seite denselben Namen wie ihr Kapitel, stuende die
        // Ueberschrift zweimal direkt untereinander (haeufig bei einseitigen
        // Kapiteln, wo Kapitel- und Seitenname aus derselben Anlage stammen).
        // Nur das erste Item ist betroffen — nur dort steht der Kapiteltitel
        // unmittelbar darueber. Journalistische Beitraege behalten ihren Kopf
        // in jedem Fall (Schlagzeile ist nicht der Ordnungsname).
        const dupOfChapter = i === 0
          && !headline.needsOwnHead(p)
          && sameStructureTitle(pageTitle, g.chapter.name);
        items.push({
          // Ueberschrift ist der Beitragstitel; `pageName` bleibt der
          // Kolumnentitel-Anker fuer `{pageTitle}` und folgt ihm.
          heading: dupOfChapter ? null : pageTitle,
          kicker: headline.kickerText(p),
          pageName: pageTitle,
          pageId: p.id,
          html: lead ? lead + '\n' + (g.pages[i].pd.html || '') : g.pages[i].pd.html,
          breakBefore: i > 0 && pageBreakBetweenPages,
        });
      }
      out.push({
        title: g.chapter.name, level: 0, isChapter: true,
        chapterId: g.chapter.id,
        depth, unnumbered, skipPageCounter,
        items,
      });
    } else if (g.chapter) {
      const html = g.pages.map(x => _headIntoHtml(x.p, x.pd.html)).join('\n');
      // Flatten-Mode: nur die erste Page laesst sich noch sauber verorten (alle
      // anderen flow'en ohne Page-Anker). Pro-Page-Counter-Skip ist hier
      // eingeschraenkt; Kapitel-Skip greift weiterhin auf den Block.
      out.push({
        title: g.chapter.name, level: 0, isChapter: true,
        chapterId: g.chapter.id,
        depth, unnumbered, skipPageCounter,
        items: [{
          html,
          pageName: (g.pages[0]?.p && headline.pageTitle(g.pages[0].p)) || g.chapter.name,
          pageId: g.pages[0]?.p?.id ?? null,
        }],
      });
    } else {
      const x = g.pages[0];
      const title = headline.pageTitle(x.p);
      out.push({
        title, level: 0, isChapter: false,
        chapterId: null,
        depth: 1, unnumbered: false, skipPageCounter: false,
        items: [{ html: _headIntoHtml(x.p, x.pd.html), pageName: title, pageId: x.p.id }],
      });
    }
  }
  return out;
}

module.exports = { _coalesceGroups };
