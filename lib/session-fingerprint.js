// Sitzungs-Fingerprint als JS-lesbares Cookie.
//
// WARUM ES DAS BRAUCHT: Der Service Worker liefert `/content/*` und `/config`
// als Stale-While-Revalidate aus, und geleert wird der CONTENT_CACHE einzig
// vom `auth-logout`-Griff der SPA (public/js/app/app-chrome.js#logout). Der
// setzt zwei Dinge voraus, die eine echte Anmeldung selten mitbringt: dass der
// User den Logout-Link IN der App geklickt hat und dass dabei ein SW die Seite
// kontrolliert. Eine abgelaufene Session, ein geschlossener Browser oder ein
// Login direkt von der Login-Seite lassen den alten Cache also stehen — der
// erste Render nach dem Anmelden kommt dann aus einer beliebig alten Kopie.
//
// Der Client kann das nicht selbst feststellen: die E-Mail unterscheidet zwei
// Sitzungen DESSELBEN Users nicht, und `/config` (wo sie steht) ist selbst
// gecacht. `req.session.loginAt` ist die Antwort, muss den Browser aber
// UNGECACHT erreichen — darum ein Cookie und kein Antwortfeld. Die
// SPA-Navigation auf `/` wird cache-only aus dem SHELL_CACHE bedient und
// erreicht den Server gar nicht; gesetzt wird das Cookie deshalb an den
// Login-Antworten selbst (die laufen ueber `/auth/`, nie gecacht) plus als
// Rueckfall in der Aktivitaets-Middleware.
//
// Der Wert ist ein Hash, kein Klartext: er liegt fuer JS offen (das ist sein
// Zweck) und soll darum nichts aussagen, was nicht schon im Browser steht.
// Kein Ersatz fuer das Session-Cookie — er authentifiziert nichts.
const crypto = require('crypto');

const SESSION_FP_COOKIE = 'sw_sess';

function sessionFingerprint(email, loginAt) {
  if (!email || !loginAt) return null;
  return crypto.createHash('sha256')
    .update(String(email) + '|' + String(loginAt))
    .digest('hex')
    .slice(0, 16);
}

function _cookieValue(header, name) {
  const m = new RegExp('(?:^|;\\s*)' + name + '=([^;]*)').exec(header || '');
  return m ? m[1] : null;
}

// Setzt das Cookie nur, wenn es fehlt oder auf eine andere Sitzung zeigt —
// sonst haengte an jeder Antwort ein `Set-Cookie` ohne Neuigkeitswert.
// `httpOnly: false` ist Absicht und der ganze Punkt: die SPA MUSS den Wert
// lesen koennen. Rueckgabe: der aktuelle Fingerprint (oder null ohne Session).
function setSessionFingerprintCookie(req, res) {
  // Token-Sessions (Device-/API-Token, `via` gesetzt) bekommen keins: sie
  // gehoeren keinem Browser-Cache, und ihr `loginAt` entsteht pro Request neu —
  // das haenge sonst an jede Antwort der nativen Clients ein Set-Cookie.
  if (req.session?.user?.via) return null;
  const email = req.session?.user?.email;
  const loginAt = req.session?.loginAt;
  const fp = sessionFingerprint(email, loginAt);
  if (!fp) return null;
  if (_cookieValue(req.headers?.cookie, SESSION_FP_COOKIE) === fp) return fp;
  res.cookie(SESSION_FP_COOKIE, fp, {
    maxAge: 7 * 24 * 60 * 60 * 1000, // gleiche Lebensdauer wie das Session-Cookie
    httpOnly: false,
    secure: req.secure === true,
    sameSite: 'lax',
    path: '/',
  });
  return fp;
}

module.exports = { SESSION_FP_COOKIE, sessionFingerprint, setSessionFingerprintCookie };
