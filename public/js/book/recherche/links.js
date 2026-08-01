// Verknuepfungs-Ebene der Recherche-Karte: Link-Picker, Sprung zum verknuepften
// Element und die KI-Verknuepfungsvorschlaege (Job /jobs/research-link).

import { fetchJson } from '../../utils.js';
import { startPoll } from '../../cards/job-helpers.js';

export const rechercheLinkMethods = {
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
};
