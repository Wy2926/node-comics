import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashFile } from '../../shared/translation-images/hash';
import { importImages } from '../src/lib/translation-store';

test('pixel processing guards source decoding, avoids unused redraw input and normalizes EXIF without a full-size canvas', async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = ['self', 'createImageBitmap', 'OffscreenCanvas'].map(
    (name) =>
      [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  const replies: { error?: string; result?: Blob }[] = [];
  const port = {
    onmessage: undefined as
      ((event: { data: unknown }) => Promise<void>) | undefined,
    postMessage: (value: { error?: string; result?: Blob }) =>
      replies.push(value),
  };
  let decoded = 0;
  let expectedArtifact: Blob;
  Object.defineProperty(globals, 'self', { configurable: true, value: port });
  Object.defineProperty(globals, 'createImageBitmap', {
    configurable: true,
    value: async (blob: Blob) => {
      decoded++;
      assert.equal(blob, expectedArtifact);
      return { width: 100, height: 100, close() {} };
    },
  });
  try {
    await import('../src/lib/translation-pixels.worker');
    const header = new Uint8Array(33);
    header.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    const view = new DataView(header.buffer);
    view.setUint32(16, 100000);
    view.setUint32(20, 1000);
    const source = new File([header], 'oversized.png', { type: 'image/png' });
    await assert.rejects(importImages([source]), /IMAGE_DIMENSIONS_LIMIT/);
    await port.onmessage!({
      data: {
        source,
        limits: {
          max_bytes: 134217728,
          max_pixels: 32000000,
          max_dimension: 16000,
        },
      },
    });
    assert.equal(replies.length, 1);
    assert.deepEqual(replies[0], { error: 'IMAGE_DIMENSIONS_LIMIT' });
    assert.equal(decoded, 0);

    expectedArtifact = new Blob(['synthetic pixels'], { type: 'image/png' });
    const original = new Blob(['unused original']);
    Object.defineProperty(original, 'slice', {
      value() {
        throw Error('Redraw must not read the input');
      },
    });
    await port.onmessage!({
      data: {
        source: original,
        artifact: expectedArtifact,
        result: {
          kind: 'translated',
          representation: 'full-image-v1',
          input_sha256: '0'.repeat(64),
          normalization_version: 1,
          width: 100,
          height: 100,
          artifact: {
            sha256: await hashFile(expectedArtifact),
            byte_size: expectedArtifact.size,
            mime: expectedArtifact.type,
            path: '/v1/translations/test/result',
          },
        },
      },
    });
    assert.equal(decoded, 1);
    assert.equal(replies[1].result, expectedArtifact);

    const canvases: number[][] = [];
    const encodings: ImageEncodeOptions[] = [];
    const decodes: ImageBitmapOptions[] = [];
    Object.defineProperty(globals, 'createImageBitmap', {
      configurable: true,
      value: async (_blob: Blob, options: ImageBitmapOptions) => {
        assert.equal(options.imageOrientation, 'from-image');
        assert.equal(options.colorSpaceConversion, 'default');
        decodes.push(options);
        return {
          width: options.resizeWidth ?? 2400,
          height: options.resizeHeight ?? 3600,
          close() {},
        };
      },
    });
    Object.defineProperty(globals, 'OffscreenCanvas', {
      configurable: true,
      value: class {
        constructor(
          public width: number,
          public height: number,
        ) {
          canvases.push([width, height]);
        }
        getContext(_type: string, options: { colorSpace: string }) {
          assert.equal(options.colorSpace, 'srgb');
          return { drawImage() {} };
        }
        async convertToBlob(options: ImageEncodeOptions) {
          encodings.push(options);
          return new Blob(['RIFF\x04\x00\x00\x00WEBP'], { type: options.type });
        }
      },
    });
    // SOF is landscape; browser decoding applies EXIF and returns portrait.
    const exif = new Blob(
      [
        new Uint8Array([
          255, 216, 255, 225, 0, 8, 69, 120, 105, 102, 0, 0, 255, 192, 0, 11, 8,
          9, 96, 14, 16, 1, 1, 17, 0, 255, 217,
        ]),
      ],
      { type: 'image/jpeg' },
    );
    await port.onmessage!({
      data: {
        source: exif,
        limits: {
          max_bytes: 134217728,
          max_pixels: 32000000,
          max_dimension: 16000,
        },
      },
    });
    assert.equal(replies[2].error, undefined);
    assert.deepEqual(canvases, [[1800, 2700]]);
    assert.deepEqual(encodings, [{ type: 'image/webp', quality: 0.9 }]);
    assert.equal(decodes.length, 2);
    assert.equal(decodes[1].resizeWidth, 1800);
    assert.equal(decodes[1].resizeHeight, 2700);
  } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globals, name, descriptor);
      else delete globals[name];
    }
  }
});
