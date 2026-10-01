import { hashFile } from '../../../shared/translation-images/hash';
import {
  needsNormalization,
  probeImageMetadata,
} from '../../../shared/translation-images/image-metadata';
import { SOURCE_MAX_PIXELS, SOURCE_MAX_DIMENSION } from './translation-store';
import { resizeInput } from '../../../shared/translation-images/resize';
import {
  translationSize,
  TRANSLATION_REENCODE_BYTES,
  TRANSLATION_MAX_PIXELS,
  TRANSLATION_MAX_DIMENSION,
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
  }>,
) => {
  try {
    const { source, limits, result, artifact } = event.data;
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
      const planned = translationSize(metadata.width, metadata.height);
      if (
        metadata.width * metadata.height > SOURCE_MAX_PIXELS ||
        Math.max(metadata.width, metadata.height) > SOURCE_MAX_DIMENSION ||
        planned.width * planned.height >
          Math.min(TRANSLATION_MAX_PIXELS, limits.max_pixels) ||
        Math.max(planned.width, planned.height) >
          Math.min(TRANSLATION_MAX_DIMENSION, limits.max_dimension)
      )
        throw Error('IMAGE_DIMENSIONS_LIMIT');
      const mime = metadata.mime;
      let input = source.slice(0, source.size, mime),
        sha256: string | undefined;
      const bitmap = await createImageBitmap(input, {
        imageOrientation: 'from-image',
        colorSpaceConversion: 'default',
      });
      const width = bitmap.width,
        height = bitmap.height;
      const size = translationSize(width, height);
      const changed = size.width !== width || size.height !== height;
      const reencode = changed || input.size > TRANSLATION_REENCODE_BYTES;
      try {
        if (
          width * height > SOURCE_MAX_PIXELS ||
          Math.max(width, height) > SOURCE_MAX_DIMENSION ||
          size.width * size.height >
            Math.min(TRANSLATION_MAX_PIXELS, limits.max_pixels) ||
          Math.max(size.width, size.height) >
            Math.min(TRANSLATION_MAX_DIMENSION, limits.max_dimension)
        )
          throw Error('IMAGE_DIMENSIONS_LIMIT');
        // resizeInput already applies orientation and draws into an sRGB canvas.
        if (!reencode && (await needsNormalization(input))) {
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
      if (changed || input.size > TRANSLATION_REENCODE_BYTES) {
        const resized = await resizeInput(input, size.width, size.height);
        if (
          changed ||
          resized.blob.size < input.size ||
          (reencode && (await needsNormalization(input)))
        ) {
          input = resized.blob;
          sha256 = resized.sha256;
        }
      }
      if (input.size > limits.max_bytes) throw Error('IMAGE_FORMAT_LIMIT');
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
