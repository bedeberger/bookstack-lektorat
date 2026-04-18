#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'prompt-config.json');

function fail(msg) {
  console.error(`[validate-prompt-config] FAIL: ${msg}`);
  process.exit(1);
}

let cfg;
try {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  cfg = JSON.parse(raw);
} catch (e) {
  fail(`prompt-config.json nicht lesbar/parsebar: ${e.message}`);
}

const REQUIRED_TOP = ['erklaerungRule', 'defaultLocale', 'commonRules', 'autorenstilRule', 'buchtypen', 'locales'];
for (const k of REQUIRED_TOP) {
  if (!(k in cfg)) fail(`Top-Level-Feld fehlt: ${k}`);
}

const LANGS = ['de', 'en'];
for (const lang of LANGS) {
  if (typeof cfg.commonRules?.[lang] !== 'string' || !cfg.commonRules[lang].trim()) {
    fail(`commonRules.${lang} fehlt oder leer`);
  }
  if (typeof cfg.autorenstilRule?.[lang] !== 'string' || !cfg.autorenstilRule[lang].trim()) {
    fail(`autorenstilRule.${lang} fehlt oder leer`);
  }
  const typen = cfg.buchtypen?.[lang];
  if (!typen || typeof typen !== 'object') fail(`buchtypen.${lang} fehlt`);
  for (const [key, val] of Object.entries(typen)) {
    if (typeof val?.label !== 'string' || !val.label.trim()) {
      fail(`buchtypen.${lang}.${key}.label fehlt oder leer`);
    }
    if (typeof val?.zusatz !== 'string') {
      fail(`buchtypen.${lang}.${key}.zusatz fehlt (darf leer sein, aber muss existieren)`);
    }
  }
}

const typenDe = Object.keys(cfg.buchtypen.de);
const typenEn = Object.keys(cfg.buchtypen.en);
const missingInEn = typenDe.filter(k => !typenEn.includes(k));
const missingInDe = typenEn.filter(k => !typenDe.includes(k));
if (missingInEn.length) fail(`buchtypen nur in de: ${missingInEn.join(', ')}`);
if (missingInDe.length) fail(`buchtypen nur in en: ${missingInDe.join(', ')}`);

if (!cfg.locales || typeof cfg.locales !== 'object') fail('locales-Objekt fehlt');
if (!cfg.locales[cfg.defaultLocale]) fail(`defaultLocale "${cfg.defaultLocale}" nicht in locales vorhanden`);

for (const [locale, loc] of Object.entries(cfg.locales)) {
  for (const f of ['korrekturRegeln', 'baseRules', 'systemPrompts']) {
    if (!loc[f]) fail(`locales.${locale}.${f} fehlt`);
  }
  if (!Array.isArray(loc.stopwords)) fail(`locales.${locale}.stopwords muss Array sein`);
  const sp = loc.systemPrompts;
  const REQUIRED_PROMPTS = ['lektorat', 'buchbewertung', 'kapitelanalyse', 'figuren', 'chat', 'buchchat', 'orte', 'kontinuitaet', 'szenen', 'zeitstrahl'];
  for (const key of REQUIRED_PROMPTS) {
    if (typeof sp[key] !== 'string' || !sp[key].trim()) {
      fail(`locales.${locale}.systemPrompts.${key} fehlt oder leer`);
    }
  }
}

console.log(`[validate-prompt-config] OK — ${Object.keys(cfg.locales).length} Locales, ${typenDe.length} Buchtypen`);
