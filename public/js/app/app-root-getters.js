// Computed-Getter der `lektorat`-Alpine-Root-Komponente.
//
// Export als Property-Descriptor-Map: Alpine-Proxy wrappt das Objekt nach
// `Alpine.data(...)`-Return; Getter-Aufrufe gehen durch den Proxy → Reaktivität
// + Dependency-Tracking funktionieren wie bei inline definierten Gettern.
// Object-Spread (`...getters`) würde Getter zur Spread-Zeit einmalig ausführen
// und als statische Werte kopieren — darum descriptor-basiertes
// `Object.defineProperties`.

import { aggregateLiveBookStats } from '../utils.js';

export const rootGetterDescriptors = {
  // Sidebar-Σ: identisch zu Hero-Snapshot (overviewLatest) und Server-Total
  // (routes/sync.js#syncBook). Σ per-Seite-Stats — Titel zählen nicht.
  tokTotals: {
    enumerable: true,
    configurable: true,
    get() {
      const ts = this.tokEsts;
      // Cache-Schluessel ist Identitaet UND Eintragszahl. Die Identitaet allein
      // reicht nicht: Pfade, die eine frisch angelegte Seite eintragen, setzen
      // per Index-Assign (`tokEsts[id] = …`) und lassen die Identitaet stehen —
      // ein reiner Ref-Vergleich liefert dort dauerhaft den alten Wert zurueck,
      // im Erstfall inklusive `any: false`, sodass die Σ-Zeile der Sidebar gar
      // nicht erst erscheint. Die Zahl der Eintraege deckt Hinzufuegen und
      // Entfernen ab; geaenderte WERTE kommen ausschliesslich ueber eine
      // Reassignment (Save-Sync, Backfill, Buch-Sync) und damit ueber die
      // Identitaet. Der Zaehler kostet nichts Zusaetzliches — die Aggregation
      // darunter laeuft ohnehin ueber dieselben Keys.
      const size = ts ? Object.keys(ts).length : 0;
      const cache = this._tokTotalsCache;
      if (cache && cache.tokRef === ts && cache.size === size) return cache.value;
      const { chars, words, tok } = aggregateLiveBookStats(ts);
      const value = {
        chars, words, tok,
        normseiten: Math.round((chars / 1500) * 10) / 10,
        any: size > 0,
      };
      this._tokTotalsCache = { tokRef: ts, size, value };
      return value;
    },
  },
};
