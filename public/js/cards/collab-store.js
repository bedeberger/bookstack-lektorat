// Alpine.store('collab') — Collaboration-/Presence-/Soft-Lock-State (offenes
// Buch + offene Seite). Vorher flach in der Root-God-State; jetzt eine schmale,
// benannte Store-Oberfläche. Der Store-Name liefert den Namespace, darum tragen
// die Keys kein `collab`-Präfix (Zugriff via `$store.collab.collabToast`).
//
// Kein Root-Proxy-Spiegel (wie tts): die Methoden in app-collab.js (in den Root
// gespreadet) greifen direkt via `this.$store.collab.*` zu, die Templates via
// `$store.collab.*`, app-init.js (beforeunload) via `this.$store.collab.*`. Die
// Methoden selbst (`presenceFor`, `_acquireEditLock`, `_startPresenceHeartbeat`,
// …) bleiben am Root — lifecycle.js/Templates rufen sie unverändert auf.
//
// Feld-Bedeutung:
//   _collabSince        — Server-„now"-Stempel als Baseline des nächsten /changes-Polls.
//   _collabPollTimer    — 5s-Voll-Poll (changes + presence); nur bei Zweit-Partei aktiv.
//   recentRemoteEdits   — Map<page_id, { isSelf, device }> der Seiten, die der
//                         Tree als „extern geändert" markiert; `isSelf` trennt
//                         eigenes Zweit-Gerät von fremdem User (Tooltip-Wortlaut,
//                         Root-Methode `remoteEditTip`). Map-Reassignment
//                         triggert die Reaktivität.
//   collabToast         — { user, pageName, pageId, count?, currentPage?,
//                         isSelf, device } | null. Text via `collabToastText()`.
//   _collabToastTimer   — Auto-Dismiss-Timer des Toasts.
//   livePresenceByPage  — Map<pageId, [{ user_email, user_display_name, device_id,
//                         device_label, is_self, last_ping_at }]>. Gelesen via
//                         der Root-Methode `presenceFor(pageId)`.
//   _presencePingTimer  — eigener 30s-Edit-Heartbeat (page_presence).
//   _presencePingPageId — Seite, für die der Heartbeat läuft.
//   _bookDevicePingTimer/_bookDevicePingBookId — leichter 40s-Buch-Geräte-Ping
//                         (Multi-Device-Erkennung), läuft immer bei offenem Buch.
//   _selfPageDeviceCount/_selfBookDeviceCount — eigene aktive Geräte auf der
//                         Seite bzw. im ganzen Buch; >1 schaltet den Voll-Poll frei.
//   _currentEditLock    — eigener gehaltener Soft-Lock { expires_at, reason }.
//   _lockHeartbeatTimer — 5min-Heartbeat des eigenen Locks (Server-TTL 30min).
//   foreignEditLock     — fremder Lock auf der offenen Seite (Banner-Quelle):
//                         { user_email, user_display_name, expires_at, reason } | null.
//   _bookAccessLostFor  — Re-Entry-Guard für _handleBookAccessLost (changes +
//                         presence feuern parallel und liefern beide 403).

export function registerCollabStore() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.store('collab', {
    _collabSince: null,
    _collabPollTimer: null,
    recentRemoteEdits: new Map(),
    collabToast: null,
    _collabToastTimer: null,
    livePresenceByPage: {},
    _presencePingTimer: null,
    _presencePingPageId: null,
    _bookDevicePingTimer: null,
    _bookDevicePingBookId: null,
    _selfPageDeviceCount: 0,
    _selfBookDeviceCount: 0,
    _currentEditLock: null,
    _lockHeartbeatTimer: null,
    foreignEditLock: null,
    _bookAccessLostFor: null,
  });
}
