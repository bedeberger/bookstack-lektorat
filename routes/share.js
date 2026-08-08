'use strict';
// Share-Link-Routes — Facade über routes/share/. Public-Reader (GET /share/:token,
// POST .../comment) + Auth-Owner-API (GET/POST/PATCH/DELETE /share/api/...).
//
// Mount in server.js VOR Auth-Guard, damit Reader-Route ohne Session erreichbar
// bleibt. Owner-API-Routen prüfen Session selbst (requireSession in share/api.js).
//
// Reader ZUERST registrieren: die `/:token`-Pattern (Single-Segment) und die
// `/api/...`-Routen (≥2 Segmente mit literalen Segmenten `api`/`comments`/`links`)
// kollidieren nicht, aber die Reihenfolge spiegelt die ursprüngliche Definition.
//
// Geteilte Helfer (Templates, Content-Rendering, data-bid-Auflösung,
// Kommentar-Serialisierung, Body-Parser): lib/share-helpers.js.

const express = require('express');
const router = express.Router();

// Geteilte Inhalte sind privat und duerfen NIE in einen Suchindex geraten.
// Der Header gilt fuer JEDE Antwort unter /share — Reader-HTML, Gone-Seite,
// Bild-Stream, JSON —, also auch fuer die Wege, die kein HTML-<head> haben,
// in den ein <meta name="robots"> passt. Die Meta-Tags in share.html und
// share.gone.html bleiben als zweite Schicht bestehen.
//
// Bewusst KEIN `Disallow: /share/` in der robots.txt (routes/public.js): ein
// Disallow verbietet das Abrufen und damit auch das Lesen dieses Headers — ein
// von aussen verlinkter Token koennte dann als reiner URL-Eintrag ohne Inhalt
// trotzdem im Index landen. Crawlen lassen + noindex ausliefern ist der
// einzige Weg, der die Seite verlaesslich wieder aus dem Index nimmt.
router.use((req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  next();
});

require('./share/reader').register(router);
require('./share/api').register(router);

module.exports = router;
