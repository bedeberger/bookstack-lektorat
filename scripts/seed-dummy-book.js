#!/usr/bin/env node
// Lädt das Dummy-Testbuch (tests/fixtures/dummy-book.md) per BookStack-API in die
// konfigurierte Instanz hoch. Legt 1 Buch, 4 Kapitel, 8 Seiten an.
//
// Voraussetzung: .env mit API_HOST, TOKEN_ID, TOKEN_KENNWORT (gleiche Variablen
// wie die App selbst). Das Script bricht ab, wenn ein Buch mit dem gleichen
// Namen bereits existiert – sonst entstehen Duplikate.
//
// Aufruf: node scripts/seed-dummy-book.js

'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const API_HOST = (process.env.API_HOST || '').replace(/\/$/, '');
const TOKEN_ID = process.env.TOKEN_ID;
const TOKEN_SECRET = process.env.TOKEN_KENNWORT;

if (!API_HOST || !TOKEN_ID || !TOKEN_SECRET) {
  console.error('FEHLER: API_HOST, TOKEN_ID und TOKEN_KENNWORT müssen in .env gesetzt sein.');
  process.exit(1);
}

const FIXTURE = path.join(__dirname, '..', 'tests', 'fixtures', 'dummy-book.md');
const BOOK_NAME = 'Der Nebel über Luzern';
const BOOK_DESCRIPTION = 'Dummy-Krimi zum Testen des bookstack-lektorat-Tools. Enthält absichtliche Fehler und Kontinuitätsbrüche.';

const headers = {
  'Authorization': `Token ${TOKEN_ID}:${TOKEN_SECRET}`,
  'Content-Type': 'application/json'
};

async function api(method, pathSuffix, body) {
  const res = await fetch(`${API_HOST}/api${pathSuffix}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${pathSuffix} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

function parseFixture(md) {
  const cut = md.indexOf('# Fehler-Checkliste');
  const body = cut > 0 ? md.slice(0, cut) : md;

  const chapters = [];
  let currentChapter = null;
  let currentPage = null;
  let buffer = [];

  const flushPage = () => {
    if (currentPage && currentChapter) {
      currentPage.markdown = buffer.join('\n').trim();
      currentChapter.pages.push(currentPage);
    }
    currentPage = null;
    buffer = [];
  };

  for (const line of body.split('\n')) {
    const chapMatch = line.match(/^# Kapitel \d+ — (.+)$/);
    const pageMatch = line.match(/^## Seite [\d.]+:\s*(.+)$/);

    if (chapMatch) {
      flushPage();
      currentChapter = { title: `Kapitel ${chapters.length + 1} — ${chapMatch[1].trim()}`, pages: [] };
      chapters.push(currentChapter);
      continue;
    }
    if (pageMatch) {
      flushPage();
      currentPage = { title: pageMatch[1].trim() };
      continue;
    }
    if (currentPage) {
      if (line.trim() === '---') continue;
      buffer.push(line);
    }
  }
  flushPage();
  return chapters;
}

async function bookExists(name) {
  const q = encodeURIComponent(`"${name}" {type:book}`);
  const res = await api('GET', `/search?query=${q}&count=10`);
  return (res.data || []).some(r => r.type === 'book' && r.name === name);
}

(async () => {
  const md = fs.readFileSync(FIXTURE, 'utf8');
  const chapters = parseFixture(md);

  console.log(`Fixture: ${chapters.length} Kapitel, ${chapters.reduce((s, c) => s + c.pages.length, 0)} Seiten`);

  if (await bookExists(BOOK_NAME)) {
    console.error(`\nAbbruch: Buch "${BOOK_NAME}" existiert bereits in ${API_HOST}.`);
    console.error('Lösche es manuell oder gib einen anderen Namen.');
    process.exit(2);
  }

  console.log(`\nLege Buch an auf ${API_HOST} ...`);
  const book = await api('POST', '/books', {
    name: BOOK_NAME,
    description: BOOK_DESCRIPTION,
    tags: [
      { name: 'status', value: 'dummy' },
      { name: 'zweck', value: 'lektorat-test' }
    ]
  });
  console.log(`  Buch: id=${book.id}, slug=${book.slug}`);

  for (const chap of chapters) {
    const chapter = await api('POST', '/chapters', {
      book_id: book.id,
      name: chap.title,
      description: ''
    });
    console.log(`  Kapitel: ${chap.title} (id=${chapter.id})`);

    for (const page of chap.pages) {
      const p = await api('POST', '/pages', {
        chapter_id: chapter.id,
        name: page.title,
        markdown: page.markdown
      });
      console.log(`    Seite: ${page.title} (id=${p.id})`);
    }
  }

  console.log(`\nFertig. Buch-URL: ${API_HOST}/books/${book.slug}`);
  console.log('Nächste Schritte in der Lektorat-App: Bucheinstellungen setzen (Krimi, de-CH, Freikontext) und Sync starten.');
})().catch(err => {
  console.error('\nSEED FEHLGESCHLAGEN:', err.message);
  process.exit(1);
});
