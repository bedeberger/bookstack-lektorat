// Bewertungsprofile der Buch- und Kapitelbewertung, skopiert nach Buchtyp.
//
// SSoT für alles, was am Bewertungs-Achsenschnitt hängt:
//   · welche Achsen der Prompt verlangt (Buch- und Kapitelebene)
//   · welche Felder das JSON-Schema führt (buildReviewSchema / buildChapterReviewSchema)
//   · welche Achsen der Notenanker für die 4.5-Schwelle nennt
//   · welche Kategorien eine Empfehlung tragen darf
//   · welche Kurzfelder die Kapitelanalyse des Multi-Pass erhebt
//   · welche Abschnitte das Frontend rendert (public/js/book/review.js)
//
// Why: die Achsen waren global narrativ. Weil das Schema jede Achse als
// Pflichtfeld führt, musste das Modell für eine Dissertation, ein Sachbuch, eine
// journalistische Sammlung und einen Gedichtband je 3–5 Sätze zu «Plot» und
// «Hauptfiguren-Bogen» schreiben — es gibt dort nichts zu schreiben, also wird
// gefüllt. Der Notenanker zog denselben Fehler nach («5.0 marktfähig», Schwelle
// über Plot/Figuren/Dramaturgie). Der Buchtyp wählt jetzt das Achsen-Set.
//
// Ein Achsen-Key ist eine Persistenz-Konstante: er steht als Feldname in
// `book_reviews.review_json` / `chapter_reviews.review_json` und in den i18n-Keys
// `review.section.<key>` / `kapitelReview.section.<key>` / `review.cat.<key>`.
// Keys werden ergänzt, nie umbenannt — sonst rendern Alt-Bewertungen ohne Label.
//
// Abgrenzung zu prompts/lektorat-typen.js: das dortige Profil entscheidet, welche
// FEHLER gemeldet werden, dieses hier, welche ACHSEN benotet werden. Sie fallen
// bei `lyrik` bewusst auseinander — im Lektorat bleibt Lyrik narrativ (Wiederholung
// und starke Bilder sind dort Kunstmittel, das ist die richtige Fehler-Brille), in
// der Bewertung braucht sie ein eigenes Set (Plot und Figuren existieren nicht).

// ── Achsen-Definitionen ──────────────────────────────────────────────────────
// key = JSON-Feldname = i18n-Suffix. hint = Prompt-Text der Achse.

const AXIS = {
  // gemeinsam genutzt
  struktur:        'Aufbau, Gliederung, Übergänge, Logik der Abfolge.',
  stil:            'Sprache, Satzbau, Ton, Konsistenz über das Werk.',
  thema:           'Roter Faden, durchgehende Frage / Idee, Konsequenz der Verfolgung.',
  kohaerenz:       'Roter Faden, Übergänge zwischen Seiten/Abschnitten, Logik der Abfolge.',

  // narrativ
  plot:            'Konflikt, Stakes, Wendepunkte, Auflösung.',
  figuren:         'Hauptfiguren-Bogen, Nebenfiguren, Stimmigkeit und Entwicklung über das Buch hinweg.',
  dramaturgie:     'Spannungskurve über die Kapitel, Aufbau, Höhepunkte, Schluss.',
  pacing:          'Tempo, Längen, Mittelteil-Loch, Rhythmus über das Buch.',
  perspektive:     'Erzählperspektive und Konsistenz innerhalb des Kapitels.',

  // sachlich / wissenschaftlich
  argumentation:   'Tragfähigkeit der These, Schlüssigkeit der Kette, Umgang mit Gegenpositionen, Trennung von Befund und Deutung.',
  belege:          'Beleglage: Sind die Behauptungen gestützt? Qualität, Aktualität und Verwendung der Quellen, Zitierdisziplin.',
  verstaendlichkeit: 'Passung zur Zielgruppe: Erklärqualität, Vorwissens-Annahmen, Beispiele, Verhältnis von Fachbegriff und Erläuterung.',
  begriffe:        'Begriffsdisziplin: Werden zentrale Begriffe definiert und durchgehend gleich verwendet? Unschärfen, stille Bedeutungsverschiebungen.',
  methode:         'Nachvollziehbarkeit des Vorgehens: Angemessenheit der Methode zur Fragestellung, Offenlegung, Reichweite und Grenzen der Aussagen.',
  beitrag:         'Erkenntnisbeitrag: Was ist eigenständig, was referiert nur? Verhältnis zum Forschungsstand, Tragweite der Schlussfolgerungen.',

  // journalistisch
  recherche:       'Recherchetiefe: Zahl und Unabhängigkeit der Quellen, Zuschreibung fremder Aussagen, Prüfbarkeit der Angaben.',
  textsortentreue: 'Erfüllung der jeweiligen Textsorte: Aufhänger, Lead, Reihenfolge der Information, Gegenposition, Schluss.',
  relevanz:        'Nachrichtenwert und Aktualität, Trennung von Nachricht und Meinung, Bedeutung für das Publikum.',

  // lyrisch
  form:            'Rhythmus, Metrum, Versbau, Zeilenbruch, Klang. Verhältnis von Form und Inhalt.',
  bildsprache:     'Bildkraft und Originalität der Bilder, Konsequenz der Bildlogik, abgegriffene vs. eigene Bilder.',
  verdichtung:     'Verdichtung: Trägt jede Zeile? Leerlauf, erklärende Zeilen, überflüssige Auflösung des Bildes.',
  stimme:          'Eigenstimme und Variation über den Band, Wiedererkennbarkeit, Gefahr der Manier.',
  komposition:     'Komposition des Ganzen: Reihenfolge, Bogen, Gruppenbildung, Anfang und Schluss.',
};

// Kapitel-Ebene: dieselben Keys, aber auf den Abschnitt bezogen formuliert.
// Nur wo die Buch-Formulierung nicht passt, steht hier ein eigener Hint.
const CHAPTER_AXIS_OVERRIDE = {
  dramaturgie:     'Spannungsbogen, Szenenabfolge, Aufbau, Höhepunkte.',
  pacing:          'Tempo, Längen, Leerlauf, Szenenrhythmus.',
  figuren:         'Auftreten der Figuren im Kapitel, Stimmigkeit, Entwicklung.',
  argumentation:   'Trägt der Gedankengang dieses Abschnitts? Schlüssigkeit der Schritte, Sprünge, unausgeführte Behauptungen.',
  belege:          'Sind die Behauptungen dieses Abschnitts gestützt? Belegdichte, Zuordnung von Aussage und Quelle.',
  begriffe:        'Werden die im Abschnitt verwendeten Begriffe konsistent und definiert gebraucht?',
  methode:         'Nachvollziehbarkeit des Vorgehens in diesem Abschnitt, Offenlegung der Schritte.',
  verstaendlichkeit: 'Erklärqualität dieses Abschnitts für die Zielgruppe, Beispiele, Vorwissens-Annahmen.',
  recherche:       'Quellenlage und Zuschreibung in den Beiträgen dieses Teils.',
  textsortentreue: 'Erfüllen die Beiträge die Form ihrer jeweiligen Textsorte?',
  relevanz:        'Nachrichtenwert, Aktualität und Trennung von Nachricht und Meinung in diesem Teil.',
  form:            'Rhythmus, Metrum, Versbau und Klang in diesem Teil des Bandes.',
  bildsprache:     'Bildkraft und Bildlogik in diesem Teil.',
  verdichtung:     'Trägt jede Zeile in diesem Teil? Leerlauf, erklärende Zeilen.',
  komposition:     'Reihenfolge und Bogen innerhalb dieses Teils, Anschluss an die Nachbarteile.',
};

function _axes(keys, override = null) {
  return keys.map(key => ({
    key,
    hint: (override && override[key]) || AXIS[key],
  }));
}

// ── Profile ──────────────────────────────────────────────────────────────────

const PROFILE = {
  // Erzählende Werke: Roman, Krimi, Fantasy, Autobiografie, Tagebuch, Satire …
  narrativ: {
    werk: { nom: 'das Buch', akk: 'das Buch' },
    bookAxes:    _axes(['struktur', 'stil', 'plot', 'figuren', 'dramaturgie', 'pacing', 'thema']),
    chapterAxes: _axes(['dramaturgie', 'pacing', 'kohaerenz', 'perspektive', 'figuren'], CHAPTER_AXIS_OVERRIDE),
    bookGewichtung:    'Plot, Figuren, Dramaturgie und Stil tragen die Gesamtnote stärker als Mikro-Mängel oder einzelne Stellen.',
    chapterGewichtung: 'Dramaturgie, Pacing und Kohärenz sind die zentralen Bewertungskriterien dieses Kapitels und fliessen stärker in die Gesamtnote ein als sprachliche Einzelmängel.',
    bookTiers: {
      mangelhaft: 'handwerklich mangelhaft – Plot, Stil oder Konsistenz gravierend defekt.',
      schwach:    'Idee tragfähig, Umsetzung schwach.',
      solide:     'solide Genreprosa, ohne herausstechende Stärke.',
      sehrGut:    'sehr gut, marktfähig.',
    },
    chapterTiers: {
      mangelhaft: 'handwerklich mangelhaft – Dramaturgie, Kohärenz oder Perspektive gravierend defekt.',
      schwach:    'Grundidee der Szene(n) trägt, Umsetzung schwach (Leerlauf, unklare Übergänge, flache Figuren).',
      solide:     'solides Kapitel, funktioniert, ohne herausstechende Wirkung.',
      sehrGut:    'sehr gut – trägt die Handlung spürbar, Szenen sitzen.',
    },
    analyse: [
      { key: 'dramaturgie_kurz', label: 'Dramaturgie', hint: 'Spannungskurve im Abschnitt (Aufbau, Höhepunkt, Schluss).' },
      { key: 'figuren_kurz', label: 'Figuren', hint: 'Welche Figuren tragen den Abschnitt, wie verschiebt sich ihre Position.' },
      { key: 'pacing_kurz', label: 'Pacing', hint: 'Tempo und Längen, Leerlauf vs. Verdichtung.' },
    ],
  },

  // Sachbuch / Essay / Blog: argumentierender Text ohne Figuren und ohne Szene.
  sachlich: {
    werk: { nom: 'das Werk', akk: 'das Werk' },
    bookAxes:    _axes(['struktur', 'stil', 'argumentation', 'belege', 'verstaendlichkeit', 'thema']),
    chapterAxes: _axes(['argumentation', 'kohaerenz', 'belege', 'verstaendlichkeit'], CHAPTER_AXIS_OVERRIDE),
    bookGewichtung:    'Argumentation, Beleglage und Struktur tragen die Gesamtnote stärker als sprachliche Einzelmängel.',
    chapterGewichtung: 'Argumentation und Kohärenz sind die zentralen Bewertungskriterien dieses Abschnitts und fliessen stärker in die Gesamtnote ein als sprachliche Einzelmängel.',
    bookTiers: {
      mangelhaft: 'handwerklich mangelhaft – die These trägt nicht, Belege fehlen oder der Aufbau ist unbrauchbar.',
      schwach:    'Thema tragfähig, Durchführung schwach (Behauptung statt Argument, dünne Beleglage, unklarer Aufbau).',
      solide:     'solide, sachlich korrekt und nachvollziehbar, ohne eigenständigen Zugriff.',
      sehrGut:    'sehr gut – eigenständige These, tragfähig belegt, für die Zielgruppe überzeugend geführt.',
    },
    chapterTiers: {
      mangelhaft: 'handwerklich mangelhaft – Gedankengang oder Beleglage gravierend defekt.',
      schwach:    'Grundgedanke trägt, Durchführung schwach (Sprünge, unbelegte Behauptungen, Redundanz).',
      solide:     'solider Abschnitt, funktioniert, ohne herausstechende Schärfe.',
      sehrGut:    'sehr gut – der Abschnitt bringt das Argument spürbar voran.',
    },
    analyse: [
      { key: 'argumentation_kurz', label: 'Argumentation', hint: 'Welchen Schritt macht das Argument in diesem Abschnitt.' },
      { key: 'belege_kurz', label: 'Belege', hint: 'Beleglage: worauf stützt sich der Abschnitt, was bleibt unbelegt.' },
      { key: 'verstaendlichkeit_kurz', label: 'Verständlichkeit', hint: 'Erklärqualität und Vorwissens-Annahmen des Abschnitts.' },
    ],
  },

  // Wissenschaftliche Arbeit: Dissertation, Paper, Studienarbeit.
  wissenschaft: {
    werk: { nom: 'die Arbeit', akk: 'die Arbeit' },
    bookAxes:    _axes(['struktur', 'stil', 'argumentation', 'methode', 'belege', 'begriffe', 'beitrag']),
    chapterAxes: _axes(['argumentation', 'kohaerenz', 'belege', 'begriffe', 'methode'], CHAPTER_AXIS_OVERRIDE),
    bookGewichtung:    'Argumentation, Methode, Beleglage und Begriffsdisziplin tragen die Gesamtnote. Sprachliche Glätte ist nachrangig; Nominalstil, Passiv und wiederholte Fachtermini sind hier kein Mangel.',
    chapterGewichtung: 'Argumentation, Beleglage und Begriffsdisziplin sind die zentralen Bewertungskriterien dieses Abschnitts.',
    bookTiers: {
      mangelhaft: 'wissenschaftlich mangelhaft – Fragestellung, Methode oder Beleglage gravierend defekt.',
      schwach:    'Fragestellung tragfähig, Durchführung schwach (Methode unklar, Befund und Deutung vermischt, lückenhafte Belege).',
      solide:     'solide Arbeit, methodisch sauber, ohne eigenständigen Erkenntnisbeitrag.',
      sehrGut:    'sehr gut – methodisch stringent, sauber belegt, mit erkennbarem eigenem Beitrag.',
    },
    chapterTiers: {
      mangelhaft: 'mangelhaft – der Abschnitt trägt argumentativ oder methodisch nicht.',
      schwach:    'Ansatz tragfähig, Durchführung schwach (Sprünge, unbelegte Behauptungen, schwankende Begriffe).',
      solide:     'solider Abschnitt, korrekt und nachvollziehbar.',
      sehrGut:    'sehr gut – der Abschnitt trägt die Argumentation der Arbeit spürbar.',
    },
    analyse: [
      { key: 'argumentation_kurz', label: 'Argumentation', hint: 'Welchen Schritt macht die Argumentation in diesem Abschnitt.' },
      { key: 'belege_kurz', label: 'Belege', hint: 'Beleglage: Dichte, Art der Quellen, unbelegte Stellen.' },
      { key: 'begriffe_kurz', label: 'Begriffe', hint: 'Zentrale Begriffe des Abschnitts und ob sie konsistent gebraucht werden.' },
    ],
  },

  // Journalistische Sammlung (Ressort, Serie, Projekt): jede Seite ein Beitrag
  // mit eigener Textsorte. Die Formprüfung des Einzelbeitrags leistet der
  // Struktur-Check (prompts/struktur.js); hier zählt das Ganze.
  journalistisch: {
    werk: { nom: 'die Sammlung', akk: 'die Sammlung' },
    bookAxes:    _axes(['struktur', 'stil', 'recherche', 'textsortentreue', 'relevanz', 'thema']),
    chapterAxes: _axes(['textsortentreue', 'recherche', 'kohaerenz', 'relevanz'], CHAPTER_AXIS_OVERRIDE),
    bookGewichtung:    'Recherche, Textsortentreue und Relevanz tragen die Gesamtnote stärker als sprachliche Einzelmängel.',
    chapterGewichtung: 'Textsortentreue und Recherche sind die zentralen Bewertungskriterien dieses Teils.',
    bookTiers: {
      mangelhaft: 'handwerklich mangelhaft – Recherche, Zuschreibung oder Form der Beiträge gravierend defekt.',
      schwach:    'Themen tragfähig, Umsetzung schwach (Einquellen-Stücke, verwischte Trennung von Nachricht und Meinung, verfehlte Formen).',
      solide:     'solides Handwerk, sauber recherchiert, ohne herausstechende Stücke.',
      sehrGut:    'sehr gut – belastbar recherchiert, formsicher, mit erkennbarem Eigenwert.',
    },
    chapterTiers: {
      mangelhaft: 'handwerklich mangelhaft – Form oder Recherche der Beiträge gravierend defekt.',
      schwach:    'Themen tragfähig, Umsetzung schwach (dünne Quellenlage, verfehlte Textsorte).',
      solide:     'solide Beiträge, sauber gearbeitet.',
      sehrGut:    'sehr gut – formsicher, belastbar, relevant.',
    },
    analyse: [
      { key: 'textsorte_kurz', label: 'Textsorte', hint: 'Welche Textsorten liegen im Abschnitt vor und werden sie in ihrer Form eingelöst.' },
      { key: 'recherche_kurz', label: 'Recherche', hint: 'Quellenlage und Zuschreibung im Abschnitt.' },
      { key: 'relevanz_kurz', label: 'Relevanz', hint: 'Nachrichtenwert und Aktualität der Beiträge dieses Abschnitts.' },
    ],
  },

  // Lyrik: Plot und Figuren existieren nicht. Bewertet werden Form, Bild,
  // Verdichtung, Stimme und die Komposition des Bandes.
  lyrisch: {
    werk: { nom: 'der Band', akk: 'den Band' },
    bookAxes:    _axes(['komposition', 'form', 'bildsprache', 'verdichtung', 'stimme', 'thema']),
    chapterAxes: _axes(['form', 'bildsprache', 'verdichtung', 'komposition'], CHAPTER_AXIS_OVERRIDE),
    bookGewichtung:    'Bildsprache, Verdichtung und Eigenstimme tragen die Gesamtnote stärker als Einzelstellen. Wortwiederholung, elliptische Syntax und Regelbrüche sind Kunstmittel, kein Mangel.',
    chapterGewichtung: 'Bildsprache und Verdichtung sind die zentralen Bewertungskriterien dieses Teils.',
    bookTiers: {
      mangelhaft: 'handwerklich mangelhaft – Bilder abgegriffen, Form beliebig, kein erkennbarer Zugriff.',
      schwach:    'einzelne Bilder tragen, der Band als Ganzes nicht (Leerlauf, erklärende Zeilen, Manier).',
      solide:     'solide gearbeitet, formsicher, ohne eigene Handschrift.',
      sehrGut:    'sehr gut – eigene Bildsprache, dicht gearbeitet, der Band trägt als Ganzes.',
    },
    chapterTiers: {
      mangelhaft: 'mangelhaft – Bilder und Form tragen in diesem Teil nicht.',
      schwach:    'einzelne Texte tragen, der Teil als Ganzes nicht.',
      solide:     'solider Teil, formsicher.',
      sehrGut:    'sehr gut – dicht, eigenständig, gut komponiert.',
    },
    analyse: [
      { key: 'form_kurz', label: 'Form', hint: 'Rhythmus, Versbau und Klang in diesem Teil.' },
      { key: 'bildsprache_kurz', label: 'Bildsprache', hint: 'Tragende Bilder des Teils und ihre Originalität.' },
      { key: 'komposition_kurz', label: 'Komposition', hint: 'Reihenfolge und Bogen innerhalb des Teils.' },
    ],
  },
};

// buchtyp-Key (prompt-config.json `buchtypen`) → Profil. Alles Ungenannte,
// inkl. null/unbekannt, fällt auf 'narrativ' zurück.
const PROFIL_BY_BUCHTYP = {
  wissenschaft: 'wissenschaft',
  sachbuch:     'sachlich',
  essay:        'sachlich',
  blog:         'sachlich',
  journalismus: 'journalistisch',
  lyrik:        'lyrisch',
};

/** Profilname für einen Buchtyp. Unbekannt/null → 'narrativ'. */
export function reviewProfil(buchtyp) {
  return PROFIL_BY_BUCHTYP[buchtyp] || 'narrativ';
}

function _profile(buchtyp) {
  return PROFILE[reviewProfil(buchtyp)];
}

/** Achsen der Buchbewertung: [{ key, hint }] in Prompt-/Render-Reihenfolge. */
export function bookReviewAxes(buchtyp) {
  return _profile(buchtyp).bookAxes;
}

/** Achsen der Kapitelbewertung: [{ key, hint }] in Prompt-/Render-Reihenfolge. */
export function chapterReviewAxes(buchtyp) {
  return _profile(buchtyp).chapterAxes;
}

// Zugriff über den PROFIL-Namen statt über den Buchtyp. Das Ergebnis-JSON führt
// `profil` mit (routes/jobs/review.js) — der Renderer muss die Achsen des Laufs
// zeigen, nicht die des heute eingestellten Buchtyps.
function _byProfil(profil) {
  return PROFILE[profil] || PROFILE.narrativ;
}

/** Buch-Achsen zu einem Profilnamen (Fallback: narrativ). */
export function bookAxesByProfil(profil) {
  return _byProfil(profil).bookAxes;
}

/** Kapitel-Achsen zu einem Profilnamen (Fallback: narrativ). */
export function chapterAxesByProfil(profil) {
  return _byProfil(profil).chapterAxes;
}

/** Kurzfelder der Kapitelanalyse (Multi-Pass-Zwischenstufe): [{ key, hint }]. */
export function chapterAnalysisFelder(buchtyp) {
  return _profile(buchtyp).analyse;
}

/** Gewichtungssatz für den Achsen-Block. */
export function reviewGewichtung(buchtyp, scope = 'book') {
  const p = _profile(buchtyp);
  return scope === 'chapter' ? p.chapterGewichtung : p.bookGewichtung;
}

/**
 * Bezeichnung des Ganzen MIT Artikel, im gewünschten Kasus: «das Buch»,
 * «die Arbeit», «der Band» / «den Band». Artikel und Kasus gehören dazu, weil
 * die Prompt-Sätze sie flektiert einsetzen — ohne sie entsteht «das Arbeit»
 * bzw. «Bewerte der Band».
 *
 * @param {string|null} buchtyp
 * @param {'nom'|'akk'} [kasus]
 */
export function werkPhrase(buchtyp, kasus = 'nom') {
  return _profile(buchtyp).werk[kasus] || _profile(buchtyp).werk.nom;
}

/**
 * Zulässige Empfehlungs-Kategorien eines Laufs.
 * Buchebene: die Buchachsen + «mikro». Kapitelebene: die Kapitelachsen + «stil»
 * (eine Stil-Empfehlung ist auf jeder Ebene legitim) + «mikro».
 */
export function empfehlungKategorien(buchtyp, scope = 'book') {
  const p = _profile(buchtyp);
  const keys = scope === 'chapter'
    ? [...p.chapterAxes.map(a => a.key), 'stil']
    : p.bookAxes.map(a => a.key);
  return [...new Set([...keys, 'mikro'])];
}

/** Notenanker-Stufen eines Profils (Prosa je Notenband). */
export function notenTiers(buchtyp, scope = 'book') {
  const p = _profile(buchtyp);
  return scope === 'chapter' ? p.chapterTiers : p.bookTiers;
}

// ── Ableitungen für Drift-Gates und Frontend ─────────────────────────────────

export const REVIEW_PROFIL_KEYS = Object.keys(PROFILE);

/** Alle je gültigen Buch-Achsen-Keys (Union über alle Profile), Render-Reihenfolge. */
export const ALLE_BOOK_AXES = [
  ...new Set(REVIEW_PROFIL_KEYS.flatMap(k => PROFILE[k].bookAxes.map(a => a.key))),
];

/** Alle je gültigen Kapitel-Achsen-Keys (Union über alle Profile). */
export const ALLE_CHAPTER_AXES = [
  ...new Set(REVIEW_PROFIL_KEYS.flatMap(k => PROFILE[k].chapterAxes.map(a => a.key))),
];

/** Union aller Empfehlungs-Kategorien — Basis der i18n-Vollständigkeit. */
export const ALLE_KATEGORIEN = [
  ...new Set([...ALLE_BOOK_AXES, ...ALLE_CHAPTER_AXES, 'stil', 'mikro']),
];

// Signatur der Profile für den Prompts-Content-Hash. Die Prompt-Bodys hängen an
// Call-Argumenten (buchtyp) und fliessen darum nicht in den Locale-Snapshot —
// ohne diese Signatur würde eine Profil-Änderung den `chapter_review_cache` /
// `book_review_cache` / `chapter_macro_review_cache` nicht invalidieren.
export const REVIEW_PROFIL_SIGNATUR = JSON.stringify(PROFILE);
