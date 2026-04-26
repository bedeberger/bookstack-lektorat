'use strict';

// Token-Schätzer für Mistral-Small-3.2-24B (Tekken-V7-Tokenizer, vocab=131k).
// Empirisch: DE ≈ 3.3 Zeichen/Token, EN ≈ 4.0 Zeichen/Token. Bewusst
// konservativ (eher aufrunden), damit `maxSeqTokens`-Filter nicht in
// Truncation läuft. Tekken-V7 ist byte-level-BPE — bei reinem DE-Fliesstext
// liegt die echte Rate näher an 3.5-3.8 char/tok, daher ist 3.3 ~10 % Puffer.
function estimateTokens(text, langIsEn) {
  if (!text) return 0;
  const perToken = langIsEn ? 4.0 : 3.3;
  return Math.ceil(text.length / perToken);
}

// Mistral-Tekken-V7-Chat-Template (offizielles Mistral-Small-3.2-Format).
// Layout pro Mistral-Common-Spec:
//   <s>[SYSTEM_PROMPT]<sys>[/SYSTEM_PROMPT][INST]<user1>[/INST]<asst1></s>[INST]<user2>[/INST]<asst2></s>
// Alle Marker ([SYSTEM_PROMPT], [/SYSTEM_PROMPT], [INST], [/INST], <s>, </s>)
// sind in Tekken-V7 als atomare Single-Tokens encoded — keine Spaces drum
// nötig oder erwünscht. Kein erneutes <s> zwischen Multi-Turn-Pairs.
//
// Wird von `emit_text=true` für `dataset_text_field="text"` (Unsloth/TRL)
// verwendet. Fehl-Template hier → Modell trainiert auf V3, Inference nutzt
// V7 → silent generation-quality drop.
function renderMistralChat(messages) {
  let out = '<s>';
  const sys = messages.find(m => m.role === 'system')?.content || '';
  if (sys) out += '[SYSTEM_PROMPT]' + sys + '[/SYSTEM_PROMPT]';
  const turns = messages.filter(m => m.role !== 'system');
  for (const m of turns) {
    if (m.role === 'user') {
      out += '[INST]' + m.content + '[/INST]';
    } else if (m.role === 'assistant') {
      out += m.content + '</s>';
    }
  }
  return out;
}

// Perzentile aus sortiertem Numeric-Array (Nearest-Rank).
function percentile(sortedNums, p) {
  if (!sortedNums.length) return 0;
  const idx = Math.min(sortedNums.length - 1, Math.floor(sortedNums.length * p));
  return sortedNums[idx];
}

// Empfohlene `max_seq_length` für Unsloth/TRL: nächste Potenz von 2 über p95
// mit ~10 % Puffer fürs Chat-Template. Min 1024, max 32768 — Mistral-Small-3.2
// hat 131072 native Kontext, aber 32768 ist VRAM-Sweetspot für 24B-Voll-FT
// auf 80-GB-Karten resp. grossem LoRA. Wer mehr will, override per opts.
function recommendSeqLen(p95) {
  const target = Math.ceil(p95 * 1.1);
  let n = 1024;
  while (n < target && n < 32768) n *= 2;
  return Math.max(1024, Math.min(32768, n));
}

module.exports = {
  estimateTokens,
  renderMistralChat,
  percentile,
  recommendSeqLen,
};
