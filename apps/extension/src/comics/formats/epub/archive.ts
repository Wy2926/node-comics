import {
  Reader,
  ZipReader,
  type FileEntry,
} from "@zip.js/zip.js/index-native.js";
import { MAX_ENTRIES, MAX_EXPANDED, MAX_FILE, MiB } from "../limits";
import { throwIfAborted, type RandomAccessSource } from "../contracts";

const MAX_TEXT = 16 * MiB;
const DIRECTORY_BUDGET = 16 * MiB;
export const EPUB_ORIGIN = "https://epub.node-comics.invalid";

/** This origin is an in-memory address space. It is never requested over the network. */
export function epubPath(href: string, base = `${EPUB_ORIGIN}/`): string {
  const url = new URL(href, base);
  if (
    url.origin !== EPUB_ORIGIN ||
    url.username ||
    url.password ||
    url.search
  ) {
    throw new Error("EPUB 资源不属于当前文件。");
  }
  const path = decodeURIComponent(url.pathname).slice(1);
  if (
    !path ||
    /[\\\u0000-\u001f\u007f]/.test(path) ||
    path.split("/").some((part) => part === ".." || part === ".")
  ) {
    throw new Error("EPUB 资源路径无效。");
  }
  return path;
}

export function epubUrl(path: string): string {
  return `${EPUB_ORIGIN}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export function parseEpubXml(text: string): XMLDocument {
  if (/<!ENTITY\s/i.test(text) || /<!DOCTYPE[^>]*\[/i.test(text)) {
    throw new Error("EPUB XML 不允许自定义实体。");
  }
  const document = new DOMParser().parseFromString(text, "application/xml");
  if (
    !document.documentElement ||
    document.getElementsByTagName("parsererror").length
  ) {
    throw new Error("EPUB XML 文档无效。");
  }
  return document;
}

export interface EpubArchive {
  has(path: string): boolean;
  read(path: string, mediaType?: string, signal?: AbortSignal): Promise<Blob>;
  text(path: string, signal?: AbortSignal): Promise<string>;
  xml(path: string, signal?: AbortSignal): Promise<XMLDocument>;
  close(): Promise<void>;
}

/** A serialized, bounded ZIP bridge: no whole-book buffer or second persistent cache. */
export async function openEpubArchive(
  source: RandomAccessSource,
  signal?: AbortSignal,
): Promise<EpubArchive> {
  throwIfAborted(signal);
  if (!source.snapshot.local) throw new Error("EPUB 需要先下载完整源文件。");
  if (
    !Number.isSafeInteger(source.snapshot.size) ||
    source.snapshot.size <= 0 ||
    source.snapshot.size > MAX_FILE
  ) {
    throw new Error("EPUB 文件大小超过支持范围。");
  }
  const lifetime = new AbortController();
  let activeSignal = signal;
  let read = 0;
  let budget = DIRECTORY_BUDGET;
  let closed = false;
  let pending: Promise<unknown> = Promise.resolve();
  class RangeReader extends Reader<RandomAccessSource> {
    constructor() {
      super(source);
      this.size = source.snapshot.size;
    }
    override async readUint8Array(offset: number, length: number) {
      throwIfAborted(activeSignal);
      length = Math.min(length, this.size - offset);
      read += length;
      if (read > budget) throw new Error("EPUB 本次读取超过安全预算。");
      return source.readAt(offset, length, activeSignal);
    }
  }
  const reader = new ZipReader(new RangeReader(), {
    useWebWorkers: false,
    useCompressionStream: true,
    checkSignature: true,
  });
  const entries = new Map<string, FileEntry>();
  try {
    let count = 0;
    let expanded = 0;
    activeSignal = AbortSignal.any([
      lifetime.signal,
      AbortSignal.timeout(60_000),
      ...(signal ? [signal] : []),
    ]);
    for await (const entry of reader.getEntriesGenerator()) {
      throwIfAborted(activeSignal);
      if (++count > MAX_ENTRIES) throw new Error("EPUB 目录超过 10000 项。");
      if (entry.zip64 || entry.diskNumberStart)
        throw new Error("EPUB 暂不支持 ZIP64 或分卷。");
      if (entry.directory) continue;
      const name = entry.filename;
      if (
        !name ||
        name.startsWith("/") ||
        /[\\\u0000-\u001f\u007f]/.test(name) ||
        name.split("/").some((part) => !part || part === "." || part === "..")
      ) {
        throw new Error("EPUB 资源路径无效。");
      }
      if (entries.has(name)) throw new Error("EPUB 中存在重复资源路径。");
      if (entry.encrypted) throw new Error("暂不支持加密 EPUB。");
      if (
        !Number.isSafeInteger(entry.uncompressedSize) ||
        entry.uncompressedSize < 0 ||
        entry.uncompressedSize > 1024 * Math.max(1, entry.compressedSize)
      ) {
        throw new Error("EPUB 解压倍率超过安全限制。");
      }
      expanded += entry.uncompressedSize;
      if (expanded > MAX_EXPANDED)
        throw new Error("EPUB 展开大小超过安全限制。");
      entries.set(name, entry);
    }
  } catch (error) {
    lifetime.abort();
    await reader.close();
    throw error;
  }

  const archive: EpubArchive = {
    has: (path) => entries.has(path),
    async read(path, mediaType = "application/octet-stream", requestSignal) {
      const operation = pending
        .catch(() => {})
        .then(async () => {
          throwIfAborted(requestSignal);
          if (closed) throw new Error("EPUB 会话已关闭。");
          const entry = entries.get(path);
          if (!entry) throw new Error("EPUB 缺少包内资源。");
          activeSignal = AbortSignal.any([
            lifetime.signal,
            AbortSignal.timeout(60_000),
            ...(requestSignal ? [requestSignal] : []),
          ]);
          read = 0;
          budget = entry.compressedSize + DIRECTORY_BUDGET;
          let written = 0;
          const chunks: Uint8Array<ArrayBuffer>[] = [];
          await entry.getData(
            new WritableStream<Uint8Array>({
              write(chunk) {
                written += chunk.byteLength;
                if (written > entry.uncompressedSize)
                  throw new Error("EPUB 实际展开大小超过声明。");
                chunks.push(new Uint8Array(chunk));
              },
            }),
            { signal: activeSignal },
          );
          throwIfAborted(activeSignal);
          if (written !== entry.uncompressedSize)
            throw new Error("EPUB 资源大小与目录不符。");
          return new Blob(chunks, { type: mediaType });
        });
      pending = operation;
      return operation;
    },
    async text(path, requestSignal) {
      const entry = entries.get(path);
      if (!entry || entry.uncompressedSize > MAX_TEXT)
        throw new Error("EPUB 文档大小超过安全限制。");
      return (
        await archive.read(path, "application/xml", requestSignal)
      ).text();
    },
    async xml(path, requestSignal) {
      return parseEpubXml(await archive.text(path, requestSignal));
    },
    async close() {
      if (closed) return;
      closed = true;
      lifetime.abort();
      await pending.catch(() => {});
      entries.clear();
      await reader.close();
    },
  };
  try {
    const mimetype = entries.get("mimetype");
    if (
      !mimetype ||
      mimetype.uncompressedSize > 64 ||
      (
        await (await archive.read("mimetype", "text/plain", signal)).text()
      ).trim() !== "application/epub+zip"
    ) {
      throw new Error("文件不是有效的 EPUB 容器。");
    }
    if (archive.has("META-INF/encryption.xml")) {
      const encryption = await archive.xml("META-INF/encryption.xml", signal);
      if (encryption.getElementsByTagNameNS("*", "EncryptedData").length)
        throw new Error("暂不支持加密 EPUB。");
    }
    return archive;
  } catch (error) {
    await archive.close();
    throw error;
  }
}
