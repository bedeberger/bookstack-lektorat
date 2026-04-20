'use strict';

// Menschliche Labels für die strukturierten POV/Tempus-Keys aus book_settings.
// Werden in Lektorat-, Kapitel-Review- und Buchbewertungs-Prompts verwendet.
// Keys bleiben stabil; Labels dürfen sich ändern.
const POV_LABELS = {
  ich:              '1. Person (Ich-Erzähler)',
  er_sie_personal:  '3. Person personal (ein Figuren-Fokus pro Szene, keine allwissende Instanz)',
  er_sie_auktorial: '3. Person auktorial (allwissender Erzähler, Perspektivwechsel erlaubt)',
  du:               '2. Person (Du-Erzähler)',
  wir:              '1. Person Plural (Wir-Erzähler)',
  gemischt:         'gemischte/wechselnde Perspektiven (Wechsel nur an Szenen-/Kapitelgrenzen zulässig)',
};

const TEMPUS_LABELS = {
  praeteritum: 'Präteritum (Imperfekt)',
  praesens:    'Präsens',
  gemischt:    'gemischt (Wechsel nur an Szenen-/Kapitelgrenzen oder bei Rückblenden)',
};

/** Wandelt die in book_settings abgelegten Keys in lesbare Labels um. */
function narrativeLabels(bookSettings) {
  return {
    erzaehlperspektive: POV_LABELS[bookSettings?.erzaehlperspektive] || null,
    erzaehlzeit:        TEMPUS_LABELS[bookSettings?.erzaehlzeit] || null,
    buchtyp:            bookSettings?.buchtyp || null,
  };
}

module.exports = { POV_LABELS, TEMPUS_LABELS, narrativeLabels };
