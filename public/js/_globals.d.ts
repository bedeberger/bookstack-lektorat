// Echte Browser-Globals des Frontends — Libs, die per <script>-Tag bzw. lazy
// via lazy-libs.js ins `window` geladen werden und darum in keinem Modul
// importiert sind. Ohne diese Deklarationen meldet das Import-Gate
// (scripts/check-imports.js) sie als undefinierte Namen und ertrinkt in
// Rauschen; mit ihnen bleibt TS2304/TS2552 ein reines Signal für den einen
// Fehler, den es fangen soll: benutztes Symbol ohne Import.
//
// Nur hier eintragen, was WIRKLICH global ist. Ein fehlender Import ist kein
// Global — er gehört importiert, nicht wegdeklariert.
//
// Wird ausschliesslich von tsconfig.check.json eingelesen (jsconfig.json
// includet nur `**/*.js` und bleibt davon unberührt). Kein Build-Artefakt,
// nicht vom Browser geladen.

declare const Alpine: any;   // vendor/alpine.min.js, <script defer> in index.html
declare const vis: any;      // vendor/vis-network — lazy via lazy-libs.js (Figuren-Graph, Motiv-Konstellation)
declare const Chart: any;    // vendor/chart.umd.min.js — lazy via lazy-libs.js (BookStats)
