// Geteilte Imports + Modul-Konstanten der notebookEditMethods-Submodule.
import { htmlToText, tzOpts, localeTag, findInHtml } from '../../../utils.js';
import { handleEditorPaste, handleEditorCopy, handleEditorCut } from '../../shared/paste.js';
import { sortByPosition } from '../../../book/page-view.js';
import { contentRepo } from '../../../repo/content.js';
import { readDraft, writeDraft, clearDraft } from '../../draft-storage.js';
import { stripLektoratMarks } from '../../shared/html-clean.js';
import { isNoChange } from '../../shared/save-pipeline.js';
import { savePage, isPageConflict, readConflictBody } from '../../shared/page-api.js';
import { mergeBlocks, mergedToHtml, buildResolvedHtml } from '../../shared/block-merge.js';
import { trackMerge } from '../../shared/merge-telemetry.js';
import { FEATURE_BLOCK_MERGE } from '../../../app/app-state.js';
import { getActiveEditorContainer } from '../../shared/active-editor.js';
import { editorHost } from '../../shared/editor-host.js';
import { installEditCounter } from '../../shared/edit-counter.js';
import { writeNormalSnapshot, clearNormalSnapshot, readEditorPrefs, writeEditorPrefs, ZOOM_MIN, ZOOM_MAX } from '../storage.js';
import { runQuoteNormalize } from '../../shared/quote-normalize.js';
import { mountEditorHtml } from '../../shared/mount-html.js';
import { findBlock } from '../../shared/dom-block.js';
import { EVT } from '../../../events.js';

// Auto-Save: idle-debounce + max-Cap. Regel und Werte liegen in
// editor/shared/autosave.js — geteilt mit dem Bucheditor, damit die beiden
// Editoren nicht mit unterschiedlichem Rhythmus speichern. Die Timer-Handles
// bleiben hier am Root-Host (siehe autosave.js in diesem Ordner).
export { AUTOSAVE_IDLE_MS, AUTOSAVE_MAX_MS } from '../../shared/autosave.js';
export const DRAFT_DEBOUNCE_MS = 500;
// stripLektoratMarks / normalizeForCompare / normalizeEditorBlocks /
// ROOT_BLOCK_TAGS leben in public/js/editor/shared/html-clean.js — dieselbe
// Lib wird auch vom Focus-Editor konsumiert. Die Block-Normalisierung erreichen
// die Submodule hier ueber shared/mount-html.js (`mountEditorHtml`), das sie
// zusammen mit dem Caret-Slot anwendet.


// Sub-Methoden der Card `editorNotebookCard`. Alle State-Touches gegen
// `window.__app` (Root). Aufruf von extern: über die Trampoline-Forwarder
// in [trampoline.js] am Root-Spread (`app.startEdit()` → `__notebookCard.startEdit()`).

export { EVT, FEATURE_BLOCK_MERGE, ZOOM_MAX, ZOOM_MIN, buildResolvedHtml, clearDraft, clearNormalSnapshot, contentRepo, editorHost, findBlock, findInHtml, getActiveEditorContainer, handleEditorCopy, handleEditorCut, handleEditorPaste, htmlToText, installEditCounter, isNoChange, isPageConflict, localeTag, mergeBlocks, mergedToHtml, mountEditorHtml, readConflictBody, readDraft, readEditorPrefs, runQuoteNormalize, savePage, sortByPosition, stripLektoratMarks, trackMerge, tzOpts, writeDraft, writeEditorPrefs, writeNormalSnapshot };
