import {Reader, ZipReader, type Entry} from '@zip.js/zip.js/index-native.js';
import {MAX_ENTRIES, MAX_PAGE, MiB, imageMime, validateEntries} from './limits';
import {throwIfAborted, type DocumentSession, type IndexedPage, type RandomAccessSource} from './contracts';

export function openZipDocument(source: RandomAccessSource): DocumentSession {
  let activeSignal: AbortSignal | undefined, read = 0, budget = 16 * MiB;
  class RangeReader extends Reader<RandomAccessSource> {
    constructor() { super(source); this.size = source.snapshot.size; }
    override async readUint8Array(offset: number, length: number) {
      throwIfAborted(activeSignal);
      length = Math.min(length, this.size - offset);
      read += length;
      if (read > budget) throw new Error('ZIP 本次目录或页面读取超过安全预算，请拆分文件。');
      return source.readAt(offset, length, activeSignal);
    }
  }
  const reader = new ZipReader(new RangeReader(), {useWebWorkers: false, useCompressionStream: true, checkSignature: true});
  let images: {name: string; size: number; encrypted: boolean; entry: Entry}[] | undefined;
  let pages: IndexedPage[] | undefined;
  let closed = false;
  const capabilities = {access: 'random' as const, remote: true, encrypted: false as const, multiVolume: false as const, indexComplete: false};
  return {
    capabilities,
    async index(signal) {
      throwIfAborted(signal);
      if (closed) throw new Error('ZIP 会话已关闭。');
      if (pages) return pages;
      activeSignal = signal; read = 0; budget = 16 * MiB;
      const entries = [];
      for await (const entry of reader.getEntriesGenerator()) {
        throwIfAborted(signal);
        if (entries.length >= MAX_ENTRIES) throw new Error('压缩包目录超过 10000 项。');
        if (entry.zip64) throw new Error('ZIP64 尚未开放，请转换为普通 CBZ。');
        if (entry.diskNumberStart) throw new Error('暂不支持 ZIP 分卷。');
        if (!entry.directory && entry.uncompressedSize > 1024 * Math.max(1, entry.compressedSize)) throw new Error('ZIP 解压倍率超过安全限制。');
        entries.push({name: entry.filename, size: entry.uncompressedSize, encrypted: entry.encrypted, entry});
      }
      images = validateEntries(entries.filter(item => !item.entry.directory));
      pages = images.map((item, ordinal) => ({ordinal, name: item.name, locator: {entry: item.name}}));
      capabilities.indexComplete = true;
      return pages;
    },
    async materialize(page, signal) {
      throwIfAborted(signal);
      if (closed) throw new Error('ZIP 会话已关闭。');
      if (!images) await this.index(signal);
      const item = images!.find(value => value.name === page.locator.entry);
      if (!item || item.entry.directory) throw new Error('ZIP 页面索引不属于当前文件。');
      activeSignal = signal; read = 0; budget = 40 * MiB;
      let written = 0;
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      const stream = new WritableStream<Uint8Array>({write(chunk) {
        written += chunk.byteLength;
        if (written > MAX_PAGE || written > item.size) throw new Error('ZIP 实际展开大小超过声明或安全限制。');
        chunks.push(new Uint8Array(chunk));
      }});
      await item.entry.getData(stream, {signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000)});
      if (written !== item.size) throw new Error('ZIP 图片大小与目录不符。');
      return new Blob(chunks, {type: imageMime(item.name)});
    },
    async close() { if (closed) return; closed = true; await reader.close(); },
  };
}
