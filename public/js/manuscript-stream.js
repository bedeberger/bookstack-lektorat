// Kanonisches Manuskript-Stream-Modell: eine Sequenz aus Kapitel-Headern und
// Seiten-Blöcken in Lesereihenfolge. Geteilte Quelle für die drei Konsumenten,
// die ein Buch als durchgehenden Stream darstellen:
//   - Bucheditor      (fromPages, wrappt Page-Entries mit Editor-State)
//   - Fassungen-Reader (fromSnapshotTree)
//   - Share/Teilen-SSR (fromGroups, serverseitig via dynamic import())
//
// PURE + ISOMORPH: kein DOM-/Alpine-/Browser-Zugriff, damit der Express-Server
// das Modul wie public/js/prompts.js per dynamic import() laden kann. HTML wird
// VERBATIM durchgereicht (bereits via lib/html-clean.js sanitisiert) — hier
// nicht escapen, nicht strippen (stripFocusArtefacts gehört in den Editor-
// Wrapper, der browser-only ist).
//
// StreamEntry =
//   | { kind:'chapter', name, depth, key, chapterId? }
//   | { kind:'page',    name, depth, key, id, html, chapterId?, headBefore?, headAfter?, article? }
// `id` = einheitliche Seiten-Identität (pageId | srcId | pd.id), am Adapter-Rand
// normalisiert. `key` = positionsbasiert, deterministisch ('c'+i / 'p'+i).
//
// `headBefore`/`headAfter` sind FERTIGES Markup, das der Renderer über bzw.
// unter die Seitenüberschrift stellt (Dachzeile und Lead der Titel-Werkstatt).
// Dieses Modul baut es NICHT selbst: die Markup-SSoT ist lib/headline-render.js,
// und die ist CommonJS — hier stünde sonst eine zweite Kopie der Klassennamen.
// Der Adapter bekommt sie deshalb als Callback herein (siehe `opts.pageHead`).

function _str(v) {
  return typeof v === 'string' ? v : '';
}

function _pushChapter(out, name, depth, chapterId) {
  out.push({ kind: 'chapter', name: name || '', depth, key: 'c' + out.length, chapterId: chapterId ?? null });
}

function _pushPage(out, { name, html, id, depth, chapterId, headBefore, headAfter, article }) {
  out.push({
    kind: 'page', name: name || '', html: html || '', id: id ?? null,
    depth, key: 'p' + out.length, chapterId: chapterId ?? null,
    headBefore: headBefore || '', headAfter: headAfter || '', article: !!article,
  });
}

// Bucheditor-Quelle: server-vorsortierte Page-Liste aus /book-editor/:id/contents.
// Flach (depth 0); Chapter-Header bei jedem chapterId-Wechsel, Solo-Pages
// (chapterId null/0) erzeugen keinen Header.
export function fromPages(pages) {
  const out = [];
  let lastChapterId = undefined;
  for (const p of pages || []) {
    if (p.chapterId !== lastChapterId) {
      lastChapterId = p.chapterId;
      if (p.chapterId) _pushChapter(out, p.chapterName, 0, p.chapterId);
    }
    _pushPage(out, { name: p.pageName, html: p.html, id: p.pageId, depth: 0, chapterId: p.chapterId });
  }
  return out;
}

// Fassungs-Quelle: selbsttragender Snapshot-Tree (buildBookJson-Format,
// node.type 'chapter'|'page', verschachtelte children). Echtes Nesting → depth.
// srcId (alte page_id) → id.
export function fromSnapshotTree(tree) {
  const nodes = Array.isArray(tree) ? tree : [];
  const out = [];
  (function walk(list, depth) {
    for (const node of (list || [])) {
      if (!node || typeof node !== 'object') continue;
      if (node.type === 'chapter') {
        _pushChapter(out, _str(node.name), depth, null);
        walk(node.children, depth + 1);
      } else if (node.type === 'page') {
        _pushPage(out, {
          name: _str(node.name),
          html: _str(node.html),
          id: Number.isFinite(node.srcId) ? node.srcId : null,
          depth,
        });
      }
    }
  })(nodes, 0);
  return out;
}

// Share-/Export-Quelle: loadContents().groups = [{ chapterId, chapter, pages:[{ p, pd }] }].
// Bereits kapitel-gruppiert + flach (keine Sub-Kapitel-Tiefe) → depth 0,
// Chapter-Header nur bei gesetztem chapter. pd.id → id.
//
// `opts.pageHead(p, pd)` darf je Seite `{ name, before, after }` liefern und
// damit den Titel-Kopf beisteuern (Aufrufer: lib/share-helpers.js mit
// lib/headline-render.js). Fehlt der Callback, bleibt alles wie gehabt — dieses
// Modul kennt die Titel-Werkstatt nicht.
export function fromGroups(groups, opts = {}) {
  const head = typeof opts.pageHead === 'function' ? opts.pageHead : null;
  const out = [];
  for (const g of (groups || [])) {
    if (g && g.chapter) _pushChapter(out, g.chapter.name || g.chapter.chapter_name, 0, g.chapterId ?? g.chapter.id ?? null);
    for (const { p, pd } of (g && g.pages ? g.pages : [])) {
      if (!pd) continue;
      const h = head ? (head(p || pd, pd) || null) : null;
      _pushPage(out, {
        name: (h && h.name) || pd.name,
        html: pd.html, id: pd.id, depth: 0, chapterId: g.chapterId ?? null,
        headBefore: h && h.before, headAfter: h && h.after, article: !!h,
      });
    }
  }
  return out;
}
