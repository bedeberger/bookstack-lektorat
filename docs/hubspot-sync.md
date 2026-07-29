# HubSpot-Sync (Buch ↔ HubSpot-Blog)

Spec für den HubSpot-Blog-Workflow eines Buchs vom Typ `blog`. Halbierte Funktion gegenüber [blog-sync.md](blog-sync.md) (WordPress): einmaliger Initial-Import + Per-Page-Push. Erst-Push erstellt einen HubSpot-Draft (`POST /cms/v3/blogs/posts`), Re-Push aktualisiert den Draft-Buffer eines bereits verknüpften Posts (`PATCH /cms/v3/blogs/posts/{id}/draft`). Kein Pull-Back, kein Conflict-Handling.

## Eckdaten

- **Mapping:** 1 Buch == 1 HubSpot-Blog (`contentGroupId`) + 1 Author (`blogAuthorId`). 1 HubSpot-Post == 1 Page in der App.
- **Gating:** Verbindung nur konfigurierbar, wenn `buchtyp === 'blog'` (serverseitig hart gegated über `getBookSettings`).
- **Auth:** Private Access Token (PAT, `pat-…`) via Bearer-Header. Token pro Buch verschlüsselt in der DB (`lib/crypto.js`).
- **Trigger:** manuell. Einmaliger Initial-Import + ad-hoc Per-Page-Push (Erst-Push + Re-Push) + on-demand Reconcile (Link-Drift-Check). Kein Cron, keine Pull-Operation.
- **Bilder:** konsequent gestrippt — Whitelist erlaubt nur Inline-/Block-Tags, kein `<img>`, kein Featured-Image-Upload, keine Medien-Embeds.
- **Quellen:** Quellen-Chips werden zu Klartext (`span` steht in keiner Whitelist-Map, das Element wird entpackt, der Kurzbeleg bleibt im Satz) — im HubSpot-Post wäre ein Zeiger auf `sources.id` toter Ballast. Bei aktivem `bibliography_in_blog` hängt der Push das Quellenverzeichnis als `<h2>` + Liste an. **Kein Marker-Wrapper, anders als bei WordPress** ([blog-sync.md](blog-sync.md) → „Pflicht-Invariante: der Pull entfernt es wieder"): HubSpot liest nie zurück, es kann also nichts akkumulieren — und ein `<div>` würde die Allowlist ohnehin entpacken.
- **Erst-Push:** `state: 'DRAFT'` via `POST /cms/v3/blogs/posts`. Finalisieren, Einplanen, Publizieren passiert in HubSpot.
- **Re-Push:** `PATCH /cms/v3/blogs/posts/{id}/draft` aktualisiert den Buffer eines existierenden Posts. Live-Version drüben bleibt unverändert, bis der User den Buffer in HubSpot publiziert. Der UI-Warn-Dialog macht klar, dass HubSpot-spezifische Formatierungen (Module, CTAs, Bilder, Forms, Tags) im Buffer durch den App-HTML-Body ersetzt werden.
- **Out-of-Scope:** Pull-Back von HubSpot-Änderungen, Featured-Image, Inline-Bilder, Tags/Topics/Categories, OAuth (PAT only), mehrere HubSpot-Blogs pro Buch.

## Status-Modell (UI)

Drei Zustände pro Page (`computeStatus` in [hubspot-sync-card.js](../public/js/cards/hubspot-sync-card.js)):

| Status | Bedingung | UI |
|---|---|---|
| `new` | Kein `hubspot_page_links`-Eintrag | Push-Button aktiv, Erst-Push ohne Confirm |
| `pushed-dirty` | Link existiert + `page.updated_at > COALESCE(last_pushed_at, hubspot_created_at)` | Push-Button aktiv, öffnet `appConfirm`-Warn-Dialog vor Re-Push |
| `pushed` | Link existiert + lokal unverändert seit Sync-Punkt | Indikator + externer Link, Push-Button ausgeblendet |

Re-Push ruft den Warn-Dialog (Keys `hubspot.repush.warning`/`hubspot.repush.confirm`) via `confirmPush`-Hook in [sync-core.js](../public/js/cards/sync/sync-core.js) auf. Bestätigt der User, sendet das Backend `PATCH …/draft` an HubSpot. Bricht der User ab, ändert sich nichts. Sync-Baseline ist `last_pushed_at || hubspot_created_at`. Der Initial-Import setzt `last_pushed_at` auf den Anlage-Zeitpunkt der frisch erzeugten Page (`created.updated_at`), damit sie direkt nach dem Import als `pushed` (synchron) gilt — sonst würde die Seitenanlage selbst (`updated_at` = jetzt > `hubspot_created_at`) als lokaler Edit zählen und der Status fälschlich `pushed-dirty` sein. Erst ein echter User-Edit schiebt `updated_at` über die Baseline → `pushed-dirty`.

## Schema (Migration 147 + 149 + 150)

Zwei Tabellen. FKs auf `books.book_id` + `pages.page_id` mit `ON DELETE CASCADE`.

```sql
CREATE TABLE hubspot_connections (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id                INTEGER NOT NULL UNIQUE REFERENCES books(book_id) ON DELETE CASCADE,
  token_enc              BLOB NOT NULL,                     -- AES via lib/crypto.js
  blog_id                TEXT NOT NULL,                     -- HubSpot contentGroupId
  author_id              TEXT NOT NULL,                     -- HubSpot blogAuthorId
  portal_id              TEXT,                              -- HubSpot HubID (me().portalId) für Editor-URL
  initial_import_done_at TEXT,                              -- NULL = noch nie importiert
  last_import_at         TEXT,
  last_push_at           TEXT,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_hubspot_conn_book ON hubspot_connections(book_id);

CREATE TABLE hubspot_page_links (
  page_id            INTEGER PRIMARY KEY REFERENCES pages(page_id) ON DELETE CASCADE,
  hub_id             INTEGER NOT NULL REFERENCES hubspot_connections(id) ON DELETE CASCADE,
  hubspot_post_id    TEXT NOT NULL,
  hubspot_state      TEXT,                                  -- 'DRAFT' | 'PUBLISHED' | …
  hubspot_created_at TEXT,
  last_pushed_at     TEXT,
  hubspot_url        TEXT,                                  -- absolute Post-URL aus createPost-Response
  UNIQUE(hub_id, hubspot_post_id)
);
CREATE INDEX idx_hubspot_links_hub ON hubspot_page_links(hub_id);
```

Idempotenz des Initial-Imports kommt aus `UNIQUE(hub_id, hubspot_post_id)` — Re-Run nach Crash überspringt bereits importierte Posts.

## Server-Module

| File | Inhalt |
|---|---|
| [lib/hubspot-client.js](../lib/hubspot-client.js) | REST-Wrapper. Bearer-Auth, Token-Bucket-Rate-Limit (100 req / 10 s, modulglobal), Retry mit Backoff bei 429/5xx (`Retry-After` honoriert). Methoden: `me()`, `listBlogs()`, `listAuthors()`, `iteratePosts({ authorId, blogId, state, limit })` (async-Generator, Cursor-Pagination via `paging.next.after`), `createPost(payload)`, `updatePostDraft(postId, payload)`, `getPost(postId)` (Reconcile + Push-Pre-Check). Fehler-Codes: 401→`HUBSPOT_AUTH_FAILED`, 403→`HUBSPOT_FORBIDDEN`, 404→`HUBSPOT_HTTP_404`, 429→`HUBSPOT_RATE_LIMIT`, 5xx→`HUBSPOT_UPSTREAM`, Netzwerk→`HUBSPOT_FETCH_FAILED`. |
| [lib/hubspot-html.js](../lib/hubspot-html.js) | `hubspotToAppHtml(raw)` — Strip-Pipeline für Import: Jinja-Marker (`{{…}}`, `{%…%}`, `{#…#}`) raus, CMS-Wrapper (`.hs-cta-*`, `.hs-form`, `.hs-embed-wrapper`, `script`/`style`/`iframe`/`noscript`) entfernen, Medien (`img`/`figure`/`video`/`audio`/`svg`/`object`/`embed`/`canvas`) raus. Whitelist Inline (`strong/b → strong`, `em/i → em`, `u`, `a[href^=https]`, `br`) + Block (`p`, `h1→h2`, `h2→h2`, `h3-h6→h3`, `ul`, `ol`, `li`, `blockquote`, `pre`, `hr`). Fallback: nur Inline-Content → in `<p>` wrappen. `appToHubspotHtml(html)` läuft durch dieselbe Pipeline (defensiv gegen Drift / direkte DB-Manipulation). |
| [db/hubspot.js](../db/hubspot.js) | CRUD für Connections + Links. `getConnection(bookId)` entschlüsselt das Token, `getConnectionPublic(bookId)` nie. `upsertConnection` re-encrypt'et bei jedem Save (kein dirty-Tracking nötig). `upsertLink` mit `ON CONFLICT(page_id) DO UPDATE` und `COALESCE` für nicht-überschreibbare Felder. |
| [routes/hubspot.js](../routes/hubspot.js) | HTTP-Endpoints (siehe unten). `router.param('book_id', bookParamHandler)` für ALS-Log-Context. Buchtyp-Gate via `_requireBlogType` vor jedem mutierenden Call (400 `HUBSPOT_REQUIRES_BLOG_TYPE`). `aclParamGuard('viewer'\|'editor')` pro Route. |
| [routes/jobs/hubspot-sync.js](../routes/jobs/hubspot-sync.js) | Job-Typen `hubspot-import`, `hubspot-push`, `hubspot-reconcile`. Dedup via `findActiveJobId(type, bookId, userEmail)`. `setContext({ book: book_id })` in jedem POST-Handler nach `toIntId`. |

## HTTP-Endpoints

Alle unter `/hubspot/:book_id/*`, `:book_id` via `bookParamHandler` validiert (setzt `req.bookId` + ALS-Context).

| Methode | Pfad | ACL | Zweck |
|---|---|---|---|
| GET | `/status` | viewer | `{ isBlogType, connected, connection }` — Connection-Public-Meta (kein Token) |
| POST | `/test` | editor | Token gegen `/integrations/v1/me` prüfen → `{ ok, hubId }` |
| GET | `/blogs` | editor | Combobox-Source `contentGroups` (akzeptiert `?token=…` für Pre-Save-Probe) |
| GET | `/authors` | editor | Combobox-Source Autoren (analog) |
| POST | `/connect` | editor | Token + `blogId` + `authorId` speichern. Token-Sentinel `__keep__` lässt bestehendes Token unverändert (für Re-Save ohne Token-Eingabe). Vor Save `me()`-Roundtrip. |
| GET | `/links` | viewer | `{ connected, blogId, portalId, links: [...] }` — Page-Link-Status für Buchorganizer-Badges; `portalId` füttert die Editor-URL bei Drafts. Pre-150-Connections: einmaliger `me()`-Self-Heal-Roundtrip persistiert `portalId` lazy beim ersten Aufruf. |
| DELETE | `/` | editor | Verbindung löschen (CASCADE killt Links) |

Push-Trigger läuft separat über die Job-Queue:

| Methode | Pfad | Body | Zweck |
|---|---|---|---|
| POST | `/jobs/hubspot-import` | `{ book_id }` | Initial-Import enqueuen |
| POST | `/jobs/hubspot-push` | `{ book_id, page_ids[] }` | Push-Job enqueuen (Multi-Page möglich) |
| POST | `/jobs/hubspot-reconcile` | `{ book_id }` | Reconcile-Job: ruft `getPost` für jeden Link, dropt 404-Orphans |

## Sync-Jobs

### `runHubspotImportJob(jobId, bookId, userEmail)` — einmalig

Gated: `initial_import_done_at IS NULL`. Zweiter Aufruf → Job-Fail mit `HUBSPOT_ALREADY_IMPORTED`.

1. `_requireBlogBook` + `_resolveHubConn` (sonst `HUBSPOT_REQUIRES_BLOG_TYPE` / `HUBSPOT_NOT_CONNECTED`).
2. `client.iteratePosts({ authorId, blogId, state: 'PUBLISHED' })` — Cursor-Pagination via `paging.next.after`.
3. Pro Post:
   - Skip, wenn `getLinkByPost(conn.id, post.id)` existiert (Idempotenz nach Re-Run).
   - Skip, wenn `htmlTitle`/`name` leer ist (Counter `dropped++`).
   - `hubspotToAppHtml(postBody)` (Fallback `<p></p>`).
   - Jahres-Kapitel via `_resolveYearChapter(bookId, year, cache)` — Cache-Map vermeidet Duplikat-Reads. `year` = `publishDate.slice(0,4)` (oder `created`/`updated`), Fallback `'Undatiert'`.
   - Page-Name: `YYYY-MM-DD: htmlTitle` wenn Datum vorhanden, sonst nur Titel.
   - `contentStore.createPage(...)` + `upsertLink(...)`.
   - `updateJob` mit Key `job.hubspot.import.progress`, Params `{ done }`.
4. Am Ende `markInitialImportDone(conn.id)`.
5. Wenn `imported > 0`: `syncBook(...)` + Vortags-Baseline-Snapshot in `book_stats_history` (identisches Pattern zu Blog-Import — verhindert verfälschte „heute geschrieben"-Statistik).

### `runHubspotPushJob(jobId, bookId, userEmail, pageIds[])`

Multi-Select-Push. Sequentiell, da gemeinsame Rate-Limit-Quota.

1. `_requireBlogBook` + `_resolveHubConn`.
2. Pro `pageId`:
   - `updateJob` mit Key `job.hubspot.push.upload`, Params `{ current, total }`.
   - Page laden via `contentStore.loadPage(pageId)`; Mismatch `book_id` → `PAGE_WRONG_BOOK`-Error im Errors-Array.
   - **Quellen:** `buildBibliography({ bookId, pageIds: [pageId], userEmail })` (Einheit ist die Seite — ein Post ist eine Seite, die Nummern des numerischen Stils folgen den Fundstellen dieses Posts ab 1), dann `resolveCitesInHtml` über das Seiten-HTML (der gespeicherte Chip-Text ist nur ein Cache). Bei `bibliography_enabled && bibliography_in_blog` kommt `bibliographySectionHtml(bib, { list: true })` dahinter.
   - `appToHubspotHtml(appHtml + bibSection)` (Fallback `<p></p>`).
   - **Erst-Push (kein Link):** `client.createPost({ name, postBody, contentGroupId, blogAuthorId, authorName, state: 'DRAFT' })` — kein `publishDate`, kein `slug`, kein `metaDescription`; User finalisiert drüben. `authorName` einmal pro Job aus `listAuthors()` resolved (HubSpot v3 ignoriert `blogAuthorId` allein bei manchen Portalen — Name muss mit).
   - **Re-Push (Link existiert):** `client.updatePostDraft(hubspot_post_id, { name, postBody })` → `PATCH /cms/v3/blogs/posts/{id}/draft` aktualisiert nur den Buffer; Live-Version drüben unverändert. UI hat User vorher via `appConfirm` über Verlust HubSpot-spezifischer Formatierungen aufgeklärt.
   - **Auto-Revive bei 404 im Re-Push:** Schlägt `updatePostDraft` mit `HUBSPOT_HTTP_404` fehl (User hat Draft drüben gelöscht), wird der Link entfernt und derselbe Push als Create neu ausgeführt — Page bekommt einen frischen Draft-Post, kein Sackgassen-Status.
   - `upsertLink({ pageId, hubId, hubspotPostId, hubspotState, hubspotCreatedAt, lastPushedAt: now })` — `lastPushedAt` immer aktualisiert, ist die Sync-Baseline für `pushed-dirty`-Erkennung.
3. `touchPush(conn.id)`. Job-Result: `{ pushed, errors: [{ pageId, code }] }`.

Abort-Signal: `jobAbortControllers.get(jobId)?.signal` wird in `createHubspotClient({ signal })` durchgereicht; jeder Loop-Iteration prüft `signal.aborted`.

### `runHubspotReconcileJob(jobId, bookId, userEmail)` — on demand

Drift-Check zwischen lokalen Links und HubSpot-Realität. Deckt Hard-Delete drüben (kein Trash-Stamp via API erreichbar).

1. `_requireBlogBook` + `_resolveHubConn`.
2. `hubspot.listLinksForConnection(conn.id)` → pro Link ein `client.getPost(hubspot_post_id)`.
3. Bei `HUBSPOT_HTTP_404` → `hubspot.deleteLink(link.page_id)` (CASCADE-frei, betrifft nur den Marker — Page bleibt unverändert). Andere Fehler werden nur geloggt, Link bleibt.
4. Job-Result: `{ checked, removed }`. Buchorganizer-Badge flippt nach `loadLinks` für betroffene Pages auf `new`; erneuter Push erstellt einen frischen Draft.

## Frontend

### BookSettings-Section „HubSpot-Verbindung"

Sichtbar nur bei `buchtyp === 'blog'`. Implementiert in [public/js/book/book-settings.js](../public/js/book/book-settings.js) (Methoden) + [public/js/cards/book-settings-card.js](../public/js/cards/book-settings-card.js) (State, `hubspotSectionOpen`-Toggle, Job-Finish-Listener) + [public/partials/book-settings.html](../public/partials/book-settings.html) (Markup).

State im Karten-Init: `hubspotConnection`, `hubspotForm { token, blogId, authorId }`, `hubspotBusy`, `hubspotAction`, `hubspotMessage`, `hubspotError`, `hubspotBlogs`, `hubspotAuthors`, `hubspotImportJobId`.

Form-Felder: PAT-Token (write-only; Read liefert keinen Token), Blog-Combobox (lazy, `/blogs?token=…`), Author-Combobox (lazy, `/authors?token=…`). Buttons: Test, Verbinden, Initial-Import, Trennen.

Methoden:
- `loadHubspotStatus` — `/status` lesen, `hubspotConnection` füllen.
- `loadHubspotBlogs` / `loadHubspotAuthors` — Combobox-Source nachladen.
- `testHubspotConnection` — `/test`-Call, `testOk` toasten.
- `saveHubspotConnection` — `/connect`-Call mit Token (`__keep__` wenn unverändert).
- `startHubspotImport` — `/jobs/hubspot-import` enqueuen, `job:enqueued`-Event.
- `startHubspotReconcile` — `/jobs/hubspot-reconcile` enqueuen (mit Confirm-Dialog, da N HTTP-Calls pro Link).
- `disconnectHubspot` — `DELETE /hubspot/:book_id` mit Confirm-Dialog.

Status-Panel zeigt `initialImportDoneAt` + `lastPushAt` (via `tzOpts`-Format).

### Buchorganizer-Badge + Push (sync-core-basiert)

Headless Sub-Komponente [public/js/cards/hubspot-sync-card.js](../public/js/cards/hubspot-sync-card.js) ist ein dünner Wrapper über [public/js/cards/sync/sync-core.js](../public/js/cards/sync/sync-core.js) — Single Source of Truth für `loadLinks`/`statusFor`/`canPush`/`push`/Polling-Lifecycle. Provider-Spec liefert nur Endpoint-Prefix, Job-Typen, Status-Modell, Labels. Lebt als `<div x-data="hubspotSyncCard" class="display-contents">` in [public/index.html](../public/index.html); globaler Zugriff via `window.__hubspotCard` + Template-Magic `$hubspot`. Templates iterieren über `$syncProviders` (Alpine-Magic in [public/js/app.js](../public/js/app.js)) — gleicher Badge+Push-Button-Block deckt Blog und HubSpot ab, ohne pro Provider neu zu duplizieren. CSS-Accent über `.sync-provider--hubspot { --sync-accent: var(--card-accent-hubspot); }`, Status-Pills `.badge--sync-{new|pushed|…}`.

Provider-Spec (in [hubspot-sync-card.js](../public/js/cards/hubspot-sync-card.js)):
- `key: 'hubspot'`, `endpointBase: '/hubspot'`
- `jobTypes: { push: 'hubspot-push', refresh: ['hubspot-import'], reconcile: 'hubspot-reconcile' }` — `reconcile` triggert nach Job-Done ein `loadLinks()` (entfernte Orphans verschwinden aus dem Buchorganizer).
- `computeStatus(page, link)` → `'new' | 'pushed-dirty' | 'pushed'` (siehe Status-Modell oben)
- `statusLabels: { new, pushed, 'pushed-dirty' }`
- `canPushStatuses: ['new', 'pushed-dirty']`
- `confirmPush(pageId)` → öffnet bei Status `pushed-dirty` einen `appConfirm`-Dialog (Keys `hubspot.repush.warning` + `hubspot.repush.confirm`). Rückgabe `false` (User bricht ab) verhindert den Backend-Call. `confirmPush`-Hook lebt in [sync-core.js](../public/js/cards/sync/sync-core.js) und ist generisch für andere Provider nachnutzbar.
- `viewUrl(page, providerMeta, link)` → bei `hubspot_state === 'DRAFT'` Editor-URL `https://app.hubspot.com/blog/<portalId>/editor/<postId>/content`, sonst Live-Post-URL aus `hubspot_url`. Draft-Preview ohne HubSpot-Session wäre sonst nicht aufrufbar.
- `pushErrorCode: 'HUBSPOT_PUSH_FAILED'`

Re-Push wird auf der HubSpot-Seite als Draft-Buffer-Update modelliert — der publizierte Live-Post bleibt unverändert, bis der User den Buffer drüben publiziert. Damit ist die Trennung „App schreibt Text, HubSpot publiziert" auch beim Re-Push gewahrt.

## i18n

Keys in [public/js/i18n/de.json](../public/js/i18n/de.json) + [en.json](../public/js/i18n/en.json):

```
hubspot.connect.title|token|tokenReplace|blog|author|test|save|update|disconnect|disconnectConfirm|testOk|saved|disconnected
hubspot.status.title|tokenSet|blog|author|imported|notImported|lastPush|new|pushed|pushedDirty
hubspot.action.import|push|view|reconcile|reconcileHint|reconcileConfirm
hubspot.repush.warning|confirm
hubspot.error.HUBSPOT_TOKEN_REQUIRED|HUBSPOT_BLOG_REQUIRED|HUBSPOT_AUTHOR_REQUIRED|HUBSPOT_AUTH_FAILED|HUBSPOT_FORBIDDEN|HUBSPOT_RATE_LIMIT|HUBSPOT_UPSTREAM|HUBSPOT_REQUIRES_BLOG_TYPE|HUBSPOT_NOT_CONNECTED|HUBSPOT_ALREADY_IMPORTED|HUBSPOT_ALREADY_PUSHED|HUBSPOT_PUSH_FAILED|HUBSPOT_IMPORT_FAILED|HUBSPOT_SAVE_FAILED|HUBSPOT_DISCONNECT_FAILED|HUBSPOT_TEST_FAILED|HUBSPOT_RECONCILE_FAILED|HUBSPOT_PRECHECK_FAILED
job.label.hubspotImport|hubspotPush|hubspotPushCount|hubspotReconcile
job.hubspot.import.fetch|progress
job.hubspot.push.upload
job.hubspot.reconcile.check
```

Server-Fehler-Codes werden 1:1 als i18n-Keys gemappt (`hubspot.error.${code}`). Neuer Server-Error-Code → in beiden Locale-Files Eintrag ergänzen.

## Sicherheit

- **PAT-Speicherung:** Token via [lib/crypto.js](../lib/crypto.js) AES-verschlüsselt. Klartext nur in `getConnection()` (server-intern), nie an Client. `getConnectionPublic` liefert ausschliesslich Meta.
- **HTTPS-only:** HubSpot-API ist hartcoded `https://api.hubapi.com`; keine User-konfigurierbare Base-URL.
- **`__keep__`-Sentinel:** Re-Save ohne Token-Eingabe sendet `token: '__keep__'` → Server resolved aus DB.
- **PAT-Scopes:** User braucht in HubSpot mindestens `content` (read+write). Test-Call `me()` prüft nur Auth, nicht Scope — fehlende Scopes liefern später 403 beim List/Create → `HUBSPOT_FORBIDDEN`.
- **Rate-Limit:** clientseitiges Token-Bucket (100 req / 10 s, modulglobal — PAT == ein User-Account, parallele Clients teilen Quota). Bei 429 wird `Retry-After`-Header honoriert, bis zu `MAX_RETRIES` Versuche.
- **Output-Sanitisierung:** `appToHubspotHtml` strippt defensiv `<script>`/`<iframe>`/`<img>` etc., auch wenn App-HTML konzeptionell sauber ist (`lib/html-clean.js` am Save-Chokepoint).
- **Buchtyp-Gate serverseitig hart:** Connect/Import/Push prüfen `getBookSettings(bookId).buchtyp === 'blog'`, sonst 400 `HUBSPOT_REQUIRES_BLOG_TYPE`.
- **Job-Dedup:** `findActiveJobId('hubspot-import'\|'hubspot-push', bookId, userEmail)` verhindert parallele Jobs pro Buch + User.
- **ACL:** alle Routes via `aclParamGuard('viewer'\|'editor')` (Status/Links: viewer; Test/Blogs/Authors/Connect/Disconnect: editor).
- **Logging-Context:** `router.param('book_id', bookParamHandler)` in `routes/hubspot.js`; `setContext({ book: book_id })` in Job-POST-Routes nach `toIntId`-Validierung.

## Tests

- **Unit** ([tests/unit/](../tests/unit/)):
  - [hubspot-html.test.mjs](../tests/unit/hubspot-html.test.mjs) — `hubspotToAppHtml` / `appToHubspotHtml`: Whitelist, Image-Strip, Jinja-Strip, https-only Links, Heading-Normalize, leerer Input; **Quellen:** Chip → Klartext ohne `data-src`, angehängtes Verzeichnis überlebt als `<h2>` + `<ul>` (numerisch: Absätze mit `[n]`), Marker-`<div>` wird entpackt, Titel escapet.
  - [hubspot-db.test.js](../tests/unit/hubspot-db.test.js) — Connection + Link CRUD, Token-Encrypt/Decrypt-Roundtrip, `UNIQUE(hub_id, hubspot_post_id)`-Constraint.
- **Integration** ([tests/integration/](../tests/integration/)):
  - [hubspot-sync.test.js](../tests/integration/hubspot-sync.test.js) — Initial-Import (Year-Chapter-Aggregation, Link-Eintrag) gegen [mock-hubspot.js](../tests/integration/_helpers/mock-hubspot.js); `HUBSPOT_ALREADY_IMPORTED` bei zweitem Run; Push-Job (Draft + Link) + `HUBSPOT_ALREADY_PUSHED` bei Re-Push; `HUBSPOT_REQUIRES_BLOG_TYPE` bei falschem Buchtyp.
- **Drift-Gates:** [erd-drift.test.mjs](../tests/unit/erd-drift.test.mjs) + [squash-drift.test.mjs](../tests/unit/squash-drift.test.mjs) decken `hubspot_connections` + `hubspot_page_links` ab.

## Edge-Cases

- **PAT abgelaufen:** Job-Status `error` mit `HUBSPOT_AUTH_FAILED`; User aktualisiert Token in den Bucheinstellungen.
- **Page lokal nach Push verändert:** Push-UI blockiert, lokale Edits driften gegenüber HubSpot. Bewusster Trade-off — User hat Workflow-Wechsel zu HubSpot kommuniziert.
- **HubSpot-Post/Blog drüben gelöscht:**
  - **Push-Pfad:** Re-Push einer verlinkten Page entdeckt das 404 via `updatePostDraft`, löscht den Link automatisch und erstellt einen neuen Draft (`revived` im Logger). Single Push-Klick reicht.
  - **Drift sichtbar machen:** „Verbindung prüfen"-Button (`runHubspotReconcileJob`) ruft `getPost` für jeden Link und entfernt Orphans. Pages flippen danach auf Badge `new`. Manuell wie der Blog-Reconcile — kein Auto-Check.
- **Link auf Pre-149-Pushes:** `hubspot_url` wurde mit Migration 149 ergänzt; vorher gepushte Pages haben `NULL` → kein „In HubSpot öffnen"-Button für PUBLISHED-Posts. Workaround: Re-Push (Status `pushed-dirty`) füllt das Feld; alternativ Link in DB löschen → Push neu.
- **Connection vor Migration 150:** `portal_id` fehlt → Editor-URL nicht baubar. `/links` self-healt einmalig via `me()`-Roundtrip beim ersten Aufruf nach dem Update und persistiert die `portalId`. Schlägt der Roundtrip fehl (Auth/Netz), bleibt der Draft-Button für diesen Request leer; nächster Aufruf retried.
- **HubSpot-Rate-Limit (429):** Client honoriert `Retry-After`, retried bis `MAX_RETRIES`. Bei Final-Fail → `HUBSPOT_RATE_LIMIT` im Job-Errors-Array.
- **Post ohne Titel:** Import dropt Post (Counter `dropped++`).
- **Pagination-Cursor verloren bei Crash:** Initial-Import nicht resumeable; User triggert erneut, Idempotenz greift via `UNIQUE(hub_id, hubspot_post_id)`-Skip.
- **Author wechselt in HubSpot:** Push hängt an `author_id` der Connection. User muss disconnecten + neu verbinden.
- **CLI parallel:** [scripts/import-hubspot.js](../scripts/import-hubspot.js) bleibt für Ops/Power-User funktionsfähig und nutzt `lib/hubspot-html.js` als geteilte Strip-Pipeline.
- **Beide Provider verbunden (WP + HubSpot)** auf demselben Buch: technisch möglich (separate Tabellen + separate Sub-Komponenten), nicht empfohlen.

## Konvention

- **Year-Chapter `YYYY`:** identisch zu Blog-Sync, geteilt nutzbar bei gleichem Jahr.
- **Page-Name `YYYY-MM-DD: Titel`:** beim Import gesetzt, Datum aus `publishDate`/`created`/`updated`. Push lässt Titel unverändert (rohen `page_name` durchreichen).
- **`publishDate`/`slug`/`meta_description`:** nicht gesetzt — HubSpot defaultet bzw. User füllt drüben.
