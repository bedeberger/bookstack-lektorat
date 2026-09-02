// Kontext-Slice der Referenz-Karte (Alpine.data('referenceCard'), cards/reference-card.js):
// die EINE Regel, nach der jeder Reiter entscheidet, was zur offenen Seite bzw.
// zu deren Kapitel gehoert — plus die daraus gefilterten Listen und ihr Memo.
//
// Warum als eigener Slice und nicht in der Karte: die Karte macht Laden, Tabs
// und die zwei schreibenden Wege (O-Ton, Beleg); hier steht ausschliesslich
// RECHNUNG auf schon geladenen Daten. Die Trennung haelt beide unter dem
// LOC-Deckel und macht den Kontext-Filter fuer sich testbar — er ist der Teil,
// an dem sich die Reiter systematisch unterscheiden (siehe Kopf der Karte:
// Figuren ueber figure_appearances ∪ Namensfund, Orte ueber location_chapters
// ∪ Namensfund, Szenen ueber alle drei Toepfe, Ereignisse ueber die Bruecken-
// IDs, Recherche ueber die Verknuepfungen).
//
// Der Zustand dazu (`_memos`, `_refPageText`, `_refPageTextKey`) bleibt in der
// Karte deklariert — ein Slice spreadet Methoden, keine eigene State-Insel.
// Schreibt nie in den Buchtext.

import { selectScenesForView } from '../editor/notebook/entities.js';

/** Herkunft einer Zeile im Kontext-Scope: 'page' = haengt an der offenen Seite,
 *  'chapter' = haengt am Kapitel (andere Seite oder ohne Seitenbezug). Jede
 *  Liste markiert ihre Zeilen damit, statt beides wortlos zu vermischen — der
 *  Autor muss sehen, was wirklich vor ihm steht und was drumherum liegt.
 *  Kopie statt Mutation: die Katalog-Objekte im Store bleiben unberuehrt. */
const markCtx = (list, refCtx, extra) =>
  list.map(x => ({ ...x, refCtx, ...(extra ? extra(x) : null) }));

/** Ist `id` in der Liste? Vergleich ueber Number, weil Bruecken-IDs je nach
 *  Route als Zahl oder String ankommen. Nur fuer die NUMERISCHEN Anker
 *  (page_id/chapter_id) — Figuren tragen eine TEXT-Identitaet, siehe `figKey`. */
const hasId = (ids, id) =>
  id != null && Array.isArray(ids) && ids.some(x => x != null && Number(x) === Number(id));

/** Identitaet einer Figur als Vergleichsschluessel. Die Achse ist die TEXT-
 *  `fig_id` (`/figures/:book_id` UND `/figures/chapter/:book_id/:chapter_id`
 *  liefern sie als `id`) — sie darf nie durch `Number()` laufen: 'fig_7' wird
 *  dabei zu NaN, jeder Vergleich schlaegt fehl, und die Vereinigung unten haelt
 *  dann jede Kapitel-Figur fuer unbekannt und rendert sie doppelt. */
const figKey = (f) => (f?.id == null ? '' : String(f.id));

export const referenceContextMethods = {
  // ── Memo (ein Helper pro Modul, Array-Deps mit ===) ──────────────────────
  _memo(key, deps, fn) {
    const prev = this._memos[key];
    if (prev && prev.deps.length === deps.length && prev.deps.every((d, i) => d === deps[i])) {
      return prev.val;
    }
    const val = fn();
    this._memos[key] = { deps, val };
    return val;
  },

  _pageKey() {
    const p = window.__app?.currentPage;
    return p ? (p.id + ':' + (p.updated_at || '')) : '';
  },

  // Plaintext der aktuellen Seite (Namens-Treffer für Figuren/Orte im Kontext).
  _pageText() {
    const app = window.__app;
    if (!app?.currentPage) return '';
    const key = this._pageKey();
    if (this._refPageTextKey === key) return this._refPageText;
    const html = app.originalHtml || '';
    this._refPageText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').toLowerCase();
    this._refPageTextKey = key;
    return this._refPageText;
  },

  _nameInPage(names) {
    const txt = this._pageText();
    if (!txt) return false;
    return names.some(n => n && txt.includes(String(n).toLowerCase()));
  },

  _currentChapterName() {
    const cid = window.__app?.currentPage?.chapter_id;
    if (!cid) return '';
    const ch = (Alpine.store('nav').tree || []).find(c => c.id === cid);
    return ch?.name || '';
  },

  // ── Gefilterte Listen (memoized — im Template + in referenceCount genutzt) ─
  // Vereinigung statt Entweder-oder: der Namens-Treffer im Seitentext UND die
  // server-geladene Kapitel-Figurenliste. `chapterFigures` ist der Index
  // (`figure_appearances`) und kennt eine eben erst geschriebene Erwaehnung
  // noch nicht; der Namensfund kennt umgekehrt keine Figur, die auf dieser
  // Seite nur umschrieben wird. Gerendert werden die Katalog-Objekte — sie
  // tragen das volle Dossier, `chapterFigures` nur einen Spaltenausschnitt.
  referenceFiguren() {
    const app = window.__app;
    const all = Alpine.store('catalog').figuren || [];
    const chapterFigs = app?.chapterFigures || [];
    return this._memo('figuren', [this.referenceScope, this._pageKey(), all, chapterFigs], () => {
      if (!this._contextActive()) return all;
      const chapKeys = new Set(chapterFigs.map(figKey).filter(Boolean));
      const chapNames = new Set(chapterFigs.map(f => String(f?.name || '').toLowerCase()).filter(Boolean));
      const inChap = (f) => chapKeys.has(figKey(f)) || chapNames.has(String(f?.name || '').toLowerCase());
      const onPage = [];
      const inChapter = [];
      const known = new Set();
      for (const f of all) {
        const k = figKey(f);
        if (k) known.add(k);
        if (this._nameInPage([f.name, f.kurzname])) onPage.push(f);
        else if (inChap(f)) inChapter.push(f);
      }
      // Kapitel-Figuren ohne Katalog-Gegenstueck: der Slot laedt den Katalog
      // asynchron nach — bis dahin darf die Liste nicht leer wirken. Beide
      // Listen sprechen dieselbe Identitaet (`figKey`), sonst ist hier JEDE
      // Kapitel-Figur ein Waisenkind und steht ein zweites Mal in der Liste.
      const orphans = chapterFigs.filter(f => !figKey(f) || !known.has(figKey(f)));
      return [...markCtx(onPage, 'page'), ...markCtx([...inChapter, ...orphans], 'chapter')];
    });
  },

  // Zwei Wege in den Kontext, wie bei den Figuren: die Kapitel-Zuordnung
  // (`location_chapters`, kommt als `ort.kapitel` mit) UND der Namens-Treffer
  // im Seitentext. Vereinigung statt Entweder-oder — der Namensfund holt Orte,
  // deren Index noch nicht nachgezogen ist, die Kapitel-Kante holt jene, die
  // auf dieser Seite nur umschrieben werden ("die Burg").
  referenceOrte() {
    const all = Alpine.store('catalog').orte || [];
    const cid = window.__app?.currentPage?.chapter_id ?? null;
    return this._memo('orte', [this.referenceScope, this._pageKey(), cid, all], () => {
      if (!this._contextActive()) return all;
      const onPage = [];
      const inChapter = [];
      for (const o of all) {
        if (this._nameInPage([o.name])) onPage.push(o);
        else if (this._ortInChapter(o, cid)) inChapter.push(o);
      }
      return [...markCtx(onPage, 'page'), ...markCtx(inChapter, 'chapter')];
    });
  },

  /** Haengt der Ort ueber `location_chapters` am aktuellen Kapitel?
   *  `ort.kapitel` liefert /locations/:book_id als [{ chapter_id, name, … }];
   *  ohne explizite Zuordnung steht dort der aus der Erstnennung abgeleitete
   *  Eintrag — beides zaehlt gleich. */
  _ortInChapter(ort, chapterId) {
    const kap = Array.isArray(ort?.kapitel) ? ort.kapitel : [];
    return hasId(kap.map(k => k?.chapter_id), chapterId);
  },

  // Alle drei Kontext-Toepfe, nicht nur zwei: eine Szene, die dem Kapitel UND
  // einer anderen Seite desselben Kapitels gehoert, fiel bisher aus der Liste.
  // Reihenfolge: diese Seite → kapitelweit ungebunden → andere Seite im Kapitel.
  referenceSzenen() {
    const all = Alpine.store('catalog').szenen || [];
    const app = window.__app;
    const pid = app?.currentPage?.id;
    const cid = app?.currentPage?.chapter_id;
    const pages = Alpine.store('nav').pages || [];
    return this._memo('szenen', [this.referenceScope, pid, cid, all, pages], () => {
      if (!this._contextActive()) return all;
      const v = selectScenesForView(all, pid, cid);
      return [
        ...markCtx(v.onPage, 'page'),
        ...markCtx(v.inChapter, 'chapter'),
        ...markCtx(v.inChapterOtherPage, 'chapter',
          (s) => ({ refPageName: this._pageName(s.page_id, pages) })),
      ];
    });
  },

  _pageName(pageId, pages) {
    if (pageId == null) return '';
    const p = (pages || []).find(x => Number(x.id) === Number(pageId));
    return p?.name || '';
  },

  /** Untertitel einer Zeile im Kontext-Scope: an welcher ANDEREN Seite sie
   *  haengt. Leer, wenn sie zu dieser Seite gehoert oder kapitelweit gilt —
   *  dann waere die Angabe nur Rauschen. Geteilt von Szenen + Ereignissen. */
  referenceRowWhere(row) {
    if (!row?.refPageName) return '';
    return window.__app.t('reference.ctx.onOtherPage', { page: row.refPageName });
  },

  // Ereignisse tragen ihre Anker als IDs (`page_ids`/`chapter_ids`, Bruecken
  // zeitstrahl_event_pages/_chapters) — danach wird gefiltert, nicht mehr nach
  // dem Kapitel-NAMEN: der verwechselt gleichnamige Kapitel und faellt nach
  // jeder Umbenennung aus. Seitenanker zuerst, Kapitelanker danach.
  referenceEreignisse() {
    const all = Alpine.store('catalog').globalZeitstrahl || [];
    const app = window.__app;
    const pid = app?.currentPage?.id ?? null;
    const cid = app?.currentPage?.chapter_id ?? null;
    const chapName = this._currentChapterName();
    const pages = Alpine.store('nav').pages || [];
    return this._memo('ereignisse', [this.referenceScope, pid, cid, chapName, all, pages], () => {
      if (!this._contextActive()) return all;
      const onPage = [];
      const inChapter = [];
      for (const ev of all) {
        if (hasId(ev?.page_ids, pid)) onPage.push(ev);
        else if (this._evtInChapter(ev, cid, chapName)) inChapter.push(ev);
      }
      return [
        ...markCtx(onPage, 'page'),
        ...markCtx(inChapter, 'chapter',
          (ev) => ({ refPageName: this._evtOtherPageNames(ev, pid, pages) })),
      ];
    });
  },

  /** Kapitel-Zugehoerigkeit eines Ereignisses. `chapter_ids` ist die Wahrheit;
   *  der Namensvergleich bleibt nur als Rueckfall fuer Eintraege ganz ohne
   *  IDs — er ist die Regel, die dieser Reiter gerade losgeworden ist. */
  _evtInChapter(ev, chapterId, chapterName) {
    // Anker sind Listen — die Kanonform stellt cards/ereignisse/model.js an den
    // beiden Schreibstellen des Stores her (book/ereignisse.js).
    const ids = ev?.chapter_ids || [];
    if (ids.length) return hasId(ids, chapterId);
    if (!chapterName) return false;
    const cl = String(chapterName).toLowerCase();
    return (ev?.kapitel || []).some(k => String(k).toLowerCase() === cl);
  },

  /** Seiten, an denen ein Kapitel-Ereignis sonst noch haengt (ohne die offene).
   *  Leer, wenn es gar keinen Seitenanker hat — dann ist es kapitelweit. */
  _evtOtherPageNames(ev, pageId, pages) {
    const ids = (ev?.page_ids || [])
      .filter(x => x != null && Number(x) !== Number(pageId));
    if (!ids.length) return '';
    return ids.map(id => this._pageName(id, pages)).filter(Boolean).join(', ');
  },

  // Dieselbe Zweiteilung wie die Geschwister-Reiter: die Verknuepfung zeigt
  // entweder auf diese Seite oder auf ihr Kapitel. Gefiltert wurde schon
  // vorher nach beidem — neu ist, dass die Zeile sagt, welches von beiden.
  referenceRechercheItems() {
    const all = this.referenceRecherche || [];
    const app = window.__app;
    const pid = app?.currentPage?.id;
    const cid = app?.currentPage?.chapter_id;
    return this._memo('recherche', [this.referenceScope, pid, cid, all], () => {
      if (!this._contextActive()) return all;
      const onPage = [];
      const inChapter = [];
      for (const it of all) {
        const links = Array.isArray(it?.links) ? it.links : [];
        if (pid != null && links.some(l => l.target_kind === 'page' && Number(l.target_id) === Number(pid))) {
          onPage.push(it);
        } else if (cid != null && links.some(l => l.target_kind === 'chapter' && Number(l.target_id) === Number(cid))) {
          inChapter.push(it);
        }
      }
      return [...markCtx(onPage, 'page'), ...markCtx(inChapter, 'chapter')];
    });
  },

  referenceCount(tab) {
    switch (tab) {
      case 'figuren':    return this.referenceFiguren().length;
      case 'orte':       return this.referenceOrte().length;
      case 'szenen':     return this.referenceSzenen().length;
      case 'ereignisse': return this.referenceEreignisse().length;
      case 'recherche':  return this.referenceRechercheItems().length;
      case 'quellen':    return this.referenceQuellen().length;
      case 'verwandt':   return this.verwandtResults().length;
      default:           return 0;
    }
  },
};
