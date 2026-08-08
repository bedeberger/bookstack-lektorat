// Status-Plakette am Editor-Eck: laeuft eine Pruefung, ist der Text sauber, wie
// viele Befunde stehen an, ist der Dienst aus, blockiert eine Browser-Erweiterung.
//
// Sitzt als Sibling von `root` (gleiches offsetParent) statt IM contenteditable
// — im Editor-Root waere sie ein Fremdknoten, den der Save-Pfad mitschriebe.

const NS = 'http://www.w3.org/2000/svg';
const XLINK = 'http://www.w3.org/1999/xlink';

function makeIcon(name) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'icon');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', `/icons.svg#${name}`);
  use.setAttributeNS(XLINK, 'xlink:href', `/icons.svg#${name}`);
  svg.appendChild(use);
  return svg;
}

// Zustand → Icon + i18n-Key des Tooltips. `matches` traegt zusaetzlich die Zahl.
const STATES = {
  extension: { icon: 'alert-triangle', key: 'spellcheck.extension_conflict.title' },
  error:     { icon: 'alert-triangle', key: 'spellcheck.status.error' },
  loading:   { icon: 'loader',         key: 'spellcheck.status.active' },
  matches:   { icon: 'alert-triangle', key: 'spellcheck.status.matches' },
  clean:     { icon: 'check',          key: 'spellcheck.status.no_matches' },
  disabled:  { icon: 'x',              key: 'spellcheck.status.disabled' },
};

/**
 * @param {object} deps
 * @param {Element} deps.root        das contenteditable, an dessen Ecke die Plakette klebt
 * @param {string}  deps.editorKind  'notebook' | 'focus' | 'book' (nur als data-Attribut)
 * @param {(key: string) => string} deps.i18n
 */
export function createBadge({ root, editorKind, i18n }) {
  let el = null;

  function syncPosition() {
    if (!el || !root) return;
    el.style.top  = `${root.offsetTop + 6}px`;
    el.style.left = `${root.offsetLeft + root.offsetWidth - 8}px`;
  }

  function ensure() {
    if (el) return el;
    el = document.createElement('div');
    el.className = 'lt-badge';
    el.setAttribute('data-editor', editorKind);
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    root.parentNode?.insertBefore(el, root.nextSibling);
    syncPosition();
    return el;
  }

  return {
    syncPosition,

    // Plakette anlegen, ohne schon einen Zustand zu behaupten. Beim Attach steht
    // sie darum leer da, bis der erste Check „prueft…" meldet — ein Haekchen an
    // dieser Stelle waere eine Aussage ueber einen Text, den noch niemand
    // angesehen hat.
    ensure,

    update(state, opts = {}) {
      ensure();
      syncPosition();
      el.setAttribute('data-state', state);
      const spec = STATES[state] || STATES.clean;
      let title = i18n(spec.key);
      let label = '';
      if (state === 'matches') {
        const n = Number(opts.count || 0);
        label = String(n);
        title = title.replace('{n}', String(n));
      }
      el.setAttribute('data-tip', title);
      el.setAttribute('aria-label', title);
      el.replaceChildren();
      const iconWrap = document.createElement('span');
      iconWrap.className = 'lt-badge__icon';
      iconWrap.appendChild(makeIcon(spec.icon));
      el.appendChild(iconWrap);
      if (label) {
        const labelSpan = document.createElement('span');
        labelSpan.className = 'lt-badge__label';
        labelSpan.textContent = label;
        el.appendChild(labelSpan);
      }
    },

    remove() {
      if (el && el.parentNode) el.parentNode.removeChild(el);
      el = null;
    },
  };
}
