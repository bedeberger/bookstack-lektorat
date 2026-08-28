// Jahr×Monat-Heatmap: geteilte, pure Bausteine für das Jahr-als-Zeile × 12-Monate-
// Raster. Konsumenten: Rückblick-Karte (book/tagebuch-rueckblick.js, interaktiv) +
// Buch-Übersicht (book-overview/diary.js, Navigation). CSS-Pattern:
// components/year-month-heatmap.css (.ymheat-*). Siehe DESIGN.md „Jahr×Monat-Heatmap".

import { localIsoDate } from '../utils.js';

// Quartil-Bucketing über positive Zählwerte → `levelFor(n)` ∈ {0..4}.
// Level 0 = keine Einträge; 1..4 = Quartile der positiven Zählwerte. Bei nur
// einer Datenlage kollabieren Stufen — das ist gewollt (wenig Varianz = wenig
// Farbabstufung). Dritter Konsument neben den beiden Jahr×Monat-Heatmaps ist
// das Wochen-Raster [public/js/streak-grid.js] — die Einfärbungs-Regel gilt für
// beide Heatmap-Formen und existiert nur hier.
export function quartileLevelFor(counts) {
  const sorted = [...counts].filter((c) => c > 0).sort((a, b) => a - b);
  const q = (p) => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]);
  const t1 = q(0.25), t2 = q(0.5), t3 = q(0.75);
  return (e) => {
    if (!e || e <= 0) return 0;
    if (e <= t1) return 1;
    if (e <= t2) return 2;
    if (e <= t3) return 3;
    return 4;
  };
}

// Aktueller Monat als 'YYYY-MM', TZ-aware (app.timezone via localIsoDate) —
// nicht Browser-TZ. Für das „aktueller Monat"-Orientierungs-Highlight der Zellen.
export function currentMonthKey() {
  return localIsoDate().slice(0, 7);
}
