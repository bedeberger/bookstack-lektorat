// Diagramme in der oeffentlichen Leseansicht rendern — RUECKFALL, nicht der
// Normalweg.
//
// Normalweg ist die SSR-Antwort: routes/share/reader.js loest Diagramme vor dem
// Ausliefern serverseitig auf (lib/diagram-export.js, `mode: 'screen'`, beide
// Themes im Markup). Dann steht hier kein `pre.mermaid` mehr und dieses Modul
// kehrt sofort zurueck — der anonyme Leser laedt die 3,4-MB-Lib nicht.
//
// Gefunden wird also nur, was der Server NICHT rendern konnte: Chromium fehlt im
// Container, Rendering abgeschaltet, oder der Quelltext ist ungueltig. Genau
// dafuer bleibt dieser Pfad bestehen.
//
// BEWUSSTE KOPIE des Kerns aus public/js/diagram/mermaid-view.js: der Reader
// muss pre-auth ladbar sein und darf nur aus /js/share-reader/ importieren
// (siehe PUBLIC_ASSET_PREFIXES in server.js) — ein Import aus /js/diagram/ kaeme
// beim anonymen Leser als HTML vom Auth-Guard zurueck und der Browser wuerde das
// Modul wegen MIME-Type verweigern. Dieselbe Lage wie READER_BLOCK_SEL in
// share-reader/tts.js. Gegen Drift gesichert durch
// tests/unit/mermaid-drift.test.mjs.
//
// Eigenstaendiges Modul (wie tts.js/dwell.js): liest #share-config selbst und
// wird von share.html direkt geladen.
//
// Faellt mermaid aus (Ladefehler, offline), bleibt der Quelltext im `<pre>`
// stehen. Das ist der Grund, warum der Traeger ein `<pre>` ist.

const DIAGRAM_SEL = 'pre.mermaid';
const RENDER_CLASS = 'mermaid-render';
const VENDOR_SRC = '/vendor/mermaid-11.16.0.min.js';

let _libPromise = null;

function loadLib() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  if (!_libPromise) {
    _libPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = VENDOR_SRC;
      s.async = true;
      s.onload = () => resolve(window.mermaid);
      s.onerror = () => reject(new Error('mermaid load failed'));
      document.head.appendChild(s);
    }).catch(err => { _libPromise = null; throw err; });
  }
  return _libPromise;
}

function readerTheme() {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'dark') return 'dark';
  if (attr === 'light') return 'default';
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'default';
}

/** Alle Diagramme im Artikel rendern. Einmal beim Laden — die Leseansicht ist
 *  statisch, es gibt kein Nachladen von Inhalt. */
export async function setupDiagrams(root) {
  const article = root || document.querySelector('.share-content');
  if (!article) return;
  const blocks = [...article.querySelectorAll(DIAGRAM_SEL)]
    .filter(el => (el.textContent || '').trim());
  if (!blocks.length) return;

  let mermaid;
  try {
    mermaid = await loadLib();
  } catch {
    return; // Quelltext bleibt stehen.
  }

  // `htmlLabels: false` ist Pflicht, nicht Geschmack: mit HTML-Labels steckt
  // mermaid <foreignObject> ins SVG, und das rendert kein E-Book-Reader und kein
  // Rasterizer. `securityLevel: 'strict'` schaltet Klick-Handler und rohes HTML
  // in Labels ab — der Diagramm-Code stammt aus dem Manuskript.
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    flowchart: { htmlLabels: false, useMaxWidth: true },
    theme: readerTheme(),
    fontFamily: 'inherit',
  });

  let i = 0;
  for (const el of blocks) {
    const code = (el.textContent || '').trim();
    try {
      const { svg } = await mermaid.render('share-mmd-' + (i++), code);
      const host = document.createElement('div');
      host.className = RENDER_CLASS;
      host.innerHTML = svg;
      el.insertAdjacentElement('afterend', host);
      el.classList.add('mermaid--rendered');
    } catch {
      // Ungueltiges Diagramm: Quelltext stehen lassen, naechstes versuchen.
    }
  }
}

setupDiagrams();
