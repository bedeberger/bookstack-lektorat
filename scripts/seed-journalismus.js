#!/usr/bin/env node
'use strict';
// Beispiel-Ressort zum Ausprobieren des journalistischen Arbeitens.
//
//   node scripts/seed-journalismus.js [owner-email]
//
// Legt ein Buch vom Typ `journalismus` an: zwei Rubriken, sechs Beiträge in
// fünf Textsorten, dazu eine O-Ton-Quelle mit ausstehender Autorisierung und
// eine mit Freigabe. Idempotent über den Buchnamen — ein zweiter Lauf legt
// nichts doppelt an, sondern bricht mit Hinweis ab.
//
// Die Beiträge sind ABSICHTLICH mangelhaft, jeder auf seine Art — sonst hat man
// nichts zu sehen:
//   · «Gemeinderat bewilligt …» (Nachricht): Indikativ in der indirekten Rede,
//     Amtsdeutsch, Kostenangabe ohne Herkunft, kein «wann» im Lead.
//   · «Nach dem Hochwasser» (Bericht): Wertung der Redaktion im berichtenden
//     Text, Gegenposition fehlt.
//   · «Sechs Uhr früh am Bahnhof» (Reportage): steigt zusammenfassend statt
//     szenisch ein, wechselt mitten im Text das Tempus.
//   · «Wir haben zu lange zugeschaut» (Kommentar): meinungsstark — hier darf die
//     Wertung stehen, das Lektorat meldet sie nicht (Textsorten-Schnitt).
//   · «Drei Fragen an die Stadtpräsidentin» (Interview): Doppelfrage, keine
//     kritische Nachfrage, zitiert den noch nicht freigegebenen O-Ton.
//   · «Der Mann, der die Uhren stellt» (Porträt): Ämter-Aufzählung statt Szene.
//
// Danach im UI: Buch wählen → Karte «Struktur» (nur bei diesem Buchtyp
// sichtbar) → «Alle prüfen»; Lektorat wie gewohnt pro Seite.

const path = require('path');
const contentStore = require('../lib/content-store');
const { db } = require('../db/connection');
const { setBookTextsorte } = require('../db/schema');
const { setPageTextsorte } = require('../db/textsorte');
const sources = require('../db/sources');

const BOOK_NAME = 'Ressort Stadt (Beispiel)';

const P = (...abs) => abs.map(a => `<p>${a}</p>`).join('\n');

const RUBRIKEN = [
  {
    name: 'Politik',
    beitraege: [
      {
        name: 'Gemeinderat bewilligt Sanierung des Hallenbads',
        textsorte: 'nachricht',
        blocks: [
          'Der Gemeinderat hat die Sanierung des Hallenbads bewilligt. Die Vorlage passierte das Gremium mit 24 zu 11 Stimmen bei drei Enthaltungen.',
          'Die Sanierung kostet 18,4 Millionen Franken. Sie umfasst die Erneuerung der Wassertechnik, die energetische Ertüchtigung der Gebäudehülle sowie die Inbetriebnahme eines zweiten Beckens für den Schulschwimmsport.',
          'Bauvorstand Peter Hasler sagte, die Arbeiten sind auf drei Etappen verteilt und der Betrieb bleibt während der gesamten Bauzeit aufrechterhalten. Im Rahmen der Massnahme wird zudem die Zufahrt neu organisiert.',
          'Gegen die Vorlage hatte sich eine Minderheit gestellt, die eine Gesamterneuerung an anderem Standort forderte. Ein Referendum ist möglich.',
        ],
      },
      {
        name: 'Nach dem Hochwasser: Der Wiederaufbau stockt',
        textsorte: 'bericht',
        blocks: [
          'Vier Monate nach dem Hochwasser vom März sind von 61 beschädigten Gebäuden im Unterdorf erst 19 wieder bewohnbar. Das geht aus einer Aufstellung der Gemeinde hervor, die diese Woche veröffentlicht wurde.',
          'Verantwortlich für die skandalöse Verzögerung ist die Gebäudeversicherung, die Gutachten in einem geradezu erschreckenden Tempo bearbeitet. Betroffene warten seit Wochen auf einen Bescheid.',
          'Die Gemeinde hat einen Härtefallfonds über 1,2 Millionen Franken eingerichtet. Bislang wurden daraus 340 000 Franken ausbezahlt, wie die Sozialvorsteherin auf Anfrage mitteilte.',
          'Wie es weitergeht, ist offen. Der Kanton prüft, ob er sich am Fonds beteiligt.',
        ],
      },
    ],
  },
  {
    name: 'Reportage & Meinung',
    beitraege: [
      {
        name: 'Sechs Uhr früh am Bahnhof',
        textsorte: 'reportage',
        blocks: [
          'Der Bahnhof ist morgens ein Ort, an dem viele verschiedene Menschen aufeinandertreffen und in dem sich der soziale Wandel der Stadt zeigt. Das lässt sich an mehreren Beispielen darlegen.',
          'Um 6.12 Uhr fährt der erste Regionalzug ein. Elf Menschen steigen aus, zwei davon mit Werkzeugkoffern. Der Kioskbetreiber Aldo Ferrari schiebt die Rollläden hoch und stellt zwei Stapel Zeitungen auf den Tresen.',
          'Ferrari arbeitete seit 1998 an diesem Ort. Er sagte, früher kamen die Pendler in Wellen, heute tröpfeln sie den ganzen Tag herein.',
          'Gegen sieben füllt sich die Halle. Eine Frau in Warnweste räumt Kaffeebecher zusammen. Der Zug nach Zürich hat vier Minuten Verspätung, was niemanden zu stören scheint.',
        ],
      },
      {
        name: 'Wir haben zu lange zugeschaut',
        textsorte: 'kommentar',
        blocks: [
          'Die Verzögerung beim Wiederaufbau im Unterdorf ist ein Versagen mit Ansage. Wer vier Monate nach einer Katastrophe erst ein Drittel der Gebäude wieder bewohnbar hat, hat nicht gezögert, sondern versagt.',
          'Natürlich braucht ein Gutachten Zeit, und natürlich sind die Schäden komplex. Aber die Gemeinde wusste seit dem ersten Tag, wie viele Häuser betroffen sind. Sie hätte die Verfahren bündeln können, statt jeden Fall einzeln durch dieselbe Mühle zu schicken.',
          'Der Härtefallfonds ist richtig. Nur ist er ein Pflaster, kein Verfahren. Solange die Gutachten stocken, verteilt die Gemeinde Almosen statt Ansprüche.',
          'Es braucht jetzt eine Frist: Wer nach acht Wochen keinen Bescheid hat, bekommt eine Akontozahlung. Alles andere ist Verwaltung des Stillstands.',
        ],
      },
      {
        name: 'Drei Fragen an die Stadtpräsidentin',
        textsorte: 'interview',
        blocks: [
          'Regula Brunner ist seit 2022 Stadtpräsidentin. Wir haben sie zum Stand des Wiederaufbaus befragt.',
          '<strong>Frau Brunner, wie zufrieden sind Sie mit dem Tempo des Wiederaufbaus und was sagen Sie den Betroffenen, die seit Wochen warten?</strong>',
          'Ich verstehe den Unmut. Wir haben die Verfahren so aufgesetzt, wie es das Gesetz verlangt, und das dauert. Trotzdem: Ich hätte mir mehr Tempo gewünscht.',
          '<strong>Der Härtefallfonds ist zu einem Viertel ausgeschöpft. Reicht das?</strong>',
          'Der Fonds ist ein Instrument für akute Notlagen, kein Ersatz für die Versicherungsleistung. Wenn er ausgeschöpft wird, reden wir über eine Aufstockung.',
          '<strong>Und wann sind alle Häuser wieder bewohnbar?</strong>',
          'Das kann ich Ihnen nicht sagen. Wir arbeiten daran.',
        ],
      },
      {
        name: 'Der Mann, der die Uhren stellt',
        textsorte: 'portraet',
        blocks: [
          'Kurt Ammann ist seit 1994 Turmuhrenwart der Stadt, Mitglied der Denkmalkommission, Vorstandsmitglied des Verkehrsvereins und war von 2003 bis 2011 im Gemeindeparlament. Ausserdem präsidiert er den Verein der Freunde des Stadtarchivs.',
          'Zweimal im Jahr steigt er in die Türme von St. Martin, der Kapelle im Unterdorf und des alten Rathauses, um die Uhren auf die Zeitumstellung einzustellen. Insgesamt sind es 142 Stufen.',
          'Die Arbeit ist unbezahlt. Ammann sagt, es gehe ihm nicht ums Geld, sondern darum, dass die Stadt zur richtigen Zeit schlägt.',
        ],
      },
    ],
  },
];

// O-Töne: der erste ist der Fall, um den es geht — im Interview zitiert, aber
// noch nicht freigegeben. Der zweite zeigt den Normalfall.
const OTOENE = [
  {
    csl_type: 'interview',
    authors: [{ family: 'Brunner', given: 'Regula' }],
    title: 'Gespräch über den Wiederaufbau im Unterdorf',
    oton_role: 'Stadtpräsidentin',
    oton_channel: 'persoenlich',
    oton_date: '2026-07-29',
    oton_auth: 'ausstehend',
    year: '2026',
    note: 'Autorisierung am 29.07. per Mail angefragt, noch keine Antwort.',
  },
  {
    csl_type: 'interview',
    authors: [{ family: 'Hasler', given: 'Peter' }],
    title: 'Telefonat zur Hallenbad-Sanierung',
    oton_role: 'Bauvorstand',
    oton_channel: 'telefon',
    oton_date: '2026-07-31',
    oton_auth: 'freigegeben',
    year: '2026',
  },
];

async function main() {
  const owner = process.argv[2]
    || db.prepare('SELECT email FROM app_users ORDER BY id LIMIT 1').get()?.email;
  if (!owner) {
    console.error('Kein Benutzer in der Datenbank. Aufruf: node scripts/seed-journalismus.js <email>');
    process.exit(1);
  }

  const existing = db.prepare('SELECT book_id FROM books WHERE name = ?').get(BOOK_NAME);
  if (existing) {
    console.error(`«${BOOK_NAME}» existiert bereits (book_id=${existing.book_id}). Erst löschen, dann erneut seeden.`);
    process.exit(1);
  }

  const book = await contentStore.createBook({
    name: BOOK_NAME,
    description: 'Beispiel-Ressort: sechs Beiträge in fünf Textsorten, jeder mit einem anderen handwerklichen Mangel.',
    owner_email: owner,
  }, null);
  const bookId = book.id;

  // Buchtyp + vorherrschende Textsorte. Der Buchtyp schaltet das
  // journalistische Lektorat-Profil frei und blendet die Buchwelt-Karten aus.
  db.prepare(`
    INSERT INTO book_settings (book_id, language, region, buchtyp, updated_at)
    VALUES (?, 'de', 'CH', 'journalismus', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(book_id) DO UPDATE SET buchtyp = 'journalismus'
  `).run(bookId);
  setBookTextsorte(bookId, 'bericht');

  let seiten = 0;
  for (const rubrik of RUBRIKEN) {
    const chapter = await contentStore.createChapter({ book_id: bookId, name: rubrik.name }, null);
    for (const b of rubrik.beitraege) {
      const page = await contentStore.createPage({
        book_id: bookId,
        chapter_id: chapter.id,
        name: b.name,
        html: P(...b.blocks),
      }, null);
      // Seiten-Override nur, wo er vom Buch-Default abweicht — sonst zeigt die
      // Karte einen Override, der nichts überschreibt.
      if (b.textsorte !== 'bericht') setPageTextsorte(page.id, bookId, b.textsorte);
      seiten++;
    }
  }

  for (const o of OTOENE) {
    const src = sources.createSource(owner, o);
    sources.linkSource(bookId, src.id, owner);
  }

  console.log(`✓ «${BOOK_NAME}» angelegt (book_id=${bookId}, Besitzer ${owner})`);
  console.log(`  ${RUBRIKEN.length} Rubriken, ${seiten} Beiträge, ${OTOENE.length} O-Töne`);
  console.log('  Buchtyp journalismus · Buch-Textsorte «Bericht» · Overrides je Beitrag');
  console.log('\nNächster Schritt in der App: Buch wählen → Karte «Struktur» → «Alle prüfen».');
}

main().catch(e => {
  console.error('Seed fehlgeschlagen:', e.message);
  console.error(e.stack);
  process.exit(1);
});
