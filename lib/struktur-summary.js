'use strict';

// Verdichtet die Ist-Befunde des Struktur-Checks (`page_structure_checks`) zu
// dem, was eine Buch- oder Kapitelbewertung braucht.
//
// Der Struktur-Check prüft EINEN Beitrag gegen den Soll-Katalog seiner Textsorte
// — regelbasiert, deterministisch, mit Status pro Regel. Die Bewertung fragt
// dagegen nach dem Ganzen. Ohne diese Brücke schätzt das Bewertungs-Modell die
// Formtreue der Sammlung, obwohl sie längst gemessen ist.
//
// Bewusst pur (kein DB-, kein Prompt-Import): die Zählerei ist die Stelle, an der
// sich Fehler verstecken, und sie soll ohne Datenbank testbar sein. Den Datenzugriff
// macht routes/jobs/review-context.js, die Formulierung prompts/review.js.

const URTEILE = ['traegt', 'lueckenhaft', 'verfehlt'];
const W_FRAGEN = ['wer', 'was', 'wann', 'wo', 'wie', 'warum'];

// Prompt-Bloat-Schutz. Die Bewertung bekommt ohnehin den Volltext bzw. die
// Kapitelanalysen als Hauptinput — dieser Block ist Beiwerk, kein Bericht.
const MAX_LUECKEN  = 8;
const MAX_SEITEN   = 12;
const MAX_SEITEN_KAPITEL = 20;

/** Sortierung «schlimmste zuerst». */
const URTEIL_RANK = { verfehlt: 0, lueckenhaft: 1, traegt: 2 };

function _trunc(s, n) {
  if (!s) return '';
  const t = String(s).trim().replace(/\s+/g, ' ');
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}

/**
 * @param {Array} checks  Zeilen aus db/textsorte.js#listStructureChecks
 *                        ({ page_id, textsorte, gesamturteil, result })
 * @param {Array} pages   Seiten im Scope, in Lesereihenfolge:
 *                        [{ id, title | name }]
 * @param {{scope?: 'book'|'chapter'}} opts
 * @returns {object|null} null, wenn im Scope kein einziger Befund vorliegt —
 *                        dann lässt der Prompt-Builder den Block ganz weg.
 */
function summarizeStrukturChecks(checks, pages, { scope = 'book' } = {}) {
  const seiten = Array.isArray(pages) ? pages : [];
  const titelById = new Map(seiten.map(p => [Number(p.id), p.title || p.name || '']));
  const imScope = (c) => titelById.has(Number(c.page_id));

  const relevant = (Array.isArray(checks) ? checks : []).filter(c => c && imScope(c) && c.result);
  if (!relevant.length) return null;

  const urteile = { traegt: 0, lueckenhaft: 0, verfehlt: 0 };
  const proTextsorte = new Map();
  const luecken = new Map();   // `${textsorte}|${nr}` → { textsorte, nr, fehlt, teilweise }
  const wFragen = new Map();
  const seitenBefunde = [];

  for (const c of relevant) {
    const urteil = URTEILE.includes(c.gesamturteil) ? c.gesamturteil : null;
    if (urteil) urteile[urteil]++;

    const ts = c.textsorte || 'unbekannt';
    if (!proTextsorte.has(ts)) proTextsorte.set(ts, { textsorte: ts, anzahl: 0, traegt: 0, lueckenhaft: 0, verfehlt: 0 });
    const bucket = proTextsorte.get(ts);
    bucket.anzahl++;
    if (urteil) bucket[urteil]++;

    const maengel = [];
    for (const r of c.result?.regeln || []) {
      if (r?.status !== 'fehlt' && r?.status !== 'teilweise') continue;
      const key = `${ts}|${r.nr}`;
      if (!luecken.has(key)) luecken.set(key, { textsorte: ts, nr: r.nr, fehlt: 0, teilweise: 0 });
      luecken.get(key)[r.status]++;
      maengel.push({ nr: r.nr, status: r.status, befund: _trunc(r.befund, 120) });
    }

    for (const w of c.result?.fehlendeWFragen || []) {
      if (!W_FRAGEN.includes(w)) continue;
      wFragen.set(w, (wFragen.get(w) || 0) + 1);
    }

    // Nur Beiträge mit Befund sind erwähnenswert; ein «traegt» ohne Mängel
    // trägt keine Information, die der Bewertung hilft.
    if (urteil !== 'traegt' || maengel.length) {
      seitenBefunde.push({
        titel: _trunc(titelById.get(Number(c.page_id)), 80),
        textsorte: ts,
        urteil: urteil || '–',
        maengel: maengel.slice(0, scope === 'chapter' ? 4 : 2),
      });
    }
  }

  seitenBefunde.sort((a, b) =>
    (URTEIL_RANK[a.urteil] ?? 3) - (URTEIL_RANK[b.urteil] ?? 3)
    || b.maengel.length - a.maengel.length);

  const maxSeiten = scope === 'chapter' ? MAX_SEITEN_KAPITEL : MAX_SEITEN;

  return {
    scope,
    geprueft: relevant.length,
    gesamt: seiten.length,
    urteile,
    proTextsorte: [...proTextsorte.values()].sort((a, b) => b.anzahl - a.anzahl),
    luecken: [...luecken.values()]
      .sort((a, b) => (b.fehlt * 2 + b.teilweise) - (a.fehlt * 2 + a.teilweise))
      .slice(0, MAX_LUECKEN),
    wFragen: [...wFragen.entries()]
      .map(([frage, anzahl]) => ({ frage, anzahl }))
      .sort((a, b) => b.anzahl - a.anzahl),
    seiten: seitenBefunde.slice(0, maxSeiten),
    // Wie viele auffällige Beiträge der Deckel geschluckt hat — der Prompt weist
    // das aus, statt eine gekürzte Liste als vollständig erscheinen zu lassen.
    seitenGekuerzt: Math.max(0, seitenBefunde.length - maxSeiten),
  };
}

module.exports = { summarizeStrukturChecks, URTEILE, W_FRAGEN };
