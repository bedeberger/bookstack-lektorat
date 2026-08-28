// Alterstabelle der Figuren — fuenfter Reiter der Figuren-Karte.
//
// ZWEI QUELLEN, bewusst nebeneinander in EINER Tabelle:
//   1. Der Katalog (`Alpine.store('catalog').figuren`): `geburtstag` (vom Autor
//      gepflegt) und `alter_im_roman` (serverseitig aus dem konsolidierten
//      Zeitstrahl gerechnet, nur bei book_settings.zeitlinie_real).
//   2. Der Alters-Index (GET /figures/:id/alter, Job `figur-alter`): das Alter,
//      wie es im TEXT steht — mit woertlichem Beleg und Sprungziel.
//
// Die Tabelle funktioniert OHNE Lauf: sie zeigt dann, was der Katalog weiss. Der
// Analyse-Knopf ergaenzt die Textfunde und macht Widersprueche sichtbar. Genau
// dafuer bleiben beide Werte sichtbar — ein einziger „richtiger" Wert waere eine
// Behauptung darueber, welche Quelle recht hat.
//
// Gespreadet in cards/figuren-card.js; Root-Zugriffe via window.__app.

import { fetchJson, dateTimeFormat } from '../utils.js';

const TYP_ORDER = { hauptfigur: 0, antagonist: 1, mentor: 2, nebenfigur: 3, randfigur: 4, andere: 5 };

/** Pure Verbindung von Katalog und Alters-Index + Filter + Sortierung.
 *  Ausserhalb von Alpine testbar. `ages` = Map fig_id → Index-Zeile. */
export function computeAlterRows(figuren, ages, { suche = '', typ = '', nur = '' } = {}) {
  const q = (suche || '').toLowerCase();
  const rows = [];
  for (const f of (figuren || [])) {
    if (f.stale) continue;
    if (typ && f.typ !== typ) continue;
    if (q && !(f.name || '').toLowerCase().includes(q) && !(f.kurzname || '').toLowerCase().includes(q)) continue;
    const a = ages?.get?.(f.id) || null;
    // Textfund gewinnt in der Anzeige; der gerechnete Wert bleibt als eigene
    // Spalte stehen, damit die Abweichung sichtbar ist statt geglaettet.
    const alterVon = a?.alter_von ?? null;
    const alterBis = a?.alter_bis ?? alterVon;
    // Der gerechnete Wert kommt aus dem Index, wenn es einen gibt: der Server
    // kennt dort auch ein NUR IM TEXT gefundenes Geburtsjahr, das `alter_im_roman`
    // am Katalog per Definition nicht kennt (das liest nur das kuratierte Feld).
    // Ohne Lauf bleibt der Katalog-Wert — die Tabelle soll ohne Analyse arbeiten.
    const abgeleitet = a?.gerechnet ?? f.alter_im_roman ?? null;
    const row = {
      id: f.id,
      name: f.name,
      kurzname: f.kurzname || null,
      typ: f.typ || 'andere',
      geburtsjahr: a?.geburtsjahr ?? (f.geburtsjahr ?? null),
      geburtsjahr_quelle: a?.geburtsjahr_quelle ?? (f.geburtsjahr != null ? 'zeitstrahl' : null),
      geburtstag: f.geburtstag || null,
      alter_von: alterVon,
      alter_bis: alterBis,
      alter_abgeleitet: abgeleitet,
      jahr_im_roman: f.jahr_im_roman ?? null,
      bezugsjahr_von: a?.bezugsjahr_von ?? null,
      bezugsjahr_bis: a?.bezugsjahr_bis ?? null,
      quelle: a?.quelle ?? (abgeleitet != null ? 'zeitstrahl' : null),
      konfidenz: a?.konfidenz ?? (abgeleitet != null ? 0.5 : 0),
      widerspruch: a?.widerspruch ?? null,
      belege: a?.belege ?? [],
      // Ein Wert steht hier nur, wenn irgendeine Quelle etwas hergibt.
      hatAlter: alterVon != null || abgeleitet != null,
    };
    if (nur === 'mitAlter' && !row.hatAlter) continue;
    if (nur === 'ohneAlter' && row.hatAlter) continue;
    if (nur === 'widerspruch' && !row.widerspruch) continue;
    if (nur === 'beleg' && !row.belege.length) continue;
    rows.push(row);
  }
  return rows.sort((a, b) => {
    const at = TYP_ORDER[a.typ] ?? 99, bt = TYP_ORDER[b.typ] ?? 99;
    if (at !== bt) return at - bt;
    return (a.name || '').localeCompare(b.name || '', 'de');
  });
}

export const figurenAlterMethods = {
  // ── Laden ─────────────────────────────────────────────────────────────────
  async loadFigurenAlter() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) { this.figurenAlterData = null; return; }
    try {
      this.figurenAlterData = await fetchJson(`/figures/${encodeURIComponent(bookId)}/alter`);
      this._figurenAlterLoadedBookId = String(bookId);
      this._memos = {};
    } catch (e) {
      if (e?.name === 'AbortError') return;
      this.figurenAlterData = null;
      this.figurenAlterStatus = window.__app?.t?.('figuren.alter.loadError') || '';
    }
  },

  // Reiter wird geoeffnet: einmal laden, nicht bei jedem Klick.
  async ensureFigurenAlter() {
    const bookId = String(Alpine.store('nav').selectedBookId || '');
    if (!bookId) return;
    if (this.figurenAlterData && this._figurenAlterLoadedBookId === bookId) return;
    await this.loadFigurenAlter();
  },

  // ── Analyse anstossen ─────────────────────────────────────────────────────
  // Manuell ausgeloest heisst „ich will jetzt eine Zahl sehen" — der Server
  // ueberspringt in diesem Pfad seinen Delta-Skip (force).
  async runFigurenAlterScan() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || this.figurenAlterLoading) return;
    this.figurenAlterLoading = true;
    this.figurenAlterProgress = 0;
    this.figurenAlterStatus = window.__app?.t?.('figuren.alter.running') || '';
    try {
      const j = await fetchJson('/jobs/figur-alter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId, force: true }),
      });
      if (!j?.jobId) throw new Error('no jobId');
      this._pollFigurenAlter(j.jobId);
    } catch (e) {
      this.figurenAlterLoading = false;
      this.figurenAlterStatus = window.__app?.t?.('figuren.alter.error') || 'Fehler';
    }
  },

  _pollFigurenAlter(jobId) {
    const tick = async () => {
      try {
        const j = await fetchJson('/jobs/' + encodeURIComponent(jobId));
        if (j.status === 'done') {
          this.figurenAlterLoading = false;
          this.figurenAlterProgress = 0;
          this.figurenAlterStatus = '';
          await this.loadFigurenAlter();
          return;
        }
        if (j.status === 'error' || j.status === 'cancelled') {
          this.figurenAlterLoading = false;
          this.figurenAlterProgress = 0;
          this.figurenAlterStatus = j.error
            ? window.__app.t(j.error, j.errorParams)
            : (window.__app?.t?.('figuren.alter.error') || 'Fehler');
          return;
        }
        this.figurenAlterProgress = j.progress || 0;
        this._figurenAlterPollTimer = setTimeout(tick, 1200);
      } catch {
        this._figurenAlterPollTimer = setTimeout(tick, 2500);
      }
    };
    tick();
  },

  // ── Tabelle ───────────────────────────────────────────────────────────────
  figurenAlterRows() {
    const figuren = Alpine.store('catalog').figuren;
    const data = this.figurenAlterData;
    const f = this.figurenAlterFilters;
    const suche = f?.suche ?? '', typ = f?.typ ?? '', nur = f?.nur ?? '';
    return this._memo('alterRows', [figuren, data, suche, typ, nur], () => {
      const ages = new Map((data?.figuren || []).map(r => [r.fig_id, r]));
      return computeAlterRows(figuren, ages, { suche, typ, nur });
    });
  },

  // Typen, die im Buch wirklich vorkommen (Filter-Combobox).
  figurenAlterTypListe() {
    const figuren = Alpine.store('catalog').figuren;
    return this._memo('alterTypen', [figuren], () => {
      const seen = new Set();
      for (const f of (figuren || [])) if (!f.stale && f.typ) seen.add(f.typ);
      return [...seen].sort((a, b) => (TYP_ORDER[a] ?? 99) - (TYP_ORDER[b] ?? 99));
    });
  },

  // Kennzahlen über der Tabelle — „von wie vielen weiss ich es überhaupt".
  // Memoized: das Template liest drei Felder daraus, jedes wäre sonst ein eigener
  // Lauf über alle Zeilen (CLAUDE.md „Memo-Pattern: ein Helper pro Modul").
  figurenAlterSummary() {
    const rows = this.figurenAlterRows();
    return this._memo('alterSummary', [rows], () => ({
      total: rows.length,
      mitAlter: rows.filter(r => r.hatAlter).length,
      mitBeleg: rows.filter(r => r.belege.length).length,
      widerspruch: rows.filter(r => r.widerspruch).length,
    }));
  },

  // ── Anzeige-Helfer ────────────────────────────────────────────────────────
  // Eine Spanne wird als Spanne gezeigt. „12" statt „12–19" waere eine andere
  // Aussage: die Figur ist im Buch nicht zwölf, sie wird zwischen zwölf und
  // neunzehn Jahre alt.
  figurenAlterLabel(row) {
    const t = window.__app?.t?.bind(window.__app);
    if (row.alter_von != null) {
      return row.alter_bis != null && row.alter_bis !== row.alter_von
        ? `${row.alter_von}–${row.alter_bis}`
        : String(row.alter_von);
    }
    if (row.alter_abgeleitet != null) return String(row.alter_abgeleitet);
    return t ? t('figuren.alter.unknown') : '–';
  },

  // Bezugsjahr nur, wenn es ueberhaupt ein Alter gibt. Eine Jahreszahl neben
  // „unbekannt" liest sich wie eine Teilantwort, ist aber bloss das Buchende:
  // `jahr_im_roman` fällt für eine undatierte Figur auf das späteste Jahr des
  // Buchs zurück (lib/figure-years.js).
  figurenAlterBezugLabel(row) {
    if (!row.hatAlter) return '';
    const von = row.bezugsjahr_von, bis = row.bezugsjahr_bis;
    if (von != null && bis != null && von !== bis) return `${von}–${bis}`;
    if (von != null) return String(von);
    if (bis != null) return String(bis);
    if (row.jahr_im_roman != null) return String(row.jahr_im_roman);
    return '';
  },

  figurenAlterQuelleLabel(row) {
    const t = window.__app?.t?.bind(window.__app);
    if (!t || !row.quelle) return '';
    return t('figuren.alter.quelle.' + row.quelle);
  },

  // Konfidenz als drei Stufen statt als Kommazahl: die Zahl suggeriert eine
  // Praezision, die eine Heuristik nicht hat.
  figurenAlterKonfidenzStufe(row) {
    if (!row.hatAlter) return 'none';
    if (row.konfidenz >= 0.8) return 'hoch';
    if (row.konfidenz >= 0.6) return 'mittel';
    return 'niedrig';
  },

  figurenAlterKonfidenzLabel(row) {
    const stufe = this.figurenAlterKonfidenzStufe(row);
    if (stufe === 'none') return '';
    return window.__app?.t?.('figuren.alter.konfidenz.' + stufe) || '';
  },

  // Die Sicherheit steht als Ton an der Herkunfts-Plakette, ihr Wort im Tooltip —
  // eine eigene Plakette daneben las sich wie eine zweite Quellenangabe.
  figurenAlterKonfidenzTip(row) {
    const label = this.figurenAlterKonfidenzLabel(row);
    if (!label) return '';
    return window.__app?.t?.('figuren.alter.konfidenzTip', { level: label }) || label;
  },

  figurenAlterWiderspruchText(w) {
    const t = window.__app?.t?.bind(window.__app);
    if (!t || !w) return '';
    return t('figuren.alter.widerspruch.' + w.typ, { a: w.a, b: w.b });
  },

  figurenAlterWiderspruchTip(row) {
    return (row.widerspruch || []).map(w => this.figurenAlterWiderspruchText(w)).filter(Boolean).join(' · ');
  },

  figurenAlterGotoBeleg(b) {
    if (b?.page_id != null) window.__app?.gotoPageById?.(Number(b.page_id));
  },

  figurenAlterScanLabel() {
    const scan = this.figurenAlterData?.scan;
    if (!scan?.scanned_at) return '';
    const d = new Date(scan.scanned_at);
    if (Number.isNaN(d.getTime())) return '';
    // Datums-Anzeige ausschliesslich ueber den geteilten Formatter (harte Regel
    // „Frontend-Datums-Display: nur via tzOpts") — dateTimeFormat merged es.
    const date = dateTimeFormat(window.__app?.uiLocale, { dateStyle: 'medium', timeStyle: 'short' }).format(d);
    return window.__app?.t?.('common.asOf', { date }) || '';
  },

  // Belege einer Zeile auf-/zuklappen. Ein offener Beleg-Block pro Tabelle —
  // zwei offene Zeilen machen die Tabelle unlesbar, und der Vergleich zweier
  // Figuren laeuft ueber die Spalten, nicht ueber die Belege.
  figurenAlterToggleBelege(row) {
    this.figurenAlterOpenId = this.figurenAlterOpenId === row.id ? null : row.id;
  },
};
