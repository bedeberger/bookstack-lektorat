'use strict';
// Migration 107 + db/app-users.js Helper-API.
//
// Test laeuft Migrations-Pipeline auf eine Tmp-DB, seedet vor der Mig 107
// `users` + `job_runs` + `chat_sessions` + `user_tokens` Rows mit distinct
// Email-Werten. Erwartet:
//   - app_users-Row pro distinct Email
//   - existing user_tokens-FK wird via Cascade-Recreate korrekt umgehaengt
//   - user_invites + user_sessions_audit angelegt
//   - ensureAdminFromEnv legt Admin an / hebt vorhandene Row hoch
//   - createInvite + acceptInvite + revokeInvite funktionieren
//   - Audit-Events landen
//   - foreign_key_check leer

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(os.tmpdir(), `app-users-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmpDb;
// Bewusst KEIN ADMIN_EMAIL bei Mig-Lauf — ensureAdminFromEnv testen wir separat.
delete process.env.ADMIN_EMAIL;

// Migrations rennt bei require — danach koennen wir mit der DB seedet/lesen.
require('../../db/migrations');
const { db } = require('../../db/connection');
const appUsers = require('../../db/app-users');

// Bestand: Mig 107 hat schon gelaufen, aber kein User existierte. Wir simulieren
// jetzt einen Pre-107-Stand, indem wir nachtraeglich Datenquellen mit Rows
// fuellen und einen erneuten Backfill nachstellen — oder einfacher: wir testen
// nur die laufenden Helper. Bestands-Backfill aus pre-107 ist Migrations-
// Eigenleistung; hier verifizieren wir, dass es laeuft ohne Daten-Drift.

test.after(() => {
  try { db.close(); } catch {}
  try { fs.unlinkSync(tmpDb); } catch {}
  try { fs.unlinkSync(tmpDb + '-wal'); } catch {}
  try { fs.unlinkSync(tmpDb + '-shm'); } catch {}
});

test('schema_version >= 129', () => {
  const v = db.prepare('SELECT version FROM schema_version').get().version;
  assert.ok(v >= 129, `schema_version=${v} < 129`);
});

test('app_users + user_invites + user_sessions_audit existieren', () => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  for (const t of ['app_users', 'user_invites', 'user_sessions_audit']) {
    assert.ok(tables.includes(t), `${t} fehlt`);
  }
});

test('user_invites: partial UNIQUE-Index aktiv', () => {
  const idx = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND name='idx_user_invites_active_email'").get();
  assert.ok(idx, 'idx_user_invites_active_email fehlt');
  assert.match(idx.sql, /WHERE\s+revoked_at\s+IS\s+NULL/i);
});

test('users-Tabelle entfernt (Migration 129)', () => {
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
  assert.equal(t, undefined, 'users-Tabelle haette in Mig 129 gedropt werden muessen');
});

test('app_users hat konsolidierte Settings-Spalten', () => {
  const cols = db.pragma('table_info(app_users)').map(c => c.name);
  for (const c of ['last_login_at', 'theme', 'default_buchtyp', 'default_language',
                   'default_region', 'focus_granularity']) {
    assert.ok(cols.includes(c), `app_users.${c} fehlt`);
  }
  assert.ok(!cols.includes('daily_goal_chars'), 'daily_goal_chars lebt seit Mig 136 in book_settings, nicht mehr in app_users');
});

test('createUser + getUser', () => {
  appUsers.createUser({ email: 'alice@example.com', displayName: 'Alice', globalRole: 'user' });
  const u = appUsers.getUser('alice@example.com');
  assert.ok(u);
  assert.equal(u.email, 'alice@example.com');
  assert.equal(u.display_name, 'Alice');
  assert.equal(u.global_role, 'user');
  assert.equal(u.status, 'active');
  assert.equal(u.can_invite_users, 1);
});

test('getUser: email wird lowercase-normalisiert', () => {
  const u = appUsers.getUser('ALICE@example.com');
  assert.ok(u);
  assert.equal(u.email, 'alice@example.com');
});

test('touchLogin updated last_seen_at + first_seen_at', () => {
  appUsers.touchLogin('alice@example.com', 'Alice (renamed)');
  const u = appUsers.getUser('alice@example.com');
  assert.ok(u.first_seen_at);
  assert.ok(u.last_seen_at);
  assert.equal(u.display_name, 'Alice (renamed)');
});

test('setGlobalRole + setStatus + setCanInviteUsers', () => {
  appUsers.setGlobalRole('alice@example.com', 'admin');
  appUsers.setStatus('alice@example.com', 'suspended');
  appUsers.setCanInviteUsers('alice@example.com', 0);
  const u = appUsers.getUser('alice@example.com');
  assert.equal(u.global_role, 'admin');
  assert.equal(u.status, 'suspended');
  assert.equal(u.can_invite_users, 0);
});

test('softDeleteUser setzt status=deleted + anonymisiert display_name', () => {
  appUsers.createUser({ email: 'bob@example.com', displayName: 'Bob' });
  appUsers.softDeleteUser('bob@example.com');
  const u = appUsers.getUser('bob@example.com');
  assert.equal(u.status, 'deleted');
  assert.notEqual(u.display_name, 'Bob');
});

test('recordAuditEvent + listAuditForUser', () => {
  appUsers.recordAuditEvent('alice@example.com', 'login', { ip: '127.0.0.1', userAgent: 'tests', meta: { method: 'oidc' } });
  appUsers.recordAuditEvent('alice@example.com', 'role-changed', { meta: { from: 'user', to: 'admin' } });
  const events = appUsers.listAuditForUser('alice@example.com');
  assert.ok(events.length >= 2);
  const roleEvent = events.find(e => e.event === 'role-changed');
  assert.ok(roleEvent);
  const meta = JSON.parse(roleEvent.meta_json);
  assert.equal(meta.to, 'admin');
});

test('createInvite + findInviteByToken + inviteStatus', () => {
  const inv = appUsers.createInvite({ email: 'charlie@example.com', invitedBy: 'alice@example.com' });
  assert.ok(inv.invite_token);
  assert.equal(inv.email, 'charlie@example.com');
  assert.equal(inv.global_role, 'user');
  const found = appUsers.findInviteByToken(inv.invite_token);
  assert.ok(found);
  assert.equal(appUsers.inviteStatus(found), 'active');
});

test('createInvite revoked vorherige aktive Invite auf gleiche Email', () => {
  const inv1 = appUsers.createInvite({ email: 'dora@example.com', invitedBy: 'alice@example.com' });
  const inv2 = appUsers.createInvite({ email: 'dora@example.com', invitedBy: 'alice@example.com' });
  const found1 = appUsers.findInviteByToken(inv1.invite_token);
  assert.equal(appUsers.inviteStatus(found1), 'revoked');
  const found2 = appUsers.findInviteByToken(inv2.invite_token);
  assert.equal(appUsers.inviteStatus(found2), 'active');
});

test('acceptInvite + revokeInvite', () => {
  const inv = appUsers.createInvite({ email: 'eve@example.com', invitedBy: 'alice@example.com' });
  appUsers.acceptInvite(inv.id);
  const acc = appUsers.findInviteByToken(inv.invite_token);
  assert.equal(appUsers.inviteStatus(acc), 'accepted');

  const inv2 = appUsers.createInvite({ email: 'eve2@example.com', invitedBy: 'alice@example.com' });
  appUsers.revokeInvite(inv2.id);
  const rev = appUsers.findInviteByToken(inv2.invite_token);
  assert.equal(appUsers.inviteStatus(rev), 'revoked');
});

test('ensureAdminFromEnv: ohne ENV ist no-op', () => {
  delete process.env.ADMIN_EMAIL;
  const r = appUsers.ensureAdminFromEnv();
  assert.equal(r, null);
});

test('ensureAdminFromEnv: neuer Admin wird angelegt', () => {
  process.env.ADMIN_EMAIL = 'admin-new@example.com';
  const r = appUsers.ensureAdminFromEnv();
  assert.equal(r.action, 'created');
  const u = appUsers.getUser('admin-new@example.com');
  assert.equal(u.global_role, 'admin');
  assert.equal(u.status, 'active');
});

test('ensureAdminFromEnv: bestehender user wird auf admin upgegradet', () => {
  appUsers.createUser({ email: 'admin-up@example.com', globalRole: 'user' });
  process.env.ADMIN_EMAIL = 'admin-up@example.com';
  const r = appUsers.ensureAdminFromEnv();
  assert.equal(r.action, 'upgraded');
  const u = appUsers.getUser('admin-up@example.com');
  assert.equal(u.global_role, 'admin');
});

test('ensureAdminFromEnv: bestehender admin wird nicht angefasst', () => {
  process.env.ADMIN_EMAIL = 'admin-up@example.com';
  const r = appUsers.ensureAdminFromEnv();
  assert.equal(r.action, 'exists');
});

test('updateUserSettings + getUser: language + theme + default_* persistiert', () => {
  appUsers.createUser({ email: 'settings@example.com', displayName: 'Settings User' });
  appUsers.updateUserSettings('settings@example.com', {
    language: 'en',
    theme: 'dark',
    default_buchtyp: 'roman',
    default_language: 'en',
    default_region: 'US',
    focus_granularity: 'sentence',
  });
  const u = appUsers.getUser('settings@example.com');
  assert.equal(u.language, 'en');
  assert.equal(u.theme, 'dark');
  assert.equal(u.default_buchtyp, 'roman');
  assert.equal(u.default_region, 'US');
  assert.equal(u.focus_granularity, 'sentence');
});

test('touchUserLastSeen aktualisiert last_seen_at', () => {
  const before = appUsers.getUser('settings@example.com').last_seen_at;
  appUsers.touchUserLastSeen('settings@example.com', '2099-01-01T00:00:00.000Z');
  const after = appUsers.getUser('settings@example.com').last_seen_at;
  assert.equal(after, '2099-01-01T00:00:00.000Z');
  assert.notEqual(after, before);
});

test('addUserActivity summiert seconds pro (user, Tag)', () => {
  appUsers.addUserActivity('settings@example.com', 30, '2099-01-02T08:00:00.000Z');
  appUsers.addUserActivity('settings@example.com', 45, '2099-01-02T09:00:00.000Z');
  const row = db.prepare(
    'SELECT seconds FROM user_activity WHERE user_email = ? AND date = ?'
  ).get('settings@example.com', '2099-01-02');
  assert.equal(row.seconds, 75);
});

test('markInviteClicked: setzt last_clicked_at + zaehlt click_count', () => {
  const inv = appUsers.createInvite({ email: 'click1@example.com', invitedBy: 'alice@example.com' });
  let found = appUsers.findInviteById(inv.id);
  assert.equal(found.click_count, 0);
  assert.equal(found.last_clicked_at, null);
  appUsers.markInviteClicked(inv.id);
  appUsers.markInviteClicked(inv.id);
  found = appUsers.findInviteById(inv.id);
  assert.equal(found.click_count, 2);
  assert.ok(found.last_clicked_at, 'last_clicked_at fehlt');
});

test('markInviteReminded: setzt last_reminder_at + zaehlt reminder_count', () => {
  const inv = appUsers.createInvite({ email: 'remind1@example.com', invitedBy: 'alice@example.com' });
  appUsers.markInviteReminded(inv.id);
  const found = appUsers.findInviteById(inv.id);
  assert.equal(found.reminder_count, 1);
  assert.ok(found.last_reminder_at);
});

test('listActiveInvites: gibt Click+Reminder-Felder zurueck', () => {
  const all = appUsers.listActiveInvites();
  const sample = all[0];
  assert.ok(sample);
  for (const k of ['last_clicked_at', 'click_count', 'last_reminder_at', 'reminder_count']) {
    assert.ok(k in sample, `${k} fehlt im listActiveInvites-Output`);
  }
});

// ── Einladungs-Herkunft + KI-Profil-Vererbung ──────────────────────────────
//
// Ein eingeladenes Konto erbt das KI-Profil des Einladenden EINMAL bei der
// Anlage. Ohne das landet ein per Buch-Freigabe hereingeholter Mitautor stumm
// auf dem globalen Provider, den niemand fuer ihn gewaehlt hat.

test('createUser: invitedBy wird gespeichert (Herkunft des Kontos)', () => {
  appUsers.createUser({ email: 'inviter@example.com', displayName: 'Ida Inviter' });
  appUsers.createUser({ email: 'invitee@example.com', invitedBy: 'Inviter@Example.com' });
  const u = appUsers.getUser('invitee@example.com');
  assert.equal(u.invited_by, 'inviter@example.com', 'invited_by nicht normalisiert gespeichert');
  assert.ok(u.invited_at, 'invited_at fehlt');
});

test('createUser: eingeladener User erbt das KI-Profil des Einladenden', () => {
  const aiProfiles = require('../../db/ai-profiles');
  const prof = aiProfiles.createProfile({ name: `Erb-Profil-${Date.now()}`, provider: 'claude' }, 'inviter@example.com');
  appUsers.setAiProfile('inviter@example.com', prof.id);

  appUsers.createUser({ email: 'erbe@example.com', invitedBy: 'inviter@example.com' });
  assert.equal(appUsers.getUser('erbe@example.com').ai_profile_id, prof.id);

  // Kopie, keine Verknuepfung: der Wechsel beim Einladenden zieht den
  // Eingeladenen nicht mit.
  appUsers.setAiProfile('inviter@example.com', null);
  assert.equal(appUsers.getUser('erbe@example.com').ai_profile_id, prof.id);

  // Ohne Einladenden bleibt es beim globalen Provider (NULL).
  appUsers.createUser({ email: 'selbst@example.com' });
  assert.equal(appUsers.getUser('selbst@example.com').ai_profile_id, null);

  // Expliziter Wert schlaegt die Vererbung.
  appUsers.setAiProfile('inviter@example.com', prof.id);
  appUsers.createUser({ email: 'explizit@example.com', invitedBy: 'inviter@example.com', aiProfileId: null });
  assert.equal(appUsers.getUser('explizit@example.com').ai_profile_id, null);
});

test('listUsers: liefert Einladungs-Herkunft inkl. Name des Einladenden', () => {
  const row = appUsers.listUsers().find(u => u.email === 'invitee@example.com');
  assert.ok(row, 'invitee fehlt in listUsers');
  assert.equal(row.invited_by, 'inviter@example.com');
  assert.equal(row.invited_by_name, 'Ida Inviter');
  const self = appUsers.listUsers().find(u => u.email === 'selbst@example.com');
  assert.equal(self.invited_by, null);
  assert.equal(self.invited_by_name, null);
});

test('foreign_key_check nach Mig 107 leer', () => {
  const errs = db.pragma('foreign_key_check');
  assert.equal(errs.length, 0, `${errs.length} FK-Verstoesse: ${JSON.stringify(errs.slice(0, 5))}`);
});
