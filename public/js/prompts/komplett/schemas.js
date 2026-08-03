// Dynamische JSON-Schemas für Grammar-Constrained Decoding (lokale Provider) +
// statische Konsolidierungs-Schemas. _rebuildKomplettSchemas() baut die _isLocal-abhängigen
// Schemas nach configurePrompts() neu.
import { _isLocal } from '../state.js';
import { _obj, _str, _num } from '../schema-utils.js';

// ═════════════════════════════════════════════════════════════════════════════
// JSON-Schemas für Grammar-Constrained Decoding (lokale Provider)
// ═════════════════════════════════════════════════════════════════════════════
// Beziehungs-Items: für lokale Provider wird `machtverhaltnis` absichtlich aus dem
// JSON-Schema weggelassen – kleine Modelle setzen es fast immer 0 oder halluzinieren.
// Lieber das Feld leer lassen als falsche Werte anzeigen. Für Claude bleibt es erhalten.

const _bzBeleg = _obj({ kapitel: _str, seite: _str });
const _bzItem = () => _obj(_isLocal
  ? { figur_id: _str, typ: _str, beschreibung: _str, belege: { type: 'array', items: _bzBeleg } }
  : { figur_id: _str, typ: _str, machtverhaltnis: _num, beschreibung: _str, belege: { type: 'array', items: _bzBeleg } }
);

// Tiefe-Felder (aeusseres/stimme/hintergrund/arc) nur für Claude: lokale Grammar
// (_obj → alle Properties required) würde kleine Modelle zwingen, sie zu füllen →
// Halluzination/Bloat. Analog zum machtverhaltnis-Gating in _bzItem.
const _figurSchemaProps = () => ({
  id: _str,
  name: _str,
  kurzname: _str,
  typ: _str,
  geburtstag: _str,
  geschlecht: _str,
  beruf: _str,
  wohnadresse: _str,
  ...(_isLocal ? {} : {
    aeusseres: _str,
    stimme: _str,
    hintergrund: _str,
  }),
  rolle: _str,
  motivation: _str,
  konflikt: _str,
  beschreibung: _str,
  sozialschicht: _str,
  praesenz: { type: 'string', enum: ['zentral', 'regelmaessig', 'punktuell', 'randfigur'] },
  ...(_isLocal
    ? { entwicklung: _str }
    : { arc: _obj({ typ: _str, anfang: _str, wendepunkte: { type: 'array', items: _str }, ende: _str }) }),
  erste_erwaehnung: _str,
  schluesselzitate: { type: 'array', items: _str },
  eigenschaften: { type: 'array', items: _str },
  kapitel: { type: 'array', items: _obj({ name: _str, haeufigkeit: _num }) },
  beziehungen: { type: 'array', items: _bzItem() },
});

// _figurSchema und alle abgeleiteten Schemas werden in _rebuildKomplettSchemas() bei jedem
// configurePrompts-Aufruf neu gebaut, damit der dynamisch gesetzte _isLocal-Flag korrekt
// wirkt (z.B. machtverhaltnis-Weglassen).
let _figurSchema = _obj(_figurSchemaProps());

// Stammdaten-Schema OHNE Beziehungen (Claude-Single-Pass A1).
const _figurStammSchemaProps = () => {
  const p = _figurSchemaProps();
  delete p.beziehungen;
  return p;
};
let _figurStammSchema = _obj(_figurStammSchemaProps());

const _ortSchema = _obj({
  id: _str,
  name: _str,
  typ: _str,
  beschreibung: _str,
  land: _str,
  erste_erwaehnung: _str,
  stimmung: _str,
  kapitel: { type: 'array', items: _obj({ name: _str, haeufigkeit: _num }) },
  figuren_namen: { type: 'array', items: _str },
});

const _songSchema = _obj({
  id: _str,
  titel: _str,
  interpret: _str,
  genre: _str,
  kontext_typ: _str,
  beschreibung: _str,
  stimmung: _str,
  erste_erwaehnung: _str,
  kapitel: { type: 'array', items: _obj({ name: _str, haeufigkeit: _num }) },
  figuren_namen: { type: 'array', items: _str },
});

const _faktSchema = _obj({ kategorie: _str, subjekt: _str, fakt: _str, seite: _str });

export let SCHEMA_KOMPLETT_EXTRAKTION = null;
export let SCHEMA_KOMPLETT_FIGUREN_PASS = null;
export let SCHEMA_KOMPLETT_FIGUREN_STAMM = null;
export let SCHEMA_KOMPLETT_ORTE_PASS = null;
export let SCHEMA_KOMPLETT_FAKTEN_PASS = null;
export let SCHEMA_KOMPLETT_EVENTS = null;
export let SCHEMA_FIGUREN_KONSOL = null;
export let SCHEMA_BEZIEHUNGEN = null;

function _szenenField() {
  return {
    type: 'array',
    items: _obj({
      seite: _str,
      kapitel: _str,
      titel: _str,
      wertung: { type: 'string', enum: ['stark', 'mittel', 'schwach'] },
      kommentar: _str,
      figuren_namen: { type: 'array', items: _str },
      orte_namen: { type: 'array', items: _str },
    }),
  };
}

// Whitelist für Event-Subtypen (Phase 2). KI darf nur diese Werte liefern;
// Server-Save fällt sonst auf 'sonstiges' zurück. SSoT des KI-Vertrags – die
// Server-Persistenz (db/event-subtyp.js) MUSS deckungsgleich bleiben (gegated
// durch tests/unit/event-subtyp-drift.test.mjs).
export const EVENT_SUBTYP_ENUM = [
  'geburt', 'tod', 'hochzeit', 'liebe', 'trennung', 'krankheit',
  'reise', 'umzug', 'konflikt', 'wendepunkt', 'entdeckung', 'verlust', 'sieg',
  'extern_politisch', 'extern_wirtschaftlich', 'extern_natur', 'extern_kulturell', 'extern_krieg',
  'sonstiges',
];

// Datumsfelder eines Events sind NULLABLE-Zahlen. Zwingend so, nicht als _num:
// `_obj` macht jede Property required, und mit `type: 'number'` kann ein lokaler
// Provider unter Constrained Decoding gar kein `null` erzeugen — er muss dann
// eine Zahl setzen und waehlt 0. Genau dieser 0-Platzhalter ist es, den
// lib/datum-parse#normalizeDatumFields serverseitig wieder einfangen muss.
// Claude ignoriert Schemas (callAI), dort traegt allein die Prompt-Regel.
const _numOrNull = { type: ['number', 'null'] };

const _EVENT_DATUM_FIELDS = {
  datum:            _str,
  datum_label:      _str,
  datum_year:       _numOrNull,
  datum_month:      _numOrNull,
  datum_day:        _numOrNull,
  datum_ende_year:  _numOrNull,
  datum_ende_month: _numOrNull,
  datum_ende_day:   _numOrNull,
  story_tag:        _numOrNull,
  datum_unsicher:   { type: 'boolean' },
};

function _assignmentsField() {
  return {
    type: 'array',
    items: _obj({
      figur_name: _str,
      lebensereignisse: {
        type: 'array',
        items: _obj({
          ..._EVENT_DATUM_FIELDS,
          subtyp: { type: 'string', enum: EVENT_SUBTYP_ENUM },
          ereignis: _str,
          typ: { type: 'string', enum: ['persoenlich', 'extern'] },
          bedeutung: _str,
          seite: _str,
          kapitel: _str,
        }),
      },
    }),
  };
}

function _buildExtraktionSchema() {
  return _obj({
    figuren: { type: 'array', items: _figurSchema },
    orte: { type: 'array', items: _ortSchema },
    songs: { type: 'array', items: _songSchema },
    fakten: { type: 'array', items: _faktSchema },
    szenen: _szenenField(),
    assignments: _assignmentsField(),
  });
}

function _buildFigurenPassSchema() {
  return _obj({
    figuren: { type: 'array', items: _figurSchema },
    assignments: _assignmentsField(),
  });
}

// Claude-Single-Pass A1: reine Figuren-Stammdaten OHNE Beziehungen UND OHNE
// Lebensereignisse – Events zieht Claude in einen eigenen Pass (SCHEMA_KOMPLETT_EVENTS),
// damit das gesamte Output-Budget der Event-Erfassung gewidmet ist (analog Fakten-Pass C).
function _buildFigurenStammSchema() {
  return _obj({
    figuren: { type: 'array', items: _figurStammSchema },
  });
}

// Claude-Single-Pass E: nur Lebensereignisse pro Figur (eigener Call gegen den
// gecachten Buchtext-Block). Volle Modell-Aufmerksamkeit auf vollständige
// Event-Erfassung, ohne mit Figuren-Stammdaten ums Attention-Budget zu konkurrieren.
function _buildEventsPassSchema() {
  return _obj({ assignments: _assignmentsField() });
}

// Claude zieht Fakten in einen eigenen Pass (SCHEMA_KOMPLETT_FAKTEN_PASS); nur lokale
// Provider behalten fakten im kombinierten Pass-B-Schema. Schema-Gating muss zur
// _isLocal-Gating in buildKomplettSchemaOrteSzenen (extraktion.js) passen.
function _buildOrtePassSchema() {
  return _obj({
    orte: { type: 'array', items: _ortSchema },
    songs: { type: 'array', items: _songSchema },
    ...(_isLocal ? { fakten: { type: 'array', items: _faktSchema } } : {}),
    szenen: _szenenField(),
  });
}

function _buildFaktenPassSchema() {
  return _obj({ fakten: { type: 'array', items: _faktSchema } });
}

function _buildBeziehungenSchema() {
  const belegeField = { belege: { type: 'array', items: _bzBeleg } };
  const props = _isLocal
    ? { von: _str, zu: _str, typ: _str, beschreibung: _str, ...belegeField }
    : { von: _str, zu: _str, typ: _str, machtverhaltnis: _num, beschreibung: _str, ...belegeField };
  return _obj({ beziehungen: { type: 'array', items: _obj(props) } });
}

export function _rebuildKomplettSchemas() {
  _figurSchema = _obj(_figurSchemaProps());
  _figurStammSchema = _obj(_figurStammSchemaProps());
  SCHEMA_KOMPLETT_EXTRAKTION = _buildExtraktionSchema();
  SCHEMA_KOMPLETT_FIGUREN_PASS = _buildFigurenPassSchema();
  SCHEMA_KOMPLETT_FIGUREN_STAMM = _buildFigurenStammSchema();
  SCHEMA_KOMPLETT_ORTE_PASS = _buildOrtePassSchema();
  SCHEMA_KOMPLETT_FAKTEN_PASS = _buildFaktenPassSchema();
  SCHEMA_KOMPLETT_EVENTS = _buildEventsPassSchema();
  SCHEMA_FIGUREN_KONSOL = _obj({ figuren: { type: 'array', items: _figurSchema } });
  SCHEMA_BEZIEHUNGEN = _buildBeziehungenSchema();
}

_rebuildKomplettSchemas();

// ── Statische Schemas (nicht _isLocal-abhängig) ──────────────────────────────

export const SCHEMA_ORTE_KONSOL = _obj({ orte: { type: 'array', items: _ortSchema } });

export const SCHEMA_SONGS_KONSOL = _obj({ songs: { type: 'array', items: _songSchema } });

export const SCHEMA_SOZIOGRAMM_KONSOL = _obj({
  figuren:     { type: 'array', items: _obj({ id: _str, sozialschicht: _str }) },
  beziehungen: { type: 'array', items: _obj({ from_fig_id: _str, to_fig_id: _str, machtverhaltnis: _num }) },
});

export const SCHEMA_ZEITSTRAHL = _obj({
  ereignisse: {
    type: 'array',
    items: _obj({
      ..._EVENT_DATUM_FIELDS,
      subtyp: { type: 'string', enum: EVENT_SUBTYP_ENUM },
      ereignis: _str,
      typ: { type: 'string', enum: ['persoenlich', 'extern'] },
      bedeutung: _str,
      kapitel: { type: 'array', items: _str },
      seiten: { type: 'array', items: _str },
      figuren: { type: 'array', items: _obj({ id: _str, name: _str, typ: _str }) },
    }),
  },
});

export const SCHEMA_KONTINUITAET_FAKTEN = _obj({
  fakten: { type: 'array', items: _faktSchema },
});

// Verify-Stufe: pro gemeldetem Multi-Pass-Problem die Bestätigung mit Originaltext.
export const SCHEMA_KONTINUITAET_VERIFY = _obj({
  bestaetigt: { type: 'boolean' },
  grund: _str,
});

// _reasoning MUSS das erste Property bleiben: PROBLEME_RULES (schema-strings.js)
// erzwingt Reasoning-First als zentrale False-Positive-Abwehr. _obj() macht alle
// Properties required + additionalProperties:false – ohne dieses Feld verbietet die
// Grammar lokaler Provider (ollama/llama) genau das vom Prompt geforderte Reasoning.
export const SCHEMA_KONTINUITAET_PROBLEME = _obj({
  _reasoning: _str,
  probleme: {
    type: 'array',
    items: _obj({
      schwere: { type: 'string', enum: ['kritisch', 'mittel', 'niedrig'] },
      typ: _str,
      beschreibung: _str,
      stelle_a: _str,
      stelle_b: _str,
      figuren: { type: 'array', items: _str },
      kapitel: { type: 'array', items: _str },
      empfehlung: _str,
    }),
  },
  zusammenfassung: _str,
});

// Coverage-Self-Audit (F2): pro gesampeltem Kapitel meldet das Modell, wie viele der
// bekannten Figuren/Orte es im Passus wiedererkannt hat und welche NAMENTLICH genannten
// FEHLEN. Der Score wird im Job aus (erkannt / (erkannt + fehlend)) berechnet.
export const SCHEMA_COVERAGE_AUDIT = _obj({
  erkannte_figuren: _num,
  fehlende_figuren: { type: 'array', items: _str },
  erkannte_orte: _num,
  fehlende_orte: { type: 'array', items: _str },
});

// Remap-Rescue: Zuordnung unauflösbarer Figuren-Bezeichnungen zum Katalog (oder «» = keine).
// Runtime-only (kein persistenter Cache) → NICHT in _promptsContentHash.
export const SCHEMA_NAME_RESOLUTION = _obj({
  zuordnungen: {
    type: 'array',
    items: _obj({ name: _str, treffer: _str }),
  },
});

// Alias-Cluster (F3): Cluster von Namensvarianten, die dieselbe Figur bezeichnen
// (Epitheta, Spitznamen, Umbenennungen). `kanonisch` = bevorzugter Name; `aliase` =
// die übrigen Namen aus der Kandidatenliste, die zu derselben Figur gehören.
export const SCHEMA_FIGUREN_ALIAS_CLUSTER = _obj({
  cluster: {
    type: 'array',
    items: _obj({ kanonisch: _str, aliase: { type: 'array', items: _str } }),
  },
});

// Attribut-Widerspruch-Urteil (F4): pro deterministisch gefundenem Kandidatenpaar
// entscheidet das Modell, ob ein echter Kontinuitätswiderspruch vorliegt. Reasoning-First
// als False-Positive-Abwehr (analog SCHEMA_KONTINUITAET_PROBLEME).
export const SCHEMA_ATTR_CONTRADICTION = _obj({
  _reasoning: _str,
  widerspruch: { type: 'boolean' },
  schwere: { type: 'string', enum: ['kritisch', 'mittel', 'niedrig'] },
  beschreibung: _str,
  empfehlung: _str,
});

// Entitäten-Paar-Urteil: pro Graubereich-Paar des Matchings (Figur/Ort/Szene) sagt das
// Modell, ob beide Einträge dieselbe Entität bezeichnen. Reasoning-First als
// False-Positive-Abwehr (analog SCHEMA_ATTR_CONTRADICTION); nur `gleich === true`
// führt zu einem Merge, alles andere lässt die Einträge getrennt.
export const SCHEMA_ENTITY_MATCH = _obj({
  paare: {
    type: 'array',
    items: _obj({ nr: _num, _reasoning: _str, gleich: { type: 'boolean' } }),
  },
});

// Weltfakten-Realitätscheck (Faktencheck-Job): pro extrahiertem Welt-Fakt urteilt das
// Modell, ob die Aussage der realen Faktenlage widerspricht — mit Web-Suche als Grundlage.
// Reasoning-First als False-Positive-Abwehr (analog SCHEMA_ATTR_CONTRADICTION). `urteil`
// dreistufig: nur «falsch» erzeugt einen Befund; «unklar» (keine belastbare Quelle) und
// «korrekt» werden verworfen. `quelle` = belegende URL (nur bei «falsch» Pflicht).
export const SCHEMA_FAKT_REALITY = _obj({
  _reasoning: _str,
  urteil: { type: 'string', enum: ['korrekt', 'falsch', 'unklar'] },
  schwere: { type: 'string', enum: ['kritisch', 'mittel', 'niedrig'] },
  beschreibung: _str,
  quelle: _str,
  empfehlung: _str,
});

// ── Kapitel-Erzählprofil (Phase «Erzählprofil») ──────────────────────────────
// Pro Kapitel: erkannte Erzählperspektive/-zeit (Enum-Keys deckungsgleich mit
// routes/jobs/narrative-labels.js POV_LABELS/TEMPUS_LABELS — SSoT-Drift vermeiden),
// Erzähler-/Fokusfigur (Klarname), POV-Konfidenz + Beleg, Spannungs-Intensität 1–5,
// dominante Themen/Motive/Symbole. Static (nicht _isLocal-abhängig); die Enums helfen
// lokalen Providern (Grammar-Constrained), Claude ignoriert das Schema.
export const ERZAEHLPROFIL_POV_ENUM = ['ich', 'du', 'er_sie_personal', 'er_sie_auktorial', 'wir', 'gemischt'];
export const ERZAEHLPROFIL_TEMPUS_ENUM = ['praeteritum', 'praesens', 'gemischt'];
const _themaItem = _obj({
  thema: _str,
  typ: { type: 'string', enum: ['thema', 'motiv', 'symbol'] },
  // 2–4 kurze wörtliche Zitate, die das Thema/Motiv im Kapitel belegen.
  belege: { type: 'array', items: _str },
});
const _erzaehlprofilProps = (withKapitel) => ({
  ...(withKapitel ? { kapitel: _str } : {}),
  perspektive: { type: 'string', enum: ERZAEHLPROFIL_POV_ENUM },
  erzaehlzeit: { type: 'string', enum: ERZAEHLPROFIL_TEMPUS_ENUM },
  erzaehler_figur: _str,
  pov_konfidenz: _num,
  pov_beleg: _str,
  intensitaet: _num,
  intensitaet_begruendung: _str,
  zusammenfassung: _str,
  themen: { type: 'array', items: _themaItem },
});
// Single-Pass (ganzes Buch → Array pro Kapitel).
export const SCHEMA_ERZAEHLPROFIL = _obj({
  kapitel: { type: 'array', items: _obj(_erzaehlprofilProps(true)) },
});
// Multi-Pass (ein Kapitel pro Call; Kapitelname ist im Prompt bekannt).
export const SCHEMA_ERZAEHLPROFIL_CHAPTER = _obj(_erzaehlprofilProps(false));

// KI-Dach-Befund (Autoren-Befund): priorisierte Synthese der deterministischen
// Struktur-Befunde. Das Modell benennt/priorisiert nur die gelieferten Kennzahlen,
// es erfindet keine neuen Befunde (Verankerung erzwungen im Prompt).
export const AUTOREN_BEFUND_KAT_ENUM = ['figuren', 'pacing', 'struktur', 'perspektive', 'kohaerenz', 'thema', 'orte', 'dramaturgie'];
export const SCHEMA_AUTOREN_BEFUND = _obj({
  zusammenfassung: _str,
  befunde: {
    type: 'array',
    items: _obj({
      kategorie: { type: 'string', enum: AUTOREN_BEFUND_KAT_ENUM },
      prio: { type: 'string', enum: ['hoch', 'mittel', 'niedrig'] },
      titel: _str,
      text: _str,
      beleg: _str,
    }),
  },
});
