// Fehlertyp-Profile des Lektorats, skopiert nach Buchtyp.
//
// SSoT für alles, was am Fehlertyp hängt:
//   · das Typ-Enum im Lektorat-Prompt (voll / Stil-Pass / Objektiv-Pass / lokal)
//   · die Anti-Doppelungs-Priorität im Prompt UND im Code (lib/lektorat-consolidate.js)
//   · das JSON-Schema-Enum (buildLektoratSchema / buildObjektivLektoratSchema)
//   · welche Regelblöcke der Prompt einhängt
//   · welche Typen der stilistische Cap deckelt (routes/jobs/lektorat.js)
//   · was der Server als gültigen Typ akzeptiert (validateLektoratFehler)
//
// Why: der Buchtyp erreichte den Lektorat-Prompt vorher nur als Kontext-Zusatz
// (`BUCHTYP-KONTEXT`) und über den Erzählform-Block. Die Fehlertypen selbst waren
// global — eine Dissertation wurde auf show_vs_tell, klischee, schwaches_verb und
// filterwort geprüft (Rauschen, teils schädlich: Nominalstil ist dort erwünscht),
// während die Typen fehlten, die dort zählen. Der Buchtyp wählt jetzt das Typ-Set.
//
// Ein Typ-Key ist eine Persistenz-Konstante: er steht in `page_checks.errors_json`,
// im `lektorat_cache` und in den i18n-Keys `finding.<typ>` / `fehlerHeatmap.typ.<typ>`.
// Keys werden nur ergänzt, nie umbenannt — sonst rendern Alt-Findings ohne Label.

// ── Kanonische Reihenfolge pro Profil ────────────────────────────────────────
// Reihenfolge = Reihenfolge im Prompt-Enum. Objektive Typen zuerst, damit der
// Stil-Pass-Filter (ohne Objektive) eine zusammenhängende Restliste ergibt.

// Erzählende Werke: Roman, Krimi, Fantasy, Autobiografie, Tagebuch, Lyrik, Satire …
export const NARRATIV_TYPEN = [
  'rechtschreibung', 'grammatik',
  'stil', 'satzbau', 'wiederholung', 'schwaches_verb', 'fuellwort', 'filterwort',
  'klischee', 'pleonasmus', 'ki_geruch', 'show_vs_tell', 'passiv',
  'perspektivbruch', 'tempuswechsel',
  'dialogformat', 'namenskonsistenz', 'figurenmerkmal', 'anrede', 'schauplatzmerkmal',
];

// Sachbuch / Essay / Blog: argumentierender Text ohne Figuren und ohne Szene.
// Erzähl-Handwerk (show_vs_tell, filterwort, perspektivbruch, dialogformat,
// Figuren-/Schauplatz-Konsistenz) entfällt; Absicherungsfloskeln und wechselnde
// Terminologie kommen dazu. Starke Verben, aktive Formulierung und frische Bilder
// bleiben Ziel — anders als in der wissenschaftlichen Arbeit.
export const SACHLICH_TYPEN = [
  'rechtschreibung', 'grammatik',
  'stil', 'satzbau', 'wiederholung', 'schwaches_verb', 'fuellwort',
  'klischee', 'pleonasmus', 'ki_geruch', 'passiv', 'hedging',
  'tempuswechsel', 'begriffsinkonsistenz',
];

// Wissenschaftliche Arbeit (Dissertation, Paper, Studienarbeit): Nominalstil,
// Passiv und wiederholte Fachtermini sind ERWÜNSCHT, nicht Mangel — darum fehlen
// schwaches_verb, passiv, klischee, ki_geruch und show_vs_tell hier. Geprüft wird
// stattdessen, was die Arbeit tragfähig macht: Beleglage, Begriffsdisziplin,
// konsistente Autorenreferenz, Tempus-Konvention der Abschnitte, Hedging-Mass.
export const WISSENSCHAFT_TYPEN = [
  'rechtschreibung', 'grammatik',
  'stil', 'satzbau', 'wiederholung', 'fuellwort', 'pleonasmus', 'hedging',
  'tempuswechsel', 'unbelegt', 'begriffsinkonsistenz', 'autorenform',
];

const PROFILE = {
  narrativ:     NARRATIV_TYPEN,
  sachlich:     SACHLICH_TYPEN,
  wissenschaft: WISSENSCHAFT_TYPEN,
};

// buchtyp-Key (prompt-config.json `buchtypen`) → Profil. Alles Ungenannte,
// inkl. null/unbekannt, fällt auf 'narrativ' zurück.
// `lyrik` bleibt bewusst narrativ: Wiederholung und starke Bildsprache sind dort
// Kunstmittel, das braucht ein eigenes Profil statt einer Sachbuch-Näherung.
const PROFIL_BY_BUCHTYP = {
  wissenschaft: 'wissenschaft',
  sachbuch:     'sachlich',
  essay:        'sachlich',
  blog:         'sachlich',
};

/** Profilname für einen Buchtyp. Unbekannt/null → 'narrativ'. */
export function lektoratProfil(buchtyp) {
  return PROFIL_BY_BUCHTYP[buchtyp] || 'narrativ';
}

// Objektive/mechanische Typen: werden im Claude-Split im fokussierten Objektiv-Pass
// geprüft und sind im Stil-Pass verboten. Reihenfolge = Enum-Reihenfolge dort.
export const OBJEKTIV_TYPEN = [
  'rechtschreibung', 'grammatik', 'dialogformat',
  'namenskonsistenz', 'figurenmerkmal', 'anrede',
];
const OBJEKTIV_SET = new Set(OBJEKTIV_TYPEN);

// Typen, die nur gegen die Figurenkartei prüfbar sind — ohne Figuren-Block
// fallen sie aus dem Objektiv-Enum.
const FIGUREN_TYPEN = new Set(['namenskonsistenz', 'figurenmerkmal', 'anrede']);

// Lokale Provider (Ollama/llama.cpp) bekommen ein reduziertes Set: Typen, die
// nuanciertes Textverständnis verlangen, lässt der lokale Pfad weg (kleine
// Modelle scheitern daran oder geraten in Wiederholungsloops).
const LOCAL_SET = new Set([
  'rechtschreibung', 'grammatik', 'stil', 'wiederholung', 'schwaches_verb', 'fuellwort',
]);

/**
 * Aktive Fehlertypen für einen Prompt-Lauf, in Enum-Reihenfolge.
 * @param {string|null} buchtyp
 * @param {{local?: boolean, stilOnly?: boolean}} opts
 */
export function lektoratTypen(buchtyp, { local = false, stilOnly = false } = {}) {
  let typen = PROFILE[lektoratProfil(buchtyp)];
  if (local)    typen = typen.filter(t => LOCAL_SET.has(t));
  if (stilOnly) typen = typen.filter(t => !OBJEKTIV_SET.has(t));
  return typen;
}

/** Enum des fokussierten Objektiv-Passes (buildObjektivLektoratPrompt). */
export function lektoratObjektivTypen(buchtyp, { hasFiguren = false } = {}) {
  const aktiv = new Set(lektoratTypen(buchtyp));
  return OBJEKTIV_TYPEN.filter(t => aktiv.has(t) && (hasFiguren || !FIGUREN_TYPEN.has(t)));
}

/** Im Objektiv-Pass verbotene Typen (= alles Nicht-Objektive des Profils). */
export function lektoratStilTypen(buchtyp) {
  return lektoratTypen(buchtyp, { stilOnly: true });
}

// ── Anti-Doppelungs-Priorität ────────────────────────────────────────────────
// Spezifisch schlägt generisch. Diese Liste ist die SSoT für BEIDE Dedup-Stellen:
// die EIN-EINTRAG-PRO-STELLE-Regel im Prompt und das Span-Overlap-Clustering in
// lib/lektorat-consolidate.js (dort als CJS-Kopie, gegated durch
// tests/unit/lektorat-typen-drift.test.mjs).
export const TYP_PRIORITAET = [
  'dialogformat', 'rechtschreibung', 'grammatik',
  'namenskonsistenz', 'figurenmerkmal', 'schauplatzmerkmal', 'anrede',
  'begriffsinkonsistenz', 'autorenform', 'unbelegt',
  'pleonasmus', 'wiederholung', 'perspektivbruch', 'tempuswechsel',
  'klischee', 'ki_geruch', 'passiv', 'show_vs_tell',
  'hedging', 'filterwort', 'schwaches_verb', 'fuellwort', 'satzbau', 'stil',
];

/** Priorität als Prompt-String, auf die aktiven Typen eines Laufs beschränkt. */
export function typPrioritaetString(typen) {
  const aktiv = new Set(typen);
  return TYP_PRIORITAET.filter(t => aktiv.has(t)).join(' > ');
}

// ── Cap-Zuständigkeit ────────────────────────────────────────────────────────
// Subjektiv-stilistische Typen: unterliegen der Schwere-Schwelle und der
// Mengen-Obergrenze (Prompt) sowie dem deterministischen Handler-Backstop
// (capStylisticFehler in routes/jobs/lektorat.js). Alles andere — mechanische
// Fehler und Konsistenz-Befunde inkl. `unbelegt`/`begriffsinkonsistenz`/
// `autorenform` — wird NIE gekappt.
export const STILISTISCHE_TYPEN = [
  'stil', 'satzbau', 'schwaches_verb', 'fuellwort', 'filterwort',
  'klischee', 'ki_geruch', 'show_vs_tell', 'passiv', 'pleonasmus', 'wiederholung',
  'hedging',
];

// Union aller je gültigen Typen — Basis der Server-Validierung und Referenz für
// die i18n-Vollständigkeit (`finding.<typ>` / `fehlerHeatmap.typ.<typ>`).
export const ALLE_LEKTORAT_TYPEN = [
  ...new Set([...NARRATIV_TYPEN, ...SACHLICH_TYPEN, ...WISSENSCHAFT_TYPEN]),
];

// ── Span-Typ pro Fehlertyp ───────────────────────────────────────────────────
// Welche Textspanne «original»/«korrektur» tragen müssen. Nur für die
// Fach-Profile aus dieser Map generiert; die narrativen Span-Regeln stehen als
// gewachsener Prosatext in prompts/lektorat.js.
const SPAN_KIND = {
  rechtschreibung: 'wort', grammatik: 'wort',
  pleonasmus: 'phrase', hedging: 'phrase',
  begriffsinkonsistenz: 'phrase', autorenform: 'phrase',
  wiederholung: 'satz', fuellwort: 'satz', passiv: 'satz', tempuswechsel: 'satz',
  schwaches_verb: 'satz', unbelegt: 'satz',
  stil: 'satz_oder_phrase', satzbau: 'satz_oder_phrase',
  klischee: 'satz_oder_phrase', ki_geruch: 'satz_oder_phrase',
};

const SPAN_LABEL = {
  wort:             'Phrase oder Wort (genau die fehlerhafte Stelle)',
  phrase:           'Phrase (genau die redundante / absichernde / abweichende Stelle)',
  satz:             'vollständiger Satz',
  satz_oder_phrase: 'vollständiger Satz ODER eindeutig abgrenzbare Phrase – beide Felder müssen denselben Span-Typ haben',
};

/** Span-Typ-Pflichtzeilen für die Fach-Profile, aus SPAN_KIND generiert. */
export function spanRegelnFach(typen) {
  const aktiv = new Set(typen);
  return Object.keys(SPAN_LABEL)
    .map(kind => {
      const gruppe = Object.keys(SPAN_KIND).filter(t => aktiv.has(t) && SPAN_KIND[t] === kind);
      return gruppe.length ? `  · ${gruppe.join(', ')}: ${SPAN_LABEL[kind]}` : null;
    })
    .filter(Boolean)
    .join('\n');
}

// Signatur für den Prompt-Content-Hash (public/js/prompts.js#_promptsContentHash).
// Die Prompt-BODYS fliessen nicht in den Hash (sie hängen an Call-Argumenten) —
// eine Profil-Änderung muss darum hier ankommen, sonst behält ein wissenschaftliches
// Buch seine alten, narrativ geprägten `lektorat_cache`-Zeilen.
export const PROFIL_SIGNATUR = JSON.stringify([
  PROFILE, PROFIL_BY_BUCHTYP, TYP_PRIORITAET, STILISTISCHE_TYPEN, SPAN_KIND,
]);
