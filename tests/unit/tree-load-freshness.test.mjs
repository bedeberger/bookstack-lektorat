// Gate fuer die Frische-Entscheidung der Sidebar-Reads (Buchliste + Baum).
//
// WARUM ALS UNIT-TEST: Der Service Worker ist auf localhost aus
// (public/js/app/boot/sw-register.js). Ein Stale-Hit auf dem Baum faellt darum
// weder lokal noch im Smoke auf — er zeigt sich auf HTTPS als "die importierten
// Seiten sind nicht da" bzw. "nach dem Aufwachen steht der alte Stand", und ein
// Hard-Refresh (umgeht den SW) widerlegt es.
//
// DIE INVARIANTE: Stale-While-Revalidate ist fuer den KALTSTART richtig (Sidebar
// steht sofort, offline ueberhaupt) und fuer einen EREIGNIS-getriggerten Reload
// falsch. Wake-Refresh, Buchwechsel und "Job fertig" fragen nach dem Serverstand.
// Zwei dieser drei sind ausserdem Faelle, in denen im Browser gar kein
// Cache-Bust gelaufen sein KANN: der Wake hat waehrend des Schlafs nichts
// mitbekommen, und Import-/Pull-Jobs legen die Seiten serverseitig an.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readsFresh } from '../../public/js/book/tree/load.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('Kaltstart liest aus dem Cache — sonst friert die Offline-Kopie ein', () => {
  // `fresh` umgeht den SW-Cache und FUELLT ihn nicht. Waere jeder Read fresh,
  // bliebe die Offline-Kopie auf dem Stand des allerersten Loads stehen.
  assert.equal(readsFresh({}), false);
  assert.equal(readsFresh(), false);
  assert.equal(readsFresh({ source: undefined }), false);
});

test('Ereignis-getriggerte Reloads lesen frisch', () => {
  // `login` gehoert aus demselben Grund dazu: nach einer Anmeldung kann der
  // Cache einer beliebig alten oder fremden Sitzung gehoeren, und ein Bust KANN
  // im Browser nicht gelaufen sein — der Griff, der die Caches leert, haengt am
  // Logout-Link IN der App (eine abgelaufene Session kommt dort nie vorbei).
  // Erste Wahl bleibt, den Cache zu leeren (boot/session-change.js); dieser
  // Quellwert ist der Rueckfall, wenn kein SW erreichbar ist.
  for (const source of ['bookSwitch', 'wake', 'job', 'login']) {
    assert.equal(readsFresh({ source }), true, `${source} muss frisch lesen`);
  }
});

test('Ein explizites fresh:true schlaegt die Quelle', () => {
  assert.equal(readsFresh({ fresh: true }), true);
  assert.equal(readsFresh({ fresh: true, source: 'manual' }), true);
  // Kein truthy-Vergleich: nur ein echtes `true` zaehlt.
  assert.equal(readsFresh({ fresh: 1 }), false);
});

test('Der Wake-Refresh gibt beiden Reads die Quelle mit', () => {
  // Ohne `source: 'wake'` an BEIDEN Aufrufen laeuft _refreshAfterWake ins Leere:
  // die Funktion existiert genau dafuer, den Stand nach Sleep/Wake zu erneuern,
  // und beantwortete sich sonst selbst aus dem Cache.
  const src = fs.readFileSync(path.join(ROOT, 'public/js/app/app-view/bookscope.js'), 'utf8');
  const wake = src.slice(src.indexOf('async _refreshAfterWake'));
  assert.match(wake, /loadBooks\(\{ source: 'wake' \}\)/,
    'loadBooks im Wake-Pfad ohne source=wake → Buchliste bleibt stale.');
  assert.match(wake, /loadPages\(\{ source: 'wake' \}\)/,
    'loadPages im Wake-Pfad ohne source=wake → Baum bleibt stale.');
});

test('loadBooks reicht seine Quelle an loadPages weiter', () => {
  // Sonst liest `loadBooks({ source })` die Buchliste frisch und den Baum
  // trotzdem aus dem Cache — die halbe Antwort auf die gestellte Frage, und
  // genau die Haelfte, in der die Seiten stehen. Der Wake-Pfad ist bewusst
  // ausgenommen (`skipLoadPages`) und ruft loadPages selbst.
  const src = fs.readFileSync(path.join(ROOT, 'public/js/book/tree/load.js'), 'utf8');
  const fn = src.slice(src.indexOf('async loadBooks('), src.indexOf('bookComboOptions('));
  assert.match(fn, /loadPages\(pageOpts\)/,
    'loadBooks ruft loadPages ohne weitergereichte Optionen → Baum bleibt stale.');
  assert.match(fn, /opts\.source \? \{ source: opts\.source \}/,
    'Quelle wird nicht durchgereicht.');
});
