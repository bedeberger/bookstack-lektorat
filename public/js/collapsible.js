// Alpine.data('collapsible') — wiederverwendbare klappbare Sektion.
//
// SSoT für das DESIGN.md-Pattern `.collapsible-toggle` + `.history-chevron`.
// Besitzt den Open-State, die Toggle-Logik, die ARIA-Kopplung und die
// Chevron-Rotation — Konsumenten verdrahten nichts mehr von Hand.
//
// Pflicht-Markup (3 x-bind-Spreads):
//   <div x-data="collapsible()">                          <!-- collapsible(true) für initial offen -->
//     <button type="button" class="collapsible-toggle" x-bind="trigger">
//       <span class="history-chevron" x-bind="chevron" aria-hidden="true"></span>
//       <span x-text="label"></span>
//     </button>
//     <div x-bind="panel" x-cloak> … </div>
//   </div>
//
// Geteilter / persistierter State (Parent steuert open): zusätzlich
//   x-modelable="open" x-model="parentVar"
// koppeln — analog combobox/numInput.
//
// Der `.history-chevron`-Span braucht KEINEN Inhalt (CSS-Mask-Icon, rotiert via
// `.open`); `aria-hidden` setzen, Label kommt als separates Geschwister.
//
// Das Panel animiert seine Höhe über `x-collapse` (@alpinejs/collapse, geladen
// in index.html vor dem Alpine-Core) — die Direktive reist im `panel`-Spread
// mit, Konsumenten-Markup bleibt unverändert. Zwei Folgen, die man wissen muss:
//   1) Das Plugin hält `overflow: hidden` auf dem Panel. Absolut positionierte
//      Kinder (Kebab-Menüs, Popover) würden darin abgeschnitten — die gehören
//      ohnehin per x-teleport in den Top-Layer (Architektur-Regel), nicht ins
//      Panel.
//   2) Reduced-Motion braucht hier KEINEN Sonderfall: der globale Override in
//      css/tokens/motion.css setzt `transition-duration: 0s !important`, und
//      Alpines Transition-Helper liest die berechnete Dauer → klappt instant.

export function registerCollapsible() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('collapsible', (initialOpen = false) => ({
    open: !!initialOpen,

    toggle() { this.open = !this.open; },

    // Spread auf das Trigger-<button>.
    get trigger() {
      return {
        type: 'button',
        ['@click']: () => { this.toggle(); },
        [':aria-expanded']: () => this.open,
      };
    },

    // Spread auf den <span class="history-chevron">.
    get chevron() {
      return { [':class']: () => ({ open: this.open }) };
    },

    // Spread auf das aufklappbare Panel. `x-collapse` animiert die Höhe; die
    // Direktive funktioniert im x-bind-Objekt inklusive Modifier-Suffix
    // (`x-collapse.duration.200ms`), falls eine Sektion mal langsamer klappen
    // soll — dann hier nicht global drehen, sondern beim Konsumenten das Panel
    // von Hand verdrahten.
    get panel() {
      return { ['x-show']: () => this.open, ['x-collapse']: () => '' };
    },
  }));
}
