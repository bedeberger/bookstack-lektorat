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
  setTheme(pref) {
    if (pref !== 'auto' && pref !== 'light' && pref !== 'dark') return;
    if (this.themePref === pref) return;
    this.themePref = pref;
    try { localStorage.setItem('theme', this.themePref); } catch (e) {}
    this._applyTheme();
    fetch('/me/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: this.themePref }),
    }).catch(e => console.error('[theme] Persist fehlgeschlagen:', e));
  },
  _avatarInitials() {
    const src = (this.currentUser && (this.currentUser.name || this.currentUser.email)) || '';
    if (!src) return '·';
    const parts = src.split('@')[0].split(/[\s._-]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return (parts[0] || src).slice(0, 2).toUpperCase();
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
