# LanguageTool-Integration

Self-hosted Rechtschreib-/Grammatik-/Stilprüfung über LanguageTool-Docker. Aktiv in allen drei Editoren ([docs/notebook-editor.md](notebook-editor.md), [docs/focus-editor.md](focus-editor.md), [docs/book-editor.md](book-editor.md)) und in Form-Feldern mit `data-spellcheck="spelling"`. Regelbasiert — **kein KI-Call**, daher als synchroner Proxy ausserhalb der Job-Queue erlaubt (Ausnahme von der „KI-Calls nur via Job-Queue"-Regel).

Browser-Spellcheck wird automatisch deaktiviert (`:spellcheck="!$app.languagetoolEnabled"`), wenn LT aktiv ist.

## Datenfluss

```
contenteditable ─ MutationObserver/input ─ debounce 1500ms ─┐
                                                            ▼
                                                  buildOffsetTable(root)
                                                            │
                                  text + positions[]        │
                                                            ▼
                                  POST /languagetool/check { text, language, bookId, pageId }
                                                            │
        ┌─────────────────── routes/languagetool.js ────────┴───────────────┐
        │  page_languagetool_cache HIT? ─ ja ─► matches[] zurück            │
        │  nein → chunkText(50KB) ─► Pool=4 fetch ${url}/v2/check          │
        │         ─► adjustMatches(offset) ─► dict.filterMatches ─► cache  │
        └──────────────────────────────────────────────────────────────────┘
                                                            │
                                                            ▼
                            rangeFromOffset(table, m.offset, m.length)
                                                            │
                                  ┌─ Range pro Match ───────┴───────┐
                                  ▼                                 ▼
                       CSS.highlights.add(range)              squiggles.set(id, …)
                       (native wavy underline)                (Click-Hit-Test)
```

## Backend

### Settings & Routes

| Key | Default | Wo |
|---|---|---|
| `languagetool.enabled` | `false` | [lib/app-settings.js#DEFAULTS](../lib/app-settings.js) |
| `languagetool.url` | `''` | dito (z.B. `http://localhost:8010`) |
| `languagetool.picky` | `false` | dito |

Admin-UI: [public/partials/admin-settings.html](../public/partials/admin-settings.html) Tab `languagetool`. Test-Endpoint [routes/admin-settings.js#POST /admin/settings/test-languagetool](../routes/admin-settings.js) pingt `${url}/v2/languages`.

`/config` exposed nur Existenz-Flag, niemals URL: [routes/proxies.js#languagetool](../routes/proxies.js). Frontend liest in [app-state.js#languagetoolEnabled](../public/js/app/app-state.js) + [app.js](../public/js/app.js) via `cfg.languagetool?.enabled`.

### Proxy [routes/languagetool.js](../routes/languagetool.js)

`POST /languagetool/check` `{ text, language?, bookId?, pageId? }`:

- **Disabled-Fall:** `!enabled || !url` → `404 { error: 'languagetool_disabled' }`. Frontend behandelt als „Feature aus", kein Retry.
- **Locale-SSoT:** wenn `bookId` mitgesendet → `getBookLocale(bookId)` aus [db/schema.js](../db/schema.js) gewinnt. `body.language` nur Fallback (Aufrufe ohne Buchscope).
- **Body-Cap:** `TEXT_MAX = 500_000` Zeichen, JSON-Body 600 KB. Übergross → `413 { error: 'text_too_large' }`.
- **Cache-Lookup:** Wenn `pageId` gesetzt, `ltCache.getCached({ pageId, contentHash, lang, picky })` — Hit liefert `{ matches, cached: true }`. Vor der Antwort läuft `dict.filterMatches` erneut über das gecachte Array (idempotent — Cached sind bereits gefilterte Matches, ein zweiter Lauf entfernt nur, was seit dem Cache-Write ins Dict gewandert ist; deckt den Edge-Case ab, dass `_purgeCacheForWord` die Seite verfehlt, weil `body_html` beim Add noch den ungespeicherten Stand hatte).
- **Chunking:** `chunkText(text, CHUNK_MAX=50_000)` aus [lib/languagetool-chunk.js](../lib/languagetool-chunk.js). Splittet primär an Paragraph (`\n{2,}`), Fallback Satz (`[.!?\n]+`), Worst-Case Hard-Split bei Wortgrenze.
- **Pool:** `PARALLEL = 4` Worker konsumieren Chunks; `adjustMatches(c.offset, …)` schiebt Match-Offsets auf absolute Position.
- **Filter:** `dict.getCheckSet(userEmail, bookId, language)` lädt User-Wörterbuch; `dict.filterMatches(all, dictSet)` entfernt User-Wörter.
- **Cache-Write:** gefilterte Matches landen via `ltCache.setCached(…)` in `page_languagetool_cache`.
- **Timeout:** `UPSTREAM_TIMEOUT_MS = 10_000`, AbortController bricht alle Worker. Upstream-Fehler → `502 { error: 'languagetool_upstream', upstream_status }`. Timeout → `408 { error: 'languagetool_timeout' }`.
- **Logging-Context:** `setContext({ book: bookId })` nach `toIntId`-Validierung.
- **Auth-Vertrag:** `/languagetool/` steht in `API_PREFIXES` ([server.js](../server.js)) → abgelaufene Session bzw. ungültiges Device-Token (`swd_…`) liefert `401 { error_code: 'NOT_LOGGED_IN' }` statt Login-HTML-Redirect. Nötig, damit der Android-Client den Auth-Fehler erkennt (Token verwerfen → Pairing) statt nur ein generisches Fehler-Badge zu zeigen.

### Dictionary [routes/dictionary.js](../routes/dictionary.js) + [db/user-dictionary.js](../db/user-dictionary.js)

`GET/POST/DELETE /dictionary` mit `{ word, bookId?, lang? }`.

- **Scope:** `book_id = 0` → User-global, `> 0` → nur dieses Buch. `lang = '*'` → alle Sprachen, sonst LT-Locale-Tag (`de-CH`, `en-US`, …). `'auto'` ist **kein** gültiger Wert (Migration 142 normalisiert auf `'*'`).
- **Lookup im Proxy:** `getCheckSet(userEmail, bookId, lang)` matched `(book_id = 0 OR book_id = ?) AND (lang = '*' OR lang = ?)`. Case-insensitive via lower-cased Set.
- **Auth-Vertrag:** `/dictionary` steht (ohne Trailing-Slash — der Router bedient die Wurzel) in `API_PREFIXES` ([server.js](../server.js)) → `401 JSON` statt Redirect, gleiche Begründung wie beim Proxy.
- **Cache-Invalidierung beim Add/Remove:** word-scoped Purge — nur Pages, deren `body_html LIKE %word% COLLATE NOCASE` enthält, verlieren ihren `page_languagetool_cache`-Eintrag. Bei `bookId=0` über alle Bücher des Users (via `book_access`), sonst nur das gewählte Buch.
- **Word-Cap:** 80 Zeichen.

### DB-Schema (Migration 141–143)

```
page_languagetool_cache
  PK (page_id, content_hash, lang, picky)
  FK page_id → pages(page_id) ON DELETE CASCADE
  matches_json TEXT
  → Mehrere Einträge pro Page möglich (Sprachwechsel, Picky-Toggle).
  → content_hash = sha1 über LT-Eingabetext (`ltCache.hashText`).

user_dictionary
  PK (user_email, book_id, word, lang)
  FK user_email → app_users(email) ON DELETE CASCADE
  → book_id=0 = global, lang='*' = sprachübergreifend.
```

Migration 143 leert den Cache einmalig (`lang='auto'`-Bug hatte unfilterte Caches geschrieben).

## Frontend

### Dispatcher [public/js/cards/editor-spellcheck/dispatch.js](../public/js/cards/editor-spellcheck/dispatch.js)

Eine Instanz pro App, gestartet in [app.js#setupSpellcheckDispatch](../public/js/app.js). Beobachtet `editMode`, `focusActive`, `showBookEditorCard`, `languagetoolEnabled`, `selectedBookId` und hält **genau einen** Controller auf dem aktiven contenteditable. Prioritätskette: Focus > Notebook > Bucheditor.

| Editor | Selector | Scroll-Container |
|---|---|---|
| Notebook | `.page-content-view--editing` | gleich (overflow-y:auto + max-height:70vh) |
| Focus | `.focus-editor__content` | gleich (Scroll-Events bubblen nicht) |
| Bucheditor | `.book-editor-page-body[contenteditable="true"]` | window |

Bucheditor-Block-Wechsel via dedizierter MutationObserver auf `.card--bookeditor` mit `attributeFilter: ['contenteditable']` — bei jedem Block-Activate wird detach+attach getriggert.

Form-Felder (`input/textarea[data-spellcheck="spelling"]`) laufen parallel: focusin-getrieben, eine Controller-Instanz pro Feld (WeakMap-Cache), Cleanup via MutationObserver auf DOM-Removal. Kein Single-Active-Constraint.

### Controller [public/js/cards/editor-spellcheck/controller.js](../public/js/cards/editor-spellcheck/controller.js)

`createSpellcheckController({ root, scrollContainer, getHtml, onApplyReplacement, editorKind, getBookLocale, getBookId, getPageId, isEnabled, i18n })` → `{ attach, detach, refresh }`.

**Squiggles ohne Overlay-DOM:** Native CSS Custom Highlight API (`CSS.highlights` + `Highlight`). Pro Kategorie ein globaler Highlight-Bucket (`lt-typo`, `lt-grammar`, `lt-style`), DOM-Ranges werden direkt hinzugefügt. Browser zeichnet wavy-Underline am Text-Lauf, scrollt nativ mit. Kein JS-Reposition bei Scroll, keine Span-Inseln im contenteditable.

Fallback bei fehlendem API-Support: `_updateBadge('disabled')`, sonst läuft die App ohne LT-Markierungen weiter.

**Kategorie-Mapping** (`_categoryKey`):
- `rule.id` enthält `SPELL` oder `category.id === 'TYPOS'` → `lt-typo` (rot).
- `category.id ∈ {STYLE, REDUNDANCY, TYPOGRAPHY}` → `lt-style` (gelb).
- Sonst → `lt-grammar` (blau).

**Staleness-Schutz:**
- `seq`-Counter pro Request; Late-Response mit `myReq !== seq` wird verworfen.
- `lastHtmlSnapshot = getHtml()` vor Fetch; nach Response Vergleich mit aktuellem `getHtml()` — Mismatch verwirft.
- `AbortController` bricht ältere Requests bei neuem `_runCheck`.

**Click-Hit-Test:** Kein DOM-Element pro Match — `mousedown` auf root → `caretPositionFromPoint`/`caretRangeFromPoint` liefert Caret-Position; `_findMatchAtCaret` iteriert `squiggles`-Map und vergleicht via `Range.compareBoundaryPoints(START_TO_START)` und `START_TO_END`. Treffer öffnet Popover.

**Popover-Mounting** (Host-Wahl + Geometrie in [position.js](../public/js/cards/editor-spellcheck/position.js), pure DOM-Mathematik ohne Controller-State — `resolvePopoverHost(scrollEl)` + `positionPopover(el, anchorRect, host)`):
- Interner Scroll-Container (Notebook/Focus): Popover als Kind des Scroll-Containers, `position: absolute` in Scroll-Content-Koordinaten. Popover ist `contenteditable="false"` (nicht-editbare Insel), MutationObserver filtert popover-eigene Mutationen (sonst trigger das Anhängen einen Re-Check, der Squiggles vor dem User-Klick verwirft).
- Window-Scroll (Bucheditor): Popover an `document.body`, position absolute in Document-Koordinaten.
- Vertical/Horizontal Clamp + Flip gegen Viewport bzw. Host-Sichtbereich.

**MutationObserver-Filter `_isPopoverOnlyMutation`** — Mutationen, deren betroffene Knoten ausschliesslich im Popover-Subtree liegen, triggern keinen Re-Check.

**Drei Schliesswege** — Outside-`mousedown` (einmaliger document-Listener in Capture), **Escape** und der **Close-Button** im Header (`.lt-popover__close`, Glyph `×` + `aria-label`/`data-tip` aus `spellcheck.popover.close`); dazu die Aktionen Vorschlag-Anwenden / Ignorieren / Zum-Wörterbuch. Escape hängt als document-**Capture**-Listener (per `AbortController` beim Schliessen abgemeldet) und ruft `stopPropagation()`: der Focus-Editor hört Escape an `window` in der Bubble-Phase ([editor/focus/card.js](../public/js/editor/focus/card.js)), würde also gleichzeitig den Fokus-Modus verlassen. Erstes Escape schliesst nur den Popover, zweites wirkt wieder normal. Bewusst nicht über ein `app`-Flag (wie Synonym-/Figur-Overlay) — der Controller ist host-agnostisch.

**Waisen-Knoten-Schutz `_purgeStrayUi()`** — bei Notebook/Focus hängt der Popover IM contenteditable. Jede Operation, die den Root-Inhalt aus HTML neu aufbaut oder Blöcke teilt (Enter-Split, Undo, `content.innerHTML = …`, Laden von HTML mit mitgespeichertem UI-Markup), kann eine Kopie erzeugen, die die `popover`-Closure nicht kennt — ein Knoten ohne jeden Handler, den `_closePopover` nie abträgt: unschliessbar bis zum Reload. Darum entfernen `_openPopover`, `attach()` und `detach()` **jedes** `.lt-popover`/`.lt-badge` im Root, nicht nur die eigene Referenz. Das echte Badge ist Sibling von `root` und damit nicht betroffen.

**Apply-Replacement** läuft über editor-spezifischen Callback (`onApplyReplacement(range, text)`), zentral in [dispatch.js#_onApply](../public/js/cards/editor-spellcheck/dispatch.js): `range.deleteContents()` + `insertNode(textNode)` + Selection hinter Insertion + `input`-Event-Dispatch (Editor-Save-Pipeline triggert).

**Ignore (Session-only):** `ignored: Set<matchId>`. `matchId = ${offset}:${length}:${rule.id}`. Kein DB-Persist.

**Add-to-Dictionary:** Popover-Button erscheint nur bei Spelling-Matches. POST `/dictionary` mit `{ word, bookId, lang }` (lang `'auto'` wird zu `'*'` mappt). Bei Erfolg: Squiggle weg + `_scheduleCheck` für Re-Filter.

**Badge** (`.lt-badge`): floating oben-rechts vom Editor (`offsetTop+6`, `offsetLeft+offsetWidth-8`), States `loading|matches|clean|extension|error|disabled|idle` mit Lucide-Icons + Tooltip via `data-tip`.

### Mapping [public/js/cards/editor-spellcheck/mapping.js](../public/js/cards/editor-spellcheck/mapping.js)

Pure Funktionen, testbar ohne Browser (läuft in linkedom — `SHOW_ELEMENT_AND_TEXT = 1 | 4` als rohe Bitmask, kein `NodeFilter.*`-Constructor):

- `buildOffsetTable(root)` → `{ text, positions: [{node, start, end}] }`. TreeWalker, Text-Node-Werte verketten. Block-Tags (P/DIV/LI/UL/OL/BLOCKQUOTE/H1-6/PRE/SECTION/…) fügen `\n\n` ein (LT-Paragraph-Break), `<br>` fügt `\n` ein. **Whitespace innerhalb von Text-Nodes bleibt unangetastet** — LT handhabt Tokenisierung selbst.
- `locateOffset(table, offset, length)` → `{ startNode, startOffset, endNode, endOffset }` oder `null`. Match darf über mehrere Text-Nodes spannen.
- `rangeFromOffset(table, offset, length)` → DOM-`Range` oder `null` (falls Offsets ausserhalb der Tabelle, z.B. nach DOM-Mutation).

UTF-16 Code Units = JS `String.length` = LT-Offset-Semantik. Keine Konvertierung nötig.

### Form-Controller [public/js/cards/editor-spellcheck/form-controller.js](../public/js/cards/editor-spellcheck/form-controller.js)

Eine Instanz pro `<input>`/`<textarea>` mit `data-spellcheck="spelling"`. Unterschiede zum contenteditable-Controller:

- Quelle: `el.value`, kein DOM-Walk.
- **Kein Inline-Squiggle** — Form-Felder rendern Text intern, kein `CSS.highlights`-Support. Stattdessen `.lt-badge.lt-badge--form` absolut **im** Feld (top/bottom-right); Klick öffnet Popover mit Liste aller Tippfehler.
- **Wrap-Pattern:** Beim ersten attach wickelt `_insertBadge` das Feld in `<span class="lt-field-wrap">` (Textarea: zusätzlich `lt-field-wrap--textarea`) und hängt den Badge als zweites Kind ein. Beim detach unwrap (Feld zurück an Grandparent, Wrap entfernt). Alpine-Bindings bleiben intakt — das Element-Objekt wird nur verschoben, nicht ersetzt. Idempotent: wenn Feld bei Re-Attach schon gewrappt ist, wird nicht doppelt gewrappt.
- **Position:** `position: absolute` auf `.lt-badge--form`, default top:50%/right:6px (vertikal mittig). Textarea-Variante: `bottom: 8px/right: 6px` (Badge sitzt am unteren Rand, blockiert nicht die erste Zeile).
- **Padding-Reservation:** CSS-Regel `.lt-field-wrap > input[data-spellcheck], .lt-field-wrap > textarea[data-spellcheck] { padding-inline-end: 32px !important }` reserviert rechts Platz. `!important` ist Pflicht, weil Karten wie `.card-title--input:focus` per `padding`-Shorthand alle 4 Seiten neu setzen — sonst überschreibt der Focus-Shorthand das `padding-inline-end` zurück und Text klebt am Badge.
- **Flex/Grid-Parents:** `.lt-field-wrap { flex: 1; min-width: 0; display: block; }`. In flex-Containern (Buchorganizer-`.organizer-page`, `.ideen-input-row`, `.kapitel-new-page`, `.book-settings-kontext-wrap`) übernimmt der Wrap die `flex:1`-Rolle des Feldes; in grid-Cells (`.card-form-row`) und block-Stacks (`.card-header-titlebar`) bleibt es block-level. Kein JS-Reposition bei Scroll/Resize nötig — alles CSS.
- **Spelling-only Filter** — Grammar/Style/Punctuation wegfiltern. Titel/Notizen sind kurz, Grammar/Style bringen keinen Mehrwert und nerven.
- Apply via `el.setRangeText(text, off, off+len, 'end')` + `input`/`change`-Event (Alpine `x-model` bekommt mit, Undo-Stack bleibt intakt).
- Snapshot-Drift-Check vor Apply: wenn `el.value.substr(off, len).trim() !== lastValueSnapshot`-Word, abbrechen + Re-Check.
- Debounce: `500ms` für `<input>`, `1000ms` für `<textarea>`.

### Locale-Mapping [dispatch.js#_locale](../public/js/cards/editor-spellcheck/dispatch.js)

Aus `books[i].language` (`de`/`en`) + `books[i].region` (`CH`/`DE`/`US`/`GB`) → `${l}-${r}`. Beide leer → `'auto'`. Server überschreibt mit `getBookLocale(bookId)`, wenn `bookId` mitgeliefert.

### Extension-Konflikt

LT-Browser-Extension injiziert eigene Squiggles → doppelte Underline. Detection in [controller.js#_detectExtension](../public/js/cards/editor-spellcheck/controller.js): MutationObserver auf `document.body` prüft Selektoren `lt-div`, `lt-highlighter`, `[class*="lt-toolbar"]`, `[class*="languagetool"]`. Hit → Highlights leeren, Badge `'extension'`, Event `languagetool:extension-detected` dispatched.

Banner-Card [public/js/cards/editor-spellcheck-card.js](../public/js/cards/editor-spellcheck-card.js) (`editorSpellcheckCard`, Markup in [public/index.html](../public/index.html)) hört auf das Event und zeigt Hinweis. Per-Session dismissable via `sessionStorage['lt:extension-banner-dismissed']`. Marker verschwinden → `languagetool:extension-cleared`, Banner aus.

## CSS [public/css/editor/spellcheck.css](../public/css/editor/spellcheck.css)

Shared für alle Editoren + Form-Felder. Pflicht-Token: `--z-overlay-spellcheck` (Squiggle-Layer), `--z-popover` (Popover-Layer).

`::highlight(lt-typo|lt-grammar|lt-style)` setzen `text-decoration: underline wavy …` mit `text-decoration-skip-ink: none` (sonst Lücken unter `g`/`p`/`y`). Farben via `--color-err-border`/`--color-running`/`--color-style-border`.

Pro-Editor-Tweaks via `[data-editor="focus"]`/`[data-editor="book"]` auf Popover/Badge.

`.lt-popover__close` sitzt via `margin-left: auto` rechts im Header, 24×24 Trefferfläche (Mobile 32×32).

## Tests

| Layer | Datei | Scope |
|---|---|---|
| Unit | [tests/unit/languagetool-mapping.test.mjs](../tests/unit/languagetool-mapping.test.mjs) | `buildOffsetTable`/`rangeFromOffset`: Block-Boundaries, Cross-Node-Matches, Whitespace |
| Unit | [tests/unit/languagetool-chunk.test.mjs](../tests/unit/languagetool-chunk.test.mjs) | Paragraph-/Satz-/Hard-Split, `adjustMatches`-Offset-Shift |
| Unit | [tests/unit/user-dictionary-filter.test.mjs](../tests/unit/user-dictionary-filter.test.mjs) | `dict.filterMatches`: Case-Insensitive-Match, Set-Lookup |
| Integration | [tests/integration/languagetool-proxy.test.js](../tests/integration/languagetool-proxy.test.js) | Mock-LT: Forward, Disabled-404, Upstream-502, Timeout-408, Cache-Hit |
| Unit | [tests/unit/editor-shared-save.test.mjs](../tests/unit/editor-shared-save.test.mjs) | `stripLektoratMarks`: `.lt-popover`/`.lt-badge` raus (inkl. Fast-Path-Regression), `normalizeForCompare` bleibt stabil |
| Unit | [tests/unit/html-clean.test.js](../tests/unit/html-clean.test.js) | `stripEditorUiArtefacts` + `cleanPageHtml`: UI-Markup eines alten Clients landet nicht im Content |
| E2E | [tests/e2e/spellcheck-notebook.spec.js](../tests/e2e/spellcheck-notebook.spec.js) | Tippen → Debounce → Squiggle → Popover → Replace → Save; Escape, Close-Button (Maus + Tab/Enter), kein UI-Markup im Save |
| E2E | [tests/e2e/spellcheck-focus.spec.js](../tests/e2e/spellcheck-focus.spec.js) | Focus-Enter/Exit-Lifecycle, internes Scrollen (Container-Scroll, nicht Window); Escape-Priorität gegen den Editor-Handler, Waisen-Popover-Purge bei Open + Mount |
| E2E | [tests/e2e/spellcheck-book.spec.js](../tests/e2e/spellcheck-book.spec.js) | Block-Activate-Switch: Squiggle wandert mit aktivem Block; Escape/Close am `<body>`-gemounteten Popover |

## Pflicht-Invarianten

- **`data-spellcheck="spelling"` auf jedem Prosa-Feld.** Buch-/Seiten-/Kapiteltitel, Notizen, Beschreibungen, Einleitungen, Ideen, Freitext-Kontext — alles bekommt das Attribut (siehe CLAUDE.md „LanguageTool auf Prosatextfeldern Pflicht"). Ausnahmen: Suchfelder, `numInput`, Admin-Settings, Find/Replace, Readonly-Felder. Wer ein neues Prosa-Feld baut, ohne das Attribut zu setzen, bricht die Regel.
- **Wrap-Pattern via Form-Controller, nicht im Markup.** Der `.lt-field-wrap`-Span entsteht beim attach automatisch, das Partial enthält nur das Attribut. Hand-Markup-Wrap ist Anti-Pattern und führt zu Drift mit dem Controller-Unwrap.
- **Locale-SSoT Server.** Wenn der Proxy eine `bookId` bekommt, gewinnt `getBookLocale(bookId)` über alles, was das Frontend mitschickt. Frontend liefert Locale nur als Fallback (Form-Felder ohne Buchscope).
- **`'auto'` ist kein Dictionary-Lang.** Wert `'auto'` wird in `/dictionary` zu `'*'` gemappt, sonst matched `getCheckSet` nie (Migration 142 hat tote Daten gelöscht). Frontend-Add muss das mappen.
- **Cache-Key enthält `picky` + `lang`.** Sprachwechsel oder Picky-Toggle dürfen alten Cache **nicht** wiederverwenden. PRIMARY KEY `(page_id, content_hash, lang, picky)`.
- **Dictionary-Add purgt nur betroffene Pages.** `body_html LIKE %word%` — kein Pauschal-Wipe. Beim Edit von `user-dictionary.js`-Lookup-Queries: Granularität pro `book_id`/`lang` muss zur Cache-Purge-Query passen.
- **Dict-Filter läuft auch auf Cache-Hits.** Der `body_html`-basierte Purge ist eine Best-Effort-Optimierung; der eigentliche Wahrheits-Anker ist der Re-Filter im Proxy beim Cache-Lookup. Wer den Cache-Hit-Pfad anfasst, darf das `dict.filterMatches` davor nicht entfernen — sonst überleben Dict-Wörter, deren `body_html` beim Add ungespeichert war.
- **Popover ist `contenteditable="false"`.** MutationObserver filtert Popover-Mutationen (`_isPopoverOnlyMutation`), sonst verschwinden Squiggles vor dem Klick. Gilt für jede neue UI, die der Controller in den Editor-Subtree einhängt.
- **Nie nur die eigene Popover-Referenz entfernen.** Wer den Popover-Lifecycle anfasst, räumt beim Öffnen/Mount/Unmount **alle** `.lt-popover`/`.lt-badge` im Root weg (`_purgeStrayUi`). Eine Kopie, die kein Controller mehr kennt, ist per Definition unschliessbar — sie hat keinen einzigen Handler.
- **Mindestens ein Schliessweg ohne Maus und einer ohne Tastatur.** Escape **und** sichtbarer Close-Button sind Pflicht, nicht nur Outside-Click: der Popover sitzt im contenteditable, auf Touch ist „daneben tippen" ein Klick in den Text.
- **Escape-Handler in Capture + `stopPropagation`.** Nicht in der Bubble-Phase registrieren — der Focus-Editor-Handler an `window` würde sonst zusätzlich feuern und den Fokus-Modus verlassen. Listener beim Schliessen abmelden (`AbortController`), sonst frisst ein toter Handler das nächste Escape.
- **UI-Markup nie persistieren.** `.lt-popover`/`.lt-badge` fliegen client-seitig in `stripLektoratMarks` ([editor/shared/html-clean.js](../public/js/editor/shared/html-clean.js)) und server-seitig in `stripEditorUiArtefacts` (Teil von `cleanPageHtml`, [lib/html-clean.js](../lib/html-clean.js)) raus. Der Client-Filter hat einen Fast-Path — ein neuer UI-Klassenname muss **auch in die `hasLtUi`-Trigger-Bedingung**, sonst greift der Early-Return und der Filter läuft nie.
- **Quellennachweise sind geschützte Bereiche, kein Text-Schnitt.** Quellen-Chips (`span.cite[data-src]`, [sources/cite-html.js](../public/js/sources/cite-html.js)) bleiben IM LT-Eingabe-Stream; `buildOffsetTable` liefert stattdessen `protectedRanges`, und `filterProtectedMatches` verwirft jeden Treffer, der ein Intervall **berührt** (nicht erst, wenn er ganz darin liegt — ein angewandter Vorschlag würde sonst Chip-Zeichen ersetzen und den Zeiger auf die Quelle zerstören). **Nicht** herausschneiden: die beiden Nachbar-Textknoten ergäben ein doppeltes Leerzeichen, und darauf hat LanguageTool eine eigene Regel — die Quellenangabe erzeugte den Fehler, den sie vermeiden soll. Gefiltert wird **genau einmal** (im Controller vor `_renderMatches`), damit Squiggles und Badge-Zahl dieselbe Menge sehen. `CITE_SKIP_SEL` in [mapping.js](../public/js/cards/editor-spellcheck/mapping.js) ist eine bewusste Kopie von `CITE_SEL` (das Modul hält sich frei von App-Bundle-Kanten), gegated durch [tests/unit/cite-guard-drift.test.mjs](../tests/unit/cite-guard-drift.test.mjs).
- **`seq` + `htmlSnapshot` doppelte Staleness.** Both checks sind Pflicht: Race „User tippt während Fetch" + Race „mehrere Checks parallel". AbortController allein reicht nicht (Response kann durch sein, bevor abort durchläuft).
- **Apply geht über `input`-Event, nicht direkt an Editor-State.** Save-Pipeline muss triggern (Notebook-Autosave/Focus-Save/Bucheditor-`_markDirty`). Direkter State-Write umgeht Stale-Write-Schutz und Draft-Storage.
- **CSS-Highlights sind global.** `CSS.highlights.set(name, …)` ist Document-scoped. Bei mehreren parallelen Editoren (theoretisch — Dispatcher verbietet's) würden Buckets kollidieren. Single-Active-Constraint ist die Garantie.
- **LT-URL niemals ans Frontend.** Nur Existenz-Flag in `/config`. Bei neuen Routes/Endpoints, die LT-Config zurückgeben, das wahren.
- **Body-Cap 500 KB im Proxy.** Frontend muss > Limit splitten oder hart abbrechen — der Proxy antwortet sonst `413` ohne Retry.
