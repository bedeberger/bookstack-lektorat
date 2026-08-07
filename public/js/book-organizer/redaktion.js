// Redaktions-Slice des Buchorganizers: Stufe pro Beitrag lesen, setzen,
// anzeigen.
//
// Warum im Organizer und nicht als eigene Karte: die Frage „wo steht welcher
// Beitrag" ist eine Frage an die Liste aller Beitraege — und die ist der
// Organizer. Eine zweite Liste daneben waere dieselbe Liste mit einer Spalte
// mehr.
//
// State liegt in der Karte (nicht in einem Store): ausser dem Organizer liest
// ihn niemand. Er wird beim Oeffnen geladen und bei `book:changed`/`view:reset`
// ueber `freshState()` mitgeleert.

import { sendJson, fetchJson } from '../utils/net.js';
import { REDAKTION_STATUS, statusLabelKey } from '../redaktion/status.js';

export const redaktionMethods = {
  /**
   * Stufen-Inventar + gesetzte Stufen des Buchs holen. Fehler sind nicht fatal:
   * der Organizer ist ohne die Spalte vollstaendig benutzbar, und ein roter
   * Kasten ueber der Seitenliste waere unverhaeltnismaessig.
   */
  async loadRedaktion() {
    const bookId = window.__app?.selectedBookId;
    if (!bookId) { this.redaktionEnabled = false; return; }
    try {
      const r = await fetchJson(`/redaktion/${bookId}`);
      this.redaktionEnabled = !!r.enabled;
      this.redaktionByPage = r.pages || {};
      this.redaktionCounts = r.counts || null;
    } catch (_) {
      this.redaktionEnabled = false;
      this.redaktionByPage = {};
      this.redaktionCounts = null;
    }
  },

  /** Eintrag einer Seite oder null. */
  redaktionOf(pageId) {
    return this.redaktionByPage[String(pageId)] || null;
  },

  /**
   * Optionen der Stufen-Auswahl. Erste Option leert die Stufe wieder — ohne sie
   * waere ein versehentlich gesetzter Status nicht mehr zurueckzunehmen.
   */
  redaktionOptions() {
    const t = window.__app?.t?.bind(window.__app) || ((k) => k);
    return [
      { value: '', label: t('redaktion.status.none') },
      ...REDAKTION_STATUS.map(s => ({ value: s, label: t(statusLabelKey(s)) })),
    ];
  },

  /** Anzeige-Label einer Stufe (leer, wenn keine gesetzt ist). */
  redaktionLabel(status) {
    if (!status) return '';
    const t = window.__app?.t?.bind(window.__app) || ((k) => k);
    return t(statusLabelKey(status));
  },

  /**
   * Tooltip der Plakette: Stufe, wer sie gesetzt hat, und die Warnung, falls der
   * Text danach noch bearbeitet wurde. Der Stale-Hinweis ist der eigentliche
   * Wert der Spalte — „freigegeben" auf einem seither geaenderten Text ist die
   * gefaehrlichste Anzeige, die das Feature haben kann.
   */
  redaktionTip(pageId) {
    const e = this.redaktionOf(pageId);
    if (!e) return '';
    const t = window.__app?.t?.bind(window.__app) || ((k) => k);
    const parts = [this.redaktionLabel(e.status)];
    if (e.updated_by) parts.push(e.updated_by);
    if (e.stale) parts.push(t('redaktion.staleHint'));
    return parts.join(' · ');
  },

  /**
   * Stufe setzen (leerer Wert entfernt sie). Optimistisch ist hier bewusst
   * nichts: die Antwort traegt den frisch berechneten `stale`-Wert und den
   * Zeitanker, und beides koennte der Client nicht selbst bilden.
   */
  async setRedaktion(pageId, status) {
    if (!this.redaktionEnabled) return;
    const key = String(pageId);
    const before = this.redaktionByPage[key] || null;
    this.redaktionSaving = { ...this.redaktionSaving, [key]: true };
    try {
      const r = await sendJson(`/redaktion/page/${pageId}`, 'PUT', { status: status || null });
      const next = { ...this.redaktionByPage };
      if (r.entry) next[key] = r.entry; else delete next[key];
      this.redaktionByPage = next;
      this.redaktionCounts = r.counts || null;
    } catch (_) {
      // Zurueck auf den letzten bestaetigten Stand — ein stehengebliebener
      // falscher Status ist schlimmer als gar keiner.
      const next = { ...this.redaktionByPage };
      if (before) next[key] = before; else delete next[key];
      this.redaktionByPage = next;
      this.organizerStatus = window.__app?.t?.('redaktion.saveFailed') || '';
    } finally {
      const busy = { ...this.redaktionSaving };
      delete busy[key];
      this.redaktionSaving = busy;
    }
  },
};
