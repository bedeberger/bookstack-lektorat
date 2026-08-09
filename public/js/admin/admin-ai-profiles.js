// KI-Profil-Verwaltung (Provider-Tab, Sub-Tab „Profile").
// Wird im adminSettingsCard-Alpine-Scope gespreaded. Root-Zugriffe ueber
// `window.__app`, weil Alpine-Magics in JS-Methoden nicht zuverlaessig sind.
//
// Ein Profil ueberschreibt punktuell die globalen `ai.<provider>.*`-Settings des
// Nachbar-Sub-Tabs; JEDES leer gelassene Feld bleibt global. Darum sind die
// Formularfelder bewusst leer statt mit dem globalen Wert vorbelegt: ein
// vorbelegtes Feld waere beim Speichern eine Kopie, die spaeter nicht mehr
// mitzieht, wenn der Admin die Instanz-Einstellung aendert.

const EMPTY_PROFILE = {
  id: null, name: '', provider: 'openai-compat', model: '', host: '',
  api_key: '', cloud: '', temperature: '', context_window: '',
  max_tokens_out: '', repeat_penalty: '', think: '', max_parallel: '', notes: '',
};

export const adminAiProfilesMethods = {
  adminProfilesNew() {
    return { ...EMPTY_PROFILE };
  },

  async adminProfilesLoad() {
    if (this.adminProfilesLoading) return;
    this.adminProfilesLoading = true;
    this.adminProfilesError = '';
    try {
      const r = await fetch('/admin/ai-profiles', { credentials: 'same-origin' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error_code || `HTTP ${r.status}`);
      this.adminProfilesList = j.profiles || [];
    } catch (e) {
      this.adminProfilesError = e.message;
    } finally {
      this.adminProfilesLoading = false;
    }
  },

  adminProfilesEdit(profile) {
    // `api_key` bleibt leer: der Klartext verlaesst den Server nie. Leer lassen =
    // gespeicherten Key behalten (die Route setzt `__unchanged__`), etwas eintippen
    // = ersetzen.
    this.adminProfilesForm = {
      ...EMPTY_PROFILE,
      ...profile,
      api_key: '',
      temperature: profile.temperature ?? '',
      context_window: profile.context_window ?? '',
      max_tokens_out: profile.max_tokens_out ?? '',
      repeat_penalty: profile.repeat_penalty ?? '',
      max_parallel: profile.max_parallel ?? '',
      // Dreiwertig als STRING, weil die Combobox Strings liefert: '' = global,
      // 'true'/'false' = ausdruecklich gesetzt. Ein Boolean hier wuerde beim
      // Bearbeiten nie auf eine Option matchen und stumm auf „global" zurueckfallen.
      cloud: profile.cloud === null || profile.cloud === undefined ? '' : String(profile.cloud),
      think: profile.think === null || profile.think === undefined ? '' : String(profile.think),
      model: profile.model || '',
      host: profile.host || '',
      notes: profile.notes || '',
    };
    this.adminProfilesEditing = true;
  },

  adminProfilesCreate() {
    this.adminProfilesForm = this.adminProfilesNew();
    this.adminProfilesEditing = true;
  },

  adminProfilesCancel() {
    this.adminProfilesEditing = false;
    this.adminProfilesError = '';
  },

  async adminProfilesSave() {
    const f = this.adminProfilesForm || {};
    this.adminProfilesSaving = true;
    this.adminProfilesError = '';
    try {
      const body = { ...f };
      // Leeres Key-Feld heisst „nicht anfassen" — nur beim Anlegen ist leer auch leer.
      if (f.id && !String(f.api_key || '').trim()) delete body.api_key;
      delete body.id;
      const url = f.id ? `/admin/ai-profiles/${f.id}` : '/admin/ai-profiles';
      const r = await fetch(url, {
        method: f.id ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error_code || `HTTP ${r.status}`);
      this.adminProfilesEditing = false;
      await this.adminProfilesLoad();
    } catch (e) {
      this.adminProfilesError = e.message;
    } finally {
      this.adminProfilesSaving = false;
    }
  },

  async adminProfilesDelete(profile) {
    const t = window.__app?.t;
    // Zugewiesene User werden abgehaengt (FK SET NULL) und folgen danach wieder dem
    // globalen Provider. Das gehoert in die Rueckfrage, nicht in eine Ueberraschung.
    const msg = profile.user_count
      ? t?.('admin.profiles.confirmDeleteUsers', { name: profile.name, n: profile.user_count })
      : t?.('admin.profiles.confirmDelete', { name: profile.name });
    if (!confirm(msg || `${profile.name} löschen?`)) return;
    this.adminProfilesError = '';
    try {
      const r = await fetch(`/admin/ai-profiles/${profile.id}`, {
        method: 'DELETE', credentials: 'same-origin',
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error_code || `HTTP ${r.status}`);
      await this.adminProfilesLoad();
    } catch (e) {
      this.adminProfilesError = e.message;
    }
  },

  // Zeigt an, was ein leeres Feld effektiv bedeutet: den globalen Wert dieses
  // Providers aus dem Nachbar-Sub-Tab (adminSettingsForm ist bereits geladen).
  adminProfilesGlobalHint(key) {
    const p = this.adminProfilesForm?.provider;
    if (!p) return '';
    const v = this.adminSettingsForm?.[`ai.${p}.${key}`];
    if (v === undefined || v === null || v === '') return '';
    return window.__app?.t?.('admin.profiles.inheritsGlobal', { value: String(v) }) || '';
  },
};
