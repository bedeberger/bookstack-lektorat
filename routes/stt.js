'use strict';
// Speech-to-Text-Proxy (self-hosted).
// Frontend nimmt im Notebook-Editor an Sprechpausen (browserseitiges VAD) ein
// Audiosegment auf und POSTet es an /stt/transcribe; Server holt Host/Model/
// Key aus app_settings und forwarded an einen OpenAI-kompatiblen Whisper-
// Endpunkt `${host}/v1/audio/transcriptions`. Credentials/Host verlassen den
// Server nie.
//
// Sync-Proxy-Ausnahme zur Job-Queue-Regel (analog routes/languagetool.js):
// kurzer Request/Response-Transkriptionscall, kein KI-Analysejob, kein
// Token-Budget, kein callAI. STT transkribiert 1:1 — keine generative KI.
//
// Disabled / no-Host -> 404 { error: 'stt_disabled' } (Frontend behandelt als
// "Feature aus", Button ist ohnehin nicht im DOM).
//
// Audio kommt als rohes Binary (express.raw) mit dem MediaRecorder-Mime im
// Content-Type — keine Multipart-Dep noetig. Server baut daraus die Multipart-
// FormData an den Whisper-Endpunkt (file mit korrekter Extension, model,
// language). Audio wird nur durchgereicht, nie persistiert, nie geloggt
// (nur Metadaten: Segmentgroesse, Latenz, Upstream-Status).

const express = require('express');
const logger = require('../logger');
const appSettings = require('../lib/app-settings');
const { toIntId } = require('../lib/validate');
const { setContext } = require('../lib/log-context');
const { getBookLocale } = require('../db/schema');
const { sessionEmail } = require('../lib/acl');

const router = express.Router();
const AUDIO_MAX = 5 * 1024 * 1024; // 5 MB — kurze VAD-Segmente
const UPSTREAM_TIMEOUT_DEFAULT_MS = 30_000;
const UPSTREAM_TIMEOUT_MIN_MS = 5_000;
const UPSTREAM_TIMEOUT_MAX_MS = 120_000;

// Upstream-Timeout aus App-Setting (self-hosted tunebar). Grosszuegig genug,
// damit ein GPU-Cold-Start (Modell-Reload nach Idle) nicht als Timeout das
// Segment verliert. Geclampt gegen Fehlkonfiguration.
function upstreamTimeoutMs() {
  const v = Number(appSettings.get('stt.upstream_timeout_ms'));
  if (!Number.isFinite(v)) return UPSTREAM_TIMEOUT_DEFAULT_MS;
  return Math.min(Math.max(v, UPSTREAM_TIMEOUT_MIN_MS), UPSTREAM_TIMEOUT_MAX_MS);
}

// Whitelist erlaubter Audio-Mimes → Datei-Extension fuer den Forward. Der
// ffmpeg-basierte Whisper-Endpunkt dekodiert anhand der Extension/Mime.
const MIME_EXT = {
  'audio/webm': 'webm',
  'audio/ogg':  'ogg',
  'audio/mp4':  'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac':  'aac',
  'audio/wav':  'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mpeg': 'mp3',
};

// Content-Type kann Codec-Parameter tragen ("audio/webm;codecs=opus") — nur
// den Basis-Mime fuer die Whitelist heranziehen.
function baseMime(contentType) {
  return String(contentType || '').split(';')[0].trim().toLowerCase();
}

const rawAudioBody = express.raw({ type: ['audio/*', 'application/octet-stream'], limit: AUDIO_MAX + 1 });

router.post('/transcribe', rawAudioBody, async (req, res) => {
  const enabled = appSettings.get('stt.enabled') === true;
  const host = String(appSettings.get('stt.host') || '').replace(/\/+$/, '').replace(/\/v1$/i, '');
  if (!enabled || !host) {
    return res.status(404).json({ error: 'stt_disabled' });
  }

  const bookId = toIntId(req.query.bookId);
  const pageId = toIntId(req.query.pageId);
  if (bookId) setContext({ book: bookId });
  const userEmail = sessionEmail(req);
  const mime = baseMime(req.headers['content-type']);
  const log = logger.child({ job: 'stt', user: userEmail || '-', book: bookId || '-' });
  const ctx = `page=${pageId || '-'} mime=${mime || '-'} bytes=${Buffer.isBuffer(req.body) ? req.body.length : 0}`;

  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    log.warn(`reject no-audio ${ctx}`);
    return res.status(400).json({ error: 'stt_no_audio' });
  }
  if (req.body.length > AUDIO_MAX) {
    log.warn(`reject too-large ${ctx} max=${AUDIO_MAX}`);
    return res.status(413).json({ error: 'stt_audio_too_large', max: AUDIO_MAX });
  }

  const ext = MIME_EXT[mime];
  if (!ext) {
    log.warn(`reject unsupported-mime ${ctx}`);
    return res.status(415).json({ error: 'stt_unsupported_audio' });
  }

  // Book ist SSoT fuer Locale: bookId vorhanden -> getBookLocale gewinnt.
  // stt.language nur Fallback (Aufrufe ohne Buchscope). Whisper erwartet einen
  // ISO-639-1-Code (de/en), keine Region — Locale wie "de-CH" auf "de" kuerzen.
  let language = '';
  if (bookId) {
    try { language = getBookLocale(bookId, userEmail) || ''; } catch { /* noop */ }
  }
  if (!language) language = String(appSettings.get('stt.language') || '');
  language = language.split('-')[0].trim().toLowerCase();

  const model = String(appSettings.get('stt.model') || '').trim();
  const apiKey = String(appSettings.get('stt.api_key') || '').trim();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), upstreamTimeoutMs());
  const t0 = Date.now();
  try {
    const form = new FormData();
    form.append('file', new Blob([req.body], { type: mime }), `segment.${ext}`);
    if (model) form.append('model', model);
    if (language) form.append('language', language);
    form.append('response_format', 'json');
    // Sampling-Temperatur (App-Setting, Default 0 = deterministisch, weniger
    // Halluzinationen bei stillen/unklaren Segmenten).
    const temperature = Number(appSettings.get('stt.temperature'));
    form.append('temperature', String(Number.isFinite(temperature) ? temperature : 0));

    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
    const upstream = await fetch(`${host}/v1/audio/transcriptions`, {
      method: 'POST',
      headers,
      body: form,
      signal: ctrl.signal,
    });
    if (!upstream.ok) {
      log.warn(`upstream ${upstream.status} ${ctx} latency=${Date.now() - t0}ms`);
      return res.status(502).json({ error: 'stt_upstream', upstream_status: upstream.status });
    }
    const json = await upstream.json().catch(() => null);
    const text = typeof json?.text === 'string' ? json.text : '';
    // Leeres Resultat (Stille/VAD-Fehltrigger/Whisper-Guard) als eigenen Marker —
    // sonst nicht von einem echten Treffer unterscheidbar.
    log.info(`${text.length ? 'ok' : 'empty'} ${ctx} lang=${language || '-'} chars=${text.length} ${Date.now() - t0}ms`);
    return res.json({ text });
  } catch (err) {
    const isAbort = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
    log.warn(`fetch ${isAbort ? 'TIMEOUT' : err.message} ${ctx} latency=${Date.now() - t0}ms`);
    return res.status(isAbort ? 408 : 502).json({ error: isAbort ? 'stt_timeout' : 'stt_upstream' });
  } finally {
    clearTimeout(timer);
  }
});

module.exports = router;
