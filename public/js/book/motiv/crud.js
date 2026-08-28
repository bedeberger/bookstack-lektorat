// Motiv-Werkstatt — CRUD für Themen, Motive, Beziehungen und Soll-Verknüpfungen,
// plus Auswahl + Fundstellen-Laden. Nach jeder Mutation lokalen State + Graph
// aktualisieren (loadBoard) statt Teil-Patches — die Boards sind klein.

import { fetchJson, sendJson } from '../../utils.js';
import { THEME_COLOR_KEYS, defaultThemeColorKey } from './graph.js';
import { highlightOccurrenceOnPage } from './highlight.js';
import { MOTIF_REL_TYPES } from './constants.js';

export const crudMethods = {
  _bookId() { return this.$store.nav.selectedBookId; },

  // Panel-weite Tastaturkürzel (am Karten-Root, damit sie auch bei Fokus im Graph/
  // Chip greifen): Cmd/Ctrl+S speichert das gewählte Motiv bzw. Thema, Escape verwirft
  // ungespeicherte Änderungen — oder schliesst den Editor, wenn nichts dirty ist.
  // Combobox/EntityPicker konsumieren Escape selbst, solange ihr Dropdown offen ist
  // (stopPropagation dort), und offene Popover/Menüs regeln ihr Escape ebenfalls selbst.
  onPanelKeydown(event) {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && !event.shiftKey && !event.altKey && (event.key === 's' || event.key === 'S')) {
      event.preventDefault();
      if (this.selectedMotif()) this.saveMotifEdit();
      else if (this.selectedTheme()) this.saveThemeEdit();
      return;
    }
    if (event.key === 'Escape') {
      if (this.graphMenuOpen || this.themeColorPickerId != null) return;
      if (this.selectedMotif()) { event.preventDefault(); this.escMotifEdit(); }
      else if (this.selectedTheme()) { event.preventDefault(); this.escThemeEdit(); }
    }
  },
  // Escape im Motiv-Editor: ungespeicherte Änderungen verwerfen, sonst Editor schliessen.
  async escMotifEdit() {
    if (this.motifDirty()) { this.cancelMotifEdit(); return; }
    await this.selectMotif(null);
  },
  // Escape im Themen-Editor: analog (verwerfen → sonst zurück zur Themen-Liste).
  async escThemeEdit() {
    if (this.themeDirty()) { this.cancelThemeEdit(); return; }
    await this.deselectTheme();
  },

  // ── Themen ─────────────────────────────────────────────────────────────
  // Namensfeld des Themen-Editors fokussieren (nach Anlegen) — der Editor ist erst
  // nach dem Reflow (selectTheme → x-if) im DOM; sonst No-Op.
  _focusThemeNameInput() {
    this.$nextTick(() => {
      const el = this.$root?.querySelector('.motiv-theme-name-input');
      if (el) { el.focus(); el.select(); }
    });
  },
  async addTheme() {
    const name = (this.newThemeName || '').trim();
    if (!name) return;
    this.busy = true;
    try {
      const theme = await sendJson('/motifs/themes', 'POST', { book_id: this._bookId(), name });
      this.newThemeName = '';
      await this.loadBoard();
      await this.selectTheme(theme.id);
      this._focusThemeNameInput();
    } catch (e) { this.errorMessage = window.__app.t('motiv.error.save'); }
    finally { this.busy = false; }
  },
  async deleteTheme(theme) {
    if (!window.confirm(window.__app.t('motiv.theme.confirmDelete', { name: theme.name }))) return;
    try {
      await sendJson(`/motifs/themes/${theme.id}`, 'DELETE');
      if (this.selectedThemeId === theme.id) { this.selectedThemeId = null; this._loadThemeBuffer(null); }
      await this.loadBoard();
    } catch (e) { this.errorMessage = window.__app.t('motiv.error.save'); }
  },

  // Themen-Editor: Kern-Felder (Name/Beschreibung) mit explizitem Save/Cancel wie der
  // Motiv-Editor. Farbe bleibt Sofort-Aktion (setThemeColor), unabhängig vom Puffer.
  _loadThemeBuffer(t) {
    this.editThemeName = t ? (t.name || '') : '';
    this.editThemeBeschreibung = t ? (t.beschreibung || '') : '';
  },
  themeDirty() {
    const t = this.selectedTheme();
    if (!t) return false;
    return (this.editThemeName || '').trim() !== (t.name || '')
      || (this.editThemeBeschreibung || '') !== (t.beschreibung || '');
  },
  cancelThemeEdit() { this._loadThemeBuffer(this.selectedTheme()); },
  async saveThemeEdit() {
    const t = this.selectedTheme();
    if (!t || !this.themeDirty()) return;
    const name = (this.editThemeName || '').trim();
    if (!name) { this.errorMessage = window.__app.t('motiv.error.nameRequired'); return; }
    this.busy = true;
    try {
      await sendJson(`/motifs/themes/${t.id}`, 'PATCH', { name, beschreibung: this.editThemeBeschreibung || '' });
      await this.loadBoard();
      this._loadThemeBuffer(this.selectedTheme());
      this.errorMessage = '';
    } catch (e) { this.errorMessage = window.__app.t('motiv.error.save'); }
    finally { this.busy = false; }
  },
  // Ausstehende Puffer-Änderungen des gewählten Themas committen (Wechsel/Schliessen =
  // Save, kein stilles Verwerfen). Leerer Name verwirft nur die Umbenennung.
  async _commitPendingThemeEdit() {
    const t = this.selectedTheme();
    if (!t || !this.themeDirty()) return;
    if (!(this.editThemeName || '').trim()) this.editThemeName = t.name;
    await this.saveThemeEdit();
  },
  // Vor jedem Auswahl-Wechsel BEIDE Panel-Editoren (Motiv + Thema) committen. Gibt
  // false zurück, wenn ein Save fehlschlug (Puffer bleibt dirty) → der Aufrufer bricht
  // ab und behält die aktuelle Auswahl, statt Änderungen still zu verwerfen. Motiv-
  // und Themen-Editor sind im Panel exklusiv (nur einer ist je dirty); beide zu
  // committen ist billig und macht die Reihenfolge egal. SSoT für selectMotif/
  // selectTheme/deselectTheme.
  async _commitPendingEdits() {
    await this._commitPendingMotifEdit();
    if (this.motifDirty()) return false;
    await this._commitPendingThemeEdit();
    if (this.themeDirty()) return false;
    return true;
  },
  // Thema auswählen → Editor im Panel. Gegenseitig exklusiv zur Motiv-Auswahl.
  // Re-Select derselben ID lädt den Puffer nicht neu (Edits überleben).
  async selectTheme(id) {
    const sameId = !!id && id === this.selectedThemeId;
    if (!sameId && !(await this._commitPendingEdits())) return;
    this.selectedMotifId = null;
    this.selectedThemeId = id;
    if (!sameId) this._loadThemeBuffer(this.themeById(id));
  },
  // Themen-Editor schliessen → zurück zur Themen-Liste (committet ausstehende Edits).
  async deselectTheme() {
    if (!(await this._commitPendingEdits())) return;
    this.selectedThemeId = null;
  },
  // Palette-Schlüssel für den Farbwähler (theme-aware --palette-*-Tokens).
  themeColorKeys() { return THEME_COLOR_KEYS; },
  // Effektiver Palette-Schlüssel eines Themas (gewählt oder Auto nach Index) —
  // SSoT für die Swatch-Leiste, deckungsgleich mit der Graph-Farbe.
  themeSwatchKey(theme) {
    return theme.farbe || defaultThemeColorKey(this.themes.findIndex(t => t.id === theme.id));
  },
  toggleThemeColorPicker(themeId) {
    this.themeColorPickerId = this.themeColorPickerId === themeId ? null : themeId;
  },
  // Thema-Farbe setzen (key aus der Palette oder null = Auto nach Index). Optimistisch
  // lokal spiegeln, damit Graph + Swatch ohne Reload umfärben; loadBoard bestätigt.
  async setThemeColor(theme, key) {
    this.themeColorPickerId = null;
    const farbe = THEME_COLOR_KEYS.includes(key) ? key : null;
    if (farbe === (theme.farbe || null)) return;
    theme.farbe = farbe;
    try { await sendJson(`/motifs/themes/${theme.id}`, 'PATCH', { farbe }); await this.loadBoard(); }
    catch (e) { this.errorMessage = window.__app.t('motiv.error.save'); }
  },

  // ── Motive ─────────────────────────────────────────────────────────────
  async addMotif() {
    const name = (this.newMotifName || '').trim();
    if (!name) return;
    this.busy = true;
    try {
      const body = { book_id: this._bookId(), name };
      if (this.newMotifThemeId) body.theme_id = Number(this.newMotifThemeId);
      const m = await sendJson('/motifs', 'POST', body);
      this.newMotifName = '';
      await this.loadBoard();
      await this.selectMotif(m.id);
      this.$nextTick(() => this.$root?.querySelector('.motiv-name-input')?.focus());
    } catch (e) { this.errorMessage = window.__app.t('motiv.error.save'); }
    finally { this.busy = false; }
  },
  // Motiv direkt anlegen (aus dem Graph-Kontextmenü) — mit Default-Namen, optional
  // einem Thema zugeordnet, danach im Panel selektiert + Namensfeld fokussiert zum
  // sofortigen Umbenennen.
  async createMotifAt(themeId) {
    this.closeGraphMenu();
    this.busy = true;
    try {
      const body = { book_id: this._bookId(), name: window.__app.t('motiv.motif.newName') };
      if (themeId) body.theme_id = Number(themeId);
      const m = await sendJson('/motifs', 'POST', body);
      await this.loadBoard();
      await this.selectMotif(m.id);
      this.$nextTick(() => { const el = this.$root?.querySelector('.motiv-name-input'); if (el) { el.focus(); el.select(); } });
    } catch (e) { this.errorMessage = window.__app.t('motiv.error.save'); }
    finally { this.busy = false; }
  },
  // Thema direkt anlegen (aus dem Graph-Kontextmenü) — mit Default-Namen; danach im
  // Panel-Editor selektiert + Namensfeld fokussiert zum sofortigen Umbenennen.
  async createThemeQuick() {
    this.closeGraphMenu();
    this.busy = true;
    try {
      const theme = await sendJson('/motifs/themes', 'POST', { book_id: this._bookId(), name: window.__app.t('motiv.theme.newName') });
      await this.loadBoard();
      await this.selectTheme(theme.id);
      this._focusThemeNameInput();
    } catch (e) { this.errorMessage = window.__app.t('motiv.error.save'); }
    finally { this.busy = false; }
  },

  // Edit-Puffer der Kern-Felder aus dem Motiv füllen (bei Auswahl/Cancel/Reload).
  _loadMotifBuffer(m) {
    this.editName = m ? (m.name || '') : '';
    this.editThemeId = m && m.theme_id ? String(m.theme_id) : '';
    this.editBeschreibung = m ? (m.beschreibung || '') : '';
    this.editTriggers = m ? (m.trigger_terms || []).join(', ') : '';
  },
  // Trigger-Puffer (Komma-Text) auf die kanonische Term-Liste normalisieren.
  _bufferTriggerTerms() {
    return (this.editTriggers || '').split(',').map(s => s.trim()).filter(Boolean);
  },
  // Ungespeicherte Änderungen an den Kern-Feldern (Name/Thema/Beschreibung/Trigger)?
  _coreDirty() {
    const m = this.selectedMotif();
    if (!m) return false;
    const tid = this.editThemeId ? Number(this.editThemeId) : null;
    return (this.editName || '').trim() !== (m.name || '')
      || tid !== (m.theme_id || null)
      || (this.editBeschreibung || '') !== (m.beschreibung || '')
      || this._bufferTriggerTerms().join(', ') !== (m.trigger_terms || []).join(', ');
  },
  // Ungespeicherte Änderungen am Motiv gesamt (Kern-Felder ODER Soll-Verknüpfungen)?
  // Steuert Sichtbarkeit des einen Save/Cancel-Icons in der Titelzeile — es erscheint
  // also auch, sobald eine Combobox-Auswahl eine Verknüpfung in den Puffer legt.
  motifDirty() {
    return this._coreDirty() || this.linksDirty();
  },
  // Alle Puffer (Kern-Felder + Verknüpfungen) auf den gespeicherten Motivstand zurücksetzen.
  cancelMotifEdit() {
    const m = this.selectedMotif();
    this._loadMotifBuffer(m);
    this._loadLinkBuffer(m);
  },
  // Motiv speichern: geänderte Kern-Felder als PATCH und/oder geänderte Soll-Links
  // als Full-Replace-PUT — ein Save-Button für beides, danach ein loadBoard.
  async saveMotifEdit() {
    const m = this.selectedMotif();
    if (!m || !this.motifDirty()) return;
    const coreDirty = this._coreDirty();
    const linksDirty = this.linksDirty();
    const name = (this.editName || '').trim();
    if (coreDirty && !name) { this.errorMessage = window.__app.t('motiv.error.nameRequired'); return; }
    this.busy = true;
    try {
      if (coreDirty) {
        await sendJson(`/motifs/${m.id}`, 'PATCH', {
          name,
          theme_id: this.editThemeId ? Number(this.editThemeId) : null,
          beschreibung: this.editBeschreibung || '',
          trigger_terms: this._bufferTriggerTerms(),
        });
      }
      if (linksDirty) {
        await sendJson(`/motifs/${m.id}/links`, 'PUT', {
          figures: this.editFigures.map(f => f.figId),
          draftFigures: this.editDraftFigures.map(f => f.id),
          beats: this.editBeats.map(b => b.id),
          chapters: this.editChapters.map(c => c.id),
          pages: this.editPages.map(p => p.id),
        });
      }
      await this.loadBoard();
      const sel = this.selectedMotif();
      this._loadMotifBuffer(sel);
      this._loadLinkBuffer(sel);
      this.errorMessage = '';
    } catch (e) { this.errorMessage = window.__app.t('motiv.error.save'); }
    finally { this.busy = false; }
  },
  async deleteMotif(motif) {
    if (!window.confirm(window.__app.t('motiv.motif.confirmDelete', { name: motif.name }))) return;
    try {
      await sendJson(`/motifs/${motif.id}`, 'DELETE');
      if (this.selectedMotifId === motif.id) { this.selectedMotifId = null; this.occurrences = []; }
      await this.loadBoard();
    } catch (e) { this.errorMessage = window.__app.t('motiv.error.save'); }
  },

  // ── Beziehungen (Motiv ↔ Motiv) ──────────────────────────────────────────
  // Kuratierte Typ-Auswahl fürs Beziehungs-Picker (stabile Schlüssel, Reihenfolge).
  // Freitext-Alt-Kanten bleiben lesbar: motifRelLabel fällt auf den rohen Wert zurück.
  motifRelTypes() { return MOTIF_REL_TYPES; },

  motifRelLabel(typ) {
    const key = 'motiv.relation.type.' + typ;
    const label = window.__app.t(key);
    return label === key ? typ : label;
  },

  async addRelation() {
    const from = this.selectedMotifId;
    const to = this.newRelationTargetId ? Number(this.newRelationTargetId) : null;
    const typ = (this.newRelationTyp || '').trim();
    if (!from || !to || from === to || !typ) return;
    try {
      await sendJson('/motifs/relations', 'POST', { from_motif_id: from, to_motif_id: to, typ });
      this.newRelationTargetId = '';
      this.newRelationTyp = '';
      await this.loadBoard();
    } catch (e) { this.errorMessage = window.__app.t('motiv.error.save'); }
  },
  async deleteRelation(rel) {
    try { await sendJson(`/motifs/relations/${rel.id}`, 'DELETE'); await this.loadBoard(); }
    catch (e) { this.errorMessage = window.__app.t('motiv.error.save'); }
  },
  // Beziehungen, die das gewählte Motiv berühren (mit Richtungs-/Partner-Label).
  relationsForSelected() {
    const id = this.selectedMotifId;
    if (!id) return [];
    return this.relations
      .filter(r => r.from_motif_id === id || r.to_motif_id === id)
      .map(r => {
        const otherId = r.from_motif_id === id ? r.to_motif_id : r.from_motif_id;
        const other = this.motifById(otherId);
        return { ...r, outgoing: r.from_motif_id === id, otherName: other ? other.name : '?' };
      });
  },

  // ── Soll-Verknüpfungen (explizit gespeichert via Save/Cancel, kein Auto-Save) ─
  // Die Chips bearbeiten lokale Puffer (editFigures/…); erst saveMotifEdit() schickt
  // den Full-Replace aller fünf Brücken (ein Motiv-Save deckt Kern-Felder + Links).
  // kind (figures|draftFigures|beats|chapters|pages) → Puffer-Property.
  _linkBufKey(kind) {
    return { figures: 'editFigures', draftFigures: 'editDraftFigures', beats: 'editBeats', chapters: 'editChapters', pages: 'editPages' }[kind];
  },
  // Identitäts-Property im Puffer-Item: Katalog-Figuren tragen die TEXT-fig_id als
  // `figId`, alle übrigen Brücken die INTEGER-`id`.
  _linkIdKey(kind) { return kind === 'figures' ? 'figId' : 'id'; },
  // Verknüpfungs-Puffer aus dem Motiv füllen (bei Auswahl/Cancel/nach Save). Kopien,
  // damit Chip-Mutationen den Board-State nicht anfassen, bevor gespeichert wird.
  _loadLinkBuffer(m) {
    this.editFigures = m ? (m.figures || []).map(x => ({ ...x })) : [];
    this.editDraftFigures = m ? (m.draftFigures || []).map(x => ({ ...x })) : [];
    this.editBeats = m ? (m.beats || []).map(x => ({ ...x })) : [];
    this.editChapters = m ? (m.chapters || []).map(x => ({ ...x })) : [];
    this.editPages = m ? (m.pages || []).map(x => ({ ...x })) : [];
  },
  // Figuren-Combobox mischt zwei Quellen; der Auswahl-Wert trägt ein Präfix
  // (fig:<fig_id> = Komplettanalyse, draft:<id> = Plotwerkstatt) → richtige Brücke.
  addFigureLink(val) {
    if (val == null || val === '') return;
    const s = String(val);
    if (s.startsWith('draft:')) this.addLink('draftFigures', s.slice(6));
    else this.addLink('figures', s.startsWith('fig:') ? s.slice(4) : s);
  },
  // Verknüpfung im Puffer hinzufügen/entfernen (kein Persist — erst saveMotifEdit).
  toggleLink(kind, item) {
    if (!this.selectedMotif()) return;
    const idKey = this._linkIdKey(kind);
    const arr = this[this._linkBufKey(kind)];
    const ix = arr.findIndex(x => x[idKey] === item[idKey]);
    if (ix >= 0) arr.splice(ix, 1);
    else arr.push(item);
  },
  // Verknüpfung per Auswahl-Wert (Combobox) in den Puffer legen — Item aus der Quelle auflösen.
  addLink(kind, idVal) {
    if (!this.selectedMotif() || idVal == null || idVal === '') return;
    let item = null;
    if (kind === 'figures') {
      // Katalog-Figuren tragen die TEXT-fig_id im `.id`-Feld (siehe /figures: id = f.fig_id),
      // NICHT in `.fig_id`. Die Soll-Brücke speichert sie als `figId`.
      const f = (this.$store.catalog.figuren || []).find(x => String(x.id) === String(idVal));
      if (f) item = { figId: f.id, name: f.name };
    } else if (kind === 'draftFigures') {
      const d = (this.allDraftFiguren || []).find(x => String(x.id) === String(idVal));
      if (d) item = { id: Number(d.id), name: d.name };
    } else if (kind === 'beats') {
      const b = this.allBeats.find(x => String(x.id) === String(idVal));
      if (b) item = { id: b.id, titel: b.titel };
    } else if (kind === 'chapters') {
      const c = (this.$store.nav.tree || []).find(t => t.type === 'chapter' && String(t.id) === String(idVal));
      if (c) item = { id: Number(idVal), name: c.name };
    } else if (kind === 'pages') {
      const p = (this.$store.nav.pages || []).find(x => String(x.id) === String(idVal));
      if (p) item = { id: Number(idVal), name: p.name };
    }
    if (!item) return;
    const idKey = this._linkIdKey(kind);
    const arr = this[this._linkBufKey(kind)];
    if (arr.some(x => x[idKey] === item[idKey])) return; // schon verknüpft
    arr.push(item);
  },

  hasLink(kind, idVal) {
    if (!this.selectedMotif()) return false;
    const idKey = this._linkIdKey(kind);
    return this[this._linkBufKey(kind)].some(x => x[idKey] === idVal);
  },

  // Ungespeicherte Änderungen an den Soll-Verknüpfungen? (ID-Mengen-Vergleich Puffer ↔ Motiv.)
  // Fliesst in motifDirty() ein — mitgespeichert vom einen Motiv-Save/Cancel.
  linksDirty() {
    const m = this.selectedMotif();
    if (!m) return false;
    const key = (arr, k) => (arr || []).map(x => String(x[k])).sort().join(',');
    return key(this.editFigures, 'figId') !== key(m.figures, 'figId')
      || key(this.editDraftFigures, 'id') !== key(m.draftFigures, 'id')
      || key(this.editBeats, 'id') !== key(m.beats, 'id')
      || key(this.editChapters, 'id') !== key(m.chapters, 'id')
      || key(this.editPages, 'id') !== key(m.pages, 'id');
  },

  // ── Auswahl + Fundstellen ────────────────────────────────────────────────
  // Plot-Beats fürs Verknüpfungs-Combobox (lazy, einmal pro Board-Load).
  // Akte werden mitgeladen, damit die Beats im Combobox nach Akt gruppiert
  // erscheinen (opt.group) statt als flache Liste.
  async _ensureBeats() {
    if (this._beatsLoaded) return;
    this._beatsLoaded = true;
    try {
      const data = await fetchJson(`/plot?book_id=${this._bookId()}`);
      this.allBeats = (data.beats || []).map(b => ({ id: b.id, titel: b.titel, actId: b.act_id }));
      this.allActs = (data.acts || []).map(a => ({ id: a.id, name: a.name }));
    } catch (e) { this.allBeats = []; this.allActs = []; }
  },
  // Werkstatt-Figuren (draft_figures) fürs Figuren-Combobox (Gruppe „Plotwerkstatt").
  async _ensureDraftFiguren() {
    if (this._draftFigurenLoaded) return;
    this._draftFigurenLoaded = true;
    try {
      const data = await fetchJson(`/draft-figures/${this._bookId()}`);
      this.allDraftFiguren = (Array.isArray(data) ? data : []).map(d => ({ id: d.id, name: d.name }));
    } catch (e) { this.allDraftFiguren = []; }
  },

  // Ausstehende Puffer-Änderungen des aktuell gewählten Motivs committen (wie das
  // Beat-Edit-Panel der Plot-Werkstatt: Wechsel/Schliessen = Save, kein stilles
  // Verwerfen). Leerer Name verwirft nur die Umbenennung statt den Save zu blocken.
  async _commitPendingMotifEdit() {
    const m = this.selectedMotif();
    if (!m || !this.motifDirty()) return;
    if (!(this.editName || '').trim()) this.editName = m.name;
    await this.saveMotifEdit();
  },

  async selectMotif(id) {
    // Re-Klick auf das bereits gewählte Motiv (z.B. sein Graph-Knoten): Edit-Puffer
    // NICHT neu laden — sonst verwirft der Klick ungespeicherte Änderungen (Name/
    // Thema/Verknüpfungen) kommentarlos und der Graph behält den alten Stand.
    // Save fehlgeschlagen → Auswahl behalten, nichts verwerfen. Motiv-Auswahl ist
    // gegenseitig exklusiv zur Themen-Auswahl (ein Editor im Panel).
    const sameId = !!id && id === this.selectedMotifId;
    if (!sameId && !(await this._commitPendingEdits())) return;
    this.selectedThemeId = null;
    this.selectedMotifId = id;
    if (!sameId) {
      this.occurrences = [];
      this._loadMotifBuffer(this.motifById(id));
      this._loadLinkBuffer(this.motifById(id));
    }
    if (!id) return;
    this.occExpanded = this._readSectionExpanded('occ', id);
    this.linksExpanded = this._readSectionExpanded('links', id);
    this.relationsExpanded = this._readSectionExpanded('relations', id);
    this._ensureBeats();
    this._ensureDraftFiguren();
    this.occLoading = true;
    try {
      const data = await fetchJson(`/motifs/${id}/occurrences`);
      this.occurrences = data.occurrences || [];
    } catch (e) { /* Fundstellen sind optional; kein harter Fehler */ }
    finally { this.occLoading = false; }
    this._highlightNode(id);
  },

  // Auf-/Zuklapp-Zustand einer Panel-Sektion (occ/links/relations) pro Motiv
  // (localStorage; Default offen → nur der zugeklappte Zustand wird gespeichert,
  // offen räumt den Key).
  _sectionExpandedKey(section, id) { return `sw:motiv:${section}-expanded:${id}`; },
  _readSectionExpanded(section, id) {
    try { return localStorage.getItem(this._sectionExpandedKey(section, id)) !== '0'; }
    catch (e) { return true; }
  },
  _persistSectionExpanded(section, id, open) {
    try {
      if (open) localStorage.removeItem(this._sectionExpandedKey(section, id));
      else localStorage.setItem(this._sectionExpandedKey(section, id), '0');
    } catch (e) { /* localStorage optional */ }
  },

  // Anzahl Soll-Verknüpfungen über alle fünf Brücken (Badge in der Sektion) —
  // aus dem Puffer, damit der Zähler den ungespeicherten Bearbeitungsstand zeigt.
  linkCount() {
    if (!this.selectedMotif()) return 0;
    return this.editFigures.length + this.editDraftFigures.length
      + this.editBeats.length + this.editChapters.length + this.editPages.length;
  },

  gotoOccurrence(occ) {
    // Seiten-Fund trägt page_id direkt; Szenen-Fund (page_id null) fällt auf die
    // Seite zurück, an der die Szene verankert ist (figure_scenes.page_id).
    const pageId = occ.page_id || occ.scene_page_id;
    if (!pageId) return;
    window.__app.gotoPageById(pageId);
    // Passage im Seitentext hervorheben (reines Lesen; findet sie nichts, bleibt
    // der Sprung auf die Seite bestehen).
    if (occ.snippet) highlightOccurrenceOnPage(occ.snippet);
  },
};
