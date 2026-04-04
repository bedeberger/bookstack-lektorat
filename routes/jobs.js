'use strict';
const express = require('express');
const { randomUUID } = require('crypto');
const logger = require('../logger');
const { db, saveFigurenToDb } = require('../db/schema');

const router = express.Router();
const jsonBody = express.json();

// ── Job store ─────────────────────────────────────────────────────────────────
// key: jobId → { id, type, bookId, status, progress, statusText, result, error }
const jobs = new Map();
// key: `${type}:${bookId}` → jobId  (verhindert Doppel-Starts)
const runningJobs = new Map();

function fmtTok(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function jobKey(type, bookId, userEmail) {
  return `${type}:${bookId}:${userEmail || ''}`;
}

function createJob(type, bookId, userEmail) {
  const id = randomUUID();
  const key = jobKey(type, bookId, userEmail);
  jobs.set(id, {
    id, type, bookId: String(bookId), userEmail: userEmail || null,
    status: 'running', progress: 0, statusText: '',
    tokensIn: 0, tokensOut: 0,
    maxTokensOut: parseInt(process.env.MODEL_TOKEN, 10) || 64000,
    result: null, error: null,
  });
  runningJobs.set(key, id);
  // Auto-Cleanup nach 2 Stunden
  setTimeout(() => {
    jobs.delete(id);
    if (runningJobs.get(key) === id) runningJobs.delete(key);
  }, 7200000);
  return id;
}

function updateJob(id, updates) {
  const job = jobs.get(id);
  if (job && job.status === 'running') Object.assign(job, updates);
}

function completeJob(id, result) {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, { status: 'done', progress: 100, result });
  runningJobs.delete(jobKey(job.type, job.bookId, job.userEmail));
}

function failJob(id, err) {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, { status: 'error', error: err.message || String(err), progress: 0 });
  runningJobs.delete(jobKey(job.type, job.bookId, job.userEmail));
}

// ── BookStack-Helfer ──────────────────────────────────────────────────────────
const BS_URL = (process.env.API_HOST || process.env.BOOKSTACK_URL || 'http://localhost:80').replace(/\/$/, '');

async function bsGet(path) {
  const resp = await fetch(`${BS_URL}/api/${path}`, {
    headers: { Authorization: `Token ${process.env.TOKEN_ID || ''}:${process.env.TOKEN_KENNWORT || ''}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`BookStack ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

async function bsGetAll(path) {
  let offset = 0;
  const all = [];
  while (true) {
    const sep = path.includes('?') ? '&' : '?';
    const data = await bsGet(`${path}${sep}count=500&offset=${offset}`);
    const items = data.data || [];
    all.push(...items);
    if (all.length >= (data.total || 0) || !items.length) break;
    offset += items.length;
  }
  return all;
}

// ── KI-Aufruf ─────────────────────────────────────────────────────────────────
// Gibt { text, tokensIn, tokensOut } zurück.
// tokensIn/tokensOut: aus Claude message_start/message_delta bzw. Ollama done-Chunk.
// onProgress({ chars, tokIn }): optionaler Callback während des Streamings
//   chars:  akkumulierte Ausgabe-Zeichenanzahl
//   tokIn:  Input-Token-Zahl (bekannt ab message_start; 0 solange noch nicht bekannt)
async function callAI(userPrompt, systemPrompt, onProgress) {
  const provider = process.env.API_PROVIDER || 'claude';

  if (provider === 'ollama') {
    const host = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/$/, '');
    const model = process.env.OLLAMA_MODEL || 'llama3.2';
    const maxTokens = parseInt(process.env.MODEL_TOKEN, 10) || 64000;
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: userPrompt });

    const resp = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true, options: { num_ctx: maxTokens } }),
    });
    if (!resp.ok) throw new Error(`Ollama ${resp.status}: ${await resp.text()}`);

    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '', text = '', tokensIn = 0, tokensOut = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line);
          if (chunk.done) {
            // Letzter Chunk enthält Token-Statistiken
            tokensIn = chunk.prompt_eval_count || 0;
            tokensOut = chunk.eval_count || 0;
          } else {
            text += chunk.message?.content || '';
            if (onProgress) onProgress({ chars: text.length, tokIn: 0 });
          }
        } catch { }
      }
    }
    return { text, tokensIn, tokensOut };
  } else {
    const model = process.env.MODEL_NAME || 'claude-sonnet-4-6';
    const maxTokens = parseInt(process.env.MODEL_TOKEN, 10) || 64000;
    const body = {
      model, max_tokens: maxTokens, temperature: 0.2,
      messages: [{ role: 'user', content: userPrompt }], stream: true,
    };
    if (systemPrompt) body.system = systemPrompt;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`Claude ${resp.status}: ${JSON.stringify(await resp.json())}`);

    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let text = '', buf = '', tokensIn = 0, tokensOut = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6);
        if (raw === '[DONE]') break;
        try {
          const ev = JSON.parse(raw);
          // message_start: Input-Token-Zahl (kommt gleich zu Beginn des Streams)
          if (ev.type === 'message_start' && ev.message?.usage) {
            tokensIn = ev.message.usage.input_tokens || 0;
            if (onProgress) onProgress({ chars: text.length, tokIn: tokensIn });
          }
          // message_delta: Output-Token-Zahl (finaler Wert)
          if (ev.type === 'message_delta' && ev.usage) {
            tokensOut = ev.usage.output_tokens || 0;
          }
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
            text += ev.delta.text;
            if (onProgress) onProgress({ chars: text.length, tokIn: tokensIn });
          }
        } catch { }
      }
    }
    return { text, tokensIn, tokensOut };
  }
}

function parseJSON(text) {
  const clean = text.replace(/```json\s*|```/g, '').trim();
  try { return JSON.parse(clean); } catch {
    const m = clean.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('KI-Antwort konnte nicht als JSON geparst werden');
  }
}

function htmlToText(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
}

const SINGLE_PASS_LIMIT = 60000;
const BATCH_SIZE = 5;

async function loadPageContents(pages, chMap, minLength, onBatch) {
  const contents = [];
  for (let i = 0; i < pages.length; i += BATCH_SIZE) {
    if (onBatch) onBatch(i, pages.length);
    const results = await Promise.allSettled(pages.slice(i, i + BATCH_SIZE).map(async p => {
      const pd = await bsGet('pages/' + p.id);
      const text = htmlToText(pd.html).trim();
      if (text.length < minLength) return null;
      return {
        title: p.name,
        chapter_id: p.chapter_id || null,
        chapter: p.chapter_id ? (chMap[p.chapter_id] || 'Kapitel') : null,
        text,
      };
    }));
    for (const r of results) if (r.status === 'fulfilled' && r.value) contents.push(r.value);
  }
  return contents;
}

function groupByChapter(pageContents) {
  const groupOrder = [], groups = new Map();
  for (const p of pageContents) {
    const key = p.chapter_id != null ? String(p.chapter_id) : '__ungrouped__';
    if (!groups.has(key)) { groupOrder.push(key); groups.set(key, { name: p.chapter || 'Sonstige Seiten', pages: [] }); }
    groups.get(key).pages.push(p);
  }
  return { groupOrder, groups };
}

// ── System-Prompts (gespiegelt von public/js/prompts.js) ─────────────────────
const BASE_RULES = 'SCHWEIZER KONTEXT – STRIKTE REGEL: Im Schweizer Schriftdeutsch wird kein ß verwendet. Deshalb sind alle ss-Schreibungen, die im Deutschen ß wären, korrekte Helvetismen: zerreisst, heisst, weiss, ausserdem, Strasse, gemäss, grösser usw. Diese Wörter sind KEIN FEHLER und dürfen NICHT ins «fehler»-Array. Auch «zerreisst» als Verbform von «zerreissen» ist korrekt. Der Gedankenstrich (–) ist korrekte Schreibweise – NICHT ins «fehler»-Array. Anführungszeichen-Regel: Die Wahl der Anführungszeichen («», „", "", \'\') ist kein Fehler und kein Stilproblem – NICHT ins «fehler»-Array, egal welche Variante verwendet wird. GRUNDREGEL FÜR DAS «fehler»-ARRAY: Ein Eintrag kommt nur rein, wenn er eindeutig, zweifelsfrei und ohne Einschränkung falsch ist. Enthält die Erklärung Formulierungen wie «im Schweizer Kontext akzeptabel», «kein Fehler», «vertretbar», «könnte», «möglicherweise» – dann darf der Eintrag NICHT im Array stehen. Vor jedem Eintrag: Selbsttest – «Ist das im Schweizer Kontext wirklich falsch?» Wenn nein oder unsicher: weglassen. Antworte ausschliesslich mit einem JSON-Objekt – kein Markdown, kein Text davor oder danach.';
const SYSTEM_BUCHBEWERTUNG = `Du bist ein erfahrener Literaturkritiker und Lektor für deutschsprachige Texte aus der Schweiz. ${BASE_RULES}`;
const SYSTEM_KAPITELANALYSE = `Du bist ein erfahrener Literaturkritiker und Lektor für deutschsprachige Texte aus der Schweiz. ${BASE_RULES}`;
const SYSTEM_FIGUREN = `Du bist ein Literaturanalytiker für deutschsprachige Texte aus der Schweiz. ${BASE_RULES}`;

// Hilfsfunktion: callAI aufrufen, Token-Zähler akkumulieren, Job aktualisieren.
// fromPct/toPct: optionaler Fortschrittsbereich – während des Streamings wird der Balken
// von fromPct auf toPct gefüllt (basierend auf akkumulierten Output-Zeichen vs. expectedChars).
async function aiCall(jobId, tok, prompt, system, fromPct, toPct, expectedChars = 3000) {
  const onProgress = ({ chars, tokIn }) => {
    const updates = {};
    // Fortschrittsbalken auf Basis akkumulierter Zeichen
    if (fromPct != null && toPct != null) {
      updates.progress = Math.round(fromPct + (toPct - fromPct) * Math.min(1, chars / expectedChars));
    }
    // Live-Token-Anzeige: tok.in/tok.out = bisherige abgeschlossene Calls;
    // aktueller Call: Input aus message_start, Output approximiert (chars / 4)
    if (tokIn > 0) updates.tokensIn = tok.in + tokIn;
    if (chars > 0) updates.tokensOut = tok.out + Math.floor(chars / 4);
    if (Object.keys(updates).length) updateJob(jobId, updates);
  };
  const { text, tokensIn, tokensOut } = await callAI(prompt, system, onProgress);
  tok.in += tokensIn;
  tok.out += tokensOut;
  updateJob(jobId, { tokensIn: tok.in, tokensOut: tok.out });
  return parseJSON(text);
}

// ── Job: Buchbewertung ────────────────────────────────────────────────────────
async function runReviewJob(jobId, bookId, bookName, userEmail) {
  try {
    updateJob(jobId, { statusText: 'Lade Seiten…', progress: 0 });
    const [chaptersData, pages] = await Promise.all([
      bsGetAll('chapters?book_id=' + bookId),
      bsGetAll('pages?book_id=' + bookId),
    ]);

    if (!pages.length) { completeJob(jobId, { empty: true }); return; }

    const chMap = Object.fromEntries(chaptersData.map(c => [c.id, c.name]));
    const tok = { in: 0, out: 0 }; // akkumulierte Token über alle KI-Calls
    const pageContents = await loadPageContents(pages, chMap, 50, (i, total) => {
      updateJob(jobId, {
        progress: Math.round((i / total) * 60),
        statusText: `Lese ${i + 1}–${Math.min(i + BATCH_SIZE, total)} von ${total} Seiten…`,
      });
    });

    updateJob(jobId, { progress: 65 });
    const totalChars = pageContents.reduce((s, p) => s + p.text.length, 0);
    let r;

    if (totalChars <= SINGLE_PASS_LIMIT) {
      updateJob(jobId, { progress: 65, statusText: 'KI analysiert das Buch…' });
      const bookText = pageContents
        .map(p => `### ${p.chapter ? '[' + p.chapter + '] ' : ''}${p.title}\n${p.text}`)
        .join('\n\n---\n\n');

      r = await aiCall(jobId, tok,
        `Bewerte das folgende Buch «${bookName}» kritisch und umfassend. Analysiere:
- Struktur und Aufbau (Kapitel, Übergänge, Logik)
- Sprachstil und Konsistenz über alle Seiten hinweg
- Stärken des Texts
- Schwächen und Verbesserungspotenzial
- Konkrete Empfehlungen für den Autor

Antworte mit diesem JSON-Schema:
{
  "gesamtnote": "Zahl von 1 (sehr schwach) bis 5 (ausgezeichnet)",
  "gesamtnote_begruendung": "Ein Satz warum diese Note",
  "zusammenfassung": "2-3 Sätze Gesamteindruck",
  "struktur": "Analyse des Aufbaus und der Struktur (3-4 Sätze)",
  "stil": "Analyse des Schreibstils und seiner Konsistenz (3-4 Sätze)",
  "staerken": ["Stärke 1", "Stärke 2", "Stärke 3"],
  "schwaechen": ["Schwäche 1", "Schwäche 2"],
  "empfehlungen": ["Empfehlung 1", "Empfehlung 2", "Empfehlung 3"],
  "fazit": "Abschliessendes Urteil in 1-2 Sätzen"
}

Buchinhalt (${pageContents.length} Seiten):

${bookText}`,
        SYSTEM_BUCHBEWERTUNG,
        65, 97, 5000,
      );
    } else {
      const { groupOrder, groups } = groupByChapter(pageContents);
      const chapterAnalyses = [];

      for (let gi = 0; gi < groupOrder.length; gi++) {
        const group = groups.get(groupOrder[gi]);
        const tokStr = tok.in + tok.out > 0 ? ` · ↑${fmtTok(tok.in)} ↓${fmtTok(tok.out)} Tokens` : '';
        const fromPct = 65 + Math.round((gi / groupOrder.length) * 25);
        const toPct   = 65 + Math.round(((gi + 1) / groupOrder.length) * 25);
        updateJob(jobId, {
          progress: fromPct,
          statusText: `Analysiere ${gi + 1}/${groupOrder.length}: «${group.name}»…${tokStr}`,
        });
        const chText = group.pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n');
        const ca = await aiCall(jobId, tok,
          `Analysiere das Kapitel «${group.name}» aus dem Buch «${bookName}».
Lies den vollständigen Kapiteltext und gib eine kompakte Analyse als JSON zurück:
{
  "themen": "Hauptthemen und Inhalte in 2-3 Sätzen",
  "stil": "Schreibstilbeobachtungen: Wortwahl, Satzbau, Ton in 2 Sätzen",
  "qualitaet": "Allgemeiner Qualitätseindruck in 1-2 Sätzen",
  "staerken": ["konkrete Stärke 1", "konkrete Stärke 2"],
  "schwaechen": ["konkrete Schwäche 1", "konkrete Schwäche 2"]
}

Kapitelinhalt (${group.pages.length} Seiten):

${chText}`,
          SYSTEM_KAPITELANALYSE,
          fromPct, toPct, 1500,
        );
        chapterAnalyses.push({ name: group.name, pageCount: group.pages.length, ...ca });
      }

      updateJob(jobId, {
        progress: 90,
        statusText: `KI erstellt Gesamtbewertung… · ↑${fmtTok(tok.in)} ↓${fmtTok(tok.out)} Tokens`,
      });
      const synthIn = chapterAnalyses.map((ca, i) =>
        `## Kapitel ${i + 1}: ${ca.name} (${ca.pageCount} Seiten)\nThemen: ${ca.themen || '–'}\nStil: ${ca.stil || '–'}\nQualität: ${ca.qualitaet || '–'}\nStärken: ${(ca.staerken || []).join(' | ')}\nSchwächen: ${(ca.schwaechen || []).join(' | ')}`
      ).join('\n\n');

      r = await aiCall(jobId, tok,
        `Bewerte das Buch «${bookName}» kritisch und umfassend.
Grundlage sind die Analysen aller ${chapterAnalyses.length} Kapitel (insgesamt ${pageContents.length} Seiten).

Kapitelanalysen:

${synthIn}

Antworte mit diesem JSON-Schema:
{
  "gesamtnote": "Zahl von 1 (sehr schwach) bis 5 (ausgezeichnet)",
  "gesamtnote_begruendung": "Ein Satz warum diese Note",
  "zusammenfassung": "2-3 Sätze Gesamteindruck",
  "struktur": "Analyse des Aufbaus und der Struktur über alle Kapitel (3-4 Sätze)",
  "stil": "Analyse des Schreibstils und seiner Konsistenz über das gesamte Buch (3-4 Sätze)",
  "staerken": ["Stärke 1", "Stärke 2", "Stärke 3"],
  "schwaechen": ["Schwäche 1", "Schwäche 2"],
  "empfehlungen": ["Empfehlung 1", "Empfehlung 2", "Empfehlung 3"],
  "fazit": "Abschliessendes Urteil in 1-2 Sätzen"
}`,
        SYSTEM_BUCHBEWERTUNG,
        90, 97, 5000,
      );
    }

    if (typeof r?.gesamtnote === 'undefined') throw new Error('KI-Antwort ungültig: gesamtnote fehlt');

    const model = process.env.API_PROVIDER === 'ollama'
      ? (process.env.OLLAMA_MODEL || 'llama3.2')
      : (process.env.MODEL_NAME || 'claude-sonnet-4-6');
    db.prepare('INSERT INTO book_reviews (book_id, book_name, reviewed_at, review_json, model, user_email) VALUES (?, ?, ?, ?, ?, ?)')
      .run(parseInt(bookId), bookName, new Date().toISOString(), JSON.stringify(r), model, userEmail || null);

    completeJob(jobId, { review: r, pageCount: pageContents.length, tokensIn: tok.in, tokensOut: tok.out });
    logger.info(`Job ${jobId}: Buchbewertung Buch ${bookId} abgeschlossen (${fmtTok(tok.in)}↑ ${fmtTok(tok.out)}↓ Tokens).`);
  } catch (e) {
    logger.error(`Job ${jobId}: Buchbewertung Fehler: ${e.message}`);
    failJob(jobId, e);
  }
}

// ── Job: Figurenextraktion ────────────────────────────────────────────────────
async function runFiguresJob(jobId, bookId, bookName, userEmail) {
  const FINAL_SCHEMA = `{
  "figuren": [
    {
      "id": "fig_1",
      "name": "Vollständiger Name",
      "kurzname": "Vorname oder Spitzname",
      "typ": "hauptfigur|nebenfigur|antagonist|mentor|andere",
      "geburtstag": "JJJJ oder leer wenn unbekannt",
      "geschlecht": "männlich|weiblich|divers|unbekannt",
      "beruf": "Beruf oder Rolle oder leer",
      "beschreibung": "2-3 Sätze zu Rolle, Persönlichkeit und Bedeutung",
      "eigenschaften": ["Eigenschaft1", "Eigenschaft2"],
      "kapitel": [{ "name": "Kapitelname", "haeufigkeit": 3 }],
      "beziehungen": [{ "figur_id": "fig_2", "typ": "elternteil|geschwister|kind|freund|feind|kollege|bekannt|liebesbeziehung|rivale|mentor|schuetzling|andere", "beschreibung": "1 Satz" }]
    }
  ]
}`;
  const FINAL_RULES = `Regeln:
- Eindeutige IDs (fig_1, fig_2, …)
- beziehungen.figur_id: nur IDs aus dieser Liste; jede Beziehung nur einmal eintragen
- kapitel: absteigend nach Häufigkeit; haeufigkeit = Anzahl Seiten/Abschnitte mit aktivem Auftreten
- Beziehungstypen: elternteil/kind (gerichtet), geschwister (undirektional), übrige selbsterklärend
- Nur echte Personen/Charaktere, keine Orte oder Objekte
- Sortiert nach Wichtigkeit; maximal 20 Figuren
- KONSERVATIV: Nur Figuren und Beziehungen aufnehmen die im Text eindeutig belegt sind. Lieber weglassen als spekulieren.`;

  try {
    updateJob(jobId, { statusText: 'Lade Seiten…', progress: 0 });
    const [chaptersData, pages] = await Promise.all([
      bsGetAll('chapters?book_id=' + bookId),
      bsGetAll('pages?book_id=' + bookId),
    ]);
    if (!pages.length) { completeJob(jobId, { empty: true }); return; }

    const chMap = Object.fromEntries(chaptersData.map(c => [c.id, c.name]));
    const tok = { in: 0, out: 0 };
    const pageContents = await loadPageContents(pages, chMap, 30, (i, total) => {
      updateJob(jobId, {
        progress: Math.round((i / total) * 55),
        statusText: `Lese ${i + 1}–${Math.min(i + BATCH_SIZE, total)} von ${total} Seiten…`,
      });
    });

    const totalChars = pageContents.reduce((s, p) => s + p.text.length, 0);
    let result;

    if (totalChars <= SINGLE_PASS_LIMIT) {
      updateJob(jobId, { progress: 65, statusText: 'KI analysiert Figuren…' });
      const bookText = pageContents
        .map(p => `### ${p.chapter ? '[' + p.chapter + '] ' : ''}${p.title}\n${p.text}`)
        .join('\n\n---\n\n');
      result = await aiCall(jobId, tok,
        `Analysiere das Buch «${bookName}» und extrahiere alle wichtigen Figuren.\n\nAntworte mit diesem JSON-Schema:\n${FINAL_SCHEMA}\n\n${FINAL_RULES}\n\nBuchtext (${pageContents.length} Seiten):\n\n${bookText}`,
        SYSTEM_FIGUREN,
        65, 96, 6000,
      );
    } else {
      const { groupOrder, groups } = groupByChapter(pageContents);
      const chapterFiguren = [];

      for (let gi = 0; gi < groupOrder.length; gi++) {
        const group = groups.get(groupOrder[gi]);
        const tokStr = tok.in + tok.out > 0 ? ` · ↑${fmtTok(tok.in)} ↓${fmtTok(tok.out)} Tokens` : '';
        const fromPct = 55 + Math.round((gi / groupOrder.length) * 30);
        const toPct   = 55 + Math.round(((gi + 1) / groupOrder.length) * 30);
        updateJob(jobId, {
          progress: fromPct,
          statusText: `Figuren in «${group.name}» (${gi + 1}/${groupOrder.length})…${tokStr}`,
        });
        const chText = group.pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n');
        const chResult = await aiCall(jobId, tok,
          `Extrahiere alle Figuren/Charaktere aus dem Kapitel «${group.name}» des Buchs «${bookName}».
Antworte mit:
{
  "figuren": [
    { "name": "Vollständiger Name", "kurzname": "...", "typ": "hauptfigur|nebenfigur|antagonist|mentor|andere", "beruf": "...", "geburtstag": "JJJJ oder leer", "geschlecht": "männlich|weiblich|divers|unbekannt", "beschreibung": "1-2 Sätze", "eigenschaften": ["..."], "beziehungen": [{ "name": "Name der anderen Figur", "typ": "elternteil|geschwister|kind|freund|feind|kollege|bekannt|liebesbeziehung|rivale|mentor|schuetzling|andere", "beschreibung": "1 Satz" }] }
  ]
}

Nur echte Personen. Sei konservativ: nur Figuren und Beziehungen die im Text eindeutig belegt sind.

Kapiteltext (${group.pages.length} Seiten):\n\n${chText}`,
          SYSTEM_FIGUREN,
          fromPct, toPct, 2000,
        );
        chapterFiguren.push({ kapitel: group.name, figuren: chResult.figuren || [] });
      }

      updateJob(jobId, {
        progress: 88,
        statusText: `KI konsolidiert Figuren… · ↑${fmtTok(tok.in)} ↓${fmtTok(tok.out)} Tokens`,
      });
      const synthInput = chapterFiguren.map(cf =>
        `## Kapitel: ${cf.kapitel}\n` + cf.figuren.map(f =>
          `- ${f.name} (${f.typ})${f.beruf ? ', ' + f.beruf : ''}: ${f.beschreibung || ''}` +
          (f.beziehungen?.length ? '\n  Beziehungen: ' + f.beziehungen.map(b => `${b.name} [${b.typ}]`).join(', ') : '')
        ).join('\n')
      ).join('\n\n');

      result = await aiCall(jobId, tok,
        `Konsolidiere die folgenden Figurenanalysen aller Kapitel des Buchs «${bookName}» zu einer einheitlichen Gesamtliste. Dedupliziere Figuren, führe Informationen zusammen und vergib stabile IDs.

Kapitelanalysen:

${synthInput}

Antworte mit diesem JSON-Schema:
${FINAL_SCHEMA}

${FINAL_RULES}`,
        SYSTEM_FIGUREN,
        88, 96, 6000,
      );
    }

    if (!Array.isArray(result?.figuren)) throw new Error('KI-Antwort ungültig: figuren-Array fehlt');

    const figuren = result.figuren.map((f, i) => ({ ...f, id: f.id || ('fig_' + (i + 1)) }));
    saveFigurenToDb(parseInt(bookId), figuren, userEmail || null);
    completeJob(jobId, { count: figuren.length, tokensIn: tok.in, tokensOut: tok.out });
    logger.info(`Job ${jobId}: Figurenextraktion Buch ${bookId} abgeschlossen (${figuren.length} Figuren, ${fmtTok(tok.in)}↑ ${fmtTok(tok.out)}↓ Tokens).`);
  } catch (e) {
    logger.error(`Job ${jobId}: Figurenextraktion Fehler: ${e.message}`);
    failJob(jobId, e);
  }
}

// ── Routen ────────────────────────────────────────────────────────────────────
router.post('/review', jsonBody, (req, res) => {
  const { book_id, book_name } = req.body;
  if (!book_id) return res.status(400).json({ error: 'book_id fehlt' });
  const userEmail = req.session?.user?.email || null;
  // Laufenden Job zurückgeben statt neu starten
  const existing = runningJobs.get(jobKey('review', book_id, userEmail));
  if (existing && jobs.has(existing)) return res.json({ jobId: existing, existing: true });
  const jobId = createJob('review', book_id, userEmail);
  runReviewJob(jobId, book_id, book_name || '', userEmail)
    .catch(e => logger.error('Unkontrollierter review-Job-Fehler: ' + e.message));
  res.json({ jobId });
});

router.post('/figures', jsonBody, (req, res) => {
  const { book_id, book_name } = req.body;
  if (!book_id) return res.status(400).json({ error: 'book_id fehlt' });
  const userEmail = req.session?.user?.email || null;
  const existing = runningJobs.get(jobKey('figures', book_id, userEmail));
  if (existing && jobs.has(existing)) return res.json({ jobId: existing, existing: true });
  const jobId = createJob('figures', book_id, userEmail);
  runFiguresJob(jobId, book_id, book_name || '', userEmail)
    .catch(e => logger.error('Unkontrollierter figures-Job-Fehler: ' + e.message));
  res.json({ jobId });
});

router.get('/active', (req, res) => {
  const { type, book_id } = req.query;
  if (!type || !book_id) return res.status(400).json({ error: 'type und book_id erforderlich' });
  const userEmail = req.session?.user?.email || null;
  const jobId = runningJobs.get(jobKey(type, book_id, userEmail));
  if (!jobId || !jobs.has(jobId)) return res.json({ jobId: null });
  const job = jobs.get(jobId);
  res.json({ jobId: job.id, status: job.status, progress: job.progress, statusText: job.statusText });
});

router.get('/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job nicht gefunden' });
  res.json({
    id: job.id, type: job.type, status: job.status,
    progress: job.progress, statusText: job.statusText,
    tokensIn: job.tokensIn, tokensOut: job.tokensOut,
    maxTokensOut: job.maxTokensOut,
    result: job.result, error: job.error,
  });
});

module.exports = router;
