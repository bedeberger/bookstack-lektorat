// On-demand-Loader für vis-network und Chart.js. Beide Libs laden nur bei Bedarf
// (Figuren-Graph- bzw. BookStats-Karte geöffnet) — vorher blockten sie als
// Eager-Script-Tags den initialen Page-Load mit ~800 KB unbenutzter JS.
//
// Self-hosted unter public/vendor/ — externe CDNs (unpkg, jsdelivr) entfallen,
// damit offline (Zug-Szenario) Karten weiter funktionieren und kein Third-Party-
// Roundtrip beim Erstöffnen anfällt. Versionen sind im Dateinamen gepinnt;
// Update = neue Datei + alte löschen + SHELL_CACHE in public/sw.js bumpen.

let _visPromise = null;
let _chartPromise = null;
let _jsMindPromise = null;
let _sortablePromise = null;
let _diffPromise = null;
let _leafletPromise = null;
let _cloudPromise = null;
let _mermaidPromise = null;

function _loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Script konnte nicht geladen werden: ' + src));
    document.head.appendChild(s);
  });
}

function _ensureCss(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = href;
  document.head.appendChild(l);
}

export function loadVis() {
  if (window.vis?.Network) return Promise.resolve(window.vis);
  if (!_visPromise) {
    _visPromise = _loadScript('vendor/vis-network-10.0.2.min.js')
      .then(() => window.vis)
      .catch(err => { _visPromise = null; throw err; });
  }
  return _visPromise;
}

export function loadChart() {
  if (typeof window.Chart !== 'undefined') return Promise.resolve(window.Chart);
  if (!_chartPromise) {
    _chartPromise = _loadScript('vendor/chart-4.5.1.umd.min.js')
      .then(() => window.Chart)
      .catch(err => { _chartPromise = null; throw err; });
  }
  return _chartPromise;
}

export function loadJsMind() {
  if (typeof window.jsMind !== 'undefined') return Promise.resolve(window.jsMind);
  if (!_jsMindPromise) {
    _jsMindPromise = _loadScript('vendor/jsmind-0.8.7.js')
      .then(() => window.jsMind)
      .catch(err => { _jsMindPromise = null; throw err; });
  }
  return _jsMindPromise;
}

export function loadSortable() {
  if (typeof window.Sortable !== 'undefined') return Promise.resolve(window.Sortable);
  if (!_sortablePromise) {
    _sortablePromise = _loadScript('vendor/sortable-1.15.6.min.js')
      .then(() => window.Sortable)
      .catch(err => { _sortablePromise = null; throw err; });
  }
  return _sortablePromise;
}

export function loadDiff() {
  if (typeof window.Diff !== 'undefined') return Promise.resolve(window.Diff);
  if (!_diffPromise) {
    _diffPromise = _loadScript('vendor/diff-9.0.0.min.js')
      .then(() => window.Diff)
      .catch(err => { _diffPromise = null; throw err; });
  }
  return _diffPromise;
}

/** d3-cloud (Wortwolke der Wortschatz-Karte). Der UMD-Build hängt sich unter
 *  `window.d3.layout.cloud` ein und bringt sein einziges Paket-Dependency
 *  (d3-dispatch) gebundelt mit — es braucht kein d3 daneben.
 *
 *  Der Layout-Lauf misst jedes Wort auf einem Offscreen-Canvas; das ist der
 *  Grund, warum er asynchron über mehrere Ticks arbeitet und nicht einfach ein
 *  Array zurückgibt. Aufrufer warten auf das `end`-Event, siehe
 *  public/js/book/wortschatz-cloud.js. */
export function loadWordCloud() {
  if (window.d3?.layout?.cloud) return Promise.resolve(window.d3.layout.cloud);
  if (!_cloudPromise) {
    _cloudPromise = _loadScript('vendor/d3-cloud-1.2.9.js')
      .then(() => window.d3.layout.cloud)
      .catch(err => { _cloudPromise = null; throw err; });
  }
  return _cloudPromise;
}

/** mermaid (Diagramm-Bloecke im Manuskript). Mit Abstand die groesste Lib im
 *  Bestand (~3,5 MB, ~1 MB gzip) — sie laedt darum ausschliesslich, wenn eine
 *  Seite tatsaechlich einen `pre.mermaid` enthaelt bzw. der Diagramm-Dialog
 *  geoeffnet wird, nie beim Kartenwechsel „auf Verdacht".
 *
 *  Der UMD-Build haengt sich unter `window.mermaid` ein. Konfiguriert wird er
 *  nicht hier, sondern in public/js/diagram/mermaid-view.js — die Optionen
 *  (htmlLabels, securityLevel) sind fachlich und gehoeren zur SSoT, nicht zum
 *  Loader. */
export function loadMermaid() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  if (!_mermaidPromise) {
    _mermaidPromise = _loadScript('vendor/mermaid-11.16.0.min.js')
      .then(() => window.mermaid)
      .catch(err => { _mermaidPromise = null; throw err; });
  }
  return _mermaidPromise;
}

export function loadLeaflet() {
  // CSS muss vor dem Skript da sein (Marker-Image-Pfade relativ zur leaflet.css).
  _ensureCss('vendor/leaflet-1.9.4/leaflet.css');
  if (typeof window.L !== 'undefined') return Promise.resolve(window.L);
  if (!_leafletPromise) {
    _leafletPromise = _loadScript('vendor/leaflet-1.9.4/leaflet.js')
      .then(() => {
        // Auto-Detect der Image-Pfade scheitert bei manchen Setups → explizit setzen.
        if (window.L?.Icon?.Default) window.L.Icon.Default.imagePath = 'vendor/leaflet-1.9.4/images/';
        return window.L;
      })
      .catch(err => { _leafletPromise = null; throw err; });
  }
  return _leafletPromise;
}
