# Dramatik: Drehbuch, Theater, Hörspiel, Podcast

- **Status:** Draft <!-- Offene Fragen unten noch nicht leer -->
- **Aufwand:** XL
- **Severity:** medium <!-- neue Zielgruppe, strategisch; kein Bestandsrisiko -->

## Context

Die App deckt 18 Buchtypen ab — von `roman` bis `journalismus` —, aber **keine dramatische Form**. Ein Grep über `fountain|drehbuch|theater|hörspiel|screenplay|dramatik|sprechrolle|regieanweisung` trifft im ganzen Repo drei Stellen, alle drei False Positives (ein Kommentar „Compliance-Theater", ein Prompt-Beispiel, ein Icon-Name). Das Feld ist vollständig unbesetzt.

Die These, die das Feature trägt: **Figuren, Plot und Motive sind zu grossen Teilen schon da** — Drehbuch-, Theater-, Hörspiel- und Podcast-Autoren arbeiten mit denselben Bausteinen wie Romanautoren. Das stimmt, mit einer Ausnahme (siehe „Abhängigkeiten"). Damit ist Dramatik die **günstigste neue Zielgruppe**: es fehlen nicht die Werkzeuge, sondern drei Schichten obendrauf — eine **Dialogstruktur im Manuskript**, ein **Formsatz** für die Ausgabe und eine **Sprechrollen-Auswertung**.

Bezug zur Produkt-Linie: dasselbe Muster wie `journalismus` — ein Buchtyp wählt Profile und schaltet eine Vertikale frei. Nichts davon ist generativ im Manuskripttext; die KI plant und prüft, sie schreibt nicht.

## Scope MVP

**Phase 0 — Buchtyp + Profile** (allein schon nützlich, keine UI)
- Buchtyp `dramatik` in `prompt-config.json` (de + en) und `VALID_BUCHTYPEN`
- Fünftes Lektorat-Profil `dramatisch` (ohne `show_vs_tell`, `filterwort`, `perspektivbruch`, `dialogformat`; neu `regieanweisung`, `figurenstimme`, `expositionsdialog`, `sprechbarkeit`)
- Review-Profil `dramatisch` (Achsen `dialog`, `figurenstimmen`, `szenenoekonomie`, `produzierbarkeit` + geteilte `struktur`/`stil`/`dramaturgie`/`thema`)
- Karten-Sichtbarkeit: Figuren/Plot/Szenen/Motive/Orte bleiben, `erzaehlprofil` und Satz-Karten aus

**Phase 1 — Formkatalog**
- `dramenformen.js` mit `drehbuch` / `theater` / `hoerspiel` / `podcast`, Buch-Default + Seiten-Ausnahme

**Phase 2 — Paste-Reparatur, dann Dialog-Markup**
- **Zuerst:** `<p class>` überlebt Paste; Copy/Cut schreiben `text/html`
- Markup-SSoT `drama-html.js`, Eingabe im Notebook-Editor, Durchstich aller Blockschichten
- Zählpfad-Variante + Dramatik-Zweig für `dialog_chars`

**Phase 3 — Abgeleitete Indexe + Rollen-Karte**
- `drama_scenes` + `drama_speeches` als Full-Replace am Content-Store-Chokepoint, kein `callAI`
- Karte **Rollen**: Sprechanteil je Figur, Auftritte je Szene, Szenen ohne Dialog, Sprecherverzeichnis

## Out-of-Scope

- **Formsatz und Fountain** (Phase 4): Drehbuch-PDF im Industriestandard, Fountain-Import/-Export, Theater-/Hörspiel-Presets. Eigenes Vorhaben.
- **Hörspiel-TTS mit Stimme pro Figur** (Phase 5) — technisch billig, weil TTS und `data-fig` existieren, aber ohne Phase 2 gegenstandslos.
- **Kuratierte Nutzdaten am Markup** — dauerhaft ausgeschlossen, solange `ensureBlockIds` beim Paste neue IDs vergibt. Markup-getragene Schlüssel sind unter dem heutigen Paste-Regime nicht stabil.
- **Szenen als CRUD-Objekt** — bewusst nicht. Der Slug im Text ist die Wahrheit (siehe DB).
- **Generieren von Dialog** — Konflikt mit dem Produkt-Prinzip „nie generativ in den Manuskripttext". Die KI prüft Repliken, sie schreibt keine.

## Done when

- Ein Buch vom Typ `dramatik` lässt sich anlegen und speichern (kein `400 INVALID_BUCHTYP`).
- Lektorat auf einer Drehbuchseite meldet **kein** `show_vs_tell` und **kein** `dialogformat`.
- Die Bewertung nennt im Notenanker jede Achse des dramatischen Profils; keine Rede von „Hauptfiguren-Bogen" oder „marktfähig".
- Eine Szene lässt sich per Cut+Paste verschieben, **ohne** dass Klassen verlorengehen und ohne dass sie aus `drama_scenes` verschwindet.
- Wortzahl einer Seite ändert sich **nicht**, wenn eine Sprecherzeile hinzukommt.
- Dieselbe Seite zeigt in der Stil-Heatmap einen hohen Dialoganteil, nicht 0 %.
- Sprechername und Slug sind im KI-Prompt **und** in der Volltextsuche weiterhin vorhanden.
- Alle sieben Ausgabewege (PDF, DOCX, EPUB, HTML, MD, TXT, Share-Reader) rendern Dialog erkennbar, keiner kippt in den `paragraph`-Fallback.
- Die Rollen-Karte zeigt für ein Testbuch plausible Sprechanteile.

## Hard-Rule-Audit

| Regel | Betroffen | Wie eingehalten |
|---|---|---|
| **Editor-Spezifikation** | **ja** | Eingabe ausschliesslich **Notebook-Editor** (Muster Diagramm-Dialog). Die Paste-Reparatur liegt in `editor/shared/` und trifft **alle drei** — im Diff einzeln auflisten. **Focus-Editor ist stabilisiert**: nur anfassen, wenn ein konkretes Verhalten sich ändert; `FOCUS_BLOCK_SEL` bewusst und einzeln entscheiden, nicht „mitziehen". |
| **Editor-Blockstruktur / Markup-SSoT** | **ja** | Neues Modul `public/js/drama/drama-html.js` nach dem Muster `mermaid-html.js`. Keine `'replik'`/`'sprecher'`/`'data-fig'`-Literale ausserhalb. `contenteditable` nie persistiert. |
| **Styles nur in `public/css/`** | ja | Neue Datei unter `css/components/` bzw. `css/editor/`; kein Inline-`style`. |
| **UI-Strings nur in i18n** | ja | Alle neuen Labels/Fehler/Job-Phasen in **beiden** Locales, siehe „i18n". |
| **Content-Store-Facade** | ja | Kein direkter SQL-Zugriff auf `pages`. Die Index-Schreiber hängen am Facade-Chokepoint; Namens-JOINs in eigenem `db/`-Modul. |
| **DB-Integrität** | ja | FK auf `pages(page_id)` CASCADE; Index auf jede FK-Spalte; keine Snapshot-Spalten; ISO+Z via `NOW_ISO_SQL`; `foreign_key_check` am Migrationsende. |
| **Job-Queue** | teilweise | Phase 0–3 brauchen **keinen** neuen KI-Job (Indexe sind reine Ableitung). Erst Fountain-Import (Phase 4) wird ein Job. |
| **`x-html`-Escape** | ja | Rollen-Karte rendert Figurennamen — `escHtml()` vor jeder Interpolation, oder `x-text`. |
| **Combobox / numInput / LanguageTool** | ja | Formwahl als `combobox`, keine nativen `<select>`. Prosafelder der Karte mit `data-spellcheck="spelling"`. |
| **`sortableTable`** | ja | Die Rollen-Tabelle (>3 Zeilen) nutzt `Alpine.data('sortableTable')`. |
| **SHELL_CACHE** | ja | Alle neuen JS/CSS/Partials landen über den PostToolUse-Hook in `sw-manifest.js`; Ergebnis mitcommitten. |
| **DESIGN.md** | ja | Neue Karte nutzt bestehende Patterns; Akzentfarbe als `--card-accent-<key>-base` + Mapping. |
| **Prompts nur unter `public/js/prompts/`** | ja | `dramenformen.js` liegt dort, Re-Export über die Facade. |
| **Doku-Pflicht** | ja | `docs/dramatik.md` + Eintrag in CLAUDE.md; `docs/erd.md` im selben Commit wie die Migration. |

## Abhängigkeiten

**Trägt bereits (Wiederverwendung, kein Neubau):**

| Baustein | Zustand |
|---|---|
| `plot_acts` / `plot_beats` / `plot_threads` | vollständig: CRUD, Board-UI, zwei KI-Jobs, Undo/Redo. Akt/Beat/Strang **ist** praktisch schon Dramaturgie. |
| `figures` inkl. `stimme`, `arc`, `schluesselzitate` | vollständig, manueller `PUT`-Pfad. `figures.stimme` ist wörtlich „Sprechweise/Register/typische Wendungen der Figur". |
| `motifs` + fünf Soll-Brücken + Ist-Index | vollständig, kuratierbar |
| `div.poem` als Sonderblock | 14 Schichten, sauber dokumentiert — die exakte Blaupause |
| Export-Pipeline | ein Walker → fünf Builder behandeln `poem` (EPUB nicht) |
| `STRUKTUR_*`-Vokabular + Struktur-Job | vollständig, nur schlecht einsortiert — **importieren, nicht kopieren** |
| Abgeleitete Full-Replace-Indexe | dreimal exerziert (`source_citations`, `xref_anchors`, `motif_occurrences`) |

**Trägt nicht — die zwei harten Funde:**

1. **`figure_scenes` ist ein Analyse-Artefakt, kein Autorenobjekt.** [routes/figures.js](../../routes/figures.js) kennt nur `GET /figures/scenes/:book_id`, `POST …/merge` und `DELETE …/:id` (**nur bei `stale = 1`**). Kein `POST`, kein `PUT`, keine Zeit, kein INT/EXT. Ausgerechnet die primäre Autoreneinheit des Drehbuchs lässt sich nicht anlegen. → Gelöst durch Umdrehen der Wahrheitsrichtung, nicht durch Nachrüsten von CRUD.

2. **Der Paste-Pfad zerstört klassengetragenes Markup — blockierend.** [public/js/utils/html.js](../../public/js/utils/html.js) `PASTE_ALLOWED_ATTRS` (Z. 114–133) hat **keinen `P`-Eintrag**; der Filter (Z. 174–176) strippt jedes Attribut an jedem `<p>`. `div.poem` überlebt nur dank eines expliziten DIV-Zweigs, der zudem **jedes** `<div>` auf `class="poem"` zwingt (Z. 164/178). Und [public/js/editor/shared/paste.js](../../public/js/editor/shared/paste.js) (Z. 81–102) schreibt bei Copy **und** Cut ausschliesslich `text/plain`. Eine Szene per Cut+Paste zu verschieben — die naheliegendste Drehbuch-Operation überhaupt — macht aus ihr einen Stapel klassenloser `<p>`. Bei `div.poem` ist der Schaden kosmetisch und lokal; bei Dramatik ist *jede Zeile* klassengetragen: die Szene verschwindet ersatzlos aus dem Index, **ohne Stale-Flag, ohne Warnung**. An dieser Stelle ist `figure_scenes` mit seinem `stale=1` robuster als der Neuentwurf. → **Muss vor Phase 3 repariert sein.**

**Nebenbefund:** `plot_beats` hat in der Dev-DB **0 Zeilen**. Das Board ist gebaut, aber ungenutzt — Dramatik wäre der erste Anwendungsfall, der es zwingend braucht.

## Backend

**Phase 0–1** — keine neuen Routen ausser der Formwahl:

| Methode + Pfad | Vertrag |
|---|---|
| `GET /dramenform/:book_id` | Formen des Buchs + effektive Form je Seite. ACL `viewer`. |
| `PUT /dramenform/page/:page_id` | `{ form }` — Seiten-Ausnahme setzen/löschen. `pageBookGuard`, `editor`. Validierung gegen `DRAMENFORM_KEYS`, sonst `400 INVALID_DRAMENFORM`. |

Buch-Default läuft über das bestehende `PUT /booksettings/:id` (neues Feld `dramenform`).

**Phase 3** — Lesepfad des Indexes:

| Methode + Pfad | Vertrag |
|---|---|
| `GET /drama/scenes/:book_id` | Szenenliste in Buchreihenfolge (Nummern **berechnet**, nicht gespeichert). ACL `viewer`. |
| `GET /drama/roles/:book_id` | Sprechanteile je Figur, Auftritte je Szene. ACL `viewer`. |

**Libs:**
- `lib/drama-index.js` — `reindexPageDramaSafe(pageId, html)`, `reindexAllDrama()`, `ensureBookDramaIndexed(bookId)`. Muster [lib/xref-index.js](../../lib/xref-index.js).
- `lib/drama-scenes.js` — pure Verdichtung der seiten-lokalen Segmente zu Buch-Szenen (`flattenTree`-Reihenfolge), Nummernvergabe zur Lesezeit.
- Generalisierung von `routes/jobs/struktur.js` auf `(katalog, key)` statt hartkodiertem `effectiveTextsorte`.

**Einhängepunkt des Indexes** — dreifach, exakt analog zu cite/xref: [lib/content-store/index.js](../../lib/content-store/index.js) Z. 187–190 (`savePage`, nur bei Body-Change), Z. 200–201 (`createPage` — Import, Blog-Pull, Snapshot-Restore und Buch-Migration laufen hier durch, nicht über `savePage`), Z. 242–248 (`movePage`). Lazy-Getter neben `_citeIndex()`/`_xrefIndex()`. Reihenfolge egal: der anchors-vor-links-Zwang der Xrefs hat hier kein Pendant.

**Kosten pro Write:** Der `indexOf`-Vortest (Muster [lib/cite-index.js](../../lib/cite-index.js) Z. 22–29) hält Prosabücher bei null. Bei Dramatik greift er auf **jeder** Seite bei **jedem** Save — anders als cite/xref, die statistisch fast nie greifen. Das ist dann der dritte linkedom-Parse pro Save. Bei kurzen Drehbuchseiten vertretbar, aber real und nicht schönzureden.

## Frontend

**Neue Karte `rollen`** (Phase 3):
- Fachmodul `public/js/book/rollen.js` → `export const rollenMethods = {…}`, Root-Zugriff via `window.__app`
- `public/js/cards/rollen-card.js` → `Alpine.data('rollenCard')` + `setupCardLifecycle`, registriert in `register-cards.js`
- `public/partials/rollen.html` mit `x-data="rollenCard"`, `<div id="partial-rollen">` in `index.html`
- `showRollenCard` in `app-state.js` → `cardsState`
- **`EXCLUSIVE_CARDS`** + **`FEATURES`** je mit `requiresBuchtyp: 'dramatik'`, dazu `ALLOWED_KEYS` in [routes/usage.js](../../routes/usage.js)
- Hash-Router: Build-Branch in `_computeHash()`, Parse-Branch in `_applyHash()`, Flag in `watchers`

**Bestehende Karten gaten:** `erzaehlprofil` und die Satz-Karten bekommen `hiddenForBuchtyp: ['dramatik']` — **in beiden Registries** ([feature-registry.js](../../public/js/cards/feature-registry.js) Z. 74–138 *und* Z. 249–294). Figuren, Plot, Szenen, Motive, Orte bleiben sichtbar; das ist der Unterschied zu `journalismus`, das ~20 Karten ausblendet.

**Editor** (Phase 2): Slash-Items für Slug / Regie / Replik, Tab-Zyklus Sprecher → Text → Regie (Konvention aller Drehbuch-Editoren). Formwahl als `combobox` in den Bucheinstellungen.

## CSS

- `public/css/components/manuscript-content.css` — `.slug`, `.regie`, `.replik`, `.sprecher`, `.klammer` (analog zum bestehenden `.poem`-Block, Z. 254–266)
- `public/css/editor/focus/focus-content.css` — Wrapper-Behandlung wie bei `.poem` (Z. 110–113)
- `public/css/analysis/rollen.css` — neue Karte, `<link>` in `index.html`
- Akzentfarbe: `--card-accent-rollen-base` in `tokens/colors.css` (Dark-Wert per OKLCH abgeleitet) + Mapping in `card-accents.css`

## i18n

Neue Bereiche, je in **`de.json` und `en.json`** (Anker: Journalismus brauchte ~227 Keys je Locale):

| Präfix | Inhalt |
|---|---|
| `dramenform.<key>` | vier Formen |
| `drama.*` | Editor-Labels (Slug, Regie, Replik, Sprecher, Klammer), Fehlercodes |
| `rollen.*` | Karte: Spalten, Kennzahlen, Leerzustände |
| `finding.<typ>` + `fehlerHeatmap.typ.<typ>` | `regieanweisung`, `figurenstimme`, `expositionsdialog`, `sprechbarkeit` |
| `fehlerHeatmap.cluster.dramatik` | neue Cluster-Spalte |
| `review.section.*`, `kapitelReview.section.*`, `review.cat.*` | `dialog`, `figurenstimmen`, `szenenoekonomie`, `produzierbarkeit` |
| `tile.rollen` + `tile.rollen.desc` | Karte in Palette/Pills |
| `landing.feat<N>Title` / `Desc` | plus `<N>` in `HELP_FEATURES` |

## DB

Migration **272** — Achtung: Version 271 (KI-Profile) lag beim Verfassen **uncommitted** im Tree, und es liefen parallele Sessions im Repo. Vor dem Anlegen `schema_version` prüfen.

```sql
-- Formwahl (Buch-Default steht als Spalte an book_settings)
CREATE TABLE IF NOT EXISTS page_dramenform (
  page_id    INTEGER PRIMARY KEY REFERENCES pages(page_id) ON DELETE CASCADE,
  book_id    INTEGER NOT NULL    REFERENCES books(book_id) ON DELETE CASCADE,
  form       TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_page_dramenform_book ON page_dramenform(book_id);
ALTER TABLE book_settings ADD COLUMN dramenform TEXT;         -- mit table_info-Guard
ALTER TABLE page_structure_checks ADD COLUMN katalog TEXT;     -- sonst kollidieren die Key-Räume

-- Abgeleitete Indexe: Full-Replace pro Seiten-Write, KEIN book_id
CREATE TABLE IF NOT EXISTS drama_scenes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id       INTEGER NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
  ord           INTEGER NOT NULL,        -- Reihenfolge INNERHALB der Seite
  fortsetzung   INTEGER NOT NULL DEFAULT 0 CHECK(fortsetzung IN (0,1)),
  ort           TEXT,
  innen_aussen  TEXT CHECK(innen_aussen IN ('int','ext','int_ext') OR innen_aussen IS NULL),
  tageszeit     TEXT,
  slug_text     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drama_scenes_page ON drama_scenes(page_id, ord);

CREATE TABLE IF NOT EXISTS drama_speeches (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id    INTEGER NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
  scene_ord  INTEGER NOT NULL,
  figure_id  INTEGER REFERENCES figures(id) ON DELETE SET NULL,
  sprecher   TEXT NOT NULL,             -- Fallback, wenn keine Figur zugeordnet
  repliken   INTEGER NOT NULL DEFAULT 0,
  woerter    INTEGER NOT NULL DEFAULT 0,
  zeichen    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_drama_speeches_page ON drama_speeches(page_id);
CREATE INDEX IF NOT EXISTS idx_drama_speeches_fig  ON drama_speeches(figure_id);
```

**Vier Entwurfs-Invarianten, die nicht verhandelbar sind:**

1. **Szenennummern werden nicht persistiert.** Sie sind ein Render-Artefakt der gerenderten Einheit — Präzedenz [lib/xref-render.js](../../lib/xref-render.js), Invariante A. Und **nicht** `ORDER BY p.position` kopieren (wie es `db/xrefs.js` tut): Ordnungs-SSoT ist `book_order` ([lib/content-store/index.js](../../lib/content-store/index.js) Z. 256–260). Bei Abbildungsnummern fällt eine Abweichung kaum auf, bei „Szene 14" im Export sofort.
2. **Kein `book_id`** — Scope über `JOIN pages`. Dann braucht die movePage-Kappliste ([backends/localdb.js](../../lib/content-store/backends/localdb.js) Z. 470–486) keine einzige neue Zeile und der Buchwechsel stimmt automatisch.
3. **Seitenübergreifende Szenen:** Zeilen sind seiten-lokale Segmente mit `ord` plus Flag „beginnt ohne Slug" (= Fortsetzung). Zusammenbau auf Buchebene über `flattenTree`. **Umfang und Wortzahl einer Szene dürfen nicht in der Zeile stehen** — sie sind nicht seiten-lokal berechenbar.
4. **Cron-Reindex und Lazy-Backfill sind Pflicht, nicht Kür.** Es gibt keine Transaktion um Seiten-Write und Index (`reindexPage*Safe` schluckt jeden Fehler; das `UPDATE pages` ist längst committed). Bei Xrefs heilt der Backfill nur den Ziel-Picker; bei einer Szenenliste, die das Rückgrat der Ansicht ist, wäre Drift sofort sichtbar.

`figure_scenes` bleibt unberührt. Zwei Szenenbegriffe nebeneinander sind Absicht, keine Drift — sie beantworten verschiedene Fragen (Analyse-Szene der Belletristik vs. Autoren-Szene des Drehbuchs).

`docs/erd.md` im selben Commit: Stand-Zeile bumpen, drei Blöcke + FK-Kanten ergänzen. `npm run squash:regen` nicht vergessen.

## Security

- ACL über `guardBook` / `pageBookGuard`, keine handgeschriebenen Guards. Lesen ab `viewer`, Schreiben ab `editor`.
- `data-fig` ist eine Figuren-ID aus **demselben** Buch — beim Indexieren gegen `figures.book_id` prüfen (Muster: der Buch-Guard in `replacePageCitations`, der Marker aus fremden Büchern verwirft). Sonst trägt eine kopierte Seite fremde Figurenreferenzen ein.
- Rollen-Karte rendert Figurennamen: `escHtml()` bzw. `x-text`, keine neuen `x-html`-Sinks.
- Kein neuer ausgehender Request → `ssrf-guard` nicht betroffen. Kein PII über das hinaus, was `figures` schon führt.
- Neue Tabellen referenzieren kein Konto → kein `USER_REF_PLAN`-Eintrag nötig; **prüfen**, falls doch eine `*_email`-Spalte dazukommt.

## Telemetrie

`n/a` für Phase 0–2. Ab Phase 3 sinnvoll: Zahl der Bücher mit Buchtyp `dramatik` und Zahl indizierter Szenen als `/metrics`-Kennzahlen. **Dann Pflicht:** Eintrag in `docs/homeassistant/configuration.yaml`, `dashboard.yaml` und die Sensor-Übersicht im selben Commit.

## Reversibilität

- **Phase 0–1** vollständig reversibel: Buchtyp aus der Config nehmen, Profile-Einträge entfernen. Bestehende Bücher fallen auf `narrativ` zurück; Alt-Bewertungen rendern weiter, weil der Renderer die Achsen aus `review.profil` **im Ergebnis-JSON** zieht, nicht aus dem aktuellen Buchtyp.
- **Phase 2** ist der Punkt ohne einfachen Rückweg: Markup steht dann in `pages.content`. Ohne die Klassen degradiert es zu normalen Absätzen — Text bleibt vollständig erhalten, nur die Struktur ist weg. Das ist die richtige Degradation, aber eine Einbahnstrasse.
- **Phase 3** trivial rückbaubar: reine Ableitungstabellen, `DROP TABLE` genügt, Neuaufbau jederzeit über `reindexAllDrama`.
- Kill-Switch: Karte über `requiresBuchtyp` ohnehin gegated; ein `dramatik.enabled`-Setting wäre nur für Phase 3 sinnvoll und ist im MVP nicht vorgesehen.

## Tests

**Unit**
- `tests/unit/dramenformen-drift.test.mjs` — Katalog-Konsistenz, CJS-Spiegel, i18n in beiden Locales (Bauplan: [textsorten-drift.test.mjs](../../tests/unit/textsorten-drift.test.mjs))
- Erweiterung `lektorat-typen-drift` (Profil-Zuordnung, `TYP_PRIORITAET`-Vollständigkeit, `FEHLER_CLUSTERS`-Union, CJS-Spiegel) und `review-typen-drift` (Profil-Vollständigkeit, Schema == Achsen, **Profil→Test-Buchtyp-Map**)
- `lektorat-prompt-contract` / `review-prompt-contract` um `dramatik` erweitern — insbesondere die Notenanker-Invariante
- Neu: Markup-Invarianten (`drama-html`), Slug-Parsing (INT./EXT./Tageszeit), seitenübergreifende Szenen-Zusammensetzung, Zählpfad schneidet / Prompt-Pfad nicht

**Integration**
- Index-Lebenszyklus: Seite speichern → Szene da; Slug entfernen → Szene weg; Seite verschieben → Buchzuordnung stimmt; `ensureBookDramaIndexed` füllt eine nie indizierte Seite nach

**E2E / Smoke**
- `npm run test:smoke` deckt die neue Karte registry-getrieben automatisch ab
- Neu, Fixture-Harness: Slash-Einfügen einer Replik, Tab-Zyklus, Caret-Verhalten an Blockgrenzen
- **Paste-Spec** (der Test, der heute fehlschlägt): Szene markieren → Cut → Paste → alle Klassen erhalten

**Manuell**
- Sieben Ausgabewege einmal von Hand ziehen. **Keine Formalie:** [lib/export-builders/epub.js](../../lib/export-builders/epub.js) enthält heute schon **keine** `poem`-Regel — Gedichte verlieren dort ihre Formatierung, und es ist niemandem aufgefallen. Der `paragraph`-Fallback ist gnädig (kein Datenverlust, nur Formatverlust) und deshalb unauffällig.
- Seed-Skript `scripts/seed-dramatik.js` nach dem Muster von `scripts/seed-journalismus.js`

## Edge-Cases

| Fall | Umgang |
|---|---|
| Sprecher ohne Figurenkartei-Eintrag | zulässig: `data-fig` optional, `drama_speeches.sprecher` trägt den Namen. Rollen-Karte zeigt ihn als „nicht zugeordnet" mit Übernahme-Aktion. |
| Figur umbenannt | `data-fig` ist die Wahrheit, der Name im Markup ein Cache — jeder Renderer setzt ihn frisch (Regel wie beim Quellen-Chip). |
| Figur gelöscht | `ON DELETE SET NULL`; die Replik bleibt, fällt in „nicht zugeordnet". |
| Szene läuft über mehrere Seiten | Fortsetzungs-Flag, Zusammenbau auf Buchebene. Kein Umfang in der Segmentzeile. |
| Seite beginnt mitten in einer Szene | genau der Fortsetzungsfall — erstes Segment ohne Slug. |
| Slug ohne erkennbares INT/EXT | `innen_aussen NULL`, Szene zählt trotzdem. Nie raten. |
| Buchtyp nachträglich auf `dramatik` gewechselt | Markup fehlt, Indexe leer, Rollen-Karte zeigt Leerzustand mit Hinweis — kein Fehler. |
| Buchtyp weg von `dramatik` | Markup bleibt im Text und rendert weiter; Karte verschwindet. Kein Datenverlust. |
| Replik ohne Text (nur Sprecher) | fällt aus dem Index (Muster `collectDiagrams`: leerer Block ist kein Block). |
| Sehr lange Replik | kein Deckel im Index; das Lektorat meldet sie über `sprechbarkeit`. |
| Import aus Fremdformat / Snapshot-Restore | läuft über `createPage` — der Index hängt dort ebenfalls (Z. 200–201), nicht nur an `savePage`. |

## Kritische Dateien

**Modify**
- `prompt-config.json` — Buchtyp `dramatik` (de + en)
- [routes/booksettings.js](../../routes/booksettings.js) — `VALID_BUCHTYPEN` (Z. 22)
- [public/js/prompts/lektorat-typen.js](../../public/js/prompts/lektorat-typen.js) — Profil-Array, `PROFILE`, `PROFIL_BY_BUCHTYP`, `TYP_PRIORITAET`, `SPAN_KIND`
- [public/js/prompts/blocks-fach.js](../../public/js/prompts/blocks-fach.js) — **eigener Zweig** in `_buildFachAufgabe` / `_buildFachSelbstkontrollBlock` / `_buildFachAbschnittRegelnBlock`, sonst fällt `dramatisch` in den Wissenschafts-Default
- [public/js/prompts/lektorat.js](../../public/js/prompts/lektorat.js) — Profil-Flags (Z. 91–96) und die daran hängenden Blöcke
- [public/js/prompts/review-typen.js](../../public/js/prompts/review-typen.js) — `AXIS`, `CHAPTER_AXIS_OVERRIDE`, Profil-Objekt, `PROFIL_BY_BUCHTYP`
- [public/js/utils/html.js](../../public/js/utils/html.js) — **Paste-Whitelist** (Z. 114–133, 164, 174–184)
- [public/js/editor/shared/paste.js](../../public/js/editor/shared/paste.js) — **`text/html` bei Copy und Cut** (Z. 81–102)
- [public/js/editor/shared/dom-block.js](../../public/js/editor/shared/dom-block.js) — `CARET_BLOCK_SEL` (Z. 23)
- [lib/html-clean.js](../../lib/html-clean.js) — `flattenDivBlocks`, `_hasPoemClass`, `ensureBlockIds` (Z. 182–190, 317–325)
- [lib/html-text.js](../../lib/html-text.js) + `public/js/html-text.js` — **Zähl-Variante**, Spiegel Pflicht
- [lib/page-index.js](../../lib/page-index.js) — Dramatik-Zweig in `_findDialogRanges` / `computePronounsAndDialog` (Z. 156–208)
- [routes/sync.js](../../routes/sync.js) — Zähl-Variante statt `htmlToText` für die Statistik (Z. 243–244)
- [lib/content-store/index.js](../../lib/content-store/index.js) — dritter Index-Hook (Z. 187–190, 200–201, 242–248)
- [lib/pdf-render/html-walker.js](../../lib/pdf-render/html-walker.js) + `lib/pdf-render/blocks.js` — neue `kind`s
- `lib/export-builders/{docx,md,substack,html,epub}.js` — je ein `case` bzw. CSS-Regel
- [public/js/cards/feature-registry.js](../../public/js/cards/feature-registry.js) — beide Registries
- [routes/usage.js](../../routes/usage.js), `db/migrations.js`, `db/squashed-schema.js`, `docs/erd.md`, `public/js/i18n/{de,en}.json`, `public/index.html`, `public/sw-manifest.js`, `CLAUDE.md`
- Kleinkram, leicht übersehen: `NON_PROSE_BUCHTYPEN` ([lib/share-helpers.js](../../lib/share-helpers.js) Z. 36), `BUCHTYP_LABELS_DE` ([tools-catalog.js](../../routes/jobs/book-chat-tools/tools-catalog.js) Z. 521), `VALID_BUCHTYPEN` ([routes/usersettings.js](../../routes/usersettings.js) Z. 62 — führt **bestehende Drift**: nur 10 der 18 Typen sind als User-Default wählbar)

**Create**
- `public/js/drama/drama-html.js` — Markup-SSoT
- `public/js/prompts/dramenformen.js` — Formkatalog
- `db/dramenform.js` — CJS-Spiegel + `effectiveDramenform`
- `db/drama.js` — Index-Schreiber/Leser
- `lib/drama-index.js`, `lib/drama-scenes.js`
- `routes/dramenform.js`, `routes/drama.js`
- `public/js/book/rollen.js`, `public/js/cards/rollen-card.js`, `public/partials/rollen.html`, `public/css/analysis/rollen.css`
- `docs/dramatik.md`, `scripts/seed-dramatik.js`
- Tests: `tests/unit/dramenformen-drift.test.mjs`, `tests/unit/drama-html.test.mjs`, `tests/unit/drama-scenes.test.mjs`, `tests/integration/drama-index.test.js`, `tests/e2e/drama-paste.spec.js`

## Offene Fragen

1. **`werkPhrase` kennt nur den Buchtyp, nicht die Form.** „das Drehbuch" / „das Stück" / „das Hörspiel" / „der Podcast" lassen sich damit nicht unterscheiden — die Bewertung müsste eine neutrale Formulierung tragen (Vorschlag: `das Skript`). Alternative: `werkPhrase(buchtyp, kasus)` um die Form erweitern; das betrifft alle fünf Profile und ist der grössere Eingriff. **Entscheidung nötig vor Phase 0.**
2. **Wie streng darf die Paste-Whitelist werden?** `P: new Set(['class'])` plus Klassen-Whitelist ist der Vorschlag (Muster: der SPAN-Zweig, der nur Cite und Xref durchlässt). Offen ist, ob die Whitelist die Dramatik-Klassen hart aufzählt oder ein Präfix erlaubt.
3. **Podcast: eigene Form oder Journalismus-Zweig?** Das Skript grenzt an das bestehende redaktionelle Arbeiten (O-Ton, Interview-Transkription, Zitatautorisierung). Möglicherweise ist Podcast besser als Textsorte im Journalismus-Buchtyp aufgehoben als als Dramenform — dann fallen im MVP drei Formen an statt vier.
4. **Wird `page_structure_checks` wirklich mitbenutzt** (mit `katalog`-Spalte), oder bekommt Dramatik einen eigenen Formcheck? Ersteres spart den halben Job, letzteres hält die Key-Räume sauber getrennt.
5. **Braucht die Rollen-Karte einen Kapitel-/Akt-Filter** oder reicht die Buchsicht im MVP?
