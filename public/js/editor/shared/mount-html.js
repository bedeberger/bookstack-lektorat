// HTML in ein contenteditable einhängen — SSoT für alle Pfade, die den
// Editor-Inhalt komplett ersetzen: `startEdit` (Session-Start), Undo/Redo-
// Restore (notebook/history.js) und das Spiegeln eines gemergten Stands
// (`_applyMergedToEditor`).
//
// Warum gebündelt: rohes `el.innerHTML = html` reproduziert zwei Defekte, die
// `startEdit` einzeln behandelte und die Restore-Pfade vergessen hatten —
// orphan Text-/Inline-Runs direkt unter dem Editor-Root (Block-Erkennung des
// Fokusmodus greift nicht) und ein letzter Block ohne Caret-Slot (kindloses
// `<p>` ist zero-height, `<hr>` ist void → kein Schreib-Anker am Seitenende).
//
// Persistenz-Effekt: keiner. `<p><br></p>` strippt der Server-Cleaner
// (lib/html-clean.js#cleanPageHtml) beim Save wieder, und `normalizeForCompare`
// ignoriert es im Dirty-Vergleich.

import { normalizeEditorBlocks } from './html-clean.js';
import { ensureTrailingParagraph } from './auto-slot.js';
import { markCitesAtomic } from '../../sources/cite-html.js';
import { markXrefsAtomic } from '../../xrefs/xref-html.js';

// Setzt `html` in `el` und stellt Block-Konsistenz + Caret-Slot her.
// Liefert `{ repaired }` — true, wenn `normalizeEditorBlocks` am gelieferten
// HTML etwas ändern musste (Legacy-Markup). Der Aufrufer entscheidet, ob er
// die Reparatur persistiert (`startEdit` setzt dafür `editDirty`, sonst kehrt
// der Defekt nach jedem Reload zurück).
export function mountEditorHtml(el, html) {
  if (!el) return { repaired: false };
  const doc = el.ownerDocument || globalThis.document;
  if (html) {
    el.innerHTML = html;
  } else {
    // Leere Seite: Platzhalter-Absatz, damit der Cursor einen Block hat (sonst
    // landen erste Zeichen als orphan-Textnode direkt unter dem Editor-Root).
    const p = doc.createElement('p');
    p.appendChild(doc.createElement('br'));
    el.replaceChildren(p);
  }
  const beforeNormalize = el.innerHTML;
  normalizeEditorBlocks(el);
  const repaired = el.innerHTML !== beforeNormalize;
  ensureCaretSlot(el);
  // Quellen-Chips atomar machen (Caret springt darueber, Backspace loescht ganz).
  // Bewusst NACH der Repaired-Messung: `contenteditable="false"` ist
  // Editor-Laufzeit, keine Inhaltsreparatur — sonst gaelte jede Seite mit Quellenangabe
  // beim Oeffnen als veraendert und wuerde ungefragt neu gespeichert.
  markCitesAtomic(el);
  markXrefsAtomic(el);
  return { repaired };
}

// Caret-Slot am Ende des Editors sicherstellen. Zwei Fälle:
//   kindloses `<p>`  → `<br>` als Schreib-Slot ergänzen (zero-height sonst)
//   trailing `<hr>`  → Folge-Absatz anhängen (void-Element, kein Caret-Slot)
export function ensureCaretSlot(el) {
  if (!el) return;
  const doc = el.ownerDocument || globalThis.document;
  const lastBlock = el.lastElementChild;
  if (!lastBlock) return;
  if (lastBlock.tagName === 'P' && !lastBlock.hasChildNodes()) {
    lastBlock.appendChild(doc.createElement('br'));
  } else if (lastBlock.tagName === 'HR') {
    ensureTrailingParagraph(el);
  }
}
