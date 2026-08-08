// Reine Rechenkerne des Diktats — kein DOM, kein MediaRecorder, kein Netz.
// Darum ohne Browser testbar (tests/unit/stt-vad.test.mjs); die DOM- und
// Aufnahme-Pfade decken die E2E-Tests ab.
//
// Bleibt ein Methoden-Objekt (statt freier Funktionen), weil die Helfer sich
// gegenseitig ueber `this` rufen und alle vier Teilmodule in denselben
// Root-Scope gespreadet werden (siehe Facade ../stt-dictation.js).

const STT_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
];

// Bekannte Whisper-Halluzinationen bei stillen/unverstaendlichen Segmenten.
// EXACT trifft nur, wenn das ganze (normalisierte) Segment der Phrase gleicht;
// PATTERNS treffen eindeutige Untertitel-/Copyright-Marker, die in echtem
// Prosatext nicht vorkommen. Siehe `_isLikelyHallucination`.
const STT_HALLUCINATION_EXACT = new Set([
  'vielen dank',
  'vielen dank fürs zuschauen',
  'vielen dank fürs zuhören',
  'vielen dank für ihre aufmerksamkeit',
  'danke fürs zuschauen',
  'bis zum nächsten mal',
  'tschüss',
  'das war\'s',
  'untertitel',
  'untertitelung',
  'thank you',
  'thanks for watching',
]);
const STT_HALLUCINATION_PATTERNS = [
  /untertitel(ung)?\s+(des|der|im auftrag|von|aufgrund|erstellt)/i,
  /amara\.org/i,
  /\b(zdf|ard|wdr|swr|ndr|orf|srf)\b/i,
  /\bfunk\b[^.]*\b\d{4}\b/i,
  /^\s*copyright\b/i,
  /^\s*©/,
  /\buntertitel\b.*\b\d{4}\b/i,
];

export const sttComputeMethods = {

  // RMS aus einem Time-Domain-Sample (Uint8Array, zentriert um 128).
  _computeRms(timeDomain) {
    if (!timeDomain || !timeDomain.length) return 0;
    let sum = 0;
    for (let i = 0; i < timeDomain.length; i++) {
      const v = (timeDomain[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / timeDomain.length);
  },

  // Segment-Schnitt-Entscheidung. Schneidet, wenn nach erkannter Sprache eine
  // Stille von >= silenceMs anhaelt, oder wenn das Segment maxSegmentS
  // ueberschreitet (Schutz gegen Dauer-Sprechen ohne Pause).
  _computeVadCut({ rms, threshold, now, segmentStart, lastVoiceTs, hasVoice, silenceMs, maxSegmentS }) {
    const voiced = rms >= threshold;
    if (hasVoice && (now - segmentStart) >= maxSegmentS * 1000) {
      return { cut: true, reason: 'max', voiced };
    }
    if (hasVoice && !voiced && (now - lastVoiceTs) >= silenceMs) {
      return { cut: true, reason: 'silence', voiced };
    }
    return { cut: false, voiced };
  },

  // Beste vom Browser unterstuetzte MediaRecorder-Mime. isSupported ist die
  // injizierte MediaRecorder.isTypeSupported-Funktion (testbar).
  _computeSttMime(isSupported) {
    for (const c of STT_MIME_CANDIDATES) {
      if (isSupported(c)) return c;
    }
    return '';
  },

  // Normalisiert ein Transkript-Segment fuer die Einfuegung: trimmt, kollabiert
  // interne Whitespace-Folgen (Whisper liefert gelegentlich Doppel-Leerzeichen
  // oder Zeilenumbrueche) und tilgt ein Leerzeichen DIREKT vor Satzzeichen
  // („Wort , dann" -> „Wort, dann").
  _normalizeTranscript(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .replace(/\s+([,.;:!?…])/g, '$1')
      .trim();
  },

  // Schreibt den ersten Buchstaben gross (ggf. nach einem oeffnenden Zeichen wie
  // Anfuehrung/Klammer). No-op, wenn der Text mit Ziffer/Satzzeichen beginnt
  // oder schon gross ist. Pure/testbar.
  _capitalizeSentenceStart(text) {
    return String(text || '').replace(
      /^([\s"'»«„“‚‘(\[]*)(\p{L})/u,
      (_, pre, ch) => pre + ch.toUpperCase(),
    );
  },

  // True, wenn der vorausgehende Text auf einem Satzendezeichen endet — auch
  // wenn danach noch schliessende Anfuehrungs-/Klammerzeichen stehen
  // („…her.«", „…?"", „…!)"). So erkennen wir vom Modell gesetzte Satzzeichen
  // (Whisper punktiert selbst) und ergaenzen keinen eigenen Punkt. Pure/testbar.
  _endsSentence(prevText) {
    const s = String(prevText || '').replace(/[\s"'’”“»«)\]]+$/u, '');
    return /[.!?…]$/.test(s);
  },

  // Fuegt vor dem Transkript ein Leerzeichen ein, wenn unmittelbar davor ein
  // Nicht-Whitespace steht und der neue Text nicht mit Satzzeichen beginnt —
  // damit Worte ueber Segmentgrenzen hinweg nicht zusammenkleben.
  //
  // Satzgrenzen folgen ausschliesslich der Punktierung des Modells: NUR wenn der
  // Vortext (bzw. der Doc-/Block-Anfang) auf einem Satzendezeichen steht, wird
  // der erste Buchstabe gross geschrieben. Eine blosse Sprechpause (Atemholen)
  // ist KEIN Satzende — wir ergaenzen weder einen eigenen Punkt noch eine
  // Grossschreibung, weil Whisper selbst punktiert und grossschreibt. `prevText`
  // ist der (Teil-)Text links vom Caret; das letzte Zeichen bestimmt die
  // Leerzeichen-Heuristik, der getrimmte Schwanz die Satzende-Erkennung
  // (`_endsSentence` erkennt Satzzeichen auch hinter schliessender Anfuehrung).
  _computeSpacedInsert(prevText, text) {
    let t = this._normalizeTranscript(text);
    if (!t) return '';
    const prev = String(prevText || '');
    const prevChar = prev ? prev[prev.length - 1] : '';
    if (!prevChar || this._endsSentence(prev)) t = this._capitalizeSentenceStart(t);
    if (!prevChar) return t;
    if (/\s/.test(prevChar)) return t; // schon Whitespace davor
    const startsPunct = /^[\s,.;:!?…)»"'’-]/.test(t);
    return startsPunct ? t : ' ' + t;
  },

  // Whisper „halluziniert" bei stillen/unverstaendlichen Segmenten bekannte
  // Boilerplate-Phrasen (Video-Untertitel-Floskeln, Dank-/Abschiedsformeln).
  // True, wenn das GANZE Segment einer solchen Phrase entspricht — dann wird es
  // verworfen statt eingefuegt. Bewusst Whole-Segment-Match bzw. eindeutige
  // Marker (ZDF/ARD/Amara/funk/Copyright), damit legitimer Prosatext, der eine
  // dieser Floskeln enthaelt, nicht faelschlich getilgt wird. Pure/testbar.
  _isLikelyHallucination(text) {
    const norm = String(text || '')
      .replace(/\s+/g, ' ')
      .replace(/[.!?…»«„“”"'’\s]+$/u, '')
      .trim()
      .toLowerCase();
    if (!norm) return false;
    if (STT_HALLUCINATION_EXACT.has(norm)) return true;
    return STT_HALLUCINATION_PATTERNS.some((re) => re.test(text));
  },

  // Effektiver VAD-Threshold aus gemessenem Geraeuschboden: leicht ueber dem
  // Rauschen, nie unter dem Admin-Wert und auf das 5-Fache gedeckelt (verhindert
  // Ueber-Unterdrueckung, falls waehrend der Kalibrierung doch gesprochen wurde).
  // Pure/testbar.
  _computeNoiseThreshold(noiseFloor, base) {
    const b = Number(base) || 0;
    const cand = (Number(noiseFloor) || 0) * 1.8 + 0.004;
    return Math.min(Math.max(b, cand), Math.max(b * 5, 0.08));
  },

  // Plausibilisierung am Caret: liefert true, wenn ein Whitespace direkt vor
  // dem Caret getilgt werden soll, weil das neue Segment mit Satzzeichen
  // beginnt (sonst entstuende „Wort , dann"). Pure/testbar.
  _computeEatPrevSpace(prevChar, text) {
    const t = String(text || '').trim();
    if (!t) return false;
    return /\s/.test(prevChar) && /^[,.;:!?…]/.test(t);
  },
};
