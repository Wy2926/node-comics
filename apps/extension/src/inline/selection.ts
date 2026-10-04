interface ImageSelection {
  element: HTMLImageElement;
  pageUrl: string;
  url: string;
  displayedUrl?: string;
  width: number;
  height: number;
}
type SelectionDocument = Document & { __ncImageSelection?: ImageSelection };

/** The lazy inline bundle shares this isolated-world reference with the light entry. */
export function installImageSelection(doc: Document) {
  const capture = (event: MouseEvent) => {
    if (!event.isTrusted) return;
    const element = event.composedPath().find(node => node instanceof HTMLImageElement);
    const state = doc as SelectionDocument;
    if (!(element instanceof HTMLImageElement)) { state.__ncImageSelection = undefined; return; }
    // Chrome may report the CSS replacement URL when right-clicking a translated img.
    const displayedUrl = doc.defaultView!.getComputedStyle(element).content.match(/^url\(["']?(.*?)["']?\)$/)?.[1];
    state.__ncImageSelection = {
      element, pageUrl: doc.defaultView!.location.href, url: element.currentSrc || element.src, displayedUrl,
      width: element.naturalWidth, height: element.naturalHeight,
    };
  };
  doc.addEventListener('contextmenu', capture, true);
  return () => { doc.removeEventListener('contextmenu', capture, true); delete (doc as SelectionDocument).__ncImageSelection; };
}

export function selectedImage(doc: Document, url?: string, dataImage=false) {
  const selected = (doc as SelectionDocument).__ncImageSelection;
  return selected && (selected.url === url || url!==undefined&&selected.displayedUrl === url
    || dataImage&&/^data:image\/(?:png|jpeg|webp|gif|avif);/i.test(selected.url))
    && selectionCurrent(selected, doc) ? selected : undefined;
}

export function selectionCurrent(selection: ImageSelection, doc: Document) {
  const image = selection.element;
  return selection.pageUrl === doc.defaultView?.location.href && image.isConnected && image.ownerDocument === doc
    && image.complete && image.naturalWidth > 0 && image.naturalHeight > 0
    && (image.currentSrc || image.src) === selection.url
    && image.naturalWidth === selection.width && image.naturalHeight === selection.height;
}

export type { ImageSelection };
