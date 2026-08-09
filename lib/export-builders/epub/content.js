'use strict';
// Aufbereitung des Manuskript-HTML fuer die epub-gen-memory-Pipeline: Bilder in
// einbettbare Form bringen, Umbruch-/Szenen-Marker uebersetzen, `data-*`-Zeiger
// auf Klassen abbilden und IDs pro Dokument eindeutig machen.

const logger = require('../../../logger');

// Zaehlt <img>-Tags, deren src weder http(s) noch data: ist — die kann
// epub-gen-memory nicht einbetten und verwirft sie still. Wir loggen das,
// statt es zu verschlucken.
function _countUnfetchableImages(chapters) {
  let n = 0;
  for (const c of chapters) {
    const all = c.content?.match(/<img\b[^>]*\bsrc\s*=\s*["'][^"']*["']/gi) || [];
    for (const tag of all) {
      if (!/\bsrc\s*=\s*["'](https?:|data:|file:)/i.test(tag)) n += 1;
    }
  }
  return n;
}

// Manuskript-Bilder für epub-gen-memory bereitstellen. Die Lib bettet ein Bild nur
// dann korrekt ein, wenn seine src (a) eine echte Bild-Endung trägt (media-type +
// Extension leitet sie via mime.getType aus dem URL-Suffix ab) UND (b) über
// file://- bzw. http(s)-Fetch ladbar ist. /content/page-image/:id (kein Suffix,
// auth-geschützt) und data:-URIs (Fassungs-Export) erfüllen beides nicht — die Lib
// legt sonst nur eine 0-Byte-Datei mit leerem media-type an. Darum: BLOB in eine
// Temp-Datei mit echter Endung schreiben und die src auf deren file://-URL umbiegen.
// Danach embeddet die Lib nativ (Bytes + media-type + OPF-Manifest + Spine). Die
// zurückgegebenen Temp-Pfade räumt der Aufrufer nach dem Build wieder ab.
function _stagePageImagesForEpub(chapters) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { pathToFileURL } = require('url');
  const { randomUUID } = require('crypto');
  const { getPageImage } = require('../../../db/page-images');
  const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };
  const tmpDir = os.tmpdir();
  const tmpPaths = [];
  const cache = new Map(); // src → file://-URL (mehrfach referenzierte Bilder teilen eine Datei)

  const stage = (buffer, mime) => {
    const p = path.join(tmpDir, `epubimg-${randomUUID()}.${EXT[mime] || 'jpg'}`);
    fs.writeFileSync(p, buffer);
    tmpPaths.push(p);
    return pathToFileURL(p).href;
  };
  const urlFor = (src) => {
    if (cache.has(src)) return cache.get(src);
    let out = null;
    try {
      const pm = /^\/content\/page-image\/(\d+)/.exec(src);
      if (pm) {
        const row = getPageImage(parseInt(pm[1], 10));
        if (row && row.image) out = stage(row.image, row.mime);
      } else if (/^data:image\//i.test(src)) {
        const semi = src.indexOf(';'); const comma = src.indexOf(',');
        out = stage(Buffer.from(src.slice(comma + 1), 'base64'), src.slice(5, semi === -1 ? comma : semi));
      }
    } catch (e) { logger.warn(`epub: page-image staging fehlgeschlagen (${e.message})`); out = null; }
    cache.set(src, out);
    return out;
  };

  for (const c of chapters) {
    if (!c.content) continue;
    const hasPageImg = c.content.indexOf('/content/page-image/') !== -1;
    const hasData = c.content.indexOf('data:image/') !== -1;
    if (!hasPageImg && !hasData) continue;
    if (hasPageImg) c.content = c.content.replace(/\/content\/page-image\/(\d+)/g, (m) => urlFor(m) || m);
    if (hasData) {
      c.content = c.content
        .replace(/(src\s*=\s*")(data:image\/[^"]+)(")/gi, (m, a, s, z) => { const u = urlFor(s); return u ? a + u + z : m; })
        .replace(/(src\s*=\s*')(data:image\/[^']+)(')/gi, (m, a, s, z) => { const u = urlFor(s); return u ? a + u + z : m; });
    }
  }
  return tmpPaths;
}

// Editor-Umbruchmarker (`<hr class="pagebreak">` / `<hr class="blankpage">`) in
// EPUB-Aequivalente uebersetzen: Pagebreak bleibt randloses hr mit erzwungenem
// Seitenumbruch danach; Blankpage wird ein leeres div (hr kann keinen Inhalt
// tragen) mit Umbruch davor + danach, damit eine bewusst leere Seite entsteht.
const _SCENE_MARKUP = {
  line: '<hr class="scene-line" />',
  blank: '<hr class="scene-blank" />',
  asterism: '<p class="scene-sep">⁂</p>',
  stars: '<p class="scene-sep">* * *</p>',
  fleuron: '<p class="scene-sep">❦</p>',
};

// Vom Autor gesetzte Leerzeile (leerer Absatz) im Belletristik-Satz =
// Szenentrenner: sichtbare Leerzeile + Folgeabsatz ohne Erstzeilen-Einzug
// (CSS `.scene-gap` / `.scene-gap + p`). Nur bei aktivem Einzug; im Sachbuch-
// Satz trennt bereits der Absatzabstand.
const _SCENE_GAP = '<p class="scene-gap">&#160;</p>';

// Strich-Trenner zwischen Kapitelnummer und Kapiteltitel bei gestapelter,
// numerierter Ueberschrift. Drei Geviertstriche; das CSS-letter-spacing zerlegt
// sie optisch in einzelne Striche.
const CHAPTER_RULE = '———';

function _applyBlankLines(html) {
  return html
    .replace(/<p\b[^>]*>(?:\s|&nbsp;|&#160;|<br\s*\/?>)*<\/p>/gi, _SCENE_GAP)
    .replace(/(?:<p class="scene-gap">&#160;<\/p>\s*){2,}/gi, _SCENE_GAP)
    .replace(/^\s*(?:<p class="scene-gap">&#160;<\/p>\s*)+/i, '')
    .replace(/(?:<p class="scene-gap">&#160;<\/p>\s*)+\s*$/i, '');
}

// `data-*`-Attribute auf KLASSEN abbilden, bevor das Markup die epub-Lib
// erreicht.
//
// WARUM DAS NOETIG IST: epub-gen-memory filtert jedes Attribut gegen eine feste
// Allowlist (dist/lib/util/constants.js#allowedAttributes). Darin stehen `class`,
// `style`, `colspan`/`rowspan` und die `aria-*`-Familie — aber KEIN `data-*` und
// kein `scope`. Jeder Selektor der Form `[data-…]` im EPUB-Stylesheet ist damit
// wirkungslos, und zwar lautlos: das Markup kommt an, nur ohne seinen Zeiger.
//
// Betrifft zwei Faelle:
//   - `data-align` an Tabellenzellen → `.ta-center` / `.ta-right`. Ohne die
//     Abbildung stehen Zahlenspalten im E-Book linksbuendig.
//   - `data-src` am belegten Blockzitat → `.cited-quote`. Dieselbe Ursache.
// Die Attribute bleiben zusaetzlich stehen — sie kosten nichts (die Lib wirft sie
// ohnehin weg) und halten das Markup zum Rest der App konsistent.
//
// `scope="col"` an den Kopfzellen laesst sich so NICHT retten (keine erlaubte
// Entsprechung). Ein `<th>` in `<thead>` ist per HTML-Semantik ohnehin
// Spaltenkopf; die Zuordnung bleibt also lesbar, nur nicht explizit.
function _applyDataClasses(html) {
  if (!html) return html;
  const addClass = (tag, cls) => (/\bclass="([^"]*)"/i.test(tag)
    ? tag.replace(/\bclass="([^"]*)"/i, (_m, c) => `class="${c} ${cls}"`)
    : tag.replace(/^<(\w+)/, `<$1 class="${cls}"`));
  return html
    .replace(/<(?:th|td)\b[^>]*\bdata-align="(center|right)"[^>]*>/gi,
      (m, a) => addClass(m, `ta-${a.toLowerCase()}`))
    .replace(/<blockquote\b[^>]*\bdata-src="[^"]*"[^>]*>/gi,
      (m) => addClass(m, 'cited-quote'));
}

function _applyBreaks(html, sceneSep = 'line', indentActive = false) {
  if (!html) return html;
  const scene = _SCENE_MARKUP[sceneSep] || _SCENE_MARKUP.line;
  let out = _applyDataClasses(html)
    .replace(/<hr\b[^>]*\bclass="[^"]*\bpagebreak\b[^"]*"[^>]*>/gi, '<hr class="pagebreak" />')
    .replace(/<hr\b[^>]*\bclass="[^"]*\bblankpage\b[^"]*"[^>]*>/gi, '<div class="blankpage"> </div>')
    .replace(/<hr(?![^>]*\bclass=)[^>]*>/gi, scene);
  if (indentActive) out = _applyBlankLines(out);
  return out;
}

// EPUBCheck verlangt dokumentweit eindeutige id-Attribute (RSC-005 "Duplicate
// ID"). Editor-/Import-HTML kann doppelte Anker-IDs (BookStack `bkmrk-…`) und
// leere `id=""` enthalten. Pro XHTML-Datei deduplizieren: das erste Vorkommen
// behaelt die ID (bleibt Link-Ziel), spaetere Duplikate bekommen einen Zaehler-
// Suffix, leere IDs werden entfernt. Zwei-Pass, damit der synthetische Suffix
// keine andere echte ID im selben Dokument trifft.
function _dedupeIds(html) {
  if (!html || !/\sid\s*=/i.test(html)) return html;
  const existing = new Set(
    [...html.matchAll(/\sid\s*=\s*"([^"]*)"/gi)].map(m => m[1].trim()).filter(Boolean),
  );
  const used = new Set();
  return html.replace(/(\s)id\s*=\s*"([^"]*)"/gi, (full, sp, raw) => {
    const v = raw.trim();
    if (!v) return ''; // leere id ganz entfernen (inkl. fuehrendem Whitespace)
    if (!used.has(v)) { used.add(v); return `${sp}id="${v}"`; }
    let i = 2, nv;
    do { nv = `${v}-${i++}`; } while (used.has(nv) || existing.has(nv));
    used.add(nv);
    return `${sp}id="${nv}"`;
  });
}

module.exports = {
  CHAPTER_RULE,
  _countUnfetchableImages,
  _stagePageImagesForEpub,
  _applyBreaks,
  _dedupeIds,
};
