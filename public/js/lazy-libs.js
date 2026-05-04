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

export function loadVis() {
  if (typeof window.vis !== 'undefined') return Promise.resolve(window.vis);
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
