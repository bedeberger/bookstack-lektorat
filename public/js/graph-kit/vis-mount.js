import { loadVis } from '../lazy-libs.js';

// vis-network-Bundle sicherstellen und derweil einen Platzhalter in den Container
// setzen. Rückgabe `false` = Bundle nicht verfügbar; der Fehlertext steht dann im
// Container, der Aufrufer bricht ohne weitere Meldung ab.
//
// `.Network` statt bloss `window.vis` prüfen: erst wenn das Bundle wirklich da ist,
// lässt sich `new vis.Network` aufrufen.
export async function ensureVis(container) {
  if (window.vis?.Network) return true;
  const ph = document.createElement('span');
  ph.className = 'muted-msg muted-msg--block';
  ph.textContent = window.__app.t('graph.empty.visLoading');
  container.replaceChildren(ph);
  try {
    await loadVis();
    return true;
  } catch (e) {
    ph.textContent = e.message;
    return false;
  }
}

// Platzhalter-Text im Graph-Container (leerer Datenbestand, fehlende Voraussetzung).
// textContent statt innerHTML — kein Escape nötig, gar keine HTML-Sink.
export function graphPlaceholder(container, text, className = 'muted-msg muted-msg--block') {
  const ph = document.createElement('span');
  ph.className = className;
  ph.textContent = text;
  container.replaceChildren(ph);
}
