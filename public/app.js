const CLAUDE_API = '/claude';

const SYSTEM_LEKTORAT = `Du bist ein deutschsprachiger Lektor für literarische Texte aus der Schweiz. Helvetismen (grösseres, Strasse, gemäss usw.) sind korrekt und werden nicht bemängelt. Antworte ausschliesslich mit einem JSON-Objekt – kein Markdown, kein Text davor oder danach.`;

const SYSTEM_BUCHBEWERTUNG = `Du bist ein erfahrener Literaturkritiker und Lektor für deutschsprachige Texte aus der Schweiz. Helvetismen (grösseres, Strasse, gemäss usw.) sind korrekt und werden nicht bemängelt. Antworte ausschliesslich mit einem JSON-Objekt – kein Markdown, kein Text davor oder danach.`;
const SYSTEM_KAPITELANALYSE = `Du bist ein erfahrener Literaturkritiker und Lektor für deutschsprachige Texte aus der Schweiz. Helvetismen sind korrekt und werden nicht bemängelt. Antworte ausschliesslich mit einem kompakten JSON-Objekt – kein Markdown, kein Text davor oder danach.`;

const SYSTEM_FIGUREN = `Du bist ein Literaturanalytiker für deutschsprachige Texte. Du extrahierst und analysierst Figuren/Charaktere aus literarischen Werken präzise und strukturiert. Antworte ausschliesslich mit einem JSON-Objekt – kein Markdown, kein Text davor oder danach.`;

function escHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function htmlToText(html) {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d.textContent || d.innerText || '';
}

document.addEventListener('alpine:init', () => {
  Alpine.data('lektorat', () => ({
    authToken: '',
    bookstackUrl: '',
    claudeModel: 'claude-sonnet-4-6',
    claudeMaxTokens: 64000,
    books: [],
    selectedBookId: '',
    pages: [],
    tree: [],
    pageSearch: '',
    currentPage: null,
    originalHtml: null,
    correctedHtml: null,
    hasErrors: false,
    showDiff: false,
    diffHtml: '',
    showBookCard: false,
    showEditorCard: false,
    showBookReviewCard: false,
    status: '',
    statusSpinner: false,
    _statusTimer: null,
    analysisOut: '',
    bookReviewOut: '',
    bookReviewStatus: '',
    checkLoading: false,
    bookReviewLoading: false,
    bookReviewProgress: 0,
    batchLoading: false,
    batchProgress: 0,
    batchStatus: '',
    lastCheckId: null,
    pageHistory: [],
    selectedHistoryId: null,
    bookReviewHistory: [],
    selectedBookReviewId: null,
    tokEsts: {},
    _tokenEstGen: 0,
    showFiguresCard: false,
    figuren: [],
    figurenLoading: false,
    figurenProgress: 0,
    figurenStatus: '',
    selectedFigurId: null,
    _figurenNetwork: null,

    get statusHtml() {
      if (!this.status) return '';
      return this.statusSpinner
        ? `<span class="spinner"></span>${this.status}`
        : this.status;
    },

    get selectedBookName() {
      const book = this.books.find(b => String(b.id) === String(this.selectedBookId));
      return book?.name || '';
    },

    get filteredTree() {
      if (!this.pageSearch) return this.tree;
      const q = this.pageSearch.toLowerCase();
      return this.tree.map(item => {
        if (item.type === 'chapter') {
          const pages = item.pages.filter(p => p.name.toLowerCase().includes(q));
          if (!pages.length) return null;
          return { ...item, pages, open: true };
        }
        return item.page?.name.toLowerCase().includes(q) ? item : null;
      }).filter(Boolean);
    },

    setStatus(msg, spinner = false, duration = 0) {
      this.status = msg;
      this.statusSpinner = spinner;
      clearTimeout(this._statusTimer);
      if (duration > 0 && msg) {
        this._statusTimer = setTimeout(() => {
          this.status = '';
          this.statusSpinner = false;
        }, duration);
      }
    },

    formatDate(iso) {
      if (!iso) return '';
      return new Date(iso).toLocaleString('de-CH', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
    },

    setReviewStatus(msg, spinner = false) {
      this.bookReviewStatus = spinner
        ? `<span class="spinner"></span>${msg}`
        : msg;
    },

    cutAtSentence(text, maxLen) {
      if (text.length <= maxLen) return text;
      const sub = text.slice(0, maxLen);
      const m = sub.match(/^([\s\S]*[.!?])\s/);
      if (m) return m[1] + ' […]';
      const wi = sub.lastIndexOf(' ');
      return (wi > 0 ? sub.slice(0, wi) : sub) + ' […]';
    },

    computeDiff(originalHtml, correctedHtml) {
      const aText = htmlToText(originalHtml);
      const bText = htmlToText(correctedHtml);
      if (aText === bText) {
        return '<div class="diff-unchanged">Keine Textänderungen.</div>';
      }
      const tok = s => s.match(/[^\s]+|\s+/g) || [];
      const a = tok(aText);
      const b = tok(bText);
      if (a.length * b.length > 400000) {
        return `<div class="muted-msg">Text zu lang für Diff-Ansicht (${Math.round(a.length * b.length / 1000)}k Operationen).</div>`;
      }
      const m = a.length, n = b.length;
      const dp = [];
      for (let i = 0; i <= m; i++) dp[i] = new Uint32Array(n + 1);
      for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
          dp[i][j] = a[i-1] === b[j-1]
            ? dp[i-1][j-1] + 1
            : Math.max(dp[i-1][j], dp[i][j-1]);
        }
      }
      const ops = [];
      let i = m, j = n;
      while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && a[i-1] === b[j-1]) {
          ops.push({ t: '=', s: a[i-1] }); i--; j--;
        } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
          ops.push({ t: '+', s: b[j-1] }); j--;
        } else {
          ops.push({ t: '-', s: a[i-1] }); i--;
        }
      }
      ops.reverse();
      let html = '';
      for (const op of ops) {
        const s = escHtml(op.s);
        if (op.t === '=') html += s;
        else if (op.t === '+') html += `<ins>${s}</ins>`;
        else html += `<del>${s}</del>`;
      }
      return `<div class="diff-view">${html}</div>`;
    },

    async bsGet(path) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      try {
        const r = await fetch('/api/' + path, {
          headers: { Authorization: this.authToken },
          signal: ctrl.signal,
        });
        if (!r.ok) throw new Error('BookStack API Fehler ' + r.status);
        return r.json();
      } finally {
        clearTimeout(timer);
      }
    },

    async bsGetAll(path) {
      const COUNT = 500;
      let offset = 0, all = [];
      while (true) {
        const sep = path.includes('?') ? '&' : '?';
        const data = await this.bsGet(`${path}${sep}count=${COUNT}&offset=${offset}`);
        all = all.concat(data.data);
        if (all.length >= data.total) break;
        offset += COUNT;
      }
      return all;
    },

    async bsPut(path, body) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(new Error('Timeout: BookStack hat nicht innerhalb von 90 Sekunden geantwortet')), 90000);
      try {
        const r = await fetch('/api/' + path, {
          method: 'PUT',
          headers: { Authorization: this.authToken, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        if (!r.ok) {
          let detail = '';
          try { const e = await r.json(); detail = e.message || e.error || ''; } catch (_) {}
          throw new Error(`BookStack API Fehler ${r.status}${detail ? ': ' + detail : ''}`);
        }
        return r.json();
      } catch (e) {
        if (e.name === 'AbortError') {
          throw new Error(ctrl.signal.reason?.message || 'Timeout: Anfrage wurde abgebrochen');
        }
        throw e;
      } finally {
        clearTimeout(timer);
      }
    },

    _applyCorrections(html, fehler) {
      let result = html;
      for (const f of fehler) {
        if (!f.original || !f.korrektur || f.original === f.korrektur) continue;
        const idx = result.indexOf(f.original);
        if (idx !== -1) {
          result = result.slice(0, idx) + f.korrektur + result.slice(idx + f.original.length);
        }
      }
      return result;
    },

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

    _buildLektoratPrompt(text, html) {
      return `Analysiere diesen deutschsprachigen Text auf Rechtschreibfehler, Grammatikfehler und stilistische Auffälligkeiten.

Antworte mit diesem JSON-Schema:
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
${text}

Original-HTML (für korrekturen_html):
${html}`;
    },

    async init() {
      try {
        const cfg = await fetch('/config').then(r => r.json());
        if (cfg.tokenId && cfg.tokenPw) {
          this.authToken = 'Token ' + cfg.tokenId + ':' + cfg.tokenPw;
          this.bookstackUrl = cfg.bookstackUrl || '';
          if (cfg.claudeModel) this.claudeModel = cfg.claudeModel;
          if (cfg.claudeMaxTokens) this.claudeMaxTokens = cfg.claudeMaxTokens;
          await this.loadBooks();
        } else {
          this.setStatus('Keine Zugangsdaten in .env konfiguriert.');
        }
      } catch {
        this.setStatus('Fehler beim Laden der Konfiguration.');
      }
    },

    async loadBooks() {
      try {
        this.setStatus('Verbinde mit BookStack…', true);
        this.books = await this.bsGetAll('books');
        this.selectedBookId = String(this.books[0]?.id || '');
        this.showBookCard = true;
        this.setStatus(this.books.length + ' Buch/Bücher gefunden.', false, 4000);
        if (this.books.length === 1) await this.loadPages();
      } catch (e) {
        console.error('[loadBooks]', e);
        this.setStatus('Fehler: ' + e.message);
      }
    },

    async loadTokenEstimates(gen) {
      const BATCH = 5;
      const pages = [...this.pages];
      for (let i = 0; i < pages.length; i += BATCH) {
        if (this._tokenEstGen !== gen) return;
        const batch = pages.slice(i, i + BATCH);
        await Promise.allSettled(batch.map(async p => {
          try {
            const pd = await this.bsGet('pages/' + p.id);
            const text = htmlToText(pd.html || '');
            this.tokEsts[p.id] = Math.round(text.length / 4);
          } catch { /* ignore */ }
        }));
      }
    },

    async loadPages() {
      const bookId = this.selectedBookId;
      try {
        this.setStatus('Lade Seiten…', true);
        this.pageSearch = '';
        this.tokEsts = {};
        this._tokenEstGen++;
        const [chapters, pages] = await Promise.all([
          this.bsGetAll('chapters?book_id=' + bookId),
          this.bsGetAll('pages?book_id=' + bookId),
        ]);

        const sortedChapters = [...chapters].sort((a, b) => a.priority - b.priority);
        const chMap = Object.fromEntries(sortedChapters.map(c => [c.id, c.name]));
        const chapterOrder = Object.fromEntries(sortedChapters.map((c, i) => [c.id, i]));

        this.pages = [...pages]
          .sort((a, b) => {
            const aO = a.chapter_id ? (chapterOrder[a.chapter_id] ?? 999) : -1;
            const bO = b.chapter_id ? (chapterOrder[b.chapter_id] ?? 999) : -1;
            if (aO !== bO) return aO - bO;
            return a.priority - b.priority;
          })
          .map(p => ({
            ...p,
            chapterName: p.chapter_id ? (chMap[p.chapter_id] || 'Kapitel') : null,
            url: this.bookstackUrl && p.book_slug && p.slug
              ? `${this.bookstackUrl}/books/${p.book_slug}/page/${p.slug}`
              : null,
          }));

        this.tree = [
          ...sortedChapters.map(c => ({
            type: 'chapter',
            id: c.id,
            name: c.name,
            priority: c.priority,
            open: true,
            pages: this.pages.filter(p => p.chapter_id === c.id),
          })),
          ...this.pages.filter(p => !p.chapter_id).map(p => ({
            type: 'page',
            id: p.id,
            name: p.name,
            priority: p.priority,
            page: p,
          })),
        ].sort((a, b) => a.priority - b.priority);

        this.setStatus('');
        await Promise.all([
          this.loadBookReviewHistory(bookId),
          this.loadFiguren(bookId),
        ]);
        this.loadTokenEstimates(this._tokenEstGen); // Hintergrund, kein await
      } catch (e) {
        console.error('[loadPages]', e);
        this.setStatus('Fehler: ' + e.message);
      }
    },

    async loadPageHistory(pageId) {
      try {
        this.pageHistory = await fetch('/history/page/' + pageId).then(r => r.json());
      } catch (e) {
        console.error('[loadPageHistory]', e);
      }
    },

    async loadBookReviewHistory(bookId) {
      try {
        this.bookReviewHistory = await fetch('/history/review/' + bookId).then(r => r.json());
      } catch (e) {
        console.error('[loadBookReviewHistory]', e);
      }
    },

    async selectPage(p) {
      this.currentPage = p;
      this.originalHtml = null;
      this.correctedHtml = null;
      this.hasErrors = false;
      this.showDiff = false;
      this.diffHtml = '';
      this.lastCheckId = null;
      this.pageHistory = [];
      this.selectedHistoryId = null;
      this.showEditorCard = true;
      this.analysisOut = '<span class="muted-msg"><span class="spinner"></span>Vorschau lädt…</span>';
      this.setStatus('');
      try {
        const pageData = await this.bsGet('pages/' + p.id);
        const text = htmlToText(pageData.html).trim();
        const preview = text.length > 600 ? text.slice(0, 600) + ' …' : text;
        this.analysisOut = preview
          ? `<div class="preview-text">${escHtml(preview)}</div><div class="preview-hint">Vorschau · «Prüfen» starten für Lektorat</div>`
          : '<span class="muted-msg">Seite ist leer. «Prüfen» starten.</span>';
      } catch (e) {
        console.error('[selectPage preview]', e);
        this.analysisOut = '<span class="muted-msg">Seite ausgewählt. «Prüfen» starten.</span>';
      }
      await this.loadPageHistory(p.id);
    },

    resetView() {
      this.currentPage = null;
      this.originalHtml = null;
      this.correctedHtml = null;
      this.hasErrors = false;
      this.showDiff = false;
      this.diffHtml = '';
      this.showEditorCard = false;
      this.showBookReviewCard = false;
      this.analysisOut = '';
      this.bookReviewOut = '';
      this.status = '';
      this.statusSpinner = false;
      this.bookReviewStatus = '';
      this.lastCheckId = null;
      this.pageHistory = [];
      this.selectedHistoryId = null;
      this.tree.forEach(c => { if (c.type === 'chapter') c.open = false; });
      this.showFiguresCard = false;
      this.figurenStatus = '';
      this.figurenProgress = 0;
      this.selectedFigurId = null;
      if (this._figurenNetwork) { this._figurenNetwork.destroy(); this._figurenNetwork = null; }
    },

    async runCheck() {
      if (!this.currentPage) return;
      this.checkLoading = true;
      this.originalHtml = null;
      this.correctedHtml = null;
      this.hasErrors = false;
      this.showDiff = false;
      this.diffHtml = '';
      this.analysisOut = '';
      this.setStatus('Lade Seiteninhalt…', true);

      try {
        const pageData = await this.bsGet('pages/' + this.currentPage.id);
        const html = pageData.html;
        const text = htmlToText(html);
        this.originalHtml = html;

        this.setStatus('Claude analysiert… (0 Zeichen)', true);

        const result = await this.callClaude(
          this._buildLektoratPrompt(text, html),
          SYSTEM_LEKTORAT,
          (chars) => this.setStatus(`Claude analysiert… (${chars} Zeichen)`, true)
        );

        const claudeHtml = result.korrekturen_html;
        if (claudeHtml && claudeHtml.length >= html.length * 0.7) {
          this.correctedHtml = claudeHtml;
        } else {
          // Claude hat das HTML weggelassen oder abgeschnitten → Korrekturen manuell einsetzen
          const fixable = (result.fehler || []).filter(f => f.typ !== 'stil');
          this.correctedHtml = fixable.length > 0 ? this._applyCorrections(html, fixable) : html;
          if (claudeHtml) console.warn('[runCheck] korrekturen_html zu kurz, Korrekturen manuell angewandt');
        }

        const fehler = result.fehler || [];
        const errors = fehler.filter(f => f.typ === 'rechtschreibung' || f.typ === 'grammatik');
        const styles = fehler.filter(f => f.typ === 'stil');
        this.hasErrors = errors.length > 0;

        let out = '';
        if (errors.length === 0) {
          out += `<div class="finding ok"><span class="badge badge-ok">✓ Fehlerfrei</span> &nbsp;Keine Rechtschreib- oder Grammatikfehler gefunden.</div>`;
        } else {
          out += `<div class="section-heading">${errors.length} Fehler gefunden</div>`;
          errors.forEach(f => {
            out += `<div class="finding error">
              <span class="badge badge-err">${f.typ}</span>
              &nbsp;<del>${escHtml(f.original)}</del> → <ins>${escHtml(f.korrektur)}</ins>
              <div class="finding-context">«${escHtml(f.kontext)}»</div>
              <div class="finding-explanation">${escHtml(f.erklaerung)}</div>
            </div>`;
          });
        }
        if (styles.length > 0) {
          out += `<div class="section-heading-top">Stilanmerkungen</div>`;
          styles.forEach(f => {
            out += `<div class="finding style">
              <span class="badge badge-warn">Stil</span>
              &nbsp;${escHtml(f.erklaerung)}
              ${f.original ? `<div class="finding-context">«${escHtml(f.original)}»</div>` : ''}
            </div>`;
          });
        }
        if (result.stilanalyse) {
          out += `<div class="stilbox"><div class="stilbox-title">Stilanalyse</div>${escHtml(result.stilanalyse)}</div>`;
        }
        if (result.fazit) {
          out += `<div class="fazit">${escHtml(result.fazit)}</div>`;
        }
        this.analysisOut = out;

        try {
          const hr = await fetch('/history/check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              page_id: this.currentPage.id,
              page_name: this.currentPage.name,
              book_id: this.currentPage.book_id || null,
              error_count: fehler.length,
              errors_json: fehler,
              stilanalyse: result.stilanalyse || null,
              fazit: result.fazit || null,
              model: this.claudeModel,
            }),
          });
          const hd = await hr.json();
          this.lastCheckId = hd.id;
          await this.loadPageHistory(this.currentPage.id);
        } catch (e) { console.error('[history check]', e); }

        this.setStatus('Analyse abgeschlossen.', false, 5000);
      } catch (e) {
        console.error('[runCheck]', e);
        this.analysisOut = `<span class="error-msg">Fehler: ${escHtml(e.message)}</span>`;
        this.setStatus('');
      }
      this.checkLoading = false;
    },

    async saveCorrections() {
      if (!this.correctedHtml || !this.currentPage) return;
      if (this.originalHtml && this.correctedHtml.length < this.originalHtml.length * 0.5) {
        this.setStatus('Fehler: Korrigiertes HTML wirkt unvollständig – Speichern abgebrochen.');
        console.error('[saveCorrections] correctedHtml zu kurz:', this.correctedHtml.length, 'vs original:', this.originalHtml.length);
        return;
      }
      this.setStatus('Speichere in BookStack…', true);
      try {
        await this.bsPut('pages/' + this.currentPage.id, {
          html: this.correctedHtml,
          name: this.currentPage.name,
        });
        if (this.lastCheckId) {
          try {
            await fetch('/history/check/' + this.lastCheckId + '/saved', { method: 'PATCH' });
            await this.loadPageHistory(this.currentPage.id);
          } catch (e) { console.error('[history saved]', e); }
        }
        this.setStatus('✓ Korrekturen gespeichert.', false, 5000);
        this.correctedHtml = null;
        this.hasErrors = false;
        this.showDiff = false;
        this.diffHtml = '';
      } catch (e) {
        console.error('[saveCorrections]', e);
        this.setStatus('Fehler: ' + e.message);
      }
    },

    toggleDiff() {
      if (!this.correctedHtml || !this.originalHtml) return;
      this.showDiff = !this.showDiff;
      if (this.showDiff && !this.diffHtml) {
        this.diffHtml = this.computeDiff(this.originalHtml, this.correctedHtml);
      }
    },

    async batchCheck() {
      if (!this.pages.length || this.batchLoading) return;
      if (!confirm(`Alle ${this.pages.length} Seiten prüfen und Ergebnisse in der History speichern?\n\nDies kann bei grossen Büchern mehrere Minuten dauern.`)) return;
      this.batchLoading = true;
      this.batchProgress = 0;
      this.batchStatus = '';
      let done = 0, totalErrors = 0;
      const pages = [...this.pages];

      for (let i = 0; i < pages.length; i++) {
        const p = pages[i];
        this.batchProgress = Math.round((i / pages.length) * 100);
        this.batchStatus = `${i + 1}/${pages.length}: ${p.name}`;

        try {
          const pageData = await this.bsGet('pages/' + p.id);
          const html = pageData.html;
          const text = htmlToText(html).trim();
          if (!text) continue;

          const result = await this.callClaude(this._buildLektoratPrompt(text, html), SYSTEM_LEKTORAT);
          const fehler = result.fehler || [];
          totalErrors += fehler.filter(f => f.typ !== 'stil').length;

          await fetch('/history/check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              page_id: p.id,
              page_name: p.name,
              book_id: p.book_id || null,
              error_count: fehler.length,
              errors_json: fehler,
              stilanalyse: result.stilanalyse || null,
              fazit: result.fazit || null,
              model: this.claudeModel,
            }),
          });
          done++;
        } catch (e) {
          console.error('[batchCheck page]', p.id, e);
        }
      }

      this.batchProgress = 100;
      this.batchStatus = `Fertig: ${done}/${pages.length} Seiten geprüft, ${totalErrors} Rechtschreib-/Grammatikfehler.`;
      this.batchLoading = false;

      if (this.currentPage) await this.loadPageHistory(this.currentPage.id);
    },

    async runBookReview() {
      const bookId = this.selectedBookId;
      const bookName = this.selectedBookName;
      this.bookReviewLoading = true;
      this.bookReviewProgress = 0;
      this.showBookReviewCard = true;
      this.bookReviewOut = '';

      try {
        this.setReviewStatus('Lade Seiten…', true);
        const [chaptersData, pages] = await Promise.all([
          this.bsGetAll('chapters?book_id=' + bookId),
          this.bsGetAll('pages?book_id=' + bookId),
        ]);

        const chMap = Object.fromEntries(chaptersData.map(c => [c.id, c.name]));

        if (!pages.length) {
          this.setReviewStatus('Keine Seiten im Buch gefunden.');
          this.bookReviewLoading = false;
          return;
        }

        this.setReviewStatus(`Lese ${pages.length} Seiten…`, true);

        // Alle Seiten vollständig laden (keine Kürzung hier)
        const BATCH = 5;
        const pageContents = [];
        for (let i = 0; i < pages.length; i += BATCH) {
          this.bookReviewProgress = Math.round((i / pages.length) * 60);
          const batch = pages.slice(i, i + BATCH);
          const results = await Promise.allSettled(batch.map(async p => {
            const pd = await this.bsGet('pages/' + p.id);
            const text = htmlToText(pd.html).trim();
            if (text.length < 50) return null;
            return {
              title: p.name,
              chapter_id: p.chapter_id || null,
              chapter: p.chapter_id ? (chMap[p.chapter_id] || 'Kapitel') : null,
              text,
            };
          }));
          for (const r of results) {
            if (r.status === 'fulfilled' && r.value) pageContents.push(r.value);
          }
        }

        this.bookReviewProgress = 65;

        const totalChars = pageContents.reduce((s, p) => s + p.text.length, 0);
        const SINGLE_PASS_LIMIT = 60000;

        let r;

        if (totalChars <= SINGLE_PASS_LIMIT) {
          // Single-pass: alle Seiten direkt an Claude
          this.setReviewStatus('Claude analysiert das Buch…', true);

          const bookText = pageContents.map(p =>
            `### ${p.chapter ? '[' + p.chapter + '] ' : ''}${p.title}\n${p.text}`
          ).join('\n\n---\n\n');

          const prompt = `Bewerte das folgende Buch «${bookName}» kritisch und umfassend. Analysiere:
- Struktur und Aufbau (Kapitel, Übergänge, Logik)
- Sprachstil und Konsistenz über alle Seiten hinweg
- Stärken des Texts
- Schwächen und Verbesserungspotenzial
- Konkrete Empfehlungen für den Autor

Antworte mit diesem JSON-Schema:
{
  "gesamtnote": "Zahl von 1 (sehr schwach) bis 5 (ausgezeichnet)",
  "gesamtnote_begruendung": "Ein Satz warum diese Note",
  "zusammenfassung": "2-3 Sätze Gesamteindruck",
  "struktur": "Analyse des Aufbaus und der Struktur (3-4 Sätze)",
  "stil": "Analyse des Schreibstils und seiner Konsistenz (3-4 Sätze)",
  "staerken": ["Stärke 1", "Stärke 2", "Stärke 3"],
  "schwaechen": ["Schwäche 1", "Schwäche 2"],
  "empfehlungen": ["Empfehlung 1", "Empfehlung 2", "Empfehlung 3"],
  "fazit": "Abschliessendes Urteil in 1-2 Sätzen"
}

Buchinhalt (${pageContents.length} Seiten):

${bookText}`;

          r = await this.callClaude(prompt, SYSTEM_BUCHBEWERTUNG, (chars) => {
            this.setReviewStatus(`Claude analysiert… (${chars} Zeichen)`, true);
          });

        } else {
          // Multi-pass: Kapitel einzeln analysieren, dann synthetisieren

          // Seiten nach Kapitel gruppieren
          const groupOrder = [];
          const groups = new Map();
          for (const p of pageContents) {
            const key = p.chapter_id != null ? String(p.chapter_id) : '__ungrouped__';
            if (!groups.has(key)) {
              groupOrder.push(key);
              groups.set(key, { name: p.chapter || 'Sonstige Seiten', pages: [] });
            }
            groups.get(key).pages.push(p);
          }

          const chapterAnalyses = [];
          for (let gi = 0; gi < groupOrder.length; gi++) {
            const group = groups.get(groupOrder[gi]);
            this.bookReviewProgress = 65 + Math.round(((gi + 1) / groupOrder.length) * 25);
            this.setReviewStatus(`Analysiere ${gi + 1}/${groupOrder.length}: «${group.name}»…`, true);

            const chapterText = group.pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n');

            const chapterPrompt = `Analysiere das Kapitel «${group.name}» aus dem Buch «${bookName}».
Lies den vollständigen Kapiteltext und gib eine kompakte Analyse als JSON zurück:
{
  "themen": "Hauptthemen und Inhalte in 2-3 Sätzen",
  "stil": "Schreibstilbeobachtungen: Wortwahl, Satzbau, Ton in 2 Sätzen",
  "qualitaet": "Allgemeiner Qualitätseindruck in 1-2 Sätzen",
  "staerken": ["konkrete Stärke 1", "konkrete Stärke 2"],
  "schwaechen": ["konkrete Schwäche 1", "konkrete Schwäche 2"]
}

Kapitelinhalt (${group.pages.length} Seiten):

${chapterText}`;

            const analysis = await this.callClaude(chapterPrompt, SYSTEM_KAPITELANALYSE);
            chapterAnalyses.push({ name: group.name, pageCount: group.pages.length, ...analysis });
          }

          // Synthese aller Kapitelanalysen
          this.bookReviewProgress = 90;
          this.setReviewStatus('Claude erstellt Gesamtbewertung…', true);

          const synthesisInput = chapterAnalyses.map((ca, i) =>
            `## Kapitel ${i + 1}: ${ca.name} (${ca.pageCount} Seiten)\nThemen: ${ca.themen || '–'}\nStil: ${ca.stil || '–'}\nQualität: ${ca.qualitaet || '–'}\nStärken: ${(ca.staerken || []).join(' | ')}\nSchwächen: ${(ca.schwaechen || []).join(' | ')}`
          ).join('\n\n');

          const synthesisPrompt = `Bewerte das Buch «${bookName}» kritisch und umfassend.
Grundlage sind die Analysen aller ${chapterAnalyses.length} Kapitel (insgesamt ${pageContents.length} Seiten).

Kapitelanalysen:

${synthesisInput}

Antworte mit diesem JSON-Schema:
{
  "gesamtnote": "Zahl von 1 (sehr schwach) bis 5 (ausgezeichnet)",
  "gesamtnote_begruendung": "Ein Satz warum diese Note",
  "zusammenfassung": "2-3 Sätze Gesamteindruck",
  "struktur": "Analyse des Aufbaus und der Struktur über alle Kapitel (3-4 Sätze)",
  "stil": "Analyse des Schreibstils und seiner Konsistenz über das gesamte Buch (3-4 Sätze)",
  "staerken": ["Stärke 1", "Stärke 2", "Stärke 3"],
  "schwaechen": ["Schwäche 1", "Schwäche 2"],
  "empfehlungen": ["Empfehlung 1", "Empfehlung 2", "Empfehlung 3"],
  "fazit": "Abschliessendes Urteil in 1-2 Sätzen"
}`;

          r = await this.callClaude(synthesisPrompt, SYSTEM_BUCHBEWERTUNG, (chars) => {
            this.setReviewStatus(`Claude synthetisiert… (${chars} Zeichen)`, true);
          });
        }

        this.bookReviewProgress = 100;
        setTimeout(() => { this.bookReviewProgress = 0; }, 400);

        const note = parseInt(r.gesamtnote, 10) || 0;
        const stars = '★'.repeat(Math.min(5, Math.max(0, note))) + '☆'.repeat(Math.max(0, 5 - note));

        let html = `
          <div class="bewertung-header">
            <span class="bewertung-stars">${stars}</span>
            <span class="bewertung-header-note">${escHtml(r.gesamtnote_begruendung || '')}</span>
          </div>
          <div class="stilbox" style="margin-bottom:14px;">${escHtml(r.zusammenfassung || '')}</div>`;

        if (r.struktur) html += `
          <div class="bewertung-section">
            <div class="bewertung-section-title">Struktur &amp; Aufbau</div>
            <p class="bewertung-section-text">${escHtml(r.struktur)}</p>
          </div>`;
        if (r.stil) html += `
          <div class="bewertung-section">
            <div class="bewertung-section-title">Schreibstil</div>
            <p class="bewertung-section-text">${escHtml(r.stil)}</p>
          </div>`;
        if (r.staerken?.length) html += `
          <div class="bewertung-section">
            <div class="bewertung-section-title">Stärken</div>
            <ul class="bullet-list pos">${r.staerken.map(s => `<li>${escHtml(s)}</li>`).join('')}</ul>
          </div>`;
        if (r.schwaechen?.length) html += `
          <div class="bewertung-section">
            <div class="bewertung-section-title">Schwächen</div>
            <ul class="bullet-list neg">${r.schwaechen.map(s => `<li>${escHtml(s)}</li>`).join('')}</ul>
          </div>`;
        if (r.empfehlungen?.length) html += `
          <div class="bewertung-section">
            <div class="bewertung-section-title">Empfehlungen</div>
            <ul class="bullet-list">${r.empfehlungen.map(s => `<li>${escHtml(s)}</li>`).join('')}</ul>
          </div>`;
        if (r.fazit) html += `<div class="fazit" style="margin-top:16px;">${escHtml(r.fazit)}</div>`;

        this.bookReviewOut = html;

        try {
          await fetch('/history/review', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              book_id: parseInt(bookId),
              book_name: bookName,
              review_json: r,
              model: this.claudeModel,
            }),
          });
          await this.loadBookReviewHistory(bookId);
        } catch (e) { console.error('[history review]', e); }

        this.setReviewStatus(`${pageContents.length} Seiten analysiert.`);
      } catch (e) {
        console.error('[runBookReview]', e);
        this.bookReviewOut = `<span class="error-msg">Fehler: ${escHtml(e.message)}</span>`;
        this.setReviewStatus('');
      }
      this.bookReviewLoading = false;
    },

    // ── Figuren ──────────────────────────────────────────────────────────────

    async loadFiguren(bookId) {
      try {
        const data = await fetch('/figures/' + bookId).then(r => r.json());
        this.figuren = data?.figuren || [];
      } catch (e) {
        console.error('[loadFiguren]', e);
      }
    },

    async saveFiguren() {
      try {
        await fetch('/figures/' + this.selectedBookId, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ figuren: this.figuren }),
        });
      } catch (e) {
        console.error('[saveFiguren]', e);
      }
    },

    async toggleFiguresCard() {
      this.showFiguresCard = !this.showFiguresCard;
      if (this.showFiguresCard) {
        await this.$nextTick();
        this.renderFigurGraph();
      }
    },

    async runFigurExtraction() {
      const bookId = this.selectedBookId;
      const bookName = this.selectedBookName;
      this.figurenLoading = true;
      this.figurenProgress = 0;
      this.figurenStatus = '<span class="spinner"></span>Lade Seiten…';

      const FINAL_SCHEMA = `{
  "figuren": [
    {
      "id": "fig_1",
      "name": "Vollständiger Name",
      "kurzname": "Vorname oder Spitzname",
      "typ": "hauptfigur|nebenfigur|antagonist|mentor|andere",
      "geburtstag": "JJJJ oder leer wenn unbekannt",
      "geschlecht": "männlich|weiblich|divers|unbekannt",
      "beruf": "Beruf oder Rolle oder leer",
      "beschreibung": "2-3 Sätze zu Rolle, Persönlichkeit und Bedeutung",
      "eigenschaften": ["Eigenschaft1", "Eigenschaft2"],
      "kapitel": [{ "name": "Kapitelname", "haeufigkeit": 3 }],
      "beziehungen": [{ "figur_id": "fig_2", "typ": "elternteil|geschwister|kind|freund|feind|kollege|bekannt|liebesbeziehung|rivale|mentor|schuetzling|andere", "beschreibung": "1 Satz" }]
    }
  ]
}`;

      const FINAL_RULES = `Regeln:
- Eindeutige IDs (fig_1, fig_2, …)
- beziehungen.figur_id: nur IDs aus dieser Liste; jede Beziehung nur einmal eintragen
- kapitel: absteigend nach Häufigkeit; haeufigkeit = Anzahl Seiten/Abschnitte mit aktivem Auftreten
- Beziehungstypen: elternteil/kind (gerichtet), geschwister (undirektional), übrige selbsterklärend
- Nur echte Personen/Charaktere, keine Orte oder Objekte
- Sortiert nach Wichtigkeit; maximal 20 Figuren`;

      try {
        const [chaptersData, pages] = await Promise.all([
          this.bsGetAll('chapters?book_id=' + bookId),
          this.bsGetAll('pages?book_id=' + bookId),
        ]);
        if (!pages.length) {
          this.figurenStatus = 'Keine Seiten gefunden.';
          this.figurenLoading = false;
          return;
        }

        const chMap = Object.fromEntries(chaptersData.map(c => [c.id, c.name]));

        // Seiten laden (voller Text, keine Kürzung)
        const BATCH = 5;
        const pageContents = [];
        for (let i = 0; i < pages.length; i += BATCH) {
          this.figurenProgress = Math.round((i / pages.length) * 55);
          this.figurenStatus = `<span class="spinner"></span>Lese ${i + 1}–${Math.min(i + BATCH, pages.length)} von ${pages.length} Seiten…`;
          const batch = pages.slice(i, i + BATCH);
          const results = await Promise.allSettled(batch.map(async p => {
            const pd = await this.bsGet('pages/' + p.id);
            const text = htmlToText(pd.html).trim();
            if (text.length < 30) return null;
            return { title: p.name, chapter_id: p.chapter_id || null, chapter: p.chapter_id ? (chMap[p.chapter_id] || 'Kapitel') : null, text };
          }));
          for (const r of results) {
            if (r.status === 'fulfilled' && r.value) pageContents.push(r.value);
          }
        }

        const totalChars = pageContents.reduce((s, p) => s + p.text.length, 0);
        const SINGLE_PASS_LIMIT = 60000;
        let result;

        if (totalChars <= SINGLE_PASS_LIMIT) {
          // ── Single-Pass ──────────────────────────────────────────────────
          this.figurenProgress = 65;
          this.figurenStatus = '<span class="spinner"></span>Claude analysiert Figuren…';
          const bookText = pageContents.map(p => `### ${p.chapter ? '[' + p.chapter + '] ' : ''}${p.title}\n${p.text}`).join('\n\n---\n\n');
          result = await this.callClaude(
            `Analysiere das Buch «${bookName}» und extrahiere alle wichtigen Figuren.\n\nAntworte mit diesem JSON-Schema:\n${FINAL_SCHEMA}\n\n${FINAL_RULES}\n\nBuchtext (${pageContents.length} Seiten):\n\n${bookText}`,
            SYSTEM_FIGUREN,
            (chars) => { this.figurenStatus = `<span class="spinner"></span>Claude analysiert… (${chars} Zeichen)`; }
          );

        } else {
          // ── Multi-Pass: pro Kapitel analysieren, dann konsolidieren ──────
          const groupOrder = [];
          const groups = new Map();
          for (const p of pageContents) {
            const key = p.chapter_id != null ? String(p.chapter_id) : '__ungrouped__';
            if (!groups.has(key)) { groupOrder.push(key); groups.set(key, { name: p.chapter || 'Sonstige Seiten', pages: [] }); }
            groups.get(key).pages.push(p);
          }

          const chapterFiguren = [];
          for (let gi = 0; gi < groupOrder.length; gi++) {
            const group = groups.get(groupOrder[gi]);
            this.figurenProgress = 55 + Math.round(((gi + 1) / groupOrder.length) * 30);
            this.figurenStatus = `<span class="spinner"></span>Figuren in «${group.name}» (${gi + 1}/${groupOrder.length})…`;

            const chText = group.pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n');
            const chResult = await this.callClaude(
              `Extrahiere alle Figuren/Charaktere aus dem Kapitel «${group.name}» des Buchs «${bookName}».

Antworte mit:
{
  "figuren": [
    { "name": "Vollständiger Name", "kurzname": "...", "typ": "hauptfigur|nebenfigur|antagonist|mentor|andere", "beruf": "...", "geburtstag": "JJJJ oder leer", "geschlecht": "männlich|weiblich|divers|unbekannt", "beschreibung": "1-2 Sätze", "eigenschaften": ["..."], "beziehungen": [{ "name": "Name der anderen Figur", "typ": "elternteil|geschwister|kind|freund|feind|kollege|bekannt|liebesbeziehung|rivale|mentor|schuetzling|andere", "beschreibung": "1 Satz" }] }
  ]
}

Nur echte Personen. Beziehungen: nur Figuren die in diesem Kapitel vorkommen.

Kapiteltext (${group.pages.length} Seiten):\n\n${chText}`,
              SYSTEM_FIGUREN
            );
            chapterFiguren.push({ kapitel: group.name, figuren: chResult.figuren || [] });
          }

          // ── Konsolidierung ───────────────────────────────────────────────
          this.figurenProgress = 88;
          this.figurenStatus = '<span class="spinner"></span>Claude konsolidiert Figuren…';

          const synthInput = chapterFiguren.map(cf =>
            `## Kapitel: ${cf.kapitel}\n` + cf.figuren.map(f =>
              `- ${f.name} (${f.typ})${f.beruf ? ', ' + f.beruf : ''}: ${f.beschreibung || ''}` +
              (f.beziehungen?.length ? '\n  Beziehungen: ' + f.beziehungen.map(b => `${b.name} [${b.typ}]`).join(', ') : '')
            ).join('\n')
          ).join('\n\n');

          result = await this.callClaude(
            `Konsolidiere die folgenden Figurenanalysen aller Kapitel des Buchs «${bookName}» zu einer einheitlichen Gesamtliste. Dedupliziere Figuren (dieselbe Figur kann in mehreren Kapiteln auftreten), führe Informationen zusammen und vergib stabile IDs.

Kapitelanalysen:

${synthInput}

Antworte mit diesem JSON-Schema:
${FINAL_SCHEMA}

${FINAL_RULES}`,
            SYSTEM_FIGUREN,
            (chars) => { this.figurenStatus = `<span class="spinner"></span>Claude konsolidiert… (${chars} Zeichen)`; }
          );
        }

        this.figuren = (result.figuren || []).map((f, i) => ({ ...f, id: f.id || ('fig_' + (i + 1)) }));
        this.figurenProgress = 100;
        setTimeout(() => { this.figurenProgress = 0; }, 400);

        await this.saveFiguren();
        this.figurenStatus = `${this.figuren.length} Figuren ermittelt und gespeichert.`;
        await this.$nextTick();
        this.renderFigurGraph();
      } catch (e) {
        console.error('[runFigurExtraction]', e);
        this.figurenStatus = `<span class="error-msg">Fehler: ${escHtml(e.message)}</span>`;
        this.figurenProgress = 0;
      }
      this.figurenLoading = false;
    },

    _figTypColor(typ) {
      const colors = {
        hauptfigur: { background: '#D4E8FF', border: '#4A90D9', highlight: { background: '#BDD8FF', border: '#2B6CB0' } },
        nebenfigur:  { background: '#F0F0F0', border: '#888',    highlight: { background: '#E4E4E4', border: '#555' } },
        antagonist:  { background: '#FFE0E0', border: '#E24B4A', highlight: { background: '#FFC7C7', border: '#B03030' } },
        mentor:      { background: '#EAF3DE', border: '#639922', highlight: { background: '#D5EBBD', border: '#3B6D11' } },
        andere:      { background: '#FFF5DC', border: '#C4941A', highlight: { background: '#FFEEBB', border: '#8A6800' } },
      };
      return colors[typ] || colors.andere;
    },

    renderFigurGraph() {
      const container = document.getElementById('figuren-graph');
      if (!container) return;
      if (this._figurenNetwork) {
        this._figurenNetwork.destroy();
        this._figurenNetwork = null;
      }
      if (!this.figuren.length) {
        container.innerHTML = '<span class="muted-msg" style="display:block;padding:20px;text-align:center;">Noch keine Figuren – «Figuren ermitteln» starten.</span>';
        return;
      }
      if (typeof vis === 'undefined') {
        container.innerHTML = '<span class="muted-msg" style="display:block;padding:20px;text-align:center;">vis-network wird geladen…</span>';
        return;
      }

      const nodes = new vis.DataSet(this.figuren.map(f => ({
        id: f.id,
        label: (f.kurzname || f.name) + (f.geburtstag ? '\n* ' + f.geburtstag : ''),
        title: `<b>${escHtml(f.name)}</b><br>${escHtml(f.typ)}<br>${escHtml(f.beschreibung || '')}`,
        color: this._figTypColor(f.typ),
        font: { size: 13, face: 'system-ui, -apple-system, sans-serif' },
        shape: 'box',
        margin: 10,
        widthConstraint: { maximum: 160 },
      })));

      const BZ = {
        elternteil:      { color: '#888',    highlight: '#555',    arrows: 'to',  dashes: false },
        kind:            { color: '#888',    highlight: '#555',    arrows: 'from', dashes: false },
        geschwister:     { color: '#4A90D9', highlight: '#2B6CB0', arrows: '',    dashes: [5,5] },
        freund:          { color: '#639922', highlight: '#3B6D11', arrows: '',    dashes: [4,3] },
        feind:           { color: '#E24B4A', highlight: '#B03030', arrows: '',    dashes: [4,3] },
        kollege:         { color: '#C4941A', highlight: '#8A6800', arrows: '',    dashes: [4,3] },
        bekannt:         { color: '#999',    highlight: '#555',    arrows: '',    dashes: [4,3] },
        liebesbeziehung: { color: '#D46EA0', highlight: '#A0446E', arrows: '',    dashes: [4,3] },
        rivale:          { color: '#9B4B00', highlight: '#6B3000', arrows: '',    dashes: [4,3] },
        mentor:          { color: '#4A90D9', highlight: '#2B6CB0', arrows: 'to',  dashes: [4,3] },
        schuetzling:     { color: '#4A90D9', highlight: '#2B6CB0', arrows: 'from', dashes: [4,3] },
        andere:          { color: '#bbb',    highlight: '#888',    arrows: '',    dashes: [4,3] },
      };

      const edgeList = [];
      const addedPairs = new Set();

      for (const f of this.figuren) {
        for (const bz of (f.beziehungen || [])) {
          if (!this.figuren.find(x => x.id === bz.figur_id)) continue;
          // Deduplizieren: geschwister + undirektionale Typen per sort-Key
          const directed = ['elternteil', 'kind', 'mentor', 'schuetzling'];
          const dedupeKey = directed.includes(bz.typ)
            ? [f.id, bz.figur_id, bz.typ].join('|')
            : [[f.id, bz.figur_id].sort().join('-'), bz.typ].join('|');
          if (addedPairs.has(dedupeKey)) continue;
          addedPairs.add(dedupeKey);

          const s = BZ[bz.typ] || BZ.andere;
          edgeList.push({
            from: f.id, to: bz.figur_id,
            label: bz.typ,
            title: bz.beschreibung || bz.typ,
            font: { size: 10, color: s.color },
            color: { color: s.color, highlight: s.highlight },
            arrows: s.arrows,
            dashes: s.dashes,
          });
        }
      }
      const edges = new vis.DataSet(edgeList);

      const hasFamilyEdges = edgeList.some(e => ['elternteil', 'kind'].includes(e.label));
      const options = {
        physics: hasFamilyEdges
          ? { solver: 'hierarchicalRepulsion', hierarchicalRepulsion: { nodeDistance: 140 } }
          : { solver: 'repulsion', repulsion: { nodeDistance: 160 } },
        layout: hasFamilyEdges
          ? { hierarchical: { direction: 'UD', sortMethod: 'directed', nodeSpacing: 160, levelSeparation: 120 } }
          : { randomSeed: 42 },
        interaction: { hover: true, tooltipDelay: 100 },
        edges: { smooth: { type: 'cubicBezier' } },
      };

      this._figurenNetwork = new vis.Network(container, { nodes, edges }, options);
    },
  }));
});
