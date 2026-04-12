export const CLAUDE_API = '/claude';

// Unveränderliche technische Pflicht-Anweisung – darf nicht konfiguriert werden,
// da callAI() immer ein JSON-Objekt erwartet.
const JSON_ONLY = 'Antworte ausschliesslich mit einem JSON-Objekt – kein Markdown, kein Text davor oder danach. Beginne deine Antwort direkt mit { und beende sie mit }.';


function buildSystem(prefix, rules) {
  return `${prefix}\n\n${rules}\n\n${JSON_ONLY}`;
}

// Für Chat-Prompts: Prefix + Rules, aber kein JSON_ONLY am Ende –
// buildChatSystemPrompt/buildBookChatSystemPrompt hängen das Schema selbst an.
function buildSystemNoJson(prefix, rules) {
  return `${prefix}\n\n${rules}`;
}

// ── Interne Locale-Map ────────────────────────────────────────────────────────
// Key: localeKey (z.B. 'de-CH') → { SYSTEM_LEKTORAT, ..., STOPWORDS, ERKLAERUNG_RULE }
let _localeMap = new Map();
let _defaultLocale = 'de-CH';

/** Baut ein Locale-Prompts-Objekt aus einer Locale-Config (aus prompt-config.json). */
function _buildLocalePrompts(localeConfig, globalErklaerungRule) {
  const rules = localeConfig.baseRules || '';
  const sp    = localeConfig.systemPrompts || {};
  return {
    ERKLAERUNG_RULE:             globalErklaerungRule || '',
    STOPWORDS:                   Array.isArray(localeConfig.stopwords) ? localeConfig.stopwords : [],
    SOZIOGRAMM_KONTEXT:          localeConfig.soziogrammKontext || '',
    SYSTEM_LEKTORAT:             buildSystem(sp.lektorat          || '', rules),
    SYSTEM_BUCHBEWERTUNG:        buildSystem(sp.buchbewertung     || '', rules),
    SYSTEM_KAPITELANALYSE:       buildSystem(sp.kapitelanalyse    || '', rules),
    SYSTEM_FIGUREN:              buildSystem(sp.figuren           || '', rules),
    SYSTEM_STILKORREKTUR:        buildSystem(sp.stilkorrektur     || '', rules),
    SYSTEM_CHAT:                 buildSystemNoJson(sp.chat        || '', rules),
    SYSTEM_BOOK_CHAT:            buildSystemNoJson(sp.buchchat    || '', rules),
    SYSTEM_ORTE:                 buildSystem(sp.orte              || 'Du bist ein Literaturanalytiker. Du identifizierst Schauplätze und Orte präzise und konservativ – nur was im Text eindeutig belegt ist.', rules),
    SYSTEM_KONTINUITAET:         buildSystem(sp.kontinuitaet      || 'Du bist ein sorgfältiger Literaturlektor. Du prüfst einen Roman auf Kontinuitätsfehler und Widersprüche – Figuren, Zeitabläufe, Orte, Objekte und Charakterverhalten.', rules),
    SYSTEM_SZENEN:               buildSystem(sp.szenen            || '', rules),
    SYSTEM_ZEITSTRAHL:           buildSystem(sp.zeitstrahl        || '', rules),
    // Kombinierter System-Prompt für buildExtraktionKomplettChapterPrompt (P1+P5 merged).
    // Schema und Regeln sind im System-Prompt → werden gecacht; User-Message enthält nur Kapiteltext.
    SYSTEM_KOMPLETT_EXTRAKTION:  buildSystemKomplett(sp.figuren   || '', rules),
  };
}

// Live-Exports – werden durch configurePrompts() gesetzt (Pflicht vor erstem Prompt-Aufruf).
// Alle importierenden Module erhalten via ESM-Live-Binding immer den aktuellen Wert.
// Diese Globals entsprechen stets dem defaultLocale und dienen der Rückwärtskompatibilität.
export let ERKLAERUNG_RULE              = null;
export let STOPWORDS                    = [];
export let SOZIOGRAMM_KONTEXT           = '';
export let SYSTEM_LEKTORAT              = null;
export let SYSTEM_BUCHBEWERTUNG         = null;
export let SYSTEM_KAPITELANALYSE        = null;
export let SYSTEM_FIGUREN               = null;
export let SYSTEM_STILKORREKTUR         = null;
export let SYSTEM_CHAT                  = null;
export let SYSTEM_BOOK_CHAT             = null;
export let SYSTEM_ORTE                  = null;
export let SYSTEM_KONTINUITAET          = null;
export let SYSTEM_SZENEN                = null;
export let SYSTEM_ZEITSTRAHL            = null;
export let SYSTEM_KOMPLETT_EXTRAKTION   = null;

/**
 * Setzt alle System-Prompts aus dem promptConfig-Objekt (geladen aus prompt-config.json).
 * Unterstützt sowohl das neue Locales-Format (cfg.locales) als auch das alte Flat-Format
 * (cfg.baseRules direkt) für Rückwärtskompatibilität.
 * Pflichtaufruf beim App-Start – wirft einen Fehler wenn cfg fehlt.
 * @param {Object} cfg  promptConfig-Objekt aus /config
 */
export function configurePrompts(cfg) {
  if (!cfg) throw new Error('prompt-config.json fehlt oder ist ungültig – Prompts können nicht konfiguriert werden.');

  _localeMap.clear();

  if (cfg.locales && typeof cfg.locales === 'object') {
    // ── Neues Format: locales-Map ─────────────────────────────────────────────
    _defaultLocale = cfg.defaultLocale || 'de-CH';
    for (const [key, localeCfg] of Object.entries(cfg.locales)) {
      _localeMap.set(key, _buildLocalePrompts(localeCfg, cfg.erklaerungRule));
    }
    // Fallback: Falls defaultLocale nicht in der Map → ersten Eintrag nehmen
    if (!_localeMap.has(_defaultLocale) && _localeMap.size > 0) {
      _defaultLocale = _localeMap.keys().next().value;
    }
  } else {
    // ── Altes Flat-Format (Rückwärtskompatibilität) ───────────────────────────
    const rules = cfg.baseRules;
    if (!rules) throw new Error('prompt-config.json: Pflichtfeld "baseRules" oder "locales" fehlt.');
    _defaultLocale = 'de-CH';
    _localeMap.set('de-CH', _buildLocalePrompts({
      baseRules:     cfg.baseRules,
      stopwords:     cfg.stopwords,
      systemPrompts: cfg.systemPrompts || {},
    }, cfg.erklaerungRule));
  }

  // Globale Exports auf Default-Locale setzen (ESM-Live-Binding für Client-Code)
  const def = _localeMap.get(_defaultLocale) || {};
  ERKLAERUNG_RULE              = def.ERKLAERUNG_RULE              ?? '';
  STOPWORDS                    = def.STOPWORDS                    ?? [];
  SOZIOGRAMM_KONTEXT           = def.SOZIOGRAMM_KONTEXT           ?? '';
  SYSTEM_LEKTORAT              = def.SYSTEM_LEKTORAT              ?? null;
  SYSTEM_BUCHBEWERTUNG         = def.SYSTEM_BUCHBEWERTUNG         ?? null;
  SYSTEM_KAPITELANALYSE        = def.SYSTEM_KAPITELANALYSE        ?? null;
  SYSTEM_FIGUREN               = def.SYSTEM_FIGUREN               ?? null;
  SYSTEM_STILKORREKTUR         = def.SYSTEM_STILKORREKTUR         ?? null;
  SYSTEM_CHAT                  = def.SYSTEM_CHAT                  ?? null;
  SYSTEM_BOOK_CHAT             = def.SYSTEM_BOOK_CHAT             ?? null;
  SYSTEM_ORTE                  = def.SYSTEM_ORTE                  ?? null;
  SYSTEM_KONTINUITAET          = def.SYSTEM_KONTINUITAET          ?? null;
  SYSTEM_SZENEN                = def.SYSTEM_SZENEN                ?? null;
  SYSTEM_ZEITSTRAHL            = def.SYSTEM_ZEITSTRAHL            ?? null;
  SYSTEM_KOMPLETT_EXTRAKTION   = def.SYSTEM_KOMPLETT_EXTRAKTION   ?? null;
}

/**
 * Gibt das Locale-Prompts-Objekt für einen gegebenen Locale-Key zurück.
 * Fällt auf den Default-Locale zurück wenn der Key unbekannt ist.
 * @param {string} localeKey  z.B. 'de-CH', 'en-US'
 * @returns {{ SYSTEM_LEKTORAT, SYSTEM_BUCHBEWERTUNG, ..., STOPWORDS, ERKLAERUNG_RULE }}
 */
export function getLocalePrompts(localeKey) {
  return _localeMap.get(localeKey) ?? _localeMap.get(_defaultLocale) ?? {};
}

export function buildStilkorrekturPrompt(html, styles) {
  const liste = styles.map((s, i) =>
    `${i + 1}. Originalstelle: "${s.original}"\n   Empfehlung: "${s.korrektur}"\n   Begründung: ${s.erklaerung}\n   Kontext: ${s.kontext}`
  ).join('\n\n');

  return `Du bekommst einen HTML-Text und eine Liste stilistischer Verbesserungsvorschläge. Für jede Stelle entscheidest du selbst, wie die beste Formulierung lautet – die Empfehlung ist ein Hinweis, keine Vorgabe. Gib für jede Stelle das exakte Original (wie es im HTML steht) und deine gewählte Ersatzformulierung zurück.

Stilistische Verbesserungen:
${liste}

Antworte mit diesem JSON-Schema:
{
  "korrekturen": [
    { "original": "exakter Originaltext wie im HTML", "ersatz": "deine gewählte Ersatzformulierung" }
  ]
}

HTML-Text:
${html}`;
}

// Wiederholung-Regeln für Lektorat-Prompts (beide Varianten)
// sw: explizite Stoppwort-Liste; fällt auf globales STOPWORDS zurück (Default-Locale)
function _buildWiederholungBlock(sw = STOPWORDS) {
  const swNote = sw.length > 0
    ? `\n- Stoppwörter nie melden (auch flektierte Formen): ${sw.join(', ')}`
    : '';
  return `
Wiederholung-Regeln (typ: «wiederholung»):
- Nur Inhaltswörter, die auffällig oft vorkommen: mind. 3× im Text ODER 2× in enger Nähe (5 Sätze)
- Keine Pronomen, Hilfsverben, Artikel, Konjunktionen, Präpositionen, Eigennamen${swNote}
- «original»: vollständiger Satz zeichengenau aus dem Text (damit die Textstelle eindeutig auffindbar ist)
- «korrektur»: derselbe Satz mit dem besten Synonym – exakt gleiche grammatische Form (Kasus, Numerus, Tempus)
- Synonym-Selbsttest vor jedem Eintrag: Klingt der Satz danach natürlich? Bedeutung erhalten? Passt zum Autorenstil?`;
}

// Batch-Variante ohne korrekturen_html (spart Output-Tokens, für Server-Side-Jobs)
// opts.stopwords / opts.erklaerungRule überschreiben die globalen Defaults (für locale-aware Aufrufe)
export function buildBatchLektoratPrompt(text, { stopwords = STOPWORDS, erklaerungRule = ERKLAERUNG_RULE } = {}) {
  return `Analysiere diesen deutschsprachigen Text auf Rechtschreibfehler, Grammatikfehler, stilistische Auffälligkeiten und auffällige Wortwiederholungen. Bewerte ausserdem die Szenen der Seite.

WICHTIG: Jede einzelne Beanstandung erhält einen eigenen Eintrag im «fehler»-Array. Wenn an einer Stelle mehrere unabhängige Probleme vorliegen, müssen diese als separate Einträge erscheinen – niemals in einer gemeinsamen «erklaerung» zusammenfassen.

Antworte mit diesem JSON-Schema:
{
  "fehler": [
    {
      "typ": "rechtschreibung|grammatik|stil|wiederholung",
      "original": "das fehlerhafte Wort oder die fehlerhafte Phrase – bei «wiederholung»: vollständiger Satz zeichengenau aus dem Text",
      "korrektur": "die korrekte Version – bei «wiederholung»: derselbe Satz mit Synonym",
      "kontext": "der Satz in dem der Fehler vorkommt (bei «wiederholung» gleich wie «original»)",
      "erklaerung": "kurze Erklärung (nur diesen einen Mangel beschreiben) ${erklaerungRule}"
    }
  ],
  "szenen": [
    {
      "titel": "Kurze Szenenbezeichnung (1 Satz)",
      "wertung": "stark|mittel|schwach",
      "kommentar": "1-2 Sätze: was funktioniert, was fehlt (Spannung, Tempo, Figurenentwicklung)"
    }
  ],
  "stilanalyse": "2-3 Sätze Stilanalyse",
  "fazit": "ein Satz Gesamtfazit"
}

Szenen-Regeln:
- Eine Szene ist ein abgegrenzter Handlungsabschnitt mit eigenem Anfang und Ende
- Wenn die Seite keine erkennbaren Szenen enthält (z.B. rein beschreibender Text, Exposition): «szenen» als leeres Array zurückgeben
- wertung: «stark» = funktioniert gut, «mittel» = verbesserungswürdig, «schwach» = klare Schwächen
${_buildWiederholungBlock(stopwords)}

Text:
${text}`;
}

// ── Buchbewertung ─────────────────────────────────────────────────────────────

export function buildBookReviewSinglePassPrompt(bookName, pageCount, bookText) {
  return `Bewerte das folgende Buch «${bookName}» kritisch und umfassend. Analysiere:
- Struktur und Aufbau (Kapitel, Übergänge, Logik)
- Sprachstil und Konsistenz über alle Seiten hinweg
- Stärken des Texts
- Schwächen und Verbesserungspotenzial
- Konkrete Empfehlungen für den Autor

GEWICHTUNG: Stil, Sprache und literarische Qualität sind die zentralen Bewertungskriterien und fliessen stärker in die Gesamtnote ein als Rechtschreib- oder Grammatikfehler.

Antworte mit diesem JSON-Schema:
{
  "gesamtnote": "Zahl von 1 (sehr schwach) bis 6 (ausgezeichnet)",
  "gesamtnote_begruendung": "Ein Satz warum diese Note",
  "zusammenfassung": "2-3 Sätze Gesamteindruck",
  "struktur": "Analyse des Aufbaus und der Struktur (3-4 Sätze)",
  "stil": "Analyse des Schreibstils und seiner Konsistenz (3-4 Sätze)",
  "staerken": ["Stärke 1", "Stärke 2", "Stärke 3"],
  "schwaechen": ["Schwäche 1", "Schwäche 2"],
  "empfehlungen": ["Empfehlung 1", "Empfehlung 2", "Empfehlung 3"],
  "fazit": "Abschliessendes Urteil in 1-2 Sätzen"
}

Buchinhalt (${pageCount} Seiten):

${bookText}`;
}

export function buildChapterAnalysisPrompt(chapterName, bookName, pageCount, chText) {
  return `Analysiere das Kapitel «${chapterName}» aus dem Buch «${bookName}».
Lies den vollständigen Kapiteltext und gib eine kompakte Analyse als JSON zurück:

Antworte mit diesem JSON-Schema:
{
  "themen": "Hauptthemen und Inhalte in 2-3 Sätzen",
  "stil": "Schreibstilbeobachtungen: Wortwahl, Satzbau, Ton in 2 Sätzen",
  "qualitaet": "Allgemeiner Qualitätseindruck in 1-2 Sätzen",
  "staerken": ["konkrete Stärke 1", "konkrete Stärke 2"],
  "schwaechen": ["konkrete Schwäche 1", "konkrete Schwäche 2"]
}

Kapitelinhalt (${pageCount} Seiten):

${chText}`;
}

export function buildBookReviewMultiPassPrompt(bookName, chapterAnalyses, totalPageCount) {
  const synthIn = chapterAnalyses.map((ca, i) =>
    `## Kapitel ${i + 1}: ${ca.name} (${ca.pageCount} Seiten)\nThemen: ${ca.themen || '–'}\nStil: ${ca.stil || '–'}\nQualität: ${ca.qualitaet || '–'}\nStärken: ${(ca.staerken || []).join(' | ')}\nSchwächen: ${(ca.schwaechen || []).join(' | ')}`
  ).join('\n\n');
  return `Bewerte das Buch «${bookName}» kritisch und umfassend.
Grundlage sind die Analysen aller ${chapterAnalyses.length} Kapitel (insgesamt ${totalPageCount} Seiten).

GEWICHTUNG: Stil, Sprache und literarische Qualität sind die zentralen Bewertungskriterien und fliessen stärker in die Gesamtnote ein als Rechtschreib- oder Grammatikfehler.

Kapitelanalysen:

${synthIn}

Antworte mit diesem JSON-Schema:
{
  "gesamtnote": "Zahl von 1 (sehr schwach) bis 6 (ausgezeichnet)",
  "gesamtnote_begruendung": "Ein Satz warum diese Note",
  "zusammenfassung": "2-3 Sätze Gesamteindruck",
  "struktur": "Analyse des Aufbaus und der Struktur über alle Kapitel (3-5 Sätze)",
  "stil": "Analyse des Schreibstils und seiner Konsistenz über das gesamte Buch (3-5 Sätze)",
  "staerken": ["Stärke 1", "Stärke 2", "Stärke 3"],
  "schwaechen": ["Schwäche 1", "Schwäche 2"],
  "empfehlungen": ["Empfehlung 1", "Empfehlung 2", "Empfehlung 3"],
  "fazit": "Abschliessendes Urteil in 1-3 Sätzen"
}`;
}

// ── Figurenextraktion ─────────────────────────────────────────────────────────

const FIGUREN_SCHEMA = `{
  "figuren": [
    {
      "id": "fig_1",
      "name": "Vollständiger Name",
      "kurzname": "Vorname oder Spitzname",
      "typ": "hauptfigur|nebenfigur|antagonist|mentor|andere",
      "geburtstag": "JJJJ oder leer wenn unbekannt",
      "geschlecht": "männlich|weiblich|divers|unbekannt",
      "beruf": "Beruf oder Rolle oder leer",
      "beschreibung": "2-3 Sätze zu Rolle, Persönlichkeit und Bedeutung",
      "sozialschicht": "wirtschaftselite|gehobenes_buergertum|mittelschicht|arbeiterschicht|migrantenmilieu|prekariat|unterwelt|andere",
      "eigenschaften": ["Eigenschaft1", "Eigenschaft2"],
      "lebensereignisse": [{ "datum": "JJJJ (nur Jahreszahl; falls nicht direkt genannt aus Kontext errechnen – z.B. Geburtsjahr + damaliges Alter, oder bekannte historische Jahreszahl; leer lassen wenn nicht errechenbar)", "ereignis": "Was passierte (1 Satz)", "typ": "persoenlich|extern", "bedeutung": "Bedeutung für die Figur (1 Satz, leer wenn nicht klar)", "kapitel": "Kapitelname wo dieses Ereignis erwähnt wird (leer wenn unklar)" }],
      "kapitel": [{ "name": "Kapitelname", "haeufigkeit": 3 }],
      "beziehungen": [{ "figur_id": "fig_2", "typ": "elternteil|geschwister|kind|freund|feind|kollege|bekannt|liebesbeziehung|rivale|mentor|schuetzling|patronage|geschaeft|andere", "machtverhaltnis": 0, "beschreibung": "1 Satz" }]
    }
  ]
}`;

const FIGUREN_RULES = `Regeln:
- Eindeutige IDs (fig_1, fig_2, …)
- beziehungen.figur_id: nur IDs aus dieser Liste; jede Beziehung nur einmal eintragen
- kapitel: absteigend nach Häufigkeit; haeufigkeit = Anzahl Seiten/Abschnitte mit aktivem Auftreten
- lebensereignisse: chronologisch sortiert; kapitel = Kapitelname aus dem der Textbeleg stammt (leer wenn unklar); datum immer als vierstellige Jahreszahl (JJJJ) – falls nicht direkt erwähnt, aus Kontext errechnen (Geburtsjahr der Figur + genannte Altersangabe, bekannte historische Jahreszahlen u.ä.); Events ohne errechenbare Jahreszahl weglassen; typ='persoenlich' nur für echte biografische Wendepunkte (neue Beziehung, Trennung, Jobwechsel, Verlust einer nahestehenden Person, Pubertät/Reifung, Umzug, Trauma, wichtige Entscheidung) – keine Alltagshandlungen oder Szenen die keine bleibende Wirkung haben; typ='extern' für gesellschaftliche/historische Ereignisse (Katastrophen, Massaker, Kriege, politische Umbrüche u.ä.) die die Figur direkt betreffen – hier grosszügig sein, auch erwähnte Ereignisse aufnehmen die nur indirekt wirken
- sozialschicht: gesellschaftliche Schicht der Figur – nur vergeben wenn im Text eindeutig belegt; wirtschaftselite=Unternehmerfamilien, Direktoren, Bankiers (sehr wohlhabend), gehobenes_buergertum=Akademiker in freien Berufen, Ärzte, Anwälte, obere Kader, mittelschicht=Angestellte, Beamte, mittlere Kader, Handwerker mit eigenem Betrieb, arbeiterschicht=Fabrik-/Bauarbeiter, Servicepersonal, einfache Angestellte, migrantenmilieu=Zugewanderte (Saisonniers, Niedergelassene, zweite Generation), prekariat=Sozialhilfeempfänger, Randständige, Langzeitarbeitslose, unterwelt=kriminelles Milieu, andere=nicht eindeutig zuordenbar
- beziehungen.machtverhaltnis: Machtasymmetrie aus Perspektive von figur_id→ «fig_2» als Bezugspunkt: +2=fig_2 dominiert klar, +1=fig_2 hat leichten Vorteil, 0=symmetrisch, -1=fig_1 hat leichten Vorteil, -2=fig_1 dominiert klar; weglassen oder 0 wenn unklar; patronage=Schutzherrschaft/Klientelverhältnis, geschaeft=geschäftliche/wirtschaftliche Beziehung
- Beziehungstypen: elternteil/kind (gerichtet), geschwister (undirektional), übrige selbsterklärend
- Nur fiktive Charaktere oder Figuren die aktiv an der Buchhandlung teilnehmen – keine Orte oder Objekte
- KEINE historischen oder realen Personen die nur erwähnt, zitiert oder als Referenz genannt werden (z.B. Napoleon, Einstein, ein Politiker, eine Künstlerin); solche Personen gehören höchstens als lebensereignis.typ='extern' zu einer Figur, aber nicht als eigene Figur in diese Liste
- Sortiert nach Wichtigkeit
- KONSERVATIV: Nur Figuren, Beziehungen und Ereignisse aufnehmen die im Text eindeutig belegt sind. Lieber weglassen als spekulieren.
- DEDUPLIZIERUNG MIT KONTEXTABGLEICH: Figuren zusammenführen wenn der Name übereinstimmt (gleicher Vor- und Nachname) ODER ein Teilname (nur Vorname oder nur Nachname) mit mindestens einem inhaltlichen Indiz zusammenpasst – z.B. gleicher Beruf, überschneidende Fachkenntnisse, konsistente Charakterzüge oder übereinstimmendes Verhalten kapitelübergreifend. Beispiel: «Maria» die in Kapitel 1 als Kräuterkundige gilt und «Maria Huber» die in Kapitel 3 Naturheilkunde beherrscht – zusammenführen. Widersprechen sich Eigenschaften eindeutig, getrennt behalten. Gibt es nur Namensähnlichkeit ohne inhaltliche Überschneidung: getrennt behalten.`;

export function buildFiguresSinglePassPrompt(bookName, pageCount, bookText) {
  return `Analysiere das Buch «${bookName}» und extrahiere alle wichtigen Figuren.

Antworte mit diesem JSON-Schema:
${FIGUREN_SCHEMA}

${FIGUREN_RULES}

Buchtext (${pageCount} Seiten):

${bookText}`;
}

export function buildFiguresConsolidationPrompt(bookName, chapterFiguren) {
  const synthInput = chapterFiguren.map(cf =>
    `## Kapitel: ${cf.kapitel}\n` + cf.figuren.map(f => {
      const meta = [f.typ, f.beruf, f.geburtstag ? `*${f.geburtstag}` : '', f.geschlecht].filter(Boolean).join(', ');
      return `- ${f.name}${f.kurzname && f.kurzname !== f.name ? ` («${f.kurzname}»)` : ''} (${meta}): ${f.beschreibung || ''}` +
        (f.eigenschaften?.length ? '\n  Eigenschaften: ' + f.eigenschaften.join(', ') : '') +
        (f.beziehungen?.length ? '\n  Beziehungen: ' + f.beziehungen.map(b => `${b.name} [${b.typ}]`).join(', ') : '') +
        (f.lebensereignisse?.length ? '\n  Lebensereignisse:\n' + f.lebensereignisse.map(e =>
          `    - datum: ${e.datum || ''}, typ: ${e.typ || 'persoenlich'}, ereignis: ${e.ereignis || ''}` +
          (e.bedeutung ? `, bedeutung: ${e.bedeutung}` : '') +
          (e.kapitel ? `, kapitel: ${e.kapitel}` : '')
        ).join('\n') : '');
    }).join('\n')
  ).join('\n\n');
  return `Konsolidiere die folgenden Figurenanalysen aller Kapitel des Buchs «${bookName}» zu einer einheitlichen Gesamtliste. Dedupliziere Figuren, führe Informationen zusammen und vergib stabile IDs.

Kapitelanalysen:

${synthInput}

${JSON_ONLY}

Antworte mit diesem JSON-Schema:
${FIGUREN_SCHEMA}

${FIGUREN_RULES}`;
}

// ── Figurenextraktion (Basis – ohne Lebensereignisse) ─────────────────────────

const FIGUREN_BASIS_SCHEMA = `{
  "figuren": [
    {
      "id": "fig_1",
      "name": "Vollständiger Name",
      "kurzname": "Vorname oder Spitzname",
      "typ": "hauptfigur|nebenfigur|antagonist|mentor|andere",
      "geburtstag": "JJJJ oder leer wenn unbekannt",
      "geschlecht": "männlich|weiblich|divers|unbekannt",
      "beruf": "Beruf oder Rolle oder leer",
      "beschreibung": "2-3 Sätze zu Rolle, Persönlichkeit und Bedeutung",
      "sozialschicht": "wirtschaftselite|gehobenes_buergertum|mittelschicht|arbeiterschicht|migrantenmilieu|prekariat|unterwelt|andere",
      "eigenschaften": ["Eigenschaft1", "Eigenschaft2"],
      "kapitel": [{ "name": "Kapitelname", "haeufigkeit": 3 }],
      "beziehungen": [{ "figur_id": "fig_2", "typ": "elternteil|geschwister|kind|freund|feind|kollege|bekannt|liebesbeziehung|rivale|mentor|schuetzling|patronage|geschaeft|andere", "machtverhaltnis": 0, "beschreibung": "1 Satz" }]
    }
  ]
}`;

const FIGUREN_BASIS_RULES = `Regeln:
- Eindeutige IDs (fig_1, fig_2, …)
- beziehungen.figur_id: nur IDs aus dieser Liste; jede Beziehung nur einmal eintragen
- kapitel: absteigend nach Häufigkeit; haeufigkeit = Anzahl Seiten/Abschnitte mit aktivem Auftreten; name = immer der Kapitelname (aus dem ## Kapitel-Header über dem Abschnitt oder aus dem Prompt-Kontext) – NIEMALS Seitentitel als Kapitelnamen verwenden
- sozialschicht: gesellschaftliche Schicht der Figur – nur vergeben wenn eindeutig belegt; wirtschaftselite=Unternehmerfamilien/Direktoren, gehobenes_buergertum=Akademiker/freie Berufe/obere Kader, mittelschicht=Angestellte/Beamte/mittlere Kader, arbeiterschicht=Fabrik-/Bauarbeiter/Servicepersonal, migrantenmilieu=Zugewanderte/zweite Generation, prekariat=Sozialhilfe/Randständige/Langzeitarbeitslose, unterwelt=kriminelles Milieu, andere=nicht eindeutig
- beziehungen.machtverhaltnis: Machtasymmetrie aus Perspektive der beschriebenen Figur → Bezugspunkt «figur_id»: +2=figur_id dominiert klar, +1=leichter Vorteil, 0=symmetrisch, -1=Bezugsfigur hat leichten Vorteil, -2=Bezugsfigur dominiert; weglassen oder 0 wenn unklar
- Beziehungstypen: elternteil/kind (gerichtet), geschwister (undirektional), patronage=Schutzherrschaft, geschaeft=wirtschaftliche Beziehung, übrige selbsterklärend
- Nur fiktive Charaktere oder Figuren die aktiv an der Buchhandlung teilnehmen – keine Orte oder Objekte
- KEINE historischen oder realen Personen die nur erwähnt, zitiert oder als Referenz genannt werden (z.B. Napoleon, Einstein, ein Politiker, eine Künstlerin)
- Sortiert nach Wichtigkeit
- KONSERVATIV: Nur Figuren und Beziehungen aufnehmen die im Text eindeutig belegt sind. Lieber weglassen als spekulieren.
- DEDUPLIZIERUNG MIT KONTEXTABGLEICH: Figuren zusammenführen wenn der Name übereinstimmt (gleicher Vor- und Nachname) ODER ein Teilname (nur Vorname oder nur Nachname) mit mindestens einem inhaltlichen Indiz zusammenpasst – z.B. gleicher Beruf, überschneidende Fachkenntnisse, konsistente Charakterzüge oder übereinstimmendes Verhalten kapitelübergreifend. Beispiel: «Maria» die in Kapitel 1 als Kräuterkundige gilt und «Maria Huber» die in Kapitel 3 Naturheilkunde beherrscht – zusammenführen. Widersprechen sich Eigenschaften eindeutig, getrennt behalten. Gibt es nur Namensähnlichkeit ohne inhaltliche Überschneidung: getrennt behalten.`;

export function buildFiguresBasisSinglePassPrompt(bookName, pageCount, bookText) {
  return `Analysiere das Buch «${bookName}» und extrahiere alle wichtigen Figuren.

Antworte mit diesem JSON-Schema:
${FIGUREN_BASIS_SCHEMA}

${FIGUREN_BASIS_RULES}

${JSON_ONLY}

Buchtext (${pageCount} Seiten):

${bookText}`;
}

export function buildFiguresBasisChapterPrompt(chapterName, bookName, pageCount, chText) {
  return `Extrahiere alle Figuren aus dem Kapitel «${chapterName}» des Buchs «${bookName}».

Antworte mit diesem JSON-Schema:
${FIGUREN_BASIS_SCHEMA}

${FIGUREN_BASIS_RULES}

Wichtig: Für kapitel[].name aller Figuren in diesem Kapitel immer genau «${chapterName}» verwenden – die ### Überschriften im Text sind Seitentitel, keine Kapitelnamen.

${JSON_ONLY}

Kapiteltext (${pageCount} Seiten):

${chText}`;
}

export function buildFiguresBasisConsolidationPrompt(bookName, chapterFiguren) {
  const synthInput = chapterFiguren.map(cf => {
    // Kapitel-lokale IDs → Namen auflösen, damit Beziehungen kapitelübergreifend eindeutig sind
    const nameById = Object.fromEntries((cf.figuren || []).map(f => [f.id, f.name]));
    return `## Kapitel: ${cf.kapitel}\n` + (cf.figuren || []).map(f => {
      const meta = [f.typ, f.beruf, f.geburtstag ? `*${f.geburtstag}` : '', f.geschlecht].filter(Boolean).join(', ');
      return `- ${f.name}${f.kurzname && f.kurzname !== f.name ? ` («${f.kurzname}»)` : ''} (${meta}): ${f.beschreibung || ''}` +
        (f.eigenschaften?.length ? '\n  Eigenschaften: ' + f.eigenschaften.join(', ') : '') +
        (f.kapitel?.length ? '\n  Kapitel: ' + f.kapitel.map(k => k.name + (k.haeufigkeit > 1 ? ' ×' + k.haeufigkeit : '')).join(', ') : '') +
        (f.beziehungen?.length ? '\n  Beziehungen: ' + f.beziehungen.map(b => {
          const relName = nameById[b.figur_id] || b.name || b.figur_id;
          return `${relName} [${b.typ}]${b.beschreibung ? ': ' + b.beschreibung : ''}`;
        }).join(', ') : '');
    }).join('\n');
  }).join('\n\n');
  return `Konsolidiere die folgenden Figurenanalysen aller Kapitel des Buchs «${bookName}» zu einer einheitlichen Gesamtliste. Dedupliziere Figuren, führe Informationen zusammen und vergib stabile IDs.

Kapitelanalysen:

${synthInput}

${JSON_ONLY}

Antworte mit diesem JSON-Schema:
${FIGUREN_BASIS_SCHEMA}

${FIGUREN_BASIS_RULES}`;
}

// ── Soziogramm-Anreicherung (Sozialschicht + Machtverhältnis) ─────────────────

export function buildFigurSoziogrammEnrichmentPrompt(bookName, figurenList, beziehungenList, kontext = SOZIOGRAMM_KONTEXT) {
  const figurenStr = figurenList.map(f =>
    `- ${f.fig_id}: ${f.name} (${f.typ || 'andere'}${f.beruf ? ', ' + f.beruf : ''}) – ${f.beschreibung || '(keine Beschreibung)'}` +
    (f.eigenschaften?.length ? `\n  Eigenschaften: ${f.eigenschaften.join(', ')}` : '')
  ).join('\n');
  const beziehungenStr = beziehungenList.map(bz =>
    `- ${bz.from_fig_id} → ${bz.to_fig_id} [${bz.typ}]${bz.beschreibung ? ': ' + bz.beschreibung : ''}`
  ).join('\n');
  return `Analysiere die gesellschaftliche Stellung und Machtstrukturen im Buch «${bookName}».

Figuren:
${figurenStr}

Bestehende Beziehungen:
${beziehungenStr}

Antworte mit diesem JSON-Schema:
{
  "figuren": [
    { "fig_id": "fig_1", "sozialschicht": "wirtschaftselite|gehobenes_buergertum|mittelschicht|arbeiterschicht|migrantenmilieu|prekariat|unterwelt|andere" }
  ],
  "beziehungen": [
    { "from_fig_id": "fig_1", "to_fig_id": "fig_2", "machtverhaltnis": 0 }
  ]
}

Regeln:
- sozialschicht: gesellschaftliche Schicht basierend auf Beschreibung und Beruf der Figur${kontext ? ` (${kontext})` : ''}; wirtschaftselite=Unternehmerfamilien, Direktoren, sehr wohlhabende Geschäftsleute; gehobenes_buergertum=Akademiker in freien Berufen (Ärzte, Anwälte, Architekten), obere Kader, etablierte Kaufleute; mittelschicht=Angestellte, Beamte, mittlere Kader, Handwerker mit eigenem Betrieb, Lehrer; arbeiterschicht=Fabrik-/Bauarbeiter, Servicepersonal, einfache Angestellte, Pflegepersonal; migrantenmilieu=Zugewanderte und ihre Familien (Saisonniers, Niedergelassene, zweite/dritte Generation – unabhängig von Beruf, wenn kulturell-ethnische Zugehörigkeit relevant ist); prekariat=Sozialhilfeempfänger, Obdachlose, Randständige, Langzeitarbeitslose, Drogenabhängige; unterwelt=kriminelles Milieu; «andere» nur wenn wirklich unbestimmbar
- machtverhaltnis: Machtasymmetrie aus Perspektive von from_fig_id gegenüber to_fig_id; +2=from_fig dominiert klar (Herr/Knecht, Arbeitgeber/Angestellter, Patron/Klient), +1=from_fig hat leichten strukturellen Vorteil, 0=symmetrisch oder unklar, -1=to_fig hat leichten Vorteil, -2=to_fig dominiert klar; nur vergeben wenn aus Kontext ableitbar, sonst 0
- Jede Figur aus der Liste mit einer sozialschicht belegen (nie weglassen)
- Nur Beziehungen mit machtverhaltnis ≠ 0 in «beziehungen» aufführen – symmetrische Beziehungen weglassen
- KONSERVATIV: Lieber 0 als spekulieren`;
}

// ── Lebensereignisse-Zuordnung ────────────────────────────────────────────────

export function buildFiguresEventAssignmentPrompt(chapterName, bookName, pageCount, figurenList, chText) {
  const figurenStr = figurenList.map(f => `${f.id}: ${f.name} (${f.typ || 'andere'})`).join('\n');
  return `Durchforste den Kapiteltext «${chapterName}» des Buchs «${bookName}» systematisch nach Ereignissen – persönliche Wendepunkte UND externe Ereignisse – und verknüpfe sie mit den betroffenen Figuren.

Bekannte Figuren (nur diese IDs in «fig_id» verwenden):
${figurenStr}

Antworte mit diesem JSON-Schema:
{
  "assignments": [
    {
      "fig_id": "fig_1",
      "lebensereignisse": [
        {
          "datum": "JJJJ (nur Jahreszahl; aus Kontext errechnen wenn nötig – Geburtsjahr + Altersangabe, bekannte historische Jahreszahl; leer lassen wenn nicht errechenbar)",
          "ereignis": "Was passierte (1 Satz)",
          "typ": "persoenlich|extern",
          "bedeutung": "Bedeutung für die Figur (1 Satz, leer wenn nicht klar)",
          "kapitel": "${chapterName}",
          "seite": "Name der Seite/des Abschnitts (aus ### Überschrift; leer wenn unklar)"
        }
      ]
    }
  ]
}

Regeln:
- typ='persoenlich': echte biografische Wendepunkte (Geburt, Tod, Trauma, neue/beendete Beziehung, Jobwechsel, Umzug, wichtige Entscheidung) – nur aufnehmen wenn tatsächlich im Text belegt
- typ='extern': gesellschaftliche/historische Ereignisse – SEHR GROSSZÜGIG erfassen:
  • Kriege, Konflikte, Terroranschläge, Attentate, Amokläufe
  • Politische Umbrüche (Mauerfall, Revolutionen, Regierungswechsel, gesellschaftliche Umwälzungen)
  • Sport- und Kulturereignisse (WM, Olympia, Großveranstaltungen)
  • Wirtschaftskrisen, Seuchen, Naturkatastrophen, Umweltereignisse
  • Auch wenn nur kurz erwähnt, nur angedeutet oder nur indirekt auf Figuren wirkt
  • Jedes externe Ereignis ALLEN Figuren zuweisen die dabei waren, davon betroffen waren oder im Zusammenhang erwähnt werden
- datum: immer als vierstellige Jahreszahl (JJJJ) – falls nicht direkt erwähnt, aus Kontext errechnen (Geburtsjahr + Alter, bekannte historische Jahreszahl); Events ohne errechenbare Jahreszahl weglassen
- Nur Figuren ausgeben die mindestens ein Ereignis haben; leeres assignments-Array wenn keine Ereignisse gefunden
- Nur fig_id-Werte aus der obigen Liste verwenden
- Chronologisch sortiert nach Datum innerhalb jeder Figur

${JSON_ONLY}

Kapiteltext (${pageCount} Seiten):

${chText}`;
}

export function buildSzenenAnalysePrompt(kapitel, figurenKompakt, orteKompakt, chText) {
  const figurenStr = figurenKompakt.length
    ? figurenKompakt.map(f => `${f.id}: ${f.name} (${f.typ})`).join('\n')
    : '(keine Figuren bekannt)';
  const orteStr = orteKompakt.length
    ? orteKompakt.map(o => `${o.id}: ${o.name}`).join('\n')
    : '';
  const orteSection = orteStr
    ? `\nBekannte Schauplätze (nur diese IDs in «orte» verwenden):\n${orteStr}\n`
    : '';
  const orteField = orteStr
    ? `\n      "orte": [${orteKompakt.slice(0, 2).map(o => `"${o.id}"`).join(', ')}],`
    : '';
  const orteRule = orteStr
    ? '\n- orte: IDs der Schauplätze wo die Szene spielt; leer lassen wenn kein passender Ort bekannt'
    : '';
  return `Analysiere die Szenen im Kapitel «${kapitel}».

Bekannte Figuren (nur diese IDs in «figuren» verwenden):
${figurenStr}
${orteSection}
Antworte mit diesem JSON-Schema:
{
  "szenen": [
    {
      "seite": "Name der Seite/des Abschnitts aus dem die Szene stammt (leer wenn unklar)",
      "titel": "Kurze Szenenbezeichnung (1 Satz)",
      "wertung": "stark|mittel|schwach",
      "kommentar": "1-2 Sätze: was funktioniert, was fehlt (Spannung, Tempo, Figurenentwicklung)",
      "figuren": ["fig_1", "fig_2"]${orteField}
    }
  ]
}

Regeln:
- Eine Szene ist ein abgegrenzter Handlungsabschnitt mit eigenem Anfang und Ende
- figuren: nur IDs aus der obigen Liste; leer lassen wenn keine bekannte Figur aktiv beteiligt ist
- wertung: «stark» = spannend/überzeugend, «mittel» = verbesserungswürdig, «schwach» = klare Schwächen
- Wenn ein Abschnitt keine erkennbaren Szenen enthält (reine Exposition, Beschreibung): «szenen» als leeres Array
- Jede erkennbare Szene erfassen; konservativ – lieber weniger, aber treffende Einträge${orteRule}

${JSON_ONLY}

Kapiteltext:
${chText}`;
}

// ── Schauplatz-Schemata (auch verwendet in Komplett-Analyse) ─────────────────

const ORTE_SCHEMA = `{
  "orte": [
    {
      "id": "ort_1",
      "name": "Name des Schauplatz",
      "typ": "stadt|gebaeude|raum|landschaft|region|andere",
      "beschreibung": "2-3 Sätze zu Erscheinungsbild, Atmosphäre, Bedeutung für die Handlung",
      "erste_erwaehnung": "Kapitelname oder Seitenname der ersten Erwähnung (leer wenn unklar)",
      "stimmung": "Grundatmosphäre in 2-3 Worten (z.B. bedrohlich, heimelig, verlassen, belebt)",
      "kapitel": [{ "name": "Kapitelname", "haeufigkeit": 3 }],
      "figuren": ["fig_1", "fig_2"]
    }
  ]
}`;

const ORTE_RULES = `Regeln:
- Eindeutige IDs (ort_1, ort_2, …)
- Nur Schauplätze, die im Text eindeutig beschrieben oder mehrfach genannt werden – keine einmaligen, flüchtigen Erwähnungen
- figuren: nur IDs aus der gelieferten Figurenliste (leer lassen wenn keine Figuren bekannt)
- kapitel: absteigend nach Häufigkeit; haeufigkeit = Anzahl Seiten/Abschnitte in denen der Ort aktiv vorkommt
- KONSERVATIV: Lieber weglassen als spekulieren; maximal 20 Orte`;

// ── Komplett-Analyse (kombinierte Extraktion) ─────────────────────────────────
// Hilfsfunktion: Extrahiert den Inhalt des äussersten Objekts aus einem Schema-String.
// Ermöglicht das Zusammensetzen von Schemas ohne Duplikation der Felddefinitionen.
function _schemaBody(schemaStr) {
  return schemaStr.trim().replace(/^\s*\{\s*/, '').replace(/\s*\}\s*$/, '').trim();
}

// ── Kombiniertes Schema für Komplett-Extraktion (P1+P5 merged) ───────────────
// Statisch – wird zur Ladezeit initialisiert, nachdem alle Abhängigkeiten definiert sind.
// buildSystemKomplett() bettet es in den System-Prompt ein → Caching über alle Kapitel-Calls.
// figuren_namen / orte_namen / figur_name: Klarnamen statt IDs, da konsolidierte IDs
// erst nach P2/P3 bekannt sind. Remapping nach der Konsolidierung in jobs.js.
const KOMPLETT_SCHEMA_STATIC = `Antworte mit diesem JSON-Schema:
{
  ${_schemaBody(FIGUREN_BASIS_SCHEMA)},
  ${_schemaBody(ORTE_SCHEMA)},
  "fakten": [
    {
      "kategorie": "figur|ort|objekt|zeit|ereignis|soziolekt|sonstiges",
      "subjekt": "Über wen/was geht es (Name oder Bezeichnung)",
      "fakt": "Was genau behauptet wird (1 Satz, so präzise wie möglich)",
      "seite": "Seitenname oder Abschnittsname (leer wenn unklar)"
    }
  ],
  "szenen": [
    {
      "seite": "Name der Seite/des Abschnitts (leer wenn unklar)",
      "kapitel": "Kapitelname (aus dem ## Kapitel-Header über diesem Abschnitt; leer wenn unklar)",
      "titel": "Kurze Szenenbezeichnung (1 Satz)",
      "wertung": "stark|mittel|schwach",
      "kommentar": "1-2 Sätze: was funktioniert, was fehlt (Spannung, Tempo, Figurenentwicklung)",
      "figuren_namen": ["Figurenname exakt wie im Text"],
      "orte_namen": ["Schauplatzname exakt wie im Text"]
    }
  ],
  "assignments": [
    {
      "figur_name": "Figurenname exakt wie im Text",
      "lebensereignisse": [
        {
          "datum": "JJJJ (nur Jahreszahl; aus Kontext errechnen wenn nötig; leer wenn nicht errechenbar)",
          "ereignis": "Was passierte (1 Satz)",
          "typ": "persoenlich|extern",
          "bedeutung": "Bedeutung für die Figur (1 Satz, leer wenn nicht klar)",
          "seite": "Name der Seite/des Abschnitts (leer wenn unklar)",
          "kapitel": "Kapitelname (aus dem ## Kapitel-Header über diesem Abschnitt; leer wenn unklar)"
        }
      ]
    }
  ]
}

Figuren-Regeln:
${FIGUREN_BASIS_RULES}

Schauplatz-Regeln:
${ORTE_RULES}

Fakten-Regeln:
- Nur konkrete, prüfbare Aussagen – keine Interpretationen
- Figuren-Zustände besonders genau erfassen (Wissen, Können, körperlicher Zustand, Wohnort, Beruf)
- Soziolekt: Wenn eine Figur erstmals oder markant spricht, ein Faktum erfassen das ihr Sprachregister beschreibt. Kategorie «soziolekt» verwenden.
- Objekte: Wer besitzt was, wo liegt was, in welchem Zustand
- Zeitangaben: Relative («am nächsten Morgen») und absolute («1943») erfassen
- Maximal 30 Fakten pro Kapitel; lieber weniger, dafür präzise

Szenen-Regeln:
- Eine Szene ist ein abgegrenzter Handlungsabschnitt mit eigenem Anfang und Ende
- figuren_namen: aktiv beteiligte Figuren – Namen exakt wie im Text (vollständiger Name oder Spitzname); leeres Array wenn keine Figur beteiligt
- orte_namen: Schauplatz der Szene – exakter Name wie im Text; leeres Array wenn kein konkreter Ort erwähnt
- wertung: «stark» = überzeugend/spannend, «mittel» = verbesserungswürdig, «schwach» = klare Schwächen
- Wenn ein Abschnitt keine erkennbaren Szenen enthält (reine Exposition, Beschreibung): «szenen» als leeres Array

Ereignis-Regeln:
- typ='persoenlich': echte biografische Wendepunkte (Geburt, Tod, Trauma, neue/beendete Beziehung, Jobwechsel, Umzug, wichtige Entscheidung) – nur wenn tatsächlich im Text belegt
- typ='extern': gesellschaftliche/historische Ereignisse – SEHR GROSSZÜGIG erfassen: Kriege, politische Umbrüche, Sport- und Kulturereignisse, Wirtschaftskrisen, Seuchen, Naturkatastrophen; auch wenn nur kurz erwähnt; jedes externe Ereignis ALLEN betroffenen Figuren zuweisen
- datum: immer als vierstellige Jahreszahl (JJJJ) – aus Kontext errechnen wenn nötig; Events ohne errechenbare Jahreszahl weglassen
- figur_name: exakt wie in figuren[].name dieser Antwort (kanonischen Namen aus der Figurenliste verwenden, KEINE Textvariante, kein Titel, kein Spitzname der dort nicht steht)
- Nur Figuren ausgeben die mindestens ein Ereignis haben; leeres assignments-Array wenn keine Ereignisse gefunden`;

// buildSystemKomplett: wie buildSystem, aber mit eingebettetem KOMPLETT_SCHEMA_STATIC.
// Der Schema-Block wird so gecacht (cache_control: ephemeral in lib/ai.js) – spart bei
// ~20 Kapitel-Calls ~19 × Schema-Tokens (statt in jeder User-Message wiederholen).
// Hinweis: KOMPLETT_SCHEMA_STATIC ist zur Ladezeit verfügbar (const, nach _schemaBody definiert);
// buildSystemKomplett wird erst nach Modul-Initialisierung aufgerufen (via configurePrompts).
function buildSystemKomplett(prefix, rules) {
  return `${prefix}\n\n${rules}\n\n${KOMPLETT_SCHEMA_STATIC}\n\n${JSON_ONLY}`;
}

/**
 * Kombinierter Kapitel-Extraktions-Prompt: Figuren + Schauplätze in einem einzigen Call.
 * Referenziert FIGUREN_BASIS_SCHEMA, FIGUREN_BASIS_RULES, ORTE_SCHEMA, ORTE_RULES direkt –
 * keine Duplikation. Wird ausschliesslich vom komplett-analyse-Job verwendet.
 */
export function buildExtraktionFigurenOrteChapterPrompt(chapterName, bookName, pageCount, chText) {
  const isSinglePass = chapterName === 'Gesamtbuch';
  const kapitelNote = isSinglePass
    ? 'Für kapitel[].name der Figuren den jeweiligen Kapitelnamen aus dem [Kapitelname]-Teil der ### Überschriften verwenden.'
    : `Für kapitel[].name aller Figuren immer genau «${chapterName}» verwenden – die ### Überschriften im Text sind Seitentitel, keine Kapitelnamen.`;
  return `Extrahiere alle Figuren und Schauplätze aus ${isSinglePass ? `dem Buch «${bookName}»` : `dem Kapitel «${chapterName}» des Buchs «${bookName}»`}.

Antworte mit diesem JSON-Schema:
{
  ${_schemaBody(FIGUREN_BASIS_SCHEMA)},
  ${_schemaBody(ORTE_SCHEMA)}
}

Figuren-Regeln:
${FIGUREN_BASIS_RULES}
${kapitelNote}

Schauplatz-Regeln:
${ORTE_RULES}

${JSON_ONLY}

${isSinglePass ? `Buchtext (${pageCount} Seiten)` : `Kapiteltext (${pageCount} Seiten)`}:

${chText}`;
}

/**
 * Kombinierter Kapitel-Pass (P1+P8f): Figuren + Schauplätze + Kontinuitätsfakten in einem Call.
 * Ersetzt buildExtraktionFigurenOrteChapterPrompt + buildKontinuitaetChapterFactsPrompt
 * im komplett-analyse-Job. Wird ausschliesslich dort verwendet.
 */
export function buildExtraktionFigurenOrteKontinuitaetChapterPrompt(chapterName, bookName, pageCount, chText) {
  const isSinglePass = chapterName === 'Gesamtbuch';
  const kapitelNote = isSinglePass
    ? 'Für kapitel[].name der Figuren den jeweiligen Kapitelnamen aus dem [Kapitelname]-Teil der ### Überschriften verwenden.'
    : `Für kapitel[].name aller Figuren immer genau «${chapterName}» verwenden – die ### Überschriften im Text sind Seitentitel, keine Kapitelnamen.`;
  return `Extrahiere aus ${isSinglePass ? `dem Buch «${bookName}»` : `dem Kapitel «${chapterName}» des Buchs «${bookName}»`} in einem Durchgang: alle Figuren, alle Schauplätze und alle kontinuitätsrelevanten Fakten.

Antworte mit diesem JSON-Schema:
{
  ${_schemaBody(FIGUREN_BASIS_SCHEMA)},
  ${_schemaBody(ORTE_SCHEMA)},
  "fakten": [
    {
      "kategorie": "figur|ort|objekt|zeit|ereignis|soziolekt|sonstiges",
      "subjekt": "Über wen/was geht es (Name oder Bezeichnung)",
      "fakt": "Was genau behauptet wird (1 Satz, so präzise wie möglich)",
      "seite": "Seitenname oder Abschnittsname (leer wenn unklar)"
    }
  ]
}

Figuren-Regeln:
${FIGUREN_BASIS_RULES}
${kapitelNote}

Schauplatz-Regeln:
${ORTE_RULES}

Fakten-Regeln:
- Nur konkrete, prüfbare Aussagen – keine Interpretationen
- Figuren-Zustände besonders genau erfassen (Wissen, Können, körperlicher Zustand, Wohnort, Beruf)
- Soziolekt: Wenn eine Figur erstmals oder markant spricht, ein Faktum erfassen das ihr Sprachregister beschreibt (z.B. «spricht formell-gebildet», «verwendet Dialekt»). Kategorie «soziolekt» verwenden.
- Objekte: Wer besitzt was, wo liegt was, in welchem Zustand
- Zeitangaben: Relative («am nächsten Morgen») und absolute («1943») erfassen
- Maximal 30 Fakten${isSinglePass ? '' : ' pro Kapitel'}; lieber weniger, dafür präzise

${JSON_ONLY}

${isSinglePass ? `Buchtext (${pageCount} Seiten)` : `Kapiteltext (${pageCount} Seiten)`}:

${chText}`;
}

/**
 * Kombinierter Vollextraktion-Prompt (P1 + P5 in einem Call):
 * Figuren + Schauplätze + Kontinuitätsfakten + Szenen + Lebensereignisse.
 *
 * Schema und Regeln leben im System-Prompt (SYSTEM_KOMPLETT_EXTRAKTION) – diese User-Message
 * enthält nur den Kapiteltext und den chapter-spezifischen Kapitelnamen-Hinweis.
 * Szenen und Assignments verwenden Klarnamen (figuren_namen / orte_namen / figur_name)
 * statt IDs – das Remapping auf konsolidierte IDs erfolgt in jobs.js nach P2/P3.
 *
 * Ersetzt buildExtraktionFigurenOrteKontinuitaetChapterPrompt + buildExtraktionSzenenEreignisseChapterPrompt.
 */
export function buildExtraktionKomplettChapterPrompt(chapterName, bookName, pageCount, chText) {
  const isSinglePass = chapterName === 'Gesamtbuch';
  const scope = isSinglePass ? `dem Buch «${bookName}»` : `dem Kapitel «${chapterName}» des Buchs «${bookName}»`;
  const kapitelNote = isSinglePass
    ? 'Der Text ist in Kapitel-Sektionen gegliedert (## Kapitelname) mit Seiten darunter (### Seitentitel). Für alle Kapitel-Felder (kapitel[].name der Figuren und Orte, szenen[].kapitel, lebensereignisse[].kapitel): den Kapitelnamen exakt aus dem ## Header entnehmen, unter dem der jeweilige Abschnitt steht.'
    : `Für alle Kapitel-Felder (kapitel[].name der Figuren und Orte, szenen[].kapitel, lebensereignisse[].kapitel): immer genau «${chapterName}» verwenden – die ### Überschriften im Text sind Seitentitel, keine Kapitelnamen.`;
  return `Extrahiere aus ${scope} in einem Durchgang: alle Figuren, alle Schauplätze, alle kontinuitätsrelevanten Fakten, alle Szenen und alle Lebensereignisse der Figuren.

${kapitelNote}

${isSinglePass ? `Buchtext (${pageCount} Seiten)` : `Kapiteltext (${pageCount} Seiten)`}:

${chText}`;
}

/**
 * Kombinierter Kapitel-Extraktions-Prompt: Szenen + Lebensereignisse in einem einzigen Call.
 * Setzt konsolidierte Figuren und Orte aus der DB voraus (nach Phase 1+2 der Komplettanalyse).
 * @deprecated Ersetzt durch buildExtraktionKomplettChapterPrompt (P1+P5 merged).
 */
export function buildExtraktionSzenenEreignisseChapterPrompt(chapterName, bookName, pageCount, figurenKompakt, orteKompakt, chText) {
  const figurenStr = figurenKompakt.length
    ? figurenKompakt.map(f => `${f.id}: ${f.name} (${f.typ || 'andere'})`).join('\n')
    : '(keine Figuren bekannt)';
  const orteStr = orteKompakt.length
    ? orteKompakt.map(o => `${o.id}: ${o.name}`).join('\n')
    : '(keine Schauplätze bekannt)';
  return `Analysiere das Kapitel «${chapterName}» des Buchs «${bookName}» und extrahiere gleichzeitig Szenen und Lebensereignisse der Figuren.

Bekannte Figuren (nur diese IDs verwenden):
${figurenStr}

Bekannte Schauplätze (nur diese IDs in «orte» verwenden):
${orteStr}

Antworte mit diesem JSON-Schema:
{
  "szenen": [
    {
      "seite": "Name der Seite/des Abschnitts (leer wenn unklar)",
      "titel": "Kurze Szenenbezeichnung (1 Satz)",
      "wertung": "stark|mittel|schwach",
      "kommentar": "1-2 Sätze: was funktioniert, was fehlt (Spannung, Tempo, Figurenentwicklung)",
      "figuren": ["fig_1", "fig_2"],
      "orte": ["ort_1"]
    }
  ],
  "assignments": [
    {
      "fig_id": "fig_1",
      "lebensereignisse": [
        {
          "datum": "JJJJ (nur Jahreszahl; aus Kontext errechnen wenn nötig; leer wenn nicht errechenbar)",
          "ereignis": "Was passierte (1 Satz)",
          "typ": "persoenlich|extern",
          "bedeutung": "Bedeutung für die Figur (1 Satz, leer wenn nicht klar)",
          "kapitel": "${chapterName}",
          "seite": "Name der Seite/des Abschnitts (aus ### Überschrift; leer wenn unklar)"
        }
      ]
    }
  ]
}

Szenen-Regeln:
- Eine Szene ist ein abgegrenzter Handlungsabschnitt mit eigenem Anfang und Ende
- figuren: nur IDs aus der obigen Figurenliste; leer wenn keine bekannte Figur aktiv beteiligt
- orte: nur IDs aus der Schauplatzliste; leer wenn kein passender Ort bekannt
- wertung: «stark» = überzeugend, «mittel» = verbesserungswürdig, «schwach» = klare Schwächen
- Wenn ein Abschnitt keine erkennbaren Szenen enthält (reine Exposition, Beschreibung): «szenen» als leeres Array

Ereignis-Regeln:
- typ='persoenlich': echte biografische Wendepunkte (Geburt, Tod, Trauma, neue/beendete Beziehung, Jobwechsel, Umzug, wichtige Entscheidung) – nur wenn tatsächlich im Text belegt
- typ='extern': gesellschaftliche/historische Ereignisse – SEHR GROSSZÜGIG erfassen: Kriege, politische Umbrüche, Sport- und Kulturereignisse, Wirtschaftskrisen, Seuchen, Naturkatastrophen; auch wenn nur kurz erwähnt; jedes externe Ereignis ALLEN betroffenen Figuren zuweisen
- datum: immer als vierstellige Jahreszahl (JJJJ) – aus Kontext errechnen wenn nötig; Events ohne errechenbare Jahreszahl weglassen
- Nur fig_id-Werte aus der obigen Figurenliste verwenden
- Nur Figuren ausgeben die mindestens ein Ereignis haben; leeres assignments-Array wenn keine Ereignisse gefunden

${JSON_ONLY}

Kapiteltext (${pageCount} Seiten):

${chText}`;
}

export function buildZeitstrahlConsolidationPrompt(events) {
  return `Du erhältst eine Liste von Lebensereignissen verschiedener Figuren aus einem Buch. Erkenne semantisch identische oder sehr ähnliche Ereignisse (gleicher realer Vorfall, nur unterschiedlich formuliert) und fasse sie zu einem einzigen Eintrag zusammen. Führe die Figurenlisten zusammen und wähle die präziseste Formulierung.

Ereignisse die sich inhaltlich unterscheiden, bleiben getrennt – auch wenn sie im selben Jahr stattfanden.

Antworte mit diesem JSON-Schema:
{
  "ereignisse": [
    {
      "datum": "JJJJ",
      "ereignis": "kanonische Formulierung",
      "typ": "persoenlich|extern",
      "bedeutung": "zusammengeführte Bedeutung oder leer",
      "kapitel": ["Kapitelname1", "Kapitelname2"],
      "seiten": ["Seite1", "Seite2"],
      "figuren": [{ "id": "fig_1", "name": "Name", "typ": "hauptfigur|nebenfigur|antagonist|mentor|andere" }]
    }
  ]
}

Regeln:
- Behalte die chronologische Reihenfolge (aufsteigend nach Jahreszahl)
- Dedupliziere figuren (gleiche id nur einmal pro Ereignis)
- kapitel: Alle Kapitel der zusammengeführten Ereignisse beibehalten (Union der Arrays, Duplikate entfernen)
- seiten: Alle Seiten der zusammengeführten Ereignisse beibehalten (Union der Arrays, Duplikate entfernen)
- Im Zweifel getrennt lassen – nur eindeutige Übereinstimmungen zusammenführen

${JSON_ONLY}

Ereignisse:
${JSON.stringify(events, null, 2)}`;
}

// ── Chat ──────────────────────────────────────────────────────────────────────

/**
 * Baut den vollständigen System-Prompt für den Seiten-Chat.
 * @param {string}   pageName   Name der Seite
 * @param {string}   pageText   Seiteninhalt als Plaintext
 * @param {Array}    figuren    Figuren-Array aus der DB (kann leer sein)
 * @param {Object}   review     Letzte Buchbewertung aus der DB (kann null sein)
 */
export function buildChatSystemPrompt(pageName, pageText, figuren, review, systemOverride = null) {
  const parts = [
    systemOverride ?? SYSTEM_CHAT,
    '',
    `Aktuelle Seite: «${pageName}»`,
    '',
    '=== SEITENINHALT ===',
    pageText,
    '',
  ];

  if (figuren && figuren.length > 0) {
    parts.push('=== FIGUREN DES BUCHS ===');
    parts.push(JSON.stringify(figuren, null, 2));
    parts.push('');
  }

  if (review) {
    parts.push('=== LETZTE BUCHBEWERTUNG ===');
    parts.push(JSON.stringify({
      gesamtnote:  review.gesamtnote,
      fazit:       review.fazit,
      staerken:    review.staerken,
      schwaechen:  review.schwaechen,
    }, null, 2));
    parts.push('');
  }

  parts.push(
    'Antworte immer im folgenden JSON-Format:',
    '{',
    '  "antwort": "Deine Antwort als Freitext (Markdown erlaubt)",',
    '  "vorschlaege": [',
    '    {',
    '      "original": "exakter Originaltext aus der Seite (zeichengenau)",',
    '      "ersatz": "Ersatztext",',
    '      "begruendung": "kurze Begründung"',
    '    }',
    '  ]',
    '}',
    '',
    'vorschlaege ist ein leeres Array wenn keine konkreten Textänderungen sinnvoll sind.',
    'original muss zeichengenau mit dem Seitentext übereinstimmen.',
    '',
    JSON_ONLY,
  );

  return parts.join('\n');
}

/**
 * Baut den vollständigen System-Prompt für den Buch-Chat (kein Vorschläge-System).
 * @param {string}  bookName       Name des Buchs
 * @param {Array}   relevantPages  Ausgewählte Seiten [{name, text}] (bereits auf Budget gekürzt)
 * @param {Array}   figuren        Figuren-Array aus der DB (kann leer sein)
 * @param {Object}  review         Letzte Buchbewertung aus der DB (kann null sein)
 */
export function buildBookChatSystemPrompt(bookName, relevantPages, figuren, review, systemOverride = null) {
  const parts = [
    systemOverride ?? SYSTEM_BOOK_CHAT,
    '',
    `Buch: «${bookName}»`,
    '',
  ];

  if (relevantPages && relevantPages.length > 0) {
    parts.push('=== RELEVANTE BUCHSEITEN ===');
    for (const page of relevantPages) {
      parts.push(`--- Seite: ${page.name} ---`);
      parts.push(page.text);
      parts.push('');
    }
  }

  if (figuren && figuren.length > 0) {
    parts.push('=== FIGUREN DES BUCHS ===');
    parts.push(JSON.stringify(figuren, null, 2));
    parts.push('');
  }

  if (review) {
    parts.push('=== LETZTE BUCHBEWERTUNG ===');
    parts.push(JSON.stringify({
      gesamtnote:  review.gesamtnote,
      fazit:       review.fazit,
      staerken:    review.staerken,
      schwaechen:  review.schwaechen,
    }, null, 2));
    parts.push('');
  }

  parts.push(
    'Antworte immer im folgenden JSON-Format:',
    '{',
    '  "antwort": "Deine Antwort als Freitext (Markdown erlaubt)"',
    '}',
    '',
    JSON_ONLY,
  );

  return parts.join('\n');
}

// ── Schauplatz-Extraktion ─────────────────────────────────────────────────────

export function buildLocationsSinglePassPrompt(bookName, pageCount, bookText, figurenKompakt) {
  const figurenStr = figurenKompakt && figurenKompakt.length
    ? '\n\nBekannte Figuren (nur diese IDs in «figuren» verwenden):\n' + figurenKompakt.map(f => `${f.id}: ${f.name}`).join('\n')
    : '';
  return `Analysiere das Buch «${bookName}» und extrahiere alle wichtigen Schauplätze und Orte.${figurenStr}

Antworte mit diesem JSON-Schema:
${ORTE_SCHEMA}

${ORTE_RULES}

${JSON_ONLY}

Buchtext (${pageCount} Seiten):

${bookText}`;
}

export function buildLocationsChapterPrompt(chapterName, bookName, pageCount, chText, figurenKompakt) {
  const figurenStr = figurenKompakt && figurenKompakt.length
    ? '\n\nBekannte Figuren (nur diese IDs in «figuren» verwenden):\n' + figurenKompakt.map(f => `${f.id}: ${f.name}`).join('\n')
    : '';
  return `Extrahiere alle Schauplätze aus dem Kapitel «${chapterName}» des Buchs «${bookName}».${figurenStr}

Antworte mit:
{ "orte": [{ "name": "Name", "typ": "stadt|gebaeude|raum|landschaft|region|andere", "beschreibung": "1-2 Sätze", "erste_erwaehnung": "${chapterName}", "stimmung": "Atmosphäre", "kapitel": [{"name": "${chapterName}", "haeufigkeit": 1}], "figuren": [] }] }

Nur Schauplätze die im Text eindeutig beschrieben sind. Sei konservativ.

${JSON_ONLY}

Kapiteltext (${pageCount} Seiten):

${chText}`;
}

export function buildLocationsConsolidationPrompt(bookName, chapterOrte, figurenKompakt) {
  const synthInput = chapterOrte.map(co =>
    `## Kapitel: ${co.kapitel}\n` + co.orte.map(o =>
      `- ${o.name} (${o.typ || 'andere'}): ${o.beschreibung || ''}` +
      (o.stimmung ? ` | Stimmung: ${o.stimmung}` : '') +
      (o.kapitel?.length ? ` | Kapitel: ` + o.kapitel.map(k => k.name + (k.haeufigkeit > 1 ? ' ×' + k.haeufigkeit : '')).join(', ') : '')
    ).join('\n')
  ).join('\n\n');
  const figurenStr = figurenKompakt && figurenKompakt.length
    ? '\n\nBekannte Figuren (nur diese IDs in «figuren» verwenden):\n' + figurenKompakt.map(f => `${f.id}: ${f.name}`).join('\n')
    : '';
  return `Konsolidiere die folgenden Schauplatz-Analysen aller Kapitel des Buchs «${bookName}» zu einer einheitlichen Gesamtliste. Dedupliziere, führe Informationen zusammen und vergib stabile IDs.${figurenStr}

Kapitelanalysen:

${synthInput}

${JSON_ONLY}

Antworte mit diesem JSON-Schema:
${ORTE_SCHEMA}

${ORTE_RULES}`;
}

// ── Kontinuitätsprüfung ───────────────────────────────────────────────────────

export function buildKontinuitaetChapterFactsPrompt(chapterName, chText) {
  return `Extrahiere alle konkreten Fakten und Behauptungen aus dem Kapitel «${chapterName}» die für die Kontinuitätsprüfung relevant sind: Figuren-Zustände (lebendig/tot, Verletzungen, Wissen, Beziehungen), Ortsbeschreibungen, Zeitangaben, Objekte und deren Besitz/Zustand, sowie wichtige Handlungsereignisse.

Antworte mit diesem JSON-Schema:
{
  "fakten": [
    {
      "kategorie": "figur|ort|objekt|zeit|ereignis|soziolekt|sonstiges",
      "subjekt": "Über wen/was geht es (Name oder Bezeichnung)",
      "fakt": "Was genau behauptet wird (1 Satz, so präzise wie möglich)",
      "seite": "Seitenname oder Abschnittsname (leer wenn unklar)"
    }
  ]
}

Regeln:
- Nur konkrete, prüfbare Aussagen – keine Interpretationen
- Figuren-Zustände besonders genau erfassen (Wissen, Können, körperlicher Zustand, Wohnort, Beruf)
- Soziolekt: Wenn eine Figur hier erstmals oder markant spricht, ein Faktum erfassen das ihr Sprachregister beschreibt (z.B. «spricht formell-gebildet», «verwendet Dialekt und Umgangssprache», «benutzt Fachjargon aus Bereich X»). Kategorie «soziolekt» verwenden.
- Objekte: Wer besitzt was, wo liegt was, in welchem Zustand
- Zeitangaben: Relative («am nächsten Morgen») und absolute («1943») erfassen
- Maximal 30 Fakten pro Kapitel; lieber weniger, dafür präzise

${JSON_ONLY}

Kapiteltext:

${chText}`;
}

export function buildKontinuitaetCheckPrompt(bookName, chapterFacts, figurenKompakt, orteKompakt) {
  const factsText = chapterFacts.map(cf =>
    `## ${cf.kapitel}\n` + cf.fakten.map(f => `[${f.kategorie}] ${f.subjekt}: ${f.fakt}${f.seite ? ` (${f.seite})` : ''}`).join('\n')
  ).join('\n\n');

  const figurenStr = figurenKompakt && figurenKompakt.length
    ? '\n\n## Bekannte Figuren\n' + figurenKompakt.map(f => `${f.name} (${f.typ}): ${f.beschreibung || ''}`).join('\n')
    : '';
  const orteStr = orteKompakt && orteKompakt.length
    ? '\n\n## Bekannte Schauplätze\n' + orteKompakt.map(o => `${o.name} (${o.typ || 'andere'}): ${o.beschreibung || ''}`).join('\n')
    : '';

  return `Prüfe das Buch «${bookName}» auf Kontinuitätsfehler und Widersprüche. Dir liegen die extrahierten Fakten aller Kapitel vor.${figurenStr}${orteStr}

## Extrahierte Fakten nach Kapitel:

${factsText}

Suche nach Widersprüchen: Fakten, die sich gegenseitig ausschliessen oder nicht vereinbar sind. Beispiele: Figur stirbt in Kapitel 3 aber erscheint in Kapitel 7; Ort wird in Kap. 2 als verlassen beschrieben, in Kap. 5 als belebt; Figur weiss etwas, das sie noch nicht wissen konnte.

Prüfe zusätzlich die Soziolekt-Kohärenz: Spricht jede Figur konsistent mit der Herkunft, Bildung und sozialen Schicht, die in früheren Kapiteln durch ihren Soziolekt etabliert wurde? Registerwechsel (z.B. plötzlich formal statt umgangssprachlich, plötzlich Dialekt statt Hochsprache) die sich nicht durch die Situation oder dramaturgischen Kontext erklären lassen, sind Kontinuitätsfehler. Typ «soziolekt» verwenden.

Antworte mit diesem JSON-Schema:
{
  "probleme": [
    {
      "schwere": "kritisch|mittel|niedrig",
      "typ": "figur|zeitlinie|ort|objekt|verhalten|soziolekt|sonstiges",
      "beschreibung": "Was genau widerspricht sich (1-2 Sätze)",
      "stelle_a": "Erste Textstelle (Kapitel: Seite oder Abschnitt)",
      "stelle_b": "Zweite Textstelle (Kapitel: Seite oder Abschnitt)",
      "figuren": ["Name der direkt betroffenen Figur"],
      "kapitel": ["Exakter Kapitelname A", "Exakter Kapitelname B"],
      "empfehlung": "Wie könnte das aufgelöst werden (1 Satz)"
    }
  ],
  "zusammenfassung": "Gesamteinschätzung der Konsistenz des Buchs in 2-3 Sätzen"
}

Regeln:
- Nur echte Widersprüche – keine stilistischen oder inhaltlichen Anmerkungen
- schwere: «kritisch» = klarer Logikfehler der auffällt; «mittel» = wahrscheinlicher Fehler; «niedrig» = mögliche Inkonsistenz
- Soziolekt-Probleme: nur wenn klar ein Sprachmuster etabliert wurde und dann ohne Begründung bricht – nicht melden wenn Figur wenig Dialoganteil hat
- figuren: PFLICHTFELD – immer angeben, mindestens []; Namen exakt wie in der Figurenliste; [] nur wenn wirklich keine Figur betroffen (rein ortsbezogene Widersprüche)
- kapitel: PFLICHTFELD – immer angeben, mindestens []; exakte Kapitelnamen aus stelle_a/stelle_b; wenn beide Stellen im selben Kapitel nur einmal; [] nur wenn der Text keine Kapitelinformation enthält
- Wenn keine Widersprüche gefunden: «probleme» als leeres Array, «zusammenfassung» = positive Einschätzung
- Konservativ: Im Zweifel weglassen

${JSON_ONLY}`;
}

export function buildKontinuitaetSinglePassPrompt(bookName, bookText, figurenKompakt, orteKompakt) {
  const figurenStr = figurenKompakt && figurenKompakt.length
    ? '\n\n## Bekannte Figuren\n' + figurenKompakt.map(f => `${f.name} (${f.typ || ''}): ${f.beschreibung || ''}`).join('\n')
    : '';
  const orteStr = orteKompakt && orteKompakt.length
    ? '\n\n## Bekannte Schauplätze\n' + orteKompakt.map(o => `${o.name} (${o.typ || 'andere'}): ${o.beschreibung || ''}`).join('\n')
    : '';

  return `Prüfe das Buch «${bookName}» auf Kontinuitätsfehler und Widersprüche.${figurenStr}${orteStr}

Suche aktiv nach: Figuren die nach ihrem Tod wieder auftauchen; Orte die sich widersprüchlich beschrieben werden; Zeitangaben die nicht vereinbar sind; Objekte die falsch verwendet werden; Figuren die Wissen haben das sie noch nicht haben könnten; Charakterverhalten das ihrer etablierten Persönlichkeit widerspricht; Soziolekt-Brüche: Figuren die plötzlich anders sprechen als durch ihre Herkunft, Bildung und soziale Schicht etabliert (Registerwechsel ohne dramaturgische Begründung).

Buchtext:

${bookText}

Antworte mit diesem JSON-Schema:
{
  "probleme": [
    {
      "schwere": "kritisch|mittel|niedrig",
      "typ": "figur|zeitlinie|ort|objekt|verhalten|soziolekt|sonstiges",
      "beschreibung": "Was genau widerspricht sich (1-2 Sätze)",
      "stelle_a": "Erste Textstelle (Kapitel: Seite oder Abschnitt)",
      "stelle_b": "Zweite Textstelle (Kapitel: Seite oder Abschnitt)",
      "figuren": ["Name der direkt betroffenen Figur"],
      "kapitel": ["Exakter Kapitelname A", "Exakter Kapitelname B"],
      "empfehlung": "Wie könnte das aufgelöst werden (1 Satz)"
    }
  ],
  "zusammenfassung": "Gesamteinschätzung der Konsistenz des Buchs in 2-3 Sätzen"
}

Regeln:
- Nur echte Widersprüche
- schwere: «kritisch» = klarer Logikfehler; «mittel» = wahrscheinlicher Fehler; «niedrig» = mögliche Inkonsistenz
- Soziolekt-Brüche: nur wenn ein Sprachmuster klar etabliert wurde und dann ohne Begründung bricht
- figuren: PFLICHTFELD – immer angeben, mindestens []; Namen exakt wie in der Figurenliste; [] nur wenn wirklich keine Figur betroffen
- kapitel: PFLICHTFELD – immer angeben, mindestens []; exakte Kapitelnamen aus stelle_a/stelle_b; wenn beide Stellen im selben Kapitel nur einmal; [] nur wenn der Text keine Kapitelinformation enthält
- Wenn keine Widersprüche: «probleme» als leeres Array
- Konservativ: Im Zweifel weglassen

${JSON_ONLY}`;
}

export function buildLektoratPrompt(text, _html, { stopwords = STOPWORDS, erklaerungRule = ERKLAERUNG_RULE } = {}) {
  return `Analysiere diesen Text auf Rechtschreibfehler, Grammatikfehler, stilistische Auffälligkeiten und auffällige Wortwiederholungen. Bewerte ausserdem die Szenen der Seite.

WICHTIG: Jede einzelne Beanstandung erhält einen eigenen Eintrag im «fehler»-Array. Wenn an einer Stelle mehrere unabhängige Probleme vorliegen (z.B. ein Gallizismus und separate Anführungszeichen-Problematik), müssen diese als separate Einträge erscheinen – niemals in einer gemeinsamen «erklaerung» zusammenfassen.

Antworte mit diesem JSON-Schema:
{
  "fehler": [
    {
      "typ": "rechtschreibung|grammatik|stil|wiederholung",
      "original": "das fehlerhafte Wort oder die fehlerhafte Phrase – bei «wiederholung»: vollständiger Satz zeichengenau aus dem Text",
      "korrektur": "die korrekte Version – bei «wiederholung»: derselbe Satz mit Synonym",
      "kontext": "der Satz in dem der Fehler vorkommt (bei «wiederholung» gleich wie «original»)",
      "erklaerung": "kurze Erklärung (nur diesen einen Mangel beschreiben) ${erklaerungRule}"
    }
  ],
  "szenen": [
    {
      "titel": "Kurze Szenenbezeichnung (1 Satz)",
      "wertung": "stark|mittel|schwach",
      "kommentar": "1-2 Sätze: was funktioniert, was fehlt (Spannung, Tempo, Figurenentwicklung)"
    }
  ],
  "stilanalyse": "2-3 Sätze Stilanalyse",
  "fazit": "ein Satz Gesamtfazit"
}

Szenen-Regeln:
- Eine Szene ist ein abgegrenzter Handlungsabschnitt mit eigenem Anfang und Ende
- Wenn die Seite keine erkennbaren Szenen enthält (z.B. rein beschreibender Text, Exposition): «szenen» als leeres Array zurückgeben
- wertung: «stark» = funktioniert gut, «mittel» = verbesserungswürdig, «schwach» = klare Schwächen
${_buildWiederholungBlock(stopwords)}

Originaltext:
${text}`;
}
