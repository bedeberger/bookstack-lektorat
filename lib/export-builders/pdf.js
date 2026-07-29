'use strict';
// Sync-PDF-Builder. Verwendet das Default-Profil aus lib/pdf-export-defaults
// (keine User-Profile, kein Cover, keine Custom-Font) und ruft renderPdfBuffer.
// Custom-PDF-Job (routes/jobs/pdf-export.js) laeuft direkt gegen renderPdfBuffer
// mit User-Profil; dieser Wrapper ist nur fuer den `GET /export/:scope/:id/pdf`-
// Schnellpfad.

const { renderPdfBuffer } = require('../pdf-render');
const { defaultConfig } = require('../pdf-export-defaults');

async function buildPdf({ scope, book, chapter, page, groups }, { token, lang, bibliography = null } = {}) {
  const profile = {
    name: 'default',
    config: defaultConfig(),
    has_cover: false,
  };
  // Sync-Pfad rendert ohne PDF/A-Validation (Job-Pfad uebernimmt das fuer
  // druckfertige Exports). Aktiv lassen erzwingt sonst veraPDF-Aufruf bei jedem
  // Quick-Download.
  profile.config.pdfa.enabled = false;
  // Quellen-Chips + Verzeichnis wie im Job-Pfad — renderPdfBuffer loest die Chips
  // selbst auf (resolveCitesInGroups) und haengt das Verzeichnis an.
  return renderPdfBuffer({
    book, groups, profile,
    coverBuf: null, token, lang,
    scope, chapter, page, bibliography,
  });
}

module.exports = { buildPdf };
