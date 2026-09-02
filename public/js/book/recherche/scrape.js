// Link eines Recherche-Fundstuecks serverseitig lesen lassen („scrapen") und
// Titel/Text/Herkunft uebernehmen — POST /research/:id/scrape.
//
// Die Aktion haengt an der EINZELNEN Link-Zeile, nicht am Fundstueck: ein Fund
// sammelt beliebig viele URLs, und welche davon der Artikel ist, weiss nur der
// User (dieselbe Ueberlegung wie bei „als Quelle uebernehmen", from-research.js).
//
// Der Server fuellt per Default NUR leere Felder und meldet in `skipped`, was er
// deshalb stehen gelassen hat. Erst darauf fragen wir nach und schicken
// `overwrite` — ein Knopf, der eigenen Text ohne Rueckfrage durch Fremdtext
// ersetzt, ist kein Knopf, den man zweimal drueckt.
import { fetchJson } from '../../utils.js';

// error_code → i18n-Key. Die Faelle sind bewusst getrennt, weil sie zu
// verschiedenen Handlungen fuehren: URL korrigieren, spaeter erneut versuchen,
// oder die Browser-Erweiterung nehmen (die liest die gerenderte Seite).
const SCRAPE_ERRORS = {
  NO_URL: 'recherche.scrape.noUrl',
  INVALID_URL: 'recherche.scrape.invalidUrl',
  SCRAPE_BLOCKED: 'recherche.scrape.blocked',
  SCRAPE_NOT_HTML: 'recherche.scrape.notHtml',
  SCRAPE_EMPTY: 'recherche.scrape.empty',
  SCRAPE_TIMEOUT: 'recherche.scrape.timeout',
  SCRAPE_TOO_LARGE: 'recherche.scrape.tooLarge',
};

export const rechercheScrapeMethods = {
  // Schluessel des Busy-Flags: Fundstueck + Link (Muster urlToSourceKey).
  urlScrapeKey(item, u) { return `${item.id}:${u.url_id}`; },
  urlScrapeBusy(item, u) { return !!this._scrapeBusy[this.urlScrapeKey(item, u)]; },

  async scrapeUrl(item, u, { overwrite = false } = {}) {
    const app = window.__app;
    if (!item || !u?.url_id) return;
    const key = this.urlScrapeKey(item, u);
    if (this._scrapeBusy[key]) return;
    // Reassign statt In-Place-Mutate, damit Alpine die Aenderung im
    // verschachtelten x-for sicher sieht (wie _toSourceBusy).
    this._scrapeBusy = { ...this._scrapeBusy, [key]: true };
    try {
      const r = await fetchJson(`/research/${item.id}/scrape`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url_id: u.url_id, overwrite }),
      });
      if (r?.item) this._replaceItem(r.item);
      this.errorMessage = '';

      const filled = r?.filled || [];
      const skipped = r?.skipped || [];
      // Nichts uebernommen, aber etwas stehen gelassen → das ist keine Panne,
      // sondern die Nachfrage: die Seite hat Inhalt, das Fundstueck aber auch.
      if (!filled.length && skipped.length) {
        if (overwrite) return;
        const ok = await app.appConfirm({
          message: app.t('recherche.scrape.confirmOverwrite', {
            fields: skipped.map(f => app.t(`recherche.scrape.field.${f}`)).join(', '),
          }),
          confirmLabel: app.t('recherche.scrape.overwrite'),
          danger: true,
        });
        if (ok) await this.scrapeUrl(item, u, { overwrite: true });
        return;
      }
      if (!filled.length) {
        this.errorMessage = app.t('recherche.scrape.nothingNew');
        return;
      }
      app?._showJobToast?.({
        message: app.t(r.truncated ? 'recherche.scrape.doneTruncated' : 'recherche.scrape.done', {
          fields: filled.map(f => app.t(`recherche.scrape.field.${f}`)).join(', '),
        }),
        // Nur 'ok' und 'err' sind gestylt (components/job-toast.css) — die
        // Kappung steht darum im Text, nicht in einer dritten Schwere.
        severity: 'ok',
        jobType: 'research',
        bookId: window.Alpine?.store('nav').selectedBookId ?? null,
      });
    } catch (e) {
      // `code` ist der `error_code` der Antwort (utils/net.js#fetchJson).
      const msgKey = SCRAPE_ERRORS[e?.code];
      this.errorMessage = msgKey ? app.t(msgKey) : app.t('recherche.scrape.error');
    } finally {
      const next = { ...this._scrapeBusy };
      delete next[key];
      this._scrapeBusy = next;
    }
  },
};
