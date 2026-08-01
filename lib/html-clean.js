'use strict';

// Server-seitiger HTML-Sanitizer für BookStack-Page-Writes. Catched Doppel-Abstände
// (`<p></p>`, `<p><br></p>`, `<p>&nbsp;</p>`-Runs, `<br><br>`-Runs) bevor sie in
// BookStack landen — verhindert dass spätere Exporte oder Renderer doppelte
// Abstände zeigen. Spiegelung von public/js/utils.js (collapseEmptyBlocks +
// stripTrailingEmptyBlocks) auf linkedom. Idempotent.

const crypto = require('crypto');
const { parseHTML } = require('linkedom');

const _STRUCTURAL_LEAF = 'img,iframe,video,audio,table,figure,hr,object,embed,canvas,svg,input,button';

function _isBlankTrailing(node) {
  if (!node) return false;
  if (node.nodeType === 3) return !node.textContent.replace(/ /g, ' ').trim();
  if (node.nodeType !== 1) return false;
  const tag = node.tagName;
  if (tag !== 'P' && tag !== 'DIV' && tag !== 'BR') return false;
  if (tag === 'BR') return true;
  if ((node.textContent || '').replace(/ /g, ' ').trim()) return false;
  if (node.querySelector(_STRUCTURAL_LEAF)) return false;
  return true;
}

function _parseFragment(html) {
  const wrapped = '<!DOCTYPE html><html><body><div id="r">' + html + '</div></body></html>';
  const { document } = parseHTML(wrapped);
  return document.getElementById('r');
}

function _serialize(root) {
  let out = '';
  for (const child of root.childNodes) {
    out += child.nodeType === 3 ? child.textContent : (child.outerHTML || '');
  }
  return out;
}

// Bare Text-Nodes und Inline-Elemente direkt unter dem Root in <p> verpacken.
// BookStack speichert sonst die Roh-Bytes ohne Block-Wrapper (kein bkmrk-ID,
// kein Absatz-Margin). Pendant zu `normalizeEditorBlocks` in
// public/js/editor/edit.js. Idempotent.
const _ROOT_BLOCK_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'LI', 'PRE', 'UL', 'OL', 'TABLE',
  'FIGURE', 'HR', 'DIV', 'DL', 'SECTION', 'ARTICLE',
  'ASIDE', 'HEADER', 'FOOTER', 'NAV', 'MAIN', 'FORM',
]);

function wrapOrphanBlocks(html) {
  if (!html) return html;
  const root = _parseFragment(html);
  if (!root) return html;
  const doc = root.ownerDocument;
  let group = [];
  const flushBefore = (target) => {
    if (!group.length) return;
    const hasContent = group.some(n =>
      (n.nodeType === 3 && n.textContent.replace(/ /g, ' ').trim()) ||
      (n.nodeType === 1)
    );
    if (!hasContent) { group = []; return; }
    const p = doc.createElement('p');
    for (const n of group) p.appendChild(n);
    if (target) root.insertBefore(p, target);
    else root.appendChild(p);
    group = [];
  };
  const children = Array.from(root.childNodes);
  for (const child of children) {
    if (child.nodeType === 1 && _ROOT_BLOCK_TAGS.has(child.tagName)) {
      flushBefore(child);
    } else {
      group.push(child);
    }
  }
  flushBefore(null);
  return _serialize(root);
}

function collapseEmptyBlocks(html) {
  if (!html) return html;
  const root = _parseFragment(html);
  if (!root) return html;

  let node = root.firstChild;
  while (node) {
    const next = node.nextSibling;
    if (_isBlankTrailing(node)) {
      let probe = next;
      while (probe) {
        const probeNext = probe.nextSibling;
        if (probe.nodeType === 3 && !probe.textContent.replace(/ /g, ' ').trim()) {
          probe.remove();
          probe = probeNext;
          continue;
        }
        if (_isBlankTrailing(probe)) {
          probe.remove();
          probe = probeNext;
          continue;
        }
        break;
      }
    }
    node = next;
  }

  root.querySelectorAll('br').forEach(br => {
    let s = br.nextSibling;
    while (s) {
      const sn = s.nextSibling;
      if (s.nodeType === 3 && !s.textContent.replace(/ /g, ' ').trim()) {
        s.remove();
        s = sn;
        continue;
      }
      if (s.nodeType === 1 && s.tagName === 'BR') {
        s.remove();
        s = sn;
        continue;
      }
      break;
    }
  });

  return _serialize(root);
}

// Editor-Cursor-Anker (`&#160;` am Block-Ende) erzeugen Phantom-Revisionen:
// byte-different, aber visuell identisch (NBSP kollabiert in jeder Stats-/
// Diff-Pipeline). Pre-Persist pro Block leading/trailing Whitespace inkl.
// NBSP aus dem ersten/letzten Text-Node strippen — mid-Block-NBSPs bleiben.
const _EDGE_TRIM_BLOCKS = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,div,td,th,dd,dt,figcaption';

function _firstTextNodeIn(el) {
  let n = el.firstChild;
  while (n) {
    if (n.nodeType === 3) return n;
    if (n.nodeType === 1) {
      const inner = _firstTextNodeIn(n);
      if (inner) return inner;
    }
    n = n.nextSibling;
  }
  return null;
}
function _lastTextNodeIn(el) {
  let n = el.lastChild;
  while (n) {
    if (n.nodeType === 3) return n;
    if (n.nodeType === 1) {
      const inner = _lastTextNodeIn(n);
      if (inner) return inner;
    }
    n = n.previousSibling;
  }
  return null;
}

function stripBlockEdgeNbsp(html) {
  if (!html) return html;
  const root = _parseFragment(html);
  if (!root) return html;
  // JS `\s` matcht NBSP ( ) und alle anderen Unicode-Whitespaces.
  for (const el of root.querySelectorAll(_EDGE_TRIM_BLOCKS)) {
    const last = _lastTextNodeIn(el);
    if (last) last.textContent = last.textContent.replace(/[\s ]+$/u, '');
    const first = _firstTextNodeIn(el);
    if (first) first.textContent = first.textContent.replace(/^[\s ]+/u, '');
  }
  return _serialize(root);
}

// `<div>` ist im Focus-Editor (public/js/editor/focus/constants.js) nicht in
// BLOCK_TAGS. Folge: die CSS-Dim-Rule (focus-mode.css, `:is(p, h1..h6, …)`)
// dimmt `<div>`-Blöcke nicht, sie bleiben permanent opacity 1 und wirken wie
// dauerhaft hervorgehoben, während rundherum `<p>` faded. Zusätzlich findet
// `findBlockFromNode` keinen Active-Block, der Cursor wirkt „eingefroren".
// Legacy-Pages (BookStack-Editor-Reste) enthalten teils flache `<div>`-
// Absätze; hier zu `<p>` normalisieren. `div.poem` bleibt — dort ist `<div>`
// strukturell gewollt (siehe lib/pdf-render/html-walker.js#poem).
const _DIV_BLOCK_DESCENDANT_SEL = 'p,h1,h2,h3,h4,h5,h6,ul,ol,li,blockquote,pre,table,div,figure,hr,section,article,aside,header,footer,nav,main,form';

function _hasPoemClass(el) {
  const cls = el.getAttribute('class') || '';
  return cls.split(/\s+/).includes('poem');
}

function flattenDivBlocks(html) {
  if (!html) return html;
  const root = _parseFragment(html);
  if (!root) return html;
  const doc = root.ownerDocument;
  let guard = 16;
  let changed = true;
  while (changed && guard-- > 0) {
    changed = false;
    for (const div of Array.from(root.querySelectorAll('div'))) {
      if (_hasPoemClass(div)) continue;
      if (div.querySelector(_DIV_BLOCK_DESCENDANT_SEL)) continue;
      const p = doc.createElement('p');
      for (const attr of Array.from(div.attributes)) p.setAttribute(attr.name, attr.value);
      while (div.firstChild) p.appendChild(div.firstChild);
      div.replaceWith(p);
      changed = true;
    }
  }
  return _serialize(root);
}

// Bare http(s)-URLs in Text-Nodes zu `<a>` wrappen. Idempotent (überspringt
// Text in `<a>`, `<pre>`, `<code>`). Trailing-Satzzeichen (. , ; : ! ? ) ] })
// bleiben ausserhalb des Link-Tags. Läuft im Save-Pfad — User-getippte/-
// gepastete URLs werden persistent klickbar.
const _URL_RE = /https?:\/\/[^\s<]+/g;
const _LINKIFY_SKIP_ANCESTOR = new Set(['A', 'PRE', 'CODE']);

function _isInsideSkipAncestor(node) {
  let p = node.parentNode;
  while (p && p.nodeType === 1) {
    if (_LINKIFY_SKIP_ANCESTOR.has(p.tagName)) return true;
    p = p.parentNode;
  }
  return false;
}

function _trimTrailingPunct(url) {
  let cut = 0;
  for (let i = url.length - 1; i >= 0; i--) {
    const c = url[i];
    if (/[.,;:!?)\]}»"']/.test(c)) cut++;
    else break;
  }
  return cut > 0 ? { url: url.slice(0, -cut), tail: url.slice(-cut) } : { url, tail: '' };
}

function linkifyBareUrls(html) {
  if (!html) return html;
  if (!html.includes('http')) return html;
  const root = _parseFragment(html);
  if (!root) return html;
  // Entities (`&amp;` in Query-Strings) zerlegen den Parser-Output in mehrere
  // benachbarte Text-Nodes (`…?a=1` | `&` | `b=2`). Ohne Merge linkt der Walker
  // nur bis zur ersten Entity und lässt den URL-Rest als Klartext stehen.
  root.normalize();
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, 0x4); // NodeFilter.SHOW_TEXT = 4
  const candidates = [];
  let cur = walker.nextNode();
  while (cur) {
    if (!_isInsideSkipAncestor(cur) && /https?:\/\//.test(cur.textContent)) {
      candidates.push(cur);
    }
    cur = walker.nextNode();
  }
  for (const textNode of candidates) {
    const text = textNode.textContent;
    const matches = [...text.matchAll(_URL_RE)];
    if (matches.length === 0) continue;
    const frag = doc.createDocumentFragment();
    let last = 0;
    for (const m of matches) {
      const start = m.index;
      const rawMatch = m[0];
      const { url, tail } = _trimTrailingPunct(rawMatch);
      if (!url) continue;
      if (start > last) frag.appendChild(doc.createTextNode(text.slice(last, start)));
      const a = doc.createElement('a');
      a.setAttribute('href', url);
      a.textContent = url;
      frag.appendChild(a);
      if (tail) frag.appendChild(doc.createTextNode(tail));
      last = start + rawMatch.length;
    }
    if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)));
    textNode.parentNode.replaceChild(frag, textNode);
  }
  return _serialize(root);
}

function stripTrailingEmptyBlocks(html) {
  if (!html) return html;
  const root = _parseFragment(html);
  if (!root) return html;
  let last = root.lastChild;
  while (last && _isBlankTrailing(last)) {
    const prev = last.previousSibling;
    root.removeChild(last);
    last = prev;
  }
  return _serialize(root);
}

// Stabile Block-IDs (`data-bid`) auf allen Block-Level-Elementen. Basis für
// den Block-Level-Merge (lib/block-merge.js): pro Block eine 8-Byte-Hex-ID, die
// über Saves stabil bleibt, sodass beim Stale-Write-Konflikt blockweise gemerged
// werden kann statt Last-Write-Wins. Idempotent: bestehende `data-bid`s bleiben,
// nur fehlende werden vergeben. Duplikate (Copy-Paste eines Blocks samt ID)
// bekommen ab dem zweiten Vorkommen eine neue ID — sonst kollidieren sie im Merge.
// Tabellen/Figuren zählen als ein Block (innere Zellen nicht mergebar).
const _BID_BLOCK_SEL = 'p,h1,h2,h3,h4,h5,h6,ul,ol,blockquote,pre,hr,figure,table';

function _newBid() { return crypto.randomBytes(8).toString('hex'); }

function ensureBlockIds(html) {
  if (!html) return html;
  const root = _parseFragment(html);
  if (!root) return html;
  const seen = new Set();
  for (const el of root.querySelectorAll(_BID_BLOCK_SEL)) {
    let bid = el.getAttribute('data-bid');
    if (!bid || seen.has(bid)) bid = _newBid();
    el.setAttribute('data-bid', bid);
    seen.add(bid);
  }
  // `div.poem` ist ein gewollter Block (siehe flattenDivBlocks/pdf-render); der
  // generische `div`-Selektor würde Wrapper-Divs mit-taggen, darum separat.
  for (const div of root.querySelectorAll('div')) {
    if (!_hasPoemClass(div)) continue;
    let bid = div.getAttribute('data-bid');
    if (!bid || seen.has(bid)) bid = _newBid();
    div.setAttribute('data-bid', bid);
    seen.add(bid);
  }
  return _serialize(root);
}

// Transiente Editor-UI, die als Kind im contenteditable lebt: das
// LanguageTool-Popover und sein Status-Badge. Speichert ein Client bei offenem
// Popover, wandert das komplette UI-Markup (Buttons, SVG-Icons) als Inhalt in
// die Revision und kommt beim naechsten Laden als Text zurueck. Client-Pendant
// ist stripLektoratMarks in public/js/editor/shared/html-clean.js — hier als
// Gürtel-und-Hosenträger, damit auch ein alter Client nichts einschmuggelt.
const _UI_ARTEFACT_SEL = '.lt-popover,.lt-badge';

// `contenteditable` ist reine Editor-Laufzeit und gehoert nie in die Persistenz.
// Der Beleg-Chip (public/js/sources/cite-html.js) bekommt es beim Mount gesetzt,
// damit der Caret ihn ueberspringt; ohne dieses Strippen wanderte das Attribut in
// den gespeicherten Text und von dort in den WordPress-Post.
function stripEditorUiArtefacts(html) {
  if (!html) return html;
  const hasArtefact = html.indexOf('lt-popover') !== -1 || html.indexOf('lt-badge') !== -1;
  const hasEditableAttr = html.indexOf('contenteditable') !== -1;
  if (!hasArtefact && !hasEditableAttr) return html;
  const root = _parseFragment(html);
  if (!root) return html;
  if (hasArtefact) root.querySelectorAll(_UI_ARTEFACT_SEL).forEach(el => el.remove());
  if (hasEditableAttr) {
    root.querySelectorAll('[contenteditable]').forEach(el => el.removeAttribute('contenteditable'));
  }
  return _serialize(root);
}

// Aktive Inhalte aus Page-HTML entfernen: `<script>`-Elemente, Event-Handler-
// Attribute (`onerror`, `onclick`, …) und Script-URLs in Link-/Quell-Attributen.
//
// Why: Seiten-HTML wird an mehreren Stellen unescaped in eine Seite gerendert —
// am kritischsten `content_html` in der öffentlichen SSR-Leseansicht des
// Share-Links ([routes/share/reader.js]). Dass daraus bisher kein Stored XSS
// wird, hängt allein an der CSP ohne `'unsafe-inline'` im `script-src`
// ([server.js]#buildCspHeader) — eine einzige Direktive als einzige Schicht.
// Der Editor selbst kann nichts davon erzeugen; die Schreibwege sind aber offen
// (`POST /content/…`, Blog-Import, Migration-Bundle, Fassungs-Restore), und HTML
// aus fremder Quelle darf nicht darauf angewiesen sein, dass eine Header-Zeile
// stimmt.
//
// Bewusst KEIN Tag-Allowlist-Sanitizer: `iframe`/`object` (WordPress-Embeds in
// Blog-Büchern), `style`-Blöcke, `data:`-Bild-URIs (Fassungs-Export) und die
// Marker-Spans der Quellen-/Querverweis-SSoT müssen durchgehen. Entfernt wird
// nur, was Skript AUSFÜHRT — nicht, was Inhalt darstellt.
// Der Vorab-Test läuft auf der von Whitespace/Steuerzeichen befreiten Fassung,
// nicht auf dem Rohstring: `java\tscript:` navigiert im Browser, würde aber an
// einem Muster mit `javascript` vorbeilaufen und damit den Fast-Path nehmen.
// Falsch-Positive (Prosa über „JavaScript", ein Attribut wie `data-position=`)
// kosten nur einen Parse in einer Pipeline, die ohnehin mehrfach parst.
const _ACTIVE_PROBE = /<script|on[a-z]+=|javascript:|vbscript:|data:text\/html/i;

function _mayContainActive(html) {
  return _ACTIVE_PROBE.test(html.replace(/[\u0000-\u0020]+/g, ''));
}

// Attribute, deren Wert der Browser als URL lädt bzw. navigiert.
const _URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'poster', 'data', 'xlink:href']);

// Whitespace und Steuerzeichen fallen bei der Scheme-Erkennung des Browsers weg
// (`java\tscript:` navigiert) — für den Vergleich also erst wegräumen. Der Wert
// selbst wird nicht umgeschrieben, nur das Attribut ganz entfernt oder behalten.
function _isScriptUrl(value) {
  const v = String(value || '').replace(/[\u0000-\u0020]+/g, '').toLowerCase();
  return v.startsWith('javascript:') || v.startsWith('vbscript:') || v.startsWith('data:text/html');
}

function stripActiveContent(html) {
  if (!html) return html;
  if (!_mayContainActive(html)) return html; // Fast-Path: der Normalfall parst nicht
  const root = _parseFragment(html);
  if (!root) return html;
  root.querySelectorAll('script').forEach(el => el.remove());
  for (const el of root.querySelectorAll('*')) {
    for (const attr of Array.from(el.attributes)) {
      const name = String(attr.name || '').toLowerCase();
      if (name.startsWith('on')) { el.removeAttribute(attr.name); continue; }
      if (_URL_ATTRS.has(name) && _isScriptUrl(attr.value)) el.removeAttribute(attr.name);
    }
  }
  return _serialize(root);
}

// Defense-in-Depth Sanitizer für Page-HTML auf Schreibvorgängen Richtung BookStack.
// Reihenfolge: aktive Inhalte zuerst raus (jede folgende Stufe klont Attribute
// zwischen Elementen — flattenDivBlocks trägt sie vom `<div>` ans neue `<p>`;
// ein `onclick` würde also überleben, wenn es erst später fiele), dann
// UI-Artefakte (sonst macht flattenDivBlocks aus dem Popover-<div> Absätze),
// dann orphan Text-/Inline-Runs in <p> verpacken, danach Leer-Blöcke
// kollabieren — sonst sieht collapseEmptyBlocks die Roh-Bytes ohne Block-Struktur.
function cleanPageHtml(html) {
  if (!html || typeof html !== 'string') return html;
  const out = stripTrailingEmptyBlocks(
    stripBlockEdgeNbsp(
      collapseEmptyBlocks(wrapOrphanBlocks(flattenDivBlocks(linkifyBareUrls(stripEditorUiArtefacts(stripActiveContent(html))))))
    )
  );
  return out || '<p></p>';
}

module.exports = { cleanPageHtml, ensureBlockIds, wrapOrphanBlocks, collapseEmptyBlocks, stripTrailingEmptyBlocks, stripBlockEdgeNbsp, flattenDivBlocks, linkifyBareUrls, stripEditorUiArtefacts, stripActiveContent };
