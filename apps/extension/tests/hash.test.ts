import {createHash} from 'node:crypto';
import {describe, expect, it, vi} from 'vitest';
import {hashFile, imageIdentity, Sha256} from '../src/importers/hash';

const reference = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
describe('bounded SHA-256 identities', () => {
  it.each([0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 129, 1025])('matches SHA-256 padding and split boundaries at %i bytes', length => {
    const bytes = Uint8Array.from({length}, (_, i) => (i * 31 + 17) & 255);
    const hash = new Sha256();
    for (let i = 0; i < length; i += 7) hash.update(bytes.subarray(i, i + 7));
    expect(hash.digest()).toBe(reference(bytes));
  });
  it('matches the standard million-a vector', () => {
    const hash = new Sha256();
    for (let i = 0; i < 1000; i++) hash.update(new Uint8Array(1000).fill(97));
    expect(hash.digest()).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  });
  it('reads large files in at most 1 MiB slices, never a whole-file arrayBuffer', async () => {
    const bytes = Uint8Array.from({length: 3 * 1024 * 1024 + 65}, (_, i) => i & 255);
    const blob = new Blob([bytes]);
    const wholeRead = vi.spyOn(blob, 'arrayBuffer').mockRejectedValue(Error('whole file read'));
    const slice = vi.spyOn(blob, 'slice');const progress = vi.fn();
    expect(await hashFile(blob, progress)).toBe(reference(bytes));
    expect(wholeRead).not.toHaveBeenCalled();expect(slice).toHaveBeenCalledTimes(4);
    expect(slice.mock.calls.every(([start, end]) => end! - start! <= 1024 * 1024)).toBe(true);
    expect(progress).toHaveBeenLastCalledWith(bytes.length, bytes.length);
  });
  it('identifies independently imported and website images by their own bytes + zero, regardless of name/order', async () => {
    const first = await imageIdentity(new File(['original bytes'], '2.png'));
    const renamed = await imageIdentity(new File(['original bytes'], 'renamed.png'));
    const fromWebsite = await imageIdentity(new Blob(['original bytes']));
    expect(first).toEqual({fileHash: reference('original bytes'),imageSha256:reference('original bytes'), pageIndex: 0});
    expect(renamed).toEqual(first);expect(fromWebsite).toEqual(first);
    expect((await imageIdentity(new File(['different'], '2.png'))).fileHash).not.toBe(first.fileHash);
  });
});
