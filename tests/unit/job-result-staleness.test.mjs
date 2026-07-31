// Job-Result `updatedAt`-Staleness — Contract zwischen Server-Job und Frontend.
//
// CLAUDE.md "Harte Regel": Server-Jobs, deren Resultate auf einem Snapshot
// des BookStack-Seitenstands operieren (Lektorat-Findings mit Positionen,
// Chat-Antworten mit `vorschlaege.original`), liefern `updatedAt: pd.updated_at`.
// Der Client vergleicht im `onDone` mit `currentPage.updated_at`; weicht es ab,
// wird das Ergebnis verworfen statt angewandt.
//
// Verhaltens-Test des Frontend-Pfads lebt in stale-write.test.mjs. Hier:
// Drift-Schutz für das CONTRACT — wer ihn auf Server- oder Frontend-Seite
// versehentlich entfernt, bricht den Test.
//
// Geprüfte Stellen:
//  S1  routes/jobs/lektorat.js#runCheckJob — completeJob-Payload enthält
//      `updatedAt: pd.updated_at`.
//  S2  routes/jobs/chat/page-chat.js#runChatJob — completeJob-Payload enthält
//      `updatedAt: pageUpdatedAt`.
//  F1  public/js/editor/lektorat.js#startCheckPoll.onDone — Discard-Guard
//      `r.updatedAt && this.currentPage?.updated_at && r.updatedAt !== ...`.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');

test('S1: routes/jobs/lektorat.js completeJob-Payload enthält updatedAt', () => {
  const src = read('routes/jobs/lektorat.js');
  // completeJob(jobId, { ... updatedAt: pd.updated_at ... })
  // Wir matchen tolerant: irgendwo zwischen completeJob-Start und nächster
  // Funktion muss `updatedAt:` an `pd.updated_at` gebunden sein.
  const m = src.match(/completeJob\s*\(\s*jobId\s*,\s*\{[\s\S]*?\}\s*,/g);
  assert.ok(m && m.length >= 1, 'mindestens ein completeJob-Aufruf');
  // Mindestens EIN completeJob im Single-Page-Check muss updatedAt setzen.
  const anyHasUpdatedAt = m.some(block => /updatedAt\s*:\s*pd\.updated_at/.test(block));
  assert.ok(anyHasUpdatedAt,
    'runCheckJob completeJob muss `updatedAt: pd.updated_at` setzen — sonst kann Client Staleness nicht erkennen');
});

test('S2: routes/jobs/chat/page-chat.js completeJob-Payload enthält updatedAt', () => {
  const src = read('routes/jobs/chat/page-chat.js');
  // Im Seiten-Chat-Pfad: `updatedAt: pageUpdatedAt` (Variable aus pd.updated_at).
  assert.match(src, /updatedAt\s*:\s*pageUpdatedAt/,
    'runChatJob completeJob muss `updatedAt: pageUpdatedAt` setzen');
  // pageUpdatedAt wird aus pd.updated_at abgeleitet — auch das prüfen.
  assert.match(src, /pageUpdatedAt\s*=\s*pd\.updated_at|const\s+pageUpdatedAt\s*=\s*[\w.]+\.updated_at/,
    'pageUpdatedAt muss aus dem Seiten-Read (pd.updated_at) stammen, nicht erfunden');
});

// Extrahiert den Block-Body ab der ersten `{` nach `fromIdx`. Brace-Counting,
// weil Template-Literals & `${…}`-Expressions eigene `}` enthalten — ein simples
// indexOf('}') würde mitten im Template-Literal stoppen.
function blockBodyAfter(src, fromIdx) {
  const open = src.indexOf('{', fromIdx);
  let depth = 1;
  let i = open + 1;
  let inStr = null, inTpl = 0;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    const prev = src[i - 1];
    if (inStr) {
      if (ch === inStr && prev !== '\\') inStr = null;
    } else if (inTpl > 0) {
      if (ch === '`' && prev !== '\\') inTpl--;
      else if (ch === '$' && src[i + 1] === '{') { depth++; i++; }
      else if (ch === '}') { depth--; }
    } else {
      if (ch === '`') inTpl++;
      else if (ch === '"' || ch === "'") inStr = ch;
      else if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    i++;
  }
  return src.slice(open + 1, i - 1);
}

test('F1: editor/lektorat.js onDone verifiziert den Stempel selbst (nicht via currentPage)', () => {
  const src = read('public/js/editor/lektorat.js');
  // `currentPage.updated_at` ist eine browserlokale Kopie und rückt nur vor,
  // wenn der Collab-Poll lief (40s-Device-Ping als Voraussetzung) — ein Write
  // von einem Zweitgerät erreicht sie nicht verlässlich. onDone MUSS den
  // aktuellen Stempel darum selbst holen.
  assert.match(src, /contentRepo\.loadPage\(\s*pageId\s*,\s*\{\s*fresh:\s*true\s*\}\s*\)/,
    'onDone braucht einen eigenen fresh-Read der Seite für den Stempel-Vergleich');
  assert.match(src, /pd\.updated_at\s*!==\s*r\.updatedAt/,
    'Vergleich muss gegen den frisch geholten pd.updated_at laufen, nicht gegen die lokale Kopie');
});

test('F1b: Findings werden im Stale-Fall gegen den FRISCHEN Text refiltert', () => {
  const src = read('public/js/editor/lektorat.js');
  // Rettung statt Verwerfen: `sortByPosition` ist der Survivor-Filter (es
  // verwirft jedes Finding, dessen `original` im übergebenen HTML nicht
  // auffindbar ist). Basis muss darum die Variable sein, die im Stale-Fall auf
  // den aufgefrischten Stand zeigt — NICHT r.originalHtml.
  assert.match(src, /const\s+findings\s*=\s*sortByPosition\(\s*base\s*,\s*fehler\s*\)/,
    'Findings-Basis muss `base` sein (im Stale-Fall der frische Text), nicht r.originalHtml');
  assert.match(src, /base\s*=\s*this\.originalHtml/,
    'im Stale-Zweig muss `base` auf den via _refetchCurrentPage aufgefrischten Stand zeigen');
  assert.match(src, /await\s+this\._refetchCurrentPage\(\)/,
    'Stale-Zweig muss den frischen Stand in die Seitenansicht ziehen');
  // Überlebt nichts, wird trotzdem verworfen (keine leere Findings-Liste als
  // „geprüft, alles gut" ausgeben).
  assert.match(src, /staleRefiltered\s*&&\s*findings\.length\s*===\s*0/,
    'sind alle Findings hinfällig, muss das Ergebnis komplett verworfen werden');
});

test('F1c: nicht verifizierbarer Stand wird komplett verworfen (Offline-Fallback)', () => {
  const src = read('public/js/editor/lektorat.js');
  // Schlägt der fresh-Read fehl (offline, SW-Fehler, kein pageId), darf NICHT
  // ungeprüft auf dem Job-Snapshot weitergearbeitet werden — dann gilt das alte
  // Verhalten: lokal vergleichen und bei Mismatch verwerfen.
  const guardRe = /if\s*\(\s*!verified\s*&&\s*r\.updatedAt\s*&&\s*this\.currentPage\?\.updated_at\s*&&\s*r\.updatedAt\s*!==\s*this\.currentPage\.updated_at\s*\)/;
  assert.match(src, guardRe, 'Fallback-Guard für den nicht verifizierbaren Fall fehlt');
  const body = blockBodyAfter(src, src.search(guardRe));
  assert.match(body, /\breturn\b/,
    'Discard-Branch muss return-en — sonst werden Findings doch angewandt');
  assert.doesNotMatch(body, /this\.originalHtml\s*=/,
    'Discard-Branch darf originalHtml nicht überschreiben');
  assert.doesNotMatch(body, /this\.lektoratFindings\s*=/,
    'Discard-Branch darf lektoratFindings nicht setzen');
});

