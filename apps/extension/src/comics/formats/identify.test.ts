import {describe, expect, it} from 'vitest';
import {imageMimeFromBytes} from './identify';

describe('raster image byte identification', () => {
  const header = (brand: string) => new Uint8Array([0, 0, 0, 28, ...new TextEncoder().encode('ftyp' + brand)]);
  it('recognizes the AVIF major brand when the server sends application/octet-stream', () => {
    expect(imageMimeFromBytes(header('avif'))).toBe('image/avif');
  });
  it.each(['mp42', 'heic', 'mif1'])('does not label an unrelated BMFF brand %s as AVIF', brand => {
    expect(imageMimeFromBytes(header(brand))).toBeUndefined();
  });
  it('rejects truncated or misplaced AVIF brand bytes', () => {
    expect(imageMimeFromBytes(header('avif').slice(0, 11))).toBeUndefined();
    expect(imageMimeFromBytes(new TextEncoder().encode('avif-not-an-image'))).toBeUndefined();
  });
});
