import {useLayoutEffect, useRef} from 'react';
import {installScrollbars} from './scrollbar-controller';
import './scrollbars.css';

/** Install once per extension surface; dynamically opened panels keep their own scroll owners. */
export function Scrollbars({pageMode = 'overlay'}: {pageMode?: 'overlay' | 'reserved'}) {
  const marker = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    // Native touch scrolling needs no draggable overlay or DOM-wide rail observer.
    // Some touch browsers report a fine pointer but cannot hover.
    const touch = matchMedia('(pointer: coarse), (hover: none)');
    let dispose: (() => void) | undefined;
    const sync = () => {
      dispose?.();
      dispose = !touch.matches && typeof HTMLElement.prototype.showPopover === 'function'
        ? installScrollbars(marker.current!.closest<HTMLElement>('.nc-app')!) : undefined;
    };
    sync();
    touch.addEventListener('change', sync);
    return () => {touch.removeEventListener('change', sync);dispose?.();};
  }, []);
  return <span ref={marker} hidden data-page-scrollbar-mode={pageMode}/>;
}
