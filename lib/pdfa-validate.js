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
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const logger = require('../logger');

const BIN = process.env.VERAPDF_BIN || 'verapdf';
const FLAVOUR = process.env.VERAPDF_FLAVOUR || '2b';
const TIMEOUT_MS = 60_000;

function _isDisabled() {
  return process.env.VERAPDF_DISABLED === '1';
}

function _run(args) {
  return new Promise((resolve, reject) => {
    const child = execFile(BIN, args, { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') {
        const e = new Error('verapdf-not-installed');
        e.code = 'VERAPDF_MISSING';
        return reject(e);
      }
      resolve({ stdout, stderr, code: err ? err.code : 0 });
    });
    child.on('error', () => {});
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
  // veraPDF-CLI liest nicht von stdin (`-` wird als Filename interpretiert).
  // Buffer in Tempdatei mit .pdf-Extension schreiben, danach aufräumen.
  const tmpPath = path.join(os.tmpdir(), `verapdf-${crypto.randomBytes(8).toString('hex')}.pdf`);
  await fs.writeFile(tmpPath, buffer);
  let result;
  try {
    result = await _run(['--flavour', FLAVOUR, '--format', 'json', tmpPath]);
  } catch (e) {
    if (e.code === 'VERAPDF_MISSING') {
      logger.warn('veraPDF binary not found — PDF/A-Validierung übersprungen.');
      return { available: false, reason: 'binary-missing' };
    }
    throw e;
  } finally {
    fs.unlink(tmpPath).catch(() => {});
  }
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    logger.warn('veraPDF: stdout nicht JSON — Report verworfen.', { stderr: String(result.stderr || '').slice(0, 500) });
    return { available: false, reason: 'unparseable-output' };
  }
  // veraPDF-JSON: jobs[0].validationResult ist seit 1.30 ein Array (ein Eintrag
  // pro angefordertem Flavour); ältere Versionen lieferten ein Objekt.
  let vr = report?.report?.jobs?.[0]?.validationResult
        ?? report?.jobs?.[0]?.validationResult
        ?? null;
  if (Array.isArray(vr)) vr = vr[0] || null;
  const passed = !!(vr && vr.compliant);
  return { available: true, passed, report };
}

module.exports = { validatePdfa };
