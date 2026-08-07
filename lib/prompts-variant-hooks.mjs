// ESM-Loader-Hook fuer die zwei Prompt-Modul-Instanzen (siehe lib/prompts-loader.js).
//
// Zweck: `import('prompts.js?promptVariant=local')` liefert von sich aus nur eine
// zweite Instanz der EINSTIEGS-Datei — die Abhaengigkeiten (`./prompts/state.js`
// & Co.) loesen fuer beide Instanzen auf dieselbe URL auf und bleiben damit
// GETEILT. Genau dort liegt aber `_isLocal`. Ohne diesen Hook haetten beide
// Instanzen weiterhin ein gemeinsames Provider-Flag und der Umbau waere wirkungslos.
//
// Der resolve-Hook zieht die Variante darum vom Elternmodul auf jedes Kind
// weiter, sodass pro Variante ein vollstaendig eigener Modulgraph entsteht —
// eigener `_isLocal`, eigene gebaute Schemas, eigene SYSTEM_*-Prompts.
//
// Eng gefasst, damit der prozessweite Hook nichts anderes beruehrt:
//   - greift nur, wenn der IMPORTIERENDE bereits die Marker-Query traegt,
//   - nur `file:`-URLs (kein `node:`, kein `data:`),
//   - nie unter `node_modules/` — npm-Pakete bleiben Singletons, ihre
//     Seiteneffekte duerfen sich nicht verdoppeln.
// Der Prompt-Graph ist heute vollstaendig self-contained (nur relative Importe
// innerhalb von public/js/prompts/), die Duplikation also klein und begrenzt.
//
// Der Query-Parameter-Name kommt via register(data) aus lib/prompts-loader.js —
// dort ist die SSoT, damit die beiden Dateien nicht auseinanderdriften.

const DEFAULT_PARAM = 'promptVariant';

let _param = DEFAULT_PARAM;
let _re = new RegExp(`[?&]${DEFAULT_PARAM}=([a-z]+)`);

export async function initialize(data) {
  if (data && data.param) {
    _param = data.param;
    _re = new RegExp(`[?&]${_param}=([a-z]+)`);
  }
}

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  const m = _re.exec(context.parentURL || '');
  if (!m) return result;
  const url = result.url;
  if (!url.startsWith('file:')) return result;
  if (url.includes('/node_modules/')) return result;
  if (_re.test(url)) return result;
  return {
    ...result,
    url: `${url}${url.includes('?') ? '&' : '?'}${_param}=${m[1]}`,
    shortCircuit: true,
  };
}
