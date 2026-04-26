'use strict';

const { extractDialogs } = require('../lib/text');
const { findSpeaker } = require('../lib/names');

// Dialog-Sammlung läuft immer, wenn Figuren bekannt sind — `dialogsByFigure`
// füttert auch den authorChat-Block (Zitatsammlung pro Figur). Der eigentliche
// dialog-Typ ist davon unabhängig per Checkbox steuerbar.
function buildDialogSamples(ctx) {
  const {
    samples, counts, opts, langIsEn, unifiedSys, bookName,
    pageContents, figRows, figNamesSorted, dialogsByFigure,
  } = ctx;

  if (!figNamesSorted.length) return;

  for (const p of pageContents) {
    const dlgs = extractDialogs(p.text);
    for (const d of dlgs) {
      if (d.quote.length < 6 || d.quote.length > 800) continue;
      const speaker = findSpeaker(p.text, d.start, d.end, figNamesSorted);
      if (!speaker) continue;
      const spkKey = speaker.toLowerCase();
      if (!dialogsByFigure.has(spkKey)) dialogsByFigure.set(spkKey, []);
      dialogsByFigure.get(spkKey).push({ quote: d.quote, chapter: p.chapter, page: p.title });
      if (!opts.types.dialog) continue;
      const ctxBefore = p.text.slice(Math.max(0, d.start - 160), d.start).replace(/\s+/g, ' ').trim();
      const ctxStr = (ctxBefore.slice(-140) || p.chapter || bookName).trim();
      const userPart = langIsEn
        ? `Write a dialogue line for ${speaker}. Context: ${ctxStr}`
        : `Schreibe eine Dialogzeile für ${speaker}. Kontext: ${ctxStr}`;
      samples.push({
        id: 'dialog|' + p.id + '|' + d.start,
        type: 'dialog',
        messages: [
          { role: 'system', content: unifiedSys },
          { role: 'user', content: userPart },
          { role: 'assistant', content: d.quote },
        ],
      });
      counts.dialog++;
    }
  }

  // ── Reverse Dialog: «Welche Figur sagt ...?» (#6) ────────────────────
  // Sobald Dialog-Extraktion gelaufen ist, existieren eindeutig
  // speaker-zugeordnete Zitate in dialogsByFigure. Reverse-Sample erzeugt
  // Speaker-Lookup-Fähigkeit: gegeben ein Zitat → Figur zurückgeben. Pro
  // Figur cap bei 12 Zitaten, damit stark sprechende Figuren nicht das
  // Training dominieren.
  if (opts.types.dialog) {
    const REV_CAP_PER_FIG = 30;
    for (const f of figRows) {
      const entries = dialogsByFigure.get(f.name.toLowerCase()) || [];
      const altEntries = (f.kurzname && f.kurzname !== f.name)
        ? (dialogsByFigure.get(f.kurzname.toLowerCase()) || [])
        : [];
      const seenQ = new Set();
      let emitted = 0;
      for (const e of [...entries, ...altEntries]) {
        if (emitted >= REV_CAP_PER_FIG) break;
        if (seenQ.has(e.quote)) continue;
        seenQ.add(e.quote);
        if (e.quote.length < 12 || e.quote.length > 600) continue;
        const ctxTag = e.chapter
          ? (langIsEn ? ` (in «${e.chapter}»)` : ` (in «${e.chapter}»)`)
          : '';
        samples.push({
          id: 'dialogRev|' + f.fig_id + '|' + emitted,
          type: 'dialog',
          messages: [
            { role: 'system', content: unifiedSys },
            { role: 'user',   content: (langIsEn
              ? `Who says this: "${e.quote}"?`
              : `Wer sagt das: «${e.quote}»?`) },
            { role: 'assistant', content: f.name + ctxTag + '.' },
          ],
        });
        counts.dialog++;
        emitted++;
      }
    }
  }
}

module.exports = { buildDialogSamples };
