'use strict';
// Kapitel-Erzaehlprofil (Komplettanalyse-Phase). Full-Replace pro (Buch,
// User): die Phase regeneriert das gesamte Profil bei jedem Lauf (nur wenn der
// Konsolidierungs-Checkpoint nicht greift). Themen als CASCADE-Kind.

const { db } = require('./connection');
// Prepared Statements dieses Moduls sitzen auf migrierten Spalten — die
// Migrationen muessen vor dem Anlegen gelaufen sein.
require('./migrations');
// Die deklarierte Erzaehlform des Buchs ist der Soll-Wert, gegen den das
// gemessene Profil abweicht — sie kommt aus den Buch-Einstellungen.
const { getBookSettings } = require('./book-settings');
const { NOW_ISO_SQL } = require('./now');

// Full-Replace pro (Buch, User): die Phase regeneriert das gesamte Profil bei jedem
// Lauf (nur wenn der Konsolidierungs-Checkpoint nicht greift). Themen als CASCADE-Kind.
function saveChapterNarrativeProfiles(bookId, userEmail, profiles, chNameToId, figNameToId, declared) {
  const bookIdInt = parseInt(bookId);
  const email = userEmail || null;
  const list = Array.isArray(profiles) ? profiles : [];
  // TEXT-fig_id (KI/Katalog) → INTEGER figures.id (FK-Target).
  const figRows = db.prepare(
    'SELECT id, fig_id FROM figures WHERE book_id = ? AND user_email IS ?'
  ).all(bookIdInt, email);
  const figIdToRowId = Object.fromEntries(figRows.map(r => [r.fig_id, r.id]));
  // Soll-Erzählform aus book_settings (Keys, nicht Labels). 'gemischt' ist als Soll
  // absichtlich tolerant → dann nie als Abweichung werten (jeder Wechsel erlaubt).
  const declaredP = declared?.erzaehlperspektive || null;
  const declaredT = declared?.erzaehlzeit || null;
  let saved = 0;
  db.transaction(() => {
    db.prepare('DELETE FROM chapter_narrative_profile WHERE book_id = ? AND user_email IS ?').run(bookIdInt, email);
    const insP = db.prepare(`INSERT INTO chapter_narrative_profile
      (book_id, user_email, chapter_id, perspektive, erzaehlzeit, erzaehler_figur_id, erzaehler_figur,
       pov_konfidenz, pov_beleg, pov_abweichung, intensitaet, intensitaet_begruendung, zusammenfassung, sort_order, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL})`);
    const insT = db.prepare(
      'INSERT INTO chapter_narrative_themes (profile_id, thema, typ, belege, sort_order) VALUES (?, ?, ?, ?, ?)'
    );
    list.forEach((p, i) => {
      const chId = (p.kapitel != null && chNameToId?.[p.kapitel] != null) ? chNameToId[p.kapitel] : null;
      const figName = p.erzaehler_figur ? String(p.erzaehler_figur).trim() : '';
      const figTextId = figName ? (figNameToId?.[figName] || null) : null;
      const figRowId = figTextId ? (figIdToRowId[figTextId] ?? null) : null;
      const persp = p.perspektive || null;
      const zeit  = p.erzaehlzeit || null;
      // Abweichung nur bei deklariertem, nicht-'gemischt'-Soll und abweichendem Ist.
      let abw = 0;
      if (declaredP && declaredP !== 'gemischt' && persp && persp !== declaredP) abw = 1;
      if (declaredT && declaredT !== 'gemischt' && zeit && zeit !== declaredT) abw = 1;
      const konf  = (typeof p.pov_konfidenz === 'number' && isFinite(p.pov_konfidenz))
        ? Math.max(0, Math.min(1, p.pov_konfidenz)) : null;
      const inten = Number.isFinite(p.intensitaet)
        ? Math.max(1, Math.min(5, Math.round(p.intensitaet))) : null;
      // Klarnamen-Fallback nur speichern, wenn keine FK aufgelöst werden konnte
      // (Snapshot-Vermeidung – aufgelöste Namen kommen zur Lesezeit per JOIN).
      const { lastInsertRowid: pid } = insP.run(
        bookIdInt, email, chId, persp, zeit, figRowId, figRowId ? null : (figName || null),
        konf, p.pov_beleg || null, abw, inten, p.intensitaet_begruendung || null, p.zusammenfassung || null, i,
      );
      const themen = Array.isArray(p.themen) ? p.themen : [];
      themen.forEach((t, j) => {
        const thema = (t && typeof t === 'object') ? (t.thema || '') : String(t || '');
        const trimmed = String(thema).trim();
        if (!trimmed) return;
        // belege: Array wörtlicher Zitate → JSON. Legacy-Einzelstring (t.beleg)
        // wird tolerant ins Array gehoben. Leeres/kein Beleg → NULL.
        const rawBelege = (t && typeof t === 'object')
          ? (Array.isArray(t.belege) ? t.belege : (t.beleg != null ? [t.beleg] : []))
          : [];
        const belegeArr = rawBelege.map(b => String(b || '').trim()).filter(Boolean);
        const belege = belegeArr.length ? JSON.stringify(belegeArr) : null;
        insT.run(pid, trimmed, (t && typeof t === 'object' && t.typ) || null, belege, j);
      });
      saved++;
    });
  })();
  return saved;
}

/** Liest das aktuelle Kapitel-Erzählprofil eines Buchs (inkl. Themen + deklarierter
 *  Soll-Erzählform für den Abweichungs-Abgleich in der Karte). */
function getChapterNarrativeProfile(bookId, userEmail) {
  const bookIdInt = parseInt(bookId);
  const email = userEmail || null;
  const rows = db.prepare(`
    SELECT p.id, p.chapter_id, c.chapter_name, p.perspektive, p.erzaehlzeit,
           p.erzaehler_figur_id, f.name AS erzaehler_figur_name, p.erzaehler_figur,
           p.pov_konfidenz, p.pov_beleg, p.pov_abweichung, p.intensitaet,
           p.intensitaet_begruendung, p.zusammenfassung, p.sort_order, p.updated_at
      FROM chapter_narrative_profile p
      LEFT JOIN chapters c ON c.chapter_id = p.chapter_id
      LEFT JOIN figures  f ON f.id = p.erzaehler_figur_id
     WHERE p.book_id = ? AND p.user_email IS ?
     ORDER BY p.sort_order, p.id
  `).all(bookIdInt, email);
  const bs = getBookSettings(bookIdInt, email);
  const declared = { erzaehlperspektive: bs?.erzaehlperspektive || null, erzaehlzeit: bs?.erzaehlzeit || null };
  if (!rows.length) return { chapters: [], declared, updated_at: null };
  const themeRows = db.prepare(`
    SELECT profile_id, thema, typ, belege FROM chapter_narrative_themes
     WHERE profile_id IN (SELECT id FROM chapter_narrative_profile WHERE book_id = ? AND user_email IS ?)
     ORDER BY profile_id, sort_order, id
  `).all(bookIdInt, email);
  const parseBelege = (raw) => {
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.map(b => String(b || '').trim()).filter(Boolean) : [];
    } catch { return String(raw).trim() ? [String(raw).trim()] : []; }
  };
  const byPid = new Map();
  for (const t of themeRows) {
    if (!byPid.has(t.profile_id)) byPid.set(t.profile_id, []);
    byPid.get(t.profile_id).push({ thema: t.thema, typ: t.typ, belege: parseBelege(t.belege) });
  }
  // Abweichung zur Lese-Zeit aus der aktuellen Soll-Erzählform berechnen (statt aus
  // dem beim Lauf gespeicherten Flag) — so bleibt die Anzeige korrekt, auch wenn der
  // Autor die Soll-Perspektive/-zeit nach dem Analyselauf ändert, und Perspektiv- vs.
  // Tempus-Abweichung sind getrennt. 'gemischt' als Soll ist tolerant (nie Abweichung).
  const deviates = (soll, ist) => !!(soll && soll !== 'gemischt' && ist && ist !== soll);
  const chapters = rows.map(r => ({
    chapter_id: r.chapter_id,
    kapitel: r.chapter_name || null,
    perspektive: r.perspektive,
    erzaehlzeit: r.erzaehlzeit,
    erzaehler_figur_id: r.erzaehler_figur_id,
    erzaehler_figur: r.erzaehler_figur_name || r.erzaehler_figur || null,
    pov_konfidenz: r.pov_konfidenz,
    pov_beleg: r.pov_beleg,
    pov_abweichung: deviates(declared.erzaehlperspektive, r.perspektive),
    tempus_abweichung: deviates(declared.erzaehlzeit, r.erzaehlzeit),
    intensitaet: r.intensitaet,
    intensitaet_begruendung: r.intensitaet_begruendung,
    zusammenfassung: r.zusammenfassung,
    themen: byPid.get(r.id) || [],
  }));
  return { chapters, declared, updated_at: rows[0]?.updated_at || null };
}

module.exports = {
  saveChapterNarrativeProfiles,
  getChapterNarrativeProfile,
};
