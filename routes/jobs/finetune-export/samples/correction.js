'use strict';

const { db } = require('../../../../db/schema');

function buildCorrectionSamples(ctx) {
  const {
    samples, counts, opts, langIsEn, unifiedSys,
    bookIdInt, userEmail,
  } = ctx;
  const { maxChars } = opts;

  // Lektor-Persona absichtlich entfernt: Korrekturen fliessen mit unifiedSys
  // ein, sodass die korrigierte Fassung als Autor-Prosa gelernt wird, nicht
  // als Lektor-Output. Task-Hinweis steckt im User-Prefix.
  const userPrefix    = langIsEn
    ? 'Rewrite this sentence in the author\'s style:\n\n'
    : 'Formuliere diesen Satz im Stil des Autors um:\n\n';
  const reasonedUser  = langIsEn
    ? 'Rewrite this sentence in the author\'s style and explain the change in one sentence:\n\n'
    : 'Formuliere diesen Satz im Stil des Autors um und erkläre die Änderung in einem Satz:\n\n';
  const reasonLabel   = langIsEn ? 'Reason: ' : 'Grund: ';

  // Neueste-First, damit bei mehrfach geprüften Seiten die aktuellste Korrektur
  // den Dedupe-Slot gewinnt (gleich-hashende Paare später ignoriert).
  const checkRows = db.prepare(`
    SELECT errors_json FROM page_checks
    WHERE book_id = ? AND user_email = ? AND errors_json IS NOT NULL AND error_count > 0
    ORDER BY checked_at DESC
  `).all(bookIdInt, userEmail);
  const seen = new Set();
  for (const row of checkRows) {
    let errs = null;
    try { errs = JSON.parse(row.errors_json); } catch { continue; }
    if (!Array.isArray(errs)) continue;
    for (const e of errs) {
      const orig = (e.original || '').trim();
      const korr = (e.korrektur || '').trim();
      if (orig.length < 8 || korr.length < 5) continue;
      if (orig.toLowerCase() === korr.toLowerCase()) continue;
      if (orig.length > maxChars || korr.length > maxChars) continue;
      const key = orig + '→' + korr;
      if (seen.has(key)) continue;
      seen.add(key);
      const idx = seen.size;
      // Base-Variante: nur verbesserter Satz als Antwort.
      samples.push({
        id: 'correction|a|' + idx,
        type: 'correction',
        messages: [
          { role: 'system', content: unifiedSys },
          { role: 'user',   content: userPrefix + orig },
          { role: 'assistant', content: korr },
        ],
      });
      counts.correction++;
      // Reasoned-Variante (nur wenn Begründung vorhanden): verbesserter Satz
      // + kurze Begründung. Trainiert ein Warum-Signal mit, ohne Basis-Antworten
      // mit Reasoning zu verwässern.
      const erkl = (e.erklaerung || '').trim();
      if (erkl.length >= 15 && erkl.length <= 400) {
        samples.push({
          id: 'correction|b|' + idx,
          type: 'correction',
          messages: [
            { role: 'system', content: unifiedSys },
            { role: 'user',   content: reasonedUser + orig },
            { role: 'assistant', content: korr + '\n\n' + reasonLabel + erkl },
          ],
        });
        counts.correction++;
      }
    }
  }
}

module.exports = { buildCorrectionSamples };
