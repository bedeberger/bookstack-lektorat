// Titel-Werkstatt: Dachzeile, Titel, Lead und Teaser eines Beitrags.
//
// Die vier sind METADATA der Seite, nicht ihre ersten Absätze — genau das ist
// der Zweck. Als Spalten sind sie adressierbar: der Blog-Sync nimmt Titel und
// Teaser direkt, der Zeichenzähler weiss, wo der Titel aufhört, und keiner der
// vier fällt der Wortschatz-Analyse als Prosa in die Hände.
//
// Die Karte schreibt nie in den Manuskript-Text. Sie schreibt nach
// `page_headline` (geltender Stand) und `page_headline_variants` (Kandidaten).
//
// Zwei Ebenen: die Tabelle zeigt alle Beiträge des Buchs mit ihrem Titelstand,
// eine aufgeklappte Zeile zeigt die vier Felder mit Kanal-Linealen und
// Varianten. Ohne die Tabelle sieht man nie, welcher Beitrag noch keinen Titel
// hat — und das ist die Frage, die eine Redaktion vor Schluss stellt.

import { fetchJson, sendJson } from '../utils/net.js';
import { startPoll } from '../cards/job-helpers.js';
import {
  HEADLINE_FIELDS, HEADLINE_LONG_FIELDS, HEADLINE_CHANNELS,
  channelFit, tightestLimit, fieldLabelKey, channelLabelKey,
} from '../headline/channels.js';

const LS_KEY = (pageId) => `headline_job_${pageId}`;

export const titelwerkstattMethods = {
  get twFields() { return HEADLINE_FIELDS; },
  get twChannels() { return HEADLINE_CHANNELS; },

  twIsLong(feld) { return HEADLINE_LONG_FIELDS.includes(feld); },
  twFieldLabel(feld) { return window.__app.t(fieldLabelKey(feld)); },
  twChannelLabel(key) { return window.__app.t(channelLabelKey(key)); },

  // ── Laden ──────────────────────────────────────────────────────────────────

  async loadTitelwerkstatt() {
    const bookId = window.Alpine?.store('nav')?.selectedBookId;
    if (!bookId) return;
    this.twLoadError = false;
    try {
      const data = await fetchJson(`/headline/${bookId}`);
      this.twEnabled = !!data.enabled;
      this.twPages = data.pages || {};
      this._twRev++;
    } catch {
      this.twLoadError = true;
    }
  },

  /** Zeilen der Übersicht: alle Beiträge mit ihrem Titelstand. */
  twRows() {
    const pages = window.__app?.$store?.nav?.pages || [];
    const key = `${pages.length}|${Object.keys(this.twPages).length}|${this._twRev}`;
    if (this._twRowsKey === key) return this._twRows;
    const rows = pages.map(p => {
      const h = this.twPages[String(p.id)] || null;
      return {
        id: p.id,
        name: p.name || '',
        dachzeile: h?.dachzeile || '',
        titel: h?.titel || '',
        lead: h?.lead || '',
        teaser: h?.teaser || '',
        // „Wie weit ist der Titelapparat" — die Zahl, nach der man vor Schluss
        // sortiert. Ein Beitrag ohne Titel ist nicht fertig, egal wie gut er ist.
        gesetzt: HEADLINE_FIELDS.filter(f => (h?.[f] || '').trim()).length,
      };
    });
    this._twRowsKey = key;
    this._twRows = rows;
    return rows;
  },

  /** Wie viele Beiträge haben schon einen Titel? Kopfzeile der Karte. */
  twMitTitel() {
    return this.twRows().filter(r => r.titel).length;
  },

  // ── Eine Zeile öffnen ──────────────────────────────────────────────────────

  async twToggleRow(pageId) {
    if (this.twOpenId === pageId) { this.twOpenId = null; return; }
    this.twOpenId = pageId;
    this.twDraft = {};
    this.twVariants = {};
    this.twError = '';
    try {
      const data = await fetchJson(`/headline/page/${pageId}`);
      const h = data.headline || {};
      for (const f of HEADLINE_FIELDS) this.twDraft[f] = h[f] || '';
      this.twVariants = data.varianten || {};
    } catch {
      this.twError = window.__app.t('headline.loadError');
    }
  },

  /**
   * Ein Feld speichern. Gespeichert wird beim Verlassen des Feldes, nicht bei
   * jedem Tastendruck: ein Titel entsteht durch Umformulieren, und jede
   * Zwischenstufe zu persistieren hiesse, `updated_at` im Sekundentakt zu
   * bewegen — woran unter anderem die Stale-Erkennung des Redaktions-Status
   * hängt.
   */
  async twSaveField(pageId, feld) {
    if (!HEADLINE_FIELDS.includes(feld)) return;
    const val = String(this.twDraft[feld] ?? '');
    if (val === (this.twPages[String(pageId)]?.[feld] || '')) return;
    this.twSaving = { ...this.twSaving, [feld]: true };
    this.twError = '';
    try {
      const r = await sendJson(`/headline/page/${pageId}`, 'PUT', { [feld]: val });
      this._twApplyHeadline(pageId, r.headline);
    } catch {
      this.twError = window.__app.t('headline.saveError');
    } finally {
      const busy = { ...this.twSaving };
      delete busy[feld];
      this.twSaving = busy;
    }
  },

  /** Antwort des Servers in Tabelle und Entwurf zurückspiegeln. */
  _twApplyHeadline(pageId, headline) {
    const next = { ...this.twPages };
    if (headline) next[String(pageId)] = headline; else delete next[String(pageId)];
    this.twPages = next;
    for (const f of HEADLINE_FIELDS) this.twDraft[f] = headline?.[f] || '';
    this._twRev++;
  },

  // ── Kanal-Lineal ───────────────────────────────────────────────────────────

  /** Je Kanal `{ key, limit, len, fits, over }` für den aktuellen Entwurf. */
  twFit(feld) {
    return channelFit(feld, this.twDraft[feld] || '');
  },

  twLen(feld) {
    return String(this.twDraft[feld] || '').trim().length;
  },

  /**
   * Füllstand gegen den ENGSTEN Kanal — der reisst zuerst, und an ihm misst man
   * beim Schreiben. Über 100% wird gekappt, damit der Balken nicht ausläuft;
   * dass es zu lang ist, sagt ohnehin die Kanal-Liste mit der Zahl.
   */
  twFillPct(feld) {
    const limit = tightestLimit(feld);
    if (!limit) return 0;
    return Math.min(100, Math.round((this.twLen(feld) / limit) * 100));
  },

  /** Passt der Entwurf in ALLE Kanäle, in einige, in keinen? */
  twFitState(feld) {
    const fits = this.twFit(feld);
    if (!fits.length || !this.twLen(feld)) return 'leer';
    const ok = fits.filter(f => f.fits).length;
    if (ok === fits.length) return 'passt';
    return ok > 0 ? 'teilweise' : 'zulang';
  },

  // ── Varianten ──────────────────────────────────────────────────────────────

  twVariantsFor(feld) { return this.twVariants[feld] || []; },

  async twAddVariant(pageId, feld) {
    const text = String(this.twNewVariant[feld] || '').trim();
    if (!text) return;
    try {
      const r = await sendJson(`/headline/page/${pageId}/variants`, 'POST', { feld, text });
      this.twVariants = r.varianten || this.twVariants;
      this.twNewVariant = { ...this.twNewVariant, [feld]: '' };
    } catch {
      this.twError = window.__app.t('headline.saveError');
    }
  },

  /** Variante übernehmen: wird geltender Stand, der bisherige wird als Variante
   *  gesichert (Server-Seite) — jede Übernahme bleibt umkehrbar. */
  async twPromote(variantId) {
    try {
      const r = await sendJson(`/headline/variants/${variantId}/promote`, 'POST');
      this.twVariants = r.varianten || this.twVariants;
      this._twApplyHeadline(r.page_id, r.headline);
    } catch {
      this.twError = window.__app.t('headline.saveError');
    }
  },

  async twDeleteVariant(variantId) {
    try {
      const r = await sendJson(`/headline/variants/${variantId}`, 'DELETE');
      this.twVariants = r.varianten || this.twVariants;
    } catch {
      this.twError = window.__app.t('headline.saveError');
    }
  },

  // ── KI-Vorschläge ──────────────────────────────────────────────────────────

  _twIdle() {
    this.twRunning = false;
    this.twProgress = 0;
    this.twStatus = '';
    if (this._twPollTimer) { clearInterval(this._twPollTimer); this._twPollTimer = null; }
  },

  /**
   * Varianten vorschlagen lassen. Läuft immer für GENAU einen Beitrag —
   * Titelarbeit ist Einzelstückarbeit, ein Stapellauf produziert Listen, die
   * niemand durchsieht.
   */
  async twSuggest(pageId) {
    if (this.twRunning) return;
    this.twRunning = true;
    this.twError = '';
    this.twProgress = 0;
    this.twStatus = window.__app.t('common.analysisRunning');
    try {
      const { jobId } = await sendJson('/jobs/headline-variants', 'POST', {
        page_id: pageId, felder: this.twSuggestFields.slice(),
      });
      localStorage.setItem(LS_KEY(pageId), jobId);
      this._twPoll(jobId, pageId);
    } catch {
      this._twIdle();
      this.twError = window.__app.t('headline.runError');
    }
  },

  _twPoll(jobId, pageId) {
    startPoll(this, {
      timerProp: '_twPollTimer',
      jobId,
      lsKey: LS_KEY(pageId),
      progressProp: 'twProgress',
      onProgress: (job) => {
        this.twStatus = window.__app.t(job.statusText, job.statusParams);
      },
      onDone: (job) => {
        this._twIdle();
        this.twLastRun = {
          angelegt: job.result?.angelegt || 0,
          verworfen: job.result?.verworfen || 0,
          zuKurz: !!job.result?.zuKurz,
        };
        // Der Job liefert die frische Variantenliste mit — kein zweiter Fetch.
        if (job.result?.varianten && this.twOpenId === pageId) {
          this.twVariants = job.result.varianten;
        }
      },
      onNotFound: () => {
        this._twIdle();
        this.twError = window.__app.t('headline.interrupted');
      },
      onError: (job) => {
        this._twIdle();
        this.twError = window.__app.t(job.error, job.errorParams);
      },
    });
  },

  /** Reconnect nach Reload (app-jobs-core.js#checkPendingJobs). */
  twReconnect(jobId, pageId) {
    this.twRunning = true;
    this.twStatus = window.__app.t('common.analysisRunning');
    this._twPoll(jobId, pageId);
  },
};
