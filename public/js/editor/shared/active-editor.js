// Active-Editor-Lookup. Damit mode-agnostische Sub-Komponenten (Synonyme,
// Figuren-Lookup) den Ziel-Container finden, ohne Mode-Flag abzufragen.
// Smart-Switch: wenn ein Focus-Cardroot (`.focus-editor`) im DOM existiert
// und der App-State `focusActive` meldet, gewinnt der Focus-Container.
// Sonst → Normal-Editor-Container.

import { editorHost } from './editor-host.js';

// Exportiert, damit der DOM-Roundtrip des Fokusmodus (focus/mirror.js) dieselben
// beiden Selektoren benutzt wie der Smart-Switch. Zwei Definitionen desselben
// Containers wären genau die Drift, die den Roundtrip in einen leeren Klon
// laufen liesse.
export const NORMAL_SELECTOR = '#editor-card .page-content-view--editing';
// `.is-active` filtert den Skeleton-Cardroot (x-show=false, ohne `.is-active`) aus.
export const FOCUS_SELECTOR = '.focus-editor.is-active .focus-editor__content';

// Liefert das contenteditable des aktiven Editors oder null, wenn kein
// Editor offen ist. Focus-Container greift nur, wenn er nicht display:none
// ist (offsetParent !== null) — sonst würden Sub-Komponenten in einen
// unsichtbaren Container schreiben.
export function getActiveEditorContainer() {
  const app = editorHost();
  if (app?.focusActive) {
    const focusEl = document.querySelector(FOCUS_SELECTOR);
    if (focusEl && focusEl.offsetParent !== null) return focusEl;
  }
  return document.querySelector(NORMAL_SELECTOR);
}

// 'normal' | 'focus' | null. Beruht auf `focusActive` als SSoT.
export function getActiveEditorMode() {
  const app = editorHost();
  if (!app) return null;
  if (app.focusActive) return 'focus';
  if (app.editMode) return 'normal';
  return null;
}
