# WordPress-Import

One-Shot-Import einer WordPress-Site in BookStack via mysqldump-Datei. Liest Posts (`status=publish, type=post`) plus Categories aus dem Dump, sortiert nach Veröffentlichungsdatum aufsteigend (älteste zuerst), gruppiert pro Yoast-Primary-Category in BookStack-Kapitel.

**Script:** [scripts/wp-import.js](../scripts/wp-import.js)

## Voraussetzungen

- `.env` mit `API_HOST`, `TOKEN_ID`, `TOKEN_KENNWORT` (gleiche Variablen wie die App selbst).
- BookStack-User des API-Tokens braucht Schreibrechte auf das Zielbuch.
- mysqldump-Datei im Format `utf8mb4`. Erzeugen z.B. mit:
  ```bash
  mysqldump --default-character-set=utf8mb4 --single-transaction \
            -u root -p wordpress > wp-dump.sql
  ```
- Zielbuch in BookStack-UI **vorab anlegen**, ID notieren (steht in der URL: `/books/<slug>` → API gibt sie via `GET /api/books`).

## Ablauf

1. Buch in BookStack anlegen.
2. Dump exportieren und lokal verfügbar machen.
3. Dry-Run mit Limit:
   ```bash
   node scripts/wp-import.js --dump wp-dump.sql --book-id 42 --dry-run --limit 5
   ```
   Output prüfen:
   - Stimmen Anzahl + Reihenfolge der Kapitel?
   - Sind alle Categories als Chapter gemapped?
   - Wirken Titel und Datums-Sortierung plausibel?
4. Voller Dry-Run (ohne `--limit`), Output in Datei umleiten und stichprobenartig HTML-Cleanup im Browser checken (DevTools → ein paar `pushPage`-Bodies in BookStack-Editor pasten und schauen).
5. Echter Lauf:
   ```bash
   node scripts/wp-import.js --dump wp-dump.sql --book-id 42
   ```
   Vor dem Push zeigt das Script den vollen Importplan (Kapitel + alle Seitentitel mit Datums-Prefix) und wartet auf `j`/`ja`/`y`/`yes`. Mit `--yes` (bzw. `-y`) wird die Bestätigung übersprungen.
6. In BookStack: Buch öffnen, Stichproben — Reihenfolge, Kategorien, Tags (`wp-id`, `wp-slug`, `wp-date`).

## CLI-Flags

| Flag | Pflicht | Default | Bedeutung |
|------|---------|---------|-----------|
| `--dump` | ✓ | — | Pfad zur mysqldump-Datei |
| `--book-id` | ✓ | — | BookStack-Buch-ID, in das importiert wird |
| `--prefix` | — | `wp_` | Tabellen-Prefix im Dump (manche Installs nutzen `wp1234_`, `wpcustom_`) |
| `--dry-run` | — | aus | Zeigt Plan, schreibt nichts an BookStack |
| `--limit N` | — | alle | Nur die ersten N Posts (nach Sortierung) — gut zum Testen |
| `--yes` / `-y` | — | aus | Bestätigungsprompt überspringen (für CI / Skripte) |

## Was importiert wird

**Aus dem Dump:**
- `wp_posts` mit `post_status='publish' AND post_type='post'` (Drafts + WP-Pages werden ignoriert).
- `wp_terms` + `wp_term_taxonomy` + `wp_term_relationships` für Categories.
- `wp_postmeta`-Schlüssel `_yoast_wpseo_primary_category` (falls vorhanden) für Primary-Category-Wahl.

**Nach BookStack:**
- Pro unique Category ein **Chapter** unter dem Zielbuch. Reihenfolge der Chapter = Datum des ersten Posts pro Category aufsteigend, `priority = (i+1) * 10`.
- Pro Post eine **Page** im jeweiligen Chapter. `priority = (localIdx+1) * 10`, also Lücken für späteres manuelles Reorder. Seitentitel mit Datums-Prefix `YYYY-MM-DD ` (Veröffentlichungsdatum aus `post_date_gmt`).
- **Tags pro Page:**
  - `wp-id` — Original-Post-ID (Traceability für spätere Re-Runs / nginx-Redirect-Maps)
  - `wp-slug` — Original-Permalink-Slug
  - `wp-date` — Original-Publish-Date (`YYYY-MM-DD`)
  - `category` — alle weiteren Categories des Posts (Multi-Cat-Spillover; die Primary wird nicht doppelt getaggt)

## Category → Chapter-Logik

Pro Post wird genau eine Primary-Category bestimmt:

1. Yoast-SEO `_yoast_wpseo_primary_category`-Postmeta, falls gesetzt.
2. Sonst: erste Category in alphabetischer Sortierung der Post-Categories.
3. Sonst: `Unkategorisiert` (Fallback-Chapter).

Begründung: BookStack-Pages leben in genau einem Chapter. Multi-Cat-Posts werden nicht dupliziert; die Sekundär-Categories landen als Tags an der Page (siehe oben).

## HTML-Cleanup

Pro Post werden auf `post_content` angewendet:

- **Gutenberg-Block-Kommentare strippen:** `<!-- wp:paragraph -->` etc. werden entfernt, die enthaltenen Tags bleiben.
- **`[caption]`-Shortcode unwrappen:** Wrapper raus, innerer Inhalt bleibt (für Bilder ohne Anhang-Migration meist sinnvoll, da das `<img>` darin ohnehin auf die alte Domain zeigt).
- **Andere Shortcodes** (`[gallery]`, `[contact-form-7]`, plugin-spezifisch) werden in `<pre class="wp-shortcode">…</pre>` eingewickelt — kein automatisches Rendering, aber sichtbar für späteres manuelles Review.
- **`wpautop`-Äquivalent:** Doppel-Newlines → `<p>…</p>`-Wraps, Single-Newlines → `<br>`. Nur ausserhalb bekannter Block-Tags (p, div, h1-h6, ul, ol, li, blockquote, pre, figure, table…). Sonst blieb der Classic-Editor-Inhalt im BookStack-Renderer ohne Absätze.

**Was nicht gemacht wird:**
- Bilder werden nicht migriert. Inline-`<img src="https://altedomain/...">` bleibt mit absoluter URL stehen. Falls die alte WP-Domain online bleibt, lädt das Bild weiter; sonst manuell ersetzen oder separates Bild-Migrations-Script anhängen.
- Old-WP-URL-Redirects werden nicht erzeugt. Falls SEO/Bookmark-Erhalt wichtig: `wp-slug`-Tags später aus BookStack ziehen und nginx-`map`-Block bauen.
- Drafts, Revisions, WP-Pages, Custom-Post-Types werden ignoriert. Falls gewünscht, im Script den Filter (`post_status === 'publish' && post_type === 'post'` in `joinPosts()`) anpassen.

## Funktionsweise (Parser)

Der Parser ist standalone, ohne mysql-Server-Abhängigkeit, ohne Drittpaket:

- **Streaming:** liest den Dump in 1-MB-Chunks, erkennt Statement-Grenzen zeichenweise (String-/Kommentar-aware: `'…'`, `\\`-Escapes, `-- …`/`# …`-Zeilenkommentare, `/* … */`-Blöcke).
- **CREATE-TABLE:** extrahiert Spaltenreihenfolge per Regex.
- **INSERT-INTO:** verarbeitet Multi-Row-`VALUES (…), (…), (…);`. Tuple werden mit echtem MySQL-Escape-Handling (`\n`, `\r`, `\t`, `\0`, `\Z`, `\\`, `\'`, `\"`, doppelte `''`) geparst.
- **JOIN in JS:** Maps für `term_id → name`, `term_taxonomy_id → term_id`, `post_id → primary` (Yoast), `post_id → [categories]`. Keine SQLite-/MySQL-Engine im Spiel.
- **Hauptspeicher:** alle Rows der 5 relevanten Tabellen liegen während des JOINs im RAM. Bei wirklich grossen Dumps (Hunderttausende Posts) muss man auf SQLite-In-Memory umsteigen (better-sqlite3 ist im Projekt vorhanden) — für übliche Blogs reicht der JS-JOIN locker.

## Re-Run / Idempotenz

Aktuell **nicht idempotent.** Ein zweiter Lauf erzeugt Duplikate (neue Chapter mit gleichen Namen, neue Pages). Workarounds:

- **Vor Re-Run:** Buch in BookStack-UI leeren oder neu anlegen.
- **Selektive Re-Runs:** `--limit N` plus manuelle Filterung im Code (z.B. `posts.slice(N)`) — schneller Hack für „nur den Rest".
- **Sauber idempotent machen** (falls häufig nötig): vor jedem `POST /chapters` per `GET /api/chapters?filter[book_id]=…&filter[name]=…` checken, vor jedem `POST /pages` per `wp-id`-Tag checken (`GET /api/pages?filter[tags.name]=wp-id&filter[tags.value]=42`). Code dazu nicht eingebaut, weil one-shot ausreichend ist.

## Fehlerbilder

| Symptom | Ursache | Fix |
|---------|---------|-----|
| `FEHLER: --dump pflicht.` | Argument fehlt | Beide Pflicht-Flags setzen |
| `Dump-Datei "..." nicht gefunden` | Pfad falsch / kein Read-Recht | `ls -la <pfad>` checken |
| `--prefix "..." enthält ungültige Zeichen` | Whitelist `[a-zA-Z0-9_]+` | Prefix korrigieren (kein Punkt, kein Bindestrich) |
| `keine Spalten für wp_xxx bekannt — INSERT übersprungen` | INSERT vor zugehörigem CREATE TABLE im Dump (selten) | Dump neu generieren mit Default-Reihenfolge, oder `INSERT … (col1, col2, …) VALUES …`-Form (Script erkennt beide) |
| Umlaute kaputt | Dump nicht in `utf8mb4` exportiert | Mit `--default-character-set=utf8mb4` neu dumpen |
| Manche Posts fehlen | `post_status` ≠ `publish` oder `post_type` ≠ `post` | In Dump per `grep "INSERT INTO \`wp_posts\`"` prüfen, Filter im Script ggf. lockern |
| 401 von BookStack | Token in `.env` ungültig oder abgelaufen | In BookStack neue API-Tokens generieren, `.env` aktualisieren |
| 403 | API-User hat keine Schreibrechte aufs Buch | Rollen-/Permission-Check in BookStack |

## Rollback

`POST /api/chapters` und `POST /api/pages` haben kein Bulk-Delete. Abbruch mitten im Lauf bedeutet: angelegte Chapter/Pages bleiben stehen. Optionen:

- BookStack-UI → Buch öffnen → Chapter/Pages manuell löschen.
- Oder Buch komplett löschen und neu anlegen (Tags + Pages + Chapter weg).
- Oder via API: alle Pages mit `wp-id`-Tag im Buch holen (`GET /api/pages?filter[book_id]=…`), per Loop `DELETE /api/pages/<id>`.
