import { escHtml } from './utils.js';
import { SYSTEM_FIGUREN } from './prompts.js';
import { SINGLE_PASS_LIMIT, loadPageContents, groupByChapter } from './two-tier.js';

// Figurenübersicht-Methoden (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.

export const figurenMethods = {
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
- Sortiert nach Wichtigkeit; maximal 20 Figuren
- KONSERVATIV: Nur Figuren und Beziehungen aufnehmen die im Text eindeutig belegt sind. Lieber weglassen als spekulieren. Keine Beziehungen erschliessen die nicht explizit genannt werden.`;

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

      const pageContents = await loadPageContents(
        p => this.bsGet(p), pages, chMap, 30,
        (i, total) => {
          this.figurenProgress = Math.round((i / total) * 55);
          this.figurenStatus = `<span class="spinner"></span>Lese ${i + 1}–${Math.min(i + 5, total)} von ${total} Seiten…`;
        }
      );

      const totalChars = pageContents.reduce((s, p) => s + p.text.length, 0);
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
        const { groupOrder, groups } = groupByChapter(pageContents);

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

Nur echte Personen. Sei konservativ: nur Figuren und Beziehungen die im Text eindeutig belegt sind – lieber weglassen als spekulieren. Bevorzugte Beziehungstypen: elternteil, kind, geschwister, liebesbeziehung, bekannt. Andere Typen (freund, feind, kollege etc.) nur wenn explizit im Text genannt.

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
};
