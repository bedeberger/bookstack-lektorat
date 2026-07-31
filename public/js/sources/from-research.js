// Bruecke Recherche-Board → Quellen-Bibliothek: einen Link eines Fundstuecks als
// Quellen-ENTWURF in die Bibliothek uebernehmen (`POST /sources/from-research`).
// Wird in die Recherche-Karte gespreadet (analog researchChatMethods) und liegt
// bewusst hier statt in book/recherche.js — die Fachlogik ist die der Quellen.
//
// Ein Fundstueck sammelt beliebig viele URLs; welche davon der Nachweis ist,
// weiss nur der User. Darum haengt die Aktion an der EINZELNEN Link-Zeile und
// schickt deren `url_id` mit, statt fuer das ganze Fundstueck zu raten.
//
// Bewusst KEINE „schon uebernommen"-Markierung: der Server erlaubt dieselbe URL
// zweimal (zwei Nachweise mit unterschiedlichen Angaben), und ohne eine
// persistierte Verknuepfung Fund-URL ↔ Quelle waere jede Anzeige geraten. Die
// Karte merkt sich nur den laufenden Klick.
import { sendJson } from '../utils.js';

export const rechercheToSourceMethods = {
  // Schluessel des Busy-Flags: Fundstueck + Link. `_toSourceBusy` ist in
  // recherche-card.js deklariert und wird per Reassign (kein In-Place-Mutate)
  // gesetzt, damit Alpine die Aenderung im verschachtelten x-for sicher sieht.
  urlToSourceKey(item, u) { return `${item.id}:${u.url_id}`; },
  urlToSourceBusy(item, u) { return !!this._toSourceBusy[this.urlToSourceKey(item, u)]; },

  async urlToSource(item, u) {
    const app = window.__app;
    if (!item || !u?.url_id) return;
    const key = this.urlToSourceKey(item, u);
    if (this._toSourceBusy[key]) return;
    this._toSourceBusy = { ...this._toSourceBusy, [key]: true };
    try {
      const src = await sendJson('/sources/from-research', 'POST', {
        item_id: item.id,
        url_id: u.url_id,
      });
      // Kein Ansichtswechsel: der User arbeitet im Board weiter, die Quelle
      // liegt als Entwurf in der Quellen-Karte und wird dort nachgeschaerft.
      app?._showJobToast?.({
        message: app.t('recherche.toSource.done', { title: src?.title || u.url }),
        severity: 'ok',
        jobType: 'source',
        bookId: window.Alpine?.store('nav').selectedBookId ?? null,
      });
      this.errorMessage = '';
    } catch (e) {
      // 400 ist hier praktisch immer SOURCE_IDENTITY_REQ: ein Fundstueck ohne
      // Titel und ein Link ohne Label geben keiner Quelle einen Namen. Das ist
      // behebbar (Titel nachtragen) und verdient darum eine eigene Ansage.
      this.errorMessage = e?.status === 400
        ? app.t('recherche.toSource.needsTitle')
        : app.t('recherche.toSource.error');
    } finally {
      const next = { ...this._toSourceBusy };
      delete next[key];
      this._toSourceBusy = next;
    }
  },
};
