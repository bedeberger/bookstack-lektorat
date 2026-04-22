import { escPreserveStrong, fetchText } from './utils.js';

const FIGUR_TYP_ORDER = { hauptfigur: 0, antagonist: 1, mentor: 2, nebenfigur: 3, andere: 4 };

// Pure Filter-Logik für die Szenen-Liste. Getrennt von Alpine-Getter, damit
// Unit-Tests den Page-/Kapitel-Filter direkt gegen Fixtures prüfen können —
// besonders die Regression, dass der Seiten-Filter per `page_id` (Number) UND
// Name (String) matchen muss.
export function applySzenenFilters(szenen, filters) {
  const q = filters.suche ? filters.suche.toLowerCase() : '';
  return (szenen || []).filter(s =>
    (!q || (s.titel || '').toLowerCase().includes(q)) &&
    (!filters.wertung || s.wertung === filters.wertung) &&
    (!filters.figurId || (s.fig_ids || []).includes(filters.figurId)) &&
    (!filters.kapitel || s.kapitel === filters.kapitel) &&
    (!filters.seite || (typeof filters.seite === 'number'
      ? s.page_id === filters.seite
      : s.seite === filters.seite)) &&
    (!filters.ortId || (s.ort_ids || []).includes(filters.ortId))
  );
}

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
  // Pages im Szenen-Filter-Dropdown: nur Seiten, die tatsächlich Szenen tragen.
  // Value ist primär die `page_id` (Number) — der Filter matcht dann auch Szenen,
  // deren `seite`-String abweicht (z.B. KI-Schreibweise ≠ BookStack-Titel).
  // Fallback für Szenen ohne auflösbare `page_id`: Seitenname als String-Value.
  szenenSeitenListe() {
    if (!this.szenenFilters.kapitel) return [];
    const pageIdsOfKapitel = new Set();
    const namesOfKapitel = new Set();
    for (const s of (this.szenen || [])) {
      if (s.kapitel !== this.szenenFilters.kapitel) continue;
      if (s.page_id) pageIdsOfKapitel.add(s.page_id);
      else if (s.seite) namesOfKapitel.add(s.seite);
    }
    const options = [];
    const labelById = new Map();
    // Primär: Tree-Seiten auflösen (stabile page_id, robuster Label).
    for (const p of (this.pages || [])) {
      if (p.id && pageIdsOfKapitel.has(p.id) && p.name && !labelById.has(p.id)) {
        options.push({ value: p.id, label: p.name });
        labelById.set(p.id, p.name);
      }
    }
    // Fallback: page_id, die in `this.pages` nicht aufzulösen ist (Tree noch
    // nicht geladen) → Szenen-`seite`-String als Label.
    for (const s of (this.szenen || [])) {
      if (s.kapitel !== this.szenenFilters.kapitel || !s.page_id || !s.seite) continue;
      if (!labelById.has(s.page_id)) {
        options.push({ value: s.page_id, label: s.seite });
        labelById.set(s.page_id, s.seite);
      }
    }
    // Szenen ohne page_id: Name als Value (schwächerer Match, aber besser als nichts).
    for (const name of namesOfKapitel) {
      options.push({ value: name, label: name });
    }
    return options.sort((a, b) => this._pageIdx(a.label) - this._pageIdx(b.label));
  },
  orteKapitelListe() {
    return this._deriveKapitel(this.orte, o => o.kapitel);
  },

  // kontinuitaetKapitelListe() wandert in Alpine.data('kontinuitaetCard').

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

  // ereignisseKapitelListe / ereignisseSeitenListe / filteredEreignisse
  // wandern in Alpine.data('ereignisseCard') — siehe cards/ereignisse-card.js.

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
