'use strict';
// Text-to-Speech-Proxy (self-hosted) — „Proof-Listening" (Gegenstueck zum
// STT-Diktat). Frontend liest im Notebook-Editor den Seitentext satzweise vor:
// pro Satz ein POST /tts/speak; die Synthese selbst laeuft ueber den geteilten
// Kern lib/tts-synth.js (Host/Model/Voice/Key aus app_settings, Forward an einen
// OpenAI-kompatiblen Speech-Endpunkt). Die Audio-Bytes werden 1:1 ans Frontend
// durchgereicht (kein Persistieren). Credentials/Host verlassen den Server nie.
//
// Dritte Sync-Proxy-Ausnahme zur Job-Queue-Regel (analog routes/stt.js und
// routes/languagetool.js): kurzer Request/Response-Synthesecall, kein
// KI-Analysejob, kein Token-Budget, kein callAI. TTS liest verbatim vor —
// keine generative KI.
//
// Denselben Synthese-Kern nutzt die public, token-skopierte Vorlese-Route im
// Share-Reader (routes/share/reader.js, POST /share/:token/tts) — dort ohne
// Session, mit Token-Scope statt Auth-Guard.
//
// Disabled / no-Host -> 404 { error: 'tts_disabled' } (Frontend behandelt als
// "Feature aus", der Vorlese-Button ist ohnehin nicht im DOM).

const express = require('express');
const logger = require('../logger');
const { toIntId } = require('../lib/validate');
const { setContext } = require('../lib/log-context');
const { getBookLocale } = require('../db/schema');
const tts = require('../lib/tts-synth');
const { sessionEmail } = require('../lib/acl');

const router = express.Router();

router.post('/speak', express.json({ limit: tts.TEXT_MAX + 2048 }), async (req, res) => {
  const bookId = toIntId(req.query.bookId);
  const pageId = toIntId(req.query.pageId);
  if (bookId) setContext({ book: bookId });
  const userEmail = sessionEmail(req);
  const log = logger.child({ job: 'tts', user: userEmail || '-', book: bookId || '-' });

  // Stimme locale-aware: die Buch-Locale gewinnt (SSoT wie bei STT die Sprache).
  // Ohne Buchscope greift der Default. Region wird im Kern abgeschnitten.
  let lang = '';
  if (bookId) {
    try { lang = getBookLocale(bookId, userEmail) || ''; } catch { /* noop */ }
  }

  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  const ctx = `page=${pageId || '-'} chars=${text.trim().length}`;
  try {
    const { buf, mime, bytes, latency } = await tts.synthesizeSpeech({ text, lang });
    log.info(`ok ${ctx} bytes=${bytes} ${latency}ms`);
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'no-store');
    return res.end(buf);
  } catch (err) {
    if (err instanceof tts.TtsError) {
      if (err.status >= 500 || err.status === 408) {
        log.warn(`${err.code} ${ctx} status=${err.status} latency=${err.latency || 0}ms`);
      }
      const body = { error: err.code };
      if (err.max) body.max = err.max;
      if (err.upstream_status) body.upstream_status = err.upstream_status;
      return res.status(err.status).json(body);
    }
    log.warn(`unexpected ${err?.message} ${ctx}`);
    return res.status(502).json({ error: 'tts_upstream' });
  }
});

module.exports = router;
