// Match-Klassifikation + die drei Highlight-Toepfe. Reine Funktionen ohne
// Controller-Closure — hier steht, WAS ein LanguageTool-Match ist, nicht was
// mit ihm passiert.
//
// Die drei Kategorien sind zugleich die drei `::highlight()`-Namen aus
// public/css/editor/spellcheck.css: `CSS.highlights` ist ein globales Register,
// und die Namen sind der Vertrag zwischen JS und Stylesheet.

export const HL_TYPO    = 'lt-typo';
export const HL_GRAMMAR = 'lt-grammar';
export const HL_STYLE   = 'lt-style';
export const HL_KEYS    = [HL_TYPO, HL_GRAMMAR, HL_STYLE];

export const supportsHighlightApi = typeof CSS !== 'undefined'
  && CSS.highlights
  && typeof Highlight !== 'undefined';

// LT liefert keine stabile ID -> aus offset+length+ruleId zusammenbauen.
export function matchId(m) {
  return `${m.offset}:${m.length}:${m.rule?.id || ''}`;
}

// Das beanstandete Wort aus dem Kontext-Ausschnitt. Leer, wenn es fehlt oder
// unplausibel lang ist — es landet sonst als Eintrag im Woerterbuch.
export function extractMatchedWord(m) {
  const ctx = m?.context;
  if (!ctx || typeof ctx.text !== 'string') return '';
  const word = ctx.text.substr(ctx.offset || 0, ctx.length || 0).trim();
  return word.length > 0 && word.length <= 80 ? word : '';
}

export function categoryKey(match) {
  const id = match.rule?.id || '';
  const cat = match.rule?.category?.id || '';
  if (id.includes('SPELL') || cat === 'TYPOS') return HL_TYPO;
  if (cat === 'STYLE' || cat === 'REDUNDANCY' || cat === 'TYPOGRAPHY') return HL_STYLE;
  return HL_GRAMMAR;
}

export function badgeClassFor(match) {
  const k = categoryKey(match);
  if (k === HL_TYPO) return 'lt-squiggle--typo';
  if (k === HL_STYLE) return 'lt-squiggle--style';
  return 'lt-squiggle--grammar';
}

// Ist der Match ein Rechtschreibfehler? Nur dann bietet der Popover „ins
// Woerterbuch" an — ein Grammatik- oder Stilbefund hat kein Einzelwort, das man
// dauerhaft erlauben koennte.
export function isSpellingMatch(m) {
  return (m.rule?.id || '').includes('SPELL') || (m.rule?.category?.id || '') === 'TYPOS';
}

/**
 * Die drei Highlight-Toepfe einer Controller-Instanz. `CSS.highlights` ist
 * global; pro Instanz wird ein frischer `Highlight` registriert und beim detach
 * geleert.
 */
export function createHighlightBuckets() {
  const buckets = { [HL_TYPO]: null, [HL_GRAMMAR]: null, [HL_STYLE]: null };
  return {
    // false, wenn der Browser die Highlight-API nicht kann — der Aufrufer
    // ueberspringt dann stillschweigend (App laeuft, nur ohne Markierungen).
    ensure() {
      if (!supportsHighlightApi) return false;
      for (const key of HL_KEYS) {
        if (!buckets[key]) {
          buckets[key] = new Highlight();
          CSS.highlights.set(key, buckets[key]);
        }
      }
      return true;
    },
    add(category, range) { buckets[category]?.add(range); },
    remove(category, range) { buckets[category]?.delete(range); },
    clear() {
      for (const key of HL_KEYS) buckets[key]?.clear();
    },
  };
}
