// Datums-Schicht der Ereignisse-Karte: Gültigkeitsprüfung, Date-Bau und
// Anzeige-Formatierung. Reine Funktionen ohne Alpine — direkt testbar
// (tests/unit/event-datum-zero.test.mjs). Die Karte (../ereignisse-card.js)
// importiert und re-exportiert sie.

// ── Gültigkeit der strukturierten Datumsfelder ───────────────────────────────
// Anzeige-seitiges Gegenstück zu lib/datum-parse#normalizeDatumFields. Der
// Server normalisiert am Schreibpfad, aber die Karte darf sich nicht darauf
// verlassen: ein einzelner 0-Platzhalter aus einem Alt-Bestand oder einem noch
// nicht migrierten Backup rendert sonst wieder «00.00.0» und zieht das
// Jahres-Band bis Jahr 0 auf. `== null` allein reicht dafür nicht.
// Jahr 0 gibt es in der Jahreszählung nicht; v. Chr. steht negativ im Feld.
export function validYear(v)  { return Number.isFinite(v) && v !== 0 ? Math.trunc(v) : null; }
export function validMonth(v) { return Number.isFinite(v) && v >= 1 && v <= 12 ? Math.trunc(v) : null; }
export function validDay(v)   { return Number.isFinite(v) && v >= 1 && v <= 31 ? Math.trunc(v) : null; }

// Hat das Event ein verwertbares Kalenderjahr? SSoT für alle Stellen, die
// zwischen „auf der Achse" und „nur in der Liste" unterscheiden — Karte wie
// Template (eventHasYear).
export function hasEventYear(ev) {
  return validYear(ev?.datum_year) !== null;
}

// Baut ein Date aus den strukturierten Jahr/Monat/Tag-Feldern. setFullYear
// (statt new Date(year,…)) vermeidet das 0–99-Jahr-Mapping auf 1900+year und
// trägt damit auch historische/frühe Jahre korrekt.
export function eventDate(year, month, day) {
  const d = new Date(0);
  d.setFullYear(year, month ? month - 1 : 0, day || 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Formatiert das Anzeige-Datum aus den strukturierten Feldern. Punkt-Events
// und Spannen werden unterschiedlich gerendert. Fallback auf datum_label
// (Original-String) oder die i18n-Variante für "unbekannt".
//
// Ausgabeformen: «17.10.1987» · «10.1987» · «1987» · «17.10.» (Tag/Monat ohne
// Jahr) · «Tag 3» (relative Story-Zeit) · Original-Label · «ohne Datum».
// Ungültige Teilfelder werden verworfen statt mitgerendert — ein unbekannter
// Monat darf nicht als «00.» erscheinen und ein unbekanntes Jahr nicht als «0».
export function formatEventDateParts(ev, t) {
  const p2 = (n) => String(n).padStart(2, '0');
  const part = (y, m, d) => {
    const yy = validYear(y);
    const mm = validMonth(m);
    // Ein Tag ohne Monat ist nicht darstellbar und trägt keine Aussage.
    const dd = mm === null ? null : validDay(d);
    if (yy === null && mm === null) return null;
    if (yy === null) return dd !== null ? `${p2(dd)}.${p2(mm)}.` : `${p2(mm)}.`;
    if (mm === null) return String(yy);
    return dd !== null ? `${p2(dd)}.${p2(mm)}.${yy}` : `${p2(mm)}.${yy}`;
  };
  const start = part(ev.datum_year, ev.datum_month, ev.datum_day);
  // Spannen-Ende nur mit eigenem Jahr — sonst ist es kein darstellbares Ende.
  const ende  = validYear(ev.datum_ende_year) === null
    ? null : part(ev.datum_ende_year, ev.datum_ende_month, ev.datum_ende_day);
  // Aus dem Kontext abgeleitetes (unsicheres) Datum → «ca.»-Prefix; nur relevant
  // wenn ein Jahr vorliegt (Story-Tags/Labels bleiben unverändert).
  const circa = (d) => (ev.datum_unsicher && hasEventYear(ev)) ? t('events.circa', { date: d }) : d;
  if (ende && start) return circa(t('events.span', { start, ende }));
  if (start) return circa(start);
  // Relative Story-Zeit beginnt bei Tag 1; alles darunter ist der
  // Unbekannt-Platzhalter der KI, kein Datum.
  if (Number.isFinite(ev.story_tag) && ev.story_tag >= 1) {
    return t('events.storyDay', { n: Math.trunc(ev.story_tag) });
  }
  if (ev.datum_label) return ev.datum_label;
  return t('events.unknownDate');
}
