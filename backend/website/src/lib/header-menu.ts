/** Disclosure menus stay open while focus moves inside, and close on dismissal. */
export function bindHeaderMenus(root: Document) {
  const menus = [...root.querySelectorAll<HTMLDetailsElement>('.language-menu, .mobile-nav')];
  function closeOutside(target: EventTarget | null) {
    for (const menu of menus) {
      if (menu.open && !(target instanceof Node && menu.contains(target))) menu.open = false;
    }
  }
  root.addEventListener('pointerdown', event => closeOutside(event.target));
  root.addEventListener('focusin', event => closeOutside(event.target));
  for (const menu of menus) {
    menu.addEventListener('focusout', event => {
      if (!menu.contains(event.relatedTarget as Node | null)) menu.open = false;
    });
    menu.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !menu.open) return;
      event.preventDefault();
      menu.open = false;
      menu.querySelector('summary')?.focus({ preventScroll: true });
    });
  }
}
