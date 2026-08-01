// Facade: toolbarCardMethods aus thematischen Submodulen in toolbar/.
// Bubble-Toolbar + Link-Bar (bubble.js), Slash-Menü (slash.js), Quellen-Picker
// (cite.js), Querverweis-Picker (xref.js), Diagramm-Dialog (diagram.js) und der
// zentrale Keydown-Dispatcher
// (keydown.js) teilen sich zur
// Laufzeit ein `this` (in das
// Card-Objekt gespreadet). Geteilte Modul-Helfer + Konstanten in
// toolbar/_shared.js. Extern importiert nur editor-toolbar-card.js
// { toolbarCardMethods } — die Aufteilung ist internes Implementierungsdetail.
//
// Tabu im Fokus-Modus: Bubble + Slash sind über `!$app.focusActive` (Template)
// bzw. Guards gegated; Keydown-Handler bis zum Focus-Hard-Stop laufen in beiden
// Modi.

import { bubbleMethods } from './toolbar/bubble.js';
import { slashMethods } from './toolbar/slash.js';
import { keydownMethods } from './toolbar/keydown.js';
import { citeMethods } from './toolbar/cite.js';
import { xrefMethods } from './toolbar/xref.js';
import { diagramMethods } from './toolbar/diagram.js';

export const toolbarCardMethods = {
  ...bubbleMethods,
  ...slashMethods,
  ...keydownMethods,
  ...citeMethods,
  ...xrefMethods,
  ...diagramMethods,
};
