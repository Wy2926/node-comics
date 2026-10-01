import { useId, useRef, useState } from 'react';

export type Screenshot = { src: string; fullSrc: string; width: number; height: number; label: string; description: string; alt: string };
type Props = { images: Screenshot[]; name: string; enlarge: string; close: string; note: string };

export default function ScreenshotGallery({ images, name, enlarge, close, note }: Props) {
  const [selected, setSelected] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const current = images[selected];
  return <div className="product-gallery">
    <div className="gallery-switches" role="group" aria-label={name}>
      {images.map((item, index) => <button key={item.src} type="button" aria-pressed={selected === index} aria-controls={`${id}-image`} onClick={() => setSelected(index)}><span className="gallery-switch-label">{item.label}</span></button>)}
    </div>
    <figure className="gallery-frame">
      <figcaption className="gallery-caption"><div><strong>{current.label}</strong><p aria-live="polite">{current.description}</p></div><button ref={trigger} type="button" onClick={() => { setExpanded(true); dialog.current?.showModal(); }}>{enlarge}<span aria-hidden="true"> ↗</span></button></figcaption>
      <div id={`${id}-image`} className="gallery-focus"><img key={current.src} src={current.src} width={current.width} height={current.height} alt={current.alt} loading="lazy" decoding="async" /></div>
    </figure>
    <p className="gallery-note">{note}</p>
    <dialog ref={dialog} className="screenshot-dialog" aria-label={current.label} onClose={() => { setExpanded(false); trigger.current?.focus(); }} onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <div className="screenshot-dialog-content"><div className="screenshot-dialog-heading"><strong>{current.label}</strong><button className="button compact secondary" type="button" autoFocus onClick={() => dialog.current?.close()}>{close}</button></div>{expanded && <img src={current.fullSrc} width={current.width} height={current.height} alt={current.alt} decoding="async" />}</div>
    </dialog>
  </div>;
}
