// Wendet ein Ersatzwort (Spellcheck-/LanguageTool-Vorschlag, Synonym) auf eine
// DOM-Range an.
//
// Einzige Quelle für die Range-Mutation + Caret-Wiederherstellung. Vier
// Konsumenten: SPA-Spellcheck-Dispatcher ([cards/editor-spellcheck/dispatch.js]),
// SPA-Synonym-Picker ([editor/synonyme.js]) und die fremde Schale (nativer
// Mac-Focus-Writer: [cards/editor-spellcheck/controller.js] +
// [cards/editor-synonyme/controller.js], eigene onApplyReplacement-Verdrahtung).
// Alle ziehen diese Funktion, damit die Caret-Logik nicht an vier Stellen
// driftet. Darum auch explizit im OTA-Bundle ([lib/editor-bundle.js]).
//
// Der Name nennt nur den ersten Konsumenten und bleibt trotzdem stehen: die
// Funktion ist Teil des OTA-Editor-Bundles, ein Rename erreicht die nativen
// Clients erst nach einem Server-Deploy — Risiko ohne Verhaltensgewinn.
//
// Caret landet am Ende des EINGEFÜGTEN Text-Knotens — also IN dem Absatz.
// NICHT hinter `range.endContainer`: beim Text-Node-Split durch
// deleteContents/insertNode rutscht die End-Boundary der Range auf das
// Block-Element (<p>). Ein Caret „hinter dem <p>" wird vom Browser in den
// nächsten (leeren) Absatz normalisiert; im Fokusmodus desynct dadurch
// zusätzlich das Spotlight (Anchor ausserhalb jedes Blocks → das Recenter
// fällt auf den Viewport-Center-Block zurück statt auf den korrigierten).
//
// Dispatcht ein bubbelndes `input`-Event auf dem nächsten contenteditable-Host,
// damit der Save-Pfad des jeweiligen Editors greift. Liefert true bei Erfolg.
export function applySpellcheckReplacement(range, text) {
  if (!range) return false;
  const startEl = range.startContainer?.parentElement || null;
  const inserted = document.createTextNode(text);
  try {
    range.deleteContents();
    range.insertNode(inserted);
  } catch { return false; }
  try {
    const sel = window.getSelection();
    sel?.removeAllRanges();
    const r2 = document.createRange();
    r2.setStart(inserted, inserted.length);
    r2.collapse(true);
    sel?.addRange(r2);
  } catch { /* Selection-API-Edge-Cases: Caret-Restore ist kosmetisch */ }
  const host = startEl?.closest('[contenteditable="true"]')
    || inserted.parentElement?.closest?.('[contenteditable="true"]')
    || null;
  if (host) host.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}
