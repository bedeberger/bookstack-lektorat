// On-demand-Loader für vis-network und Chart.js. Beide Libs laden nur bei Bedarf
// (Figuren-Graph- bzw. BookStats-Karte geöffnet) — vorher blockten sie als
// Eager-Script-Tags den initialen Page-Load mit ~800 KB unbenutzter JS.

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
    _visPromise = _loadScript('https://unpkg.com/vis-network/standalone/umd/vis-network.min.js')
      .then(() => window.vis)
      .catch(err => { _visPromise = null; throw err; });
  }
  return _visPromise;
}

export function loadChart() {
  if (typeof window.Chart !== 'undefined') return Promise.resolve(window.Chart);
  if (!_chartPromise) {
    _chartPromise = _loadScript('https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js')
      .then(() => window.Chart)
      .catch(err => { _chartPromise = null; throw err; });
  }
  return _chartPromise;
}
