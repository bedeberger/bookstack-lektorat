// Unveränderliche technische Pflicht-Anweisung – darf nicht konfiguriert werden,
// da callAI() immer ein JSON-Objekt erwartet.
const JSON_ONLY = 'Antworte ausschliesslich mit einem JSON-Objekt – kein Markdown, kein Text davor oder danach. Beginne deine Antwort direkt mit { und beende sie mit }.';

// Provider-Flag – wird durch configurePrompts() gesetzt.
// Für lokale Provider (ollama, llama) werden Prompts abgespeckt:
// - JSON_ONLY entfällt, weil lib/ai.js Grammar-Constrained JSON-Output erzwingt (format: 'json' / response_format).
// - commonRules wird durch eine kompakte Slim-Version ersetzt (Kernregel + Stilimitation statt ~600 Wörter Aufzählung).
// - Lektorat-Prompts droppen Beispiele, WICHTIG-Paragrafen und spezialisierte Fehler-Typen.
// - Komplett-Extraktions-Schema droppt lange Regeln (Schema bleibt, einzeilige Regeln statt Paragrafen).
let _isLocal = false;
function _jsonOnly() { return _isLocal ? '' : `\n\n${JSON_ONLY}`; }

// Kompakte Ersatzregeln für commonRules[langCode] im Lokal-Modus.
// Behält nur Kernregel + Stilimitation – keine Aufzählung «WAS GEMELDET WERDEN SOLL»
// (die ist redundant mit den typ-spezifischen Rule-Blöcken in den Prompts selbst).
const SLIM_COMMON_RULES = {
  de: 'GRUNDREGEL: Nur eindeutig, zweifelsfrei falsche Stellen melden. Im Zweifel weglassen.\n\nAUTORENSTIL: Alle Korrekturen und Vorschläge müssen sich in den Stil des vorliegenden Textes einfügen (Satzbau, Rhythmus, Wortwahl, Ton) – als wären sie vom Autor selbst geschrieben.',
  en: 'BASIC RULE: Only flag what is clearly and unambiguously wrong. When in doubt, leave it out.\n\nAUTHOR STYLE: All corrections and suggestions must fit the style of the given text (sentence structure, rhythm, word choice, tone) — as if written by the author themselves.',
};

function buildSystem(prefix, rules) {
  return `${prefix}\n\n${rules}${_jsonOnly()}`;
}

// Für Chat-Prompts: Prefix + Rules, aber kein JSON_ONLY am Ende –
// buildChatSystemPrompt/buildBookChatSystemPrompt hängen das Schema selbst an.
function buildSystemNoJson(prefix, rules) {
  return `${prefix}\n\n${rules}`;
}

// ── Interne Locale-Maps ───────────────────────────────────────────────────────
// _localeMap:  Key: localeKey (z.B. 'de-CH') → vorgebautes Prompts-Objekt (Default ohne Buchkontext)
// _rawLocales: Key: localeKey → roher Locale-Config (baseRules, systemPrompts, stopwords)
//              Wird von getLocalePromptsForBook() benötigt um per-Buch-Prompts zu bauen.
let _localeMap  = new Map();
let _rawLocales = new Map();
let _buchtypen  = {};        // cfg.buchtypen aus prompt-config.json
let _erklaerungRule = '';    // cfg.erklaerungRule
let _defaultLocale = 'de-CH';

/** Baut ein Locale-Prompts-Objekt aus einer Locale-Config (aus prompt-config.json).
 *  buchKontext: optionaler per-Buch-Kontext (Freitext), wird als soziogramm-Kontext weitergegeben.
 */
function _buildLocalePrompts(localeConfig, globalErklaerungRule, buchKontext = '') {
  const rules = localeConfig.baseRules || '';
  const sp    = localeConfig.systemPrompts || {};
  return {
    ERKLAERUNG_RULE:             globalErklaerungRule || '',
    KORREKTUR_REGELN:            localeConfig.korrekturRegeln || '',
    STOPWORDS:                   Array.isArray(localeConfig.stopwords) ? localeConfig.stopwords : [],
    BUCH_KONTEXT:                buchKontext,
    SYSTEM_LEKTORAT:             buildSystem(sp.lektorat          || '', rules),
    SYSTEM_BUCHBEWERTUNG:        buildSystem(sp.buchbewertung     || '', rules),
    SYSTEM_KAPITELANALYSE:       buildSystem(sp.kapitelanalyse    || '', rules),
    SYSTEM_FIGUREN:              buildSystem(sp.figuren           || '', rules),
    SYSTEM_STILKORREKTUR:        buildSystem(sp.stilkorrektur     || '', rules),
    SYSTEM_CHAT:                 buildSystemNoJson(sp.chat        || '', rules),
    SYSTEM_BOOK_CHAT:            buildSystemNoJson(sp.buchchat    || '', rules),
    SYSTEM_ORTE:                 buildSystem(sp.orte              || 'Du bist ein Literaturanalytiker. Du identifizierst Schauplätze und Orte präzise und konservativ – nur was im Text eindeutig belegt ist.', rules),
    SYSTEM_KONTINUITAET:         buildSystem(sp.kontinuitaet      || 'Du bist ein sorgfältiger Literaturlektor. Du prüfst einen Roman auf Kontinuitätsfehler und Widersprüche – Figuren, Zeitabläufe, Orte, Objekte und Charakterverhalten.', rules),
    SYSTEM_ZEITSTRAHL:           buildSystem(sp.zeitstrahl        || '', rules),
    // Kombinierter System-Prompt für buildExtraktionKomplettChapterPrompt (P1+P5 merged).
    // Schema und Regeln sind im System-Prompt → werden gecacht; User-Message enthält nur Kapiteltext.
    // buchKontext dient als soziogramm-Kontext für die Sozialschicht-Klassifikation der Figuren.
    SYSTEM_KOMPLETT_EXTRAKTION:  buildSystemKomplett(sp.figuren   || '', rules, buchKontext),
  };
}

// Live-Exports – werden durch configurePrompts() gesetzt (Pflicht vor erstem Prompt-Aufruf).
// Alle importierenden Module erhalten via ESM-Live-Binding immer den aktuellen Wert.
// Diese Globals entsprechen stets dem defaultLocale und dienen der Rückwärtskompatibilität.
export let ERKLAERUNG_RULE              = null;
export let KORREKTUR_REGELN             = '';
export let STOPWORDS                    = [];
export let SYSTEM_LEKTORAT              = null;
export let SYSTEM_BUCHBEWERTUNG         = null;
export let SYSTEM_KAPITELANALYSE        = null;
export let SYSTEM_FIGUREN               = null;
export let SYSTEM_STILKORREKTUR         = null;
export let SYSTEM_CHAT                  = null;
export let SYSTEM_BOOK_CHAT             = null;
export let SYSTEM_ORTE                  = null;
export let SYSTEM_KONTINUITAET          = null;
export let SYSTEM_ZEITSTRAHL            = null;
export let SYSTEM_KOMPLETT_EXTRAKTION   = null;

/**
 * Setzt alle System-Prompts aus dem promptConfig-Objekt (geladen aus prompt-config.json).
 * Unterstützt sowohl das neue Locales-Format (cfg.locales) als auch das alte Flat-Format
 * (cfg.baseRules direkt) für Rückwärtskompatibilität.
 * Pflichtaufruf beim App-Start – wirft einen Fehler wenn cfg fehlt.
 * @param {Object} cfg        promptConfig-Objekt aus /config
 * @param {string} [provider] 'claude' | 'ollama' | 'llama' – Default: 'claude'.
 *   Bei 'ollama'/'llama' werden die Prompts abgespeckt (siehe _isLocal oben).
 */
export function configurePrompts(cfg, provider = 'claude') {
  if (!cfg) throw new Error('prompt-config.json fehlt oder ist ungültig – Prompts können nicht konfiguriert werden.');

  _isLocal = provider === 'ollama' || provider === 'llama';

  _localeMap.clear();
  _rawLocales.clear();
  _buchtypen     = cfg.buchtypen || {};
  _erklaerungRule = cfg.erklaerungRule || '';

  if (cfg.locales && typeof cfg.locales === 'object') {
    // ── Neues Format: locales-Map ─────────────────────────────────────────────
    _defaultLocale = cfg.defaultLocale || 'de-CH';
    const commonRules = cfg.commonRules || {};
    for (const [key, localeCfg] of Object.entries(cfg.locales)) {
      const langCode = key.split('-')[0];
      // Für lokale Modelle wird commonRules durch eine Slim-Version ersetzt.
      // Das Original enthält den grossen Meta-Block (GRUNDREGEL + WAS GEMELDET WERDEN SOLL +
      // AUTORENSTIL IMITIEREN) – ~600 Wörter, die kleine Modelle überfordern.
      // Slim behält nur Kernregel + Stilimitation. Der locale-eigene baseRules-Block
      // (Orthografienorm) bleibt in beiden Modi – er ist essentiell.
      const common = _isLocal
        ? (SLIM_COMMON_RULES[langCode] || '')
        : (commonRules[langCode] || '');
      const base = localeCfg.baseRules || '';
      const mergedCfg = {
        ...localeCfg,
        baseRules: common ? `${base}\n\n${common}` : base,
      };
      _rawLocales.set(key, mergedCfg);
      _localeMap.set(key, _buildLocalePrompts(mergedCfg, cfg.erklaerungRule));
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
    const flatCfg = { baseRules: cfg.baseRules, stopwords: cfg.stopwords, systemPrompts: cfg.systemPrompts || {} };
    _rawLocales.set('de-CH', flatCfg);
    _localeMap.set('de-CH', _buildLocalePrompts(flatCfg, cfg.erklaerungRule));
  }

  // Globale Exports auf Default-Locale setzen (ESM-Live-Binding für Client-Code)
  const def = _localeMap.get(_defaultLocale) || {};
  ERKLAERUNG_RULE              = def.ERKLAERUNG_RULE              ?? '';
  KORREKTUR_REGELN             = def.KORREKTUR_REGELN             ?? '';
  STOPWORDS                    = def.STOPWORDS                    ?? [];
  SYSTEM_LEKTORAT              = def.SYSTEM_LEKTORAT              ?? null;
  SYSTEM_BUCHBEWERTUNG         = def.SYSTEM_BUCHBEWERTUNG         ?? null;
  SYSTEM_KAPITELANALYSE        = def.SYSTEM_KAPITELANALYSE        ?? null;
  SYSTEM_FIGUREN               = def.SYSTEM_FIGUREN               ?? null;
  SYSTEM_STILKORREKTUR         = def.SYSTEM_STILKORREKTUR         ?? null;
  SYSTEM_CHAT                  = def.SYSTEM_CHAT                  ?? null;
  SYSTEM_BOOK_CHAT             = def.SYSTEM_BOOK_CHAT             ?? null;
  SYSTEM_ORTE                  = def.SYSTEM_ORTE                  ?? null;
  SYSTEM_KONTINUITAET          = def.SYSTEM_KONTINUITAET          ?? null;
  SYSTEM_ZEITSTRAHL            = def.SYSTEM_ZEITSTRAHL            ?? null;
  SYSTEM_KOMPLETT_EXTRAKTION   = def.SYSTEM_KOMPLETT_EXTRAKTION   ?? null;
}

/**
 * Gibt ein Locale-Prompts-Objekt zurück, das mit dem per-Buch-Kontext augmentiert ist.
 * Baut die baseRules dynamisch auf (Buchtyp-Block + Freitext-Block) und übergibt
 * buchKontext als soziogramm-Kontext an SYSTEM_KOMPLETT_EXTRAKTION / figurenBasisRules.
 * @param {string} localeKey   z.B. 'de-CH', 'en-US'
 * @param {string|null} buchtyp     Key aus prompt-config.json buchtypen (z.B. 'roman')
 * @param {string|null} buchKontext Freitext des Users (Schauplatz, Epoche, …)
 * @returns {{ SYSTEM_LEKTORAT, ..., BUCH_KONTEXT }}
 */
export function getLocalePromptsForBook(localeKey, buchtyp, buchKontext) {
  const rawLocale = _rawLocales.get(localeKey) || _rawLocales.get(_defaultLocale) || {};
  const kontext   = (buchKontext || '').trim();

  // Augmentierte baseRules: Original + Buchtyp-Block + Freitext-Block
  const langCode    = (localeKey || _defaultLocale).split('-')[0];
  const buchtypDef  = buchtyp && _buchtypen?.[langCode]?.[buchtyp];
  let augRules = rawLocale.baseRules || '';
  if (buchtypDef?.zusatz) {
    augRules += `\n\nBUCHTYP-KONTEXT: ${buchtypDef.zusatz}`;
  }
  if (kontext) {
    augRules += `\n\nVORRANGIGE ANGABEN DES AUTORS (übersteuern bei Konflikt alle obigen Regeln – insbesondere Stil-, Ton- und Formatvorgaben):\n${kontext}`;
  }

  const augLocale = { ...rawLocale, baseRules: augRules };
  // buchKontext als soziogramm-Kontext weitergeben (figurenBasisRules / SYSTEM_KOMPLETT_EXTRAKTION)
  return _buildLocalePrompts(augLocale, _erklaerungRule, kontext);
}

export function buildStilkorrekturPrompt(html, styles) {
  const liste = styles.map((s, i) =>
    `${i + 1}. Originalstelle: "${s.original}"\n   Empfehlung: "${s.korrektur}"\n   Begründung: ${s.erklaerung}`
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

// Stil-Regeln für Lektorat-Prompts
function _buildStilBlock() {
  return `
Stil-Regeln (typ: «stil»):
- Nur melden, falls das Problem nicht bereits als anderer Typ (wiederholung, grammatik, rechtschreibung) erfasst wurde
- PFLICHT: «korrektur» muss immer eine konkrete Umformulierung enthalten – nicht leer lassen, nicht dasselbe wie «original». Keine Stilanmerkung ohne konkreten Verbesserungsvorschlag.`;
}

// Wiederholung-Regeln für Lektorat-Prompts (beide Varianten)
// sw: explizite Stoppwort-Liste; fällt auf globales STOPWORDS zurück (Default-Locale)
function _buildWiederholungBlock(sw = STOPWORDS) {
  const swNote = sw.length > 0
    ? `\n- Stoppwörter nie melden (auch flektierte Formen): ${sw.join(', ')}`
    : '';
  return `
Wiederholung-Regeln (typ: «wiederholung»):
- Nur Inhaltswörter, die auffällig oft vorkommen: mind. 3× auf der gesamten Seite ODER 2× im selben oder direkt aufeinanderfolgenden Absatz
- Keine Pronomen, Hilfsverben, Artikel, Konjunktionen, Präpositionen, Eigennamen${swNote}
- «original»: vollständiger Satz zeichengenau aus dem Text (damit die Textstelle eindeutig auffindbar ist)
- «korrektur»: derselbe Satz mit dem besten Synonym – exakt gleiche grammatische Form (Kasus, Numerus, Tempus)
- Synonym-Selbsttest vor jedem Eintrag: Klingt der Satz danach natürlich? Bedeutung erhalten? Passt zum Autorenstil?`;
}

// Schwache-Verben-Regeln für Lektorat-Prompts
function _buildSchwacheVerbenBlock() {
  return `
Schwache-Verben-Regeln (typ: «schwaches_verb»):
- Schwache, blasse oder nichtssagende Verben identifizieren
- Typische schwache Verben: machen, tun, sein, haben, geben, gehen, kommen, bringen, stehen, liegen, sagen, meinen, finden u.ä.
- Nur melden, wenn ein ausdrucksstärkeres Verb den Satz spürbar verbessert — keine Pedanterie bei idiomatischen Wendungen oder Hilfsverb-Konstruktionen
- «original»: vollständiger Satz zeichengenau aus dem Text (damit die Textstelle eindeutig auffindbar ist)
- «korrektur»: derselbe Satz mit dem stärkeren Verb — exakt gleiche grammatische Form und Tempus
- Selbsttest vor jedem Eintrag: Ist das Ersatzverb wirklich präziser und bildstärker? Passt es zum Stil und Ton des Textes?`;
}

// Füllwort-Regeln für Lektorat-Prompts
function _buildFuellwortBlock() {
  return `
Füllwort-Regeln (typ: «fuellwort»):
- Überflüssige Füllwörter identifizieren, die den Text verwässern
- Typische Füllwörter: eigentlich, irgendwie, quasi, halt, eben, wohl, ja, doch, mal, nun, also, natürlich, gewissermassen, sozusagen, durchaus, ziemlich, etwas, ein wenig, ein bisschen u.ä.
- Nur melden, wenn das Streichen oder Ersetzen den Satz strafft, ohne Bedeutung oder Stimme zu verlieren — in Dialogen können Füllwörter bewusst eingesetzt sein
- «original»: vollständiger Satz zeichengenau aus dem Text
- «korrektur»: derselbe Satz ohne das Füllwort (oder mit knapperer Formulierung)
- Selbsttest: Verliert der Satz durch die Streichung an Rhythmus, Stimme oder Bedeutungsnuance? Dann weglassen.`;
}

// Show-vs-Tell-Regeln für Lektorat-Prompts
function _buildShowVsTellBlock() {
  return `
Show-vs-Tell-Regeln (typ: «show_vs_tell»):
- Stellen identifizieren, an denen Emotionen, Eigenschaften oder Zustände abstrakt benannt statt szenisch gezeigt werden
- Typische Muster: «Er war wütend», «Sie fühlte sich traurig», «Das Haus war alt», «Er war nervös»
- «original»: vollständiger Satz zeichengenau aus dem Text
- «korrektur»: derselbe Satz umformuliert mit konkreten Sinneseindrücken, Handlungen oder Details, die das Gleiche zeigen
- Nur melden, wenn eine szenische Darstellung den Text spürbar lebendiger macht — nicht jede abstrakte Aussage muss umgeschrieben werden (z.B. in Zusammenfassungen, Rückblenden oder schnellen Übergängen ist Telling erlaubt)
- Selbsttest: Passt die szenische Variante zum Erzähltempo und zur Szene? Nicht aufblähen.`;
}

// Passiv-Regeln für Lektorat-Prompts
function _buildPassivBlock() {
  return `
Passivkonstruktionen-Regeln (typ: «passiv»):
- Vermeidbare Passivkonstruktionen identifizieren, die den Text schwerfällig oder unpersönlich machen
- «original»: vollständiger Satz zeichengenau aus dem Text
- «korrektur»: derselbe Satz in aktiver Formulierung — das handelnde Subjekt klar benennen
- Nicht melden, wenn das Passiv bewusst eingesetzt wird (Täter unbekannt/unwichtig, wissenschaftlicher Stil, Betonung auf dem Objekt) oder die aktive Variante gezwungen klingt
- Selbsttest: Ist die aktive Formulierung wirklich klarer und lebendiger? Klingt sie natürlich im Kontext?`;
}

// Perspektivbruch-Regeln für Lektorat-Prompts
function _buildPerspektivbruchBlock() {
  return `
Perspektivbruch-Regeln (typ: «perspektivbruch»):
- Stellen identifizieren, an denen die Erzählperspektive innerhalb einer Szene unbeabsichtigt wechselt
- Typische Brüche: Wissen oder Gedanken einer Figur beschreiben, die nicht die aktuelle Perspektivfigur ist; plötzlicher Wechsel zwischen Ich-Erzähler und auktorialem Erzähler; Informationen, die der Perspektivfigur nicht zugänglich sind
- «original»: vollständiger Satz zeichengenau aus dem Text
- «korrektur»: derselbe Satz so umformuliert, dass er zur etablierten Perspektive der Szene passt
- «erklaerung»: benennen, welche Perspektive etabliert ist und worin der Bruch besteht
- Nicht melden bei bewusst auktorialer Erzählweise oder bei expliziten Perspektivwechseln (z.B. nach Szenenumbruch)`;
}

// Tempuswechsel-Regeln für Lektorat-Prompts
function _buildTempuswechselBlock() {
  return `
Tempuswechsel-Regeln (typ: «tempuswechsel»):
- Unbeabsichtigte Wechsel der Erzählzeit innerhalb einer Szene oder eines Abschnitts identifizieren
- Typisch: Erzählung im Präteritum mit plötzlichem Wechsel ins Präsens (oder umgekehrt), ohne dass ein Stilmittel erkennbar ist
- «original»: vollständiger Satz zeichengenau aus dem Text
- «korrektur»: derselbe Satz im korrekten Tempus der umgebenden Passage
- «erklaerung»: benennen, welches Tempus in der Passage etabliert ist und welches im Satz verwendet wird
- Nicht melden bei: Plusquamperfekt für Rückblenden, historischem Präsens als bewusstem Stilmittel, Tempuswechsel in direkter Rede, Wechsel an Szenen-/Kapitelgrenzen`;
}

// Gemeinsamer Rumpf für Einzel- und Batch-Lektorat-Prompts
function _buildLektoratPromptBody(text, textLabel, { stopwords = STOPWORDS, erklaerungRule = ERKLAERUNG_RULE, korrekturRegeln = KORREKTUR_REGELN, figuren = [] } = {}) {
  const figurenBlock = figuren.length > 0
    ? `\nBekannte Figuren in diesem Kapitel (Kontext für Namenskonsistenz und Perspektivprüfung):\n${figuren.map(f => {
        const parts = [f.name];
        if (f.kurzname) parts.push(`Kurzname: ${f.kurzname}`);
        if (f.geschlecht) parts.push(f.geschlecht);
        if (f.beruf) parts.push(f.beruf);
        if (f.typ) parts.push(`Typ: ${f.typ}`);
        if (f.beschreibung) parts.push(f.beschreibung);
        return '- ' + parts.join(' | ');
      }).join('\n')}\nHinweis: Figurennamen und deren Varianten sind KEINE Rechtschreibfehler.\n`
    : '';

  // Lokaler Modus: kleinere Typ-Enum, keine Beispiele, keine spezialisierten Rule-Blöcke
  // (show_vs_tell, passiv, perspektivbruch, tempuswechsel). Diese Typen verlangen nuanciertes
  // Textverständnis, an dem kleine Modelle häufig scheitern oder in Wiederholungsloops geraten.
  const typEnum = _isLocal
    ? 'rechtschreibung|grammatik|stil|wiederholung|schwaches_verb|fuellwort'
    : 'rechtschreibung|grammatik|stil|wiederholung|schwaches_verb|fuellwort|show_vs_tell|passiv|perspektivbruch|tempuswechsel';

  const wichtigBlock = _isLocal
    ? ''
    : '\nWICHTIG: Jede einzelne Beanstandung erhält einen eigenen Eintrag im «fehler»-Array. Wenn an einer Stelle mehrere unabhängige Probleme vorliegen (z.B. ein Gallizismus und separate Anführungszeichen-Problematik), müssen diese als separate Einträge erscheinen – niemals in einer gemeinsamen «erklaerung» zusammenfassen.\n';

  const filterBlock = _isLocal
    ? ''
    : `${erklaerungRule ? `\nFILTER-PFLICHT: ${erklaerungRule}\n` : ''}${korrekturRegeln ? `\n${korrekturRegeln}\n` : ''}`;

  const beispielBlock = _isLocal ? '' : `
Beispiel eines GUTEN Eintrags:
{ "typ": "grammatik", "original": "wegen dem Regen", "korrektur": "wegen des Regens", "erklaerung": "«wegen» verlangt den Genitiv." }
Beispiel eines VERWORFENEN Eintrags (NICHT aufnehmen):
{ "typ": "rechtschreibung", "original": "heisst", "korrektur": "heißt", "erklaerung": "Könnte im Standarddeutschen mit ß geschrieben werden." } → Erklärung enthält Unsicherheit → Selbsttest nicht bestanden → weglassen.
`;

  const spezialBlocks = _isLocal
    ? ''
    : `${_buildShowVsTellBlock()}
${_buildPassivBlock()}
${_buildPerspektivbruchBlock()}
${_buildTempuswechselBlock()}
`;

  return `Analysiere den Text vollständig von Anfang bis Ende – nicht nur lokale Abschnitte oder die letzten Sätze – auf Rechtschreibfehler, Grammatikfehler, stilistische Auffälligkeiten und auffällige Wortwiederholungen. Bewerte ausserdem die Szenen der Seite.
${wichtigBlock}${filterBlock}
Antworte mit diesem JSON-Schema:
{
  "fehler": [
    {
      "typ": "${typEnum}",
      "original": "das fehlerhafte Wort oder die fehlerhafte Phrase – bei «wiederholung»: vollständiger Satz zeichengenau aus dem Text",
      "korrektur": "die korrekte Version – bei «wiederholung»: derselbe Satz mit Synonym",
      "erklaerung": "kurze Erklärung – nur diesen einen Mangel beschreiben"
    }
  ],
  "szenen": [
    {
      "titel": "Kurze Szenenbezeichnung (1 Satz)",
      "wertung": "stark|mittel|schwach",
      "kommentar": "1-2 Sätze: was funktioniert, was fehlt (Spannung, Tempo, Figurenentwicklung)"
    }
  ],
  "stilanalyse": "4-5 Sätze Stilanalyse – KEINE konkreten Fehler erwähnen, die bereits im «fehler»-Array stehen (weder Rechtschreibung, Grammatik, Stil, Wiederholungen noch andere Typen). Fokus ausschliesslich auf übergreifende Beobachtungen zu literarischem Stil, Rhythmus, Bildsprache und Wirkung, die nicht als Einzelfehler erfasst sind.",
  "fazit": "ein Satz Gesamtfazit zur literarischen Qualität – KEINE Fehler aus dem «fehler»-Array wiederholen oder zusammenfassen, da diese separat behoben werden"
}
${beispielBlock}
Szenen-Regeln:
- Eine Szene ist ein abgegrenzter Handlungsabschnitt mit eigenem Anfang und Ende
- Wenn die Seite keine erkennbaren Szenen enthält (z.B. rein beschreibender Text, Exposition): «szenen» als leeres Array zurückgeben
- wertung: «stark» = funktioniert gut, «mittel» = verbesserungswürdig, «schwach» = klare Schwächen
${_buildStilBlock()}
${_buildWiederholungBlock(stopwords)}
${_buildSchwacheVerbenBlock()}
${_buildFuellwortBlock()}
${spezialBlocks}${figurenBlock}
${textLabel}
${text}`;
}

// Batch-Variante ohne korrekturen_html (spart Output-Tokens, für Server-Side-Jobs)
// opts.stopwords / opts.erklaerungRule überschreiben die globalen Defaults (für locale-aware Aufrufe)
export function buildBatchLektoratPrompt(text, opts = {}) {
  return _buildLektoratPromptBody(text, 'Text:', opts);
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
  "gesamtnote": 4.5,
  "gesamtnote_begruendung": "Ein Satz warum diese Note (gesamtnote als Dezimalzahl von 1.0=sehr schwach bis 6.0=ausgezeichnet, Halbschritte erlaubt)",
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
  "gesamtnote": 4.5,
  "gesamtnote_begruendung": "Ein Satz warum diese Note (gesamtnote als Dezimalzahl von 1.0=sehr schwach bis 6.0=ausgezeichnet, Halbschritte erlaubt)",
  "zusammenfassung": "2-3 Sätze Gesamteindruck",
  "struktur": "Analyse des Aufbaus und der Struktur über alle Kapitel (3-5 Sätze)",
  "stil": "Analyse des Schreibstils und seiner Konsistenz über das gesamte Buch (3-5 Sätze)",
  "staerken": ["Stärke 1", "Stärke 2", "Stärke 3"],
  "schwaechen": ["Schwäche 1", "Schwäche 2"],
  "empfehlungen": ["Empfehlung 1", "Empfehlung 2", "Empfehlung 3"],
  "fazit": "Abschliessendes Urteil in 1-3 Sätzen"
}`;
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

const figurenBasisRules = (kontext = '') => `Regeln:
- Eindeutige IDs (fig_1, fig_2, …)
- beziehungen.figur_id: nur IDs aus dieser Liste; jede Beziehung nur einmal eintragen
- kapitel: absteigend nach Häufigkeit; haeufigkeit = Anzahl Seiten/Abschnitte mit aktivem Auftreten; name = immer der Kapitelname (aus dem ## Kapitel-Header über dem Abschnitt oder aus dem Prompt-Kontext) – NIEMALS Seitentitel als Kapitelnamen verwenden
- sozialschicht: gesellschaftliche Schicht der Figur${kontext ? ` (${kontext})` : ''} – nur vergeben wenn eindeutig belegt; wirtschaftselite=Unternehmerfamilien/Direktoren, gehobenes_buergertum=Akademiker/freie Berufe/obere Kader, mittelschicht=Angestellte/Beamte/mittlere Kader, arbeiterschicht=Fabrik-/Bauarbeiter/Servicepersonal, migrantenmilieu=Zugewanderte/zweite Generation, prekariat=Sozialhilfe/Randständige/Langzeitarbeitslose, unterwelt=kriminelles Milieu, andere=nicht eindeutig
- beziehungen.machtverhaltnis: Machtasymmetrie: +2=Gegenüber (figur_id) dominiert klar, +1=Gegenüber hat leichten Vorteil, 0=symmetrisch, -1=diese Figur hat leichten Vorteil, -2=diese Figur dominiert klar; weglassen oder 0 wenn unklar
- Beziehungstypen: typ beschreibt die ROLLE von figur_id (NICHT der aktuellen Figur!). Bei Figur X der Eintrag {figur_id: Y, typ: elternteil} bedeutet: Y IST der Elternteil von X. Konkretes Beispiel: Robert hat Mutter Sandra → bei Robert eintragen {figur_id: «<Sandras fig_id>», typ: elternteil, machtverhaltnis: 2}. patronage=Schutzherrschaft (figur_id = Patron), geschaeft=wirtschaftliche Beziehung, geschwister=undirektional, übrige selbsterklärend
- Pro Figurenpaar höchstens EINE Beziehung eintragen – aus der Perspektive EINER Figur. Keine widersprüchlichen Angaben (z.B. nicht gleichzeitig elternteil und kind für dasselbe Paar)
- Nur fiktive Charaktere oder Figuren die aktiv an der Buchhandlung teilnehmen – keine Orte oder Objekte
- KEINE historischen oder realen Personen die nur erwähnt, zitiert oder als Referenz genannt werden (z.B. Napoleon, Einstein, ein Politiker, eine Künstlerin)
- Sortiert nach Wichtigkeit
- KONSERVATIV: Nur Figuren und Beziehungen aufnehmen die im Text eindeutig belegt sind. Lieber weglassen als spekulieren.
- DEDUPLIZIERUNG MIT KONTEXTABGLEICH: Figuren zusammenführen wenn der Name übereinstimmt (gleicher Vor- und Nachname) ODER ein Teilname (nur Vorname oder nur Nachname) mit mindestens einem inhaltlichen Indiz zusammenpasst – z.B. gleicher Beruf, überschneidende Fachkenntnisse, konsistente Charakterzüge oder übereinstimmendes Verhalten kapitelübergreifend. Beispiel: «Maria» die in Kapitel 1 als Kräuterkundige gilt und «Maria Huber» die in Kapitel 3 Naturheilkunde beherrscht – zusammenführen. Widersprechen sich Eigenschaften eindeutig, getrennt behalten. Gibt es nur Namensähnlichkeit ohne inhaltliche Überschneidung: getrennt behalten.`;


export function buildFiguresBasisConsolidationPrompt(bookName, chapterFiguren, buchKontext = '') {
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

Antworte mit diesem JSON-Schema:
${FIGUREN_BASIS_SCHEMA}

${figurenBasisRules(buchKontext)}`;
}


// ── Kapitelübergreifende Beziehungen ──────────────────────────────────────────
export function buildKapiteluebergreifendeBeziehungenPrompt(bookName, figurenList, bookText) {
  const idToName = Object.fromEntries(figurenList.map(f => [f.id, f.name]));
  const figInfo = figurenList.map(f => {
    const kap = (f.kapitel || []).map(k => k.name).join(', ') || '(kein Kapitel)';
    const bzStr = (f.beziehungen || [])
      .map(b => `${idToName[b.figur_id] || b.figur_id} [${b.typ}]`)
      .join(', ');
    return `- **${f.id}** ${f.name}${f.kurzname && f.kurzname !== f.name ? ` («${f.kurzname}»)` : ''} | ${f.typ} | Kapitel: ${kap}` +
      (f.beschreibung ? `\n  ${f.beschreibung}` : '') +
      (bzStr ? `\n  Bekannte Beziehungen: ${bzStr}` : '');
  }).join('\n');

  return `Buchname: «${bookName}»

Analysiere die folgende Figurenliste und den Buchtext. Identifiziere Beziehungen zwischen Figuren aus VERSCHIEDENEN Kapiteln, die noch NICHT in «Bekannte Beziehungen» aufgeführt sind.

Figurenliste:
${figInfo}

Buchtext:
${bookText}

Antworte mit diesem JSON-Schema:
{
  "beziehungen": [
    { "von": "fig_1", "zu": "fig_2", "typ": "elternteil|geschwister|kind|freund|feind|kollege|bekannt|liebesbeziehung|rivale|mentor|schuetzling|patronage|geschaeft|andere", "machtverhaltnis": 0, "beschreibung": "1 Satz" }
  ]
}

Regeln:
- Nur Beziehungen zwischen Figuren aus VERSCHIEDENEN Kapiteln
- Nur Beziehungen die im Buchtext eindeutig belegt sind – KONSERVATIV, lieber weglassen als spekulieren
- von/zu: nur IDs aus der obigen Figurenliste
- Jede Beziehung nur einmal eintragen (nicht von→zu UND zu→von für denselben Typ)
- Keine Beziehungen die bereits in «Bekannte Beziehungen» stehen
- machtverhaltnis: Machtasymmetrie: +2=Gegenüber («zu») dominiert klar, +1=Gegenüber hat leichten Vorteil, 0=symmetrisch, -1=diese Figur («von») hat leichten Vorteil, -2=diese Figur dominiert klar; weglassen oder 0 wenn unklar
- Leeres Array wenn keine neuen kapitelübergreifenden Beziehungen eindeutig belegt sind`;
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

// ── Fakten-Schema (verwendet in Komplett-Analyse und Kontinuität) ────────────

const FAKTEN_SCHEMA = `"fakten": [
    {
      "kategorie": "figur|ort|objekt|zeit|ereignis|soziolekt|sonstiges",
      "subjekt": "Über wen/was geht es (Name oder Bezeichnung)",
      "fakt": "Was genau behauptet wird (1 Satz, so präzise wie möglich)",
      "seite": "Seitenname oder Abschnittsname (leer wenn unklar)"
    }
  ]`;

const FAKTEN_RULES = `Fakten-Regeln:
- Nur konkrete, prüfbare Aussagen – keine Interpretationen
- Figuren-Zustände besonders genau erfassen (Wissen, Können, körperlicher Zustand, Wohnort, Beruf)
- Soziolekt: Wenn eine Figur erstmals oder markant spricht, ein Faktum erfassen das ihr Sprachregister beschreibt. Kategorie «soziolekt» verwenden.
- Objekte: Wer besitzt was, wo liegt was, in welchem Zustand
- Zeitangaben: Relative («am nächsten Morgen») und absolute («1943») erfassen
- Maximal 50 Fakten pro Kapitel; lieber weniger, dafür präzise`;

// ── Kontinuitäts-Probleme-Schema (verwendet in Check und SinglePass) ─────────

const PROBLEME_SCHEMA = `{
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
}`;

const PROBLEME_RULES = `Regeln:
- Nur echte Widersprüche – keine stilistischen oder inhaltlichen Anmerkungen
- WICHTIG: Wenn du bei der Analyse zum Schluss kommst, dass KEIN Widerspruch vorliegt (z.B. «konsistent», «passt», «kein echter Widerspruch»), dann das Problem NICHT melden. Nur tatsächliche Widersprüche ins Array aufnehmen.
- schwere: «kritisch» = klarer Logikfehler der dem Leser sofort auffällt und zwingend korrigiert werden muss; «mittel» = wahrscheinlicher Fehler der den Leser stören könnte; «niedrig» = mögliche Inkonsistenz die eventuell beabsichtigt ist
- Soziolekt-Probleme: nur wenn klar ein Sprachmuster etabliert wurde und dann ohne Begründung bricht – nicht melden wenn Figur wenig Dialoganteil hat
- figuren: PFLICHTFELD – immer angeben, mindestens []; Namen exakt wie in der Figurenliste; [] nur wenn wirklich keine Figur betroffen (rein ortsbezogene Widersprüche)
- kapitel: PFLICHTFELD – immer angeben, mindestens []; exakte Kapitelnamen aus stelle_a/stelle_b; wenn beide Stellen im selben Kapitel nur einmal; [] nur wenn der Text keine Kapitelinformation enthält
- Wenn keine Widersprüche gefunden: «probleme» als leeres Array, «zusammenfassung» = positive Einschätzung
- Konservativ: Im Zweifel weglassen – lieber ein echtes Problem übersehen als ein Nicht-Problem melden`;

// ── Komplett-Analyse (kombinierte Extraktion) ─────────────────────────────────
// Hilfsfunktion: Extrahiert den Inhalt des äussersten Objekts aus einem Schema-String.
// Ermöglicht das Zusammensetzen von Schemas ohne Duplikation der Felddefinitionen.
function _schemaBody(schemaStr) {
  return schemaStr.trim().replace(/^\s*\{\s*/, '').replace(/\s*\}\s*$/, '').trim();
}

// ── Kombiniertes Schema für Komplett-Extraktion (P1+P5 merged) ───────────────
// buildSystemKomplett() bettet es in den System-Prompt ein → Caching über alle Kapitel-Calls.
// figuren_namen / orte_namen / figur_name: Klarnamen statt IDs, da konsolidierte IDs
// erst nach P2/P3 bekannt sind. Remapping nach der Konsolidierung in jobs.js.
// kontext kommt aus book_settings.buch_kontext (per-Buch-Freitext), wird von buildSystemKomplett durchgereicht.
function buildKomplettSchemaStatic(kontext = '') {
  const schemaPart = `Priorität: Figuren und deren Beziehungen sind am wichtigsten. Im Zweifel lieber weniger Fakten/Szenen und dafür korrekte Figurenanalyse.

Antworte mit diesem JSON-Schema:
{
  ${_schemaBody(FIGUREN_BASIS_SCHEMA)},
  ${_schemaBody(ORTE_SCHEMA)},
  ${FAKTEN_SCHEMA},
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
          "ereignis": "Was passierte – neutral und kanonisch formuliert, NICHT aus der Figurenperspektive. Ereignisse die mehrere Figuren betreffen MÜSSEN bei allen beteiligten Figuren identisch formuliert sein (z.B. 'Geburt von Maria' für Vater, Mutter und Kind – nicht 'Geburt seiner Tochter' oder 'Eigene Geburt').",
          "typ": "persoenlich|extern",
          "bedeutung": "Bedeutung für diese Figur (1 Satz, leer wenn nicht klar)",
          "seite": "Name der Seite/des Abschnitts (leer wenn unklar)",
          "kapitel": "Kapitelname (aus dem ## Kapitel-Header über diesem Abschnitt; leer wenn unklar)"
        }
      ]
    }
  ]
}`;

  // Lokaler Modus: einzeilige Kernregeln statt ausführlicher Rule-Paragrafen.
  // Schema oben bleibt identisch (sonst würde der Remapping-Code in jobs.js brechen).
  if (_isLocal) {
    return `${schemaPart}

Kernregeln:
- IDs eindeutig (fig_1, ort_1, …); Beziehungen nur zwischen IDs aus dieser Liste.
- KONSERVATIV: Nur aufnehmen was im Text eindeutig belegt ist. Im Zweifel weglassen.
- Keine historischen/realen Personen die nur erwähnt werden.
- kapitel[].name: immer der Kapitelname (aus dem ## Header oder dem Prompt-Kontext), niemals Seitentitel.
- figuren_namen / orte_namen / figur_name: Klarnamen exakt wie im Text.
- Ereignisse: datum als JJJJ; ohne errechenbares Jahr weglassen. Gleiches Ereignis bei allen beteiligten Figuren identisch formulieren.
- Leere Arrays wenn nichts gefunden.`;
  }

  return `${schemaPart}

Figuren-Regeln:
${figurenBasisRules(kontext)}

Schauplatz-Regeln:
${ORTE_RULES}

${FAKTEN_RULES}

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
}

// buildSystemKomplett: wie buildSystem, aber mit eingebettetem Schema+Regeln-Block.
// Der Schema-Block wird so gecacht (cache_control: ephemeral in lib/ai.js) – spart bei
// ~20 Kapitel-Calls ~19 × Schema-Tokens (statt in jeder User-Message wiederholen).
// kontext kommt aus book_settings.buch_kontext (per-Buch-Freitext, via getLocalePromptsForBook).
function buildSystemKomplett(prefix, rules, kontext) {
  return `${prefix}\n\n${rules}\n\n${buildKomplettSchemaStatic(kontext)}${_jsonOnly()}`;
}


/**
 * Kombinierter Vollextraktion-Prompt (P1 + P5 in einem Call):
 * Figuren + Schauplätze + Kontinuitätsfakten + Szenen + Lebensereignisse.
 *
 * Schema und Regeln leben im System-Prompt (SYSTEM_KOMPLETT_EXTRAKTION) – diese User-Message
 * enthält nur den Kapiteltext und den chapter-spezifischen Kapitelnamen-Hinweis.
 * Szenen und Assignments verwenden Klarnamen (figuren_namen / orte_namen / figur_name)
 * statt IDs – das Remapping auf konsolidierte IDs erfolgt in jobs.js nach P2/P3.
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
- Ereignisse verschiedener Figuren zum gleichen Datum die denselben realen Vorfall beschreiben (z.B. Geburt, Heirat, Tod, Unfall, Krieg) MÜSSEN zusammengeführt werden – auch wenn die Formulierungen leicht abweichen. Führe alle beteiligten Figuren im figuren-Array zusammen.
- Nur bei inhaltlich klar verschiedenen Vorfällen trennen

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
    'VORSCHLÄGE-REGELN:',
    '- Wenn du stilistische, inhaltliche oder sprachliche Schwächen erkennst oder der Autor nach Verbesserungen fragt: liefere mindestens einen konkreten Vorschlag mit original und ersatz.',
    '- original muss zeichengenau mit dem Seitentext übereinstimmen.',
    '- ersatz muss den Stil des Autors beibehalten.',
    '- vorschlaege ist nur dann ein leeres Array, wenn die Frage rein inhaltlich/konzeptionell ist und keine Textstelle betrifft (z.B. Plotfragen, Figurenmotivation).',
    ...(_isLocal ? [] : ['', JSON_ONLY]),
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
    ...(_isLocal ? [] : ['', JSON_ONLY]),
  );

  return parts.join('\n');
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

Antworte mit diesem JSON-Schema:
${ORTE_SCHEMA}

${ORTE_RULES}`;
}

// ── Kontinuitätsprüfung ───────────────────────────────────────────────────────

export function buildKontinuitaetChapterFactsPrompt(chapterName, chText) {
  return `Extrahiere alle konkreten Fakten und Behauptungen aus dem Kapitel «${chapterName}» die für die Kontinuitätsprüfung relevant sind: Figuren-Zustände (lebendig/tot, Verletzungen, Wissen, Beziehungen), Ortsbeschreibungen, Zeitangaben, Objekte und deren Besitz/Zustand, sowie wichtige Handlungsereignisse.

Antworte mit diesem JSON-Schema:
{
  ${FAKTEN_SCHEMA}
}

${FAKTEN_RULES}

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
${PROBLEME_SCHEMA}

${PROBLEME_RULES}`;
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
${PROBLEME_SCHEMA}

${PROBLEME_RULES}`;
}

export function buildLektoratPrompt(text, opts = {}) {
  return _buildLektoratPromptBody(text, 'Originaltext:', opts);
}

// ── Synonym-Suche (Kontextmenü im Editor) ────────────────────────────────────
export function buildSynonymPrompt(wort, satz) {
  return `Schlage 5 bis 8 Synonyme für das Wort «${wort}» vor, die im gegebenen Satzkontext passen. Nur einzelne Ersatzwörter, keine Umschreibungen oder Satzumbauten.

Regeln:
- Exakt gleiche Wortart und grammatische Form (Kasus, Numerus, Tempus, Geschlecht) wie das Originalwort im Satz
- Bedeutung im Kontext muss erhalten bleiben
- Stil, Ton und Register des Autors berücksichtigen
- Keine offensichtlich unpassenden oder weit entfernten Begriffe
- Duplikate und das Originalwort selbst vermeiden

Antworte mit diesem JSON-Schema:
{
  "synonyme": [
    { "wort": "das Ersatzwort", "hinweis": "kurze Note zu Register/Konnotation, z.B. «gehoben», «umgangssprachlich», «stärker» – darf leer sein" }
  ]
}

Satz: ${satz}
Wort: ${wort}`;
}


// ═════════════════════════════════════════════════════════════════════════════
// JSON-Schemas für Grammar-Constrained Decoding (nur lokale Provider)
// ═════════════════════════════════════════════════════════════════════════════
// Werden als `format: <schema>` (Ollama) bzw. `response_format: { type: 'json_schema', ... }`
// (LM Studio/llama.cpp) an den Server übergeben. llama.cpp baut daraus eine GBNF-Grammatik,
// die während des Samplings erzwingt: gültiges JSON, korrekt escapete Strings, Typ-Einhaltung.
//
// Strict-Regeln (LM Studio json_schema mit strict:true):
// - `additionalProperties: false` auf jedem object-Level
// - Jedes object-Property im `required`-Array
// - Enums nur wo Werte stabil und klein sind
//
// Claude verwendet keine Schemas – callAI ignoriert das Argument für Claude.
//
// Hilfsfunktion: schlankes Objekt-Schema mit strict-Defaults.
function _obj(properties, { addl = false } = {}) {
  return {
    type: 'object',
    additionalProperties: addl,
    required: Object.keys(properties),
    properties,
  };
}
const _str = { type: 'string' };
const _num = { type: 'number' };

// ── Lektorat (check + batch-check) ───────────────────────────────────────────
// Enum-Werte müssen mit typEnum in _buildLektoratPromptBody (Slim-Variante) übereinstimmen.
export const SCHEMA_LEKTORAT = _obj({
  fehler: {
    type: 'array',
    items: _obj({
      typ: { type: 'string', enum: ['rechtschreibung', 'grammatik', 'stil', 'wiederholung', 'schwaches_verb', 'fuellwort'] },
      original: _str,
      korrektur: _str,
      kontext: _str,
      erklaerung: _str,
    }),
  },
  szenen: {
    type: 'array',
    items: _obj({
      titel: _str,
      wertung: { type: 'string', enum: ['stark', 'mittel', 'schwach'] },
      kommentar: _str,
    }),
  },
  stilanalyse: _str,
  fazit: _str,
});

// ── Komplett-Extraktion (pro Kapitel) ────────────────────────────────────────
// Typ-Enums bewusst permissiv (type: string ohne enum), weil das Modell hier
// freiere Bezeichnungen produziert und strikte Enums das Sampling blockieren
// könnten. Wichtig ist die Grammatik-Struktur, nicht die Feld-Werte.
const _figurSchema = _obj({
  id: _str,
  name: _str,
  kurzname: _str,
  typ: _str,
  geburtstag: _str,
  geschlecht: _str,
  beruf: _str,
  beschreibung: _str,
  sozialschicht: _str,
  eigenschaften: { type: 'array', items: _str },
  kapitel: { type: 'array', items: _obj({ name: _str, haeufigkeit: _num }) },
  beziehungen: {
    type: 'array',
    items: _obj({ figur_id: _str, typ: _str, machtverhaltnis: _num, beschreibung: _str }),
  },
});
const _ortSchema = _obj({
  id: _str,
  name: _str,
  typ: _str,
  beschreibung: _str,
  erste_erwaehnung: _str,
  stimmung: _str,
  kapitel: { type: 'array', items: _obj({ name: _str, haeufigkeit: _num }) },
  figuren: { type: 'array', items: _str },
});
const _faktSchema = _obj({ kategorie: _str, subjekt: _str, fakt: _str, seite: _str });
export const SCHEMA_KOMPLETT_EXTRAKTION = _obj({
  figuren: { type: 'array', items: _figurSchema },
  orte: { type: 'array', items: _ortSchema },
  fakten: { type: 'array', items: _faktSchema },
  szenen: {
    type: 'array',
    items: _obj({
      seite: _str,
      kapitel: _str,
      titel: _str,
      wertung: { type: 'string', enum: ['stark', 'mittel', 'schwach'] },
      kommentar: _str,
      figuren_namen: { type: 'array', items: _str },
      orte_namen: { type: 'array', items: _str },
    }),
  },
  assignments: {
    type: 'array',
    items: _obj({
      figur_name: _str,
      lebensereignisse: {
        type: 'array',
        items: _obj({
          datum: _str,
          ereignis: _str,
          typ: { type: 'string', enum: ['persoenlich', 'extern'] },
          bedeutung: _str,
          seite: _str,
          kapitel: _str,
        }),
      },
    }),
  },
});

// ── Konsolidierungen (Komplett-Pipeline) ─────────────────────────────────────
export const SCHEMA_FIGUREN_KONSOL = _obj({ figuren: { type: 'array', items: _figurSchema } });
export const SCHEMA_ORTE_KONSOL    = _obj({ orte:    { type: 'array', items: _ortSchema } });

export const SCHEMA_BEZIEHUNGEN = _obj({
  beziehungen: {
    type: 'array',
    items: _obj({ von: _str, zu: _str, typ: _str, machtverhaltnis: _num, beschreibung: _str }),
  },
});

export const SCHEMA_ZEITSTRAHL = _obj({
  ereignisse: {
    type: 'array',
    items: _obj({
      datum: _str,
      ereignis: _str,
      typ: { type: 'string', enum: ['persoenlich', 'extern'] },
      bedeutung: _str,
      kapitel: { type: 'array', items: _str },
      seiten: { type: 'array', items: _str },
      figuren: { type: 'array', items: _obj({ id: _str, name: _str, typ: _str }) },
    }),
  },
});

// ── Kontinuitätsprüfung ──────────────────────────────────────────────────────
export const SCHEMA_KONTINUITAET_FAKTEN = _obj({
  fakten: { type: 'array', items: _faktSchema },
});
export const SCHEMA_KONTINUITAET_PROBLEME = _obj({
  probleme: {
    type: 'array',
    items: _obj({
      schwere: { type: 'string', enum: ['kritisch', 'mittel', 'niedrig'] },
      typ: _str,
      beschreibung: _str,
      stelle_a: _str,
      stelle_b: _str,
      figuren: { type: 'array', items: _str },
      kapitel: { type: 'array', items: _str },
      empfehlung: _str,
    }),
  },
  zusammenfassung: _str,
});

// ── Review ───────────────────────────────────────────────────────────────────
export const SCHEMA_REVIEW = _obj({
  gesamtnote: _num,
  gesamtnote_begruendung: _str,
  zusammenfassung: _str,
  struktur: _str,
  stil: _str,
  staerken: { type: 'array', items: _str },
  schwaechen: { type: 'array', items: _str },
  empfehlungen: { type: 'array', items: _str },
  fazit: _str,
});
export const SCHEMA_CHAPTER_ANALYSIS = _obj({
  themen: _str,
  stil: _str,
  qualitaet: _str,
  staerken: { type: 'array', items: _str },
  schwaechen: { type: 'array', items: _str },
});

// ── Chat ─────────────────────────────────────────────────────────────────────
export const SCHEMA_CHAT = _obj({
  antwort: _str,
  vorschlaege: {
    type: 'array',
    items: _obj({ original: _str, ersatz: _str, begruendung: _str }),
  },
});
export const SCHEMA_BOOK_CHAT = _obj({ antwort: _str });

// ── Stilkorrektur ────────────────────────────────────────────────────────────
export const SCHEMA_STILKORREKTUR = _obj({
  korrekturen: {
    type: 'array',
    items: _obj({ original: _str, ersatz: _str }),
  },
});

// ── Synonym-Suche ────────────────────────────────────────────────────────────
export const SCHEMA_SYNONYM = _obj({
  synonyme: {
    type: 'array',
    items: _obj({ wort: _str, hinweis: _str }),
  },
});
