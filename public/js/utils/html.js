// HTML-Bereinigung für Editor-Inhalte: Text-Extraktion, Paste-Sanitizing,
// Inline-Style-/Leerblock-Cleanup. DOMParser-basiert (inert, keine
// Resource-Loads). Idempotent aufrufbar.

// Sicherheitscheck vor dem Speichern: < 50 % wirkt unvollständig → Abbruch
export const SAFETY_HTML_RATIO = 0.5;

export function htmlToText(html) {
  // DOMParser statt detached div: `div.innerHTML = …` triggert in allen
  // Browsern einen GET auf `<img src>`/Background-URLs (HTML-Parser-Pipeline
  // setzt Resource-Loads nicht aus). DOMParser('text/html') produziert ein
  // inert document ohne Resource-Requests.
  if (typeof DOMParser !== 'undefined') {
    try {
      const doc = new DOMParser().parseFromString(html || '', 'text/html');
      return doc.body?.textContent || '';
    } catch { /* fallback unten */ }
  }
  const d = document.createElement('template');
  d.innerHTML = html || '';
  return d.content?.textContent || '';
}

/**
 * Entfernt Fokus-Modus-Artefakte aus BookStack-HTML. Browser friert bei
 * contenteditable-Edits die computed `font-size` des Fokus-Containers als
 * inline `<span style="font-size:…">` ein; die `focus-paragraph-*`-Klassen sind
 * rein interne UI-Markierungen, die nie ins persistierte HTML gehören.
 * Idempotent – auch auf bereits sauberem HTML sicher aufrufbar. Aufruf an allen
 * Seams: nach dem Laden von BookStack und vor dem Speichern an BookStack.
 */
export function stripFocusArtefacts(html) {
  if (!html) return html;
  // Trigger erweitern: leeres `class=""` entsteht, wenn classList.remove die
  // letzte Klasse wegnimmt — Attribut bleibt mit leerem Wert stehen. Ohne
  // diesen Branch erzeugt Focus-Mode-Aktiv-Markierung beim Save eine Revision,
  // obwohl semantisch nichts geändert wurde.
  if (
    !html.includes('focus-paragraph') &&
    !html.includes('hr-selected') &&
    !/font-size|background-color\s*:\s*transparent/i.test(html) &&
    !/\sclass\s*=\s*""/.test(html)
  ) {
    return html;
  }

  const tmp = document.createElement('div');
  tmp.innerHTML = html;

  // Transiente Editor-UI-Markierungen (Focus-Spotlight-Klassen, per Klick
  // selektierte <hr>) sind reine Laufzeit-Dekoration — nie persistieren, sonst
  // falsch-dirty im Vergleich + landen in der Revision.
  //
  // Praefix-basiert statt Klassenliste: der Focus-Editor markiert heute den
  // aktiven Absatz (`-active`) und in der Granularitaet window-3 zusaetzlich
  // dessen Nachbarn (`-near`); beide haengen waehrend der ganzen Edit-Session im
  // DOM, also auch wenn Autosave oder der Exit-Save mitten drin speichert. Die
  // Erweitern-Checkliste in docs/focus-editor.md nennt diese Stelle nicht — eine
  // gepflegte Liste driftet beim naechsten Granularitaetsmodus zwangslaeufig
  // wieder auseinander, das Praefix nicht.
  tmp.querySelectorAll('[class*="focus-paragraph"], .hr-selected').forEach(el => {
    for (const c of Array.from(el.classList)) {
      if (c.startsWith('focus-paragraph-')) el.classList.remove(c);
    }
    el.classList.remove('hr-selected');
    if (el.classList.length === 0) el.removeAttribute('class');
  });

  tmp.querySelectorAll('[style]').forEach(el => {
    const cleaned = (el.getAttribute('style') || '')
      .split(';')
      .map(d => d.trim())
      .filter(d => {
        if (!d) return false;
        const key = d.split(':')[0].trim().toLowerCase();
        if (key === 'font-size') return false;
        if (key === 'background-color' && /transparent/i.test(d)) return false;
        return true;
      })
      .join('; ');
    if (cleaned) el.setAttribute('style', cleaned);
    else el.removeAttribute('style');
  });

  tmp.querySelectorAll('span').forEach(span => {
    if (span.attributes.length === 0) {
      const parent = span.parentNode;
      if (!parent) return;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
    }
  });

  // Verbleibende leere class=""-Attribute unabhängig von ihrer Herkunft entfernen.
  tmp.querySelectorAll('[class=""]').forEach(el => el.removeAttribute('class'));

  return tmp.innerHTML;
}

// Whitelist erlaubter Tags beim Paste. Alles ausserhalb wird zu Text reduziert
// (Tag-Hülle entfernt, Text-Inhalt bleibt). Tags spiegeln den Editor-Toolbar-
// Output (Notebook/Focus/Bucheditor schreiben dasselbe Markup).
const PASTE_ALLOWED_TAGS = new Set([
  'P', 'BR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'UL', 'OL', 'LI', 'HR', 'PRE',
  'STRONG', 'B', 'EM', 'I', 'U', 'S', 'STRIKE', 'CODE', 'MARK', 'SUB', 'SUP',
  'A', 'DIV',
]);
// Attribute, die pro Tag erhalten bleiben. Alles andere wird gestrippt
// (insbesondere on*-Handler, style, id, class, data-*).
const PASTE_ALLOWED_ATTRS = {
  A: new Set(['href']),
  DIV: new Set(['class']), // nur .poem (siehe Filter unten)
};

/**
 * Sanitisiert Clipboard-HTML auf eine im Editor unterstützte Form. Wird vor
 * `document.execCommand('insertHTML', …)` aufgerufen. Parsing via DOMParser
 * statt innerHTML — Subtree hängt nie im Live-DOM, on*-Handler werden vor
 * Insert gestrippt.
 *
 * - Whitelist-Tags bleiben (Inhalt wandert mit), unbekannte Tags werden
 *   unwrapped (Text bleibt, Hülle weg).
 * - Skripte/Styles/Metadaten + ihre Subtrees fliegen komplett raus.
 * - `<div>` bleibt nur als `<div class="poem">`, sonst unwrapped.
 * - Alle Attribute weg, ausser denen in `PASTE_ALLOWED_ATTRS`.
 * - Anschliessend durch `cleanContentArtefacts` für inline-style-Reste.
 */
export function sanitizePasteHtml(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString('<div id="r">' + html + '</div>', 'text/html');
  const root = doc.getElementById('r');
  if (!root) return '';

  root.querySelectorAll('script, style, meta, link, title, iframe, object, embed, noscript')
    .forEach(el => el.remove());

  let guard = 32;
  let changed = true;
  while (changed && guard-- > 0) {
    changed = false;
    const all = Array.from(root.querySelectorAll('*'));
    for (const el of all) {
      const tag = el.tagName;
      if (tag === 'DIV' && !(el.getAttribute('class') || '').split(/\s+/).includes('poem')) {
        _unwrap(el);
        changed = true;
        continue;
      }
      if (!PASTE_ALLOWED_TAGS.has(tag)) {
        _unwrap(el);
        changed = true;
        continue;
      }
      const allowedAttrs = PASTE_ALLOWED_ATTRS[tag] || null;
      for (const attr of Array.from(el.attributes)) {
        if (!allowedAttrs || !allowedAttrs.has(attr.name)) el.removeAttribute(attr.name);
      }
      if (tag === 'DIV') el.setAttribute('class', 'poem');
      if (tag === 'A' && !el.getAttribute('href')) {
        _unwrap(el);
        changed = true;
      }
    }
  }

  return cleanContentArtefacts(root.innerHTML);
}

function _unwrap(el) {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

// Tags, auf denen `style` IMMER unerwünscht ist (Block-Styling kommt über
// .poem/.callout/style.css; der Editor selbst setzt nie inline-style).
// Strukturelemente wie img/table/td/col/figure/iframe bleiben unangetastet,
// dort sind Width-/Height-Angaben legitim.
const STRIP_STYLE_TAGS = new Set([
  'P', 'SPAN', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'LI', 'UL', 'OL', 'BLOCKQUOTE', 'A', 'B', 'I', 'STRONG', 'EM',
  'BR', 'PRE', 'CODE', 'SMALL', 'MARK', 'U', 'S', 'SUB', 'SUP',
]);

/**
 * Säubert HTML von Inline-Style-Müll, leeren Spans und Paste-Wrapper-Tags.
 *
 * Chrome friert beim Tippen oder Pasten in `contenteditable` die Computed-
 * Styles auf jedem Block ein (z.B. `<p style="margin:0.4em 0px;color:rgb(...);
 * font-family:Lato,...">`). Werden diese Inline-Styles mitgespeichert,
 * überschreiben sie beim Rendern die echten Block-Styles (`.poem` &Co)
 * und das Resultat sieht kaputt aus.
 *
 * Idempotent. Behält `style` auf img/table/td/col/figure/iframe.
 */
export function cleanContentArtefacts(html) {
  if (!html) return html;
  if (!/\sstyle\s*=|<(span|meta|link|script|style|title)\b/i.test(html)) return html;

  const tmp = document.createElement('div');
  tmp.innerHTML = html;

  // Paste-Wrapper aus Browser/Office (komplett raus, samt Inhalt)
  tmp.querySelectorAll('meta, link, script, style, title').forEach(el => el.remove());

  tmp.querySelectorAll('[style]').forEach(el => {
    if (STRIP_STYLE_TAGS.has(el.tagName)) el.removeAttribute('style');
  });

  // Leere Spans aus Paste-/Selection-Operationen entkernen
  tmp.querySelectorAll('span').forEach(span => {
    if (span.attributes.length === 0) {
      const parent = span.parentNode;
      if (!parent) return;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
    }
  });

  return tmp.innerHTML;
}

// Elemente mit eigenem "visuellen" Inhalt (dürfen leer wirken, bleiben erhalten).
const _STRUCTURAL_LEAF = 'img,iframe,video,audio,table,figure,hr,object,embed,canvas,svg,input,button';

function _isBlankTrailing(node) {
  if (!node) return false;
  if (node.nodeType === 3) return !node.textContent.replace(/\u00A0/g, ' ').trim();
  if (node.nodeType !== 1) return false;
  const tag = node.tagName;
  if (tag !== 'P' && tag !== 'DIV' && tag !== 'BR') return false;
  if (tag === 'BR') return true;
  if ((node.textContent || '').replace(/\u00A0/g, ' ').trim()) return false;
  if (node.querySelector(_STRUCTURAL_LEAF)) return false;
  return true;
}

/**
 * Reduziert Runs aufeinanderfolgender Leerblöcke (`<p></p>`, `<p><br></p>`,
 * `<p>&nbsp;</p>`, top-level `<br>`) auf je einen Block und Runs von `<br>`
 * innerhalb von Inline-Kontext (z.B. `<p>foo<br><br>bar</p>`) auf ein einzelnes
 * `<br>`. Ein einzelner Leerblock bleibt als bewusste Absatz-Trennung erhalten.
 * Idempotent. Nutzt DOMParser, keine Script-Side-Effects.
 */
export function collapseEmptyBlocks(html) {
  if (!html) return html;
  const doc = new DOMParser().parseFromString('<div id="r">' + html + '</div>', 'text/html');
  const root = doc.getElementById('r');
  if (!root) return html;

  // Top-Level: Run von Leerblöcken → erster Block bleibt, Rest weg.
  let node = root.firstChild;
  while (node) {
    const next = node.nextSibling;
    if (_isBlankTrailing(node)) {
      let probe = next;
      while (probe) {
        const probeNext = probe.nextSibling;
        if (probe.nodeType === 3 && !probe.textContent.replace(/\u00A0/g, ' ').trim()) {
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

  // Inline: aufeinanderfolgende `<br>` (auch durch Whitespace getrennt) → ein `<br>`.
  root.querySelectorAll('br').forEach(br => {
    let s = br.nextSibling;
    while (s) {
      const sn = s.nextSibling;
      if (s.nodeType === 3 && !s.textContent.replace(/\u00A0/g, ' ').trim()) {
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

  return root.innerHTML;
}

/**
 * Entfernt leere Absätze am Ende des HTML. contenteditable hängt beim Tippen
 * oft `<p><br></p>`/`<p>&nbsp;</p>` an; ohne Strip wachsen beim jedem Save
 * weitere Leerabsätze hinten ans BookStack-HTML. Idempotent, Top-Level only.
 * Nutzt DOMParser statt innerHTML-Assign, um keine Script-Side-Effects auszulösen.
 */
export function stripTrailingEmptyBlocks(html) {
  if (!html) return html;
  const doc = new DOMParser().parseFromString('<div id="r">' + html + '</div>', 'text/html');
  const root = doc.getElementById('r');
  if (!root) return html;
  let last = root.lastChild;
  while (last && _isBlankTrailing(last)) {
    const prev = last.previousSibling;
    root.removeChild(last);
    last = prev;
  }
  return root.innerHTML;
}
