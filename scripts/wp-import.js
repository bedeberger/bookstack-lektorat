#!/usr/bin/env node
// WordPress → BookStack One-Shot-Import aus mysqldump-Datei.
//
// Liest einen WordPress-SQL-Dump, extrahiert Posts (status=publish, type=post)
// + Categories + Term-Relations, sortiert nach post_date_gmt aufsteigend
// (älteste zuerst), bündelt pro Yoast-Primary-Category in BookStack-Kapitel
// und legt sie als Pages im konfigurierten Buch an.
//
// Voraussetzungen
//   .env  → API_HOST, TOKEN_ID, TOKEN_KENNWORT (gleiche Variablen wie App).
//   Buch in BookStack-UI vorab anlegen, ID per --book-id übergeben.
//   mysqldump-Datei (utf8mb4) lokal verfügbar.
//
// Aufruf
//   node scripts/wp-import.js --dump dump.sql --book-id 42
//
//   Optional:
//     --prefix wp_              (Default wp_; manche Installs nutzen wpXX_)
//     --dry-run                 (zeigt Plan, schreibt nichts)
//     --limit 5                 (nur N Posts; gut zum Testen)
//     --yes / -y                (Bestätigungsprompt vor Push überspringen)

'use strict';
require('dotenv').config();
const fs = require('fs');
const readline = require('node:readline');
const { parseArgs } = require('node:util');

const API_HOST = (process.env.API_HOST || '').replace(/\/$/, '');
const TOKEN_ID = process.env.TOKEN_ID;
const TOKEN_SECRET = process.env.TOKEN_KENNWORT;

if (!API_HOST || !TOKEN_ID || !TOKEN_SECRET) {
  console.error('FEHLER: API_HOST, TOKEN_ID, TOKEN_KENNWORT in .env setzen.');
  process.exit(1);
}

const args = parseArgs({
  options: {
    'dump':    { type: 'string' },
    'prefix':  { type: 'string', default: 'wp_' },
    'book-id': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    'limit':   { type: 'string' },
    'yes':     { type: 'boolean', short: 'y', default: false }
  },
  strict: true
}).values;

for (const k of ['dump', 'book-id']) {
  if (!args[k]) {
    console.error(`FEHLER: --${k} pflicht.`);
    process.exit(1);
  }
}
if (!/^[a-zA-Z0-9_]+$/.test(args.prefix)) {
  console.error(`FEHLER: --prefix "${args.prefix}" enthält ungültige Zeichen.`);
  process.exit(1);
}
if (!fs.existsSync(args.dump)) {
  console.error(`FEHLER: Dump-Datei "${args.dump}" nicht gefunden.`);
  process.exit(1);
}

const BOOK_ID = parseInt(args['book-id'], 10);
if (!Number.isInteger(BOOK_ID) || BOOK_ID <= 0) {
  console.error('FEHLER: --book-id muss positive Ganzzahl sein.');
  process.exit(1);
}

const LIMIT = args.limit ? parseInt(args.limit, 10) : null;
const DRY = args['dry-run'];
const SKIP_CONFIRM = args.yes;
const P = args.prefix;

const headers = {
  'Authorization': `Token ${TOKEN_ID}:${TOKEN_SECRET}`,
  'Content-Type': 'application/json'
};

async function api(method, pathSuffix, body) {
  const res = await fetch(`${API_HOST}/api${pathSuffix}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${pathSuffix} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

// ──────────────────────────────────────────────────────────────────────────
// SQL-Dump-Parser
// ──────────────────────────────────────────────────────────────────────────

// Liefert Statements (ohne abschliessendes Semikolon) als Async-Iterator.
// Erkennt SQL-Strings ('...'), Backslash-Escapes, /* … */-Blockkommentare und
// Zeilenkommentare (-- / #). Yields jeweils ein Statement, sobald ; ausserhalb
// von Strings/Kommentaren gefunden wird.
async function* statementStream(file) {
  const stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 });
  let buf = '';
  let stmtStart = 0;
  let i = 0;
  let inStr = false;        // innerhalb '...'
  let inLineCom = false;    // -- … oder # …
  let inBlockCom = false;   // /* … */

  for await (const chunk of stream) {
    buf += chunk;
    while (i < buf.length) {
      const c = buf[i];

      if (inLineCom) {
        if (c === '\n') inLineCom = false;
        i++;
        continue;
      }
      if (inBlockCom) {
        if (c === '*' && buf[i + 1] === '/') { inBlockCom = false; i += 2; continue; }
        i++;
        continue;
      }
      if (inStr) {
        if (c === '\\') { i += 2; continue; }
        if (c === "'") {
          if (buf[i + 1] === "'") { i += 2; continue; }
          inStr = false;
        }
        i++;
        continue;
      }

      // outside string/comment
      if (c === "'") { inStr = true; i++; continue; }
      if (c === '-' && buf[i + 1] === '-') { inLineCom = true; i += 2; continue; }
      if (c === '#') { inLineCom = true; i++; continue; }
      if (c === '/' && buf[i + 1] === '*') { inBlockCom = true; i += 2; continue; }

      if (c === ';') {
        yield buf.substring(stmtStart, i);
        stmtStart = i + 1;
      }
      i++;
    }

    // Buffer kürzen: alles bis stmtStart fallen lassen
    if (stmtStart > 0) {
      buf = buf.substring(stmtStart);
      i -= stmtStart;
      stmtStart = 0;
    }
  }
  if (buf.trim()) yield buf;
}

// Zerlegt eine MySQL-Tuple-Liste "(1,'a'),(2,'b'),..." in einzelne Tuple-Bodies.
// Liefert für jeden Tuple das geparste Wert-Array.
function* parseInsertValues(valuesBody) {
  let i = 0;
  const n = valuesBody.length;
  while (i < n) {
    while (i < n && valuesBody[i] !== '(') i++;
    if (i >= n) break;
    i++; // skip (
    const start = i;
    let depth = 1;
    let inStr = false;
    while (i < n && depth > 0) {
      const c = valuesBody[i];
      if (inStr) {
        if (c === '\\') { i += 2; continue; }
        if (c === "'") {
          if (valuesBody[i + 1] === "'") { i += 2; continue; }
          inStr = false;
          i++;
          continue;
        }
        i++;
        continue;
      }
      if (c === "'") { inStr = true; i++; continue; }
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) break;
      }
      i++;
    }
    yield parseTuple(valuesBody.substring(start, i));
    i++; // skip )
  }
}

// Parst einen Tuple-Body wie "1,'foo\'bar',NULL,'x'" → [1, "foo'bar", null, "x"].
function parseTuple(s) {
  const out = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    while (i < n && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r')) i++;
    if (i >= n) break;

    if (s[i] === "'") {
      i++;
      let val = '';
      while (i < n) {
        const c = s[i];
        if (c === '\\') {
          const next = s[i + 1];
          if (next === 'n') val += '\n';
          else if (next === 'r') val += '\r';
          else if (next === 't') val += '\t';
          else if (next === '0') val += '\0';
          else if (next === 'Z') val += '\x1a';
          else if (next === 'b') val += '\b';
          else if (next === '\\') val += '\\';
          else if (next === "'") val += "'";
          else if (next === '"') val += '"';
          else val += next;
          i += 2;
        } else if (c === "'") {
          if (s[i + 1] === "'") { val += "'"; i += 2; }
          else { i++; break; }
        } else {
          val += c;
          i++;
        }
      }
      out.push(val);
    } else {
      let val = '';
      while (i < n && s[i] !== ',') { val += s[i]; i++; }
      const t = val.trim();
      if (t.toUpperCase() === 'NULL') out.push(null);
      else if (/^-?\d+$/.test(t)) out.push(parseInt(t, 10));
      else if (/^-?\d*\.\d+$/.test(t)) out.push(parseFloat(t));
      else out.push(t);
    }

    while (i < n && s[i] !== ',') i++;
    if (i < n && s[i] === ',') i++;
  }
  return out;
}

// Extrahiert Spaltennamen aus CREATE TABLE-Body (zwischen erstem ( und letztem )).
function extractColumns(createSql) {
  const cols = [];
  const open = createSql.indexOf('(');
  if (open < 0) return cols;
  const body = createSql.substring(open + 1);
  const lines = body.split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith(')')) continue;
    const m = t.match(/^`([^`]+)`/);
    if (!m) continue;
    const name = m[1];
    // KEY/PRIMARY KEY etc. Zeilen beginnen nicht mit Backtick → bereits gefiltert
    cols.push(name);
  }
  return cols;
}

const TABLES = ['posts', 'postmeta', 'terms', 'term_taxonomy', 'term_relationships'];

async function parseDump(file) {
  const wantedCreate = new Map(TABLES.map(t => [P + t, t]));
  const colsByTable = {};
  const rowsByTable = Object.fromEntries(TABLES.map(t => [t, []]));

  let count = 0;
  for await (const stmt of statementStream(file)) {
    count++;
    const trimmed = stmt.trim();
    if (!trimmed) continue;

    // CREATE TABLE
    const cm = trimmed.match(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`([^`]+)`/i);
    if (cm) {
      const tbl = cm[1];
      if (wantedCreate.has(tbl)) {
        const key = wantedCreate.get(tbl);
        colsByTable[key] = extractColumns(trimmed);
      }
      continue;
    }

    // INSERT INTO `wp_xxx` [(...cols...)] VALUES (...),(...);
    const im = trimmed.match(/^INSERT\s+INTO\s+`([^`]+)`(?:\s*\(([^)]+)\))?\s+VALUES\s*/i);
    if (!im) continue;
    const tbl = im[1];
    if (!wantedCreate.has(tbl)) continue;
    const key = wantedCreate.get(tbl);

    let cols = colsByTable[key];
    if (im[2]) {
      cols = im[2].split(',').map(s => s.trim().replace(/^`|`$/g, ''));
    }
    if (!cols || cols.length === 0) {
      console.warn(`WARN: keine Spalten für ${tbl} bekannt — INSERT übersprungen.`);
      continue;
    }

    const valuesBody = trimmed.substring(im[0].length);
    for (const tuple of parseInsertValues(valuesBody)) {
      const row = {};
      for (let k = 0; k < cols.length; k++) row[cols[k]] = tuple[k];
      rowsByTable[key].push(row);
    }
  }

  console.log(`SQL-Statements gelesen: ${count}`);
  for (const t of TABLES) {
    console.log(`  ${P}${t}: ${rowsByTable[t].length} Rows`);
  }
  return rowsByTable;
}

// ──────────────────────────────────────────────────────────────────────────
// JOIN: Posts → chapter, all_cats
// ──────────────────────────────────────────────────────────────────────────

function joinPosts(tables) {
  // term_id → name
  const termName = new Map();
  for (const t of tables.terms) termName.set(Number(t.term_id), t.name);

  // term_taxonomy_id → { term_id, taxonomy }
  const ttById = new Map();
  for (const tt of tables.term_taxonomy) {
    ttById.set(Number(tt.term_taxonomy_id), { term_id: Number(tt.term_id), taxonomy: tt.taxonomy });
  }

  // post_id → primary term_id (Yoast)
  const yoastByPost = new Map();
  for (const m of tables.postmeta) {
    if (m.meta_key === '_yoast_wpseo_primary_category') {
      const termId = parseInt(m.meta_value, 10);
      if (Number.isInteger(termId)) yoastByPost.set(Number(m.post_id), termId);
    }
  }

  // post_id → [category-Namen]  (deterministisch sortiert)
  const catsByPost = new Map();
  for (const r of tables.term_relationships) {
    const tt = ttById.get(Number(r.term_taxonomy_id));
    if (!tt || tt.taxonomy !== 'category') continue;
    const name = termName.get(tt.term_id);
    if (!name) continue;
    const pid = Number(r.object_id);
    if (!catsByPost.has(pid)) catsByPost.set(pid, []);
    catsByPost.get(pid).push(name);
  }
  for (const arr of catsByPost.values()) arr.sort();

  const out = [];
  for (const p of tables.posts) {
    if (p.post_status !== 'publish' || p.post_type !== 'post') continue;
    const pid = Number(p.ID);
    const all = catsByPost.get(pid) || [];

    let chapter = null;
    const yoastTermId = yoastByPost.get(pid);
    if (yoastTermId != null) chapter = termName.get(yoastTermId) || null;
    if (!chapter && all.length) chapter = all[0];
    if (!chapter) chapter = 'Unkategorisiert';

    out.push({
      ID: pid,
      post_title: p.post_title,
      post_name: p.post_name,
      post_date_gmt: p.post_date_gmt,
      post_content: p.post_content,
      chapter,
      all_cats: all
    });
  }

  out.sort((a, b) => String(a.post_date_gmt).localeCompare(String(b.post_date_gmt)));
  return LIMIT ? out.slice(0, LIMIT) : out;
}

// ──────────────────────────────────────────────────────────────────────────
// HTML-Cleanup
// ──────────────────────────────────────────────────────────────────────────

function cleanHtml(raw) {
  if (!raw) return '';
  let html = String(raw);

  html = html.replace(/<!--\s*\/?wp:[^>]*-->/g, '');
  html = html.replace(/\[caption[^\]]*\](.*?)\[\/caption\]/gs, '$1');
  html = html.replace(/\[\/?[a-zA-Z][a-zA-Z0-9_-]*[^\]]*\]/g, m =>
    `<pre class="wp-shortcode">${m.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</pre>`
  );

  const blockTagRe = /^<(p|div|h[1-6]|ul|ol|li|blockquote|pre|figure|table|tr|td|th|thead|tbody|tfoot|section|article|header|footer|aside|nav|hr|br|img)\b/i;
  const parts = html.split(/\n{2,}/);
  html = parts.map(part => {
    const trim = part.trim();
    if (!trim) return '';
    if (blockTagRe.test(trim)) return trim;
    return `<p>${trim.replace(/\n/g, '<br>')}</p>`;
  }).join('\n');

  return html;
}

// ──────────────────────────────────────────────────────────────────────────
// BookStack-Push
// ──────────────────────────────────────────────────────────────────────────

function buildTags(row) {
  const date = String(row.post_date_gmt || '').slice(0, 10);
  const tags = [
    { name: 'wp-id', value: String(row.ID) },
    { name: 'wp-slug', value: row.post_name || '' },
    { name: 'wp-date', value: date }
  ];
  for (const c of row.all_cats) {
    if (c !== row.chapter) tags.push({ name: 'category', value: c });
  }
  return tags;
}

async function ensureChapters(chapterNames) {
  const map = new Map();
  for (let i = 0; i < chapterNames.length; i++) {
    const name = chapterNames[i];
    if (DRY) {
      map.set(name, { id: -(i + 1), priority: (i + 1) * 10, name });
      continue;
    }
    const r = await api('POST', '/chapters', {
      book_id: BOOK_ID,
      name,
      priority: (i + 1) * 10
    });
    map.set(name, { id: r.id, priority: r.priority, name });
    console.log(`  Chapter angelegt: "${name}" (id=${r.id})`);
  }
  return map;
}

function pageTitle(row) {
  const date = String(row.post_date_gmt || '').slice(0, 10);
  const base = row.post_title || `(ohne Titel) ${row.ID}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date} ${base}` : base;
}

async function pushPage(row, chapterId, priority) {
  const html = cleanHtml(row.post_content);
  const body = {
    chapter_id: chapterId,
    name: pageTitle(row),
    html,
    priority,
    tags: buildTags(row)
  };
  if (DRY) return { id: -row.ID, ...body };
  return api('POST', '/pages', body);
}

function confirm(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => {
      rl.close();
      resolve(/^(j|ja|y|yes)$/i.test(answer.trim()));
    });
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`WP→BookStack Import ${DRY ? '(DRY-RUN)' : ''}`);
  console.log(`  Dump: ${args.dump}`);
  console.log(`  Prefix: ${P}`);
  console.log(`  BookStack: ${API_HOST} → Buch ${BOOK_ID}`);
  console.log(`  Limit: ${LIMIT ?? 'alle'}`);
  console.log('');

  const tables = await parseDump(args.dump);
  const posts = joinPosts(tables);

  console.log('');
  console.log(`Posts importierbar (publish, post): ${posts.length}`);
  if (!posts.length) {
    console.log('Nichts zu importieren.');
    return;
  }

  const chapterOrder = [];
  const seen = new Set();
  for (const p of posts) {
    if (!seen.has(p.chapter)) {
      seen.add(p.chapter);
      chapterOrder.push(p.chapter);
    }
  }

  console.log(`Importplan — ${chapterOrder.length} Kapitel, ${posts.length} Seiten:`);
  console.log('');
  for (const c of chapterOrder) {
    const inCh = posts.filter(p => p.chapter === c);
    console.log(`  ▸ ${c} (${inCh.length} Seiten)`);
    for (const p of inCh) {
      console.log(`      ${pageTitle(p)}`);
    }
    console.log('');
  }

  if (!DRY && !SKIP_CONFIRM) {
    const ok = await confirm('Importieren? [j/N] ');
    if (!ok) {
      console.log('Abgebrochen.');
      return;
    }
    console.log('');
  }

  const chapterMap = await ensureChapters(chapterOrder);

  const perChapterCount = new Map();
  let ok = 0, fail = 0;
  for (let i = 0; i < posts.length; i++) {
    const row = posts[i];
    const ch = chapterMap.get(row.chapter);
    const localIdx = (perChapterCount.get(row.chapter) || 0) + 1;
    perChapterCount.set(row.chapter, localIdx);
    const priority = localIdx * 10;
    try {
      const r = await pushPage(row, ch.id, priority);
      ok++;
      console.log(`  [${i + 1}/${posts.length}] ${String(row.post_date_gmt).slice(0, 10)}  ${row.chapter}  →  "${row.post_title}" (id=${r.id})`);
    } catch (e) {
      fail++;
      console.error(`  [${i + 1}/${posts.length}] FEHLER bei wp-id=${row.ID}: ${e.message}`);
    }
  }

  console.log('');
  console.log(`Fertig. OK: ${ok}, Fehler: ${fail}${DRY ? ' (DRY-RUN, nichts geschrieben)' : ''}.`);
}

main().catch(e => {
  console.error('Abbruch:', e);
  process.exit(1);
});
