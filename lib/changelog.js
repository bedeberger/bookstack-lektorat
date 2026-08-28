'use strict';
// Changelog — SSoT sind die JSON-Dateien in `changelog/` (eine pro Version,
// Dateiname = Version). Format + Pflegeregeln: changelog/README.md.
//
// Gelesen wird einmal beim Modul-Load (wie lib/version.js): ein Release bringt
// ohnehin einen Neustart mit, und ein Verzeichnis-Scan pro Kartenoeffnung waere
// Aufwand ohne Gegenwert.
//
// Zwei Konsumenten mit unterschiedlichem Bedarf:
//   - `getChangelog()`      — die vollstaendige Liste (Route GET /changelog,
//                             lazy beim Oeffnen des Reiters „Neuigkeiten").
//   - `getLatestVersion()`  — nur die Kopf-Version, damit /config den Neu-Punkt
//                             am Hilfe-Knopf entscheiden kann, ohne die ganze
//                             Liste in jede Boot-Antwort zu haengen.
//
// Ein Eintrag traegt `de` UND `en` (i18n-Regel: Changelog ist User-Text). Die
// Sortier-Achse ist die Version, nicht das Datum — ein nachgereichter Hotfix
// auf einem aelteren Zweig soll nicht vor der neueren Version stehen.

const fs = require('fs');
const path = require('path');
const logger = require('../logger');

const DIR = path.join(__dirname, '..', 'changelog');
const KINDS = new Set(['neu', 'verbessert', 'behoben']);
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/** Semver-Vergleich (absteigend: neueste Version zuerst). */
function _cmpDesc(a, b) {
  const pa = a.version.match(VERSION_RE);
  const pb = b.version.match(VERSION_RE);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pb[i]) - Number(pa[i]);
    if (d) return d;
  }
  return 0;
}

// Eine Datei zu einem Release-Objekt — oder null, wenn sie den Vertrag verletzt.
// Fehlerhafte Dateien werden uebersprungen und geloggt, nicht geworfen: ein
// Tippfehler im Changelog darf die App nicht am Start hindern.
function _parseFile(file) {
  const name = path.basename(file, '.json');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { logger.warn(`changelog: ${path.basename(file)} ist kein gueltiges JSON — uebersprungen (${e.message})`); return null; }

  const version = String(raw?.version || '').trim();
  if (!VERSION_RE.test(version)) { logger.warn(`changelog: ${path.basename(file)} hat keine gueltige version — uebersprungen.`); return null; }
  if (version !== name) { logger.warn(`changelog: ${path.basename(file)} nennt Version ${version} — Dateiname und Version muessen uebereinstimmen, uebersprungen.`); return null; }

  const date = String(raw?.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { logger.warn(`changelog: ${version} hat kein gueltiges date (YYYY-MM-DD) — uebersprungen.`); return null; }

  const entries = [];
  for (const e of Array.isArray(raw?.entries) ? raw.entries : []) {
    const kind = String(e?.kind || '').trim();
    const de = String(e?.de || '').trim();
    const en = String(e?.en || '').trim();
    if (!KINDS.has(kind) || !de || !en) {
      logger.warn(`changelog: ${version} enthaelt einen Eintrag ohne gueltiges kind/de/en — uebersprungen.`);
      continue;
    }
    entries.push({ kind, de, en });
  }
  if (!entries.length) { logger.warn(`changelog: ${version} hat keine gueltigen Eintraege — uebersprungen.`); return null; }

  return { version, date, entries };
}

let _releases = [];
try {
  _releases = fs.readdirSync(DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => _parseFile(path.join(DIR, f)))
    .filter(Boolean)
    .sort(_cmpDesc);
} catch (_) { /* Verzeichnis fehlt → leerer Changelog, kein Fehler */ }

/** Alle Releases, neueste Version zuerst. */
function getChangelog() {
  return _releases;
}

/** Version des neuesten Eintrags ('' wenn der Changelog leer ist). */
function getLatestVersion() {
  return _releases[0]?.version || '';
}

module.exports = { getChangelog, getLatestVersion };
