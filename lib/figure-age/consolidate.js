'use strict';
// Verdichtung: aus geprueften Einzelfunden wird EINE Zeile pro Figur.
//
// WARUM DETERMINISTISCH UND NICHT IM MODELL: „wie alt ist die Figur im Buch" ist
// keine Formulierungs-, sondern eine Rechenfrage — Spanne bilden, Bezugsjahr
// abziehen, Widerspruch erkennen. Das Modell liefert die Behauptungen samt Zitat;
// was daraus folgt, rechnet dieses Modul, damit es reproduzierbar ist und ein
// Widerspruch nicht davon abhaengt, ob das Modell ihn bemerkt hat.
//
// Reine Funktionen, keine DB, kein Netz.

// Ab dieser Abweichung (in Jahren) gilt eine Angabe als widerspruechlich. Eins
// ist Toleranz und keine Willkuer: zwischen Geburtstag und Bezugszeitpunkt liegt
// je nach Monat ein Jahr Unterschied, ohne dass jemand sich geirrt hat.
const TOLERANZ_JAHRE = 1;

const KONF = {
  explizit: 0.9,   // woertliche Altersangabe im Text, Zitat nachgeschlagen
  geburtsjahr: 0.75, // aus Geburtsjahr + Bezugsjahr gerechnet
  zeitstrahl: 0.5, // nur aus dem konsolidierten Zeitstrahl abgeleitet
  vage: 0.3,       // Fund, den das Modell selbst als unsicher meldet
};
const KONF_WIDERSPRUCH_MALUS = 0.2;

function _num(v) {
  const n = typeof v === 'number' ? v : parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/** Jahreszahl aus einem freien Datums-String ("Frühling 1850") — dieselbe Lesart
 *  wie routes/figures.js#_yearFromString, damit das kuratierte `geburtstag`-Feld
 *  hier und dort dasselbe bedeutet. */
function yearFromString(s) {
  if (!s) return null;
  const m = String(s).match(/\b(\d{4})\b/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * @param {object} input
 *   funde       [{ art:'alter'|'geburtsjahr'|'todesjahr', wert, bezugsjahr,
 *                  zitat, page_id, chapter, ordinal, offset, unsicher, begruendung }]
 *               — bereits zitat-geprueft (das Zitat steht wirklich im Text).
 *   kuratiert   { geburtstag }  aus `figures` (Autor-gepflegt, hat Vorrang).
 *   zeitstrahl  { jahr_im_roman, geburtsjahr, alter_im_roman } | null
 *   buchJahre   { minYear, maxYear } | null   Spanne des konsolidierten Zeitstrahls
 */
function consolidateFigure({ funde = [], kuratiert = null, zeitstrahl = null, buchJahre = null } = {}) {
  const sorted = [...funde].sort((a, b) => (a.ordinal - b.ordinal) || (a.offset - b.offset));
  const alterFunde = sorted.filter(f => f.art === 'alter' && _num(f.wert) != null);
  const gebFunde   = sorted.filter(f => f.art === 'geburtsjahr' && _num(f.wert) != null);

  // ── Geburtsjahr: kuratiert schlaegt Text schlaegt Zeitstrahl ──────────────
  const gebKuratiert = yearFromString(kuratiert?.geburtstag);
  const gebText = gebFunde.length ? _num(gebFunde[0].wert) : null;
  const gebZeitstrahl = _num(zeitstrahl?.geburtsjahr);
  let geburtsjahr = gebKuratiert ?? gebText ?? gebZeitstrahl ?? null;
  const geburtsjahrQuelle = gebKuratiert != null ? 'kuratiert'
    : gebText != null ? 'text'
      : gebZeitstrahl != null ? 'zeitstrahl' : null;

  const widerspruch = [];
  if (gebKuratiert != null && gebText != null && Math.abs(gebKuratiert - gebText) > TOLERANZ_JAHRE) {
    widerspruch.push({ typ: 'geburtsjahr', a: gebKuratiert, b: gebText, zitat: gebFunde[0].zitat || null, page_id: gebFunde[0].page_id ?? null });
  }

  // ── Alter aus dem Text: Spanne ueber die Leserichtung ────────────────────
  let alterVon = null, alterBis = null, bezugVon = null, bezugBis = null;
  for (const f of alterFunde) {
    const w = _num(f.wert);
    if (alterVon == null || w < alterVon) alterVon = w;
    if (alterBis == null || w > alterBis) alterBis = w;
    const bj = _num(f.bezugsjahr);
    if (bj != null) {
      if (bezugVon == null || bj < bezugVon) bezugVon = bj;
      if (bezugBis == null || bj > bezugBis) bezugBis = bj;
    }
  }

  // Alter sinkt im Buchverlauf: entweder Rueckblende (legitim) oder Fehler —
  // beides ist etwas, das der Autor sehen will. Gemeldet wird der Befund, nicht
  // ein Urteil darueber.
  for (let i = 1; i < alterFunde.length; i++) {
    const prev = alterFunde[i - 1], cur = alterFunde[i];
    if (_num(cur.wert) < _num(prev.wert) - TOLERANZ_JAHRE) {
      widerspruch.push({
        typ: 'reihenfolge', a: _num(prev.wert), b: _num(cur.wert),
        zitat: cur.zitat || null, page_id: cur.page_id ?? null,
      });
      break; // ein Hinweis genuegt; die Belegliste zeigt den Rest
    }
  }

  // ── Aus Geburtsjahr gerechnet ────────────────────────────────────────────
  const jahrVon = _num(buchJahre?.minYear);
  const jahrBis = _num(buchJahre?.maxYear) ?? _num(zeitstrahl?.jahr_im_roman);
  let gerechnetVon = null, gerechnetBis = null;
  if (geburtsjahr != null) {
    if (jahrVon != null && jahrVon >= geburtsjahr) gerechnetVon = jahrVon - geburtsjahr;
    if (jahrBis != null && jahrBis >= geburtsjahr) gerechnetBis = jahrBis - geburtsjahr;
  }

  // Textangabe gegen Rechnung. Vergleich nur, wo beide eine Spanne haben —
  // sonst vergleicht man den Anfang des einen mit dem Ende des anderen.
  if (alterBis != null && gerechnetBis != null && Math.abs(alterBis - gerechnetBis) > TOLERANZ_JAHRE
      && (alterVon == null || gerechnetVon == null || Math.abs(alterVon - gerechnetVon) > TOLERANZ_JAHRE)) {
    widerspruch.push({ typ: 'rechnung', a: alterBis, b: gerechnetBis });
  }

  // ── Ergebnis waehlen ─────────────────────────────────────────────────────
  // Der Text hat Vorrang: eine woertliche Angabe ist die Aussage des Werks, die
  // Rechnung nur ihre Rekonstruktion.
  let quelle = null, von = null, bis = null, konfidenz = 0;
  if (alterVon != null) {
    quelle = 'text';
    von = alterVon; bis = alterBis;
    const alleUnsicher = alterFunde.every(f => f.unsicher);
    konfidenz = alleUnsicher ? KONF.vage : KONF.explizit;
  } else if (gerechnetVon != null || gerechnetBis != null) {
    quelle = geburtsjahrQuelle === 'zeitstrahl' ? 'zeitstrahl' : 'geburtsjahr';
    von = gerechnetVon ?? gerechnetBis;
    bis = gerechnetBis ?? gerechnetVon;
    konfidenz = quelle === 'zeitstrahl' ? KONF.zeitstrahl : KONF.geburtsjahr;
  } else if (_num(zeitstrahl?.alter_im_roman) != null) {
    quelle = 'zeitstrahl';
    von = bis = _num(zeitstrahl.alter_im_roman);
    konfidenz = KONF.zeitstrahl;
  }
  if (widerspruch.length && konfidenz > 0) {
    konfidenz = Math.max(0.1, Math.round((konfidenz - KONF_WIDERSPRUCH_MALUS) * 100) / 100);
  }

  return {
    alter_von: von,
    alter_bis: bis == null ? von : bis,
    bezugsjahr_von: bezugVon ?? (quelle === 'text' ? null : jahrVon),
    bezugsjahr_bis: bezugBis ?? (quelle === 'text' ? null : jahrBis),
    geburtsjahr,
    geburtsjahr_quelle: geburtsjahrQuelle,
    gerechnet_von: gerechnetVon,
    gerechnet_bis: gerechnetBis,
    quelle,
    konfidenz,
    widerspruch: widerspruch.length ? widerspruch : null,
    belege: sorted,
  };
}

module.exports = { consolidateFigure, yearFromString, TOLERANZ_JAHRE, KONF };
