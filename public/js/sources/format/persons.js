// Namen und Namenslisten je Zitierstil.
//
// Personen liegen als CSL-JSON vor: `{family, given}` fuer natuerliche Personen,
// `{literal}` fuer Koerperschaften ("Bundesamt fuer Statistik"), die kein
// Vor-/Nachname-Paar haben. `literal` wird ueberall unveraendert uebernommen —
// eine Heuristik, die daraus Namensteile raten wuerde, liegt bei Doppelnamen,
// Adelspraefixen und Institutionen zu oft falsch.

/** Initialen eines Vornamensfelds: "Franz Xaver" → "F. X.", "Hans-Peter" → "H.-P." */
export function initialsOf(given) {
  if (!given) return '';
  return String(given).trim().split(/\s+/).filter(Boolean)
    .map(tok => tok.split(/[-–]/).filter(Boolean)
      .map(p => `${p[0].toUpperCase()}.`)
      .join('-'))
    .join(' ');
}

function _isLiteral(p) {
  return !!(p && !p.family && (p.literal || typeof p === 'string'));
}

function _literalOf(p) {
  return String(typeof p === 'string' ? p : (p.literal || '')).trim();
}

/** "Kafka, Franz" bzw. "Kafka, F." — Koerperschaften unveraendert. */
export function personInverted(p, { initials = false } = {}) {
  if (!p) return '';
  if (_isLiteral(p)) return _literalOf(p);
  const family = String(p.family || '').trim();
  if (!family) return _literalOf(p);
  const given = initials ? initialsOf(p.given) : String(p.given || '').trim();
  return given ? `${family}, ${given}` : family;
}

/** "Franz Kafka" bzw. "F. Kafka" — Koerperschaften unveraendert. */
export function personNormal(p, { initials = false } = {}) {
  if (!p) return '';
  if (_isLiteral(p)) return _literalOf(p);
  const family = String(p.family || '').trim();
  if (!family) return _literalOf(p);
  const given = initials ? initialsOf(p.given) : String(p.given || '').trim();
  return given ? `${given} ${family}` : family;
}

/** Nachname bzw. Koerperschaftsname — Traeger des Kurzbelegs und Sortierschluessel. */
export function familyOf(p) {
  if (!p) return '';
  if (_isLiteral(p)) return _literalOf(p);
  return String(p.family || '').trim() || _literalOf(p);
}

function _clean(persons) {
  return (Array.isArray(persons) ? persons : []).filter(p => familyOf(p));
}

// Ab hier die Listenformen. Die Schwellen (2 / 3 / 20 / 21 …) sind die
// Stilregeln selbst, darum stehen sie als benannte Konstanten nah am Code.

const APA_MAX_LISTED = 20;   // ab 21 Personen: erste 19, Auslassung, letzte
const APA_HEAD = 19;
const CHICAGO_MAX_LISTED = 10; // ab 11: erste 7 + et al.
const CHICAGO_HEAD = 7;
const NUMERIC_MAX_LISTED = 3;  // ab 4: erste + u. a.

/** APA 7: "Kafka, F.", "Kafka, F., & Wolff, K.", 3–20 mit "&" vor der letzten,
 *  ab 21 erste 19 + Auslassung + letzte. */
export function apaAuthorList(persons, labels) {
  const list = _clean(persons);
  if (!list.length) return '';
  const fmt = p => personInverted(p, { initials: true });
  if (list.length === 1) return fmt(list[0]);
  if (list.length === 2) return `${fmt(list[0])}, ${labels.andApa} ${fmt(list[1])}`;
  if (list.length <= APA_MAX_LISTED) {
    const head = list.slice(0, -1).map(fmt).join(', ');
    return `${head}, ${labels.andApa} ${fmt(list[list.length - 1])}`;
  }
  const head = list.slice(0, APA_HEAD).map(fmt).join(', ');
  return `${head}, … ${fmt(list[list.length - 1])}`;
}

/** Chicago Author-Date (Verzeichnisform): erste Person invertiert, alle weiteren
 *  in natuerlicher Reihenfolge; ab 11 Personen erste 7 + et al. */
export function chicagoAuthorList(persons, labels) {
  const list = _clean(persons);
  if (!list.length) return '';
  const first = personInverted(list[0]);
  if (list.length === 1) return first;

  const rest = list.slice(1).map(p => personNormal(p));
  if (list.length > CHICAGO_MAX_LISTED) {
    return `${[first, ...rest.slice(0, CHICAGO_HEAD - 1)].join(', ')} ${labels.etAlChicago}`;
  }
  if (rest.length === 1) return `${first}, ${labels.andChicago} ${rest[0]}`;
  const head = [first, ...rest.slice(0, -1)].join(', ');
  return `${head}, ${labels.andChicago} ${rest[rest.length - 1]}`;
}

/** Numerischer Stil: alle Namen invertiert mit Semikolon getrennt (deutsche
 *  Verzeichniskonvention), ab 4 Personen die erste + "u. a.". */
export function numericAuthorList(persons, labels) {
  const list = _clean(persons);
  if (!list.length) return '';
  const fmt = p => personInverted(p);
  if (list.length > NUMERIC_MAX_LISTED) return `${fmt(list[0])} ${labels.etAlNumeric}`;
  return list.map(fmt).join('; ');
}

/** Namensteil des Kurzbelegs im Text. Schwellen sind stilabhaengig: APA kuerzt
 *  ab 3 Personen, Chicago erst ab 4. */
export function shortNames(persons, style, labels) {
  const list = _clean(persons);
  if (!list.length) return '';
  const f = list.map(familyOf);
  if (style === 'chicago-ad') {
    if (f.length === 1) return f[0];
    if (f.length === 2) return `${f[0]} ${labels.andChicago} ${f[1]}`;
    if (f.length === 3) return `${f[0]}, ${f[1]} ${labels.andChicago} ${f[2]}`;
    return `${f[0]} ${labels.etAlChicago}`;
  }
  // APA 7
  if (f.length === 1) return f[0];
  if (f.length === 2) return `${f[0]} ${labels.andApa} ${f[1]}`;
  return `${f[0]} ${labels.etAlApa}`;
}

/** Herausgeber-Angabe fuer APA: "H. Wolff (Hrsg.)" / "H. Wolff & M. Brod (Hrsg.)" */
export function apaEditorList(persons, labels) {
  const list = _clean(persons);
  if (!list.length) return '';
  const names = list.map(p => personNormal(p, { initials: true }));
  const joined = names.length === 1
    ? names[0]
    : `${names.slice(0, -1).join(', ')} ${labels.andApa} ${names[names.length - 1]}`;
  return `${joined} (${list.length === 1 ? labels.editorSuffix1 : labels.editorSuffixN})`;
}

// Herausgeber in der URHEBER-Position (Quelle ohne Autoren). Andere Form als die
// Herausgeber-Angabe mitten im Eintrag: der Kopf traegt den Sortierschluessel
// und wird darum invertiert — "Wolff, K. (Hrsg.)", nicht "K. Wolff (Hrsg.)".

/** APA 7: "Wolff, K. (Hrsg.)" / "Wolff, K., & Brod, M. (Hrsg.)" */
export function apaEditorHead(persons, labels) {
  const list = _clean(persons);
  if (!list.length) return '';
  const names = apaAuthorList(list, labels);
  return `${names} (${list.length === 1 ? labels.editorSuffix1 : labels.editorSuffixN})`;
}

/** Chicago: "Wolff, Kurt, Hrsg." */
export function chicagoEditorHead(persons, labels) {
  const list = _clean(persons);
  if (!list.length) return '';
  return `${chicagoAuthorList(list, labels)}, ${list.length === 1 ? labels.editorSuffix1 : labels.editorSuffixN}`;
}

/** Numerisch: "Wolff, Kurt (Hrsg.)" */
export function numericEditorHead(persons, labels) {
  const list = _clean(persons);
  if (!list.length) return '';
  return `${numericAuthorList(list, labels)} (${list.length === 1 ? labels.editorSuffix1 : labels.editorSuffixN})`;
}

/** Herausgeber-Angabe fuer Chicago/numerisch: "herausgegeben von Kurt Wolff" */
export function editedByList(persons, labels) {
  const list = _clean(persons);
  if (!list.length) return '';
  const names = list.map(p => personNormal(p));
  const joined = names.length === 1
    ? names[0]
    : `${names.slice(0, -1).join(', ')} ${labels.andChicago} ${names[names.length - 1]}`;
  return `${labels.editedBy} ${joined}`;
}
