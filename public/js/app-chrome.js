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
  // Logout: SW-Caches dropen, bevor der Browser zum Login redirected. Sonst
  // liefert die SWR-Strategie nach Re-Login kurz noch /api/* + /config des
  // alten Users, bis Eviction greift.
  async logout(ev) {
    const sw = navigator.serviceWorker;
    if (!sw?.controller) return; // kein SW aktiv → normales Anker-Verhalten
    ev.preventDefault();
    const ctrl = sw.controller;
    const done = new Promise(resolve => {
      const onMsg = (e) => {
        if (e.data?.type === 'auth-logout-done') {
          sw.removeEventListener('message', onMsg);
          resolve();
        }
      };
      sw.addEventListener('message', onMsg);
      setTimeout(() => { sw.removeEventListener('message', onMsg); resolve(); }, 1500);
    });
    ctrl.postMessage({ type: 'auth-logout' });
    await done;
    location.href = '/auth/logout';
  },
  // Wartenden SW aktivieren (vom Update-Banner). Nach `skip-waiting` feuert
  // `controllerchange` im app.js-Listener und macht das eigentliche Reload.
  // Fallback-Reload nach 2s falls das Event aus irgendeinem Grund nicht
  // kommt (z.B. SW-Controller fehlt) — dann harten Reload, damit der User
  // nicht im Banner-Limbo hängenbleibt.
  applyUpdate() {
    const w = window.__pendingWorker;
    if (w) {
      try { w.postMessage({ type: 'skip-waiting' }); } catch {}
    }
    setTimeout(() => location.reload(), 2000);
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

  // Custom Confirm-Dialog. Native window.confirm() reisst Chrome auf macOS aus
  // dem nativen Vollbild-Space (zeigt Modal nur ausserhalb des Spaces) — nach
  // dem Klick bleibt das Fenster im Standard-Modus. Bricht u.a. Focus-Mode-
  // Cancel-Flow.
  // Verwendung:
  //   if (!await this.appConfirm({ message, confirmLabel?, cancelLabel?, danger? })) return;
  appConfirm({ message, confirmLabel, cancelLabel, danger = false } = {}) {
    if (this._confirmDialogResolve) {
      try { this._confirmDialogResolve(false); } catch {}
    }
    this.confirmDialogMessage = message || '';
    this.confirmDialogConfirmLabel = confirmLabel || this.t('common.confirm');
    this.confirmDialogCancelLabel = cancelLabel || this.t('common.cancel');
    this.confirmDialogDanger = !!danger;
    this.confirmDialogOpen = true;
    return new Promise(resolve => { this._confirmDialogResolve = resolve; });
  },

  _resolveConfirmDialog(value) {
    const r = this._confirmDialogResolve;
    this._confirmDialogResolve = null;
    this.confirmDialogOpen = false;
    if (r) r(value);
  },
};
