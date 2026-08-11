'use strict';
// Kleine Normalisierer, die sich mehrere Schreibpfade teilen. Bewusst ein
// eigenes Modul: sie werden von Zeitstrahl, Orten, Welt-Fakten, Songs,
// Kontinuitaet und allen Delta-Caches gebraucht — als Kopie pro Domaenen-Modul
// wuerden sie auseinanderdriften, im Facade-Modul waeren sie ein Grund, es am
// Leben zu halten.


// Schreib-Guard für user_email auf den Tabellen mit FK auf app_users(email)
// (job_checkpoints, zeitstrahl_events und die Delta-Caches für Extract, Review,
// Makro-Review, Lektorat, Synonyme, Finetune-Augmentation). Die Spalten tragen
// dort ein NOT NULL DEFAULT '' — ein Leerstring ist aber keine app_users-Zeile,
// der Write liefe also in einen FK-Constraint-Fehler aus dem Prepared Statement,
// der nicht verrät, welcher Aufrufer ohne User-Kontext lief. Deshalb hier hart
// abbrechen statt auf '' zu coalescen. Lese- und Löschpfade behalten das
// Coalescing: dort ist der Effekt ein Cache-Miss bzw. ein No-Op.
function requireUserEmail(userEmail, what) {
  const e = userEmail == null ? '' : String(userEmail).trim();
  if (!e) throw new Error(`${what}: user_email fehlt — Schreibzugriff ohne User-Kontext.`);
  return e;
}

// KI liefert in Listenfeldern (figuren/kapitel/seiten) gelegentlich Objekte
// statt blanker Strings — z.B. `{name: 'Renate', id: 'fig-3'}` oder
// `{name: 'Olten', haeufigkeit: 2}`. Vor dem Persistieren auf String reduzieren,
// damit Renderer nicht "[object Object]" ausgeben.
function toRefString(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') {
    const s = v.name || v.titel || v.label || v.fig_id || v.loc_id || v.id;
    return s ? String(s).trim() || null : null;
  }
  return null;
}

module.exports = {
  requireUserEmail,
  toRefString,
};
