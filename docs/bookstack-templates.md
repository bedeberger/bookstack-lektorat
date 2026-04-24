# BookStack-Templates integrieren

Das Verzeichnis [`themes/custom/`](../themes/custom/) enthält sechs Dateien, die BookStack an zwei Stellen erweitern:

- **PDF-Export** (Buch, Kapitel, Seite) mit eigenem Layout in B5, Playfair Display / EB Garamond, automatischem Inhaltsverzeichnis und laufenden Kopfzeilen.
- **Editor-Erweiterung „Gedicht"** — ein Block-Format mit kursivem Satz, Einrückung und Zierstrich, verfügbar sowohl im alten TinyMCE- als auch im neuen Lexical-Editor (`wysiwyg2024`).

Dieser Leitfaden beschreibt, wie du die Dateien in eine bestehende BookStack-Installation einspielst.

---

## 1. Überblick über die Dateien

| Datei | Zweck |
|-------|-------|
| `functions.php` | Einstiegspunkt des Themes. Registriert den Hook `THEME_REGISTER_VIEWS` und hängt `tinymce-poem` an `layouts.parts.custom-head`. Wird von BookStack beim Start automatisch geladen. |
| `tinymce-poem.blade.php` | Wird in den `<head>` jeder Seite injiziert. Liefert die `.poem`-CSS-Regeln für den Viewer und registriert das Format `Gedicht` beim Editor (TinyMCE-Dropdown bzw. Lexical-Toolbar-Button). |
| `exports/book.blade.php` | Buch-Export-Template mit Titelseite, Inhaltsverzeichnis und Kapitelwechseln. |
| `exports/chapter.blade.php` | Kapitel-Export (Titelseite + alle Seiten des Kapitels). |
| `exports/page.blade.php` | Einzelseiten-Export mit gleicher Typografie. |
| `exports/pdf-styles.blade.php` | Gemeinsame Styles (`@page`, Typografie, Seitenumbrüche) für die drei Export-Blades. Wird via `@include('exports.pdf-styles')` eingebunden. |

> Die Export-Blades erwarten BookStacks eigene Views `layouts.export` und `exports.parts.page-item` — die sind Teil von BookStack und müssen nicht mitgeliefert werden.

---

## 2. Verzeichnis-Layout in BookStack

Im Repository liegen alle Dateien flach in `themes/custom/`. In der BookStack-Installation müssen die Export-Blades in den Unterordner `exports/` umziehen, damit BookStacks View-Resolver die Namen (`exports.book`, `exports.pdf-styles`, …) findet:

```
<bookstack-root>/
└── themes/
    └── custom/
        ├── functions.php
        ├── tinymce-poem.blade.php
        └── exports/
            ├── book.blade.php
            ├── chapter.blade.php
            ├── page.blade.php
            └── pdf-styles.blade.php
```

`<bookstack-root>` ist der Projektordner deiner BookStack-Instanz (bei Docker-Setups typischerweise ein gemountetes Volume, z.B. `./bookstack_app_data/` oder `/var/www/bookstack/`).

---

## 3. Installation

### 3.1 Dateien kopieren

```bash
# aus dem Root des Lektorat-Repos
BOOKSTACK_ROOT=/pfad/zu/deiner/bookstack-instanz

mkdir -p "$BOOKSTACK_ROOT/themes/custom/exports"

cp themes/custom/functions.php           "$BOOKSTACK_ROOT/themes/custom/"
cp themes/custom/tinymce-poem.blade.php  "$BOOKSTACK_ROOT/themes/custom/"
cp themes/custom/book.blade.php          "$BOOKSTACK_ROOT/themes/custom/exports/"
cp themes/custom/chapter.blade.php       "$BOOKSTACK_ROOT/themes/custom/exports/"
cp themes/custom/page.blade.php          "$BOOKSTACK_ROOT/themes/custom/exports/"
cp themes/custom/pdf-styles.blade.php    "$BOOKSTACK_ROOT/themes/custom/exports/"
```

Bei Docker-Deployments müssen die Dateien in das gemountete Theme-Volume liegen (siehe `docker-compose.yml` der BookStack-Instanz, Mount-Target ist `/app/www/themes`).

### 3.2 Theme in BookStack aktivieren

In der **`.env` der BookStack-Instanz** (nicht der Lektorat-App) setzen:

```ini
APP_THEME=custom
```

Danach BookStack neu starten bzw. den Container neu hochfahren:

```bash
docker compose restart bookstack
```

### 3.3 Cache leeren

BookStack cacht kompilierte Blade-Views. Nach dem Einspielen oder jeder Änderung:

```bash
docker compose exec bookstack php artisan view:clear
docker compose exec bookstack php artisan cache:clear
```

Ohne Docker: dieselben `php artisan`-Befehle direkt im BookStack-Projektordner.

---

## 4. Prüfen, ob es klappt

### PDF-Export
1. In BookStack ein Buch öffnen → **Export → PDF**.
2. Das erzeugte PDF sollte eine Titelseite, ein Inhaltsverzeichnis und laufende Kopfzeilen (Kapitelname links, Seitenname rechts) haben.
3. Schriftarten: Playfair Display (Titel) und EB Garamond (Fliesstext).

> **Internetzugang nötig:** `pdf-styles.blade.php` importiert Google Fonts via `@import url(...)`. Der BookStack-Server muss beim Export `fonts.googleapis.com` erreichen können. Für air-gapped Setups: Fonts lokal ablegen und den `@import`-Block durch `@font-face`-Deklarationen mit eigenen URLs ersetzen.

### Gedicht-Format
1. Eine Seite bearbeiten.
2. **Alter Editor (TinyMCE):** im Format-Dropdown sollte „Gedicht" erscheinen. Absatz markieren → auswählen → Absatz bekommt Kursivschrift, linken Rand und Zierstrich.
3. **Neuer Editor (Lexical / `wysiwyg2024`):** in der letzten Toolbar-Sektion sollte ein Button „Gedicht" sein. Klick fügt einen Beispielblock mit zwei Zeilen ein.

Wenn der Lexical-Button fehlt, in der DevTools-Konsole nach `[theme] Gedicht-Button konnte nicht registriert werden` suchen — BookStack warnt ausdrücklich, dass die Lexical-API sich ändern kann.

---

## 5. Anpassen

### Seitengrösse oder Ränder ändern
Nur in [`pdf-styles.blade.php`](../themes/custom/pdf-styles.blade.php) editieren, der `@page`-Block oben ist die einzige Stelle:

```css
@page {
  size: 176mm 250mm;          /* B5 */
  margin: 24mm 18mm 28mm 20mm;
}
```

### Cover-Vollbild an/aus
`book.blade.php` ruft `@include('exports.pdf-styles', ['coverBleed' => true])`. Auf `false` setzen (oder den Parameter weglassen), wenn die Titelseite den normalen Seitenrand behalten soll.

### Farben / Schriftarten
Playfair Display und EB Garamond werden in `pdf-styles.blade.php` per `@import url()` geladen. Andere Google-Fonts: URL oben austauschen und die `font-family`-Werte im Style-Block anpassen.

### Poem-Look
Nur in [`tinymce-poem.blade.php`](../themes/custom/tinymce-poem.blade.php). Der `<style>`-Block regelt das Aussehen im Viewer; `cfg.content_style` spiegelt dieselben Regeln in den TinyMCE-Editor, damit Autor:innen während des Schreibens sehen, wie es später aussieht. Beide Stellen synchron halten.

---

## 6. Fehlersuche

| Symptom | Ursache / Fix |
|---------|---------------|
| Export sieht aus wie vorher | `APP_THEME=custom` nicht gesetzt oder BookStack nicht neu gestartet. `php artisan config:clear && php artisan view:clear`. |
| `View [exports.pdf-styles] not found` | `pdf-styles.blade.php` liegt nicht in `themes/custom/exports/`. Pfad prüfen. |
| Schrift fällt auf Serifen zurück | Keine Internetverbindung beim Export — Google Fonts unerreichbar. Siehe Abschnitt 4. |
| Gedicht-Format fehlt im Dropdown | `functions.php` nicht geladen (Theme-Name falsch?) oder View-Cache nicht geleert. |
| Lexical-Button fehlt | BookStack-Update kann die Lexical-API verändert haben. DevTools-Console prüfen. |

---

## 7. Referenz: BookStack-Theme-System

- Offizielle Doku: <https://www.bookstackapp.com/docs/admin/hacking-bookstack/> (Abschnitt „Visual Theme System" und „Logic Theme System").
- `functions.php` wird automatisch geladen, wenn `APP_THEME` gesetzt ist.
- Views aus dem Theme überschreiben gleichnamige aus dem BookStack-Core — `exports.book` im Theme sticht also das eingebaute Buch-Export-Template.
- Der Event `ThemeEvents::THEME_REGISTER_VIEWS` erlaubt das Einhängen von Partials an definierte Stellen (`custom-head`, `custom-body-start`, `custom-body-end`, …), ohne Core-Views zu überschreiben.
