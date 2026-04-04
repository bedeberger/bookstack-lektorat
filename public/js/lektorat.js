import { escHtml, htmlToText } from './utils.js';
import { SYSTEM_LEKTORAT, buildLektoratPrompt, SYSTEM_STILKORREKTUR, buildStilkorrekturPrompt } from './prompts.js';

// Mindestanteil: korrigiertes HTML muss >= 70 % des Originals sein, sonst Fallback
const MIN_HTML_RATIO = 0.7;
// Sicherheitscheck vor dem Speichern: < 50 % wirkt unvollständig → Abbruch
const SAFETY_HTML_RATIO = 0.5;

// Lektorat-Workflow-Methoden (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.

export const lektoratMethods = {
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

  toggleDiff() {
    if (!this.correctedHtml || !this.originalHtml) return;
    this.showDiff = !this.showDiff;
    if (this.showDiff && !this.diffHtml) {
      this.diffHtml = this.computeDiff(this.originalHtml, this.correctedHtml);
    }
  },

  _recomputeCorrectedHtml() {
    if (!this.originalHtml) return;
    const selected = this.lektoratErrors.filter((_, i) => this.selectedErrors[i]);
    this.correctedHtml = selected.length > 0
      ? this._applyCorrections(this.originalHtml, selected)
      : this.originalHtml;
    this.diffHtml = '';
    this.showDiff = false;
  },

  toggleError(i) {
    this.selectedErrors[i] = !this.selectedErrors[i];
    this._recomputeCorrectedHtml();
  },

  toggleStyle(i) {
    this.selectedStyles[i] = !this.selectedStyles[i];
    this._recomputeCorrectedHtml();
  },

  selectAllErrors(val) {
    this.selectedErrors = this.selectedErrors.map(() => val);
    this._recomputeCorrectedHtml();
  },

  selectAllStyles(val) {
    this.selectedStyles = this.selectedStyles.map(() => val);
    this._recomputeCorrectedHtml();
  },

  async runCheck() {
    if (!this.currentPage) return;
    this.checkLoading = true;
    this.checkDone = false;
    this.originalHtml = null;
    this.correctedHtml = null;
    this.hasErrors = false;
    this.showDiff = false;
    this.diffHtml = '';
    this.analysisOut = '';
    this.lektoratErrors = [];
    this.lektoratStyles = [];
    this.selectedErrors = [];
    this.selectedStyles = [];
    this.setStatus('Lade Seiteninhalt…', true);

    try {
      const pageData = await this.bsGet('pages/' + this.currentPage.id);
      const html = pageData.html;
      const text = htmlToText(html);
      this.originalHtml = html;
      this.currentPageUpdatedAt = pageData.updated_at || null;

      this.setStatus('KI analysiert… (0 Zeichen)', true);

      const result = await this.callAI(
        buildLektoratPrompt(text, html),
        SYSTEM_LEKTORAT,
        (chars) => this.setStatus(`KI analysiert… (${chars} Zeichen)`, true)
      );

      if (!Array.isArray(result?.fehler)) {
        throw new Error('Claude-Antwort ungültig: fehler-Array fehlt');
      }

      const fehler = result.fehler || [];
      const errors = fehler.filter(f => f.typ === 'rechtschreibung' || f.typ === 'grammatik');
      const styles = fehler.filter(f => f.typ === 'stil');

      this.lektoratErrors = errors;
      this.lektoratStyles = styles;
      this.selectedErrors = errors.map(() => true);
      this.selectedStyles = styles.map(() => false);
      this.hasErrors = errors.length > 0;

      // Korrekturen aus gewählten Fehlern berechnen
      this.correctedHtml = errors.length > 0
        ? this._applyCorrections(html, errors)
        : html;

      // Prüfen ob Claude-HTML vollständiger ist → dann als Basis nehmen
      const claudeHtml = result.korrekturen_html;
      if (claudeHtml && claudeHtml.length >= html.length * MIN_HTML_RATIO) {
        // Claude-HTML ist vollständig – aber wir brauchen selektives Anwenden,
        // daher immer _applyCorrections nutzen (Claude-HTML wird ignoriert)
        if (errors.length === 0) this.correctedHtml = html;
      } else if (claudeHtml) {
        console.warn('[runCheck] korrekturen_html zu kurz, Korrekturen manuell angewandt');
      }

      let out = '';
      if (result.stilanalyse) {
        out += `<div class="stilbox"><div class="stilbox-title">Stilanalyse</div>${escHtml(result.stilanalyse)}</div>`;
      }
      if (result.fazit) {
        out += `<div class="fazit">${escHtml(result.fazit)}</div>`;
      }
      this.analysisOut = out;
      this.checkDone = true;

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
            model: this.apiProvider === 'ollama' ? this.ollamaModel : this.claudeModel,
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
    if (this.originalHtml && this.correctedHtml.length < this.originalHtml.length * SAFETY_HTML_RATIO) {
      this.setStatus('Fehler: Korrigiertes HTML wirkt unvollständig – Speichern abgebrochen.');
      console.error('[saveCorrections] correctedHtml zu kurz:', this.correctedHtml.length, 'vs original:', this.originalHtml.length);
      return;
    }

    let finalHtml = this.correctedHtml;
    const selectedStyles = this.lektoratStyles.filter((_, i) => this.selectedStyles[i]);
    if (selectedStyles.length > 0) {
      this.setStatus('KI überarbeitet Stil… (0 Zeichen)', true);
      try {
        const result = await this.callAI(
          buildStilkorrekturPrompt(this.correctedHtml, selectedStyles),
          SYSTEM_STILKORREKTUR,
          (chars) => this.setStatus(`KI überarbeitet Stil… (${chars} Zeichen)`, true)
        );
        if (Array.isArray(result?.korrekturen) && result.korrekturen.length > 0) {
          finalHtml = this._applyCorrections(this.correctedHtml, result.korrekturen.map(k => ({ original: k.original, korrektur: k.ersatz })));
        } else {
          console.warn('[saveCorrections] Stil-Korrekturen leer oder ungültig, Stilkorrekturen übersprungen');
        }
      } catch (e) {
        console.error('[saveCorrections] Stil-Call fehlgeschlagen:', e);
        this.setStatus('Fehler bei Stilkorrektur: ' + e.message);
        return;
      }
    }

    this.setStatus('Prüfe auf Änderungen…', true);
    try {
      const current = await this.bsGet('pages/' + this.currentPage.id);
      if (this.currentPageUpdatedAt && current.updated_at !== this.currentPageUpdatedAt) {
        this.setStatus('Konflikt: Die Seite wurde zwischenzeitlich von jemand anderem geändert. Bitte Lektorat neu starten.');
        return;
      }
    } catch (e) {
      console.warn('[saveCorrections] Konfliktprüfung fehlgeschlagen, fahre fort:', e.message);
    }

    this.setStatus('Speichere in BookStack…', true);
    try {
      await this.bsPut('pages/' + this.currentPage.id, {
        html: finalHtml,
        name: this.currentPage.name,
      });
      if (this.lastCheckId) {
        try {
          const appliedErrors = this.lektoratErrors.filter((_, i) => this.selectedErrors[i]);
          await fetch('/history/check/' + this.lastCheckId + '/saved', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ applied_errors_json: appliedErrors }),
          });
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

        const result = await this.callAI(buildLektoratPrompt(text, html), SYSTEM_LEKTORAT);
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
            model: this.apiProvider === 'ollama' ? this.ollamaModel : this.claudeModel,
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
};
