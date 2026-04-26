'use strict';

const { db } = require('../../../../../db/schema');
const { extractName, escapeRe } = require('../../lib/names');

// Block 6-11: Zeitstrahl-Events + Tripel + Pair-Frames
function buildEventSamples(ctx) {
  const {
    langIsEn,
    bookIdInt, userEmail,
    figRows, figById, locRows,
    chaptersByLocPk,
    eventQuestions, pushQA, pickVariants,
  } = ctx;

  // ── Zeitstrahl-Q&A (angereichert) ─────────────────────────────────────
  // Ereignisse als zweite zentrale Säule der Buchwelt — alle verfügbaren
  // Felder (typ, figuren, kapitel, seiten) einfliessen lassen und pro
  // Ereignis mehrere spezialisierte Fragen stellen.
  const evtRows = db.prepare(
    'SELECT ereignis, datum, typ, bedeutung, kapitel, seiten, figuren FROM zeitstrahl_events WHERE book_id = ? AND user_email = ? ORDER BY sort_order'
  ).all(bookIdInt, userEmail || '');
  for (let i = 0; i < evtRows.length; i++) {
    const ev = evtRows[i];
    const ereignis = (ev.ereignis || '').trim();
    if (!ereignis) continue;
    // JSON-Felder defensiv parsen.
    const parseList = (v) => {
      if (!v) return [];
      if (Array.isArray(v)) return v;
      try { const r = JSON.parse(v); return Array.isArray(r) ? r : []; } catch { return []; }
    };
    const kapitelArr = parseList(ev.kapitel).map(k => extractName(k)).filter(Boolean);
    const seitenArr  = parseList(ev.seiten).map(s => extractName(s)).filter(Boolean);
    const figNames   = parseList(ev.figuren).map(f => extractName(f, figById)).filter(Boolean);

    const parts = [ereignis + '.'];
    if (ev.datum)     parts.push(langIsEn ? `When: ${ev.datum}.` : `Zeitpunkt: ${ev.datum}.`);
    if (ev.typ)       parts.push(langIsEn ? `Type: ${ev.typ}.` : `Art: ${ev.typ}.`);
    if (figNames.length) {
      parts.push(langIsEn
        ? `Characters involved: ${figNames.slice(0, 8).join(', ')}.`
        : `Beteiligte Figuren: ${figNames.slice(0, 8).join(', ')}.`);
    }
    if (kapitelArr.length) {
      parts.push(langIsEn
        ? `In chapter(s): ${kapitelArr.slice(0, 5).join(', ')}.`
        : `In Kapitel: ${kapitelArr.slice(0, 5).join(', ')}.`);
    }
    if (seitenArr.length) {
      parts.push(langIsEn
        ? `On page(s): ${seitenArr.slice(0, 5).join(', ')}.`
        : `Auf Seite(n): ${seitenArr.slice(0, 5).join(', ')}.`);
    }
    if (ev.bedeutung) parts.push((langIsEn ? 'Why it matters: ' : 'Bedeutung: ') + ev.bedeutung);
    const fullAnswer = parts.join(' ');

    // Haupt-Q&A: mehrere Paraphrasen mit voller Antwort
    const idxs = pickVariants('evt|' + i, eventQuestions, eventQuestions.length);
    for (const idx of idxs) {
      const q = eventQuestions[idx].replace('{ereignis}', ereignis);
      pushQA('authorChat|evt|' + i + '|' + idx, q, fullAnswer);
    }

    // Gezielte Sub-Fragen pro Facette
    if (figNames.length) {
      pushQA('authorChat|evt-fig|' + i,
        langIsEn ? `Who is involved in «${ereignis}»?` : `Wer ist bei «${ereignis}» dabei?`,
        figNames.join(', '));
    }
    if (kapitelArr.length) {
      pushQA('authorChat|evt-ch|' + i,
        langIsEn ? `In which chapter does «${ereignis}» happen?` : `In welchem Kapitel passiert «${ereignis}»?`,
        kapitelArr.join(', '));
    }
    if (ev.datum) {
      pushQA('authorChat|evt-when|' + i,
        langIsEn ? `When does «${ereignis}» happen?` : `Wann passiert «${ereignis}»?`,
        ev.datum);
    }
    if (ev.bedeutung) {
      pushQA('authorChat|evt-sig|' + i,
        langIsEn ? `What's the significance of «${ereignis}»?` : `Welche Bedeutung hat «${ereignis}»?`,
        ev.bedeutung);
    }
    if (ev.typ) {
      pushQA('authorChat|evt-typ|' + i,
        langIsEn ? `What type of event is «${ereignis}»?` : `Was für eine Art Ereignis ist «${ereignis}»?`,
        ev.typ);
    }
  }

  // ── Ereignisse × Orte × Figuren (Doppel-Verknüpfung) ─────────────────
  // zeitstrahl_events hat kein Orts-Feld → Orte ableiten via:
  //   (a) Kapitel-Schnittmenge mit location_chapters
  //   (b) Namens-Erwähnung in ereignis/bedeutung-Text
  // Ziel: pro Event reiche Tripel (Event, Figur, Ort) als Samples
  // erzeugen, plus inverse Aggregate (welche Events spielen am Ort X /
  // welche Events erlebt Figur Y / Schnittmenge Figur×Ort).
  const parseEvtList = (v) => {
    if (!v) return [];
    if (Array.isArray(v)) return v;
    try { const r = JSON.parse(v); return Array.isArray(r) ? r : []; } catch { return []; }
  };
  const locsByChapterName = new Map();
  for (const l of locRows) {
    for (const ch of (chaptersByLocPk.get(l.pk) || [])) {
      const key = (ch || '').toLowerCase();
      if (!key) continue;
      if (!locsByChapterName.has(key)) locsByChapterName.set(key, []);
      locsByChapterName.get(key).push(l);
    }
  }
  // Enriched events: { ereignis, datum, typ, bedeutung, figs:[{fig_id,name}], locs:[{pk,name}], kapitel:[], fullAnswer }
  const enrichedEvents = [];
  for (let i = 0; i < evtRows.length; i++) {
    const ev = evtRows[i];
    const ereignis = (ev.ereignis || '').trim();
    if (!ereignis) continue;
    const kapitelArr = parseEvtList(ev.kapitel).map(k => extractName(k)).filter(Boolean);
    const figRefs = parseEvtList(ev.figuren)
      .map(fv => {
        const name = extractName(fv, figById);
        if (!name) return null;
        const match = figRows.find(f => f.name === name || f.kurzname === name);
        return match ? { fig_id: match.fig_id, name: match.name } : { fig_id: null, name };
      })
      .filter(Boolean);
    const locSet = new Map();
    for (const ch of kapitelArr) {
      for (const l of (locsByChapterName.get(ch.toLowerCase()) || [])) {
        locSet.set(l.pk, l);
      }
    }
    const haystack = ((ev.ereignis || '') + ' ' + (ev.bedeutung || '')).toLowerCase();
    for (const l of locRows) {
      if (!l.name || l.name.length < 3) continue;
      const re = new RegExp('\\b' + escapeRe(l.name) + '\\b', 'i');
      if (re.test(haystack)) locSet.set(l.pk, l);
    }
    const locs = [...locSet.values()];
    // Vollantwort wie im Hauptblock (Datum/Typ/Figuren/Kapitel/Seiten/Bedeutung) — gespiegelt.
    const seitenArr = parseEvtList(ev.seiten).map(s => extractName(s)).filter(Boolean);
    const figNames = figRefs.map(f => f.name);
    const parts = [ereignis + '.'];
    if (ev.datum)      parts.push(langIsEn ? `When: ${ev.datum}.` : `Zeitpunkt: ${ev.datum}.`);
    if (ev.typ)        parts.push(langIsEn ? `Type: ${ev.typ}.` : `Art: ${ev.typ}.`);
    if (figNames.length) parts.push(langIsEn
      ? `Characters involved: ${figNames.slice(0, 8).join(', ')}.`
      : `Beteiligte Figuren: ${figNames.slice(0, 8).join(', ')}.`);
    if (locs.length) parts.push(langIsEn
      ? `Locations: ${locs.slice(0, 6).map(l => l.name).join(', ')}.`
      : `Schauplätze: ${locs.slice(0, 6).map(l => l.name).join(', ')}.`);
    if (kapitelArr.length) parts.push(langIsEn
      ? `In chapter(s): ${kapitelArr.slice(0, 5).join(', ')}.`
      : `In Kapitel: ${kapitelArr.slice(0, 5).join(', ')}.`);
    if (seitenArr.length) parts.push(langIsEn
      ? `On page(s): ${seitenArr.slice(0, 5).join(', ')}.`
      : `Auf Seite(n): ${seitenArr.slice(0, 5).join(', ')}.`);
    if (ev.bedeutung)  parts.push((langIsEn ? 'Why it matters: ' : 'Bedeutung: ') + ev.bedeutung);
    const fullAnswer = parts.join(' ');
    enrichedEvents.push({ i, ereignis, datum: ev.datum, typ: ev.typ, bedeutung: ev.bedeutung,
                          kapitel: kapitelArr, figs: figRefs, locs, fullAnswer });
  }

  // Pro-Event Q&A mit Orts-Bezug
  for (const e of enrichedEvents) {
    // Wo passiert das Ereignis?
    if (e.locs.length) {
      const locList = e.locs.slice(0, 6).map(l => l.name).join(', ');
      pushQA('authorChat|evt-loc|' + e.i,
        langIsEn ? `Where does «${e.ereignis}» take place?` : `Wo findet «${e.ereignis}» statt?`,
        locList);
      pushQA('authorChat|evt-loc2|' + e.i,
        langIsEn ? `At which locations does «${e.ereignis}» happen?` : `An welchen Schauplätzen spielt sich «${e.ereignis}» ab?`,
        locList);
      // Pro Einzel-Ort eine fokussierte Frage mit voller Antwort
      for (let li = 0; li < Math.min(e.locs.length, 4); li++) {
        const l = e.locs[li];
        pushQA('authorChat|evt-locDetail|' + e.i + '|' + l.pk,
          langIsEn ? `What happens at ${l.name} during «${e.ereignis}»?` : `Was passiert an ${l.name} bei «${e.ereignis}»?`,
          e.fullAnswer);
      }
    }
    // Pro Einzel-Figur fokussierte Frage mit voller Antwort
    for (let fi = 0; fi < Math.min(e.figs.length, 6); fi++) {
      const fg = e.figs[fi];
      const fkey = fg.fig_id || fg.name.toLowerCase();
      pushQA('authorChat|evt-figDetail|' + e.i + '|' + fkey,
        langIsEn ? `What does ${fg.name} experience during «${e.ereignis}»?` : `Was erlebt ${fg.name} bei «${e.ereignis}»?`,
        e.fullAnswer);
      pushQA('authorChat|evt-figRole|' + e.i + '|' + fkey,
        langIsEn ? `What is ${fg.name}'s role in «${e.ereignis}»?` : `Welche Rolle spielt ${fg.name} bei «${e.ereignis}»?`,
        e.fullAnswer);
    }
    // Tripel: Figur × Ort × Event
    if (e.figs.length && e.locs.length) {
      for (let fi = 0; fi < Math.min(e.figs.length, 4); fi++) {
        const fg = e.figs[fi];
        const fkey = fg.fig_id || fg.name.toLowerCase();
        for (let li = 0; li < Math.min(e.locs.length, 3); li++) {
          const l = e.locs[li];
          pushQA('authorChat|evt-figLoc|' + e.i + '|' + fkey + '|' + l.pk,
            langIsEn
              ? `What does ${fg.name} do at ${l.name} during «${e.ereignis}»?`
              : `Was macht ${fg.name} an ${l.name} während «${e.ereignis}»?`,
            e.fullAnswer);
          pushQA('authorChat|evt-figLoc2|' + e.i + '|' + fkey + '|' + l.pk,
            langIsEn
              ? `Why is ${fg.name} at ${l.name} in «${e.ereignis}»?`
              : `Warum ist ${fg.name} an ${l.name} bei «${e.ereignis}»?`,
            e.bedeutung || e.fullAnswer);
        }
      }
    }
  }

  // ── Inverse Aggregate: Events pro Ort / pro Figur / pro Figur×Ort ───
  const evtsByLocPk = new Map();
  const evtsByFigKey = new Map(); // fig_id || lowercased-name → [events]
  const evtsByFigLoc = new Map(); // fig_id+'|'+locPk → [events]
  for (const e of enrichedEvents) {
    for (const l of e.locs) {
      if (!evtsByLocPk.has(l.pk)) evtsByLocPk.set(l.pk, []);
      evtsByLocPk.get(l.pk).push(e);
    }
    for (const fg of e.figs) {
      const fkey = fg.fig_id || fg.name.toLowerCase();
      if (!evtsByFigKey.has(fkey)) evtsByFigKey.set(fkey, { name: fg.name, fig_id: fg.fig_id, items: [] });
      evtsByFigKey.get(fkey).items.push(e);
      for (const l of e.locs) {
        const k = fkey + '|' + l.pk;
        if (!evtsByFigLoc.has(k)) evtsByFigLoc.set(k, { fig: fg, loc: l, items: [] });
        evtsByFigLoc.get(k).items.push(e);
      }
    }
  }
  const renderEvtList = (items, max = 8) => items.slice(0, max)
    .map(e => `${e.datum ? e.datum + ': ' : ''}${e.ereignis}${e.bedeutung ? ' (' + e.bedeutung + ')' : ''}`)
    .join(' · ');
  // Pro Ort: alle dort spielenden Events
  for (const [locPk, items] of evtsByLocPk) {
    if (!items.length) continue;
    const loc = locRows.find(l => l.pk === locPk);
    if (!loc) continue;
    const list = renderEvtList(items, 10);
    pushQA('authorChat|evtsByLoc|' + loc.loc_id,
      langIsEn ? `Which events take place at ${loc.name}?` : `Welche Ereignisse spielen an ${loc.name}?`,
      list);
    pushQA('authorChat|evtsByLoc2|' + loc.loc_id,
      langIsEn ? `What happens at ${loc.name} over the course of the book?` : `Was geschieht an ${loc.name} im Verlauf des Buches?`,
      list);
    // Erst-Ereignis
    if (items[0]) {
      pushQA('authorChat|evtsByLocFirst|' + loc.loc_id,
        langIsEn ? `What's the first event at ${loc.name}?` : `Welches Ereignis spielt zuerst an ${loc.name}?`,
        items[0].fullAnswer);
    }
  }
  // Pro Figur: alle Zeitstrahl-Events, an denen sie beteiligt ist
  for (const [fkey, group] of evtsByFigKey) {
    if (!group.items.length) continue;
    const list = renderEvtList(group.items, 10);
    pushQA('authorChat|evtsByFig|' + fkey,
      langIsEn ? `Which events involve ${group.name}?` : `An welchen Ereignissen ist ${group.name} beteiligt?`,
      list);
    pushQA('authorChat|evtsByFig2|' + fkey,
      langIsEn ? `What does ${group.name} experience throughout the book?` : `Was erlebt ${group.name} im Verlauf des Buches?`,
      list);
    if (group.items.length >= 2) {
      pushQA('authorChat|evtsByFigArc|' + fkey,
        langIsEn ? `Trace ${group.name}'s arc through the events.` : `Zeichne ${group.name}s Bogen anhand der Ereignisse nach.`,
        list);
    }
  }
  // Schnittmenge Figur × Ort
  for (const [, group] of evtsByFigLoc) {
    if (group.items.length < 1) continue;
    const list = renderEvtList(group.items, 6);
    const fname = group.fig.name;
    const lname = group.loc.name;
    pushQA('authorChat|evtsByFigLoc|' + (group.fig.fig_id || fname.toLowerCase()) + '|' + group.loc.pk,
      langIsEn ? `Which events involve ${fname} at ${lname}?` : `Welche Ereignisse erlebt ${fname} an ${lname}?`,
      list);
  }
  // Pro Kapitel: alle Events (kapitelübergreifender Zugriff)
  const evtsByChapter = new Map();
  for (const e of enrichedEvents) {
    for (const ch of e.kapitel) {
      const key = ch.toLowerCase();
      if (!evtsByChapter.has(key)) evtsByChapter.set(key, { name: ch, items: [] });
      evtsByChapter.get(key).items.push(e);
    }
  }
  for (const [key, group] of evtsByChapter) {
    if (!group.items.length) continue;
    const list = renderEvtList(group.items, 10);
    pushQA('authorChat|evtsByCh|' + key.replace(/\s+/g, '_').slice(0, 80),
      langIsEn ? `Which events take place in «${group.name}»?` : `Welche Ereignisse passieren in «${group.name}»?`,
      list);
  }

  // ── Globale (externe) Ereignisse — gezielt boosten ───────────────────
  // typ='extern' = gesellschaftlich/historisch (Kriege, Krisen, Sport,
  // Naturkatastrophen). Eigene Aggregate + zusätzliche Q&A pro externes
  // Event, damit das Modell den historischen Hintergrund prominent lernt.
  const externEvents = enrichedEvents.filter(e => (e.typ || '').toLowerCase() === 'extern');
  const persoenlichEvents = enrichedEvents.filter(e => (e.typ || '').toLowerCase() === 'persoenlich' || !e.typ);
  if (externEvents.length) {
    const list = externEvents.slice(0, 15)
      .map(e => `${e.datum ? e.datum + ': ' : ''}${e.ereignis}`)
      .join(' · ');
    pushQA('authorChat|evtsExternAll',
      langIsEn ? `Which historical or global events appear in the book?` : `Welche historischen oder globalen Ereignisse spielen im Buch eine Rolle?`,
      list);
    pushQA('authorChat|evtsExternAll2',
      langIsEn ? `What's the historical backdrop of the book?` : `Welcher historische Hintergrund prägt das Buch?`,
      list);
    pushQA('authorChat|evtsExternAll3',
      langIsEn ? `List the external events that shape the story.` : `Liste die externen Ereignisse, die die Geschichte prägen.`,
      list);
    // Pro externes Event extra Frames + Figur-Auswirkung
    for (const e of externEvents) {
      pushQA('authorChat|evtExtCtx|' + e.i,
        langIsEn ? `What is the historical context of «${e.ereignis}»?` : `Welcher historische Kontext steckt hinter «${e.ereignis}»?`,
        e.fullAnswer);
      pushQA('authorChat|evtExtSoc|' + e.i,
        langIsEn ? `How does «${e.ereignis}» shape the world of the book?` : `Wie prägt «${e.ereignis}» die Welt des Buches?`,
        e.bedeutung || e.fullAnswer);
      for (const fg of e.figs.slice(0, 6)) {
        const fkey = fg.fig_id || fg.name.toLowerCase();
        pushQA('authorChat|evtExtFig|' + e.i + '|' + fkey,
          langIsEn ? `How does «${e.ereignis}» affect ${fg.name}?` : `Wie betrifft «${e.ereignis}» ${fg.name}?`,
          e.fullAnswer);
        pushQA('authorChat|evtExtFigLife|' + e.i + '|' + fkey,
          langIsEn ? `What does ${fg.name} live through during «${e.ereignis}»?` : `Was erlebt ${fg.name} während «${e.ereignis}»?`,
          e.fullAnswer);
      }
    }
    // Pro Figur Trennung extern/persönlich für Sortier-Recall
    const externByFig = new Map();
    for (const e of externEvents) {
      for (const fg of e.figs) {
        const fkey = fg.fig_id || fg.name.toLowerCase();
        if (!externByFig.has(fkey)) externByFig.set(fkey, { name: fg.name, items: [] });
        externByFig.get(fkey).items.push(e);
      }
    }
    for (const [fkey, group] of externByFig) {
      const list2 = renderEvtList(group.items, 8);
      pushQA('authorChat|evtsExtByFig|' + fkey,
        langIsEn ? `Which historical events touch ${group.name}'s life?` : `Welche historischen Ereignisse berühren ${group.name}s Leben?`,
        list2);
    }
  }
  // ── Kausalketten via sort_order-Nachbarn ─────────────────────────────
  // sort_order in zeitstrahl_events spiegelt narrativ-chronologische Folge.
  // Pro Event: was führt dahin (Vorgänger), was folgt (Nachfolger). Lehrt
  // narrative Logik statt isolierter Fakten.
  for (let i = 0; i < enrichedEvents.length; i++) {
    const e = enrichedEvents[i];
    if (i > 0) {
      const prev = enrichedEvents[i - 1];
      pushQA('authorChat|evtCausePrev|' + e.i,
        langIsEn ? `What leads up to «${e.ereignis}»?` : `Was führt zu «${e.ereignis}»?`,
        prev.fullAnswer);
      pushQA('authorChat|evtCausePrev2|' + e.i,
        langIsEn ? `What happens just before «${e.ereignis}»?` : `Was geschieht unmittelbar vor «${e.ereignis}»?`,
        prev.ereignis + (prev.bedeutung ? ' — ' + prev.bedeutung : ''));
    }
    if (i + 1 < enrichedEvents.length) {
      const next = enrichedEvents[i + 1];
      pushQA('authorChat|evtCauseNext|' + e.i,
        langIsEn ? `What follows from «${e.ereignis}»?` : `Was folgt aus «${e.ereignis}»?`,
        next.fullAnswer);
      pushQA('authorChat|evtCauseNext2|' + e.i,
        langIsEn ? `What happens right after «${e.ereignis}»?` : `Was geschieht direkt nach «${e.ereignis}»?`,
        next.ereignis + (next.bedeutung ? ' — ' + next.bedeutung : ''));
    }
    // 2-Schritt-Kette
    if (i + 2 < enrichedEvents.length) {
      const a = enrichedEvents[i + 1];
      const b = enrichedEvents[i + 2];
      pushQA('authorChat|evtChain|' + e.i,
        langIsEn ? `Trace the chain of events starting from «${e.ereignis}».` : `Zeichne die Ereigniskette ab «${e.ereignis}» nach.`,
        [e, a, b].map(x => `${x.datum ? x.datum + ': ' : ''}${x.ereignis}`).join(' → '));
    }
  }

  // ── Chronologie-Aggregate ────────────────────────────────────────────
  if (enrichedEvents.length >= 2) {
    const chrono = enrichedEvents.slice(0, 30)
      .map((e, idx) => `${idx + 1}. ${e.datum ? e.datum + ': ' : ''}${e.ereignis}`)
      .join('\n');
    pushQA('authorChat|evtChrono',
      langIsEn ? `List the events of the book in chronological order.` : `Liste die Ereignisse des Buches in chronologischer Reihenfolge.`,
      chrono);
    pushQA('authorChat|evtChrono2',
      langIsEn ? `What's the timeline of the book?` : `Wie sieht der Zeitstrahl des Buches aus?`,
      chrono);
  }

  // ── POV-Prosa pro Event×Figur ────────────────────────────────────────
  // Anders als evt-figDetail (das nur fullAnswer wiederholt): Antwort-Frame
  // erzwingt Ich-/Er-Perspektive in Prosa, Modell soll POV-Verschiebung
  // lernen. Antwort bleibt fullAnswer, aber Prompt rahmt klar als Prosa-
  // Aufgabe → Trainings-Signal kommt aus dem Prompt-Framing.
  for (const e of enrichedEvents) {
    for (const fg of e.figs.slice(0, 4)) {
      const fkey = fg.fig_id || fg.name.toLowerCase();
      pushQA('authorChat|evtPov|' + e.i + '|' + fkey,
        langIsEn
          ? `Tell «${e.ereignis}» from ${fg.name}'s point of view.`
          : `Erzähle «${e.ereignis}» aus ${fg.name}s Sicht.`,
        e.fullAnswer);
      pushQA('authorChat|evtPovInner|' + e.i + '|' + fkey,
        langIsEn
          ? `What goes through ${fg.name}'s mind during «${e.ereignis}»?`
          : `Was geht ${fg.name} während «${e.ereignis}» durch den Kopf?`,
        e.bedeutung || e.fullAnswer);
    }
  }

  if (persoenlichEvents.length) {
    const personByFig = new Map();
    for (const e of persoenlichEvents) {
      for (const fg of e.figs) {
        const fkey = fg.fig_id || fg.name.toLowerCase();
        if (!personByFig.has(fkey)) personByFig.set(fkey, { name: fg.name, items: [] });
        personByFig.get(fkey).items.push(e);
      }
    }
    for (const [fkey, group] of personByFig) {
      if (group.items.length < 1) continue;
      const list2 = renderEvtList(group.items, 8);
      pushQA('authorChat|evtsPersByFig|' + fkey,
        langIsEn ? `What are ${group.name}'s personal turning points?` : `Was sind ${group.name}s persönliche Wendepunkte?`,
        list2);
    }
  }

  // ── Figuren-Paar-Events (Wann/Wo/Was zwischen A und B) ───────────────
  // Pro Event mit ≥2 Figuren werden alle ungeordneten Figuren-Paare
  // permutiert (A→B). Dadurch bekommt das Modell pro (A,B,Event) drei
  // bis vier zeitlich-örtliche Q&A-Frames. Bei semantisch erkennbaren
  // ereignis-Texten (Kuss/Hochzeit/Streit/…) entsteht zusätzlich eine
  // natürliche Verbalisierung.
  const verbalize = (ereignis) => {
    const t = (ereignis || '').toLowerCase();
    if (langIsEn) {
      if (/\bkiss/.test(t))                     return { de: null, en: 'kiss for the first time' };
      if (/\b(meet|first met|first encounter)/.test(t)) return { de: null, en: 'first meet' };
      if (/\b(wedding|marri|got married)/.test(t)) return { de: null, en: 'get married' };
      if (/\b(fight|argu|quarrel)/.test(t))      return { de: null, en: 'have a fight' };
      if (/\b(break.?up|separat|split)/.test(t)) return { de: null, en: 'break up' };
      if (/\b(reuni|reunion)/.test(t))           return { de: null, en: 'reunite' };
      return null;
    }
    if (/\b(kuss|geküsst|küssen)/.test(t))          return { de: 'sich das erste Mal geküsst', en: null };
    if (/\b(kennengelernt|kennenlern)/.test(t))     return { de: 'sich kennengelernt', en: null };
    if (/\b(hochzeit|geheiratet|heirat)/.test(t))   return { de: 'geheiratet', en: null };
    if (/\b(streit|gestritten)/.test(t))            return { de: 'Streit gehabt', en: null };
    if (/\b(trennung|getrennt|trennen)/.test(t))    return { de: 'sich getrennt', en: null };
    if (/\b(versöhn|wiedersehen|wiedergesehen)/.test(t)) return { de: 'sich wiedergesehen', en: null };
    if (/\b(geboren|geburt)/.test(t))               return { de: 'sich geboren', en: null };
    return null;
  };
  const fmtWhenWhere = (datum, ortName, bedeutung) => {
    const parts = [];
    if (datum && ortName)       parts.push(langIsEn ? `In ${datum}, at ${ortName}.` : `Im ${datum}, an ${ortName}.`);
    else if (datum)             parts.push(langIsEn ? `In ${datum}.` : `Im ${datum}.`);
    else if (ortName)           parts.push(langIsEn ? `At ${ortName}.` : `An ${ortName}.`);
    if (bedeutung)              parts.push(bedeutung);
    return parts.join(' ');
  };
  for (const e of enrichedEvents) {
    if (e.figs.length < 2) continue;
    const primaryLoc = e.locs[0]?.name || '';
    const dat = e.datum || '';
    const bed = e.bedeutung || '';
    const verb = verbalize(e.ereignis);
    // Geordnete Paare A→B (beide Richtungen, damit Modell Reihenfolge-invariant lernt)
    for (let ai = 0; ai < e.figs.length; ai++) {
      for (let bi = 0; bi < e.figs.length; bi++) {
        if (ai === bi) continue;
        if (ai >= 4 || bi >= 4) continue; // cap
        const A = e.figs[ai];
        const B = e.figs[bi];
        const akey = A.fig_id || A.name.toLowerCase();
        const bkey = B.fig_id || B.name.toLowerCase();
        const pairKey = e.i + '|' + akey + '|' + bkey;
        const whenWhere = fmtWhenWhere(dat, primaryLoc, bed);
        // Generische Wann-Frage
        if (dat || primaryLoc) {
          pushQA('authorChat|evtPairWhen|' + pairKey,
            langIsEn
              ? `When does «${e.ereignis}» happen between ${A.name} and ${B.name}?`
              : `Wann passiert «${e.ereignis}» zwischen ${A.name} und ${B.name}?`,
            whenWhere || e.fullAnswer);
        }
        // Generische Wo-Frage
        if (primaryLoc) {
          pushQA('authorChat|evtPairWhere|' + pairKey,
            langIsEn
              ? `Where does «${e.ereignis}» happen between ${A.name} and ${B.name}?`
              : `Wo passiert «${e.ereignis}» zwischen ${A.name} und ${B.name}?`,
            fmtWhenWhere(dat, primaryLoc, bed) || primaryLoc);
        }
        // Was-Frage mit voller Antwort
        pushQA('authorChat|evtPairWhat|' + pairKey,
          langIsEn
            ? `What happens between ${A.name} and ${B.name} during «${e.ereignis}»?`
            : `Was passiert zwischen ${A.name} und ${B.name} bei «${e.ereignis}»?`,
          e.fullAnswer);
        // Verbalisierte Variante (Kuss/Hochzeit/etc.)
        if (verb) {
          const phrase = langIsEn ? verb.en : verb.de;
          if (phrase) {
            if (dat || primaryLoc) {
              pushQA('authorChat|evtPairVerbWhen|' + pairKey,
                langIsEn
                  ? `When do ${A.name} and ${B.name} ${phrase}?`
                  : `Wann haben ${A.name} und ${B.name} ${phrase}?`,
                whenWhere || e.fullAnswer);
            }
            if (primaryLoc) {
              pushQA('authorChat|evtPairVerbWhere|' + pairKey,
                langIsEn
                  ? `Where do ${A.name} and ${B.name} ${phrase}?`
                  : `Wo haben ${A.name} und ${B.name} ${phrase}?`,
                fmtWhenWhere(dat, primaryLoc, bed) || primaryLoc);
            }
          }
        }
      }
    }
  }
}

module.exports = { buildEventSamples };
