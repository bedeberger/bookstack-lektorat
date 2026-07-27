// Snapshot des Notebook-Modus im sessionStorage. Pendant zu focus/storage.js:
// nach Reload (z.B. nach Session-Banner-Relogin oder manuelles F5) soll der
// Normal-Editor wieder geöffnet werden, wenn die ursprüngliche Seite geladen
// ist. sessionStorage = pro Tab/Fenster, überlebt F5 und OIDC-Redirect-
// Roundtrip, nicht aber Tab-Close.
//
// Der Snapshot enthält ausschliesslich `{ pageId, ts }` — er triggert das
// erneute Mounten der Editor-Session, nicht die Content-Wiederherstellung.
// Letztere läuft über den localStorage-Draft in `editor/draft-storage.js`
// (separater Mechanismus für unsavable Inhalte; persistiert pro Page).

const NORMAL_SNAPSHOT_KEY = 'normal.snapshot';
const NORMAL_SNAPSHOT_TTL_MS = 60 * 60 * 1000;

export function writeNormalSnapshot(pageId) {
  if (!pageId) return;
  try {
    sessionStorage.setItem(NORMAL_SNAPSHOT_KEY, JSON.stringify({ pageId, ts: Date.now() }));
  } catch {}
}

export function clearNormalSnapshot() {
  try { sessionStorage.removeItem(NORMAL_SNAPSHOT_KEY); } catch {}
}

export function readNormalSnapshot() {
  try {
    const raw = sessionStorage.getItem(NORMAL_SNAPSHOT_KEY);
    if (!raw) return null;
    const snap = JSON.parse(raw);
    if (!snap || !snap.pageId || !snap.ts) return null;
    if (Date.now() - snap.ts > NORMAL_SNAPSHOT_TTL_MS) {
      clearNormalSnapshot();
      return null;
    }
    return snap;
  } catch { return null; }
}

// User-Prefs für Notebook-Editor-Layout (Fullscreen, Seitenbreite,
// Steuerzeichen, Zoom). Persistiert in localStorage über alle Tabs/Sessions
// hinweg — der Editor soll beim nächsten Eintritt so aussehen wie beim letzten
// Verlassen. Zoom multipliziert sich orthogonal zu Fit-Width (reines
// CSS-cqi-Scaling, kein JS-Vorab-Compute), darum ist er eine eigene Pref.
const EDITOR_PREFS_KEY = 'notebook.editorPrefs';

// Grenzen des Zoom-Sliders (Spiegel von pageEditorZoomIn/Out in edit/view.js) —
// ein manipulierter localStorage-Wert darf den Editor nicht unlesbar machen.
export const ZOOM_MIN = 0.7;
export const ZOOM_MAX = 2.5;

const DEFAULTS = { fullscreen: false, fitWidth: false, showMarks: false, zoom: 1 };

function normalizeZoom(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(n * 100) / 100));
}

function normalizePrefs(prefs) {
  return {
    fullscreen: !!prefs?.fullscreen,
    fitWidth: !!prefs?.fitWidth,
    showMarks: !!prefs?.showMarks,
    zoom: normalizeZoom(prefs?.zoom ?? 1),
  };
}

export function readEditorPrefs() {
  try {
    const raw = localStorage.getItem(EDITOR_PREFS_KEY);
    if (!raw) return { ...DEFAULTS };
    return normalizePrefs(JSON.parse(raw));
  } catch { return { ...DEFAULTS }; }
}

export function writeEditorPrefs(prefs) {
  try {
    localStorage.setItem(EDITOR_PREFS_KEY, JSON.stringify(normalizePrefs(prefs)));
  } catch {}
}
