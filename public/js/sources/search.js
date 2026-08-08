// Suchen und Benennen einer Quelle — die zwei Fragen, die jede Oberfläche stellt,
// die eine Quellenliste zeigt: „passt diese Zeile zum Suchbegriff" und „wie heisst
// sie in einer Zeile".
//
// Beides stand vorher in drei bzw. zwei Kopien (Quellen-Karte, Beleg-Picker des
// Notebook-Editors, Server-Route) — mit auseinandergelaufenen Feldlisten: der
// Verlagsort war nur in der Karte durchsuchbar, im Picker nicht. Welche Felder
// eine Quelle auffindbar machen, ist eine fachliche Entscheidung und gehört
// darum an EINE Stelle.
//
// Pure Funktionen, kein DOM, kein Alpine — testbar und (wie format.js) vom
// Server per dynamic `import()` konsumierbar.

/** Anzeigename einer Person: „Kafka, Franz" bzw. „Bundesamt für Statistik".
 *  Deckungsgleich mit `personLabel` in fields.js — dort für das Formular, hier
 *  für Such- und Listenzeilen; beide lesen dieselbe CSL-Form. */
function personLabel(p) {
  if (!p) return '';
  if (p.literal) return p.literal;
  return [p.family, p.given].filter(Boolean).join(', ');
}

/** Alle Personen einer Quelle (Autoren vor Herausgebern), flach. */
export function sourcePersons(s) {
  return [...(s?.authors || []), ...(s?.editors || [])];
}

/** Durchsuchbarer Text einer Quelle, kleingeschrieben.
 *
 *  Enthalten sind die Felder, unter denen ein Autor eine Quelle sucht: Titel,
 *  übergeordnetes Werk, Verlag, Ort, Jahr, Zitierschlüssel und alle Personen
 *  (Nachname, Vorname und Körperschafts-Form, damit beide Schreibrichtungen
 *  treffen). Bewusst NICHT enthalten: Notiz und Abstract — sie machen die Suche
 *  unscharf, weil dort ganze Absätze stehen. */
export function sourceHaystack(s) {
  if (!s) return '';
  const persons = sourcePersons(s)
    .map(p => `${p.family || ''} ${p.given || ''} ${p.literal || ''}`).join(' ');
  return [s.title, s.container_title, s.publisher, s.place, s.year, s.citekey, persons]
    .filter(Boolean).join(' ').toLowerCase();
}

/** Trifft der Suchbegriff diese Quelle? Leerer Begriff trifft immer. */
export function matchesSourceQuery(s, query) {
  const q = String(query || '').trim().toLowerCase();
  return q ? sourceHaystack(s).includes(q) : true;
}

/** Quellenliste nach Freitext filtern (leerer Begriff → unveränderte Liste). */
export function filterSources(list, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return Array.isArray(list) ? list : [];
  return (list || []).filter(s => sourceHaystack(s).includes(q));
}

/** Einzeilige Kennung für Picker und Trefferlisten:
 *  „Kafka, Franz — Die Verwandlung (1915)".
 *
 *  Keine Zitierstil-Form — dafür ist format.js zuständig. Diese Zeile soll die
 *  Quelle in einer Liste wiedererkennbar machen, nicht sie belegen. */
export function sourceLine(s) {
  const who = personLabel(sourcePersons(s)[0]);
  const parts = [who, s?.title].filter(Boolean).join(' — ');
  return s?.year ? `${parts} (${s.year})` : parts;
}

/** Urheber-Spalte der Tabelle: erster Autor, sonst erster Herausgeber, sonst
 *  leer. Gleichzeitig der Sortierwert dieser Spalte — darum ein String und
 *  nicht das Personen-Objekt. */
export function primaryPersonLabel(src) {
  const a = Array.isArray(src?.authors) ? src.authors : [];
  const e = Array.isArray(src?.editors) ? src.editors : [];
  return personLabel(a[0]) || personLabel(e[0]) || '';
}

export { personLabel };
