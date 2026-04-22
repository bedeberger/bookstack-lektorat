import { escPreserveStrong, fetchText } from './utils.js';

// Pure Filter-Logik für die Szenen-Liste. Getrennt von Alpine-Getter, damit
// Unit-Tests den Page-/Kapitel-Filter direkt gegen Fixtures prüfen können.
// Kapitel-Filter matcht per Name (die Kapitelnamen in den Szenen stammen aus
// dem Komplett-Job und sind dort bereits auf die echten BookStack-Namen
// normalisiert). Seiten-Filter matcht ausschliesslich per `page_id` (Number) —
// die Dropdown-Optionen liefert `szenenSeitenListe()` direkt aus dem
// BookStack-Kapitel-Baum, sodass der Value immer eine gültige page_id ist.
export function applySzenenFilters(szenen, filters) {
  const q = filters.suche ? filters.suche.toLowerCase() : '';
  return (szenen || []).filter(s =>
    (!q || (s.titel || '').toLowerCase().includes(q)) &&
    (!filters.wertung || s.wertung === filters.wertung) &&
    (!filters.figurId || (s.fig_ids || []).includes(filters.figurId)) &&
    (!filters.kapitel || s.kapitel === filters.kapitel) &&
    (!filters.seite || s.page_id === filters.seite) &&
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
  // Pages im Szenen-Filter-Dropdown: alle Seiten des gewählten Kapitels aus
  // dem BookStack-Kapitel-Baum (`this.pages`). So bleibt das Dropdown auch
  // dann befüllt, wenn die KI bei einzelnen Szenen keine `seite` gesetzt hat.
  // Value = page_id (Number); der Filter in `applySzenenFilters` matcht strikt
  // `s.page_id === filter.seite`. Szenen mit `page_id=null` tauchen in keinem
  // Seiten-Filter auf – das ist OK (User sieht sie ohne Seitenfilter).
  szenenSeitenListe() {
    if (!this.szenenFilters.kapitel) return [];
    // chapter_id aus Tree auflösen; Fallback aus den Szenen selbst (falls Tree
    // noch nicht geladen oder Kapitel = "Sonstige Seiten" → chapterId bleibt null).
    let chapterId = (this.tree || [])
      .find(t => t.type === 'chapter' && t.name === this.szenenFilters.kapitel)?.id ?? null;
    if (chapterId == null) {
      for (const s of (this.szenen || [])) {
        if (s.kapitel === this.szenenFilters.kapitel && s.chapter_id) {
          chapterId = s.chapter_id; break;
        }
      }
    }
    const matchesChapter = chapterId == null
      ? (p => !p.chapter_id && p.chapterName === this.szenenFilters.kapitel)
      : (p => p.chapter_id === chapterId);
    return (this.pages || [])
      .filter(p => p.id && p.name && matchesChapter(p))
      .map(p => ({ value: p.id, label: p.name }))
      .sort((a, b) => this._pageIdx(a.label) - this._pageIdx(b.label));
  },
  orteKapitelListe() {
    return this._deriveKapitel(this.orte, o => o.kapitel);
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
