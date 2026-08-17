'use strict';
// Public-Landing + Register.
//
// Routen (alle vor dem Auth-Guard in server.js gemountet):
//   GET  /              — eingeloggt → next(), unauth → landing.html
//   GET  /landing       — immer landing.html
//   GET  /register      — Formular (kein Session-Zwang)
//   POST /register      — Anfrage anlegen + Admin-Mail (Rate-Limit + optional Captcha)
//   GET  /datenschutz    — öffentliche Datenschutzerklärung (kein Session-Zwang)
//   GET  /privacy        — englischer Alias auf dieselbe Seite (Sprache via Accept-Language)
//   GET  /robots.txt     — Crawler-Regeln (dynamisch, siehe `seo.indexable`)
//   GET  /sitemap.xml    — die zwei indexierbaren Seiten (nur mit `app.public_url`)
//
// SEO: indexierbar sind ausschliesslich Landing und Datenschutz. Register- und
// Login-Seite tragen ihr `noindex` fest im Markup (Funnel-Schritte, kein Inhalt),
// geteilte Inhalte zusaetzlich einen X-Robots-Tag-Header (routes/share.js).
// Die Instanz als Ganzes laesst sich ueber `seo.indexable` aus dem Index nehmen.
//
// Anti-User-Enumeration: POST /register liefert IMMER 202 mit derselben
// Erfolgsmeldung, egal ob Email schon existiert, bereits pending ist oder
// neu angelegt wurde. Doppel-Anfragen werden via Partial-UNIQUE-Index
// vom DB-Layer abgefangen — Caller schluckt die SQLITE_CONSTRAINT-Exception.

const path = require('path');
const fs = require('fs');
const express = require('express');
const logger = require('../logger');
const appSettings = require('../lib/app-settings');
const appUsers = require('../db/app-users');
const regRequests = require('../db/registration-requests');
const mailer = require('../lib/mailer');
const rateLimit = require('../lib/register-ratelimit');
const altcha = require('../lib/altcha');
const extensionRelease = require('../lib/extension-release');
const macclientRelease = require('../lib/macclient-release');
const { tServer } = require('../lib/i18n-server');

const router = express.Router();

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const _templateCache = new Map();
function _loadTemplate(name) {
  if (process.env.NODE_ENV !== 'production' || !_templateCache.has(name)) {
    _templateCache.set(name, fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8'));
  }
  return _templateCache.get(name);
}

// Mini-Template-Substitution: {{key}} → vars[key]. Werte werden HTML-escaped,
// ausser sie enden auf "Json" (dann roher JSON-Stream fuer Inline-Skript).
// Konditionale Bloecke: {{#if flag}}…{{/if}} bleiben nur, wenn vars[flag] truthy ist.
const _escHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function _render(name, vars) {
  const tpl = _loadTemplate(name)
    .replace(/\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, flag, body) => (vars[flag] ? body : ''));
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const raw = vars[key];
    if (raw === undefined || raw === null) return '';
    if (key.endsWith('Json')) return String(raw); // bereits JSON.stringify
    return _escHtml(raw);
  });
}

function _bodyLang(req) {
  const accept = String(req.headers['accept-language'] || '').toLowerCase();
  return accept.startsWith('en') ? 'en' : 'de';
}

// Darf diese Instanz indexiert werden? Zusaetzlich zum Admin-Flag zaehlt eine
// gesetzte oeffentliche Basis-URL: ohne sie gibt es keine kanonische Adresse,
// unter der eine Indexierung ueberhaupt sinnvoll waere.
function _seoIndexable() {
  return !!appSettings.get('seo.indexable') && !!_publicUrl();
}

function _publicUrl() {
  return String(appSettings.get('app.public_url') || '').replace(/\/$/, '');
}

function _clientIp(req) {
  // Nur req.ip (aufgeloest via `trust proxy`-Hop). Client-supplied X-Forwarded-For
  // ist spoofbar und darf fuer Rate-Limit-/Anti-Abuse-Keys nicht verwendet werden.
  return req.ip || null;
}

function _renderLanding(req, res) {
  const lang = _bodyLang(req);
  const t = (key) => tServer(key, lang);
  const appName = appSettings.get('app.name') || 'Schreibwerkstatt';
  res.set('Cache-Control', 'no-store');
  res.type('html').send(_render('landing.html', {
    lang,
    noindex:       !_seoIndexable(),
    canonical:     _seoIndexable() ? `${_publicUrl()}/` : '',
    title:         appName,
    appName,
    subtitle:      t('landing.subtitle'),
    loginLabel:    t('landing.loginLabel'),
    registerLabel: t('landing.registerLabel'),
    footer:        t('landing.footer'),
    githubUrl:     'https://github.com/bedeberger/schreibwerkstatt',
    githubLabel:   t('landing.githubLabel'),
    privacyLabel:  t('privacy.footerLink'),
    featuresTitle: t('landing.featuresTitle'),
    feat1Title:    t('landing.feat1Title'), feat1Desc: t('landing.feat1Desc'),
    feat2Title:    t('landing.feat2Title'), feat2Desc: t('landing.feat2Desc'),
    feat3Title:    t('landing.feat3Title'), feat3Desc: t('landing.feat3Desc'),
    feat4Title:    t('landing.feat4Title'), feat4Desc: t('landing.feat4Desc'),
    feat5Title:    t('landing.feat5Title'), feat5Desc: t('landing.feat5Desc'),
    feat6Title:    t('landing.feat6Title'), feat6Desc: t('landing.feat6Desc'),
    feat7Title:    t('landing.feat7Title'), feat7Desc: t('landing.feat7Desc'),
    feat8Title:    t('landing.feat8Title'), feat8Desc: t('landing.feat8Desc'),
    feat9Title:    t('landing.feat9Title'), feat9Desc: t('landing.feat9Desc'),
    macTitle:      t('landing.macTitle'),
    macDesc:       t('landing.macDesc'),
    macLinkLabel:  t('landing.macLinkLabel'),
    macUrl:        macclientRelease.MAC_APP_STORE_URL,
    androidTitle:     t('landing.androidTitle'),
    androidDesc:      t('landing.androidDesc'),
    androidLinkLabel: t('landing.androidLinkLabel'),
    androidUrl:       'https://github.com/bedeberger/schreibwerkstatt-mobile/releases/latest',
    extensionTitle:     t('landing.extensionTitle'),
    extensionDesc:      t('landing.extensionDesc'),
    extensionLinkLabel: t('landing.extensionLinkLabel'),
    extensionUrl:       extensionRelease.CHROME_STORE_URL,
  }));
}

function _renderRegister(req, res) {
  const lang = _bodyLang(req);
  const t = (key) => tServer(key, lang);
  res.set('Cache-Control', 'no-store');
  const config = {
    altchaEnabled: altcha.isEnabled(),
    i18n: {
      success:   t('register.success'),
      rateLimit: t('register.rateLimit'),
      invalid:   t('register.invalid'),
      error:     t('register.error'),
    },
  };
  res.type('html').send(_render('register.html', {
    lang,
    title:          t('register.title'),
    subtitle:       t('register.subtitle'),
    emailLabel:     t('register.emailLabel'),
    nameLabel:      t('register.nameLabel'),
    messageLabel:   t('register.messageLabel'),
    submitLabel:    t('register.submitLabel'),
    backToLanding:  t('register.backToLanding'),
    footerHint:     t('register.footer'),
    privacyLabel:   t('privacy.footerLink'),
    configJson:     JSON.stringify(config).replace(/</g, '\\u003c'),
  }));
}

// Öffentliche Datenschutzerklärung. Statisches Template mit i18n-Substitution,
// kein Session-Zwang — verlinkt u.a. aus dem nativen macOS-Client und für die
// Apple-App-Store-Einreichung erreichbar. Sprache via Accept-Language.
function _renderPrivacy(req, res) {
  const lang = _bodyLang(req);
  const t = (key) => tServer(key, lang);
  const appName = appSettings.get('app.name') || 'Schreibwerkstatt';
  const analyticsEnabled = !!appSettings.get('analytics.plausible.enabled');
  res.set('Cache-Control', 'no-store');
  res.type('html').send(_render('datenschutz.html', {
    lang,
    noindex:       !_seoIndexable(),
    // /privacy ist ein Alias derselben Seite — beide zeigen auf /datenschutz,
    // sonst konkurrieren zwei URLs mit identischem Inhalt um dieselbe Position.
    canonical:     _seoIndexable() ? `${_publicUrl()}/datenschutz` : '',
    appName,
    analyticsEnabled,
    pageTitle:     t('privacy.title'),
    lastUpdated:   t('privacy.lastUpdated'),
    intro:         t('privacy.intro'),
    sec1Title:     t('privacy.sec1Title'),  sec1Body:  t('privacy.sec1Body'),
    sec2Title:     t('privacy.sec2Title'),  sec2Intro: t('privacy.sec2Intro'),
    sec2ItemA:     t('privacy.sec2ItemA'),  sec2ItemB: t('privacy.sec2ItemB'),
    sec2ItemC:     t('privacy.sec2ItemC'),  sec2ItemD: t('privacy.sec2ItemD'),
    sec3Title:     t('privacy.sec3Title'),  sec3Body:  t('privacy.sec3Body'),
    sec4Title:     t('privacy.sec4Title'),  sec4Body:  t('privacy.sec4Body'),
    secAiTitle:    t('privacy.secAiTitle'), secAiBody: t('privacy.secAiBody'),
    sec5Title:     t('privacy.sec5Title'),  sec5Body:  t('privacy.sec5Body'),
    sec6Title:     t('privacy.sec6Title'),  sec6Body:  t('privacy.sec6Body'),
    sec7Title:     t('privacy.sec7Title'),  sec7Body:  t('privacy.sec7Body'),
    sec8Title:     t('privacy.sec8Title'),
    sec8Body:      analyticsEnabled ? t('privacy.sec8BodyAnalytics') : t('privacy.sec8Body'),
    secAnalyticsTitle: t('privacy.secAnalyticsTitle'), secAnalyticsBody: t('privacy.secAnalyticsBody'),
    sec9Title:     t('privacy.sec9Title'),  sec9Body:  t('privacy.sec9Body'),
    backToLanding: t('privacy.backToLanding'),
  }));
}

// GET / — unauth → landing, eingeloggt → next() (SPA-Shell wird vom
// nachfolgenden staticServe in server.js geliefert).
router.get('/', (req, res, next) => {
  if (req.session?.user) return next();
  if (process.env.LOCAL_DEV_MODE === 'true') return next();
  return _renderLanding(req, res);
});

// robots.txt — dynamisch, weil die Sitemap-Zeile die konfigurierte Basis-URL
// braucht und Nebeninstanzen (Demo/Staging) sich per `seo.indexable` komplett
// sperren koennen. Bewusst KEIN Disallow fuer /share, /register oder /login:
// diese Seiten sagen selbst „noindex", und ein Disallow wuerde den Crawler
// daran hindern, das zu lesen — die URL kaeme dann ohne Inhalt in den Index
// statt gar nicht. Sperren heisst hier: crawlen lassen und noindex ausliefern.
router.get('/robots.txt', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  if (!_seoIndexable()) {
    return res.type('text/plain').send('User-agent: *\nDisallow: /\n');
  }
  res.type('text/plain').send(
    `User-agent: *\nAllow: /\n\nSitemap: ${_publicUrl()}/sitemap.xml\n`
  );
});

// sitemap.xml — nur die beiden Seiten, die ueberhaupt indexiert werden sollen.
// /privacy fehlt absichtlich (Alias von /datenschutz, siehe canonical dort).
router.get('/sitemap.xml', (req, res) => {
  if (!_seoIndexable()) return res.status(404).type('text/plain').send('Not found');
  const base = _publicUrl();
  const urls = ['/', '/datenschutz']
    .map(p => `  <url><loc>${_escHtml(base + p)}</loc></url>`)
    .join('\n');
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
  );
});

router.get('/landing', _renderLanding);
router.get('/register', _renderRegister);
router.get('/datenschutz', _renderPrivacy);
router.get('/privacy', _renderPrivacy); // englischer Alias — eine Seite, Sprache via _bodyLang

// ALTCHA-Challenge fuer Register- + Admin-Login-Widget (kein Auth-Zwang, vor
// dem Guard gemountet). Liefert eine frische signierte Challenge; 503 wenn
// ALTCHA aus ist (das Widget wird dann gar nicht erst geladen).
router.get('/altcha/challenge', async (req, res) => {
  if (!altcha.isEnabled()) return res.status(503).json({ error_code: 'ALTCHA_DISABLED' });
  res.set('Cache-Control', 'no-store');
  try {
    res.json(await altcha.createPowChallenge());
  } catch (e) {
    logger.warn(`ALTCHA challenge failed: ${e.message}`);
    res.status(500).json({ error_code: 'ALTCHA_CHALLENGE_FAILED' });
  }
});

const _emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/register', express.json({ limit: '8kb' }), async (req, res) => {
  const ip = _clientIp(req);
  const userAgent = req.headers['user-agent'] || null;
  const limit = rateLimit.check(ip);
  if (!limit.allowed) {
    res.set('Retry-After', String(limit.retryAfterSec));
    return res.status(429).json({ error_code: 'RATE_LIMITED', retryAfter: limit.retryAfterSec });
  }

  const { email, displayName, message, altcha: altchaSolution } = req.body || {};
  const e = String(email || '').trim().toLowerCase();
  if (!e || !_emailRegex.test(e) || e.length > 320) {
    rateLimit.record(ip); // Fehlversuch zaehlt — sonst freier Spam-Probe
    return res.status(400).json({ error_code: 'EMAIL_INVALID' });
  }

  const captcha = await altcha.verify(altchaSolution);
  if (!captcha.ok) {
    rateLimit.record(ip);
    return res.status(400).json({ error_code: 'CAPTCHA_FAILED' });
  }

  const nameTrim = String(displayName || '').trim().slice(0, 120) || null;
  const msgTrim  = String(message || '').trim().slice(0, 500) || null;

  let created = null;
  try {
    created = regRequests.createRequest({ email: e, displayName: nameTrim, message: msgTrim, ip, userAgent });
  } catch (err) {
    // SQLITE_CONSTRAINT (Partial-UNIQUE pending): bestehende pending-Anfrage —
    // antworten als waere alles ok, kein Leak.
    if (!String(err.message || '').includes('UNIQUE')) {
      logger.warn(`registration_requests insert failed: ${err.message}`);
    }
  } finally {
    rateLimit.record(ip);
  }

  if (created) {
    logger.info(`registration-request eingegangen: ${e} (ip=${ip || '-'})`);
    // Admin-Mail (best effort): an alle active admin-User. Mailer skipt
    // selbst, wenn Gmail-Credentials fehlen.
    try {
      const admins = appUsers.listUsers().filter(u => u.global_role === 'admin' && u.status === 'active');
      const adminUrl = (appSettings.get('app.public_url') || '').replace(/\/$/, '') + '/#admin-users';
      for (const a of admins) {
        mailer.send({
          to: a.email,
          template: 'registration-request-admin',
          locale: a.language || 'de',
          ctx: {
            email: e,
            displayName: nameTrim || '',
            ip: ip || '',
            createdAt: created.created_at,
            adminUrl,
            message: msgTrim || '',
          },
        }).catch(err => logger.warn(`admin-notify failed: ${err.message}`));
      }
    } catch (err) {
      logger.warn(`admin-notify lookup failed: ${err.message}`);
    }
  }

  return res.status(202).json({ ok: true });
});

module.exports = router;
