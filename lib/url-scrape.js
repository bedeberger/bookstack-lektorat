'use strict';
// Serverseitiges Lesen einer Webseite: URL holen, Titel/Beschreibung/Haupttext
// extrahieren. Speist „Link scrapen" am Recherche-Fundstueck
// (POST /research/:id/scrape).
//
// Warum es das ueberhaupt gibt, obwohl die Browser-Erweiterung dasselbe tut:
// die Erweiterung liest das GERENDERTE Dokument im Tab des Users und ist damit
// die bessere Quelle (Login-Sitzung, ausgefuehrtes JavaScript, Paywall-Umfeld).
// Sie ist aber nur da, wo ein Chrome mit Erweiterung offen ist. Wird ein Link
// aus der Android-App geteilt, kommt genau eine URL an und das Fundstueck bleibt
// ein leerer Zettel — unauffindbar in Volltextsuche und Semantik-Index, weil es
// keinen Text hat. Dieses Modul holt das Nachtraeglich-Erreichbare.
//
// Es ist ausdruecklich das SCHLECHTERE der beiden Verfahren: kein JavaScript,
// keine Sitzung. Wer eine Seite bekommt, die ihren Text erst im Browser
// zusammensetzt, bekommt hier wenig oder nichts — dann ist die Erweiterung der
// Weg. Darum wird nie geraten und nie interpretiert: kein callAI, keine
// Zusammenfassung, keine Ableitung. Was hier zurueckkommt, steht im Dokument.
//
// SSRF: die URL stammt vom User (er hat sie ins Fundstueck geschrieben). Damit
// gilt die harte Regel — assertPublicUrl pro Hop, Timeout, Byte-Deckel
// (Muster lib/pdf-render/images.js#_fetchRemote).

const { parseHTML } = require('linkedom');
const { assertPublicUrl } = require('./ssrf-guard');

const FETCH_TIMEOUT_MS = 12_000;
// Ein HTML-Dokument, das mehr als das waere, traegt seinen Text nicht im
// Markup. Der Deckel greift VOR dem Parsen — linkedom baut sonst einen
// vollstaendigen DOM-Baum aus einer beliebig grossen Antwort auf.
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;

// Nur Text-Dokumente. Ein PDF hinter der URL ist kein Fehler des Users, aber
// auch nicht unser Weg: dafuer gibt es den PDF-Upload am Fundstueck, der den
// Volltext ueber lib/pdf-extract.js zieht.
const HTML_TYPE_RE = /^(?:text\/html|application\/xhtml\+xml|text\/plain)\b/i;

// Elemente, deren Textinhalt nie Seiteninhalt ist. `nav`/`header`/`footer`/
// `aside` fliegen bewusst mit raus: sie tragen Navigation und Rechtstexte, die
// sonst in JEDEM Fundstueck derselben Website wortgleich stehen und im
// Semantik-Index als Aehnlichkeit zwischen unverwandten Funden auftauchen.
const DROP_SEL = [
  'script', 'style', 'noscript', 'template', 'svg', 'iframe', 'object', 'embed',
  'form', 'button', 'select', 'textarea',
  'nav', 'header', 'footer', 'aside',
  '[aria-hidden="true"]', '[hidden]',
].join(',');

// Kandidaten fuer den Haupttext, in der Reihenfolge ihrer Aussagekraft. Die
// Reihenfolge entscheidet ZWISCHEN den Selektoren, die Laenge nur INNERHALB
// eines: `<main>` ist auf vielen Seiten eine Layout-Huelle, die den `<article>`
// samt Werbe- und Teaser-Bloecken umfasst und darum laenger ist, ohne besser zu
// sein. Umgekehrt gibt es Seiten mit mehreren `<article>` (Kartenliste einer
// Uebersichtsseite) — dort gewinnt der laengste.
const MAIN_SEL = ['article', 'main', '[role="main"]', '#content', '.entry-content', '.post-content'];

// Ab wann ein Kandidat als Haupttext durchgeht. Darunter gilt er als Huelle
// (ein `<main>`, das nur eine Bildunterschrift enthaelt) und der naechste
// Selektor kommt zum Zug, am Ende der ganze Body.
const MIN_MAIN_CHARS = 200;

// Grenzen, an denen der Text umbrechen muss. Ohne das klebt der ganze Artikel
// zu einer Zeile zusammen — im Detail-Dialog unlesbar, und der Chunker des
// Semantik-Index findet keine Grenzen. Zwei Staerken, weil der Unterschied im
// Ergebnis sichtbar ist: ein Absatz steht mit Leerzeile, eine Listenzeile
// direkt unter ihrer Vorgaengerin.
const HARD_SEL = 'p,div,h1,h2,h3,h4,h5,h6,blockquote,pre,section,article,figcaption,hr,table,ul,ol,dl';
const SOFT_SEL = 'li,tr,td,th,dt,dd,br';

// Marker statt direkter Umbrueche: zwei benachbarte Blockgrenzen (`</p><p>`)
// sollen EINEN Absatzabstand ergeben, nicht zwei. Mit rohen Umbruechen laesst
// sich das hinterher nicht mehr unterscheiden — ein Run aus Markern wird zum
// staerksten Umbruch, den er enthaelt.
const HARD_MARK = '\u0000';
const SOFT_MARK = '\u0001';

function _err(code, msg) {
  const e = new Error(msg || code);
  e.code = code;
  return e;
}

/** Antwort-Body als Text lesen, mit Byte-Deckel.
 *
 *  `content-length` wird zuerst geprueft (billiger Abbruch), ist aber nicht
 *  vertrauenswuerdig — darum zaehlt der Stream-Zweig mit. Der arrayBuffer-Zweig
 *  greift, wenn kein Async-Iterator anfaellt (gestubbter fetch im Test). */
async function _readCapped(res) {
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BYTES) throw _err('SCRAPE_TOO_LARGE');
  if (!res.body || typeof res.body[Symbol.asyncIterator] !== 'function') {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw _err('SCRAPE_TOO_LARGE');
    return buf;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > MAX_BYTES) throw _err('SCRAPE_TOO_LARGE');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// Zeichensatz aus dem content-type — sonst wird eine latin1-Seite zu
// Fragezeichen. `<meta charset>` im Dokument bleibt unbeachtet: es steht im
// Body, den wir zum Lesen schon dekodiert haben muessen.
function _decode(buf, contentType) {
  const m = /charset=["']?([\w-]+)/i.exec(contentType || '');
  const cs = (m?.[1] || 'utf-8').toLowerCase();
  const alias = cs === 'iso-8859-1' || cs === 'windows-1252' ? 'latin1' : cs;
  try { return new TextDecoder(alias).decode(buf); }
  catch { return buf.toString('utf8'); }
}

/**
 * Dokument holen. Redirects von Hand verfolgen, weil JEDER Hop geprueft werden
 * muss: ein oeffentlicher Host, der auf 127.0.0.1 umleitet, ist genau der Weg,
 * den ein Einmal-Check am Anfang durchlaesst.
 *
 * Wirft mit `code`: SSRF_* (aus dem Guard), SCRAPE_TIMEOUT, SCRAPE_TOO_LARGE,
 * SCRAPE_HTTP_ERROR, SCRAPE_NOT_HTML, SCRAPE_UNAVAILABLE.
 */
async function fetchDocument(rawUrl) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, FETCH_TIMEOUT_MS);
  try {
    let url = String(rawUrl);
    for (let hop = 0; ; hop++) {
      await assertPublicUrl(url);
      let res;
      try {
        res = await fetch(url, {
          redirect: 'manual',
          signal: ctrl.signal,
          headers: {
            // Ein Standard-Browser-UA: viele Seiten liefern einem unbekannten
            // Client eine Sperrseite statt des Artikels. Das ist keine
            // Umgehung eines Schutzes, sondern die Bitte um die Fassung, die
            // der User im eigenen Browser ohnehin sieht.
            'user-agent': 'Mozilla/5.0 (compatible; Schreibwerkstatt/1.0; +https://github.com/)',
            accept: 'text/html,application/xhtml+xml',
            'accept-language': 'de,en;q=0.8',
          },
        });
      } catch (e) {
        // Timeout und User-Abbruch kommen beide als AbortError an — nur das
        // Flag trennt sie, und nur der Timeout ist eine Aussage ueber das Ziel.
        if (timedOut) throw _err('SCRAPE_TIMEOUT');
        throw _err('SCRAPE_UNAVAILABLE', e.message);
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers?.get?.('location');
        if (!loc || hop >= MAX_REDIRECTS) throw _err('SCRAPE_HTTP_ERROR', `redirect ${res.status}`);
        url = new URL(loc, url).toString();
        continue;
      }
      if (!res.ok) {
        const e = _err('SCRAPE_HTTP_ERROR', `HTTP ${res.status}`);
        e.status = res.status;
        throw e;
      }
      const ct = res.headers?.get?.('content-type') || '';
      if (ct && !HTML_TYPE_RE.test(ct)) throw _err('SCRAPE_NOT_HTML', ct);
      const buf = await _readCapped(res);
      return { html: _decode(buf, ct), finalUrl: url, contentType: ct };
    }
  } finally {
    clearTimeout(timer);
  }
}

function _meta(document, names, attr = 'name') {
  for (const n of names) {
    const el = document.querySelector(`meta[${attr}="${n}"]`);
    const v = (el?.getAttribute('content') || '').trim();
    if (v) return v;
  }
  return '';
}

// Textinhalt eines Elements mit Absatz- und Zeilengrenzen.
function _blockText(root) {
  if (!root) return '';
  const parts = [];
  const walk = (node) => {
    for (const child of node.childNodes || []) {
      if (child.nodeType === 3) { parts.push(child.textContent || ''); continue; }
      if (child.nodeType !== 1) continue;
      const mark = child.matches?.(HARD_SEL) ? HARD_MARK
        : (child.matches?.(SOFT_SEL) ? SOFT_MARK : '');
      if (mark) parts.push(mark);
      walk(child);
      if (mark) parts.push(mark);
    }
  };
  walk(root);
  const RUN = new RegExp(`[ ${HARD_MARK}${SOFT_MARK}]*[${HARD_MARK}${SOFT_MARK}][ ${HARD_MARK}${SOFT_MARK}]*`, 'g');
  return parts.join('')
    .replace(/[\s\u00a0]+/g, ' ')
    // Ein Run aus Markern (samt Leerraum dazwischen) wird zu EINEM Umbruch —
    // Absatz, sobald ein harter darin vorkommt, sonst Zeile.
    .replace(RUN, (run) => (run.includes(HARD_MARK) ? '\n\n' : '\n'))
    .trim();
}

/**
 * Titel, Beschreibung und Haupttext aus einem HTML-Dokument lesen.
 * Reine Funktion (kein Netz) — darum einzeln testbar.
 *
 * `text` ist UNGEDECKELT; das Kappen auf BODY_MAX macht der Aufrufer, weil nur
 * er weiss, in welches Feld es geht und wie er die Kappung ausweist.
 */
function extractFromHtml(html, pageUrl = '') {
  const { document } = parseHTML(String(html || ''));

  const title = _meta(document, ['og:title', 'twitter:title'], 'property')
    || _meta(document, ['og:title', 'twitter:title'])
    || (document.querySelector('title')?.textContent || '').trim()
    || (document.querySelector('h1')?.textContent || '').trim();

  const description = _meta(document, ['og:description', 'twitter:description'], 'property')
    || _meta(document, ['description', 'og:description', 'twitter:description']);

  const siteName = _meta(document, ['og:site_name'], 'property') || _meta(document, ['og:site_name']);
  const lang = (document.querySelector('html')?.getAttribute('lang') || '').trim().slice(0, 35);
  const canonical = (document.querySelector('link[rel="canonical"]')?.getAttribute('href') || '').trim();
  const published = _meta(document, ['article:published_time'], 'property')
    || _meta(document, ['article:published_time', 'date', 'dcterms.date']);

  // Erst entfernen, dann waehlen: sonst gewinnt eine Layout-Huelle, deren
  // Laenge aus Navigation besteht.
  for (const el of document.querySelectorAll(DROP_SEL)) el.remove();

  let best = '';
  for (const sel of MAIN_SEL) {
    let longest = '';
    for (const el of document.querySelectorAll(sel)) {
      const t = _blockText(el);
      if (t.length > longest.length) longest = t;
    }
    if (longest.length > best.length) best = longest;
    // Der erste Selektor, der Substanz liefert, gewinnt — spaetere sind
    // allgemeiner und wuerden nur Umgebung dazuholen.
    if (best.length >= MIN_MAIN_CHARS) break;
  }
  // Kein brauchbarer Kandidat → ganzer Body.
  if (best.length < MIN_MAIN_CHARS) {
    const bodyText = _blockText(document.querySelector('body'));
    if (bodyText.length > best.length) best = bodyText;
  }

  return {
    title: (title || '').replace(/\s+/g, ' ').trim(),
    description: (description || '').replace(/\s+/g, ' ').trim(),
    text: best,
    siteName: (siteName || '').replace(/\s+/g, ' ').trim(),
    lang,
    canonicalUrl: canonical ? _abs(canonical, pageUrl) : '',
    published: (published || '').trim().slice(0, 40),
  };
}

function _abs(href, base) {
  try { return new URL(href, base || undefined).toString(); } catch { return ''; }
}

/** Holen + Extrahieren in einem Schritt. Wirft wie fetchDocument. */
async function scrapeUrl(rawUrl) {
  const { html, finalUrl, contentType } = await fetchDocument(rawUrl);
  // text/plain kommt ohne Markup — als Text durchreichen, nicht durch den
  // DOM-Parser, der daraus einen einzigen Textknoten machen wuerde.
  if (/^text\/plain\b/i.test(contentType)) {
    return {
      title: '', description: '', siteName: '', lang: '', canonicalUrl: '', published: '',
      text: String(html).replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim(),
      finalUrl,
    };
  }
  return { ...extractFromHtml(html, finalUrl), finalUrl };
}

module.exports = {
  scrapeUrl, fetchDocument, extractFromHtml,
  FETCH_TIMEOUT_MS, MAX_BYTES, MAX_REDIRECTS,
};
