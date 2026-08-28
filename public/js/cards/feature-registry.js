// Single Source of Truth für Karten-Features + globale Aktionen + Provider-Hooks.
// Wird von Quick-Pills, Command-Palette und Tracking-Hook gelesen.
// Karten-Keys synchron mit der Allowlist in routes/usage.js — bei Erweiterung
// beide Stellen anpassen.
//
// Karten (`kind: 'toggle'`): öffnen/schliessen eine Hauptkarte.
//   `flag`   – Name des Show-State-Flags am Root.
//   `toggle` – Methodenname am Root, der die Karte ein-/ausschaltet.
//   `requiresPages` – disabled, wenn Buch leer.
//   `requiresBook`  – disabled, wenn kein Buch gewählt.
//   `minRole`       – Buch-Rolle, ab der die Karte sichtbar ist.
//                     Hierarchie: viewer < lektor < editor < owner. Pflichtfeld.
//   `requiresBuchtyp` – Karte erscheint nur bei diesem Buchtyp (z.B. 'tagebuch').
//                     Gate greift in Palette (featuresVisibleFor) + isFeatureAvailable.
//   `hiddenForBuchtyp` – Array von Buchtypen, bei denen die Karte VERSCHWINDET.
//                     Gegenstueck zu `requiresBuchtyp`, fuer Karten, die es
//                     ueberall ausser in einem Werktyp gibt. Anlass: ein
//                     journalistisches Ressort hat keine Figuren, keinen Plot,
//                     keine Motive und keinen Buchsatz — diese Karten dort
//                     anzubieten liesse das Produkt wie ein Romanwerkzeug mit
//                     Journalismus-Aufkleber wirken. Gate greift in Palette
//                     (featuresVisibleFor), in isFeatureAvailable UND im
//                     generischen Toggle (_toggleCardGeneric), damit auch ein
//                     Deep-Link (#plot) die Karte nicht oeffnet.
//   `dependsOnKomplett` – true: Karte konsumiert Komplettanalyse-Output
//                     (Figuren/Orte/Szenen/Ereignisse/Fakten/Soziogramm/Kontinuität).
//                     Palette zeigt dafür ein Hinweis-Badge.
//   `requiresCloudModel` – true: Karte erscheint nur, wenn der effektive Provider der
//                     KLASSE `cloud` angehört (Kontinuität/Erzählprofil — ihre
//                     Qualitätsstufen brauchen ein fähiges Modell, aber keine
//                     Anthropic-API-Fähigkeit; ein gehostetes Frontier-Modell über
//                     openai-compat mit `cloud`-Schalter zählt dazu). Gate greift in
//                     Palette (featuresVisibleFor + isFeatureAvailable) und im
//                     generischen Toggle (_toggleCardGeneric). ctx.cloudModelEffective
//                     liefert den Wert (aus $store.config.effectiveProviderClass).
//
// Aktionen (`kind: 'action'`): einmalige Befehle (Theme wechseln, Logout …).
//   `run(root)` – wird mit Root als Argument aufgerufen.
//
// `aliases` (optional): zusätzliche Suchbegriffe (Synonyme, EN-Übersetzungen).

// Buchtypen, in denen die Komplettanalyse gar nicht angeboten wird. Sie
// produziert ausschliesslich narrative Ableitungen (Figuren, Soziogramm, Orte,
// Songs, Weltfakten, Szenen, Zeitstrahl, Kontinuitaet, Erzaehlprofil) — und
// genau deren Karten sind im Ressort via `hiddenForBuchtyp` schon weg. Ein Lauf
// haette dort kein Ziel, wuerde aber Zeit und Tokens kosten. SSoT fuer die drei
// Einstiegspunkte: Header-Button (komplett-status.html), Palette-Aktion
// (`action.komplett`) und das CTA-Tile der Buch-Uebersicht.
export const KOMPLETT_HIDDEN_BUCHTYPEN = ['journalismus'];

export function komplettHiddenFor(buchtyp) {
  return !!buchtyp && KOMPLETT_HIDDEN_BUCHTYPEN.includes(buchtyp);
}

// Buchtypen mit redaktionellem Apparat (Textsorte, Titel-Werkstatt,
// Redaktions-Status). Frontend-Spiegel von JOURNALISTIC in lib/buchtyp.js —
// gegated durch tests/unit/headline-drift.test.mjs. Zwei Typen mit Absicht: ein
// Blog laeuft durch dieselbe Schleife aus Dachzeile/Titel/Lead, nur mit
// WordPress statt Druck als Ziel.
export const JOURNALISTIC_BUCHTYPEN = ['journalismus', 'blog'];

export function isJournalisticBuchtyp(buchtyp) {
  return !!buchtyp && JOURNALISTIC_BUCHTYPEN.includes(buchtyp);
}

export const FEATURES = [
  // Übersicht — Viewer darf read-only Buch-Overview sehen.
  { key: 'overview',       kind: 'toggle', group: 'tools',  labelKey: 'tile.overview',       descKey: 'tile.overview.desc',       flag: 'showBookOverviewCard',   toggle: 'toggleBookOverviewCard',   requiresBook: true, minRole: 'viewer',
    aliases: ['uebersicht','overview','dashboard','home','start','startseite','landing'] },
  // Bewertung / Analyse-Cards: editor+ (Stats- und Lektorat-Auswertung).
  { key: 'review',         kind: 'toggle', group: 'review', labelKey: 'tile.review',         descKey: 'tile.review.desc',         flag: 'showBookReviewCard',     toggle: 'toggleBookReviewCard',     requiresBook: true, minRole: 'editor',
    aliases: ['bewertung','rating','note','stars','sterne','feedback'] },
  { key: 'stil',           kind: 'toggle', group: 'review', labelKey: 'tile.stil',           descKey: 'tile.stil.desc',           flag: 'showStilCard',           toggle: 'toggleStilCard',           requiresBook: true, minRole: 'editor',
    aliases: ['style','heatmap','passiv','fuellwoerter','filler','readability','lesbarkeit','metrik'] },
  { key: 'fehlerHeatmap',  kind: 'toggle', group: 'review', labelKey: 'tile.fehlerHeatmap',  descKey: 'tile.fehlerHeatmap.desc',  flag: 'showFehlerHeatmapCard',  toggle: 'toggleFehlerHeatmapCard',  requiresBook: true, minRole: 'editor',
    aliases: ['errors','heatmap','findings','lektorat','typo','tippfehler'] },
  { key: 'kontinuitaet',   kind: 'toggle', group: 'review', labelKey: 'tile.kontinuitaet',   descKey: 'tile.kontinuitaet.desc',   flag: 'showKontinuitaetCard',   toggle: 'toggleKontinuitaetCard',   requiresBook: true, minRole: 'editor', dependsOnKomplett: true, requiresCloudModel: true, hiddenForBuchtyp: ['journalismus'],
    aliases: ['continuity','widerspruch','plot-hole','contradiction','consistency'] },
  { key: 'redundanz',      kind: 'toggle', group: 'review', labelKey: 'tile.redundanz',      descKey: 'tile.redundanz.desc',      flag: 'showRedundanzCard',      toggle: 'toggleRedundanzCard',      requiresBook: true, minRole: 'editor',
    aliases: ['redundanz','redundancy','doppelung','doppelungen','duplicate','duplikate','wiederholung','wiederholungen','repetition','dupe','semantik','similar'] },
  { key: 'buchlandkarte',  kind: 'toggle', group: 'review', labelKey: 'tile.buchlandkarte',  descKey: 'tile.buchlandkarte.desc',  flag: 'showBuchlandkarteCard',  toggle: 'toggleBuchlandkarteCard',  requiresBook: true, minRole: 'editor',
    aliases: ['buchlandkarte','landkarte','karte','map','bookmap','projektion','projection','pca','cluster','wolke','scatter','streuung','kohäsion','kohaesion','cohesion','ausreisser','outlier','themenkarte','semantik'] },
  { key: 'wortschatz',     kind: 'toggle', group: 'review', labelKey: 'tile.wortschatz',     descKey: 'tile.wortschatz.desc',     flag: 'showWortschatzCard',     toggle: 'toggleWortschatzCard',     requiresBook: true, minRole: 'editor',
    aliases: ['wortschatz','vocabulary','lexik','lexical','diversitaet','diversity','mattr','mtld','ttr','hapax','heaps','yule','lieblingswort','lieblingswoerter','phrasen','wendung','wendungen','tic','tics','ngram','kollokation','keyness','stilometrie','stylometry'] },
  { key: 'erzaehlprofil',  kind: 'toggle', group: 'review', labelKey: 'tile.erzaehlprofil',  descKey: 'tile.erzaehlprofil.desc',  flag: 'showErzaehlprofilCard',  toggle: 'toggleErzaehlprofilCard',  requiresBook: true, minRole: 'editor', dependsOnKomplett: true, requiresCloudModel: true, hiddenForBuchtyp: ['journalismus'],
    aliases: ['pov','perspektive','erzählperspektive','erzaehlperspektive','narration','pacing','spannungskurve','themen','motive','narrative','point of view','erzählprofil'] },
  // Tagebuch-Rückblick: nur bei Buchtyp 'tagebuch'. Rückwärtsgewandte KI-Verdichtung.
  { key: 'tagebuchRueckblick', kind: 'toggle', group: 'review', labelKey: 'tile.tagebuchRueckblick', descKey: 'tile.tagebuchRueckblick.desc', flag: 'showTagebuchRueckblickCard', toggle: 'toggleTagebuchRueckblickCard', requiresBook: true, minRole: 'editor', requiresBuchtyp: 'tagebuch',
    aliases: ['rückblick','rueckblick','retrospective','diary','tagebuch','jahresrückblick','monatsrückblick','review'] },
  // Struktur-Check: nur bei Buchtyp 'journalismus'. Prueft die FORM der Textsorte
  // (Lead, Aufbau, Gegenposition), nicht die Sprache — das macht das Lektorat.
  { key: 'struktur',       kind: 'toggle', group: 'review', labelKey: 'tile.struktur',       descKey: 'tile.struktur.desc',       flag: 'showStrukturCard',       toggle: 'toggleStrukturCard',       requiresBook: true, minRole: 'editor', requiresBuchtyp: 'journalismus',
    aliases: ['struktur','textsorte','textsorten','lead','vorspann','aufbau','nachricht','bericht','reportage','kommentar','glosse','interview','portraet','porträt','feature','rezension','w-fragen','pyramide','redaktion','journalismus','structure','genre'] },
  // Titel-Werkstatt: Dachzeile/Titel/Lead/Teaser als Metadata der Seite. Gilt
  // fuer beide publizistischen Buchtypen — ein Blog braucht denselben
  // Titelapparat wie ein Ressort, nur mit WordPress statt Druck als Ziel.
  { key: 'titelwerkstatt', kind: 'toggle', group: 'manuscript', labelKey: 'tile.titelwerkstatt', descKey: 'tile.titelwerkstatt.desc', flag: 'showTitelwerkstattCard', toggle: 'toggleTitelwerkstattCard', requiresBook: true, minRole: 'editor', requiresBuchtyp: JOURNALISTIC_BUCHTYPEN,
    aliases: ['titel','titelwerkstatt','dachzeile','ueberzeile','überzeile','kicker','lead','vorspann','teaser','anreisser','anreisser','schlagzeile','headline','seo','meta','varianten','zeichenlimit'] },
  // Welt & Plot — World-Cards: editor+ (für Viewer/Lektor nicht relevant).
  { key: 'figuren',        kind: 'toggle', group: 'world',  labelKey: 'tile.figuren',        descKey: 'tile.figuren.desc',        flag: 'showFiguresCard',        toggle: 'toggleFiguresCard',        requiresBook: true, minRole: 'editor', dependsOnKomplett: true, hiddenForBuchtyp: ['journalismus'],
    aliases: ['characters','personen','cast','protagonist','antagonist','soziogramm','graph'] },
  { key: 'werkstatt',      kind: 'toggle', group: 'world',  labelKey: 'tile.werkstatt',      descKey: 'tile.werkstatt.desc',      flag: 'showFigurWerkstattCard', toggle: 'toggleFigurWerkstattCard', requiresBook: true, minRole: 'editor', hiddenForBuchtyp: ['journalismus'],
    aliases: ['workshop','mindmap','draft','entwurf','brainstorm','character','figur','vorwaerts'] },
  { key: 'szenen',         kind: 'toggle', group: 'world',  labelKey: 'tile.szenen',         descKey: 'tile.szenen.desc',         flag: 'showSzenenCard',         toggle: 'toggleSzenenCard',         requiresBook: true, minRole: 'editor', dependsOnKomplett: true, hiddenForBuchtyp: ['journalismus'],
    aliases: ['scenes','beats','sequences','akt'] },
  { key: 'orte',           kind: 'toggle', group: 'world',  labelKey: 'tile.orte',           descKey: 'tile.orte.desc',           flag: 'showOrteCard',           toggle: 'toggleOrteCard',           requiresBook: true, minRole: 'editor', dependsOnKomplett: true, hiddenForBuchtyp: ['journalismus'],
    aliases: ['locations','schauplaetze','places','setting','welt','world'] },
  { key: 'songs',          kind: 'toggle', group: 'world',  labelKey: 'tile.songs',          descKey: 'tile.songs.desc',          flag: 'showSongsCard',          toggle: 'toggleSongsCard',          requiresBook: true, minRole: 'editor', dependsOnKomplett: true, hiddenForBuchtyp: ['journalismus'],
    aliases: ['musik','music','songs','musikstuecke','musikstücke','playlist','soundtrack','band','interpret','tracks'] },
  { key: 'ereignisse',     kind: 'toggle', group: 'world',  labelKey: 'tile.events',         descKey: 'tile.events.desc',         flag: 'showEreignisseCard',     toggle: 'toggleEreignisseCard',     requiresBook: true, minRole: 'editor', dependsOnKomplett: true, hiddenForBuchtyp: ['journalismus'],
    aliases: ['events','timeline','zeitstrahl','plot','chronologie'] },
  { key: 'plot',           kind: 'toggle', group: 'world',  labelKey: 'tile.plot',           descKey: 'tile.plot.desc',           flag: 'showPlotCard',           toggle: 'togglePlotCard',           requiresBook: true, minRole: 'editor', hiddenForBuchtyp: ['journalismus'],
    aliases: ['plot','handlung','beat','beat-board','board','akt','struktur','outline','dramaturgie','story','plotten','beats','skizze','wendepunkt'] },
  { key: 'motiv',          kind: 'toggle', group: 'world',  labelKey: 'tile.motiv',          descKey: 'tile.motiv.desc',          flag: 'showMotivCard',          toggle: 'toggleMotivCard',          requiresBook: true, minRole: 'editor', hiddenForBuchtyp: ['journalismus'],
    aliases: ['motiv','motive','thema','themen','theme','motif','leitmotiv','symbol','symbolik','konstellation','bildsprache','metapher'] },
  { key: 'weltfakten',     kind: 'toggle', group: 'world',  labelKey: 'tile.weltfakten',     descKey: 'tile.weltfakten.desc',     flag: 'showWorldFactsCard',     toggle: 'toggleWorldFactsCard',     requiresBook: true, minRole: 'editor', dependsOnKomplett: true, hiddenForBuchtyp: ['journalismus'],
    aliases: ['facts','fakten','weltregeln','worldbuilding','lore','magiesystem','rules','kanon','canon','regeln'] },
  { key: 'recherche',      kind: 'toggle', group: 'world',  labelKey: 'tile.recherche',      descKey: 'tile.recherche.desc',      flag: 'showRechercheCard',      toggle: 'toggleRechercheCard',      requiresBook: true, minRole: 'editor',
    aliases: ['research','wissen','knowledge','notizen','notes','quellen','sources','zitate','quotes','links','material','archiv','board'] },
  // Quellenverzeichnis: kuratierte Quellen + Fund-Index. minRole editor — die
  // Karte ist eine Verwaltungsoberflaeche (Anlegen/Bearbeiten/Loeschen), und
  // genau das gated der Server ab 'editor'. Dass `GET /sources` schon ab
  // 'viewer' antwortet, ist fuer die Leseansicht gedacht (sie muss den
  // Quellen-Marker aufloesen), nicht fuer diese Karte.
  { key: 'sources',        kind: 'toggle', group: 'world',  labelKey: 'tile.sources',        descKey: 'tile.sources.desc',        flag: 'showSourcesCard',        toggle: 'toggleSourcesCard',        requiresBook: true, minRole: 'editor',
    aliases: ['quellen','quellenverzeichnis','quellenangabe','quellennachweis','literatur','literaturverzeichnis','bibliografie','bibliographie','bibliography','sources','citation','zitieren','zitat','beleg','belege','apa','chicago','fussnote','isbn','doi'] },
  // Werkzeug
  { key: 'bookchat',       kind: 'toggle', group: 'tools',  labelKey: 'tile.bookchat',       descKey: 'tile.bookchat.desc',       flag: 'showBookChatCard',       toggle: 'toggleBookChatCard',       requiresPages: true, minRole: 'editor',
    aliases: ['ai','frage','question','rag','assistant'] },
  { key: 'stats',          kind: 'toggle', group: 'tools',  labelKey: 'tile.stats',          descKey: 'tile.stats.desc',          flag: 'showBookStatsCard',      toggle: 'toggleBookStatsCard',      requiresBook: true, minRole: 'editor',
    aliases: ['statistik','progress','wordcount','entwicklung','timeline'] },
  { key: 'bookSettings',   kind: 'toggle', group: 'tools',  labelKey: 'tile.bookSettings',   descKey: 'tile.bookSettings.desc',   flag: 'showBookSettingsCard',   toggle: 'toggleBookSettingsCard',   requiresBook: true, minRole: 'editor',
    aliases: ['settings','config','buchtyp','booktype','einstellungen','genre'] },
  { key: 'finetuneExport', kind: 'toggle', group: 'export', labelKey: 'tile.finetuneExport', descKey: 'tile.finetuneExport.desc', flag: 'showFinetuneExportCard', toggle: 'toggleFinetuneExportCard', requiresBook: true, minRole: 'editor',
    aliases: ['export','training','jsonl','llm','dataset','samples'] },
  { key: 'snapshots',      kind: 'toggle', group: 'manuscript', labelKey: 'tile.snapshots',      descKey: 'tile.snapshots.desc',      flag: 'showSnapshotsCard',      toggle: 'toggleSnapshotsCard',      requiresPages: true, minRole: 'editor',
    aliases: ['fassung','fassungen','version','versionen','meilenstein','milestone','snapshot','snapshots','manuskript','vergleich','diff','revision'] },
  // Export: viewer reicht (Lese-Zugang impliziert Export).
  { key: 'export',         kind: 'toggle', group: 'export', labelKey: 'tile.export',         descKey: 'tile.export.desc',         flag: 'showExportCard',         toggle: 'toggleExportCard',         requiresBook: true, minRole: 'viewer',
    aliases: ['download','pdf','epub','html','txt','markdown','md','herunterladen','speichern'] },
  { key: 'pdfExport',      kind: 'toggle', group: 'export', labelKey: 'tile.pdfExport',      descKey: 'tile.pdfExport.desc',      flag: 'showPdfExportCard',      toggle: 'togglePdfExportCard',      requiresBook: true, minRole: 'viewer', hiddenForBuchtyp: ['journalismus'],
    aliases: ['pdf','pdfa','custom','layout','schrift','font','cover','titelbild','print','druck'] },
  { key: 'epubExport',     kind: 'toggle', group: 'export', labelKey: 'tile.epubExport',     descKey: 'tile.epubExport.desc',     flag: 'showEpubExportCard',     toggle: 'toggleEpubExportCard',     requiresBook: true, minRole: 'viewer', hiddenForBuchtyp: ['journalismus'],
    aliases: ['epub','ebook','e-book','reader','reflow','kindle','blocksatz','toc','inhaltsverzeichnis'] },
  { key: 'docxExport',     kind: 'toggle', group: 'export', labelKey: 'tile.docxExport',     descKey: 'tile.docxExport.desc',     flag: 'showDocxExportCard',     toggle: 'toggleDocxExportCard',     requiresBook: true, minRole: 'viewer',
    aliases: ['word','docx','manuskript','manuscript','lektorat','verlag','normseite','doc','review','einreichen'] },
  { key: 'folderImport',   kind: 'toggle', group: 'manuscript', labelKey: 'tile.folderImport',   descKey: 'tile.folderImport.desc',   flag: 'showFolderImportCard',   toggle: 'toggleFolderImportCard',   minRole: 'editor',
    aliases: ['import','folder','ordner','tagebuch','diary','docx','odt','zip','word','openoffice'] },
  { key: 'bookOrganizer',  kind: 'toggle', group: 'manuscript', labelKey: 'tile.bookOrganizer',  descKey: 'tile.bookOrganizer.desc',  flag: 'showBookOrganizerCard', toggle: 'toggleBookOrganizerCard',  requiresBook: true, minRole: 'editor',
    aliases: ['organize','organisieren','sortieren','reorder','umordnen','verschieben','rename','umbenennen','delete','loeschen','create','anlegen','struktur','kapitel','chapter','seiten','pages'] },
  // Editor: viewer (read-only) / lektor (apply-only) / editor+ (frei).
  { key: 'bookEditor',     kind: 'toggle', group: 'manuscript', labelKey: 'tile.bookEditor',     descKey: 'tile.bookEditor.desc',     flag: 'showBookEditorCard',    toggle: 'toggleBookEditorCard',     requiresPages: true, minRole: 'viewer',
    aliases: ['bucheditor','book-editor','stream','endlos','endless','single-page','one-page','edit-all','alle-bearbeiten','volltext','full-text','suchen-ersetzen','search-replace','find-replace','suchen','ersetzen'] },
  // Volltextsuche. minRole viewer — Search filtert
  // serverseitig zusaetzlich nach book_access; jeder Auth-User darf suchen,
  // sieht aber nur eigene Buecher.
  { key: 'search',         kind: 'toggle', group: 'manuscript', labelKey: 'tile.search',         descKey: 'tile.search.desc',         flag: 'showSearchCard',        toggle: 'toggleSearchCard',         minRole: 'viewer',
    aliases: ['suche','search','volltext','fulltext','find','finden','fts','grep'] },
  { key: 'shareLinks',     kind: 'toggle', group: 'tools',  labelKey: 'tile.shareLinks',     descKey: 'tile.shareLinks.desc',     flag: 'showShareLinksCard',    toggle: 'toggleShareLinksCard',     requiresBook: true, minRole: 'editor',
    aliases: ['share','teilen','link','readonly','beta','feedback','public','offentlich','geteilt'] },
  // Hilfe — buch-unabhaengig, fuer jeden Auth-User. Funktionsueberblick fuer
  // den Einstieg (kein requiresBook/Pages, minRole viewer → immer sichtbar).
  { key: 'help',           kind: 'toggle', group: 'tools',  labelKey: 'tile.help',           descKey: 'tile.help.desc',           flag: 'showHelpCard',          toggle: 'toggleHelpCard',           minRole: 'viewer',
    aliases: ['hilfe','help','funktionen','features','anleitung','guide','einstieg','intro','ueberblick','overview','faq'] },
  // Erste Schritte — buch-unabhaengig, fuer jeden Auth-User. Fortschritts-
  // Checkliste fuer den Einstieg + Beispielbuch-Import (kein requiresBook).
  { key: 'onboarding',     kind: 'toggle', group: 'tools',  labelKey: 'tile.onboarding',     descKey: 'tile.onboarding.desc',     flag: 'showOnboardingCard',    toggle: 'toggleOnboardingCard',     minRole: 'viewer',
    aliases: ['onboarding','erste-schritte','einstieg','start','getting-started','tour','checkliste','beispielbuch','demo','einfuehrung','walkthrough'] },
];

// Globale Aktionen (kind:'action'). Eigene Sektion in der Palette.
// `run(root)` wird mit dem Root-Alpine-Proxy als Argument aufgerufen.
export const ACTIONS = [
  { key: 'action.theme.cycle',    kind: 'action', group: 'app', labelKey: 'palette.action.theme',     descKey: 'palette.action.theme.desc',
    aliases: ['dark','light','hell','dunkel','mode','farbe','color','design'],
    run: (root) => {
      const next = root.$store.shell.themePref === 'auto' ? 'light'
                 : root.$store.shell.themePref === 'light' ? 'dark'
                 : 'auto';
      root.setTheme(next);
    } },
  { key: 'action.locale.toggle',  kind: 'action', group: 'app', labelKey: 'palette.action.locale',    descKey: 'palette.action.locale.desc',
    aliases: ['language','sprache','english','deutsch','en','de','i18n'],
    run: (root) => {
      const next = root.$store.shell.uiLocale === 'de' ? 'en' : 'de';
      root.changeLocale(next);
    } },
  { key: 'action.shortcuts',      kind: 'action', group: 'app', labelKey: 'palette.action.shortcuts', descKey: 'palette.action.shortcuts.desc',
    aliases: ['help','hotkeys','tasten','keyboard','hilfe','shortcuts'],
    run: (root) => { root.toggleShortcutsOverlay(); } },
  { key: 'action.myStats',        kind: 'action', group: 'app', labelKey: 'mystats.title',           descKey: 'mystats.desc',
    aliases: ['statistik','stats','gesamt','zeichen','wörter','woerter','words','total','schreibstatistik','overview','profil'],
    run: (root) => { root.toggleMyStatsCard(); } },
  { key: 'action.myBooks',        kind: 'action', group: 'app', labelKey: 'mybooks.title',           descKey: 'mybooks.desc',
    aliases: ['buecher','bücher','books','regal','shelf','verwaltung','manage','pin','anheften','archiv','archive','archivieren','fertig','finished','uebersicht','übersicht','bibliothek','library'],
    run: (root) => { root.toggleMyBooksCard(); } },
  { key: 'action.closeAll',       kind: 'action', group: 'app', labelKey: 'palette.action.closeAll',  descKey: 'palette.action.closeAll.desc',
    aliases: ['esc','dismiss','reset','schliessen'],
    run: (root) => { root._closeOtherMainCards(null); root._maybeOpenBookOverview({ restoreLastPage: false }); } },
  { key: 'action.komplett',       kind: 'action', group: 'app', labelKey: 'palette.action.komplett',  descKey: 'palette.action.komplett.desc',
    requiresBook: true, hiddenForBuchtyp: KOMPLETT_HIDDEN_BUCHTYPEN,
    aliases: ['analyse','vollanalyse','reload','aktualisieren','refresh','komplett'],
    run: (root) => { root.alleAktualisieren(); } },
  { key: 'action.swReload',       kind: 'action', group: 'app', labelKey: 'palette.action.swReload',  descKey: 'palette.action.swReload.desc',
    aliases: ['cache','update','refresh','sw','service-worker','neu-laden'],
    run: () => {
      navigator.serviceWorker?.getRegistration?.().then(reg => reg?.unregister?.()).finally(() => location.reload(true));
    } },
  { key: 'action.logout',         kind: 'action', group: 'app', labelKey: 'palette.action.logout',    descKey: 'palette.action.logout.desc',
    aliases: ['signout','abmelden','exit'],
    run: async (root) => {
      // Caches via Root-logout-Pfad dropen, falls SW aktiv. Danach immer redirect.
      try { await root.logout({ preventDefault() {} }); } catch {}
      location.href = '/auth/logout';
    } },
];

// Alle Hauptkarten mit Exklusivitäts-Verhalten. Superset von FEATURES
// (enthält zusätzlich nicht-Palette-Karten wie kapitelReview und userSettings,
// die via Sidebar bzw. Avatar-Menu geöffnet werden, aber dieselbe „eine Karte
// gleichzeitig"-Regel folgen). Wird von `_closeOtherMainCards`, `resetView`,
// `_maybeOpenBookOverview` und vom generischen `_toggleCardGeneric` in
// [public/js/app/app-view/_shared.js](public/js/app/app-view/_shared.js)
// gelesen — neue Hauptkarte braucht nur einen Eintrag hier, die View-Logik
// bleibt drift-frei.
//
// Felder:
//   `key`     – Argument für `_closeOtherMainCards(keep)` + `card:refresh`-detail.name.
//   `flag`    – Show-State-Flag am Root.
//   `toggle`  – Methodenname am Root. `_toggleCardGeneric` generiert die Methode aus
//               diesem Eintrag (Alpine-spread-fähig), Aufrufer (Template, Hash-
//               Router, Palette) rufen sie wie eine handgeschriebene Methode.
//   `bespoke` – true: keine Generierung, die Methode lebt in einem anderen
//               Modul (z.B. kapitelReview, oder bewusst gesonderte Logik).
//   `onReclick` – 'close' (default) schliesst die Karte beim 2. Klick;
//                 'refresh' dispatcht `card:refresh` und lässt sie offen.
//   `refreshName` – Override für `card:refresh`-detail.name, falls die Sub-
//                Komponente einen anderen Listener-Namen verwendet als der
//                Karten-Key (z.B. key='figures' aber Sub hört auf 'figuren').
//                Default: `key`.
//   `requiresBook` – true: ohne `selectedBookId` öffnet die Karte nicht.
//   `loadDeps` – Pre-Open-Bedingungen: `{ method, skipIfNonEmpty }`. Wird
//                `this[method](selectedBookId)` aufgerufen, wenn
//                `this[skipIfNonEmpty]` leer ist. Wird nach `flag = true`
//                gestartet (Karte sichtbar, Daten laden im Hintergrund),
//                aber awaited — damit der Aufruf-Promise erst nach Daten resolve't.
//   `auditEvent` – Event-Name für `logAuditEvent` nach dem Öffnen (`book`-Detail).
//   `extraRefreshOnOpen` – belt-and-braces: nach Open zusätzlich einmalig
//                `card:refresh` dispatchen (für $watch-Race-Conditions).
//   `partial` – Name des HTML-Partials (ohne Endung), das die Karte hostet.
//                Wird vor `flag = true` lazy via `_ensurePartial` geladen.
//                Bespoke-Toggles ohne dieses Feld lazy-laden selbst.
export const EXCLUSIVE_CARDS = [
  { key: 'bookOverview',   flag: 'showBookOverviewCard',   toggle: 'toggleBookOverviewCard',   onReclick: 'refresh', requiresBook: true, partial: 'bookoverview' },
  { key: 'bookReview',     flag: 'showBookReviewCard',     toggle: 'toggleBookReviewCard',     onReclick: 'refresh', partial: 'buchreview' },
  { key: 'kapitelReview',  flag: 'showKapitelReviewCard',  toggle: 'toggleKapitelReviewCard',  bespoke: true, partial: 'kapitelreview' },
  { key: 'figures',        flag: 'showFiguresCard',        toggle: 'toggleFiguresCard',        onReclick: 'refresh', refreshName: 'figuren', partial: 'figuren', hiddenForBuchtyp: ['journalismus'] },
  { key: 'figurWerkstatt', flag: 'showFigurWerkstattCard', toggle: 'toggleFigurWerkstattCard', onReclick: 'refresh', requiresBook: true, extraRefreshOnOpen: true, partial: 'figur-werkstatt', hiddenForBuchtyp: ['journalismus'] },
  { key: 'szenen',         flag: 'showSzenenCard',         toggle: 'toggleSzenenCard',         onReclick: 'refresh', partial: 'szenen', hiddenForBuchtyp: ['journalismus'],
    loadDeps: [{ method: 'loadFiguren', skipIfNonEmpty: 'figuren' }, { method: 'loadOrte', skipIfNonEmpty: 'orte' }] },
  { key: 'ereignisse',     flag: 'showEreignisseCard',     toggle: 'toggleEreignisseCard',     onReclick: 'refresh', partial: 'ereignisse', hiddenForBuchtyp: ['journalismus'],
    loadDeps: [{ method: 'loadFiguren', skipIfNonEmpty: 'figuren' }] },
  { key: 'plot',           flag: 'showPlotCard',           toggle: 'togglePlotCard',           onReclick: 'refresh', requiresBook: true, partial: 'plot', hiddenForBuchtyp: ['journalismus'],
    loadDeps: [{ method: 'loadFiguren', skipIfNonEmpty: 'figuren' }] },
  { key: 'motiv',          flag: 'showMotivCard',          toggle: 'toggleMotivCard',          onReclick: 'refresh', requiresBook: true, partial: 'motiv', hiddenForBuchtyp: ['journalismus'],
    loadDeps: [{ method: 'loadFiguren', skipIfNonEmpty: 'figuren' }] },
  { key: 'weltfakten',     flag: 'showWorldFactsCard',     toggle: 'toggleWorldFactsCard',     onReclick: 'refresh', extraRefreshOnOpen: true, partial: 'world-facts', hiddenForBuchtyp: ['journalismus'] },
  { key: 'recherche',      flag: 'showRechercheCard',      toggle: 'toggleRechercheCard',      onReclick: 'refresh', requiresBook: true, partial: 'recherche' },
  { key: 'sources',        flag: 'showSourcesCard',        toggle: 'toggleSourcesCard',        onReclick: 'refresh', requiresBook: true, partial: 'sources' },
  { key: 'bookStats',      flag: 'showBookStatsCard',      toggle: 'toggleBookStatsCard',      onReclick: 'close', partial: 'bookstats' },
  { key: 'stil',           flag: 'showStilCard',           toggle: 'toggleStilCard',           onReclick: 'close', partial: 'stil-heatmap' },
  { key: 'fehlerHeatmap',  flag: 'showFehlerHeatmapCard',  toggle: 'toggleFehlerHeatmapCard',  onReclick: 'close', partial: 'fehler-heatmap' },
  { key: 'redundanz',      flag: 'showRedundanzCard',      toggle: 'toggleRedundanzCard',      onReclick: 'close', requiresBook: true, partial: 'redundanz' },
  { key: 'buchlandkarte',  flag: 'showBuchlandkarteCard',  toggle: 'toggleBuchlandkarteCard',  onReclick: 'close', requiresBook: true, partial: 'buchlandkarte' },
  { key: 'wortschatz',     flag: 'showWortschatzCard',     toggle: 'toggleWortschatzCard',     onReclick: 'refresh', requiresBook: true, partial: 'wortschatz' },
  { key: 'struktur',       flag: 'showStrukturCard',       toggle: 'toggleStrukturCard',       onReclick: 'refresh', requiresBook: true, requiresBuchtyp: 'journalismus', partial: 'struktur' },
  { key: 'titelwerkstatt', flag: 'showTitelwerkstattCard', toggle: 'toggleTitelwerkstattCard', onReclick: 'refresh', requiresBook: true, requiresBuchtyp: JOURNALISTIC_BUCHTYPEN, partial: 'titelwerkstatt' },
  { key: 'bookChat',       flag: 'showBookChatCard',       toggle: 'toggleBookChatCard',       onReclick: 'refresh', requiresBook: true, auditEvent: 'bookChatOpened', partial: 'chat' },
  { key: 'orte',           flag: 'showOrteCard',           toggle: 'toggleOrteCard',           onReclick: 'refresh', partial: 'orte', hiddenForBuchtyp: ['journalismus'],
    loadDeps: [{ method: 'loadFiguren', skipIfNonEmpty: 'figuren' }] },
  { key: 'songs',          flag: 'showSongsCard',          toggle: 'toggleSongsCard',          onReclick: 'refresh', partial: 'songs', hiddenForBuchtyp: ['journalismus'],
    loadDeps: [{ method: 'loadFiguren', skipIfNonEmpty: 'figuren' }] },
  { key: 'kontinuitaet',   flag: 'showKontinuitaetCard',   toggle: 'toggleKontinuitaetCard',   onReclick: 'refresh', extraRefreshOnOpen: true, partial: 'kontinuitaet', requiresCloudModel: true, hiddenForBuchtyp: ['journalismus'] },
  { key: 'erzaehlprofil',  flag: 'showErzaehlprofilCard',  toggle: 'toggleErzaehlprofilCard',  onReclick: 'refresh', extraRefreshOnOpen: true, partial: 'erzaehlprofil', requiresCloudModel: true, hiddenForBuchtyp: ['journalismus'] },
  { key: 'tagebuchRueckblick', flag: 'showTagebuchRueckblickCard', toggle: 'toggleTagebuchRueckblickCard', onReclick: 'refresh', requiresBook: true, requiresBuchtyp: 'tagebuch', partial: 'tagebuch-rueckblick' },
  { key: 'bookSettings',   flag: 'showBookSettingsCard',   toggle: 'toggleBookSettingsCard',   onReclick: 'close', partial: 'book-settings' },
  { key: 'userSettings',   flag: 'showUserSettingsCard',   toggle: 'toggleUserSettingsCard',   onReclick: 'close', partial: 'user-settings' },
  { key: 'myStats',        flag: 'showMyStatsCard',        toggle: 'toggleMyStatsCard',        onReclick: 'close', partial: 'my-stats' },
  { key: 'myBooks',        flag: 'showMyBooksCard',        toggle: 'toggleMyBooksCard',        onReclick: 'refresh', partial: 'my-books' },
  { key: 'adminUsers',     flag: 'showAdminUsersCard',     toggle: 'toggleAdminUsersCard',     onReclick: 'close', partial: 'admin-users' },
  { key: 'adminSettings',  flag: 'showAdminSettingsCard',  toggle: 'toggleAdminSettingsCard',  onReclick: 'close', partial: 'admin-settings' },
  { key: 'adminUsage',     flag: 'showAdminUsageCard',     toggle: 'toggleAdminUsageCard',     onReclick: 'close', partial: 'admin-usage' },
  { key: 'adminCategories',flag: 'showAdminCategoriesCard',toggle: 'toggleAdminCategoriesCard',onReclick: 'close', partial: 'admin-categories' },
  { key: 'adminBooks',     flag: 'showAdminBooksCard',     toggle: 'toggleAdminBooksCard',     onReclick: 'close', partial: 'admin-books' },
  { key: 'adminLogs',      flag: 'showAdminLogsCard',      toggle: 'toggleAdminLogsCard',      onReclick: 'close', partial: 'admin-logs' },
  { key: 'adminParseFails',flag: 'showAdminParseFailsCard',toggle: 'toggleAdminParseFailsCard',onReclick: 'close', partial: 'admin-parse-fails' },
  { key: 'adminJsErrors',  flag: 'showAdminJsErrorsCard',  toggle: 'toggleAdminJsErrorsCard',  onReclick: 'close', partial: 'admin-js-errors' },
  { key: 'adminDevices',   flag: 'showAdminDevicesCard',   toggle: 'toggleAdminDevicesCard',   onReclick: 'refresh', partial: 'admin-devices' },
  { key: 'adminBackup',    flag: 'showAdminBackupCard',    toggle: 'toggleAdminBackupCard',    onReclick: 'refresh', partial: 'admin-backup' },
  { key: 'finetuneExport', flag: 'showFinetuneExportCard', toggle: 'toggleFinetuneExportCard', onReclick: 'close', partial: 'finetune-export' },
  { key: 'snapshots',      flag: 'showSnapshotsCard',      toggle: 'toggleSnapshotsCard',      onReclick: 'refresh', requiresBook: true, partial: 'snapshots' },
  { key: 'export',         flag: 'showExportCard',         toggle: 'toggleExportCard',         onReclick: 'close', partial: 'export' },
  { key: 'pdfExport',      flag: 'showPdfExportCard',      toggle: 'togglePdfExportCard',      onReclick: 'close', partial: 'pdf-export', hiddenForBuchtyp: ['journalismus'] },
  { key: 'epubExport',     flag: 'showEpubExportCard',     toggle: 'toggleEpubExportCard',     onReclick: 'close', partial: 'epub-export', hiddenForBuchtyp: ['journalismus'] },
  { key: 'docxExport',     flag: 'showDocxExportCard',     toggle: 'toggleDocxExportCard',     onReclick: 'close', partial: 'docx-export' },
  { key: 'folderImport',   flag: 'showFolderImportCard',   toggle: 'toggleFolderImportCard',   onReclick: 'close', partial: 'folder-import' },
  { key: 'bookOrganizer',  flag: 'showBookOrganizerCard',  toggle: 'toggleBookOrganizerCard',  onReclick: 'refresh', requiresBook: true, partial: 'buchorganizer' },
  { key: 'bookEditor',     flag: 'showBookEditorCard',     toggle: 'toggleBookEditorCard',     onReclick: 'refresh', requiresBook: true, partial: 'book-editor' },
  { key: 'search',         flag: 'showSearchCard',         toggle: 'toggleSearchCard',         onReclick: 'refresh', partial: 'search' },
  { key: 'shareLinks',     flag: 'showShareLinksCard',     toggle: 'toggleShareLinksCard',     onReclick: 'refresh', requiresBook: true, partial: 'share-links' },
  { key: 'help',           flag: 'showHelpCard',           toggle: 'toggleHelpCard',           onReclick: 'close', partial: 'help' },
  { key: 'onboarding',     flag: 'showOnboardingCard',     toggle: 'toggleOnboardingCard',     onReclick: 'refresh', partial: 'onboarding' },
];

export const FEATURE_GROUPS = ['review', 'world', 'manuscript', 'export', 'tools', 'app'];

export const GROUP_LABEL_KEY = {
  review:     'tile.group.review',
  world:      'tile.group.world',
  manuscript: 'tile.group.manuscript',
  export:     'tile.group.export',
  tools:      'tile.group.tools',
  app:        'palette.group.app',
};

const ALL = [...FEATURES, ...ACTIONS];
const BY_KEY = new Map(ALL.map(f => [f.key, f]));

export function featureByKey(key) {
  return BY_KEY.get(key) || null;
}

export function allFeatures() {
  return ALL;
}

// Default-Set für neuen User ohne Tracking-Daten.
export const DEFAULT_RECENT_KEYS = ['review', 'figuren', 'bookchat'];

/** Ist die Karte fuer diesen Buchtyp ausgeblendet? Zentraler Helper, damit die
 *  drei Gates (Palette-Sichtbarkeit, Verfuegbarkeit, Toggle) dieselbe Antwort
 *  geben. */
export function hiddenForBuchtyp(feature, buchtyp) {
  return !!(buchtyp && feature?.hiddenForBuchtyp?.includes(buchtyp));
}

/** Passt der Buchtyp zu `requiresBuchtyp`? Das Feld nimmt einen einzelnen Key
 *  ODER eine Liste — der Titelapparat gilt fuer 'journalismus' UND 'blog', die
 *  Tagebuch-Rueckschau nur fuer 'tagebuch'. Ohne Angabe passt jeder Typ.
 *
 *  Eigener Helper statt eines `===` an drei Stellen: die drei Gates
 *  (Palette-Sichtbarkeit, Verfuegbarkeit, Toggle) muessen dieselbe Antwort
 *  geben, sonst zeigt die Palette eine Karte, die der Toggle verweigert. */
export function matchesRequiredBuchtyp(feature, buchtyp) {
  const req = feature?.requiresBuchtyp;
  if (!req) return true;
  return Array.isArray(req) ? req.includes(buchtyp) : req === buchtyp;
}

export function isFeatureAvailable(feature, ctx) {
  if (!feature) return false;
  if (feature.requiresBook && !ctx.selectedBookId) return false;
  if (feature.requiresPages && !(ctx.pages && ctx.pages.length > 0)) return false;
  if (!matchesRequiredBuchtyp(feature, ctx.buchtyp)) return false;
  if (hiddenForBuchtyp(feature, ctx.buchtyp)) return false;
  if (feature.requiresCloudModel && !ctx.cloudModelEffective) return false;
  return true;
}

// Grund-Key für Disabled-Tooltip / Toast.
export function unavailabilityReasonKey(feature, ctx) {
  if (!feature) return null;
  if (feature.requiresBook && !ctx.selectedBookId) return 'palette.disabled.needBook';
  if (feature.requiresPages && !(ctx.pages && ctx.pages.length > 0)) return 'palette.disabled.needPages';
  if (!matchesRequiredBuchtyp(feature, ctx.buchtyp)) return 'palette.disabled.needBook';
  if (feature.requiresCloudModel && !ctx.cloudModelEffective) return 'palette.disabled.needCloudModel';
  if (feature.minRole && ctx.bookRole && !hasMinRole(ctx.bookRole, feature.minRole)) return 'palette.disabled.insufficientRole';
  return null;
}

// Rolle-Hierarchie: viewer < lektor < editor < owner.
// SSoT für Frontend-Visibility-Checks (Quick-Pills, Command-Palette, Sidebar).
// Server-Guard ist autoritativ (lib/acl.js), das hier ist UX.
export const ROLE_RANK = { viewer: 1, lektor: 2, editor: 3, owner: 4 };

export function hasMinRole(actual, required) {
  if (!required) return true;
  if (!actual) return false;
  const a = ROLE_RANK[actual] || 0;
  const r = ROLE_RANK[required] || 0;
  return a >= r;
}

// Filter `features` aufs sichtbare Subset für eine Buchrolle. Cards ohne
// `minRole` sind nur für editor+ sichtbar (defensive: kein impliziter Viewer).
// `buchtyp` (optional): blendet `requiresBuchtyp`-Cards aus, deren Typ nicht passt,
// und `hiddenForBuchtyp`-Cards, deren Typ genannt ist.
// `cloudModelEffective` (optional, Default true): blendet `requiresCloudModel`-Cards
// aus, wenn der effektive Provider nicht der Klasse `cloud` angehört
// (Kontinuität/Erzählprofil).
export function featuresVisibleFor(features, role, buchtyp = null, cloudModelEffective = true) {
  const byBuchtyp = (f) => matchesRequiredBuchtyp(f, buchtyp) && !hiddenForBuchtyp(f, buchtyp);
  const byCloud = (f) => !f.requiresCloudModel || cloudModelEffective;
  if (!role) return features.filter(f => !f.requiresBook && !f.requiresPages && byBuchtyp(f) && byCloud(f));
  return features.filter(f => {
    const min = f.minRole || 'editor';
    return hasMinRole(role, min) && byBuchtyp(f) && byCloud(f);
  });
}
