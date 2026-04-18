'use strict';
// Tool-Implementierungen für den Agentic Buch-Chat.
// Jede Funktion nimmt (input, ctx) und gibt ein JSON-serialisierbares Objekt zurück.
// ctx = { bookId, userEmail, userToken, jobSignal, logger }

const { db } = require('../../db/schema');
const { bsGet, htmlToText } = require('./shared');

// Harte Obergrenzen – schützen das Token-Budget gegen ausufernde Tool-Calls.
const MAX_RESULT_CHARS      = 8000;
const MAX_SEARCH_RESULTS    = 30;
const MAX_PAGES_PER_FETCH   = 20;
const MAX_CHARS_PER_PAGE    = 8000;
const DEFAULT_CHARS_PER_PAGE = 3000;
const SEARCH_SNIPPET_CONTEXT = 120; // Zeichen vor + nach dem Treffer

/** Kürzt ein Tool-Result-Objekt, damit es nicht das Token-Budget sprengt. */
function _truncateResult(obj) {
  const s = JSON.stringify(obj);
  if (s.length <= MAX_RESULT_CHARS) return obj;
  // Fallback: wenn shown/results-Array existiert, kürzen und truncated-Flag setzen
  if (Array.isArray(obj.results) && obj.results.length > 5) {
    return {
      ..._truncateResult({ ...obj, results: obj.results.slice(0, 10) }),
      truncated: true,
      total_results: obj.results.length,
    };
  }
  // Letzter Ausweg: stringifizieren und hart schneiden
  return { _truncated: s.slice(0, MAX_RESULT_CHARS - 100) + '… [result truncated]' };
}

// ── list_chapters ────────────────────────────────────────────────────────────

function tool_list_chapters(_input, ctx) {
  const chapterRows = db.prepare(`
    SELECT c.chapter_id, c.chapter_name,
           COUNT(p.page_id)            AS page_count,
           COALESCE(SUM(ps.words), 0)  AS words,
           COALESCE(SUM(ps.chars), 0)  AS chars
    FROM chapters c
    LEFT JOIN pages p      ON p.chapter_id = c.chapter_id AND p.book_id = c.book_id
    LEFT JOIN page_stats ps ON ps.page_id = p.page_id
    WHERE c.book_id = ?
    GROUP BY c.chapter_id, c.chapter_name
    ORDER BY c.chapter_id
  `).all(ctx.bookId);

  // Seiten mit ihren Kapitelzuordnungen laden – inkl. Seiten ohne Kapitel (chapter_id IS NULL)
  const pageRows = db.prepare(`
    SELECT p.page_id, p.page_name, p.chapter_id, COALESCE(ps.words, 0) AS words
    FROM pages p
    LEFT JOIN page_stats ps ON ps.page_id = p.page_id
    WHERE p.book_id = ?
    ORDER BY p.chapter_id, p.page_id
  `).all(ctx.bookId);

  const pagesByChapter = new Map();
  const orphanPages = [];
  let totalWords = 0, totalPages = 0;
  for (const p of pageRows) {
    totalPages++;
    totalWords += p.words;
    const entry = { page_id: p.page_id, page_name: p.page_name, words: p.words };
    if (p.chapter_id == null) orphanPages.push(entry);
    else {
      if (!pagesByChapter.has(p.chapter_id)) pagesByChapter.set(p.chapter_id, []);
      pagesByChapter.get(p.chapter_id).push(entry);
    }
  }

  const chapters = chapterRows.map(r => ({
    chapter_id:   r.chapter_id,
    chapter_name: r.chapter_name,
    page_count:   r.page_count,
    words:        r.words,
    pages:        pagesByChapter.get(r.chapter_id) || [],
  }));

  return _truncateResult({
    chapters,
    ...(orphanPages.length ? { pages_without_chapter: orphanPages } : {}),
    total_pages: totalPages,
    total_words: totalWords,
    hint: totalWords < 12000
      ? 'Kleines Buch – du kannst alle Seiten via get_pages laden, wenn das für die Frage sinnvoll ist.'
      : undefined,
  });
}

// ── count_pronouns ────────────────────────────────────────────────────────────

const PRONOUN_KEYS = ['ich', 'du', 'er', 'sie_sg', 'wir', 'ihr_pl', 'man'];

function _aggregatePronounsFromRows(rows, filterKeys) {
  const agg = {};
  for (const k of filterKeys) agg[k] = { narr: 0, dlg: 0 };
  for (const r of rows) {
    if (!r.pronoun_counts) continue;
    let parsed;
    try { parsed = JSON.parse(r.pronoun_counts); } catch { continue; }
    for (const k of filterKeys) {
      const v = parsed[k];
      if (!v) continue;
      agg[k].narr += v.narr || 0;
      agg[k].dlg  += v.dlg  || 0;
    }
  }
  return agg;
}

function tool_count_pronouns(input, ctx) {
  const perChapter = !!input.per_chapter;
  const filterKeys = Array.isArray(input.pronouns) && input.pronouns.length
    ? input.pronouns.filter(p => PRONOUN_KEYS.includes(p))
    : PRONOUN_KEYS;

  if (!perChapter) {
    const rows = db.prepare(
      'SELECT pronoun_counts FROM page_stats WHERE book_id = ? AND pronoun_counts IS NOT NULL'
    ).all(ctx.bookId);
    const counts = _aggregatePronounsFromRows(rows, filterKeys);
    return { counts, scope: 'book', pronouns: filterKeys, pages_indexed: rows.length };
  }

  // Pro Kapitel aggregieren
  const rows = db.prepare(`
    SELECT p.chapter_id, c.chapter_name, ps.pronoun_counts
    FROM page_stats ps
    JOIN pages p      ON p.page_id = ps.page_id
    LEFT JOIN chapters c ON c.chapter_id = p.chapter_id AND c.book_id = p.book_id
    WHERE ps.book_id = ? AND ps.pronoun_counts IS NOT NULL
  `).all(ctx.bookId);
  const byChapter = new Map();
  for (const r of rows) {
    const key = r.chapter_id ?? 0;
    if (!byChapter.has(key)) {
      byChapter.set(key, { chapter_id: r.chapter_id, chapter_name: r.chapter_name || '(ohne Kapitel)', rows: [] });
    }
    byChapter.get(key).rows.push(r);
  }
  const chapters = [...byChapter.values()]
    .sort((a, b) => (a.chapter_id ?? 0) - (b.chapter_id ?? 0))
    .map(ch => ({
      chapter_id: ch.chapter_id,
      chapter_name: ch.chapter_name,
      counts: _aggregatePronounsFromRows(ch.rows, filterKeys),
    }));
  return { chapters, scope: 'chapters', pronouns: filterKeys };
}

// ── get_chapter_stats ─────────────────────────────────────────────────────────

function tool_get_chapter_stats(input, ctx) {
  const chapterId = input.chapter_id;
  if (chapterId == null) throw new Error('chapter_id fehlt');

  const chRow = db.prepare('SELECT chapter_id, chapter_name FROM chapters WHERE chapter_id = ? AND book_id = ?')
    .get(chapterId, ctx.bookId);
  if (!chRow) return { chapter_id: chapterId, error: 'Kapitel nicht gefunden' };

  const pages = db.prepare(`
    SELECT p.page_id, p.page_name, ps.words, ps.chars, ps.sentences, ps.dialog_chars, ps.pronoun_counts
    FROM pages p
    LEFT JOIN page_stats ps ON ps.page_id = p.page_id
    WHERE p.chapter_id = ? AND p.book_id = ?
    ORDER BY p.page_id
  `).all(chapterId, ctx.bookId);

  let words = 0, chars = 0, sentences = 0, dialogChars = 0;
  for (const p of pages) {
    words += p.words || 0;
    chars += p.chars || 0;
    sentences += p.sentences || 0;
    dialogChars += p.dialog_chars || 0;
  }
  const dialogRatio = chars > 0 ? Math.round((dialogChars / chars) * 1000) / 1000 : 0;

  // Top-5 Figuren dieses Kapitels
  const topFiguren = db.prepare(`
    SELECT f.fig_id, f.name, f.user_email, SUM(pfm.count) AS total
    FROM page_figure_mentions pfm
    JOIN pages p  ON p.page_id = pfm.page_id
    JOIN figures f ON f.id = pfm.figure_id
    WHERE p.chapter_id = ? AND p.book_id = ? AND f.user_email IS ?
    GROUP BY f.id
    ORDER BY total DESC
    LIMIT 5
  `).all(chapterId, ctx.bookId, ctx.userEmail || null);

  return {
    chapter_id: chapterId,
    chapter_name: chRow.chapter_name,
    pages: pages.length,
    words,
    sentences,
    chars,
    dialog_chars: dialogChars,
    dialog_ratio: dialogRatio,
    top_figuren: topFiguren.map(f => ({ fig_id: f.fig_id, name: f.name, mentions: f.total })),
  };
}

// ── get_figure_mentions ───────────────────────────────────────────────────────

function tool_get_figure_mentions(input, ctx) {
  const userEmail = ctx.userEmail || null;
  let figRow = null;
  if (input.figur_id) {
    figRow = db.prepare(
      'SELECT id, fig_id, name, kurzname FROM figures WHERE book_id = ? AND fig_id = ? AND user_email IS ?'
    ).get(ctx.bookId, input.figur_id, userEmail);
  }
  if (!figRow && input.figur_name) {
    const q = `%${input.figur_name}%`;
    figRow = db.prepare(
      `SELECT id, fig_id, name, kurzname FROM figures
         WHERE book_id = ? AND user_email IS ?
           AND (name LIKE ? OR kurzname LIKE ?)
         ORDER BY CASE WHEN name = ? OR kurzname = ? THEN 0 ELSE 1 END, id
         LIMIT 1`
    ).get(ctx.bookId, userEmail, q, q, input.figur_name, input.figur_name);
  }
  if (!figRow) {
    return { error: 'Figur nicht gefunden', hint: 'Prüfe die Figurenliste im System-Prompt.' };
  }

  const mentions = db.prepare(`
    SELECT p.page_id, p.page_name, p.chapter_id, c.chapter_name, pfm.count, pfm.first_offset
    FROM page_figure_mentions pfm
    JOIN pages p      ON p.page_id = pfm.page_id
    LEFT JOIN chapters c ON c.chapter_id = p.chapter_id AND c.book_id = p.book_id
    WHERE pfm.figure_id = ? AND p.book_id = ?
    ORDER BY p.chapter_id, p.page_id
  `).all(figRow.id, ctx.bookId);

  if (!mentions.length) {
    return {
      fig_id: figRow.fig_id,
      name: figRow.name,
      total_mentions: 0,
      note: 'Keine Index-Erwähnungen vorhanden. Führe Komplettanalyse oder Sync aus, um den Figuren-Index zu aktualisieren.',
    };
  }

  const total = mentions.reduce((s, m) => s + m.count, 0);
  // Erstes Vorkommen
  const first = mentions[0];

  // Nach Kapitel gruppieren
  const byChapter = new Map();
  for (const m of mentions) {
    const key = m.chapter_id ?? 0;
    if (!byChapter.has(key)) byChapter.set(key, { chapter_id: m.chapter_id, chapter_name: m.chapter_name || '(ohne Kapitel)', count: 0, pages: [] });
    const ch = byChapter.get(key);
    ch.count += m.count;
    ch.pages.push({ page_id: m.page_id, page_name: m.page_name, count: m.count });
  }

  return _truncateResult({
    fig_id: figRow.fig_id,
    name: figRow.name,
    total_mentions: total,
    first_appearance: {
      chapter_id: first.chapter_id,
      chapter_name: first.chapter_name || '(ohne Kapitel)',
      page_id: first.page_id,
      page_name: first.page_name,
    },
    by_chapter: [...byChapter.values()],
  });
}

// ── search_passages ───────────────────────────────────────────────────────────

function _buildSearchRegex(pattern, regex) {
  if (!regex) {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(escaped, 'gi');
  }
  // Harte Zeitgrenze gegen ReDoS via AbortSignal beim Match-Loop (siehe tool_search_passages).
  return new RegExp(pattern, 'gi');
}

async function tool_search_passages(input, ctx) {
  const pattern = (input.pattern || '').trim();
  if (!pattern) return { error: 'pattern fehlt' };
  const maxResults = Math.min(Math.max(1, input.max_results || 10), MAX_SEARCH_RESULTS);

  let re;
  try { re = _buildSearchRegex(pattern, !!input.regex); }
  catch (e) { return { error: `Ungültiges Regex-Muster: ${e.message}` }; }

  // Kandidaten: zuerst preview_text (gecacht) scannen. Bei Treffer → page_id merken,
  // bis Limit erreicht ist oder Preview-Scan durch ist.
  const pages = db.prepare(
    'SELECT page_id, page_name, chapter_id, preview_text FROM pages WHERE book_id = ? AND preview_text IS NOT NULL'
  ).all(ctx.bookId);

  const results = [];
  const deadline = Date.now() + 3000; // Hard-Timeout gegen ReDoS

  outer: for (const p of pages) {
    if (Date.now() > deadline) break;
    if (ctx.jobSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(p.preview_text)) !== null) {
      const start = Math.max(0, m.index - SEARCH_SNIPPET_CONTEXT);
      const end   = Math.min(p.preview_text.length, m.index + m[0].length + SEARCH_SNIPPET_CONTEXT);
      results.push({
        page_id:   p.page_id,
        page_name: p.page_name,
        chapter_id: p.chapter_id,
        offset:    m.index,
        match:     m[0],
        snippet:   (start > 0 ? '…' : '') + p.preview_text.slice(start, end) + (end < p.preview_text.length ? '…' : ''),
      });
      if (results.length >= maxResults) break outer;
      // Bei leerem Match (z.B. leerer Regex) Endlosschleife verhindern
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }

  return _truncateResult({
    pattern,
    regex: !!input.regex,
    results,
    note: pages.length === 0
      ? 'Kein Seiten-Cache. Sync ausführen.'
      : 'Suche bisher nur im gecachten Vorschautext (~800 Zeichen pro Seite) – für vollständigen Text get_pages verwenden.',
  });
}

// ── get_pages ─────────────────────────────────────────────────────────────────

async function tool_get_pages(input, ctx) {
  const ids = Array.isArray(input.ids) ? input.ids.filter(n => Number.isInteger(n)) : [];
  if (!ids.length) return { error: 'ids fehlen oder leer' };
  const limit = Math.min(MAX_PAGES_PER_FETCH, ids.length);
  const maxChars = Math.min(MAX_CHARS_PER_PAGE, Math.max(500, input.max_chars_per_page || DEFAULT_CHARS_PER_PAGE));
  const toFetch = ids.slice(0, limit);
  if (!ctx.userToken) {
    return { error: 'Kein BookStack-Token in der Session.' };
  }
  const results = [];
  const missing = [];
  for (const pageId of toFetch) {
    if (ctx.jobSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      const pd = await bsGet(`pages/${pageId}`, ctx.userToken);
      const text = htmlToText(pd.html || '');
      const pageRow = db.prepare('SELECT page_name, chapter_name FROM pages WHERE page_id = ?').get(pageId);
      results.push({
        page_id: pageId,
        page_name: pageRow?.page_name || pd.name || `#${pageId}`,
        chapter_name: pageRow?.chapter_name || null,
        text: text.length > maxChars ? text.slice(0, maxChars) + '…' : text,
        truncated: text.length > maxChars,
      });
    } catch (e) {
      missing.push({ page_id: pageId, error: e.message });
    }
  }
  const dropped = ids.length - toFetch.length;
  return _truncateResult({
    pages: results,
    ...(missing.length ? { missing } : {}),
    ...(dropped > 0 ? { dropped, note: `${dropped} weitere IDs ignoriert (max ${MAX_PAGES_PER_FETCH} pro Aufruf).` } : {}),
  });
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

const TOOLS = {
  list_chapters:       tool_list_chapters,
  count_pronouns:      tool_count_pronouns,
  get_chapter_stats:   tool_get_chapter_stats,
  get_figure_mentions: tool_get_figure_mentions,
  search_passages:     tool_search_passages,
  get_pages:           tool_get_pages,
};

async function executeTool(name, input, ctx) {
  const fn = TOOLS[name];
  if (!fn) throw new Error(`Unbekanntes Werkzeug: ${name}`);
  const result = await fn(input || {}, ctx);
  return _truncateResult(result);
}

module.exports = { executeTool, TOOLS };
