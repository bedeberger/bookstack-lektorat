'use strict';

// Folder-Import-Job. Empfaengt ein ZIP-Archiv (Struktur YYYY/Monat/Tagesdatei),
// entpackt es, erkennt Datumsformate via Regel-Heuristik (+AI-Fallback wenn
// Confidence < Threshold), parst .docx via mammoth und .odt via eigenem Mini-
// Parser, und legt Kapitel pro Jahr + Seiten pro Tag via Content-Store an.
//
// ZIP-Buffer landet beim POST in `importBuffers`-Map und wird vom Worker konsumiert.

const express = require('express');
const JSZip = require('jszip');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  aiCall, getPrompts, jobs, createJob, enqueueJob, findActiveJobId,
} = require('./shared');
const contentStore = require('../../lib/content-store');
const { detectDate, detectDateInText, firstLineFromHtml, extractTitle, scoreSample } = require('../../lib/import-parsers/date-detect');
const { parseImportFile, extOf, SUPPORTED_EXTS } = require('../../lib/import-parsers/dispatch');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const { resolveProvider } = require('../../lib/ai');
const { requireBookAccess, sendACLError } = require('../../lib/acl');
const bookAccess = require('../../db/book-access');
const { getBookLocale } = require('../../db/schema');
const { db } = require('../../db/connection');
const logger = require('../../logger');

const router = express.Router();

const MAX_ZIP_BYTES = 200 * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const CONFIDENCE_THRESHOLD = 0.8;
const AI_SAMPLE_SIZE = 30;
const BUFFER_TTL_MS = 30 * 60 * 1000;

// Kapitel-Gruppierung pro Import (Query-Param `grouping`): Jahr+Monat (Default),
// nur Jahr, oder flach (keine Kapitel). Unbekannte Werte fallen auf 'year-month'.
const GROUPINGS = new Set(['year-month', 'year', 'flat']);

// Monatsnamen fuer die Sub-Chapter-Benennung ("2020 November"). Sprache richtet
// sich nach der Buch-Locale (getBookLocale), nicht hartcodiert deutsch.
const MONTH_NAMES_DE = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
const MONTH_NAMES_EN = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// jobId -> { buffer, mode, bookName, bookId }
const importBuffers = new Map();

function _scheduleBufferCleanup(jobId) {
  const t = setTimeout(() => importBuffers.delete(jobId), BUFFER_TTL_MS);
  t.unref?.();
}

function _parsePath(p) {
  // Erwartet: "<YYYY>/<Monat>/<Datei>". Trim Mac-Resource-Forks und Hidden-Files.
  const norm = p.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = norm.split('/');
  if (parts.length < 3) return null;
  if (parts.some(seg => seg.startsWith('._') || seg === '.DS_Store' || seg === '__MACOSX')) return null;
  const baseFile = parts[parts.length - 1];
  if (!baseFile || baseFile.startsWith('.')) return null;
  // Erstes Element mit 4-stelliger Jahreszahl als Jahr-Ordner nehmen.
  let yearIdx = -1;
  for (let i = 0; i < parts.length - 2; i += 1) {
    if (/^\d{4}$/.test(parts[i])) { yearIdx = i; break; }
  }
  if (yearIdx < 0) return null;
  const year = parseInt(parts[yearIdx], 10);
  const monthRaw = parts[yearIdx + 1];
  const file = parts.slice(yearIdx + 2).join('/');
  return { year, monthRaw, file, fullPath: parts.slice(yearIdx).join('/') };
}

function _monthFromRaw(monthRaw) {
  const { parseMonthToken } = require('../../lib/import-parsers/date-detect');
  return parseMonthToken(monthRaw);
}

async function runFolderImportJob(jobId, { userEmail, mode, bookName, bookId, grouping = 'year-month' }) {
  const log = makeJobLogger(jobId);
  // Audit-Log: jeder User-relevante Schritt landet hier UND in den Winston-Logs.
  // Result-JSON liefert das Array ans Frontend (Collapsible "Import-Log").
  const auditLog = [];
  const skipped = [];
  const audit = (level, msg) => {
    auditLog.push({ level, msg, ts: new Date().toISOString() });
    if (level === 'warn') log.warn(msg);
    else log.info(msg);
  };
  const recordSkip = (path, reason) => {
    skipped.push({ path, reason });
    audit('warn', `skip ${path}: ${reason}`);
  };
  try {
    const entry = importBuffers.get(jobId);
    if (!entry) throw i18nError('job.error.importBufferMissing');
    const { buffer } = entry;

    updateJob(jobId, { progress: 5, statusText: 'job.folder-import.unpacking' });
    const zip = await JSZip.loadAsync(buffer);

    const files = [];
    zip.forEach((relativePath, file) => {
      if (file.dir) return;
      const parsed = _parsePath(relativePath);
      if (!parsed) {
        recordSkip(relativePath, 'BAD_PATH');
        return;
      }
      const ext = extOf(parsed.file);
      if (!SUPPORTED_EXTS.has(ext)) {
        recordSkip(relativePath, 'UNSUPPORTED_EXT');
        return;
      }
      files.push({ relativePath, zipEntry: file, ...parsed });
    });

    if (!files.length) {
      throw i18nError('job.error.emptyArchive');
    }
    audit('info', `${files.length} Dateien gefunden, ${skipped.length} skipped`);

    updateJob(jobId, { progress: 10, statusText: 'job.folder-import.detectingDates' });

    // Sample fuer Pattern-Scoring (erste 20 Filenames mit Path-Context)
    const samplePool = files.slice(0, 20).map(f => ({
      filename: f.file,
      year: f.year,
      month: _monthFromRaw(f.monthRaw),
    }));
    const score = scoreSample(samplePool);
    audit('info', `date-detect score: ${(score.confidence * 100).toFixed(0)}% (pattern=${score.pattern || 'none'})`);

    let aiDateMap = null;
    if (score.confidence < CONFIDENCE_THRESHOLD) {
      audit('info', `Confidence < ${CONFIDENCE_THRESHOLD * 100}% -> AI-Fallback`);
      updateJob(jobId, { progress: 15, statusText: 'job.folder-import.aiDateDetect' });
      try {
        const aiSamples = files.slice(0, AI_SAMPLE_SIZE).map(f => ({
          path: f.fullPath,
          year: f.year,
          month: _monthFromRaw(f.monthRaw),
        }));
        const prompts = await getPrompts(userEmail);
        const { buildDateDetectPrompt, SCHEMA_DATE_DETECT } = prompts;
        const SYSTEM = 'Du bist ein Assistent fuer das Erkennen von Datumsformaten in Dateinamen. Antworte ausschliesslich mit einem JSON-Objekt.';
        const tok = { in: 0, out: 0, ms: 0 };
        const result = await aiCall(
          jobId, tok,
          buildDateDetectPrompt(aiSamples),
          SYSTEM,
          15, 25, 2000, 0.2, 4000, undefined, SCHEMA_DATE_DETECT,
        );
        if (Array.isArray(result?.dateien)) {
          aiDateMap = new Map();
          for (const d of result.dateien) {
            if (d && typeof d.path === 'string' && typeof d.iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.iso)) {
              aiDateMap.set(d.path, d.iso);
            }
          }
          audit('info', `AI date-detect: ${aiDateMap.size}/${aiSamples.length} resolved`);
        }
      } catch (e) {
        audit('warn', `AI date-detect failed: ${e.message}`);
      }
    }

    // Pro Datei: Datum aus Filename → erste Zeile (nach Parse) → AI-Map.
    // Parse passiert HIER (nicht spaeter), damit Fallback-Quelle "erste
    // Dokumentzeile" verfuegbar ist. HTML + Warnings werden mit-gespeichert,
    // damit createPage spaeter nicht erneut parst.
    updateJob(jobId, { progress: 25, statusText: 'job.folder-import.parsing', statusParams: { file: '', current: 0, total: files.length } });
    const enriched = [];
    const warningsCollected = [];
    let parseCount = 0;
    for (const f of files) {
      parseCount += 1;
      const month = _monthFromRaw(f.monthRaw);
      const ctx = { year: f.year, month };
      let isoDate = null;
      let dateSource = null;

      const ruleResult = detectDate(f.file, ctx);
      if (ruleResult) { isoDate = ruleResult.iso; dateSource = 'filename'; }

      // Datei jetzt parsen — entweder fuer Date-Fallback oder fuer
      // spaeteren Page-Insert.
      let buf;
      try {
        buf = await f.zipEntry.async('nodebuffer');
      } catch (e) {
        recordSkip(f.relativePath, 'ZIP_READ_FAILED');
        continue;
      }
      if (buf.length > MAX_FILE_BYTES) {
        recordSkip(f.relativePath, 'FILE_TOO_LARGE');
        continue;
      }
      let parsed;
      try {
        parsed = await parseImportFile(f.file, buf);
      } catch (e) {
        audit('warn', `Parse fail ${f.relativePath}: ${e.message}`);
        recordSkip(f.relativePath, 'PARSE_FAILED');
        continue;
      }
      if (!parsed) {
        recordSkip(f.relativePath, 'UNSUPPORTED_EXT');
        continue;
      }

      // Fallback: erste Text-Zeile pruefen
      if (!isoDate) {
        const firstLine = firstLineFromHtml(parsed.html);
        const textResult = detectDateInText(firstLine, ctx);
        if (textResult) { isoDate = textResult.iso; dateSource = 'first-line'; }
      }

      // Fallback: AI-Map
      if (!isoDate && aiDateMap) {
        const aiIso = aiDateMap.get(f.fullPath);
        if (aiIso) { isoDate = aiIso; dateSource = 'ai'; }
      }

      // Fallback: ZIP-Entry-Modified-Date (mtime). Pfad-Jahr ist immer fuehrend
      // (User-Organisations-Intent schlaegt Filesystem-Metadaten); mtime liefert
      // nur Monat/Tag. Sanity-Cap: mtYear >= 1990 (filtert JSZip-Default
      // 1980-01-01 fuer unset mtimes).
      //   - Pfad-Monat bekannt: strict — mtYear muss f.year matchen (sonst ist
      //     mtime ein Repack-Artefakt). Pfad-Monat gewinnt, Tag aus mtime.
      //   - Pfad-Monat fehlt: relaxed — Year-Match-Constraint fallen lassen,
      //     mtime liefert Monat+Tag. Synthetisches YYYY-06-15 (year-only) waere
      //     sonst die einzige Alternative und gibt null Info ueber den Monat.
      if (!isoDate && f.zipEntry?.date instanceof Date && !isNaN(f.zipEntry.date)) {
        const mt = f.zipEntry.date;
        const mtYear = mt.getUTCFullYear();
        if (mtYear >= 1990) {
          const mtMonth = mt.getUTCMonth() + 1;
          const mtDay = mt.getUTCDate();
          if (Number.isFinite(month)) {
            if (mtYear === f.year) {
              isoDate = `${f.year}-${String(month).padStart(2, '0')}-${String(mtDay).padStart(2, '0')}`;
              dateSource = 'mtime';
            }
          } else {
            isoDate = `${f.year}-${String(mtMonth).padStart(2, '0')}-${String(mtDay).padStart(2, '0')}`;
            dateSource = 'mtime';
          }
        }
      }

      // Letzter Fallback: nur Jahr+Monat aus Pfad ableitbar → synthetisches
      // Datum YYYY-MM-15 (Mitte des Monats fuer Sortierung). Page-Name behaelt
      // den Filename, damit der User sieht, dass kein echtes Datum vorlag.
      if (!isoDate && Number.isFinite(month)) {
        isoDate = `${f.year}-${String(month).padStart(2, '0')}-15`;
        dateSource = 'month-only';
      }

      // Allerletzter Fallback: nur Jahr ableitbar → synthetisches Mid-Year-
      // Datum YYYY-06-15 (sortierbar, Page-Name nutzt YYYY + Thema, damit
      // User sieht dass kein echter Tag vorlag).
      if (!isoDate && Number.isFinite(f.year)) {
        isoDate = `${f.year}-06-15`;
        dateSource = 'year-only';
      }

      if (!isoDate) {
        recordSkip(f.relativePath, 'NO_DATE');
        continue;
      }

      if (parsed.warnings?.length) {
        warningsCollected.push({ path: f.relativePath, items: parsed.warnings });
      }
      enriched.push({ ...f, isoDate, dateSource, html: parsed.html, month });
    }

    if (!enriched.length) {
      throw i18nError('job.error.noDatesFound');
    }

    audit('info', `date-detect breakdown: filename=${enriched.filter(e => e.dateSource === 'filename').length}, first-line=${enriched.filter(e => e.dateSource === 'first-line').length}, ai=${enriched.filter(e => e.dateSource === 'ai').length}, mtime=${enriched.filter(e => e.dateSource === 'mtime').length}, month-only=${enriched.filter(e => e.dateSource === 'month-only').length}, year-only=${enriched.filter(e => e.dateSource === 'year-only').length}`);

    // Sortieren chronologisch
    enriched.sort((a, b) => a.isoDate.localeCompare(b.isoDate));

    // Kollisions-Resolve fuer echte Datums-Quellen: zwei Files auf gleichen Tag
    // wuerden sonst beide den nackten ISO-Namen tragen (mit "(2)"-Suffix). Wir
    // versuchen: (A) Thema aus jedem File extrahieren und `YYYY-MM-DD <Thema>`
    // setzen. (B) wo kein Thema ableitbar ist, HTML in den ersten Tageseintrag
    // mergen — Tagebuch-Semantik: ein Tag = ein Eintrag, kein Datenverlust.
    const REAL_DATE_SOURCES = new Set(['filename', 'first-line', 'ai', 'mtime']);
    const mergedAway = new Set();
    const byDate = new Map();
    for (const f of enriched) {
      if (!REAL_DATE_SOURCES.has(f.dateSource)) continue;
      if (!byDate.has(f.isoDate)) byDate.set(f.isoDate, []);
      byDate.get(f.isoDate).push(f);
    }
    for (const [iso, group] of byDate) {
      if (group.length < 2) continue;
      const annotated = group.map(f => ({ f, thema: extractTitle(f.html, f.file) }));
      const themaful = annotated.filter(x => x.thema);
      const themaless = annotated.filter(x => !x.thema);
      if (themaless.length === group.length) {
        // Alle ohne Thema → in ersten Eintrag mergen
        const [first, ...rest] = group;
        const parts = [first.html, ...rest.map(r => r.html)];
        first.html = parts.join('\n<hr class="day-merge">\n');
        for (const r of rest) mergedAway.add(r);
        audit('info', `day-merge ${iso}: ${rest.length + 1} Files ohne Thema zusammengefasst`);
      } else if (themaless.length === 0) {
        // Alle mit Thema → jeden umbenennen
        for (const { f, thema } of annotated) f._resolvedName = `${iso} ${thema}`;
      } else {
        // Mixed: themaful umbenennen, themaless ins erste themaful-Target mergen
        const target = themaful[0].f;
        for (const { f, thema } of themaful) f._resolvedName = `${iso} ${thema}`;
        for (const { f } of themaless) {
          target.html = `${target.html}\n<hr class="day-merge">\n${f.html}`;
          mergedAway.add(f);
        }
        audit('info', `day-merge ${iso}: ${themaless.length} themalose Files in «${target._resolvedName}» integriert`);
      }
    }
    const resolved = enriched.filter(f => !mergedAway.has(f));

    // Buch sicherstellen
    let effBookId = bookId;
    if (mode === 'new-book') {
      updateJob(jobId, { progress: 28, statusText: 'job.folder-import.creatingBook' });
      const created = await contentStore.createBook({ name: bookName, owner_email: userEmail }, { session: { user: { email: userEmail } } });
      effBookId = created.id;
      try {
        db.prepare(`UPDATE books SET owner_email = COALESCE(owner_email, ?) WHERE book_id = ?`)
          .run(userEmail, effBookId);
        bookAccess.grantAccess(effBookId, userEmail, 'owner', userEmail);
      } catch (gErr) {
        logger.warn(`Auto-Owner-Grant fuer book=${effBookId} fehlgeschlagen: ${gErr.message}`);
      }
      audit('info', `Buch erstellt: «${bookName}» id=${effBookId}`);
    }
    if (!effBookId) throw i18nError('job.error.bookMissing');
    setContext({ book: effBookId });

    // Kapitel-Cache: pro Jahr ein Top-Level-Chapter, pro Jahr+Monat ein
    // Sub-Chapter (parent_chapter_id = Jahr-Chapter-ID).
    const chapterByYear = new Map();        // year (Number) -> chapter_id
    const chapterByYearMonth = new Map();   // "YYYY-MM" -> chapter_id
    // Buch-Locale steuert die Monatsnamen der Sub-Chapter. Fuer neue Buecher
    // greift getBookSettings auf die default_language des Users zurueck.
    const MONTH_NAMES = getBookLocale(effBookId, userEmail).startsWith('en') ? MONTH_NAMES_EN : MONTH_NAMES_DE;
    if (mode === 'merge' && grouping !== 'flat') {
      const existing = await contentStore.listChapters(effBookId, { session: { user: { email: userEmail } } });
      // Erst Top-Level (Jahre) cachen, dann Sub-Chapter (Monate) den Parents zuordnen.
      for (const ch of existing) {
        if (ch.parent_chapter_id) continue;
        const y = parseInt(ch.name, 10);
        if (Number.isFinite(y) && /^\d{4}$/.test(String(ch.name).trim())) {
          chapterByYear.set(y, ch.id);
        }
      }
      for (const ch of existing) {
        if (!ch.parent_chapter_id) continue;
        // Match Year via parent → Month via Position (1-12)
        const parentYear = [...chapterByYear.entries()].find(([, id]) => id === ch.parent_chapter_id)?.[0];
        if (!Number.isFinite(parentYear)) continue;
        const monthNum = ch.position;
        if (Number.isFinite(monthNum) && monthNum >= 1 && monthNum <= 12) {
          chapterByYearMonth.set(`${parentYear}-${String(monthNum).padStart(2, '0')}`, ch.id);
        }
      }
    }

    // Pages anlegen (HTML stammt aus Enrichment-Pass)
    const total = resolved.length;
    let current = 0;
    const dateSeen = new Map(); // iso -> count (fuer Duplikat-Suffix)
    let pagesCreated = 0;

    for (const f of resolved) {
      current += 1;
      const progress = 30 + Math.round(65 * (current / total));
      updateJob(jobId, {
        progress,
        statusText: 'job.folder-import.creating',
        statusParams: { file: f.relativePath, current, total },
      });

      // Kapitel-Zuordnung je nach Gruppierungs-Modus:
      //   'flat'       → keine Kapitel, Seite haengt direkt am Buch (chapter_id null)
      //   'year'       → nur Jahr-Top-Level-Chapter
      //   'year-month' → Jahr-Chapter + Monats-Sub-Chapter (Default)
      let chapterId = null;
      if (grouping !== 'flat') {
        // Year-Chapter (Top-Level) sicherstellen
        let yearChapterId = chapterByYear.get(f.year);
        if (!yearChapterId) {
          const ch = await contentStore.createChapter(
            { book_id: effBookId, name: String(f.year), position: f.year },
            { session: { user: { email: userEmail } } },
          );
          yearChapterId = ch.id;
          chapterByYear.set(f.year, yearChapterId);
          audit('info', `Year-Chapter angelegt: ${f.year} (id=${yearChapterId})`);
        }
        chapterId = yearChapterId;

        // Month-Sub-Chapter nur im 'year-month'-Modus (parent = year-chapter).
        // Wenn Monat unbekannt (year-only-Fallback), bleibt die Seite am
        // Year-Chapter. Name-Format: "YYYY Monatsname" (z.B. "2020 November").
        const isoMonth = f.isoDate.slice(5, 7);
        const monthNum = parseInt(isoMonth, 10);
        if (grouping === 'year-month' && Number.isFinite(monthNum) && monthNum >= 1 && monthNum <= 12 && f.dateSource !== 'year-only') {
          const ymKey = `${f.year}-${isoMonth}`;
          let subId = chapterByYearMonth.get(ymKey);
          if (!subId) {
            const subName = `${f.year} ${MONTH_NAMES[monthNum - 1]}`;
            const sub = await contentStore.createChapter(
              { book_id: effBookId, name: subName, parent_chapter_id: yearChapterId, position: monthNum },
              { session: { user: { email: userEmail } } },
            );
            subId = sub.id;
            chapterByYearMonth.set(ymKey, subId);
            audit('info', `Month-Sub-Chapter angelegt: ${subName} unter ${f.year} (id=${subId})`);
          }
          chapterId = subId;
        }
      }

      // Page-Name: ISO-Date bei echtem Datum, sonst "YYYY-MM <Thema>" fuer
      // month-only-Eintraege. Thema wird via extractTitle aus Heading/
      // Filename/erster Zeile geholt (siehe lib/import-parsers/date-detect).
      // _resolvedName setzt der Kollisions-Resolve oben fuer echte Datums-
      // Quellen mit Kollision (z.B. "2024-03-05 Persoenliches").
      let pageName;
      if (f._resolvedName) {
        pageName = f._resolvedName;
      } else if (f.dateSource === 'month-only') {
        const ym = f.isoDate.slice(0, 7);
        const thema = extractTitle(f.html, f.file);
        pageName = thema ? `${ym} ${thema}` : ym;
      } else if (f.dateSource === 'year-only') {
        const thema = extractTitle(f.html, f.file);
        pageName = thema ? `${f.year} ${thema}` : String(f.year);
      } else {
        pageName = f.isoDate;
      }
      // Duplikat-Suffix auf pageName (nicht mehr auf isoDate, damit
      // month-only-Eintraege mit unterschiedlichen Filenames eigenstaendig sind)
      const seenCount = dateSeen.get(pageName) || 0;
      dateSeen.set(pageName, seenCount + 1);
      if (seenCount > 0) pageName = `${pageName} (${seenCount + 1})`;

      try {
        await contentStore.createPage(
          {
            book_id: effBookId,
            chapter_id: chapterId,
            name: pageName,
            html: f.html,
          },
          { session: { user: { email: userEmail } } },
        );
        pagesCreated += 1;
      } catch (e) {
        audit('warn', `createPage fail ${f.relativePath}: ${e.message}`);
        skipped.push({ path: f.relativePath, reason: 'CREATE_FAILED' });
      }
    }

    audit('info', `Import abgeschlossen: ${pagesCreated} Seiten, ${chapterByYear.size} Jahres-Kapitel, ${chapterByYearMonth.size} Monats-Sub-Kapitel, ${skipped.length} skipped`);

    // Stats syncen + Vortags-Baseline setzen. Ohne prevChars-Snapshot vor heute
    // bleibt der Tages-Donut auf 0 (siehe public/js/today-ring.js). Import-Stand
    // wandert auf gestern, damit Schreiben heute korrekt als Delta zaehlt.
    if (pagesCreated > 0) {
      try {
        const { syncBook } = require('../sync');
        const { localIsoDate, localIsoDaysAgo } = require('../../lib/local-date');
        await syncBook(effBookId, { session: { user: { email: userEmail } } });
        const yesterday = localIsoDaysAgo(1);
        const today = localIsoDate();
        db.prepare(`
          INSERT INTO book_stats_history (book_id, recorded_at, page_count, words, chars, tok, unique_words, chapter_count, avg_sentence_len, avg_lix, avg_flesch_de)
          SELECT book_id, ?, page_count, words, chars, tok, unique_words, chapter_count, avg_sentence_len, avg_lix, avg_flesch_de
            FROM book_stats_history WHERE book_id = ? AND recorded_at = ?
          ON CONFLICT(book_id, recorded_at) DO UPDATE SET
            page_count=excluded.page_count, words=excluded.words, chars=excluded.chars, tok=excluded.tok,
            unique_words=excluded.unique_words, chapter_count=excluded.chapter_count,
            avg_sentence_len=excluded.avg_sentence_len, avg_lix=excluded.avg_lix, avg_flesch_de=excluded.avg_flesch_de
        `).run(yesterday, effBookId, today);
        audit('info', `Vortags-Baseline gesetzt (${yesterday})`);
      } catch (e) {
        audit('warn', `Baseline-Snapshot fail: ${e.message}`);
      }
    }

    completeJob(jobId, {
      bookId: effBookId,
      pagesCreated,
      chaptersCreated: chapterByYear.size + chapterByYearMonth.size,
      yearChaptersCreated: chapterByYear.size,
      monthSubChaptersCreated: chapterByYearMonth.size,
      skipped,
      warnings: warningsCollected,
      auditLog,
    });
  } catch (e) {
    if (e?.name !== 'AbortError') log.error(`folder-import job ${jobId}: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  } finally {
    importBuffers.delete(jobId);
  }
}

const rawZipBody = express.raw({
  type: ['application/zip', 'application/octet-stream', 'application/x-zip-compressed'],
  limit: MAX_ZIP_BYTES + 1,
});

router.post('/folder-import', rawZipBody, async (req, res) => {
  const userEmail = req.session?.user?.email || null;
  if (!userEmail) return res.status(401).json({ error_code: 'UNAUTHENTICATED' });

  const mode = (req.query?.mode === 'merge') ? 'merge' : 'new-book';
  const bookName = String(req.query?.book_name || '').trim();
  const bookId = mode === 'merge' ? toIntId(req.query?.book_id) : null;
  const grouping = GROUPINGS.has(req.query?.grouping) ? req.query.grouping : 'year-month';

  if (mode === 'new-book' && !bookName) {
    return res.status(400).json({ error_code: 'BOOK_NAME_REQUIRED' });
  }
  if (mode === 'merge' && !bookId) {
    return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  }

  if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error_code: 'EMPTY_BODY' });
  }
  if (req.body.length > MAX_ZIP_BYTES) {
    return res.status(413).json({ error_code: 'ZIP_TOO_LARGE' });
  }

  if (mode === 'merge') {
    setContext({ book: bookId });
    try { requireBookAccess(req, bookId, 'editor'); }
    catch (e) { if (sendACLError(res, e)) return; throw e; }
  }

  const dedupKey = mode === 'merge' ? `merge:${bookId}` : `new:${bookName}`;
  const existing = findActiveJobId('folder-import', dedupKey, userEmail);
  if (existing) return res.json({ jobId: existing, deduplicated: true });

  const jobId = createJob(
    'folder-import',
    bookId || 0,
    userEmail,
    'job.label.folderImportBook',
    { name: bookName || `Book #${bookId}` },
    dedupKey,
  );
  importBuffers.set(jobId, { buffer: req.body, mode, bookName, bookId });
  _scheduleBufferCleanup(jobId);

  enqueueJob(jobId, () => runFolderImportJob(jobId, { userEmail, mode, bookName, bookId, grouping }));
  res.status(202).json({ jobId });
});

module.exports = { folderImportRouter: router, runFolderImportJob, importBuffers };
