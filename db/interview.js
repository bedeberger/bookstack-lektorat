'use strict';
// Interview-Transkripte: Aufnahme, Segmente mit Zeitmarken, Sprecher-Zuordnung.
//
// Das Transkript haengt an einem Recherche-Fundstueck (`research_items`, kind
// 'transcript'). Diese Datei kennt das Fundstueck nur ueber die item_id — den
// Volltext nach `doc_text` schreibt der Job, weil dort auch FTS- und
// Embedding-Index nachgezogen werden.
//
// EIN LAUF ERSETZT ALLES: Segmente sind ein abgeleiteter Index, kein
// Bearbeitungsstand. Ein zweiter Transkriptionslauf (anderes Modell, Backend mit
// Sprechertrennung) schreibt sie per Full-Replace neu. Die Sprecher-Zuordnung
// ueberlebt das bewusst — sie ist Handarbeit des Nutzers und haengt am
// Sprecher-Schluessel, nicht an den Segment-Zeilen.

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');

const TRANSCRIPT_STATUS = ['pending', 'running', 'ready', 'error'];

// ── Transkript-Kopf ──────────────────────────────────────────────────────────

const _stmtGet = db.prepare(`
  SELECT item_id, book_id, audio_mime, audio_name, audio_bytes, duration_s,
         status, fehler, sprache, modell, diarisiert, created_at, updated_at,
         (audio IS NOT NULL) AS has_audio
    FROM interview_transcripts WHERE item_id = ?
`);
const _stmtListForBook = db.prepare(`
  SELECT item_id, status, duration_s, diarisiert, audio_name
    FROM interview_transcripts WHERE book_id = ?
`);

/** Kopfdaten ohne den Audio-BLOB. Jede Leseabfrage geht hier durch — der BLOB
 *  wird ausschliesslich von `getAudio` geholt, damit eine Listenabfrage nicht
 *  hundert Megabyte durch den Prozess zieht. */
function getTranscript(itemId) {
  const r = _stmtGet.get(parseInt(itemId));
  if (!r) return null;
  return { ...r, diarisiert: !!r.diarisiert, has_audio: !!r.has_audio };
}

function listBookTranscripts(bookId) {
  const out = {};
  for (const r of _stmtListForBook.all(parseInt(bookId))) {
    out[String(r.item_id)] = { ...r, diarisiert: !!r.diarisiert };
  }
  return out;
}

/** Audio-BLOB samt Mime — nur fuer die Ausliefer-Route. */
function getAudio(itemId) {
  return db.prepare(
    'SELECT audio, audio_mime, audio_name FROM interview_transcripts WHERE item_id = ?',
  ).get(parseInt(itemId)) || null;
}

/** Aufnahme ablegen und den Lauf als wartend markieren. */
function createTranscript(itemId, bookId, { buffer, mime, name }) {
  db.prepare(`
    INSERT INTO interview_transcripts
           (item_id, book_id, audio, audio_mime, audio_name, audio_bytes, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ${NOW_ISO_SQL}, ${NOW_ISO_SQL})
    ON CONFLICT(item_id) DO UPDATE SET
      audio = excluded.audio, audio_mime = excluded.audio_mime,
      audio_name = excluded.audio_name, audio_bytes = excluded.audio_bytes,
      status = 'pending', fehler = NULL, updated_at = excluded.updated_at
  `).run(parseInt(itemId), parseInt(bookId), buffer, mime, name || null, buffer?.length || 0);
  return getTranscript(itemId);
}

function setStatus(itemId, status, fehler = null) {
  if (!TRANSCRIPT_STATUS.includes(status)) {
    const err = new Error(`Ungueltiger Transkript-Status: ${status}`);
    err.code = 'INVALID_STATUS';
    throw err;
  }
  db.prepare(
    `UPDATE interview_transcripts SET status = ?, fehler = ?, updated_at = ${NOW_ISO_SQL} WHERE item_id = ?`,
  ).run(status, fehler ? String(fehler).slice(0, 500) : null, parseInt(itemId));
  return getTranscript(itemId);
}

/** Audio loeschen, Transkript behalten. Die Aufnahme ist der grosse Teil, und
 *  wenn der Wortlaut steht, will man sie oft nicht mehr im Backup mitschleppen. */
function dropAudio(itemId) {
  db.prepare(
    `UPDATE interview_transcripts
        SET audio = NULL, audio_bytes = 0, updated_at = ${NOW_ISO_SQL}
      WHERE item_id = ?`,
  ).run(parseInt(itemId));
  return getTranscript(itemId);
}

// ── Segmente ─────────────────────────────────────────────────────────────────

const _stmtSegments = db.prepare(
  'SELECT id, idx, start_s, end_s, speaker, text FROM interview_segments WHERE item_id = ? ORDER BY idx',
);
const _stmtSegment = db.prepare(
  'SELECT id, item_id, book_id, idx, start_s, end_s, speaker, text FROM interview_segments WHERE id = ?',
);

function listSegments(itemId) {
  return _stmtSegments.all(parseInt(itemId));
}

function getSegment(id) {
  return _stmtSegment.get(parseInt(id)) || null;
}

/** Full-Replace: ein Lauf ersetzt alle Segmente. In einer Transaktion, damit es
 *  keinen Zwischenzustand mit halbem Transkript gibt. */
function replaceSegments(itemId, bookId, segments) {
  const iid = parseInt(itemId);
  const bid = parseInt(bookId);
  const ins = db.prepare(
    'INSERT INTO interview_segments (item_id, book_id, idx, start_s, end_s, speaker, text) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  db.transaction(() => {
    db.prepare('DELETE FROM interview_segments WHERE item_id = ?').run(iid);
    let i = 0;
    for (const s of segments || []) {
      const text = String(s?.text || '').trim();
      if (!text) continue;
      ins.run(iid, bid, i++, s.start_s ?? null, s.end_s ?? null, s.speaker || null, text);
    }
  })();
  return listSegments(iid);
}

// ── Sprecher ─────────────────────────────────────────────────────────────────

const _stmtSpeakers = db.prepare(
  'SELECT speaker, label, rolle, source_id FROM interview_speakers WHERE item_id = ? ORDER BY speaker',
);

/** Sprecher-Zuordnungen als { [speaker]: { label, rolle, source_id } }. */
function listSpeakers(itemId) {
  const out = {};
  for (const r of _stmtSpeakers.all(parseInt(itemId))) {
    out[r.speaker] = { label: r.label || null, rolle: r.rolle || null, source_id: r.source_id || null };
  }
  return out;
}

/** Nur die Anzeigenamen — die Form, die `transcriptToText` erwartet. */
function speakerLabels(itemId) {
  const out = {};
  for (const [k, v] of Object.entries(listSpeakers(itemId))) {
    if (v.label) out[k] = v.label;
  }
  return out;
}

/**
 * Sprecher benennen bzw. mit einer Quelle verknuepfen. Ein leerer Name loescht
 * die Zuordnung wieder — dann steht in der Anzeige wieder der rohe Schluessel,
 * und das ist ehrlicher als ein leerer Name.
 *
 * Die Sprecher-Schluessel, die es geben DARF, kommen aus den Segmenten: einen
 * Namen fuer `SPEAKER_09` zu setzen, wenn im Gespraech nur zwei Stimmen sind,
 * legt eine Zeile an, die nie jemand sieht.
 */
function setSpeaker(itemId, speaker, { label = null, rolle = null, sourceId = null } = {}) {
  const iid = parseInt(itemId);
  const key = String(speaker || '').trim();
  if (!key) return null;
  const known = new Set(listSegments(iid).map(s => s.speaker).filter(Boolean));
  if (!known.has(key)) {
    const err = new Error(`Unbekannter Sprecher: ${key}`);
    err.code = 'UNKNOWN_SPEAKER';
    throw err;
  }
  const clean = (v, max) => {
    const s = v == null ? '' : String(v).replace(/\s+/g, ' ').trim();
    return s ? s.slice(0, max) : null;
  };
  const lab = clean(label, 200);
  const rol = clean(rolle, 200);
  const sid = sourceId == null || sourceId === '' ? null : parseInt(sourceId) || null;
  if (!lab && !rol && !sid) {
    db.prepare('DELETE FROM interview_speakers WHERE item_id = ? AND speaker = ?').run(iid, key);
    return null;
  }
  db.prepare(`
    INSERT INTO interview_speakers (item_id, speaker, label, rolle, source_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ${NOW_ISO_SQL})
    ON CONFLICT(item_id, speaker) DO UPDATE SET
      label = excluded.label, rolle = excluded.rolle,
      source_id = excluded.source_id, updated_at = excluded.updated_at
  `).run(iid, key, lab, rol, sid);
  return listSpeakers(iid)[key] || null;
}

/** Die im Transkript vorkommenden Sprecher-Schluessel, in Reihenfolge ihres
 *  ersten Auftretens — das ist die Reihenfolge, in der die Karte sie zum
 *  Benennen anbietet. */
function speakerKeys(itemId) {
  const seen = [];
  for (const s of listSegments(itemId)) {
    if (s.speaker && !seen.includes(s.speaker)) seen.push(s.speaker);
  }
  return seen;
}

module.exports = {
  TRANSCRIPT_STATUS,
  getTranscript, listBookTranscripts, getAudio, createTranscript, setStatus, dropAudio,
  listSegments, getSegment, replaceSegments,
  listSpeakers, speakerLabels, setSpeaker, speakerKeys,
};
