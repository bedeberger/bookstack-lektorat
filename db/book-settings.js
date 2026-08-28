'use strict';
// Buch-Einstellungen (`book_settings`): Sprache/Region, Buchtyp + Freitext,
// Erzaehlform, Ziele, Quellen-/Querverweis-Einstellungen, Textsorte, Stilprofil.

const { db } = require('./connection');
// Prepared Statements dieses Moduls sitzen auf migrierten Spalten — die
// Migrationen muessen vor dem Anlegen gelaufen sein.
require('./migrations');


// Quellenverzeichnis-Defaults: einmal deklariert, von Row-Mapping und beiden
// Fallback-Pfaden in getBookSettings geteilt. Die Werte spiegeln die
// Spalten-Defaults aus Migration 252 — driften sie auseinander, sieht ein Buch
// ohne book_settings-Zeile andere Einstellungen als eines mit.
const CITATION_DEFAULTS = Object.freeze({
  citation_style: 'apa7',
  citation_notes: 'inline',
  bibliography_enabled: 0,
  bibliography_title: null,
  bibliography_scope: 'cited',
  bibliography_in_blog: 0,
});
const VALID_CITATION_STYLES = ['apa7', 'chicago-ad', 'numeric'];
// Deckungsgleich mit CITATION_NOTES_MODES in lib/endnotes.js — laufen die
// auseinander, faellt der Schreibpfad stumm auf 'inline' zurueck.
const VALID_CITATION_NOTES = ['inline', 'endnotes', 'footnotes'];
const VALID_BIBLIOGRAPHY_SCOPES = ['cited', 'all'];

// Querverweis-Defaults (Migration 255). Steht aus demselben Grund in
// book_settings wie der Zitierstil: ob ein Werk seine Abbildungen nummeriert,
// gilt fuer ALLE Ausgabewege gleichzeitig und darf nicht je Exportprofil
// abweichen. Default 0 — ein Roman mit Bildern will keine „Abb. 1:"-Praefixe.
const XREF_DEFAULTS = Object.freeze({
  figure_numbering: 0,
  table_numbering: 0,
});

const _getBookSettings = db.prepare('SELECT language, region, buchtyp, buch_kontext, stilprofil, erzaehlperspektive, erzaehlzeit, is_finished, allow_lektor_book_chat, daily_goal_chars, goal_target_chars, goal_deadline, entities_enabled, orte_real, schauplatz_land, zeitlinie_real, weltfakten_real_pruefen, exclude_from_stats, citation_style, bibliography_enabled, bibliography_title, bibliography_scope, bibliography_in_blog, citation_notes, figure_numbering, table_numbering, textsorte FROM book_settings WHERE book_id = ?');
const _upsertBookSettings = db.prepare(`
  INSERT INTO book_settings (book_id, language, region, buchtyp, buch_kontext, stilprofil, erzaehlperspektive, erzaehlzeit, is_finished, allow_lektor_book_chat, daily_goal_chars, goal_target_chars, goal_deadline, orte_real, schauplatz_land, zeitlinie_real, weltfakten_real_pruefen, exclude_from_stats, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(book_id) DO UPDATE SET
    language=excluded.language, region=excluded.region,
    buchtyp=excluded.buchtyp, buch_kontext=excluded.buch_kontext,
    stilprofil=excluded.stilprofil,
    erzaehlperspektive=excluded.erzaehlperspektive, erzaehlzeit=excluded.erzaehlzeit,
    is_finished=excluded.is_finished,
    allow_lektor_book_chat=excluded.allow_lektor_book_chat,
    daily_goal_chars=excluded.daily_goal_chars,
    goal_target_chars=excluded.goal_target_chars,
    goal_deadline=excluded.goal_deadline,
    orte_real=excluded.orte_real,
    schauplatz_land=excluded.schauplatz_land,
    zeitlinie_real=excluded.zeitlinie_real,
    weltfakten_real_pruefen=excluded.weltfakten_real_pruefen,
    exclude_from_stats=excluded.exclude_from_stats,
    updated_at=excluded.updated_at
`);
const _updateBookSettingsEntitiesEnabled = db.prepare(`
  INSERT INTO book_settings (book_id, entities_enabled, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(book_id) DO UPDATE SET
    entities_enabled=excluded.entities_enabled,
    updated_at=excluded.updated_at
`);
const _updateBookIsFinished = db.prepare(`
  INSERT INTO book_settings (book_id, is_finished, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(book_id) DO UPDATE SET
    is_finished=excluded.is_finished,
    updated_at=excluded.updated_at
`);
const _updateBookStilprofil = db.prepare(`
  INSERT INTO book_settings (book_id, stilprofil, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(book_id) DO UPDATE SET
    stilprofil=excluded.stilprofil,
    updated_at=excluded.updated_at
`);
// Quellenverzeichnis-Einstellungen als eigener Schreibpfad (Muster
// entities_enabled/stilprofil) statt als weitere Positionsargumente an
// saveBookSettings: der Quellen-Tab speichert unabhaengig vom Haupt-Formular,
// und die 18-stellige Positionsliste von saveBookSettings soll nicht weiter
// wachsen.
const _updateBookCitationSettings = db.prepare(`
  INSERT INTO book_settings (book_id, citation_style, bibliography_enabled, bibliography_title, bibliography_scope, bibliography_in_blog, citation_notes, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(book_id) DO UPDATE SET
    citation_style=excluded.citation_style,
    bibliography_enabled=excluded.bibliography_enabled,
    bibliography_title=excluded.bibliography_title,
    bibliography_scope=excluded.bibliography_scope,
    bibliography_in_blog=excluded.bibliography_in_blog,
    citation_notes=excluded.citation_notes,
    updated_at=excluded.updated_at
`);
// Querverweis-Einstellungen, eigener Schreibpfad aus demselben Grund.
const _updateBookXrefSettings = db.prepare(`
  INSERT INTO book_settings (book_id, figure_numbering, table_numbering, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(book_id) DO UPDATE SET
    figure_numbering=excluded.figure_numbering,
    table_numbering=excluded.table_numbering,
    updated_at=excluded.updated_at
`);

/** Gibt {language, region, buchtyp, buch_kontext, erzaehlperspektive, erzaehlzeit, is_finished, allow_lektor_book_chat, daily_goal_chars, entities_enabled} für ein Buch zurück.
 *  Fehlt die book_settings-Zeile, werden – wenn vorhanden – die User-Defaults
 *  (default_language/region/buchtyp) als Fallback verwendet. `daily_goal_chars`
 *  bleibt NULL, wenn nichts gesetzt — Frontend mappt auf 1500-Default. */
function getBookSettings(bookId, userEmail = null) {
  const row = _getBookSettings.get(parseInt(bookId));
  if (row) return {
    ...row,
    is_finished: row.is_finished ? 1 : 0,
    allow_lektor_book_chat: row.allow_lektor_book_chat ? 1 : 0,
    entities_enabled: row.entities_enabled ? 1 : 0,
    orte_real: row.orte_real ? 1 : 0,
    zeitlinie_real: row.zeitlinie_real ? 1 : 0,
    weltfakten_real_pruefen: row.weltfakten_real_pruefen ? 1 : 0,
    exclude_from_stats: row.exclude_from_stats ? 1 : 0,
    citation_style: row.citation_style || CITATION_DEFAULTS.citation_style,
    bibliography_enabled: row.bibliography_enabled ? 1 : 0,
    bibliography_title: row.bibliography_title || null,
    bibliography_scope: row.bibliography_scope || CITATION_DEFAULTS.bibliography_scope,
    bibliography_in_blog: row.bibliography_in_blog ? 1 : 0,
    citation_notes: row.citation_notes || CITATION_DEFAULTS.citation_notes,
    figure_numbering: row.figure_numbering ? 1 : 0,
    table_numbering: row.table_numbering ? 1 : 0,
    textsorte: row.textsorte || null,
  };
  if (userEmail) {
    const u = require('./app-users').getUser(userEmail);
    if (u && (u.default_language || u.default_buchtyp)) {
      const language = u.default_language || 'de';
      const region   = u.default_region   || (language === 'en' ? 'US' : 'CH');
      return { language, region, buchtyp: u.default_buchtyp || null, buch_kontext: null, stilprofil: null, erzaehlperspektive: null, erzaehlzeit: null, is_finished: 0, allow_lektor_book_chat: 0, daily_goal_chars: null, goal_target_chars: null, goal_deadline: null, entities_enabled: 0, orte_real: 0, schauplatz_land: null, zeitlinie_real: 0, weltfakten_real_pruefen: 0, exclude_from_stats: 0, textsorte: null, ...CITATION_DEFAULTS, ...XREF_DEFAULTS };
    }
  }
  return { language: 'de', region: 'CH', buchtyp: null, buch_kontext: null, stilprofil: null, erzaehlperspektive: null, erzaehlzeit: null, is_finished: 0, allow_lektor_book_chat: 0, daily_goal_chars: null, goal_target_chars: null, goal_deadline: null, entities_enabled: 0, orte_real: 0, schauplatz_land: null, zeitlinie_real: 0, weltfakten_real_pruefen: 0, exclude_from_stats: 0, textsorte: null, ...CITATION_DEFAULTS, ...XREF_DEFAULTS };
}

/** Locale-Key für ein Buch: z.B. "de-CH", "en-US". */
function getBookLocale(bookId, userEmail = null) {
  const { language, region } = getBookSettings(bookId, userEmail);
  return `${language}-${region}`;
}

/** Speichert/aktualisiert Sprache, Region, Buchtyp, Buchkontext, Erzählperspektive, Erzählzeit, is_finished, allow_lektor_book_chat, daily_goal_chars.
 *  `entities_enabled` wird hier nicht angefasst — Quick-Toggle aus der Notebook-Toolbar laeuft ueber setBookEntitiesEnabled. */
function saveBookSettings(bookId, language, region, buchtyp, buchKontext, erzaehlperspektive = null, erzaehlzeit = null, isFinished = 0, allowLektorBookChat = 0, dailyGoalChars = null, orteReal = 0, schauplatzLand = null, goalTargetChars = null, goalDeadline = null, stilprofil = null, zeitlinieReal = 0, excludeFromStats = 0, weltfaktenRealPruefen = 0) {
  _upsertBookSettings.run(
    parseInt(bookId), language, region,
    buchtyp || null, buchKontext || null,
    stilprofil || null,
    erzaehlperspektive || null, erzaehlzeit || null,
    isFinished ? 1 : 0,
    allowLektorBookChat ? 1 : 0,
    dailyGoalChars == null ? null : Math.round(Number(dailyGoalChars)),
    goalTargetChars == null ? null : Math.round(Number(goalTargetChars)),
    goalDeadline || null,
    orteReal ? 1 : 0,
    schauplatzLand || null,
    zeitlinieReal ? 1 : 0,
    weltfaktenRealPruefen ? 1 : 0,
    excludeFromStats ? 1 : 0,
    new Date().toISOString()
  );
}

/** Toggle aus Notebook-Toolbar — Quick-Update nur fuer entities_enabled,
 *  ohne andere Settings anzufassen (Toolbar-Toggle laedt Form nicht). */
function setBookEntitiesEnabled(bookId, enabled) {
  _updateBookSettingsEntitiesEnabled.run(
    parseInt(bookId),
    enabled ? 1 : 0,
    new Date().toISOString()
  );
}

/** Quellenverzeichnis-Einstellungen pro Buch (Quellen-Tab der Bucheinstellungen).
 *  Eigener Schreibpfad — beruehrt keine anderen Settings. Enum-Werte werden hier
 *  hart auf die Whitelist gezwungen, damit ein Fremdwert nie in der DB landet
 *  (der Formatter kennt nur diese Stile und wuerde sonst still auf apa7 fallen). */
// Default-Textsorte des Buchs. Eigener Setter statt eines weiteren Positions-
// arguments an saveBookSettings — dessen 18-stellige Liste soll nicht wachsen.
const _updateBookTextsorte = db.prepare(
  'UPDATE book_settings SET textsorte = ?, updated_at = ? WHERE book_id = ?',
);
function setBookTextsorte(bookId, textsorte) {
  const value = textsorte == null || textsorte === '' ? null : String(textsorte);
  // Kein UPSERT: ohne book_settings-Zeile gibt es noch keinen Buchtyp, und eine
  // Textsorte ohne Buchtyp waere eine Angabe ohne Wirkung. Das Formular legt die
  // Zeile ohnehin beim ersten Speichern an.
  _updateBookTextsorte.run(value, new Date().toISOString(), parseInt(bookId));
  return value;
}

function setBookCitationSettings(bookId, {
  citation_style, bibliography_enabled, bibliography_title, bibliography_scope, bibliography_in_blog,
  citation_notes,
} = {}) {
  const style = VALID_CITATION_STYLES.includes(citation_style)
    ? citation_style : CITATION_DEFAULTS.citation_style;
  const scope = VALID_BIBLIOGRAPHY_SCOPES.includes(bibliography_scope)
    ? bibliography_scope : CITATION_DEFAULTS.bibliography_scope;
  const title = bibliography_title ? String(bibliography_title).trim().slice(0, 200) : null;
  _updateBookCitationSettings.run(
    parseInt(bookId), style,
    bibliography_enabled ? 1 : 0,
    title || null, scope,
    bibliography_in_blog ? 1 : 0,
    VALID_CITATION_NOTES.includes(citation_notes) ? citation_notes : CITATION_DEFAULTS.citation_notes,
    new Date().toISOString(),
  );
}

/** Querverweis-Einstellungen pro Buch. Eigener Schreibpfad — beruehrt keine
 *  anderen Settings. */
function setBookXrefSettings(bookId, { figure_numbering, table_numbering } = {}) {
  _updateBookXrefSettings.run(
    parseInt(bookId),
    figure_numbering ? 1 : 0,
    table_numbering ? 1 : 0,
    new Date().toISOString(),
  );
}

/** Quick-Update nur fuer is_finished — Regal-Karte („Meine Buecher") schaltet
 *  den Fertig-Status ohne das ganze Settings-Formular. `is_finished` bleibt
 *  damit EIN Schalter: er gilt buchweit und geht in die Prompts, ein zweiter
 *  pro User wuerde diese Aussage zerteilen. */
function setBookIsFinished(bookId, isFinished) {
  _updateBookIsFinished.run(
    parseInt(bookId),
    isFinished ? 1 : 0,
    new Date().toISOString()
  );
}

/** Quick-Update nur fuer stilprofil — der Stilprofil-Extraktions-Job persistiert
 *  sein Ergebnis, ohne die uebrigen Settings (die er nicht geladen hat) zu beruehren. */
function setBookStilprofil(bookId, stilprofil) {
  _updateBookStilprofil.run(
    parseInt(bookId),
    stilprofil || null,
    new Date().toISOString()
  );
}

module.exports = {
  getBookSettings,
  getBookLocale,
  saveBookSettings,
  setBookEntitiesEnabled,
  setBookIsFinished,
  setBookStilprofil,
  setBookTextsorte,
  setBookCitationSettings,
  setBookXrefSettings,
  VALID_CITATION_STYLES,
  VALID_CITATION_NOTES,
  VALID_BIBLIOGRAPHY_SCOPES,
};
