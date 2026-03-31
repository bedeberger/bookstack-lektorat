import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Load .env from the project directory
const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dotenv = require('dotenv');
dotenv.config({ path: join(__dirname, '.env') });

const API_HOST   = process.env.API_HOST || process.env.BOOKSTACK_URL || 'http://localhost:80';
const TOKEN_ID   = process.env.TOKEN_ID   || '';
const TOKEN_PW   = process.env.TOKEN_KENNWORT || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const CLAUDE_MODEL  = 'claude-sonnet-4-20250514';

// --- BookStack helpers ---

function bsHeaders() {
  return {
    'Authorization': `Token ${TOKEN_ID}:${TOKEN_PW}`,
    'Content-Type': 'application/json',
  };
}

async function bsGet(path) {
  const url = `${API_HOST}/api/${path}`;
  const r = await fetch(url, { headers: bsHeaders() });
  if (!r.ok) throw new Error(`BookStack ${r.status}: ${await r.text()}`);
  return r.json();
}

async function bsPut(path, body) {
  const url = `${API_HOST}/api/${path}`;
  const r = await fetch(url, {
    method: 'PUT',
    headers: bsHeaders(),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`BookStack ${r.status}: ${await r.text()}`);
  return r.json();
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function text(str) {
  return [{ type: 'text', text: str }];
}

// --- MCP Server ---

const server = new McpServer({
  name: 'bookstack',
  version: '1.0.0',
});

// list_books
server.tool(
  'list_books',
  'Listet alle Bücher in BookStack auf.',
  {},
  async () => {
    const data = await bsGet('books?count=100');
    const books = (data.data || []).map(b => `[${b.id}] ${b.name}`);
    return { content: text(books.join('\n') || 'Keine Bücher gefunden.') };
  }
);

// list_chapters
server.tool(
  'list_chapters',
  'Listet alle Kapitel eines Buchs auf.',
  { book_id: z.number().describe('ID des Buchs') },
  async ({ book_id }) => {
    const data = await bsGet(`chapters?book_id=${book_id}&count=100`);
    const chapters = (data.data || []).map(c => `[${c.id}] ${c.name}`);
    return { content: text(chapters.join('\n') || 'Keine Kapitel gefunden.') };
  }
);

// list_pages
server.tool(
  'list_pages',
  'Listet alle Seiten eines Buchs auf.',
  { book_id: z.number().describe('ID des Buchs') },
  async ({ book_id }) => {
    const data = await bsGet(`pages?book_id=${book_id}&count=200`);
    const pages = (data.data || []).map(p => `[${p.id}] ${p.name}${p.chapter_id ? ` (Kapitel ${p.chapter_id})` : ''}`);
    return { content: text(pages.join('\n') || 'Keine Seiten gefunden.') };
  }
);

// get_page
server.tool(
  'get_page',
  'Liest den Inhalt einer Seite. Gibt Titel, Klartext und HTML zurück.',
  { page_id: z.number().describe('ID der Seite') },
  async ({ page_id }) => {
    const page = await bsGet(`pages/${page_id}`);
    const plainText = stripHtml(page.html || '');
    const out = [
      `# ${page.name}`,
      `ID: ${page.id} | Buch: ${page.book_id} | Kapitel: ${page.chapter_id || '–'}`,
      '',
      '## Text',
      plainText,
      '',
      '## HTML',
      page.html || '',
    ].join('\n');
    return { content: text(out) };
  }
);

// search
server.tool(
  'search',
  'Volltextsuche über alle BookStack-Inhalte.',
  {
    query: z.string().describe('Suchbegriff'),
    count: z.number().optional().describe('Maximale Anzahl Ergebnisse (Standard: 20)'),
  },
  async ({ query, count = 20 }) => {
    const data = await bsGet(`search?query=${encodeURIComponent(query)}&count=${count}`);
    const results = (data.data || []).map(r =>
      `[${r.type} ${r.id}] ${r.name}` + (r.preview_html ? `\n  ${stripHtml(r.preview_html)}` : '')
    );
    return { content: text(results.join('\n\n') || 'Keine Ergebnisse.') };
  }
);

// update_page
server.tool(
  'update_page',
  'Speichert neuen HTML-Inhalt in einer Seite.',
  {
    page_id: z.number().describe('ID der Seite'),
    html: z.string().describe('Neuer HTML-Inhalt'),
    name: z.string().optional().describe('Optionaler neuer Seitentitel'),
  },
  async ({ page_id, html, name }) => {
    const body = { html };
    if (name) body.name = name;
    const page = await bsPut(`pages/${page_id}`, body);
    return { content: text(`Seite "${page.name}" (ID ${page.id}) gespeichert.`) };
  }
);

// lektorat_page
server.tool(
  'lektorat_page',
  'Lektoriert eine BookStack-Seite mit Claude. Gibt Fehler, Stilanalyse und korrigiertes HTML zurück. Optional auto_save=true speichert das Ergebnis direkt.',
  {
    page_id: z.number().describe('ID der Seite'),
    auto_save: z.boolean().optional().describe('Korrigiertes HTML automatisch speichern (Standard: false)'),
  },
  async ({ page_id, auto_save = false }) => {
    if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY fehlt in .env');

    const page = await bsGet(`pages/${page_id}`);
    const html = page.html || '';
    const text_plain = stripHtml(html);

    const prompt = `Du bist ein deutschsprachiger Lektor für literarische Texte aus der Schweiz (Helvetismen wie "grösseres", "Strasse" etc. sind korrekt und sollen NICHT geändert werden).

Analysiere diesen Text auf:
1. Rechtschreibfehler
2. Grammatikfehler
3. Stilistische Anmerkungen (nur wenn auffällig)

Antworte NUR mit einem JSON-Objekt, kein Markdown, keine Erklärungen davor oder danach:
{
  "fehler": [
    {
      "typ": "rechtschreibung|grammatik|stil",
      "original": "das fehlerhafte Wort oder die fehlerhafte Phrase",
      "korrektur": "die korrekte Version",
      "kontext": "der Satz in dem der Fehler vorkommt (gekürzt)",
      "erklaerung": "kurze Erklärung auf Deutsch"
    }
  ],
  "korrekturen_html": "vollständiges korrigiertes HTML – behalte ALLE Tags exakt bei, ändere nur fehlerhafte Textstellen",
  "stilanalyse": "2-3 Sätze Stilanalyse",
  "fazit": "ein Satz Gesamtfazit"
}

Originaltext:
${text_plain}

Original-HTML (für korrekturen_html):
${html}`;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 8000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!resp.ok) throw new Error(`Anthropic API ${resp.status}: ${await resp.text()}`);

    const data = await resp.json();
    const raw = (data.content || []).map(b => b.text || '').join('');
    const clean = raw.replace(/```json\s*|```/g, '').trim();

    let result;
    try {
      result = JSON.parse(clean);
    } catch (e) {
      throw new Error('Claude-Antwort konnte nicht geparst werden: ' + raw.slice(0, 200));
    }

    const fehler = result.fehler || [];
    const errors = fehler.filter(f => f.typ !== 'stil');
    const styles = fehler.filter(f => f.typ === 'stil');

    let out = `# Lektorat: ${page.name}\n\n`;

    if (errors.length === 0) {
      out += '✓ Keine Rechtschreib- oder Grammatikfehler gefunden.\n';
    } else {
      out += `## ${errors.length} Fehler\n`;
      errors.forEach(f => {
        out += `\n**[${f.typ}]** ~~${f.original}~~ → **${f.korrektur}**\n`;
        out += `> «${f.kontext}»\n`;
        out += `${f.erklaerung}\n`;
      });
    }

    if (styles.length > 0) {
      out += `\n## ${styles.length} Stilanmerkungen\n`;
      styles.forEach(f => {
        out += `\n**[stil]** ${f.original} → ${f.korrektur}\n`;
        out += `${f.erklaerung}\n`;
      });
    }

    out += `\n## Stilanalyse\n${result.stilanalyse || '–'}\n`;
    out += `\n## Fazit\n${result.fazit || '–'}\n`;

    if (auto_save && result.korrekturen_html) {
      await bsPut(`pages/${page_id}`, { html: result.korrekturen_html });
      out += '\n✓ Korrigierte Version wurde in BookStack gespeichert.\n';
    } else if (result.korrekturen_html) {
      out += '\n---\nKorrigiertes HTML liegt vor. Mit `update_page` speichern oder `auto_save: true` setzen.\n';
    }

    return { content: [{ type: 'text', text: out }] };
  }
);

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
