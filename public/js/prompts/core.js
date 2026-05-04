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
  buildSystemKomplettOrteSzenen,
} from './komplett.js';

// Versionsmarker für persistente Caches (z.B. chapter_extract_cache, Phase-1
// Single-Pass-Cache). Bei jeder schemarelevanten Änderung erhöhen, damit alte
// Cache-Einträge nicht mehr matchen und frisch extrahiert wird.
export const PROMPTS_VERSION = '6';

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
let _localeMap  = new Map();
let _rawLocales = new Map();
let _autorenstilByLocale = new Map();
let _localChatAddonByLocale = new Map();
let _buchtypen  = {};
let _erklaerungRule = '';
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
    // + optionaler Autor-Kontext. Ohne baseRules/commonRules.
    SYSTEM_SYNONYM:              buildSystemSynonym(sp.synonym    || '', localeConfig.korrekturRegeln || '', buchKontext),
    SYSTEM_CHAT:                 buildSystemNoJson(sp.chat        || '', rulesWithAutorenstil) + chatAddonSuffix,
    SYSTEM_BOOK_CHAT:            buildSystemNoJson(sp.buchchat    || '', rules) + chatAddonSuffix,
    SYSTEM_ORTE:                 buildSystem(sp.orte              || 'Du bist ein Literaturanalytiker. Du identifizierst Schauplätze und Orte präzise und konservativ – nur was im Text eindeutig belegt ist.', rules),
    SYSTEM_KONTINUITAET:         buildSystem(sp.kontinuitaet      || 'Du bist ein sorgfältiger Literaturlektor. Du prüfst einen Roman auf Kontinuitätsfehler und Widersprüche – Figuren, Zeitabläufe, Orte, Objekte und Charakterverhalten.', rules),
    SYSTEM_ZEITSTRAHL:           buildSystem(sp.zeitstrahl        || '', rules),
    // Kombinierter System-Prompt für buildExtraktionKomplettChapterPrompt (P1+P5 merged).
    // Schema und Regeln sind im System-Prompt → werden gecacht; User-Message enthält nur Kapiteltext.
    SYSTEM_KOMPLETT_EXTRAKTION:  buildSystemKomplett(sp.figuren   || '', rules, buchKontext),
    // Welle 4 · #11 – für lokale Modelle zweiter fokussierter Pass.
    // Claude nutzt weiterhin SYSTEM_KOMPLETT_EXTRAKTION (kombinierter Single-Call).
    SYSTEM_KOMPLETT_FIGUREN_PASS: buildSystemKomplettFiguren(sp.figuren || '', rules, buchKontext),
    SYSTEM_KOMPLETT_ORTE_PASS:    buildSystemKomplettOrteSzenen(sp.orte || sp.figuren || '', rules, buchKontext),
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

  if (cfg.locales && typeof cfg.locales === 'object') {
    // ── Neues Format: locales-Map ─────────────────────────────────────────────
    _defaultLocale = cfg.defaultLocale || 'de-CH';
    const commonRules        = cfg.commonRules         || {};
    const autorenstilRaw     = cfg.autorenstilRule     || {};
    const localChatAddonRaw  = cfg.localModelChatRule  || {};
    for (const [key, localeCfg] of Object.entries(cfg.locales)) {
      const langCode = key.split('-')[0];
      // Für lokale Modelle wird commonRules durch eine Slim-Version ersetzt.
      // AUTORENSTIL wird separat gehandhabt und nur an Lektorat/Chat/Stilkorrektur angehängt.
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
  // buchKontext als soziogramm-Kontext weitergeben (figurenBasisRules / SYSTEM_KOMPLETT_EXTRAKTION).
  // autorenstilRule wird nur an Lektorat/Chat/Stilkorrektur angehängt (siehe _buildLocalePrompts).
  const autorenstil = _autorenstilByLocale.get(localeKey) || _autorenstilByLocale.get(_defaultLocale) || '';
  const localChatAddon = _localChatAddonByLocale.get(localeKey) || _localChatAddonByLocale.get(_defaultLocale) || '';
  return _buildLocalePrompts(augLocale, _erklaerungRule, kontext, autorenstil, localChatAddon);
}
