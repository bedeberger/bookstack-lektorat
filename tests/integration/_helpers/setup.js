'use strict';
// Test bootstrap. Order matters: env -> mocks -> require pipeline modules.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Wegwerf-DB moeglichst auf ein RAM-Dateisystem legen. Auf CI-Runnern mit
// Netz-Storage (Ceph-RBD) kostet jede SQLite-Datei sonst Netz-Latenz pro
// Write — bei parallel laufenden Test-Files summiert sich das zu Sekunden.
// TEST_TMPDIR erlaubt ein explizites Override.
function _tmpBase() {
  if (process.env.TEST_TMPDIR) return process.env.TEST_TMPDIR;
  try {
    fs.accessSync('/dev/shm', fs.constants.W_OK);
    return '/dev/shm';
  } catch (_) {
    return os.tmpdir();
  }
}

function bootstrap() {
  const dbFile = path.join(_tmpBase(), `lektorat-test-${process.pid}-${Date.now()}.db`);
  process.env.DB_PATH = dbFile;
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

  // ENV fuer migrierte Keys ist tot. Migrationen laufen, dann
  // app_settings-Overrides fuer Test-Budget direkt in die DB — bevor lib/ai
  // (via mock-ai) seine Context-/Token-Defaults aus app_settings liest.
  require('../../../db/connection');
  require('../../../db/migrations');
  const { db } = require('../../../db/connection');
  const upsert = db.prepare(`
    INSERT INTO app_settings (key, value_json, encrypted, updated_at, updated_by)
    VALUES (?, ?, 0, datetime('now'), 'test')
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
  `);
  // Tight token budget so multi-pass kicks in at ~20K chars instead of 600K.
  upsert.run('ai.claude.context_window', JSON.stringify(10000));
  upsert.run('ai.claude.max_tokens_out', JSON.stringify(2000));
  upsert.run('ai.provider', JSON.stringify('claude'));
  upsert.run('jobs.max_concurrent', JSON.stringify(1));
  // Claude-Split abschalten: ein kombinierter Lektorat-Call pro Seite statt
  // K Objektiv-Läufe + 1 Stil-Lauf. Die Konsolidierung des Splits ist separat
  // unit-getestet (tests/unit/lektorat-consolidate.test.mjs); die Integration-
  // Tests prüfen Cache-HIT/MISS und Pipeline, nicht die Fan-out-Anzahl.
  upsert.run('ai.lektorat_split', JSON.stringify(false));

  // app_users-Rows fuer Test-Identitaeten — Backfill/Backend-Migrate-Job
  // schreiben in book_access (FK auf app_users.email). Ohne Seed bricht
  // jeder Job mit "FOREIGN KEY constraint failed".
  const insUser = db.prepare(`
    INSERT OR IGNORE INTO app_users (email, display_name, global_role, status, language, can_invite_users, first_seen_at, created_at)
    VALUES (?, ?, 'user', 'active', 'de', 1, datetime('now'), datetime('now'))
  `);
  for (const email of [
    'alice@example.com', 'bob@example.com', 'admin@example.com', 'test@example.com',
    'tester@test.dev', 'autor@test.dev', 'owner@test.dev', 'eindringling@test.dev',
    'mitarbeit@test.dev',
    'autor@werk.dev', 'me@werk.dev', 'other@werk.dev',
  ]) {
    insUser.run(email, email.split('@')[0]);
  }

  const mockAi = require('./mock-ai');
  const dbSeed = require('./db-seed');
  mockAi.install();

  // Now safe to require pipeline modules — they'll pick up the mocked deps.
  const komplett = require('../../../routes/jobs/komplett');
  const review = require('../../../routes/jobs/review');
  const kapitel = require('../../../routes/jobs/kapitel');
  const rueckblick = require('../../../routes/jobs/rueckblick');
  const lektorat = require('../../../routes/jobs/lektorat');
  const synonyme = require('../../../routes/jobs/synonyme');
  const sourceDetect = require('../../../routes/jobs/source-detect');
  const shared = require('../../../routes/jobs/shared');
  const dbSchema = require('../../../db/schema');

  // Warm-up: Module, die sonst erst *waehrend* des ersten Jobs lazy geladen
  // werden (lib/notify zieht die komplette nodemailer-Kette, ~140 Files), hier
  // im before-Hook cold-requiren. `require` ist synchrones FS-I/O und blockiert
  // den Event-Loop — passiert das im Test, frisst es dessen waitForJob-Budget,
  // obwohl der Job selbst nichts dafuer kann. Prompts-ESM-Graph parallel
  // anstossen (Promise ist in prompts-loader gecacht).
  require('../../../lib/notify');
  require('../../../lib/budget');
  require('../../../lib/prompts-loader').getPrompts().catch(() => {});

  function cleanup() {
    try { fs.unlinkSync(dbFile); } catch (_) {}
    try { fs.unlinkSync(`${dbFile}-wal`); } catch (_) {}
    try { fs.unlinkSync(`${dbFile}-shm`); } catch (_) {}
  }

  return { mockAi, dbSeed, komplett, review, kapitel, rueckblick, lektorat, synonyme, sourceDetect, shared, dbSchema, dbFile, cleanup };
}

const POLL_MS = 10;
// Timer-Jitter unter Last ist normal; erst darueber gilt der Tick als Stall.
const STALL_THRESHOLD_MS = 200;

// Das Budget zaehlt *nicht* Wandzeit, sondern Zeit, in der der Event-Loop
// verfuegbar war. Stand die Loop (synchrone Cold-Requires, ueberbuchter
// CI-Runner, Swap), konnte der Job in dieser Zeit ohnehin nicht laufen — sie
// als Timeout zu werten produziert genau die Flakes, die dieser Helper
// verhindern soll. Ein echt haengender Job blockiert die Loop nicht: seine
// Timer feuern puenktlich, das Budget laeuft normal ab.
// Absolute Wandzeit-Obergrenze als Backstop, damit ein dauerhaft ausgehungerter
// Runner nicht endlos wartet.
async function waitForJob(shared, jobId, { timeoutMs = 5000 } = {}) {
  const start = Date.now();
  const hardCapMs = Math.max(60_000, timeoutMs * 20);
  let budgetMs = timeoutMs;
  let stalledMs = 0;
  let last = start;

  for (;;) {
    const job = shared.jobs.get(jobId);
    if (job && (job.status === 'done' || job.status === 'error' || job.status === 'cancelled')) return job;

    const wallMs = Date.now() - start;
    if (budgetMs <= 0 || wallMs >= hardCapMs) {
      const status = job ? job.status : 'unknown (job nicht in shared.jobs)';
      const stall = stalledMs > 0 ? `, davon ${Math.round(stalledMs)}ms Event-Loop-Stall` : '';
      throw new Error(
        `waitForJob: timeout after ${timeoutMs}ms Loop-Budget (Wandzeit ${wallMs}ms${stall}), `
        + `Job-Status: ${status}`,
      );
    }

    await new Promise(r => setTimeout(r, POLL_MS));

    const now = Date.now();
    const tickMs = now - last;
    last = now;
    if (tickMs > STALL_THRESHOLD_MS) stalledMs += tickMs - POLL_MS;
    else budgetMs -= tickMs;
  }
}

module.exports = { bootstrap, waitForJob };
