import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashFile } from '../../shared/translation-images/hash';
import { probeImageMetadata } from '../../shared/translation-images/image-metadata';
import type { TranslationResult } from '../../shared/translation-images/types';
import { importImages } from '../src/lib/translation-store';

const limits = { max_bytes: 128 * 1024 * 1024, max_pixels: 100000 ** 2, max_dimension: 100000 };
type Message = { source: Blob; limits?: typeof limits; result?: TranslationResult; artifact?: Blob; allowTiles?: boolean };
type Reply = { error?: string; input?: Blob; result?: Blob; width?: number; height?: number; sha256?: string; mime?: string };
type Handler = (event: { data: Message }) => Promise<void>;
let handler: Handler | undefined;

function png(width: number, height: number, normalize = false, padding = 0) {
  const header = new Uint8Array(33), view = new DataView(header.buffer);
  header.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  view.setUint32(16, width); view.setUint32(20, height);
  const metadata = new Uint8Array(normalize ? 12 : 0);
  if (normalize) metadata.set(new TextEncoder().encode('gAMA'), 4);
  return new Blob([header, metadata, new Uint8Array(padding)], { type: 'image/png' });
}

async function withWorker(run: (state: {
  actual?: [number, number]; failDecodeAt?: number; overflow: boolean;
  decodes: { blob: Blob; options?: ImageBitmapOptions }[];
  bitmaps: { width: number; height: number; closed: boolean }[];
  canvases: { width: number; height: number }[];
  surfaces: number[][]; encodings: ImageEncodeOptions[];
  send: (data: Message) => Promise<Reply>;
}) => Promise<void>) {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = ['self', 'createImageBitmap', 'OffscreenCanvas', 'CompressionStream'].map(
    name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  const replies: Reply[] = [], port = { onmessage: undefined as Handler | undefined, postMessage: (reply: Reply) => replies.push(reply) };
  const state = {
    actual: undefined as [number, number] | undefined, failDecodeAt: undefined as number | undefined, overflow: false,
    decodes: [] as { blob: Blob; options?: ImageBitmapOptions }[],
    bitmaps: [] as { width: number; height: number; closed: boolean }[],
    canvases: [] as { width: number; height: number }[], surfaces: [] as number[][], encodings: [] as ImageEncodeOptions[],
    async send(data: Message) { await handler!({ data: { limits, ...data } }); return replies.at(-1)!; },
  };
  const NativeCompressionStream = CompressionStream;
  Object.defineProperty(globals, 'self', { configurable: true, value: port });
  Object.defineProperty(globals, 'createImageBitmap', {
    configurable: true, value: async (blob: Blob, options?: ImageBitmapOptions) => {
      state.decodes.push({ blob, options });
      if (state.decodes.length === state.failDecodeAt) throw new DOMException('Bad image', 'EncodingError');
      const metadata = await probeImageMetadata(blob);
      assert.ok(metadata);
      const bitmap = {
        width: options?.resizeWidth ?? state.actual?.[0] ?? metadata.width,
        height: options?.resizeHeight ?? state.actual?.[1] ?? metadata.height,
        closed: false, close() { assert.equal(this.closed, false); this.closed = true; },
      };
      state.bitmaps.push(bitmap); return bitmap;
    },
  });
  Object.defineProperty(globals, 'OffscreenCanvas', {
    configurable: true, value: class {
      constructor(public width: number, public height: number) { state.canvases.push(this); }
      getContext(_type: string, options: { colorSpace: string }) {
        assert.equal(options.colorSpace, 'srgb'); state.surfaces.push([this.width, this.height]);
        return { drawImage() {}, getImageData(_x: number, _y: number, width: number, height: number) { return { data: new Uint8ClampedArray(width * height * 4) }; } };
      }
      async convertToBlob(options: ImageEncodeOptions) {
        state.encodings.push(options);
        return options.type === 'image/png' ? png(this.width, this.height) : new Blob(['RIFF\x04\x00\x00\x00WEBP'], { type: options.type });
      }
    },
  });
  Object.defineProperty(globals, 'CompressionStream', {
    configurable: true, value: class {
      readable: ReadableStream; writable: WritableStream;
      constructor(format: CompressionFormat) {
        // Report a compressor chunk crossing the real encoder's budget without allocating 128 MiB.
        const stream = state.overflow ? new TransformStream({ transform(_chunk, controller) { controller.enqueue({ length: 128 * 1024 * 1024 }); } }) : new NativeCompressionStream(format);
        this.readable = stream.readable; this.writable = stream.writable;
      }
    },
  });
  try {
    if (!handler) { await import('../src/lib/translation-pixels.worker'); handler = port.onmessage!; }
    await run(state);
  } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globals, name, descriptor);
      else delete globals[name];
    }
  }
}

test('rejects byte, source dimension, missing tiles capability and old-center limits before decoding', async () => withWorker(async state => {
  await assert.rejects(importImages([new File([png(100001, 1)], 'oversized.png', { type: 'image/png' })]), /IMAGE_DIMENSIONS_LIMIT/);
  assert.deepEqual(await state.send({ source: png(1, 1, false, 32 * 1024 * 1024) }), { error: 'IMAGE_FORMAT_LIMIT' });
  assert.deepEqual(await state.send({ source: png(100001, 1), allowTiles: true }), { error: 'IMAGE_DIMENSIONS_LIMIT' });
  assert.deepEqual(await state.send({ source: png(64, 20000) }), { error: 'RESULT_FORMAT_UNAVAILABLE' });
  assert.deepEqual(await state.send({ source: png(64, 20000), allowTiles: true, limits: { ...limits, max_dimension: 16000 } }), { error: 'IMAGE_DIMENSIONS_LIMIT' });
  assert.deepEqual(await state.send({ source: png(1800, 20000), allowTiles: true, limits: { ...limits, max_pixels: 32000000 } }), { error: 'IMAGE_DIMENSIONS_LIMIT' });
  assert.equal(state.decodes.length, 0);
}));

test('accepts sources above 40 million pixels and tiled strips up to a 100000-pixel side', async () => withWorker(async state => {
  const large = await state.send({ source: png(6000, 8000) });
  assert.equal(large.error, undefined); assert.equal(large.width, 1800); assert.equal(large.height, 2400);
  assert.deepEqual(state.surfaces, [[1800, 2400]]);
  const source = png(100000, 64), strip = await state.send({ source, allowTiles: true });
  assert.equal(strip.error, undefined); assert.equal(strip.width, 100000); assert.equal(strip.height, 64);
  assert.equal(strip.sha256, await hashFile(source)); assert.equal(state.decodes.length, 3);
  assert.deepEqual(state.surfaces, [[1800, 2400]]);
}));

test('rechecks decoded dimensions and releases the bitmap when a header understates them', async () => withWorker(async state => {
  const source = png(64, 100);
  state.actual = [64, 100001];
  assert.deepEqual(await state.send({ source, allowTiles: true }), { error: 'IMAGE_DIMENSIONS_LIMIT' });
  state.actual = [64, 20000];
  assert.deepEqual(await state.send({ source }), { error: 'RESULT_FORMAT_UNAVAILABLE' });
  state.actual = [1800, 20000];
  assert.deepEqual(await state.send({ source, allowTiles: true, limits: { ...limits, max_pixels: 32000000 } }), { error: 'IMAGE_DIMENSIONS_LIMIT' });
  assert.equal(state.bitmaps.length, 3); assert.ok(state.bitmaps.every(bitmap => bitmap.closed)); assert.equal(state.canvases.length, 0);
}));

test('materializes full redraw output without decoding or reading the unused original', async () => withWorker(async state => {
  const original = new Blob(['unused original']), artifact = png(100, 100);
  Object.defineProperty(original, 'slice', { value() { throw Error('Redraw must not read the input'); } });
  const reply = await state.send({ source: original, artifact, result: {
    kind: 'translated', representation: 'full-image-v1', input_sha256: '0'.repeat(64), normalization_version: 1, width: 100, height: 100,
    artifact: { sha256: await hashFile(artifact), byte_size: artifact.size, mime: artifact.type, path: '/v1/translations/test/result' },
  } });
  assert.equal(reply.result, artifact); assert.equal(state.decodes.length, 1); assert.equal(state.decodes[0].blob, artifact);
  assert.ok(state.bitmaps.every(bitmap => bitmap.closed));
}));

test('uses oriented dimensions and one target-sized WebP encode for a resized EXIF image', async () => withWorker(async state => {
  state.actual = [2400, 3600];
  // SOF is landscape; browser decoding applies EXIF and returns portrait.
  const source = new Blob([new Uint8Array([255, 216, 255, 225, 0, 8, 69, 120, 105, 102, 0, 0, 255, 192, 0, 11, 8, 9, 96, 14, 16, 1, 1, 17, 0, 255, 217])], { type: 'image/jpeg' });
  const reply = await state.send({ source });
  assert.equal(reply.error, undefined); assert.deepEqual(state.surfaces, [[1800, 2700]]);
  assert.deepEqual(state.encodings, [{ type: 'image/webp', quality: 0.9 }]);
  assert.equal(state.decodes.length, 2); assert.equal(state.decodes[1].options?.resizeWidth, 1800); assert.equal(state.decodes[1].options?.resizeHeight, 2700);
  assert.ok(state.decodes.every(decode => decode.options?.imageOrientation === 'from-image' && decode.options?.colorSpaceConversion === 'default'));
  assert.ok(state.bitmaps.every(bitmap => bitmap.closed));
}));

test('normalizes a long tagged image through small PNG canvases without a full-length canvas', async () => withWorker(async state => {
  const reply = await state.send({ source: png(64, 20000, true), allowTiles: true });
  assert.equal(reply.error, undefined); assert.equal(reply.mime, 'image/png');
  assert.deepEqual(await probeImageMetadata(reply.input!), { mime: 'image/png', width: 64, height: 20000 });
  assert.equal(reply.sha256, await hashFile(reply.input!)); assert.equal(state.decodes.length, 2);
  assert.ok(state.surfaces.length > 1); assert.ok(state.surfaces.every(([width, height]) => width <= 2048 && height <= 4096));
  assert.equal(state.encodings.length, 0); assert.ok(state.canvases.every(canvas => canvas.width === 1 && canvas.height === 1));
  assert.ok(state.bitmaps.every(bitmap => bitmap.closed));
}));

test('keeps exact admissible original bytes when only optional same-size encoding exceeds its output budget', async () => withWorker(async state => {
  state.overflow = true;
  const source = png(64, 20000, false, 1024 * 1024), reply = await state.send({ source, allowTiles: true });
  assert.equal(reply.error, undefined); assert.equal(reply.sha256, await hashFile(source));
  assert.deepEqual(await reply.input!.arrayBuffer(), await source.arrayBuffer());
  assert.equal(state.decodes.length, 2); assert.ok(state.bitmaps.every(bitmap => bitmap.closed));
}));

test('does not fall back when resizing, normalization, or a smaller server byte limit makes encoding mandatory', async () => withWorker(async state => {
  state.overflow = true;
  assert.deepEqual(await state.send({ source: png(2400, 30000), allowTiles: true }), { error: 'IMAGE_OUTPUT_TOO_LARGE' });
  assert.deepEqual(await state.send({ source: png(64, 20000, true), allowTiles: true }), { error: 'IMAGE_OUTPUT_TOO_LARGE' });
  const source = png(64, 20000, false, 1024 * 1024);
  assert.deepEqual(await state.send({ source, allowTiles: true, limits: { ...limits, max_bytes: source.size - 1 } }), { error: 'IMAGE_OUTPUT_TOO_LARGE' });
  assert.equal(state.decodes.length, 6); assert.ok(state.bitmaps.every(bitmap => bitmap.closed));
}));

test('does not hide a decode failure during optional compression', async () => withWorker(async state => {
  state.failDecodeAt = 2;
  assert.deepEqual(await state.send({ source: png(64, 20000, false, 1024 * 1024), allowTiles: true }), { error: 'IMAGE_PROCESSING_FAILED' });
  assert.equal(state.decodes.length, 2); assert.ok(state.bitmaps.every(bitmap => bitmap.closed));
}));
