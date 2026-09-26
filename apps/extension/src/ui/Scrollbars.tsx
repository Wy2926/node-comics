import {useLayoutEffect, useRef} from 'react';
import {installScrollbars} from './scrollbar-controller';
import './scrollbars.css';

/** Install once per extension surface; dynamically opened panels keep their own scroll owners. */
export function Scrollbars({pageMode = 'overlay'}: {pageMode?: 'overlay' | 'reserved'}) {
  const marker = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => installScrollbars(marker.current!.closest<HTMLElement>('.nc-app')!), []);
  return <span ref={marker} hidden data-page-scrollbar-mode={pageMode}/>;
}
