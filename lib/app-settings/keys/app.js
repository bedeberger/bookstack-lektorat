'use strict';
// Settings-Keys der uebrigen Bereiche: Cron/Sync, App-weite Werte, PDF-Norm,
// Analytics, LanguageTool, Diktat, Vorlesen, Bild-Generierung, Semantik,
// Reranker und Geocoding.
// Teil der Registry — Deskriptor-Format und Regeln stehen in
// [../registry.js](../registry.js).

module.exports = {
  // Cron / Sync
  // app.timezone gilt fuer Cron, Server-Datums-Buckets (lib/local-date.js)
  // und Frontend-Display-Formatter (toLocaleString, Intl.DateTimeFormat).
  // Single Source of Truth — Browser-TZ wird ueberschrieben.
  'app.timezone': { default: 'Europe/Zurich', env: [['CRON_TIMEZONE', v => String(v)], ['TZ', v => String(v)]] },
  'cron.stale_days': {
    default: 7,
    validate: { type: 'int', min: 1, max: 365 },
    env: [['STALE_DAYS', v => parseInt(v, 10)]],
  },

  // PDF/A
  'pdfa.flavour': {
    default: '2b',
    validate: { type: 'enum', oneOf: ['2b', '3b'] },
    env: [['VERAPDF_FLAVOUR', v => String(v)]],
  },
  'pdfa.disabled': { default: false, env: [['VERAPDF_DISABLED', v => v === 'true' || v === '1']] },

  // App-Name fuer Startup-Log, Mail-Templates etc.
  'app.name': { default: 'Schreibwerkstatt' },

  // Floor fuer page_revisions-Tiered-Retention: jueng­ste N Revisions pro Seite
  // werden zusaetzlich zum GFS-Bucket-Schema (Tag/Woche/Monat/Jahr) garantiert
  // behalten. Cleanup-Hook in lib/cache-cleanup.js → db/page-revisions.js#pruneTiered.
  // Range 1..500 (Validator + UI); Default 50.
  'app.page_revision_limit': { default: 50, validate: { type: 'int', min: 1, max: 500 } },

  // Page-Lock-TTL (Lektorat-Mutex + Edit-Advisory) in Minuten. So lange bleibt
  // ein Lock ohne Heartbeat gueltig, bevor er ablaeuft und die Seite wieder
  // editierbar wird. Quelle: db/book-access.js#_acquireOrExtendLock.
  'editor.lock_ttl_min': { default: 30, validate: { type: 'int', min: 1, max: 1440 } },

  // Share-Link Beta-Leser-Kommentar-Rate-Limit (In-Memory, pro Token + IP-Hash).
  // max Kommentare pro window_min Minuten; danach 429 mit Retry-After. Beta-Leser
  // hinterlassen viele verankerte Inline-Anmerkungen pro Sitzung — grosszuegig
  // genug halten, aber kein Bot-Schleudertor.
  'share.comment.rate_limit_max': { default: 30, validate: { type: 'int', min: 1, max: 1000 } },
  'share.comment.rate_limit_window_min': { default: 60, validate: { type: 'int', min: 1, max: 1440 } },

  // GitHub-Token (PAT) fuer den Client-Release-Abruf (lib/github-release.js): Android-App
  // und Chrome-Erweiterung. Die macOS-App kommt aus dem Mac App Store und laeuft ueber
  // lib/appstore-lookup.js, also ohne Token — der Key-Name bleibt aus Kompatibilitaet.
  // Optional: leer = unauthentifizierter Public-API-Zugriff (60 Req/h pro IP). Gesetzt =
  // Bearer-Token, hebt das Rate-Limit (5000 Req/h). Default leer, damit das Admin-Settings-UI
  // den (encrypted) Key auch ohne bestehende DB-Row rendert (analog smtp.gmail.app_password).
  'macclient.github_token': { default: '', secret: true, env: [['GITHUB_TOKEN', v => String(v)]] },

  // Öffentliche Basis-URL der App (ohne Slash am Ende). Wird für OIDC-Callback,
  // Invite-Mails und Share-Links genutzt. Admin-Pflicht: leer = OIDC-Login und
  // Invite-Versand nicht möglich; LOCAL_DEV_MODE fällt auf http://localhost:PORT.
  'app.public_url': { default: '', env: [['APP_URL', v => String(v).replace(/\/$/, '')]] },

  // Darf diese Instanz indexiert werden? Wirkt NUR auf Landing + Datenschutz
  // und robots.txt (Auswertung in routes/public.js); false ist fuer Neben-
  // instanzen (Demo/Staging) gedacht, die der Hauptdomain sonst als doppelter
  // Inhalt in den Index laufen. NICHT der Schutz der Share-Links — die tragen
  // unabhaengig davon immer X-Robots-Tag: noindex (routes/share.js).
  'seo.indexable': { default: true, env: [['SEO_INDEXABLE', v => v === 'true' || v === '1']] },

  // Plausible-Analytics (self-hosted). enabled=false → kein Tracking, kein
  // CSP-Eintrag. script_url ist die volle URL zum Bootstrap-JS, z.B.
  // https://analytics.example.com/js/pa-XXXX.js — Origin wird daraus
  // abgeleitet und in CSP scriptSrc/connectSrc aufgenommen.
  'analytics.plausible.enabled': { default: false },
  'analytics.plausible.script_url': { default: '' },

  // LanguageTool (self-hosted, regelbasierte Rechtschreib-/Grammatikpruefung).
  // enabled=true + url gesetzt aktiviert Overlay-Spellcheck in allen Editoren
  // und deaktiviert Browser-Spellcheck. Picky-Mode aktiviert zusaetzliche
  // Stil-Regeln.
  'languagetool.enabled': { default: false },
  'languagetool.url': { default: '' },
  'languagetool.picky': { default: false },
  // Debounce-Zeit fuer den Spellcheck-Controller in den drei Editoren
  // (contenteditable). Nach jeder Eingabe wartet der Controller diese Spanne,
  // bevor er /languagetool/check ruft. Form-Felder (input/textarea) nutzen
  // eigene Defaults und sind hiervon unberuehrt.
  'languagetool.debounce_ms': { default: 1500, validate: { type: 'int', min: 200, max: 10000 } },

  // Speech-to-Text (self-hosted, OpenAI-kompatibler Whisper-Endpunkt).
  // enabled=true + host gesetzt blendet den Mic-Diktat-Button im Notebook-Editor
  // ein. Sprache loest der /stt/transcribe-Proxy pro Request aus der Buch-Locale
  // auf (SSoT wie LanguageTool); stt.language ist nur Fallback ohne Buchscope.
  // VAD-Schwellen steuern die browserseitige Sprechpausen-Segmentierung und
  // gehen ueber /config ins Frontend (VAD laeuft im Browser).
  'stt.enabled': { default: false },
  'stt.host': { default: '' },
  'stt.model': { default: '' },
  'stt.language': { default: 'de' },
  'stt.temperature': { default: 0, validate: { type: 'number', min: 0, max: 1 } },
  // Upstream-Timeout fuer den Whisper-Forward. Grosszuegig, damit ein
  // GPU-Cold-Start (Modell-Reload nach Idle) den ersten Request nicht als
  // Timeout abschneidet und das Segment verliert. Self-hosted tunebar.
  'stt.upstream_timeout_ms': { default: 30000, validate: { type: 'int', min: 5000, max: 120000 } },
  'stt.vad.silence_ms': { default: 800, validate: { type: 'int', min: 200, max: 5000 } },
  'stt.vad.threshold': { default: 0.015, validate: { type: 'number', min: 0, max: 1 } },
  'stt.vad.max_segment_s': { default: 30, validate: { type: 'int', min: 5, max: 120 } },

  // Text-to-Speech (self-hosted, OpenAI-kompatibler Speech-Endpunkt) —
  // „Proof-Listening". enabled=true + host gesetzt blendet den Vorlese-Button im
  // Notebook-Editor ein. Der /tts/speak-Proxy synthetisiert pro Satz; voice/
  // speed/format gehen serverseitig in den Request, nie ins Frontend.
  'tts.enabled': { default: false },
  'tts.host': { default: '' },
  'tts.model': { default: '' },
  // Standard-Stimme (Fallback). Locale-spezifische Stimmen (tts.voice.de /
  // tts.voice.en) ueberschreiben sie, wenn fuer die Buch-Locale gesetzt — der
  // /tts/speak-Proxy loest die Stimme pro Request aus der Buch-Locale auf
  // (SSoT wie bei STT/LanguageTool die Sprache).
  'tts.voice': { default: '' },
  'tts.voice.de': { default: '' },
  'tts.voice.en': { default: '' },
  'tts.format': { default: 'mp3', validate: { type: 'enum', oneOf: ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'] } },
  'tts.speed': { default: 1, validate: { type: 'number', min: 0.25, max: 4 } },
  // Atempause (ms) zwischen den vorgelesenen Fragmenten — gibt dem Ohr Luft,
  // statt nahtlos ins naechste Fragment ueberzugehen. fragment_ms gilt Satz-zu-
  // Satz innerhalb eines Absatzes, paragraph_ms an Absatzgrenzen (Block-Wechsel,
  // meist etwas laenger). 0 = keine Pause. Browserseitig in der Abspiel-Schleife
  // angewandt, daher via /config ans Frontend geliefert (kein Secret).
  'tts.pause.fragment_ms': { default: 250, validate: { type: 'int', min: 0, max: 5000 } },
  'tts.pause.paragraph_ms': { default: 550, validate: { type: 'int', min: 0, max: 5000 } },

  // Bild-Generierung (self-hosted, OpenAI-kompatibler Image-Endpunkt).
  // enabled=true + host gesetzt schaltet das agentische Buch-Chat-Tool
  // `generate_image` frei (greift nur bei ai.provider=claude — nur dort gibt es
  // den Tool-Loop). Der /v1/images/generations-Call laeuft serverseitig im
  // Chat-Tool; Host/Model/Key verlassen den Server nie. Erzeugte Bilder sind
  // reine Weltaufbau-/Chat-Visualisierung: sie landen NICHT im Manuskript,
  // sondern nur im Chat-Verlauf (abrufbar + herunterladbar). size geht 1:1 an
  // den Endpunkt (z.B. "1024x1024"); SD-/Flux-Wrapper interpretieren es selbst.
  'image.enabled': { default: false },
  'image.host': { default: '' },
  'image.model': { default: '' },
  'image.size': { default: '1024x1024' },
  'image.timeout_ms': { default: 120000, validate: { type: 'int', min: 5000, max: 600000 } },

  // Semantische Suche (self-hosted, OpenAI-kompatibler /v1/embeddings-Endpunkt,
  // z.B. LocalAI). enabled=true + host gesetzt schaltet den Semantik-Suchmodus,
  // die „ähnliche Stellen"-Buttons an Figuren/Szenen und das Buch-Chat-Tool
  // `search_similar` frei (semanticSearch.enabled im /config leitet sich daraus
  // ab). Host/Model/Key verlassen den Server nie — nur der Ableitungs-Flag geht
  // ans Frontend. bge-m3: mehrsprachig, 8k Kontext (ganze Szene am Stück), 1024
  // dim. Modellwechsel invalidiert die Vektoren implizit (model steht im Chunk-
  // Key, Query filtert aufs aktive Modell → Reindex nötig). dim muss zum Modell
  // passen; nur als Sanity-Guard gespeichert, die echte Länge kommt vom Endpunkt.
  'embed.enabled': { default: false },
  'embed.host': { default: '' },
  'embed.model': { default: 'bge-m3' },
  'embed.dim': { default: 1024 },
  'embed.timeout_ms': { default: 60000 },
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
  'embed.min_score': { default: 0.25, validate: { type: 'number', min: 0, max: 1 } },
  'embed.hybrid': { default: true, validate: { type: 'bool' } },
  'embed.query_prefix': { default: '' },
  'embed.passage_prefix': { default: '' },

  // Plot-Verankerung (Beat-Anchor): Score-Untergrenze fürs Fundstellen-Popover +
  // Drift-Badge der Plot-Werkstatt. Blendet schwache semantische Beat-Treffer aus
  // (0 = alle zeigen). Filtert count UND Liste am Lese-Chokepoint → wirkt sofort
  // ohne Anchor-Neulauf. FTS-/wörtliche Treffer (score=null) bleiben immer sichtbar.
  'plot.anchor.min_score': { default: 0, validate: { type: 'number', min: 0, max: 1 } },

  // Plot-Verankerung — Promotion-Schwelle: ab welcher semantischen Ähnlichkeit ein
  // GEPLANTER Beat als „offenbar schon geschrieben" gilt und ein Promotion-Badge
  // („Als im Buch markieren?") bekommt. Bewusst hoch (Default 0.55) — geplante Beats
  // würden bei niedriger Schwelle für praktisch jeden Beat schwache Treffer liefern
  // und das Board mit falschen Vorschlägen fluten. Greift beim Anchor-Lauf (Store-
  // Zeit, nicht Lese-Zeit): nur Fundstellen ≥ dieser Schwelle werden für geplante
  // Beats überhaupt gespeichert. 0 = Promotion-Erkennung aus.
  'plot.anchor.promote_min_score': { default: 0.55, validate: { type: 'number', min: 0, max: 1 } },

  // Motiv-Erkennung (Motiv-Werkstatt, Ist-Index): Cosinus-Untergrenze für die
  // Fundstellen eines Motivs im Text. Blendet unwahrscheinliche semantische Treffer
  // aus Panel-Liste, Konfidenz-% UND Ist-Dichte (Graph-Knotengrösse + Geist-Erkennung)
  // aus — gefiltert am Lese-Chokepoint, wirkt sofort ohne Motiv-Scan-Neulauf. Wörtliche
  // Trigger-Treffer (score=null) bleiben immer sichtbar (Exakt-Match). Modellabhängig
  // wie embed.min_score; Default auf bge-m3 geeicht (0 = alle zeigen).
  'motif.scan.min_score': { default: 0.45, validate: { type: 'number', min: 0, max: 1 } },

  // Redundanz-Radar: Cosinus-Schwellen der drei UI-Bänder (streng/mittel/locker),
  // die der buchweite Doppelungs-Scan (lib/redundancy.js) über dem embed-Index
  // fährt. Modellabhängig wie embed.min_score — die Defaults sind auf bge-m3
  // geeicht; bei einem anderen Embedding-Modell hier nachjustieren (fremde Modelle
  // haben andere Cosinus-Verteilungen). Der Job clampt zusätzlich auf 0.70–0.97.
  'redundancy.threshold_strict': { default: 0.88, validate: { type: 'number', min: 0, max: 1 } },
  'redundancy.threshold_medium': { default: 0.82, validate: { type: 'number', min: 0, max: 1 } },
  'redundancy.threshold_loose': { default: 0.76, validate: { type: 'number', min: 0, max: 1 } },

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
  'rerank.enabled': { default: false, validate: { type: 'bool' } },
  'rerank.host': { default: '' },
  'rerank.model': { default: 'bge-reranker-v2-m3' },
  'rerank.api_key': { default: '', secret: true },
  'rerank.timeout_ms': { default: 30000, validate: { type: 'int', min: 5000, max: 600000 } },
  'rerank.top_n': { default: 30, validate: { type: 'int', min: 5, max: 100 } },
  'rerank.min_score': { default: 0, validate: { type: 'number', min: 0, max: 1 } },

  // Geocoding (Orte-Karte). provider waehlt die Koordinaten-Quelle: OSM-Nominatim
  // (public oder self-hosted) oder Photon (Komoot, self-hosted). Die jeweilige
  // url-Setting zeigt auf die Instanz. Nominatim hat einen public Default;
  // Photon braucht zwingend eine eigene URL (leer = kein Geocoding-Vorschlag,
  // manueller Pin bleibt moeglich).
  'geocode.provider': {
    default: 'nominatim',
    validate: { type: 'enum', oneOf: ['nominatim', 'photon'] },
    env: [['GEOCODE_PROVIDER', v => String(v).toLowerCase()]],
  },
  'geocode.nominatim.url': {
    default: 'https://nominatim.openstreetmap.org/search',
    env: [['NOMINATIM_URL', v => String(v)]],
  },
  'geocode.photon.url': { default: '', env: [['PHOTON_URL', v => String(v)]] },
  // Tile-Server der Orte-Karte. Leaflet holt die Kacheln direkt im Browser, die
  // URL wird daher via /config ans Frontend geliefert (anders als die Geocoder-
  // URLs, die nur serverseitig genutzt werden). Default = Public-OSM (Tile Usage
  // Policy beachten); ein self-hosted Tile-Server (openstreetmap-tile-server /
  // tileserver-gl) bekommt seine eigene URL im {z}/{x}/{y}.png-Schema. Die
  // {s}-Subdomain ist optional — Leaflet ignoriert den Platzhalter, wenn die URL
  // ihn nicht enthaelt. attribution leer = Frontend nutzt den i18n-Default.
  'geocode.tiles.url': {
    default: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    env: [['OSM_TILES_URL', v => String(v)]],
  },
  'geocode.tiles.attribution': { default: '', env: [['OSM_TILES_ATTRIBUTION', v => String(v)]] },
};
