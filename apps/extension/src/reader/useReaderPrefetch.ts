import {useEffect, useLayoutEffect, useRef} from 'react';
import {acquireImage} from '../comics/application/image-access';
import {ReaderImagePrefetch, type ReaderPrefetchOptions} from './image-prefetch';

export function useReaderPrefetch(options: ReaderPrefetchOptions): void {
  const manager = useRef<ReaderImagePrefetch | undefined>(undefined);
  if (!manager.current) manager.current = new ReaderImagePrefetch(acquireImage);
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    const prefetch = manager.current!;
    const visibility = () => prefetch.update({...latest.current, enabled: latest.current.enabled && !document.hidden});
    document.addEventListener('visibilitychange', visibility);
    return () => {document.removeEventListener('visibilitychange', visibility); prefetch.dispose();};
  }, []);
  // Drop an old authorization generation before child pictures acquire in passive effects.
  useLayoutEffect(() => {
    manager.current!.update({...options, enabled: options.enabled && !document.hidden});
  });
}
