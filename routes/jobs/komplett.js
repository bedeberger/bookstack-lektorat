'use strict';
const express = require('express');
const logger = require('../../logger');
const {
  db,
  saveFigurenToDb, addFigurenBeziehungen, updateFigurenEvents, updateFigurenSoziogramm,
  saveZeitstrahlEvents, saveOrteToDb, backfillLocationChaptersFromScenes,
  saveCheckpoint, loadCheckpoint, deleteCheckpoint,
  loadChapterExtractCache, saveChapterExtractCache, deleteChapterExtractCache,
  getAllUserTokens, getBookSettings, getTokenForRequest,
  saveContinuityCheck, getLatestContinuityCheck,
} = require('../../db/schema');
const { narrativeLabels } = require('./narrative-labels');
const { recomputeBookFigureMentions } = require('../../lib/page-index');
const { toIntId } = require('../../lib/validate');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  aiCall, getPrompts, getBookPrompts,
  loadPageContents, groupByChapter, buildSinglePassBookText, splitGroupsIntoChunks, cleanPageTextForClaude,
  bsGetAll, SINGLE_PASS_LIMIT, PER_CHUNK_LIMIT, BATCH_SIZE, jobAbortControllers,
  _modelName, fmtTok, tps, settledAll,
  jobs, runningJobs, createJob, enqueueJob, jobKey, findActiveJobId,
  jsonBody,
} = require('./shared');

const komplettRouter = express.Router();

// ── Hilfsfunktionen ──────────────────────────────────────────────────────────

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

/** Extrahiert ein Feld aus settledAll-Ergebnissen in das Kapitel-Array-Format. */
function extractField(settled, chunkTexts, field) {
  return settled.map((r, i) => ({
    kapitel: chunkTexts[i].chunk.name,
    [field]: r.status === 'fulfilled' ? (r.value?.[field] || []) : [],
  }));
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
  const s = bookSettings || {};
  const settingsPart = `${s.language || ''}:${s.region || ''}:${s.buchtyp || ''}:${s.buch_kontext || ''}`;
  return `${pagesPart}||${settingsPart}||${cacheVersion || ''}`;
}

/** Führt eine nicht-kritische Phase aus – Fehler werden geloggt, nicht geworfen. */
async function runNonCritical(label, fn, log, jobId) {
  try {
    return await fn();
  } catch (e) {
    log.warn(`Job ${jobId}: ${label} fehlgeschlagen (ignoriert): ${e.message}`);
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
function buildFigNameLookup(figuren, chapterFiguren, chapterAssignments, log, jobId) {
  const nameToId = {};
  for (const f of figuren) {
    nameToId[f.name] = f.id;
    if (f.kurzname && f.kurzname !== f.name) nameToId[f.kurzname] = f.id;
  }
  const nameToIdLower = Object.fromEntries(
    Object.entries(nameToId).map(([k, v]) => [k.toLowerCase(), v])
  );

  function tryTokenFallback(name) {
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
      log.info(`Job ${jobId}: Phase-1-Name «${name}» → ${matches[0]} (Token-Fallback)`);
    }
  }

  for (const { figuren: chFigs } of (chapterFiguren || []))
    for (const f1 of (chFigs || [])) tryTokenFallback(f1.name);
  for (const { assignments: chAss } of (chapterAssignments || []))
    for (const a of (chAss || [])) tryTokenFallback(a?.figur_name);

  return { figNameToId: nameToId, figNameToIdLower: nameToIdLower };
}

/** Mergt duplizierte Figuren anhand des normalisierten Namens (case-insensitive).
 *  Fängt Fälle ab, in denen kleine Modelle (Ollama/llama) die Dedup-Regel in
 *  Phase 2 nicht befolgen. Verschmilzt Kapitel, Eigenschaften und Beziehungen.
 *  Remappt beziehungen.figur_id auf die kanonische ID und entfernt Selbst-Referenzen.
 *  Zweistufig:
 *    Stufe 1: exakter normalisierter Name (titel-/whitespace-bereinigt).
 *    Stufe 2: Teilname-Match (ein Name ist Teilmenge des anderen) plus mind. 2 Indizien
 *             (Beruf, Geburtsjahr, gemeinsames Kapitel, gleiches Geschlecht, geteilte Beziehung).
 *             Strenger Schutz: verschiedene Vornamen mit gleichem Nachnamen («Paul Schmidt»
 *             vs. «Marta Schmidt») werden NICHT zusammengeführt. */
const TITLE_PREFIX_RE = /^(?:dr\.?|doktor|prof\.?|professor|herrn?|hr\.?|frau|fr\.?|fräulein)\s+/;
const NAME_STOPWORDS = new Set(['von', 'zu', 'van', 'der', 'die', 'das', 'den', 'dem', 'de', 'la']);

function _normalizeName(s) {
  let r = (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
  while (TITLE_PREFIX_RE.test(r)) r = r.replace(TITLE_PREFIX_RE, '');
  return r;
}
function _nameTokens(name) {
  return _normalizeName(name)
    .split(/[\s\-\.]+/)
    .filter(t => t.length > 1 && !NAME_STOPWORDS.has(t));
}

/** Fasst zwei Figuren zu einer kanonischen Figur zusammen. `canon` wird mutiert.
 *  Gibt nichts zurück – Caller kümmert sich um idRemap. */
function _mergeFigurInto(canon, other) {
  for (const field of ['kurzname', 'typ', 'geburtstag', 'geschlecht', 'beruf', 'wohnadresse', 'sozialschicht',
                       'rolle', 'motivation', 'konflikt', 'entwicklung', 'erste_erwaehnung', 'praesenz']) {
    if (!canon[field] && other[field]) canon[field] = other[field];
  }
  // Beschreibung: die längere gewinnt (bereits durch Sortierung gewährleistet, sonst hier fallback).
  if (!canon.beschreibung && other.beschreibung) canon.beschreibung = other.beschreibung;
  // Schlüsselzitate: zusammenführen, dedupliziert, max 3
  const zit = new Set([...(canon.schluesselzitate || []), ...(other.schluesselzitate || [])]);
  canon.schluesselzitate = [...zit].slice(0, 3);
  // Kapitel: per Name aufsummieren
  const kapByName = new Map();
  for (const k of (canon.kapitel || [])) kapByName.set(k.name, k.haeufigkeit || 1);
  for (const k of (other.kapitel || [])) {
    kapByName.set(k.name, (kapByName.get(k.name) || 0) + (k.haeufigkeit || 1));
  }
  canon.kapitel = [...kapByName.entries()].map(([name, haeufigkeit]) => ({ name, haeufigkeit }));
  const eigSet = new Set([...(canon.eigenschaften || []), ...(other.eigenschaften || [])]);
  canon.eigenschaften = [...eigSet];
  const bzByFig = new Map();
  for (const b of (canon.beziehungen || [])) bzByFig.set(b.figur_id, b);
  for (const b of (other.beziehungen || [])) if (!bzByFig.has(b.figur_id)) bzByFig.set(b.figur_id, b);
  canon.beziehungen = [...bzByFig.values()];
}

/** Zählt Indizienpunkte für zwei Figuren (Nachnamen-Match-Check). Siehe Kommentar oben. */
function _indicatorScore(a, b) {
  let score = 0;
  // Beruf-Match (ignoriere leere / generische Werte)
  const ba = (a.beruf || '').toLowerCase().trim();
  const bb = (b.beruf || '').toLowerCase().trim();
  if (ba && bb && ba === bb) score += 1;
  // Geburtsjahr: stark
  if (a.geburtstag && b.geburtstag && a.geburtstag === b.geburtstag) score += 2;
  // Gemeinsames Kapitel
  const kapA = new Set((a.kapitel || []).map(k => k.name));
  for (const k of (b.kapitel || [])) if (kapA.has(k.name)) { score += 1; break; }
  // Geschlecht (nur wenn beide bekannt und gleich)
  const ga = (a.geschlecht || '').toLowerCase();
  const gb = (b.geschlecht || '').toLowerCase();
  if (ga && gb && ga !== 'unbekannt' && gb !== 'unbekannt' && ga === gb) score += 1;
  // Typ (schwach)
  if (a.typ && b.typ && a.typ === b.typ && a.typ !== 'andere') score += 1;
  // Geteilte Beziehung (sehr stark)
  const relA = new Set((a.beziehungen || []).map(x => x.figur_id));
  for (const bz of (b.beziehungen || [])) if (relA.has(bz.figur_id)) { score += 2; break; }
  return score;
}

/** Stufe 2: Teilnamens-Fusion. Nur wenn ein Name Teilmenge des anderen ist
 *  (nach Token-Normalisierung). Verschiedene Vornamen mit gleichem Nachnamen
 *  → disjunkte Tokens → keine Fusion. */
function _mergeByPartialName(figuren, idRemap) {
  const tokens = figuren.map(f => _nameTokens(f.name));
  const merged = [];
  const consumed = new Set();
  for (let i = 0; i < figuren.length; i++) {
    if (consumed.has(i)) continue;
    const canon = { ...figuren[i] };
    let fused = 0;
    for (let j = i + 1; j < figuren.length; j++) {
      if (consumed.has(j)) continue;
      const ta = tokens[i], tb = tokens[j];
      if (!ta.length || !tb.length) continue;
      // Subset-Check: eine Seite komplett in der anderen enthalten?
      const aInB = ta.every(t => tb.includes(t));
      const bInA = tb.every(t => ta.includes(t));
      if (!aInB && !bInA) continue;
      // Indizien
      if (_indicatorScore(canon, figuren[j]) < 2) continue;
      idRemap[figuren[j].id] = canon.id;
      _mergeFigurInto(canon, figuren[j]);
      consumed.add(j);
      fused++;
    }
    if (fused > 0) canon.__fusedInStage2 = fused;
    merged.push(canon);
  }
  return merged;
}

/** Rollierender Dedup VOR Phase 2: geht chapterFiguren in Reihenfolge durch,
 *  baut eine kanonische Map (normalisierter Name → Figur) auf und entfernt
 *  Duplikate aus folgenden Kapiteln. Kapitel-Einträge werden aggregiert,
 *  Eigenschaften verschmolzen. Beziehungen bleiben kapitel-lokal (werden erst
 *  von Phase 2 konsolidiert) – wir würden sonst die lokalen fig_id-Referenzen
 *  brechen. Reduziert die Eingabegrösse für den Phase-2-Konsolidierungs-Call
 *  und fängt Fälle ab in denen Phase 2 trotz Hinweis Duplikate stehen lässt. */
function preMergeChapterFiguren(chapterFiguren) {
  const canonical = new Map(); // normalizedName → Figur (Referenz in einem der merged[i].figuren)
  const canonicalList = [];    // [{ normKey, figur }] für Fuzzy-Scan
  const merged = chapterFiguren.map(c => ({ kapitel: c.kapitel, figuren: [] }));
  let dupesRemoved = 0;

  for (let ci = 0; ci < chapterFiguren.length; ci++) {
    for (const f of (chapterFiguren[ci].figuren || [])) {
      const key = _normalizeName(f.name);
      if (!key) continue;
      let canon = canonical.get(key);

      // Fuzzy: Teilname + ≥2 Indizien (gleicher Beruf, Kapitel, Geburtsjahr, Typ, Geschlecht, Beziehung)
      if (!canon) {
        const tokA = _nameTokens(f.name);
        if (tokA.length) {
          for (const entry of canonicalList) {
            const tokB = _nameTokens(entry.figur.name);
            if (!tokB.length) continue;
            const aInB = tokA.every(t => tokB.includes(t));
            const bInA = tokB.every(t => tokA.includes(t));
            if (!aInB && !bInA) continue;
            if (_indicatorScore(entry.figur, f) >= 2) { canon = entry.figur; break; }
          }
        }
      }

      if (canon) {
        // Merge: kapitel, eigenschaften, leere Kernfelder; Beziehungen NICHT mergen (lokale fig_ids).
        // Rollierender Dedup ist Pre-Processing – die Phase-2-KI bekommt trotzdem die
        // Original-Beziehungen pro Kapitel und löst die Referenzen dort auf.
        for (const field of ['kurzname', 'typ', 'geburtstag', 'geschlecht', 'beruf', 'wohnadresse', 'sozialschicht',
                             'rolle', 'motivation', 'konflikt', 'entwicklung', 'erste_erwaehnung', 'praesenz',
                             'beschreibung']) {
          if (!canon[field] && f[field]) canon[field] = f[field];
        }
        const zit = new Set([...(canon.schluesselzitate || []), ...(f.schluesselzitate || [])]);
        canon.schluesselzitate = [...zit].slice(0, 3);
        const eig = new Set([...(canon.eigenschaften || []), ...(f.eigenschaften || [])]);
        canon.eigenschaften = [...eig];
        const kapByName = new Map();
        for (const k of (canon.kapitel || [])) kapByName.set(k.name, k.haeufigkeit || 1);
        for (const k of (f.kapitel || [])) {
          kapByName.set(k.name, (kapByName.get(k.name) || 0) + (k.haeufigkeit || 1));
        }
        canon.kapitel = [...kapByName.entries()].map(([name, haeufigkeit]) => ({ name, haeufigkeit }));
        dupesRemoved++;
      } else {
        merged[ci].figuren.push(f);
        canonical.set(key, f);
        canonicalList.push({ normKey: key, figur: f });
      }
    }
  }

  return { chapterFiguren: merged, dupesRemoved };
}

/** Welle 4 · #12 – Mode-Vote für Sozialschicht (lokale Modelle).
 *  Phase 2 (Konsolidierung) bei kleinen Modellen wählt die sozialschicht
 *  manchmal aus einem Nebenkapitel, obwohl drei andere Kapitel einheitlich
 *  anders votiert haben. Hier korrigieren wir per Mehrheitsabstimmung über
 *  die Phase-1-Rohdaten (nach rollierendem Pre-Merge normalisiert per Name).
 *  Claude läuft durch den holistischen Refine-Call und braucht das nicht. */
function applySozialschichtModeVote(chapterFiguren, figuren) {
  const votes = new Map();
  for (const c of (chapterFiguren || [])) {
    for (const f of (c.figuren || [])) {
      if (!f?.name || !f?.sozialschicht) continue;
      const key = _normalizeName(f.name);
      if (!votes.has(key)) votes.set(key, {});
      votes.get(key)[f.sozialschicht] = (votes.get(key)[f.sozialschicht] || 0) + 1;
    }
  }
  let changes = 0;
  for (const f of figuren) {
    const v = votes.get(_normalizeName(f.name));
    if (!v) continue;
    const entries = Object.entries(v);
    if (entries.length < 2) continue;
    entries.sort((a, b) => b[1] - a[1]);
    // Mehrheit nur anwenden wenn sie eindeutig (nicht Gleichstand) und abweicht
    if (entries[0][1] === entries[1][1]) continue;
    const mode = entries[0][0];
    if (mode && mode !== f.sozialschicht) {
      f.sozialschicht = mode;
      changes++;
    }
  }
  return changes;
}

function mergeDuplicateFiguren(figuren) {
  const groups = new Map();
  for (const f of figuren) {
    const key = _normalizeName(f.name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }

  const idRemap = {};
  let stage1 = [];
  for (const group of groups.values()) {
    if (group.length === 1) { stage1.push(group[0]); continue; }
    group.sort((a, b) => (b.beschreibung?.length || 0) - (a.beschreibung?.length || 0));
    const canon = { ...group[0] };
    for (const other of group.slice(1)) {
      idRemap[other.id] = canon.id;
      _mergeFigurInto(canon, other);
    }
    stage1.push(canon);
  }
  const stage1Saved = figuren.length - stage1.length;

  // Stufe 2: Teilnamens-Fusion mit Indizien-Check (konservativ)
  const stage2 = _mergeByPartialName(stage1, idRemap);
  const stage2Saved = stage1.length - stage2.length;

  const validIds = new Set(stage2.map(f => f.id));
  for (const f of stage2) {
    const seen = new Map();
    for (const b of (f.beziehungen || [])) {
      const mappedId = idRemap[b.figur_id] || b.figur_id;
      if (mappedId === f.id || !validIds.has(mappedId)) continue;
      if (!seen.has(mappedId)) seen.set(mappedId, { ...b, figur_id: mappedId });
    }
    f.beziehungen = [...seen.values()];
    delete f.__fusedInStage2;
  }

  return { figuren: stage2, mergedCount: stage1Saved + stage2Saved, stage1Saved, stage2Saved, idRemap };
}

/** Sanity-Check + Rettung für Beziehungs-Beschreibungen (nur Lokal-KI).
 *  Lokale Modelle verrutschen oft Beschreibungen zwischen Beziehungen (z.B.
 *  «Sebastian ist Roberts Freund» auf der Relation Robert→Herr Koch).
 *  Zweistufig:
 *    1. Wenn die Beschreibung genau eine andere Figur des Buchs erwähnt und
 *       diese Figur eine bestehende beziehung (des gleichen Besitzers) ohne
 *       Beschreibung hat: Beschreibung dorthin verschieben.
 *    2. Sonst: Beschreibung leeren (typ + Paar bleiben erhalten).
 *  Gibt { cleared, moved } zurück. */
function validateBeziehungenDescriptions(figuren) {
  const idToNames = Object.fromEntries(
    figuren.map(f => [f.id, [f.name, f.kurzname].filter(Boolean).map(s => s.toLowerCase())])
  );
  const allNames = figuren.map(f => ({
    id: f.id,
    names: [f.name, f.kurzname].filter(Boolean).map(s => s.toLowerCase()),
  }));
  let cleared = 0, moved = 0;
  for (const f of figuren) {
    for (const bz of (f.beziehungen || [])) {
      if (!bz.beschreibung) continue;
      const currentNames = idToNames[bz.figur_id] || [];
      if (!currentNames.length) continue;
      const text = bz.beschreibung.toLowerCase();
      if (currentNames.some(n => text.includes(n))) continue; // passt – weitermachen

      // Rettung: finde andere Figur, die eindeutig in der Beschreibung erwähnt wird
      const candidates = allNames.filter(c =>
        c.id !== f.id && c.id !== bz.figur_id && c.names.some(n => text.includes(n))
      );
      if (candidates.length === 1) {
        const target = candidates[0];
        // Umhängen nur wenn: Relation (f → target) existiert und dort keine Beschreibung
        // Oder: gar keine Relation (f → target) existiert → dann neue Beziehung anlegen (typ bleibt)
        const existing = (f.beziehungen || []).find(x => x.figur_id === target.id);
        if (existing) {
          if (!existing.beschreibung) {
            existing.beschreibung = bz.beschreibung;
            bz.beschreibung = null;
            moved++;
            continue;
          }
          // Ziel-Beschreibung belegt → nicht überschreiben; clear
        } else {
          // Keine bestehende Beziehung zum Kandidaten → neue Beziehung mit dem aktuellen typ anlegen
          (f.beziehungen || []).push({ figur_id: target.id, typ: bz.typ, beschreibung: bz.beschreibung,
            ...(bz.machtverhaltnis != null ? { machtverhaltnis: bz.machtverhaltnis } : {}) });
          bz.beschreibung = null;
          moved++;
          continue;
        }
      }
      bz.beschreibung = null;
      cleared++;
    }
  }
  return { cleared, moved };
}

/** Mappt Szenen-Klarnamen (aus Phase 1) auf konsolidierte Figuren-/Ort-IDs. */
function remapSzenen(chSzenen, figNameToId, figNameToIdLower, ortNameToId, ortNameToIdLower, chNameToId) {
  const szenen = [];
  for (const { kapitel, szenen: chSz } of (chSzenen || [])) {
    for (const s of (chSz || [])) {
      // Wie bei `seite` kann die KI auch beim Kapitel den ##-Präfix mitliefern.
      const rawKapitel = (s.kapitel || '').replace(/^#{1,6}\s+/, '').trim();
      const effKapitel = (rawKapitel && chNameToId[rawKapitel] != null) ? rawKapitel : kapitel;
      // LLM-Halluzination 1: Markdown-Header-Präfix («### Seitentitel» statt
      // «Seitentitel») – wortwörtlich aus der User-Message kopiert.
      // LLM-Halluzination 2: Kapitelname als Seitentitel zurückgegeben, weil der
      // echte Titel nicht erkannt wurde. Oder chMap-Fallback «Sonstige Seiten».
      // In beiden Fällen `seite` nullen / strippen, damit der page_id-Lookup
      // unten trifft.
      let effSeite = (s.seite || '').replace(/^#{1,6}\s+/, '').trim() || null;
      if (effSeite && (effSeite === effKapitel || effSeite === 'Sonstige Seiten')) {
        effSeite = null;
      }
      szenen.push({
        kapitel: effKapitel,
        seite: effSeite,
        titel: s.titel || '(unbekannt)',
        wertung: s.wertung || null,
        kommentar: s.kommentar || null,
        fig_ids: (s.figuren_namen || []).map(n => {
          const name = _refToString(n);
          return name ? (figNameToId[name] || figNameToIdLower[name.toLowerCase()] || null) : null;
        }).filter(Boolean),
        ort_ids: (s.orte_namen || []).map(n => {
          const name = _refToString(n);
          return name ? (ortNameToId[name] || ortNameToIdLower[name.toLowerCase()] || null) : null;
        }).filter(Boolean),
        sort_order: szenen.length,
      });
    }
  }
  return szenen;
}

/** Mappt Assignments auf konsolidierte Figuren-IDs, dedupliziert und sortiert. */
function remapAssignments(chAssignments, figNameToId, figNameToIdLower, chNameToId, log, jobId) {
  const mergedEvtMap = new Map();
  let dropped = 0;

  for (const { kapitel, assignments: chAss } of (chAssignments || [])) {
    for (const assignment of (chAss || [])) {
      const figId = figNameToId[assignment.figur_name]
        || figNameToIdLower[assignment.figur_name?.toLowerCase()] || null;
      if (!figId) {
        dropped++;
        log.warn(`Job ${jobId}: Assignment «${assignment.figur_name}» (${assignment.lebensereignisse?.length || 0} Ereignisse) – keine Figuren-ID.`);
        continue;
      }
      if (!mergedEvtMap.has(figId)) mergedEvtMap.set(figId, []);
      for (const ev of (assignment.lebensereignisse || [])) {
        const evKap = (ev.kapitel || '').replace(/^#{1,6}\s+/, '').trim();
        const evSeite = (ev.seite || '').replace(/^#{1,6}\s+/, '').trim();
        mergedEvtMap.get(figId).push({
          ...ev,
          kapitel: (evKap && chNameToId[evKap] != null) ? evKap : kapitel,
          seite: evSeite || null,
        });
      }
    }
  }
  if (dropped > 0) log.warn(`Job ${jobId}: ${dropped} Assignments ohne Figuren-ID ignoriert.`);

  const allAssignments = [];
  for (const [fig_id, events] of mergedEvtMap) {
    const seen = new Set();
    const deduped = [];
    for (const ev of events) {
      const key = (ev.datum || '') + '||' + (ev.ereignis || '').trim().toLowerCase();
      if (!seen.has(key)) { seen.add(key); deduped.push(ev); }
    }
    deduped.sort((a, b) => (parseInt(a.datum) || 0) - (parseInt(b.datum) || 0));
    allAssignments.push({ fig_id, lebensereignisse: deduped });
  }
  return allAssignments;
}

/** Speichert Szenen und Figuren-Events in die DB. Gibt { szenenCount, eventsCount } zurück. */
function saveSzenenAndEvents(bookIdInt, email, szenen, assignments, locIdToDbId, idMaps, log, jobId) {
  db.transaction(() => {
    db.prepare('DELETE FROM figure_scenes WHERE book_id = ? AND user_email = ?').run(bookIdInt, email);
    const now = new Date().toISOString();
    const ins = db.prepare(`INSERT INTO figure_scenes
      (book_id, user_email, titel, wertung, kommentar, chapter_id, page_id, sort_order, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    // scene_figures.figure_id ist INTEGER (figures.id) seit Mig 73 — Lookup TEXT → INT.
    const figRows = db.prepare(
      'SELECT id, fig_id FROM figures WHERE book_id = ? AND user_email IS ?'
    ).all(bookIdInt, email);
    const figIdToRowId = Object.fromEntries(figRows.map(r => [r.fig_id, r.id]));
    const insSf = db.prepare('INSERT OR IGNORE INTO scene_figures (scene_id, figure_id) VALUES (?, ?)');
    const insSl = db.prepare('INSERT OR IGNORE INTO scene_locations (scene_id, location_id) VALUES (?, ?)');
    for (const s of szenen) {
      const chapterId = idMaps.chNameToId[s.kapitel] ?? null;
      const pageId = s.seite
        ? (idMaps.pageNameToIdByChapter[chapterId ?? 0]?.[s.seite] ?? null)
        : null;
      const { lastInsertRowid: sceneId } = ins.run(
        bookIdInt, email,
        s.titel, s.wertung, s.kommentar,
        chapterId, pageId,
        s.sort_order, now,
      );
      for (const fid of s.fig_ids) {
        const rowId = figIdToRowId[fid];
        if (rowId != null) insSf.run(sceneId, rowId);
      }
      for (const locIdStr of s.ort_ids) {
        const dbLocId = locIdToDbId[locIdStr];
        if (dbLocId) insSl.run(sceneId, dbLocId);
      }
    }
  })();

  const eventsCount = assignments.reduce((s, a) => s + (a.lebensereignisse?.length || 0), 0);
  if (eventsCount > 0) {
    saveZeitstrahlEvents(bookIdInt, email, []);
    updateFigurenEvents(bookIdInt, assignments, email, idMaps);
  }
  log.info(`Job ${jobId}: ${szenen.length} Szenen, ${eventsCount} Ereignisse gespeichert.`);
  return { szenenCount: szenen.length, eventsCount };
}

/** Speichert Kontinuitätsprüfung in die DB (eine Zeile pro Issue + Bridge-Tabellen
 *  für Figuren-/Kapitel-Referenzen). Gibt normalizedIssues zurück, oder null bei
 *  ungültiger Antwort. */
function saveKontinuitaetResult(bookIdInt, email, kontResult, figNameToId, chNameToId, effectiveProvider, log, jobId) {
  if (typeof kontResult?.zusammenfassung === 'undefined') return null;
  const issues = (kontResult.probleme || []).map(p => ({
    schwere: p.schwere, typ: p.typ, beschreibung: p.beschreibung,
    stelle_a: p.stelle_a, stelle_b: p.stelle_b, empfehlung: p.empfehlung,
    figuren: (p.figuren || []).map(_refToString).filter(Boolean),
    kapitel: (p.kapitel || []).map(_refToString).filter(Boolean),
  }));
  const { normalizedIssues } = saveContinuityCheck(
    bookIdInt, email, kontResult.zusammenfassung || '',
    _modelName(effectiveProvider), issues, figNameToId, chNameToId,
  );
  log.info(`Job ${jobId}: Kontinuitätsprüfung gespeichert (${normalizedIssues.length} Probleme).`);
  return normalizedIssues;
}

/** Invalidiert Delta-Cache-Einträge für umbenannte Kapitel. */
function invalidateRenamedChapterCaches(bookIdInt, chaptersData, log, jobId) {
  const stored = db.prepare('SELECT chapter_id, chapter_name FROM chapters WHERE book_id = ?').all(bookIdInt);
  const storedChMap = Object.fromEntries(stored.map(r => [r.chapter_id, r.chapter_name]));
  const delCacheByKey = db.prepare('DELETE FROM chapter_extract_cache WHERE book_id = ? AND chapter_key = ?');
  for (const c of chaptersData) {
    if (storedChMap[c.id] !== undefined && storedChMap[c.id] !== c.name) {
      log.info(`Job ${jobId}: Kapitel ${c.id} umbenannt («${storedChMap[c.id]}» → «${c.name}») – Cache invalidiert.`);
      delCacheByKey.run(bookIdInt, String(c.id));
    }
  }
}

/** Lädt und validiert einen Komplett-Analyse-Checkpoint. Gibt null zurück wenn ungültig. */
function loadAndValidateCheckpoint(bookIdInt, email, log, jobId) {
  let cp = loadCheckpoint('komplett-analyse', bookIdInt, email);
  if (!cp) return null;
  log.info(`Job ${jobId}: Checkpoint gefunden (Phase: ${cp.phase}).`);
  if (cp.phase !== 'p1_full_done') {
    log.info(`Job ${jobId}: Checkpoint Phase «${cp.phase}» ignoriert (altes Format) – Neustart.`);
    deleteCheckpoint('komplett-analyse', bookIdInt, email);
    return null;
  }
  const hasFiguren = Array.isArray(cp.chapterFiguren) && cp.chapterFiguren.length > 0
    && cp.chapterFiguren.some(c => Array.isArray(c.figuren) && c.figuren.length > 0);
  if (!hasFiguren) {
    log.warn(`Job ${jobId}: Checkpoint ohne Figuren-Daten – Neustart.`);
    deleteCheckpoint('komplett-analyse', bookIdInt, email);
    return null;
  }
  return cp;
}

/** Stellt Phase-1-Ergebnisse aus einem validen Checkpoint wieder her. */
function restorePhase1FromCheckpoint(cp, tok, log, jobId) {
  const { chapterFiguren, chapterOrte, chapterFakten, chapterSzenen, chapterAssignments } = cp;
  if (cp.tokIn != null) { tok.in = cp.tokIn; tok.out = cp.tokOut || 0; tok.ms = cp.tokMs || 0; }
  const figTotal = (chapterFiguren || []).reduce((s, c) => s + (c.figuren?.length || 0), 0);
  const orteTotal = (chapterOrte || []).reduce((s, c) => s + (c.orte?.length || 0), 0);
  const szTotal = (chapterSzenen || []).reduce((s, c) => s + (c.szenen?.length || 0), 0);
  log.info(`Job ${jobId}: Phase 1 aus Checkpoint – ${chapterFiguren.length} Kapitel, fig=${figTotal} orte=${orteTotal} sz=${szTotal} (${fmtTok(tok.in)}↑ ${fmtTok(tok.out)}↓)`);
  updateJob(jobId, { progress: 28, statusText: 'job.phase.checkpointLoaded', tokensIn: tok.in, tokensOut: tok.out });
  return { chapterFiguren, chapterOrte, chapterFakten, chapterSzenen, chapterAssignments };
}

// ── Phase-Funktionen ─────────────────────────────────────────────────────────

/**
 * Phase 1: Vollextraktion (Figuren+Orte+Fakten+Szenen+Events).
 * Single-Pass für kleine Bücher, Multi-Pass mit Delta-Cache für grosse.
 * Schema und Regeln im System-Prompt (SYSTEM_KOMPLETT_EXTRAKTION) → gecacht über alle Kapitel.
 * Szenen/Assignments verwenden Klarnamen statt IDs; Remapping nach P2/P3-Konsolidierung.
 */
async function runPhase1(ctx) {
  const { jobId, bookIdInt, bookName, email, call, tok, log,
    effectiveProvider, singlePassLimit, cacheVersion,
    prompts, sys, pageContents, groups, groupOrder, totalChars, fullBookText } = ctx;

  const perChunkLimit = effectiveProvider === 'claude' ? singlePassLimit : PER_CHUNK_LIMIT;
  const { chunkOrder, chunks } = splitGroupsIntoChunks(groups, groupOrder, perChunkLimit);

  log.info(`Job ${jobId}: Phase 1 – ${totalChars} Zeichen, ${effectiveProvider} → ${totalChars <= singlePassLimit ? 'Single-Pass' : `Multi-Pass (${groupOrder.length} Kapitel → ${chunkOrder.length} Chunks)`}`);

  let chapterFiguren, chapterOrte, chapterFakten, chapterSzenen, chapterAssignments;

  if (totalChars <= singlePassLimit) {
    // ── Single-Pass ──
    // Persistenter Cache: wenn Pages+Kapitelnamen unverändert, P1-Ergebnis wiederverwenden.
    // Key: chapter_key='__singlepass__' + Gesamt-Seitensignatur. Überlebt Job-Ende
    // (der Anthropic-Prompt-Cache deckt nur eine 1h-Fensterspanne ab).
    const bookPagesSig = buildBookPagesSig(pageContents, getBookSettings(bookIdInt, email), cacheVersion);
    const cached = loadChapterExtractCache(bookIdInt, email, '__singlepass__', bookPagesSig);
    if (cached && Array.isArray(cached.chapterFiguren) && cached.chapterFiguren[0]?.figuren?.length > 0) {
      chapterFiguren     = cached.chapterFiguren;
      chapterOrte        = cached.chapterOrte        || [{ kapitel: 'Gesamtbuch', orte: [] }];
      chapterFakten      = cached.chapterFakten      || [{ kapitel: 'Gesamtbuch', fakten: [] }];
      chapterSzenen      = cached.chapterSzenen      || [{ kapitel: 'Gesamtbuch', szenen: [] }];
      chapterAssignments = cached.chapterAssignments || [{ kapitel: 'Gesamtbuch', assignments: [] }];
      log.info(`Job ${jobId}: Phase 1 Single-Pass – Cache-HIT (pages_sig match) – spart den Extraktions-Call.`);
      updateJob(jobId, { progress: 28, statusText: 'job.phase.checkpointLoaded' });
    } else {
      updateJob(jobId, { progress: 12, statusText: 'job.phase.extracting' });
      // Ein kombinierter Call (Figuren+Orte+Fakten+Szenen+Assignments). Claude erhält den
      // Buchtext zusätzlich als eigenen cache_control-Block mit 1h-TTL, sodass Phase 8
      // Kontinuität denselben Prefix trifft und cache_read statt cache_write zahlt.
      // Früher: Claude teilte Single-Pass in zwei parallele Pässe (Figuren | Orte+Szenen).
      // Das halbierte zwar den Output pro Call, schrieb aber den Buchtext zweimal parallel
      // in den Cache (kein Dedup bei gleichzeitigen Requests) – doppelte Input-Kosten.
      let r;
      if (effectiveProvider === 'claude') {
        const bookSystemBlock = { text: buildBookSystemBlockText(bookName, pageContents.length, fullBookText), ttl: '1h' };
        r = await call(jobId, tok,
          prompts.buildExtraktionKomplettChapterPrompt('Gesamtbuch', bookName, pageContents.length, null),
          [bookSystemBlock, { text: sys.SYSTEM_KOMPLETT_EXTRAKTION }],
          12, 28, 22000, 0.2, null, prompts.SCHEMA_KOMPLETT_EXTRAKTION,
        );
      } else {
        r = await call(jobId, tok,
          prompts.buildExtraktionKomplettChapterPrompt('Gesamtbuch', bookName, pageContents.length, fullBookText),
          sys.SYSTEM_KOMPLETT_EXTRAKTION, 12, 28, 16000, 0.2, null, prompts.SCHEMA_KOMPLETT_EXTRAKTION,
        );
      }
      const passA = { figuren: r?.figuren, assignments: r?.assignments };
      const passB = { orte: r?.orte, fakten: r?.fakten, szenen: r?.szenen };
      chapterFiguren     = [{ kapitel: 'Gesamtbuch', figuren:     passA.figuren     || [] }];
      chapterOrte        = [{ kapitel: 'Gesamtbuch', orte:        passB.orte        || [] }];
      chapterFakten      = [{ kapitel: 'Gesamtbuch', fakten:      passB.fakten      || [] }];
      chapterSzenen      = [{ kapitel: 'Gesamtbuch', szenen:      passB.szenen      || [] }];
      chapterAssignments = [{ kapitel: 'Gesamtbuch', assignments: passA.assignments || [] }];
      const totalEvents = (passA.assignments || []).reduce((s, a) => s + (a.lebensereignisse?.length || 0), 0);
      log.info(`Job ${jobId}: Single-Pass OK – fig=${chapterFiguren[0].figuren.length} orte=${chapterOrte[0].orte.length} sz=${chapterSzenen[0].szenen.length} (${totalEvents} Ereignisse)`);
      saveChapterExtractCache(bookIdInt, email, '__singlepass__', bookPagesSig, {
        chapterFiguren, chapterOrte, chapterFakten, chapterSzenen, chapterAssignments,
      });
    }
  } else {
    // ── Multi-Pass mit Delta-Cache ──
    // Für lokale Modelle: Kapitel die PER_CHUNK_LIMIT überschreiten, werden in Seiten-Untergruppen
    // aufgeteilt. Jeder Chunk bekommt einen eigenen KI-Call mit eigenem Delta-Cache-Eintrag.
    // Claude nutzt singlePassLimit (250K) als Chunk-Grenze → kein Splitting in der Praxis.
    updateJob(jobId, { progress: 12, statusText: 'job.phase.extractingChunks', statusParams: { n: chunkOrder.length } });
    const chunkTexts = chunkOrder.map(chunkKey => {
      const chunk = chunks.get(chunkKey);
      return {
        chunk, key: chunkKey,
        pagesSig: chunk.pages.map(p => `${p.id}:${p.updated_at}`).sort().join('|') + `||${cacheVersion || ''}`,
        chText: chunk.pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n'),
      };
    });
    let cacheHits = 0;
    // Welle 4 · #11 – für lokale Modelle zweigeteilte Extraktion:
    //   Pass A: figuren + assignments (fokussiertes Schema)
    //   Pass B: orte + fakten + szenen
    // Cache-Keys entsprechend `${key}:figuren` / `${key}:orte`, damit alte
    // kombinierte Caches sauber neu entstehen statt fälschlich getroffen zu werden.
    const isSplit = effectiveProvider !== 'claude';
    const settled = await settledAll(
      chunkTexts.map(({ chunk, key, pagesSig, chText }, chunkIdx) => async () => {
        const chunkLabel = `Chunk ${chunkIdx + 1}/${chunkTexts.length} «${chunk.name}»`;
        log.info(`Job ${jobId}: ${chunkLabel} – ${chunk.pages.length} Seiten${isSplit ? ' (Split-Pässe)' : ''}`);

        if (!isSplit) {
          // Claude: ein Call pro Chunk, kombiniertes Schema.
          const cached = loadChapterExtractCache(bookIdInt, email, key, pagesSig);
          if (cached) { cacheHits++; log.info(`Job ${jobId}: ${chunkLabel} – Cache-HIT.`); return cached; }
          log.info(`Job ${jobId}: ${chunkLabel} – Cache-MISS, KI-Call…`);
          const result = await call(jobId, tok,
            prompts.buildExtraktionKomplettChapterPrompt(chunk.name, bookName, chunk.pages.length, chText),
            sys.SYSTEM_KOMPLETT_EXTRAKTION, 12, 28, 14000, 0.2, null, prompts.SCHEMA_KOMPLETT_EXTRAKTION,
          );
          saveChapterExtractCache(bookIdInt, email, key, pagesSig, result);
          log.info(`Job ${jobId}: ${chunkLabel} – OK (fig=${result?.figuren?.length ?? 0} orte=${result?.orte?.length ?? 0} sz=${result?.szenen?.length ?? 0}).`);
          return result;
        }

        // Lokal: zwei fokussierte Pässe. Cache je Pass.
        const figKey = `${key}:figuren`;
        const ortKey = `${key}:orte`;
        const cachedFig = loadChapterExtractCache(bookIdInt, email, figKey, pagesSig);
        const cachedOrt = loadChapterExtractCache(bookIdInt, email, ortKey, pagesSig);

        let passA = cachedFig;
        if (passA) { cacheHits++; log.info(`Job ${jobId}: ${chunkLabel} Pass A (Figuren) – Cache-HIT.`); }
        else {
          log.info(`Job ${jobId}: ${chunkLabel} Pass A (Figuren) – KI-Call…`);
          passA = await call(jobId, tok,
            prompts.buildExtraktionFigurenPassPrompt(chunk.name, bookName, chunk.pages.length, chText),
            sys.SYSTEM_KOMPLETT_FIGUREN_PASS, 12, 20, 8000, 0.2, null, prompts.SCHEMA_KOMPLETT_FIGUREN_PASS,
          );
          saveChapterExtractCache(bookIdInt, email, figKey, pagesSig, passA);
        }

        let passB = cachedOrt;
        if (passB) { cacheHits++; log.info(`Job ${jobId}: ${chunkLabel} Pass B (Orte/Szenen) – Cache-HIT.`); }
        else {
          log.info(`Job ${jobId}: ${chunkLabel} Pass B (Orte/Szenen) – KI-Call…`);
          passB = await call(jobId, tok,
            prompts.buildExtraktionOrtePassPrompt(chunk.name, bookName, chunk.pages.length, chText),
            sys.SYSTEM_KOMPLETT_ORTE_PASS, 20, 28, 6000, 0.2, null, prompts.SCHEMA_KOMPLETT_ORTE_PASS,
          );
          saveChapterExtractCache(bookIdInt, email, ortKey, pagesSig, passB);
        }

        const merged = {
          figuren:     passA?.figuren     || [],
          assignments: passA?.assignments || [],
          orte:        passB?.orte        || [],
          fakten:      passB?.fakten      || [],
          szenen:      passB?.szenen      || [],
        };
        log.info(`Job ${jobId}: ${chunkLabel} – Split-OK (fig=${merged.figuren.length} orte=${merged.orte.length} sz=${merged.szenen.length}).`);
        return merged;
      })
    );

    // Fehlgeschlagene Chunks loggen (einmal pro Chunk, nicht pro Feld)
    for (let i = 0; i < settled.length; i++) {
      if (settled[i].status === 'rejected')
        log.warn(`Job ${jobId}: Vollextraktion «${chunkTexts[i].chunk.name}» übersprungen: ${settled[i].reason?.message}`);
    }
    chapterFiguren     = extractField(settled, chunkTexts, 'figuren');
    chapterOrte        = extractField(settled, chunkTexts, 'orte');
    chapterFakten      = extractField(settled, chunkTexts, 'fakten');
    chapterSzenen      = extractField(settled, chunkTexts, 'szenen');
    chapterAssignments = extractField(settled, chunkTexts, 'assignments');

    const failedChunks = settled.filter(r => r.status === 'rejected');
    log.info(`Job ${jobId}: Phase 1 Multi-Pass – ${settled.length - failedChunks.length}/${settled.length} OK (${cacheHits} Cache-Hits), fig=${chapterFiguren.reduce((s, c) => s + c.figuren.length, 0)} orte=${chapterOrte.reduce((s, c) => s + c.orte.length, 0)} sz=${chapterSzenen.reduce((s, c) => s + c.szenen.length, 0)}`);
    if (failedChunks.length > 0) {
      // Chunk fehlgeschlagen → kein Checkpoint speichern; Delta-Cache schützt erfolgreiche Chunks.
      // Beim Retry versucht Phase 1 die fehlgeschlagenen Chunks erneut.
      const failedDetails = chunkTexts
        .map((ct, i) => ({ ct, r: settled[i] }))
        .filter(({ r }) => r.status === 'rejected')
        .map(({ ct, r }) => `${ct.chunk.name}: ${r.reason?.message || 'unbekannt'}`);
      throw i18nError('job.error.phase1Incomplete', { count: failedChunks.length, details: failedDetails.join('; ') });
    }
  }

  saveCheckpoint('komplett-analyse', bookIdInt, email, {
    phase: 'p1_full_done',
    chapterFiguren, chapterOrte, chapterFakten, chapterSzenen, chapterAssignments,
    tokIn: tok.in, tokOut: tok.out, tokMs: tok.ms,
  });
  return { chapterFiguren, chapterOrte, chapterFakten, chapterSzenen, chapterAssignments };
}

/** Phase 2: Figuren konsolidieren + Soziogramm + Name→ID Lookup.
 *  Single-Pass-Optimierung: Wenn Phase 1 im Single-Pass-Modus lief (ein „Kapitel"
 *  namens Gesamtbuch), sind die Figuren bereits holistisch extrahiert – eine
 *  weitere KI-Konsolidierung fügt nichts hinzu und kostet ~8K Tokens extra.
 *  Stattdessen übernehmen wir die P1-Figuren direkt (IDs werden normalisiert). */
async function runPhase2(ctx, chapterFiguren, chapterAssignments) {
  const { jobId, bookIdInt, bookName, email, call, tok, log, prompts, sys, idMaps, effectiveProvider } = ctx;

  const isSinglePass = chapterFiguren.length === 1 && chapterFiguren[0].kapitel === 'Gesamtbuch';
  let figuren;

  if (isSinglePass) {
    updateJob(jobId, { progress: 30, statusText: 'job.phase.consolidatingFiguren' });
    const raw = chapterFiguren[0].figuren || [];
    figuren = raw.map((f, i) => ({ ...f, id: f.id || ('fig_' + (i + 1)) }));
    log.info(`Job ${jobId}: Phase 2 übersprungen (Single-Pass, ${figuren.length} Figuren aus P1 übernommen) – spart einen KI-Call.`);
    updateJob(jobId, { progress: effectiveProvider === 'claude' ? 40 : 43 });
  } else {
    updateJob(jobId, { progress: 30, statusText: 'job.phase.consolidatingFiguren' });
    // Welle 3 · Rollierender Dedup: Duplikate regelbasiert VOR dem KI-Call entfernen.
    // Spart Eingabetokens und verhindert, dass Phase 2 aus Bequemlichkeit doppelte Figuren durchlässt.
    const { chapterFiguren: preMerged, dupesRemoved } = preMergeChapterFiguren(chapterFiguren);
    if (dupesRemoved > 0) log.info(`Job ${jobId}: Rollierender Pre-Merge – ${dupesRemoved} Figuren-Duplikate regelbasiert zusammengeführt.`);
    const figProgressEnd = effectiveProvider === 'claude' ? 40 : 43;
    const figResult = await call(jobId, tok,
      prompts.buildFiguresBasisConsolidationPrompt(bookName, preMerged, sys.BUCH_KONTEXT || ''),
      sys.SYSTEM_FIGUREN, 30, figProgressEnd, 8000, 0.2, null, prompts.SCHEMA_FIGUREN_KONSOL,
    );
    if (!Array.isArray(figResult?.figuren)) throw i18nError('job.error.figurenMissing');
    figuren = figResult.figuren.map((f, i) => ({ ...f, id: f.id || ('fig_' + (i + 1)) }));
  }
  const { figuren: mergedFiguren, mergedCount, stage1Saved, stage2Saved, idRemap } = mergeDuplicateFiguren(figuren);
  if (mergedCount > 0) log.info(`Job ${jobId}: ${mergedCount} Figuren-Duplikate zusammengeführt (exakt: ${stage1Saved}, Teilname+Indizien: ${stage2Saved}).`);
  figuren = mergedFiguren;
  if (effectiveProvider && effectiveProvider !== 'claude') {
    const { cleared, moved } = validateBeziehungenDescriptions(figuren);
    if (cleared > 0 || moved > 0) log.info(`Job ${jobId}: Beziehungs-Beschreibungen bereinigt – ${moved} verschoben, ${cleared} geleert.`);
    // Welle 4 · #12 – Sozialschicht per Mehrheitsabstimmung harmonisieren.
    const schichtChanges = applySozialschichtModeVote(chapterFiguren, figuren);
    if (schichtChanges > 0) log.info(`Job ${jobId}: Sozialschicht per Mehrheitsvotum korrigiert (${schichtChanges} Figuren).`);
  }
  saveFigurenToDb(bookIdInt, figuren, email, idMaps);
  log.info(`Job ${jobId}: ${figuren.length} Figuren gespeichert.`);
  // Figuren-Mentions für den Buch-Chat-Index aktualisieren (non-critical)
  try {
    const { figures: figCount, pagesProcessed } = recomputeBookFigureMentions(bookIdInt, email);
    log.info(`Job ${jobId}: Figuren-Mentions aktualisiert (${figCount} Figuren × ${pagesProcessed} Seiten).`);
  } catch (e) {
    log.warn(`Job ${jobId}: Figuren-Mentions-Neuberechnung fehlgeschlagen: ${e.message}`);
  }

  // Soziogramm: preliminary-Werte aus P2-Ergebnis als Fallback
  if (figuren.length >= 4) {
    let sozFiguren = figuren.map(f => ({ fig_id: f.id, sozialschicht: f.sozialschicht || 'andere' }));
    let sozBeziehungen = figuren.flatMap(f =>
      (f.beziehungen || [])
        .filter(bz => bz.machtverhaltnis && bz.figur_id)
        .map(bz => ({ from_fig_id: f.id, to_fig_id: bz.figur_id, machtverhaltnis: bz.machtverhaltnis }))
    );

    // Claude-only + Multi-Pass: holistische Soziogramm-Konsolidierung (sozialschicht + machtverhaltnis)
    // Bei Single-Pass hat Claude das ganze Buch gesehen → preliminary-Werte sind bereits holistisch,
    // der Refine-Call fügt nichts hinzu und kostet ~3K Tokens extra.
    // Non-critical – bei Fehler fallen wir auf die preliminary-Werte zurück.
    if (effectiveProvider === 'claude' && !isSinglePass) {
      updateJob(jobId, { progress: 40, statusText: 'job.phase.refiningSoziogramm' });
      try {
        const sozResult = await call(jobId, tok,
          prompts.buildSoziogrammConsolidationPrompt(bookName, figuren, sys.BUCH_KONTEXT || ''),
          sys.SYSTEM_FIGUREN, 40, 43, 3000, 0.2, null, prompts.SCHEMA_SOZIOGRAMM_KONSOL,
        );
        const validIds = new Set(figuren.map(f => f.id));
        const prelimSchichtById = Object.fromEntries(sozFiguren.map(s => [s.fig_id, s.sozialschicht]));
        const prelimPairs = new Set(sozBeziehungen.map(bz => `${bz.from_fig_id}|${bz.to_fig_id}`));
        const schichtOverride = {};
        for (const f of (sozResult?.figuren || [])) {
          if (f && validIds.has(f.id) && f.sozialschicht) schichtOverride[f.id] = f.sozialschicht;
        }
        sozFiguren = figuren.map(f => ({
          fig_id: f.id,
          sozialschicht: schichtOverride[f.id] || prelimSchichtById[f.id] || 'andere',
        }));
        const refinedBz = (sozResult?.beziehungen || [])
          .filter(bz => bz && validIds.has(bz.from_fig_id) && validIds.has(bz.to_fig_id)
            && bz.from_fig_id !== bz.to_fig_id
            && Number.isFinite(bz.machtverhaltnis)
            && prelimPairs.has(`${bz.from_fig_id}|${bz.to_fig_id}`));
        if (refinedBz.length > 0) sozBeziehungen = refinedBz;
        const changedSchichten = Object.keys(schichtOverride).filter(id => schichtOverride[id] !== prelimSchichtById[id]).length;
        log.info(`Job ${jobId}: Soziogramm-Konsolidierung: ${changedSchichten} Schicht-Korrekturen, ${refinedBz.length}/${prelimPairs.size} Machtbeziehungen verfeinert.`);
      } catch (e) {
        log.warn(`Job ${jobId}: Soziogramm-Konsolidierung fehlgeschlagen, nutze preliminary-Werte: ${e.message}`);
        updateJob(jobId, { progress: 43 });
      }
    }

    updateFigurenSoziogramm(bookIdInt, sozFiguren, sozBeziehungen, email);
    log.info(`Job ${jobId}: Soziogramm: ${sozFiguren.length} Figuren, ${sozBeziehungen.length} Machtbeziehungen.`);
  }

  const figurenKompakt = figuren.map(f => ({ id: f.id, name: f.name, typ: f.typ || 'andere' }));
  const { figNameToId, figNameToIdLower } = buildFigNameLookup(figuren, chapterFiguren, chapterAssignments, log, jobId);

  return { figuren, figNameToId, figNameToIdLower, figurenKompakt, idRemap, isSinglePass };
}

/** Phase 3: Orte konsolidieren + Name→ID Lookup.
 *  Single-Pass-Optimierung analog zu Phase 2: Wenn Phase 1 im Single-Pass-Modus lief,
 *  sind die Orte bereits holistisch extrahiert – ein Konsolidierungs-Call fügt nichts
 *  hinzu und kostet ~15K Tokens. Die figuren-Referenzen in den Orten werden gegen das
 *  idRemap aus mergeDuplicateFiguren abgeglichen (gemergte Figuren werden umgebogen,
 *  nicht mehr existente entfernt). */
async function runPhase3(ctx, chapterOrte, figurenKompakt, isSinglePass, idRemap, opts = {}) {
  const { jobId, bookIdInt, bookName, email, call, tok, log, prompts, sys, idMaps } = ctx;
  // opts.prefetchedOrteRaw: Ergebnis eines parallel laufenden runPhase3OrteCall.
  //   Dann nochmaliger Call entfällt; idRemap+validFigIds-Filter werden auf
  //   den Pre-Merge-IDs angewendet (Prompt nutzte prelim figurenKompakt).
  const prefetched = opts.prefetchedOrteRaw || null;

  let orte;
  if (isSinglePass) {
    updateJob(jobId, { progress: 43, statusText: 'job.phase.consolidatingOrte' });
    const validFigIds = new Set(figurenKompakt.map(f => f.id));
    const raw = chapterOrte[0]?.orte || [];
    orte = raw.map((o, i) => ({
      ...o,
      id: o.id || ('ort_' + (i + 1)),
      figuren: (o.figuren || [])
        .map(fid => idRemap?.[fid] || fid)
        .filter(fid => validFigIds.has(fid)),
    }));
    log.info(`Job ${jobId}: Phase 3 übersprungen (Single-Pass, ${orte.length} Orte aus P1 übernommen) – spart einen KI-Call.`);
    updateJob(jobId, { progress: 55 });
  } else {
    updateJob(jobId, { progress: 43, statusText: 'job.phase.consolidatingOrte' });
    const orteResultRaw = prefetched || await call(jobId, tok,
      prompts.buildLocationsConsolidationPrompt(bookName, chapterOrte, figurenKompakt),
      sys.SYSTEM_ORTE, 43, 55, 6000, 0.2, null, prompts.SCHEMA_ORTE_KONSOL,
    );
    if (!Array.isArray(orteResultRaw?.orte)) throw i18nError('job.error.orteMissing');
    if (prefetched) {
      // AI-Call lief mit Pre-Merge-figurenKompakt → IDs auf Post-Merge umbiegen.
      const validFigIds = new Set(figurenKompakt.map(f => f.id));
      orte = orteResultRaw.orte.map((o, i) => ({
        ...o,
        id: o.id || ('ort_' + (i + 1)),
        figuren: (o.figuren || [])
          .map(fid => idRemap?.[fid] || fid)
          .filter(fid => validFigIds.has(fid)),
      }));
      updateJob(jobId, { progress: 55 });
    } else {
      orte = orteResultRaw.orte.map((o, i) => ({ ...o, id: o.id || ('ort_' + (i + 1)) }));
    }
  }
  saveOrteToDb(bookIdInt, orte, email, idMaps.chNameToId, idMaps.pageNameToIdByChapter);
  log.info(`Job ${jobId}: ${orte.length} Schauplätze gespeichert.`);

  const ortNameToId = {}, ortNameToIdLower = {};
  for (const o of orte) {
    ortNameToId[o.name] = o.id;
    ortNameToIdLower[o.name.toLowerCase()] = o.id;
  }
  return { orte, ortNameToId, ortNameToIdLower };
}

/** Pre-Merge figurenKompakt aus chapterFiguren – für parallelen Orte-Call vor P2-Merge.
 *  Dedup nach ID (Reihenfolge: erstes Vorkommen gewinnt). */
function buildPrelimFigurenKompakt(chapterFiguren) {
  const seen = new Set();
  const list = [];
  for (const c of chapterFiguren) {
    for (const f of (c.figuren || [])) {
      if (!f?.id || seen.has(f.id)) continue;
      seen.add(f.id);
      list.push({ id: f.id, name: f.name, typ: f.typ || 'andere' });
    }
  }
  return list;
}

/** Nur der Orte-Konso-AI-Call (Multi-Pass) – ohne DB-Save, ohne Progress-Update.
 *  Aufrufer wendet idRemap+validFigIds-Filter via runPhase3(opts.prefetchedOrteRaw) an. */
async function runPhase3OrteCall(ctx, chapterOrte, figurenKompaktForPrompt) {
  const { jobId, bookName, call, tok, prompts, sys } = ctx;
  return call(jobId, tok,
    prompts.buildLocationsConsolidationPrompt(bookName, chapterOrte, figurenKompaktForPrompt),
    sys.SYSTEM_ORTE,
    null, null,
    6000, 0.2, null, prompts.SCHEMA_ORTE_KONSOL,
  );
}

/**
 * Phase 3b: Kapitelübergreifende Beziehungen (nur Multi-Pass).
 * Single-Pass: Phase 1 hat den vollständigen Text gesehen → Beziehungen bereits erfasst.
 * Multi-Pass: Kapitel wurden isoliert analysiert → Beziehungen zwischen Figuren
 * verschiedener Kapitel hier nachträglich identifiziert.
 */
async function runPhase3b(ctx, figuren) {
  const { jobId, bookIdInt, email, call, tok, log, prompts, sys, singlePassLimit, bookName, fullBookText, pageContents } = ctx;

  updateJob(jobId, { progress: 55, statusText: 'job.phase.crossChapterRelations' });

  // Welle 3 · Co-Occurrence-basierter Textauswahl: Statt fullBookText zu trunkieren
  // (was bei lokalen Modellen bis zu 2/3 des Buchs verwirft), zielen wir auf
  // die Seiten ab, wo mindestens zwei Figuren aus verschiedenen Kapiteln gemeinsam
  // vorkommen. Das liefert dichtere Evidenz bei viel kleinerem Token-Budget.
  let textForPrompt = null;

  try {
    const { computeFigureMentions } = require('../../lib/page-index');
    // Figuren-Objekte für computeFigureMentions: {id, name, kurzname}
    const figInput = figuren.map(f => ({ id: f.id, name: f.name, kurzname: f.kurzname || '' }));
    // Map: figId → Set<pageIdx>
    const figPages = new Map();
    for (let pi = 0; pi < pageContents.length; pi++) {
      const mentions = computeFigureMentions(pageContents[pi].text, figInput);
      for (const m of mentions) {
        if (!figPages.has(m.figure_id)) figPages.set(m.figure_id, new Set());
        figPages.get(m.figure_id).add(pi);
      }
    }
    // Figur-zu-Hauptkapitel-Map (aus f.kapitel[0].name, sofern vorhanden)
    const figToHome = Object.fromEntries(figuren.map(f => [f.id, (f.kapitel || [])[0]?.name || null]));
    // Existierende Beziehungspaare (ungeordnet)
    const existingPairs = new Set();
    for (const f of figuren) {
      for (const b of (f.beziehungen || [])) {
        const [a, c] = f.id < b.figur_id ? [f.id, b.figur_id] : [b.figur_id, f.id];
        existingPairs.add(`${a}|${c}`);
      }
    }
    // Kandidatenseiten: Co-Occurrence zweier Figuren aus unterschiedlichen Haupt-Kapiteln
    // und noch ohne Beziehung untereinander.
    const candidatePageIdx = new Set();
    const figIds = figuren.map(f => f.id);
    for (let i = 0; i < figIds.length; i++) {
      for (let j = i + 1; j < figIds.length; j++) {
        const a = figIds[i], b = figIds[j];
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (existingPairs.has(key)) continue;
        if (figToHome[a] && figToHome[b] && figToHome[a] === figToHome[b]) continue;
        const pa = figPages.get(a), pb = figPages.get(b);
        if (!pa || !pb) continue;
        for (const pi of pa) if (pb.has(pi)) candidatePageIdx.add(pi);
      }
    }
    if (candidatePageIdx.size > 0) {
      // Budget: bei Lokalmodellen gilt singlePassLimit (60K) als harte Obergrenze.
      // Seiten nach Index sortieren (Reihenfolge im Buch), bis Budget voll ist.
      const sortedIdx = [...candidatePageIdx].sort((x, y) => x - y);
      const parts = [];
      let total = 0;
      for (const pi of sortedIdx) {
        const p = pageContents[pi];
        const chunk = `## ${p.chapter || 'Sonstige'}\n### ${p.title}\n${p.text}`;
        if (total + chunk.length > singlePassLimit) break;
        parts.push(chunk);
        total += chunk.length;
      }
      if (parts.length > 0) {
        textForPrompt = parts.join('\n\n---\n\n');
        log.info(`Job ${jobId}: Phase 3b Co-Occurrence – ${parts.length} Seiten (${total} Zeichen) aus ${candidatePageIdx.size} Kandidaten.`);
      }
    }
  } catch (e) {
    log.warn(`Job ${jobId}: Phase 3b Co-Occurrence-Auswahl fehlgeschlagen, Fallback auf Trunkierung: ${e.message}`);
  }

  // Fallback: wie vorher, Buchtext bis singlePassLimit
  if (!textForPrompt) {
    textForPrompt = fullBookText.length <= singlePassLimit ? fullBookText : fullBookText.slice(0, singlePassLimit);
  }

  const bzResult = await call(jobId, tok,
    prompts.buildKapiteluebergreifendeBeziehungenPrompt(bookName, figuren, textForPrompt),
    sys.SYSTEM_FIGUREN, 55, 58, 2000, 0.2, null, prompts.SCHEMA_BEZIEHUNGEN,
  );
  const newBz = Array.isArray(bzResult?.beziehungen) ? bzResult.beziehungen : [];
  if (newBz.length > 0) addFigurenBeziehungen(bookIdInt, newBz, email, ctx.idMaps);
  log.info(`Job ${jobId}: Phase 3b – ${newBz.length} kapitelübergreifende Beziehungen.`);
}

/** P6: Zeitstrahl aus gespeicherten Events konsolidieren. */
async function runZeitstrahl(ctx, opts = {}) {
  const { jobId, bookIdInt, email, call, tok, log, prompts, sys, idMaps } = ctx;
  // silent: keine Progress-/Status-Updates; nötig wenn parallel zu P8 (Claude),
  // damit P8 die Bar exklusiv kontrolliert.
  const silent = !!opts.silent;

  if (!silent) updateJob(jobId, { progress: 78, statusText: 'job.phase.consolidatingTimeline' });
  const rawEvtRows = db.prepare(`
    SELECT f.fig_id, f.name AS fig_name, f.typ AS fig_typ,
           fe.datum, fe.ereignis, fe.typ AS evt_typ, fe.bedeutung,
           c.chapter_name AS kapitel, p.page_name AS seite
    FROM figure_events fe
    JOIN figures f ON f.id = fe.figure_id
    LEFT JOIN chapters c ON c.chapter_id = fe.chapter_id
    LEFT JOIN pages    p ON p.page_id    = fe.page_id
    WHERE f.book_id = ? AND f.user_email IS ?
    ORDER BY fe.datum, f.sort_order
  `).all(bookIdInt, email);
  if (!rawEvtRows.length) return;

  const evtGroupMap = new Map();
  for (const row of rawEvtRows) {
    const key = `${row.datum}||${(row.ereignis || '').trim().toLowerCase()}`;
    if (!evtGroupMap.has(key)) {
      evtGroupMap.set(key, {
        datum: row.datum, ereignis: row.ereignis, typ: row.evt_typ,
        bedeutung: row.bedeutung || '',
        kapitel: row.kapitel ? [row.kapitel] : [],
        seiten:  row.seite   ? [row.seite]   : [],
        figuren: [],
      });
    }
    const ev = evtGroupMap.get(key);
    if (!ev.figuren.some(f => f.id === row.fig_id))
      ev.figuren.push({ id: row.fig_id, name: row.fig_name, typ: row.fig_typ || 'andere' });
    if (row.kapitel && !ev.kapitel.includes(row.kapitel)) ev.kapitel.push(row.kapitel);
    if (row.seite   && !ev.seiten.includes(row.seite))   ev.seiten.push(row.seite);
  }

  const zeitstrahlEvents = [...evtGroupMap.values()].sort((a, b) => parseInt(a.datum) - parseInt(b.datum));

  // Bei wenigen pre-gegroupeten Events bringt die KI-Konsolidierung fast nichts
  // (Dedup-Chance klein, kanonische Formulierung marginal) – direkt speichern spart
  // einen KI-Call (~2K Input + 3K Output).
  if (zeitstrahlEvents.length < 5) {
    saveZeitstrahlEvents(bookIdInt, email, zeitstrahlEvents, idMaps.chNameToId, idMaps.pageNameToIdByChapter);
    log.info(`Job ${jobId}: ${zeitstrahlEvents.length} Zeitstrahl-Ereignisse direkt gespeichert (unter Konsolidierungs-Schwelle) – spart einen KI-Call.`);
    if (!silent) updateJob(jobId, { progress: 82 });
    return;
  }

  const ztResult = await call(jobId, tok,
    prompts.buildZeitstrahlConsolidationPrompt(zeitstrahlEvents),
    sys.SYSTEM_ZEITSTRAHL,
    silent ? null : 78, silent ? null : 82,
    3000, 0.2, null, prompts.SCHEMA_ZEITSTRAHL,
  );
  if (Array.isArray(ztResult?.ereignisse)) {
    saveZeitstrahlEvents(bookIdInt, email, ztResult.ereignisse, idMaps.chNameToId, idMaps.pageNameToIdByChapter);
    log.info(`Job ${jobId}: ${ztResult.ereignisse.length} Zeitstrahl-Ereignisse gespeichert.`);
  }
  // Sicherstellen dass Zeitstrahl-Threshold (82) zuverlässig erreicht wird
  if (!silent) updateJob(jobId, { progress: 82 });
}

// ── Job: Komplettanalyse ─────────────────────────────────────────────────────
// Pipeline (token-optimiert):
//   P1 (Vollextraktion: Figuren+Orte+Fakten+Szenen+Events, parallel/Kapitel, SYSTEM_KOMPLETT_EXTRAKTION)
//      → Schema im System-Prompt gecacht; Szenen/Events mit Klarnamen (kein ID-Lookup nötig)
//   P2/P3 (Claude Multi-Pass parallel, sonst sequentiell):
//      P2 (Figuren konsolidieren + Soziogramm) → figNameToId aufbauen
//      P3 (Orte konsolidieren, prelim figurenKompakt im Prompt, idRemap post-hoc) → ortNameToId
//   P3b (Kapitelübergreifende Beziehungen, nur Multi-Pass, non-critical)
//   P5 Szenen remappen
//   P6 Zeitstrahl + P8 Kontinuität: parallel bei Claude (P8 ownt Progress-Bar), sonst sequentiell
async function runKomplettAnalyseJob(jobId, bookId, bookName, userEmail, userToken, provider = undefined) {
  const bookIdInt = parseInt(bookId);
  const email = userEmail || null;
  const log = makeJobLogger(jobId);
  // call akzeptiert optional ein JSON-Schema als letztes Argument (11. Position in aiCall).
  // Schemas werden nur von lokalen Providern (ollama/llama) verwendet – Claude ignoriert sie.
  const call = (jobId_, tok_, prompt_, system_, fromPct, toPct, expectedChars, outputRatio, maxTokens, schema) =>
    aiCall(jobId_, tok_, prompt_, system_, fromPct, toPct, expectedChars, outputRatio, maxTokens, provider, schema);
  const effectiveProvider = provider || process.env.API_PROVIDER || 'claude';
  // SINGLE_PASS_LIMIT skaliert jetzt dynamisch mit MODEL_CONTEXT (siehe shared.js).
  // Bei 200K-Kontext ≈ 420K Zeichen Single-Pass – reicht für fast alle Bücher.
  const singlePassLimit = SINGLE_PASS_LIMIT;
  const prompts = await getPrompts();
  const sys = await getBookPrompts(bookId, email);
  const tok = { in: 0, out: 0, ms: 0, inflight: new Map() };

  try {
    const cp = loadAndValidateCheckpoint(bookIdInt, email, log, jobId);

    // ── Seiten laden ──────────────────────────────────────────────────────────
    updateJob(jobId, { statusText: 'job.phase.loadingPages', progress: 0 });
    const [chaptersData, pages] = await Promise.all([
      bsGetAll('chapters?filter[book_id]=' + bookId, userToken),
      bsGetAll('pages?filter[book_id]=' + bookId, userToken),
    ]);
    if (!pages.length) { completeJob(jobId, { empty: true }); return; }

    const chMap = Object.fromEntries(chaptersData.map(c => [c.id, c.name]));
    const pageContents = await loadPageContents(pages, chMap, 30, (i, total) => {
      updateJob(jobId, {
        progress: Math.round((i / total) * 12),
        statusText: 'job.phase.readingPages',
        statusParams: { from: i + 1, to: Math.min(i + BATCH_SIZE, total), total },
      });
    }, userToken, jobAbortControllers.get(jobId)?.signal);

    const idMaps = {
      chNameToId: Object.fromEntries(chaptersData.map(c => [c.name, c.id])),
      // Kapitel-scoped Page-Lookup gegen Namenskollisionen: derselbe Seitenname
      // kann in mehreren Kapiteln existieren (z.B. «Der Vater» als Kapitelname
      // und als Page-Titel in einem anderen Kapitel). Key 0 = Seiten ohne Kapitel.
      pageNameToIdByChapter: (() => {
        const map = {};
        for (const p of pages) {
          const k = p.chapter_id ?? 0;
          (map[k] ??= {})[p.name] = p.id;
        }
        return map;
      })(),
    };
    invalidateRenamedChapterCaches(bookIdInt, chaptersData, log, jobId);

    // Buchtext-Preprocessing (claude-only): unbekannte HTML-Entities (&nbsp;,
    // &mdash;, …), Zero-Width-Zeichen, Soft Hyphen, NBSP, doppelte Spaces raus.
    // Wirkt auf pageContents → schlägt automatisch in fullBookText UND
    // Multi-Pass-Chunks durch (beide werden aus pageContents gebaut).
    // P1 und P8 nutzen identischen Buchtext → 1h-Cache-Read in P8 bleibt intakt.
    if (effectiveProvider === 'claude') {
      let savedChars = 0;
      for (const p of pageContents) {
        const before = p.text.length;
        p.text = cleanPageTextForClaude(p.text);
        savedChars += before - p.text.length;
      }
      if (savedChars > 0) log.info(`Job ${jobId}: Buchtext-Preprocessing ${savedChars} Zeichen entfernt (Entities/Whitespace/ZWS).`);
    }

    const totalChars = pageContents.reduce((s, p) => s + p.text.length, 0);
    const { groupOrder, groups } = groupByChapter(pageContents);
    // Einmal bauen, wiederverwenden (Phase 1 Single-Pass, Phase 3b, P8 Kontinuität)
    const fullBookText = buildSinglePassBookText(groups, groupOrder);
    // Single/Multi-Pass-Signal für die Frontend-Phasenanzeige: Im Single-Pass wird
    // Phase 3b übersprungen, die UI blendet den entsprechenden Eintrag aus.
    const passMode = totalChars <= singlePassLimit ? 'single' : 'multi';
    updateJob(jobId, { passMode });

    // Cache-Version: Modellname + Prompts-Schema-Version. Ändert sich eins davon,
    // werden alle persistierten Phase-1-Caches automatisch verworfen (Hit-Test
    // matcht den vollen Sig-String inkl. dieser Version).
    const cacheVersion = `${_modelName(effectiveProvider)}:${prompts.PROMPTS_VERSION || ''}`;

    const ctx = {
      jobId, bookIdInt, bookName, email, call, tok, log,
      effectiveProvider, singlePassLimit, cacheVersion, prompts, sys,
      idMaps, pageContents, groups, groupOrder, totalChars, fullBookText,
    };

    // ── Phase 1: Vollextraktion ───────────────────────────────────────────────
    const p1 = cp?.phase === 'p1_full_done'
      ? restorePhase1FromCheckpoint(cp, tok, log, jobId)
      : await runPhase1(ctx);
    const { chapterFiguren, chapterOrte, chapterFakten, chapterSzenen, chapterAssignments } = p1;

    // ── Phase 2 + 3: Figuren + Orte konsolidieren ────────────────────────────
    // Multi-Pass Claude: P2 (Figuren-AI) und P3 (Orte-AI) sind unabhängig und
    // werden parallel gefahren. P3 nutzt prelim figurenKompakt (Pre-P2-Merge) im
    // Prompt; nach P2-Merge werden die Orte-figuren-IDs via idRemap+validFigIds
    // auf die finalen Post-Merge-IDs umgebogen.
    // Single-Pass: kein AI-Call in P2/P3 → Parallelisierung bringt nichts.
    // Lokale Provider: sequentiell (Mutex serialisiert AI-Calls ohnehin).
    const isMultiPassClaude = effectiveProvider === 'claude' && chapterFiguren.length > 1;
    let figuren, figNameToId, figNameToIdLower, figurenKompakt, idRemap, isSinglePass;
    let orte, ortNameToId, ortNameToIdLower;
    if (isMultiPassClaude) {
      const prelimFigKompakt = buildPrelimFigurenKompakt(chapterFiguren);
      const [p2Result, orteRaw] = await Promise.all([
        runPhase2(ctx, chapterFiguren, chapterAssignments),
        runPhase3OrteCall(ctx, chapterOrte, prelimFigKompakt),
      ]);
      ({ figuren, figNameToId, figNameToIdLower, figurenKompakt, idRemap, isSinglePass } = p2Result);
      ({ orte, ortNameToId, ortNameToIdLower } =
        await runPhase3(ctx, chapterOrte, figurenKompakt, isSinglePass, idRemap, { prefetchedOrteRaw: orteRaw }));
    } else {
      ({ figuren, figNameToId, figNameToIdLower, figurenKompakt, idRemap, isSinglePass } =
        await runPhase2(ctx, chapterFiguren, chapterAssignments));
      ({ orte, ortNameToId, ortNameToIdLower } =
        await runPhase3(ctx, chapterOrte, figurenKompakt, isSinglePass, idRemap));
    }

    // ── Phase 3b: Kapitelübergreifende Beziehungen (non-critical, nur Multi-Pass) ──
    if (chapterFiguren.length > 1 && figuren.length >= 2) {
      await runNonCritical('Phase 3b kapitelübergreifende Beziehungen',
        () => runPhase3b(ctx, figuren), log, jobId);
    }

    // ── Block 2: Szenen remappen → Zeitstrahl + Kontinuitätsprüfung ──────────
    // Claude: P6 (Zeitstrahl) und P8 (Kontinuität) sind unabhängig und laufen
    // parallel. P8 dominiert zeitlich (voller Buchtext bei Single-Pass, sonst
    // Fakten-Listen) und kontrolliert die Progress-Bar (82..97); P6 läuft
    // silent. Lokale Provider sequentiell (Mutex serialisiert ohnehin).
    updateJob(jobId, { progress: 58, statusText: 'job.phase.processingScenes' });
    const locRows = db.prepare(
      'SELECT id, loc_id FROM locations WHERE book_id = ? AND user_email = ? ORDER BY sort_order'
    ).all(bookIdInt, email);
    const locIdToDbId = Object.fromEntries(locRows.map(r => [r.loc_id, r.id]));
    const szenen = remapSzenen(chapterSzenen, figNameToId, figNameToIdLower, ortNameToId, ortNameToIdLower, idMaps.chNameToId);
    const assignments = remapAssignments(chapterAssignments, figNameToId, figNameToIdLower, idMaps.chNameToId, log, jobId);
    updateJob(jobId, { progress: 76, statusText: 'job.phase.savingScenes' });
    const szenenResult = saveSzenenAndEvents(bookIdInt, email, szenen, assignments, locIdToDbId, idMaps, log, jobId);
    backfillLocationChaptersFromScenes(bookIdInt, email);

    const figKompakt = figuren.map(f => ({ name: f.name, typ: f.typ || 'andere', beschreibung: f.beschreibung || '' }));
    const ortRows = db.prepare(
      'SELECT name, typ, beschreibung FROM locations WHERE book_id = ? AND user_email = ? ORDER BY sort_order'
    ).all(bookIdInt, email);
    const orteKompakt = ortRows.map(o => ({ name: o.name, typ: o.typ, beschreibung: o.beschreibung || '' }));

    // P8-Call als Closure – wird je nach Provider parallel oder sequentiell ausgeführt.
    const runP8 = async () => {
      if (totalChars <= singlePassLimit && effectiveProvider === 'claude') {
        log.info(`Job ${jobId}: Kontinuität Single-Pass: ${fullBookText.length} Zeichen, ${figKompakt.length} Figuren, ${orteKompakt.length} Orte`);
        const bookSystemBlock = { text: buildBookSystemBlockText(bookName, pageContents.length, fullBookText), ttl: '1h' };
        return call(jobId, tok,
          prompts.buildKontinuitaetSinglePassPrompt(bookName, null, figKompakt, orteKompakt, narrativeLabels(getBookSettings(bookIdInt, email))),
          [bookSystemBlock, { text: sys.SYSTEM_KONTINUITAET }],
          82, 97, 5000, 0.2, null, prompts.SCHEMA_KONTINUITAET_PROBLEME,
        );
      }
      log.info(`Job ${jobId}: Kontinuität facts-basiert: ${chapterFakten.length} Kapitel, ${figKompakt.length} Figuren`);
      return call(jobId, tok,
        prompts.buildKontinuitaetCheckPrompt(bookName, chapterFakten, figKompakt, orteKompakt),
        sys.SYSTEM_KONTINUITAET, 82, 97, effectiveProvider === 'claude' ? 5000 : 2500, 0.2, null, prompts.SCHEMA_KONTINUITAET_PROBLEME,
      );
    };

    let kontResult;
    if (effectiveProvider === 'claude') {
      // Parallel: P6 silent, P8 ownt Bar (82..97).
      updateJob(jobId, { progress: 82, statusText: 'job.phase.checkContinuity' });
      const [, p8Out] = await Promise.all([
        runZeitstrahl(ctx, { silent: true }),
        runP8(),
      ]);
      kontResult = p8Out;
    } else {
      await runZeitstrahl(ctx);
      updateJob(jobId, { progress: 82, statusText: 'job.phase.checkContinuity' });
      kontResult = await runP8();
    }
    saveKontinuitaetResult(bookIdInt, email, kontResult, figNameToId, idMaps.chNameToId, effectiveProvider, log, jobId);

    deleteCheckpoint('komplett-analyse', bookIdInt, email);
    completeJob(jobId, {
      figCount:    figuren.length,
      orteCount:   orte.length,
      szenenCount: szenenResult.szenenCount,
      tokensIn: tok.in, tokensOut: tok.out,
    }, tps(tok));
    log.info(`Job ${jobId}: Komplettanalyse Buch ${bookIdInt} abgeschlossen (${fmtTok(tok.in)}↑ ${fmtTok(tok.out)}↓).`);
  } catch (e) {
    if (e.name !== 'AbortError') {
      const cause = e.cause?.message || e.cause?.code || '';
      log.error(`Job ${jobId}: Komplettanalyse Fehler: ${e.message}${cause ? ' (cause: ' + cause + ')' : ''}`);
    }
    failJob(jobId, e);
  }
}

// ── Job: Kontinuitätsprüfung (eigenständig) ──────────────────────────────────
async function runKontinuitaetJob(jobId, bookId, bookName, userEmail, userToken, provider = undefined) {
  const bookIdInt = parseInt(bookId);
  const email = userEmail || null;
  const log = makeJobLogger(jobId);
  const call = (jobId_, tok_, prompt_, system_, fromPct, toPct, expectedChars, outputRatio, maxTokens, schema) =>
    aiCall(jobId_, tok_, prompt_, system_, fromPct, toPct, expectedChars, outputRatio, maxTokens, provider, schema);
  const effectiveProvider = provider || process.env.API_PROVIDER || 'claude';
  const singlePassLimit = SINGLE_PASS_LIMIT;
  const prompts = await getPrompts();
  const sys = await getBookPrompts(bookId, email);

  try {
    const cp = loadCheckpoint('kontinuitaet', bookIdInt, email);
    if (cp) log.info(`Job ${jobId}: Checkpoint gefunden (${cp.nextGi} Kapitel fertig).`);

    updateJob(jobId, { statusText: 'job.phase.loadingPages', progress: 0 });
    const [chaptersData, pages] = await Promise.all([
      bsGetAll('chapters?filter[book_id]=' + bookId, userToken),
      bsGetAll('pages?filter[book_id]=' + bookId, userToken),
    ]);
    if (!pages.length) { completeJob(jobId, { empty: true }); return; }

    const chMap = Object.fromEntries(chaptersData.map(c => [c.id, c.name]));
    const chNameToId = Object.fromEntries(chaptersData.map(c => [c.name, c.id]));
    const tok = { in: 0, out: 0, ms: 0 };

    // Bekannte Figuren + Orte aus DB laden
    const figRows = db.prepare(`
      SELECT f.fig_id, f.name, f.typ, f.beschreibung FROM figures f
      WHERE f.book_id = ? AND f.user_email = ? ORDER BY f.sort_order
    `).all(bookIdInt, email);
    const figurenKompakt = figRows.map(f => ({ name: f.name, typ: f.typ || 'andere', beschreibung: f.beschreibung || '' }));
    const figNameToId = Object.fromEntries(figRows.map(r => [r.name, r.fig_id]));

    const ortRows = db.prepare(
      'SELECT name, typ, beschreibung FROM locations WHERE book_id = ? AND user_email = ? ORDER BY sort_order'
    ).all(bookIdInt, email);
    const orteKompakt = ortRows.map(o => ({ name: o.name, typ: o.typ, beschreibung: o.beschreibung || '' }));

    const pageContents = await loadPageContents(pages, chMap, 30, (i, total) => {
      updateJob(jobId, {
        progress: Math.round((i / total) * 50),
        statusText: 'job.phase.readingPages',
        statusParams: { from: i + 1, to: Math.min(i + BATCH_SIZE, total), total },
      });
    }, userToken, jobAbortControllers.get(jobId)?.signal);

    // Buchtext-Preprocessing claude-only (siehe runKomplettAnalyseJob).
    if (effectiveProvider === 'claude') {
      let savedChars = 0;
      for (const p of pageContents) {
        const before = p.text.length;
        p.text = cleanPageTextForClaude(p.text);
        savedChars += before - p.text.length;
      }
      if (savedChars > 0) log.info(`Job ${jobId}: Buchtext-Preprocessing ${savedChars} Zeichen entfernt.`);
    }

    const totalChars = pageContents.reduce((s, p) => s + p.text.length, 0);
    const { groupOrder, groups } = groupByChapter(pageContents);
    let result;

    if (totalChars <= singlePassLimit) {
      updateJob(jobId, { progress: 60, statusText: 'job.phase.checkContinuity' });
      const bookText = buildSinglePassBookText(groups, groupOrder);
      result = await call(jobId, tok,
        prompts.buildKontinuitaetSinglePassPrompt(bookName, bookText, figurenKompakt, orteKompakt, narrativeLabels(getBookSettings(bookIdInt, email))),
        sys.SYSTEM_KONTINUITAET, 60, 97, 5000, 0.2, null, prompts.SCHEMA_KONTINUITAET_PROBLEME,
      );
    } else {
      // Multi-Pass: Fakten pro Kapitel extrahieren – ggf. aus Checkpoint fortsetzen
      let chapterFacts = cp?.chapterFacts ?? [];
      const startGi = cp?.nextGi ?? 0;
      if (startGi > 0) {
        updateJob(jobId, {
          progress: 50 + Math.round((startGi / groupOrder.length) * 35),
          statusText: 'job.phase.resumeFacts',
          statusParams: { current: startGi, total: groupOrder.length },
        });
      }
      for (let gi = startGi; gi < groupOrder.length; gi++) {
        const group = groups.get(groupOrder[gi]);
        const fromPct = 50 + Math.round((gi / groupOrder.length) * 35);
        const toPct   = 50 + Math.round(((gi + 1) / groupOrder.length) * 35);
        updateJob(jobId, { progress: fromPct, statusText: 'job.phase.factsInGroup', statusParams: { name: group.name, current: gi + 1, total: groupOrder.length } });
        const chText = group.pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n');
        try {
          const chResult = await call(jobId, tok,
            prompts.buildKontinuitaetChapterFactsPrompt(group.name, chText),
            sys.SYSTEM_KONTINUITAET, fromPct, toPct, 1500, 0.2, null, prompts.SCHEMA_KONTINUITAET_FAKTEN,
          );
          chapterFacts.push({ kapitel: group.name, fakten: chResult.fakten || [] });
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          log.warn(`Job ${jobId}: Fakten «${group.name}» übersprungen: ${e.message}`);
        }
        saveCheckpoint('kontinuitaet', bookIdInt, email, { chapterFacts, nextGi: gi + 1 });
      }

      updateJob(jobId, { progress: 88, statusText: 'job.phase.checkContradictions' });
      result = await call(jobId, tok,
        prompts.buildKontinuitaetCheckPrompt(bookName, chapterFacts, figurenKompakt, orteKompakt),
        sys.SYSTEM_KONTINUITAET, 88, 97, 5000, 0.2, null, prompts.SCHEMA_KONTINUITAET_PROBLEME,
      );
    }

    if (typeof result?.zusammenfassung === 'undefined') throw i18nError('job.error.zusammenfassungMissing');
    const normalizedProbleme = saveKontinuitaetResult(bookIdInt, email, result, figNameToId, chNameToId, effectiveProvider, log, jobId);
    deleteCheckpoint('kontinuitaet', bookIdInt, email);
    completeJob(jobId, {
      count: normalizedProbleme.length,
      issues: normalizedProbleme,
      zusammenfassung: result.zusammenfassung,
      tokensIn: tok.in, tokensOut: tok.out,
    }, tps(tok));
    log.info(`Job ${jobId}: Kontinuitätsprüfung abgeschlossen (${normalizedProbleme.length} Probleme, ${fmtTok(tok.in)}↑ ${fmtTok(tok.out)}↓).`);
  } catch (e) {
    if (e.name !== 'AbortError') log.error(`Job ${jobId}: Kontinuitätsprüfung Fehler: ${e.message}`);
    failJob(jobId, e);
  }
}

// ── Nacht-Cron: Komplettanalyse für alle Bücher × alle User ──────────────────
async function runKomplettAnalyseAll() {
  const cronProvider = process.env.API_PROVIDER || 'llama';
  const cronHostOk = cronProvider === 'llama'  ? !!process.env.LLAMA_HOST
                   : cronProvider === 'ollama' ? !!process.env.OLLAMA_HOST
                   : true; // claude braucht keinen lokalen Host
  if (!cronHostOk) {
    logger.info(`Nacht-Analyse übersprungen: ${cronProvider.toUpperCase()}_HOST nicht konfiguriert.`);
    return;
  }

  const users = getAllUserTokens();
  if (!users.length) {
    logger.warn('Nacht-Analyse übersprungen: kein BookStack-Token in der Datenbank.');
    return;
  }

  // Bücherliste mit erstem verfügbaren Token holen
  let books;
  for (const u of users) {
    try {
      books = await bsGetAll('books', { id: u.token_id, pw: u.token_pw });
      break;
    } catch (e) {
      logger.warn(`Nacht-Analyse: Bücherliste mit Token von ${u.email} fehlgeschlagen – nächsten versuchen.`);
    }
  }
  if (!books) {
    logger.error('Nacht-Analyse abgebrochen: kein gültiger Token für Bücherliste gefunden.');
    return;
  }

  logger.info(`Nacht-Analyse: ${books.length} Buch/Bücher × ${users.length} User`);
  let queued = 0;
  for (const book of books) {
    for (const u of users) {
      if (findActiveJobId('komplett-analyse', book.id, u.email)) {
        logger.info(`Nacht-Analyse: Buch ${book.id} / ${u.email} läuft bereits – überspringe.`);
        continue;
      }
      const label = `Nacht · ${book.name}`;
      const userToken = { id: u.token_id, pw: u.token_pw };
      const jobId = createJob('komplett-analyse', book.id, u.email, label);
      enqueueJob(jobId, () => runKomplettAnalyseJob(jobId, book.id, book.name, u.email, userToken, cronProvider));
      queued++;
    }
  }
  logger.info(`Nacht-Analyse: ${queued} Job(s) in Warteschlange eingereiht.`);
}

// ── Routen ────────────────────────────────────────────────────────────────────
komplettRouter.post('/komplett-analyse', jsonBody, (req, res) => {
  const { book_name } = req.body;
  const book_id = toIntId(req.body?.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  const userEmail = req.session?.user?.email || null;
  const userToken = getTokenForRequest(req);
  const existing = findActiveJobId('komplett-analyse', book_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const label = book_name ? 'job.label.komplettBook' : 'job.label.komplett';
  const labelParams = book_name ? { name: book_name } : null;
  const jobId = createJob('komplett-analyse', book_id, userEmail, label, labelParams);
  enqueueJob(jobId, () => runKomplettAnalyseJob(jobId, book_id, book_name || '', userEmail, userToken));
  res.json({ jobId });
});

komplettRouter.post('/kontinuitaet', jsonBody, (req, res) => {
  const { book_name } = req.body;
  const book_id = toIntId(req.body?.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  const userEmail = req.session?.user?.email || null;
  const userToken = getTokenForRequest(req);
  const existing = findActiveJobId('kontinuitaet', book_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const label = book_name ? 'job.label.kontinuitaetBook' : 'job.label.kontinuitaet';
  const labelParams = book_name ? { name: book_name } : null;
  const jobId = createJob('kontinuitaet', book_id, userEmail, label, labelParams);
  enqueueJob(jobId, () => runKontinuitaetJob(jobId, book_id, book_name || '', userEmail, userToken));
  res.json({ jobId });
});

komplettRouter.get('/kontinuitaet/:book_id', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
  const userEmail = req.session?.user?.email || null;
  const result = getLatestContinuityCheck(bookId, userEmail);
  res.json(result);
});

komplettRouter.delete('/chapter-cache/:book_id', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
  const userEmail = req.session?.user?.email || '';
  const deleted = deleteChapterExtractCache(bookId, userEmail);
  res.json({ ok: true, deleted });
});

module.exports = { komplettRouter, runKomplettAnalyseAll, runKomplettAnalyseJob, runKontinuitaetJob };
