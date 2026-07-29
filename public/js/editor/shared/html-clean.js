// Editor-übergreifende HTML-Bereinigung. Single source für Normal- und
// Focus-Editor, damit beide bit-identisch normalisieren. Eingangspunkte:
// - vor Save (stripLektoratMarks): Korrekturvorschlags-Markup raus
// - für Dirty-Vergleich (normalizeForCompare): roher Server-HTML vs.
//   contenteditable-HTML auf eine Vergleichs-Normalform bringen
// - bei Edit-Start (normalizeEditorBlocks): orphan Text-/Inline-Runs in <p>
//   verpacken, damit Block-Erkennung greift
//
// Server-Pendant ist lib/html-clean.js (cleanPageHtml am Save-Chokepoint);
// Client normalisiert dieselbe Form vorab, damit der Vergleich gegen den
// Originalstand stimmt.

import {
  stripFocusArtefacts,
  cleanContentArtefacts,
  collapseEmptyBlocks,
  stripTrailingEmptyBlocks,
} from '../../utils.js';

export {
  stripFocusArtefacts,
  cleanContentArtefacts,
  collapseEmptyBlocks,
  stripTrailingEmptyBlocks,
};

// Parst ein HTML-Fragment in ein detached <div>, ohne den innerHTML-Setter zu
// nutzen. Identisches Verhalten zum klassischen `tmp.innerHTML = out`-Pattern
// (beide gehen durch denselben HTML5-Parser), aber das resultierende Element
// hängt nie im Live-DOM — Lektorat-Marks sind Korrektur-Wrapper aus dem
// Editor-Eigeninhalt (kein externer User-Input).
function parseFragment(html) {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  return doc.body.firstElementChild || null;
}

// Entfernt Korrekturvorschlags-Markup:
//   - .lektorat-ins / .chat-mark-ins → komplett entfernen (nur Vorschlagstext)
//   - .lektorat-mark / .chat-mark → unwrap (Originaltext behalten)
//   - .lt-popover / .lt-badge → komplett entfernen (LanguageTool-UI, s.u.)
// Danach via collapse/cleaner durch die gleichen Filter wie der Save-Pfad.
export function stripLektoratMarks(html) {
  let out = html;
  const hasMark = out && (out.indexOf('lektorat-mark') !== -1 || out.indexOf('chat-mark') !== -1);
  const hasIns = out && (out.indexOf('lektorat-ins') !== -1 || out.indexOf('chat-mark-ins') !== -1);
  // LanguageTool-UI haengt zur Laufzeit als contenteditable="false"-Insel IM
  // Editier-Root (damit Scroll sie nativ mitnimmt). Wer bei offenem Popover
  // speichert, persistiert sonst das komplette UI-Markup samt <button>/<svg> in
  // die Revision — und bekommt es beim naechsten Laden als Inhalt zurueck.
  // Der Trigger gehoert zwingend in diese Bedingung: sonst greift der
  // Early-Return und der Filter unten laeuft nie.
  const hasLtUi = out && (out.indexOf('lt-popover') !== -1 || out.indexOf('lt-badge') !== -1);
  // `contenteditable` ist Editor-Laufzeit, kein Inhalt: der Quellen-Chip
  // (public/js/sources/cite-html.js) bekommt es beim Mount gesetzt, damit der
  // Caret ihn ueberspringt. Bliebe es in der Vergleichsform stehen, gaelte jede
  // Seite mit Quellenangabe direkt beim Oeffnen als veraendert — Autosave, Revision und
  // updated_at-Bump bei jedem blossen Hinsehen. Server-Pendant:
  // lib/html-clean.js#stripEditorUiArtefacts.
  const hasEditableAttr = out && out.indexOf('contenteditable') !== -1;
  if (hasMark || hasIns || hasLtUi || hasEditableAttr) {
    const tmp = parseFragment(out);
    if (tmp) {
      tmp.querySelectorAll('.lt-popover, .lt-badge').forEach(ui => {
        ui.parentNode?.removeChild(ui);
      });
      tmp.querySelectorAll('[contenteditable]').forEach(el => {
        el.removeAttribute('contenteditable');
      });
      tmp.querySelectorAll('.lektorat-ins, .chat-mark-ins').forEach(ins => {
        ins.parentNode?.removeChild(ins);
      });
      tmp.querySelectorAll('.lektorat-mark, .chat-mark').forEach(mark => {
        const parent = mark.parentNode;
        if (!parent) return;
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
        parent.removeChild(mark);
      });
      out = tmp.innerHTML;
    }
  }
  return stripTrailingEmptyBlocks(collapseEmptyBlocks(cleanContentArtefacts(stripFocusArtefacts(out))));
}

// Block-Tags, die der Editor-Root als gültigen Block akzeptiert. Alles andere
// (bare Text-Nodes, Inline-Elements) wird via normalizeEditorBlocks in <p>
// gewrapt.
export const ROOT_BLOCK_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'LI', 'PRE', 'UL', 'OL', 'TABLE',
  'FIGURE', 'HR', 'DIV', 'DL', 'SECTION', 'ARTICLE',
  'ASIDE', 'HEADER', 'FOOTER', 'NAV', 'MAIN', 'FORM',
]);

// Mutiert el in-place: orphan Text-/Inline-Runs zwischen Block-Tags werden in
// <p> gewrapt. Idempotent — zweiter Lauf macht nichts mehr.
export function normalizeEditorBlocks(el) {
  if (!el) return;
  let group = [];
  const flushBefore = (target) => {
    if (!group.length) return;
    const hasContent = group.some(n =>
      (n.nodeType === 3 && n.textContent.replace(/ /g, ' ').trim()) ||
      (n.nodeType === 1)
    );
    if (!hasContent) { group = []; return; }
    const p = el.ownerDocument.createElement('p');
    for (const n of group) p.appendChild(n);
    if (target) el.insertBefore(p, target);
    else el.appendChild(p);
    group = [];
  };
  const children = Array.from(el.childNodes);
  for (const child of children) {
    if (child.nodeType === 1 && ROOT_BLOCK_TAGS.has(child.tagName)) {
      flushBefore(child);
    } else {
      group.push(child);
    }
  }
  flushBefore(null);
}

// Gemeinsame Normalform für Dirty-Vergleich: Original-HTML vom Server und
// contenteditable-HTML aus dem Browser durch denselben DOM-Roundtrip +
// Block-Normalizer + Cleaner. Ohne diese Vereinheitlichung schlägt
// `newHtml === originalHtml` byte-genau fehl, obwohl semantisch identisch
// (Whitespace, Attribut-Reihenfolge, self-closing, fehlende <p>-Wrapper).
export function normalizeForCompare(html) {
  if (!html) return '';
  const wrap = parseFragment(html);
  if (!wrap) return '';
  normalizeEditorBlocks(wrap);
  return stripLektoratMarks(wrap.innerHTML);
}
