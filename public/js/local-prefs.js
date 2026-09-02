// Per-User-/Per-Buch-Prefs im localStorage. Quota-tolerant (alle Calls in
// try/catch). Keys: `sw:<bereich>:<email>:<bookId>[:<scope>]`.
//
// Bereiche:
//   - lastBookId:<email>                   -> Rückfall-Merker fürs Startbuch
//   - lastPage:<email>:<bookId>            -> letzte geöffnete Seiten-ID
//   - filters:<email>:<bookId>:<scope>     -> Filter-Objekt pro Karten-Scope
//   - userpref:<email>:<key>               -> book-unabhängiger User-Pref (JSON)

const PREFIX = 'sw';

function safeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}
function safeRemove(key) {
  try { localStorage.removeItem(key); } catch {}
}

// Startbuch-Rückfall. Die WAHRHEIT dazu ist serverseitig
// (`book_shelf.last_opened_at`, ein Zeitstempel pro Buch und User) — dieser
// Merker greift nur, wenn kein Buch der Liste einen Server-Zeitstempel trägt:
// erster Besuch auf diesem Gerät, oder offline geschrieben und noch nicht
// gemeldet. Er ist bewusst kein zweiter Schiedsrichter: localStorage ist
// browserweit und nicht pro Tab, konkurrierende Tabs können daran nichts
// entscheiden. Geschrieben wird er an genau denselben Stellen wie der
// Server-Zeitstempel (`_touchBookOpened`), nie beim Boot allein.
function lastBookKey(email) {
  return `${PREFIX}:lastBookId:${email || ''}`;
}

export function getLastBookId(email) {
  const raw = safeGet(lastBookKey(email));
  return raw ? String(raw) : '';
}

export function setLastBookId(email, bookId) {
  if (!bookId) return;
  safeSet(lastBookKey(email), String(bookId));
}

function lastPageKey(email, bookId) {
  return `${PREFIX}:lastPage:${email || ''}:${bookId}`;
}

function filtersKey(email, bookId, scope) {
  return `${PREFIX}:filters:${email || ''}:${bookId}:${scope}`;
}

export function getLastPageId(email, bookId) {
  if (!bookId) return null;
  const raw = safeGet(lastPageKey(email, bookId));
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

export function setLastPageId(email, bookId, pageId) {
  if (!bookId || !pageId) return;
  safeSet(lastPageKey(email, bookId), String(pageId));
}

export function clearLastPageId(email, bookId) {
  if (!bookId) return;
  safeRemove(lastPageKey(email, bookId));
}

export function getFilters(email, bookId, scope) {
  if (!bookId || !scope) return null;
  const raw = safeGet(filtersKey(email, bookId, scope));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export function setFilters(email, bookId, scope, filters) {
  if (!bookId || !scope) return;
  try {
    safeSet(filtersKey(email, bookId, scope), JSON.stringify(filters || {}));
  } catch {}
}

// Book-unabhängiger User-Pref. Für View-Settings, die nicht pro Buch variieren
// (z.B. Chart-Metric in BookStats). JSON-serialisiert, fallback-tolerant.
function userPrefKey(email, key) {
  return `${PREFIX}:userpref:${email || ''}:${key}`;
}

export function getUserPref(email, key, fallback = null) {
  if (!key) return fallback;
  const raw = safeGet(userPrefKey(email, key));
  if (raw == null) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

export function setUserPref(email, key, value) {
  if (!key) return;
  try {
    safeSet(userPrefKey(email, key), JSON.stringify(value));
  } catch {}
}
