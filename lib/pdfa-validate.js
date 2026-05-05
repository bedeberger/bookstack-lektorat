'use strict';
// veraPDF-CLI-Wrapper. Spawnt das Binary mit JSON-Report-Output und gibt einen
// strukturierten Bericht zurück.
//
// Wenn das Binary nicht verfügbar ist (Dev-Setups ohne veraPDF), liefert die
// Funktion `{ available: false }`. Der Job-Wrapper interpretiert das als
// „Validation skipped" und liefert das PDF trotzdem aus, mit einem Hinweis im
// Job-Result.
//
// Konfiguration:
//   VERAPDF_BIN  → Pfad zum verapdf-Binary (Default: 'verapdf' im PATH)
//   VERAPDF_FLAVOUR → '2b' Default
//   VERAPDF_DISABLED='1' überspringt Validierung komplett.

const { execFile } = require('child_process');
const logger = require('../logger');

const BIN = process.env.VERAPDF_BIN || 'verapdf';
const FLAVOUR = process.env.VERAPDF_FLAVOUR || '2b';
const TIMEOUT_MS = 60_000;

function _isDisabled() {
  return process.env.VERAPDF_DISABLED === '1';
}

function _run(args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(BIN, args, { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') {
        const e = new Error('verapdf-not-installed');
        e.code = 'VERAPDF_MISSING';
        return reject(e);
      }
      // Exit-Code 1 bei Validation-Fail ist NORMAL — wir parsen trotzdem stdout.
      resolve({ stdout, stderr, code: err ? err.code : 0 });
    });
    if (input) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

/**
 * Validiert einen PDF-Buffer gegen PDF/A-2B (oder konfigurierten Flavour).
 *
 * Returns:
 *   { available: false }                              — Binary fehlt / disabled
 *   { available: true, passed: boolean, report: object } — Standard-Fall
 *   wirft bei Spawn-Fehlern, die nicht ENOENT sind
 */
async function validatePdfa(buffer) {
  if (_isDisabled()) {
    return { available: false, reason: 'disabled' };
  }
  let result;
  try {
    result = await _run([
      '--flavour', FLAVOUR,
      '--format', 'json',
      '-',
    ], buffer);
  } catch (e) {
    if (e.code === 'VERAPDF_MISSING') {
      logger.warn('veraPDF binary not found — PDF/A-Validierung übersprungen.');
      return { available: false, reason: 'binary-missing' };
    }
    throw e;
  }
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    logger.warn('veraPDF: stdout nicht JSON — Report verworfen.');
    return { available: false, reason: 'unparseable-output' };
  }
  // Standard-veraPDF-JSON enthält jobs[0].validationResult.compliant boolean.
  const job = report?.report?.jobs?.[0]?.validationResult
            || report?.jobs?.[0]?.validationResult
            || null;
  const passed = !!(job && job.compliant);
  return { available: true, passed, report };
}

module.exports = { validatePdfa };
