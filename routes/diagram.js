'use strict';

// Diagramm-Rendering fuer die Bildschirm-Leseansichten.
//
// WARUM DIESE ROUTE EXISTIERT: mermaid ist mit 3,4 MB (~1 MB gzip) die groesste
// Lib im Bestand. Sie nur zu laden, um ein fertiges Bild anzuzeigen, ist der
// falsche Preis — der Server kann dasselbe SVG liefern, hat den Renderer fuer
// die Exportwege ohnehin und cached inhaltsadressiert (lib/diagram-cache.js).
// Der Client-Bundle bleibt fuer die zwei Faelle, in denen er unersetzlich ist:
// die Live-Vorschau im Diagramm-Dialog (Tippen braucht sofortige Rueckmeldung,
// kein Roundtrip) und der Rueckfall, wenn hier nicht gerendert werden kann.
//
// SYNCHRONER PROXY, bewusst keine Job-Queue — wie /languagetool, /tts und
// /geocode: kein `callAI`, keine Token, Antwortzeit im Bereich einer Interaktion
// und ohne Nutzen als Verlaufseintrag. Die Job-Queue-Regel gilt fuer KI-Calls.
//
// DREI ANTWORTFORMEN, und die Unterscheidung ist der ganze Punkt:
//   200 { svg }                             — gerendert (oder aus dem Cache)
//   422 DIAGRAM_INVALID                     — DIESES Diagramm rendert nicht
//                                             (Syntaxfehler im Quelltext).
//                                             Der Client zeigt seine Fehlerzeile
//                                             und laedt NICHTS nach.
//   503 DIAGRAM_RENDERER_UNAVAILABLE        — hier rendert gar nichts (Chromium
//                                             fehlt, Feature abgeschaltet). Der
//                                             Client faellt auf den Bundle
//                                             zurueck.
// Ohne diese Trennung zoege ein einziges kaputtes Diagramm 3,4 MB nach.

const express = require('express');
const logger = require('../logger');
const { renderCachedDiagram } = require('../lib/diagram-cache');
const { rendererUnavailable } = require('../lib/mermaid-render');
const { mermaidHtml } = require('../lib/esm-bridge');

const router = express.Router();

router.post('/render', express.json({ limit: '64kb' }), async (req, res) => {
  const code = String(req.body?.code || '').trim();
  const theme = req.body?.theme === 'dark' ? 'dark' : 'default';
  if (!code) return res.status(400).json({ error_code: 'DIAGRAM_CODE_REQUIRED' });

  // Laengendeckel aus der Markup-SSoT, nicht als Kopie: derselbe Wert begrenzt
  // schon den Dialog. Ein Diagramm mit 5000 Knoten blockiert den Renderer.
  const { DIAGRAM_MAX_CHARS } = await mermaidHtml();
  if (code.length > DIAGRAM_MAX_CHARS) {
    return res.status(413).json({ error_code: 'DIAGRAM_TOO_LARGE', max: DIAGRAM_MAX_CHARS });
  }

  // Vorab-Auskunft: ist bekannt, dass nichts rendert, kostet der Versuch nur
  // Zeit. Der Client soll seinen Rueckfall sofort nehmen.
  if (rendererUnavailable()) {
    return res.status(503).json({ error_code: 'DIAGRAM_RENDERER_UNAVAILABLE' });
  }

  let asset = null;
  try {
    asset = await renderCachedDiagram(code, theme);
  } catch (e) {
    logger.warn(`[diagram] Render fehlgeschlagen: ${e.message}`);
  }
  if (asset?.svg) return res.json({ svg: asset.svg });

  // Der Versuch selbst kann erst gezeigt haben, dass Chromium fehlt.
  if (rendererUnavailable()) {
    return res.status(503).json({ error_code: 'DIAGRAM_RENDERER_UNAVAILABLE' });
  }
  return res.status(422).json({ error_code: 'DIAGRAM_INVALID' });
});

module.exports = router;
