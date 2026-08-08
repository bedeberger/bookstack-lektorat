// Titel-Werkstatt: die vier Felder und ihre Zeichenlimits pro Ausspielkanal.
//
// WARUM LIMITS UND NICHT VALIDIERUNG: ein zu langer Titel ist kein Fehler,
// sondern ein noch nicht fertiger Titel. Die Werkstatt zeigt darum an, in welche
// Kanäle eine Formulierung passt und in welche nicht — sie verhindert nichts und
// kürzt nichts. Der Server kennt diese Limits deshalb gar nicht: er speichert,
// was der Autor schreibt. Es gibt bewusst KEINEN CJS-Spiegel dieser Datei.
//
// Die Zahlen sind Erfahrungswerte der jeweiligen Ausspielung, keine Norm:
//   print  — Spaltenbreite im Blatt; Dachzeile und Titel müssen einzeilig setzen.
//   web    — Titelzeile im Artikelkopf und in Teaser-Kacheln.
//   seo    — Google schneidet den Titel bei ~60 und die Description bei ~155
//            Zeichen ab; darüber steht die Fortsetzung nirgends.
//   social — Vorschaukarte (Open Graph), die den Rest mit Auslassung kappt.
// Ein Feld, das in einem Kanal nicht vorkommt (eine Dachzeile hat in der
// SERP-Vorschau keinen Platz), fehlt dort schlicht — kein Limit heisst „gilt
// nicht", nicht „unbegrenzt".

/** Reihenfolge = Anzeige-Reihenfolge in der Karte. Die Feld-Keys sind zugleich
 *  die Spaltennamen in `page_headline` und die erlaubten Werte von
 *  `page_headline_variants.feld` (CHECK-Constraint, Migration 269). */
export const HEADLINE_FIELDS = ['dachzeile', 'titel', 'lead', 'teaser'];

/** Felder, die als mehrzeiliger Fliesstext eingegeben werden (Textarea statt
 *  Input). Reine Darstellungsfrage, deshalb hier und nicht im Schema. */
export const HEADLINE_LONG_FIELDS = ['lead', 'teaser'];

/**
 * Die Felder, die AM BEITRAG stehen — im Editor-Kopf, im Share-Reader und in
 * jedem Export. Der Teaser fehlt hier mit Absicht: er ist der Anreisser für
 * Übersichten und Vorschaukarten, nicht Teil des Artikels; im Beitrag selbst
 * wäre er die Wiederholung des Leads mit anderen Worten. Er verlässt die App
 * nur als WordPress-`excerpt` und wird darum ausschliesslich in der
 * Titel-Werkstatt gepflegt.
 *
 * Serverseitiges Gegenstück: lib/headline-render.js.
 */
export const HEADLINE_HEAD_FIELDS = ['dachzeile', 'titel', 'lead'];

export const HEADLINE_CHANNELS = [
  { key: 'print',  limits: { dachzeile: 32, titel: 48, lead: 280, teaser: 180 } },
  { key: 'web',    limits: { dachzeile: 40, titel: 70, lead: 400, teaser: 220 } },
  { key: 'seo',    limits: { titel: 60, teaser: 155 } },
  { key: 'social', limits: { titel: 90, teaser: 200 } },
];

/** Kanäle, für die dieses Feld überhaupt ein Limit hat. */
export function channelsForField(feld) {
  return HEADLINE_CHANNELS.filter(c => typeof c.limits[feld] === 'number');
}

/** Das strengste Limit eines Feldes über alle Kanäle (oder null). Treibt die
 *  Fortschrittsanzeige am Zeichenzähler: gemessen wird gegen den engsten Kanal,
 *  weil der zuerst reisst. */
export function tightestLimit(feld) {
  const nums = channelsForField(feld).map(c => c.limits[feld]);
  return nums.length ? Math.min(...nums) : null;
}

/**
 * Passt `text` in `feld` für jeden Kanal? Liefert je Kanal `{ key, limit, len,
 * fits, over }`. `over` ist die Zahl der Zeichen zu viel (0, wenn es passt) —
 * „13 zu viel" ist die Angabe, mit der man kürzt; „passt nicht" ist es nicht.
 */
export function channelFit(feld, text) {
  const len = String(text ?? '').trim().length;
  return channelsForField(feld).map(c => {
    const limit = c.limits[feld];
    return { key: c.key, limit, len, fits: len <= limit, over: Math.max(0, len - limit) };
  });
}

/** Getrimmte Zeichenzahl — die Zahl, gegen die alle Limits gemessen werden.
 *  Umschliessende Leerzeichen zaehlen nirgends mit: sie sind ein Tippartefakt,
 *  kein Titel. */
export function fieldLen(text) {
  return String(text ?? '').trim().length;
}

/**
 * Füllstand in Prozent gegen den ENGSTEN Kanal — der reisst zuerst, und an ihm
 * misst man beim Schreiben. Über 100% wird gekappt, damit der Balken nicht
 * ausläuft; dass es zu lang ist, sagt ohnehin die Zahl daneben.
 */
export function fillPct(feld, text) {
  const limit = tightestLimit(feld);
  if (!limit) return 0;
  return Math.min(100, Math.round((fieldLen(text) / limit) * 100));
}

/**
 * `'leer' | 'passt' | 'teilweise' | 'zulang'` — treibt die Farbe von Zähler und
 * Balken. Beide Oberflächen (Titel-Werkstatt und der Kopf im Notebook-Editor)
 * zeigen dasselbe Signal; die Stufen leben deshalb hier und nicht zweimal in
 * den Karten.
 */
export function fitState(feld, text) {
  const fits = channelFit(feld, text);
  if (!fits.length || !fieldLen(text)) return 'leer';
  const ok = fits.filter(f => f.fits).length;
  if (ok === fits.length) return 'passt';
  return ok > 0 ? 'teilweise' : 'zulang';
}

/** Nur die Kanäle, in die es NICHT mehr passt. */
export function overChannels(feld, text) {
  return channelFit(feld, text).filter(f => !f.fits);
}

/** i18n-Key eines Feld-Labels bzw. eines Kanal-Labels. */
export function fieldLabelKey(feld) { return `headline.field.${feld}`; }
export function channelLabelKey(key) { return `headline.channel.${key}`; }
