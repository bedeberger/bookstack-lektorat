// Struktur-Werkstatt: Textsorte pro Beitrag setzen und die Form dagegen prüfen.
//
// Zwei Dinge in einer Karte, weil sie dasselbe Objekt betreffen: die Textsorte
// ist das SOLL (was für ein Text soll das sein), der Struktur-Befund das IST
// (hält er die Form ein). Eine Karte, die nur prüft, ohne die Textsorte setzen
// zu lassen, wäre die halbe Bewegung.
//
// Die Karte schreibt nie in den Manuskript-Text — sie stellt Befunde neben ihn.

import { fetchJson } from '../utils.js';
import { startPoll } from '../cards/job-helpers.js';
import { TEXTSORTEN, TEXTSORTE_KEYS, textsorte as textsorteDef } from '../prompts/textsorten.js';

const LS_KEY = (bookId) => `struktur_job_${bookId}`;

// Urteil → Badge-Klasse. Reihenfolge der Schwere ist auch die Sortierreihenfolge
// in der Tabelle (schlechteste zuerst) — der Befund soll oben stehen.
const URTEIL_RANK = { verfehlt: 0, lueckenhaft: 1, traegt: 2 };
const STATUS_RANK = { fehlt: 0, teilweise: 1, nicht_anwendbar: 2, erfuellt: 3 };

export const strukturMethods = {
  get strukturTextsorten() { return TEXTSORTEN; },
  get strukturTextsorteKeys() { return TEXTSORTE_KEYS; },

  /** Combobox-Optionen: die neun Textsorten, plus „ohne" als Leerwert. */
  strukturTextsorteOptions() {
    return TEXTSORTE_KEYS.map(k => ({ value: k, label: window.__app.t(`textsorte.${k}`) }));
  },

  async loadStruktur() {
    const bookId = window.Alpine?.store('nav')?.selectedBookId;
    if (!bookId) return;
    this.strukturLoadError = false;
    try {
      const data = await fetchJson(`/textsorte/${bookId}`);
      this.strukturBookTextsorte = data.book_textsorte || '';
      this.strukturPageMap = data.pages || {};
      const byPage = {};
      for (const c of (data.checks || [])) byPage[String(c.page_id)] = c;
      this.strukturChecks = byPage;
      this._strukturMemos = {};
    } catch {
      this.strukturLoadError = true;
    }
  },

  /** Zeilen der Tabelle: alle Seiten des Buchs mit Textsorte und letztem Befund. */
  strukturRows() {
    const pages = window.__app?.$store?.nav?.pages || [];
    const key = `${pages.length}|${Object.keys(this.strukturPageMap).length}|${Object.keys(this.strukturChecks).length}|${this.strukturBookTextsorte}|${this._strukturRev}`;
    if (this._strukturRowsKey === key) return this._strukturRows;
    const chapters = window.__app?.$store?.nav?.tree || [];
    const chapterName = {};
    const walk = (nodes) => {
      for (const n of nodes || []) {
        if (n.type === 'chapter') { chapterName[String(n.id)] = n.name; walk(n.children); }
      }
    };
    walk(chapters);
    const rows = pages.map(p => {
      const own = this.strukturPageMap[String(p.id)] || null;
      const eff = own || this.strukturBookTextsorte || null;
      const check = this.strukturChecks[String(p.id)] || null;
      return {
        id: p.id,
        name: p.name || '',
        chapter: p.chapter_id ? (chapterName[String(p.chapter_id)] || '') : '',
        ownTextsorte: own || '',
        textsorte: eff,
        textsorteLabel: eff ? window.__app.t(`textsorte.${eff}`) : '',
        // Der Befund gilt nur, wenn er zur JETZT eingestellten Textsorte gehoert —
        // sonst zeigt die Karte ein Urteil, das gegen einen anderen Katalog erging.
        check: (check && check.textsorte === eff) ? check : null,
        urteil: (check && check.textsorte === eff) ? (check.gesamturteil || '') : '',
        _rank: (check && check.textsorte === eff) ? (URTEIL_RANK[check.gesamturteil] ?? 3) : 4,
      };
    });
    this._strukturRowsKey = key;
    this._strukturRows = rows;
    return rows;
  },

  /** Regel-Zeilen des offenen Befunds, schlechteste zuerst. */
  strukturDetailRegeln(row) {
    const regeln = row?.check?.result?.regeln || [];
    const def = textsorteDef(row?.textsorte);
    return regeln
      .map(r => ({ ...r, text: def?.regeln?.[r.nr - 1] || '' }))
      .slice()
      .sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || a.nr - b.nr);
  },

  /** Beitrag im Editor oeffnen. Geht ueber die Seiten-Liste des Roots, weil
   *  `selectPage` das Seiten-Objekt erwartet, nicht nur die ID. */
  strukturOpenPage(row) {
    const page = (window.__app?.$store?.nav?.pages || []).find(p => String(p.id) === String(row.id));
    if (page) window.__app.selectPage(page);
  },

  strukturOpenRow(row) {
    this.strukturOpenId = this.strukturOpenId === row.id ? null : row.id;
  },

  /** Textsorte einer einzelnen Seite setzen (leer = Buch-Default gilt wieder).
   *
   *  No-Op-Vergleich gegen `strukturPageMap`, NICHT gegen `row.ownTextsorte`:
   *  die Combobox schreibt ihren Wert über `x-model` in die Zeile, bevor
   *  `@combobox-change` feuert — ein Vergleich mit der Zeile vergliche den
   *  neuen Wert mit sich selbst und spränge immer heraus, ohne zu speichern. */
  async setPageTextsorte(row, value) {
    const v = value || null;
    const gespeichert = this.strukturPageMap[String(row.id)] || '';
    if (gespeichert === (v || '')) return;
    try {
      await fetchJson(`/textsorte/page/${row.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ textsorte: v }),
      });
      if (v) this.strukturPageMap[String(row.id)] = v;
      else delete this.strukturPageMap[String(row.id)];
      this._strukturRev++;
    } catch {
      this.strukturError = window.__app.t('struktur.saveError');
    }
  },

  /** Vorherrschende Textsorte des Buchs (Default fuer Seiten ohne Override). */
  async setBookTextsorte(value) {
    const bookId = window.Alpine?.store('nav')?.selectedBookId;
    if (!bookId) return;
    const v = value || null;
    try {
      await fetchJson(`/booksettings/${bookId}/textsorte`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ textsorte: v }),
      });
      this.strukturBookTextsorte = v || '';
      this._strukturRev++;
    } catch {
      this.strukturError = window.__app.t('struktur.saveError');
    }
  },

  /** Struktur-Check starten — fuer das ganze Buch oder eine einzelne Seite. */
  async runStrukturCheck(pageId = null) {
    const bookId = window.Alpine?.store('nav')?.selectedBookId;
    if (!bookId || this.strukturRunning) return;
    this.strukturRunning = true;
    this.strukturError = '';
    this.strukturProgress = 0;
    this.strukturStatus = window.__app.t('common.analysisRunning');
    try {
      const body = pageId ? { page_id: pageId } : { book_id: bookId };
      const { jobId } = await fetchJson('/jobs/struktur-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      localStorage.setItem(LS_KEY(bookId), jobId);
      this._pollStruktur(jobId);
    } catch {
      this._strukturIdle();
      this.strukturError = window.__app.t('struktur.runError');
    }
  },

  _pollStruktur(jobId) {
    const bookId = window.Alpine?.store('nav')?.selectedBookId;
    startPoll(this, {
      timerProp: '_strukturPollTimer',
      jobId,
      lsKey: LS_KEY(bookId),
      progressProp: 'strukturProgress',
      onProgress: (job) => {
        this.strukturStatus = window.__app.t(job.statusText, job.statusParams);
      },
      onDone: async (job) => {
        this._strukturIdle();
        this.strukturLastRun = {
          geprueft: job.result?.geprueft || 0,
          uebersprungen: job.result?.uebersprungen || 0,
          ohneTextsorte: job.result?.ohneTextsorte || 0,
          zuKurz: job.result?.zuKurz || 0,
        };
        await this.loadStruktur();
      },
      onNotFound: () => {
        this._strukturIdle();
        this.strukturError = window.__app.t('struktur.interrupted');
      },
      onError: (job) => {
        this._strukturIdle();
        this.strukturError = window.__app.t(job.error, job.errorParams);
      },
    });
  },

  /** Reconnect nach Reload (app-jobs-core.js#checkPendingJobs). */
  reconnectStruktur(job, jobId) {
    this.strukturRunning = true;
    this.strukturProgress = job?.progress || 0;
    this.strukturError = '';
    this.strukturStatus = window.__app.t(job?.statusText || 'common.analysisRunning', job?.statusParams);
    this._pollStruktur(jobId);
  },

  _strukturIdle() {
    this.strukturRunning = false;
    this.strukturProgress = 0;
    this.strukturStatus = '';
  },
};
