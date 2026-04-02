import { CLAUDE_API } from './prompts.js';

// Methoden für Claude-API-Calls (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.

export const claudeMethods = {
  async callClaude(userPrompt, systemPrompt = null, onProgress = null) {
    const body = {
      model: this.claudeModel,
      max_tokens: this.claudeMaxTokens,
      temperature: 0.2,
      messages: [{ role: 'user', content: userPrompt }],
    };
    if (systemPrompt) body.system = systemPrompt;

    const resp = await fetch(CLAUDE_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const err = await resp.json();
      throw new Error('Claude API Fehler: ' + (err.error?.message || JSON.stringify(err)));
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
        } catch { /* SSE parse errors ignorieren */ }
      }
    }

    // JSON parsen: direkt versuchen, dann erstes {...}-Block extrahieren
    const clean = fullText.replace(/```json\s*|```/g, '').trim();
    try {
      return JSON.parse(clean);
    } catch {
      const match = clean.match(/\{[\s\S]*\}/);
      if (match) {
        try { return JSON.parse(match[0]); } catch {}
      }
      throw new Error(
        'Claude-Antwort konnte nicht geparst werden.\n\nRohantwort: ' + fullText.slice(0, 500)
      );
    }
  },
};
