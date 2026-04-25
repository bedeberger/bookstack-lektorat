'use strict';

// Token-Schätzer. Für Mistral-Tekken-V7-Tokenizer (Mistral-Small-3.2) ergibt
// sich empirisch: DE ≈ 3.3 Zeichen/Token, EN ≈ 4.0 Zeichen/Token. Bewusst
// konservativ (eher aufrunden), damit `maxSeqTokens`-Filter nicht in
// Truncation läuft.
function estimateTokens(text, langIsEn) {
  if (!text) return 0;
  const perToken = langIsEn ? 4.0 : 3.3;
  return Math.ceil(text.length / perToken);
}

// Mistral-Tekken-V7-Chat-Template (minimaler Umriss für Token-Budget und
// optionale Text-Felder). Das echte Template fügt BOS/EOS/[INST] sowie
// [SYSTEM_PROMPT]-Tags ein — Unsloth/Mistral-Common rendert das selbst.
// Wir brauchen hier nur ein realistisches String-Gerüst für Längen-Schätzung
// und `emitText`.
function renderMistralChat(messages) {
  let out = '<s>';
  const sys = messages.find(m => m.role === 'system')?.content || '';
  const turns = messages.filter(m => m.role !== 'system');
  for (let i = 0; i < turns.length; i++) {
    const m = turns[i];
    if (m.role === 'user') {
      const prefix = (i === 0 && sys) ? sys + '\n\n' : '';
      out += '[INST] ' + prefix + m.content + ' [/INST]';
    } else if (m.role === 'assistant') {
      out += ' ' + m.content + '</s>';
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
// mit ~10 % Puffer fürs Chat-Template. Mindestens 1024, max 16384.
function recommendSeqLen(p95) {
  const target = Math.ceil(p95 * 1.1);
  let n = 1024;
  while (n < target && n < 16384) n *= 2;
  return Math.max(1024, Math.min(16384, n));
}

module.exports = {
  estimateTokens,
  renderMistralChat,
  percentile,
  recommendSeqLen,
};
