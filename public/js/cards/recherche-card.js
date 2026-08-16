// Alpine.data('rechercheCard') — Sub-Komponente der Recherche-/Wissensboard-Karte.
// Buchweit geteiltes Archiv (alle Editoren sehen dieselben Schnipsel). Eigener
// fachlicher State + Lifecycle; Root-Zugriffe via window.__app / $app.
import { setupCardLifecycle } from './card-lifecycle.js';
import { attachFullscreenSync } from '../fullscreen.js';
import { rechercheMethods } from '../book/recherche.js';
import { rechercheToSourceMethods } from '../sources/from-research.js';
import { researchChatMethods } from '../chat/research-chat.js';
import { EVT } from '../events.js';
import { emptyDraft as _emptyDraft } from '../book/recherche/shared.js';
import { rechercheInterviewMethods, rechercheInterviewState } from '../book/recherche/interview.js';

// Filterleiste + Sortierung pro Buch im localStorage (siehe
// public/js/filter-persist.js). `filterLinked` ist der aus Kategorie + Ziel
// zusammengesetzte Query-Wert und wird mitgespeichert, weil `loadRecherche` ihn
// als Query-Parameter schickt — die drei Felder werden immer zusammen gesetzt.
// `resetRecherche` fasst diese Felder nicht mehr an; die Restaurierung laeuft
// im Lifecycle VOR dem Nachladen, sonst holte der Buchwechsel die ungefilterte
// Liste und der restaurierte Filter zeigte auf nichts.
const RECHERCHE_FILTER_SCOPES = [
  { scope: 'recherche', defaults: {
    filterKind: '', filterTag: '', filterLinked: '', filterLinkedKind: '',
    filterLinkedTargetId: '', filterText: '', sortBy: 'updated', showArchived: false,
  } },
];

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

    // EIN Formular-Draft für BEIDE Wege — Anlegen (recherche-create.html) und
    // Bearbeiten im Detail-Dialog teilen Felder-Fragment, Dialog-Shell und diesen
    // Draft. Kein `creating`-Boolean daneben: ob der Anlegen-Dialog offen ist, weiss
    // das <dialog> selbst (items.js#startCreate/closeCreate fahren es per
    // showModal()/close()); ein zweites Flag wäre nur eine Kopie zum Auseinanderlaufen.
    draft: _emptyDraft(),

    // Detail-Dialog (recherche-detail.html): `detailItemId` ist die SSoT dafür,
    // WELCHES Fundstück offen ist — der Dialog selbst wird daraus in
    // items.js#openDetail per showModal() aufgezogen und spiegelt sich in
    // #…/recherche/<itemId>. `detailEditing` schaltet darin auf das Formular;
    // Verknüpfen/Tags/Anhänge bleiben in beiden Modi bedienbar.
    detailItemId: null,
    detailEditing: false,

    filterKind: '',
    filterTag: '',
    filterLinked: '',
    filterLinkedKind: '',
    filterLinkedTargetId: '',
    filterText: '',
    sortBy: 'updated',
    showArchived: false,

    menuOpenId: null,

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

    // Interview-Transkription (Slice book/recherche/interview.js): Aufnahme,
    // Wortlaut, Sprecher. Buch-skopiert, darum aus der Factory.
    ...rechercheInterviewState(),
    _ivPollTimer: null,

    _lifecycle: null,

    // Das offene Fundstück, aus `items` gelesen statt kopiert: nach jedem
    // _replaceItem (Speichern, Upload, Verknüpfen) zeigt der Dialog damit den
    // frischen Datensatz, ohne eigenen Sync-Pfad.
    get detailItem() {
      if (this.detailItemId == null) return null;
      return (this.items || []).find(i => i.id === this.detailItemId) || null;
    },
    // Alias-Vehikel für den Dialog: die geteilten Fragmente (Aktionsmenü,
    // URL-Zeilen, Verknüpfungen) sprechen das Fundstück als `item` an, weil sie
    // im x-for der Liste stehen. Ein x-for über 0 oder 1 Element gibt dem Dialog
    // denselben Namen — so bleibt das Markup EINE Quelle statt zweier Kopien.
    get detailItems() {
      const it = this.detailItem;
      return it ? [it] : [];
    },

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        name: 'recherche',
        showFlag: 'showRechercheCard',
        timerKeys: ['_suggestTimer', '_researchChatPollTimer', '_ivPollTimer'],
        resetState: { detailEditing: false, menuOpenId: null, linkPickerItemId: null, busy: false },
        filterScopes: RECHERCHE_FILTER_SCOPES,
        load: () => this.loadRecherche(),
        extraListeners: [
          { type: 'recherche:filter-page', handler: (e) => this.filterToPage(e.detail?.pageId) },
          { type: 'recherche:filter-chapter', handler: (e) => this.filterToChapter(e.detail?.chapterId) },
          // Deep-Link-Permalink #book/X/recherche/<itemId>: Hash-Router dispatcht das
          // Event; _focusRechercheItemById öffnet das Item (bzw. merkt es bis zum Load vor).
          { type: EVT.RECHERCHE_FOCUS_ITEM, handler: (e) => this._focusRechercheItemById(e.detail?.itemId) },
          // Transkriptionslauf nach Reload/Tab-Wechsel wieder aufnehmen.
          { type: 'job:reconnect', handler: (e) => {
            if (e.detail?.type !== 'interview-transcribe') return;
            const itemId = parseInt(String(e.detail.job?.entityId || '').replace(/^i/, ''));
            if (itemId) this.ivReconnect(e.detail.jobId, itemId);
          } },
        ],
        onBookChanged: (e, ctx, root) => {
          Object.assign(this, rechercheInterviewState());
          this.resetRecherche();
          this.resetResearchChat();
          this.researchChatOpen = false;
          if (root.showRechercheCard && Alpine.store('nav').selectedBookId) this.loadRecherche();
        },
        onViewReset: () => {
          this.resetRecherche(); this.resetResearchChat(); this.researchChatOpen = false;
          Object.assign(this, rechercheInterviewState());
        },
      });

      // Karte zugeklappt (Exklusivität, Seitenwechsel, Hash-Navigation): BEIDE
      // Dialoge ZWINGEND schliessen. Ein offenes <dialog> hält das restliche
      // Dokument inert, und da es im Top-Layer liegt, verschwindet es mit der
      // display:none-Karte nur optisch — die App wirkte danach eingefroren.
      this.$watch(() => window.__app.showRechercheCard, (v) => {
        if (v) return;
        this.closeDetail();
        this.closeCreate();
      });

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
    // Detailansicht (LESEN, nicht Bearbeiten — ein geteilter Link soll zeigen,
    // nicht in ein Formular führen) + die Zeile dahinter zentriert ins Bild und
    // kurz hervorheben, damit sie nach dem Schliessen unter dem Cursor liegt.
    // Noch nicht geladene Liste → ID merken, loadRecherche ruft uns danach erneut
    // auf (analog _focusBeatById in der Plot-Werkstatt).
    _focusRechercheItemById(rawId) {
      const id = parseInt(rawId, 10);
      this._pendingFocusItemId = null;
      if (!Number.isInteger(id)) return;
      const item = (this.items || []).find(i => i.id === id);
      if (!item) { this._pendingFocusItemId = id; return; }
      this.openDetail(item);
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

    ...rechercheInterviewMethods,
    ...rechercheToSourceMethods,
    ...researchChatMethods,
  }));
}
