import {useLayoutEffect, type RefObject} from 'react';

export type ViewportBounds = {left: number; top: number; width: number; height: number};
type Anchor = {left: number; top: number; right: number; bottom: number; width: number; height: number};

/** Coordinates share the layout viewport used by fixed popovers and native dialogs. */
export function visibleViewport(): ViewportBounds {
  const root = document.documentElement, visual = window.visualViewport;
  return {
    left: visual?.offsetLeft ?? 0,
    top: visual?.offsetTop ?? 0,
    width: Math.min(root.clientWidth, root.getBoundingClientRect().width, visual?.width ?? window.innerWidth),
    height: visual?.height ?? window.innerHeight,
  };
}

export function menuPosition(anchor: Anchor, viewport: ViewportBounds, desiredWidth: number, contentHeight: number, placement: 'auto' | 'left' = 'auto') {
  const gap = 6, margin = 8, left = viewport.left + margin, top = viewport.top + margin;
  const right = viewport.left + viewport.width - margin, bottom = viewport.top + viewport.height - margin;
  const width = Math.max(0, Math.min(Math.max(anchor.width, desiredWidth), right - left));
  // A reader's side menu becomes an ordinary anchored menu when the phone has no side gutter.
  if (placement === 'left' && anchor.left - gap - width >= left) {
    const maxHeight = Math.max(0, Math.min(320, bottom - top));
    const height = Math.min(contentHeight, maxHeight);
    return {left: anchor.left - gap - width, top: Math.max(top, Math.min(anchor.top + (anchor.height - height) / 2, bottom - height)), width, maxHeight};
  }
  const below = bottom - anchor.bottom - gap, above = anchor.top - gap - top;
  const upwards = below < Math.min(contentHeight, 320) && above > below;
  const maxHeight = Math.max(0, Math.min(320, upwards ? above : below, bottom - top));
  const height = Math.min(contentHeight, maxHeight);
  return {left: Math.max(left, Math.min(anchor.left, right - width)), top: Math.max(top, Math.min(upwards ? anchor.top - gap - height : anchor.bottom + gap, bottom - height)), width, maxHeight};
}

/** Observe only while a dialog is mounted; keyboard/browser bars must not hide its close control. */
export function useDialogViewport(ref: RefObject<HTMLDialogElement | null>, enabled = true) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return;
    const update = () => {
      const viewport = visibleViewport();
      for (const [key, value] of Object.entries(viewport)) element.style.setProperty(`--nc-viewport-${key}`, `${value}px`);
    };
    update();
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    return () => {
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
    };
  }, [ref, enabled]);
}
