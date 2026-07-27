# Native Clients (macOS + Android)

Neben der Web-SPA gibt es zwei native Offline-First-Clients, die in eigenen Repos leben und denselben Server konsumieren:

- **macOS** — [schreibwerkstatt-focuseditor](https://github.com/bedeberger/schreibwerkstatt-focuseditor): der Focus-Writer in einer WKWebView-Schale, die den Editor-Kern per OTA zieht (siehe [docs/focus-editor.md](focus-editor.md) → `setEditorHost()`/Bridge).
- **Android** — [schreibwerkstatt-mobile](https://github.com/bedeberger/schreibwerkstatt-mobile): native Mobile-App mit nativer Navigation/UI; der Schreibmodus selbst ist eine WebView, die denselben Editor-Kern per OTA zieht (eigenes Boot-HTML `assets/editor-host/host.html` + `editor-host.css`, Bundle-Load via `BundleManager`/`EditorViewModel`). Gleiche Auth + Sync.

Diese Datei ist der **Überblick über die client-seitige Server-Schicht** (Auth, OTA, Sync, Presence, Release-Discovery). Der Editor-Kern selbst und die Bridge in fremde Schalen sind in [docs/focus-editor.md](focus-editor.md) dokumentiert; das Sync-/Konflikt-Modell der Seiten in [docs/notebook-editor.md](notebook-editor.md) (Block-Level-Merge).

> **SSoT bleibt dieses Repo.** Editor-Code lebt unter `public/js`, UI-Strings unter `public/js/i18n` bzw. `assets/macclient-i18n`. Die Clients ziehen Code/Strings zur Laufzeit oder bündeln einen Stand mit — sie sind nie die Quelle.

## Authentifizierung: Device-Token (`swd_…`)

Native Clients haben keine OAuth-Browser-Session, sondern authentisieren per **Device-Bearer-Token**.

- **Format** `swd_<32 Hex-Bytes>` ([db/device-tokens.js](../db/device-tokens.js)). Eigener Prefix, damit der Device-Pfad fremde `sw_…`-Tokens (`api_tokens`/Metrics) früh abweist.
- **Speicherung:** nur der SHA-256-Hash liegt in `device_tokens`. Der Klartext wird **genau einmal** bei `POST /me/device-tokens` zurückgegeben — danach nicht mehr rekonstruierbar.
- **Auflösung** ([lib/device-auth.js](../lib/device-auth.js) `tryDeviceAuth`): Anders als der admin-scoped Metrics-Bearer löst ein Device-Token auf den **echten User + dessen echte Rolle** auf und respektiert das Status-Gate (`suspended`/`deleted` → abgewiesen). Greift im globalen Auth-Guard ([server.js](../server.js)) — liefert es ein User-Objekt, wird der Request wie eine normale Session behandelt; sonst fällt der Guard auf 401/Redirect zurück.
- **Pflege** (Profil `/me`, Routen in [routes/usersettings.js](../routes/usersettings.js)):
  - `GET /me/device-tokens` — eigene Tokens auflisten
  - `POST /me/device-tokens` — Token ausstellen (gibt `plain_token` einmalig zurück). Ein Request, der **selbst per Device-Token** authentisiert ist, darf kein neues Token minten → `403 DEVICE_TOKEN_SELF_MINT_FORBIDDEN` (kein Token-Rollover ohne Browser-Login).
  - `POST /me/device-tokens/:id/revoke` — Soft-Revoke (`revoked_at`)
  - `DELETE /me/device-tokens/:id` — endgültig löschen
- **Nutzungs-Tracking:** jeder authentifizierte Request ruft `touchTokenUsage` → `last_used_at`, `last_used_ip`, `use_count +1` und persistiert die per `X-Client-Version` gemeldete Version (`COALESCE` hält den letzten bekannten Wert).
- **Admin-Übersicht:** [routes/admin-devices.js](../routes/admin-devices.js) (`GET /admin/devices`) listet alle Tokens user-übergreifend (Admin-Tab „Geräte"), inkl. Version → erlaubt Versionsskew gegen das neueste Release zu erkennen.

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

- **Pull (Spiegel aktualisieren):** `GET /content/books/:book_id/sync?since=<iso>&since_id=<n>&limit=<n>` ([routes/content.js](../routes/content.js)) — liefert **alle** seit dem Cursor geänderten/neuen Seiten **inkl. eigener Edits**, mit vollem HTML. Keyset-Cursor `(updated_at, page_id)`, Antwort trägt `cursor` + `has_more`; der Client paged bis `has_more=false`. Ohne `since` = Voll-Pull (Baseline). Gelöschte Seiten reconciled der Client über `GET /content/books/:book_id/tree`.
- **Push:** über den bestehenden `PUT /content/pages/:id`. Konflikt → `409 PAGE_CONFLICT` → Block-Level-Merge clientseitig (siehe [docs/notebook-editor.md](notebook-editor.md)).
- **Collab-Signal (nicht Sync):** `GET /content/books/:book_id/changes?since=<iso>&device_id=<uuid>` — self-exkludierend, **ohne** HTML, nur für Collab-Toasts. „Andere Partei" = anderer User **oder** ein anderes eigenes Gerät; nur der Echo des anfragenden Geräts (gleiche `device_id`) wird ausgefiltert. Jede Row trägt `is_self` (gleicher Account, anderes Gerät) + `device_label` (nur für **eigene** Geräte gejoint, kein Leak fremder Gerätenamen) — die UI formuliert Multi-Device-Edits als „auf ⟨Gerät⟩ geändert" statt als Fremd-Edit.
- **Presence-Heartbeat:** `POST/DELETE /content/pages/:page_id/presence` (Seiten-Edit-Marker) und `POST/DELETE /content/books/:book_id/device-ping` (leichter Buch-Heartbeat) + `GET /content/books/:book_id/presence` (aktive Sessions). Trägt die Multi-Device-Erkennung.

## Release-Discovery (Download-Hinweis im Profil)

Das Profil (`/me`) zeigt eingeloggten Usern Version + Download-Link der nativen Apps. Beide Routen sind dünne Proxies auf die GitHub-Public-API über den generischen Fetcher [lib/github-release.js](../lib/github-release.js) (In-Memory-Cache):

| Plattform | Route | Lib | Asset |
|-----------|-------|-----|-------|
| macOS | `GET /content/macclient/release.json` | [lib/macclient-release.js](../lib/macclient-release.js) | `.dmg` |
| Android | `GET /content/android/release.json` | [lib/androidclient-release.js](../lib/androidclient-release.js) | `.apk` (Sideload) |

- Die UI verlinkt direkt auf die GitHub-CDN-URL (kein Download-Proxy). Da die Client-Repos öffentlich sind, ist die Asset-URL selbst öffentlich; der Download wird nur Eingeloggten **angezeigt** (Anzeige-Gating, kein Hard-Gating).
- ETag = sha256(Version) → 304.
- **GitHub-Rate-Limit:** ohne Token 60 Req/h. Ein optionaler PAT hebt das auf 5000/h (Admin-Settings → Erweitert → `macclient.github_token`, verschlüsselt in `app_settings`; `GITHUB_TOKEN` in `.env` nur als einmaliger Boot-Seed). Siehe [README.md](../README.md).
- Profil-UI-Strings: `profile.macApp.*` / `profile.androidApp.*` in [public/js/i18n/{de,en}.json](../public/js/i18n/).

## macOS vs. Android — Abdeckung

| Aspekt | macOS (`focuseditor`) | Android (`mobile`) |
|--------|----------------------|--------------------|
| Architektur | WKWebView-Schale, Editor-Kern per OTA | native App + WebView-Schreibmodus, Editor-Kern per OTA |
| Device-Token-Auth | ✅ | ✅ |
| Sync (`/sync`) + Presence | ✅ | ✅ |
| Release-Discovery | ✅ `.dmg` | ✅ `.apk` |
| OTA-Editor-Bundle | ✅ | ✅ (eigenes Boot-HTML) |
| OTA-i18n-Override | ✅ | — (native Strings) |
| Push-Notifications | — | — (kein FCM/APNS im Server) |

Das Fehlende auf Android-Seite (i18n-Override) ist **kein Gap, sondern Folge der Architektur**: die App verwaltet ihre Chrome-Strings nativ, der Editor-Kern bringt seine eigenen mit. Was beide gemeinsam tragen — Auth, Sync, Presence, Release-Discovery, Editor-Bundle — ist symmetrisch abgedeckt.

**Push-Notifications** existieren auf keiner Plattform serverseitig (kein FCM/APNS). Falls künftig gewünscht, wäre das ein neuer Baustein (Token-Registry analog `device_tokens`, Notify-Trigger an den Sync-/Collab-Punkten).
