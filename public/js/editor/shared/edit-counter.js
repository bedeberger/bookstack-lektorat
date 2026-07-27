// Per-Container-Counter für Edit-Modus: zählt Wörter/Zeichen + Delta gegen
// Tagesbaseline. Konsumenten: Notebook + Focus. Lebt unter editor/shared/
// statt unter editor/focus/, damit kein Editor JS-mässig auf einen anderen
// abstützt.

import { getActiveEditorContainer } from './active-editor.js';
import { localIsoDate } from '../../utils.js';

const COUNTER_DEBOUNCE_MS = 220;
const DAILY_BASELINE_KEY = 'focus.dailyBaseline';

// Tages-Bucket in `app.timezone`, nicht in Browser-TZ. Browser-Datumsteile
// (getFullYear/getMonth/getDate) würden die Baseline in einer abweichenden
// Zeitzone am falschen Tag zurücksetzen — mitten im Abend-Schreibfenster.
function todayKey() {
  return localIsoDate();
}

function readDailyBaselines() {
  try {
    const raw = localStorage.getItem(DAILY_BASELINE_KEY);
    return raw ? (JSON.parse(raw) || {}) : {};
  } catch { return {}; }
}

function writeDailyBaselines(obj) {
  try { localStorage.setItem(DAILY_BASELINE_KEY, JSON.stringify(obj)); }
  catch { /* quota / private mode — egal, Delta bleibt 0 */ }
}

// Liefert {dw, dc} (delta words/chars) für die heutige Sitzung der Seite.
// Schreibt bei Bedarf einen frischen Baseline-Eintrag und prunt stale.
export function dailyDelta(pageId, words, chars) {
  if (pageId == null) return { dw: 0, dc: 0 };
  const today = todayKey();
  const all = readDailyBaselines();
  let dirty = false;
  for (const id of Object.keys(all)) {
    if (all[id]?.date !== today) { delete all[id]; dirty = true; }
  }
  let entry = all[pageId];
  if (!entry || entry.date !== today) {
    entry = { date: today, words, chars };
    all[pageId] = entry;
    dirty = true;
  }
  if (dirty) writeDailyBaselines(all);
  return { dw: words - entry.words, dc: chars - entry.chars };
}

// `±0` für klare Optik bei Null statt nacktem `0`. Unicode-Minus für sauberen
// Tabulator-Look (gleiche Glyph-Breite wie Plus); ASCII-Hyphen ist schmaler.
export function fmtSigned(n) {
  if (n > 0) return '+' + n;
  if (n < 0) return '−' + Math.abs(n);
  return '±0';
}

// Edit-Mode-Counter: läuft sobald Edit-Modus aktiv ist (NICHT erst im Fokus).
// Setzt Tagesbaseline beim Edit-Start (nicht beim Focus-Eintritt) und tickt bei
// jeder Eingabe – damit zählen auch Edits ausserhalb des Fokusmodus zum
// „heute"-Delta. Idempotent: doppelter Install-Aufruf liefert dieselbe Teardown-
// Funktion zurück, ohne zweite Listener anzuhängen.
export function installEditCounter(app) {
  if (!app) return () => {};
  if (app._editCounterCtx) return app._editCounterCtx.teardown;

  const container = getActiveEditorContainer();
  if (!container) return () => {};

  let timer = 0;
  const compute = () => {
    const txt = container.textContent || '';
    const chars = txt.length;
    const words = txt.trim() ? txt.trim().split(/\s+/).length : 0;
    app.focusCountChars = chars;
    app.focusCountWords = words;
    const { dw, dc } = dailyDelta(app.currentPage?.id, words, chars);
    app.focusCountWordsDelta = fmtSigned(dw);
    app.focusCountCharsDelta = fmtSigned(dc);
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(compute, COUNTER_DEBOUNCE_MS);
  };

  container.addEventListener('input', schedule);
  container.addEventListener('compositionend', schedule);

  // Initial: Baseline für heute setzen (falls noch nicht vorhanden) und
  // aktuellen Stand anzeigen. Ohne diesen Call würde Delta erst nach erstem
  // Tastendruck überhaupt initialisiert.
  compute();

  const teardown = () => {
    clearTimeout(timer);
    container.removeEventListener('input', schedule);
    container.removeEventListener('compositionend', schedule);
    if (app._editCounterCtx?.teardown === teardown) app._editCounterCtx = null;
  };
  app._editCounterCtx = { teardown };
  return teardown;
}
