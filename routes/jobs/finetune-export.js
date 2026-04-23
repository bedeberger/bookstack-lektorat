'use strict';
const express = require('express');
const { createHash } = require('crypto');
const { db, getTokenForRequest, getBookSettings } = require('../../db/schema');
const {
  makeJobLogger, updateJob, completeJob, failJob,
  bsGetAll, loadPageContents,
  jobs, runningJobs, createJob, enqueueJob, jobKey,
  jobAbortControllers, BATCH_SIZE,
  jsonBody,
} = require('./shared');

const finetuneExportRouter = express.Router();

// JSONL-Nutzdaten liegen NICHT in job.result, weil der generische Status-GET
// (/jobs/:id) die gesamte result-Struktur serialisiert — bei einem grossen Buch
// wären das Megabytes pro Poll. Stattdessen: eigener Store, TTL analog zur
// Job-Cleanup (2 h nach Abschluss, siehe shared.js:_scheduleJobCleanup).
const JSONL_TTL_MS = 2 * 60 * 60 * 1000;
const finetuneResultStore = new Map();
function storeFinetuneResult(jobId, payload) {
  finetuneResultStore.set(jobId, payload);
  const t = setTimeout(() => finetuneResultStore.delete(jobId), JSONL_TTL_MS);
  t.unref?.();
}

function hashSplit(id, seed) {
  const h = createHash('sha1').update(String(seed || 0) + '|' + id).digest();
  return ((h[0] << 8) | h[1]) / 0xffff;
}

function splitParagraphs(text) {
  return text.split(/\n\s*\n+/).map(p => p.trim()).filter(Boolean);
}

// Splittet `text` nahe `ratio` (0–1) an einer Satzgrenze. Sucht zuerst rückwärts
// vom Zielindex nach dem letzten Satzende, fällt dann vorwärts zurück.
function splitAtSentence(text, ratio) {
  const target = Math.max(1, Math.min(text.length - 1, Math.floor(text.length * ratio)));
  const head = text.slice(0, target);
  const tail = text.slice(target);
  const lastStop = head.search(/[.!?…][”"«»„"']?\s+[A-ZÄÖÜ"„«][^.!?…]*$/);
  if (lastStop !== -1) {
    const after = head.slice(lastStop).search(/\s/);
    if (after !== -1) {
      const idx = lastStop + after + 1;
      return [text.slice(0, idx).trim(), text.slice(idx).trim()];
    }
  }
  const nextStop = tail.search(/[.!?…][”"«»„"']?\s+[A-ZÄÖÜ"„«]/);
  if (nextStop !== -1) {
    const idx = target + nextStop + 1;
    return [text.slice(0, idx + 1).trim(), text.slice(idx + 1).trim()];
  }
  return [head.trim(), tail.trim()];
}
const splitHalfAtSentence = (text) => splitAtSentence(text, 0.5);

// Dialog-Zitate (DE + EN-Typografie + ASCII). Bewusst konservativ — matched nur
// Zitate innerhalb eines Absatzes (keine Zeilenumbrüche), damit keine
// mehrseitigen False-Positives entstehen.
function extractDialogs(text) {
  const results = [];
  const patterns = [
    /„([^"\n]{10,400})"/g,
    /"([^"\n]{10,400})"/g,     // U+201C/U+201D
    /«\s?([^»\n]{10,400})\s?»/g,
    /"([^"\n]{10,400})"/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      results.push({ quote: m[1].trim(), start: m.index, end: m.index + m[0].length });
    }
  }
  results.sort((a, b) => a.start - b.start);
  return results;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function findSpeaker(text, quoteStart, quoteEnd, figureNames) {
  const ctx = text.slice(Math.max(0, quoteStart - 120), quoteStart)
    + ' ' + text.slice(quoteEnd, quoteEnd + 120);
  for (const name of figureNames) {
    const re = new RegExp('\\b' + escapeRe(name) + '\\b', 'i');
    if (re.test(ctx)) return name;
  }
  return null;
}

async function runFinetuneExportJob(jobId, bookId, bookName, userEmail, userToken, opts) {
  const logger = makeJobLogger(jobId);
  try {
    logger.info(`Start Finetune-Export «${bookName}» (book=${bookId}, types=${Object.entries(opts.types).filter(([,v]) => v).map(([k]) => k).join(',')})`);
    updateJob(jobId, { statusText: 'job.phase.loadingPages', progress: 0 });
    const [chaptersData, pages] = await Promise.all([
      bsGetAll('chapters?filter[book_id]=' + bookId, userToken),
      bsGetAll('pages?filter[book_id]=' + bookId, userToken),
    ]);
    if (!pages.length) { completeJob(jobId, { empty: true }); return; }

    const chMap = Object.fromEntries(chaptersData.map(c => [c.id, c.name]));
    const pageContents = await loadPageContents(pages, chMap, 30, (i, total) => {
      updateJob(jobId, {
        progress: Math.round((i / total) * 40),
        statusText: 'job.phase.readingPages',
        statusParams: { from: i + 1, to: Math.min(i + BATCH_SIZE, total), total },
      });
    }, userToken, jobAbortControllers.get(jobId)?.signal);

    updateJob(jobId, { progress: 45, statusText: 'finetune.phase.loadMetadata' });

    const bookIdInt = parseInt(bookId);
    const settings = getBookSettings(bookIdInt, userEmail);
    const langIsEn = (settings.language || 'de') === 'en';

    const figRows = db.prepare(`
      SELECT f.fig_id, f.id AS pk, f.name, f.kurzname, f.typ, f.beschreibung, f.beruf, f.geschlecht,
             GROUP_CONCAT(DISTINCT ft.tag) AS tags_csv
      FROM figures f
      LEFT JOIN figure_tags ft ON ft.figure_id = f.id
      WHERE f.book_id = ? AND f.user_email = ?
      GROUP BY f.id
      ORDER BY f.sort_order
    `).all(bookIdInt, userEmail);
    const figById = new Map(figRows.map(f => [f.fig_id, f]));
    const figNamesSorted = [...new Set(
      figRows.flatMap(f => [f.name, f.kurzname].filter(n => n && String(n).trim().length >= 2))
    )].sort((a, b) => b.length - a.length);

    const locRows = db.prepare(`
      SELECT loc_id, name, typ, beschreibung, stimmung
      FROM locations
      WHERE book_id = ? AND (user_email = ? OR (? IS NULL AND user_email IS NULL))
      ORDER BY sort_order
    `).all(bookIdInt, userEmail, userEmail);
    const locById = new Map(locRows.map(l => [l.loc_id, l]));

    const sceneRows = db.prepare(`
      SELECT id, kapitel, seite, titel, wertung, kommentar, chapter_id, page_id
      FROM figure_scenes WHERE book_id = ? AND user_email = ?
      ORDER BY sort_order
    `).all(bookIdInt, userEmail);
    const sceneFigRows = db.prepare(
      'SELECT sf.scene_id, sf.fig_id FROM scene_figures sf JOIN figure_scenes fs ON fs.id = sf.scene_id WHERE fs.book_id = ? AND fs.user_email = ?'
    ).all(bookIdInt, userEmail);
    const sceneLocRows = db.prepare(
      'SELECT sl.scene_id, l.loc_id FROM scene_locations sl JOIN locations l ON l.id = sl.location_id JOIN figure_scenes fs ON fs.id = sl.scene_id WHERE fs.book_id = ? AND fs.user_email = ?'
    ).all(bookIdInt, userEmail);
    const figsByScene = new Map();
    for (const r of sceneFigRows) {
      if (!figsByScene.has(r.scene_id)) figsByScene.set(r.scene_id, []);
      figsByScene.get(r.scene_id).push(r.fig_id);
    }
    const locsByScene = new Map();
    for (const r of sceneLocRows) {
      if (!locsByScene.has(r.scene_id)) locsByScene.set(r.scene_id, []);
      locsByScene.get(r.scene_id).push(r.loc_id);
    }
    const pageTextById = new Map(pageContents.map(p => [p.id, p.text]));
    const pageChapterById = new Map(pageContents.map(p => [p.id, p.chapter || '']));

    const minChars = Math.max(80, opts.minChars | 0);
    const maxChars = Math.max(minChars + 100, opts.maxChars | 0);
    const valSplit = Math.max(0, Math.min(0.5, Number.isFinite(opts.valSplit) ? opts.valSplit : 0.1));
    const seed = Number.isFinite(opts.valSeed) ? opts.valSeed : 0;

    const samples = [];
    let styleCount = 0, sceneCount = 0, dialogCount = 0, authorChatCount = 0, correctionCount = 0;

    if (opts.types.style) {
      updateJob(jobId, { progress: 55, statusText: 'finetune.phase.style' });
      const sys = langIsEn
        ? "You are a literary assistant writing in the author's style."
        : 'Du bist ein literarischer Assistent und schreibst im Stil des Autors.';
      const prefix = langIsEn
        ? "Continue the following passage in the author's style:\n\n"
        : 'Setze den folgenden Abschnitt im Stil des Autors fort:\n\n';
      const contextPrefix = langIsEn
        ? "Given this passage, continue in the author's style. Write only the next paragraph:\n\n"
        : 'Setze den folgenden Abschnitt fort. Schreibe nur den nächsten Absatz im Stil des Autors:\n\n';

      // Split-Ratios pro Absatz: 50/50 ist das stärkste Signal (Haupt-Sample),
      // 25/75 und 75/25 ergänzen als augmentierte Varianten (Training-Volumen
      // ×3 bei gleichem Ausgangsmaterial). Verhindert dass das Modell nur
      // „halbierte" Prompt-Länge als Stil-Fortsetzung kennt.
      const splitRatios = [0.50, 0.25, 0.75];

      for (const p of pageContents) {
        const paragraphs = splitParagraphs(p.text);

        // ── Intra-Absatz-Splits (Sliding-Windows) ─────────────────────────
        for (let pi = 0; pi < paragraphs.length; pi++) {
          const para = paragraphs[pi];
          if (para.length < minChars) continue;
          const clipped = para.length > maxChars ? para.slice(0, maxChars) : para;
          for (let ri = 0; ri < splitRatios.length; ri++) {
            const [first, second] = splitAtSentence(clipped, splitRatios[ri]);
            if (first.length < 60 || second.length < 60) continue;
            samples.push({
              id: 'style|' + p.id + '|' + pi + '|r' + ri,
              type: 'style',
              messages: [
                { role: 'system', content: sys },
                { role: 'user', content: prefix + first },
                { role: 'assistant', content: second },
              ],
            });
            styleCount++;
          }
        }

        // ── Multi-Absatz-Kontext (Langstrecken-Kohärenz) ──────────────────
        // Prompt = vorhergehende 1–3 Absätze, Completion = nächster Absatz.
        // Teaches long-range coherence so dass Fortsetzungen über Absätze
        // hinweg klingen wie der Autor. Überspringt Einträge, wenn der
        // Prompt-Kontext zu kurz oder zu lang ist.
        const CTX_MAX_PROMPT = Math.floor(maxChars * 2);
        for (let i = 1; i < paragraphs.length; i++) {
          const next = paragraphs[i];
          if (next.length < minChars) continue;
          const ctxStart = Math.max(0, i - 3);
          const context = paragraphs.slice(ctxStart, i).join('\n\n');
          if (context.length < 200) continue;
          const ctxClipped = context.length > CTX_MAX_PROMPT
            ? context.slice(context.length - CTX_MAX_PROMPT)
            : context;
          const completion = next.length > maxChars ? next.slice(0, maxChars) : next;
          if (completion.length < 80) continue;
          samples.push({
            id: 'styleCtx|' + p.id + '|' + i,
            type: 'style',
            messages: [
              { role: 'system', content: sys },
              { role: 'user', content: contextPrefix + ctxClipped },
              { role: 'assistant', content: completion },
            ],
          });
          styleCount++;
        }
      }
    }

    if (opts.types.scene) {
      updateJob(jobId, { progress: 70, statusText: 'finetune.phase.scene' });
      const scenesByPageId = new Map();
      for (const s of sceneRows) {
        if (!s.page_id) continue;
        if (!scenesByPageId.has(s.page_id)) scenesByPageId.set(s.page_id, []);
        scenesByPageId.get(s.page_id).push(s);
      }
      const sys = langIsEn
        ? "You write literary scenes matching the given metadata in the author's style."
        : 'Du schreibst literarische Szenen im Stil des Autors, passend zu den angegebenen Metadaten.';
      for (const [pageId, scenes] of scenesByPageId) {
        const txt = pageTextById.get(pageId);
        if (!txt || txt.length < minChars) continue;
        const completion = txt.length > maxChars ? txt.slice(0, maxChars) : txt;
        const meta = [];
        const titel = [...new Set(scenes.map(s => s.titel).filter(Boolean))].join(' / ');
        if (titel) meta.push((langIsEn ? 'Title: ' : 'Titel: ') + titel);
        const kapitel = scenes[0].kapitel || pageChapterById.get(pageId);
        if (kapitel) meta.push((langIsEn ? 'Chapter: ' : 'Kapitel: ') + kapitel);
        const figIds = [...new Set(scenes.flatMap(s => figsByScene.get(s.id) || []))];
        const figNames = figIds.map(id => figById.get(id)?.name).filter(Boolean);
        if (figNames.length) meta.push((langIsEn ? 'Characters: ' : 'Figuren: ') + figNames.join(', '));
        const locIds = [...new Set(scenes.flatMap(s => locsByScene.get(s.id) || []))];
        const locNames = locIds.map(id => locById.get(id)?.name).filter(Boolean);
        if (locNames.length) meta.push((langIsEn ? 'Location: ' : 'Schauplatz: ') + locNames.join(', '));
        const comments = [...new Set(scenes.map(s => s.kommentar).filter(Boolean))].join(' ');
        if (comments) meta.push((langIsEn ? 'Notes: ' : 'Notiz: ') + comments);
        if (meta.length === 0) continue;
        const instr = (langIsEn
          ? 'Write a scene with the following parameters:\n'
          : 'Schreibe eine Szene mit folgenden Vorgaben:\n') + meta.join('\n');
        samples.push({
          id: 'scene|' + pageId,
          type: 'scene',
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: instr },
            { role: 'assistant', content: completion },
          ],
        });
        sceneCount++;
      }
    }

    if (opts.types.dialog && figNamesSorted.length) {
      updateJob(jobId, { progress: 85, statusText: 'finetune.phase.dialog' });
      const sys = langIsEn
        ? "You write dialogue lines for the given character in the author's voice."
        : 'Du schreibst Dialogzeilen für die jeweilige Figur im Ton des Autors.';
      for (const p of pageContents) {
        const dlgs = extractDialogs(p.text);
        for (const d of dlgs) {
          if (d.quote.length < 10 || d.quote.length > 400) continue;
          const speaker = findSpeaker(p.text, d.start, d.end, figNamesSorted);
          if (!speaker) continue;
          const ctxBefore = p.text.slice(Math.max(0, d.start - 160), d.start).replace(/\s+/g, ' ').trim();
          const ctx = (ctxBefore.slice(-140) || p.chapter || bookName).trim();
          const userPart = langIsEn
            ? `Write a dialogue line for ${speaker}. Context: ${ctx}`
            : `Schreibe eine Dialogzeile für ${speaker}. Kontext: ${ctx}`;
          samples.push({
            id: 'dialog|' + p.id + '|' + d.start,
            type: 'dialog',
            messages: [
              { role: 'system', content: sys },
              { role: 'user', content: userPart },
              { role: 'assistant', content: d.quote },
            ],
          });
          dialogCount++;
        }
      }
    }

    if (opts.types.correction) {
      updateJob(jobId, { progress: 88, statusText: 'finetune.phase.correction' });
      const sys = langIsEn
        ? "You are an editor. Rewrite the given sentence in the author's voice — concise, precise, stylistically refined. Return only the improved version."
        : 'Du bist Lektor. Formuliere den Satz im Stil des Autors um — knapp, präzise, stilistisch geschliffen. Gib nur die verbesserte Fassung zurück.';
      const userPrefix    = langIsEn ? 'Improve: ' : 'Verbessere: ';
      const reasonedSys   = langIsEn
        ? "You are an editor. Rewrite the given sentence in the author's voice, then explain the change in one sentence."
        : 'Du bist Lektor. Formuliere den Satz im Stil des Autors um und erkläre die Änderung in einem Satz.';
      const reasonedUser  = langIsEn ? 'Improve and explain: ' : 'Verbessere und begründe: ';
      const reasonLabel   = langIsEn ? 'Reason: ' : 'Grund: ';

      // Neueste-First, damit bei mehrfach geprüften Seiten die aktuellste Korrektur
      // den Dedupe-Slot gewinnt (gleich-hashende Paare später ignoriert).
      const checkRows = db.prepare(`
        SELECT errors_json FROM page_checks
        WHERE book_id = ? AND user_email = ? AND errors_json IS NOT NULL AND error_count > 0
        ORDER BY checked_at DESC
      `).all(bookIdInt, userEmail);
      const seen = new Set();
      for (const row of checkRows) {
        let errs = null;
        try { errs = JSON.parse(row.errors_json); } catch { continue; }
        if (!Array.isArray(errs)) continue;
        for (const e of errs) {
          const orig = (e.original || '').trim();
          const korr = (e.korrektur || '').trim();
          if (orig.length < 8 || korr.length < 5) continue;
          if (orig.toLowerCase() === korr.toLowerCase()) continue;
          if (orig.length > maxChars || korr.length > maxChars) continue;
          const key = orig + '→' + korr;
          if (seen.has(key)) continue;
          seen.add(key);
          const idx = seen.size;
          // Base-Variante: nur verbesserter Satz als Antwort.
          samples.push({
            id: 'correction|a|' + idx,
            type: 'correction',
            messages: [
              { role: 'system', content: sys },
              { role: 'user',   content: userPrefix + orig },
              { role: 'assistant', content: korr },
            ],
          });
          correctionCount++;
          // Reasoned-Variante (nur wenn Begründung vorhanden): verbesserter Satz
          // + kurze Begründung. Trainiert ein Warum-Signal mit, ohne Basis-Antworten
          // mit Reasoning zu verwässern.
          const erkl = (e.erklaerung || '').trim();
          if (erkl.length >= 15 && erkl.length <= 400) {
            samples.push({
              id: 'correction|b|' + idx,
              type: 'correction',
              messages: [
                { role: 'system', content: reasonedSys },
                { role: 'user',   content: reasonedUser + orig },
                { role: 'assistant', content: korr + '\n\n' + reasonLabel + erkl },
              ],
            });
            correctionCount++;
          }
        }
      }
    }

    if (opts.types.authorChat) {
      updateJob(jobId, { progress: 90, statusText: 'finetune.phase.authorChat' });
      const displayName = bookName || (langIsEn ? 'this book' : 'diesem Buch');
      const sys = langIsEn
        ? `You are the author's voice for «${displayName}» answering a reader in conversation. Respond concisely, accurately, and in the spirit of the book.`
        : `Du bist die Stimme des Autors von «${displayName}» und antwortest einer Leserin im Gespräch. Antworte knapp, präzise und im Geist des Buchs.`;

      // Deterministische Auswahl einer Paraphrase pro Entity — bei gleichem Seed
      // reproduzierbar. `pickVariants` liefert `count` Indizes ohne Dubletten.
      const pickVariants = (id, variants, count) => {
        if (variants.length <= count) return variants.map((_, i) => i);
        const seen = new Set();
        const out = [];
        for (let i = 0; i < count * 4 && out.length < count; i++) {
          const v = Math.floor(hashSplit(id + '|' + i, seed) * variants.length);
          if (seen.has(v)) continue;
          seen.add(v);
          out.push(v);
        }
        return out;
      };

      // Mehr Fragevarianten = Modell lernt dieselbe Buchfakten über viele
      // Formulierungen hinweg assoziieren → schnellere Memorisierung der Welt.
      const figQuestions = langIsEn
        ? ['Who is {name}?', 'Tell me about {name}.', 'How would you describe {name}?',
           'What do I need to know about {name}?', 'What is {name} like?',
           "What's {name}'s story?", 'Give me a portrait of {name}.']
        : ['Wer ist {name}?', 'Erzähl mir von {name}.', 'Wie würdest du {name} beschreiben?',
           'Was sollte ich über {name} wissen?', 'Was für ein Mensch ist {name}?',
           'Was ist {name} für eine Figur?', 'Zeichne mir ein Bild von {name}.']
      ;
      const ortQuestions = langIsEn
        ? ['What is {name}?', 'Describe {name}.', 'What kind of place is {name}?',
           'How does {name} feel?', 'Tell me about {name}.',
           'What should I imagine when I hear {name}?']
        : ['Was ist {name}?', 'Beschreibe {name}.', 'Was für ein Ort ist {name}?',
           'Wie wirkt {name}?', 'Erzähl mir von {name}.',
           'Was soll ich mir unter {name} vorstellen?']
      ;
      const sceneQuestions = langIsEn
        ? ['What happens in «{titel}»?', 'Can you summarize the scene «{titel}»?',
           'What is «{titel}» about?', 'Tell me about the scene «{titel}».',
           "What's going on in «{titel}»?"]
        : ['Was passiert in «{titel}»?', 'Worum geht es in «{titel}»?',
           'Fasse die Szene «{titel}» zusammen.', 'Erzähl mir von der Szene «{titel}».',
           'Was spielt sich in «{titel}» ab?']
      ;
      const eventQuestions = langIsEn
        ? ['What happens around {ereignis}?', 'What is the significance of {ereignis}?',
           'Tell me about {ereignis}.', 'How does {ereignis} matter?']
        : ['Was weisst du über {ereignis}?', 'Welche Bedeutung hat {ereignis}?',
           'Erzähl mir von {ereignis}.', 'Warum ist {ereignis} wichtig?']
      ;
      const chapterQuestions = langIsEn
        ? ['What happens in «{kapitel}»?', 'Summarize «{kapitel}» for me.',
           'Walk me through «{kapitel}».', 'What is «{kapitel}» about?']
        : ['Was passiert in «{kapitel}»?', 'Fasse «{kapitel}» zusammen.',
           'Was geschieht im Kapitel «{kapitel}»?', 'Worum geht es in «{kapitel}»?']
      ;

      const pushQA = (id, q, a) => {
        const qq = (q || '').trim();
        const aa = (a || '').trim();
        if (qq.length < 4 || aa.length < 20) return;
        samples.push({
          id,
          type: 'authorChat',
          messages: [
            { role: 'system', content: sys },
            { role: 'user',   content: qq },
            { role: 'assistant', content: aa },
          ],
        });
        authorChatCount++;
      };

      // ── Figuren-Q&A ────────────────────────────────────────────────────────
      // Composite answer: beschreibung als Rückgrat + ein angehängter Satz zu
      // Beruf/Geschlecht/Tags (so die Antwort wie Prosa klingt und nicht wie CSV).
      for (const f of figRows) {
        const desc = (f.beschreibung || '').trim();
        if (!desc) continue;
        const extras = [];
        if (f.beruf) extras.push(langIsEn ? `Occupation: ${f.beruf}.` : `Beruf: ${f.beruf}.`);
        if (f.tags_csv) {
          const tags = f.tags_csv.split(',').map(t => t.trim()).filter(Boolean).slice(0, 4).join(', ');
          if (tags) extras.push(langIsEn ? `Traits: ${tags}.` : `Eigenschaften: ${tags}.`);
        }
        const answer = [desc, ...extras].join(' ');
        // 3 Paraphrasen pro Figur → gleiche Fakten mehrmals sehen → bessere
        // Memorisierung der Buchwelt (Ziel: Figur als «Realität» akzeptieren).
        const idxs = pickVariants('fig|' + f.fig_id, figQuestions, 3);
        for (const idx of idxs) {
          const q = figQuestions[idx].replace('{name}', f.name);
          pushQA('authorChat|fig|' + f.fig_id + '|' + idx, q, answer);
        }
        // Zusatz-Frage mit Kurzname als Zielnamen (wenn vorhanden), damit das
        // Modell beide Namen-Varianten kennt.
        if (f.kurzname && f.kurzname !== f.name && f.kurzname.trim().length >= 2) {
          const altIdx = Math.floor(hashSplit('figAlt|' + f.fig_id, seed) * figQuestions.length);
          const q = figQuestions[altIdx].replace('{name}', f.kurzname);
          pushQA('authorChat|figAlt|' + f.fig_id, q, answer);
        }
      }

      // ── Orte-Q&A ───────────────────────────────────────────────────────────
      for (const l of locRows) {
        const desc = (l.beschreibung || '').trim();
        if (!desc) continue;
        const parts = [desc];
        if (l.stimmung) parts.push(langIsEn ? `The atmosphere: ${l.stimmung}.` : `Die Stimmung: ${l.stimmung}.`);
        if (l.typ)      parts.push(langIsEn ? `Type: ${l.typ}.` : `Art des Ortes: ${l.typ}.`);
        const answer = parts.join(' ');
        const idxs = pickVariants('ort|' + l.loc_id, ortQuestions, 3);
        for (const idx of idxs) {
          const q = ortQuestions[idx].replace('{name}', l.name);
          pushQA('authorChat|ort|' + l.loc_id + '|' + idx, q, answer);
        }
      }

      // ── Szenen-Q&A ────────────────────────────────────────────────────────
      for (const s of sceneRows) {
        const komm = (s.kommentar || '').trim();
        if (!s.titel || !komm) continue;
        const parts = [komm];
        const figIds = figsByScene.get(s.id) || [];
        const figNames = figIds.map(id => figById.get(id)?.name).filter(Boolean);
        if (figNames.length) parts.push(langIsEn ? `Characters: ${figNames.join(', ')}.` : `Figuren: ${figNames.join(', ')}.`);
        const locIds = locsByScene.get(s.id) || [];
        const locNames = locIds.map(id => locById.get(id)?.name).filter(Boolean);
        if (locNames.length) parts.push(langIsEn ? `Setting: ${locNames.join(', ')}.` : `Schauplatz: ${locNames.join(', ')}.`);
        if (s.kapitel) parts.push(langIsEn ? `Chapter: ${s.kapitel}.` : `Kapitel: ${s.kapitel}.`);
        const answer = parts.join(' ');
        const idxs = pickVariants('scene|' + s.id, sceneQuestions, 2);
        for (const idx of idxs) {
          const q = sceneQuestions[idx].replace('{titel}', s.titel);
          pushQA('authorChat|scene|' + s.id + '|' + idx, q, answer);
        }
      }

      // ── Zeitstrahl-Q&A ────────────────────────────────────────────────────
      const evtRows = db.prepare(
        'SELECT ereignis, datum, bedeutung, figuren FROM zeitstrahl_events WHERE book_id = ? AND user_email = ? ORDER BY sort_order'
      ).all(bookIdInt, userEmail || '');
      for (let i = 0; i < evtRows.length; i++) {
        const ev = evtRows[i];
        const ereignis = (ev.ereignis || '').trim();
        if (!ereignis) continue;
        const parts = [ereignis + '.'];
        if (ev.datum)     parts.push(langIsEn ? `When: ${ev.datum}.` : `Zeitpunkt: ${ev.datum}.`);
        if (ev.bedeutung) parts.push((langIsEn ? 'Why it matters: ' : 'Bedeutung: ') + ev.bedeutung);
        const answer = parts.join(' ');
        const idxs = pickVariants('evt|' + i, eventQuestions, 1);
        for (const idx of idxs) {
          const q = eventQuestions[idx].replace('{ereignis}', ereignis);
          pushQA('authorChat|evt|' + i + '|' + idx, q, answer);
        }
      }

      // ── Review-basierte Q&A ───────────────────────────────────────────────
      // Nutzt die zuletzt gespeicherte book_reviews.review_json. Feste Fragen
      // pro Feld, weil die Review-Felder bereits in klaren Sätzen vorliegen.
      const reviewRow = db.prepare(
        'SELECT review_json FROM book_reviews WHERE book_id = ? AND user_email = ? ORDER BY reviewed_at DESC LIMIT 1'
      ).get(bookIdInt, userEmail);
      if (reviewRow?.review_json) {
        let r = null;
        try { r = JSON.parse(reviewRow.review_json); } catch { /* ignore */ }
        if (r && typeof r === 'object') {
          const qaFromReview = (suffix, q, a) => pushQA('authorChat|review|' + suffix, q, a);
          if (r.zusammenfassung) {
            qaFromReview('summary',
              langIsEn ? `What is «${displayName}» about?` : `Worum geht es in «${displayName}»?`,
              r.zusammenfassung);
          }
          if (r.themen) {
            qaFromReview('themen',
              langIsEn ? 'What are the main themes?' : 'Was sind die Hauptthemen?',
              typeof r.themen === 'string' ? r.themen : (Array.isArray(r.themen) ? r.themen.join(', ') : ''));
          }
          if (Array.isArray(r.staerken) && r.staerken.length) {
            qaFromReview('staerken',
              langIsEn ? 'What are the strengths of the book?' : 'Was sind die Stärken des Buchs?',
              r.staerken.join(' · '));
          }
          if (Array.isArray(r.schwaechen) && r.schwaechen.length) {
            qaFromReview('schwaechen',
              langIsEn ? 'What would you criticize about the book?' : 'Was würdest du am Buch kritisieren?',
              r.schwaechen.join(' · '));
          }
          if (r.gesamtnote != null && r.gesamtnote_begruendung) {
            qaFromReview('note',
              langIsEn ? 'How would you rate the book overall?' : 'Wie bewertest du das Buch gesamt?',
              `${r.gesamtnote}/6 — ${r.gesamtnote_begruendung}`);
          }
        }
      }

      // ── Kapitel-Reviews ───────────────────────────────────────────────────
      // Neueste pro Kapitel (user+book). Pro Review mehrere Q&A: Zusammenfassung,
      // Fazit, Stärken, Schwächen, Dramaturgie, Pacing, Figuren.
      const chapterReviewRows = db.prepare(`
        SELECT cr1.chapter_name, cr1.review_json
        FROM chapter_reviews cr1
        WHERE cr1.book_id = ? AND cr1.user_email = ?
          AND cr1.reviewed_at = (
            SELECT MAX(cr2.reviewed_at) FROM chapter_reviews cr2
            WHERE cr2.book_id = cr1.book_id AND cr2.chapter_id = cr1.chapter_id AND cr2.user_email = cr1.user_email
          )
      `).all(bookIdInt, userEmail);
      for (const row of chapterReviewRows) {
        const chName = (row.chapter_name || '').trim();
        if (!chName || !row.review_json) continue;
        let cr = null;
        try { cr = JSON.parse(row.review_json); } catch { continue; }
        if (!cr || typeof cr !== 'object') continue;
        // Zusammenfassung als Hauptantwort auf „Was passiert in Kapitel X?"
        if (cr.zusammenfassung) {
          const idxs = pickVariants('chap|' + chName, chapterQuestions, 2);
          for (const idx of idxs) {
            const q = chapterQuestions[idx].replace('{kapitel}', chName);
            pushQA('authorChat|chap|' + chName + '|' + idx, q, cr.zusammenfassung);
          }
        }
        if (cr.fazit) {
          pushQA('authorChat|chap-fazit|' + chName,
            langIsEn ? `What's the takeaway of «${chName}»?` : `Was ist das Fazit zu Kapitel «${chName}»?`,
            cr.fazit);
        }
        if (cr.dramaturgie) {
          pushQA('authorChat|chap-drama|' + chName,
            langIsEn ? `How does «${chName}» build tension?` : `Wie ist «${chName}» dramaturgisch aufgebaut?`,
            cr.dramaturgie);
        }
        if (cr.pacing) {
          pushQA('authorChat|chap-pacing|' + chName,
            langIsEn ? `How is the pacing of «${chName}»?` : `Wie ist das Tempo in «${chName}»?`,
            cr.pacing);
        }
        if (cr.figuren) {
          pushQA('authorChat|chap-fig|' + chName,
            langIsEn ? `Who carries «${chName}»?` : `Welche Figuren tragen «${chName}»?`,
            cr.figuren);
        }
        if (Array.isArray(cr.staerken) && cr.staerken.length) {
          pushQA('authorChat|chap-str|' + chName,
            langIsEn ? `What makes «${chName}» strong?` : `Was macht «${chName}» stark?`,
            cr.staerken.join(' · '));
        }
      }

      // ── Echte Buch-Chat-Messages ──────────────────────────────────────────
      // Consecutive (user, assistant)-Paare aus book-chat-Sessions (page_name
      // = '__book__') direkt übernehmen. Das ist die authentischste Q&A-Quelle.
      const chatRows = db.prepare(`
        SELECT cs.id AS sid, cm.role, cm.content, cm.created_at, cm.id AS mid
        FROM chat_messages cm
        JOIN chat_sessions cs ON cs.id = cm.session_id
        WHERE cs.book_id = ? AND cs.user_email = ? AND cs.page_name = '__book__'
        ORDER BY cs.id, cm.created_at, cm.id
      `).all(bookIdInt, userEmail);
      for (let i = 0; i + 1 < chatRows.length; i++) {
        const a = chatRows[i];
        const b = chatRows[i + 1];
        if (a.sid !== b.sid) continue;
        if (a.role !== 'user' || b.role !== 'assistant') continue;
        const q = (a.content || '').trim();
        const ans = (b.content || '').trim();
        if (q.length < 4 || ans.length < 30) continue;
        pushQA('authorChat|chat|' + a.sid + '|' + a.mid, q, ans);
      }
    }

    updateJob(jobId, { progress: 95, statusText: 'finetune.phase.building' });
    const trainArr = [];
    const valArr = [];
    for (const s of samples) {
      if (valSplit > 0 && hashSplit(s.id, seed) < valSplit) valArr.push(s);
      else trainArr.push(s);
    }
    const toJsonl = (arr) => arr.length
      ? arr.map(s => JSON.stringify({ messages: s.messages })).join('\n') + '\n'
      : '';

    const trainJsonl = toJsonl(trainArr);
    const valJsonl   = toJsonl(valArr);
    const stats = {
      total: samples.length,
      train: trainArr.length,
      val: valArr.length,
      styleCount, sceneCount, dialogCount, authorChatCount, correctionCount,
      trainBytes: Buffer.byteLength(trainJsonl, 'utf8'),
      valBytes:   Buffer.byteLength(valJsonl,   'utf8'),
    };

    storeFinetuneResult(jobId, { trainJsonl, valJsonl });
    completeJob(jobId, { stats });
    logger.info(`Finetune-Export fertig: ${stats.total} Samples (${styleCount} style / ${sceneCount} scene / ${dialogCount} dialog / ${authorChatCount} authorChat / ${correctionCount} correction) → ${trainArr.length} train, ${valArr.length} val.`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Fehler Finetune-Export (book=${bookId}): ${e.message}`);
    failJob(jobId, e);
  }
}

finetuneExportRouter.post('/finetune-export', jsonBody, (req, res) => {
  const { book_id, book_name, types, min_chars, max_chars, val_split, val_seed } = req.body || {};
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  const opts = {
    types: {
      style:      !!(types && types.style),
      scene:      !!(types && types.scene),
      dialog:     !!(types && types.dialog),
      authorChat: !!(types && types.authorChat),
      correction: !!(types && types.correction),
    },
    minChars: Number(min_chars) || 200,
    maxChars: Number(max_chars) || 4000,
    valSplit: Number.isFinite(Number(val_split)) ? Number(val_split) : 0.1,
    valSeed:  Number(val_seed)  || 0,
  };
  if (!Object.values(opts.types).some(v => v)) {
    return res.status(400).json({ error_code: 'FINETUNE_NO_TYPES' });
  }
  const userEmail = req.session?.user?.email || null;
  const userToken = getTokenForRequest(req);
  const existing = runningJobs.get(jobKey('finetune-export', book_id, userEmail));
  if (existing && jobs.has(existing)) return res.json({ jobId: existing, existing: true });
  const label = book_name ? 'job.label.finetuneExportBook' : 'job.label.finetuneExport';
  const labelParams = book_name ? { name: book_name } : null;
  const jobId = createJob('finetune-export', book_id, userEmail, label, labelParams);
  enqueueJob(jobId, () => runFinetuneExportJob(jobId, book_id, book_name || '', userEmail, userToken, opts));
  res.json({ jobId });
});

finetuneExportRouter.get('/finetune-export/:id/:kind.jsonl', (req, res) => {
  const userEmail = req.session?.user?.email || null;
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error_code: 'JOB_NOT_FOUND' });
  if (job.userEmail !== userEmail) return res.status(403).json({ error_code: 'FORBIDDEN' });
  if (job.type !== 'finetune-export') return res.status(400).json({ error_code: 'JOB_TYPE_MISMATCH' });
  if (job.status !== 'done') return res.status(409).json({ error_code: 'JOB_NOT_DONE' });
  const kind = req.params.kind;
  if (kind !== 'train' && kind !== 'val') return res.status(400).json({ error_code: 'INVALID_KIND' });
  const payload = finetuneResultStore.get(req.params.id);
  if (!payload) return res.status(410).json({ error_code: 'JSONL_EXPIRED' });
  const content = kind === 'train' ? payload.trainJsonl : payload.valJsonl;
  if (!content) return res.status(404).json({ error_code: 'JSONL_EMPTY' });
  const filename = `finetune-${kind}-book${job.bookId}.jsonl`;
  res.setHeader('Content-Type', 'application/jsonl; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(content);
});

module.exports = { finetuneExportRouter };
