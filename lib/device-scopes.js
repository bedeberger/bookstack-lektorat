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
//   capture:write   Erfassungs-Scope. Erlaubt die SCHREIBENDEN Erfassungs-
//                   Endpunkte (CAPTURE_ALLOW).
//   content:read    Lese-Scope. Erlaubt die LESENDEN Endpunkte (READ_ALLOW).
//   sonst           Kein Zugriff. Deny-by-default fuer den Fall, dass jemand
//                   spaeter einen vierten Scope einfuehrt und dieses Modul
//                   dabei vergisst — die restriktive Richtung ist die richtige.
//
// Die beiden Allowlisten sind getrennt, damit Lesen nicht am Schreib-Scope
// haengt: die Erweiterung fragt vor dem Erfassen „kenne ich diese Seite schon",
// und dafuer soll man kein Token brauchen, das auch anlegen darf. Ein Token mit
// `content:read` allein ist damit ein echtes Nur-Lese-Token; die beiden
// ausstellbaren Arten (TOKEN_KINDS) tragen den Lese-Scope ohnehin schon, es
// aendert sich fuer sie nichts.
//
// Beide Listen sind bewusst eng und explizit statt als Praefix-Muster: sie sind
// die Antwort auf die Frage „was darf eine Erweiterung", und die soll man in
// einer Liste lesen koennen, nicht aus Regex-Ueberdeckungen ableiten muessen.
//
// ACHTUNG, KEINE ROUTEN-LISTE: hier steht, was ein Scope DARF — nicht, was es
// gibt. Ein Eintrag ist keine Zusage, dass die Route existiert, und die Muster
// sagen nichts ueber Parameter, Body oder Antwortform. Verbindlich fuer
// Client-Autoren sind die Endpunkte in docs/clients.md (Abschnitt „Dritter
// Client"); wer hier nachschlaegt, prueft dort gegen.

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

// Was ein content:read-Token darf: die Buchliste (Buchwahl im Popup), der
// Bestand an Fundstuecken/Quellen des Buchs (Dublettenpruefung vor dem
// Erfassen, Suche im Warteschlangen-Fenster) und der Register-Lookup.
// Ausschliesslich GET — ein Eintrag mit anderer Methode gehoert hier nicht hin.
const READ_ALLOW = [
  ['GET', /^\/content\/books$/],
  ['GET', /^\/research$/],
  ['GET', /^\/research\/tags$/],
  ['GET', /^\/sources$/],
  ['GET', /^\/sources\/(?:pool|stats|lookup|by-url)$/],
];

// Was ein capture:write-Token zusaetzlich darf: Fundstuecke, Quellen,
// Zuordnungen, Anhaenge — und der eine transaktionale Sammel-Endpunkt /capture.
//
// Nicht enthalten und damit verboten: alles unter /content/books/:id/pages*
// (Manuskript), /book-editor/*, /me/* (kein Self-Minting weiterer Tokens),
// /admin/*, /jobs/* (keine KI-Kosten auf Zuruf) und jedes DELETE.
const CAPTURE_ALLOW = [
  ['POST', /^\/research$/],
  ['POST', /^\/research\/\d+\/(?:image|doc)$/],
  ['POST', /^\/sources$/],
  // Der Anhang-Endpunkt der Quellen heisst `doc` (routes/sources-doc.js) —
  // dieselbe Nomenklatur wie am Recherche-Fundstueck. Ein zusaetzlich gelisteter
  // Aliasname wie `pdf` kostet NICHT nichts: er liest sich wie ein Endpunkt und
  // wird als einer aufgerufen (der Router antwortet dann 404, und der Client
  // sucht den Fehler bei sich). Wer hier umbenennt, prueft diese Liste.
  ['POST', /^\/sources\/\d+\/(?:link|doc)$/],
  ['POST', /^\/capture$/],
];

function _scopeList(scopesStr) {
  if (!scopesStr) return [];
  return String(scopesStr).split(',').map(s => s.trim()).filter(Boolean);
}

/** 'full' | 'capture' | 'read' | 'none' — hoechste Stufe dieses Tokens.
 *  Beschreibend (Logs/Anzeige); die Entscheidung faellt isDeviceRequestAllowed,
 *  weil ein capture-Token seine Lese- UND Schreibrechte aus zwei Scopes zieht. */
function scopeMode(scopesStr) {
  const list = _scopeList(scopesStr);
  if (list.includes(FULL_SCOPE)) return 'full';
  if (list.includes(CAPTURE_SCOPE)) return 'capture';
  if (list.includes(READ_SCOPE)) return 'read';
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

/** Pure Entscheidung — Testgegenstand von tests/unit/device-scopes.test.js.
 *  Die Scopes wirken additiv: content:read oeffnet READ_ALLOW, capture:write
 *  oeffnet CAPTURE_ALLOW, content:write oeffnet alles. */
function isDeviceRequestAllowed({ scopes, method, path }) {
  const list = _scopeList(scopes);
  if (list.includes(FULL_SCOPE)) return true;
  const m = String(method || '').toUpperCase();
  const p = _normPath(path);
  const matches = allow => allow.some(([am, re]) => am === m && re.test(p));
  if (list.includes(READ_SCOPE) && matches(READ_ALLOW)) return true;
  if (list.includes(CAPTURE_SCOPE) && matches(CAPTURE_ALLOW)) return true;
  return false;
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
  READ_ALLOW,
  CAPTURE_ALLOW,
  scopeMode,
  scopesForKind,
  isDeviceRequestAllowed,
  deviceScopeGate,
};
