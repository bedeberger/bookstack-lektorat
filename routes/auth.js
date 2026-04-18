const express = require('express');
const { Issuer, generators } = require('openid-client');
const logger = require('../logger');
const { getUserToken, setUserToken, upsertUserLogin } = require('../db/schema');

const router = express.Router();

// OIDC-Client wird einmalig initialisiert und gecacht
let oidcClient = null;

async function getClient() {
  if (oidcClient) return oidcClient;
  const googleIssuer = await Issuer.discover('https://accounts.google.com');
  const appUrl = (process.env.APP_URL || 'http://localhost:3737').replace(/\/$/, '');
  oidcClient = new googleIssuer.Client({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uris: [`${appUrl}/auth/callback`],
    response_types: ['code'],
  });
  return oidcClient;
}

// Maximal parallele offene Login-Flows pro Session (ältere werden verworfen)
const MAX_PENDING_FLOWS = 5;

// GET /auth/login → redirect zu Google (oder direkt zu / im LOCAL_DEV_MODE)
router.get('/auth/login', async (req, res) => {
  if (process.env.LOCAL_DEV_MODE === 'true') {
    return res.redirect('/');
  }
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(500).send(
      'Google OAuth nicht konfiguriert. Bitte GOOGLE_CLIENT_ID und GOOGLE_CLIENT_SECRET in der .env setzen.'
    );
  }
  try {
    const client = await getClient();
    const state = generators.state();
    const nonce = generators.nonce();
    const rawReturn = req.query.returnTo || '/';
    const returnTo = rawReturn.startsWith('/') && !rawReturn.startsWith('//') ? rawReturn : '/';
    // Mehrere parallele Login-Flows (z.B. mehrere Tabs) nebeneinander erlauben:
    // State → { nonce, returnTo } ablegen, im Callback gezielt nachschlagen.
    const pending = Array.isArray(req.session.oidcPending) ? req.session.oidcPending : [];
    pending.push({ state, nonce, returnTo, ts: Date.now() });
    while (pending.length > MAX_PENDING_FLOWS) pending.shift();
    req.session.oidcPending = pending;
    const url = client.authorizationUrl({ scope: 'openid email profile', state, nonce });
    req.session.save((saveErr) => {
      if (saveErr) {
        logger.error('Session save error: ' + saveErr.message);
        return res.status(500).send('Session-Fehler: ' + saveErr.message);
      }
      res.redirect(url);
    });
  } catch (err) {
    logger.error('Auth login error: ' + err.message);
    res.status(500).send('Anmeldung fehlgeschlagen: ' + err.message);
  }
});

// GET /auth/callback → Token validieren, Session anlegen
router.get('/auth/callback', async (req, res) => {
  try {
    const client = await getClient();
    const appUrl = (process.env.APP_URL || 'http://localhost:3737').replace(/\/$/, '');
    const params = client.callbackParams(req);
    // Passenden pending-Flow suchen (Mehrtab-Support). Fallback auf Legacy-Felder.
    const pending = Array.isArray(req.session.oidcPending) ? req.session.oidcPending : [];
    const flowIdx = pending.findIndex(f => f.state === params.state);
    const flow = flowIdx >= 0
      ? pending[flowIdx]
      : (req.session.oidcState && req.session.oidcState === params.state
          ? { state: req.session.oidcState, nonce: req.session.oidcNonce, returnTo: req.session.returnTo }
          : null);
    if (!flow) {
      logger.warn(`Auth callback: kein passender Login-Flow für state=${params.state}`);
      return res.status(400).send(
        'Anmeldung abgelaufen oder ungültig. <a href="/auth/login">Erneut anmelden</a>'
      );
    }
    const tokenSet = await client.callback(
      `${appUrl}/auth/callback`,
      params,
      { state: flow.state, nonce: flow.nonce }
    );
    const claims = tokenSet.claims();
    const email = claims.email;

    // Optionale E-Mail-Whitelist (ALLOWED_EMAILS=a@b.com,c@d.com)
    const allowed = process.env.ALLOWED_EMAILS;
    if (allowed) {
      const list = allowed.split(',').map(e => e.trim().toLowerCase());
      if (!list.includes(email.toLowerCase())) {
        logger.warn(`Login verweigert für: ${email}`);
        return res.status(403).send(
          `Zugriff verweigert: ${email} ist nicht berechtigt. ` +
          `<a href="/auth/logout">Anderes Konto verwenden</a>`
        );
      }
    }

    const returnTo = flow.returnTo || '/';
    // Verbrauchten Flow entfernen; übrige parallele Flows nicht antasten.
    if (flowIdx >= 0) {
      pending.splice(flowIdx, 1);
      req.session.oidcPending = pending;
    }
    delete req.session.oidcState;
    delete req.session.oidcNonce;
    delete req.session.returnTo;
    req.session.user = { email, name: claims.name || email };
    upsertUserLogin(email, claims.name || email);
    // Gespeicherten BookStack-Token in Session laden (falls vorhanden)
    const stored = getUserToken(email);
    if (stored) req.session.bookstackToken = { id: stored.token_id, pw: stored.token_pw };
    logger.info(`Login: ${email}${stored ? ' (Token geladen)' : ' (kein Token hinterlegt)'}`);
    res.redirect(returnTo);
  } catch (err) {
    logger.error('Auth callback error: ' + err.message);
    res.status(500).send('Anmeldung fehlgeschlagen: ' + err.message);
  }
});

// GET /auth/logout → Session löschen
router.get('/auth/logout', (req, res) => {
  const email = req.session.user?.email;
  req.session.destroy(() => {
    if (email) logger.info(`Logout: ${email}`);
    res.redirect('/auth/login');
  });
});

// GET /auth/me → aktueller User (JSON, für Frontend)
router.get('/auth/me', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  res.json(req.session.user);
});

// GET /auth/token → ob ein BookStack-Token hinterlegt ist (kein Klartext!)
router.get('/auth/token', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  res.json({ hasToken: !!req.session.bookstackToken });
});

// PUT /auth/token → BookStack-Token speichern (DB + Session)
router.put('/auth/token', express.json(), (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  const { tokenId, tokenPw } = req.body || {};
  if (!tokenId || !tokenPw) return res.status(400).json({ error_code: 'TOKEN_ID_PW_REQUIRED' });
  const email = req.session.user.email;
  setUserToken(email, tokenId, tokenPw);
  req.session.bookstackToken = { id: tokenId, pw: tokenPw };
  logger.info(`Token gespeichert für: ${email}`);
  res.json({ ok: true });
});

module.exports = router;
