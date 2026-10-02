import type {TranslationResult} from './types';
import {hashFile} from './hash';
import {imageWork} from './work';
import {TRANSLATION_MAX_DIMENSION} from './limits';
import {TILES_MIME,readTiles} from './tiles';
import {bitmapPng} from './png';

const digest = /^[a-f0-9]{64}$/;
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;

export class OriginalUnavailableError extends Error {
  readonly code = 'ORIGINAL_UNAVAILABLE';
  constructor(message = '原图不可用，请恢复所属来源或本地原图缓存。') {
    super(message);
    this.name = 'OriginalUnavailableError';
  }
}

export class InvalidArtifactError extends Error {
  readonly code = 'RESULT_ARTIFACT_INVALID';
  constructor() {
    super('翻译文件校验失败，请重新加载。');
    this.name = 'InvalidArtifactError';
  }
}

export function validateResult(result: TranslationResult) {
  if (result.normalization_version !== 1 || !digest.test(result.input_sha256) ||
      !positive(result.width) || !positive(result.height) || Math.max(result.width, result.height) > TRANSLATION_MAX_DIMENSION ||
      !['translated', 'partial', 'no_text'].includes(result.kind)) {
    throw new InvalidArtifactError();
  }
  if (result.representation === 'original') {
    if (result.artifact || result.bbox || result.composite) throw new InvalidArtifactError();
    return;
  }
  const artifact = result.artifact;
  if (!artifact || !digest.test(artifact.sha256) || !positive(artifact.byte_size) ||
      artifact.byte_size > 128 * 1024 * 1024 || result.kind === 'no_text') {
    throw new InvalidArtifactError();
  }
  if (result.representation === 'overlay-v1') {
    const box = result.bbox;
    if (result.composite !== 'source-atop' || artifact.mime !== 'image/webp' || !box ||
        !Number.isSafeInteger(box.x) || !Number.isSafeInteger(box.y) || box.x < 0 || box.y < 0 ||
        !positive(box.width) || !positive(box.height) ||
        box.x + box.width > result.width || box.y + box.height > result.height) {
      throw new InvalidArtifactError();
    }
  } else if(result.representation==='overlay-tiles-v1'){
    if(result.bbox||result.composite!=='source-atop'||artifact.mime!==TILES_MIME)throw new InvalidArtifactError();
  } else if (result.representation !== 'full-image-v1' || result.bbox || result.composite) {
    throw new InvalidArtifactError();
  }
}

async function validateArtifact(result: TranslationResult, blob: Blob) {
  const artifact = result.artifact;
  if (!artifact || blob.size !== artifact.byte_size || blob.type !== artifact.mime ||
      await hashFile(blob) !== artifact.sha256) {
    throw new InvalidArtifactError();
  }
}

/** Reader, inline display and export verify delivered bytes once, before caching or composing. */
export async function materializeResult(result: TranslationResult, original: Blob | undefined, artifact?: Blob): Promise<Blob> {
  validateResult(result);
  if (artifact) await validateArtifact(result, artifact);
  if (result.representation !== 'original' && !artifact) throw new InvalidArtifactError();
  if (result.representation !== 'full-image-v1' && !original) throw new OriginalUnavailableError();
  if (original && await hashFile(original) !== result.input_sha256) {
    throw Error('原图内容已变化，请重新加载后翻译。');
  }
  return imageWork(async () => {
    let base: ImageBitmap | undefined;
    let patch: ImageBitmap | undefined;
    let canvas: OffscreenCanvas | undefined;
    try {
      if (original) {
        base = await createImageBitmap(original, {imageOrientation: 'from-image', colorSpaceConversion: 'default'});
        if (result.representation !== 'full-image-v1' && (base.width !== result.width || base.height !== result.height)) {
          throw Error('原图内容已变化，请重新加载后翻译。');
        }
      }
      if (result.representation === 'original') return original!;
      if(result.representation==='overlay-tiles-v1'){
        try{return await bitmapPng(base!,await readTiles(artifact!,result.input_sha256,result.width,result.height));}
        catch{throw new InvalidArtifactError();}
      }
      try { patch = await createImageBitmap(artifact!); }
      catch { throw new InvalidArtifactError(); }
      const expected = result.representation === 'overlay-v1' ? result.bbox! : result;
      if (patch.width !== expected.width || patch.height !== expected.height) throw new InvalidArtifactError();
      if (result.representation === 'full-image-v1') return artifact!;
      if(Math.max(result.width,result.height)>16383)
        return await bitmapPng(base!,[{...result.bbox!,bitmap:patch}]);
      canvas = new OffscreenCanvas(result.width, result.height);
      const context = canvas.getContext('2d', {colorSpace: 'srgb'});
      if (!context) throw new InvalidArtifactError();
      context.imageSmoothingEnabled = false;
      context.drawImage(base!, 0, 0);
      context.globalCompositeOperation = 'source-atop';
      context.drawImage(patch, result.bbox!.x, result.bbox!.y);
      return await canvas.convertToBlob({type: 'image/png'});
    } finally {
      base?.close();
      patch?.close();
      if (canvas) canvas.width = canvas.height = 1;
    }
  });
}
