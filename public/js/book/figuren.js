// Figurenübersicht-Methoden am Root-Spread (von vielen Modulen via
// $root.loadFiguren() gerufen). Die eigentliche Extraktion läuft als Teil
// von POST /jobs/komplett-analyse.

import { fetchJson } from '../utils.js';
import { VALID_FIGUR_TYPEN } from './figur-typen.js';

export function _cleanStr(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || s === '-' || s === '–' || s === '—' || s === 'n/a' || s === 'N/A') return null;
  return s;
}

// Umschliessende Anführungszeichen entfernen: Das Display wrappt Zitate selbst
// mit «…» (figuren.html, Prompt-Kontext). Liefert die KI das Zitat bereits in
// Original-Interpunktion mit Gänsefüsschen, gäbe das sonst ««…»». Idempotent.
const _QUOTE_PAIRS = [['«', '»'], ['„', '“'], ['“', '”'], ['‚', '‘'], ['‘', '’'], ['"', '"'], ["'", "'"]];
export function _stripQuotes(v) {
  let s = _cleanStr(v);
  if (!s) return s;
  let changed = true;
  while (changed) {
    changed = false;
    for (const [open, close] of _QUOTE_PAIRS) {
      if (s.length > open.length + close.length - 1 && s.startsWith(open) && s.endsWith(close)) {
        s = s.slice(open.length, s.length - close.length).trim();
        changed = true;
        break;
      }
    }
  }
  return s || null;
}

// Strukturierter Entwicklungsbogen: leere Felder bereinigen; null wenn nichts übrig.
function _sanitizeArc(arc) {
  if (!arc || typeof arc !== 'object') return null;
  const anfang = _cleanStr(arc.anfang);
  const ende = _cleanStr(arc.ende);
  const wendepunkte = (Array.isArray(arc.wendepunkte) ? arc.wendepunkte : []).map(_cleanStr).filter(Boolean);
  const typ = _cleanStr(arc.typ);
  if (!anfang && !ende && !wendepunkte.length && !typ) return null;
  return { typ: typ || '', anfang: anfang || '', wendepunkte, ende: ende || '' };
}

export function _sanitizeFigur(f) {
  return {
    ...f,
    typ: VALID_FIGUR_TYPEN.has(f.typ) ? f.typ : 'andere',
    kurzname: _cleanStr(f.kurzname),
    beruf: _cleanStr(f.beruf),
    wohnadresse: _cleanStr(f.wohnadresse),
    beschreibung: _cleanStr(f.beschreibung),
    geburtstag: _cleanStr(f.geburtstag),
    geschlecht: _cleanStr(f.geschlecht),
    sozialschicht: _cleanStr(f.sozialschicht),
    praesenz: _cleanStr(f.praesenz),
    rolle: _cleanStr(f.rolle),
    motivation: _cleanStr(f.motivation),
    konflikt: _cleanStr(f.konflikt),
    aeusseres: _cleanStr(f.aeusseres),
    stimme: _cleanStr(f.stimme),
    hintergrund: _cleanStr(f.hintergrund),
    entwicklung: _cleanStr(f.entwicklung),
    arc: _sanitizeArc(f.arc),
    erste_erwaehnung: _cleanStr(f.erste_erwaehnung),
    schluesselzitate: (f.schluesselzitate || []).map(_stripQuotes).filter(Boolean).slice(0, 5),
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
  // Kompaktes "Jahr · Alter"-Label einer Figur (nur befüllt bei Romanen mit
  // echter Zeitlinie — book_settings.zeitlinie_real; sonst leerer String → Tag
  // bleibt aus). jahr_im_roman/alter_im_roman kommen serverseitig aus den
  // datierten Figuren-Ereignissen. Geteilt von Figurenübersicht, Kontext-Leiste
  // und Figur-Lookup im Editor.
  figurJahrLabel(fig) {
    if (!fig) return '';
    const jahr = fig.jahr_im_roman;
    const alter = fig.alter_im_roman;
    if (jahr == null && alter == null) return '';
    if (jahr != null && alter != null) return this.t('figuren.jahrAlter', { jahr, alter });
    if (jahr != null) return String(jahr);
    return '';
  },

  // Das datierte Ereignis, das den aktuellen Stand der Figur setzt (das "weil
  // …"). Leerer String, wenn die Figur kein eigenes datiertes Ereignis hat.
  figurJahrAnchor(fig) {
    if (!fig?.anchor_ereignis) return '';
    return fig.anchor_kapitel
      ? this.t('figuren.jahrAnchor', { ereignis: fig.anchor_ereignis, kapitel: fig.anchor_kapitel })
      : fig.anchor_ereignis;
  },

  async loadFiguren(bookId, { signal } = {}) {
    try {
      const data = await fetchJson('/figures/' + bookId, { signal });
      this.$store.catalog.figuren = (data?.figuren || []).map(_sanitizeFigur);
      this._figurLookupIndex = null;
      this._buildGlobalZeitstrahl();
    } catch (e) {
      if (e?.name === 'AbortError') return;
      console.error('[loadFiguren]', e);
    }
  },

  // Stale-Figur ("nicht mehr im Text") endgültig löschen. Nur für stale-Einträge —
  // aktive Figuren werden bei der nächsten Komplettanalyse neu abgeglichen. CASCADE räumt
  // figure_relations/-events/-scenes/-appearances + evtl. plot_beat_figures/research_item_links mit.
  async deleteStaleFigur(f) {
    if (!f?.stale) return;
    if (!await this.appConfirm({
      message: this.t('figuren.confirmDeleteStale', { name: f.name }),
      confirmLabel: this.t('common.delete'), danger: true,
    })) return;
    try {
      const r = await fetch(`/figures/${this.$store.nav.selectedBookId}/${f.id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      this.$store.catalog.figuren = this.$store.catalog.figuren.filter(x => x.id !== f.id);
      this._figurLookupIndex = null;
      this._buildGlobalZeitstrahl();
    } catch (e) {
      console.error('[deleteStaleFigur]', e);
    }
  },
};
