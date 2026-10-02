import { hashFile } from '../../../shared/translation-images/hash';
import {
  needsNormalization,
  probeImageMetadata,
} from '../../../shared/translation-images/image-metadata';
import { ImageOutputTooLargeError, resizeInput } from '../../../shared/translation-images/resize';
import {
  translationSize,
  TRANSLATION_REENCODE_BYTES,
  TRANSLATION_MAX_BYTES,
  TRANSLATION_MAX_PIXELS,
  TRANSLATION_MAX_DIMENSION,
  TRANSLATION_JPEG_MAX_DIMENSION,
} from '../../../shared/translation-images/limits';
import { materializeResult } from '../../../shared/translation-images/materialize';
import { imageWork } from '../../../shared/translation-images/work';
import type { TranslationResult } from '../../../shared/translation-images/types';
type Limits = { max_bytes: number; max_pixels: number; max_dimension: number };
self.onmessage = async (
  event: MessageEvent<{
    source: Blob;
    limits: Limits;
    result?: TranslationResult;
    artifact?: Blob;
    allowTiles?: boolean;
  }>,
) => {
  try {
    const { source, limits, result, artifact, allowTiles = false } = event.data;
    if (result) {
      self.postMessage({
        result: await materializeResult(
          result,
          result.representation === 'full-image-v1' ? undefined : source,
          artifact,
        ),
      });
      return;
    }
    await imageWork(async () => {
      if (source.size > 32 * 1024 * 1024) throw Error('IMAGE_FORMAT_LIMIT');
      const metadata = await probeImageMetadata(source);
      if (!metadata) throw Error('IMAGE_FORMAT_LIMIT');
      const checkedSize = (width: number, height: number) => {
        if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
          width < 1 || height < 1 || Math.max(width, height) > TRANSLATION_MAX_DIMENSION)
          throw Error('IMAGE_DIMENSIONS_LIMIT');
        const size = translationSize(width, height);
        if (Math.max(size.width, size.height) > 16383 && !allowTiles)
          throw Error('RESULT_FORMAT_UNAVAILABLE');
        if (size.width * size.height > Math.min(TRANSLATION_MAX_PIXELS, limits.max_pixels) ||
          Math.max(size.width, size.height) > Math.min(TRANSLATION_MAX_DIMENSION, limits.max_dimension))
          throw Error('IMAGE_DIMENSIONS_LIMIT');
        return size;
      };
      checkedSize(metadata.width, metadata.height);
      const maxBytes = Math.min(TRANSLATION_MAX_BYTES, limits.max_bytes);
      const mime = metadata.mime;
      let input = source.slice(0, source.size, mime),
        sha256: string | undefined;
      const bitmap = await createImageBitmap(input, {
        imageOrientation: 'from-image',
        colorSpaceConversion: 'default',
      });
      const width = bitmap.width,
        height = bitmap.height;
      let size: { width: number; height: number }, changed: boolean, reencode: boolean, normalize: boolean, canReencode: boolean;
      try {
        size = checkedSize(width, height);
        changed = size.width !== width || size.height !== height;
        normalize = await needsNormalization(input);
        canReencode = Math.max(size.width, size.height) <= TRANSLATION_JPEG_MAX_DIMENSION;
        if (!canReencode && (changed || normalize)) throw Error('IMAGE_DIMENSIONS_LIMIT');
        reencode = canReencode && (changed || input.size > TRANSLATION_REENCODE_BYTES ||
          normalize && Math.max(size.width, size.height) > 16383);
        // resizeInput already applies orientation and draws into an sRGB canvas.
        if (!reencode && normalize) {
          const canvas = new OffscreenCanvas(width, height);
          try {
            canvas
              .getContext('2d', { colorSpace: 'srgb' })!
              .drawImage(bitmap, 0, 0);
            input = await canvas.convertToBlob({ type: 'image/png' });
          } finally {
            canvas.width = canvas.height = 1;
          }
        }
      } finally {
        bitmap.close();
      }
      if (reencode || canReencode && input.size > TRANSLATION_REENCODE_BYTES) {
        try {
          const resized = await resizeInput(input, size.width, size.height);
          if (changed || resized.blob.size < input.size || reencode && normalize) {
            input = resized.blob;
            sha256 = resized.sha256;
          }
        } catch (error) {
          // Only optional compression may retain already normalized, admissible bytes.
          if (changed || reencode && normalize || input.size > maxBytes || !(error instanceof ImageOutputTooLargeError))
            throw error;
        }
      }
      if (input.size > maxBytes) throw Error('IMAGE_FORMAT_LIMIT');
      self.postMessage({
        input,
        ...size,
        sha256: sha256 ?? (await hashFile(input)),
        mime: input.type,
      });
    });
  } catch (error) {
    const code =
      (error as { code?: unknown })?.code ??
      (error instanceof Error ? error.message : '');
    self.postMessage({
      error:
        typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code)
          ? code
          : 'IMAGE_PROCESSING_FAILED',
    });
  }
};
