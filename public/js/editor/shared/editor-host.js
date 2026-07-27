// Host-Facade für die Editoren (Notebook + Focus teilen sie via shared/).
//
// Der Editor-Kern greift NICHT direkt auf `window.__app` zu, sondern über
// `editorHost()`. Damit ist der Editor von der SPA-Root entkoppelt und in einer
// fremden Schale (z.B. dem nativen Mac-Focus-Writer in einer WKWebView, ohne
// Alpine-Root) lauffähig: die Schale injiziert via `setEditorHost()` einen
// eigenen Host, der denselben Vertrag erfüllt.
//
// Liegt unter shared/ (nicht focus/), weil auch mode-agnostische Helfer wie
// shared/active-editor.js den Host brauchen — und kein Editor JS-mässig auf
// einen anderen abstützen soll.
//
// Vertrag (vom Editor-Kern konsumiert — Spiegel der Felder, die die SPA-Root und
// die Test-Harness in tests/fixtures/focus-harness.html bereitstellen):
//   Lesefelder:  editMode, showEditorCard, focusActive, editDirty, editSaving,
//                focusGranularity, typewriterAnchor, contentLocale,
//                currentPage{ id }, renderedPageHtml,
//                originalHtml, _figurLookupOpen, _synonymMenuOpen,
//                _synonymPickerOpen, _editCounterCtx
//   Schreibfelder: focusActive, editMode, editSaving, saveOffline, lastDraftSavedAt
//   Methoden (alle optional via ?.()): startEdit, cancelEdit, quickSave,
//                _flushDraftSaveNow, _markEditDirty, _stopAutosave,
//                _uninstallOnlineRetry, closeSynonymMenu, closeSynonymPicker,
//                closeFigurLookup, _syncPageStatsAfterSave, updatePageView
//
// Default: `window.__app` (reaktiver Alpine-Root-Proxy). Wird KEIN Host
// injiziert, verhält sich der Editor exakt wie zuvor — die SPA bleibt
// unverändert.

let _host = null;

// Injektionspunkt für fremde Schalen. `null` setzt auf den SPA-Default zurück.
export function setEditorHost(host) {
  _host = host || null;
}

// Liefert den aktiven Host. In der SPA (kein injizierter Host) ist das der
// reaktive `window.__app`-Proxy — als Getter aufgelöst, damit die Reaktivität
// erhalten bleibt (kein Capturing einer veralteten Referenz).
export function editorHost() {
  if (_host) return _host;
  return (typeof window !== 'undefined') ? window.__app : null;
}
