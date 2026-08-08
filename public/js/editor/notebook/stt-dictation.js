// STT-Diktat (nur Notebook-Editor) — Facade. Mic-Button in der Notebook-Toolbar
// nimmt kontinuierlich auf; browserseitiges VAD (WebAudio-RMS) schneidet an
// Sprechpausen ab. Jedes abgeschlossene Segment geht an /stt/transcribe; der
// zurueckkommende Text wird verbatim am Cursor eingefuegt, waehrend schon das
// naechste Segment laeuft.
//
// Diese Methoden werden in den Root (`Alpine.data('lektorat')`) gespreaded —
// die Notebook-Icon-Bar laeuft im Root-Scope (wie notebookUndo/Entity-Toggle).
// Deshalb liegen die vier Teile hier in EINEM Objekt: sie rufen sich gegenseitig
// ueber `this`, und der gemeinsame Runtime-Container `_sttRt` gehoert allen.
//
// Sprache loest der Proxy aus der Buch-Locale auf; das Frontend schickt nur
// `bookId`.
//
// Aufteilung unter stt/ — die vier Teile haben verschiedene Testbarkeit und
// verschiedene Fehlerbilder:
//   compute.js    reine Rechenkerne (RMS, Schnitt-Entscheidung, Mime-Wahl,
//                 Leerzeichen-/Satzgrenzen-Heuristik, Halluzinations-Filter).
//                 Ohne Browser testbar — tests/unit/stt-vad.test.mjs.
//   recorder.js   Lifecycle, Start/Stop, VAD-Tick, Segmentierung.
//   transport.js  Upload an /stt/transcribe samt Retry-Politik.
//   insert.js     Einfuegen ins contenteditable (Caret-Anker, Absatz-Pfad).
//
// Externer Einstieg ist ausschliesslich diese Datei (`sttDictationMethods`) —
// Konsumenten: public/js/app.js, tests/unit/stt-vad.test.mjs und
// tests/fixtures/stt-harness.html.

import { sttComputeMethods } from './stt/compute.js';
import { sttRecorderMethods } from './stt/recorder.js';
import { sttTransportMethods } from './stt/transport.js';
import { sttInsertMethods } from './stt/insert.js';

export const sttDictationMethods = {
  ...sttComputeMethods,
  ...sttRecorderMethods,
  ...sttTransportMethods,
  ...sttInsertMethods,
};
