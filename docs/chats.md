# Die drei Chats

Die App hat **drei unabhängige Chats**. Sie teilen sich nur das Storage-Modell (`chat_sessions` + `chat_messages`, diskriminiert über `chat_sessions.kind`) und die geteilte Frontend-Basis [public/js/chat/chat-base.js](../public/js/chat/chat-base.js) (`makeChatMethods`). Charakter, Job-Pfad, Tool-Set und Skopierung sind je Chat verschieden — bei Änderungs-/Bugfix-Wünschen am „Chat" **immer** zuerst klären, welcher gemeint ist (siehe Harte Regel „Chat-Spezifikation Pflicht" in [CLAUDE.md](../CLAUDE.md)).

## Übersicht

| | **Seiten-Chat** | **Buch-Chat** | **Recherche-Chat** |
|---|---|---|---|
| Karte / Frontend | `chatCard` ([chat-card.js](../public/js/cards/chat-card.js)) | `bookChatCard` ([book-chat-card.js](../public/js/cards/book-chat-card.js)) | Panel in `rechercheCard` ([recherche-card.js](../public/js/cards/recherche-card.js)) |
| Methods-Modul | [public/js/chat/chat.js](../public/js/chat/chat.js) | [public/js/chat/book-chat.js](../public/js/chat/book-chat.js) | [public/js/chat/research-chat.js](../public/js/chat/research-chat.js) |
| Job-POST | `/jobs/chat` | `/jobs/book-chat` | `/jobs/research-chat` |
| Job-Runner | `runChatJob` ([routes/jobs/chat.js](../routes/jobs/chat.js)) | `runBookChatJob` / `runBookChatJobAgent` ([routes/jobs/chat.js](../routes/jobs/chat.js)) | `runResearchChatJob` ([routes/jobs/research-chat.js](../routes/jobs/research-chat.js)) |
| Session-`kind` | `'page'` (mit `page_id`) | `'book'` (`page_id IS NULL`) | `'research'` (`page_id IS NULL`, buchweit) |
| Skopierung | pro Seite | pro Buch | pro Buch + User |
| Provider | alle | alle (Tool-Loop: Claude + openai-compat) | **Claude-only** (mit Anthropic-Web-Suche) |
| Tool-Loop | nein (klassisch) | ja, agentisch (`BOOK_CHAT_TOOLS`) | ja, agentisch (eigenes Tool-Set + Web-Suche) |
| Schreibt? | schlägt `vorschlaege` mit zeichengenauem `original` vor (User wendet an) | nein (read-only; Ausnahme `generate_image`) | schlägt `propose_research_item` vor (User bestätigt → POST `/research`) |

## Seiten-Chat

Läuft **neben dem Editor** (Ausnahme zur Exklusivitäts-Regel: kein `_closeOtherMainCards` beim Öffnen). Klassischer Chat ohne Tool-Loop. Antwortformat enthält `vorschlaege` mit zeichengenauem `original` für Textersetzung; unterliegt dem `updatedAt`-Staleness-Check (Vorschlag wird verworfen, wenn der User während der Analyse gespeichert hat). Session-`kind = 'page'` mit gesetztem `page_id`; Root dispatcht `chat:reset` beim Seitenwechsel.

## Buch-Chat

Buchweiter agentischer Chat **ohne** Vorschläge-System. Sessions: `kind = 'book'` mit `page_id IS NULL` (CHECK-Constraint erzwingt die Kombination). Read-only-Tool-Vertrag mit 33 Tools (Inventar, `ctx`-Vertrag, Truncation, Loop-Constraints, neues Tool anlegen: **[docs/buchchat-tools.md](buchchat-tools.md)**). Einzige bewusste Ausnahme zum Read-Only-Vertrag: `generate_image` (**[docs/image.md](image.md)**) — nie in den Manuskript-Text. Per-Job-Claude-Override möglich (`ai.claude.*.bookchat`). Root dispatcht `book-chat:reset`.

**Erst-Kontext im agentischen Pfad:** vor der ersten Tool-Iteration legt `preContextPassages` ([book-chat-retrieval.js](../routes/jobs/chat/book-chat-retrieval.js)) die semantisch nächsten Passagen zur Frage als eigenen System-Block in den Prompt (`jobs.book_chat.pre_rag_top_k` / `…pre_rag_chars`, 0 = aus). Zusammen mit der **Kosten-Leiter** im System-Prompt beantwortet der Agent schmale Faktenfragen ohne Werkzeug-Runde, statt auf Kapitel-Volltexte zu eskalieren — Details, Cache-Invariante und Sichtbarkeit (`context_info.pre_context`): [docs/buchchat-tools.md](buchchat-tools.md#erst-kontext--kosten-leiter).

**Zwei Pfade (Dispatcher `runBookChatJobDispatch`):** der **agentische** Tool-Loop (`runBookChatJobAgent`) läuft, wenn der effektive Provider Werkzeuge kann (`providerSupportsTools` — Claude und `openai-compat`, siehe [ai-providers.md](ai-providers.md#tool-use)) und `jobs.book_chat.mode` ≠ `classic`; Ollama sowie `mode='classic'` fahren den **klassischen** Single-Pass (`runBookChatJob`). Zwei Achsen sind für lokale Endpunkte anders eingestellt, weil dort **kein Prompt-Caching** greift und damit JEDE Iteration den vollen Prompt neu bezahlt: der **Werkzeugsatz** ist per Default der Slim-Satz (16 statt 37 Werkzeuge, `jobs.book_chat.tool_set` = `auto|slim|full`; SSoT der Liste: `BOOK_CHAT_SLIM_TOOL_NAMES` in [prompts/book-chat-tools.js](../public/js/prompts/book-chat-tools.js)) und der **Iterations-Deckel** ein eigener, niedrigerer (`jobs.book_chat.max_tool_iter_local`, Default 6). Welcher Satz lief, steht in `context_info.tool_set`/`tools_offered`. Lehnt ein Endpunkt Werkzeuge ab, fällt der Job auf den klassischen Pfad zurück statt zu scheitern (`AI_TOOLS_UNSUPPORTED` → `fallbackJob`). Der klassische Pfad ist ein **Mini-RAG**: Retrieval → relevante Buchtext-Auszüge in den System-Prompt. Ist der Embedding-Index aktiv (`embed.isEnabled()`), zieht `selectPassagesSemantic` die bedeutungs-relevantesten Chunk-Auszüge (ein bester Chunk pro Seite, `jobs.book_chat.rag_top_k`, Default 40) über die geteilte Pipeline [lib/semantic-retrieval.js](../lib/semantic-retrieval.js)#`semanticQuery` (Cosinus + Hybrid-RRF + optional Rerank — identisch zu `search_similar`/Such-Karte) — dichter/präziser als das Fallback und **ohne alle Seiten zu laden**. Fällt auf Keyword-Scoring über alle geladenen Seiten (`_scorePageRelevance`) zurück, wenn kein Index existiert, das Embedding-Backend ausfällt oder die Anfrage keine semantischen Treffer liefert. Der Modus landet als `context_info.retrievalMode` (`semantic`/`keyword`).

## Recherche-Chat

Agentischer Chat als **Panel in der Recherche-/Wissensboard-Karte**, **Claude-only** mit Anthropics serverseitigem `web_search`-Tool. Aufbau analog `runBookChatJobAgent`, aber eigenes Tool-Set + Web-Suche, ohne Seiten-Vorladen/Zitat-Validierung. Rückwärtsgewandt im Sinne der App-Philosophie: recherchiert + sammelt Material, **schreibt nie in den Buchtext**. Vorschläge (`propose_research_item`) werden **nicht** automatisch gespeichert — sie kommen in `context_info.proposals` zurück, der User bestätigt sie im Frontend (POST `/research`). Session-`kind = 'research'`, pro Buch + User gescoped. Panel nur sichtbar, wenn der effektive Provider Claude ist + Kill-Switch `research_chat.enabled` ≠ false (`/config` → `researchChat.enabled`). Volle Details (Tool-Tabelle, Loop, Bestätigungs-Modell): **[docs/recherche-chat.md](recherche-chat.md)**.

## Geteiltes

- **Storage:** `chat_sessions` (diskriminiert über `kind`) + `chat_messages`. Beim Buch-Migration-Export werden Seiten- und Buch-Chat mitgenommen ([docs/book-migration.md](book-migration.md)).
- **History-Titel (KI):** `chat_sessions.title` hält einen kurzen, KI-zusammengefassten Titel für den History-Eintrag — einmal pro Session beim ersten Antwort-Turn generiert ([routes/jobs/chat-title.js](../routes/jobs/chat-title.js), Prompt `buildChatTitlePrompt` + `SCHEMA_CHAT_TITLE`). Non-fatal: schlägt die Generierung fehl, bleibt `title` NULL und die Liste fällt auf die Vorschau (erste Nachricht) zurück. Der Titel kommt im Job-Result (`sessionTitle`) zurück und wird in [chat-base.js](../public/js/chat/chat-base.js) (`onDone`) in die Sessions-Liste übernommen; das Rendering liest `s.title || s.preview`.
- **Frontend-Basis:** [chat-base.js](../public/js/chat/chat-base.js) (`makeChatMethods`) — gemeinsames Verhalten, in die jeweilige Card gespreadet. Implementierungs-Detail, keine fachliche Kopplung.
- **Temperatur:** `ai.chat_temperature` (app_settings) überschreibt Provider-Defaults für Seiten- **und** Buch-Chat ([docs/ai-providers.md](ai-providers.md)).
