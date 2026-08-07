// Zeitmarken eines Interview-Transkripts.
//
// BEWUSSTE KOPIE von lib/interview-transcribe.js#formatTimecode. Beide Seiten
// brauchen dieselbe Marke: der Server schreibt sie in den Volltext (damit sie
// mit in Suche und Semantik-Index geht) und in die Stellenangabe eines O-Tons,
// der Browser rendert sie an jedem Redebeitrag. Ein Import ist nicht möglich —
// CJS dort, ESM hier. Drift ist durch tests/unit/interview-transcribe.test.mjs
// gegated (beide Implementierungen gegen dieselbe Wertetabelle).

/** Sekunden als `m:ss` bzw. `h:mm:ss`. */
export function formatTimecode(seconds) {
  const t = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/** Dauer in Minuten, gerundet — für die Kopfzeile eines Transkripts. */
export function durationLabel(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return '';
  return formatTimecode(s);
}

/**
 * Anzeigename eines Sprechers: die Zuordnung des Nutzers, sonst der rohe
 * Schlüssel des Backends. Bewusst KEIN „Sprecher 1" als Ersatz — der Schlüssel
 * ist das, was das Modell gehört hat, und eine hübschere Nummer daneben würde
 * nur verdecken, dass niemand weiss, wer da spricht.
 */
export function speakerLabel(speakers, key) {
  if (!key) return '';
  return speakers?.[key]?.label || key;
}
