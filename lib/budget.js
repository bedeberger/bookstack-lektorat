'use strict';
// Budget-Enforcement.
// checkBudget(email) liest app_users.{monthly_budget_usd, budget_mode} und
// aggregiert die monatliche USD-Summe ueber job_runs + chat_messages.
//   mode='none' => kein Check (Default fuer Neu-User).
//   mode='soft' => allowed=true, overrun-Flag fuer Banner.
//   mode='hard' => allowed=false bei Overrun => Middleware antwortet 429.
//
// Enforcement bewusst nur auf POST-Routen (Job-Start, Chat-Send). Status-Polls
// duerfen weiterlaufen, sonst kann ein gerade kostenpflichtig gewordener Job
// nicht mehr abgefragt werden.

const appUsers = require('../db/app-users');
const appSettings = require('./app-settings');
const { localMonthStartIso } = require('./local-date');
const costLedger = require('../db/cost-ledger');
const logger = require('../logger');
const { sessionEmail } = require('./acl');

// Monatsbeginn als UTC-Instant, gerechnet in app.timezone. Treibt sowohl
// Budget-Enforcement als auch Admin-Usage-Default-Range — Buckets matchen
// die App-Anzeige statt UTC-Mitternacht.
function firstOfCurrentMonthIso() {
  return localMonthStartIso();
}

// Summiert die eingefrorenen USD-Kosten eines Users seit `sinceIso` aus dem
// Kosten-Ledger (db/cost-ledger). Das Ledger trennt Job- und Chat-Verbrauch
// bereits an der Schreib-Seite (recordJobLedger schliesst chat-sourced Typen
// aus) — keine Doppelzaehlung, kein Re-Compute mehr noetig.
function sumCostUsdSince(email, sinceIso) {
  return costLedger.sumUsdSince(email, sinceIso);
}

// Liefert { allowed, mode, usd, budget, overrun? }.
//   allowed=false ausschliesslich bei mode='hard' UND usd>=budget>0.
function checkBudget(email) {
  if (!email) return { allowed: true, mode: 'none', usd: 0, budget: null };
  const user = appUsers.getUser(email);
  if (!user) return { allowed: true, mode: 'none', usd: 0, budget: null };
  const mode = user.budget_mode || 'none';
  if (mode === 'none') return { allowed: true, mode, usd: 0, budget: user.monthly_budget_usd };
  const budget = user.monthly_budget_usd;
  if (!budget || !Number.isFinite(budget) || budget <= 0) {
    return { allowed: true, mode, usd: 0, budget };
  }
  const usd = sumCostUsdSince(email, firstOfCurrentMonthIso());
  const overrun = usd >= budget;
  return { allowed: mode !== 'hard' || !overrun, mode, usd, budget, overrun };
}

// Express-Middleware: blockt POSTs mit 429 BUDGET_EXCEEDED bei hard-overrun.
// Skip-Bedingungen:
//   - Provider != 'claude' (lokale Modelle kosten 0 USD).
//   - Nicht-POST (Status-Polls, GETs).
//   - Kein eingeloggter User (eigene Auth-Middleware faengt das vorher).
function enforceBudget(req, res, next) {
  if (req.method !== 'POST') return next();
  const email = sessionEmail(req);
  if (!email) return next();

  const provider = (appSettings.get('ai.provider') || 'claude').toLowerCase();
  if (provider !== 'claude') return next();

  let result;
  try { result = checkBudget(email); }
  catch (err) {
    logger.warn(`[budget] checkBudget failed for ${email}: ${err.message}`);
    return next();
  }
  if (result.allowed) return next();

  res.status(429).json({
    error_code: 'BUDGET_EXCEEDED',
    usd: Math.round(result.usd * 100) / 100,
    budget: result.budget,
    mode: result.mode,
  });
}

module.exports = { checkBudget, enforceBudget, firstOfCurrentMonthIso, sumCostUsdSince };
