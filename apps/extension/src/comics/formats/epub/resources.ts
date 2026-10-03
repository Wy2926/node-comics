import { epubPath, epubUrl, parseEpubXml, type EpubArchive } from "./archive";

const XHTML = "http://www.w3.org/1999/xhtml";
const REMOVED_ELEMENTS = new Set([
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "base",
  "foreignobject",
  "audio",
  "video",
  "source",
  "track",
  "animate",
  "animatetransform",
  "animatemotion",
  "set",
]);
const IMAGE = /^(?:image\/(?:png|jpeg|gif|webp|avif|bmp|svg\+xml))$/;
const FONT =
  /^(?:font\/(?:woff2?|ttf|otf)|application\/(?:font-woff|vnd\.ms-opentype|x-font-(?:ttf|opentype)))$/;
const CSP =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline' blob:; img-src blob: data:; font-src blob:; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

interface Scope {
  urls: Set<string>;
  pending: Map<string, Promise<string>>;
  controller: AbortController;
  closed: boolean;
}

async function replaceAsync(
  text: string,
  pattern: RegExp,
  replace: (match: RegExpExecArray) => Promise<string>,
) {
  let output = "";
  let offset = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    output += text.slice(offset, match.index) + (await replace(match));
    offset = match.index + match[0].length;
  }
  return output + text.slice(offset);
}

/** Local resource ownership is per displayed section; leaving it revokes every derived URL. */
export class EpubResources {
  private scopes = new Map<string, Scope>();
  private closed = false;

  constructor(
    private archive: EpubArchive,
    private mediaTypes: ReadonlyMap<string, string>,
  ) {}

  private scope(owner: string): Scope {
    if (this.closed) throw new Error("EPUB 会话已关闭。");
    let scope = this.scopes.get(owner);
    if (!scope) {
      scope = {
        urls: new Set(),
        pending: new Map(),
        controller: new AbortController(),
        closed: false,
      };
      this.scopes.set(owner, scope);
    }
    return scope;
  }

  private async resource(
    href: string,
    base: string,
    scope: Scope,
    chain: readonly string[] = [],
  ): Promise<string> {
    scope.controller.signal.throwIfAborted();
    const path = epubPath(href, base);
    const mediaType = this.mediaTypes
      .get(path)
      ?.split(";")[0]
      .trim()
      .toLowerCase();
    if (
      !mediaType ||
      !(
        IMAGE.test(mediaType) ||
        FONT.test(mediaType) ||
        mediaType === "text/css"
      )
    ) {
      throw new Error("EPUB 不支持此资源类型。");
    }
    if (chain.includes(path) || chain.length >= 16)
      throw new Error("EPUB 样式引用形成循环。");
    let pending = scope.pending.get(path);
    if (!pending) {
      pending = (async () => {
        let blob: Blob;
        if (mediaType === "text/css") {
          const css = await this.css(
            await this.archive.text(path, scope.controller.signal),
            epubUrl(path),
            scope,
            [...chain, path],
          );
          blob = new Blob([css], { type: mediaType });
        } else if (mediaType === "image/svg+xml") {
          const svg = parseEpubXml(
            await this.archive.text(path, scope.controller.signal),
          );
          await this.sanitizeDocument(svg, epubUrl(path), scope, [
            ...chain,
            path,
          ]);
          blob = new Blob([new XMLSerializer().serializeToString(svg)], {
            type: mediaType,
          });
        } else {
          blob = await this.archive.read(
            path,
            mediaType,
            scope.controller.signal,
          );
        }
        if (scope.closed) throw new Error("EPUB 资源已释放。");
        const url = URL.createObjectURL(blob);
        scope.urls.add(url);
        return url;
      })();
      scope.pending.set(path, pending);
    }
    return pending;
  }

  private async resourceOrEmpty(
    href: string,
    base: string,
    scope: Scope,
    chain: readonly string[],
  ) {
    try {
      return await this.resource(href, base, scope, chain);
    } catch {
      scope.controller.signal.throwIfAborted();
      // Missing, external or unsupported artwork must not prevent text from being read.
      return "";
    }
  }

  private async css(
    text: string,
    base: string,
    scope: Scope,
    chain: readonly string[],
  ) {
    // CSP remains the enforcement boundary, including escaped CSS tokens this rewriter does not recognize.
    let output = text.replace(/\/\*[\s\S]*?\*\//g, "");
    output = await replaceAsync(
      output,
      /@import\s+(['"])(.*?)\1([^;]*);/gi,
      async (match) => {
        const url = await this.resourceOrEmpty(match[2], base, scope, chain);
        return url ? `@import url("${url}")${match[3]};` : "";
      },
    );
    return replaceAsync(
      output,
      /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi,
      async (match) => {
        const value = (match[1] ?? match[2] ?? match[3]).trim();
        if (value.startsWith("#")) return `url("${value.replaceAll('"', "")}")`;
        // URLs already produced by this owner are the only accepted blob URLs.
        if (scope.urls.has(value)) return `url("${value}")`;
        const url = await this.resourceOrEmpty(value, base, scope, chain);
        return url ? `url("${url}")` : 'url("data:,")';
      },
    );
  }

  async sanitize(document: Document, base: string, owner: string) {
    if (
      document.documentElement.localName !== "html" ||
      document.documentElement.namespaceURI !== XHTML
    ) {
      throw new Error("EPUB 正文章节必须是 XHTML 文档。");
    }
    return this.sanitizeDocument(document, base, this.scope(owner), []);
  }

  private async sanitizeDocument(
    document: Document,
    base: string,
    scope: Scope,
    chain: readonly string[],
  ) {
    const elements = [...Array.from(document.getElementsByTagName("*"))];
    for (const element of elements) {
      scope.controller.signal.throwIfAborted();
      const name = element.localName.toLowerCase();
      if (
        REMOVED_ELEMENTS.has(name) ||
        (name === "meta" &&
          Array.from(element.attributes).some(
            (attribute) => attribute.localName.toLowerCase() === "http-equiv",
          ))
      ) {
        element.parentNode?.removeChild(element);
        continue;
      }
      for (const attribute of Array.from(element.attributes)) {
        const key = attribute.localName.toLowerCase();
        if (
          key.startsWith("on") ||
          [
            "srcdoc",
            "srcset",
            "ping",
            "autofocus",
            "action",
            "formaction",
            "background",
            "poster",
            "xml:base",
            "data-nc-epub-href",
          ].includes(key) ||
          (attribute.namespaceURI === "http://www.w3.org/XML/1998/namespace" &&
            key === "base")
        ) {
          element.removeAttributeNode(attribute);
        }
      }
      if (name === "style") {
        element.textContent = await this.css(
          element.textContent ?? "",
          base,
          scope,
          chain,
        );
      }
      const inlineStyle = element.getAttribute("style");
      if (inlineStyle)
        element.setAttribute(
          "style",
          await this.css(inlineStyle, base, scope, chain),
        );
      for (const attribute of Array.from(element.attributes)) {
        const key = attribute.localName.toLowerCase();
        if (key !== "src" && key !== "href") continue;
        const value = attribute.value;
        if (name === "a" && key === "href") {
          try {
            const path = epubPath(value, base);
            const url = new URL(value, base);
            element.setAttribute("data-nc-epub-href", epubUrl(path) + url.hash);
            element.setAttributeNS(attribute.namespaceURI, attribute.name, "#");
          } catch {
            element.removeAttributeNode(attribute);
          }
        } else if (
          (name === "link" &&
            element.getAttribute("rel")?.toLowerCase() === "stylesheet") ||
          name === "img" ||
          name === "image"
        ) {
          const url = await this.resourceOrEmpty(value, base, scope, chain);
          if (url)
            element.setAttributeNS(attribute.namespaceURI, attribute.name, url);
          else element.removeAttributeNode(attribute);
        } else if (name === "use" && value.startsWith("#")) {
          // SVG fragments never leave the current resource.
        } else {
          element.removeAttributeNode(attribute);
        }
      }
    }
    if (
      document.documentElement.localName === "html" &&
      document.documentElement.namespaceURI === XHTML
    ) {
      let head = Array.from(document.documentElement.childNodes).find(
        (node): node is Element =>
          node.nodeType === 1 &&
          (node as Element).localName === "head" &&
          (node as Element).namespaceURI === XHTML,
      );
      if (!head) {
        head = document.createElementNS(XHTML, "head");
        document.documentElement.insertBefore(
          head,
          document.documentElement.firstChild,
        );
      }
      const policy = document.createElementNS(XHTML, "meta");
      policy.setAttribute("http-equiv", "Content-Security-Policy");
      policy.setAttribute("content", CSP);
      head.insertBefore(policy, head.firstChild);
      const referrer = document.createElementNS(XHTML, "meta");
      referrer.setAttribute("name", "referrer");
      referrer.setAttribute("content", "no-referrer");
      head.insertBefore(referrer, policy.nextSibling);
    }
  }

  release(owner: string) {
    const scope = this.scopes.get(owner);
    if (!scope) return;
    scope.closed = true;
    scope.controller.abort();
    for (const url of scope.urls) URL.revokeObjectURL(url);
    scope.urls.clear();
    scope.pending.clear();
    this.scopes.delete(owner);
  }

  close() {
    this.closed = true;
    for (const owner of this.scopes.keys()) this.release(owner);
  }
}
