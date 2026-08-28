// Subtyp-Schicht der Ereignisse-Karte: Icon- und Farb-Zuordnung sowie die
// Unterscheidung Moment/Zeitraum. Reine Daten + Funktionen ohne Alpine.
// Die Karte (../ereignisse-card.js) importiert und re-exportiert sie.
//
// Die Schluessel-Whitelist ist deckungsgleich mit dem Prompt-Enum
// (public/js/prompts/komplett/schemas.js#EVENT_SUBTYP_ENUM) und der
// Server-Whitelist (db/event-subtyp.js) — gegated durch
// tests/unit/event-subtyp-drift.test.mjs, das zusaetzlich Icon-Map, CSS-Tokens
// und i18n-Keys gegen dasselbe Enum prueft.
import { validYear } from './date.js';

// Mapping Subtyp → Lucide-Sprite-Icon-ID. Unbekannte/ungueltige Subtypen fallen
// auf 'sonstiges' → more-horizontal.
export const SUBTYP_ICON = {
  geburt:            'baby',
  tod:               'skull',
  hochzeit:          'heart',
  liebe:             'heart-handshake',
  trennung:          'heart-off',
  krankheit:         'activity',
  reise:             'plane',
  umzug:             'truck',
  konflikt:          'swords',
  wendepunkt:        'git-fork',
  entdeckung:        'compass',
  verlust:           'heart-crack',
  sieg:              'trophy',
  extern_politisch:  'landmark',
  extern_wirtschaftlich: 'banknote',
  extern_natur:      'mountain',
  extern_kulturell:  'book-open',
  extern_krieg:      'bomb',
  sonstiges:         'more-horizontal',
};

export function subtypIcon(subtyp) {
  return SUBTYP_ICON[subtyp] || SUBTYP_ICON.sonstiges;
}

// Subtyp → Akzentfarbe des Band-Markers. Token-SSoT: `--card-accent-event-*`
// (public/css/tokens/colors.css), gleiche Codierung wie die Listen-Badges.
// Unbekannte Subtypen fallen auf 'sonstiges'; extern (Weltgeschehen) uebersteuert
// mit der Error-Randfarbe — analog zur Listen-Darstellung.
const _SUBTYP_KEYS = new Set(Object.keys(SUBTYP_ICON));
export function bandMarkerColor(subtyp, extern) {
  if (extern) return 'var(--color-err-border)';
  const key = _SUBTYP_KEYS.has(subtyp) ? subtyp : 'sonstiges';
  return `var(--card-accent-event-${key})`;
}

// Instantane Subtypen (Momente, kein Zeitraum): bekommen nie einen Span-Balken,
// auch wenn die Daten ein Ende-Jahr tragen (z.B. Geburt mit Ende = „Jetzt" der
// Geschichte → sonst 50-Jahre-Spanne statt Punkt). Dauer-faehige Subtypen
// (liebe, krankheit, reise, umzug, konflikt, extern_*) bleiben Spannen.
export const POINT_SUBTYPES = new Set([
  'geburt', 'tod', 'hochzeit', 'trennung',
  'wendepunkt', 'entdeckung', 'sieg', 'verlust',
]);

// Spannen-Hoehe eines Listen-Events in Jahren (0 = Punkt-Event). Geclampt, weil
// eine 300-Jahre-Spanne die Liste sonst auseinanderzieht. Konsumiert als
// CSS-Custom-Prop --span-years.
export function eventSpanYears(ev) {
  const y = validYear(ev.datum_year), ye = validYear(ev.datum_ende_year);
  if (y === null || ye === null) return 0;
  if (POINT_SUBTYPES.has(ev.subtyp || 'sonstiges')) return 0;
  const diff = ye - y;
  return diff > 0 ? Math.min(diff, 50) : 0;
}
