// Theme vor erstem Paint setzen (FOUC-Schutz). Gespeicherte Präferenz:
// 'auto' (folgt System), 'light', 'dark'. Auflösung → data-theme-Attribut.
// Externe Datei statt Inline-Script, damit CSP ohne 'unsafe-inline' auskommt.
(function () {
  var stored = null;
  try { stored = localStorage.getItem('theme'); } catch (e) {}
  var pref = (stored === 'light' || stored === 'dark' || stored === 'auto') ? stored : 'auto';
  var resolved = pref === 'auto'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : pref;
  document.documentElement.setAttribute('data-theme', resolved);
  window.__themePref = pref;
})();
