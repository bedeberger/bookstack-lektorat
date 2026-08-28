// Geteilte Konstanten der Motiv-Werkstatt.

// Kuratierte Typen der gerichteten Motiv-zu-Motiv-Beziehungen (from --typ--> to).
// `typ` ist serverseitig Freitext (analog figure_relations/plot_beat_relations);
// dies ist die im Frontend angebotene Auswahl. Zwei Familien: Gleichlauf
// (verstaerkt/spiegelt/bedingt) + Spannung (kontrastiert/bricht/verdraengt) —
// die Familien-Zuordnung und ihre Auswertung liegen serverseitig in
// lib/motif-consistency.js, hier stehen nur die stabilen Schluessel + Reihenfolge.
// Labels via i18n (motiv.relation.type.<typ>). Die Schluessel sind Persistenz-
// Konstanten (motif_relations.typ): ergaenzen ja, umbenennen nein — sonst zeigen
// Alt-Kanten ihren rohen Schluessel.
// Drift zwischen dieser Liste und der Familien-Tabelle des Servers ist durch
// tests/unit/motif-consistency.test.mjs gegated.
export const MOTIF_REL_TYPES = ['verstaerkt', 'spiegelt', 'bedingt', 'kontrastiert', 'bricht', 'verdraengt'];
