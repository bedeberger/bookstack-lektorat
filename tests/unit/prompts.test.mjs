// Tests für public/js/prompts.js – Build-Logik:
//  - configurePrompts() füllt System-Prompts aus locales-Map
//  - JSON_ONLY-Footer in System-Prompts (Claude-Mode)
//  - getLocalePromptsForBook() augmentiert baseRules mit BUCHTYP-KONTEXT + Freitext
//  - User-Freitext erscheint mit «VORRANGIGE ANGABEN»-Marker
//  - Lokale Provider (ollama/llama) lassen JSON_ONLY weg
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const cfgPath = path.resolve(here, '..', '..', 'prompt-config.json');
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));

const promptsUrl = new URL('../../public/js/prompts.js', import.meta.url).href;

async function freshPrompts(provider = 'claude') {
  // ESM-Module-Cache umgehen: Cache-Buster pro Test, sonst bleibt der State
  // aus dem vorherigen configurePrompts-Aufruf liegen.
  const mod = await import(`${promptsUrl}?t=${Date.now()}_${Math.random()}`);
  mod.configurePrompts(cfg, provider);
  return mod;
}

test('configurePrompts: setzt System-Prompts auf Default-Locale (de-CH)', async () => {
  const m = await freshPrompts('claude');
  assert.ok(m.SYSTEM_LEKTORAT && m.SYSTEM_LEKTORAT.length > 0);
  assert.ok(m.SYSTEM_BUCHBEWERTUNG && m.SYSTEM_BUCHBEWERTUNG.length > 0);
  assert.ok(m.SYSTEM_FIGUREN && m.SYSTEM_FIGUREN.length > 0);
  assert.ok(m.SYSTEM_KOMPLETT_EXTRAKTION && m.SYSTEM_KOMPLETT_EXTRAKTION.length > 0);
  // Default-Locale ist de-CH → Schweizer Schreibnorm im Prompt
  assert.match(m.SYSTEM_LEKTORAT, /Schweizer/i);
});

test('configurePrompts (claude): JSON_ONLY-Footer in jedem Analyse-Prompt', async () => {
  const m = await freshPrompts('claude');
  // JSON_ONLY-Marker: "Antworte ausschliesslich mit einem JSON-Objekt"
  for (const key of [
    'SYSTEM_LEKTORAT', 'SYSTEM_BUCHBEWERTUNG', 'SYSTEM_KAPITELANALYSE',
    'SYSTEM_KAPITELREVIEW', 'SYSTEM_FIGUREN', 'SYSTEM_STILKORREKTUR',
    'SYSTEM_SYNONYM',
  ]) {
    assert.match(m[key], /Antworte ausschliesslich mit einem JSON-Objekt/, `${key} fehlt JSON_ONLY`);
    assert.match(m[key], /Beginne deine Antwort direkt mit \{/, `${key} fehlt Klammer-Anweisung`);
  }
});

test('configurePrompts (ollama): JSON_ONLY entfällt – Grammar-Constrained Output zwingt Format', async () => {
  const m = await freshPrompts('ollama');
  for (const key of ['SYSTEM_LEKTORAT', 'SYSTEM_BUCHBEWERTUNG', 'SYSTEM_FIGUREN']) {
    assert.doesNotMatch(m[key], /Antworte ausschliesslich mit einem JSON-Objekt/,
      `${key} darf JSON_ONLY im Lokal-Modus NICHT enthalten`);
  }
});

test('getLocalePromptsForBook: ohne Buchtyp + ohne Freitext → keine Augmentation', async () => {
  const m = await freshPrompts('claude');
  const out = m.getLocalePromptsForBook('de-CH', null, '');
  assert.doesNotMatch(out.SYSTEM_LEKTORAT, /BUCHTYP-KONTEXT/);
  assert.doesNotMatch(out.SYSTEM_LEKTORAT, /VORRANGIGE ANGABEN DES AUTORS/);
  assert.equal(out.BUCH_KONTEXT, '');
});

test('getLocalePromptsForBook: Buchtyp injiziert BUCHTYP-KONTEXT in baseRules', async () => {
  const m = await freshPrompts('claude');
  const out = m.getLocalePromptsForBook('de-CH', 'krimi', '');
  assert.match(out.SYSTEM_LEKTORAT, /BUCHTYP-KONTEXT:/);
  assert.match(out.SYSTEM_LEKTORAT, /Krimi oder Thriller/);
  // Auch in Buchbewertung – baseRules wird in alle Analyse-Prompts gemergt.
  assert.match(out.SYSTEM_BUCHBEWERTUNG, /BUCHTYP-KONTEXT:/);
});

test('getLocalePromptsForBook: Buchtyp "andere" hat leeren zusatz → kein Block', async () => {
  const m = await freshPrompts('claude');
  const out = m.getLocalePromptsForBook('de-CH', 'andere', '');
  // zusatz="" → kein BUCHTYP-KONTEXT-Block
  assert.doesNotMatch(out.SYSTEM_LEKTORAT, /BUCHTYP-KONTEXT/);
});

test('getLocalePromptsForBook: Freitext erscheint als VORRANGIGE-ANGABEN-Block', async () => {
  const m = await freshPrompts('claude');
  const freitext = 'Spielt 1893 in Zürich, Erzähler ist 12-jähriges Mädchen.';
  const out = m.getLocalePromptsForBook('de-CH', null, freitext);
  assert.match(out.SYSTEM_LEKTORAT, /VORRANGIGE ANGABEN DES AUTORS/);
  assert.match(out.SYSTEM_LEKTORAT, /übersteuern bei Konflikt/);
  assert.ok(out.SYSTEM_LEKTORAT.includes(freitext), 'Freitext muss wörtlich erscheinen');
  assert.equal(out.BUCH_KONTEXT, freitext);
});

test('getLocalePromptsForBook: Buchtyp + Freitext → beide Blöcke, Freitext nach Buchtyp', async () => {
  const m = await freshPrompts('claude');
  const freitext = 'Schauplatz: Mars-Kolonie 2189.';
  const out = m.getLocalePromptsForBook('de-CH', 'fantasy_scifi', freitext);
  const idxBuchtyp = out.SYSTEM_LEKTORAT.indexOf('BUCHTYP-KONTEXT');
  const idxFreitext = out.SYSTEM_LEKTORAT.indexOf('VORRANGIGE ANGABEN');
  assert.ok(idxBuchtyp > 0);
  assert.ok(idxFreitext > 0);
  assert.ok(idxFreitext > idxBuchtyp,
    'Freitext muss NACH Buchtyp stehen, damit User-Angaben Buchtyp-Defaults übersteuern können');
});

test('getLocalePromptsForBook: unbekannter Buchtyp → ignoriert, kein Crash', async () => {
  const m = await freshPrompts('claude');
  const out = m.getLocalePromptsForBook('de-CH', 'gibtsnicht', '');
  assert.doesNotMatch(out.SYSTEM_LEKTORAT, /BUCHTYP-KONTEXT/);
  assert.ok(out.SYSTEM_LEKTORAT.length > 0, 'Prompt muss trotzdem aufgebaut werden');
});

test('getLocalePromptsForBook: unbekannte Locale → fällt auf Default zurück', async () => {
  const m = await freshPrompts('claude');
  const out = m.getLocalePromptsForBook('xx-YY', null, '');
  assert.ok(out.SYSTEM_LEKTORAT && out.SYSTEM_LEKTORAT.length > 0);
});

test('getLocalePromptsForBook (en-US): erzeugt englische Prompts', async () => {
  const m = await freshPrompts('claude');
  if (!cfg.locales['en-US']) return; // optional – nur testen wenn locale definiert ist
  const out = m.getLocalePromptsForBook('en-US', null, '');
  // englische Locale enthält "JSON FIELD NAMES"-Hinweis aus commonRules.en
  assert.ok(out.SYSTEM_LEKTORAT.length > 0);
});

test('PROMPTS_VERSION: ist gesetzter String – wird als Cache-Key verwendet', async () => {
  const m = await freshPrompts('claude');
  assert.equal(typeof m.PROMPTS_VERSION, 'string');
  assert.ok(m.PROMPTS_VERSION.length > 0);
});

test('buildLektoratPrompt: erzeugt nicht-leeren Prompt-Body', async () => {
  const m = await freshPrompts('claude');
  const out = m.buildLektoratPrompt('Der Hund läuft im Wald.', { buchtyp: 'roman' });
  assert.equal(typeof out, 'string');
  assert.ok(out.length > 50);
  assert.ok(out.includes('Der Hund läuft im Wald.'));
});
