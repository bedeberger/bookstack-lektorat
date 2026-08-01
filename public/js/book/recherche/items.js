// Fundstueck-Ebene der Recherche-Karte: Anlegen, Bearbeiten, Pin/Archiv/Loeschen
// und der Uebersichts-Cap des Beschreibungstexts.

import { fetchJson } from '../../utils.js';
import { emptyDraft as _emptyDraft } from './shared.js';

export const rechercheItemMethods = {
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

  // ── Beschreibungstext in der Übersicht ─────────────────────────────────────
  // Ein Zitat-Volltext oder eine ausführliche Notiz treibt die Liste sonst so weit
  // auf, dass sich die Übersicht nicht mehr scannen lässt. Der Text wird darum
  // per CSS auf wenige Zeilen gekappt (.research-item-text--clamped) und ist pro
  // Fundstück ausklappbar.
  bodyExpanded(item) { return !!this.expandedBodyIds[item.id]; },
  toggleBodyExpanded(item) {
    // Reassign statt In-Place-Mutate: das x-for-Item liest über diese Map, und
    // Alpine sieht die Änderung so garantiert (wie _proposalSaving).
    const next = { ...this.expandedBodyIds };
    if (next[item.id]) delete next[item.id]; else next[item.id] = true;
    this.expandedBodyIds = next;
  },

  // Ob der Toggle überhaupt erscheint, wird GEMESSEN, nicht aus der Textlänge
  // geschätzt: ob der Cap etwas abschneidet, hängt an der Spaltenbreite (Karte im
  // Vollbild vs. Handy, Sidebar offen/zu). Eine Zeichen-Schwelle zeigte auf breiten
  // Schirmen ein „Mehr anzeigen", das nichts aufzuklappen hatte.
  bodyClampable(item) { return !!this.clampableBodyIds[item.id]; },
  // Angestossen aus dem Template (x-effect am Textblock): der Lesezugriff auf
  // item.body macht die Messung zur Alpine-Dependency — sie läuft beim Rendern der
  // Liste und erneut, wenn sich ein Text ändert. Resize hängt in recherche-card.js.
  noteBodyForClamp(item) {
    void item?.body;
    this._scheduleBodyClampMeasure();
  },
  _scheduleBodyClampMeasure() {
    // Re-Entry-Guard: ein Frame bündelt alle Items einer Render-Runde.
    if (this._clampRaf) return;
    this._clampRaf = requestAnimationFrame(() => {
      this._clampRaf = null;
      this._measureBodyClamps();
    });
  },
  _measureBodyClamps() {
    const root = this.$root;
    if (!root) return;
    const next = {};
    for (const el of root.querySelectorAll('.research-item-text')) {
      const id = parseInt(el.closest('[data-research-id]')?.dataset.researchId || '', 10);
      if (!id) continue;
      // Aufgeklappt ist nichts messbar (es schneidet ja nichts ab) — der Toggle
      // muss aber bleiben, sonst kommt der User nicht zurück in den Cap.
      if (this.expandedBodyIds[id]) { next[id] = true; continue; }
      if (el.scrollHeight > el.clientHeight + 1) next[id] = true;
    }
    const prev = this.clampableBodyIds || {};
    const keys = Object.keys(next);
    if (keys.length === Object.keys(prev).length && keys.every(k => prev[k])) return;
    this.clampableBodyIds = next;
  },
};
