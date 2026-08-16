// Diagramme im Browser anzeigen — geteilt von allen drei Anzeige-Oberflaechen
// (Notebook-Leseansicht, Bucheditor, Diagramm-Dialog des Notebook-Editors).
// Der Share-Reader hat eine eigene Kopie: er ist ein eigenstaendiger, schlanker
// Modulgraph und darf nur aus /js/share-reader/ importieren — gegated durch
// tests/unit/mermaid-drift.test.mjs.
//
// WER RENDERT: fuer die LESENDEN Ansichten der Server (POST /diagram/render,
// inhaltsadressierter Cache) — mermaid ist mit 3,4 MB die groesste Lib im
// Bestand und lohnt sich nicht dafuer, ein fertiges Bild anzuzeigen. Der
// Client-Bundle laedt nur noch
//   a) in der Live-Vorschau des Diagramm-Dialogs (`renderDiagramSvg`): Tippen
//      braucht Rueckmeldung ohne Roundtrip, und der Code ist dort noch nicht
//      gespeichert;
//   b) als Rueckfall, wenn der Server-Renderer nicht verfuegbar ist (Chromium
//      fehlt im Container, Feature abgeschaltet). Dann verhaelt sich alles wie
//      vorher — deshalb bleibt der Bundle ausgeliefert.
// Ein einzelnes UNGUELTIGES Diagramm loest den Rueckfall bewusst NICHT aus
// (Server: 422 statt 503), sonst kostete ein Tippfehler 1 MB Download.
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

/** Schluessel des Render-Knotens. Das THEME gehoert hinein: ein Wechsel
 *  hell/dunkel muss dieselben Diagramme neu zeichnen lassen, weil die Farben im
 *  SVG stehen — mit einem rein inhaltsbasierten Schluessel galten sie als
 *  „schon gerendert" und blieben im alten Modus stehen. */
function _renderKey(code, theme) {
  return `${diagramKey(code)}:${theme}`;
}

// Ist der Server-Renderer als nicht verfuegbar bekannt? Gilt fuer die restliche
// Sitzung: die Antwort haengt an der Installation, nicht am Diagramm — jede
// weitere Anfrage waere ein Roundtrip mit vorhersagbarem 503.
let _serverRenderOff = false;

/** Ein Diagramm serverseitig rendern lassen.
 *
 *  Rueckgabe: `{ svg }` | `{ error }` (ungueltiger Quelltext) |
 *  `{ retryLocal: true }` (hier rendert nichts — der Aufrufer soll die Lib
 *  nehmen). */
async function _serverSvg(code, theme) {
  if (_serverRenderOff) return { retryLocal: true };
  try {
    const res = await fetch('/diagram/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, theme }),
    });
    if (res.ok) {
      const data = await res.json();
      return data?.svg ? { svg: data.svg } : { retryLocal: true };
    }
    if (res.status === 422) return { error: 'invalid' };
    if (res.status === 503) { _serverRenderOff = true; return { retryLocal: true }; }
    // 413 (zu gross) und alles Uebrige: die Lib im Browser hat keinen solchen
    // Deckel und schafft es vielleicht.
    return { retryLocal: true };
  } catch {
    // Offline oder Netzfehler. Der Bundle liegt womoeglich im Service-Worker-
    // Cache und rendert dann trotzdem.
    return { retryLocal: true };
  }
}

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
  const theme = mermaidTheme();
  const found = collectDiagrams(root);
  if (!found.length) return { rendered: 0, failed: 0 };

  const pending = found.filter(({ el, code }) => {
    const next = el.nextElementSibling;
    const done = next?.classList?.contains(RENDER_CLASS)
      && next.getAttribute(RENDER_KEY_ATTR) === _renderKey(code, theme);
    return !done;
  });
  if (!pending.length) return { rendered: 0, failed: 0 };

  // Stufe 1: alle offenen Diagramme parallel beim Server anfragen. Parallel,
  // weil ein langsames Diagramm die anderen nicht aufhalten soll — und weil ein
  // Cache-Treffer ohnehin nur ein Roundtrip ist.
  const results = await Promise.all(pending.map(({ code }) => _serverSvg(code, theme)));

  // Stufe 2: nur wenn der Server ueberhaupt nicht rendern kann, kommt der
  // Bundle. Eine einzige Anfrage genuegt fuer die Entscheidung — `_serverSvg`
  // hat den Zustand schon fuer die Sitzung gemerkt.
  let libReady = false;
  if (results.some(r => r?.retryLocal)) {
    try { await loadMermaid(); libReady = true; } catch { /* bleibt Quelltext */ }
  }

  let rendered = 0;
  let failed = 0;
  for (let i = 0; i < pending.length; i++) {
    const { el, code } = pending[i];
    let result = results[i];

    if (result?.retryLocal) {
      if (!libReady) {
        // Weder Server noch Lib: der Quelltext bleibt sichtbar. Genau die
        // Degradation, fuer die `<pre>` als Traeger gewaehlt wurde.
        const stale = el.nextElementSibling;
        if (stale?.classList?.contains(RENDER_CLASS)) stale.remove();
        el.classList.remove('mermaid--rendered');
        failed++;
        continue;
      }
      try {
        result = { svg: await renderDiagramSvg(code, `mmd-${diagramKey(code)}-${i}`) };
      } catch (err) {
        result = { error: err?.message };
      }
    }

    // Reste eines frueheren Laufs entfernen, bevor neu gezeichnet wird.
    const stale = el.nextElementSibling;
    if (stale?.classList?.contains(RENDER_CLASS)) stale.remove();

    const host = document.createElement('div');
    host.className = RENDER_CLASS;
    host.setAttribute(RENDER_KEY_ATTR, _renderKey(code, theme));
    if (result?.svg) {
      host.innerHTML = result.svg;
      el.classList.add('mermaid--rendered');
      rendered++;
    } else {
      host.classList.add(ERROR_CLASS);
      // Kein x-html-Sink und kein innerHTML mit Fremdtext: die Meldung von
      // mermaid enthaelt Teile des Quelltexts.
      host.textContent = opts.errorLabel || 'Diagram error';
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
