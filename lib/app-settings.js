'use strict';
// Single Source of Truth fuer Runtime-Configs. Konsumenten lesen Werte ueber get(key) und reagieren
// optional auf das 'changed'-Event, wenn der Admin per PUT etwas aendert.
//
// Auflösung:
//   1. DB-Setting (app_settings)
//   2. Hardcoded Default (DEFAULTS)
// Kein ENV-Fallback fuer migrierte Keys — `.env` ist fuer diese Keys tot.
// Boot-Layer-Werte (PORT, DB_PATH, SESSION_SECRET, ADMIN_EMAIL,
// ADMIN_PASSWORD, TZ, LOG_LEVEL, LOCAL_DEV_MODE, VERAPDF_BIN) bleiben in ENV.

const { EventEmitter } = require('events');
const { db } = require('../db/connection');
require('../db/migrations');
const { NOW_ISO_SQL } = require('../db/now');
const { encrypt, decrypt, isEncrypted } = require('./crypto');
const logger = require('../logger');

const events = new EventEmitter();

// Pro Server-Boot Memory-Cache; Invalidierung via set() + clearCache().
const _cache = new Map();

// Hardcoded Defaults. Werte sind nicht-sensitiv (keine API-Keys, keine Tokens).
// Bei migrierten Keys greift der Default, solange `app_settings` keine Row hat.
const DEFAULTS = {
  // Auth
  'auth.allow_open_signup':    false,
  // ALTCHA-Proof-of-Work-Schutz fuer /register und den ENV-Admin-Login.
  // Self-hosted, kein Drittanbieter-Call. enabled=false = aus; harter
  // Rate-Limit (3/h/IP Register, 5/15min Admin-Login) bleibt unabhaengig
  // davon aktiv. Das HMAC-Secret (auth.altcha.hmac_secret) wird beim
  // Aktivieren automatisch generiert, falls noch leer.
  'auth.altcha.enabled':       false,
  // PoW-Schwierigkeit = obere Grenze der zu durchsuchenden Zahl. Hoeher =
  // mehr Browser-Rechenzeit pro Loesung (Bot-Kosten), aber traegere UX.
  'auth.altcha.complexity':    100000,
  // Lebensdauer einer ausgegebenen PoW-Challenge in Minuten. Lang genug fuer
  // langsame Geraete, kurz genug um das Replay-Fenster eng zu halten (der
  // Rate-Limit deckt den Rest).
  'auth.altcha.challenge_ttl_min':  10,
  // Maximalalter pending-Anfragen; Cron setzt sie danach auf
  // 'expired' (DB-Status). Default 30 Tage analog spec.
  'auth.registration.expire_days': 30,
  // Register-Formular-Rate-Limit (In-Memory, pro IP). max Anfragen pro
  // window_min Minuten; danach 429 mit Retry-After. Schuetzt das oeffentliche
  // /register vor Spam-Anmeldungen, unabhaengig vom ALTCHA-Toggle.
  'auth.register.rate_limit_max':         3,
  'auth.register.rate_limit_window_min':  60,
  // Admin-Login-Lockout (In-Memory, pro IP). Nach max_fails Fehlversuchen
  // innerhalb window_min Minuten wird die IP fuer denselben Zeitraum gesperrt
  // (429 + Retry-After).
  'auth.admin_login.max_fails':           5,
  'auth.admin_login.window_min':          15,

  // SMTP (Gmail-App-Password). Pflichtfelder fuer Mailer-Aktivierung sind
  // `smtp.gmail.user` + `smtp.gmail.app_password`. Defaults leer, damit das
  // Admin-Settings-UI die Keys auch ohne bestehende DB-Row rendert (sonst
  // greift der `if (!s) continue`-Guard im Save-Pfad).
  'smtp.gmail.user':           '',
  'smtp.gmail.app_password':   '',
  'smtp.from_name':            'Schreibwerkstatt',
  'smtp.reply_to':             '',
  'smtp.rate_limit_per_minute': 30,

  // Notification-Mails (Job-Crash, Token-Cap, Budget-Overrun).
  // Master-Toggles je Pfad; Throttle deduped Crash-/Token-Cap-Mails
  // pro {type,errorPrefix} fuer N Minuten. skip_errors blockiert genannte
  // i18n-Keys (Komma-Liste); leer = Defaults aus lib/notify.js.
  'mail.notify.admin_on_job_fail':        true,
  'mail.notify.admin_on_token_cap':       true,
  'mail.notify.user_on_budget_overrun':   true,
  'mail.notify.admin_on_budget_overrun':  true,
  // Beta-Leser-Feedback: Owner-Mail bei neuem Share-Kommentar (gedrosselt pro
  // Link, opt-out). Owner-eigene Antworten loesen nichts aus.
  'mail.notify.owner_on_share_comment':   true,
  // Reviewer-Mail, wenn der Autor auf seinen Thread antwortet (nur wenn der Leser
  // eine Adresse hinterlegt hat; gedrosselt pro Thread, opt-out).
  'mail.notify.reader_on_owner_reply':    true,
  'mail.notify.job_fail_throttle_min':    60,
  'mail.notify.skip_errors':              'job.cancelled,BUDGET_EXCEEDED,job.error.aiTruncated,job.error.parseFailed,job.error.aiInvalidJson',
  // Forward-Adresse fuer Admin-Notifications. Leer = an alle aktiven Admin-User
  // (global_role='admin'). Gesetzt = ersetzt diese Liste komplett, sodass
  // Mails an eine Adresse gehen, die nicht zwingend einem Admin-Account
  // entspricht.
  'mail.notify.admin_recipient':          '',

  // KI-Provider
  'ai.provider':               'claude',
  'ai.claude.model':           'claude-sonnet-4-6',
  // Per-Job-Overrides nur für die Komplettanalyse-Familie (leer/0 = folgt dem globalen
  // Wert). Erlauben z.B. Opus 4.8 mit 128K Output, vollem Kontext und längerem Hard-Timeout
  // für die gründlichere Extraktion, während global Sonnet 4.6 / 64K / 10min fürs Lektorat
  // läuft. WICHTIG: max_tokens_out muss zum komplett-Modell passen (Sonnet 4.6 ≤ 64000,
  // Opus 4.8 ≤ 128000) – ein zu hoher Wert für das gewählte Modell führt zu HTTP 400.
  // timeout_ms.komplett: Opus ist langsamer und der Single-Pass macht mehrere grosse Calls,
  // darum braucht die Buchanalyse oft mehr als die globalen 10 Min pro Call.
  'ai.claude.model.komplett':           '',
  'ai.claude.context_window.komplett':  0,
  'ai.claude.max_tokens_out.komplett':  0,
  'ai.claude.timeout_ms.komplett':      0,
  // Tiered Model Routing (nur Komplettanalyse, nur Claude): günstigeres Modell für die
  // MECHANISCHEN Extraktions-Calls (Vollextraktion, Completeness-Gaps, Coverage-Audit,
  // Lebensereignisse), während die KONSOLIDIERUNG + das Kontinuitäts-Urteil auf dem
  // starken `ai.claude.model.komplett` laufen. Leer = kein Tiering (Extraktion folgt
  // ebenfalls `ai.claude.model.komplett`). Beispiel: extract=claude-sonnet-5,
  // model.komplett=claude-opus-4-8[1m]. Das Extraktions-Modell fliesst in die cacheVersion
  // (es erzeugt den gecachten Phase-1-Inhalt).
  'ai.claude.model.komplett.extract':   '',
  // Effort (output_config.effort) NUR für die Komplettanalyse-Familie (P1–P8 + Kontinuität).
  // Leer = kein Effort-Feld (API-Default 'high'). Sinnvoll auf Opus 4.7+/Sonnet 5: 'xhigh'
  // für die anspruchsvollsten Urteils-/Verify-Phasen, 'high' als Standard. Wird via ALS an
  // lib/ai.js gereicht (_resolveClaudeEffort) und greift NUR bei `ai.provider = claude`.
  // Ungültige Werte werden dort still auf null gemappt (kein 400). Achtung: Effort-Tokens
  // (adaptive Thinking) zählen gegen dasselbe max_tokens-Budget wie das JSON.
  'ai.claude.effort.komplett':          '',
  // Effort NUR fuer die mechanischen Extraktions-Calls der Komplettanalyse (dieselbe
  // Gruppe, die `ai.claude.model.komplett.extract` routet: Vollextraktion,
  // Completeness-Gaps, Coverage-Audit/-Feedback, Szenen-Backfill, Lebensereignisse).
  // Leer = folgt `ai.claude.effort.komplett`.
  //
  // WOZU: Extraktion ist Aufzaehlen, kein Urteilen — die Denk-Tiefe der
  // Kontinuitaetspruefung ist dort verschenkt. Da Reasoning-Tokens auf dieselbe
  // Output-Rechnung laufen wie das JSON, ist das der direkteste Kosten- UND
  // Dauer-Hebel: 'medium' oder 'low' hier, waehrend `effort.komplett` fuer P8/
  // Konsolidierung/Verify hoch bleibt. Reicht der Recall nicht, wieder anheben.
  // Der Wert fliesst in die cacheVersion (Wechsel invalidiert die Phase-1-Caches).
  'ai.claude.effort.komplett.extract':  '',
  // Dieselbe Per-Job-Override-Familie für den Buch-Chat (klassisch + agentisch).
  // Leer/0 = folgt dem globalen Wert. Erlaubt z.B. Opus für den agentischen Tool-Loop
  // (bessere Tool-Auswahl/Mehrschritt-Reasoning im 6-Iterationen-Budget), während global
  // Sonnet 4.6 für Lektorat/Komplettanalyse läuft. Greift nur bei `ai.provider = claude`.
  'ai.claude.model.bookchat':           '',
  'ai.claude.context_window.bookchat':  0,
  'ai.claude.max_tokens_out.bookchat':  0,
  'ai.claude.timeout_ms.bookchat':      0,
  'ai.claude.max_tokens_out':  64000,
  'ai.claude.context_window':  200000,
  'ai.claude.retry_max':       3,
  'ai.claude.timeout_ms':      600000,
  'ai.claude.phase1_concurrency': 4,
  'ai.ollama.host':            'http://localhost:11434',
  'ai.ollama.model':           'llama3.2',
  'ai.ollama.temperature':     0.7,
  'ai.ollama.context_window':  32000,
  'ai.ollama.max_tokens_out':  16000,
  // Anti-Loop: penalisiert kürzlich wiederholte Tokens und bricht so die
  // Wiederholungsschleifen, in die kleine Modelle bei grammar-constrained JSON
  // laufen (endloses Generieren identischer Array-Items bis zum Token-Cap).
  // 1.0 = aus; mild (1.1–1.2) reicht meist, ohne legitime Key-Wiederholung im
  // JSON zu schädigen.
  'ai.ollama.repeat_penalty':  1.15,
  // Reasoning/„Thinking" an/aus. Viele lokale Modelle (Qwen3, DeepSeek-R1-Distill,
  // Magistral …) denken per Default und verbrennen so Output-Tokens für eine
  // <think>-Spur, die wir verwerfen. false (Default) unterdrückt das via Ollama-
  // `think`-Flag; true lässt das Modell denken.
  'ai.ollama.think':           false,
  'ai.openai-compat.host':           'http://localhost:8080',
  'ai.openai-compat.model':          'llama3.2',
  'ai.openai-compat.temperature':    0.7,
  'ai.openai-compat.context_window': 32000,
  'ai.openai-compat.max_tokens_out': 16000,
  // Optionaler Bearer-Token für gehostete OpenAI-kompatible Endpoints (vLLM,
  // LiteLLM, OpenAI). Leer = kein Authorization-Header (lokale llama.cpp-Server).
  'ai.openai-compat.api_key':        '',
  // Anti-Loop für OpenAI-kompatible lokale Server, siehe ai.ollama.repeat_penalty.
  'ai.openai-compat.repeat_penalty': 1.15,
  // Reasoning/„Thinking" an/aus, siehe ai.ollama.think. false (Default) sendet
  // `chat_template_kwargs: { enable_thinking: false }` mit — der De-facto-Standard
  // für vLLM/SGLang/llama.cpp (Qwen3 & Co). Server ohne dieses Template-Kwarg
  // ignorieren es folgenlos. true sendet das Kwarg NICHT (Modell-Default, denkt
  // i.d.R.) — so bleibt auch echtes OpenAI, das unbekannte Felder ablehnt, nutzbar.
  'ai.openai-compat.think':          false,
  // Max. gleichzeitige Calls an den OpenAI-kompatiblen Server. 1 = strikt seriell
  // (wie Ollama). Höher setzen, wenn der lokale Server parallele Requests verträgt
  // (z.B. LocalAI mit mehreren Slots). Überzählige Calls warten in einer Queue.
  'ai.openai-compat.max_parallel':   1,
  'ai.chat_temperature':       0.7,
  'ai.chars_per_token':        3,
  'ai.lektorat_batch_concurrency': 2,
  // Handler-Backstop zur Prompt-Mengen-Obergrenze: max. Anzahl SUBJEKTIV-stilistischer
  // Lektorat-Findings pro Seite (Liste: STILISTISCHE_TYPEN in
  // public/js/prompts/lektorat-typen.js). Objektive Fehler (Rechtschreibung/Grammatik/
  // Zeichensetzung, Tempus-/Perspektivbruch, Dialogformat) sowie Konsistenz-, Form- und
  // Beleg-Befunde werden NIE gekappt. Deterministische Absicherung, weil Modelle die
  // Selbst-Obergrenze im Prompt unzuverlässig einhalten.
  'ai.lektorat_stylistic_cap': 20,
  // Claude-Split: ob das Seiten-Lektorat in fokussierte Einzel-Pässe aufgeteilt wird
  // (Objektiv-Pass für Rechtschreibung/Grammatik + Stil-Pass für Stil/Szenen) statt
  // einem grossen Kombi-Call. Fokussierte Pässe liefern präzisere/vollständigere Funde.
  // Nur Cloud/Claude – lokale Provider fahren immer einen Kombi-Call.
  'ai.lektorat_split': true,
  // Anzahl paralleler Objektiv-Läufe, deren übereinstimmende Funde (Konsens) behalten
  // werden. Greift nur bei aktivem Split. Default 1 = ein Objektiv-Lauf ohne Konsens
  // (genau ein fokussierter Call pro Typ: Objektiv + Stil). Höher = Konsens für mehr Präzision.
  'ai.lektorat_objective_runs': 1,
  // Konsens-Schwelle: ein objektiver Fund bleibt nur, wenn ihn ≥ so viele der K
  // Läufe melden. Höher = strenger/präziser, weniger Recall. Auf K geklemmt.
  'ai.lektorat_consensus_threshold': 2,
  // Output-Token-Cap pro Komplettanalyse-Extraktions-Call (Phase 1: Single-Pass-
  // lokal sowie Multi-Pass Split-Pässe A/B). Basis-Versuch; bei Truncation eskaliert
  // der Job einmalig auf das Provider-Ceiling (`ai.<provider>.max_tokens_out`), statt
  // den Chunk zu verwerfen. Effektiv immer durch das Provider-Ceiling gedeckelt.
  'ai.komplett.extract_max_tokens': 16000,
  // Completeness-/Gap-Pässe der Komplettanalyse (nur Claude Single-Pass): wie oft nach
  // der Erst-Extraktion zusätzlich gezielt nach FEHLENDEN Figuren/Schauplätzen/Fakten/
  // Szenen gesucht wird (Long-Tail-Recall). 0 = aus. Default 2: Gap-Pässe lesen denselben
  // 1h-gecachten Buchtext-Block (cache_read, ~10× billiger als der Erst-Pass) und holen den
  // Long-Tail nach, den ein einzelner Extraktions-Call zuverlässig auslässt. Loop-until-dry:
  // stoppt früher, sobald eine Runde nichts Neues liefert. Höher = gründlicher, mehr Tokens.
  'ai.komplett.completeness_passes': 2,
  // Coverage-Self-Audit (nur Claude): nach der Konsolidierung werden N zufällige Kapitel
  // gesampelt und das Modell gefragt, welche namentlich genannten Figuren/Schauplätze im
  // Katalog FEHLEN → Recall-Score ins Job-Result (Sichtbarkeit statt Blindflug). Läuft auf
  // dem Extraktions-Tier (günstig). 0 = aus. Diagnostisch, nicht gecacht.
  'ai.komplett.coverage_audit_chapters': 3,
  // Schwelle, unter der der Coverage-Score als Warnung (job.warn.coverageLow) gemeldet wird.
  'ai.komplett.coverage_min_score':      0.8,
  // Attribut-Widerspruchs-Detektor (nur Claude): baut aus figure_events/world_facts eine
  // Attribut→Kapitel→Wert-Sicht, findet deterministisch Kandidatenpaare mit divergenten Werten
  // und lässt das Modell (Konsolidierungs-Tier) nur diese beurteilen → Cross-Chapter-Widersprüche,
  // die der fakten-basierte Kontinuitäts-Pfad pro Kapitel strukturell übersieht. true = an.
  'ai.komplett.attribute_check':         true,
  // Weltfakten-Realitätscheck (Standalone-Job /jobs/faktencheck, nur Claude): prüft die
  // extrahierten Welt-Fakten mit Anthropics web_search gegen die reale Faktenlage. Instanz-
  // Kill-Switch — bewusst Default AUS, weil jede Web-Suche echtes Geld kostet; der Betreiber
  // schaltet ihn frei. Zusätzlich pro Buch opt-in (book_settings.weltfakten_real_pruefen).
  'ai.komplett.factcheck':               false,
  // Extraktions-Single-Pass-Schwelle (Zeichen), ENTKOPPELT von der Kontinuitäts-Schwelle.
  // 0 = folgt der Kontinuitäts-Schwelle (context_window-abgeleitet; heutiges Verhalten). >0
  // begrenzt die EXTRAKTION auf kleinere Chunks (höherer Per-Chunk-Recall + Alias-Cluster +
  // Multi-Pass-Gap), während Kontinuität/Erzählprofil weiterhin das ganze Buch im 1M-Fenster
  // sehen. Empfehlung für Opus 4.8 + 1M: ~700000. Fliesst in die cacheVersion (Wechsel
  // invalidiert die Extraktions-Caches). Nur Claude.
  'ai.komplett.extract_single_pass_cap': 0,
  // Coverage-Feedback (nur Claude Single-Pass): der Vollständigkeits-Audit (siehe
  // coverage_audit_chapters) läuft zusätzlich VOR E/A2 und speist die namentlich als
  // fehlend gemeldeten Figuren/Schauplätze als gezielten Nachzieh-Pass ein (nicht nur als
  // Metrik am Ende). Greift nur wenn coverage_audit_chapters > 0. true = an.
  'ai.komplett.coverage_feedback':       true,
  // Szenen-Backfill (nur Claude Single-Pass): Kapitel mit substanziellem Text (≥
  // scene_backfill_min_chars Zeichen), für die die Extraktion 0 Szenen lieferte, bekommen
  // einen gezielten Szenen-Nachzieh-Call. Deterministische Lückenerkennung, nur der Fix
  // braucht KI. true = an.
  'ai.komplett.scene_backfill':          true,
  'ai.komplett.scene_backfill_min_chars': 3000,
  // Figuren-Batch-Grösse für die Lebensereignis- (E) und Beziehungs- (A2) Pässe (nur Claude
  // Single-Pass): grosse Casts werden in Gruppen dieser Grösse gebündelt und parallel
  // abgefragt (kleinere, robustere Outputs, weniger Truncation). ≤ Cast-Grösse → 1 Call
  // (heutiges Verhalten für kleine Bücher). A2 batcht per «von»-Scope erst OBERHALB dieser
  // Grösse (Paar-Dedup übernimmt mergeBeziehungenIntoFiguren).
  'ai.komplett.figure_batch_size':       20,
  // Remap-Rescue (nur Claude): vor dem Verwerfen nicht auflösbarer Klarnamen aus Szenen/
  // Events ein billiger Auflösungs-Call (Kandidaten + Katalognamen → Zuordnung oder
  // «unbekannt»), damit Szenen-Figuren-Links und Event-Assignments nicht verloren gehen.
  // Läuft nur, wenn es überhaupt unauflösbare Namen gibt. true = an.
  'ai.komplett.remap_rescue':            true,

  // Jobs / Buch-Chat
  'jobs.max_concurrent':       1,
  'jobs.book_chat.mode':       'auto',
  'jobs.book_chat.max_tool_iter': 12,
  'jobs.book_chat.token_budget':  0,
  // Klassischer Buch-Chat (Nicht-Claude / mode=classic): Anzahl der semantisch
  // retrievten Auszüge (ein bester Chunk pro Seite) im Mini-RAG-Pfad. Greift nur,
  // wenn der Embedding-Index aktiv ist; sonst Keyword-Scoring über alle Seiten.
  'jobs.book_chat.rag_top_k':     40,
  // Recherche-Chat (Claude-only, mit Web-Suche). Kill-Switch + Iterations-Cap.
  'research_chat.enabled':        true,
  'jobs.research_chat.max_tool_iter': 6,

  // Cron / Sync
  // app.timezone gilt fuer Cron, Server-Datums-Buckets (lib/local-date.js)
  // und Frontend-Display-Formatter (toLocaleString, Intl.DateTimeFormat).
  // Single Source of Truth — Browser-TZ wird ueberschrieben.
  'app.timezone':              'Europe/Zurich',
  'cron.stale_days':           7,

  // PDF/A
  'pdfa.flavour':              '2b',
  'pdfa.disabled':             false,

  // App-Name fuer Startup-Log, Mail-Templates etc.
  'app.name':                  'Schreibwerkstatt',

  // Floor fuer page_revisions-Tiered-Retention: jueng­ste N Revisions pro Seite
  // werden zusaetzlich zum GFS-Bucket-Schema (Tag/Woche/Monat/Jahr) garantiert
  // behalten. Cleanup-Hook in lib/cache-cleanup.js → db/page-revisions.js#pruneTiered.
  // Range 1..500 (Validator + UI); Default 50.
  'app.page_revision_limit':   50,

  // Page-Lock-TTL (Lektorat-Mutex + Edit-Advisory) in Minuten. So lange bleibt
  // ein Lock ohne Heartbeat gueltig, bevor er ablaeuft und die Seite wieder
  // editierbar wird. Quelle: db/book-access.js#_acquireOrExtendLock.
  'editor.lock_ttl_min':       30,

  // Share-Link Beta-Leser-Kommentar-Rate-Limit (In-Memory, pro Token + IP-Hash).
  // max Kommentare pro window_min Minuten; danach 429 mit Retry-After. Beta-Leser
  // hinterlassen viele verankerte Inline-Anmerkungen pro Sitzung — grosszuegig
  // genug halten, aber kein Bot-Schleudertor.
  'share.comment.rate_limit_max':         30,
  'share.comment.rate_limit_window_min':  60,

  // GitHub-Token (PAT) fuer den macOS-Client-Release-Abruf (lib/macclient-release.js).
  // Optional: leer = unauthentifizierter Public-API-Zugriff (60 Req/h pro IP). Gesetzt =
  // Bearer-Token, hebt das Rate-Limit (5000 Req/h). Default leer, damit das Admin-Settings-UI
  // den (encrypted) Key auch ohne bestehende DB-Row rendert (analog smtp.gmail.app_password).
  'macclient.github_token':    '',

  // Öffentliche Basis-URL der App (ohne Slash am Ende). Wird für OIDC-Callback,
  // Invite-Mails und Share-Links genutzt. Admin-Pflicht: leer = OIDC-Login und
  // Invite-Versand nicht möglich; LOCAL_DEV_MODE fällt auf http://localhost:PORT.
  'app.public_url':            '',

  // Plausible-Analytics (self-hosted). enabled=false → kein Tracking, kein
  // CSP-Eintrag. script_url ist die volle URL zum Bootstrap-JS, z.B.
  // https://analytics.example.com/js/pa-XXXX.js — Origin wird daraus
  // abgeleitet und in CSP scriptSrc/connectSrc aufgenommen.
  'analytics.plausible.enabled':    false,
  'analytics.plausible.script_url': '',

  // LanguageTool (self-hosted, regelbasierte Rechtschreib-/Grammatikpruefung).
  // enabled=true + url gesetzt aktiviert Overlay-Spellcheck in allen Editoren
  // und deaktiviert Browser-Spellcheck. Picky-Mode aktiviert zusaetzliche
  // Stil-Regeln.
  'languagetool.enabled': false,
  'languagetool.url':     '',
  'languagetool.picky':   false,
  // Debounce-Zeit fuer den Spellcheck-Controller in den drei Editoren
  // (contenteditable). Nach jeder Eingabe wartet der Controller diese Spanne,
  // bevor er /languagetool/check ruft. Form-Felder (input/textarea) nutzen
  // eigene Defaults und sind hiervon unberuehrt.
  'languagetool.debounce_ms': 1500,

  // Speech-to-Text (self-hosted, OpenAI-kompatibler Whisper-Endpunkt).
  // enabled=true + host gesetzt blendet den Mic-Diktat-Button im Notebook-Editor
  // ein. Sprache loest der /stt/transcribe-Proxy pro Request aus der Buch-Locale
  // auf (SSoT wie LanguageTool); stt.language ist nur Fallback ohne Buchscope.
  // VAD-Schwellen steuern die browserseitige Sprechpausen-Segmentierung und
  // gehen ueber /config ins Frontend (VAD laeuft im Browser).
  'stt.enabled':            false,
  'stt.host':               '',
  'stt.model':              '',
  'stt.language':           'de',
  'stt.temperature':        0,
  // Upstream-Timeout fuer den Whisper-Forward. Grosszuegig, damit ein
  // GPU-Cold-Start (Modell-Reload nach Idle) den ersten Request nicht als
  // Timeout abschneidet und das Segment verliert. Self-hosted tunebar.
  'stt.upstream_timeout_ms': 30000,
  'stt.vad.silence_ms':     800,
  'stt.vad.threshold':      0.015,
  'stt.vad.max_segment_s':  30,

  // Text-to-Speech (self-hosted, OpenAI-kompatibler Speech-Endpunkt) —
  // „Proof-Listening". enabled=true + host gesetzt blendet den Vorlese-Button im
  // Notebook-Editor ein. Der /tts/speak-Proxy synthetisiert pro Satz; voice/
  // speed/format gehen serverseitig in den Request, nie ins Frontend.
  'tts.enabled':            false,
  'tts.host':               '',
  'tts.model':              '',
  // Standard-Stimme (Fallback). Locale-spezifische Stimmen (tts.voice.de /
  // tts.voice.en) ueberschreiben sie, wenn fuer die Buch-Locale gesetzt — der
  // /tts/speak-Proxy loest die Stimme pro Request aus der Buch-Locale auf
  // (SSoT wie bei STT/LanguageTool die Sprache).
  'tts.voice':              '',
  'tts.voice.de':           '',
  'tts.voice.en':           '',
  'tts.format':             'mp3',
  'tts.speed':              1,
  // Atempause (ms) zwischen den vorgelesenen Fragmenten — gibt dem Ohr Luft,
  // statt nahtlos ins naechste Fragment ueberzugehen. fragment_ms gilt Satz-zu-
  // Satz innerhalb eines Absatzes, paragraph_ms an Absatzgrenzen (Block-Wechsel,
  // meist etwas laenger). 0 = keine Pause. Browserseitig in der Abspiel-Schleife
  // angewandt, daher via /config ans Frontend geliefert (kein Secret).
  'tts.pause.fragment_ms':  250,
  'tts.pause.paragraph_ms': 550,

  // Bild-Generierung (self-hosted, OpenAI-kompatibler Image-Endpunkt).
  // enabled=true + host gesetzt schaltet das agentische Buch-Chat-Tool
  // `generate_image` frei (greift nur bei ai.provider=claude — nur dort gibt es
  // den Tool-Loop). Der /v1/images/generations-Call laeuft serverseitig im
  // Chat-Tool; Host/Model/Key verlassen den Server nie. Erzeugte Bilder sind
  // reine Weltaufbau-/Chat-Visualisierung: sie landen NICHT im Manuskript,
  // sondern nur im Chat-Verlauf (abrufbar + herunterladbar). size geht 1:1 an
  // den Endpunkt (z.B. "1024x1024"); SD-/Flux-Wrapper interpretieren es selbst.
  'image.enabled':     false,
  'image.host':        '',
  'image.model':       '',
  'image.size':        '1024x1024',
  'image.timeout_ms':  120000,

  // Semantische Suche (self-hosted, OpenAI-kompatibler /v1/embeddings-Endpunkt,
  // z.B. LocalAI). enabled=true + host gesetzt schaltet den Semantik-Suchmodus,
  // die „ähnliche Stellen"-Buttons an Figuren/Szenen und das Buch-Chat-Tool
  // `search_similar` frei (semanticSearch.enabled im /config leitet sich daraus
  // ab). Host/Model/Key verlassen den Server nie — nur der Ableitungs-Flag geht
  // ans Frontend. bge-m3: mehrsprachig, 8k Kontext (ganze Szene am Stück), 1024
  // dim. Modellwechsel invalidiert die Vektoren implizit (model steht im Chunk-
  // Key, Query filtert aufs aktive Modell → Reindex nötig). dim muss zum Modell
  // passen; nur als Sanity-Guard gespeichert, die echte Länge kommt vom Endpunkt.
  'embed.enabled':     false,
  'embed.host':        '',
  'embed.model':       'bge-m3',
  'embed.dim':         1024,
  'embed.timeout_ms':  60000,
  // Trefferqualität. min_score: Cosinus-Untergrenze für Freitext-Treffer — die
  // reine Ähnlichkeitssuche liefert nie „keine Treffer" (jede Anfrage hat einen
  // nächsten Nachbarn), darum schneidet dieser Floor den schwachen Long-Tail ab,
  // damit unter den guten Treffern kein Rauschen steht. Modellabhängig (bge-m3:
  // relevante Passagen meist > 0.4); 0 = aus. Gilt nur für Freitext, nicht für
  // „ähnliche Stellen zu Entität" (dort zählt Recall). hybrid: mischt die
  // lexikalische FTS5-Rangliste per Reciprocal Rank Fusion in die Freitext-
  // Semantiksuche — fängt exakte Begriffe/Eigennamen ein, die reine Embeddings
  // verlieren. query_prefix/passage_prefix: Instruction-Präfixe für asymmetrische
  // Modelle (z.B. e5: „query: " / „passage: "); bge-m3 braucht sie NICHT (leer
  // lassen). passage_prefix fliesst in den Chunk-Hash → Änderung erzwingt Reindex.
  'embed.min_score':      0.25,
  'embed.hybrid':         true,
  'embed.query_prefix':   '',
  'embed.passage_prefix': '',

  // Plot-Verankerung (Beat-Anchor): Score-Untergrenze fürs Fundstellen-Popover +
  // Drift-Badge der Plot-Werkstatt. Blendet schwache semantische Beat-Treffer aus
  // (0 = alle zeigen). Filtert count UND Liste am Lese-Chokepoint → wirkt sofort
  // ohne Anchor-Neulauf. FTS-/wörtliche Treffer (score=null) bleiben immer sichtbar.
  'plot.anchor.min_score': 0,

  // Plot-Verankerung — Promotion-Schwelle: ab welcher semantischen Ähnlichkeit ein
  // GEPLANTER Beat als „offenbar schon geschrieben" gilt und ein Promotion-Badge
  // („Als im Buch markieren?") bekommt. Bewusst hoch (Default 0.55) — geplante Beats
  // würden bei niedriger Schwelle für praktisch jeden Beat schwache Treffer liefern
  // und das Board mit falschen Vorschlägen fluten. Greift beim Anchor-Lauf (Store-
  // Zeit, nicht Lese-Zeit): nur Fundstellen ≥ dieser Schwelle werden für geplante
  // Beats überhaupt gespeichert. 0 = Promotion-Erkennung aus.
  'plot.anchor.promote_min_score': 0.55,

  // Motiv-Erkennung (Motiv-Werkstatt, Ist-Index): Cosinus-Untergrenze für die
  // Fundstellen eines Motivs im Text. Blendet unwahrscheinliche semantische Treffer
  // aus Panel-Liste, Konfidenz-% UND Ist-Dichte (Graph-Knotengrösse + Geist-Erkennung)
  // aus — gefiltert am Lese-Chokepoint, wirkt sofort ohne Motiv-Scan-Neulauf. Wörtliche
  // Trigger-Treffer (score=null) bleiben immer sichtbar (Exakt-Match). Modellabhängig
  // wie embed.min_score; Default auf bge-m3 geeicht (0 = alle zeigen).
  'motif.scan.min_score': 0.45,

  // Redundanz-Radar: Cosinus-Schwellen der drei UI-Bänder (streng/mittel/locker),
  // die der buchweite Doppelungs-Scan (lib/redundancy.js) über dem embed-Index
  // fährt. Modellabhängig wie embed.min_score — die Defaults sind auf bge-m3
  // geeicht; bei einem anderen Embedding-Modell hier nachjustieren (fremde Modelle
  // haben andere Cosinus-Verteilungen). Der Job clampt zusätzlich auf 0.70–0.97.
  'redundancy.threshold_strict': 0.88,
  'redundancy.threshold_medium': 0.82,
  'redundancy.threshold_loose':  0.76,

  // Reranker (self-hosted, OpenAI/Jina-kompatibler /v1/rerank-Endpunkt, z.B.
  // LocalAI, TEI). Cross-Encoder-Nachordnung der Freitext-Kandidaten aus der
  // semantischen Suche: bewertet (Anfrage, Dokument)-Paare direkt statt über
  // Vektor-Distanz → schärfere Relevanz als die Retrieval-Stufe allein. Setzt
  // aktivierte semantische Suche voraus (ordnet deren Treffer nach). top_n =
  // Kandidatenpool, der rerankt wird (RRF/Cosinus als erste Stufe, Reranker als
  // zweite). min_score: Relevanz-Untergrenze nach dem Reranking (0 = alle
  // behalten; Skala modellabhängig, bge-reranker ~ Sigmoid 0..1). Host/Model/Key
  // verlassen den Server nie. Fällt der Endpunkt aus, greift still die RRF-/
  // Cosinus-Reihenfolge (non-fatal).
  'rerank.enabled':    false,
  'rerank.host':       '',
  'rerank.model':      'bge-reranker-v2-m3',
  'rerank.api_key':    '',
  'rerank.timeout_ms': 30000,
  'rerank.top_n':      30,
  'rerank.min_score':  0,

  // Geocoding (Orte-Karte). provider waehlt die Koordinaten-Quelle: OSM-Nominatim
  // (public oder self-hosted) oder Photon (Komoot, self-hosted). Die jeweilige
  // url-Setting zeigt auf die Instanz. Nominatim hat einen public Default;
  // Photon braucht zwingend eine eigene URL (leer = kein Geocoding-Vorschlag,
  // manueller Pin bleibt moeglich).
  'geocode.provider':      'nominatim',
  'geocode.nominatim.url': 'https://nominatim.openstreetmap.org/search',
  'geocode.photon.url':    '',
  // Tile-Server der Orte-Karte. Leaflet holt die Kacheln direkt im Browser, die
  // URL wird daher via /config ans Frontend geliefert (anders als die Geocoder-
  // URLs, die nur serverseitig genutzt werden). Default = Public-OSM (Tile Usage
  // Policy beachten); ein self-hosted Tile-Server (openstreetmap-tile-server /
  // tileserver-gl) bekommt seine eigene URL im {z}/{x}/{y}.png-Schema. Die
  // {s}-Subdomain ist optional — Leaflet ignoriert den Platzhalter, wenn die URL
  // ihn nicht enthaelt. attribution leer = Frontend nutzt den i18n-Default.
  'geocode.tiles.url':         'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  'geocode.tiles.attribution': '',
};

// Range-/Enum-Validation pro Key. `set()` wirft bei Verstoss
// `InvalidSettingValueError` — Admin-PUT-Route mappt das auf 400, andere Caller
// (env-bootstrap, Tests) loggen + skippen. Ranges decken sich mit der
// numInput-min/max-Spec im Admin-UI (public/partials/admin-settings.html);
// wer dort ein Limit aendert, zieht es hier mit.
//
// Bewusst nicht abgedeckt: freie String-Settings (URLs, Tokens, Hosts) —
// dort ist „leer = aus" valider Zustand, harte Pattern-Checks bringen wenig.
const VALIDATORS = {
  // Auth
  'auth.registration.expire_days':      { type: 'int',    min: 1,    max: 365   },
  'auth.register.rate_limit_max':       { type: 'int',    min: 1,    max: 1000  },
  'auth.register.rate_limit_window_min':{ type: 'int',    min: 1,    max: 1440  },
  'auth.admin_login.max_fails':         { type: 'int',    min: 1,    max: 1000  },
  'auth.admin_login.window_min':        { type: 'int',    min: 1,    max: 1440  },
  'auth.altcha.complexity':             { type: 'int',    min: 1000, max: 5000000 },
  'auth.altcha.challenge_ttl_min':      { type: 'int',    min: 1,    max: 120   },
  // SMTP
  'smtp.rate_limit_per_minute':         { type: 'int',    min: 1,    max: 500   },
  // Mail-Notify
  'mail.notify.job_fail_throttle_min':  { type: 'int',    min: 0,    max: 1440  },
  // KI
  'ai.provider':                        { type: 'enum',   oneOf: ['claude', 'ollama', 'openai-compat'] },
  'ai.claude.max_tokens_out':           { type: 'int',    min: 1024, max: 200000 },
  'ai.claude.context_window':           { type: 'int',    min: 8000, max: 2000000 },
  // Komplett-Overrides: 0 = folgt global; sonst dieselben Grenzen wie global.
  'ai.claude.context_window.komplett':  { type: 'int',    min: 0,    max: 2000000 },
  'ai.claude.max_tokens_out.komplett':  { type: 'int',    min: 0,    max: 200000 },
  'ai.claude.timeout_ms.komplett':      { type: 'int',    min: 0,    max: 3600000 },
  // Buch-Chat-Overrides: 0 = folgt global; sonst dieselben Grenzen wie global.
  'ai.claude.context_window.bookchat':  { type: 'int',    min: 0,    max: 2000000 },
  'ai.claude.max_tokens_out.bookchat':  { type: 'int',    min: 0,    max: 200000 },
  'ai.claude.timeout_ms.bookchat':      { type: 'int',    min: 0,    max: 3600000 },
  'ai.claude.retry_max':                { type: 'int',    min: 0,    max: 10    },
  'ai.claude.timeout_ms':               { type: 'int',    min: 1000, max: 3600000 },
  'ai.claude.phase1_concurrency':       { type: 'int',    min: 1,    max: 16    },
  'ai.ollama.temperature':              { type: 'number', min: 0,    max: 2     },
  'ai.ollama.context_window':           { type: 'int',    min: 2048, max: 2000000 },
  'ai.ollama.max_tokens_out':           { type: 'int',    min: 512,  max: 200000 },
  'ai.ollama.repeat_penalty':           { type: 'number', min: 1,    max: 2     },
  'ai.openai-compat.temperature':       { type: 'number', min: 0,    max: 2     },
  'ai.openai-compat.context_window':    { type: 'int',    min: 2048, max: 2000000 },
  'ai.openai-compat.max_tokens_out':    { type: 'int',    min: 512,  max: 200000 },
  'ai.openai-compat.repeat_penalty':    { type: 'number', min: 1,    max: 2     },
  'ai.openai-compat.max_parallel':      { type: 'int',    min: 1,    max: 16    },
  'ai.chat_temperature':                { type: 'number', min: 0,    max: 2     },
  'ai.chars_per_token':                 { type: 'number', min: 1,    max: 10    },
  'ai.lektorat_batch_concurrency':      { type: 'int',    min: 1,    max: 8     },
  'ai.lektorat_stylistic_cap':          { type: 'int',    min: 1,    max: 200   },
  'ai.lektorat_split':                  { type: 'bool' },
  'ai.lektorat_objective_runs':         { type: 'int',    min: 1,    max: 6     },
  'ai.lektorat_consensus_threshold':    { type: 'int',    min: 1,    max: 6     },
  'ai.komplett.extract_max_tokens':     { type: 'int',    min: 1024, max: 200000 },
  'ai.komplett.completeness_passes':    { type: 'int',    min: 0,    max: 3     },
  'ai.komplett.extract_single_pass_cap':{ type: 'int',    min: 0,    max: 2000000 },
  'ai.komplett.scene_backfill_min_chars':{ type: 'int',   min: 500,  max: 100000 },
  'ai.komplett.figure_batch_size':      { type: 'int',    min: 1,    max: 200   },
  // Jobs
  'jobs.max_concurrent':                { type: 'int',    min: 1,    max: 8     },
  'jobs.book_chat.mode':                { type: 'enum',   oneOf: ['auto', 'agent', 'classic'] },
  'jobs.book_chat.max_tool_iter':       { type: 'int',    min: 1,    max: 50    },
  'jobs.book_chat.token_budget':        { type: 'int',    min: 0,    max: 2000000 },
  'jobs.book_chat.rag_top_k':           { type: 'int',    min: 1,    max: 200   },
  'research_chat.enabled':              { type: 'bool' },
  'jobs.research_chat.max_tool_iter':   { type: 'int',    min: 1,    max: 50    },
  // Cron / App
  'cron.stale_days':                    { type: 'int',    min: 1,    max: 365   },
  'app.page_revision_limit':            { type: 'int',    min: 1,    max: 500   },
  'editor.lock_ttl_min':                { type: 'int',    min: 1,    max: 1440  },
  'share.comment.rate_limit_max':       { type: 'int',    min: 1,    max: 1000  },
  'share.comment.rate_limit_window_min':{ type: 'int',    min: 1,    max: 1440  },
  // PDF/A
  'pdfa.flavour':                       { type: 'enum',   oneOf: ['2b', '3b']   },
  // LanguageTool
  'languagetool.debounce_ms':           { type: 'int',    min: 200,  max: 10000 },
  // Speech-to-Text (VAD-Schwellen; Ranges deckungsgleich mit numInput im Admin-UI)
  'stt.temperature':                    { type: 'number', min: 0,    max: 1     },
  'stt.upstream_timeout_ms':            { type: 'int',    min: 5000, max: 120000 },
  'stt.vad.silence_ms':                 { type: 'int',    min: 200,  max: 5000  },
  'stt.vad.threshold':                  { type: 'number', min: 0,    max: 1     },
  'stt.vad.max_segment_s':              { type: 'int',    min: 5,    max: 120   },
  // Text-to-Speech (Proof-Listening; speed-Range deckungsgleich mit numInput im Admin-UI)
  'tts.speed':                          { type: 'number', min: 0.25, max: 4     },
  'tts.format':                         { type: 'enum',   oneOf: ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'] },
  'tts.pause.fragment_ms':              { type: 'int',    min: 0,    max: 5000  },
  'tts.pause.paragraph_ms':             { type: 'int',    min: 0,    max: 5000  },
  // Geocoding
  'geocode.provider':                   { type: 'enum',   oneOf: ['nominatim', 'photon'] },
  // Bild-Generierung
  'image.timeout_ms':                   { type: 'int',    min: 5000, max: 600000 },
  // Semantische Suche — Trefferqualität
  'embed.min_score':                    { type: 'number', min: 0,    max: 1     },
  'embed.hybrid':                       { type: 'bool' },
  'plot.anchor.min_score':              { type: 'number', min: 0,    max: 1     },
  'plot.anchor.promote_min_score':      { type: 'number', min: 0,    max: 1     },
  'motif.scan.min_score':               { type: 'number', min: 0,    max: 1     },
  // Redundanz-Radar-Bänder
  'redundancy.threshold_strict':        { type: 'number', min: 0,    max: 1     },
  'redundancy.threshold_medium':        { type: 'number', min: 0,    max: 1     },
  'redundancy.threshold_loose':         { type: 'number', min: 0,    max: 1     },
  // Reranker
  'rerank.enabled':                     { type: 'bool' },
  'rerank.timeout_ms':                  { type: 'int',    min: 5000, max: 600000 },
  'rerank.top_n':                       { type: 'int',    min: 5,    max: 100   },
  'rerank.min_score':                   { type: 'number', min: 0,    max: 1     },
};

class InvalidSettingValueError extends Error {
  constructor(key, reason) {
    super(`${key}: ${reason}`);
    this.name = 'InvalidSettingValueError';
    this.code = 'INVALID_VALUE';
    this.key = key;
    this.reason = reason;
  }
}

function _validate(key, value) {
  const v = VALIDATORS[key];
  if (!v) return;
  if (v.type === 'enum') {
    if (!v.oneOf.includes(value)) {
      throw new InvalidSettingValueError(key, `muss einer aus [${v.oneOf.join(', ')}] sein (got ${JSON.stringify(value)})`);
    }
    return;
  }
  if (v.type === 'int') {
    if (!Number.isInteger(value)) {
      throw new InvalidSettingValueError(key, `muss Integer sein (got ${JSON.stringify(value)})`);
    }
  } else if (v.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new InvalidSettingValueError(key, `muss Number sein (got ${JSON.stringify(value)})`);
    }
  }
  if (typeof v.min === 'number' && value < v.min) {
    throw new InvalidSettingValueError(key, `muss >= ${v.min} sein (got ${value})`);
  }
  if (typeof v.max === 'number' && value > v.max) {
    throw new InvalidSettingValueError(key, `muss <= ${v.max} sein (got ${value})`);
  }
}

// Welche Keys werden encrypted persistiert? `set()` darf das nicht selbst
// raten — Caller markiert explizit, weil ein vergessener `encrypted:true`-
// Flag Token-Klartext in der DB landen liesse.
const ENCRYPTED_KEYS = new Set([
  'auth.google.client_id',
  'auth.google.client_secret',
  'auth.altcha.hmac_secret',
  'ai.claude.api_key',
  'ai.openai-compat.api_key',
  'smtp.gmail.app_password',
  'stt.api_key',
  'tts.api_key',
  'image.api_key',
  'embed.api_key',
  'rerank.api_key',
  'macclient.github_token',
]);

function isEncryptedKey(key) {
  return ENCRYPTED_KEYS.has(key);
}

// Bekannter Key = hat einen Hardcoded-Default ODER ist ein (defaultloser)
// Encrypted-Key. Die Admin-PUT-Route lehnt unbekannte Keys ab, damit Tippfehler
// nicht stillschweigend als toter Eintrag in app_settings landen.
function isKnownKey(key) {
  return Object.prototype.hasOwnProperty.call(DEFAULTS, key) || ENCRYPTED_KEYS.has(key);
}

const _stmtGet = db.prepare('SELECT value_json, encrypted FROM app_settings WHERE key = ?');
const _stmtList = db.prepare('SELECT key, value_json, encrypted, updated_at, updated_by FROM app_settings ORDER BY key');
const _stmtUpsert = db.prepare(`
  INSERT INTO app_settings (key, value_json, encrypted, updated_at, updated_by)
  VALUES (@key, @value_json, @encrypted, ${NOW_ISO_SQL}, @updated_by)
  ON CONFLICT(key) DO UPDATE SET
    value_json = excluded.value_json,
    encrypted  = excluded.encrypted,
    updated_at = excluded.updated_at,
    updated_by = excluded.updated_by
`);
const _stmtDelete = db.prepare('DELETE FROM app_settings WHERE key = ?');
const _stmtAuditInsert = db.prepare(`
  INSERT INTO app_settings_audit (key, old_hash, new_hash, updated_by, updated_at)
  VALUES (?, ?, ?, ?, ${NOW_ISO_SQL})
`);

function _readFromDb(key) {
  const row = _stmtGet.get(key);
  if (!row) return undefined;
  let raw = row.value_json;
  if (row.encrypted) {
    try { raw = decrypt(raw); }
    catch (e) {
      logger.error(`app-settings: Decrypt-Fehler fuer ${key}: ${e.message}`);
      return undefined;
    }
  }
  try { return JSON.parse(raw); }
  catch (e) {
    logger.error(`app-settings: JSON-Parse-Fehler fuer ${key}: ${e.message}`);
    return undefined;
  }
}

function get(key) {
  if (_cache.has(key)) return _cache.get(key);
  const fromDb = _readFromDb(key);
  const value = fromDb !== undefined ? fromDb : (DEFAULTS[key] !== undefined ? DEFAULTS[key] : undefined);
  _cache.set(key, value);
  return value;
}

function has(key) {
  return _readFromDb(key) !== undefined;
}

function set(key, value, { updatedBy = 'system' } = {}) {
  const encrypted = isEncryptedKey(key);
  // Sentinel `__unchanged__` fuer Encrypted-Felder: nicht ueberschreiben.
  if (encrypted && value === '__unchanged__') return get(key);
  _validate(key, value);
  const json = JSON.stringify(value);
  const stored = encrypted && typeof value === 'string' ? encrypt(json) : json;
  // Audit: SHA-256-Hash beider Werte. Klartext-Secrets nie in der Audit-Tabelle.
  const crypto = require('crypto');
  const oldRaw = _readFromDb(key);
  const oldHash = oldRaw === undefined ? null : crypto.createHash('sha256').update(JSON.stringify(oldRaw)).digest('hex').slice(0, 16);
  const newHash = crypto.createHash('sha256').update(json).digest('hex').slice(0, 16);
  _stmtUpsert.run({
    key,
    value_json: stored,
    encrypted: encrypted ? 1 : 0,
    updated_by: updatedBy,
  });
  _stmtAuditInsert.run(key, oldHash, newHash, updatedBy);
  _cache.delete(key);
  events.emit('changed', { key, updatedBy });
  return value;
}

function remove(key, { updatedBy = 'system' } = {}) {
  _stmtDelete.run(key);
  _cache.delete(key);
  events.emit('changed', { key, removed: true, updatedBy });
}

// Liste fuer Admin-UI: encrypted-Werte werden maskiert (letzte 4 Zeichen
// sichtbar, falls vorhanden — sonst Sentinel "***").
function listForAdmin() {
  const rows = _stmtList.all();
  const map = new Map(rows.map(r => [r.key, r]));
  // Encrypted-Keys immer aufnehmen — auch die ohne Hardcoded-Default und ohne
  // DB-Row. Sonst rendert das Admin-UI zwar das Passwort-Feld (aus dem Partial),
  // aber der Key fehlt in adminSettingsMap → adminSettingsSave überspringt ihn
  // (`if (!s) continue`) und der eingegebene Wert wird stillschweigend verworfen.
  const allKeys = new Set([...rows.map(r => r.key), ...Object.keys(DEFAULTS), ...ENCRYPTED_KEYS]);
  const out = [];
  for (const key of [...allKeys].sort()) {
    const row = map.get(key);
    const encrypted = row?.encrypted ? 1 : (isEncryptedKey(key) ? 1 : 0);
    let value;
    let masked = null;
    if (row) {
      let raw = row.value_json;
      if (row.encrypted) {
        try {
          const dec = decrypt(raw);
          const parsed = JSON.parse(dec);
          masked = typeof parsed === 'string' && parsed.length > 4
            ? '***' + parsed.slice(-4)
            : '***';
          value = '__masked__';
        } catch { value = '__masked__'; masked = '***'; }
      } else {
        try { value = JSON.parse(raw); } catch { value = raw; }
      }
    } else {
      value = DEFAULTS[key];
    }
    out.push({
      key,
      value,
      masked,
      encrypted,
      isDefault: !row,
      updated_at: row?.updated_at || null,
      updated_by: row?.updated_by || null,
    });
  }
  return out;
}

function clearCache() {
  _cache.clear();
}

function on(event, fn) {
  events.on(event, fn);
}

function off(event, fn) {
  events.off(event, fn);
}

// ENV → DB Bootstrap. Beim Server-Start einmalig: fuer jeden ENV-Key, der
// noch nicht in der DB liegt, Wert aus process.env in app_settings spiegeln.
// Damit Admins beim ersten 4c-Lauf nicht alles in der UI nachpflegen muessen.
// Keine Ueberschreibung bestehender DB-Werte — ENV ist nur „Erstbefuellung".
// Spaeter koennen die ENV-Reads in den Konsumenten ersatzlos entfernt werden.
const ENV_MAP = [
  // [envVar, key, transform]
  ['API_PROVIDER',        'ai.provider',                v => String(v).toLowerCase()],
  ['ANTHROPIC_API_KEY',   'ai.claude.api_key',          v => String(v)],
  ['MODEL_NAME',          'ai.claude.model',            v => String(v)],
  ['MODEL_TOKEN',         'ai.claude.max_tokens_out',   v => parseInt(v, 10)],
  ['MODEL_CONTEXT',       'ai.claude.context_window',   v => parseInt(v, 10)],
  ['CHARS_PER_TOKEN',     'ai.chars_per_token',         v => parseFloat(v)],
  ['OLLAMA_HOST',         'ai.ollama.host',             v => String(v)],
  ['OLLAMA_MODEL',        'ai.ollama.model',            v => String(v)],
  ['OLLAMA_TEMPERATURE',  'ai.ollama.temperature',      v => parseFloat(v)],
  ['OPENAI_COMPAT_HOST',        'ai.openai-compat.host',        v => String(v)],
  ['OPENAI_COMPAT_MODEL',       'ai.openai-compat.model',       v => String(v)],
  ['OPENAI_COMPAT_TEMPERATURE', 'ai.openai-compat.temperature', v => parseFloat(v)],
  ['OPENAI_COMPAT_API_KEY',     'ai.openai-compat.api_key',     v => String(v)],
  ['CHAT_TEMPERATURE',    'ai.chat_temperature',        v => parseFloat(v)],
  ['CLAUDE_RETRY_MAX',    'ai.claude.retry_max',        v => parseInt(v, 10)],
  ['CLAUDE_TIMEOUT_MS',   'ai.claude.timeout_ms',       v => parseInt(v, 10)],
  ['CLAUDE_PHASE1_CONCURRENCY', 'ai.claude.phase1_concurrency', v => parseInt(v, 10)],
  ['LEKTORAT_BATCH_CONCURRENCY', 'ai.lektorat_batch_concurrency', v => parseInt(v, 10)],
  ['MAX_CONCURRENT_JOBS', 'jobs.max_concurrent',        v => parseInt(v, 10)],
  ['BOOK_CHAT_MODE',      'jobs.book_chat.mode',        v => String(v)],
  ['BOOK_CHAT_MAX_TOOL_ITER', 'jobs.book_chat.max_tool_iter', v => parseInt(v, 10)],
  ['BOOK_CHAT_TOKEN_BUDGET',  'jobs.book_chat.token_budget',  v => parseInt(v, 10)],
  ['CRON_TIMEZONE',       'app.timezone',               v => String(v)],
  ['TZ',                  'app.timezone',               v => String(v)],
  ['STALE_DAYS',          'cron.stale_days',            v => parseInt(v, 10)],
  ['VERAPDF_FLAVOUR',     'pdfa.flavour',               v => String(v)],
  ['VERAPDF_DISABLED',    'pdfa.disabled',              v => v === 'true' || v === '1'],
  ['GOOGLE_CLIENT_ID',    'auth.google.client_id',      v => String(v)],
  ['GOOGLE_CLIENT_SECRET','auth.google.client_secret',  v => String(v)],
  ['ALLOW_OPEN_SIGNUP',   'auth.allow_open_signup',     v => v === 'true' || v === '1'],
  ['APP_URL',             'app.public_url',             v => String(v).replace(/\/$/, '')],
  ['GITHUB_TOKEN',        'macclient.github_token',     v => String(v)],
  ['GEOCODE_PROVIDER',    'geocode.provider',           v => String(v).toLowerCase()],
  ['NOMINATIM_URL',       'geocode.nominatim.url',      v => String(v)],
  ['PHOTON_URL',          'geocode.photon.url',         v => String(v)],
  ['OSM_TILES_URL',       'geocode.tiles.url',          v => String(v)],
  ['OSM_TILES_ATTRIBUTION','geocode.tiles.attribution', v => String(v)],
];

function bootstrapFromEnv() {
  let mirrored = 0;
  for (const [envVar, key, transform] of ENV_MAP) {
    if (has(key)) continue;
    const raw = process.env[envVar];
    if (raw === undefined || raw === '') continue;
    let value;
    try { value = transform(raw); }
    catch (e) {
      logger.warn(`app-settings: bootstrap ${envVar}→${key} transform failed: ${e.message}`);
      continue;
    }
    if (typeof value === 'number' && Number.isNaN(value)) continue;
    try {
      set(key, value, { updatedBy: 'env-bootstrap' });
      mirrored++;
    } catch (e) {
      logger.warn(`app-settings: bootstrap ${envVar}→${key} write failed: ${e.message}`);
    }
  }
  if (mirrored > 0) logger.info(`app-settings: ${mirrored} ENV-Wert(e) initial in DB gespiegelt.`);
  return mirrored;
}

module.exports = {
  get, has, set, remove,
  listForAdmin, clearCache,
  on, off,
  isEncryptedKey, isKnownKey, ENCRYPTED_KEYS, DEFAULTS,
  bootstrapFromEnv, ENV_MAP,
  VALIDATORS, InvalidSettingValueError,
};
