import { escPreserveStrong, fetchText, tzOpts, formatRelativeShort, charBadgeLabel } from '../utils.js';
import { avatarHue } from '../avatar.js';

// Pure Filter-Logik für die Szenen-Liste. Getrennt von Alpine-Getter, damit
// Unit-Tests den Kapitel-Filter direkt gegen Fixtures prüfen können.
// Kapitel-Filter matcht per Name (die Kapitelnamen in den Szenen stammen aus
// dem Komplett-Job und sind dort bereits auf die echten BookStack-Namen
// normalisiert).
// Pure Filter-Logik für die Musik-Liste. Songs[].figuren kann String (fig_id)
// oder Object ({ fig_id }) enthalten — je nachdem ob der Server das per-Figur-
// Kontext-Override mitliefert. Filter normalisiert beide Formen.
export function applySongsFilters(songs, filters) {
  const q = filters.suche ? filters.suche.toLowerCase() : '';
  return (songs || []).filter(s => {
    if (q) {
      const hay = `${s.titel || ''} ${s.interpret || ''} ${s.genre || ''} ${s.beschreibung || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (filters.figurId && !(s.figuren || []).some(x => (x.fig_id || x) === filters.figurId)) return false;
    if (filters.kapitel && !(s.kapitel || []).some(k => k.name === filters.kapitel)) return false;
    if (filters.genre && s.genre !== filters.genre) return false;
    if (filters.kontextTyp && s.kontext_typ !== filters.kontextTyp) return false;
    return true;
  });
}

export function applySzenenFilters(szenen, filters) {
  const q = filters.suche ? filters.suche.toLowerCase() : '';
  return (szenen || []).filter(s =>
    (!q || (s.titel || '').toLowerCase().includes(q)) &&
    (!filters.wertung || s.wertung === filters.wertung) &&
    (!filters.figurId || (s.fig_ids || []).includes(filters.figurId)) &&
    (!filters.kapitel || s.kapitel === filters.kapitel) &&
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

  // Kompakte Zeichen-Plakette („842 Z" / „~13k Z"). SSoT fuer alle Oberflaechen,
  // die sie zeigen (Sidebar-Kapitel + -Seite, Notebook-Kopfleiste, Kapitel-
  // bewertung) — die Einheit kommt aus der i18n, nicht aus einem Literal.
  charBadge(chars) {
    return charBadgeLabel(chars, this.t('bookstats.unit.z'));
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
    return this._deriveKapitel(this.$store.catalog.szenen, s => s.kapitel);
  },
  orteKapitelListe() {
    return this._deriveKapitel(this.$store.catalog.orte, o => o.kapitel);
  },

  // ── Email-Display-Lookup ────────────────────────────────────────────────
  // Liefert den lesbaren Anzeigenamen zu einer Email. Erstaufruf triggert das
  // Lazy-Load via `/me/users-light`; bis dahin Email als Platzhalter, damit
  // die UI nichts springt. Unbekannte Emails (nicht mehr in app_users) bleiben
  // als Email zurueckgegeben — kein Hard-Fail, weil Revisionen historische
  // User behalten duerfen, die zwischenzeitlich entfernt wurden.
  userDisplayName(email) {
    if (!email) return '';
    if (!this._usersByEmail && !this._usersByEmailLoading) this._loadUsersLight();
    const hit = this._usersByEmail?.get(String(email).toLowerCase());
    return hit?.display_name || email;
  },

  // Initialen-Bubble. Versucht erst den display_name (2 Tokens: „Alice Müller"
  // → „AM"); faellt sonst auf die Email-Local-Part zurueck (mit Separator-
  // Split: „david.berger" → „DB"). Single-Token-Namen liefern 1 Buchstaben.
  // Maximal 2 Zeichen, immer uppercase.
  userInitials(email) {
    if (!email) return '?';
    const name = this.userDisplayName(email);
    const isEmail = String(name).indexOf('@') > -1;
    const source = isEmail ? String(email).split('@')[0] : String(name);
    const tokens = source.split(/[\s._-]+/).filter(Boolean);
    if (tokens.length === 0) return '?';
    const first = tokens[0][0] || '';
    const second = tokens.length > 1 ? (tokens[1][0] || '') : '';
    return (first + second).toUpperCase().slice(0, 2);
  },

  // Deterministische Akzentfarbe pro Email, damit zwei verschiedene User in
  // einer Liste visuell auseinanderzuhalten sind. Hash → Hue → HSL, Sat/L
  // an Theme-Tokens halten. Konsistent ueber Reloads (kein Random).
  // Deterministische Pip-Farbe pro User (SSoT: public/js/avatar.js — geteilt mit
  // der Share-Reader-Leiste, damit dieselbe Person stabil dieselbe Hue bekommt).
  userAvatarHue(email) {
    return avatarHue(email);
  },

  async _loadUsersLight() {
    if (this._usersByEmailLoading) return;
    this._usersByEmailLoading = true;
    try {
      const r = await fetch('/me/users-light');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const map = new Map();
      for (const u of (data?.users || [])) {
        if (u?.email) map.set(String(u.email).toLowerCase(), { display_name: u.display_name || null });
      }
      this._usersByEmail = map;
    } catch (e) {
      console.warn('[users-light]', e);
      // Leere Map setzen, damit Folge-Aufrufe nicht in Endlos-Retry laufen;
      // Re-Try beim naechsten Session-Boot.
      this._usersByEmail = new Map();
    } finally {
      this._usersByEmailLoading = false;
    }
  },

  // ── Datum / Save-Status ─────────────────────────────────────────────────
  formatDate(iso) {
    if (!iso) return '';
    const tag = this.$store.shell.uiLocale === 'en' ? 'en-US' : 'de-CH';
    return new Date(iso).toLocaleString(tag, tzOpts({
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }));
  },

  // Intl-Options mit der App-Timezone für Datums-Displays in Templates
  // (`$app.tzOpts(opts)`). Spiegelt den Util, damit Alpine-Expressions die
  // app.timezone-Setting anwenden können statt in Browser-TZ zu rendern.
  tzOpts(opts) {
    return tzOpts(opts);
  },

  // Kurz-relative Zeit („vor 3 Minuten") für push-getriebene Hints wie den
  // „Zuletzt bearbeitet auf <Gerät>"-Banner. Lokalisierung via Intl in utils.
  formatRelativeShort(iso) {
    return formatRelativeShort(iso, this.$store.shell.uiLocale);
  },

  escPreserveStrong,

  _saveStatus() {
    // Reihenfolge: lokaler Persist-Fehler zuerst (unsaved — Inhalt liegt nicht
    // einmal in localStorage, stärkstes Signal), dann aktive Vorgänge (saving),
    // dann Fehlerzustände (offline), dann normale Resultate (draft/saved).
    // saveOffline/draftPersistFailed bleiben sticky bis zum nächsten
    // erfolgreichen Save → User sieht den Fehlerzustand durchgehend.
    if (this.draftPersistFailed) {
      return { ts: this.lastDraftSavedAt || 0, kind: 'unsaved' };
    }
    if (this.editSaving) {
      return { ts: this.lastDraftSavedAt || this.lastAutosaveAt || 0, kind: 'saving' };
    }
    if (this.saveOffline) {
      return { ts: this.lastDraftSavedAt || this.lastAutosaveAt || 0, kind: 'offline' };
    }
    const server = Math.max(
      this.lastAutosaveAt || 0,
      this.currentPage?.updated_at ? new Date(this.currentPage.updated_at).getTime() : 0,
    );
    // Draft-Zeitstempel zählt nur im Fokusmodus und nur wenn er neuer als Server ist.
    const draft = (this.focusActive && this.lastDraftSavedAt && this.lastDraftSavedAt > server)
      ? this.lastDraftSavedAt : 0;
    if (draft) return { ts: draft, kind: 'draft' };
    if (server) return { ts: server, kind: 'saved' };
    return { ts: 0, kind: 'none' };
  },

  _formatSaveTs(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const tag = this.$store.shell.uiLocale === 'en' ? 'en-US' : 'de-CH';
    const sameDay = d.toDateString() === new Date().toDateString();
    if (sameDay) {
      return d.toLocaleTimeString(tag, tzOpts({ hour: '2-digit', minute: '2-digit' }));
    }
    return d.toLocaleString(tag, tzOpts({ day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }));
  },

  lastSavedLabel() { return this._formatSaveTs(this._saveStatus().ts); },
  lastSavedKind() { return this._saveStatus().kind; },

  // Lokalisierter Text fürs Save-Status-Pill (Card-Subline + Focus-Header).
  // 'saving'  → „Speichert…"
  // 'offline' → „Offline – wartet auf Verbindung" (mit letztem Draft-Zeitstempel,
  //             falls vorhanden)
  // 'draft'   → „Entwurf {when}" (nur Focus-Mode, lokaler ungespeicherter Stand)
  // 'saved'   → „gespeichert {when}"
  // 'none'    → leer (keine Status-Anzeige)
  saveIndicatorText() {
    const { ts, kind } = this._saveStatus();
    const when = ts ? this._formatSaveTs(ts) : '';
    if (kind === 'unsaved') return this.t('edit.status.unsaved');
    if (kind === 'saving') return this.t('edit.status.saving');
    if (kind === 'offline') {
      return when
        ? this.t('edit.status.offlineWith', { when })
        : this.t('edit.status.offline');
    }
    if (kind === 'draft') return this.t('editor.draft', { when });
    if (kind === 'saved') return this.t('editor.saved', { when });
    return '';
  },

  // Tooltip pro Kind — Detail zum Status-Pill (data-tip CSS-Hover).
  saveIndicatorTip() {
    const kind = this._saveStatus().kind;
    if (kind === 'unsaved') return this.t('edit.status.unsavedTip');
    if (kind === 'saving') return this.t('edit.status.savingTip');
    if (kind === 'offline') return this.t('edit.status.offlineTip');
    if (kind === 'draft') return this.t('editor.draftTitle');
    if (kind === 'saved') return this.t('editor.savedTitle');
    return '';
  },

  // ── Partials laden ───────────────────────────────────────────────────────
  // Boot lädt nur die ESSENTIAL-Partials (immer sichtbarer Shell-Anteil).
  // Karten-Partials werden lazy geladen, wenn der zugehörige Toggle das erste
  // Mal feuert (siehe `_ensurePartial`). Spart beim Cold-Boot ~50 Fetches +
  // Alpine.initTree-Walks für Karten, die der User nie öffnet.
  //
  // Trust: Partial-HTML kommt vom eigenen Server (statische Dateien unter
  // /partials/), Auth-pflichtig. innerHTML-Injection ist daher sicher; XSS
  // wird durch die `x-html`-Escape-Regel (siehe CLAUDE.md) abgedeckt, nicht
  // hier.
  async _loadEssentialPartials() {
    const ESSENTIAL = [
      'avatar-menu', 'komplett-status', 'sidebar',
      'palette', 'job-toast', 'collab-toast', 'shortcuts',
    ];
    await Promise.all(ESSENTIAL.map(name => this._ensurePartial(name)));
  },

  // Lazy-Load eines einzelnen Partials. Idempotent: zweiter Aufruf liefert die
  // bereits laufende Promise zurück (verhindert Doppel-Fetch bei parallelen
  // Toggle-Klicks). Aufrufer-Pattern: `await this._ensurePartial('figuren')`
  // direkt vor dem Setzen des Show-Flags in der Toggle-Methode.
  async _ensurePartial(name) {
    if (!name) return false;
    const el = document.getElementById(`partial-${name}`);
    if (!el) return false;
    if (el.childElementCount > 0) return true;
    this._partialPromises ||= {};
    if (this._partialPromises[name]) return this._partialPromises[name];
    this._partialPromises[name] = (async () => {
      try {
        await this._injectPartial(el, name);
        await this._cascadePartialsInside(el);
        return true;
      } catch (e) {
        console.error(`[ensurePartial:${name}]`, e);
        delete this._partialPromises[name];
        return false;
      }
    })();
    return this._partialPromises[name];
  },

  // Rekursiv alle leeren `partial-*`-Container im Subtree füllen.
  // Wird intern nach jeder Partial-Injektion gerufen — Cascade endet, wenn
  // ein Pass nichts mehr findet (Schutzlimit 5 gegen Zirkularität).
  async _cascadePartialsInside(root) {
    let safety = 5;
    while (safety-- > 0) {
      const empty = [...root.querySelectorAll('[id^="partial-"]')]
        .filter(el => el.childElementCount === 0);
      if (empty.length === 0) return;
      await Promise.all(empty.map(async el => {
        try {
          await this._injectPartial(el, el.id.replace(/^partial-/, ''));
        } catch (e) {
          console.error(`[cascadePartial:${el.id}]`, e);
        }
      }));
    }
  },

  // Helper: fetcht Partial, injiziert in Element, initialisiert Alpine.
  // Fragment-Includes werden VOR dem innerHTML-Set string-seitig aufgelöst —
  // anders als der DOM-Placeholder-Mechanismus (`<div id="partial-X">`) greift
  // das auch INNERHALB von `<template>`/`x-for` (querySelector steigt nicht in
  // Template-Content ab). So bleibt geteiltes Markup (z.B. die Plot-Beat-Karte
  // in flachem + Grid-Board) an EINER Stelle. Siehe `_resolveIncludes`.
  async _injectPartial(el, name) {
    let html = await fetchText(`/partials/${name}.html`);
    html = await this._resolveIncludes(html);
    el.innerHTML = html;
    Alpine.initTree(el);
  },

  // String-seitige Fragment-Includes: ersetzt jeden Marker `<!-- @include NAME -->`
  // durch den Inhalt von `/partials/NAME.html` (rekursiv; jeder Name pro Pass nur
  // einmal gefetcht). Reines Text-Splicing vor jeglichem DOM/Alpine-Processing —
  // der eingefügte Markup-Block ist danach Teil des Template-Contents und wird pro
  // x-for-Iteration normal geklont.
  // `seen` bricht Selbst-/Zyklen-Referenzen by name ab: enthält ein Fragment einen
  // Marker auf sich selbst (z.B. in einem Doku-Kommentar), wird der zu '' aufgelöst
  // statt N-fach expandiert zu werden.
  async _resolveIncludes(html, seen = new Set()) {
    const re = /<!--\s*@include\s+([\w-]+)\s*-->/g;
    const matches = [...html.matchAll(re)];
    if (!matches.length) return html;
    const cache = {};
    for (const m of matches) {
      const frag = m[1];
      if (frag in cache) continue;
      if (seen.has(frag)) { cache[frag] = ''; continue; }
      cache[frag] = await this._resolveIncludes(
        await fetchText(`/partials/${frag}.html`),
        new Set([...seen, frag]),
      );
    }
    return html.replace(re, (_, frag) => cache[frag] ?? '');
  },
};
