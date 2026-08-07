// Alpine.data('helpCard') — Hilfe & Funktionen: statischer Funktionsueberblick
// fuer den Einstieg. Buch-unabhaengig (wie Suche/Meine-Statistik), `showHelpCard`
// + `toggleHelpCard` leben im Root (generiert aus EXCLUSIVE_CARDS). Inhalt sind
// die Feature-Bloecke der Landing-Page (i18n-Keys `landing.featNTitle/Desc`) —
// SSoT, damit oeffentliche Landing und In-App-Hilfe nicht auseinanderdriften.
// Rein statisch: keine Daten, kein Lifecycle, kein State ausser der Feature-Liste.

// Wiederverwendung der Landing-Feature-Texte (de.json/en.json). Reihenfolge =
// Anzeige-Reihenfolge. Neues Landing-Feature → hier eine Zahl ergaenzen.
const HELP_FEATURES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20].map(n => ({
  titleKey: `landing.feat${n}Title`,
  descKey: `landing.feat${n}Desc`,
}));

export function registerHelpCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('helpCard', () => ({
    helpFeatures: HELP_FEATURES,
  }));
}
