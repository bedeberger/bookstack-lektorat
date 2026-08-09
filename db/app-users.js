'use strict';
// Helper-API ueber app_users, user_invites, user_sessions_audit, user_activity.
// Keine direkte SQL aus Konsumenten.
//
// `app_users` ist die SSoT fuer User: Identity (email, display_name, role,
// status), Profil/Settings (language, theme, default_buchtyp/language/region,
// focus_granularity), Login-Spuren (first_seen_at, last_seen_at,
// last_login_at) und Budget/Provider-Overrides.
// Begleittabellen:
//   - `user_sessions_audit`  — Login/Logout/Role-Change-Events
//   - `user_invites`         — Token-basierte Einladungen
//   - `user_activity`        — aktive Sekunden pro (user, Tag)
//
// Default ist Soft-Delete via `status='deleted'`; Hard-Delete via DELETE-Row
// raeumt abhaengige Tabellen via FK CASCADE/SET NULL.

const crypto = require('crypto');
const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');

const _stmtFindByEmail = db.prepare(`
  SELECT id, email, display_name, avatar_url, global_role, status, language,
         model_override, can_invite_users, first_seen_at, last_seen_at,
         invited_by, invited_at, created_at, last_login_at,
         theme, default_buchtyp, default_language, default_region,
         focus_granularity, daily_goal_minutes,
         monthly_budget_usd, budget_mode, ai_profile_id,
         onboarding_state
    FROM app_users
   WHERE email = ?
`);

const _stmtInsertUser = db.prepare(`
  INSERT INTO app_users (email, display_name, global_role, status, language,
                         can_invite_users, first_seen_at, invited_by, invited_at, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL})
`);

const _stmtTouchLogin = db.prepare(`
  UPDATE app_users
     SET last_seen_at  = ${NOW_ISO_SQL},
         last_login_at = ${NOW_ISO_SQL},
         first_seen_at = COALESCE(first_seen_at, ${NOW_ISO_SQL}),
         display_name  = COALESCE(?, display_name)
   WHERE email = ?
`);

const _stmtTouchLastSeen = db.prepare(`
  UPDATE app_users SET last_seen_at = ? WHERE email = ?
`);

const _stmtUpdateUserSettings = db.prepare(`
  UPDATE app_users
     SET language          = ?,
         theme             = ?,
         default_buchtyp   = ?,
         default_language  = ?,
         default_region    = ?,
         focus_granularity = ?,
         daily_goal_minutes = ?
   WHERE email = ?
`);

const _stmtAddUserActivity = db.prepare(`
  INSERT INTO user_activity (user_email, date, seconds, first_at, last_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(user_email, date) DO UPDATE SET
    seconds = seconds + excluded.seconds,
    last_at = excluded.last_at
`);

const _stmtSetStatus = db.prepare(`
  UPDATE app_users SET status = ? WHERE email = ?
`);

const _stmtSetRole = db.prepare(`
  UPDATE app_users SET global_role = ? WHERE email = ?
`);

const _stmtSetInviteFlag = db.prepare(`
  UPDATE app_users SET can_invite_users = ? WHERE email = ?
`);

const _stmtListUsers = db.prepare(`
  SELECT u.id, u.email, u.display_name, u.global_role, u.status, u.language,
         u.can_invite_users, u.first_seen_at, u.last_seen_at, u.created_at,
         u.monthly_budget_usd, u.budget_mode, u.ai_profile_id,
         p.name     AS ai_profile_name,
         p.provider AS ai_profile_provider
    FROM app_users u
    LEFT JOIN ai_profiles p ON p.id = u.ai_profile_id
   ORDER BY u.created_at DESC, u.email
`);

// Admin weist einem User ein KI-Profil zu. NULL/'' loescht die Zuweisung (User
// folgt dann dem globalen ai.provider samt globaler Parameter). Validierung der
// Existenz in der Route; hier nur Persistenz — der FK faengt eine tote ID ohnehin.
const _stmtSetAiProfile = db.prepare(`
  UPDATE app_users SET ai_profile_id = ? WHERE email = ?
`);
function setAiProfile(email, profileId) {
  const e = _normEmail(email);
  if (!e) throw new Error('setAiProfile: email required');
  const v = (profileId === null || profileId === undefined || profileId === '')
    ? null
    : parseInt(profileId, 10);
  if (v !== null && !Number.isInteger(v)) throw new Error('setAiProfile: profileId must be an integer or null');
  _stmtSetAiProfile.run(v, e);
}

// Onboarding-Fortschritt (persistierter Teil: welcomeDismissed/completed) als
// JSON-Blob. NULL = noch nichts weggeklickt/abgeschlossen. Die Checklisten-
// Schritte selbst werden aus echtem State abgeleitet (routes/usersettings.js),
// nicht hier gespeichert.
const _stmtSetOnboarding = db.prepare(`
  UPDATE app_users SET onboarding_state = ? WHERE email = ?
`);
function setOnboardingState(email, state) {
  const e = _normEmail(email);
  if (!e) return;
  _stmtSetOnboarding.run(state == null ? null : JSON.stringify(state), e);
}

const _stmtSetBudget = db.prepare(`
  UPDATE app_users SET monthly_budget_usd = ?, budget_mode = ? WHERE email = ?
`);

const _stmtInsertAudit = db.prepare(`
  INSERT INTO user_sessions_audit (user_email, event, ip, user_agent, meta_json, created_at)
  VALUES (?, ?, ?, ?, ?, ${NOW_ISO_SQL})
`);

const _stmtListAudit = db.prepare(`
  SELECT id, event, ip, user_agent, meta_json, created_at
    FROM user_sessions_audit
   WHERE user_email = ?
   ORDER BY created_at DESC, id DESC
   LIMIT ?
`);

const _stmtInviteFind = db.prepare(`
  SELECT id, email, global_role, invite_token, invited_by, invited_at,
         expires_at, accepted_at, revoked_at,
         last_clicked_at, click_count, last_reminder_at, reminder_count
    FROM user_invites
   WHERE invite_token = ?
`);

const _stmtInviteFindById = db.prepare(`
  SELECT id, email, global_role, invite_token, invited_by, invited_at,
         expires_at, accepted_at, revoked_at,
         last_clicked_at, click_count, last_reminder_at, reminder_count
    FROM user_invites
   WHERE id = ?
`);

const _stmtInviteMarkClicked = db.prepare(`
  UPDATE user_invites
     SET last_clicked_at = ${NOW_ISO_SQL},
         click_count     = click_count + 1
   WHERE id = ?
`);

const _stmtInviteMarkReminded = db.prepare(`
  UPDATE user_invites
     SET last_reminder_at = ${NOW_ISO_SQL},
         reminder_count   = reminder_count + 1
   WHERE id = ?
`);

const _stmtInviteFindActiveByEmail = db.prepare(`
  SELECT id, invite_token, expires_at FROM user_invites
   WHERE email = ? AND revoked_at IS NULL AND accepted_at IS NULL
`);

const _stmtInviteInsert = db.prepare(`
  INSERT INTO user_invites (email, global_role, invite_token, invited_by, invited_at, expires_at)
  VALUES (?, ?, ?, ?, ${NOW_ISO_SQL}, ?)
`);

const _stmtInviteAccept = db.prepare(`
  UPDATE user_invites SET accepted_at = ${NOW_ISO_SQL} WHERE id = ?
`);

const _stmtInviteRevoke = db.prepare(`
  UPDATE user_invites SET revoked_at = ${NOW_ISO_SQL} WHERE id = ? AND accepted_at IS NULL
`);

function _normEmail(email) {
  return (email || '').trim().toLowerCase();
}

function getUser(email) {
  const e = _normEmail(email);
  if (!e) return null;
  return _stmtFindByEmail.get(e) || null;
}

function listUsers() {
  return _stmtListUsers.all();
}

const _stmtActiveAdminEmails = db.prepare(`
  SELECT email FROM app_users WHERE global_role = 'admin' AND status = 'active'
`);

function getActiveAdminEmails() {
  return _stmtActiveAdminEmails.all().map(r => r.email).filter(Boolean);
}

function createUser({ email, displayName = null, globalRole = 'user', status = 'active', language = 'de', canInviteUsers = 1, invitedBy = null }) {
  const e = _normEmail(email);
  if (!e) throw new Error('createUser: email required');
  const nowIso = new Date().toISOString();
  _stmtInsertUser.run(
    e,
    displayName,
    globalRole,
    status,
    language,
    canInviteUsers ? 1 : 0,
    status === 'active' ? nowIso : null,
    invitedBy ? _normEmail(invitedBy) : null,
    invitedBy ? nowIso : null,
  );
  return getUser(e);
}

function touchLogin(email, displayName = null) {
  const e = _normEmail(email);
  if (!e) return;
  _stmtTouchLogin.run(displayName, e);
}

/** Setzt last_seen_at auf nowIso. Throttling macht der Aufrufer. */
function touchUserLastSeen(email, nowIso = new Date().toISOString()) {
  const e = _normEmail(email);
  if (!e) return;
  _stmtTouchLastSeen.run(nowIso, e);
}

/** Partielles Settings-Update. Null-Werte setzen die Spalte zurueck. */
function updateUserSettings(email, settings) {
  const e = _normEmail(email);
  if (!e) return;
  _stmtUpdateUserSettings.run(
    settings.language          ?? null,
    settings.theme             ?? null,
    settings.default_buchtyp   ?? null,
    settings.default_language  ?? null,
    settings.default_region    ?? null,
    settings.focus_granularity ?? null,
    settings.daily_goal_minutes ?? null,
    e,
  );
}

/** Summiert aktive Sekunden fuer (user, Tag) in user_activity. */
function addUserActivity(email, seconds, nowIso = new Date().toISOString()) {
  const e = _normEmail(email);
  if (!e || !(seconds > 0)) return;
  const date = nowIso.slice(0, 10);
  _stmtAddUserActivity.run(e, date, Math.round(seconds), nowIso, nowIso);
}

function setStatus(email, status) {
  _stmtSetStatus.run(status, _normEmail(email));
}

function setGlobalRole(email, role) {
  _stmtSetRole.run(role, _normEmail(email));
}

function setCanInviteUsers(email, flag) {
  _stmtSetInviteFlag.run(flag ? 1 : 0, _normEmail(email));
}

// Admin setzt Monats-Budget. `usd=null` entfernt das numerische
// Limit; `mode='none'` deaktiviert Pruefung komplett.
function setBudget(email, { usd, mode }) {
  const e = _normEmail(email);
  if (!e) throw new Error('setBudget: email required');
  if (mode !== 'none' && mode !== 'soft' && mode !== 'hard') {
    throw new Error("setBudget: mode must be 'none'|'soft'|'hard'");
  }
  const usdVal = (usd === null || usd === undefined || usd === '') ? null : Number(usd);
  if (usdVal !== null && (!Number.isFinite(usdVal) || usdVal < 0)) {
    throw new Error('setBudget: usd must be null or a non-negative number');
  }
  _stmtSetBudget.run(usdVal, mode, e);
}

// Soft-Delete: status='deleted' + anonymize display_name. Email bleibt
// blockiert (UNIQUE-Index verhindert Wiederverwendung).
function softDeleteUser(email) {
  const e = _normEmail(email);
  if (!e) return;
  db.prepare(`
    UPDATE app_users
       SET status        = 'deleted',
           display_name  = 'gelöscht'
     WHERE email = ?
  `).run(e);
}

function recordAuditEvent(email, event, { ip = null, userAgent = null, meta = null } = {}) {
  const e = _normEmail(email);
  if (!e) return;
  const metaJson = meta ? JSON.stringify(meta) : null;
  _stmtInsertAudit.run(e, event, ip || null, userAgent || null, metaJson);
}

function listAuditForUser(email, limit = 50) {
  const e = _normEmail(email);
  if (!e) return [];
  return _stmtListAudit.all(e, Math.max(1, Math.min(500, limit)));
}

// ── Invites ────────────────────────────────────────────────────────────────

function _newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function createInvite({ email, globalRole = 'user', invitedBy, expiresInDays = 14 }) {
  const e = _normEmail(email);
  if (!e) throw new Error('createInvite: email required');
  if (!invitedBy) throw new Error('createInvite: invitedBy required');
  if (globalRole !== 'admin' && globalRole !== 'user') {
    throw new Error('createInvite: globalRole must be admin|user');
  }
  // Bestehende aktive Invite fuer dieselbe Email zuerst revoken — Partial UNIQUE
  // erlaubt sonst keinen zweiten Eintrag.
  const existing = _stmtInviteFindActiveByEmail.get(e);
  if (existing) {
    db.prepare(`UPDATE user_invites SET revoked_at = ${NOW_ISO_SQL} WHERE id = ?`).run(existing.id);
  }
  const token = _newToken();
  const expiresAt = new Date(Date.now() + Math.max(1, expiresInDays) * 86400_000).toISOString();
  _stmtInviteInsert.run(e, globalRole, token, _normEmail(invitedBy), expiresAt);
  return findInviteByToken(token);
}

function findInviteByToken(token) {
  if (!token || typeof token !== 'string') return null;
  return _stmtInviteFind.get(token) || null;
}

// Status-Auflösung: 'active' (verwendbar), 'expired', 'revoked', 'accepted'.
function inviteStatus(invite) {
  if (!invite) return null;
  if (invite.revoked_at)  return 'revoked';
  if (invite.accepted_at) return 'accepted';
  if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) return 'expired';
  return 'active';
}

function acceptInvite(inviteId) {
  _stmtInviteAccept.run(inviteId);
}

function revokeInvite(inviteId) {
  _stmtInviteRevoke.run(inviteId);
}

function listActiveInvites() {
  return db.prepare(`
    SELECT id, email, global_role, invite_token, invited_by, invited_at,
           expires_at, last_clicked_at, click_count,
           last_reminder_at, reminder_count
      FROM user_invites
     WHERE revoked_at IS NULL AND accepted_at IS NULL
     ORDER BY invited_at DESC
  `).all();
}

function findInviteById(id) {
  const n = Number(id);
  if (!Number.isFinite(n) || n <= 0) return null;
  return _stmtInviteFindById.get(n) || null;
}

function markInviteClicked(inviteId) {
  _stmtInviteMarkClicked.run(inviteId);
}

function markInviteReminded(inviteId) {
  _stmtInviteMarkReminded.run(inviteId);
}

// ── Admin-Bootstrap: ENV-getriebener Admin ────────────────────────────────
//
// Beim Server-Start: ADMIN_EMAIL aus ENV liest → wenn vorhanden, app_users-Row
// sicherstellen mit global_role='admin', status='active'. Re-Run-tauglich:
// existiert die Row mit anderer Rolle, wird auf 'admin' upgegradet (ENV ist
// SSoT fuer Admin-Identitaet). Status bleibt unangetastet, falls 'suspended'
// gewuenscht (Admin kann sich selbst sperren).
function ensureAdminFromEnv() {
  const envEmail = _normEmail(process.env.ADMIN_EMAIL);
  if (!envEmail) return null;
  const existing = getUser(envEmail);
  if (!existing) {
    createUser({
      email: envEmail,
      displayName: 'Admin',
      globalRole: 'admin',
      status: 'active',
      canInviteUsers: 1,
    });
    return { email: envEmail, action: 'created' };
  }
  if (existing.global_role !== 'admin') {
    setGlobalRole(envEmail, 'admin');
    return { email: envEmail, action: 'upgraded' };
  }
  return { email: envEmail, action: 'exists' };
}

module.exports = {
  getUser, listUsers, getActiveAdminEmails, createUser, touchLogin,
  touchUserLastSeen, updateUserSettings, addUserActivity,
  setStatus, setGlobalRole, setCanInviteUsers, setBudget, softDeleteUser,
  setAiProfile, setOnboardingState,
  recordAuditEvent, listAuditForUser,
  createInvite, findInviteByToken, findInviteById, inviteStatus,
  acceptInvite, revokeInvite, listActiveInvites,
  markInviteClicked, markInviteReminded,
  ensureAdminFromEnv,
};
