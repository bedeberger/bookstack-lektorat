// Konstanten + Helper für Figurengraph/Familie/Soziogramm.
// Wird von allen Render-Pfaden geteilt. SSoT für sämtliche Graph-Farben:
// Schicht- und Typ-Paletten leben ausschliesslich hier, die Render-Slices
// importieren nur noch.

export const DEFAULT_FONT = { size: 13, face: 'system-ui, -apple-system, sans-serif' };

// Node-Label aus einer Figur: Kurzname + optionales Geburtsdatum in zweiter Zeile.
export const nodeLabel = f => (f.kurzname || f.name) + (f.geburtstag ? '\n* ' + f.geburtstag : '');

// ── Sozialschicht-Palette (Schweiz, Mittelland, 1990er–2010er) ───────────────
// Jeder Eintrag hält alle Schicht-Visuals an einer Stelle:
//   background/border/highlight → vis-Node-Farbe
//   font                        → optionaler Node-Font (heller Text auf dunklem Band)
//   band                        → halbtransparenter Hintergrund-Streifen im Soziogramm
//   label                       → Textfarbe des Schicht-Labels links
export const SCHICHT_COLOR = {
  wirtschaftselite:    { background: '#FFF3CC', border: '#A07800', highlight: { background: '#FFE566', border: '#7A5A00' },
                         band: 'rgba(255,243,204,0.40)', label: '#8B6A00' },
  gehobenes_buergertum:{ background: '#D4E8FF', border: '#2d6a9f', highlight: { background: '#BDD8FF', border: '#1d4b73' },
                         band: 'rgba(212,232,255,0.35)', label: '#1d4b73' },
  mittelschicht:       { background: '#E8F4E8', border: '#3a7a3a', highlight: { background: '#D0EBD0', border: '#275927' },
                         band: 'rgba(232,244,232,0.35)', label: '#275927' },
  arbeiterschicht:     { background: '#F5EAD4', border: '#8B5E26', highlight: { background: '#EDD9A8', border: '#6B3F0D' },
                         band: 'rgba(245,234,212,0.38)', label: '#6B3F0D' },
  migrantenmilieu:     { background: '#FDEBD0', border: '#C0602A', highlight: { background: '#FAD5A8', border: '#9A4010' },
                         band: 'rgba(253,235,208,0.40)', label: '#9A4010' },
  prekariat:           { background: '#F5EDED', border: '#8B3A3A', highlight: { background: '#EDD5D5', border: '#6B1A1A' },
                         band: 'rgba(245,237,237,0.40)', label: '#6B1A1A' },
  unterwelt:           { background: '#3A3A3A', border: '#111',    highlight: { background: '#505050', border: '#000' },
                         font: { ...DEFAULT_FONT, color: '#fff' },
                         band: 'rgba(40,40,40,0.22)', label: '#333' },
  andere:              { background: '#FFF5DC', border: '#c4a55a', highlight: { background: '#FFEEBB', border: '#8a6a20' },
                         band: 'rgba(255,245,220,0.25)', label: '#888' },
};

// Vertikale Ebene pro Schicht (0 = oben)
export const SCHICHT_LEVEL = {
  wirtschaftselite:    0,
  gehobenes_buergertum:1,
  mittelschicht:       2,
  arbeiterschicht:     3,
  migrantenmilieu:     4,
  prekariat:           5,
  unterwelt:           6,
  andere:              2,
};

// ── Figurentyp-Palette ────────────────────────────────────────────────────────
// TYP_COLOR = vis-Node-Füllung (background/border/highlight).
export const TYP_COLOR = {
  hauptfigur:  { background: '#D4E8FF', border: '#2d6a9f', highlight: { background: '#BDD8FF', border: '#1d4b73' } },
  nebenfigur:  { background: '#F0F0F0', border: '#888',    highlight: { background: '#E4E4E4', border: '#555' } },
  antagonist:  { background: '#FFE0E0', border: '#E24B4A', highlight: { background: '#FFC7C7', border: '#B03030' } },
  mentor:      { background: '#EAF3DE', border: '#639922', highlight: { background: '#D5EBBD', border: '#3B6D11' } },
  randfigur:   { background: '#F7F7F7', border: '#BBB',    highlight: { background: '#EDEDED', border: '#999' } },
  andere:      { background: '#FFF5DC', border: '#c4a55a', highlight: { background: '#FFEEBB', border: '#8a6a20' } },
};
// TIER_COLOR = Text-/Akzentfarbe (Tier-Label + Presence-Bar im Figurengraph).
// Bewusst eigenständig: neben-/randfigur nutzen dunklere Werte als die Node-Border,
// damit Label und Balken auf hellem Grund genug Kontrast haben.
export const TIER_COLOR = {
  hauptfigur: '#2d6a9f', antagonist: '#E24B4A', mentor: '#639922',
  nebenfigur: '#666',    randfigur:  '#999',    andere: '#c4a55a',
};

// ── Beziehungstyp-Styling (Figurengraph) ─────────────────────────────────────
export const BZ = {
  elternteil:      { color: '#888',    highlight: '#555',    arrows: 'to',   dashes: false },
  kind:            { color: '#888',    highlight: '#555',    arrows: 'from', dashes: false },
  geschwister:     { color: '#2d6a9f', highlight: '#1d4b73', arrows: '',     dashes: [5,5] },
  freund:          { color: '#639922', highlight: '#3B6D11', arrows: '',     dashes: [4,3] },
  feind:           { color: '#E24B4A', highlight: '#B03030', arrows: '',     dashes: [4,3] },
  kollege:         { color: '#c4a55a', highlight: '#8a6a20', arrows: '',     dashes: [4,3] },
  bekannt:         { color: '#999',    highlight: '#555',    arrows: '',     dashes: [4,3] },
  liebesbeziehung: { color: '#D46EA0', highlight: '#A0446E', arrows: '',     dashes: [4,3] },
  ehepartner:      { color: '#D46EA0', highlight: '#A0446E', arrows: '',     dashes: false },
  ex_partner:      { color: '#C98AB0', highlight: '#A0446E', arrows: '',     dashes: [2,3] },
  rivale:          { color: '#9B4B00', highlight: '#6B3000', arrows: '',     dashes: [4,3] },
  mentor:          { color: '#2d6a9f', highlight: '#1d4b73', arrows: 'to',   dashes: [4,3] },
  schuetzling:     { color: '#2d6a9f', highlight: '#1d4b73', arrows: 'from', dashes: [4,3] },
  patronage:       { color: '#7B3FA0', highlight: '#5A1F80', arrows: 'to',   dashes: false },
  vorgesetzter:    { color: '#7B3FA0', highlight: '#5A1F80', arrows: 'to',   dashes: [4,3] },
  untergebener:    { color: '#7B3FA0', highlight: '#5A1F80', arrows: 'from', dashes: [4,3] },
  geschaeft:       { color: '#B8860B', highlight: '#7A5A00', arrows: '',     dashes: [6,3] },
  komplize:        { color: '#B8860B', highlight: '#7A5A00', arrows: '',     dashes: [2,2] },
  verbuendete:     { color: '#639922', highlight: '#3B6D11', arrows: '',     dashes: [6,3] },
  andere:          { color: '#bbb',    highlight: '#888',    arrows: '',     dashes: [4,3] },
};

// ── Beziehungskategorie-Farben (Soziogramm) ───────────────────────────────────
export const BZ_SOZIO_COLOR = {
  familie:  '#888',
  macht:    '#7B3FA0',
  konflikt: '#E24B4A',
  geschaeft:'#B8860B',
  liebe:    '#D46EA0',
  sozial:   '#639922',
};
export const BZ_SOZIO_CAT = {
  elternteil: 'familie', kind: 'familie', geschwister: 'familie',
  patronage: 'macht',  mentor: 'macht', schuetzling: 'macht', vorgesetzter: 'macht', untergebener: 'macht',
  feind: 'konflikt', rivale: 'konflikt',
  geschaeft: 'geschaeft', kollege: 'geschaeft', komplize: 'geschaeft',
  liebesbeziehung: 'liebe', ehepartner: 'liebe', ex_partner: 'liebe',
  freund: 'sozial', bekannt: 'sozial', verbuendete: 'sozial', andere: 'sozial',
};

// Typen mit fester Pfeilrichtung im Standardgraph
export const DIRECTED_TYPES = ['elternteil', 'kind', 'mentor', 'schuetzling', 'patronage', 'vorgesetzter', 'untergebener'];

// ── Reiter der Figuren-Karte: welche zeichnen ein Netz? ──────────────────────
// `figurenGraphModus` steuert sechs Reiter, aber nur drei davon rendern ein
// vis-network; die uebrigen (praesenz/alter/lebenslauf) sind reine DOM-Ansichten
// in eigenen Partials. SSoT, weil die Liste doppelt gefuehrt wurde (Render-
// Dispatcher UND x-show im Partial) und ein spaeter dazugekommener Reiter nur in
// einer der beiden Listen landete: der Dispatcher lud dann das vis-Bundle nach
// und zeichnete ein vollstaendiges Netz in einen ausgeblendeten Container.
// Neuer Reiter ⇒ hier entscheiden, nicht an den Verwendungsstellen.
export const GRAPH_MODES = ['figur', 'familie', 'soziogramm'];
export const isGraphMode = (mode) => GRAPH_MODES.includes(mode);
