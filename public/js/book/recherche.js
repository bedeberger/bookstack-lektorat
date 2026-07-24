// Methoden für die Recherche-/Wissensboard-Karte (Sub-Komponente).
// Buchweit geteiltes Archiv: Notizen, Links, Zitate, Faktensplitter, Bilder —
// optional mit Buch-Entitäten (Kapitel/Seite/Figur/Ort/Szene/Beat) verknüpfbar
// und über Tags filterbar. Rein kuratierend, nie generativ im Buchtext.

import { fetchJson } from '../utils.js';
import { startPoll } from '../cards/job-helpers.js';
import { toggleWrapFullscreen } from '../fullscreen.js';

const KINDS = ['note', 'link', 'quote', 'fact', 'image', 'document'];
// Verknüpfungs-Kategorien (Reihenfolge = Anzeige in Picker/Filter/Sortierung).
const LINK_KINDS = ['figure', 'location', 'scene', 'beat', 'thread', 'chapter', 'page'];

function _emptyDraft() {
  return { kind: 'note', title: '', body: '', urls: [], source: '', tags: '', fileName: '' };
}

export const rechercheMethods = {
  // ── Lifecycle ──────────────────────────────────────────────────────────────
  async loadRecherche() {
    const app = window.__app;
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) { this.items = []; return; }
    // Skeleton nur beim Erstladen (noch keine Daten). Bei Filter-/Sort-/Such-
    // Refetches bleibt die Liste stehen und wird nur gedimmt (refreshing) — sonst
    // flackert bei jedem Tastendruck das Skeleton auf und wieder weg.
    if (this.items.length > 0) this.refreshing = true; else this.loading = true;
    try {
      const qs = new URLSearchParams({ book_id: String(bookId) });
      if (this.filterKind) qs.set('kind', this.filterKind);
      if (this.filterTag) qs.set('tag', this.filterTag);
      if (this.filterLinked) qs.set('linked', this.filterLinked);
      if ((this.filterText || '').trim()) qs.set('q', this.filterText.trim());
      if (this.showArchived) qs.set('archived', '1');
      if (this.sortBy && this.sortBy !== 'updated') qs.set('sort', this.sortBy);
      const rows = await fetchJson(`/research?${qs.toString()}`);
      this.items = Array.isArray(rows) ? rows : [];
      this.errorMessage = '';
      this._loadTags();
      this.ensureLinkTargets();
    } catch (e) {
      this.errorMessage = app.t('recherche.error.load');
      this.items = [];
    } finally {
      this.loading = false;
      this.refreshing = false;
    }
    // Deep-Link-Ziel (#…/recherche/<itemId>), das vor dem Load ankam, jetzt
    // fokussieren — das Item existiert erst nach diesem Load in `items`.
    if (this._pendingFocusItemId != null) this._focusRechercheItemById(this._pendingFocusItemId);
  },

  async _loadTags() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) { this.tagPool = []; return; }
    try {
      const rows = await fetchJson(`/research/tags?book_id=${bookId}`);
      this.tagPool = Array.isArray(rows) ? rows : [];
    } catch { this.tagPool = []; }
  },

  async ensureLinkTargets() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || this._linkTargetsBookId === bookId) return;
    try {
      this.linkTargets = await fetchJson(`/research/link-targets?book_id=${bookId}`);
      this._sortLinkTargetsByTree();
      this._linkTargetsBookId = bookId;
    } catch { this.linkTargets = {}; }
  },

  // Seiten + Kapitel im Picker/Filter in Buchtree-Reihenfolge bringen (identisch
  // zur Sidebar), statt in der flachen `position`-Server-Sortierung, die die
  // Kapitel-Hierarchie nicht abbildet. Welt-Entitäten (Figuren/Orte/Szenen/
  // Beats/Stränge) behalten ihre kuratierte bzw. gewichtete Server-Sortierung.
  _sortLinkTargetsByTree() {
    const nav = Alpine.store('nav');
    const pageOrder = window.__app?._pageIdOrderMap;
    if (pageOrder && Array.isArray(this.linkTargets.page)) {
      const rank = (id) => pageOrder.has(id) ? pageOrder.get(id) : Number.MAX_SAFE_INTEGER;
      this.linkTargets.page = [...this.linkTargets.page].sort((a, b) => rank(a.id) - rank(b.id));
    }
    if (Array.isArray(nav?.tree) && Array.isArray(this.linkTargets.chapter)) {
      const chapterOrder = new Map();
      let i = 0;
      for (const item of nav.tree) {
        if (item.type === 'chapter' && !item.solo) chapterOrder.set(item.id, i++);
      }
      const rank = (id) => chapterOrder.has(id) ? chapterOrder.get(id) : Number.MAX_SAFE_INTEGER;
      this.linkTargets.chapter = [...this.linkTargets.chapter].sort((a, b) => rank(a.id) - rank(b.id));
    }
  },

  resetRecherche() {
    this.items = [];
    this.tagPool = [];
    this.linkTargets = {};
    this._linkTargetsBookId = null;
    this.creating = false;
    this.draft = _emptyDraft();
    this.editingId = null;
    this.editDraft = _emptyDraft();
    this._pendingFocusItemId = null;
    if (window.Alpine) window.Alpine.store('nav').rechercheItemId = null;
    this.filterKind = '';
    this.filterTag = '';
    this.filterLinked = '';
    this.filterLinkedKind = '';
    this.filterLinkedTargetId = '';
    this.filterText = '';
    this.sortBy = 'updated';
    this.showArchived = false;
    this.menuOpenId = null;
    this.linkPickerItemId = null;
    this.suggestions = {};
    this.errorMessage = '';
    this.busy = false;
    this.refreshing = false;
    if (this._suggestTimer) { clearInterval(this._suggestTimer); this._suggestTimer = null; }
  },

  // Ganze Recherche-Karte ins Native-Vollbild — mehr Platz fürs Karten-Board.
  // Status-Sync via fullscreenchange-Listener in recherche-card.js (rechercheFullscreen).
  async toggleRechercheFullscreen() {
    try {
      await toggleWrapFullscreen(this.$root);
    } catch {
      this.errorMessage = window.__app.t('recherche.error.fullscreen');
    }
  },

  // ── Filter ───────────────────────────────────────────────────────────────
  applyFilters() { return this.loadRecherche(); },
  clearFilters() {
    this.filterKind = ''; this.filterTag = ''; this.filterText = '';
    this.filterLinked = ''; this.filterLinkedKind = ''; this.filterLinkedTargetId = '';
    return this.loadRecherche();
  },
  kindOptions() {
    const t = window.__app.t;
    return KINDS.map(k => ({ value: k, label: t(`recherche.kind.${k}`) }));
  },
  tagFilterOptions() {
    return (this.tagPool || []).map(r => ({ value: r.tag, label: `${r.tag} (${r.n})` }));
  },

  // Alle Verknüpfungs-Kategorien (geteilt zwischen Filter + Sortierung).
  linkKinds() {
    return LINK_KINDS.map(k => ({ value: k, label: this.linkKindLabel(k) }));
  },
  // Kategorien im Verknüpfen-Picker: Seite zuerst (häufigstes Ziel).
  linkPickerKinds() {
    const ordered = ['page', ...LINK_KINDS.filter(k => k !== 'page')];
    return ordered.map(k => ({ value: k, label: this.linkKindLabel(k) }));
  },
  // Sortier-Modi: feste Felder + „nach verknüpfter Entität" (link:<dimension>).
  sortOptions() {
    const t = window.__app.t;
    const opts = ['updated', 'created', 'title', 'kind'].map(s => ({ value: s, label: t(`recherche.sort.${s}`) }));
    for (const k of LINK_KINDS) opts.push({ value: `link:${k}`, label: t(`recherche.sort.by`, { kind: this.linkKindLabel(k) }) });
    return opts;
  },
  applySort() { return this.loadRecherche(); },

  // Filter „nach Verknüpfung": Kategorie + konkreter Eintrag → filterLinked.
  // Die Ziel-Optionen baut die generische entityPicker-Komponente (entity
  // 'target') aus `linkTargets[filterLinkedKind]`.
  onLinkedFilterKindChange() {
    this.filterLinkedTargetId = '';
    return this.applyLinkedFilter();
  },
  applyLinkedFilter() {
    this.filterLinked = (this.filterLinkedKind && this.filterLinkedTargetId)
      ? `${this.filterLinkedKind}:${this.filterLinkedTargetId}` : '';
    return this.loadRecherche();
  },

  // Sprung vom Seiten-Indikator: alle Filter zurücksetzen und nur die mit dieser
  // Seite verknüpften Schnipsel zeigen. Beim frischen Öffnen lädt der Lifecycle
  // (rising edge) selbst; ist die Karte schon offen, hier nachladen.
  filterToPage(pageId) {
    const pid = parseInt(pageId, 10);
    if (!pid) return;
    this.filterKind = '';
    this.filterTag = '';
    this.filterText = '';
    this.showArchived = false;
    this.filterLinkedKind = 'page';
    this.filterLinkedTargetId = String(pid);
    this.filterLinked = `page:${pid}`;
    if (window.__app?.showRechercheCard) this.loadRecherche();
  },

  // Sprung vom Kapitel-Indikator: alle Filter zurücksetzen und nur die mit diesem
  // Kapitel verknüpften Schnipsel zeigen (analog filterToPage).
  filterToChapter(chapterId) {
    const cid = parseInt(chapterId, 10);
    if (!cid) return;
    this.filterKind = '';
    this.filterTag = '';
    this.filterText = '';
    this.showArchived = false;
    this.filterLinkedKind = 'chapter';
    this.filterLinkedTargetId = String(cid);
    this.filterLinked = `chapter:${cid}`;
    if (window.__app?.showRechercheCard) this.loadRecherche();
  },

  // ── Anlegen ────────────────────────────────────────────────────────────────
  startCreate() {
    this.creating = true;
    this.draft = _emptyDraft();
    this.editingId = null;
    this.clearCreateFile();
  },
  cancelCreate() { this.creating = false; this.draft = _emptyDraft(); this.clearCreateFile(); },

  // Datei-Auswahl beim Anlegen: File NICHT in reaktivem State halten (ein Alpine-
  // Proxy bricht File.arrayBuffer mit „Illegal invocation"), nur den Anzeige-Namen.
  // Das echte File wird beim Speichern via x-ref aus dem Input gelesen.
  onCreateFilePick(ev) {
    const file = ev?.target?.files?.[0];
    if (!file) { this.draft.fileName = ''; return; }
    this.draft.fileName = file.name;
    if ((file.type || '').startsWith('image/')) this.draft.kind = 'image';
    else if (file.type === 'application/pdf') this.draft.kind = 'document';
  },
  clearCreateFile() {
    this.draft.fileName = '';
    if (this.$refs?.createFile) this.$refs.createFile.value = '';
  },

  async createItem() {
    const app = window.__app;
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) return;
    const d = this.draft;
    const file = this.$refs?.createFile?.files?.[0] || null;
    const hasText = !!((d.title || '').trim() || (d.body || '').trim() || (d.urls || []).some(u => (u.url || '').trim()));
    if (!hasText && !file) {
      this.errorMessage = app.t('recherche.error.empty');
      return;
    }
    this.busy = true;
    try {
      const payload = this._draftBody(d);
      // Reiner Datei-Eintrag ohne Text: Server verlangt ein nicht-leeres Feld →
      // Dateiname als Titel, damit das Item benannt ist (kind setzt der Upload).
      if (!hasText && file && !payload.title) payload.title = file.name.slice(0, 300);
      const row = await fetchJson('/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId, ...payload }),
      });
      this.items = [row, ...this.items];
      // Datei nachladen (image/* → Bild, application/pdf → Dokument); uploadXxx
      // ersetzt das eben eingefügte Item per id und setzt kind serverseitig.
      if (file) {
        if ((file.type || '').startsWith('image/')) await this.uploadImage(row, file);
        else if (file.type === 'application/pdf') await this.uploadDoc(row, file);
      }
      this.creating = false;
      this.draft = _emptyDraft();
      this.clearCreateFile();
      this.errorMessage = '';
      this._loadTags();
    } catch (e) {
      this.errorMessage = app.t('recherche.error.save');
    } finally {
      this.busy = false;
    }
  },

  // ── Bearbeiten ───────────────────────────────────────────────────────────
  startEdit(item) {
    this.editingId = item.id;
    this.creating = false;
    // Permalink-Spiegel: offenes Item → #…/recherche/<itemId>. editingId bleibt
    // SSoT in der Karte (analog editingBeatId ↔ plotBeatId in der Plot-Werkstatt).
    if (window.Alpine) window.Alpine.store('nav').rechercheItemId = item.id;
    this.editDraft = {
      kind: item.kind || 'note',
      title: item.title || '',
      body: item.body || '',
      urls: (item.urls || []).map(u => ({ url: u.url || '', label: u.label || '' })),
      source: item.source || '',
      tags: (item.tags || []).join(', '),
    };
  },
  cancelEdit() {
    this.editingId = null;
    this.editDraft = _emptyDraft();
    if (window.Alpine) window.Alpine.store('nav').rechercheItemId = null;
  },

  // URL-Zeilen im Anlegen-/Bearbeiten-Formular (geteilt über draft/editDraft).
  addUrlRow(draft) { if (!Array.isArray(draft.urls)) draft.urls = []; draft.urls.push({ url: '', label: '' }); },
  removeUrlRow(draft, i) { (draft.urls || []).splice(i, 1); },

  // Klick auf den Eintrag öffnet den Edit-Modus — ausser auf interaktiven
  // Elementen (Aktions-Buttons, Links, Datei-Inputs, Tag-/Link-Chips) sowie
  // dem Verknüpfen-Picker (inkl. Combobox-Dropdown, dessen Optionen <li> sind
  // und sonst durchblubbern würden), die ihre eigene Aktion behalten.
  onItemBodyClick(item, ev) {
    if (this.busy) return;
    if (ev.target.closest('a, button, input, label, .research-tag, .research-link-chip, .recherche-linkpicker, .combobox-wrap')) return;
    // Textselektion nicht abwürgen: hat der User Text markiert (Drag löst am
    // Ende ebenfalls ein click aus), nicht in den Edit-Modus wechseln.
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return;
    this.startEdit(item);
  },

  async saveEdit(item) {
    const app = window.__app;
    this.busy = true;
    try {
      const row = await fetchJson(`/research/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this._draftBody(this.editDraft)),
      });
      this._replaceItem(row);
      this.editingId = null;
      this.editDraft = _emptyDraft();
      if (window.Alpine) window.Alpine.store('nav').rechercheItemId = null;
      this.errorMessage = '';
      this._loadTags();
    } catch (e) {
      this.errorMessage = app.t('recherche.error.save');
    } finally {
      this.busy = false;
    }
  },

  _draftBody(d) {
    const tags = (d.tags || '').split(',').map(s => s.trim()).filter(Boolean);
    const urls = (d.urls || [])
      .map(u => ({ url: (u.url || '').trim(), label: (u.label || '').trim() }))
      .filter(u => u.url);
    return {
      kind: d.kind, title: d.title.trim(), body: d.body.trim(),
      urls, source: d.source.trim(), tags,
    };
  },

  async togglePin(item) {
    try {
      const row = await fetchJson(`/research/${item.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: !item.pinned }),
      });
      this._replaceItem(row);
      this.items = this._sortItems(this.items);
    } catch { this.errorMessage = window.__app.t('recherche.error.save'); }
    this.menuOpenId = null;
  },

  async toggleArchive(item) {
    try {
      await fetchJson(`/research/${item.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived: !item.archived }),
      });
      // Bei aktivem „nur aktive"-Filter verschwindet das Item aus der Liste.
      if (!this.showArchived) this.items = this.items.filter(i => i.id !== item.id);
      else { item.archived = item.archived ? 0 : 1; }
      // Archivierte Items zählen nicht im Seiten-/Kapitel-Indikator.
      if ((item.links || []).some(l => l.target_kind === 'page')) this._refreshRecherchePageCounts();
      if ((item.links || []).some(l => l.target_kind === 'chapter')) this._refreshRechercheChapterCounts();
    } catch { this.errorMessage = window.__app.t('recherche.error.save'); }
    this.menuOpenId = null;
  },

  async deleteItem(item) {
    const app = window.__app;
    if (!await app.appConfirm({
      message: app.t('recherche.confirmDelete'),
      confirmLabel: app.t('common.delete'), danger: true,
    })) return;
    try {
      await fetchJson(`/research/${item.id}`, { method: 'DELETE' });
      this.items = this.items.filter(i => i.id !== item.id);
      if (this.editingId === item.id) {
        this.editingId = null;
        if (window.Alpine) window.Alpine.store('nav').rechercheItemId = null;
      }
      this._loadTags();
      if ((item.links || []).some(l => l.target_kind === 'page')) this._refreshRecherchePageCounts();
      if ((item.links || []).some(l => l.target_kind === 'chapter')) this._refreshRechercheChapterCounts();
    } catch { this.errorMessage = app.t('recherche.error.delete'); }
    this.menuOpenId = null;
  },

  // ── Verknüpfungen ──────────────────────────────────────────────────────────
  async openLinkPicker(item) {
    await this.ensureLinkTargets();
    this.linkPickerItemId = item.id;
    this.linkPickerKind = 'page';
    this.linkPickerTargetId = '';
  },
  cancelLinkPicker() { this.linkPickerItemId = null; this.linkPickerTargetId = ''; },

  // Ziel-Optionen des Link-Pickers baut die generische entityPicker-Komponente
  // (entity 'target') aus `linkTargets[linkPickerKind]`.

  async addLink(itemId, targetKind, targetId) {
    const app = window.__app;
    if (!targetKind || !targetId) return;
    try {
      const row = await fetchJson(`/research/${itemId}/links`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_kind: targetKind, target_id: parseInt(targetId, 10) }),
      });
      this._replaceItem(row);
      this.linkPickerItemId = null;
      this.linkPickerTargetId = '';
      if (targetKind === 'page') this._refreshRecherchePageCounts();
      if (targetKind === 'chapter') this._refreshRechercheChapterCounts();
    } catch { this.errorMessage = app.t('recherche.error.link'); }
  },

  async confirmLinkPicker() {
    if (!this.linkPickerItemId || !this.linkPickerTargetId) return;
    return this.addLink(this.linkPickerItemId, this.linkPickerKind, this.linkPickerTargetId);
  },

  // Sprung zum verknüpften Element: baut den Deep-Link-Hash und überlässt die
  // eigentliche Navigation (Karte öffnen, Eintrag fokussieren, Exklusivität)
  // dem Hash-Router als SSoT. Kind → Router-View-Segment; thread hat keinen
  // Deep-Link-Arg (nur Board öffnen), alle anderen springen per target_id.
  gotoLink(link) {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || !link) return;
    const VIEW = {
      figure: 'figur', location: 'ort', scene: 'szene',
      beat: 'plot', thread: 'plot', chapter: 'kapitel', page: 'page',
    };
    const view = VIEW[link.target_kind];
    if (!view) return;
    const arg = (link.target_kind !== 'thread' && link.target_id != null)
      ? `/${link.target_id}` : '';
    location.hash = `#book/${bookId}/${view}${arg}`;
  },

  async removeLink(item, link) {
    try {
      const row = await fetchJson(`/research/${item.id}/links/${link.link_id}`, { method: 'DELETE' });
      this._replaceItem(row);
      if (link.target_kind === 'page') this._refreshRecherchePageCounts();
      if (link.target_kind === 'chapter') this._refreshRechercheChapterCounts();
    } catch { this.errorMessage = window.__app.t('recherche.error.link'); }
  },

  // ── Bild-Upload ──────────────────────────────────────────────────────────
  async uploadImage(item, file) {
    const app = window.__app;
    if (!file) return;
    this.busy = true;
    try {
      const buf = await file.arrayBuffer();
      const row = await fetchJson(`/research/${item.id}/image`, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: buf,
      });
      this._replaceItem(row);
    } catch { this.errorMessage = app.t('recherche.error.image'); }
    finally { this.busy = false; }
  },
  onImagePick(item, ev) {
    const file = ev?.target?.files?.[0];
    if (file) this.uploadImage(item, file);
    if (ev?.target) ev.target.value = '';
  },
  imageUrl(item) { return `/research/${item.id}/image`; },

  // ── Dokument-Upload (PDF) ──────────────────────────────────────────────────
  async uploadDoc(item, file) {
    const app = window.__app;
    if (!file) return;
    this.busy = true;
    try {
      const buf = await file.arrayBuffer();
      const qs = file.name ? `?name=${encodeURIComponent(file.name)}` : '';
      const row = await fetchJson(`/research/${item.id}/doc${qs}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/pdf' },
        body: buf,
      });
      this._replaceItem(row);
    } catch { this.errorMessage = app.t('recherche.error.doc'); }
    finally { this.busy = false; }
  },
  onDocPick(item, ev) {
    const file = ev?.target?.files?.[0];
    if (file) this.uploadDoc(item, file);
    if (ev?.target) ev.target.value = '';
  },
  docUrl(item) { return `/research/${item.id}/doc`; },
  async removeDoc(item) {
    const app = window.__app;
    if (!await app.appConfirm({
      message: app.t('recherche.doc.confirmRemove'),
      confirmLabel: app.t('common.delete'), danger: true,
    })) return;
    try {
      const row = await fetchJson(`/research/${item.id}/doc`, { method: 'DELETE' });
      this._replaceItem(row);
    } catch { this.errorMessage = app.t('recherche.error.doc'); }
    this.menuOpenId = null;
  },

  // ── KI-Verknüpfungsvorschläge ──────────────────────────────────────────────
  async suggestLinks(item) {
    const app = window.__app;
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) return;
    this.suggestItemId = item.id;
    this.suggestStatus = app.t('recherche.suggest.running');
    this.suggestions = { ...this.suggestions, [item.id]: null };
    this.menuOpenId = null;
    try {
      const { jobId } = await fetchJson('/jobs/research-link', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId, item_id: item.id }),
      });
      startPoll(this, {
        timerProp: '_suggestTimer',
        jobId,
        onNotFound: () => { this.suggestItemId = null; this.suggestStatus = ''; },
        onError: () => {
          this.suggestItemId = null;
          this.suggestStatus = '';
          this.errorMessage = app.t('recherche.suggest.error');
        },
        onDone: (job) => {
          this.suggestItemId = null;
          this.suggestStatus = '';
          const list = job.result?.suggestions || [];
          this.suggestions = { ...this.suggestions, [item.id]: list };
          if (!list.length) this.suggestStatus = app.t('recherche.suggest.none');
        },
      });
    } catch (e) {
      this.suggestItemId = null;
      this.suggestStatus = '';
      this.errorMessage = app.t('recherche.suggest.error');
    }
  },

  async acceptSuggestion(item, sugg) {
    await this.addLink(item.id, sugg.target_kind, sugg.target_id);
    const list = (this.suggestions[item.id] || []).filter(
      s => !(s.target_kind === sugg.target_kind && s.target_id === sugg.target_id)
    );
    this.suggestions = { ...this.suggestions, [item.id]: list };
  },
  dismissSuggestions(item) {
    const next = { ...this.suggestions };
    delete next[item.id];
    this.suggestions = next;
  },
  itemSuggestions(item) { return this.suggestions[item.id] || null; },

  // ── Helpers ──────────────────────────────────────────────────────────────
  _replaceItem(row) { this.items = this.items.map(i => (i.id === row.id ? row : i)); },
  // Seiten-Indikator-Map (Sidebar + Editor) nach Link-/Archiv-/Lösch-Änderungen
  // frisch ziehen. Buchweit geteilt → ein leichter Request hält alle Editoren sync.
  async _refreshRecherchePageCounts() {
    const app = window.__app;
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) return;
    try {
      const map = await fetchJson(`/research/page-counts?book_id=${bookId}`);
      Alpine.store('badges').rechercheCounts = map || {};
      if (app.currentPage?.id) app.currentPageRechercheCount = (map || {})[app.currentPage.id] || 0;
    } catch { /* Indikator-Refresh ist best-effort */ }
  },
  // Kapitel-Indikator-Map (Sidebar) nach Link-/Archiv-/Lösch-Änderungen frisch
  // ziehen. Buchweit geteilt, analog zu _refreshRecherchePageCounts.
  async _refreshRechercheChapterCounts() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) return;
    try {
      const map = await fetchJson(`/research/chapter-counts?book_id=${bookId}`);
      Alpine.store('badges').chapterRechercheCounts = map || {};
    } catch { /* Indikator-Refresh ist best-effort */ }
  },
  _sortItems(arr) {
    return [...arr].sort((a, b) => {
      if (!!b.pinned !== !!a.pinned) return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
      return (b.updated_at || '').localeCompare(a.updated_at || '');
    });
  },
  kindLabel(k) { return window.__app.t(`recherche.kind.${k}`); },
  linkKindLabel(k) { return window.__app.t(`recherche.linkKind.${k}`); },
  hasItems() { return (this.items || []).length > 0; },
};
