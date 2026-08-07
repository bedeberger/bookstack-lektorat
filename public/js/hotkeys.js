// SSoT der Tastenkürzel-Hinweise IM TOOLTIP eines Action-Icons ("Fett (⌘B)").
//
// Das Kürzel-Overlay ([partials/shortcuts.html](../partials/shortcuts.html), `?`)
// dokumentiert alle Kürzel vollständig; hier stehen nur die, die zusätzlich an
// einem Icon hängen — der Hinweis soll neben der Aktion stehen, statt im Overlay
// gesucht werden zu müssen. Kürzel ohne Icon (F9-Chef-Taste, Tab-Einrückung im
// Organizer, `?`/`/`) gehören deshalb bewusst NICHT in diese Tabelle.
//
// Die Bindings selbst leben weiterhin dort, wo sie gebraucht werden (index.html,
// editor/notebook/toolbar/keydown.js, cards/*-card.js). Diese Tabelle ist reine
// ANZEIGE — sie bindet nichts. Drift zwischen ihr und dem Overlay ist durch
// tests/unit/hotkey-tips.test.mjs gegated.
import { tRaw } from './i18n.js';

// `mod` = ⌘ auf dem Mac, Strg sonst. `ctrl` = ausdrücklich Strg/⌃ auf beiden
// Plattformen (Ctrl+Enter für das Lektorat ist nur an ctrlKey gebunden).
// Named Keys (`enter`, `esc`) werden über `shortcuts.key.*` übersetzt.
export const HOTKEYS = {
  palette:       { mod: true, key: 'K' },
  treeSearch:    { mod: true, key: 'P' },
  edit:          { mod: true, key: 'E' },
  save:          { mod: true, key: 'S' },
  runCheck:      { ctrl: true, key: 'enter' },
  focusToggle:   { mod: true, shift: true, key: 'E' },
  focusExit:     { key: 'esc' },
  bold:          { mod: true, key: 'B' },
  italic:        { mod: true, key: 'I' },
  hr:            { mod: true, shift: true, key: 'H' },
  link:          { mod: true, shift: true, key: 'K' },
  synonym:       { mod: true, shift: true, key: 'S' },
  undo:          { mod: true, key: 'Z' },
  redo:          { mod: true, shift: true, key: 'Z' },
  find:          { mod: true, key: 'F' },
  findNext:      { key: 'enter' },
  findPrev:      { shift: true, key: 'enter' },
};

// Named Key → i18n-Key des Overlays. Buchstaben-Keys stehen wörtlich im Spec.
const NAMED_KEYS = {
  enter: 'shortcuts.key.enter',
  esc: 'shortcuts.key.esc',
};

// Token-Signatur eines Specs — dieselben Namen, die das Overlay in seinen
// `<kbd x-text="t('shortcuts.key.…')">` benutzt. Grundlage des Drift-Tests.
export function hotkeyTokens(spec) {
  const out = [];
  if (spec.ctrl) out.push('ctrl');
  if (spec.mod) out.push('cmdCtrl');
  if (spec.alt) out.push('alt');
  if (spec.shift) out.push('shift');
  out.push(spec.key);
  return out;
}

/**
 * Anzeigetext eines Kürzels. Mac: Modifier-Glyphen in der dort üblichen
 * Reihenfolge ⌃⌥⇧⌘, direkt an den Key geklebt (`⌘⇧E`). Sonst mit `+` verbunden
 * und lokalisierten Modifier-Namen (`Strg+Shift+E`).
 * Mehrzeichige Keys ("Enter") bekommen auf dem Mac ein Leerzeichen, damit
 * `⌃Enter` nicht als ein Wort gelesen wird.
 */
export function hotkeyText(id, isMac) {
  const spec = HOTKEYS[id];
  if (!spec) return '';
  const key = NAMED_KEYS[spec.key] ? tRaw(NAMED_KEYS[spec.key]) : spec.key;
  if (isMac) {
    let mods = '';
    if (spec.ctrl) mods += '⌃';
    if (spec.alt) mods += '⌥';
    if (spec.shift) mods += '⇧';
    if (spec.mod) mods += '⌘';
    if (!mods) return key;
    return mods + (key.length > 1 ? ' ' : '') + key;
  }
  const parts = [];
  if (spec.ctrl || spec.mod) parts.push(tRaw('shortcuts.key.ctrl'));
  if (spec.alt) parts.push(tRaw('shortcuts.key.alt'));
  if (spec.shift) parts.push(tRaw('shortcuts.key.shift'));
  parts.push(key);
  return parts.join('+');
}

/** `label` + Kürzel in Klammern. Unbekannte ID → Label unverändert. */
export function hotkeyTip(label, id, isMac) {
  const keys = hotkeyText(id, isMac);
  if (!keys) return label;
  return `${label} (${keys})`;
}
