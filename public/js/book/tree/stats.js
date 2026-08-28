import { CHARS_PER_TOKEN, charBadgeLabel, localeTag, relativeDay, tzOpts } from '../../utils.js';
import { htmlToPlainText } from '../../html-text.js';
import { EVT } from '../../events.js';

// Seiten-Status (Lektorat-Aktualität), Tooltip-Zeilen, Page-Stats-Sync nach Save
// und Kapitel-Stat-Aggregation. `this` = die Alpine-Komponente (tree-Methoden
// werden gemeinsam in den Root gespreadet).

const STALE_THRESHOLD_DAYS = 30;

// Tag-Differenz auf Basis lokaler Mitternacht – analog zu fmtLastRun in
// routes/jobs/shared.js. Verhindert Off-by-one bei Checks <24h, die aber
// bereits am Vortag stattfanden.
function _diffDays(then, now = new Date()) {
  const a = new Date(then.getFullYear(), then.getMonth(), then.getDate());
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((b - a) / 86400000);
}

function _fmtTime(d, locale) {
  return d.toLocaleTimeString(localeTag(locale), tzOpts({ hour: '2-digit', minute: '2-digit' }));
}
function _fmtDateShort(d, locale) {
  return d.toLocaleDateString(localeTag(locale), tzOpts({ day: '2-digit', month: '2-digit' }));
}

export const treeStatsMethods = {
  pageStatus(page) {
    const rec = this.pageLastChecked?.[page.id];
    if (!rec) return 'none';
    const checkedAt = new Date(rec.at);
    const updatedMs = page.updated_at ? new Date(page.updated_at).getTime() : 0;
    if (updatedMs > checkedAt.getTime()) return 'warn';
    if (_diffDays(checkedAt) >= STALE_THRESHOLD_DAYS) return 'warn';
    if (rec.pending) return 'pending';
    return 'ok';
  },

  // Erwartete Keys: `${prefix}Rel` ({rel, time}) und `${prefix}On` ({date, time}).
  // `rel` kommt aus Intl.RelativeTimeFormat (heute / gestern / vor N Tagen).
  _fmtRelativeLine(d, prefix) {
    const diff = Math.max(0, _diffDays(d));
    const time = _fmtTime(d, this.$store.shell.uiLocale);
    if (diff < 7) return this.t(`${prefix}Rel`, { rel: relativeDay(diff, this.$store.shell.uiLocale), time });
    return this.t(`${prefix}On`, { date: _fmtDateShort(d, this.$store.shell.uiLocale), time });
  },

  pageStatusTooltip(page) {
    const rec = this.pageLastChecked?.[page.id];
    const updatedAt = page.updated_at ? new Date(page.updated_at) : null;
    const pageLine = updatedAt ? this._fmtRelativeLine(updatedAt, 'sidebar.status.pageUpdated') : '';
    if (!rec) {
      const lines = [this.t('sidebar.status.noLektorat')];
      if (pageLine) lines.push(pageLine);
      return lines;
    }
    const checkedAt = new Date(rec.at);
    const lektLine = this._fmtRelativeLine(checkedAt, 'sidebar.status.lektorat');
    const editedSince = updatedAt && updatedAt.getTime() > checkedAt.getTime();
    const lines = [];
    if (editedSince) lines.push(this.t('sidebar.status.editedSince'));
    else if (rec.pending) lines.push(this.t('sidebar.status.pending'));
    lines.push(lektLine);
    const myEmail = this.$store.session.currentUser?.email || null;
    if (rec.by && myEmail && rec.by !== myEmail) {
      lines.push(this.t('sidebar.status.lektoratBy', { user: rec.by }));
    }
    if (pageLine) lines.push(pageLine);
    return lines;
  },

  markPageChecked(pageId, { pending = false } = {}) {
    if (pageId == null) return;
    this.pageLastChecked = {
      ...this.pageLastChecked,
      [pageId]: {
        at: new Date().toISOString(),
        pending: !!pending,
        by: this.$store.session.currentUser?.email || null,
      },
    };
  },

  // Nach einem Page-Save tokEsts neu berechnen, damit der Baum den
  // "leer"-Badge sofort verliert und die Zeichenzahl stimmt. Persistiert
  // den frischen Stat-Eintrag auch in der History-DB.
  //
  // WICHTIG: Char/Word-Count via lib/html-text.js / public/js/html-text.js
  // (SSoT). Servers- und Frontend-Pendant dekodieren HTML-Entities, strippen
  // Tags zu Single-Space, collapse \s+, trim — sonst zaehlt trailing NBSP aus
  // dem Editor (`&#160;`) als 6 Zeichen mit und treibt Heute-Ring/7-Tage-Bars
  // gegen den Cron-Snapshot.
  //
  // Nur Seiten-HTML zählt — Seitennamen sind kein Teil des Umfangs (analog
  // routes/sync.js#computeStats). tok = chars / CHARS_PER_TOKEN.
  _syncPageStatsAfterSave(page, html) {
    if (!page?.id) return;
    // Gespeicherte Seite kann Abbildungen hinzugefuegt oder entfernt haben — die
    // Anker im Index sind jetzt andere, also darf der Ziel-Picker seine
    // gecachte Liste nicht behalten. Bewusst UNGATED (nicht „nur wenn <figure>
    // im neuen HTML steht"): beim Entfernen der letzten Abbildung enthaelt das
    // neue HTML gerade keine mehr, die Zielliste hat sich aber trotzdem
    // geaendert. Der Cache spart einen Fetch pro Picker-Oeffnung, nicht pro Save.
    // Dieser Hook laeuft aus allen drei Editoren — ein Signal deckt alle ab.
    window.dispatchEvent(new CustomEvent(EVT.XREFS_CHANGED, {
      detail: { bookId: this.$store?.nav?.selectedBookId ?? null },
    }));
    const normalized = htmlToPlainText(String(html || ''));
    const words = normalized === '' ? 0 : normalized.split(/\s+/).length;
    const stat = {
      tok: Math.round(normalized.length / CHARS_PER_TOKEN),
      words,
      chars: normalized.length,
    };
    this.tokEsts = { ...this.tokEsts, [page.id]: stat };
    if (!this.$store.nav.selectedBookId) return;
    fetch('/history/page-stats/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{
        page_id: page.id,
        book_id: parseInt(this.$store.nav.selectedBookId),
        tok: stat.tok,
        words: stat.words,
        chars: stat.chars,
        updated_at: page.updated_at || null,
      }]),
    }).catch(() => {});
  },

  // Setzt `item.stats` für jedes Kapitel der aktuellen Tree-Struktur.
  // Aufruf: nach Tree-Build (loadPages) und nach jeder tokEsts-Reassignment
  // (loadTokenEstimates / _syncPageStatsAfterSave). Mutiert direkt die
  // Kapitel-Items — Alpine-Reaktivität trägt das Update an die Sidebar.
  _refreshChapterStats() {
    const ts = this.tokEsts || {};
    const items = (this.$store.nav.tree || []).filter(it => it.type === 'chapter');
    const childMap = new Map();
    for (const it of items) {
      if (it.solo || !it.parent_id) continue;
      const arr = childMap.get(it.parent_id) || [];
      arr.push(it);
      childMap.set(it.parent_id, arr);
    }
    const cache = new Map();
    const subtree = (item) => {
      if (cache.has(item.id)) return cache.get(item.id);
      let words = 0, chars = 0, tok = 0, count = 0;
      for (const p of item.pages) {
        const e = ts[p.id];
        if (e) { words += e.words; chars += e.chars; tok += e.tok; count++; }
      }
      for (const child of (childMap.get(item.id) || [])) {
        const s = subtree(child);
        words += s.words; chars += s.chars; tok += s.tok; count += s.count;
      }
      const res = { words, chars, tok, count };
      cache.set(item.id, res);
      return res;
    };
    for (const item of items) {
      const { words, chars, tok, count } = subtree(item);
      item.stats = count
        ? {
            words, chars, tok, count,
            normseiten: Math.round((chars / 1500) * 10) / 10,
            badge: charBadgeLabel(chars, this.t('bookstats.unit.z')),
          }
        : null;
    }
  },
};
