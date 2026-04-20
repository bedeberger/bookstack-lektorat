// App-Chrome: Theme-Umschaltung + BookStack-Token-Setup.
// Beides sind UI-Bereiche, die ausserhalb der normalen Buch-/Seiten-Flows
// leben und keine Querabhängigkeiten zu Job-Queue oder Hash-Router haben.
export const appChromeMethods = {
  // ── Theme (Hell/Dunkel/Auto) ─────────────────────────────────────────────
  _applyTheme() {
    const resolved = this.themePref === 'auto'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : this.themePref;
    document.documentElement.setAttribute('data-theme', resolved);
  },
  cycleTheme() {
    const order = ['auto', 'light', 'dark'];
    this.themePref = order[(order.indexOf(this.themePref) + 1) % order.length];
    try { localStorage.setItem('theme', this.themePref); } catch (e) {}
    this._applyTheme();
    fetch('/me/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: this.themePref }),
    }).catch(e => console.error('[theme] Persist fehlgeschlagen:', e));
  },
  _themeLabel() {
    return this.t({ auto: 'theme.auto', light: 'theme.light', dark: 'theme.dark' }[this.themePref] || 'theme.auto');
  },

  // ── BookStack Token Setup ────────────────────────────────────────────────
  async saveBookstackToken() {
    this.tokenSetupError = '';
    if (!this.tokenSetupId.trim() || !this.tokenSetupPw.trim()) {
      this.tokenSetupError = this.t('app.tokenRequired');
      return;
    }
    this.tokenSetupLoading = true;
    try {
      const r = await fetch('/auth/token', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tokenId: this.tokenSetupId.trim(), tokenPw: this.tokenSetupPw.trim() }),
      });
      if (!r.ok) throw new Error(this.tError(await r.json()));
      this.showTokenSetup = false;
      this.tokenSetupCanCancel = false;
      this.tokenSetupId = '';
      this.tokenSetupPw = '';
      this.bookstackTokenInvalid = false;
      window.__bookstackUnauthedNotified = false;
      await this.loadBooks();
    } catch (e) {
      this.tokenSetupError = e.message;
    } finally {
      this.tokenSetupLoading = false;
    }
  },

  openTokenChange() {
    this.tokenSetupId = '';
    this.tokenSetupPw = '';
    this.tokenSetupError = '';
    this.tokenSetupCanCancel = true;
    this.showUserSettingsCard = false;
    this.showTokenSetup = true;
  },

  cancelTokenSetup() {
    this.showTokenSetup = false;
    this.tokenSetupCanCancel = false;
    this.tokenSetupId = '';
    this.tokenSetupPw = '';
    this.tokenSetupError = '';
  },
};
