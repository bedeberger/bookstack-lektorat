// Statischer Mini-Server für Playwright. Liefert public/ und tests/ aus,
// damit die Harness-HTMLs die Module per ESM laden können. Zusätzlich liefert
// er deterministische Mocks für die Job-Queue-Endpoints (/jobs/check,
// /jobs/:id), den BookStack-Proxy (/api/pages/:id) und den History-Endpoint
// (/history/check/:id/saved), die das Lektorat-Harness braucht. Das ist
// bewusst kein echter Mini-Express – ein Roh-HTTP-Dispatch reicht und hält
// das Setup ohne Extra-Dependencies.

const http = require('http');
const fs = require('fs');
const path = require('path');

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

const ORIGINAL_HTML = '<p>Der Jungen ging in den Walld. Die Sonne scheinet hell.</p>';

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

  // BookStack-Proxy-Mock: GET liefert dieselbe HTML wie das Lektorat-Result,
  // PUT bestätigt den Speichervorgang und merkt den Body für Assertions.
  const pageMatch = urlPath.match(/^\/api\/pages\/\d+$/);
  if (pageMatch) {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 1, html: ORIGINAL_HTML, name: 'Testseite' }));
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

  // History-Endpoint: Lektorat patched nach saveCorrections die applied/selected-Listen.
  if (urlPath.match(/^\/history\/check\/\d+\/saved$/) && req.method === 'PATCH') {
    const body = await readBody(req);
    try { lastHistoryPatch = JSON.parse(body); } catch (_) { lastHistoryPatch = null; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
    return true;
  }

  // Inspect-Endpoint für die Tests: aktuelle Mock-State-Werte.
  if (urlPath === '/__mock/state' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ lastBsPut, lastHistoryPatch }));
    return true;
  }

  // Reset für beforeEach.
  if (urlPath === '/__mock/reset' && req.method === 'POST') {
    jobs.clear();
    jobSeq = 0;
    lastBsPut = null;
    lastHistoryPatch = null;
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

http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  try {
    const handled = await handleMockRoute(req, res, urlPath);
    if (!handled) serveStatic(req, res, urlPath);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('server error: ' + e.message);
  }
}).listen(PORT, () => console.log(`test server on :${PORT}`));
