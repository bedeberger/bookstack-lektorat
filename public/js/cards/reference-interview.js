// O-Töne aus einem Interview-Transkript in den Artikel — Referenz-Panel neben
// dem Notebook-Editor.
//
// WARUM HIER UND NICHT IM RECHERCHE-BOARD: das Board ist eine Hauptkarte und
// schliesst beim Öffnen den Editor (Exklusivität). Ein „in den Artikel"-Knopf
// hätte dort keinen Artikel, in den er schreiben könnte. Das Referenz-Panel
// steht neben dem offenen Editor — genau die Anordnung, die das Herausgreifen
// eines O-Tons braucht: links das Gespräch, rechts der Text.
//
// Das Panel bleibt read-only gegenüber der RECHERCHE (es ändert kein Fundstück).
// Es schreibt in den ARTIKEL, und zwar über denselben Weg wie jede Quellenangabe:
// `insertOTonBlock` in editor/notebook/toolbar/cite.js erzeugt das übliche
// `<blockquote data-src>` + `span.cite`. Kein zweiter Zitat-Träger.

import { fetchJson, sendJson } from '../utils/net.js';
import { formatTimecode, speakerLabel } from '../interview/timecode.js';
import { EVT } from '../events.js';

export const referenceInterviewMethods = {
  refIvTimecode(s) { return formatTimecode(s); },
  refIvSpeakerLabel(key) { return speakerLabel(this.refIvSpeakers, key); },

  /** Ist dieses Fundstück ein Transkript? Steuert, ob die Zeile aufklappbar ist. */
  refIsTranscript(item) {
    return item?.kind === 'transcript';
  },

  /**
   * Transkript einer Zeile auf-/zuklappen. Segmente werden erst beim Öffnen
   * geholt — ein Gespräch von einer Stunde sind mehrere hundert Redebeiträge,
   * die niemand sehen will, solange die Zeile zu ist.
   */
  async refIvToggle(itemId) {
    if (this.refIvOpenId === itemId) { this.refIvOpenId = null; return; }
    this.refIvOpenId = itemId;
    this.refIvSegments = [];
    this.refIvSpeakers = {};
    this.refIvError = '';
    this.refIvLoading = true;
    try {
      const d = await fetchJson(`/research/${itemId}/transcript`);
      this.refIvSegments = d.segments || [];
      this.refIvSpeakers = d.speakers || {};
      this.refIvStatus = d.transcript?.status || null;
    } catch (e) {
      this.refIvError = window.__app.t(
        e.status === 404 ? 'interview.noTranscript' : 'interview.error.generic',
      );
    } finally {
      this.refIvLoading = false;
    }
  },

  /** Segmente, gefiltert nach dem Suchfeld des Panels. */
  refIvFiltered() {
    const q = String(this.refIvQuery || '').trim().toLowerCase();
    if (!q) return this.refIvSegments;
    return this.refIvSegments.filter(s => String(s.text || '').toLowerCase().includes(q));
  },

  /**
   * O-Ton übernehmen: Quelle anlegen (bzw. die des Sprechers wiederverwenden),
   * dann als belegtes Blockzitat in den Artikel setzen.
   *
   * Reihenfolge ist Absicht — erst die Quelle, dann der Text. Ein Blockzitat
   * ohne `data-src` wäre ein Zitat ohne Beleg, und genau das soll dieses Feature
   * unmöglich machen. Schlägt das Anlegen fehl, wird nichts eingefügt.
   */
  async refIvInsert(itemId, segment) {
    if (!window.__app?.editMode) {
      this.refIvError = window.__app.t('interview.needEditMode');
      return;
    }
    this.refIvError = '';
    this.refIvBusyId = segment.id;
    try {
      const r = await sendJson(`/research/${itemId}/oton`, 'POST', { segment_id: segment.id });
      // Trampolin an die Editor-Toolbar: das Markup baut cite.js, weil dort die
      // SSoT fuer Quellen-Markup liegt. `ack` traegt die Antwort synchron
      // zurueck (siehe EVT.EDITOR_OTON_INSERT).
      const ack = { ok: false };
      window.dispatchEvent(new CustomEvent(EVT.EDITOR_OTON_INSERT, {
        detail: { source: r.source, text: r.text, loc: r.loc, ack },
      }));
      if (!ack.ok) this.refIvError = window.__app.t('interview.insertFailed');
    } catch (e) {
      this.refIvError = window.__app.t(
        e.message === 'SPEAKER_UNNAMED' ? 'interview.error.SPEAKER_UNNAMED' : 'interview.error.generic',
      );
    } finally {
      this.refIvBusyId = null;
    }
  },
};

/** Anfangszustand des Slices — vom Karten-Reset mitbenutzt. */
export const referenceInterviewState = () => ({
  refIvOpenId: null,
  refIvSegments: [],
  refIvSpeakers: {},
  refIvStatus: null,
  refIvQuery: '',
  refIvLoading: false,
  refIvBusyId: null,
  refIvError: '',
});
