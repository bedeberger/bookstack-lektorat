// Geteilter Tooltip-Layer für [data-tip].
// Ein einziges DOM-Element wird bei Hover/Focus auf ein [data-tip]-Element
// positioniert und befüllt. Hält die Pseudo-Slots auf den Targets frei,
// damit ::before/::after dort für eigene Decorations verfügbar bleiben.
import { EVT } from './events.js';
import { mountInTopLayer } from './fullscreen.js';

(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__tooltipLayerInstalled) return;
  window.__tooltipLayerInstalled = true;

  let layer = null;
  let arrow = null;
  let bubble = null;
  let currentTarget = null;

  // Quell-Element kann aus dem DOM fallen, während der Tooltip sichtbar ist
  // (Alpine x-show/Re-Render, Karten-/Seitenwechsel, Button rendert sich beim
  // Klick selbst neu). Dabei feuert kein mouseout — das Element wird nicht
  // verlassen, sondern entfernt. Ohne diesen Watcher bliebe der Tooltip
  // verwaist stehen, bis der nächste Hover/Klick ihn wegräumt.
  const removalWatcher =
    typeof MutationObserver === 'function'
      ? new MutationObserver(() => {
          if (currentTarget && !document.contains(currentTarget)) hide();
        })
      : null;

  function ensureLayer() {
    if (layer) return;
    layer = document.createElement('div');
    layer.className = 'tip-layer';
    layer.setAttribute('role', 'tooltip');
    layer.setAttribute('aria-hidden', 'true');
    bubble = document.createElement('div');
    bubble.className = 'tip-bubble';
    arrow = document.createElement('div');
    arrow.className = 'tip-arrow';
    layer.appendChild(bubble);
    layer.appendChild(arrow);
    document.body.appendChild(layer);
  }

  // Offenes <dialog> UND Native-Vollbild (Plot-/Motiv-/Recherche-/Bucheditor-Karte)
  // rendern im Top-Layer; Body-Kinder liegen dahinter und sind unsichtbar. Layer
  // pro Anzeige zum Ziel umhaengen — Wahl der Ebene in fullscreen.js#topLayerHost.
  function reparentLayer(target) {
    mountInTopLayer(layer, target);
  }

  function hide() {
    currentTarget = null;
    if (removalWatcher) removalWatcher.disconnect();
    if (!layer) return;
    layer.classList.remove('tip-visible');
    layer.setAttribute('aria-hidden', 'true');
  }

  function position(target) {
    if (!layer) return;
    // Vor dem Messen die Inline-Position neutralisieren: ein fixed/auto-width
    // Element berechnet seine Shrink-to-fit-Breite aus (Viewport − left). Ein
    // stale `left` vom vorher gezeigten Tooltip (rechtsbündige Header-Icons)
    // engt den Platz ein → langer Text bricht um → offsetWidth misst falsch.
    layer.style.left = '0px';
    layer.style.top = '0px';
    const rect = target.getBoundingClientRect();
    const lw = layer.offsetWidth;
    const lh = layer.offsetHeight;
    const margin = 8;
    let left = rect.left + rect.width / 2 - lw / 2;
    let top = rect.top - lh - 6;
    let placement = 'top';
    if (top < margin) {
      top = rect.bottom + 6;
      placement = 'bottom';
    }
    const maxLeft = window.innerWidth - lw - margin;
    if (left < margin) left = margin;
    else if (left > maxLeft) left = maxLeft;
    layer.style.left = Math.round(left) + 'px';
    layer.style.top = Math.round(top) + 'px';
    layer.dataset.placement = placement;
    const arrowLeft = rect.left + rect.width / 2 - left;
    arrow.style.left = Math.round(arrowLeft) + 'px';
  }

  function show(target) {
    const text = target.getAttribute('data-tip');
    if (!text) {
      hide();
      return;
    }
    ensureLayer();
    reparentLayer(target);
    currentTarget = target;
    bubble.textContent = text;
    layer.classList.add('tip-visible');
    layer.setAttribute('aria-hidden', 'false');
    position(target);
    if (removalWatcher) {
      removalWatcher.observe(document.body, { childList: true, subtree: true });
    }
  }

  function findTip(node) {
    if (!node || node.nodeType !== 1) return null;
    return node.closest('[data-tip]');
  }

  document.addEventListener('mouseover', (e) => {
    const t = findTip(e.target);
    if (t && t !== currentTarget) show(t);
    else if (!t && currentTarget) hide();
  });
  document.addEventListener('mouseout', (e) => {
    if (!currentTarget) return;
    const next = e.relatedTarget;
    if (next && currentTarget.contains(next)) return;
    if (next && findTip(next) === currentTarget) return;
    hide();
  });
  document.addEventListener('focusin', (e) => {
    const t = findTip(e.target);
    if (t) show(t);
  });
  document.addEventListener('focusout', () => hide());
  window.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
  // Programmatisches Ausblenden (z.B. wenn ein Klick ein Popover über demselben
  // Trigger öffnet und der Hover-Tooltip sonst darüber hängen bliebe).
  window.addEventListener(EVT.TOOLTIP_HIDE, hide);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide();
  });
})();
