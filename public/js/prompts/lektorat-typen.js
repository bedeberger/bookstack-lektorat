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

import { istMeinungsform } from './textsorten.js';

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

// Journalistischer Text (Nachricht, Bericht, Reportage, Porträt, Kommentar):
// argumentierend wie der Sachtext, aber mit vier eigenen Pflichten, die weder
// das narrative noch das wissenschaftliche Profil kennt — indirekte Rede im
// Konjunktiv I, Zuschreibung jeder fremden Aussage, Trennung von Nachricht und
// Meinung, Übersetzung von Amts- und PR-Sprache. `unbelegt` fehlt bewusst: der
// Beleg ist hier die genannte Person oder Stelle im Satz, nicht der Kurzbeleg —
// das deckt `zuschreibung` ab. `hedging` ebenfalls nicht: die Absicherung im
// Verdachtsfall («soll», «mutmasslich») ist presserechtlich geboten, nicht
// Stapelung. Erzähl-Handwerk (show_vs_tell, filterwort, Figuren-/Schauplatz-
// Konsistenz) entfällt wie im Sachprofil; starke Verben, Aktiv und frische
// Bilder bleiben Ziel.
export const JOURNALISTISCH_TYPEN = [
  'rechtschreibung', 'grammatik', 'konjunktiv',
  'stil', 'satzbau', 'wiederholung', 'schwaches_verb', 'fuellwort',
  'klischee', 'pleonasmus', 'ki_geruch', 'passiv', 'amtsdeutsch',
  'tempuswechsel', 'begriffsinkonsistenz',
  'zuschreibung', 'wertung',
];

const PROFILE = {
  narrativ:      NARRATIV_TYPEN,
  sachlich:      SACHLICH_TYPEN,
  wissenschaft:  WISSENSCHAFT_TYPEN,
  journalistisch: JOURNALISTISCH_TYPEN,
};

// buchtyp-Key (prompt-config.json `buchtypen`) → Profil. Alles Ungenannte,
// inkl. null/unbekannt, fällt auf 'narrativ' zurück.
// `lyrik` bleibt bewusst narrativ: Wiederholung und starke Bildsprache sind dort
// Kunstmittel, das braucht ein eigenes Profil statt einer Sachbuch-Näherung.
const PROFIL_BY_BUCHTYP = {
  wissenschaft:  'wissenschaft',
  sachbuch:      'sachlich',
  essay:         'sachlich',
  blog:          'sachlich',
  journalismus:  'journalistisch',
};

/** Profilname für einen Buchtyp. Unbekannt/null → 'narrativ'. */
export function lektoratProfil(buchtyp) {
  return PROFIL_BY_BUCHTYP[buchtyp] || 'narrativ';
}

// Objektive/mechanische Typen: werden im Claude-Split im fokussierten Objektiv-Pass
// geprüft und sind im Stil-Pass verboten. Reihenfolge = Enum-Reihenfolge dort.
// `konjunktiv` gehört hierher, weil der Modus der indirekten Rede eine
// Formfrage ist wie Kasus oder Kongruenz — nicht Geschmack. Er steht nur im
// journalistischen Profil und fällt in allen anderen über den `aktiv`-Filter
// von lektoratObjektivTypen() heraus.
export const OBJEKTIV_TYPEN = [
  'rechtschreibung', 'grammatik', 'konjunktiv', 'dialogformat',
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
 *
 * `textsorte` greift nur im journalistischen Profil: in den meinungsbetonten
 * Formen (Kommentar, Glosse, Rezension) fällt `wertung` ersatzlos weg — dort ist
 * die Wertung der Zweck des Textes. Ohne diesen Schnitt meldete das Lektorat
 * einen Kommentar Satz für Satz als fehlerhaft.
 *
 * @param {string|null} buchtyp
 * @param {{local?: boolean, stilOnly?: boolean, textsorte?: string|null}} opts
 */
export function lektoratTypen(buchtyp, { local = false, stilOnly = false, textsorte = null } = {}) {
  let typen = PROFILE[lektoratProfil(buchtyp)];
  if (istMeinungsform(textsorte)) typen = typen.filter(t => t !== 'wertung');
  if (local)    typen = typen.filter(t => LOCAL_SET.has(t));
  if (stilOnly) typen = typen.filter(t => !OBJEKTIV_SET.has(t));
  return typen;
}

/** Enum des fokussierten Objektiv-Passes (buildObjektivLektoratPrompt). */
export function lektoratObjektivTypen(buchtyp, { hasFiguren = false, textsorte = null } = {}) {
  const aktiv = new Set(lektoratTypen(buchtyp, { textsorte }));
  return OBJEKTIV_TYPEN.filter(t => aktiv.has(t) && (hasFiguren || !FIGUREN_TYPEN.has(t)));
}

/** Im Objektiv-Pass verbotene Typen (= alles Nicht-Objektive des Profils). */
export function lektoratStilTypen(buchtyp, { textsorte = null } = {}) {
  return lektoratTypen(buchtyp, { stilOnly: true, textsorte });
}

// ── Anti-Doppelungs-Priorität ────────────────────────────────────────────────
// Spezifisch schlägt generisch. Diese Liste ist die SSoT für BEIDE Dedup-Stellen:
// die EIN-EINTRAG-PRO-STELLE-Regel im Prompt und das Span-Overlap-Clustering in
// lib/lektorat-consolidate.js (dort als CJS-Kopie, gegated durch
// tests/unit/lektorat-typen-drift.test.mjs).
export const TYP_PRIORITAET = [
  'dialogformat', 'rechtschreibung', 'konjunktiv', 'grammatik',
  'namenskonsistenz', 'figurenmerkmal', 'schauplatzmerkmal', 'anrede',
  'begriffsinkonsistenz', 'autorenform', 'zuschreibung', 'unbelegt', 'wertung',
  'pleonasmus', 'wiederholung', 'perspektivbruch', 'tempuswechsel',
  'klischee', 'amtsdeutsch', 'ki_geruch', 'passiv', 'show_vs_tell',
  'hedging', 'filterwort', 'schwaches_verb', 'fuellwort', 'satzbau', 'stil',
];

/** Priorität als Prompt-String, auf die aktiven Typen eines Laufs beschränkt. */
export function typPrioritaetString(typen) {
  const aktiv = new Set(typen);
  return TYP_PRIORITAET.filter(t => aktiv.has(t)).join(' > ');
}

// ── Querverweise zwischen Typen ──────────────────────────────────────────────
// Die Regelblöcke grenzen ihren Typ gegen die Nachbartypen ab («Grammatikfehler
// → grammatik, NICHT stil»). Im Stil-Pass des Claude-Splits sind die objektiven
// Typen aber gar nicht im Enum — ein Verweis auf sie ist dort eine Sackgasse:
// das Modell etikettiert den Fund dann eher um (Kommafehler als «satzbau»), statt
// ihn dem Objektiv-Pass zu überlassen. Darum wird jede Verweisliste gegen die
// aktiven Typen gefiltert und der Rest durch den expliziten Hinweis ersetzt.

/** Verweisliste auf die aktiven Typen eines Laufs filtern. */
export function verweisTypen(kandidaten, typen) {
  const aktiv = new Set(typen);
  return kandidaten.filter(t => aktiv.has(t));
}

/** Ersatz-Verweis für Typen, die in diesem Lauf nicht gemeldet werden dürfen. */
export const OBJEKTIV_VERWEIS = 'gehört in den separaten Objektiv-Pass – hier NICHT melden';

/**
 * Ein Verweisziel rendern: der Typname, solange er im Lauf gemeldet werden darf,
 * sonst der Hinweis auf den Objektiv-Pass.
 */
export function verweisZiel(typ, typen) {
  return typen.includes(typ) ? typ : OBJEKTIV_VERWEIS;
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
  'hedging', 'amtsdeutsch',
];

// Union aller je gültigen Typen — Basis der Server-Validierung und Referenz für
// die i18n-Vollständigkeit (`finding.<typ>` / `fehlerHeatmap.typ.<typ>`).
export const ALLE_LEKTORAT_TYPEN = [
  ...new Set([...NARRATIV_TYPEN, ...SACHLICH_TYPEN, ...WISSENSCHAFT_TYPEN, ...JOURNALISTISCH_TYPEN]),
];

// ── Span-Typ pro Fehlertyp ───────────────────────────────────────────────────
// Welche Textspanne «original»/«korrektur» tragen müssen. Deckt ALLE Profile ab
// (auch die narrativen und die lokal geprüften Typen) — die Span-Regeln im
// Prompt werden daraus generiert, statt als Prosatext pro Profil dazustehen.
// Why: der handgeschriebene narrative Block nannte Pflicht-Spannen für Typen,
// die der Stil-Pass gar nicht melden darf (rechtschreibung, grammatik,
// dialogformat, namenskonsistenz) — eine Anweisung, die dem Verbot in der
// <aufgabe> direkt widerspricht. Generiert kann das nicht mehr driften.
const SPAN_KIND = {
  rechtschreibung: 'wort', grammatik: 'wort',
  namenskonsistenz: 'name',
  pleonasmus: 'phrase', hedging: 'phrase',
  begriffsinkonsistenz: 'phrase', autorenform: 'phrase',
  figurenmerkmal: 'phrase', anrede: 'phrase', schauplatzmerkmal: 'phrase',
  dialogformat: 'phrase',
  wiederholung: 'satz', fuellwort: 'satz', passiv: 'satz', tempuswechsel: 'satz',
  schwaches_verb: 'satz', unbelegt: 'satz',
  filterwort: 'satz', show_vs_tell: 'satz', perspektivbruch: 'satz',
  // Journalistisch: der Modus und die Zuschreibung hängen am ganzen Satz der
  // referierten Rede; Wertung und Amtsdeutsch können Satz oder Phrase sein.
  konjunktiv: 'satz', zuschreibung: 'satz',
  wertung: 'satz_oder_phrase', amtsdeutsch: 'satz_oder_phrase',
  stil: 'satz_oder_phrase', satzbau: 'satz_oder_phrase',
  klischee: 'satz_oder_phrase', ki_geruch: 'satz_oder_phrase',
};

const SPAN_LABEL = {
  wort:             'Phrase oder Wort (genau die fehlerhafte Stelle)',
  name:             'einzelnes Wort (der falsch geschriebene Name)',
  phrase:           'Phrase (genau die widersprüchliche / redundante / absichernde / typografisch falsche Stelle)',
  satz:             'vollständiger Satz',
  satz_oder_phrase: 'vollständiger Satz ODER eindeutig abgrenzbare Phrase – beide Felder müssen denselben Span-Typ haben',
};

/** Span-Typ-Pflichtzeilen eines Laufs, aus SPAN_KIND auf die aktiven Typen gefiltert. */
export function spanRegeln(typen) {
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
