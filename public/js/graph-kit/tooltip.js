// Hover-Tooltip für die vis-network-Graphen. Der Tooltip ist ein absolut
// positioniertes Element im Graph-Wrapper; die Positionierung klemmt ihn an den
// Container-Rändern und klappt bei Bedarf auf die andere Cursor-Seite.
//
// Der HTML-Inhalt kommt vom Aufrufer und MUSS bereits aus escHtml()-Atomen
// zusammengesetzt sein (Escape-Invariante, siehe harte Regel „`x-html` nur mit
// vorab-escaptem Content" — hier gilt dasselbe für die innerHTML-Sink).

// Pure Geometrie: Cursor-Position (relativ zum Container) + Tooltip-Grösse →
// Position innerhalb des Containers. Ohne DOM, damit testbar.
export function clampTipPos({ cx, cy, tipW, tipH, boxW, boxH, offset = 14 }) {
  let left = cx + offset;
  let top = cy + offset;
  if (left + tipW > boxW) left = cx - tipW - offset;
  if (top + tipH > boxH) top = cy - tipH - offset;
  return { left: Math.max(0, left), top: Math.max(0, top) };
}

// Tooltip-Steuerung für einen Container. `tip` ist das Tooltip-Element
// (`.graph-tooltip`); fehlt es, sind show/hide No-ops.
export function createGraphTooltip(container, tip) {
  if (!tip) return { show() {}, hide() {} };
  return {
    // html: bereits escapte Atome (siehe Kopfkommentar).
    show(html, clientX, clientY) {
      tip.innerHTML = html;
      // Erst an 0/0 sichtbar machen, dann messen — offsetWidth/Height sind bei
      // display:none null, die Klemmung liefe sonst gegen 0-Grössen.
      tip.style.left = '0px';
      tip.style.top = '0px';
      tip.classList.add('visible');
      const rect = container.getBoundingClientRect();
      const { left, top } = clampTipPos({
        cx: clientX - rect.left,
        cy: clientY - rect.top,
        tipW: tip.offsetWidth,
        tipH: tip.offsetHeight,
        boxW: container.offsetWidth,
        boxH: container.offsetHeight,
      });
      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
    },
    hide() {
      tip.classList.remove('visible');
    },
  };
}
