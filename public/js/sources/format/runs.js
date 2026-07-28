// Run-Modell der Literaturangabe + die zwei Renderer darauf.
//
// Ein Verzeichniseintrag entsteht als flache Liste von Runs
// (`[{ text, italic? }]`) und wird daraus einmal zu Klartext und einmal zu HTML
// gerendert. Warum nicht direkt Strings bauen: der Eintrag braucht Kursivsatz
// (Werktitel, Zeitschriftenname), und PDF/DOCX/HTML/Blog wollen denselben
// Eintrag in drei Auspraegungen. Zwei getrennte Formatierpfade wuerden
// garantiert auseinanderdriften — das Run-Modell haelt pro Zitierstil genau
// eine Quelle der Wahrheit. Es ist ausserdem dieselbe Form, in der der
// PDF-/DOCX-Walker Inline-Text ohnehin denkt (lib/pdf-render/html-walker.js).

import { escHtml } from '../../utils/escape.js';

/** Ein normaler Run. Leerer/fehlender Text → leere Liste (Aufrufer muss nicht pruefen). */
export function txt(text) {
  const s = text == null ? '' : String(text).trim();
  return s ? [{ text: s }] : [];
}

/** Ein kursiver Run (Werktitel, Zeitschriftenname). */
export function it(text) {
  const s = text == null ? '' : String(text).trim();
  return s ? [{ text: s, italic: true }] : [];
}

/** Ein Run, der eine Adresse traegt. `terminate` haengt dahinter KEINEN Punkt an
 *  — ein Schlusspunkt direkt hinter einer URL wandert beim Kopieren mit in die
 *  Adresse. APA und Chicago lassen ihn nach DOI/URL ebenfalls weg. */
export function urlRun(text) {
  const s = text == null ? '' : String(text).trim();
  return s ? [{ text: s, url: true }] : [];
}

// Terminal endet ein Teil auch dann, wenn hinter dem Satzzeichen noch ein
// schliessendes Anfuehrungszeichen steht — Chicago setzt Aufsatztitel als
// „Titel.“ und darf danach keinen zweiten Punkt bekommen.
const TERMINAL = /[.?!][”“"'»]?$/;

/** Fuegt Teile mit einem Trennzeichen zusammen und ueberspringt leere Teile.
 *
 *  Die Punktuations-Kollaps-Regel ist der Grund, warum das eine Funktion ist:
 *  ein Autorenname endet nach der Initiale schon auf '.', und ein Titel kann
 *  auf '?' oder '!' enden. Naiv verkettet entsteht daraus "Kafka, F.. (1915)"
 *  bzw. "Wer denn?. Verlag". Endet der Vorgaenger terminal und ist der Separator
 *  ein Punkt, bleibt nur dessen Leerzeichen stehen. Analog fuer Komma. */
export function joinParts(parts, sep = '. ') {
  const out = [];
  for (const part of parts) {
    const runs = (part || []).filter(r => r && r.text);
    if (!runs.length) continue;
    if (out.length) {
      const lastText = out[out.length - 1].text;
      let s = sep;
      if (sep[0] === '.' && TERMINAL.test(lastText)) s = sep.slice(1);
      else if (sep[0] === ',' && /,$/.test(lastText)) s = sep.slice(1);
      if (s) out.push({ text: s });
    }
    out.push(...runs);
  }
  return out;
}

/** Schlusspunkt, aber nur wenn der Eintrag nicht ohnehin terminal endet (Titel
 *  mit '?', Initiale, „Titel.“) und nicht auf einer Adresse (urlRun). */
export function terminate(runs) {
  if (!runs.length) return runs;
  const last = runs[runs.length - 1];
  if (last.url) return runs;
  if (TERMINAL.test(last.text)) return runs;
  return [...runs, { text: '.' }];
}

/** Runs zu Klartext (TXT/Markdown-Export, Sortier-Vorschau, Tests). */
export function runsToText(runs) {
  return runs.map(r => r.text).join('');
}

/** Runs zu HTML. Escapet JEDEN Run-Text — Quellenfelder sind User-Eingabe und
 *  fliessen in `x-html`-Senken sowie in den Blog-Push. Kursiv wird zu <em>,
 *  weil <em> der einzige Inline-Tag ist, den alle Ziel-Pipelines kennen
 *  (PDF-/DOCX-Walker, wp-html, hubspot-html). */
export function runsToHtml(runs) {
  return runs.map(r => (r.italic ? `<em>${escHtml(r.text)}</em>` : escHtml(r.text))).join('');
}

/** Bindestrich zwischen Ziffern zu Halbgeviertstrich. Seitenbereiche werden
 *  praktisch immer als "44-46" eingetippt, gehoeren im Satz aber als "44–46". */
export function enDashRange(s) {
  if (!s) return '';
  return String(s).trim().replace(/(\d)\s*[-–—]\s*(\d)/g, '$1–$2');
}

/** Seitenangabe mit Sprach-Abkuerzung. Mehrzahl-Form, sobald ein Bereich oder
 *  eine Aufzaehlung erkennbar ist (relevant nur fuer Englisch: p. vs. pp.). */
export function pageLabel(pages, labels) {
  const p = enDashRange(pages);
  if (!p) return '';
  const plural = /[–,;]|\bf{1,2}\.?$/.test(p);
  return `${plural ? labels.pageAbbrevN : labels.pageAbbrev1} ${p}`;
}

/** In Anfuehrungszeichen der Buchsprache setzen (Chicago: Aufsatz-/Kapiteltitel). */
export function quoted(text, labels) {
  const s = text == null ? '' : String(text).trim();
  if (!s) return [];
  // Ein Titel, der schon auf Satzzeichen endet, behaelt es innerhalb der
  // Anfuehrung — "Wer denn?" statt "Wer denn?".
  return [{ text: `${labels.quoteOpen}${s}${TERMINAL.test(s) ? '' : '.'}${labels.quoteClose}` }];
}

/** Verlinkbare Adresse einer Quelle: DOI hat Vorrang vor url (stabiler). */
export function locatorUrl(src) {
  const doi = src.doi ? String(src.doi).trim() : '';
  if (doi) return /^https?:\/\//i.test(doi) ? doi : `https://doi.org/${doi.replace(/^doi:\s*/i, '')}`;
  const url = src.url ? String(src.url).trim() : '';
  return url || '';
}
