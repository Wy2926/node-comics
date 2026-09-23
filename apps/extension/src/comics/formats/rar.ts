import {createExtractorFromData} from 'node-unrar-js/esm/index.esm';
import wasmUrl from 'node-unrar-js/esm/js/unrar.wasm?url';
import {MAX_ENTRIES, MAX_PAGE, MiB, imageMime, validateEntries} from './limits';
import {throwIfAborted, type DocumentSession, type IndexedPage, type RandomAccessSource} from './contracts';

/** This driver runs in a terminable Worker and is deliberately local-only. */
export async function openRarDocument(source: RandomAccessSource): Promise<DocumentSession> {
  if (!source.snapshot.local) throw new Error('CBR 暂不支持云端范围读取，请下载后从本地导入。');
  if (source.snapshot.size > 128 * MiB) throw new Error('CBR 解码会话最多支持 128 MB，请转换为 CBZ。');
  const data = new Uint8Array(source.snapshot.size);
  for (let offset = 0; offset < data.length; offset += MiB) data.set(await source.readAt(offset, Math.min(MiB, data.length - offset)), offset);
  const wasm = await fetch(wasmUrl);
  if (!wasm.ok) throw new Error('RAR 解码器加载失败。');
  const extractor = await createExtractorFromData({data: data.buffer, wasmBinary: await wasm.arrayBuffer()});
  const list = extractor.getFileList();
  if (list.arcHeader.flags.volume) throw new Error('暂不支持 RAR 分卷。');
  if (list.arcHeader.flags.headerEncrypted) throw new Error('暂不支持加密 RAR。');
  const entries = [];
  for (const header of list.fileHeaders) {
    if (entries.length >= MAX_ENTRIES) throw new Error('RAR 目录超过 10000 项。');
    entries.push({name: header.name, size: header.unpSize, encrypted: header.flags.encrypted, directory: header.flags.directory});
  }
  const images = validateEntries(entries.filter(entry => !entry.directory), 256 * MiB);
  const pages: IndexedPage[] = images.map((entry, ordinal) => ({ordinal, name: entry.name, locator: {entry: entry.name}}));
  const io = extractor as unknown as {write(fd: number, buf: number, size: number): boolean};
  const write = io.write.bind(extractor); let written = 0;
  io.write = (fd, buf, size) => {
    written += size;
    if (size < 0 || written > MAX_PAGE) throw new Error('RAR 实际输出超过 32 MB 安全限制。');
    return write(fd, buf, size);
  };
  return {
    capabilities: {access: 'full-buffer', remote: false, solid: list.arcHeader.flags.solid, encrypted: false, multiVolume: false, indexComplete: true},
    async index(signal) { throwIfAborted(signal); return pages; },
    async materialize(page, signal) {
      throwIfAborted(signal);
      const image = images.find(entry => entry.name === page.locator.entry);
      if (!image) throw new Error('RAR 页面索引不属于当前文件。');
      written = 0;
      // UnRAR skips preceding output; the extraction iterator must be exhausted to release its handle.
      let result: Blob | undefined;
      try {
        for (const file of extractor.extract({files: header => header.name === image.name}).files) {
          throwIfAborted(signal);
          if (!file.extraction || file.extraction.length !== image.size) throw new Error('RAR 图片数据不完整。');
          result = new Blob([new Uint8Array(file.extraction)], {type: imageMime(image.name)});
        }
      } finally {
        // node-unrar-js retains extracted DataFiles internally; remove requested output immediately.
        const files = extractor as unknown as {dataFiles: Record<string, unknown>; dataFileMap: Record<string, string>};
        for (const key of Object.keys(files.dataFiles)) if (key.startsWith('*Extracted*/')) delete files.dataFiles[key];
        for (const [fd, name] of Object.entries(files.dataFileMap)) if (name.startsWith('*Extracted*/')) delete files.dataFileMap[fd];
      }
      if (!result) throw new Error('RAR 中找不到目标图片。');
      return result;
    },
    async close() { /* Worker termination frees WASM and its full-buffer input. */ },
  };
}
