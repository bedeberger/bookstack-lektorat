'use strict';
// requireAdmin-Middleware fuer alle /admin/*-Routen. Liest die globale Rolle aus app_users (SSoT)
// statt aus Session — session.user.role kann veraltet sein, wenn der
// Admin selbst die Rolle aenderte ohne neu einzuloggen.

const appUsers = require('../db/app-users');
const { sessionEmail } = require('./acl');

function requireAdmin(req, res, next) {
  const email = sessionEmail(req);
  if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  const user = appUsers.getUser(email);
  if (!user) return res.status(403).json({ error_code: 'NOT_REGISTERED' });
  if (user.status !== 'active') return res.status(403).json({ error_code: 'NOT_ACTIVE' });
  if (user.global_role !== 'admin') return res.status(403).json({ error_code: 'ADMIN_REQUIRED' });
  // Session-Cache synchron halten, falls Rolle in DB veraendert wurde.
  if (req.session.user.role !== 'admin') req.session.user.role = 'admin';
  next();
}

// Hilfsfunktion fuer Routen, die "Admin ODER eigene Email" pruefen
// (z.B. PUT /admin/users/:email mit Self-Service-Sub-Pfaden).
function requireSelfOrAdmin(emailParam) {
  return (req, res, next) => {
    const sessionEmail = sessionEmail(req);
    if (!sessionEmail) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
    const target = (req.params[emailParam] || '').toLowerCase();
    if (target === sessionEmail.toLowerCase()) return next();
    return requireAdmin(req, res, next);
  };
}

module.exports = { requireAdmin, requireSelfOrAdmin };
