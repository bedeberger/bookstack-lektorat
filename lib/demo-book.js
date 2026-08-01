'use strict';
// Beispielbuch fuer echte User (Onboarding „Erste Schritte"): ein kleines,
// vollstaendiges Buch mit Kapiteln + Seiten, das ueber die Content-Store-Facade
// (gleicher Write-Chokepoint wie der Buch-Import → data-bid-Vergabe) angelegt
// wird. Kein KI-Call, kein Job noetig (5 Seiten, synchron).
//
// Prosa-Text: Public-Domain (Franz Kafka, „Die Verwandlung"). Bewusst als eigene
// SSoT hier — entkoppelt vom LOCAL_DEV_MODE-Seed (lib/dev-seed.js), der nur lokal
// laeuft. Der Text ist Anschauungsmaterial, damit Neue die Analyse-Funktionen
// (Figuren, Orte, Zeitstrahl, Lektorat) an echtem Inhalt sehen.
//
// Zweiter Seed in dieser Datei: `createForeignDemoBook` (unten) legt ein Buch
// eines FREMDEN Kontos an, auf dem der Demo-User nur `viewer` ist. Das laeuft
// ausschliesslich im Demo-Zugang, nie im Onboarding echter User — Begruendung
// im Kommentarblock dort.

const contentStore = require('./content-store');
const bookAccess = require('../db/book-access');
const appUsers = require('../db/app-users');
const logger = require('../logger');

const DEMO_BOOK_NAME = 'Beispiel: Die Verwandlung';
const DEMO_BOOK_DESCRIPTION = 'Ein Beispielbuch zum Ausprobieren — gemeinfreie Prosa von Franz Kafka. Leg damit los, lass es analysieren oder loesche es jederzeit wieder.';

// Prosa block-weise (ein Eintrag = ein <p>). data-bid vergibt der Content-Store
// am Write-Chokepoint automatisch — hier bewusst reines Markup.
const DEMO_PROSE = [
  {
    chapter: 'Kapitel 1 — Das Erwachen',
    pages: [
      {
        name: 'Die Verwandlung',
        blocks: [
          'Als Gregor Samsa eines Morgens aus unruhigen Träumen erwachte, fand er sich in seinem Bett zu einem ungeheueren Ungeziefer verwandelt. Er lag auf seinem panzerartig harten Rücken und sah, wenn er den Kopf ein wenig hob, seinen gewölbten, braunen, von bogenförmigen Versteifungen geteilten Bauch, auf dessen Höhe sich die Bettdecke, zum gänzlichen Niedergleiten bereit, kaum noch erhalten konnte.',
          '„Was ist mit mir geschehen?", dachte er. Es war kein Traum. Sein Zimmer, ein richtiges, nur etwas zu kleines Menschenzimmer, lag ruhig zwischen den vier wohlbekannten Wänden. Über dem Tisch, auf dem eine auseinandergepackte Musterkollektion von Tuchwaren ausgebreitet war — Samsa war Reisender — hing das Bild, das er vor kurzem aus einer illustrierten Zeitschrift ausgeschnitten und in einem hübschen, vergoldeten Rahmen untergebracht hatte.',
        ],
      },
      {
        name: 'Die Familie',
        blocks: [
          'Die Verwandlung hatte den Haushalt der Familie Samsa von einem Tag auf den anderen verändert. Der Vater, der seit fünf Jahren nicht mehr gearbeitet hatte, kramte alte Anzüge aus dem Schrank. Die Mutter, von Asthma geplagt, nähte feine Wäsche für ein Modegeschäft, und die Schwester Grete, gerade siebzehn Jahre alt, hatte eine Stellung als Verkäuferin gefunden.',
          'Gregor verfolgte alle Geräusche durch die geschlossene Tür. Er erkannte den Gang des Vaters, das schleppende Schreiten der Mutter, den raschen, leichten Schritt der Schwester. Manchmal wurde die Tür geöffnet, und Grete trat herein. Sie stellte die Schüssel mit Speiseresten in eine Ecke und zog sich rasch wieder zurück.',
        ],
      },
    ],
  },
  {
    chapter: 'Kapitel 2 — Der Rückzug',
    pages: [
      {
        name: 'Der Apfel',
        blocks: [
          'Eines Abends kam der Vater früher als sonst nach Hause. Gregor hatte das Zimmer verlassen wollen, um die Schwester nicht zu erschrecken. Doch der Vater, in seiner blauen Uniform mit den Goldknöpfen, sah die Tochter mit dem Schreckensschrei umsinken. Er griff nach einer Schüssel mit Obst, die auf der Anrichte stand, und begann, Apfel um Apfel zu werfen.',
          'Ein schwach geworfener Apfel streifte Gregors Rücken, glitt aber ohne Schaden ab. Ein ihm sofort nachfliegender drang dagegen förmlich in Gregors Rücken ein. Gregor wollte sich weiterschleppen, als drücke ihn der überraschende, unglaubliche Schmerz.',
        ],
      },
      {
        name: 'Drei Untermieter',
        blocks: [
          'Die drei Zimmerherren waren ernste Männer. Alle drei trugen Vollbärte und sahen einander zum Verwechseln ähnlich. Sie nahmen ihre Mahlzeiten mit ungeheurer Würde ein und prüften jeden Bissen, bevor er in den Mund gelangte. Die Eltern sahen ihnen mit Sorgfalt zu, dass nichts fehlte.',
          'Doch eines Abends spielte Grete Violine in der Küche. Der mittlere Herr rief zuerst seinen Freunden zu: „Kommen Sie doch, die Tochter spielt!" Sie nickten und setzten sich erwartungsvoll. Da öffnete Gregor die Tür um einen Spalt — und alle drei Herren bemerkten ihn zugleich.',
        ],
      },
      {
        name: 'Ende',
        blocks: [
          'Am frühen Morgen kam die Bedienerin und schrie laut auf. Sie stand vor dem leblosen Körper Gregors. Die Familie eilte herbei: der Vater im Hemd, die Mutter im Schlafrock, Grete in einem dünnen Kleid. „Tot?", fragte die Mutter. „Ich glaub schon", sagte die Bedienerin.',
          'Grete wandte den Blick nicht von dem Leichnam ab. „Seht nur, wie mager er war. Er hat ja auch schon so lange nichts gegessen." Dann verließ die Familie gemeinsam die Wohnung, was sie seit Monaten nicht mehr getan hatte, und fuhr mit der elektrischen Bahn ins Freie vor die Stadt.',
        ],
      },
    ],
  },
];

// Legt das Beispielbuch fuer einen User an (idempotent pro User: existiert es
// schon, wird die bestehende Buch-ID zurueckgegeben statt eines Duplikats).
// Laeuft ueber die Content-Store-Facade (createBook/createChapter/createPage) —
// der Write-Chokepoint vergibt data-bid, hookt den FTS-Index und legt eine
// Erst-Revision an. Rueckgabe: { bookId, deduplicated }.
async function createDemoBook(userEmail) {
  const ctx = { session: { user: { email: userEmail } } };

  // Dedup: Buchliste des Users ueber die Facade (kein direkter books-Zugriff).
  const existing = (await contentStore.listBooks(ctx)).find(b => b && b.name === DEMO_BOOK_NAME);
  if (existing) return { bookId: existing.id, deduplicated: true };

  const created = await contentStore.createBook(
    { name: DEMO_BOOK_NAME, description: DEMO_BOOK_DESCRIPTION, owner_email: userEmail },
    ctx,
  );
  const bookId = created.id;
  try {
    bookAccess.grantAccess(bookId, userEmail, 'owner', userEmail);
  } catch (e) {
    logger.warn(`Demo-Buch: Owner-Grant fuer book=${bookId} fehlgeschlagen: ${e.message}`);
  }

  let pages = 0;
  for (const ch of DEMO_PROSE) {
    const chapter = await contentStore.createChapter(
      { book_id: bookId, name: ch.chapter, parent_chapter_id: null },
      ctx,
    );
    for (const p of ch.pages) {
      const html = p.blocks.map(t => `<p>${t}</p>`).join('');
      await contentStore.createPage(
        { book_id: bookId, chapter_id: chapter.id, name: p.name, html },
        ctx,
      );
      pages += 1;
    }
  }

  logger.info(`Demo-Buch «${DEMO_BOOK_NAME}» angelegt (id=${bookId}, ${DEMO_PROSE.length} Kapitel, ${pages} Seiten) fuer ${userEmail}`);
  return { bookId, deduplicated: false };
}

// ── Zweites Buch: fremdes Eigentum, nur Leserecht ────────────────────────────
//
// Nur fuer den Demo-Zugang (lib/demo-user.js#seedDemoContent), NICHT fuer das
// Onboarding echter User: dieses Buch zeigt einen Fehlerfall, keine Funktion.
//
// Warum es existiert: die Browser-Erweiterung muss in der Store-Pruefung
// belegen, dass sie ein verweigertes Recht benennt statt stumm zu scheitern.
// Dafuer braucht der Pruefer ein Buch, in das er NICHT schreiben darf — er
// bekommt dort `403 INSUFFICIENT_ROLE` mit `detail.actual='viewer'` statt eines
// Haengers. Mit nur einem eigenen Buch ist dieser Pfad nicht vorfuehrbar.
//
// Die Besitzer-Adresse MUSS auf example.org lauten (RFC 2606, nie vergeben):
// `GET /content/books` gibt `owner_email` heraus, und der Pruefer sieht die
// Antwort. Dort darf keine echte Adresse auftauchen, auch keine interne.
const FOREIGN_BOOK_NAME = 'Fremdes Buch';
const FOREIGN_BOOK_DESCRIPTION = 'Gehoert einem anderen Konto. Du darfst es lesen, aber nicht bearbeiten — jeder Schreibversuch wird mit einer Begruendung abgelehnt.';
const FOREIGN_OWNER_EMAIL = 'fremde.autorin@example.org';
const FOREIGN_OWNER_NAME = 'Fremde Autorin';

// Eigener Text statt Public-Domain-Prosa: die Seite soll erklaeren, warum es
// dieses Buch gibt — ein Pruefer, der hineinklickt, liest die Antwort auf seine
// naechste Frage, statt sich zu wundern, wieso hier ein zweiter Roman liegt.
const FOREIGN_PROSE = {
  chapter: 'Kapitel 1 — Nur zum Ansehen',
  page: {
    name: 'Ein fremdes Manuskript',
    blocks: [
      'Dieses Buch gehoert einem anderen Konto. Du hast Leserecht darauf, aber kein Schreibrecht — genau wie bei einem Manuskript, das jemand mit dir geteilt hat, damit du es liest und nicht damit du es aenderst.',
      'Wer hier etwas erfassen oder aendern will, bekommt vom Server keine stille Fehlfunktion, sondern eine Begruendung: die eigene Rolle ist «viewer», noetig waere «editor». Die Clients zeigen genau diese Auskunft an, statt eine leere Meldung oder einen haengenden Ladebalken.',
      'Im ersten Buch, das dir selbst gehoert, funktioniert derselbe Handgriff ohne Umschweife. Der Unterschied zwischen beiden Buechern ist der Punkt dieser Demo.',
    ],
  },
};

/**
 * Legt das Fremdbuch samt Besitzer-Konto an und gibt dem Demo-User `viewer`.
 *
 * Idempotent ueber die BESITZ-Row, nicht ueber den Buchnamen: der Demo-User
 * darf den Namen aendern (er ist dort Viewer — nicht am Buch, aber ein Reset
 * spielt einen aelteren Stand ein), und Serverstart wie `demo-reset.timer`
 * rufen diese Funktion beliebig oft auf. Ein Namens-Dedup wuerde nach der
 * ersten Umbenennung ein zweites Buch anlegen.
 *
 * Rueckgabe: { bookId, deduplicated }.
 */
async function createForeignDemoBook(demoUserEmail) {
  const owner = String(FOREIGN_OWNER_EMAIL || '').toLowerCase();
  // Fail-closed statt „faellt schon niemandem auf": eine echte Adresse als
  // Buchbesitzer waere in `GET /content/books` fuer jeden Demo-Nutzer sichtbar.
  if (!/@example\.org$/.test(owner)) {
    throw new Error(`createForeignDemoBook: Besitzer-Adresse muss auf example.org lauten (ist: ${owner || '-'})`);
  }
  if (!demoUserEmail) throw new Error('createForeignDemoBook: demoUserEmail fehlt');

  // Das Konto traegt nur den FK von book_access und das Besitzer-Label. Es ist
  // bewusst 'suspended': niemand soll sich damit anmelden koennen, auch nicht,
  // wenn die Adresse eines Tages doch aufloest. Kein Invite-Recht, kein Admin.
  if (!appUsers.getUser(owner)) {
    appUsers.createUser({
      email: owner,
      displayName: FOREIGN_OWNER_NAME,
      globalRole: 'user',
      status: 'suspended',
      canInviteUsers: 0,
    });
    logger.info(`Demo-Fremdbuch: Besitzer-Konto ${owner} angelegt (suspended, nur Label + FK).`);
  }

  const ctx = { session: { user: { email: owner } } };

  const existing = bookAccess.listBookIdsForUser(owner).find(r => r.role === 'owner');
  if (existing) {
    // Viewer-Grant bei jedem Lauf neu setzen (Upsert): wird er entzogen, waere
    // das Buch fuer den Demo-User unsichtbar und der Pfad nicht mehr vorfuehrbar.
    bookAccess.grantAccess(existing.book_id, demoUserEmail, 'viewer', owner);
    return { bookId: existing.book_id, deduplicated: true };
  }

  const created = await contentStore.createBook(
    { name: FOREIGN_BOOK_NAME, description: FOREIGN_BOOK_DESCRIPTION, owner_email: owner },
    ctx,
  );
  const bookId = created.id;
  bookAccess.grantAccess(bookId, owner, 'owner', owner);

  const chapter = await contentStore.createChapter(
    { book_id: bookId, name: FOREIGN_PROSE.chapter, parent_chapter_id: null },
    ctx,
  );
  await contentStore.createPage(
    {
      book_id: bookId,
      chapter_id: chapter.id,
      name: FOREIGN_PROSE.page.name,
      html: FOREIGN_PROSE.page.blocks.map(t => `<p>${t}</p>`).join(''),
    },
    ctx,
  );

  // Zuletzt: erst wenn Inhalt da ist, soll das Buch beim Demo-User auftauchen.
  bookAccess.grantAccess(bookId, demoUserEmail, 'viewer', owner);

  logger.info(`Demo-Fremdbuch «${FOREIGN_BOOK_NAME}» angelegt (id=${bookId}, Besitzer ${owner}), ${demoUserEmail} ist viewer.`);
  return { bookId, deduplicated: false };
}

module.exports = {
  createDemoBook, DEMO_BOOK_NAME,
  createForeignDemoBook, FOREIGN_BOOK_NAME, FOREIGN_OWNER_EMAIL,
};
