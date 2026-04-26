'use strict';

// Einheitlicher Filename-Builder für User-Downloads (BookStack-Export,
// Finetune-Export, künftige Exports). Format: `<prefix>-<slug>-YYYY-MM-DD-hh-mm-ss.<ext>`.
// Lokale Server-Zeit, nicht UTC — User erwartet "jetzt", nicht ISO-Versatz.

function formatExportTimestamp(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
       + `-${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function slugify(name) {
  return (name || 'book')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'book';
}

function buildExportFilename({ prefix, slug, ext, date }) {
  return `${prefix}-${slugify(slug)}-${formatExportTimestamp(date)}.${ext}`;
}

module.exports = { formatExportTimestamp, slugify, buildExportFilename };
