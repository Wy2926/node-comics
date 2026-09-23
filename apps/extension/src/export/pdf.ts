import {msg} from '../i18n/runtime';
import {PDFDocument} from 'pdf-lib';
import {exportImage} from './images';

/** PDF images are normalized to JPEG to bound retained decoded PNG data. */
export async function pdfWriter(title: string) {
  const doc = await PDFDocument.create();
  doc.setTitle(title); doc.setCreator(msg("NodeLane Comics")); doc.setProducer('NodeLane Comics / pdf-lib');
  let bytes = 0;
  return {
    async add(blob: Blob, signal?: AbortSignal) {
      const image = await exportImage(blob, true, undefined, signal);
      signal?.throwIfAborted();
      bytes += image.blob.size;
      if (bytes > 128 * 1024 * 1024) throw Error(msg("单份 PDF 图片超过 128 MiB，请改用 CBZ 或图片 ZIP。"));
      const embedded = await doc.embedJpg(await image.blob.arrayBuffer());
      const scale = Math.min(0.75, 14400 / Math.max(image.width, image.height));
      const width = image.width * scale, height = image.height * scale;
      doc.addPage([width, height]).drawImage(embedded, {x: 0, y: 0, width, height});
    },
    async close(manifest: string) {
      await doc.attach(new TextEncoder().encode(manifest), 'export-manifest.json', {mimeType: 'application/json', description: 'NodeLane Comics export page manifest'});
      return new Blob([new Uint8Array(await doc.save())], {type: 'application/pdf'});
    },
  };
}
