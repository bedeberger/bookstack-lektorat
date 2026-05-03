// Wiederverwendbare Regel-Blöcke für Lektorat- und Review-Prompts.
// Pure Funktionen – keine Modul-State-Abhängigkeiten.

export function _buildStilBlock() {
  return `
Stil-Regeln (typ: «stil»):
- Nur melden, falls das Problem nicht bereits als anderer Typ (wiederholung, grammatik, rechtschreibung) erfasst wurde
- PFLICHT: «korrektur» muss immer eine konkrete Umformulierung enthalten – nicht leer lassen, nicht dasselbe wie «original». Keine Stilanmerkung ohne konkreten Verbesserungsvorschlag.`;
}

// sw: explizite Stoppwort-Liste; Caller muss sie übergeben (kein globaler Fallback).
export function _buildWiederholungBlock(sw = []) {
  const swNote = sw.length > 0
    ? `\n- Stoppwörter nie melden (auch flektierte Formen): ${sw.join(', ')}`
    : '';
  return `
Wiederholung-Regeln (typ: «wiederholung»):
- Nur Inhaltswörter, die auffällig oft vorkommen: mind. 3× auf der gesamten Seite ODER 2× im selben oder direkt aufeinanderfolgenden Absatz
- Keine Pronomen, Hilfsverben, Artikel, Konjunktionen, Präpositionen, Eigennamen${swNote}
- «original»: vollständiger Satz zeichengenau aus dem Text (damit die Textstelle eindeutig auffindbar ist)
- «korrektur»: derselbe Satz mit dem besten Synonym – exakt gleiche grammatische Form (Kasus, Numerus, Tempus)
- Synonym-Selbsttest vor jedem Eintrag: Klingt der Satz danach natürlich? Bedeutung erhalten? Passt zum Autorenstil?`;
}

export function _buildSchwacheVerbenBlock() {
  return `
Schwache-Verben-Regeln (typ: «schwaches_verb»):
- Schwache, blasse oder nichtssagende Verben identifizieren
- Typische schwache Verben: machen, tun, sein, haben, geben, gehen, kommen, bringen, stehen, liegen, sagen, meinen, finden u.ä.
- Nur melden, wenn ein ausdrucksstärkeres Verb den Satz spürbar verbessert — keine Pedanterie bei idiomatischen Wendungen oder Hilfsverb-Konstruktionen
- «original»: vollständiger Satz zeichengenau aus dem Text (damit die Textstelle eindeutig auffindbar ist)
- «korrektur»: derselbe Satz mit dem stärkeren Verb — exakt gleiche grammatische Form und Tempus
- Selbsttest vor jedem Eintrag: Ist das Ersatzverb wirklich präziser und bildstärker? Passt es zum Stil und Ton des Textes?`;
}

export function _buildFuellwortBlock() {
  return `
Füllwort-Regeln (typ: «fuellwort»):
- Überflüssige Füllwörter identifizieren, die den Text verwässern
- Typische Füllwörter: eigentlich, irgendwie, quasi, halt, eben, wohl, ja, doch, mal, nun, also, natürlich, gewissermassen, sozusagen, durchaus, ziemlich, etwas, ein wenig, ein bisschen u.ä.
- Nur melden, wenn das Streichen oder Ersetzen den Satz strafft, ohne Bedeutung oder Stimme zu verlieren — in Dialogen können Füllwörter bewusst eingesetzt sein
- «original»: vollständiger Satz zeichengenau aus dem Text
- «korrektur»: derselbe Satz ohne das Füllwort (oder mit knapperer Formulierung)
- Selbsttest: Verliert der Satz durch die Streichung an Rhythmus, Stimme oder Bedeutungsnuance? Dann weglassen.`;
}

export function _buildShowVsTellBlock() {
  return `
Show-vs-Tell-Regeln (typ: «show_vs_tell»):
- Stellen identifizieren, an denen Emotionen, Eigenschaften oder Zustände abstrakt benannt statt szenisch gezeigt werden
- Typische Muster: «Er war wütend», «Sie fühlte sich traurig», «Das Haus war alt», «Er war nervös»
- «original»: vollständiger Satz zeichengenau aus dem Text
- «korrektur»: derselbe Satz umformuliert mit konkreten Sinneseindrücken, Handlungen oder Details, die das Gleiche zeigen
- Nur melden, wenn eine szenische Darstellung den Text spürbar lebendiger macht — nicht jede abstrakte Aussage muss umgeschrieben werden (z.B. in Zusammenfassungen, Rückblenden oder schnellen Übergängen ist Telling erlaubt)
- Selbsttest: Passt die szenische Variante zum Erzähltempo und zur Szene? Nicht aufblähen.`;
}

export function _buildPassivBlock() {
  return `
Passivkonstruktionen-Regeln (typ: «passiv»):
- Vermeidbare Passivkonstruktionen identifizieren, die den Text schwerfällig oder unpersönlich machen
- «original»: vollständiger Satz zeichengenau aus dem Text
- «korrektur»: derselbe Satz in aktiver Formulierung — das handelnde Subjekt klar benennen
- Nicht melden, wenn das Passiv bewusst eingesetzt wird (Täter unbekannt/unwichtig, wissenschaftlicher Stil, Betonung auf dem Objekt) oder die aktive Variante gezwungen klingt
- Selbsttest: Ist die aktive Formulierung wirklich klarer und lebendiger? Klingt sie natürlich im Kontext?`;
}

export function _buildPerspektivbruchBlock() {
  return `
Perspektivbruch-Regeln (typ: «perspektivbruch»):
- Stellen identifizieren, an denen die Erzählperspektive innerhalb einer Szene unbeabsichtigt wechselt
- Typische Brüche: Wissen oder Gedanken einer Figur beschreiben, die nicht die aktuelle Perspektivfigur ist; plötzlicher Wechsel zwischen Ich-Erzähler und auktorialem Erzähler; Informationen, die der Perspektivfigur nicht zugänglich sind
- «original»: vollständiger Satz zeichengenau aus dem Text
- «korrektur»: derselbe Satz so umformuliert, dass er zur etablierten Perspektive der Szene passt
- «erklaerung»: benennen, welche Perspektive etabliert ist und worin der Bruch besteht
- Nicht melden bei bewusst auktorialer Erzählweise oder bei expliziten Perspektivwechseln (z.B. nach Szenenumbruch)`;
}

export function _buildTempuswechselBlock() {
  return `
Tempuswechsel-Regeln (typ: «tempuswechsel»):
- Unbeabsichtigte Wechsel der Erzählzeit innerhalb einer Szene oder eines Abschnitts identifizieren
- Typisch: Erzählung im Präteritum mit plötzlichem Wechsel ins Präsens (oder umgekehrt), ohne dass ein Stilmittel erkennbar ist
- «original»: vollständiger Satz zeichengenau aus dem Text
- «korrektur»: derselbe Satz im korrekten Tempus der umgebenden Passage
- «erklaerung»: benennen, welches Tempus in der Passage etabliert ist und welches im Satz verwendet wird
- Nicht melden bei: Plusquamperfekt für Rückblenden, historischem Präsens als bewusstem Stilmittel, Tempuswechsel in direkter Rede, Wechsel an Szenen-/Kapitelgrenzen`;
}

/**
 * Erzeugt den Erzählform-Kontextblock für Bewertungs-/Lektorat-Prompts.
 * Bei buchtyp='kurzgeschichten' wird die Angabe als Richtwert deklariert, da
 * einzelne Kurzgeschichten legitim eine andere Perspektive oder Erzählzeit
 * verwenden können. Gibt '' zurück, wenn weder perspektive noch zeit gesetzt
 * sind (kein Block im Prompt).
 *
 * @param {string|null} perspektive  lesbares Label (z.B. '3. Person personal')
 * @param {string|null} zeit         lesbares Label (z.B. 'Präteritum')
 * @param {string|null} buchtyp      Buchtyp-Key (z.B. 'kurzgeschichten')
 * @param {'lektorat'|'review'} mode 'lektorat' verweist auf perspektivbruch/tempuswechsel;
 *                                   'review' bleibt neutraler ("Konsistenzprüfung")
 */
export function _buildErzaehlformBlock(perspektive, zeit, buchtyp, mode = 'lektorat') {
  if (!perspektive && !zeit) return '';
  const isShortStories = buchtyp === 'kurzgeschichten';
  const header = isShortStories
    ? 'Erzählform der Sammlung (Richtwert – einzelne Kurzgeschichten dürfen legitim abweichen; Abweichungen NICHT als Fehler melden, wenn sie in sich konsistent bleiben):'
    : (mode === 'review'
      ? 'Etablierte Erzählform des Buchs (Referenz für Konsistenz- und Stilprüfung – abweichende Passagen sind Bruchstellen, sofern nicht dramaturgisch begründet):'
      : 'Etablierte Erzählform des Buchs (verbindliche Referenz für «perspektivbruch» und «tempuswechsel» – abweichende Stellen gegen diese Vorgabe prüfen, nicht gegen Default-Annahmen):');
  const lines = [
    perspektive ? `- Erzählperspektive: ${perspektive}` : null,
    zeit        ? `- Erzählzeit: ${zeit}`              : null,
  ].filter(Boolean);
  const scopeNote = `- Gilt NUR für den narrativen Erzähltext. KEIN Bruch ist in folgenden Fällen: direkte Rede / Dialog (Figuren sprechen in ihrer eigenen Zeit), innere Monologe in direkter Form, zitierte Briefe / Tagebuch­einträge / Nachrichten / Dokumente im Roman, erlebte Rede, historisches Präsens als bewusstes Stilmittel, Rückblenden (Plusquamperfekt) und Antizipationen (Futur), sowie Wechsel an Szenen-/Kapitelgrenzen.`;
  return `\n${header}\n${lines.join('\n')}\n${scopeNote}\n`;
}
