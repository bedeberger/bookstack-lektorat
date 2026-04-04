// Methoden für BookStack-API-Calls (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.
// Authorization-Header wird serverseitig vom Proxy injiziert.

export const bookstackMethods = {
  async bsGet(path) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('Timeout: BookStack hat nicht innerhalb von 30 Sekunden geantwortet')), 30000);
    try {
      const r = await fetch('/api/' + path, { signal: ctrl.signal });
      if (r.status === 401) { location.href = '/auth/login'; return; }
      if (!r.ok) throw new Error('BookStack API Fehler ' + r.status);
      return r.json();
    } catch (e) {
      if (e.name === 'AbortError') {
        throw new Error(ctrl.signal.reason?.message || 'Timeout: Anfrage wurde abgebrochen');
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  },

  async bsGetAll(path) {
    const COUNT = 500;
    let offset = 0, all = [];
    while (true) {
      const sep = path.includes('?') ? '&' : '?';
      const data = await this.bsGet(`${path}${sep}count=${COUNT}&offset=${offset}`);
      all = all.concat(data.data);
      if (all.length >= data.total) break;
      offset += COUNT;
    }
    return all;
  },

  async bsPut(path, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('Timeout: BookStack hat nicht innerhalb von 90 Sekunden geantwortet')), 90000);
    try {
      const r = await fetch('/api/' + path, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (r.status === 401) { location.href = '/auth/login'; return; }
      if (!r.ok) {
        let detail = '';
        try { const e = await r.json(); detail = e.message || e.error || ''; } catch (_) {}
        throw new Error(`BookStack API Fehler ${r.status}${detail ? ': ' + detail : ''}`);
      }
      return r.json();
    } catch (e) {
      if (e.name === 'AbortError') {
        throw new Error(ctrl.signal.reason?.message || 'Timeout: Anfrage wurde abgebrochen');
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  },

  _applyCorrections(html, fehler) {
    let result = html;
    for (const f of fehler) {
      if (!f.original || !f.korrektur || f.original === f.korrektur) continue;
      const idx = result.indexOf(f.original);
      if (idx !== -1) {
        result = result.slice(0, idx) + f.korrektur + result.slice(idx + f.original.length);
      }
    }
    return result;
  },
};
