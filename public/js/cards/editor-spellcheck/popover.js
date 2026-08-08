// Der Befund-Popover: Kategorie, Meldung, Ersetzungsvorschlaege, Ignorieren,
// „ins Woerterbuch", Regel-Info.
//
// Kapselt die vier Zustaende, die zusammengehoeren (Element, Host, Anker-Range,
// Tastatur-Controller) — der Controller sieht davon nur `open/close/remount/
// contains/isOpen/el`.
//
// Zwei Eigenheiten, die kein Zufall sind:
//   • JEDER `mousedown` im Popover ruft `preventDefault`. Die Buttons sitzen bei
//     Notebook/Focus INNERHALB des contenteditable-Subtrees; ohne das naehme der
//     Klick dem Editor die Selection weg, und die Ersetzung liefe ins Leere.
//   • Der Schliessen-Knopf zeigt das Glyph „×", nicht den uebersetzten Text. Der
//     macOS-Client speist die Popover-Strings aus seiner eigenen Bridge-i18n-Map
//     und faellt bei unbekannten Keys auf den rohen Key zurueck — dort stuende
//     sonst bis zum naechsten Client-Release „spellcheck.popover.close" im Button.
//     Die Uebersetzung traegt darum nur aria-label/Tooltip.

import { badgeClassFor, extractMatchedWord, isSpellingMatch } from './categories.js';
import { resolvePopoverHost, positionPopover } from './position.js';

const MAX_REPLACEMENTS = 5;

// Klick auf einen Popover-Knopf darf die Editor-Selection nicht verschieben.
function keepSelection(el) {
  el.addEventListener('mousedown', (ev) => ev.preventDefault());
  return el;
}

function button(className, text) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.textContent = text;
  return keepSelection(btn);
}

/**
 * @param {object} deps
 * @param {string} deps.editorKind
 * @param {(key: string) => string} deps.i18n
 * @param {() => Element|Window|null} deps.getScrollEl  Scroll-Box zur Host-Wahl
 * @param {({word, lang}) => Promise<boolean>} deps.addWord
 * @param {() => string} deps.getLang  Buch-Locale ('auto' → '*')
 */
export function createPopover({ editorKind, i18n, getScrollEl, addWord, getLang }) {
  let el = null;
  let host = null;
  let anchorRange = null;
  let keyCtrl = null;

  function close() {
    if (keyCtrl) { keyCtrl.abort(); keyCtrl = null; }
    if (el && el.parentNode) el.parentNode.removeChild(el);
    el = null;
    host = null;
    anchorRange = null;
  }

  function buildHeader(m) {
    const header = document.createElement('div');
    header.className = 'lt-popover__header';
    const catBadge = document.createElement('span');
    catBadge.className = `lt-popover__badge ${badgeClassFor(m)}`;
    catBadge.textContent = m.rule?.category?.name || m.shortMessage || '';
    header.appendChild(catBadge);
    if (m.shortMessage && m.shortMessage !== catBadge.textContent) {
      const title = document.createElement('span');
      title.className = 'lt-popover__title';
      title.textContent = m.shortMessage;
      header.appendChild(title);
    }
    const closeLabel = i18n('spellcheck.popover.close');
    const closeBtn = button('lt-popover__close', '×');
    closeBtn.setAttribute('aria-label', closeLabel);
    closeBtn.setAttribute('data-tip', closeLabel);
    closeBtn.addEventListener('click', () => close());
    header.appendChild(closeBtn);
    return header;
  }

  function buildReplacements(m, onApply) {
    const list = Array.isArray(m.replacements) ? m.replacements.slice(0, MAX_REPLACEMENTS) : [];
    if (list.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'lt-popover__empty';
      empty.textContent = i18n('spellcheck.popover.no_suggestions');
      return empty;
    }
    const wrap = document.createElement('div');
    wrap.className = 'lt-popover__replacements';
    for (const r of list) {
      const btn = button('lt-popover__replacement', r.value || '');
      btn.addEventListener('click', () => onApply(r.value || ''));
      wrap.appendChild(btn);
    }
    return wrap;
  }

  function buildFooter(m, { onIgnore, onDictAdded }) {
    const footer = document.createElement('div');
    footer.className = 'lt-popover__footer';

    const ignoreBtn = button('lt-popover__ignore', i18n('spellcheck.popover.ignore'));
    ignoreBtn.addEventListener('click', () => { onIgnore(); close(); });
    footer.appendChild(ignoreBtn);

    // „Ins Woerterbuch" nur bei Rechtschreibung und nur mit erkanntem Einzelwort.
    const word = isSpellingMatch(m) ? extractMatchedWord(m) : '';
    if (word) {
      const dictBtn = button('lt-popover__dict', i18n('spellcheck.popover.add_to_dict'));
      dictBtn.addEventListener('click', async () => {
        dictBtn.disabled = true;
        try {
          const ok = await addWord({ word, bookId: 0, lang: getLang() });
          if (ok) { onDictAdded(); close(); }
          else dictBtn.disabled = false;
        } catch { dictBtn.disabled = false; }
      });
      footer.appendChild(dictBtn);
    }

    const urlInfo = Array.isArray(m.rule?.urls) && m.rule.urls[0]?.value;
    if (urlInfo) {
      const link = document.createElement('a');
      link.href = urlInfo;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'lt-popover__info';
      link.textContent = i18n('spellcheck.popover.rule_info');
      footer.appendChild(link);
    }
    return footer;
  }

  function mount() {
    if (!el || !anchorRange) return;
    const anchorRect = anchorRange.getBoundingClientRect();
    // Host-Wahl + Geometrie in position.js. Beim Scroller-Host wird der Popover
    // Kind des contenteditable; der MutationObserver des Controllers filtert
    // popover-eigene Mutationen heraus (sonst triggert das Anhaengen einen
    // Re-Check, der die Squiggles wegnimmt bevor der User klicken kann).
    host = resolvePopoverHost(getScrollEl());
    host.appendChild(el);
    positionPopover(el, anchorRect, host);
  }

  function installDismissHandlers() {
    // Escape schliesst. Capture auf document, damit der Handler VOR den
    // Editor-eigenen Escape-Handlern laeuft — der Focus-Editor haengt seinen an
    // `window` in der Bubble-Phase (editor/focus/card.js) und wuerde sonst
    // gleichzeitig den Fokus-Modus verlassen. stopPropagation neutralisiert ihn
    // fuer genau diesen Tastendruck: erstes Escape schliesst nur den Popover,
    // zweites verhaelt sich wieder normal. Bewusst nicht ueber ein `app`-Flag wie
    // beim Synonym-/Figur-Overlay — der Controller ist host-agnostisch und kennt
    // keinen Alpine-Root.
    keyCtrl = new AbortController();
    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      close();
    }, { capture: true, signal: keyCtrl.signal });

    // Outside-Click schliesst. setTimeout: der aktuelle mousedown soll nicht
    // gleich wieder schliessen.
    setTimeout(() => {
      const onDocClick = (ev) => {
        if (!el) { document.removeEventListener('mousedown', onDocClick, true); return; }
        if (el.contains(ev.target)) return;
        close();
        document.removeEventListener('mousedown', onDocClick, true);
      };
      document.addEventListener('mousedown', onDocClick, true);
    }, 0);
  }

  return {
    isOpen: () => !!el,
    contains: (node) => !!el && el.contains(node),
    get el() { return el; },
    close,

    // Nur neu positionieren (Resize) — ohne Rebuild.
    remount() {
      if (!el || !anchorRange || !host) return;
      positionPopover(el, anchorRange.getBoundingClientRect(), host);
    },

    /**
     * @param {{match: object, range: Range}} entry
     * @param {{onApply:(text:string)=>void, onIgnore:()=>void, onDictAdded:()=>void}} handlers
     */
    open(entry, handlers) {
      close();
      const m = entry.match;
      anchorRange = entry.range;

      el = document.createElement('div');
      el.className = 'lt-popover';
      el.setAttribute('role', 'dialog');
      el.setAttribute('contenteditable', 'false');
      el.setAttribute('data-editor', editorKind);
      keepSelection(el);

      el.appendChild(buildHeader(m));
      if (m.message) {
        const msg = document.createElement('p');
        msg.className = 'lt-popover__message';
        msg.textContent = m.message;
        el.appendChild(msg);
      }
      el.appendChild(buildReplacements(m, handlers.onApply));
      el.appendChild(buildFooter(m, handlers));

      mount();
      installDismissHandlers();
    },
  };
}
