// Keyed Timeout-Bag: mehrere gleichartige Timer, adressiert über einen Key
// (z.B. eine pageId), mit garantiertem Sammel-Cleanup. Ersetzt das Muster
// „`Map<key, timeoutId>` + drei Stellen, die clearTimeout/delete von Hand
// paaren" — genau dort entstehen Leaks, wenn ein Pfad das Löschen vergisst.
//
// Pur bis auf setTimeout/clearTimeout; kein DOM, kein Alpine-State.
export function createTimerBag() {
  const bag = new Map();

  return {
    // Setzt (bzw. ersetzt) den Timer für `key`. Der Handle räumt sich beim
    // Feuern selbst aus der Map — `has(key)` ist damit ehrlich.
    set(key, fn, ms) {
      const prev = bag.get(key);
      if (prev) clearTimeout(prev);
      bag.set(key, setTimeout(() => {
        bag.delete(key);
        fn();
      }, ms));
    },

    // Setzt den Timer nur, wenn für `key` noch keiner läuft (Max-Cap-Semantik:
    // ab dem ersten Auslöser durchlaufen, nicht bei jedem Tick verlängern).
    setOnce(key, fn, ms) {
      if (bag.has(key)) return;
      this.set(key, fn, ms);
    },

    has(key) { return bag.has(key); },

    clear(key) {
      const t = bag.get(key);
      if (!t) return;
      clearTimeout(t);
      bag.delete(key);
    },

    clearAll() {
      for (const t of bag.values()) clearTimeout(t);
      bag.clear();
    },
  };
}
