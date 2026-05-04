// Plausible-Bootstrap (self-hosted Instanz). Nur auf Produktions-Hosts
// (kein localhost/.local). Externe Datei statt Inline-Script, damit CSP
// ohne 'unsafe-inline' auskommt.
(function () {
  var h = location.hostname;
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.local')) return;
  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://analytics.david-berger.ch/js/pa-88MHJ1lIXYZYeHM5hVZIA.js';
  document.head.appendChild(s);
  window.plausible = window.plausible || function () { (plausible.q = plausible.q || []).push(arguments); };
  plausible.init = plausible.init || function (i) { plausible.o = i || {}; };
  plausible.init({ hashBasedRouting: true });
})();
