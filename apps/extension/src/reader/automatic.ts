import type {Page} from '../types';

export function normalizeAhead(value: unknown) {
  const number = Number(value);
  return value == null || !Number.isFinite(number) ? 10 : Math.max(0, Math.min(50, Math.trunc(number)));
}

export function translationWindow(pages: Page[], index: number, ahead: number) {
  const start = Math.max(0, Math.trunc(index));
  return pages.slice(start, start + normalizeAhead(ahead) + 1);
}

/** Only the latest reading window is pending. A session has no total page limit. */
export class AutomaticTranslationQueue {
  private pages: Page[] = [];
  private attempted = new Set<string>();
  private revision = 0;
  private session = 0;
  private running = false;

  reset() {
    this.session++;
    this.revision++;
    this.attempted.clear();
    this.pages = [];
  }

  setWindow(pages: Page[]) {
    if (pages.map(p => p.id).join(',') !== this.pages.map(p => p.id).join(',')) this.revision++;
    this.pages = pages;
  }

  async drain(maxBatch: number, prepare: (pages: Page[], current: () => boolean) => Promise<boolean>) {
    if (this.running) return;
    this.running = true;
    const session = this.session;
    try {
      while (session === this.session) {
        const batch = this.pages.filter(p => !this.attempted.has(p.id)).slice(0, Math.max(1, maxBatch));
        if (!batch.length) return;
        const revision = this.revision;
        const current = () => session === this.session && revision === this.revision;
        const completed = await prepare(batch, current);
        if (session !== this.session) return;
        // A submitted batch remains attempted even if the reader jumped while it was in flight.
        if (completed) for (const page of batch) this.attempted.add(page.id);
        else if (current()) return;
      }
    } finally { this.running = false; }
  }
}
