// Generische KI-API-Methoden (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.
// Unterstützte Provider: 'claude' (Anthropic) und 'ollama' (lokales Modell).

function _providerConfig(provider, claudeModel, ollamaModel) {
  if (provider === 'ollama') {
    return { endpoint: '/ollama', model: ollamaModel, temperature: 0.0, label: 'Ollama' };
  }
  return { endpoint: '/claude', model: claudeModel, temperature: 0.2, label: 'Claude' };
}

function _parseJson(fullText) {
  const clean = fullText.replace(/```json\s*|```/g, '').trim();
  try {
    return JSON.parse(clean);
  } catch (e1) {
    console.error('[callAI] Direktes JSON.parse fehlgeschlagen:', e1, '\nVolle Antwort:', fullText);
    const match = clean.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (e2) {
        console.error('[callAI] JSON.parse aus extrahiertem Block fehlgeschlagen:', e2, '\nExtrahierter Block:', match[0]);
      }
    }
    throw new Error('KI-Antwort konnte nicht geparst werden (siehe Console für vollständige Rohantwort)');
  }
}

export const aiMethods = {
  // onProgress(chars, tokIn) – wird während des Streamings aufgerufen (tokIn=0 bis message_start)
  // onComplete({ tokensIn, tokensOut }) – optionaler Callback nach Abschluss des Streams
  async callAI(userPrompt, systemPrompt = null, onProgress = null, onComplete = null) {
    const { endpoint, model, temperature, label } = _providerConfig(
      this.apiProvider, this.claudeModel, this.ollamaModel
    );

    const body = {
      model,
      max_tokens: this.claudeMaxTokens,
      temperature,
      messages: [{ role: 'user', content: userPrompt }],
    };
    if (systemPrompt) body.system = systemPrompt;

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(`${label} API Fehler: ` + (err.error?.message || JSON.stringify(err)));
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let buffer = '';
    let tokensIn = 0, tokensOut = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6);
        if (raw === '[DONE]') break;
        try {
          const ev = JSON.parse(raw);
          if (ev.type === 'message_start' && ev.message?.usage) {
            tokensIn = ev.message.usage.input_tokens || 0;
            if (onProgress) onProgress(fullText.length, tokensIn);
          } else if (ev.type === 'message_delta' && ev.usage) {
            tokensOut = ev.usage.output_tokens || 0;
          } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
            fullText += ev.delta.text;
            if (onProgress) onProgress(fullText.length, tokensIn);
          }
        } catch (e) {
          console.error('[callAI] SSE-Event konnte nicht geparst werden:', e, '\nRaw:', raw);
        }
      }
    }

    if (onComplete) onComplete({ tokensIn, tokensOut });
    return _parseJson(fullText);
  },
};
