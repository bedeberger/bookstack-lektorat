// Setting-Field (selbst-rendernd) — eine Primitive für ein einzelnes Admin-
// Settings-Feld. Ersetzt das über die Settings-Tabs verstreute, immer gleiche
// `<label><span x-text=…label><input …><small …help></label>`-Boilerplate
// (plus die Masked-Secret-, numInput-, combobox- und Toggle-Varianten) durch
// ein Config-Objekt. `init()` rendert die komplette `<label>`-Struktur selbst
// und ruft `Alpine.initTree` — analog combobox / num-input / toggle-switch.
//
// Bindet an die `adminSettingsCard`-Form über die Alpine-Scope-Kette: der
// gerenderte `x-model="adminSettingsForm['<k>']"` löst über die Ancestor-Scopes
// auf die Karte auf (settingField selbst deklariert `adminSettingsForm` nicht).
// Wrapper-Div leer lassen, nur Attribute setzen.
//
// Verwendung:
//
//   <!-- i18n-Konvention (Label/Placeholder/Help via `.label`/`.placeholder`/`.help`) -->
//   <div x-data="settingField({ k: 'image.host', type: 'url', base: 'image.host', help: true })"></div>
//
//   <!-- Roh-Key als Label (keine i18n) + expliziter Help-Key -->
//   <div x-data="settingField({ k: 'app.timezone', help: 'admin.settings.help.appTimezone' })"></div>
//
//   <!-- Zahl / Auswahl / Boolean -->
//   <div x-data="settingField({ k: 'cron.stale_days', type: 'num', num: { step: 1, min: 1, max: 365 } })"></div>
//   <div x-data="settingField({ k: 'pdfa.flavour', type: 'select', opts: [{ value:'2b', label:'2b' }, { value:'3b', label:'3b' }] })"></div>
//   <div x-data="settingField({ k: 'tts.enabled', type: 'toggle', base: 'tts.enabled' })"></div>
//
//   <!-- Modell-Feld: Freitext + Combobox mit der Modell-Liste des Hosts -->
//   <div x-data="settingField({ k: 'embed.model', base: 'embed.model', help: true, models: { target: 'embed', hostKey: 'embed.host' } })"></div>
//
// Config-Optionen:
//   k       (Pflicht) Setting-Key → Form/Map-Bindung.
//   type    'text' (Default) | 'url' | 'email' | 'password' | 'num' | 'select' | 'toggle'
//   base    i18n-Basis unter `admin.settings.` → Label `.label`, Placeholder
//           `.placeholder` (nur Text-Typen), Help `.help` (nur bei `help: true`).
//   label   Voller i18n-Key fürs Label (übersteuert `base`/Roh-Key).
//   ph      Literal-Placeholder-String (z. B. 'https://app.example.com').
//   phKey   Voller i18n-Key fürs Placeholder (übersteuert `base`.placeholder).
//   help    true → `admin.settings.<base>.help`; String → voller i18n-Key; sonst kein Help.
//   secret  true → Masked-Placeholder + Masked-Hint (bei type 'password' implizit).
//   num     numInput-Config (type 'num').
//   opts    combobox-Options `[{ value, label }]` (type 'select').
//   models  Modell-Picker: Target-String (`'claude'`) oder `{ target, hostKey }`.
//           `hostKey` ist der Form-Key des zugehoerigen Hosts — damit fragt der
//           Picker den gerade eingetippten, noch nicht gespeicherten Host ab.
//           Das Textfeld bleibt die Wahrheit; die Combobox schreibt nur hinein
//           (Modelle, die der Host nicht meldet, bleiben tippbar).

import { tRaw } from './i18n.js';

// Prozessweiter Cache der geladenen Listen (Target → [{ id, label }]). Mehrere
// Felder teilen sich dasselbe Target (vier Claude-Modellfelder) — sie sollen
// den Host nicht je einzeln abfragen. Zusaetzlich meldet ein Window-Event die
// frische Liste an bereits gemountete Geschwister-Felder.
const _modelCache = new Map();
const MODELS_EVENT = 'admin-settings:models-loaded';

export function settingFieldData(cfg = {}) {
  const type = cfg.type || 'text';
  const models = typeof cfg.models === 'string' ? { target: cfg.models } : (cfg.models || null);
  return {
    _k: cfg.k,
    _type: type,
    _secret: type === 'password' || !!cfg.secret,
    _base: cfg.base || null,
    _labelKey: cfg.label || null,
    _ph: cfg.ph ?? null,
    _phKey: cfg.phKey || null,
    _help: cfg.help ?? null,
    _num: cfg.num || null,
    _opts: cfg.opts || null,

    // ── Modell-Picker (cfg.models) ────────────────────────────────────────
    _modelsTarget: models?.target || null,
    _modelsHostKey: models?.hostKey || null,
    _models: [],
    _modelsLoading: false,
    _modelsLoaded: false,
    _modelsErr: '',
    _modelPick: null,   // transiente Combobox-Bindung (Auswahl → Textfeld)
    _liveHost: '',      // via x-effect aus adminSettingsForm[hostKey] gespiegelt
    _abortCtrl: null,

    // Touch die reaktive Locale, damit Alpine bei Sprachwechsel re-evaluiert;
    // fällt via tRaw auf die globale _locale zurück, wenn kein Store da ist.
    _t(key, params) { void window.Alpine?.store('shell')?.uiLocale; return tRaw(key, params); },

    get labelText() {
      if (this._labelKey) return this._t(this._labelKey);
      if (this._base) return this._t(`admin.settings.${this._base}.label`);
      return this._k;
    },
    get placeholderText() {
      if (this._secret) return this._t('admin.settings.secret.masked');
      if (this._ph != null) return this._ph;
      if (this._phKey) return this._t(this._phKey);
      if (this._base) return this._t(`admin.settings.${this._base}.placeholder`);
      return '';
    },
    get helpText() {
      if (this._help === true && this._base) return this._t(`admin.settings.${this._base}.help`);
      if (typeof this._help === 'string') return this._t(this._help);
      return '';
    },

    get modelOptions() {
      return this._models.map(m => ({ value: m.id, label: m.label || m.id }));
    },
    get modelPickLabel() { return this._t('admin.settings.models.pick'); },
    get modelReloadLabel() { return this._t('admin.settings.models.reload'); },
    get modelLoadLabel() {
      return this._t(this._modelsLoading ? 'admin.settings.models.loading' : 'admin.settings.models.load');
    },

    _applyModels(list, { fresh = false } = {}) {
      this._models = list;
      this._modelsLoaded = list.length > 0;
      if (fresh && !list.length) this._modelsErr = this._t('admin.settings.models.empty');
    },

    // Holt die Modell-Liste des Hosts. `force` umgeht den geteilten Cache
    // (Combobox-Footer „Liste neu laden" — nach einem Host-Wechsel oder einem
    // frisch gezogenen Modell).
    async loadModels(force = false) {
      const target = this._modelsTarget;
      if (!target || this._modelsLoading) return;
      if (!force && _modelCache.has(target)) { this._applyModels(_modelCache.get(target)); return; }
      this._modelsLoading = true;
      this._modelsErr = '';
      try {
        const r = await fetch('/admin/settings/models', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ target, host: this._liveHost || '' }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) {
          this._modelsErr = this._t('admin.settings.models.error', { err: j.error_code || `HTTP ${r.status}` });
          return;
        }
        const list = Array.isArray(j.models) ? j.models : [];
        _modelCache.set(target, list);
        this._applyModels(list, { fresh: true });
        // Geschwister-Felder desselben Targets mitziehen (4x Claude-Modell).
        window.dispatchEvent(new CustomEvent(MODELS_EVENT, { detail: { target, models: list } }));
      } catch (e) {
        this._modelsErr = this._t('admin.settings.models.error', { err: e.message });
      } finally {
        this._modelsLoading = false;
      }
    },

    init() {
      this.$el.classList.add('setting-field');
      this.$el.innerHTML = this._render();
      // Frisch gesetztes Markup explizit initialisieren (nested numInput/
      // combobox/toggle + eigene x-model-Bindungen), analog combobox/toggle.
      window.Alpine.initTree(this.$el);
      if (this._modelsTarget) {
        if (_modelCache.has(this._modelsTarget)) this._applyModels(_modelCache.get(this._modelsTarget));
        this._abortCtrl = new AbortController();
        window.addEventListener(MODELS_EVENT, (e) => {
          if (e.detail?.target === this._modelsTarget) this._applyModels(e.detail.models || []);
        }, { signal: this._abortCtrl.signal });
      }
    },

    destroy() {
      this._abortCtrl?.abort();
      this._abortCtrl = null;
    },

    _help_small() {
      return '<small x-show="helpText" class="muted-msg muted-msg--sm" x-text="helpText"></small>';
    },

    // Technischer Config-Key als sekundärer Marker neben dem übersetzten Label.
    // `_k` ist ein konstanter Setting-Key (`[a-z0-9._-]`), kein User-Input.
    _keyMarker() {
      return `<code class="setting-field__key">${this._k}</code>`;
    },

    _render() {
      const k = this._k;
      const mkey = `adminSettingsForm['${k}']`;
      const help = this._help_small();

      if (this._type === 'toggle') {
        // toggleSwitch rendert das Label rechts vom Switch; Key-Marker daneben,
        // Help darunter.
        return [
          '<div class="setting-field__toggle-row">',
          `  <div x-data="toggleSwitch({ label: () => labelText })" x-modelable="value" x-model="${mkey}"></div>`,
          `  ${this._keyMarker()}`,
          '</div>',
          help,
        ].join('\n');
      }

      let control;
      if (this._type === 'num') {
        // Einfach-gequotetes Attribut → JSON (Doppel-Quotes) darin gültig.
        const numJson = JSON.stringify(this._num || {});
        control = `<input type="text" x-data='numInput(${numJson})' x-modelable="value" x-model="${mkey}">`;
      } else if (this._type === 'select') {
        const optsJson = JSON.stringify(this._opts || []);
        control = [
          `<div x-data="combobox({ placeholder: labelText, compact: false })"`,
          `     x-modelable="value" x-model="${mkey}"`,
          `     x-effect='options = ${optsJson}'></div>`,
        ].join('\n');
      } else {
        // text | url | email | password
        control = `<input type="${this._type}" x-model="${mkey}" :placeholder="placeholderText" autocomplete="off">`;
      }

      // Modell-Picker: Textfeld bleibt die Wahrheit, die Combobox schreibt nur
      // hinein (`transient` → sie behaelt keinen eigenen Wert). Die Liste wird
      // erst auf Klick geholt: ein Settings-Tab-Aufruf soll nicht acht fremde
      // Hosts anpingen. Host-Spiegel via x-effect, weil der Form-Scope nur
      // ueber die Alpine-Scope-Kette (Template) zuverlaessig erreichbar ist.
      if (this._modelsTarget) {
        const hostMirror = this._modelsHostKey
          ? ` x-effect="_liveHost = adminSettingsForm['${this._modelsHostKey}'] ?? ''"`
          : '';
        control = [
          `<div class="setting-field__model-row"${hostMirror}>`,
          `  ${control}`,
          '  <button type="button" class="setting-field__model-btn" x-show="!_modelsLoaded"',
          '          :disabled="_modelsLoading" @click="loadModels()" x-text="modelLoadLabel"></button>',
          '  <div class="setting-field__model-pick" x-show="_modelsLoaded" x-cloak',
          '       x-data="combobox({ placeholder: () => modelPickLabel, transient: true,',
          '                          footer: { label: () => modelReloadLabel, action: () => loadModels(true) } })"',
          '       x-modelable="value" x-model="_modelPick"',
          '       x-effect="options = modelOptions"',
          `       @combobox-change="${mkey} = $event.detail"></div>`,
          '</div>',
          '<small x-show="_modelsErr" x-cloak class="muted-msg muted-msg--sm" x-text="_modelsErr"></small>',
        ].join('\n');
      }

      const maskedSmall = this._secret
        ? `<small x-show="adminSettingsMap['${k}']?.masked" class="muted-msg muted-msg--sm" x-text="adminSettingsMap['${k}']?.masked"></small>`
        : '';

      return [
        '<label>',
        '  <span class="setting-field__labelrow">',
        '    <span class="setting-field__label" x-text="labelText"></span>',
        `    ${this._keyMarker()}`,
        '  </span>',
        `  ${control}`,
        maskedSmall,
        help,
        '</label>',
      ].filter(Boolean).join('\n');
    },
  };
}

export function registerSettingField() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('settingField', (cfg = {}) => settingFieldData(cfg));
}
