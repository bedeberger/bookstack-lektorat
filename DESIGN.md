# DESIGN.md — UI-Pattern-Katalog

**Verbindlich.** Vor dem Hinzufügen neuer UI-Komponenten zuerst hier nachschlagen, ob das Pattern bereits existiert. Wiederverwenden statt neu erfinden. Neue Patterns werden in dieser Datei dokumentiert; ohne Eintrag hier kein neues UI-Element-Vokabular.

Token-Referenz (Farben, Radien, Spacing, Schriftgrössen): [public/css/tokens.css](public/css/tokens.css).

## Token-Pflicht (keine ad-hoc-Werte)

Wiederkehrende Werte gehen über Tokens. Ad-hoc-Werte (`box-shadow: 0 4px 12px ...`, `padding: 7px 10px`, `opacity: 0.5`) nur, wenn keine Token-Variante passt.

| Bereich | Tokens | Verwendung |
|---------|--------|------------|
| **Schatten** | `--shadow-sm` (Card-Lift), `--shadow-md` (Popover/Dropdown), `--shadow-lg` (Modal), `--shadow-soft-sm` (sehr dezent), `--shadow-inset-top` (Job-Queue-Footer) | Standard-Erhebungen. Dark-Theme erbt automatisch dunklere Schatten. |
| **Padding** | `--pad-btn-compact` (7px 10px), `--pad-badge` (4px 8px), `--pad-detail` (0.5rem 0.75rem) | Compact-Buttons, Badges/Tags, Detail-Boxen / Drawer-Inhalt. |
| **Transition** | `--transition-fast` (0.1s ease), `--transition-base` (0.12s ease), `--transition-slow` (0.15s ease) | Standard-Cadence. Längere Animationen (0.18s+, 0.3s) bleiben ad-hoc. **NIE als `--x: var(--x)` definieren** — zirkuläre Custom-Property ist invalid → ganze `transition`/`animation`-Property kippt auf Default `0s` → Chevron-Rotationen, `cardFadeIn`, Hover-Tints sind tot, Erweiterungen „wackeln" weil Section snappt ohne Chevron-Maskierung. Definitionen müssen Literalwerte tragen, [public/css/tokens.css](public/css/tokens.css). |
| **Opacity** | `--opacity-disabled` (0.6), `--opacity-muted` (0.5), `--opacity-hint` (0.4), `--opacity-faint` (0.35), `--opacity-strong` (0.75) | Semantische Stufen. `:disabled` immer `--opacity-disabled`. |
| **Font-Size klein** | `--font-size-xs` (11px), `--font-size-sm` (13px), `--font-size-base` (14px) | `font-size: 11px` → `var(--font-size-xs)`. |

---

## Klappbarer Section-Toggle (Accordion)

**Use:** Sekundärer Inhalt in einer Karte, der per Default zu sein soll (Legenden, Zusammenfassungen, Details).

**Markup:**
```html
<div class="collapsible-wrap">
  <button type="button"
          class="collapsible-toggle"
          @click="xxxOpen = !xxxOpen"
          :aria-expanded="xxxOpen">
    <span class="history-chevron" :class="{ open: xxxOpen }">›</span>
    <span x-text="$app.t('bereich.toggle')"></span>
  </button>
  <div x-show="xxxOpen" x-cloak class="collapsible-section">…Inhalt…</div>
</div>
```

`.collapsible-wrap` (block-Container, Spacing pro Section) + `.collapsible-section` (border-left, padding, Inhaltsabstand) leben beide in [public/css/entity-list.css](public/css/entity-list.css).

**Regeln:**
- Chevron `›` rotiert via `.history-chevron.open` (90°). CSS in [public/css/tree-history.css](public/css/tree-history.css).
- Button-Stil `.collapsible-toggle` (uppercase, kleinere Schrift, `inline-flex`). CSS in [public/css/entity-list.css](public/css/entity-list.css).
- State (`xxxOpen`) lebt in der Sub-Komponente, nicht im Root.
- Kein `<details>`/`<summary>` — nicht stylebar genug, andere optische Sprache.
- **Toggle-Button NICHT lokal auf `display: flex; width: 100%` umstellen.** Hat in der Vergangenheit horizontalen Wackel-Shift beim Öffnen verursacht (PDF-Export-Karte). Block-Stapelung kommt vom `.collapsible-wrap`-Container, nicht vom Button selbst.
- **„Wackelt beim Öffnen"-Symptom** = Chevron-Rotation läuft nicht ODER Toggle ist auf full-width gestreckt. Beides geprüft? Section snappt instant auf, ohne dass die `transform: rotate(90deg)`-Transition den Snap visuell trägt → der Sprung wirkt grob. Ursache 1 (vertikal): `--transition-slow` ist invalid (z.B. zirkuläre Definition) → in DevTools auf `0.15s ease` prüfen, Token reparieren reicht für die ganze Karte. Ursache 2 (horizontal nach rechts): Toggle ist `display: flex; width: 100%` und ändert beim Klick die Layout-Box → Default `inline-flex` zurücksetzen, in `.collapsible-wrap` einwickeln.

**Beispiele:** Kontinuitäts-Zusammenfassung [public/partials/kontinuitaet.html:38](public/partials/kontinuitaet.html#L38), Figuren-Legende [public/partials/figuren.html:37](public/partials/figuren.html#L37).

---

## Karten (`.card`)

**Use:** Hauptansicht im Buchscope (Figuren, Orte, Szenen, …).

**Regeln:**
- Wurzel `<div class="card" x-data="xxxCard" x-show="$app.showXxxCard" x-cloak>`.
- Animation: nur CSS (`cardFadeIn` aus [public/css/card-form.css](public/css/card-form.css)). **Kein `x-transition`** auf `.card` — doppelt gemoppelt, wabbelt.
- Header: `.card-header` mit `.card-header--subline` für Buchtitel + Timestamp.
- Status-Hinweis: `.card-status` (Loading/Empty), `.card-status--error` für Fehler.
- Empty-State: `<div x-show="…" class="card-status" x-text="$app.t('common.noDataYet')"></div>`.

**Akzentfarbe pro Karte:** `.card--xxx { --card-accent: var(--card-accent-xxx); }` (siehe `tokens.css`).

---

## Combobox (Auswahlfeld)

**Use:** Jedes Auswahlfeld. Ersetzt natives `<select>` (siehe CLAUDE.md harte Regel).

Pattern + Pflicht-Markup: siehe [CLAUDE.md](CLAUDE.md) Abschnitt „Combobox statt `<select>`". Nicht hier duplizieren — Single Source of Truth bleibt CLAUDE.md.

### Reaktivität bei Datenquelle aus Karten-Scope (häufiger „Liste leer"-Bug)

`<div x-data="combobox(...)">` ist eine **nested x-data** innerhalb der Karten-x-data. Methods am Karten-Scope, die in `x-effect` der Combobox aufgerufen werden und **reaktive Karten-Daten via `this.xxx` lesen**, werden nicht zuverlässig getrackt — Combobox bleibt leer, auch nachdem die Daten nachgeladen wurden. Bestätigt durch Werkstattkommentar bei [`ideenMovePickerOptions` in public/js/app.js](public/js/app.js) („x-effect der Combobox-Sub-x-data nur `$app`/Magics, nicht Karten-Methoden sieht").

**Symptom-Beispiel (PDF-Export, vor Fix):**
- Schriftart-Combobox leer (`fontFamilyOptions()` liest `this.fontList`)
- Schriftstärke-Combobox leer (`fontWeightOptions(role)` liest `this.activeProfile`/`this.fontList`)
- Clone-From-Combobox leer (`cloneOptions()` liest `this.profiles`)
- Statische Listen (Seitengröße, Spalten, Kapitelumbruch) funktionieren — keine reaktive Datenquelle.

**Etablierter Workaround in der Codebase:** [`figurenKapitelListe`](public/js/cards/figuren-card.js#L116), [`ereignisseKapitelListe`](public/js/cards/ereignisse-card.js), [`kontinuitaetKapitelListe`](public/js/kontinuitaet.js) — Datenzugriff explizit über `window.__app.xxx`, nie über `this.xxx`.

**Fix-Optionen für neuen Combobox mit reaktiver Karten-Datenquelle:**

1. **Inline-Expression in `x-effect`** (minimal-invasiv) — keine Method-Indirektion, Alpine trackt die Reads direkt im Effect-Body:
   ```html
   x-effect="options = fontList.map(f => ({ value: f.family, label: f.family }))"
   ```
   `fontList` resolved über merged-Scope an die Karte; reaktiver Read im Effect-Body wird getrackt.

2. **State an Root verschieben** — Daten + Option-Builder in einen State-Slice/Method-Spread am Root, Karte liest via `$app.xxx` / `window.__app.xxx`. Konsistent zum bestehenden Pattern (figuren, orte, ereignisse), aber invasiver.

3. **Method auf Karte, Datenzugriff via `window.__app`** — funktioniert nur, wenn die Daten am Root liegen. Nicht anwendbar, wenn der State karten-lokal sein muss.

**Default-Empfehlung:** Variante 1 für karten-lokalen State, Variante 2 wenn die Daten ohnehin global geteilt werden.

**Anti-Pattern (vermeiden):**
```html
<!-- Combobox ist nested x-data; this.xxx aus Card-Method wird nicht zuverlässig reaktiv -->
<div x-data="combobox(...)" x-effect="options = myCardOptions()"></div>
```
mit `myCardOptions() { return this.cardData.map(...); }` am Karten-Scope.

**Status PDF-Export:** Alle 12 Comboboxes in [public/partials/pdf-export.html](public/partials/pdf-export.html) verwenden Variante 1 (Inline-Expression im `x-effect`). Karten-lokaler State (`fontList`, `profiles`, `activeProfile`) wird direkt im Effect-Body gelesen; die früher vorhandenen Option-Builder-Methods sind ersatzlos entfernt.

---

## Tabs / Modus-Toggle

**Use:** Tab-Reihen mit Panels (PDF-Export) **und** Modus-Toggles mit 2-3 Optionen (Fehler-Heatmap: offen / angewendet / alle). Ein Pattern, beide Use-Cases.

**Pattern: `.tabs` / `.tabs-btn` / `.tabs-btn--active`** ([public/css/tabs.css](public/css/tabs.css)). Polished segmented: dezenter Tint statt Vollfarben-Active, 2px Akzentband am Unterkante, weiche Übergänge. Eckig.

**Markup:**
```html
<div class="tabs">
  <button class="tabs-btn" :class="{ 'tabs-btn--active': mode === 'a' }">A</button>
  <button class="tabs-btn" :class="{ 'tabs-btn--active': mode === 'b' }">B</button>
</div>
```

**Count-Badge** (optional, z.B. für Filter-Tabs): `.tabs-btn-count` als zweites Span-Kind im Button. Aktiver Tab tönt das Badge primary-getintet, disabled-Tabs dimmen es.
```html
<button class="tabs-btn" :disabled="count === 0">
  <span x-text="label"></span>
  <span class="tabs-btn-count" x-text="count"></span>
</button>
```

**Disabled-Tabs:** native `:disabled` (oder `aria-disabled="true"`) → ausgegraut, kein Hover, `cursor: not-allowed`. Pflicht-Pattern für Filter-Tabs mit leerem Bucket (kein Click ins Nichts). Beispiele: [public/partials/kontinuitaet.html](public/partials/kontinuitaet.html), [public/partials/szenen.html](public/partials/szenen.html).

**Modifier `.tabs--scrollable`** für viele Tabs in schmaler Karte (horizontaler Scroll, Mobile). Beispiel: PDF-Export-Tabs ([public/partials/pdf-export.html](public/partials/pdf-export.html)).

**Altes Pattern `.figur-modus-btn`** ([public/css/figuren.css:61](public/css/figuren.css#L61)) bleibt nur in [public/partials/figuren.html](public/partials/figuren.html) erhalten (Graph/Familie/Soziogramm). **Nicht für neue Karten verwenden** — `.tabs` ist SSoT. Wer figuren.html anfasst: bei Gelegenheit auf `.tabs` migrieren und `figuren.css`-Block entfernen.

---

## Badges & Tags

**Eckig** (`border-radius: var(--radius-sm)` oder `0`), nie pill-förmig oder rund.

**Generische Badges** [public/css/buttons-badges.css](public/css/buttons-badges.css):
- `.badge-ok` — grün, positive Info
- `.badge-warn` — amber, Warnung
- `.badge-err` — rot, Fehler
- `.btn-count` — Counter-Badge in Buttons

**Severity-Tags** [public/css/entity-list.css:143](public/css/entity-list.css#L143):
- `.severity-tag--kritisch` / `--stark` / `--mittel` / `--schwach` / `--niedrig`
- Verwendet für Lektorats-/Kontinuitäts-Schweregrade.

**Hue-getriebener Badge** (`.palette-badge` in [public/css/utilities.css](public/css/utilities.css)):
- Basis-Pattern für alle farb-codierten Badges (Sozialschicht, Präsenz, Figurentyp).
- Konsumenten setzen lokal `--badge-hue: var(--palette-xxx);` — Hintergrund und Text werden via `color-mix()` aus Hue + Surface/Text abgeleitet (Theme-aware).
- Beispiel: `<span class="palette-badge" style="--badge-hue: var(--palette-green)">Mittelschicht</span>` oder eigene Modifier-Klassen wie `.figur-schicht-mittelschicht { --badge-hue: var(--palette-green); }`.

---

## Buttons

**Hierarchie:**
- `<button class="primary">` — Haupt-CTA pro Karte (max. einer)
- `<button class="success">` — Bestätigungsaktion
- `<button>` (default) — sekundär, transparent
- `:disabled` — Opacity 0.4, cursor not-allowed

**Counter in Button:** `<span class="btn-count">N</span>` rechts vom Label.

---

## Form-Patterns (Settings- und Export-Karten)

**Use:** Karten mit Eingabefeldern in Label-Wert-Anordnung (book-settings, user-settings, finetune-export, …). Eine **gemeinsame** Geometrie über alle Karten — kein paralleles Klassen-Vokabular pro Karte.

### Grid (Label links, Wert rechts)

`.book-settings-form` / `.book-settings-row` / `.book-settings-label` (CSS in [public/css/kontinuitaet.css](public/css/kontinuitaet.css), 170 px-Label-Spalte). Auch ausserhalb von „Buch-Einstellungen" wiederverwenden — Klassenname stammt vom ersten Konsumenten, ist aber generisch gemeint. Modifier `.book-settings-row--top` für oben-ausgerichtete Rows mit Textareas.

```html
<div class="book-settings-form">
  <div class="book-settings-row">
    <label class="book-settings-label" x-text="…"></label>
    <div class="form-stack">…</div>
  </div>
</div>
```

### Wertspalten-Bausteine (CSS in [public/css/card-form.css](public/css/card-form.css))

| Klasse | Verwendung |
|--------|------------|
| `.form-stack` | flex-column gap 10 — vertikale Liste (mehrere Checks oder Sub-Gruppen) |
| `.form-inline` | flex-row gap 20 wrap — Inline-Felder nebeneinander (z.B. Min/Max) |
| `.form-inline-field` | Wrapper aus Label + Input (`<label><span/><input/></label>`) |
| `.form-num` | numerischer Input, 90 px breit, kompakt — paart mit `.form-inline-field` |
| `.form-check` | Grid 18 px-Checkbox + Title-Desc-Stack |
| `.form-check-title` | bold Titel der Check-Option |
| `.form-check-desc` | mittlerer Erklaerungstext (12 px, muted) |
| `.form-lead` | Intro-Paragraph unter `.card-header`, oberhalb der Form |
| `.form-section` | Wrapper unter dem Form-Output (Trennstrich + 14 px Abstand) |
| `.form-stats` | flex-wrap gap 8 — Reihe aus `.tok-badge`-Stats |
| `.form-size-hint` | sekundärer Inline-Hinweis im Button (z.B. Dateigröße) |

### Section-Trenner innerhalb des Forms

`.book-settings-section-divider` (CSS in [public/css/kontinuitaet.css](public/css/kontinuitaet.css)) — `<p>`-Tag mit Border-Top + erklärendem Text, trennt logische Form-Sektionen (Beispiel: AI-Augmentierung in finetune-export).

### Hint / Error / Saved unterhalb der Form

`.book-settings-hint` (12 px, muted, italic), `.book-settings-error` (rot), `.book-settings-saved` (success).

### Mobile (≤ 600 px)

Grid kollabiert auf 1 Spalte (in [public/css/confirm-dialog.css](public/css/confirm-dialog.css) — Hist. Grund). `.form-inline` reflowed auf 50/50 (`flex 1 1 calc(50% - 16px)`); `.form-num` wird flex-fluid.

### Regel: Keine parallele Reinvention

Wer eine neue Settings-/Export-Karte baut, nutzt diese Klassen direkt (siehe [public/partials/user-settings.html](public/partials/user-settings.html), [public/partials/finetune-export.html](public/partials/finetune-export.html)). Kein eigenes `.xxx-form` / `.xxx-row` / `.xxx-check` mehr. Verstößt gegen die Style-Konsistenz-Regel oben.

---

## Progress-Bar

**Markup:**
```html
<div class="progress-bar-wrap">
  <div class="progress-bar" :style="{ '--progress': xProgress + '%' }"></div>
</div>
```

**Regel (CLAUDE.md):** Breite kommt aus CSS-Custom-Prop `--progress`. Niemals `:style="'width:' + … + '%'"`.

---

## Entity-List (Listendarstellung)

**Use:** Tabellarische Listen mit Klick → Detail (Figuren, Orte, Szenen, Findings, …).

**Klassen:**
- `.entity-list` — Container
- `.entity-list--accented` — mit linkem Akzentstreifen
- `.entity-row` / `.entity-row--selected` — Zeile
- `.entity-row-title` / `.entity-row-meta`
- `.entity-meta-row` / `.entity-meta-label` / `.entity-meta-value` — Detail-Box

CSS: [public/css/entity-list.css](public/css/entity-list.css). Wiederverwendbar für jede neue Listen-Karte; nicht selbst neu bauen.

---

## Card-Status / Loading / Empty / Error

| Zustand        | Klasse               | Inhalt |
|----------------|----------------------|--------|
| Loading        | `.card-status`       | i18n-Status + optional `.progress-bar-wrap` darüber |
| Empty          | `.card-status`       | `$app.t('common.noDataYet')` |
| Error          | `.card-status--error`| Fehlermeldung als i18n-Key |

Niemals reine `<div>`s mit Inline-Text dafür — immer durch `.card-status*`-Klassen.

---

## Chevron-Konventionen

| Pattern | Marker | Rotation |
|---------|--------|----------|
| Collapsible-Toggle | `›` | 0° → 90° (Klasse `.open`) |
| Combobox-Trigger   | `▾` | 0° → 180° (Klasse `--open`) |
| Disclosure (sonstig) | nicht erfinden — vorhandenes Muster nehmen |

Kein neuer Marker ohne Eintrag hier.

---

## Mikro-Typografie (Memory-Regeln)

- **Doppelpunkt als Funktion-Separator:** `Funktion: Target` mit `:`. Nicht `·` (das ist Listen-Trenner für gleichwertige Items).
- **Schweizer Zahlen:** Dezimal `.`, Tausender `’` (Apostroph). Locale-Tag `de-CH`.
- **Keine Icons/Emojis** ohne ausdrückliche Aufforderung. Disclosure-Marker (Chevron) zählen nicht als Icons.
- **Style-Konsistenz:** Eine Style-Entscheidung gilt für alle vergleichbaren Elemente. Wer eine Komponente neu macht, prüft, ob ähnliche bereits existieren — und passt entweder die existierenden mit an oder übernimmt deren Stil.

---

## Mobile-Breakpoints

**Pflicht:** Jede neue UI-Komponente bekommt im selben Commit Mobile-Breakpoints (`@media (max-width: 600px)`). Nie auf später verschieben.

**Standard-Set** (CSS-Custom-Properties funktionieren in `@media` nicht — diese vier Werte ausschliesslich verwenden):
- `480px` — Phone-Small (sehr enge Devices, harter Reflow)
- `600px` — Phone-Large (Default-Mobile-Breakpoint)
- `768px` — Tablet
- `1024px` — Desktop-Compact

---

## Layout-Pattern: List-Header (`.list-header`)

**Use:** Header-Zeile innerhalb einer Karte oder Sektion, die Titel + Aktionen horizontal anordnet und auf Mobile auf Spalte umbricht.

**Markup:**
```html
<div class="list-header list-header--between list-header--wrap">
  <h3 class="history-heading" x-text="$app.t('bereich.title')"></h3>
  <div class="card-actions">…</div>
</div>
```

**Modifier:**
- `.list-header--between` — `justify-content: space-between`
- `.list-header--wrap` — `flex-wrap: wrap`

CSS in [public/css/utilities.css](public/css/utilities.css). Mobile (≤600 px) bricht automatisch auf Spalte (`flex-direction: column; align-items: flex-start`).

**Wichtig:** Bestehende Sub-Header-Klassen (`.figur-list-header`, `.figur-szene-header` etc.) haben kontextspezifische Sonderlogik (Margins, Borders, Padding) und bleiben unverändert; die Util-Klasse ist Default für **neue** Header-Zeilen.

---

## Card-Animation (CSS-Only)

**Pattern:** Karten faden via `cardFadeIn` ein (in [public/css/card-form.css](public/css/card-form.css)). Niemals `x-transition` zusätzlich auf `.card` — translateY × scale konkurriert sichtbar bei grossen Karten (Szenen, Figuren).

Neues Karten-Element: nur `x-show="…" x-cloak`.

---

## Layout

### Zwei-Spalten (Sidebar + Main)

**Use:** Haupt-Editor-Layout (Tree links, Editor mittig, optional Chat rechts).

**Klassen** [public/css/twocolumn.css](public/css/twocolumn.css):
- `.layout` — Grid-Container
- `.layout-sidebar` — linke Spalte mit Tree
- `.layout-main` — Hauptbereich
- `.sidebar-resize-handle` — Drag-Handle, persistiert Spaltenbreite via JS

Nur einmal verwendet — nicht neu erfinden für andere Kontexte (Karten haben eigene Modal-Logik via `_closeOtherMainCards`).

### Row-Utility

**Use:** Flexbox-Wrapper für Button-Gruppen, Input-Reihen mit responsive Stacking.

```html
<div class="row">…</div>
```

CSS: [public/css/row.css](public/css/row.css). Auf Mobile (`max-width: 600px`) stapelt sich der Inhalt automatisch.

---

## Confirm-Dialog (Modal)

**Use:** Destruktive Aktionen bestätigen (Löschen, Reset, Logout).

**Markup:**
```html
<div class="confirm-overlay" x-show="confirmOpen" @click.self="confirmOpen = false">
  <div class="confirm-dialog">
    <div class="confirm-dialog-message" x-text="$app.t('…')"></div>
    <div class="confirm-dialog-actions">
      <button class="confirm-dialog-btn" @click="confirmOpen = false">…</button>
      <button class="confirm-dialog-btn confirm-dialog-btn--danger" @click="…">…</button>
    </div>
  </div>
</div>
```

CSS: [public/css/confirm-dialog.css](public/css/confirm-dialog.css). Varianten `--primary` und `--danger`. Niemals native `confirm()` verwenden.

---

## Skeleton-Loader

**Use:** Während Daten laden — verhindert CLS (Layout-Shift), zeigt Strukturhinweis.

**Entity-List** (Listen-Karten):
```html
<div class="entity-skeleton" x-show="loading">
  <template x-for="i in 5">
    <div class="entity-skeleton-row">
      <div class="entity-skeleton-cell entity-skeleton-cell--anchor"></div>
      <div class="entity-skeleton-cell entity-skeleton-cell--title"></div>
      <div class="entity-skeleton-cell entity-skeleton-cell--meta"></div>
    </div>
  </template>
</div>
```

**Chat** (mehrzeiliges Schimmer-Pattern):
- `.chat-skeleton-wrapper` + `.chat-skeleton-line`
- Animation `@keyframes skeleton-shimmer` in [public/css/chat.css](public/css/chat.css).

Kein Skeleton ohne Shimmer-Animation. CSS-File-Referenzen: [entity-list.css](public/css/entity-list.css), [chat.css](public/css/chat.css).

---

## Filter-Bar (Listenfilter)

**Use:** Such-/Filtereingaben oberhalb von `.entity-list`-Listen.

**Markup:**
```html
<div class="filter-bar">
  <input class="filter-search-input" type="text" :placeholder="$app.t('filter.search')" x-model="filterText">
  <span class="filter-count" x-text="filteredItems.length + ' / ' + items.length"></span>
</div>
```

**Severity-/Wertungs-Filter:** generisches `.tabs` / `.tabs-btn` (siehe Tabs-Sektion oben). Kein eigenes Filter-Pattern. Beispiele: [public/partials/kontinuitaet.html](public/partials/kontinuitaet.html), [public/partials/szenen.html](public/partials/szenen.html).

---

## Heatmap-Visualisierung

**Use:** Tabellarische Datenintensitäts-Darstellung (Stil-Heatmap, Fehler-Heatmap).

**Klassen** [public/css/heatmap.css](public/css/heatmap.css):
- `.heatmap-wrap` — Container
- `.heatmap-legend` — Skala oberhalb
- `.heatmap-scroll` — horizontaler Scroll-Container
- `.heatmap-table` — Tabelle mit sticky `thead`
- `.heatmap-rowhead` — sticky linke Spalte
- `.heatmap-cell--tinted` / `--primary` / `--faded` / `--empty` — Intensitätsstufen
- `.heatmap-cell--clickable` / `--active` — interaktiv

**Detail-Drawer** unter Tabelle: `.heatmap-detail` mit `.heatmap-detail-list`/`-page`/`-token-groups`.

**Mode-Toggle innerhalb Heatmaps:** `.tabs` + `.tabs-btn` + `--active`. Identisch zur generischen Tabs-Sektion oben — kein eigenes Heatmap-Pattern, einfach `.tabs` wiederverwenden.

---

## Tree (Sidebar-Navigation)

**Use:** Hierarchische Buch-/Kapitel-/Seiten-Navigation in der Sidebar.

**Klassen** [public/css/tree-history.css](public/css/tree-history.css):
- `.tree-chapter` / `.tree-chapter-header` / `.tree-chapter-header--active`
- `.tree-chapter-meta` — Counter rechts
- `.tree-chevron` / `.tree-chevron.open` — gleicher Rotations-Mechanismus wie Section-Toggle (nur Klassenpräfix anders)
- `.tree-chapter-pages::before` — visuelle Guide-Linie zu Children

Nur in Sidebar-Tree verwendet. Bei neuer hierarchischer Liste: erst prüfen, ob die Tree-Klassen passen.

---

## History-Item-List (Versionierung, Job-Verlauf)

**Use:** Liste vergangener Job-Läufe / Page-Revisions, klappbar mit Detail-Drawer.

**Markup:**
```html
<button class="history-item" :class="{ 'history-item--active': active, 'history-item--open': open }">
  <span class="history-chevron" :class="{ open }">›</span>
  <span class="history-date" x-text="date"></span>
  <button class="history-item-delete" @click.stop="del()">…</button>
</button>
<div x-show="open" class="history-detail">…</div>
```

CSS: [public/css/tree-history.css](public/css/tree-history.css). `.history-detail` hat einen gestrichelten Top-Border, der visuell anschliesst. Chevron + State (`open`) wiederverwenden — nicht neu definieren.

---

## Findings-Cards (Lektorat-Ergebnisse)

**Use:** Einzelne Lektorats-/Review-Findings mit Original/Korrektur und Apply-Action.

**Klassen** (CSS in [public/css/findings.css](public/css/findings.css), Render-Logik im Frontend):
- `.finding` / `.finding--flash` (Highlight-Animation) / `.finding--applied` (nach Übernahme)
- Severity-Variante: `.finding.error` / `.ok` / `.style`
- Children: `.finding-header`, `.finding-checkbox`, `.finding-content`, `.finding-original`, `.finding-korrektur`, `.finding-explanation`, `.finding-toggle-group`

**Stilbox** (`.stilbox`, `.stilbox--review-summary`, `.stilbox--spaced`) — bordered Container für Analyse-Sektionen, in Reviews und Findings wiederverwendet.

---

## Heading-Hierarchie in Karten

- `.card-title` — Karten-Titel (Header)
- `.card-subline` / `.card-subline-link` — Untertitel mit Timestamp/Save-Indicator
- `.section-heading` — Sub-Sektion innerhalb generierter Outputs
- `.section-heading-top` — erste Section ohne oberen Abstand

Kein `<h3>`/`<h4>` innerhalb von Karten ohne diese Klassen — sonst kollidiert es mit globaler Heading-Cascade.

---

## Save-Indicator

**Use:** Karten mit auto-saving State (Editor, User-Settings, Book-Settings).

```html
<span class="save-indicator save-indicator--draft" x-text="$app.t('common.draft')"></span>
<span class="save-indicator save-indicator--offline" x-text="$app.t('common.offline')"></span>
```

CSS: [public/css/focus-mode.css](public/css/focus-mode.css). Inline in `.card-subline`.

---

## Page-Content-View (Reading-Frame)

**Use:** Seiteninhalt im Lese-/Fokus-Modus (Serifenfont, lange Zeilen, Callouts).

**Klassen** [public/css/page-view.css](public/css/page-view.css):
- `.page-content-view` — Container mit max-width, Serif-Font
- `.page-content-view--editing` — Variante während Bearbeitung
- Innerhalb: native `h1`–`h6`, `blockquote` werden auto-gestylt
- `.callout.info` / `.success` / `.warning` / `.danger` — links eingerückte Callout-Boxen
- `.poem` — Sonderlayout für Verse (preserve whitespace)
- `.lektorat-mark` / `.lektorat-mark--selected` — Inline-Annotationen

Nicht selbst Reading-Typografie definieren; immer diesen Frame verwenden.

---

## Focus-Mode

**Use:** Vollbild-Editor mit Typewriter-Dimming (Cmd+Shift+F).

**State-Selektor:** `body.focus-mode` (gesetzt durch JS-Toggle).

**Klassen** [public/css/focus-mode.css](public/css/focus-mode.css):
- `.focus-paragraph-active` — voll sichtbarer Paragraph
- `.focus-paragraph-near` — leicht gedimmt (opacity 0.6)
- nicht-aktive Paragraphen: opacity 0.35
- `.focus-live-counter` / `.focus-live-counter--today` — Live-Wortzähler

Granularität (paragraph/sentence) und Timings sind über Tests abgesichert ([tests/unit/focus-granularity.test.mjs](tests/unit/focus-granularity.test.mjs)). Bei Änderungen Tests laufen lassen.

---

## Avatar-Menu

**Use:** User-Menü oben rechts (Profil, Logout, Sprache).

**Klassen** (CSS in [public/css/buttons-badges.css](public/css/buttons-badges.css) + erweitert):
- `.avatar-btn` / `.avatar-btn--active` — Trigger
- `.avatar-btn-img` (Foto) oder `.avatar-btn-initials` (Fallback)
- `.avatar-menu-panel` — Dropdown
- `.avatar-menu-header` (mit `-avatar`/`-text`/`-img`)
- `.avatar-menu-section`, `.avatar-menu-item`, `.avatar-menu-item--logout`
- `.avatar-menu-divider`, `.avatar-menu-label`
- `.avatar-menu-provider` + `-dot` (Provider-Indikator)

Markup: [public/partials/avatar-menu.html](public/partials/avatar-menu.html). Bei neuen Header-Dropdowns dieses Pattern wiederverwenden statt eigenes Menu zu bauen.

---

## Edit-Bubble-Toolbar (Inline-Formatierung)

**Use:** Schwebender Format-Button-Bar bei Editor-Selection (Bold/Italic/Heading).

**Klassen** [public/css/edit-toolbar.css](public/css/edit-toolbar.css):
- `.edit-bubble-toolbar` — fixed-position Container
- `.edit-bubble-btn` / `.edit-bubble-btn--bold` / `--italic` — Variante pro Format
- Slash-Menu: `.edit-slash-menu`, `.edit-slash-hint`, `.edit-slash-item`, `.edit-slash-item--active`

Spezifisch für Editor — bei neuer Inline-Toolbar erst prüfen, ob die Edit-Klassen passen.

---

## Find-and-Replace

**Use:** Suchen/Ersetzen-Panel im Editor (Cmd/Ctrl+F).

**Klassen** [public/css/find-replace.css](public/css/find-replace.css):
- `.edit-find` (fixed Container), `.edit-find-row`
- `.edit-find-input` (Such-/Ersetzen-Input)
- `.edit-find-count` (Treffer-Anzeige)
- `.edit-find-btn` / `.edit-find-btn--toggle` / `--active`
- `.edit-find-close`

Nur einmal verwendet (Editor). Doku hier zur Auffindbarkeit für künftige Such-Features.

---

## Tooltip / Lookup-Popover

**Use:** Hover-/Click-Popover mit Detail-Info (z.B. Figuren-Lookup im Editor bei Ctrl+Click).

**Klassen** [public/css/figur-lookup.css](public/css/figur-lookup.css):
- `.figur-lookup`, `.figur-lookup-header`, `.figur-lookup-body`, `.figur-lookup-row`, `.figur-lookup-footer`, `.figur-lookup-link`
- Position: fixed, JS setzt Top/Left aus Cursor-Position

Bei neuen Popover-Komponenten dieses Markup-Schema übernehmen (Header/Body/Footer), Custom-Klassen-Präfix pro Use-Case (`.xxx-lookup`).

---

## Sofort-Tooltip (`data-tip`) — **Default-Variante**

**Harte Regel:** `data-tip` ist die bevorzugte Tooltip-Variante. Natives `title=` hat ~500ms Delay, der nicht abstellbar ist — zu langsam für jedes Hover-Feedback. Neue Tooltips werden grundsätzlich als `data-tip` gesetzt.

**Markup:** `data-tip="Mo: +1234"` (oder Alpine `:data-tip="..."`) auf beliebigem Element. Das Attribut bleibt — gerendert wird via geteiltem Layer.

**Implementation:** Ein einziges `.tip-layer`-Element wird beim ersten Hover via [public/js/tooltip.js](public/js/tooltip.js) in den Body gehängt und auf das jeweilige Target positioniert (fixed). Pseudo-Slots (`::before`/`::after`) auf den Targets bleiben so frei für eigene Decorations.

**Klassen** [public/css/tooltip.css](public/css/tooltip.css):
- `.tip-layer` (Wrapper, `position: fixed`), `.tip-bubble` (Inhalt), `.tip-arrow` (Dreieck).
- `data-placement="top|bottom"` schaltet die Pfeilseite. Auto-Flip nach unten, wenn oben kein Platz.

**Wann `title=` ausnahmsweise erlaubt:**
- Reine Form-Inputs / Icon-Buttons, wo a11y-Screenreader-Hint wichtiger ist als Geschwindigkeit (`<button title="Schliessen">` etc.).
- In Konflikt-Fällen darf beides parallel gesetzt werden (`data-tip` für Sicht, `title` für Screenreader).

**Nicht erlaubt:**
- Neue Wert- oder Erklärungs-Tooltips als `:title=` ohne `data-tip` daneben — User-Präferenz, weil 500ms-Delay als störend empfunden wird.
- **Keine** `[data-tip]:hover::before` / `::after`-Selektoren — Pseudos auf dem Target gehören dem Element.

---

## Header-Actions

**Use:** Rechts-ausgerichtete Button-Cluster im Karten-Header (z.B. „Aktualisieren"-Button, Token-Stats).

**Klassen** [public/css/header-actions.css](public/css/header-actions.css):
- `.header-actions` — flex-Container
- `.header-action-cluster` — Sub-Gruppe mit reduziertem Gap
- Innerhalb: `.tok-stats` für Token-Counter

Nicht eigene Toolbar-Layouts pro Karte erfinden.

---

## Command-Palette

**Use:** Globaler Power-User-Eintritt zu allen Features (Cmd/Ctrl+K bzw. `/`). Gruppierte Liste aus Karten, globalen Aktionen und Such-Providern (Seiten, Kapitel, Figuren, Orte, Szenen).

**Hero-Trigger** (auf Buch-Übersicht oben):
```html
<button type="button" class="palette-hero" @click="openPalette()">
  <span class="palette-hero-icon" aria-hidden="true">⌘</span>
  <span class="palette-hero-text" x-text="t('palette.hero.text')"></span>
  <kbd class="palette-hero-kbd">⌘K</kbd>
</button>
```

**Modal-Markup:** siehe [public/partials/palette.html](public/partials/palette.html) (per `x-teleport="body"` — fixed-Overlay aus transformiertem Eltern-Container befreit).

**Klassen** ([public/css/feature-tiles.css](public/css/feature-tiles.css)):
- `.palette-hero` / `-icon` / `-text` / `-kbd` — Hero-Trigger im Home
- `.palette-overlay` — Fullscreen-Overlay mit Backdrop-Blur
- `.palette-panel` — zentriertes Modal
- `.palette-input` — Such-Input (mit `role="combobox"`, `aria-controls`)
- `.palette-list` (`role="listbox"`) + `.palette-section` + `.palette-section-label`
- `.palette-item` / `--active` / `--disabled` (`role="option"`)
- `.palette-item-label` / `.palette-item-desc`
- `.palette-mode` + `.palette-mode-pill` — aktive Prefix-Mode-Anzeige (`>` Befehle, `#` Seiten, `!` Kapitel, `@` Figuren, `$` Orte, `%` Szenen)
- `.palette-legend` + `-grid` + `-row` — Prefix-Legende bei leerem Input
- `.palette-mark` — Fuzzy-Match-Highlight im Item-Label
- `.palette-empty` / `.palette-toast`

**SSoT:** Karten/Aktionen/Provider stehen in [public/js/cards/feature-registry.js](public/js/cards/feature-registry.js), nicht im Template. Neuer Eintrag → dort, nicht hier.

**Kein zweiter Such-Trigger:** Jede neue „Spotlight"-/„Quick-Switcher"-Idee zuerst in Palette-Provider einbauen, kein paralleles Modal.

---

## Book-Overview-Tiles

**Use:** Default-Home beim Buchwechsel ([public/partials/bookoverview.html](public/partials/bookoverview.html)). Tile-Grid mit Inline-SVG-Visualisierungen (Sparkline, Donut, 7-Tage-Bars, Stacked-Bar, Sterne) — bewusst **kein Chart.js-Lazy-Load** (Tiles laden sofort, wenig Daten).

**Klassen** ([public/css/book-overview.css](public/css/book-overview.css)):
- `.book-overview .overview-grid` — `repeat(auto-fit, minmax(220px, 1fr))` + `grid-auto-flow: row dense` (verhindert Whitespace-Inseln bei `--hero`/`--medium`/`--wide`-Spans)
- `.overview-tile` — Basis-Tile, optional `.internal-link` für klickbar
- Spans (≥720px): `.overview-tile--hero` (span 2), `.overview-tile--medium` (span 2), `.overview-tile--wide` (full-width)
- `.overview-tile--actions` — Quick-Action-Container (gestrichelter Border, kein Hover-Lift, optisch von Daten-Tiles abgesetzt)
- Tile-Innenleben: `.overview-tile-label` (Header), `.overview-hero-row`/`-num`/`-value`/`-unit`, `.overview-substats`/`-substat`, `.overview-sparkline`, `.overview-trend-meta`/`-pct` (`--up`/`--down`)
- 7-Tage-Bars: `.overview-bars7` + `-col`/`-track`/`-fill` (`--pos`/`--neg`)/`-label`, `.overview-bars7-total`
- Donut: `.overview-donut-row` + `.overview-donut` + `-text`/`-meta`
- Fehler-Bars: `.overview-error-bars` + `-bar-item`/`-head`/`-typ`/`-count`/`-track`/`-fill`
- Bewertung: `.overview-stars` + `.overview-star` (`--full`/`--half`), `.overview-review-meta`/`-date`/`-trend`
- Figuren-Chips: `.overview-fig-row` + `-count`/`-count-unit`/`-chips`/`-chip`/`-name`/`-avatar` (Avatar-Farbe via `[data-idx="0|1|2"]`)

**Klick-Verhalten:** `.overview-tile.internal-link` öffnet die zugehörige Karte (über globalen `.internal-link`-Handler aus app.js — nicht selbst verdrahten).

**Hover-Override:** Globaler `.internal-link:hover` setzt `opacity: 0.65`. Für Tiles ungewollt — `.overview-tile.internal-link:hover` setzt `opacity: 1` zurück und nutzt Border/Shadow als Affordance.

**Neuer Tile-Typ:** Bestehende Tile-Klassen wiederverwenden, SVG inline ins Markup, keine externe Vis-Lib für Overview einführen.

---

## Wartung

Wer ein neues Pattern einführt:
1. Gibt es schon eines, das passt? → wiederverwenden.
2. Wirklich neu? → hier dokumentieren (Markup-Snippet + CSS-Datei + Use-Case).
3. SHELL_CACHE in [public/sw.js](public/sw.js) bumpen (CSS/JS-Änderung).
4. i18n-Strings in beide Locales eintragen (CLAUDE.md-Regel).
5. Mobile-Breakpoints im selben Commit (CLAUDE.md-Regel).
