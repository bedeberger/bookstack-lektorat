// Buch-/Seiten-Tree-Methoden — Facade über book/tree/. Werden in die Alpine-Root-
// Komponente gespreadet (app.js); `this` bezieht sich dort auf die Komponente.
//
// Interne Aufteilung (Submodule):
//   tree/load.js        — Buch-/Seiten-Laden, Tree-Build, Combobox, Kapitel-Anlage,
//                         Token-Estimate-Backfill. Exportiert auch `insertChapterItem`.
//   tree/permissions.js — ACL-Rolle + Entity-Flag pro Buch, canEdit/canReview/isViewer, Buchtyp.
//   tree/open-state.js  — Persistenter Collapse-State + Chapter-Header-Aktivierung.
//   tree/stats.js       — Seiten-Status/Tooltips, Page-Stats-Sync, Kapitel-Aggregation.
//   tree/ui.js          — Sidebar-Tooltip-Helper (Token-Badge + Page-Status).

import { treeLoadMethods } from './tree/load.js';
import { treePermissionsMethods } from './tree/permissions.js';
import { treeOpenStateMethods } from './tree/open-state.js';
import { treeStatsMethods } from './tree/stats.js';
import { treeUiMethods } from './tree/ui.js';


export const treeMethods = {
  ...treeLoadMethods,
  ...treePermissionsMethods,
  ...treeOpenStateMethods,
  ...treeStatsMethods,
  ...treeUiMethods,
};
