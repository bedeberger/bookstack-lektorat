// Was ein Quellen-Chip in der LESEANSICHT ueber seine Quelle zeigt — pure
// Abbildung Chip-Attribute + Quellenliste → Anzeigemodell.
//
// Gegenstueck zum Beleg-Picker im Edit-Modus (editor/notebook/toolbar/cite.js):
// dort wird der Chip geaendert, hier nur gelesen. Konsument ist das Popover in
// cards/editor-entities-card.js.
//
// Kein DOM, kein Alpine, kein Netz — die Karte liest die Attribute (via
// cite-html.js) und die Liste (via source-cache.js) und uebergibt beides.
//
// `data-src` ist die Wahrheit, der Chip-Text nur ein Cache des Kurzbelegs (siehe
// cite-html.js). Darum baut das Popover den Voll-Eintrag frisch aus der Quelle
// statt den sichtbaren Text zu zerlegen — steht im Text noch ein veralteter
// Kurzbeleg, zeigt das Popover trotzdem den aktuellen Stand.

import { formatFullHtml, labelsFor, runsToText, locatorRuns } from './format.js';
import { primaryPersonLabel } from './fields.js';
import { CITE_MODE_DEFAULT } from './cite-html.js';

/** Externer Zeiger der Quelle: DOI hat Vorrang (stabil), sonst die URL.
 *  Nur `http(s)` — ein `javascript:`-Wert aus einem importierten BibTeX-Feld
 *  darf nie in ein href gelangen. */
export function sourceExternalUrl(src) {
  const doi = String(src?.doi || '').trim();
  if (doi) {
    return /^https?:\/\//i.test(doi)
      ? doi
      : `https://doi.org/${encodeURI(doi.replace(/^doi:\s*/i, ''))}`;
  }
  const url = String(src?.url || '').trim();
  return /^https?:\/\//i.test(url) ? url : '';
}

/**
 * Anzeigemodell des Quellen-Popovers.
 *
 * @param {object} opts
 * @param {number|null} opts.srcId   `data-src` des Chips (Zeiger auf sources.id).
 * @param {string} opts.loc          `data-loc` (Stellenangabe, „44" / „Kap. 3").
 * @param {string} opts.mode         `data-mode` ('quote' | 'paraphrase').
 * @param {Array}  opts.sources      Quellen des Buchs (source-cache.js).
 * @param {string} opts.style        Zitierstil des Buchs.
 * @param {string} opts.lang         Sprache des Buchs (nicht die UI-Locale).
 * @param {boolean} opts.loadError   Liste konnte nicht geladen werden.
 * @returns {object} `{ srcId, missing, loadError, name, entryHtml, locLabel,
 *                      paraphrase, citeCount, url }`
 *
 * `missing` heisst: der Zeiger zeigt auf eine Quelle, die in diesem Buch nicht
 * (mehr) zugeordnet ist. Das Popover geht dann nicht leer auf, sondern sagt es —
 * genau dafuer gibt es den Fall (Seite in ein anderes Buch kopiert, Quelle aus
 * dem Buch entfernt, Marker steht noch im Text).
 */
export function buildCitePopoverModel({
  srcId = null, loc = '', mode = CITE_MODE_DEFAULT, sources = [],
  style = 'apa7', lang = 'de', loadError = false,
} = {}) {
  const id = Number.isInteger(srcId) && srcId > 0 ? srcId : null;
  const src = id === null ? null : (Array.isArray(sources) ? sources : []).find(s => s?.id === id) || null;
  const labels = labelsFor(lang);
  const model = {
    srcId: id,
    missing: !loadError && !src,
    loadError: !!loadError,
    name: '',
    entryHtml: '',
    // Kein `data-loc` → kein Feld: die Stellenangabe ist optional.
    locLabel: runsToText(locatorRuns(loc, labels)),
    paraphrase: mode === 'paraphrase',
    citeCount: 0,
    url: '',
  };
  if (!src) return model;

  // Kopfzeile: Urheber, sonst der Titel. Der Voll-Eintrag darunter wiederholt
  // beides — der Kopf ist der Wiedererkennungs-Anker, nicht der Nachweis.
  model.name = primaryPersonLabel(src) || String(src.title || '').trim();
  // Escapet in runsToHtml; der einzige erzeugte Tag ist <em> (Titel-Kursive).
  model.entryHtml = formatFullHtml(src, { style, lang });
  model.citeCount = Math.max(0, parseInt(src.cite_count, 10) || 0);
  model.url = sourceExternalUrl(src);
  return model;
}
