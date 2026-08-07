'use strict';
// Interview-Transkription: Aufnahme hochladen, Transkript lesen, Sprecher
// benennen, O-Ton übernehmen.
//
// Am research-Haupt-Router gemountet (siehe routes/research.js) — das Transkript
// IST ein Recherche-Fundstück, kein eigenes Objekt daneben. Deshalb gilt hier
// dieselbe ACL wie dort: lesen ab `viewer`, schreiben ab `editor`, aufgelöst
// über das Buch des Fundstücks.
//
// Routen:
//   POST   /:id/audio           Aufnahme ablegen, kind wird 'transcript'
//   GET    /:id/audio           Aufnahme streamen (Range-fähig für den Player)
//   DELETE /:id/audio           Aufnahme löschen, Transkript behalten
//   GET    /:id/transcript      Kopf + Segmente + Sprecher
//   PUT    /:id/speaker/:key    Sprecher benennen / mit Quelle verknüpfen
//   POST   /:id/oton            O-Ton als Quelle vom Typ `interview` anlegen

const express = require('express');
const { db } = require('../db/schema');
const { NOW_ISO_SQL } = require('../db/now');
const { emitItem, itemBookId } = require('../db/research-items');
const {
  getTranscript, getAudio, createTranscript, dropAudio,
  listSegments, getSegment, listSpeakers, speakerLabels, setSpeaker, speakerKeys,
} = require('../db/interview');
const {
  AUDIO_MAX_BYTES, extForMime, baseMime, transcriptionAvailable,
  transcriptToText, formatTimecode,
} = require('../lib/interview-transcribe');
const { createSource, linkSource, getSource } = require('../db/sources');
const { toIntId } = require('../lib/validate');
const { setContext } = require('../lib/log-context');
const { requireBookAccess, sendACLError } = require('../lib/acl');
const searchIndex = require('../lib/search');
const logger = require('../logger');

const interviewMediaRouter = express.Router();
const jsonBody = express.json();
// Audio kommt als rohes Binary mit dem Datei-Mime im Content-Type — kein
// Multipart, gleiche Bauform wie der PDF- und Bild-Upload der Recherche-Karte.
const rawAudio = express.raw({ type: ['audio/*', 'video/mp4', 'video/webm'], limit: AUDIO_MAX_BYTES + 1024 });

const AUDIONAME_MAX = 200;

function userEmailOrNull(req) {
  return req.session?.user?.email || null;
}

/** ACL über das Buch des Fundstücks. Liefert die book_id oder null (Antwort ist
 *  dann bereits gesendet). */
function _guard(req, res, itemId, minRole) {
  const bookId = itemBookId(itemId);
  if (!bookId) { res.status(404).json({ error_code: 'ITEM_NOT_FOUND' }); return null; }
  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, minRole); return bookId; }
  catch (e) { if (sendACLError(res, e)) return null; throw e; }
}

function _cleanName(raw) {
  const s = String(raw || '').replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, AUDIONAME_MAX) : null;
}

// ── Aufnahme hochladen ───────────────────────────────────────────────────────

interviewMediaRouter.post('/:id/audio', rawAudio, (req, res) => {
  const userEmail = userEmailOrNull(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const bookId = _guard(req, res, id, 'editor');
  if (!bookId) return;

  if (!Buffer.isBuffer(req.body) || !req.body.length) {
    return res.status(400).json({ error_code: 'NO_AUDIO' });
  }
  if (req.body.length > AUDIO_MAX_BYTES) {
    return res.status(413).json({ error_code: 'AUDIO_TOO_LARGE', params: { max: AUDIO_MAX_BYTES } });
  }
  const mime = baseMime(req.headers['content-type']);
  if (!extForMime(mime)) {
    return res.status(415).json({ error_code: 'UNSUPPORTED_AUDIO' });
  }

  createTranscript(id, bookId, {
    buffer: req.body, mime, name: _cleanName(req.query.name),
  });
  // `kind` erst NACH der Ablage: schlägt der Insert fehl, soll das Fundstück
  // nicht als Transkript dastehen, hinter dem nichts liegt.
  db.prepare(`UPDATE research_items SET kind = 'transcript', updated_at = ${NOW_ISO_SQL} WHERE id = ?`).run(id);
  logger.info(`[interview] Audio abgelegt item=${id} bytes=${req.body.length} mime=${mime}`);
  res.json({
    item: emitItem(id),
    transcript: getTranscript(id),
    // Der Client soll nicht raten müssen, ob ein Transkriptionslauf überhaupt
    // möglich ist — ohne Backend bleibt die Aufnahme ein Anhang.
    can_transcribe: transcriptionAvailable(),
  });
});

/**
 * Aufnahme streamen. Range-fähig, weil ein `<audio>`-Element sonst nicht
 * springen kann: ohne `Accept-Ranges` lädt der Browser bei jedem Klick auf eine
 * Zeitmarke die ganze Datei neu — bei einer Stunde Gespräch unbrauchbar.
 */
interviewMediaRouter.get('/:id/audio', (req, res) => {
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const bookId = _guard(req, res, id, 'viewer');
  if (!bookId) return;
  const row = getAudio(id);
  if (!row?.audio) return res.status(404).json({ error_code: 'NO_AUDIO' });

  const buf = row.audio;
  const mime = row.audio_mime || 'application/octet-stream';
  res.set('Content-Type', mime);
  res.set('Accept-Ranges', 'bytes');
  res.set('Cache-Control', 'private, max-age=3600');
  res.set('X-Content-Type-Options', 'nosniff');

  const range = String(req.headers.range || '');
  const m = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!m) {
    res.set('Content-Length', String(buf.length));
    return res.send(buf);
  }
  let start = m[1] === '' ? null : parseInt(m[1], 10);
  let end = m[2] === '' ? null : parseInt(m[2], 10);
  if (start === null && end === null) return res.status(416).end();
  if (start === null) { start = Math.max(0, buf.length - end); end = buf.length - 1; }
  if (end === null || end >= buf.length) end = buf.length - 1;
  if (start > end || start >= buf.length) {
    res.set('Content-Range', `bytes */${buf.length}`);
    return res.status(416).end();
  }
  res.status(206);
  res.set('Content-Range', `bytes ${start}-${end}/${buf.length}`);
  res.set('Content-Length', String(end - start + 1));
  res.send(buf.subarray(start, end + 1));
});

/** Aufnahme löschen, Wortlaut behalten. */
interviewMediaRouter.delete('/:id/audio', (req, res) => {
  const userEmail = userEmailOrNull(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  if (!_guard(req, res, id, 'editor')) return;
  res.json({ transcript: dropAudio(id) });
});

// ── Transkript lesen ─────────────────────────────────────────────────────────

interviewMediaRouter.get('/:id/transcript', (req, res) => {
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  if (!_guard(req, res, id, 'viewer')) return;
  const head = getTranscript(id);
  if (!head) return res.status(404).json({ error_code: 'TRANSCRIPT_NOT_FOUND' });
  res.json({
    transcript: head,
    segments: listSegments(id),
    speakers: listSpeakers(id),
    speaker_keys: speakerKeys(id),
    can_transcribe: transcriptionAvailable(),
  });
});

// ── Sprecher benennen ────────────────────────────────────────────────────────

/**
 * Aus «SPEAKER_01» wird «Maria Keller». Danach wird der Volltext neu gesetzt,
 * damit die Namen auch in Suche und Semantik-Index stehen — sonst findet man
 * das Zitat nur unter dem Schlüssel, den niemand kennt.
 */
interviewMediaRouter.put('/:id/speaker/:key', jsonBody, (req, res) => {
  const userEmail = userEmailOrNull(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  if (!_guard(req, res, id, 'editor')) return;
  if (!getTranscript(id)) return res.status(404).json({ error_code: 'TRANSCRIPT_NOT_FOUND' });

  try {
    setSpeaker(id, req.params.key, {
      label: req.body?.label ?? null,
      rolle: req.body?.rolle ?? null,
      sourceId: req.body?.source_id ?? null,
    });
  } catch (e) {
    if (e.code === 'UNKNOWN_SPEAKER') return res.status(400).json({ error_code: 'UNKNOWN_SPEAKER' });
    throw e;
  }

  const text = transcriptToText(listSegments(id), speakerLabels(id));
  db.prepare(
    `UPDATE research_items SET doc_text = ?, doc_chars = ?, updated_at = ${NOW_ISO_SQL} WHERE id = ?`,
  ).run(text, text.length, id);
  searchIndex.upsertResearch(id);
  res.json({ speakers: listSpeakers(id) });
});

// ── O-Ton übernehmen ─────────────────────────────────────────────────────────

/**
 * Ein Redebeitrag wird zur Quelle vom CSL-Typ `interview`.
 *
 * Warum über die Quellen-Bibliothek und nicht als eigener Zitat-Typ: der
 * Apparat dafür steht schon — `oton_role`/`oton_channel`/`oton_date`/`oton_auth`
 * (Migration 267) samt Warnung bei fehlender Zitatautorisierung, und der
 * Einfüge-Pfad im Editor (`span.cite[data-src]` + `blockquote[data-src]`) trägt
 * jeden O-Ton bis in PDF, EPUB und Quellenverzeichnis. Ein zweiter Zitat-Träger
 * daneben müsste all das nachbauen.
 *
 * Die Route legt NUR die Quelle an und liefert Text und Stellenangabe zurück.
 * Ins Manuskript schreibt sie nicht — wo ein O-Ton steht, entscheidet der Autor
 * im Editor (gleiche Trennung wie bei der Quellen-Erkennung).
 */
interviewMediaRouter.post('/:id/oton', jsonBody, (req, res) => {
  const userEmail = userEmailOrNull(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const bookId = _guard(req, res, id, 'editor');
  if (!bookId) return;

  const segId = toIntId(req.body?.segment_id);
  const seg = segId ? getSegment(segId) : null;
  if (!seg || seg.item_id !== id) return res.status(404).json({ error_code: 'SEGMENT_NOT_FOUND' });

  const speakers = listSpeakers(id);
  const info = seg.speaker ? speakers[seg.speaker] : null;

  // Hat dieser Sprecher schon eine Quelle, wird sie wiederverwendet. Sonst
  // entstünde je O-Ton ein neuer Eintrag derselben Person in der Bibliothek —
  // und das Quellenverzeichnis listete sie fünfmal.
  if (info?.source_id) {
    const existing = getSource(info.source_id, bookId);
    if (existing) {
      return res.json({ source: existing, reused: true, ...(_otonPayload(seg, info)) });
    }
  }

  const head = getTranscript(id);
  const name = info?.label || (seg.speaker ? seg.speaker : null);
  if (!name) return res.status(400).json({ error_code: 'SPEAKER_UNNAMED' });

  const src = createSource(userEmail, {
    csl_type: 'interview',
    // Die sprechende Person IST die Autorin des O-Tons (CSL-Konvention beim Typ
    // `interview`). Als `literal`, weil die App den Namen nicht in Vor- und
    // Nachname zerlegen kann, ohne zu raten.
    authors: [{ literal: name }],
    title: head?.audio_name || `Interview ${name}`,
    oton_role: info?.rolle || null,
    // Kanal und Datum weiss die App nicht — sie werden NICHT geraten. Das
    // Quellen-Formular fragt sie ab, und ein leeres Feld ist dort sichtbar,
    // eine erfundene Angabe nicht.
    //
    // `oton_auth: 'ausstehend'` ist Absicht und kein Platzhalter: ein frisch
    // aus dem Transkript gezogener O-Ton IST unautorisiert, und die Quellen-
    // Karte warnt dann überall dort, wo er belegt wird (fields.js#otonBlocking).
    oton_auth: 'ausstehend',
    note: `O-Ton aus dem Transkript «${head?.audio_name || id}»`,
  });
  linkSource(bookId, src.id, userEmail);
  setSpeaker(id, seg.speaker, {
    label: info?.label || name, rolle: info?.rolle || null, sourceId: src.id,
  });
  logger.info(`[interview] O-Ton item=${id} segment=${segId} → Quelle ${src.id}`);
  res.json({ source: getSource(src.id, bookId), reused: false, ..._otonPayload(seg, info) });
});

/** Was der Editor zum Einfügen braucht: Wortlaut und Stellenangabe. Die
 *  Stellenangabe ist die Zeitmarke — bei einem Gespräch ist sie das, was die
 *  Seitenzahl bei einem Buch ist. */
function _otonPayload(seg, info) {
  return {
    text: seg.text,
    loc: seg.start_s == null ? '' : formatTimecode(seg.start_s),
    speaker: info?.label || seg.speaker || null,
  };
}

module.exports = { interviewMediaRouter };
