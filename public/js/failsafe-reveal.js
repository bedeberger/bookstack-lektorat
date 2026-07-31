// Failsafe-Reveal + Boot-Watchdog: löst das data-app-loading-Gate notfalls
// auch ohne erfolgreichen Alpine-Boot. Scheitert ein SW-Reload offline am
// frisch geleerten Modul-Cache, bricht der ESM-Import von app.js ab, init()
// entfernt das Attribut nie → Body bliebe unsichtbar (schwarz im
// Dark-Theme). Script-Load-Fehler (capture) + Timeout-Backstop geben dem
// User stattdessen die gecachte Shell inkl. Offline-Banner.
//
// Boot-Watchdog: bricht ein Modul-Fetch der app.js-Kaskade ab, ist KEINE
// Alpine-Komponente registriert (window.__app fehlt) und jede x-data-Expression
// wirft "X is not defined". Das ist transient (Deploy-/SW-Übergang, Netz-Blip)
// und heilt beim Reload. Darum: bei Boot-Script-Fehler genau EINMAL neu laden
// (sessionStorage-Guard gegen Loop). app.js#init() löscht das Flag nach
// erfolgreichem Boot — ein späterer Lazy-Load-Fehler löst dann keinen Reload aus.
//
// Externe Datei statt Inline-Script, damit CSP ohne 'unsafe-inline' auskommt.
// Klassisches Script (kein module/defer), läuft unabhängig vom ESM-Graphen.
(function () {
  var reveal = function () { document.documentElement.removeAttribute('data-app-loading'); };
  var RELOAD_KEY = 'bootReloadDone';
  var HEAL_KEY = 'bootHealDone';
  setTimeout(reveal, 8000);

  // Boot-Heal-Watchdog: der Reload-Pfad oben hängt an einem Script-LADEfehler.
  // Es gibt aber einen Boot-Ausfall ohne jeden Ladefehler — eine
  // Generations-Inkohärenz: das Markup der Shell stammt aus einer anderen
  // Generation als die (fehlerfrei geladenen) JS-Module, sodass jede
  // x-data-Expression auf Stores/Karten zeigt, die das geladene app.js nie
  // registriert hat. Dann bleibt window.__app aus, und alle regulären
  // Heilungswege sind tot: der Build-Guard (app-init.js) läuft in Alpines
  // init(), das Update-Banner braucht Alpine, und der SW liefert die Shell
  // cache-only weiter — auch ein Hard-Reload landet wieder dort.
  //
  // Darum hier hart heilen: Shell-Caches wegwerfen + SW abmelden + neu laden,
  // damit der nächste Load garantiert eine kohärente Generation vom Netz zieht.
  // Genau EINMAL pro Session (sessionStorage-Guard) und nur online — offline
  // wäre nach dem Cache-Wurf gar nichts mehr ladbar. app.js#init() löscht das
  // Flag nach erfolgreichem Boot.
  setTimeout(function () {
    if (window.__app) return;
    var alreadyHealed = false;
    try { alreadyHealed = !!sessionStorage.getItem(HEAL_KEY); } catch (_) {}
    if (alreadyHealed || navigator.onLine === false) { reveal(); return; }
    try { sessionStorage.setItem(HEAL_KEY, '1'); } catch (_) {}
    var done = function () { location.reload(); };
    var clearCaches = window.caches
      ? caches.keys().then(function (keys) {
          return Promise.all(keys.filter(function (k) {
            return k.indexOf('schreibwerkstatt-shell-') === 0;
          }).map(function (k) { return caches.delete(k); }));
        }).catch(function () {})
      : Promise.resolve();
    clearCaches.then(function () {
      if (!navigator.serviceWorker) return null;
      return navigator.serviceWorker.getRegistrations()
        .then(function (regs) {
          return Promise.all(regs.map(function (r) { return r.unregister(); }));
        }).catch(function () {});
    }).then(done, done);
  }, 10000);
  window.addEventListener('error', function (e) {
    if (!(e && e.target && e.target.tagName === 'SCRIPT')) return;
    // Boot noch nicht erfolgt? → einmaliger Reload-Versuch gegen transiente
    // Fetch-Fehler. Beim zweiten Fehlschlag (Flag gesetzt) nur enthüllen.
    var alreadyTried = false;
    try { alreadyTried = !!sessionStorage.getItem(RELOAD_KEY); } catch (_) {}
    if (!window.__app && !alreadyTried) {
      try { sessionStorage.setItem(RELOAD_KEY, '1'); } catch (_) {}
      location.reload();
      return;
    }
    reveal();
  }, true);
})();
