'use strict';
// TTL-basierter Cleanup für Cache-Tabellen + Job-/Stats-Historie.
// Hält die DB schlank, beschleunigt Sequential-Scans, reduziert Backup-Grösse.
//
// Per-Tabelle: Timestamp-Spalte (Cache-Tabellen tragen historisch unterschiedliche
// Spaltennamen — `cached_at`, `checked_at`, `recorded_at`, `queued_at`, `fetched_at`)
// + TTL in Tagen + optionaler WHERE-Filter (z.B. nur abgeschlossene Job-Runs).
//
// Stale-Detection: cleanup-Hit-Rate auf alte Rows ist nach 30/60/90 Tagen praktisch
// null — PROMPTS_VERSION-Bumps und pages_sig-Mismatches sortieren stale Rows
// lautlos via Cache-Miss aus, alte Rows bleiben aber liegen. TTL ist die einfachste
// Garbage-Collection.
//
// Trigger: täglicher Cron (server.js, 23:00-Tick) + manuelles Script
// `npm run cache:cleanup [-- --vacuum]`.

const { db } = require('../db/connection');
const logger = require('../logger');
// app-settings + page-revisions werden lazy importiert (siehe
// _prunePerPageLimit). Eager-Import zwingt sonst test-setups, die mit
// minimal-Schema gegen db/connection arbeiten, durch die volle
// Migrationspipeline — die das Test-Schema nicht hat.

// Plan-Referenz: docs/bookstack-exit.md#phase-0d.
// `tsColumn` matched die historische Spalten-Namensgebung der jeweiligen Tabelle.
// `tsKind`: 'iso' → datetime('now', '-N days'); 'epoch' → strftime('%s','now')-N*86400.
const POLICIES = [
  { table: 'chapter_extract_cache',      tsColumn: 'cached_at',   tsKind: 'iso',   ttlDays: 90 },
  { table: 'book_extract_cache',         tsColumn: 'cached_at',   tsKind: 'iso',   ttlDays: 90 },
  { table: 'chapter_review_cache',       tsColumn: 'cached_at',   tsKind: 'iso',   ttlDays: 90 },
  { table: 'book_review_cache',          tsColumn: 'cached_at',   tsKind: 'iso',   ttlDays: 90 },
  { table: 'chapter_macro_review_cache', tsColumn: 'cached_at',   tsKind: 'iso',   ttlDays: 90 },
  { table: 'synonym_cache',              tsColumn: 'cached_at',   tsKind: 'iso',   ttlDays: 90 },
  { table: 'lektorat_cache',             tsColumn: 'cached_at',   tsKind: 'iso',   ttlDays: 60 },
  { table: 'finetune_ai_cache',          tsColumn: 'cached_at',   tsKind: 'iso',   ttlDays: 60 },
  { table: 'page_languagetool_cache',    tsColumn: 'created_at',  tsKind: 'iso',   ttlDays: 30 },
  { table: 'font_cache',                 tsColumn: 'fetched_at',  tsKind: 'epoch', ttlDays: 90 },
  // Diagramm-Renderings (Mermaid). `last_used_at`, nicht `created_at`: ein
  // Diagramm, das seit Jahren im Manuskript steht, wird bei jedem Export neu
  // getroffen und soll nicht verfallen. Rein rekonstruierbar — ein zu frueh
  // geloeschter Eintrag kostet einen Render-Lauf, keine Daten.
  { table: 'mermaid_cache',              tsColumn: 'last_used_at', tsKind: 'iso',  ttlDays: 90 },
  { table: 'job_runs',                   tsColumn: 'queued_at',   tsKind: 'iso',   ttlDays: 30,
    where: "status IN ('done','error','cancelled')" },
  // page_checks (Lektorate pro Seite) werden bewusst NICHT geprunt — sie sind die
  // Lektorat-History und sollen dauerhaft erhalten bleiben.
  { table: 'book_stats_history',         tsColumn: 'recorded_at', tsKind: 'iso',   ttlDays: 365 },
  // page_revisions: tiered GFS-Retention (siehe db/page-revisions.js#pruneTiered).
  // `setting` haelt den Floor (jueng­ste N pro Seite immer behalten) zur Laufzeit
  // aus app_settings — Admin kann ohne Code-Change adjusten. Bucket-Schema
  // selbst ist hardcoded. Behandelt im runCacheCleanup-Branch unten.
  { table: 'page_revisions', kind: 'tiered', setting: 'app.page_revision_limit' },
];

function _tableExists(table) {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name = ?"
  ).get(table);
  return !!row;
}

function _deleteOlderThan(policy) {
  const { table, tsColumn, tsKind, ttlDays, where } = policy;
  const cutoffExpr = tsKind === 'epoch'
    ? `strftime('%s','now') - ${ttlDays * 86400}`
    : `datetime('now', '-${ttlDays} days')`;
  const whereClause = where ? ` AND (${where})` : '';
  const sql = `DELETE FROM ${table} WHERE ${tsColumn} < ${cutoffExpr}${whereClause}`;
  return db.prepare(sql).run().changes;
}

function _pruneTiered(policy, now) {
  const appSettings = require('./app-settings');
  const pageRevisions = require('../db/page-revisions');
  const floor = parseInt(appSettings.get(policy.setting), 10);
  if (!Number.isInteger(floor) || floor <= 0) {
    throw new Error(`tiered: ${policy.setting} muss positiver Int sein (got ${floor})`);
  }
  return pageRevisions.pruneTiered(now ? { floor, now } : { floor });
}

function runCacheCleanup({ vacuum = false, now = null } = {}) {
  const summary = { tables: [], totalRemoved: 0, vacuumed: false };
  for (const policy of POLICIES) {
    if (!_tableExists(policy.table)) {
      summary.tables.push({ table: policy.table, removed: 0, skipped: 'table-missing' });
      continue;
    }
    try {
      const removed = policy.kind === 'tiered'
        ? _pruneTiered(policy, now)
        : _deleteOlderThan(policy);
      summary.totalRemoved += removed;
      summary.tables.push({
        table: policy.table,
        removed,
        ...(policy.kind === 'tiered'
          ? { kind: 'tiered', setting: policy.setting }
          : { ttlDays: policy.ttlDays }),
      });
      if (removed > 0) {
        const meta = policy.kind === 'tiered'
          ? `setting=${policy.setting}`
          : `ttlDays=${policy.ttlDays}`;
        logger.info(`[cache-cleanup] table=${policy.table} removed=${removed} ${meta}`);
      }
    } catch (err) {
      logger.error(`[cache-cleanup] table=${policy.table} Fehler: ${err.message}`);
      summary.tables.push({ table: policy.table, removed: 0, error: err.message });
    }
  }
  if (vacuum) {
    try {
      db.prepare('VACUUM').run();
      summary.vacuumed = true;
      logger.info('[cache-cleanup] VACUUM abgeschlossen.');
    } catch (err) {
      logger.error(`[cache-cleanup] VACUUM Fehler: ${err.message}`);
    }
  }
  return summary;
}

module.exports = { runCacheCleanup, POLICIES };
