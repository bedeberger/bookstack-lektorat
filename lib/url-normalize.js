'use strict';
// Pure URL-Normalisierung fuer die Dublettenpruefung der Quellen-Bibliothek und
// des Recherche-Boards.
//
// Zwei Aufrufer muessen bitgleich normalisieren, sonst findet der Lookup die
// Quelle nicht, die der Insert unmittelbar danach als Dublette anlegt:
//   GET  /sources/by-url  („habe ich das schon?")
//   POST /capture         (legt an — oder gibt das Bestehende zurueck)
//
// Bewusst konservativ: normalisiert wird nur, was denselben Inhalt bezeichnet.
// Alles, was den Inhalt aendern KANN, bleibt stehen — eine falsch verschmolzene
// Quelle ist teurer als eine Dublette, weil sie im Verzeichnis eine fremde
// Fundstelle behauptet.

// Parameter, die reine Herkunfts-/Kampagnen-Markierung sind und den Inhalt der
// Seite nie beeinflussen. `ref` steht bewusst NICHT drin: manche Seiten steuern
// darueber tatsaechlich, was ausgeliefert wird.
const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'dclid', 'msclkid', 'yclid', 'twclid', 'igshid',
  'mc_cid', 'mc_eid', 'vero_id', 'vero_conv', '_hsenc', '_hsmi', 'hsctatracking',
  'wt_mc', 'wt_zmc', 'pk_campaign', 'pk_kwd', 'piwik_campaign', 'piwik_kwd',
  'mkt_tok', 's_kwcid', 'ck_subscriber_id', 'oly_anon_id', 'oly_enc_id',
]);

function _isTracking(name) {
  const n = String(name).toLowerCase();
  return n.startsWith('utm_') || TRACKING_PARAMS.has(n);
}

/**
 * Normalisiert eine http(s)-URL fuer den Dublettenvergleich.
 * Gibt `null` zurueck, wenn es keine brauchbare http(s)-URL ist — Aufrufer
 * behandeln das als „nicht vergleichbar", nicht als Fehler.
 */
function normalizeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  // Fragment ist reine Sprungmarke innerhalb desselben Dokuments.
  u.hash = '';
  // Host ist per Definition case-insensitiv; `www.` unterscheidet in der Praxis
  // kein Dokument. Der Pfad bleibt case-sensitiv — dort tut er es sehr wohl.
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  // Standard-Port ist derselbe Ort wie kein Port.
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) {
    u.port = '';
  }
  // http und https derselben Adresse sind dasselbe Dokument — auf https
  // vereinheitlichen, sonst zaehlt ein Redirect als zweite Quelle.
  u.protocol = 'https:';

  for (const name of [...u.searchParams.keys()]) {
    if (_isTracking(name)) u.searchParams.delete(name);
  }
  // Reihenfolge der Query-Parameter traegt keine Bedeutung; sortiert wird nur
  // fuer den Vergleich, die gespeicherte URL bleibt unberuehrt.
  u.searchParams.sort();

  let out = u.toString();
  // `?` ohne Parameter und ein Trailing-Slash am Ende des Pfads sind kein
  // eigenes Dokument. Der Root-Slash bleibt (https://host/ ist die Startseite).
  out = out.replace(/\?$/, '');
  out = out.replace(/^(https:\/\/[^/]+\/[^?#]*?)\/(?=$|\?)/, '$1');
  return out;
}

/** Zwei URLs bezeichnen dasselbe Dokument? Nicht-URLs sind nie gleich. */
function sameUrl(a, b) {
  const na = normalizeUrl(a);
  const nb = normalizeUrl(b);
  return !!na && !!nb && na === nb;
}

module.exports = { normalizeUrl, sameUrl, TRACKING_PARAMS };
