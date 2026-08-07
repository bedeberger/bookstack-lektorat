// Interview-Transkription im Recherche-Board: Aufnahme hochladen, Lauf
// anstossen, Wortlaut lesen, Sprecher benennen.
//
// Das Transkript ist ein Recherche-Fundstück (`kind: 'transcript'`) — deshalb
// liegt seine Verwaltung hier und nicht in einer eigenen Karte. Was die Aufnahme
// hergibt, gehört zum Material, aus dem der Beitrag gebaut wird, genau wie ein
// PDF oder ein Link.
//
// Das EINFÜGEN der O-Töne passiert nicht hier, sondern im Referenz-Panel neben
// dem Editor (cards/reference-interview.js): das Board ist eine Hauptkarte und
// schliesst den Editor, in den der O-Ton soll.

import { fetchJson, sendJson } from '../../utils/net.js';
import { startPoll } from '../../cards/job-helpers.js';
import { formatTimecode, durationLabel, speakerLabel } from '../../interview/timecode.js';

const LS_KEY = (itemId) => `interview_job_${itemId}`;

export const rechercheInterviewMethods = {
  ivTimecode(s) { return formatTimecode(s); },
  ivDuration(s) { return durationLabel(s); },
  ivSpeakerLabel(key) { return speakerLabel(this.ivSpeakers, key); },

  /** Läuft gerade eine Transkription für dieses Fundstück? */
  ivBusy(itemId) {
    return this.ivRunningItemId === itemId;
  },

  // ── Aufnahme hochladen ─────────────────────────────────────────────────────

  /**
   * Audiodatei an ein bestehendes Fundstück hängen. Der Upload geht als rohes
   * Binary mit dem Datei-Mime im Content-Type — dieselbe Bauform wie beim
   * PDF-Anhang, kein Multipart.
   *
   * Der Transkriptionslauf startet NICHT automatisch mit: ohne Backend gibt es
   * keinen, und selbst mit einem soll der Nutzer entscheiden, wann eine
   * einstündige Aufnahme die GPU belegt. `can_transcribe` aus der Antwort sagt
   * der Karte, ob sie den Knopf überhaupt anbieten darf.
   */
  async ivUploadAudio(itemId, file) {
    if (!file) return;
    this.ivError = '';
    this.ivUploading = true;
    try {
      const r = await fetch(`/research/${itemId}/audio?name=${encodeURIComponent(file.name || '')}`, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error_code || `HTTP ${r.status}`);
      }
      const data = await r.json();
      this.ivCanTranscribe = !!data.can_transcribe;
      this.ivTranscript = data.transcript || null;
      this._ivPatchItem(data.item);
    } catch (e) {
      this.ivError = this._ivErrorText(e.message);
    } finally {
      this.ivUploading = false;
    }
  },

  /** Fehlercode des Servers auf einen Satz abbilden; Unbekanntes bleibt generisch. */
  _ivErrorText(code) {
    const t = window.__app.t.bind(window.__app);
    const known = ['AUDIO_TOO_LARGE', 'UNSUPPORTED_AUDIO', 'NO_AUDIO', 'TRANSCRIBE_DISABLED'];
    return known.includes(code) ? t(`interview.error.${code}`) : t('interview.error.generic');
  },

  /** Geändertes Item in die Board-Liste zurückspiegeln (kind wechselt auf
   *  'transcript', damit die Kachel den Player statt des Notizsymbols zeigt). */
  _ivPatchItem(item) {
    if (!item?.id) return;
    const i = (this.items || []).findIndex(x => x.id === item.id);
    if (i >= 0) this.items[i] = { ...this.items[i], ...item };
    if (this.detailItem?.id === item.id) this.detailItem = { ...this.detailItem, ...item };
  },

  // ── Transkript lesen ───────────────────────────────────────────────────────

  async ivLoadTranscript(itemId) {
    this.ivError = '';
    this.ivSegments = [];
    this.ivSpeakers = {};
    try {
      const d = await fetchJson(`/research/${itemId}/transcript`);
      this.ivTranscript = d.transcript || null;
      this.ivSegments = d.segments || [];
      this.ivSpeakers = d.speakers || {};
      this.ivSpeakerKeys = d.speaker_keys || [];
      this.ivCanTranscribe = !!d.can_transcribe;
      // Ein Lauf, der beim letzten Besuch noch lief, ist womöglich fertig — der
      // Status kommt vom Server, nicht aus dem Gedächtnis der Karte.
      if (this.ivTranscript?.status === 'running') this.ivRunningItemId = itemId;
    } catch (e) {
      // 404 heisst „kein Transkript" und ist kein Fehler: das Fundstück kann
      // eine Aufnahme ohne Lauf sein.
      if (e.status !== 404) this.ivError = this._ivErrorText(e.message);
      this.ivTranscript = null;
    }
  },

  // ── Lauf ───────────────────────────────────────────────────────────────────

  _ivIdle() {
    this.ivRunningItemId = null;
    this.ivProgress = 0;
    this.ivStatus = '';
    if (this._ivPollTimer) { clearInterval(this._ivPollTimer); this._ivPollTimer = null; }
  },

  async ivTranscribe(itemId) {
    if (this.ivRunningItemId) return;
    this.ivError = '';
    this.ivRunningItemId = itemId;
    this.ivProgress = 0;
    this.ivStatus = window.__app.t('interview.starting');
    try {
      const { jobId } = await sendJson('/jobs/interview-transcribe', 'POST', { item_id: itemId });
      localStorage.setItem(LS_KEY(itemId), jobId);
      this._ivPoll(jobId, itemId);
    } catch (e) {
      this._ivIdle();
      this.ivError = this._ivErrorText(e.message);
    }
  },

  _ivPoll(jobId, itemId) {
    startPoll(this, {
      timerProp: '_ivPollTimer',
      jobId,
      lsKey: LS_KEY(itemId),
      progressProp: 'ivProgress',
      onProgress: (job) => {
        this.ivStatus = window.__app.t(job.statusText, job.statusParams);
      },
      onDone: async () => {
        this._ivIdle();
        await this.ivLoadTranscript(itemId);
      },
      onNotFound: () => {
        this._ivIdle();
        this.ivError = window.__app.t('interview.interrupted');
      },
      onError: (job) => {
        this._ivIdle();
        this.ivError = window.__app.t(job.error, job.errorParams);
        // Den Grund trägt auch die Transkript-Zeile — neu laden, damit die
        // Karte ihn dauerhaft zeigt und nicht nur bis zum nächsten Öffnen.
        this.ivLoadTranscript(itemId);
      },
    });
  },

  /** Reconnect nach Reload (app-jobs-core.js#checkPendingJobs). */
  ivReconnect(jobId, itemId) {
    this.ivRunningItemId = itemId;
    this.ivStatus = window.__app.t('common.analysisRunning');
    this._ivPoll(jobId, itemId);
  },

  // ── Sprecher ───────────────────────────────────────────────────────────────

  /**
   * Sprecher benennen. Danach steht der Name auch im Volltext (der Server setzt
   * ihn neu) — sonst fände man das Zitat nur unter `SPEAKER_01`.
   */
  async ivRenameSpeaker(itemId, key) {
    const draft = this.ivSpeakerDraft[key] || {};
    try {
      const r = await sendJson(`/research/${itemId}/speaker/${encodeURIComponent(key)}`, 'PUT', {
        label: draft.label ?? null,
        rolle: draft.rolle ?? null,
      });
      this.ivSpeakers = r.speakers || {};
    } catch (e) {
      this.ivError = this._ivErrorText(e.message);
    }
  },

  /** Entwurfsfelder aus dem geladenen Stand vorbelegen. */
  ivEditSpeaker(key) {
    const cur = this.ivSpeakers[key] || {};
    this.ivSpeakerDraft = {
      ...this.ivSpeakerDraft,
      [key]: { label: cur.label || '', rolle: cur.rolle || '' },
    };
  },

  /** Aufnahme verwerfen, Wortlaut behalten — der Audio-BLOB ist der grosse Teil. */
  async ivDropAudio(itemId) {
    if (!window.confirm(window.__app.t('interview.dropAudioConfirm'))) return;
    try {
      const r = await sendJson(`/research/${itemId}/audio`, 'DELETE');
      this.ivTranscript = r.transcript || null;
    } catch (e) {
      this.ivError = this._ivErrorText(e.message);
    }
  },
};

/** Buch-skopierter Anfangszustand des Slices — vom Karten-Reset mitbenutzt. */
export const rechercheInterviewState = () => ({
  ivTranscript: null,
  ivSegments: [],
  ivSpeakers: {},
  ivSpeakerKeys: [],
  ivSpeakerDraft: {},
  ivCanTranscribe: false,
  ivUploading: false,
  ivRunningItemId: null,
  ivProgress: 0,
  ivStatus: '',
  ivError: '',
});
