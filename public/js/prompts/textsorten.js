// Journalistische Textsorten — SSoT für alles, was an der Form eines Beitrags
// hängt.
//
// Die Textsorte ist im Journalismus keine Etikette, sondern ein Vertrag mit der
// Leserschaft: eine Nachricht beantwortet die W-Fragen im ersten Absatz und
// enthält keine Meinung; ein Kommentar besteht aus Meinung und darf sie nicht
// verstecken. Darum steuert sie hier drei Dinge:
//
//   1. das Fehlertyp-Set des Lektorats — `wertung` (Meinung im berichtenden
//      Text) fällt in den meinungsbetonten Formen ersatzlos weg, sonst meldet
//      das Lektorat einen Kommentar als durchgehend fehlerhaft.
//   2. den Struktur-Check (routes/jobs/struktur.js): `regeln` ist der
//      Soll-Katalog, gegen den der Beitrag geprüft wird.
//   3. die Anrede im Prompt (`promptLabel`).
//
// Reines Datenmodul ohne Imports — es wird sowohl vom Prompt-Bau als auch vom
// Frontend (Combobox) und über die Facade vom Server gelesen.
//
// Ein Textsorten-Key ist eine Persistenz-Konstante (`book_settings.textsorte`,
// `page_textsorte.textsorte`, `page_structure_checks.textsorte`, i18n-Key
// `textsorte.<key>`): ergänzen ja, umbenennen nein.

/**
 * `meinung: true` = meinungsbetonte Form. Dort ist die Wertung der Zweck des
 * Textes, nicht ihr Mangel.
 * `regeln` = Soll-Struktur für den Struktur-Check, als Prompt-Text.
 */
export const TEXTSORTEN = [
  {
    key: 'nachricht',
    meinung: false,
    promptLabel: 'Nachricht (Meldung)',
    regeln: [
      'Der erste Absatz (Lead) beantwortet die wichtigsten W-Fragen: Wer? Was? Wann? Wo? — und, sofern bekannt, Wie? und Warum?',
      'Aufbau nach der umgekehrten Pyramide: das Wichtigste zuerst, jeder folgende Absatz ist verzichtbarer als der vorige. Der Text muss sich von hinten kürzen lassen, ohne dass die Kernaussage fällt.',
      'Jede Tatsachenbehauptung ist zugeschrieben; die Herkunft steht spätestens im zweiten Absatz.',
      'Keine Meinung der Redaktion, keine wertenden Adjektive, keine rhetorischen Fragen.',
      'Eine Nachricht ist kurz. Hintergrund nur so weit, wie er die Meldung verständlich macht.',
    ],
  },
  {
    key: 'bericht',
    meinung: false,
    promptLabel: 'Bericht',
    regeln: [
      'Der Einstieg nennt den Anlass und den Kern des Vorgangs; die W-Fragen sind spätestens nach dem zweiten Absatz beantwortet.',
      'Der Text ordnet ein: Vorgeschichte, Zusammenhänge und Folgen stehen in eigenen Absätzen, klar getrennt von der Meldung selbst.',
      'Mehrere Perspektiven kommen vor; bei einem Vorwurf ist die betroffene Seite gehört oder ihr Schweigen ausgewiesen.',
      'Zitate und O-Töne tragen den Text mit, ersetzen aber nicht die Darstellung.',
      'Keine Meinung der Redaktion.',
    ],
  },
  {
    key: 'reportage',
    meinung: false,
    promptLabel: 'Reportage',
    regeln: [
      'Der Einstieg ist eine Szene — beobachtet, konkret, mit Ort, Zeit und Menschen, nicht eine Zusammenfassung.',
      'Szene und Hintergrund wechseln sich ab: auf beobachtete Passagen folgen einordnende, und der Text kehrt zur Szene zurück.',
      'Die Erzählperspektive ist durchgehend erkennbar: Was hat die Autorin selbst gesehen, was ist recherchiert, was ist erzählt bekommen?',
      'Menschen haben Namen, Alter und Funktion; sie sprechen in direkter Rede.',
      'Der Schluss schliesst den Bogen zum Einstieg oder setzt einen bewussten Schlusspunkt — er endet nicht mit einem Zitat, das zufällig übrig blieb.',
      'Atmosphäre ersetzt keine Information: die Kernfrage des Textes ist beantwortet.',
    ],
  },
  {
    key: 'interview',
    meinung: false,
    promptLabel: 'Interview',
    regeln: [
      'Ein Vorspann führt die befragte Person ein: Name, Funktion, Anlass des Gesprächs.',
      'Fragen sind kurz, offen und je eine Frage — keine Doppelfragen, keine Statements mit Fragezeichen.',
      'Die Fragen bleiben erkennbar Fragen der Redaktion; sie transportieren keine Meinung als vermeintliche Tatsache.',
      'Es gibt mindestens eine kritische Nachfrage; ausweichende Antworten bleiben nicht unwidersprochen stehen.',
      'Die Antworten sind zusammenhängend und in sich verständlich, ohne dass der Sinn verändert wurde.',
      'Der Wechsel Frage/Antwort ist typografisch durchgehend gleich ausgezeichnet.',
    ],
  },
  {
    key: 'portraet',
    meinung: false,
    promptLabel: 'Porträt',
    regeln: [
      'Der Einstieg zeigt die Person in einer konkreten Situation, nicht in einer Aufzählung ihrer Ämter.',
      'Der Text beantwortet, warum diese Person jetzt von Interesse ist (Anlass).',
      'Biografische Angaben sind eingebettet, nicht als Lebenslauf abgeladen.',
      'Es kommen Dritte zu Wort — Weggefährten, Gegner, Beobachter —, nicht nur die porträtierte Person.',
      'Nähe und Distanz sind ausgewiesen: Bewunderung oder Abneigung der Autorin sind als solche erkennbar oder gar nicht vorhanden.',
    ],
  },
  {
    key: 'feature',
    meinung: false,
    promptLabel: 'Feature / Hintergrundstück',
    regeln: [
      'Der Einstieg ist ein Aufhänger (Szene, Fall, Zahl), der ins Thema führt, nicht das Thema selbst.',
      'Die Leitfrage des Textes ist früh erkennbar und wird am Schluss beantwortet oder als offen ausgewiesen.',
      'Der Text ist in erkennbare Bausteine gegliedert (Fall, Befund, Einordnung, Gegenrede, Ausblick).',
      'Belege stammen aus mehreren, benannten Quellen; Zahlen tragen ihre Herkunft.',
      'Keine Meinung der Redaktion — die Einordnung bleibt referiert.',
    ],
  },
  {
    key: 'kommentar',
    meinung: true,
    promptLabel: 'Kommentar / Leitartikel',
    regeln: [
      'Die These steht früh und ist in einem Satz benennbar.',
      'Der Text ist als Meinung erkennbar und nicht als Bericht getarnt.',
      'Die Argumente sind auf Tatsachen gestützt, die der Text nennt — Meinung ersetzt keine Fakten.',
      'Der stärkste Gegeneinwand kommt vor und wird beantwortet, nicht ausgelassen.',
      'Der Schluss zieht eine Folgerung oder stellt eine Forderung; er wiederholt nicht bloss die These.',
      'Angriffe richten sich gegen Positionen und Handlungen, nicht gegen Personen.',
    ],
  },
  {
    key: 'glosse',
    meinung: true,
    promptLabel: 'Glosse',
    regeln: [
      'Es gibt einen konkreten Anlass, und er ist im Text benannt.',
      'Die Pointe trägt bis zum Schluss und kommt nicht schon im ersten Absatz.',
      'Die Ironie ist als solche erkennbar — der Text kann nicht versehentlich als Bericht gelesen werden.',
      'Der Text bleibt kurz; ein ausgewalztes Bonmot verliert seine Wirkung.',
      'Spott trifft Verhalten und Verhältnisse, nicht unbeteiligte Privatpersonen.',
    ],
  },
  {
    key: 'rezension',
    meinung: true,
    promptLabel: 'Rezension / Kritik',
    regeln: [
      'Der Gegenstand ist vollständig identifiziert (Titel, Urheber, Ort/Verlag, Datum).',
      'Der Text gibt wieder, worum es geht, ohne die Auflösung zu verraten.',
      'Das Urteil ist begründet und am Werk belegt — nicht behauptet.',
      'Die Massstäbe der Kritik sind erkennbar (Anspruch des Werks, Vergleichsrahmen).',
      'Der Schluss enthält eine klare Einschätzung, keine Ausweichformel.',
    ],
  },
];

const BY_KEY = new Map(TEXTSORTEN.map(t => [t.key, t]));

/** Alle gültigen Keys, in Anzeige-Reihenfolge. */
export const TEXTSORTE_KEYS = TEXTSORTEN.map(t => t.key);

export const DEFAULT_TEXTSORTE = 'bericht';

/** Textsorten-Objekt oder null. */
export function textsorte(key) {
  return BY_KEY.get(key) || null;
}

/** Ist die Form meinungsbetont (Kommentar, Glosse, Rezension)? Unbekannt/null
 *  → false: im Zweifel gilt die Trennung von Nachricht und Meinung. */
export function istMeinungsform(key) {
  return !!BY_KEY.get(key)?.meinung;
}

/** Anrede für den Prompt («Bericht», «Kommentar / Leitartikel»). */
export function textsorteLabel(key) {
  return BY_KEY.get(key)?.promptLabel || 'journalistischer Beitrag';
}

/** Soll-Katalog einer Textsorte als nummerierte Prompt-Liste. */
export function textsorteRegelnListe(key) {
  const t = BY_KEY.get(key);
  if (!t) return '';
  return t.regeln.map((r, i) => `${i + 1}. ${r}`).join('\n');
}

// Signatur für den Prompt-Content-Hash (public/js/prompts.js). Die Regeln
// fliessen nur über Call-Argumente in die Prompts — ohne diesen Wert bliebe
// eine Regel-Änderung im Lektorat-Cache unsichtbar.
export const TEXTSORTEN_SIGNATUR = JSON.stringify(TEXTSORTEN);
