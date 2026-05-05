'use strict';
// Konvertiert Upload-Buffer in PDF/A-2B-taugliches JPEG:
//  - sRGB-Farbraum (CMYK / RGB-mit-Profil → sRGB; ICC im Output)
//  - kein Alpha-Channel (Transparenz auf Weiß flatten)
//  - max. 2400 px Längsseite
//  - JPEG-Qualität 88
//
// Wirft bei korrupten Eingaben oder unsupported Formaten. Magic-Bytes-Check
// vor sharp, damit nicht beliebige BLOBs an libvips wandern.

const sharp = require('sharp');

const MAX_INPUT_BYTES   = 20 * 1024 * 1024;
const MAX_OUTPUT_PIXELS = 2400;
const JPEG_QUALITY      = 88;

const MAGIC = [
  { bytes: [0xFF, 0xD8, 0xFF],                          mime: 'image/jpeg' },
  { bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], mime: 'image/png' },
  { bytes: [0x52, 0x49, 0x46, 0x46],                    mime: 'image/webp' }, // RIFF header
];

function detectMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  for (const m of MAGIC) {
    if (m.bytes.every((b, i) => buf[i] === b)) {
      // WebP zusätzlich auf "WEBP" an Offset 8 prüfen
      if (m.mime === 'image/webp' && buf.slice(8, 12).toString('ascii') !== 'WEBP') continue;
      return m.mime;
    }
  }
  return null;
}

/**
 * @param {Buffer} input  Upload-Buffer
 * @returns {Promise<{ buffer: Buffer, mime: 'image/jpeg', width: number, height: number }>}
 */
async function prepareCover(input) {
  if (!Buffer.isBuffer(input)) throw new Error('cover-not-buffer');
  if (input.length === 0) throw new Error('cover-empty');
  if (input.length > MAX_INPUT_BYTES) throw new Error('cover-too-large');

  const mime = detectMime(input);
  if (!mime) throw new Error('cover-unsupported-format');

  const img = sharp(input, { failOn: 'error' });
  const meta = await img.metadata();
  if (!meta.width || !meta.height) throw new Error('cover-no-dimensions');

  const longest = Math.max(meta.width, meta.height);
  const pipeline = img
    .rotate()                      // EXIF-Rotation anwenden
    .flatten({ background: '#ffffff' })  // Alpha auf weiß flatten
    .toColorspace('srgb');

  if (longest > MAX_OUTPUT_PIXELS) {
    pipeline.resize({
      width:  meta.width  >= meta.height ? MAX_OUTPUT_PIXELS : null,
      height: meta.height >  meta.width  ? MAX_OUTPUT_PIXELS : null,
      fit: 'inside',
      withoutEnlargement: true,
    });
  }

  const out = await pipeline
    .jpeg({ quality: JPEG_QUALITY, chromaSubsampling: '4:2:0', mozjpeg: false })
    .withMetadata({ icc: 'srgb' })
    .toBuffer({ resolveWithObject: true });

  return {
    buffer: out.data,
    mime: 'image/jpeg',
    width: out.info.width,
    height: out.info.height,
  };
}

module.exports = { prepareCover, detectMime, MAX_INPUT_BYTES };
