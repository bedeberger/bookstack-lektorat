// Plot-Werkstatt: Akt-CRUD, Reihenfolge, Farb-Picker, scoped Anlegen (geteilt
// vs. strang-eigen) und Hybrid-Akt-Fork/Unfork.

import { fetchJson } from '../../utils.js';
import { ACT_PALETTE } from './constants.js';

export const actsMethods = {
  toggleActColorPicker(actId) {
    this.actColorPickerId = this.actColorPickerId === actId ? null : actId;
  },

  async setActColor(act, key) {
    const app = window.__app;
    this.actColorPickerId = null;
    const farbe = ACT_PALETTE.includes(key) ? key : null;
    if (farbe === (act.farbe || null)) return;
    try {
      const updated = await fetchJson(`/plot/acts/${act.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ farbe }),
      });
      this.acts = this.acts.map(a => (a.id === updated.id ? updated : a));
      this._recordActFields(act.id, { farbe: act.farbe || null }, { farbe });
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = app.t('plot.error.save');
    }
  },

  // ── Akte ─────────────────────────────────────────────────────────────────
  async addAct() {
    const app = window.__app;
    const name = (this.newActName || '').trim();
    if (!name) { this.errorMessage = app.t('plot.error.nameRequired'); return; }
    this.busy = true;
    try {
      const act = await fetchJson('/plot/acts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: Alpine.store('nav').selectedBookId, name }),
      });
      this.acts = [...this.acts, act];
      this._recordCreate('act', act?.id);
      this.newActName = '';
      this.addingAct = false;
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = app.t('plot.error.save');
    } finally { this.busy = false; }
  },

  startEditAct(act) {
    this.editingActId = act.id;
    this.actDraft = act.name;
    // Flaches Board + Grid sind beide im DOM (eines via x-show versteckt) — die
    // sichtbare Titel-Eingabe fokussieren, nicht die display:none-Variante.
    this.$nextTick(() => {
      const inputs = [...(this.$root?.querySelectorAll('.plot-column-title-input') || [])];
      (inputs.find(el => el.offsetParent !== null) || inputs[0])?.focus();
    });
  },
  cancelEditAct() { this.editingActId = null; this.actDraft = ''; },

  // Der Spellcheck-Dispatcher wickelt das Feld beim Fokus in ein
  // <span class="lt-field-wrap"> — der DOM-Move feuert ein synchrones blur,
  // obwohl der Fokus unmittelbar danach wiederhergestellt wird. Würde blur
  // sofort speichern, liefe saveEditAct → cancelEditAct und das x-if blendete
  // das Input direkt beim ersten Klick wieder aus. Darum eine Frame deferren und
  // nur speichern, wenn der Fokus das Feld wirklich verlassen hat.
  onActBlur(act, ev) {
    const input = ev?.target || null;
    requestAnimationFrame(() => {
      if (input && document.activeElement === input) return;
      this.saveEditAct(act);
    });
  },

  async saveEditAct(act) {
    const app = window.__app;
    const name = (this.actDraft || '').trim();
    if (!name) { this.errorMessage = app.t('plot.error.nameRequired'); return; }
    if (name === act.name) { this.cancelEditAct(); return; }
    this.busy = true;
    try {
      const updated = await fetchJson(`/plot/acts/${act.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      this.acts = this.acts.map(a => (a.id === updated.id ? updated : a));
      this._recordActFields(act.id, { name: act.name }, { name });
      this.editingActId = null;
      this.actDraft = '';
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = app.t('plot.error.save');
    } finally { this.busy = false; }
  },

  async deleteAct(act) {
    const app = window.__app;
    const beatCount = this.beatsForAct(act.id).length;
    if (!await app.appConfirm({
      message: app.t('plot.confirmDeleteAct', { name: act.name, n: beatCount }),
      confirmLabel: app.t('common.delete'),
      danger: true,
    })) return;
    this.busy = true;
    try {
      await fetchJson(`/plot/acts/${act.id}`, { method: 'DELETE' });
      // Hard-Delete samt Beats des Akts → jeder Record im Stack kann ins Leere
      // zeigen (siehe plot/history.js).
      this._clearHistory();
      this.acts = this.acts.filter(a => a.id !== act.id);
      this.beats = this.beats.filter(b => b.act_id !== act.id);
      this._memos = {};
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = app.t('plot.error.delete');
    } finally { this.busy = false; }
  },

  // Akt-Reihenfolge per Pfeil-Button verschieben (a11y statt Drag der Spalten).
  // Position ist PRO SCOPE (geteilt vs. strang-eigen) — nur innerhalb desselben
  // thread_id-Scopes umsortieren, der andere Scope bleibt unberührt.
  async moveAct(act, dir) {
    const app = window.__app;
    const scope = act.thread_id ?? null;
    const ordered = (this.acts || [])
      .filter(a => (a.thread_id ?? null) === scope)
      .sort((a, b) => a.position - b.position);
    const idx = ordered.findIndex(a => a.id === act.id);
    const swap = idx + dir;
    if (idx < 0 || swap < 0 || swap >= ordered.length) return;
    const orderBefore = ordered.map(a => a.id); // Undo-Ziel (Reihenfolge dieses Scopes)
    [ordered[idx], ordered[swap]] = [ordered[swap], ordered[idx]];
    ordered.forEach((a, i) => { a.position = i; });
    // Nur die Akte dieses Scopes ersetzen, der Rest bleibt.
    const byId = new Map(ordered.map(a => [a.id, a]));
    this.acts = (this.acts || []).map(a => byId.get(a.id) || a);
    this._memos = {};
    try {
      await fetchJson('/plot/acts/order', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: Alpine.store('nav').selectedBookId, order: ordered.map(a => a.id) }),
      });
      this._recordActOrder(orderBefore, ordered.map(a => a.id));
    } catch (e) { this.errorMessage = app.t('plot.error.save'); }
  },

  // ── Akt scoped hinzufügen (Grid: geteilt ODER strang-eigen) ─────────────────
  // addingActScope: false = aus, null = geteilter Akt, <threadId> = strang-eigen.
  // Datenattribut-Schlüssel fürs Fokussieren: 'shared' bzw. die Strang-ID.
  _addActScopeKey(threadId) { return threadId == null ? 'shared' : String(threadId); },

  startAddAct(threadId = null) {
    this.addingActScope = threadId;
    this.newActName = '';
    this.$nextTick(() => {
      const sel = `[data-add-act-scope="${this._addActScopeKey(threadId)}"] .plot-new-act-input`;
      this.$root?.querySelector(sel)?.focus();
    });
  },
  cancelAddAct() { this.addingActScope = false; this.newActName = ''; },

  async addActScoped() {
    const app = window.__app;
    const threadId = this.addingActScope; // false darf hier nicht ankommen
    const name = (this.newActName || '').trim();
    if (!name) { this.errorMessage = app.t('plot.error.nameRequired'); return; }
    this.busy = true;
    try {
      const act = await fetchJson('/plot/acts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: Alpine.store('nav').selectedBookId, name, thread_id: threadId == null ? null : threadId }),
      });
      this.acts = [...this.acts, act];
      this._memos = {};
      this._recordCreate('act', act?.id);
      this.newActName = '';
      this.addingActScope = false;
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = app.t('plot.error.save');
    } finally { this.busy = false; }
  },

  // ── Hybrid-Akte: eigene Aktstruktur eines Strangs an-/ausschalten ───────────
  // Aktivieren klont die geteilten Akte in den Strang (Server) und hängt dessen
  // Beats auf die Klone um — danach Board neu laden (act_id-Remap betrifft viele
  // Beats, lokales Spiegeln wäre fehleranfällig).
  async forkThreadActs(thread) {
    const app = window.__app;
    if (!this.sharedActs().length) { this.errorMessage = app.t('plot.thread.forkNoActs'); return; }
    if (!await app.appConfirm({
      message: app.t('plot.thread.confirmFork', { name: thread.name }),
      confirmLabel: app.t('plot.thread.ownActs'),
    })) return;
    this.busy = true;
    try {
      await fetchJson(`/plot/threads/${thread.id}/fork-acts`, { method: 'POST' });
      await this.loadBoard();
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = app.t('plot.error.save');
    } finally { this.busy = false; }
  },

  // Auflösen: Beats positionsweise zurück auf die geteilten Akte, eigene Akte weg.
  async unforkThreadActs(thread) {
    const app = window.__app;
    if (!await app.appConfirm({
      message: app.t('plot.thread.confirmUnfork', { name: thread.name }),
      confirmLabel: app.t('plot.thread.sharedActs'),
      danger: true,
    })) return;
    this.busy = true;
    try {
      await fetchJson(`/plot/threads/${thread.id}/fork-acts`, { method: 'DELETE' });
      await this.loadBoard();
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = app.t('plot.error.save');
    } finally { this.busy = false; }
  },
};
