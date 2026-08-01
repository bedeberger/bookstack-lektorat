// Alpine.data('rechercheCard') — Sub-Komponente der Recherche-/Wissensboard-Karte.
// Buchweit geteiltes Archiv (alle Editoren sehen dieselben Schnipsel). Eigener
// fachlicher State + Lifecycle; Root-Zugriffe via window.__app / $app.
import { setupCardLifecycle } from './card-lifecycle.js';
import { attachFullscreenSync } from '../fullscreen.js';
import { rechercheMethods } from '../book/recherche.js';
import { rechercheToSourceMethods } from '../sources/from-research.js';
import { researchChatMethods } from '../chat/research-chat.js';
import { EVT } from '../events.js';

function _emptyDraft() {
  return { kind: 'note', title: '', body: '', url: '', source: '', tags: '', fileName: '' };
}

export function registerRechercheCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('rechercheCard', () => ({
    items: [],
    tagPool: [],
    linkTargets: {},
    _linkTargetsBookId: null,

    loading: false,
    // Refetch bei Filter/Sort/Suche (Daten schon vorhanden): Liste bleibt stehen
    // und wird nur gedimmt, statt aufs Skeleton umzuschalten — kein Flackern.
    refreshing: false,
    busy: false,
    errorMessage: '',

    creating: false,
    draft: _emptyDraft(),
    editingId: null,
    editDraft: _emptyDraft(),

    filterKind: '',
    filterTag: '',
    filterLinked: '',
    filterLinkedKind: '',
    filterLinkedTargetId: '',
    filterText: '',
    sortBy: 'updated',
    showArchived: false,

    menuOpenId: null,

    // Beschreibungstext-Cap der Übersicht (CSS: .research-item-text--clamped).
    // `expanded…` = vom User aufgeklappte Fundstücke, `clampable…` = die, bei denen
    // der Cap wirklich etwas abschneidet (gemessen in _measureBodyClamps, nicht
    // aus der Textlänge geschätzt). Beide per Reassign, nicht In-Place-Mutate.
    expandedBodyIds: {},
    clampableBodyIds: {},
    // Re-Entry-Guard der rAF-gebündelten Messung (kurzlebig, kein Fach-State).
    _clampRaf: null,

    // Native-Fullscreen-Status (gespiegelt vom fullscreenchange-Listener) —
    // mehr Platz fürs Karten-Board. Toggle in rechercheMethods.toggleRechercheFullscreen.
    rechercheFullscreen: false,

    linkPickerItemId: null,
    linkPickerKind: 'figure',
    linkPickerTargetId: '',

    // Laufende „Link → Quelle"-Uebernahmen, Schluessel `${item.id}:${url_id}`
    // (rechercheToSourceMethods). Reassign statt In-Place-Mutate, damit Alpine
    // die Aenderung im verschachtelten x-for sicher sieht — wie _proposalSaving.
    // Kein Eintrag in resetRecherche noetig: der finally-Block der Uebernahme
    // raeumt jeden Schluessel, hier bleibt nichts liegen.
    _toSourceBusy: {},

    suggestions: {},
    suggestItemId: null,
    suggestStatus: '',
    _suggestTimer: null,

    // Deep-Link-Ziel (#book/X/recherche/<itemId>): gemerkt, bis die Liste geladen
    // ist. loadRecherche fokussiert es danach; _focusRechercheItemById in recherche.js.
    _pendingFocusItemId: null,

    // Recherche-Chat-Panel (Claude-only, mit Web-Suche). Eigener Sub-State neben
    // dem Board; Methoden aus researchChatMethods (makeChatMethods-Factory).
    researchChatOpen: false,
    researchChatSessions: [],
    researchChatMessages: [],
    researchChatSessionId: null,
    researchChatInput: '',
    researchChatLoading: false,
    researchChatProgress: 0,
    researchChatStatus: '',
    _researchChatPollTimer: null,

    // Saving-/Saved-Status der Chat-Speicher-Vorschläge — Card-Level statt auf dem
    // verschachtelten proposal-Objekt, weil Mutationen am x-for-Item-Proxy nach
    // einem await nicht zuverlässig ins Template durchschlagen (Reactive-Proxy-
    // Identity). Schlüssel: `${sessionId}:${msgIdx}:${pi}`. Reassign (kein In-Place-
    // Mutate), damit Alpine die Änderung sicher sieht.
    _proposalSaved: {},
    _proposalSaving: {},

    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        name: 'recherche',
        showFlag: 'showRechercheCard',
        timerKeys: ['_suggestTimer', '_researchChatPollTimer'],
        resetState: { creating: false, editingId: null, menuOpenId: null, linkPickerItemId: null, busy: false },
        load: () => this.loadRecherche(),
        extraListeners: [
          { type: 'recherche:filter-page', handler: (e) => this.filterToPage(e.detail?.pageId) },
          { type: 'recherche:filter-chapter', handler: (e) => this.filterToChapter(e.detail?.chapterId) },
          // Deep-Link-Permalink #book/X/recherche/<itemId>: Hash-Router dispatcht das
          // Event; _focusRechercheItemById öffnet das Item (bzw. merkt es bis zum Load vor).
          { type: EVT.RECHERCHE_FOCUS_ITEM, handler: (e) => this._focusRechercheItemById(e.detail?.itemId) },
        ],
        onBookChanged: (e, ctx, root) => {
          this.resetRecherche();
          this.resetResearchChat();
          this.researchChatOpen = false;
          if (root.showRechercheCard && Alpine.store('nav').selectedBookId) this.loadRecherche();
        },
        onViewReset: () => { this.resetRecherche(); this.resetResearchChat(); this.researchChatOpen = false; },
      });

      // Spaltenbreite ändert, wie viel der Text-Cap abschneidet → Toggle-Sichtbarkeit
      // neu messen (Pflicht-Signal aus dem Lifecycle, kein manuelles removeEventListener).
      window.addEventListener('resize', () => this._scheduleBodyClampMeasure(),
        { signal: this._lifecycle.signal });

      // Native Fullscreen-API: Status spiegeln (Toggle-Button + Esc-Exit).
      // $root = die Karten-Wurzel (.card--recherche), unabhängig vom Klick-Kontext.
      attachFullscreenSync({
        resolveWrap: () => this.$root,
        signal: this._lifecycle.signal,
        onChange: (active) => { this.rechercheFullscreen = active; },
      });
    },

    destroy() { this._lifecycle?.destroy(); },

    // Deep-Link-Item (#book/X/recherche/<itemId>) öffnen: Schnipsel suchen →
    // Edit-Modus + zentriert ins Bild + kurz hervorheben. Noch nicht geladene
    // Liste → ID merken, loadRecherche ruft uns danach erneut auf (analog
    // _focusBeatById in der Plot-Werkstatt).
    _focusRechercheItemById(rawId) {
      const id = parseInt(rawId, 10);
      this._pendingFocusItemId = null;
      if (!Number.isInteger(id)) return;
      const item = (this.items || []).find(i => i.id === id);
      if (!item) { this._pendingFocusItemId = id; return; }
      this.startEdit(item);
      this.$nextTick(() => {
        const el = this.$root?.querySelector(`[data-research-id="${id}"]`);
        if (!el) return;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.remove('research-item--flash');
        void el.offsetWidth; // Reflow → Animation startet auch beim zweiten Klick neu
        el.classList.add('research-item--flash');
        setTimeout(() => el.classList.remove('research-item--flash'), 1600);
      });
    },

    ...rechercheMethods,
    ...rechercheToSourceMethods,
    ...researchChatMethods,
  }));
}
