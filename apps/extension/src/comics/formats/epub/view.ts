import IframeView from 'epubjs/src/managers/views/iframe.js';
import type Contents from 'epubjs/types/contents';

/** EPUB.js fits fixed pages but leaves them on the left (or at a publisher spread edge). */
export function centerFixedPage(contents: Contents, width: number, height: number, alignment = .5) {
  const viewport = (contents as Contents & {viewport(): {width: string; height: string}}).viewport();
  const pageWidth = Number.parseFloat(viewport.width), pageHeight = Number.parseFloat(viewport.height);
  if (!(pageWidth > 0 && pageHeight > 0 && width > 0 && height > 0)) return;
  const scale = Math.min(width / pageWidth, height / pageHeight);
  // Physical margins are outside the transform, so no scaled translation or CFI-tree edits.
  contents.css('margin-left', `${(width - pageWidth * scale) * alignment}px`, true);
  contents.css('margin-right', '0px', true);
  contents.css('margin-top', `${(height - pageHeight * scale) / 2}px`, true);
  contents.css('margin-bottom', '0px', true);
}

/** Both managers can destroy/recycle frames without emitting their removed event. */
export function epubView(unload: (view: IframeView) => void, gap = () => 0) {
  return class EpubView extends IframeView {
    private pendingDisplay?: Promise<unknown>;
    constructor(...args: ConstructorParameters<typeof IframeView>) {
      // WebKit blocks even parent-owned event callbacks without allow-scripts.
      // Resources sanitizes every chapter and prepends script-src 'none'; that
      // policy still forbids book scripts, while reader tap/link handlers work.
      super(args[0], {...args[1], method: 'blobUrl', allowScriptedContent: true});
    }
    override expand(force?: boolean) {
      super.expand(force);
      if (this.contents && this.layout.name === 'pre-paginated') {
        let alignment = .5;
        if (this.layout.divisor === 2 && this.element.parentElement) {
          const page = this.element.getBoundingClientRect(), viewport = this.element.parentElement.getBoundingClientRect();
          alignment = page.left + page.width / 2 < viewport.left + viewport.width / 2 ? 1 - gap() / 100 : gap() / 100;
        }
        centerFixedPage(this.contents, this.layout.columnWidth, this.layout.height, alignment);
      }
    }
    override display(request?: Function) {
      // A queued visibility update can meet a direct CFI display. One iframe must
      // have only one load promise; otherwise onload is replaced and navigation hangs.
      return this.pendingDisplay ??= super.display(request).finally(() => {this.pendingDisplay = undefined;});
    }
    override destroy() {
      if (this.contents) unload(this);
      super.destroy();
      // The continuous manager retains empty frames as size placeholders. Their next
      // display must sanitize again, not reuse HTML containing revoked resource URLs.
      this.sectionRender = undefined;
    }
  };
}
