// Catalog-Filter: dünner Wrapper um die Combobox für die wiederkehrenden
// Filter-Comboboxen in den Katalog-Karten (figuren/orte/szenen/ereignisse/
// songs/kontinuitaet). Statt jede Karte einzeln den Placeholder- und
// Empty-Label-i18n-Key durchreichen zu lassen, kennt der Wrapper die
// Standard-Labels per Filter-Typ ("kind"). Optionen kommen weiterhin via
// `x-effect="options = …"` aus dem Karten-Scope (siehe DESIGN.md, Anti-
// Pattern: Method-Indirection in x-effect).
//
// Verwendung:
//
//   <div x-data="catalogFilter('figur')"
//        x-modelable="value" x-model="$store.catalogUi.szenenFilters.figurId"
//        x-effect="options = $store.catalog.figuren.filter(...).map(...)"></div>
//
// Erweiterung: neue Filter-Typen (z. B. 'tag', 'datum') hier ergänzen,
// i18n-Keys in `public/js/i18n/{de,en}.json` analog hinzufügen.

import { comboboxData } from './combobox.js';

const FILTER_KINDS = {
  figur:   { placeholder: 'filter.figur',   empty: 'filter.allFiguren' },
  werkstattFigur: { placeholder: 'filter.werkstattFigur', empty: 'filter.allWerkstattFiguren' },
  chapter: { placeholder: 'filter.chapter', empty: 'filter.allChapters' },
  page:    { placeholder: 'filter.page',    empty: 'filter.allPages' },
  ort:     { placeholder: 'filter.ort',     empty: 'filter.allOrte' },
  szene:   { placeholder: 'filter.szene',   empty: 'filter.allSzenen' },
  subtyp:  { placeholder: 'events.filter.subtyp', empty: 'events.filter.allSubtypes' },
  kategorie: { placeholder: 'filter.kategorie', empty: 'filter.allKategorien' },
  status:  { placeholder: 'filter.status',  empty: 'filter.allStatus' },
  figurTyp: { placeholder: 'filter.figurTyp', empty: 'filter.allFigurTypen' },
  alterStatus: { placeholder: 'filter.alterStatus', empty: 'filter.allAlter' },
};

export function registerCatalogFilter() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('catalogFilter', (kind, extraCfg = {}) => {
    const spec = FILTER_KINDS[kind];
    if (!spec) throw new Error(`catalogFilter: unbekannter kind '${kind}'`);
    return comboboxData({
      placeholder: () => window.__app?.t?.(spec.placeholder) ?? '',
      emptyLabel:  () => window.__app?.t?.(spec.empty) ?? '',
      compact: true,
      ...extraCfg,
    });
  });
}
