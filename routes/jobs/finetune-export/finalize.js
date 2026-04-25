'use strict';

const { estimateTokens, renderMistralChat, percentile, recommendSeqLen } = require('./lib/tokens');
const { hashSplit } = require('./lib/names');
const { storeFinetuneResult } = require('./lib/store');

// Token-Stats berechnen, optional nach `maxSeqTokens` filtern, train/val
// per `hashSplit` aufteilen, JSONL serialisieren und im Result-Store ablegen.
//
// Gibt `stats`-Objekt zurück, das in completeJob gepackt wird.
function finalizeFinetuneSamples(jobId, ctx) {
  const { samples, opts, langIsEn, counts } = ctx;
  const { valSplit, valSeed, maxSeqTokens, emitText } = opts;

  // ── Token-Budget pro Sample (für Stats + Filter) ──────────────────────
  // Pro Sample: Summe aller Nachrichten + fester Template-Overhead (BOS/EOS,
  // [INST]/[/INST]-Marker, [SYSTEM_PROMPT]-Tags, Rollen-Separatoren).
  // 20 Tokens sind sichere Obergrenze für Mistral-Tekken-V7.
  const TEMPLATE_OVERHEAD = 20;
  const withTokens = samples.map(s => {
    const sum = s.messages.reduce((a, m) => a + estimateTokens(m.content, langIsEn), 0);
    return { s, tokens: sum + TEMPLATE_OVERHEAD };
  });

  // ── Seq-Filter (optional) ─────────────────────────────────────────────
  // Samples rauswerfen, die bei `maxSeqTokens` zu stiller Truncation führen
  // würden. Ohne Filter werden sie später beim Training entweder weggeworfen
  // (SFTTrainer ab Version X) oder — schlimmer — am Assistant-Ende
  // abgeschnitten.
  const kept = maxSeqTokens > 0
    ? withTokens.filter(e => e.tokens <= maxSeqTokens)
    : withTokens;
  const droppedCount = withTokens.length - kept.length;

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
  // vorgerendertes `text`-Feld (Mistral-Template), damit Unsloth-Userinnen
  // `SFTTrainer(dataset_text_field="text")` ohne `formatting_func` nutzen
  // können. Das `messages`-Feld bleibt erhalten — manche Tools wollen das.
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
