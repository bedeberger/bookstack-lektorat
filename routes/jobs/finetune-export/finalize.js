'use strict';

const { estimateTokens, renderMistralChat, percentile, recommendSeqLen } = require('./lib/tokens');
const { hashSplit } = require('./lib/names');
const { splitAtSentence } = require('./lib/text');
const { storeFinetuneResult } = require('./lib/store');

// Token-Stats berechnen, optional nach `maxSeqTokens` filtern, train/val
// per `hashSplit` aufteilen, JSONL serialisieren und im Result-Store ablegen.
//
// Gibt `stats`-Objekt zurück, das in completeJob gepackt wird.
function finalizeFinetuneSamples(jobId, ctx) {
  const { samples, opts, langIsEn, counts } = ctx;
  const { valSplit, valSeed, maxSeqTokens, emitText, truncateLong } = opts;

  // ── Token-Budget pro Sample (für Stats + Filter) ──────────────────────
  // Pro Sample: Summe aller Nachrichten + fester Template-Overhead. Mistral-
  // Tekken-V7 (Mistral-Small-3.2) encoded die Marker als atomare Single-
  // Tokens: <s>=1, [SYSTEM_PROMPT]=1, [/SYSTEM_PROMPT]=1, [INST]=1,
  // [/INST]=1, </s>=1 → real ~6 Tokens. 20 ist 3× konservativ und deckt
  // Newlines/Whitespace-Variationen mit ab.
  const TEMPLATE_OVERHEAD = 20;
  const withTokens = samples.map(s => {
    const sum = s.messages.reduce((a, m) => a + estimateTokens(m.content, langIsEn), 0);
    return { s, tokens: sum + TEMPLATE_OVERHEAD };
  });

  // ── Seq-Filter / Cap (optional) ──────────────────────────────────────
  // Samples, die bei `maxSeqTokens` zu stiller Truncation führen würden,
  // werden behandelt: entweder gedroppt (default) oder per `truncateLong`
  // an einer Satzgrenze gekappt (Assistant-Content wird gekürzt).
  let kept;
  let droppedCount = 0;
  let cappedCount = 0;
  if (maxSeqTokens > 0) {
    if (truncateLong) {
      kept = [];
      const perToken = langIsEn ? 4.0 : 3.3;
      for (const e of withTokens) {
        if (e.tokens <= maxSeqTokens) { kept.push(e); continue; }
        const assistantMsg = e.s.messages[e.s.messages.length - 1];
        if (!assistantMsg || assistantMsg.role !== 'assistant') {
          droppedCount++;
          continue;
        }
        const otherTokens = e.s.messages.slice(0, -1)
          .reduce((a, m) => a + estimateTokens(m.content, langIsEn), 0);
        const assistantBudget = maxSeqTokens - otherTokens - TEMPLATE_OVERHEAD;
        if (assistantBudget < 30) { droppedCount++; continue; }
        const charBudget = Math.floor(assistantBudget * perToken);
        const orig = assistantMsg.content;
        if (charBudget >= orig.length) { kept.push(e); continue; }
        const ratio = Math.max(0.05, Math.min(0.95, charBudget / orig.length));
        const [head] = splitAtSentence(orig, ratio);
        if (head.length < 60) { droppedCount++; continue; }
        assistantMsg.content = head;
        const newSum = e.s.messages.reduce((a, m) => a + estimateTokens(m.content, langIsEn), 0);
        e.tokens = newSum + TEMPLATE_OVERHEAD;
        cappedCount++;
        kept.push(e);
      }
    } else {
      kept = withTokens.filter(e => e.tokens <= maxSeqTokens);
      droppedCount = withTokens.length - kept.length;
    }
  } else {
    kept = withTokens;
  }

  // ── Token-Histogramm (p50/p95/max) ────────────────────────────────────
  const tokenCounts = kept.map(e => e.tokens).sort((a, b) => a - b);
  const tokensP50 = percentile(tokenCounts, 0.50);
  const tokensP95 = percentile(tokenCounts, 0.95);
  const tokensMax = tokenCounts.length ? tokenCounts[tokenCounts.length - 1] : 0;
  const recommendedSeqLen = recommendSeqLen(tokensP95);

  const trainArr = [];
  const valArr = [];
  for (const { s } of kept) {
    if (valSplit > 0 && hashSplit(s.id, valSeed) < valSplit) valArr.push(s);
    else trainArr.push(s);
  }

  // JSONL-Line: immer `messages`-Feld. Mit `emitText=true` zusätzlich ein
  // vorgerendertes `text`-Feld (Mistral-Tekken-V7-Template, Mistral-Small-3.2-
  // konform), damit Unsloth-Userinnen `SFTTrainer(dataset_text_field="text")`
  // ohne `formatting_func` nutzen können. `messages` bleibt erhalten — manche
  // Tools (TRL ChatML-Loader) wollen das.
  const serialize = (sample) => {
    const obj = { messages: sample.messages };
    if (emitText) obj.text = renderMistralChat(sample.messages);
    return JSON.stringify(obj);
  };
  const toJsonl = (arr) => arr.length
    ? arr.map(serialize).join('\n') + '\n'
    : '';

  const trainJsonl = toJsonl(trainArr);
  const valJsonl   = toJsonl(valArr);
  const stats = {
    total: kept.length,
    dropped: droppedCount,
    capped: cappedCount,
    train: trainArr.length,
    val: valArr.length,
    styleCount: counts.style,
    sceneCount: counts.scene,
    dialogCount: counts.dialog,
    authorChatCount: counts.authorChat,
    correctionCount: counts.correction,
    trainBytes: Buffer.byteLength(trainJsonl, 'utf8'),
    valBytes:   Buffer.byteLength(valJsonl,   'utf8'),
    tokensP50, tokensP95, tokensMax,
    recommendedSeqLen,
    maxSeqTokens: maxSeqTokens || null,
    emitText,
  };

  storeFinetuneResult(jobId, { trainJsonl, valJsonl });
  return stats;
}

module.exports = { finalizeFinetuneSamples };
