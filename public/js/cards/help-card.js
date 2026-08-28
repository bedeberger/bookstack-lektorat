// Alpine.data('helpCard') — Hilfe & Funktionen: zwei Reiter.
//
//   „Funktionen"   — statischer Funktionsueberblick fuer den Einstieg. Inhalt
//                    sind die Feature-Bloecke der Landing-Page (i18n-Keys
//                    `landing.featNTitle/Desc`) — SSoT, damit oeffentliche
//                    Landing und In-App-Hilfe nicht auseinanderdriften.
//   „Neuigkeiten"  — Release-Notizen aus `changelog/` (GET /changelog), neueste
//                    Version zuerst. Lazy: erst beim ersten Oeffnen des Reiters
//                    geholt, nicht beim Mount der Karte.
//
// Buch-unabhaengig (wie Suche/Meine-Statistik), `showHelpCard` +
// `toggleHelpCard` leben im Root (generiert aus EXCLUSIVE_CARDS). Darum auch
// kein `setupCardLifecycle`: der Helper ist fuer Buch-skopierte Karten
// (book:changed/view:reset/card:refresh) — hier gibt es nichts zu resetten.
//
// Neu-Punkt: `$store.shell.changelogLatest > changelogSeen` (beides aus
// /config) traegt den Achtungs-Punkt am Hilfe-Knopf im Header. Das Oeffnen des
// Reiters quittiert (POST /changelog/seen) und aktualisiert den Store lokal
// mit — ohne das bliebe der Punkt bis zum naechsten Reload stehen.

import { tzOpts } from '../utils.js';

// Wiederverwendung der Landing-Feature-Texte (de.json/en.json). Reihenfolge =
// Anzeige-Reihenfolge. Neues Landing-Feature → hier eine Zahl ergaenzen.
const HELP_FEATURES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27].map(n => ({
  titleKey: `landing.feat${n}Title`,
  descKey: `landing.feat${n}Desc`,
}));

/** Semver-Vergleich; ein leerer/ungueltiger Stand gilt als „aelter als alles".
 *  Spiegel von routes/changelog.js#_cmp — die Frage „gibt es Neues?" wird auf
 *  beiden Seiten gestellt (Punkt im Frontend, Nur-vorwaerts-Quittung im Server). */
export function cmpVersion(a, b) {
  const pa = String(a || '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  const pb = String(b || '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!pa) return pb ? -1 : 0;
  if (!pb) return 1;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Gibt es ungelesene Release-Notizen? Liest den shell-Store, damit Header-Punkt
 *  und Karte dieselbe Frage stellen. */
export function hasUnreadChangelog(shell) {
  const latest = shell?.changelogLatest || '';
  if (!latest) return false;
  return cmpVersion(latest, shell?.changelogSeen || '') > 0;
}

export function registerHelpCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('helpCard', () => ({
    helpFeatures: HELP_FEATURES,

    // Aktiver Reiter (SSoT; die `tabs`-Komponente haengt via x-modelable dran).
    helpTab: 'features',
    changelogReleases: [],
    changelogLoading: false,
    changelogError: '',
    _changelogLoaded: false,
    // Changelog-Stand beim Oeffnen der Karte. Wird beim Quittieren NICHT
    // mitgezogen: die „Neu"-Plakette soll waehrend der Sitzung stehen bleiben,
    // in der der User die Notizen zum ersten Mal liest — sonst verschwindet sie
    // im selben Tick, in dem er sie sieht.
    _changelogSeenAtOpen: '',

    init() {
      this._changelogSeenAtOpen = window.Alpine.store('shell')?.changelogSeen || '';
      // Wer einen Neu-Punkt sieht und auf „?" klickt, meint die Neuigkeiten —
      // nicht den Funktionsueberblick, den er schon kennt.
      if (hasUnreadChangelog(window.Alpine.store('shell'))) this.helpTab = 'changelog';
      // Mount und Reiter-Wahl liegen im selben Tick; das Laden haengt darum am
      // Watcher statt an einem zweiten Aufruf hier.
      this.$watch('helpTab', (v) => { if (v === 'changelog') this.onChangelogTab(); });
      if (this.helpTab === 'changelog') this.onChangelogTab();
    },

    /** Reiter „Neuigkeiten" ist aktiv: einmal laden, dann quittieren. */
    onChangelogTab() {
      this.loadChangelog();
      this.markChangelogSeen();
    },

    async loadChangelog() {
      if (this._changelogLoaded || this.changelogLoading) return;
      this.changelogLoading = true;
      this.changelogError = '';
      try {
        const r = await fetch('/changelog', { credentials: 'same-origin' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        this.changelogReleases = Array.isArray(data?.releases) ? data.releases : [];
        this._changelogLoaded = true;
      } catch (_) {
        this.changelogError = window.__app.t('changelog.loadError');
      } finally {
        this.changelogLoading = false;
      }
    },

    /** Quittieren — Store zuerst, damit der Punkt sofort verschwindet; ein
     *  gescheiterter POST laesst ihn beim naechsten Boot wiederkommen (der
     *  Server ist die Wahrheit), was besser ist als ein haengender Punkt. */
    async markChangelogSeen() {
      const shell = window.Alpine.store('shell');
      const latest = shell?.changelogLatest || '';
      if (!latest || !hasUnreadChangelog(shell)) return;
      shell.changelogSeen = latest;
      try {
        await fetch('/changelog/seen', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ version: latest }),
        });
      } catch (_) { /* non-fatal: naechster Boot holt den Stand vom Server */ }
    },

    /** Eintragstext in der UI-Sprache des Betrachters (de = Fallback). */
    changelogText(entry) {
      const loc = window.Alpine.store('shell')?.uiLocale || 'de';
      return (loc === 'en' ? entry?.en : entry?.de) || entry?.de || '';
    },

    /** Release-Datum (YYYY-MM-DD) in der App-Zeitzone/Locale. */
    changelogDate(iso) {
      if (!iso) return '';
      const d = new Date(iso + 'T12:00:00Z');
      if (Number.isNaN(d.getTime())) return iso;
      const loc = window.Alpine.store('shell')?.uiLocale === 'en' ? 'en-US' : 'de-CH';
      return d.toLocaleDateString(loc, tzOpts({ year: 'numeric', month: '2-digit', day: '2-digit' }));
    },

    /** War dieses Release beim Oeffnen der Karte noch ungelesen? Plakette am
     *  Versions-Kopf, damit der Neu-Punkt am Knopf ein Ziel in der Liste hat. */
    isNewRelease(version) {
      return cmpVersion(version, this._changelogSeenAtOpen) > 0;
    },
  }));
}
