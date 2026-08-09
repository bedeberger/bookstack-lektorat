const crypto = require('crypto');
const express = require('express');
const logger = require('../logger');
const avatarCache = require('../lib/avatar-cache');
const { MAX_TOKENS_OUT, CHARS_PER_TOKEN, resolveProvider, providerClass } = require('../lib/ai');
const { aiSetting } = require('../lib/ai/profile');
const { getBookLocale } = require('../db/schema');
const appUsers = require('../db/app-users');
const { getPromptConfig } = require('../lib/prompts-loader');
const { toIntId } = require('../lib/validate');
const appSettings = require('../lib/app-settings');
const { getVersion, getShellBuild } = require('../lib/version');
const { MAX_INPUT_BYTES: PDF_MAX_BYTES } = require('../lib/pdf-attachment');

const router = express.Router();

const OSM_TILES_DEFAULT = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';

// Liefert die Tile-URL fuers Frontend: nur-HTTP-Upstreams ueber den Same-Origin-
// Proxy (/tiles) ausspielen (sonst Mixed-Content-Block bei HTTPS-App), sonst die
// konfigurierte URL direkt. Siehe routes/tiles.js.
function tileFrontendUrl() {
  const tpl = String(appSettings.get('geocode.tiles.url') || '').trim() || OSM_TILES_DEFAULT;
  return /^http:\/\//i.test(tpl) ? '/tiles/{z}/{x}/{y}' : tpl;
}

// Modell-Konfiguration ans Frontend liefern (keine Credentials)
router.get('/config', (req, res) => {
  const sessionUser = req.session?.user || null;
  let user = sessionUser;
  let userSettings = null;
  if (sessionUser) {
    const appUser = appUsers.getUser(sessionUser.email);
    // Google-Profilbild über den Same-Origin-Proxy (/auth/avatar) ausliefern,
    // damit Browser-Tracking-Prevention den Direktzugriff auf
    // googleusercontent.com nicht blockt. `?v=` bricht den Browser-Cache, wenn
    // Google die Avatar-URL rotiert (avatarCache liest die echte URL aus der Session).
    let picture = sessionUser.picture || null;
    if (avatarCache.isAllowedAvatarUrl(picture)) {
      const v = crypto.createHash('sha1').update(picture).digest('hex').slice(0, 8);
      picture = `/auth/avatar?v=${v}`;
    }
    user = {
      ...sessionUser,
      picture,
      role: appUser?.global_role || 'user',
      status: appUser?.status || 'active',
      can_invite_users: appUser?.can_invite_users ? 1 : 0,
      isAdmin: appUser?.global_role === 'admin',
    };
    if (appUser) {
      // `locale` ist API-Vertrag; app_users-Spalte heisst `language`.
      userSettings = {
        locale:            appUser.language,
        theme:             appUser.theme,
        default_buchtyp:   appUser.default_buchtyp,
        default_language:  appUser.default_language,
        default_region:    appUser.default_region,
        focus_granularity: appUser.focus_granularity,
      };
    }
  }
  // Effektiver (per-User aufgelöster) Provider — Basis fürs Feature-Gating von
  // Claude-only-Features im Frontend (anders als `apiProvider`, das den globalen
  // ai.provider spiegelt und den Per-User-Override ignoriert).
  const effectiveProvider = sessionUser
    ? resolveProvider({ userEmail: sessionUser.email })
    : (appSettings.get('ai.provider') || 'claude');
  // Klasse des effektiven Providers ('cloud' | 'local'). Gate fuer alles, was ein
  // faehiges Modell braucht, aber keine Anthropic-API-Faehigkeit — im Gegensatz zu
  // `effectiveProvider === 'claude'`, das fuer Web-Suche & Co zustaendig bleibt.
  const effectiveClass = providerClass(effectiveProvider, sessionUser ? { userEmail: sessionUser.email } : { userEmail: null });
  // Modellnamen fuer die Anzeige (Avatar-Menue): ueber das Profil-Overlay, sonst
  // zeigte die App jedem User das global eingestellte Modell — auch dem, der per
  // Profil auf einem ganz anderen laeuft.
  const _pOpts = sessionUser ? { userEmail: sessionUser.email } : { userEmail: null };
  res.json({
    claudeMaxTokens: MAX_TOKENS_OUT,
    claudeModel: aiSetting('claude', 'model', _pOpts) || 'claude-sonnet-4-6',
    apiProvider: appSettings.get('ai.provider') || 'claude',
    effectiveProvider,
    effectiveProviderClass: effectiveClass,
    charsPerToken: CHARS_PER_TOKEN,
    ollamaModel: aiSetting('ollama', 'model', _pOpts) || 'llama3.2',
    openaiCompatModel: aiSetting('openai-compat', 'model', _pOpts) || 'llama3.2',
    user,
    userSettings,
    devMode: process.env.LOCAL_DEV_MODE === 'true',
    promptConfig: getPromptConfig(),
    appTimezone: appSettings.get('app.timezone') || 'Europe/Zurich',
    appName: appSettings.get('app.name') || 'Schreibwerkstatt',
    appVersion: getVersion(),
    shellBuild: getShellBuild(),
    languagetool: {
      enabled: appSettings.get('languagetool.enabled') === true
        && !!String(appSettings.get('languagetool.url') || '').replace(/\/$/, '').replace(/\/v2$/i, '').trim(),
      debounceMs: Number(appSettings.get('languagetool.debounce_ms')) || 1500,
    },
    // STT: nur enabled + VAD-Schwellen (VAD laeuft im Browser). Host/Key/Model/
    // Language verlassen den Server nicht — die Sprache loest /stt/transcribe
    // pro Request aus der Buch-Locale auf.
    stt: {
      enabled: appSettings.get('stt.enabled') === true
        && !!String(appSettings.get('stt.host') || '').trim(),
      provider: 'openai-compat',
      vad: {
        silenceMs:    Number(appSettings.get('stt.vad.silence_ms')) || 800,
        threshold:    Number(appSettings.get('stt.vad.threshold')) || 0.015,
        maxSegmentS:  Number(appSettings.get('stt.vad.max_segment_s')) || 30,
      },
    },
    // TTS (Proof-Listening): enabled + Atempausen (ms). Host/Model/Voice/Speed/
    // Key verlassen den Server nie — die Synthese laeuft komplett ueber den
    // /tts/speak-Proxy. Die Pausen-Werte sind kein Secret: sie steuern die
    // browserseitige Abspiel-Schleife (wie die STT-VAD-Schwellen).
    tts: {
      enabled: appSettings.get('tts.enabled') === true
        && !!String(appSettings.get('tts.host') || '').trim(),
      pause: {
        fragmentMs:  Number.isFinite(Number(appSettings.get('tts.pause.fragment_ms')))  ? Number(appSettings.get('tts.pause.fragment_ms'))  : 250,
        paragraphMs: Number.isFinite(Number(appSettings.get('tts.pause.paragraph_ms'))) ? Number(appSettings.get('tts.pause.paragraph_ms')) : 550,
      },
    },
    // Tile-Server der Orte-Karte. Leaflet holt die Kacheln direkt im Browser,
    // darum muss die URL ans Frontend (anders als die Geocoder-URLs, die nur der
    // server-seitige /geocode-Proxy nutzt). Ein nur-HTTP-Upstream (z. B. LAN-Tile-
    // Server) wuerde von einer HTTPS-App als Mixed-Content geblockt → dann liefern
    // wir die Same-Origin-Proxy-URL (/tiles, routes/tiles.js) statt der http-URL.
    // HTTPS-/OSM-Upstreams laedt Leaflet weiterhin direkt. attribution leer =
    // Frontend faellt auf den i18n-Default (orte.map.attribution) zurueck.
    mapTiles: {
      url: tileFrontendUrl(),
      attribution: String(appSettings.get('geocode.tiles.attribution') || '').trim(),
    },
    // Recherche-Chat (agentisch, mit Web-Suche) — Claude-only. Das Panel in der
    // Recherche-Karte erscheint nur, wenn der EFFEKTIVE Provider dieses Users Claude
    // ist (Web-Suche gibt es nur über die Anthropic-API), ein API-Key gesetzt ist und
    // der Admin-Kill-Switch nicht auf false steht (Default an).
    researchChat: {
      enabled: appSettings.get('research_chat.enabled') !== false
        && effectiveProvider === 'claude'
        && !!String(appSettings.get('ai.claude.api_key') || '').trim(),
    },
    // PDF-Anhang (Quelle + Recherche-Fundstueck): Upload-Limit als SSoT vom
    // Server. Ohne das steht dieselbe Zahl im Browser, im express.raw-Body und
    // im Extraktor — und der Browser laedt 30 MB hoch, um dann ein 413 zu sehen.
    pdfUpload: { maxBytes: PDF_MAX_BYTES },
    // Semantische Suche (Embeddings, self-hosted). enabled=true + host schaltet
    // den Semantik-Suchmodus, die „ähnliche Stellen"-Buttons und das Buch-Chat-
    // Tool `search_similar` frei. Provider-unabhängig (eigener Embedding-Endpunkt,
    // nicht der Chat-Provider). Host/Model/Key verlassen den Server nie.
    semanticSearch: (() => {
      const enabled = appSettings.get('embed.enabled') === true
        && !!String(appSettings.get('embed.host') || '').trim();
      return {
        enabled,
        // Ableitungs-Flags nur für einen dezenten UI-Hinweis in der Such-Karte —
        // Host/Model/Key bleiben serverseitig. hybrid = FTS5-Fusion aktiv;
        // rerank = Cross-Encoder-Nachordnung aktiv.
        hybrid: enabled && appSettings.get('embed.hybrid') !== false,
        rerank: enabled
          && appSettings.get('rerank.enabled') === true
          && !!String(appSettings.get('rerank.host') || '').trim(),
      };
    })(),
    // Redundanz-Radar: die drei Band-Schwellen (streng/mittel/locker). Der Radar
    // liest den embed-Index, darum sind es modellabhängige Cosinus-Werte, die im
    // Admin-Semantik-Tab justierbar sind. Keine Credentials — reine UI-Kalibrierung.
    redundancy: {
      thresholdStrict: Number(appSettings.get('redundancy.threshold_strict')),
      thresholdMedium: Number(appSettings.get('redundancy.threshold_medium')),
      thresholdLoose:  Number(appSettings.get('redundancy.threshold_loose')),
    },
    // Komplettanalyse-Zusatzphasen «Kontinuität» + «Erzählprofil»: die
    // qualitätskritischen Stufen (Single-Pass, Verify-Filter, Attribut-Check)
    // brauchen ein faehiges Modell → fuer die lokale Klasse Karten ausgeblendet und
    // die Phasen im Job uebersprungen. Gating an der KLASSE des effektiven
    // (per-User) Providers — dieselbe Entscheidung wie in job-komplett.js.
    komplett: {
      continuity:      effectiveClass === 'cloud',
      narrativeProfile: effectiveClass === 'cloud',
      // Weltfakten-Realitätscheck: Claude-only (web_search-Server-Tool) UND per Instanz
      // freigeschaltet (Web-Suche kostet). Das Buch-Opt-in weltfakten_real_pruefen gated
      // zusätzlich pro Buch (Frontend prüft es am Buch, nicht hier).
      factcheck:       effectiveProvider === 'claude' && appSettings.get('ai.komplett.factcheck') === true,
    },
  });
});

// OpenThesaurus (openthesaurus.de) — deutscher Community-Thesaurus von Daniel Naber.
// JSON-API liefert Bedeutungsgruppen (synsets) mit stilistischem Level; nur für deutsche Bücher.
// Terme können Kontext in Klammern enthalten ("(sich) identifizieren (mit)") — wird fürs Ersetzen gestrippt.
function cleanThesTerm(term) {
  return String(term || '').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
}

async function fetchOpenThesaurusRaw(word, budgetSignal) {
  const url = `https://www.openthesaurus.de/synonyme/search?q=${encodeURIComponent(word)}&format=application/json&baseform=true`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  const onBudget = () => ctrl.abort();
  budgetSignal?.addEventListener?.('abort', onBudget);
  try {
    const upstream = await fetch(url, { signal: ctrl.signal, headers: { 'Accept': 'application/json' } });
    if (!upstream.ok) return null;
    return await upstream.json();
  } catch (err) {
    if (err.name !== 'AbortError') logger.warn(`OpenThesaurus fetch «${word}»: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
    budgetSignal?.removeEventListener?.('abort', onBudget);
  }
}

function extractThesSynonyms(data, queryWord) {
  const synsets = Array.isArray(data?.synsets) ? data.synsets : [];
  const normQuery = queryWord.toLowerCase();
  const out = [];
  const seen = new Set([normQuery]);
  for (const synset of synsets) {
    const terms = Array.isArray(synset?.terms) ? synset.terms : [];
    for (const t of terms) {
      const clean = cleanThesTerm(t?.term);
      if (!clean) continue;
      const key = clean.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ wort: clean, hinweis: (t?.level || '').trim() });
    }
  }
  return out;
}

// Liefert Synonyme; fällt bei flektierten Formen ("ging") automatisch auf die Grundform zurück.
async function fetchOpenThesaurus(word, budgetSignal) {
  const first = await fetchOpenThesaurusRaw(word, budgetSignal);
  if (!first) return { synonyme: [], lemma: null };
  const direct = extractThesSynonyms(first, word);
  if (direct.length > 0) return { synonyme: direct, lemma: null };
  const baseforms = Array.isArray(first?.baseforms) ? first.baseforms : [];
  for (const lemma of baseforms) {
    if (!lemma || lemma.toLowerCase() === word.toLowerCase()) continue;
    if (budgetSignal?.aborted) break;
    const second = await fetchOpenThesaurusRaw(lemma, budgetSignal);
    if (!second) continue;
    const hits = extractThesSynonyms(second, lemma);
    if (hits.length > 0) {
      const hinweis = `Grundform: ${lemma}`;
      return {
        synonyme: hits.map(h => ({ wort: h.wort, hinweis: h.hinweis || hinweis })),
        lemma,
      };
    }
  }
  return { synonyme: [], lemma: null };
}

router.get('/openthesaurus/synonyms', async (req, res) => {
  const word = (req.query.word || '').trim();
  const bookId = toIntId(req.query.book_id);
  const log = logger.child({ job: 'thesaurus', user: req.session?.user?.email || '-', book: bookId || '-' });
  if (!word) return res.json({ synonyme: [], disabled: false });
  const userEmail = req.session?.user?.email || null;
  const locale = bookId ? getBookLocale(bookId, userEmail) : 'de-CH';
  if (!locale || !locale.toLowerCase().startsWith('de')) {
    log.info(`word=«${word}» skipped (locale=${locale})`);
    return res.json({ synonyme: [], disabled: true });
  }
  const budget = new AbortController();
  const budgetTimer = setTimeout(() => budget.abort(), 10000);
  const t0 = Date.now();
  try {
    const { synonyme, lemma } = await fetchOpenThesaurus(word, budget.signal);
    const ms = Date.now() - t0;
    log.info(`word=«${word}»${lemma ? ` lemma=«${lemma}»` : ''} hits=${synonyme.length} ${ms}ms`);
    res.json({ synonyme, disabled: false, lemma });
  } finally {
    clearTimeout(budgetTimer);
  }
});

module.exports = { router };
