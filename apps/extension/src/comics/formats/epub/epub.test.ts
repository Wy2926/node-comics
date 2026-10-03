import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  BlobReader,
  Uint8ArrayWriter,
  ZipWriter,
} from "@zip.js/zip.js/index-native.js";
import {
  DOMParser as XmlDomParser,
  XMLSerializer as XmlDomSerializer,
} from "@xmldom/xmldom";
import type { RandomAccessSource } from "../contracts";
import {
  epubPath,
  epubUrl,
  openEpubArchive,
  parseEpubXml,
  type EpubArchive,
} from "./archive";
import { indexEpub, readEpubImage } from "./index";
import { EpubResources } from "./resources";
import {
  epubProgression,
  initializeEpubLocation,
  resizeEpub,
  restoreEpubLocation,
  settleEpubLayout,
  turnEpub,
} from "./location";
import type Rendition from "epubjs/types/rendition";
import type { EpubSession } from "./index";

beforeAll(() => {
  class StrictXmlParser extends XmlDomParser {
    constructor() {
      super({
        onError() {
          throw new Error("Invalid XML");
        },
      });
    }
  }
  vi.stubGlobal("DOMParser", StrictXmlParser);
  vi.stubGlobal("XMLSerializer", XmlDomSerializer);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
});
afterEach(() => vi.restoreAllMocks());

it('uses viewport page turns in continuous EPUB and only crosses chapters at an edge', async () => {
  const container = {scrollTop: 0, scrollHeight: 2500, clientHeight: 900};
  const rendition = {manager: {container, isPaginated: false, settings: {axis: 'vertical'}, scrollTo: vi.fn((_left, top) => {container.scrollTop = top;})},
    next: vi.fn(), prev: vi.fn(), reportLocation: vi.fn()} as unknown as Rendition;
  await turnEpub(rendition, 1); expect(container.scrollTop).toBe(900); expect(rendition.next).not.toHaveBeenCalled();
  await turnEpub(rendition, 1); expect(container.scrollTop).toBe(1600);
  await turnEpub(rendition, 1); expect(rendition.next).toHaveBeenCalledOnce();
  await turnEpub(rendition, -1); expect(container.scrollTop).toBe(700);
  await turnEpub(rendition, -1); expect(container.scrollTop).toBe(0);
  await turnEpub(rendition, -1); expect(rendition.prev).toHaveBeenCalledOnce();
  (rendition as unknown as {manager: {isPaginated: boolean}}).manager.isPaginated = true;
  await turnEpub(rendition, 1); expect(rendition.next).toHaveBeenCalledTimes(2);
});

const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>${body}`;
const opf =
  xml(`<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Text fixture</dc:title><dc:identifier id="uid">fixture</dc:identifier></metadata>
  <manifest><item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/></manifest>
  <spine toc="ncx"><itemref idref="c1"/></spine></package>`);
const ncx = xml(
  `<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap><navPoint id="chapter"><navLabel><text>Chapter one</text></navLabel><content src="chapter.xhtml#start"/></navPoint></navMap></ncx>`,
);

async function fixture(overrides: Record<string, string | Blob> = {}) {
  const files: Record<string, string | Blob> = {
    mimetype: "application/epub+zip",
    "META-INF/container.xml": xml(
      '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ),
    "OPS/content.opf": opf,
    "OPS/toc.ncx": ncx,
    "OPS/chapter.xhtml": xml(
      `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Text</title></head><body><p id="start">${"Real text. ".repeat(30_000)}</p></body></html>`,
    ),
    "OPS/cover.png": new Blob([new Uint8Array(200_000)]),
    ...overrides,
  };
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    useWebWorkers: false,
    level: 0,
  });
  for (const [name, value] of Object.entries(files))
    await writer.add(
      name,
      new BlobReader(typeof value === "string" ? new Blob([value]) : value),
    );
  const bytes = await writer.close();
  const reads: [number, number][] = [];
  const source: RandomAccessSource = {
    snapshot: {
      identity: "epub-fixture",
      version: "1",
      size: bytes.length,
      local: true,
    },
    async readAt(offset, length, signal) {
      signal?.throwIfAborted();
      reads.push([offset, length]);
      return bytes.subarray(offset, offset + length);
    },
    validate: async () => "unchanged",
    close: vi.fn(async () => {}),
  };
  return { source, reads, bytes };
}

describe("EPUB package bridge", () => {
  it("indexes text chapters and navigation without materializing image pages or whole-file resources", async () => {
    const { source, reads, bytes } = await fixture();
    const index = await indexEpub(source);
    expect(index.kind).toBe("epub");
    expect(index.title).toBe("Text fixture");
    expect(index.chapters).toEqual([
      { id: "0:c1", href: "OPS/chapter.xhtml", label: "Chapter one" },
    ]);
    expect(index.toc).toEqual([
      { href: "OPS/chapter.xhtml#start", label: "Chapter one" },
    ]);
    expect(index.cover).toEqual({
      href: "OPS/cover.png",
      mediaType: "image/png",
    });
    expect(index.images).toEqual([{href: 'OPS/cover.png', mediaType: 'image/png'}]);
    expect(reads.reduce((size, [, length]) => size + length, 0)).toBeLessThan(
      bytes.length / 2,
    );
    expect(source.close).not.toHaveBeenCalled();
  });

  it("indexes a remote random-access source without fetching the whole container", async () => {
    const { source, reads, bytes } = await fixture();
    await expect(indexEpub({ ...source, snapshot: { ...source.snapshot, local: false } }))
      .resolves.toMatchObject({ kind: 'epub', title: 'Text fixture' });
    expect(reads.reduce((size, [, length]) => size + length, 0)).toBeLessThan(bytes.length / 2);
  });

  it('materializes only a manifest image and rejects text, unknown and external locators', async () => {
    const {source} = await fixture();
    const image = await readEpubImage(source, 'OPS/cover.png');
    expect(image.type).toBe('image/png');
    expect(image.size).toBe(200_000);
    for (const href of ['OPS/chapter.xhtml', 'OPS/unknown.png', 'https://external.test/image.png'])
      await expect(readEpubImage(source, href)).rejects.toThrow('图片不在内容清单');
    expect(source.close).not.toHaveBeenCalled();
  });

  it("rejects malformed XML, custom entities, DRM and missing spine resources", async () => {
    expect(() => parseEpubXml("<x>")).toThrow();
    expect(() =>
      parseEpubXml('<!DOCTYPE x [<!ENTITY e "bad">]><x>&e;</x>'),
    ).toThrow("实体");
    const protectedBook = await fixture({
      "META-INF/encryption.xml":
        '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#"/></encryption>',
    });
    await expect(indexEpub(protectedBook.source)).rejects.toThrow("加密");
    const missing = await fixture({
      "OPS/content.opf": opf.replace(
        'href="chapter.xhtml"',
        'href="missing.xhtml"',
      ),
    });
    await expect(indexEpub(missing.source)).rejects.toThrow("缺少正文章节");
  });

  it("never resolves external or malformed names into the archive", () => {
    expect(epubPath("../image%20one.png", epubUrl("OPS/chapter.xhtml"))).toBe(
      "image one.png",
    );
    expect(() => epubPath("https://external.example/a")).toThrow();
    expect(() => epubPath("//external.example/a")).toThrow();
    expect(() => epubPath("javascript:alert(1)")).toThrow();
    expect(() => epubPath("a%5Cb")).toThrow();
    expect(() => epubPath("%")).toThrow();
  });

  it("keeps only spine destinations in navigation while retaining valid children", async () => {
    const { source } = await fixture({
      "OPS/toc.ncx": ncx.replace(
        "</navMap>",
        '<navPoint id="outside"><navLabel><text>Non-spine</text></navLabel><content src="appendix.xhtml"/><navPoint id="inside"><navLabel><text>Nested chapter</text></navLabel><content src="chapter.xhtml#nested"/></navPoint></navPoint></navMap>',
      ),
    });
    expect((await indexEpub(source)).toc).toEqual([
      { href: "OPS/chapter.xhtml#start", label: "Chapter one" },
      { href: "OPS/chapter.xhtml#nested", label: "Nested chapter" },
    ]);
  });

  it("refuses archive reads after disposal and honors an already aborted request", async () => {
    const { source } = await fixture();
    const archive = await openEpubArchive(source);
    const controller = new AbortController();
    controller.abort();
    await expect(
      archive.read("OPS/cover.png", "image/png", controller.signal),
    ).rejects.toThrow();
    await archive.close();
    await expect(archive.read("OPS/cover.png")).rejects.toThrow("关闭");
    expect(source.close).not.toHaveBeenCalled();
  });
});

function resourceArchive(read: EpubArchive["read"]): EpubArchive {
  return {
    has: () => true,
    read,
    text: async () => "",
    xml: async () => parseEpubXml("<x/>"),
    close: async () => {},
  };
}

describe("EPUB resource isolation", () => {
  it("places policy in the actual XHTML head and rejects forged navigation metadata", async () => {
    const resources = new EpubResources(
      resourceArchive(async () => new Blob()),
      new Map(),
    );
    const document = parseEpubXml(
      '<html xmlns="http://www.w3.org/1999/xhtml"><head xmlns="urn:foreign"/><body><head/><a data-nc-epub-href="https://external.example/missing.xhtml">Forged</a></body></html>',
    );
    await resources.sanitize(document, epubUrl("OPS/chapter.xhtml"), "chapter");
    const policy = Array.from(document.getElementsByTagName("meta")).find(
      (element) =>
        element.getAttribute("http-equiv") === "Content-Security-Policy",
    )!;
    expect(policy.parentNode?.parentNode).toBe(document.documentElement);
    expect((policy.parentNode as Element).namespaceURI).toBe(
      "http://www.w3.org/1999/xhtml",
    );
    expect(
      document.getElementsByTagName("a")[0].hasAttribute("data-nc-epub-href"),
    ).toBe(false);
    await expect(
      resources.sanitize(
        parseEpubXml('<html xmlns="urn:foreign"/>'),
        epubUrl("OPS/chapter.xhtml"),
        "foreign",
      ),
    ).rejects.toThrow("XHTML");
    resources.close();
  });

  it("strips active elements, both cases of refresh, event attributes and external resources before serialization", async () => {
    const read = vi.fn(async () => new Blob(["image"], { type: "image/png" }));
    const resources = new EpubResources(
      resourceArchive(read),
      new Map([["OPS/image.png", "image/png"]]),
    );
    const document = parseEpubXml(
      '<html xmlns="http://www.w3.org/1999/xhtml"><head><meta HTTP-EQUIV="refresh" CONTENT="0;url=https://external.example/"/><meta http-equiv="refresh" content="0;url=https://external.example/"/><script>bad()</script></head><body onload="bad()"><iframe src="https://external.example/"/><img src="image.png"/><img src="https://external.example/image.png"/><a href="chapter.xhtml#note">Note</a><a href="https://external.example/">External</a></body></html>',
    );
    await resources.sanitize(document, epubUrl("OPS/chapter.xhtml"), "chapter");
    const serialized = new XMLSerializer().serializeToString(document);
    expect(serialized).toContain("default-src 'none'");
    expect(serialized).not.toMatch(
      /<script|<iframe|onload=|refresh|https:\/\/external/,
    );
    expect(document.getElementsByTagName("img")[0].getAttribute("src")).toMatch(
      /^blob:/,
    );
    expect(document.getElementsByTagName('img')[0].getAttribute('data-nc-epub-image')).toBe('OPS/image.png');
    expect(document.getElementsByTagName("img")[1].hasAttribute("src")).toBe(
      false,
    );
    expect(document.getElementsByTagName("a")[0].getAttribute("href")).toBe(
      "#",
    );
    expect(document.getElementsByTagName("a")[1].hasAttribute("href")).toBe(
      false,
    );
    expect(read).toHaveBeenCalledTimes(1);
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    resources.release("chapter");
    expect(revoke).toHaveBeenCalledTimes(1);
    resources.close();
  });

  it('annotates only real internal artwork, including SVG image elements, and strips forged identities', async () => {
    const resources = new EpubResources(resourceArchive(async () => new Blob(['image'], {type: 'image/png'})), new Map([['OPS/real.png', 'image/png']]));
    const document = parseEpubXml('<html xmlns="http://www.w3.org/1999/xhtml"><head/><body><p contenteditable="true" data-nc-epub-image="OPS/real.png">Original text</p><img src="https://external.test/image.png" data-nc-epub-image="OPS/real.png"/><svg xmlns="http://www.w3.org/2000/svg"><image href="real.png" data-nc-epub-image="OPS/forged.png"/></svg></body></html>');
    await resources.sanitize(document, epubUrl('OPS/chapter.xhtml'), 'chapter');
    expect(document.getElementsByTagName('p')[0].textContent).toBe('Original text');
    expect(document.getElementsByTagName('p')[0].hasAttribute('data-nc-epub-image')).toBe(false);
    expect(document.getElementsByTagName('p')[0].hasAttribute('contenteditable')).toBe(false);
    expect(document.getElementsByTagName('img')[0].hasAttribute('data-nc-epub-image')).toBe(false);
    expect(document.getElementsByTagName('image')[0].getAttribute('data-nc-epub-image')).toBe('OPS/real.png');
    resources.close();
  });

  it("cannot resurrect a released owner while the first resource is in flight", async () => {
    let resolve!: (blob: Blob) => void;
    const read = vi.fn(
      () =>
        new Promise<Blob>((done) => {
          resolve = done;
        }),
    );
    const resources = new EpubResources(
      resourceArchive(read),
      new Map([
        ["OPS/one.png", "image/png"],
        ["OPS/two.png", "image/png"],
      ]),
    );
    const create = vi.spyOn(URL, "createObjectURL");
    const document = parseEpubXml(
      '<html xmlns="http://www.w3.org/1999/xhtml"><head/><body><img src="one.png"/><img src="two.png"/></body></html>',
    );
    const pending = resources.sanitize(
      document,
      epubUrl("OPS/chapter.xhtml"),
      "chapter",
    );
    const rejection = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    resources.release("chapter");
    resolve(new Blob(["one"]));
    await rejection;
    expect(read).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    resources.close();
  });
});

describe("EPUB source position restoration", () => {
  it("configures appearance before display and restores the original CFI again after themes, fonts and layout", async () => {
    const events: string[] = [];
    let rendered!: () => void;
    let fontReady!: () => void;
    const fonts = new Promise<void>((resolve) => {
      fontReady = resolve;
    });
    const resizeCheck = vi.fn(() => events.push("layout"));
    const rendition = {
      on: vi.fn((_event: string, callback: () => void) => {
        rendered = callback;
      }),
      off: vi.fn(),
      getContents: () => [
        { document: { fonts: { ready: fonts } }, resizeCheck },
      ],
      display: vi.fn(async (_target: string) => {
        events.push("display");
        if (events.filter((event) => event === "display").length === 1) {
          queueMicrotask(() => {
            events.push("theme-hook");
            rendered();
          });
        }
      }),
    };
    const current = {
      book: { getRange: async () => ({}) },
    } as unknown as EpubSession;
    const pending = initializeEpubLocation(
      current,
      rendition as unknown as Rendition,
      { cfi: "chapter-20" },
      () => {
        events.push("appearance");
      },
    );
    await vi.waitFor(() => expect(events).toContain("theme-hook"));
    expect(rendition.display).toHaveBeenCalledTimes(1);
    expect(resizeCheck).not.toHaveBeenCalled();
    fontReady();
    await pending;
    expect(events).toEqual([
      "appearance",
      "display",
      "theme-hook",
      "layout",
      "layout",
      "display",
    ]);
    expect(rendition.display).toHaveBeenLastCalledWith("chapter-20");
    expect(rendition.off).toHaveBeenCalledWith("rendered", rendered);
  });

  it("aborts layout readiness without waiting for an unresolved font", async () => {
    const controller = new AbortController();
    const resizeCheck = vi.fn();
    const rendition = {
      getContents: () => [
        { document: { fonts: { ready: new Promise(() => {}) } }, resizeCheck },
      ],
    };
    const pending = settleEpubLayout(
      rendition as unknown as Rendition,
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(resizeCheck).not.toHaveBeenCalled();
  });

  it("resizes around the displayed chapter instead of a previous RAF position report", () => {
    const current = { start: { cfi: "current-chapter" } };
    const rendition = {
      location: { start: { cfi: "previous-chapter" } },
      currentLocation: () => current,
      resize: vi.fn(),
    };
    resizeEpub(rendition as unknown as Rendition, 800, 600);
    expect(rendition.location).toBe(current);
    expect(rendition.resize).toHaveBeenCalledWith(800, 600, "current-chapter");
  });

  const view = (
    axis = "vertical",
    direction = "ltr",
    rtlScrollType = "negative",
  ) => {
    const container = {
      scrollHeight: 4000,
      clientHeight: 800,
      scrollTop: 0,
      scrollWidth: 6000,
      clientWidth: 1000,
      scrollLeft: 0,
    };
    const manager = {
      container,
      settings: { axis, direction, rtlScrollType },
      isPaginated: false,
      layout: { delta: 1000, height: 800 },
      scrollTo: vi.fn((left: number, top: number) => {
        container.scrollLeft = left;
        container.scrollTop = top;
      }),
    };
    return {
      manager,
      display: vi.fn(async () => {}),
      reportLocation: vi.fn(async () => {}),
    };
  };
  const session = (validCfi: boolean) =>
    ({
      book: {
        getRange: vi.fn(async () => {
          if (!validCfi) throw Error("stale CFI");
          return {};
        }),
        spine: {
          get: vi.fn((href: string) =>
            href === "/OPS/chapter.xhtml" ? { href } : undefined,
          ),
        },
      },
    }) as unknown as EpubSession;

  it("falls back from stale CFI to href plus chapter progression without scanning the book", async () => {
    const rendition = view();
    await restoreEpubLocation(
      session(false),
      rendition as unknown as Rendition,
      { cfi: "stale", href: "OPS/chapter.xhtml", progression: 0.5 },
    );
    expect(rendition.display).toHaveBeenCalledWith("/OPS/chapter.xhtml");
    expect(rendition.manager.scrollTo).toHaveBeenCalledWith(0, 2000, true);
    expect(epubProgression(rendition as unknown as Rendition)).toBe(0.5);
  });

  it("prefers valid CFI, and falls back to first section for a missing href", async () => {
    const rendition = view();
    await restoreEpubLocation(
      session(true),
      rendition as unknown as Rendition,
      { cfi: "valid", href: "OPS/chapter.xhtml", progression: 0.5 },
    );
    expect(rendition.display).toHaveBeenCalledWith("valid");
    expect(rendition.manager.scrollTo).not.toHaveBeenCalled();
    await restoreEpubLocation(
      session(false),
      rendition as unknown as Rendition,
      { href: "missing", progression: 0.5 },
    );
    expect(rendition.display).toHaveBeenLastCalledWith(undefined);
  });

  it("round-trips source fraction in horizontal RTL layouts", async () => {
    const rendition = view("horizontal", "rtl");
    await restoreEpubLocation(
      session(false),
      rendition as unknown as Rendition,
      { href: "OPS/chapter.xhtml", progression: 0.5 },
    );
    expect(rendition.manager.scrollTo).toHaveBeenCalledWith(-3000, 0, true);
    expect(epubProgression(rendition as unknown as Rendition)).toBe(0.5);
  });
});
