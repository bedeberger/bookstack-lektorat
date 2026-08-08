// editorPageHeadCard — Titel-Kopf des Beitrags im NOTEBOOK-EDITOR.
//
// Zeigt Dachzeile, Titel und Lead über dem Seiteninhalt — in der Leseansicht
// gesetzt wie im Ausgabeweg, im Edit-Modus als Eingabefelder. Damit steht beim
// Schreiben sichtbar, worauf der Text zuläuft; bisher sah man den Titelapparat
// nur in der Titel-Werkstatt, also gerade nicht dort, wo man am Text arbeitet.
//
// NUR DER NOTEBOOK-EDITOR. Der Focus-Editor ist der Vollbild-Schreibmodus — ein
// Kopf über der Schreiblinie griffe in seine Höhenkette ein, und er blendet aus
// gutem Grund alles aus, was nicht der laufende Satz ist. Der Bucheditor zeigt
// den Manuskript-Stream über das ganze Ressort; dort gehört der Kopf an jeden
// Beitrag und nicht an eine Karte (eigenes Vorhaben, siehe docs/journalismus.md).
//
// ZWEITER SCHREIBPFAD, BEWUSST GETRENNT: gespeichert wird über
// `PUT /headline/page/:id` (dieselbe Route wie in der Titel-Werkstatt), NICHT
// über den Seiten-Save. Der Kopf steht in `page_headline`, nicht in
// `pages.content` — er kann den Editor-Konflikt-/Stale-Pfad also weder auslösen
// noch stören, und `pages.updated_at` bewegt sich durch ihn nicht (woran unter
// anderem die Stale-Erkennung des Redaktions-Status hängt).
//
// Gespeichert wird beim VERLASSEN des Feldes, nicht bei jedem Anschlag — ein
// Titel entsteht durch Umformulieren, und jede Zwischenstufe zu persistieren
// hiesse, vierzig Fassungen einer halben Schlagzeile zu schreiben. Gleiche Regel
// wie in der Titel-Werkstatt (public/js/book/titelwerkstatt.js#twSaveField).

import { EVT } from '../events.js';
import { fetchJson, sendJson } from '../utils/net.js';
import { setupCardLifecycle } from './card-lifecycle.js';
import { isJournalisticBuchtyp } from './feature-registry.js';
import { readEditorPrefs } from '../editor/notebook/storage.js';
import {
  HEADLINE_HEAD_FIELDS, HEADLINE_LONG_FIELDS,
  fieldLen, fillPct, fitState, overChannels, fieldLabelKey, channelLabelKey,
} from '../headline/channels.js';

const EMPTY = () => ({ dachzeile: '', titel: '', lead: '' });

export function registerEditorPageHeadCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('editorPageHeadCard', () => ({
    // Entwurf der drei Kopf-Felder (immer alle drei gesetzt, nie undefined —
    // sonst hängt x-model an einem nicht existierenden Schlüssel).
    headDraft: EMPTY(),
    // Zuletzt vom Server bestätigter Stand. Vergleichsbasis für „hat sich beim
    // Verlassen des Feldes überhaupt etwas geändert".
    headSaved: EMPTY(),
    // Seite, zu der Entwurf und Stand gehören. Verhindert, dass eine spät
    // eintreffende Antwort den Kopf der inzwischen geöffneten Seite überschreibt.
    headPageId: null,
    headSaving: {},
    headError: '',
    // Erst nach dem ersten erfolgreichen Laden anzeigen — sonst blitzt beim
    // Seitenwechsel ein leerer Kopf auf.
    headLoaded: false,
    _headLifecycle: null,
    _headFetchSeq: 0,

    init() {
      // Anzeige-Wahl aus den Editor-Prefs holen. Der zweite Restore-Punkt sitzt
      // in edit/lifecycle.js#startEdit — der greift aber erst beim ersten
      // Eintritt in den Bearbeitungsmodus, und der Kopf steht auch im
      // Lesemodus. Beide lesen dieselbe SSoT (notebook/storage.js).
      try {
        const app = window.__app;
        if (app) app.pageEditorShowHead = readEditorPrefs().showHead;
      } catch { /* Default aus app-state (an) bleibt stehen */ }

      this._headLifecycle = setupCardLifecycle(this, {
        name: 'editorPageHead',
        resetState: () => ({
          headDraft: EMPTY(), headSaved: EMPTY(), headPageId: null,
          headSaving: {}, headError: '', headLoaded: false,
        }),
      });
      // Seitenwechsel im Editor lädt den Kopf neu. Der Watch hängt am Root
      // (window.__app), nicht am eigenen Scope — die Seite ist Root-State.
      this.$watch(() => window.__app?.currentPage?.id, (id) => this._headLoad(id));
      this._headLoad(window.__app?.currentPage?.id);
    },

    destroy() { this._headLifecycle?.destroy(); },

    // ── Sichtbarkeit ─────────────────────────────────────────────────────────

    /**
     * Hat dieser Beitrag überhaupt einen Titelapparat? In einem Roman gibt es
     * keine Dachzeile — gleiches Gate wie die Titel-Werkstatt, nicht
     * abschaltbar. Steuert AUCH das Laden.
     */
    headAvailable() {
      const app = window.__app;
      if (!app?.currentPage) return false;
      return isJournalisticBuchtyp(app.currentBuchtyp?.());
    },

    /**
     * Wird er gerade gezeigt? Zusätzlich zur Verfügbarkeit die Anzeige-Wahl des
     * Users (Toolbar-Knopf, `pageEditorShowHead`). Sie blendet nur aus — die
     * gespeicherten Felder, der Share-Reader und jeder Export bleiben unberührt.
     *
     * Bewusst NICHT die Lade-Bedingung: sonst stünde der Kopf nach dem
     * Wiedereinschalten leer da, bis jemand die Seite wechselt.
     */
    headVisible() {
      return this.headAvailable() && !!window.__app?.pageEditorShowHead;
    },

    /**
     * Steht der Kopf gerade da? EINE Stelle für die Anzeige-Bedingung, weil das
     * Markup sie zweimal braucht: `x-show` blendet ein, `page-head--shown`
     * meldet es dem Blatt darunter — das gibt seine obere Rundung nur auf,
     * solange der Kopf sie fortsetzt (page-head.css). Zwei getrennt gepflegte
     * Ausdrücke drifteten auseinander und liessen ein Blatt mit gekappter
     * Oberkante ohne Kopf stehen.
     */
    headShown() {
      return this.headVisible() && (!!window.__app?.editMode || this.headHasContent());
    },

    headFields() { return HEADLINE_HEAD_FIELDS; },
    headIsLong(feld) { return HEADLINE_LONG_FIELDS.includes(feld); },
    headFieldLabel(feld) { return window.__app.t(fieldLabelKey(feld)); },

    /** Steht im Lesemodus überhaupt etwas da? Ein leerer Kopf soll dort keinen
     *  Platz belegen — im Edit-Modus dagegen schon, sonst kann man ihn nie
     *  füllen. */
    headHasContent() {
      return HEADLINE_HEAD_FIELDS.some(f => (this.headSaved[f] || '').trim());
    },

    // ── Laden ────────────────────────────────────────────────────────────────

    async _headLoad(pageId) {
      const id = pageId ? parseInt(pageId) : null;
      this.headError = '';
      this.headPageId = id;
      this.headDraft = EMPTY();
      this.headSaved = EMPTY();
      this.headLoaded = false;
      if (!id || !this.headAvailable()) return;
      const seq = ++this._headFetchSeq;
      try {
        const data = await fetchJson(`/headline/page/${id}`);
        // Zwischenzeitlicher Seitenwechsel: Antwort verwerfen statt den Kopf
        // der falschen Seite zu zeigen.
        if (seq !== this._headFetchSeq) return;
        const h = data.headline || {};
        const next = EMPTY();
        for (const f of HEADLINE_HEAD_FIELDS) next[f] = h[f] || '';
        this.headDraft = { ...next };
        this.headSaved = { ...next };
        this.headLoaded = true;
      } catch {
        if (seq !== this._headFetchSeq) return;
        this.headError = window.__app.t('headline.loadError');
      }
    },

    // ── Speichern ────────────────────────────────────────────────────────────

    async headSaveField(feld) {
      if (!HEADLINE_HEAD_FIELDS.includes(feld)) return;
      const pageId = this.headPageId;
      if (!pageId || !window.__app?.canEdit?.()) return;
      const val = String(this.headDraft[feld] ?? '');
      if (val === (this.headSaved[feld] || '')) return;
      this.headSaving = { ...this.headSaving, [feld]: true };
      this.headError = '';
      try {
        const r = await sendJson(`/headline/page/${pageId}`, 'PUT', { [feld]: val });
        // Der Server normalisiert (trimmt, faltet Umbrüche) — der bestätigte
        // Stand ist seine Antwort, nicht die Eingabe.
        const h = r.headline || {};
        const next = EMPTY();
        for (const f of HEADLINE_HEAD_FIELDS) next[f] = h[f] || '';
        this.headSaved = { ...next };
        this.headDraft = { ...this.headDraft, [feld]: next[feld] };
        // Die Titel-Werkstatt zeigt dieselben Felder in ihrer Übersicht. Sie ist
        // eine eigene Karte mit eigenem State — ohne dieses Signal steht dort
        // der alte Titel, bis jemand die Karte neu lädt.
        window.dispatchEvent(new CustomEvent(EVT.CARD_REFRESH, { detail: { name: 'titelwerkstatt' } }));
      } catch {
        this.headError = window.__app.t('headline.saveError');
      } finally {
        const busy = { ...this.headSaving };
        delete busy[feld];
        this.headSaving = busy;
      }
    },

    // ── Zeichen-Lineal ───────────────────────────────────────────────────────
    // Nur die knappe Form: Füllstand gegen den ENGSTEN Kanal plus die Kanäle,
    // die reissen. Die vollständige Kanal-Tabelle bleibt der Titel-Werkstatt
    // vorbehalten — im Editor soll der Kopf schmal sein.
    //
    // Gerechnet wird NICHT hier: dasselbe Signal steht auch in der
    // Titel-Werkstatt, und zwei Rechnungen für dieselbe Farbe driften
    // auseinander. Die Stufen leben in headline/channels.js neben den Limits,
    // von denen sie abhängen.

    headLen(feld) { return fieldLen(this.headDraft[feld]); },

    headFillPct(feld) { return fillPct(feld, this.headDraft[feld]); },

    /** 'leer' | 'passt' | 'teilweise' | 'zulang' — treibt die Farbe des Balkens. */
    headFitState(feld) { return fitState(feld, this.headDraft[feld]); },

    /** Die Kanäle, in die es NICHT mehr passt, als kurze Liste für den Tooltip. */
    headOverList(feld) {
      return overChannels(feld, this.headDraft[feld])
        .map(f => `${window.__app.t(channelLabelKey(f.key))} +${f.over}`)
        .join(' · ');
    },
  }));
}
