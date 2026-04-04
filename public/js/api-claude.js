// Methoden für KI-API-Calls (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.
// Unterstützte Provider: 'claude' (Anthropic) und 'ollama' (lokales Modell).

export const claudeMethods = {
  async callClaude(userPrompt, systemPrompt = null, onProgress = null) {
    const isOllama = this.apiProvider === 'ollama';
    const endpoint = isOllama ? '/ollama' : '/claude';

    const body = {
      model: isOllama ? this.ollamaModel : this.claudeModel,
      max_tokens: this.claudeMaxTokens,
      temperature: isOllama ? 0.0 : 0.2,
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
      const provider = isOllama ? 'Ollama' : 'Claude';
      throw new Error(`${provider} API Fehler: ` + (err.error?.message || JSON.stringify(err)));
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let buffer = '';

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
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
            fullText += ev.delta.text;
            if (onProgress) onProgress(fullText.length);
          }
        } catch (e) {
          console.error('[callClaude] SSE-Event konnte nicht geparst werden:', e, '\nRaw:', raw);
        }
      }
    }

    // JSON parsen: direkt versuchen, dann erstes {...}-Block extrahieren
    const clean = fullText.replace(/```json\s*|```/g, '').trim();
    try {
      return JSON.parse(clean);
    } catch (e1) {
      console.error('[callClaude] Direktes JSON.parse fehlgeschlagen:', e1, '\nVolle Antwort:', fullText);
      const match = clean.match(/\{[\s\S]*\}/);
      if (match) {
        try { return JSON.parse(match[0]); } catch (e2) {
          console.error('[callClaude] JSON.parse aus extrahiertem Block fehlgeschlagen:', e2, '\nExtrahierter Block:', match[0]);
        }
      }
      throw new Error('Claude-Antwort konnte nicht geparst werden (siehe Console für vollständige Rohantwort)');
    }
  },
};
