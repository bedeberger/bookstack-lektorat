// Figurenübersicht-Methoden am Root-Spread (von vielen Modulen via
// $root.loadFiguren() gerufen). Die eigentliche Extraktion läuft als Teil
// von POST /jobs/komplett-analyse.

import { fetchJson } from './utils.js';

const _VALID_TYPES = new Set(['hauptfigur', 'nebenfigur', 'antagonist', 'mentor', 'randfigur', 'andere']);

export function _cleanStr(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || s === '-' || s === '–' || s === '—' || s === 'n/a' || s === 'N/A') return null;
  return s;
}

export function _sanitizeFigur(f) {
  return {
    ...f,
    typ: _VALID_TYPES.has(f.typ) ? f.typ : 'andere',
    kurzname: _cleanStr(f.kurzname),
    beruf: _cleanStr(f.beruf),
    beschreibung: _cleanStr(f.beschreibung),
    geburtstag: _cleanStr(f.geburtstag),
    geschlecht: _cleanStr(f.geschlecht),
    sozialschicht: _cleanStr(f.sozialschicht),
    praesenz: _cleanStr(f.praesenz),
    rolle: _cleanStr(f.rolle),
    motivation: _cleanStr(f.motivation),
    konflikt: _cleanStr(f.konflikt),
    entwicklung: _cleanStr(f.entwicklung),
    erste_erwaehnung: _cleanStr(f.erste_erwaehnung),
    schluesselzitate: (f.schluesselzitate || []).map(_cleanStr).filter(Boolean).slice(0, 3),
    eigenschaften: (f.eigenschaften || []).map(_cleanStr).filter(Boolean),
    lebensereignisse: (f.lebensereignisse || []).map(ev => ({
      ...ev,
      datum: _cleanStr(ev.datum),
      ereignis: _cleanStr(ev.ereignis),
      kapitel: _cleanStr(ev.kapitel),
      seite: _cleanStr(ev.seite),
      bedeutung: _cleanStr(ev.bedeutung),
    })).filter(ev => ev.ereignis || ev.datum),
    beziehungen: (f.beziehungen || []).map(bz => ({
      ...bz,
      beschreibung: _cleanStr(bz.beschreibung),
    })),
  };
}

export const figurenMethods = {
  async loadFiguren(bookId) {
    try {
      const data = await fetchJson('/figures/' + bookId);
      this.figuren = (data?.figuren || []).map(_sanitizeFigur);
      this.figurenUpdatedAt = data?.updated_at || null;
      this._figurLookupIndex = null;
      this._buildGlobalZeitstrahl();
    } catch (e) {
      console.error('[loadFiguren]', e);
    }
  },

  async saveFiguren() {
    try {
      const r = await fetch('/figures/' + this.selectedBookId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ figuren: this.figuren }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      console.error('[saveFiguren]', e);
    }
  },
};
