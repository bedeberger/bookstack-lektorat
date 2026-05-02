// Such-Provider für die Command-Palette. Jeder Provider liefert
// für eine Query eine Liste fuzzy-gematchter Items.
//
// Item-Schema: { key, providerKey, label, sub, score, indices, run(root), available }
//   key        – stabile ID (provider:resourceId)
//   label      – Anzeigetext (highlight() bekommt indices)
//   sub        – sekundäre Zeile (Kapitel, Typ etc.)
//   score      – kleinerer = besser
//   indices    – Match-Positionen im label (für Highlight)
//   run(root)  – Aktion bei Enter/Klick
//   available  – immer true für Provider-Items (sie würden gar nicht in der Liste
//                stehen, wenn die zugrundeliegende Ressource fehlte)
//
// Prefix-Routing (`#`, `@`, `!`, `>`) wird in palette-card.js geparsed; dieser
// Modul-Layer kennt nur den Provider-Set + Limits.

import { fuzzyMatch } from './palette-fuzzy.js';

const PER_PROVIDER_LIMIT = 8;

function rank(items) {
  return items
    .filter(Boolean)
    .sort((a, b) => a.score - b.score)
    .slice(0, PER_PROVIDER_LIMIT);
}

export const PROVIDERS = [
  {
    key: 'pages',
    prefix: '#',
    sectionKey: 'palette.section.pages',
    list(root) {
      return Array.isArray(root.pages) ? root.pages : [];
    },
    search(root, q, _t) {
      const pages = this.list(root);
      if (!pages.length) return [];
      const out = [];
      for (const p of pages) {
        const m = fuzzyMatch(q, p.name || '');
        if (!m) continue;
        out.push({
          key: 'page:' + p.id,
          providerKey: 'pages',
          label: p.name || '',
          sub: p.chapterName || '',
          score: m.score,
          indices: m.indices,
          available: true,
          run: (r) => r.gotoPageById(p.id),
        });
      }
      return rank(out);
    },
  },
  {
    key: 'chapters',
    prefix: '!',
    sectionKey: 'palette.section.chapters',
    list(root) {
      return Array.isArray(root.tree) ? root.tree.filter(t => t.type === 'chapter') : [];
    },
    search(root, q, t) {
      const chapters = this.list(root);
      if (!chapters.length) return [];
      const out = [];
      for (const c of chapters) {
        const m = fuzzyMatch(q, c.name || '');
        if (!m) continue;
        const pageCount = c.pages?.length || 0;
        out.push({
          key: 'chapter:' + c.id,
          providerKey: 'chapters',
          label: c.name || '',
          sub: t(pageCount === 1 ? 'palette.chapter.pageCountOne' : 'palette.chapter.pageCountOther', { n: pageCount }),
          score: m.score,
          indices: m.indices,
          available: true,
          run: (r) => {
            // Buch qualifiziert → Kapitel-Review; sonst erste Seite.
            if (typeof r.openKapitelReviewForChapter === 'function'
                && typeof r.kapitelReviewChapterOptions === 'function'
                && r.kapitelReviewChapterOptions().some(x => String(x.id) === String(c.id))) {
              r.openKapitelReviewForChapter(c.id);
            } else if (c.pages?.[0]) {
              r.selectPage(c.pages[0]);
            }
          },
        });
      }
      return rank(out);
    },
  },
  {
    key: 'figuren',
    prefix: '@',
    sectionKey: 'palette.section.figuren',
    list(root) {
      return Array.isArray(root.figuren) ? root.figuren : [];
    },
    // Defensive: Falls beim Buch-Wechsel der Reset durchläuft bevor loadFiguren fertig ist.
    prepare(root) {
      if (root.selectedBookId && !(root.figuren && root.figuren.length) && typeof root.loadFiguren === 'function') {
        root.loadFiguren(root.selectedBookId);
      }
    },
    search(root, q, _t) {
      const items = this.list(root);
      if (!items.length) return [];
      const out = [];
      for (const f of items) {
        const name = f.name || f.kurzname || '';
        const m = fuzzyMatch(q, name);
        if (!m) continue;
        out.push({
          key: 'figur:' + f.id,
          providerKey: 'figuren',
          label: name,
          sub: f.typ || f.rolle || '',
          score: m.score,
          indices: m.indices,
          available: true,
          run: (r) => r.openFigurById(f.id),
        });
      }
      return rank(out);
    },
  },
  {
    key: 'orte',
    prefix: '$',
    sectionKey: 'palette.section.orte',
    list(root) {
      return Array.isArray(root.orte) ? root.orte : [];
    },
    // Orte werden sonst nur beim Öffnen der Orte-Karte geladen.
    prepare(root) {
      if (root.selectedBookId && !(root.orte && root.orte.length) && typeof root.loadOrte === 'function') {
        root.loadOrte(root.selectedBookId);
      }
    },
    search(root, q, _t) {
      const items = this.list(root);
      if (!items.length) return [];
      const out = [];
      for (const o of items) {
        const m = fuzzyMatch(q, o.name || '');
        if (!m) continue;
        out.push({
          key: 'ort:' + o.id,
          providerKey: 'orte',
          label: o.name || '',
          sub: o.typ || '',
          score: m.score,
          indices: m.indices,
          available: true,
          run: (r) => r.openOrtById(o.id),
        });
      }
      return rank(out);
    },
  },
  {
    key: 'szenen',
    prefix: '%',
    sectionKey: 'palette.section.szenen',
    list(root) {
      return Array.isArray(root.szenen) ? root.szenen : [];
    },
    // Szenen werden sonst nur beim Öffnen der Szenen-Karte geladen.
    prepare(root) {
      if (root.selectedBookId && !(root.szenen && root.szenen.length) && typeof root.loadSzenen === 'function') {
        root.loadSzenen(root.selectedBookId);
      }
    },
    search(root, q, _t) {
      const items = this.list(root);
      if (!items.length) return [];
      const out = [];
      for (const s of items) {
        const m = fuzzyMatch(q, s.titel || '');
        if (!m) continue;
        out.push({
          key: 'szene:' + (s.id || s.titel),
          providerKey: 'szenen',
          label: s.titel || '',
          sub: s.kapitel ? (s.kapitel + (s.seite ? ' · ' + s.seite : '')) : '',
          score: m.score,
          indices: m.indices,
          available: true,
          run: (r) => r.openSzeneById(s.id),
        });
      }
      return rank(out);
    },
  },
];

const BY_PREFIX = new Map(PROVIDERS.filter(p => p.prefix).map(p => [p.prefix, p]));

// Erkennt führendes Prefix in der Query, gibt Provider + restliche Query zurück.
// Pure Befehls-Suche: `>` schaltet in den Befehls-Modus (kind:'action' only).
export function parseQuery(raw) {
  const trimmed = (raw || '').trimStart();
  if (!trimmed) return { mode: 'all', q: '' };
  const first = trimmed[0];
  if (first === '>') return { mode: 'commands', q: trimmed.slice(1).trimStart() };
  const provider = BY_PREFIX.get(first);
  if (provider) return { mode: 'provider', provider, q: trimmed.slice(1).trimStart() };
  return { mode: 'all', q: trimmed };
}

export function providerByKey(key) {
  return PROVIDERS.find(p => p.key === key) || null;
}
