# KI-Provider

Code: [lib/ai.js](../lib/ai.js). Drei Provider, ein Vertrag.

## Provider-Auswahl

Admin setzt `ai.provider` global in `app_settings` (`claude` (Default) | `ollama` | `openai-compat`). Pro User kann ein Override via `app_users.ai_provider_override` gesetzt werden — siehe „Per-User-Override" weiter unten.

### Auflösungs-Reihenfolge

`lib/ai.js#resolveProvider({ userEmail })`:

1. `app_users.ai_provider_override` (NULL = follows global)
2. `app_settings.ai.provider`
3. Hardcoded `'claude'`

`userEmail` kommt aus dem ALS-Context (Job-Queue: `runWithContext({ user: job.userEmail, … })`) oder explizit (Routes/SSE via `req.session.email`). Job-Pfade resolven den Provider einmalig am Job-Start (siehe `effectiveProvider` in `routes/jobs/review.js`, `kapitel.js`, `lektorat.js`, `synonyme.js`, `komplett/`). In-Flight-Override-Wechsel ändert den laufenden Job nicht.

### Per-User-Override

- **Wahl** pro User; **Credentials** bleiben global in `app_settings`. Kein Per-User-API-Key.
- Admin setzt den Override in der AdminUsersCard (Combobox `(Global: …)` | `claude` | `ollama` | `openai-compat`). PUT `/admin/users/:email` mit `{ ai_provider_override: 'ollama' | null }`. NULL/'' löscht den Override.
- API-Guard: Override auf nicht-konfigurierten Provider → `400 AI_PROVIDER_NOT_CONFIGURED`.
- `GET /config` liefert den resolvten Provider read-only (`apiProvider`) für die Frontend-Statuszeile.
- Self-Service nein. Cost-Verteilung gehört zum Admin-Kontrakt.

### Concurrency-Locks bleiben providerspezifisch

Locks serialisieren *pro Provider*, nicht pro User. Ollama läuft über einen strikten Mutex (`withOllamaLock`) — VRAM verträgt keine Parallelität. OpenAI-kompatibel läuft über eine **Semaphore** (`withOpenAICompatLock`, `makeSemaphore` in [lib/ai/shared.js](lib/ai/shared.js)) mit dynamisch gelesener Obergrenze `ai.openai-compat.max_parallel` (Default 1 = seriell wie Ollama, Admin-Setting, greift ohne Neustart). Höher setzen, wenn der lokale Server mehrere Slots verträgt (z.B. LocalAI); überzählige Calls warten in der Queue.

### Cache-Key-Erweiterung

`provider`-Spalte ist Pflicht-Teil des PRIMARY KEY in: `chapter_extract_cache`, `book_extract_cache`, `chapter_review_cache`, `book_review_cache`, `chapter_macro_review_cache`, `synonym_cache`, `lektorat_cache`. Ohne den Split würde Claude-Output an Ollama-User ausgeliefert. Migration 117 backfillt bestehende Eintraege mit dem zur Migrationszeit aktiven Globalwert.

Cache-Helpers (`db/schema.js`): `loadXxxCache(…, provider)` / `saveXxxCache(…, provider)`. Caller muessen den resolvten Provider durchreichen.

## Konfiguration: `app_settings` als SSoT

Alle KI-Konfig liegt in der `app_settings`-Tabelle. Admin-PUT via `/admin/settings`. `.env`-Vars sind nur **Boot-Spiegel**: beim ersten Start gespiegelt in `app_settings`, danach nie wieder gelesen (Mapping: [lib/app-settings.js:270-278](../lib/app-settings.js#L270-L278)). Änderungen am Setting per Admin-UI/PUT erfordern App-Restart (Werte werden beim Modul-Load gefrosted).

| Setting-Key | Default | Boot-Env | Bedeutung |
|-------------|---------|----------|-----------|
| `ai.provider` | `claude` | `API_PROVIDER` | Globaler Provider (`claude` \| `ollama` \| `openai-compat`) |
| `ai.claude.api_key` | – | `ANTHROPIC_API_KEY` | Pflicht bei Claude |
| `ai.claude.model` | `claude-sonnet-4-6` | `MODEL_NAME` | |
| `ai.claude.context_window` | 200 000 | `MODEL_CONTEXT` | Gesamtfenster (Input+Output) |
| `ai.claude.max_tokens_out` | 64 000 | `MODEL_TOKEN` | Output-Cap (`MAX_TOKENS_OUT`) |
| `ai.claude.retry_max` | 3 | – | Retry-Attempts bei 429/529 |
| `ai.claude.timeout_ms` | 600 000 | – | Hard-Timeout (10 min) |
| `ai.ollama.host` | `http://localhost:11434` | `OLLAMA_HOST` | |
| `ai.ollama.model` | `llama3.2` | `OLLAMA_MODEL` | |
| `ai.ollama.temperature` | 0.7 | `OLLAMA_TEMPERATURE` | Default `0.2` für Lock-Logik |
| `ai.ollama.context_window` | 32 000 | – | Per-Provider-Override |
| `ai.ollama.max_tokens_out` | 16 000 | – | |
| `ai.ollama.think` | `false` | – | Reasoning an/aus (top-level `think`-Flag); aus spart Output-Token |
| `ai.openai-compat.host` | `http://localhost:8080` | `OPENAI_COMPAT_HOST` | OpenAI-kompatibler `/v1/chat/completions`-Endpoint |
| `ai.openai-compat.model` | `llama3.2` | `OPENAI_COMPAT_MODEL` | |
| `ai.openai-compat.api_key` | – | `OPENAI_COMPAT_API_KEY` | Optionaler Bearer-Token (encrypted); leer = kein `Authorization`-Header |
| `ai.openai-compat.temperature` | 0.7 | `OPENAI_COMPAT_TEMPERATURE` | Default `0.1` für Lock-Logik |
| `ai.openai-compat.context_window` | 32 000 | – | |
| `ai.openai-compat.max_tokens_out` | 16 000 | – | |
| `ai.openai-compat.think` | `false` | – | Reasoning an/aus; aus sendet `chat_template_kwargs.enable_thinking=false`, an sendet nichts (Modell-Default; nötig für echtes OpenAI) |
| `ai.openai-compat.cloud` | `false` | – | Provider-Klasse (siehe unten): `true` = gehostetes Frontier-Modell (z.B. Kimi/Moonshot, OpenAI) → volle Cloud-Prompts, Lektorat-Split, parallele Calls |
| `ai.chars_per_token` | provider-default (3 Claude / 4 lokal) | – | Tokenizer-Heuristik (Boot-frozen) |
| `ai.chat_temperature` | – | – | Override nur für Seiten-/Buch-Chat |

| Provider | Streaming | Tool-Use | Caching |
|----------|-----------|----------|---------|
| `claude` | SSE | Ja (`callAIWithTools`) | `cache_control: ephemeral`, optional `ttl: '1h'` |
| `ollama` | NDJSON | Nein | Nein |
| `openai-compat` | OpenAI-SSE | Nein | Nein |

Ollama läuft über einen globalen **Mutex** (`withOllamaLock`) — VRAM-Schutz, parallele Calls würden das Modell abschmieren lassen. OpenAI-kompatibel läuft über eine **Semaphore** (`withOpenAICompatLock`) mit konfigurierbarer Obergrenze `ai.openai-compat.max_parallel` (Default 1). Jobs laufen weiter parallel; die KI-Calls am Server sind auf die Semaphore-Grenze gedrosselt (bzw. bei Ollama seriell).

### Reasoning/„Thinking" (nur lokale Provider)

Viele lokale Modelle (Qwen3, DeepSeek-R1-Distill, Magistral …) denken per Default und verbrennen Output-Token für eine `<think>`-Spur, die der App nichts bringt (wir parsen nur `message.content` bzw. `delta.content`, die Spur landet in `thinking`/`reasoning_content` und wird verworfen). `ai.ollama.think` / `ai.openai-compat.think` (Default `false`) schalten das pro Provider ab; per-Call gelesen → Admin-Änderung greift ohne Server-Restart.

- **Ollama:** top-level `think: <bool>` im `/api/chat`-Body (nicht in `options` — dort wird es ignoriert).
- **OpenAI-kompatibel:** bei `false` reicht der Body `chat_template_kwargs: { enable_thinking: false }` an die Jinja-Chat-Vorlage durch (vLLM/SGLang/llama.cpp; Server ohne dieses Kwarg ignorieren es folgenlos). Bei `true` wird das Feld **nicht** gesendet, damit echtes OpenAI (lehnt unbekannte Felder ab) nutzbar bleibt.

## Token-Budgets

Boot-Konstanten in `lib/ai.js` lesen den **Claude-Globalwert** beim Modul-Load:
- `MODEL_CONTEXT = ai.claude.context_window` (Default 200 000). Bei lokalen Modellen auf native Kontextgrösse setzen (Mistral-Small3.2 / Llama-3.1: 128 000, ältere: 32 000 / 8 000).
- `MAX_TOKENS_OUT = ai.claude.max_tokens_out` (Default 64 000). Job-spezifische Overrides per `Math.min` gedeckelt.
- `CHARS_PER_TOKEN`: Default `3` (Claude) / `4` (lokal), Override via `ai.chars_per_token`. Tokenizer-Heuristik für Char→Token-Umrechnung.

Abgeleitet:
- `INPUT_BUDGET_TOKENS = MODEL_CONTEXT − MAX_TOKENS_OUT − contextSafetyMargin(MODEL_CONTEXT)`.
- `INPUT_BUDGET_CHARS = INPUT_BUDGET_TOKENS × CHARS_PER_TOKEN`.

`contextSafetyMargin(ctx) = max(2000, round(ctx × 0.03))` — **proportional zum Fenster**, weil der Fehler der Char→Token-Heuristik mit der Prompt-Länge mitwächst: bei 72 000 geschätzten Input-Tokens deckt ein absoluter Puffer von 2000 keine 3 % Abweichung ab, während 5 % dort 3600 Tokens sind. Untergrenze 2000 für kleine Fenster (3 % von 8000 wären wirkungslos). Konkret: 200 000 → 6000, 90 000 → 2700, 32 000 → 2000, 1 000 000 (Komplett-Override) → 30 000.

Hard-Check beim Boot **pro Provider**: `max_tokens_out + contextSafetyMargin(context_window) < context_window`, sonst Crash (verhindert lokale-Provider-400-Fehler durch `max_tokens > num_ctx`). Derselbe Check läuft für den Komplett-Override (`ai.claude.max_tokens_out.komplett` gegen `ai.claude.context_window.komplett`) — Validierung und Budget-Rechnung lesen dieselbe Funktion, sonst divergieren sie. Der Frontend-Spiegel der Ableitung (`adminSettingsBudget` in [public/js/admin/admin-settings.js](../public/js/admin/admin-settings.js)) rechnet mit derselben Formel.

**Per-Provider via `getContextConfigFor(provider)`** ([lib/ai.js:968](../lib/ai.js#L968)): liefert `{ contextWindow, maxTokensOut, charsPerToken, safetyMargin, inputBudgetTokens, inputBudgetChars }` aus `ai.<provider>.context_window` + `ai.<provider>.max_tokens_out`. Fallback-Defaults: `claude=200000`, `ollama=32000`, `llama=32000` (`PROVIDER_CONTEXT_DEFAULTS`). Boot-Konstanten bleiben Claude-spezifisch für Backwards-Compat; neue Code-Pfade mit auflösbarem `userEmail` nutzen den Helper.

Job-Konstanten skalieren automatisch:
- `SINGLE_PASS_LIMIT = 0.7 × INPUT_BUDGET_CHARS`
- `PER_CHUNK_LIMIT  = 0.35 × INPUT_BUDGET_CHARS`
- `BOOK_CHAT_TOKEN_BUDGET` Default + Tool-Result-Caps + Classic-Buch-Chat-Text-Budget.

## API: callAI

```js
const { callAI } = require('../../lib/ai');

const { text, truncated, tokensIn, tokensOut, cacheReadIn, cacheCreationIn } = await callAI(
  userPrompt,
  systemPrompt,                          // String oder Array (s.u.)
  onProgress,                            // ({ chars, tokIn, delta }) => void
  maxTokensOverride,                     // optional, gedeckelt durch MODEL_TOKEN
  signal,                                // AbortController.signal
  provider,                              // optional, default API_PROVIDER
  jsonSchema,                            // optional, GBNF-Constrained nur lokal
);
```

**`systemPrompt` als Array** = mehrere Cache-Breakpoints (nur Claude):

```js
[{ text: bookText, ttl: '1h' }, { text: phaseSystem }]
// Claude: zwei cache_control-Blöcke (1h-Buch + 5min-Phase)
// Lokal:  zu einem String geflattet
```

**`callAIChat(messages, ...)`** — Multi-Turn-Variante mit Messages-Array.

**`callAIWithTools(messages, system, tools, ...)`** — Tool-Use, nur Claude. Wirft für Ollama/Llama. Caller verwaltet Loop: bei `stopReason === 'tool_use'` Tool-Results als `tool_result`-Blocks anhängen und neu callen.

## JSON-Pflicht

Jeder Systemprompt MUSS JSON-only erzwingen — `JSON_ONLY`-Konstante aus [public/js/prompts/state.js](../public/js/prompts/state.js).

Nach `callAI` ist Schema-Validierung Pflicht:

```js
const { text, truncated } = await callAI(...);
if (truncated) throw new Error('Output abgeschnitten — max_tokens erreicht.');
//                  ^^ IMMER vor parseJSON werfen, sonst liefert jsonrepair
//                     tolerant Partial-Daten (silent partial bug).

const parsed = parseJSON(text);
if (!parsed.fehler) throw new Error('Pflichtfeld `fehler` fehlt.');
```

`truncated`-Check zuerst, dann Parse, dann Pflichtfeld-Check.

## JSON-Parse-Fallback-Kette

`parseJSON(text)` in [lib/ai.js](../lib/ai.js):

1. Strip ```` ```json ```` -Fences, trim.
2. `JSON.parse()` direkt.
3. `extractBalancedJson()` — typ-sensitiver Stack, findet erstes balanciertes `{...}`.
4. `jsonrepair()` (toleranter Repairer).
5. `escapeUnescapedQuotes()` — escapet ASCII-`"` mitten in String-Werten (typisch: lokale Modelle vergessen Escape bei Anführungszeichen-Beispielen).
6. `jsonrepair(escaped)`.
7. Bei Fail: `_dumpParseFail` schreibt Rohtext in `ai_parse_fails/` (rotiert auf 50 Files), wirft mit Position-Preview.

`parseJSONLenient(text, [stringFields])` — schluckt Parse-Fehler, extrahiert benannte String-Felder einzeln per Regex (akzeptiert ASCII + typografische + DE/CH/FR-Quotes). Für User-Prosa-Rettung statt Job-Fail.

## Grammar-Constrained Decoding (lokal)

Optionales 7. Argument `jsonSchema`:
- **OpenAI-kompatibel**: `response_format: { type: 'json_schema', json_schema: { strict: true, schema } }` → GBNF-Grammar erzwingt Schema-Konformität + korrekt escapete Strings.
- **Ollama**: `format: <schema>` mit demselben Effekt.
- **Claude**: ignoriert (Claude nutzt prompt-basierte Schema-Validierung).

Fixt die "unescaped `"` im String"-Klasse von Bugs, die mistral-small3.2 ohne Schema produziert.

## Retries (nur Claude)

Transiente Fehler retryen mit Exp-Backoff (1s/2s/4s + Jitter, max `ai.claude.retry_max` = 3):
- HTTP 429 (Rate-Limit) — respektiert `retry-after`-Header.
- HTTP 529 (Overloaded).
- HTTP 503 mit `error.type === 'overloaded_error'` (Body-Typ-Detection via `_isOverloadedBody`).
- Stream-Event `overloaded_error` — nur retry wenn noch kein Text emittiert (sonst Output-Duplikat).

Nicht-retryable: alle anderen Status-Codes.

## Timeouts (Claude)

Hard-Timeout via `ai.claude.timeout_ms` (Default 600 000 ms = 10 min). `_combineSignals` merged User-Cancel und Timeout in einen AbortController. Marker `state.timedOut` unterscheidet Timeout (`code: 'AI_TIMEOUT'`) von User-Cancel (`AbortError`).

## Connection-Fehler (lokal)

`_connErrorCode` erkennt `ECONNREFUSED`/`ENOTFOUND`/`EHOSTUNREACH`/`ETIMEDOUT`/`EAI_AGAIN`/`ECONNRESET`/`ENETUNREACH` + node-fetch-`fetch failed`. Wirft i18n-keyed `error.OLLAMA_UNREACHABLE`/`error.OPENAI_COMPAT_UNREACHABLE` mit `i18nParams: { host, detail }`.

## Preflight: Input-Deckel vor dem Absenden

`assertPromptFitsContext` ([lib/ai/shared.js](../lib/ai/shared.js)) prüft **vor** jedem Call, ob geschätzter Input + Output-Cap + Sicherheitspuffer ins Kontextfenster passen:

```
estTokIn = promptChars / charsPerToken            // estimatePromptTokens(), zählt Prompt UND System-Blöcke
budget   = contextWindow − maxTokensOut − safetyMargin   // maxTokensOut = Cap DIESES Calls
estTokIn > budget  →  throw 'job.error.aiContextOverflow'
```

Der Wurf trägt `i18nParams: { provider, tokIn, window, maxOut, budget }` — die Meldung nennt die Zahlen und die drei Knöpfe (weniger Text, `ai.<provider>.context_window` höher, `ai.<provider>.max_tokens_out` tiefer).

Drei Aufrufer, ein Helfer:
- [routes/jobs/shared/ai.js](../routes/jobs/shared/ai.js)#`aiCall` — der Chokepoint, durch den alle Job-Calls laufen.
- `_callOllama` / `_callOpenAICompat` — defensiv, weil `callAIChat` aus den Chat-Jobs direkt in die Provider geht.

**Warum vorab:** ohne den Guard beantwortet llama.cpp/vLLM einen zu grossen Prompt mit `OpenAI-kompatibel 400: <Server-Text>` (kein Hinweis auf die Ursache), und Ollama kürzt still, weil es `num_ctx` selbst deckelt — der Job liefert dann ein Ergebnis über weniger Buch, als er behauptet. **Gekürzt wird darum nie automatisch**; der Job scheitert mit Ansage. Ist `contextWindow` unkonfiguriert, greift der Guard nicht (nicht raten).

Der Preflight **ersetzt den `truncated`-Check nicht** (siehe [JSON-Pflicht](#json-pflicht)): der eine deckt „Input zu gross", der andere „Output abgeschnitten".

## Sicherheits-Abbruch (lokal)

Während Streaming: wenn `estimatedOut > MAX_OUTPUT_RATIO × estimatedIn` (= 4×) → Abbruch + `truncated=true`. Schützt gegen Wiederholungs-Schleifen lokaler Modelle.

## Token-Tracking

Rückgabe enthält:
- `tokensIn` — Input-Tokens (inklusive Cache-Read + Cache-Creation bei Claude).
- `tokensOut` — generierte Output-Tokens.
- `cacheReadIn`, `cacheCreationIn` — Claude only, sonst 0.
- `truncated: bool` — `stop_reason === 'max_tokens'`.
- `genDurationMs` — Generation-Dauer ohne Setup-Zeit.

Lokale Provider: bei vollständigem Cache-Hit (`prompt_eval_count=0`) Fallback auf Char-Schätzung, damit Anzeige nicht 0 wird. Während Streaming KEIN Schätzwert für `tokIn` — sonst weicht Job-Status vom finalen `usage` ab.

## Provider-Unterschiede in Prompts

`_isLocal`-Flag aus [public/js/prompts/state.js](../public/js/prompts/state.js) wird in `configurePrompts` gesetzt. Lokale Modelle bekommen abgespeckte Prompts (kein POV-/Tempus-Block, keine Figuren-Beziehungen, kein Vorseiten-Kontext) — sparen Tokens, weil lokale Kontextfenster meist 32-128K statt 200K sind.

Schemas werden per `_rebuildLektoratSchema()`/`_rebuildKomplettSchemas()` provider-spezifisch neu gebaut **vor** `configureLocales`.

### Zwei Instanzen, weil der Provider pro User auflöst

`_isLocal` ist ein **Modul-Flag**, die Provider-Auflösung aber **pro User** (`resolveProvider`, s.o.). [lib/prompts-loader.js](../lib/prompts-loader.js) hält darum zwei getrennte Modulgraphen — `cloud` (claude) und `local` (ollama, bzw. openai-compat je nach Klassen-Schalter) — und konfiguriert jeden **einmal**. `getPrompts(userEmail)` wählt die Instanz zum effektiven Provider; `getPromptsForProvider(provider)` für Aufrufer, die ihn schon aufgelöst haben (Chat-Titel-Job).

Ohne diese Trennung bekäme im Mischbetrieb jeder User die Prompts des jeweils anderen Providers: ein lokales Modell die Cloud-Felder, die das `_isLocal`-Gating bewusst weglässt, weil kleine Modelle sie halluzinieren (`machtverhaltnis`, `aeusseres`/`stimme`/`hintergrund`/`arc`) — und Claude die Slim-Variante **ohne** die `JSON_ONLY`-Pflichtanweisung, womit bei Claude-Modellen ohne Structured-Output-Support keine Schicht mehr reines JSON erzwingt.

**Nicht pro Call umkonfigurieren:** die Job-Queue läuft parallel, und Konsumenten halten die Namespace-Referenz über `await`-Grenzen hinweg (`const prompts = await getPrompts(u)` … später `prompts.SCHEMA_X`). Ein Flip zwischendurch zöge ihnen den Boden weg.

Die Isolation trägt der ESM-Resolve-Hook [lib/prompts-variant-hooks.mjs](../lib/prompts-variant-hooks.mjs): er zieht die Varianten-Query vom Eltern- auf jedes Kindmodul. **Ein blosser Query-Cache-Buster genügt nicht** — er dupliziert nur die Einstiegsdatei, die Dependencies (und damit `state.js` mit `_isLocal`) blieben geteilt. Fehlt `module.register` (Node < 20.6), fällt der Loader mit Warnung auf **eine** Instanz nach globalem Provider zurück. Gegated: die `Provider-Varianten`-Tests in [tests/unit/prompts.test.mjs](../tests/unit/prompts.test.mjs).

`PROMPTS_VERSION` unterscheidet sich zwischen den Instanzen (Content-Hash über die gebauten Prompts). Das ist korrekt und braucht **keinen** Bump des Basis-Prefix: alle provider-partitionierten Cache-Tabellen führen `provider` im PRIMARY KEY, und jeder `cacheVersion`-String enthält zusätzlich `_modelName(effectiveProvider)`.

### Provider-Klasse (`cloud` vs. `local`) und der Schalter `ai.openai-compat.cloud`

Die Klassen-Entscheidung ist SSoT in `providerClass(provider)` ([lib/ai/config.js](../lib/ai/config.js)): `claude` → `cloud`, `ollama` → `local`, `openai-compat` → per Default `local` (llama.cpp/vLLM & Co), mit Admin-Toggle `ai.openai-compat.cloud = true` → `cloud` (gehostete Frontier-APIs wie Kimi/Moonshot oder OpenAI über denselben Endpoint-Typ). Per-Call gelesen → greift ohne Server-Restart; beim Flip wechselt `PROMPTS_VERSION` mit der Variante, Caches invalidieren dadurch automatisch.

Drei Konsumenten hängen an der Klasse (nicht am Provider-Namen):
- **Prompt-Variante** — `promptVariantFor` in [lib/prompts-loader.js](../lib/prompts-loader.js) (volle Cloud-Prompts inkl. `JSON_ONLY` vs. Slim-Prompts).
- **Lektorat-Kontext + Split** — `_isLocalProvider` in [routes/jobs/lektorat.js](../routes/jobs/lektorat.js): Klasse `cloud` lädt Vorseiten-Kontext/Figuren-Beziehungen/POV-Block wieder und lässt den fokussierten Objektiv/Stil-Split zu (sofern `ai.lektorat_split` aktiv).
- **Call-Serialisierung** — `settledAll` in [routes/jobs/shared/ai.js](../routes/jobs/shared/ai.js): Klasse `cloud` fährt parallel statt seriell; die Obergrenze bleibt die `max_parallel`-Semaphore (bei einem Frontier-Endpoint also `ai.openai-compat.max_parallel` hochsetzen).

Bewusst **nicht** klassen-, sondern provider-gegatet (`=== 'claude'`): Prompt-Caching (`cache_control`), Tool-Use (`callAIWithTools`, agentischer Buch-Chat, Recherche-Chat), Tiered Routing sowie die Claude-only-Jobs (Kontinuitäts-Verify, Faktencheck, Erzählprofil). Ein openai-compat-Frontier-Modell bekommt mit dem Schalter also die volle Prompt- und Strategie-Behandlung, aber keine Claude-API-Features — der Recherche-Chat bleibt für solche User ausgeblendet.

## Chat-Temperatur

`ai.chat_temperature` (app_settings) überschreibt Provider-Defaults nur für Seiten-Chat und Buch-Chat. Andere Job-Typen (Review, Lektorat, Komplett) bleiben deterministisch (Provider-Defaults: Ollama 0.2, Llama 0.1).
