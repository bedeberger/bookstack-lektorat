'use strict';
const appSettings = require('../lib/app-settings');
// Admin-Routen fuer User-Verwaltung. Alle hinter requireAdmin (lib/admin-mw.js).
//
// Endpoints:
//   GET    /admin/users                — Liste aller User (kein Audit-Spam)
//   GET    /admin/users/:email/audit   — Audit-Drawer (letzte 50 Events)
//   POST   /admin/users/invite         — Token-Invite + Audit
//   PUT    /admin/users/:email         — global_role / status / can_invite_users
//   DELETE /admin/users/:email         — Soft-Delete (status='deleted')
//
// Privacy: Admin sieht hier nur User-Identitaet/Rolle/Status, keine Buecher.
// Buchsichtbarkeit laeuft ueber book_access.

const express = require('express');
const appUsers = require('../db/app-users');
const aiProfiles = require('../db/ai-profiles');
const mailer = require('../lib/mailer');
const { buildInviteUrl } = require('../lib/invite-url');
const { requireAdmin } = require('../lib/admin-mw');
const { setContext } = require('../lib/log-context');
const logger = require('../logger');

// Cooldown zwischen Reminder-Mails. Schuetzt den Empfaenger vor Spam, falls
// der Admin ungeduldig wird. Klick-Tracking gibt dem Admin sonst keinen
// Grund mehr fuer schnelle Wiederholung.
const REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// Faehrt dieses Profil effektiv gegen eine erreichbare Konfiguration? Ein NULL-Feld
// im Profil bedeutet „globaler Wert" — die Pruefung muss darum beide Ebenen ansehen,
// nicht nur die Profil-Spalte. Rueckgabe: der fehlende Provider (Detail fuer die
// Fehlerantwort) oder null, wenn alles da ist.
function _profileConfigGap(prof) {
  const eff = (key) => {
    const v = prof[key];
    return (v === null || v === undefined || v === '') ? appSettings.get(`ai.${prof.provider}.${key}`) : v;
  };
  if (prof.provider === 'claude') {
    return (prof.has_api_key || appSettings.get('ai.claude.api_key')) ? null : 'claude';
  }
  return eff('host') ? null : prof.provider;
}

const router = express.Router();
router.use(requireAdmin);

function _clientIp(req) {
  return req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || null;
}

// Router-Mount: app.use('/admin/users', router) — Pfade hier sind relativ.
router.get('/', (req, res) => {
  const users = appUsers.listUsers();
  res.json({ users });
});

router.get('/:email/audit', (req, res) => {
  const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 50));
  const events = appUsers.listAuditForUser(req.params.email, limit);
  res.json({ events });
});

router.post('/invite', express.json(), async (req, res) => {
  const { email, role = 'user' } = req.body || {};
  if (!email) return res.status(400).json({ error_code: 'EMAIL_REQUIRED' });
  if (role !== 'admin' && role !== 'user') return res.status(400).json({ error_code: 'ROLE_INVALID' });
  const invitedBy = req.session.user.email;
  let invite;
  try {
    invite = appUsers.createInvite({ email, globalRole: role, invitedBy });
    logger.info(`Admin-Invite ausgestellt: ${email} (${role})`, { user: invitedBy });
  } catch (e) {
    logger.error(`createInvite: ${e.message}`, { user: invitedBy });
    return res.status(500).json({ error_code: 'INVITE_FAILED', detail: e.message });
  }
  const inviteUrl = buildInviteUrl(invite.invite_token);
  // Mail synchron probieren, damit das UI sofort sieht, ob die Mail rausging
  // oder die URL inline kopiert werden muss (Mailer-disabled-Fallback).
  let mail = { sent: false, reason: 'not-attempted' };
  try {
    mail = await mailer.send({
      to: email,
      template: 'invite',
      locale: 'de',
      ctx: { inviterName: invitedBy, inviteUrl, expiresAt: invite.expires_at, role },
    });
  } catch (e) {
    mail = { sent: false, reason: 'error', error: e.message };
  }
  res.json({ invite, inviteUrl, mail });
});

// Liste aktiver, noch nicht akzeptierter und nicht widerrufener Invites.
// Frontend rendert daraus den Tab "Eingeladene Benutzer".
router.get('/invites', (req, res) => {
  const invites = appUsers.listActiveInvites().map(inv => ({
    ...inv,
    invite_url: buildInviteUrl(inv.invite_token),
    expired: inv.expires_at ? new Date(inv.expires_at).getTime() < Date.now() : false,
  }));
  res.json({ invites });
});

router.post('/invites/:id/remind', express.json(), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error_code: 'ID_INVALID' });
  const inv = appUsers.findInviteById(id);
  if (!inv) return res.status(404).json({ error_code: 'INVITE_NOT_FOUND' });
  const status = appUsers.inviteStatus(inv);
  if (status !== 'active') {
    return res.status(409).json({ error_code: 'INVITE_NOT_ACTIVE', status });
  }
  if (inv.last_reminder_at) {
    const last = new Date(inv.last_reminder_at).getTime();
    if (Number.isFinite(last) && Date.now() - last < REMINDER_COOLDOWN_MS) {
      const retryAfterSec = Math.ceil((REMINDER_COOLDOWN_MS - (Date.now() - last)) / 1000);
      res.set('Retry-After', String(retryAfterSec));
      return res.status(429).json({ error_code: 'REMINDER_COOLDOWN', retryAfter: retryAfterSec });
    }
  }
  const inviteUrl = buildInviteUrl(inv.invite_token);
  const actor = req.session.user.email;
  let mail = { sent: false, reason: 'not-attempted' };
  try {
    mail = await mailer.send({
      to: inv.email,
      template: 'invite-reminder',
      locale: 'de',
      ctx: { inviterName: inv.invited_by || actor, inviteUrl, expiresAt: inv.expires_at, role: inv.global_role },
    });
  } catch (e) {
    mail = { sent: false, reason: 'error', error: e.message };
  }
  if (mail.sent) {
    appUsers.markInviteReminded(id);
    logger.info(`Invite-Reminder gesendet an ${inv.email}`, { user: actor });
  }
  res.json({ mail, invite: appUsers.findInviteById(id) });
});

router.delete('/invites/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error_code: 'ID_INVALID' });
  const inv = appUsers.findInviteById(id);
  if (!inv) return res.status(404).json({ error_code: 'INVITE_NOT_FOUND' });
  appUsers.revokeInvite(id);
  logger.info(`Invite widerrufen: ${inv.email} (id=${id})`, { user: req.session.user.email });
  res.json({ ok: true });
});

router.put('/:email', express.json(), (req, res) => {
  const target = (req.params.email || '').toLowerCase();
  if (!target) return res.status(400).json({ error_code: 'EMAIL_REQUIRED' });
  const user = appUsers.getUser(target);
  if (!user) return res.status(404).json({ error_code: 'USER_NOT_FOUND' });

  const { global_role, status, can_invite_users, monthly_budget_usd, budget_mode, ai_profile_id } = req.body || {};
  const ip = _clientIp(req);
  const userAgent = req.headers['user-agent'] || null;
  const actor = req.session.user.email;

  if (global_role !== undefined) {
    if (global_role !== 'admin' && global_role !== 'user') {
      return res.status(400).json({ error_code: 'ROLE_INVALID' });
    }
    if (global_role !== user.global_role) {
      appUsers.setGlobalRole(target, global_role);
      appUsers.recordAuditEvent(target, 'role-changed', { ip, userAgent, meta: { from: user.global_role, to: global_role, by: actor } });
    }
  }
  if (status !== undefined) {
    if (!['active', 'suspended', 'invited', 'deleted'].includes(status)) {
      return res.status(400).json({ error_code: 'STATUS_INVALID' });
    }
    if (status !== user.status) {
      appUsers.setStatus(target, status);
      const event = status === 'suspended' ? 'suspended' : (status === 'active' ? 'reactivated' : status === 'deleted' ? 'deleted' : null);
      if (event) appUsers.recordAuditEvent(target, event, { ip, userAgent, meta: { from: user.status, to: status, by: actor } });
    }
  }
  if (can_invite_users !== undefined) {
    appUsers.setCanInviteUsers(target, !!can_invite_users);
  }
  // Budget-Felder. Beide muessen zusammen kommen — Mode + USD bilden
  // eine Einheit, sonst sind Defaults missverstaendlich.
  if (monthly_budget_usd !== undefined || budget_mode !== undefined) {
    const nextMode = budget_mode !== undefined ? budget_mode : (user.budget_mode || 'none');
    const nextUsd = monthly_budget_usd === undefined ? user.monthly_budget_usd : monthly_budget_usd;
    try {
      appUsers.setBudget(target, { usd: nextUsd, mode: nextMode });
      if (nextMode !== (user.budget_mode || 'none') || nextUsd !== user.monthly_budget_usd) {
        appUsers.recordAuditEvent(target, 'budget-changed', {
          ip, userAgent,
          meta: { from: { mode: user.budget_mode || 'none', usd: user.monthly_budget_usd }, to: { mode: nextMode, usd: nextUsd }, by: actor },
        });
      }
    } catch (e) {
      return res.status(400).json({ error_code: 'BUDGET_INVALID', detail: e.message });
    }
  }
  // KI-Profil-Zuweisung. NULL/'' = User folgt dem globalen ai.provider samt globaler
  // Parameter. Validiert wird die Erreichbarkeit der Konfiguration, die dieses Profil
  // effektiv faehrt: ein Profil ohne eigenen Host/Key faellt auf die globalen Werte
  // zurueck — fehlen die auch, waere die Zuweisung eine Zusage, die kein Call einloest.
  if (ai_profile_id !== undefined) {
    const next = (ai_profile_id === null || ai_profile_id === '') ? null : parseInt(ai_profile_id, 10);
    if (next !== null && !Number.isInteger(next)) {
      return res.status(400).json({ error_code: 'AI_PROFILE_INVALID' });
    }
    if (next !== null) {
      const prof = aiProfiles.getProfile(next);
      if (!prof) return res.status(404).json({ error_code: 'AI_PROFILE_NOT_FOUND' });
      const missing = _profileConfigGap(prof);
      if (missing) return res.status(400).json({ error_code: 'AI_PROVIDER_NOT_CONFIGURED', detail: missing });
    }
    if (next !== (user.ai_profile_id || null)) {
      try { appUsers.setAiProfile(target, next); }
      catch (e) { return res.status(400).json({ error_code: 'AI_PROFILE_INVALID', detail: e.message }); }
      appUsers.recordAuditEvent(target, 'ai-provider-changed', {
        ip, userAgent,
        meta: { from: user.ai_profile_id || null, to: next, by: actor },
      });
    }
  }

  res.json({ user: appUsers.getUser(target) });
});

router.delete('/:email', (req, res) => {
  const target = (req.params.email || '').toLowerCase();
  const user = appUsers.getUser(target);
  if (!user) return res.status(404).json({ error_code: 'USER_NOT_FOUND' });
  // Selbst-Loeschung blockieren — sonst lockt sich Admin selbst aus.
  if (target === req.session.user.email.toLowerCase()) {
    return res.status(400).json({ error_code: 'CANNOT_DELETE_SELF' });
  }
  appUsers.softDeleteUser(target);
  appUsers.recordAuditEvent(target, 'deleted', {
    ip: _clientIp(req),
    userAgent: req.headers['user-agent'] || null,
    meta: { by: req.session.user.email },
  });
  res.json({ ok: true });
});

module.exports = router;
