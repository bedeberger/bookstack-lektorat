// Undo/Redo für Buchorganizer.
//
// Record-Typen:
//   { kind: 'reorder', before, after }              — workstate-Snapshots
//   { kind: 'rename-chapter', id, oldName, newName }
//   { kind: 'rename-page',    id, oldName, newName }
//   { kind: 'create-chapter', id, name }
//   { kind: 'create-page',    id, chapterId, name }
//
// Capacity: HISTORY_MAX pro Stack (FIFO-Drop bei Überlauf).
//
// Sonderfall create: Undo löscht das frisch erstellte Kapitel/Seite. Nach
// einem solchen Undo wird der gesamte Redo-Stack invalidiert — beim erneuten
// Anlegen würde der Server eine NEUE ID vergeben, andere Records im Redo-Stack
// referenzieren aber die alten IDs (z.B. Reorder-Snapshots). Saubere Lösung:
// User legt das Kapitel manuell neu an.
//
// Delete (Kapitel/Seite) ist ebenfalls nicht reversibel (Hard-Delete in SQLite,
// keine Content-Snapshots). Delete-Operationen rufen `_clearHistory()` und
// blocken damit Undo komplett, statt einen inkonsistenten Stack zu hinterlassen.

const HISTORY_MAX = 10;

export const historyMethods = {
  _clearHistory() {
    this._undoStack = [];
    this._redoStack = [];
  },

  _pushUndo(record, { clearRedo = true } = {}) {
    if (this._inHistoryFlight) return;
    this._undoStack.push(record);
    while (this._undoStack.length > HISTORY_MAX) this._undoStack.shift();
    if (clearRedo) this._redoStack = [];
  },

  _pushRedo(record) {
    this._redoStack.push(record);
    while (this._redoStack.length > HISTORY_MAX) this._redoStack.shift();
  },

  _recordReorder(before) {
    const after = this._snapshotWorkstate();
    this._pushUndo({ kind: 'reorder', before, after });
  },

  _recordRenameChapter(id, oldName, newName) {
    this._pushUndo({ kind: 'rename-chapter', id, oldName, newName });
  },

  _recordRenamePage(id, oldName, newName) {
    this._pushUndo({ kind: 'rename-page', id, oldName, newName });
  },

  _recordCreateChapter(id, name) {
    this._pushUndo({ kind: 'create-chapter', id, name });
  },

  _recordCreatePage(id, chapterId, name) {
    this._pushUndo({ kind: 'create-page', id, chapterId, name });
  },

  // Der Gegen-Stack wird ERST NACH dem Flight beschrieben: `_pushUndo` verwirft
  // Records, solange `_inHistoryFlight` steht (das ist der Schutz davor, dass eine
  // wiederhergestellte Mutation sich selbst wieder aufzeichnet). Innerhalb des
  // try-Blocks aufgezeichnet, fiele der Redo→Undo-Rückweg genau darauf herein —
  // nach einem Redo wäre nichts mehr rückgängig zu machen.
  async historyUndo() {
    if (this.organizerSaving || this._inHistoryFlight) return;
    const rec = this._undoStack.pop();
    if (!rec) return;
    this._inHistoryFlight = true;
    let ok = false;
    try {
      ok = await this._applyInverse(rec);
    } finally {
      this._inHistoryFlight = false;
    }
    if (!ok) { this._undoStack.push(rec); return; }
    if (rec.kind === 'create-chapter' || rec.kind === 'create-page') {
      // Redo-Pfad wäre ein Recreate mit neuer ID → bestehende Records mit
      // alter ID werden inkonsistent. Komplett invalidieren.
      this._redoStack = [];
    } else {
      this._pushRedo(rec);
    }
  },

  async historyRedo() {
    if (this.organizerSaving || this._inHistoryFlight) return;
    const rec = this._redoStack.pop();
    if (!rec) return;
    this._inHistoryFlight = true;
    let ok = false;
    try {
      ok = await this._applyForward(rec);
    } finally {
      this._inHistoryFlight = false;
    }
    if (!ok) { this._redoStack.push(rec); return; }
    this._pushUndo(rec, { clearRedo: false });
  },

  async _applyInverse(rec) {
    if (rec.kind === 'reorder') return this._applyReorderSnapshot(rec.before);
    if (rec.kind === 'rename-chapter') return this._doRenameChapter(rec.id, rec.oldName, null);
    if (rec.kind === 'rename-page') return this._doRenamePage(rec.id, rec.oldName, null);
    if (rec.kind === 'create-chapter') return this._deleteChapterRaw(rec.id);
    if (rec.kind === 'create-page') return this._deletePageRaw(rec.id);
    return false;
  },

  async _applyForward(rec) {
    if (rec.kind === 'reorder') return this._applyReorderSnapshot(rec.after);
    if (rec.kind === 'rename-chapter') return this._doRenameChapter(rec.id, rec.newName, null);
    if (rec.kind === 'rename-page') return this._doRenamePage(rec.id, rec.newName, null);
    return false;
  },

  // Snapshot einspielen: Workstate ersetzen, Sortables neu binden, dann derselbe
  // Single-Tree-PUT wie jede andere Reorder-Mutation. `mirror: 'both'`, weil ein
  // Snapshot sowohl Kapitel-Struktur als auch Seiten-Zugehoerigkeit enthalten
  // kann (Chapter-Prio/Tiefe zuerst, danach Page-Membership mit neuen Prios).
  async _applyReorderSnapshot(snap) {
    this.workTree = JSON.parse(JSON.stringify(snap.workTree));
    this.soloPages = JSON.parse(JSON.stringify(snap.soloPages));
    await this._reattachSortables();
    return await this._persistOrder({ mirror: 'both' });
  },
};
