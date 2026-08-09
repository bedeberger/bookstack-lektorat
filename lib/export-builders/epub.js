'use strict';
// Facade des EPUB-Exports (via epub-gen-memory). Die Umsetzung liegt in
// ./epub/: build (Orchestrator), css, matter (Titelei/Backmatter), content
// (HTML-Aufbereitung + Bild-Staging), opf, nav und cover. Externe Konsumenten
// importieren ausschliesslich diese Datei.

const { buildEpub, _resolveEpubMeta } = require('./epub/build');
const { _buildCss } = require('./epub/css');
const {
  _proseToXhtml, _buildFrontmatter, _buildImprintBackmatter,
  _buildBackmatter, _buildExtraSections,
} = require('./epub/matter');
const { _countUnfetchableImages, _applyBreaks, _dedupeIds } = require('./epub/content');
const { _buildOpfExtraMeta, _buildAccessibilityMeta, _buildContentOPF } = require('./epub/opf');
const { _buildLandmarksNav } = require('./epub/nav');
const { _buildCoverXhtml } = require('./epub/cover');

module.exports = {
  buildEpub,
  _resolveEpubMeta,
  _countUnfetchableImages,
  _buildFrontmatter,
  _buildBackmatter,
  _buildImprintBackmatter,
  _buildExtraSections,
  _proseToXhtml,
  _buildOpfExtraMeta,
  _buildAccessibilityMeta,
  _buildLandmarksNav,
  _buildContentOPF,
  _buildCoverXhtml,
  _buildCss,
  _applyBreaks,
  _dedupeIds,
};
