'use strict';
// Facade der Alters-Analyse (Job `figur-alter`). Reine Module unter
// lib/figure-age/ — Mustererkennung (patterns), Kandidatensuche (scan),
// Verdichtung (consolidate). Kein DB-, kein Netzzugriff in dieser Schicht.
//
// AGE_ANALYSIS_VERSION geht in die Inhaltssignatur des Laufs (`content_sig`):
// aendert sich hier die Logik oder der Prompt, matcht der Delta-Skip nicht mehr
// und der naechste Lauf rechnet neu.
const AGE_ANALYSIS_VERSION = 1;

const patterns = require('./figure-age/patterns');
const scan = require('./figure-age/scan');
const consolidate = require('./figure-age/consolidate');

module.exports = { AGE_ANALYSIS_VERSION, ...patterns, ...scan, ...consolidate };
