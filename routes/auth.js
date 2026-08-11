const crypto = require('crypto');
const express = require('express');
const { Issuer, generators } = require('openid-client');
const logger = require('../logger');
const appUsers = require('../db/app-users');
const rateLimit = require('../lib/admin-login-ratelimit');
const appSettings = require('../lib/app-settings');
const altcha = require('../lib/altcha');
const avatarCache = require('../lib/avatar-cache');
const demoUser = require('../lib/demo-user');
const { tServer } = require('../lib/i18n-server');
const { sessionEmail } = require('../lib/acl');

const router = express.Router();

// Öffentliche Basis-URL: SSoT ist app_settings (`app.public_url`). Im
// LOCAL_DEV_MODE fällt der Default auf den lokalen Dev-Port — sonst muss der
// Admin den Wert in der Settings-UI gesetzt haben, damit OIDC-Callback +
// Invite-Mails funktionieren.
function getPublicUrl() {
  const fromDb = appSettings.get('app.public_url');
  if (fromDb) return String(fromDb).replace(/\/$/, '');
  if (process.env.LOCAL_DEV_MODE === 'true') {
    return `http://localhost:${process.env.PORT || 3737}`;
  }
  return '';
}

// OIDC-Client wird einmalig initialisiert und gecacht. Bei Änderung relevanter
// app_settings-Keys (public_url, google.client_id/secret) verworfen, damit die
// neue Konfiguration beim nächsten Login greift — ohne Server-Restart.
let oidcClient = null;
appSettings.on('changed', ({ key }) => {
  if (key === 'app.public_url' || key === 'auth.google.client_id' || key === 'auth.google.client_secret') {
    oidcClient = null;
  }
});

async function getClient() {
  if (oidcClient) return oidcClient;
  const googleIssuer = await Issuer.discover('https://accounts.google.com');
  const appUrl = getPublicUrl();
  if (!appUrl) throw new Error('app.public_url ist nicht gesetzt — Admin muss die öffentliche URL in den App-Einstellungen hinterlegen.');
  oidcClient = new googleIssuer.Client({
    client_id: appSettings.get('auth.google.client_id'),
    client_secret: appSettings.get('auth.google.client_secret'),
    redirect_uris: [`${appUrl}/auth/callback`],
    response_types: ['code'],
  });
  return oidcClient;
}

// Maximal parallele offene Login-Flows pro Session (ältere werden verworfen)
const MAX_PENDING_FLOWS = 5;

function _clientIp(req) {
  // Nur req.ip (aufgeloest via `trust proxy`-Hop). Client-supplied X-Forwarded-For
  // ist spoofbar und darf fuer Rate-Limit-/Anti-Abuse-Keys nicht verwendet werden.
  return req.ip || null;
}

// Konstant-zeit-Vergleich gleichgrosser Buffer. ENV-Passwort + User-Input
// auf SHA-256 normalisieren, damit Buffer-Laenge identisch ist.
function _passwordsMatch(expected, given) {
  if (!expected || !given) return false;
  const a = crypto.createHash('sha256').update(String(expected)).digest();
  const b = crypto.createHash('sha256').update(String(given)).digest();
  return crypto.timingSafeEqual(a, b);
}

// Gemeinsamer Kern der ENV-Passwort-Logins (Admin-Pfad + Demo-Zugang). Nur die
// Konfiguration unterscheidet sich; die sicherheitsrelevante Sequenz
// (Rate-Limit → ALTCHA → konstantzeit-Vergleich → Audit → Session) ist damit per
// Konstruktion in beiden Pfaden identisch und kann nicht auseinanderdriften.
//
// Der Rate-Limit-Bucket ist bewusst GETEILT (lib/admin-login-ratelimit, Key =
// IP): Brute-Force gegen den einen Pfad deckelt auch den anderen.
//
// cfg.ensureUser() liefert { role, name } oder { denied: 'suspended'|'deleted' }
// und ist die einzige Stelle, die ueber die Rolle der Session entscheidet.
function _credentialLogin(cfg) {
  const { disabledCode, envEmailKey, envPasswordKey, method, ensureUser, onSuccess, logLabel } = cfg;
  const isEnabled = cfg.isEnabled || (() => !!(process.env[envEmailKey] && process.env[envPasswordKey]));
  return async (req, res) => {
    if (!isEnabled()) return res.status(404).json({ error_code: disabledCode });
    const ip = _clientIp(req);
    const state = rateLimit.getState(ip);
    if (state.blocked) {
      res.set('Retry-After', String(state.retryAfterSec || 900));
      return res.status(429).json({ error_code: 'RATE_LIMITED', retryAfter: state.retryAfterSec });
    }
    const { email, password, altcha: altchaSolution } = req.body || {};
    // ALTCHA vor dem Credential-Check: ohne gueltige PoW-Loesung kein Versuch.
    // Kein recordFailure hier — ein fehlendes/ungueltiges Token ist keine
    // Credential-Brute-Force, und der Solver-CPU-Aufwand deckelt Bots bereits.
    const captcha = await altcha.verify(altchaSolution);
    if (!captcha.ok) {
      return res.status(400).json({ error_code: 'CAPTCHA_FAILED' });
    }
    const givenEmail = (email || '').toLowerCase().trim();
    const expectedEmail = (process.env[envEmailKey] || '').toLowerCase().trim();
    const userAgent = req.headers['user-agent'] || null;

    const emailMatch = givenEmail && expectedEmail && givenEmail === expectedEmail;
    const passwordMatch = _passwordsMatch(process.env[envPasswordKey], password);

    if (!emailMatch || !passwordMatch) {
      const after = rateLimit.recordFailure(ip);
      appUsers.recordAuditEvent(givenEmail || expectedEmail, 'login-denied', { ip, userAgent, meta: { method, failCount: after.failCount } });
      logger.warn(`${logLabel} fehlgeschlagen.`, { user: givenEmail || expectedEmail });
      return res.status(401).json({ error_code: 'INVALID_CREDENTIALS' });
    }

    rateLimit.recordSuccess(ip);
    // app_users-Row sicherstellen. Status-Gate greift hier und nicht vor dem
    // Credential-Check, damit die Antwort nicht verraet, ob ein Konto existiert.
    const ensured = ensureUser();
    if (ensured && ensured.denied) {
      appUsers.recordAuditEvent(givenEmail, 'login-denied', { ip, userAgent, meta: { method, reason: ensured.denied } });
      logger.warn(`${logLabel} verweigert (Status ${ensured.denied}).`, { user: givenEmail });
      return res.status(403).json({ error_code: 'USER_NOT_ACTIVE', reason: ensured.denied });
    }
    appUsers.touchLogin(givenEmail);
    appUsers.recordAuditEvent(givenEmail, 'login', { ip, userAgent, meta: { method } });

    req.session.user = { email: givenEmail, name: ensured.name, picture: null, role: ensured.role };
    req.session.loginAt = Date.now();
    req.session.lastSeen = Date.now();
    logger.info(`${logLabel}.`, { user: givenEmail });
    // Post-Login-Hook (Demo-Seed). Non-fatal: ein Fehler darf den bereits
    // erfolgreichen Login nicht in einen 500 verwandeln.
    if (onSuccess) {
      try { await onSuccess(givenEmail); }
      catch (e) { logger.warn(`${logLabel}: Post-Login-Hook fehlgeschlagen: ${e.message}`, { user: givenEmail }); }
    }
    req.session.save(err => {
      if (err) return res.status(500).json({ error_code: 'SESSION_SAVE_FAILED' });
      res.json({ ok: true });
    });
  };
}

// Gemeinsames Pre-Auth-Page-Skeleton. Wird vor SPA-Boot ausgeliefert, darum
// kein Alpine, sondern Server-HTML mit minimalem Asset-Set (tokens + landing).
function _renderPublicShell({ lang, title, mainHtml, scripts = '' }) {
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="/schreibwerkstatt_icon.svg">
<link rel="stylesheet" href="/css/tokens.css">
<link rel="stylesheet" href="/css/landing.css">
<script defer src="/js/plausible-init.js"></script>
</head>
<body>
${mainHtml}
${scripts}</body></html>`;
}

function _escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

const DENIED_REASONS = new Set(['suspended', 'deleted', 'notInvited']);

// Status-Gates: 'suspended' / 'deleted' → 403, audit + denied-Render.
function _renderDenied(res, lang, reasonKey) {
  const reason = DENIED_REASONS.has(reasonKey) ? reasonKey : 'notInvited';
  const title = tServer('auth.denied.title', lang);
  const body = tServer(`auth.denied.${reason}`, lang);
  const cta = tServer('auth.denied.cta', lang);
  res.status(403);
  res.set('Cache-Control', 'no-store');
  res.send(_renderPublicShell({
    lang,
    title,
    mainHtml: `<main class="public-shell">
  <header class="public-header">
    <h1>${title}</h1>
    <p class="public-sub">${body}</p>
  </header>
  <section class="public-actions">
    <a class="public-btn" href="/auth/logout">${cta}</a>
  </section>
</main>`,
  }));
}

function _bodyLang(req) {
  const accept = String(req.headers['accept-language'] || '').toLowerCase();
  return accept.startsWith('en') ? 'en' : 'de';
}

// GET /invite/:token → loggt Click (last_clicked_at, click_count) und leitet
// auf /login?returnTo=/?invite={token} weiter. Damit kann der Admin im Tab
// "Eingeladene Benutzer" sehen, ob der User die Mail geoeffnet hat — auch wenn
// er sich noch nicht eingeloggt hat. Oeffentlicher Endpoint (vor Auth-Guard).
//
// Auch fuer abgelaufene/widerrufene/akzeptierte Tokens wird weitergeleitet —
// der Callback wirft dann den passenden Fehler. Click-Tracking selber laeuft
// nur fuer 'active'-Status, damit Wiederholungs-Klicks auf alte Mails nicht
// die Statistik verwaessern.
router.get('/invite/:token', (req, res) => {
  const token = String(req.params.token || '');
  if (token) {
    try {
      const inv = appUsers.findInviteByToken(token);
      if (inv && appUsers.inviteStatus(inv) === 'active') {
        appUsers.markInviteClicked(inv.id);
      }
    } catch (e) {
      logger.warn(`invite-click: ${e.message}`);
    }
  }
  const returnTo = `/?invite=${encodeURIComponent(token)}`;
  res.redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`);
});

// GET /auth/login → redirect zu Google (oder direkt zu / im LOCAL_DEV_MODE)
router.get('/auth/login', async (req, res) => {
  if (process.env.LOCAL_DEV_MODE === 'true') {
    // Logout-Marker raeumen, damit der Guard wieder eine Dev-Session anlegen darf.
    res.clearCookie('sw_devout', { path: '/' });
    return res.redirect('/');
  }
  if (!appSettings.get('auth.google.client_id') || !appSettings.get('auth.google.client_secret')) {
    return res.status(500).send(
      'Google OAuth nicht konfiguriert. Admin muss auth.google.client_id und auth.google.client_secret in den App-Einstellungen setzen.'
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
    const appUrl = getPublicUrl();
    const params = client.callbackParams(req);
    // Passenden pending-Flow suchen (Mehrtab-Support). `oidcPending` ist seit
    // Multi-Tab-Refactor die einzige Quelle; ältere `oidcState`/`oidcNonce`-
    // Felder werden nirgends mehr geschrieben.
    const pending = Array.isArray(req.session.oidcPending) ? req.session.oidcPending : [];
    const flowIdx = pending.findIndex(f => f.state === params.state);
    const flow = flowIdx >= 0 ? pending[flowIdx] : null;
    if (!flow) {
      logger.warn(`Auth callback: kein passender Login-Flow für state=${params.state}`);
      return res.status(400).send(
        'Anmeldung abgelaufen oder ungültig. <a href="/login">Erneut anmelden</a>'
      );
    }
    const tokenSet = await client.callback(
      `${appUrl}/auth/callback`,
      params,
      { state: flow.state, nonce: flow.nonce }
    );
    const claims = tokenSet.claims();
    const email = (claims.email || '').toLowerCase();
    const ip = _clientIp(req);
    const userAgent = req.headers['user-agent'] || null;
    const lang = _bodyLang(req);

    // app_users-Lookup + Status-Gate + Invite-Accept-Flow.
    let user = appUsers.getUser(email);
    if (user) {
      if (user.status === 'suspended') {
        appUsers.recordAuditEvent(email, 'login-denied', { ip, userAgent, meta: { method: 'oidc', reason: 'suspended' } });
        return _renderDenied(res, lang, 'suspended');
      }
      if (user.status === 'deleted') {
        appUsers.recordAuditEvent(email, 'login-denied', { ip, userAgent, meta: { method: 'oidc', reason: 'deleted' } });
        return _renderDenied(res, lang, 'deleted');
      }
    } else {
      // Kein Eintrag in app_users: pruefen, ob ein gueltiger Invite-Token
      // im returnTo verlinkt ist, oder ALLOW_OPEN_SIGNUP greift.
      const inviteToken = (() => {
        try { return new URL(flow.returnTo || '', 'http://x').searchParams.get('invite'); }
        catch { return null; }
      })();
      let acceptedInvite = null;
      if (inviteToken) {
        const inv = appUsers.findInviteByToken(inviteToken);
        if (inv && inv.email === email && appUsers.inviteStatus(inv) === 'active') {
          acceptedInvite = inv;
        }
      }
      if (acceptedInvite) {
        user = appUsers.createUser({
          email,
          displayName: claims.name || email,
          globalRole: acceptedInvite.global_role,
          status: 'active',
          invitedBy: acceptedInvite.invited_by,
        });
        appUsers.acceptInvite(acceptedInvite.id);
      } else if (appSettings.get('auth.allow_open_signup') === true) {
        user = appUsers.createUser({
          email,
          displayName: claims.name || email,
          globalRole: 'user',
          status: 'active',
        });
      } else {
        appUsers.recordAuditEvent(email, 'login-denied', { ip, userAgent, meta: { method: 'oidc', reason: 'not-invited' } });
        logger.warn('Login verweigert (kein Invite, ALLOW_OPEN_SIGNUP=false).', { user: email });
        return _renderDenied(res, lang, 'notInvited');
      }
    }

    const returnTo = (flow.returnTo && flow.returnTo.startsWith('/') && !flow.returnTo.startsWith('//')) ? flow.returnTo : '/';
    // Verbrauchten Flow entfernen; übrige parallele Flows nicht antasten.
    if (flowIdx >= 0) {
      pending.splice(flowIdx, 1);
      req.session.oidcPending = pending;
    }
    delete req.session.oidcState;
    delete req.session.oidcNonce;
    delete req.session.returnTo;
    req.session.user = {
      email,
      name: claims.name || user.display_name || email,
      picture: claims.picture || null,
      role: user.global_role,
    };
    req.session.loginAt = Date.now();
    req.session.lastSeen = Date.now();
    appUsers.touchLogin(email, claims.name || null);
    appUsers.recordAuditEvent(email, 'login', { ip, userAgent, meta: { method: 'oidc' } });
    logger.info('Login', { user: email });
    res.redirect(returnTo);
  } catch (err) {
    logger.error('Auth callback error: ' + err.message);
    res.status(500).send('Anmeldung fehlgeschlagen: ' + err.message);
  }
});

// GET /login → Landing-Page mit Google-Button + optionaler Admin-Form.
// Auth-Guard redirected unauth User hierhin (statt direkt zu Google),
// damit Admin-Pfad sichtbar ist. Wenn ADMIN_PASSWORD-ENV leer ist, wird
// die Admin-Form ausgeblendet (Plan-Pfad B deaktiviert).
router.get('/login', (req, res) => {
  if (process.env.LOCAL_DEV_MODE === 'true') return res.redirect('/');
  if (req.session?.user) {
    const rawReturn = typeof req.query.returnTo === 'string' ? req.query.returnTo : '/';
    const safeReturn = rawReturn.startsWith('/') && !rawReturn.startsWith('//') ? rawReturn : '/';
    return res.redirect(safeReturn);
  }
  // Backcompat: Mails vor Mig 144 trugen /login?invite=TOKEN ohne returnTo.
  // Auf neue Click-Tracking-Route umlenken, damit Klick mitgezaehlt wird und
  // Token in den OIDC-Callback-Flow gepackt wird.
  const legacyInvite = typeof req.query.invite === 'string' ? req.query.invite : null;
  if (legacyInvite && !req.query.returnTo) {
    return res.redirect(`/invite/${encodeURIComponent(legacyInvite)}`);
  }
  const lang = _bodyLang(req);
  const hasGoogle = !!(appSettings.get('auth.google.client_id') && appSettings.get('auth.google.client_secret'));
  const hasAdminPw = !!process.env.ADMIN_PASSWORD;
  const hasDemo = demoUser.isEnabled();
  const returnTo = typeof req.query.returnTo === 'string' && req.query.returnTo.startsWith('/') && !req.query.returnTo.startsWith('//')
    ? req.query.returnTo : '/';
  const t = (k) => tServer(k, lang);
  const title = t('auth.login.title');
  const googleBlock = `  <section class="public-actions">
    <a class="public-btn public-btn--primary" href="/auth/login?returnTo=${encodeURIComponent(returnTo)}">${t('auth.login.google')}</a>
  </section>
`;
  // ALTCHA-Widget nur einhaengen, wenn aktiv. Form-assoziiertes Custom-Element:
  // der geloeste Wert landet als Feld `altcha` in der FormData
  // (credential-login.js liest ihn raus). Das Modul registriert <altcha-widget>
  // beim Laden. Jede Form braucht ihre EIGENE Widget-Instanz — das Element ist
  // an genau eine Form gebunden, ein geteiltes Widget wuerde nur in einer der
  // beiden FormData landen.
  const altchaOn = (hasAdminPw || hasDemo) && altcha.isEnabled();
  const altchaWidget = altchaOn
    ? `    <altcha-widget challenge="/altcha/challenge" name="altcha" auto="onload"></altcha-widget>\n`
    : '';
  // Beide Passwort-Formen teilen Markup + Handler; sie unterscheiden sich nur in
  // Endpoint, Labels und (beim Demo-Zugang) der vorbefuellten Adresse.
  const pwForm = ({ id, endpoint, heading, hint, emailLabel, submitLabel, emailValue }) => `  <form id="${id}" class="public-form" novalidate data-login-endpoint="${_escAttr(endpoint)}" data-returnto="${_escAttr(returnTo)}" data-msg-invalid="${_escAttr(t('auth.login.errInvalid'))}" data-msg-rate-tpl="${_escAttr(t('auth.login.errRateTpl'))}" data-msg-captcha="${_escAttr(t('auth.login.errCaptcha'))}" data-msg-inactive="${_escAttr(t('auth.login.errInactive'))}">
    <h2 class="public-form-title">${heading}</h2>
${hint ? `    <p class="public-sub">${hint}</p>\n` : ''}    <label><span>${emailLabel}</span><input type="email" name="email" required autocomplete="username"${emailValue ? ` value="${_escAttr(emailValue)}"` : ''}></label>
    <label><span>${t('auth.login.password')}</span><input type="password" name="password" required autocomplete="current-password"></label>
${altchaWidget}    <div class="public-form-actions">
      <button type="submit" class="public-btn public-btn--primary">${submitLabel}</button>
    </div>
    <p class="public-msg public-msg--err" data-login-err hidden></p>
  </form>
`;
  const adminBlock = pwForm({
    id: 'admin-form',
    endpoint: '/auth/admin-login',
    heading: t('auth.login.adminTitle'),
    emailLabel: t('auth.login.email'),
    submitLabel: t('auth.login.submit'),
  });
  // Demo-Adresse vorbefuellen: sie ist kein Geheimnis (steht in den
  // Store-Reviewer-Notes) und ein Tippfehler des Reviewers kostet einen
  // Rejection-Zyklus. Das Passwort wird nie vorbefuellt.
  const demoBlock = pwForm({
    id: 'demo-form',
    endpoint: '/auth/demo-login',
    heading: t('auth.login.demoTitle'),
    hint: t('auth.login.demoHint'),
    emailLabel: t('auth.login.demoEmail'),
    submitLabel: t('auth.login.demoSubmit'),
    emailValue: demoUser.demoEmail(),
  });
  const blocks = [];
  if (hasGoogle) blocks.push(googleBlock);
  if (hasAdminPw) blocks.push(adminBlock);
  if (hasDemo) blocks.push(demoBlock);
  const sep = `  <div class="public-sep">${t('auth.login.or')}</div>\n`;
  const bodyHtml = blocks.length
    ? blocks.join(sep)
    : `  <p class="public-sub">${t('auth.login.noAdmin')}</p>\n`;
  res.set('Cache-Control', 'no-store');
  const formScripts = (hasAdminPw || hasDemo)
    ? `${altchaOn ? '<script type="module" src="/vendor/altcha-3.0.11.min.js"></script>\n' : ''}<script src="/js/credential-login.js"></script>\n`
    : '';
  res.send(_renderPublicShell({
    lang,
    title,
    mainHtml: `<main class="public-shell">
  <header class="public-header"><h1>${title}</h1></header>
${bodyHtml}</main>`,
    scripts: formScripts,
  }));
});

// POST /auth/admin-login → ENV-getriebener Admin-Login.
//
// Wahrheit lebt in ENV: ADMIN_EMAIL + ADMIN_PASSWORD. timingSafeEqual ueber
// SHA-256-Hash beider Werte (gleiche Buffer-Laenge, konstantzeit-Vergleich).
// Rate-Limit pro IP via lib/admin-login-ratelimit. Ohne ADMIN_PASSWORD-ENV
// liefert die Route 404 (Login-Pfad B komplett deaktiviert).
router.post('/auth/admin-login', express.json(), _credentialLogin({
  disabledCode: 'ADMIN_LOGIN_DISABLED',
  envEmailKey: 'ADMIN_EMAIL',
  envPasswordKey: 'ADMIN_PASSWORD',
  method: 'env',
  logLabel: 'Admin-Login (ENV-Pfad)',
  // Sicherstellen, dass app_users-Row existiert + global_role='admin'. Kein
  // Status-Gate: der ENV-Admin ist der Notfall-Zugang zur Instanz und darf sich
  // nicht selbst aussperren koennen.
  ensureUser: () => {
    appUsers.ensureAdminFromEnv();
    return { role: 'admin', name: 'Admin' };
  },
}));

// POST /auth/demo-login → ENV-getriebener Demo-Zugang (Rolle 'user').
//
// Gleiche Haertung wie der Admin-Pfad (geteilte Factory + geteilter
// Rate-Limit-Bucket), aber ohne Admin-Rechte. Existenzgrund: Store-Reviews
// verlangen einen Demo-Account, und ein Google-Konto kann man Reviewern nicht
// geben. Wahrheit in ENV: DEMO_EMAIL + DEMO_PASSWORD; ohne beides → 404.
// Details + Betriebsregeln: lib/demo-user.js.
router.post('/auth/demo-login', express.json(), _credentialLogin({
  disabledCode: 'DEMO_LOGIN_DISABLED',
  envEmailKey: 'DEMO_EMAIL',
  envPasswordKey: 'DEMO_PASSWORD',
  method: 'demo',
  logLabel: 'Demo-Login',
  isEnabled: () => demoUser.isEnabled(),
  ensureUser: () => demoUser.ensureDemoUser(),
  onSuccess: (email) => demoUser.seedDemoContent(email),
}));

// GET /auth/logout → Session löschen + Landing-Page anzeigen.
// Kein Auto-Redirect zu /auth/login: Google-Session wäre meist noch aktiv und
// würde uns sofort silent wieder einloggen. User klickt aktiv "Erneut anmelden".
router.get('/auth/logout', (req, res) => {
  // LOCAL_DEV_MODE: Logout no-op — der Guard wuerde sofort eine neue Dev-Admin-
  // Session anlegen, dadurch waere der Logout/Login-Zyklus visuell folgenlos und
  // verwirrend. UI versteckt den Logout-Link im Dev-Mode ohnehin; manuelle URL-
  // Aufrufe landen einfach wieder auf `/`.
  if (process.env.LOCAL_DEV_MODE === 'true') {
    return res.redirect('/');
  }
  const email = req.session.user?.email;
  const loginAt = req.session.loginAt;
  const accept = String(req.headers['accept-language'] || '').toLowerCase();
  const lang = accept.startsWith('en') ? 'en' : 'de';
  const ip = _clientIp(req);
  const userAgent = req.headers['user-agent'] || null;
  if (email) {
    appUsers.recordAuditEvent(email, 'logout', { ip, userAgent });
  }
  req.session.destroy(() => {
    if (email) {
      const durMin = loginAt ? Math.round((Date.now() - loginAt) / 60000) : null;
      logger.info(`Logout${durMin != null ? ` (Session ${durMin} min)` : ''}`, { user: email });
    }
    // Session-Cookie aus dem Browser raeumen — `destroy()` loescht nur Server-State,
    // Browser haelt `connect.sid` sonst weiter und schickt ihn beim naechsten Request mit.
    res.clearCookie('connect.sid', { path: '/', httpOnly: true, sameSite: 'lax', secure: req.secure });
    // LOCAL_DEV_MODE: Guard legt sonst sofort wieder eine Dev-Session an. Marker
    // sperrt das, bis der User aktiv /auth/login aufruft (1 Tag genuegt fuer Tests).
    if (process.env.LOCAL_DEV_MODE === 'true') {
      res.cookie('sw_devout', '1', { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 24 * 60 * 60 * 1000 });
    }
    const title = tServer('auth.logout.title', lang);
    const body = tServer('auth.logout.body', lang);
    const cta = tServer('auth.logout.cta', lang);
    res.set('Cache-Control', 'no-store');
    res.send(_renderPublicShell({
      lang,
      title,
      mainHtml: `<main class="public-shell">
  <header class="public-header">
    <h1>${title}</h1>
    <p class="public-sub">${body}</p>
  </header>
  <section class="public-actions">
    <a class="public-btn public-btn--primary" href="/login">${cta}</a>
  </section>
</main>`,
    }));
  });
});

// GET /auth/avatar → Same-Origin-Proxy für das Google-Profilbild des
// eingeloggten Users. Browser-Tracking-Prevention blockiert den Direktzugriff
// auf lh3.googleusercontent.com (v.a. in Firmennetzen); der Server holt das
// Bild selbst und cached es. Liefert 404 ohne Session/Bild → Frontend fällt
// im `@error`-Handler auf die Initialen-Bubble zurück.
router.get('/auth/avatar', async (req, res) => {
  const url = req.session?.user?.picture;
  if (!url || !avatarCache.isAllowedAvatarUrl(url)) {
    return res.status(404).end();
  }
  try {
    const { buffer, contentType } = await avatarCache.getAvatar(url);
    // private: nur Browser-Cache, keine Shared-Caches (Bild ist user-spezifisch).
    // Der `?v=`-Hash in der /config-URL bricht den Cache, wenn Google rotiert.
    res.set('Cache-Control', 'private, max-age=86400');
    res.set('Content-Type', contentType);
    res.send(buffer);
  } catch (err) {
    logger.warn('Avatar-Proxy fehlgeschlagen: ' + err.message, { user: sessionEmail(req) });
    res.status(404).end();
  }
});

module.exports = router;
