// URL-Hash-Permalinks + History-Management.
// Schema: #profil | #book/:bookId[/page/:pageId|/figur/:figId|/ort/:ortId|/kapitel[/:chapterId]|/<view>]
// Views: figuren, orte, szenen, ereignisse, kontinuitaet, bewertung, kapitel, chat, stats, stil, fehler, einstellungen
//
// Entwurfsentscheidungen:
// - push vs. replace entscheidet `_hashCategory`: gleiche Kategorie → replace
//   (z.B. Figur↔Figur), Wechsel → push. `figur`/`figuren`, `ort`/`orte` gelten
//   als dieselbe Kategorie.
// - `_updateHash` bündelt mehrere synchrone Alpine-Watcher-Feuer per Microtask
//   zu EINEM History-Eintrag.
// - `_applyHash` setzt `_inHashApply` + `_applyingHash`, damit während der
//   Anwendung getriggerte Watcher keinen Rück-Schreibzyklus starten.
export const appHashRouterMethods = {
  _computeHash() {
    if (this.showUserSettingsCard) return '#profil';
    if (!this.selectedBookId) return '';
    const parts = ['book', this.selectedBookId];
    if (this.showEditorCard && this.currentPage?.id) {
      parts.push('page', String(this.currentPage.id));
    } else if (this.showFiguresCard && this.selectedFigurId) {
      parts.push('figur', String(this.selectedFigurId));
    } else if (this.showOrteCard && this.selectedOrtId) {
      parts.push('ort', String(this.selectedOrtId));
    } else if (this.showKapitelReviewCard && this.kapitelReviewChapterId) {
      parts.push('kapitel', String(this.kapitelReviewChapterId));
    } else if (this.showFiguresCard) parts.push('figuren');
    else if (this.showOrteCard) parts.push('orte');
    else if (this.showSzenenCard) parts.push('szenen');
    else if (this.showEreignisseCard) parts.push('ereignisse');
    else if (this.showKontinuitaetCard) parts.push('kontinuitaet');
    else if (this.showBookReviewCard) parts.push('bewertung');
    else if (this.showKapitelReviewCard) parts.push('kapitel');
    else if (this.showBookChatCard) parts.push('chat');
    else if (this.showBookStatsCard) parts.push('stats');
    else if (this.showStilCard) parts.push('stil');
    else if (this.showFehlerHeatmapCard) parts.push('fehler');
    else if (this.showBookSettingsCard) parts.push('einstellungen');
    return '#' + parts.join('/');
  },

  _hashCategory(hash) {
    if (!hash) return null;
    const parts = hash.replace(/^#/, '').split('/').filter(Boolean);
    if (parts[0] === 'profil') return 'profil';
    if (parts[0] !== 'book' || !parts[1]) return null;
    const bookId = parts[1];
    const view = parts[2] || 'book';
    const kind = view === 'figur' ? 'figuren' : view === 'ort' ? 'orte' : view;
    return bookId + ':' + kind;
  },

  _writeHash(newHash) {
    const cleanUrl = location.pathname + location.search;
    const firstWrite = !this._hashInitialized;
    this._hashInitialized = true;
    if (!newHash) {
      if (location.hash) history.replaceState(null, '', cleanUrl);
      return;
    }
    if (location.hash === newHash) return;
    if (firstWrite) { history.replaceState(null, '', newHash); return; }
    const oldCat = this._hashCategory(location.hash);
    const newCat = this._hashCategory(newHash);
    if (oldCat && oldCat === newCat) {
      history.replaceState(null, '', newHash);
    } else {
      history.pushState(null, '', newHash);
    }
  },

  // Synchroner URL-Sync ohne neuen History-Eintrag (initial + nach Hash-Apply).
  _syncUrlNow() {
    const newHash = this._computeHash();
    const cleanUrl = location.pathname + location.search;
    if (!newHash) {
      if (location.hash) history.replaceState(null, '', cleanUrl);
    } else if (location.hash !== newHash) {
      history.replaceState(null, '', newHash);
    }
    this._hashInitialized = true;
  },

  // Mehrere synchrone State-Änderungen werden per Microtask zu einem
  // einzigen URL-Update zusammengefasst.
  _updateHash() {
    if (this._applyingHash) return;
    if (this._hashUpdatePending) return;
    this._hashUpdatePending = true;
    queueMicrotask(() => {
      this._hashUpdatePending = false;
      if (this._applyingHash) return;
      this._writeHash(this._computeHash());
    });
  },

  async _applyHash() {
    const hash = (location.hash || '').replace(/^#/, '');
    if (!hash) return;
    const parts = hash.split('/').filter(Boolean);

    if (parts[0] === 'profil') {
      this._applyingHash = true;
      this._inHashApply = true;
      try {
        if (!this.showUserSettingsCard) await this.toggleUserSettingsCard();
      } finally {
        this._applyingHash = false;
        this._inHashApply = false;
      }
      return;
    }

    if (parts[0] !== 'book' || !parts[1]) return;
    const targetBookId = parts[1];
    if (!this.books.some(b => String(b.id) === targetBookId)) return;

    this._applyingHash = true;
    this._inHashApply = true;
    try {
      if (String(this.selectedBookId) !== targetBookId) {
        this.selectedBookId = targetBookId;
        this._resetBookScopedState();
        await this.loadPages();
      }

      const view = parts[2];
      const arg = parts[3];
      if (!view) {
        this._closeOtherMainCards('none');
        return;
      }

      switch (view) {
        case 'page':
          if (arg) {
            const page = this.pages.find(p => String(p.id) === arg);
            if (page) await this.selectPage(page);
          }
          break;
        case 'figur':
          if (arg) await this.openFigurById(arg);
          else {
            this.selectedFigurId = null;
            if (!this.showFiguresCard) await this.toggleFiguresCard();
            else this._closeOtherMainCards('figures');
          }
          break;
        case 'ort':
          if (arg) await this.openOrtById(arg);
          else {
            this.selectedOrtId = null;
            if (!this.showOrteCard) await this.toggleOrteCard();
            else this._closeOtherMainCards('orte');
          }
          break;
        case 'figuren':
          this.selectedFigurId = null;
          if (!this.showFiguresCard) await this.toggleFiguresCard();
          else this._closeOtherMainCards('figures');
          break;
        case 'orte':
          this.selectedOrtId = null;
          if (!this.showOrteCard) await this.toggleOrteCard();
          else this._closeOtherMainCards('orte');
          break;
        case 'szenen':
          if (!this.showSzenenCard) await this.toggleSzenenCard();
          break;
        case 'ereignisse':
          if (!this.showEreignisseCard) await this.toggleEreignisseCard();
          break;
        case 'kontinuitaet':
          if (!this.showKontinuitaetCard) await this.toggleKontinuitaetCard();
          break;
        case 'bewertung':
          if (!this.showBookReviewCard) await this.toggleBookReviewCard();
          break;
        case 'kapitel':
          if (!this.showKapitelReviewCard) await this.toggleKapitelReviewCard();
          if (arg) {
            // Nur übernehmen, wenn es ein qualifizierendes Kapitel ist (>1 Seite).
            const opts = this.kapitelReviewChapterOptions();
            if (opts.some(c => String(c.id) === String(arg))) {
              this.kapitelReviewChapterId = String(arg);
              this.kapitelReviewOut = '';
              this.setKapitelReviewStatus('');
            }
          }
          break;
        case 'chat':
          if (!this.showBookChatCard) await this.toggleBookChatCard();
          break;
        case 'stats':
          if (!this.showBookStatsCard) await this.toggleBookStatsCard();
          break;
        case 'stil':
          if (!this.showStilCard) await this.toggleStilCard();
          break;
        case 'fehler':
          if (!this.showFehlerHeatmapCard) await this.toggleFehlerHeatmapCard();
          break;
        case 'einstellungen':
          if (!this.showBookSettingsCard) await this.toggleBookSettingsCard();
          break;
      }
    } finally {
      this._applyingHash = false;
      this._inHashApply = false;
    }
  },

  _setupHashRouting() {
    const watchers = [
      'selectedBookId', 'currentPage', 'showEditorCard',
      'selectedFigurId', 'selectedOrtId',
      'showFiguresCard', 'showOrteCard', 'showSzenenCard', 'showEreignisseCard',
      'showKontinuitaetCard', 'showBookReviewCard', 'showBookChatCard',
      'showKapitelReviewCard', 'kapitelReviewChapterId',
      'showBookStatsCard', 'showStilCard', 'showFehlerHeatmapCard',
      'showBookSettingsCard', 'showUserSettingsCard',
    ];
    for (const prop of watchers) {
      this.$watch(prop, () => this._updateHash());
    }
    window.addEventListener('hashchange', () => this._applyHash(), { signal: this._abortCtrl?.signal });
  },
};
