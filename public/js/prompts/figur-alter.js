// Alters-Analyse der Figuren (Job `figur-alter`): das Modell liest KANDIDATEN-
// SAETZE und sagt, was sie ueber das Alter einer Figur behaupten.
//
// DREI SCHICHTEN, BEWUSST GETRENNT (wie bei der Quellen-Erkennung):
//   1. Deterministisch (lib/figure-age/): welche Saetze koennen ueberhaupt etwas
//      ueber ein Alter sagen — Muster + Figurenname im Satzfenster.
//   2. Das Modell hier: was behaupten diese Saetze. Nur das Modell sieht, dass
//      „an ihrem sechzehnten Geburtstag" ein Alter nennt und „1912 kehrte sie
//      zurueck" nur ein Bezugsjahr; nur es loest „drei Jahre spaeter" auf.
//   3. Wieder deterministisch: Zitat nachschlagen, Spanne bilden, Widerspruch
//      erkennen (lib/figure-age/consolidate.js).
//
// DAS MODELL RECHNET NICHT UND RAET NICHT. Es bekommt kein Feld fuer „geschaetztes
// Alter": ein Sprachmodell schaetzt das Alter jeder Figur, nach der man fragt, und
// die Schaetzung sieht in einer Tabelle wie ein Befund aus. Gefragt ist nur, was
// im vorgelegten Satz STEHT — samt woertlichem Zitat, an dem sich das nachpruefen
// laesst. Kein Zitat, kein Fund.
//
// Rein rueckwaertsgewandt: schreibt nie in den Buchtext und nie in `figures`.

import { _obj, _str, _num } from './schema-utils.js';
import { _jsonOnly } from './state.js';

const ART_ENUM = ['alter', 'geburtsjahr', 'todesjahr'];

export function buildFigurAlterSystemPrompt() {
  return `Du bist Lektorin und fuehrst die Figurenkartei eines Manuskripts. Deine Aufgabe ist eng: du liest vorgelegte Textstellen und notierst, welche ALTERSANGABE darin ueber welche Figur gemacht wird — ein Alter in Jahren, ein Geburtsjahr, ein Todesjahr.

Du notierst nur, was die Stelle sagt. Du schaetzt kein Alter, du rechnest keines aus deinem Weltwissen aus, und du uebertraegst keine Angabe von einer Figur auf eine andere. Zu jeder Angabe gehoert das woertliche Zitat der Stelle — ohne Zitat gilt die Angabe als nicht gemacht. Eine Figur ohne Angabe ist ein gueltiges Ergebnis.${_jsonOnly()}`;
}

/** Eine Figur samt ihren Kandidatensaetzen als Prompt-Block. */
function _figurBlock(f, nr) {
  const kopf = [
    f.kurzname && f.kurzname !== f.name ? `«${f.kurzname}»` : '',
    f.typ || '',
    f.geburtstag ? `im Steckbrief: geboren ${f.geburtstag}` : '',
  ].filter(Boolean).join(', ');
  const stellen = (f.stellen || []).map((s, i) => {
    const ort = [s.chapter, s.page_name].filter(Boolean).join(' › ');
    const hinweis = s.indirekt ? ' [Figur steht im Satz davor]' : '';
    return `  (${nr}.${i + 1})${ort ? ` [${ort}]` : ''}${hinweis} ${s.satz}`;
  });
  return `${nr}. ${f.name}${kopf ? ` (${kopf})` : ''}\n${stellen.length ? stellen.join('\n') : '  (keine Stellen gefunden)'}`;
}

/**
 * @param {Array}  figuren  [{ id, name, kurzname, typ, geburtstag, stellen: [{ satz, chapter, page_name, indirekt }] }]
 * @param {string} buchKontext  BUCH_KONTEXT aus getBookPrompts.
 * @param {object} zeit  { minYear, maxYear } — Spanne des konsolidierten Zeitstrahls, falls vorhanden.
 */
export function buildFigurAlterPrompt(figuren = [], buchKontext = '', zeit = null) {
  const ctxSeg = (buchKontext || '').trim() ? `\nBUCH-KONTEXT:\n${buchKontext}\n` : '';
  const zeitSeg = (zeit && (zeit.minYear != null || zeit.maxYear != null))
    ? `\nERZAEHLTE ZEIT (aus dem Zeitstrahl des Buchs): ${zeit.minYear ?? '?'} bis ${zeit.maxYear ?? '?'}. Nimm sie als Bezugsrahmen, aber nur wenn die Stelle selbst kein Jahr nennt.\n`
    : '';
  return `Die Autorin will wissen, wie alt ihre Figuren im Buch sind. Unten stehen zu jeder Figur die Textstellen, in denen eine Alters- oder Jahresangabe in ihrer Naehe vorkommt. Lies sie und notiere, was sie ueber DIESE Figur sagen.
${ctxSeg}${zeitSeg}
FIGUREN UND IHRE STELLEN:
${figuren.map((f, i) => _figurBlock(f, i + 1)).join('\n\n')}

Regeln:
- "figur" ist der Name genau so, wie er oben in der Liste steht.
- "art": "alter" = Alter in Jahren, "geburtsjahr" = Jahr der Geburt, "todesjahr" = Jahr des Todes.
- "wert" ist eine ganze Zahl. Ein ausgeschriebenes Zahlwort ("zwoelf", "einundvierzig") wird zur Ziffer. Bei "an ihrem sechzehnten Geburtstag" ist der Wert 16.
- "bezugsjahr": das Jahr, in dem dieses Alter gilt — nur wenn die Stelle es nennt oder der Kontext es eindeutig hergibt. Sonst leer lassen.
- "zitat" ist ein WOERTLICHES Stueck der oben vorgelegten Stelle (hoechstens 200 Zeichen), in dem die Angabe steht. Nicht umformulieren, nicht zusammensetzen, nicht uebersetzen — die Autorin springt darueber an die Fundstelle, und ein veraendertes Zitat findet sie nicht.
- "unsicher": true, wenn die Stelle die Angabe nur nahelegt (Pronomen-Bezug unklar, Zahl koennte etwas anderes meinen, Rueckblende ungewiss). Ein unsicherer Fund ist brauchbar, ein als sicher ausgegebener falscher nicht.
- Eine Stelle, in der die Zahl NICHTS mit einem Alter zu tun hat (Uhrzeit, Hausnummer, Geldbetrag, Anzahl von Dingen, Jahreszahl eines Ereignisses ohne Bezug zur Figur), ergibt keinen Fund.
- Steht die Figur nur im Satz davor ([Figur steht im Satz davor]), pruefe den Pronomen-Bezug. Traegt er nicht, gib keinen Fund aus.
- Mehrere Angaben zur selben Figur sind erwuenscht, wenn der Text sie an verschiedenen Stellen macht — daraus liest die Autorin ab, wie die Figur altert. Dieselbe Angabe nicht doppelt.
- Findest du nichts, gib ein leeres Array zurueck.

Antworte mit diesem JSON-Schema:
{
  "funde": [
    { "figur": "Name wie oben", "art": "alter", "wert": 12, "bezugsjahr": 1912, "unsicher": false, "zitat": "woertliches Stueck der Stelle", "begruendung": "in einem Satz, woraus sich das ergibt" }
  ]
}`;
}

export const SCHEMA_FIGUR_ALTER = _obj({
  funde: {
    type: 'array',
    items: _obj({
      figur: _str,
      art: { type: 'string', enum: ART_ENUM },
      wert: _num,
      bezugsjahr: _num,
      unsicher: { type: 'boolean' },
      zitat: _str,
      begruendung: _str,
    }),
  },
});

export const FIGUR_ALTER_ARTEN = ART_ENUM;
