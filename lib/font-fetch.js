'use strict';
// Lädt TTF-Buffers von Google Fonts zur Render-Zeit. Cache via db/fonts.js
// (30-Tage-TTL, Stale-while-revalidate). Eingaben sind whitelisted: nur
// Familien aus FONT_LIST und Weights aus deren `weights`-Array werden
// akzeptiert (verhindert SSRF / beliebige Outbound-Requests).
//
// Implementierung:
//  - Hit `https://fonts.googleapis.com/css?family=...` (CSS-API v1) mit
//    User-Agent, der Server zum TTF-Serving zwingt.
//  - Aus dem CSS regex-extrahieren des passenden TTF-URLs für gewünschten
//    Weight + Style.
//  - Download des TTF-Buffers, in font_cache speichern.
//  - Wenn Fetch fehlschlägt und stale-Cache vorhanden → stale-Buffer zurück.

const { getCachedFont, cacheFont } = require('../db/fonts');
const logger = require('../logger');

// Kuratierte Liste populärer Google-Fonts. Pro Eintrag: Weights + Styles, die
// das Frontend auswählen darf.
const FONT_LIST = [
  // Serif (Body / Heading / Title)
  { family: 'EB Garamond',      category: 'serif', weights: [400, 500, 600, 700], styles: ['normal', 'italic'] },
  { family: 'Lora',             category: 'serif', weights: [400, 500, 600, 700], styles: ['normal', 'italic'] },
  { family: 'Crimson Pro',      category: 'serif', weights: [400, 500, 600, 700, 800], styles: ['normal', 'italic'] },
  { family: 'Source Serif 4',   category: 'serif', weights: [400, 600, 700], styles: ['normal', 'italic'] },
  { family: 'Merriweather',     category: 'serif', weights: [400, 700, 900], styles: ['normal', 'italic'] },
  { family: 'Playfair Display', category: 'serif', weights: [400, 600, 700, 900], styles: ['normal', 'italic'] },
  { family: 'PT Serif',         category: 'serif', weights: [400, 700], styles: ['normal', 'italic'] },
  { family: 'Cormorant Garamond', category: 'serif', weights: [400, 500, 600, 700], styles: ['normal', 'italic'] },
  { family: 'Libre Baskerville',  category: 'serif', weights: [400, 700], styles: ['normal', 'italic'] },
  { family: 'Bitter',           category: 'serif', weights: [400, 600, 700], styles: ['normal', 'italic'] },
  { family: 'Spectral',         category: 'serif', weights: [300, 400, 600, 700], styles: ['normal', 'italic'] },

  // Sans
  { family: 'Inter',            category: 'sans', weights: [400, 500, 600, 700], styles: ['normal'] },
  { family: 'Source Sans 3',    category: 'sans', weights: [400, 600, 700], styles: ['normal', 'italic'] },
  { family: 'Roboto',           category: 'sans', weights: [400, 500, 700], styles: ['normal', 'italic'] },
  { family: 'Open Sans',        category: 'sans', weights: [400, 600, 700], styles: ['normal', 'italic'] },
  { family: 'Lato',             category: 'sans', weights: [400, 700, 900], styles: ['normal', 'italic'] },
  { family: 'Nunito',           category: 'sans', weights: [400, 600, 700], styles: ['normal', 'italic'] },
  { family: 'Work Sans',        category: 'sans', weights: [400, 500, 600, 700], styles: ['normal', 'italic'] },
  { family: 'Noto Sans',        category: 'sans', weights: [400, 700], styles: ['normal', 'italic'] },
  { family: 'Noto Serif',       category: 'serif', weights: [400, 700], styles: ['normal', 'italic'] },

  // Display / Title
  { family: 'Cormorant',        category: 'display', weights: [400, 500, 600, 700], styles: ['normal', 'italic'] },
  { family: 'Cinzel',           category: 'display', weights: [400, 600, 700, 900], styles: ['normal'] },
  { family: 'Great Vibes',      category: 'handwriting', weights: [400], styles: ['normal'] },

  // Monospace (selten gebraucht, nur als Notbehelf)
  { family: 'JetBrains Mono',   category: 'mono', weights: [400, 500, 700], styles: ['normal', 'italic'] },
];

const FONT_INDEX = new Map(FONT_LIST.map(f => [f.family, f]));

// Wget liefert von der Google-CSS-API zuverlässig `format('truetype')`-Einträge.
// Andere getestete UAs (alte Firefox/IE) geben WOFF/WOFF2 zurück, was pdfkit
// nicht embedden kann.
const UA_FOR_TTF = 'Wget/1.13.4';

function listFonts() {
  return FONT_LIST.map(f => ({ family: f.family, category: f.category, weights: f.weights, styles: f.styles }));
}

function isAllowed(family, weight, style) {
  const f = FONT_INDEX.get(family);
  if (!f) return false;
  if (!f.weights.includes(parseInt(weight))) return false;
  if (!f.styles.includes(style)) return false;
  return true;
}

function _buildCssUrl(family, weight, style) {
  // Old-API: /css?family=Lora:400,400i,700,700i&display=swap. Liefert TTF
  // bei Firefox-UA.
  const tag = `${weight}${style === 'italic' ? 'i' : ''}`;
  const fam = encodeURIComponent(family).replace(/%20/g, '+');
  return `https://fonts.googleapis.com/css?family=${fam}:${tag}&display=swap`;
}

async function _fetchTtfFromGoogle(family, weight, style) {
  const url = _buildCssUrl(family, weight, style);
  const cssRes = await fetch(url, { headers: { 'User-Agent': UA_FOR_TTF, 'Accept': 'text/css' } });
  if (!cssRes.ok) throw new Error(`google-fonts-css ${cssRes.status}`);
  const css = await cssRes.text();
  // Suche `src: url(...) format('truetype')`
  const ttfMatch = css.match(/url\(([^)]+\.ttf)\)/i);
  if (!ttfMatch) throw new Error('no-ttf-url');
  const ttfUrl = ttfMatch[1];
  const ttfRes = await fetch(ttfUrl);
  if (!ttfRes.ok) throw new Error(`google-fonts-ttf ${ttfRes.status}`);
  const ab = await ttfRes.arrayBuffer();
  return Buffer.from(ab);
}

/**
 * Liefert TTF-Buffer für (family, weight, style). Cache zuerst, dann Network.
 * Bei Network-Fehler mit stale-Cache wird der stale-Buffer geliefert (Render
 * läuft durch, Job-Log warnt).
 *
 * Wirft bei nicht-whitelisted Eingaben oder leerem Cache + Network-Fehler.
 */
async function fetchFont(family, weight, style = 'normal') {
  if (!isAllowed(family, weight, style)) {
    throw new Error(`font-not-allowed: ${family} ${weight} ${style}`);
  }
  const cached = getCachedFont(family, weight, style);
  if (cached && !cached.stale) return cached.ttf;

  try {
    const buf = await _fetchTtfFromGoogle(family, weight, style);
    cacheFont(family, weight, style, buf);
    return buf;
  } catch (e) {
    if (cached) {
      logger.warn(`font-fetch failed for ${family} ${weight} ${style} (${e.message}); serving stale cache`);
      return cached.ttf;
    }
    throw e;
  }
}

module.exports = { listFonts, isAllowed, fetchFont, FONT_LIST };
