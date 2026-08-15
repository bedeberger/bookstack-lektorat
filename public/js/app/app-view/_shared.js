// Geteilte Imports + Modul-Konstanten der appViewMethods-Submodule.
import { htmlToText, fetchJson, escHtml, decorateMentions } from '../../utils.js';
import { computeTodayRing, computeWeekBars, computeWritingStreak } from '../../today-ring.js';
import { EXCLUSIVE_CARDS, hiddenForBuchtyp, matchesRequiredBuchtyp } from '../../cards/feature-registry.js';
import { contentRepo } from '../../repo/content.js';
import { readDraft, clearDraft } from '../../editor/draft-storage.js';
import { setLastPageId, getLastPageId, getFilters } from '../../local-prefs.js';
import { getDeviceId } from '../../device-id.js';
import { EVT } from '../../events.js';

// Karten-Scopes, deren Filter pro Buch im localStorage persistiert werden.
// Defaults werden bei Buchwechsel angewandt; gespeicherte Werte überschreiben
// jeweils nur die genannten Keys. SSoT für persist (app.js-Watcher),
// restore (`_restoreBookPrefs`) und reset (`resetView`).
export const FILTER_SCOPES = [
  ['figurenFilters',      { kapitel: '', seite: '', suche: '' }],
  ['ereignisseFilters',   { figurId: '', kapitel: '', seite: '', suche: '' }],
  ['szenenFilters',       { wertung: '', figurId: '', kapitel: '', ortId: '', suche: '' }],
  ['orteFilters',         { figurId: '', kapitel: '', szeneId: '', suche: '' }],
  ['songsFilters',        { figurId: '', kapitel: '', szeneId: '', genre: '', kontextTyp: '', suche: '' }],
  ['kontinuitaetFilters', { figurId: '', kapitel: '', schwere: '' }],
];

// Kartenwechsel als sanfter Cross-Fade (View Transitions API). Progressive
// Enhancement: ohne Browser-Support (oder ohne DOM, Unit-Tests) läuft der
// Callback direkt. Der Callback muss den DOM-Endzustand herstellen — Alpine
// flusht reaktive Änderungen erst im nextTick, darum gehört das Warten (und
// der Scroll, damit der neue Snapshot die Endposition zeigt) mit hinein.
// Reduced-Motion wird CSS-seitig gekappt (tokens/motion.css).
export async function _withCardTransition(ctx, apply) {
  if (typeof document === 'undefined' || typeof document.startViewTransition !== 'function') {
    await apply();
    return;
  }
  const run = async () => { await apply(); await ctx.$nextTick?.(); };
  const vt = document.startViewTransition(run);
  // `ready`/`finished` rejecten (unbehandelt), wenn der Browser die Transition
  // überspringt — etwa bei verstecktem Tab ("skipped because document
  // visibility state is hidden"). Schlucken, sonst löst das ein
  // unhandledrejection aus. Der DOM-Endzustand steht via updateCallbackDone.
  vt.ready?.catch(() => {});
  vt.finished?.catch(() => {});
  await vt.updateCallbackDone.catch(() => {});
}

// Generischer Karten-Toggle. Liest Behavior-Felder aus EXCLUSIVE_CARDS-Entry
// (onReclick, requiresBook, loadDeps, auditEvent, extraRefreshOnOpen) und
// kapselt die Open/Close/Refresh-Pfade. Bespoke-Toggles (kapitelReview, ideen,
// chat, tree) leben weiterhin als eigene Methoden.
// `opts.skipCardScroll` unterdrückt den Sprung an den Karten-Anfang. Gesetzt von
// den zusammengesetzten Navigationen (`openFigurById` & Co.), die gleich danach
// die getroffene ZEILE ins Bild scrollen: beide Scrolls laufen sonst als
// konkurrierende Smooth-Animationen, und landen sie im selben Frame, schluckt
// der Browser den zweiten — das Ziel bliebe ausserhalb des Bildes. Wer keine
// Zeile im Sinn hat, bekommt den Karten-Scroll unverändert.
export async function _toggleCardGeneric(entry, opts = {}) {
  if (this[entry.flag]) {
    if (entry.onReclick === 'refresh') {
      window.dispatchEvent(new CustomEvent(EVT.CARD_REFRESH, { detail: { name: entry.refreshName || entry.key } }));
      if (!opts.skipCardScroll) this._scrollToCardByKey(entry.key);
    } else {
      await _withCardTransition(this, () => { this[entry.flag] = false; });
    }
    return;
  }
  if (entry.requiresBook && !this.$store.nav.selectedBookId) return;
  // Claude-only-Karten (Kontinuität/Erzählprofil) für Nicht-Claude gar nicht öffnen —
  // deckt Deep-Links (#kontinuitaet) + Palette-Klicks ab, falls sie durchrutschen.
  if (entry.requiresCloudModel && (this.$store.config?.effectiveProviderClass || 'cloud') !== 'cloud') return;
  // Buchtyp-Ausschluss (z.B. Figuren/Plot/Buchsatz in einem journalistischen
  // Ressort) auch hier pruefen, nicht nur in der Palette — sonst oeffnet ein
  // Deep-Link (#plot) eine Karte, die es fuer dieses Buch nicht geben soll.
  if (hiddenForBuchtyp(entry, this.currentBuchtyp?.())) return;
  // Und der positive Fall: eine Karte mit `requiresBuchtyp` (Titel-Werkstatt,
  // Struktur, Tagebuch-Rueckschau) darf ein Deep-Link nicht in einem Buch
  // oeffnen, fuer dessen Typ es sie nicht gibt — die Palette blendet sie dort
  // aus, `#titel` im Roman kam bisher trotzdem durch.
  if (!matchesRequiredBuchtyp(entry, this.currentBuchtyp?.())) return;
  // Partial VOR der Transition laden — Netzwerk gehört nicht in den
  // View-Transition-Callback (der friert das Rendering ein).
  if (entry.partial) await this._ensurePartial(entry.partial);
  await _withCardTransition(this, () => {
    this._closeOtherMainCards(entry.key);
    this[entry.flag] = true;
  });
  if (!opts.skipCardScroll) this._scrollToCardByKey(entry.key);
  if (entry.auditEvent) this.logAuditEvent?.(entry.auditEvent, { book: this.$store.nav.selectedBookId });
  if (entry.extraRefreshOnOpen) {
    window.dispatchEvent(new CustomEvent(EVT.CARD_REFRESH, { detail: { name: entry.key } }));
  }
  if (entry.loadDeps?.length) {
    const tasks = [];
    for (const dep of entry.loadDeps) {
      const empty = !(this[dep.skipIfNonEmpty]?.length);
      if (empty && typeof this[dep.method] === 'function') {
        tasks.push(this[dep.method](this.$store.nav.selectedBookId));
      }
    }
    if (tasks.length) await Promise.all(tasks);
  }
}

// Auto-generierte Toggle-Methoden — eine pro EXCLUSIVE_CARDS-Eintrag (ausser
// `bespoke: true`). Werden in `appViewMethods` gespreaded, damit Alpine sie
// als reguläre Methoden auf der Root-Component sieht (Templates, Hash-Router,
// Palette rufen `toggleXxxCard()` direkt).
export const generatedToggles = {};
for (const entry of EXCLUSIVE_CARDS) {
  if (entry.bespoke || !entry.toggle) continue;
  generatedToggles[entry.toggle] = async function(opts) { return _toggleCardGeneric.call(this, entry, opts || {}); };
}

// View-Steuerung: Exklusivität zwischen Buch-/Seiten-Karten, Seitenauswahl,
// Reset-Logik beim Buch-/Seitenwechsel. Buchebenen-Features und Editor sind
// gegenseitig exklusiv (siehe CLAUDE.md-Regel "Feature-Toggle").

export { EVT, EXCLUSIVE_CARDS, clearDraft, computeTodayRing, computeWeekBars, computeWritingStreak, contentRepo, decorateMentions, escHtml, fetchJson, getDeviceId, getFilters, getLastPageId, htmlToText, readDraft, setLastPageId };
