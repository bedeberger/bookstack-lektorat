// Locale-State + System-Prompt-Aufbau. Kern-Orchestrator: configureLocales() liest
// prompt-config.json, baut für jede Locale einen SYSTEM_*-Bündel und setzt die
// Default-Locale-Exports (live-bound, damit Konsumenten ohne Re-Import den aktuellen
// Wert sehen).
//
// Pflichtaufruf-Reihenfolge in prompts.js (Facade): _setIsLocal → _rebuildLektoratSchema
// → _rebuildKomplettSchemas → configureLocales. Schemas vor configureLocales,
// weil _buildLocalePrompts → buildSystemKomplett* → _jsonOnly() den _isLocal-Flag liest.

import { _isLocal, _jsonOnly } from './state.js';
import {
  buildSystemKomplett,
  buildSystemKomplettFiguren,
  buildSystemKomplettFigurenStamm,
  buildSystemKomplettOrteSzenen,
  buildSystemKomplettFakten,
  buildSystemKomplettEvents,
} from './komplett.js';

// Versionsmarker für persistente Caches (z.B. chapter_extract_cache, Phase-1
// Single-Pass-Cache). Der manuelle Prefix erlaubt einen erzwungenen Bump; der
// Suffix `-<hash>` wird von configurePrompts() automatisch aus dem tatsächlich
// gebauten Prompt-/Schema-Inhalt abgeleitet (_setPromptsContentHash). Dadurch
// invalidiert jede Wortlaut- oder Schema-Änderung der SYSTEM_*-Prompts/Schemas den
// Cache von selbst. Änderungen am dynamisch gebauten Lektorat-USER-Prompt (blocks.js,
// buildLektoratPrompt) fliessen NICHT in den Hash → bei solchen Edits den Prefix manuell bumpen.
const PROMPTS_VERSION_BASE = '20';
export let PROMPTS_VERSION = PROMPTS_VERSION_BASE;

/** Setzt den Content-Hash-Suffix an PROMPTS_VERSION (von der Facade aufgerufen,
 *  nachdem alle SYSTEM_*-Prompts und Schemas gebaut sind). */
export function _setPromptsContentHash(hash) {
  PROMPTS_VERSION = hash ? `${PROMPTS_VERSION_BASE}-${hash}` : PROMPTS_VERSION_BASE;
}

/** Serialisierbarer Snapshot aller gebauten Locale-Prompts (alle Locales, alle
 *  SYSTEM_*-Cores inkl. eingebettetem Komplett-Schema) – Basis für den Content-Hash. */
export function _allLocalePromptsSnapshot() {
  return JSON.stringify([..._localeMap.entries()]);
}

// Kompakte Ersatzregeln für commonRules[langCode] im Lokal-Modus.
// Behält nur die Kernregel – WAS GEMELDET WERDEN SOLL ist redundant mit den typ-spezifischen
// Rule-Blöcken, AUTORENSTIL wird separat über SLIM_AUTORENSTIL_RULE nur an Lektorat/Chat
// angehängt (nicht an Analyse-Prompts wie figuren/buchbewertung).
const SLIM_COMMON_RULES = {
  de: 'GRUNDREGEL: Nur eindeutig, zweifelsfrei falsche Stellen melden. Im Zweifel weglassen.',
  en: 'BASIC RULE: Only flag what is clearly and unambiguously wrong. When in doubt, leave it out.',
};

// Kompakte Autorenstil-Regel für Lokal-Modus (pendant zu cfg.autorenstilRule).
// Wird nur an Prompts angehängt, die Textvorschläge erzeugen (Lektorat, Seiten-Chat).
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

// Splittet einen stabilen System-Prompt + buchspezifischen Kontext in zwei
// Cache-Blöcke für Anthropic. Der stabile Block bekommt 1h-TTL → trifft auch
// nach Buchwechsel oder langer Session den Cache; der buchspezifische Teil
// bleibt ephemeral (5min-Default). Ohne bookContextStr fällt das auf einen
// einzelnen String zurück (Standard-Cache).
//
// Konsumiert von Job-Sites via SYSTEM_*_BLOCKS. Lokale Provider (Ollama/Llama)
// erhalten das Array unverändert; callAIChat (lib/ai.js) flattet es vor dem
// Versand zu einem einzelnen String.
function _toCacheBlocks(stableSysString, bookContextStr) {
  if (!bookContextStr) return stableSysString;
  return [
    { text: stableSysString, ttl: '1h' },
    { text: bookContextStr },
  ];
}

// Schlanker System-Prompt für die Synonym-Suche:
// Rolle + Locale-Norm (korrekturRegeln) + optionaler Autor-Kontext + JSON_ONLY.
// Bewusst ohne baseRules/commonRules, da die Aufgabe eng umrissen ist
// und volle Lektoratsregeln ~650 Input-Tokens kosten würden.
function buildSystemSynonym(prefix, korrekturRegeln, buchKontext, stilHint = '') {
  const parts = [prefix || ''];
  if (korrekturRegeln) parts.push(korrekturRegeln);
  const k = (buchKontext || '').trim();
  if (k) parts.push(`AUTOR-KONTEXT: ${k}`);
  const s = (stilHint || '').trim();
  if (s) parts.push(s);
  return parts.filter(Boolean).join('\n\n') + _jsonOnly();
}

// ── Interne Locale-Maps ───────────────────────────────────────────────────────
let _localeMap  = new Map();
let _rawLocales = new Map();
let _autorenstilByLocale = new Map();
let _localChatAddonByLocale = new Map();
let _werkAbgeschlossenByLang = {};
let _buchtypen  = {};
let _erklaerungRule = '';
let _defaultLocale = 'de-CH';

/** Baut ein Locale-Prompts-Objekt aus einer Locale-Config (aus prompt-config.json).
 *  buchKontext: optionaler per-Buch-Kontext (Freitext), wird als soziogramm-Kontext weitergegeben.
 *  autorenstilRule: wird NUR an Prompts angehängt, die Textvorschläge erzeugen
 *  (Lektorat, Seiten-Chat). Analyse-Prompts (buchbewertung, figuren, …)
 *  bleiben davon unberührt – dort soll die Kritik nicht durch Autorenstil-Imitation
 *  abgemildert werden.
 */
function _buildLocalePrompts(localeConfig, globalErklaerungRule, buchKontext = '', autorenstilRule = '', localChatAddon = '', bookContextStr = '', stilprofil = '') {
  const rules = localeConfig.baseRules || '';
  const rulesWithAutorenstil = autorenstilRule ? `${rules}\n\n${autorenstilRule}` : rules;
  const sp    = localeConfig.systemPrompts || {};
  // Nur für lokale Provider (ollama/llama) befüllt; bricht den „Ich kündige an und höre auf"-Trainingsbias.
  const chatAddonSuffix = localChatAddon ? `\n\n${localChatAddon}` : '';

  // Stable Cores (ohne Buch-Kontext) — werden im 1h-Cache-Block gesendet.
  const SYS_LEKTORAT_CORE         = buildSystem(sp.lektorat          || '', rulesWithAutorenstil);
  const SYS_BUCHBEWERTUNG_CORE    = buildSystem(sp.buchbewertung     || '', rules);
  const SYS_KAPITELANALYSE_CORE   = buildSystem(sp.kapitelanalyse    || '', rules);
  const SYS_KAPITELREVIEW_CORE    = buildSystem(sp.kapitelreview     || sp.buchbewertung || '', rules);
  const SYS_FIGUREN_CORE          = buildSystem(sp.figuren           || '', rules);
  const SYS_ORTE_CORE             = buildSystem(sp.orte              || 'Du bist ein Literaturanalytiker. Du identifizierst Schauplätze und Orte präzise und konservativ – nur was im Text eindeutig belegt ist.', rules);
  const SYS_KONTINUITAET_CORE     = buildSystem(sp.kontinuitaet      || 'Du bist ein sorgfältiger Literaturlektor. Du prüfst einen Roman auf Kontinuitätsfehler und Widersprüche – Figuren, Zeitabläufe, Orte, Objekte und Charakterverhalten.', rules);
  const SYS_ZEITSTRAHL_CORE       = buildSystem(sp.zeitstrahl        || '', rules);
  const SYS_RUECKBLICK_CORE       = buildSystem(sp.rueckblick        || 'Du bist ein aufmerksamer, einfühlsamer Beobachter. Du verdichtest datierte Tagebuch-Einträge rückblickend zu Themen, Personen, Orten und bemerkenswerten Tagen – ausschliesslich belegt, ohne zu werten und ohne den Tagebuchtext fortzuschreiben.', rules);
  // Stilprofil-Extraktion: rein deskriptive Analyse. Kein Buch-Kontext-Block
  // (das Profil wird gerade ERST aus dem Text destilliert; VORRANGIGE-ANGABEN
  // sollen die Beschreibung nicht einfärben).
  const SYS_STILPROFIL_CORE       = buildSystem(sp.stilprofil        || 'Du bist ein literarischer Stilanalytiker. Du destillierst aus einer Leseprobe den unverwechselbaren Stil des Autors – rein deskriptiv, ohne zu werten und ohne den Text fortzuschreiben.', rules);
  // Struktur-Check journalistischer Beitraege: prueft die FORM der Textsorte,
  // nicht die Sprache. Bewusst ohne Buch-Kontext-Block — der Soll-Katalog kommt
  // aus der Textsorte (prompts/textsorten.js), nicht aus den Buch-Angaben.
  // Titel-Werkstatt: schlaegt Formulierungen vor, entscheidet aber nichts. Wie
  // beim Struktur-Check bewusst ohne Buch-Kontext-Block — was den Titel traegt,
  // steht im Beitrag, nicht in den Buch-Angaben.
  const SYS_HEADLINE_CORE         = buildSystem(sp.headline          || 'Du bist Blattmacherin einer Tageszeitung und textest den Titelapparat: Dachzeile, Titel, Lead, Teaser. Du arbeitest ausschliesslich mit dem, was im Beitrag steht – du spitzt nicht über die Faktenlage hinaus zu, erfindest keine Zahl und keinen Namen und stellst keine Frage, wo eine Aussage hingehört. Du lieferst Vorschläge zur Auswahl, keine Entscheidung.', rules);
  const SYS_STRUKTUR_CORE         = buildSystem(sp.struktur          || 'Du bist Schlussredakteurin einer Tageszeitung und prüfst einen Beitrag auf die Form seiner Textsorte. Du bewertest AUSSCHLIESSLICH den Aufbau: Aufhänger, Lead, Reihenfolge der Information, Zuschreibung, Gegenposition, Schluss. Sprache, Rechtschreibung und Stil sind NICHT dein Thema – dafür gibt es das Lektorat. Du schreibst den Text nicht um und schlägst keine Formulierungen vor. Leerer Output ist besser als ein erfundener Mangel.', rules);
  // Komplett-Extraktion enthält das Schema; buchKontext fliesst in das Schema-Embedding ein,
  // bleibt aber für die _toCacheBlocks-Split-Logik separat sichtbar — der Core ist
  // bewusst der Builder-Output OHNE bookContextStr-Section (siehe getLocalePromptsForBook).
  const SYS_KOMPLETT_EXTRAKTION_CORE   = buildSystemKomplett(sp.figuren   || '', rules, buchKontext);
  const SYS_KOMPLETT_FIGUREN_PASS_CORE  = buildSystemKomplettFiguren(sp.figuren || '', rules, buchKontext);
  const SYS_KOMPLETT_FIGUREN_STAMM_CORE = buildSystemKomplettFigurenStamm(sp.figuren || '', rules, buchKontext);
  const SYS_KOMPLETT_ORTE_PASS_CORE     = buildSystemKomplettOrteSzenen(sp.orte || sp.figuren || '', rules, buchKontext);
  const SYS_KOMPLETT_FAKTEN_PASS_CORE   = buildSystemKomplettFakten(sp.figuren || '', rules, buchKontext);
  const SYS_KOMPLETT_EVENTS_PASS_CORE   = buildSystemKomplettEvents(sp.figuren || '', rules, buchKontext);

  // Augmented Strings (Backward-Compat): Core + Book-Context als Single-String.
  // Konsumenten ohne Multi-Block-Support (chat-builder, proxies.js) bleiben funktionsfähig.
  const _aug = (core) => bookContextStr ? `${core}\n\n${bookContextStr}` : core;

  // Stilprofil-Injektion (per-Buch, gezielt). Zwei Framings:
  //  · Imitate  → text-erzeugende Prompts (Lektorat/Synonym/Chat): Vorschläge
  //    sollen sich in den Stil einfügen, ohne die Schärfe der Kritik zu mildern.
  //  · Reference → Bewertungs-Prompts (Buch-/Kapitel-Review): das Profil ist der
  //    Massstab für Stimmen-Treue, Abweichungen werden benannt.
  // Bewusst NICHT in Analyse-Prompts (Figuren/Komplett/Orte/Kontinuität) – dort
  // hätte ein Stil-Hinweis keinen Nutzen und nur Token-Kosten.
  const stp = (stilprofil || '').trim();
  const stilImitate = stp
    ? `ETABLIERTES STILPROFIL DES AUTORS (Korrektur- und Textvorschläge müssen sich nahtlos in diesen Stil einfügen, als wären sie vom Autor selbst geschrieben; dein Urteil über Schwächen bleibt davon unberührt – direkt und schonungslos):\n${stp}`
    : '';
  const stilReference = stp
    ? `ETABLIERTES STILPROFIL DES AUTORS (Massstab für Stimmen-Treue: Passagen, die deutlich von diesem Stil abweichen oder generisch/fremd klingen, im Urteil benennen):\n${stp}`
    : '';
  const lektoratCtx = [bookContextStr, stilImitate].filter(Boolean).join('\n\n');
  const reviewCtx   = [bookContextStr, stilReference].filter(Boolean).join('\n\n');
  // Wie _aug, aber mit explizitem Kontext-String (statt dem geteilten bookContextStr).
  const _augCtx = (core, ctx) => ctx ? `${core}\n\n${ctx}` : core;

  return {
    ERKLAERUNG_RULE:             globalErklaerungRule || '',
    KORREKTUR_REGELN:            localeConfig.korrekturRegeln || '',
    STOPWORDS:                   Array.isArray(localeConfig.stopwords) ? localeConfig.stopwords : [],
    BUCH_KONTEXT:                buchKontext,
    SYSTEM_LEKTORAT:             _augCtx(SYS_LEKTORAT_CORE, lektoratCtx),
    SYSTEM_LEKTORAT_BLOCKS:      _toCacheBlocks(SYS_LEKTORAT_CORE, lektoratCtx),
    SYSTEM_BUCHBEWERTUNG:        _augCtx(SYS_BUCHBEWERTUNG_CORE, reviewCtx),
    SYSTEM_BUCHBEWERTUNG_BLOCKS: _toCacheBlocks(SYS_BUCHBEWERTUNG_CORE, reviewCtx),
    // Stilprofil-Extraktion: deskriptive Analyse, kein Buch-Kontext-Block.
    SYSTEM_STILPROFIL:           SYS_STILPROFIL_CORE,
    // Struktur-Check: Formpruefung gegen die Textsorte, kein Buch-Kontext-Block.
    SYSTEM_STRUKTUR:             SYS_STRUKTUR_CORE,
    // Titel-Werkstatt: Vorschlaege zur Auswahl, kein Buch-Kontext-Block.
    SYSTEM_HEADLINE:             SYS_HEADLINE_CORE,
    SYSTEM_KAPITELANALYSE:       _aug(SYS_KAPITELANALYSE_CORE),
    SYSTEM_KAPITELANALYSE_BLOCKS:_toCacheBlocks(SYS_KAPITELANALYSE_CORE, bookContextStr),
    // Kapitel-Review nutzt die gleiche Bewerter-Rolle wie die Buchbewertung,
    // wenn prompt-config.json keinen eigenen `kapitelreview`-Slot liefert.
    SYSTEM_KAPITELREVIEW:        _augCtx(SYS_KAPITELREVIEW_CORE, reviewCtx),
    SYSTEM_KAPITELREVIEW_BLOCKS: _toCacheBlocks(SYS_KAPITELREVIEW_CORE, reviewCtx),
    SYSTEM_FIGUREN:              _aug(SYS_FIGUREN_CORE),
    SYSTEM_FIGUREN_BLOCKS:       _toCacheBlocks(SYS_FIGUREN_CORE, bookContextStr),
    // Synonym-Suche: schlanker System-Prompt – nur Rolle + Locale-Norm (korrekturRegeln)
    // + optionaler Autor-Kontext. Ohne baseRules/commonRules. buchKontext ist hier bereits
    // im Core eingebaut (buildSystemSynonym) — kein zusätzlicher Cache-Split nötig.
    SYSTEM_SYNONYM:              buildSystemSynonym(sp.synonym    || '', localeConfig.korrekturRegeln || '', buchKontext, stilImitate),
    // Chat-Prompts bleiben String (chat-builder konkateniert weitere Sektionen).
    // lektoratCtx (= bookContextStr + Stilprofil-Imitate) wird hier inline
    // gemerged — kein Multi-Block-Split, weil der Builder darauf String erwartet.
    SYSTEM_CHAT:                 _augCtx(buildSystemNoJson(sp.chat        || '', rulesWithAutorenstil), lektoratCtx) + chatAddonSuffix,
    SYSTEM_BOOK_CHAT:            _augCtx(buildSystemNoJson(sp.buchchat    || '', rules), lektoratCtx) + chatAddonSuffix,
    SYSTEM_ORTE:                 _aug(SYS_ORTE_CORE),
    SYSTEM_ORTE_BLOCKS:          _toCacheBlocks(SYS_ORTE_CORE, bookContextStr),
    SYSTEM_KONTINUITAET:         _aug(SYS_KONTINUITAET_CORE),
    SYSTEM_KONTINUITAET_BLOCKS:  _toCacheBlocks(SYS_KONTINUITAET_CORE, bookContextStr),
    SYSTEM_ZEITSTRAHL:           _aug(SYS_ZEITSTRAHL_CORE),
    SYSTEM_ZEITSTRAHL_BLOCKS:    _toCacheBlocks(SYS_ZEITSTRAHL_CORE, bookContextStr),
    // Tagebuch-Rückblick: rückwärtsgewandte Verdichtung. Persona-Fallback wenn
    // prompt-config.json keinen `rueckblick`-Slot liefert. Buch-Locale via baseRules.
    SYSTEM_RUECKBLICK:           _aug(SYS_RUECKBLICK_CORE),
    SYSTEM_RUECKBLICK_BLOCKS:    _toCacheBlocks(SYS_RUECKBLICK_CORE, bookContextStr),
    // Kombinierter System-Prompt für buildExtraktionKomplettChapterPrompt (P1+P5 merged).
    // Schema und Regeln sind im System-Prompt → werden gecacht; User-Message enthält nur Kapiteltext.
    SYSTEM_KOMPLETT_EXTRAKTION:        _aug(SYS_KOMPLETT_EXTRAKTION_CORE),
    SYSTEM_KOMPLETT_EXTRAKTION_BLOCKS: _toCacheBlocks(SYS_KOMPLETT_EXTRAKTION_CORE, bookContextStr),
    // Welle 4 · #11 – für lokale Modelle zweiter fokussierter Pass.
    // Claude nutzt weiterhin SYSTEM_KOMPLETT_EXTRAKTION (kombinierter Single-Call).
    SYSTEM_KOMPLETT_FIGUREN_PASS:        _aug(SYS_KOMPLETT_FIGUREN_PASS_CORE),
    SYSTEM_KOMPLETT_FIGUREN_PASS_BLOCKS: _toCacheBlocks(SYS_KOMPLETT_FIGUREN_PASS_CORE, bookContextStr),
    // Claude-Single-Pass A1: Figuren-Stammdaten ohne Beziehungen (A2 separat).
    SYSTEM_KOMPLETT_FIGUREN_STAMM:        _aug(SYS_KOMPLETT_FIGUREN_STAMM_CORE),
    SYSTEM_KOMPLETT_FIGUREN_STAMM_BLOCKS: _toCacheBlocks(SYS_KOMPLETT_FIGUREN_STAMM_CORE, bookContextStr),
    SYSTEM_KOMPLETT_ORTE_PASS:           _aug(SYS_KOMPLETT_ORTE_PASS_CORE),
    SYSTEM_KOMPLETT_ORTE_PASS_BLOCKS:    _toCacheBlocks(SYS_KOMPLETT_ORTE_PASS_CORE, bookContextStr),
    // Claude-Single-Pass C: eigener Fakten-Pass parallel zu A1/B (lokal: Fakten in Pass B).
    SYSTEM_KOMPLETT_FAKTEN_PASS:         _aug(SYS_KOMPLETT_FAKTEN_PASS_CORE),
    SYSTEM_KOMPLETT_FAKTEN_PASS_BLOCKS:  _toCacheBlocks(SYS_KOMPLETT_FAKTEN_PASS_CORE, bookContextStr),
    // Claude-Single-Pass E: eigener Lebensereignis-Pass über die finale Figurenliste.
    SYSTEM_KOMPLETT_EVENTS_PASS:         _aug(SYS_KOMPLETT_EVENTS_PASS_CORE),
    SYSTEM_KOMPLETT_EVENTS_PASS_BLOCKS:  _toCacheBlocks(SYS_KOMPLETT_EVENTS_PASS_CORE, bookContextStr),
  };
}

// Live-Exports – werden durch configureLocales() gesetzt (Pflicht vor erstem Prompt-Aufruf).
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
export let SYSTEM_SYNONYM               = null;
export let SYSTEM_CHAT                  = null;
export let SYSTEM_BOOK_CHAT             = null;
export let SYSTEM_ORTE                  = null;
export let SYSTEM_KONTINUITAET          = null;
export let SYSTEM_ZEITSTRAHL            = null;
export let SYSTEM_KOMPLETT_EXTRAKTION    = null;
export let SYSTEM_KOMPLETT_FIGUREN_PASS  = null;
export let SYSTEM_KOMPLETT_FIGUREN_STAMM = null;
export let SYSTEM_KOMPLETT_ORTE_PASS     = null;
export let SYSTEM_KOMPLETT_FAKTEN_PASS   = null;

/**
 * Setzt alle System-Prompts aus dem promptConfig-Objekt (geladen aus prompt-config.json).
 * Unterstützt sowohl das neue Locales-Format (cfg.locales) als auch das alte Flat-Format
 * (cfg.baseRules direkt) für Rückwärtskompatibilität.
 * Pflichtaufruf beim App-Start – wirft einen Fehler wenn cfg fehlt.
 *
 * Achtung: setzt _isLocal NICHT selbst und ruft _rebuildSchemas NICHT selbst – dies muss
 * der Aufrufer (Facade prompts.js) vor configureLocales tun, damit _buildLocalePrompts →
 * buildSystemKomplett* den korrekten _isLocal-Flag liest.
 */
export function configureLocales(cfg) {
  if (!cfg) throw new Error('prompt-config.json fehlt oder ist ungültig – Prompts können nicht konfiguriert werden.');

  _localeMap.clear();
  _rawLocales.clear();
  _autorenstilByLocale.clear();
  _localChatAddonByLocale.clear();
  _buchtypen     = cfg.buchtypen || {};
  _erklaerungRule = cfg.erklaerungRule || '';
  _werkAbgeschlossenByLang = cfg.werkAbgeschlossenRule || {};

  if (cfg.locales && typeof cfg.locales === 'object') {
    // ── Neues Format: locales-Map ─────────────────────────────────────────────
    _defaultLocale = cfg.defaultLocale || 'de-CH';
    const commonRules        = cfg.commonRules         || {};
    const autorenstilRaw     = cfg.autorenstilRule     || {};
    const localChatAddonRaw  = cfg.localModelChatRule  || {};
    for (const [key, localeCfg] of Object.entries(cfg.locales)) {
      const langCode = key.split('-')[0];
      // Für lokale Modelle wird commonRules durch eine Slim-Version ersetzt.
      // AUTORENSTIL wird separat gehandhabt und nur an Lektorat/Chat angehängt.
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

  // Globale Exports auf Default-Locale setzen (ESM-Live-Binding für Client-Code).
  // Achtung: nur die String-Form wird hier exportiert; Multi-Block-Varianten
  // (SYSTEM_*_BLOCKS) leben pro Buch und werden via getBookPrompts geliefert.
  const def = _localeMap.get(_defaultLocale) || {};
  ERKLAERUNG_RULE              = def.ERKLAERUNG_RULE              ?? '';
  KORREKTUR_REGELN             = def.KORREKTUR_REGELN             ?? '';
  STOPWORDS                    = def.STOPWORDS                    ?? [];
  SYSTEM_LEKTORAT              = def.SYSTEM_LEKTORAT              ?? null;
  SYSTEM_BUCHBEWERTUNG         = def.SYSTEM_BUCHBEWERTUNG         ?? null;
  SYSTEM_KAPITELANALYSE        = def.SYSTEM_KAPITELANALYSE        ?? null;
  SYSTEM_KAPITELREVIEW         = def.SYSTEM_KAPITELREVIEW         ?? null;
  SYSTEM_FIGUREN               = def.SYSTEM_FIGUREN               ?? null;
  SYSTEM_SYNONYM               = def.SYSTEM_SYNONYM               ?? null;
  SYSTEM_CHAT                  = def.SYSTEM_CHAT                  ?? null;
  SYSTEM_BOOK_CHAT             = def.SYSTEM_BOOK_CHAT             ?? null;
  SYSTEM_ORTE                  = def.SYSTEM_ORTE                  ?? null;
  SYSTEM_KONTINUITAET          = def.SYSTEM_KONTINUITAET          ?? null;
  SYSTEM_ZEITSTRAHL            = def.SYSTEM_ZEITSTRAHL            ?? null;
  SYSTEM_KOMPLETT_EXTRAKTION    = def.SYSTEM_KOMPLETT_EXTRAKTION    ?? null;
  SYSTEM_KOMPLETT_FIGUREN_PASS  = def.SYSTEM_KOMPLETT_FIGUREN_PASS  ?? null;
  SYSTEM_KOMPLETT_FIGUREN_STAMM = def.SYSTEM_KOMPLETT_FIGUREN_STAMM ?? null;
  SYSTEM_KOMPLETT_ORTE_PASS     = def.SYSTEM_KOMPLETT_ORTE_PASS     ?? null;
  SYSTEM_KOMPLETT_FAKTEN_PASS   = def.SYSTEM_KOMPLETT_FAKTEN_PASS   ?? null;
}

/**
 * Gibt ein Locale-Prompts-Objekt zurück, das mit dem per-Buch-Kontext augmentiert ist.
 * Baut die baseRules dynamisch auf (Buchtyp-Block + Freitext-Block) und übergibt
 * buchKontext als soziogramm-Kontext an SYSTEM_KOMPLETT_EXTRAKTION / figurenBasisRules.
 * @param {string} localeKey   z.B. 'de-CH', 'en-US'
 * @param {string|null} buchtyp     Key aus prompt-config.json buchtypen (z.B. 'roman')
 * @param {string|null} buchKontext Freitext des Users (Schauplatz, Epoche, …)
 * @param {boolean}     isFinished  Buch wurde vom Autor als abgeschlossen markiert
 * @returns {{ SYSTEM_LEKTORAT, ..., BUCH_KONTEXT }}
 */
export function getLocalePromptsForBook(localeKey, buchtyp, buchKontext, isFinished = false, hauptland = null, stilprofil = null, zeitlinieReal = false) {
  const rawLocale = _rawLocales.get(localeKey) || _rawLocales.get(_defaultLocale) || {};
  const kontext   = (buchKontext || '').trim();

  // Buchspezifische Sektion separat sammeln — KEIN Inline-Merge in baseRules mehr.
  // _buildLocalePrompts splittet sie via _toCacheBlocks in einen eigenen Cache-Block,
  // damit der stabile SYSTEM-Core (Persona + Regeln + Schema) buchübergreifend
  // gecacht bleiben kann (1h-TTL).
  const langCode    = (localeKey || _defaultLocale).split('-')[0];
  const buchtypDef  = buchtyp && _buchtypen?.[langCode]?.[buchtyp];
  const bookCtxParts = [];
  if (buchtypDef?.zusatz) {
    bookCtxParts.push(`BUCHTYP-KONTEXT: ${buchtypDef.zusatz}`);
  }
  if (kontext) {
    bookCtxParts.push(`VORRANGIGE ANGABEN DES AUTORS (übersteuern bei Konflikt alle obigen Regeln – insbesondere Stil-, Ton- und Formatvorgaben):\n${kontext}`);
  }
  const landCode = /^[A-Za-z]{2}$/.test(String(hauptland || '').trim()) ? String(hauptland).trim().toLowerCase() : null;
  if (landCode) {
    let landName = landCode.toUpperCase();
    try { landName = new Intl.DisplayNames([langCode], { type: 'region' }).of(landCode.toUpperCase()) || landName; } catch { /* Intl-Fallback: Code */ }
    bookCtxParts.push(`HAUPT-SCHAUPLATZLAND: ${landName} (${landCode}). Sofern der Text keinen anderen Schauplatz-Ort belegt, sind Schauplätze in diesem Land verortet; nutze diesen Code als Default für das «land»-Feld von Orten.`);
  }
  if (zeitlinieReal) {
    bookCtxParts.push(`REALE ZEITLINIE: Dieses Buch spielt auf einem realen, kalendarischen Zeitstrahl (echte Jahreszahlen, keine rein erfundene Story-Zeit). Verankere Lebensereignisse deshalb so konkret wie möglich mit echten Jahreszahlen (datum_year) und nutze die Jahres-Inferenz aus dem Kontext (verankerte Jahreszahlen, Lebensspannen, Epoche) besonders konsequent statt dich auf relative Angaben zu beschränken. story_tag (relative Story-Tage) nur, wenn der Text keinerlei kalendarischen Anhaltspunkt bietet.`);
  }
  if (isFinished) {
    const fertigRule = _werkAbgeschlossenByLang?.[langCode];
    if (fertigRule) bookCtxParts.push(fertigRule);
  }
  const bookContextStr = bookCtxParts.join('\n\n');

  // buchKontext als soziogramm-Kontext weitergeben (figurenBasisRules / SYSTEM_KOMPLETT_EXTRAKTION).
  // autorenstilRule wird nur an Lektorat/Chat angehängt (siehe _buildLocalePrompts).
  const autorenstil = _autorenstilByLocale.get(localeKey) || _autorenstilByLocale.get(_defaultLocale) || '';
  const localChatAddon = _localChatAddonByLocale.get(localeKey) || _localChatAddonByLocale.get(_defaultLocale) || '';
  return _buildLocalePrompts(rawLocale, _erklaerungRule, kontext, autorenstil, localChatAddon, bookContextStr, (stilprofil || '').trim());
}

/**
 * Liefert den `reviewSchwerpunkt`-Text für einen Buchtyp einer Locale.
 * Wird von den Buchreview-/Kapitelreview-Prompts genutzt, um den Bewertungs­fokus
 * genre-spezifisch zu schärfen (Krimi: Logik der Auflösung, Sachbuch: Argumentation, …).
 * Bei fehlendem Eintrag oder leerem Feld → '' (Prompt baut dann keinen Schwerpunkt-Block).
 *
 * @param {string} localeKey z.B. 'de-CH', 'en-US'
 * @param {string|null} buchtyp Key aus prompt-config.json buchtypen
 * @returns {string} Schwerpunkt-Text oder ''
 */
export function getBuchtypReviewSchwerpunkt(localeKey, buchtyp) {
  if (!buchtyp) return '';
  const langCode = (localeKey || _defaultLocale).split('-')[0];
  const def = _buchtypen?.[langCode]?.[buchtyp];
  return (def?.reviewSchwerpunkt || '').trim();
}
