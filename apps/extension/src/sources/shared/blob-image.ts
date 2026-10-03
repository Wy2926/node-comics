import {canvasImage} from './canvas';

/** Some viewers revoke their Blob URL in onload. The decoded <img> remains
 * readable, but fetching that URL no longer works. Only page-owned Blobs use
 * this fallback; HTTP/CORS failures must not turn into pixel acquisition. */
export async function readBlobImage(image: HTMLImageElement, url: string, pageUrl: string, signal?: AbortSignal): Promise<Blob> {
  signal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30000)]);
  const width = image.naturalWidth, height = image.naturalHeight;
  const current = () => {
    signal?.throwIfAborted();
    if (!url.startsWith('blob:') || new URL(url).origin !== new URL(pageUrl).origin ||
        !image.isConnected || !image.complete || width <= 0 || height <= 0 ||
        (image.currentSrc || image.src) !== url || image.naturalWidth !== width || image.naturalHeight !== height ||
        (image.ownerDocument.defaultView && image.ownerDocument.defaultView.location.href !== pageUrl))
      throw Error('SOURCE_RESOURCE_EXPIRED');
  };
  current();
  // Preserve original encoding/bytes while the URL is valid. A failed Blob
  // fetch is local, not another source/CDN request or a new decoding protocol.
  try {
    const response = await fetch(url, {signal});
    if (response.ok) {
      const blob = await response.blob();
      current();
      return blob;
    }
    await response.body?.cancel();
  } catch {current();}
  current();
  const canvas = image.ownerDocument.createElement('canvas');
  canvas.width = width; canvas.height = height;
  try {
    const drawing = canvas.getContext('2d');
    if (!drawing) throw Error('SOURCE_IMAGE_UNREADABLE');
    drawing.drawImage(image, 0, 0);
    const blob = await canvasImage(canvas, signal);
    current();
    return blob;
  } finally {
    // Encoding is demand-driven, without a retained full-resolution pixel cache.
    canvas.width = 0; canvas.height = 0;
  }
}
