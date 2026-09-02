# Buch-Migration (`.swbook`)

Verlustfreier Round-Trip eines ganzen Buchs zwischen App-Instanzen (Dev → Prod, zwischen self-hosted Deployments). **Pflicht-Scope:** Pages + Kapitelstruktur + authored `book_settings`. **Optional zuschaltbar** (Export-Checkboxen): Komplettanalyse-Entities, gespeicherte Lektorats-Checks, Chat-Verläufe. Nicht enthalten: Drafts/Figuren-Werkstatt, regenerierbare Caches (Extract/Review/LanguageTool/Lektorat-Cache), Integrationen (Blog/HubSpot), Sharing, ACL, Presence. Owner nach Import = importierender User; `user_email` aller übernommenen Zeilen wird auf den Importer gesetzt.

Die menschen-lesbaren Export-Formate (PDF/HTML/MD/EPUB/TXT) sind Einweg-Artefakte; `.swbook` ist das App-eigene Austauschformat für 1:1-Wiederherstellung.

## Bundle-Format (`version: 2`)

ZIP mit Endung `.swbook`:

```
<slug>.swbook            ZIP
├── manifest.json        { format:'schreibwerkstatt-book', version:2, exportedAt, sourceBookId, appVersion,
│                          includes:{ analysis, lektorat, chats } }
├── book.json            { book:{ name, description, settings:{…} }, tree:[ node… ] }
├── analysis.json        (nur wenn includes.analysis) Komplettanalyse-Entities
├── lektorat.json        (nur wenn includes.lektorat) { pageChecks:[…] }
└── chats.json           (nur wenn includes.chats)    { sessions:[…], messages:[…] }
```

- `node` = `{ type:'chapter', name, srcId, children:[node…] }` | `{ type:'page', name, html, srcId }`.
- **`srcId`** = Quell-`page_id`/`chapter_id`. Der Import baut daraus `pageIdMap`/`chapterIdMap` (srcId → neue ID); die Extra-Dateien referenzieren Pages/Kapitel ausschliesslich über diese Quell-IDs und werden beim Restore umgeschrieben.
- **Reihenfolge** = Array-Order. **Hierarchie** = Nesting (max Tiefe 3, wie chapters). Top-Level-Seiten ohne Kapitel werden vorangestellt (Interleaving zwischen Top-Pages und Top-Kapiteln geht verloren — für Migration unkritisch, Struktur + Inhalt bleiben vollständig).
- `settings` = authored Konfig (`language, region, buchtyp, buch_kontext, erzaehlperspektive, erzaehlzeit, is_finished, daily_goal_chars, orte_real, schauplatz_land, entities_enabled`). `allow_lektor_book_chat` wird beim Import auf 0 gesetzt (ACL-relevant, instanzspezifisch).
- **`version: 2`** trägt immer `srcId` + `manifest.includes` (auch ohne Extras). Alt-Bundles (`version: 1`) bleiben importierbar (kein srcId → leere Maps, keine Extras). Eine ältere Instanz lehnt ein v2-Bundle bewusst ab (`unsupportedVersion`), statt Analyse/Chats stillschweigend zu verlieren.

### Extra-Bloecke (analysis/lektorat/chats)

Tabellen-Inventar pro Block — alle book-scoped, IDs werden beim Restore remapped:

- **analysis** (Komplettanalyse): `figures` (+`figure_tags`/`figure_relations`/`figure_appearances`/`figure_events`/`page_figure_mentions`), `locations` (+`location_figures`/`location_chapters`), `figure_scenes` (+`scene_figures`/`scene_locations`), `songs` (+`song_figures`/`song_chapters`/`song_scenes`), `world_facts` (+`world_fact_chapters`), `storylines`, `zeitstrahl_events` (+`zeitstrahl_event_chapters`/`_pages`/`_figures`), `continuity_checks`/`continuity_issues` (+`_figures`/`_chapters`), `ideen`.
- **lektorat**: `page_checks` (gespeicherte Befunde/Stilanalyse/Fazit pro Seite).
- **chats**: `chat_sessions` + `chat_messages` (Seiten- und Buch-Chat).

**Der Analyse-Block traegt genau EINE Analyse.** `figures`/`locations`/`figure_scenes`/`songs`/`world_facts`/`zeitstrahl_events`/`continuity_*`/`ideen` sind pro `user_email` skopiert: jeder Mitarbeitende hat seine eigene Komplettanalyse desselben Buchs, mit eigenem `fig_1`-Raum. Beim Restore bekommt jede Zeile die E-Mail des Importierenden (der Quell-User existiert auf der Zielinstanz nicht) — zwei mitgenommene Analysen verschmelzen dabei zu EINEM Katalog, in dem jede Figur zweimal steht. Durchgesetzt auf beiden Seiten: `_pickScope` beim Sammeln (die Analyse des exportierenden Users, sonst die vollstaendigste) und `_restoreToOneScope` beim Einspielen (fuer aeltere Bundles, die noch mehrere tragen; die uebersprungenen Zeilen stehen als `skippedScopes`/`skippedRows` im Job-Resultat und in der Import-Meldung). **Lektorat und Chats bleiben ungefiltert** — Protokolle koennen nebeneinander bestehen; sie tragen nach dem Import allerdings den Importierenden als Autor.

Remap-Regeln im Restore (Reihenfolge respektiert FK-Abhängigkeiten): storylines → figures → figure-Bridges → locations → scenes → songs → world_facts → zeitstrahl_events → continuity → ideen. Natural Keys (`fig_id`/`loc_id`/`song_uid`) werden bei Kollision per `__N`-Suffix eindeutig gemacht — das ist die **letzte Absicherung** fuer beschaedigte oder handgebaute Bundles, kein Weg, zwei Analysen zu vereinen (siehe Kasten oben); im Normalfall greift sie nie. Bridge-Zeilen, deren remappte Referenz fehlt, werden übersprungen (`INSERT OR IGNORE` bzw. `continue`); nullbare FK-Spalten werden auf `NULL` gesetzt. `ideen` (XOR page/chapter): fehlt die remappte Referenz, wird die Zeile verworfen (sonst CHECK-Verletzung). Chat-Sessions mit `kind='page'` brauchen eine remappte `page_id` — fehlt sie, entfällt Session + zugehörige Messages.

## Code

- **`lib/book-bundle.js`** — pure Builder/Parser/Validator (kein Express/DB, Round-Trip testbar): `buildManifest`, `normalizeIncludes`, `treeToNodes`, `buildBookJson`, `validateManifest`, `validateBookJson`, `planFromNodes`. `planFromNodes` flacht den node-Tree in eine geordnete Op-Liste (`chapter`/`page` mit `tempId`/`parentTempId`/`srcId`); Tiefe > 3 wird gekappt (Pages hängen am letzten erlaubten Vorfahr, `cappedChapters` zählt das).
- **`db/book-migration-data.js`** — `collectExtras(bookId, { analysis, lektorat, chats }, scopeEmail)` (book-scoped SELECTs, JOIN-Scoping für Bridge-Tabellen, Analyse-Block auf einen `user_email`-Scope) + `restoreExtras(bookId, extras, { pageIdMap, chapterIdMap }, importerEmail)` (eine `db.transaction`, alle Inserts mit ID-Remap + `user_email`→Importer). Direkter SQL-Zugriff bewusst — Analyse-Entities fallen nicht unter die Content-Store-Facade (die gilt nur für Pages/Chapters/Books).
- **Export — `GET /book-migration/:bookId`** ([routes/book-migration.js](../routes/book-migration.js), sync, in `server.js` gemountet): Query-Flags `?analysis=1&lektorat=1&chats=1`. ACL `viewer` (reiner Content-Export) bzw. **`owner`**, sobald ein Extra angefordert wird (Extras enthalten potenziell personenbezogene Daten aller Mitarbeitenden). → `bookTree` + Page-HTML via Content-Store → `treeToNodes` (mit srcId) → `getBookSettings` → `collectExtras` → JSZip (book.json + optionale Extra-Dateien) → Stream `application/zip`. Leeres Buch → 400, fehlend → 404.
- **Import — `POST /jobs/book-import`** ([routes/jobs/book-import.js](../routes/jobs/book-import.js), Job-Queue, spiegelt das Buffer-Map-Pattern von folder-import): raw ZIP (Limit 200 MB) → `importBuffers`-Map (TTL 30 min) → Job `book-import` (bookId 0). Dedup-Key `swbook:<bytelength>`. Worker `runBookImportJob`: `JSZip.loadAsync` → `validateManifest`/`validateBookJson` → `createBook` (Owner = Importer) + Owner-Grant → `saveBookSettings` → Ops in Reihenfolge via `createChapter`/`createPage` (Content-Store-Facade), dabei `pageIdMap`/`chapterIdMap` aus `op.srcId` → neue ID füllen → `restoreExtras` (gemäss `manifest.includes`, **non-fatal**) → `syncBook` + Vortags-Baseline-Snapshot → `completeJob({ bookId, pagesCreated, chaptersCreated, cappedChapters, extras })`.

Seiten-HTML läuft beim `createPage` durch den Sanitization-Chokepoint (`_cleanHtmlSafe`) → kein XSS-Import. Manifest-Validierung vor jeder Verarbeitung: falsches `format`/fehlend → `job.error.badManifest`, Version > 2 → `job.error.unsupportedVersion`, leeres `book.json`/leerer Tree → `job.error.swbookEmpty`. Schlägt nur die Extra-Wiederherstellung fehl, bleibt das Buch mit Inhalt bestehen (`extras: { error: true }` im Resultat).

## Frontend

- **Export-Card** ([public/js/book/export.js](../public/js/book/export.js) + [partials/export.html](../public/partials/export.html)): Migration-Button zieht `/book-migration/<bookId>` (gleicher Blob-Download wie reguläre Exporte). Nur scope=book. Drei `.form-check`-Checkboxen (`migrateAnalysis`/`migrateLektorat`/`migrateChats`) hängen die Query-Flags an. Nur Owner sieht beim Anhaken einen erfolgreichen Download (Server gated auf `owner`).
- **folder-import-Card** ([public/js/cards/folder-import-card.js](../public/js/cards/folder-import-card.js) + [partials/folder-import.html](../public/partials/folder-import.html)): zweiter Modus „Schreibwerkstatt-Buch (.swbook)" — File-Input → `POST /jobs/book-import` → Job-Polling → bei Done Navigation zum neuen `bookId`. Das Resultat zeigt die wiederhergestellten Extra-Zähler (analysis/lektorat/chats). Import übernimmt automatisch, was im Bundle steckt — keine Import-seitige Auswahl.

## Tests

- [tests/unit/book-migration.test.mjs](../tests/unit/book-migration.test.mjs) — Bundle-Builder/Parser Round-Trip, Manifest-Validierung (inkl. `includes`/`srcId`), Hierarchie-Tiefe + Reihenfolge.
- [tests/integration/book-import.test.js](../tests/integration/book-import.test.js) — Seed → Export → Import-Job → Tree/HTML/settings deep-equal; Re-Import → 2. unabhängiges Buch; Extra-Round-Trip (Figur/Szene/page_check/chat) mit remappten Page-/Kapitel-Referenzen.
