'use strict';
// Scope-Gate fuer Device-Tokens (`swd_…`).
//
// `device_tokens.scopes` ist bis zu dieser Schicht ein Etikett ohne Wirkung:
// tryDeviceAuth (lib/device-auth.js) reicht den Wert nur durch, geprueft hat ihn
// niemand. Fuer die nativen Clients (macOS/Android) ist genau das richtig — sie
// bearbeiten das Manuskript und brauchen die vollen Rechte ihres Users. Fuer
// eine Browser-Erweiterung nicht: die lebt in fremden Tabs, und ein dort
// entwendetes Token darf nicht das ganze Buch ueberschreiben koennen.
//
// Modell mit Bestandsschutz:
//   content:write   Unbeschraenkter Geraete-Scope. UNGEGATED — jedes bereits
//                   ausgestellte Client-Token traegt ihn (DEFAULT_SCOPES) und
//                   arbeitet unveraendert weiter.
//   capture:write   Erfassungs-Scope. Traegt ein Token ihn ohne content:write,
//                   gilt die Allowlist unten; alles andere endet in 403.
//   sonst           Kein Zugriff. Deny-by-default fuer den Fall, dass jemand
//                   spaeter einen dritten Scope einfuehrt und dieses Modul
//                   dabei vergisst — die restriktive Richtung ist die richtige.
//
// Die Allowlist ist bewusst eng und explizit statt als Praefix-Muster: sie ist
// die Antwort auf die Frage „was darf eine Erweiterung", und die soll man in
// einer Liste lesen koennen, nicht aus Regex-Ueberdeckungen ableiten muessen.

const logger = require('../logger');

const READ_SCOPE = 'content:read';
const FULL_SCOPE = 'content:write';
const CAPTURE_SCOPE = 'capture:write';

// Ausstellbare Scope-Saetze. Der Client waehlt eine `kind`, keinen Freitext-
// Scope-String — sonst wandert die Scope-Grammatik in den Request-Body und jeder
// Tippfehler erzeugt lautlos ein Token, das nichts darf.
const TOKEN_KINDS = {
  device: `${READ_SCOPE},${FULL_SCOPE}`,
  capture: `${READ_SCOPE},${CAPTURE_SCOPE}`,
};
const DEFAULT_KIND = 'device';

// Was ein capture:write-Token darf. Lesen: die Buchliste (Buchwahl im Popup),
// die eigenen Fundstuecke/Quellen (Dublettenanzeige), der Register-Lookup.
// Schreiben: Fundstuecke, Quellen, Zuordnungen, Anhaenge — und der eine
// transaktionale Sammel-Endpunkt /capture.
//
// Nicht enthalten und damit verboten: alles unter /content/books/:id/pages*
// (Manuskript), /book-editor/*, /me/* (kein Self-Minting weiterer Tokens),
// /admin/*, /jobs/* (keine KI-Kosten auf Zuruf) und jedes DELETE.
const CAPTURE_ALLOW = [
  ['GET', /^\/content\/books$/],
  ['GET', /^\/research$/],
  ['GET', /^\/research\/tags$/],
  ['POST', /^\/research$/],
  ['POST', /^\/research\/\d+\/(?:image|doc)$/],
  ['GET', /^\/sources$/],
  ['GET', /^\/sources\/(?:pool|stats|lookup|by-url)$/],
  ['POST', /^\/sources$/],
  // `pdf` und `doc` beide: der Anhang-Endpunkt der Quellen traegt historisch
  // beide Namen. Ein Name zu viel in der Allowlist kostet nichts (der Router
  // antwortet 404), ein fehlender kostet ein 403, das der Client nicht erklaeren
  // kann. Wer hier umbenennt, prueft diese Liste.
  ['POST', /^\/sources\/\d+\/(?:link|pdf|doc)$/],
  ['POST', /^\/capture$/],
];

function _scopeList(scopesStr) {
  if (!scopesStr) return [];
  return String(scopesStr).split(',').map(s => s.trim()).filter(Boolean);
}

/** 'full' | 'capture' | 'none' — welche Stufe traegt dieses Token? */
function scopeMode(scopesStr) {
  const list = _scopeList(scopesStr);
  if (list.includes(FULL_SCOPE)) return 'full';
  if (list.includes(CAPTURE_SCOPE)) return 'capture';
  return 'none';
}

// Express matcht Routen per Default case-INSENSITIV (`case sensitive routing`
// ist aus) und akzeptiert einen Trailing-Slash. Die Allowlist muss beide
// Schreibweisen erfassen, sonst laeuft `/SOURCES/` am Gate vorbei in den Router.
function _normPath(path) {
  let p = String(path || '').toLowerCase();
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/** Pure Entscheidung — Testgegenstand von tests/unit/device-scopes.test.js. */
function isDeviceRequestAllowed({ scopes, method, path }) {
  const mode = scopeMode(scopes);
  if (mode === 'full') return true;
  if (mode === 'none') return false;
  const m = String(method || '').toUpperCase();
  const p = _normPath(path);
  return CAPTURE_ALLOW.some(([am, re]) => am === m && re.test(p));
}

/** Scope-String zu einer Token-Art. Unbekannte Art → DEFAULT_KIND. */
function scopesForKind(kind) {
  return TOKEN_KINDS[String(kind || '').trim()] || TOKEN_KINDS[DEFAULT_KIND];
}

// Middleware: laeuft NACH dem Auth-Guard, greift nur bei Device-Token-Requests.
// Session-Requests (Browser) und api_token-Requests (/metrics) passieren
// unberuehrt — die haben ihr eigenes Rechtemodell.
function deviceScopeGate(req, res, next) {
  const u = req.session?.user;
  if (!u || u.via !== 'device_token') return next();
  if (isDeviceRequestAllowed({ scopes: u.scopes, method: req.method, path: req.path })) return next();
  logger.warn(`Device-Scope verweigert: ${req.method} ${req.path} (token=${u.tokenId || '?'}, scopes=${u.scopes || '-'})`);
  return res.status(403).json({ error_code: 'DEVICE_SCOPE_FORBIDDEN' });
}

module.exports = {
  READ_SCOPE,
  FULL_SCOPE,
  CAPTURE_SCOPE,
  TOKEN_KINDS,
  DEFAULT_KIND,
  CAPTURE_ALLOW,
  scopeMode,
  scopesForKind,
  isDeviceRequestAllowed,
  deviceScopeGate,
};
