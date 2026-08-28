// Alpine.data('worldFactsCard') — Welt-Fakten/Weltregeln-Karte (read-only).
//
// Selbstständige Karte: hält eigenen State + fetcht /world-facts/:bookId. Daten
// stammen ausschliesslich aus der Komplettanalyse (kein Edit-Pfad im Frontend).
// Gruppierung nach Kategorie; Filter über Suche + Kategorie-Combobox.
import { setupCardLifecycle } from './card-lifecycle.js';
import { fetchJson } from '../utils.js';

// Harte Kategorie-Gruppierung — SSoT für Reihenfolge + Icon je Key. Spiegelt die
// Whitelist FAKT_KATEGORIE_WL (db/schema.js) und das Prompt-Enum
// (prompts/komplett/schema-strings.js#FAKTEN_SCHEMA). Labels via i18n
// weltfakten.kategorie.<key>. Unbekannte/leere Werte → 'sonstiges'.
export const KAT_ORDER = [
  'figur', 'ort', 'objekt', 'organisation', 'technik', 'regel',
  'kultur', 'historie', 'zeit', 'soziolekt', 'ereignis', 'sonstiges',
];
const KAT_ICON = {
  figur:        'user',
  ort:          'map-pin',
  objekt:       'package',
  organisation: 'landmark',
  technik:      'cpu',
  regel:        'scale',
  kultur:       'book-open',
  historie:     'scroll',
  zeit:         'calendar',
  soziolekt:    'quote',
  ereignis:     'zap',
  sonstiges:    'more-horizontal',
};
// Filterleiste pro Buch im localStorage (siehe public/js/filter-persist.js).
// `defaults` ist zugleich die SSoT der Feldliste — `wfFilters` gehört damit dem
// Persistenz-Layer und wird in `resetState` nicht mehr mitgesetzt.
const WF_FILTER_SCOPES = [
  { scope: 'wfFilters', key: 'wfFilters', defaults: { suche: '', kategorie: '', seite: '' } },
];

const _katRank = new Map(KAT_ORDER.map((k, i) => [k, i]));
function _normKat(k) {
  return _katRank.has(k) ? k : 'sonstiges';
}

export function registerWorldFactsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('worldFactsCard', () => ({
    fakten: [],
    wfUpdatedAt: null,
    wfLoading: false,
    // Lief die Komplettanalyse schon? Trennt „nie analysiert" von „analysiert,
    // nichts gefunden" — sonst fordert der Leer-Zustand einen Lauf, der lief.
    wfScanned: false,
    wfFilters: { suche: '', kategorie: '', seite: '' },
    wfOpenGroups: {},
    _lifecycle: null,
    // _memos: nicht-reaktiver Memo-Cache (lazy via _memo, Reset in loadWorldFacts) —
    // bewusst nicht im reaktiven Initial-State, analog book-overview/load.js.

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        name: 'weltfakten',
        showFlag: 'showWorldFactsCard',
        resetState: { fakten: [], wfUpdatedAt: null, wfLoading: false, wfScanned: false, wfOpenGroups: {} },
        filterScopes: WF_FILTER_SCOPES,
        load: () => this.loadWorldFacts(),
      });
    },

    destroy() {
      this._lifecycle?.destroy();
    },

    async loadWorldFacts() {
      const bookId = Alpine.store('nav').selectedBookId;
      if (!bookId) return;
      this.wfLoading = true;
      try {
        const data = await fetchJson('/world-facts/' + bookId);
        this.fakten = data?.fakten || [];
        this.wfUpdatedAt = data?.updated_at || null;
        this.wfScanned = !!data?.scanned;
        this._memos = {};
        // Glossar startet aufgeklappt — reine Nachschlage-Ansicht, alle Gruppen offen.
        const open = {};
        for (const k of this.wfKategorieListe) open[k] = true;
        this.wfOpenGroups = open;
      } catch (e) {
        console.error('[loadWorldFacts]', e);
      } finally {
        this.wfLoading = false;
      }
    },

    // Ein Memo-Helper pro Modul (Array-Deps, shallow ===). Reset bei Reload.
    _memo(key, deps, compute) {
      const memos = (this._memos ||= {});
      const hit = memos[key];
      if (hit && hit.deps.length === deps.length
          && hit.deps.every((d, i) => d === deps[i])) {
        return hit.value;
      }
      const value = compute();
      memos[key] = { deps: [...deps], value };
      return value;
    },

    // Einmal pro fakten-Satz: Counts je Kategorie + vorhandene Kategorien (kanonisch sortiert).
    get _wfIndex() {
      return this._memo('index', [this.fakten], () => {
        const counts = {};
        for (const f of this.fakten) {
          const k = _normKat(f.kategorie);
          counts[k] = (counts[k] || 0) + 1;
        }
        return { counts, present: KAT_ORDER.filter(k => counts[k]) };
      });
    },

    // Vorhandene Kategorien in kanonischer Reihenfolge (KAT_ORDER), nicht alphabetisch.
    get wfKategorieListe() {
      return this._wfIndex.present;
    },

    // i18n-Label + Lucide-Icon je Kategorie-Key (für Gruppen-Köpfe + Filter-Tabs).
    wfKatLabel(key) {
      return window.__app.t('weltfakten.kategorie.' + _normKat(key));
    },
    wfKatIcon(key) {
      return KAT_ICON[_normKat(key)] || KAT_ICON.sonstiges;
    },
    wfKatCount(key) {
      return this._wfIndex.counts[_normKat(key)] || 0;
    },

    wfToggleGroup(key) {
      this.wfOpenGroups[key] = !this.wfOpenGroups[key];
    },
    // Gruppe sichtbar, wenn explizit aufgeklappt — oder zwangsoffen: bei aktiver
    // Suche/Kapitel-Filter (Treffer müssen sichtbar sein) und bei aktivem
    // Kategorie-Tab (Gruppen-Kopf ist dort ausgeblendet, Liste zeigt direkt).
    wfGroupOpen(key) {
      if (this.wfFilters.kategorie || this.wfFilters.seite || this.wfFilters.suche.trim()) return true;
      return !!this.wfOpenGroups[key];
    },

    // Alle in Fakten referenzierten Kapitel-/Seitennamen (aus seite_label).
    // Fallback auf f.kapitel, falls die Junction-Tabelle befüllt ist.
    get wfSeiteListe() {
      return this._memo('seiten', [this.fakten], () => {
        const refs = this.fakten.flatMap(f => f.seite ? [f.seite] : (f.kapitel || []));
        return [...new Set(refs)].sort((a, b) => a.localeCompare(b));
      });
    },

    get wfFiltered() {
      const { suche, kategorie, seite } = this.wfFilters;
      const locale = Alpine.store('shell').uiLocale;
      return this._memo('filtered', [this.fakten, suche, kategorie, seite, locale], () => {
        const q = suche.trim().toLowerCase();
        return this.fakten.filter(f => {
          if (kategorie && _normKat(f.kategorie) !== kategorie) return false;
          if (seite && f.seite !== seite && !(f.kapitel || []).includes(seite)) return false;
          if (!q) return true;
          return (f.fakt || '').toLowerCase().includes(q)
            || (f.subjekt || '').toLowerCase().includes(q)
            || (f.seite || '').toLowerCase().includes(q)
            || (f.kapitel || []).some(k => k.toLowerCase().includes(q))
            || this.wfKatLabel(f.kategorie).toLowerCase().includes(q);
        });
      });
    },

    // Gefilterte Fakten nach Kategorie gruppiert, in kanonischer Reihenfolge:
    // [{ kategorie (Key), fakten[] }].
    get wfGrouped() {
      const filtered = this.wfFiltered;
      return this._memo('grouped', [filtered], () => {
        const groups = new Map();
        for (const f of filtered) {
          const k = _normKat(f.kategorie);
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k).push(f);
        }
        return KAT_ORDER
          .filter(k => groups.has(k))
          .map(k => ({ kategorie: k, fakten: groups.get(k) }));
      });
    },
  }));
}
