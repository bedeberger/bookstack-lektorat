'use strict';

// Diagramme fuer die Exportwege aufloesen — das Pendant zu lib/bibliography.js
// fuer Quellenangaben.
//
// In `pages.content` steht nur der Quelltext (siehe
// public/js/diagram/mermaid-html.js). Jeder Ausgabeweg ruft darum
// `prepareDiagrams` auf seinen Gruppen, BEVOR sein Walker laeuft — genau wie
// `prepareCitations`.
//
// VIER AUSGABEFORMEN, weil die Zielformate verschiedene Dinge koennen:
//   'svg'  — HTML- und EPUB-Export. Vektor, skaliert, klein.
//   'png'  — PDF und DOCX. pdfkit und docx koennen kein SVG einbetten; beide
//            verstehen aber `data:image/png;base64` in einem `<img>`, und damit
//            greifen ihre vorhandenen Bildpfade (Groessenrechnung, Seitenumbruch,
//            ImageRun) ohne einen zweiten Bildmechanismus.
//   'code' — Markdown und Plaintext. Ein ```mermaid-Block ist dort die native
//            Darstellung; ein eingebettetes Bild waere in einer .md-Datei ein
//            Fremdkoerper und in einer .txt-Datei sinnlos.
//   'screen' — die oeffentliche SSR-Leseansicht (Share-Reader). Wie 'svg', aber
//            BEIDE Themes im Markup, weil die SSR-Antwort nicht weiss, in
//            welchem Modus der Leser sitzt: `prefers-color-scheme` ist eine
//            Eigenschaft des Browsers, und die Theme-Wahl steht im
//            localStorage des Lesers. Ein Server-SVG traegt seine Farben aber
//            gebacken. Also liefert der Server beide und CSS zeigt eines —
//            zwei kleine SVG sind billiger als der 3,4-MB-Client-Bundle, der
//            sonst nur zum Umfaerben nachgeladen wuerde.
//
// HARTE INVARIANTEN
//
//   A) Nichts davon wird je in `pages.content` zurueckgeschrieben. Render-
//      Artefakt, entsteht bei jedem Export neu — dieselbe Regel wie beim
//      Quellenverzeichnis.
//
//   B) Ein nicht renderbares Diagramm behaelt seinen Quelltext. Kein Platzhalter,
//      kein Fehlerbild, keine Luecke. Faellt Chromium aus, ist der Export
//      vollstaendig, nur eben mit Codebloecken statt Grafiken — dieselbe
//      Degradation wie auf dem Bildschirm.

const { parseHTML } = require('linkedom');

const { renderCachedDiagram } = require('./diagram-cache');
const { mermaidHtml: _diagramModule } = require('./esm-bridge');

// Klasse des Render-Knotens. Deckungsgleich mit dem Knoten, den die
// Bildschirm-Oberflaechen zur Laufzeit einhaengen (public/js/diagram/
// mermaid-view.js) — daran haengen das Manuskript-CSS und der TTS-Ausschluss
// (TTS_SKIP_BLOCK_SEL). Ein eigener Klassenname fuer die SSR-Variante haette
// beide umgangen: das SVG waere unformatiert und der Vorleser wuerde die
// Knotenbeschriftungen mitlesen.
const RENDER_CLASS = 'mermaid-render';

/** Beide Theme-Varianten in EINEM Knoten. CSS entscheidet, welche sichtbar ist
 *  (public/css/components/manuscript-content.css).
 *
 *  Liegt nur eine Variante vor — etwa weil der Cache erst eine haelt oder das
 *  zweite Rendern scheiterte —, geht sie ohne Umschaltung raus. Ein Diagramm in
 *  den falschen Farben ist besser als kein Diagramm; `null` bliebe Quelltext. */
function _screenHtml(light, dark) {
  const a = light?.svg;
  const b = dark?.svg;
  if (!a && !b) return null;
  if (!a || !b) return `<div class="${RENDER_CLASS}">${a || b}</div>`;
  return `<div class="${RENDER_CLASS}">`
    + `<span class="diagram-theme diagram-theme--light">${a}</span>`
    + `<span class="diagram-theme diagram-theme--dark">${b}</span>`
    + '</div>';
}

/** Ersatzknoten fuer einen Diagramm-Block bauen. `null` = unveraendert lassen. */
function _replacementHtml(mode, asset, code, escXml) {
  if (mode === 'code') {
    // Markdown/Plaintext gehen nicht durch diesen Pfad (sie lesen den Quelltext
    // direkt), aber der Modus bleibt vollstaendig, damit ein Aufrufer ihn
    // waehlen kann, ohne einen Sonderfall zu bauen.
    return null;
  }
  if (!asset) return null;
  if (mode === 'svg') {
    // Der Alt-Text bleibt als `aria-label` am figure — mermaid setzt zwar
    // `role="graphics-document"` aufs SVG, aber keinen Namen, den ein Reader
    // vorlesen koennte.
    return `<figure class="diagram">${asset.svg}</figure>`;
  }
  if (mode === 'png' && asset.png) {
    const b64 = Buffer.isBuffer(asset.png) ? asset.png.toString('base64') : String(asset.png);
    // Breite/Hoehe als Attribute: der PDF-Walker und der DOCX-Builder rechnen
    // damit das Seitenverhaeltnis aus, ohne das PNG selbst zu dekodieren.
    return `<figure class="diagram"><img src="data:image/png;base64,${b64}"`
      + ` width="${asset.width || ''}" height="${asset.height || ''}"`
      + ` alt="${escXml(code.slice(0, 120))}"></figure>`;
  }
  return null;
}

function _esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Diagramme in EINEM HTML-Fragment aufloesen. */
async function resolveDiagramsInHtml(html, { mode = 'svg', theme = 'default' } = {}) {
  if (typeof html !== 'string' || !html) return html;
  const { DIAGRAM_SEL, DIAGRAM_CLASS, diagramCode } = await _diagramModule();
  // Billiger Vorab-Test, bevor ein DOM gebaut wird — Seiten ohne Diagramm
  // kosten so nichts. Das Literal kommt aus der SSoT, nicht aus einer Kopie.
  if (html.indexOf(DIAGRAM_CLASS) === -1) return html;

  const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body></html>`);
  const root = document.getElementById('r');
  if (!root) return html;

  const blocks = Array.from(root.querySelectorAll(DIAGRAM_SEL));
  if (!blocks.length) return html;

  let changed = 0;
  for (const el of blocks) {
    const code = diagramCode(el);
    if (!code) continue;
    let replacement;
    if (mode === 'screen') {
      // Zwei Laeufe, nicht einer: der Cache ist pro Theme adressiert, und beide
      // Varianten sollen dort landen. Beim zweiten Aufruf ist der Browser schon
      // warm — das Aufsetzen ist die teure Operation, nicht das Rendern.
      const light = await renderCachedDiagram(code, 'default');
      const dark = await renderCachedDiagram(code, 'dark');
      replacement = _screenHtml(light, dark);
    } else {
      const asset = await renderCachedDiagram(code, theme);
      replacement = _replacementHtml(mode, asset, code, _esc);
    }
    // Invariante B: nicht renderbar ⇒ Quelltext bleibt stehen.
    if (!replacement) continue;
    const tmp = document.createElement('div');
    tmp.innerHTML = replacement;
    const node = tmp.firstElementChild;
    if (!node) continue;
    el.replaceWith(node);
    changed++;
  }
  return changed ? root.innerHTML : html;
}

/** Diagramme in den Gruppen eines Bundles aufloesen.
 *
 *  Liefert eine NEUE Gruppen-Struktur (flache Kopien bis zum `pd`), damit der
 *  Aufrufer nicht versehentlich das Bundle mutiert, das an anderer Stelle noch
 *  gebraucht wird — `prepareCitations` hat denselben Vertrag.
 *
 *  `mode: 'code'` (Markdown/Plaintext) laesst alles unveraendert und rendert
 *  nichts: kein Chromium-Start, kein Cache-Zugriff. */
async function resolveDiagramsInGroups(groups, opts = {}) {
  const mode = opts.mode || 'svg';
  if (mode === 'code' || !Array.isArray(groups) || !groups.length) return groups || [];
  const out = [];
  for (const g of groups) {
    const pages = [];
    for (const x of (g.pages || [])) {
      const html = x?.pd?.html;
      if (typeof html !== 'string' || !html) { pages.push(x); continue; }
      const next = await resolveDiagramsInHtml(html, opts);
      pages.push(next === html ? x : { ...x, pd: { ...x.pd, html: next } });
    }
    out.push({ ...g, pages });
  }
  return out;
}

module.exports = { resolveDiagramsInHtml, resolveDiagramsInGroups };
