// Alpine.store('shell') — App-Meta-/Shell-State: Laufzeit-Rahmen der App
// (Boot-Gate, PWA-Update, Theme, Locale/Region/Zeitzone, App-Name/-Version,
// Plattform, Prompt-Config). Vorher flach in der Root-God-State; jetzt eine
// schmale, benannte Store-Oberfläche. Der Store-Name liefert den Namespace,
// darum tragen die Keys kein `shell`-Präfix (Zugriff via `$store.shell.uiLocale`).
//
// Kein Root-Proxy-Spiegel (wie nav/session/tts/collab/jobs): Konsumenten greifen
// direkt zu — in den Root gespreadete Module + Root-Methoden via
// `this.$store.shell.*`, Templates via `$store.shell.*`, Karten/pure Helper via
// `Alpine.store('shell').*`. Die zugehörigen Methoden (`setTheme`,
// `changeLocale`, `t`/`tRaw`, Boot-Sequenz) bleiben am Root.
//
// Bewusst NICHT hier: `focusGranularity`/`typewriterAnchor` — die liest der
// Editor-Kern über den editor-host-Vertrag (shared/editor-host.js) direkt von
// `window.__app` bzw. dem injizierten Standalone-Host (Mac-Client), nicht über
// einen Store; sie bleiben am Root. Ebenso die internen Lazy-Caches
// (`_usersByEmail*`, `_abortCtrl`).
//
// Feld-Bedeutung:
//   appReady        — SSoT für „Boot komplett" (Ende von init()). Reveal-Gate.
//   updateAvailable — neuer Service-Worker wartet; Banner bietet Reload an.
//   bossScreenActive— Chef-Taste (F9 im Seiten-Editor): schwarzer Vollbild-Vorhang.
//   themePref       — Theme-Wahl ('auto'|'light'|'dark'), in localStorage gespiegelt.
//   uiLocale        — UI-Sprache ('de'|'en'); Quelle für t()/tRaw() + Date-Locale.
//   defaultRegion   — Default-Region (Geocoding/Locale-Defaults).
//   appTimezone     — App-weite Zeitzone (/config → app_settings.app.timezone);
//                   Basis für tzOpts() + alle Date-Display-Formatter.
//   appName         — App-Name (/config → app_settings.app.name); <title>, Header,
//                   Locale-Platzhalter `{appName}`.
//   appVersion      — App-Version (/config → VERSION); Anzeige in den UserSettings.
//   changelogLatest — neueste Version mit Release-Notizen (/config → changelog/).
//   changelogSeen   — vom User zuletzt quittierter Changelog-Stand ('' = nie).
//                   changelogLatest > changelogSeen ⇒ Neu-Punkt am Hilfe-Knopf.
//   isMac           — Plattform-Detect für Tasten-Hints (⌘ vs. Ctrl).
//   promptConfig    — Prompt-Config-Rohdaten (/config); Quelle für configurePrompts().

export function registerShellStore() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.store('shell', {
    appReady: false,
    updateAvailable: false,
    bossScreenActive: false,
    themePref: 'auto',
    uiLocale: '',
    defaultRegion: '',
    appTimezone: 'Europe/Zurich',
    appName: 'Schreibwerkstatt',
    appVersion: '',
    changelogLatest: '',
    changelogSeen: '',
    isMac: false,
    promptConfig: {},
  });
}
