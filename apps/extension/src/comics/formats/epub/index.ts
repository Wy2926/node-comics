import Book from "epubjs/src/book.js";
import Packaging from "epubjs/src/packaging.js";
import Navigation from "epubjs/src/navigation.js";
import type Section from "epubjs/types/section";
import type { NavItem } from "epubjs/types/navigation";
import type { RenditionOptions } from "epubjs/types/rendition";
import type Contents from "epubjs/types/contents";
import {
  throwIfAborted,
  type EpubIndex,
  type EpubTocItem,
  type RandomAccessSource,
} from "../contracts";
import { MAX_ENTRIES } from "../limits";
import {
  EPUB_ORIGIN,
  epubPath,
  epubUrl,
  openEpubArchive,
  type EpubArchive,
} from "./archive";
import { EpubResources, TRANSLATABLE_EPUB_IMAGE } from "./resources";

export interface EpubSession {
  readonly index: EpubIndex;
  readonly book: Book;
  readonly signal?: AbortSignal;
  render(
    element: Element,
    options?: RenditionOptions,
  ): ReturnType<Book["renderTo"]>;
  close(): Promise<void>;
}

async function metadata(archive: EpubArchive, signal?: AbortSignal) {
  const container = await archive.xml("META-INF/container.xml", signal);
  const rootfile = Array.from(
    container.getElementsByTagNameNS("*", "rootfile"),
  ).find(
    (element) =>
      element.getAttribute("media-type") === "application/oebps-package+xml",
  );
  const declaredPath = rootfile?.getAttribute("full-path");
  if (!declaredPath) throw new Error("EPUB 缺少内容清单。");
  const packagePath = epubPath(declaredPath);
  const packageUrl = epubUrl(packagePath);
  const document = await archive.xml(packagePath, signal);
  if (document.documentElement.localName !== "package")
    throw new Error("EPUB 内容清单无效。");
  const items = Array.from(document.getElementsByTagNameNS("*", "item"));
  const identifiers = new Set<string>();
  const mediaTypes = new Map<string, string>();
  for (const item of items) {
    const id = item.getAttribute("id");
    if (
      !id ||
      identifiers.has(id) ||
      ["__proto__", "constructor", "prototype"].includes(id)
    ) {
      throw new Error("EPUB 资源标识无效或重复。");
    }
    identifiers.add(id);
    try {
      const path = epubPath(item.getAttribute("href") ?? "", packageUrl);
      const type = (item.getAttribute("media-type") ?? "").split(";")[0].trim().toLowerCase();
      mediaTypes.set(path, type);
      // One canonical package-relative address space also gives the renderer stable hrefs.
      item.setAttribute("href", new URL(epubUrl(path)).pathname);
    } catch {
      // External resources are not fetched. A remote spine item is rejected below.
    }
  }
  const packaging = new Packaging(document);
  if (!packaging.spine.length || packaging.spine.length > MAX_ENTRIES)
    throw new Error("EPUB 阅读顺序无效。");
  const chapters = packaging.spine.map((item) => {
    const resource = packaging.manifest[item.idref];
    if (
      !resource ||
      !["application/xhtml+xml", "text/html"].includes(resource.type)
    ) {
      throw new Error("EPUB 包含不支持的正文格式。");
    }
    const path = epubPath(resource.href, packageUrl);
    if (!archive.has(path)) throw new Error("EPUB 缺少正文章节。");
    return {
      id: `${item.index}:${item.idref}`,
      href: new URL(epubUrl(path)).pathname.slice(1),
      label: item.idref,
    };
  });
  const chaptersByHref = new Map(
    chapters.map((chapter) => [chapter.href, chapter]),
  );
  const labeled = new Set<string>();
  const navigationHref = packaging.navPath || packaging.ncxPath;
  let toc: EpubTocItem[] = [];
  let navigationDocument: XMLDocument | undefined;
  let navigationPath: string | undefined;
  if (navigationHref) {
    navigationPath = epubPath(navigationHref, packageUrl);
    navigationDocument = await archive.xml(navigationPath, signal);
    const navigation = new Navigation(navigationDocument);
    let count = 0;
    const normalize = (items: NavItem[], depth: number): EpubTocItem[] => {
      if (depth > 32) throw new Error("EPUB 目录层级超过安全限制。");
      return items.flatMap((item) => {
        if (++count > MAX_ENTRIES) throw new Error("EPUB 目录超过 10000 项。");
        const children = item.subitems?.length
          ? normalize(item.subitems, depth + 1)
          : undefined;
        try {
          const path = epubPath(item.href, epubUrl(navigationPath!));
          const fragment = new URL(item.href, epubUrl(navigationPath!)).hash;
          const href = new URL(epubUrl(path)).pathname.slice(1) + fragment;
          const label = item.label.trim() || path.split("/").at(-1)!;
          const chapter = chaptersByHref.get(href.split("#")[0]);
          if (!chapter) return children ?? [];
          if (!labeled.has(chapter.id)) {
            chapter.label = label;
            labeled.add(chapter.id);
          }
          return [{ href, label, ...(children?.length ? { children } : {}) }];
        } catch {
          return children ?? [];
        }
      });
    };
    toc = normalize(navigation.toc, 0);
  }
  const index: EpubIndex = {
    kind: "epub",
    title: packaging.metadata.title?.trim() || "",
    chapters,
    toc,
    images: [...mediaTypes].filter(([href, type]) => TRANSLATABLE_EPUB_IMAGE.test(type) && archive.has(href))
      .map(([href, mediaType]) => ({href, mediaType})),
  };
  if (packaging.coverPath) {
    try {
      const path = epubPath(packaging.coverPath, packageUrl);
      const mediaType = mediaTypes.get(path);
      if (archive.has(path) && mediaType && /^image\//.test(mediaType))
        index.cover = { href: path, mediaType };
    } catch {
      // An external cover does not make the text unreadable.
    }
  }
  return {
    index,
    mediaTypes,
    packagePath,
    document,
    navigationPath,
    navigationDocument,
  };
}

export async function indexEpub(
  source: RandomAccessSource,
  signal?: AbortSignal,
): Promise<EpubIndex> {
  const archive = await openEpubArchive(source, signal);
  try {
    return (await metadata(archive, signal)).index;
  } finally {
    await archive.close();
  }
}

/** Materialize a real embedded image, never a screenshot of EPUB text. */
export async function readEpubImage(source: RandomAccessSource, href: string, signal?: AbortSignal): Promise<Blob> {
  const archive = await openEpubArchive(source, signal);
  try {
    const parsed = await metadata(archive, signal);
    const image = parsed.index.images?.find(image => image.href === href);
    if (!image) throw new Error("EPUB 图片不在内容清单中。");
    return await archive.read(image.href, image.mediaType, signal);
  } finally {
    await archive.close();
  }
}

export async function openEpub(
  source: RandomAccessSource,
  signal?: AbortSignal,
): Promise<EpubSession> {
  const archive = await openEpubArchive(source, signal);
  let book: Book | undefined;
  let resources: EpubResources | undefined;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const close = () => {
    if (closePromise) return closePromise;
    closed = true;
    resources?.close();
    book?.destroy();
    signal?.removeEventListener("abort", onAbort);
    closePromise = archive.close();
    return closePromise;
  };
  const onAbort = () => {
    void close();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const parsed = await metadata(archive, signal);
    throwIfAborted(signal);
    resources = new EpubResources(archive, parsed.mediaTypes);
    const request = async (href: string) => {
      throwIfAborted(signal);
      if (closed) throw new Error("EPUB 会话已关闭。");
      const path = epubPath(href);
      if (path === parsed.packagePath) return parsed.document;
      if (path === parsed.navigationPath) return parsed.navigationDocument!;
      return archive.xml(path, signal);
    };
    book = new Book({ requestMethod: request, replacements: "none" });
    // No library-managed ZIP, network client, localforage store, or global resource preloading.
    await book.open(epubUrl(parsed.packagePath), "opf");
    await book.ready;
    throwIfAborted(signal);
    const activeBook = book;
    const activeResources = resources;
    const loadedSections = new Map<string, Section>();
    book.spine.hooks.content.register(
      async (document: Document, section: Section) => {
        throwIfAborted(signal);
        await activeResources.sanitize(document, section.url, section.href);
        loadedSections.set(section.href, section);
        throwIfAborted(signal);
      },
    );
    return {
      index: parsed.index,
      book,
      signal,
      render(element, options = {}) {
        throwIfAborted(signal);
        if (closed) throw new Error("EPUB 会话已关闭。");
        const safeOptions: RenditionOptions & {
          allowPopups: boolean;
          method: string;
        } = {
          ...options,
          manager: "default",
          view: "iframe",
          // Preserve XML parsing semantics; srcdoc would reparse untrusted XHTML as HTML.
          method: "blobUrl",
          script: undefined,
          stylesheet: undefined,
          allowScriptedContent: false,
          allowPopups: false,
        };
        const rendition = activeBook.renderTo(element, safeOptions);
        rendition.hooks.content.register((contents: Contents) => {
          contents.document.addEventListener(
            "click",
            (event) => {
              const target =
                (event.target as Node | null)?.nodeType === 1
                  ? (event.target as Element).closest("a")
                  : undefined;
              if (!target) return;
              event.preventDefault();
              event.stopImmediatePropagation();
              const href = target.getAttribute("data-nc-epub-href");
              if (!href || closed) return;
              const url = new URL(href, EPUB_ORIGIN);
              if (activeBook.spine.get(url.pathname)) {
                void rendition.display(url.pathname + url.hash);
              }
            },
            { capture: true },
          );
        });
        rendition.hooks.unloaded.register((view: { section: Section }) => {
          activeResources.release(view.section.href);
          loadedSections.delete(view.section.href);
          view.section.unload();
        });
        // DefaultViewManager.clear() destroys frames without an unloaded event.
        // Retain only currently displayed sections, including their source blob URLs.
        rendition.on('rendered', () => {
          const visible = new Set<string>();
          rendition.views().forEach(view => visible.add((view as unknown as {section: Section}).section.href));
          for (const [href, section] of loadedSections) if (!visible.has(href)) {
            activeResources.release(href);
            section.unload();
            loadedSections.delete(href);
          }
        });
        return rendition;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
