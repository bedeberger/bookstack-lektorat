'use strict';
// Share-Link Public-Reader: SSR-Leseansicht (GET /share/:token) + Leser-
// Self-Service (Kommentar abgeben/bearbeiten/löschen/erledigen, Namen ändern,
// Threads-JSON). Ohne Session — Mount in server.js VOR dem Auth-Guard.

const express = require('express');
const shareLinks = require('../../db/share-links');
const rateLimit = require('../../lib/share-ratelimit');
const { setContext } = require('../../lib/log-context');
const { tServer, tServerParams } = require('../../lib/i18n-server');
const appSettings = require('../../lib/app-settings');
const notify = require('../../lib/notify');
const logger = require('../../logger');
const H = require('../../lib/share-helpers');
const tts = require('../../lib/tts-synth');
const { getBookLocale } = require('../../db/schema');

const {
  commentBody, TEMPLATE_OK, articleStyleClass,
  READER_NAME_MAX, READER_EMAIL_MAX, BODY_MAX, ANCHOR_QUOTE_MAX,
  ANCHOR_BID_RE, READER_TOKEN_RE, READER_EMAIL_RE, TOKEN_RE,
  serializeCommentForReader, escHtml, detectLang, isExpired,
  fillTemplate, paragraphifyIntro, backfillScopeBlockIds, loadContentForLink,
  buildTocBlock, renderGone, htmlToPlainLength,
} = H;

// Lesezeit-Schaetzung: durchschnittliche stille Lesegeschwindigkeit ~1100
// Zeichen/Min (≈200 WpM Prosa). Zeichen ist die primaere Umfangs-Kennzahl.
const CHARS_PER_MINUTE = 1100;

function register(router) {
  // ── Public: Manuskript-Bild eines geteilten Inhalts ────────────────────────
  // Token-gebundener Bild-Stream (der Reader laeuft ohne Session; /content/* ist
  // auth-geschuetzt). Scope-Check: das Bild muss zu einer Seite im Link-Scope
  // gehoeren (page → gleiche Seite, chapter → gleiches Kapitel, book → gleiches Buch).
  router.get('/:token/page-image/:id', (req, res) => {
    const token = String(req.params.token || '');
    if (!TOKEN_RE.test(token)) return res.status(404).type('html').send('Not found');
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).type('html').send('Not found');
    const link = shareLinks.getShareLinkByToken(token);
    if (!link || isExpired(link)) return res.status(404).type('html').send('Not found');
    setContext({ book: link.book_id });

    const { getPageImage } = require('../../db/page-images');
    const row = getPageImage(id);
    if (!row || !row.image) return res.status(404).type('html').send('Not found');

    // Scope: Bild nur ausliefern, wenn seine Seite im geteilten Bereich liegt.
    const inScope =
      link.kind === 'page'    ? row.page_id === link.page_id
      : link.kind === 'chapter' ? (row.book_id === link.book_id && row.chapter_id === link.chapter_id)
      : link.kind === 'book'    ? row.book_id === link.book_id
      : false;
    if (!inScope) return res.status(404).type('html').send('Not found');

    const SAFE_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
    const safe = SAFE_IMAGE_MIME.has(row.mime);
    res.setHeader('Content-Type', safe ? row.mime : 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Content-Length', row.image.length);
    res.end(row.image);
  });

  // ── Public: Vorlesen (TTS / Proof-Listening) ───────────────────────────────
  // Token-gebundene Synthese fuer den Share-Reader (laeuft ohne Session; der
  // auth-pflichtige /tts/speak-Proxy ist fuer den anonymen Leser nicht
  // erreichbar). Voice locale-aware aus der Buch-Locale des geteilten Buchs.
  // Kein Persistieren; Credentials/Host verlassen den Server nie (Kern:
  // lib/tts-synth.js, geteilt mit routes/tts.js).
  router.post('/:token/tts', express.json({ limit: tts.TEXT_MAX + 2048 }), async (req, res) => {
    const token = String(req.params.token || '');
    if (!TOKEN_RE.test(token)) return res.status(404).json({ error: 'not_found' });
    const link = shareLinks.getShareLinkByToken(token);
    if (!link || isExpired(link)) return res.status(404).json({ error: 'not_found' });
    setContext({ book: link.book_id });

    // Feature aus -> 404 (Frontend behandelt als „Vorlesen nicht verfuegbar",
    // der Dock ist ohnehin nur bei enabled im DOM).
    if (!tts.isEnabled()) return res.status(404).json({ error: 'tts_disabled' });

    // Stimme aus der Buch-Locale (SSoT wie im authed Pfad). owner_email ist der
    // Buch-Besitzer — dessen Locale-Override bestimmt die Sprache des Buchs.
    let lang = '';
    try { lang = getBookLocale(link.book_id, link.owner_email) || ''; } catch { /* noop */ }

    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    try {
      const { buf, mime } = await tts.synthesizeSpeech({ text, lang });
      res.setHeader('Content-Type', mime);
      res.setHeader('Cache-Control', 'no-store');
      return res.end(buf);
    } catch (err) {
      if (err instanceof tts.TtsError) {
        if (err.status >= 500 || err.status === 408) {
          logger.warn(`[share/tts] ${err.code} token=${token.slice(0, 8)} book=${link.book_id} status=${err.status}`);
        }
        const body = { error: err.code };
        if (err.max) body.max = err.max;
        return res.status(err.status).json(body);
      }
      logger.warn(`[share/tts] unexpected ${err?.message} token=${token.slice(0, 8)}`);
      return res.status(502).json({ error: 'tts_upstream' });
    }
  });

  // ── Public: Reader-View ───────────────────────────────────────────────────
  router.get('/:token', async (req, res) => {
    const token = String(req.params.token || '');
    if (!TOKEN_RE.test(token)) return res.status(404).type('html').send('Not found');
    const link = shareLinks.getShareLinkByToken(token);
    if (!link) return res.status(404).type('html').send('Not found');
    setContext({ book: link.book_id });
    const gone = isExpired(link);
    if (gone) {
      logger.warn(`[share/reader] 410 ${gone} token=${token.slice(0, 8)} book=${link.book_id}`);
      return renderGone(req, res, gone);
    }
    const lang = detectLang(req);
    // Legacy-/Import-Seiten ohne data-bid einmalig nachziehen, damit verankerte
    // Kommentare (Selektions-Button + schwebende Leiste) funktionieren — auch fuer
    // Links, die vor dem Backfill-on-create angelegt wurden. Idempotent, additiv.
    await backfillScopeBlockIds(link);
    const content = await loadContentForLink(link);
    if (!content) return res.status(404).type('html').send('Not found');

    const introAuthor = link.owner_display_name || tServer('share.reader.anon_author', lang);
    const introLabel = tServerParams('share.reader.intro_label', { name: introAuthor }, lang);
    const introBlock = link.intro
      ? `<aside class="share-intro" aria-label="${escHtml(introLabel)}">
        <div class="share-intro__label">${escHtml(introLabel)}</div>
        <div class="share-intro__body">${paragraphifyIntro(link.intro)}</div>
      </aside>`
      : '';

    const tocBlock = link.show_toc ? buildTocBlock(content, lang) : '';
    const layoutClass = tocBlock ? 'share-layout--has-toc' : '';

    // Umfang + Lesezeit (dem Leser oben angezeigt). Zeichen als Primaerkennzahl,
    // Minuten als abgeleitete Schaetzung (min. 1).
    const contentChars = htmlToPlainLength(content.html);
    const readMinutes = Math.max(1, Math.round(contentChars / CHARS_PER_MINUTE));
    const metaBlock = contentChars > 0
      ? `<div class="share-header__meta">
          <span class="share-header__meta-item">${escHtml(tServerParams('share.reader.char_count', { count: contentChars.toLocaleString(lang === 'en' ? 'en-US' : 'de-CH') }, lang))}</span>
          <span class="share-header__meta-item">${escHtml(tServerParams('share.reader.reading_time', { min: readMinutes }, lang))}</span>
        </div>`
      : '';

    // Lesetiefe-Zuordnung fuer den Reader: pro Kapitel der Anker seiner Ueberschrift
    // (Buch-Shares). read-depth.js nutzt aufeinanderfolgende Kapitel-Anker als
    // Grenzen → Ø-Lesetiefe pro Kapitel (chapter_id = echter FK). Kapitel-Shares
    // haben keine Kapitel-Ueberschrift (omitChapterHeaders) → nur Gesamt-Tiefe.
    const readDepthChapters = (content.toc || [])
      .filter(e => e.level === 1 && e.chapterId)
      .map(e => ({ id: e.chapterId, anchor: e.anchor }));

    // SSR-Fallback zeigt nur allgemeine Anmerkungen (kein Anker, kein Reply) in der
    // unteren Sektion. Verankerte Threads werden client-seitig via /threads in die
    // schwebende Leiste hydriert (share-reader.js) — ohne JS nicht positionierbar,
    // daher SSR-Rail leer.
    const comments = shareLinks.listCommentsByToken(token, { order: 'desc' })
      .filter(c => !c.parent_id && !c.anchor_bid);
    const generalCommentsHtml = comments.length
      ? comments.map(c => `<li class="share-comments__item">
          <div class="share-comments__meta">${escHtml(c.reader_name || tServer('share.reader.anon', lang))} · ${escHtml(c.created_at)}</div>
          <div class="share-comments__body">${escHtml(c.body)}</div>
        </li>`).join('\n')
      : `<li class="share-comments__empty">${escHtml(tServer('share.reader.comments_empty', lang))}</li>`;

    const fallback = req.query?.cmt;
    const fallbackMsg = fallback === 'ok'   ? tServer('share.reader.comment_submitted', lang)
                      : fallback === 'rate' ? tServer('share.reader.comment_rate_limited', lang)
                      : fallback === 'empty'? tServer('share.reader.form_empty', lang)
                      : fallback === 'long' ? tServer('share.reader.form_error', lang)
                      : fallback === 'err'  ? tServer('share.reader.form_error', lang)
                      : '';
    const fallbackBlock = fallbackMsg
      ? `<div class="share-comments__status share-comments__status--${escHtml(String(fallback))}" role="status">${escHtml(fallbackMsg)}</div>`
      : '';
    const formBlock = `${fallbackBlock}<form id="share-comment-form" class="share-comments__form" autocomplete="off"
        method="POST" action="/share/${escHtml(token)}/comment"
        data-empty-msg="${escHtml(tServer('share.reader.form_empty', lang))}"
        data-rate-msg="${escHtml(tServer('share.reader.comment_rate_limited', lang))}"
        data-error-msg="${escHtml(tServer('share.reader.form_error', lang))}"
        data-success-msg="${escHtml(tServer('share.reader.comment_submitted', lang))}"
        data-anon="${escHtml(tServer('share.reader.anon', lang))}">
        <label class="share-comments__label">
          <span>${escHtml(tServer('share.reader.comment_form_name', lang))}</span>
          <input type="text" name="reader_name" maxlength="${READER_NAME_MAX}" placeholder="${escHtml(tServer('share.reader.comment_form_name_placeholder', lang))}">
        </label>
        <label class="share-comments__label">
          <span>${escHtml(tServer('share.reader.comment_form_body', lang))}</span>
          <textarea name="body" rows="4" required maxlength="${BODY_MAX}"></textarea>
        </label>
        <input type="text" name="_hp" tabindex="-1" autocomplete="off" aria-hidden="true" class="share-comments__hp">
        <div class="share-comments__actions">
          <button type="submit">${escHtml(tServer('share.reader.comment_form_submit', lang))}</button>
          <span id="share-comment-status" class="share-comments__status" role="status"></span>
        </div>
      </form>`;

    // Reader-Config (Token + i18n) fuer share-reader.js. JSON in <script type=
    // "application/json"> — `<` escapen, damit kein `</script>`-Breakout moeglich.
    const readerKeys = ['anchor_cta', 'composer_title', 'composer_general_title', 'reply',
      'reply_placeholder', 'send', 'cancel', 'you_badge', 'author_badge', 'resolved_badge',
      'jump_to_text', 'anchor_stale', 'anchor_changed', 'threads_heading', 'threads_empty',
      'your_name', 'comment_as', 'change_name', 'set_name', 'name_modal_title', 'name_modal_intro',
      'name_modal_save', 'name_modal_skip', 'anon', 'comment_form_body', 'comment_form_submit',
      'comment_submitted', 'comment_rate_limited', 'form_empty', 'form_error', 'comments_empty',
      'options_label', 'theme_label', 'theme_auto', 'theme_light', 'theme_dark',
      'delete', 'delete_confirm', 'mark_done', 'reopen', 'delete_has_replies',
      'email_optional_hint', 'email_notice_on', 'name_modal_email',
      'edit', 'edit_save', 'edited_badge', 'new_reply_badge',
      'tts_listen', 'tts_pause', 'tts_resume', 'tts_skip', 'tts_stop',
      'tts_reading', 'tts_paused', 'tts_loading', 'tts_error',
      'resume_reading', 'back_to_top',
      'prefs_label', 'prefs_font_size', 'prefs_smaller', 'prefs_larger',
      'prefs_line_width', 'prefs_width_narrow', 'prefs_width_normal', 'prefs_width_wide',
      'prefs_typeface', 'prefs_serif', 'prefs_sans',
      'feedback_heading', 'feedback_intro', 'feedback_rating_label', 'feedback_star',
      'feedback_comment_placeholder', 'feedback_submit', 'feedback_update',
      'feedback_thanks', 'feedback_error', 'feedback_change'];
    const readerI18n = {};
    for (const k of readerKeys) readerI18n[k] = tServer(`share.reader.${k}`, lang);
    // Vorlesen (TTS): nur `enabled` + Atempausen ans Frontend — Host/Voice/Key
    // bleiben server-seitig (Kern lib/tts-synth.js). Bei ausgeschaltetem Feature
    // baut share-reader.js den Dock gar nicht.
    const ttsCfg = { enabled: tts.isEnabled(), pause: tts.pauseConfig() };

    // Aufruf protokollieren (Gesamtzaehler + share_views-Zeile fuer eindeutige
    // Besucher/Lesedauer). ip_hash gehasht wie bei Kommentaren. viewId geht an den
    // Reader, damit er die Verweildauer per Beacon nachtragen kann. DB-Fehler
    // duerfen die Leseansicht nie blockieren.
    let viewId = null;
    try {
      const ip = req.ip || req.connection?.remoteAddress || '';
      viewId = shareLinks.recordShareView(token, rateLimit.hashIp(ip));
    } catch (e) { logger.warn(`[share/view] record fehlgeschlagen: ${e.message}`); }

    const configJson = JSON.stringify({
      token, lang, viewId, i18n: readerI18n, tts: ttsCfg,
      readDepth: { chapters: readDepthChapters },
    }).replace(/</g, '\\u003c');

    // Bei Buch-Shares ist content.title bereits der Buchname — keine Doppelung
    // (Buch-Zeile leer, H1 = Buchname). Sonst "Seite/Kapitel · Buch".
    const isBook = link.kind === 'book';
    const html = fillTemplate(TEMPLATE_OK, {
      lang,
      config_json: configJson,
      layout_class: layoutClass,
      article_class: articleStyleClass(link.book_id),
      title: escHtml(isBook ? content.title : `${content.title} · ${link.book_name}`),
      book_name: escHtml(isBook ? '' : (link.book_name || '')),
      target_name: escHtml(content.title),
      // Dachzeile publizistischer Beitraege (nur Seiten-Share, sonst leer):
      // fertiges Markup aus lib/headline-render.js, dort bereits escaped. Der
      // Lead steht nicht hier, sondern als Vorspann am Beitragsanfang.
      head_kicker: content.kicker || '',
      author_name: escHtml(link.owner_display_name || tServer('share.reader.anon_author', lang)),
      t_by: escHtml(tServer('share.reader.by', lang)),
      t_skip: escHtml(tServer('share.reader.skip_to_content', lang)),
      t_comments: escHtml(tServer('share.reader.comments_heading', lang)),
      t_general_heading: escHtml(tServer('share.reader.general_heading', lang)),
      reading_meta: metaBlock,
      intro_block: introBlock,
      toc_block: tocBlock,
      content_html: content.html,
      anchored_comments_html: '',
      general_comments_html: generalCommentsHtml,
      form_block: formBlock,
      app_name: 'Schreibwerkstatt',
      app_url: escHtml((appSettings.get('app.public_url') || '').replace(/\/$/, '') || '/'),
    });

    res.set('Cache-Control', 'no-store');
    res.status(200).type('html').send(html);
  });

  // ── Public: Verweildauer eines Aufrufs nachtragen (Beacon) ─────────────────
  // Der Reader schickt beim Verlassen der Seite (pagehide/visibilitychange) die
  // sichtbar verbrachte Zeit via navigator.sendBeacon. Write-once pro view_id,
  // geclampt auf einen sinnvollen Maximalwert (Bot-/Manipulationsschutz fuer die
  // Owner-Statistik). Antwortet immer 204 — Beacons ignorieren den Body.
  const MAX_DWELL_MS = 6 * 60 * 60 * 1000; // 6 h
  router.post('/:token/view-duration', express.json({ limit: '1kb' }), (req, res) => {
    const token = String(req.params.token || '');
    if (!TOKEN_RE.test(token)) return res.sendStatus(204);
    const viewId = parseInt(req.body?.viewId, 10);
    const durationMs = Math.round(Number(req.body?.durationMs));
    if (!Number.isInteger(viewId) || viewId <= 0) return res.sendStatus(204);
    if (!Number.isFinite(durationMs) || durationMs < 0) return res.sendStatus(204);
    const clamped = Math.min(durationMs, MAX_DWELL_MS);
    try { shareLinks.setViewDuration(viewId, token, clamped); } catch { /* non-fatal */ }
    res.sendStatus(204);
  });

  // ── Public: Lesetiefe eines Aufrufs nachtragen (Beacon) ────────────────────
  // Gesamt-Scrolltiefe (0-100 %) + optional pro Kapitel die erreichte Tiefe. Wie
  // die Verweildauer per sendBeacon beim Wechsel in den Hintergrund; MAX-Merge in
  // der DB, view_id token-gebunden. Antwortet immer 204.
  router.post('/:token/read-depth', express.json({ limit: '8kb' }), (req, res) => {
    const token = String(req.params.token || '');
    if (!TOKEN_RE.test(token)) return res.sendStatus(204);
    const viewId = parseInt(req.body?.viewId, 10);
    if (!Number.isInteger(viewId) || viewId <= 0) return res.sendStatus(204);

    const rawMax = Math.round(Number(req.body?.maxScrollPct));
    if (Number.isFinite(rawMax) && rawMax >= 0) {
      const pct = Math.min(100, rawMax);
      try { shareLinks.setViewMaxScroll(viewId, token, pct); } catch { /* non-fatal */ }
    }

    // Pro-Kapitel-Tiefe (max. 500 Eintraege defensiv). chapterId + pct clamped in DB.
    const chapters = Array.isArray(req.body?.chapters) ? req.body.chapters.slice(0, 500) : [];
    if (chapters.length) {
      const sections = chapters
        .map(c => ({ chapterId: parseInt(c?.chapterId, 10), pct: Number(c?.pct) }))
        .filter(c => Number.isInteger(c.chapterId) && c.chapterId > 0 && Number.isFinite(c.pct));
      if (sections.length) {
        try { shareLinks.recordSectionDepths(viewId, token, sections); } catch { /* non-fatal */ }
      }
    }
    res.sendStatus(204);
  });

  // ── Public: Gesamt-Fazit abgeben (Sternewertung + optionaler Freitext) ──────
  // Einmal pro Leser (reader_token, UPSERT). Erneutes Absenden aktualisiert das
  // eigene Fazit. reader_token ist Pflicht (sonst kein Upsert-Key → Spam-Schutz).
  router.post('/:token/feedback', express.json({ limit: '8kb' }), (req, res) => {
    const token = String(req.params.token || '');
    if (!TOKEN_RE.test(token)) return res.status(404).json({ error_code: 'NOT_FOUND' });
    const link = shareLinks.getShareLinkByToken(token);
    if (!link || isExpired(link)) return res.status(404).json({ error_code: 'GONE' });

    const readerToken = String(req.body?.reader_token || '');
    if (!READER_TOKEN_RE.test(readerToken)) return res.status(400).json({ error_code: 'NO_READER_TOKEN' });
    const rating = parseInt(req.body?.rating, 10);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error_code: 'BAD_RATING' });

    let body = req.body?.body != null ? String(req.body.body).trim() : null;
    if (body && body.length > BODY_MAX) return res.status(400).json({ error_code: 'TOO_LONG' });
    if (!body) body = null;
    let readerName = req.body?.reader_name != null ? String(req.body.reader_name).trim().slice(0, READER_NAME_MAX) : null;
    if (!readerName) readerName = null;

    const ip = req.ip || req.connection?.remoteAddress || '';
    try {
      shareLinks.upsertFeedback(token, { readerToken, readerName, rating, body, ipHash: rateLimit.hashIp(ip) });
    } catch (e) {
      logger.warn(`[share/feedback] upsert fehlgeschlagen: ${e.message}`);
      return res.status(500).json({ error_code: 'ERR' });
    }
    res.json({ ok: true });
  });

  // ── Public: eigenes Fazit dieses Lesers (Prefill) ──────────────────────────
  router.get('/:token/feedback/mine', (req, res) => {
    const token = String(req.params.token || '');
    if (!TOKEN_RE.test(token)) return res.status(404).json({ error_code: 'NOT_FOUND' });
    const readerToken = String(req.query?.rt || '');
    if (!READER_TOKEN_RE.test(readerToken)) return res.set('Cache-Control', 'no-store').json({ feedback: null });
    let feedback = null;
    try { feedback = shareLinks.getFeedbackByReader(token, readerToken) || null; } catch { /* non-fatal */ }
    res.set('Cache-Control', 'no-store').json({ feedback });
  });

  // ── Public: Kommentar abgeben ──────────────────────────────────────────────
  router.post('/:token/comment', commentBody, (req, res) => {
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    const wantsJson = ct.startsWith('application/json');
    const respond = (status, errorCode, extra) => {
      if (wantsJson) return res.status(status).json({ error_code: errorCode, ...(extra || {}) });
      const flag = errorCode === 'BODY_REQUIRED' ? 'empty'
                : errorCode === 'BODY_TOO_LONG' ? 'long'
                : errorCode === 'NAME_TOO_LONG' ? 'long'
                : errorCode === 'RATE_LIMITED'  ? 'rate'
                : errorCode === 'GONE'          ? 'gone'
                : errorCode === 'NOT_FOUND'     ? 'gone'
                : 'err';
      res.redirect(303, `/share/${encodeURIComponent(token)}?cmt=${flag}`);
    };

    const token = String(req.params.token || '');
    if (!TOKEN_RE.test(token)) return respond(404, 'NOT_FOUND');
    const link = shareLinks.getShareLinkByToken(token);
    if (!link) return respond(404, 'NOT_FOUND');
    setContext({ book: link.book_id });
    if (isExpired(link)) return respond(410, 'GONE');

    const body = String((req.body?.body || '')).trim();
    const readerName = String((req.body?.reader_name || '')).trim();
    const readerEmailRaw = String((req.body?.reader_email || '')).trim();
    const hp = String((req.body?._hp || '')).trim();
    if (hp) {
      logger.warn(`[share/comment] honeypot triggered token=${token.slice(0, 8)}`);
      return respond(400, 'INVALID');
    }
    if (!body) return respond(400, 'BODY_REQUIRED');
    if (body.length > BODY_MAX) return respond(400, 'BODY_TOO_LONG');
    if (readerName.length > READER_NAME_MAX) return respond(400, 'NAME_TOO_LONG');
    // Mail optional: leer = keine; gesetzt = formal valide + Längenlimit.
    if (readerEmailRaw && (readerEmailRaw.length > READER_EMAIL_MAX || !READER_EMAIL_RE.test(readerEmailRaw))) {
      return respond(400, 'INVALID_EMAIL');
    }
    const readerEmail = readerEmailRaw || null;

    // Optionale Anker-/Thread-/Identitaets-Felder (nur JSON-Pfad; No-JS-Form
    // schickt sie nicht → allgemeine Anmerkung). Defensiv validiert.
    const readerTokenRaw = String((req.body?.reader_token || '')).trim();
    const readerToken = READER_TOKEN_RE.test(readerTokenRaw) ? readerTokenRaw : null;

    let parentId = null;
    let anchorBid = null;
    let anchorQuote = null;
    let anchorStart = null;
    let anchorEnd = null;

    if (req.body?.parent_id != null && req.body.parent_id !== '') {
      const target = parseInt(req.body.parent_id, 10);
      if (!Number.isInteger(target)) return respond(400, 'INVALID_PARENT');
      // Antwort auf einen beliebigen Kommentar DIESES Links — der Thread bleibt
      // flach (eine Ebene): eine Antwort auf eine Antwort hängt unter denselben
      // Root. resolveThreadRootId normalisiert auf die Root-ID.
      parentId = shareLinks.resolveThreadRootId(target, token);
      if (!parentId) return respond(400, 'INVALID_PARENT');
      // Anker wird vom Root geerbt — eingehende Anker-Felder bei Replies ignoriert.
    } else if (req.body?.anchor_bid != null && req.body.anchor_bid !== '') {
      anchorBid = String(req.body.anchor_bid).trim().toLowerCase();
      if (!ANCHOR_BID_RE.test(anchorBid)) return respond(400, 'INVALID_ANCHOR');
      anchorQuote = String(req.body?.anchor_quote || '').slice(0, ANCHOR_QUOTE_MAX);
      const s = parseInt(req.body?.anchor_start, 10);
      const e = parseInt(req.body?.anchor_end, 10);
      if (Number.isInteger(s) && Number.isInteger(e) && s >= 0 && e > s) {
        anchorStart = s;
        anchorEnd = e;
      }
    }

    const ip = req.ip || req.connection?.remoteAddress || '';
    const ipHash = rateLimit.hashIp(ip);
    const rl = rateLimit.check(token, ipHash);
    if (!rl.allowed) {
      logger.warn(`[share/comment] rate-limit token=${token.slice(0, 8)} ipHash=${ipHash}`);
      res.setHeader('Retry-After', String(rl.retryAfterSec));
      return respond(429, 'RATE_LIMITED', { retry_after: rl.retryAfterSec });
    }

    try {
      const comment = shareLinks.insertComment({
        token,
        readerName: readerName || null,
        readerEmail,
        readerToken,
        body,
        ipHash,
        parentId,
        anchorBid,
        anchorQuote,
        anchorStart,
        anchorEnd,
      });
      logger.info(`[share/comment] new token=${token.slice(0, 8)} book=${link.book_id} bytes=${body.length} anchored=${!!anchorBid} reply=${!!parentId}`);
      // Owner per Mail benachrichtigen (fire-and-forget, gedrosselt, opt-out).
      notify.maybeNotifyShareComment(link, comment).catch(() => {});
      if (wantsJson) {
        return res.json({ ok: true, comment: serializeCommentForReader(comment, readerToken) });
      }
      return res.redirect(303, `/share/${encodeURIComponent(token)}?cmt=ok`);
    } catch (e) {
      logger.error('[share/comment] DB-Fehler: ' + e.message);
      respond(500, 'DB_ERROR');
    }
  });

  // ── Public: Threads (verankerte + allgemeine Kommentare) als JSON ──────────
  // Reader-Frontend hydriert daraus Inline-Highlights + Thread-Popover. `rt` =
  // Reader-Token des Browsers (optional, fuer Self-Erkennung). no-store.
  router.get('/:token/threads', (req, res) => {
    const token = String(req.params.token || '');
    if (!TOKEN_RE.test(token)) return res.status(404).json({ error_code: 'NOT_FOUND' });
    const link = shareLinks.getShareLinkByToken(token);
    if (!link) return res.status(404).json({ error_code: 'NOT_FOUND' });
    if (isExpired(link)) return res.status(410).json({ error_code: 'GONE' });
    const rtRaw = String(req.query?.rt || '').trim();
    const readerToken = READER_TOKEN_RE.test(rtRaw) ? rtRaw : null;
    try {
      const rows = shareLinks.listCommentsByToken(token, { order: 'asc' });
      res.set('Cache-Control', 'no-store');
      res.json({ comments: rows.map(r => serializeCommentForReader(r, readerToken)) });
    } catch (e) {
      logger.error('[share/threads GET] ' + e.message);
      res.status(500).json({ error_code: 'DB_ERROR' });
    }
  });

  // ── Public: Reader-Namen nachträglich ändern ───────────────────────────────
  // Setzt der Leser oben rechts einen neuen (oder leeren) Namen, ziehen ALLE
  // seiner bisherigen Kommentare unter diesem Link auf den neuen Namen nach —
  // Zuordnung über sein Browser-reader_token (kein Auth, Self-Identität). Leerer
  // Name → anonymisiert (reader_name = NULL).
  router.post('/:token/reader-name', commentBody, (req, res) => {
    const token = String(req.params.token || '');
    if (!TOKEN_RE.test(token)) return res.status(404).json({ error_code: 'NOT_FOUND' });
    const link = shareLinks.getShareLinkByToken(token);
    if (!link) return res.status(404).json({ error_code: 'NOT_FOUND' });
    setContext({ book: link.book_id });
    if (isExpired(link)) return res.status(410).json({ error_code: 'GONE' });

    const rtRaw = String(req.body?.reader_token || '').trim();
    if (!READER_TOKEN_RE.test(rtRaw)) return res.status(400).json({ error_code: 'INVALID_TOKEN' });
    const newName = String(req.body?.reader_name || '').trim();
    if (newName.length > READER_NAME_MAX) return res.status(400).json({ error_code: 'NAME_TOO_LONG' });
    const newEmailRaw = String(req.body?.reader_email || '').trim();
    if (newEmailRaw && (newEmailRaw.length > READER_EMAIL_MAX || !READER_EMAIL_RE.test(newEmailRaw))) {
      return res.status(400).json({ error_code: 'INVALID_EMAIL' });
    }

    try {
      const changed = shareLinks.updateReaderIdentity(token, rtRaw, newName || null, newEmailRaw || null);
      res.json({ ok: true, updated: changed });
    } catch (e) {
      logger.error('[share/reader-identity POST] ' + e.message);
      res.status(500).json({ error_code: 'DB_ERROR' });
    }
  });

  // ── Public: eigenen Kommentar als erledigt markieren / wieder öffnen ───────
  // Leser-Self-Service über sein Browser-reader_token (kein Auth). Nur eigene
  // Root-Threads; teilt die resolved_at-Spalte mit dem Owner-Resolve.
  router.patch('/:token/comment/:id/resolve', commentBody, (req, res) => {
    const token = String(req.params.token || '');
    if (!TOKEN_RE.test(token)) return res.status(404).json({ error_code: 'NOT_FOUND' });
    const link = shareLinks.getShareLinkByToken(token);
    if (!link) return res.status(404).json({ error_code: 'NOT_FOUND' });
    setContext({ book: link.book_id });
    if (isExpired(link)) return res.status(410).json({ error_code: 'GONE' });

    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error_code: 'INVALID_ID' });
    const rtRaw = String(req.body?.reader_token || '').trim();
    if (!READER_TOKEN_RE.test(rtRaw)) return res.status(400).json({ error_code: 'INVALID_TOKEN' });
    const resolved = req.body?.resolved !== false;

    try {
      const ok = shareLinks.setReaderCommentResolved(id, token, rtRaw, resolved);
      if (!ok) return res.status(404).json({ error_code: 'NOT_FOUND' });
      res.json({ ok: true, resolved });
    } catch (e) {
      logger.error('[share/comment resolve PATCH] ' + e.message);
      res.status(500).json({ error_code: 'DB_ERROR' });
    }
  });

  // ── Public: eigenen Kommentar bearbeiten ───────────────────────────────────
  // Self-Service via reader_token (kein Auth). Nur eigene Reader-Beiträge
  // (author_email IS NULL); setzt edited_at als „bearbeitet"-Marker.
  router.patch('/:token/comment/:id', commentBody, (req, res) => {
    const token = String(req.params.token || '');
    if (!TOKEN_RE.test(token)) return res.status(404).json({ error_code: 'NOT_FOUND' });
    const link = shareLinks.getShareLinkByToken(token);
    if (!link) return res.status(404).json({ error_code: 'NOT_FOUND' });
    setContext({ book: link.book_id });
    if (isExpired(link)) return res.status(410).json({ error_code: 'GONE' });

    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error_code: 'INVALID_ID' });
    const rtRaw = String(req.body?.reader_token || '').trim();
    if (!READER_TOKEN_RE.test(rtRaw)) return res.status(400).json({ error_code: 'INVALID_TOKEN' });
    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(400).json({ error_code: 'BODY_REQUIRED' });
    if (body.length > BODY_MAX) return res.status(400).json({ error_code: 'BODY_TOO_LONG' });

    try {
      const ok = shareLinks.editReaderComment(id, token, rtRaw, body);
      if (!ok) return res.status(404).json({ error_code: 'NOT_FOUND' });
      res.json({ ok: true, comment: serializeCommentForReader(shareLinks.getCommentById(id), rtRaw) });
    } catch (e) {
      logger.error('[share/comment edit PATCH] ' + e.message);
      res.status(500).json({ error_code: 'DB_ERROR' });
    }
  });

  // ── Public: eigenen Kommentar löschen ──────────────────────────────────────
  // Self-Service via reader_token. Hart löschen nur, wenn der Beitrag KEINE
  // Antworten hat — sonst würde der Owner-Reply per CASCADE still verschwinden
  // (→ 409 HAS_REPLIES, Frontend bietet dann nur „Erledigt" an).
  router.delete('/:token/comment/:id', commentBody, (req, res) => {
    const token = String(req.params.token || '');
    if (!TOKEN_RE.test(token)) return res.status(404).json({ error_code: 'NOT_FOUND' });
    const link = shareLinks.getShareLinkByToken(token);
    if (!link) return res.status(404).json({ error_code: 'NOT_FOUND' });
    setContext({ book: link.book_id });
    if (isExpired(link)) return res.status(410).json({ error_code: 'GONE' });

    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error_code: 'INVALID_ID' });
    const rtRaw = String(req.body?.reader_token || '').trim();
    if (!READER_TOKEN_RE.test(rtRaw)) return res.status(400).json({ error_code: 'INVALID_TOKEN' });

    try {
      const own = shareLinks.getReaderComment(id, token, rtRaw);
      if (!own) return res.status(404).json({ error_code: 'NOT_FOUND' });
      if (shareLinks.commentHasReplies(id)) return res.status(409).json({ error_code: 'HAS_REPLIES' });
      const ok = shareLinks.deleteReaderComment(id, token, rtRaw);
      if (!ok) return res.status(404).json({ error_code: 'NOT_FOUND' });
      logger.info(`[share/comment DELETE] token=${token.slice(0, 8)} book=${link.book_id} id=${id}`);
      res.json({ ok: true });
    } catch (e) {
      logger.error('[share/comment DELETE] ' + e.message);
      res.status(500).json({ error_code: 'DB_ERROR' });
    }
  });
}

module.exports = { register };
