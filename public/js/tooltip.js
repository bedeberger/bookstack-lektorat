// Geteilter Tooltip-Layer für [data-tip].
// Ein einziges DOM-Element wird bei Hover/Focus auf ein [data-tip]-Element
// positioniert und befüllt. Hält die Pseudo-Slots auf den Targets frei,
// damit ::before/::after dort für eigene Decorations verfügbar bleiben.
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__tooltipLayerInstalled) return;
  window.__tooltipLayerInstalled = true;

  let layer = null;
  let arrow = null;
  let bubble = null;
  let currentTarget = null;

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

  function hide() {
    currentTarget = null;
    if (!layer) return;
    layer.classList.remove('tip-visible');
    layer.setAttribute('aria-hidden', 'true');
  }

  function position(target) {
    if (!layer) return;
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
    currentTarget = target;
    bubble.textContent = text;
    layer.classList.add('tip-visible');
    layer.setAttribute('aria-hidden', 'false');
    position(target);
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
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide();
  });
  // Source-Element kann aus dem DOM verschwinden (Alpine x-show, Re-Render).
  // Vor jedem Klick prüfen und ggf. Tooltip ausblenden.
  document.addEventListener('click', (e) => {
    if (currentTarget && !document.contains(currentTarget)) hide();
  }, true);
})();
