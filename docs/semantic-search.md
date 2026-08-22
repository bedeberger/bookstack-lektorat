# Semantische Suche (Embeddings)

Bedeutungs-basierte Suche über ein Buch: Seiten, Szenen, Figuren und Recherche-Schnipsel (inkl. des extrahierten Volltexts hochgeladener PDFs) werden in Chunks zerlegt, über einen **self-hosted, OpenAI-kompatiblen `/v1/embeddings`-Endpunkt** (z.B. LocalAI, llama.cpp) in Float32-Vektoren übersetzt und per Cosinus-Ähnlichkeit durchsucht. **Rein rückwärtsgewandt** — liest bestehende Inhalte, schreibt nie in den Buchtext (analog Recherche-/Buch-Chat).

Der Index ist ein **reiner Ableitungs-Index** (wie FTS5): jederzeit aus den Quelltabellen neu berechenbar. Host/Model/Key liegen in `app_settings` (`embed.*`) und verlassen den Server nie.

## Trefferqualität — die drei Stufen des Freitext-Pfads

Der **Freitext**-Query (`?q=…`, Such-Karte + Buch-Chat-Tool `search_similar`) läuft über die zentrale Pipeline [lib/semantic-retrieval.js](../lib/semantic-retrieval.js)#`semanticQuery`; jede Stufe ist optional und gated:

1. **Retrieval + Score-Floor** — Embedding-Cosinus (`searchSimilar`). `embed.min_score` (Default 0.25) ist die Cosinus-Untergrenze: die Ähnlichkeitssuche liefert nie „keine Treffer" (jede Anfrage hat einen nächsten Nachbarn), der Floor schneidet den schwachen Long-Tail ab, damit unter den guten Treffern kein Rauschen steht. **Gilt nur für Freitext**, nicht für „ähnliche Stellen zu Entität" (dort zählt Recall — der gemittelte Entitäts-Vektor rankt niedriger).
2. **Hybrid-Fusion (`embed.hybrid`, Default an)** — die lexikalische FTS5/bm25-Rangliste ([lib/search.js](../lib/search.js)) wird per **Reciprocal Rank Fusion** ([lib/semantic-fusion.js](../lib/semantic-fusion.js), pure, `RRF_K=60`) in die semantische gemischt. RRF fusioniert über die Rang-Position (nicht über inkompatible Score-Skalen) → exakte Begriffe/Eigennamen (die reine Embeddings verlieren) kommen zurück, Paraphrasen (die FTS verliert) bleiben.
3. **Reranking (`rerank.*`, Default aus)** — ein Cross-Encoder ([lib/rerank.js](../lib/rerank.js), self-hosted OpenAI/Jina-`/v1/rerank`, z.B. LocalAI/TEI) ordnet die Top-`rerank.top_n` Fusions-Kandidaten neu, indem er (Anfrage, Textstelle) direkt bewertet — schärfere Relevanz als Vektor-Distanz allein. `rerank.min_score` filtert danach. **Non-fatal:** fällt der Endpunkt aus, greift still die RRF-/Cosinus-Reihenfolge. Setzt aktivierte semantische Suche voraus (`isEnabled()` prüft zusätzlich `embed.isEnabled()`).

**Drei weitere Pfade nutzen denselben Reranker** (alle in [lib/semantic-retrieval.js](../lib/semantic-retrieval.js), damit `lib/rerank.js` seinen einzigen Konsumenten behält):
- **„Passagen in einem Dokument"** (`passagesInEntity`): mehrere Chunks **innerhalb EINER** Entität, sortiert nach Nähe zur Frage — der Gegensatz zu `searchSimilar`, das pro Entität nur den besten Chunk liefert. Existiert für lange Recherche-PDFs: dort ist die Frage nicht „welcher Eintrag passt", sondern „welche Stelle **in diesem** Eintrag". Score-Floor wie im Freitext-Pfad, Rerank via `rerankOrder`, kein Hybrid (FTS kennt keine Chunk-Granularität). Einziger Konsument: das Recherche-Chat-Tool `search_research_passages`.
- **„Ähnliche Stellen zu Entität"** (`similarToEntity`): das reine Vektor-Retrieval dieses Pfads ist am unschärfsten (gemittelter Entitäts-Vektor). Bei aktivem Reranker wird der Kandidatenpool anschliessend gegen den **Entitäts-Text** (`getEntityText`, Chunk-Texte verkettet, max. 2000 Zeichen) geschärft. Kein Hybrid (kein Anfragetext für FTS).
- **Buch-Chat `search_passages`** (Wort-genaue FTS-Literalsuche): `rerankOrder` sortiert den bm25-Kandidatenpool per Cross-Encoder gegen das Suchmuster **nur um** (nichts wird verworfen), damit bei natürlichsprachlichen Mustern die relevantesten Seiten zuerst gescannt werden (`max_results`-/Deadline-Cut). Die Literal-/Regex-Treffer selbst bleiben unangetastet.

**Instruction-Präfixe** (`embed.query_prefix`/`embed.passage_prefix`, Default leer): für asymmetrische Modelle (e5: `query: `/`passage: `). Query-seitig via [lib/embed.js](../lib/embed.js)#`embedQuery` (alle Query-Aufrufer nutzen es), Passage-seitig im Index-Job — der `passage_prefix` fliesst in den Chunk-`content_hash` → Präfixwechsel invalidiert den Delta-Cache und erzwingt Reindex. **bge-m3 braucht die Präfixe NICHT** (leer lassen).

`/config` exponiert die Ableitungs-Flags `semanticSearch.hybrid`/`.rerank` für einen dezenten Hinweis in der Such-Karte (`semanticEnhancedLabel`); Host/Model/Key bleiben serverseitig. Admin-Test: `POST /admin/settings/test-embed` + `POST /admin/settings/test-rerank`.

## Einstiegspunkte

Alle sind nur sichtbar/aktiv, wenn das Backend konfiguriert ist (`config.semanticSearchEnabled`, siehe [Freischalten](#freischalten)).

| Einstieg | Ort | Auslöser |
|----------|-----|----------|
| **Modus „Sinngemäss"** | Such-Karte (`searchCard`), Modus-Zeile `.search-mode-row` | User schaltet in [search.html](../public/partials/search.html) von „Volltext" (`fts`) auf „Sinngemäss" (`semantic`) → `setMode('semantic')` |
| **„Ähnliche Stellen"** | Button an Figuren- und Szenen-Karten | [figuren.html:133](../public/partials/figuren.html) / [szenen.html:181](../public/partials/szenen.html) → `$app.findSimilar(kind, id, label)` → öffnet Such-Karte, feuert Event `search:similar` |
| **Buch-Chat-Tool** | Agentischer Buch-Chat | Tool `search_similar` ([book-chat-tools.js:68](../public/js/prompts/book-chat-tools.js)) — Gegenstück zu `search_passages` (Wort-genau vs. sinngemäss) |
| **Recherche-Chat-Tool** | Agentischer Recherche-Chat | Tool `search_research_passages` ([recherche.js](../public/js/prompts/recherche.js)) — semantisch übers Archiv, mit `item_id` gezielt **in** ein langes PDF. Nur angeboten, wenn `embed.isEnabled()` (Filter in [research-chat.js](../routes/jobs/research-chat.js)) |
| **Belegvorschlag** | Lektorat-Findings-Panel, an jedem `unbelegt`-Befund ([editor-findings.html](../public/partials/editor-findings.html)) | `toggleEvidence(i)` → `GET /sources/evidence` → semantisch gegen die **Quellen-Bibliothek** (`semanticSourceQuery`, user-skopiert) |
| **Buchlandkarte** | Eigene Karte (`buchlandkarteCard`) | `runBookMap()` → Job `POST /jobs/book-map` — liest die Wolke als **Geometrie** statt als Trefferliste ([lib/book-map.js](../lib/book-map.js)) |

Es gibt **keine eigene Karte** und **keinen Paletten-Prefix** — die semantische Suche lebt komplett in der bestehenden Such-Karte (`key: 'search'` in [feature-registry.js](../public/js/cards/feature-registry.js)).

**Interner Konsument (kein UI-Einstieg): der klassische Buch-Chat.** `runBookChatJob` (Nicht-Claude / `jobs.book_chat.mode='classic'`, [docs/chats.md](chats.md#buch-chat)) nutzt `semanticQuery` als **Mini-RAG-Retriever**: statt alle Seiten zu laden + Keyword-Scoring zieht `selectPassagesSemantic` ([book-chat-retrieval.js](../routes/jobs/chat/book-chat-retrieval.js)) bei aktivem Index die relevantesten Chunk-Auszüge (ein bester Chunk pro Seite, `kinds:['page']`, `jobs.book_chat.rag_top_k`) in den System-Prompt. Non-fatal: kein Index / Backend down / keine Treffer → Keyword-Fallback. So bekommt der agentenlose Chat dieselbe scharfe Retrieval-Qualität wie das Tool `search_similar`.

**Interner Konsument (kein UI-Einstieg): der Erst-Kontext des agentischen Buch-Chats.** Derselbe Pfad, andere Dosierung: `preContextPassages` (ebenfalls [book-chat-retrieval.js](../routes/jobs/chat/book-chat-retrieval.js)) legt vor der ersten Tool-Iteration `jobs.book_chat.pre_rag_top_k` Passagen (Deckel `jobs.book_chat.pre_rag_chars`) als eigenen System-Block in den Prompt — **nicht** budget-füllend wie der klassische Pfad, sondern absichtlich klein. Zweck ist Kostenkontrolle: schmale Faktenfragen sind damit ohne Werkzeug-Runde beantwortbar, statt über `search_passages` zu `get_chapter_text` zu eskalieren. Details + Cache-Invariante: [docs/buchchat-tools.md](buchchat-tools.md#erst-kontext--kosten-leiter).

**Interner Konsument (kein UI-Einstieg):** die **Kontinuitäts-Verify-Stufe** (Multi-Pass, [docs/komplett.md](komplett.md#phase-8--kontinuitätsprüfung)) nutzt den Index als **best-effort Beleg-Fallback** — findet die wörtliche Textstellen-Suche das Zitat eines Befunds nicht, lädt sie die semantisch nächste Seiten-Passage nach (`searchSimilar`, `kinds:['page']`). Gilt nur, wenn der Index für das Buch existiert; sonst keyword-Pfad. Rein rückwärtsgewandt.

## Freischalten

Admin → Einstellungen → Tab **„Semantik"** ([admin-settings-embed.html](../public/partials/admin-settings-embed.html)). Settings-Keys (Defaults in [lib/app-settings.js](../lib/app-settings.js)):

| Key | Default | Bedeutung |
|-----|---------|-----------|
| `embed.enabled` | `false` | Kill-Switch |
| `embed.host` | `''` | Basis-URL des Embedding-Endpunkts (ohne `/v1`) |
| `embed.model` | `bge-m3` | Embedding-Modell (steht im Chunk-Key → Modellwechsel = Reindex) |
| `embed.dim` | `1024` | Vektor-Dimension (muss zum Modell passen) |
| `embed.timeout_ms` | `60000` | HTTP-Timeout pro Batch |
| `embed.api_key` | `''` | optionaler Bearer-Token |

**Gate:** `embed.isEnabled()` = `embed.enabled === true` **und** `embed.host` gesetzt ([lib/embed.js:14](../lib/embed.js)). Das `/config` exponiert daraus `semanticSearch.enabled` ([routes/proxies.js:137](../routes/proxies.js)), das Frontend spiegelt es nach `Alpine.store('config').semanticSearchEnabled` ([app-init.js:206](../public/js/app/app-init.js)). Zusätzlich verlangen die UI-Einstiege ein **gewähltes Buch** (`semanticAvailable`-Getter in [search-card.js:81](../public/js/cards/search-card.js)) — Vektoren leben pro Buch.

## Pipeline

```
Admin „Semantik" (embed.*) ──► lib/embed.js  ──POST /v1/embeddings──► self-hosted Endpunkt
                                    │
Such-Karte „Index aufbauen" ──POST /jobs/embed-index──► runEmbedIndexJob ──► semantic_chunks (BLOB)
                                                                                   │
Such-Karte „Sinngemäss" / „Ähnliche Stellen" ──GET /search/semantic──► searchSimilar (Cosinus, Brute-Force)
```

### Index-Job — `POST /jobs/embed-index`

[routes/jobs/embed-index.js](../routes/jobs/embed-index.js), `runEmbedIndexJob`. Rolle **`lektor`**, dedupt via `findActiveJobId`.

1. `_collectEntities` lädt indexierbaren Rohtext je Kind: Seiten (`loadPageContents`), Szenen (`titel`+`kommentar`), Figuren (`name`+`beschreibung`). Leerer Text → übersprungen.
2. `chunkText` ([lib/embed-chunk.js](../lib/embed-chunk.js)): ~1500 Zeichen/Chunk, 200 Overlap, bricht bevorzugt an Satz-/Absatzgrenzen.
3. **Delta-Cache:** pro Chunk `content_hash` (SHA-256, 16 hex). Unveränderter Chunk mit passender `dim` → alter Vektor wird wiederverwendet, kein Embedding-Call. Nur `pending`-Chunks werden in Batches (64) neu embeddet.
4. **Inkrementelle Persistenz:** eine Entität wird via `replaceEntity` atomar geschrieben, sobald ihr letzter pending-Chunk embeddet ist (nicht erst am Ende). Bricht das Backend mitten im Lauf ab, überleben die bereits fertigen Entitäten — der Delta-Cache übernimmt sie beim nächsten Lauf, nur der Rest wird neu embeddet. `pruneMissing` räumt am Ende verwaiste Chunks gelöschter Entitäten.

Erstlauf kann dauern (embeddet alles); Folgeläufe embetten nur Geändertes. Fehlt das Backend → `EMBED_DISABLED` (400) bzw. `job.error.embedDisabled`.

**Batch-Retry gegen transiente Aussetzer:** [lib/embed.js](../lib/embed.js)#`_withRetry` wiederholt jeden HTTP-Batch bis zu 3× mit linearem Backoff (800 ms × Versuch), wenn der Fehler transient ist — Netz-Blip (`fetch failed`), Timeout, HTTP 429/5xx, unvollständige Antwort (`err.retriable`). Nicht-transiente Fehler (HTTP 4xx ausser 429) und echter Job-Cancel (`signal`) werfen sofort. So reisst bei grossen Büchern (viele Batches) nicht mehr ein einzelner Backend-Zucker den ganzen Index-Lauf ab.

### Query — `GET /search/semantic`

[routes/search.js:118](../routes/search.js). Rolle **`viewer`**, immer buch-skopiert. Zwei Modi:

- **Freitext** (`q`, 2–500 Zeichen): `embed.embedOne(q)` → Query-Vektor.
- **„Ähnliche Stellen zu Entität"** (`like_kind`+`like_id`): läuft über `similarToEntity`. `getEntityVector` mittelt die vorhandenen Chunk-Vektoren der Entität — **kein** Embedding-Call. Die Quell-Entität wird aus den Treffern ausgeschlossen. Bei aktivem Reranker wird der Pool danach gegen den Entitäts-Text nachgeordnet (siehe [Trefferqualität](#trefferqualität--die-drei-stufen-des-freitext-pfads)).

`searchSimilar` ([db/semantic-chunks.js:70](../db/semantic-chunks.js)) scannt alle Chunks des Buches unter dem **aktiven Modell** linear (Buchgröße → Millisekunden, kein sqlite-vec nötig), nimmt pro Entität den besten Chunk, sortiert nach Score, top-K. Backend nicht erreichbar → `EMBED_UNAVAILABLE` (503) → Frontend zeigt `search.semantic.unavailable`.

## Datenmodell — `semantic_chunks`

Migrationen **240** + **251** + **259** ([db/migrations.js](../db/migrations.js)). Polymorph nach `kind` (`page`/`scene`/`figure`/`research`), modelliert wie `motif_occurrences` — **typisierte FK-Spalten statt einer untypisierten Ref**, sodass die DB die Referenz selbst durchsetzt:

- `kind` (`CHECK` auf die vier Werte) plus je eine nullable FK-Spalte: `page_id` → `pages(page_id)`, `scene_id` → `figure_scenes(id)`, `figure_id` → `figures(id)`, `research_item_id` → `research_items(id)`, alle **ON DELETE CASCADE**. Ein `CHECK` erzwingt, dass genau die zu `kind` passende Spalte gesetzt ist (sentinel-frei).
- `entity_id` ist eine **`GENERATED … VIRTUAL`-Spalte** (`COALESCE(page_id, scene_id, figure_id, research_item_id)`). Alle Lesepfade fragen polymorph darüber ab (`WHERE kind = ? AND entity_id = ?`, `COUNT(DISTINCT entity_id)`, `JOIN figures ON f.id = sc.entity_id`); geschrieben wird ausschliesslich über die typisierten Spalten (`_entityCols()` in [db/semantic-chunks.js](../db/semantic-chunks.js) ist der einzige Übersetzer). Abgeleitet statt dupliziert → kann nicht abdriften.
- `book_id` → `books(book_id)` **ON DELETE CASCADE**, `chunk_ix`, `content_hash`, `model`, `dim`, `vector BLOB` (Float32 LE), `text`.
- `UNIQUE(kind, entity_id, chunk_ix, model)` als benannter Index `idx_semchunk_uniq` (Table-Constraints können keine generierte Spalte referenzieren) — Mehr-Modell-Koexistenz, Query filtert aufs aktive Modell.
- Weitere Indexe: `idx_semchunk_book(book_id, kind)` + je einer auf `page_id`/`scene_id`/`figure_id`/`research_item_id` (FK-Deckung für den CASCADE-Scan).

**`kind='research'` — warum im Buch-Index und nicht in einer eigenen Tabelle.** `research_items` ist buchgebunden wie Seite/Szene/Figur; eine zweite Tabelle wäre eine Kopie mit anderem FK. Der User-Pool `sources` bekam dagegen `source_semantic_chunks`, weil Quellen **personen**-gebunden sind (kein `book_id`) — das ist der Unterschied, an dem die Entscheidung hängt, nicht „PDF ja/nein". Indexgut ist `title + body + doc_text` am Stück; bei einem Dokument-Eintrag ist der PDF-Volltext der weitaus grösste Anteil. **Archivierte Einträge werden mitindexiert** — der FTS5-Index tut es auch, und die Hybrid-Fusion mischt beide Ranglisten: ein einseitiger Filter liesse FTS-Kandidaten ohne semantisches Gegenstück auftauchen.

**Frische nach einem PDF-Upload:** `POST /research/:id/doc` ruft `enqueueEmbedIndexJob(bookId)` ([routes/jobs/embed-index.js](../routes/jobs/embed-index.js)) — non-fatal, dedupt gegen einen laufenden Job des Buchs. Ohne das bliebe ein frisch hochgeladenes PDF bis zum Nacht-Cron nur per Wortmatch auffindbar. Der Delta-Cache macht den Lauf billig: nur die Chunks des neuen Dokuments werden embeddet.

**Cleanup:** Der Entity-Delete cascadet in der DB. Die expliziten Hooks in [db/pages.js:154](../db/pages.js) (`remove('page', …)`) und [routes/figures.js](../routes/figures.js) (`remove('scene'/'figure', …)`) bleiben als sofortige Freigabe im selben Transaktionsschritt. `pruneMissing()` deckt den Fall ab, den kein FK sieht: die Entität existiert noch, ist aber nicht mehr indizierbar (stale-Figur, Seite in ein anderes Buch verschoben).

## Zwei Fragen jenseits der Trefferliste

Die Einstiegspunkte oben stellen alle dieselbe Frage — „gib mir die k nächsten Nachbarn zu diesem Text". Zwei Konsumenten benutzen denselben Index anders, und ihre Eigenheiten folgen daraus:

**Belegvorschlag** ([routes/sources-evidence.js](../routes/sources-evidence.js) + [public/js/editor/lektorat-evidence.js](../public/js/editor/lektorat-evidence.js)) dreht die Richtung: die Anfrage kommt nicht vom Suchenden, sondern **aus dem Buchtext selbst**. Ein `unbelegt`-Befund des wissenschaftlichen Lektorat-Profils liefert den wörtlichen Satz (Span-Typ `satz`), und der ist eine fertige semantische Anfrage gegen `source_semantic_chunks`. Vier Entscheidungen daran:

- **Nur `unbelegt`, nicht `zuschreibung`.** Im journalistischen Profil ist der Beleg die im Satz *genannte* Person oder Stelle, nicht der Kurzbeleg (Begründung an `JOURNALISTISCH_TYPEN` in [prompts/lektorat-typen.js](../public/js/prompts/lektorat-typen.js)) — ein Quellen-Chip wäre dort die falsche Reparatur.
- **`linked` gehört in die Antwort.** Ein `data-src`-Marker erzeugt nur dann eine Fundstelle, wenn die Quelle dem Buch zugeordnet ist (`replacePageCitations`). Ein Vorschlag aus einer anderen Arbeit muss darum erst durch `POST /sources/:id/link` — und zwar **vor** dem Einfügen, sonst stünde der Beleg im Text und in keinem Verzeichnis.
- **Server-Apply, nicht DOM.** Bei sichtbaren Befunden ist der Editor per Invariante nie im Bearbeiten-Modus (`editMode + checkDone forbidden`) — es gibt kein contenteditable. Der Weg ist derselbe wie beim Korrektur-Apply: frisch laden → `insertAfterInHtml` → `savePage(expectedUpdatedAt)`, Revisions-Quelle `lektorat-apply`. `insertAfterInHtml` **spleisst, ersetzt nicht**: `replaceInHtml` würde ein balanciertes `<em>` oder eine bestehende Quellenangabe im Satz verlieren.
- **Keine Stellenangabe.** Der Fund kommt aus einem Embedding-Chunk, und `source_semantic_chunks` hat keine Seitenzahl. Sie zu raten wäre eine erfundene Belegstelle; der Autor trägt sie über den Chip-Klick nach. Mehrdeutigkeit (`countInHtml > 1`) ist ein **Abbruch**, keine Wahl.

**Buchlandkarte** ([lib/book-map.js](../lib/book-map.js), Job [routes/jobs/book-map.js](../routes/jobs/book-map.js), Karte `buchlandkarteCard`) fragt nicht nach Nachbarn, sondern nach der **Form der Wolke**: wo liegen die Kapitel zueinander, hält ein Kapitel zusammen, welche Seite passt nicht ins Buch. Ein Punkt je Seite (Mittel über ihre Chunks, normiert), Projektion per **PCA** — linear, parameterfrei, deterministisch und in ~40 Zeilen selbst gerechnet (Power-Iteration mit Deflation). t-SNE/UMAP sähen hübscher aus, bräuchten eine Vendor-Lib, wären zufallsinitialisiert (dieselbe Analyse zeigte beim zweiten Öffnen ein anderes Bild) und erhalten *lokale* Nachbarschaft auf Kosten der globalen Struktur — genau die ist hier die Frage.

- **Die Achsen haben keine Bedeutung** und bekommen darum keine Beschriftung; nur die relative Lage zählt. Beide werden mit **demselben** Faktor skaliert, sonst sähe eine gestreckte Wolke rund aus (gegated in [tests/unit/book-map.test.mjs](../tests/unit/book-map.test.mjs)).
- **`explainedVariance` wird ausgewiesen, nicht verschwiegen.** Zeigt die Projektion wenig von der Streuung, sagt die Karte das und behauptet keine Nähe (gleiche Ehrlichkeitsregel wie der Einmalwort-Deckel des Wortschatzes).
- **Alle Kennzahlen im Vollraum**, nie auf den 2D-Koordinaten: Kohäsion, Nachbar-Kapitel und Ausreisser-Abstand rechnen über den Original-Vektoren. Sonst erbten sie den Fehler der Projektion.
- **Kohäsion ist kein Gütemass.** Ein niedriger Wert heisst „thematisch breit" — im Übersichtskapitel richtig, im Szenen-Kapitel ein Hinweis. Ein Kapitel mit einer Seite bekommt `cohesion: null` statt 1.0: das wäre die Behauptung perfekter Geschlossenheit, wo nichts zu vergleichen war.
- **Kein persistierter Index.** Das Ergebnis lebt nur im Job-Result — es ist vollständig aus `semantic_chunks` neu berechenbar, und ein Ableitungs-Index eines Ableitungs-Index wäre nur eine weitere Stelle, die veralten kann.

## Nacht-Cron

`reindexAllBooks()` ([routes/jobs/embed-index.js](../routes/jobs/embed-index.js), eingehängt in [server.js](../server.js)) reiht pro Buch (`contentStore.listBooks`) einen `embed-index`-Job ein (Dedup gegen laufende Jobs). Der Delta-Cache hält den Reindex billig: bereits indizierte Bücher embedden nur seit gestern geänderte Chunks neu, nie-indizierte Bücher bekommen ihren Erst-Index.

## Pflicht-Invarianten

- **Nie generativ** — die semantische Suche findet nur Bestehendes, schreibt nie in den Buchtext.
- **Reiner Ableitungs-Index** — keine Wahrheit in `semantic_chunks`; jederzeit via `embed-index` neu berechenbar.
- **Query filtert aufs aktive Modell** (`embed.model`). Modellwechsel im Admin → alte Modell-Chunks bleiben liegen (koexistieren), bis der nächste Full-Reindex sie über `pruneMissing`/`clearBook` ersetzt. Nach Modellwechsel Reindex anstoßen.
- **Host/Model/Key nie im `/config`** — nur der abgeleitete Bool `semanticSearch.enabled` geht ans Frontend.
- **Kennzahlen über der Wolke rechnen im Vollraum** — die 2D-Projektion der Buchlandkarte ist eine Anzeige, keine Datenquelle. Wer eine neue Kennzahl ergänzt, nimmt die Original-Vektoren.
- **`embed.dim` muss zum Modell passen** — Vektoren ungleicher Länge ranken via `cosineSim → -Infinity` nie als Treffer.

## Tests

[tests/unit/embed-chunk.test.mjs](../tests/unit/embed-chunk.test.mjs) — Chunking, (De)Serialisierung, Cosinus, Content-Hash (pure Helfer, kein Netz/DB). [tests/unit/embed-retry.test.mjs](../tests/unit/embed-retry.test.mjs) — Batch-Retry (`_withRetry`): transient→Erfolg nach Retries, nicht-transient→sofort, erschöpft→wirft, Job-Cancel→kein Retry. [tests/unit/book-map.test.mjs](../tests/unit/book-map.test.mjs) — Buchlandkarte: Punkt-Verdichtung, PCA-Eigenschaften (Determinismus, geteilter Achsen-Faktor, Cluster-Trennung), Kapitel-Kennzahlen, Ausreisser (pure Mathematik, kein Netz/DB). [tests/unit/cite-insert-after.test.mjs](../tests/unit/cite-insert-after.test.mjs) — Belegvorschlag: `insertAfterInHtml` verliert nichts (Inline-Auszeichnung, bestehende Quellenangabe), bleibt im Absatz, umgeht abschliessende Auszeichnung; plus der Mehrdeutigkeits-Guard davor.
