// Per-Buch-Persistenz der Filterleisten (localStorage via local-prefs.js).
//
// Ein Filter-Scope beschreibt EINE Filterleiste:
//   { scope, key?, defaults }
//     scope    — Namensteil des localStorage-Schluessels
//                (`sw:filters:<email>:<bookId>:<scope>`). Persistenz-Konstante:
//                aendert er sich, verlieren gespeicherte Filter ihren Anker.
//     key      — Feldname des Filter-OBJEKTS auf dem Host (z.B. 'plotFilters').
//                Fehlt er, liegen die Filterfelder FLACH auf dem Host
//                (z.B. `filterKind` der Recherche-Karte).
//     defaults — Default je Feld; zugleich SSoT der Feldliste. Nur genannte
//                Keys werden gespeichert, restauriert und zurueckgesetzt — ein
//                Feld, das hier fehlt, ist stillschweigend nicht persistent.
//
// Host ist `Alpine.store('catalogUi')` fuer die Katalog-Karten (Figuren, Orte,
// Szenen, Songs, Ereignisse, Kontinuitaet) und die Karten-Komponente selbst fuer
// alle uebrigen Filterleisten (Plot, Weltfakten, Recherche, Quellen, Titel).
//
// Drei Vorgaenge, ueberall dieselben:
//   restore — Defaults setzen, gespeicherte Werte darueberlegen (Buchwechsel,
//             Karten-Mount).
//   reset   — nur Defaults (view:reset); der Watcher schreibt sie danach zurueck,
//             ein Reset raeumt also auch den gespeicherten Stand.
//   persist — bei jeder Mutation, gegen das AKTUELL gewaehlte Buch.

import { getFilters, setFilters } from './local-prefs.js';

// Top-Level-Felder des Hosts, die dieser Scope besitzt. Karten-Reset-Payloads
// werden darum bereinigt (siehe card-lifecycle.js) — sonst ueberschriebe der
// Karten-Reset den gerade restaurierten Filterstand mit seinen Defaults.
export function filterScopeKeys(spec) {
  return spec.key ? [spec.key] : Object.keys(spec.defaults);
}

export function ownedFilterKeys(specs) {
  const keys = new Set();
  for (const spec of specs || []) {
    for (const k of filterScopeKeys(spec)) keys.add(k);
  }
  return keys;
}

// Zielobjekt der Filterfelder: das benannte Filter-Objekt oder der Host selbst.
function target(host, spec) {
  return spec.key ? host[spec.key] : host;
}

// Nur die deklarierten Felder auslesen — ein fremdes Feld auf dem Host (bei
// flachen Scopes ist das die ganze Karte) gehoert nicht in den Speicher.
export function readFilterScope(host, spec) {
  const src = target(host, spec);
  const out = {};
  if (!src) return out;
  for (const k of Object.keys(spec.defaults)) out[k] = src[k];
  return out;
}

// Defaults setzen, dann `saved` darueberlegen. In-Place-Mutation: bestehende
// Objekt-Referenzen (Memo-Deps, Template-Bindings) bleiben gueltig.
export function applyFilterScope(host, spec, saved) {
  const dst = target(host, spec);
  if (!dst) return;
  for (const [k, def] of Object.entries(spec.defaults)) {
    dst[k] = (saved && Object.prototype.hasOwnProperty.call(saved, k)) ? saved[k] : def;
  }
}

export function resetFilterScopes(host, specs) {
  for (const spec of specs || []) applyFilterScope(host, spec, null);
}

export function restoreFilterScopes(host, specs, email, bookId) {
  for (const spec of specs || []) {
    applyFilterScope(host, spec, bookId ? getFilters(email, bookId, spec.scope) : null);
  }
}

export function persistFilterScope(host, spec, email, bookId) {
  if (!bookId) return;
  setFilters(email, bookId, spec.scope, readFilterScope(host, spec));
}

// `$watch` je Scope. Objekt-Scopes werden ueber einen Getter gewatcht (Alpine
// vergleicht JSON-serialisiert → deep, also feuert auch eine verschachtelte
// Mutation); flache Scopes pro Feld, weil es dort kein umschliessendes Objekt
// gibt. `ctx` ist die Alpine-Komponente, die `$watch` bereitstellt.
export function watchFilterScopes(ctx, host, specs, { email, bookId }) {
  for (const spec of specs || []) {
    const save = () => persistFilterScope(typeof host === 'function' ? host() : host, spec, email(), bookId());
    if (spec.key) {
      const get = () => (typeof host === 'function' ? host() : host)[spec.key];
      ctx.$watch(get, save);
    } else {
      for (const field of Object.keys(spec.defaults)) {
        ctx.$watch(() => (typeof host === 'function' ? host() : host)[field], save);
      }
    }
  }
}
