// Collaboration-Polling: erkennt Saves anderer User am offenen Buch und
// hinterlaesst Tree-Marker bzw. Toast. Cheap-Pfad ohne SSE/WS — eigener
// 5s-Tick, parallel zum Job-Queue-Poll. Nutzt GET /content/books/:id/changes.
//
// Reaktionen:
//   - Aktuell offene Seite, kein Edit-Mode → silent Refetch + Toast
//   - Aktuell offene Seite + editMode + dirty → kein Refetch, `editConflict`-Banner
//   - Andere Seite des Buchs → page_id in `recentRemoteEdits` (Tree-Badge);
//     bei mehreren in einem Tick: aggregierter Toast
//
// Serverseitig wird nur der Echo DIESES Geraets ausgefiltert (per device_id):
// Edits eines anderen ACL-Users ODER eines eigenen Zweit-Geraets (z.B. nativer
// Mac-Client) kommen als Remote-Change durch, der Save des eigenen Browsers nicht.
//
// Die Change-Row unterscheidet beide Faelle (`is_self` + `device_label`), und
// jede User-sichtbare Meldung (Toast, Tree-Tooltip, Konflikt-Banner) hat eine
// Self-Variante: ein Solo-Autor mit mehreren Geraeten liest „auf <Geraet>
// geaendert", nicht „von anderen Usern geaendert".

import { getDeviceId } from '../device-id.js';

const COLLAB_POLL_MS = 5000;

// Buch-Level-Geraete-Ping: leicht (40s) und laeuft IMMER bei offenem Buch — auch
// fuer Einzel-Owner-Buecher. Dient nur der Multi-Device-Erkennung; der teure
// 5s-Collab-Poll (changes + presence) startet erst, wenn dieser Ping >1 eigenes
// Geraet meldet (oder das Buch ohnehin geteilt ist).
const BOOK_DEVICE_PING_MS = 40000;

export const appCollabMethods = {
  _startCollabPoll(bookId) {
    this._stopCollabPoll();
    if (!bookId) return;
    const id = String(bookId);
    // Leichter Buch-Geraete-Ping laeuft IMMER — er bootstrappt die
    // Multi-Device-Erkennung (eigenes Zweit-Geraet → voller Poll). `_loadBookRole`
    // ruft uns nach dem ACL-Read erneut auf, sobald `bookSharedFlags` gesetzt ist.
    this._startBookDevicePing(id);
    // Geteiltes Buch: voller Poll sofort, ohne auf den Geraete-Ping zu warten.
    if (this.bookSharedFlags[id] === true) this._ensureFullCollabPoll(id);
  },

  _stopCollabPoll() {
    this._stopBookDevicePing();
    this._stopFullCollabPoll();
    // Echtes Teardown (Buchwechsel/Access-Lost): auch den Editor-Heartbeat
    // abraeumen, falls ein Edit offen war.
    this._stopPresenceHeartbeat();
  },

  // Voller 5s-Collab-Poll (changes + page-presence). Startet, sobald eine zweite
  // Partei am Buch ist: anderer ACL-User ODER eigenes Zweit-Geraet. Idempotent.
  _ensureFullCollabPoll(bookId) {
    if (this.$store.collab._collabPollTimer) return;
    if (!bookId || String(bookId) !== String(this.$store.nav.selectedBookId)) return;
    // Erster Tick holt sich den Server-Stempel als Baseline — sonst wuerden
    // historische Edits beim Buchwechsel als „neu" gemeldet.
    this.$store.collab._collabSince = null;
    const tick = () => this._collabPollOnce(bookId);
    tick();
    this.$store.collab._collabPollTimer = setInterval(tick, COLLAB_POLL_MS);
  },

  // Stoppt NUR den Poll + poll-abgeleiteten State. Der Presence-Heartbeat gehoert
  // dem Editor-Lifecycle (enter/exit), nicht dem Poll — sonst verstummt ein solo
  // editierender User, sobald sein Zweit-Geraet das Buch wieder schliesst und
  // koennte ein drittes Geraet nicht mehr erreichen. Echtes Teardown
  // (`_stopCollabPoll`) raeumt den Heartbeat separat ab.
  _stopFullCollabPoll() {
    if (this.$store.collab._collabPollTimer) {
      clearInterval(this.$store.collab._collabPollTimer);
      this.$store.collab._collabPollTimer = null;
    }
    this.$store.collab._collabSince = null;
    this.$store.collab.recentRemoteEdits = new Map();
    this.$store.collab.livePresenceByPage = {};
    this.$store.collab.foreignEditLock = null;
    this._dismissCollabToast();
  },

  // ── Buch-Level-Geraete-Ping (Multi-Device-Erkennung) ────────────────────
  _startBookDevicePing(bookId) {
    this._stopBookDevicePing();
    if (!bookId) return;
    this.$store.collab._bookDevicePingBookId = String(bookId);
    const tick = () => this._sendBookDevicePing(bookId);
    tick();
    this.$store.collab._bookDevicePingTimer = setInterval(tick, BOOK_DEVICE_PING_MS);
  },

  _stopBookDevicePing() {
    if (this.$store.collab._bookDevicePingTimer) {
      clearInterval(this.$store.collab._bookDevicePingTimer);
      this.$store.collab._bookDevicePingTimer = null;
    }
    const bid = this.$store.collab._bookDevicePingBookId;
    this.$store.collab._bookDevicePingBookId = null;
    this.$store.collab._selfPageDeviceCount = 0;
    this.$store.collab._selfBookDeviceCount = 0;
    if (bid) this._sendBookDeviceLeave(bid);
  },

  async _sendBookDevicePing(bookId) {
    if (!bookId || String(bookId) !== String(this.$store.nav.selectedBookId)) return;
    let data;
    try {
      const r = await fetch('/content/books/' + bookId + '/device-ping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: getDeviceId(), page_id: this.currentPage?.id || null }),
      });
      if (r.status === 403) { this._handleBookAccessLost(bookId); return; }
      if (!r.ok) return;
      data = await r.json();
    } catch { return; }
    this.$store.collab._selfPageDeviceCount = Number(data?.self_page_device_count) || 0;
    this.$store.collab._selfBookDeviceCount = Number(data?.self_book_device_count) || 0;
    this._reconcileFullCollabPoll(bookId);
  },

  // Beim Seitenwechsel sofort neu pingen, damit die page-scoped Erkennung nicht
  // bis zum naechsten 40s-Tick wartet. Aufrufer: Seitenwechsel + Edit-Eintritt.
  _pingDevicePresenceNow() {
    const bid = this.$store.collab._bookDevicePingBookId;
    if (bid) this._sendBookDevicePing(bid);
  },

  // Voller Poll an/aus je nach erkannter Zweit-Partei. `bookSharedFlags` deckt
  // andere ACL-User ab (buchweit); `_selfBookDeviceCount` das eigene Multi-Device
  // im GANZEN Buch (z.B. nativer Mac-Client, der eine BELIEBIGE Seite pusht — so
  // landet sein Push auch dann als Tree-Marker, wenn der Browser eine andere Seite
  // offen hat); `_selfPageDeviceCount` deckt zusaetzlich den Seitenkonflikt ab.
  _reconcileFullCollabPoll(bookId) {
    if (!bookId || String(bookId) !== String(this.$store.nav.selectedBookId)) return;
    const id = String(bookId);
    const needFull = this.bookSharedFlags[id] === true
      || this.$store.collab._selfBookDeviceCount > 1
      || (this.currentPage?.id && this.$store.collab._selfPageDeviceCount > 1);
    if (needFull) this._ensureFullCollabPoll(id);
    else this._stopFullCollabPoll();
  },

  _sendBookDeviceLeave(bookId) {
    if (!bookId) return;
    try {
      const did = getDeviceId();
      fetch('/content/books/' + bookId + '/device-ping?device_id=' + encodeURIComponent(did), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: did }),
        keepalive: true,
      }).catch(() => {});
    } catch {}
  },

  // Buch waehrend offener Session geloescht oder Zugriff entzogen: der Poller
  // bekommt 403 NO_BOOK_ACCESS. Ohne Handler tickt der 5s-Poll endlos weiter
  // und spammt Server-Warnungen. Hier hart abbrechen: Polling + Lock-Heartbeat
  // stoppen, Buchwahl raeumen, View resetten, Buchliste neu laden (das Buch
  // verschwindet daraus). Re-Entry-Guard, weil changes+presence parallel feuern.
  _handleBookAccessLost(bookId) {
    if (!bookId || String(bookId) !== String(this.$store.nav.selectedBookId)) return;
    if (this.$store.collab._bookAccessLostFor === String(bookId)) return;
    this.$store.collab._bookAccessLostFor = String(bookId);
    this._stopCollabPoll();
    if (this.$store.collab._lockHeartbeatTimer) { clearInterval(this.$store.collab._lockHeartbeatTimer); this.$store.collab._lockHeartbeatTimer = null; }
    this.$store.collab._currentEditLock = null;
    this.$store.nav.selectedBookId = '';
    this.resetView();
    this.loadBooks?.();
    this.setStatus(this.t('collab.bookAccessLost'), false, 6000);
    this.$store.collab._bookAccessLostFor = null;
  },

  async _collabPollOnce(bookId) {
    if (document.hidden) return;
    if (!bookId || String(bookId) !== String(this.$store.nav.selectedBookId)) return;
    // Beide Reads parallel: /changes (Diff seit since) + /presence (Live-Heartbeat).
    await Promise.all([
      this._collabFetchChanges(bookId),
      this._collabFetchPresence(bookId),
    ]);
    // Stale-Cleanup fuer foreignEditLock: Wenn der gespeicherte fremde Lock
    // laut expires_at abgelaufen ist, null'en — Server-Cron purged nur 1x/Tag
    // und wir wollen das Banner nicht 24h zu lang stehen lassen.
    if (this.$store.collab.foreignEditLock?.expires_at) {
      const exp = Date.parse(this.$store.collab.foreignEditLock.expires_at);
      if (Number.isFinite(exp) && exp < Date.now()) this.$store.collab.foreignEditLock = null;
    }
  },

  async _collabFetchChanges(bookId) {
    // device_id: macht den Feed geraete-bewusst — der Server filtert nur den Echo
    // DIESES Browsers aus, eigene Edits anderer Geraete (Mac-Client) bleiben.
    const params = new URLSearchParams({ device_id: getDeviceId() });
    if (this.$store.collab._collabSince) params.set('since', this.$store.collab._collabSince);
    const url = '/content/books/' + bookId + '/changes?' + params.toString();
    let data;
    try {
      const r = await fetch(url);
      if (r.status === 403) { this._handleBookAccessLost(bookId); return; }
      if (!r.ok) return;
      data = await r.json();
    } catch { return; }
    if (!data) return;

    // Server-„now"-Stempel als Baseline fuer den naechsten Tick. Server-Uhr,
    // nicht Client-Uhr — Clock-Skew vermeiden.
    if (data.now) this.$store.collab._collabSince = data.now;

    const changes = Array.isArray(data.changes) ? data.changes : [];
    if (changes.length === 0) return;
    this._applyCollabChanges(changes);
  },

  async _collabFetchPresence(bookId) {
    let data;
    try {
      const url = '/content/books/' + bookId + '/presence?device_id=' + encodeURIComponent(getDeviceId());
      const r = await fetch(url);
      if (r.status === 403) { this._handleBookAccessLost(bookId); return; }
      if (!r.ok) return;
      data = await r.json();
    } catch { return; }
    const rows = Array.isArray(data?.presence) ? data.presence : [];
    const map = {};
    for (const p of rows) {
      if (!p?.page_id) continue;
      const key = String(p.page_id);
      if (!map[key]) map[key] = [];
      map[key].push({
        user_email: p.user_email,
        user_display_name: p.user_display_name || p.user_email,
        device_id: p.device_id,
        device_label: p.device_label || null,
        is_self: !!p.is_self,
        last_ping_at: p.last_ping_at,
      });
    }
    this.$store.collab.livePresenceByPage = map;
  },

  _applyCollabChanges(changes) {
    let touchedCurrent = null;
    const others = [];
    for (const ch of changes) {
      if (!ch?.page_id) continue;
      if (this.currentPage?.id && ch.page_id === this.currentPage.id) {
        touchedCurrent = ch;
      } else {
        this.$store.collab.recentRemoteEdits.set(ch.page_id, {
          isSelf: !!ch.is_self,
          device: ch.device_label || null,
        });
        others.push(ch);
      }
    }
    // Map-Mutation: neue Reference triggert Alpine-Reaktivitaet.
    this.$store.collab.recentRemoteEdits = new Map(this.$store.collab.recentRemoteEdits);

    if (touchedCurrent) this._onCurrentPageRemoteEdit(touchedCurrent);
    if (others.length === 1) {
      this._showCollabToast({
        user: others[0].last_editor_name || others[0].last_editor_email,
        pageName: others[0].page_name,
        pageId: others[0].page_id,
        isSelf: !!others[0].is_self,
        device: others[0].device_label || null,
      });
    } else if (others.length > 1) {
      // Nur wenn ALLE Rows vom eigenen Account stammen, ist der Batch ein
      // Multi-Device-Sync; gemischt bleibt die neutrale Fremd-Formulierung.
      this._showCollabToast({
        user: null,
        pageName: null,
        pageId: null,
        count: others.length,
        isSelf: others.every(o => !!o.is_self),
        device: null,
      });
    }
  },

  _onCurrentPageRemoteEdit(change) {
    const name = change.last_editor_name || change.last_editor_email;
    const isSelf = !!change.is_self;
    const device = change.device_label || null;
    if (this.editMode && this.editDirty) {
      // Dirty-Editor: kein Auto-Reload — Banner setzen, naechster Save triggert
      // die optimistische DB-Concurrency-Pruefung (Phase 2).
      this.editConflict = {
        remoteUserName: name,
        remoteUpdatedAt: change.updated_at,
        remoteIsSelf: isSelf,
        remoteDevice: device,
      };
      this.setStatus(isSelf
        ? this.t('edit.conflict.unsavedHintSelf', { device: device || this.t('presence.device.unknown') })
        : this.t('edit.conflict.unsavedHint', { user: name || this.t('edit.conflict.unknownUser') }),
      false, 8000);
      return;
    }
    // Clean-Editor oder Read-Only: frischen Stand holen + Toast.
    this._refetchCurrentPage?.().catch(() => {});
    this._showCollabToast({
      user: name,
      pageName: change.page_name,
      pageId: change.page_id,
      currentPage: true,
      isSelf,
      device,
    });
  },

  // Toast-Text als Methode statt Template-Ternary-Kaskade: drei Faelle
  // (aktuelle Seite / Batch / Einzelseite) mal Self-vs-Fremd.
  collabToastText() {
    const c = this.$store.collab.collabToast;
    if (!c) return '';
    const device = c.device || this.t('presence.device.unknown');
    const user = c.user || this.t('edit.conflict.unknownUser');
    if (c.currentPage) {
      return c.isSelf
        ? this.t('collab.toast.currentPageSelf', { device })
        : this.t('collab.toast.currentPage', { user });
    }
    if (c.count && c.count > 1) {
      return c.isSelf
        ? this.t('collab.toast.batchSelf', { count: c.count })
        : this.t('collab.toast.batch', { count: c.count });
    }
    const page = c.pageName || '';
    return c.isSelf
      ? this.t('collab.toast.otherPageSelf', { device, page })
      : this.t('collab.toast.otherPage', { user, page });
  },

  // Tooltip des Tree-Markers. Ohne Eintrag (Marker nicht gesetzt) null, damit
  // `:data-tip` nichts rendert.
  remoteEditTip(pageId) {
    const meta = this.$store.collab.recentRemoteEdits.get(pageId);
    if (!meta) return null;
    return meta.isSelf
      ? this.t('collab.tree.remoteEditTipSelf', { device: meta.device || this.t('presence.device.unknown') })
      : this.t('collab.tree.remoteEditTip');
  },

  _showCollabToast(payload) {
    this._dismissCollabToast();
    this.$store.collab.collabToast = payload;
    this.$store.collab._collabToastTimer = setTimeout(() => {
      this.$store.collab.collabToast = null;
      this.$store.collab._collabToastTimer = null;
    }, 7000);
  },

  _dismissCollabToast() {
    if (this.$store.collab._collabToastTimer) {
      clearTimeout(this.$store.collab._collabToastTimer);
      this.$store.collab._collabToastTimer = null;
    }
    this.$store.collab.collabToast = null;
  },

  // Beim Klick auf eine im Tree markierte Seite → Marker droppen.
  _clearRemoteEditMark(pageId) {
    if (!pageId || !this.$store.collab.recentRemoteEdits.has(pageId)) return;
    this.$store.collab.recentRemoteEdits.delete(pageId);
    this.$store.collab.recentRemoteEdits = new Map(this.$store.collab.recentRemoteEdits);
  },

  // Liefert das Presence-Array fuer eine Seite. Eigene aktuelle Session ist
  // serverseitig schon ausgefiltert; eigene andere Geraete bleiben drin mit
  // `is_self: true`. [] wenn niemand.
  presenceFor(pageId) {
    if (!pageId) return [];
    return this.$store.collab.livePresenceByPage[String(pageId)] || [];
  },

  // ── Eigener Heartbeat ──────────────────────────────────────────────────
  // Im Edit-Mode pingt der Client alle 30s, damit andere User „X editiert
  // hier" sehen. Verlassen via DELETE bei cancel/save. Page-Wechsel waehrend
  // Edit ist nicht moeglich (Editor zerstoert sich), aber zur Sicherheit
  // hardcoded: bei pageId-Wechsel wird der alte Ping abgemeldet.
  _startPresenceHeartbeat(pageId) {
    if (!pageId) return;
    // Laeuft immer im Edit-Mode (billiger 30s-POST, nur waehrend aktivem Edit) —
    // so liegt die page_presence-Row sofort vor, wenn ein Zweit-Geraet das Buch
    // oeffnet und seinen vollen Poll startet. Gegated ist nur der teure 5s-Poll,
    // nicht dieser Heartbeat.
    if (this.$store.collab._presencePingPageId && this.$store.collab._presencePingPageId !== pageId) {
      this._sendPresenceLeave(this.$store.collab._presencePingPageId);
    }
    this.$store.collab._presencePingPageId = pageId;
    this._sendPresencePing(pageId);
    // Sofort die page-scoped Erkennung anstossen: meldet diese Seite ans
    // book_presence und holt den aktuellen Geraete-Zaehler — so erscheint das
    // Self-Banner gleich bei Edit-Eintritt, nicht erst nach dem 40s-Tick.
    this._pingDevicePresenceNow();
    if (this.$store.collab._presencePingTimer) clearInterval(this.$store.collab._presencePingTimer);
    this.$store.collab._presencePingTimer = setInterval(() => {
      if (this.$store.collab._presencePingPageId) this._sendPresencePing(this.$store.collab._presencePingPageId);
    }, 30 * 1000);
  },

  _stopPresenceHeartbeat() {
    if (this.$store.collab._presencePingTimer) {
      clearInterval(this.$store.collab._presencePingTimer);
      this.$store.collab._presencePingTimer = null;
    }
    const pid = this.$store.collab._presencePingPageId;
    this.$store.collab._presencePingPageId = null;
    if (pid) this._sendPresenceLeave(pid);
  },

  _sendPresencePing(pageId) {
    if (!pageId) return;
    try {
      fetch('/content/pages/' + pageId + '/presence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: getDeviceId() }),
      }).catch(() => {});
    } catch {}
  },

  _sendPresenceLeave(pageId) {
    if (!pageId) return;
    try {
      // device_id auch als Query-Param: keepalive/sendBeacon koennen Body
      // verschlucken; Server akzeptiert beide.
      const did = getDeviceId();
      fetch('/content/pages/' + pageId + '/presence?device_id=' + encodeURIComponent(did), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: did }),
        keepalive: true,
      }).catch(() => {});
    } catch {}
  },

  // ── Soft-Edit-Lock ────────────────────────────────────────────────────
  // Beim Editor-Start: POST /books/pages/:id/lock mit reason='edit'. Heartbeat
  // alle 5 Minuten (TTL 30min serverseitig). Bei 423 (fremder lektorat-Lock)
  // verweigern wir den Edit gar nicht — der PUT haengt sich daran nicht auf,
  // weil getBlockingLockFor nur 'lektorat' meldet (Phase 2 OCC reicht).
  // Fremder 'edit'-Lock landet als foreignEditLock im Banner.
  async _acquireEditLock(pageId) {
    if (!pageId) return null;
    try {
      const r = await fetch('/books/pages/' + pageId + '/lock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'edit' }),
      });
      if (r.status === 423) {
        const body = await r.json().catch(() => ({}));
        this.$store.collab.foreignEditLock = {
          user_email: body.locked_by_email || null,
          user_display_name: this.userDisplayName?.(body.locked_by_email) || body.locked_by_email,
          expires_at: body.expires_at || null,
          reason: body.reason || 'lektorat',
        };
        return null;
      }
      if (!r.ok) return null;
      const data = await r.json();
      this.$store.collab._currentEditLock = data?.lock || null;
      this.$store.collab.foreignEditLock = null;
      this._startLockHeartbeat(pageId);
      return this.$store.collab._currentEditLock;
    } catch { return null; }
  },

  _startLockHeartbeat(pageId) {
    if (this.$store.collab._lockHeartbeatTimer) clearInterval(this.$store.collab._lockHeartbeatTimer);
    // 5min-Tick — Server-TTL ist 30min, doppelt-sicher gegen verlorene Pings.
    this.$store.collab._lockHeartbeatTimer = setInterval(() => {
      if (!this.$store.collab._currentEditLock || !pageId) return;
      this._sendLockHeartbeat(pageId);
    }, 5 * 60 * 1000);
  },

  async _sendLockHeartbeat(pageId) {
    try {
      const r = await fetch('/books/pages/' + pageId + '/lock/heartbeat', { method: 'POST' });
      if (r.status === 423) {
        // Anderer User hat in der Zwischenzeit (Hard-Pfad: 'lektorat') uebernommen.
        const body = await r.json().catch(() => ({}));
        this.$store.collab.foreignEditLock = {
          user_email: body.locked_by_email || null,
          user_display_name: this.userDisplayName?.(body.locked_by_email) || body.locked_by_email,
          expires_at: body.expires_at || null,
          reason: body.reason || 'lektorat',
        };
        this.$store.collab._currentEditLock = null;
        if (this.$store.collab._lockHeartbeatTimer) clearInterval(this.$store.collab._lockHeartbeatTimer);
        this.$store.collab._lockHeartbeatTimer = null;
        return;
      }
      if (!r.ok) return;
      const data = await r.json();
      this.$store.collab._currentEditLock = data?.lock || this.$store.collab._currentEditLock;
    } catch {}
  },

  _releaseEditLock(pageId) {
    if (this.$store.collab._lockHeartbeatTimer) {
      clearInterval(this.$store.collab._lockHeartbeatTimer);
      this.$store.collab._lockHeartbeatTimer = null;
    }
    this.$store.collab._currentEditLock = null;
    if (!pageId) return;
    try {
      fetch('/books/pages/' + pageId + '/lock', { method: 'DELETE' }).catch(() => {});
    } catch {}
  },

  // Best-Effort-Release beim Tab-Close. `navigator.sendBeacon` ist der einzige
  // verlaessliche Pfad waehrend `beforeunload`/`pagehide` — normales fetch wird
  // vom Browser oft gekillt. POST mit JSON-Body, sendBeacon kann das.
  _beaconReleaseEditLock(pageId) {
    if (!pageId || typeof navigator === 'undefined' || !navigator.sendBeacon) return;
    try {
      const blob = new Blob([JSON.stringify({ method: 'DELETE' })], { type: 'application/json' });
      // Server hat keinen sendBeacon-Endpoint mit DELETE-Semantik — Workaround:
      // Wir nutzen fetch mit keepalive:true (Fallback) bzw. sendBeacon mit POST
      // auf einen kuenstlichen Release-Marker. Pragmatischer: fetch mit keepalive.
      fetch('/books/pages/' + pageId + '/lock', { method: 'DELETE', keepalive: true }).catch(() => {});
    } catch {}
  },
};
