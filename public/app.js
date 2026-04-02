const CLAUDE_API = '/claude';

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
    claudeMaxTokens: 64000,
    claudeModel: '',
    books: [],
    selectedBookId: '',
    pages: [],
    tree: [],
    currentPage: null,
    correctedHtml: null,
    hasErrors: false,
    showBookCard: false,
    showEditorCard: false,
    showBookReviewCard: false,
    status: '',
    statusSpinner: false,
    analysisOut: '',
    bookReviewOut: '',
    bookReviewStatus: '',
    checkLoading: false,
    bookReviewLoading: false,
    bookReviewProgress: 0,
    lastCheckId: null,
    pageHistory: [],
    selectedHistoryId: null,

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

    setStatus(msg, spinner = false) {
      this.status = msg;
      this.statusSpinner = spinner;
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

    async bsGet(path) {
      const r = await fetch('/api/' + path, { headers: { Authorization: this.authToken } });
      if (!r.ok) throw new Error('BookStack API Fehler ' + r.status);
      return r.json();
    },

    async bsPut(path, body) {
      const r = await fetch('/api/' + path, {
        method: 'PUT',
        headers: { Authorization: this.authToken, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error('BookStack API Fehler ' + r.status);
      return r.json();
    },

    async callClaude(prompt) {
      const resp = await fetch(CLAUDE_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: this.claudeModel,
          max_tokens: this.claudeMaxTokens,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      const data = await resp.json();
      if (data.type === 'error') {
        throw new Error('Claude API Fehler: ' + (data.error?.message || JSON.stringify(data.error)));
      }
      const raw = (data.content || []).map(b => b.text || '').join('');
      const clean = raw.replace(/```json\s*|```/g, '').trim();
      try {
        return JSON.parse(clean);
      } catch (e) {
        throw new Error(
          'Claude-Antwort konnte nicht geparst werden: ' + e.message +
          '\n\nRohantwort: ' + raw.slice(0, 300)
        );
      }
    },

    async init() {
      try {
        const cfg = await fetch('/config').then(r => r.json());
        if (cfg.tokenId && cfg.tokenPw) {
          this.authToken = 'Token ' + cfg.tokenId + ':' + cfg.tokenPw;
          this.bookstackUrl = cfg.bookstackUrl || '';
          if (cfg.claudeMaxTokens) this.claudeMaxTokens = cfg.claudeMaxTokens;
          if (cfg.claudeModel) this.claudeModel = cfg.claudeModel;
          await this.loadBooks();
        } else {
          this.setStatus('Keine Zugangsdaten in .env konfiguriert.');
        }
      } catch (_) {
        this.setStatus('Fehler beim Laden der Konfiguration.');
      }
    },

    async loadBooks() {
      try {
        this.setStatus('Verbinde mit BookStack…', true);
        const data = await this.bsGet('books');
        this.books = data.data;
        this.selectedBookId = String(this.books[0]?.id || '');
        this.showBookCard = true;
        this.setStatus(this.books.length + ' Buch/Bücher gefunden.');
        if (this.books.length === 1) await this.loadPages();
      } catch (e) {
        console.error('[loadBooks]', e);
        this.setStatus('Fehler: ' + e.message);
      }
    },

    async loadPages() {
      const bookId = this.selectedBookId;
      try {
        this.setStatus('Lade Seiten…', true);
        const [chapters, pagesData] = await Promise.all([
          this.bsGet('chapters?book_id=' + bookId),
          this.bsGet('pages?book_id=' + bookId),
        ]);

        const sortedChapters = [...chapters.data].sort((a, b) => a.priority - b.priority);
        const chMap = Object.fromEntries(sortedChapters.map(c => [c.id, c.name]));
        const chapterOrder = Object.fromEntries(sortedChapters.map((c, i) => [c.id, i]));

        this.pages = [...pagesData.data]
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

    async selectPage(p) {
      this.currentPage = p;
      this.correctedHtml = null;
      this.hasErrors = false;
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
      this.correctedHtml = null;
      this.hasErrors = false;
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
    },

    async runCheck() {
      if (!this.currentPage) return;
      this.checkLoading = true;
      this.correctedHtml = null;
      this.hasErrors = false;
      this.analysisOut = '';
      this.setStatus('Lade Seiteninhalt…', true);

      try {
        const pageData = await this.bsGet('pages/' + this.currentPage.id);
        const html = pageData.html;
        const text = htmlToText(html);

        this.setStatus('Claude analysiert…', true);

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
${text}

Original-HTML (für korrekturen_html):
${html}`;

        const result = await this.callClaude(prompt);
        this.correctedHtml = result.korrekturen_html || html;

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

        // Analyse in History speichern
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

        this.setStatus('Analyse abgeschlossen.');
      } catch (e) {
        console.error('[runCheck]', e);
        this.analysisOut = `<span class="error-msg">Fehler: ${e.message}</span>`;
        this.setStatus('');
      }

      this.checkLoading = false;
    },

    async saveCorrections() {
      if (!this.correctedHtml || !this.currentPage) return;
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
        this.setStatus('✓ Korrekturen gespeichert.');
        this.correctedHtml = null;
        this.hasErrors = false;
      } catch (e) {
        console.error('[saveCorrections]', e);
        this.setStatus('Fehler: ' + e.message);
      }
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
        const [chaptersData, pagesData] = await Promise.all([
          this.bsGet('chapters?book_id=' + bookId),
          this.bsGet('pages?book_id=' + bookId),
        ]);

        const chMap = Object.fromEntries(chaptersData.data.map(c => [c.id, c.name]));
        const pages = pagesData.data;

        if (pages.length === 0) {
          this.setReviewStatus('Keine Seiten im Buch gefunden.');
          this.bookReviewLoading = false;
          return;
        }

        this.setReviewStatus(`Lese ${pages.length} Seiten…`, true);

        const pageContents = [];
        for (let i = 0; i < pages.length; i++) {
          const p = pages[i];
          this.bookReviewProgress = Math.round((i / pages.length) * 80);
          try {
            const pd = await this.bsGet('pages/' + p.id);
            const text = htmlToText(pd.html).trim();
            if (text.length > 50) {
              const chapter = p.chapter_id ? (chMap[p.chapter_id] || 'Kapitel') : null;
              pageContents.push({
                title: p.name,
                chapter,
                text: text.length > 3000 ? text.slice(0, 3000) + ' […]' : text,
              });
            }
          } catch (e) { console.error('[runBookReview page]', p.id, e); }
        }

        this.bookReviewProgress = 85;
        this.setReviewStatus('Claude analysiert das Buch…', true);

        const bookText = pageContents.map(p =>
          `### ${p.chapter ? '[' + p.chapter + '] ' : ''}${p.title}\n${p.text}`
        ).join('\n\n---\n\n');

        const prompt = `Du bist ein erfahrener Literaturkritiker und Lektor für deutschsprachige Texte aus der Schweiz. Helvetismen (grösseres, Strasse, gemäss, usw.) sind korrekt und werden nicht bemängelt.

Bewerte das folgende Buch «${bookName}» kritisch und umfassend. Analysiere dabei:
- Struktur und Aufbau (Kapitel, Übergänge, Logik)
- Sprachstil und Konsistenz über alle Seiten hinweg
- Stärken des Texts
- Schwächen und Verbesserungspotenzial
- Konkrete Empfehlungen für den Autor

Antworte NUR mit einem JSON-Objekt, kein Markdown, keine Erklärungen davor oder danach:
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

        const r = await this.callClaude(prompt);

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

        // Buchbewertung in History speichern
        try {
          await fetch('/history/review', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ book_id: parseInt(bookId), book_name: bookName, review_json: r, model: this.claudeModel }),
          });
        } catch (e) { console.error('[history review]', e); }

        this.setReviewStatus(`${pageContents.length} Seiten analysiert.`);
      } catch (e) {
        console.error('[runBookReview]', e);
        this.bookReviewOut = `<span class="error-msg">Fehler: ${e.message}</span>`;
        this.setReviewStatus('');
      }

      this.bookReviewLoading = false;
    },
  }));
});
