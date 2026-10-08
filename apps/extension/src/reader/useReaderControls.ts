import {useEffect, useRef, useState} from 'react';
import {msg} from '../i18n/runtime';
import {hasShortcutOverlay} from '../shortcuts/runtime';

/** Reader chrome owns interaction state, never image windows or document locations. */
export function useReaderControls<Panel extends string>({blocked, notify}: {
  blocked: boolean;
  notify(message: string): void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [panel, setPanel] = useState<Panel>();
  const [immersive, setImmersive] = useState(false);
  const [hidden, setHidden] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function reveal() {
    setHidden(false);
    clearTimeout(hideTimer.current);
    if (immersive && !panel && !blocked) {
      hideTimer.current = setTimeout(() => {
        // Mouse-restored button focus must not pin the tools open. Keyboard
        // focus and editable controls stay visible until focus leaves them.
        if (!root.current?.querySelector('.nc-reader-controls :focus-visible')) setHidden(true);
      }, 1200);
    }
  }

  function togglePanel(next: Panel) {
    setPanel(value => value === next ? undefined : next);
  }

  function closePanel() {
    setPanel(undefined);
    const selector = panel === 'directory' ? '[data-reader-directory-trigger]'
      : panel === 'translation' ? '.nc-translation-trigger' : '[data-reader-settings-trigger]';
    root.current?.querySelector<HTMLButtonElement>(selector)?.focus({preventScroll: true});
  }

  async function fullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      notify(msg('此浏览器暂时无法进入全屏。'));
    }
  }

  useEffect(() => {
    reveal();
    return () => clearTimeout(hideTimer.current);
  }, [immersive, panel, blocked]);
  useEffect(() => {
    if (!panel) return;
    if (panel !== 'translation') {
      root.current?.querySelector<HTMLButtonElement>('.nc-reader-drawer .nc-drawer-title button')?.focus({preventScroll: true});
      return;
    }
    const bubble = root.current?.querySelector<HTMLElement>('.nc-translation-popover');
    const trigger = root.current?.querySelector<HTMLButtonElement>('.nc-translation-trigger');
    (bubble?.querySelector<HTMLButtonElement>('[aria-pressed="true"]') ?? bubble?.querySelector<HTMLButtonElement>('.nc-drawer-title button'))?.focus({preventScroll: true});
    function outside(event: PointerEvent) {
      const target = event.target as Node;
      if (!bubble?.contains(target) && !trigger?.contains(target)) setPanel(undefined);
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.keyCode === 229 || blocked || hasShortcutOverlay(document)) return;
      event.preventDefault();
      event.stopPropagation();
      closePanel();
    }
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    return () => {document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true);};
  }, [panel, blocked]);
  useEffect(() => {
    function escape(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing ||
        event.keyCode === 229 || blocked || hasShortcutOverlay(document)) return;
      if (panel) closePanel();
      else reveal();
    }
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [immersive, panel, blocked]);

  return {root, panel, setPanel, togglePanel, closePanel, immersive, setImmersive, hidden, reveal, fullscreen};
}
