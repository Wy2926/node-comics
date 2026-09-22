import type { SourceNavigation } from './navigation';

interface Subscriber {
  changed(): void;
  invalidated(): void;
}

/** One navigation and one adapter observer, shared by all features in a document. */
export class SourceDocument {
  private navigation: SourceNavigation;
  private subscribers = new Set<Subscriber>();
  private stopObserving?: () => void;
  private observedId?: string;
  private timer?: number;
  private suspended = false;

  constructor(
    private view: Window,
    createNavigation: (invalidate: () => void) => SourceNavigation,
  ) {
    this.navigation = createNavigation(() => {
      this.stopObserving?.();
      this.stopObserving = undefined;
      this.observedId = undefined;
      for (const subscriber of [...this.subscribers]) subscriber.invalidated();
    });
    view.addEventListener('pagehide', () => {
      this.suspended = true;
      this.pause();
      this.navigation.dispose();
    });
    view.addEventListener('pageshow', () => {
      this.suspended = false;
      if (this.subscribers.size) this.resume();
    });
  }

  current() {
    if (this.suspended) throw Error('SOURCE_SESSION_EXPIRED');
    const page = this.navigation.get(this.view.location.href);
    if (this.subscribers.size && this.observedId !== page.navigationId) {
      this.observedId = page.navigationId;
      this.stopObserving = page.session.observe?.(this.changed);
      this.notify();
    }
    return page;
  }

  subscribe(subscriber: Subscriber) {
    this.subscribers.add(subscriber);
    if (!this.suspended) {
      this.resume();
      subscriber.changed();
    }
    return () => {
      this.subscribers.delete(subscriber);
      if (!this.subscribers.size) {
        this.pause();
        this.navigation.dispose();
      }
    };
  }

  private notify() {
    for (const subscriber of [...this.subscribers]) subscriber.changed();
  }

  private changed = () => {
    // Recheck the URL before notifying consumers about DOM changes.
    const previous = this.observedId;
    this.current();
    if (previous === this.observedId) this.notify();
  };

  private resume() {
    if (this.timer === undefined) {
      this.view.addEventListener('popstate', this.changed);
      this.view.addEventListener('hashchange', this.changed);
      // pushState in the page's main world does not dispatch an isolated-world event.
      this.timer = this.view.setInterval(() => {
        this.current();
      }, 250);
    }
    this.current();
  }

  private pause() {
    this.view.clearInterval(this.timer);
    this.timer = undefined;
    this.view.removeEventListener('popstate', this.changed);
    this.view.removeEventListener('hashchange', this.changed);
  }
}
