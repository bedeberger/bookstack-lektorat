// Teil von notebookEditMethods (siehe Facade edit.js).
import { FEATURE_BLOCK_MERGE, buildResolvedHtml, contentRepo, editorHost, isPageConflict, mergeBlocks, mergedToHtml, readConflictBody, savePage, trackMerge, writeDraft } from './_shared.js';

export const conflictMethods = {

  // Text des Konflikt-Banners. Eigenes Zweit-Gerät (Mac-Client, zweiter Laptop,
  // Android) nennt das Gerät statt eines Usernamens — sonst liest ein Solo-Autor
  // seinen eigenen Namen als „fremder Bearbeiter".
  editConflictBannerText() {
    const app = editorHost();
    const c = app?.editConflict;
    if (!c) return '';
    const time = c.remoteUpdatedAt ? app.formatDate(c.remoteUpdatedAt) : '';
    return c.remoteIsSelf
      ? app.t('edit.conflict.bannerSelf', { device: c.remoteDevice || app.t('presence.device.unknown'), time })
      : app.t('edit.conflict.banner', { user: c.remoteUserName || app.t('edit.conflict.unknownUser'), time });
  },

  // Pre-Save-Conflict-Check für Read-Modify-Write-Pfade. Vor PUT die Seite
  // frisch lesen und `updated_at` mit Editor-Snapshot vergleichen; Mismatch =
  // anderer User hat zwischendrin gespeichert. Liefert null bei keiner
  // Diskrepanz, sonst { remoteUpdatedAt, remoteUserName, remoteHtml }.
  // Wirft nicht — Aufrufer entscheidet bei Read-Fehler.
  async _checkPageConflict(pageId, expectedUpdatedAt) {
    if (!expectedUpdatedAt) return null;
    // Offline kann es keinen Cross-User-Konflikt geben — der ohnehin folgende
    // PUT wird ebenfalls scheitern und in den Offline-Banner-Pfad fallen. Modal
    // hier zu zeigen wäre irreführend (kein verlässlicher Server-Stand).
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return null;
    let remote;
    try {
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
  _applyMergedToEditor(html) {
    const el = this._getEditEl();
    if (el && el.innerHTML !== html) el.innerHTML = html;
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
    const draftOk = writeDraft(app.currentPage.id, localHtml, app.originalHtml, app.currentPage.updated_at);
    app.draftPersistFailed = !draftOk;
    if (draftOk) app.lastDraftSavedAt = Date.now();
    app.saveOffline = true;
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
        // block-mergen — analog zum 409-Pfad in saveEdit, nur mit finalHtml als
        // lokaler Quelle (= die gerade getroffene Auflösung).
        app.editSaving = false;
        const merge = await this._attemptBlockMerge({ localHtml: finalHtml, source });
        // _openConflictResolution hat den conflictResolution-State auf den neuen
        // Remote-Stand ersetzt → User löst die neue Kollision auf.
        if (merge?.conflict) return;
        if (merge?.merged) {
          // Kollisionsfrei gegen den neuen Stand: gemergte Auflösung nachspeichern.
          try {
            const saved = await savePage(cr.pageId, {
              html: merge.saveHtml, pageName: app.currentPage?.name, source,
              expectedUpdatedAt: merge.expectedAt,
            });
            this._applySaveSuccess(saved, merge.saveHtml, { pageId: cr.pageId, applyToEditor: true });
            trackMerge('conflict_resolved', { mix: this._resolutionMix(cr) });
            app.conflictResolution = null;
            app.setStatus(app.t('edit.conflict.merged.silent'), false, 3000);
            return;
          } catch (e2) { console.warn('[submitConflictResolution] merged re-save failed', e2); }
        }
        // Fallback (Merge null: Flag off / leere Base / Read-Fehler): die
        // aufgelöste Arbeit als Draft sichern, Offline-/Konflikt-Banner zeigen.
        // conflictResolution bleibt offen — User kann erneut übernehmen/abbrechen.
        const draftOk = writeDraft(cr.pageId, finalHtml, app.originalHtml, app.currentPage?.updated_at);
        app.draftPersistFailed = !draftOk;
        if (draftOk) app.lastDraftSavedAt = Date.now();
        app.saveOffline = true;
        app.editConflict = readConflictBody(e);
        app.setStatus(app.t('edit.conflict.kept'), false, 8000);
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
