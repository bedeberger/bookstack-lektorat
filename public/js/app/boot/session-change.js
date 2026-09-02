// Erkennt beim Start, ob eine ANDERE Sitzung laeuft als die, zu der die
// SW-Caches gehoeren — und wirft sie in diesem Fall weg.
//
// DAS PROBLEM: `/content/*` und `/config` liefert der Service Worker als
// Stale-While-Revalidate aus. Fuer den Kaltstart ist das richtig (die Sidebar
// steht sofort, offline ueberhaupt), und der Hintergrund-Revalidate fuellt den
// Cache — aber NICHT die schon gerenderte Sidebar. Geleert wurde der Cache
// bisher einzig vom Logout-Griff der SPA (app-chrome.js#logout), und der setzt
// voraus, dass der User den Logout-Link IN der App klickt und dabei ein SW die
// Seite kontrolliert. Eine abgelaufene Session, ein geschlossener Browser oder
// ein Login direkt von der Login-Seite lassen den Cache also stehen: der erste
// Render nach dem Anmelden zeigt dann den Baum vom letzten Besuch. Bei einem
// Tagebuch heisst das „es fehlen Tage" — eine Aussage, die niemand als
// Cache-Problem liest. Sie haelt ueber jeden normalen Reload und heilt nur
// zufaellig: per Hard-Refresh (umgeht den SW) oder wenn Minuten spaeter der
// Wake-Refresh feuert, weil der Tab lange genug im Hintergrund war.
//
// DIE ANTWORT: Eine neue Anmeldung ist ein EREIGNIS, kein Kaltstart. Der Server
// legt dazu einen Sitzungs-Fingerprint als JS-lesbares Cookie ab
// (lib/session-fingerprint.js); weicht er von dem ab, den dieser Browser sich
// gemerkt hat, gehoert der Cache einer anderen Sitzung.
//
// GELEERT, NICHT UMGANGEN: ein leerer Cache laesst SWR ans Netz gehen und
// fuellt sich dabei wieder. Ein `__fresh=1` waere ebenfalls frisch, liesse die
// Offline-Kopie aber leer — darum ist es hier nur der Rueckfall fuer den Fall,
// dass gar kein SW erreichbar ist (siehe app-init.js).

// Bewusste Kopie des Cookie-Namens aus lib/session-fingerprint.js — der Server
// ist CJS, das Browser-Bundle ESM. Gegated durch
// tests/unit/session-change.test.mjs.
export const SESSION_FP_COOKIE = 'sw_sess';
const LS_KEY = 'sw:sessionFp';

export function readCookie(name, header) {
  const src = header !== undefined ? header : (typeof document !== 'undefined' ? document.cookie : '');
  const m = new RegExp('(?:^|;\\s*)' + name + '=([^;]*)').exec(src || '');
  return m ? m[1] : null;
}

// Pure Entscheidung, damit sie ohne Browser pruefbar ist.
//
// Kein Cookie → kein Signal (Cookies geblockt, Device-Token-Kontext, Session
// aelter als dieses Feature): dann NICHT wegwerfen, sonst verliert eine
// funktionierende Offline-Kopie bei jedem Start ihren Sinn.
//
// Cookie da, aber nichts gemerkt → als Wechsel behandeln. Wir wissen nicht, zu
// welcher Sitzung der vorhandene Cache gehoert, und die beiden Kosten sind
// nicht vergleichbar: ein Drop kostet einen Refetch, ein Stale-Render kostet
// fehlende Tage im Tagebuch. Auf einem wirklich ersten Besuch ist der Cache
// ohnehin leer und der Drop ein No-op.
export function decideSessionChange(cookieFp, storedFp) {
  if (!cookieFp) return false;
  return cookieFp !== storedFp;
}

export function detectSessionChange() {
  const fp = readCookie(SESSION_FP_COOKIE);
  let stored = null;
  try { stored = localStorage.getItem(LS_KEY); } catch { /* Private Mode */ }
  return { changed: decideSessionChange(fp, stored), fp };
}

// Pure Handlungswahl, damit die drei Faelle ohne Browser pruefbar sind.
//
// `skip` ist der Offline-Fall und kein Detail: ein Cache, den wir nicht neu
// fuellen koennen, ist offline das Einzige, was ueberhaupt funktioniert. Er
// bleibt dann stehen UND der Fingerprint wird nicht gemerkt — der naechste
// Start mit Netz sieht die Abweichung erneut und heilt.
export function planSessionCacheAction({ changed, online }) {
  if (!changed) return 'remember';
  if (!online) return 'skip';
  return 'drop';
}

export function rememberSession(fp) {
  if (!fp) return;
  try { localStorage.setItem(LS_KEY, fp); } catch { /* Private Mode */ }
}

// Wirft CONTENT_CACHE + CONFIG_CACHE weg (gleicher SW-Griff wie der Logout).
// Rueckgabe `true` nur bei bestaetigtem Drop — der Aufrufer entscheidet daran,
// ob er zusaetzlich frisch lesen muss. Timeout wie im Logout-Pfad: lieber
// einmal frisch lesen als den Start an einer Quittung haengen lassen.
export async function dropSessionCaches() {
  const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : null;
  const ctrl = sw?.controller;
  if (!ctrl) return false;
  const done = new Promise(resolve => {
    const onMsg = (e) => {
      if (e.data?.type === 'session-changed-done') {
        sw.removeEventListener('message', onMsg);
        resolve(true);
      }
    };
    sw.addEventListener('message', onMsg);
    setTimeout(() => { sw.removeEventListener('message', onMsg); resolve(false); }, 1500);
  });
  try { ctrl.postMessage({ type: 'session-changed' }); }
  catch { return false; }
  return done;
}

// Bringt die SW-Caches mit der laufenden Sitzung in Deckung und liefert die
// Optionen fuer den ersten Buch-Read zurueck ({} = normal, also SWR gegen einen
// Cache, der jetzt zu dieser Sitzung gehoert).
//
// Gemerkt wird der Fingerprint nur, wenn der Cache nachweislich passt. Sonst
// wuerde ein unbestaetigtes Leeren den Stale-Stand als "gleiche Sitzung"
// festschreiben, und der naechste Start rendert wieder daraus.
export async function reconcileSessionCaches() {
  const { changed, fp } = detectSessionChange();
  const online = typeof navigator === 'undefined' || navigator.onLine !== false;
  const action = planSessionCacheAction({ changed, online });
  if (action === 'remember') { rememberSession(fp); return {}; }
  if (action === 'skip') return {};
  if (await dropSessionCaches()) { rememberSession(fp); return {}; }
  // Kein erreichbarer SW / keine Quittung: ersatzweise frisch lesen. Kostet die
  // Offline-Kopie bis zum naechsten Kaltstart, nicht den aktuellen Stand — und
  // ohne kontrollierenden SW gibt es ohnehin keinen Stale-Hit.
  return { source: 'login' };
}
