// DOM-Seite des Normalisierers: Text-Nodes einsammeln, zu einem Zeichenstrom
// verketten, den Strom einmal durchlaufen und die Nodes zurückschreiben.
//
// Der Zeichenstrom ist der Grund, warum Seiten- und Selection-Scope dieselbe
// Logik fahren: Lookahead, Runs über Inline-Tag-Grenzen (`«<em>‹`), Innen-
// Space-Strip über Node-Grenzen und der Nesting-Stack hängen alle daran, den
// Text linear zu sehen. Der Range-Scope markiert lediglich Zeichen als
// nicht-editierbar — sie fliessen unverändert durch, liefern aber Kontext und
// bewegen den Stack, damit ein selektiertes Inner-Quote die Tiefe kennt.
//
// Skip: <pre>, <code>, <script>, <style>.

import { SPACES, isDoubleQuote, isSingleQuote, isQuoteGlyph } from './styles.js';
import { isApostrophe, resolveRun } from './classify.js';
import { composeBlockSel } from '../dom-block.js';

// Blöcke, innerhalb derer Anführungszeichen normalisiert werden. Kein `pre`
// (steht in SKIP_SEL — Code bleibt unangetastet), dafür Tabellenzellen und
// Gedichtzeilen. Eigener Name, weil der Inhalt sich von den Editor-Selektoren
// unterscheidet; Kern kommt aus shared/dom-block.js.
const QUOTE_BLOCK_SEL = composeBlockSel('td', 'th', 'div.poem');
const SKIP_SEL  = 'pre, code, script, style';

// Eigene Walk-Logik statt TreeWalker — linkedom (Unit-Test-Umgebung) ignoriert
// den acceptNode-Filter und würde Text-Nodes in <pre>/<code> mit-transformieren.
// `innerBlockSel` (optional) stoppt die Rekursion an Block-Elementen — die
// laufen als eigener Durchgang, sonst leakt der Zustand zwischen Geschwister-
// Paragraphen einer Blockquote/Liste. `<br>` wird als Marker mitgesammelt:
// weiche Zeilengrenze innerhalb eines Blocks (Dialog je Zeile).
function _collectTextNodes(root, out, innerBlockSel) {
  for (let n = root.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 3) {
      const parent = n.parentElement;
      if (parent && parent.closest(SKIP_SEL)) continue;
      out.push(n);
    } else if (n.nodeType === 1) {
      if (n.nodeName === 'BR') { out.push(n); continue; }
      if (n.matches && n.matches(SKIP_SEL)) continue;
      if (innerBlockSel && n.matches && n.matches(innerBlockSel)) continue;
      _collectTextNodes(n, out, innerBlockSel);
    }
  }
}

function _isBr(node) {
  return node.nodeType === 1 && node.nodeName === 'BR';
}

// Nächster QUOTE_BLOCK_SEL-Ancestor. Nur im Range-Scope nötig, wo über Block-Grenzen
// hinweg gesammelt wird, der Zustand aber je Block frisch sein muss.
function _closestBlock(node, root) {
  let n = node.parentElement;
  while (n) {
    if (n === root) return root;
    if (n.matches && n.matches(QUOTE_BLOCK_SEL)) return n;
    n = n.parentElement;
  }
  return root;
}

// Zeichenstrom: ein Eintrag je Quellzeichen (`{ n, ch, editable }`) plus
// Grenzmarker (`{ boundary: true }`) für <br> und Blockwechsel.
function _buildStream(textNodes, range, common) {
  const items = [];
  let lastBlock = null;
  for (let n = 0; n < textNodes.length; n++) {
    const node = textNodes[n];
    if (_isBr(node)) {
      items.push({ boundary: true });
      if (common) lastBlock = _closestBlock(node, common);
      continue;
    }
    const s = node.nodeValue;
    if (!s) continue;
    if (common) {
      const blk = _closestBlock(node, common);
      if (lastBlock && blk !== lastBlock) items.push({ boundary: true });
      lastBlock = blk;
    }
    const nodeInRange = range ? range.intersectsNode(node) : true;
    const from = (range && node === range.startContainer) ? range.startOffset : 0;
    const to   = (range && node === range.endContainer)   ? range.endOffset   : s.length;
    for (let i = 0; i < s.length; i++) {
      items.push({ n, ch: s[i], editable: nodeInRange && i >= from && i < to });
    }
  }
  return items;
}

function _nextChar(items, p) {
  const it = items[p];
  return (it && !it.boundary) ? it.ch : '';
}

// Erstes Nicht-Space-Zeichen ab `p`, bis zur nächsten Grenze.
function _nextSignificant(items, p) {
  for (let k = p; items[k] && !items[k].boundary; k++) {
    if (!SPACES.has(items[k].ch)) return items[k].ch;
  }
  return '';
}

// Bis zu 12 Wortzeichen ab `p` — für die englische Kontraktions-Heuristik.
function _peekWord(items, p) {
  let w = '';
  for (let k = p; items[k] && !items[k].boundary && w.length < 12; k++) {
    if (!/[\p{L}\p{N}]/u.test(items[k].ch)) break;
    w += items[k].ch;
  }
  return w;
}

// Style-Vorgabe in lead/core/trail zerlegen. `core` ist die signifikante
// Glyphe, lead/trail der Innen-Abstand (de-CH: keiner, fr: NBSP).
function _splitRepl(repl) {
  let a = 0, b = repl.length;
  while (a < b && SPACES.has(repl[a])) a++;
  while (b > a && SPACES.has(repl[b - 1])) b--;
  return { lead: repl.slice(0, a), core: repl.slice(a, b) || repl, trail: repl.slice(b) };
}

function _process(textNodes, style, range, common) {
  const items = _buildStream(textNodes, range, common);
  if (!items.length) return 0;

  // Ausgabe als Token-Liste (`{ n, text, strippable }`) statt als String je
  // Node: ein Schliesser muss die Spaces vor sich wegräumen, und die können in
  // einem vorherigen Node liegen. `strippable` schützt dabei Zeichen, die
  // ausserhalb der Range liegen.
  const tokens = [];
  const units = new Array(textNodes.length).fill(0);
  const stack = [];
  let prevRaw = '';
  let prevSig = '';
  // Nach einem öffnenden Quote: direkt folgende Quell-Spaces gehören zum schon
  // emittierten Innen-Abstand → verwerfen (sonst wachsen die Abstände bei
  // jedem Lauf, egal ob macOS-Autokorrektur oder KI sie eingeschleust hat).
  let dropFollowing = false;

  const push = (n, text, strippable) => tokens.push({ n, text, strippable });

  const emit = (n, role, repl) => {
    const { lead, core, trail } = _splitRepl(repl);
    if (role === 'apostrophe') {
      // Weder Innen-Abstand noch Strip: der Apostroph klebt am Wort und lässt
      // den Space davor (`Get ’em`) stehen.
      push(n, core, false);
      dropFollowing = false;
    } else if (role === 'open') {
      push(n, core, false);
      if (trail) push(n, trail, true);
      dropFollowing = true;
    } else {
      while (tokens.length) {
        const last = tokens[tokens.length - 1];
        if (!last.strippable || !SPACES.has(last.text)) break;
        tokens.pop();
      }
      if (lead) push(n, lead, true);
      push(n, core, false);
      dropFollowing = false;
    }
    prevRaw = core;
    prevSig = core;
    units[n]++;
  };

  for (let p = 0; p < items.length; p++) {
    const it = items[p];
    if (it.boundary) {
      prevRaw = '';
      prevSig = '';
      dropFollowing = false;
      stack.length = 0;
      continue;
    }
    const c = it.ch;
    if (dropFollowing) {
      if (SPACES.has(c) && it.editable) continue;
      dropFollowing = false;
    }

    const dbl = isDoubleQuote(c);
    const sgl = !dbl && isSingleQuote(c);

    if (!dbl && !sgl) {
      // ASCII-Punktfolge innerhalb offener Rede → `…`. Nur im Quote-Scope,
      // damit `z.B.`/`usw.` unangetastet bleiben.
      if (c === '.' && stack.length > 0 && it.editable) {
        let len = 0;
        while (items[p + len] && !items[p + len].boundary
               && items[p + len].ch === '.' && items[p + len].editable) len++;
        if (len >= 2) {
          push(it.n, '…', false);
          units[it.n]++;
          p += len - 1;
          prevRaw = '…';
          prevSig = '…';
          continue;
        }
      }
      push(it.n, c, it.editable && SPACES.has(c));
      prevRaw = c;
      if (!SPACES.has(c)) prevSig = c;
      continue;
    }

    const nextRaw = _nextChar(items, p + 1);
    if (sgl && isApostrophe({
      prevRaw, nextRaw, style,
      singleOpen: stack.includes('s'),
      wordAfter: () => _peekWord(items, p + 1),
    })) {
      if (it.editable) emit(it.n, 'apostrophe', style.apostrophe);
      else { push(it.n, c, false); prevRaw = c; prevSig = c; }
      dropFollowing = false;
      continue;
    }

    // Run bilden: benachbarte Quote-Glyphen mit gleichem Editier-Status.
    const glyphs = [{ ch: c, isDouble: dbl, n: it.n }];
    let q = p + 1;
    while (items[q] && !items[q].boundary && items[q].editable === it.editable
           && isQuoteGlyph(items[q].ch)) {
      glyphs.push({ ch: items[q].ch, isDouble: isDoubleQuote(items[q].ch), n: items[q].n });
      q++;
    }

    const decisions = resolveRun(glyphs, {
      prevRaw,
      prevSig,
      nextRaw: _nextChar(items, q),
      nextSig: _nextSignificant(items, q),
      depth: stack.length,
    });

    for (let d = 0; d < decisions.length; d++) {
      const dec = decisions[d];
      const n = (glyphs[d] || glyphs[glyphs.length - 1]).n;
      if (dec.role === 'open') {
        // Ebene aus dem Stack, nicht aus der getippten Glyphe: wer durchgängig
        // `"` tippt, bekommt trotzdem aussen/innen korrekt verschachtelt.
        const kind = dec.isDouble ? (stack.length % 2 === 0 ? 'd' : 's') : 's';
        if (it.editable) emit(n, 'open', kind === 'd' ? style.ldquo : style.lsquo);
        stack.push(kind);
      } else {
        // Geschlossen wird, was oben auf dem Stack liegt — die Glyphe folgt
        // der offenen Ebene, nicht dem, was dastand.
        const kind = stack.pop() || (dec.isDouble ? 'd' : 's');
        if (it.editable) emit(n, 'close', kind === 'd' ? style.rdquo : style.rsquo);
      }
    }
    if (!it.editable) {
      for (const g of glyphs) push(g.n, g.ch, false);
      prevRaw = glyphs[glyphs.length - 1].ch;
      prevSig = prevRaw;
      dropFollowing = false;
    }
    p = q - 1;
  }

  const byNode = new Map();
  for (const t of tokens) byNode.set(t.n, (byNode.get(t.n) || '') + t.text);

  let count = 0;
  for (let n = 0; n < textNodes.length; n++) {
    const node = textNodes[n];
    if (_isBr(node)) continue;
    const orig = node.nodeValue;
    if (orig == null || orig === '') continue;
    const next = byNode.get(n) ?? '';
    if (next !== orig) {
      node.nodeValue = next;
      // Geänderter Node zählt ≥1 — auch wenn nur ein Fremd-Space über die
      // Node-Grenze geschluckt wurde; no-op bleibt 0.
      count += Math.max(1, units[n]);
    }
  }
  return count;
}

export function normalizeQuotes(rootEl, style) {
  if (!rootEl || !style) return 0;
  let blocks = Array.from(rootEl.querySelectorAll(QUOTE_BLOCK_SEL));
  if (!blocks.length) blocks = [rootEl];
  let total = 0;
  for (const b of blocks) {
    // Benachbarte Text-Nodes zusammenführen (Browser-Normalzustand: ein Node
    // je Inline-Run; Editing/`&#160;`-Parse fragmentiert ihn).
    b.normalize?.();
    const nodes = [];
    // Innere Blocks (z.B. <p> in <blockquote>) laufen als eigener Durchgang —
    // kein Doppel-Processing, kein Zustands-Leak.
    _collectTextNodes(b, nodes, QUOTE_BLOCK_SEL);
    if (nodes.length) total += _process(nodes, style, null, null);
  }
  return total;
}

// Selection-Scope: nur Zeichen innerhalb von `range` werden transformiert.
// Zeichen ausserhalb bleiben unverändert, liefern aber Kontext und Nesting-Tiefe.
export function normalizeQuotesInRange(range, style) {
  if (!range || range.collapsed || !style) return 0;
  const anchor = range.commonAncestorContainer;
  const common = anchor.nodeType === 1 ? anchor : anchor.parentElement;
  if (!common) return 0;
  const nodes = [];
  _collectTextNodes(common, nodes);
  if (!nodes.length) return 0;
  return _process(nodes, style, range, common);
}

// String-Variante: normalisiert die Quotes in einem HTML-String off-DOM.
// Genutzt für KI-Vorschläge (Lektorat-Korrekturen, Seitenchat-Ersatz), bevor
// sie gespeichert werden — die KI liefert oft gerade `"`/`'`, die nicht zum
// Buch-Style passen. Round-Trip über ein detached `<div>`; `data-bid` bleibt
// erhalten (innerHTML bewahrt Attribute, ensureBlockIds ist idempotent).
export function normalizeQuotesInHtml(html, style) {
  if (!html || !style) return html;
  const div = document.createElement('div');
  div.innerHTML = html;
  normalizeQuotes(div, style);
  return div.innerHTML;
}
