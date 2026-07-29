// Prompt-Contract-Test für das Lektorat: verankert die kritischen Invarianten-
// Instruktionen im gebauten Prompt, damit ein Refactor sie nicht STILL entfernt.
//
// Dies ist kein Output-Qualitäts-Eval (das läuft manuell gegen die echte KI via
// `npm run eval:lektorat`), sondern ein Drift-Schutz auf Prompt-STRUKTUR-Ebene:
// jeder Block, der empirisch messbaren Effekt hat (Korrektur-Purität, Zeichen-
// genauigkeit, Anti-Doppelung, Schwere-Schwelle, Selbstkontroll-Pass, das
// VERWORFENE Few-Shot-Beispiel, die XML-Sektionierung), muss im Cloud-Prompt
// vorhanden bleiben. Der lokale Prompt lässt bewusst einen Teil weg – auch das
// wird gegengeprüft, damit die _isLocal-Reduktion nicht versehentlich kippt.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'prompt-config.json'), 'utf8'));
const prompts = await import(pathToFileURL(path.join(ROOT, 'public', 'js', 'prompts.js')).href);

const SAMPLE = 'Es war ein warmer Tag. Sie ging zum Fluss.';

function buildCloud() {
  prompts.configurePrompts(cfg, 'claude');
  return prompts.buildLektoratPrompt(SAMPLE, { langCode: 'de' });
}
function buildLocal() {
  prompts.configurePrompts(cfg, 'ollama');
  return prompts.buildLektoratPrompt(SAMPLE, { langCode: 'de' });
}

// Cloud-Prompt: alle wirkungsstarken Blöcke müssen vorhanden sein.
const CLOUD_INVARIANTS = [
  ['XML-Aufgabe',            '<aufgabe>'],
  ['Output-Format',          '<output_format>'],
  ['Originaltext-Wrapper',   '<originaltext'],
  ['Korrektur-Purität',      'KORREKTUR-PURITÄT'],
  ['Zeichengenauigkeit',     'ZEICHENGENAUIGKEIT von «original»'],
  ['Span-Typ-Konsistenz',    'SPAN-TYP-KONSISTENZ'],
  ['Anti-Doppelung',         'EIN-EINTRAG-PRO-STELLE'],
  ['Schwere-Schwelle',       'SCHWERE-SCHWELLE'],
  ['Selbstkontroll-Pass',    'SELBSTKONTROLL-PASS'],
  ['Verworfenes Few-Shot',   'Beispiel eines VERWORFENEN Eintrags'],
  ['Gutes Few-Shot',         'Beispiel eines GUTEN Eintrags'],
  ['Zusammenfassungs-Disjunktion', 'ZUSAMMENFASSUNGS-DISJUNKTION'],
  ['Mechanik-Ausnahme (nie streichen)', 'MECHANISCHE FEHLER'],
];

test('Cloud-Lektorat-Prompt enthält alle Invarianten-Blöcke', () => {
  const p = buildCloud();
  for (const [label, needle] of CLOUD_INVARIANTS) {
    assert.ok(p.includes(needle), `Cloud-Prompt fehlt Block: ${label} («${needle}»)`);
  }
});

test('Cloud-Lektorat-Prompt liefert das volle Typ-Enum + szenen/stilanalyse/fazit', () => {
  const p = buildCloud();
  for (const typ of ['show_vs_tell', 'ki_geruch', 'perspektivbruch', 'tempuswechsel', 'dialogformat', 'namenskonsistenz']) {
    assert.ok(p.includes(typ), `Cloud-Prompt fehlt Typ: ${typ}`);
  }
  assert.ok(p.includes('"szenen"'), 'Cloud-Schema muss szenen enthalten');
  assert.ok(p.includes('"stilanalyse"'), 'Cloud-Schema muss stilanalyse enthalten');
  assert.ok(p.includes('"fazit"'), 'Cloud-Schema muss fazit enthalten');
});

test('Lokaler Lektorat-Prompt ist bewusst reduziert (kein Schwere-/Selbstkontroll-Block, keine szenen)', () => {
  const local = buildLocal();
  assert.ok(!local.includes('SCHWERE-SCHWELLE'), 'Lokal: keine Schwere-Schwelle');
  assert.ok(!local.includes('SELBSTKONTROLL-PASS'), 'Lokal: kein Selbstkontroll-Pass');
  assert.ok(!local.includes('"szenen"'), 'Lokal: kein szenen-Schema');
  // Der spezialisierte Show-vs-Tell-REGELBLOCK ist cloud-only (der bloße Token
  // «show_vs_tell» taucht lokal noch im Anti-Doppelungs-Beispiel auf – daher am
  // Blockheader prüfen, nicht am Token).
  assert.ok(!local.includes('Show-vs-Tell-Regeln'), 'Lokal: kein Show-vs-Tell-Regelblock');
  assert.ok(!local.includes('KI-Geruch-Regeln'), 'Lokal: kein KI-Geruch-Regelblock');
  // ...aber die Kern-Puritäts-Invarianten bleiben auch lokal:
  assert.ok(local.includes('KORREKTUR-PURITÄT'), 'Lokal: Korrektur-Purität muss bleiben');
  assert.ok(local.includes('ZEICHENGENAUIGKEIT von «original»'), 'Lokal: Zeichengenauigkeit muss bleiben');
  assert.ok(local.includes('EIN-EINTRAG-PRO-STELLE'), 'Lokal: Anti-Doppelung muss bleiben');
  // Reconfigure zurück auf Cloud, damit nachfolgende Suites den Default-State sehen.
  prompts.configurePrompts(cfg, 'claude');
});

test('Systemprompt trägt Rolle + „leerer Output > falscher Output"-Haltung', () => {
  prompts.configurePrompts(cfg, 'claude');
  const sys = prompts.SYSTEM_LEKTORAT || '';
  assert.ok(/Lektor/i.test(sys), 'Systemprompt nennt die Lektor-Rolle');
  assert.ok(/Leerer Output ist besser/i.test(sys), 'Systemprompt trägt die Konservativ-Haltung');
});

// ── Buchtyp-Profile ──────────────────────────────────────────────────────────
// Der Buchtyp waehlt das Fehlertyp-Set (public/js/prompts/lektorat-typen.js). Diese
// Tests verankern, dass die Umschaltung im GEBAUTEN Prompt ankommt — nicht nur in
// der Profil-Tabelle. Vorher erreichte `buchtyp` den Lektorat-Prompt nur als
// Kontext-Zusatz und ueber den Erzaehlform-Block; die Regelbloecke blieben global.

function buildWissenschaft(opts = {}) {
  prompts.configurePrompts(cfg, 'claude');
  return prompts.buildLektoratPrompt(SAMPLE, { langCode: 'de', buchtyp: 'wissenschaft', ...opts });
}

test('Wissenschafts-Prompt fordert keine narrativen Regelbloecke an', () => {
  const p = buildWissenschaft();
  for (const block of ['Show-vs-Tell-Regeln', 'Filterwort-Regeln', 'Klischee-Regeln',
    'KI-Geruch-Regeln', 'Passivkonstruktionen-Regeln', 'Perspektivbruch-Regeln',
    'Dialogformat-Regeln', 'Schwache-Verben-Regeln', 'Figurenkonsistenz-Regeln',
    'Schauplatzkonsistenz-Regeln']) {
    assert.ok(!p.includes(block), `Wissenschaft: Block «${block}» darf nicht drin sein`);
  }
  // Auch nicht im Typ-Enum.
  const enumLine = p.split('\n').find(l => l.includes('"typ": "'));
  assert.ok(enumLine, 'Typ-Enum-Zeile fehlt');
  for (const typ of ['show_vs_tell', 'klischee', 'schwaches_verb', 'filterwort',
    'ki_geruch', 'passiv', 'perspektivbruch', 'dialogformat', 'namenskonsistenz']) {
    assert.ok(!enumLine.includes(typ), `Wissenschaft: Typ «${typ}» darf nicht im Enum stehen`);
  }
});

test('Wissenschafts-Prompt bringt die vier Fach-Regelbloecke + Fach-Varianten', () => {
  const p = buildWissenschaft();
  for (const block of ['Beleg-Regeln (typ: «unbelegt»)', 'Begriffs-Regeln (typ: «begriffsinkonsistenz»)',
    'Autorenreferenz-Regeln (typ: «autorenform»)', 'Hedging-Regeln (typ: «hedging»)',
    'Tempus-Regeln (typ: «tempuswechsel»)', 'Abschnitts-Regeln']) {
    assert.ok(p.includes(block), `Wissenschaft: Block «${block}» fehlt`);
  }
  // Die Fach-Wiederholungsregel muss Fachtermini ausnehmen, sonst arbeitet sie gegen
  // begriffsinkonsistenz (Terminus MUSS wortgleich wiederholt werden).
  assert.ok(/VORRANG-REGEL: Fachbegriffe/.test(p), 'Fachbegriff-Ausnahme in wiederholung fehlt');
  // Und der Prompt muss Nominalstil/Passiv ausdruecklich freigeben.
  assert.ok(/Nominalstil/.test(p), 'Nominalstil-Freigabe fehlt');
  // Kein erfundener Beleg im korrektur-Feld.
  assert.ok(/Erfinde NIEMALS einen Beleg/.test(p), 'Beleg-Erfindungs-Verbot fehlt');
  assert.ok(/BELEG-ERFINDUNG/.test(p), 'Selbstkontroll-Schritt gegen erfundene Belege fehlt');
});

test('Wissenschafts-Prompt behaelt die Puritaets-Invarianten', () => {
  const p = buildWissenschaft();
  for (const [label, needle] of CLOUD_INVARIANTS) {
    assert.ok(p.includes(needle), `Wissenschaft-Prompt fehlt Block: ${label} («${needle}»)`);
  }
});

test('Erzaehlform-Block entfaellt in den Fach-Profilen', () => {
  const opts = { erzaehlperspektive: '1. Person (Ich-Erzähler)', erzaehlzeit: 'Präteritum' };
  const roman = prompts.buildLektoratPrompt(SAMPLE, { langCode: 'de', buchtyp: 'roman', ...opts });
  const wiss = buildWissenschaft(opts);
  assert.ok(roman.includes('Etablierte Erzählform des Buchs'), 'Roman: Erzählform-Block muss bleiben');
  assert.ok(!wiss.includes('Etablierte Erzählform des Buchs'), 'Wissenschaft: kein Erzählform-Block');
});

test('Sachbuch-Prompt: Erzaehl-Handwerk weg, Hedging + Begriffsdisziplin da', () => {
  prompts.configurePrompts(cfg, 'claude');
  const p = prompts.buildLektoratPrompt(SAMPLE, { langCode: 'de', buchtyp: 'sachbuch' });
  assert.ok(!p.includes('Show-vs-Tell-Regeln'), 'Sachbuch: kein Show-vs-Tell');
  assert.ok(!p.includes('Filterwort-Regeln'), 'Sachbuch: kein Filterwort');
  assert.ok(p.includes('Hedging-Regeln'), 'Sachbuch: Hedging fehlt');
  assert.ok(p.includes('Begriffs-Regeln'), 'Sachbuch: Begriffsdisziplin fehlt');
  // Starke Verben und Aktiv bleiben in Sachtexten Ziel – anders als in der Arbeit.
  assert.ok(p.includes('Schwache-Verben-Regeln'), 'Sachbuch: schwaches_verb muss bleiben');
  assert.ok(p.includes('Passivkonstruktionen-Regeln'), 'Sachbuch: passiv muss bleiben');
});

test('Objektiv-Pass schrumpft im Fach-Profil auf reine Mechanik', () => {
  prompts.configurePrompts(cfg, 'claude');
  const figuren = [{ name: 'Anna', geschlecht: 'weiblich' }];
  const roman = prompts.buildObjektivLektoratPrompt(SAMPLE, { buchtyp: 'roman', figuren });
  const wiss = prompts.buildObjektivLektoratPrompt(SAMPLE, { buchtyp: 'wissenschaft', figuren });
  assert.ok(roman.includes('Dialogformat-Regeln'), 'Roman: Dialogformat gehört in den Objektiv-Pass');
  assert.ok(roman.includes('Figurenkonsistenz-Regeln'), 'Roman: Figurenkonsistenz gehört dazu');
  assert.ok(!wiss.includes('Dialogformat-Regeln'), 'Wissenschaft: kein Dialogformat');
  assert.ok(!wiss.includes('Figurenkonsistenz-Regeln'), 'Wissenschaft: keine Figurenkonsistenz');
  assert.ok(wiss.includes('"typ": "rechtschreibung|grammatik"'), 'Wissenschaft: Enum auf Mechanik reduziert');
  // Der Verbots-Katalog muss die Fach-Typen nennen, nicht die narrativen.
  assert.ok(/VERBOTEN[^\n]*hedging/.test(wiss), 'Wissenschaft: hedging fehlt im Verbots-Katalog');
  assert.ok(!/VERBOTEN[^\n]*show_vs_tell/.test(wiss), 'Wissenschaft: show_vs_tell hat im Verbot nichts zu suchen');
});

test('Schema-Enum und Prompt-Enum tragen dasselbe Typ-Set', () => {
  prompts.configurePrompts(cfg, 'claude');
  for (const buchtyp of ['roman', 'sachbuch', 'wissenschaft']) {
    const p = prompts.buildLektoratPrompt(SAMPLE, { langCode: 'de', buchtyp });
    const enumLine = p.split('\n').find(l => l.includes('"typ": "'));
    const promptTypen = enumLine.match(/"typ": "([^"]+)"/)[1].split('|');
    const schemaTypen = prompts.buildLektoratSchema({ buchtyp })
      .properties.fehler.items.properties.typ.enum;
    assert.deepEqual(schemaTypen, promptTypen, `${buchtyp}: Grammar und Prompt-Text weichen ab`);
  }
});
