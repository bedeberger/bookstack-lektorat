---
description: Neues Feature nach dem CLAUDE.md-Rezept anlegen (Job/Karte/Registry/i18n/Migration/Tests)
argument-hint: "[Feature-Beschreibung]"
allowed-tools: Read, Edit, Write, Grep, Glob, Bash(npm run test:unit), Bash(npm run test:smoke), Bash(npm run squash:regen), Bash(git status:*)
---

Du legst ein neues Feature an: **$ARGUMENTS**

Arbeite die relevanten Schritte der CLAUDE.md-Sektion „Neues Feature hinzufügen" ab. **Nicht blind alles** — zuerst den Scope klären, dann nur die zutreffenden Teile.

## 0. Scope klären (zuerst!)

Bestimme (bei Unklarheit **nachfragen**):
- **KI-Job nötig?** Alles Langläufer-/KI-hafte läuft als Job-Typ (Harte Regel „KI-Calls nur via Job-Queue"). → Teil A.
- **Eigene UI-Karte?** Neue Hauptansicht/Sub-Komponente. → Teil B.
- **Schema-Änderung?** → erst `/migration` ausführen (oder dessen Schritte), dann hier weiter.
- Betrifft es **einen der drei Editoren / drei Chats / drei Kommentar-Oberflächen**? Dann die jeweilige Ausprägung explizit benennen (Harte Regeln „…-Spezifikation Pflicht").

## Teil A — Backend (KI-Job)

1. Job-Datei in `routes/jobs/` (Muster: `routes/jobs/review.js`) mit `runXxxJob` + `router.post('/xxx', …)`.
2. Router in `routes/jobs.js` mounten.
3. Prompt-Builder ins passende Submodul unter `public/js/prompts/` + Re-Export in Facade `public/js/prompts.js`. Cache-Invalidierung läuft automatisch über den Content-Hash — neue cache-gatete Schemas in `_promptsContentHash` aufnehmen.
4. **Nach `callAI`: Pflichtfeld-Validierung** + `truncated`-Flag VOR `parseJSON` prüfen und werfen (Harte Regel „callAI gibt nur JSON zurück").
5. **Dedup:** `findActiveJobId(type, entityId, userEmail)` aus `routes/jobs/shared/` (nicht `runningJobs.get`).
6. **Logging-Context:** `setContext({ book: book_id })` nach `toIntId`-Validierung.
7. i18n-Keys für `statusText`/Labels als Keys (`job.phase.xxx`) in **beiden** Locales.
8. **Stats-Label:** neuen Job-Typ in `JOB_TYPE_LABELS` ([routes/jobs/shared/jobs.js](routes/jobs/shared/jobs.js)) auf einen `job.label.xxx`-Key mappen (in beiden Locales anlegen) — sonst erscheint er in den Job-Statistiken (Bucheinstellungen) nur mit roher ID. Ausnahme: Sub-Job eines Superjobs (z.B. komplett-analyse) → stattdessen in `STATS_EXCLUDED_TYPES` aufnehmen.

## Teil B — Frontend (neue Karte)

**Vor neuer UI: [DESIGN.md](DESIGN.md)-Pattern-Katalog prüfen** — wiederverwenden, nicht neu erfinden. Fehlt das Pattern: erst dort dokumentieren (Markup + CSS-Datei + Use-Case), dann bauen.

**Vor jeder State-Änderung: [docs/state-modell.md](docs/state-modell.md)** — verbindliche SSoT für die Ebenenwahl (Root vs. Sub-Karte vs. Store), Lifecycle und die Editor-Modi-Invarianten.

1. Fachmodul in `public/js/` → `export const xxxMethods = { … }`; Root-Zugriff via `window.__app.xxx` (JS) bzw. `$app.xxx` (Template). **Keine `get x()`-Getter** im gespreadeten Methods-Modul (Spread ruft sie sofort mit falschem `this`).
2. Sub-Komponente `public/js/cards/xxx-card.js` → `Alpine.data('xxxCard', () => ({ …state, init(), destroy(), ...xxxMethods }))`, Lifecycle über [`setupCardLifecycle`](public/js/cards/card-lifecycle.js) (globale Listener nur mit `{ signal: this._abortCtrl.signal }`). State **explizit** deklariert (Initial-Felder, kein lazy `this._x`).
3. `registerXxxCard()` exportieren und in [public/js/app/register-cards.js](public/js/app/register-cards.js) aufrufen (SSoT des Karten-Inventars — **nicht** in `app.js`).
4. Partial `public/partials/xxx.html`, `x-data="xxxCard"` am `<div class="card">`.
5. `showXxxCard`-Flag in `app-state.js` → `cardsState`.
6. **Pflicht: `EXCLUSIVE_CARDS`-Eintrag** in [public/js/cards/feature-registry.js](public/js/cards/feature-registry.js) — daraus wird der Root-Toggle **generiert** (`generatedToggles` + `_toggleCardGeneric` in [app-view/_shared.js](public/js/app/app-view/_shared.js)); Exklusivität, Lazy-Partial und Scroll-to kommen gratis mit. Minimal `{ key, flag, toggle, partial }`; je nach Bedarf `onReclick: 'refresh'`, `requiresBook`, `loadDeps`, `refreshName`, `auditEvent`, `extraRefreshOnOpen` (Feldliste steht im Kommentarblock über `EXCLUSIVE_CARDS`). **Keine handgeschriebene `toggleXxxCard()`** — nur bei echter Sonderlogik `bespoke: true` setzen und die Methode in [app-view/cards.js](public/js/app/app-view/cards.js) implementieren.
7. **`FEATURES`-Eintrag** in feature-registry.js (SSoT für Quick-Pills + Command-Palette + Usage). Bei `kind:'toggle'` zusätzlich Key in `ALLOWED_KEYS` von [routes/usage.js](routes/usage.js).
8. Hash-Router ([app-hash-router.js](public/js/app/app-hash-router.js)): Build-Branch in `_computeHash()`, Parse-Branch in `_applyHash()`, Flag ins `watchers`-Array in `_setupHashRouting()` (Store-basierte Quellen stattdessen als Getter in `storeWatched`).
9. **Bei user-sichtbarem Feature:** `landing.feat<N>Title`/`Desc` in beiden Locales + `<N>` in `HELP_FEATURES` ([help-card.js](public/js/cards/help-card.js)) — SSoT für Landing + In-App-Hilfe.

**UI-Bausteine sind Pflicht-Pattern (Harte Regeln):** Tabellen >3 Zeilen → `sortableTable`; Auswahlfelder → `combobox` (kein `<select>`); Zahlen → `numInput` (kein `<input type=number>`); klappbare Sektion → `collapsible`; Prosa-Felder → `data-spellcheck="spelling"`. `x-html` nur mit `escHtml()`-vorescaptem Content.

## Querschnitt (immer)

- **i18n:** jeder neue User-sichtbare String sofort in `de.json` UND `en.json` (`t('bereich.feld')`, `{platzhalter}`). Nie nur eine Locale.
- **Styles:** nur `public/css/` (kein Inline-`style`, kein `<style>`). Neues Token → Datei in `public/css/tokens/`.
- **Buchinhalt:** nur über die Content-Store-Facade (`require('lib/content-store')`), kein Roh-SQL auf `pages`/`chapters`/`books`.
- **Timestamps:** `${NOW_ISO_SQL}` serverseitig, `tzOpts()` fürs Frontend-Datums-Display.
- **File-Limits:** JS >600 / Partial >250 / CSS >600 LOC → in `<name>/`-Subfolder mit Facade splitten.

## Tests

- **Unit** (Facade/Pure-Logik), **Integration** (API, Job-Pipeline mit Mock-AI), **E2E/Smoke** falls UI. Muster in `tests/`.
- Abschluss: `npm run test:unit` grün.
- **Bei neuer Karte zusätzlich `npm run test:smoke`** — der Smoke-Test öffnet jede `EXCLUSIVE_CARDS`-Karte in der echten App und ist die einzige Schicht, die Alpine-Template-Fehler (verschluckte Expression-Errors, fehlende Registrierung) sichtbar macht.

## Abschluss

Knapp melden: welche Teile (A/B/Migration) umgesetzt, welche Dateien angelegt/geändert, welche Registry-/i18n-/Hilfe-Einträge ergänzt, Testergebnis. Offene Punkte (z.B. fehlende E2E) explizit nennen. **Nicht** committen.
