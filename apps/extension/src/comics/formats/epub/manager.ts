import ContinuousViewManager from 'epubjs/src/managers/continuous/index.js';

/** Compatibility fixes confined to the pinned EPUB.js 0.3.93 renderer. */
export class EpubContinuousManager extends ContinuousViewManager {
  private closed = false;
  override check(left?: number, top?: number) {
    if (this.closed) return Promise.resolve(false);
    // Prepending changes scrollTop synchronously; the DOM scroll event may arrive
    // after check recurses. Stale offsets otherwise pull in every previous chapter.
    if (this.container) {
      this.scrollTop = this.container.scrollTop;
      this.scrollLeft = this.container.scrollLeft;
    }
    // Upstream applies the horizontal RTL scroll sign to scrollTop too. Vertical
    // reading always advances downwards, including Japanese fixed-layout comics.
    const direction = this.settings.direction;
    if (this.settings.axis === 'vertical') this.settings.direction = 'ltr';
    try {return super.check(left, top);}
    finally {this.settings.direction = direction;}
  }

  override onScroll() {
    const suppressed = this.ignore;
    super.onScroll();
    // A silent no-op restoration can leave `ignore` set for the first real wheel
    // event. Refill even then; the reader separately gates persistence while restoring.
    if (suppressed) this._scrolled?.();
  }

  override async next() {
    await this.fill();
    if (this.closed) return;
    super.next();
    await this.fill();
  }

  override async prev() {
    await this.fill();
    if (this.closed) return;
    super.prev();
    await this.fill();
  }

  override destroy() {
    this.closed = true;
    this.q.stop();
    this._scrolled?.cancel();
    clearTimeout(this.trimTimeout);
    clearTimeout(this.scrollTimeout);
    clearTimeout(this.afterScrolled);
    super.destroy();
  }
}
