// Tolerantes Suchen/Ersetzen in HTML über eine Text-View mit Positions-Map.
// Findet KI-/User-Phrasen, die im HTML von Inline-Tags durchsetzt sind, und
// ersetzt sie tag-balance-sicher (Block-Grenzen werden nie gekreuzt).

// Dekodiert eine einzelne HTML-Entity (z.B. &bdquo;) via Browser-Parser.
// Gibt null zurück, wenn sich die Entity nicht auflöst.
const _entityDecoder = typeof document !== 'undefined' ? document.createElement('textarea') : null;
function _decodeHtmlEntity(entity) {
  if (!_entityDecoder) return null;
  _entityDecoder.innerHTML = entity;
  const decoded = _entityDecoder.value;
  return decoded === entity ? null : decoded;
}

/**
 * Baut eine Text-View von `html` mit Positions-Map zurück ins Original-HTML.
 * - Tags werden entfernt; Tag-Grenzen wirken wie Whitespace.
 * - Aufeinanderfolgender Whitespace wird auf einzelne Spaces kollabiert.
 * - Entities werden via Browser-Parser dekodiert.
 * - Pro Text-Zeichen `text[i]` gilt: es stammt aus dem HTML-Bereich [starts[i], ends[i]).
 */
function _buildHtmlTextMap(html) {
  const chars = [];
  const starts = [];
  const ends = [];
  let pendingSpace = false;
  let emittedNonSpace = false;
  let i = 0;

  const markSpace = () => { if (emittedNonSpace) pendingSpace = true; };

  const pushChar = (ch, start, end) => {
    if (pendingSpace) {
      chars.push(' ');
      starts.push(start);
      ends.push(start);
      pendingSpace = false;
    }
    chars.push(ch);
    starts.push(start);
    ends.push(end);
    emittedNonSpace = true;
  };

  while (i < html.length) {
    const c = html[i];
    if (c === '<') {
      const gt = html.indexOf('>', i);
      if (gt === -1) break;
      markSpace();
      i = gt + 1;
      continue;
    }
    if (c === '&') {
      const semi = html.indexOf(';', i);
      if (semi !== -1 && semi - i <= 10) {
        const entity = html.slice(i, semi + 1);
        const decoded = _decodeHtmlEntity(entity);
        if (decoded != null) {
          for (const dc of decoded) {
            if (/\s/.test(dc)) markSpace();
            else pushChar(dc, i, semi + 1);
          }
          i = semi + 1;
          continue;
        }
      }
    }
    if (/\s/.test(c)) {
      markSpace();
      i++;
      continue;
    }
    pushChar(c, i, i + 1);
    i++;
  }
  return { text: chars.join(''), starts, ends };
}

/**
 * Sucht `needle` in `html`. Exakter Substring-Match hat Vorrang; sonst
 * toleranter Match über die Text-View (Tags ignorieren, Entities dekodieren,
 * Whitespace kollabieren). Gibt { htmlStart, htmlEnd } zurück oder null.
 *
 * Typischer Fall: Chat-/Lektorat-KI sieht die Seite als Plaintext und
 * liefert `Er sagte das magische Wort.`, im HTML steht aber
 * `Er sagte <em>das magische</em> Wort.`. Der Tolerant-Match findet die
 * Stelle trotzdem; die `<em>`-Tags fallen beim Ersatz weg, was akzeptabel
 * ist, weil die KI ohnehin eine neue Formulierung vorschlägt.
 */
export function findInHtml(html, needle) {
  if (!html || !needle) return null;
  const exact = html.indexOf(needle);
  if (exact !== -1) return { htmlStart: exact, htmlEnd: exact + needle.length };

  const normalized = needle.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  const { text, starts, ends } = _buildHtmlTextMap(html);
  const idx = text.indexOf(normalized);
  if (idx === -1) return null;
  return { htmlStart: starts[idx], htmlEnd: ends[idx + normalized.length - 1] };
}

/**
 * Zählt die nicht-überlappenden Vorkommen von `needle` in `html` über dieselbe
 * Text-View wie `findInHtml` (Tags ignorieren, Entities dekodieren, Whitespace
 * kollabieren). Dient der Ambiguitäts-Erkennung vor einer Ersetzung: `findInHtml`
 * greift immer das erste Vorkommen, was bei mehrdeutigen Phrasen die falsche
 * Stelle treffen würde. Kommt der Text mehrfach vor, kann statt still-falscher
 * Ersetzung abgebrochen werden.
 */
export function countInHtml(html, needle) {
  if (!html || !needle) return 0;
  const normalized = needle.replace(/\s+/g, ' ').trim();
  if (!normalized) return 0;
  const { text } = _buildHtmlTextMap(html);
  let count = 0;
  let from = 0;
  let idx;
  while ((idx = text.indexOf(normalized, from)) !== -1) {
    count++;
    from = idx + normalized.length;
  }
  return count;
}

const _VOID_TAGS = new Set([
  'area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr',
]);

// Inline-Elemente, ueber die eine Ersetzung gefahrlos hinweggehen darf — ihre
// Tag-Balance haelt der Orphan-Schutz in `_splitOrphanTags`. Alles andere
// (p, li, h1-h6, blockquote, pre, table-Teile, div, figure …) ist eine
// Block-Grenze: ein Match, der sie kreuzt, wuerde beim Ersetzen Absatzstruktur
// zerreissen (verschachtelte/aufgespaltene Bloecke). Default-Deny: unbekannte
// Tags gelten als Block-Grenze, damit nichts stillschweigend korrumpiert.
const _INLINE_TAGS = new Set([
  'a','abbr','b','bdi','bdo','br','cite','code','data','dfn','em','i','kbd',
  'mark','q','rp','rt','ruby','s','samp','small','span','strong','sub','sup',
  'time','u','var','wbr',
]);

// True, wenn der Slice ein Nicht-Inline-Tag (Block-Grenze) enthaelt.
function _crossesBlockBoundary(slice) {
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  let m;
  while ((m = tagRe.exec(slice))) {
    if (!_INLINE_TAGS.has(m[1].toLowerCase())) return true;
  }
  return false;
}

// True, wenn der Slice einen sichtbaren Zeilenumbruch <br> umschliesst. In der
// Text-View wird <br> — wie jedes Tag — zu einem Space (markSpace), sodass ein
// toleranter Match ihn ueberspannen kann. Beim Ersetzen ginge der <br> dann
// verloren: er ist ein Void-Tag, den `_splitOrphanTags` nicht als Waise erhaelt,
// und `korrektur` ist Fliesstext ohne Umbruch-Position. Ergebnis waere ein
// stillschweigend geloeschter Zeilenumbruch (Vers, Adresse, Strophe). Wie bei
// einer Block-Grenze bleibt der Text darum unveraendert statt korrumpiert.
function _crossesLineBreak(slice) {
  return /<br\b[^>]*>/i.test(slice);
}

// True, wenn der Slice ein VOLLSTAENDIG umschlossenes <a>…</a> enthaelt (Open
// UND Close im Bereich). Das href traegt Information, die die Plaintext-View der
// KI nie gesehen hat — beim Ersetzen fiele der Link ersatzlos weg (nur der
// sichtbare Linktext bliebe). Ein Waisen-<a> (Open oder Close ausserhalb) ist
// dagegen ungefaehrlich: `_splitOrphanTags` klebt den fehlenden Partner wieder
// an, der Link ueberlebt. Anker verschachteln nicht — depth-Zaehlung reicht.
function _containsBalancedAnchor(slice) {
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  let depth = 0;
  let m;
  while ((m = tagRe.exec(slice))) {
    if (m[1].toLowerCase() !== 'a') continue;
    if (m[0].startsWith('</')) { if (depth > 0) return true; }
    else depth++;
  }
  return false;
}

/**
 * Findet im Slice Tags ohne Partner: Closes ohne vorheriges Open im Slice
 * (Open liegt VOR dem Slice, Tag muss nach dem Replacement erhalten bleiben),
 * bzw. Opens ohne nachfolgendes Close im Slice (Close liegt NACH dem Slice).
 * Self-closing/Void-Elemente werden ignoriert.
 */
function _splitOrphanTags(slice) {
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  const stack = [];
  const orphanCloses = [];
  let m;
  while ((m = tagRe.exec(slice))) {
    const full = m[0];
    const tag = m[1].toLowerCase();
    if (_VOID_TAGS.has(tag) || /\/>$/.test(full)) continue;
    if (full.startsWith('</')) {
      if (stack.length && stack[stack.length - 1].tag === tag) stack.pop();
      else orphanCloses.push(full);
    } else {
      stack.push({ tag, full });
    }
  }
  return { orphanOpens: stack.map(s => s.full), orphanCloses };
}

/**
 * Ersetzt `needle` im HTML durch `replacement`. Nutzt `findInHtml` für die
 * Position. Wenn der Match nur Inline-Tag-Grenzen kreuzt (toleranter Match),
 * bleiben Waisen-Tags innerhalb der ersetzten Range erhalten, sonst zerbricht
 * die Tag-Balance (typisch: KI ändert Phrase, die ein `<em>kursiv</em>` umfasst,
 * dabei darf weder das öffnende noch das schliessende Tag verloren gehen).
 *
 * Kreuzt der Match dagegen eine BLOCK-Grenze (`</p><p>`, `</li><li>`, Heading,
 * Tabelle …), umschliesst er einen Zeilenumbruch (`<br>`) ODER einen vollständigen
 * Hyperlink (`<a>…</a>`), wird NICHT ersetzt: eine Block-Grenzen-Ersetzung würde
 * Absätze zerstören, ein umspannter `<br>` würde als sichtbarer Zeilenumbruch
 * ersatzlos verschwinden, eine Link-Ersetzung würde das nur der KI-Plaintext-View
 * unbekannte `href` verwerfen. In allen Fällen bleibt der Text unverändert statt
 * korrumpiert.
 *
 * `replacement` selbst wird von rohen Zeilenumbrüchen (`\n`/`\r`) befreit, damit
 * kein Umbruch hinzukommt, den `original` nicht hatte.
 *
 * Gibt das neue HTML zurück, oder das Original wenn nichts gefunden bzw. der
 * Match eine Block-Grenze, einen `<br>` oder einen Link kreuzt.
 */
export function replaceInHtml(html, needle, replacement) {
  if (!html || !needle) return html;
  const m = findInHtml(html, needle);
  if (!m) return html;
  const removed = html.slice(m.htmlStart, m.htmlEnd);
  // Keinen Zeilenumbruch hinzufuegen: `korrektur` ist reiner Ersatz-Fliesstext.
  // Ein rohes \n darin (KI-Artefakt) wanderte sonst verbatim ins HTML und wuerde
  // in umbruch-erhaltenden Bloecken (<pre>, .poem) als sichtbarer Umbruch gerendert.
  let inserted = String(replacement).replace(/[\r\n]+/g, ' ');
  if (removed.includes('<')) {
    if (_crossesBlockBoundary(removed)) return html;
    if (_crossesLineBreak(removed)) return html;
    if (_containsBalancedAnchor(removed)) return html;
    const { orphanOpens, orphanCloses } = _splitOrphanTags(removed);
    if (orphanOpens.length || orphanCloses.length) {
      inserted = orphanOpens.join('') + inserted + orphanCloses.join('');
    }
  }
  return html.slice(0, m.htmlStart) + inserted + html.slice(m.htmlEnd);
}

/**
 * Warum eine `replaceInHtml`-Ersetzung ein No-Op wäre — zur Unterscheidung der
 * User-Meldung (Absatzgrenze vs. Link). Gibt `true`, wenn der Match einen
 * vollständigen `<a>…</a>` umschliesst (und deshalb übersprungen wird).
 */
export function matchSpansLink(html, needle) {
  if (!html || !needle) return false;
  const m = findInHtml(html, needle);
  if (!m) return false;
  return _containsBalancedAnchor(html.slice(m.htmlStart, m.htmlEnd));
}

/**
 * Klassifiziert, WARUM eine `replaceInHtml`-Ersetzung ein No-Op war — damit die
 * User-Meldung die Wahrheit sagt statt pauschal „Link oder Absatzgrenze":
 *
 *   'notFound'  — `needle` steht nicht (mehr) im HTML. Kein Schutzmechanismus,
 *                 sondern ein veralteter Textbezug: die Stelle wurde inzwischen
 *                 umgeschrieben oder gelöscht. Braucht keine Nachkontrolle.
 *   'spansLink' — der Match umschliesst ein vollständiges `<a>…</a>`; ersetzen
 *                 würde das `href` verwerfen.
 *   'boundary'  — der Match kreuzt eine Block-Grenze oder einen `<br>`.
 *
 * Nur für den No-Op-Fall gedacht; auf einer erfolgreich ersetzbaren Stelle
 * aufgerufen liefert es 'boundary' (der Aufrufer fragt dort nicht).
 * Reihenfolge = Entscheidungsbaum von chat.js#applyChatVorschlag.
 */
export function skipReason(html, needle) {
  if (!findInHtml(html, needle)) return 'notFound';
  return matchSpansLink(html, needle) ? 'spansLink' : 'boundary';
}
