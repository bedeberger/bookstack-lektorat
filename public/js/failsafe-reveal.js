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
//
// Boot-Telemetrie: die Heilung allein macht den Ausfall unsichtbar. Im Log
// landen dann nur die Folgefehler jeder x-data-Expression ("X is not defined"),
// nie der Auslöser. Darum meldet dieses Script den Boot-Ausfall selbst — es ist
// klassisch und läuft auch dann, wenn der ESM-Graph tot ist. Genau deshalb kann
// die Meldung NICHT im Graphen sitzen; das gilt auch für 'shell-incoherent',
// dessen regulärer Empfänger (app/boot/sw-register.js) im Ausfall mit ausfällt.
// Hier wird nur GEMELDET, nicht geheilt — das Heilen bleibt, wo es steht.
(function () {
  var reveal = function () { document.documentElement.removeAttribute('data-app-loading'); };
  var RELOAD_KEY = 'bootReloadDone';
  var HEAL_KEY = 'bootHealDone';
  setTimeout(reveal, 8000);

  // Umgebungs-Fingerabdruck: ohne ihn ist ein Boot-Ausfall im Log nicht
  // einzuordnen (Netz-Blip vs. Cache-Eviction vs. Generations-Skew).
  // `ready`/`res`/`t` trennen die zwei Lagen, die im Report sonst identisch
  // aussehen: ein toter Modul-Graph (readyState 'complete', aber keine
  // Registrierung → echter Fehler, danebenliegende 'error'-Reports lesen) und
  // ein bloss langsamer Load (noch 'loading'/'interactive', res waechst → nur
  // Latenz). Ohne diese Unterscheidung ist jeder Boot-Ausfall im Log geraten.
  function bootEnv() {
    var sw = 'n/a';
    try {
      if (navigator.serviceWorker) {
        sw = navigator.serviceWorker.controller ? 'controlled' : 'uncontrolled';
      }
    } catch (_) {}
    var res = '?';
    try {
      res = performance.getEntriesByType('resource').filter(function (r) {
        return r.name.indexOf('.js') > 0;
      }).length;
    } catch (_) {}
    return 'online=' + (navigator.onLine !== false)
      + ' sw=' + sw
      + ' ready=' + document.readyState
      + ' js=' + res
      + ' t=' + Math.round(performance.now()) + 'ms'
      + ' build=' + (window.__SHELL_BUILD || '?');
  }

  // Report ueber den gemeinsamen Reporter aus client-error.js (Dedup/Throttle/
  // keepalive dort). Fehlt er (eigener Ladefehler), wird still verzichtet —
  // Telemetrie darf den Heilungspfad nie aufhalten.
  var bootReports = 0;
  function bootReport(message, source) {
    if (bootReports >= 5) return;   // eigener Deckel: Eviction kann viele Pfade treffen
    bootReports++;
    try {
      if (typeof window.__reportClientError !== 'function') return;
      window.__reportClientError({
        kind: 'boot',
        message: message + ' [' + bootEnv() + ']',
        stack: null,
        source: source || null,
        line: null,
        col: null,
        pageUrl: location.href,
      });
    } catch (_) {}
  }

  // Der SW meldet eine Cache-Luecke (Einzel-Eviction, v.a. iOS). Geheilt wird
  // das in app/boot/sw-register.js — nur eben nicht, wenn der Graph gar nicht
  // erst geladen hat. Hier also ausschliesslich protokollieren.
  try {
    if (navigator.serviceWorker) {
      navigator.serviceWorker.addEventListener('message', function (e) {
        if (e && e.data && e.data.type === 'shell-incoherent') {
          bootReport('Shell-Inkohaerenz: Cache-Miss auf Manifest-Asset', e.data.path || null);
        }
      });
    }
  } catch (_) {}

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
  //
  // ZWEI Vorbedingungen, ohne die die Heilung nicht heilt, sondern schadet —
  // beide sind teuer erkauft, weil ihr Fehlen sich selbst reproduziert:
  //  1. `readyState === 'complete'`. Laeuft der Load noch, ist das kein Ausfall,
  //     sondern Latenz — die Shell zieht ~200 Module. Die Heilung wirft dann
  //     genau den Cache weg, der den naechsten Load schnell machen wuerde, und
  //     der Folge-Load ist wieder kalt: derselbe Watchdog feuert erneut.
  //     Darum einmalig Nachfrist statt Heilung.
  //  2. Ein Service-Worker kontrolliert die Seite. Die Heilung repariert genau
  //     EINEN Fall — eine Generations-Inkohaerenz, bei der der SW Shell-Markup
  //     und Module aus verschiedenen Generationen ausliefert. Ohne Controller
  //     kommt nichts aus dem SW-Cache, Markup und Module stammen zwangslaeufig
  //     aus demselben Deploy, ein Skew ist ausgeschlossen. Cache-Wurf und
  //     Abmeldung koennen dort nichts reparieren, kosten aber den Cache und die
  //     Registrierung — und die Neu-Registrierung sitzt in app.js, also im Boot,
  //     der gerade scheitert. Ein Fehlgriff laesst den User dauerhaft
  //     unkontrolliert und kalt zurueck.
  var HEAL_AFTER_MS = 10000;
  var GRACE_MS = 10000;
  function bootWatchdog(isRetry) {
    if (window.__app) return;
    var secs = Math.round(performance.now() / 1000);
    if (!isRetry && document.readyState !== 'complete') {
      setTimeout(function () { bootWatchdog(true); }, GRACE_MS);
      return;
    }
    var alreadyHealed = false;
    try { alreadyHealed = !!sessionStorage.getItem(HEAL_KEY); } catch (_) {}
    var controlled = false;
    try { controlled = !!(navigator.serviceWorker && navigator.serviceWorker.controller); } catch (_) {}
    if (alreadyHealed || navigator.onLine === false || !controlled) {
      var grund = alreadyHealed ? 'bereits geheilt'
        : navigator.onLine === false ? 'offline'
        : 'ohne Service-Worker, kein Generations-Skew moeglich';
      bootReport('Boot-Ausfall: keine Alpine-Registrierung nach ' + secs + 's, Heilung uebersprungen ('
        + grund + ')');
      reveal();
      return;
    }
    bootReport('Boot-Ausfall: keine Alpine-Registrierung nach ' + secs + 's, harte Heilung laeuft');
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
  }
  setTimeout(bootWatchdog, HEAL_AFTER_MS);
  window.addEventListener('error', function (e) {
    if (!(e && e.target && e.target.tagName === 'SCRIPT')) return;
    // Boot noch nicht erfolgt? → einmaliger Reload-Versuch gegen transiente
    // Fetch-Fehler. Beim zweiten Fehlschlag (Flag gesetzt) nur enthüllen.
    var alreadyTried = false;
    try { alreadyTried = !!sessionStorage.getItem(RELOAD_KEY); } catch (_) {}
    if (!window.__app && !alreadyTried) {
      // Vor dem Reload melden: der Report laeuft mit keepalive und ueberlebt
      // die Navigation, sonst ginge genau der Auslöser mit dem Reload verloren.
      bootReport('Boot-Ausfall: Script-Ladefehler vor Alpine-Boot, Reload-Versuch',
        (e.target.src || e.target.href || '') + '');
      try { sessionStorage.setItem(RELOAD_KEY, '1'); } catch (_) {}
      location.reload();
      return;
    }
    if (!window.__app) {
      bootReport('Boot-Ausfall: Script-Ladefehler auch nach Reload',
        (e.target.src || e.target.href || '') + '');
    }
    reveal();
  }, true);
})();
