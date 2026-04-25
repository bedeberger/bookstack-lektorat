'use strict';

const { db } = require('../../../../../db/schema');

// Block 26+27+28: book_reviews + chapter_reviews + chat_messages
function buildReviewSamples(ctx) {
  const {
    langIsEn, displayName,
    bookIdInt, userEmail,
    chapterQuestions, pushQA, pickVariants,
  } = ctx;

  // ── Review-basierte Q&A ───────────────────────────────────────────────
  // Nutzt die zuletzt gespeicherte book_reviews.review_json. Feste Fragen
  // pro Feld, weil die Review-Felder bereits in klaren Sätzen vorliegen.
  const reviewRow = db.prepare(
    'SELECT review_json FROM book_reviews WHERE book_id = ? AND user_email = ? ORDER BY reviewed_at DESC LIMIT 1'
  ).get(bookIdInt, userEmail);
  if (reviewRow?.review_json) {
    let r = null;
    try { r = JSON.parse(reviewRow.review_json); } catch { /* ignore */ }
    if (r && typeof r === 'object') {
      const qaFromReview = (suffix, q, a) => pushQA('authorChat|review|' + suffix, q, a);
      if (r.zusammenfassung) {
        qaFromReview('summary',
          langIsEn ? `What is «${displayName}» about?` : `Worum geht es in «${displayName}»?`,
          r.zusammenfassung);
      }
      if (r.themen) {
        qaFromReview('themen',
          langIsEn ? 'What are the main themes?' : 'Was sind die Hauptthemen?',
          typeof r.themen === 'string' ? r.themen : (Array.isArray(r.themen) ? r.themen.join(', ') : ''));
      }
      if (Array.isArray(r.staerken) && r.staerken.length) {
        qaFromReview('staerken',
          langIsEn ? 'What are the strengths of the book?' : 'Was sind die Stärken des Buchs?',
          r.staerken.join(' · '));
      }
      if (Array.isArray(r.schwaechen) && r.schwaechen.length) {
        qaFromReview('schwaechen',
          langIsEn ? 'What would you criticize about the book?' : 'Was würdest du am Buch kritisieren?',
          r.schwaechen.join(' · '));
      }
      if (r.gesamtnote != null && r.gesamtnote_begruendung) {
        qaFromReview('note',
          langIsEn ? 'How would you rate the book overall?' : 'Wie bewertest du das Buch gesamt?',
          `${r.gesamtnote}/6 — ${r.gesamtnote_begruendung}`);
      }
    }
  }

  // ── Kapitel-Reviews ───────────────────────────────────────────────────
  // Neueste pro Kapitel (user+book). Pro Review mehrere Q&A: Zusammenfassung,
  // Fazit, Stärken, Schwächen, Dramaturgie, Pacing, Figuren.
  const chapterReviewRows = db.prepare(`
    SELECT cr1.chapter_name, cr1.review_json
    FROM chapter_reviews cr1
    WHERE cr1.book_id = ? AND cr1.user_email = ?
      AND cr1.reviewed_at = (
        SELECT MAX(cr2.reviewed_at) FROM chapter_reviews cr2
        WHERE cr2.book_id = cr1.book_id AND cr2.chapter_id = cr1.chapter_id AND cr2.user_email = cr1.user_email
      )
  `).all(bookIdInt, userEmail);
  for (const row of chapterReviewRows) {
    const chName = (row.chapter_name || '').trim();
    if (!chName || !row.review_json) continue;
    let cr = null;
    try { cr = JSON.parse(row.review_json); } catch { continue; }
    if (!cr || typeof cr !== 'object') continue;
    // Zusammenfassung als Hauptantwort auf „Was passiert in Kapitel X?"
    if (cr.zusammenfassung) {
      const idxs = pickVariants('chap|' + chName, chapterQuestions, 2);
      for (const idx of idxs) {
        const q = chapterQuestions[idx].replace('{kapitel}', chName);
        pushQA('authorChat|chap|' + chName + '|' + idx, q, cr.zusammenfassung);
      }
    }
    if (cr.fazit) {
      pushQA('authorChat|chap-fazit|' + chName,
        langIsEn ? `What's the takeaway of «${chName}»?` : `Was ist das Fazit zu Kapitel «${chName}»?`,
        cr.fazit);
    }
    if (cr.dramaturgie) {
      pushQA('authorChat|chap-drama|' + chName,
        langIsEn ? `How does «${chName}» build tension?` : `Wie ist «${chName}» dramaturgisch aufgebaut?`,
        cr.dramaturgie);
    }
    if (cr.pacing) {
      pushQA('authorChat|chap-pacing|' + chName,
        langIsEn ? `How is the pacing of «${chName}»?` : `Wie ist das Tempo in «${chName}»?`,
        cr.pacing);
    }
    if (cr.figuren) {
      pushQA('authorChat|chap-fig|' + chName,
        langIsEn ? `Who carries «${chName}»?` : `Welche Figuren tragen «${chName}»?`,
        cr.figuren);
    }
    if (Array.isArray(cr.staerken) && cr.staerken.length) {
      pushQA('authorChat|chap-str|' + chName,
        langIsEn ? `What makes «${chName}» strong?` : `Was macht «${chName}» stark?`,
        cr.staerken.join(' · '));
    }
  }

  // ── Echte Buch-Chat-Messages ──────────────────────────────────────────
  // Consecutive (user, assistant)-Paare aus book-chat-Sessions (page_name
  // = '__book__') direkt übernehmen. Das ist die authentischste Q&A-Quelle.
  const chatRows = db.prepare(`
    SELECT cs.id AS sid, cm.role, cm.content, cm.created_at, cm.id AS mid
    FROM chat_messages cm
    JOIN chat_sessions cs ON cs.id = cm.session_id
    WHERE cs.book_id = ? AND cs.user_email = ? AND cs.page_name = '__book__'
    ORDER BY cs.id, cm.created_at, cm.id
  `).all(bookIdInt, userEmail);
  for (let i = 0; i + 1 < chatRows.length; i++) {
    const a = chatRows[i];
    const b = chatRows[i + 1];
    if (a.sid !== b.sid) continue;
    if (a.role !== 'user' || b.role !== 'assistant') continue;
    const q = (a.content || '').trim();
    const ans = (b.content || '').trim();
    if (q.length < 4 || ans.length < 30) continue;
    pushQA('authorChat|chat|' + a.sid + '|' + a.mid, q, ans);
  }
}

module.exports = { buildReviewSamples };
