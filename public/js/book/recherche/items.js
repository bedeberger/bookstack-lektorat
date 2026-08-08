// Fundstueck-Ebene der Recherche-Karte: Anlegen, Bearbeiten, Pin/Archiv/Loeschen
// und der Uebersichts-Cap des Beschreibungstexts.

import { fetchJson } from '../../utils.js';
import { emptyDraft as _emptyDraft } from './shared.js';

export const rechercheItemMethods = {
  // ── Native-Dialog schliessen (geteilter Idiom) ────────────────────────────
  // Dialog per dlg.close() schliessen, damit ESC/Backdrop/Button denselben Weg
  // nehmen — das native close-Event ruft den onClosed-Hook als einzigen
  // Aufräum-Punkt. Steht der Dialog noch nicht am DOM (oder wurde schon per
  // close-Event abgeräumt), geht der Hook direkt durch.
  _closeNativeDialog(refName, onClosed) {
    const dlg = this.$refs?.[refName];
    if (dlg?.open) dlg.close();
    else onClosed.call(this);
  },

  // ── Anlegen (Dialog) ──────────────────────────────────────────────────────
  // Anlegen und Bearbeiten fahren auf DEMSELBEN `draft` und teilen dieselben
  // Formularfelder (partials/recherche-form-fields.html) in derselben Dialog-Shell.
  // Zwei Drafts + zwei Formular-Kopien waren die Drift-Quelle; exklusiv sind die
  // beiden Wege ohnehin, weil beide in einem modalen <dialog> stehen.
  startCreate() {
    this.draft = _emptyDraft();
    // Anlegen und Detailansicht schliessen sich aus — sonst schreibt der User in
    // ein Formular, während hinter dem Dialog ein zweites offen steht.
    this.closeDetail();
    this.clearCreateFile();
    // Native showModal() erst nach dem Render: der Dialog steht im selben Tick
    // noch nicht am DOM (analog openDetail).
    this.$nextTick(() => {
      const dlg = this.$refs?.createDialog;
      if (dlg && typeof dlg.showModal === 'function' && !dlg.open) dlg.showModal();
    });
  },
  // Über dlg.close() gehen, damit Schliessen-Knopf, Abbrechen und ESC denselben Weg
  // nehmen — das close-Event ruft _onCreateClosed als einzigen Aufräum-Punkt (Muster
  // closeDetail). Bewusst KEIN Backdrop-Klick am Anlegen-Dialog: hier steht ein
  // frisch getippter (womöglicherweise langer) Text, den ein Fehlklick daneben nicht
  // wegwerfen darf — dieselbe Überlegung wie der `!detailEditing`-Guard am
  // Detail-Dialog.
  closeCreate() { this._closeNativeDialog('createDialog', this._onCreateClosed); },
  // Die close-Handler beider Dialoge fassen die Textfelder von `draft` NICHT an:
  // das native close-Event feuert als eigener Task (nicht synchron zu dlg.close()),
  // und `draft` teilen sich Anlegen und Bearbeiten — ein Reset hier würde den Draft
  // überschreiben, den der gerade geöffnete zweite Dialog schon gefüllt hat
  // (openDetail(item, { edit: true }) schliesst zuerst diesen Dialog). Gefüllt wird
  // `draft` ausschliesslich von startCreate/startEdit.
  _onCreateClosed() {
    this.clearCreateFile();
    this.errorMessage = '';
  },

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
      // Dialog zu (raeumt draft + Datei-Input im close-Handler).
      this.closeCreate();
      this._loadTags();
    } catch (e) {
      this.errorMessage = app.t('recherche.error.save');
    } finally {
      this.busy = false;
    }
  },

  // ── Detail-Dialog (Lesen) ────────────────────────────────────────────────
  // Ein Klick auf ein Fundstück ÖFFNET es, er bearbeitet es nicht: der Volltext
  // eines erfassten Artikels (bis 20 000 Zeichen) ist in einem Formularfeld nicht
  // lesbar. Bearbeiten ist im Dialog ein eigener Schalter — Verknüpfungen, Tags
  // und Anhänge bleiben dabei sichtbar und bedienbar.
  openDetail(item, { edit = false } = {}) {
    if (!item) return;
    this.detailItemId = item.id;
    this.detailEditing = false;
    this.menuOpenId = null;
    // Anlegen-Dialog wirklich schliessen (nicht bloss das Flag): er liegt sonst
    // als zweites Panel im Top-Layer.
    this.closeCreate();
    if (edit) this.startEdit(item);
    // Permalink-Spiegel: offenes Fundstück → #…/recherche/<itemId>. detailItemId
    // bleibt SSoT in der Karte (analog editingBeatId ↔ plotBeatId in der Plot-
    // Werkstatt).
    if (window.Alpine) window.Alpine.store('nav').rechercheItemId = item.id;
    // Transkript-Block des Dialogs fuellen. Nur fuer Transkript-Fundstuecke —
    // fuer eine Notiz waere es ein 404 bei jedem Oeffnen.
    if (item.kind === 'transcript') this.ivLoadTranscript?.(item.id);
    else { this.ivTranscript = null; this.ivSegments = []; this.ivSpeakerKeys = []; }
    // Native showModal() erst nach dem Render: der Dialoginhalt hängt an
    // detailItems (x-for über 0/1 Element) und existiert im selben Tick noch nicht.
    this.$nextTick(() => {
      const dlg = this.$refs?.detailDialog;
      if (dlg && typeof dlg.showModal === 'function' && !dlg.open) dlg.showModal();
    });
  },
  closeDetail() { this._closeNativeDialog('detailDialog', this._onDetailClosed); },
  _onDetailClosed() {
    this.detailItemId = null;
    this.detailEditing = false;
    this.linkPickerItemId = null;
    // menuOpenId-Aufräum-Pflicht beim Schliessen: trägt noch den Kontext-Bezeichner
    // ('detail:<id>'), sonst reopening wäre das Menü sofort offen. Liste vs. Detail
    // sind über den menuCtx-Präfix im Markup getrennt, der Reset gilt beiden.
    this.menuOpenId = null;
    if (window.Alpine) window.Alpine.store('nav').rechercheItemId = null;
  },

  // ── Bearbeiten (nur im Detail-Dialog) ────────────────────────────────────
  startEdit(item) {
    this.detailEditing = true;
    this.draft = {
      kind: item.kind || 'note',
      title: item.title || '',
      body: item.body || '',
      urls: (item.urls || []).map(u => ({ url: u.url || '', label: u.label || '' })),
      source: item.source || '',
      tags: (item.tags || []).join(', '),
      fileName: '',
    };
  },
  // Zurück in den Lesemodus — der Dialog bleibt offen (und damit der Permalink).
  cancelEdit() {
    this.detailEditing = false;
    this.draft = _emptyDraft();
  },

  // URL-Zeilen des geteilten Formular-Fragments (Anlegen + Bearbeiten, `draft`).
  addUrlRow(draft) { if (!Array.isArray(draft.urls)) draft.urls = []; draft.urls.push({ url: '', label: '' }); },
  removeUrlRow(draft, i) { (draft.urls || []).splice(i, 1); },

  // Klick auf den Eintrag öffnet die Detailansicht — ausser auf interaktiven
  // Elementen (Aktions-Buttons, Links, Datei-Inputs, Tag-/Link-Chips) sowie
  // dem Verknüpfen-Picker (inkl. Combobox-Dropdown, dessen Optionen <li> sind
  // und sonst durchblubbern würden), die ihre eigene Aktion behalten.
  onItemBodyClick(item, ev) {
    if (this.busy) return;
    if (ev.target.closest('a, button, input, label, .research-tag, .research-link-chip, .recherche-linkpicker, .combobox-wrap')) return;
    // Textselektion nicht abwürgen: hat der User Text markiert (Drag löst am
    // Ende ebenfalls ein click aus), nicht den Dialog aufziehen.
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return;
    this.openDetail(item);
  },

  async saveEdit(item) {
    const app = window.__app;
    this.busy = true;
    try {
      this._replaceItem(await this._patchItem(item.id, this._draftBody(this.draft)));
      // Nach dem Speichern zurück in den Lesemodus, Dialog bleibt offen: der
      // User will sehen, was er geschrieben hat.
      this.detailEditing = false;
      this.draft = _emptyDraft();
      this.errorMessage = '';
      this._loadTags();
    } catch (e) {
      this.errorMessage = app.t('recherche.error.save');
    } finally {
      this.busy = false;
    }
  },

  // Teil-Aktualisierung eines Fundstuecks. Vier Aufrufer (Speichern, Anheften,
  // Archivieren, Feld-Edit) schickten dieselben drei Zeilen Fetch-Aufbau.
  _patchItem(id, body) {
    return fetchJson(`/research/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
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
      this._replaceItem(await this._patchItem(item.id, { pinned: !item.pinned }));
      this.items = this._sortItems(this.items);
    } catch { this.errorMessage = window.__app.t('recherche.error.save'); }
    this.menuOpenId = null;
  },

  async toggleArchive(item) {
    try {
      await this._patchItem(item.id, { archived: !item.archived });
      // Bei aktivem „nur aktive"-Filter verschwindet das Item aus der Liste.
      // Dann muss auch der Detail-Dialog zu: sein Inhalt hängt an `items`, er
      // stünde sonst leer offen.
      if (!this.showArchived) {
        this.items = this.items.filter(i => i.id !== item.id);
        if (this.detailItemId === item.id) this.closeDetail();
      } else { item.archived = item.archived ? 0 : 1; }
      // Archivierte Items zählen nicht im Seiten-/Kapitel-Indikator.
      if ((item.links || []).some(l => l.target_kind === 'page')) this._refreshRechercheCounts('page');
      if ((item.links || []).some(l => l.target_kind === 'chapter')) this._refreshRechercheCounts('chapter');
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
      if (this.detailItemId === item.id) this.closeDetail();
      this._loadTags();
      if ((item.links || []).some(l => l.target_kind === 'page')) this._refreshRechercheCounts('page');
      if ((item.links || []).some(l => l.target_kind === 'chapter')) this._refreshRechercheCounts('chapter');
    } catch { this.errorMessage = app.t('recherche.error.delete'); }
    this.menuOpenId = null;
  },

};
