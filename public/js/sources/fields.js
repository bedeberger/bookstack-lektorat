// Feld-Inventar des Quellen-Formulars: welche CSL-Felder ein Quellentyp zeigt,
// unter welchem Label — plus die Umrechnung zwischen DB-Form und Formular-Form.
//
// Pure Daten + pure Helper: kein DOM, kein Alpine, kein fetch. Damit ist die
// Zuordnung ohne gemountete Karte testbar, und die Live-Vorschau kann denselben
// Payload durch formatFull() schicken, den der PUT spaeter speichert.
//
// Warum typabhaengig: das Schema haelt fuer alle elf Typen dieselben Spalten
// (db/sources.js#TEXT_FIELDS), aber ein Film hat keine ISSN und ein
// Zeitschriftenaufsatz keinen Verlagsort. Ein Formular mit allen sechzehn
// Feldern gleichzeitig waere unbenutzbar — diese Datei ist die Sicht-Schicht
// darauf, nicht eine zweite Wahrheit ueber das Schema.

/** Deckungsgleich mit CSL_TYPES in db/sources.js. Laufen die auseinander,
 *  bietet das Formular einen Typ an, den die Route mit 400 INVALID_VALUE
 *  ablehnt. Reihenfolge = Anzeige-Reihenfolge in der Typ-Combobox. */
export const SOURCE_TYPES = [
  'book', 'chapter', 'article', 'website', 'thesis',
  'report', 'legal', 'interview', 'film', 'dataset', 'other',
];

export const DEFAULT_SOURCE_TYPE = 'book';

/** Alle Freitext-Spalten — Reihenfolge wie db/sources.js#TEXT_FIELDS. Basis fuer
 *  den leeren Draft; die Sichtbarkeit entscheidet `fieldsForType`. */
export const TEXT_FIELDS = [
  'citekey', 'title', 'container_title', 'publisher', 'place', 'year',
  'edition', 'volume', 'issue', 'pages', 'doi', 'isbn', 'issn', 'url',
  'accessed_at', 'note',
];

// Immer sichtbar, vor den typspezifischen Feldern.
const HEAD_FIELDS = ['title', 'year'];
// Immer sichtbar, dahinter. `note` und `citekey` stehen im Formular in einer
// eigenen Sektion („Verwaltung") und sind hier deshalb nicht gelistet.
const TAIL_FIELDS = ['url', 'accessed_at'];

const TYPE_FIELDS = {
  book:      ['publisher', 'place', 'edition', 'volume', 'isbn', 'doi'],
  chapter:   ['container_title', 'publisher', 'place', 'edition', 'pages', 'isbn', 'doi'],
  article:   ['container_title', 'volume', 'issue', 'pages', 'doi', 'issn'],
  website:   ['container_title', 'publisher'],
  thesis:    ['publisher', 'place', 'doi'],
  report:    ['publisher', 'place', 'volume', 'doi', 'isbn'],
  legal:     ['container_title', 'place', 'pages'],
  interview: ['publisher', 'place'],
  film:      ['publisher', 'place'],
  dataset:   ['publisher', 'volume', 'doi'],
  other:     ['container_title', 'publisher', 'place', 'pages', 'doi'],
};

// Typspezifische Label-Ueberschreibungen. `container_title` heisst beim
// Sammelband-Beitrag „Sammelband", beim Aufsatz „Zeitschrift" — dasselbe Feld,
// aber ein generisches „Ueberliegender Titel" versteht niemand.
// Werte sind i18n-Suffixe unter `sources.field.`.
const LABEL_OVERRIDE = {
  container_title: {
    chapter: 'containerBook',
    article: 'containerJournal',
    website: 'containerSite',
    legal:   'containerLegal',
  },
  publisher: {
    thesis:    'publisherSchool',
    report:    'publisherOrg',
    film:      'publisherStudio',
    interview: 'publisherMedium',
  },
};

function _type(cslType) {
  return SOURCE_TYPES.includes(cslType) ? cslType : DEFAULT_SOURCE_TYPE;
}

/** i18n-Key des Feld-Labels fuer einen Typ. */
export function fieldLabelKey(field, cslType) {
  const suffix = LABEL_OVERRIDE[field]?.[_type(cslType)];
  return `sources.field.${suffix || _camel(field)}`;
}

// container_title → containerTitle, accessed_at → accessedAt.
function _camel(field) {
  return field.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

// Felder, die Prosatext aufnehmen und damit LanguageTool bekommen
// (`data-spellcheck="spelling"`, harte Regel in CLAUDE.md). Bewusst NICHT
// dabei: Ort, Verlag, Auflage, Band, Seiten, DOI/ISBN/ISSN, URL, Abrufdatum —
// Eigennamen und Kennungen, die der Pruefer sonst als Tippfehler anmeckert.
const SPELLCHECK_FIELDS = new Set(['title', 'container_title', 'note']);

/** Sichtbare Freitext-Felder eines Typs, in Formular-Reihenfolge.
 *  Rueckgabe: [{ key, labelKey, spell }] — das Template rendert daraus die Rows. */
export function fieldsForType(cslType) {
  const t = _type(cslType);
  const keys = [...HEAD_FIELDS, ...(TYPE_FIELDS[t] || TYPE_FIELDS.other), ...TAIL_FIELDS];
  return keys.map(key => ({
    key,
    labelKey: fieldLabelKey(key, t),
    spell: SPELLCHECK_FIELDS.has(key),
  }));
}

// ── Personen (CSL-JSON ↔ Formular) ───────────────────────────────────────────
// DB-Form ist {family, given} ODER {literal} (Koerperschaften). Das Formular
// haelt beide Varianten in EINER Zeile mit drei Feldern und entscheidet beim
// Speichern: `literal` gefuellt → Koerperschaft, sonst Personenname. So braucht
// die Zeile keinen Modus-State, der mit dem Inhalt aus dem Tritt kommen kann.

/** DB-Personenliste → Formular-Zeilen. */
export function personsToDraft(list) {
  if (!Array.isArray(list)) return [];
  return list.map(p => ({
    family:  p?.family || '',
    given:   p?.given || '',
    literal: p?.literal || '',
  }));
}

/** Formular-Zeilen → CSL-Personenliste. Leere Zeilen fallen weg (der User laesst
 *  beim Tippen regelmaessig eine offene Zeile stehen). */
export function draftToPersons(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const r of rows) {
    const literal = String(r?.literal || '').trim();
    if (literal) { out.push({ literal }); continue; }
    const family = String(r?.family || '').trim();
    const given  = String(r?.given || '').trim();
    if (!family && !given) continue;
    // Nur Vorname ohne Nachname ist kein CSL-Personenname — als Koerperschaft
    // ablegen, statt ihn stumm zu verlieren.
    if (!family) { out.push({ literal: given }); continue; }
    out.push(given ? { family, given } : { family });
  }
  return out;
}

/** Anzeigename einer Person („Kafka, Franz" / „Bundesamt fuer Statistik"). */
export function personLabel(p) {
  if (!p) return '';
  if (p.literal) return p.literal;
  return [p.family, p.given].filter(Boolean).join(', ');
}

/** Urheber-Spalte der Tabelle: erster Autor, sonst erster Herausgeber, sonst
 *  leer. Gleichzeitig der Sortierwert dieser Spalte — darum ein String und
 *  nicht das Personen-Objekt. */
export function primaryPersonLabel(src) {
  const a = Array.isArray(src?.authors) ? src.authors : [];
  const e = Array.isArray(src?.editors) ? src.editors : [];
  return personLabel(a[0]) || personLabel(e[0]) || '';
}

// ── Draft ↔ Quelle ───────────────────────────────────────────────────────────

/** Leerer bzw. aus einer Quelle vorbefuellter Formular-Draft. */
export function draftFromSource(src = null) {
  const draft = {
    csl_type: _type(src?.csl_type),
    authors: personsToDraft(src?.authors),
    editors: personsToDraft(src?.editors),
    archived: src?.archived ? 1 : 0,
  };
  for (const f of TEXT_FIELDS) draft[f] = src?.[f] || '';
  // PDF-Metadaten werden am Form gezeigt, aber nicht dauerhaft gespeichert (die
  // CRUD-Route berührt nur TEXT_FIELDS). Upload/Löschen laufen über eigene
  // Endpunkte (`/:id/pdf`); der Draft schleppt hier nur den Anzeige-State.
  draft.has_pdf = !!src?.has_pdf;
  draft.doc_name = src?.doc_name || '';
  draft.doc_pages = src?.doc_pages ?? null;
  draft.doc_indexed_at = src?.doc_indexed_at || null;
  return draft;
}

/** Draft → Request-Body. Leere Strings werden zu `null`, damit ein geleertes
 *  Feld die Spalte wirklich raeumt (die Route ist PATCH-artig: `undefined`
 *  liesse den alten Wert stehen). */
export function draftToPayload(draft) {
  const out = {
    csl_type: _type(draft?.csl_type),
    authors: draftToPersons(draft?.authors),
    editors: draftToPersons(draft?.editors),
    archived: draft?.archived ? 1 : 0,
  };
  for (const f of TEXT_FIELDS) {
    const v = draft?.[f];
    out[f] = v == null || String(v).trim() === '' ? null : String(v).trim();
  }
  return out;
}

/** Hat der Draft genug fuer einen Verzeichniseintrag? Spiegelt `_hasIdentity`
 *  in routes/sources.js — der Server bleibt autoritativ (400
 *  SOURCE_IDENTITY_REQ), die Karte deaktiviert damit nur den Speichern-Button,
 *  statt den User in einen Fehler laufen zu lassen. */
export function draftHasIdentity(draft) {
  if (String(draft?.title || '').trim()) return true;
  return draftToPersons(draft?.authors).length > 0
      || draftToPersons(draft?.editors).length > 0;
}
