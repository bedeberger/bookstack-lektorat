// Facade: bookSettingsMethods aus thematischen Submodulen in book-settings/.
// Submodul-Aufteilung nach Domäne; Methoden teilen sich zur Laufzeit ein
// gemeinsames `this` (in das Objekt gespreadet). Geteilte Imports/Konstanten
// in book-settings/_shared.js.
import { settingsMethods } from './book-settings/settings.js';
import { citationMethods } from './book-settings/citation.js';
import { adminMethods } from './book-settings/admin.js';
import { accessMethods } from './book-settings/access.js';
import { blogMethods } from './book-settings/blog.js';
import { hubspotMethods } from './book-settings/hubspot.js';
import { mergeMethods } from './book-settings/merge.js';

export const bookSettingsMethods = {
  ...settingsMethods,
  ...citationMethods,
  ...adminMethods,
  ...accessMethods,
  ...blogMethods,
  ...hubspotMethods,
  ...mergeMethods,
};
