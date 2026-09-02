// Status-Ebene der Recherche-Karte: die zweite Ansicht des Boards.
//
// Die Liste zeigt den BESTAND (was habe ich gesammelt), das Status-Board den
// FORTSCHRITT (wo steht jeder Fund auf dem Weg in den Buchtext) — Spalten sind
// die vier Stufen aus shared.js#STATUSES, die Karte darin nennt die Stelle im
// Buch, an der der Fund gelandet ist (Kapitel-/Seiten-Verknuepfungen).
//
// Zwei Dinge, die hier bewusst NICHT passieren:
//   * Kein zweiter Lesepfad. Beide Ansichten rendern dieselbe `items`-Liste
//     desselben `/research`-Requests, mit derselben Filterleiste davor — sonst
//     zeigten Liste und Board bei aktivem Filter verschiedene Bestaende.
//   * Keine Reihenfolge INNERHALB einer Spalte. `research_items` hat keine
//     `sort_order`; die Ordnung kommt aus der gewaehlten Sortierung (angeheftet
//     zuerst). Ein Drag traegt darum genau eine Aussage: den neuen Status. Der
//     physische DOM-Move wird immer zurueckgenommen (revertSortable), auch
//     innerhalb derselben Spalte — dort hat er nichts zu bedeuten.

import { loadSortable } from '../../lazy-libs.js';
import {
  patchSortableOnce,
  revertSortable,
  markDragIgnore,
  unmarkDragIgnore,
  BASE_SORTABLE_OPTS,
} from '../../sortable-dnd.js';
import { STATUSES, PLACE_LINK_KINDS } from './shared.js';

export const rechercheStatusMethods = {
  // ── Ansicht ────────────────────────────────────────────────────────────────
  statuses() { return STATUSES; },
  statusLabel(s) { return window.__app.t(`recherche.status.${s}`); },
  // Unbekannter/leerer Wert (Alt-Datensatz, fremder Schreibpfad) zaehlt als
  // 'offen' — die Karte darf nicht aus dem Board fallen, nur weil ihr Status
  // nicht in der Liste steht.
  itemStatus(item) { return STATUSES.includes(item?.status) ? item.status : STATUSES[0]; },

  // Die Plakette in Liste + Detailansicht zeigt die Stufe nur, wenn jemand sie
  // gesetzt hat: `offen` ist der Default, und ihn an jeder Zeile zu wiederholen
  // ist Rauschen ohne Aussage (gleiche Regel wie beim Anheften — „nicht
  // angeheftet" traegt auch kein Abzeichen). Wer die Achse nie benutzt, sieht
  // die Liste unveraendert.
  showStatusBadge(item) { return this.itemStatus(item) !== STATUSES[0]; },

  // Ein Pass ueber `items` fuer alle vier Spalten (Memo-Pattern: die Spalten
  // fragen ihre Liste mehrfach pro Render — Karten UND Zaehler). Deps sind die
  // Listen-Referenz: `_replaceItem` weist `items` neu zu, der Memo verfaellt also
  // bei jeder Statusaenderung.
  statusBuckets() {
    return this._memo('statusBuckets', [this.items], () => {
      const out = {};
      for (const s of STATUSES) out[s] = [];
      for (const it of (this.items || [])) out[this.itemStatus(it)].push(it);
      return out;
    });
  },
  itemsForStatus(status) { return this.statusBuckets()[status] || []; },

  // Ein Memo-Helfer fuer die ganze Karte (harte Regel „Memo-Pattern: ein Helper
  // pro Modul"): Array-Deps, shallow verglichen. `this._memos` wird in
  // resetRecherche/loadRecherche geleert.
  _memo(key, deps, fn) {
    const prev = this._memos[key];
    if (prev && prev.deps.length === deps.length && prev.deps.every((d, i) => d === deps[i])) {
      return prev.value;
    }
    const value = fn();
    this._memos[key] = { deps, value };
    return value;
  },

  // Verknuepfungen, die eine Stelle im Buch bezeichnen (Kapitel/Seite) — die
  // Antwort auf „wo ist das eingearbeitet". Read-only auf der Karte: entfernt
  // wird eine Verknuepfung in der Detailansicht, wo auch der Picker sitzt.
  placeLinks(item) {
    return (item?.links || []).filter(l => PLACE_LINK_KINDS.includes(l.target_kind));
  },
  // Zahl der uebrigen Verknuepfungen (Figur/Ort/Szene/Beat/Strang) als blosse
  // Andeutung — sie gehoeren thematisch dazu, aber nicht auf diese Achse.
  otherLinkCount(item) {
    return (item?.links || []).filter(l => !PLACE_LINK_KINDS.includes(l.target_kind)).length;
  },
  // „Eingearbeitet" ohne Stelle im Buch ist ein BEFUND, keine Korrektur: der
  // Fund gilt als verwendet, aber nirgends steht, wo. Gleiche Bauart wie das
  // Drift-Badge der Beat-Karte (Soll gesetzt, Ist nicht auffindbar).
  statusNeedsPlace(item) {
    return this.itemStatus(item) === 'eingearbeitet' && this.placeLinks(item).length === 0;
  },

  // ── Status setzen ──────────────────────────────────────────────────────────
  // Einziger Schreibpfad der Achse — Kebab-Menue (Liste + Detailansicht) und
  // Drag im Board laufen beide hier durch.
  async setItemStatus(item, status) {
    const app = window.__app;
    this.menuOpenId = null;
    if (!item || !STATUSES.includes(status)) return;
    if (this.itemStatus(item) === status) return;
    this.busy = true;
    try {
      this._replaceItem(await this._patchItem(item.id, { status }));
      this.errorMessage = '';
    } catch {
      this.errorMessage = app.t('recherche.error.save');
    } finally {
      this.busy = false;
    }
  },

  // ── Drag & Drop (SortableJS, geteilter Kern in sortable-dnd.js) ────────────
  // Angebunden werden die vier Spalten-Container ([data-research-status-cell]).
  // Sie sind stabil, solange das Board im DOM steht (die Spalten sind fix, nur
  // ihr Inhalt wechselt) — reattached wird darum beim Ansichtswechsel, nicht bei
  // jeder Listenaenderung.
  async _ensureStatusBoard() {
    if (this.viewMode !== 'status' || !window.__app?.showRechercheCard) {
      this._destroyStatusSortables();
      return;
    }
    try { await loadSortable(); } catch { return; }
    await this.$nextTick();
    this._initStatusSortables();
  },

  _destroyStatusSortables() {
    for (const s of (this._statusSortables || [])) { try { s.destroy(); } catch {} }
    this._statusSortables = [];
    // Ein durch Teardown unterbrochener Drag darf die aufgeblaehten Drop-Zonen
    // nicht stehen lassen.
    document.body.classList.remove('research-dnd-active');
  },

  _initStatusSortables() {
    const Sortable = window.Sortable;
    if (!Sortable) return;
    patchSortableOnce(Sortable);
    this._destroyStatusSortables();
    const cells = this.$root?.querySelectorAll('[data-research-status-cell]') || [];
    if (!cells.length) return;
    // Im Native-Vollbild rendert nur der Teilbaum des Fullscreen-Elements;
    // SortableJS haengt den Fallback-Ghost aber an <body> und damit hinter das
    // Vollbild-Element. Gleiche Nachbesserung wie im Plot-Board.
    const relocateGhostForFullscreen = () => {
      const fsEl = document.fullscreenElement;
      const ghost = Sortable.ghost;
      if (fsEl && ghost && !fsEl.contains(ghost)) fsEl.appendChild(ghost);
    };
    const opts = {
      ...BASE_SORTABLE_OPTS,
      emptyInsertThreshold: 24,
      scroll: true,
      draggable: '.research-status-card',
      handle: '.research-status-grip',
      group: { name: 'research-status', pull: true, put: ['research-status'] },
      chosenClass: 'research-status-card--chosen',
      ghostClass: 'research-status-card--ghost',
      dragClass: 'research-status-card--dragging',
      onChoose: markDragIgnore,
      onUnchoose: unmarkDragIgnore,
      onStart: () => {
        document.body.classList.add('research-dnd-active');
        relocateGhostForFullscreen();
      },
      onEnd: (evt) => {
        document.body.classList.remove('research-dnd-active');
        unmarkDragIgnore(evt);
        this.onStatusSortEnd(evt);
      },
    };
    for (const el of cells) this._statusSortables.push(new Sortable(el, opts));
  },

  // Immer zuerst reverten: Alpine x-for ist alleiniger DOM-Besitzer, und die
  // Position innerhalb einer Spalte ist nichts, was wir speichern koennten.
  async onStatusSortEnd(evt) {
    const itemId = parseInt(evt.item?.dataset?.researchCardId, 10);
    const target = evt.to?.dataset?.researchStatusCell || '';
    revertSortable(evt);
    if (this.busy || !Number.isFinite(itemId)) return;
    if (evt.from === evt.to) return;
    const item = (this.items || []).find(i => i.id === itemId);
    if (!item) return;
    await this.setItemStatus(item, target);
  },
};
