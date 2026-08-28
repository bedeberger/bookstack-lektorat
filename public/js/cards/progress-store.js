// Alpine.store('progress') — Tages-Schreibziel-State für den Header-Donut links
// neben dem Avatar. Liegt im Store (nicht in einer Karte), weil der Donut direkt
// im Root-Header-`<template>` rendert und unabhängig von der Buch-Overview-Karte
// sichtbar sein muss — es gibt keine Karte, die ihn hosten könnte.
//
// Kein Root-Proxy (wie nav/badges): Root-gespreadete Module (app-view/bookscope.js
// mit loadDailyProgress/resetDailyProgress/headerTodayRing, book-settings/settings.js)
// greifen via `this.$store.progress.*` bzw. `Alpine.store('progress').*` zu, das
// Header-Template via `$store.progress.*`.
//
// Zugleich der geteilte Landeplatz für `/history/book-stats/:bookId` und
// `/booksettings/:bookId`: Header-Donut UND Buch-Übersicht brauchen genau diese
// zwei Antworten. Sie zweimal zu holen hiess, bei jedem Buchwechsel vier
// Requests statt zwei zu schicken und danach zwei Kopien derselben Zeitreihe zu
// führen — von denen der Auto-Sync der Übersicht nur eine auffrischte, sodass
// der Header hinterher eine ältere Zahl zeigte. `loadDailyProgress` in
// app-view/bookscope.js ist der einzige Schreibpfad.
//
// Feld-Bedeutung:
//   dailyProgressBookId        — Buch, für das die Stats geladen sind (Stale-Gate).
//   dailyProgressStats         — rohe /history/book-stats/:bookId-Liste; Tagesdelta
//                                berechnet headerTodayRing() (computeTodayRing).
//   dailyProgressSettings      — rohe /booksettings/:bookId-Antwort. Der Header
//                                braucht zwei Felder daraus, die Übersicht fünf
//                                (Buchtyp, Schreibziel, Deadline) — darum liegt
//                                die ganze Antwort hier, nicht nur das Destillat.
//   dailyProgressIsFinished    — abgeschlossenes Buch → kein Donut.
//   dailyProgressDailyGoalChars— Zielzeichen/Tag (Default 1500, wenn null).
//   dailyProgressFailed        — Schlüssel der Endpoints, die auch nach Retry
//                                ausgefallen sind ('stats' | 'settings'); die
//                                Übersicht zeigt daraus ihren Fehlerhinweis.

export function registerProgressStore() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.store('progress', {
    dailyProgressBookId: null,
    dailyProgressStats: [],
    dailyProgressSettings: null,
    dailyProgressIsFinished: false,
    dailyProgressDailyGoalChars: null,
    dailyProgressFailed: [],
    // Header-Ring-Mini-Popover (heute · Serie · 7-Tage-Verlauf). UI-Toggle,
    // lebt hier weil der Ring direkt im Root-Header rendert (keine Host-Karte).
    popoverOpen: false,
  });
}
