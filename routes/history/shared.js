'use strict';
// Geteilte Helfer/Konstanten der /history-Submodule.

const express = require('express');

const jsonBody = express.json();

// Grosser Limit fuer Routen, deren Body mit der Seitenzahl waechst: stats-stale
// traegt die vollstaendige { id, updated_at }-Liste (Tagebuecher haben tausende
// Seiten → Default-100-KB sprengt das mit 413), page-stats/batch ist der
// gleichfoermige Batch-Write-Endpunkt. Das Limit ist nur eine Obergrenze, kein
// Vorab-Alloc — kleine Bodies kosten nichts.
const jsonBodyLarge = express.json({ limit: '25mb' });

module.exports = { jsonBody, jsonBodyLarge };
