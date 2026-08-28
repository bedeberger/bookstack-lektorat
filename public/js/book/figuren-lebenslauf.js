// Lebenslauf der Figuren — sechster Reiter der Figuren-Karte.
//
// EINE MATRIX, kein zweiter Katalog: Zeilen sind Lebensphasen, Spalten die
// ausgewaehlten Figuren, Zellen deren datierte Lebensereignisse in dieser Phase.
// Damit beantwortet der Reiter die Frage, die eine Zeile-pro-Figur-Tabelle nicht
// beantworten kann: „wo stand die eine Figur, als die andere X erlebte".
//
// KEIN EIGENER JOB, KEIN EIGENER INDEX, KEINE EIGENE ROUTE. Die Ereignisse stehen
// mit `datum`, `subtyp`, `kapitel` und `page_id` bereits im Figuren-Katalog
// (GET /figures/:book_id → `lebensereignisse`, befuellt von der Komplettanalyse).
// Eine zweite Extraktion wuerde dieselbe Information ein zweites Mal erheben —
// und dann konkurrierend, mit zwei Wahrheiten ueber dasselbe Leben.
//
// DIE ZEILEN-ACHSE IST DAS ALTER, NICHT DAS JAHR. Zwei Figuren, ein Jahr
// auseinander geboren, gehen im selben Lebensabschnitt zur Schule, aber in
// verschiedenen Kalenderjahren. Nach Jahren sortiert stuenden sie versetzt und
// der Vergleich, um den es geht, waere zerschnitten.
//
// Gespreadet in cards/figuren-card.js; Root-Zugriffe via window.__app.

const TYP_ORDER = { hauptfigur: 0, antagonist: 1, mentor: 2, nebenfigur: 3, randfigur: 4, andere: 5 };

// Wie viele Spalten die Tabelle von sich aus oeffnet. Mehr als eine Handvoll
// nebeneinander liest niemand mehr; der Rest wird zugeschaltet.
export const LEBENSLAUF_DEFAULT_SPALTEN = 3;
// Harte Obergrenze: darueber ist die Zeile breiter als jeder Bildschirm und die
// Matrix kippt in eine horizontale Schnitzeljagd.
export const LEBENSLAUF_MAX_SPALTEN = 6;

// Die Phasen-Schnitte liegen an den biografischen Naehten (Einschulung, Uebertritt
// in die Oberstufe, Volljaehrigkeit, Pensionierung) — nicht auf runden Zehnern.
// WHY: die Naht ist der Grund, warum zwei Figuren ueberhaupt in einer Zeile
// stehen. Ein Band 10–19 traefe den Uebertritt mit zwoelf in der Mitte und legte
// Primar- und Oberstufenzeit derselben Figur uebereinander.
// `bis: null` = offen nach oben, `von: null` = offen nach unten.
export const LEBENSPHASEN = [
  { key: 'vorgeschichte',  von: null, bis: -1 },
  { key: 'geburt',         von: 0,    bis: 0 },
  { key: 'kleinkind',      von: 1,    bis: 5 },
  { key: 'schulkind',      von: 6,    bis: 11 },
  { key: 'jugend',         von: 12,   bis: 17 },
  { key: 'jungerwachsen',  von: 18,   bis: 29 },
  { key: 'erwachsen',      von: 30,   bis: 49 },
  { key: 'reife',          von: 50,   bis: 64 },
  { key: 'hochalter',      von: 65,   bis: null },
];
// Sammelzeile fuer Ereignisse ohne Jahreszahl. Sie werden NICHT weggelassen:
// „steht nicht in der Matrix" hiesse sonst „gibt es nicht", und undatierte
// Ereignisse sind der Normalfall in Buechern ohne Kalender-Zeitlinie.
export const PHASE_UNDATIERT = 'undatiert';

/** Erste vierstellige Jahreszahl aus einem Datums-String („Frühling 1850" → 1850).
 *  Bewusst dieselbe Regel wie serverseitig `lib/figure-years.js#yearFromString` —
 *  eine grosszuegigere Variante hier liesse Lebenslauf und Alters-Spalte an genau
 *  den Datumsangaben auseinanderlaufen, an denen sie sich unterscheiden. */
export function jahrAusDatum(s) {
  if (!s) return null;
  const m = String(s).match(/\b(\d{4})\b/);
  return m ? parseInt(m[1], 10) : null;
}

/** Geburtsjahr einer Figur, in der Vorrangordnung der Alters-Analyse:
 *  Index-Wert (der kennt auch ein nur im Text gefundenes Jahr und hat den
 *  kuratierten Stammwert bereits bevorzugt) → Katalog-Wert aus dem konsolidierten
 *  Zeitstrahl → das Stammfeld selbst. */
export function figurGeburtsjahr(f, a) {
  return a?.geburtsjahr ?? f?.geburtsjahr ?? jahrAusDatum(f?.geburtstag);
}

/** Phase-Key zu einem Alter. `null` (kein Jahr im Ereignis) → Sammelzeile. */
export function phaseFuerAlter(alter) {
  if (alter == null || !Number.isFinite(alter)) return PHASE_UNDATIERT;
  for (const p of LEBENSPHASEN) {
    if ((p.von == null || alter >= p.von) && (p.bis == null || alter <= p.bis)) return p.key;
  }
  return PHASE_UNDATIERT;
}

/** Figuren, die als Spalte taugen: nicht stale, mit Geburtsjahr, mit Ereignissen.
 *  OHNE GEBURTSJAHR KEINE SPALTE — ohne Bezugspunkt liesse sich kein einziges
 *  Ereignis einer Lebensphase zuordnen, die ganze Spalte fiele in die
 *  Sammelzeile und taeuschte eine Aussage vor, die sie nicht macht. Wie viele
 *  Figuren das betrifft, meldet `computeLebenslaufKandidaten` als `ohneJahr`. */
export function computeLebenslaufKandidaten(figuren, ages, { suche = '', typ = '' } = {}) {
  const q = (suche || '').toLowerCase();
  const liste = [];
  let ohneJahr = 0;
  for (const f of (figuren || [])) {
    if (f.stale) continue;
    const evts = f.lebensereignisse || [];
    if (!evts.length) continue;
    const gj = figurGeburtsjahr(f, ages?.get?.(f.id));
    if (gj == null) { ohneJahr++; continue; }
    if (typ && f.typ !== typ) continue;
    if (q && !(f.name || '').toLowerCase().includes(q)
          && !(f.kurzname || '').toLowerCase().includes(q)) continue;
    liste.push({
      id: f.id,
      name: f.name,
      kurzname: f.kurzname || null,
      typ: f.typ || 'andere',
      geburtsjahr: gj,
      anzahl: evts.length,
    });
  }
  liste.sort((a, b) => {
    const at = TYP_ORDER[a.typ] ?? 99, bt = TYP_ORDER[b.typ] ?? 99;
    if (at !== bt) return at - bt;
    if (a.anzahl !== b.anzahl) return b.anzahl - a.anzahl;
    return (a.name || '').localeCompare(b.name || '', 'de');
  });
  return { liste, ohneJahr };
}

/** Die Matrix. `ids` = ausgewaehlte Figuren-Kennungen (fig_id) in Klick-Reihenfolge;
 *  die Spalten stehen aber in Kandidaten-Reihenfolge, damit ein Umschalten die
 *  Tabelle nicht durchmischt.
 *  Liefert `{ spalten, zeilen }`; `zeilen` enthaelt nur Phasen, in denen
 *  ueberhaupt etwas passiert — leere Zwischenzeilen sind kein Befund, nur Luft. */
export function computeLebenslauf(figuren, ages, ids) {
  const wanted = new Set((ids || []).map(String));
  const byId = new Map((figuren || []).map(f => [String(f.id), f]));
  const { liste } = computeLebenslaufKandidaten(figuren, ages);
  const spalten = liste.filter(k => wanted.has(String(k.id)));
  if (!spalten.length) return { spalten: [], zeilen: [] };

  // Phase-Key → Spaltenindex → Ereignisse.
  const buckets = new Map();
  const push = (key, si, evt) => {
    let row = buckets.get(key);
    if (!row) { row = spalten.map(() => []); buckets.set(key, row); }
    row[si].push(evt);
  };

  spalten.forEach((sp, si) => {
    const f = byId.get(String(sp.id));
    for (const e of (f?.lebensereignisse || [])) {
      const jahr = jahrAusDatum(e.datum);
      // Ein Ereignis VOR der Geburt ist kein Rechenfehler, sondern Vorgeschichte
      // (Herkunft, Elterngeneration) — darum eine eigene Phase statt eines Filters.
      const alter = jahr != null ? jahr - sp.geburtsjahr : null;
      push(phaseFuerAlter(alter), si, {
        jahr,
        alter,
        datum: e.datum || '',
        ereignis: e.ereignis || '',
        bedeutung: e.bedeutung || '',
        subtyp: e.subtyp || 'sonstiges',
        page_id: e.page_id ?? null,
        kapitel: e.kapitel || null,
        seite: e.seite || null,
      });
    }
  });

  const zeilen = [];
  for (const p of [...LEBENSPHASEN, { key: PHASE_UNDATIERT, von: null, bis: null }]) {
    const row = buckets.get(p.key);
    if (!row) continue;
    for (const zelle of row) {
      zelle.sort((a, b) => (a.jahr ?? 0) - (b.jahr ?? 0) || (a.alter ?? 0) - (b.alter ?? 0));
    }
    zeilen.push({ key: p.key, von: p.von, bis: p.bis, zellen: row });
  }
  return { spalten, zeilen };
}

export const figurenLebenslaufMethods = {
  // ── Spaltenwahl ───────────────────────────────────────────────────────────
  // Kandidaten sind ungefiltert die Grundlage der Vorauswahl und gefiltert die
  // Grundlage der Chip-Liste — zwei Memo-Eintraege, weil die Vorauswahl nicht bei
  // jedem Tastendruck im Suchfeld umspringen darf.
  figurenLebenslaufKandidaten() {
    const figuren = Alpine.store('catalog').figuren;
    const data = this.figurenAlterData;
    const f = this.figurenLebenslaufFilters;
    const suche = f?.suche ?? '', typ = f?.typ ?? '';
    return this._memo('llKandidaten', [figuren, data, suche, typ], () =>
      computeLebenslaufKandidaten(figuren, this._figurenLebenslaufAges(), { suche, typ }));
  },

  _figurenLebenslaufAges() {
    const data = this.figurenAlterData;
    return this._memo('llAges', [data], () =>
      new Map((data?.figuren || []).map(r => [r.fig_id, r])));
  },

  // Erste Oeffnung: die praesentesten Figuren stehen schon da. Eine leere Matrix
  // mit der Aufforderung, erst Spalten zu waehlen, waere ein Formular, kein Befund.
  figurenLebenslaufEnsureAuswahl() {
    if (this.figurenLebenslaufIds.length) return;
    const figuren = Alpine.store('catalog').figuren;
    const { liste } = computeLebenslaufKandidaten(figuren, this._figurenLebenslaufAges());
    this.figurenLebenslaufIds = liste.slice(0, LEBENSLAUF_DEFAULT_SPALTEN).map(k => k.id);
  },

  figurenLebenslaufToggle(id) {
    const ids = this.figurenLebenslaufIds;
    const i = ids.indexOf(id);
    if (i >= 0) { ids.splice(i, 1); return; }
    if (ids.length >= LEBENSLAUF_MAX_SPALTEN) return;
    ids.push(id);
  },

  // Der Deckel wird aus der Konstante gelesen, nicht im Template wiederholt —
  // eine zweite Zahl im Markup laeuft der ersten davon.
  figurenLebenslaufMax() {
    return LEBENSLAUF_MAX_SPALTEN;
  },

  figurenLebenslaufSelected(id) {
    return this.figurenLebenslaufIds.includes(id);
  },

  // Der Chip einer nicht gewaehlten Figur wird gesperrt, sobald die Obergrenze
  // steht — sperren statt still ignorieren, sonst wirkt der Klick kaputt.
  figurenLebenslaufVoll() {
    return this.figurenLebenslaufIds.length >= LEBENSLAUF_MAX_SPALTEN;
  },

  // ── Matrix ────────────────────────────────────────────────────────────────
  figurenLebenslaufMatrix() {
    const figuren = Alpine.store('catalog').figuren;
    const data = this.figurenAlterData;
    const ids = this.figurenLebenslaufIds;
    // Dep ist der VERKETTETE Schluessel, nicht das Array: `figurenLebenslaufIds`
    // wird in place mutiert (push/splice), die Referenz bleibt also gleich. Eine
    // Laengen-Dep daneben faenge das Umschalten „eine ab, eine dazu" nicht.
    return this._memo('llMatrix', [figuren, data, ids.join(',')], () =>
      computeLebenslauf(figuren, this._figurenLebenslaufAges(), ids));
  },

  // ── Anzeige-Helfer ────────────────────────────────────────────────────────
  figurenLebenslaufPhaseLabel(zeile) {
    return window.__app?.t?.('figuren.lebenslauf.phase.' + zeile.key) || zeile.key;
  },

  // Die Altersangabe neben dem Phasennamen macht die Zeilen-Achse lesbar: ohne
  // sie muesste man raten, warum ein Ereignis in dieser und nicht der naechsten
  // Zeile steht.
  figurenLebenslaufPhaseSpanne(zeile) {
    if (zeile.key === PHASE_UNDATIERT) return '';
    const t = window.__app?.t?.bind(window.__app);
    if (!t) return '';
    if (zeile.von == null) return t('figuren.lebenslauf.spanne.vorGeburt');
    // Ein Punkt statt einer Spanne (die Geburt) traegt seine Erklaerung schon im
    // Zeilennamen; „0 Jahre" daneben waere Fuellsel.
    if (zeile.von === zeile.bis) return '';
    if (zeile.bis == null) return t('figuren.lebenslauf.spanne.ab', { n: zeile.von });
    return t('figuren.lebenslauf.spanne.von', { a: zeile.von, b: zeile.bis });
  },

  // Jahr UND Alter in der Zelle: das Jahr verankert im Buch, das Alter erklaert
  // die Zeile. Nur eines von beiden zwaenge den Leser zum Kopfrechnen.
  figurenLebenslaufMarke(evt) {
    if (evt.jahr == null) return evt.datum || '';
    if (evt.alter == null) return String(evt.jahr);
    return window.__app?.t?.('figuren.lebenslauf.marke', { jahr: evt.jahr, alter: evt.alter })
        || `${evt.jahr}`;
  },

  figurenLebenslaufSubtypLabel(evt) {
    return window.__app?.t?.('events.subtyp.' + evt.subtyp) || '';
  },

  figurenLebenslaufGoto(evt) {
    if (evt?.page_id != null) window.__app?.gotoPageById?.(Number(evt.page_id));
  },
};
