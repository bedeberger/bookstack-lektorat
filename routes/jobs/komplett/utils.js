'use strict';

const crypto = require('crypto');

/** Reduziert KI-Ref (String oder {name,id,…}-Objekt) auf einen blanken Namen.
 *  KI liefert in figuren_namen/orte_namen/issue.figuren etc. gelegentlich Objekte
 *  statt Strings — ohne Normalisierung würde `[object Object]` durch die Pipeline
 *  laufen oder `n?.toLowerCase()` werfen. */
function _refToString(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') {
    const s = v.name || v.titel || v.label || v.fig_id || v.loc_id || v.id;
    return s ? String(s).trim() || null : null;
  }
  return null;
}

/** Passt der zu erwartende Output einer Konsolidierung noch unter das Output-Cap?
 *  Liefert `{ estOut, cap, fits }`; pure.
 *
 *  **Why:** Eine Konsolidierung schreibt die eingespeisten Felder praktisch vollständig
 *  zurück — dedupliziert zwar, ergänzt dafür JSON-Schlüssel und Anführungszeichen. Der
 *  Prompt ist damit der beste verfügbare Schätzer für die Antwortlänge. Reisst der Call
 *  am Cap, wirft `aiCall` `job.error.aiTruncated`, das ganze Ergebnis ist verloren und
 *  der Aufrufer fällt auf seinen regelbasierten Merge zurück — die Generierung ist zu
 *  dem Zeitpunkt aber bereits bezahlt. Bei einem lokalen Modell mit 20–30 tok/s sind
 *  das für ein 32K-Cap rund 20 Minuten für ein verworfenes Ergebnis. Vorher zu fragen
 *  ändert am ERGEBNIS nichts (derselbe Fallback), spart aber die Wartezeit — und macht
 *  im Log sichtbar, an welchem Wert es lag.
 *
 *  `reserve` (Default 0.9) hält Luft für den Schätzfehler in beide Richtungen. Bewusst
 *  grosszügig: ein fälschlich übersprungener Call kostet Qualität, ein fälschlich
 *  geführter nur Zeit — im Zweifel also lieber rufen. */
function consolidationFitsCap({ promptText, charsPerToken, cap, reserve = 0.9 }) {
  const cpt = Number(charsPerToken) > 0 ? Number(charsPerToken) : 4;
  const capN = Number(cap) > 0 ? Number(cap) : 0;
  const estOut = Math.ceil(String(promptText || '').length / cpt);
  // Ohne brauchbares Cap nicht raten — dann lieber rufen (bisheriges Verhalten).
  if (!capN) return { estOut, cap: capN, fits: true };
  return { estOut, cap: capN, fits: estOut <= capN * reserve };
}

/** Extrahiert ein Feld aus settledAll-Ergebnissen in das Kapitel-Array-Format. */
function extractField(settled, chunkTexts, field) {
  return settled.map((r, i) => ({
    kapitel: chunkTexts[i].chunk.name,
    [field]: r.status === 'fulfilled' ? (r.value?.[field] || []) : [],
  }));
}

/** Löst Klarnamen einer Entität (Song/Ort) gegen die kanonische Figurenliste zu fig_ids auf –
 *  identisches Muster wie remapSzenen (exakt, dann lowercase-Fallback). Nicht auflösbare
 *  Namen werden verworfen. Ergebnis dedupliziert. Songs UND Orte referenzieren Figuren über
 *  Namen (nicht fig_id), weil der Extraktions-Pass A1s ID-Namespace nicht teilt. */
function _remapFigNames(names, figNameToId, figNameToIdLower) {
  const out = [];
  const seen = new Set();
  for (const n of (names || [])) {
    const name = _refToString(typeof n === 'object' && n ? (n.name ?? n) : n);
    if (!name) continue;
    const id = figNameToId?.[name] || figNameToIdLower?.[name.toLowerCase()] || null;
    if (id && !seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

/**
 * Baut den System-Block mit dem Buchtext, der über mehrere Claude-Calls gecached wird.
 * Byte-identische Formatierung in Phase 1 Pass A/B und Phase 8 Kontinuität,
 * damit der Cache-Prefix-Match greift (erster cache_control-Breakpoint).
 */
function buildBookSystemBlockText(bookName, pageCount, fullBookText) {
  return `Buch: «${bookName}»\n\nBuchtext (${pageCount} Seiten):\n\n${fullBookText}`;
}

/**
 * Settings-Anteil der Cache-Signatur (language/region/buchtyp/buch_kontext).
 * SSoT für Single-Pass (buildBookPagesSig) UND Multi-Pass-Chunk-Keys: beide müssen
 * bei Buchtyp-/Kontext-Wechsel invalidieren, weil diese Settings via
 * getLocalePromptsForBook (Block «VORRANGIGE ANGABEN DES AUTORS») in den
 * Extraktions-Prompt fliessen und das Ergebnis verändern.
 */
function bookSettingsSigPart(bookSettings) {
  const s = bookSettings || {};
  return `${s.language || ''}:${s.region || ''}:${s.buchtyp || ''}:${s.buch_kontext || ''}`;
}

/**
 * Signatur aller Seiten eines Buchs für den Single-Pass-Cache der Phase 1.
 * Berücksichtigt page_id, page-updated_at, chapter_id, chapter-Name sowie
 * buchtyp/buch_kontext/language – ändert sich eins davon, wird der Cache
 * invalidiert, weil die entsprechenden Prompts andere Ergebnisse liefern.
 * `cacheVersion` (model+prompts-Version) hängt zusätzlich an, damit Modell-
 * oder Schema-Änderungen alte Caches automatisch invalidieren.
 */
function buildBookPagesSig(pageContents, bookSettings, cacheVersion) {
  const pagesPart = pageContents
    .map(p => `${p.id}:${p.updated_at || ''}|${p.chapter_id ?? ''}:${p.chapter ?? ''}`)
    .sort()
    .join('|');
  return `${pagesPart}||${bookSettingsSigPart(bookSettings)}||${cacheVersion || ''}`;
}

/** Extrahiert das wörtliche Zitat aus einem stelle_a/stelle_b-String (in «»/""/„").
 *  Leer, wenn kein Zitat vorhanden. Geteilt von der Verify-Stufe (job.js) und der
 *  Beleg-Prüfung im Single-Pass-Save (remap.js). */
function _stelleQuote(stelle) {
  const m = String(stelle || '').match(/[«„"“]([^»"”]{3,})[»"”]/);
  return m ? m[1].trim() : '';
}

/** Misst Wall-Clock pro Pipeline-Segment. `mark(label)` loggt die Dauer seit dem
 *  letzten Mark sofort (Live-Fortschritt + Lokalisierung, falls ein Job in einer
 *  Phase hängt) und sammelt sie für `summary()` (eine konsolidierte Zeile am
 *  Job-Ende). Date.now() konsistent mit _jobDurationFmt; Sekunden-Auflösung reicht
 *  für die mehrsekündigen Phasen. Parallel laufende Phasen (P2+P3, P6+P8) erscheinen
 *  als ein Segment mit ihrer gemeinsamen Wall-Clock-Dauer. */
function makePhaseTimer(log) {
  const segments = [];
  let last = Date.now();
  return {
    mark(label) {
      const now = Date.now();
      const secs = (now - last) / 1000;
      last = now;
      segments.push(`${label}=${secs.toFixed(1)}s`);
      log.info(`Phase «${label}» – ${secs.toFixed(1)}s`);
    },
    summary() { return segments.join(' '); },
  };
}

/** Führt eine nicht-kritische Phase aus – Fehler werden geloggt, nicht geworfen.
 *  Optionaler `warnings`-Sink + `warnKey`: bei Fehlschlag wird `{ key: warnKey }`
 *  gesammelt, damit die Degradierung im Job-Result user-sichtbar wird. */
async function runNonCritical(label, fn, log, { warnings = null, warnKey = null } = {}) {
  try {
    return await fn();
  } catch (e) {
    log.warn(`${label} fehlgeschlagen (ignoriert): ${e.message}`);
    if (warnings && warnKey) warnings.push({ key: warnKey });
    return null;
  }
}

/**
 * Baut Name→ID Lookup-Maps für konsolidierte Figuren.
 * Enthält kanonischen Namen, Kurznamen und Token-Fallback für Phase-1-Namen.
 * Wenn das Modell in Phase 1 einen anderen Namen verwendet als Phase 2
 * (z.B. nur Nachname, Titel+Name), wird per Token-Matching die eindeutig
 * passende Phase-2-Figur gesucht. Nur bei eindeutigem Match.
 */
function buildFigNameLookup(figuren, chapterFiguren, chapterAssignments, chapterSzenen, log, jobId, aliasMap = null) {
  const nameToId = {};
  for (const f of figuren) {
    nameToId[f.name] = f.id;
    if (f.kurzname && f.kurzname !== f.name) nameToId[f.kurzname] = f.id;
  }
  const nameToIdLower = Object.fromEntries(
    Object.entries(nameToId).map(([k, v]) => [k.toLowerCase(), v])
  );
  // Alias-Cluster (F3): Namen, die auf einen kanonischen Namen vereinheitlicht wurden, weiter
  // auflösbar halten — sonst droppt eine Szene/Event, die noch den Alias-Namen trägt, im Remap.
  if (aliasMap) {
    for (const [aliasLower, canon] of Object.entries(aliasMap)) {
      const id = nameToId[canon] || nameToIdLower[String(canon).toLowerCase()];
      if (id && !nameToIdLower[aliasLower]) nameToIdLower[aliasLower] = id;
    }
  }

  function tryTokenFallback(name) {
    // KI liefert figur_name gelegentlich als Objekt statt String. Call-Sites
    // normalisieren via _refToString; dieser Guard macht den Helper zusätzlich
    // aufrufer-unabhängig robust (sonst würde name.toLowerCase() auf einem Objekt werfen
    // und den gesamten Job nach bereits gespeichertem Katalog killen).
    if (typeof name !== 'string') return;
    if (!name || nameToId[name] || nameToIdLower[name.toLowerCase()]) return;
    const tokens = new Set(name.toLowerCase().split(/[\s\-\.]+/).filter(t => t.length > 2));
    if (!tokens.size) return;
    const seen = new Set();
    const matches = [];
    for (const [canon, fid] of Object.entries(nameToId)) {
      if (seen.has(fid)) continue;
      const overlap = canon.toLowerCase().split(/[\s\-\.]+/)
        .filter(t => t.length > 2 && tokens.has(t)).length;
      if (overlap > 0) { seen.add(fid); matches.push(fid); }
    }
    if (matches.length === 1) {
      nameToId[name] = matches[0];
      nameToIdLower[name.toLowerCase()] = matches[0];
      log.info(`Phase-1-Name «${name}» → ${matches[0]} (Token-Fallback)`);
    }
  }

  for (const { figuren: chFigs } of (chapterFiguren || []))
    for (const f1 of (chFigs || [])) tryTokenFallback(f1.name);
  for (const { assignments: chAss } of (chapterAssignments || []))
    for (const a of (chAss || [])) tryTokenFallback(_refToString(a?.figur_name));
  // Szenen-Namen ebenfalls einbeziehen: eine Szenenfigur «Gerold», die nur als
  // Teilname zu «Gerold Brunner» existiert, soll im Remap auflösen statt droppen.
  for (const { szenen: chSz } of (chapterSzenen || []))
    for (const s of (chSz || []))
      for (const n of (s?.figuren_namen || [])) tryTokenFallback(_refToString(n));

  return { figNameToId: nameToId, figNameToIdLower: nameToIdLower };
}

/** Coverage-Self-Audit (F2): wählt bis zu `n` gleichmässig über das Buch verteilte,
 *  nicht-leere Kapitel als Stichprobe und baut je Kapitel den Prüftext (auf
 *  `maxCharsPerChapter` gedeckelt — die Stichprobe misst Recall, nicht Vollextraktion).
 *  Deterministisch (kein Zufall) → reproduzierbar. Pure, testbar. */
function sampleChapters(groups, groupOrder, n, maxCharsPerChapter = 40000) {
  if (!groups || !groupOrder || n <= 0) return [];
  const nonEmpty = groupOrder.filter(k => {
    const g = groups.get(k);
    return g && (g.pages || []).some(p => (p.text || '').trim());
  });
  if (!nonEmpty.length) return [];
  const count = Math.min(n, nonEmpty.length);
  const idxs = new Set();
  for (let i = 0; i < count; i++) {
    idxs.add(Math.min(nonEmpty.length - 1, Math.floor((i + 0.5) * nonEmpty.length / count)));
  }
  return [...idxs].map(i => {
    const g = groups.get(nonEmpty[i]);
    let chText = (g.pages || []).map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n');
    if (chText.length > maxCharsPerChapter) chText = chText.slice(0, maxCharsPerChapter);
    return { name: g.name, chText };
  });
}

/** Coverage-Self-Audit (F2): aggregiert die Per-Stichprobe-Ergebnisse zu einem Recall-Score
 *  = erkannte / (erkannte + fehlende). null, wenn die Stichprobe keine Entitäten enthielt.
 *  Pure, testbar. */
function computeCoverageScore(samples) {
  let erkannt = 0, fehlend = 0;
  const missFig = [], missOrt = [];
  for (const s of (samples || [])) {
    erkannt += (Number(s?.erkannte_figuren) || 0) + (Number(s?.erkannte_orte) || 0);
    const mf = (s?.fehlende_figuren || []).filter(Boolean);
    const mo = (s?.fehlende_orte || []).filter(Boolean);
    fehlend += mf.length + mo.length;
    missFig.push(...mf); missOrt.push(...mo);
  }
  const denom = erkannt + fehlend;
  return {
    score: denom > 0 ? Math.round((erkannt / denom) * 100) / 100 : null,
    erkannt, fehlend,
    missingFiguren: [...new Set(missFig)].slice(0, 20),
    missingOrte: [...new Set(missOrt)].slice(0, 20),
  };
}

/** Konsolidierungs-Checkpoint (F5): deterministische Signatur des assemblierten Phase-1-
 *  Katalogs + der konsolidierungs-relevanten Parameter. Ist sie unverändert, kann P2–P8
 *  (die teuren Konsolidierungs-/Urteil-Calls) übersprungen werden — der DB-Katalog ist dann
 *  bereits korrekt. `flags` enthält alles, was das Konsolidierungs-/Kontinuitäts-ERGEBNIS
 *  beeinflusst, aber NICHT in der Extraktion (cacheVersion) steckt (Konsolidierungs-Modell,
 *  Alias-/Attribut-Check-Toggles). JSON.stringify(chapters) ist bei Cache-HITs byte-stabil
 *  (genau der Fall, in dem das Short-Circuit greifen soll). Pure, testbar. */
function buildConsolidationSig(chapters, cacheVersion, flags = {}) {
  return crypto.createHash('sha256')
    .update(String(cacheVersion || ''))
    .update('|flags:' + JSON.stringify(flags))
    .update('|catalog:' + JSON.stringify(chapters || {}))
    .digest('hex');
}

module.exports = {
  _refToString, _remapFigNames, extractField, consolidationFitsCap,
  buildBookSystemBlockText, buildBookPagesSig, bookSettingsSigPart,
  _stelleQuote,
  makePhaseTimer,
  runNonCritical, buildFigNameLookup,
  sampleChapters, computeCoverageScore, buildConsolidationSig,
};
