'use strict';

// Block 24+25: Buch-Architektur-Meta + Buch-Anfang/-Ende
function buildArchitectureSamples(ctx) {
  const {
    langIsEn, displayName,
    chapterKeys, chapterNameByKey, pagesByChapter, pageContents,
    pushQA,
  } = ctx;

  // Strukturwissen: Kapitel-Liste, Nachbarschaften, Buch-Anfang/-Ende,
  // Anzahl. Gibt dem Modell ein mentales Inhaltsverzeichnis.
  const chapterNamesOrdered = chapterKeys
    .filter(k => k !== 0 || (pagesByChapter.get(k) || []).length > 0)
    .map(k => chapterNameByKey.get(k))
    .filter(Boolean);
  if (chapterNamesOrdered.length >= 2) {
    const joined = chapterNamesOrdered.map((n, i) => `${i + 1}. ${n}`).join('\n');
    pushQA('authorChat|archStructure',
      langIsEn ? `How is «${displayName}» structured?` : `Wie ist «${displayName}» aufgebaut?`,
      langIsEn
        ? `«${displayName}» consists of ${chapterNamesOrdered.length} chapters:\n${joined}`
        : `«${displayName}» besteht aus ${chapterNamesOrdered.length} Kapiteln:\n${joined}`);
    pushQA('authorChat|archList',
      langIsEn ? `List all chapters of «${displayName}».` : `Nenn mir alle Kapitel von «${displayName}».`,
      joined);
    pushQA('authorChat|archCount',
      langIsEn ? `How many chapters does «${displayName}» have?` : `Wie viele Kapitel hat «${displayName}»?`,
      langIsEn ? `${chapterNamesOrdered.length} chapters.` : `${chapterNamesOrdered.length} Kapitel.`);
    // Nachbarschaften: Vorgänger / Nachfolger
    for (let i = 0; i < chapterNamesOrdered.length; i++) {
      const name = chapterNamesOrdered[i];
      if (i + 1 < chapterNamesOrdered.length) {
        pushQA('authorChat|archNext|' + i,
          langIsEn ? `Which chapter follows «${name}»?` : `Welches Kapitel folgt auf «${name}»?`,
          langIsEn ? `The next chapter is «${chapterNamesOrdered[i + 1]}».` : `Das nächste Kapitel ist «${chapterNamesOrdered[i + 1]}».`);
      }
      if (i > 0) {
        pushQA('authorChat|archPrev|' + i,
          langIsEn ? `Which chapter comes before «${name}»?` : `Welches Kapitel kommt vor «${name}»?`,
          langIsEn ? `The previous chapter is «${chapterNamesOrdered[i - 1]}».` : `Das vorherige Kapitel ist «${chapterNamesOrdered[i - 1]}».`);
      }
    }
    // Erste / letzte Kapitel
    pushQA('authorChat|archFirst',
      langIsEn ? `What's the first chapter of «${displayName}»?` : `Welches ist das erste Kapitel von «${displayName}»?`,
      chapterNamesOrdered[0]);
    pushQA('authorChat|archLast',
      langIsEn ? `What's the last chapter of «${displayName}»?` : `Welches ist das letzte Kapitel von «${displayName}»?`,
      chapterNamesOrdered[chapterNamesOrdered.length - 1]);
  }

  // Buch-Anfang / -Ende: erste ~500 Zeichen der ersten Seite, letzte ~500
  // der letzten Seite. Verankert „Wie beginnt/endet das Buch?".
  if (pageContents.length > 0) {
    const firstPage = pageContents[0];
    const lastPage  = pageContents[pageContents.length - 1];
    if (firstPage?.text) {
      const head = firstPage.text.slice(0, Math.min(600, firstPage.text.length));
      pushQA('authorChat|archBegin',
        langIsEn ? `How does «${displayName}» begin?` : `Wie beginnt «${displayName}»?`,
        head);
    }
    if (lastPage?.text) {
      const tail = lastPage.text.slice(-Math.min(600, lastPage.text.length));
      pushQA('authorChat|archEnd',
        langIsEn ? `How does «${displayName}» end?` : `Wie endet «${displayName}»?`,
        tail);
    }
  }
}

module.exports = { buildArchitectureSamples };
