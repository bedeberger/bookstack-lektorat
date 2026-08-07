'use strict';
// Interview-Transkription: eine ganze Aufnahme an den self-hosted Whisper-
// Endpunkt schicken und Segmente mit Zeitmarken (und, wenn das Backend sie
// liefert, Sprechern) zurueckbekommen.
//
// ABGRENZUNG ZUM DIKTAT (routes/stt.js): dort geht ein Sprechpausen-Segment von
// wenigen Sekunden synchron durch und der Text landet am Cursor. Hier geht eine
// Aufnahme von einer Stunde durch, das dauert Minuten, und darum laeuft es als
// Job. Beide sprechen denselben Endpunkt `${host}/v1/audio/transcriptions` an,
// aber mit anderem `response_format`: das Diktat will `json` (nur Text), die
// Transkription `verbose_json` (Segmente mit `start`/`end`).
//
// SPRECHERTRENNUNG IST BACKEND-ABHAENGIG, und diese Datei tut nicht so, als
// waere sie es nicht. Reines faster-whisper kennt keine Sprecher; WhisperX,
// whisper-diarization und einige speaches-Builds liefern pro Segment ein
// `speaker`-Feld, wenn man `diarize=true` mitschickt. Wir schicken die Bitte mit
// und WERTEN AUS, WAS KOMMT:
//   - Segmente mit `speaker`            → Sprechertrennung, `diarisiert = true`
//   - Segmente ohne                     → ein Sprecher, `diarisiert = false`
// Kein Fallback, der Sprecherwechsel aus Sprechpausen RAET. Eine erfundene
// Sprecherzuordnung im Interview ist schlimmer als gar keine: sie legt einer
// Person Saetze in den Mund, die eine andere gesagt hat. Wer Trennung braucht,
// stellt ein Backend hin, das sie kann; wer keins hat, benennt den einen
// Sprecher-Block von Hand um.

const appSettings = require('./app-settings');

// Grosszuegiger Deckel: eine Stunde Gespraech als m4a liegt bei ~30 MB, als
// unkomprimiertes wav deutlich darueber. Wer laenger aufnimmt, teilt die Datei.
const AUDIO_MAX_BYTES = 200 * 1024 * 1024;

// Eine Stunde Audio braucht auf einer GPU wenige Minuten, auf CPU deutlich
// laenger. Der Default ist bewusst hoch — ein Timeout mitten in der Transkription
// wirft die ganze Aufnahme weg, und der Job blockiert niemanden.
const TIMEOUT_DEFAULT_MS = 30 * 60_000;
const TIMEOUT_MIN_MS = 60_000;
const TIMEOUT_MAX_MS = 4 * 60 * 60_000;

/** Erlaubte Container → Extension. Der ffmpeg-basierte Endpunkt entscheidet
 *  anhand der Extension, welcher Dekoder greift. Bewusst breiter als beim
 *  Diktat: hier kommen Dateien aus Aufnahmegeraeten und Telefonmitschnitten,
 *  nicht nur MediaRecorder-Ausgaben. */
const MIME_EXT = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};

function baseMime(contentType) {
  return String(contentType || '').split(';')[0].trim().toLowerCase();
}

/** Extension zum Mime oder null (= nicht unterstuetzt). */
function extForMime(contentType) {
  return MIME_EXT[baseMime(contentType)] || null;
}

function timeoutMs() {
  const v = Number(appSettings.get('stt.transcribe_timeout_ms'));
  if (!Number.isFinite(v)) return TIMEOUT_DEFAULT_MS;
  return Math.min(Math.max(v, TIMEOUT_MIN_MS), TIMEOUT_MAX_MS);
}

/** Ist die Transkription betriebsbereit? Dieselbe Konfiguration wie das Diktat —
 *  ein zweiter Host waere ein zweiter Ort, an dem dasselbe stehen muss. */
function transcriptionAvailable() {
  return appSettings.get('stt.enabled') === true
    && !!String(appSettings.get('stt.host') || '').trim();
}

/**
 * Rohe Upstream-Segmente in unsere Form bringen: getrimmt, ohne Leersegmente,
 * fortlaufend nummeriert. Pur — der Test kommt ohne Netz aus.
 *
 * Der Sprecher-Schluessel wird NICHT umbenannt (aus `SPEAKER_01` wird nicht
 * `Sprecher 1`): er ist ein Schluessel, und der Anzeigename gehoert in
 * `interview_speakers.label`, wo ihn der Nutzer ueberschreibt.
 */
function normalizeSegments(raw) {
  // `Number(null)` ist 0 und `Number('')` auch — eine fehlende Zeitmarke waere
  // ueber ein blosses `Number.isFinite` also eine Marke bei 0:00 geworden, und
  // der Redebeitrag saehe aus, als endete er am Anfang der Aufnahme.
  const sec = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const out = [];
  for (const s of Array.isArray(raw) ? raw : []) {
    const text = String(s?.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const speaker = String(s?.speaker ?? '').trim();
    out.push({
      idx: out.length,
      start_s: sec(s?.start),
      end_s: sec(s?.end),
      speaker: speaker || null,
      text,
    });
  }
  return out;
}

/**
 * Aufeinanderfolgende Segmente desselben Sprechers zusammenfassen.
 *
 * Warum ueberhaupt: Whisper schneidet alle paar Sekunden, ein Interview zerfaellt
 * dadurch in hunderte Schnipsel. Zum Lesen und zum Herausgreifen eines O-Tons
 * braucht man Redebeitraege, nicht Schnipsel. Die Zeitmarke des Beitrags ist der
 * Beginn des ersten und das Ende des letzten Schnipsels — damit bleibt der
 * Rueckbezug auf die Aufnahme exakt.
 *
 * `maxChars` deckelt den Zusammenschluss: ein Monolog von zehn Minuten waere
 * sonst EIN Block, den man weder zitieren noch anspringen kann.
 */
function mergeBySpeaker(segments, { maxChars = 900 } = {}) {
  const out = [];
  for (const s of segments) {
    const last = out[out.length - 1];
    const sameSpeaker = last && last.speaker === s.speaker;
    const fits = last && (last.text.length + 1 + s.text.length) <= maxChars;
    if (sameSpeaker && fits) {
      last.text = `${last.text} ${s.text}`;
      last.end_s = s.end_s ?? last.end_s;
      continue;
    }
    out.push({ ...s, idx: out.length });
  }
  return out;
}

/** Sekunden als `m:ss` bzw. `h:mm:ss`. Pur, von Server und Tests genutzt; das
 *  Frontend hat seine eigene Kopie (public/js/interview/timecode.js), weil es
 *  dieselbe Marke im Browser rendert. */
function formatTimecode(seconds) {
  const t = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/**
 * Transkript als Fliesstext — das ist der Text, der als `doc_text` am
 * Recherche-Fundstueck landet und damit von FTS und Embedding-Index abgedeckt
 * wird, ohne dass eine dieser Schichten etwas von Interviews wissen muss.
 *
 * Die Zeitmarke steht mit im Text: wer eine Passage semantisch findet, will
 * wissen, wo im Gespraech sie faellt. Der Sprechername kommt aus `labels`
 * (Nutzer-Zuordnung), sonst steht der rohe Schluessel da.
 */
function transcriptToText(segments, labels = {}) {
  const lines = [];
  for (const s of segments) {
    const who = s.speaker ? (labels[s.speaker] || s.speaker) : null;
    const tc = s.start_s == null ? '' : `[${formatTimecode(s.start_s)}] `;
    lines.push(`${tc}${who ? `${who}: ` : ''}${s.text}`);
  }
  return lines.join('\n');
}

/**
 * Aufnahme transkribieren. Wirft bei Fehlern (der Job faengt und schreibt
 * `status='error'` samt Meldung an die Transkript-Zeile).
 *
 * @param {Buffer} buffer   Audiodaten
 * @param {object} opts
 * @param {string} opts.mime
 * @param {string} [opts.language]  ISO-639-1 (Buch-Locale, Region gekuerzt)
 * @param {AbortSignal} [opts.signal]
 * @returns {{segments: Array, diarisiert: boolean, duration_s: number|null,
 *            sprache: string|null, modell: string|null}}
 */
async function transcribeAudio(buffer, { mime, language = '', signal = null } = {}) {
  if (!transcriptionAvailable()) {
    const err = new Error('TRANSCRIBE_DISABLED');
    err.code = 'TRANSCRIBE_DISABLED';
    throw err;
  }
  const ext = extForMime(mime);
  if (!ext) {
    const err = new Error('UNSUPPORTED_AUDIO');
    err.code = 'UNSUPPORTED_AUDIO';
    throw err;
  }
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    const err = new Error('NO_AUDIO');
    err.code = 'NO_AUDIO';
    throw err;
  }

  const host = String(appSettings.get('stt.host') || '').replace(/\/+$/, '').replace(/\/v1$/i, '');
  const model = String(appSettings.get('stt.model') || '').trim();
  const apiKey = String(appSettings.get('stt.api_key') || '').trim();

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: baseMime(mime) }), `interview.${ext}`);
  if (model) form.append('model', model);
  const lang = String(language || '').split('-')[0].trim().toLowerCase();
  if (lang) form.append('language', lang);
  // Zeitmarken gibt es nur in dieser Antwortform — `json` liefert bloss `text`.
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  // Bitte um Sprechertrennung. Backends, die das nicht koennen, ignorieren das
  // Feld; darum steht danach kein Fehler, sondern `diarisiert = false`.
  form.append('diarize', 'true');
  form.append('timestamp_granularities[]', 'segment');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs());
  const onOuterAbort = () => ctrl.abort();
  if (signal) signal.addEventListener('abort', onOuterAbort, { once: true });
  try {
    const upstream = await fetch(`${host}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      body: form,
      signal: ctrl.signal,
    });
    if (!upstream.ok) {
      const err = new Error(`TRANSCRIBE_UPSTREAM_${upstream.status}`);
      err.code = 'TRANSCRIBE_UPSTREAM';
      err.status = upstream.status;
      throw err;
    }
    const json = await upstream.json().catch(() => null);
    if (!json) {
      const err = new Error('TRANSCRIBE_BAD_BODY');
      err.code = 'TRANSCRIBE_BAD_BODY';
      throw err;
    }
    let segments = normalizeSegments(json.segments);
    // Kein Segment-Array, aber Text: ein Backend ohne verbose_json-Support.
    // Besser ein Transkript ohne Zeitmarken als gar keins.
    if (!segments.length && typeof json.text === 'string' && json.text.trim()) {
      segments = [{ idx: 0, start_s: null, end_s: null, speaker: null, text: json.text.trim() }];
    }
    const diarisiert = segments.some(s => !!s.speaker);
    return {
      segments: mergeBySpeaker(segments),
      diarisiert,
      duration_s: Number.isFinite(Number(json.duration)) ? Number(json.duration) : null,
      sprache: typeof json.language === 'string' ? json.language : (lang || null),
      modell: model || null,
    };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onOuterAbort);
  }
}

module.exports = {
  AUDIO_MAX_BYTES, MIME_EXT,
  baseMime, extForMime, transcriptionAvailable,
  normalizeSegments, mergeBySpeaker, formatTimecode, transcriptToText,
  transcribeAudio,
};
