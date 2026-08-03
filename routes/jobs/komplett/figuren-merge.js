'use strict';

const { _refToString } = require('./utils');
const { normName: _normalizeName, nameTokens: _nameTokens } = require('../../../lib/name-normalize');
const { figureEvidence } = require('../../../lib/entity-match');

/** Mergt duplizierte Figuren anhand des normalisierten Namens (case-insensitive).
 *  Fängt Fälle ab, in denen kleine Modelle (Ollama/llama) die Dedup-Regel in
 *  Phase 2 nicht befolgen. Verschmilzt Kapitel, Eigenschaften und Beziehungen.
 *  Remappt beziehungen.figur_id auf die kanonische ID und entfernt Selbst-Referenzen.
 *  Zweistufig:
 *    Stufe 1: exakter normalisierter Name (titel-/whitespace-bereinigt).
 *    Stufe 2: Teilname-Match (ein Name ist Teilmenge des anderen) plus mind. 2 Indizien
 *             (Beruf, Geburtsjahr, gemeinsames Kapitel, gleiches Geschlecht, geteilte Beziehung).
 *             Strenger Schutz: verschiedene Vornamen mit gleichem Nachnamen («Paul Schmidt»
 *             vs. «Marta Schmidt») werden NICHT zusammengeführt.
 *  Namens-Normalisierung (_normalizeName/_nameTokens) kommt aus lib/name-normalize. */

/** Fasst zwei Figuren zu einer kanonischen Figur zusammen. `canon` wird mutiert.
 *  Gibt nichts zurück – Caller kümmert sich um idRemap. */
function _arcWeight(a) {
  if (!a || typeof a !== 'object') return 0;
  return (a.anfang ? 1 : 0) + (a.ende ? 1 : 0) + (Array.isArray(a.wendepunkte) ? a.wendepunkte.length : 0);
}

function _mergeFigurInto(canon, other) {
  for (const field of ['kurzname', 'typ', 'geburtstag', 'geschlecht', 'beruf', 'wohnadresse', 'sozialschicht',
                       'aeusseres', 'stimme', 'hintergrund',
                       'rolle', 'motivation', 'konflikt', 'entwicklung', 'erste_erwaehnung', 'praesenz']) {
    if (!canon[field] && other[field]) canon[field] = other[field];
  }
  // Arc: reichere Variante (mehr belegte Stationen) gewinnt.
  if (_arcWeight(other.arc) > _arcWeight(canon.arc)) canon.arc = other.arc;
  if (!canon.beschreibung && other.beschreibung) canon.beschreibung = other.beschreibung;
  const zit = new Set([...(canon.schluesselzitate || []), ...(other.schluesselzitate || [])]);
  canon.schluesselzitate = [...zit].slice(0, 5);
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

/** Indizienpunkte für zwei Figuren. Rechnet `figureEvidence` (SSoT
 *  lib/entity-match.js, geteilt mit dem Cross-Run-Matching) auf der Analyse-Form:
 *  Kapitel liegen hier als [{ name }] vor, Beziehungen als [{ figur_id }].
 *  Positiv wie bisher — und NEU negativ bei widersprüchlichem Geburtsjahr oder
 *  Geschlecht, sodass zwei gleichnamige, aber verschieden datierte Figuren in Stufe 2
 *  nicht mehr verschmelzen. */
function _indicatorScore(a, b) {
  return figureEvidence(
    { ...a, chapters: (a.kapitel || []).map(k => k?.name ?? k), relations: (a.beziehungen || []).map(x => x.figur_id) },
    { ...b, chapters: (b.kapitel || []).map(k => k?.name ?? k), relations: (b.beziehungen || []).map(x => x.figur_id) },
  );
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
      const aInB = ta.every(t => tb.includes(t));
      const bInA = tb.every(t => ta.includes(t));
      if (!aInB && !bInA) continue;
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
  const canonical = new Map();
  const canonicalList = [];
  const merged = chapterFiguren.map(c => ({ kapitel: c.kapitel, figuren: [] }));
  let dupesRemoved = 0;

  for (let ci = 0; ci < chapterFiguren.length; ci++) {
    for (const f of (chapterFiguren[ci].figuren || [])) {
      const key = _normalizeName(f.name);
      if (!key) continue;
      let canon = canonical.get(key);

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
        for (const field of ['kurzname', 'typ', 'geburtstag', 'geschlecht', 'beruf', 'wohnadresse', 'sozialschicht',
                             'aeusseres', 'stimme', 'hintergrund',
                             'rolle', 'motivation', 'konflikt', 'entwicklung', 'erste_erwaehnung', 'praesenz',
                             'beschreibung']) {
          if (!canon[field] && f[field]) canon[field] = f[field];
        }
        if (_arcWeight(f.arc) > _arcWeight(canon.arc)) canon.arc = f.arc;
        const zit = new Set([...(canon.schluesselzitate || []), ...(f.schluesselzitate || [])]);
        canon.schluesselzitate = [...zit].slice(0, 5);
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
      if (currentNames.some(n => text.includes(n))) continue;

      const candidates = allNames.filter(c =>
        c.id !== f.id && c.id !== bz.figur_id && c.names.some(n => text.includes(n))
      );
      if (candidates.length === 1) {
        const target = candidates[0];
        const existing = (f.beziehungen || []).find(x => x.figur_id === target.id);
        if (existing) {
          if (!existing.beschreibung) {
            existing.beschreibung = bz.beschreibung;
            bz.beschreibung = null;
            moved++;
            continue;
          }
        } else {
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

/** Faltet flache Beziehungen aus dem Claude-A2-Pass ({von,zu,typ,machtverhaltnis,
 *  beschreibung,belege}) zurück in figuren[].beziehungen ({figur_id,...} aus Sicht der
 *  «von»-Figur), sodass der Downstream (Soziogramm-Preliminary, saveFigurenToDb) dieselbe
 *  Datenform wie beim kombinierten Extraktions-Call sieht. Filtert ungültige/Selbst-IDs,
 *  dedupliziert pro ungeordnetem Paar, respektiert bereits vorhandene Beziehungen.
 *  Mutiert die Eingabe nicht – gibt eine neue Figurenliste in Originalreihenfolge zurück. */
function mergeBeziehungenIntoFiguren(figuren, flatBz) {
  const byId = new Map(figuren.map(f => [f.id, { ...f, beziehungen: [...(f.beziehungen || [])] }]));
  const seenPair = new Set();
  for (const f of byId.values()) {
    for (const b of f.beziehungen) {
      const [a, c] = f.id < b.figur_id ? [f.id, b.figur_id] : [b.figur_id, f.id];
      seenPair.add(`${a}|${c}`);
    }
  }
  for (const bz of (flatBz || [])) {
    const von = bz?.von, zu = bz?.zu;
    if (!von || !zu || von === zu) continue;
    if (!byId.has(von) || !byId.has(zu)) continue;
    const [a, c] = von < zu ? [von, zu] : [zu, von];
    const key = `${a}|${c}`;
    if (seenPair.has(key)) continue;
    seenPair.add(key);
    byId.get(von).beziehungen.push({
      figur_id: zu,
      typ: bz.typ || 'andere',
      ...(Number.isFinite(bz.machtverhaltnis) ? { machtverhaltnis: bz.machtverhaltnis } : {}),
      ...(bz.beschreibung ? { beschreibung: bz.beschreibung } : {}),
      ...(Array.isArray(bz.belege) && bz.belege.length ? { belege: bz.belege } : {}),
    });
  }
  return figuren.map(f => byId.get(f.id));
}

/** Backfill: Namen, die in Szenen/Events referenziert werden, aber in keiner
 *  konsolidierten Figur auftauchen, werden als Minimal-Figuren angelegt.
 *  Phase-1-Figurenextraktion hat unvollständigen Recall (v.a. Nebenfiguren);
 *  ohne Backfill droppen remapSzenen/remapAssignments diese Namen und der
 *  Charakter existiert gar nicht – obwohl er in Szenen/Orten/Events vorkommt.
 *  Schwelle: ≥2 Vorkommen (mehrere Szenen ODER zusätzlich als Assignment), um
 *  Einmal-Halluzinationen zu filtern. Token-Subset zu einer bestehenden Figur
 *  («Gerold» bei vorhandenem «Gerold Brunner») → kein Backfill, der
 *  Token-Fallback in buildFigNameLookup löst das auf. Mutiert `figuren`
 *  (append) und gibt die Anzahl neu angelegter Figuren zurück. */
const NAME_HAS_LETTER_RE = /\p{L}/u;
function backfillFiguren(figuren, chapterSzenen, chapterAssignments, log) {
  const resolved = new Set();
  const figTokens = [];
  for (const f of figuren) {
    resolved.add(_normalizeName(f.name));
    if (f.kurzname) resolved.add(_normalizeName(f.kurzname));
    const t = _nameTokens(f.name);
    if (t.length) figTokens.push(t);
  }

  const refs = new Map(); // normKey → { display, count }
  const bump = (raw) => {
    const name = _refToString(raw);
    if (!name) return;
    const key = _normalizeName(name);
    if (!key) return;
    const e = refs.get(key) || { display: name, count: 0 };
    e.count++;
    refs.set(key, e);
  };
  for (const { szenen: chSz } of (chapterSzenen || []))
    for (const s of (chSz || []))
      for (const n of (s?.figuren_namen || [])) bump(n);
  for (const { assignments: chAss } of (chapterAssignments || []))
    for (const a of (chAss || [])) bump(a?.figur_name);

  let maxIdx = 0;
  for (const f of figuren) {
    const m = /^fig_(\d+)$/.exec(f.id || '');
    if (m) maxIdx = Math.max(maxIdx, parseInt(m[1], 10));
  }

  let created = 0;
  for (const { display, count } of refs.values()) {
    if (count < 2) continue;
    const key = _normalizeName(display);
    if (resolved.has(key)) continue;
    if (display.length < 2 || !NAME_HAS_LETTER_RE.test(display)) continue;
    const tk = _nameTokens(display);
    if (tk.length && figTokens.some(ft =>
      tk.every(t => ft.includes(t)) || ft.every(t => tk.includes(t)))) continue;
    maxIdx++;
    figuren.push({
      id: 'fig_' + maxIdx,
      name: display,
      typ: 'andere',
      beziehungen: [],
      kapitel: [],
      eigenschaften: [],
    });
    resolved.add(key);
    created++;
    log.info(`Backfill-Figur «${display}» aus Szenen/Events (${count} Vorkommen) – Phase-1 hatte sie ausgelassen.`);
  }
  return created;
}

/** Letzte Absicherung vor saveFigurenToDb gegen das UNIQUE(book_id, fig_id,
 *  user_email): garantiert, dass jede Figur eine eindeutige, nicht-leere `id`
 *  trägt. mergeDuplicateFiguren dedupliziert nur nach Namen – liefert die
 *  Phase-2-Konsolidierung zwei verschieden benannte Figuren mit derselben `id`
 *  (oder kollidiert eine explizite `fig_N` mit einer index-generierten), würden
 *  sonst beide eingefügt und der INSERT bricht ab. Die ERSTE Figur einer ID
 *  behält sie (eingehende beziehungen.figur_id bleiben gültig); jede weitere
 *  Kollision bzw. leere ID bekommt eine frische `fig_<maxIdx+1>`.
 *
 *  **Doppelte Objekt-Referenzen zuerst kollabieren:** liegt dieselbe Figur-Instanz
 *  zweimal im Array (Merge-/Backfill-Pfad teilt versehentlich eine Referenz), würde
 *  die ID-Neuvergabe unten DASSELBE Objekt mutieren – beide Slots blieben identisch
 *  und der INSERT bräche trotzdem mit UNIQUE. Darum werden exakte Referenz-Duplikate
 *  (erste Vorkommen bleibt) vorab entfernt; das ist semantisch korrekt (dieselbe
 *  Figur soll nur einmal gespeichert werden). Mutiert `figuren` (in-place, ggf.
 *  verkürzt) und gibt die Anzahl neu vergebener IDs zurück. */
function ensureUniqueFigIds(figuren, log = null) {
  // Schritt 1: exakte Objekt-Referenz-Duplikate entfernen (erste Position behalten).
  const objSeen = new Set();
  let w = 0;
  for (let r = 0; r < figuren.length; r++) {
    if (objSeen.has(figuren[r])) continue;
    objSeen.add(figuren[r]);
    figuren[w++] = figuren[r];
  }
  figuren.length = w;

  // Schritt 2: eindeutige, nicht-leere id pro (jetzt distinkter) Figur.
  let maxIdx = 0;
  for (const f of figuren) {
    const m = /^fig_(\d+)$/.exec(f.id || '');
    if (m) maxIdx = Math.max(maxIdx, parseInt(m[1], 10));
  }
  const seen = new Set();
  const collidedIds = new Set(); // Original-IDs, die wegen Kollision neu vergeben wurden
  let reassigned = 0;
  for (const f of figuren) {
    if (!f.id || seen.has(f.id)) {
      if (f.id) collidedIds.add(f.id);
      f.id = 'fig_' + (++maxIdx);
      reassigned++;
    }
    seen.add(f.id);
  }
  // Inbound-Ref-Hinweis: zeigt eine beziehungen.figur_id auf eine kollidierte (jetzt
  // mehrdeutige) ID, ist nicht eindeutig entscheidbar, welche Figur gemeint war — die
  // Heuristik «erste behält die ID» kann dann fehl-attribuieren. Kein Datenfehler
  // (dedupRelations + validIds-Filter halten Refs konsistent), aber für die Diagnose
  // protokollieren. Sehr seltener Edge-Case (zwei verschieden benannte Figuren mit
  // identischer ID + eine dritte, die darauf referenziert).
  if (log && collidedIds.size > 0) {
    const affected = figuren.some(f => (f.beziehungen || []).some(b => collidedIds.has(b.figur_id)));
    if (affected) log.warn(`ensureUniqueFigIds: ${collidedIds.size} kollidierte ID(s) mit eingehenden Beziehungs-Refs – mögliche Fehl-Attribution (Heuristik: erste Figur behält ID).`);
  }
  return reassigned;
}

/** Alias-Cluster (F3) auf die (pre-merged) Kapitel-Figuren anwenden: Namensvarianten, die laut
 *  Alias-Pass dieselbe Figur bezeichnen (Epitheta/Spitznamen/Umbenennungen), auf den kanonischen
 *  Namen umschreiben — der Originalname bleibt als kurzname erhalten, falls noch keiner gesetzt
 *  ist. Die nachfolgende KI-Konsolidierung + mergeDuplicateFiguren führen die nun gleichnamigen
 *  Einträge zusammen. Gibt `{ renamed, aliasMap }` zurück; aliasMap (lowercased Alias →
 *  kanonischer Name) geht in buildFigNameLookup, damit Szenen/Events mit dem Alias-Namen weiter
 *  auf die kanonische Figur auflösen (kein Drop). Mutiert die übergebenen figuren in place.
 *  Pure, testbar. */
function applyAliasClusters(chapterFiguren, clusters, log = null) {
  const aliasMap = {};
  for (const c of (clusters || [])) {
    const canon = _refToString(c?.kanonisch);
    if (!canon) continue;
    for (const a of (c?.aliase || [])) {
      const alias = _refToString(a);
      if (!alias || _normalizeName(alias) === _normalizeName(canon)) continue;
      aliasMap[alias.toLowerCase()] = canon;
    }
  }
  if (!Object.keys(aliasMap).length) return { renamed: 0, aliasMap };
  let renamed = 0;
  for (const ch of (chapterFiguren || [])) {
    for (const f of (ch.figuren || [])) {
      const canon = aliasMap[String(f.name || '').toLowerCase()];
      if (canon && canon !== f.name) {
        if (!f.kurzname || f.kurzname === f.name) f.kurzname = f.name;
        f.name = canon;
        renamed++;
      }
    }
  }
  if (renamed && log) log.info(`Alias-Cluster: ${renamed} Figuren-Nennung(en) auf kanonische Namen vereinheitlicht (${Object.keys(aliasMap).length} Aliasse).`);
  return { renamed, aliasMap };
}

module.exports = {
  preMergeChapterFiguren, applySozialschichtModeVote,
  mergeDuplicateFiguren, validateBeziehungenDescriptions,
  mergeBeziehungenIntoFiguren, backfillFiguren, ensureUniqueFigIds,
  applyAliasClusters,
  _normalizeName,
};
