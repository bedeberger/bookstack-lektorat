// Native Browser-Fullscreen-Helper.
//
// `toggleWrapFullscreen(wrap)` — Enter/Exit auf das gegebene Element. Wirft,
// wenn `requestFullscreen` rejected (iOS Safari ohne API, Permissions-Policy,
// Permission-Denial). Caller fängt für CSS-Overlay-Fallback ab.
//
// `attachFullscreenSync({ resolveWrap, onChange, signal })` — registriert
// einen `fullscreenchange`-Listener am document und ruft `onChange(active)`
// mit aktuellem Match-Status. `resolveWrap` als Funktion, damit lazy/erst
// später gemountete Wraps unterstützt werden. `signal` (AbortController) für
// automatisches Abmelden via Card-Lifecycle.
//
// `topLayerHost(target)` / `mountInTopLayer(el, target)` — SSoT dafür, WOHIN ein
// schwebendes Element (Tooltip, Popover, Modal-Overlay) gehört, damit es sichtbar
// bleibt. **Why:** ein `<dialog open>` und ein Fullscreen-Element rendern im
// Top-Layer; alles darunter — also jedes `<body>`-Kind — liegt hinter dem
// `::backdrop` und ist unsichtbar. Ein nach `body` gehängtes Overlay verschwindet
// dort also lautlos, während sein State korrekt „offen" sagt. Statisch
// teleportierbare Popover einer Vollbild-Karte lösen das über ihr Teleport-Ziel
// (die Karten-Wurzel, siehe docs/plot.md); global lebende Elemente können das
// nicht und müssen zur Anzeigezeit umgehängt werden.

export async function toggleWrapFullscreen(wrap) {
  if (!wrap) return;
  if (document.fullscreenElement === wrap) {
    try { await document.exitFullscreen(); } catch {}
    return;
  }
  if (document.fullscreenElement) {
    try { await document.exitFullscreen(); } catch {}
  }
  await wrap.requestFullscreen();
}

export function attachFullscreenSync({ resolveWrap, onChange, signal }) {
  const handler = () => {
    const wrap = typeof resolveWrap === 'function' ? resolveWrap() : resolveWrap;
    onChange(!!wrap && document.fullscreenElement === wrap);
  };
  document.addEventListener('fullscreenchange', handler, signal ? { signal } : undefined);
  return handler;
}

// Der Knoten, unter dem ein schwebendes Element aktuell sichtbar ist.
// `target` = das Element, auf das sich das Schwebende bezieht (Tooltip-Trigger).
// Ohne `target` gilt allein das Fullscreen-Element (global lebende Overlays wie
// die Command-Palette gehören immer in den obersten Top-Layer).
// Das `contains`-Gate verhindert, dass ein Tooltip für ein Ziel AUSSERHALB des
// Vollbilds in den Top-Layer wandert und dort neben seinem unsichtbaren Trigger
// schwebt.
export function topLayerHost(target) {
  const dlg = target?.closest?.('dialog[open]');
  if (dlg) return dlg;
  const fs = document.fullscreenElement;
  if (fs && (!target || fs === target || fs.contains(target))) return fs;
  return document.body;
}

// `el` unter den passenden Host hängen (No-Op, wenn es schon dort liegt — ein
// `appendChild` auf denselben Parent würde den Knoten neu einfügen und dabei
// CSS-Transitions/Fokus verlieren). Gibt den Host zurück.
export function mountInTopLayer(el, target) {
  const host = topLayerHost(target);
  if (el && el.parentNode !== host) host.appendChild(el);
  return host;
}
