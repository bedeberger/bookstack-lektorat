// Quellen-Erkennung (Job `source-detect`): die KI liest den Buchtext und meldet
// WERKE, die darin lose erwaehnt werden — ein Buch, ein Aufsatz, eine
// Zeitschrift, ohne dass ein Quellen-Marker gesetzt waere. Der Autor uebernimmt
// die Funde einzeln in seine Bibliothek.
//
// DAS MODELL EXTRAHIERT, ES RECHERCHIERT NICHT. Das Schema kennt bewusst weder
// `doi` noch `isbn`, `publisher` oder `place`: ein Sprachmodell erfindet solche
// Kennungen mit voller Ueberzeugung, und sie landen dann als Wahrheit im
// Quellenverzeichnis. Gefragt ist nur, was WOERTLICH im Text steht (Titel,
// genannte Personen, genanntes Jahr); die kanonischen Felder holt hinterher der
// deterministische Register-Lookup (lib/source-lookup.js#searchWork). Die
// Trennung ist die Existenzberechtigung des Features — wer das Schema um
// Metadaten-Felder erweitert, hebt sie auf.
//
// Rein rueckwaertsgewandt: findet, was schon dasteht, und schreibt NIE in den
// Buchtext. Auch keine Quellen-Marker — die setzt der Autor selbst im Editor.

import { _obj, _str } from './schema-utils.js';
import { _jsonOnly } from './state.js';
import { lektoratProfil } from './lektorat-typen.js';

// Modell-Werktyp → `sources.csl_type` (db/sources.js#CSL_TYPES). Bewusst ein
// kleines Vokabular: je feiner die Auswahl, desto mehr raet das Modell. Der
// Register-Lookup korrigiert den Typ ohnehin, wenn er das Werk findet.
export const SOURCE_DETECT_TYPES = {
  buch: 'book',
  aufsatz: 'article',
  zeitschrift: 'article',
  kapitel: 'chapter',
  hochschulschrift: 'thesis',
  bericht: 'report',
  webseite: 'website',
  film: 'film',
  sonstiges: 'other',
};

const TYP_ENUM = Object.keys(SOURCE_DETECT_TYPES);

export function buildSourceDetectSystemPrompt() {
  return `Du bist wissenschaftliche Hilfskraft und erfasst Literatur. Du liest einen Text und notierst jedes WERK, auf das der Text sich beruft oder das er namentlich nennt — Buecher, Aufsaetze, Zeitschriften, Hochschulschriften, Berichte, Filme.

Du bist Erfasserin, nicht Rechercheurin: du notierst ausschliesslich, was im vorliegenden Text steht. Du ergaenzt keine Verlage, keine Erscheinungsorte, keine ISBN/DOI und kein Jahr, das der Text nicht nennt. Fehlende Angaben bleiben leer — eine Luecke ist brauchbar, eine erfundene Angabe nicht.${_jsonOnly()}`;
}

/** Hinweisblock gegen die haeufigsten Fehlfunde, abhaengig vom Buchtyp.
 *  Bei erzaehlenden Werken ist die Verwechslungsgefahr am groessten: ein Roman
 *  darf Buecher erfinden, und ein erfundenes Werk hat in einer Bibliothek nichts
 *  verloren. Bei Sach-/Wissenschaftstexten ist der haeufigere Fehlfund das
 *  Gegenteil — dort wird die eigene Gliederung („siehe Kapitel 3") als Werk
 *  gelesen. */
function _fehlfundBlock(buchtyp) {
  const profil = lektoratProfil(buchtyp);
  if (profil === 'narrativ') {
    return `- ACHTUNG, erzaehlender Text: Werke, die nur in der erzaehlten Welt existieren (eine Figur liest ein erfundenes Buch, eine erfundene Zeitung wird zitiert), gehoeren NICHT in die Liste. Nimm nur Werke auf, von denen du weisst, dass es sie ausserhalb dieses Buches gibt.
- Titel von Liedern, Gemaelden oder Theaterstuecken, die blosse Erwaehnung bleiben, sind keine Quellen.`;
  }
  return `- Verweise auf die EIGENE Arbeit ("wie in Kapitel 3 gezeigt", "vgl. Abschnitt 2.1", "meine fruehere Studie") sind keine Werke.
- Institutionen, Datenbanken, Gesetze und Projekte ohne Werkcharakter ("das Bundesamt", "die Datenbank") nur aufnehmen, wenn der Text sie wie eine Publikation zitiert.`;
}

function _bekanntBlock(bekannteTitel) {
  const list = (bekannteTitel || [])
    .filter(t => typeof t === 'string' && t.trim())
    .slice(0, 200)
    .map(t => `- ${t}`);
  return list.length ? list.join('\n') : '(noch keine)';
}

/**
 * @param {string}   text          Buchtext (bereits aufs Budget gekuerzt).
 * @param {string[]} bekannteTitel Titel, die schon in der Bibliothek stehen.
 * @param {string}   buchKontext   BUCH_KONTEXT aus getBookPrompts.
 * @param {string}   buchtyp       book_settings.buchtyp (steuert _fehlfundBlock).
 */
export function buildSourceDetectPrompt(text, bekannteTitel = [], buchKontext = '', buchtyp = null) {
  const ctxSeg = (buchKontext || '').trim() ? `\nBUCH-KONTEXT:\n${buchKontext}\n` : '';
  return `Die Autorin baut das Quellenverzeichnis ihrer Arbeit auf. Im Text sind Werke erwaehnt, fuer die noch kein Nachweis erfasst ist. Finde sie.
${ctxSeg}
BEREITS IN DER BIBLIOTHEK (nicht erneut melden):
${_bekanntBlock(bekannteTitel)}

TEXT:
${text}

Regeln:
- Nur Werke, die der Text tatsaechlich nennt. Keine thematisch passende Literatur aus deinem Weltwissen.
- "titel" so, wie der Text ihn nennt. Nennt der Text nur den Autor ("bei Foucault heisst es"), lass "titel" leer und trage die Person ein.
- "autoren" als Klarnamen in Leserichtung ("Michel Foucault"), eine Person pro Eintrag. Nennt der Text keine Person, bleibt das Array leer.
- "jahr" nur, wenn es im Text steht. Sonst leer.
- "container" nur bei Aufsaetzen: die Zeitschrift oder der Sammelband, in dem der Aufsatz steht.
- "erwaehnung" ist ein WOERTLICHES Zitat aus dem obigen Text (ein Satz, hoechstens 200 Zeichen), in dem das Werk vorkommt. Nicht umformulieren — die Autorin springt darueber an die Fundstelle.
- Dasselbe Werk nur EINMAL, auch wenn es mehrfach vorkommt.
${_fehlfundBlock(buchtyp)}
- Findest du nichts, gib ein leeres Array zurueck. Ein leeres Ergebnis ist ein gueltiges Ergebnis.

Erlaubte Werte fuer "typ": ${TYP_ENUM.join(', ')}.

Antworte mit diesem JSON-Schema:
{
  "werke": [
    { "typ": "buch", "titel": "Titel wie im Text genannt", "autoren": ["Vorname Nachname"], "jahr": "1962", "container": "", "erwaehnung": "woertlicher Satz aus dem Text" }
  ]
}`;
}

export const SCHEMA_SOURCE_DETECT = _obj({
  werke: {
    type: 'array',
    items: _obj({
      typ: { type: 'string', enum: TYP_ENUM },
      titel: _str,
      autoren: { type: 'array', items: _str },
      jahr: _str,
      container: _str,
      erwaehnung: _str,
    }),
  },
});
