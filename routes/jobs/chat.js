'use strict';
// Chat-Job-Router — Facade über routes/jobs/chat/. Drei Chats teilen den
// gemeinsamen POST-Handler + das Storage-Modell, laufen aber als getrennte
// Job-Typen (siehe docs/chats.md).
//
//   chat/shared.js    — Antwort-Parsing, _handleChatPost, Buch-Chat-Seiten-Cache.
//   chat/page-chat.js — Seiten-Chat (kind='page', vorschlaege-Envelope).
//   chat/book-chat.js — Buch-Chat (kind='book', klassisch + agentisch + Dispatch).
//   ../research-chat  — Recherche-Chat (kind='research', Claude-only, Web-Suche).

const express = require('express');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const { jsonBody } = require('./shared');
const { _handleChatPost, bookPageCache, invalidateBookPageCache } = require('./chat/shared');
const { runChatJob } = require('./chat/page-chat');
const { runBookChatJobDispatch } = require('./chat/book-chat');
const { runResearchChatJob } = require('./research-chat');
const { sessionEmail } = require('../../lib/acl');

const chatRouter = express.Router();

chatRouter.post('/chat', jsonBody, (req, res) => _handleChatPost(req, res, {
  jobType: 'chat',
  // book_name aus books-Tabelle (Mig 77), page_name via pages-JOIN (Mig 78).
  sessionSelect: `SELECT cs.id, cs.book_id, p.page_name, b.name AS book_name
                  FROM chat_sessions cs
                  LEFT JOIN books b ON b.book_id = cs.book_id
                  LEFT JOIN pages p ON p.page_id = cs.page_id
                  WHERE cs.id = ? AND cs.user_email = ?`,
  labelFn: s => s.page_name
    ? { key: 'job.label.chatPage', params: { name: s.page_name } }
    : { key: 'job.label.chat', params: null },
  runFn: runChatJob,
}));

chatRouter.post('/book-chat', jsonBody, (req, res) => _handleChatPost(req, res, {
  jobType: 'book-chat',
  sessionSelect: `SELECT cs.id, cs.book_id, b.name AS book_name
                  FROM chat_sessions cs
                  LEFT JOIN books b ON b.book_id = cs.book_id
                  WHERE cs.id = ? AND cs.user_email = ?`,
  labelFn: s => s.book_name
    ? { key: 'job.label.bookChatBook', params: { name: s.book_name } }
    : { key: 'job.label.bookChat', params: null },
  runFn: runBookChatJobDispatch,
}));

chatRouter.post('/research-chat', jsonBody, (req, res) => _handleChatPost(req, res, {
  jobType: 'research-chat',
  sessionSelect: `SELECT cs.id, cs.book_id, b.name AS book_name
                  FROM chat_sessions cs
                  LEFT JOIN books b ON b.book_id = cs.book_id
                  WHERE cs.id = ? AND cs.user_email = ? AND cs.kind = 'research'`,
  labelFn: s => s.book_name
    ? { key: 'job.label.researchChatBook', params: { name: s.book_name } }
    : { key: 'job.label.researchChat', params: null },
  runFn: runResearchChatJob,
}));

chatRouter.delete('/book-chat-cache', (req, res) => {
  const book_id = toIntId(req.query.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: book_id });
  const { requireBookAccess, sendACLError } = require('../../lib/acl');
  try { requireBookAccess(req, book_id, 'editor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }
  const userEmail = sessionEmail(req);
  const key = `${book_id}:${userEmail}`;
  bookPageCache.delete(key);
  res.json({ ok: true });
});

module.exports = { chatRouter, invalidateBookPageCache };
