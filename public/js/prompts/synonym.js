// Synonym-Suche (Kontextmenü im Editor). System-Prompt-Bau lebt in core.js
// (buildSystemSynonym), hier nur User-Prompt-Builder + Schema.

import { _obj, _str } from './schema-utils.js';

export function buildSynonymPrompt(wort, satz) {
  return `Schlage bis zu 11 Synonyme für das Wort «${wort}» vor, die im gegebenen Satzkontext passen. Nur einzelne Ersatzwörter, keine Umschreibungen oder Satzumbauten.

Regeln:
- Exakt gleiche Wortart und grammatische Form (Kasus, Numerus, Tempus, Geschlecht) wie das Originalwort im Satz
- Bedeutung im Kontext muss erhalten bleiben
- Stil, Ton und Register des Autors berücksichtigen
- Keine offensichtlich unpassenden oder weit entfernten Begriffe
- Duplikate und das Originalwort selbst vermeiden

Antworte mit diesem JSON-Schema:
{
  "synonyme": [
    { "wort": "das Ersatzwort", "hinweis": "kurze Note zu Register/Konnotation, z.B. «gehoben», «umgangssprachlich», «stärker» – darf leer sein" }
  ]
}

Satz: ${satz}
Wort: ${wort}`;
}

export const SCHEMA_SYNONYM = _obj({
  synonyme: {
    type: 'array',
    items: _obj({ wort: _str, hinweis: _str }),
  },
});
