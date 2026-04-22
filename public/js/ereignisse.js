// Ereignisse/Zeitstrahl-Methoden am Root-Spread (figuren.js ruft
// _buildGlobalZeitstrahl, app-komplett.js ruft _reloadZeitstrahl).

import { fetchJson } from './utils.js';

export const ereignisseMethods = {
  _buildGlobalZeitstrahl() {
    const allEvents = [];
    for (const f of (this.figuren || [])) {
      for (const ev of (f.lebensereignisse || [])) {
        const year = parseInt(ev.datum);
        if (!year) continue; // Events ohne errechenbare Jahreszahl ignorieren
        allEvents.push({
          datum: String(year),
          ereignis: ev.ereignis || '',
          typ: ev.typ || 'persoenlich',
          bedeutung: ev.bedeutung || '',
          kapitel: ev.kapitel || '',
          seite: ev.seite || '',
          figur: { id: f.id, name: f.kurzname || f.name, typ: f.typ },
        });
      }
    }

    // Events mit identischem datum+ereignis zusammenführen (alle Typen)
    const groups = [];
    const used = new Set();
    for (let i = 0; i < allEvents.length; i++) {
      if (used.has(i)) continue;
      const ev = allEvents[i];
      const group = {
        datum: ev.datum,
        ereignis: ev.ereignis,
        typ: ev.typ,
        bedeutung: ev.bedeutung,
        kapitel: ev.kapitel ? [ev.kapitel] : [],
        seiten: ev.seite ? [ev.seite] : [],
        figuren: [ev.figur],
      };
      for (let j = i + 1; j < allEvents.length; j++) {
        if (used.has(j)) continue;
        const ev2 = allEvents[j];
        if (ev2.datum === ev.datum && ev2.ereignis === ev.ereignis) {
          group.figuren.push(ev2.figur);
          if (ev2.kapitel && !group.kapitel.includes(ev2.kapitel)) group.kapitel.push(ev2.kapitel);
          if (ev2.seite && !group.seiten.includes(ev2.seite)) group.seiten.push(ev2.seite);
          used.add(j);
        }
      }
      used.add(i);
      groups.push(group);
    }

    // Chronologisch sortieren
    groups.sort((a, b) => parseInt(a.datum) - parseInt(b.datum));

    this.globalZeitstrahl = groups;
  },

  async _reloadZeitstrahl() {
    // Guard: wenn Konsolidierung läuft, ist der Status nur in der ereignisseCard
    // verfügbar. Von dort wird `this._reloadZeitstrahl()` nur gecallt, wenn
    // ohnehin nicht konsolidiert. Für Root-Aufrufer (komplett) existiert der
    // Zustand nicht separat; wir überspringen hier keine Calls.
    try {
      const { ereignisse } = await fetchJson(`/figures/zeitstrahl/${this.selectedBookId}`);
      if (ereignisse) {
        this.globalZeitstrahl = ereignisse;
      } else if (!this.globalZeitstrahl.length) {
        this._buildGlobalZeitstrahl();
      }
    } catch (e) {
      console.error('[reloadZeitstrahl]', e);
      if (!this.globalZeitstrahl.length) this._buildGlobalZeitstrahl();
    }
  },
};
