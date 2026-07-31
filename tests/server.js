// Statischer Mini-Server für Playwright. Liefert public/ und tests/ aus,
// damit die Harness-HTMLs die Module per ESM laden können. Zusätzlich liefert
// er deterministische Mocks für die Job-Queue-Endpoints (/jobs/check,
// /jobs/:id), das Content-Repo (/content/pages/:id) und den History-Endpoint
// (/history/check/:id/saved), die das Lektorat-Harness braucht. Das ist
// bewusst kein echter Mini-Express – ein Roh-HTTP-Dispatch reicht und hält
// das Setup ohne Extra-Dependencies.

const http = require('http');
const fs = require('fs');
const path = require('path');
// Echte PDF-Default-Config, damit der Mock-Profile-POST dieselbe vollstaendige
// Struktur liefert wie die Produktion — sonst rendert die pdfExportCard gegen
// fehlende Felder (marginsMm/bodyInsetMm/font[role] …) und wirft Alpine-Errors.
const { defaultConfig } = require('../lib/pdf-export-defaults');

const PORT = 8765;
const ROOT = path.resolve(__dirname, '..');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg':  'image/svg+xml',
};

// ── Mock-State ────────────────────────────────────────────────────────────
// Jeder neue Job wird mit einem Szenario aus dem POST-Body erzeugt. Szenarien
// liefern fest verdrahtete Responses, damit die Tests rein deterministisch
// bleiben. `pollsSeen` zählt GET /jobs/:id-Aufrufe: der erste Poll gibt
// „running" zurück, der zweite den Endzustand – so wird das State-Machine-
// Verhalten des Frontends (startCheckPoll) realistisch durchlaufen.
const jobs = new Map();
let jobSeq = 0;
let lastBsPut = null;
let lastHistoryPatch = null;
let pdfProfiles = [];
let pdfProfileSeq = 0;

// Publication-Tab + EPUB-Export-Mock-State.
let publication = {};       // bookId -> { …meta, has_cover, has_author_image }
let epubJobSeq = 0;
let lastPubPut = null;
const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const ORIGINAL_HTML = '<p>Der Jungen ging in den Walld. Die Sonne scheinet hell.</p>';

// Fremd-Write-Szenario: der Seitenstand, den ein ZWEITGERAET waehrend der
// laufenden Analyse geschrieben hat. Der erste Satz ist neu formuliert (das
// Finding auf «Walld» ist damit hinfaellig), der zweite ist unveraendert (die
// Findings auf «scheinet» und «Die» ueberleben wortgleich).
const REWRITTEN_HTML = '<p>Der Junge lief zum Fluss. Die Sonne scheinet hell.</p>';

// Aktueller Seitenstand, den GET /content/pages/:id ausliefert. Das
// `stale`-Szenario schaltet ihn beim Job-Start auf REWRITTEN_HTML + neuen
// Stempel um — simuliert „Mac-Client pusht, waehrend der Job laeuft".
const PAGE_INITIAL = { html: ORIGINAL_HTML, updated_at: '2026-07-31T10:00:00.000Z' };
let pageState = { ...PAGE_INITIAL };

const SCENARIOS = {
  ok: () => ({
    status: 'done',
    progress: 100,
    result: {
      fehler: [
        { typ: 'rechtschreibung', original: 'Walld',   korrektur: 'Wald',   erklaerung: 'Tippfehler' },
        { typ: 'grammatik',       original: 'scheinet', korrektur: 'scheint', erklaerung: 'Konjugation' },
        { typ: 'wiederholung',    original: 'Die',      korrektur: 'Eine',    erklaerung: 'Wortwiederholung' },
      ],
      szenen: [],
      stilanalyse: null,
      fazit: null,
      originalHtml: ORIGINAL_HTML,
      pageName: 'Testseite',
      checkId: 4711,
      tokensIn: 100, tokensOut: 50,
    },
  }),
  empty: () => ({
    status: 'done', progress: 100,
    result: { empty: true },
  }),
  // Wie `ok`, aber der Job-Snapshot ist veraltet: `updatedAt` traegt den Stempel
  // VON VOR dem Fremd-Write, waehrend GET /content/pages/:id inzwischen
  // REWRITTEN_HTML + neuen Stempel liefert. Erwartetes Client-Verhalten: die
  // Findings werden gegen den frischen Text refiltert (2 von 3 ueberleben), nicht
  // pauschal verworfen.
  stale: () => ({
    status: 'done',
    progress: 100,
    result: {
      fehler: [
        { typ: 'rechtschreibung', original: 'Walld',   korrektur: 'Wald',   erklaerung: 'Tippfehler' },
        { typ: 'grammatik',       original: 'scheinet', korrektur: 'scheint', erklaerung: 'Konjugation' },
        { typ: 'wiederholung',    original: 'Die',      korrektur: 'Eine',    erklaerung: 'Wortwiederholung' },
      ],
      szenen: [],
      stilanalyse: null,
      fazit: null,
      originalHtml: ORIGINAL_HTML,
      updatedAt: PAGE_INITIAL.updated_at,
      pageName: 'Testseite',
      checkId: 4712,
      tokensIn: 100, tokensOut: 50,
    },
  }),
  error: () => ({
    status: 'error', progress: 0,
    error: 'job.error.fehlerArrayMissing',
  }),
};

function buildJobResponse(job) {
  // Poll 1: running. Ab Poll 2: Endzustand laut Szenario.
  if (job.pollsSeen < 1) {
    return { status: 'running', progress: 50, statusText: 'job.phase.aiAnalyzing' };
  }
  return SCENARIOS[job.scenario]();
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
  });
}

async function handleMockRoute(req, res, urlPath) {
  // POST /jobs/check → neuen Mock-Job anlegen.
  if (req.method === 'POST' && urlPath === '/jobs/check') {
    const body = await readBody(req);
    let payload = {};
    try { payload = body ? JSON.parse(body) : {}; } catch (_) {}
    const scenario = SCENARIOS[payload._scenario] ? payload._scenario : 'ok';
    // Fremd-Write simulieren: ab Job-Start liefert der Content-Endpoint den
    // neuen Stand, waehrend das Job-Result den alten Snapshot traegt.
    if (scenario === 'stale') {
      pageState = { html: REWRITTEN_HTML, updated_at: '2026-07-31T10:05:00.000Z' };
    }
    const jobId = 'mock-' + (++jobSeq);
    jobs.set(jobId, { scenario, pollsSeen: 0 });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jobId }));
    return true;
  }

  // GET /jobs/:id → State-Machine, 1. Poll running, danach Endzustand.
  const jobMatch = urlPath.match(/^\/jobs\/(mock-\d+)$/);
  if (jobMatch && req.method === 'GET') {
    const job = jobs.get(jobMatch[1]);
    if (!job) { res.writeHead(404); return res.end('not found'); }
    const payload = buildJobResponse(job);
    job.pollsSeen++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
    return true;
  }

  // Content-Repo-Mock: GET liefert dieselbe HTML wie das Lektorat-Result,
  // PUT bestätigt den Speichervorgang und merkt den Body für Assertions.
  const pageMatch = urlPath.match(/^\/content\/pages\/\d+$/);
  if (pageMatch) {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 1, html: pageState.html, name: 'Testseite', updated_at: pageState.updated_at }));
      return true;
    }
    if (req.method === 'PUT') {
      const body = await readBody(req);
      try { lastBsPut = JSON.parse(body); } catch (_) { lastBsPut = null; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 1, ...lastBsPut }));
      return true;
    }
  }

  // Booksettings-Mock: runQuoteNormalizeHtml (lektorat saveCorrections, sobald
  // $store.nav.selectedBookId gesetzt ist) lädt die Buch-Locale für die
  // Quote-Normalisierung. Liefert eine gültige Locale → kein 404-console.error.
  if (urlPath.match(/^\/booksettings\/\d+$/) && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ language: 'de', region: 'CH' }));
    return true;
  }

  // History-Endpoint: Lektorat patched nach saveCorrections die applied/selected-Listen.
  if (urlPath.match(/^\/history\/check\/\d+\/saved$/) && req.method === 'PATCH') {
    const body = await readBody(req);
    try { lastHistoryPatch = JSON.parse(body); } catch (_) { lastHistoryPatch = null; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
    return true;
  }

  // ── PDF-Export-Mocks für E2E-Tests ──────────────────────────────────────
  // Eigener Reset nur für pdf-profiles, damit Parallel-Lauf mit anderen
  // Specs (lektorat) den Job-State nicht löscht.
  if (urlPath === '/__mock/pdf-reset' && req.method === 'POST') {
    pdfProfiles = [];
    pdfProfileSeq = 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
    return true;
  }
  if (urlPath === '/pdf-export/fonts' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ fonts: [
      { family: 'Lora',             category: 'serif', weights: [400, 700], styles: ['normal','italic'] },
      { family: 'Playfair Display', category: 'display', weights: [400, 700], styles: ['normal'] },
    ]}));
    return true;
  }
  if (urlPath.match(/^\/pdf-export\/profiles(\?.*)?$/) && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ profiles: pdfProfiles }));
    return true;
  }
  if (urlPath === '/pdf-export/profiles' && req.method === 'POST') {
    const body = await readBody(req);
    let payload = {};
    try { payload = JSON.parse(body); } catch {}
    const id = ++pdfProfileSeq;
    const profile = {
      id, book_id: payload.book_id || 0, user_email: 'test@x',
      name: payload.name || 'Profil', config: defaultConfig(),
      is_default: false, has_cover: false, has_back_cover: false,
    };
    pdfProfiles.push(profile);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(profile));
    return true;
  }
  const profileMatch = urlPath.match(/^\/pdf-export\/profiles\/(\d+)$/);
  if (profileMatch && req.method === 'GET') {
    const p = pdfProfiles.find(x => x.id === parseInt(profileMatch[1]));
    if (!p) { res.writeHead(404); return res.end('{}'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(p));
    return true;
  }
  if (profileMatch && req.method === 'DELETE') {
    const idx = pdfProfiles.findIndex(x => x.id === parseInt(profileMatch[1]));
    if (idx >= 0) pdfProfiles.splice(idx, 1);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
    return true;
  }

  // /languagetool/check Mock fuer Spellcheck-E2E-Specs.
  // Liefert deterministische Matches: jedes Vorkommen von "Walld" -> Tippfehler,
  // "scheinet" -> Grammatik. Body { text } UTF-8 JSON.
  if (urlPath === '/languagetool/check' && req.method === 'POST') {
    const body = await readBody(req);
    let p = {};
    try { p = JSON.parse(body); } catch {}
    const text = typeof p.text === 'string' ? p.text : '';
    const matches = [];
    let i = 0;
    while ((i = text.indexOf('Walld', i)) >= 0) {
      matches.push({
        message: 'Tippfehler', shortMessage: 'Tippfehler',
        offset: i, length: 5,
        rule: { id: 'GERMAN_SPELLER_RULE', category: { id: 'TYPOS', name: 'Rechtschreibung' } },
        replacements: [{ value: 'Wald' }, { value: 'Wand' }],
        context: { text: text.slice(Math.max(0, i - 5), i + 10), offset: Math.min(5, i), length: 5 },
      });
      i += 5;
    }
    i = 0;
    while ((i = text.indexOf('scheinet', i)) >= 0) {
      matches.push({
        message: 'Falsche Konjugation', shortMessage: 'Grammatik',
        offset: i, length: 8,
        rule: { id: 'GRAMMAR_RULE', category: { id: 'GRAMMAR', name: 'Grammatik' } },
        replacements: [{ value: 'scheint' }],
        context: { text: text.slice(Math.max(0, i - 5), i + 13), offset: Math.min(5, i), length: 8 },
      });
      i += 8;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ matches, language: { code: 'de-DE' } }));
    return true;
  }

  // /stt/transcribe Mock fuer STT-Diktat-E2E. Liest das Audio-Binary (egal
  // welches), liefert deterministisches Transkript. enabled-Guard simuliert via
  // ?bookId — irrelevant; gibt immer { text }.
  if (urlPath.startsWith('/stt/transcribe') && req.method === 'POST') {
    await readBody(req); // Audio-Binary konsumieren + verwerfen
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ text: 'Hallo Welt' }));
    return true;
  }

  // ── Publication-Tab + EPUB-Export-Mocks ─────────────────────────────────
  if (urlPath === '/__mock/publication-reset' && req.method === 'POST') {
    publication = {}; epubJobSeq = 0; lastPubPut = null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
    return true;
  }
  const pubMatch = urlPath.match(/^\/publication\/(\d+)$/);
  if (pubMatch) {
    const id = pubMatch[1];
    const base = { book_id: Number(id), isbn: '', subtitle: '', year: '', dedication: '', imprint: '', copyright: '', frontmatter: '', author_bio: '', epub_css_style: 'serif', epub_justify: true, epub_toc_title: '', has_cover: false, has_author_image: false };
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...base, ...(publication[id] || {}) }));
      return true;
    }
    if (req.method === 'PUT') {
      const body = await readBody(req);
      try { lastPubPut = JSON.parse(body); } catch { lastPubPut = null; }
      publication[id] = { ...(publication[id] || {}), ...(lastPubPut || {}), epub_justify: !!(lastPubPut?.epub_justify === 1 || lastPubPut?.epub_justify === true) };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...base, ...publication[id] }));
      return true;
    }
  }
  const pubImgMatch = urlPath.match(/^\/publication\/(\d+)\/(cover|author-image)$/);
  if (pubImgMatch) {
    const id = pubImgMatch[1];
    const key = pubImgMatch[2] === 'cover' ? 'has_cover' : 'has_author_image';
    publication[id] = publication[id] || {};
    if (req.method === 'POST')   { publication[id][key] = true;  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, mime: 'image/jpeg' })); return true; }
    if (req.method === 'DELETE') { publication[id][key] = false; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return true; }
    if (req.method === 'GET') {
      if (!publication[id][key]) { res.writeHead(404); return res.end('{}'); }
      res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(PNG_1x1); return true;
    }
  }
  if (urlPath === '/jobs/epub-export' && req.method === 'POST') {
    const jobId = 'epub-' + (++epubJobSeq);
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jobId }));
    return true;
  }
  if (urlPath.match(/^\/jobs\/epub-\d+$/) && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'done', progress: 100, result: { ready: true, filename: 'book.epub', mime: 'application/epub+zip' } }));
    return true;
  }
  if (urlPath.match(/^\/jobs\/epub-export\/epub-\d+\/file$/) && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/epub+zip', 'Content-Disposition': 'attachment; filename="book.epub"' });
    res.end(Buffer.from('PKepub-mock-bytes'));
    return true;
  }

  // Inspect-Endpoint für die Tests: aktuelle Mock-State-Werte.
  if (urlPath === '/__mock/state' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ lastBsPut, lastHistoryPatch, lastPubPut }));
    return true;
  }

  // Reset für beforeEach.
  if (urlPath === '/__mock/reset' && req.method === 'POST') {
    jobs.clear();
    jobSeq = 0;
    lastBsPut = null;
    lastHistoryPatch = null;
    pageState = { ...PAGE_INITIAL };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
    return true;
  }

  return false;
}

function serveStatic(req, res, urlPath) {
  const filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

// Keep-Alive bleibt aktiv: jede Harness lädt Dutzende ESM-Module, und mit
// `Connection: close` käme pro Datei ein neuer TCP-Handshake — unter 4 parallelen
// CI-Workern ein Connection-Storm, der einzelne Requests stallt und `page.goto`
// (waitUntil 'load' wartet auf alle Subresources) bis zum 60s-Timeout hängt.
// ECONNRESET ("socket hang up") wird stattdessen über grosszügige Keep-Alive-/
// Headers-Timeouts vermieden (unten), die länger leben als Playwrights Socket-Reuse.
const server = http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  try {
    const handled = await handleMockRoute(req, res, urlPath);
    if (!handled) serveStatic(req, res, urlPath);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('server error: ' + e.message);
  }
});
server.keepAliveTimeout = 70_000;
server.headersTimeout = 75_000;
server.listen(PORT, () => console.log(`test server on :${PORT}`));
