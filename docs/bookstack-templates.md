# BookStack-Templates integrieren

[`themes/custom/`](../themes/custom/) erweitert BookStack an zwei Stellen:

- **PDF-Export** (Buch, Kapitel, Seite) in B5, Playfair Display / EB Garamond, mit Inhaltsverzeichnis und laufenden Kopfzeilen.
- **Editor-Block „Gedicht"** – kursiver Satz, Einrückung, Zierstrich. Verfügbar in TinyMCE und Lexical (`wysiwyg2024`).

## 1. Dateien

| Datei | Zweck |
|---|---|
| `functions.php` | Theme-Einstieg. Registriert `THEME_REGISTER_VIEWS`, hängt `tinymce-poem` an `layouts.parts.custom-head`. |
| `tinymce-poem.blade.php` | `.poem`-CSS für den Viewer + Format-Registrierung in TinyMCE/Lexical. |
| `exports/book.blade.php` | Buch-Export (Titelseite, Inhaltsverzeichnis, Kapitelwechsel). |
| `exports/chapter.blade.php` | Kapitel-Export. |
| `exports/page.blade.php` | Einzelseiten-Export. |
| `exports/pdf-styles.blade.php` | Gemeinsame Styles (`@page`, Typografie, Umbrüche). |

`layouts.export` und `exports.parts.page-item` kommen aus BookStack-Core.

## 2. Layout in BookStack

Im Repo flach in `themes/custom/`. In der BookStack-Installation müssen die Export-Blades nach `exports/`:

```
<bookstack-root>/themes/custom/
├── functions.php
├── tinymce-poem.blade.php
└── exports/
    ├── book.blade.php
    ├── chapter.blade.php
    ├── page.blade.php
    └── pdf-styles.blade.php
```

Bei Docker-Setups: gemountetes Theme-Volume (Mount-Target `/app/www/themes`).

## 3. Installation

### Dateien kopieren

```bash
BOOKSTACK_ROOT=/pfad/zu/bookstack
mkdir -p "$BOOKSTACK_ROOT/themes/custom/exports"

cp themes/custom/functions.php           "$BOOKSTACK_ROOT/themes/custom/"
cp themes/custom/tinymce-poem.blade.php  "$BOOKSTACK_ROOT/themes/custom/"
cp themes/custom/book.blade.php          "$BOOKSTACK_ROOT/themes/custom/exports/"
cp themes/custom/chapter.blade.php       "$BOOKSTACK_ROOT/themes/custom/exports/"
cp themes/custom/page.blade.php          "$BOOKSTACK_ROOT/themes/custom/exports/"
cp themes/custom/pdf-styles.blade.php    "$BOOKSTACK_ROOT/themes/custom/exports/"
```

### Theme aktivieren

In der **`.env` der BookStack-Instanz**:

```ini
APP_THEME=custom
```

Neu starten:

```bash
docker compose restart bookstack
```

### Cache leeren

```bash
docker compose exec bookstack php artisan view:clear
docker compose exec bookstack php artisan cache:clear
```

## 4. Prüfen

**PDF-Export:** Buch → Export → PDF. Erwartet: Titelseite, Inhaltsverzeichnis, laufende Kopfzeilen (Kapitel links, Seitenname rechts), Schriften Playfair Display + EB Garamond.

> Internetzugang nötig: `pdf-styles.blade.php` lädt Google Fonts via `@import`. Air-gapped: Fonts lokal ablegen, `@import` durch `@font-face` ersetzen.

**Gedicht-Format:**
- TinyMCE: Format-Dropdown enthält „Gedicht".
- Lexical: Toolbar-Button „Gedicht" in der letzten Sektion.

Lexical-Button fehlt → DevTools-Konsole nach `[theme] Gedicht-Button konnte nicht registriert werden` prüfen.

## 5. Anpassen

**Seitengrösse / Ränder:** [`pdf-styles.blade.php`](../themes/custom/pdf-styles.blade.php), `@page`-Block oben:

```css
@page {
  size: 176mm 250mm;
  margin: 24mm 18mm 28mm 20mm;
}
```

**Cover-Vollbild:** `book.blade.php` → `@include('exports.pdf-styles', ['coverBleed' => true])`. Auf `false` für normalen Rand.

**Schriften:** `@import url()` in `pdf-styles.blade.php` austauschen, `font-family`-Werte anpassen.

**Poem-Look:** [`tinymce-poem.blade.php`](../themes/custom/tinymce-poem.blade.php). `<style>`-Block (Viewer) und `cfg.content_style` (Editor) synchron halten.

## 6. Fehlersuche

| Symptom | Fix |
|---|---|
| Export wie vorher | `APP_THEME=custom` fehlt oder kein Restart. `php artisan config:clear && view:clear` |
| `View [exports.pdf-styles] not found` | Datei fehlt in `themes/custom/exports/` |
| Schrift fällt auf Serifen zurück | Kein Internet → Google Fonts unerreichbar |
| Gedicht-Format fehlt im Dropdown | `functions.php` nicht geladen oder View-Cache nicht geleert |
| Lexical-Button fehlt | BookStack-Update hat Lexical-API verändert. DevTools prüfen |

## 7. Referenz

- [BookStack-Doku: Hacking BookStack](https://www.bookstackapp.com/docs/admin/hacking-bookstack/)
- `functions.php` lädt automatisch bei gesetztem `APP_THEME`.
- Theme-Views überschreiben gleichnamige Core-Views.
- `THEME_REGISTER_VIEWS` hängt Partials an `custom-head`/`custom-body-start`/`custom-body-end` ein.
