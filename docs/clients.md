# Clients (macOS, Android, Browser-Erweiterung)

Neben der Web-SPA gibt es drei Clients, die in eigenen Repos leben und denselben Server konsumieren — **zwei schreibende Offline-First-Editoren und eine erfassende Erweiterung**:

- **macOS** — [schreibwerkstatt-focuseditor](https://github.com/bedeberger/schreibwerkstatt-focuseditor): der Focus-Writer in einer WKWebView-Schale, die den Editor-Kern per OTA zieht (siehe [docs/focus-editor.md](focus-editor.md) → `setEditorHost()`/Bridge).
- **Android** — [schreibwerkstatt-mobile](https://github.com/bedeberger/schreibwerkstatt-mobile): native Mobile-App mit nativer Navigation/UI; der Schreibmodus selbst ist eine WebView, die denselben Editor-Kern per OTA zieht (eigenes Boot-HTML `assets/editor-host/host.html` + `editor-host.css`, Bundle-Load via `BundleManager`/`EditorViewModel`). Gleiche Auth + Sync.
- **Chrome** — `schreibwerkstatt-browser-extension`: erfasst beim Surfen Webseiten ins Recherche-Board bzw. in die Quellen-Bibliothek. **Kein Editor-Client** — kein Editor-Bundle, kein Sync, keine Presence, und nie in den Manuskripttext. Teilt mit den nativen Clients nur das Device-Token, und auch das mit engerem Scope. Eigener Abschnitt: „[Dritter Client](#dritter-client-browser-erweiterung-chrome-capture-scope)".

Diese Datei ist der **Überblick über die client-seitige Server-Schicht** (Auth, OTA, Sync, Presence, Release-Discovery). Der Editor-Kern selbst und die Bridge in fremde Schalen sind in [docs/focus-editor.md](focus-editor.md) dokumentiert; das Sync-/Konflikt-Modell der Seiten in [docs/notebook-editor.md](notebook-editor.md) (Block-Level-Merge).

> **SSoT bleibt dieses Repo.** Editor-Code lebt unter `public/js`, UI-Strings unter `public/js/i18n` bzw. `assets/macclient-i18n`. Die Clients ziehen Code/Strings zur Laufzeit oder bündeln einen Stand mit — sie sind nie die Quelle.

## Authentifizierung: Device-Token (`swd_…`)

Native Clients haben keine OAuth-Browser-Session, sondern authentisieren per **Device-Bearer-Token**.

- **Format** `swd_<32 Hex-Bytes>` ([db/device-tokens.js](../db/device-tokens.js)). Eigener Prefix, damit der Device-Pfad fremde `sw_…`-Tokens (`api_tokens`/Metrics) früh abweist.
- **Speicherung:** nur der SHA-256-Hash liegt in `device_tokens`. Der Klartext wird **genau einmal** bei `POST /me/device-tokens` zurückgegeben — danach nicht mehr rekonstruierbar.
- **Auflösung** ([lib/device-auth.js](../lib/device-auth.js) `tryDeviceAuth`): Anders als der admin-scoped Metrics-Bearer löst ein Device-Token auf den **echten User + dessen echte Rolle** auf und respektiert das Status-Gate (`suspended`/`deleted` → abgewiesen). Greift im globalen Auth-Guard ([server.js](../server.js)) — liefert es ein User-Objekt, wird der Request wie eine normale Session behandelt; sonst fällt der Guard auf 401/Redirect zurück.
- **Pflege** (Profil `/me`, Routen in [routes/usersettings.js](../routes/usersettings.js)):
  - `GET /me/device-tokens` — eigene Tokens auflisten
  - `POST /me/device-tokens` — Token ausstellen (gibt `plain_token` einmalig zurück). Body `{ device_name, platform?, kind? }`; `kind` wählt den Rechteumfang (siehe „Scopes" unten), unbekannte Art → `400 INVALID_VALUE` statt stiller Default. Ein Request, der **selbst per Device-Token** authentisiert ist, darf kein neues Token minten → `403 DEVICE_TOKEN_SELF_MINT_FORBIDDEN` (kein Token-Rollover ohne Browser-Login).
  - `POST /me/device-tokens/:id/revoke` — Soft-Revoke (`revoked_at`)
  - `DELETE /me/device-tokens/:id` — endgültig löschen
- **Nutzungs-Tracking:** jeder authentifizierte Request ruft `touchTokenUsage` → `last_used_at`, `last_used_ip`, `use_count +1` und persistiert die per `X-Client-Version` gemeldete Version (`COALESCE` hält den letzten bekannten Wert).
- **Admin-Übersicht:** [routes/admin-devices.js](../routes/admin-devices.js) (`GET /admin/devices`) listet alle Tokens user-übergreifend (Admin-Tab „Geräte"), inkl. Version → erlaubt Versionsskew gegen das neueste Release zu erkennen.
- **Ausnahme Demo-Zugang (Store-Reviews):** auf einer Demo-Instanz können die Tokens in der ENV festgenagelt werden (`DEMO_DEVICE_TOKEN`, `DEMO_CAPTURE_TOKEN` → [lib/demo-user.js](../lib/demo-user.js)#`ensureDemoTokens`, `db/device-tokens.js#upsertFixedDeviceToken`). **Why:** ein Store-Reviewer kommt sonst nicht in den Client — der normale Weg (Browser-Login → Profil → minten → kopieren) ist der Punkt, an dem eine Review als „App unbenutzbar" endet. Registriert wird beim **Serverstart**, denn diese Clients rufen die Login-Seite nie auf. Der Klartext steht in den Reviewer-Notes, die DB hält weiter nur den Hash; Format (`swd_` + 64 Hex) ist Pflicht und fail-closed. Die Scopes kommen aus `TOKEN_KINDS` — **kein** Sonderrechte-Pfad. Widerruf/Löschen dieser Rows über `/me/device-tokens` ist gesperrt (`403 DEMO_TOKEN_FIXED`), entzogen wird über die ENV. Betriebsregeln: [README.md](../README.md) → „Demo-Zugang".

### Scopes: was ein Token darf ([lib/device-scopes.js](../lib/device-scopes.js))

`device_tokens.scopes` ist **durchgesetzt**, nicht dekorativ: das Gate `deviceScopeGate` hängt im globalen Auth-Guard direkt hinter `tryDeviceAuth` und vor jedem Route-Mount ([server.js](../server.js)). Es greift **nur** bei Requests via Device-Token — Browser-Sessions und `api_token`-Requests (`/metrics`) haben ihr eigenes Rechtemodell.

| `kind` beim Ausstellen | Scopes | Wirkung |
|---|---|---|
| `device` (Default) | `content:read,content:write` | Unbeschränkt — die vollen Rechte des Users. Für macOS/Android, die das Manuskript bearbeiten. **Ungegated**, damit bereits ausgestellte Client-Tokens unverändert weiterlaufen. |
| `capture` | `content:read,capture:write` | Nur Erfassen — Lesen aus `READ_ALLOW`, Schreiben aus `CAPTURE_ALLOW` (Tabelle unten). Alles andere → `403 DEVICE_SCOPE_FORBIDDEN`. |

**Die Scopes wirken additiv, Lesen und Schreiben hängen an getrennten Listen** ([lib/device-scopes.js](../lib/device-scopes.js)):

| Scope | Öffnet | Endpunkte |
|---|---|---|
| `content:read` | `READ_ALLOW` (**nur** `GET`) | `GET /content/books`, `GET /research`, `GET /research/tags`, `GET /sources{,/pool,/stats,/lookup,/by-url}` |
| `capture:write` | `CAPTURE_ALLOW` (kein `GET`) | `POST /research`, `POST /research/:id/{image,doc}`, `POST /sources`, `POST /sources/:id/{link,doc}`, `POST /capture` |
| `content:write` | alles | ungegated |

> **Die Allowlisten sind Rechte-Listen, keine Routen-Listen.** Sie sagen, was ein Scope *darf* — nicht, was es *gibt*, und nichts über Parameter, Body oder Antwortform. Verbindlich für Client-Autoren sind die Endpunkte und Fehlercodes weiter unten („[Dritter Client](#dritter-client-browser-erweiterung-chrome-capture-scope)"); ein Muster in [lib/device-scopes.js](../lib/device-scopes.js) ist keine Zusage, dass der Pfad existiert.

**Why getrennt:** die Erweiterung fragt vor dem Erfassen „kenne ich diese Seite schon" — dafür soll kein Token nötig sein, das auch anlegen darf. Ein Token mit `content:read` allein ist damit ein echtes Nur-Lese-Token; die beiden ausstellbaren Arten tragen den Lese-Scope ohnehin, für sie ändert sich nichts. `READ_ALLOW` enthält ausschliesslich `GET`-Einträge — ein Schreib-Eintrag dort würde am `capture:write`-Gate vorbei schreiben lassen und ist durch [tests/unit/device-scopes.test.js](../tests/unit/device-scopes.test.js) verboten.

Für die Browser-Erweiterung ist `capture` **Pflicht**: sie lebt in fremden Tabs, und ein dort entwendetes Token darf nicht am Manuskript schreiben können. Ausgeschlossen sind damit u.a. `/content/books/:id/pages*`, `/book-editor/*`, `/me/*` (kein Weiter-Minten), `/admin/*`, `/jobs/*` (keine KI-Kosten auf Zuruf) und **jedes** `DELETE`.

Ein Token ohne einen der drei Scopes darf nichts (Deny-by-default) — die restriktive Richtung, falls später ein vierter Scope entsteht und dieses Modul dabei vergessen wird. Beide Allowlisten sind bewusst explizite Listen und keine Präfix-Muster; Pfade werden vorher kleingeschrieben und um einen Trailing-Slash normalisiert, weil Express case-insensitiv routet.

### Client-Selbstidentifikation (Header)

Pro Request, ergänzend zum statischen `device_tokens.platform`:

| Header | Zweck |
|--------|-------|
| `X-Client-Version` | persistiert in `device_tokens.client_version` (Versionsskew-Erkennung im Admin-Tab) |
| `X-Client-Platform` | Runtime-Plattform-Hinweis (`clientPlatform`) — korrekt auch, wenn dasselbe Token auf Mac + Android läuft |
| `X-Client-Device` | Runtime-Gerätename (`clientDevice`) |

`X-Client-Platform`/`-Device` beschreiben das **tatsächlich** anfragende Gerät und fließen ins Revision-Label (siehe `lib/content-store#_clientFromCtx`). Fehlen sie, fällt das Label auf die statischen Token-Felder zurück.

## Datenmodell

- **`device_tokens`** ([db/device-tokens.js](../db/device-tokens.js), ERD in [docs/erd.md](erd.md)) — die Bearer-Tokens. FK `app_users(email)` CASCADE, `token_hash` UNIQUE. Default-Scopes `content:read,content:write`.
- **`app_users_devices`** — Browser-/Geräte-Sessions (UUID `device_id`, Auto-Label aus UA). Trägt Multi-Device-Presence und `pages.last_editor_device_id` (wer eine Seite zuletzt von welchem Gerät editiert hat). **Nicht** zu verwechseln mit `device_tokens`: `app_users_devices` ist die Presence-/Audit-Identität (auch für Browser-Tabs), `device_tokens` ist der Auth-Credential der nativen Clients.

## OTA: Editor-Bundle (macOS + Android)

Beide Clients sind Web-Schalen ohne Alpine um denselben Editor-Kern, den sie **zur Laufzeit** ziehen und lokal cachen (statt ihn zur Build-Zeit aus dem Repo zu kopieren). Jeder Client bringt nur sein eigenes Boot-/Bridge-HTML mit.

- `GET /content/editor-bundle.zip` ([routes/content.js](../routes/content.js)) — ZIP mit der transitiven ES-Modul-Import-Closure ab `focus/standalone.js` + `shared/editor-host.js` + `shared/block-merge.js` (+ Spellcheck-/Synonym-Controller), den Focus-Editor-CSS-Dateien und einem `bundle-manifest.json` (`{ sourceCommit, jsFiles[], cssFiles[] }`). **Kein** `index.html` — das Boot-/Bridge-HTML besitzt der Client.
- **SSoT der Closure-Auflösung:** [lib/editor-bundle.js](../lib/editor-bundle.js) (`specifiersOf`/`resolveSpecifier`/`buildClosure`). Editor-Code-SSoT bleibt `public/js` — hier wird nur gelesen und gepackt.
- **Caching:** `ETag = sha256(sourceCommit + sortierte Datei-Hashes)`, `Cache-Control: no-cache` → der Client fragt bei jedem Online-Start konditional an; `If-None-Match` mit passendem ETag → `304` ohne Body.
- **Host-CSS schlägt Bundle-CSS.** Das gesamte Editor-CSS liegt in `@layer components`; **unlayered** Regeln im Boot-CSS des Clients (macOS `editor-host.css`, Android `assets/editor-host/editor-host.css`) gewinnen unabhängig von Spezifität. Wer dort `.focus-editor`/`.focus-editor__content` anfasst, kann Höhenkette und Scroll-Box aushebeln, ohne dass der Editor sich wehren kann. Der Editor fängt genau diesen Fall ab: `resolveScrollBox` löst die Scroll-Box auf und Typewriter, Scroll-Listener (document-Capture), IntersectionObserver-Root und `--focus-box-h`-Messung hängen alle daran ([focus-editor.md](focus-editor.md) Invariante 13). Programmatische Scrolls verlangen `behavior: 'instant'`, damit ein `scroll-behavior: smooth` im Host-CSS sie nicht animiert (Invariante 14a). Gegated ist die Konstellation in [tests/e2e/focus-shell-host.spec.js](../tests/e2e/focus-shell-host.spec.js) — **wer Host-CSS im Client anfasst, prüft dort gegen** — Spotlight-Puffer und Schreiblinie hängen aber weiter an den Formeln aus `focus-mode.css` (Invariante 9).
- **Beide Clients ziehen dasselbe ZIP** (macOS `EditorBundleStore`, Android `BundleManager` → `ensureBundle` beim Öffnen des Editors). JS und CSS kommen darin **atomar** aus einem Stand — ein Skew zwischen neuem Editor-JS und altem Editor-CSS ist ausgeschlossen. Folge: Editor-Änderungen erreichen beide Clients erst nach einem **Server-Deploy** (neuer ETag), nicht nach einem App-Update.

## OTA: i18n-Overrides (nur macOS)

- `GET /content/macclient-i18n.json` ([routes/content.js](../routes/content.js)) — flaches `{ de: {…}, en: {…} }`. Der Client bündelt dieselben Kataloge mit; dieser Endpunkt erlaubt es, einzelne Keys **zentral zu überschreiben** (fehlende Keys fallen im Client auf den gebündelten Stand zurück).
- **SSoT der Server-Overrides:** [assets/macclient-i18n/{de,en}.json](../assets/macclient-i18n/) (Logik in [lib/macclient-i18n.js](../lib/macclient-i18n.js)). ETag = sha256(Body), 304 wie oben.
- **Android hat kein Server-i18n-Override** — die App verwaltet ihre Strings nativ. (Bewusst: kein `assets/androidclient-i18n/`.)

## Sync & Presence (beide Clients)

Offline-First: der Client hält einen lokalen SQLite-Spiegel und synchronisiert per Delta gegen den Server.

- **Pull (Spiegel aktualisieren):** `GET /content/books/:book_id/sync?since=<iso>&since_id=<n>&limit=<n>` ([routes/content.js](../routes/content.js)) — liefert **alle** seit dem Cursor geänderten/neuen Seiten **inkl. eigener Edits**, mit vollem HTML. Keyset-Cursor `(updated_at, page_id)`, Antwort trägt `cursor` + `has_more`; der Client paged bis `has_more=false`. Ohne `since` = Voll-Pull (Baseline).
- **Gelöschte Seiten:** derselbe Aufruf liefert `deleted: [{ page_id, page_name, deleted_at }]` (Quelle `page_deletions`, Lesepfad [db/page-deletions.js](../db/page-deletions.js)). Eine gelöschte Seite kann in `pages` per Definition nicht auftauchen — ohne diesen Block bliebe sie im lokalen Spiegel und im Pagetree des Clients stehen. Vier Eigenschaften, auf die man sich verlassen darf: **eigene Zeitachse** (`deleted_at`, nicht im Seiten-Keyset-Cursor — gefiltert nach dem `since` *dieser* Anfrage, unabhängig von der Paginierung); **idempotent** (eine schon entfernte Seite erneut zu entfernen ist ein No-op, Doppel-Lieferung über mehrere Pull-Seiten also unschädlich); **leer beim Voll-Pull** ohne `since` (die Baseline kennt die Seite gar nicht); **nicht self-exkludierend** (anders als `/changes` — der eigene Spiegel eines Zweitgeräts muss auch die eigenen Löschungen nachziehen). `deleted_has_more: true` heisst gedeckelt (`limit`, max. 200) — dann bleibt `GET /content/books/:book_id/tree` die vollständige Reconciliation.
- **Push:** über den bestehenden `PUT /content/pages/:id`. Konflikt → `409 PAGE_CONFLICT` → Block-Level-Merge clientseitig (siehe [docs/notebook-editor.md](notebook-editor.md)).
- **Collab-Signal (nicht Sync):** `GET /content/books/:book_id/changes?since=<iso>&device_id=<uuid>` — self-exkludierend, **ohne** HTML, nur für Collab-Toasts. „Andere Partei" = anderer User **oder** ein anderes eigenes Gerät; nur der Echo des anfragenden Geräts (gleiche `device_id`) wird ausgefiltert. Jede Row trägt `is_self` (gleicher Account, anderes Gerät) + `device_label` (nur für **eigene** Geräte gejoint, kein Leak fremder Gerätenamen) — die UI formuliert Multi-Device-Edits als „auf ⟨Gerät⟩ geändert" statt als Fremd-Edit.
- **Presence-Heartbeat:** `POST/DELETE /content/pages/:page_id/presence` (Seiten-Edit-Marker) und `POST/DELETE /content/books/:book_id/device-ping` (leichter Buch-Heartbeat) + `GET /content/books/:book_id/presence` (aktive Sessions). Trägt die Multi-Device-Erkennung.

> **Das Collab-Signal ist ein Komfort-Kanal, keine Wahrheitsquelle.** Der 5s-Poll auf `/changes` läuft im Browser erst, wenn der **40s**-Buch-Device-Ping eine zweite Partei gemeldet hat (`_selfBookDeviceCount > 1` bzw. geteiltes Buch, [app-collab.js](../public/js/app/app-collab.js#L135)) — ein Push eines Zweitgeräts wird also bis zu einer Ping-Periode später sichtbar, und gar nicht, wenn das Gerät offline schrieb und beim Reconnect nur pusht, ohne das Buch zu pingen. Folge für den Server-Konsumenten: **jeder Pfad, dessen Resultat an einem Seiten-Snapshot hängt** (Lektorat-Findings mit Positionen, Chat-`vorschlaege.original`), muss den aktuellen `updated_at` **selbst** nachfragen statt der browserlokalen `currentPage.updated_at` zu glauben. Siehe harte Regel „Job-Ergebnisse mit `updatedAt`-Staleness-Check" in [CLAUDE.md](../CLAUDE.md).

## Release-Discovery (Download-Hinweis im Profil + Landing)

Das Profil (`/me`) und die Landing-Page zeigen Logged-in-Usern bzw. Besucher:innen Installationsweg + Version der nativen Apps und der Chrome-Erweiterung. Alle Routen sind dünne Proxies mit In-Memory-Cache; **die Versionsquelle folgt dem Auslieferungsweg** — Store-App aus dem Store, Direkt-Download aus dem GitHub-Release:

| Plattform | Route | Lib | Weg + Versionsquelle |
|-----------|-------|-----|----------------------|
| macOS | `GET /content/macclient/release.json` | [lib/macclient-release.js](../lib/macclient-release.js) | Mac App Store (kein Direkt-Download); Version aus der iTunes-Lookup-API über [lib/appstore-lookup.js](../lib/appstore-lookup.js) |
| Android | `GET /content/android/release.json` | [lib/androidclient-release.js](../lib/androidclient-release.js) | `.apk` (Sideload); Version aus dem GitHub-Release |
| Chrome | `GET /content/extension/release.json` | [lib/extension-release.js](../lib/extension-release.js) | Chrome Web Store, `.zip` als Zweitweg; Version aus dem GitHub-Release |

- **Warum die macOS-Version nicht am GitHub-Tag hängt:** ohne Download-Asset gibt es dort nichts, woraus sich eine Version ableiten liesse, und eine getaggte, aber noch in Review hängende Version wäre die falsche Vergleichsgrösse — installieren kann man nur die freigegebene. Der generische GitHub-Fetcher [lib/github-release.js](../lib/github-release.js) bedient darum nur noch Android + Erweiterung.
- Wo es einen Direkt-Download gibt, verlinkt die UI direkt auf die GitHub-CDN-URL (kein Download-Proxy). Da die Client-Repos öffentlich sind, ist die Asset-URL selbst öffentlich; der Download wird nur Eingeloggten **angezeigt** (Anzeige-Gating, kein Hard-Gating).
- ETag = sha256(Version) → 304. Bei **macOS und Chrome** geht zusätzlich die Store-URL in den Hash: sie steht als `storeUrl` **immer** im Body (auch bei `available:false`, denn der Store darf nicht an einem Ausfall der Versionsquelle hängen), und ohne sie im ETag bekäme ein Client mit altem Cache-Body weiterhin ein 304. SSoT der URLs: `MAC_APP_STORE_URL` in [lib/macclient-release.js](../lib/macclient-release.js) bzw. `CHROME_STORE_URL` in [lib/extension-release.js](../lib/extension-release.js) — die Landing liest beide direkt.
- **`MAC_APP_STORE_URL` ist storefront-neutral** (`https://apps.apple.com/app/id…?mt=12`, kein `/ch/`-Pfad): Apple leitet auf die Storefront des Besuchers um, ein festgenagelter Ländercode zeigt allen anderen den falschen Shop. Der Lookup fragt dagegen eine konkrete Storefront ab (die API braucht eine); die Version ist storefront-gleich.
- **GitHub-Rate-Limit:** ohne Token 60 Req/h. Ein optionaler PAT hebt das auf 5000/h (Admin-Settings → Erweitert → `macclient.github_token`, verschlüsselt in `app_settings`; `GITHUB_TOKEN` in `.env` nur als einmaliger Boot-Seed). Der Key-Name stammt aus der Zeit des DMG-Downloads und bleibt aus Kompatibilität; betroffen sind heute Android + Erweiterung, der App-Store-Lookup braucht kein Token. Siehe [README.md](../README.md).
- Profil-UI-Strings: `profile.macApp.*` / `profile.androidApp.*` / `profile.extensionApp.*` in [public/js/i18n/{de,en}.json](../public/js/i18n/). Landing-Strings: `landing.{mac,android,extension}{Title,Desc,LinkLabel}`.
- **Veraltet-Vergleich im Admin-Tab:** `/admin/devices` liefert `latestVersions: { macos, android, extension }`. Der Client bestimmt pro Gerät anhand der gemeldeten `client_version` (Plattform-Prefix `android/…` bzw. `chrome/…`) und des Freitext-`platform`-Felds, welcher Referenzstrang gilt; fuer Chrome zeichnet `_devicesIsChrome` zuständig. `devicesIsOutdated(d)` vergleicht dotted-numeric und blendet dieselbe „veraltet"-Badge ein wie bei den nativen Clients.

## Konto-Selbstlöschung (`DELETE /me/account`)

App-Store-Guideline 5.1.1(v): ein Konto, das sich in der App anlegen lässt, muss sich **in der App** löschen lassen — nicht bloss deaktivieren. Der macOS-Client ruft dafür:

```
DELETE /me/account
Authorization: Bearer swd_…
Content-Type: application/json

{ "confirm": "DELETE" }
```

- **`confirm` ist ein konstanter Protokollwert**, nicht lokalisiert und nicht der Kontoname. Die Absicherung gegen den Fehlklick sitzt im Client-UI; dieser Wert sichert nur gegen den versehentlichen Request.
- **Device-Token genügt** — anders als `POST /me/device-tokens` (dort `403 DEVICE_TOKEN_SELF_MINT_FORBIDDEN`) gibt es hier kein Gate auf die Auth-Art: der Client hat keine Session. Ein `capture`-Token kommt trotzdem nicht durch (`/me/*` ist nicht allowlistet → `DEVICE_SCOPE_FORBIDDEN`).
- **Nach dem `200` ist jedes Token des Kontos tot** → der nächste Request beantwortet der Guard mit `401 NOT_LOGGED_IN`. Der Client soll seinen lokalen Spiegel löschen und in den abgemeldeten Zustand wechseln.
- **Keine Karenzfrist:** die Antwort trägt **kein** `scheduled_purge_at`. Das Feld bleibt im Client-Vertrag optional (falls der Server das später einführt, zeigt der Client das Datum an), aktuell wird sofort gelöscht.

| `error_code` | HTTP | Wann |
|---|---|---|
| `CONFIRM_REQUIRED` | 400 | `confirm` fehlt oder ist nicht exakt `DELETE` |
| `ACCOUNT_DELETE_FORBIDDEN` | 403 | Konto darf sich nicht selbst löschen: `ADMIN_EMAIL` aus der ENV (wird beim Serverstart neu angelegt) oder letzter aktiver Admin der Instanz |
| `USER_NOT_FOUND` | 404 | keine `app_users`-Row zu dieser Anmeldung |
| `ACCOUNT_DELETE_FAILED` | 500 | Löschung abgebrochen; trägt `detail`. Ein zweiter Aufruf räumt den Rest ab (jeder Schritt ist idempotent) |

> **Ein 404 OHNE `error_code`** heisst „dieser Server kennt die Route nicht" (ältere Instanz). Der Client fällt dann auf den Browser zurück und öffnet `…/#profil` — dort steht in der Profil-Karte dieselbe Aktion. Jeder **fachliche** Fehler trägt dagegen immer einen `error_code`.

**Was gelöscht wird:** eigene Bücher (Kapitel, Seiten, Fassungen, Analysen, Share-Links) samt allem, was daran hängt — auch für Mitarbeitende. Bücher, an denen der User nur beteiligt ist, bleiben ihren Besitzern; es fällt nur seine `book_access`-Zeile. Betriebsdaten (Kosten, Job- und Fehlerspur) bleiben **anonymisiert**, die Audit-Spur der Löschung bleibt als Nachweis. Vollständige Spaltenliste mit Begründungen: [lib/account-delete.js](../lib/account-delete.js).

**Demo-Konto:** derselbe Aufruf setzt es **zurück** statt es zu löschen (Antwort zusätzlich `demo_reset: true`, Tokens bleiben gültig) — der Zugang ist geteilt und steht in den Reviewer-Notes. Ein Prüfer erlebt den vollständigen Ablauf, der nächste findet eine benutzbare Demo. Siehe [Demo-Instanz](#demo-instanz-ein-buch-zum-nicht-hineinschreiben).

## Abdeckung im Vergleich

| Aspekt | macOS (`focuseditor`) | Android (`mobile`) | Chrome (`browser-extension`) |
|--------|----------------------|--------------------|------------------------------|
| Architektur | WKWebView-Schale, Editor-Kern per OTA | native App + WebView-Schreibmodus, Editor-Kern per OTA | MV3-Service-Worker + Popup, kein Editor |
| Device-Token-Auth | ✅ `device` | ✅ `device` | ✅ `capture` (enge Allowlist) |
| Schreibt ins Manuskript | ✅ | ✅ | — (Recherche + Quellen, nie Buchtext) |
| Sync (`/sync`) + Presence | ✅ | ✅ | — (kein lokaler Spiegel) |
| Release-Discovery | ✅ Mac App Store | ✅ `.apk` | ✅ Chrome Web Store (+ `.zip` als Zweitweg) |
| OTA-Editor-Bundle | ✅ | ✅ (eigenes Boot-HTML) | — |
| OTA-i18n-Override | ✅ | — (native Strings) | — (eigene Strings) |
| Konto-Selbstlöschung | ✅ `DELETE /me/account` | — (Web-Profil) | — (`/me/*` nicht allowlistet) |
| Push-Notifications | — | — (kein FCM/APNS im Server) | — |

Das Fehlende auf Android-Seite (i18n-Override) ist **kein Gap, sondern Folge der Architektur**: die App verwaltet ihre Oberflächen-Strings nativ, der Editor-Kern bringt seine eigenen mit. Was beide nativen Clients gemeinsam tragen — Auth, Sync, Presence, Release-Discovery, Editor-Bundle — ist symmetrisch abgedeckt.

Die leere Spalte der Erweiterung ist ebenso wenig eine Lücke: sie ist **die Definition des Clients**. Wer nur erfasst, braucht keinen lokalen Spiegel (es gibt nichts zu mergen), kein Editor-Bundle (es wird nichts editiert) und keine Presence (niemand teilt eine Seite mit ihr). Käme eines davon dazu, wäre es ein zweiter Editor-Client und kein Erfassungswerkzeug mehr — und der enge Token-Scope, der genau das absichert, müsste fallen. **Release-Discovery hat sie dagegen sehr wohl** (eigene Versionsstränge, eigener Veraltet-Vergleich) — ab dem Punkt, wo die Erweiterung ein Release-Asset auf GitHub trägt, erscheint es im Profil, in der Landing und im Admin-Geräte-Tab.

**Push-Notifications** existieren auf keiner Plattform serverseitig (kein FCM/APNS). Falls künftig gewünscht, wäre das ein neuer Baustein (Token-Registry analog `device_tokens`, Notify-Trigger an den Sync-/Collab-Punkten).

## Dritter Client: Browser-Erweiterung (Chrome, `capture`-Scope)

`schreibwerkstatt-browser-extension` erfasst beim Surfen Webseiten ins Recherche-Board bzw. in die Quellen-Bibliothek. Sie ist **kein Editor-Client**: sie zieht kein Editor-Bundle, hat keinen Sync und keine Presence — sie schreibt nur nach vorne in zwei kuratierende Ablagen und **nie** in den Manuskripttext.

Serverseitig braucht sie nichts Eigenes außer dem Scope, einem Sammel-Endpunkt zum Schreiben und zwei Bestandsfragen zum Lesen:

- **Auth** wie die nativen Clients (`swd_…`), aber mit `kind: 'capture'` → Allowlist oben. Selbstidentifikation per `X-Client-Platform: chrome` und `X-Client-Version: chrome/<version>` (Prefix analog `android/…`), damit der Admin-Tab die Plattform erkennt und die gemeldete Version gegen das neueste Extension-Release vergleichen kann.
- **Kein CORS nötig:** die App hat keine CORS-Middleware und braucht keine, solange alle Requests im MV3-Service-Worker laufen — mit `host_permissions` auf den App-Host ist der Worker CORS-exempt. Aus einem Content-Script heraus scheitert derselbe Request.
- **`POST /capture`** ([routes/capture.js](../routes/capture.js)) — Fundstück und/oder Quelle in **einem** transaktionalen Aufruf. Body `{ book_id, mode: 'research'|'source'|'both', url, title, body, kind, tags, source, authors, container_title, year, doi, isbn, csl_type, accessed_at, note }`, Antwort `{ research_item, research_created, source, source_created, source_linked }`. Rolle `editor` auf dem Buch.
  - **Warum nicht die drei Einzelaufrufe:** ein Popup, das der User nach der Quittung zuklappt, hinterlässt bei drei Requests nach Abbruch eine Quelle, die in keinem Buch liegt. Alles in einer `db.transaction`.
  - **Idempotenz mit zwei verschiedenen Regeln, absichtlich:** eine **Quelle** darf pro Dokument nur einmal existieren (buchübergreifend, Bibliothek) → bekannte URL wird wiederverwendet und nur noch verlinkt. Ein **Fundstück** darf pro Dokument beliebig oft existieren (zwei Zitate aus derselben Seite sind zwei Funde) → deduped wird nur ein *wortgleicher* Fund (kind + Titel + Text + URL) aus einem 10-Minuten-Fenster, also der Doppelklick.
- **`GET /sources/by-url?url=&book_id=`** ([routes/sources.js](../routes/sources.js)) — „liegt das schon in meiner Bibliothek?" vor dem Erfassen. Nur der eigene Pool; `linked_to_book` sagt, ob im Zielbuch schon zugeordnet.
- **`GET /research?book_id=&q=&kind=&limit=`** ([routes/research.js](../routes/research.js)) — Bestandsblick aufs Recherche-Board: „habe ich zu dieser Seite schon etwas erfasst?" vor dem Erfassen, plus Suche im Warteschlangen-Fenster. Rein lesend, keine Nebenwirkung. Scope `content:read`, Rolle `editor` auf dem Buch (Buch-ACL greift für ein Token exakt wie für eine Session — das Token löst auf den echten User auf).
  - **Reduzierte Ausgabeform für Device-Token-Requests** (`toClientItem` in [lib/research-validate.js](../lib/research-validate.js)): `id, kind, title, source, created_at, updated_at, body_snippet, urls[{url,label}]`. Der volle `body` geht **nicht** mit — er trägt bis zu `BODY_MAX` (20 000) Zeichen Seitentext, den die Erweiterung selbst hochgeladen hat, und würde sich bei jeder Dublettenprüfung zurückschicken; `body_snippet` ist der auf 200 Zeichen normalisierte Anriss. `urls` bleibt drin, weil die Frage ohne sie nicht beantwortbar wäre. Board-Zubehör (`tags`, `links`, `doc_*`, `pinned`, `archived`) fällt weg. **Die SPA-Antwort ist unverändert** — die Verzweigung hängt allein an `session.user.via === 'device_token'`.
  - **`limit`**: Default 50 für Device-Token-Requests, Maximum 200; ein unbrauchbarer Wert (0, negativ, Text) fällt auf den Default zurück statt 400 zu werfen. Ohne Token-Kontext (SPA) gilt weiterhin **kein** Limit, sofern keines mitgeschickt wird.
  - **`q` deckelt vorher bei `FTS_PREFILTER_LIMIT` = 500**: die Suche läuft als FTS5-Vorfilter über den Index und holt höchstens 500 Treffer, die erst danach gefiltert, sortiert und auf `limit` gekürzt werden. Bei sehr breiten Queries in sehr grossen Büchern liegen Funde jenseits davon ausserhalb der Antwort — **der Client soll die Grenze spiegeln** und breite Queries als „unvollständig" kennzeichnen statt als „nicht vorhanden".
  - **`kind`** filtert über `LIST_FILTER_KINDS` (`note, link, quote, fact, image, document`); ein unbekannter Wert wird ignoriert, nicht abgewiesen.
  - Fehler: `400 INVALID_ID` (fehlendes/ungültiges `book_id`), `403 DEVICE_SCOPE_FORBIDDEN` (Scope fehlt — das Gate greift **vor** der Route, es wird nichts geladen), `403 NO_BOOK_ACCESS` (kein Zugriff aufs Buch), `403 INSUFFICIENT_ROLE` (nur `viewer`, `detail: { actual, required }`), `401 NOT_LOGGED_IN` (Token ungültig/widerrufen/abgelaufen).
- **URL-Vergleich** über [lib/url-normalize.js](../lib/url-normalize.js) (pure): Fragment weg, `www.` weg, `http`→`https`, Standard-Port weg, Tracking-Parameter (`utm_*`, `fbclid`, …) weg, Query sortiert, Trailing-Slash weg. Bewusst konservativ — `ref` bleibt stehen, weil manche Seiten darüber ausliefern, was sie zeigen. Verglichen wird in JS über den Pool des Users, **nicht** über eine abgeleitete `url_norm`-Spalte: die müsste jeder Schreibpfad mitpflegen und würde genau dort wegdriften; eine persönliche Bibliothek hat zwei- bis dreistellig viele Einträge (gleiche Begründung wie der Freitextfilter in `routes/sources.js`).
- **Metadaten-Ernte passiert im Client**, nicht hier: kein Endpunkt ruft fremde URLs ab (keine SSRF-Fläche), und die Erweiterung hat den DOM ohnehin — auch hinter Login und Paywall. Für kanonische Angaben reicht das vorhandene `GET /sources/lookup?doi=`.
- **Kein Job, kein `callAI`:** erfassen erschließt nichts, es legt ab.

### Fehlercodes: der verbindliche Vertrag

Jede Fehlerantwort ist JSON mit dem Feld `error_code` (Ausnahmen unten). **Diese Tabelle ist vollständig** für alles, was ein `capture`-Token treffen kann — ein Client-Autor soll die Codes hier lesen und nicht aus dem Quelltext ableiten oder erfinden müssen. Kommt ein Code hinzu, gehört er in dieselbe Tabelle.

**Gate und Auth** (laufen vor jeder Route, [server.js](../server.js) → [lib/device-scopes.js](../lib/device-scopes.js)):

| `error_code` | HTTP | Wann | Endpunkt |
|---|---|---|---|
| `NOT_LOGGED_IN` | 401 | `swd_`-Token fehlt, ist unbekannt, widerrufen oder abgelaufen; oder der User ist `suspended`/`deleted` | alle |
| `DEVICE_SCOPE_FORBIDDEN` | 403 | Methode+Pfad stehen in keiner Allowlist des Tokens. Greift **vor** der Route — es wird nichts geladen und nichts geschrieben | alle |
| `DEMO_TOKEN_FIXED` | 403 | Versuch, ein ENV-festgenageltes Demo-Token zu widerrufen/löschen | `POST /me/device-tokens/:id/revoke`, `DELETE /me/device-tokens/:id`. **Mit einem `capture`-Token nicht erreichbar** (`/me/*` ist nicht allowlistet → vorher `DEVICE_SCOPE_FORBIDDEN`); nur über die Browser-Session des Demo-Users |

**Buch-ACL** ([lib/acl.js](../lib/acl.js)) — greift auf jeder Route mit `book_id`, gleich ob Session oder Token:

| `error_code` | HTTP | Wann | Endpunkt |
|---|---|---|---|
| `INVALID_BOOK_ID` | 400 | `book_id` keine positive Ganzzahl | nur `:book_id`-URL-Routen (`aclParamGuard`). Auf den Capture-Endpunkten unerreichbar: die validieren vorher selbst und antworten `BOOKID_REQ` bzw. `INVALID_ID` |
| `NOT_LOGGED_IN` | 401 | keine Session/kein gültiges Token. **Der einzige 401 des Erfassungs-Pfads** — die book-scoped Router prüfen den Login nicht mehr selbst vor dem Guard | alle `book_id`-Routen |
| `NO_BOOK_ACCESS` | 403 | Buch existiert nicht **oder** der User hat gar keine `book_access`-Row darauf (beides ununterscheidbar — Absicht) | alle `book_id`-Routen |
| `INSUFFICIENT_ROLE` | 403 | Rolle zu niedrig. Trägt `detail: { actual, required }`, z.B. `{ actual: 'viewer', required: 'editor' }` — **die Meldung, die dem Nutzer die Ursache nennt** | alle `book_id`-Routen |

**Welcher 400-Code bei fehlendem `book_id`** — die Regel, damit ein Client-Autor nicht raten muss: `BOOKID_REQ`, wenn `book_id` im **Body** steht (`POST /research`, `POST /capture`), `INVALID_ID`, wenn es als **Query-Parameter** kommt (`GET /research`, `GET /sources`, …), und `INVALID_BOOK_ID`, wenn es Teil des **Pfads** ist (`aclParamGuard`). Historisch gewachsen und bewusst nicht vereinheitlicht: die Codes stehen in ausgelieferten Clients, und ein Umbenennen brächte nur Kosmetik. Ein Client, der alle drei auf dieselbe Meldung abbildet, liegt richtig.

**`POST /capture`** ([routes/capture.js](../routes/capture.js), Rolle `editor`):

| `error_code` | HTTP | Wann |
|---|---|---|
| `NOT_LOGGED_IN` | 401 | keine Session/kein gültiges Token |
| `BOOKID_REQ` | 400 | `book_id` fehlt oder ist keine positive Ganzzahl |
| `INVALID_VALUE` | 400 | Feldwert nicht in der Whitelist. Trägt `params: { field, allowed }` — `field: 'mode'` (`research\|source\|both`), `field: 'csl_type'`, `field: 'authors'\|'editors'` (`allowed: 'array'`) |
| `INVALID_URL` | 400 | `url` ist nicht normalisierbar bzw. kein `http(s)` |
| `EMPTY` | 400 | Fundstück ohne Titel **und** ohne Text **und** ohne URL (`mode` ≠ `source`) |
| `SOURCE_IDENTITY_REQ` | 400 | Quellen-Entwurf ohne Titel und ohne Person (`mode` ∈ `source\|both`) |
| `CITEKEY_TAKEN` | 409 | `UNIQUE(owner_email, citekey)` verletzt. Der Entwurf trägt bewusst keinen `citekey`, der Fall ist praktisch ein Wettlauf |

**Recherche-Board** ([routes/research.js](../routes/research.js), Rolle `editor`) — `GET /research`, `GET /research/tags`, `POST /research`, `POST /research/:id/{image,doc}`:

| `error_code` | HTTP | Wann | Endpunkt |
|---|---|---|---|
| `NOT_LOGGED_IN` | 401 | keine Session/kein gültiges Token. Kommt aus dem Buch-Guard ([lib/acl.js](../lib/acl.js)) — der Router hat keine eigene Login-Prüfung davor, und damit auch keinen zweiten Code für dieselbe Lage | alle |
| `BOOKID_REQ` | 400 | `book_id` fehlt/ungültig | `POST /research` |
| `INVALID_ID` | 400 | `book_id` (Query) bzw. `:id` (Pfad) fehlt/ungültig | `GET /research`, `GET /research/tags`, alle `/:id/*` |
| `EMPTY` | 400 | weder Titel noch Text noch `http(s)`-URL | `POST /research` |
| `INVALID_KIND` | 400 | `kind` nicht in `note, link, quote, fact, image` | `PATCH /research/:id` — **nicht allowlistet** (kein `PATCH` im Capture-Scope); hier nur genannt, weil `kind` sonst wie ein prüfender Wert aussieht: bei `POST` wird ein unbekannter `kind` **still** auf `note` gesetzt, nicht abgewiesen |
| `ITEM_NOT_FOUND` | 404 | Fundstück-Id existiert nicht | `/research/:id/{image,doc}` |
| `NO_IMAGE` | 400 | leerer Body oder kein `image/*`-Content-Type | `POST /research/:id/image` |
| `IMAGE_INVALID` | 400 | `sharp` kann das Bild nicht lesen/normalisieren | `POST /research/:id/image` |
| `NO_DOC` | 400 | leerer Body, kein `application/pdf`-Content-Type, oder 0 Bytes | `POST /research/:id/doc` |
| `DOC_TOO_LARGE` | 413 | PDF über 25 MB. **In der Praxis kommt der Client hier nicht an:** der Body-Parser hat dieselbe Schwelle und antwortet vorher mit 413 **ohne** `error_code` (siehe unten) | `POST /research/:id/doc` |
| `DOC_NOT_PDF` | 415 | Magic-Bytes sind nicht `%PDF-` | `POST /research/:id/doc` |
| `DOC_UNREADABLE` | 400 | Parser-Fehler (verschlüsselt, beschädigt) | `POST /research/:id/doc` |

**Quellen-Bibliothek** ([routes/sources.js](../routes/sources.js), [routes/sources-doc.js](../routes/sources-doc.js)):

| `error_code` | HTTP | Wann | Endpunkt |
|---|---|---|---|
| `NOT_LOGGED_IN` | 401 | keine Session/kein gültiges Token | `GET /sources/{pool,by-url}`, `POST /sources`, `POST /sources/:id/doc` |
| `INVALID_ID` | 400 | `book_id`/`exclude_book_id`/`:id` fehlt oder ist keine positive Ganzzahl | `GET /sources`, `GET /sources/{pool,stats}`, `GET /sources/by-url`, `POST /sources`, `POST /sources/:id/{link,doc}` |
| `INVALID_VALUE` | 400 | `csl_type` nicht in `CSL_TYPES`, oder `authors`/`editors` kein Array. Trägt `params: { field, allowed }` | `POST /sources` |
| `INVALID_URL` | 400 | `url` ist kein `http(s)` bzw. nicht normalisierbar | `POST /sources`, `GET /sources/by-url` |
| `SOURCE_IDENTITY_REQ` | 400 | weder Titel noch Person — ein Verzeichniseintrag, der nichts benennt | `POST /sources` |
| `URL_REQ` | 400 | `?url=` fehlt | `GET /sources/by-url` |
| `NOT_FOUND` | 404 | Quelle existiert nicht — bei `by-url`: **kein Treffer im eigenen Pool** (der Normalfall vor dem Erfassen, kein Fehler) | `GET /sources/by-url`, `POST /sources/:id/{link,doc}` |
| `NOT_SOURCE_OWNER` | 403 | Quelle gehört einem anderen Konto. Zuordnen und Anhängen sind Pool-Hoheit, nicht Buch-Rechte — ein Buch-Editor darf fremde Bibliothekseinträge nicht verteilen | `POST /sources/:id/{link,doc}` |
| `CITEKEY_TAKEN` | 409 | `UNIQUE(owner_email, citekey)` verletzt | `POST /sources` |
| `NO_DOC` | 400 | leerer Body / kein `application/pdf` / 0 Bytes | `POST /sources/:id/doc` |
| `DOC_TOO_LARGE` | 413 | PDF über 25 MB — dieselbe Einschränkung wie oben: der Body-Parser antwortet vorher mit 413 ohne `error_code` | `POST /sources/:id/doc` |
| `DOC_NOT_PDF` | 415 | Magic-Bytes sind nicht `%PDF-` | `POST /sources/:id/doc` |
| `DOC_UNREADABLE` | 400 | Parser-Fehler | `POST /sources/:id/doc` |
| `LOOKUP_PARAM_REQUIRED` | 400 | weder `doi=` noch `isbn=` | `GET /sources/lookup` |
| `LOOKUP_PARAM_AMBIGUOUS` | 400 | `doi=` **und** `isbn=` zugleich | `GET /sources/lookup` |
| `INVALID_DOI` | 400 | `doi` nicht normalisierbar | `GET /sources/lookup` |
| `INVALID_ISBN` | 400 | `isbn` nicht normalisierbar (Prüfziffer/Länge) | `GET /sources/lookup` |
| `LOOKUP_NOT_FOUND` | 404 | Register kennt die Kennung nicht | `GET /sources/lookup` |
| `LOOKUP_UNAVAILABLE` | 502 | Crossref/OpenLibrary nicht erreichbar | `GET /sources/lookup` |
| `LOOKUP_FAILED` | 502 | Fremd-Dienst antwortet, aber unbrauchbar | `GET /sources/lookup` |

**Zwei Antworten ohne `error_code`** — der Server hat keinen globalen Express-Fehler-Handler, der Body-Parser antwortet also mit Express' Default (HTML, kein JSON). Der Client darf beim Parsen der Fehlerantwort nicht davon ausgehen, JSON zu bekommen:

| HTTP | Wann |
|---|---|
| 413 | Body über dem Parser-Limit (PDF > 25 MB, Bild > 12 MB, JSON > 256 kB) — **vor** dem Handler, also ohne `DOC_TOO_LARGE` |
| 400 | JSON-Body syntaktisch kaputt |

### Grenzwerte, die der Client spiegeln soll

Textfelder werden **still gekürzt, nicht abgewiesen** (`cleanStr` in [lib/research-validate.js](../lib/research-validate.js)) — wer das nicht spiegelt, zeigt dem Nutzer einen Text, der so nie gespeichert wurde. Die Upload-Limits dagegen werfen.

| Grenze | Wert | SSoT |
|---|---|---|
| `TITLE_MAX` | 300 Zeichen | [lib/research-validate.js](../lib/research-validate.js) |
| `BODY_MAX` | 20 000 Zeichen | [lib/research-validate.js](../lib/research-validate.js) |
| `SOURCE_MAX` | 1 000 Zeichen | [lib/research-validate.js](../lib/research-validate.js) |
| `TAG_MAX` / `MAX_TAGS` | 60 Zeichen / 20 Tags | [lib/research-validate.js](../lib/research-validate.js) |
| `URL_MAX` / `MAX_URLS` | 2 000 Zeichen / 20 URLs | [lib/research-validate.js](../lib/research-validate.js) |
| `URL_LABEL_MAX` | 300 Zeichen | [lib/research-validate.js](../lib/research-validate.js) |
| `SNIPPET_MAX` | 200 Zeichen (`body_snippet` in der Client-Form) | [lib/research-validate.js](../lib/research-validate.js) |
| `CLIENT_LIST_LIMIT` / `LIST_LIMIT_MAX` | 50 (Default am Token) / 200 (Maximum) | [lib/research-validate.js](../lib/research-validate.js) |
| `FTS_PREFILTER_LIMIT` | 500 Treffer vor Filter/Sortierung | [lib/research-validate.js](../lib/research-validate.js) |
| Bild-Upload | 12 MB | [routes/research.js](../routes/research.js) (`rawImage`) |
| PDF-Upload | 25 MB | [lib/pdf-extract.js](../lib/pdf-extract.js) (`MAX_INPUT_BYTES`) |
| Gespeicherter PDF-Text | 200 000 Zeichen, danach `doc_truncated: true` | [lib/pdf-extract.js](../lib/pdf-extract.js) (`MAX_TEXT_CHARS`) |
| Dateiname eines Anhangs (`?name=`) | 200 Zeichen | [lib/pdf-attachment.js](../lib/pdf-attachment.js) (`DOCNAME_MAX`) |
| JSON-Body `POST /capture` | 256 kB | [routes/capture.js](../routes/capture.js) |

### Demo-Instanz: ein Buch zum Nicht-Hineinschreiben

Der Demo-Seed legt **zwei** Bücher an ([lib/demo-book.js](../lib/demo-book.js), aufgerufen aus [lib/demo-user.js](../lib/demo-user.js)#`seedDemoContent`):

| Buch | Besitzer | Rolle des Demo-Users | Wofür |
|---|---|---|---|
| „Beispiel: Die Verwandlung" | der Demo-User selbst | `owner` | der normale Erfassungs-Pfad |
| „Fremdes Buch" | ein erfundenes Konto auf `example.org` | `viewer` | der **verweigerte** Pfad |

**Why:** eine Store-Prüfung soll sehen, dass die Erweiterung ein fehlendes Recht *benennt* statt stumm zu scheitern. Mit nur einem eigenen Buch ist das nicht vorführbar. Auf dem zweiten Buch beantwortet der Server jeden Schreibversuch mit `403 INSUFFICIENT_ROLE` + `detail: { actual: 'viewer', required: 'editor' }`, während `GET /content/books` **beide** Bücher listet (mit `role` und `owner_email` pro Zeile) — Lesen geht, Schreiben nicht, und der Grund steht in der Antwort.

Die Besitzer-Adresse **muss** auf `example.org` lauten (RFC 2606, nie vergeben): `GET /content/books` gibt `owner_email` heraus, und der Prüfer sieht die Antwort — dort darf keine echte Adresse stehen, auch keine interne. Der Seed ist idempotent über die Besitz-Row, nicht über den Buchnamen: Serverstart und `demo-reset.timer` laufen beliebig oft, und den Namen darf der Prüfer ändern. Gegated durch [tests/unit/demo-foreign-book.test.js](../tests/unit/demo-foreign-book.test.js) und [tests/integration/demo-seed-acl.test.js](../tests/integration/demo-seed-acl.test.js).
