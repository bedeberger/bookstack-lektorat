// Teil von notebookEditMethods (siehe Facade edit.js).
import { FEATURE_BLOCK_MERGE, buildResolvedHtml, checkPageConflict, conflictBannerFrom, conflictText, contentRepo, editorHost, isPageConflict, mergeBlocks, mergedToHtml, mountEditorHtml, readConflictBody, savePage, trackMerge, writeDraft } from './_shared.js';

export const conflictMethods = {

  // Text des Konflikt-Banners. Die Gerät-vs-User-Verzweigung liegt in
  // shared/conflict-text.js (geteilt mit dem Bucheditor); hier nur die Variante
  // und der Zeitstempel als zusätzlicher Platzhalter.
  editConflictBannerText() {
    const app = editorHost();
    const c = app?.editConflict;
    if (!c) return '';
    const time = c.remoteUpdatedAt ? app.formatDate(c.remoteUpdatedAt) : '';
    return conflictText(app.t.bind(app), c, 'banner', { time });
  },


  // Banner-State (`editConflict`) aus einem Konflikt-Objekt — Feldsatz-SSoT in
  // shared/page-conflict.js, weil ihn beide Editoren gleich befüllen.
  _conflictBannerFrom(conflict) {
    return conflictBannerFrom(conflict);
  },


  // Statuszeile für den stillen Pfad (quickSave/Autosave).
  _conflictHintText(banner) {
    const app = editorHost();
    return conflictText(app.t.bind(app), banner, 'hint');
  },


  // Gemeinsamer Fallback aller Save-Pfade, wenn ein Konflikt nicht automatisch
  // aufzulösen ist: lokale Fassung als Draft sichern, Offline-/Konflikt-Banner
  // setzen, Status melden. Draft zuerst (Pflicht-Invariante #5) — die Arbeit
  // darf nicht am Banner hängen.
  _keepAsDraft({ pageId, html, banner = null, statusKey = 'edit.conflict.kept', statusMs = 8000 }) {
    const app = editorHost();
    const draftOk = writeDraft(pageId, html, app.originalHtml, app.currentPage?.updated_at);
    app.draftPersistFailed = !draftOk;
    if (draftOk) app.lastDraftSavedAt = Date.now();
    app.saveOffline = true;
    if (banner) app.editConflict = banner;
    if (statusKey) app.setStatus(app.t(statusKey), false, statusMs);
  },


  // Konflikt-Klärung VOR dem PUT. SSoT für saveEdit + quickSave — vorher lag
  // dieser Block in beiden Methoden als Kopie (inkl. der Banner-Objekt-
  // Konstruktion) und driftete bei jeder Änderung auseinander.
  //
  // `silent: true` (quickSave/Autosave) zeigt niemals ein Modal — Pflicht-
  // Invariante #9: ein Hintergrund-Save darf den User nicht unterbrechen.
  //
  // Rückgabe:
  //   { proceed: true, saveHtml, expectedAt, merged? } — Aufrufer speichert saveHtml
  //   { proceed: false } — abgebrochen (Banner/Auflösungs-Modal offen, Draft gesichert)
  async _resolveConflictBeforeSave({ localHtml, source, silent }) {
    const app = editorHost();
    const expectedAt = app.currentPage.updated_at;
    const conflict = await this._checkPageConflict(app.currentPage.id, expectedAt);
    if (!conflict) return { proceed: true, saveHtml: localHtml, expectedAt };

    const merge = await this._attemptBlockMerge({
      localHtml, source,
      remoteHtml: conflict.remoteHtml, remoteUpdatedAt: conflict.remoteUpdatedAt,
    });
    if (merge?.conflict) return { proceed: false }; // Auflösungs-Modal offen
    if (merge?.merged) {
      // Stiller Auto-Merge: nicht-kollidierende Block-Edits zusammengeführt.
      app.editConflict = null;
      return { proceed: true, saveHtml: merge.saveHtml, expectedAt: merge.expectedAt, merged: true };
    }

    // Kein Merge (Flag off / leere Base / Read-Fehler) → klassischer Pfad.
    const banner = this._conflictBannerFrom(conflict);
    app.editConflict = banner;
    if (silent) {
      app.saveOffline = true;
      app.setStatus(this._conflictHintText(banner), false, 8000);
      return { proceed: false };
    }
    const okOverwrite = await app.appConfirm({
      message: conflictText(app.t.bind(app), conflict, 'modal', {
        time: app.formatDate(conflict.remoteUpdatedAt),
      }),
      confirmLabel: app.t('edit.conflict.saveAnyway'),
      danger: true,
    });
    if (!okOverwrite) {
      this._keepAsDraft({ pageId: app.currentPage.id, html: localHtml, statusKey: 'edit.conflict.kept', statusMs: 6000 });
      return { proceed: false };
    }
    if (FEATURE_BLOCK_MERGE) trackMerge('fallback_overwrite');
    // Bewusstes Überschreiben MUSS den frischen Remote-Stempel mitschicken:
    // der OCC-Guard im Backend prüft `WHERE updated_at = expected_updated_at`.
    // Mit dem stale Editor-Stempel würde der PUT erneut 409 liefern und die
    // Entscheidung des Users („trotzdem speichern") wäre wirkungslos.
    return { proceed: true, saveHtml: localHtml, expectedAt: conflict.remoteUpdatedAt };
  },


  // 409-Race NACH dem PUT: zwischen Pre-Check und Write hat jemand geschrieben.
  // Gegen den jetzt frischen Remote-Stand neu block-mergen und den gemergten
  // Stand nachspeichern. SSoT für saveEdit + quickSave + submitConflictResolution.
  //
  // Rückgabe:
  //   { saved, html } — erfolgreich nachgespeichert
  //   { conflict: true } — Auflösungs-Modal offen, Aufrufer bricht ab
  //   null — kein Merge möglich → Aufrufer macht den _keepAsDraft-Fallback
  async _retryAfterConflict({ localHtml, source, pageId, pageName, tag }) {
    const app = editorHost();
    // Vor dem möglichen Öffnen des Auflösungs-Modals zurücksetzen:
    // `submitConflictResolution` bricht bei gesetztem `editSaving` früh ab,
    // der User käme aus dem Modal nicht heraus.
    app.editSaving = false;
    const merge = await this._attemptBlockMerge({ localHtml, source });
    if (merge?.conflict) return { conflict: true };
    if (!merge?.merged) return null;
    try {
      const saved = await savePage(pageId, {
        html: merge.saveHtml, pageName, source, expectedUpdatedAt: merge.expectedAt,
      });
      return { saved, html: merge.saveHtml };
    } catch (e) {
      console.warn(`[${tag}] merged re-save failed`, e);
      return null;
    }
  },

  // Notebook-Einstieg in den geteilten Pre-Save-Conflict-Check
  // (shared/page-conflict.js). Die Prüfung selbst ist eine Eigenschaft der
  // Seite und liegt darum nicht mehr hier — der Bucheditor importiert dieselbe
  // Funktion direkt, statt über die Root-Trampoline in diese Karte zu greifen.
  _checkPageConflict(pageId, expectedUpdatedAt) {
    return checkPageConflict(pageId, expectedUpdatedAt);
  },


  // Block-Level-3-Way-Merge gegen den frischen Remote-Stand. base = originalHtml
  // (zuletzt geladene/gespeicherte Server-Fassung = common ancestor). Liefert
  // { merged, conflicts } oder null → Aufrufer fällt auf klassischen Banner zurück
  // (Flag off, leere Base = frische Page → 2-Way-Fallback, oder Merge wirft).
  _computeBlockMerge(localHtml, remoteHtml) {
    const app = editorHost();
    if (!FEATURE_BLOCK_MERGE) return null;
    const base = app.originalHtml || '';
    if (!base) return null;
    try {
      return mergeBlocks(base, localHtml, remoteHtml);
    } catch (e) {
      console.warn('[blockMerge] compute failed, fallback to classic', e);
      return null;
    }
  },


  // Gemergtes HTML in den Live-Editor spiegeln, damit Folge-Edits auf dem
  // gemergten Stand aufbauen (sonst würde der nächste Save remote-Blöcke
  // wieder „zurückeditieren"). Quelle ist server-sanitiertes Page-HTML (gleiche
  // Vertrauensstufe wie startEdit, das ebenfalls direkt setzt). Cursor springt
  // an den Anfang — akzeptabel, der Pfad läuft nur bei echtem Multi-Device-Konflikt.
  //
  // Läuft über `mountEditorHtml` (dieselbe Pipeline wie startEdit + Undo-Restore):
  // ein gemergtes Block-Set kann auf einer `<hr>` enden oder einen kindlosen
  // `<p>` enthalten — ohne Caret-Slot stünde der User danach ohne Schreib-Anker da.
  _applyMergedToEditor(html) {
    const el = this._getEditEl();
    if (!el || el.innerHTML === html) return;
    mountEditorHtml(el, html);
  },


  // Konflikt-Banner öffnen: kollidierende Blöcke + Auflösungs-State festhalten.
  _openConflictResolution({ merged, conflicts, source, remoteUpdatedAt }) {
    const app = editorHost();
    const decisions = {};
    for (const c of conflicts) decisions[c.bid] = 'local';
    app.conflictResolution = {
      pageId: app.currentPage?.id,
      source,
      merged,
      conflicts,
      remoteUpdatedAt,
      decisions,
    };
    trackMerge('conflict_shown');
  },


  // Konflikt-Orchestrierung: versucht Block-Merge gegen den Remote-Stand.
  // remoteHtml/remoteUpdatedAt können aus _checkPageConflict mitgegeben werden
  // (spart einen fresh-Load); fehlen sie (409-Race), wird frisch geladen.
  // Rückgabe:
  //   { merged:true, saveHtml, expectedAt } — kollisionsfrei, Aufrufer speichert saveHtml.
  //   { conflict:true } — Auflösungs-Banner geöffnet, Aufrufer bricht ab.
  //   null — kein Merge (Flag off / leere Base / Read-Fehler) → klassischer Pfad.
  async _attemptBlockMerge({ localHtml, source, remoteHtml = null, remoteUpdatedAt = null }) {
    const app = editorHost();
    if (!FEATURE_BLOCK_MERGE || !app.currentPage) return null;
    if (remoteHtml === null || remoteUpdatedAt === null) {
      try {
        const remote = await contentRepo.loadPage(app.currentPage.id, { fresh: true });
        remoteHtml = remote?.html || '';
        remoteUpdatedAt = remote?.updated_at || null;
      } catch { return null; }
    }
    if (!remoteUpdatedAt) return null;
    const m = this._computeBlockMerge(localHtml, remoteHtml);
    if (!m) return null;
    if (m.conflicts.length === 0) {
      const saveHtml = mergedToHtml(m.merged);
      this._applyMergedToEditor(saveHtml);
      trackMerge('silent_success');
      return { merged: true, saveHtml, expectedAt: remoteUpdatedAt };
    }
    // Draft sichern, aber ohne Status-Zeile — das Auflösungs-Modal ist der
    // sichtbare Hinweis, ein zweiter Toast daneben wäre Rauschen.
    this._keepAsDraft({ pageId: app.currentPage.id, html: localHtml, statusKey: null });
    this._openConflictResolution({ merged: m.merged, conflicts: m.conflicts, source, remoteUpdatedAt });
    return { conflict: true };
  },


  // Auflösungs-Entscheidung pro Block (UI). choice: 'local'|'remote'|'both'.
  resolveBlock(bid, choice) {
    const app = editorHost();
    if (!app.conflictResolution) return;
    app.conflictResolution.decisions[bid] = choice;
  },


  // Bulk: alle Konflikte auf eine Seite setzen.
  resolveAllConflicts(choice) {
    const app = editorHost();
    if (!app.conflictResolution) return;
    for (const c of app.conflictResolution.conflicts) {
      app.conflictResolution.decisions[c.bid] = choice;
    }
  },


  // Auflösung übernehmen: finales HTML aus merged + decisions bauen und mit
  // expected_updated_at = remoteUpdatedAt speichern.
  async submitConflictResolution() {
    const app = editorHost();
    const cr = app.conflictResolution;
    if (!cr || app.editSaving) return;
    const finalHtml = buildResolvedHtml(cr.merged, cr.decisions);
    const source = cr.source || (app.focusActive ? 'focus' : 'main');
    app.editSaving = true;
    app.setStatus(app.t('edit.saving'), true);
    try {
      const saved = await savePage(cr.pageId, {
        html: finalHtml,
        pageName: app.currentPage?.name,
        source,
        expectedUpdatedAt: cr.remoteUpdatedAt,
      });
      this._applySaveSuccess(saved, finalHtml, { pageId: cr.pageId, applyToEditor: true });
      trackMerge('conflict_resolved', { mix: this._resolutionMix(cr) });
      app.conflictResolution = null;
      app.setStatus('');
    } catch (e) {
      if (isPageConflict(e)) {
        // Dritter Schreibvorgang zwischen Konflikt-Anzeige und „Auflösung
        // übernehmen": der finale PUT (expected = cr.remoteUpdatedAt) trifft
        // erneut 409. Statt Sackgasse (User klickt immer in denselben 409) die
        // lokal aufgelöste Fassung gegen den jetzt frischen Remote-Stand neu
        // block-mergen — gemeinsamer Pfad mit saveEdit/quickSave, nur mit
        // finalHtml als lokaler Quelle (= die gerade getroffene Auflösung).
        const retry = await this._retryAfterConflict({
          localHtml: finalHtml, source, pageId: cr.pageId,
          pageName: app.currentPage?.name, tag: 'submitConflictResolution',
        });
        // _openConflictResolution hat den conflictResolution-State auf den neuen
        // Remote-Stand ersetzt → User löst die neue Kollision auf.
        if (retry?.conflict) return;
        if (retry) {
          this._applySaveSuccess(retry.saved, retry.html, { pageId: cr.pageId, applyToEditor: true });
          trackMerge('conflict_resolved', { mix: this._resolutionMix(cr) });
          app.conflictResolution = null;
          app.setStatus(app.t('edit.conflict.merged.silent'), false, 3000);
          return;
        }
        // Fallback (kein Merge: Flag off / leere Base / Read-Fehler): die
        // aufgelöste Arbeit als Draft sichern, Offline-/Konflikt-Banner zeigen.
        // conflictResolution bleibt offen — User kann erneut übernehmen/abbrechen.
        this._keepAsDraft({ pageId: cr.pageId, html: finalHtml, banner: readConflictBody(e) });
        return;
      }
      console.error('[submitConflictResolution]', e);
      app.setStatus(app.t('edit.saveFailed', { msg: e.message }), false, 8000);
    } finally {
      app.editSaving = false;
    }
  },


  // Auflösungs-Mix (Meine/Andere/Beide) für Telemetrie aus dem
  // conflictResolution-State zählen.
  _resolutionMix(cr) {
    const mix = { local: 0, remote: 0, both: 0 };
    for (const c of cr.conflicts) {
      const choice = cr.decisions[c.bid] || 'local';
      if (mix[choice] != null) mix[choice]++;
    }
    return mix;
  },


  // Auflösung abbrechen: Konflikt-State verwerfen, frischen Server-Stand laden.
  // Lokale Edits bleiben als Page-Revision/Draft erhalten (Last-Resort).
  async cancelConflictResolution() {
    const app = editorHost();
    const cr = app.conflictResolution;
    app.conflictResolution = null;
    app.editConflict = null;
    if (!cr?.pageId) return;
    try {
      const remote = await contentRepo.loadPage(cr.pageId, { fresh: true });
      if (remote?.html != null) {
        this._applyMergedToEditor(remote.html);
        app.originalHtml = remote.html;
        if (remote.updated_at) app.currentPage.updated_at = remote.updated_at;
        app.editDirty = false;
        app.saveOffline = false;
        app.updatePageView?.();
      }
    } catch (e) {
      console.warn('[cancelConflictResolution] reload failed', e);
    }
  },
};
