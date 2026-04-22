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
// Behält nur die Kernregel – WAS GEMELDET WERDEN SOLL ist redundant mit den typ-spezifischen
// Rule-Blöcken, AUTORENSTIL wird separat über SLIM_AUTORENSTIL_RULE nur an Lektorat/Chat/
// Stilkorrektur angehängt (nicht an Analyse-Prompts wie figuren/buchbewertung).
const SLIM_COMMON_RULES = {
  de: 'GRUNDREGEL: Nur eindeutig, zweifelsfrei falsche Stellen melden. Im Zweifel weglassen.',
  en: 'BASIC RULE: Only flag what is clearly and unambiguously wrong. When in doubt, leave it out.',
};

// Kompakte Autorenstil-Regel für Lokal-Modus (pendant zu cfg.autorenstilRule).
// Wird nur an Prompts angehängt, die Textvorschläge erzeugen (Lektorat, Seiten-Chat, Stilkorrektur).
const SLIM_AUTORENSTIL_RULE = {
  de: 'AUTORENSTIL: Korrekturen und Textvorschläge müssen sich in den Stil des vorliegenden Textes einfügen (Satzbau, Rhythmus, Wortwahl, Ton) – als wären sie vom Autor selbst geschrieben. Dein Urteil über Schwächen bleibt davon unberührt: direkt und schonungslos.',
  en: 'AUTHOR STYLE: Corrections and suggested text must fit the style of the given text (sentence structure, rhythm, word choice, tone) — as if written by the author themselves. Your judgment on weaknesses is unaffected: direct and uncompromising.',
};

function buildSystem(prefix, rules) {
  return `${prefix}\n\n${rules}${_jsonOnly()}`;
}

// Für Chat-Prompts: Prefix + Rules, aber kein JSON_ONLY am Ende –
// buildChatSystemPrompt/buildBookChatSystemPrompt hängen das Schema selbst an.
function buildSystemNoJson(prefix, rules) {
  return `${prefix}\n\n${rules}`;
}

// Schlanker System-Prompt für die Synonym-Suche:
// Rolle + Locale-Norm (korrekturRegeln) + optionaler Autor-Kontext + JSON_ONLY.
// Bewusst ohne baseRules/commonRules, da die Aufgabe eng umrissen ist
// und volle Lektoratsregeln ~650 Input-Tokens kosten würden.
function buildSystemSynonym(prefix, korrekturRegeln, buchKontext) {
  const parts = [prefix || ''];
  if (korrekturRegeln) parts.push(korrekturRegeln);
  const k = (buchKontext || '').trim();
  if (k) parts.push(`AUTOR-KONTEXT: ${k}`);
  return parts.filter(Boolean).join('\n\n') + _jsonOnly();
}

// ── Interne Locale-Maps ───────────────────────────────────────────────────────
// _localeMap:  Key: localeKey (z.B. 'de-CH') → vorgebautes Prompts-Objekt (Default ohne Buchkontext)
// _rawLocales: Key: localeKey → roher Locale-Config (baseRules, systemPrompts, stopwords)
//              Wird von getLocalePromptsForBook() benötigt um per-Buch-Prompts zu bauen.
let _localeMap  = new Map();
let _rawLocales = new Map();
let _autorenstilByLocale = new Map(); // localeKey → autorenstil-String (bereits Slim/Full gewählt)
let _localChatAddonByLocale = new Map(); // localeKey → Zusatzregel nur für ollama/llama (Seiten-/Buch-Chat); leer bei Claude
let _buchtypen  = {};        // cfg.buchtypen aus prompt-config.json
let _erklaerungRule = '';    // cfg.erklaerungRule
let _defaultLocale = 'de-CH';

/** Baut ein Locale-Prompts-Objekt aus einer Locale-Config (aus prompt-config.json).
 *  buchKontext: optionaler per-Buch-Kontext (Freitext), wird als soziogramm-Kontext weitergegeben.
 *  autorenstilRule: wird NUR an Prompts angehängt, die Textvorschläge erzeugen
 *  (Lektorat, Seiten-Chat, Stilkorrektur). Analyse-Prompts (buchbewertung, figuren, …)
 *  bleiben davon unberührt – dort soll die Kritik nicht durch Autorenstil-Imitation
 *  abgemildert werden.
 */
function _buildLocalePrompts(localeConfig, globalErklaerungRule, buchKontext = '', autorenstilRule = '', localChatAddon = '') {
  const rules = localeConfig.baseRules || '';
  const rulesWithAutorenstil = autorenstilRule ? `${rules}\n\n${autorenstilRule}` : rules;
  const sp    = localeConfig.systemPrompts || {};
  // Nur für lokale Provider (ollama/llama) befüllt; bricht den „Ich kündige an und höre auf"-Trainingsbias.
  const chatAddonSuffix = localChatAddon ? `\n\n${localChatAddon}` : '';
  return {
    ERKLAERUNG_RULE:             globalErklaerungRule || '',
    KORREKTUR_REGELN:            localeConfig.korrekturRegeln || '',
    STOPWORDS:                   Array.isArray(localeConfig.stopwords) ? localeConfig.stopwords : [],
    BUCH_KONTEXT:                buchKontext,
    SYSTEM_LEKTORAT:             buildSystem(sp.lektorat          || '', rulesWithAutorenstil),
    SYSTEM_BUCHBEWERTUNG:        buildSystem(sp.buchbewertung     || '', rules),
    SYSTEM_KAPITELANALYSE:       buildSystem(sp.kapitelanalyse    || '', rules),
    // Kapitel-Review nutzt die gleiche Bewerter-Rolle wie die Buchbewertung,
    // wenn prompt-config.json keinen eigenen `kapitelreview`-Slot liefert.
    SYSTEM_KAPITELREVIEW:        buildSystem(sp.kapitelreview     || sp.buchbewertung || '', rules),
    SYSTEM_FIGUREN:              buildSystem(sp.figuren           || '', rules),
    SYSTEM_STILKORREKTUR:        buildSystem(sp.stilkorrektur     || '', rulesWithAutorenstil),
    // Synonym-Suche: schlanker System-Prompt – nur Rolle + Locale-Norm (korrekturRegeln)
    // + optionaler Autor-Kontext. Ohne baseRules/commonRules, da die Synonym-Aufgabe
    // klein und eng umrissen ist (Kontextmenü im Editor).
    SYSTEM_SYNONYM:              buildSystemSynonym(sp.synonym    || '', localeConfig.korrekturRegeln || '', buchKontext),
    SYSTEM_CHAT:                 buildSystemNoJson(sp.chat        || '', rulesWithAutorenstil) + chatAddonSuffix,
    SYSTEM_BOOK_CHAT:            buildSystemNoJson(sp.buchchat    || '', rules) + chatAddonSuffix,
    SYSTEM_ORTE:                 buildSystem(sp.orte              || 'Du bist ein Literaturanalytiker. Du identifizierst Schauplätze und Orte präzise und konservativ – nur was im Text eindeutig belegt ist.', rules),
    SYSTEM_KONTINUITAET:         buildSystem(sp.kontinuitaet      || 'Du bist ein sorgfältiger Literaturlektor. Du prüfst einen Roman auf Kontinuitätsfehler und Widersprüche – Figuren, Zeitabläufe, Orte, Objekte und Charakterverhalten.', rules),
    SYSTEM_ZEITSTRAHL:           buildSystem(sp.zeitstrahl        || '', rules),
    // Kombinierter System-Prompt für buildExtraktionKomplettChapterPrompt (P1+P5 merged).
    // Schema und Regeln sind im System-Prompt → werden gecacht; User-Message enthält nur Kapiteltext.
    // buchKontext dient als soziogramm-Kontext für die Sozialschicht-Klassifikation der Figuren.
    SYSTEM_KOMPLETT_EXTRAKTION:  buildSystemKomplett(sp.figuren   || '', rules, buchKontext),
    // Welle 4 · #11 – für lokale Modelle zweiter fokussierter Pass.
    // Claude nutzt weiterhin SYSTEM_KOMPLETT_EXTRAKTION (kombinierter Single-Call).
    SYSTEM_KOMPLETT_FIGUREN_PASS: buildSystemKomplettFiguren(sp.figuren || '', rules, buchKontext),
    SYSTEM_KOMPLETT_ORTE_PASS:    buildSystemKomplettOrteSzenen(sp.orte || sp.figuren || '', rules, buchKontext),
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
export let SYSTEM_KAPITELREVIEW         = null;
export let SYSTEM_FIGUREN               = null;
export let SYSTEM_STILKORREKTUR         = null;
export let SYSTEM_SYNONYM               = null;
export let SYSTEM_CHAT                  = null;
export let SYSTEM_BOOK_CHAT             = null;
export let SYSTEM_ORTE                  = null;
export let SYSTEM_KONTINUITAET          = null;
export let SYSTEM_ZEITSTRAHL            = null;
export let SYSTEM_KOMPLETT_EXTRAKTION   = null;
export let SYSTEM_KOMPLETT_FIGUREN_PASS = null;
export let SYSTEM_KOMPLETT_ORTE_PASS    = null;

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
  // Schemas sind _isLocal-abhängig (machtverhaltnis-Weglassen für lokale Provider)
  // – bei jedem configure neu bauen.
  _rebuildSchemas();

  _localeMap.clear();
  _rawLocales.clear();
  _autorenstilByLocale.clear();
  _localChatAddonByLocale.clear();
  _buchtypen     = cfg.buchtypen || {};
  _erklaerungRule = cfg.erklaerungRule || '';

  if (cfg.locales && typeof cfg.locales === 'object') {
    // ── Neues Format: locales-Map ─────────────────────────────────────────────
    _defaultLocale = cfg.defaultLocale || 'de-CH';
    const commonRules        = cfg.commonRules         || {};
    const autorenstilRaw     = cfg.autorenstilRule     || {};
    const localChatAddonRaw  = cfg.localModelChatRule  || {};
    for (const [key, localeCfg] of Object.entries(cfg.locales)) {
      const langCode = key.split('-')[0];
      // Für lokale Modelle wird commonRules durch eine Slim-Version ersetzt.
      // Das Original enthält den grossen Meta-Block (GRUNDREGEL + WAS GEMELDET WERDEN SOLL)
      // – kleine Modelle werden davon überfordert. AUTORENSTIL wird separat gehandhabt
      // und nur an Lektorat/Chat/Stilkorrektur angehängt (nicht an Analyse-Prompts).
      const common = _isLocal
        ? (SLIM_COMMON_RULES[langCode] || '')
        : (commonRules[langCode] || '');
      const autorenstil = _isLocal
        ? (SLIM_AUTORENSTIL_RULE[langCode] || '')
        : (autorenstilRaw[langCode] || '');
      // Chat-Zusatzregel nur an lokale Provider: zwingt das Modell, Ankündigungen auszuformulieren.
      const localChatAddon = _isLocal ? (localChatAddonRaw[langCode] || '') : '';
      const base = localeCfg.baseRules || '';
      const mergedCfg = {
        ...localeCfg,
        baseRules: common ? `${base}\n\n${common}` : base,
      };
      _rawLocales.set(key, mergedCfg);
      _autorenstilByLocale.set(key, autorenstil);
      _localChatAddonByLocale.set(key, localChatAddon);
      _localeMap.set(key, _buildLocalePrompts(mergedCfg, cfg.erklaerungRule, '', autorenstil, localChatAddon));
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
  SYSTEM_KAPITELREVIEW         = def.SYSTEM_KAPITELREVIEW         ?? null;
  SYSTEM_FIGUREN               = def.SYSTEM_FIGUREN               ?? null;
  SYSTEM_STILKORREKTUR         = def.SYSTEM_STILKORREKTUR         ?? null;
  SYSTEM_SYNONYM               = def.SYSTEM_SYNONYM               ?? null;
  SYSTEM_CHAT                  = def.SYSTEM_CHAT                  ?? null;
  SYSTEM_BOOK_CHAT             = def.SYSTEM_BOOK_CHAT             ?? null;
  SYSTEM_ORTE                  = def.SYSTEM_ORTE                  ?? null;
  SYSTEM_KONTINUITAET          = def.SYSTEM_KONTINUITAET          ?? null;
  SYSTEM_ZEITSTRAHL            = def.SYSTEM_ZEITSTRAHL            ?? null;
  SYSTEM_KOMPLETT_EXTRAKTION   = def.SYSTEM_KOMPLETT_EXTRAKTION   ?? null;
  SYSTEM_KOMPLETT_FIGUREN_PASS = def.SYSTEM_KOMPLETT_FIGUREN_PASS ?? null;
  SYSTEM_KOMPLETT_ORTE_PASS    = def.SYSTEM_KOMPLETT_ORTE_PASS    ?? null;
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
  // autorenstilRule wird nur an Lektorat/Chat/Stilkorrektur angehängt (siehe _buildLocalePrompts).
  const autorenstil = _autorenstilByLocale.get(localeKey) || _autorenstilByLocale.get(_defaultLocale) || '';
  const localChatAddon = _localChatAddonByLocale.get(localeKey) || _localChatAddonByLocale.get(_defaultLocale) || '';
  return _buildLocalePrompts(augLocale, _erklaerungRule, kontext, autorenstil, localChatAddon);
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
/**
 * Erzeugt den Erzählform-Kontextblock für Bewertungs-/Lektorat-Prompts.
 * Bei buchtyp='kurzgeschichten' wird die Angabe als Richtwert deklariert, da
 * einzelne Kurzgeschichten legitim eine andere Perspektive oder Erzählzeit
 * verwenden können. Gibt '' zurück, wenn weder perspektive noch zeit gesetzt
 * sind (kein Block im Prompt).
 *
 * @param {string|null} perspektive  lesbares Label (z.B. '3. Person personal')
 * @param {string|null} zeit         lesbares Label (z.B. 'Präteritum')
 * @param {string|null} buchtyp      Buchtyp-Key (z.B. 'kurzgeschichten')
 * @param {'lektorat'|'review'} mode 'lektorat' verweist auf perspektivbruch/tempuswechsel;
 *                                   'review' bleibt neutraler ("Konsistenzprüfung")
 */
function _buildErzaehlformBlock(perspektive, zeit, buchtyp, mode = 'lektorat') {
  if (!perspektive && !zeit) return '';
  const isShortStories = buchtyp === 'kurzgeschichten';
  const header = isShortStories
    ? 'Erzählform der Sammlung (Richtwert – einzelne Kurzgeschichten dürfen legitim abweichen; Abweichungen NICHT als Fehler melden, wenn sie in sich konsistent bleiben):'
    : (mode === 'review'
      ? 'Etablierte Erzählform des Buchs (Referenz für Konsistenz- und Stilprüfung – abweichende Passagen sind Bruchstellen, sofern nicht dramaturgisch begründet):'
      : 'Etablierte Erzählform des Buchs (verbindliche Referenz für «perspektivbruch» und «tempuswechsel» – abweichende Stellen gegen diese Vorgabe prüfen, nicht gegen Default-Annahmen):');
  const lines = [
    perspektive ? `- Erzählperspektive: ${perspektive}` : null,
    zeit        ? `- Erzählzeit: ${zeit}`              : null,
  ].filter(Boolean);
  // WICHTIG: Die Vorgabe gilt nur für den narrativen Erzähltext. Dialoge,
  // Briefe, innere Monologe, Rückblenden und bewusste Stilmittel haben
  // naturgemäss eigene Perspektive/Zeit und sind KEIN Bruch.
  const scopeNote = `- Gilt NUR für den narrativen Erzähltext. KEIN Bruch ist in folgenden Fällen: direkte Rede / Dialog (Figuren sprechen in ihrer eigenen Zeit), innere Monologe in direkter Form, zitierte Briefe / Tagebuch­einträge / Nachrichten / Dokumente im Roman, erlebte Rede, historisches Präsens als bewusstes Stilmittel, Rückblenden (Plusquamperfekt) und Antizipationen (Futur), sowie Wechsel an Szenen-/Kapitelgrenzen.`;
  return `\n${header}\n${lines.join('\n')}\n${scopeNote}\n`;
}

function _buildLektoratPromptBody(text, textLabel, {
  stopwords = STOPWORDS,
  erklaerungRule = ERKLAERUNG_RULE,
  korrekturRegeln = KORREKTUR_REGELN,
  figuren = [],
  figurenBeziehungen = [],
  orte = [],
  pageName = null,
  chapterName = null,
  erzaehlperspektive = null,
  erzaehlzeit = null,
  buchtyp = null,
  previousExcerpt = null,
} = {}) {
  const metaParts = [];
  if (chapterName) metaParts.push(`Kapitel: «${chapterName}»`);
  if (pageName)    metaParts.push(`Seite: «${pageName}»`);
  const metaBlock = metaParts.length ? `\nVerortung im Buch: ${metaParts.join(' · ')}\n` : '';

  // Erzählform-Block dient nur perspektivbruch/tempuswechsel – lokal ohnehin nicht geprüft.
  const povBlock = _isLocal
    ? ''
    : _buildErzaehlformBlock(erzaehlperspektive, erzaehlzeit, buchtyp, 'lektorat');

  // Lokal: nur Namen (+ Kurzname) als Erkennungshilfe – Geschlecht/Beruf/Typ/Beschreibung
  // werden für Rechtschreibung/Grammatik/Stil nicht gebraucht und kosten nur Tokens.
  const figurenBlock = figuren.length > 0
    ? (_isLocal
      ? `\nBekannte Figuren in diesem Kapitel (Namen sind KEINE Rechtschreibfehler):\n${figuren.map(f => {
          const parts = [f.name];
          if (f.kurzname && f.kurzname !== f.name) parts.push(f.kurzname);
          return '- ' + parts.join(' / ');
        }).join('\n')}\n`
      : `\nBekannte Figuren in diesem Kapitel (Kontext für Namenskonsistenz und Perspektivprüfung):\n${figuren.map(f => {
          const parts = [f.name];
          if (f.kurzname) parts.push(`Kurzname: ${f.kurzname}`);
          if (f.geschlecht) parts.push(f.geschlecht);
          if (f.beruf) parts.push(f.beruf);
          if (f.typ) parts.push(`Typ: ${f.typ}`);
          if (f.beschreibung) parts.push(f.beschreibung);
          return '- ' + parts.join(' | ');
        }).join('\n')}\nHinweis: Figurennamen und deren Varianten sind KEINE Rechtschreibfehler.\n`)
    : '';

  // Beziehungen dienen v.a. Anreden/Pronomen/Perspektiv-Prüfung – lokal nicht relevant.
  const beziehungenBlock = (_isLocal || figurenBeziehungen.length === 0)
    ? ''
    : `\nBeziehungen zwischen diesen Figuren (Kontext für Anreden, Pronomen, Rollen):\n${figurenBeziehungen.map(b => {
        const head = `${b.von} → ${b.zu}: ${b.typ}`;
        return b.beschreibung ? `- ${head} – ${b.beschreibung}` : `- ${head}`;
      }).join('\n')}\n`;

  // Lokal: nur Ortsnamen als Erkennungshilfe – Typ/Stimmung/Beschreibung sind für Lektorat irrelevant.
  const orteBlock = orte.length > 0
    ? (_isLocal
      ? `\nSchauplätze in diesem Kapitel (Ortsnamen sind KEINE Rechtschreibfehler):\n${orte.map(o => '- ' + o.name).join('\n')}\n`
      : `\nSchauplätze in diesem Kapitel (Kontext – Ortsnamen und deren Varianten sind KEINE Rechtschreibfehler):\n${orte.map(o => {
          const parts = [o.name];
          if (o.typ) parts.push(`Typ: ${o.typ}`);
          if (o.stimmung) parts.push(`Stimmung: ${o.stimmung}`);
          if (o.beschreibung) parts.push(o.beschreibung);
          return '- ' + parts.join(' | ');
        }).join('\n')}\n`)
    : '';

  // Vorseiten-Absatz dient Tempus-/Perspektiv-Übergang – lokal nicht geprüft.
  const previousBlock = (_isLocal || !previousExcerpt)
    ? ''
    : `\nLetzter Absatz der vorherigen Seite (NUR als Übergangskontext für Tempus-/Perspektiv-/Pronomen-Prüfung – NICHT bewerten, nicht in «fehler» aufnehmen):\n"""\n${previousExcerpt}\n"""\n`;

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

  // Lokal: szenen/stilanalyse/fazit werden aus Schema und Prompt gestrichen. Kleine Modelle
  // halluzinieren diese Felder oft generisch und das Generieren kostet spürbar Output-Tokens.
  const schemaBlock = _isLocal
    ? `Antworte mit diesem JSON-Schema:
{
  "fehler": [
    {
      "typ": "${typEnum}",
      "original": "das fehlerhafte Wort oder die fehlerhafte Phrase – bei «wiederholung»: vollständiger Satz zeichengenau aus dem Text",
      "korrektur": "die korrekte Version – bei «wiederholung»: derselbe Satz mit Synonym",
      "erklaerung": "kurze Erklärung – nur diesen einen Mangel beschreiben"
    }
  ]
}`
    : `Antworte mit diesem JSON-Schema:
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
}`;

  const szenenRegelnBlock = _isLocal ? '' : `
Szenen-Regeln:
- Eine Szene ist ein abgegrenzter Handlungsabschnitt mit eigenem Anfang und Ende
- Wenn die Seite keine erkennbaren Szenen enthält (z.B. rein beschreibender Text, Exposition): «szenen» als leeres Array zurückgeben
- wertung: «stark» = funktioniert gut, «mittel» = verbesserungswürdig, «schwach» = klare Schwächen`;

  const aufgabeSatz = _isLocal
    ? 'Analysiere den Text vollständig von Anfang bis Ende – nicht nur lokale Abschnitte oder die letzten Sätze – auf Rechtschreibfehler, Grammatikfehler, stilistische Auffälligkeiten und auffällige Wortwiederholungen.'
    : 'Analysiere den Text vollständig von Anfang bis Ende – nicht nur lokale Abschnitte oder die letzten Sätze – auf Rechtschreibfehler, Grammatikfehler, stilistische Auffälligkeiten und auffällige Wortwiederholungen. Bewerte ausserdem die Szenen der Seite.';

  return `${aufgabeSatz}
${metaBlock}${povBlock}${wichtigBlock}${filterBlock}
${schemaBlock}
${beispielBlock}${szenenRegelnBlock}
${_buildStilBlock()}
${_buildWiederholungBlock(stopwords)}
${_buildSchwacheVerbenBlock()}
${_buildFuellwortBlock()}
${spezialBlocks}${figurenBlock}${beziehungenBlock}${orteBlock}${previousBlock}
${textLabel}
${text}`;
}

// Batch-Variante ohne korrekturen_html (spart Output-Tokens, für Server-Side-Jobs)
// opts.stopwords / opts.erklaerungRule überschreiben die globalen Defaults (für locale-aware Aufrufe)
export function buildBatchLektoratPrompt(text, opts = {}) {
  return _buildLektoratPromptBody(text, 'Text:', opts);
}

// ── Buchbewertung ─────────────────────────────────────────────────────────────

export function buildBookReviewSinglePassPrompt(bookName, pageCount, bookText, { erzaehlperspektive = null, erzaehlzeit = null, buchtyp = null } = {}) {
  const povBlock = _buildErzaehlformBlock(erzaehlperspektive, erzaehlzeit, buchtyp, 'review');
  return `Bewerte das folgende Buch «${bookName}» kritisch und umfassend. Analysiere:
- Struktur und Aufbau (Kapitel, Übergänge, Logik)
- Sprachstil und Konsistenz über alle Seiten hinweg
- Stärken des Texts
- Schwächen und Verbesserungspotenzial
- Konkrete Empfehlungen für den Autor

GEWICHTUNG: Stil, Sprache und literarische Qualität sind die zentralen Bewertungskriterien und fliessen stärker in die Gesamtnote ein als Rechtschreib- oder Grammatikfehler.
${povBlock}
Antworte mit diesem JSON-Schema:
{
  "gesamtnote": 4.5,
  "gesamtnote_begruendung": "Ein Satz warum diese Note (gesamtnote als Dezimalzahl von 1.0=sehr schwach bis 6.0=ausgezeichnet, Halbschritte erlaubt)",
  "zusammenfassung": "2-3 Sätze Gesamteindruck",
  "struktur": "Analyse des Aufbaus und der Struktur (3-4 Sätze)",
  "stil": "Analyse des Schreibstils und seiner Konsistenz (3-4 Sätze) – falls eine Erzählform vorgegeben ist: kurz beurteilen, ob Perspektive und Zeit über das Buch hinweg konsistent gehalten werden",
  "staerken": ["Stärke 1", "Stärke 2", "Stärke 3"],
  "schwaechen": ["Schwäche 1", "Schwäche 2"],
  "empfehlungen": ["Empfehlung 1", "Empfehlung 2", "Empfehlung 3"],
  "fazit": "Abschliessendes Urteil in 1-2 Sätzen"
}

Buchinhalt (${pageCount} Seiten):

${bookText}`;
}

export function buildChapterAnalysisPrompt(chapterName, bookName, pageCount, chText, { erzaehlperspektive = null, erzaehlzeit = null, buchtyp = null } = {}) {
  const povBlock = _buildErzaehlformBlock(erzaehlperspektive, erzaehlzeit, buchtyp, 'review');
  return `Analysiere das Kapitel «${chapterName}» aus dem Buch «${bookName}».
Lies den vollständigen Kapiteltext und gib eine kompakte Analyse als JSON zurück:
${povBlock}
Antworte mit diesem JSON-Schema:
{
  "themen": "Hauptthemen und Inhalte in 2-3 Sätzen",
  "stil": "Schreibstilbeobachtungen: Wortwahl, Satzbau, Ton in 2 Sätzen – falls eine Erzählform vorgegeben ist, kurz beurteilen, ob das Kapitel diese konsistent einhält",
  "qualitaet": "Allgemeiner Qualitätseindruck in 1-2 Sätzen",
  "staerken": ["konkrete Stärke 1", "konkrete Stärke 2"],
  "schwaechen": ["konkrete Schwäche 1", "konkrete Schwäche 2"]
}

Kapitelinhalt (${pageCount} Seiten):

${chText}`;
}

// Kapitel-Review: makro-kritische Bewertung eines einzelnen Kapitels.
// Fokus: Dramaturgie, Pacing, Kohärenz, Perspektive, Figuren – Dinge, die
// beim Seiten-Lektorat (Mikro-Fehler) und bei der Buchbewertung (Gesamtnote)
// naturgemäss nicht erfasst werden.
export function buildChapterReviewPrompt(chapterName, bookName, pageCount, chText, { erzaehlperspektive = null, erzaehlzeit = null, buchtyp = null } = {}) {
  const povBlock = _buildErzaehlformBlock(erzaehlperspektive, erzaehlzeit, buchtyp, 'review');
  return `Bewerte das Kapitel «${chapterName}» aus dem Buch «${bookName}» kritisch und umfassend.
Der Fokus liegt auf seitenübergreifenden Qualitäten – nicht auf Mikro-Fehlern (dafür gibt es das Seiten-Lektorat).
Prüfe:
- Dramaturgie und Spannungsbogen (Szenenabfolge, Aufbau, Höhepunkte)
- Pacing (Tempo, Längen, Leerlauf, Szenenrhythmus)
- Kohärenz und roter Faden (Übergänge zwischen Seiten/Szenen, Logik der Handlung)
- Erzählperspektive und Konsistenz innerhalb des Kapitels
- Figuren im Kapitel (Auftreten, Stimmigkeit, Entwicklung)

GEWICHTUNG: Dramaturgie, Pacing und Kohärenz sind die zentralen Bewertungskriterien dieses Kapitels und fliessen stärker in die Gesamtnote ein als sprachliche Einzelmängel.
${povBlock}
Antworte mit diesem JSON-Schema:
{
  "gesamtnote": 4.5,
  "gesamtnote_begruendung": "Ein Satz warum diese Note (gesamtnote als Dezimalzahl von 1.0=sehr schwach bis 6.0=ausgezeichnet, Halbschritte erlaubt)",
  "zusammenfassung": "2-3 Sätze Gesamteindruck dieses Kapitels",
  "dramaturgie": "Spannungsbogen, Szenenstruktur, Aufbau (3-4 Sätze)",
  "pacing": "Tempo, Längen, Leerlauf (2-3 Sätze)",
  "kohaerenz": "Roter Faden und Übergänge zwischen Seiten/Szenen (2-3 Sätze)",
  "perspektive": "Erzählperspektive und Konsistenz innerhalb des Kapitels (1-2 Sätze) – falls eine Erzählform vorgegeben ist: explizit beurteilen, ob das Kapitel ihr folgt oder davon abweicht",
  "figuren": "Auftreten und Stimmigkeit der Figuren in diesem Kapitel (2-3 Sätze)",
  "staerken": ["konkrete Stärke 1", "konkrete Stärke 2", "konkrete Stärke 3"],
  "schwaechen": ["konkrete Schwäche 1", "konkrete Schwäche 2"],
  "empfehlungen": ["Empfehlung 1", "Empfehlung 2", "Empfehlung 3"],
  "fazit": "Abschliessendes Urteil in 1-2 Sätzen"
}

Kapitelinhalt (${pageCount} Seiten):

${chText}`;
}

export function buildBookReviewMultiPassPrompt(bookName, chapterAnalyses, totalPageCount, { erzaehlperspektive = null, erzaehlzeit = null, buchtyp = null } = {}) {
  const povBlock = _buildErzaehlformBlock(erzaehlperspektive, erzaehlzeit, buchtyp, 'review');
  const synthIn = chapterAnalyses.map((ca, i) =>
    `## Kapitel ${i + 1}: ${ca.name} (${ca.pageCount} Seiten)\nThemen: ${ca.themen || '–'}\nStil: ${ca.stil || '–'}\nQualität: ${ca.qualitaet || '–'}\nStärken: ${(ca.staerken || []).join(' | ')}\nSchwächen: ${(ca.schwaechen || []).join(' | ')}`
  ).join('\n\n');
  return `Bewerte das Buch «${bookName}» kritisch und umfassend.
Grundlage sind die Analysen aller ${chapterAnalyses.length} Kapitel (insgesamt ${totalPageCount} Seiten).

GEWICHTUNG: Stil, Sprache und literarische Qualität sind die zentralen Bewertungskriterien und fliessen stärker in die Gesamtnote ein als Rechtschreib- oder Grammatikfehler.
${povBlock}
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
      "typ": "hauptfigur|nebenfigur|antagonist|mentor|randfigur|andere",
      "geburtstag": "JJJJ oder leer wenn unbekannt",
      "geschlecht": "männlich|weiblich|divers|unbekannt",
      "beruf": "Beruf oder Rolle oder leer",
      "rolle": "1 Satz: Funktion in der Handlung (z.B. 'Ermittelt den Mordfall', 'Erzählerin, blickt rückblickend zurück')",
      "motivation": "1 Satz: was die Figur antreibt; leer wenn nicht belegt",
      "konflikt": "1 Satz: zentraler innerer oder äusserer Konflikt; leer wenn nicht belegt",
      "beschreibung": "2-3 Sätze: Rolle + Persönlichkeit + Bedeutung, textnah",
      "sozialschicht": "wirtschaftselite|gehobenes_buergertum|mittelschicht|arbeiterschicht|migrantenmilieu|prekariat|unterwelt|andere",
      "eigenschaften": ["Eigenschaft1", "Eigenschaft2"],
      "praesenz": "zentral|regelmaessig|punktuell|randfigur",
      "entwicklung": "statisch|Kurzbeschreibung des Wandels (1 Satz, z.B. 'verliert Vertrauen in Mentor')",
      "erste_erwaehnung": "Kapitelname oder Seitenname der ersten Erwähnung (leer wenn unklar)",
      "schluesselzitate": ["Bis zu 3 charakterisierende Zitate, max. 80 Zeichen, wörtlich aus dem Text"],
      "kapitel": [{ "name": "Kapitelname", "haeufigkeit": 3 }],
      "beziehungen": [{ "figur_id": "fig_2", "typ": "elternteil|geschwister|kind|freund|feind|kollege|bekannt|liebesbeziehung|rivale|mentor|schuetzling|patronage|geschaeft|andere", "machtverhaltnis": 0, "beschreibung": "1 Satz", "belege": [{ "kapitel": "EXAKT der ## Kapitel-Header", "seite": "EXAKT ein ### Seiten-Header aus dem Kapitel – NIE der Kapitelname; leer wenn unklar" }] }]
    }
  ]
}`;

const figurenBasisRules = (kontext = '') => `Regeln:
- Eindeutige IDs (fig_1, fig_2, …)
- beziehungen.figur_id: nur IDs aus dieser Liste; jede Beziehung nur einmal eintragen
- kapitel: absteigend nach Häufigkeit; haeufigkeit = Anzahl Seiten/Abschnitte mit aktivem Auftreten; name = immer der Kapitelname (aus dem ## Kapitel-Header über dem Abschnitt oder aus dem Prompt-Kontext) – NIEMALS Seitentitel als Kapitelnamen verwenden
- typ: Figuren-Archetyp. hauptfigur=trägt zentral die Handlung, antagonist=Gegenspieler, mentor=Anleiter/Lehrerin, nebenfigur=klar identifizierbarer Sekundärcharakter mit mehreren Auftritten, randfigur=tritt nur am Rand in Erscheinung (kaum mehr als Erwähnung), andere=nicht zuordenbar. NICHT mit praesenz verwechseln (Typ = Rolle, Präsenz = Handlungsgewicht).
- praesenz: Gewichtung der Figur im Gesamtbuch. zentral=Haupthandlungsträger, regelmaessig=wiederkehrend und handlungsrelevant, punktuell=taucht in einzelnen Szenen auf, randfigur=kaum mehr als Erwähnung. Bei Einzelkapitel-Analyse: Einschätzung basiert nur auf diesem Kapitel.
- rolle / motivation / konflikt: je 1 Satz, textnah. Leer lassen wenn nicht belegt – nicht spekulieren.
- beschreibung: 2-3 Sätze Zusammenfassung (Fallback für Anzeige und Chat-Kontext). Soll KEINE Spekulation enthalten.
- schluesselzitate: bis zu 3 wörtliche Zitate (max. 80 Zeichen) die die Figur charakterisieren – exakt aus dem Text, in der Original-Interpunktion. Leer lassen wenn keine prägnanten Stellen gefunden.
- erste_erwaehnung: Kapitel- oder Seitenname der ersten Erwähnung (so präzise wie belegt). Leer wenn unklar.
- entwicklung: "statisch" wenn die Figur über das Buch hinweg unverändert bleibt, sonst 1 Satz zum Wandel. Leer wenn nicht eindeutig.
- sozialschicht: gesellschaftliche Schicht der Figur${kontext ? ` (${kontext})` : ''} – nur vergeben wenn eindeutig belegt; wirtschaftselite=Unternehmerfamilien/Direktoren, gehobenes_buergertum=Akademiker/freie Berufe/obere Kader, mittelschicht=Angestellte/Beamte/mittlere Kader, arbeiterschicht=Fabrik-/Bauarbeiter/Servicepersonal, migrantenmilieu=Zugewanderte/zweite Generation, prekariat=Sozialhilfe/Randständige/Langzeitarbeitslose, unterwelt=kriminelles Milieu, andere=nicht eindeutig
- beziehungen.machtverhaltnis: Machtasymmetrie: +2=Gegenüber (figur_id) dominiert klar, +1=Gegenüber hat leichten Vorteil, 0=symmetrisch, -1=diese Figur hat leichten Vorteil, -2=diese Figur dominiert klar; weglassen oder 0 wenn unklar
- beziehungen.belege: 1-3 Stellen (Kapitelname + Seitentitel) an denen die Beziehung klar wird. Genau wie im Text stehen lassen; leer lassen wenn unsicher. Seitennamen aus ### Überschriften, Kapitelnamen aus ## Überschriften oder dem Prompt-Kontext.
- Beziehungstypen: typ beschreibt die ROLLE von figur_id (NICHT der aktuellen Figur!). Bei Figur X der Eintrag {figur_id: Y, typ: elternteil} bedeutet: Y IST der Elternteil von X. Konkretes Beispiel: Robert hat Mutter Sandra → bei Robert eintragen {figur_id: «<Sandras fig_id>», typ: elternteil, machtverhaltnis: 2}. patronage=Schutzherrschaft (figur_id = Patron), geschaeft=wirtschaftliche Beziehung, geschwister=undirektional, übrige selbsterklärend
- Pro Figurenpaar höchstens EINE Beziehung eintragen – aus der Perspektive EINER Figur. Keine widersprüchlichen Angaben (z.B. nicht gleichzeitig elternteil und kind für dasselbe Paar)
- Nur fiktive Charaktere oder Figuren die aktiv an der Buchhandlung teilnehmen – keine Orte oder Objekte
- KEINE historischen oder realen Personen die nur erwähnt, zitiert oder als Referenz genannt werden (z.B. Napoleon, Einstein, ein Politiker, eine Künstlerin)
- Sortiert nach Wichtigkeit (zentral zuerst)
- KONSERVATIV: Nur Figuren und Beziehungen aufnehmen die im Text eindeutig belegt sind. Lieber weglassen als spekulieren. Leere Strings/Arrays sind besser als erfundene Inhalte.
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
    { "von": "fig_1", "zu": "fig_2", "typ": "elternteil|geschwister|kind|freund|feind|kollege|bekannt|liebesbeziehung|rivale|mentor|schuetzling|patronage|geschaeft|andere", "machtverhaltnis": 0, "beschreibung": "1 Satz", "belege": [{ "kapitel": "EXAKT der ## Kapitel-Header", "seite": "EXAKT ein ### Seiten-Header aus dem Kapitel – NIE der Kapitelname; leer wenn unklar" }] }
  ]
}

Regeln:
- Nur Beziehungen zwischen Figuren aus VERSCHIEDENEN Kapiteln
- Nur Beziehungen die im Buchtext eindeutig belegt sind – KONSERVATIV, lieber weglassen als spekulieren
- von/zu: nur IDs aus der obigen Figurenliste
- Jede Beziehung nur einmal eintragen (nicht von→zu UND zu→von für denselben Typ)
- Keine Beziehungen die bereits in «Bekannte Beziehungen» stehen
- machtverhaltnis: Machtasymmetrie: +2=Gegenüber («zu») dominiert klar, +1=Gegenüber hat leichten Vorteil, 0=symmetrisch, -1=diese Figur («von») hat leichten Vorteil, -2=diese Figur dominiert klar; weglassen oder 0 wenn unklar
- belege: 1-3 Stellen (Kapitelname + Seitentitel) an denen die Beziehung sichtbar wird. Seitennamen aus ### Überschriften, Kapitel aus ## Überschriften des übergebenen Textes.
- Leeres Array wenn keine neuen kapitelübergreifenden Beziehungen eindeutig belegt sind`;
}


// ── Soziogramm-Konsolidierung (Claude-only, holistische Revision) ────────────
export function buildSoziogrammConsolidationPrompt(bookName, figuren, buchKontext = '') {
  const figInfo = figuren.map(f => {
    const nameById = Object.fromEntries(figuren.map(x => [x.id, x.name]));
    const meta = [f.typ, f.beruf, f.geschlecht].filter(Boolean).join(', ');
    const bzStr = (f.beziehungen || [])
      .map(b => `${nameById[b.figur_id] || b.figur_id} [${b.typ}${Number.isFinite(b.machtverhaltnis) ? ', macht=' + b.machtverhaltnis : ''}]`)
      .join(', ');
    return `- **${f.id}** ${f.name}${f.kurzname && f.kurzname !== f.name ? ` («${f.kurzname}»)` : ''} | ${meta || '—'} | sozialschicht=${f.sozialschicht || '—'}` +
      (f.beschreibung ? `\n  ${f.beschreibung}` : '') +
      (bzStr ? `\n  Beziehungen: ${bzStr}` : '');
  }).join('\n');

  return `Buch: «${bookName}»${buchKontext ? `\nBuchkontext: ${buchKontext}` : ''}

Die folgenden Figuren sind bereits konsolidiert. Die preliminary-Werte für sozialschicht und die machtverhaltnis-Werte in den Beziehungen stammen aus einer kapitelweisen Vorab-Analyse und sind oft inkonsistent oder fehlen. Revidiere beides HOLISTISCH mit Blick auf das ganze Buch.

Figurenliste:
${figInfo}

Antworte mit diesem JSON-Schema:
{
  "figuren": [
    { "id": "fig_1", "sozialschicht": "wirtschaftselite|gehobenes_buergertum|mittelschicht|arbeiterschicht|migrantenmilieu|prekariat|unterwelt|andere" }
  ],
  "beziehungen": [
    { "from_fig_id": "fig_1", "to_fig_id": "fig_2", "machtverhaltnis": 0 }
  ]
}

Regeln sozialschicht:
- Für JEDE Figur der Liste einen Eintrag – auch wenn der preliminary-Wert übernommen wird
- id: exakt aus der obigen Liste (keine neuen IDs, keine Namensfelder)
- wirtschaftselite=Unternehmerfamilien/Direktoren, gehobenes_buergertum=Akademiker/freie Berufe/obere Kader, mittelschicht=Angestellte/Beamte/mittlere Kader, arbeiterschicht=Fabrik-/Bauarbeiter/Servicepersonal, migrantenmilieu=Zugewanderte/zweite Generation (primär nach Milieu-Zugehörigkeit, nicht nach beruflichem Status), prekariat=Sozialhilfe/Randständige/Langzeitarbeitslose, unterwelt=kriminelles Milieu, andere=nicht eindeutig zuordenbar
- Innerhalb eines Buchs Milieu-Zuordnungen konsistent halten: wenn zwei Figuren im gleichen Haushalt/Familienverbund leben, teilen sie meist die sozialschicht
- KONSERVATIV: im Zweifel «andere» statt spekulativ eine Schicht wählen

Regeln beziehungen (machtverhaltnis):
- Nur Beziehungen der obigen Liste – keine neuen Paare, keine Pfeile zwischen Figuren ohne bestehende Beziehung
- from_fig_id / to_fig_id: exakt die figur_id aus dem obigen Beziehungsfeld («von» = die Figur in deren Block die Beziehung steht, «zu» = figur_id darin)
- machtverhaltnis: +2=to_fig_id dominiert klar, +1=to_fig_id hat leichten Vorteil, 0=symmetrisch, -1=from_fig_id hat leichten Vorteil, -2=from_fig_id dominiert klar
- HOLISTISCH bewerten: wer hat strukturelle Macht (Kapital, Hierarchie, Wissen), wer psychologische (Manipulation, Autorität)? Im Zweifel 0
- Pro ungeordnetem Paar (A,B) nur EIN Eintrag – nicht sowohl A→B als auch B→A
- Beziehungen weglassen wenn machtverhaltnis unklar oder 0 ist und der preliminary-Wert ebenfalls 0/leer war`;
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
- Das «probleme»-Array ist AUSSCHLIESSLICH für bestätigte Widersprüche da – nicht für Zwischenüberlegungen, geprüfte-aber-verworfene Kandidaten oder Entwarnungen. Wenn ein Kandidat sich beim Nachdenken als harmlos herausstellt, wird er komplett weggelassen, nicht mit einer Erklärung ins Array geschrieben.
- Selbstcheck vor dem Antworten: Lies jede «beschreibung» gegen. Enthält sie Formulierungen wie «kein Widerspruch», «kein echter Widerspruch», «konsistent», «passt zusammen», «stimmig», «wird nicht gemeldet», «Entwarnung», «unproblematisch», «lässt sich erklären durch …» (als Entwarnung) – dann den ganzen Eintrag ersatzlos aus dem Array entfernen. Jede «beschreibung» muss den Widerspruch positiv benennen, nicht seine Abwesenheit.
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
      "seite": "NUR der reine Seitentitel aus einem ### Header – OHNE die ###-Markierung und OHNE führende Leerzeichen. Beispiel: aus «### Was macht Adrian?» wird «Was macht Adrian?». NIEMALS den Kapitelnamen als seite. Leer wenn kein passender ### Header identifizierbar.",
      "kapitel": "NUR der reine Kapitelname aus dem ## Header – OHNE die ##-Markierung. Beispiel: aus «## Der Vater» wird «Der Vater». Nicht der ### Seiten-Header. Leer wenn unklar.",
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
          "seite": "NUR der reine Seitentitel aus einem ### Header – OHNE ###-Markierung. NIE der Kapitelname. Leer wenn unklar.",
          "kapitel": "NUR der reine Kapitelname aus dem ## Header – OHNE ##-Markierung. Nicht der ### Seiten-Header. Leer wenn unklar."
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
- seite: NUR der reine Seitentitel, OHNE die «### »-Markierung am Anfang. Aus «### Was macht Adrian?» wird «Was macht Adrian?». Wortwörtlich sonst (Gross-/Kleinschreibung, Satzzeichen). Leer lassen wenn kein passender ### Header identifizierbar. Der Kapitelname ist NIE ein gültiger Wert für seite.
- kapitel: NUR der reine Kapitelname aus dem ## Header, OHNE die «## »-Markierung.
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

// ── Split-Schemas für lokale Modelle (Welle 4 · #11) ──────────────────────────
// Kleine Modelle werden vom kombinierten 5-Array-Schema überfordert. Für Ollama/llama
// teilen wir die Extraktion in zwei fokussierte Pässe auf. Claude bekommt weiterhin
// den kombinierten Pass (nutzt das grosse Kontextfenster besser).

/** Schema-Block nur für Figuren + Lebensereignisse (Pass A, Lokalmodus). */
function buildKomplettSchemaFigurenOnly(kontext = '') {
  const schemaPart = `Antworte mit diesem JSON-Schema (nur Figuren und Lebensereignisse):
{
  ${_schemaBody(FIGUREN_BASIS_SCHEMA)},
  "assignments": [
    {
      "figur_name": "Figurenname exakt wie im Text",
      "lebensereignisse": [
        {
          "datum": "JJJJ (nur Jahreszahl; aus Kontext errechnen wenn nötig; leer wenn nicht errechenbar)",
          "ereignis": "Was passierte – neutral formuliert. Gleiches Ereignis bei allen beteiligten Figuren identisch.",
          "typ": "persoenlich|extern",
          "bedeutung": "Bedeutung für diese Figur (1 Satz, leer wenn nicht klar)",
          "seite": "EXAKT ein ### Seiten-Header aus dem aktuellen ## Kapitel. NIE der Kapitelname. Leer wenn unklar.",
          "kapitel": "EXAKT der ## Kapitel-Header (nicht ###); leer wenn unklar"
        }
      ]
    }
  ]
}`;
  if (_isLocal) {
    return `${schemaPart}

Kernregeln:
- Nur Figuren erfassen, keine Orte/Szenen/Fakten.
- Eindeutige IDs (fig_1, fig_2, …); Beziehungen nur zwischen IDs dieser Liste.
- KONSERVATIV: Nur was im Text eindeutig belegt ist.
- Keine historischen/realen Personen die nur erwähnt werden.
- kapitel[].name: aus ## Header oder Prompt-Kontext. Nie Seitentitel.
- figur_name: Klarname exakt wie im Text.
- Ereignisse: datum JJJJ; ohne errechenbares Jahr weglassen.
- Leere Arrays wenn nichts gefunden.`;
  }
  return `${schemaPart}

Figuren-Regeln:
${figurenBasisRules(kontext)}

Ereignis-Regeln:
- typ='persoenlich' / typ='extern' wie oben dokumentiert.
- Nur Figuren ausgeben die mindestens ein Ereignis haben.`;
}

/** Schema-Block nur für Orte + Fakten + Szenen (Pass B, Lokalmodus). */
function buildKomplettSchemaOrteSzenen(_kontext = '') {
  const schemaPart = `Antworte mit diesem JSON-Schema (nur Schauplätze, Fakten, Szenen):
{
  ${_schemaBody(ORTE_SCHEMA)},
  ${FAKTEN_SCHEMA},
  "szenen": [
    {
      "seite": "NUR der reine Seitentitel aus einem ### Header – OHNE ###-Markierung (Beispiel: aus «### Was macht Adrian?» wird «Was macht Adrian?»). NIE der Kapitelname. Leer wenn unklar.",
      "kapitel": "NUR der reine Kapitelname aus dem ## Header – OHNE ##-Markierung. Nicht der ### Seiten-Header. Leer wenn unklar.",
      "titel": "Kurze Szenenbezeichnung (1 Satz)",
      "wertung": "stark|mittel|schwach",
      "kommentar": "1-2 Sätze: was funktioniert, was fehlt",
      "figuren_namen": ["Figurenname exakt wie im Text"],
      "orte_namen": ["Schauplatzname exakt wie im Text"]
    }
  ]
}`;
  if (_isLocal) {
    return `${schemaPart}

Kernregeln:
- Keine Figuren-Stammdaten; figuren_namen nur als Klarname-Referenz in Szenen.
- KONSERVATIV: Nur was eindeutig belegt ist.
- kapitel[].name: aus ## Header oder Prompt-Kontext, OHNE «## »-Markierung.
- Szene.seite: reiner Titel eines ### Headers aus dem aktuellen ## Kapitel, OHNE «### »-Markierung. NIE der Kapitelname. Im Zweifel leer.
- Leere Arrays wenn nichts gefunden.`;
  }
  return `${schemaPart}

Schauplatz-Regeln:
${ORTE_RULES}

${FAKTEN_RULES}

Szenen-Regeln:
- seite: NUR der reine Titel eines ### Headers im aktuellen ## Kapitel, OHNE «### »-Markierung. NIEMALS den Kapitelnamen. Bei Unklarheit: leer.
- figuren_namen: Klarnamen exakt wie im Text; leeres Array wenn keine Figur beteiligt.
- orte_namen: exakter Name wie im Text; leeres Array wenn kein konkreter Ort.`;
}

function buildSystemKomplettFiguren(prefix, rules, kontext) {
  return `${prefix}\n\n${rules}\n\n${buildKomplettSchemaFigurenOnly(kontext)}${_jsonOnly()}`;
}
function buildSystemKomplettOrteSzenen(prefix, rules, kontext) {
  return `${prefix}\n\n${rules}\n\n${buildKomplettSchemaOrteSzenen(kontext)}${_jsonOnly()}`;
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

/** Welle 4 · #11 – Pass A: nur Figuren + Lebensereignisse (Lokalmodus).
 *  chText === null: Buchtext ist im System-Prompt (cached, Claude-Single-Pass-Split). */
export function buildExtraktionFigurenPassPrompt(chapterName, bookName, pageCount, chText) {
  const isSinglePass = chapterName === 'Gesamtbuch';
  const scope = isSinglePass ? `dem Buch «${bookName}»` : `dem Kapitel «${chapterName}» des Buchs «${bookName}»`;
  const kapitelNote = isSinglePass
    ? 'Der Text ist in Kapitel-Sektionen gegliedert (## Kapitelname) mit Seiten darunter (### Seitentitel). Für kapitel[].name und lebensereignisse[].kapitel: exakt aus dem ## Header entnehmen.'
    : `Für kapitel[].name und lebensereignisse[].kapitel: immer genau «${chapterName}» verwenden – ### Überschriften sind Seitentitel.`;
  const textBlock = chText == null
    ? 'Der Buchtext steht im System-Prompt oben.'
    : `${isSinglePass ? `Buchtext (${pageCount} Seiten)` : `Kapiteltext (${pageCount} Seiten)`}:\n\n${chText}`;
  return `Extrahiere aus ${scope} AUSSCHLIESSLICH: alle Figuren (inkl. Beziehungen) und alle Lebensereignisse der Figuren. Keine Orte, keine Fakten, keine Szenen – die werden separat extrahiert.

${kapitelNote}

${textBlock}`;
}

/** Welle 4 · #11 – Pass B: nur Orte + Fakten + Szenen (Lokalmodus).
 *  chText === null: Buchtext ist im System-Prompt (cached, Claude-Single-Pass-Split). */
export function buildExtraktionOrtePassPrompt(chapterName, bookName, pageCount, chText) {
  const isSinglePass = chapterName === 'Gesamtbuch';
  const scope = isSinglePass ? `dem Buch «${bookName}»` : `dem Kapitel «${chapterName}» des Buchs «${bookName}»`;
  const kapitelNote = isSinglePass
    ? 'Der Text ist in Kapitel-Sektionen gegliedert (## Kapitelname). Für alle Kapitel-Felder den Namen aus dem ## Header entnehmen.'
    : `Für alle Kapitel-Felder: immer genau «${chapterName}» verwenden.`;
  const textBlock = chText == null
    ? 'Der Buchtext steht im System-Prompt oben.'
    : `${isSinglePass ? `Buchtext (${pageCount} Seiten)` : `Kapiteltext (${pageCount} Seiten)`}:\n\n${chText}`;
  return `Extrahiere aus ${scope} AUSSCHLIESSLICH: alle Schauplätze, alle kontinuitätsrelevanten Fakten und alle Szenen. Figuren-Stammdaten nicht – die sind separat erfasst. In Szenen nur Figurennamen als Referenz nennen.

${kapitelNote}

${textBlock}`;
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
      "figuren": [{ "id": "fig_1", "name": "Name", "typ": "hauptfigur|nebenfigur|antagonist|mentor|randfigur|andere" }]
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
/**
 * Baut den System-Prompt für den Agentic Buch-Chat (Tool-Use-Modus).
 * Unterscheidet sich von buildBookChatSystemPrompt: enthält KEINE Seiteninhalte,
 * dafür eine Anweisung an das Modell, Werkzeuge aufzurufen statt zu raten.
 * Figuren + Review bleiben im System-Prompt (klein, gecacht).
 */
export function buildBookChatAgentSystemPrompt(bookName, figuren, review, systemOverride = null) {
  const parts = [
    systemOverride ?? SYSTEM_BOOK_CHAT,
    '',
    `Buch: «${bookName}»`,
    '',
    'Du hast Zugriff auf Werkzeuge, die Fragen über das gesamte Buch aus einem vorberechneten Index beantworten. Nutze sie, bevor du antwortest, wann immer die Frage gemessen oder aus konkreten Textstellen belegt werden kann:',
    '- Häufigkeit, Verteilung, Erzählperspektive → count_pronouns, get_chapter_stats',
    '- Figurenverteilung, erstes Auftreten → get_figure_mentions, list_chapters',
    '- Konkrete Textstellen oder Zitate → search_passages, get_pages',
    '',
    'Rufe Werkzeuge an, bevor du vermutest. Bei interpretatorischen Fragen (Stil, Ton, Wirkung) kannst du direkt antworten oder mit search_passages Belege suchen.',
    'Maximal 6 Werkzeug-Aufrufe pro Antwort. Halte Werkzeug-Argumente präzise und kurz.',
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
    'Deine finale Antwort (nach allen nötigen Werkzeug-Aufrufen) hat dieses JSON-Format:',
    '{',
    '  "antwort": "Deine Antwort als Freitext (Markdown erlaubt)"',
    '}',
    ...(_isLocal ? [] : ['', JSON_ONLY]),
  );

  return parts.join('\n');
}

/**
 * Werkzeug-Definitionen für den Agentic Buch-Chat.
 * Anthropic-Tool-Format (name/description/input_schema). lib/ai.js liest daraus direkt.
 * Beschreibungen bewusst kurz — kosten Input-Tokens.
 */
export const BOOK_CHAT_TOOLS = [
  {
    name: 'list_chapters',
    description: 'Liefert die komplette Kapitel- und Seitenliste: pro Kapitel chapter_id, Name, Seitenzahl, Wortzahl UND pages[{page_id,page_name,words}]. Zusätzlich total_pages/total_words für das ganze Buch. Nutze dies zuerst für einen Überblick – und um page_ids für get_pages zu bekommen, z.B. wenn du bei einem kleinen Buch alle Seiten laden willst.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'count_pronouns',
    description: 'Zählt Pronomen im ganzen Buch (Summe) oder pro Kapitel (per_chapter=true). Unterscheidet narrativen Text und Dialog. Ideal für Fragen zur Erzählperspektive ("kommt der Ich-Erzähler häufiger vor?").',
    input_schema: {
      type: 'object',
      properties: {
        per_chapter: { type: 'boolean', description: 'true = pro Kapitel aufschlüsseln, false = gesamt (default).' },
        pronouns: {
          type: 'array',
          items: { type: 'string', enum: ['ich', 'du', 'er', 'sie_sg', 'wir', 'ihr_pl', 'man'] },
          description: 'Optionaler Filter auf bestimmte Pronomen-Gruppen. Ohne Angabe: alle.',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_chapter_stats',
    description: 'Zusammenfassende Statistik eines Kapitels: Wortzahl, Satzzahl, Dialoganteil, Top-Figuren-Erwähnungen.',
    input_schema: {
      type: 'object',
      properties: {
        chapter_id: { type: 'integer', description: 'ID des Kapitels (aus list_chapters).' },
      },
      required: ['chapter_id'],
    },
  },
  {
    name: 'get_figure_mentions',
    description: 'Wo und wie oft wird eine Figur erwähnt? Antwort nach Kapitel und Seite, mit Count je Seite. Ideal für "wann taucht X erstmals auf?". Gib figur_id (bevorzugt) ODER figur_name an.',
    input_schema: {
      type: 'object',
      properties: {
        figur_id:   { type: 'string', description: 'fig_id aus der Figurenliste (z.B. "fig_3").' },
        figur_name: { type: 'string', description: 'Alternative: Name oder Kurzname der Figur.' },
      },
      required: [],
    },
  },
  {
    name: 'search_passages',
    description: 'Durchsucht das Buch nach Textstellen. Liefert Treffer mit Kurzkontext (Snippet). Standard: case-insensitive Literal-Suche; mit regex=true als Regex.',
    input_schema: {
      type: 'object',
      properties: {
        pattern:     { type: 'string',  description: 'Suchmuster (literal oder Regex).' },
        regex:       { type: 'boolean', description: 'true = pattern als Regex interpretieren. Default: false.' },
        max_results: { type: 'integer', description: 'Maximale Anzahl Treffer (default 10, max 30).' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'get_pages',
    description: 'Lädt den vollen Text bestimmter Seiten (bei Bedarf für Zitate oder Detail-Analyse). Bis zu 20 Seiten pro Aufruf – bei kleinen Büchern kannst du in einem Call das ganze Buch laden (Page-IDs vorher via list_chapters holen).',
    input_schema: {
      type: 'object',
      properties: {
        ids:                { type: 'array', items: { type: 'integer' }, description: 'Liste der page_ids (aus list_chapters oder anderen Tool-Ergebnissen).' },
        max_chars_per_page: { type: 'integer', description: 'Harte Kürzung pro Seite (default 3000, max 8000).' },
      },
      required: ['ids'],
    },
  },
];

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

export function buildKontinuitaetSinglePassPrompt(bookName, bookText, figurenKompakt, orteKompakt, { erzaehlperspektive = null, erzaehlzeit = null, buchtyp = null } = {}) {
  const figurenStr = figurenKompakt && figurenKompakt.length
    ? '\n\n## Bekannte Figuren\n' + figurenKompakt.map(f => `${f.name} (${f.typ || ''}): ${f.beschreibung || ''}`).join('\n')
    : '';
  const orteStr = orteKompakt && orteKompakt.length
    ? '\n\n## Bekannte Schauplätze\n' + orteKompakt.map(o => `${o.name} (${o.typ || 'andere'}): ${o.beschreibung || ''}`).join('\n')
    : '';
  const povBlock = _buildErzaehlformBlock(erzaehlperspektive, erzaehlzeit, buchtyp, 'review');
  const erzaehlformHint = (erzaehlperspektive || erzaehlzeit) && buchtyp !== 'kurzgeschichten'
    ? ' Erzählform-Brüche: Kapitel oder Passagen, die die oben angegebene Erzählperspektive oder Erzählzeit unbegründet verlassen (Wechsel nur an Szenen-/Kapitelgrenzen oder bei expliziten Rückblenden zulässig) – typ «sonstiges», Beschreibung: «Erzählform-Bruch: …».'
    : '';

  const textBlock = bookText == null
    ? 'Der Buchtext steht im System-Prompt oben.'
    : `Buchtext:\n\n${bookText}`;
  return `Prüfe das Buch «${bookName}» auf Kontinuitätsfehler und Widersprüche.${figurenStr}${orteStr}
${povBlock}
Suche aktiv nach: Figuren die nach ihrem Tod wieder auftauchen; Orte die sich widersprüchlich beschrieben werden; Zeitangaben die nicht vereinbar sind; Objekte die falsch verwendet werden; Figuren die Wissen haben das sie noch nicht haben könnten; Charakterverhalten das ihrer etablierten Persönlichkeit widerspricht; Soziolekt-Brüche: Figuren die plötzlich anders sprechen als durch ihre Herkunft, Bildung und soziale Schicht etabliert (Registerwechsel ohne dramaturgische Begründung).${erzaehlformHint}

${textBlock}

Antworte mit diesem JSON-Schema:
${PROBLEME_SCHEMA}

${PROBLEME_RULES}`;
}

export function buildLektoratPrompt(text, opts = {}) {
  return _buildLektoratPromptBody(text, 'Originaltext:', opts);
}

// ── Synonym-Suche (Kontextmenü im Editor) ────────────────────────────────────
export function buildSynonymPrompt(wort, satz) {
  return `Schlage bis zu 11 Synonyme für das Wort «${wort}» vor, die im gegebenen Satzkontext passen. Nur einzelne Ersatzwörter, keine Umschreibungen oder Satzumbauten.

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
// Lokale Provider erhalten ein reduziertes Schema ohne szenen/stilanalyse/fazit – kleine Modelle
// halluzinieren diese Felder oft generisch, das Generieren kostet Output-Tokens.
// Wird in _rebuildSchemas() neu gebaut, damit _isLocal dynamisch wirkt.
export let SCHEMA_LEKTORAT = null;
function _buildLektoratSchema() {
  const fehlerField = {
    type: 'array',
    items: _obj({
      typ: { type: 'string', enum: ['rechtschreibung', 'grammatik', 'stil', 'wiederholung', 'schwaches_verb', 'fuellwort'] },
      original: _str,
      korrektur: _str,
      kontext: _str,
      erklaerung: _str,
    }),
  };
  if (_isLocal) return _obj({ fehler: fehlerField });
  return _obj({
    fehler: fehlerField,
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
}

// ── Komplett-Extraktion (pro Kapitel) ────────────────────────────────────────
// Typ-Enums bewusst permissiv (type: string ohne enum), weil das Modell hier
// freiere Bezeichnungen produziert und strikte Enums das Sampling blockieren
// könnten. Wichtig ist die Grammatik-Struktur, nicht die Feld-Werte.
// Beziehungs-Items: für lokale Provider wird `machtverhaltnis` absichtlich aus dem
// JSON-Schema weggelassen – kleine Modelle setzen es fast immer 0 oder halluzinieren.
// Lieber das Feld leer lassen als falsche Werte anzeigen. Für Claude bleibt es erhalten.
const _bzBeleg = _obj({ kapitel: _str, seite: _str });
const _bzItem = () => _obj(_isLocal
  ? { figur_id: _str, typ: _str, beschreibung: _str, belege: { type: 'array', items: _bzBeleg } }
  : { figur_id: _str, typ: _str, machtverhaltnis: _num, beschreibung: _str, belege: { type: 'array', items: _bzBeleg } }
);
const _figurSchemaProps = () => ({
  id: _str,
  name: _str,
  kurzname: _str,
  typ: _str,
  geburtstag: _str,
  geschlecht: _str,
  beruf: _str,
  rolle: _str,
  motivation: _str,
  konflikt: _str,
  beschreibung: _str,
  sozialschicht: _str,
  praesenz: { type: 'string', enum: ['zentral', 'regelmaessig', 'punktuell', 'randfigur'] },
  entwicklung: _str,
  erste_erwaehnung: _str,
  schluesselzitate: { type: 'array', items: _str },
  eigenschaften: { type: 'array', items: _str },
  kapitel: { type: 'array', items: _obj({ name: _str, haeufigkeit: _num }) },
  beziehungen: { type: 'array', items: _bzItem() },
});
// Achtung: Das konkrete _figurSchema-Objekt (und alle Schemas, die es enthalten) wird
// in _rebuildSchemas() bei jedem configurePrompts-Aufruf neu gebaut, damit der
// dynamisch gesetzte _isLocal-Flag korrekt wirkt (z.B. machtverhaltnis-Weglassen).
let _figurSchema = _obj(_figurSchemaProps());
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

// Schemas, die Figuren-Einträge oder machtverhaltnis enthalten, werden in
// _rebuildSchemas() neu gebaut. Für Claude-Provider: unverändert. Für Lokal:
// machtverhaltnis fehlt (siehe _bzItem), damit kleine Modelle das Feld nicht
// mit Nullen oder Halluzinationen füllen.
export let SCHEMA_KOMPLETT_EXTRAKTION = null;
export let SCHEMA_KOMPLETT_FIGUREN_PASS = null;
export let SCHEMA_KOMPLETT_ORTE_PASS = null;
export let SCHEMA_FIGUREN_KONSOL = null;
export let SCHEMA_BEZIEHUNGEN = null;

function _szenenField() {
  return {
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
  };
}
function _assignmentsField() {
  return {
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
  };
}

function _buildExtraktionSchema() {
  return _obj({
    figuren: { type: 'array', items: _figurSchema },
    orte: { type: 'array', items: _ortSchema },
    fakten: { type: 'array', items: _faktSchema },
    szenen: _szenenField(),
    assignments: _assignmentsField(),
  });
}

function _buildFigurenPassSchema() {
  return _obj({
    figuren: { type: 'array', items: _figurSchema },
    assignments: _assignmentsField(),
  });
}
function _buildOrtePassSchema() {
  return _obj({
    orte: { type: 'array', items: _ortSchema },
    fakten: { type: 'array', items: _faktSchema },
    szenen: _szenenField(),
  });
}

function _buildBeziehungenSchema() {
  const belegeField = { belege: { type: 'array', items: _bzBeleg } };
  const props = _isLocal
    ? { von: _str, zu: _str, typ: _str, beschreibung: _str, ...belegeField }
    : { von: _str, zu: _str, typ: _str, machtverhaltnis: _num, beschreibung: _str, ...belegeField };
  return _obj({ beziehungen: { type: 'array', items: _obj(props) } });
}

export function _rebuildSchemas() {
  _figurSchema = _obj(_figurSchemaProps());
  SCHEMA_LEKTORAT = _buildLektoratSchema();
  SCHEMA_KOMPLETT_EXTRAKTION = _buildExtraktionSchema();
  SCHEMA_KOMPLETT_FIGUREN_PASS = _buildFigurenPassSchema();
  SCHEMA_KOMPLETT_ORTE_PASS = _buildOrtePassSchema();
  SCHEMA_FIGUREN_KONSOL = _obj({ figuren: { type: 'array', items: _figurSchema } });
  SCHEMA_BEZIEHUNGEN = _buildBeziehungenSchema();
}
_rebuildSchemas();

// ── Konsolidierungen (Komplett-Pipeline) ─────────────────────────────────────
export const SCHEMA_ORTE_KONSOL    = _obj({ orte:    { type: 'array', items: _ortSchema } });

export const SCHEMA_SOZIOGRAMM_KONSOL = _obj({
  figuren:     { type: 'array', items: _obj({ id: _str, sozialschicht: _str }) },
  beziehungen: { type: 'array', items: _obj({ from_fig_id: _str, to_fig_id: _str, machtverhaltnis: _num }) },
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
export const SCHEMA_CHAPTER_REVIEW = _obj({
  gesamtnote: _num,
  gesamtnote_begruendung: _str,
  zusammenfassung: _str,
  dramaturgie: _str,
  pacing: _str,
  kohaerenz: _str,
  perspektive: _str,
  figuren: _str,
  staerken: { type: 'array', items: _str },
  schwaechen: { type: 'array', items: _str },
  empfehlungen: { type: 'array', items: _str },
  fazit: _str,
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
