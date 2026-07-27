// Dünner Save-Wrapper. Alle Save-Pfade (Notebook, Focus, Book-Editor,
// Lektorat-/Chat-Apply) rufen diese Funktion mit dem reinen PUT-Body aus
// buildSavePayload, damit Payload-Schema + Source-Whitelist nicht pro
// Aufrufer driften. Die Offline-Queue-Anbindung (writeDraft, online-Retry)
// bleibt am Editor-Lifecycle und wird hier nicht gekapselt — sie hängt am
// Karten-State (`saveOffline`, `_onlineHandler`), den eine pure Lib nicht
// kennen darf.
//
// Verantwortung dieser Datei:
//   - PUT-Aufruf an /content/pages/:id über contentRepo
//   - Conflict-Body normalisieren (409 PAGE_CONFLICT)
//
// Nicht hier:
//   - Draft-Schreiben in localStorage (gehört in editor/draft-storage.js)
//   - Status-Banner / setStatus (gehört in Karte)
//   - Listener-Lifecycle (gehört in Karte)

import { contentRepo } from '../../repo/content.js';
import { buildSavePayload } from './save-pipeline.js';

// Führt den PUT durch. Wirft mit dem ursprünglichen Error-Objekt — Aufrufer
// entscheidet, ob 409 als Konflikt-Modal oder als stilles Banner gerendert
// wird (saveEdit vs. quickSave-Pfad).
export async function savePage(pageId, { html, pageName, source, expectedUpdatedAt }) {
  const payload = buildSavePayload({ html, pageName, source, expectedUpdatedAt });
  return contentRepo.savePage(pageId, payload);
}

// Liefert true, wenn der Error ein PAGE_CONFLICT ist (409 + code). Aufrufer
// dürfen sich auf diese Signatur verlassen, statt zwei Felder manuell zu
// vergleichen.
export function isPageConflict(err) {
  return err?.status === 409 && err?.code === 'PAGE_CONFLICT';
}

// Extrahiert die remote-User-/Timestamp-Felder aus einem PAGE_CONFLICT-Error.
// `remoteIsSelf` trennt das eigene Zweit-Gerät (Mac-Client, zweiter Laptop,
// Android) vom fremden ACL-User; `remoteDevice` trägt dessen Label. Alle
// Felder können null sein.
export function readConflictBody(err) {
  return {
    remoteUserName: err?.body?.server_editor_name || null,
    remoteUpdatedAt: err?.body?.server_updated_at || null,
    remoteIsSelf: !!err?.body?.server_is_self,
    remoteDevice: err?.body?.server_editor_device || null,
  };
}
