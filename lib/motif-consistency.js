'use strict';
// Motiv-Konsistenz — deterministische Schicht (Messung, KEIN callAI).
//
// Prueft die vom Autor gezogenen Motiv-zu-Motiv-Kanten (`motif_relations`) gegen
// den Ist-Index (`motif_occurrences`, aggregiert als occChapters im Graph-Payload).
// Eine Kante behauptet etwas ueber das Verhaeltnis zweier Motive IM TEXT — ob die
// Behauptung mit der gemessenen Verteilung zusammenpasst, ist rechenbar und
// braucht kein Modell. Was ein Modell beurteilen muesste (traegt die Beziehung
// inhaltlich? sind zwei Motive in Wahrheit dasselbe?), steht bewusst NICHT hier.
//
// Reine Funktionen, kein DB-/Netz-Zugriff — Aufrufer reicht den Graph-Payload
// (db/motifs.js#getGraph) und die Kapitel-Lesereihenfolge herein.

// Kuratierte Kanten-Typen mit ihrer Erwartungs-Familie. `motif_relations.typ` ist
// serverseitig Freitext (analog figure_relations); nur diese Schluessel tragen eine
// pruefbare Erwartung. Ein unbekannter Typ wird NICHT interpretiert — er faellt aus
// der Messung heraus (und bleibt der KI-Schicht ueberlassen), statt geraten zu werden.
//   gleichlauf — die beiden Motive sollen gemeinsam tragen (Kapitel-Ueberlappung)
//   spannung   — sie sollen sich reiben, was Beruehrung VORAUSSETZT (ein Kontrast,
//                der nie im selben Kapitel stattfindet, ist keiner)
const MOTIF_REL_TYPES = ['verstaerkt', 'spiegelt', 'bedingt', 'kontrastiert', 'bricht', 'verdraengt'];
const MOTIF_REL_FAMILY = {
  verstaerkt: 'gleichlauf',
  spiegelt: 'gleichlauf',
  bedingt: 'gleichlauf',
  kontrastiert: 'spannung',
  bricht: 'spannung',
  verdraengt: 'spannung',
};

function relFamily(typ) {
  return MOTIF_REL_FAMILY[String(typ || '').trim()] || null;
}

// Schwellen. Bewusst Konstanten und keine App-Settings: sie sind Teil der Aussage
// des Befunds, nicht eine Betriebsgroesse — wer sie verstellt, aendert was
// „Gleichlauf" heisst, und das gehoert in einen Commit, nicht in ein Formular.
const OVERLAP_MIN = 0.34;     // Anteil gemeinsamer Kapitel am schmaleren Motiv
const HUB_MIN_EDGES = 3;      // ab so vielen Kanten gilt ein Motiv als Nabe
const HUB_MIN_MOTIFS = 6;     // Quartil-Vergleich erst ab so vielen belegten Motiven
const ARC_MIN_CHAPTERS = 6;   // Bogen-Abbruch erst bei genug Kapiteln pruefen
const ARC_MIN_HITS = 3;       // … und erst ab so vielen Fundstellen (sonst Rauschen)
const ARC_HEAD_SHARE = 1 / 3; // „nur im vorderen Drittel des Buchbogens"

const SEVERITY_ORDER = ['kritisch', 'stark', 'mittel', 'schwach', 'niedrig'];

// Kapitel-Menge eines Motivs (Ist). occChapters kommt aus getGraph als
// [{ chapterId, n }] — Fundstellen ohne aufloesbares Kapitel sind dort schon raus.
function _chapterSet(motif) {
  return new Set((motif.occChapters || []).map(o => o.chapterId));
}

function _intersect(a, b) {
  let n = 0;
  for (const id of a) if (b.has(id)) n++;
  return n;
}

// 25%-Quantil einer Zahlenliste (nearest-rank, keine Interpolation — der Wert soll
// eine tatsaechlich vorkommende Fundstellenzahl sein, keine Rechengroesse).
function _q1(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.25) - 1)];
}

function _finding(code, schwere, motif, extra = {}) {
  return {
    code,
    quelle: 'messung',
    schwere,
    motiv_id: motif.id,
    motiv: motif.name,
    relation_id: null,
    partner_id: null,
    partner: null,
    typ: null,
    ...extra,
  };
}

// Hauptfunktion. Liefert die Befunde sortiert (Schwere, dann Motivname).
//
// scanned=false (Ist-Index leer) ist KEIN Grund, alles als „kommt nicht vor" zu
// melden: ungescannt heisst ungeprueft, nicht abwesend. Dann bleiben nur die
// Befunde uebrig, die ohne Ist-Daten auskommen — derzeit keiner, also eine leere
// Liste. Gleiches Muster wie der Verankerungs-Kontext des Plot-Checks.
function computeMotifFindings({ motifs = [], relations = [], chapterOrder = [], scanned = true } = {}) {
  if (!scanned) return [];

  const byId = new Map(motifs.map(m => [m.id, m]));
  const chapterPos = new Map(chapterOrder.map((id, i) => [id, i]));
  const findings = [];

  // Kantengrad je Motiv (beide Richtungen — eine Nabe ist eine Nabe, egal wohin
  // die Pfeile zeigen).
  const degree = new Map();
  for (const r of relations) {
    for (const id of [r.from_motif_id, r.to_motif_id]) degree.set(id, (degree.get(id) || 0) + 1);
  }

  // ── Kanten-Befunde ─────────────────────────────────────────────────────────
  for (const r of relations) {
    const from = byId.get(r.from_motif_id);
    const to = byId.get(r.to_motif_id);
    if (!from || !to) continue;
    const base = { relation_id: r.id, partner_id: to.id, partner: to.name, typ: r.typ };

    // Geist-Nachbar: die Kante zeigt auf ein Motiv, das im Text nirgends vorkommt.
    // Gilt fuer JEDEN Typ (auch Freitext) — dafuer braucht es keine Erwartung an
    // die Verteilung, nur die Zahl 0.
    if (!(to.occurrenceCount > 0)) {
      findings.push(_finding('geistNachbar', 'stark', from, base));
      continue; // Verteilungsvergleich waere gegen eine leere Menge sinnlos
    }
    if (!(from.occurrenceCount > 0)) continue; // von einem Geist aus nichts messen

    const fam = relFamily(r.typ);
    if (!fam) continue; // unbekannter Typ: nicht interpretieren

    const setFrom = _chapterSet(from);
    const setTo = _chapterSet(to);
    if (!setFrom.size || !setTo.size) continue; // Fundstellen ohne Kapitelbezug
    const shared = _intersect(setFrom, setTo);
    const smaller = Math.min(setFrom.size, setTo.size);

    if (fam === 'spannung' && shared === 0) {
      findings.push(_finding('kontrastOhneBeruehrung', 'stark', from, { ...base, params: { kapitelFrom: setFrom.size, kapitelTo: setTo.size } }));
    } else if (fam === 'gleichlauf' && shared / smaller < OVERLAP_MIN) {
      findings.push(_finding('gleichlaufOhneDeckung', 'mittel', from, { ...base, params: { shared, smaller } }));
    }
  }

  // ── Motiv-Befunde ──────────────────────────────────────────────────────────
  const belegt = motifs.filter(m => m.occurrenceCount > 0);
  const q1 = belegt.length >= HUB_MIN_MOTIFS ? _q1(belegt.map(m => m.occurrenceCount)) : null;

  for (const m of motifs) {
    const grad = degree.get(m.id) || 0;

    // Nabe ohne Substanz: viel verknuepft, im Text kaum da. Der Geist-Fall (0
    // Fundstellen) ist schon ueber die Kanten gemeldet und faellt hier raus.
    if (q1 != null && grad >= HUB_MIN_EDGES && m.occurrenceCount > 0 && m.occurrenceCount <= q1) {
      findings.push(_finding('nabeOhneSubstanz', 'mittel', m, { params: { kanten: grad, fundstellen: m.occurrenceCount } }));
    }

    // Soll-Ist-Divergenz: der Autor hat das Motiv Kapiteln zugeordnet, gefunden
    // wird es aber in keinem davon. Nur pruefbar, wenn beide Seiten befuellt sind.
    const soll = new Set((m.chapters || []).map(c => c.id));
    const ist = _chapterSet(m);
    if (soll.size && ist.size && _intersect(soll, ist) === 0) {
      findings.push(_finding('sollIstDivergenz', 'mittel', m, { params: { soll: soll.size, ist: ist.size } }));
    }

    // Abbruch im Bogen: alles im vorderen Drittel, danach nichts mehr — bei einem
    // Motiv, das laut Kanten das Gefuege mittraegt.
    if (grad >= 1 && m.occurrenceCount >= ARC_MIN_HITS && chapterOrder.length >= ARC_MIN_CHAPTERS && ist.size) {
      const positions = [...ist].map(id => chapterPos.get(id)).filter(p => p != null);
      if (positions.length) {
        const last = Math.max(...positions);
        if (last < chapterOrder.length * ARC_HEAD_SHARE) {
          findings.push(_finding('abbruchImBogen', 'schwach', m, {
            params: { letztesKapitel: last + 1, kapitelGesamt: chapterOrder.length, fundstellen: m.occurrenceCount },
          }));
        }
      }
    }
  }

  findings.sort((a, b) => {
    const s = SEVERITY_ORDER.indexOf(a.schwere) - SEVERITY_ORDER.indexOf(b.schwere);
    return s !== 0 ? s : String(a.motiv).localeCompare(String(b.motiv));
  });
  return findings;
}

module.exports = {
  MOTIF_REL_TYPES, MOTIF_REL_FAMILY, relFamily, computeMotifFindings,
  SEVERITY_ORDER, OVERLAP_MIN, HUB_MIN_EDGES, ARC_HEAD_SHARE,
};
