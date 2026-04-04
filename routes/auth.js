const express = require('express');
const { Issuer, generators } = require('openid-client');
const logger = require('../logger');
const { getUserToken, setUserToken } = require('../db/schema');

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

// GET /auth/login → redirect zu Google
router.get('/auth/login', async (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(500).send(
      'Google OAuth nicht konfiguriert. Bitte GOOGLE_CLIENT_ID und GOOGLE_CLIENT_SECRET in der .env setzen.'
    );
  }
  try {
    const client = await getClient();
    const state = generators.state();
    const nonce = generators.nonce();
    req.session.oidcState = state;
    req.session.oidcNonce = nonce;
    // Ursprüngliche Ziel-URL merken – nur relative Pfade erlaubt (kein Open Redirect)
    const rawReturn = req.query.returnTo || '/';
    req.session.returnTo = rawReturn.startsWith('/') && !rawReturn.startsWith('//') ? rawReturn : '/';
    const url = client.authorizationUrl({ scope: 'openid email profile', state, nonce });
    res.redirect(url);
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
    const tokenSet = await client.callback(
      `${appUrl}/auth/callback`,
      params,
      { state: req.session.oidcState, nonce: req.session.oidcNonce }
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

    const returnTo = req.session.returnTo || '/';
    delete req.session.oidcState;
    delete req.session.oidcNonce;
    delete req.session.returnTo;
    req.session.user = { email, name: claims.name || email };
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
  if (!req.session?.user) return res.status(401).json({ error: 'Nicht angemeldet' });
  res.json(req.session.user);
});

// GET /auth/token → ob ein BookStack-Token hinterlegt ist (kein Klartext!)
router.get('/auth/token', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Nicht angemeldet' });
  res.json({ hasToken: !!req.session.bookstackToken });
});

// PUT /auth/token → BookStack-Token speichern (DB + Session)
router.put('/auth/token', express.json(), (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Nicht angemeldet' });
  const { tokenId, tokenPw } = req.body || {};
  if (!tokenId || !tokenPw) return res.status(400).json({ error: 'tokenId und tokenPw erforderlich' });
  const email = req.session.user.email;
  setUserToken(email, tokenId, tokenPw);
  req.session.bookstackToken = { id: tokenId, pw: tokenPw };
  logger.info(`Token gespeichert für: ${email}`);
  res.json({ ok: true });
});

module.exports = router;
