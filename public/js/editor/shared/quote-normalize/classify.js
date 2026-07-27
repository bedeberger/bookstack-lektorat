// Entscheidet für jede Quote-Stelle: Apostroph, Öffner oder Schliesser.
//
// Eine „Stelle" ist ein **Run** — ein oder mehrere direkt benachbarte Quote-
// Glyphen ohne Zeichen dazwischen (`»`, `‹«`, `»«`, `"'`). Runs statt Einzel-
// zeichen, weil verunglückte Anführungszeichen genau dort entstehen: zwei
// Glyphen kleben aneinander, und jede für sich betrachtet klassifiziert sich
// plausibel — als Paar sind sie Unsinn. Der Run wird als Ganzes gerichtet und
// bekommt dann so viele Glyphen, wie der Nesting-Stack hergibt; überzählige
// fallen weg.
//
// Richtung aus vier Evidenz-Signalen statt aus einer Glyphen-Kaskade: die
// getippte Glyphe (`«` vs. `»`) ist unzuverlässig — genau sie ist ja falsch,
// wenn etwas zu reparieren ist. Verlässlich sind die Nachbarn.

import {
  LETTER_DIGIT, SPACES, END_PUNCT, CLOSE_PUNCT, OPEN_PUNCT, INTRO_PUNCT, isEnglish,
} from './styles.js';

// English leading-apostrophe-Kontraktionen (Word/Pages/Google-Docs-Heuristik).
// `'<wort>` mit `wort` in dieser Liste → Apostroph statt öffnendes Single-Quote.
// Plus Year-Shorthand `'90s`, `'00`, `'76`.
const EN_LEADING_CONTRACTIONS = new Set([
  'tis', 'twas', 'em', 'cause', 'bout', 'n', 'til', 'round', 'nother',
  'gainst', 'pon', 'lectric', 'allo', 'ave', 'nuff', 'sup',
]);
const EN_YEAR_SHORTHAND = /^\d{2,4}s?$/;

function _isLeadingContraction(word) {
  if (!word) return false;
  if (EN_LEADING_CONTRACTIONS.has(word.toLowerCase())) return true;
  return EN_YEAR_SHORTHAND.test(word);
}

// Apostroph-Test für Single-Glyphen. Läuft **vor** der Run-Bildung — ein
// Apostroph ist kein Struktur-Quote und darf den Stack nicht bewegen.
// `wordAfter` ist eine Lazy-Funktion (nur für Englisch ausgewertet).
export function isApostrophe({ prevRaw, nextRaw, style, singleOpen, wordAfter }) {
  const prevLD = !!prevRaw && LETTER_DIGIT.test(prevRaw);
  const nextLD = !!nextRaw && LETTER_DIGIT.test(nextRaw);
  // Zwischen Buchstaben/Ziffern: immer Apostroph (`auf geht's`, `L'Étoile`).
  if (prevLD && nextLD) return true;
  // Englisch: `'tis`, `'em`, `'90s`, `rock 'n' roll`.
  const prevOpenish = !prevRaw || SPACES.has(prevRaw) || OPEN_PUNCT.test(prevRaw);
  if (isEnglish(style) && prevOpenish && nextLD && _isLeadingContraction(wordAfter())) return true;
  // Saxon-Genitiv/Elision (`Chris'`, `kids'`): Wort davor, kein Wort danach —
  // und kein offenes Single-Quote. Man kann nicht schliessen, was nicht offen
  // ist. (In en fällt rsquo mit apostrophe zusammen, sichtbar wird der
  // Unterschied erst bei de-CH/de-DE/fr/it mit eigener ›/‘-Glyphe.)
  if (prevLD && !nextLD && !singleOpen) return true;
  return false;
}

// Evidenz-Bilanz um den Run herum.
// `prevRaw`/`nextRaw` = die unmittelbaren Nachbarzeichen (Space signifikant),
// `prevSig`/`nextSig` = die nächsten Nicht-Space-Zeichen (`''` an Block-/
// Zeilengrenze). Zeilenanfang zählt als Öffnungs-Evidenz — auch wenn direkt
// Satzzeichen folgt (`"... will check`); Zeilenende als Schliess-Evidenz.
function _evidence(ctx) {
  const { prevRaw, prevSig, nextRaw, nextSig } = ctx;
  const closeEv =
    (!!prevSig && (LETTER_DIGIT.test(prevSig) || END_PUNCT.test(prevSig))) ||
    nextSig === '' || (!!nextSig && CLOSE_PUNCT.test(nextSig));
  const openEv =
    prevSig === '' ||
    (!!nextSig && LETTER_DIGIT.test(nextSig)) ||
    (!!prevSig && (OPEN_PUNCT.test(prevSig) || INTRO_PUNCT.test(prevSig)));
  // „Klebt" der Run am Wort davor bzw. danach? Nur Buchstaben/Ziffern zählen
  // als Kleben nach hinten — ein direkt folgendes Komma ist Schliess-Evidenz,
  // kein Rede-Anfang.
  const hugPrev = !!prevRaw && !SPACES.has(prevRaw);
  const hugNext = !!nextRaw && LETTER_DIGIT.test(nextRaw);
  return { closeEv, openEv, hugPrev, hugNext };
}

// Reihenfolge ist die Aussagekraft der Signale: eindeutige Evidenz > Kleben >
// Stack. Der Stack-Fallback ist das, was die rein kontextbasierte Variante
// nicht konnte — bei echter Patt-Situation schliesst ein offenes Quote.
function _direction(ev, depth) {
  if (ev.closeEv && !ev.openEv) return 'close';
  if (ev.openEv && !ev.closeEv) return 'open';
  if (ev.hugNext && !ev.hugPrev) return 'open';
  if (ev.hugPrev && !ev.hugNext) return 'close';
  return depth > 0 ? 'close' : 'open';
}

// Mehr als zwei Ebenen öffnet niemand absichtlich in einem Rutsch — was
// darüber hinausgeht, ist Tipp-/Import-Müll.
const MAX_NESTED_OPEN = 2;

// `glyphs`: [{ ch, isDouble }] in Quell-Reihenfolge.
// Liefert die zu emittierenden Entscheidungen — kann **kürzer** sein als der
// Run (überzählige Glyphen werden verworfen; genau das repariert Cluster wie
// `‹«`), nie länger.
export function resolveRun(glyphs, ctx) {
  const ev = _evidence(ctx);
  const dir = _direction(ev, ctx.depth);
  const n = glyphs.length;
  if (n === 1) return [{ role: dir, isDouble: glyphs[0].isDouble }];

  // Zwei Reden ohne Leerzeichen dazwischen (`…sagte er.»«Und dann…`): der Run
  // klebt beidseitig an Inhalt und hat beide Evidenzen → erst schliessen, dann
  // neu öffnen. Ohne beidseitiges Kleben ist es ein reiner Schliess-Cluster
  // (`…"ja"' laut.`) und keine neue Rede.
  if (ev.closeEv && ev.openEv && ev.hugPrev && ev.hugNext && ctx.depth > 0) {
    const openers = Math.min(n - 1, MAX_NESTED_OPEN);
    return [
      { role: 'close' },
      ...glyphs.slice(n - openers).map(g => ({ role: 'open', isDouble: g.isDouble })),
    ];
  }
  if (dir === 'close') {
    // Nie mehr schliessen als offen ist. Bei leerem Stack bleibt ein einzelner
    // Schliesser stehen — Rede über mehrere Absätze schliesst erst im letzten.
    const k = ctx.depth > 0 ? Math.min(n, ctx.depth) : 1;
    return Array.from({ length: k }, () => ({ role: 'close' }));
  }
  return glyphs.slice(0, Math.min(n, MAX_NESTED_OPEN))
    .map(g => ({ role: 'open', isDouble: g.isDouble }));
}

export const __test__ = { _evidence, _direction };
