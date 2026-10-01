import {expect,it,vi} from 'vitest';
import {probeImageMetadata} from '../src/comics/pages/image-metadata';

// Pillow-generated 3 × 5 images: ordinary PNG/JPEG and all three WebP dimension headers.
const fixtures = {
  png: 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAAFCAYAAACAcVaiAAAAFElEQVR4nGMUsYmqZoACJhiDBA4ASGUBLySXec0AAAAASUVORK5CYII=',
  jpeg: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAFAAMDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDzKiiivUPLP//Z',
  vp8: 'UklGRjQAAABXRUJQVlA4ICgAAACQAQCdASoDAAUAAUAmJYgCdLoAA5gA/vjqf+j64RZGX+N8QXtSYAAA',
  vp8l: 'UklGRh4AAABXRUJQVlA4TBEAAAAvAgABEAdQnlJUq3uBiOh/AAA=',
  vp8x: 'UklGRlgAAABXRUJQVlA4WAoAAAAQAAAAAgAABAAAQUxQSAoAAAABB9C9iAhERP8DVlA4ICgAAACQAQCdASoDAAUAAUAmJYgCdLoAA5gA/vjqf+j64RZGX+N8QXtSYAAA',
};
const bytes = (name: keyof typeof fixtures) => Uint8Array.from(Buffer.from(fixtures[name], 'base64'));
it.each(['png','jpeg','vp8','vp8l','vp8x'] as const)('reads actual %s image dimensions without decoding', async name => {
  expect(await probeImageMetadata(new Blob([bytes(name)]))).toEqual({mime: name === 'png' ? 'image/png' : name === 'jpeg' ? 'image/jpeg' : 'image/webp', width:3, height:5});
});
it('skips long JPEG EXIF data with bounded slice reads and no whole-file allocation', async () => {
  const jpeg = bytes('jpeg'), segment = new Uint8Array(65537);
  segment.set([255,0xe1,255,255]);segment.set(new TextEncoder().encode('Exif\0\0'),4);
  const image = new Blob([jpeg.subarray(0,2),segment,jpeg.subarray(2)]);
  const whole = vi.spyOn(image, 'arrayBuffer').mockRejectedValue(Error('whole-file read'));
  const slice = vi.spyOn(image, 'slice');
  expect(await probeImageMetadata(image)).toEqual({mime:'image/jpeg',width:3,height:5});
  expect(whole).not.toHaveBeenCalled();
  expect(slice.mock.calls.reduce((total,[start,end])=>total+(end!-start!),0)).toBeLessThan(128);
});
it('exposes oversized PNG, JPEG and extended WebP dimensions before allocating pixels', async () => {
  const png = bytes('png'), view = new DataView(png.buffer);view.setUint32(16,60000);view.setUint32(20,60000);
  expect(await probeImageMetadata(new Blob([png]))).toMatchObject({width:60000,height:60000});
  const jpeg = bytes('jpeg'), frame = jpeg.findIndex((byte,index)=>byte===255&&jpeg[index+1]===0xc0), jpegView=new DataView(jpeg.buffer);
  jpegView.setUint16(frame+5,60000);jpegView.setUint16(frame+7,60000);
  expect(await probeImageMetadata(new Blob([jpeg]))).toMatchObject({width:60000,height:60000});
  const webp = bytes('vp8x');webp.fill(255,24,30);
  expect(await probeImageMetadata(new Blob([webp]))).toMatchObject({width:16777216,height:16777216});
});
it('rejects truncated or malformed headers and bounds pathological JPEG marker streams', async () => {
  expect(await probeImageMetadata(new Blob([bytes('png').subarray(0,23)]))).toBeUndefined();
  expect(await probeImageMetadata(new Blob([bytes('vp8l').subarray(0,25)]))).toBeUndefined();
  expect(await probeImageMetadata(new Blob([new Uint8Array([255,0xd8,255,0xe1,0,0])]))).toBeUndefined();
  const repeated = new Uint8Array(2400);for(let at=0;at<repeated.length;at+=4)repeated.set([255,0xe2,0,2],at);
  const image = new Blob([new Uint8Array([255,0xd8]),repeated,bytes('jpeg').subarray(2)]), slice=vi.spyOn(image,'slice');
  expect(await probeImageMetadata(image)).toBeUndefined();expect(slice).toHaveBeenCalledTimes(513);
});
