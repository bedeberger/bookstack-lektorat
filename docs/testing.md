# Tests

Vier Suiten, sequenziell via `npm test`. Erstmaliges Setup: `npx playwright install chromium`.

| Suite | Runner | Pfad | Befehl | Charakter |
|-------|--------|------|--------|-----------|
| Unit | `node --test` | [tests/unit/](../tests/unit/) | `npm run test:unit` | Pure, parallelisiert (concurrency 4), kein Browser |
| Integration | `node --test` | [tests/integration/](../tests/integration/) | `npm run test:integration` | Parallelisiert (concurrency 4), Mock-AI, Content-Store gegen Test-SQLite |
| E2E | Playwright | [tests/e2e/](../tests/e2e/) | `npm run test:e2e` | Chromium gegen `tests/server.js` mit Fixture-Harness |
| Smoke | Playwright | [tests/e2e-app/](../tests/e2e-app/) | `npm run test:smoke` | Chromium gegen die **echte** App (`node server.js`, `LOCAL_DEV_MODE`) |

## Wann welche Suite?

**Unit:**
- Pure Funktionen, Validatoren, Renderer, Schema-Builder, Prompt-Builder.
- Single-Module-Logik ohne IO und ohne DB.
- Beispiele: [ai.test.js](../tests/unit/ai.test.js) (JSON-Parse-Fallback), [escape-xss.test.mjs](../tests/unit/escape-xss.test.mjs), [validate.test.js](../tests/unit/validate.test.js), [palette-fuzzy.test.mjs](../tests/unit/palette-fuzzy.test.mjs).

**Integration:**
- Komplette Job-Pipelines gegen Mock-Provider.
- DB-Interaktion (Migrations, Reads, Writes) mit echtem SQLite-File (in temp-Dir).
- Cross-Job-Regressionen.
- Beispiele: [komplett.test.js](../tests/integration/komplett.test.js), [review.test.js](../tests/integration/review.test.js).

**E2E:**
- DOM-Logik des Editors (Fokus-Modus, Selection, Pointer-Schonfrist, Cleanup).
- Lektorat-Flow mit Mock-Server.
- PDF-Export-Profile-CRUD inkl. Cover-Upload.
- Paste-Artefakt-Stripping (`cleanContentArtefacts`).

**Smoke ([smoke.spec.js](../tests/e2e-app/smoke.spec.js)):**
- Brüche, die nur über dem **kompletten** Template-Baum auftauchen: kaputte `$app`-Verdrahtung, fehlende Methode/`t()`-Key in einem Template, falsch gemountete Sub-Komponente.
- Boot der echten SPA + Öffnen jeder Hauptkarte + aller drei Editoren ohne Browser-Fehler.
- Reine „rendert ohne Crash"-Absicherung — gezielte Verhaltens-Assertions gehören nicht in diese Datei.

**App-Verhaltens-Specs (übrige Dateien in [tests/e2e-app/](../tests/e2e-app/)):**
- Verhalten, dessen geprüfte Eigenschaft von der **echten Shell** abhängt und die ein Fixture-Harness deshalb nicht sehen kann: CSS-Höhenkette, Overlay-/Anker-Geometrie, echter Alpine-Baum, echtes Backend.
- **Entscheidungsregel:** Hängt die Assertion an vollständigem CSS oder am kompletten Template-/Store-/Backend-Zusammenspiel? → hierher. Ist sie reine DOM-/Modul-Logik? → E2E-Harness (schneller, isolierter).
- Leitfall [focus-editor-app.spec.js](../tests/e2e-app/focus-editor-app.spec.js): die Schreiblinien-Geometrie des Focus-Editors leitet sich aus `--focus-anchor`/`--focus-vh`/`--focus-box-h`/`--focus-box-top` gegen die gemessene Box ab. [focus-harness.html](../tests/fixtures/focus-harness.html) lädt bewusst nur Minimal-CSS — die 52 Harness-Tests können vollständig grün bleiben, während im echten Editor die Zeile abdriftet. Genau dieser Fall ist eingetreten.
- Weitere: [book-editor.spec.js](../tests/e2e-app/book-editor.spec.js), [motiv.spec.js](../tests/e2e-app/motiv.spec.js), [offline-outbox.spec.js](../tests/e2e-app/offline-outbox.spec.js), [radio-reactivity.spec.js](../tests/e2e-app/radio-reactivity.spec.js), [plot-dnd.spec.js](../tests/e2e-app/plot-dnd.spec.js).
- Boot-/Buchauswahl-Sequenz nicht kopieren: SSoT in [tests/e2e-app/_helpers/app.js](../tests/e2e-app/_helpers/app.js).
- **Pflicht bei neuem Geometrie-/Layout-Test: einmal mutationsprüfen.** Das geprüfte Verhalten absichtlich brechen (Funktion no-op, CSS-Property killen), Suite laufen lassen, rot sehen, zurückrollen. Ein Test, der nie rot war, ist keine Absicherung — die erste Fassung des Tipp-Recenter-Tests blieb mit komplett abgeschaltetem `runTypewriter` grün, weil sie nur `scrollTop != 0` prüfte (der native Caret-Scroll des Browsers erfüllt das auch).

## Unit-Test-Konventionen

Endung: `.test.js` (CJS) oder `.test.mjs` (ESM, fuer Frontend-Module die `import` nutzen).

```js
const test = require('node:test');
const assert = require('node:assert/strict');

test('parseJSON repairs unescaped quotes', () => {
  const out = parseJSON('{"foo": "He said "hi""}');
  assert.equal(out.foo, 'He said "hi"');
});
```

Frontend-Module (Alpine, ESM): `.mjs` + `import`. Beispiel: [hash-router.test.mjs](../tests/unit/hash-router.test.mjs) baut DOM-Stub via `globalThis.document = …`.

## Integration: Mock-AI

[tests/integration/_helpers/mock-ai.js](../tests/integration/_helpers/mock-ai.js) stubt `lib/ai.callAI` via `require.cache`. **Pflicht: vor allen Modulen laden, die `lib/ai` requiren** (also vor `routes/jobs/...`).

```js
const mockAi = require('./_helpers/mock-ai');
mockAi.register({
  match: ({ system }) => system.includes('SYSTEM_REVIEW'),
  reply: { gesamtnote: 7, beanstandungen: [] },
});

// Erst danach:
const reviewModule = require('../../routes/jobs/review');
```

Handler-API:
- `match: ({ prompt, system, schema }) => bool` — first-match wins.
- `reply: object | string | function | { __raw: {...} }` — Object → JSON, `__raw` reicht volle `callAI`-Response durch (fuer truncated etc).

## Integration: Test-DB

[tests/integration/_helpers/setup.js](../tests/integration/_helpers/setup.js) hebt eine frische SQLite-Test-DB hoch (Migrations laufen einmal pro Suite). Content-Store-Facade liest und schreibt direkt darauf.

## E2E

`tests/server.js` startet Mini-Express auf Port 8765 und serviert `tests/fixtures/*-harness.html`. Playwright lädt Harness, importiert das echte Modul (z.B. `editor/focus.js`) und bindet es an Test-Harness-Objekt — kein Storage-Backend, kein KI-Server.

`fullyParallel: false` (sequenziell), `retries: CI ? 2 : 0`, Timeout 60 s.

Harness-Fixtures müssen die **gleichen `<link rel=stylesheet>`-Tags in derselben Reihenfolge** wie [public/index.html](../public/index.html) haben, sonst weicht Cascade-Order ab und Layout-Tests sind unzuverlaessig. Neuer CSS-File → in beide Files.

### Console-Fehler-Guard

Specs importieren `test`/`expect` aus [tests/e2e/_helpers/fixtures.js](../tests/e2e/_helpers/fixtures.js) statt direkt aus `@playwright/test`. Eine Auto-Fixture (`consoleGuard`) hängt [tests/e2e/_helpers/console-guard.js](../tests/e2e/_helpers/console-guard.js) an die Page: gesammelt werden `pageerror`, `console.error` und Alpine-Warnungen (`Alpine Expression Error`/`Alpine Warn`). Nach dem Test (sofern er nicht ohnehin scheitert) wird `assertClean()` gerufen — jeder unbehandelte Fehler macht den Test rot.

- **Negativ-Test**, der einen Fehler absichtlich provoziert (z.B. erzwungener Save-Fail, fehlender Scroll-Container): `consoleGuard.skip()` am Test-Anfang.
- **Bekannte, erwartete Meldung** erlauben: `consoleGuard.ignore(/Regex/)`. Default-Allowlist deckt Netzwerk-Rauschen (fehlende Mock-Route, 401/403/404, ResizeObserver-Loop) ab.
- **Harness-Datenlücke** statt Bug: tritt der Fehler nur auf, weil der Harness dünnere Mock-Daten/Root mountet als Produktion (fehlende Methode, unvollständige Config), den **Harness** produktionsnah machen — nicht ignorieren. Beispiel: pdf-Mock-Profile liefert `defaultConfig()` aus [lib/pdf-export-defaults.js](../lib/pdf-export-defaults.js).

## Smoke (echte App)

[playwright.app.config.js](../playwright.app.config.js) bootet `node server.js` mit `LOCAL_DEV_MODE=true` (OAuth gebypasst → Dev-Admin-Session aus [server.js](../server.js); [lib/dev-seed.js](../lib/dev-seed.js) seedet ein Kafka-Buch) auf einer Wegwerf-DB (`DB_PATH=tests/.tmp/smoke.db`, vor jedem Lauf gelöscht → frischer Seed; Port 8766, eigenes `SESSION_SECRET`). KI-Keys sind nicht nötig — der Smoke triggert keine Jobs.

[tests/e2e-app/smoke.spec.js](../tests/e2e-app/smoke.spec.js) wählt das Seed-Buch via Hash-Deeplink, zieht die Toggle-Namen aus `EXCLUSIVE_CARDS` ([feature-registry.js](../public/js/cards/feature-registry.js), kein Drift) und öffnet jede Karte + alle drei Editoren, jeweils mit Console-Guard-Prüfung. **Warum:** Alpine wirft Expression-Fehler asynchron (`setTimeout(() => { throw })`) und loggt sie nur — Unit/Integration sehen davon nichts, Harnesses nur ihre eine Karte. Erst der komplette Template-Baum im echten Browser fängt sie. Neue Karte ⇒ automatisch im Smoke.

## Häufige Fallen

- **Playwright fehlt Chromium**: `npx playwright install chromium`.
- **Mock-AI nach echtem `lib/ai`-Require geladen**: stubt nicht. Mock-AI muss als allerstes oben in der Test-Datei geladen werden.
- **`node --test` ohne `--test-concurrency` ist NICHT sequenziell**: der Default ist `os.availableParallelism() - 1` — auf einem 24-Kern-Host also 23 gleichzeitige Test-Prozesse. Unit **und** Integration pinnen das Flag darum explizit auf `4`. Jedes Test-File bekommt seine eigene Wegwerf-DB (`bootstrap()`), es gibt also keinen DB-Lock zwischen Files; die Begrenzung schützt vor I/O-/CPU-Ueberbuchung auf dem CI-Runner. Bei Race-Conditions in einem File-Set: `node --test --test-concurrency=1 "tests/integration/*.test.js"`.
- **`waitForJob`-Timeout obwohl der Job korrekt laeuft**: das Budget in [_helpers/setup.js](../tests/integration/_helpers/setup.js) zaehlt Event-Loop-Zeit, nicht Wandzeit — Ticks > 200 ms gelten als Stall und werden abgezogen (siehe Kommentar dort). Meldet die Fehlermeldung viel Wandzeit + Stall, ist der Runner ueberbucht oder ein synchroner Cold-Require blockiert die Loop; Warm-up dann in `bootstrap()` (before-Hook) ziehen, nicht das Budget hochdrehen. Meldet sie kaum Stall, haengt der Job wirklich.
- **SHELL_CACHE nicht gebumpt**: E2E lädt Harness aus `public/` — falls du JS/CSS während eines Test-Runs änderst, hartes Reload nötig oder `SHELL_CACHE` bumpen ([public/sw.js](../public/sw.js)).
- **Tests anpassen statt Bug fixen**: bei UI-Änderungen am Editor/Fokus-Modus/Lektorat-Flow `npm test` laufen lassen. Schlägt etwas fehl, Ursache klären — nicht den Test entschärfen.

## Coverage-Schwerpunkte

Die folgenden Bereiche haben die kritischsten Tests; bei Aenderungen dort vor Commit:

- JSON-Fallback-Kette ([ai.test.js](../tests/unit/ai.test.js))
- Stale-Write-Schutz ([stale-write.test.mjs](../tests/unit/stale-write.test.mjs))
- Page-Stats-Normalisierung ([page-stats-normalization.test.mjs](../tests/unit/page-stats-normalization.test.mjs))
- Card-Exklusivitaet ([card-exclusivity.test.mjs](../tests/unit/card-exclusivity.test.mjs))
- Hash-Router ([hash-router.test.mjs](../tests/unit/hash-router.test.mjs))
- XSS-Escape-Invariante ([escape-xss.test.mjs](../tests/unit/escape-xss.test.mjs))
- Komplettanalyse-Pipeline ([komplett.test.js](../tests/integration/komplett.test.js), [kontinuitaet.test.js](../tests/integration/kontinuitaet.test.js)) + Pure-Helper ([figuren-merge.test.js](../tests/unit/figuren-merge.test.js), [komplett-remap.test.js](../tests/unit/komplett-remap.test.js), [figuren-beziehungen-merge.test.js](../tests/unit/figuren-beziehungen-merge.test.js), [figuren-backfill.test.js](../tests/unit/figuren-backfill.test.js)) — Feature-Doku [docs/komplett.md](komplett.md)
- PDF-Export ([pdf-export-defaults.test.js](../tests/unit/pdf-export-defaults.test.js), [pdf-render.test.mjs](../tests/unit/pdf-render.test.mjs), [pdf-export.spec.js](../tests/e2e/pdf-export.spec.js))
- Fokus-Editor ([focus-editor.spec.js](../tests/e2e/focus-editor.spec.js))
