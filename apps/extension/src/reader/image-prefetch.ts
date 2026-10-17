export interface ReaderPrefetchOptions {
  scope: string;
  current: readonly string[];
  next: readonly string[];
  /** Per-page source identity; normal chapter handoff keeps the reader scope stable. */
  identities?: ReadonlyMap<string, string>;
  /** Current sources have been acquired/failed or readable pixels are displayed; never wait on translated pixels. */
  ready: boolean;
  enabled: boolean;
}

export interface PrefetchLease {blob: Blob; release(): void}
export type PrefetchAcquire = (key: string, signal: AbortSignal, priority: 'prefetch') => Promise<PrefetchLease>;
type Window = Omit<ReaderPrefetchOptions, 'enabled'>;
type Pending = {key: string; controller: AbortController};
const budget = 64 * 1024 * 1024;
const keys = (values: readonly string[]) => [...new Set(values.filter(key => key && !key.startsWith('result:')))];
const equal = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every((key, index) => key === right[index]);

/** A two-page byte window. Displayed images still acquire and validate their own leases. */
export class ReaderImagePrefetch {
  private window?: Window;
  private held = new Map<string, PrefetchLease>();
  private bytes = 0;
  private attempted = new Set<string>();
  private pending?: Pending;
  private timer?: ReturnType<typeof setTimeout>;
  private stable = false;

  constructor(private readonly acquire: PrefetchAcquire) {}

  update(options: ReaderPrefetchOptions): void {
    if (!options.enabled) {this.dispose(); return;}
    if (this.window?.scope !== options.scope) this.dispose();
    const current = keys(options.current);
    const next = keys(options.next).filter(key => !current.includes(key)).slice(0, 2);
    // Own a bounded snapshot so a caller reusing its map cannot hide an identity change.
    const identities = new Map<string, string>();
    for (const key of [...current, ...next]) {
      const identity = options.identities?.get(key);
      if (identity !== undefined) identities.set(key, identity);
    }
    const previous = this.window;
    const nextChanged = !previous || !equal(previous.next, next);
    const changed = new Set([...current, ...next].filter(key => previous?.identities?.get(key) !== identities.get(key)));
    if (nextChanged) this.attempted.clear();
    else for (const key of changed) this.attempted.delete(key);
    if (!previous || nextChanged || changed.size || !equal(previous.current, current) || previous.ready !== options.ready) {
      this.clearTimer();
      this.stable = false;
    }
    this.window = {scope: options.scope, current, next, identities, ready: options.ready};
    for (const [key, lease] of this.held) {
      if (!changed.has(key) && this.wanted(key)) continue;
      this.held.delete(key);
      this.bytes -= lease.blob.size;
      lease.release();
    }
    if (this.pending && (changed.has(this.pending.key) || !this.wanted(this.pending.key))) this.cancelPending();
    if (this.pending && next.includes(this.pending.key)) this.attempted.add(this.pending.key);
    if (!options.ready || !next.length) return;
    if (this.stable) this.start();
    else if (this.timer === undefined) this.timer = setTimeout(() => {
      this.timer = undefined;
      this.stable = true;
      this.start();
    }, 150);
  }

  private wanted(key: string): boolean {
    const window = this.window;
    // Keep a prefetched page through its foreground acquisition, including with disk caching disabled.
    return !!window && (window.next.includes(key) || !window.ready && window.current.includes(key));
  }

  private start(): void {
    if (!this.window?.ready || !this.stable || this.pending) return;
    const key = this.window.next.find(key => !this.held.has(key) && !this.attempted.has(key));
    if (!key) return;
    this.attempted.add(key);
    const pending = {key, controller: new AbortController()};
    this.pending = pending;
    void this.read(pending);
  }

  private async read(pending: Pending): Promise<void> {
    try {
      const lease = await this.acquire(pending.key, pending.controller.signal, 'prefetch');
      if (this.pending !== pending || pending.controller.signal.aborted || !this.wanted(pending.key)) {
        lease.release();
      } else if (this.bytes + lease.blob.size > budget) {
        lease.release();
        // Do not keep fetching the rest of an oversized next window on subsequent renders.
        if (this.window!.next.includes(pending.key)) for (const key of this.window!.next) this.attempted.add(key);
      } else {
        this.held.set(pending.key, lease);
        this.bytes += lease.blob.size;
      }
    } catch {
      // A speculative failure is attempted once per next window; foreground retries stay independent.
    } finally {
      if (this.pending === pending) {this.pending = undefined; this.start();}
    }
  }

  private clearTimer(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private cancelPending(): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.controller.abort();
  }

  dispose(): void {
    this.clearTimer();
    this.cancelPending();
    for (const lease of this.held.values()) lease.release();
    this.held.clear();
    this.bytes = 0;
    this.attempted.clear();
    this.window = undefined;
    this.stable = false;
  }
}
