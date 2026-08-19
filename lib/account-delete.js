'use strict';
// Konto-Selbstloeschung — und der Reset des Demo-Kontos, der an derselben Stelle
// haengt.
//
// Anlass: App-Store-Guideline 5.1.1(v) verlangt, dass ein Konto, das sich in der
// App anlegen laesst, sich in der App auch loeschen laesst — nicht bloss
// deaktivieren. Einziger Konsument: `DELETE /me/account`
// (routes/usersettings.js), aufgerufen aus dem nativen macOS-Client (per
// Device-Token) und aus dem Profil der Web-App (per Session).
//
// ── Wieso HARTER Delete der app_users-Row ────────────────────────────────────
// `appUsers.softDeleteUser()` (status='deleted' + anonymisierter Anzeigename)
// bleibt der Weg fuer den Admin-Tab: dort ist Sperren gemeint, nicht Loeschen.
// Fuer die Selbstloeschung reicht es nicht — die Inhalte muessen wirklich weg.
// Der harte Delete ist dabei nicht bloss „auch noch das": er ist der MECHANISMUS.
// Rund vierzig Tabellen tragen einen FK auf `app_users(email)` mit CASCADE
// (loescht mit) bzw. SET NULL (anonymisiert den Beitrag auf FREMDEN Buechern,
// die bestehen bleiben). Diese Kanten erledigen die Arbeit vollstaendig und
// bleiben automatisch korrekt, wenn eine Tabelle dazukommt. Von Hand
// nachgepflegte DELETE-Listen tun das nicht.
//
// Preis: die Adresse ist danach wieder registrierbar. Das ist gewollt — ein
// Loeschrecht, das die Adresse dauerhaft blockiert, loescht sie nicht.
//
// ── Keine Karenzfrist ────────────────────────────────────────────────────────
// Geloescht wird sofort; die Antwort traegt darum KEIN `scheduled_purge_at`. Eine
// Frist waere zulaessig, kostet aber einen Purge-Job, einen zweiten Zustand
// („geloescht, aber noch da") in jedem Lesepfad und eine zweite Wahrheit
// darueber, ob ein Konto existiert. Die sofortige Loeschung ist gegenueber
// 5.1.1(v) die eindeutige Variante und gegenueber dem Nutzer die ehrliche.
//
// ── Was NICHT geloescht wird, und warum ──────────────────────────────────────
//   `user_sessions_audit` — die Login-/Logout-/Rollen-Spur inklusive des
//     'self-deleted'-Events, das dieser Vorgang selbst schreibt. Sie ist der
//     Nachweis, DASS und WANN geloescht wurde (Betreiberpflicht gegenueber dem
//     Nutzer und gegenueber Apple) und die Grundlage der Missbrauchsabwehr
//     (Anlegen-Loeschen-Anlegen im Minutentakt). Ohne sie ist die Loeschung
//     nicht belegbar — der Vorgang wuerde seine eigene Spur tilgen.
//   `job_runs`, `js_errors`, `ai_cost_ledger` — Betriebsdaten (Kostenabrechnung,
//     Fehlerspur, Job-Historie). Sie BLEIBEN, aber ohne Personenbezug: die
//     FK-Kanten setzen `user_email` auf NULL, der Ledger wird hier explizit
//     genullt. Kostensummen der Instanz bleiben stimmig, die Zeile zeigt auf
//     niemanden mehr.
//   `app_settings_audit`, `user_invites.invited_by` — NOT NULL, dokumentieren
//     die Handlung eines Kontos an FREMDEN Objekten (Instanz-Konfiguration,
//     Einladung eines anderen Nutzers). Sie bekommen die Sentinel-Adresse
//     unten statt der echten.
//
// ── Fremdes Eigentum ────────────────────────────────────────────────────────
// Buecher, an denen der User nur beteiligt war (`book_access` ohne owner-Rolle),
// bleiben stehen; es faellt nur seine ACL-Zeile (FK-CASCADE). Genau so sagt es
// die Client-UI. Umgekehrt gilt es nicht: seine EIGENEN Buecher gehen samt
// Kapiteln, Seiten, Fassungen und Share-Links, auch wenn andere daran
// mitarbeiten — die Warnung im UI sagt das ausdruecklich.

const contentStore = require('./content-store');
const bookAccess = require('../db/book-access');
const appUsers = require('../db/app-users');
const deviceTokens = require('../db/device-tokens');
const { db } = require('../db/connection');
const logger = require('../logger');

// Ersatzwert fuer NOT-NULL-Spalten, die eine Handlung an einem fremden Objekt
// dokumentieren und darum stehen bleiben. `.invalid` ist per RFC 2606 nie
// vergeben — dieselbe Begruendung wie bei der example.org-Adresse des
// Demo-Fremdbuchs (lib/demo-book.js).
const DELETED_ACTOR_EMAIL = 'geloeschtes-konto@invalid';

/**
 * Jede Spalte des Schemas, die auf ein Konto zeigt — mit ihrer Behandlung.
 *
 * Diese Liste ist KEINE Doku neben dem Code, sie IST der Code: `_purgeUserRows`
 * fuehrt sie aus. Gleichzeitig ist sie die Vollstaendigkeits-Zusage, und genau
 * das prueft tests/unit/account-delete-coverage.test.js — der Test liest die
 * Spalten aus `sqlite_master` und verlangt fuer jede einen Eintrag hier. Eine
 * neue Tabelle mit `user_email` macht CI rot, bis entschieden ist, was mit ihr
 * beim Loeschen passiert. Ohne dieses Gate waere „die Inhalte sind weg" eine
 * Behauptung mit Verfallsdatum.
 *
 * Modi:
 *   fk        — FK auf app_users(email) mit CASCADE/SET NULL. Der harte Delete
 *               der app_users-Row erledigt es; hier ist NICHTS zu tun.
 *   sweep     — kein FK (oder Inhalt, der auch auf fremden Buechern faellt):
 *               Zeile wird geloescht.
 *   anonymize — Zeile bleibt, Spalte wird NULL.
 *   sentinel  — Zeile bleibt, Spalte bekommt DELETED_ACTOR_EMAIL (NOT NULL).
 *   keep      — Zeile UND Spalte bleiben. Nur mit Begruendung in `why`.
 *   books     — faellt mit der Loeschung der eigenen Buecher.
 *   store     — laeuft ueber die Content-Store-Facade (Pages-Chokepoint).
 *   account   — die app_users-Row selbst.
 *   tokens    — Device-Tokens, vorab explizit geloescht.
 */
const USER_REF_PLAN = [
  { table: 'ai_cost_ledger',            column: 'user_email',       mode: 'anonymize', why: 'Kostenabrechnung der Instanz bleibt, Personenbezug faellt.' },
  { table: 'ai_profiles',               column: 'created_by',       mode: 'fk',        why: 'SET NULL: das KI-Profil ist Instanz-Konfiguration und bleibt nutzbar, „wer angelegt hat" faellt.' },
  { table: 'api_tokens',                column: 'admin_email',      mode: 'fk' },
  { table: 'app_settings',              column: 'updated_by',       mode: 'anonymize', why: 'Instanz-Konfiguration bleibt, „wer zuletzt" ist verzichtbar.' },
  { table: 'app_settings_audit',        column: 'updated_by',       mode: 'sentinel',  why: 'NOT NULL; Aenderungshistorie der Instanz-Konfiguration ist Betriebs-Audit.' },
  { table: 'app_users',                 column: 'email',            mode: 'account' },
  { table: 'app_users',                 column: 'invited_by',       mode: 'anonymize', why: 'Zeilen ANDERER User, die dieses Konto eingeladen hat.' },
  { table: 'app_users_devices',         column: 'user_email',       mode: 'fk' },
  { table: 'book_access',               column: 'user_email',       mode: 'fk',        why: 'CASCADE nimmt auch die Beteiligung an FREMDEN Buechern.' },
  { table: 'book_access',               column: 'granted_by',       mode: 'anonymize' },
  { table: 'book_categories',           column: 'created_by',       mode: 'anonymize', why: 'Kategorie-Pool ist instanzweit und bleibt nutzbar.' },
  { table: 'book_extract_cache',        column: 'user_email',       mode: 'fk' },
  { table: 'book_order',                column: 'updated_by',       mode: 'anonymize', why: 'Sortierung fremder Buecher bleibt, „wer zuletzt" faellt.' },
  { table: 'book_presence',             column: 'user_email',       mode: 'fk' },
  { table: 'book_review_cache',         column: 'user_email',       mode: 'fk' },
  { table: 'book_reviews',              column: 'user_email',       mode: 'fk' },
  { table: 'book_share_invites',        column: 'invitee_email',    mode: 'sweep',     why: 'Offene Sharing-Angebote AN dieses Konto sind gegenstandslos.' },
  { table: 'book_share_invites',        column: 'invited_by',       mode: 'sweep',     why: 'Angenommene Einladungen stehen ohnehin in book_access.' },
  { table: 'book_snapshots',            column: 'user_email',       mode: 'anonymize', why: 'Fassungen fremder Buecher bleiben, ohne Urheber-Bezug.' },
  { table: 'book_source_links',         column: 'added_by',         mode: 'anonymize' },
  { table: 'books',                     column: 'owner_email',      mode: 'books' },
  { table: 'budget_alerts',             column: 'email',            mode: 'fk' },
  { table: 'chapter_extract_cache',     column: 'user_email',       mode: 'fk' },
  { table: 'chapter_macro_review_cache', column: 'user_email',      mode: 'fk' },
  { table: 'chapter_narrative_profile', column: 'user_email',       mode: 'fk' },
  { table: 'chapter_review_cache',      column: 'user_email',       mode: 'fk' },
  { table: 'chapter_reviews',           column: 'user_email',       mode: 'fk' },
  { table: 'chat_sessions',             column: 'user_email',       mode: 'sweep',     why: 'Kein FK; Chats sind privat, auch die auf fremden Buechern.' },
  { table: 'continuity_checks',         column: 'user_email',       mode: 'fk' },
  { table: 'continuity_issues',         column: 'user_email',       mode: 'fk' },
  { table: 'device_tokens',             column: 'user_email',       mode: 'tokens' },
  { table: 'docx_export_profile',       column: 'user_email',       mode: 'fk' },
  { table: 'draft_figures',             column: 'user_email',       mode: 'fk' },
  { table: 'figure_relations',          column: 'user_email',       mode: 'fk' },
  { table: 'figure_scenes',             column: 'user_email',       mode: 'fk' },
  { table: 'figures',                   column: 'user_email',       mode: 'fk' },
  { table: 'finetune_ai_cache',         column: 'user_email',       mode: 'fk' },
  { table: 'ideen',                     column: 'user_email',       mode: 'fk' },
  { table: 'job_checkpoints',           column: 'user_email',       mode: 'fk' },
  { table: 'job_runs',                  column: 'user_email',       mode: 'fk',        why: 'SET NULL: Job-/Kostenhistorie bleibt anonymisiert.' },
  { table: 'js_errors',                 column: 'user_email',       mode: 'fk',        why: 'SET NULL: Fehlerspur bleibt anonymisiert.' },
  { table: 'lektorat_cache',            column: 'user_email',       mode: 'fk' },
  { table: 'lektorat_time',             column: 'user_email',       mode: 'fk' },
  { table: 'locations',                 column: 'user_email',       mode: 'fk' },
  { table: 'motif_brainstorm_cache',    column: 'user_email',       mode: 'sweep' },
  { table: 'motif_brainstorm_runs',     column: 'user_email',       mode: 'sweep' },
  { table: 'motif_graph_layout',        column: 'user_email',       mode: 'sweep' },
  { table: 'motifs',                    column: 'user_email',       mode: 'sweep' },
  { table: 'name_guard_ignores',        column: 'user_email',       mode: 'sweep' },
  { table: 'narrative_report',          column: 'user_email',       mode: 'fk' },
  { table: 'page_checks',               column: 'user_email',       mode: 'fk' },
  { table: 'page_deletions',            column: 'deleted_by_email', mode: 'anonymize', why: 'Loesch-Log fremder Buecher bleibt, „wer loeschte" faellt.' },
  { table: 'page_editorial_status',     column: 'updated_by',       mode: 'anonymize', why: 'Redaktions-Stufe fremder Beitraege bleibt, „wer freigab" faellt.' },
  { table: 'page_headline',             column: 'updated_by',       mode: 'anonymize', why: 'Titel fremder Beitraege bleiben, „wer zuletzt" faellt.' },
  { table: 'page_headline_variants',    column: 'created_by',       mode: 'anonymize', why: 'Titel-Varianten fremder Beitraege bleiben, ohne Urheber-Bezug.' },
  { table: 'page_locks',                column: 'locked_by_email',  mode: 'fk' },
  { table: 'page_presence',             column: 'user_email',       mode: 'fk' },
  { table: 'page_revisions',            column: 'user_email',       mode: 'fk',        why: 'SET NULL: Revisionen fremder Buecher bleiben, ohne Autor-Bezug.' },
  { table: 'pages',                     column: 'last_editor_email', mode: 'store' },
  { table: 'pdf_export_profile',        column: 'user_email',       mode: 'fk' },
  { table: 'plot_acts',                 column: 'user_email',       mode: 'sweep' },
  { table: 'plot_beat_relations',       column: 'user_email',       mode: 'sweep' },
  { table: 'plot_beats',                column: 'user_email',       mode: 'sweep' },
  { table: 'plot_brainstorm_runs',      column: 'user_email',       mode: 'sweep' },
  { table: 'plot_consistency_runs',     column: 'user_email',       mode: 'sweep' },
  { table: 'plot_threads',              column: 'user_email',       mode: 'sweep' },
  { table: 'registration_requests',     column: 'email',            mode: 'sweep',     why: 'Eigener Registrierungsantrag samt IP/User-Agent.' },
  { table: 'registration_requests',     column: 'reviewed_by',      mode: 'anonymize', why: 'Antraege ANDERER, die dieses Konto geprueft hat.' },
  { table: 'research_items',            column: 'user_email',       mode: 'sweep' },
  { table: 'share_comments',            column: 'author_email',     mode: 'fk' },
  { table: 'share_comments',            column: 'reader_email',     mode: 'anonymize', why: 'Textkopie der Leser-Adresse neben dem FK; Kommentar bleibt.' },
  { table: 'share_links',               column: 'owner_email',      mode: 'fk' },
  { table: 'songs',                     column: 'user_email',       mode: 'fk' },
  { table: 'source_detect_runs',        column: 'user_email',       mode: 'sweep' },
  { table: 'source_semantic_chunks',    column: 'owner_email',      mode: 'sweep' },
  { table: 'sources',                   column: 'owner_email',      mode: 'sweep',     why: 'Persoenliche Literaturbibliothek, nicht buchgebunden.' },
  { table: 'stt_time',                  column: 'user_email',       mode: 'fk' },
  { table: 'synonym_cache',             column: 'user_email',       mode: 'fk' },
  { table: 'tagebuch_rueckblick_cache', column: 'user_email',       mode: 'sweep' },
  { table: 'tagebuch_rueckblicke',      column: 'user_email',       mode: 'sweep' },
  { table: 'themes',                    column: 'user_email',       mode: 'sweep' },
  { table: 'user_activity',             column: 'user_email',       mode: 'fk' },
  { table: 'user_dictionary',           column: 'user_email',       mode: 'fk' },
  { table: 'user_feature_usage',        column: 'user_email',       mode: 'fk' },
  { table: 'user_invites',              column: 'email',            mode: 'sweep',     why: 'Einladung AN dieses Konto.' },
  { table: 'user_invites',              column: 'invited_by',       mode: 'sentinel',  why: 'NOT NULL; dokumentiert das Onboarding eines ANDEREN Nutzers.' },
  { table: 'user_page_usage',           column: 'user_email',       mode: 'fk' },
  { table: 'user_sessions_audit',       column: 'user_email',       mode: 'keep',      why: 'Nachweis der Loeschung + Missbrauchsabwehr (siehe Kopfkommentar).' },
  { table: 'werkstatt_runs',            column: 'user_email',       mode: 'fk' },
  { table: 'world_facts',               column: 'user_email',       mode: 'sweep' },
  { table: 'writing_hour',              column: 'user_email',       mode: 'fk' },
  { table: 'writing_session',           column: 'user_email',       mode: 'fk' },
  { table: 'writing_time',              column: 'user_email',       mode: 'fk' },
  { table: 'zeitstrahl_events',         column: 'user_email',       mode: 'fk' },
];

function _norm(email) {
  return String(email || '').trim().toLowerCase();
}

/**
 * Eigene Buecher (`role='owner'`), aus BEIDEN Quellen vereinigt: der ACL-Zeile
 * in `book_access` und `books.owner_email` (via Facade — Content-Store-Regel).
 * Normalerweise sind die deckungsgleich; ein Buch, das nur in einer der beiden
 * als eigenes gilt, wuerde bei einer Einzelquelle uebersehen und mit dem
 * Manuskript stehen bleiben. Beim Loeschen ist die Vereinigung die richtige
 * Richtung.
 */
async function _ownedBookIds(email) {
  const e = _norm(email);
  const ids = new Set(
    bookAccess.listBookIdsForUser(e).filter(r => r.role === 'owner').map(r => r.book_id)
  );
  const ctx = { session: { user: { email: e } } };
  for (const b of await contentStore.listBooks(ctx)) {
    if (b && _norm(b.owner_email) === e) ids.add(b.id);
  }
  return [...ids];
}

/**
 * Fuehrt alle Nicht-FK-Eintraege des Plans aus (sweep/anonymize/sentinel).
 * Eine Transaktion: entweder ist der Personenbezug ueberall weg oder nirgends.
 */
function _purgeUserRows(email) {
  const e = _norm(email);
  const stats = { deleted: 0, anonymized: 0 };
  db.transaction(() => {
    for (const entry of USER_REF_PLAN) {
      const { table, column, mode } = entry;
      if (mode === 'sweep') {
        stats.deleted += db.prepare(
          `DELETE FROM ${table} WHERE ${column} = ? COLLATE NOCASE`
        ).run(e).changes;
      } else if (mode === 'anonymize') {
        stats.anonymized += db.prepare(
          `UPDATE ${table} SET ${column} = NULL WHERE ${column} = ? COLLATE NOCASE`
        ).run(e).changes;
      } else if (mode === 'sentinel') {
        stats.anonymized += db.prepare(
          `UPDATE ${table} SET ${column} = ? WHERE ${column} = ? COLLATE NOCASE`
        ).run(DELETED_ACTOR_EMAIL, e).changes;
      }
    }
  })();
  return stats;
}

/** Eigene Buecher loeschen — ueber die Facade, damit FTS-Index und Cite-/Xref-
 *  Hooks denselben Weg nehmen wie beim Loeschen aus der Buch-Karte. */
async function _deleteOwnedBooks(email) {
  const ids = await _ownedBookIds(email);
  const ctx = { session: { user: { email: _norm(email) } } };
  let deleted = 0;
  for (const id of ids) {
    try {
      await contentStore.deleteBook(id, ctx);
      deleted += 1;
    } catch (err) {
      // Weitermachen statt abbrechen: ein Buch, das schon weg ist (oder dessen
      // Loeschung scheitert), darf nicht dazu fuehren, dass die uebrigen
      // Buecher und der Rest des Kontos stehen bleiben. Der Fehler steht im Log.
      logger.error(`Konto-Loeschung: Buch ${id} konnte nicht geloescht werden: ${err.message}`, { user: email });
    }
  }
  return { requested: ids.length, deleted };
}

/**
 * Loescht das Konto samt Inhalten.
 *
 * Reihenfolge ist Absicht:
 *   1. Device-Tokens — kappt den Zugang der nativen Clients zuerst; ein
 *      laufender Client soll nicht in die halb abgeraeumte Ablage schreiben.
 *   2. Eigene Buecher (Facade) — Kapitel/Seiten/Fassungen/Share-Links/Analysen
 *      fallen ueber die books-FK-Kaskade mit.
 *   3. Seiten-Snapshot fremder Buecher anonymisieren (Content-Store).
 *   4. Nicht-FK-Zeilen (eine Transaktion, siehe USER_REF_PLAN).
 *   5. app_users-Row hart loeschen → CASCADE/SET NULL fuer alles mit FK.
 *   6. Audit-Event.
 *
 * NICHT eine einzige Transaktion: Schritt 2 laeuft asynchron ueber die Facade,
 * und better-sqlite3-Transaktionen sind synchron. Ein Abbruch dazwischen laesst
 * darum ein teilweise geloeschtes Konto zurueck — ein zweiter Aufruf raeumt den
 * Rest ab (jeder Schritt ist idempotent), und Schritt 1 stellt sicher, dass
 * dieser Zustand keinen weiteren Schreibzugang hat.
 */
async function deleteAccount(email, { ip = null, userAgent = null } = {}) {
  const e = _norm(email);
  if (!e) throw new Error('deleteAccount: email required');

  const tokens = deviceTokens.deleteAllDeviceTokens(e);
  const books = await _deleteOwnedBooks(e);
  const pages = contentStore.anonymizeUser(e);
  const rows = _purgeUserRows(e);
  const account = db.prepare('DELETE FROM app_users WHERE email = ? COLLATE NOCASE').run(e).changes;

  // Nach dem harten Delete: `user_sessions_audit` traegt keinen FK und ueberlebt
  // die Kaskade — genau deshalb ist der Eintrag hier ueberhaupt haltbar.
  appUsers.recordAuditEvent(e, 'self-deleted', {
    ip,
    userAgent,
    meta: { books: books.deleted, tokens, rows_deleted: rows.deleted, rows_anonymized: rows.anonymized },
  });

  const summary = { books: books.deleted, booksRequested: books.requested, tokens, pages: pages.pages, ...rows, account };
  logger.info(
    `Konto geloescht (self): ${books.deleted}/${books.requested} Buecher, ${tokens} Tokens, `
    + `${rows.deleted} Zeilen entfernt, ${rows.anonymized} anonymisiert, app_users=${account}`,
    { user: e },
  );
  return summary;
}

/**
 * Demo-Konto: Inhalte weg, Konto bleibt.
 *
 * Warum das Demo-Konto nicht wirklich geloescht wird: es ist EIN geteilter
 * Zugang, dessen Zugangsdaten in den Reviewer-Notes von drei Stores stehen. Eine
 * echte Loeschung durch den ersten Pruefer nimmt allen folgenden die App weg,
 * und die fixen Device-Tokens (lib/demo-user.js) laufen bis zum naechsten
 * Serverstart ins Leere.
 *
 * Warum trotzdem nicht einfach 403: der Pruefer muss den Loeschweg VORFUEHREN
 * koennen. Ein abgelehnter Knopf ist bei 5.1.1(v) genau das, was zur Ablehnung
 * fuehrt. Also faehrt dieses Konto denselben Ablauf mit demselben Ergebnis
 * („alles weg") und wird anschliessend neu bestueckt — der Pruefer sieht die
 * leere App und danach wieder eine benutzbare.
 *
 * Tokens werden bewusst NICHT widerrufen: sie sind die einzige Anmeldung der
 * nativen Clients und stehen in den Notes. Der grobe Sicherheitsnetz-Reset
 * bleibt der Golden-Snapshot-Timer (deploy/demo-reset.sh).
 */
async function resetDemoAccount(email, { ip = null, userAgent = null } = {}) {
  const e = _norm(email);
  if (!e) throw new Error('resetDemoAccount: email required');

  const books = await _deleteOwnedBooks(e);
  contentStore.anonymizeUser(e);
  const rows = _purgeUserRows(e);

  // Neu bestuecken (Beispielbuch + Fremdbuch mit viewer-Recht). Non-fatal wie im
  // Login-Pfad: ein Reset, der geloescht aber nicht neu gesaet hat, ist immer
  // noch ein erfolgreicher Reset.
  let seeded = null;
  try {
    seeded = await require('./demo-user').seedDemoContent(e);
  } catch (err) {
    logger.warn(`Demo-Reset: Neu-Seed fehlgeschlagen: ${err.message}`, { user: e });
  }

  appUsers.recordAuditEvent(e, 'demo-reset', {
    ip,
    userAgent,
    meta: { books: books.deleted, rows_deleted: rows.deleted, reseeded: !!seeded },
  });
  logger.info(
    `Demo-Konto zurueckgesetzt: ${books.deleted} Buecher entfernt, ${rows.deleted} Zeilen entfernt, `
    + `Neu-Seed ${seeded ? 'ok' : 'fehlgeschlagen'}`,
    { user: e },
  );
  return { demoReset: true, books: books.deleted, ...rows, reseeded: !!seeded };
}

module.exports = {
  deleteAccount,
  resetDemoAccount,
  USER_REF_PLAN,
  DELETED_ACTOR_EMAIL,
};
