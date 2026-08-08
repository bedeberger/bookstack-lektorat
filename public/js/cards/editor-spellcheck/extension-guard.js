// Erkennung der LanguageTool-Browser-Erweiterung.
//
// Laeuft sie mit, unterstreicht sie dieselben Stellen ein zweites Mal — die
// eigenen Markierungen werden pausiert, statt zwei Wellenlinien uebereinander
// zu legen.
//
// Der Beobachter haengt an `document.body{subtree}` und feuert damit bei JEDEM
// Tastendruck im Editor. `detect()` scannt das ganze Dokument; ungedrosselt
// waere das Tipp-Latenz pro Zeichen auf grossen Seiten. Ein Trailing-Throttle
// reicht: Erweiterungs-Marker im DOM erscheinen und verschwinden nicht
// zeitkritisch.

const EXTENSION_SELECTORS = [
  'lt-div',
  'lt-highlighter',
  '[class*="lt-toolbar"]',
  '[class*="languagetool"]',
];

const THROTTLE_MS = 300;

function detect() {
  for (const sel of EXTENSION_SELECTORS) {
    if (document.querySelector(sel)) return true;
  }
  return false;
}

/**
 * @param {object} deps
 * @param {() => void} deps.onDetected  Erweiterung ist aufgetaucht
 * @param {() => void} deps.onCleared   Erweiterung ist verschwunden
 */
export function createExtensionGuard({ onDetected, onCleared }) {
  let observer = null;
  let timer = null;
  let present = false;

  function evaluate() {
    const now = detect();
    if (now && !present) { present = true; onDetected(); }
    else if (!now && present) { present = false; onCleared(); }
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; evaluate(); }, THROTTLE_MS);
  }

  return {
    // Blockiert die Erweiterung gerade? Der Controller ueberspringt dann Checks.
    get blocked() { return present; },

    start() {
      observer = new MutationObserver(schedule);
      observer.observe(document.body, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['class'],
      });
      evaluate();
    },

    stop() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (observer) { observer.disconnect(); observer = null; }
    },
  };
}
