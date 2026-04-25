'use strict';

const { hashSplit } = require('../../lib/names');
const { buildFigureBaseSamples, buildFigureMetaSamples } = require('./figures');
const { buildLocationSamples, buildLocationPassageSamples } = require('./locations');
const { buildSceneQASamples } = require('./scenes');
const { buildEventSamples } = require('./events');
const { buildRelationSamples } = require('./relations');
const { buildFactSamples, buildReverseLookupSamples } = require('./facts');
const { buildFigurePassageSamples } = require('./passages');
const { buildArchitectureSamples } = require('./architecture');
const { buildReviewSamples } = require('./reviews');

// Mehr Fragevarianten = Modell lernt dieselbe Buchfakten über viele
// Formulierungen hinweg assoziieren → schnellere Memorisierung der Welt.
function buildQuestionPools(langIsEn) {
  const figQuestions = langIsEn
    ? ['Who is {name}?', 'Tell me about {name}.', 'How would you describe {name}?',
       'What do I need to know about {name}?', 'What is {name} like?',
       "What's {name}'s story?", 'Give me a portrait of {name}.']
    : ['Wer ist {name}?', 'Erzähl mir von {name}.', 'Wie würdest du {name} beschreiben?',
       'Was sollte ich über {name} wissen?', 'Was für ein Mensch ist {name}?',
       'Was ist {name} für eine Figur?', 'Zeichne mir ein Bild von {name}.'];
  const ortQuestions = langIsEn
    ? ['What is {name}?', 'Describe {name}.', 'What kind of place is {name}?',
       'How does {name} feel?', 'Tell me about {name}.',
       'What should I imagine when I hear {name}?']
    : ['Was ist {name}?', 'Beschreibe {name}.', 'Was für ein Ort ist {name}?',
       'Wie wirkt {name}?', 'Erzähl mir von {name}.',
       'Was soll ich mir unter {name} vorstellen?'];
  const sceneQuestions = langIsEn
    ? ['What happens in «{titel}»?', 'Can you summarize the scene «{titel}»?',
       'What is «{titel}» about?', 'Tell me about the scene «{titel}».',
       "What's going on in «{titel}»?"]
    : ['Was passiert in «{titel}»?', 'Worum geht es in «{titel}»?',
       'Fasse die Szene «{titel}» zusammen.', 'Erzähl mir von der Szene «{titel}».',
       'Was spielt sich in «{titel}» ab?'];
  const eventQuestions = langIsEn
    ? ['What happens around {ereignis}?', 'What is the significance of {ereignis}?',
       'Tell me about {ereignis}.', 'How does {ereignis} matter?']
    : ['Was weisst du über {ereignis}?', 'Welche Bedeutung hat {ereignis}?',
       'Erzähl mir von {ereignis}.', 'Warum ist {ereignis} wichtig?'];
  const chapterQuestions = langIsEn
    ? ['What happens in «{kapitel}»?', 'Summarize «{kapitel}» for me.',
       'Walk me through «{kapitel}».', 'What is «{kapitel}» about?']
    : ['Was passiert in «{kapitel}»?', 'Fasse «{kapitel}» zusammen.',
       'Was geschieht im Kapitel «{kapitel}»?', 'Worum geht es in «{kapitel}»?'];
  return { figQuestions, ortQuestions, sceneQuestions, eventQuestions, chapterQuestions };
}

function buildAuthorChatHelpers(ctx) {
  const { samples, counts, opts, unifiedSys } = ctx;
  const seed = opts.valSeed;

  // Deterministische Auswahl einer Paraphrase pro Entity — bei gleichem Seed
  // reproduzierbar. `pickVariants` liefert `count` Indizes ohne Dubletten.
  const pickVariants = (id, variants, count) => {
    if (variants.length <= count) return variants.map((_, i) => i);
    const seen = new Set();
    const out = [];
    for (let i = 0; i < count * 4 && out.length < count; i++) {
      const v = Math.floor(hashSplit(id + '|' + i, seed) * variants.length);
      if (seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
    return out;
  };

  const pushQA = (id, q, a) => {
    const qq = (q || '').trim();
    const aa = (a || '').trim();
    if (qq.length < 4 || aa.length < 20) return;
    samples.push({
      id,
      type: 'authorChat',
      messages: [
        { role: 'system', content: unifiedSys },
        { role: 'user',   content: qq },
        { role: 'assistant', content: aa },
      ],
    });
    counts.authorChat++;
  };

  return { pickVariants, pushQA };
}

function buildAuthorChatSamples(ctx) {
  const pools = buildQuestionPools(ctx.langIsEn);
  const helpers = buildAuthorChatHelpers(ctx);
  // ctx wird um helpers + pools erweitert; alle sub-modules greifen darauf zu.
  const subCtx = { ...ctx, ...pools, ...helpers };

  buildFigureBaseSamples(subCtx);          // Block 1+2: figuren composite + traits
  buildLocationSamples(subCtx);            // Block 3+4: orte einzeln + aggregate
  buildSceneQASamples(subCtx);             // Block 5: szenen
  buildEventSamples(subCtx);               // Block 6-11: zeitstrahl + tripel + paar
  buildRelationSamples(subCtx);            // Block 12-16: rel + cast + family + power + tag
  buildFigureMetaSamples(subCtx);          // Block 17+18+19: figEvt + figApp + figVoice
  buildFactSamples(subCtx);                // Block 20: chapter_extract_cache facts
  buildFigurePassageSamples(subCtx);       // Block 21: figPass + figPassCh
  buildLocationPassageSamples(subCtx);     // Block 22: ortPass
  buildReverseLookupSamples(subCtx);       // Block 23: revPage + revChap
  buildArchitectureSamples(subCtx);        // Block 24+25: kapitel-list + begin/end
  buildReviewSamples(subCtx);              // Block 26+27+28: book-rev + chap-rev + chat
}

module.exports = { buildAuthorChatSamples };
