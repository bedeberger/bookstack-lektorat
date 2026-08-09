'use strict';
// Tabellensatz-Block der PDF-Export-Profile: Defaults + Validator.
//
// Ausgelagert aus lib/pdf-export-defaults.js — die Datei lief sonst ueber das
// 600-LOC-Limit (CLAUDE.md „File-Limits / Modularitaet"). Der Block ist ein
// abgeschlossenes Thema: eigene Enums, eigener Validator, ein Konsument
// (lib/pdf-render/table.js).
//
// Der Renderer misst und bricht selbst — pdfkit bringt keine Tabelle mit. Die
// Feldnamen hier sind die PROFIL-Form; lib/pdf-render/table.js#normalizeTableConfig
// rechnet sie in seine Arbeitsform um (paddingPt → padding usw.).

const { isObj, num, enumOf, bool, hex } = require('./coerce');

const TABLE_WIDTH   = ['full', 'auto'];
const TABLE_BORDERS = ['all', 'horizontal', 'outer', 'none'];
const CAPTION_POS   = ['below', 'above'];

// `width`: 'full' spannt die Tabelle auf die Satzspiegelbreite (Word-Verhalten
//   „an Fenster anpassen"), 'auto' laesst ihr die Breite ihres Inhalts. 'full'
//   ist die Vorgabe, weil eine Tabelle im Buchsatz normalerweise mit dem
//   Textkoerper fluchtet; bei zwei kurzen Spalten will man aber 'auto'.
// `headerRepeat`: Kopfzeile nach jedem Seitenumbruch erneut setzen. Ohne das
//   steht die Fortsetzung einer langen Tabelle ohne Spaltenbeschriftung da.
// `fontScale`: Tabellen werden konventionell einen Hauch kleiner gesetzt als der
//   Fliesstext, damit mehr Spalten Platz haben.
const DEFAULT_TABLE = {
  width: 'full',
  borders: 'all',
  zebra: false,
  headerRepeat: true,
  fontScale: 0.95,
  paddingPt: 4,
  borderWidthPt: 0.5,
  borderColor: '#999999',
  zebraColor: '#f2f0ec',
  captionPosition: 'below',
};

/** Tabellenblock strikt validieren. Unbekannte Keys fallen weg, Werte werden
 *  gegen Allowlist/Range gezogen — dieselbe Zusage wie fuer die uebrigen
 *  Bloecke (lib/pdf-export-defaults.js#validateConfig). */
function validateTable(src) {
  const d = DEFAULT_TABLE;
  if (!isObj(src)) return { ...d };
  return {
    width:           enumOf(src.width, TABLE_WIDTH, d.width),
    borders:         enumOf(src.borders, TABLE_BORDERS, d.borders),
    zebra:           bool(src.zebra, d.zebra),
    headerRepeat:    bool(src.headerRepeat, d.headerRepeat),
    // Untergrenze 0.6: darunter ist der Tabellensatz kleiner als jede Fussnote
    // und im Druck nicht mehr lesbar.
    fontScale:       num(src.fontScale, 0.6, 1.2, d.fontScale),
    paddingPt:       num(src.paddingPt, 0, 20, d.paddingPt),
    borderWidthPt:   num(src.borderWidthPt, 0, 3, d.borderWidthPt),
    borderColor:     hex(src.borderColor, d.borderColor),
    zebraColor:      hex(src.zebraColor, d.zebraColor),
    captionPosition: enumOf(src.captionPosition, CAPTION_POS, d.captionPosition),
  };
}

module.exports = { DEFAULT_TABLE, validateTable, TABLE_WIDTH, TABLE_BORDERS, CAPTION_POS };
