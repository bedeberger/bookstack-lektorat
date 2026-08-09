'use strict';
// Coercion-Atome der PDF-Export-Profil-Validierung.
//
// Geteilt zwischen lib/pdf-export-defaults.js und den Themen-Untermodulen
// (./table.js). Sie liegen hier und nicht dort, weil eine Kopie je Untermodul
// genau die Drift erzeugt, gegen die die strikte Validierung antritt: ein
// `_num`, das in einem Modul clampt und im anderen nur prueft, ist an der
// Profil-Antwort nicht zu sehen.

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function num(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

function enumOf(v, allowed, fallback) {
  return allowed.includes(v) ? v : fallback;
}

function bool(v, fallback) {
  if (typeof v === 'boolean') return v;
  return fallback;
}

function hex(v, fallback) {
  if (typeof v !== 'string') return fallback;
  const s = v.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    const r = s[1], g = s[2], b = s[3];
    return ('#' + r + r + g + g + b + b).toLowerCase();
  }
  return fallback;
}

module.exports = { isObj, num, enumOf, bool, hex };
