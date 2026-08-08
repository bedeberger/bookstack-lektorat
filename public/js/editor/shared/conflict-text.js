// Wortlaut eines Schreibkonflikts — geteilt von Notebook-Editor und Bucheditor.
//
// Jeder Konflikt-Text hat dieselbe Verzweigung: kam der konkurrierende Save vom
// EIGENEN Zweit-Gerät (Mac-Client, zweiter Laptop, Android), nennt der Text das
// Gerät; kam er von einem fremden ACL-User, den Namen. Ohne diese Unterscheidung
// liest ein Solo-Autor seinen eigenen Namen als „fremder Bearbeiter".
//
// Die Verzweigung stand an vier Stellen handgeschrieben (drei im Notebook, eine
// im Bucheditor) — samt der beiden Fallback-Keys, die dabei jedes Mal mitkopiert
// werden mussten. Hier ist sie einmal formuliert; die Auftritte unterscheiden
// sich nur noch im Key-Paar.
//
// Neuer Auftritt ⇒ Key-Paar hier eintragen (beide Keys in BEIDEN Locale-Dateien
// anlegen), nicht die Verzweigung erneut ausschreiben.

// Variante → [Key bei eigenem Gerät, Key bei fremdem User].
export const CONFLICT_KEYS = {
  // Notebook-Editor
  banner: ['edit.conflict.bannerSelf', 'edit.conflict.banner'],
  hint: ['edit.conflict.unsavedHintSelf', 'edit.conflict.unsavedHint'],
  modal: ['edit.conflict.messageSelf', 'edit.conflict.message'],
  // Bucheditor (pro Block statt pro Seite)
  bookHint: ['bookEditor.conflictHintSelf', 'bookEditor.conflictHint'],
  bookBanner: ['bookEditor.conflict.bannerSelf', 'bookEditor.conflict.banner'],
  bookStatus: ['bookEditor.status.conflictSelf', 'bookEditor.status.conflict'],
};

const UNKNOWN_DEVICE_KEY = 'presence.device.unknown';
const UNKNOWN_USER_KEY = 'edit.conflict.unknownUser';

/**
 * Konflikt-Text einer Variante.
 *
 * @param {(key: string, params?: object) => string} t  Übersetzer des Hosts
 * @param {object|null} conflict  Objekt aus checkPageConflict/readConflictBody
 * @param {keyof CONFLICT_KEYS} variant
 * @param {object|null} extra  zusätzliche Platzhalter (z.B. `{ time }`)
 * @returns {string}  '' wenn kein Konflikt/kein Übersetzer/unbekannte Variante
 */
export function conflictText(t, conflict, variant, extra = null) {
  if (typeof t !== 'function' || !conflict) return '';
  const pair = CONFLICT_KEYS[variant];
  if (!pair) return '';
  const [selfKey, otherKey] = pair;
  return conflict.remoteIsSelf
    ? t(selfKey, { device: conflict.remoteDevice || t(UNKNOWN_DEVICE_KEY), ...extra })
    : t(otherKey, { user: conflict.remoteUserName || t(UNKNOWN_USER_KEY), ...extra });
}
