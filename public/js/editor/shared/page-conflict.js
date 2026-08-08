// Pre-Save-Conflict-Check für Read-Modify-Write-Pfade — geteilt von Notebook-
// Editor und Bucheditor.
//
// Liegt unter shared/, weil die Frage „hat jemand anderes seit meinem Snapshot
// geschrieben?" eine Eigenschaft der SEITE ist, nicht eines Editors. Der
// Bucheditor griff dafür früher über die Root-Trampoline in die Notebook-Karte
// (`app._checkPageConflict`) — sein Stale-Schutz hing damit daran, dass eine
// fremde Karte gemountet ist, und der Forwarder lieferte bei fehlender Karte
// `null`, also „kein Konflikt".
//
// Trennung von shared/page-api.js ist dieselbe wie dort beschrieben: hier steht,
// WAS geprüft wird, dort WIE geschrieben wird.

import { contentRepo } from '../../repo/content.js';
import { editorHost } from './editor-host.js';

/**
 * Vor dem PUT die Seite frisch lesen und `updated_at` mit dem Editor-Snapshot
 * vergleichen; Mismatch = jemand hat zwischendrin gespeichert.
 *
 * Wirft NICHT — der Aufrufer entscheidet bei einem Read-Fehler selbst (und
 * bekommt `null`, also „weitermachen"): ein Modal auf unsicherer Datenlage wäre
 * irreführend, der ohnehin folgende PUT läuft in den OCC-Guard des Backends.
 *
 * @returns {Promise<null|{remoteUpdatedAt, remoteUserName, remoteIsSelf, remoteDevice, remoteHtml}>}
 */
export async function checkPageConflict(pageId, expectedUpdatedAt) {
  if (!expectedUpdatedAt) return null;
  // Offline kann es keinen Cross-User-Konflikt geben — der ohnehin folgende
  // PUT wird ebenfalls scheitern und in den Offline-Banner-Pfad fallen. Modal
  // hier zu zeigen wäre irreführend (kein verlässlicher Server-Stand).
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return null;
  let remote;
  try {
    // `fresh: true` ist Pflicht: ohne den Bypass liefert der SW-SWR-Cache einen
    // stale `updated_at`, der Pre-Check passt fälschlich durch und überschreibt
    // den fremden Save.
    remote = await contentRepo.loadPage(pageId, { fresh: true });
  } catch (e) {
    console.warn('[checkPageConflict] read failed, skip modal', { pageId, status: e?.status, code: e?.code, msg: e?.message });
    return null;
  }
  if (!remote?.updated_at) {
    console.warn('[checkPageConflict] remote response without updated_at, skip modal', { pageId });
    return null;
  }
  if (remote.updated_at === expectedUpdatedAt) return null;
  // Eigenes Zweit-Gerät (Mac-Client, zweiter Laptop, Android) vs. fremder
  // ACL-User: `last_editor.device_name` ist serverseitig ohnehin nur für die
  // eigenen Geräte des Anfragers gefüllt.
  const selfEmail = editorHost()?.$store?.session?.currentUser?.email || null;
  const remoteIsSelf = !!selfEmail && remote.last_editor_email === selfEmail;
  return {
    remoteUpdatedAt: remote.updated_at,
    remoteUserName: remote.updated_by_name || null,
    remoteIsSelf,
    remoteDevice: remote.last_editor?.device_name || null,
    remoteHtml: remote.html || '',
  };
}

// Banner-/Block-State aus einem `checkPageConflict`-Objekt: derselbe Feldsatz
// ohne `remoteHtml` (das gehört dem Merge-Pfad, nicht der Anzeige). Die
// 409-Variante liefert `readConflictBody(err)` aus shared/page-api.js dieselbe
// Form aus dem Server-Body — beide Quellen, ein Feldsatz.
export function conflictBannerFrom(conflict) {
  return {
    remoteUserName: conflict.remoteUserName,
    remoteUpdatedAt: conflict.remoteUpdatedAt,
    remoteIsSelf: conflict.remoteIsSelf,
    remoteDevice: conflict.remoteDevice,
  };
}
