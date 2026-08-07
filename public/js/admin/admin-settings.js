// AdminSettingsCard-Methods.

import { formatNum, localeTagFromUi } from '../num-input.js';

export const adminSettingsMethods = {
  async adminSettingsLoad() {
    if (this.adminSettingsLoading) return;
    this.adminSettingsLoading = true;
    this.adminSettingsError = '';
    try {
      const r = await fetch('/admin/settings', { credentials: 'same-origin' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const map = {};
      for (const s of data.settings) {
        map[s.key] = s;
      }
      this.adminSettingsMap = map;
      // Form-State aus map kopieren — Form-Inputs schreiben in form, Save
      // diff't vs. map und sendet nur geaenderte Keys ans Backend.
      this.adminSettingsForm = this._adminSettingsBuildForm(map);
      const cur = this.adminSettingsForm['ai.provider'];
      if (cur === 'claude' || cur === 'ollama' || cur === 'openai-compat') {
        this.adminSettingsProviderSubtab = cur;
      }
    } catch (e) {
      this.adminSettingsError = e.message;
    } finally {
      this.adminSettingsLoading = false;
    }
  },

  _adminSettingsBuildForm(map) {
    const form = {};
    for (const key of Object.keys(map)) {
      const s = map[key];
      // Encrypted: leerer String, dann user kann ueberschreiben; sonst
      // Sentinel __unchanged__ beim Save.
      form[key] = s.encrypted ? '' : (s.value ?? '');
    }
    return form;
  },

  _adminSettingsCoerceValue(key, raw) {
    const s = this.adminSettingsMap[key];
    if (!s) return raw;
    if (s.encrypted) {
      // Leerer Input → __unchanged__-Sentinel; sonst Klartext-Wert
      return raw === '' ? '__unchanged__' : raw;
    }
    const def = s.value;
    if (typeof def === 'boolean') return raw === 'true' || raw === true;
    if (typeof def === 'number') {
      const n = Number(raw);
      return Number.isFinite(n) ? n : def;
    }
    return raw;
  },

  async adminSettingsSave() {
    if (this.adminSettingsSaving) return;
    this.adminSettingsSaving = true;
    this.adminSettingsError = '';
    this.adminSettingsSaved = false;
    const dirty = [];
    for (const key of Object.keys(this.adminSettingsForm)) {
      const s = this.adminSettingsMap[key];
      if (!s) continue;
      const raw = this.adminSettingsForm[key];
      const coerced = this._adminSettingsCoerceValue(key, raw);
      if (s.encrypted) {
        if (coerced !== '__unchanged__') dirty.push({ key, value: coerced });
      } else {
        if (JSON.stringify(coerced) !== JSON.stringify(s.value)) dirty.push({ key, value: coerced });
      }
    }
    try {
      for (const d of dirty) {
        const r = await fetch(`/admin/settings/${encodeURIComponent(d.key)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ value: d.value }),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(`${d.key}: ${j.error_code || r.status}`);
        }
      }
      this.adminSettingsSavedCount = dirty.length;
      this.adminSettingsSaved = true;
      setTimeout(() => { this.adminSettingsSaved = false; }, 2500);
      await this.adminSettingsLoad();
    } catch (e) {
      this.adminSettingsError = e.message;
    } finally {
      this.adminSettingsSaving = false;
    }
  },

  async adminSettingsTest(kind) {
    const path = kind === 'provider'     ? '/admin/settings/test-provider'
               : kind === 'oauth'        ? '/admin/settings/test-oauth'
               : kind === 'smtp'         ? '/admin/settings/smtp/test-send'
               : kind === 'languagetool' ? '/admin/settings/test-languagetool'
               : kind === 'stt'          ? '/admin/settings/test-stt'
               : kind === 'tts'          ? '/admin/settings/test-tts'
               : kind === 'image'        ? '/admin/settings/test-image'
               : kind === 'embed'        ? '/admin/settings/test-embed'
               : kind === 'rerank'       ? '/admin/settings/test-rerank'
               : kind === 'geocode'      ? '/admin/settings/test-geocode'
               : kind === 'tiles'        ? '/admin/settings/test-tiles'
               : null;
    if (!path) return;
    this.adminSettingsTestResult = { kind, running: true };
    try {
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: kind === 'smtp' ? JSON.stringify({}) : undefined,
      });
      const j = await r.json();
      this.adminSettingsTestResult = { kind, ...j, running: false };
    } catch (e) {
      this.adminSettingsTestResult = { kind, ok: false, error: e.message, running: false };
    }
  },

  adminSettingsSwitchTab(tab) {
    this.adminSettingsTab = tab;
    if (tab === 'api' && !this.adminApiTokensLoaded) {
      this.adminApiTokensLoad();
    }
  },

  // ── API-Tokens (Tab `api`) ──────────────────────────────────────────────
  // Plain-Token wird vom Server NUR einmal nach POST zurueckgegeben und im
  // Frontend in `adminApiTokensJustCreated` zwischengespeichert, bis der
  // User ihn ueber „Verbergen" wegklickt. DB speichert nur den SHA-256-Hash.

  async adminApiTokensLoad() {
    if (this.adminApiTokensLoading) return;
    this.adminApiTokensLoading = true;
    this.adminApiTokensError = '';
    try {
      const r = await fetch('/admin/api-tokens', { credentials: 'same-origin' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      this.adminApiTokensList = Array.isArray(data.tokens) ? data.tokens : [];
      this.adminApiTokensLoaded = true;
    } catch (e) {
      this.adminApiTokensError = e.message;
    } finally {
      this.adminApiTokensLoading = false;
    }
  },

  async adminApiTokensCreate() {
    const name = (this.adminApiTokensNewName || '').trim();
    if (!name) {
      this.adminApiTokensError = window.__app.t('admin.settings.api.errorNameRequired');
      return;
    }
    this.adminApiTokensCreating = true;
    this.adminApiTokensError = '';
    try {
      const body = { display_name: name };
      if (this.adminApiTokensNewExpiresAt) body.expires_at = this.adminApiTokensNewExpiresAt;
      const r = await fetch('/admin/api-tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error_code || `HTTP ${r.status}`);
      this.adminApiTokensJustCreated = j;
      this.adminApiTokensNewName = '';
      this.adminApiTokensNewExpiresAt = '';
      await this.adminApiTokensLoad();
    } catch (e) {
      this.adminApiTokensError = e.message;
    } finally {
      this.adminApiTokensCreating = false;
    }
  },

  async adminApiTokensRevoke(id) {
    if (!confirm(window.__app.t('admin.settings.api.confirmRevoke'))) return;
    try {
      const r = await fetch(`/admin/api-tokens/${id}/revoke`, {
        method: 'POST', credentials: 'same-origin',
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error_code || `HTTP ${r.status}`);
      }
      await this.adminApiTokensLoad();
    } catch (e) {
      this.adminApiTokensError = e.message;
    }
  },

  async adminApiTokensDelete(id) {
    if (!confirm(window.__app.t('admin.settings.api.confirmDelete'))) return;
    try {
      const r = await fetch(`/admin/api-tokens/${id}`, {
        method: 'DELETE', credentials: 'same-origin',
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error_code || `HTTP ${r.status}`);
      }
      await this.adminApiTokensLoad();
    } catch (e) {
      this.adminApiTokensError = e.message;
    }
  },

  adminApiTokensDismissPlain() {
    this.adminApiTokensJustCreated = null;
  },

  adminSettingsIsDirty(key) {
    const s = this.adminSettingsMap[key];
    if (!s) return false;
    const raw = this.adminSettingsForm[key];
    const coerced = this._adminSettingsCoerceValue(key, raw);
    if (s.encrypted) return coerced !== '__unchanged__';
    return JSON.stringify(coerced) !== JSON.stringify(s.value);
  },

  // Spiegelt die Budget-Ableitung aus lib/ai.js (getContextConfigFor) +
  // routes/jobs/shared/loader.js (chunkLimitsFor) im Frontend, damit der Admin
  // schon beim Tippen sieht, wie das Kontextfenster die Komplettanalyse-Pässe
  // skaliert. Reiner Schätzwert (charsPerToken provider-typisch) — die echte
  // Quelle bleibt der Server. Liefert null, wenn context_window noch ungültig.
  adminSettingsBudget(provider) {
    const p = (provider === 'claude' || provider === 'ollama' || provider === 'openai-compat') ? provider : 'claude';
    const ctx = Number(this.adminSettingsForm[`ai.${p}.context_window`]);
    if (!Number.isFinite(ctx) || ctx <= 0) return null;
    let out = Number(this.adminSettingsForm[`ai.${p}.max_tokens_out`]);
    if (!Number.isFinite(out) || out <= 0) out = p === 'claude' ? 64000 : 16000;
    const cptRaw = Number(this.adminSettingsForm['ai.chars_per_token']);
    const charsPerToken = Number.isFinite(cptRaw) && cptRaw > 0 ? cptRaw : (p === 'claude' ? 3 : 4);
    // Sicherheitspuffer proportional — spiegelt contextSafetyMargin in lib/ai/config.js.
    const safetyMargin = Math.max(2000, Math.round(ctx * 0.03));
    const inputBudgetTokens = Math.max(2000, ctx - out - safetyMargin);
    const inputBudgetChars = inputBudgetTokens * charsPerToken;
    const singlePass = Math.max(20000, Math.min(2000000, Math.floor(inputBudgetChars * 0.70)));
    const perChunk = Math.max(10000, Math.min(200000, Math.floor(inputBudgetChars * 0.35)));
    const RECOMMENDED = 128000;
    const level = ctx >= RECOMMENDED ? 'ok' : (ctx >= 64000 ? 'warn' : 'bad');
    const tag = localeTagFromUi(Alpine.store('shell').uiLocale);
    const fmt = (n) => formatNum(n, { localeTag: tag, decimals: 0 });
    return {
      level,
      f: {
        ctx: fmt(ctx),
        recommended: fmt(RECOMMENDED),
        budget: fmt(inputBudgetChars),
        single: fmt(singlePass),
        chunk: fmt(perChunk),
      },
    };
  },
};
