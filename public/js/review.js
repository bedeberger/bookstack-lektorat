import { escHtml } from './utils.js';
import { SYSTEM_BUCHBEWERTUNG, SYSTEM_KAPITELANALYSE } from './prompts.js';
import { SINGLE_PASS_LIMIT, loadPageContents, groupByChapter } from './two-tier.js';

// Buchbewertungs-Methoden (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.

export const reviewMethods = {
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

      const pageContents = await loadPageContents(
        p => this.bsGet(p), pages, chMap, 50,
        (i, total) => { this.bookReviewProgress = Math.round((i / total) * 60); }
      );

      this.bookReviewProgress = 65;

      const totalChars = pageContents.reduce((s, p) => s + p.text.length, 0);
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
        const { groupOrder, groups } = groupByChapter(pageContents);

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
};
