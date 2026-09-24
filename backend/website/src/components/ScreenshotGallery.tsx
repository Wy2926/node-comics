import { useId, useRef, useState } from 'react';

export type Screenshot = { src: string; width: number; height: number; label: string; description: string; alt: string; crops: { x: number; y: number; width: number; height: number }[] };
type Props = { images: Screenshot[]; name: string; enlarge: string; close: string; note: string };

export default function ScreenshotGallery({ images, name, enlarge, close, note }: Props) {
  const [selected, setSelected] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const current = images[selected];
  return <div className="product-gallery">
    <div className="gallery-switches" role="group" aria-label={name}>
      {images.map((item, index) => <button key={item.src} type="button" aria-pressed={selected === index} aria-controls={`${id}-image`} onClick={() => setSelected(index)}>{item.label}</button>)}
    </div>
    <figure className="gallery-frame">
      <div className="gallery-caption"><p aria-live="polite">{current.description}</p><button ref={trigger} type="button" onClick={() => dialog.current?.showModal()}>{enlarge}</button></div>
      <div id={`${id}-image`} className="gallery-focus" role="img" aria-label={current.alt}>{current.crops.map((crop, index) => <div key={`${selected}-${index}`} className="screenshot-crop" style={{ aspectRatio: `${crop.width} / ${crop.height}` }}><img src={current.src} width={current.width} height={current.height} alt={current.alt} loading="lazy" decoding="async" style={{ width: `${current.width / crop.width * 100}%`, left: `${-crop.x / crop.width * 100}%`, top: `${-crop.y / crop.height * 100}%` }} /></div>)}</div>
    </figure>
    <p className="gallery-note">{note}</p>
    <dialog ref={dialog} className="screenshot-dialog" aria-label={current.label} onClose={() => trigger.current?.focus()} onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <div className="screenshot-dialog-content"><div className="screenshot-dialog-heading"><strong>{current.label}</strong><button className="button compact secondary" type="button" autoFocus onClick={() => dialog.current?.close()}>{close}</button></div><img src={current.src} width={current.width} height={current.height} alt={current.alt} /></div>
    </dialog>
  </div>;
}
