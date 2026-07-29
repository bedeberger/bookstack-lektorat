# Blog-Sync (WordPress ↔ Buch)

Spec für bidirektionale Synchronisation zwischen einem self-hosted WordPress-Blog und einem Buch vom Typ `blog`.

## Eckdaten

- **Mapping:** 1 Blog == 1 Buch. 1 WP-Post == 1 Page in der App.
- **Gating:** Verbindung nur konfigurierbar, wenn `buchtyp === 'blog'` (siehe `prompt-config.json`).
- **Auth:** Basic-Auth über HTTPS. URL/User/Password pro Buch in den Bucheinstellungen.
- **Trigger:** manuell. Einmaliger Initial-Import + ad-hoc Pull/Push + on-demand Reconcile (Link-Drift-Check). Kein Cron.
- **Editor:** WordPress Block-Editor (Gutenberg) only. Classic-Editor-Posts werden importiert, beim Push wieder als Block-HTML rausgeschrieben.
- **Inline-Bilder:** werden bei Import erhalten (`<figure>`/`<img>` bleiben, `wp-image-<n>`-Klasse trägt die Attachment-ID) und bei Push als `wp:image`-Block rausgeschrieben. Bereits blog-gehostete Bilder bleiben unangetastet; data-URIs und fremd-gehostete Bilder werden vor dem Push in die WP-Mediathek hochgeladen (`lib/wp-media.js`, SSRF-guarded). Nicht-Bild-Embeds (`video`/`audio`/`iframe`/`embed`/`object`) werden beidseitig verworfen.
- **Categories/Tags/Featured-Image:** bewusst kein eigenes Mapping. Der Push sendet nur `content` (`updatePost` ist ein Partial-Update) → WP lässt Kategorien, Tags und Featured-Image unangetastet, sie bleiben also über einen Content-Push erhalten. In-App werden sie nicht gelesen/gesetzt.
- **Out-of-Scope:** Categories/Tags in-App bearbeiten, Featured-Image setzen, Auto-Pull, Mehrere Blogs pro Buch.

## Konflikt-Strategie (LWW)

Vergleich `wp.modified_gmt` ↔ `pages.updated_at`. 4 Fälle pro Pull:

| WP neuer als Link | App neuer als Link | Aktion |
|---|---|---|
| ja | nein | WP → App (Update der Page) |
| nein | ja | nichts; gehört in Push |
| nein | nein | no-op |
| ja | ja | `conflict_state='detected'` → User löst via Diff |

`blog_page_links.last_pulled_at` ist der Referenzpunkt für „App seit letztem Pull geändert".

## Schema-Migration N

Zwei neue Tabellen. Pflicht: `foreign_key_check`, `UPDATE schema_version`, `npm run squash:regen`, [erd.md](erd.md) updaten.

```sql
CREATE TABLE blog_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL UNIQUE REFERENCES books(book_id) ON DELETE CASCADE,
  base_url TEXT NOT NULL,                -- https:// nur
  username TEXT NOT NULL,
  password_enc BLOB NOT NULL,            -- AES via lib/crypto.js
  default_status TEXT NOT NULL DEFAULT 'draft'
    CHECK(default_status IN ('draft','publish','private')),
  initial_import_done_at TEXT,           -- NULL = noch nie importiert
  last_pull_at TEXT,
  last_push_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE blog_page_links (
  page_id INTEGER PRIMARY KEY REFERENCES pages(page_id) ON DELETE CASCADE,
  blog_id INTEGER NOT NULL REFERENCES blog_connections(id) ON DELETE CASCADE,
  wp_post_id INTEGER NOT NULL,
  wp_modified_at TEXT NOT NULL,
  wp_status TEXT,
  wp_slug TEXT,
  last_pulled_at TEXT,
  last_pushed_at TEXT,
  conflict_state TEXT
    CHECK(conflict_state IN (NULL,'detected','resolved-app','resolved-wp')),
  UNIQUE(blog_id, wp_post_id)
);
CREATE INDEX idx_blog_page_links_blog ON blog_page_links(blog_id);
```

## Server-Module

| File | Inhalt |
|---|---|
| `lib/wp-client.js` | Basic-Auth-Header, HTTPS-Pflicht + SSRF-Guard (`validateBaseUrl`), Pagination via `X-WP-TotalPages`, Retry/Backoff bei 429/5xx. Methoden: `me()`, `listPosts({ page, perPage, modifiedAfter? })`, `getPost(id)`, `createPost(payload)`, `updatePost(id, payload)`, `uploadMedia({ data, filename, mimeType })` (Binär-Upload via `raw`-Body + `Content-Disposition`). Keine Categories/Tags-Endpoints. |
| `lib/wp-html.js` | `wpToAppHtml(raw, stats?)` (**async**): strip alle `<!-- wp:* -->`/`<!-- /wp:* -->` Kommentare, **angehängtes Quellenverzeichnis entfernen** (`div.sw-bibliography`, siehe „Quellenverzeichnis im Post"), **Quellen-Chips ohne `data-src` zu Klartext degradieren** (zählt in `stats.citesDegraded`), `img` auf `src`/`alt`/`class`(`wp-image-<n>`) reduzieren, Nicht-Bild-Embeds + bild-lose Figuren entfernen, dann durch `lib/html-clean.js` (Single Chokepoint). Async, weil die Chip-Selektoren aus der ESM-SSoT `public/js/sources/cite-html.js` kommen statt aus einer Kopie. `appToWpHtml(html, { bibliography? })`: parse via linkedom, pro Block-Element passenden Gutenberg-Kommentar wrappen (siehe Block-Mapping); `<figure>`/`<img>` → `wp:image`. `appToWpHtmlWithMedia(html, { resolveImage, bibliography? })`: async Variante mit vorgelagertem Media-Pass (jedes `<img>` durch `resolveImage(src)` → src ersetzen / verwerfen). |
| `lib/wp-media.js` | `makeImageResolver({ wp, blogOrigin, signal, logger, fetchImpl? })` → async `resolveImage(src)`: blog-gehostet → unverändert behalten; data-URI/fremde URL → Bytes holen (SSRF-Guard `assertPublicUrl` pro Hop; Redirects via `redirect: 'manual'` selbst gefolgt + jeder Hop neu validiert, Hop-Limit 5 — verhindert Redirect-Bypass auf interne IPs) + `wp.uploadMedia`. MIME-Allowlist (jpeg/png/gif/webp/avif) + 20-MB-Cap. Fehler → Bild verwerfen (`null`), nie Job-Abbruch. |
| `lib/blog-merge.js` | Pure `classifyPull({ hasLink, wpModifiedAt, linkModifiedAt, pageUpdatedAt, lastPulledAt })` → `'create'`/`'update'`/`'conflict'`/`'skip'` + `newer(a,b)`. Ausgelagert für testbare LWW-Logik ohne Job-/DB-Kontext. |
| `db/blogs.js` | CRUD für `blog_connections` + `blog_page_links`. Passwort beim Read via `lib/crypto.js` entschlüsseln, nie an Client returnen. |
| `routes/blog.js` | `GET /blog/:book_id/status`, `POST /blog/:book_id/connect`, `DELETE /blog/:book_id/disconnect`. `router.param('book_id', bookParamHandler)` aus `lib/log-context.js`. Connect prüft serverseitig `buchtyp === 'blog'` (sonst 400 `BLOG_REQUIRES_BLOG_TYPE`). |
| `routes/jobs/blog-sync.js` | Job-Typen `blog-import`, `blog-pull`, `blog-push`, `blog-reconcile`. Dedup via `findActiveJobId(type, bookId, userEmail)`. |

## Gutenberg-Block-Mapping (Push)

App-HTML → WP-Block-HTML:

| App-Tag | Gutenberg-Wrap |
|---|---|
| `<p>` | `<!-- wp:paragraph -->\n<p>…</p>\n<!-- /wp:paragraph -->` |
| `<h2>` | `<!-- wp:heading {"level":2} -->\n<h2>…</h2>\n<!-- /wp:heading -->` |
| `<h3>` | `<!-- wp:heading {"level":3} -->\n<h3>…</h3>\n<!-- /wp:heading -->` |
| `<ul>` | `<!-- wp:list -->\n<ul>…</ul>\n<!-- /wp:list -->` |
| `<ol>` | `<!-- wp:list {"ordered":true} -->\n<ol>…</ol>\n<!-- /wp:list -->` |
| `<blockquote>` | `<!-- wp:quote -->\n<blockquote class="wp-block-quote">…</blockquote>\n<!-- /wp:quote -->` |
| `<pre>` | `<!-- wp:code -->\n<pre class="wp-block-code">…</pre>\n<!-- /wp:code -->` |
| `<hr>` | `<!-- wp:separator -->\n<hr class="wp-block-separator"/>\n<!-- /wp:separator -->` |
| Inline (`strong`, `em`, `a`, `u`) | unverändert innerhalb des Blocks |
| `<figure>`/`<img>` | `<!-- wp:image {"id":N,"sizeSlug":"full"} -->\n<figure class="wp-block-image size-full"><img src="…" alt="…" class="wp-image-N"/>…figcaption…</figure>\n<!-- /wp:image -->` (Attachment-ID `N` nur wenn bekannt; `figcaption` erhalten) |
| `<video>`, `<audio>`, `<iframe>`, `<embed>`, `<object>` | strip (nicht round-trip-fähig) |

Unit-Test pro Mapping in `tests/unit/wp-html.test.mjs`.

## Quellenverzeichnis im Post

Bei `bibliography_enabled && bibliography_in_blog` (Bucheinstellungen → Quellen) hängt der Push das Quellenverzeichnis an den Post. **Einheit ist die Seite** — ein Post ist genau eine Seite, also läuft `buildBibliography({ bookId, pageIds: [pageId], userEmail })`; die Nummern des numerischen Stils folgen den Fundstellen dieses einen Posts ab 1. Davor läuft `resolveCitesInHtml` über das Seiten-HTML, damit der Kurzbeleg im Chip den aktuellen Zitierstil zeigt (der gespeicherte Text ist nur ein Cache — siehe [publikation-export.md](publikation-export.md) und `lib/bibliography.js`).

Markup: ein `wp:group` mit der Marker-Klasse, darin `wp:heading` + `wp:list` (Autor-Jahr-Stile) bzw. `wp:paragraph` je Eintrag (numerischer Stil — sein `[n]`-Präfix ist selbst das Label, und eine auto-numerierte `<ol>` würde bei `bibliography_scope='all'` falsch zählen, weil unzitierte Quellen ohne Nummer hinten anhängen).

```
<!-- wp:group {"className":"sw-bibliography"} -->
<div class="wp-block-group sw-bibliography">
<!-- wp:heading --><h2 class="wp-block-heading">Quellenverzeichnis</h2><!-- /wp:heading -->
<!-- wp:list --><ul><!-- wp:list-item --><li>Kafka, F. (1915). <em>Die Verwandlung</em>.</li><!-- /wp:list-item --></ul><!-- /wp:list -->
</div>
<!-- /wp:group -->
```

### Pflicht-Invariante: der Pull entfernt es wieder

**Das angehängte Verzeichnis MUSS beim Pull verschwinden.** Der Sync ist bidirektional mit LWW: bleibt es stehen, liest der nächste Pull es als Seitentext ins Manuskript, der Push danach hängt ein zweites an — und es wächst pro Zyklus weiter. Das Verzeichnis ist ein **Render-Artefakt** und darf nie in `pages.content` landen (Invariante A in `lib/bibliography.js`).

Umsetzung: `appToWpHtml` schreibt den Marker (`BIBLIOGRAPHY_MARKER_CLASS`), `wpToAppHtml` entfernt `div.sw-bibliography` wie die `_DROP_EMBEDS`. Beide Richtungen stehen **bewusst in derselben Datei** — auf zwei Module verteilt hält die Invariante nicht. Gutenberg schreibt `className` in die Klassenliste des gerenderten `<div>`, der Marker ist also in `content.raw` **und** `content.rendered` zu finden; der Klassenfilter von `wpToAppHtml` behält ihn (nur `wp-`/`has-`/`is-style-`-Klassen fliegen raus).

Gegated durch `tests/unit/wp-html.test.mjs`: `appToWpHtml → wpToAppHtml` mit Verzeichnis muss buchstabengleich dasselbe liefern wie ohne, über drei Zyklen hinweg, mit erhaltenem `data-src`/`data-loc` am Chip. Der Pull-Strip ist mutationsgeprüft (Strip deaktivieren ⇒ drei Tests rot).

### KSES: Chip ohne Zeiger

WordPress' KSES entfernt `data-*`-Attribute, wenn dem verbundenen Benutzer die Capability `unfiltered_html` fehlt (bei Multisite fehlt sie auch Admins). Dann kommt vom Pull ein `<span class="cite">(Kafka, 1915, S. 44)</span>` **ohne Zeiger** zurück — eine Quellenangabe, die auf nichts zeigt.

`wpToAppHtml` degradiert solche Chips zu reinem Text: der lesbare Kurzbeleg bleibt im Satz (er ist das einzige, was noch da ist), das Chip-Markup fällt weg. **Es wird nie auf eine Quelle geraten** — nicht über den Chip-Text (der ist explizit nur ein Cache und unterscheidet zwei Quellen desselben Autors im selben Jahr nicht) und nicht über die Quellenliste des Buchs; ein falscher Zeiger wäre schlimmer als keiner, weil er unbemerkt ins Verzeichnis wanderte. Der Fall wird gezählt (`stats.citesDegraded`), landet in `job.result.citesDegraded` von Import und Pull, geht als Warnung ins Log und erscheint im Blog-Tab als `.card-form-warn`-Hinweis (`blog.status.citesDegraded`).

Ein `span.cite` mit unbrauchbarem `data-src` (`"0"`, `"abc"`) ist laut SSoT kein Nachweis, sondern Fremdmarkup — es wird ebenfalls entpackt, aber **nicht** als KSES-Verlust gezählt.

## Sync-Jobs

### `runBlogImportJob(bookId)` — einmalig

Gated: `initial_import_done_at IS NULL`. Zweiter Aufruf → 400 `ALREADY_IMPORTED`.

1. paginate `listPosts({ perPage: 100 })`
2. pro Post: Page via Content-Store (`createPage`) anlegen mit `wpToAppHtml(content.rendered)`, `page_name = title.rendered`
3. Link-Eintrag in `blog_page_links` mit `wp_modified_at = post.modified_gmt`, `last_pulled_at = NOW_ISO_SQL`
4. Status via `updateJob` mit Key `job.blog.import.progress`, Params `{done, total}`
5. am Ende `initial_import_done_at = NOW_ISO_SQL`

### `runBlogPullJob(bookId)` — manuell, Delta

Voraussetzung: Initial-Import durch. Sonst 400 `IMPORT_FIRST`.

1. `listPosts({ modifiedAfter: conn.last_pull_at })` paginieren
2. pro Post: 4-Fall-LWW aus „Konflikt-Strategie"
3. neue Posts (kein Link, kein Slug-Match) → Page anlegen + Link
4. `last_pull_at = NOW_ISO_SQL`

### `runBlogPushJob(bookId, pageIds[])` — manuell, Multi-Select

Vor dem Upload läuft `appToWpHtmlWithMedia(html, { resolveImage, bibliography })` mit einem `makeImageResolver` (Blog-Origin aus `conn.base_url`): Inline-Bilder werden ggf. in die WP-Mediathek geladen (`job.result.imagesUploaded` zählt neue Uploads). Upload-Fehler verwerfen nur das Bild, nicht den Push. Quellen-Chips werden vorher per `resolveCitesInHtml` aktualisiert, das Verzeichnis kommt bei aktivem `bibliography_in_blog` als markierter Block dazu (siehe „Quellenverzeichnis im Post").

1. pro `pageId`:
   - kein Link → `createPost({ title, content: appToWpHtmlWithMedia, status: conn.default_status, slug })` → Link anlegen.
     **Titel-Normalisierung (nur Create):** Der Datum-Prefix `YYYY-MM-DD:` ist **app-intern**. Der lokale `page_name` wird auf `YYYY-MM-DD: Rest` gebracht (Datum = `localIsoDate()`); leerer Rest → nur das Datum; vorhandener Prefix (`^\d{4}-\d{2}-\d{2}(?:\s*:\s*…)?$`) wird durch heute ersetzt. **WordPress bekommt den Titel ohne Datum** (nur `Rest`; leerer Rest → leerer WP-Titel). Lokaler `page_name` zieht via `contentStore.savePage` synchron nach; jede Umbenennung landet in `job.result.renamed: [{ pageId, name }]`, damit das Frontend Sidebar-Tree + offenen Editor-Titel nachzieht (`sync-core.js#_applyPushRenames`). Updates rühren den Titel nicht an.
   - Link da, kein Konflikt → `updatePost(id, …)`, `wp_modified_at` aus Response übernehmen
   - `conflict_state='detected'` → skip, Fehler in Job-Result
   - **WP-Post drüben gelöscht** (`BLOG_HTTP_404` von `updatePost`) → Link wird entfernt, Error-Code `BLOG_REMOTE_GONE` ins Result; Page-Badge flippt auf `new`. Erneuter Push erstellt einen frischen Post.
2. `last_push_at = NOW_ISO_SQL`

### `runBlogReconcileJob(bookId)` — on demand

Drift-Check zwischen lokalen Links und WP-Realität. Deckt Hard-Delete drüben (kein Trash-Stamp im Pull-Delta sichtbar).

1. `_requireBlogBook` + `_resolveBlogConn`.
2. `blogs.listLinksForBlog(conn.id)` → pro Link ein `wp.getPost(wp_post_id)`.
3. Bei `BLOG_HTTP_404` → `blogs.deleteLink(link.page_id)` (Marker weg, Page bleibt). Andere Fehler werden nur geloggt, Link bleibt.
4. Job-Result: `{ checked, removed }`. Buchorganizer-Badge flippt nach `loadLinks` für betroffene Pages auf `new`; erneuter Push erstellt einen neuen Post.

## UI

### BookSettings-Tab „Blog-Verbindung"

Sichtbar nur bei `buchtyp === 'blog'`. Form-Felder:

- URL (HTTPS-Validierung, sonst Submit-Button disabled + Hint)
- Username
- Password (write-only; Read liefert `hasCredentials: true`)
- Default-Status (Combobox: draft/publish/private)
- Test-Button → `users/me` mit `capabilities.edit_posts`-Check

Status-Panel: `initial_import_done_at`, `last_pull_at`, `last_push_at` (alle via `tzOpts`).

Aktion-Buttons:
- **„Initial-Import starten"** — nur sichtbar wenn `!initial_import_done_at`
- **„Pull"** — nur sichtbar wenn Import durch
- **„Verbindung prüfen"** — Reconcile-Job; nur sichtbar wenn Import durch. Ruft `GET /posts/{id}` für jeden Link, dropt 404-Orphans. Confirm-Dialog vor Start (kann je nach Link-Anzahl dauern).
- **„Disconnect"** — löscht Connection-Row + Links via FK-CASCADE

### Sync-Core (geteilt mit HubSpot)

`blog-sync-card.js` ist ein Wrapper über [public/js/cards/sync/sync-core.js](../public/js/cards/sync/sync-core.js): Provider-Spec liefert `endpointBase: '/blog'`, `jobTypes: { push: 'blog-push', refresh: ['blog-import','blog-pull'], reconcile: 'blog-reconcile' }`, `computeStatus`, `statusLabels`, `canPushStatuses: ['new','push-needed']`. `reconcile` triggert nach Job-Done ein `loadLinks()` (entfernte Orphans verschwinden aus dem Buchorganizer). Konflikt-Diff (`hasConflict: true`, `openConflict`/`resolveConflict`) bleibt provider-spezifisch via `spreadExt`. Templates iterieren über `$syncProviders` ([public/js/app.js](../public/js/app.js)), kein WP-spezifisches Markup mehr in [buchorganizer.html](../public/partials/buchorganizer.html) / [editor-notebook.html](../public/partials/editor-notebook.html) — nur Provider-agnostisches `.sync-provider--blog` / `badge--sync-*` / `organizer-sync-push`. CSS-Accent: `.sync-provider--blog { --sync-accent: var(--card-accent-blog); }`.

### Buchorganizer

Pro Page ein eckiges Badge (`--card-accent-blog`) mit Status:

- `synced` — `wp_modified_at == link.wp_modified_at && page.updated_at <= link.last_pulled_at`
- `push-needed` — `page.updated_at > link.last_pulled_at`
- `pull-needed` — Pull hat neueren WP-Modified-Stamp gesehen (selten direkt im Tree, da Pull schon mergt)
- `conflict` — `conflict_state='detected'`

Tooltip via `data-tip`.

Page-Kontext:
- „Zu Blog pushen"
- „Konflikt lösen → Diff" — öffnet `page-revision-diff` gegen `getPost`

Buch-Level: Multi-Select aus Tree + „Lokale Änderungen pushen".

## i18n

Neue Keys in `public/js/i18n/de.json` + `public/js/i18n/en.json`:

```
blog.connect.title|url|user|password|defaultStatus|test|save|disconnect
blog.status.synced|pushNeeded|pullNeeded|conflict|notImported|imported
blog.action.import|pull|push|reconcile|reconcileHint|reconcileConfirm|resolveConflict
blog.error.httpOnly|authFailed|notBlogType|conflictDetected|alreadyImported|importFirst|BLOG_REMOTE_GONE|BLOG_RECONCILE_FAILED
job.label.blogReconcile
job.blog.import.progress
job.blog.pull.fetch|job.blog.pull.merge
job.blog.push.upload
job.blog.reconcile.check
```

Persistierte Conflict-Notice in DB: `__i18n:blog.conflict.detected__`.

Buchtyp-Label in [prompt-config.json](../prompt-config.json):

```json
"buchtypen": {
  "de": { "blog": { "label": "Blog", "zusatz": "Blog-Einträge. Pro Eintrag eigenständig…" } },
  "en": { "blog": { "label": "Blog", "zusatz": "Blog posts. Each entry self-contained…" } }
}
```

## Sicherheit

- `base_url` MUSS mit `https://` beginnen — sonst 400 `BLOG_HTTPS_REQUIRED`
- Passwort: AES-Encrypt via [lib/crypto.js](../lib/crypto.js). `GET /blog/:book_id/status` liefert nur `{ hasCredentials, baseUrl, username, defaultStatus, …timestamps }`. PW nie an Client.
- Connect-Test: `users/me` muss `capabilities.edit_posts === true` zurückgeben.
- 401 von WP → Job-Fehler `blog.error.authFailed`
- Buchtyp-Gate serverseitig hart: Connect/Import/Pull/Push prüfen `buchtyp === 'blog'`, sonst 400 `BLOG_REQUIRES_BLOG_TYPE`
- Job-Dedup via `findActiveJobId` verhindert parallele Pull/Push pro Buch
- `setContext({ book: bookId })` in jedem Job-POST (Logging-Slot)

## Tests

### Unit (`tests/unit/`)
- `wp-html.test.mjs` — Block-Wrap/Unwrap Round-Trip, Inline-Erhalt, Bild-Erhalt bei Import + `wp:image`-Wrap bei Export (inkl. Attachment-ID + figcaption), Nicht-Bild-Embed-Strip, async Media-Pass (`appToWpHtmlWithMedia`); **Quellenverzeichnis:** markierter `wp:group`-Anhang, Listen- vs. Absatz-Form je Zitierstil, die Akkumulations-Invariante (Round-Trip mit == ohne Verzeichnis, auch über drei Zyklen, `data-src` erhalten — mutationsgeprüft) und der KSES-Guard (Chip ohne `data-src` → Klartext + gezählt, nie geraten)
- `wp-client.test.mjs` — Pagination via `X-WP-TotalPages`, 401-Handling, HTTPS-Reject, Backoff bei 429/5xx
- `wp-media.test.mjs` — Resolver: blog-gehostet unverändert, data-URI/fremde URL → Upload, MIME-Reject, Fetch-Fehler → `null`
- `blog-merge.test.mjs` — alle 4 LWW-Fälle (`classifyPull`) + `newer`-Vergleich

### Integration (`tests/integration/`)
- `blog-sync.test.js` — Express-WP-Stub, Round-Trip: Initial-Import → lokales Edit → Push → Pull → no-op. Konflikt-Pfad: gleichzeitige Änderung beidseits → `conflict_state='detected'`.

### Drift
- `tests/unit/erd-drift.test.mjs` grünt nach ERD-Update
- `tests/unit/squash-drift.test.mjs` grünt nach `npm run squash:regen`

## Reihenfolge der Umsetzung

1. Buchtyp `blog` in [prompt-config.json](../prompt-config.json) (de+en)
2. Migration N + ERD + `npm run squash:regen` + Drift-Tests grün
3. `lib/wp-client.js` + Unit-Tests
4. `lib/wp-html.js` + Block-Mapping + Unit-Tests
5. `db/blogs.js` + `routes/blog.js` (mit Buchtyp-Gate)
6. `routes/jobs/blog-sync.js` (Import → Pull → Push) + Integration-Tests
7. BookSettings-Tab (Form + Aktionen)
8. Buchorganizer-Badges + Push-Action + Konflikt-Diff-Reuse
9. i18n komplett (de + en synchron)
10. `SHELL_CACHE` bump in [public/sw.js](../public/sw.js)
11. Manuell gegen echte WP-Instanz testen (Test-Buch 102 als Typ `blog`)
