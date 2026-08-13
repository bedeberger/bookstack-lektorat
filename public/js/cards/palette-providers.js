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
import { EVT } from '../events.js';

const PER_PROVIDER_LIMIT = 8;

// Volltextsuche-Treffer-Aktivierung. Identische Dispatch-Logik wie
// searchCard#activateHit, dupliziert hier weil die Palette keine Sub-Karten-
// Methoden aufruft — sie kennt nur den Root.
function _runFulltextHit(root, hit) {
  if (!root || !hit) return;
  switch (hit.kind) {
    case 'page':     return root.gotoPageById?.(hit.entity_id);
    case 'chapter': {
      const tree = Alpine.store('nav').tree || [];
      const ch = tree.find(t => t.type === 'chapter' && String(t.id) === String(hit.entity_id));
      if (ch && typeof root.openKapitelReviewForChapter === 'function') {
        return root.openKapitelReviewForChapter(hit.entity_id);
      }
      if (ch?.pages?.[0]) return root.selectPage(ch.pages[0]);
      return;
    }
    case 'book': {
      // FTS5 liefert book_id als String, selectedBookId ist numerisch.
      const bid = Number(hit.book_id);
      if (Number.isFinite(bid) && Alpine.store('nav').selectedBookId !== bid) Alpine.store('nav').selectedBookId = bid;
      return root.toggleBookOverviewCard?.();
    }
    // `nav_id`, nicht `entity_id`: Figuren/Schauplaetze werden ueber ihre
    // TEXT-ID adressiert (fig_id/loc_id), der Index fuehrt den INTEGER-PK.
    // Mit dem PK oeffnet die Karte zwar, die Zeile klappt aber nie auf.
    case 'figure':   return root.openFigurById?.(hit.nav_id ?? hit.entity_id);
    case 'location': return root.openOrtById?.(hit.nav_id ?? hit.entity_id);
    case 'scene':    return root.openSzeneById?.(hit.nav_id ?? hit.entity_id);
    case 'idea':
      // Idea → eigene Suche im Karten-Trigger; Palette macht's einfach: SearchCard oeffnen.
      root.toggleSearchCard?.();
      return;
  }
}

// In-Flight-Guard für lazy provider-prepare Calls. Ohne Guard feuert jeder
// Keystroke `loadFiguren/Orte/Szenen` neu, bis der Fetch antwortet (Liste leer
// = guard-bedingung unverändert). Set hält pro Buch+Provider eine pending
// Promise; nach Resolve/Reject Eintrag löschen.
const _inFlight = new Set();
function _onceForBook(bookId, providerKey, runner) {
  const tag = providerKey + ':' + bookId;
  if (_inFlight.has(tag)) return;
  _inFlight.add(tag);
  let p;
  try { p = runner(); } catch { _inFlight.delete(tag); return; }
  Promise.resolve(p).finally(() => _inFlight.delete(tag));
}

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
      return Array.isArray(Alpine.store('nav').pages) ? Alpine.store('nav').pages : [];
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
      return Array.isArray(Alpine.store('nav').tree) ? Alpine.store('nav').tree.filter(t => t.type === 'chapter' && !t.solo) : [];
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
      return Array.isArray(root.$store.catalog.figuren) ? root.$store.catalog.figuren : [];
    },
    drafts(root) {
      const list = root.$store.nav.werkstattDrafts;
      return Array.isArray(list) ? list : [];
    },
    // Defensive: Falls beim Buch-Wechsel der Reset durchläuft bevor loadFiguren
    // fertig ist. Werkstatt-Drafts werden ebenfalls einmal pro Buch nachgeladen,
    // damit die Palette sie auch findet, wenn die Werkstatt-Karte nie geöffnet
    // wurde.
    prepare(root) {
      if (Alpine.store('nav').selectedBookId && !(root.$store.catalog.figuren && root.$store.catalog.figuren.length) && typeof root.loadFiguren === 'function') {
        _onceForBook(Alpine.store('nav').selectedBookId, 'figuren', () => root.loadFiguren(Alpine.store('nav').selectedBookId));
      }
      if (Alpine.store('nav').selectedBookId && !this.drafts(root).length) {
        _onceForBook(Alpine.store('nav').selectedBookId, 'werkstatt-drafts', async () => {
          try {
            const r = await fetch(`/draft-figures/${Alpine.store('nav').selectedBookId}`, { credentials: 'same-origin' });
            if (!r.ok) return;
            const data = await r.json();
            root.$store.nav.werkstattDrafts = Array.isArray(data) ? data : [];
          } catch { /* still searchable nach Karten-Open */ }
        });
      }
    },
    search(root, q, t) {
      const items = this.list(root);
      const drafts = this.drafts(root);
      if (!items.length && !drafts.length) return [];
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
      const werkstattLabel = t('palette.figur.werkstatt') || 'Werkstatt';
      for (const d of drafts) {
        const name = d.name || '';
        const m = fuzzyMatch(q, name);
        if (!m) continue;
        const archetype = d.archetype || '';
        out.push({
          key: 'werkstatt:' + d.id,
          providerKey: 'figuren',
          label: name,
          sub: archetype ? (archetype + ' · ' + werkstattLabel) : werkstattLabel,
          score: m.score,
          indices: m.indices,
          available: true,
          run: (r) => r.openWerkstattDraftById(d.id),
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
      return Array.isArray(root.$store.catalog.orte) ? root.$store.catalog.orte : [];
    },
    // Orte werden sonst nur beim Öffnen der Orte-Karte geladen.
    prepare(root) {
      if (Alpine.store('nav').selectedBookId && !(root.$store.catalog.orte && root.$store.catalog.orte.length) && typeof root.loadOrte === 'function') {
        _onceForBook(Alpine.store('nav').selectedBookId, 'orte', () => root.loadOrte(Alpine.store('nav').selectedBookId));
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
    // Volltextsuche-Provider. Async — feuert
    // `/search?q=...` und cached pro Query bis zur naechsten Eingabe.
    key: 'fulltext',
    prefix: '?',
    sectionKey: 'palette.section.fulltext',
    _cache: { q: '', book: '', items: null },
    _inflight: null,
    list() { return []; },
    prepare(root) {
      const q = (this._lastQuery || '').trim();
      if (q.length < 2) return;
      const bookId = Alpine.store('nav').selectedBookId || '';
      const cacheKey = q + '|' + bookId;
      if (this._cache && (this._cache.q + '|' + this._cache.book) === cacheKey) return;
      if (this._inflight === cacheKey) return;
      this._inflight = cacheKey;
      const url = new URLSearchParams({ q, kind: 'page,chapter,figure,location,scene,idea', limit: '12' });
      if (bookId) url.set('book_id', String(bookId));
      fetch('/search?' + url.toString(), { credentials: 'same-origin' })
        .then(r => r.ok ? r.json() : { hits: [] })
        .then(data => {
          this._cache = { q, book: bookId, items: Array.isArray(data.hits) ? data.hits : [] };
          // Re-Render der Palette anstossen — sonst zeigt sie das Cache-Miss-
          // Snapshot von vorhin bis zum naechsten Keystroke. palette-card
          // lauscht auf 'palette:rerender' und invalidiert Sections-Cache.
          window.dispatchEvent(new CustomEvent(EVT.PALETTE_RERENDER));
        })
        .catch(() => { this._cache = { q, book: bookId, items: [] }; })
        .finally(() => { if (this._inflight === cacheKey) this._inflight = null; });
    },
    search(root, q, t) {
      this._lastQuery = q;
      this.prepare(root);
      if (!q || q.length < 2) return [];
      const bookId = Alpine.store('nav').selectedBookId || '';
      const cacheKey = q + '|' + bookId;
      if (!this._cache || (this._cache.q + '|' + this._cache.book) !== cacheKey) return [];
      const items = this._cache.items || [];
      return items.slice(0, PER_PROVIDER_LIMIT).map(h => ({
        key: 'fts:' + h.kind + ':' + h.entity_id,
        providerKey: 'fulltext',
        label: h.title || (t('search.untitled') || ''),
        sub: t('search.kind.' + h.kind) || h.kind,
        snippet: h.snippet || '',
        score: 0,
        indices: [],
        available: true,
        run: (r) => _runFulltextHit(r, h),
      }));
    },
  },
  {
    key: 'szenen',
    prefix: '%',
    sectionKey: 'palette.section.szenen',
    list(root) {
      return Array.isArray(root.$store.catalog.szenen) ? root.$store.catalog.szenen : [];
    },
    // Szenen werden sonst nur beim Öffnen der Szenen-Karte geladen.
    prepare(root) {
      if (Alpine.store('nav').selectedBookId && !(root.$store.catalog.szenen && root.$store.catalog.szenen.length) && typeof root.loadSzenen === 'function') {
        _onceForBook(Alpine.store('nav').selectedBookId, 'szenen', () => root.loadSzenen(Alpine.store('nav').selectedBookId));
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
  {
    key: 'ereignisse',
    prefix: '&',
    sectionKey: 'palette.section.ereignisse',
    list(root) {
      return Array.isArray(root.$store.catalog.globalZeitstrahl) ? root.$store.catalog.globalZeitstrahl : [];
    },
    // Der Zeitstrahl wird sonst nur beim Öffnen der Ereignisse-Karte geladen.
    prepare(root) {
      if (Alpine.store('nav').selectedBookId && !this.list(root).length && typeof root._reloadZeitstrahl === 'function') {
        _onceForBook(Alpine.store('nav').selectedBookId, 'ereignisse', () => root._reloadZeitstrahl());
      }
    },
    search(root, q, _t) {
      const items = this.list(root);
      if (!items.length) return [];
      const out = [];
      for (const ev of items) {
        // Ohne `id` ist das Ereignis nicht adressierbar: solche Einträge stammen
        // aus dem Figuren-Fallback (`_buildGlobalZeitstrahl`) eines noch nicht
        // konsolidierten Buchs und stehen in keiner `zeitstrahl_events`-Zeile.
        if (ev.id == null) continue;
        const m = fuzzyMatch(q, ev.ereignis || '');
        if (!m) continue;
        const kapitel = Array.isArray(ev.kapitel) ? ev.kapitel[0] : ev.kapitel;
        out.push({
          key: 'ereignis:' + ev.id,
          providerKey: 'ereignisse',
          label: ev.ereignis || '',
          sub: [ev.datum_label || ev.datum || '', kapitel || ''].filter(Boolean).join(' · '),
          score: m.score,
          indices: m.indices,
          available: true,
          run: (r) => r.openEreignisById(ev.id),
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
