// SSoT der Figurentyp-Taxonomie im Frontend.
//
// DIE REIHENFOLGE IST DIE AUSSAGE: sie ordnet jede Figurenliste der App
// (Katalog, Alterstabelle, Praesenz-Heatmap, Lebenslauf-Spalten) und die
// Tier-Baender des Figurengraphen — vom Traeger der Handlung bis zur Randnotiz.
//
// WHY als eigenes Modul: dieselbe Liste stand als wortgleiches TYP_ORDER-Objekt
// in vier Modulen und zusaetzlich als Array in graph/layout.js. Ein siebter Typ
// waere damit eine Aenderung an fuenf Stellen gewesen, und eine vergessene
// Stelle sortiert still falsch, statt zu brechen.
//
// NICHT hier: Farben (Canvas-Paletten in graph/constants.js, CSS-Modifier in
// entities/figuren.css) und Beschriftungen (i18n `figuren.type.<key>`).
//
// Ein Typ-Key ist eine Persistenz-Konstante (`figures.typ`, i18n-Keys,
// CSS-Modifier, Prompt-Enum in prompts/komplett/): ergaenzen ja, umbenennen
// nein — sonst verlieren bestehende Figuren ihr Label und ihre Farbe.

export const FIGUR_TYPEN = ['hauptfigur', 'antagonist', 'mentor', 'nebenfigur', 'randfigur', 'andere'];

// Prueft, was aus der KI-Antwort kommt. Unbekanntes wird auf 'andere'
// normalisiert statt verworfen — eine Figur mit ueberraschendem Typ soll
// sichtbar bleiben.
export const VALID_FIGUR_TYPEN = new Set(FIGUR_TYPEN);

const RANK = Object.fromEntries(FIGUR_TYPEN.map((t, i) => [t, i]));

/** Sortierrang eines Typs; Unbekanntes hinten (nicht raus). */
export const typRank = (typ) => RANK[typ] ?? FIGUR_TYPEN.length;

/** Der Vergleich, den die Listen ohne eigene Zweitachse teilen: Typ-Tier,
 *  danach Name in deutscher Kollation. */
export const byTypDannName = (a, b) =>
  (typRank(a?.typ) - typRank(b?.typ)) || (a?.name ?? '').localeCompare(b?.name ?? '', 'de');
