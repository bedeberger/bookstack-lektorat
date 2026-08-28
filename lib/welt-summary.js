'use strict';

// Verdichtet den Welt-Fakten-Index (`world_facts`) zu dem, was eine Buchbewertung
// braucht: eine MESSUNG des Weltaufbaus statt einer Schaetzung.
//
// Die Bewertung urteilt heute ueber den Weltaufbau aus dem Volltext (Single-Pass)
// bzw. aus verdichteten Kapitelanalysen (Multi-Pass) — beides sagt nichts darueber,
// WIE DICHT die Welt ueber den Buchbogen etabliert ist. Der Fakten-Index sagt es:
// welche Kategorien tragen, welche Subjekte sind die Naben, und welche Kapitel
// etablieren gar nichts.
//
// Bewusst pur (kein DB-, kein Prompt-Import), gleiche Begruendung wie bei
// lib/struktur-summary.js: die Zaehlerei ist die Stelle, an der sich Fehler
// verstecken, und sie soll ohne Datenbank testbar sein. Den Datenzugriff macht
// routes/jobs/review-context.js, die Formulierung public/js/prompts/review/context.js.
//
// EINE REGEL TRAEGT DIESES MODUL: ein NICHT erhobener Index (`scanned: false`)
// liefert `null`, nicht „0 Fakten". Sonst liest die Bewertung ein nie gelaufenes
// Extraktions-Verfahren als weltarmes Buch und zieht die Note dafuer.

// Prompt-Bloat-Schutz. Der Block ist Beiwerk — Hauptinput bleibt der Text bzw. die
// Kapitelanalysen.
const MAX_SUBJEKTE   = 10;
const MAX_BEISPIELE  = 12;
const MAX_KAPITEL_OHNE = 10;

function _trunc(s, n) {
  if (!s) return '';
  const t = String(s).trim().replace(/\s+/g, ' ');
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}

function _norm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

/** Drittel des Buchbogens fuer einen 0-basierten Kapitel-Index. */
function _bogenTeil(idx, total) {
  if (total <= 0) return null;
  const r = idx / total;
  if (r < 1 / 3) return 'anfang';
  if (r < 2 / 3) return 'mitte';
  return 'schluss';
}

/**
 * @param {{scanned:boolean, fakten:Array}} welt  Ausgabe von
 *        db/world-facts.js#worldFactsScanState + #listWorldFacts
 *        (fakten: [{ kategorie, subjekt, fakt, kapitel: string[] }])
 * @param {string[]} kapitelNamen  Kapitel in Lesereihenfolge (Scope des Buchs)
 * @returns {object|null} null, wenn der Index nicht erhoben ist oder keinen Fakt
 *                        traegt — dann laesst der Prompt-Builder den Block ganz weg.
 */
function summarizeWorldFacts(welt, kapitelNamen = []) {
  if (!welt || welt.scanned === false) return null;
  const fakten = (Array.isArray(welt.fakten) ? welt.fakten : []).filter(f => f && f.fakt);
  if (!fakten.length) return null;

  const kapitel = (Array.isArray(kapitelNamen) ? kapitelNamen : []).filter(Boolean);
  const idxByKapitel = new Map();
  kapitel.forEach((name, i) => { if (!idxByKapitel.has(_norm(name))) idxByKapitel.set(_norm(name), i); });

  const proKategorie = new Map();
  const proSubjekt = new Map();
  const kapitelMitFakt = new Set();
  const bogen = { anfang: 0, mitte: 0, schluss: 0 };
  let ohneKapitelBezug = 0;

  for (const f of fakten) {
    const kat = f.kategorie || 'sonstiges';
    proKategorie.set(kat, (proKategorie.get(kat) || 0) + 1);

    const subj = String(f.subjekt || '').trim();
    if (subj) {
      const key = _norm(subj);
      if (!proSubjekt.has(key)) proSubjekt.set(key, { subjekt: subj, anzahl: 0 });
      proSubjekt.get(key).anzahl++;
    }

    const kaps = (Array.isArray(f.kapitel) ? f.kapitel : []).filter(Boolean);
    if (!kaps.length) { ohneKapitelBezug++; continue; }
    // Ein Fakt zaehlt in jedem Kapitel, in dem er etabliert wird — aber nur EINMAL
    // je Drittel, sonst blaeht ein kapitelweit wiederholter Fakt den Bogen auf.
    const teile = new Set();
    for (const k of kaps) {
      kapitelMitFakt.add(_norm(k));
      const idx = idxByKapitel.get(_norm(k));
      if (idx != null) {
        const t = _bogenTeil(idx, kapitel.length);
        if (t) teile.add(t);
      }
    }
    for (const t of teile) bogen[t]++;
  }

  const ohneFakten = kapitel.filter(k => !kapitelMitFakt.has(_norm(k)));

  // Beispiele ueber die Kategorien streuen (Round-Robin), damit der Block nicht
  // zwoelf Varianten derselben Kategorie zeigt.
  const byKat = new Map();
  for (const f of fakten) {
    const kat = f.kategorie || 'sonstiges';
    if (!byKat.has(kat)) byKat.set(kat, []);
    byKat.get(kat).push(f);
  }
  const katKeys = [...byKat.keys()].sort((a, b) => (proKategorie.get(b) || 0) - (proKategorie.get(a) || 0));
  const beispiele = [];
  for (let runde = 0; beispiele.length < MAX_BEISPIELE; runde++) {
    let zugriff = false;
    for (const kat of katKeys) {
      const arr = byKat.get(kat);
      if (runde >= arr.length) continue;
      zugriff = true;
      beispiele.push({
        kategorie: kat,
        subjekt: arr[runde].subjekt || null,
        fakt: _trunc(arr[runde].fakt, 160),
      });
      if (beispiele.length >= MAX_BEISPIELE) break;
    }
    if (!zugriff) break;
  }

  return {
    gesamt: fakten.length,
    proKategorie: [...proKategorie.entries()]
      .map(([kategorie, anzahl]) => ({ kategorie, anzahl }))
      .sort((a, b) => b.anzahl - a.anzahl),
    topSubjekte: [...proSubjekt.values()]
      .filter(s => s.anzahl > 1)
      .sort((a, b) => b.anzahl - a.anzahl)
      .slice(0, MAX_SUBJEKTE),
    kapitelAbdeckung: {
      gesamt: kapitel.length,
      mitFakten: kapitel.length - ohneFakten.length,
      ohneFakten: ohneFakten.slice(0, MAX_KAPITEL_OHNE).map(k => _trunc(k, 80)),
      ohneFaktenGekuerzt: Math.max(0, ohneFakten.length - MAX_KAPITEL_OHNE),
    },
    // Fakten, deren Kapitel sich nicht auflösen liess (Single-Pass-Lauf ohne
    // Kapitelbezug) — ausgewiesen, damit der Bogen nicht als vollstaendig gilt.
    ohneKapitelBezug,
    bogen,
    beispiele,
  };
}

module.exports = { summarizeWorldFacts, MAX_SUBJEKTE, MAX_BEISPIELE, MAX_KAPITEL_OHNE };
