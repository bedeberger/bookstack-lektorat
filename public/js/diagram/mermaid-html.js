// Diagramm-Block im Seiten-HTML — SSoT fuer Markup, Selektoren und das Auslesen.
// Jeder Pfad, der Diagramme erzeugt, findet oder rendert, geht hier durch:
// Einfuegen im Notebook-Editor, Mount ins contenteditable, Leseansichten,
// Share-Reader und alle Exportwege (HTML/EPUB/Markdown/PDF/DOCX).
//
// Persistiertes Markup:
//   <pre class="mermaid">graph TD;\n  A[Anfang] --> B[Ende];</pre>
//
// DER QUELLTEXT IST DIE WAHRHEIT, das gerenderte Bild ist ein Artefakt.
// In `pages.content` steht ausschliesslich der Diagramm-Code; kein SVG, kein
// PNG, keine Bild-URL. Gruende:
//   - Ein gerendertes SVG ist von der Mermaid-Version abhaengig. Waere es
//     persistiert, truege das Manuskript den Rendering-Stand vom Einfuegetag
//     bis in alle Ewigkeit — und ein Theme-Wechsel (hell/dunkel) koennte ihn
//     nicht mehr einholen.
//   - Der Code ist diffbar. Ein Fassungs-Vergleich (book_snapshots) zeigt
//     „Kante hinzugefuegt", nicht „12 kB Binaerdaten geaendert".
//   - Derselbe Grund wie beim Quellen-Chip: eine Schicht, die das Artefakt fuer
//     die Wahrheit haelt, friert einen Zwischenstand ein.
// Daraus folgt die Arbeitsteilung: der Browser rendert fuer den Bildschirm
// (vendor/mermaid), der Server rendert fuer den Export (lib/mermaid-render.js)
// — beide aus demselben Quelltext, keiner schreibt ihn zurueck.
//
// Warum `<pre>` und nicht ein eigenes Tag: `pre` ist bereits ueberall
// durchgereicht (html-clean, PDF-Walker, Exporter, Block-IDs) und faellt ohne
// jede Sonderbehandlung auf den Quelltext zurueck. Ein Diagramm, das nirgends
// gerendert werden kann, zeigt dann seinen Code statt zu verschwinden — das ist
// die richtige Degradation.
//
// Bewusst NICHT im persistierten Markup: `contenteditable="false"`. Das setzt
// der Editor beim Mount (markDiagramsAtomic), und lib/html-clean.js strippt es
// beim Speichern wieder.
//
// Modul ist DOM-agnostisch (Browser-DOM wie linkedom auf dem Server) — darum
// genau eine Implementierung fuer beide Seiten, serverseitig per dynamic
// import() geladen (Muster wie public/js/sources/cite-html.js).

import { escHtml } from '../utils/escape.js';

export const DIAGRAM_CLASS = 'mermaid';
export const DIAGRAM_SEL = `pre.${DIAGRAM_CLASS}`;
// Deckel gegen ein versehentlich eingefuegtes Buch: mermaid rendert alles, was
// man ihm gibt, und ein Diagramm mit 5000 Knoten blockiert den Renderer.
export const DIAGRAM_MAX_CHARS = 20000;

/** Ist `el` ein Diagramm-Block? */
export function isDiagramEl(el) {
  return !!el && el.tagName === 'PRE' && !!el.classList?.contains?.(DIAGRAM_CLASS);
}

/** Naechster Diagramm-Block ab `node` aufwaerts (Textknoten erlaubt). */
export function closestDiagramEl(node, root = null) {
  const el = node && node.nodeType === 3 ? node.parentNode : node;
  const hit = el?.closest?.(DIAGRAM_SEL);
  if (!hit) return null;
  if (root && !root.contains(hit)) return null;
  return hit;
}

/** Quelltext eines Diagramm-Blocks. `textContent`, nicht `innerHTML`: was der
 *  Nutzer geschrieben hat, ist Text — ein `<` darin ist ein Zeichen, kein Tag. */
export function diagramCode(el) {
  return (el?.textContent || '').replace(/ /g, ' ').trim();
}

/** Markup fuer einen Diagramm-Block. Einziger Erzeuger — kein Konsument baut
 *  den `<pre class="mermaid">`-String selbst zusammen. */
export function buildDiagramHtml(code) {
  return `<pre class="${DIAGRAM_CLASS}">${escHtml(String(code ?? '').trim())}</pre>`;
}

/** Alle Diagramme unter `root`, in Dokumentreihenfolge.
 *  Leere Bloecke fallen raus — ein Diagramm ohne Code ist kein Diagramm, und
 *  mermaid quittiert es mit einer Fehlergrafik. */
export function collectDiagrams(root) {
  if (!root?.querySelectorAll) return [];
  const out = [];
  for (const el of root.querySelectorAll(DIAGRAM_SEL)) {
    const code = diagramCode(el);
    if (code) out.push({ el, code });
  }
  return out;
}

/** Diagramme im contenteditable atomar machen: der Caret springt darueber,
 *  Backspace loescht den Block als Ganzes. Der Quelltext wird ausschliesslich
 *  ueber den Dialog bearbeitet — freies Tippen in einem `<pre>` erzeugt in
 *  Chromium `<div>`-Zeilen und zerlegt den Code.
 *
 *  Setzt nur Laufzeit-Attribute; nichts davon wird persistiert. */
export function markDiagramsAtomic(root) {
  if (!root?.querySelectorAll) return;
  for (const el of root.querySelectorAll(DIAGRAM_SEL)) {
    el.setAttribute('contenteditable', 'false');
  }
}

/** Stabiler Schluessel fuer einen Diagramm-Quelltext (Cache, DOM-IDs).
 *  Kein kryptografischer Anspruch — es geht um „ist das dasselbe Diagramm".
 *  Bewusst hier und nicht in einem Konsumenten: der Browser-Cache und der
 *  Server-Cache muessen denselben Code als denselben erkennen. */
export function diagramKey(code) {
  const s = String(code ?? '');
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(36) + h2.toString(36)).slice(0, 16);
}
