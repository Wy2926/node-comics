import {msg} from '../../i18n/runtime';
/** Bounded local MOBI image import. No ebook HTML is ever executed or rendered.
 * Supports DRM-free MOBI6/PalmDOC (including MOBI6+KF8 combo books).
 * The record table and text references determine image order; HD/KF8 resources
 * are not blindly appended, so thumbnails and duplicate renditions stay out.
 */
import {throwIfAborted, type DocumentSession, type IndexedPage, type RandomAccessSource} from './contracts';

const MAX_TEXT = 16 * 1024 * 1024;
const MAX_PAGES = 1500;
const decoder = new TextDecoder('utf-8');
function fail(message: string): never { throw new Error(message); }
function u16(b: Uint8Array, n: number) { if (n + 2 > b.length) fail(msg("MOBI 文件头不完整。")); return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint16(n); }
function u32(b: Uint8Array, n: number) { if (n + 4 > b.length) fail(msg("MOBI 记录越界或已损坏。")); return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(n); }
function ascii(b: Uint8Array, start: number, length: number) { return String.fromCharCode(...b.subarray(start, start + length)); }

export function decompressPalmDoc(input: Uint8Array, limit = MAX_TEXT): Uint8Array {
  const output: number[] = [];
  for (let i = 0; i < input.length;) {
    const c = input[i++];
    if (c > 0 && c <= 8) {
      if (i + c > input.length) fail(msg("MOBI 文本压缩块不完整。"));
      for (let j = 0; j < c; j++) output.push(input[i++]);
    } else if (c < 128) output.push(c);
    else if (c >= 192) output.push(32, c ^ 128);
    else {
      if (i >= input.length) fail(msg("MOBI 回溯引用不完整。"));
      const packed = ((c & 63) << 8) | input[i++];
      const distance = packed >> 3;
      if (!distance || distance > output.length) fail(msg("MOBI 文本回溯引用无效。"));
      for (let j = 0; j < (packed & 7) + 3; j++) output.push(output[output.length - distance]);
    }
    if (output.length > limit) fail(msg("MOBI 文本展开超过安全限制。"));
  }
  return Uint8Array.from(output);
}

function withoutTrailers(input: Uint8Array, flags: number): Uint8Array {
  let end = input.length;
  for (let bits = flags >>> 1; bits; bits >>>= 1) {
    if (!(bits & 1)) continue;
    let size = 0, shift = 0, found = false;
    for (let pos = end - 1; pos >= Math.max(0, end - 4); pos--) {
      const c = input[pos]; size |= (c & 127) << shift; shift += 7;
      if (c & 128) { found = true; break; }
    }
    if (!found || size <= 0 || size > end) fail(msg("MOBI 文本附加记录无效。"));
    end -= size;
  }
  if (flags & 1) {
    if (!end) fail(msg("MOBI 文本附加记录缺失。"));
    end -= (input[end - 1] & 3) + 1;
  }
  if (end < 0) fail(msg("MOBI 文本附加记录越界。"));
  return input.subarray(0, end);
}

function imageInfo(b: Uint8Array): { mime: string; width?: number; height?: number } | undefined {
  if (ascii(b, 0, 4) === 'GIF8' && b.length >= 10)
    return { mime: 'image/gif', width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) };
  if (b.length >= 24 && ascii(b, 1, 3) === 'PNG' && b[0] === 137)
    return { mime: 'image/png', width: u32(b, 16), height: u32(b, 20) };
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) {
    let pos = 2;
    while (pos + 9 < b.length) {
      if (b[pos++] !== 255) break;
      while (b[pos] === 255) pos++;
      const marker = b[pos++];
      if (marker === 217 || marker === 218) break;
      if (marker === 216 || (marker >= 208 && marker <= 215)) continue;
      const length = u16(b, pos);
      if (length < 2 || pos + length > b.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker))
        return { mime: 'image/jpeg', width: u16(b, pos + 5), height: u16(b, pos + 3) };
      pos += length;
    }
    return { mime: 'image/jpeg' };
  }
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return { mime: 'image/webp' };
  return undefined;
}

export function openMobiDocument(source: RandomAccessSource): DocumentSession {
  let pages: IndexedPage[] | undefined, closed = false;
  let offsets: number[] = [];
  let readBytes = 0;
  const capabilities = {access: 'random' as const, remote: false, encrypted: false as const, multiVolume: false as const, indexComplete: false};
  const read = async (offset: number, length: number, signal?: AbortSignal) => {
    throwIfAborted(signal); readBytes += length;
    if (readBytes > 16 * 1024 * 1024) fail('MOBI 目录读取超过 16 MB 安全预算。');
    return source.readAt(offset, length, signal);
  };
  return {
    capabilities,
    async index(signal) {
      throwIfAborted(signal);
      if (closed) fail('MOBI 会话已关闭。');
      if (pages) return pages;
      readBytes = 0;
      const header = await read(0, 78, signal);
      if (header.length < 78 || ascii(header, 60, 8) !== 'BOOKMOBI') fail('文件不是可识别的 MOBI 漫画。');
      const count = u16(header, 76);
      if (!count || 78 + count * 8 > source.snapshot.size) fail('MOBI 记录表已损坏。');
      const table = await read(78, count * 8, signal);
      offsets = Array.from({length: count}, (_, i) => u32(table, i * 8)); offsets.push(source.snapshot.size);
      if (offsets[0] < 78 + count * 8 || offsets.some((value, i) => i > 0 && value <= offsets[i - 1])) fail('MOBI 记录表范围或顺序无效。');
      const record = async (index: number) => {
        if (index < 0 || index >= count || offsets[index + 1] - offsets[index] > MAX_TEXT) fail('MOBI 记录超出安全限制。');
        return read(offsets[index], offsets[index + 1] - offsets[index], signal);
      };
      const first = await record(0);
      if (first.length < 132 || ascii(first, 16, 4) !== 'MOBI') fail('不支持此 MOBI 文件头。');
      if (u16(first, 12) !== 0) fail('此 MOBI 受 DRM 加密保护。');
      const version = u32(first, 36), compression = u16(first, 0), textRecords = u16(first, 8);
      if (version > 7) fail('暂不支持独立 KF8/AZW3。');
      if (![1, 2].includes(compression)) fail('暂不支持此 MOBI 的 HUFF/CDIC 压缩。');
      if (textRecords >= count || u32(first, 4) > MAX_TEXT) fail('MOBI 正文超过安全限制。');
      const firstImage = u32(first, 108);
      if (firstImage >= count) fail('MOBI 中没有可读取的漫画图片。');
      const flags = first.length > 243 && u32(first, 20) >= 228 ? u16(first, 242) : 0;
      let text = '', expanded = 0;
      for (let index = 1; index <= textRecords; index++) {
        const bytes = withoutTrailers(await record(index), flags);
        const part = compression === 2 ? decompressPalmDoc(bytes, MAX_TEXT - expanded) : bytes;
        expanded += part.length;
        if (expanded > MAX_TEXT) fail('MOBI 正文展开超过安全限制。');
        text += decoder.decode(part);
      }
      const refs = [...text.matchAll(/<img\b[^>]*\brecindex\s*=\s*["']?(\d+)/gi)].map(match => Number(match[1]));
      if (!refs.length) fail('未找到漫画正文图片引用。');
      if (refs.length > MAX_PAGES) fail('单卷最多支持 1500 张图片。');
      pages = refs.map((reference, ordinal) => {
        const record = firstImage + reference - 1;
        if (record < firstImage || record >= count) fail(`第 ${ordinal + 1} 页的图片记录不存在。`);
        if (offsets[record + 1] - offsets[record] > 32 * 1024 * 1024) fail(`第 ${ordinal + 1} 页超过 32 MB。`);
        return {ordinal, name: `第 ${ordinal + 1} 页`, locator: {record, offset: offsets[record], length: offsets[record + 1] - offsets[record], occurrence: ordinal}};
      });
      capabilities.indexComplete = true;
      return pages;
    },
    async materialize(page, signal) {
      throwIfAborted(signal);
      if (closed) fail('MOBI 会话已关闭。');
      if (!pages) await this.index(signal);
      const expected = pages!.find(item => item.ordinal === page.ordinal);
      if (!expected || JSON.stringify(expected.locator) !== JSON.stringify(page.locator)) fail('MOBI 页面索引不属于当前文件。');
      const {offset, length} = expected.locator;
      const bytes = await source.readAt(offset as number, length as number, signal);
      const info = imageInfo(bytes.subarray(0, 65536));
      if (!info) fail(`第 ${page.ordinal + 1} 页不是支持的漫画图片。`);
      if (info.width && info.height && (info.width * info.height > 40_000_000 || Math.max(info.width, info.height) > 30000)) fail('MOBI 页面尺寸超出阅读器安全限制。');
      throwIfAborted(signal);
      return new Blob([new Uint8Array(bytes)], {type: info.mime});
    },
    async close() { closed = true; pages = undefined; offsets = []; },
  };
}
