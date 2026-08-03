'use strict';
// Entitäten-Matching der Komplettanalyse — pure SSoT für Figuren, Schauplätze und
// Szenen. Konsumenten: Cross-Run-Reconcile (db/figures.js#saveFigurenToDb,
// db/schema.js#saveOrteToDb, routes/jobs/komplett/remap.js#saveSzenenAndEvents),
// Within-Run-Dedup (routes/jobs/komplett/phases/orte.js) und die Match-Planung des
// Jobs (routes/jobs/komplett/entity-reconcile.js).
//
// Liegt in lib/, weil db/ und routes/ darauf zugreifen, ohne eine Layering-Inversion
// (db/ → routes/) einzuführen.
//
// ── Das Modell: drei Verdikte, nicht zwei ────────────────────────────────────
// Ein Namensvergleich kann nur drei Dinge sagen: sicher dieselbe Entität, sicher
// nicht, oder «sieht ähnlich aus». Früher gab es nur ja/nein — mit der Folge, dass
// der Graubereich per Schwellenwert in eine der beiden Schubladen fiel und dabei
// systematisch falsch lag:
//   «Restaurant Kreuz (Olten)» ~ «Restaurant Kreuz (Bern)» → Jaccard 0.5 → gemergt
//   «Bahnhof» ⊂ «Bahnhof (Solothurn)» → 0.95 → gemergt, und weil greedy der erste
//   Kandidat gewinnt, willkürlich an Solothurn ODER Bern
//   «Schulhaus Frohheim» ~ «Frohheim-Schule Olten» → 0 → zwei Dubletten
// Darum jetzt: `SAME` nur bei starkem Signal, `DIFFERENT` bei echtem Widerspruch,
// alles andere `UNSURE` — und Unsicherheit führt NIE zu einem stillen Merge. Die
// unsicheren Paare beurteilt der KI-Judge (routes/jobs/komplett/entity-reconcile.js);
// bleibt er aus (kein Claude, Setting aus, Call gescheitert), bleiben sie getrennt.
// Ein verpasster Merge kostet einen Handgriff im Zusammenführen-Panel, ein falscher
// verschmilzt zwei echte Entitäten unwiederbringlich.
//
// ── Zwei Signalquellen ───────────────────────────────────────────────────────
// 1. NAME (`*Similarity`): Token-Vergleich. Neu ist der **Qualifizierer-Blocker** —
//    ein Zusatz in Klammern oder nach dem Komma ist kein Token wie jedes andere,
//    sondern genau die Unterscheidung, die der Autor gemeint hat. Tragen beide Namen
//    einen und sind die Zusätze disjunkt, sind es verschiedene Entitäten.
// 2. INDIZIEN (`*Evidence`): was die Entitäten sonst teilen — Kapitel, Figuren, Seite,
//    Land, Koordinaten, Geburtsjahr. Auch NEGATIV: verschiedene Länder oder
//    Geburtsjahre sind ein Widerspruch, nicht bloss ein fehlendes Plus. Figuren hatten
//    das (unvollständig) schon, Orte und Szenen gar nicht — das war das eigentliche
//    Loch: sie wurden ausschliesslich nach ihrem Namen beurteilt.

const { normName: _normNameRaw, nameTokens: _nameTokensRaw } = require('./name-normalize');

// Verbindungswörter/Artikel in Ortsnamen, die als Token kein Diskriminator sind.
const LOC_STOPWORDS = new Set([
  'und', 'in', 'an', 'am', 'im', 'bei', 'zur', 'zum', 'auf', 'der', 'die', 'das',
  'den', 'dem', 'von', 'vom', 'zu', 'de', 'la', 'le', 'of', 'the', 'at',
]);

// Verdikt eines Paarvergleichs. `UNSURE` ist der Normalfall im Graubereich und
// bedeutet: nicht automatisch mergen, dem Judge vorlegen.
const SAME = 'same';
const UNSURE = 'unsure';
const DIFFERENT = 'different';

// Tokenisierung ist der innere Schleifenkörper des Matchings: bei 300 Bestands- ×
// 300 neuen Einträgen fallen ~90 000 Paarvergleiche an, jeder mit mehreren
// Zerlegungen derselben paar hundert Namen. Darum ein kleiner Namens-Cache mit
// Deckel (Namen sind kurzlebig pro Lauf, ein unbegrenzter Cache wäre ein Leck).
const _TOK_CACHE_MAX = 4000;
const _tokCache = new Map();
function _cached(key, compute) {
  const hit = _tokCache.get(key);
  if (hit !== undefined) return hit;
  const val = compute();
  if (_tokCache.size >= _TOK_CACHE_MAX) _tokCache.clear();
  _tokCache.set(key, val);
  return val;
}

// Bedeutungstragende Ortsnamen-Token: Klammern/Slashes/Satzzeichen entfernt,
// lowercased, Stopwords + Ein-Zeichen-Token raus. «Mathys AG (Bettlach)» →
// [mathys, ag, bettlach]; «EPA / Nordmann Solothurn» → [epa, nordmann, solothurn].
function placeTokens(name) {
  return _cached('p:' + name, () => _placeTokens(name));
}
function _placeTokens(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[()[\]{}/,;:«»"']/g, ' ')
    .split(/[\s\-.]+/)
    .map(t => t.trim())
    .filter(t => t.length > 1 && !LOC_STOPWORDS.has(t));
}

// Normalisierter Ortsname (exakt-Match-Schlüssel) — SSoT für Orte/Szenen-Matching.
function normLocName(s) {
  return String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

// Qualifizierer abspalten: der Zusatz in Klammern bzw. nach dem ersten Komma.
// «Restaurant Kreuz (Olten)» → { head: [restaurant, kreuz], qualifier: [olten] }
// «Wohnung Brunner, Olten»   → { head: [wohnung, brunner],  qualifier: [olten] }
// Ohne Zusatz ist `qualifier` leer — dann greift der Blocker nicht (ein Name ohne
// Zusatz widerspricht keinem Zusatz, er ist nur unspezifischer).
const _QUALIFIER_RE = /[([{]([^)\]}]*)[)\]}]/g;
function splitQualifier(name) {
  return _cached('q:' + name, () => _splitQualifier(name));
}
function _splitQualifier(name) {
  const raw = String(name || '');
  const qualParts = [];
  let head = raw.replace(_QUALIFIER_RE, (_, inner) => { qualParts.push(inner); return ' '; });
  const comma = head.indexOf(',');
  if (comma >= 0) {
    qualParts.push(head.slice(comma + 1));
    head = head.slice(0, comma);
  }
  return {
    head: placeTokens(head),
    qualifier: placeTokens(qualParts.join(' ')),
  };
}

function _inter(a, b) { return a.filter(t => b.includes(t)); }
function _isSubset(a, b) { return a.length > 0 && a.every(t => b.includes(t)); }

// Iterable (Array/Set, Zahlen oder Strings) → Set normalisierter Strings.
// Ergebnis pro Quell-Objekt gecacht: `_planMatches` vergleicht jedes neue mit jedem
// bestehenden Element, und dieselbe `chapters`-Liste geht dabei hunderte Mal durch —
// ohne Cache baut der Indizien-Score bei 300×300 Einträgen 180 000 Sets.
const _setCache = new WeakMap();
function _setOf(v) {
  if (v && typeof v === 'object') {
    const hit = _setCache.get(v);
    if (hit) return hit;
    const built = _buildSet(v);
    _setCache.set(v, built);
    return built;
  }
  return _buildSet(v);
}
function _buildSet(v) {
  const out = new Set();
  for (const x of (v || [])) {
    const s = typeof x === 'object' && x ? (x.name ?? x.id ?? '') : x;
    const k = String(s ?? '').trim().toLowerCase();
    if (k) out.add(k);
  }
  return out;
}
function _shareAny(a, b) {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

// Grobe Distanz in km (Äquirektangular-Näherung — für «gleicher Ort?» genügt das,
// eine Haversine-Formel wäre hier Scheingenauigkeit).
function _roughKm(aLat, aLng, bLat, bLng) {
  const dLat = (aLat - bLat) * 111;
  const dLng = (aLng - bLng) * 111 * Math.cos(((aLat + bLat) / 2) * Math.PI / 180);
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

// Gecachte Figuren-Namensformen (dieselbe Begründung wie bei placeTokens: der
// Paarvergleich ruft sie quadratisch oft auf denselben paar hundert Namen).
function normName(v) { return _cached('n:' + v, () => _normNameRaw(v)); }
function nameTokens(v) { return _cached('t:' + v, () => _nameTokensRaw(v)); }

// ── Schauplätze ──────────────────────────────────────────────────────────────

// Namens-Ähnlichkeit zweier Orte, 0..1 (0 = sicher verschieden).
// Typ-Gate: klar verschiedene Typen (STADT vs. GEBAEUDE) sind nie derselbe Ort.
// Qualifizierer-Blocker: «Kreuz (Olten)» vs. «Kreuz (Bern)» → 0.
// Token-Teilmenge mit ≥2 geteilten Token → 0.95 («Mathys AG (Bettlach)» ⊂ «Mathys AG
// Produktionsstätte Bettlach»). Teilmenge mit nur EINEM geteilten Token → 0.7: ein
// unspezifischer Name («Bahnhof») ist Teilmenge jeder qualifizierten Variante und darf
// deshalb nicht allein aufgrund des Namens zugeordnet werden.
// Sonst Jaccard-Overlap ≥ threshold mit ≥2 gemeinsamen Token.
const SIM_SUBSET_STRONG = 0.95;
const SIM_SUBSET_THIN = 0.7;
function _locSim(a, b, { overlapThreshold = 0.5 } = {}) {
  const ta = (a.typ || '').toString().toLowerCase();
  const tb = (b.typ || '').toString().toLowerCase();
  if (ta && tb && ta !== tb && ta !== 'andere' && tb !== 'andere') return { sim: 0, shared: 0 };
  const qa = splitQualifier(a.name), qb = splitQualifier(b.name);
  if (qa.qualifier.length && qb.qualifier.length && !_inter(qa.qualifier, qb.qualifier).length) {
    return { sim: 0, shared: 0 };
  }
  const A = placeTokens(a.name), B = placeTokens(b.name);
  if (!A.length || !B.length) return { sim: 0, shared: 0 };
  const shared = _inter(A, B).length;
  if (!shared) return { sim: 0, shared: 0 };
  if (_isSubset(A, B) || _isSubset(B, A)) {
    return { sim: shared >= 2 ? SIM_SUBSET_STRONG : SIM_SUBSET_THIN, shared };
  }
  const union = new Set([...A, ...B]).size;
  const jac = shared / union;
  if (shared >= 2 && jac >= overlapThreshold) return { sim: jac, shared };
  return { sim: 0, shared };
}
function locationSimilarity(a, b, opts = {}) {
  return _locSim(a, b, opts).sim;
}

// Indizien-Punkte zweier Orte. Positiv = spricht für dieselbe Entität, negativ =
// Widerspruch. Erwartet optional `chapters`/`figures` (Iterables) sowie
// `land`/`lat`/`lng`; fehlende Felder zählen neutral (nicht negativ).
function locationEvidence(a, b) {
  let score = 0;
  if (_shareAny(_setOf(a.chapters), _setOf(b.chapters))) score += 1;
  if (_shareAny(_setOf(a.figures), _setOf(b.figures))) score += 1;
  const la = (a.land || '').toString().toLowerCase();
  const lb = (b.land || '').toString().toLowerCase();
  if (la && lb) score += (la === lb) ? 1 : -3;
  const hasA = a.lat != null && a.lng != null;
  const hasB = b.lat != null && b.lng != null;
  if (hasA && hasB) {
    const km = _roughKm(Number(a.lat), Number(a.lng), Number(b.lat), Number(b.lng));
    if (km <= 2) score += 2;
    else if (km >= 25) score -= 3;
  }
  return score;
}

function scoreLocationPair(a, b, opts = {}) {
  const { sim, shared } = _locSim(a, b, opts);
  const evidence = locationEvidence(a, b);
  if (!sim) {
    // Kein tragfähiges Namenssignal. `shared === 0` heisst: Typ-Gate,
    // Qualifizierer-Konflikt oder kein gemeinsames Token — sicher verschieden.
    // Bleibt EIN gemeinsames Token übrig («Schulhaus Frohheim» / «Frohheim-Schule
    // Olten») und sprechen die Indizien deutlich dafür, ist es ein Verdachtsfall,
    // keine Entscheidung: solche Paare gingen bisher als zwei Dubletten durch.
    // Nie SAME — ob zwei ähnlich benannte Gebäude dasselbe sind, kann nur der Text
    // sagen, also der Judge.
    if (shared >= 1 && evidence >= 2) return { sim: 0.2, shared, evidence, verdict: UNSURE };
    return { sim: 0, shared: 0, evidence: 0, verdict: DIFFERENT };
  }
  if (evidence <= -3) return { sim, shared, evidence, verdict: DIFFERENT };
  if (sim >= SIM_SUBSET_STRONG && shared >= 2) return { sim, shared, evidence, verdict: SAME };
  if (sim >= 0.5 && shared >= 2 && evidence >= 2) return { sim, shared, evidence, verdict: SAME };
  return { sim, shared, evidence, verdict: UNSURE };
}

// ── Szenen ───────────────────────────────────────────────────────────────────

// Szenen-Titel-Token (analog placeTokens — Titel sind Freitext, nur Satzzeichen +
// Stopwords raus). «Ankunft in Olten» → [ankunft, olten].
function sceneTitleTokens(titel) {
  return placeTokens(titel);
}

function _chapOf(s) { return s.chapterId ?? s.chapter_id ?? 0; }
function _pageOf(s) { return s.pageId ?? s.page_id ?? null; }

// Indizien zweier Szenen. Die Seite ist das stärkste Signal: `figure_scenes.page_id`
// verortet die Szene auf EINER Seite — dieselbe Seite spricht klar für dieselbe Szene,
// verschiedene Seiten dagegen (schwach, weil die Extraktion die Seite pro Lauf neu rät).
function sceneEvidence(a, b) {
  let score = 0;
  const pa = _pageOf(a), pb = _pageOf(b);
  if (pa != null && pb != null) score += (String(pa) === String(pb)) ? 2 : -1;
  const fa = _setOf(a.figures), fb = _setOf(b.figures);
  if (fa.size && fb.size) score += _shareAny(fa, fb) ? 1 : -1;
  if (_shareAny(_setOf(a.locations), _setOf(b.locations))) score += 1;
  return score;
}

// Szenen-Paar. Kapitel ist ein hartes Gate (eine Szene wandert nicht in ein anderes
// Kapitel — täte sie es, ist sie für den Reconcile eine neue Szene). Overlap ohne
// Teilmenge wird bewusst NICHT automatisch gemergt: Szenen sind zahlreich, ein
// Fehlmatch verschmilzt zwei echte Szenen.
function scoreScenePair(a, b) {
  if (String(_chapOf(a)) !== String(_chapOf(b))) {
    return { sim: 0, shared: 0, evidence: 0, verdict: DIFFERENT };
  }
  const evidence = sceneEvidence(a, b);
  if (normLocName(a.titel) === normLocName(b.titel) && normLocName(a.titel)) {
    return { sim: 1, shared: 0, evidence, verdict: SAME };
  }
  const A = sceneTitleTokens(a.titel), B = sceneTitleTokens(b.titel);
  if (!A.length || !B.length) return { sim: 0, shared: 0, evidence, verdict: DIFFERENT };
  const shared = _inter(A, B).length;
  if (!shared) {
    // Völlig verschiedene Titel auf derselben Seite («Der Streit» / «Auseinandersetzung
    // am Küchentisch»): das Modell hat die Szene im zweiten Lauf anders benannt. Kein
    // Namenssignal, aber ein starkes Indiz → Verdachtsfall statt stille Dublette.
    if (evidence >= 2) return { sim: 0.2, shared: 0, evidence, verdict: UNSURE };
    return { sim: 0, shared: 0, evidence, verdict: DIFFERENT };
  }
  const subset = _isSubset(A, B) || _isSubset(B, A);
  if (subset && shared >= 2) return { sim: SIM_SUBSET_STRONG, shared, evidence, verdict: SAME };
  if (subset && evidence >= 2) return { sim: SIM_SUBSET_THIN, shared, evidence, verdict: SAME };
  const union = new Set([...A, ...B]).size;
  return { sim: shared / union, shared, evidence, verdict: UNSURE };
}

// ── Figuren ──────────────────────────────────────────────────────────────────

// Indizien zweier Figuren. Positiv wie bisher (Beruf, Geburtsjahr, Kapitel, Geschlecht,
// Typ, geteilte Beziehung), NEU auch negativ: zwei gesetzte, verschiedene Geburtsjahre
// bzw. Geschlechter sind ein Widerspruch — bisher zählten sie schlicht nicht mit, und
// «Anna Meier» (1943) konnte mit «Anna Meier» (1978) verschmelzen.
function figureEvidence(a, b) {
  let score = 0;
  const ba = (a.beruf || '').toString().toLowerCase().trim();
  const bb = (b.beruf || '').toString().toLowerCase().trim();
  if (ba && bb && ba === bb) score += 1;
  if (a.geburtstag && b.geburtstag) score += (a.geburtstag === b.geburtstag) ? 2 : -3;
  if (_shareAny(_setOf(a.chapters), _setOf(b.chapters))) score += 1;
  const ga = (a.geschlecht || '').toString().toLowerCase();
  const gb = (b.geschlecht || '').toString().toLowerCase();
  if (ga && gb && ga !== 'unbekannt' && gb !== 'unbekannt') score += (ga === gb) ? 1 : -3;
  if (a.typ && b.typ && a.typ === b.typ && a.typ !== 'andere') score += 1;
  if (_shareAny(_setOf(a.relations), _setOf(b.relations))) score += 2;
  return score;
}

// Figuren-Paar. Namensstufen wie bisher (exakt → Token-Teilmenge → Rename-Fallback),
// aber der Graubereich fällt nicht mehr durch: Teilmenge mit schwachen Indizien und
// «anderer Name, mittlere Indizien» werden UNSURE statt stillschweigend verworfen bzw.
// gemergt. Verschiedene Vornamen mit gleichem Nachnamen («Paul Schmidt» / «Marta
// Schmidt») haben disjunkte Token → keine Teilmenge → nur der Rename-Fallback greift,
// und der verlangt Indizien ≥ 3.
function scoreFigurePair(a, b) {
  const evidence = figureEvidence(a, b);
  const na = normName(a.name), nb = normName(b.name);
  if (na && na === nb) return { sim: 1, shared: 0, evidence, verdict: SAME };
  if (evidence <= -2) return { sim: 0, shared: 0, evidence, verdict: DIFFERENT };
  const A = nameTokens(a.name), B = nameTokens(b.name);
  const shared = (A.length && B.length) ? _inter(A, B).length : 0;
  const subset = A.length && B.length && (_isSubset(A, B) || _isSubset(B, A));
  if (subset) {
    return evidence >= 2
      ? { sim: SIM_SUBSET_STRONG, shared, evidence, verdict: SAME }
      : { sim: SIM_SUBSET_THIN, shared, evidence, verdict: UNSURE };
  }
  if (evidence >= 3) return { sim: 0.5, shared, evidence, verdict: SAME };
  if (evidence >= 2) return { sim: 0.4, shared, evidence, verdict: UNSURE };
  return { sim: 0, shared, evidence, verdict: DIFFERENT };
}

// ── Match-Planung (Cross-Run) ────────────────────────────────────────────────
//
// Gemeinsamer Kern für alle drei Gattungen. Liefert
//   { matchOf: Map(incomingIndex → existingId), unsure: [{ index, existingId, … }] }
// Zwei Regeln, die vorher fehlten:
//   * AMBIGUITÄT ⇒ KEIN MERGE. Sind zwei Bestands-Zeilen gleich gute Kandidaten
//     (identisches sim UND evidence), war das Ergebnis vorher die Reihenfolge des
//     Arrays. Jetzt landet der Fall bei `unsure`.
//   * Ein `hint` (vom Judge bestätigtes Paar) schlägt alles. Er kommt aus dem Job,
//     weil eine DB-Schreibfunktion keinen KI-Call machen darf (harte Regel).
function _planMatches(existing, incoming, { score, keyOf, hint = null }) {
  const matchOf = new Map();
  const used = new Set();
  const unsure = [];

  // Stufe 0: bestätigte Paare aus dem Judge.
  if (hint && hint.size) {
    for (let i = 0; i < incoming.length; i++) {
      const exId = hint.get(keyOf(incoming[i]));
      if (exId == null || used.has(exId)) continue;
      if (!existing.some(ex => ex.id === exId)) continue;
      matchOf.set(i, exId);
      used.add(exId);
    }
  }

  // Stufe 1: eindeutig gleiche Paare, stärkstes Signal zuerst. Über alle
  // (incoming × existing)-Paare global sortiert, damit nicht die Array-Reihenfolge
  // entscheidet, welcher Kandidat eine Bestands-Zeile zuerst beansprucht.
  const cands = [];
  for (let i = 0; i < incoming.length; i++) {
    if (matchOf.has(i)) continue;
    for (const ex of existing) {
      const r = score(ex, incoming[i]);
      if (r.verdict === DIFFERENT) continue;
      cands.push({ i, exId: ex.id, ...r });
    }
  }
  cands.sort((x, y) => (y.sim - x.sim) || (y.evidence - x.evidence));

  const sameCands = cands.filter(c => c.verdict === SAME);
  const blocked = new Set();   // Incomings, deren stärkster Kandidat ambig war
  for (const c of sameCands) {
    if (matchOf.has(c.i) || used.has(c.exId) || blocked.has(c.i)) continue;
    // Ambiguität: eine zweite, gleich starke Bestands-Zeile für dasselbe Incoming.
    // Dann entscheidet niemand automatisch — und auch kein schwächerer Kandidat
    // desselben Incomings darf einspringen (die Liste ist nach Stärke sortiert,
    // der Gleichstand steht also an der Spitze). Darum den Index sperren.
    const rival = sameCands.find(o => o.i === c.i && o.exId !== c.exId
      && !used.has(o.exId) && o.sim === c.sim && o.evidence === c.evidence);
    if (rival) {
      blocked.add(c.i);
      unsure.push({ index: c.i, existingId: c.exId, sim: c.sim, evidence: c.evidence, reason: 'ambiguous' });
      unsure.push({ index: c.i, existingId: rival.exId, sim: rival.sim, evidence: rival.evidence, reason: 'ambiguous' });
      continue;
    }
    matchOf.set(c.i, c.exId);
    used.add(c.exId);
  }

  // Stufe 2: Graubereich sammeln — nur für Incomings ohne Match und Bestands-Zeilen,
  // die niemand beansprucht hat. Alles andere ist entschieden.
  for (const c of cands) {
    if (c.verdict !== UNSURE) continue;
    if (matchOf.has(c.i) || used.has(c.exId)) continue;
    unsure.push({ index: c.i, existingId: c.exId, sim: c.sim, evidence: c.evidence, reason: 'grey' });
  }
  return { matchOf, unsure };
}

// Hint-Schlüssel pro Gattung — dieselbe Funktion auf Job- und Schreibseite, sonst
// treffen sich Plan und Ausführung nicht.
function locationHintKey(o) { return String(o?.id ?? ''); }
function figureHintKey(f) { return String(f?.id ?? ''); }
function sceneHintKey(s) { return `${normLocName(s?.titel)}|${_chapOf(s || {})}`; }

// Cross-Run-Matching Orte. existing: [{ id, name, typ, land?, lat?, lng?, chapters?,
// figures? }], incoming: [{ id?, name, typ, … }]. Stufe 1 exakter normalisierter Name
// (billig und eindeutig), danach der gemeinsame Planer.
function matchLocations(existing, incoming, opts = {}) {
  const exByNorm = new Map();
  for (const ex of existing) {
    const k = normLocName(ex.name);
    if (k && !exByNorm.has(k)) exByNorm.set(k, ex);
  }
  const preset = new Map();
  const takenExact = new Set();
  for (let i = 0; i < incoming.length; i++) {
    const ex = exByNorm.get(normLocName(incoming[i].name));
    if (ex && !takenExact.has(ex.id)) { preset.set(i, ex.id); takenExact.add(ex.id); }
  }
  const rest = incoming.map((o, i) => (preset.has(i) ? null : { o, i })).filter(Boolean);
  const restExisting = existing.filter(ex => !takenExact.has(ex.id));
  const plan = _planMatches(restExisting, rest.map(r => r.o), {
    score: scoreLocationPair, keyOf: locationHintKey, hint: opts.hint || null,
  });
  const matchOf = new Map(preset);
  for (const [ri, exId] of plan.matchOf) matchOf.set(rest[ri].i, exId);
  const unsure = plan.unsure.map(u => ({ ...u, index: rest[u.index].i }));
  return { matchOf, unsure };
}

// Cross-Run-Matching Szenen: pro Kapitel gebucketet. Das Kapitel ist bereits Gate in
// `scoreScenePair` — der Bucket hier ist nur dessen Effizienz-Variante: Szenen sind die
// zahlreichste Gattung, und ein globaler O(n·m)-Vergleich über alle Kapitel würde bei
// grossen Büchern hunderttausende Paare bewerten, die das Gate ohnehin verwirft.
function matchScenes(existing, incoming, opts = {}) {
  const hint = opts.hint || null;
  const byChap = new Map();
  for (const ex of existing) {
    const c = String(_chapOf(ex));
    if (!byChap.has(c)) byChap.set(c, []);
    byChap.get(c).push(ex);
  }
  const idxByChap = new Map();
  for (let i = 0; i < incoming.length; i++) {
    const c = String(_chapOf(incoming[i]));
    if (!idxByChap.has(c)) idxByChap.set(c, []);
    idxByChap.get(c).push(i);
  }
  const matchOf = new Map();
  const unsure = [];
  for (const [c, idxs] of idxByChap) {
    const exBucket = byChap.get(c) || [];
    if (!exBucket.length) continue;
    const plan = _planMatches(exBucket, idxs.map(i => incoming[i]), {
      score: scoreScenePair, keyOf: sceneHintKey, hint,
    });
    for (const [bi, exId] of plan.matchOf) matchOf.set(idxs[bi], exId);
    for (const u of plan.unsure) unsure.push({ ...u, index: idxs[u.index] });
  }
  return { matchOf, unsure };
}

// Cross-Run-Matching Figuren.
function matchFiguren(existing, incoming, opts = {}) {
  return _planMatches(existing, incoming, {
    score: scoreFigurePair, keyOf: figureHintKey, hint: opts.hint || null,
  });
}

// ── Within-Run-Dedup ─────────────────────────────────────────────────────────

// Verschmilzt Varianten desselben Orts INNERHALB eines Laufs (die Completeness-Gap-
// Pässe ziehen Schreibvarianten nach). Konservativ: nur bei Verdikt SAME — ein
// Within-Run-Merge verliert einen Eintrag wirklich. Union von figuren/kapitel; die
// reichste beschreibung/stimmung gewinnt. Gibt { orte, unsure } zurück: die unsicheren
// Paare gehen an den Judge, statt still als Dublette zu bleiben.
function dedupeLocationsWithinRun(orte) {
  const kept = [];
  const unsure = [];
  for (const o of (orte || [])) {
    let target = null;
    for (const k of kept) {
      const r = scoreLocationPair(k, o);
      if (r.verdict === SAME) { target = k; break; }
      if (r.verdict === UNSURE) unsure.push({ a: k.name, b: o.name, sim: r.sim, evidence: r.evidence });
    }
    if (!target) { kept.push({ ...o }); continue; }
    const figs = new Set([...(target.figuren_namen || []), ...(o.figuren_namen || [])]);
    target.figuren_namen = [...figs];
    const kap = new Map();
    for (const src of [target.kapitel, o.kapitel]) {
      for (const k of (src || [])) {
        const name = typeof k === 'object' && k ? k.name : k;
        if (name && !kap.has(name)) kap.set(name, k);
      }
    }
    if (kap.size) target.kapitel = [...kap.values()];
    if ((o.beschreibung || '').length > (target.beschreibung || '').length) target.beschreibung = o.beschreibung;
    if (!target.stimmung && o.stimmung) target.stimmung = o.stimmung;
    // Längeren, spezifischeren Namen bevorzugen (mehr Qualifizierer).
    if (String(o.name || '').length > String(target.name || '').length) target.name = o.name;
  }
  return { orte: kept, unsure };
}

// Within-Run-Dedup Szenen. Bisher gab es hier NUR den exakten `titel|kapitel`-
// Schlüssel im Gap-Pass — zwei Titel-Varianten derselben Szene aus zwei Pässen
// landeten als zwei Szenen und beim nächsten Lauf als stale-Dublette. Konservativ
// (Verdikt SAME, also Kapitel gleich + Titel-Teilmenge bzw. Indizien); der reichere
// Eintrag (Kommentar/Wertung/Figuren) gewinnt.
function dedupeScenesWithinRun(szenen) {
  const kept = [];
  const unsure = [];
  for (const s of (szenen || [])) {
    let target = null;
    for (const k of kept) {
      const r = scoreScenePair(k, s);
      if (r.verdict === SAME) { target = k; break; }
      if (r.verdict === UNSURE) unsure.push({ a: k.titel, b: s.titel, sim: r.sim, evidence: r.evidence });
    }
    if (!target) { kept.push({ ...s }); continue; }
    const figs = new Set([...(target.figuren_namen || []), ...(s.figuren_namen || [])]);
    if (figs.size) target.figuren_namen = [...figs];
    const orte = new Set([...(target.orte_namen || []), ...(s.orte_namen || [])]);
    if (orte.size) target.orte_namen = [...orte];
    if ((s.kommentar || '').length > (target.kommentar || '').length) target.kommentar = s.kommentar;
    if (!target.wertung && s.wertung) target.wertung = s.wertung;
    if (!target.seite && s.seite) target.seite = s.seite;
    if (String(s.titel || '').length > String(target.titel || '').length) target.titel = s.titel;
  }
  return { szenen: kept, unsure };
}

module.exports = {
  SAME, UNSURE, DIFFERENT,
  LOC_STOPWORDS, placeTokens, normLocName, splitQualifier,
  locationSimilarity, locationEvidence, scoreLocationPair,
  sceneTitleTokens, sceneEvidence, scoreScenePair,
  figureEvidence, scoreFigurePair,
  matchLocations, matchScenes, matchFiguren,
  locationHintKey, sceneHintKey, figureHintKey,
  dedupeLocationsWithinRun, dedupeScenesWithinRun,
};
