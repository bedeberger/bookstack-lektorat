# Recherche-Chat

Agentischer Chat als **Panel in der Recherche-Karte** ([public/partials/recherche.html](../public/partials/recherche.html)). Recherchiert im offenen Web **und** im vorhandenen Recherche-Material, kennt die Buch-Entitäten als Kontext und schlägt Fundstücke als neue Recherche-Items vor. **Rückwärtsgewandt**: schreibt nie in den Buchtext ([user_app_philosophy]).

## Claude-only — warum

Die einzige Echtzeit-Websuche läuft über Anthropics serverseitiges `web_search`-Tool (kein eigener Google-Key, Anthropic führt die Suche selbst aus). Ollama/OpenAI-compat können das nicht. Darum ist der Chat Claude-only und das Panel wird **nur sichtbar, wenn der effektive Provider dieses Users Claude ist** (`/config` → `researchChat.enabled`, gesetzt in [routes/proxies.js](../routes/proxies.js): `resolveProvider({userEmail}) === 'claude'` + `ai.claude.api_key` gesetzt + Kill-Switch `research_chat.enabled` ≠ false). Der Job ([routes/jobs/research-chat.js](../routes/jobs/research-chat.js)) erzwingt zusätzlich `provider='claude'`.

## Datenmodell

Keine neue Tabelle — die Sessions leben in `chat_sessions` mit **`kind='research'`** (Migration 220; `page_id IS NULL`, buchweit, analog `kind='book'`). Nachrichten in `chat_messages`; `context_info` (JSON) trägt `tool_calls`, `web_searches` und die **`proposals`** (Speicher-Vorschläge).

## Tools ([routes/jobs/research-chat-tools.js](../routes/jobs/research-chat-tools.js) + [public/js/prompts/recherche.js](../public/js/prompts/recherche.js))

| Tool | Handler? | Zweck |
|------|----------|-------|
| `web_search` | nein (Anthropic-Server-Tool, Typ `web_search_20250305`) | Echtzeit-Websuche; Ergebnis + Citations kommen in derselben Runde zurück |
| `list_research_items` | ja | vorhandenes Board durchsuchen (FTS bei `q`) |
| `read_research_item` | ja | Volltext eines Eintrags inkl. PDF-`doc_text` (auf 8 000 Zeichen gekappt — die Kappung wird als `doc_chars`/`doc_truncated` **ausgewiesen**, sonst hält das Modell den Anfang für das ganze Dokument) |
| `search_research_passages` | ja | semantische Passagen-Suche; mit `item_id` **innerhalb** eines langen PDFs. Nur angeboten bei `embed.isEnabled()` |
| `list_book_entities` | ja | Figuren/Orte/Szenen/Beats/Stränge als Recherche-Kontext |
| `propose_research_item` | ja | sammelt EINEN Vorschlag in `ctx.proposals` — **persistiert nichts** |
| `final_answer` | terminal | Pflicht-Endpunkt der Antwort |

**Zwei Zugriffsarten aufs Archiv, bewusst getrennt:** `list_research_items` ist die **Wortsuche** (FTS5) und beantwortet „welche Einträge gibt es"; `search_research_passages` ist die **Bedeutungssuche** (Embeddings, [docs/semantic-search.md](semantic-search.md)) und beantwortet „welche Stelle passt zu dieser Frage". Der Fall, für den das zweite Werkzeug existiert, ist das lange PDF: ein 40-Seiten-Dokument ist über `read_research_item` nur mit seinem Anfang lesbar, über `search_research_passages` mit `item_id` dagegen an jeder Stelle. Ohne Embedding-Endpunkt wird das Werkzeug gar nicht erst angeboten (Filter in [research-chat.js](../routes/jobs/research-chat.js)) — das Modell bleibt dann bei der Wortsuche.

`web_search` wird vom Loop **nicht** ausgeführt: in [lib/ai.js](../lib/ai.js) landen `server_tool_use`-Blöcke nicht in `result.toolUses` (nur `tool_use`), bleiben aber samt `web_search_tool_result` verbatim in `rawContentBlocks` (Re-Send-Pflicht, falls daneben ein Custom-Tool lief).

## Speicher-Vorschläge (Bestätigungs-Modell)

`propose_research_item` schreibt **nichts** — der Vorschlag landet in `context_info.proposals`. Das Frontend ([public/js/chat/research-chat.js](../public/js/chat/research-chat.js) `saveResearchProposal`) rendert pro Vorschlag einen „Speichern"-Button; **erst der Klick** ruft `POST /research` und fügt das Item ins Board ein (analog zu den KI-Verknüpfungsvorschlägen). Spiegelt das `generate_image`→`ctx.images`-Sammelmuster des Buch-Chats.

Ein Vorschlag (und ein Recherche-Item generell) trägt **mehrere URLs** als `urls: [{ url, label }]` (http(s)-only, Tabelle `research_item_urls`, FK CASCADE — analog `research_item_tags`). Das Modell hängt alle belegenden Web-Quellen an einen `propose_research_item`-Aufruf; beim Speichern persistiert `POST /research` sie über `_replaceUrls`. Die alte Einzel-`url`-Spalte am `research_items` existiert nicht mehr (Migration 223).

## Loop ([routes/jobs/research-chat.js](../routes/jobs/research-chat.js))

Klon des agentischen Buch-Chat-Loops (`runBookChatJobAgent`), aber ohne Seiten-Vorladen und ohne Zitat-Validierung: `callAIWithTools` → Custom-Tools ausführen → `final_answer`/Prosa terminiert; bei erschöpften Iterationen erzwungener Synthese-Turn mit nur `final_answer`. Cap `jobs.research_chat.max_tool_iter` (Default 6).

## Frontend

Kein eigenes Card — Sub-State + Methoden sind in `rechercheCard` gespreadet ([public/js/cards/recherche-card.js](../public/js/cards/recherche-card.js)), Chat-Logik aus der geteilten `makeChatMethods`-Factory ([public/js/chat/chat-base.js](../public/js/chat/chat-base.js), Label `ResearchChat`). Toggle-Button im Karten-Header (nur bei `$app.researchChatEnabled`). Markup reused die `chat.css`-Klassen.

## Web-Such-Zitate (klickbare Quellen)

Bei aktiver `web_search` schreibt das Modell `<cite index="N-…">…</cite>`-Marker als Klartext in die `final_answer`-Antwort (claude.ai-Zitatformat; die strukturierten API-Citations hängen an Text-Blöcken, die finale Antwort ist aber ein Tool-Argument). Der geteilte Loop ([routes/jobs/agentic-chat.js](../routes/jobs/agentic-chat.js)) sammelt die `web_search_result`-Trefferdokumente (`url`+`title`) aus den `web_search_tool_result`-Blöcken **in Auftrittsreihenfolge, ohne Dedup** (das Modell referenziert per Position) und persistiert sie als `context_info.sources` (nur Recherche-Chat — Buch-Chat hat keine Web-Suche). Das Frontend ([research-chat.js](../public/js/chat/research-chat.js) `_renderResearchAnswer`) entfernt die `<cite>`-Tags, ersetzt sie durch klickbare Superscript-Marker `[N]` (1-basiert → N-tes Dokument, einzige Stelle der Basis-Annahme in `_resolveSource`) und rendert unter der Antwort eine Quellenliste (`researchCitedSources`). Sentinels (``/``) umgehen den XSS-Escape von `renderChatMarkdown`; url/title werden beim Inject escaped.

## Routen

- `POST /chat/session/research` / `GET /chat/sessions/research/:book_id` ([routes/chat.js](../routes/chat.js)) — editor-scoped, buchweit.
- `POST /jobs/research-chat` ([routes/jobs/chat.js](../routes/jobs/chat.js), via `_handleChatPost`) — Job-Queue, ACL `editor`.

## Pflicht-Invarianten

- Nie generativ in den Buchtext (nur Recherche/Weltaufbau). Der System-Prompt verbietet Manuskript-Generierung explizit.
- `propose_research_item` persistiert nie selbst — Speichern ist immer User-bestätigt.
- Claude-only: Sichtbarkeit gegated + Job erzwingt `provider='claude'`.
