// Diagramme im Browser rendern — geteilt von allen drei Anzeige-Oberflaechen
// (Notebook-Leseansicht, Bucheditor, Diagramm-Dialog des Notebook-Editors).
// Der Share-Reader hat eine eigene Kopie: er muss pre-auth ladbar sein und darf
// nur aus /js/share-reader/ importieren (siehe PUBLIC_ASSET_PREFIXES in
// server.js) — gegated durch tests/unit/mermaid-drift.test.mjs.
//
// Rendern heisst hier NIE Umschreiben: der `<pre class="mermaid">` bleibt im
// DOM stehen und wird nur ausgeblendet, das SVG kommt als Geschwister-Knoten
// daneben. Damit ist der Quelltext weiterhin die Wahrheit — auch dann, wenn ein
// Save-Pfad das DOM zurueckliest.

import { loadMermaid } from '../lazy-libs.js';
import { collectDiagrams, diagramKey } from './mermaid-html.js';

// Klasse des eingefuegten Render-Knotens. Traegt den Schluessel des Quelltexts,
// damit ein zweiter Lauf ueber denselben Container nicht neu rendert.
const RENDER_CLASS = 'mermaid-render';
const RENDER_KEY_ATTR = 'data-mermaid-key';
const ERROR_CLASS = 'mermaid-render--error';

// Theme, mit dem mermaid zuletzt konfiguriert wurde (null = noch nie).
// Ein Theme-Wechsel muss `initialize` erneut durchlaufen, sonst behalten neu
// gerenderte Diagramme die Farben des alten Modus.
let _initTheme = null;

/** mermaid einmalig konfigurieren.
 *
 *  `htmlLabels: false` ist die wichtigste Einstellung und keine Geschmacksfrage:
 *  mit HTML-Labels steckt mermaid `<foreignObject>` mit `<div>`-Inhalt ins SVG.
 *  Das rendert der Browser, aber kein EPUB-Reader und kein SVG-Rasterizer —
 *  und der Export ist genau der Weg, auf dem das Diagramm gebraucht wird. Mit
 *  `false` sind Labels echte `<text>`-Knoten und das SVG ist portabel.
 *
 *  `securityLevel: 'strict'` schaltet Klick-Handler und rohes HTML in Labels ab.
 *  Der Diagramm-Code kommt aus dem Manuskript und ist damit User-Eingabe; er
 *  darf kein Skript in die Seite tragen. */
function _init(mermaid, theme) {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    flowchart: { htmlLabels: false, useMaxWidth: true },
    theme,
    fontFamily: 'Inter, system-ui, sans-serif',
  });
}

/** Aktuelles Theme der App auf ein Mermaid-Theme abbilden. */
export function mermaidTheme() {
  const dark = document.documentElement.dataset.theme === 'dark'
    || (!document.documentElement.dataset.theme
        && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  return dark ? 'dark' : 'default';
}

/** Einen einzelnen Quelltext zu SVG rendern. Wirft bei ungueltigem Code —
 *  Aufrufer entscheidet, ob er den Fehler zeigt (Dialog) oder den Quelltext
 *  stehen laesst (Leseansicht). */
export async function renderDiagramSvg(code, id) {
  const mermaid = await loadMermaid();
  const theme = mermaidTheme();
  if (_initTheme !== theme) {
    _init(mermaid, theme);
    _initTheme = theme;
  }
  const { svg } = await mermaid.render(id || ('mmd-' + diagramKey(code)), code);
  return svg;
}

/** Alle Diagramme unter `root` rendern.
 *
 *  Idempotent: ein bereits gerenderter Block mit unveraendertem Quelltext wird
 *  uebersprungen. Das ist keine Optimierung, sondern noetig — die Leseansichten
 *  rufen die Funktion nach jedem Re-Render auf, und ein zweiter mermaid-Lauf
 *  ueber dieselbe ID wirft.
 *
 *  Fehlschlaege sind lokal: ein kaputtes Diagramm zeigt seinen Quelltext plus
 *  eine Fehlerzeile, die anderen rendern normal. Faellt die Lib ganz aus
 *  (offline, Ladefehler), bleibt jeder Block als Quelltext stehen — genau die
 *  Degradation, fuer die `<pre>` als Traeger gewaehlt wurde. */
export async function renderDiagramsIn(root, opts = {}) {
  const found = collectDiagrams(root);
  if (!found.length) return { rendered: 0, failed: 0 };

  const pending = found.filter(({ el, code }) => {
    const next = el.nextElementSibling;
    const done = next?.classList?.contains(RENDER_CLASS)
      && next.getAttribute(RENDER_KEY_ATTR) === diagramKey(code);
    return !done;
  });
  if (!pending.length) return { rendered: 0, failed: 0 };

  try {
    await loadMermaid();
  } catch {
    return { rendered: 0, failed: pending.length };
  }

  let rendered = 0;
  let failed = 0;
  for (const { el, code } of pending) {
    // Reste eines frueheren Laufs entfernen, bevor neu gezeichnet wird.
    const stale = el.nextElementSibling;
    if (stale?.classList?.contains(RENDER_CLASS)) stale.remove();

    const host = document.createElement('div');
    host.className = RENDER_CLASS;
    host.setAttribute(RENDER_KEY_ATTR, diagramKey(code));
    try {
      host.innerHTML = await renderDiagramSvg(code, 'mmd-' + diagramKey(code) + '-' + rendered);
      el.classList.add('mermaid--rendered');
      rendered++;
    } catch (err) {
      host.classList.add(ERROR_CLASS);
      // Kein x-html-Sink und kein innerHTML mit Fremdtext: die Meldung von
      // mermaid enthaelt Teile des Quelltexts.
      host.textContent = opts.errorLabel || (err?.message || 'Diagram error');
      el.classList.remove('mermaid--rendered');
      failed++;
    }
    el.insertAdjacentElement('afterend', host);
  }
  return { rendered, failed };
}

/** Render-Knoten wieder entfernen und die Quelltext-Bloecke sichtbar machen.
 *  Gebraucht, bevor ein Editor das DOM zurueckliest — auch wenn der Save-Pfad
 *  den Fremdknoten ohnehin verwerfen wuerde, ist „gar nicht erst drin" die
 *  belastbarere Zusage. */
export function clearRenderedDiagrams(root) {
  if (!root?.querySelectorAll) return;
  for (const host of root.querySelectorAll('.' + RENDER_CLASS)) host.remove();
  for (const el of root.querySelectorAll('.mermaid--rendered')) el.classList.remove('mermaid--rendered');
}
