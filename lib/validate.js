'use strict';
// Eingabe-Validierung an Request-Grenzen.
//
// Hintergrund: `parseInt('42abc')` liefert `42` und `parseInt('1e10')` liefert `1` —
// better-sqlite3 bindet das ohne Fehler an einen INTEGER-Parameter. Bei Routen,
// die IDs aus URL/Body/Query lesen, will man stattdessen striktes „ganze Zahl"
// und sonst eine 400-Antwort. `toIntId(v)` gibt die Zahl zurück oder `null`.

function toIntId(v) {
  if (v == null) return null;
  if (typeof v === 'number') {
    return Number.isInteger(v) && v > 0 ? v : null;
  }
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!/^[1-9][0-9]*$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

// Sicheres `IN (?,?,...)` für Listen. Leere Liste → `(NULL)` (matched nichts,
// kein SQL-Crash). Caller müssen Empty-Guard nicht mehr selbst bauen.
function inClause(ids) {
  const arr = Array.isArray(ids) ? ids : [];
  if (!arr.length) return { sql: '(NULL)', values: [] };
  return { sql: '(' + arr.map(() => '?').join(',') + ')', values: arr };
}

module.exports = { toIntId, inClause };
