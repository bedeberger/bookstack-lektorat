// Facade: appHashRouterMethods aus thematischen Submodulen in app-hash-router/.
// Submodule teilen sich zur Laufzeit ein gemeinsames `this` (in das Objekt
// gespreadet). Aufteilung nach Richtung des Datenflusses:
//   build.js — State → URL (Hash bauen, push/replace schreiben)
//   apply.js — URL → State (Hash parsen, Zustand herstellen)
//   setup.js — Watcher-Lifecycle (haengt die Schreib-Watcher auf/ab)
//
// URL-Hash-Permalinks + History-Management.
// Schema: #profil | #admin/<users|settings|usage[/<tab>]> | #book/:bookId[/page/:pageId|/figur/:figId|/ort/:ortId|/szene/:szeneId|/ereignis/:ereignisId|/werkstatt[/:draftId]|/kapitel[/:chapterId]|/<view>]
// Views: figuren, werkstatt, orte, szenen, ereignisse, kontinuitaet, bewertung, kapitel, chat, stats, stil, fehler, suche, einstellungen, finetune, export
// Admin-Usage-Tabs: users (default, weggelassen) | jobs | chat | summary | features | time
import { hashBuildMethods } from './app-hash-router/build.js';
import { hashApplyMethods } from './app-hash-router/apply.js';
import { hashSetupMethods } from './app-hash-router/setup.js';

export const appHashRouterMethods = {
  ...hashBuildMethods,
  ...hashApplyMethods,
  ...hashSetupMethods,
};
