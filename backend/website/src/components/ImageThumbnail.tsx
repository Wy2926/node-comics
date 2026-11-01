import { useEffect, useRef, useState } from 'react';
import { readImages } from '../lib/translation-store';
import { imageThumbnail } from '../lib/translation-pixels';

/** Only visible cards hold small thumbnails; queue cancellation releases offscreen work. */
export default function ImageThumbnail({ id, translated, result, label, onOpen }: {
  id: string; translated: boolean; result?: Blob; label: string; onOpen: () => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    observer.observe(button.current!);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setUrl(undefined);
    if (!visible) return;
    const abort = new AbortController();
    let objectUrl: string | undefined;
    void (async () => {
      const data = result ? undefined : await readImages(id);
      const blob = result ?? (translated ? data?.result : data?.source);
      if (!blob || abort.signal.aborted) return;
      const image = await imageThumbnail(blob, abort.signal);
      if (abort.signal.aborted) return;
      objectUrl = URL.createObjectURL(image.thumbnail);
      setUrl(objectUrl);
    })().catch(() => { /* The card still opens the full image and its local retry. */ });
    return () => { abort.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [id, translated, result, visible]);
  return <button ref={button} type="button" className="record-thumbnail" aria-label={label} onClick={onOpen}>
    {url ? <img src={url} alt="" decoding="async"/> : <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="m3 17 6-6 4 4 3-3 5 5"/><circle cx="15.5" cy="7.5" r="1"/></svg>}
  </button>;
}
