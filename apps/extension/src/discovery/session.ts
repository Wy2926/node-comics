import {defaultDiscoveryQuery, DiscoveryError, type DiscoveryDetail, type DiscoveryPageResult, type DiscoveryProvider, type DiscoveryQuery, type DiscoveryWork} from './types';

interface DiscoverySnapshot {
  query: DiscoveryQuery;
  works: DiscoveryWork[];
  page: number;
  hasMore: boolean;
  loading: boolean;
  stale: boolean;
  error?: DiscoveryError;
  failedPage?: number;
  selected?: DiscoveryWork;
  detail?: DiscoveryDetail;
  detailLoading: boolean;
  detailError?: DiscoveryError;
}
const failure = (error: unknown) => error instanceof DiscoveryError ? error : new DiscoveryError('unavailable');
const cacheLifetime = 5 * 60_000;

/** Bounded page-session cache and cancellation; independent of React, navigation and source import. */
export class DiscoverySession {
  private snapshot: DiscoverySnapshot = {
    query: {...defaultDiscoveryQuery}, works: [], page: 0, hasMore: false, loading: false, stale: false, detailLoading: false,
  };
  private listeners = new Set<() => void>();
  private pages = new Map<string, {value: DiscoveryPageResult; at: number}>();
  private details = new Map<number, DiscoveryDetail>();
  private listRequest?: AbortController;
  private detailRequest?: AbortController;
  private requestedPage = 1;
  constructor(private provider: DiscoveryProvider, private now = Date.now) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit(patch: Partial<DiscoverySnapshot>) {
    this.snapshot = {...this.snapshot, ...patch};
    this.listeners.forEach(listener => listener());
  }
  async search(query = this.snapshot.query, refresh = false) {
    const changed = JSON.stringify(query) !== JSON.stringify(this.snapshot.query);
    if (!changed && this.snapshot.loading && !this.listRequest?.signal.aborted) return;
    this.listRequest?.abort();
    this.emit({query: {...query}, ...(changed ? {works: [], page: 0, hasMore: false} : {})});
    await this.load(1, refresh);
  }
  async more() {
    if (!this.snapshot.loading && !this.snapshot.error && this.snapshot.hasMore) await this.load(this.snapshot.page + 1);
  }
  async retry() {
    if (!this.snapshot.loading) await this.load(this.requestedPage, true);
  }
  private async load(page: number, refresh = false) {
    this.requestedPage = page;
    const controller = new AbortController();
    this.listRequest = controller;
    const query = this.snapshot.query, key = JSON.stringify([query, page]), cached = this.pages.get(key);
    const publish = (value: DiscoveryPageResult, stale: boolean) => {
      const rows = page === 1 ? value.works : [...this.snapshot.works, ...value.works];
      this.emit({works: [...new Map(rows.map(row => [row.id, row])).values()], page, hasMore: value.hasMore, stale});
    };
    if (cached && !refresh && this.now() - cached.at < cacheLifetime) {
      publish(cached.value, false);
      this.emit({loading: false, error: undefined, failedPage: undefined});
      return;
    }
    if (cached && page === 1 && !this.snapshot.works.length) publish(cached.value, true);
    this.emit({loading: true, error: undefined, failedPage: undefined});
    try {
      const value = await this.provider.list(query, page, controller.signal);
      if (controller.signal.aborted) return;
      this.pages.delete(key);
      this.pages.set(key, {value, at: this.now()});
      if (this.pages.size > 20) this.pages.delete(this.pages.keys().next().value!);
      publish(value, false);
    } catch (error) {
      if (!controller.signal.aborted) this.emit({error: failure(error), failedPage: page, stale: this.snapshot.works.length > 0});
    } finally {
      if (!controller.signal.aborted) this.emit({loading: false});
    }
  }
  async select(selected: DiscoveryWork) {
    this.detailRequest?.abort();
    const controller = new AbortController();
    this.detailRequest = controller;
    const cached = this.details.get(selected.id);
    this.emit({selected, detail: cached, detailError: undefined, detailLoading: !cached});
    if (cached) return;
    try {
      const detail = await this.provider.detail(selected.id, controller.signal);
      if (controller.signal.aborted) return;
      this.details.set(detail.id, detail);
      if (this.details.size > 40) this.details.delete(this.details.keys().next().value!);
      this.emit({detail});
    } catch (error) {
      if (!controller.signal.aborted) this.emit({detailError: failure(error)});
    } finally {
      if (!controller.signal.aborted) this.emit({detailLoading: false});
    }
  }
  close() {
    this.detailRequest?.abort();
    this.emit({selected: undefined, detail: undefined, detailError: undefined, detailLoading: false});
  }
  dispose() {
    this.listRequest?.abort();
    this.detailRequest?.abort();
    this.listeners.clear();
  }
}
