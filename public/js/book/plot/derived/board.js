// Plot-Werkstatt — abgeleitete Reads (Teil 1): Beats/Stats, Figuren-Picker,
// Stränge/Swimlanes, Hybrid-Akte, Grid-Render-Plan, Live-Vererbung, Akt-Farben.
// Reine Compute aus Board-State (memoized), keine Server-Mutationen.

import { STATUSES, DIST_SEGMENTS, ACT_PALETTE, BEAT_REL_TYPES, classifyBeatAnchor } from '../constants.js';

export const boardMethods = {
  // ── Derived (memoized) ──────────────────────────────────────────────────────
  beatsForAct(actId) {
    return this._memo(`beats:${actId}`, [this.beats, actId], () =>
      (this.beats || [])
        .filter(b => b.act_id === actId)
        .sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id))
    );
  },

  // Beats einer Grid-Zelle (Akt × Strang). threadId === null = „ohne Strang"-Lane.
  // Im Grid-Pfad das Pendant zu beatsForAct.
  beatsForCell(actId, threadId) {
    const tid = threadId == null ? null : threadId;
    return this._memo(`cell:${actId}:${tid}`, [this.beats, actId, tid], () =>
      (this.beats || [])
        .filter(b => b.act_id === actId && (b.thread_id ?? null) === tid)
        .sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id))
    );
  },

  boardStats() {
    return this._memo('stats', [this.beats], () => this._computeStats(this.beats || []));
  },

  // Status-Zählung über eine Beat-Liste (board-weit oder pro Akt). geplant/im_buch
  // zählen nur aktive (nicht verworfene) Beats; verworfen ist eine eigene Achse
  // (Flag) und wird separat gezählt — die drei Segmente summieren sich zu total.
  // imBuch/geplant bleiben als Top-Level-Felder erhalten (von plot.stats-i18n konsumiert).
  _computeStats(list) {
    const by = { geplant: 0, im_buch: 0, verworfen: 0 };
    for (const b of list) {
      if (b.verworfen) by.verworfen++;
      else if (by[b.status] != null) by[b.status]++;
    }
    return { total: list.length, by, imBuch: by.im_buch, geplant: by.geplant };
  },

  // Pro-Akt-Status-Verteilung (für die Mini-Fortschrittsleiste im Spaltenkopf).
  actStats(actId) {
    return this._memo(`astats:${actId}`, [this.beats, actId], () =>
      this._computeStats((this.beats || []).filter(b => b.act_id === actId)));
  },

  statusList() { return STATUSES; },

  // Segmente der board-weiten/akt-weiten Verteilungsleiste (zwei Status + die
  // Verwerfen-Achse). Eigene Liste, damit die Edit-Status-Tabs binär bleiben.
  distStatusList() { return DIST_SEGMENTS; },

  // Die Figuren-Auswahl läuft über EINE `combobox` mit zwei opt-Gruppen
  // (Katalog + Werkstatt, Präfix fig:/draft:) — Markup + addBeatFigureLink in
  // plot-beat-cell.html / beats.js. Die Chips darunter lesen die Labels hier.

  // Aktuell gewählte Katalog-Figuren des Edit-Drafts als entfernbare Chips.
  beatFigureChips() {
    const byId = window.__app?.figurenById;
    return (this.beatDraft.figure_ids || []).map(id => ({ id, label: byId?.get(id)?.kurzname || byId?.get(id)?.name || id }));
  },

  // Aktuell gewählte Werkstatt-Figuren des Edit-Drafts als entfernbare Chips.
  beatWerkstattChips() {
    return (this.beatDraft.draft_figure_ids || []).map(id => ({ id, label: this.draftFigurenById?.get(id)?.name || id }));
  },

  // Motiv-Picker-Optionen (entityPicker entity 'custom'): der Motiv-Katalog als
  // { value, label, group }, gruppiert nach Thema (Gruppen in Themen-Position-
  // Reihenfolge, „Ohne Thema" ans Ende, innerhalb nach Motiv-Name). Optionen eines
  // Themas müssen zusammenhängend liegen (combobox groupt zusammenhängende Läufe) —
  // darum Sort nach _ord → group → label. Read-Quellen motifsCatalog/themesCatalog
  // werden inline berührt, damit die reaktiven Deps im Getter erhalten bleiben.
  beatMotifOptions() {
    const order = new Map();
    (this.themesCatalog || []).forEach((t, i) => order.set(t.id, i));
    const themeName = new Map((this.themesCatalog || []).map(t => [t.id, t.name]));
    const noGroup = window.__app?.t('plot.beat.motifNoTheme') || '—';
    const rows = (this.motifsCatalog || []).map(m => {
      const hasTheme = m.theme_id != null && themeName.has(m.theme_id);
      return {
        value: m.id,
        label: m.name,
        group: hasTheme ? themeName.get(m.theme_id) : noGroup,
        _ord: hasTheme ? order.get(m.theme_id) : Number.MAX_SAFE_INTEGER,
      };
    });
    rows.sort((a, b) => (a._ord - b._ord) || a.group.localeCompare(b.group) || a.label.localeCompare(b.label));
    return rows;
  },

  // Aktuell gewählte Motive des Edit-Drafts als entfernbare Chips.
  beatMotifChips() {
    const byId = new Map((this.motifsCatalog || []).map(m => [m.id, m]));
    return (this.beatDraft.motif_ids || []).map(id => ({ id, label: byId.get(id)?.name || id }));
  },

  // ── Stränge (Swimlanes, Derived) ───────────────────────────────────────────
  // Zeilen des Grids: Stränge in Position-Reihenfolge + die „ohne Strang"-Lane
  // (id null) immer am Ende — sie ist Drop-Ziel zum Entkoppeln und fängt alle
  // nicht zugeordneten Beats.
  threadLanes() {
    return this._memo('lanes', [this.threads], () => {
      const rows = [...(this.threads || [])]
        .sort((a, b) => a.position - b.position)
        .map(t => ({ id: t.id, thread: t, isDefault: false }));
      rows.push({ id: null, thread: null, isDefault: true });
      return rows;
    });
  },

  // ── Archiv (Derived) ────────────────────────────────────────────────────────
  // Ein archivierter Akt ist abgeschlossen (seine Beats sind eingearbeitet) und
  // verlässt die Board-Spalten, bis der Archiv-Schalter (plotShowArchived) ihn
  // wieder einblendet. Das Flag wirkt AUSSCHLIESSLICH auf die Spalten-Sichtbarkeit:
  // seine Beats bleiben in boardStats/actStats, im Spannungsbogen, in der
  // Kapitel-/Figuren-Coverage und in der Beat-Verankerung — sie stehen im Buch.
  // Deshalb filtert keine der beatsFor*-Methoden nach Archiv.
  _actVisible(act) {
    return !!this.plotShowArchived || !(act && act.archiviert);
  },

  // Wie viele Akte liegen im Archiv (über alle Scopes)? Treibt Sichtbarkeit +
  // Label des Archiv-Schalters.
  archivedActCount() {
    return this._memo('archActs', [this.acts], () =>
      (this.acts || []).filter(a => a.archiviert).length);
  },

  // ── Hybrid-Akte (Derived) ───────────────────────────────────────────────────
  // Geteilte Akte (thread_id NULL) — die Spalten des flachen Boards und aller
  // Stränge ohne eigene Aktstruktur. Archiv-gefiltert: das IST die Render-Quelle
  // beider Boards. Im flachen Board sind alle Akte geteilt (ein strang-eigener
  // Akt kann ohne Strang nicht existieren, plot_acts.thread_id CASCADEt), darum
  // braucht es dort keine zweite, scope-blinde Liste.
  sharedActs() {
    return this._memo('sharedActs', [this.acts, this.plotShowArchived], () =>
      (this.acts || []).filter(a => a.thread_id == null && this._actVisible(a)).sort((a, b) => a.position - b.position));
  },

  // Strang-eigene Akte (thread_id === threadId), positionsgeordnet, archiv-gefiltert.
  actsForThread(threadId) {
    return this._memo(`tacts:${threadId}`, [this.acts, threadId, this.plotShowArchived], () =>
      (this.acts || []).filter(a => a.thread_id === threadId && this._actVisible(a)).sort((a, b) => a.position - b.position));
  },

  // Hat der Strang eine eigene Aktstruktur (≥1 strang-eigener Akt)? Aus den Daten
  // abgeleitet — kein Flag (kein Drift). Für null (ohne Strang) immer false.
  // ABSICHTLICH ungefiltert nach Archiv: sind alle eigenen Akte archiviert, hat
  // der Strang weiterhin eine eigene Struktur — sonst kippte er im Grid zurück in
  // die geteilte Region und seine Beats hingen an Akten, die dort nicht stehen.
  _threadHasOwn(threadId) {
    return threadId != null && (this.acts || []).some(a => a.thread_id === threadId);
  },
  threadHasOwnActs(threadId) { return this._threadHasOwn(threadId); },

  // Render-Plan des Grids als flache Zeilen-Deskriptoren (eine x-for-Schleife im
  // Partial, je Deskriptor ein Header- ODER Lane-Block). So bleibt das (grosse)
  // Beat-Zell-Markup an EINER Stelle, obwohl geteilte Lanes und strang-eigene
  // Blöcke unterschiedliche Spalten-Sets (acts) tragen:
  //   - Geteilte Region: ein Header (sharedActs) + alle Lanes ohne eigene Akte
  //     (inkl. „ohne Strang") — Spalten richten sich aus.
  //   - Pro Strang mit eigener Aktstruktur: ein eigener Header (seine Akte) + seine
  //     Lane darunter (eigene Spaltenzahl, nicht ausgerichtet — gewollt).
  // kind: 'header' → { acts, thread } ; kind: 'lane' → { lane, acts }.
  gridRows() {
    return this._memo('gridRows', [this.acts, this.threads, this.plotShowArchived], () => {
      const lanes = this.threadLanes();
      const shared = this.sharedActs();
      const rows = [];
      const sharedLanes = lanes.filter(l => l.isDefault || !this._threadHasOwn(l.id));
      if (sharedLanes.length) {
        rows.push({ kind: 'header', key: 'h:shared', acts: shared, thread: null });
        for (const l of sharedLanes) rows.push({ kind: 'lane', key: `l:${l.id ?? 'none'}`, lane: l, acts: shared });
      }
      for (const l of lanes) {
        if (l.isDefault || !this._threadHasOwn(l.id)) continue;
        const own = this.actsForThread(l.id);
        rows.push({ kind: 'header', key: `h:${l.id}`, acts: own, thread: l.thread });
        rows.push({ kind: 'lane', key: `l:${l.id}`, lane: l, acts: own });
      }
      return rows;
    });
  },

  // CSS-Akzent eines Strangs (gleiche Palette-Whitelist wie actAccent).
  threadAccent(thread) {
    const key = thread && thread.farbe;
    return (key && ACT_PALETTE.includes(key)) ? `var(--palette-${key})` : 'var(--card-accent)';
  },

  // Anzeigename der an den Strang gebundenen Figur (Katalog via fig_id, sonst
  // Werkstatt via draft_figure_id). Leer, wenn keine Figur gebunden.
  threadFigureLabel(thread) {
    if (!thread) return '';
    if (thread.fig_id) {
      const f = window.__app.figurenById?.get(thread.fig_id);
      return f ? (f.kurzname || f.name) : '';
    }
    if (thread.draft_figure_id) {
      const d = this.draftFigurenById?.get(thread.draft_figure_id);
      return d ? d.name : '';
    }
    return '';
  },

  // ── Live-Vererbung Strang → Beat ────────────────────────────────────────────
  // Ein Beat in einer Strang-Lane erbt implizit die Hauptfigur + das Kapitel des
  // Strangs (nie auf dem Beat gespeichert — rein Anzeige + KI-Kontext). Eigene
  // Beat-Werte haben Vorrang: die Strang-Figur wird nur als geerbter Zusatz
  // gezeigt, das Strang-Kapitel nur, wenn der Beat kein eigenes Kapitel hat.
  // O(1)-Lookup id→Strang (Referenz-Wechsel-Cache wie $app.figurenById). Als
  // Methode statt Card-Getter, damit alle reinen Methods-Module sie teilen können —
  // Object-Spread überträgt keine Getter (ein Getter müsste auf der Card leben und
  // wäre den Sub-Modulen + Unit-Tests unsichtbar). SSoT für den Strang-Lookup.
  _threadById(id) {
    if (this._threadMapRef !== this.threads) {
      this._threadMapRef = this.threads;
      this._threadMap = new Map((this.threads || []).map(t => [t.id, t]));
    }
    return this._threadMap.get(id) || null;
  },

  _threadOf(beat) {
    const tid = beat && beat.thread_id;
    if (tid == null) return null;
    // O(1) über _threadById — nicht linear scannen. effectiveChapterNameForBeat
    // (SSoT) läuft pro Beat im Filter + über alle Beats in plotCoverage; ein
    // .find() hier machte das O(beats × threads).
    return this._threadById(tid);
  },

  // Vom Strang geerbte Figur als { kind:'catalog'|'werkstatt', id, label } —
  // oder null, wenn kein Strang, keine gebundene Figur, oder der Beat sie bereits
  // explizit führt (keine Doppelanzeige).
  inheritedFigureForBeat(beat) {
    const t = this._threadOf(beat);
    if (!t) return null;
    if (t.fig_id) {
      if ((beat.fig_ids || []).includes(t.fig_id)) return null;
      const f = window.__app.figurenById?.get(t.fig_id);
      return { kind: 'catalog', id: t.fig_id, label: f ? (f.kurzname || f.name) : t.fig_id };
    }
    if (t.draft_figure_id) {
      if ((beat.draft_fig_ids || []).map(String).includes(String(t.draft_figure_id))) return null;
      const d = this.draftFigurenById?.get(t.draft_figure_id);
      return { kind: 'werkstatt', id: t.draft_figure_id, label: d ? d.name : t.draft_figure_id };
    }
    return null;
  },

  // Vom Strang geerbter Kapitelname — nur wenn der Beat kein eigenes Kapitel hat
  // und der Strang eines bindet. Leer sonst.
  inheritedChapterForBeat(beat) {
    if (beat.chapter_id) return '';
    const t = this._threadOf(beat);
    return (t && t.chapter_name) ? t.chapter_name : '';
  },

  // Effektiver Kapitelname eines Beats: eigenes hat Vorrang, sonst das vom Strang
  // geerbte. SSoT für alle Aggregationen (Coverage, Filter), die mit „dem Kapitel
  // des Beats" arbeiten — sonst widerspricht das gezeigte geerbte Badge dem, was
  // Coverage/Filter melden.
  effectiveChapterNameForBeat(beat) {
    return beat.chapter_name || this.inheritedChapterForBeat(beat) || '';
  },

  // ── Akt-Farben (Derived) ───────────────────────────────────────────────────
  actPalette() { return ACT_PALETTE; },

  // CSS-Wert für den Akt-Akzent: bekannter Palette-Key → --palette-<key>,
  // sonst Karten-Akzent. Whitelist verhindert CSS-Injection aus dem Freitextfeld.
  actAccent(act) {
    const key = act && act.farbe;
    return (key && ACT_PALETTE.includes(key)) ? `var(--palette-${key})` : 'var(--card-accent)';
  },

  // CSS-Akzent eines Motiv-Badges auf der Beat-Karte: bekannter Palette-Key
  // (eigene Motiv- oder geerbte Themen-Farbe) → --palette-<key>, sonst der
  // Motiv-Werkstatt-Akzent. Whitelist verhindert CSS-Injection.
  motifAccent(m) {
    const key = m && m.farbe;
    return (key && ACT_PALETTE.includes(key)) ? `var(--palette-${key})` : 'var(--card-accent-motiv)';
  },

  // ── Beat-Verankerung (Soll status vs. Ist-Fundstellen aus plot_beat_occurrences) ──
  // Klassifikation via reiner Funktion (constants.js, unit-getestet). Der Server
  // hängt occ_count + occ_top an jeden Beat (routes/plot.js). 'none' → kein Badge.
  beatAnchorState(beat) {
    return classifyBeatAnchor(beat && beat.status, beat && beat.occ_count, beat && beat.verworfen);
  },

  // ── Beat-zu-Beat-Beziehungen (Kausalität + Setup/Payoff) ────────────────────
  // Kuratierte Typ-Auswahl fürs Beziehungs-Picker (stabile Schlüssel, Reihenfolge).
  relationTypes() { return BEAT_REL_TYPES; },

  // i18n-Label eines Beziehungstyps (Freitext-Fallback für Alt-Typen ohne Key).
  relTypeLabel(typ) {
    const app = window.__app;
    const key = 'plot.relation.type.' + typ;
    const label = app.t(key);
    return label === key ? typ : label;
  },

  // Ausgehende Kanten eines Beats (from_beat_id === beat.id), lesefertig mit
  // Ziel-Titel (aus dem Payload-JOIN) — read-only Badges + Edit-Chips.
  beatRelationsOut(beat) {
    if (!beat) return [];
    return this._memo(`relOut:${beat.id}`, [this.relations, beat.id], () =>
      (this.relations || []).filter(r => r.from_beat_id === beat.id));
  },

  // Ziel-Beat-Optionen fürs Beziehungs-Picker: alle anderen Beats (nicht der Beat
  // selbst) als { value: id, label: titel }. Verworfene werden mit Marker gezeigt.
  relTargetOptions(beat) {
    if (!beat) return [];
    return this._memo(`relTargets:${beat.id}`, [this.beats, beat.id], () =>
      (this.beats || [])
        .filter(b => b.id !== beat.id)
        .map(b => ({ value: b.id, label: b.titel + (b.verworfen ? ' (verworfen)' : '') })));
  },

  // Tooltip des Anchor-Badges: Zustands-Satz + die Top-Fundstellen (Seitenname).
  beatAnchorTip(beat) {
    const app = window.__app;
    const state = this.beatAnchorState(beat);
    if (state === 'none') return '';
    const head = app.t('plot.anchor.state.' + state, { n: beat.occ_count || 0 });
    // Klickbare Zustände (Fundstellen vorhanden): Hinweis aufs Popover statt einer
    // langen Namensliste im Tooltip. 'drift' (kein Fund) bleibt beim reinen Satz.
    if (beat.occ_count) return `${head} — ${app.t('plot.anchor.popover.hint')}`;
    return head;
  },
};
