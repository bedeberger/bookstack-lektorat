// Tests für die Filter-Persistenz (public/js/filter-persist.js) — die Mechanik
// hinter „Filterleiste bleibt pro Buch stehen":
//   - restore = Defaults + gespeicherte Werte, pro Buch getrennt
//   - nur deklarierte Felder landen im Speicher (flacher Scope liegt auf der
//     ganzen Karte, dort wäre alles andere Beifang)
//   - reset setzt Defaults (view:reset)
//   - ownedFilterKeys liefert die Felder, die card-lifecycle aus dem
//     Reset-Payload streicht
//   - Objekt-Scopes werden IN PLACE befüllt (Referenzen bleiben gültig)
import test from 'node:test';
import assert from 'node:assert/strict';

if (!globalThis.localStorage) {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
}

const {
  applyFilterScope, ownedFilterKeys, persistFilterScope,
  readFilterScope, resetFilterScopes, restoreFilterScopes,
} = await import('../../public/js/filter-persist.js');

const OBJ_SPEC = { scope: 'plotFilters', key: 'plotFilters', defaults: { kapitel: '', status: '', text: '' } };
const FLAT_SPEC = { scope: 'recherche', defaults: { filterKind: '', sortBy: 'updated', showArchived: false } };

const EMAIL = 'a@b.ch';

test('Objekt-Scope: persist + restore pro Buch getrennt', () => {
  const host = { plotFilters: { kapitel: 'K1', status: 'geplant', text: 'nebel' } };
  persistFilterScope(host, OBJ_SPEC, EMAIL, 7);

  // Anderes Buch → Defaults, nicht der Stand von Buch 7.
  restoreFilterScopes(host, [OBJ_SPEC], EMAIL, 8);
  assert.deepEqual(host.plotFilters, { kapitel: '', status: '', text: '' });

  restoreFilterScopes(host, [OBJ_SPEC], EMAIL, 7);
  assert.deepEqual(host.plotFilters, { kapitel: 'K1', status: 'geplant', text: 'nebel' });
});

test('Objekt-Scope wird in place befüllt — Referenzen bleiben gültig', () => {
  const host = { plotFilters: { kapitel: 'K9', status: '', text: '' } };
  const ref = host.plotFilters;
  restoreFilterScopes(host, [OBJ_SPEC], EMAIL, 999);
  assert.equal(host.plotFilters, ref, 'Filter-Objekt darf nicht ersetzt werden');
  assert.equal(ref.kapitel, '');
});

test('flacher Scope: nur deklarierte Felder werden gespeichert', () => {
  const host = {
    filterKind: 'pdf', sortBy: 'title', showArchived: true,
    // Nachbarschaft auf derselben Karte — darf nicht mitwandern.
    items: [1, 2, 3], loading: true, draft: { titel: 'x' },
  };
  assert.deepEqual(readFilterScope(host, FLAT_SPEC), {
    filterKind: 'pdf', sortBy: 'title', showArchived: true,
  });

  persistFilterScope(host, FLAT_SPEC, EMAIL, 3);
  const fresh = { filterKind: '', sortBy: 'updated', showArchived: false, items: [] };
  restoreFilterScopes(fresh, [FLAT_SPEC], EMAIL, 3);
  assert.equal(fresh.filterKind, 'pdf');
  assert.equal(fresh.sortBy, 'title');
  assert.equal(fresh.showArchived, true);
  assert.deepEqual(fresh.items, [], 'fremde Felder bleiben unberührt');
});

test('ohne bookId wird weder gelesen noch geschrieben', () => {
  const host = { plotFilters: { kapitel: 'K1', status: '', text: '' } };
  persistFilterScope(host, OBJ_SPEC, EMAIL, null);
  // Restore ohne Buch fällt auf Defaults zurück (kein Blick in den Speicher).
  restoreFilterScopes(host, [OBJ_SPEC], EMAIL, null);
  assert.deepEqual(host.plotFilters, { kapitel: '', status: '', text: '' });
});

test('reset setzt Defaults, auch bei gespeichertem Stand', () => {
  const host = { filterKind: 'pdf', sortBy: 'title', showArchived: true };
  persistFilterScope(host, FLAT_SPEC, EMAIL, 5);
  resetFilterScopes(host, [FLAT_SPEC]);
  assert.deepEqual(readFilterScope(host, FLAT_SPEC), {
    filterKind: '', sortBy: 'updated', showArchived: false,
  });
});

test('gespeicherter Teilstand: fehlende Felder fallen auf Default', () => {
  const host = { plotFilters: { kapitel: 'K2', status: 'im_buch', text: 'x' } };
  // Nur ein Feld im Speicher (z.B. Scope später um ein Feld erweitert).
  globalThis.localStorage.setItem(`sw:filters:${EMAIL}:11:plotFilters`, JSON.stringify({ kapitel: 'K2' }));
  applyFilterScope(host, OBJ_SPEC, JSON.parse(globalThis.localStorage.getItem(`sw:filters:${EMAIL}:11:plotFilters`)));
  assert.deepEqual(host.plotFilters, { kapitel: 'K2', status: '', text: '' });
});

test('ownedFilterKeys: Objekt-Scope → Objektname, flacher Scope → Feldnamen', () => {
  assert.deepEqual([...ownedFilterKeys([OBJ_SPEC])], ['plotFilters']);
  assert.deepEqual([...ownedFilterKeys([FLAT_SPEC])], ['filterKind', 'sortBy', 'showArchived']);
  assert.equal(ownedFilterKeys([]).size, 0);
  assert.equal(ownedFilterKeys(undefined).size, 0);
});
