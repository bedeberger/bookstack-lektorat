import { escPreserveStrong, fetchText } from './utils.js';

const FIGUR_TYP_ORDER = { hauptfigur: 0, antagonist: 1, mentor: 2, nebenfigur: 3, andere: 4 };

// Allgemeine UI-Helpers: Status, Sortierung, Filter-Listen, Datumformatierung,
// Partial-Loader. Reine `this.*`-basierte Methoden ohne Querabhängigkeiten
// zu Job-Queues oder Routing — für die Hash-/Job-/View-Module vorgesehen.
export const appUiMethods = {
  setStatus(msg, spinner = false, duration = 0) {
    this.status = msg;
    this.statusSpinner = spinner;
    clearTimeout(this._statusTimer);
    if (duration > 0 && msg) {
      this._statusTimer = setTimeout(() => {
        this.status = '';
        this.statusSpinner = false;
      }, duration);
    }
  },

  setReviewStatus(msg, spinner = false) {
    this.bookReviewStatus = spinner
      ? `<span class="spinner"></span>${msg}`
      : msg;
  },

  // ── Sort helpers (use persistent order maps from loadPages) ─────────────
  _chapterIdx(name) { return this._chapterOrderMap?.get(name) ?? 9999; },
  _pageIdx(name) { return this._pageOrderMap?.get(name) ?? 9999; },
  _pageIdIdx(id) { return this._pageIdOrderMap?.get(id) ?? 9999; },
  _sortByChapterOrder(names) {
    return [...names].sort((a, b) => this._chapterIdx(a) - this._chapterIdx(b));
  },
  _sortByPageOrder(names) {
    return [...names].sort((a, b) => this._pageIdx(a) - this._pageIdx(b));
  },

  // ── Filter-Listen: Kapitel/Seiten-Optionen für Combobox-Filter ──────────
  // Generische Extraktion aus heterogenen Quellen:
  //   extract(item) liefert entweder einen String, ein Array von Strings
  //   oder ein Array von {name}-Objekten. Unbekannte Shapes werden ignoriert.
  _deriveKapitel(items, extract) {
    const names = new Set();
    for (const it of (items || [])) {
      const v = extract(it);
      if (!v) continue;
      if (Array.isArray(v)) {
        for (const x of v) {
          const n = typeof x === 'string' ? x : x?.name;
          if (n) names.add(n);
        }
      } else {
        names.add(v);
      }
    }
    return this._sortByChapterOrder([...names]);
  },
  // Wie _deriveKapitel, aber für Seiten. Wird nur aktiv, wenn ein Kapitel
  // gefiltert ist — ohne Kapitelfilter keine Seiten.
  // kapExtract liefert pro Item das Kapitel (String oder Array), seiteExtract
  // die Seite(n) (String oder Array).
  _deriveSeiten(items, filterKapitel, kapExtract, seiteExtract) {
    if (!filterKapitel) return [];
    const names = new Set();
    for (const it of (items || [])) {
      const k = kapExtract(it);
      const kapMatches = Array.isArray(k) ? k.includes(filterKapitel) : k === filterKapitel;
      if (!kapMatches) continue;
      const s = seiteExtract(it);
      if (!s) continue;
      if (Array.isArray(s)) { for (const x of s) if (x) names.add(x); }
      else names.add(s);
    }
    return this._sortByPageOrder([...names]);
  },

  szenenKapitelListe() {
    return this._deriveKapitel(this.szenen, s => s.kapitel);
  },
  // Pages im Szenen-Filter-Dropdown: alle Seiten des gewählten Kapitels — primär
  // aus dem Buch-Baum (via chapter_id-Match), ergänzt um evtl. abweichende
  // Schreibweisen aus den Szenen selbst. So bleibt der Filter auch dann nützlich,
  // wenn die KI bei einzelnen Szenen kein `seite` gesetzt hat.
  szenenSeitenListe() {
    if (!this.szenenFilters.kapitel) return [];
    // Kapitel-ID aus Szenen oder Tree auflösen (Name als Key, weil Filter ein Name ist).
    const chapterIds = new Set();
    for (const s of (this.szenen || [])) {
      if (s.kapitel === this.szenenFilters.kapitel && s.chapter_id) chapterIds.add(s.chapter_id);
    }
    for (const t of (this.tree || [])) {
      if (t.type === 'chapter' && t.name === this.szenenFilters.kapitel) chapterIds.add(t.id);
    }
    const names = new Set();
    for (const p of (this.pages || [])) {
      if (p.chapter_id && chapterIds.has(p.chapter_id) && p.name) names.add(p.name);
      else if (p.chapterName === this.szenenFilters.kapitel && p.name) names.add(p.name);
    }
    for (const s of (this.szenen || [])) {
      if (s.kapitel === this.szenenFilters.kapitel && s.seite) names.add(s.seite);
    }
    return this._sortByPageOrder([...names]);
  },
  orteKapitelListe() {
    return this._deriveKapitel(this.orte, o => o.kapitel);
  },

  kontinuitaetKapitelListe() {
    const chapterById = new Map(
      (this.tree || []).filter(t => t.type === 'chapter').map(t => [t.id, t.name])
    );
    const chapterNames = new Set(chapterById.values());
    // Extract chapter name from stelle text like "Kapitel 3: Seite 45" → "Kapitel 3"
    const fromStelle = (s) => {
      if (!s) return null;
      const ci = s.indexOf(':');
      const c = ci > 0 ? s.substring(0, ci).trim() : s.trim();
      return chapterNames.has(c) ? c : null;
    };
    const names = new Set();
    for (const issue of (this.kontinuitaetResult?.issues || [])) {
      // Primary: chapter_ids – authoritative server-side mapping
      if (issue.chapter_ids?.length) {
        for (const id of issue.chapter_ids) { const n = chapterById.get(id); if (n) names.add(n); }
      }
      // Secondary: kapitel names validated against tree
      if (issue.kapitel?.length) {
        for (const k of issue.kapitel) if (k && chapterNames.has(k)) names.add(k);
      }
      // Tertiary: extract from stelle_a / stelle_b (covers empty-kapitel cases)
      const a = fromStelle(issue.stelle_a); if (a) names.add(a);
      const b = fromStelle(issue.stelle_b); if (b) names.add(b);
    }
    return this._sortByChapterOrder([...names]);
  },

  figurenKapitelListe() {
    return this._deriveKapitel(this.figuren, f => f.kapitel);
  },

  figurenSeitenListe() {
    // seiten ist ein Array von {kapitel, seite} — eigener Iterator nötig,
    // weil _deriveSeiten eine Eins-zu-Eins-Relation annimmt.
    if (!this.figurenFilters.kapitel) return [];
    const names = new Set();
    for (const f of (this.figuren || [])) {
      for (const s of (f.seiten || [])) {
        if (s.kapitel === this.figurenFilters.kapitel && s.seite) names.add(s.seite);
      }
    }
    return this._sortByPageOrder([...names]);
  },

  filteredFiguren() {
    let result = this.figuren;
    const q = (this.figurenFilters.suche ?? '').toLowerCase();
    if (q) result = result.filter(f => (f.name ?? '').toLowerCase().includes(q));
    if (this.figurenFilters.kapitel) {
      result = result.filter(f =>
        (f.kapitel ?? []).some(k => k.name === this.figurenFilters.kapitel)
      );
    }
    if (this.figurenFilters.seite) {
      result = result.filter(f =>
        (f.seiten ?? []).some(s => s.kapitel === this.figurenFilters.kapitel && s.seite === this.figurenFilters.seite)
      );
    }
    return [...result].sort((a, b) => {
      const aK = Math.min(...(a.kapitel ?? []).map(k => this._chapterIdx(k.name)), 9999);
      const bK = Math.min(...(b.kapitel ?? []).map(k => this._chapterIdx(k.name)), 9999);
      if (aK !== bK) return aK - bK;
      const aT = FIGUR_TYP_ORDER[a.typ] ?? 99;
      const bT = FIGUR_TYP_ORDER[b.typ] ?? 99;
      if (aT !== bT) return aT - bT;
      return (a.name ?? '').localeCompare(b.name ?? '', 'de');
    });
  },

  ereignisseKapitelListe() {
    return this._deriveKapitel(this.globalZeitstrahl, ev => ev.kapitel);
  },

  ereignisseSeitenListe() {
    return this._deriveSeiten(
      this.globalZeitstrahl,
      this.ereignisseFilters.kapitel,
      ev => ev.kapitel,
      ev => Array.isArray(ev.seiten) ? ev.seiten : ev.seite,
    );
  },

  filteredEreignisse() {
    let result = this.globalZeitstrahl;
    if (this.ereignisseFilters.suche) {
      const q = this.ereignisseFilters.suche.toLowerCase();
      result = result.filter(ev => (ev.ereignis || '').toLowerCase().includes(q));
    }
    if (this.ereignisseFilters.figurId) {
      result = result.filter(ev => ev.figuren.some(f => f.id === this.ereignisseFilters.figurId));
    }
    if (this.ereignisseFilters.kapitel) {
      result = result.filter(ev => {
        const kap = Array.isArray(ev.kapitel) ? ev.kapitel : (ev.kapitel ? [ev.kapitel] : []);
        return kap.includes(this.ereignisseFilters.kapitel);
      });
    }
    if (this.ereignisseFilters.seite && this.ereignisseFilters.kapitel) {
      result = result.filter(ev => {
        const seiten = Array.isArray(ev.seiten) ? ev.seiten : (ev.seite ? [ev.seite] : []);
        return seiten.includes(this.ereignisseFilters.seite);
      });
    }
    return result;
  },

  // ── Datum / Save-Status ─────────────────────────────────────────────────
  formatDate(iso) {
    if (!iso) return '';
    const tag = this.uiLocale === 'en' ? 'en-US' : 'de-CH';
    return new Date(iso).toLocaleString(tag, {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  },

  escPreserveStrong,

  _saveStatus() {
    const server = Math.max(
      this.lastAutosaveAt || 0,
      this.currentPage?.updated_at ? new Date(this.currentPage.updated_at).getTime() : 0,
    );
    // Draft-Zeitstempel zählt nur im Fokusmodus und nur wenn er neuer als Server ist.
    const draft = (this.focusMode && this.lastDraftSavedAt && this.lastDraftSavedAt > server)
      ? this.lastDraftSavedAt : 0;
    if (draft) return { ts: draft, kind: 'draft' };
    if (server) return { ts: server, kind: 'saved' };
    return { ts: 0, kind: '' };
  },

  _formatSaveTs(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const tag = this.uiLocale === 'en' ? 'en-US' : 'de-CH';
    const sameDay = d.toDateString() === new Date().toDateString();
    if (sameDay) {
      return d.toLocaleTimeString(tag, { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleString(tag, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  },

  lastSavedLabel() { return this._formatSaveTs(this._saveStatus().ts); },
  lastSavedKind() { return this._saveStatus().kind; },

  // ── Partials laden ───────────────────────────────────────────────────────
  // DOM-Auto-Discovery: jeder `<div id="partial-$name">` bekommt seinen
  // Inhalt aus `/partials/$name.html`. Partials dürfen weitere
  // `partial-*`-Container enthalten – die Schleife iteriert, bis nichts
  // Neues mehr auftaucht (Schutzlimit gegen zirkuläre Referenzen).
  async _loadPartials() {
    const loadPass = async () => {
      const empty = [...document.querySelectorAll('[id^="partial-"]')]
        .filter(el => el.childElementCount === 0);
      if (empty.length === 0) return 0;
      await Promise.all(empty.map(async el => {
        const name = el.id.replace(/^partial-/, '');
        const html = await fetchText(`/partials/${name}.html`);
        el.innerHTML = html;
        Alpine.initTree(el);
      }));
      return empty.length;
    };
    let safety = 5;
    while (safety-- > 0 && await loadPass() > 0) { /* weiter */ }
  },
};
