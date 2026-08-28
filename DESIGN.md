# DESIGN.md — UI-Pattern-Katalog

**Verbindlich.** Vor dem Hinzufügen neuer UI-Komponenten zuerst hier nachschlagen, ob das Pattern bereits existiert. Wiederverwenden statt neu erfinden. Neue Patterns werden in dieser Datei dokumentiert; ohne Eintrag hier kein neues UI-Element-Vokabular.

Token-Referenz (Farben, Radien, Spacing, Schriftgrössen): [public/css/tokens.css](public/css/tokens.css).

## Inhalt

**Grundlagen**
- [Doku-Template](#doku-template-pflicht-für-neue-sections) — Pflicht-Aufbau pro Section
- [Token-Pflicht](#token-pflicht-keine-ad-hoc-werte) — Schatten, Padding, Spacing, Transition, Opacity, Z-Index
- [Motion-Patterns](#motion-patterns) — cardFadeIn, `@starting-style`-Eintritt, View Transition beim Kartenwechsel, Hover-Mechaniken
- [Alpine-Plugins](#alpine-plugins-inventar) — was geladen ist (`x-anchor`/`x-trap`/`x-collapse`/`x-resize`), was mit Absicht nicht
- [Mikro-Typografie](#mikro-typografie-memory-regeln) — Doppelpunkt, Zahlen, Icons, Konsistenz
- [Feature-Text (Landing + Hilfe)](#feature-text-landing--hilfe) — Titel- und Längenrahmen für `landing.feat<N>Title/Desc`
- [Mobile-Breakpoints + Darkmode](#mobile-breakpoints--darkmode) — 480/600/768/1024 + Token-Pflicht für Farben
- [Container-Queries vs. Media-Queries](#container-queries-vs-media-queries)
- [Print-Styles](#print-styles) — nicht supported

**Komponenten**
- [Karten](#karten-card) — `.card` + Akzentfarben
- [Karten-Innenraum](#karten-innenraum) — Rhythmus + geteilte Bloecke IM Kartenkoerper
- [Buttons](#buttons) — Hierarchie, Counter
- [Action-Icon-Library](#action-icon-library-verbindlich) — **verbindlich**: Vokabular für alle Aktions-Buttons (icon-only vs. Label), Guard-Test
- [Icon-System](#icon-system-lucide-sprite) — `<svg class="icon"><use href="/icons.svg#name"/></svg>` (Lucide-Sprite)
- [Icon-Button](#icon-button-icon-btn) — generischer Icon-only Button (`.icon-btn` outlined + `--ghost`), SSoT für Canvas-/Header-/Board-Cluster
- [Toolbar-Action-Group](#toolbar-action-group-segmentierter-icon-cluster-neben-form-feldern) — segmentierte Icon-Reihe bündig mit Search/Combobox
- [Icon-Button-Count-Badge](#icon-button-count-badge-icon-btn-badge) — Counter oben rechts auf Icon-Button
- [Badges & Tags](#badges--tags) — eckig, Severity, Hue-Palette
- [Combobox](#combobox-auswahlfeld) — ersetzt `<select>`
- [Setting-Field](#setting-field-settingfield) — ein Admin-Settings-Feld deklarativ
- [Tabs / Modus-Toggle](#tabs--modus-toggle) — `.tabs` + `.tabs-btn`
- [Form-Patterns](#form-patterns-settings--und-export-karten) — `.card-form-grid` + Wertspalten
- [Progress-Bar](#progress-bar) — `--progress` Custom-Prop
- [Sequenz-Band](#sequenz-band-stil-rhythm-band) — lange Zahlenfolge in ihrer Reihenfolge (Satzrhythmus)
- [Rangliste mit Balken](#rangliste-mit-balken-stil-opener-list) — Top-N ohne Tabelle
- [Wortwolke](#wortwolke-wortschatz-cloud) — gewichtete Wortliste als Fläche (d3-cloud, lazy)
- [Entity-List](#entity-list-listendarstellung) — Listen mit Detail-Drawer
- [Listen-Anriss + Detail-Dialog](#listen-anriss--detail-dialog) — Zeilen-Cap in der Liste, Volltext im `<dialog>`
- [Karten-Toolbar](#karten-toolbar-card-toolbar) — Aktionszeile im Karten-Body
- [Filter-Bar](#filter-bar-listenfilter) — Such-/Sort-Eingaben
- [Heatmap-Visualisierung](#heatmap-visualisierung) — Daten-Intensität
- [Jahr×Monat-Heatmap](#jahrmonat-heatmap) — Jahre × 12 Monate, Dichte-Raster
- [History-Item-List](#history-item-list-versionierung-job-verlauf) — Versionen + Job-Verlauf
- [Tree](#tree-sidebar-navigation) — Buch/Kapitel/Seiten-Navigation
- [Skeleton-Loader](#skeleton-loader) — Shimmer beim Laden
- [Klappbarer Section-Toggle](#klappbarer-section-toggle-accordion) — Accordion via `.collapsible-toggle`
- [Card-Status](#card-status--loading--empty--error) — Loading/Empty/Error
- [Sortierbare Tabelle](#sortierbare-tabelle-sortabletable) — Client-Side-Sort via `sortableTable` Alpine-Komponente
- [Aktions-Spalte in Tabellen](#aktions-spalte-in-tabellen) — letzte Spalte mit Icon-Buttons; die Zelle bleibt Zelle
- [Chevron-Konventionen](#chevron-konventionen) — `›` 90°, `▾` 180°

**Layout & Navigation**
- [Layout](#layout) — Sidebar + Main, Row-Utility
- [Layout-Pattern: List-Header](#layout-pattern-list-header-list-header)
- [Heading-Hierarchie](#heading-hierarchie-in-karten) — `.card-title`/`.section-heading*`
- [Save-Indicator](#save-indicator)
- [Header-Actions](#header-actions)
- [Avatar-Menu](#avatar-menu)
- [Command-Palette](#command-palette) — Cmd/Ctrl+K
- [Routing / Deep-Links](#routing--deep-links-url-pflicht) — Hash-URL pro Feature Pflicht
- [Book-Overview-Tiles](#book-overview-tiles) — Default-Home-Grid

**Editor**
- [Editor](#editor) — Findings, Page-View, Focus, Edit-Bubble, Find-Replace, Lookup

**Overlays**
- [Chef-Taste / Boss-Key (`.boss-screen`)](#chef-taste--boss-key-boss-screen)
- [Confirm-Dialog](#confirm-dialog-modal)
- [Danger-Zone](#danger-zone-danger-zone) — abgesetzter Block für unwiderrufliche Aktionen
- [Modal-Wrapper](#modal-wrapper-generisches-pattern) — Status: noch nicht konsolidiert
- [Overlay-Focus-Trap](#overlay-focus-trap-x-trap) — `x-trap` für Overlays ohne natives `<dialog>`
- [Sofort-Tooltip (`data-tip`)](#sofort-tooltip-data-tip--default-variante) — inkl. [Tastenkürzel im Tooltip](#tastenkürzel-im-tooltip)
- [Graph-Tooltip (vis-network)](#graph-tooltip-vis-network)
- [Keyboard-Shortcut (`<kbd>`)](#keyboard-shortcut-anzeige-kbd)
- [Loading-Overlay](#loading-overlay) — Status: kein generisches Pattern
- [Empty-State mit CTA](#empty-state-mit-cta) — `.card-empty` + CTA-Button
- [Inline-Action-Group](#inline-action-group) — Status: kein Standard
- [Drawer / Side-Panel](#drawer--side-panel) — noch kein generisches Pattern
- [Toast/Snackbar](#toastsnackbar) — noch kein generisches Pattern

**Querschnitt**
- [Z-Index-Stack](#z-index-stack)
- [Relative z-index](#relative-z-index-lokal-stack-werte) — lokal-stack-Werte
- [Reduced-Motion (Pflicht)](#reduced-motion-pflicht)
- [Severity-Vokabular](#severity-vokabular-mapping)
- [Accessibility (A11y)](#accessibility-a11y)
- [Naming-Konventionen](#naming-konventionen)
- [CSS-File-Inventar](#css-file-inventar)
- [Pattern-Matrix](#pattern-matrix-karte--pattern)
- [Tooling: stylelint-Skizze](#tooling-stylelint-skizze)
- [Wartung](#wartung) — Checkliste für neue Patterns

---

## Doku-Template (Pflicht für neue Sections)

Jede Pattern-Section folgt diesem Aufbau. Sub-Items sind optional, aber Reihenfolge ist fix — sonst sind ähnliche Sections nicht querlesbar.

```markdown
## <Pattern-Name>

**Use:** Ein Satz, was es ist und wann es greift.

**Markup:** (optional, wenn nicht-trivial)
\`\`\`html
<div class="…">…</div>
\`\`\`

**Klassen** [link/zur/css.css](path):
- `.foo` — Zweck
- `.foo--variant` — Modifier-Zweck

**Regeln:** (optional, wenn Anti-Patterns oder harte Constraints)
- …

**Beispiele:** [partial.html](path), [andere-partial.html](path)
```

Pflicht-Reihenfolge: **Use → Markup → Klassen → Regeln → Beispiele**. Wer eine Section anlegt ohne `**Use:**`-Zeile, lässt einen Pattern-Eintrag ohne Daseinsberechtigung im Katalog.

## Token-Pflicht (keine ad-hoc-Werte)

Wiederkehrende Werte gehen über Tokens. Ad-hoc-Werte (`box-shadow: 0 4px 12px ...`, `padding: 7px 10px`, `opacity: 0.5`) nur, wenn keine Token-Variante passt.

| Bereich | Tokens | Verwendung |
|---------|--------|------------|
| **Schatten** | `--shadow-sm` (Sheet-Lift: Seitenblatt, Overlay-Controls), `--shadow-md` (Popover/Dropdown), `--shadow-lg` (Modal), `--shadow-inset-top` (Job-Queue-Footer) | Drei Erhebungs-Stufen + Inset. Dark-Theme erbt automatisch dunklere Schatten. `.card` ist bewusst **flach** (kein Baseline-/Hover-Schatten — Border + Akzentband tragen die Kante, siehe „Karten"). |
| **Padding** | `--pad-btn-compact` (7px 10px), `--pad-badge` (4px 8px), `--pad-detail` (0.5rem 0.75rem) | Compact-Buttons, Badges/Tags, Detail-Boxen / Drawer-Inhalt. |
| **Spacing** | `--space-xs` (4px), `--space-sm` (8px), `--space-md` (12px), `--space-lg` (16px), `--space-xl` (24px), `--space-2xl` (32px) | Margins, Gaps, Row-Gaps. 4-Pixel-Raster. Ad-hoc Pixel nur bei wirklich nicht-passendem Token. |
| **Transition** | `--transition-fast` (0.1s), `--transition-base` (0.12s), `--transition-slow` (0.15s), `--transition-emphasized` (0.3s) | Standard-Cadence. Emphasized für Modal/Drawer-Slides, Card-Eingang, längere Fades. **NIE als `--x: var(--x)` definieren** — zirkuläre Custom-Property ist invalid → ganze `transition`/`animation`-Property kippt auf Default `0s` → Chevron-Rotationen, `cardFadeIn`, Hover-Tints sind tot, Erweiterungen „wackeln" weil Section snappt ohne Chevron-Maskierung. Definitionen müssen Literalwerte tragen, [public/css/tokens/motion.css](public/css/tokens/motion.css). `prefers-reduced-motion: reduce` flippt alle Transition-Tokens auf `0s` (globaler Override in derselben Datei). **Easing:** `--ease-out` (Quint, `cubic-bezier(0.22, 1, 0.36, 1)`) für Eingänge — `--transition-emphasized` nutzt es bereits; Hover-Tints/Zustandswechsel bleiben auf `ease`. |
| **Opacity** | `--opacity-disabled` (0.6), `--opacity-muted` (0.5), `--opacity-hint` (0.4), `--opacity-faint` (0.35), `--opacity-strong` (0.75) | Semantische Stufen. `:disabled` immer `--opacity-disabled`. |
| **Focus-Ring** | — | Kein wildcard-`:focus-visible`-Token. Browser-Default-Outline aktiv; per-Element-Fokus-Styles für Tab-Navigation in [base.css](public/css/layout/base.css) (Skip-Link, `.page-item`, `.tree-chapter-header`, `.lektorat-split-findings .finding`). Komponenten mit eigenem Fokus-Signal setzen `outline: none` ohne `!important`. |
| **Font-Size** | `--font-size-xs` (11px), `--font-size-sm` (13px), `--font-size-base` (14px), `--font-size-md` (15px), `--font-size-lg` (18px), `--font-size-xl` (22px), `--font-size-2xl` (26px) | xs/sm/base/md = UI-Stufen. lg = Sub-Heading. xl = Card-Title-Standard. 2xl = Hero/H1. |
| **Font-Family** | `--font-sans` (Inter), `--font-serif` (Source Serif 4) | UI immer `--font-sans`, Reading-Frame + Headings `--font-serif`. |
| **Font-Weight** | `--fw-regular` (400), `--fw-medium` (500), `--fw-semibold` (600), `--fw-bold` (700) | `font-weight: 600` → `var(--fw-semibold)`. |
| **Line-Height** | `--lh-tight` (1.2), `--lh-base` (1.45), `--lh-relaxed` (1.6) | Headings/UI tight, Standard base, Reading-Frame relaxed. |
| **Border-Width** | `--border-thin` (0.5px), `--border-thick` (2px) | Nur die **Abweichungen** vom Standard sind tokenisiert: dezenter Trenner bzw. Akzentband. Der Regelfall 1px steht literal (`border: 1px solid var(--color-border)`) — die Farbe ist das Token, die Breite nicht. |
| **Radius** | `--radius-sm` (0, hart — Badges/Tags/Pills), `--radius-md` (2px — Cards, Inputs, Buttons), `--radius-lg` (4px — Modal, Drawer, Tooltip, Confirm-Dialog) | Editorial-Eckig bleibt Leitmotiv (Listen-Elemente hart auf 0), grössere Flächen leicht weichgespült. Nicht zu ad-hoc Pixel-Radius greifen. |
| **Text-Farben** | `--color-text`, `--color-muted`, `--color-subtle`, `--color-faint` | Vier Stufen vom prägnantesten zum dezentesten — Body / sekundär / tertiär / fast unsichtbar. Inverse für dauerhaft dunkle Flächen: `--color-text-inverse`. |
| **Z-Index** | `--z-base` (1), `--z-sticky` (100), `--z-header` (200), `--z-popover` (1000), `--z-toolbar` (1100), `--z-overlay` (2000), `--z-banner` (10000), `--z-modal` (9500), `--z-modal-front` (11000), `--z-toast` (12000), `--z-boss-screen` (13000) | Stapel-Reihenfolge — siehe Section „Z-Index-Stack" unten. |

---

## Motion-Patterns

**Use:** Ein-/Austritte von Karten, Popovers und Menüs. Drei sanktionierte Mechaniken — keine weiteren Motion-Vokabeln erfinden.

1. **Karten-Eintritt: `cardFadeIn`** (CSS-Keyframe in [card-form.css](public/css/components/card-form/card-shell.css), `--transition-emphasized` = 0.3s `--ease-out`, `translateY(8px)` → 0). Kommt automatisch mit `.card`; kein `x-transition` zusätzlich (siehe „Karten").
2. **Popover-/Menü-Eintritt: `@starting-style`** — display-getriebene Elemente (Alpine `x-show`, selbst gerenderte Dropdowns) faden rein per `transition: opacity var(--transition-base)` + `@starting-style { .x { opacity: 0; } }`. **Nur Opacity** — kein Transform, damit Flip-/Anchor-Messungen (`offsetHeight` im `$nextTick`) unbeeinflusst bleiben. Austritt bleibt instant (x-show setzt `display:none` direkt; ein CSS-only-Exit-Fade ist mit x-show nicht erreichbar). Referenz: `.context-menu` ([context-menu.css](public/css/components/context-menu.css)), `.combobox-dropdown` ([combobox.css](public/css/components/combobox.css)).
3. **Kartenwechsel: View Transition** — der generische Karten-Toggle (`_toggleCardGeneric` + Helper `_withCardTransition` in [_shared.js](public/js/app/app-view/_shared.js)) wickelt Flag-Wechsel in `document.startViewTransition` (Cross-Fade der Hauptansicht). Progressive Enhancement: ohne Support läuft der Callback direkt. Regeln: Netzwerk (`_ensurePartial`) **vor** der Transition; DOM-Endzustand (inkl. `$nextTick`) **im** Callback. Reduced-Motion wird in [tokens/motion.css](public/css/tokens/motion.css) via `::view-transition-*`-Override gekappt. Bespoke-Toggles, die den Cross-Fade wollen, nutzen denselben Helper.

**Hover hat zwei sanktionierte Mechaniken** (nicht mischen, nicht neu erfinden): **(A) Alpha-Wash** — `background: var(--color-hover)` bzw. `color-mix`-Tint (Buttons, Listen-Rows, Options, Ghost-Icon-Buttons); **(B) Fill-Flip/Kanten-Signal** — Hintergrund-/Border-Wechsel auf einen benachbarten Flächen-Token (outlined `.icon-btn` → `--color-surface`, Tabs → Textfarbe, `.card` → Akzent-Border). Neue Komponenten wählen A, ausser sie sind outlined-Chips auf Papier-Ton.

---

## Alpine-Plugins (Inventar)

**Use:** Vier offizielle Plugins sind geladen — vendored unter `public/vendor/alpine-<name>-3.15.12.min.js`, als `<script defer>` **vor** dem Alpine-Core in [index.html](public/index.html). Kein Lazy-Load: der Core registriert für jede nicht geladene Plugin-Direktive einen Stub, der beim Antreffen nur warnt.

| Direktive | Plugin | Wofür — und wo die Regel steht |
|---|---|---|
| `x-anchor` | anchor | Popover am Trigger verankern (Floating UI). Siehe „Combobox". |
| `x-trap` | focus | Focus-Trap in Overlays, die kein natives `<dialog>` sind. Siehe „Overlay-Focus-Trap". |
| `x-collapse` | collapse | Animierte Panel-Höhe. Kommt automatisch über `collapsible` — siehe „Klappbarer Section-Toggle". |
| `x-resize` | resize | ResizeObserver als Direktive. **Nur für neuen Code**, siehe unten. |

**`x-resize` — Regel:** neue Grössen-Beobachtung im Template deklarieren (`x-resize="_bandWidth = $width"`), statt in der Karte einen `ResizeObserver` samt Teardown zu bauen. Die **bestehenden** sechs handgerollten Observer bleiben, wie sie sind ([ereignisse-card.js](public/js/cards/ereignisse-card.js), [comment-rail-layout.js](public/js/editor/comment-rail-layout.js), [format-marks.js](public/js/editor/notebook/format-marks.js), [editor-spellcheck/controller.js](public/js/cards/editor-spellcheck/controller.js), [share-reader/layout.js](public/js/share-reader/layout.js)) — sie brauchen eigenes rAF-/Doppel-rAF-Scheduling und beobachten teils Elemente, die es zur Init-Zeit noch nicht gibt; `x-resize` kann beides nicht. Kein Retrofit „weil man eh in der Datei ist".

**Nicht geladen, mit Absicht:** `sort` (2D-DnD + Nesting → SortableJS, siehe [sortable-dnd.js](public/js/sortable-dnd.js)), `persist` (Keys sind pro User **und** Buch skopiert und stehen erst nach `/config` fest → [local-prefs.js](public/js/local-prefs.js)), `intersect` (die vorhandenen IntersectionObserver brauchen `root`/`rootMargin` und dynamische Element-Sets), `mask` (Zahlen-Formatierung gehört in `numInput`, sonst zwei Wahrheiten im selben Feld), `morph` (kein HTML-over-the-wire; Partials werden frisch gemountet). Neues Plugin ⇒ erst hier begründen, dann laden.

---

## Klappbarer Section-Toggle (Accordion)

**Use:** Sekundärer Inhalt in einer Karte, der per Default zu sein soll (Legenden, Zusammenfassungen, Details).

Eine eigenständige, per-Boolean klappbare Sektion nutzt **`Alpine.data('collapsible')`** aus [public/js/collapsible.js](public/js/collapsible.js). Die Komponente besitzt den Open-State (`open`), die Toggle-Logik, die ARIA-Kopplung und die Chevron-Rotation; Konsumenten verdrahten nichts mehr von Hand, sondern spreaden drei `x-bind`-Objekte (`trigger`/`chevron`/`panel`).

**Markup (Pflicht):**
```html
<div class="collapsible-wrap" x-data="collapsible()">   <!-- collapsible(true) für initial offen -->
  <button type="button" class="collapsible-toggle" x-bind="trigger">
    <span class="history-chevron" x-bind="chevron" aria-hidden="true"></span>
    <span x-text="$app.t('bereich.toggle')"></span>
  </button>
  <div x-bind="panel" x-cloak class="collapsible-section">…Inhalt…</div>
</div>
```

- `x-data="collapsible()"` auf ein Element, das **Trigger und Panel umschliesst** (oft die bereits vorhandene `.collapsible-wrap`/`section`). `collapsible(true)` für per Default offen.
- `x-bind="trigger"` (setzt `type`, `@click`→toggle, `:aria-expanded`), `x-bind="chevron"` (rotiert via `.open`), `x-bind="panel"` (`x-show` + `x-collapse`). Der `.history-chevron`-Span braucht **keinen** Inhalt (CSS-Mask-Icon) — kein `›`, kein `<svg>`.
- In `x-for`-Schleifen pro Item eine eigene `x-data="collapsible()"`-Instanz (Default-Wert darf die Loop-Variable lesen, z.B. `collapsible(role === 'body')`).

**Parent-gesteuerter State** (persistiert, oder vom Parent zurückgesetzt — z.B. Reset bei Buchwechsel): zusätzlich `x-modelable="open" x-model="parentVar"` koppeln (analog combobox/numInput). Beispiel: Blog/HubSpot-Sektion in [public/partials/book-settings.html](public/partials/book-settings.html) (Card setzt `blogSectionOpen` bei Buchwechsel zurück).

`.collapsible-wrap` (block-Container, Spacing pro Section) + `.collapsible-section` (border-left, padding, Inhaltsabstand) leben beide in [public/css/entities/entity-list.css](public/css/entities/entity-list.css).

**Öffnen/Schliessen animiert die Panel-Höhe** — `x-collapse` (@alpinejs/collapse) reist im `panel`-Spread mit, Konsumenten-Markup bleibt unverändert. Zwei Folgen:
- Das Plugin hält **`overflow: hidden`** auf dem Panel. Absolut positionierte Kinder (Kebab-Menü, Popover) würden darin abgeschnitten — die gehören ohnehin per `x-teleport` in den Top-Layer (siehe „Context-Menu"), nicht ins Panel. **Daraus folgt: keine `combobox` in ein Collapsible-Panel** — sie rendert ihr Dropdown als eigenes Kind und kann es nicht teleportieren; die Optionsliste wäre abgeschnitten und unklickbar (der State sagt trotzdem korrekt „offen"). Braucht eine Sektion eine Auswahl-Combobox, bleibt sie flach.
- **Kein `x-transition` zusätzlich** aufs Panel (analog `.card`/`cardFadeIn`): zwei konkurrierende Mechaniken auf demselben Element wirken wabbelig. Reduced-Motion braucht keinen Sonderfall — der globale `transition-duration: 0s !important`-Override in [tokens/motion.css](public/css/tokens/motion.css) greift, und Alpines Transition-Helper liest die berechnete Dauer.

**Regeln:**
- Chevron rotiert via `.history-chevron.open` (90°). CSS in [public/css/page/tree-history.css](public/css/page/tree-history.css). Nur die Klasse `.open` dreht — **nicht** `.is-open` o.ä.
- Button-Stil `.collapsible-toggle` (uppercase, kleinere Schrift, `inline-flex`). CSS in [public/css/entities/entity-list.css](public/css/entities/entity-list.css).
- Kein `<details>`/`<summary>` — nicht stylebar genug, andere optische Sprache.
- **Nicht** für Listen-/Tree-Row-Chevrons verwenden, die per `selectedXId === item.id` oder einer Per-Item-Map (`chapterOpen[id]`, Tree-`item.open`) gesteuert werden — das ist Single-Select-/Tree-Expansion, kein eigenständiger Boolean-Toggle. Dort bleibt die `.history-chevron`-Rotation, der State aber im Selektionsmodell. Ebenso Sonderfälle mit eigener Persistenz (localStorage) oder State, der in eine Berechnung einfliesst.
- **Toggle-Button NICHT lokal auf `display: flex; width: 100%` umstellen.** Hat in der Vergangenheit horizontalen Wackel-Shift beim Öffnen verursacht (PDF-Export-Karte). Block-Stapelung kommt vom `.collapsible-wrap`-Container, nicht vom Button selbst.
- **„Wackelt beim Öffnen"-Symptom** = Chevron-Rotation läuft nicht ODER Toggle ist auf full-width gestreckt. Ursache 1 (vertikal): `--transition-slow` ist invalid (z.B. zirkuläre Definition) → in DevTools auf `0.15s ease` prüfen; Token reparieren reicht für die ganze Karte. Ursache 2 (horizontal nach rechts): Toggle ist `display: flex; width: 100%` und ändert beim Klick die Layout-Box → Default `inline-flex` zurücksetzen, in `.collapsible-wrap` einwickeln. Springt die **Höhe** statt zu gleiten, fehlt das collapse-Plugin (Core-Stub warnt in der Konsole) oder das Panel trägt eine eigene `height`/`max-height`-Regel, gegen die das Plugin anschreibt.

**Beispiele:** Kontinuitäts-Zusammenfassung [public/partials/kontinuitaet.html](public/partials/kontinuitaet.html), Figuren-Legende [public/partials/figuren.html](public/partials/figuren.html), PDF-Export-Sektionen [public/partials/pdf-export.html](public/partials/pdf-export.html).

---

## Karten (`.card`)

**Use:** Hauptansicht im Buchscope (Figuren, Orte, Szenen, …).

**Regeln:**
- Wurzel `<div class="card card--<key>" x-data="xxxCard" x-show="$app.showXxxCard" x-cloak>`. **`card--<key>` Pflicht** — auch wenn die Karte den Akzent (noch) nicht visuell nutzt, hängt die `--card-accent`-Custom-Property dran und steht für künftige Anchor-Bar/Title-Underline/Severity-Marker bereit.
- **Animation: nur CSS (`cardFadeIn` aus [public/css/components/card-form.css](public/css/components/card-form/card-shell.css), 0.3s `--ease-out`).** Kein `x-transition` auf `.card` — translateY × scale konkurriert sichtbar bei grossen Karten (Szenen, Figuren), wirkt wabbelig. Neues Karten-Element nur `x-show="…" x-cloak`.
- **Fläche: flach + Akzent-Wash.** Kein Baseline-/Hover-Schatten auf `.card` — die Kante tragen Border (`--border-thin`) + 2px-Akzentband. Der Hintergrund ist ein hauchdünner Verlauf aus dem Karten-Akzent (`color-mix` 4% in `--color-surface`, läuft nach ~110px in die Surface aus). Hover verstärkt die Seiten-/Unterkanten Richtung Akzent (`border-inline-color`/`border-bottom-color` — nie der `border-color`-Shorthand, der würde das Akzentband umfärben).
- **Titel-Tintung:** `.card-title` zieht via `color-mix` 30% Richtung `--card-accent` (Fallback neutral). Kommt automatisch mit — pro Karte nichts deklarieren.
- Header: `.card-header` mit `.card-header--subline` für Buchtitel + Timestamp.
- Status-Hinweis: `.card-status` (Loading/Empty), `.card-status--error` für Fehler.
- Empty-State: `<div x-show="…" class="card-status" x-text="$app.t('common.noDataYet')"></div>`.

**Akzentfarbe pro Karte (Single-Source-of-Truth):**
- Hue-SSoT in [tokens/colors.css](public/css/tokens/colors.css): pro Karte **ein** Light-Basis-Token `--card-accent-<key>-base` + Mapping `--card-accent-<key>: var(--card-accent-<key>-base)`. Der Dark-Wert wird **nicht** von Hand gepflegt, sondern im Dark-Block per OKLCH Relative Color Syntax abgeleitet (aufhellen + leicht entsättigen; Konstanten `--accent-dark-lift`/`--accent-dark-chroma`/`--accent-dark-floor`).
- Mapping `.card--<key> { --card-accent: var(--card-accent-<key>); }` zentral in [public/css/card-accents.css](public/css/card-accents.css).
- `.card` rendert `--card-accent` automatisch als 2px Top-Border, Hintergrund-Wash und Titel-Tintung (Fallback neutral). Pro-Karten-CSS muss davon nichts selbst deklarieren — nur ergänzende Anwendungen (Anchor-Bar, Title-Underline) brauchen `var(--card-accent)`.
- Neue Karte: `--card-accent-<key>-base` (Light-Hue) + Mapping-Zeile im Light-Block ergänzen, **eine** abgeleitete `oklch(from …)`-Zeile im Dark-Block (Muster der Nachbarzeilen kopieren), Mapping in `card-accents.css`, Klasse `card--<key>` am Wurzel-Div setzen.

**Eyebrow (optional, Editorial-Pattern):**
- Kleine, gesperrte Caps-Zeile über dem `.card-title` für Kontext-Label (Buchname, Sektion, Rubrik), wenn der Titel selbst die Funktion benennt.
- Markup: `.card-eyebrow` als erstes Element in `.card-header-titlebar`, danach `.card-title`. Column-Flex sorgt für visuelle Order.
- Use-Case: Titel = Funktion ("Übersicht", "Statistik", "Lektorat"), Eyebrow = Subjekt (Buchname). Vermeidet redundante Titel-Strings vom Typ "Übersicht: {name}".
- CSS in [public/css/components/card-form.css](public/css/components/card-form/card-shell.css), Konsumenten setzen nur Markup.

```html
<div class="card-header">
  <div class="card-header-titlebar">
    <span class="card-eyebrow" x-text="$app.selectedBookName"></span>
    <span class="card-title" x-text="$app.t('overview.title')"></span>
  </div>
  <div class="card-actions">…</div>
</div>
```

**Header-Action-Buttons — Vorbild ist die Notebook-Seitenansicht-Toolbar (SSoT):** Die Aktions-Icons im Karten-Header folgen exakt dem Cluster der Einzelseiten-Ansicht ([public/partials/editor-notebook.html](public/partials/editor-notebook.html), `.card-actions--grouped`). Konkret:
- **Container:** `.card-actions` (Gap `--space-6`), bei ≥2 semantischen Bündeln `.card-actions--grouped` + `.action-sep`. **Nie** Buttons direkt in `.card-header-aside` setzen — dessen Gap (`--space-14`) ist für Status-/Token-Cluster gedacht und reisst die Icons sichtbar weiter auseinander als auf allen anderen Karten.
- **Button-Klasse:** `icon-btn icon-btn--ghost` (transparent bis Hover, einheitliche 28×28-Chips). **Nicht** der umrandete `.icon-btn` (default/outlined) für Header-Cluster.
- **Aktiver Toggle** (Panel offen, Fullscreen ein): `:class="{ 'is-active': … }"` + `:aria-pressed` — nicht eine eigene `.primary`/`.active`-Klasse.
- **Schliessen im Cluster:** liegt der Close-Button mit weiteren Aktionen in derselben `.card-actions`-Reihe, ist er ebenfalls `icon-btn icon-btn--ghost` mit `#x`-Sprite (nicht der abgesetzte `.btn-card-close`, der nur für den allein-stehenden, absolut positionierten Header-Close gilt — siehe [Action-Icon-Library](#action-icon-library-verbindlich) „Schliessen").
- **Close-Handler einer Hauptkarte: immer `@click="$app.closeCard('<key>')"`** (`<key>` = `EXCLUSIVE_CARDS`-Key), **nie** `$app.toggleXxxCard()`. Der Toggle deutet den zweiten Aufruf bei Karten mit `onReclick: 'refresh'` als Neuladen — das `x` würde dort nur die Liste refreshen und die Karte offen stehen lassen. `closeCard` ([app-view/cards.js](public/js/app/app-view/cards.js)) schliesst hart und landet danach auf der Buchübersicht, statt eine leere Spalte zu hinterlassen. Ausgenommen sind Karten neben dem Editor (Seiten-Chat, Ideen, Referenz — eigener Slot, kein Landing) und die Teilen-Karte (`closeShareLinks` kehrt zur Ausgangsansicht zurück).
- **Mobile (`≤700px`):** Header mit `.card-header-titlebar` bleibt eine **Zeile** — die Aktionen (`.card-actions` / `.card-header-aside`) bleiben oben rechts verankert, die Titelspalte schrumpft und der Titel bricht bei Bedarf um (nicht die Icons in eine eigene Zeile drücken). Geregelt zentral über `.card-header:has(.card-header-titlebar)` in [card-form.css](public/css/components/card-form/card-shell.css) — pro Karte nichts deklarieren. Reine Text-Button-Leisten **ohne** Titelspalte (`.card-header > .card-actions`, z.B. Export/Admin) sind ausgenommen und behalten den Full-Width-Stack.

Referenz-Cluster: [public/partials/recherche.html](public/partials/recherche.html) (Chat / Vollbild / Schliessen als Ghost-Trio).

---

## Karten-Innenraum

**Use:** alles, was INNERHALB einer `.card` liegt. `.card` selbst regelt Rahmen, Akzent und Kopfzeile ([Karten](#karten-card)) — hier steht, wie der Inhalt darunter organisiert ist. CSS: [components/card-form/card-blocks.css](public/css/components/card-form/card-blocks.css).

**Warum das ein Pattern ist und keine Geschmacksfrage:** Tokens allein erzeugen keine gleiche Organisation. Sie garantieren nur, dass ein *willkürlicher* Abstand aus einer Liste von 16 gewählt wird. Solange jeder Block seinen Abstand selbst mitbringt, ist der sichtbare Abstand zwischen zwei Blöcken die Summe zufällig kollidierender Eigenmargins — und er ändert sich, sobald ein Block dazwischenrutscht. Genau daran driftete es: 62 Hinweis-Klassen mit demselben Aussehen, 25 identische Kopfzeilen mit fünf verschiedenen Gaps, vier Toolbars mit vier verschiedenen Höhen unter demselben Header.

### Rhythmus: zwei Stufen, mehr nicht

| Token | Wert | Wofür |
|---|---|---|
| `--card-gap-section` | 16px (`--space-lg`) | zwischen zwei eigenständigen Blöcken |
| `--card-gap-tight` | 8px (`--space-sm`) | innerhalb eines Blocks (Titel → Inhalt, Balken → Statuszeile) |

Blöcke im Kartenkörper bekommen `.card-section`; den Abstand setzt der **Nachbar-Selektor**, nicht der Block:

```html
<div class="card card--motiv" x-data="motivCard">
  <div class="card-header">…</div>

  <div class="card-section">
    <div class="card-section-head">
      <h3 class="card-section-title">Motive</h3>
      <button class="btn-compact">Neu</button>
    </div>
    <p class="card-hint">Was hier steht und warum.</p>
  </div>

  <div class="card-section">…</div>
</div>
```

**Nachbar-Selektor (`+`), nicht `margin-bottom` + `:last-child`.** Die Blöcke hängen fast alle an `x-show`. Ein `display:none`-Element zählt für `:last-child` mit — der sichtbare Block davor behielte also seinen Abstand und die Karte bekäme einen Leerraum am Fuss. Beim Nachbar-Selektor trägt immer der **folgende sichtbare** Block den Abstand; ein ausgeblendeter Nachbar erzeugt keinen.

### Die Bausteine

| Klasse | Rolle | Modifier |
|---|---|---|
| `.card-section` | Block im Kartenkörper | `--tight` (enger Anschluss an den Block davor) |
| `.card-section-head` | Titel links, Aktionen/Zähler rechts | `--baseline` (Text gegen Text), `--flush` (kein Eigenabstand) |
| `.card-section-title` | gesperrte Caps-Zeile über dem Abschnitt | — |
| `.card-hint` | grauer Erklärsatz | `--sm` (12px), `--right`, `--warn`, `--lead` (Einleitung, 60ch) |
| `.card-status` | Lade-/Leer-/Fehlerzeile | `--error` |
| `.muted-msg` | gedämpfte Zustandsmeldung | `--sm`, `--block`, `--spaced` |
| `.progress-bar-wrap` + `.progress-bar` | Job-Fortschritt | — |
| `.filter-bar` | Listenfilter (siehe [Filter-Bar](#filter-bar-listenfilter)) | `--inline` |

**`.card-hint` vs. `.muted-msg`:** der Hinweis **erklärt** und steht dauerhaft unter seinem Element; die Meldung **berichtet einen Zustand** („keine Einträge", „zuletzt geprüft am …") und erscheint an der Stelle des fehlenden Inhalts.

**`.card-section-title` vs. `.section-heading`:** die Caps-Zeile ordnet ein (Rubrik, gesperrt, `--font-size-xs`), `.section-heading` ([analysis/analysis.css](public/css/analysis/analysis.css)) ist ein Serif-Zwischentitel im Fliesstext. Zwei Dinge, beide legitim — nicht zusammenlegen.

### Regeln

1. **Ein Hinweistext bringt keinen Abstand mit** (`margin: 0`). Der Abstand kommt aus dem Fluss. Wer einen `margin-bottom` an einen Hinweis schreibt, baut die Drift neu.
2. **Kein feature-eigener Nachbau.** `.motiv-hint`, `.xyz-section-head`, `.abc-intro` sind der Anti-Pattern-Name. Braucht die Karte eine Abweichung, trägt die Feature-Klasse **nur die Abweichung** neben der generischen — Muster: `.book-settings-section > .card-section-title { margin-bottom: var(--card-gap-section); }`, `.card-empty-hint { max-width: 32em; }`.
3. **Toolbars: eigene horizontale Geometrie ja, eigener vertikaler Abstand nein.** `.card-toolbar` ist der Regelfall; `.organizer-toolbar` (nowrap) und `.motiv-toolbar` (Gruppen) weichen horizontal ab, tragen aber dieselbe `--card-gap-section` nach unten und **keinen** Abstand nach oben — den liefert die Kopfzeile.
4. **Abstände kommen aus der Token-Skala**, nie als roher `rem`-/`px`-Wert. Gegated durch [tests/unit/spacing-scale.test.mjs](tests/unit/spacing-scale.test.mjs) (Ratsche mit Allowlist, Muster von `loc-limits`). `em` ist ausgenommen — es ist schriftgrössen-relativ und damit eine andere, bewusste Aussage.
5. **Ein globaler Klassenname hat einen eindeutigen Besitzer.** `.card-status`, `.muted-msg`, `.progress-bar*` und `.filter-bar*` leben in `card-blocks.css` — nicht in der Feature-Datei, die sie zufällig zuerst brauchte. Sonst hängt die Darstellung an der Ladereihenfolge zweier unbeteiligter Dateien (gleiche Begründung wie [status-msg.css](public/css/components/status-msg.css)).

---

## Combobox (Auswahlfeld)

**Use:** Jedes Auswahlfeld. Ersetzt natives `<select>`.

**Markup + Pflicht-Attribute** stehen in [CLAUDE.md](CLAUDE.md) (harte Regel „Combobox statt `<select>`"), weil Architektur (`x-data="combobox(...)"`, `x-modelable`, `x-effect`-Datenfluss) primär Alpine-Verhalten ist.

**Hier (visuelles):**

**Grösse muss mit umliegenden Form-Elementen matchen** — Combobox in Zeile mit `<input>`/`<button>` MUSS dieselbe Geometrie haben. Helper ist per Default **compact**; neben default-Input/Button → Object-Form `combobox({ placeholder, compact: false })`. Details + Compact-/Default-Sets siehe [Regel: Gleiche Höhe pro Form-Zeile](#regel-gleiche-höhe-pro-form-zeile). **Innerhalb `.card-form-row`** rendert auch eine compact-Combobox automatisch in Feldgrösse (volle Höhe + Surface-Hintergrund), damit sie zu den `<input>`-Feldern derselben Form passt — CSS-Override in `combobox.css`, kein Per-Call-Flag nötig.

**Mobile = am Trigger verankert wie Desktop** — das Dropdown öffnet auf allen Geräten direkt unter dem Trigger (x-anchor, Flip nach oben wenn unten kein Platz). Kein Bottom-Sheet, kein Backdrop — das Popup bleibt im Kontext des angetippten Felds. Auf Touch (`innerWidth <= 600` **oder** `(hover: none) and (pointer: coarse)` — letzteres erfasst Tablets/breite Phones) wird **nicht** auto-fokussiert: der Fokus würde die Bildschirm-Tastatur öffnen, deren `resize` das verankerte Popup verschöbe; die Liste ist auch ohne Fokus voll bedienbar (`_isMobile()` in `combobox.js` steuert nur diesen Auto-Fokus-Skip). Lange Labels wrappen auf `max-width: 600px` statt zu ellipsen, und das Suchfeld nutzt dort `font-size: 16px` (verhindert iOS-Zoom).

**Positionierung via x-anchor (Floating UI)** — das Popup wird über `x-anchor:bottom-start.fixed="$refs.cbTrigger"` am Trigger verankert (Desktop wie Mobile). `.fixed` = `position: fixed`-Strategie (entkommt overflow-clippenden Vorfahren), Flip nach oben passiert automatisch wenn unten kein Platz ist, und Floating UIs `autoUpdate` zieht das Popup bei Scroll **nach** (kein Close-on-Scroll mehr). Nur die Breite wird selbst gesetzt (`ddWidth`, = Trigger-Breite, min. 180px compact). Plugin: `vendor/alpine-anchor-3.15.12.min.js`, geladen vor dem Alpine-Core. **`.fixed` gibt es erst ab anchor 3.15.x** — ältere Builds hardcoden `position: absolute`. **Voraussetzung:** kein Vorfahr darf `transform`/`will-change`/`contain` tragen — das etabliert einen Containing-Block für das `position: fixed`-Popup, dessen viewport-relative Koordinaten dann falsch liegen (landet in der Karte statt am Trigger); `.card` nutzt darum `animation-fill-mode: backwards`, nicht `both`.

**Geometrie via `_rootEl`, nicht `this.$el`** — Combobox-Methoden, die zur Laufzeit aus dem `@click` des (selbst-gerenderten) Triggers laufen, dürfen NICHT `this.$el` benutzen: Alpine löst `$el` dort auf den Trigger-Button auf, nicht auf den Wrap. `init()` cacht `this._rootEl = this.$el` (init-Kontext = Wrap), alle Laufzeit-Methoden nutzen `_rootEl`. Siehe Memory „Alpine $el vs Root".

**Klassen** ([public/css/components/combobox.css](public/css/components/combobox.css)):
- `.combobox-wrap` — Wrapper, vom Helper auto-gesetzt (mit `--compact` per Default).
- `.combobox-trigger` — Button-Look (gleiche Höhe wie `<input>` über `--size-default-padding-y`).
- `.combobox-chevron` — Disclosure-Marker `▾`, rotiert via `.combobox-chevron--open` 0°→180°.
- `.combobox-dropdown` — Popover-Liste (`--sheet`-Modifier für Mobile-Bottom-Sheet; Flip nach oben macht x-anchor automatisch, keine eigene Klasse mehr).
- `.combobox-backdrop` — verdunkelter Hintergrund hinter dem Mobile-Sheet (Tap schliesst).
- `.combobox-search` — Input innerhalb Dropdown.
- `.combobox-option` / `.combobox-option--active` / `.combobox-empty`.
- `.combobox-option__label` / `.combobox-option__sub` — Label-Zeile + optionale gedämpfte Zweitzeile.

**Regel:** Wrapper-Div leer lassen (Helper überschreibt `innerHTML`). Pflicht-Pattern: `x-data="combobox(placeholder, emptyLabel?)" x-modelable="value" x-model="ref" x-effect="options = …"`.

**Optionale Zweitzeile:** Eine Option darf neben `{ value, label }` ein `sublabel` tragen (`{ value, label, sublabel }`). Die Combobox rendert es als gedämpfte zweite Zeile unter dem Label und bezieht es in die Such-Filterung mit ein. Fehlt `sublabel`, bleibt die Option einzeilig (rein additiv, alle bestehenden Comboboxen unverändert). Use-Case: Kontext zur Auswahl (z. B. Figuren-Import-Picker zeigt Hauptkapitel · Beruf · Jahrgang).

**Optionale Gruppen-Header:** Eine Option darf ein `group` tragen (`{ value, label, group }`). Die Combobox fügt vor dem ersten Element jeder Gruppe einen nicht auswählbaren Header (`.combobox-group`, `role="presentation"`) ein — die Optionen müssen dafür bereits **nach Gruppe sortiert** geliefert werden (gleiche Gruppe = zusammenhängend). Tastatur-Nav überspringt Header automatisch (`highlighted` indexiert weiter nur die Optionen). Eine Option darf in mehreren Gruppen erscheinen (gleicher `value`, unterschiedliche `group`) — Auswahl togglet den Wert überall. Fehlt `group` auf allen Optionen, rendert die Liste byte-gleich ohne Header (rein additiv). Kombinierbar mit `multiple: true` + `sublabel`. Use-Case: Beat-Edit-Figurenwahl gruppiert nach Kapitel (Kapitel → Figur A, Figur B).

### Catalog-Filter-Spezialisierung

Filter-Comboboxen in Katalog-Karten (Figuren/Orte/Szenen/Ereignisse/Songs/Kontinuität) nutzen den dünnen Wrapper `catalogFilter(kind)` aus [public/js/catalog-filter.js](public/js/catalog-filter.js). Erbt die volle Combobox-Mechanik via `comboboxData`-Factory und reicht nur Placeholder + Empty-Label per Filter-Typ rein. Spart pro Aufruf vier i18n-Lookups und zentralisiert die Label-Konvention.

`kind`-Werte: `figur`, `chapter`, `page`, `ort`, `szene`. Erweiterung (z. B. `tag`, `datum`): `FILTER_KINDS` in `catalog-filter.js` ergänzen + i18n-Keys `filter.<kind>` / `filter.all<Kind>s` in beiden Locales anlegen.

Pflicht-Pattern (gleiche 3 Attribute wie `combobox`, nur `x-data` schrumpft):

```html
<div x-data="catalogFilter('figur')"
     x-modelable="value" x-model="$app.szenenFilters.figurId"
     x-effect="options = $app.figuren.filter(...).map(...)"></div>
```

`@combobox-change`, `:class="{'combobox-wrap--disabled': _disabled}"` und alle weiteren Combobox-APIs funktionieren unverändert.

### Entity-Picker-Spezialisierung

Auswahl-Comboboxen für **Buch-Entitäten** (Figur/Kapitel/Werkstatt-Figur wählen, cascading Kategorie→Ziel) nutzen `entityPicker(spec)` aus [public/js/cards/entity-picker.js](public/js/cards/entity-picker.js). Im Unterschied zu `combobox`/`catalogFilter` baut die Komponente die Optionen **selbst** aus der Quelle — `options` ist ein reaktiver Getter, deshalb **kein `x-effect` im Konsumenten** (weniger Verdrahtung, eine SSoT für die Optionsbildung). Erbt die volle Combobox-Mechanik via `comboboxData`-Factory; ein interner Memo verhindert teure Rebuilds.

Use-Cases: Plot-Beat-/Strang-Editor (Figur/Werkstatt/Kapitel), Spannungsbogen-Fokus, Recherche-Link-Picker + -Filter (cascading Ziel), Figuren-Werkstatt-Import.

`entity`-Werte:
- `chapter` — Kapitel aus `$store.nav.tree` (global, keine weitere Config)
- `figur` — Katalog-Figuren aus `$store.catalog` (flach; `grouped: true` → nach Kapitel gruppiert, `noGroupLabel` für die „ohne Kapitel"-Gruppe)
- `werkstatt` — Werkstatt-/Draft-Figuren aus `items`-Thunk (karten-lokal)
- `target` — cascading: `items`-Map `[kind]` → `{id,label}` (Ziel-Optionen hängen reaktiv am Kategorie-Picker)
- `custom` — beliebige fertige Option-Liste aus `items`-Thunk (Mapping bleibt im Karten-Scope, z. B. encodierte `c:`/`w:`-Werte oder Sublabel)

Pflicht-Pattern (2 Attribute statt 3 — `x-effect` entfällt):

```html
<div x-data="entityPicker({ entity: 'chapter', placeholder: $app.t('…'), emptyLabel: $app.t('…') })"
     x-modelable="value" x-model="beatDraft.chapter_id"></div>

<div x-data="entityPicker({ entity: 'target', placeholder: $app.t('…'),
                            items: () => linkTargets, kind: () => linkPickerKind })"
     x-modelable="value" x-model="linkPickerTargetId"></div>
```

Karten-lokale Quellen (`werkstatt`/`target`/`custom`) bekommen Thunks (`items`/`kind`); deren Reads werden im Getter reaktiv getrackt — der Picker reagiert auf Änderungen ohne `x-effect`. Erweiterung (neue Entity-Quelle): `BUILDERS` in `entity-picker.js` ergänzen (Funktion liefert `{ deps, build }`). `@combobox-change`, `multiple`, `emptyLabel` und alle weiteren Combobox-APIs funktionieren unverändert. **Abgrenzung:** Enum-/Tag-/Sortier-Selektoren (feste Wertelisten) bleiben auf `combobox`, Katalog-Listen-Filter auf `catalogFilter` — `entityPicker` ist nur für die Auswahl konkreter Buch-Entitäten.

### Dropdown darf nicht geclippt werden

`.combobox-dropdown` ist via x-anchor `position: fixed` — entkommt damit overflow-clippenden Vorfahren (`overflow: hidden`/`clip`/`auto`/`scroll`), die ein normal positioniertes Popup abschneiden würden. Der frühere „kein `overflow` auf umschliessenden Containern"-Zwang ist damit weg.

**Verbleibende Regel:** Kein Vorfahr bis zur nächsten Card/Modal darf `transform`/`filter`/`will-change`/`contain`/`perspective`/`backdrop-filter` tragen — die etablieren einen Containing-Block, in dem `position: fixed` wie `absolute` wirkt und **doch wieder** vom Container geclippt wird. Das ist die einzige Falle, die bleibt (gilt auch für das Mobile-Sheet — siehe `.card`-`animation-fill-mode: backwards` oben).

Checkliste bei neuer Combobox-Platzierung:
- Vorfahren auf die o.g. Containing-Block-Properties prüfen (DevTools: Computed → Filter „transform"/„contain"/„will-change"). Reines `overflow` ist unkritisch.
- Trifft ein solcher Vorfahr zu und lässt sich die Property nicht entfernen: Combobox **ausserhalb** davon platzieren.

### Mobile + lange Labels (Viewport-Overflow)

`.combobox-wrap--compact .combobox-dropdown` setzt `right: auto; min-width: 180px;` (Desktop-Default, damit kleine Trigger trotzdem brauchbares Popover bekommen) und `.combobox-option { white-space: nowrap }`. Auf Mobile mit langen Option-Labels (Kapitel-/Figur-/Ort-/Szenen-Namen) bläst die Liste sich auf Content-Breite auf und schiebt den Dropdown über den rechten Viewport-Rand → Horizontal-Scroll.

**Global gelöst** in [public/css/components/combobox.css](public/css/components/combobox.css) (`@media (max-width: 600px)`):

- `.combobox-dropdown { max-width: calc(100vw - 16px) }` — Hard Cap gegen Viewport.
- `.combobox-wrap--compact .combobox-dropdown { left:0; right:0; min-width:0; max-width:100% }` — Dropdown bindet an Wrap-Breite, kein 180px-Minimum mehr.
- `.combobox-option { white-space: normal; overflow-wrap: anywhere }` — lange Labels wrappen statt zu überlaufen.

**Regel:** Keine per-Karte Mobile-Override mehr für Dropdown-Breite / Option-Wrap. Wer eine compact-Combobox in einer schmalen Mobile-Spalte nutzt, bekommt das Verhalten geschenkt. Falls eine Karte _absichtlich_ ein anderes Layout will (z. B. fixe Breite), das pro-Karte begründen und im Karten-CSS überschreiben — nicht im Combobox-Default.

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

**Pattern: `.tabs` / `.tabs-btn` / `.tabs-btn--active`** ([public/css/components/tabs.css](public/css/components/tabs.css)). Polished segmented: dezenter Tint statt Vollfarben-Active, 2px Akzentband am Unterkante, weiche Übergänge. Eckig.

**Horizontal scrollbar ist Basis-Verhalten** (nicht Modifier, nicht viewport-gegated): eine Reihe, die breiter ist als ihr Platz, scrollt statt zu clippen — auf **jeder** Breite. Der Scrollbalken selbst ist ausgeblendet (`scrollbar-width: none`), weil ein Gutter in einer ~27–34px hohen Reihe die Höhen-Invariante der `.filter-bar` bricht; die Scrollbarkeit zeigt stattdessen ein Rand-Schatten, der nur an der jeweils weggescrollten Seite erscheint (`background-attachment: local, scroll`-Trick). **Nicht** stattdessen einen Viewport-Breakpoint bauen: der Platzmangel entsteht an der Komponente (schmale Karte, Header-Flex-Item), nicht am Viewport.

**Komponente `Alpine.data('tabs')` (Pflicht für Tab+Panel-Sets)** ([public/js/tabs.js](public/js/tabs.js)) — SSoT für den aktiven Tab, die Umschalt-Logik und die WAI-ARIA-Tablist-Semantik (`role=tablist`/`tab`/`tabpanel`, `aria-selected`, Roving-Tabindex, Pfeil-Tastatur-Navigation). Analog combobox/numInput/sortableTable: kein hand-verdrahtetes `:class`/`@click`/`activeTab`/`setTab`/`isTab` mehr pro Karte. Die Komponente rendert die Buttons **nicht** selbst (Labels sind pro Karte unterschiedlich i18n-präfixiert, einzelne Tabs bedingt sichtbar) — sie liefert State + drei x-bind-Spreads. Wrapper umschliesst Button-Reihe **und** Panels:
```html
<div x-data="tabs(['layout','font','cover'])" x-modelable="value" x-model="activeTab">
  <div class="tabs tabs--scrollable" x-bind="tablist">
    <template x-for="tab in tabs" :key="tab">
      <button class="tabs-btn" x-bind="tabBtn(tab)" x-text="$app.t('xxx.tab.' + tab)"></button>
    </template>
  </div>
  <div class="xxx-tab-panel" x-bind="panel('layout')"> … </div>
  <div class="xxx-tab-panel" x-bind="panel('font')"> … </div>
</div>
```
- `x-modelable="value" x-model="ref"` koppelt den aktiven Tab ans Karten-Feld (bleibt SSoT für programmatisches Reset, z. B. `this.activeTab = 'layout'` auf `view:reset`). Default = Initialwert des Feldes.
- Config: positionales Array oder Object-Form `tabs({ tabs: [...], persistKey: 'xxx' })` (`persistKey` optional → aktiver Tab überlebt Reload via localStorage).
- Bedingte Tabs: Button behält eigenes `x-show`; `tabBtn(key)` daneben spreaden (Beispiel: book-settings sync-Tab nur für Buchtyp `blog`).
- Referenz: [public/partials/pdf-export.html](public/partials/pdf-export.html), [public/partials/epub-export.html](public/partials/epub-export.html), [public/partials/book-settings.html](public/partials/book-settings.html).

**Modus-Toggles / Filter-Tabs** (2-3 Optionen, die nur eine Ansicht filtern statt echte Panels umzuschalten — Fehler-Heatmap, Graph-Modus, Severity-Filter) bleiben mit inline `:class`/`@click`, kein `role=tablist`:
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

**Modifier `.tabs--scrollable`** macht die Reihe block-level, sodass sie die Container-Breite füllt statt auf Content-Breite zu schrumpfen (nützlich für Tab+Panel-Sets, damit die Reihe so breit wie das Panel darunter ist). Das Scrollen kommt aus der Basis — der Modifier entscheidet nur die Breite. Beispiel: PDF-Export-Tabs ([public/partials/pdf-export.html](public/partials/pdf-export.html)).

**Modifier `.tabs--fullwidth`** für Modus-Toggles, bei denen Buttons gleichberechtigt die volle Container-Breite teilen sollen (statt inline-flex zu Content-Breite). Beispiel: Figuren-Graph-Modus ([public/partials/figuren.html](public/partials/figuren.html)).

**Tab-Reihe im `.card-header`:** eine `.tabs` in der `.card-actions` bekommt auf Touch (≤700px) die **eigene, volle Zeile** ([card-form/card-shell.css](public/css/components/card-form/card-shell.css)) statt neben dem 55%-Floor der Titelspalte zu stehen. Als Scroll-Container ist ihre automatische Minimalbreite 0 — ohne die Ausnahme bleibt ein ~120px-Splitter, in dem ein halber Tab steht. Beispiele: Fehler-Heatmap, Redundanz.

**Tab-Panels brauchen eigenes Padding (Pflicht).** `.tabs` rendert nur die Button-Reihe — **kein** umschliessender Container/Box um die Panels. Der zugehörige Panel-Container sitzt deshalb sonst bündig an Tab-Reihe und Kartenrand. Der Panel-Container bekommt darum `padding: 1rem 0.875rem 0.75rem` (Top-Abstand zur Tab-Reihe + horizontaler Innenabstand). Die drei Export-Karten teilen sich dafür `.export-tab-panel` ([public/css/book/export-shared.css](public/css/book/export-shared.css)); Karten mit content-abhängigem Padding definieren weiterhin eine eigene `*-tab-panel`-Klasse in der Karten-CSS, nicht generisch in `tabs.css`.

---

## Badges & Tags

**Eckig** (`border-radius: var(--radius-sm)` oder `0`), nie pill-förmig oder rund.

**Generische Badges** [public/css/components/buttons-badges.css](public/css/components/buttons-badges.css):
- `.badge-ok` — grün, positive Info
- `.badge-warn` — amber, Warnung
- `.badge-err` — rot, Fehler
- `.badge-neutral` — grau, wertfreie Einordnung ohne Status-Aussage (Art/Kategorie eines Eintrags, z.B. Rechteumfang eines Geräte-Tokens). Nicht für Zustände — dafür sind die drei Status-Varianten da.
- `.btn-count` — Counter-Badge in Buttons

**Severity-Tags** [public/css/entities/entity-list.css:143](public/css/entities/entity-list.css#L143):
- `.severity-tag--kritisch` / `--stark` / `--mittel` / `--schwach` / `--niedrig`
- Verwendet für Lektorats-/Kontinuitäts-Schweregrade.

**Umfangs-Plakette** (`.tok-badge` in [public/css/tokens-est.css](public/css/tokens-est.css)):
- Zeigt den Umfang einer Seite bzw. eines Kapitels als Zeichenzahl (Sidebar-Baum, Notebook-Kopfleiste, Kapitelbewertung).
- **Beschriftung ausschliesslich ueber `charBadge(chars)`** (Root-Methode, [public/js/app/app-ui.js](public/js/app/app-ui.js), pure Funktion `charBadgeLabel` in [public/js/utils/format.js](public/js/utils/format.js)). Unter 1000 die genaue Zahl, darueber auf Tausender gerundet mit Tilde.
- **Die Einheit kommt aus der i18n** (`bookstats.unit.z` — de „Z", en „c"), nie als Literal im Template. Sonst steht in der englischen UI die Σ-Zeile auf „c" und die Plaketten darunter auf „Z".

**Hue-getriebener Badge** (`.palette-badge` in [public/css/layout/utilities.css](public/css/layout/utilities.css)):
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

**Absolut positionierter Button braucht eine eigene `:active`-Regel.** `button:active { transform: scale(0.98) }` ([components/buttons-badges.css](public/css/components/buttons-badges.css)) gilt global und **ersetzt** — nicht ergänzt — jeden eigenen `transform`. Ein mit `top: 50%; transform: translateY(-50%)` zentrierter Knopf verliert seine Zentrierung also genau im Moment des Drückens und springt um die halbe Höhe weg. Chromium hält den Klick dabei oft noch, Gecko liefert `mouseup` auf dem darunterliegenden Element ab: der `click` entsteht erst am gemeinsamen Vorfahren und der `@click`-Handler feuert **nie**.

```css
/* zentriert positionierter Button */
.mein-knopf        { position: absolute; top: 50%; transform: translateY(-50%); }
.mein-knopf:active { transform: translateY(-50%) scale(0.98); }   /* Pflicht */
```

Betrifft jeden Knopf mit eigenem `transform`. Wer den Druck-Effekt gar nicht will, setzt `:active { transform: none; }` (so lösen es `.combobox-trigger`, `.palette-item`, `.palette-hero`, `.figur-lookup-link`).

---

## Action-Icon-Library (verbindlich)

**Use:** Das **verbindliche** Vokabular für Aktions-Buttons der ganzen App. Jedes neue Frontend-Feature nutzt es — keine parallelen Button-Erfindungen. Ziel: eine einheitliche, „echte App"-Frontend-Erfahrung. Gegated durch [tests/unit/button-icons.test.mjs](tests/unit/button-icons.test.mjs) (läuft in `npm run test:unit`).

**Die Bausteine** (alle weiter unten im Detail dokumentiert):
- [Icon-System](#icon-system-lucide-sprite) — Lucide-Sprite `<svg class="icon"><use href="/icons.svg#name"/></svg>`. **Einzige** Icon-Quelle.
- [Icon-Button](#icon-button-icon-btn) — `.icon-btn` (outlined) / `.icon-btn--ghost` (transparent bis Hover) für Icon-only-Aktionen. `.icon-btn--success` (grüner Bestätigungs-Akzent).
- [Icon-Button-Count-Badge](#icon-button-count-badge-icon-btn-badge) — Zähler oben rechts (`.icon-btn-badge`); Achtungs-Punkt ohne Zahl via `.icon-btn--attention`.
- [Toolbar-Action-Group](#toolbar-action-group-segmentierter-icon-cluster-neben-form-feldern) — segmentierte Icon-Reihe.
- [Context-Menu → Dropdown-Variante](#context-menu-rechtsklick-popover) — `⋯`-Overflow (`.context-menu--dropdown`) für sekundäre Aktionen, Einträge mit `.context-menu-item--icon`.
- [Sofort-Tooltip](#sofort-tooltip-data-tip--default-variante) — `data-tip` (Pflicht bei Icon-only) + `aria-label`.

**Regeln (verbindlich):**
- **Icon-only** für: Toolbars, Header-Action-Cluster (`.card-actions`), Editoren, Close, Inline-Item-Aktionen (Löschen/Entfernen), Toasts. Pflicht: `data-tip` **und** `aria-label` (Label lebt im Tooltip).
- **Icon + Label** behalten: primäre Formular-Aktionen im Footer/Settings (z.B. „Speichern"), prominente nav-Buttons mit Text (Revisions Vor/Zurück). Label = Klarheit + A11y. Konsistenz kommt hier aus dem [Button-System](#buttons), nicht aus Icon-only.
- **Schliessen = immer `x`** (Sprite), nie `×`/`&#x2715;`/Text-„Schliessen". Siehe Icon-Liste unten.
- **Destruktiv** (Löschen) = `trash`; **Entfernen/Chip/Dismiss** = `x`. Andere Semantik als Schliessen.
- **Bündel-Trenner = `.action-sep`** (siehe [Aktions-Trennstrich](#aktions-trennstrich-action-sep--ssot-für-gebündelte-aktionsreihen)). Zerfällt eine Icon-Aktionsreihe semantisch (z.B. „Form bestätigen/abbrechen" ↔ „Datensatz verwerfen/löschen"), trennt **ausschliesslich** `<span class="action-sep" aria-hidden="true">` die Bündel — nie ein `border`-Hack oder `<hr>` pro Feature.
- **Einheitliche Glyph-Grösse** für Icon-only Action-/Close-Buttons: `<svg.icon>` ist per Default `1em`, würde also mit der font-size jedes Buttons driften (Card-Close 18px, Toast 16px, Find 15px …). Darum normalisiert [components/icon-btn.css](public/css/components/icon-btn.css) die Glyph-Grösse aller Icon-only Action-/Close-Buttons auf `var(--icon-size-action)` (Token in [tokens/typography.css](public/css/tokens/typography.css)) — desktop wie mobil (wo der Tap-Target auf 40px wächst, das Glyph aber gleich bleibt). Neuer Icon-only Close-/Action-Button → in die Selektor-Liste dort aufnehmen. Invariante (coarse-Tap-Target-Set ⊆ Glyph-Norm-Set) gegatet durch [tests/unit/icon-size-consistency.test.mjs](tests/unit/icon-size-consistency.test.mjs).
- **Reaktive Icons** via `<use :href="…">`, nie `x-text` (killt das SVG).
- **Verboten:** Unicode-Glyphen als Icon-Inhalt eines Buttons (`× ✕ ↑ ↓ ← → ⤢ ⛶ …`). Ausnahme nur als visuell versteckter Fallback in `.history-chevron`-SPANs (kein Button).
- **Neue Aktion** → erst Icon-Map (Icon-System + Icon-Button) prüfen/erweitern, Sprite-Symbol in [public/icons.svg](public/icons.svg) ergänzen, `SHELL_CACHE` bumpen.

**Guard-Test** ([tests/unit/button-icons.test.mjs](tests/unit/button-icons.test.mjs)) prüft über alle `public/partials/*.html` + `index.html`: (1) kein Button hat eine Unicode-Glyphe als Icon-Inhalt; (2) jeder `.icon-btn` enthält ein `<svg class="icon"><use…>`; (3) jeder Button in einer `.card-actions`-Leiste ist ein Icon-Button **oder** trägt `data-label-ok` (= bewusst beschriftete primäre Aktion wie Speichern/Export/Abbrechen). `.tabs-btn` (Modus-Toggle) und `admin-*`-Partials (internes Tooling, label-lastige Konvention) sind von (3) ausgenommen. Neuer „klassischer" Button → CI rot.

---

## Icon-System (Lucide-Sprite)

**Use:** Single Source of Truth für alle UI-Icons. Lucide-Icon-Set (ISC, [lucide.dev](https://lucide.dev)) als statischer SVG-Sprite. Keine Unicode-Glyphen als Icons mehr.

**Sprite:** [public/icons.svg](public/icons.svg) — `<symbol id="…" viewBox="0 0 24 24">` pro Icon. Stroke/Fill werden NICHT auf den Pfaden gesetzt; sie erben über die `.icon`-CSS-Klasse (Shadow-DOM-Cascade).

**CSS:** [public/css/components/icons.css](public/css/components/icons.css). Klasse `.icon` setzt `width/height: 1em`, `fill: none`, `stroke: currentColor`, `stroke-width: 2`, `stroke-linecap/linejoin: round`, `vertical-align: -0.125em`, `pointer-events: none`. Skaliert automatisch über `font-size` des Parents.

**Markup (statisches Icon):**
```html
<svg class="icon" aria-hidden="true">
  <use href="/icons.svg#chevron-right"/>
</svg>
```

**Markup (reaktives Icon mit Alpine):**
```html
<svg class="icon" aria-hidden="true">
  <use :href="isOpen ? '/icons.svg#chevron-up' : '/icons.svg#chevron-down'"/>
</svg>
```

Niemals `x-text` für Icon-Buttons mit zwei Zuständen — `x-text` setzt `textContent` und killt das SVG. Stattdessen `<use :href="…">` reaktiv binden, oder zwei `<template x-if>`-Branches.

**Verfügbare Icons (Stand v1, Lucide-Namen):**
- Chevrons / Arrows: `chevron-left/right/up/down`, `arrow-left/right/up/down`
- Aktionen: `check`, `x`, `plus`, `minus`, `pencil`, `trash`, `search`, `play`, `undo`, `redo`, `rotate-cw` (Analysieren/Neu-Ausführen), `more-horizontal` (⋯-Overflow-/Status-Menü), `pin` (Anheften), `archive` (Archivieren), `image` (Bild)
- Status: `circle`, `alert-triangle`, `loader`
- Viewport: `maximize`, `maximize-2`, `minimize-2`, `scan`
- Editor: `separator-horizontal` (Trennlinie), `move-horizontal` (Fit-Width), `pilcrow` (Steuerzeichen), `heading` (Titel-Kopf des Beitrags ein-/ausblenden — nur publizistische Bücher)
- Seiten-Actions: `spell-check` (Lektorat/Prüfen), `pencil` (Bearbeiten), `maximize` (Fokus-Editor), `message-square` (Seiten-Chat), `lightbulb` (Ideen), `share-2` (Seite teilen)
- Sidebar / Navigation: `rotate-cw` (Seiten neu laden), `list-tree` (Buch organisieren), `download` (Export), `book-open` (Seite öffnen)
- Clients: `laptop-minimal` (macOS-App), `smartphone` (Android-App), `puzzle` (Chrome-Erweiterung) — je einmal pro Client und Oberfläche: im CTA-Button der Landing-Client-Sektion und im Zeilen-Kopf der Profil-Download-Zeile. Die Landing lädt dafür `css/components/icons.css` mit (pre-auth erlaubt über den `/css/`-Prefix, Sprite über `/icons.svg` in `PUBLIC_ASSETS`).
- **Schliessen: immer `x`** (Lucide) — alle Karten-/Panel-/Overlay-Close-Buttons rendern das `x`-Sprite-Icon, nie ein `×`/`&#x2715;`-Glyph oder ein Text-„Schliessen". Basis ist das Primitive **`.btn-close`** ([components/btn-close.css](public/css/components/btn-close.css)): es trägt den invarianten Kern (randlose Fläche, `inline-flex`-Zentrierung, Ruhefarbe, Hover), die Varianz läuft über `--close-size` / `--close-pad` / `--close-color`. Adoptiert: `.figur-lookup-close`, `.synonym-picker-close`. Noch mit eigener Vollkopie und **bei Berührung nachzuziehen**: `.btn-card-close`, `.edit-find-close`, `.book-editor-find-close`, `.entity-popover-close`, `.heatmap-detail-close`, `.job-toast-close`, `.revision-viewer__close`, `.shortcuts-close` — beim Umstellen den dort bestehenden `font-size`/`padding`-Wert als `--close-size`/`--close-pad` mitnehmen, nicht auf den Default vereinheitlichen. Destruktives Entfernen (Chips, Session/Seite/Kapitel löschen) ist **kein** Schliessen — eigene Semantik.

Neuer Bedarf → Lucide-SVG von [lucide.dev](https://lucide.dev) als `<symbol>` in `public/icons.svg` ergänzen. Der Shell-Cache zieht über den Content-Hash automatisch nach (`npm run sw:manifest`, siehe CLAUDE.md „Shell-Cache: kein manueller Bump") — nichts hochzuzählen.

**Mask-Variante für CSS-Pseudo-Elements:** Wo Icons aus CSS-Pseudo gerendert werden (rotierende Disclosure-Marker, `.history-chevron`, `.card-form-saved::before`), gibt es vorgehaltene `--icon-…`-Custom-Properties in `:root` (siehe `icons.css`). Konsumiert via:
```css
.my-thing::before {
  content: '';
  display: inline-block;
  width: 1em; height: 1em;
  background-color: currentColor;
  -webkit-mask: var(--icon-chevron-right) center / contain no-repeat;
          mask: var(--icon-chevron-right) center / contain no-repeat;
}
```
Mehr Masken in `:root` ergänzen, sobald sie ein zweites Mal gebraucht werden (Lucide-Pfad als URL-encoded SVG data-URL eintragen).

**Erlaubte Unicode-Ausnahmen (keine Icons im engeren Sinn):**
- Repetitions-Indikatoren (z.B. `↑↑↑` als Intensität-Skala für Machtverhältnis in Figuren-Beziehungen) — Icons als Sequenz wären visuell muddled.
- Mathematische / typografische Zeichen im Fliesstext (`∑`, `·`, `–`) — kein Icon-Charakter.
- Fallback-Glyphen in Chevron-Spans (`›`) bleiben markup-seitig als Fallback bei CSS-disabled (visuell ausgeblendet via `text-indent: 100%`).

**Regeln:**
- **Keine Icon-Bibliothek per `<script>`** (Lucide-JS oder Heroicons via NPM-Build) — Sprite-Approach reicht, kein JS-Overhead, kein Build-Step.
- **`fill="none"` / `stroke="currentColor"` nicht auf `<symbol>` setzen** — Shadow-DOM-Vererbung greift nur, wenn die Properties am konsumierenden `<svg>` (via `.icon`-Klasse) liegen. Pfade bleiben attributfrei.
- **`aria-hidden="true"` an jedem dekorativen Icon-SVG** — bei Icon-only-Buttons immer auch `aria-label` am Button (nicht am SVG).
- **Hex-Farbe / inline-stroke**: nicht setzen. Farbe steuert das CSS-Parent über `color: …`.
- **`width: 1em`**-Default heisst: Icon-Grösse folgt Parent-`font-size`. Will man fixe 18px: `style="font-size:18px"` am SVG oder `.icon--md`.

---

## Icon-Button (`.icon-btn`)

**Use:** Generischer quadratischer Button für ein einzelnes Sprite-Icon — **SSoT für alle Icon-only Buttons der App**, nicht pro Feature neu erfinden. Zwei Varianten:
- **Default (`.icon-btn`)** — *outlined*: sichtbarer Rahmen + Flächenfüllung. Erste Wahl für Canvas-/Viewport-Toolbars (Figuren-Graph via vis-network, Figur-Werkstatt-Mindmap via jsMind) und für die Action-Group-Variante (Buchorganizer/Sidebar, siehe unten).
- **Ghost (`.icon-btn icon-btn--ghost`)** — transparent bis Hover. Für dichte Cluster ohne Rahmen-Rauschen: Header-Action-Cluster (Status-`⋯`-Trigger) und Plot-Board-Spaltenaktionen. Aktiver Zustand via `.is-active` oder `:aria-pressed`.

Kontext-Anpassungen (feste Grösse, Segment-Look, kompaktere Variante) laufen über eine Scoping-Klasse `.<feature>-icon-btn` bzw. `.<wrapper> .icon-btn` — nicht über eine parallele Basis-Klasse. Icons kommen aus dem [Lucide-Sprite](#icon-system-lucide-sprite).

**Markup (Overlay-Variante, oben rechts in Canvas-Ecke):**
```html
<div class="<viewer>-canvas" style="position: relative">
  <div class="…-mindmap-controls …-mindmap-controls--overlay">
    <button type="button" class="icon-btn"
            :data-tip="$app.t('graph.zoomIn')" :aria-label="$app.t('graph.zoomIn')"
            @click="…zoomIn()">
      <svg class="icon" aria-hidden="true"><use href="/icons.svg#plus"/></svg>
    </button>
    <button type="button" class="icon-btn"
            :data-tip="$app.t('graph.zoomOut')" :aria-label="$app.t('graph.zoomOut')"
            @click="…zoomOut()">
      <svg class="icon" aria-hidden="true"><use href="/icons.svg#minus"/></svg>
    </button>
    <button type="button" class="icon-btn"
            :data-tip="$app.t('graph.reset')" :aria-label="$app.t('graph.reset')"
            @click="…fit()">
      <svg class="icon" aria-hidden="true"><use href="/icons.svg#scan"/></svg>
    </button>
    <button type="button" class="icon-btn"
            :aria-pressed="fullscreen"
            :data-tip="fullscreen ? $app.t('graph.fullscreenClose') : $app.t('graph.fullscreen')"
            :aria-label="fullscreen ? $app.t('graph.fullscreenClose') : $app.t('graph.fullscreen')"
            @click="toggleFullscreen()">
      <svg class="icon" aria-hidden="true">
        <use :href="fullscreen ? '/icons.svg#minimize-2' : '/icons.svg#maximize-2'"/>
      </svg>
    </button>
  </div>
</div>
```

**Markup (Inline-Variante, unter Canvas — Legende links, Zoom-Cluster rechts):**
```html
<div class="figuren-graph-toolbar">
  <span class="card-status">…Legende…</span>
  <div class="figuren-graph-toolbar-zoom">
    <button class="icon-btn"><svg class="icon"><use href="/icons.svg#plus"/></svg></button>
    …
  </div>
</div>
```

**Icon-Map (Pflicht-Vokabular pro Aktion):**

| Aktion | Lucide-Icon | Hinweis |
|--------|-------------|---------|
| Zoom in | `plus` | — |
| Zoom out | `minus` | — |
| Reset / Fit-to-View | `scan` | Vier Ecken-Klammern, viewport-semantisch |
| Fullscreen öffnen | `maximize-2` | Diagonale Pfeile auswärts |
| Fullscreen schliessen | `minimize-2` | Diagonale Pfeile einwärts |
| Undo / Redo | `undo` / `redo` | Action-Group-Variante (siehe unten) |
| Expand-all / Collapse-all | `chevron-down` / `chevron-up` | Action-Group-Variante |

Neue Aktionen erweitern diese Tabelle und das Sprite (siehe [Icon-System](#icon-system-lucide-sprite)).

**Klassen** (Basis in [public/css/components/icon-btn.css](public/css/components/icon-btn.css), Overlay-Modifier in [public/css/entities/figur-werkstatt.css](public/css/entities/figur-werkstatt.css)):
- `.icon-btn` — quadratischer Icon-Button (28px min, `--radius-sm`, `--border-thin` solid `--color-border`, `--color-muted` Text, Hover-Tint via `--color-surface`). Innenliegendes `<svg.icon>` zentriert sich automatisch (`line-height: 1`).
- `.icon-btn--ghost` — Ghost-Variante: `display: inline-flex` zentriert, 28×28 fix, transparent (Rahmen + Fläche), `font-size-base`. Hover/`.is-active`/`[aria-pressed="true"]` blenden `--color-surface`-Fläche + `--color-border`-Rahmen ein; `:disabled` → `opacity: 0.3`. Feature-Marker (`.plot-icon-btn` o.ä.) setzen darauf nur ihre Deltas (Grösse, Hover-Tint, Icon-Grösse).
- `.icon-btn--reset` — Legacy-Override für mehrzeichige Glyphen; mit SVG-Icons nicht mehr nötig (kann beim nächsten Refactor entfernt werden).
- `.icon-btn[aria-pressed="true"]` — aktiver Toggle (Fullscreen ein): `--color-history-active-bg` Hintergrund, `--color-primary` Border + Text. Greift automatisch — Konsument setzt nur `:aria-pressed`.
- `.stt-dock-btn.is-recording[aria-pressed="true"]` — Recording-State der STT-Diktat-Taste (Notebook-Editor): roter Akzent aus den Fehler-Tokens (`--color-err-border` für Rand/Füllung, `--color-err-text` für die Schrift) + pulsierender `box-shadow` via `@keyframes sttRecPulse` (1.4s; das Abschalten bei `prefers-reduced-motion` kommt aus [components/floating-dock.css](public/css/components/floating-dock.css)). `.is-pending` = `opacity: 0.6` während getUserMedia läuft. Übersteuert den generischen `aria-pressed`-Highlight. Grundform der Taste: `.dock-btn`; CSS des Zustands in [public/css/page/stt-dock.css](public/css/page/stt-dock.css). Verwendung nur Notebook-STT.
- `.tts-dock` / `.tts-dock-btn` / `.tts-status` — Proof-Listening-Vorlese-Dock (Notebook-Editor), schwebend unten **links** im Edit-Feld (Schwester zum `.stt-dock` unten rechts; gleiche sticky/floating-Mechanik, gespiegelte Ecke → nie kollidierend). `.tts-dock-btn` ist der runde Haupttaster (Kopfhörer→Pause→Play), `.tts-dock-btn--sub` die kleineren Skip/Stop-Taster, `.tts-status` die Fortschritts-Pille. `.tts-dock-btn.is-reading[aria-pressed="true"]` = akzentfarbener Puls via `@keyframes ttsReadPulse` (1.8s, `prefers-reduced-motion` aus). CSS in [public/css/page/tts-dock.css](public/css/page/tts-dock.css). Der gerade vorgelesene Satz wird via `::highlight(tts-sentence)` (CSS Custom Highlight, keine DOM-Mutation) akzentfarben markiert.
- `.figuren-graph-toolbar` — Inline-Wrapper: `display: flex; justify-content: space-between; gap: --space-sm`, oberhalb/unterhalb der Canvas.
- `.figuren-graph-toolbar-zoom` — Button-Cluster mit `gap: --space-xs`, `flex-shrink: 0`.
- `.<viewer>-mindmap-controls--overlay` — Overlay-Wrapper: `position: absolute; top: 8px; right: 8px`, `--color-surface` 88% mit `backdrop-filter: blur(4px)`, `--border-thin` + `--radius-sm` + `--shadow-sm`, `z-index: --z-sticky`. Parent muss `position: relative`.

**Regeln:**
- **Kein eigenes Button-Vokabular pro Feature.** Neuer Icon-only Button (Viewer, Header, Board, Toolbar) → `.icon-btn` (+ ggf. `--ghost`) wiederverwenden, kontext-spezifisches via Scoping-Klasse `.<feature>-icon-btn`. Kein paralleles `.figuren-zoom-btn` / `.header-icon-btn` / `.btn-icon` o.ä. neu anlegen.
- **Icons aus Sprite, nicht Unicode.** `<svg class="icon"><use href="/icons.svg#name"/></svg>` ist Pflicht. Unicode-Glyphen (`+`, `−`, `⤢`, `⛶`, `✕`) im Button-Markup sind seit Lucide-Migration verboten — Icon-Map oben ist der Index.
- **Toggle-Icons via `<use :href="…">`** (reaktiv), nicht via `x-text` — `x-text` ersetzt den SVG-Inhalt.
- **Tooltip Pflicht** über `data-tip` (sofort-Hover, siehe [Sofort-Tooltip](#sofort-tooltip-data-tip--default-variante)), `aria-label` zusätzlich für Screen-Reader.
- **Overlay-Position** nicht ohne Grund verschieben — oben-rechts ist konsistent über Figuren-Graph (Inline) + Werkstatt (Overlay).
- **Klassen-Präfix** `icon-btn` — das Pattern teilt sich Vokabular über alle Features (Graph, Header, Board, Toolbar). Nicht in `toolbar-btn`/`*-icon-btn`-Basis o.ä. umbenennen oder forken.

**Beispiele:** [public/partials/figuren.html:86-100](public/partials/figuren.html#L86), [public/partials/figur-werkstatt.html:210-233](public/partials/figur-werkstatt.html#L210).

---

## Toolbar-Action-Group (segmentierter Icon-Cluster neben Form-Feldern)

**Use:** Reihe von 2–5 Icon-Aktionen, **vertikal exakt mit Suchfeld + Combobox in derselben Toolbar bündig**. Eingesetzt im Buchorganizer (Undo/Redo/Expand-all/Collapse-all neben Such-Input + Sprung-Combobox) und in der Sidebar (Expand-all/Collapse-all neben Page-Search). Unterscheidet sich vom Canvas-Pattern oben dadurch, dass die Buttons **als Segment** zusammenstehen (geteilte Border, gerundete Aussenseiten) und an die Höhe ihrer Toolbar-Nachbarn gekoppelt sind.

**Markup:** (Icons aus [Lucide-Sprite](#icon-system-lucide-sprite))
```html
<div class="<feature>-toolbar">
  <input type="text" class="page-search" x-model="search" :placeholder="…">
  <div class="btn-group <feature>-action-group">
    <button type="button" class="icon-btn"
            @click="undo()" :data-tip="…" :aria-label="…">
      <svg class="icon" aria-hidden="true"><use href="/icons.svg#undo"/></svg>
    </button>
    <button type="button" class="icon-btn"
            @click="redo()" :data-tip="…" :aria-label="…">
      <svg class="icon" aria-hidden="true"><use href="/icons.svg#redo"/></svg>
    </button>
    <button type="button" class="icon-btn"
            @click="expandAll()" :data-tip="…" :aria-label="…">
      <svg class="icon" aria-hidden="true"><use href="/icons.svg#chevron-down"/></svg>
    </button>
    <button type="button" class="icon-btn"
            @click="collapseAll()" :data-tip="…" :aria-label="…">
      <svg class="icon" aria-hidden="true"><use href="/icons.svg#chevron-up"/></svg>
    </button>
  </div>
  <div class="<feature>-jump"
       x-data="combobox($app.t('…'))" x-modelable="value" x-model="jumpId"
       x-effect="options = …" @combobox-change="…"></div>
</div>
```

**CSS (Beispiel aus [public/css/book/buchorganizer.css](public/css/book/buchorganizer.css)):**
```css
.<feature>-toolbar {
  display: flex;
  align-items: stretch;          /* Pflicht — sonst stretcht Action-Group nicht */
  gap: var(--space-sm);
  flex-wrap: nowrap;
}
.<feature>-toolbar .page-search {
  flex: 1 1 0; min-width: 120px;
  height: 34px; padding: 0 10px; box-sizing: border-box;
}
.<feature>-jump { flex: 0 1 220px; min-width: 140px; }
.<feature>-jump .combobox-trigger {
  height: 34px; padding-block: 0; box-sizing: border-box;
}
.<feature>-action-group {
  display: inline-flex;
  align-items: stretch;
  gap: 0;                        /* Segment-Look: keine Lücke zwischen Buttons */
  flex-shrink: 0;
}
.<feature>-action-group .icon-btn {
  width: 34px; height: 34px;
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 0; padding: 0;
  font-size: var(--font-size-base); /* steuert SVG-Grösse (1em im .icon) */
  line-height: 1; box-sizing: border-box;
  border-radius: 0;
}
.<feature>-action-group .icon-btn:first-child {
  border-top-left-radius: var(--radius-md);
  border-bottom-left-radius: var(--radius-md);
}
.<feature>-action-group .icon-btn:last-child {
  border-top-right-radius: var(--radius-md);
  border-bottom-right-radius: var(--radius-md);
}
.<feature>-action-group .icon-btn + .icon-btn {
  border-left-width: 0;          /* doppelte Border vermeiden */
}
```

**Regeln:**
- **Vertikal-Alignment Pflicht:** Toolbar IMMER `align-items: stretch` und Nachbar-Elemente (Input, Combobox-Trigger, Buttons) auf **gleiche fixe Höhe** (`34px`-Standard). Ohne stretch + fixe Höhe ergeben Padding-Differenzen schräge Auslinierungen — der häufigste Bug bei diesem Pattern.
- **Combobox-Trigger anpassen:** `.combobox-trigger` hat Eigenpadding via `--size-compact-padding`. In der Toolbar mit `height: 34px; padding-block: 0;` override, sonst überragt der Trigger die Action-Group. Wrapper-Div bleibt leer (Helper überschreibt `innerHTML`).
- **Segment-Style statt Gap:** Buttons rücken aneinander (`gap: 0` auf Action-Group, `border-left-width: 0` auf Folge-Buttons). Aussenseiten gerundet via `:first-child` / `:last-child`. Liest sich als zusammengehörige Gruppe. Wer Lücke statt Segment will: anderes Pattern verwenden (z.B. `card-actions`).
- **Scoping über den Wrapper, kein Per-Button-Marker.** Buttons tragen nur `class="icon-btn"`; die Kontext-Overrides hängen an `.<feature>-action-group .icon-btn` (siehe CSS oben). **Kein** zusätzliches `.<feature>-icon-btn` am Button — eine inerte Marker-Klasse ohne eigene Regel führt nur in die Irre.
- **Icons aus Sprite, kein Glyph-Wrapper mehr.** `<svg class="icon"><use href="/icons.svg#name"/></svg>` direkt im Button. `.icon` (1em-Quadrat) zentriert sich via Button-Flex automatisch — keine `font-size: 0`-Tricks, kein `<span class="…-icon">`-Wrapper, keine Font-Metrik-Wackelei. Icon-Map siehe [Icon-Button](#icon-button-icon-btn).
- **Disabled-State** via `:disabled` (z.B. Undo bei leerem Stack). Greift automatisch durch `.icon-btn`-Default-Styling.
- **Mobile:** Im `@media (max-width: 600px)`-Block Toolbar zu `flex-direction: column; align-items: stretch` drehen; Search + Combobox auf `width: 100%`. Action-Group bleibt horizontal (segmentierte Reihe), nimmt eigene Zeile ein.

**Beispiele:** [public/partials/buchorganizer.html:16-50](public/partials/buchorganizer.html#L16) (4 Buttons + Search + Combobox), [public/partials/sidebar.html:11-22](public/partials/sidebar.html#L11) (2 Buttons neben Search, kein Combobox).

---

## Form-Patterns (Settings- und Export-Karten)

**Use:** Karten mit Eingabefeldern in Label-Wert-Anordnung (book-settings, user-settings, finetune-export, …). Eine **gemeinsame** Geometrie über alle Karten — kein paralleles Klassen-Vokabular pro Karte.

### Grid (Label links, Wert rechts)

`.card-form-grid` / `.card-form-row` / `.card-form-label` (CSS in [public/css/components/card-form.css](public/css/components/card-form/form-elements.css), 170 px-Label-Spalte). Modifier `.card-form-row--top` für oben-ausgerichtete Rows mit Textareas, `.card-form-row--full` für labellose Voll-Breite-Blöcke (Danger-Zone, Fusszeilen-Notiz) — ohne ihn landet der Inhalt in der 170 px-Label-Spalte und läuft über deren Rand hinaus.

```html
<div class="card-form-grid">
  <div class="card-form-row">
    <label class="card-form-label" x-text="…"></label>
    <div class="form-stack">…</div>
  </div>
</div>
```

### Wertspalten-Bausteine (CSS in [public/css/components/card-form.css](public/css/components/card-form/form-elements.css))

| Klasse | Verwendung |
|--------|------------|
| `.form-stack` | flex-column gap 10 — vertikale Liste (mehrere Checks oder Sub-Gruppen) |
| `.form-inline` | flex-row gap 20 wrap — Inline-Felder nebeneinander (z.B. Min/Max) |
| `.form-radio-group` / `.form-radio-option` | horizontale, umbrechende Radio-Gruppe — selbst-gerendert via `radioGroup` (siehe „Radio-Gruppe" unten), nicht handgeschrieben |
| `.form-inline-field` | Wrapper aus Label + Input (`<label><span/><input/></label>`) |
| `.form-num` | numerischer Input, 90 px breit, kompakt — paart mit `.form-inline-field` |
| `.form-check` | Grid 18 px-Checkbox + Title-Desc-Stack |
| `.form-check-title` | bold Titel der Check-Option |
| `.form-check-desc` | mittlerer Erklaerungstext (12 px, muted) |
| `.form-lead` | Intro-Paragraph unter `.card-header`, oberhalb der Form |
| `.form-section` | Wrapper unter dem Form-Output (Trennstrich + 14 px Abstand) |
| `.form-stats` | flex-wrap gap 8 — Reihe aus `.tok-badge`-Stats |
| `.form-size-hint` | sekundärer Inline-Hinweis im Button (z.B. Dateigröße) |
| `.card-form-input` | explizite Basisklasse für Text-Felder — teilt die Geometrie der `input[type=…]`-Elementregel (1px-Border, `--radius-md`). Nutzen, wenn ein Feld die Optik per Klasse statt über den Element-Selektor tragen soll |
| `.card-form-textarea` | volle Breite, vertikal resizable; gleiche 1px-Feldborder + `--radius-md` wie Inputs |

**Feld-Geometrie:** volle Form-Felder (Text-Inputs, default-Combobox, Textarea) tragen **1px**-Border (`--color-border-input`) + `--radius-md`. **Compact**-Controls (Filter-Bars, dichte Toolbars, `.combobox-wrap--compact`) bleiben auf **0.5px**-Hairline — innerhalb `.card-form-row` zieht ein Override compact-Comboboxen aber wieder auf 1px (Feldgrösse). Neben vollen Feldern (Settings-Form) Comboboxen mit `compact: false` rendern. Disabled-State (`--opacity-hint` + `not-allowed`) ist global über alle Feldtypen gesetzt. **Kein natives `<select>`** — Combobox-Pflicht.

### Section-Trenner innerhalb des Forms

`.card-form-section-divider` — `<p>`-Tag mit Border-Top + erklärendem Text, trennt logische Form-Sektionen (Beispiel: AI-Augmentierung in finetune-export).

### Radio-Gruppe (`radioGroup`)

**Regel:** Radio-Auswahlen nutzen ausschliesslich `Alpine.data('radioGroup')` aus [public/js/radio-group.js](public/js/radio-group.js). **Kein handgeschriebenes `<label><input type="radio">…`-Markup** mehr (kein paralleles `.book-settings-option`-Vokabular pro Karte) — sonst driftet die Geometrie auseinander und Felder werden inkonsistent. Bei Berührung einer bestehenden handgeschriebenen Radio-Gruppe: mitziehen, nicht „später".

**Use:** beschriftete Auswahl aus wenigen, gleichrangigen Werten, die alle sichtbar bleiben sollen (Sprache, Region). Für lange/durchsuchbare Listen stattdessen `combobox`; für Einzel-Boolean eine Checkbox (`.form-check`). Selbst-rendernde Komponente analog `combobox`/`numInput` — Markup wird aus `options` generiert, ist also überall identisch. CSS: `.form-radio-group` / `.form-radio-option` in [card-form.css](public/css/components/card-form/form-elements.css).

Pflicht-Pattern (Wrapper-Div leer lassen, nur Attribute setzen):

```html
<div x-data="radioGroup()"
     x-modelable="value" x-model="bookSettingsRegion"
     x-effect="options = bookSettingsRegionOptions()"></div>
```

- `options`: Array `[{ value, label, disabled? }]` (`value` darf `''` sein, z.B. „nicht gesetzt"; `disabled: true` graut eine Option aus + macht sie unwählbar). **Bei reaktiver Datenquelle aus dem Karten-Scope (`this.xxx`/`$app.xxx`) die Options-Liste inline im `x-effect` bauen, nicht über eine Card-Methode** — Method-Indirection trackt nicht zuverlässig (siehe „Reaktivität bei Datenquelle aus Karten-Scope"). Beispiel: die sprachabhängige Region-Liste und das `disabled`-Flag (`!$app.selectedBookId`) stehen inline.
- `x-modelable="value" x-model="ref"` koppelt an das äussere Feld. Optional `@radio-change="…"` für Side-Effects (Detail = neuer Wert).
- Felder, die nicht per `x-model` schreiben (z.B. UI-Sprache via `changeLocale`): `value` per `x-effect` seeden und nur `@radio-change` konsumieren.
- **Variante `card`** (`radioGroup({ variant: 'card' })`): umrandete Radio-Karten mit Akzent-Tint bei Auswahl (`.form-radio-group--card`, `--card-accent` aus dem Karten-Scope) — für prominentere Modus-Auswahlen (Folder-Import). Default = plain.

Referenz: [user-settings.html](public/partials/user-settings.html), [book-settings.html](public/partials/book-settings.html) (plain), [folder-import.html](public/partials/folder-import.html) (Variante `card` + `disabled`).

### Toggle-Switch (`toggleSwitch`)

**Regel:** Boolean-Einstellungen (An/Aus-Schalter) nutzen ausschliesslich `Alpine.data('toggleSwitch')` aus [public/js/toggle-switch.js](public/js/toggle-switch.js). **Kein handgeschriebenes `<label class="checkbox-row"><input type="checkbox" :checked=… @change=…><span>…</label>`** mehr — sonst driften Coercion (`=== true || === 'true'`), Geometrie und a11y pro Karte auseinander. Bei Berührung einer bestehenden Checkbox-Zeile: mitziehen.

**Use:** ein einzelner Boolean-Wert (Feature-Kill-Switch, Export-Option, Settings-Flag). Für eine Auswahl aus mehreren Werten stattdessen `radioGroup`/`combobox`. Selbst-rendernde Komponente analog `radioGroup`: `init()` rendert `role="switch"`-Button + Track + Thumb + optionales Label und setzt die `.toggle-switch`-Klasse aufs Wrapper-Element.

Pflicht-Pattern (Wrapper-Div leer lassen, nur Attribute setzen):

```html
<div x-data="toggleSwitch({ label: () => $app.t('admin.settings.stt.enabled.label') })"
     x-modelable="value" x-model="adminSettingsForm['stt.enabled']"></div>
```

**Klassen** [public/css/components/toggle-switch.css](public/css/components/toggle-switch.css):
- `.toggle-switch` — Wrapper (von `init()` gesetzt)
- `.toggle-switch__btn` — Button (Track + Label), trägt den nativen Fokus-Ring
- `.toggle-switch__track` / `.toggle-switch__track.is-on` — Schalter-Bahn (runde Pille, `border-radius: 999px` — die vertraute An/Aus-Schalter-Affordance; die eckige-Badges-Regel gilt für Badges/Tags, nicht für dieses Control)
- `.toggle-switch__thumb` — gleitender runder Knopf (`border-radius: 50%`)
- `.toggle-switch__label` — sichtbares Label rechts vom Switch

**Regeln:**
- `value` ist intern immer ein echtes Boolean. Beim Seed werden truthy-Strings (`'true'`/`'1'`) und `1` als an interpretiert; beim Toggle wird **immer** ein Boolean zurückgeschrieben.
- `label` (Funktion/String) erzeugt das sichtbare Label; weglassen für einen reinen Switch — dann `ariaLabel` setzen (a11y-Name; wird ignoriert, sobald ein sichtbares Label da ist, um Doppel-Labeling zu vermeiden).
- `disabled: true` graut aus + sperrt. Optional `@toggle-change="…"` für Side-Effects (Detail = neuer Boolean).

**Beispiele:** direkt genutzt als Boolean-Primitive innerhalb von `settingField` ([public/js/setting-field.js](public/js/setting-field.js), `type: 'toggle'`); in den Admin-Settings-Partials erscheint der Switch daher über `settingField`, nicht als eigenes `x-data="toggleSwitch"`. Für einen freistehenden Switch ausserhalb der Settings-Karte gilt weiter das Pflicht-Pattern oben.

### Setting-Field (`settingField`)

**Regel:** Ein einzelnes Feld in einer **Admin-Settings-Karte** (Label + Control + optionaler Help-Text, gebunden an `adminSettingsForm[key]`/`adminSettingsMap[key]`) nutzt `Alpine.data('settingField')` aus [public/js/setting-field.js](public/js/setting-field.js). **Kein handgeschriebenes `<label><span x-text=…><input …><small …help></label>`** mehr pro Feld — die fünf Archetypen (Text/URL/E-Mail, Passwort/Secret mit Masked-Hint, Zahl via `numInput`, Auswahl via `combobox`, Boolean via `toggleSwitch`) waren über die Settings-Tabs vielfach dupliziert. Selbst-rendernde Komponente analog `combobox`/`toggleSwitch`: `init()` rendert die komplette `<label>`-Struktur und ruft `Alpine.initTree`; der interne `x-model` löst über die Alpine-Scope-Kette auf die `adminSettingsCard`-Form auf.

**Use:** ausschliesslich die reinen Feld-Tabs der Admin-Settings. Sonderfälle mit eigener Logik (`provider` mit Subtabs + Budget-Widget, `api` mit Token-Verwaltung) bleiben von Hand. Wrapper-Div leer lassen, nur Attribute setzen:

```html
<!-- i18n-Konvention: Label/Placeholder/Help via base + `.label`/`.placeholder`/`.help` -->
<div x-data="settingField({ k: 'image.host', type: 'url', base: 'image.host', help: true })"></div>
<!-- Roh-Key als Label (keine i18n) + expliziter Help-Key -->
<div x-data="settingField({ k: 'app.timezone', help: 'admin.settings.help.appTimezone' })"></div>
<!-- Zahl / Auswahl / Boolean -->
<div x-data="settingField({ k: 'cron.stale_days', type: 'num', num: { step: 1, min: 1, max: 365 } })"></div>
<div x-data="settingField({ k: 'pdfa.flavour', type: 'select', opts: [{ value: '2b', label: '2b' }, { value: '3b', label: '3b' }] })"></div>
<div x-data="settingField({ k: 'tts.enabled', type: 'toggle', base: 'tts.enabled' })"></div>
<!-- Modell-Feld: Freitext + Combobox mit der Modell-Liste des Hosts -->
<div x-data="settingField({ k: 'embed.model', base: 'embed.model', help: true, models: { target: 'embed', hostKey: 'embed.host' } })"></div>
```

**Modell-Picker (`models`):** Jedes Feld, in dem eine **Modell-ID** steht, bietet die Liste des zugehörigen Hosts an, statt Abtippen zu verlangen — `models` nennt das Ziel (`'claude'` als Kurzform oder `{ target, hostKey }`). `target` ist eines der in [lib/model-list.js](lib/model-list.js) deklarierten Ziele (`claude`, `ollama`, `openai-compat`, `embed`, `rerank`, `stt`, `tts`, `image`); welcher Endpunkt dahinter liegt (Anthropic `/v1/models`, Ollama `/api/tags`, sonst OpenAI-kompatibles `/v1/models`) weiss ausschliesslich der Server. Drei Eigenschaften sind Absicht:

- **Das Textfeld bleibt die Wahrheit**, die Combobox schreibt nur hinein (`transient`). Ein Modell, das der Host nicht meldet (noch nicht gezogen, Host gerade aus, nicht-konformer Server), bleibt damit eintippbar — die Liste ist eine Hilfe, kein Gate.
- **Geladen wird erst auf Klick** („Modelle laden"), nicht beim Rendern: das Öffnen der Settings-Karte initialisiert alle Tabs und würde sonst acht fremde Hosts anpingen. Danach teilen sich alle Felder desselben Ziels die Liste (Prozess-Cache + Window-Event `admin-settings:models-loaded`) — die vier Claude-Modellfelder laden gemeinsam. Combobox-Footer „Liste neu laden" erzwingt einen frischen Abruf.
- **`hostKey`** ist der Form-Key des zugehörigen Hosts. Er wird als Override mitgeschickt, damit ein gerade eingetippter, **noch nicht gespeicherter** Host schon abgefragt werden kann. Der API-Schlüssel kommt immer aus `app_settings` — Secrets verlassen den Server nicht und gehen daher auch nicht durch das Formular zurück.

Ein nicht erreichbarer Host ist kein Fehler: `POST /admin/settings/models` antwortet mit `200 { ok: false, error_code }`, das Feld zeigt den Hinweis unter dem Input und behält das Textfeld.

**Config:** `k` (Pflicht, Setting-Key); `type` (`text` Default | `url` | `email` | `password` | `num` | `select` | `toggle`); `models` (Modell-Picker, siehe unten); `base` (i18n-Basis unter `admin.settings.` → Label `.label`, Placeholder `.placeholder`, Help `.help` nur bei `help: true`); `label`/`phKey`/`help` (volle i18n-Key-Overrides, wenn die Keys nicht der `.label`/`.placeholder`/`.help`-Konvention folgen); `ph` (Literal-Placeholder-String); `secret` (Masked-Placeholder + Masked-Hint; bei `type: 'password'` implizit); `num` (numInput-Config); `opts` (combobox-Options).

**Klassen:** `.setting-field` ([public/css/admin/admin-settings.css](public/css/admin/admin-settings.css)) — Grid-Item der Sektion (`min-width: 0` hält die Shrink-Kette; internes Grid stapelt Toggle + Help). `.setting-field__model-row` legt Input + Lade-Button/Combobox in eine umbrechende Flex-Zeile. Label/Input/Small erben die bestehenden `.admin-settings-section`-Descendant-Styles.

**Beispiele:** [admin-settings-image.html](public/partials/admin-settings-image.html), [admin-settings-auth.html](public/partials/admin-settings-auth.html), [admin-settings-tts.html](public/partials/admin-settings-tts.html).

### Copy-Button (`copyButton`)

**Regel:** Buttons, die einen Wert in die Zwischenablage kopieren und kurz „Kopiert" flashen, nutzen ausschliesslich `Alpine.data('copyButton')` aus [public/js/copy-button.js](public/js/copy-button.js). **Kein handgeschriebenes `@click`-Copy + `x-text`-Toggle + lokaler `copiedXxx`-State** mehr pro Karte — sonst driften Flash-Dauer, Clipboard-Fallback und Label-Logik auseinander. Selbst-rendernde Komponente analog `combobox`/`numInput`/`radioGroup`: `init()` setzt `type=button`, hängt den Click-Handler an und rendert das Label selbst.

**Use:** „Link/Token kopieren"-Buttons (Share-URLs, API-Tokens, Invite-URLs, Device-Tokens). Pflicht-Pattern (Button-Inhalt leer lassen):

```html
<button x-data="copyButton({ text: () => someUrl })"></button>
```

- `text`: **Pflicht**, Funktion (Getter) oder String → der kopierte Wert. Getter, damit der aktuelle Wert zur Klick-Zeit gelesen wird (reaktive Quelle aus dem Karten-Scope).
- `label` / `copied`: Default-Label und Flash-Label, je Funktion oder String. Default `t('common.copy')` / `t('common.copied')`. Override z.B. für „Link kopieren" (`label: () => window.__app.t('admin.users.invites.copyUrl')`). In Getter-Closures `window.__app.t` statt `$app.t` verwenden (Magic überlebt nicht zuverlässig im später aufgerufenen Closure).
- `duration`: Flash-Dauer in ms, Default 2000.
- Pure Helper `copyText(text)` (gleiches Modul) für Auto-Copy ohne Button (z.B. direkt nach Link-Erstellung) — enthält den `execCommand`-Fallback für non-secure-context.

Referenz: [admin-users.html](public/partials/admin-users.html), [admin-settings.html](public/partials/admin-settings.html), [user-settings.html](public/partials/user-settings.html). Ausnahme [share-links.html](public/partials/share-links.html): dort teilt der Button den Flash-State mit dem Auto-Copy bei Link-Erstellung und bleibt manuell (nutzt aber `copyText`).

### Kommentar-Thread (Beta-Leser-Feedback)

**Use:** verankerte + allgemeine Leser-Anmerkungen als Threads (Root + Antworten) — im **Reader** (Share-Link, standalone) und in der **Owner-Karte** „Geteilte Links".

- **Reader (standalone, kein Alpine):** [public/css/share.css](public/css/share.css) + [public/js/share-reader.js](public/js/share-reader.js). Inline-Verankerung via **CSS Custom Highlight API** (`::highlight(share-anchor)` / `::highlight(share-anchor-active)`) — kein DOM-Eingriff am Content, kein `innerHTML`-Sink (Inhalt nur über `textContent`). Selektion → schwebender `.share-sel-btn` → `.share-composer`-Overlay. Thread-Liste `.share-thread` (Root + `.share-thread__replies` + Reader-`.share-thread__reply`-Form), Resolved-/Stale-/Autor-Marker.
- **Owner-Karte:** [public/css/components/share-links.css](public/css/components/share-links.css) — `.share-thread-owner` (Quote-Zeile `__anchor`, Owner-`__reply`-Form), erweitert das bestehende `.share-comment` um `__actions` (Resolve/Reopen + Delete im Flow), `--reply`/`--author`-Modifier, `__resolved`-Badge. Threads via `threadsFor(token)` (Root+Replies gruppiert, verankerte zuerst). Klick auf die `__anchor`-Zeile springt via `gotoComment` → `gotoPageById` in den Notebook-Editor und markiert die Stelle transient (`::highlight(share-comment-jump)`, 6 s).
- **Bidirektional:** Owner-Antwort trägt `author_email` (Display via JOIN), Reader-Identität ist ein opaker localStorage-`reader_token`. Unread zählt nur Reader-Kommentare. Details: [docs/share-link.md](docs/share-link.md).

### Datei-Auswahl (`fileDrop`)

**Regel:** Flächen, über die der User eine Datei auswählt — Drop-Zonen wie auch reine Klick-Upload-Buttons — nutzen ausschliesslich `Alpine.data('fileDrop')` aus [public/js/file-drop.js](public/js/file-drop.js). **Kein handgeschriebenes `<input type="file">` + `@change` + Drag-State (`dragOver` + `@dragover/@dragleave/@drop`)** mehr pro Karte — sonst driften Drag-Feedback, Picker-Reset und Accept-Filter auseinander. Behaviorales Primitive analog `copyButton`: `init()` legt das versteckte Input an, verdrahtet Klick + (optional) Drag&Drop und resettet das Input nach jeder Auswahl.

**Use:** Folder-/Buch-Import (Drop-Zone) und Bild-Upload-Buttons (Cover/Autorfoto/Rückseite). Pflicht-Pattern — Slot-Inhalt (Drop-Text, Dateiname, Button-Label) bleibt erhalten, die Komponente überschreibt ihn **nicht**:

```html
<div class="folder-import-drop" :class="{ 'has-file': !!file }"
     x-data="fileDrop({ accept: () => importKind === 'swbook' ? '.swbook,.zip' : '.zip' })"
     @file-drop="setFile($event.detail.file)">
  <!-- Drop-Text / Dateiname als Slot -->
</div>
```

- `@file-drop`: liefert `$event.detail.file` (erste Datei) + `$event.detail.files` (alle). Feuert nur, wenn mind. eine Datei kam. Der Konsument entscheidet, was passiert (lokal in State legen ODER direkt POSTen) — die Komponente lädt **nichts** hoch.
- `accept`: String **oder Funktion** (für reaktiven Filter, z.B. abhängig vom Import-Typ). Setzt nur den `accept`-Attr des nativen Pickers; **Drag&Drop filtert der Browser nicht** → gedroppte Dateien validiert der Konsument im Handler (Endungs-Check + Fehlertext).
- `drag`: Default `true`. `false` = reiner Klick-Button (kein Drop, keine Drag-Klasse) — so für die Bild-Upload-Buttons.
- `multiple` (Default false), `disabled` (Boolean oder Funktion).
- CSS-Hook: während Drag liegt `is-drag` auf dem Element (Konsument stylt die Drag-Tönung selbst, z.B. `.folder-import-drop.is-drag`). Generischer Baseline-Style (`cursor: pointer`) in [public/css/components/file-drop.css](public/css/components/file-drop.css).
- Ein „Entfernen"-Button **innerhalb** der Drop-Fläche fängt seinen Klick selbst ab (die Komponente ignoriert Klicks auf `button/a/input/label`), öffnet also nicht den Picker.

Referenz: [folder-import.html](public/partials/folder-import.html) (Drop-Modus), [book-settings.html](public/partials/book-settings.html) + [pdf-export.html](public/partials/pdf-export.html) (Klick-Modus, `drag: false`).

### In-Form-Repeater (`.pub-repeater`) + Segment-Toggle (`.seg-toggle`)

**Use:** lokal editierbare Liste variabler Länge innerhalb eines Forms, die als Ganzes über den normalen Karten-Save persistiert (kein eigener Server-CRUD-Roundtrip pro Zeile). Eingesetzt im Publikation-Tab (Co-Autoren als Zeilen, freie Vor-/Nachsatz-Seiten als Sub-Karten). CSS: [public/css/book/book-settings.css](public/css/book/book-settings.css).

- `.pub-repeater` — flex-column-Container, am Ende ein `.btn-compact`-„Hinzufügen"-Button.
- `.pub-repeater-row` — flache Zeile (Inputs + `.btn-compact.danger`-Entfernen), Inputs `flex: 1`.
- `.pub-matter-card` — eckige Sub-Karte für reichere Einträge (Kopf + mehrere Felder).
- Mutation per Alpine `x-for="(s, i) in arr"` + `x-model="s.feld"` (Loop-Var ist reaktive Referenz ins Array) + `arr.push(...)` / `arr.splice(i, 1)`. `:key="i"`. Kein Server-Call beim Add/Remove — der Karten-Save schreibt das volle Array.

`.seg-toggle` — **binärer Inline-Umschalter** (zwei aneinanderliegende, eckige Buttons; aktiver Zustand getintet via `--color-tag-bg` + `--color-accent`). Reuse statt nativem `<select>`/Combobox, wenn genau 2–3 sich gegenseitig ausschliessende Werte direkt in einer dichten Repeater-Zeile gesetzt werden. Markup: `<div class="seg-toggle"><button :class="{ 'seg-toggle--active': v==='a' }" @click="v='a'">…</button>…</div>`. Ein Wert, der im aktuellen Kontext nicht setzbar ist, bekommt `:disabled` (gedimmt, `not-allowed`) plus ein `:data-tip`, das den Grund nennt — **sichtbar bleiben statt verschwinden**, sonst springt die Reihe in der Breite und der User erfährt nie, dass es die Option gibt. Beispiel: „Blockzitat" im Quellen-Picker des Notebook-Editors, wenn der Caret in einer Liste steht.

### Hint / Error / Saved unterhalb der Form

`.card-form-hint` (12 px, muted, italic), `.card-form-error` (rot), `.card-form-saved` (success — ✓-Prefix via `::before`, fade via `x-transition.opacity.duration.250ms`, Auto-Dismiss 2500 ms via `_savedAtTimer` in der Karte).

`.card-form-warn` (amber, getönter Hintergrund + linker 3 px-Border) ist die dritte Stufe: die Aktion **lief durch**, hat aber eine Folge, die der User kennen muss. Kein Auto-Dismiss (ein Hinweis, der verschwindet, bevor er gelesen ist, ist keiner) und `role="status"`. Getönte Box statt bloss farbigem Text, weil solche Hinweise mehrzeilig sind und als reiner Farbtext neben `.card-form-saved` untergehen. CSS in [card-form/form-elements.css](public/css/components/card-form/form-elements.css).

```html
<p class="card-form-warn" x-show="blogCiteWarning" x-cloak role="status" x-text="blogCiteWarning"></p>
```

**Use:** Teil-Erfolg mit Datenfolge — Beispiel: der WordPress-Pull lief, aber WordPress hat die Quellen-Verweise entfernt (KSES ohne `unfiltered_html`), die Belege im Text sind zu Klartext degradiert. **Nicht** für Validation (→ `.card-form-error` + `aria-invalid`) und nicht für abgeleitete Vorschau-Konsequenzen einer Einstellung (→ `.admin-settings-budget`).

### Abgeleiteter Severity-Hinweis (`.admin-settings-budget`)

Inline-Box unterhalb von Form-Feldern, die aus den eingegebenen Werten **live** eine Konsequenz ableitet und je nach Schwere einfärbt — Use-Case: Kontextfenster → Auswirkung auf die Komplettanalyse-Pässe. Neutral (Info, `--color-tag-bg`), `.is-warn` (amber, `--color-warn-bg/-text`), `.is-bad` (rot, `--color-err-bg/-text`), linker 3 px-Border in der jeweiligen Akzentfarbe. Schwellen + abgeleitete Zahlen kommen aus einer Karten-Methode (`adminSettingsBudget(provider)`), nicht aus CSS. Markup: `<strong>`-Titel + `.muted-msg.muted-msg--sm`-Ableitung + optionaler Warn-Absatz (nur bei `level !== 'ok'`). CSS in [admin/admin-settings.css](public/css/admin/admin-settings.css). Use, wenn eine Einstellung eine nicht-offensichtliche Folgewirkung auf ein anderes Feature hat, die der Admin beim Setzen kennen soll.

### Validation-State auf Inputs (Pflicht bei Fehler)

Inputs mit Fehler bekommen `aria-invalid="true"` + `aria-describedby="<error-id>"`. Visuell rote Border via `[aria-invalid="true"]`-Selektor in [card-form.css](public/css/components/card-form/form-elements.css). Kein eigener `.form-input--invalid`-State daneben — `aria-invalid` ist Pflicht-Attribut, der Selektor leitet daraus die Optik ab.

```html
<input id="bs-foo" :aria-invalid="!!fooError" aria-describedby="bs-foo-err">
<p class="card-form-error" id="bs-foo-err" x-show="fooError" x-text="fooError"></p>
```

Pure-CSS-Border ohne `aria-invalid` ist Anti-Pattern — Screen-Reader liest sonst nichts, nur die Sehenden bekommen Feedback.

### Textarea / Field-Note

`.card-form-textarea` (volle Breite, vertikal resizable) für mehrzeilige Inputs. `.card-form-field` ist Spalten-Stack (Input + Note darunter), `.card-form-field-note` ist 12 px-Erklärtext unter dem Input.

### Spellcheck-Badge auf Form-Feldern (`.lt-field-wrap`)

`<input type="text">` und `<textarea>`, die Prosatext aufnehmen (Titel, Notizen, Einleitungen, Beschreibungen, Ideen), bekommen `data-spellcheck="spelling"`. Der Form-Controller ([public/js/cards/editor-spellcheck/form-controller.js](public/js/cards/editor-spellcheck/form-controller.js)) wickelt das Feld beim Focus einmalig in `<span class="lt-field-wrap">` und hängt dort den Badge absolut positioniert in die obere/untere rechte Ecke. Klick öffnet ein Popover mit Tippfehler-Liste + Vorschlägen.

- **Markup-Pflicht** im Partial: nur das Attribut, sonst nichts. Wrap + Badge erzeugt der Controller, keine Hand-Markup-Anpassung nötig.
  ```html
  <input type="text" data-spellcheck="spelling" x-model="…">
  <textarea data-spellcheck="spelling" x-model="…" rows="4"></textarea>
  ```
- **Position:** Input → vertikal mittig rechts. Textarea (Klasse `.lt-field-wrap--textarea` automatisch) → bottom-right (erste Textzeile bleibt frei).
- **Padding-Reservation:** Der Controller setzt das nicht selbst — CSS macht es: `.lt-field-wrap > input[data-spellcheck], .lt-field-wrap > textarea[data-spellcheck] { padding-inline-end: 32px !important }`. Eigenes Padding-Shorthand am Feld bleibt sonst voll wirksam (top/bottom/left), nur rechts wird reserviert.
- **Flex/Grid-Parents:** `.lt-field-wrap { flex: 1; min-width: 0; display: block; }` greift transparent — in flex-Parents (`.organizer-page`, `.ideen-input-row`, `.kapitel-new-page`) übernimmt der Wrap die `flex: 1`-Rolle des Inputs; in grid/block bleibt es block-level.
- **Anti-Pattern:** Badge per Hand-Markup neben den Input setzen (war früher Sibling-Layout, sah unterschiedlich aus je nach Parent — vermeidet das jetzt absichtlich).

**Wann NICHT** `data-spellcheck` setzen: Such-/Filterfelder (`.filter-search-input`, Sidebar-Suche, Palette-Suche), `numInput`-Zahlenfelder, Admin-/technische Settings (Model-IDs, URLs, Tokens), Find/Replace (User sucht ggf. nach Tippfehlern), Readonly-Felder (Share-URLs), Passwortfelder. Im Zweifel: Prosatext → ja, sonst → nein. Hard-Rule-Begründung steht in CLAUDE.md.

### Mobile (≤ 600 px)

Grid kollabiert auf 1 Spalte (in card-form.css). `.form-inline` reflowed auf 50/50 (`flex 1 1 calc(50% - 16px)`); `.form-num` wird flex-fluid.

### Regel: Gleiche Höhe pro Form-Zeile

In einer Form-Zeile (Inputs, Comboboxes, Buttons nebeneinander in Flex/Grid mit `align-items: center`/`stretch`) müssen alle Elemente dieselbe Geometrie haben — **entweder alle default oder alle compact**, kein Mix.

- Default-Set: `<input>`, `<button>` (ohne `.btn-compact`), `combobox({ compact: false })` → alle nutzen `--size-default-padding-y` (8px) + `--font-size-base` (14px).
- Compact-Set: `.btn-compact`, default-`combobox(...)` (Helper setzt `--compact` auto), Compact-Input (eigene Klasse mit `--size-compact-padding`/`--size-compact-font-size`) → alle nutzen `--size-compact-padding` (4px y) + `--size-compact-font-size` (12px).

Stolperfalle: `combobox(placeholder)` ist **default compact**. Steht der combobox neben einem nackten `<input>` oder `<button>` ohne `.btn-compact`, sieht das ungleich aus → Object-Form `combobox({ placeholder, compact: false })` verwenden. Umgekehrt: wenn die Zeile sonst nur Compact-Elemente hat (Filter-Bars, Table-Row-Controls), bleibt der Default-Compact-Combobox richtig.

**Spezifitäts-Falle bei nativen typed-Inputs (`<input type=date|number|month|datetime-local|…>`, `<select>`):** Diese werden von der generischen Form-Liste in [card-form/form-elements.css](public/css/components/card-form/form-elements.css) (`input[type=date], …, select { … }`, Spezifität **0,1,1**, volle Feldgrösse: `--font-size-base`, `--size-default-padding-y`, 1px Border, `width:100%`) getroffen. Eine eigene Compact-Klasse als **nackter** Selektor (`.xxx-date-input`, 0,1,0) **verliert** dagegen → das Feld rendert voll-gross und sitzt höher als die `.btn-compact`/Compact-Combobox daneben. Fix: Compact-Selektor höher scopen (`.parent .xxx-date-input`, 0,2,0) **und** `width: auto` setzen. Bei iOS-Zoom-Override (≥16px auf Mobile) die Mobile-Regel mit gleicher Spezifität + gleichem Breakpoint (768px) nachziehen, sonst überstimmt die neue Desktop-Regel sie. Referenz-Fix: [my-stats.css](public/css/components/my-stats.css) `.mystats-range-custom .mystats-date-input`, identisch in [recherche/board.css](public/css/entities/recherche/board.css) für `.filter-search-input`. (Gleiche Falle ist in der Filter-Bar-Sektion unten dokumentiert.)

Filter-Bars (`.filter-bar`, `.admin-usage-filter`, `.admin-users-requests-filter`) sind bewusst rein compact (Search-Input + Compact-Combobox + Compact-Buttons) — kein Mix zulässig.

### Regel: Forms folgen der UI-Locale

Alle Form-Inputs (Datums-/Zeit-Picker, Zahlen, Auswahllisten, Platzhalter, Hint-/Error-/Saved-Texte, Validation-Messages, Format-Beispiele) richten sich nach der aktiven UI-Locale (`this.uiLocale`), **nicht** nach Browser-Default oder Buchsprache.

- **Labels, Placeholder, Hints, Optionen:** ausschliesslich via `t('bereich.feld')` / `tRaw()` (siehe Harte Regel „UI-Strings nur in `public/js/i18n/{de,en}.json`"). Kein hartcodiertes DE/EN-Markup in Partials.
- **Zahlen, Datum, Zeit:** `Intl.NumberFormat` / `Intl.DateTimeFormat` mit Locale-Tag aus `this.uiLocale` (DE → `de-CH`, EN → `en-CH`/`en-US` je nach `defaultRegion`). DE-CH: Dezimal `.`, Tausender `’`; EN-US: Dezimal `.`, Tausender `,`. Nie statisch `'de-DE'` o.ä. setzen.
- **Inputs mit nativer Lokalisierung** (`<input type="number|date|time">`): erben das `lang`-Attribut vom `<html lang>`-Sync (gesetzt in [public/js/i18n.js](public/js/i18n.js) bei Locale-Wechsel). **Kein** eigenes `lang=`-Override am Input.
- **Combobox-Optionen / Sortierung:** Labels via `t()`; String-Sort `localeCompare(b, this.uiLocale)`.
- **Format-Helper** (`formatLastRun`, Schweizer-Zahlen-Util, …) bekommen `this.uiLocale` als Parameter, lesen ihn nicht aus globaler Konstante.
- **Buchsprache ≠ UI-Locale:** Buchinhalt kann DE sein, während UI auf EN läuft. Form-Chrome folgt UI, nicht Inhalt.

Reaktivität: `t()` referenziert `this.uiLocale` (siehe [public/js/i18n.js](public/js/i18n.js)), Alpine re-rendert bei Locale-Wechsel automatisch. Eigene Format-Methoden müssen `void this.uiLocale;` als Reaktivitäts-Anker enthalten, sonst frieren formatierte Werte bei Sprachwechsel ein.

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

## Sequenz-Band (`.stil-rhythm-band`)

**Use:** eine lange Zahlenfolge in ihrer **Reihenfolge** zeigen, wo ein Aggregat sie plattdrückt. Eingesetzt für den Satzrhythmus pro Kapitel in der Stil-Karte: derselbe Mittelwert entsteht aus lauter gleich langen Sätzen wie aus dem Wechsel kurz/lang, und genau dieser Unterschied ist die Aussage. **Nicht** für Zeitreihen mit Achsenbezug (→ Chart.js) und nicht für Anteile (→ Proportions-Balken).

**Markup:**
```html
<div class="stil-rhythm-row">
  <div class="stil-rhythm-label">…Name + Kennzahlen…</div>
  <svg class="stil-rhythm-band" :viewBox="…" preserveAspectRatio="none" role="img" :aria-label="…">
    <polygon class="stil-rhythm-area" :points="r.points"></polygon>
  </svg>
  <div class="stil-rhythm-stats">…</div>
</div>
```

CSS: [public/css/analysis/heatmap.css](public/css/analysis/heatmap.css). Regeln:

- **Ein Knoten pro Zeile, nicht einer pro Wert.** Der Verlauf ist ein einzelnes `<polygon>` mit vorberechnetem `points`-String; bei 40 Kapiteln × 120 Spalten wären Einzel-Rects 4800 DOM-Knoten pro Render.
- **Fläche, keine Linie.** `preserveAspectRatio="none"` streckt das SVG auf die Spaltenbreite — eine Strichstärke würde mitverzerrt, eine Fläche nicht.
- **Downsampling per Bucket-Mittel**, nicht per Sampling: ein herausgegriffener Einzelwert würfelt das Band bei jedem Zuwachs neu.
- **Skala buchweit, nicht pro Zeile** (sonst sind die Zeilen nicht vergleichbar) und über ein **Perzentil**, nicht das Maximum — ein einzelner Ausreisser drückt sonst alles an den Boden. Gekappte Werte sind als Vollausschlag lesbar.
- Farbe aus `var(--card-accent)`, Hintergrund als getönte Fläche derselben Farbe.

---

## Rangliste mit Balken (`.stil-opener-list`)

**Use:** Top-N einer Häufigkeitsverteilung als kompakte Liste mit Balken, Zahl und Anteil — wenn eine `sortableTable` zu schwer wäre (feste Sortierung, keine Interaktion). Eingesetzt für die Satzanfänge in der Stil-Karte.

**Markup:**
```html
<li class="stil-opener-row">
  <span class="stil-opener-word" x-text="o.word"></span>
  <span class="stil-opener-bar"><span class="stil-opener-fill" :style="{ '--opener-bar': (o.bar * 100) + '%' }"></span></span>
  <span class="stil-opener-count"></span><span class="stil-opener-share"></span>
</li>
```

Breite über die Custom-Property `--opener-bar` (wie `.progress-bar` über `--progress`), **nie** über `:style="'width:'+…"`. Balkenlänge relativ zum **häufigsten** Eintrag, nicht zum Gesamtanteil — sonst sind alle Balken kurz.

---

## Wortwolke (`.wortschatz-cloud`)

**Use:** eine gewichtete Wortliste als Fläche statt als Tabelle. Eingesetzt im vierten Reiter der Wortschatz-Karte. Ergänzt die Ranglisten, ersetzt sie nicht — die Wolke beantwortet „wie sieht mein Wortschatz aus", die Tabelle „welches Wort steht auf Platz 7".

**Markup:** ein `<svg>` mit fester `viewBox` (Layout-Fläche) und `<text>`-Knoten aus dem d3-cloud-Ergebnis; Transform und Schriftgrösse kommen aus dem Layout, die Farbe aus einer Custom-Property.

```html
<svg class="wortschatz-cloud" :viewBox="wsCloudViewBox()" role="img" :aria-label="…">
  <template x-for="w in wsCloudLayout" :key="w.text">
    <text class="wortschatz-cloud-word" :style="wsCloudVars(w)" :transform="wsCloudTransform(w)"
          :font-size="w.size" text-anchor="middle" @click="…" x-text="w.text"></text>
  </template>
</svg>
```

CSS: [public/css/analysis/wortschatz.css](public/css/analysis/wortschatz.css). Regeln:

- **Feste Zeichenfläche, per `viewBox` skaliert** (`aspect-ratio`). Ein Neulauf des Layouts bei jedem Resize würde die Wolke jedes Mal neu anordnen.
- **Farbe über `color-mix` mit `var(--card-accent)` und einer Gewichts-Property** — die Wolke muss in Light und Dark tragen, feste Hex-Werte scheiden aus.
- **Deterministisch** (fixer `random()`, indexbasierte Rotation): dieselbe Analyse muss dasselbe Bild ergeben, sonst sind zwei Läufe nicht vergleichbar.
- Schmal (≤ 640 px) scrollt der Kasten horizontal, statt die Wörter auf Unlesbarkeit zu schrumpfen.
- Die Lib lädt lazy (`loadWordCloud()` in [lazy-libs.js](public/js/lazy-libs.js)) und **nur**, wenn der Reiter offen ist — der Layout-Lauf misst jedes Wort einzeln auf einem Canvas.

---

## Proportions-Balken (zweigeteilt, `.mystats-effort-bar`)

**Use:** Anteil zweier Grössen als gefüllter Balken + Legende (z.B. Schreiben vs. Überarbeiten in „Meine Statistik"). Für **count-getriebene N-Segment**-Verteilungen (mehr als zwei, flex-grow nach Anzahl) stattdessen `.plot-dist-bar`/`.plot-dist-seg` (siehe Plot-Sektion).

**Markup:**
```html
<div class="mystats-effort-bar" role="img" :aria-label="…">
  <div class="mystats-effort-seg mystats-effort-seg--write" :style="{ width: pctA + '%' }"></div>
  <div class="mystats-effort-seg mystats-effort-seg--edit"  :style="{ width: pctB + '%' }"></div>
</div>
<div class="mystats-effort-legend">
  <span class="mystats-effort-key"><span class="mystats-effort-dot mystats-effort-dot--write"></span>…</span>
  <span class="mystats-effort-key"><span class="mystats-effort-dot mystats-effort-dot--edit"></span>…</span>
</div>
```

CSS: [public/css/components/my-stats.css](public/css/components/my-stats.css). Segment 1 = `var(--color-accent)`, Segment 2 = `color-mix(accent 35% bg)`; Prozente sind die einzige Datenquelle (Frontend clamped auf Summe 100).

---

## Entity-List (Listendarstellung)

**Use:** Tabellarische Listen mit Klick → Detail (Figuren, Orte, Szenen, Findings, …).

**Klassen:**
- `.entity-list` — Container
- `.entity-list--accented` — mit linkem Akzentstreifen
- `.entity-row` / `.entity-row--selected` — Zeile
- `.entity-row-title` / `.entity-row-meta`
- `.entity-meta-row` / `.entity-meta-label` / `.entity-meta-value` — Detail-Box

CSS: [public/css/entities/entity-list.css](public/css/entities/entity-list.css). Wiederverwendbar für jede neue Listen-Karte; nicht selbst neu bauen.

---

## Listen-Anriss + Detail-Dialog

**Use:** Einträge mit Freitext **beliebiger** Länge in einer Übersichtsliste (Recherche-Fundstück, erfasste Webseite, Zitat-Volltext). Die Liste zeigt einen Anriss, der Volltext lebt in einer Detailansicht — als natives `<dialog>` (Pattern [Modal-Shell](#modal-shell-modal)).

**Markup** (Liste, [recherche-item.html](public/partials/recherche-item.html)):
```html
<button type="button" class="research-item-title" @click="openDetail(item)"
        x-text="item.title || kindLabel(item.kind)"></button>
<div class="research-item-text" x-show="item.body" x-text="item.body"></div>
```

**Klassen** [entities/recherche/board.css](public/css/entities/recherche/board.css) + [entities/recherche/dialog.css](public/css/entities/recherche/dialog.css):
- `.research-item-text` — der Anriss: fester `-webkit-line-clamp` (3) + `overflow: hidden`
- `.research-item-thumb` / `.research-item-image` — Vorschaubild, klein (`max-height: 6rem`), öffnet die Detailansicht
- `.research-dialog` — die geteilte `<dialog>`-Shell; `.research-dialog__scroll` scrollt, `__head` bleibt stehen
- `.research-dialog__text` — Lesesatz: `--font-size-reading`, `--lh-relaxed`, `max-width: 34rem`
- `.research-dialog--create` — schmalere Variante fürs Anlegen (Formularspalte, keine Lesebreite)
- `.research-dialog__bar` — Fussleiste **ausserhalb** von `__scroll`: Speichern/Abbrechen bleiben stehen, während das Formular scrollt

**Regeln:**
- **Der Cap ist eine feste CSS-Zahl, kein gemessener Toggle.** Wo es eine Detailansicht gibt, ist „mehr anzeigen" dort — ein Inline-Ausklappen in der Liste macht bei einem 20 000-Zeichen-Fund aus der Übersicht wieder eine Wand, und die Zeilen-Messung (`scrollHeight > clientHeight`, rAF, `resize`-Listener), die nur die Toggle-Sichtbarkeit steuert, entfällt komplett.
- **Volltext braucht Lesetypografie, nicht bloss mehr Platz:** Lesegrösse (`--font-size-reading`), ruhige Zeilenhöhe (`--lh-relaxed`) und ein Satzspiegel um 70 Zeichen. Panelbreite ≠ Zeilenbreite.
- **Der tastaturerreichbare Weg in die Detailansicht ist ein `<button>`** (der Titel). Der Klick auf die ganze Zeile ist nur Maus-Komfort und liegt in einer Allowlist-Prüfung (`onItemBodyClick`), die interaktive Kinder und aktive Textselektion ausnimmt.
- **Lesen und Bearbeiten teilen die Detailansicht, verdrängen sich aber nicht gegenseitig:** ein Modus-Flag (`detailEditing`) tauscht nur die Textfelder. Verknüpfungen, Tags und Anhänge bleiben in beiden Modi bedienbar — zwei exklusive `x-if`-Zweige (Anzeigen ODER Formular) nehmen dem User genau die Funktionen weg, die er beim Redigieren braucht.
- **Ein offenes `<dialog>` muss mit seiner Karte schliessen** (`$watch` auf den Show-Flag): es liegt im Top-Layer, verschwindet mit der `display:none`-Karte also nur optisch und hält das restliche Dokument inert — die App wirkt eingefroren. Gilt für **jeden** Dialog der Karte, nicht nur den Detail-Dialog.
- **Anlegen gehört in denselben Dialog-Rahmen wie Bearbeiten, nicht als Block über die Liste.** Es sind dieselben Felder: EIN Feld-Fragment (`recherche-form-fields.html`), EIN Draft (`draft`), EINE Shell (`.research-dialog*`) — nur Aktionszeile und Datei-Anhang unterscheiden sich. Zwei Rahmen um dieselben Felder driften auseinander (Feldreihenfolge, Textfeldhöhe, Spellcheck-Attribut), und ein Inline-Formular schiebt die Liste beim Anlegen weg. Voraussetzung dafür: beide Wege sind exklusiv (beide modal) und der Draft wird **nur** von den Öffnern (`startCreate`/`startEdit`) gefüllt — die `@close`-Handler räumen nur ihre Flags, weil das native `close`-Event als eigener Task feuert und sonst den Draft des gerade geöffneten zweiten Dialogs überschreibt.
- **Fehlermeldungen gehören in den offenen Dialog.** Die Statuszeile der Karte liegt hinter dem `::backdrop` — ohne eigene `.card-status`-Zeile im Dialog ist „Speichern tut nichts" die ganze Rückmeldung.
- Kein `<details>`/`<summary>` für den Anriss; das ist keine klappbare Section (Pattern [Klappbarer Section-Toggle](#klappbarer-section-toggle-accordion)), sondern ein Overflow-Cap.

**Beispiele:** [recherche-item.html](public/partials/recherche-item.html) + [recherche-detail.html](public/partials/recherche-detail.html) + [recherche-create.html](public/partials/recherche-create.html) (geteilte Felder: [recherche-form-fields.html](public/partials/recherche-form-fields.html)), E2E: [tests/e2e-app/recherche-overview.spec.js](tests/e2e-app/recherche-overview.spec.js).

---

## Detail-Gruppen + Steckbrief-Raster (Figuren-Detail)

**Use:** Reich annotierte Entity-Details (viele heterogene Felder) in benannte Gruppen bündeln und kurze Fakten als ausgerichtetes Label/Wert-Raster zeigen, statt einer langen flachen Spalte gleichrangiger Sektionstitel.

**Markup:**
```html
<section class="figur-group" x-show="…">
  <h4 class="figur-group-title" x-text="t('…group…')"></h4>
  <dl class="figur-steckbrief-grid">
    <template x-if="f.rolle">
      <div class="figur-fact"><dt x-text="t('…rolle')"></dt><dd x-text="f.rolle"></dd></div>
    </template>
    <!-- weitere kurze Fakten … -->
  </dl>
  <!-- längere Prosa-Felder als volle Breite: .figur-detail-row mit inline-Label -->
  <!-- Untersektionen (Listen/Tags/Zeitstrahl) mit .bewertung-section-title -->
</section>
```

**Klassen** [public/css/entities/figuren.css](public/css/entities/figuren.css):
- `.figur-group` — Gruppe mit Top-Trenner; `:first-of-type` ohne Trenner.
- `.figur-group-title` — fetter Uppercase-Gruppentitel mit `--card-accent`-Tick (Hierarchie-Ebene über `.bewertung-section-title`).
- `.figur-steckbrief-grid` — `grid` mit `max-content 1fr`, ab 720px `max-content 1fr max-content 1fr` (zwei Label/Wert-Paare pro Zeile → nutzt Kartenbreite).
- `.figur-fact` — `display: contents`, damit `dt`/`dd` direkt im Grid fluchten (nötig als `x-if`-Wurzelelement).

**Regeln:**
- Nur **kurze** Werte ins Raster (Rolle, Beruf, Badges, Adresse). Prosa-Felder (Beschreibungen, Motivation) als volle Breite per `.figur-detail-row` mit inline-Label — sonst zerbricht der lange Text in halbe Zellen.
- Sub-Sektionstitel innerhalb einer Gruppe bleiben `.bewertung-section-title`; nur die **erste** unter dem Gruppentitel verliert ihren oberen Abstand.
- Drei Gruppen für Figuren: Steckbrief (Fakten) · Charakter (Innenleben/Entwicklung) · Im Buch (Auftritte/Beziehungen/Zeitstrahl).

**Beispiele:** [public/partials/figuren.html](public/partials/figuren.html)

---

## Aufklappbare Tabellenzeile (Drilldown im `sortableTable`)

**Use:** Tabellenzeile, die ihre Belege/Detailzeilen unter sich aufklappt (Job-Statistik → Läufe, Alterstabelle → Fundstellen). **Ein** offener Block pro Tabelle, gehalten als `xxxOpenId === row.id` in der Karte — kein `Alpine.data('collapsible')` (das ist für eigenständige Sektionen; siehe CLAUDE.md „Klappbare Section via `collapsible`" → „Nicht für Listen-/Tree-Row-Chevrons").

**Markup-Pflicht:** ein `<tbody>` **pro Zeile** aus dem `x-for`, direkt unter `<table>` nach `</thead>`. Mehrere `tbody` sind gültiges HTML, ein `tbody` im `tbody` nicht — der Parser hebt es sonst heraus und die Tabelle zerfällt. Zwei `<tr>` aus einem `x-for` gehen nur so, weil `<template x-for>` genau ein Wurzelelement erlaubt.

```html
<table x-data="sortableTable({ rows: () => xxxRows(), … })">
  <thead>…</thead>
  <template x-for="row in sorted" :key="row.id">
    <tbody>
      <tr :class="{ 'xxx-row--open': openId === row.id }"
          :role="row.belege.length ? 'button' : null"
          :tabindex="row.belege.length ? 0 : null"
          :aria-expanded="row.belege.length ? (openId === row.id) : null"
          @click="row.belege.length && toggle(row)"
          @keydown.enter.prevent="row.belege.length && toggle(row)"
          @keydown.space.prevent="row.belege.length && toggle(row)">
        <td><span class="history-chevron" :class="{ open: openId === row.id }" aria-hidden="true">›</span> …</td>
      </tr>
      <tr x-show="openId === row.id"><td :colspan="N">…Detail…</td></tr>
    </tbody>
  </template>
</table>
```

**Regeln:**
- `role="button"` / `tabindex` / `aria-expanded` nur setzen, wenn es wirklich etwas aufzuklappen gibt — eine Zeile ohne Details, die sich als Button ausgibt, ist ein Tastatur-Stop ins Nichts.
- Ein Link **innerhalb** der Zeile (Sprung zur Figur/Seite) braucht `@click.stop`, sonst klappt derselbe Klick auch die Zeile um.
- `colspan` von Hand mit der Spaltenzahl des `<thead>` gleichhalten.

**Beispiele:** [public/partials/book-settings-stats.html](public/partials/book-settings-stats.html) (Job-Läufe), [public/partials/figuren-alter.html](public/partials/figuren-alter.html) (Alters-Belege)

---

## Auswahl-Chip-Reihe (Mehrfachauswahl vor einer Vergleichsansicht)

**Use:** Der Leser stellt sich selbst zusammen, was verglichen wird — mehrere Entitäten gleichzeitig, mit hartem Deckel (Lebenslauf-Reiter der Figuren-Karte: welche Figuren als Spalten der Phasen-Matrix stehen). **Nicht** für Einfachauswahl oder Filtern — dort bleibt die `combobox` zuständig; ein Chip pro Option wäre eine ausgeklappte Liste, die nie zugeht.

**Warum ein Chip und keine Multi-Combobox:** die Auswahl bleibt sichtbar, während man die Vergleichsansicht darunter liest. Eine geschlossene Combobox verbirgt genau die Angabe, die man beim Deuten der Tabelle braucht.

```html
<!-- Wrapper traegt den Aussenabstand des Auswahl-Schritts, nicht der bedingte Hinweis -->
<div class="xxx-pick">
  <p class="xxx-hint" x-show="ausgeschlossen() > 0" x-text="…"></p>
  <div class="xxx-chips" role="group" :aria-label="$app.t('…pickLabel')">
    <template x-for="k in kandidaten()" :key="k.id">
      <button type="button" class="xxx-chip"
              :class="{ 'xxx-chip--on': istGewaehlt(k.id) }"
              :aria-pressed="istGewaehlt(k.id)"
              :disabled="!istGewaehlt(k.id) && istVoll()"
              @click="toggle(k.id)">…</button>
    </template>
  </div>
</div>
```

**Regeln:**
- **`<button>` + `:aria-pressed`**, kein `div` mit `.internal-link` — es ist ein Umschalter, kein Sprung.
- **Am Deckel wird gesperrt, nicht ignoriert** (`:disabled` auf den nicht gewählten Chips): ein Klick, der wortlos nichts tut, liest sich als Defekt. Die Zählung („3 von max. 6") steht daneben in der `.filter-count`.
- **Der Deckel kommt aus einer Konstante im Modul**, nicht als Zahl ins Template — zwei Zahlen laufen auseinander.
- **Eckig** (`--radius-sm`), wie jedes Badge/Tag; die Pillenform gehört dem An/Aus-Schalter.
- **Wer nicht in Frage kommt, erscheint gar nicht** — und wie viele das sind, wird als Hinweis ausgewiesen. Eine stumm gekürzte Liste liest sich als „mehr gibt es nicht".
- Erste Öffnung wählt selbst vor (die stärksten Kandidaten), statt eine leere Ansicht mit Aufforderung zu zeigen.
- **Der Abstand hängt am Wrapper, nicht an einem bedingten Kind.** Die Reihe ist ein eigener Arbeitsschritt zwischen Filterleiste und Vergleichsansicht und braucht oben wie unten Luft (`margin: var(--space-md) 0 var(--space-lg)`); der Hinweis darüber ist `x-show`-bedingt, und säße der untere Abstand an ihm, rückten Chips und Tabelle zusammen, sobald er verschwindet. Nach oben **kollabiert** die Wrapper-Margin mit der `margin-bottom` der `.filter-bar` (normaler Fluss) — sie addiert sich nicht.
- **Chips sind Klickziele, keine Inline-Tags:** `--pad-badge` (4/8) und ein Gap ab `--space-6`, Zeilen-Gap grösser als der Spalten-Gap (`gap: var(--space-sm) var(--space-6)`). Mit dem 2-px-Gap der dichten Tag-Reihen verschmilzt die Auswahl zu einem Block, in dem man die einzelne Schaltfläche nicht mehr sieht.

**Beispiele:** [public/partials/figuren-lebenslauf.html](public/partials/figuren-lebenslauf.html)

---

## Table-Scroll (`.table-scroll`)

**Use:** Wrapper um breite Tabellen, damit sie auf engen Viewports horizontal scrollen statt aus der Karte zu ragen. Pflicht für mehrspaltige Admin-/Listen-Tables.

**Markup:**
```html
<div class="table-scroll" x-show="rows.length">
  <table class="admin-users-table">…</table>
</div>
```

CSS: [public/css/layout/utilities.css](public/css/layout/utilities.css). `overflow-x: auto` + `max-width: 100%` am Wrapper; `min-width: 100%` an der Table.

---

## Sortierbare Tabelle (`sortableTable`)

**Pflicht** für jede `<table>` mit >3 Datenzeilen. Kein natives `<table>` ohne `sortableTable`-Wrapper, ausser die Ausnahmebedingung („Wann nicht") greift. Gilt rückwirkend: bestehende Tabellen werden bei Berührung mitgezogen.

**Use:** Reines Client-Side-Sort über eine reaktive Datenquelle. Default-Tabelle für Admin-, Listen-, Verwaltungs-Views.

**Markup:**
```html
<table class="admin-users-table"
       x-data="sortableTable({
         rows: () => adminUsersList,
         defaultKey: 'email',
         defaultDir: 'asc',
         persistKey: 'admin.users',
         types: { last_seen_at: 'date' },
       })">
  <thead><tr>
    <th class="sortable-th" :class="sortClass('email')" :aria-sort="ariaSort('email')"
        @click="sortBy('email')" x-text="$app.t('admin.users.email')"></th>
    <th class="sortable-th" :class="sortClass('last_seen_at')" :aria-sort="ariaSort('last_seen_at')"
        @click="sortBy('last_seen_at')" x-text="$app.t('admin.users.lastLogin')"></th>
  </tr></thead>
  <tbody>
    <template x-for="u in sorted" :key="u.email">…</template>
  </tbody>
</table>
```

**Pflicht-Pattern:**
- `<table>` ist die `x-data`-Wurzel — `sorted`, `sortBy`, `sortClass`, `ariaSort` werden direkt im `<thead>`/`<tbody>` adressiert. Aussere Scope (Karten-State, Methoden) bleibt via Alpine-Scope-Chain erreichbar.
- `rows` ist eine **Funktion** (Getter), keine Array-Referenz. Reagiert dadurch reaktiv auf Aenderungen der Quelle (z.B. nach `loadAll()`-Refresh oder Filter-Anpassung). Methoden des Karten-Scopes (`ownerlessBooks()`) sind erlaubt.
- `defaultKey` / `defaultDir` (`asc` | `desc`): Initial-Sort, falls kein persistierter State.
- `persistKey` (optional): Schluessel unter `localStorage["sortableTable.<persistKey>"]`. Ohne Key wird der Sort-Zustand nicht persistiert.
- `types` (optional): pro Spalte `number` | `date` | `string`. Ohne Eintrag wird der Typ aus dem ersten Non-Null-Sample-Wert geraten (ISO-Datum, Number, sonst String mit Locale-Compare). `null`/`undefined` sinkt immer ans Ende, unabhaengig von `dir`.
- `<th>` Pflicht-Attribute: `class="sortable-th"` (Cursor + Chevron-Platz), `:class="sortClass('key')"` (asc/desc-Modifier), `:aria-sort="ariaSort('key')"` (Screen-Reader), `@click="sortBy('key')"` (Toggle asc→desc, oder neuer Key → asc).
- Spalten ohne Sortier-Sinn (Action-Buttons, ungeordnete Render-Spalten wie „Status mit Badge" wenn Sort darueber nichts bringt): `<th>` ohne `sortable-th` lassen.

**CSS:** [public/css/components/sortable-table.css](public/css/components/sortable-table.css). Chevron-Pfeile via CSS-Triangles (currentColor → theme-faehig). Inaktive Spalte zeigt doppeltes Pfeil-Paar gedimmt, aktive Richtung voll opaque.

**JS:** [public/js/sortable-table.js](public/js/sortable-table.js). Reine Pure-Funktion `sortRows(rows, key, dir, typeHint)` ist exportiert fuer Unit-Tests (siehe [tests/unit/sortable-table.test.mjs](tests/unit/sortable-table.test.mjs)).

**Wann nicht:** Server-Pagination oder Server-Sort noetig (z.B. Admin-Logs mit > 10k Rows) → eigene Route + Cursor-Pagination; `sortableTable` kann den Server-Result-Slice nicht ueber alle Seiten sortieren. Presence-Matrizen ([bookoverview-figpresence.html](public/partials/bookoverview-figpresence.html), [bookoverview-ortpresence.html](public/partials/bookoverview-ortpresence.html)) und Heatmap-Tabellen (`.heatmap-table`) sind ebenfalls ausgenommen — feste Spalten/Zeilen-Semantik, kein Row-Sort sinnvoll.

---

**Falle: Padding-Shorthand auf `th` frisst den Chevron-Platz.** `.sortable-th`
reserviert ihn mit `padding-right: calc(var(--space-md) + 14px)` — die Regel liegt
aber in `@layer components`, und eine ungelayerte Feature-Datei (`public/css/entities/…`)
gewinnt unabhängig von der Ladereihenfolge. Wer im eigenen Stylesheet
`.xxx-table th { padding: … 0; }` setzt, überschreibt sie und das Sortier-Chevron
sitzt im Spaltentitel. Dann den Platz für sortierbare Köpfe explizit zurückholen:
`.xxx-table th.sortable-th { padding-right: calc(var(--space-md) + 14px); }`.

---

## Aktions-Spalte in Tabellen

**Use:** Die letzte Spalte einer Listen-/Verwaltungstabelle mit Zeilen-Aktionen (Anheften, Archivieren, Loeschen, Oeffnen). Icon-Buttons nach der [Action-Icon-Library](#action-icon-library-verbindlich).

**Markup — die Knoepfe liegen in einem Kasten IN der Zelle, nicht direkt in ihr:**
```html
<td class="mybooks-actions">
  <div class="mybooks-actions-row">
    <button type="button" class="icon-btn icon-btn--ghost" …>…</button>
    <button type="button" class="icon-btn icon-btn--ghost" …>…</button>
  </div>
</td>
```

**CSS:**
```css
.mybooks-actions-row {         /* Wrapper traegt das Layout */
  display: flex;
  gap: var(--space-2xs);
  justify-content: flex-end;
}
```
Die Zelle selbst bekommt **kein** `display`. Braucht sie nur Ausrichtung und keinen Abstand zwischen den Knoepfen, reicht die schlanke Form ganz ohne Wrapper: `.xxx-actions { text-align: right; white-space: nowrap; }` (so in [admin-users.css](public/css/admin/admin-users.css), [admin-settings.css](public/css/admin/admin-settings.css)).

**Harte Regel: kein `display: flex|grid|block` auf einer `<td>`/`<th>`-Klasse.** Damit verliert die Zelle ihre Tabellenzellen-Rolle — der Browser schiebt eine anonyme Zelle darum, und ab da laufen Rahmen, Hintergrund, Zeilenhoehe und `vertical-align` der Spalte nicht mehr mit der Zeile mit, sondern nur noch mit dem Inhalt. Die Aktions-Spalte sitzt dann sichtbar versetzt neben ihrer eigenen Zeile. Der Fehler ist im Code unsichtbar: HTML und CSS sind je fuer sich korrekt, erst ihre Kombination bricht das Layout. Gegated durch [tests/unit/table-cell-display.test.mjs](tests/unit/table-cell-display.test.mjs) — neue Zellen-Klasse mit `display:*` → CI rot. Erlaubt bleiben `display: none` (Spalte ausblenden) und `display: table-cell` (Rueckkehr zur Rolle).

**Am rechten Rand mitlaufen lassen** (breite Tabelle in `.table-scroll`): `position: sticky; right: 0;` plus eigener `background` und `border-left` gehoeren an die **Zelle** — sticky funktioniert auf `<td>`/`<th>`, und nur dort deckt die Flaeche die volle Zeilenhoehe ab. Beispiel: `.mybooks-table th:last-child, .mybooks-actions` in [my-books.css](public/css/components/my-books.css).

**Kein `sortable-th`** auf dem Kopf der Aktions-Spalte — sie hat keine Sortier-Semantik (siehe [Sortierbare Tabelle](#sortierbare-tabelle-sortabletable)).

## Card-Status / Loading / Empty / Error

| Zustand        | Klasse               | Inhalt |
|----------------|----------------------|--------|
| Loading        | `.card-status`       | i18n-Status + optional `.progress-bar-wrap` darüber |
| Empty          | `.card-status`       | `$app.t('common.noDataYet')` |
| Error          | `.card-status--error`| Fehlermeldung als i18n-Key |

Niemals reine `<div>`s mit Inline-Text dafür — immer durch `.card-status*`-Klassen.

---

## Chevron-Konventionen

| Pattern | Glyph (Fallback) | Lucide-Icon | Rotation |
|---------|------------------|-------------|----------|
| Collapsible-Toggle (`.history-chevron`) | `›` | `chevron-right` (gerendert via `mask: var(--icon-chevron-right)`) | 0° → 90° (Klasse `.open`) |
| Combobox-Trigger (`.combobox-chevron`) | `▾` | (noch Unicode-Glyph; auf `chevron-down`-Mask migrieren, sobald Touch) | 0° → 180° (Klasse `--open`) |
| Disclosure (sonstig) | nicht erfinden — vorhandenes Muster nehmen |

Markup-Fallback-Glyph (`›`) bleibt im DOM, wird per `text-indent: 100%; overflow: hidden` versteckt. Schadlos bei deaktiviertem CSS, kein Screen-Reader-Lärm (Konsumenten setzen `aria-hidden="true"` am Chevron-Span).

Kein neuer Marker ohne Eintrag hier.

---

## Feature-Text (Landing + Hilfe)

**Use:** Die Kurzbeschreibung eines Features, die in der öffentlichen Landing-Page **und** in der In-App-Hilfe als Kachel steht. Beide lesen dieselben i18n-Keys `landing.feat<N>Title` / `landing.feat<N>Desc` (SSoT, siehe CLAUDE.md „Hilfe-Karte + Landing pflegen").

**Markup:** Kachel in einem Raster — [landing.html](public/landing.html) `li.public-feature`, [help.html](public/partials/help.html) `li.help-feature`. Beide sind `<h3>` + `<p>`, kein Markdown, keine Links, keine Icons. Die Hilfe zeigt **alle** Nummern aus `HELP_FEATURES`, die Landing-Page bewusst nur die ersten als kuratierten Einstieg — dieselben Keys, dieselbe Reihenfolge, kein zweiter Textsatz.

**Regeln:**
- **Titel: 1–3 Wörter, höchstens 26 Zeichen.** Der Name des Features, nicht seine Erklärung — kein „und", kein Klammerzusatz, kein Doppelpunkt-Anhang. Steht auf einer Zeile, auch mobil.
- **Beschreibung: 160–200 Zeichen, ein bis zwei Sätze.** Das ist der harte Rahmen; **Why:** die Kacheln liegen im selben Raster nebeneinander, und ein 700-Zeichen-Block neben einem 80-Zeichen-Block lässt das Raster zerfallen und die kurzen Features nebensächlich wirken. Der Rahmen gilt **für alle Features gleich** — ein neues, komplexes Feature bekommt keinen längeren Text als „Export", es bekommt einen schärferen.
- **Inhalt: was es tut, dann der eine Unterschied.** Satz 1 nennt die Sache in der Sprache des Autors (nicht der Architektur). Satz 2 nennt genau **eine** Eigenschaft, die das Feature von der naheliegenden Erwartung abhebt. Kein dritter Gedanke — der gehört in die Deep-Doc unter [docs/](docs/).
- **Nicht hineinschreiben:** Tabellen-/Spalten-/Routen-/Job-Namen, Dateipfade, Konfigurations-Keys, Begründungen im **Why:**-Stil, Aufzählungen mit mehr als vier Gliedern, Zukunftsversprechen.
- **Beide Locales im selben Commit**, in derselben Länge — `de` ist nicht die Langfassung von `en`.
- **Reihenfolge = Erscheinungsreihenfolge**: `<N>` hängt hinten an, das neueste Feature steht unten. Bestehende Nummern nie umnummerieren (der Landing-Block trägt sie hartcodiert).

**Gate:** [tests/unit/landing-feature-text.test.mjs](tests/unit/landing-feature-text.test.mjs) — Titel-/Beschreibungslänge in beiden Locales, Lückenlosigkeit von `HELP_FEATURES`, Landing als Prefix davon.

**Beispiele:** `landing.feat6Desc` (Export — breites Feature, ein Satz Umfang + ein Satz Beigabe), `landing.feat23Desc` (Buchlandkarte — abstraktes Feature, Satz 1 sagt was es ist, Satz 2 was man sieht).

---

## Mikro-Typografie (Memory-Regeln)

- **Doppelpunkt als Funktion-Separator:** `Funktion: Target` mit `:`. Nicht `·` (das ist Listen-Trenner für gleichwertige Items).
- **Schweizer Zahlen:** Dezimal `.`, Tausender `’` (Apostroph). Locale-Tag `de-CH`.
- **Keine Icons/Emojis** ohne ausdrückliche Aufforderung. Disclosure-Marker (Chevron) zählen nicht als Icons.
- **Style-Konsistenz:** Eine Style-Entscheidung gilt für alle vergleichbaren Elemente. Wer eine Komponente neu macht, prüft, ob ähnliche bereits existieren — und passt entweder die existierenden mit an oder übernimmt deren Stil.

---

## Mobile-Breakpoints + Darkmode

**Pflicht:** Jede neue CSS-Klasse / UI-Komponente bekommt im selben Commit **beides**: Mobile-Breakpoint + Darkmode-Verhalten. Nie auf später verschieben.

### Mobile

`@media (max-width: 600px)` ist der Pflicht-Default. CSS-Custom-Properties funktionieren in `@media` nicht — die Werte stehen also als Zahlen im Code und driften ohne Disziplin sofort auseinander.

**Kanonische Leiter — neue Regeln wählen ausschliesslich hieraus:**

| Wert | Rolle | Nutzung |
|---|---|---|
| `480px` | Phone-Small (sehr enge Devices, harter Reflow) | 26 |
| `600px` | Phone-Large — **Default-Mobile-Breakpoint** | 51 |
| `768px` | Tablet | 10 |
| `960px` | Desktop — hier schaltet [layout/twocolumn.css](public/css/layout/twocolumn.css) von einspaltig auf Sidebar+Main | 5 |

**Dokumentierte Abweichungen** (bestehend, nicht ausbauen — neue Komponenten nehmen die Leiter oben):

| Wert | Warum | Nutzung |
|---|---|---|
| `700px` | dichte Karten-Raster, die schon vor Tablet-Breite umbrechen müssen (Recherche-Dialog, Szenen, Figur-Werkstatt, Kapitel-Übersicht) | 22 |
| `640px` | schmales Band für Leisten mit fixer Mindestbreite (Share-Reader-Vorlese-Dock + Leseoptionen, Revisions-Viewer, Folder-Import) | 21 |
| `720px` | Tabellen, die eine Spalte früher als das Tablet-Raster fallen lassen | 7 |
| `860px` | Satzbreite des Body (`max-width: 860px` in [layout/base.css](public/css/layout/base.css)) — die Dialoge spiegeln sie | 2 |
| `1100px` / `1700px` | Kommentar-Schiene des Share-Readers: ab hier ist Platz für die Margin-Rail bzw. für eine zweite Spalte daneben | 6 |
| `1280px` | breite Übersichts-Raster | 2 |
| `800px` | Bucheditor-Stream | 1 |

**Zwei Regeln zur Grenzziehung:**
- **`min`/`max` am selben Wert überlappen.** `max-width: 600px` und `min-width: 600px` greifen bei exakt 600 px **beide**. Wer ein Paar bildet, nimmt `max-width: N` / `min-width: N+1` (so gelöst in [share/layout.css](public/css/share/layout.css) + [share/comments.css](public/css/share/comments.css)). Ausnahme ist die mobile-first-Leiter ohne Gegenstück (`body`-Padding in [layout/base.css](public/css/layout/base.css)) — dort gibt es kein Paar.
- **`959.98px` neben `min-width: 960px` ist Absicht**, kein Tippfehler: bei fraktionaler Viewport-Breite (Browser-Zoom, 1.5×-DPI) würden ganzzahlige Grenzen beide oder keine greifen. Nicht „aufräumen".

`1024px` gibt es nicht — der Wert stand hier lange als Soll, kam im Code aber nie vor; die Desktop-Grenze ist `960px`.

### Darkmode

Toggle via `:root[data-theme="dark"]`. **Regel:** Farben/Backgrounds/Borders/Shadows nur über Tokens (`--color-text`, `--color-muted`, `--color-subtle`, `--color-faint`, `--color-bg`, `--color-surface`, `--color-border`, `--shadow-*`, `--card-accent-*`) — kein hartcoded `#hex`/`rgb()`. Tokens spiegeln Light/Dark automatisch in [tokens/colors.css](public/css/tokens/colors.css).

Pflicht-Check pro neuer Klasse:
1. Im Dark-Theme öffnen — Kontrast lesbar? (`--color-text` auf `--color-surface` ≥ 4.5:1)
2. Borders sichtbar? (`--color-border`, für Eingaben `--color-border-input`, nicht statisches `#ddd`)
3. Akzentfarben aus `--card-accent-*` (Light-Hue als `-base`-SSoT, Dark im Token-Block per OKLCH abgeleitet)?
4. Image/SVG-Assets: hellem Theme-Hintergrund nicht unsichtbar (z. B. dunkles SVG-Icon auf dunklem Surface → `currentColor` oder Theme-spezifischer Filter)?

Neuer Hue / Surface / Border: Token in beiden Theme-Blöcken (`:root` + `:root[data-theme="dark"]`) in [tokens/colors.css](public/css/tokens/colors.css) ergänzen. Kein Pro-Karten-`[data-theme="dark"]`-Override — alles über Tokens.

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

CSS in [public/css/layout/utilities.css](public/css/layout/utilities.css). Mobile (≤600 px) bricht automatisch auf Spalte (`flex-direction: column; align-items: flex-start`).

**Wichtig:** Bestehende Sub-Header-Klassen (`.figur-list-header`, `.figur-szene-header` etc.) haben kontextspezifische Sonderlogik (Margins, Borders, Padding) und bleiben unverändert; die Util-Klasse ist Default für **neue** Header-Zeilen.

---

## Layout

### Regel: Karten-Inhalt nutzt die volle Breite

Listen, Zeilen und Card-Inhalte spannen **immer** die volle verfügbare Card-Breite. Keine `max-width`-Klammer und keine künstliche Lese-Breite, die auf breiten Screens (1440 px+) eine leere Spalte rechts hinterlässt — das wirkt wie ein Bug, nicht wie Absicht. Gestreckte Zeilen (Name links, Aktion/Badge rechts) sind erwünscht; sie werden über Flex/Grid-Spaltenstruktur sauber ausgerichtet, **nicht** über eine Breitenbegrenzung gebändigt. Gilt insbesondere für Figuren-Liste (`.figur-item`) und Buchorganizer (`.organizer-page`).

### Zwei-Spalten (Sidebar + Main)

**Use:** Haupt-Editor-Layout (Tree links, Editor mittig, optional Chat rechts).

**Klassen** [public/css/layout/twocolumn.css](public/css/layout/twocolumn.css):
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

CSS: [public/css/layout/utilities.css](public/css/layout/utilities.css). Auf Mobile (`max-width: 480px`) stapelt sich der Inhalt automatisch.

---

## Confirm-Dialog (Modal)

**Use:** Destruktive Aktionen bestätigen (Löschen, Reset, Logout) **und** „Verwerfen ungespeicherter Änderungen" (Editor-Cancel, Reload einer Card mit dirty State, Page-Wechsel mit ausstehenden Edits).

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

CSS: [public/css/components/confirm-dialog.css](public/css/components/confirm-dialog.css). Varianten `--primary` und `--danger`. Niemals native `confirm()` verwenden.

**Unsaved-Changes-Pattern (Reuse, nicht parallel erfinden):** der einheitliche Discard-Dialog läuft über `appConfirm({ message, confirmLabel: t('edit.discardEdit'), danger: true })`. Beispiele: [editor/edit.js#cancelEdit](public/js/editor/edit.js), [figur-werkstatt-card.js#onCardRefresh](public/js/cards/figur-werkstatt-card.js). Pro Feature einen i18n-Key für die Frage (z. B. `edit.cancelConfirm`, `app.switchPageConfirm`, `werkstatt.confirmReload`); der Confirm-Button-Text bleibt der gemeinsame `edit.discardEdit` („Verwerfen" / „Discard").

---

## Danger-Zone (`.danger-zone`)

**Use:** unwiderrufliche Aktionen am Ende einer Karte sichtbar absetzen (Konto löschen, Buch löschen, Verlauf zurücksetzen, Restore). Nicht für „normale" Löschungen einzelner Listeneinträge — dort genügt der `--danger`-Icon-Button plus `appConfirm`.

**Markup:**
```html
<div class="danger-zone">
  <div class="danger-zone-title">
    <svg class="icon" aria-hidden="true"><use href="/icons.svg?v=693#alert-triangle"/></svg>
    <span x-text="$app.t('…')"></span>
  </div>
  <!-- mehrere Aktionen: je eine .danger-zone-section (Trennlinie kommt automatisch) -->
  <div class="danger-zone-row">
    <div class="danger-zone-text" x-text="$app.t('…')"></div>
    <div class="danger-zone-actions">
      <button type="button" class="danger-zone-btn" @click="…" :disabled="busy">…</button>
    </div>
  </div>
  <p class="card-form-error" x-show="err" x-text="err"></p>
</div>
```

CSS: [public/css/components/danger-zone.css](public/css/components/danger-zone.css). Farben aus den Fehler-Tokens (`--color-err-*`), **nicht** aus `--card-accent` — die Aussage ist „Achtung", nicht „gehört zu dieser Karte".

**Im Form-Grid einer Karte braucht der Block die volle Breite:** Wrapper `<div class="card-form-row card-form-row--full">`. Ohne den Modifier landet die labellose Zone in der 170px-Label-Spalte des `.card-form-row`-Rasters und läuft über deren Rand hinaus. Gilt genauso für jeden anderen labellosen Voll-Breite-Inhalt (z.B. die Versions-Fusszeile im Profil).

**Bestätigung ist Pflicht** und läuft über `appConfirm`/`appPrompt`, nie über native `confirm()`. Bei Aktionen, die nicht nur Daten einer Ansicht, sondern ein ganzes Konto oder Buch treffen, zwei Stufen: Warnung bestätigen, dann ein Wort tippen (`appPrompt`). Beispiel: [user-settings.js#deleteAccount](public/js/user-settings.js).

**Zwei Altbestände**, die dasselbe Muster handkopiert enthalten: `.book-settings-danger-*` ([analysis/kontinuitaet.css](public/css/analysis/kontinuitaet.css), Markup [partials/book-settings-danger.html](public/partials/book-settings-danger.html)) und `.admin-backup-danger*` ([admin/admin-backup.css](public/css/admin/admin-backup.css)). Sie ziehen bei der nächsten Berührung auf `.danger-zone` nach; **neue** Vorkommen nutzen ausschliesslich die generischen Klassen.

---

## Modal-Shell (`modal`)

**Use:** ein selbst-tragendes Overlay-Panel (Tastenkürzel-Hilfe, Info-/Detail-Dialog), das nicht der geteilte Confirm-Dialog (`appConfirm`/`appPrompt`) und keine generische Bestätigung ist. Kapselt das überall gleiche `<dialog>`-Boilerplate: `showModal()`/`close()` an einen Boolean koppeln, ESC-Routing, Backdrop-Klick und Fokus-Restore. **Alle App-Modals nutzen das native `<dialog>` + `showModal()`** — Focus-Trap, Inert-Hintergrund und ESC kommen vom Browser (kein eigener Overlay-Div, kein selbstgebauter Focus-Trap; `window.confirm()` reisst Chrome auf macOS aus dem Vollbild-Space).

**Markup** ([public/js/modal.js](public/js/modal.js) — `x-data` liegt direkt auf dem `<dialog>`):
```html
<!-- A: Event-getriggert (Pattern wie book-create:open) -->
<dialog class="shortcuts-panel" x-data="modal({ openOn: 'shortcuts:open' })">
  <button @click="close()" …>×</button>
  …Inhalt (bare t() löst über die Scope-Vererbung zum Root auf)…
</dialog>

<!-- B: Flag-gesteuert (Parent koppelt seinen Boolean) -->
<dialog x-data="modal()" x-modelable="open" x-model="shortcutsOpen">…</dialog>
```

**Regeln:**
- Panel-CSS bleibt beim Konsumenten (eigene `.*-panel`-Klasse + `::backdrop`). Das Primitiv liefert nur Verhalten, kein Styling.
- **`margin: auto` ist Pflicht in jeder Panel-Klasse** — der globale Reset ([layout/base.css](public/css/layout/base.css), `* { margin: 0 }`) schlägt die UA-Regel `dialog { margin: auto }`, und ein `showModal()`-Dialog mit `margin: 0` klebt bei `inset: 0` in der linken oberen Ecke statt in der Bildmitte. Nicht per `dialog { … }`-Regel global reparieren (das Primitiv liefert kein Styling); die Zeile gehört in jede `.*-dialog`/`.*-panel`-Klasse — so wie in `.confirm-dialog`, `.book-create-dialog`, `.research-dialog`, `.revision-viewer`, `.diagram-dialog`.
- Öffnen: entweder `openOn`-Event (`window.dispatchEvent(new CustomEvent('…'))`) **oder** den per `x-model` gekoppelten Boolean auf `true` setzen. Schliessen: `close()` (oder Flag `false`). ESC/Backdrop schliessen automatisch (per `dismissable: false` abschaltbar, z. B. während eines Submits via `setDismissable(false)`).
- Backdrop-Klick erkennt `event.target === <dialog>` — der Panel-Inhalt sollte ein Kind sein, nicht das `<dialog>` selbst stylen.
- Für Dialoge mit **eigener Karten-Logik** (book-create) bleibt die Karten-`x-data` auf dem `<dialog>`; sie steuern `showModal()/close()` weiter selbst — das Primitiv ist für **präsentative** Modals.
- **Dialog INNERHALB eines Karten-Scopes** (Detailansicht eines Listeneintrags, Revisions-Viewer): kein `modal()`, sondern `x-ref` + `showModal()` aus einer Karten-Methode, `@close` als **einziger** Aufräum-Punkt (ESC, Backdrop und Button laufen alle über `dlg.close()`). So bleibt ein einzelnes Feld die SSoT dafür, welcher Eintrag offen ist, statt Boolean + ID parallel zu führen. Referenzen: [recherche-detail.html](public/partials/recherche-detail.html) (+ `openDetail`/`closeDetail` in [recherche/items.js](public/js/book/recherche/items.js)), [page-revisions.html](public/partials/page-revisions.html). Pflicht dabei: den Dialog schliessen, wenn die Karte zugeht (`$watch` auf den Show-Flag) — ein offenes Dialog hält das Dokument inert, auch wenn die Karte darunter `display:none` ist.
- **Verschachtelte Dialoge sind erlaubt und funktionieren:** `appConfirm` ist selbst ein `<dialog>` und landet im Top-Layer **über** einem bereits offenen — Löschen/Entfernen darf also aus einer Detailansicht heraus bestätigt werden. Ein z-index-basiertes Overlay dagegen läge hinter dem `::backdrop`.
- Nicht für Bestätigungen/Prompts: dort `appConfirm`/`appPrompt`/`appAlert` (siehe „Confirm-Dialog").

**Beispiele:** [shortcuts.html](public/partials/shortcuts.html) (Variante A/B kombiniert: `x-model="shortcutsOpen"`, `?`-Hotkey togglet den Root-Flag).

---

## Overlay-Focus-Trap (`x-trap`)

**Use:** Ein Overlay, das **kein** natives `<dialog>` sein kann (weil es in eine Vollbild-Karte teleportiert wird oder im Top-Layer mit `showModal()` kollidieren würde), aber den Bildschirm blockiert. Erste Wahl bleibt `<dialog>` + `showModal()` — Trap, Inert-Hintergrund und ESC kommen dort vom Browser (siehe „Modal-Shell"). `x-trap` ist der Ersatz für die Fälle, in denen das nicht geht.

```html
<div class="palette-overlay" x-show="paletteOpen" x-cloak
     x-trap.inert="paletteOpen">…</div>
```

**Modifier-Wahl:**
- **`.inert` immer** — blendet alle Geschwister bis zum Body per `aria-hidden` aus. Ohne das liest ein Screenreader die Seite hinter dem Overlay weiter vor. (Setzt **kein** `inert`-Attribut, blockiert also keine Klicks.)
- **`.noscroll` nur, wenn die Komponente den Hintergrund nicht schon selbst festhält.** Palette und Fassungs-Reader nutzen die Projekt-Konvention `body.<name>-open { overflow: hidden; overscroll-behavior: contain }` — dort **kein** `.noscroll`, sonst zwei Mechanismen für dieselbe Sache. Wo es genutzt wird, ist es sprungfrei: `html` trägt `scrollbar-gutter: stable` ([base.css](public/css/layout/base.css)), deshalb setzt das Plugin nur `overflow: hidden` und kompensiert keine Scrollbar-Breite.
- **`.noautofocus.noreturn`**, wenn die Komponente Fokus und Restore selbst fährt (Palette: sie merkt sich das Rückkehr-Ziel **vor** dem Fokussieren ihres Suchfelds; der Trap aktiviert 15 ms später und würde als Ziel das Suchfeld selbst sehen). Sonst weglassen — dann erledigt der Trap beides.

**Nicht auf nicht-blockierende Leisten.** Die Find-Leisten in Notebook- und Bucheditor liegen über dem Text, aber man klickt aus ihnen heraus ins Manuskript. focus-trap holt den Fokus in seinem `focusin`-Handler bedingungslos zurück (`allowOutsideClick` erlaubt nur den Klick, nicht den Fokuswechsel) — der Cursor käme nie im Text an. Dort bleibt der reine Tab-Zyklus `trapFocus($event, $el)` aus [editor/shortcuts.js](public/js/editor/shortcuts.js).

**Beispiele:** [palette.html](public/partials/palette.html), [conflict-resolution.html](public/partials/conflict-resolution.html) (`.inert.noscroll`, Trap fährt auch Autofokus + Restore), [snapshots-reader.html](public/partials/snapshots-reader.html).

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

**Seiteninhalt** (Notebook-Editor Read-Modus, Prosa-Schimmer): `.page-content-skeleton` + n× `.page-content-skeleton__line` (`x-for="i in 8"`). Sitzt anstelle der `.page-content-view`, solange `pageContentLoading && !renderedPageHtml` — verhindert die blanke Fläche bei langsamem Netz / kaltem SW-Cache (ein langsamer Seiten-Load liest sonst wie „Inhalt weg"). An dieselbe Lesebreite ausgerichtet. CSS: [page/page-content-skeleton.css](public/css/page/page-content-skeleton.css).

Kein Skeleton ohne Shimmer-Animation. CSS-File-Referenzen: [entity-list.css](public/css/entities/entity-list.css), [chat.css](public/css/chat.css), [page-content-skeleton.css](public/css/page/page-content-skeleton.css).

---

## Karten-Toolbar (`.card-toolbar`)

**Use:** Aktionszeile im Karten-**Body** (nicht im Header): Anlege-/Import-Buttons, danach optional eine eingebettete Filterleiste. Abgrenzung: `.card-actions` ist die Icon-Leiste im Header.

**Markup:**
```html
<div class="card-toolbar">
  <button type="button" class="btn-compact">
    <svg class="icon" aria-hidden="true"><use href="/icons.svg?v=694#plus"/></svg>
    <span x-text="$app.t('xxx.new')"></span>
  </button>
  <div class="filter-bar filter-bar--inline">…</div>
</div>
```

`.card-toolbar` ([card-form/card-shell.css](public/css/components/card-form/card-shell.css)) setzt Flex + `flex-wrap` + `gap: --space-sm` + `align-items: center` + `margin-bottom: --card-gap-section` und richtet enthaltene `.btn-compact` inkl. `1em`-Icon aus. **Kein Nachbau pro Karte** — die Zeile mischt Buttons mit Compact-Controls, deren gemeinsame Mittellinie an genau diesen Werten hängt.

**Nicht darauf umstellen:** Toolbars mit bewusst eigener Geometrie — `.organizer-toolbar` (`nowrap`), `.figuren-graph-toolbar` (`space-between`), `.motiv-toolbar` (`padding` statt `margin`), `.page-editor-toolbar`/`.edit-bubble-toolbar` (Editor-Chrome).

**Mobile:** karten-eigene Abweichungen über die Akzent-Klasse der Karte scopen (`.card--sources .card-toolbar .btn-compact { width: 100% }`), nicht durch eine zweite Toolbar-Klasse.

**Konsumenten:** [sources.html](public/partials/sources.html), [recherche.html](public/partials/recherche.html).

---

## Filter-Bar (Listenfilter)

**Use:** Such-/Filtereingaben oberhalb von `.entity-list`-Listen.

**Markup:**
```html
<div class="filter-bar">
  <span class="filter-search-wrap">
    <input class="filter-search-input" type="text" :placeholder="$app.t('common.search')" x-model="filterText">
    <button type="button" class="search-clear--icon" x-show="filterText" @click="filterText=''"
            :aria-label="$app.t('search.clear')" :data-tip="$app.t('search.clear')">
      <svg class="icon" aria-hidden="true"><use href="/icons.svg?v=636#x"/></svg>
    </button>
  </span>
  <span class="filter-count" x-text="filteredItems.length + ' / ' + items.length"></span>
</div>
```

Das Suchfeld sitzt in einem `.filter-search-wrap` (position:relative) zusammen mit dem
Clear-X. `.search-clear--icon` ist der wiederverwendbare X-Button (aus [search.css](public/css/search.css),
geteilt mit der Sidebar-Page-Suche) — nur sichtbar (`x-show`), wenn das Suchfeld befüllt ist.

**Bausteine** (alle in [entity-list.css](public/css/entities/entity-list.css), frei kombinierbar):

| Klasse | Wirkung | Wann |
|---|---|---|
| `.filter-bar` | Eigenständige Filterzeile über der Liste, mit Unterrand als Abschluss | Default — direktes Kind der Karte |
| `.filter-bar--inline` | Nimmt das Standalone-Chrome zurück (kein Unterrand/`padding-bottom`/`margin-bottom`) + `flex: 1` | Leiste sitzt in einer `.card-toolbar` neben Buttons |
| `.filter-search-input--wide` | Suchfeld wird 12rem breit + wachsend statt der 120px-Default-Spalte | Freitext ist das Hauptfilter der Leiste |
| `.filter-toggle` | `<label>` mit Checkbox in Compact-Typografie der Nachbarn | Boolean-Filter („Archivierte anzeigen") |
| `.filter-count` | Trefferzähler, per `margin-left: auto` ans rechte Ende | Optional, immer letztes Kind |

**`.filter-bar--inline` ist Pflicht in einer Toolbar-Zeile.** Ohne den Modifier zählen die 10 px `padding-bottom` + 1 px Unterrand der Standalone-Variante bei `align-items: center` zur Box-Höhe: alle Controls sitzen ~5,5 px über der Mittellinie der Buttons daneben, und die Trennlinie läuft nur unter dem Filter-Teil der Zeile. Konsumenten: [sources.html](public/partials/sources.html), [recherche.html](public/partials/recherche.html).

**Severity-/Wertungs-Filter:** generisches `.tabs` / `.tabs-btn` (siehe Tabs-Sektion oben). Kein eigenes Filter-Pattern. Beispiele: [public/partials/kontinuitaet.html](public/partials/kontinuitaet.html), [public/partials/szenen.html](public/partials/szenen.html).

**Kapitel-/Kategorie-Filter:** Compact-Combobox (`x-data="combobox(...)"`, rendert `.combobox-wrap--compact`). Beispiele: [public/partials/world-facts.html](public/partials/world-facts.html), [public/partials/songs.html](public/partials/songs.html).

**Höhen-Invariante (Pflicht):** Alle Controls in einer `.filter-bar` — Suchfeld (`.filter-search-input`), Compact-Combobox (`.combobox-wrap--compact`) und Tabs (`.tabs` / `.tabs-btn`) — rendern auf **identischer Höhe** (~26.8px). Sie teilen font-size 12px (`--font-size-mini` / `--size-compact-font-size`), vertikales Padding 4px (`--space-xs` / `--size-compact-padding`), 0.5px-Border **und** `line-height: 1.4`. Die Angleichung lebt in [public/css/entities/entity-list.css](public/css/entities/entity-list.css) und greift automatisch für alle Filter-Bars. **Spezifitäts-Falle:** Das Suchfeld ist ein `<input type="text">` und wird daher von der generischen Form-Regel `input[type=text]` (card-form.css, Spezifität 0,1,1) getroffen — eine nackte `.filter-search-input`-Klasse (0,1,0) verliert dagegen und das Feld käme in Default-Grösse (14px/8px → höher als die Combobox). Darum ist die Compact-Regel als `.filter-bar .filter-search-input` (0,2,0) gescoped. Combobox-Trigger und Tabs-Button sind `<button>`, von der Input-Regel nicht betroffen, brauchen aber explizites `line-height: 1.4` (sonst geerbtes `normal` ~1.2 → niedriger). **Neuer Control-Typ in einer Filter-Bar** → dieselben 4 Werte (Font/Padding/Border/line-height) treffen und auf genügend Spezifität achten, sonst sitzt er höher/tiefer als die Nachbarn.

**Mittellinien-Invariante (Pflicht, gilt für jede zentrierte Zeile):** Ein Control in einer Zeile mit `align-items: center` darf **keine einseitige vertikale Margin** tragen. Flex zentriert die **Aussen**box; eine Margin nur unten (oder nur oben) kippt die sichtbare Box um die halbe Margin gegen die Mittellinie der Nachbarn — bei 6px also 3px, genug um als „nicht zentriert" aufzufallen, und ohne Messen nicht als Margin erkennbar. Betrifft vor allem `<label>`: die globale `label`-Regel ([card-form/form-elements.css](public/css/components/card-form/form-elements.css)) trägt deshalb **bewusst kein `margin-bottom`** — vertikale Abstände zwischen Label und Feld kommen ausschliesslich aus dem `gap` des Containers (`.form-stack`, `.card-form-row`, `.form-inline`, `.setting-field`, `.admin-logs-filter`). Braucht ein Label als Block-Überschrift Abstand nach unten (Container ohne `gap`), setzt das seine eigene Klasse lokal — Muster: `.book-export-migration > .book-export-scope-label`. Gegated: [tests/unit/label-margin-drift.test.mjs](tests/unit/label-margin-drift.test.mjs). Dieselbe Falle bei `padding`: `.card-form-label` trägt `padding-top` für das zweispaltige `.card-form-row`-Raster (`align-items: start`); wird dieselbe Klasse in einer zentrierten Zeile wiederverwendet, muss sie dort auf `0` (Muster: `.export-profile-bar > .card-form-label`).

---

## Heatmap-Visualisierung

**Use:** Tabellarische Datenintensitäts-Darstellung (Stil-Heatmap, Fehler-Heatmap).

**Klassen** [public/css/analysis/heatmap.css](public/css/analysis/heatmap.css):
- `.heatmap-wrap` — Container
- `.heatmap-legend` — Skala oberhalb
- `.heatmap-scroll` — horizontaler Scroll-Container
- `.heatmap-table` — Tabelle mit sticky `thead`
- `.heatmap-rowhead` — sticky linke Spalte
- `.heatmap-cell--tinted` / `--primary` / `--faded` / `--empty` — Intensitätsstufen
- `.heatmap-cell--clickable` / `--active` — interaktiv

**Cluster-Header** (Fehler-Heatmap, > 10 Spalten): zweistufiger `<thead>`. Erste Zeile `.heatmap-cluster-row` rendert pro Cluster ein `<th class="heatmap-cluster-head" :colspan="N">` mit Cluster-Label (uppercase, klein, getrackt). Zweite Zeile rendert pro Typ ein `<th>` mit Typ-Label. Spalten an Cluster-Grenzen tragen `.heatmap-cluster-start` (linker Border in Typen-Reihe **und** Body) — Trennlinie zwischen Clustern. SSoT: `FEHLER_CLUSTERS`-Array in [public/js/fehler-heatmap.js](public/js/fehler-heatmap.js); Reihenfolge der Spalten = Reihenfolge im Cluster-Array. Helper `fehlerHeatmapClusterStarts` liefert die Cluster-Grenz-Indizes für die Trennlinien-Klasse.

**Detail-Drawer** unter Tabelle: `.heatmap-detail` mit `.heatmap-detail-list`/`-page`/`-token-groups`.

**Mode-Toggle innerhalb Heatmaps:** `.tabs` + `.tabs-btn` + `--active`. Identisch zur generischen Tabs-Sektion oben — kein eigenes Heatmap-Pattern, einfach `.tabs` wiederverwenden.

---

## Jahr×Monat-Heatmap

**Use:** Jahre als Zeilen × 12 Monate als Spalten, Zell-Intensität nach einer Monats-Kennzahl (z. B. Tagebuch-Eintragszahl). Kalender-artige Aktivitäts-Landkarte über mehrere Jahre. Zwei Konsumenten: **Rückblick-Karte** (History-Kalender, interaktiv) und **Buch-Übersicht** (Rückblick-Abdeckungs-Tile).

**Klassen** [public/css/components/year-month-heatmap.css](public/css/components/year-month-heatmap.css) (`@layer components`):
- `.ymheat` — Wrapper, `container-type: inline-size` (self-containing → `@container`-Breakpoints greifen in jedem Slot). Akzent über `--ymheat-accent` (Default `var(--color-accent)`; Konsument setzt ggf. die Karten-Hue). Höhe via `--ymheat-max` (Default `320px`).
- `.ymheat-scroll` / `.ymheat-grid` / `.ymheat-row` / `.ymheat-row--head` (sticky Monats-Kopf) / `.ymheat-corner` / `.ymheat-month-label`
- `.ymheat-year` (+ `--has` / `--active` / `:disabled`) — Jahres-Label links, klickbar.
- `.ymheat-cell` — Monatszelle. `--lvl0..4` (Dichte, `color-mix(--ymheat-accent, --color-bg)`-Stufen), `--has` (eckiger Rückblick-Marker), `--current` (Innen-Ring = aktueller Monat, TZ-aware), `--active` (Auswahl-Outline), `:disabled` (dimmt leere Zellen — nur der interaktive Konsument setzt es).
- `.ymheat-legend` / `.ymheat-legend-label` — Skala + Marker-Legende (kleine `.ymheat-cell`-Swatches).

**Math:** [public/js/book/ymheatmap.js](public/js/book/ymheatmap.js) — `quartileLevelFor(counts)` (Quartil-Bucketing der positiven Monatswerte → Level 0..4, analog `overviewStreakHeatmap`) + `currentMonthKey()` (aktueller Monat `YYYY-MM`, TZ-aware). Beide Konsumenten (`_computeRueckblickCalendar` in [tagebuch-rueckblick.js](public/js/book/tagebuch-rueckblick.js), `_computeRueckblickHeatmap` in [book-overview/diary.js](public/js/book-overview/diary.js)) delegieren an diese pure Helfer. Test: [tests/unit/ymheatmap.test.mjs](tests/unit/ymheatmap.test.mjs).

**A11y:** Jede Zell- und Jahres-`<button>` trägt neben `:data-tip` ein `:aria-label` mit derselben beschreibenden Zeichenkette — sonst haben die textlosen Monatszellen keinen zugänglichen Namen.

---

## Tree (Sidebar-Navigation)

**Use:** Hierarchische Buch-/Kapitel-/Seiten-Navigation in der Sidebar.

**Klassen** [public/css/page/tree-history.css](public/css/page/tree-history.css):
- `.tree-chapter` / `.tree-chapter-header` / `.tree-chapter-header--active`
- `.tree-chapter-meta` — Counter rechts
- `.history-chevron` / `.history-chevron.open` — wiederverwendetes Rotations-Pattern (0° → 90°)
- `.tree-chapter-pages::before` — visuelle Guide-Linie zu Children

Nur in Sidebar-Tree verwendet. Bei neuer hierarchischer Liste: erst prüfen, ob die Tree-Klassen passen.

---

## Jahres-Band (selbstgebaut)

**Use:** Kompaktes Jahres-Band über einer langen, datierten Liste — datierte Elemente werden je Kalenderjahr zu einer **Säule** gebündelt und von einer Baseline nach oben gestapelt (farbcodierte Marker pro Subtyp): hohe Säule = ereignisreiches Jahr, lesbar wie ein farbiges Histogramm. Klick auf einen Marker scrollt zum zugehörigen Listeneintrag und hebt ihn hervor. Übersicht + Navigation, **nicht** der Detail-Reader (das ist die Liste darunter). Erste Konsumentin: Ereignisse-Karte (Jahr-Achse über `globalZeitstrahl`).

**Warum kein vis-timeline (mehr):** Die Lib clusterte asynchron und stapelte ihre Achse erst ~1 s nach dem ersten Paint nach → sichtbares „Einklappen, dann Expandieren". Das Band ist rein DOM/CSS positioniert (`left` in Prozent, Spur via `--gz-band-lane`, von der Baseline aufwärts), rendert synchron aus dem Daten-Modell und erscheint sofort in finaler Höhe — kein Lazy-Lib-Load, kein Layout-Shift.

**Markup:**
```html
<div class="gz-layout">
  <div class="gz-band" x-show="timelineItemCount > 0" :style="{ '--gz-band-lanes': bandModel().lanes }">
    <div class="gz-band-track">
      <template x-for="tick in bandModel().ticks"><div class="gz-band-tick" :style="{ left: tick.x + '%' }">…</div></template>
      <template x-for="m in bandModel().markers">
        <button class="gz-band-marker" :class="…" :style="bandMarkerStyle(m)" :data-ev-id="m.id"
                :data-tip="…" @click="onBandMarkerClick(m.id)"></button>
      </template>
    </div>
  </div>
  <div class="gz-timeline-hint" x-show="…" x-text="…"></div>  <!-- Hinweis: N undatierte Events -->
  <div class="…list-body">…<div :data-ev-index="i">…</div>…</div>
</div>
```

**Klassen** [public/css/analysis/zeitleiste.css](public/css/analysis/zeitleiste.css) (`@layer components`, kein Vendor-Theme mehr):
- `.gz-layout` — Flex-Wrapper, `flex-direction: column` (Band oben, Liste darunter)
- `.gz-band` / `.gz-band-track` — Container + positioniertes Koordinatensystem; Höhe aus `--gz-band-lanes`. `.gz-band-track::after` = Baseline-Linie, auf der die Säulen aufsitzen (Marker via `bottom` von der Baseline aufwärts gestapelt).
- `.gz-band-tick` / `.gz-band-tick-label` — Jahres-Gridline (top→Baseline) + Label am Fuss (`--gz-axis-h`)
- `.gz-band-marker` (+ `--range` / `--more` / `--selected`) — eckiger Marker; Farbe via `--gz-marker-color` (solider Fill, dunklerer Rand)
- `.gz-timeline-hint` — Fussnote zu undatierten Events
- `.gz-meta` — fliessende Zeile in der Liste, bündelt Kapitel + Seite („wo") in **eine** Zeile statt zwei (dichteres Scannen); nur in der Ereignisse-Liste, **nicht** im Figuren-Detail-Zeitstrahl (dort Spalten-Layout mit Margins).

**Pure Layout-Helfer** (in [ereignisse-card.js](public/js/cards/ereignisse-card.js), getestet in [ereignisse-card-filter.test.mjs](tests/unit/ereignisse-card-filter.test.mjs)):
- `buildTimelineItems(events)` — nur Events mit `datum_year` werden Achsen-Items; `id` = Listen-Index.
- `layoutBandItems(items)` — Punkte je Kalenderjahr zu Säulen bündeln und von Spur 0 (Baseline) aufwärts stapeln; x in Prozent (Repräsentant = frühestes Event des Jahres, behält Boundary 0 %/100 %). Spannen liegen vorab als Balken auf den untersten Spuren (`baseLane`), Punkte stapeln darüber. Höhe gedeckelt bei `maxLanes` (Default 6): läuft eine Säule über, **ersetzt** EIN `kind:'more'`-Marker („+N"-Chip) die oberste Zelle — kollidiert nicht mehr mit Achse/Marker. Kein stilles Wegschneiden — jedes Event zählt in den Count, Klick springt zum ersten in der Liste.
- `bandAxisTicks(bounds)` — „nette" Jahres-Ticks (Schrittweite 1/2/5/10/…).
- `buildBandModel(events)` — fügt die drei zusammen; in der Karte über `memoizeByIdentity` an die gefilterte Liste gebunden.

**Regeln:**
- Marker-Farbe NICHT pro Subtyp als CSS-Selektor duplizieren, sondern `--gz-marker-color` inline via `:style` (`bandMarkerStyle`) auf `var(--card-accent-event-<subtyp>)` setzen (SSoT-Tokens, gleiche Codierung wie die Listen-Badges); `extern` → `--color-err-border`.
- `x` ist der Mittelpunkt eines Punkt-Markers (`translateX(-50%)`); Spannen (`--range`) starten bei `x` mit inline gesetzter `width` (kein Zentrieren).
- Datums-Bau via `setFullYear` (nicht `new Date(year,…)`) — sonst landen Jahre < 100 auf 1900+year.
- Klick auf Marker → `onBandMarkerClick(id)` → `scrollToEventIndex` + `selectedEventIndex`; Liste→Band über `selectTimelineEvent(i)` (hebt Marker hervor + scrollt ihn ins Bild).

**Beispiele:** [public/partials/ereignisse.html](public/partials/ereignisse.html), [public/js/cards/ereignisse-card.js](public/js/cards/ereignisse-card.js)

---

## Context-Menu (Rechtsklick-Popover)

**Use:** Sekundäre Aktionen pro Element via Rechtsklick (Desktop) bzw. Long-Press (Touch — noch nicht verdrahtet). Erste Konsumentin: Pagetree (`.pagetree-context-menu` für Pages + Chapters).

**CSS** [public/css/components/context-menu.css](public/css/components/context-menu.css):
- `.context-menu` — `position: fixed`, `z-index: var(--z-popover)`, Border + Shadow.
- `.context-menu-header` — Target-Name oben, gemuted + ellipsed.
- `.context-menu-item` — Volle Breite, Hover/Focus = `--color-hover`.
- `.context-menu-item--danger` — Rot getönt, Hover = `--color-err-bg`.
- `.context-menu-sep` — 1 px Trenner zwischen Gruppen.

**Markup:**
```html
<div class="context-menu pagetree-context-menu"
     role="menu"
     x-show="pageTreeMenuOpen"
     x-cloak
     :style="{ left: pageTreeMenuPos.left + 'px', top: pageTreeMenuPos.top + 'px' }"
     @click.stop
     @contextmenu.prevent>
  <div class="context-menu-header" x-text="target.name"></div>
  <button role="menuitem" class="context-menu-item" @click="action()">…</button>
  <div class="context-menu-sep" role="separator"></div>
  <button role="menuitem" class="context-menu-item context-menu-item--danger" @click="del()">…</button>
</div>
```

**Pflicht-Verhalten** (Konsumenten-Modul):
- `@contextmenu`-Handler nutzt `ev.preventDefault()` + setzt State (Open/Pos/Target).
- Position viewport-fixed via `clientX/Y`. Wenn das Menü in einem `transform`-Card-Ancestor lebt: Card-Rect-Offset abziehen (Containing-Block-Falle). Sidebar liegt ausserhalb transform — kein Offset nötig.
- Outside-Click via `document.addEventListener('mousedown', …, true)` (Capture-Phase) + Escape-Keylistener. Beide bei Hide entfernen.
- Viewport-Clamp: `Math.min(window.innerWidth - menuW - 8, x)`.
- `role="menu"`/`menuitem`-Attribute setzen, sonst kein A11y-Signal für Screen-Reader.
- Container hat `@contextmenu.prevent`, damit Rechtsklick im Menü kein verschachteltes Native-Menü öffnet.

**State-Form** (Beispiel Pagetree):
- `pageTreeMenuOpen: boolean`
- `pageTreeMenuPos: { left, top }`
- `pageTreeMenuTarget: { kind: 'page'|'chapter', id, name }`

**Wann nicht:** für selten genutzte Aktionen ohne klares Trigger-Element — Command-Palette ist dann passender (kein räumlicher Kontext nötig). Auch nicht für Bulk-Operationen — dafür gibt es Selection + Toolbar.

### Dropdown-/Aktions-Menü (Meatball, `⋯`) — verbindliche Harmonisierung

**Use:** Klick-gebundenes Menü an einem Trigger-Button, das sekundäre Aktionen eines Elements bündelt. **Alle** Meatball-/Overflow-Menüs der App nutzen ausschliesslich das `.context-menu`-Vokabular — kein per-Feature nachgebautes Popover-CSS (`*-menu-popover`, `*-context-menu` o.ä.). Konsumenten: Seiten-Action-Leiste ([editor-notebook.html](public/partials/editor-notebook.html), `pageActionsMenuOpen`), Notebook-Edit-Toolbar (sekundäre Controls, `.page-editor-toolbar` via `menu()`), Kapitel-Review-Header, Figur-Werkstatt-Header, Recherche-Item-Aktionen, Ideen-Karte, Plot-Strang-Lane, Figur-Werkstatt-Mindmap-Rechtsklick.

**Pflicht (für jedes Aktions-Menü):**
- **Trigger** ist ein Icon-Button `more-horizontal` (`.icon-btn icon-btn--ghost`), nie ein `⋯`/`≡`/`▾`-Glyph. `aria-haspopup="menu"` + `:aria-expanded` + `data-tip`/`aria-label` Pflicht.
- **Jeder Eintrag** ist `.context-menu-item.context-menu-item--icon` mit **führendem** `<svg class="icon"><use…></svg>` + `<span>`-Label (Reihenfolge: Icon, Label, optional `.btn-count` rechts). Kein nackter Text-Eintrag.
- **Aktions-Kategorien** werden durch `<div class="context-menu-sep" role="separator">` getrennt (z.B. Inhalt ↔ Status ↔ Dateien ↔ Löschen; „Teilen" ist eine eigene Kategorie). Ein `x-show` am Trenner muss dieselbe Bedingung tragen wie der Eintrag, den er einleitet.
- **Destruktiv** = zusätzlich `.context-menu-item--danger` (Icon `trash`). **Aktiv** (zugehörige Karte offen) = `.context-menu-item--on`.
- ARIA: `role="menu"` am Popover, `role="menuitem"` je Eintrag.
- Gegated durch [tests/unit/context-menu-icons.test.mjs](tests/unit/context-menu-icons.test.mjs) (jeder Eintrag hat Icon, jeder Trigger ist Icon-Button) — neues icon-loses Menü ⇒ CI rot.

**Zwei Positionierungs-Strategien** (orthogonal zum Inhalt — der ist immer identisch):

| Strategie | Klasse | Wann | Schliessen |
|---|---|---|---|
| **Am Trigger verankert** (Default) | `.context-menu--dropdown` (`position: absolute; right: 0`) | Trigger lebt **nicht** in einem `overflow`-/`transform`-Container | `@click.outside` + `@keydown.escape.window` am `position: relative`-Wrapper (z.B. `.action-overflow`) |
| **Teleportiert + JS-positioniert** | Basis-`.context-menu` (`position: fixed`) in `<template x-teleport="body">`, `:style` aus `getBoundingClientRect()` | Trigger sitzt in einem Scroll-/Clip-/`will-change`-Container, wo ein verankertes Popover geclippt bzw. eingesperrt würde (Containing-Block-Falle), **oder** Rechtsklick-Kontextmenü | `@click.outside` + `@keydown.escape.window`; zusätzlich `scroll`(capture)/`resize`-Listener, die schliessen (in `init`/Reset wieder abhängen) |

Verankerte Variante (`pageActionsMenuOpen`):
```html
<span class="action-overflow" @click.outside="pageActionsMenuOpen = false"
      @keydown.escape.window="pageActionsMenuOpen = false">
  <button type="button" class="icon-btn icon-btn--ghost" :class="{ 'is-active': pageActionsMenuOpen }"
          @click="pageActionsMenuOpen = !pageActionsMenuOpen"
          aria-haspopup="menu" :aria-expanded="pageActionsMenuOpen"
          :data-tip="t('editor.btn.moreActions')" :aria-label="t('editor.btn.moreActions')">
    <svg class="icon" aria-hidden="true"><use href="/icons.svg#more-horizontal"/></svg>
  </button>
  <div class="context-menu context-menu--dropdown" x-show="pageActionsMenuOpen" x-cloak role="menu">
    <button type="button" class="context-menu-item context-menu-item--icon" role="menuitem"
            @click="toggleIdeenCard(); pageActionsMenuOpen = false">
      <svg class="icon" aria-hidden="true"><use href="/icons.svg#lightbulb"/></svg>
      <span x-text="t('ideen.title')"></span>
      <span class="btn-count" x-show="count > 0" x-text="count"></span>
    </button>
    <div class="context-menu-sep" role="separator"></div>
    <button type="button" class="context-menu-item context-menu-item--icon context-menu-item--danger"
            role="menuitem" @click="del(); pageActionsMenuOpen = false">
      <svg class="icon" aria-hidden="true"><use href="/icons.svg#trash"/></svg>
      <span x-text="t('common.delete')"></span>
    </button>
  </div>
</span>
```

**Verhalten via `Alpine.data('menu')`** (Pflicht für die verankerte Variante) — [public/js/menu.js](public/js/menu.js): das Primitiv besitzt den Open-State und kapselt Toggle, Outside-Click-Close, Escape-Close und **Auto-Close beim Klick auf einen Eintrag**. **Kein handverdrahtetes `menuOpen`-Boolean + `@click.outside`/`@keydown.escape.window` + `; menuOpen = false` pro Eintrag** mehr. Es ersetzt nur das Verhalten, **nicht** das Markup-Vokabular (Icon-Button-Trigger, `.context-menu-item--icon`, `.context-menu-sep` bleiben wie oben — weiter durch context-menu-icons.test.mjs gegated). Pattern:

```html
<span class="action-overflow" x-data="menu()">
  <button class="icon-btn icon-btn--ghost" x-bind="trigger" :class="{ 'is-active': open }"
          aria-haspopup="menu" :data-tip="t('…')" :aria-label="t('…')">
    <svg class="icon" aria-hidden="true"><use href="/icons.svg#more-horizontal"/></svg>
  </button>
  <div class="context-menu context-menu--dropdown" x-bind="panel" x-cloak>
    <button class="context-menu-item context-menu-item--icon" role="menuitem" @click="action()">…</button>
  </div>
</span>
```

- `x-bind="trigger"` (@click-Toggle + `:aria-expanded`) am Trigger-Button, `x-bind="panel"` (`x-show` + `role="menu"`) am Popover (`x-cloak` selbst setzen). Wrapper braucht nur `x-data="menu()"` — `init()` setzt die `.menu-anchor`-Klasse (position: relative); `.action-overflow` ist deckungsgleich und darf bleiben.
- Active-Zustand des Triggers via `:class="{ 'is-active': open }"` (`open` liegt im selben Scope).
- Einträge brauchen **kein** `; menuOpen = false` — ein Klick auf `.context-menu-item`/`[role=menuitem]` schliesst automatisch (nach dem Item-Handler). `@click.stop` in einem Eintrag unterdrückt das bewusst.
- Nur die **teleportierte** Variante (unten) bleibt hand-verdrahtet (case-spezifische JS-Positionierung). Beispiel-Migration: [kapitelreview.html](public/partials/kapitelreview.html).

Teleportierte Variante (ein **einzelnes** Menü ausserhalb der Liste, offene Zeile per ID; Code-Referenz Ideen [public/js/book/ideen.js](public/js/book/ideen.js) `openMenu`/`closeMenu` + Plot [public/js/book/plot/threads.js](public/js/book/plot/threads.js) `openThreadMenu`):
```html
<template x-teleport="body">
  <div class="context-menu" x-show="menuOpenId !== null && !!menuOpenIdee()" x-cloak
       :style="`top:${menuPos.top}px;left:${menuPos.left}px`"
       @click.outside="closeMenu()" @keydown.escape.window="closeMenu()" role="menu">
    <template x-if="menuOpenIdee()"><div>
      <button type="button" role="menuitem" class="context-menu-item context-menu-item--icon"
              @click.stop="startEditIdee(menuOpenIdee()); closeMenu()">
        <svg class="icon" aria-hidden="true"><use href="/icons.svg#pencil"/></svg>
        <span x-text="t('ideen.edit')"></span>
      </button>
    </div></template>
  </div>
</template>
```

**Regeln:**
- Verankerte Variante: Wrapper braucht `position: relative` + **kein** `transform`/`contain`/`will-change` auf Ancestors bis zur Karte (sonst Containing-Block-/Clip-Falle → teleportierte Variante nehmen).
- Konsumenten-Marker-Klasse für JS-Hooks (Outside-Click-Query) zusätzlich zu `.context-menu` erlaubt (Muster `.pagetree-context-menu`, `.werkstatt-context-menu`) — sie trägt **kein** eigenes Styling.
- Neues **Aktions**-Menü erfindet **kein** eigenes Popover-CSS und keine eigene Item-/Sep-Klasse. Fehlt ein Icon im Sprite, erst [public/icons.svg](public/icons.svg) ergänzen (Lucide), dann verwenden.
- **Content-Popover-Ausnahme:** Ein Popover, das keine Aktions-Einträge, sondern **reichen Inhalt** listet (mehrzeilige Zeilen mit Titel + Metadaten/Snippet), darf die `.context-menu`-Hülle + die teleportierte JS-Positionierung (`_compute*Pos`, Flip-Messung, scroll/resize-Close) wiederverwenden **und** eine eigene Zeilenklasse definieren — die Aktions-Item-Klasse (`.context-menu-item--icon`, einzeilig) passt nicht. Konsument: Plot-Anchor-Fundstellen-Popover ([plot.html](public/partials/plot.html), `.plot-occ-*` in [board.css](public/css/book/plot/board.css), `openBeatOccPopover` in [plot/ai.js](public/js/book/plot/ai.js)) — Seitenname + Score + Snippet zweizeilig, Klick springt an die Textstelle. Content-Popover ist **nicht** durch context-menu-icons.test.mjs gegated (keine Icon-Einträge).

---

## Icon-Button-Count-Badge (`.icon-btn-badge`)

**Use:** Kleines Counter-Badge oben rechts auf einem Icon-Button (offene Chat-Verläufe, offene Ideen) — das Icon-only-Pendant zum `.btn-count` in Text-Buttons.

**Markup:**
```html
<span class="icon-btn-badge-wrap" x-show="…">
  <button type="button" class="icon-btn icon-btn--ghost" :aria-label="…" :data-tip="…">
    <svg class="icon" aria-hidden="true"><use href="/icons.svg#message-square"/></svg>
  </button>
  <span class="icon-btn-badge" x-show="count > 0" x-text="count"></span>
</span>
```

**Klassen** [public/css/components/icon-btn.css](public/css/components/icon-btn.css):
- `.icon-btn-badge-wrap` — `position: relative; display: inline-flex`; übernimmt ein eventuelles `x-show` des Buttons.
- `.icon-btn-badge` — absolut oben-rechts, primary-Fläche, `--color-text-inverse`, `pointer-events: none`.
- `.icon-btn--success` — grüner Akzent für Bestätigungs-Icon-Buttons (Speichern, Korrekturen übernehmen).
- `.icon-btn--attention` — kleiner Achtungs-Punkt oben rechts (kein Counter, keine Zahl) für **Aktions**-Buttons, die auf einen erledigenswerten Zustand hinweisen (z.B. veralteter Ist-Index → „Lauf neu starten"). Toggle-artiges `.is-active` wäre hier semantisch falsch (kein Umschalt-Zustand) und als Dauer-Highlight irritierend, wenn der Zustand der Normalfall ist. Markup: `:class="{ 'icon-btn--attention': istVeraltet }"` direkt am Button — kein Wrap nötig, der Punkt liegt als `::after` auf. Beispiel: Verankerungs-Button in der Plot-Werkstatt-Kopfzeile.

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

CSS: [public/css/page/tree-history.css](public/css/page/tree-history.css). `.history-detail` hat einen gestrichelten Top-Border, der visuell anschliesst. Chevron + State (`open`) wiederverwenden — nicht neu definieren.

---

## Editor

Editor-spezifische Patterns. Greifen nur in der Editor-Card und im Fokus-Modus; andere Karten verwenden sie nicht.

**Sub-Sections:**
- [Findings-Cards](#findings-cards-lektorat-ergebnisse) (Lektorat-Output, Severity, Marginalia-Stripe)
- [Page-Content-View](#page-content-view-reading-frame) (Reading-Frame, Buchsatz, Callouts)
- [Focus-Mode](#focus-mode) (Vollbild + Typewriter-Dimming)
- [Edit-Bubble-Toolbar](#edit-bubble-toolbar-inline-formatierung) (Inline-Format + Slash-Menu)
- [Beleg-Chip + Beleg-Picker](#beleg-chip--beleg-picker-quellenverzeichnis) (Quellennachweis im Text)
- [Querverweis + Ziel-Picker](#querverweis--ziel-picker) („siehe Kapitel 3“, „vgl. Abb. 3.2“)
- [Find-and-Replace](#find-and-replace) (Cmd+F-Panel)
- [Lookup-Popover](#lookup-popover-figur-lookup) (Figuren-Detail bei Ctrl+Click)

### Findings-Cards (Lektorat-Ergebnisse)

**Use:** Einzelne Lektorats-/Review-Findings mit Original/Korrektur und Apply-Action.

**Klassen** (CSS in [public/css/editor/notebook/findings.css](public/css/editor/notebook/findings.css), Render-Logik im Frontend):
- `.finding` / `.finding--flash` (Highlight-Animation) / `.finding--applied` (nach Übernahme)
- Severity-Variante: `.finding.error` / `.ok` / `.style` (siehe Section „Severity-Vokabular" für Mapping)
- Children: `.finding-header`, `.finding-checkbox`, `.finding-content`, `.finding-original`, `.finding-korrektur`, `.finding-explanation`, `.finding-toggle-group`
- **Eigener Korrekturvorschlag (inline-Edit):** jeder Befund kann den KI-Vorschlag überschreiben oder — bei reinem Stil-Befund ohne `korrektur` — einen eigenen ergänzen. Affordance `.finding-edit-btn` (Textlink „anpassen"/„Eigener Vorschlag") → Inline-Editor `.finding-korrektur-edit` mit `.finding-korrektur-input` (`data-spellcheck="spelling"`, Enter=übernehmen, Esc=abbrechen). Eigener Vorschlag: `.finding-korrektur.finding-korrektur--user` (Akzent-Tint statt KI-Grün) + `.tag` „dein Vorschlag" + Reset-Link. Apply-Pipeline unverändert — sie liest `f.korrektur`. Edit-Controls in der `<label>` brauchen `@click.stop`/`@pointerdown.stop`, sonst togglet der Klick die Checkbox.

**Stilbox** (`.stilbox`, `.stilbox--review-summary`, `.stilbox--spaced`) — bordered Container für Analyse-Sektionen, in Reviews und Findings wiederverwendet.

**Analyse-Warnhinweis** (`.analysis-notice`, [analysis/analysis.css](public/css/analysis/analysis.css)) — Warn-Zeile über einem Analyse-Ergebnis, das **unvollständig** ist. Gleiches Pattern wie `.overview-notice` (amber Warn-Tokens + linker 3 px-Border), zweiter Fundort. Use-Case: ein Fremd-Write während der Analyse hat einen Teil der Befunde hinfällig gemacht — ohne den Hinweis liest der User die gerettete Teilmenge als vollständiges Ergebnis. Kein Retry-Button (im Gegensatz zu `.overview-notice`), der Hinweis ist rein informativ.

#### Marginalia-Stripe (Reading-Frame)

**Use:** Visueller Rotstift-Akzent rechts an Absätzen, die Lektorats-Markierungen enthalten. Editorial-Manuskript-Anmutung.

**Mechanik:** `.page-content-view p:has(.lektorat-mark)` setzt `padding-right` + Pseudo-`::after`-Stripe in severity-Farbe. Hartes Finding (`.lektorat-mark--selected`) → roter Stripe, weiches → amber. Modern-Browser-Only via `:has()`; ältere Engines fallen auf Default zurück (kein Stripe, Marks sind weiterhin sichtbar).

CSS: [public/css/page/page-view.css](public/css/page/page-view.css).

### Page-Content-View (Reading-Frame)

**Use:** Seiteninhalt im Lese-/Fokus-Modus (Serifenfont, lange Zeilen, Callouts).

**Klassen** [public/css/page/page-view.css](public/css/page/page-view.css):
- `.page-content-view` — Container mit max-width, Serif-Font, Paper-Sheet-Shadow
- `.page-content-view--editing` — Variante während Bearbeitung (Rail + Tint + hyphens off); erbt sonst alles
- Innerhalb: native `h1`–`h6`, `blockquote` werden auto-gestylt
- `.callout.info` / `.success` / `.warning` / `.danger` — links eingerückte Callout-Boxen
- `.callout.pullquote` — zentrierte, gross gesetzte Hervorhebung zwischen Absätzen. Kein Border, kein Background — Typografie trägt allein. Auto-Anführungszeichen via `::before`/`::after` in Akzentfarbe.
- `.poem` — Sonderlayout für Verse (preserve whitespace)
- `.lektorat-mark` / `.lektorat-mark--selected` — Inline-Annotationen
- `.page-aha` / `.page-aha__text` / `.page-aha__action` / `.page-aha__close` — einmaliger Erstkontakt-Nudge **über** dem Lese-Inhalt, der das KI-Lektorat sichtbar macht. Akzent-getönt (`--color-accent-soft` + Accent-Border-Left), an die Lesebreite ausgerichtet. Operational-status-Achse (Hinweis, kein Content-Callout). Dismiss persistiert in `localStorage['sw:ahaLektorat']` (Source of Truth), Markup als self-contained nested `x-data` in [editor-body-view.html](public/partials/editor-body-view.html) — kein Root-State; gegated auf Lese-Modus + `canReview()` + Seite hat Inhalt + kein laufendes/offenes Lektorat.

**Tagebuch-/Notebook-Optik:**
- Gemeinsamer Style-Scope für Read + Edit — kein Layout-Sprung beim Toggle. `--editing`-Modifier nur additiv. Edit-only-Properties immer über `--editing`-Selektor hängen.
- `box-shadow: var(--shadow-sm)` — Paper-Sheet-Lift.
- `p + p { text-indent: 1.4em; margin-top: 0; }` — Buchsatz-Erstzeilen-Einzug ab zweitem Absatz. Adjacency-Selector greift automatisch nicht nach Headings, blockquote, poem, hr.
- `padding: 36px clamp(18px, 4vw, 40px)`, `line-height: 1.75`, `<p>`-Margin 0.6em (Desktop) / 0.8em (Mobile).
- Caption-Slot via Partial-Sibling (nicht via `::before`, sonst Caret-Probleme im contenteditable).

**Buchsatz-Mikrotypografie** (am Container `.page-content-view`):
- `hanging-punctuation: first allow-end last` — Anführungszeichen ragen aus Satzkante.
- `font-feature-settings: "kern", "liga", "dlig", "calt", "onum"` — Ligaturen + alte Ziffern (Source Serif 4 hat OldStyle-Numerals).
- `text-rendering: optimizeLegibility`.
- `text-wrap: pretty` auf `<p>`, `text-wrap: balance` auf Headings (verhindert Witwen/Waisen). Im Edit-Modus deaktiviert (`wrap: wrap`) gegen Caret-Wackeln.

Nicht selbst Reading-Typografie definieren; immer diesen Frame verwenden.

### Focus-Mode

**Use:** Vollbild-Editor mit Typewriter-Dimming (Cmd+Shift+F).

**State-Selektor:** `body.focus-mode` (gesetzt durch JS-Toggle).

**Klassen** [public/css/editor/focus-mode.css](public/css/editor/focus-mode.css):
- `.focus-paragraph-active` — voll sichtbarer Paragraph
- `.focus-paragraph-near` — leicht gedimmt (opacity 0.6)
- nicht-aktive Paragraphen: opacity 0.35
- `.focus-live-counter` / `.focus-live-counter--today` — Live-Wortzähler

Granularität (paragraph/sentence) und Timings sind über Tests abgesichert ([tests/unit/focus-granularity.test.mjs](tests/unit/focus-granularity.test.mjs)). Bei Änderungen Tests laufen lassen.

### Edit-Bubble-Toolbar (Inline-Formatierung)

**Use:** Schwebender Format-Button-Bar bei Editor-Selection (Bold/Italic/Heading).

**Klassen** [public/css/editor/edit-toolbar.css](public/css/editor/edit-toolbar.css):
- `.edit-bubble-toolbar` — fixed-position Container
- `.edit-bubble-btn` / `.edit-bubble-btn--bold` / `--italic` — Variante pro Format
- Slash-Menu: `.edit-slash-menu`, `.edit-slash-hint`, `.edit-slash-item`, `.edit-slash-item--active`

Spezifisch für Editor — bei neuer Inline-Toolbar erst prüfen, ob die Edit-Klassen passen.

### Beleg-Chip + Beleg-Picker (Quellenverzeichnis)

**Use:** Quellennachweis mitten im Satz. Der **Chip** ist der Beleg im gespeicherten Seiten-HTML, der **Picker** das Panel zum Einfügen **und Bearbeiten** (Quelle wählen/wechseln + Stellenangabe + Zitat-Art + Entfernen). Kein Slash-Menü-Eintrag: der Beleg ist inline und gehört an den Caret, das Slash-Menü ersetzt dagegen einen leeren Block.

**Drei Einstiege, ein Panel:** Button in der Seiten-Toolbar (am blossen Caret — der Weg für den laufenden Satz), Button in der Bubble-Toolbar (bei markiertem Text) und **Klick auf einen bestehenden Chip** (`openCiteForChip`, Pendant zum Link-Input, der einen bestehenden `<a>` vorbefüllt). `citeEditing` unterscheidet die beiden Zustände im Template.

**Markup Chip** — SSoT [public/js/sources/cite-html.js](public/js/sources/cite-html.js), nie von Hand schreiben:
```html
<span class="cite" data-src="7" data-loc="44">(Müller, 2020, S. 44)</span>
```

**Klassen Chip** [components/manuscript-content.css](public/css/components/manuscript-content.css):
- `span.cite` — Akzentfarbe + gepunktete Grundlinie, `white-space: nowrap`. Gilt in allen drei Oberflächen (`.page-content-view`, `.book-editor-page-body`, `.share-content`).
- `span.cite[contenteditable="false"]` — nur im Editor: `cursor: default` + `user-select: none` (atomarer Chip).
- `.page-content-view--editing span.cite[contenteditable="false"]` — im Notebook-Edit-Modus `cursor: pointer`: dort ist der Chip ein Klickziel (öffnet den Picker auf sich selbst).

**Klassen Picker** [editor/notebook/edit-toolbar.css](public/css/editor/notebook/edit-toolbar.css):
- `.edit-cite-panel` — teleportiertes fixed-Panel über dem Caret (Aufbau wie `.edit-link-bar`, aber mit Trefferliste)
- `.edit-cite-row`, `.edit-cite-input--filter`, `.edit-cite-input--loc` — Filter- und Stellenangabe-Feld
- `.edit-cite-list`, `.edit-cite-item`, `.edit-cite-item.is-active` — Trefferliste mit Tastatur-Auswahl
- `.edit-cite-remove` — „Beleg entfernen", nur im Bearbeiten-Zustand (zurückhaltend wie `.edit-link-btn`; Hauptaktion bleibt die Quellenauswahl)
- `.edit-bubble-btn--cite` — Auslöser in der Bubble-Toolbar (Icon `#book-open`, wie die Quellen-Karte; `#quote` steht in der Seiten-Toolbar für die Anführungszeichen-Normalisierung)

**Regeln:**
- **Eine Selektion wird belegt, nicht ersetzt.** Der Kurzbeleg landet am Ende der Selektion; er weist die Stelle nach, statt an ihre Stelle zu treten. Unterschied zum Link-Input, wo die Selektion der Linktext ist.
- **`data-src` ist die Wahrheit, der Chip-Text ist Cache.** Jeder Ausgabeweg setzt ihn beim Rendern frisch (`resolveCitesInHtml`, im Anmerkungsmodus `lib/endnotes.js`). In der App bleibt der gespeicherte Text stehen — nach einem Stilwechsel zeigt der Editor bis zum nächsten Einfügen die alte Form; es gibt bewusst keinen Pass, der Seiten hinter dem Rücken des Autors umschreibt. Keine Schicht darf den Text als Quelle lesen.
- **`contenteditable` nie in der Persistenz.** Setzt der Editor beim Mount (`markCitesAtomic`); [lib/html-clean.js](lib/html-clean.js) strippt es beim Speichern und die Dirty-Vergleichsform ignoriert es. Ohne beides gilt jede Seite mit Beleg beim Öffnen als geändert.
- **Zurückhaltend stylen.** Kein Hintergrund, keine Border, kein eigener Font — der Kurzbeleg ist Lesetext, kein Badge. Sonst zerhackt jeder Nachweis den Absatz optisch.
- **Nur Notebook-Editor hat den Einfügepfad.** Focus-Editor und Bucheditor stellen Chips dar und zerstören sie nicht (`.edit-cite-panel` ist im Fokus-Modus strukturell gesperrt).

**Beispiele:** [editor-toolbar.html](public/partials/editor-toolbar.html)

### Querverweis + Ziel-Picker

**Use:** „siehe Kapitel 3", „vgl. Abb. 3.2" — ein Zeiger auf eine Stelle im eigenen Buch, der beim Umbauen automatisch mitnummeriert. Derselbe Bauplan wie der Beleg-Chip (Marker mit Zeiger, aufgelöst beim Rendern), nur zeigt er ins Buch statt in die Bibliothek. Kein Slash-Menü-Eintrag: der Verweis ist inline und gehört an den Caret.

**Markup** — SSoT [public/js/xrefs/xref-html.js](public/js/xrefs/xref-html.js), nie von Hand schreiben:
```html
<span class="xref" data-xref="chapter" data-xref-id="42">Kapitel 3</span>
<span class="xref" data-xref="figure" data-xref-id="a1b2c3d4e5f6a7b8" data-xref-fmt="number">3.2</span>
```

**Klassen Verweis** [components/manuscript-content.css](public/css/components/manuscript-content.css):
- `span.xref` — gepunktete Grundlinie in `--mc-muted`, `white-space: nowrap`. Gilt in allen drei Oberflächen (`.page-content-view`, `.book-editor-page-body`, `.share-content`).
- `span.xref[contenteditable="false"]` — nur im Editor: `cursor: default` + `user-select: none` (atomar).

**Klassen Picker** [editor/notebook/edit-toolbar.css](public/css/editor/notebook/edit-toolbar.css) — teilt Panel, Liste und Aktiv-Zustand mit dem Beleg-Picker (`.edit-cite-*`), es ist dieselbe Interaktion:
- `.edit-xref-panel` — Variante des `.edit-cite-panel` (breiter)
- `.edit-xref-item`, `.edit-xref-preview`, `.edit-xref-title` — zweispaltige Trefferzeile (Vorschau + Titel)
- `.edit-xref-item[data-depth="2|3"]` — Einrückung nach Kapiteltiefe
- `.edit-bubble-btn--xref` — Auslöser in der Bubble-Toolbar (Icon `#list-tree`)

**Regeln:**
- **Der Zeiger ist die Wahrheit, der Verweistext ist Cache.** Wie beim Beleg-Chip — nur schärfer: **Nummern folgen der gerenderten Einheit, nicht dem Ziel.** Dasselbe Kapitel heisst im PDF-Profil mit römischer Nummerierung „Kapitel III", bei `numbering: 'none'` gar nicht (dann fällt der Verweis auf den Kapiteltitel zurück), und im Kapitel-Scope-Export zählt es ab 1. Jeder Ausgabeweg ruft darum [lib/xref-render.js](lib/xref-render.js)#`applyXrefsInHtml`, bevor sein Walker läuft.
- **Kein zweiter Zählautomat.** Der PDF-Renderer reicht seine bereits berechneten Kapitel-Labels herein ([lib/pdf-render/numbering.js](lib/pdf-render/numbering.js) bleibt SSoT); sonst nennte der Verweis eine andere Nummer als die Überschrift.
- **Verwaiste Verweise werden nie überschrieben.** Zeigt ein Marker auf ein gelöschtes Kapitel, bleibt der Text des Autors stehen und der Fund wird gemeldet (`meta.xrefUnresolved`) — nie ein „???" im Manuskript.
- **Die Nummer im Editor ist eine Vorschau** (nested-arabisch). Was im Dokument steht, entscheidet der Export.
- **`contenteditable` nie in der Persistenz** — identisch zum Beleg-Chip (`markXrefsAtomic` beim Mount, Server strippt beim Speichern).
- **Zurückhaltender stylen als den Beleg.** Ein Querverweis ist Teil des Satzes, kein Apparat: nur Grundlinie, keine Akzentfarbe. Sonst leuchtet ein Fachtext mit vielen Verweisen wie ein Weihnachtsbaum.
- **Nur Notebook-Editor hat den Einfügepfad** — wie beim Beleg.

**Beispiele:** [editor-toolbar.html](public/partials/editor-toolbar.html)

### Find-and-Replace

**Use:** Suchen/Ersetzen-Panel im Editor (Cmd/Ctrl+F).

**Klassen** [public/css/editor/find-replace.css](public/css/editor/find-replace.css):
- `.edit-find` (fixed Container), `.edit-find-row`
- `.edit-find-input` (Such-/Ersetzen-Input)
- `.edit-find-count` (Treffer-Anzeige)
- `.edit-find-btn` / `.edit-find-btn--toggle` / `--active`
- `.edit-find-close`

Nur einmal verwendet (Editor). Doku hier zur Auffindbarkeit für künftige Such-Features.

### Lookup-Popover (Figur-Lookup)

**Use:** Hover-/Click-Popover mit Detail-Info (z.B. Figuren-Lookup im Editor bei Ctrl+Click).

**Klassen** [public/css/editor/figur-lookup.css](public/css/editor/figur-lookup.css):
- `.figur-lookup`, `.figur-lookup-header`, `.figur-lookup-body`, `.figur-lookup-row`, `.figur-lookup-footer`, `.figur-lookup-link`
- Position: fixed, JS setzt Top/Left aus Cursor-Position

Bei neuen Popover-Komponenten dieses Markup-Schema übernehmen (Header/Body/Footer), Custom-Klassen-Präfix pro Use-Case (`.xxx-lookup`).

---

## Heading-Hierarchie in Karten

- `.card-title` — Karten-Titel (Header, h2-Niveau)
- `.card-subline` / `.card-subline-link` — Untertitel mit Timestamp/Save-Indicator
- `.section-heading` — Sub-Sektion innerhalb generierter Outputs (h3-Niveau)
- `.section-heading-top` — erste Section ohne oberen Abstand
- `.section-heading-sub` — Sub-Section innerhalb `.section-heading` (h4-Niveau, kleiner, weniger Abstand). Anlegen, sobald gebraucht — kein eigenes `.xxx-subheading` pro Karte.

Kein `<h3>`/`<h4>` innerhalb von Karten ohne diese Klassen — sonst kollidiert es mit globaler Heading-Cascade.

---

## Save-Indicator

**Use:** Karten mit auto-saving State (Editor, User-Settings, Book-Settings).

```html
<span class="save-indicator save-indicator--draft" x-text="$app.t('common.draft')"></span>
<span class="save-indicator save-indicator--offline" x-text="$app.t('common.offline')"></span>
```

CSS: [public/css/editor/focus-mode.css](public/css/editor/focus-mode.css). Inline in `.card-subline`.

---

## Presence-Pip (Live-Co-Editing-Marker)

**Use:** Initialen-Bubble neben einem Seitennamen (Sidebar) oder im Editor-Header, sobald ein anderer User dieselbe Seite gerade editiert (Heartbeat <90s). Multi-Device: derselbe User auf einem anderen Geräten erscheint mit Modifier `--self` (gestrichelte Border, leicht muted) statt mit fremder Akzentfarbe.

**Klassen** (CSS in [public/css/page/page-list.css](public/css/page/page-list.css)):
- `.presence-pip` — Basis-Initialen-Bubble. Pro-User-Hue via `--avatar-hue`-Custom-Prop (Setter im Konsumenten-Markup).
- `.presence-pip--self` — Eigener User, anderes Gerät. Gestrichelte Border + opacity 0.85.

**Markup:**
```html
<span class="presence-pip"
      :class="{ 'presence-pip--self': p.is_self }"
      :style="`--avatar-hue: ${userAvatarHue(p.user_email)}`"
      :data-tip="p.is_self
        ? t('presence.self.editing', { device: p.device_label })
        : t('collab.presence.editing', { user: p.user_display_name })"
      x-text="userInitials(p.user_email)"></span>
```

**Banner-Variante (Editor-Header):** `.editor-presence-banner` mit Modifier `--self` (muted-Hue, in [public/css/editor/shared/editor-chrome.css](public/css/editor/shared/editor-chrome.css)).

**Daten-Quelle:** `presenceFor(pageId)` ([public/js/app/app-collab.js](public/js/app/app-collab.js)). Server-Filter dropt nur die eigene aktuelle Session — eigene andere Geräte bleiben mit `is_self: true` in der Liste.

---

## Avatar-Menu

**Use:** User-Menü oben rechts (Profil, Logout, Sprache).

**Klassen** (CSS in [public/css/components/buttons-badges.css](public/css/components/buttons-badges.css) + erweitert):
- `.avatar-btn` / `.avatar-btn--active` — Trigger
- `.avatar-btn-img` (Foto) oder `.avatar-btn-initials` (Fallback)
- `.avatar-menu-panel` — Dropdown
- `.avatar-menu-header` (mit `-avatar`/`-text`/`-img`)
- `.avatar-menu-section`, `.avatar-menu-item`, `.avatar-menu-item--logout`
- `.avatar-menu-divider`, `.avatar-menu-label`
- `.avatar-menu-provider` + `-dot` (Provider-Indikator)

Markup: [public/partials/avatar-menu.html](public/partials/avatar-menu.html). Bei neuen Header-Dropdowns dieses Pattern wiederverwenden statt eigenes Menu zu bauen.

---

## Sofort-Tooltip (`data-tip`) — **Default-Variante**

**Harte Regel:** `data-tip` ist die bevorzugte Tooltip-Variante. Natives `title=` hat ~500ms Delay, der nicht abstellbar ist — zu langsam für jedes Hover-Feedback. Neue Tooltips werden grundsätzlich als `data-tip` gesetzt.

**Markup:** `data-tip="Mo: +1234"` (oder Alpine `:data-tip="..."`) auf beliebigem Element. Das Attribut bleibt — gerendert wird via geteiltem Layer.

**Implementation:** Ein einziges `.tip-layer`-Element wird beim ersten Hover via [public/js/tooltip.js](public/js/tooltip.js) in den Body gehängt und auf das jeweilige Target positioniert (fixed). Pseudo-Slots (`::before`/`::after`) auf den Targets bleiben so frei für eigene Decorations.

**Klassen** [public/css/components/tooltip.css](public/css/components/tooltip.css):
- `.tip-layer` (Wrapper, `position: fixed`), `.tip-bubble` (Inhalt), `.tip-arrow` (Dreieck).
- `data-placement="top|bottom"` schaltet die Pfeilseite. Auto-Flip nach unten, wenn oben kein Platz.

**Wann `title=` ausnahmsweise erlaubt:**
- Reine Form-Inputs / Icon-Buttons, wo a11y-Screenreader-Hint wichtiger ist als Geschwindigkeit (`<button title="Schliessen">` etc.).
- In Konflikt-Fällen darf beides parallel gesetzt werden (`data-tip` für Sicht, `title` für Screenreader).

**Nicht erlaubt:**
- Neue Wert- oder Erklärungs-Tooltips als `:title=` ohne `data-tip` daneben — User-Präferenz, weil 500ms-Delay als störend empfunden wird.
- **Keine** `[data-tip]:hover::before` / `::after`-Selektoren — Pseudos auf dem Target gehören dem Element.

### Tastenkürzel im Tooltip

Hat eine Aktion ein Tastenkürzel, nennt ihr Tooltip es mit: `Bearbeiten (⌘E)` / `Bearbeiten (Strg+E)`. **Nie von Hand in den i18n-String schreiben** — sonst steht dort beides parallel („(⌘K / Strg+K)"), und die Übersetzung driftet gegen das Binding.

**Markup:** `:data-tip="withHotkey(t('editor.btn.editTitle'), 'edit')"` (aus einer Karte `$app.withHotkey(…)`). Das `aria-label` bleibt das reine Label — die Taste ist Sichthilfe, kein Teil des zugänglichen Namens.

**SSoT der IDs + Formatierung:** [public/js/hotkeys.js](public/js/hotkeys.js) (`HOTKEYS`). Plattform-Weiche über `$store.shell.isMac`: Mac zeigt Modifier-Glyphen in der dortigen Reihenfolge ⌃⌥⇧⌘ direkt am Key (`⌘⇧E`), sonst lokalisierte Namen mit `+` (`Strg+Shift+E`).

Die Tabelle listet **nur Kürzel, die an einem Element hängen** — die vollständige Dokumentation ist das Kürzel-Overlay ([partials/shortcuts.html](public/partials/shortcuts.html), `?`). Neues Kürzel an einem Icon: Eintrag in `HOTKEYS` **und** Zeile im Overlay; beides gegated durch [tests/unit/hotkey-tips.test.mjs](tests/unit/hotkey-tips.test.mjs) (Kürzel identisch in beiden Quellen, keine unbekannte oder unbenutzte ID).

---

## Graph-Tooltip (vis-network)

**Use:** Hover-Detailkarte über einem Graph-Canvas — Figuren-Graph (Figur/Beziehung) und Motiv-Konstellation (Motiv/Thema). **Nicht** `data-tip`: dort hängt der Tooltip an einem DOM-Element, hier an einem Knoten im Canvas, den nur vis-network kennt.

**Markup:** ein leeres `<div id="…-tooltip" class="graph-tooltip"></div>` im Graph-Wrapper. Der Wrapper braucht `position: relative` — er ist der Bezugsrahmen.

**Klassen** [components/graph-tooltip.css](public/css/components/graph-tooltip.css): `.graph-tooltip` (versteckt), `.visible` (eingeblendet), plus die Inhaltszeilen `strong` (Titel), `em` (Untertitel, muted), `p` (Fliesstext). Karten-eigene Zusatzzeilen bleiben in der Karten-CSS (z.B. `.motiv-tip-stats`).

**Verhalten:** `createGraphTooltip(container, tipEl)` aus [public/js/graph-kit.js](public/js/graph-kit.js) liefert `{ show(html, clientX, clientY), hide() }`. Die Klemmung an den Container-Rändern (inkl. Umklappen auf die andere Cursor-Seite) steckt in der reinen `clampTipPos` — **nicht pro Graph nachbauen**.

**Pflicht:** `html` ist bereits escapt (`escHtml()`-Atome). Der Tooltip ist eine `innerHTML`-Sink wie jedes `x-html`.

---

## Header-Actions

**Use:** Rechts-ausgerichtete Button-Cluster im Karten-Header (z.B. „Aktualisieren"-Button, Token-Stats).

**Klassen** [public/css/book/header-actions.css](public/css/book/header-actions.css):
- `.header-actions` — flex-Container
- `.header-action-cluster` — Sub-Gruppe mit reduziertem Gap
- Innerhalb: `.tok-stats` für Token-Counter

Nicht eigene Toolbar-Layouts pro Karte erfinden.

### Aktions-Trennstrich (`.action-sep`) — SSoT für gebündelte Aktionsreihen

**Use:** Der **einzige** Trenner zwischen semantischen Bündeln in einer horizontalen Aktionsreihe — egal ob Karten-Header (`.card-actions`), Editor-Toolbar oder eine Inline-Edit-Form-Aktionsleiste (z.B. Beat-Karte der Plot-Werkstatt). Trennstrich macht die Aktionstypen visuell unterscheidbar (commit-Paar ↔ Lifecycle-/State-Aktionen). **Kein** eigener Trenner pro Feature (kein `border-left`-Hack, kein `<hr>`, kein zweites Margin-Cluster).

**Markup (Karten-Header mit `.action-group`-Bündeln):**
```html
<div class="card-actions card-actions--grouped">
  <span class="action-group">
    <button>Prüfen</button>
    <button>Speichern</button>
  </span>
  <span class="action-sep" aria-hidden="true"></span>
  <span class="action-group">
    <button>Bearbeiten</button>
    <button>Fokus</button>
  </span>
</div>
```

**Markup (Inline-Icon-Aktionsleiste, direkt zwischen zwei Icon-Buttons):**
```html
<div class="plot-beat-edit-actions">
  <button class="icon-btn icon-btn--ghost ..."><!-- Speichern (check) --></button>
  <button class="icon-btn icon-btn--ghost ..."><!-- Abbrechen (x) --></button>
  <span class="action-sep" aria-hidden="true"></span>
  <button class="icon-btn icon-btn--ghost ..."><!-- Verwerfen (minus/rotate-cw) --></button>
  <button class="icon-btn icon-btn--ghost ... --danger"><!-- Löschen (trash) --></button>
</div>
```

**Klassen** ([public/css/components/card-form.css](public/css/components/card-form/card-actions.css)):
- `.action-group` — `display: contents` — semantischer Wrapper, kein Layout-Bruch zum Flex-Parent (nur nötig, wenn Bündel als Einheit angesprochen werden; bei direkten Geschwister-Buttons reicht der nackte `.action-sep`)
- `.action-sep` — 1 px Trennstrich (`var(--color-border)`), full-height via `align-self: stretch`; der umschliessende Container muss `display: flex` sein

**Mobile (≤700 px):** in `.card-actions--grouped` wird `.action-sep` ausgeblendet (Buttons stapeln ohnehin auf 100% Breite via Flex-Reflow). In kompakten Icon-only-Reihen, die nicht stapeln (z.B. Beat-Karte), bleibt er sichtbar.

**Wann nicht:** Reihen mit ≤3 Aktionen ohne semantische Bündel — bleiben flach, ohne Trenner. Trenner nur, wenn die Sektionen wirklich unterschiedliche Aktionstypen sind (z.B. „Form bestätigen/verwerfen" vs. „Datensatz-Lifecycle").

**Referenz:** [public/partials/editor.html](public/partials/editor.html) (View-Mode: 3 Gruppen × run/mode/side; Edit-Mode: 2 Gruppen × commit/mode), [public/partials/plot-beat-cell.html](public/partials/plot-beat-cell.html) (Beat-Edit: commit-Paar ↔ verwerfen/löschen).

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

**Klassen** ([public/css/components/feature-tiles.css](public/css/components/feature-tiles.css)):
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

## Routing / Deep-Links (URL-Pflicht)

**Use:** Jedes Feature mit eigener Hauptansicht (Karte, Detail, Editor-Modus, Modal mit dauerhaftem Zustand) braucht eine eigene URL. State, der nicht in der URL steht, ist nicht teilbar, nicht bookmarkbar, geht beim Reload verloren und ist im Plausible nicht messbar. Single-Source-of-Truth für Sichtbarkeit ist die URL — nicht der Show-Flag.

**Schema** (siehe [public/js/app-hash-router.js](public/js/app-hash-router.js)):
```
#profil
#book/:bookId                                     ← Buch-Übersicht
#book/:bookId/<view>                              ← Buchebenen-Karte ohne Selektion
#book/:bookId/page/:pageId                        ← Seite im Editor
#book/:bookId/figur/:figId | ort/:ortId | szene/:szId
#book/:bookId/kapitel[/:chapterId]
```

Bekannte Views: `figuren`, `orte`, `szenen`, `ereignisse`, `kontinuitaet`, `bewertung`, `kapitel`, `chat`, `uebersicht`, `stats`, `stil`, `fehler`, `einstellungen`, `finetune`, `export`, `pdf`.

**Regeln:**
- **Neue Karte → eigener View-Slug** in `_computeHash()` ([public/js/app-hash-router.js](public/js/app-hash-router.js)) **und** Apply-Zweig in `_applyHash()`. Slug kurz, deutsch, Kleinbuchstaben (passt zu bestehenden: `bewertung`, `einstellungen`).
- **Selektion (`selectedFigurId` etc.) muss in der URL** stehen, sonst Reload verliert die Auswahl. Pattern: eigene Sub-Route `#book/:bookId/<entity>/:id`.
- **Push vs. Replace:** gleiche Kategorie (z.B. Figur ↔ Figur) = Replace, Wechsel = Push. Liefert `_hashCategory()` automatisch — neue Aliase (`figur` → `figuren`) dort eintragen.
- **Watcher auf neue State-Felder, die in der URL landen** ([app-hash-router.js](public/js/app-hash-router.js)#`_setupHashWatchers`). Ohne Watcher kein Auto-Sync; Hash-Stand driftet.
- **Feature-Registry** ([public/js/cards/feature-registry.js](public/js/cards/feature-registry.js)): jeder neue Toggle bekommt einen Eintrag mit Show-Flag-Key, der in `ALLOWED_KEYS` von [routes/usage.js](routes/usage.js) gespiegelt ist. Recency-Tracking (Palette „Zuletzt") triggert auf rising-edge des Show-Flags und braucht den exakten Key.
- **Exklusivität / Home-Klick / View-Reset** sind Registry-driven ([public/js/cards/feature-registry.js](public/js/cards/feature-registry.js)#`EXCLUSIVE_CARDS`). `_closeOtherMainCards`, `resetView` und `_maybeOpenBookOverview` ([public/js/app-view.js](public/js/app-view.js)) iterieren ausschliesslich über diese Liste — neue Hauptkarte braucht **nur** einen `{ key, flag }`-Eintrag dort, keine zusätzliche Stelle in app-view.js. `key` matcht das Argument von `_closeOtherMainCards(keep)`. Auch nicht-Palette-Karten (`kapitelReview`, `userSettings`) gehören rein, sobald sie sich gegenseitig ausschliessen. Test: [tests/unit/card-exclusivity.test.mjs](tests/unit/card-exclusivity.test.mjs) deckt Home-Klick-Regression ab.
- **Plausible-Tracking:** `_writeHash` triggert nach jedem Push/Replace `plausible('pageview')`. Eigene URL = eigene Metrik, ohne Code-Änderung an Analytics.
- **Test:** [tests/unit/hash-router.test.mjs](tests/unit/hash-router.test.mjs) ergänzen für jede neue View/Selektion (Push/Replace + Apply-Roundtrip).

**Anti-Pattern:**
- Karte zeigen via reinem Show-Flag ohne URL-Pendant → Reload verliert Ansicht, „Link mir mal X" geht nicht.
- Selektion nur in lokalem Sub-State (Karte hält `selectedXxxId` selbst) → Hash kann nicht synchronisieren.
- Modal/Drawer mit dauerhaftem Inhalt (z.B. eigener Settings-Bereich) ohne URL — gleiche Regel wie Karten.

**Ausnahmen** (kein eigener Hash):
- Kurzlebige Overlays ohne Inhalts-State: Confirm-Dialog, Toast, Sofort-Tooltip, Avatar-Menu, Edit-Bubble-Toolbar.
- Editor-Sub-Modi (Edit, Fokus, Findings) — sie hängen am Page-Hash; Modus selbst wird nicht gehashed (würde sonst Back-Button-Verhalten zerschiessen).
- Command-Palette (öffnet via Shortcut, schliesst sofort wieder; kein Inhalts-State).

---

## Book-Overview-Tiles

**Use:** Default-Home beim Buchwechsel ([public/partials/bookoverview.html](public/partials/bookoverview.html)). Tile-Grid mit Inline-SVG-Visualisierungen (Sparkline, Donut, 7-Tage-Bars, Stacked-Bar, Sterne) — bewusst **kein Chart.js-Lazy-Load** (Tiles laden sofort, wenig Daten).

**Klassen** ([public/css/book-overview/base.css](public/css/book-overview/base.css)):
- `.book-overview .overview-grid` — `repeat(auto-fit, minmax(220px, 1fr))` + `grid-auto-flow: row dense` (verhindert Whitespace-Inseln bei `--hero`/`--medium`/`--wide`-Spans)
- `.overview-tile` — Basis-Tile, optional `.internal-link` für klickbar
- Spans (≥720px): `.overview-tile--hero` (span 2), `.overview-tile--medium` (span 2), `.overview-tile--wide` (full-width)
- Tile-Innenleben: `.overview-tile-label` (Header), `.overview-hero-row`/`-num`/`-value`/`-unit`, `.overview-substats`/`-substat`, `.overview-sparkline`, `.overview-trend-meta`/`-pct` (`--up`/`--down`)
- 7-Tage-Bars: `.overview-bars7` + `-col`/`-track`/`-fill` (`--pos`/`--neg`)/`-label`, `.overview-bars7-total`
- Donut: `.overview-donut-row` + `.overview-donut` + `-text`/`-meta`
- Heute-Ring: `.overview-today-ring` (Modifier `--active` triggert `overviewTodayPulse`-Animation, `--reached` flippt Stroke auf success-Farbe). Respektiert `prefers-reduced-motion`. Math via `overviewTodayRing(goal)` in [public/js/book-overview.js](public/js/book-overview.js).
- Streak-Heatmap: `.overview-streak-grid` (53 Spalten × 7 Reihen, GitHub-Stil) + `.overview-streak-week` (`display: contents` als logische Wochen-Gruppe) + `.overview-streak-cell--lvl0..4` (`color-mix(--color-accent, --color-bg)`-Stufen), `--empty` (visibility hidden für Future-Cells), `--future` (opacity-Reduce). Plus `.overview-streak-meta` (Stats-Reihe), `.overview-streak-legend` (kleine Cells als Skala). Math via `overviewStreakHeatmap()` — Quartil-Bucketing der positiven Tagesdeltas, Streak bricht bei null/negativem Delta (heutiges Null-Delta zählt nicht als Bruch).
- Fehler-Bars: `.overview-error-bars` + `-bar-item`/`-head`/`-typ`/`-count`/`-track`/`-fill`
- Bewertung: `.overview-stars` + `.overview-star` (`--full`/`--half`), `.overview-review-meta`/`-date`/`-trend`
- Figuren-Chips: `.overview-fig-row` + `-count`/`-count-unit`/`-chips`/`-chip`/`-name`/`-avatar` (Avatar-Farbe via `[data-idx="0|1|2"]`)
- Soundtrack-Liste: `.overview-song-list` + `-item`/`-dot` (Akzent-Punkt via `--card-accent`)/`-titel`/`-interpret`/`-count` (Top-Songs nach Häufigkeit, Math via `overviewTopSongs()`/`overviewSongsCount()` in [public/js/book-overview/songs.js](public/js/book-overview/songs.js))
- Fehler-Hinweis: `.overview-notice` (über dem Grid, `role="status"`) + `.overview-notice-text` — amber Warn-Tokens + linker 3 px-Border + Retry-Button (`btn-compact`). Sichtbar via `overviewLoadErrors.length > 0`, wenn ein Endpoint auch nach Retry ausfiel. Verhindert, dass ein leeres Tile als „keine Daten" fehlgedeutet wird.
- Leerzustand-CTA: `.overview-tile--cta` (gestrichelter Rahmen, erbt `.internal-link`-Hover) + `.overview-cta-body`/`-text` (muted)/`-action` (Primary-Akzent). Ein **kombiniertes** Tile, wenn das Buch Seiten hat, aber Figuren/Schauplätze/Szenen noch fehlen (`overviewNeedsAnalysis()`), Klick startet die Komplettanalyse. Statt drei leerer Zählkacheln kommentarlos auszublenden.

**Klick-Verhalten:** `.overview-tile.internal-link` öffnet die zugehörige Karte (über globalen `.internal-link`-Handler aus app.js — nicht selbst verdrahten).

**Hover-Override:** Globaler `.internal-link:hover` setzt `opacity: 0.65`. Für Tiles ungewollt — `.overview-tile.internal-link:hover` setzt `opacity: 1` zurück und nutzt Border/Shadow als Affordance.

**Neuer Tile-Typ:** Bestehende Tile-Klassen wiederverwenden, SVG inline ins Markup, keine externe Vis-Lib für Overview einführen.

### Tile-Size-Policy

Verbindlich pro Tile-Typ. `grid-auto-flow: row dense` füllt mittlere Lücken, Tail-Lücken in der letzten Zeile sind erlaubt. Tiles werden **nie zwischen** anderen Tiles leer gelassen — Span entweder fix grossgenug oder klein genug, dass Dense-Packing die Lücke schliesst.

| Tile | Span | Begründung |
|------|------|-----------|
| Snapshot (Hero) | `--hero` (2) | Hero-Zahl + 5 Sub-Stats brauchen Zeile |
| Trend (Sparkline) | small (1) | SVG skaliert, Trend-% darunter |
| 7-Tage-Bars | small (1) | 7 schmale Bars |
| Heute-Ring | small (1) | Donut + kurze Meta |
| Streak-Heatmap | `--wide` (full) | 53 Wochen × 7 Tage Grid, eigene Zeile |
| Coverage (Donut) | small (1) | Donut + Meta |
| Top-Fehlertypen | small (1) | Bars vertikal gestapelt |
| Letzte Bewertung | small (1) | Sterne + Datum |
| Figuren / Szenen / Schauplätze (Chips) | small (1) | Count + 3-6 Chips, max 2 Zeilen |
| Figuren-Präsenz-Matrix | `--medium` (2) | Spalten-Header (vertikal rotiert) braucht Höhe; mehrere Top-Figuren brauchen Cell-Reihe |
| Schauplatz-Präsenz-Matrix | `--medium` (2) | analog zur Figuren-Matrix |
| Kapitel-Verteilung (Bar+Meta-Liste) | `--medium` (2) | Bar + 5 Meta-Zellen (Δ%, Z, NS, W, S) brauchen horizontalen Platz, sonst wrap |
| Lektorat-Findings pro Kapitel | `--medium` (2) | analog: Bar + Δ% + Count |
| Lektoratszeit pro Kapitel | `--medium` (2) | analog: Bar + Δ% + Dauer |
| Zuletzt bearbeitet (Page-Liste) | `--medium` (2) | Name + Z + NS + Kapitel-Tag pro Zeile |
| Soundtrack (Top-Songs) | small (1) | Count + 6 Songs (Titel + Interpret + Häufigkeit) als kompakte Liste |

**Regel:** Wer einen neuen Tile-Typ hinzufügt, ergänzt diese Tabelle und wählt Span nach demselben Prinzip — Content mit horizontaler Struktur (Bars/Liste/Matrix) → medium; Content mit vertikaler Struktur (Donut, Sparkline, Chip-Cluster) → small. Hero und full-width nur für die im Header dokumentierten Sonderfälle (Snapshot, Streak).

**Container-Query:** `.overview-tile` hat `container-type: inline-size`. Chapter-Row-Reflow (`@container (max-width: 380px)` in [public/css/book-overview/base.css](public/css/book-overview/base.css)) greift, falls ein Listen-Tile doch auf small fällt (Mobile/2-Spalten-Viewport), und bricht das 3-Spalten-Grid in einen Stack — keine zerquetschten Meta-Zellen.

---

## Container-Queries vs. Media-Queries

**Wann was:** Komponente in **fixem Layout-Slot** (Sidebar 280 px breit, Modal 600 px max) → `@media (max-width: …px)`. Komponente in **variablem Slot** (Tile-Grid mit `--hero`/`--medium`/small-Spans, Drawer-Content das je nach Höhe scrollt) → `@container (max-width: …px)`.

**Bestehender Stand:**
- [public/css/book-overview/base.css](public/css/book-overview/base.css) — `.overview-tile` hat `container-type: inline-size`. Chapter-Row-Reflow (`@container (max-width: 380px)`) bricht 3-Spalten-Grid in Stack, falls Tile auf small fällt.

**Pflicht-Pattern:**
```css
.foo-container {
  container-type: inline-size;
  container-name: foo;
}
@container foo (max-width: 380px) {
  .foo-child { … }
}
```

**Regeln:**
- Kein Mix in derselben Regel — entweder Media- oder Container-Query, nicht beide gleichzeitig.
- Mobile-Regel mit Viewport-Bezug (Phone-Layout, Touch-Targets) → Media. Mobile-Regel mit Slot-Bezug (Tile schmal weil 2-Spalten-Grid auf Tablet) → Container.
- Container-Name setzen, sobald mehr als ein Container im Komponenten-Baum nistet.

---

## Print-Styles

**Status:** Nicht supported. Browser-Print für Karten/Editor ist undefiniert. Wer ein Buch oder einen Bericht als PDF braucht, nutzt den Custom-PDF-Export ([routes/jobs/pdf-export.js](routes/jobs/pdf-export.js)).

Kein eigenes `@media print {}` pro Karte einführen — der Aufwand für sauberes Print-Layout wäre erheblich (Page-Breaks, Header/Footer, Schwarzweiss-Fallbacks) und nicht im Scope.

---

## Drawer / Side-Panel

**Status:** Aktuell **kein generisches Drawer-Pattern**. Drawer-artige Inhalte existieren nur als `.heatmap-detail` ([heatmap.css](public/css/analysis/heatmap.css)) — Detail-Box unter der Heatmap-Tabelle, nicht als Slide-In-Side-Panel.

**Wann anlegen:** Sobald ein zweiter Konsument auftaucht (Findings-Detail-Drawer, Figuren-Detail-Drawer, Chat-Side-Panel im Editor). Dann hier dokumentieren, nicht ad-hoc daneben bauen.

**Vorbedingungen für globales Drawer-Pattern:**
- `--z-overlay` (2000) als Layer; Backdrop optional (Modal-Charakter ja → Backdrop, persistenter Begleitpanel → kein Backdrop).
- Slide-In-Animation via `--transition-emphasized`, mit `prefers-reduced-motion`-Fallback (kein Slide, nur Fade).
- Focus-Trap analog `.confirm-overlay` wenn Modal-Charakter.
- `aria-labelledby` + `role="dialog"` (Modal) bzw. `role="complementary"` (persistent).
- Geometrie: feste Breite (z.B. 360 px) mit `min(360px, 100vw - 32px)`-Cap für Mobile.

**Bis dahin:** Detail-Inhalt unter der Liste rendern (analog `.heatmap-detail`) oder als Karte mit `_closeOtherMainCards` (analog Editor + Chat).

---

## Chef-Taste / Boss-Key (`.boss-screen`)

**Use:** Ein-Tasten-Privacy-Vorhang. Im Seiten-Editor (Notebook-Edit-Modus oder Fokus-Modus) blendet `F9` sofort einen reinschwarzen Vollbild-Vorhang über die gesamte App; beliebige Taste oder Klick blendet ihn wieder aus. Reines Schwarz, kein Inhalt, `cursor: none` — maximal unauffällig.

**Markup** (Top-Level in [public/index.html](public/index.html), Geschwister der Session-Banner):
```html
<div class="boss-screen" x-show="bossScreenActive" x-cloak
     @click.prevent.stop="bossScreenActive = false"
     aria-hidden="true"></div>
```

**CSS** ([public/css/layout/layout-base.css](public/css/layout/layout-base.css)): `position: fixed; inset: 0; z-index: var(--z-boss-screen)` (13000 — über allem inkl. Toast/Modal/Banner), `background: #000`, `cursor: none`.

**Logik:** State-Flag `bossScreenActive` in `shellState` ([app-state.js](public/js/app/app-state.js)). Trigger + Dismiss in `handleBossKey` ([editor/shortcuts.js](public/js/editor/shortcuts.js)), via Capture-Listener `@keydown.capture.window` am `<body>` — läuft vor der regulären Hotkey-Kette und schluckt bei aktivem Vorhang jeden Tastendruck (`stopImmediatePropagation`), damit nichts ins Dokument getippt wird. Gate: `this.editMode` (Notebook-Edit; Fokus-Modus hat editMode ebenfalls true).

---

## Z-Index-Stack

**Pflicht-Tokens** ([public/css/tokens.css](public/css/tokens.css)). Hartcoded `z-index: 9999` o.ä. nur, wenn der Layer wirklich neu ist — dann Token ergänzen, nicht ad-hoc setzen.

| Token | Wert | Verwendung |
|-------|------|-----------|
| `--z-base` | 1 | In-flow Standard, `position: relative`-Sticky-Anker (z.B. Heatmap-Body-Cells, Book-Overview-Tile-SVG-Layer) |
| `--z-sticky` | 100 | Sticky Inhalts-Header in Listen/Heatmaps (`.heatmap-table thead`, sticky Filter-Bars) |
| `--z-header` | 200 | Sticky Card-Header, Toolbar-Header (Avatar-/Komplettstatus-Popover-Panels) |
| `--z-popover` | 1000 | Tooltip-Layer, Synonym-Menu, Figur-Lookup, Combobox-Dropdown, Focus-Counter, Token-Setup-Inline-Hint, Ideen-Move-Picker |
| `--z-toolbar` | 1100 | Edit-Bubble-Toolbar (1001), Find-and-Replace (1002) — über Popovers, weil sie auf Selektion reagieren |
| `--z-overlay` | 2000 | Palette-Overlay, künftige Fullscreen-Trigger ohne Modal-Charakter |
| `--z-banner` | 10000 | Session-Banner, Dev-Banner (oben fixed, über Karten und Palette, unter Modals) |
| `--z-modal` | 9500 | Confirm-Dialog Overlay-Backdrop |
| `--z-modal-front` | 11000 | Confirm-Dialog Panel — über Banner und Palette, weil Dialog aus jedem Kontext getriggert werden kann |
| `--z-toast` | 12000 | Reserviert für künftige Toasts/Snackbars (siehe Section „Toast/Snackbar") |
| `--z-boss-screen` | 13000 | Chef-Taste-Privacy-Vorhang (`.boss-screen`) — muss alles inkl. Toast/Modal/Banner verdecken |

**Regeln:**
- Stapel-Verletzung (Layer X muss über Layer Y liegen, ist aber numerisch darunter) → Token-Tabelle hier korrigieren, nicht lokal patchen.
- Zwei Modals gleichzeitig sind verboten (`_closeOtherMainCards` + Confirm-Dialog ist Single-Modal-Garant). Wenn doch → `--z-modal-front` belegt der zuletzt geöffnete.
- `position: fixed` ohne z-index erbt nicht den Stack-Kontext der Eltern — Token ist Pflicht.

---

## Reduced-Motion (Pflicht)

**Globale Regel:** [base.css](public/css/layout/base.css) enthält einen globalen `@media (prefers-reduced-motion: reduce)`-Block, der **alle** Animationen und Transitions auf 0.01ms setzt:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

Das deckt 100 % der Karten-Eingangs-Animationen, Skeleton-Shimmer, Hover-Transitions und Slide-Effekte ab. **Keine pro-Komponente-Override nötig** für die Standard-Cases.

**Pro-Komponente-Override sinnvoll, wenn:**
- Animation hat Funktionssemantik, die ohne Bewegung nicht greift (z.B. Loading-Spinner) → ggf. statisches Icon-Fallback statt einfach ausgeschaltet.
- JS-getriebene Animation (smooth-scroll, manuelle setInterval-Animationen) — die globale CSS-Regel greift hier nicht. JS muss `window.matchMedia('(prefers-reduced-motion: reduce)').matches` prüfen ([public/js/editor/focus.js](public/js/editor/focus.js) als Referenz).

**Bestehende JS-Reduktion:** [editor/focus.js](public/js/editor/focus.js), [book-overview/stats.css](public/css/book-overview/stats.css) (Today-Ring `--active`-Animation explizit auf `none` gesetzt, weil `animation: pulse infinite` auch unter `0.01ms` weiter zappeln würde).

**Nicht-betroffen:**
- Hover-Color-Tints (kein Layout-Shift, < 0.15s)
- Chevron-Rotation `›` 0°→90° (semantischer Marker für Zustand)

Wer eine neue Animation einführt: nichts tun, ausser sie ist `infinite` (dann explizit `animation: none` im Reduced-Motion-Block setzen) oder JS-getrieben (dann `matchMedia`-Check).

---

## Severity-Vokabular (Mapping)

Drei parallele Skalen sind vorhanden — bewusst, weil Use-Cases unterschiedlich sind. Pflicht: das passende Vokabular pro Kontext, nicht querkreuzen.

**Zwei Farb-Achsen in tokens/colors.css:**
- **content-severity** (`--color-stark/-mittel/-schwach` mit `-bg`/`-text`) — Findings, Continuity, Lektorats-Output. Semantisch reicher als ok/warn/err und visuell getrennt, damit Findings nicht wie System-Banner aussehen.
- **operational-status** (`--color-ok-*`, `--color-warn-*`, `--color-err-*`) — Banner, Validation-Border, Job-Status, Sync-Status, System-Hinweise.

Eigene Shades bewusst nicht aliased — Achsen optisch trennen. Regel: Lektorats-/Continuity-Output greift content-severity, Banner/Job/Validation greifen operational-status. Querkreuzen nur, wenn ein Element semantisch beides ist (rar).

| Skala | Klassen | Use-Case | CSS |
|-------|---------|---------|-----|
| **Findings** (Lektorat-Ergebnisse) | `.finding.error` / `.ok` / `.style` | Output von `runCheck` — Border-Color am Findings-Container | [findings.css](public/css/editor/findings.css) |
| **Severity-Tag** (Listen-Anker, Sortier-Marker) | `.severity-tag--kritisch` / `--stark` / `--mittel` / `--schwach` / `--niedrig` | Inline-Tag in `.entity-list` (Lektorats-Findings, Kontinuitäts-Issues, Fehler-Heatmap, Szenen-Wertung) | [entity-list.css](public/css/entities/entity-list.css) |
| **Status-Badge** (Job-/Sync-Status) | `.badge-ok` / `.badge-warn` / `.badge-err` | Job-Queue, Sync-Status, allgemeine Inline-Indikatoren | [buttons-badges.css](public/css/components/buttons-badges.css) |

**Mapping Lektorat-Schweregrad → Severity-Tag → Findings-Klasse:**

| Schweregrad (KI-Output) | `.severity-tag--*` | `.finding.*` | Token |
|-------------------------|--------------------|--------------|-------|
| `kritisch` | `--kritisch` | `.error` | `--color-err-border` |
| `stark` | `--stark` | `.error` | `--color-stark` |
| `mittel` | `--mittel` | `.style` | `--color-mittel` / `--color-style-border` |
| `schwach` | `--schwach` | `.style` | `--color-mittel` / `--color-schwach-bg` |
| `niedrig` | `--niedrig` | `.ok` | `--color-tag-bg` / `--color-ok-border` |

**Regel:** Severity-Tag ist visueller Anker in Listen, Findings-Klasse trägt Border am Output-Container. Beide Skalen werden parallel gesetzt — ein Tag im Listenitem, eine Container-Klasse beim Detail-Render. Wer eine neue Severity-Karte baut: dieselben fünf Stufen + diese Mapping-Zeile, nichts Neues erfinden.

**Anti-Pattern:** `.finding.kritisch` (Kreuzung der Skalen), eigene Klassen wie `.warn-tag` neben `.severity-tag--mittel` (Reinvention).

---

## Toast/Snackbar

**Status:** Ein generischer Job-Done-Toast ist umgesetzt (`.job-toast` in [job-toast.css](public/css/components/job-toast.css), Markup [partials/job-toast.html](public/partials/job-toast.html), State `jobToast` + `_showJobToast()`/`_dismissJobToast()` am Root). Daneben weiterhin lokal: `.palette-toast` ([feature-tiles.css:151](public/css/components/feature-tiles.css#L151)) als Statuszeile innerhalb des Palette-Modals — kein Floating-Snackbar, deshalb keine Migration nötig.

**Markup:**
```html
<div class="job-toast job-toast--ok" role="status" aria-live="polite">
  <span class="job-toast-msg">Komplettanalyse fertig</span>
  <button class="job-toast-close" aria-label="Schliessen">×</button>
</div>
```
- Severity-Modifier: `.job-toast--ok` (Success) / `.job-toast--err` (Error). Mappt auf `--color-ok-*` bzw. `--color-err-*` aus operational-status (siehe Severity-Achsen).
- Position: fixed bottom-right (`--z-toast` = 12000). Mobile (<600px): full-width unten.
- Animation: 160 ms Fade+Slide; bei `prefers-reduced-motion: reduce` nur Fade.

**Trigger:** Root-Handler `_onJobFinished` ([app-jobs-core.js](public/js/app-jobs-core.js)) ruft `_maybeShowJobToast(detail)` für eine Whitelist langlaufender Job-Typen (`komplett-analyse`, `kontinuitaet`, `review`, `kapitel-review`, `figuren`, `book-chat`, `finetune-export`, `pdf-export`, `batch-check`, `werkstatt-brainstorm`, `werkstatt-consistency`). `type === 'check'` (Seiten-Lektorat) ist absichtlich ausgenommen — feuert pro Seitenklick und hat sein eigenes Sidebar-Signal. `status === 'cancelled'` erzeugt keinen Toast.

**Auto-Dismiss:** 4500 ms via `_jobToastTimer`. Close-Button setzt Toast sofort auf `null`.

**Regeln für neue Konsumenten:**
- `aria-live="polite"` für Info/Success, `aria-live="assertive"` für Error (Markup oben → `polite`; bei Pflicht-Error im Markup overriden).
- Niemals modal/blockierend. Für Bestätigungen ist `.confirm-overlay` da.
- Toast-Text immer i18n-Key (Severity-Suffix `toast.job.done` / `toast.job.failed` separat, damit Job-Labels wiederverwendbar bleiben).
- Bei zusätzlichen Use-Cases (Save-Success, Network-Recovery): zweiten State `appToast` o.ä. *nicht* anlegen — `jobToast` umbenennen in `appToast` und Severity/Source-Felder erweitern.

**Card-interne Status-Hinweise** (Save-Bestätigung in einer Form, Validation-Fehler innerhalb einer Karte) bleiben bei `.card-status` / `.book-settings-saved` / `.book-settings-error` — Toast nur für globale, kartenübergreifende Events.

---

## Accessibility (A11y)

Pflicht-Patterns. Verstreute aria-Verwendungen werden hier zentralisiert; neue Komponenten orientieren sich daran statt eigene Lösungen zu finden.

### Klickbare Nicht-Buttons

`.internal-link` (siehe CLAUDE.md harte Regel) wird global per MutationObserver tastatur-erreichbar gemacht (`role="button"`, `tabindex="0"`, Enter/Space → click). Keine eigene Verdrahtung pro Element.

### Toggle-Sections (Accordion)

`.collapsible-toggle` braucht `:aria-expanded="open"`. Der Chevron-Marker `›` ist optisch redundant, daher `aria-hidden="true"` am `<span class="history-chevron">` setzen, sonst liest Screen-Reader „›" als „chevron right".

### Combobox

`Alpine.data('combobox')` setzt `role="combobox"` + `aria-controls` + `aria-expanded` automatisch. Liste hat `role="listbox"`, Items `role="option"` mit `aria-selected`. Kein eigenes ARIA-Setup im Konsumenten-Markup.

### Dialoge / Modale

`.confirm-overlay` → `role="dialog"` + `aria-modal="true"` + `aria-labelledby`/`aria-describedby` auf den Message-Container. Focus-Trap: erstes fokussierbares Element bekommt Fokus beim Open, Esc schliesst, Tab/Shift+Tab bleibt im Modal. Beim Close: Fokus zurück auf den auslösenden Trigger.

Bei nativem `<dialog>` + `showModal()` liefert der Browser das (siehe „Modal-Shell"). Overlays, die kein `<dialog>` sein können, holen es sich per `x-trap.inert` — Pattern + Modifier-Wahl in „[Overlay-Focus-Trap](#overlay-focus-trap-x-trap)". Ein `aria-modal="true"` ohne eine der beiden Mechaniken ist eine Behauptung ohne Deckung.

Gilt analog für Palette-Overlay, Token-Setup-Modal, Avatar-Menu (letzteres als `role="menu"`, Items `role="menuitem"`).

### Live-Regions (Status-Updates ohne Visual-Refocus)

| Use-Case | Region |
|---------|--------|
| Job-Status (Lektorat läuft, Findings X/Y) | `aria-live="polite"`, `aria-busy="true"` während Loading |
| Save-Indicator (`.save-indicator--draft/--offline`) | `aria-live="polite"` |
| Fehler-Banner (Session-Expired, Network) | `aria-live="assertive"` |
| Toast (künftig) | `polite` für Info, `assertive` für Error |

Card-Loading-States setzen am `.card-status`-Element `aria-busy="true"` solange `loading` truthy ist.

### Form-Validation

Inputs mit Fehler: `aria-invalid="true"` + `aria-describedby="<id-of-error>"` auf den Input. Fehler-Element bekommt eigene ID. Kein Fehler nur visuell via Roter Border — Screen-Reader liest sonst nichts.

### Focus-Visible

Globaler `:focus-visible`-Stil in [base.css](public/css/layout/base.css). Karten dürfen nicht per `outline: none` ohne Ersatz überschreiben. Wenn lokal eigener Fokus-Stil nötig: `:focus-visible` mit `box-shadow: 0 0 0 2px var(--color-border-focus)` oder analog.

### Tastatur-Navigation in Listen

`.entity-list` mit klickbaren Zeilen → Pfeil-Up/Down navigiert, Enter aktiviert (analog Palette). Roving-Tabindex statt Tab durch alle 200 Items. Pattern: ein Item `tabindex="0"`, alle anderen `tabindex="-1"`, Pfeile verschieben den Tabindex.

### Reduzierte Bewegung

Siehe Section „Reduced-Motion" oben.

### Lang-Attribut

Inhalte in einer Locale, die vom `<html lang="...">`-Default abweicht, bekommen `lang="de"` / `lang="en"` am Container. Relevant für Chat-Antworten und Seiten-HTML (User-Sprache pro Buch).

### Geo-Karte (Leaflet)

Geografische Karte mit Markern (aktuell: Orte-Karte View-Mode `map`, nur bei `book_settings.orte_real`). Leaflet lädt lazy via `loadLeaflet()` aus [public/js/lazy-libs.js](public/js/lazy-libs.js) (vendored `public/vendor/leaflet-1.9.4/`, CSS wird per `<link>` injiziert). Karten-Logik als Methods-Modul (z.B. [public/js/book/orte-map.js](public/js/book/orte-map.js)) in die Card gespreadet; Map-Instanz als transienter Runtime-Handle (`_map`/`_markers`), Teardown via `map.remove()` in `destroy` + auf `book:changed`/`view:reset`.

```html
<div x-ref="orteMapEl" class="ort-map" role="application" :aria-label="$app.t('orte.map.tab')"></div>
```

- Container nutzt `x-show` (nicht `x-if`) → `$refs` bleibt verfügbar; nach Sichtbarwerden `map.invalidateSize()` (Container hatte 0px in `display:none`).
- Tiles: OSM Public (`tile.openstreetmap.org`) — Browser-Requests, Betreiber-Sache. Attribution via `tileLayer`-Option Pflicht.
- Marker-Popup-HTML mit `escHtml()` escapen (KI-/User-Felder).
- CSS: [public/css/entities/orte-map.css](public/css/entities/orte-map.css).

---

## CSS-File-Inventar

Welche Datei besitzt welche Klassen. Bei neuer Klasse: erst hier prüfen, ob ein File thematisch passt — sonst neue Datei anlegen + in [public/index.html](public/index.html) **und** [tests/fixtures/focus-harness.html](tests/fixtures/focus-harness.html) einhängen (gleiche Reihenfolge!).

### Zwei Regeln, die jede Datei betreffen

**1. `@layer components` ist Pflicht.** [tokens.css](public/css/tokens.css) etabliert `@layer base, components, utilities` — **unlayerte Regeln schlagen jeden Layer**, unabhängig von Spezifität. Eine Datei ohne Layer gewinnt also still gegen jede layered Komponentenregel, und der Fehler fällt erst auf, wenn ein gezielter Override nicht greift. Neue Datei ⇒ Inhalt in `@layer components { … }` fassen (Datei-Kopfkommentar davor). Genau **drei** Ausnahmen, jede mit Grund:

| Unlayered | Warum |
|---|---|
| [tokens/](public/css/tokens/)`*.css` | Custom-Properties sind global; sie konkurrieren nicht über die Kaskade. |
| [share.css](public/css/share.css) + [share/](public/css/share/)`*.css` | Der Reader überschreibt bewusst die geteilten `components/`-Module (`manuscript-*`, `comment-rail`, `floating-dock`) und gewinnt über den Layer-Rang statt über Spezifitäts-Wettrüsten. |
| [entities/orte-map.css](public/css/entities/orte-map.css) | `lazy-libs.js` hängt `vendor/leaflet-*/leaflet.css` **zur Laufzeit** an den `<head>` — unlayered und nach allem anderen. Läge unsere Datei in `components`, gewänne Leaflet gegen jeden unserer Overrides. |

**2. Der Share-Reader lädt `tokens.css` nicht.** [share.html](public/share.html) verlinkt nur `share.css` + die geteilten `components/`-Module. Dort sind `--space-*`, `--font-size-*`, `--fw-*`, `--z-*`, `--color-*` **undefiniert**. Daraus folgt für alle Dateien im share-erreichbaren Satz (`share.css`, `share/*`, sowie `components/{icons,manuscript-stream,manuscript-content,comment-rail,floating-dock}.css`):
- rohe `px`-, `z-index`- und `font-weight`-Werte sind dort **richtig**, nicht nachlässig — sie sind der einzige Weg;
- geteilte Module, die von beiden Seiten benutzt werden, brauchen entweder einen Fallback (`var(--fw-semibold, 600)`) oder eine neutrale Variable, die der Reader auf sein `--share-*`-Pendant mappt (Muster: `--cr-*` in `comment-rail.css`, `--ms-*` in `manuscript-stream.css`, `--dock-*` in `floating-dock.css`);
- ein neues geteiltes Modul gehört in **beide** Shells: [public/index.html](public/index.html) und [public/share.html](public/share.html) (plus [tests/fixtures/share-reader-harness.html](tests/fixtures/share-reader-harness.html)).

Struktur: 8 thematische Subfolder unter [public/css/](public/css/) + Root-Solitäre. Cascade-Order = Lade-Order in [public/index.html](public/index.html).

### Root (Facade + Solitäre)
| File | Inhalt |
|------|--------|
| [tokens.css](public/css/tokens.css) | Cascade-Layer-Order, `@font-face`, `@import` der Token-Module aus `tokens/`. Slim Facade — keine Tokens direkt drin. Unlayered. |
| [card-accents.css](public/css/card-accents.css) | `.card--<key> { --card-accent: var(--card-accent-<key>); }` — SSoT für Karten-Akzentfarben (alle Karten). |
| [chat.css](public/css/chat.css) | Seiten-/Buch-Chat. |
| [search.css](public/css/search.css) | Volltext-Suche, Buchwahl. |
| [tokens-est.css](public/css/tokens-est.css) | Token-Schätzung Inline-Badges + Tooltip. Nur das — der Figuren-Bestand, den die Datei entgegen ihrem Namen lange mittrug, liegt in `entities/figuren*.css` und `components/kapitel-badges.css`. |
| [landing.css](public/css/landing.css) | Landing-/Register-/Login-Seiten (kein SPA-Bundle). |
| [share.css](public/css/share.css) | Facade des Share-Reader-Stylesheets (kein SPA-Bundle; nur via `share.html`/`share.gone.html`/E2E-Harness verlinkt). `@import` der `share/`-Module in Quell-Reihenfolge (= Kaskade). |

### share/ (Reader-View, contiguous Module der `share.css`-Facade)
| File | Inhalt |
|------|--------|
| [share/theme.css](public/css/share/theme.css) | `--share-*`/`--cr-*`/`--ms-*`-Custom-Properties (Light/Dark), explizite Theme-Wahl, `prefers-color-scheme`. |
| [share/layout.css](public/css/share/layout.css) | Reset, `body.share-page`, Skip-Link, Lese-Progress, Sticky-Header, Optionen-Menü (Meatball), Theme-Switcher, Main, Intro. |
| [share/content.css](public/css/share/content.css) | Lese-Inhalt: `.share-content`-Typografie, Prosa-Absatzmodell, Szenentrenner, `.ms-*`-Stream-Blöcke, `.share-toc`, Editor-Mark-Neutralisierung. |
| [share/comments.css](public/css/share/comments.css) | Leser-Kommentare: `.share-comments*`-Rail (Desktop-Seitenleiste + Mobile-Sektion), `.share-thread*`, `::highlight(share-anchor*)`, Selektions-Button + `.share-composer`-Overlay. |
| [share/reading.css](public/css/share/reading.css) | Leseoptionen des Readers: Schriftgrad-/Satzbreiten-Regler (`.share-prefs*`, Segment-Tasten), angewandt über `--share-reader-font-scale` / `--share-reader-measure`. |
| [share/tts.css](public/css/share/tts.css) | Vorlese-Dock des Readers: Verankerung (`fixed` unten links), Mapping der neutralen `--dock-*` aus [components/floating-dock.css](public/css/components/floating-dock.css) auf die `--share-*`-Tokens, Wiedergabe-/Fehler-Zustände, `::highlight(tts-sentence)`. |

### tokens/ (Custom-Properties)
| File | Inhalt |
|------|--------|
| [tokens/colors.css](public/css/tokens/colors.css) | Farb-Tokens Light (`:root`) + Dark (`:root[data-theme="dark"]`). Inkl. `--color-text` + `--color-muted` + `--color-subtle` + `--color-faint`, Status-Achsen (content-severity + operational), `--card-accent-*`-Hues. |
| [tokens/typography.css](public/css/tokens/typography.css) | `--font-sans` / `--font-serif`, `--font-size-xs/sm/base/md/lg/xl/2xl`, `--fw-*`, `--lh-*`, Control-Sizes. |
| [tokens/spacing.css](public/css/tokens/spacing.css) | `--space-*` (4px-Raster), `--pad-*`, `--border-*`, `--radius-sm/-md/-lg` (0/2/4). |
| [tokens/motion.css](public/css/tokens/motion.css) | `--transition-*`, `--shadow-*`, `--opacity-*` + `prefers-reduced-motion`-Override. |
| [tokens/scale.css](public/css/tokens/scale.css) | `--z-*` Stack. |

### layout/ (Foundation)
| File | Inhalt |
|------|--------|
| [layout/base.css](public/css/layout/base.css) | Reset, `h1`-`h3`, `.skip-link`. |
| [layout/layout-base.css](public/css/layout/layout-base.css) | `.session-banner`, `.dev-banner` (oben fixed). |
| [layout/twocolumn.css](public/css/layout/twocolumn.css) | `.layout` / `-sidebar` / `-main` (Editor-Layout). |
| [layout/utilities.css](public/css/layout/utilities.css) | `.list-header`, Job-Queue-Footer, `.palette-badge`, `.row` Flexbox-Utility, `.batch-status`. |
| [layout/safari-fallback.css](public/css/layout/safari-fallback.css) | Safari < 16.2 `color-mix()`-Fallbacks via `@supports not (...)`. **Wichtig: muss spät in der Cascade geladen werden** (Override-Wirkung), darum eigenes File und nicht in andere Datei gemergt. |

### components/ (geteilt)
| File | Inhalt |
|------|--------|
| [components/card-form/card-shell.css](public/css/components/card-form/card-shell.css) | `.card`, `.card-header*`, `.card-title*`, `.card-eyebrow`, `.card-subline*`, `.card-toolbar`, `cardFadeIn`. Die Karte selbst — was DARIN liegt, steht in `card-blocks.css`. |
| [components/card-form/card-blocks.css](public/css/components/card-form/card-blocks.css) | **Geteiltes Vokabular des Kartenkörpers** (siehe „Karten-Innenraum“): Vertikalrhythmus (`.card-section` + `--tight`), `.card-section-head` (+ `--baseline`/`--flush`), `.card-section-title`, `.card-hint` (+ `--sm`/`--right`/`--warn`/`--lead`), `.card-status` (+ `--error`), `.muted-msg*`, `.progress-bar*`, `.filter-bar*`/`.filter-count`/`.filter-toggle`/`.filter-search-*`. Besitzer-Datei für Klassen, die quer durch alle Karten laufen — vorher lagen sie in `figuren.css`, `page-list.css`, `tree-history.css` und `entity-list.css`. |
| [components/card-form/form-elements.css](public/css/components/card-form/form-elements.css) | Form-Felder (`input`/`select`/`textarea`), `.card-form-*` Grid + Wertspalten-Bausteine (`.form-stack`/`-inline`/`-check`/`-radio-group`), `.card-empty*`. Die **Erscheinung** von `.card-form-hint`/`.card-form-field-note`/`.card-empty-hint` kommt aus `card-blocks.css` (`.card-hint`-Gruppe); hier steht nur noch deren Position im Raster. |
| [components/card-form/card-actions.css](public/css/components/card-form/card-actions.css) | `.card-actions*`, `.action-group`/`.action-sep`, `.btn-card-close`. |
| [components/combobox.css](public/css/components/combobox.css) | `.combobox-*` — Searchable-Select-Komponente (Trigger, Dropdown, Optionen, Gruppen-Header, Compact-Variante, Footer-Button). |
| [components/buttons-badges.css](public/css/components/buttons-badges.css) | `<button>` Hierarchie, `.badge-*`, `.avatar-*`, `.btn-group`, `.btn-compact`. |
| [components/icon-btn.css](public/css/components/icon-btn.css) | `.icon-btn` (outlined) + `.icon-btn--ghost` — SSoT für alle Icon-only Buttons (Graph/Map/Mindmap-Toolbars, Header-Cluster, Plot-Board, Action-Groups). Feature-Marker setzen nur Deltas darauf. |
| [components/tabs.css](public/css/components/tabs.css) | `.tabs` / `.tabs-btn` + `--active`/`--scrollable`/`--fullwidth`. Basis scrollt horizontal (Scrollbalken versteckt, Rand-Schatten als Signal). |
| [components/device-tokens.css](public/css/components/device-tokens.css) | `.device-tokens-*` — Token-Verwaltung in User-Settings (Reveal-Block für Klartext-Token einmalig nach Create, Row-List statt Table). |
| [components/my-stats.css](public/css/components/my-stats.css) | „Meine Statistik"-Karte (aggregierte Schreib-Werte über alle eigenen Bücher). Teilt **das Tile-Grid + die Tile-Atome der Buch-Übersicht** (`.overview-grid` + `.overview-tile`/`--hero`/`--medium`/`--wide`, `.overview-hero-*`, `.overview-substat*`, `.overview-streak-*`, `.overview-weekday-*`, `.overview-consistency-*` — siehe „Book-Overview-Tiles" + `book-overview/`); Akzent = globaler `var(--color-accent)`, nicht die Karten-Hue. Tiles: Umfang-Hero (Zeichen gross + inline Sub-Stats), Schreibrhythmus (Kennzahlen-Grid + Streak-Heatmap), Wochentags-Muster (Balken), Meilensteine, Entwicklung (Chart). Eigene Reste: `.mystats-controls` / `.mystats-chart-wrap` (240px) für den Entwicklungs-Chart (Chart.js lazy; Modus-`.btn-group` Gesamt/Pro Buch + Metrik-Combobox + Zeitraum-`.btn-group`, mirror von `.book-stats-chart-wrap`); `.mystats-badges` / `.mystats-badge` (eckig, `var(--color-accent)`) + `.mystats-milestone-next(-head)` für die Meilensteine. Pro-Buch-Modus: eine Linie je Buch aus fester JS-Farbpalette, Legende unten. Eckig, Tabular-Nums. |
| [components/my-books.css](public/css/components/my-books.css) | „Meine Bücher"-Karte (Bücherregal: Anheften/Archivieren/Fertig + Kennzahlen je Buch). Fast alles kommt aus bestehenden Patterns — `.card-toolbar`, `.tabs`/`.tabs-btn` (Reiter In Arbeit/Fertig/Archiviert/Alle), `.filter-bar filter-bar--inline`, `.table-scroll`, `.sortable-th` (`sortableTable`), `.icon-btn icon-btn--ghost` (Pin/Archiv/Fertig/Öffnen), `.badge-ok`/`.badge-warn`/`.badge-neutral`, und die Summenzeile nutzt die Kennzahl-Atome der Buch-Übersicht (`.overview-substats`/`.overview-substat*`). Eigen sind nur: `.mybooks-summary` (Rahmen der Summenzeile, Akzentkante links), `.mybooks-tab-count`, die Tabellen-Typografie (`.mybooks-table` mit **schmalem `--space-sm`-Zellenpadding**, damit zehn Spalten ohne Horizontal-Scroll lesbar bleiben — `.sortable-th` braucht deshalb seine Chevron-Reserve explizit zurück; `.mybooks-num` rechts + Tabular-Nums, `.mybooks-sub` als Zweitzeile in der Zelle, `.mybooks-book*`, `.mybooks-chip`), die **sticky Aktions-Spalte** (`th:last-child` + `.mybooks-actions`, `position: sticky; right: 0` mit `--color-card-bg` — die Schalter sind der Grund, das Regal zu öffnen, und dürfen beim Scrollen nicht als erstes verschwinden) und die zwei Zeilen-Zustände `.mybooks-row--archived` (gedämpfter Text, **ohne** `opacity` auf der Zeile — das dimmte auch die Knöpfe, mit denen man sie zurückholt) und `.mybooks-row--pinned` (Akzent-Kante via `inset box-shadow` an der ersten Zelle). Es gibt **keine Status-Spalte**: fertig/archiviert stehen als Badges neben dem Buchnamen (`.mybooks-book-meta`), wo auch Kategorie und Fremd-Rolle sitzen. Akzent = `--card-accent-mybooks`. |
| [components/help.css](public/css/components/help.css) | „Hilfe & Funktionen"-Karte (`.card--help`) — statischer Funktionsüberblick für den Einstieg, buch-unabhängig. `.help-intro` (Lede), `.help-features` (2-Spalten-Grid, mobil 1-spaltig) mit `.help-feature`/`-title`/`-desc` (Accent-Border-Left = globaler `var(--color-accent)`), `.help-palette-hint` (muted Fusszeile). Inhalt = Landing-Feature-Texte (`landing.featNTitle/Desc`, SSoT). Dazu der globale Header-`?`-Button (`.header-help-btn[aria-pressed=true]`) und der Welcome-Empty-State: Textlink (`.welcome-help-link`) plus 3-Schritt-Ablauf (`.welcome-steps`/`.welcome-step`/`.welcome-step-num` eckig/`.welcome-step-body`/`-title`/`-desc`, Schreiben→Analysieren→Überarbeiten) und Philosophie-Zeile (`.welcome-philosophy`, muted) — vermittelt früh die rückwärtsgewandte KI. |
| [components/onboarding.css](public/css/components/onboarding.css) | „Erste Schritte"-Karte (`.card--onboarding`, Accent `--card-accent-onboarding`) — Fortschritts-Checkliste für den Einstieg, buch-unabhängig. `.onboarding-intro` (Lede), `.onboarding-progress` (Zeile: globaler `.progress-bar` + `.onboarding-progress-count`), `.onboarding-steps`/`.onboarding-step` (Accent-Border-Left; `.is-done` = gedimmt + gefüllter `.onboarding-step-num` eckig; `.onboarding-step-state` „Erledigt"-Badge eckig vs. `.onboarding-step-cta` Button), `.onboarding-demo` (gestrichelte Beispielbuch-Box), `.onboarding-alldone`/`-error`/`-palette-hint`. Dazu der First-Login-`.onboarding-welcome-banner` (schlanke, wegklickbare Leiste in index.html, `-text`/`-actions`). Mobil (≤640px): Steps umbrechen, Demo-Box + Banner stapeln. |
| [components/confirm-dialog.css](public/css/components/confirm-dialog.css) | `.confirm-overlay` / `-dialog`, Shortcuts-Overlay. |
| [components/danger-zone.css](public/css/components/danger-zone.css) | `.danger-zone` + `-title`/`-row`/`-text`/`-actions`/`-section`/`-btn` — abgesetzter Block für unwiderrufliche Aktionen (Konto löschen, Buch löschen, Restore). Fehler-Tokens statt Karten-Akzent. Siehe „Danger-Zone"; zwei handkopierte Altbestände (`.book-settings-danger-*`, `.admin-backup-danger*`) ziehen bei Berührung nach. |
| [components/snapshot-reader.css](public/css/components/snapshot-reader.css) | `.snapshot-reader*` — Vollbild-Overlay (Modal-Charakter) zum nur-lesenden Öffnen einer Fassung (`book_snapshots`) im **Bucheditor-Look** (reuse `.book-editor-*` aus `editor/book/book-editor.css`, read-only): Backdrop/Panel/Header, Export-Leiste (Schnell-Formate + PDF-Profil), Status-Badges (`--changed`/`--removed`), Inline-Wort-Diff gegen den aktuellen Buchstand (`.snapshot-reader__diff ins.diff-add`/`del.diff-del`). |
| [components/manuscript-stream.css](public/css/components/manuscript-stream.css) | `.ms-chapter` / `.ms-page` / `.ms-page__title` / `.ms-page__body` sowie der **Titel-Kopf eines Beitrags** (`.ms-page--article`, `.ms-page__title--headline`, `.ms-head__kicker`, `.ms-head__lead`; Markup-SSoT [lib/headline-render.js](lib/headline-render.js) — die Seiten-Caption ist sonst eine kleine gesperrte Marginalie, als Schlagzeile wäre das falsch, darum Variantenklassen statt zweitem Renderer) — geteilter **read-only Manuskript-Stream-Look** (Kapitel + Seiten als Fluss), gespiegelt vom Bucheditor (`editor/book/book-editor.css` = editierbare Master-Variante). Markup aus [public/js/manuscript-render.js](public/js/manuscript-render.js). Neutrale `--ms-*`-Variablen, jeder Kontext bridged sie auf seine Tokens (Share: `--share-*` in `share.css`). Nur Stream-Rahmung; Body-Typografie bleibt kontext-spezifisch. Konsument: Share-Reader-SSR. |
| [components/manuscript-content.css](public/css/components/manuscript-content.css) | **SSoT der Block-Typografie des gespeicherten Seiten-HTML** — jeder Block, den der Notebook-Editor schreiben kann (Überschriften h1–h6, Inline-Auszeichnung `u`/`s`/`sup`/`sub`, Listen, Checkbox-Listen `ul.todo`, Tabellen, Bilder + `figure`/`figcaption`, Trenner inkl. `hr.pagebreak`/`hr.blankpage`, `pre`/`code`, Gedichte `div.poem`) plus die Import-Artefakte (BookStack-`.callout` + `.pullquote`, orphan `<br>` nach `</blockquote>`). Pendant zu `manuscript-stream.css`: das stylt die *Rahmung*, hier steht der *Inhalt*. Drei Konsumenten rendern dasselbe HTML und teilen die Regeln: `.page-content-view` (Notebook), `.book-editor-page-body` (Bucheditor + Fassungs-Reader), `.share-content` (Share-Reader-SSR). Neutrale `--mc-*`-Variablen, je Kontext auf `--color-*` bzw. `--share-*` gemappt. Kontext-Abweichungen (Absatzmodell, Zitat-Einzug, Reader-Überschriftengrössen, Edit-Modus-Zustände) bleiben beim Konsumenten und überschreiben von dort — in `index.html` **vor** `page-view.css`/`book-editor.css` laden (gleicher `@layer`), Share-Regeln sind unlayered und gewinnen ohnehin. |
| [components/comment-rail.css](public/css/components/comment-rail.css) | Geteilte **Kommentar-Karten-Optik** (`.comment-rail__thread` + Quote-Snippet, Meta/Avatar-Pip, Body, Antwort-Box, `.comment-rail-diff`) für alle drei Leisten: Notebook-Leseansicht + Bucheditor (SPA-Tokens) und Share-Reader (`--share-*`). Neutrale `--cr-*`-Schnittstelle (Fallback auf SPA-Tokens → die zwei SPA-Leisten brauchen kein Mapping; Share mappt alle `--cr-*` in `share.css` auf `body.share-page`). Kontext-spezifisch bleiben Layout, Aktions-Buttons und die `::highlight()`-Regeln. |
| [components/icons.css](public/css/components/icons.css) | `.icon`-Klasse, SVG-Sprite-Konsumenten. |
| [components/job-toast.css](public/css/components/job-toast.css) | `.job-toast` (Job-Done-Floater). |
| [components/user-chip.css](public/css/components/user-chip.css) | User-Avatar-Chip. |
| [components/feature-tiles.css](public/css/components/feature-tiles.css) | Palette (Hero/Overlay/Panel/Item), Quick-Pills. |
| [components/tooltip.css](public/css/components/tooltip.css) | `.tip-layer` / `.tip-bubble` / `.tip-arrow` für `[data-tip]`. |
| [components/kapitel-badges.css](public/css/components/kapitel-badges.css) | `.kapitel-badges` / `.kapitel-badge` (+ `--primary`/`--secondary`/`--more`) — die Kapitel-Plakette an einer Entitätszeile. Geteilt von Figuren, Orten, Szenen, Songs, Kontinuität, Plot-Beats, Weltfakten und der Quellen-Erkennung; darum Komponente und nicht Feature-Datei. |
| [components/graph-tooltip.css](public/css/components/graph-tooltip.css) | `.graph-tooltip` (+ `.visible`, `strong`/`em`/`p`-Zeilen) — Hover-Detailkarte über einem vis-network-Canvas. Geteilt von Figuren-Graph (`#figur-tooltip`) und Motiv-Konstellation (`#motiv-tooltip`); positioniert wird in [public/js/graph-kit/tooltip.js](public/js/graph-kit/tooltip.js). Nicht `[data-tip]` — die Karte hängt an einem Canvas-Knoten, nicht an einem DOM-Element. Siehe „Graph-Tooltip (vis-network)". |
| [components/sortable-table.css](public/css/components/sortable-table.css) | `.sortable-th` + `--asc`/`--desc`-Modifier für die `sortableTable`-Alpine-Komponente. |
| [components/year-month-heatmap.css](public/css/components/year-month-heatmap.css) | `.ymheat-*` — geteiltes Jahr×Monat-Raster (Jahre als Zeilen, 12 Monate als Spalten), Zell-Level 0..4 aus `var(--ymheat-accent)`, `--has`-Eckmarker, `--current`-Innenring, `--active`-Auswahlring. Self-containing (`container-type`). Konsumenten: Rückblick-Karte + Buch-Übersicht. Siehe „Jahr×Monat-Heatmap". |
| [components/toggle-switch.css](public/css/components/toggle-switch.css) | `.toggle-switch` (Track/Thumb/Label) für das `toggleSwitch`-Primitive — eckiger Boolean-Schalter, Ersatz für `.checkbox-row`. |
| [components/file-drop.css](public/css/components/file-drop.css) | Generischer Baseline-Style (`cursor: pointer`) für das `fileDrop`-Primitive; Visuals + `is-drag`-Tönung beim Konsumenten. |
| [components/folder-import.css](public/css/components/folder-import.css) | Folder-Import-Karte (Drop-Zone, Mode-Toggle, Progress, Result). |
| [components/btn-close.css](public/css/components/btn-close.css) | `.btn-close` — Primitive der Schliessen-Taste (randlose Fläche, `inline-flex`-Zentrierung des `x`-Icons). Varianz über `--close-size`/`--close-pad`/`--close-color`. Siehe „Icon-Sprache" → Schliessen; acht Altbestände ziehen bei Berührung nach. |
| [components/status-msg.css](public/css/components/status-msg.css) | `.success-msg` / `.error-msg` (+ `--banner`-Variante mit Fläche) — app-weite Status-Meldungen aus den Status-Tokens. **Eindeutiger Besitzer für zwei generische Klassennamen**, die vorher in `admin/admin-settings.css`, `chat.css` und `page/page-list.css` verteilt lagen; die Darstellung hing dadurch an der Ladereihenfolge unbeteiligter Dateien. Konsumenten: Admin-Einstellungen, API-/Geräte-Token, Chat- und Lektorat-Statusstrings. |
| [components/floating-dock.css](public/css/components/floating-dock.css) | `.dock` / `.dock-btn` (+ `--sub`) / `.dock-status` — schwebender Werkzeug-Dock am Rand der Lesefläche (runde Icon-Taste + Status-Pille mit Punkt-Indikator). Geteilte SSoT für **drei** Konsumenten: `.stt-dock` (Diktat, sticky rechts), `.tts-dock` im Notebook (Vorlesen, sticky links) und `.tts-dock` im Share-Reader (fixed links). Neutrale `--dock-*`-Variablen mit Fallback auf die SPA-Tokens → die zwei SPA-Docks brauchen kein Mapping, der Reader mappt sie in `share/tts.css` auf `--share-*`. Verankerung, Zustandsfarben und Puls-Animationen bleiben beim Konsumenten. |
| [components/color-picker.css](public/css/components/color-picker.css) | `.color-picker` / `__swatch` / `__popover` / `__opt` (+ `--on`, `--none`) — Farbwähler-Popover für Ordnungsfarben. Geteilt zwischen Motiv-Werkstatt (Themen) und Plot-Werkstatt (Akte, Handlungsstränge). Die Farbe liefert der Konsument per `--col-accent`; das Modul kennt keine Palette, nur die Form. |
| [components/editor-dialog.css](public/css/components/editor-dialog.css) | `.editor-dialog` / `__inner` / `__head` / `__title` / `__actions` / `__spacer` — Schale der modalen Notebook-Editor-Dialoge (natives `<dialog>`, Focus-Trap + ESC vom Browser). Geteilt von Diagramm- und Tabellen-Dialog; Breite pro Dialog über `--dlg-width`/`--dlg-max-width`. Der Rumpf (das eigentliche Werkzeug) bleibt beim Konsumenten. |
| [components/snapshots.css](public/css/components/snapshots.css) | Fassungen-Karte (`snapshotsCard`): Capture-Leiste + Drift-Hinweis (`.snapshots-drift` „lohnt sich eine neue Fassung?", operational-status-Achse, `--worth`-Modifier amber-getönt + `.snapshots-drift__head`/`__tags`) + Fassungs-Liste + Buch-Level-Diff zweier Fassungen. Tabelle reuse `.entity-grid-table`; Diff-Zellen reuse `revision-diff-*` aus `page/page-revision-viewer.css` — hier nur snapshot-spezifische Zell-Tweaks. |

### page/
| File | Inhalt |
|------|--------|
| [page/page-list.css](public/css/page/page-list.css) | Seiten-Liste in Sidebar, `.tok-stats`, `.tok-totals`. |
| [page/page-view.css](public/css/page/page-view.css) | `.page-content-view` Reading-Frame, Callouts, Marginalia-Stripe, Mention-/Channel-Chips. |
| [page/stt-dock.css](public/css/page/stt-dock.css) | `.stt-dock` — STT-Diktat-Dock (Notebook-Edit), schwebend unten rechts im Edit-Feld. |
| [page/tts-dock.css](public/css/page/tts-dock.css) | `.tts-dock` — TTS-/Proof-Listening-Dock (Notebook-Read), schwebend unten links + `::highlight(tts-sentence)`. |
| [page/page-content-skeleton.css](public/css/page/page-content-skeleton.css) | `.page-content-skeleton` — Prosa-Schimmer-Lade-Skelett anstelle der `.page-content-view` (Notebook Read-Modus). |
| [page/sidebar-calendar.css](public/css/page/sidebar-calendar.css) | `.sidebar-calendar` — Monats-Grid + Stepper für Tagebuch-Sidebar. |
| [page/diary-anniversary.css](public/css/page/diary-anniversary.css) | `.diary-anniversary` / `.diary-range` — Rückblick „An diesem Tag" + Zeitraum-Suche im Kalender-Sidebar. |
| [page/page-revision-viewer.css](public/css/page/page-revision-viewer.css) | Page-Revision-Diff-Viewer. |
| [page/tree-history.css](public/css/page/tree-history.css) | Sidebar-Tree, `.history-*`, `.history-chevron`. |
| [page/tagebuch-rueckblick.css](public/css/page/tagebuch-rueckblick.css) | `.card--tagebuchRueckblick` — Rückblick-Karte, editorial: `.rb-essay` (Zusammenfassung als ruhiger Lesetext, max 64ch), `.rb-facets`/`.rb-facet` (worüber/wer/wo — Label-Spalte + `.rb-word`-Stichwörter mit dezentem `.rb-word-count`, Klick → Belege-Popover), `.rb-tage` (bemerkenswerte Tage als Akzent-Liste mit linker Karten-Hue-Kante). Die History-Kalenderansicht nutzt das geteilte `.ymheat-*`-Pattern (`.rb-ymheat` setzt nur Karten-Hue + `--ymheat-max`). |

### editor/
Drei Editoren leben in eigenen Subfoldern (`book/`, `focus/`, `notebook/`); editor-übergreifende Chrome-Komponenten unter `shared/`. Kein Editor importiert CSS aus einem anderen Editor.

| File | Inhalt |
|------|--------|
| [editor/shared/editor-chrome.css](public/css/editor/shared/editor-chrome.css) | `.save-indicator`, `.editor-conflict-banner`, `.editor-presence-banner`, `.editor-draft-banner` — von Notebook + Focus + Figur-Werkstatt konsumiert. |
| [editor/shared/conflict-resolution.css](public/css/editor/shared/conflict-resolution.css) | Block-Level-Merge-Konflikt-Modal: `.conflict-overlay`, `.conflict-modal`, `.conflict-block`, Block-Previews. Notebook + Focus. |
| [editor/book/book-editor.css](public/css/editor/book/book-editor.css) | Bucheditor (`.book-editor-*`): Outline + Manuskript-Stream. |
| [editor/focus/focus-mode.css](public/css/editor/focus/focus-mode.css) | Fokus-Modus, Geometrie + Zustände: `.focus-editor`, `.focus-editor__content`, Höhenkette/Schreiblinie, Spotlight, Auto-Hide-Cursor, Live-Counter. |
| [editor/focus/focus-content.css](public/css/editor/focus/focus-content.css) | Fokus-Modus, Inhalts-Blöcke der Schreibfläche: geplättete Formatierungen, Block-Margins, Checkbox-Zeilen, Bild-Marker. **Lädt nach focus-mode.css** (gleicher `@layer`, Quell-Reihenfolge entscheidet). |
| [editor/notebook/edit-toolbar.css](public/css/editor/notebook/edit-toolbar.css) | `.edit-bubble-toolbar`, `.edit-slash-menu`. |
| [editor/notebook/diagram-dialog.css](public/css/editor/notebook/diagram-dialog.css) | Diagramm-Dialog des Notebook-Editors (`.diagram-dialog*`, `.diagram-source-input`, `.diagram-preview-host`): natives `<dialog>`, Quelltext links / Live-Vorschau rechts. Enthält zusätzlich die Klick-Affordanz auf `pre.mermaid` im Edit-Modus. Die Block-Typografie des Diagramms selbst steht in [components/manuscript-content.css](public/css/components/manuscript-content.css). |
| [editor/notebook/table-dialog.css](public/css/editor/notebook/table-dialog.css) | Tabellen-Dialog des Notebook-Editors (`.table-dialog*`, `.table-dialog-grid`, `.table-grid-input`, `.table-align-btn`): natives `<dialog>`, Gitter aus Zellenfeldern mit stickigen Zeilen-/Spaltenköpfen. Enthält zusätzlich die Klick-Affordanz auf `table` im Edit-Modus. Die Tabellen-Typografie im Manuskript selbst steht in [components/manuscript-content.css](public/css/components/manuscript-content.css) — sie gilt für alle drei Leseflächen. |
| [editor/notebook/find-replace.css](public/css/editor/notebook/find-replace.css) | Notebook-Find/Replace (`.edit-find*`). |
| [editor/notebook/findings.css](public/css/editor/notebook/findings.css) | `.finding` / `.stilbox`. Dazu der **Belegvorschlag** unter einem `unbelegt`-Befund (`.finding-evidence*`): aufklappbare Trefferliste aus der Quellen-Bibliothek, Score + Quellenzeile + scrollbarer Beleg-Ausschnitt. Alles `span` statt `div` — der Befund ist ein `<label>`. |
| [editor/notebook/lektorat.css](public/css/editor/notebook/lektorat.css) | `.lektorat-mark`, Findings-Flash, Hover-Sync. |
| [editor/notebook/comments-rail.css](public/css/editor/notebook/comments-rail.css) | Kommentar-Leiste der Leseansicht — **nur Layout + Notebook-Chrome**: `.editor-body-wrap.comments-split` (Grid-Split wie Lektorat), `.comment-rail` Container, `.comment-rail__head`/`__section`, die Icon-Aktions-Buttons (`__thread-actions`/`__del`) und `::highlight(comment-rail-anchor)` / `…-active`. Die Karten-Optik selbst kommt aus [components/comment-rail.css](public/css/components/comment-rail.css). |
| [editor/notebook/entities.css](public/css/editor/notebook/entities.css) | Entity-Linking: `::highlight(entity-figure)` / `::highlight(entity-location)` Inline-Highlights + `.entity-popover` (Klick auf ein Highlight). Die Kontext-Listen leben im Referenz-Slot. |
| [editor/notebook/page-head.css](public/css/editor/notebook/page-head.css) | Titel-Kopf des Beitrags im Notebook-Editor (`.page-head*`), nur publizistische Bücher. **Die Eingabe sieht aus wie das Ergebnis:** beide Modi teilen die Typografie über `--ph-*`, die Felder sind randlos und ohne Padding, die Platzhalter tragen die Feldnamen (keine Labels) — beim Moduswechsel bewegt sich nichts. Bedienung erscheint erst auf Anforderung: Zeichenzahl und Lineal (`progress-bar-wrap`/`progress-bar`) bei Fokus bzw. dauerhaft sobald ein Kanal reisst, der Werkstatt-Sprung beim Überfahren. **Zwei Fallen:** `input[type="text"]` aus `components/card-form/form-elements.css` (0,1,1) schlägt eine blosse Klasse — der Reset braucht den Vorfahr-Selektor; und `editor/spellcheck.css` nimmt `.page-head__input` von der Badge-Padding-Reservierung aus (wie `.card-title--input`), sonst verschiebt sich der Satz gegen die Leseansicht. Der Kopf im **Ausgabeweg** steht dagegen in `components/manuscript-stream.css` — er gehört zum server-gerenderten HTML, nicht zum Editor-Chrome. |
| [editor/reference-slot.css](public/css/editor/reference-slot.css) | Referenz-Slot neben dem Notebook-Editor (Companion, Mutex mit Chat/Ideen): Tab-Zähler, Listenzeilen (`.reference-row*`), Scope-Hinweis. |
| [editor/synonym-menu.css](public/css/editor/synonym-menu.css) | Synonym-Kontextmenü + Picker. |
| [editor/figur-lookup.css](public/css/editor/figur-lookup.css) | `.figur-lookup` Popover. |
| [editor/spellcheck.css](public/css/editor/spellcheck.css) | LanguageTool-Squiggles + Popover, geteilt über Notebook-, Focus- und Bucheditor: `::highlight()`-Pseudos (Custom Highlight API), Tippfehler-Popover, `.lt-field-wrap`-Badge auf Form-Feldern. |

### entities/
| File | Inhalt |
|------|--------|
| [entities/figuren.css](public/css/entities/figuren.css) | Figuren-Karte, **Liste + Detail**: Listenzeile (`.figur-item`, stale-Zustand, `.figur-typ-dot`), die drei Detail-Gruppen (Steckbrief/Charakter/Im Buch), Beziehungszeile (`.figur-bz-*`), Schicht-/Präsenz-Plakette, Entwicklungsbogen, Schlüsselzitate. Hier steht auch die **Farbton-Zuordnung je Figurentyp** (`--fig-hue`), die sich Listenpunkt und Legendenpunkt teilen. |
| [entities/figuren-graph.css](public/css/entities/figuren-graph.css) | Figuren-Karte, **Netz-Ansicht**: Rahmen + Vollbild (`.figuren-graph-wrap`, native `:fullscreen` und `.is-fullscreen`-Rückfall), Werkzeugleiste, Kapitel-Filter, Knoten- und Kanten-Legende inkl. Sozialschicht-Bändern. Getrennt von `figuren.css`, weil beides zusammen über dem CSS-Limit liegt und die zwei Bereiche nur die Karte teilen. |
| [entities/figuren-alter.css](public/css/entities/figuren-alter.css) | Alterstabelle der Figuren (5. Reiter): Kopfzeile mit Analyse-Knopf, Tabelle mit aufklappbarer Beleg-Zeile, Konfidenz-/Widerspruch-Tags. Akzent via `var(--card-accent)` von `.card--figuren`. |
| [entities/figuren-lebenslauf.css](public/css/entities/figuren-lebenslauf.css) | Lebenslauf der Figuren (6. Reiter): Auswahl-Chip-Reihe, Phasen-x-Figuren-Matrix mit `table-layout: fixed`, Jahr-/Alter-Marke pro Ereignis. Akzent via `var(--card-accent)` von `.card--figuren`. |
| [entities/figur-werkstatt.css](public/css/entities/figur-werkstatt.css) | Figuren-Werkstatt (Mindmap, Drafts-Sidebar, Read-only-Tree). |
| [entities/szenen.css](public/css/entities/szenen.css) | Szenen-Karte. |
| [entities/world-facts.css](public/css/entities/world-facts.css) | Welt-Fakten-Karte (read-only): Kategorie-Gruppierung (`.weltfakten-*`), Fakt-Zeile mit Akzent-Leiste. |
| [entities/entity-grid.css](public/css/entities/entity-grid.css) | Entity-Grid (Matrix-Ansicht für Szenen + Schauplätze): sortierbare Tabelle, View-Toggle (`.entity-view-toggle`, `.entity-grid-*`). |
| [entities/ideen.css](public/css/entities/ideen.css) | Ideen-Karte. |
| [entities/entity-list.css](public/css/entities/entity-list.css) | `.entity-list` / `-row`, `.severity-tag*`, `.collapsible-*`, Skeleton, `.ort-*` Schauplätze. |
| [entities/orte-map.css](public/css/entities/orte-map.css) | Orte-Karte View-Mode `map` (Geo-Karte via Leaflet): `.ort-map*` Container + Geocode-Liste. Nur bei `book_settings.orte_real`. |
| [entities/recherche/board.css](public/css/entities/recherche/board.css) | Recherche-/Wissensboard (Board-Teil): Toolbar/Filter, Anlege-/Edit-Formular, einspaltige Schnipsel-Liste (`.recherche-list` + `.research-item`), Kind-Badges, Verknüpfungs-/Tag-Chips, KI-Vorschläge, Link-Picker, Link-Zeile (`.research-item-url-row`: Link + „als Quelle übernehmen"-`.icon-btn--ghost`, auf 22px kontext-verkleinert über `.research-url-tosource`, weil 28px die Zeilenhöhe einer `font-size-sm`-Liste bestimmen würde). Native-Vollbild (`.card--recherche:fullscreen`, Toggle via `fullscreen.js` wie Plot-Board) → Liste zentriert mit Lese-Maximalbreite. |
| [entities/recherche/dialog.css](public/css/entities/recherche/dialog.css) | Geteilte `<dialog>`-Shell der Recherche-Karte (`.research-dialog*`) für Detailansicht **und** Anlegen-Modal: Panelbreite, stehender `__head`, scrollender `__scroll`, `__bar`-Fussleiste, Mobile als vollflächiges Blatt. `__text` setzt den Volltext in Lesegrösse mit begrenztem Satzspiegel, `__figure`/`__image` zeigen das Bild gross (bis 60vh), `__doc`/`__figcaption` tragen die Anhang-Aktionen. Dazu `textarea.recherche-input--tall` fürs Redigieren langer Funde. |
| [entities/recherche/chat.css](public/css/entities/recherche/chat.css) | Recherche-Chat derselben Karte: Spalten-Layout `.recherche-split` (ab 1280px Board links / Chat rechts als sticky Spalte `clamp(420px, 32vw, 620px)` — breiter als der 420px-Seiten-Chat, weil Web-Such-Antworten und Fundstück-Vorschläge mehr Zeilenbreite brauchen; darunter Flex-Spalte mit `order: -1`, Chat über dem Board) plus das Panel selbst (`.research-chat*`: Kopf, Nachrichtenhöhe, Quellenliste, Speicher-Vorschläge). |
| [entities/sources.css](public/css/entities/sources.css) | Quellenverzeichnis-Karte: Toolbar/Filter-Bar (Compact-Höhen-Scope für `.filter-search-input`), Quellen-Tabelle (`.sources-table` via `sortableTable`), Zitier-Badge (`.sources-cite-badge`, Hue aus `--card-accent`), Detail-Formular, Fundstellen-Panel, Zitat-Kennzahlen-Reihe (`.sources-quote-stats` / `-stat` / `-stat-value` / `-stat-label` / `-stats-hint`: Zitat-Anteil + wörtlich/Paraphrase/belegte Quellen — schlichte Wert/Label-Reihe am Tabellenfuss, bewusst kein Tile-Grid). Enthält ausserdem `.sources-preview` (hängend eingerückte Formatter-Vorschau) — **geteilt** mit dem Quellen-Tab der Bucheinstellungen. |
| [entities/ereignisse-subtyp.css](public/css/entities/ereignisse-subtyp.css) | Event-Subtyp-Badges + Marker-Farbe im Zeitstrahl: Mapping `.gz-item--subtyp-<typ>` auf die gemeinsame `--gz-subtyp-color`-Prop (SSoT der Hues = `--card-accent-event-*` in `tokens/colors.css`), konsumiert von Marker (`.gz-marker`) und Badge. |
| [entities/ereignisse-span.css](public/css/entities/ereignisse-span.css) | Spannen-Events im Zeitstrahl: `.gz-item--span` verlängert den Marker vertikal proportional zur Jahr-Differenz (CSS-Custom-Prop `--span-years`); reine Punkt-Events unverändert. |

### analysis/
| File | Inhalt |
|------|--------|
| [analysis/analysis.css](public/css/analysis/analysis.css) | `.section-heading*`, JS-generated Output-Stile. |
| [analysis/heatmap.css](public/css/analysis/heatmap.css) | `.heatmap-*` Tabelle + Detail-Drawer. |
| [analysis/kontinuitaet.css](public/css/analysis/kontinuitaet.css) | Kontinuitätsprüfung + Buch-Einstellungen-Spezifika. |
| [analysis/erzaehlprofil.css](public/css/analysis/erzaehlprofil.css) | Kapitel-Erzählprofil: Spannungskurve (CSS-Balken), POV-/Themen-Chips, Abweichungs-Hervorhebung. |
| [analysis/komplett-status.css](public/css/analysis/komplett-status.css) | Komplettanalyse-Status-Header. |
| [analysis/zeitleiste.css](public/css/analysis/zeitleiste.css) | Globaler Zeitstrahl: Ereignis-Liste + selbstgebautes `.gz-band`-Jahres-Band. |
| [analysis/kapitel-review.css](public/css/analysis/kapitel-review.css) | Kapitel-Review. |
| [analysis/redundanz.css](public/css/analysis/redundanz.css) | Redundanz-Radar: Seiten-Paar-Liste mit Score-Badge + zwei Snippet-Spalten. |
| [analysis/buchlandkarte.css](public/css/analysis/buchlandkarte.css) | Buchlandkarte: `.buchlandkarte-canvas-wrap` (Chart.js-Scatter, **`aspect-ratio: 1`** — beide Achsen sind mit demselben Faktor skaliert, ein gestreckter Rahmen verzerrte die Abstände und damit die einzige Aussage der Karte), `.buchlandkarte-variance` (Aussagekraft der Projektion; nur die schwache Lage wird eingefärbt), `.buchlandkarte-table` + `.buchlandkarte-num` (Tabular-Nums, Prozente rechts) für die zwei Kennzahl-Tabellen. |
| [analysis/struktur.css](public/css/analysis/struktur.css) | Struktur-Werkstatt (Textsorte je Beitrag + Formbefund, nur Buchtyp `journalismus`): Tabelle `.struktur-table` (`sortableTable`) mit Textsorten-Combobox je Zeile, Urteil-Badges `.struktur-urteil--traegt/--lueckenhaft/--verfehlt` (Tag-Variante der Status-Achse ok/warn/err), und der Befund-Block `.struktur-detail` UNTER der Tabelle (linker Rand in `var(--card-accent)`) mit `.struktur-regel--erfuellt/--teilweise/--fehlt/--nicht_anwendbar` als farbige Randmarke je Formregel. |
| [analysis/wortschatz.css](public/css/analysis/wortschatz.css) | Wortschatz-Analyse (quantitative Stilistik pro Buch): Kennzahlen-Grid **wiederverwendet** `.overview-grid`/`.overview-tile` + Hero-/Substat-Atome aus `book-overview/` (siehe „Book-Overview-Tiles") — eigen sind nur `.wortschatz-kpi-note` (was die Zahl bedeutet), `.wortschatz-kpi-peer` (Vergleich gegen die übrigen Bücher, trägt `var(--card-accent)`), `.wortschatz-kpi-warn` (Kennzahl **nicht** belastbar: Text kürzer als das MATTR-Fenster bzw. unter der MTLD-/Heaps-Mindestlänge), die Ranglisten-Tabelle `.wortschatz-table` (`sortableTable`, `.wortschatz-num` tabular-nums, `.wortschatz-term`/`-phrase`) und die Keyness-Bänder `.wortschatz-keyness--high/--mid/--neg`. |

### admin/
| File | Inhalt |
|------|--------|
| [admin/admin-home.css](public/css/admin/admin-home.css) | Admin-Übersicht. |
| [admin/admin-backup.css](public/css/admin/admin-backup.css) | Admin-Backup: Meta-Kennzahlen, Download-Sektion, Restore-Danger-Zone. |
| [admin/admin-settings.css](public/css/admin/admin-settings.css) | Admin-Settings-Form. |
| [admin/admin-usage.css](public/css/admin/admin-usage.css) | Admin-Usage-Dashboard. |
| [admin/admin-users.css](public/css/admin/admin-users.css) | Admin-Users-Tabelle. |
| [admin/logs.css](public/css/admin/logs.css) | Admin-Logs: Filter-Toolbar, Log-Liste, Stack-Trace-Toggle. |
| [admin/parse-fails.css](public/css/admin/parse-fails.css) | Admin-KI-Parse-Fehler: Dump-Liste mit aufklappbarem Rohtext. |
| [admin/js-errors.css](public/css/admin/js-errors.css) | Admin-Client-JS-Fehler (`.card--admin-js-errors`): gemeldete Browser-Fehler mit aufklappbarem Detail (Stack, Quelle, User-Agent), Mobile via Container-Query. |

### book/
| File | Inhalt |
|------|--------|
| [book/book-create-modal.css](public/css/book/book-create-modal.css) | Buch-Anlage-Modal. |
| [book/book-settings.css](public/css/book/book-settings.css) | Buch-Einstellungen Job-Stats-Tabellen. |
| [book/header-actions.css](public/css/book/header-actions.css) | `.header-actions`-Cluster, Update-All-Panel. |
| [book/buchorganizer.css](public/css/book/buchorganizer.css) | Buch-Organisations-Karte. |
| [book/titelwerkstatt.css](public/css/book/titelwerkstatt.css) | Titel-Werkstatt (Dachzeile/Titel/Lead/Teaser als Metadata des Beitrags, publizistische Buchtypen): Übersichtszeile `.tw-row` als Grid-Button in einer `colspan`-Zelle (Sortierung über `sortableTable` bleibt, der Detail-Block bekommt die volle Breite), Feld-Block `.tw-field` mit Zeichenzähler, Kanal-Lineal `.tw-ruler-track` + `.tw-channel--fits/--over` (Print/Web/Suche/Social) und Varianten-Liste `.tw-variant` mit Herkunfts-Marke `--user`/`--ki`. Akzent via `var(--card-accent)` (`.card--titelwerkstatt`). |
| [book/plot/board.css](public/css/book/plot/board.css) | Plot-Werkstatt (Beat-Board / Kanban): Board-Layout, Spalten, Beat-Karten, Beat-Edit, Add-Beat/Akt, Vollbild + Mobile. |
| [book/plot/widgets.css](public/css/book/plot/widgets.css) | Plot-Werkstatt-Widgets: KI-Brainstorm, Consistency-Panel, Coverage, Status-Verteilungsbalken, Akt-Farbpalette, Beat-Intensität, Spannungsbogen. Ergänzt plot/board.css. |
| [book/plot/swimlane.css](public/css/book/plot/swimlane.css) | Plot-Werkstatt: Swimlane-Grid (Akte × Stränge) + Strang-Leiste. Ergänzt plot/board.css + plot/widgets.css. |
| [book/plot/relations.css](public/css/book/plot/relations.css) | Plot-Werkstatt: Beat-zu-Beat-Beziehungen (Kausalität + Setup/Payoff) — read-only Badges auf der Beat-Karte + Beziehungs-Editor (Typ-/Ziel-Combobox + Chips). Ergänzt plot/board.css. |
| [book/motiv.css](public/css/book/motiv.css) | Motiv-Werkstatt (Themen & Motive als Konstellation): Anlege-/Layer-Leiste, Zwei-Spalten-Layout (Graph + Seitenpanel), Motiv-Editor, Fundstellen-Liste, Soll-Verknüpfungs-Chips, Beziehungs-Editor. Akzent via `var(--card-accent)` (`.card--motiv`). Layer-Toggle-Buttons (`.motiv-layer-btn`) + entfernbare Chips (`.motiv-chip`) sind feature-skopiert. |
| [book/export.css](public/css/book/export.css) | Buch-Export (Standard-Format-Tiles + .swbook-Migration). |
| [book/export-shared.css](public/css/book/export-shared.css) | Geteilte Grammatik der drei Export-Karten (PDF/Word/EPUB): Scope-Picker, einzeilige Profil-Leiste + Anlege-Zeile, Tabs/Tab-Panels, Chips, Progress, Mobile. |
| [book/pdf-export.css](public/css/book/pdf-export.css) | PDF-Export-Spezifika (Inputs, Num-Grids, Schrift-Akkordeon, Farbpicker, Cover-Vorschau). Aufbau aus export-shared.css. |
| [book/docx-export.css](public/css/book/docx-export.css) | Word-Export-Spezifika (schmales Zahlenfeld). Aufbau aus export-shared.css. |

### book-overview/ (dichtes Tile-Grid)
[coverage.css](public/css/book-overview/coverage.css), [domain.css](public/css/book-overview/domain.css), [kapitel.css](public/css/book-overview/kapitel.css), [presence.css](public/css/book-overview/presence.css), [recent-actions.css](public/css/book-overview/recent-actions.css), [stats.css](public/css/book-overview/stats.css), [base.css](public/css/book-overview/base.css), [review.css](public/css/book-overview/review.css), [diary.css](public/css/book-overview/diary.css) (Tagebuch-Tiles: Lücken/Konsistenz-Kennzahlen + Wochentag-Rhythmus-Balken) — pro Tile-Familie ein File. Die Rückblick-Abdeckungs-Heatmap im Overview-Tile nutzt das geteilte `.ymheat-*`-Pattern ([components/year-month-heatmap.css](public/css/components/year-month-heatmap.css)), kein eigenes Tile-File mehr.

---

## Naming-Konventionen

Project mixt zwei Schemata. Beide sind erlaubt, aber pro Komponente konsistent.

**BEM-light** für Komponenten mit Modifiern: `.block`, `.block-element`, `.block--modifier`. Beispiele: `.card`, `.card-header`, `.card-form-row--top`, `.tabs-btn--active`.

**Flat** für kleine Utility-Klassen ohne Modifier-Bedarf: `.row`, `.muted-msg`, `.spinner`. Beispiele: `.list-header`, `.form-stack`.

**Anti-Patterns:**
- `.tabs-btn-count-active` ❌ — Modifier per `--active`-Suffix nicht durch Konkatenation. Richtig: `.tabs-btn--active .tabs-btn-count`.
- Camel-Case-Klassen (`.cardForm`) ❌ — kebab-case Pflicht.
- Doppel-Element (`.card-header-title-text`) ❌ — bei mehr als zwei Element-Stufen Refactor zu Sub-Komponente erwägen.

**Präfix-Konventionen pro Domain:**
- `card-`, `card-form-` — Karten-Form-Geometrie (geteilt)
- `tabs-`, `entity-`, `palette-`, `tree-`, `history-`, `heatmap-`, `finding-` — geteilte Komponenten
- `editor-`, `edit-`, `lektorat-`, `figur-`, `chat-` — Editor-Slices
- `overview-` — Book-Overview-Tiles
- `pdfx-` — PDF-Export-spezifisch (kurz, weil viele Sub-Klassen)
- `book-settings-` — Buch-Einstellungs-spezifische Klassen (Danger-Zone, Locale, Options) — generische Form-Klassen heissen `card-form-*`.

---

## Modal-Wrapper (generisches Pattern)

**Status:** Aktuell **kein generisches Modal-Wrapper-Pattern**. Mehrere Modal-artige Overlays existieren parallel:
- `.confirm-overlay` + `.confirm-dialog` ([confirm-dialog.css](public/css/components/confirm-dialog.css))
- `.shortcuts-overlay` + `.shortcuts-panel` ([confirm-dialog.css](public/css/components/confirm-dialog.css))
- `.palette-overlay` + `.palette-panel` ([feature-tiles.css](public/css/components/feature-tiles.css))

Jedes hat eigenen Backdrop, eigene Close-Logik, eigenen Focus-Trap. Drift-Risiko hoch.

**Wann konsolidieren:** Sobald ein fünfter Konsument auftaucht, oder ein Bug zeigt, dass eine Variante z.B. Esc nicht behandelt während andere es tun.

**Vorgesehenes Konsolidat:**
```html
<div class="modal-overlay" role="dialog" aria-modal="true">
  <div class="modal-panel modal-panel--md">…</div>
</div>
```
- `.modal-overlay` — Backdrop + Position-Fixed + `--z-modal`
- `.modal-panel` — zentriertes Panel mit `--shadow-lg`
- Modifier `--sm/-md/-lg` für Breite (480/720/960)

Bestehende Confirm/Shortcuts/Palette/Token-Setup würden darauf migrieren, behalten aber ihre eigenen Inhalts-Klassen (`.confirm-dialog-message`, `.palette-list`, etc.).

**Bis dahin:** Neue Modale orientieren sich an `.confirm-overlay` (am vollständigsten dokumentiert) und kopieren die Geometrie statt eigene zu erfinden.

---

## Loading-Overlay

**Status:** Kein generisches Pattern. Loading-Indikatoren existieren als:
- Inline-`.spinner` neben Button-Label (Standard für Buttons während async-Action)
- `.card-status` mit Text + `.progress-bar-wrap`
- Skeleton-Loader (`.entity-skeleton*` / `.chat-skeleton-*`)

**Wann anlegen:** Sobald jemand „kompletter Kartenüberlay während Refresh" braucht (aktuell behandelt jede Karte das via `x-show`-Toggling auf Inhalt + `.card-status` daneben).

**Soll-Pattern (wenn nötig):**
```html
<div class="card-loading-overlay" x-show="loading" aria-busy="true">
  <span class="spinner" aria-hidden="true"></span>
</div>
```
Position: absolute innerhalb `.card`, `background: var(--color-surface) / 0.7` mit Backdrop-Blur. `aria-busy="true"` auf Karte oder Overlay.

---

## Empty-State mit CTA

**Status:** Aktiv. Klassen leben in [card-form/form-elements.css](public/css/components/card-form/form-elements.css). Verwenden, wann immer eine Karte „Keine Daten — hier der Button um welche zu erzeugen" rendert. Ersetzt den nackten `.card-status`-Leertext. Konsumenten: Figuren-Werkstatt (Inline-Input-Variante) **und** alle Komplettanalyse-Katalogkarten (Figuren, Orte, Szenen, Ereignisse, Weltfakten, Kontinuität, Songs) mit „Buch analysieren"-CTA.

**Markup (Standard-CTA mit Icon — Komplettanalyse-Katalogkarten):**
```html
<div x-show="…leer & nicht-loading…" class="card-empty">
  <p class="card-empty-text" x-text="$app.t('common.noAnalysisYet')"></p>
  <button type="button" class="primary card-empty-cta"
          @click="$app.alleAktualisieren()"
          :disabled="$app.alleAktualisierenLoading || !$app.selectedBookId">
    <svg class="icon" aria-hidden="true"><use href="/icons.svg?v=691#rotate-cw"/></svg>
    <span x-text="$app.t('header.updateAll')"></span>
  </button>
</div>
```
- `.card-empty` — flex-column, zentriert, Padding `--space-2xl --space-lg` (Mobile: `--space-xl --space-md`)
- `.card-empty-text` — semantischer Hauptsatz, `--font-size-md`, `--fw-medium`, Text-Farbe
- `.card-empty-hint` — 12 px muted Erklärung, `max-width: 32em` (optional, nur wenn der Hauptsatz Kontext braucht)
- `.card-empty-cta` — `inline-flex` + Gap, damit Lucide-Icon + Label im `.primary`-Button bündig sitzen. Basis bleibt `.primary`.

**Regeln:**
- CTA muss zur **tatsächlichen** Datenquelle der Karte passen. Komplettanalyse-Outputs → `$app.alleAktualisieren()`. Lektorat-getriebene Karten (Fehler-/Stil-Heatmap) NICHT mit diesem CTA versehen — sie entstehen über den Prüf-Flow, nicht über die Komplettanalyse.
- CTA `:disabled`, solange die Analyse läuft oder kein Buch gewählt ist.

Wenn die Karte zusätzlich Inline-Inputs braucht (z.B. „Neue Figur — Name eingeben"), `.card-empty` als Container für Input + Button-Row mit `.row` weiternutzen — siehe [public/partials/figur-werkstatt.html](public/partials/figur-werkstatt.html).

---

## Inline-Action-Group

**Status:** Kein Standard. Patterns wie „Mehr anzeigen / Alle ausklappen / Filter zurücksetzen" als Link-Reihe nach Listen werden ad-hoc gebaut.

**Soll-Pattern (wenn jemand Bedarf hat):**
```html
<div class="inline-actions">
  <button type="button" class="link-btn" @click="…">Alle ausklappen</button>
  <span class="inline-actions-sep">·</span>
  <button type="button" class="link-btn" @click="…">Filter zurücksetzen</button>
</div>
```
- `.inline-actions` — flex row, `gap: var(--space-sm)`, `font-size: var(--font-size-sm)`
- `.link-btn` — Button-Reset auf Text-Link (color: var(--color-primary), Hover: underline)
- `.inline-actions-sep` — `·` als Separator (entspricht Mikro-Typografie-Regel: gleichwertige Items mit `·`, nicht `:`)

---

## Bild-Upload mit Vorschau + Entfernen

**Status:** Etabliert. Zwei Konsumenten: PDF-Export-Karte (Cover/Autorfoto/Rückseite) und BookSettings-Publikation-Tab (Cover/Autorfoto). Jeweils eigene Klassen mit gleichem Aufbau (kein geteiltes Basis-CSS — die Implementierungen sind bewusst entkoppelt, da unterschiedliche Token-Sets/Layout-Slots).

**Pattern:** Vorschau-Box (zeigt Bild oder Leer-Hinweis) + Aktionsreihe mit `fileDrop`-Button (Klick-Modus, im Button-Look) + `<button>` „Entfernen" (nur bei vorhandenem Bild). Der File-Picker läuft über das `fileDrop`-Primitive (siehe „Datei-Auswahl (`fileDrop`)") — kein eigenes `<input type="file">` + `@change`.
```html
<div class="pub-image-block">
  <div class="pub-image-preview">
    <template x-if="bookPublication.has_cover"><img :src="publicationCoverUrl()" alt=""></template>
    <template x-if="!bookPublication.has_cover"><span x-text="$app.t('publication.noImage')"></span></template>
  </div>
  <div class="pub-image-actions">
    <div class="pub-upload-btn"
         x-data="fileDrop({ accept: 'image/jpeg,image/png,image/webp', drag: false })"
         @file-drop="uploadPublicationCover($event.detail.file)">
      <span x-text="…uploading ? t('uploading') : (has_cover ? t('replace') : t('upload'))"></span>
    </div>
    <button type="button" x-show="bookPublication.has_cover" @click="removePublicationCover()" x-text="t('remove')"></button>
  </div>
</div>
```
- Upload-Handler nimmt die Datei direkt entgegen (`uploadPublicationCover(file)`), nicht das DOM-Event — `fileDrop` resettet sein Input selbst.
- Vorschau-URL trägt `?v=${previewVersion}`-Counter → Cache-Bust nach Upload/Remove (kein veraltetes Bild).
- Upload via `fetch(POST, body: file)` mit `Content-Type: file.type`; Server härtet durch `prepareCover` (sharp, Magic-Bytes, sRGB-JPEG).
- CSS: PDF-Export `.pdfx-cover-preview`/`.pdfx-file-btn` ([public/css/book/pdf-export.css](public/css/book/pdf-export.css)), BookSettings `.pub-image-preview`/`.pub-upload-btn` ([public/css/book/book-settings.css](public/css/book/book-settings.css)).

---

## Plot-Beat-Board (Kanban)

**Use:** Planendes Spalten-Board — Akte als Spalten (`.plot-column`), Handlungspunkte als ziehbare Karten (`.plot-beat`). Einzige Kanban-Komponente der App; nur für die Plot-Werkstatt. Kein generisches Board-Framework — wer ein zweites Board braucht, abstrahiert vorher.

**Struktur:**
```html
<div class="plot-board">                         <!-- flex, horizontal scroll; Mobile: column-stack -->
  <div class="plot-column" :style="{ '--col-accent': actAccent(act) }">
    <div class="plot-column-header">…Swatch + Titel + .plot-column-count + .plot-column-actions (.plot-icon-btn)…</div>
    <div class="plot-dist-bar plot-dist-bar--mini">…Status-Verteilung dieses Akts…</div>
    <div class="plot-column-body">
      <!-- SortableJS-Container: NUR x-for-Anker + Beat-Karten (data-plot-cell). -->
      <div class="plot-beats" data-plot-cell :data-act-id="act.id">
        <div class="plot-beat plot-beat--im_buch" :data-beat-id="beat.id">
          <div class="plot-beat-head">
            <span class="plot-beat-grip">…grip-vertical-Icon…</span>  <!-- einzige Drag-Greiffläche (handle), nur Ansichtsmodus -->
            <span class="plot-beat-title">…</span>                    <!-- Klick = Edit-Modus -->
            <span class="plot-beat-intensity">…Pips 1–5…</span>
          </div>
          <!-- Status erscheint NICHT als Badge — nur die linke Border-Farbe signalisiert ihn. -->
        </div>
      </div>
      <button class="plot-add-beat-btn">+ Beat</button>      <!-- ausserhalb .plot-beats -->
      <button class="plot-brainstorm-btn">KI: Beats vorschlagen</button>
    </div>
  </div>
  <div class="plot-column plot-column--add">…neuer Akt…</div>
</div>
<!-- Ab ≥1 Handlungsstrang schaltet die Render-Weiche aufs Akte×Stränge-Grid (.plot-swimlane). -->
```

- **CSS:** [public/css/book/plot/board.css](public/css/book/plot/board.css) (Kern-Board) + [plot/widgets.css](public/css/book/plot/widgets.css) (Brainstorm/Consistency/Coverage/Verteilungsbalken/Farbpalette/Intensität/Spannungsbogen) + [plot/swimlane.css](public/css/book/plot/swimlane.css) (Grid) + [plot/relations.css](public/css/book/plot/relations.css) (Beat-zu-Beat-Beziehungen); Lade-/Cascade-Order board → widgets → swimlane → relations. Akzent via `var(--card-accent)` (Mapping `.card--plot` in [card-accents.css](public/css/card-accents.css) → `--card-accent-plot`).
- **DnD:** SortableJS (geteilt mit dem Buchorganizer, lazy via `loadSortable()`). Pro Beat-Zelle (Akt × Strang) ein Container `.plot-beats[data-plot-cell]` mit nur dem x-for-Anker + den Beat-Karten (Add-/Toggle-/Brainstorm-Elemente liegen ausserhalb, damit Drop-Index + Revert sauber rechnen); alle Container teilen die `plot-beats`-Gruppe → Beats wandern per Drag zwischen Zellen. Ein **Ghost-Slot** (`.plot-beat-ghost`, gestrichelter Akzentrahmen) zeigt vor dem Loslassen die Landeposition. `onEnd` nimmt SortableJS' physischen DOM-Move zurück (`_revertSortable`, gegen Alpine-x-for-Doppelbesitz) und mutiert dann das Modell über die geprüfte `_dropBeat`-Mechanik → `PUT /plot/beats/order`. Drag startet **ausschliesslich am Griff** (`handle: '.plot-beat-grip'`, das `grip-vertical`-Icon oben links, nur im Ansichtsmodus gerendert) — so bleibt die restliche Karte voll klickbar (Titel→Edit, Tags→Figur springen) ohne Drag/Klick-Konflikt; eine Karte im Edit-Modus hat keinen Griff und ist nie ziehbar (ein `filter` erübrigt sich). Akte werden per Pfeil-Buttons verschoben (a11y), nicht per Drag. Code: [public/js/book/plot/dnd.js](public/js/book/plot/dnd.js).
- **Status:** binäre Realisierungsachse `geplant` (neutral) · `im_buch` (ok, gedämpft via `opacity`) als **linke Border-Farbe** auf `.plot-beat` — **kein** Status-Badge in der Ansicht; gesetzt über die Status-Tabs (`.plot-status-tabs`) im Edit-Modus, gefiltert über die Status-Combobox der Filter-Leiste. `verworfen` ist eine **orthogonale Flag-Achse** (kein Status-Wert): durchgestrichen + gedimmt, pro Spalte einklappbar (`.plot-verworfen-toggle`). Eigene Klassen, NICHT `severity-tag--*`. Konflikt-Severity im Consistency-Panel nutzt dagegen die bestehenden `severity-tag--*`.
- **Icon-Buttons:** generische [`.icon-btn icon-btn--ghost`](#icon-button-icon-btn)-Basis; `.plot-icon-btn` (+ `--danger`) ist nur der board-lokale Scoping-Marker für die Deltas (24px, randlos, Hover-Tint, 15px-Icon). Kein eigener Icon-Button-Stil.
- **Akt-Farbe (`--col-accent`):** jede Spalte trägt eine optionale Farb-Identität (`plot_acts.farbe` = Palette-Key). Frontend bindet sie als Custom-Prop am Spalten-Div: `:style="{ '--col-accent': actAccent(act) }"`; `actAccent` liefert `var(--palette-<key>)` (theme-aware, geteilt mit der Figuren-Palette) oder fällt auf den Karten-Akzent zurück (Whitelist `ACT_PALETTE` gegen CSS-Injection). Spalten-Header-Border, Drag-Ghost-Slot (`.plot-beat-ghost`), Titel-Input, Beat-Intensität und Intensitäts-Editor lesen `var(--col-accent)`; `.plot-column` setzt den Default (`var(--card-accent)`), damit die „Neuer Akt"-Spalte ohne Binding funktioniert. Swatch + Palette-Popover: `.plot-color-swatch` → `.plot-color-popover` (`.plot-color-opt` je Hue, `--none` für Zurücksetzen). **Re-assert-Pflicht:** das globale `button:hover { background }` (gleiche `@layer`) muss bei farbtragenden Buttons (`.plot-color-opt`, `.plot-intensity-step--on`) im `:hover` explizit re-asserted werden.
- **Status-Verteilungsbalken (`.plot-dist-bar`):** segmentierter Stacked-Bar über drei Segmente (`DIST_SEGMENTS = geplant · im_buch · verworfen`), je Segment ein `.plot-dist-seg.plot-dist-seg--<seg>` (Farben = `--color-muted` / `--color-ok-border` / Schraffur aus `--color-border` für `verworfen`). Breite über `flex-grow: var(--seg-grow)` (Count, **kein** Width-String), `flex-basis:0`, `min-width:3px`. Board-weit (`.plot-progress` + Legende) und als `--mini`-Variante (4px) im Spaltenkopf. Counts kommen aus `boardStats().by[s]` / `actStats(actId).by[s]`.
- **Spannungsbogen (`.plot-tension`):** klappbares Inline-SVG-Diagramm (kein Chart.js — analog book-overview-Sparkline). `.collapsible-toggle` + `.history-chevron` Header; `.plot-tension-chart` (position:relative) hält ein SVG `viewBox="0 0 100 100" preserveAspectRatio="none"` mit `<polyline vector-effect="non-scaling-stroke">` + HTML-`.plot-tension-dot`s (absolut via `left%`/`bottom%`, Farbe = Akt-`--col-accent`, Klick öffnet den Beat-Edit). Datenquelle `tensionCurve()` (Beats mit Intensität 1–5 in Board-Lesereihenfolge; verworfene zählen nicht). Nur sichtbar ab ≥2 Punkten.
- **Beat-Intensität:** Anzeige als 5-stufiges Signal-Meter (`.plot-beat-intensity-pip`, aufsteigende Höhe) in der Kopfzeile; Editor als 1–5-Stufenwahl (`.plot-intensity-step`, erneuter Klick auf aktiven Wert = zurücksetzen).
- **Verworfen-Collapse:** verworfene Beats werden pro Spalte über `.plot-verworfen-toggle` (`.collapsible-toggle`) ein-/ausgeblendet (`visibleBeatsForAct` vs. `filteredBeatsForAct`); Drag/Reorder bleiben auf der vollen Liste.
- **Scroll/Sticky:** Board `scroll-snap-type: x proximity` + Spalten `scroll-snap-align: start`; Spaltenköpfe `position: sticky; top: 0` (Desktop) für Trello-artiges Mitlaufen beim Seiten-Scroll (Mobile: `static`).
- **Swimlane-Grid (Akte × Stränge), [book/plot/swimlane.css](public/css/book/plot/swimlane.css):** optionale zweite Ordnungsachse (Handlungsstränge / POV). **Render-Weiche:** ohne Strang das flache Board (`.plot-board`, unverändert), ab ≥1 Strang das Grid (`.plot-swimlane`). Beide Boards liegen als Geschwister im Card-Root (je `x-show`), `plot.html` ist nur der Rahmen + verschachtelte Partials (`plot-board-flat`, `plot-board-grid`, `plot-thread-bar` via `_loadPartials`-Cascade). Layout: Flex-Zeilen (`.plot-swim-row`), erste Spalte (`.plot-swim-lane` / `.plot-swim-corner`) `position: sticky; left: 0` → Strang-Label bleibt beim horizontalen Akt-Scroll stehen; Zellen (`.plot-swim-cell`) `flex: 0 0 var(--cell-w)`. Zeilenbreite via `min-width: max-content` erzwingt H-Scroll. Letzte Zeile ist die „ohne Strang"-Lane (`thread_id` NULL, `.plot-swim-row--default`). Beat-Karte + Add-/Farb-/Brainstorm-/Intensitäts-Styles werden 1:1 aus `plot/board.css` + `plot/widgets.css` wiederverwendet (Markup in beiden Boards synchron halten). Strang-Akzent `--col-accent` via `threadAccent()` (gleiche Palette-Whitelist wie `actAccent`). DnD: pro Zelle ein `.plot-beats[data-plot-cell]`-SortableJS-Container (`data-act-id` + `data-thread-id`), Drop setzt `act_id` **+** `thread_id` → `PUT /plot/beats/order` mit `{actId, threadId, beatIds}`-Gruppen. **Opt-in-Einstieg:** `.plot-thread-bar` (sichtbar sobald Akte existieren) mit „+ Strang". Strang-Brainstorm zell-granular (nur echte Stränge, `#zap`-Icon). Spannungsbogen: pro Strang eine farbige Polyline (sonst eine globale Kurve).

---

## Keyboard-Shortcut-Anzeige (`<kbd>`)

**Use:** Tasten anzeigen (Hotkeys, Help-Overlay, Palette-Hero).

**Markup:** Native `<kbd>` mit globalem Reset in [base.css](public/css/layout/base.css):
```html
Shortcut: <kbd>⌘</kbd>+<kbd>K</kbd>
```

**Klasse-Stil** existiert pro Konsument: `.palette-hero-kbd`, `.palette-mode-pill kbd`. Globaler Reset ist gesetzt — neue Konsumenten erben automatisch und überschreiben nur, wenn nötig.

**Im Tooltip eines Action-Icons** gibt es kein `<kbd>` (der Tooltip-Layer rendert `textContent`) — dort läuft die Anzeige über `withHotkey()`, siehe [Tastenkürzel im Tooltip](#tastenkürzel-im-tooltip).

---

## Pattern-Matrix (Karte → Pattern)

Welche Karte verwendet welche Patterns. Drift-Erkennung: wer auf der gleichen Zeile fehlt obwohl er sollte, verwendet wahrscheinlich Reinvention.

| Karte | `.card` | Form | Tabs | Combobox | Entity-List | Heatmap | Findings | Filter-Bar |
|-------|:------:|:----:|:----:|:--------:|:-----------:|:-------:|:--------:|:----------:|
| BookOverview | ✓ | — | — | — | — | — | — | — |
| BookReview | ✓ | — | — | — | — | — | — | — |
| KapitelReview | ✓ | — | — | — | — | — | — | — |
| Figuren | ✓ | — | ✓ | — | ✓ | — | — | ✓ |
| FigurWerkstatt | ✓ | ✓ | — | ✓ | — | — | — | — |
| Orte | ✓ | — | — | — | ✓ | — | — | ✓ |
| Szenen | ✓ | — | ✓ | ✓ | ✓ | — | — | ✓ |
| Ereignisse | ✓ | — | — | ✓ | ✓ | — | — | ✓ |
| Kontinuität | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — |
| BookStats | ✓ | — | — | — | — | — | — | — |
| Stil | ✓ | — | ✓ | — | — | ✓ | — | — |
| FehlerHeatmap | ✓ | — | ✓ | — | — | ✓ | — | — |
| BookSettings | ✓ | ✓ | — | ✓ | — | — | — | — |
| UserSettings | ✓ | ✓ | — | ✓ | — | — | — | — |
| FinetuneExport | ✓ | ✓ | — | ✓ | — | — | — | — |
| PdfExport | ✓ | ✓ | ✓ | ✓ | — | — | — | — |
| Ideen | ✓ | — | — | ✓ | ✓ | — | — | ✓ |
| Chat (Seite) | ✓ | — | — | — | — | — | — | — |
| BuchChat | ✓ | — | — | — | — | — | — | — |
| Editor (Findings) | ✓ | — | — | — | ✓ | — | ✓ | — |
| PageHistory | ✓ | — | — | — | — | — | — | — |
| Palette | (Modal) | — | — | — | ✓ | — | — | ✓ |

**Audit-Hinweis:** Wer eine neue Karte oder ein neues Pattern einführt, fügt hier Spalte/Zeile + Häkchen hinzu. Nicht nur Existenz prüfen — auch ob die Karte die geteilte Klasse benutzt oder eigenes Vokabular pflegt.

---

## Relative z-index (lokal-stack-Werte)

Werte 1, 2, 5, 10, 20, 50 in [heatmap.css](public/css/analysis/heatmap.css), [lektorat.css](public/css/editor/lektorat.css), [twocolumn.css](public/css/layout/twocolumn.css), [search.css](public/css/search.css), [book-overview/](public/css/book-overview/) sind **lokal-relativ** und gehören NICHT in den globalen Stack:
- Heatmap: sticky-thead (1) und sticky-rowhead (2) innerhalb der Tabelle
- Lektorat-Marks: Findings-Flash (50) über In-Place-Markierungen
- Twocolumn: Resize-Handle (5) über Sidebar-Content
- Book-Overview-Tiles: SVG-Layering innerhalb Tile

Diese Werte bleiben hartcoded mit Kommentar `/* lokal-relativ, kein globaler Stack-Tier */` in der Nähe. Wer sie migriert, durchbricht die lokale Stack-Logik.

Im globalen Stack (siehe [Z-Index-Stack](#z-index-stack)) steht alles, was per `position: fixed` oder gegen andere Komponenten konkurriert.

---

## Tooling: stylelint-Skizze

**Status:** Aktuell nicht eingerichtet. Skizze für späteren Setup:

```json
{
  "rules": {
    "declaration-property-value-disallowed-list": {
      "z-index": ["/^[0-9]+$/"],
      "/^font-weight$/": ["/^[0-9]+$/"],
      "/^transition-duration$/": ["/^[0-9.]+m?s$/"]
    },
    "declaration-property-value-allowed-list": {
      "/^z-index$/": ["/^var\\(--z-/", "/^[1-5]$/"]
    },
    "color-no-hex": true,
    "color-named": "never",
    "custom-property-pattern": "^[a-z][a-z0-9-]+$"
  }
}
```

Was es prüft:
- z-index muss `var(--z-*)` oder lokal-relative 1-5 sein
- font-weight muss Token sein, nicht Zahl
- transition-duration muss Token sein, nicht Literal
- Hex-Farben verboten, immer Token
- Custom-Property-Naming einheitlich kebab-case

Setup-Aufwand: ~1 Stunde (`npm i -D stylelint stylelint-config-standard` + `.stylelintrc.json` + npm-Script). Aktuelle Codebase würde initial ~50-100 Verstöße melden — die meisten Migrationskandidaten, einzelne Ausnahmen via `/* stylelint-disable-next-line */`.

Nicht in scope für DESIGN.md-Refactor — separater Task wenn gewünscht.

---

## Wartung

Wer ein neues Pattern einführt:
1. Gibt es schon eines, das passt? → wiederverwenden.
2. Wirklich neu? → hier dokumentieren (Markup-Snippet + CSS-Datei + Use-Case) und im **Inhalt**-Abschnitt oben verlinken.
3. Doku-Template (oben) eingehalten? Use → Markup → Klassen → Regeln → Beispiele.
4. SHELL_CACHE in [public/sw.js](public/sw.js) bumpen (CSS/JS-Änderung).
5. i18n-Strings in beide Locales eintragen (CLAUDE.md-Regel).
6. Mobile-Breakpoints **und** Darkmode-Verhalten im selben Commit (siehe [Mobile-Breakpoints + Darkmode](#mobile-breakpoints--darkmode)) — Farben/Borders/Shadows nur via Tokens, kein hartcoded `#hex`.
7. Spacing/Padding/Schatten/Transition aus Tokens (`--space-*`, `--pad-*`, `--shadow-*`, `--transition-*`) — keine ad-hoc Pixel-Werte ohne Begründung.
8. `prefers-reduced-motion`-Override gesetzt (sofern Animation/Transition mit Bewegung)?
9. A11y-Attribute (`aria-*`, `role`, Focus-Trap bei Modal, `aria-invalid` bei Inputs) gesetzt?
10. Z-Index über Token aus tokens.css gesetzt (kein hartcoded Wert)?
11. Container-Query vs. Media-Query bewusst gewählt (siehe Section)?
12. Eigene URL für die neue Hauptansicht im [Hash-Router](#routing--deep-links-url-pflicht) (View-Slug + Apply-Zweig + Selektion + Watcher + Test)?
